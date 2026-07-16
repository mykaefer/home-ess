'use strict';

const express = require('express');
const { verifyPassword } = require('./password');
const { createSession, destroySession } = require('./session');
const renderLogin = require('../views/login');
const renderDashboard = require('../views/dashboard');
const pairingState = require('../remote-access/pairing-state');

// Authentifizierungs-Routen: Startseite/Login, Login-Verarbeitung, Logout.
function authRoutes(db) {
  const router = express.Router();

  // Startseite entscheidet dynamisch: angemeldet -> Dashboard, sonst Login.
  router.get('/', (req, res) => {
    if (req.session) return res.send(renderDashboard());
    res.send(renderLogin());
  });

  router.post('/login', (req, res) => {
    const { password } = req.body;
    const remember = req.body.remember === 'on' || req.body.remember === 'true';

    db.get('SELECT password FROM users LIMIT 1', (err, row) => {
      if (err || !row || !verifyPassword(password, row.password)) {
        return res.status(401).send(renderLogin({ error: true, remember }));
      }
      createSession(db, res, remember, (sErr) => {
        if (sErr) return res.status(500).send(renderLogin({ error: true, remember }));
        res.redirect('/dashboard');
      });
    });
  });

  router.get('/logout', (req, res) => {
    // Beim Logout auch den flüchtigen Pairing-Zustand dieser Session entfernen
    // (Token/QR aus dem Speicher), bevor die Session zerstört wird.
    if (req.session) pairingState.removeForOwner(req.session.id);
    destroySession(db, req, res, () => res.redirect('/'));
  });

  return router;
}

module.exports = authRoutes;
