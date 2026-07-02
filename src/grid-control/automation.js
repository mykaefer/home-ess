'use strict';

const mqttClient = require('../mqtt/client');
const { isEnabled } = require('../modules');
const { loadBatterieConfig, readBatterieData } = require('../batterie/config');
const { loadGridControlConfig, STATE_IDS } = require('./config');
const gridControlLog = require('./log');
const operatingState = require('../operating-state');
const {
  EIGENVERBRAUCH_L1_STATE_ID,
  EIGENVERBRAUCH_L2_STATE_ID,
  EIGENVERBRAUCH_L3_STATE_ID,
} = require('../stromverbrauch/config');
const { localCalendar } = require('../local-time');
const metrics = require('../runtime-metrics');

// Frische-Fenster für sicherheitskritische Messwerte: Nach einem
// Verbindungsabbruch bleiben alte Werte im Cache stehen. Einträge, die älter als
// dieses Fenster sind, gelten als unbekannt (null) statt als gültige Messung.
const FREQUENCY_MAX_AGE_MS = 60000;

// Bestätigung der Ziel-Topics (geschlossene Regelschleife): Nach dem Schreiben
// eines Schaltbefehls muss der Broker den Soll-Wert zurückmelden. Tut er das
// nicht innerhalb des Timeouts, gilt die Schaltung als NICHT durchgeführt → der
// Befehl wird wiederholt und eine Warnung gesetzt (sicherheitskritisch).
const COMMAND_CONFIRM_TIMEOUT_MS = 20000;
const COMMAND_REPUBLISH_MS = 4000;

const state = {
  socLow: false, socHigh: false, voltageLow: false, voltageHigh: false,
  temperature: false, load: false, gridActual: false, feedInActual: false,
  gridPublished: null, feedInPublished: null,
  gridConfirmed: null, feedInConfirmed: null,
  gridWarned: false, feedInWarned: false,
  gridZeroSince: 0,
  loadOffSince: 0,
  gridFrequencies: [null, null, null],
  inverterLoads: [null, null, null],
};

// Pro Ziel-Topic der Stand der Bestätigung: { topic, desired, lastPublishAt,
// unconfirmedSince, warned }. Wird bei Topic-Wechsel verworfen.
const commandTracks = new Map();

// Cache-Wert nur zurückgeben, wenn er nicht überaltert ist; sonst null.
function freshCacheValue(cache, id, maxAgeMs, now) {
  const entry = cache.get(id);
  if (!entry || entry.value == null) return null;
  if (maxAgeMs && entry.receivedAt != null && now - entry.receivedAt > maxAgeMs) return null;
  return entry.value;
}

// ── Audit-Log ──────────────────────────────────────────────────────────────
// Letzter geloggter Zustand (quantisiert) zum Erkennen von Änderungen.
let logSnapshot = null;

function appendLog(db, category, message, values) {
  // Nicht-blockierend; Fehler (z. B. Tabelle fehlt im Test) werden geschluckt.
  Promise.resolve(gridControlLog.appendLog(db, category, message, values)).catch(() => {});
}

function logNum(value) {
  return value == null ? '—' : value;
}

// Kompakter Werte-Schnappschuss, der jedem Log-Eintrag beigestellt wird.
function formatLogValues(snap) {
  return (
    `SoC ${logNum(snap.soc)} % · ` +
    `Spannung ${logNum(snap.voltage)} V · ` +
    `Frequenz ${snap.f.map(logNum).join('/')} Hz · ` +
    `Last ${snap.l.map(logNum).join('/')} W`
  );
}

