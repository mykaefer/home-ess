'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { displayValue, forEachState } = require('../adapters/states');
const { buildStatesTree } = require('../states/repository');
const { listCatalogLevel, searchCatalog } = require('../states/catalog');
const mqttClient = require('../mqtt/client');
const renderStates = require('../views/states');

function statesRoutes(db) {
  const router = express.Router();

  router.get('/states', requireAuth, async (req, res) => {
    try {
      const tree = await buildStatesTree(db, mqttClient.getCache());
      res.send(renderStates({ tree }));
    } catch (_) {
      res.status(500).send('Fehler beim Laden der States.');
    }
  });

  // Katalog für den Topic-Picker: derselbe zentrale Baum wie auf der States-Seite,
  // einschließlich der adressierbaren system://homeess/...-Werte.
  router.get('/states/catalog.json', requireAuth, async (req, res) => {
    try {
      const tree = await buildStatesTree(db, mqttClient.getCache());
      res.json({ instances: tree });
    } catch (_) {
      res.status(500).json({ instances: [] });
    }
  });

  // Zentraler, lazy geladener States-Katalog für Wertquellen. Anders als der
  // Topic-Picker oben enthält er auch die berechneten Systemwerte.
  router.get('/states/catalog', requireAuth, async (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      const result = query
        ? await searchCatalog(db, mqttClient.getCache(), query)
        : await listCatalogLevel(db, mqttClient.getCache(), req.query.path, req.query.offset);
      res.json(result);
    } catch (_) {
      res.status(500).json({ path: '', nodes: [], items: [], nextOffset: null });
    }
  });

  // Live-Werte als { topic: display } für die clientseitige Aktualisierung.
  router.get('/states/data.json', requireAuth, async (req, res) => {
    try {
      const tree = await buildStatesTree(db, mqttClient.getCache());
      const values = {};
      for (const inst of tree) {
        // Virtuelle Blöcke (z. B. Schaltgruppen) liefern eine eigene Darstellung
        // („Ein"/„Aus"); Adapter-States werden weiterhin generisch formatiert.
        forEachState(inst.categories, (st) => {
          values[st.topic] = st.display != null ? st.display : displayValue(st.value, st.unit);
        });
      }
      res.json({ values });
    } catch (_) {
      res.status(500).json({ values: {} });
    }
  });

  return router;
}

module.exports = statesRoutes;
