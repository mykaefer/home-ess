'use strict';

// Farbthema je Benutzer: hell (wie bisher), dunkel oder nur das Dashboard
// dunkel. Eingefärbt wird ausschliesslich die Seitenfläche — Titelleiste und
// Seitenmenü behalten in jedem Thema ihre Farben.

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-theme-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const usersRepo = require('../src/auth/users');
const accessMod = require('../src/auth/access');
const { sessionMiddleware, authorize } = require('../src/auth/session');
const authRoutes = require('../src/auth/routes');
const settingsRoutes = require('../src/routes/settings');
const { renderLayout } = require('../src/views/layout');

const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function freshDb() {
  fs.rmSync(process.env.HOME_ESS_DB, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 400));
}

// --- Einheit: Themenmodell ---------------------------------------------------

test('normalizeTheme: nur bekannte Themen, sonst hell', () => {
  assert.equal(accessMod.normalizeTheme('hell'), 'hell');
  assert.equal(accessMod.normalizeTheme('dunkel'), 'dunkel');
  assert.equal(accessMod.normalizeTheme('dashboard'), 'dashboard');
  assert.equal(accessMod.normalizeTheme('DUNKEL'), 'dunkel');
  assert.equal(accessMod.normalizeTheme('quatsch'), 'hell');
  assert.equal(accessMod.normalizeTheme(null), 'hell');
  assert.equal(accessMod.normalizeTheme(undefined), 'hell');
});

test('isDarkForPath: „dashboard" färbt nur die Dashboard-Seite', () => {
  assert.equal(accessMod.isDarkForPath('hell', '/dashboard'), false);
  assert.equal(accessMod.isDarkForPath('hell', '/settings'), false);

  assert.equal(accessMod.isDarkForPath('dunkel', '/dashboard'), true);
  assert.equal(accessMod.isDarkForPath('dunkel', '/settings'), true);
  assert.equal(accessMod.isDarkForPath('dunkel', ''), true);

  assert.equal(accessMod.isDarkForPath('dashboard', '/dashboard'), true);
  assert.equal(accessMod.isDarkForPath('dashboard', '/dashboard/tab/2'), true);
  assert.equal(accessMod.isDarkForPath('dashboard', '/settings'), false);
  assert.equal(accessMod.isDarkForPath('dashboard', '/photovoltaik'), false);
  // Kein Präfix-Fehlgriff auf ähnlich beginnende Pfade.
  assert.equal(accessMod.isDarkForPath('dashboard', '/dashboards'), false);
});

test('themeBodyClass liefert die Body-Klasse oder nichts', () => {
  assert.equal(accessMod.themeBodyClass('dunkel', '/settings'), 'theme-dark');
  assert.equal(accessMod.themeBodyClass('dashboard', '/dashboard'), 'theme-dark');
  assert.equal(accessMod.themeBodyClass('dashboard', '/settings'), '');
  assert.equal(accessMod.themeBodyClass('hell', '/dashboard'), '');
});

test('accessForUser reicht das Thema durch – auch für den Administrator', () => {
  const user = accessMod.accessForUser({ id: 2, role: 'read', is_admin: 0, theme: 'dunkel' });
  assert.equal(user.theme, 'dunkel');
  // Anders als Rolle und Seitensichtbarkeit ist das Thema keine Rechtefrage.
  const admin = accessMod.accessForUser({ id: 1, role: 'write', is_admin: 1, theme: 'dashboard' });
  assert.equal(admin.theme, 'dashboard');
  // Bestandszeile ohne Spaltenwert bleibt hell.
  assert.equal(accessMod.accessForUser({ id: 3, is_admin: 0 }).theme, 'hell');
  assert.equal(accessMod.fullAccess().theme, 'hell');
});

// --- Einheit: Persistenz -----------------------------------------------------

test('Migration: bestehende Zugänge bekommen das helle Thema', async () => {
  const db = await freshDb();
  const users = await usersRepo.listUsers(db);
  assert.equal(users[0].theme, 'hell');
  db.close();
});