// Diff des aktuellen gegen den vorigen Schnappschuss → Log-Einträge schreiben.
// Kategorien: 'info' (neutral), 'action' (gelb, Grid-Control hat geschaltet),
// 'critical' (rot, kritischer Zustand erkannt).
function recordLog(db, snap) {
  const prev = logSnapshot;
  logSnapshot = snap;
  const vals = formatLogValues(snap);

  if (!prev) {
    // Einmaliger Startmarker; danach werden nur noch Schwellen/Aktionen geloggt.
    appendLog(db, 'info', 'Grid-Control-Überwachung gestartet', vals);
    return;
  }

  // Kritische Schwellen (rot) – nur beim Überschreiten, nicht bei jeder Wertänderung.
  if (snap.voltageLow && !prev.voltageLow) appendLog(db, 'critical', 'Akkuspannung zu niedrig', vals);
  if (snap.voltageHigh && !prev.voltageHigh) appendLog(db, 'critical', 'Akkuspannung zu hoch', vals);
  if (snap.tempWarn && !prev.tempWarn) appendLog(db, 'critical', 'Wechselrichter-Temperaturwarnung aktiv', vals);
  if (snap.load && !prev.load) appendLog(db, 'critical', 'Wechselrichterlast zu hoch', vals);
  if (snap.socLow && !prev.socLow) appendLog(db, 'critical', 'Akku-SoC am unteren Limit', vals);
  if (snap.emergency && !prev.emergency) appendLog(db, 'critical', 'Notstrombetrieb aktiviert (kein Netz erkannt)', vals);
  // Erst nach Ablauf des Bestätigungs-Timeouts (COMMAND_CONFIRM_TIMEOUT_MS) als
  // kritisch protokollieren, nicht schon im selben Tick wie die Schaltung. Der
  // Broker kann den Soll-Wert unmöglich innerhalb desselben 2-Sekunden-Zyklus
  // zurückmelden; ein Log direkt auf den momentan-„nicht bestätigt"-Zustand
  // erzeugte sonst zu jeder normalen, wenige Sekunden später bestätigten
  // Schaltung einen roten Fehlalarm. `warned` markiert die tatsächlich
  // anhaltende Divergenz (≥ 20 s) – dieselbe Bedingung, die auch die
  // MQTT-Warnung auslöst.
  if (snap.gridWarned && !prev.gridWarned) {
    appendLog(db, 'critical', 'Netzschaltung vom Broker nicht bestätigt – wird wiederholt', vals);
  }
  if (snap.feedInWarned && !prev.feedInWarned) {
    appendLog(db, 'critical', 'Überschusseinspeisung vom Broker nicht bestätigt – wird wiederholt', vals);
  }

  // Ausgeführte Schaltaktionen (gelb).
  if (snap.gridActual !== prev.gridActual) {
    appendLog(db, 'action', snap.gridActual ? 'Netz zugeschaltet' : 'Netz abgeschaltet', vals);
  }
  if (snap.feedInActual !== prev.feedInActual) {
    appendLog(db, 'action', snap.feedInActual ? 'Überschusseinspeisung aktiviert' : 'Überschusseinspeisung deaktiviert', vals);
  }
  if (snap.level !== prev.level) appendLog(db, 'action', `Betriebslevel ${prev.level} → ${snap.level}`, vals);
  if (!snap.emergency && prev.emergency) appendLog(db, 'action', 'Notstrombetrieb beendet', vals);
}

function load(loader, db) {
  return new Promise((resolve) => loader(db, resolve));
}

function parseNumber(value) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function comparable(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === 'true' || text === '1') return '1';
  if (text === 'false' || text === '0') return '0';
  return text;
}

function updateExtremeWindows(value, lowThreshold, highThreshold, hysteresis, previousLow, previousHigh) {
  if (value == null) return { low: false, high: false, available: false };
  return {
    low: previousLow ? value < lowThreshold + hysteresis : value <= lowThreshold,
    high: previousHigh ? value > highThreshold - hysteresis : value >= highThreshold,
    available: true,
  };
}

function updateLoadSwitch(loads, onThresholds, offThresholds, previous) {
  const overload = loads.some((load, index) => load != null && onThresholds[index] != null && load > onThresholds[index]);
  if (overload) return true;
  if (!previous) return false;
  const allBelow = loads.every((load, index) => load != null && offThresholds[index] != null && load < offThresholds[index]);
  return !allBelow;
}

