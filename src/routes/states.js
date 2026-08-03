'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { displayValue, forEachState } = require('../adapters/states');
const { buildStatesTree } = require('../states/repository');
const { listCatalogLevel, searchCatalog } = require('../states/catalog');
const mqttClient = require('../mqtt/client');
const renderStates = require('../views/states');
const renderCustomStates = require('../views/custom-states');
const customStates = require('../states/custom');
const { invalidateStates } = require('../states/repository');

function statesRoutes(db) {
  const router = express.Router();

  async function customPage(res, options = {}) {
    const data = await customStates.rowsWithPaths(db);
    const tree = await customStates.managementTree(db);
    res.status(options.status || 200).send(renderCustomStates({ tree, folders: data.folders, states: data.states, ...options }));
  }

  router.get('/states/custom', requireAuth, async (req, res) => {
    try { await customPage(res, { message: String(req.query.ok || '').slice(0, 200) }); } catch (_) { res.status(500).send('Fehler beim Laden der Custom States.'); }
  });

  const mutate = (action, successMessage) => async (req, res) => {
    try {
      await action(req);
      invalidateStates();
      res.redirect(`/states/custom?ok=${encodeURIComponent(successMessage)}`);
    } catch (err) {
      try { await customPage(res, { status: 400, error: err.message || 'Die Änderung konnte nicht gespeichert werden.' }); }
      catch (_) { res.status(500).send('Fehler beim Speichern der Custom States.'); }
    }
  };

  router.post('/states/custom/folder', requireAuth, mutate((req) => customStates.addFolder(db, req.body), 'Verzeichnis angelegt.'));
  router.post('/states/custom/folder/:id', requireAuth, mutate((req) => customStates.updateFolder(db, req.params.id, req.body), 'Verzeichnis gespeichert.'));
  router.post('/states/custom/folder/:id/delete', requireAuth, mutate((req) => customStates.deleteFolder(db, req.params.id), 'Verzeichnis entfernt.'));
  router.post('/states/custom/state', requireAuth, mutate((req) => customStates.addState(db, req.body), 'Custom State angelegt.'));
  router.post('/states/custom/state/:id', requireAuth, mutate((req) => customStates.updateState(db, req.params.id, req.body), 'Custom State gespeichert.'));
  router.post('/states/custom/state/:id/delete', requireAuth, mutate((req) => customStates.deleteState(db, req.params.id), 'Custom State entfernt.'));
  router.post('/states/custom/state/:id/value', requireAuth, async (req, res) => {
    try {
      const state = await customStates.setValue(db, req.params.id, req.body.value);
      invalidateStates();
      res.json({ value: state.value, valueInput: state.valueInput, display: state.display });
    } catch (err) { res.status(400).json({ error: err.message || 'Wert konnte nicht gesetzt werden.' }); }
  });

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
