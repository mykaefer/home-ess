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
    saveBatterieConfig(db, req.body, (err, config) => {
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
          // gespiegelte Einstellung) an das Remote-Topic. noteLocalChange sorgt
          // dafür, dass ein noch im Cache liegender älterer Remote-Wert die
          // gerade gespeicherte Einstellung nicht sofort wieder zurückdreht.
          if (config.minSocTopic) mqttClient.publish(config.minSocTopic, config.minSoc);
          if (config.remoteTopic) {
            batterieMinSocSync.noteLocalChange();
            mqttClient.publish(config.remoteTopic, config.minSoc);
          }
        })
        .then(() => gridControlAutomation.runNow(db))
        .catch(() => {})
        .finally(() => {
          const data = readBatterieData(mqttClient.getCache());
          res.send(renderBatterie({ config, data, message: 'Konfiguration gespeichert.' }));
        });
    });
  });

  router.get('/batterie/data', requireAuth, (req, res) => {
    const data = readBatterieData(mqttClient.getCache());
    res.json(data);
  });

  return router;
}

module.exports = batterieRoutes;
