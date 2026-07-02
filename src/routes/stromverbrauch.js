'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const {
  loadStromverbrauchConfig,
  saveStromverbrauchConfig,
} = require('../stromverbrauch/config');
const {
  buildStromverbrauchSnapshot,
  setManualOffset,
  parseNumber,
  resetCountersForChangedTopics,
} = require('../stromverbrauch/aggregation');
const { recordDailyMetric, isValidDayKey } = require('../history/daily-metrics');
const renderStromverbrauch = require('../views/stromverbrauch');

async function renderPage(db, res, options = {}) {
  const config = await new Promise((resolve) => loadStromverbrauchConfig(db, resolve));
  const metrics = await buildStromverbrauchSnapshot(db, mqttClient.getCache());
  res.send(
    renderStromverbrauch({
      config,
      metrics,
      formMessage: options.formMessage || '',
      formError: options.formError || '',
      reconcileMessage: options.reconcileMessage || '',
      reconcileError: options.reconcileError || '',
    })
  );
}

function stromverbrauchRoutes(db) {
  const router = express.Router();

  router.get('/stromverbrauch', requireAuth, async (req, res, next) => {
    try {
      await renderPage(db, res);
    } catch (err) {
      next(err);
    }
  });

  router.get('/stromverbrauch/data', requireAuth, async (req, res, next) => {
    try {
      const metrics = await buildStromverbrauchSnapshot(db, mqttClient.getCache());
      res.json(metrics.formatted);
    } catch (err) {
      next(err);
    }
  });

  router.post('/stromverbrauch/topics', requireAuth, async (req, res, next) => {
    try {
      const previousConfig = await new Promise((resolve) => loadStromverbrauchConfig(db, resolve));
      const cfg = await new Promise((resolve, reject) => {
        saveStromverbrauchConfig(db, req.body, (err, value) => (err ? reject(err) : resolve(value)));
      });
      const defs = await loadAllStateDefinitions(db);
      // Reihenfolge wichtig: erst den Value-Cache über die neuen State-Definitionen
      // leeren (setStateDefinitions verwirft den alten Wert geänderter Topics),
      // dann den gemerkten Zähler-Rohstand zurücksetzen. So gilt der erste Wert des
      // neuen/getauschten Zählers als Ist-Stand und wird nicht als Sprung gezählt.
      mqttClient.setStateDefinitions(defs);
      await resetCountersForChangedTopics(db, previousConfig, cfg);
      await renderPage(db, res, { formMessage: 'MQTT-Topics gespeichert.' });
    } catch (err) {
      try {
        await renderPage(db, res, { formError: 'Fehler beim Speichern der MQTT-Topics.' });
      } catch (_) {
        next(err);
      }
    }
  });

  router.post('/stromverbrauch/reconcile', requireAuth, async (req, res, next) => {
    try {
      const target = req.body.target;
      // Summen (Woche/Jahr/Vorjahr) setzen Netzbezug + Einspeisung gemeinsam über die
      // Offset-Zähler; Eigenverbrauch ergibt sich daraus. Minimum/Maximum je Kennzahl
      // werden als Startwert für einen Tag in die Tageshistorie geschrieben.
      if (target === 'week' || target === 'year' || target === 'previousYear') {
        const netzbezug = parseNumber(req.body.reconcileNetzbezugValue);
        const einspeisung = parseNumber(req.body.reconcileEinspeisungValue);
        if (netzbezug == null || einspeisung == null) {
          return renderPage(db, res, {
            reconcileError: 'Bitte gueltige Werte fuer Netzbezug und Einspeisung eingeben.',
          });
        }
        await setManualOffset(db, target, { netzbezug, einspeisung });
      } else if (
        target === 'netzbezug.min' || target === 'netzbezug.max' ||
        target === 'eigenverbrauch.min' || target === 'eigenverbrauch.max'
      ) {
        const metric = target.startsWith('netzbezug') ? 'strom.netzbezug' : 'strom.eigenverbrauch';
        const value = parseNumber(req.body.reconcileValue);
        if (value == null) {
          return renderPage(db, res, { reconcileError: 'Bitte einen gueltigen Wert eingeben.' });
        }
        if (!isValidDayKey(req.body.reconcileDate)) {
          return renderPage(db, res, { reconcileError: 'Bitte ein gueltiges Datum eingeben.' });
        }
        await recordDailyMetric(db, metric, req.body.reconcileDate, value);
      } else {
        return renderPage(db, res, { reconcileError: 'Bitte eine Kennzahl auswaehlen.' });
      }
      await renderPage(db, res, { reconcileMessage: 'Wert uebernommen.' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = stromverbrauchRoutes;
