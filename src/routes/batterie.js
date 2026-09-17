'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const {
  loadBatterieConfig,
  saveBatterieConfig,
  readBatterieData,
} = require('../batterie/config');
const renderBatterie = require('../views/batterie');
const gridControlAutomation = require('../grid-control/automation');
const batterieMinSocSync = require('../batterie/min-soc-sync');

function batterieRoutes(db) {
  const router = express.Router();

  router.get('/batterie', requireAuth, (req, res) => {
    loadBatterieConfig(db, (config) => {
      const data = readBatterieData(mqttClient.getCache());
      res.send(renderBatterie({ config, data }));
    });
  });

  router.post('/batterie/topics', requireAuth, (req, res) => {
    loadBatterieConfig(db, (previous) => saveBatterieConfig(db, req.body, (err, config) => {
      if (err) {
        loadBatterieConfig(db, (cfg) => {
          res.send(renderBatterie({ config: cfg, data: readBatterieData(mqttClient.getCache()), error: err.message || 'Fehler beim Speichern.' }));
        });
        return;
      }
      loadAllStateDefinitions(db)
        .then((defs) => mqttClient.setStateDefinitions(defs))
        .then(() => {
          // Der gespeicherte Mindest-SoC geht an das Steuer-Topic und (als
          // gespiegelte Einstellung) an das Remote-Topic.
          batterieMinSocSync.publishLocalMinSoc(previous, config, 'oberflaeche');
        })
        .then(() => gridControlAutomation.runNow(db))
        .catch(() => {})
        .finally(() => {
          const data = readBatterieData(mqttClient.getCache());
          res.send(renderBatterie({ config, data, message: 'Konfiguration gespeichert.' }));
        });
    }));
  });

  // Schieberegler: übernimmt den Mindest-SoC sofort, ohne das Formular zu speichern.
  router.post('/batterie/min-soc', requireAuth, async (req, res, next) => {
    try {
      const config = await batterieMinSocSync.setLocalMinSoc(db, req.body && req.body.minSoc);
      gridControlAutomation.runNow(db).catch(() => {});
      res.json({ ok: true, minSoc: config.minSoc });
    } catch (err) {
      if (err.validation) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Live-Werte samt gespeicherter Einstellung, damit der Regler externen
  // Änderungen (Remote-Topic) ohne Seitenreload folgt.
  router.get('/batterie/data', requireAuth, (req, res) => {
    loadBatterieConfig(db, (config) => {
      res.json({ ...readBatterieData(mqttClient.getCache()), minSocSetting: config.minSoc });
    });
  });

  return router;
}

module.exports = batterieRoutes;
