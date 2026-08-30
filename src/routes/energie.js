'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { buildEnergieOverview } = require('../energie/overview');
const renderEnergie = require('../views/energie');

// Energie-Übersicht: reine Anzeige-Seite ohne eigene Konfiguration. Sie bündelt
// die Eckdaten von Photovoltaik, Stromverbrauch, Batterie und Grid-Control und
// verweist für alles Weitere auf die jeweilige Unterseite.
function energieRoutes(db) {
  const router = express.Router();

  router.get('/energie', requireAuth, async (req, res, next) => {
    try {
      const overview = await buildEnergieOverview(db);
      res.send(renderEnergie({ overview }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/energie/data', requireAuth, async (req, res, next) => {
    try {
      res.json(await buildEnergieOverview(db));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = energieRoutes;
