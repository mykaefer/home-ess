'use strict';

const express = require('express');
const config = require('./config');
const { openDatabase } = require('./db');
const { sessionMiddleware } = require('./auth/session');
const { loadMqttConfig } = require('./mqtt/config');
const mqttClient = require('./mqtt/client');
const { listPvPlants } = require('./photovoltaik/plants');
const { touchPhotovoltaikAggregation } = require('./photovoltaik/aggregation');
const { recordCalibration } = require('./photovoltaik/calibration');
const { buildStromverbrauchSnapshot } = require('./stromverbrauch/aggregation');
const { recordSample } = require('./photovoltaik/sun-intensity');
const { refreshWeather } = require('./photovoltaik/forecast');
const { loadAllStateDefinitions } = require('./mqtt/state-definitions');
const outputEngine = require('./output/engine');

const authRoutes = require('./auth/routes');
const dashboardRoutes = require('./routes/dashboard');
const stromverbrauchRoutes = require('./routes/stromverbrauch');
const photovoltaikRoutes = require('./routes/photovoltaik');
const batterieRoutes = require('./routes/batterie');
const settingsRoutes = require('./routes/settings');
const outputRoutes = require('./routes/output');
const liveRoutes = require('./routes/live');
const modulesRoutes = require('./routes/modules');
const poolRoutes = require('./routes/pool');
const gridControlRoutes = require('./routes/grid-control');
const wallboxRoutes = require('./routes/wallbox');
const { buildWallboxSnapshot, totalWallboxPowerWatt } = require('./wallbox/aggregation');
const { listWallboxes } = require('./wallbox/boxes');
const prognosisRoutes = require('./routes/prognosis');
const { initModules, isEnabled } = require('./modules');
const gridControlAutomation = require('./grid-control/automation');
const operatingState = require('./operating-state');
const operatingLevelHandler = require('./operating-level/handler');
const { recordConsumptionSample } = require('./prognosis/forecast');
const { readBatterieData } = require('./batterie/config');
const { buildEnvironmentSnapshot } = require('./mqtt/config');
const prognosisBehavior = require('./prognosis/behavior');

// Baut die Express-App zusammen: DB öffnen, Middleware, Routen registrieren,
// MQTT-Verbindung mit gespeicherter Konfiguration starten.
function createApp() {
  const db = openDatabase();
  const app = express();

  // Statische Assets (nur CSS o. Ä. — die Seiten selbst werden dynamisch gerendert).
  app.use(express.static(config.PUBLIC_DIR, { index: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(sessionMiddleware(db));

  // Routen-Module. Jede Funktionsgruppe liegt in eigener Datei.
  app.use(authRoutes(db));
  app.use(dashboardRoutes(db));
  app.use(stromverbrauchRoutes(db));
  app.use(photovoltaikRoutes(db));
  app.use(batterieRoutes(db));
  app.use(prognosisRoutes(db));
  app.use(settingsRoutes(db));
  app.use(outputRoutes(db));
  app.use(liveRoutes(db));
  app.use(modulesRoutes(db));
  app.use(poolRoutes(db));
  app.use(gridControlRoutes(db));
  app.use(wallboxRoutes(db));

  const operatingReady = operatingState.init(db).then(() => {
    operatingState.startMqttSync(db);
  });

  // Optionale Module und globalen Betriebszustand laden – muss abgeschlossen sein bevor
  // loadAllStateDefinitions läuft, da isEnabled() sonst noch falsch zurückgibt.
  const modulesReady = initModules(db)
    .catch(() => {})
  modulesReady
    .then(() => operatingReady)
    .then(() => loadAllStateDefinitions(db))
    .then((defs) => {
      mqttClient.setStateDefinitions(defs);
      loadMqttConfig(db, (cfg) => {
        if (cfg.host) mqttClient.connect(cfg);
      });
    })
    .catch(() => {
      loadMqttConfig(db, (cfg) => {
        if (cfg.host) mqttClient.connect(cfg);
      });
    });

  // Output-Engine: schreibt interne Werte bei Aenderung an ihre Ziel-Topics.
  outputEngine.init(db).catch(() => {});
  Promise.all([modulesReady, operatingReady])
    .then(() => {
      operatingLevelHandler.init();
      gridControlAutomation.init(db);
      return prognosisBehavior.init(db);
    })
    .catch(() => {
      operatingLevelHandler.init();
      gridControlAutomation.init(db);
      prognosisBehavior.init(db).catch(() => {});
    });

  const updateConsumption = async () => {
    const cache = mqttClient.getCache();
    try {
      const boxes = isEnabled('wallbox') ? await listWallboxes(db) : [];
      const snapshot = await buildStromverbrauchSnapshot(db, cache);
      await recordConsumptionSample(db, snapshot.raw.today.summe, cache, {
        batteryPower: readBatterieData(cache).power,
        wallboxPower: totalWallboxPowerWatt(cache, boxes),
        outdoorTemperature: buildEnvironmentSnapshot(cache).temperature.value,
      });
    } catch (_) {
      // Der nächste Minutentakt versucht es erneut.
    }
  };
  updateConsumption();
  setInterval(updateConsumption, 60000);
  setInterval(() => {
    listPvPlants(db)
      .then((plants) => touchPhotovoltaikAggregation(db, mqttClient.getCache(), plants))
      .catch(() => {});
  }, 60000);

  // Wallbox-Zähler/Summen je Box fortschreiben (Tag/Woche/Monat/Jahr + Vorjahr,
  // bzw. Power-Integration ohne Zähler-Topic). Nur aktiv, wenn Boxen angelegt sind.
  const updateWallbox = () => {
    buildWallboxSnapshot(db, mqttClient.getCache()).catch(() => {});
  };
  updateWallbox();
  setInterval(updateWallbox, 60000);

  // Sonnenintensität als Zeitreihe erfassen (für 10-Minuten-/Tages-/Vortagsmittel).
  recordSample(db, mqttClient.getCache()).catch(() => {});
  setInterval(() => {
    recordSample(db, mqttClient.getCache()).catch(() => {});
  }, 60000);

  // Wetterprognose (Open-Meteo) für die PV-Prognose vorhalten: beim Start einmal
  // füllen und alle 30 Minuten aktualisieren. Fehler still — die Seite bleibt nutzbar.
  refreshWeather(db).catch(() => {});
  setInterval(() => {
    refreshWeather(db).catch(() => {});
  }, 30 * 60 * 1000);

  // Selbstkalibrierung: an Klarhimmel-Momenten den tageszeit-abhängigen
  // Kalibrierfaktor je Anlage sanft nachziehen (Gates inkl. Wetter/SoC im Modul).
  setInterval(() => {
    listPvPlants(db)
      .then((plants) => recordCalibration(db, mqttClient.getCache(), plants))
      .catch(() => {});
  }, 60000);

  return { app, db };
}

module.exports = { createApp };