// Ausschaltverzögerung für die Wechselrichterlast. Die Verzögerung beginnt erst,
// wenn alle Phasen unter ihrer Rückschwelle liegen. Schon eine Phase oberhalb
// ihrer Rückschwelle verwirft den laufenden Timer; dadurch führen kurze
// Lastabfälle nicht zu einem Aus-/Einschaltzyklus.
function updateLoadSwitchDelayed(loads, onThresholds, offThresholds, previous, offSince, delayMs, now) {
  const overload = loads.some((load, index) => load != null && onThresholds[index] != null && load > onThresholds[index]);
  if (overload) return { active: true, offSince: 0 };
  if (!previous) return { active: false, offSince: 0 };

  const allBelow = loads.every((load, index) => load != null && offThresholds[index] != null && load < offThresholds[index]);
  if (!allBelow) return { active: true, offSince: 0 };
  if (delayMs <= 0) return { active: false, offSince: 0 };

  const startedAt = offSince || now;
  if (now - startedAt >= delayMs) return { active: false, offSince: 0 };
  return { active: true, offSince: startedAt };
}

let runtimeDb = null;
let runtimeLoaded = false;
let runtimeInitialized = false;

function loadRuntimeState(db) {
  if (runtimeDb === db && runtimeLoaded) return Promise.resolve();
  if (runtimeDb !== db) {
    runtimeDb = db;
    runtimeLoaded = false;
    runtimeInitialized = false;
    state.load = false;
    state.loadOffSince = 0;
  }
  return new Promise((resolve) => {
    db.get('SELECT load_active, load_off_since, initialized FROM grid_control_runtime WHERE id = 1', (err, row) => {
      if (!err && row) {
        runtimeInitialized = !!row.initialized;
        state.load = runtimeInitialized && !!row.load_active;
        state.loadOffSince = runtimeInitialized ? Number(row.load_off_since) || 0 : 0;
      }
      // Alte bzw. bewusst minimale Test-Schemata besitzen die Runtime-Tabelle
      // nicht. Die Regelung funktioniert dort weiterhin, nur ohne Persistenz.
      runtimeLoaded = true;
      resolve();
    });
  });
}

