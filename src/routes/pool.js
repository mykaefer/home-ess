'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { isEnabled } = require('../modules');
const { loadPoolConfig, savePoolConfig, readPoolValue, subscribePoolTopics } = require('../pool/config');
const { loadBatterieConfig } = require('../batterie/config');
const poolAutomation = require('../pool/automation');
const mqttClient = require('../mqtt/client');
const renderPool = require('../views/pool');

function poolRoutes(db) {
  const router = express.Router();

  // Beim App-Start einmalig Topics abonnieren + Automation starten.
  loadPoolConfig(db, (cfg) => subscribePoolTopics(cfg));
  poolAutomation.init(db);

  function requirePoolEnabled(req, res, next) {
    if (!isEnabled('pool')) return res.redirect('/module');
    next();
  }

  function renderPoolPage(res, options = {}) {
    loadBatterieConfig(db, (batCfg) => {
      const batterieSocConfigured = !!batCfg.socTopic;
      const base = {
        solarOutput: poolAutomation.getSolarOutput(),
        filterOutput: poolAutomation.getFilterOutput(),
        batterieSocConfigured,
        gridControlEnabled: isEnabled('grid-control'),
      };
      if (options.cfg) {
        res.send(renderPool({ ...base, ...options }));
      } else {
        loadPoolConfig(db, (cfg) => res.send(renderPool({ ...base, cfg, ...options })));
      }
    });
  }

  router.get('/pool', requireAuth, requirePoolEnabled, (req, res) => {
    renderPoolPage(res);
  });

  router.post('/pool/config', requireAuth, requirePoolEnabled, (req, res) => {
    savePoolConfig(db, req.body, (err, cfg) => {
      renderPoolPage(res, {
        cfg: err ? req.body : cfg,
        message: err ? 'Fehler beim Speichern.' : 'Konfiguration gespeichert.',
      });
    });
  });

  // Aktuelle Messwerte aus dem MQTT-Cache (für Polling der KPI-Karten).
  router.get('/pool/status', requireAuth, requirePoolEnabled, (req, res) => {
    loadPoolConfig(db, (cfg) => {
      const cache = mqttClient.getCache();
      function val(topic) { return topic ? readPoolValue(cache, topic) : undefined; }

      const status = {};
      if (cfg.temperatureTopic) status.temperature = val(cfg.temperatureTopic);
      if (cfg.solarPumpStatusTopic) status.solarPump = val(cfg.solarPumpStatusTopic);
      if (cfg.filterPumpStatusTopic) status.filterPump = val(cfg.filterPumpStatusTopic);
      if (cfg.phTopic) status.ph = val(cfg.phTopic);
      if (cfg.chlorTopic) status.chlor = val(cfg.chlorTopic);
      status.solarMode = poolAutomation.getPumpMode('solar');
      status.filterMode = poolAutomation.getPumpMode('filter');

      res.json(status);
    });
  });

  // Pumpenmodus setzen: on / off / auto
  router.post('/pool/pump/:which/:mode', requireAuth, requirePoolEnabled, (req, res) => {
    const { which, mode } = req.params;
    if (!['solar', 'filter'].includes(which) || !['on', 'off', 'auto'].includes(mode)) {
      return res.status(400).json({ error: 'Ungültige Parameter.' });
    }
    loadPoolConfig(db, (cfg) => {
      const topic = which === 'solar' ? cfg.solarPumpCommandTopic : cfg.filterPumpCommandTopic;
      if (!topic) return res.status(400).json({ error: 'Kein Steuerungstopic konfiguriert.' });
      poolAutomation.setPumpMode(which, mode);
      poolAutomation.runNow(db)
        .then(() => res.json({ ok: true, mode }))
        .catch(() => res.status(500).json({ error: 'Pumpenautomatik konnte nicht ausgeführt werden.' }));
    });
  });

  return router;
}

module.exports = poolRoutes;