test('Thema wird angelegt, geändert und bleibt bei Updates ohne Feld erhalten', async () => {
  const db = await freshDb();
  const user = await usersRepo.createUser(db, {
    name: 'Nina', password: 'geheim', role: 'operate', visiblePages: ['dashboard'], theme: 'dunkel',
  });
  assert.equal(user.theme, 'dunkel');

  // Speichern aus der Benutzerverwaltung ohne Themenfeld darf die Auswahl
  // nicht stillschweigend zurücksetzen.
  const kept = await usersRepo.updateUser(db, user.id, { name: 'Nina', role: 'operate', visiblePages: ['dashboard'] });
  assert.equal(kept.theme, 'dunkel');

  const changed = await usersRepo.updateUser(db, user.id, {
    name: 'Nina', role: 'operate', visiblePages: ['dashboard'], theme: 'dashboard',
  });
  assert.equal(changed.theme, 'dashboard');

  // Eigene Einstellung: unabhängig von Rolle und Benutzerverwaltung.
  const own = await usersRepo.setUserTheme(db, user.id, 'hell');
  assert.equal(own.theme, 'hell');
  // Unbekannter Wert fällt auf hell zurück.
  assert.equal((await usersRepo.setUserTheme(db, user.id, 'neon')).theme, 'hell');

  // Auch der Administrator kann sein Thema wählen.
  const [admin] = (await usersRepo.listUsers(db)).filter((u) => u.isAdmin);
  const adminDark = await usersRepo.updateUser(db, admin.id, { name: admin.name, theme: 'dunkel' });
  assert.equal(adminDark.theme, 'dunkel');
  assert.equal(adminDark.isAdmin, true);
  assert.equal(adminDark.role, 'write');

  db.close();
});

// --- Darstellung -------------------------------------------------------------

test('renderLayout setzt die Themenklasse passend zum Pfad', () => {
  const withTheme = (theme, activePath) => accessMod.runWithAccess(
    { ...accessMod.fullAccess(), theme },
    () => renderLayout({ title: 'T', activePath, body: '<p>x</p>' })
  );

  const hell = withTheme('hell', '/dashboard');
  assert.ok(!hell.includes('theme-dark'), 'helles Thema setzt keine Klasse');
  assert.ok(hell.includes('data-theme="hell"'));

  const dunkel = withTheme('dunkel', '/settings');
  assert.ok(/<body class="page-dashboard [^"]*theme-dark"/.test(dunkel), 'dunkles Thema auf jeder Seite');
  assert.ok(dunkel.includes('data-theme="dunkel"'));

  assert.ok(withTheme('dashboard', '/dashboard').includes('theme-dark'));
  assert.ok(!withTheme('dashboard', '/photovoltaik').includes('theme-dark'));
});