function saveRuntimeState(db) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO grid_control_runtime (id, load_active, load_off_since, initialized)
       VALUES (1, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         load_active=excluded.load_active,
         load_off_since=excluded.load_off_since,
         initialized=1`,
      [state.load ? 1 : 0, state.loadOffSince || 0],
      (err) => {
        if (!err) runtimeInitialized = true;
        resolve();
      }
    );
  });
}

function hasPhaseFailure(frequencies) {
  return frequencies.some((frequency) => frequency === 0);
}

function allPhasesPresent(frequencies) {
  return frequencies.every((frequency) => frequency != null && frequency > 0);
}

function currentDayKey(cache, now = new Date()) {
  return localCalendar(cache, 'Europe/Berlin', now).dateKey;
}

function publishWarning(cfg, text) {
  if (cfg.warningTextTopic) mqttClient.publish(cfg.warningTextTopic, text);
  if (cfg.warningActiveTopic) mqttClient.publish(cfg.warningActiveTopic, true);
}

function publishSwitch(topic, enabled) {
  return !!(topic && mqttClient.publish(topic, enabled ? 1 : 0));
}

async function updateMinimumSoc(db, batteryCfg, currentSoc, gridCfg) {
  if (currentSoc == null) return;
  const adjusted = Math.min(100, Math.max(batteryCfg.minSoc, Math.ceil(currentSoc / 5) * 5));
  await new Promise((resolve) => {
    db.run('UPDATE batterie_config SET min_soc = ? WHERE id = 1', [adjusted], () => resolve());
  });
  if (batteryCfg.minSocTopic) mqttClient.publish(batteryCfg.minSocTopic, adjusted);
  publishWarning(
    gridCfg,
    `Batterie war unerwartet frühzeitig leer. Mindest-SoC wurde von ${batteryCfg.minSoc} % auf ${adjusted} % angepasst.`
  );
  if (adjusted !== Number(batteryCfg.minSoc)) {
    appendLog(
      db,
      'action',
      `Mindest-SoC von ${batteryCfg.minSoc} % auf ${adjusted} % angehoben (Batterie unerwartet früh leer)`,
      `SoC ${currentSoc == null ? '—' : Math.round(currentSoc)} %`
    );
  }
}

// Geschlossene Regelschleife für ein Schalt-Ziel-Topic: vergleicht den Soll-Wert
// gegen den TATSÄCHLICH vom Broker zurückgemeldeten Wert (nicht gegen einen
// optimistisch gemerkten Eigenwert). Stimmt er nicht überein – oder ist die
// Verbindung getrennt, sodass keine Bestätigung vorliegt –, wird der Befehl
// (gedrosselt) erneut geschrieben und nach einem Timeout eine Warnung gesetzt.
function reconcileCommand(key, topic, stateId, desired, ctx) {
  const { cache, connected, cfg, now, hasMeasurement, label } = ctx;
  if (!topic) {
    commandTracks.delete(key);
    return null;
  }
  if (!hasMeasurement) return commandTracks.get(key) ? commandTracks.get(key).confirmed : null;

  let track = commandTracks.get(key);
  if (!track || track.topic !== topic) {
    track = { topic, desired: null, lastPublishAt: 0, unconfirmedSince: 0, warned: false, confirmed: null };
  }

  const desiredCmp = desired ? '1' : '0';
  const brokerRaw = cache.get(stateId)?.value;
  const brokerCmp = brokerRaw == null ? null : comparable(brokerRaw);
  const confirmed = connected && brokerCmp === desiredCmp;

  // Soll-Wechsel: Bestätigungs-Tracking zurücksetzen und sofort senden.
  if (track.desired !== desired) {
    track.desired = desired;
    track.unconfirmedSince = 0;
    track.warned = false;
    track.lastPublishAt = 0;
  }

  if (confirmed) {
    track.unconfirmedSince = 0;
    track.warned = false;
  } else {
    if (!track.unconfirmedSince) track.unconfirmedSince = now;
    // (Re-)Publish gedrosselt – schreibt den Befehl wiederholt, bis der Broker
    // den Soll-Wert bestätigt (selbstheilend nach verlorenem Write/Reconnect).
    if (now - track.lastPublishAt >= COMMAND_REPUBLISH_MS) {
      if (publishSwitch(topic, desired)) track.lastPublishAt = now;
    }
    // Bleibt die Bestätigung zu lange aus → Warnung (Schaltung greift nicht).
    if (!track.warned && now - track.unconfirmedSince >= COMMAND_CONFIRM_TIMEOUT_MS) {
      const reported = brokerCmp == null ? 'keinen Wert' : brokerCmp;
      const reason = connected ? `Broker meldet ${reported}` : 'keine Broker-Verbindung';
      publishWarning(cfg, `${label} nicht bestätigt: Ziel-Topic „${topic}" sollte ${desiredCmp} sein (${reason}). Der Befehl wird wiederholt.`);
      track.warned = true;
    }
  }

  track.confirmed = confirmed;
  commandTracks.set(key, track);
  return confirmed;
}

