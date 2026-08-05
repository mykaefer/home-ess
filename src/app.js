'use strict';

const express = require('express');
const config = require('./config');
const { openDatabase } = require('./db');
const { sessionMiddleware, authorize } = require('./auth/session');
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
const systemStatesRuntime = require('./states/system-runtime');
const customStates = require('./states/custom');
const timeHandler = require('./time-handler');

const authRoutes = require('./auth/routes');
const dashboardRoutes = require('./routes/dashboard');
const stromverbrauchRoutes = require('./routes/stromverbrauch');
const photovoltaikRoutes = require('./routes/photovoltaik');
const batterieRoutes = require('./routes/batterie');
const settingsRoutes = require('./routes/settings');
const outputRoutes = require('./routes/output');
const liveRoutes = require('./routes/live');
const poolRoutes = require('./routes/pool');
const gridControlRoutes = require('./routes/grid-control');
const wallboxRoutes = require('./routes/wallbox');
const messenSchaltenRoutes = require('./routes/messen-schalten');
const adapterRoutes = require('./routes/adapters');
const statesRoutes = require('./routes/states');
const conditionsRoutes = require('./routes/conditions');
const remoteAccessRoutes = require('./routes/remote-access');
const updateRoutes = require('./routes/update');
const pairingState = require('./remote-access/pairing-state');
const identityStore = require('./remote-access/identity-store');
const connectionService = require('./remote-access/connection-service');
const { buildWallboxSnapshot, totalWallboxPowerWatt } = require('./wallbox/aggregation');
const { listWallboxes } = require('./wallbox/boxes');
const { buildActorSnapshot } = require('./messen-schalten/aggregation');
const { recordFunctionSamples, currentFunctionPowerW } = require('./messen-schalten/functions');
const prognosisRoutes = require('./routes/prognosis');
const { initModules, isEnabled } = require('./modules');
const adapterHost = require('./adapters/host');
const adapterSecrets = require('./adapters/secrets');
const adapterData = require('./adapters/data-store');
const adapterNavigation = require('./adapters/navigation');
const gridControlAutomation = require('./grid-control/automation');
const operatingState = require('./operating-state');
const operatingLevelHandler = require('./operating-level/handler');
const { recordConsumptionSample } = require('./prognosis/forecast');
const { integrateSelfCount, reconcileCompletedHours } = require('./prognosis/self-count');
const { checkSamplingHealth, markSampleHealthy } = require('./prognosis/sampling-health');
const { logSamplingEvent } = require('./prognosis/sampling-log');
const { updateBatteryEnergy } = require('./batterie/energy');
const batterieMinSocSync = require('./batterie/min-soc-sync');
const prognosisBehavior = require('./prognosis/behavior');
const jobs = require('./job-scheduler');
const { updatePoolEnergyModel } = require('./pool/energy-model');
const i18n = require('./i18n');
const conditionEngine = require('./conditions/engine');

