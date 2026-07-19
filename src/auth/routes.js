'use strict';

const express = require('express');
const { verifyPassword } = require('./password');
const { createSession, destroySession } = require('./session');
const { listUsersForLogin, getUserWithSecret } = require('./users');
const access = require('./access');
const renderLogin = require('../views/login');
const pairingState = require('../remote-access/pairing-state');

// Landeseite eines angemeldeten Nutzers: das Dashboard, sofern sichtbar, sonst
// die erste freigeschaltete Seite.
function landingPathFor(userAccess) {
  if (!userAccess || !userAccess.visiblePages) return '/dashboard';
  if (userAccess.visiblePages.includes('dashboard')) return '/dashboard';
  const first = userAccess.visiblePages[0];
  const page = access.PAGES.find((entry) => entry.key === first);
  return page ? page.prefix : '/dashboard';
}

// Authentifizierungs-Routen: Startseite/Login, Login-Verarbeitung, Logout.
function authRoutes(db) {
  const router = express.Router();

  // Startseite entscheidet dynamisch: angemeldet -> kleine Weiterleitung auf
  // die Landeseite (Dashboard bzw. erste sichtbare Seite), sonst Login mit
  // Nutzerauswahl. `/` rendert das Dashboard bewusst nicht direkt: die
  // Startantwort muss klein bleiben, damit mobile Relay-Clients nicht an einer
  // großen ersten HTML-Antwort abbrechen.
  router.get('/', (req, res) => {
    if (req.session && req.access) {
      return res.redirect(landingPathFor(req.access));
    }
    listUsersForLogin(db)
      .then((users) => res.send(renderLogin({ users })))
      .catch(() => res.send(renderLogin({ users: [] })));
  });

  router.post('/login', (req, res) => {
    const remember = req.body.remember === 'on' || req.body.remember === 'true';
    const userId = Number(req.body.userId);
    const password = req.body.password;

    const fail = () =>
      listUsersForLogin(db)
        .then((users) => res.status(401).send(renderLogin({ users, error: true, remember, selectedUserId: Number.isFinite(userId) ? userId : null })))
        .catch(() => res.status(401).send(renderLogin({ users: [], error: true, remember })));

    if (!Number.isFinite(userId)) return fail();

    getUserWithSecret(db, userId)
      .then((user) => {
        if (!user || !verifyPassword(password, user.password)) return fail();
        createSession(db, res, user.id, remember, (sErr) => {
          if (sErr) return fail();
          const userAccess = access.accessForUser(user);
          res.redirect(landingPathFor(userAccess));
        });
      })
      .catch(() => fail());
  });

  router.get('/logout', (req, res) => {
    // Beim Logout auch den flüchtigen Pairing-Zustand dieser Session entfernen
    // (Token/QR aus dem Speicher), bevor die Session zerstört wird.
    if (req.session) pairingState.removeForOwner(req.session.id);
    destroySession(db, req, res, () => res.redirect('/'));
  });

  // Zugriffs-Endpunkt für Adapter-Frontends (und die eigene Oberfläche): liefert
  // die Rechte des gerade angemeldeten Nutzers. Adapter-Seiten laufen im Browser
  // mit demselben Session-Cookie und können damit ihre eigenen Bearbeiten-/
  // Schalt-Elemente an die Rolle read/operate/write anpassen. Adapter selbst
  // (Kindprozesse) bleiben von der Rechtelogik unberührt; sie stellen bislang
  // keine Rechte bereit.
  router.get('/me/access', (req, res) => {
    if (!req.access) return res.status(401).json({ error: 'Nicht angemeldet.' });
    const acc = req.access;
    res.json({
      user: acc.userName,
      role: acc.role,
      isAdmin: acc.isAdmin,
      canRead: true,
      canOperate: acc.canOperate,
      canWrite: acc.canWrite,
    });
  });

  return router;
}

module.exports = authRoutes;