async function tick(db) {
  if (!isEnabled('grid-control') && !operatingState.getState().emergencyMode) {
    await operatingState.updateAutarkForDay(db, currentDayKey(mqttClient.getCache()), false);
    return getState();
  }

  const [cfg, batteryCfg] = await Promise.all([
    load(loadGridControlConfig, db), load(loadBatterieConfig, db),
  ]);
  await loadRuntimeState(db);
  const cache = mqttClient.getCache();
  const now = Date.now();
  const connected = mqttClient.getStatus().connected;
  const battery = readBatterieData(cache);
  const soc = parseNumber(battery.soc);
  const voltage = parseNumber(battery.voltage);
  const warningEntry = cache.get(STATE_IDS.temperatureWarning);
  const warningValue = warningEntry ? warningEntry.value : null;
  // Frequenzen mit Frische-Prüfung: stale Werte (z. B. nach Verbindungsabbruch)
  // dürfen die Notstromerkennung weder fälschlich auslösen noch entriegeln.
  const frequencies = [STATE_IDS.gridFrequencyL1, STATE_IDS.gridFrequencyL2, STATE_IDS.gridFrequencyL3]
    .map((id) => parseNumber(freshCacheValue(cache, id, FREQUENCY_MAX_AGE_MS, now)));
  const loads = [EIGENVERBRAUCH_L1_STATE_ID, EIGENVERBRAUCH_L2_STATE_ID, EIGENVERBRAUCH_L3_STATE_ID]
    .map((id) => parseNumber(cache.get(id)?.value));
  state.gridFrequencies = frequencies;
  state.inverterLoads = loads;

  const oldVoltageLow = state.voltageLow;
  const oldTemperature = state.temperature;
  const gridBeforeTemperature = state.socLow || state.socHigh || state.voltageLow || state.voltageHigh;

  const lowSocThreshold = Number(batteryCfg.minSoc) + Number(cfg.socLowerOffset);
  const highSocThreshold = 100 - Number(cfg.socUpperOffset);
  const socWindows = cfg.socEnabled
    ? updateExtremeWindows(soc, lowSocThreshold, highSocThreshold, cfg.socHysteresis, state.socLow, state.socHigh)
    : { low: false, high: false, available: false };
  const voltageWindows = cfg.voltageEnabled
    ? updateExtremeWindows(voltage, Number(batteryCfg.lowerVoltage), Number(batteryCfg.upperVoltage), cfg.voltageHysteresis, state.voltageLow, state.voltageHigh)
    : { low: false, high: false, available: false };

  state.socLow = socWindows.low;
  state.socHigh = socWindows.high;
  state.voltageLow = voltageWindows.low;
  state.voltageHigh = voltageWindows.high;
  state.temperature = !!(cfg.temperatureEnabled && warningValue != null && comparable(warningValue) === comparable(cfg.temperatureWarningValue));
  const previousLoad = state.load;
  const previousLoadOffSince = state.loadOffSince;
  const brokerGridValue = cache.get(STATE_IDS.gridCommand)?.value;
  if (cfg.loadEnabled) {
    // Bei einer noch nicht initialisierten Runtime (erstes Upgrade) übernimmt
    // eine aktive Broker-Rückmeldung den Schaltzustand. Damit startet bei einem
    // Neustart nicht versehentlich sofort ein Ausschaltbefehl.
    if (!runtimeInitialized && comparable(brokerGridValue) === '1') {
      state.load = true;
    }
    const delayedLoad = updateLoadSwitchDelayed(
      loads,
      [parseNumber(cfg.loadOnL1), parseNumber(cfg.loadOnL2), parseNumber(cfg.loadOnL3)],
      [parseNumber(cfg.loadOffL1), parseNumber(cfg.loadOffL2), parseNumber(cfg.loadOffL3)],
      state.load,
      state.loadOffSince,
      Number(cfg.loadOffDelaySeconds) * 1000,
      now
    );
    state.load = delayedLoad.active;
    state.loadOffSince = delayedLoad.offSince;
  } else {
    state.load = false;
    state.loadOffSince = 0;
  }
  const canInitializeRuntime = runtimeInitialized || brokerGridValue != null || state.load;
  if (canInitializeRuntime && (!runtimeInitialized || state.load !== previousLoad || state.loadOffSince !== previousLoadOffSince)) {
    await saveRuntimeState(db);
  }

  if (!cfg.socEnabled || socWindows.available) {
    await operatingState.updateAutarkForDay(db, currentDayKey(cache), state.socLow);
  }

  if (!oldVoltageLow && state.voltageLow) {
    await updateMinimumSoc(db, batteryCfg, soc, cfg);
  }
  if (!oldTemperature && state.temperature && gridBeforeTemperature) {
    publishWarning(cfg, 'Wechselrichter meldet eine Temperaturwarnung, obwohl das Netz bereits durch einen anderen Auslöser zugeschaltet war.');
  }

  let hasMeasurement = socWindows.available || voltageWindows.available || warningValue != null || loads.some((value) => value != null) || state.gridPublished !== null;
  const lowOrTemperature = state.socLow || state.voltageLow || state.temperature || state.load;
  const high = state.socHigh || state.voltageHigh;
  const highForGrid = state.voltageHigh || (state.socHigh && cfg.feedInAllowed);
  const baseGridActual = lowOrTemperature || highForGrid;
  let globalState = operatingState.getState();
  hasMeasurement = hasMeasurement || globalState.emergencyMode || frequencies.some((value) => value != null);

  // Erst drei erkannte (frische) Phasen entriegeln den Notstromzustand.
  // Null/fehlende/überalterte Werte auf nur einer Phase reichen ausdrücklich
  // nicht aus – nach einem Verbindungsabbruch fallen stale Werte über die
  // Frische-Prüfung auf null und verhindern so eine voreilige Entriegelung.
  if (globalState.emergencyMode && allPhasesPresent(frequencies)) {
    await operatingState.setEmergencyMode(db, false);
    state.gridZeroSince = 0;
    globalState = operatingState.getState();
  }

  state.gridActual = baseGridActual || globalState.emergencyMode;
  state.feedInActual = !!(cfg.feedInAllowed && cfg.feedInCommandTopic && high && !lowOrTemperature && !globalState.emergencyMode);

  // Ein expliziter Frequenzwert 0 auf einer beliebigen Phase startet die
  // Erkennungszeit. Danach bleibt die Verriegelung bis zur Rückkehr aller Phasen.
  if (!globalState.emergencyMode && cfg.gridCommandTopic && state.gridActual && hasPhaseFailure(frequencies)) {
    if (!state.gridZeroSince) state.gridZeroSince = now;
    if (now - state.gridZeroSince >= Number(cfg.gridDetectionSeconds) * 1000) {
      await operatingState.setEmergencyMode(db, true);
      publishWarning(cfg, 'Kein Netz erkannt. Es wurde in den Notstrombetrieb gewechselt.');
      globalState = operatingState.getState();
      state.gridActual = true;
      state.feedInActual = false;
    }
  } else if (!globalState.emergencyMode) {
    state.gridZeroSince = 0;
  }

  // Grid-Control verwaltet ausschließlich die Notstrom-Verriegelung und die
  // Netzschaltung. Alle Betriebslevel 1–5 gehören der Prognose.
  if (globalState.emergencyMode) {
    state.gridActual = true;
    state.feedInActual = false;
  }

  // Geschlossene Regelschleife: Soll-Werte gegen die tatsächliche Broker-Rückmeldung
  // abgleichen und bei Abweichung erneut schreiben (statt fire-and-forget).
  const ctx = { cache, connected, cfg, now, hasMeasurement };
  // Beim allerersten Start nach dem Upgrade ist noch kein persistierter
  // Lastzustand vorhanden. Bis die Broker-Rückmeldung eintrifft (oder eine
  // Überlast einschaltet), senden wir daher keinen vorschnellen Aus-Befehl.
  const gridHasMeasurement = hasMeasurement && !(
    cfg.loadEnabled && !runtimeInitialized && brokerGridValue == null && !state.gridActual
  );
  state.gridConfirmed = reconcileCommand('grid', cfg.gridCommandTopic, STATE_IDS.gridCommand, state.gridActual, { ...ctx, hasMeasurement: gridHasMeasurement, label: 'Netzschaltung' });
  state.feedInConfirmed = reconcileCommand('feedIn', cfg.feedInCommandTopic, STATE_IDS.feedInCommand, state.feedInActual, { ...ctx, label: 'Überschusseinspeisung' });
  // Anhaltende (≥ Timeout) Divergenz für das Audit-Log – siehe recordLog.
  state.gridWarned = !!commandTracks.get('grid')?.warned;
  state.feedInWarned = !!commandTracks.get('feedIn')?.warned;
  // Für die hasMeasurement-Heuristik: sobald ein Netz-Topic konfiguriert ist und
  // wir hier ankommen, gilt die Steuerung als aktiv.
  if (hasMeasurement && cfg.gridCommandTopic) state.gridPublished = state.gridActual;
  if (hasMeasurement && cfg.feedInCommandTopic) state.feedInPublished = state.feedInActual;

  // Audit-Log: Werte (quantisiert) und Zustände gegen den letzten Stand
  // protokollieren. Nur wenn es überhaupt etwas zu überwachen gibt.
  if (hasMeasurement) {
    const finalState = operatingState.getState();
    recordLog(db, {
      soc: soc == null ? null : Math.round(soc),
      voltage: voltage == null ? null : Math.round(voltage * 10) / 10,
      f: frequencies.map((x) => (x == null ? null : Math.round(x * 10) / 10)),
      l: loads.map((x) => (x == null ? null : Math.round(x / 50) * 50)),
      tempWarn: !!state.temperature,
      socLow: !!state.socLow,
      socHigh: !!state.socHigh,
      voltageLow: !!state.voltageLow,
      voltageHigh: !!state.voltageHigh,
      load: !!state.load,
      gridActual: !!state.gridActual,
      feedInActual: !!state.feedInActual,
      emergency: !!finalState.emergencyMode,
      level: finalState.operatingLevel,
      gridConfirmed: state.gridConfirmed,
      feedInConfirmed: state.feedInConfirmed,
      gridWarned: state.gridWarned,
      feedInWarned: state.feedInWarned,
    });
  }

  return getState();
}

