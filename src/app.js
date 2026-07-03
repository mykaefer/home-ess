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
const messenSchaltenRoutes = require('./routes/messen-schalten');
const adapterRoutes = require('./routes/adapters');
const statesRoutes = require('./routes/states');
const { buildWallboxSnapshot, totalWallboxPowerWatt } = require('./wallbox/aggregation');
const { listWallboxes } = require('./wallbox/boxes');
const { buildActorSnapshot } = require('./messen-schalten/aggregation');
const { recordFunctionSamples, currentFunctionPowerW } = require('./messen-schalten/functions');
const prognosisRoutes = require('./routes/prognosis');
const { initModules, isEnabled } = require('./modules');
const adapterHost = require('./adapters/host');
const gridControlAutomation = require('./grid-control/automation');
const operatingState = require('./operating-state');
const operatingLevelHandler = require('./operating-level/handler');
const { recordConsumptionSample } = require('./prognosis/forecast');
const { readBatterieData } = require('./batterie/config');
const { updateBatteryEnergy } = require('./batterie/energy');
const prognosisBehavior = require('./prognosis/behavior');
const jobs = require('./job-scheduler');
const { updatePoolEnergyModel } = require('./pool/energy-model');

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
  app.use(messenSchaltenRoutes(db));
  app.use(adapterRoutes(db));
  app.use(statesRoutes(db));

  const operatingReady = operatingState.init(db).then(() => {
    operatingState.startMqttSync(db);
  });

  // Optionale Module und globalen Betriebszustand laden – muss abgeschlossen sein bevor
  // loadAllStateDefinitions läuft, da isEnabled() sonst noch falsch zurückgibt.
  const modulesReady = initModules(db)
    .catch(() => {})
  // Adapter-Host vor loadAllStateDefinitions hochfahren: Registry/Schemes und der
  // Router-Host müssen stehen, bevor State-Definitionen (ggf. mit prefix://-Topics)
  // ihre Routen aufbauen.
  const adaptersReady = adapterHost.initAdapters(db).catch((err) => {
    console.error('[adapters] Init fehlgeschlagen:', err && err.message);
  });
  modulesReady
    .then(() => operatingReady)
    .then(() => adaptersReady)
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
      const rawCounters = snapshot.raw.rawCounters || {};
      const hasCounterReading = ['import', 'export'].some((direction) =>
        Object.values(rawCounters[direction] || {}).some((value) => value != null));
      // Beim Start läuft der erste Job eventuell vor den retained MQTT-Werten.
      // Eine aus lauter fehlenden Quellen berechnete Null darf den kumulierten
      // Tagesstand nicht neu basieren.
      if (!hasCounterReading && !(Number(snapshot.raw.today.eigenverbrauch) > 0)) return;
      const poolEnergy = await updatePoolEnergyModel(db, cache, snapshot.raw.eigenverbrauchPower);
      // Eigenverbrauch ist hier die physikalische Hausbilanz PV + Netzsaldo.
      // `summe` addiert die separat dargestellte Netzkomponente ein zweites Mal
      // und ist deshalb keine geeignete kumulierte Quelle für das Lernmodell.
      // Funktionszugeordnete Geräte (Licht, Waschen, …) werden separat
      // statistisiert und deshalb – wie Wallbox und Pool – aus dem gelernten
      // Haus-Grundverbrauch herausgerechnet.
      const functionPower = await currentFunctionPowerW(db, cache).catch(() => 0);
      await recordConsumptionSample(db, snapshot.raw.today.eigenverbrauch, cache, {
        batteryPower: readBatterieData(cache).power,
        wallboxPower: totalWallboxPowerWatt(cache, boxes),
        poolPower: poolEnergy.currentPowerW,
        functionPower,
      });
    } catch (_) {
      // Der nächste Minutentakt versucht es erneut.
    }
  };
  jobs.runExclusive('consumption', updateConsumption).catch(() => {});
  jobs.schedule('consumption', 60000, updateConsumption);
  jobs.schedule('pvAggregation', 60000, () =>
    listPvPlants(db)
      .then((plants) => touchPhotovoltaikAggregation(db, mqttClient.getCache(), plants))
  );

  // Wallbox-Zähler/Summen je Box fortschreiben (Tag/Woche/Monat/Jahr + Vorjahr,
  // bzw. Power-Integration ohne Zähler-Topic). Nur aktiv, wenn Boxen angelegt sind.
  const updateWallbox = () => {
    return buildWallboxSnapshot(db, mqttClient.getCache()).catch(() => {});
  };
  jobs.runExclusive('wallboxAggregation', updateWallbox).catch(() => {});
  jobs.schedule('wallboxAggregation', 60000, updateWallbox);

  // Messen + Schalten: „Leistung aus Zählerfortschritt" je Gerät fortschreiben
  // (Δkwh/Δt; 0 W nach über 10 min ohne Fortschritt) und danach die
  // Funktions-Stundenstatistik (Licht, Waschen, …) integrieren.
  const updateActors = () => buildActorSnapshot(db, mqttClient.getCache())
    .then(() => recordFunctionSamples(db, mqttClient.getCache()))
    .catch(() => {});
  jobs.runExclusive('messSchaltAggregation', updateActors).catch(() => {});
  jobs.schedule('messSchaltAggregation', 60000, updateActors);

  // Akku-Lade-/Entladeenergie fortschreiben (für die Bereinigung der
  // Jahres-Prognosebasis um die Netto-Akkuladung).
  const updateBattery = () => {
    return updateBatteryEnergy(db, mqttClient.getCache()).catch(() => {});
  };
  jobs.runExclusive('batteryEnergy', updateBattery).catch(() => {});
  jobs.schedule('batteryEnergy', 60000, updateBattery);

  // Sonnenintensität als Zeitreihe erfassen (für 10-Minuten-/Tages-/Vortagsmittel).
  jobs.runExclusive('sunIntensity', () => recordSample(db, mqttClient.getCache())).catch(() => {});
  jobs.schedule('sunIntensity', 60000, () => recordSample(db, mqttClient.getCache()));

  // Wetterprognose (Open-Meteo) für die PV-Prognose vorhalten: beim Start einmal
  // füllen und alle 30 Minuten aktualisieren. Fehler still — die Seite bleibt nutzbar.
  jobs.runExclusive('weather', () => refreshWeather(db)).catch(() => {});
  jobs.schedule('weather', 30 * 60 * 1000, () => refreshWeather(db));

  // Selbstkalibrierung: an Klarhimmel-Momenten den tageszeit-abhängigen
  // Kalibrierfaktor je Anlage sanft nachziehen (Gates inkl. Wetter/SoC im Modul).
  jobs.schedule('pvCalibration', 60000, () =>
    listPvPlants(db)
      .then((plants) => recordCalibration(db, mqttClient.getCache(), plants))
  );

  return { app, db };
}

module.exports = { createApp };