test('Stylesheet: Titelleiste und Seitenmenü behalten im dunklen Thema die hellen Farben', () => {
  // Das dunkle Thema definiert nur Tokens auf dem Body um …
  assert.ok(/body\.theme-dark\s*\{/.test(STYLES), 'Themenblock vorhanden');
  const darkBlock = STYLES.slice(STYLES.indexOf('body.theme-dark {'));
  const bodyTokens = darkBlock.slice(0, darkBlock.indexOf('}'));

  // … und stellt sie für Kopfzeile und Menü wieder auf die hellen Werte.
  const shellStart = STYLES.indexOf('.theme-dark .dashboard-header,');
  assert.ok(shellStart > 0, 'Rückstellung für Kopfzeile/Menü vorhanden');
  const shellBlock = STYLES.slice(shellStart, STYLES.indexOf('}', shellStart));
  for (const selector of ['.sidebar', '.mobile-tabbar', '.mobile-nav-sheet']) {
    assert.ok(shellBlock.includes(selector), `${selector} wird zurückgestellt`);
  }

  // Jedes im dunklen Thema geänderte Token muss für die Hülle zurückgestellt
  // sein, sonst färbt sich Kopfzeile oder Menü unbeabsichtigt mit.
  const tokensOf = (block) => new Set(
    [...block.matchAll(/^\s*(--color-[a-z-]+)\s*:/gm)].map((m) => m[1])
  );
  const dark = tokensOf(bodyTokens);
  const shell = tokensOf(shellBlock);
  const missing = [...dark].filter((token) => !shell.has(token));
  assert.deepEqual(missing, [], `nicht zurückgestellte Tokens: ${missing.join(', ')}`);

  // Die hellen Werte der Hülle müssen den Werten aus :root entsprechen.
  const root = STYLES.slice(STYLES.indexOf(':root {'), STYLES.indexOf('}', STYLES.indexOf(':root {')));
  const valuesOf = (block) => Object.fromEntries(
    [...block.matchAll(/^\s*(--color-[a-z-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()])
  );
  const rootValues = valuesOf(root);
  const shellValues = valuesOf(shellBlock);
  for (const [token, value] of Object.entries(shellValues)) {
    if (rootValues[token] === undefined) continue;
    assert.equal(value, rootValues[token], `${token} weicht von :root ab`);
  }
});

test('Stylesheet: der QR-Code der Kopplung bleibt auch dunkel weiss', () => {
  assert.ok(/\.theme-dark \.remote-access-qr\s*\{[^}]*#ffffff/.test(STYLES));
});

// Adapter bringen eigene Verwaltungs-Stylesheets mit, die im selben Dokument
// wie styles.css geladen werden. Sie müssen dieselben Tokens verwenden, sonst
// bleiben im dunklen Thema weisse Kästen und dunkle Schrift stehen.
test('Adapter-Stylesheets tragen keine festen Hell-/Dunkelfarben mehr', () => {
  const adapterDir = path.join(__dirname, '..', 'adapter');
  const sheets = fs.readdirSync(adapterDir)
    .map((name) => path.join(adapterDir, name, 'management.css'))
    .filter((file) => fs.existsSync(file));
  assert.ok(sheets.length >= 4, 'Verwaltungs-Stylesheets gefunden');

  // Helligkeit nach der üblichen Gewichtung; Rückfallwerte in var(…) zählen
  // nicht, weil dort immer das Token gewinnt.
  const helligkeit = (hex) => {
    let x = hex.toLowerCase();
    if (x.length === 4) x = `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}`;
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(x.substr(k, 2), 16));
    return r * 0.299 + g * 0.587 + b * 0.114;
  };

  const treffer = [];
  for (const file of sheets) {
    const css = fs.readFileSync(file, 'utf8');
    css.replace(/([^{}]+)\{([^{}]*)\}/g, (full, sel, body) => {
      const s = sel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
      // Ausnahmen des dunklen Themas dürfen feste Farben tragen.
      if (s.startsWith('@') || /theme-dark/.test(s)) return full;
      body.replace(/(^|[;{])\s*([-a-zA-Z]+)\s*:\s*([^;{}]*)/g, (f, l, prop, value) => {
        const p = prop.toLowerCase();
        const bare = value.replace(/var\([^)]*\)/g, '');
        for (const hex of bare.match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
          const hell = helligkeit(hex);
          if (/^(background|background-color|fill)$/.test(p) && hell > 200) {
            treffer.push(`${path.basename(path.dirname(file))}: ${s} → ${p}: ${hex} (helle Fläche)`);
          }
          if (p === 'color' && hell < 115) {
            treffer.push(`${path.basename(path.dirname(file))}: ${s} → ${p}: ${hex} (dunkle Schrift)`);
          }
        }
        return f;
      });
      return full;
    });
  }
  assert.deepEqual(treffer, [], `feste Farben ohne Token:\n${treffer.join('\n')}`);
});

// --- Integration: Einstellungsseite -----------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function loginAs(baseUrl, userId, password) {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `userId=${userId}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('POST /settings/theme setzt das Thema des angemeldeten Benutzers', async () => {
  const db = await freshDb();
  // Bewusst die Rolle „Lesen": die Darstellung ist keine Schreiboperation an
  // der Anlage, sondern eine persönliche Einstellung.
  const reader = await usersRepo.createUser(db, {
    name: 'Leser', password: 'lesen', role: 'read', visiblePages: ['dashboard', 'settings'],
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(sessionMiddleware(db));
  app.use(authorize({ openPaths: ['/', '/login', '/logout'], sharedPaths: ['/live', '/me'] }));
  app.use(authRoutes(db));
  app.use(settingsRoutes(db));
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const cookie = await loginAs(baseUrl, reader.id, 'lesen');
  const res = await fetch(`${baseUrl}/settings/theme`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'theme=dunkel',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal((await usersRepo.getUser(db, reader.id)).theme, 'dunkel');

  // Ohne Anmeldung keine Änderung.
  const anonymous = await fetch(`${baseUrl}/settings/theme`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'theme=hell',
    redirect: 'manual',
  });
  assert.equal(anonymous.status, 403);
  assert.equal((await usersRepo.getUser(db, reader.id)).theme, 'dunkel');

  server.close();
  db.close();
});
