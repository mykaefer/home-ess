'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { buildStatesTree, displayValue, forEachState } = require('../adapters/states');
const renderStates = require('../views/states');

function statesRoutes(db) {
  const router = express.Router();

  router.get('/states', requireAuth, async (req, res) => {
    try {
      const tree = await buildStatesTree(db);
      res.send(renderStates({ tree }));
    } catch (_) {
      res.status(500).send('Fehler beim Laden der States.');
    }
  });

  // Katalog für den State-Picker (gleiche Baumstruktur wie die Seite).
  router.get('/states/catalog.json', requireAuth, async (req, res) => {
    try {
      const tree = await buildStatesTree(db);
      res.json({ instances: tree });
    } catch (_) {
      res.status(500).json({ instances: [] });
    }
  });

  // Live-Werte als { topic: display } für die clientseitige Aktualisierung.
  router.get('/states/data.json', requireAuth, async (req, res) => {
    try {
      const tree = await buildStatesTree(db);
      const values = {};
      for (const inst of tree) {
        forEachState(inst.categories, (st) => { values[st.topic] = displayValue(st.value, st.unit); });
      }
      res.json({ values });
    } catch (_) {
      res.status(500).json({ values: {} });
    }
  });

  return router;
}

module.exports = statesRoutes;