function getState() {
  return {
    gridBySoc: state.socLow || state.socHigh,
    gridByVoltage: state.voltageLow || state.voltageHigh,
    gridByTemperature: state.temperature,
    gridByLoad: state.load,
    gridActual: state.gridActual,
    feedInActual: state.feedInActual,
    gridCommandConfirmed: state.gridConfirmed,
    feedInCommandConfirmed: state.feedInConfirmed,
    mqttConnected: mqttClient.getStatus().connected,
    gridFrequencies: [...state.gridFrequencies],
    inverterLoads: [...state.inverterLoads],
    ...operatingState.getState(),
  };
}

let timer = null;
let unsubscribe = null;
let running = false;
let rerunRequested = false;
let activeRun = Promise.resolve();

const RELEVANT_STATE_IDS = new Set([
  'batterie.soc', 'batterie.voltage',
  STATE_IDS.gridCommand, STATE_IDS.feedInCommand, STATE_IDS.temperatureWarning,
  STATE_IDS.gridFrequencyL1, STATE_IDS.gridFrequencyL2, STATE_IDS.gridFrequencyL3,
  EIGENVERBRAUCH_L1_STATE_ID, EIGENVERBRAUCH_L2_STATE_ID, EIGENVERBRAUCH_L3_STATE_ID,
]);