// Baut die Express-App zusammen: DB öffnen, Middleware, Routen registrieren,
// MQTT-Verbindung mit gespeicherter Konfiguration starten.
function createApp() {
  const db = openDatabase();
  const app = express();

  // Sprachdateien vor der ersten gerenderten Antwort scannen; die persistierte
  // Auswahl wird parallel aus SQLite geladen.
  i18n.init(db).catch((error) => console.error('[i18n] Initialisierung fehlgeschlagen:', error.message));

  // Statische Assets (nur CSS o. Ä. — die Seiten selbst werden dynamisch gerendert).
  app.use(express.static(config.PUBLIC_DIR, { index: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, _res, next) => i18n.ready().then(() => next(), next));
  app.use((_req, res, next) => {
    const send = res.send.bind(res);
    const json = res.json.bind(res);
    res.send = (body) => {
      const type = String(res.getHeader('Content-Type') || '');
      return send(typeof body === 'string' && !type.includes('application/json') && !body.trimStart().startsWith('<')
        ? i18n.localizeText(body)
        : body);
    };
    res.json = (body) => json(i18n.localizePayload(body));
    next();
  });
  app.use(sessionMiddleware(db));

  // Globale Autorisierung nach dem Rechtemodell (read/operate/write + sichtbare
  // Seiten). openPaths sind ohne Anmeldung erreichbar (Login/Logout und die
  // öffentlichen Energiefluss-Exporte); sharedPaths bleiben von der
  // Seiten-Sichtbarkeit ausgenommen (Header-Live-Daten und der Zugriffs-Endpunkt
  // für Adapter, die jede Seite benötigt).
  app.use(authorize({
    // /adapter-public liefert ausschließlich Dateien aus, die ein Adapter in
    // seinem Manifest ausdrücklich als öffentlich erklärt hat. Ohne diese
    // Ausnahme käme das USB-Flashtool nicht an die Firmware, denn es kann
    // keine Sitzung führen.
    openPaths: ['/', '/login', '/logout', '/energiefluss/export', '/adapter-public', '/update/health'],
    sharedPaths: ['/live', '/me', '/states/catalog'],
  }));

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
  app.use(poolRoutes(db));
  app.use(gridControlRoutes(db));
  app.use(wallboxRoutes(db));
  app.use(messenSchaltenRoutes(db));
  app.use(adapterRoutes(db));
  app.use(statesRoutes(db));
  app.use(conditionsRoutes(db));
  app.use(remoteAccessRoutes());
  app.use(updateRoutes());

  // Fernzugriff: dauerhafte Instanzidentität und Origin-WebSocket vorbereiten.
  // Der Relay-Client ist ein optionaler Subdienst — Fehler dürfen den normalen
  // lokalen Betrieb (MQTT/Dashboard) nie blockieren.
  identityStore.init(config.IDENTITY_DIR);
  adapterSecrets.init(config.IDENTITY_DIR);
  adapterData.init(config.DATA_DIR);
  connectionService.init({ wsUrl: config.RELAY_WS_URL, enabled: config.RELAY_CONNECTION_ENABLED });
  // Nach erfolgreichem `paired` automatisch die WebSocket-Verbindung starten.
  pairingState.setHooks({ onPaired: () => connectionService.onPaired() });
  // Autostart: nur verbinden, wenn bereits eine provisionierte Identität
  // existiert (read-only, legt sonst kein Schlüsselmaterial an).
  identityStore.getProvisionedIdentity()
    .then((prov) => { if (prov && prov.instanceId) connectionService.autostart(); })
    .catch((err) => console.error('[remote-access] Identity-Store nicht ladbar:', err && err.code));

  // Fernzugriff: periodischer Cleanup abgelaufener/terminaler Pairing-Sessions
  // (nur In-Memory; unref-Timer hält den Prozess nicht am Leben).
  pairingState.startCleanup();

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
  const adaptersReady = Promise.all([
    adapterHost.initAdapters(db),
    adapterNavigation.refresh(db),
  ]).catch((err) => {
    console.error('[adapters] Init fehlgeschlagen:', err && err.message);
  });
  const customStatesReady = customStates.init(db).catch((err) => {
    console.error('[custom-states] Init fehlgeschlagen:', err && err.message);
  });
  const timeReady = timeHandler.init(db).catch((err) => {
    console.error('[time-handler] Init fehlgeschlagen:', err && err.message);
  });
  modulesReady
    .then(() => operatingReady)
    .then(() => Promise.all([adaptersReady, customStatesReady, timeReady]))
    .then(() => loadAllStateDefinitions(db))
    .then(async (defs) => {
      mqttClient.setStateDefinitions(defs);
      await conditionEngine.init(db);
      loadMqttConfig(db, (cfg) => {
        i18n.setTimezone(cfg.timezone);
        if (cfg.host) mqttClient.connect(cfg);
      });
    })
    .catch((error) => {
      if (error) console.error('[startup] State-/Bedingungs-Init fehlgeschlagen:', error && error.message);
      conditionEngine.init(db).catch((err) => console.error('[conditions] Fallback-Init fehlgeschlagen:', err && err.message)).finally(() => {
        loadMqttConfig(db, (cfg) => {
          i18n.setTimezone(cfg.timezone);
          if (cfg.host) mqttClient.connect(cfg);
        });
      });
    });

  // Output-Engine: schreibt interne Werte bei Aenderung an ihre Ziel-Topics.
  outputEngine.init(db).catch(() => {});
  Promise.all([modulesReady, operatingReady, timeReady])
    .then(() => {
      systemStatesRuntime.init(db);
      operatingLevelHandler.init();
      gridControlAutomation.init(db);
      batterieMinSocSync.init(db);
      return prognosisBehavior.init(db);
    })
    .catch(() => {
      systemStatesRuntime.init(db);
      operatingLevelHandler.init();
      gridControlAutomation.init(db);
      batterieMinSocSync.init(db);
      prognosisBehavior.init(db).catch(() => {});
    });

  const updateConsumption = async () => {
    const cache = mqttClient.getCache();
    try {
      const boxes = isEnabled('wallbox') ? await listWallboxes(db) : [];
      // Im selben Takt fortschreiben: So kann der exakte Zählerdelta direkt aus
      // dem Hausverbrauch entfernt werden, ohne auf einen synchronen Power-Wert
      // der Wallbox angewiesen zu sein.
      const wallboxSample = boxes.length
        ? await buildWallboxSnapshot(db, cache)
        : { hourlyDeltaKwh: null };
      const snapshot = await buildStromverbrauchSnapshot(db, cache);
      const rawCounters = snapshot.raw.rawCounters || {};
      const hasCounterReading = ['import', 'export'].some((direction) =>
        Object.values(rawCounters[direction] || {}).some((value) => value != null));

      // Fehlererkennung zuerst – auch wenn unten (mangels Daten) nichts erfasst
      // wird: vollständig verpasste Stunden werden als unvollständig markiert
      // (Vortageswert, ausgegraut), statt eine Null zu lernen.
      await checkSamplingHealth(db, cache).catch(() => {});

      const evPowerRaw = snapshot.raw.eigenverbrauchPower;
      // Rein verbraucherseitige Eigenverbrauch-Leistung liegt vor? (Wechselrichter-
      // Ausgang + verbraucherseitige PV). Bewusst unabhängig von den Netzzählern.
      const hasConsumerData = evPowerRaw != null && Number.isFinite(Number(evPowerRaw));
      // Beim Start läuft der erste Job eventuell vor den retained MQTT-Werten.
      // Eine aus lauter fehlenden Quellen berechnete Null darf den kumulierten
      // Tagesstand nicht neu basieren.
      const countersUsable = hasCounterReading || Number(snapshot.raw.today.eigenverbrauch) > 0;
      if (!hasConsumerData && !countersUsable) return;

      const poolEnergy = await updatePoolEnergyModel(db, cache, evPowerRaw);
      // Funktionszugeordnete Geräte (Licht, Waschen, …) werden – wie Wallbox und
      // Pool – aus dem gelernten Haus-Grundverbrauch herausgerechnet.
      const functionPower = await currentFunctionPowerW(db, cache).catch(() => 0);
      const wallboxPower = totalWallboxPowerWatt(cache, boxes);

      // Unabhängige Selbstzählung = Eigenverbrauch-Leistung − Wallbox/Pool/Funktionen
      // (Haus-Grundlast, ≥ 0, sägezahnfrei). Läuft UNABHÄNGIG von den Netzzählern:
      // früher stand sie hinter deren Early-Return, sodass ein fehlender Netzzähler
      // (Verbindungsabbruch/Inselbetrieb) die grid-unabhängige Selbstzählung
      // fälschlich mit abschaltete.
      if (hasConsumerData) {
        const netHousePower = Number(evPowerRaw) - wallboxPower - (poolEnergy.currentPowerW || 0) - functionPower;
        await integrateSelfCount(db, cache, netHousePower).catch(() => {});
        await markSampleHealthy(db).catch(() => {});
      }

      // Zähler-/bilanzbasierte Erfassung braucht zusätzlich einen echten Zählerwert
      // (sonst würde eine Start-Null den kumulierten Tageszähler neu basieren).
      if (countersUsable) {
        await recordConsumptionSample(db, snapshot.raw.today.eigenverbrauch, cache, {
          // Der Stromverbrauchs-Snapshot ist bereits um Laden/Entladen des
          // Hausakkus bereinigt; hier darf die Korrektur nicht erneut erfolgen.
          batteryPower: 0,
          wallboxPower,
          wallboxEnergyDelta: wallboxSample.hourlyDeltaKwh,
          poolPower: poolEnergy.currentPowerW,
          functionPower,
        });
      }
      // Abgeschlossene Stunden absichern: Bilanz ggf. durch die Selbstzählung ersetzen.
      await reconcileCompletedHours(db, cache, { selfMeterPresent: snapshot.raw.selfMeterPresent }).catch(() => {});
    } catch (err) {
      // Der nächste Minutentakt versucht es erneut; die Störung wird protokolliert.
      logSamplingEvent('Fehler im Verbrauchs-Sampling', { error: String((err && err.message) || err) });
    }
  };
  jobs.runExclusive('consumption', updateConsumption).catch(() => {});
  jobs.schedule('consumption', 60000, updateConsumption);
  jobs.schedule('pvAggregation', 60000, () =>
    listPvPlants(db)
      .then((plants) => touchPhotovoltaikAggregation(db, mqttClient.getCache(), plants))
  );

  // Messen + Schalten: „Leistung aus Zählerfortschritt" je Gerät fortschreiben
  // (Δkwh/Δt; 0 W nach über 10 min ohne Fortschritt) und danach die
  // Funktions-Stundenstatistik (Licht, Waschen, …) integrieren.
  const updateActors = () => buildActorSnapshot(db, mqttClient.getCache())
    .then(() => recordFunctionSamples(db, mqttClient.getCache()))
    .catch(() => {});
  jobs.runExclusive('messSchaltAggregation', updateActors).catch(() => {});
  jobs.schedule('messSchaltAggregation', 60000, updateActors);
  // Neue Zählerwerte sofort statt erst im nächsten Minutentakt verarbeiten.
  // Der Browser aktualisiert sich per SSE nach 1 s und sieht damit bereits den
  // fortgeschriebenen internen Zähler bzw. die daraus abgeleitete Leistung.
  let actorAggregationTimer = null;
  mqttClient.onValuesChanged((event) => {
    const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
    // Zähler-Fortschritt sowie Schalt-/Status-Flanken (Letztere für die virtuelle
    // Zählung aus Nennleistung × Schaltzustand) sofort statt erst im Minutentakt
    // verarbeiten.
    if (!keys.some((key) => /^messschalt:\d+:(counter|switch|status)$/.test(String(key)))) return;
    if (actorAggregationTimer) return;
    actorAggregationTimer = setTimeout(() => {
      actorAggregationTimer = null;
      jobs.runExclusive('messSchaltAggregation', updateActors).catch(() => {});
    }, 100);
  });

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
