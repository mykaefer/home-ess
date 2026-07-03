'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { isEnabled } = require('../modules');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const { loadGridControlConfig, saveGridControlConfig, normalizeGridControlInput, readGridControlBrokerValues } = require('../grid-control/config');
const automation = require('../grid-control/automation');
const { readLog } = require('../grid-control/log');
const { loadBatterieConfig } = require('../batterie/config');
const renderGridControl = require('../views/grid-control');
const { loadStromverbrauchConfig } = require('../stromverbrauch/config');

function load(loader, db) { return new Promise((resolve) => loader(db, resolve)); }

function gridControlRoutes(db) {
  const router = express.Router();

  async function page(res, options = {}) {
    const [config, batteryConfig] = await Promise.all([
      load(loadGridControlConfig, db), load(loadBatterieConfig, db),
    ]);
    const brokerValues = readGridControlBrokerValues(mqttClient.getCache());
    const log = await readLog(db, 1).catch(() => ({ entries: [], page: 1, totalPages: 1, total: 0 }));
    res.send(renderGridControl({ config, batteryConfig, state: automation.getState(), brokerValues, log, ...options }));
  }

  router.get('/grid-control', requireAuth, (req, res) => {
    if (!isEnabled('grid-control')) return res.redirect('/module');
    page(res).catch(() => res.status(500).send('Fehler beim Laden.'));
  });

  router.post('/grid-control/config', requireAuth, async (req, res) => {
    if (!isEnabled('grid-control')) return res.redirect('/module');
    const [batteryConfig, stromverbrauchConfig] = await Promise.all([
      load(loadBatterieConfig, db),
      load(loadStromverbrauchConfig, db),
    ]);
    const candidate = normalizeGridControlInput(req.body);
    const lowSoc = Number(batteryConfig.minSoc) + candidate.socLowerOffset;
    const highSoc = 100 - candidate.socUpperOffset;
    if (candidate.socEnabled && lowSoc + candidate.socHysteresis >= highSoc - candidate.socHysteresis) {
      return page(res, { error: 'SoC-Schaltfenster überlappen sich. Bitte Offsets oder Hysterese verkleinern.' });
    }
    if (candidate.voltageEnabled && Number(batteryConfig.lowerVoltage) + candidate.voltageHysteresis >= Number(batteryConfig.upperVoltage) - candidate.voltageHysteresis) {
      return page(res, { error: 'Spannungs-Schaltfenster überlappen sich. Bitte die Hysterese verkleinern oder die Batteriegrenzen anpassen.' });
    }
    if (candidate.loadEnabled) {
      const sourceTopics = [
        stromverbrauchConfig.eigenverbrauchL1Topic,
        stromverbrauchConfig.eigenverbrauchL2Topic,
        stromverbrauchConfig.eigenverbrauchL3Topic,
      ];
      if (sourceTopics.some((topic) => !topic)) {
        return page(res, { error: 'Für die Lastschaltung müssen unter Stromverbrauch alle drei Eigenverbrauchs-Leistungstopics konfiguriert sein.' });
      }
      const on = [candidate.loadOnL1, candidate.loadOnL2, candidate.loadOnL3];
      const off = [candidate.loadOffL1, candidate.loadOffL2, candidate.loadOffL3];
      const shedMax = [candidate.loadShedMaxL1, candidate.loadShedMaxL2, candidate.loadShedMaxL3];
      if (shedMax.some((value) => value == null)) {
        return page(res, { error: 'Für den Lastabwurf müssen alle drei Maximallasten ausgefüllt sein.' });
      }
      if (on.some((value) => value == null) || off.some((value) => value == null)) {
        return page(res, { error: 'Für die Lastschaltung müssen alle Ein- und Ausschaltschwellen ausgefüllt sein.' });
      }
      if (on.some((value, index) => off[index] >= value)) {
        return page(res, { error: 'Die Ausschaltschwelle muss auf jeder Phase unter der zugehörigen Einschaltschwelle liegen.' });
      }
      if (shedMax.some((value) => value <= 0)) {
        return page(res, { error: 'Die Maximallast für den Lastabwurf muss auf jeder Phase größer als 0 sein.' });
      }
    }
    saveGridControlConfig(db, req.body, (err) => {
      if (err) return page(res, { error: 'Fehler beim Speichern.' });
      loadAllStateDefinitions(db)
        .then((defs) => mqttClient.setStateDefinitions(defs))
        .then(() => automation.runNow(db))
        .then(() => page(res, { message: 'Grid-Control-Konfiguration gespeichert.' }))
        .catch(() => page(res, { error: 'Konfiguration gespeichert, Steuerung konnte aber nicht aktualisiert werden.' }));
    });
  });

  router.get('/grid-control/status', requireAuth, (req, res) => res.json({
    ...automation.getState(),
    brokerValues: readGridControlBrokerValues(mqttClient.getCache()),
  }));

  router.get('/grid-control/log', requireAuth, async (req, res) => {
    if (!isEnabled('grid-control')) return res.status(403).json({ error: 'disabled' });
    try {
      res.json(await readLog(db, req.query.page));
    } catch (err) {
      res.status(500).json({ error: 'log' });
    }
  });
  return router;
}

module.exports = gridControlRoutes;