function isRelevantEvent(event) {
  const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
  return keys.some((key) => RELEVANT_STATE_IDS.has(String(key)));
}

// Direkte Aufrufe (Routen/Tests) bleiben awaitbar. Bursts während eines laufenden
// Ticks werden auf genau einen Folgetick verdichtet, statt eine lange Promise-
// Kette aufzubauen.
function runNow(db) {
  if (running) {
    rerunRequested = true;
    metrics.counter('grid.coalesced');
    return activeRun;
  }
  running = true;
  activeRun = (async () => {
    let result;
    do {
      rerunRequested = false;
      result = await metrics.measure('grid.tick', () => tick(db));
    } while (rerunRequested);
    return result;
  })().finally(() => { running = false; });
  return activeRun;
}
function init(db) {
  gridControlLog.initLog(db).catch(() => {});
  if (!unsubscribe) unsubscribe = mqttClient.onValuesChanged((event) => {
    metrics.counter('bus.events');
    if (isRelevantEvent(event)) runNow(db).catch(() => {});
    else metrics.counter('grid.irrelevantEvents');
  });
  if (!timer) timer = setInterval(() => runNow(db).catch(() => {}), 2000);
  runNow(db).catch(() => {});
}

module.exports = { init, runNow, getState, isRelevantEvent, updateExtremeWindows, updateLoadSwitch, updateLoadSwitchDelayed, hasPhaseFailure, allPhasesPresent, currentDayKey };
