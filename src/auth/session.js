'use strict';

const crypto = require('crypto');
const config = require('../config');
const access = require('./access');
const { accessForUserId } = require('./users');

// Schlanke, DB-gestützte Cookie-Sessions. Ersetzt das frühere prozessweite
// isLoggedIn-Flag und ermöglicht "Passwort merken" sowie mehrere Clients.
// Sessions überleben Neustarts, weil sie in der sessions-Tabelle liegen.

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Middleware: setzt req.session = { id, userId } für gültige Sessions und löst
// den zugehörigen Nutzer-Zugriff (Rechte/Seiten) auf. Der weitere Request läuft
// innerhalb des Zugriffskontexts (AsyncLocalStorage), sodass renderLayout und die
// Views die Rechte ohne explizite Durchreichung lesen können.
function sessionMiddleware(db) {
  return (req, res, next) => {
    const sid = parseCookies(req.headers.cookie)[config.SESSION_COOKIE];
    if (!sid) {
      req.session = null;
      req.access = null;
      return next();
    }
    db.get('SELECT id, expires_at, user_id FROM sessions WHERE id = ?', [sid], (err, row) => {
      if (err || !row || row.expires_at < Date.now()) {
        req.session = null;
        req.access = null;
        return next();
      }
      req.session = { id: row.id, userId: row.user_id == null ? null : row.user_id };
      accessForUserId(db, row.user_id)
        .then((userAccess) => {
          // Session ohne (mehr) gültigen Nutzer gilt als nicht angemeldet.
          if (!userAccess) {
            req.session = null;
            req.access = null;
            return next();
          }
          req.access = userAccess;
          access.runWithAccess(userAccess, () => next());
        })
        .catch(() => {
          req.session = null;
          req.access = null;
          next();
        });
    });
  };
}

// Erzeugt eine Session für einen Nutzer, schreibt sie in die DB und setzt das
// Cookie. remember=true -> persistentes Cookie (30 Tage) = automatischer Login
// beim nächsten Aufruf, sonst Session-Cookie (12 h).
function createSession(db, res, userId, remember, callback) {
  const id = crypto.randomBytes(32).toString('hex');
  const maxAge = remember ? config.SESSION_REMEMBER_MS : config.SESSION_DEFAULT_MS;
  const expiresAt = Date.now() + maxAge;

  db.run('INSERT INTO sessions (id, expires_at, user_id) VALUES (?, ?, ?)', [id, expiresAt, userId], (err) => {
    if (err) return callback(err);
    res.cookie(config.SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // Ohne "merken" kein maxAge -> Cookie endet mit der Browser-Sitzung.
      ...(remember ? { maxAge } : {}),
    });
    callback(null, id);
  });
}

function destroySession(db, req, res, callback) {
  res.clearCookie(config.SESSION_COOKIE, { path: '/' });
  if (!req.session) return callback && callback();
  db.run('DELETE FROM sessions WHERE id = ?', [req.session.id], () => callback && callback());
}

// Schutz-Middleware für authentifizierte Routen.
function requireAuth(req, res, next) {
  if (!req.session) return res.redirect('/');
  next();
}

// Schalt-/Bedien-Routen, die auch mit der Rolle „bedienen" erlaubt sind:
// Schalter in Messen + Schalten, Schaltgruppen und Dashboard-Schalter sowie die
// Bedienelemente für Wallbox-Lademodi/-Steuerung und die Pool-Pumpenmodi
// (An/Aus/Automatik). Alle anderen schreibenden Requests erfordern „schreiben".
const OPERATE_POST_PATTERNS = [
  /^\/dashboard\/switch\/\d+\/[^/]+\/?$/,
  /^\/messen-schalten\/actor\/\d+\/switch\/[^/]+\/?$/,
  /^\/messen-schalten\/schaltgruppen\/\d+\/switch\/[^/]+\/?$/,
  /^\/wallbox\/box\/\d+\/mode\/[^/]+\/?$/,
  /^\/wallbox\/box\/\d+\/control\/[^/]+\/?$/,
  /^\/pool\/pump\/[^/]+\/[^/]+\/?$/,
];

// Reine Lese-POSTs (Diagnose ohne Zustandsänderung), die auch Lesern erlaubt
// sind. Aktuell nur der MQTT-Verbindungstest.
const READ_POST_PATTERNS = [
  /^\/settings\/mqtt\/test\/?$/,
];

function isOperatePost(pathname) {
  return OPERATE_POST_PATTERNS.some((re) => re.test(pathname));
}

function isReadPost(pathname) {
  return READ_POST_PATTERNS.some((re) => re.test(pathname));
}

function wantsJson(req) {
  return req.xhr
    || (req.headers.accept || '').includes('application/json')
    || (req.headers['content-type'] || '').includes('application/json');
}

function denyWrite(req, res) {
  if (wantsJson(req)) return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
  return res.status(403).send('Keine Berechtigung für diese Aktion.');
}

// Globale Autorisierung nach dem Rechtemodell:
//   - GET/HEAD: jeder angemeldete Nutzer darf lesen (Seiten-Sichtbarkeit siehe
//     unten). Nicht angemeldet -> Redirect zum Login.
//   - schreibende Methoden (POST/PUT/PATCH/DELETE): nur „schreiben"; Schalt-
//     Routen zusätzlich „bedienen"; MQTT-Test zusätzlich „lesen".
//   - Seiten-Sichtbarkeit: Zugriff auf eine nicht freigeschaltete Seite wird
//     unterbunden (Redirect auf die erste sichtbare Seite bzw. 403 für JSON).
// `openPaths` sind ohne Anmeldung erreichbar (Login/Logout/öffentliche Exporte).
function authorize(options = {}) {
  const openPaths = options.openPaths || [];
  const sharedPaths = options.sharedPaths || [];
  const isOpen = (pathname) => openPaths.some((p) => (p instanceof RegExp ? p.test(pathname) : pathname === p || pathname.startsWith(`${p}/`)));
  const isShared = (pathname) => sharedPaths.some((p) => (p instanceof RegExp ? p.test(pathname) : pathname === p || pathname.startsWith(`${p}/`)));

  return (req, res, next) => {
    const pathname = req.path;
    if (isOpen(pathname)) return next();

    if (!req.session || !req.access) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (wantsJson(req)) return res.status(401).json({ error: 'Nicht angemeldet.' });
        return res.redirect('/');
      }
      return denyWrite(req, res);
    }

    const acc = req.access;
    const method = req.method;

    if (method !== 'GET' && method !== 'HEAD') {
      if (acc.canWrite) return next();
      if (isOperatePost(pathname) && acc.canOperate) return next();
      if (isReadPost(pathname)) return next();
      return denyWrite(req, res);
    }

    // Lesende Requests: Seiten-Sichtbarkeit prüfen (außer geteilte Endpunkte wie
    // Live-Header/SSE, die jede Seite benötigt).
    if (!isShared(pathname) && !acc.isAdmin && acc.visiblePages) {
      const pageKey = access.pageForPath(pathname);
      if (pageKey && !access.canSeePage(acc, pageKey)) {
        if (wantsJson(req)) return res.status(403).json({ error: 'Diese Seite ist nicht freigeschaltet.' });
        const firstVisible = acc.visiblePages[0];
        const target = access.PAGES.find((page) => page.key === firstVisible);
        return res.redirect(target ? target.prefix : '/');
      }
    }
    next();
  };
}

module.exports = { sessionMiddleware, createSession, destroySession, requireAuth, authorize };
