'use strict';

// Zentralheizung des Moduls „Heizung & Klima".
//
// Sie wird eingeschaltet, sobald mindestens ein Raum Wärme anfordert, und
// abgestellt, sobald keine Anforderung mehr besteht. Ob ein Raum seine Wärme
// von hier oder von seinem lokalen Gerät bekommt, entscheidet allein die
// **Außentemperatur** gegen die je Raum eingestellte Grenztemperatur. Als
// Quelle dient standardmäßig die **systemweite Außentemperatur** aus den
// MQTT-Einstellungen; hier lässt sie sich für die Heizung eigens überschreiben.
// Irgendeine der beiden muss vorliegen, sonst könnte kein Raum die
// Zentralheizung je anfordern. Zwei Ansteuerungsarten:
//
//   modbus — der Brenner wird über einen State angesprochen (z. B. ein Register
//            des Modbus-Adapters). Die Anlage regelt selbst.
//   relais — der Brenner hängt an einem Schaltaktor. Dann sind Vorlauf- und
//            Rücklauftemperatur zwingend: solange die Vorlauftemperatur steigt,
//            läuft der Brenner und darf keinesfalls abgeschaltet werden. Erst
//            wenn sie (und der Rücklauf) wieder sinken, wird abgestellt.
//            Optional hängt hier auch die **Umwälzpumpe** an einem zweiten
//            Schaltaktor. Ist sie hinterlegt, gilt zwingend: erst läuft die
//            Pumpe, dann darf der Brenner starten — und nach dem Brenner läuft
//            sie die eingestellte Nachlaufzeit weiter, bevor auch sie abschaltet.
//
// Jede Brennerlaufzeit wird protokolliert. Aus Verbrauch je Betriebsstunde und
// Preis je Einheit ergeben sich die Heizkosten.

const { normalizeMqttTopic } = require('../mqtt/topics');
const { checkboxValue } = require('../conditions/values');
const { topicForId } = require('../states/system-topics');
const { loadMqttConfig, buildEnvironmentSnapshot } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const timeHandler = require('../time-handler');

// Systemwerte der Zentralheizung: id-Präfix und Ordner auf der States-Seite.
const ID_PREFIX = 'zentralheizung.';
const CATEGORY = 'Zentralheizung';

const MODES = ['relais', 'modbus'];
// Schornsteinfeger-Modus: alle Räume auf diese Temperatur, damit die Heizkörper
// aufdrehen und die Zentralheizung durchheizt.
const SWEEP_TARGET_TEMP = 28;

const MIN_FLOW_WINDOW_SECONDS = 30;
const MAX_FLOW_WINDOW_SECONDS = 1800;
const MAX_HOLD_MINUTES = 240;
// Vorlauf der Pumpe vor dem Brennerstart und Nachlauf nach dem Abschalten.
const MAX_PUMP_LEAD_SECONDS = 600;
const MAX_PUMP_LAG_SECONDS = 3600;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function done(err) {
    if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function validation(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value) {
  const raw = text(value).replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function numberOr(value, fallback, min, max, label) {
  if (text(value) === '') return fallback;
  const number = toNumber(value);
  if (number == null) throw validation(`Bitte ${label} als Zahl angeben.`);
  if (number < min || number > max) throw validation(`${label} muss zwischen ${min} und ${max} liegen.`);
  return number;
}

function rowToConfig(row = {}) {
  return {
    enabled: Number(row.enabled) === 1,
    mode: MODES.includes(row.mode) ? row.mode : 'relais',
    switchTopic: row.switch_topic || '',
    // Eigene Außentemperatur-Quelle (optional; sonst die systemweite).
    outdoorTopic: row.outdoor_topic || '',
    flowTopic: row.flow_topic || '',
    returnTopic: row.return_topic || '',
    // Rückmeldung des Brenners (Flammensignal, „Brenner an"-Kontakt, Register).
    // Sie bestimmt, welche Zeiten in die Kosten eingehen.
    burnerFeedbackTopic: row.burner_feedback_topic || '',
    // Optionale Umwälzpumpe am zweiten Schaltaktor.
    pumpTopic: row.pump_topic || '',
    pumpLeadSeconds: row.pump_lead_seconds == null ? 30 : Number(row.pump_lead_seconds),
    pumpLagSeconds: row.pump_lag_seconds == null ? 300 : Number(row.pump_lag_seconds),
    // Beobachtungsfenster und Mindest-Absinken für die Trenderkennung der
    // Vorlauftemperatur.
    flowWindowSeconds: row.flow_window_seconds == null ? 120 : Number(row.flow_window_seconds),
    flowDropDelta: row.flow_drop_delta == null ? 0.3 : Number(row.flow_drop_delta),
    // Notabschaltung, falls der Vorlauf nie zu sinken beginnt (0 = keine).
    maxHoldMinutes: row.max_hold_minutes == null ? 0 : Number(row.max_hold_minutes),
    consumptionPerHour: row.consumption_per_hour == null ? 0 : Number(row.consumption_per_hour),
    unit: row.unit == null ? 'l' : row.unit,
    pricePerUnit: row.price_per_unit == null ? 0 : Number(row.price_per_unit),
    sweepEnabled: Number(row.sweep_enabled) === 1,
    sweepStartedAt: row.sweep_started_at == null ? null : Number(row.sweep_started_at),
  };
}

async function loadCentralConfig(db) {
  const row = await dbGet(db, 'SELECT * FROM heizung_central WHERE id = 1');
  return rowToConfig(row || {});
}

// Eingaben der Zentralheizungs-Seite prüfen. Beim Schaltaktor sind Vor- und
// Rücklauf Pflicht — ohne sie ließe sich nicht erkennen, ob der Brenner noch
// hochheizt.
function cleanConfigInput(input = {}, options = {}) {
  const enabled = checkboxValue(input.enabled);
  const mode = MODES.includes(text(input.mode)) ? text(input.mode) : 'relais';
  const config = {
    enabled,
    mode,
    switchTopic: normalizeMqttTopic(input.switchTopic || ''),
    outdoorTopic: normalizeMqttTopic(input.outdoorTopic || ''),
    flowTopic: normalizeMqttTopic(input.flowTopic || ''),
    returnTopic: normalizeMqttTopic(input.returnTopic || ''),
    burnerFeedbackTopic: normalizeMqttTopic(input.burnerFeedbackTopic || ''),
    pumpTopic: normalizeMqttTopic(input.pumpTopic || ''),
    pumpLeadSeconds: Math.round(numberOr(input.pumpLeadSeconds, 30, 0, MAX_PUMP_LEAD_SECONDS,
      'den Vorlauf der Umwälzpumpe')),
    pumpLagSeconds: Math.round(numberOr(input.pumpLagSeconds, 300, 0, MAX_PUMP_LAG_SECONDS,
      'den Nachlauf der Umwälzpumpe')),
    flowWindowSeconds: Math.round(numberOr(input.flowWindowSeconds, 120,
      MIN_FLOW_WINDOW_SECONDS, MAX_FLOW_WINDOW_SECONDS, 'das Beobachtungsfenster der Vorlauftemperatur')),
    flowDropDelta: numberOr(input.flowDropDelta, 0.3, 0.05, 10, 'das Mindest-Absinken der Vorlauftemperatur'),
    maxHoldMinutes: Math.round(numberOr(input.maxHoldMinutes, 0, 0, MAX_HOLD_MINUTES, 'die Notabschaltung')),
    consumptionPerHour: numberOr(input.consumptionPerHour, 0, 0, 100000, 'den Verbrauch je Betriebsstunde'),
    unit: text(input.unit).slice(0, 20) || 'l',
    pricePerUnit: numberOr(input.pricePerUnit, 0, 0, 100000, 'den Preis je Einheit'),
  };
  if (enabled) {
    if (!config.switchTopic) throw validation('Bitte den State zum Schalten der Zentralheizung auswählen.');
    // Ohne irgendeine Außentemperatur könnte kein Raum die Zentralheizung je
    // anfordern — sie entscheidet, ab wann übernommen wird.
    if (!config.outdoorTopic && !options.systemOutdoorTopic) {
      throw validation('Bitte eine Außentemperatur auswählen — entweder hier oder systemweit unter Einstellungen → MQTT.');
    }
    if (mode === 'relais' && (!config.flowTopic || !config.returnTopic)) {
      throw validation('Beim Schaltaktor müssen Vorlauf- und Rücklauftemperatur überwacht werden — bitte beide States auswählen.');
    }
  }
  return config;
}

// Systemweite Außentemperatur (Einstellungen → MQTT). Sie ist die Vorgabe,
// solange die Heizung keine eigene Quelle hinterlegt hat.
function systemOutdoorTopic(db) {
  return new Promise((resolve) => {
    loadMqttConfig(db, (cfg) => resolve((cfg && cfg.outdoorTemperatureTopic) || ''));
  });
}

async function saveCentralConfig(db, input = {}) {
  const config = cleanConfigInput(input, { systemOutdoorTopic: await systemOutdoorTopic(db) });
  await dbRun(db, `INSERT INTO heizung_central
      (id, enabled, mode, switch_topic, outdoor_topic, flow_topic, return_topic,
       burner_feedback_topic, pump_topic,
       pump_lead_seconds, pump_lag_seconds, flow_window_seconds, flow_drop_delta,
       max_hold_minutes, consumption_per_hour, unit, price_per_unit)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode,
       switch_topic = excluded.switch_topic, outdoor_topic = excluded.outdoor_topic,
       flow_topic = excluded.flow_topic, return_topic = excluded.return_topic,
       burner_feedback_topic = excluded.burner_feedback_topic,
       pump_topic = excluded.pump_topic, pump_lead_seconds = excluded.pump_lead_seconds,
       pump_lag_seconds = excluded.pump_lag_seconds,
       flow_window_seconds = excluded.flow_window_seconds, flow_drop_delta = excluded.flow_drop_delta,
       max_hold_minutes = excluded.max_hold_minutes, consumption_per_hour = excluded.consumption_per_hour,
       unit = excluded.unit, price_per_unit = excluded.price_per_unit`, [
    config.enabled ? 1 : 0, config.mode, config.switchTopic, config.outdoorTopic, config.flowTopic, config.returnTopic,
    config.burnerFeedbackTopic, config.pumpTopic, config.pumpLeadSeconds, config.pumpLagSeconds,
    config.flowWindowSeconds, config.flowDropDelta, config.maxHoldMinutes,
    config.consumptionPerHour, config.unit, config.pricePerUnit,
  ]);
  return loadCentralConfig(db);
}

// Schornsteinfeger-Modus: bleibt bewusst persistiert, damit er einen Neustart
// des Servers übersteht und nicht unbemerkt endet.
async function setSweepMode(db, enabled, at = Date.now()) {
  await dbRun(db, `INSERT INTO heizung_central (id, sweep_enabled, sweep_started_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET sweep_enabled = excluded.sweep_enabled, sweep_started_at = excluded.sweep_started_at`,
  [enabled ? 1 : 0, enabled ? at : null]);
}

// Brennerlaufzeiten ─────────────────────────────────────────────────────────

// Beginn einer Laufzeit. `ended_at` wird im Takt fortgeschrieben, damit ein
// Stromausfall höchstens den letzten Takt kostet.
async function startBurnerRun(db, at = Date.now(), reason = '') {
  const result = await dbRun(db,
    'INSERT INTO heizung_burner_runs (started_at, ended_at, duration_ms, reason) VALUES (?, ?, 0, ?)',
    [at, at, String(reason || '').slice(0, 200)]);
  return result.id;
}

async function touchBurnerRun(db, runId, at = Date.now()) {
  if (!runId) return;
  await dbRun(db, 'UPDATE heizung_burner_runs SET ended_at = ?, duration_ms = MAX(0, ? - started_at) WHERE id = ?',
    [at, at, Number(runId)]);
}

async function finishBurnerRun(db, runId, at = Date.now(), reason = null) {
  if (!runId) return;
  if (reason == null) {
    await dbRun(db, 'UPDATE heizung_burner_runs SET ended_at = ?, duration_ms = MAX(0, ? - started_at) WHERE id = ?',
      [at, at, Number(runId)]);
    return;
  }
  await dbRun(db,
    'UPDATE heizung_burner_runs SET ended_at = ?, duration_ms = MAX(0, ? - started_at), reason = ? WHERE id = ?',
    [at, at, String(reason).slice(0, 200), Number(runId)]);
}

// Nach einem Neustart darf keine Laufzeit offen bleiben: sie wird auf dem
// zuletzt fortgeschriebenen Stand geschlossen.
async function closeOpenRuns(db) {
  await dbRun(db, `UPDATE heizung_burner_runs
     SET ended_at = COALESCE(ended_at, started_at), duration_ms = MAX(0, COALESCE(ended_at, started_at) - started_at)
     WHERE ended_at IS NULL OR duration_ms IS NULL`);
}

async function listRuns(db, limit = 50) {
  return dbAll(db, 'SELECT id, started_at, ended_at, duration_ms, reason FROM heizung_burner_runs ORDER BY started_at DESC LIMIT ?',
    [Math.max(1, Math.min(500, Number(limit) || 50))]);
}

// Anteilige Laufzeit ab einem Zeitpunkt: Läufe, die vor dem Zeitraum begannen,
// zählen nur mit ihrem Anteil innerhalb des Zeitraums.
async function runtimeMsSince(db, from, now = Date.now()) {
  const row = await dbGet(db, `SELECT COALESCE(SUM(
        MAX(0, MIN(COALESCE(ended_at, started_at + duration_ms), ?) - MAX(started_at, ?))
      ), 0) AS total
     FROM heizung_burner_runs WHERE COALESCE(ended_at, started_at + duration_ms) >= ?`, [now, from, from]);
  return Number((row && row.total) || 0);
}

function startOfLocalDay(now = Date.now(), offsetDays = 0) {
  const parts = localCalendar(null, undefined, new Date(now));
  const base = Date.UTC(parts.year, parts.month - 1, parts.day) - offsetDays * 86400000;
  const day = new Date(base);
  return timeHandler.wallPartsToEpoch({
    year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(),
    hours: 0, minutes: 0, seconds: 0,
  });
}

function startOfLocalYear(now = Date.now()) {
  const parts = localCalendar(null, undefined, new Date(now));
  return timeHandler.wallPartsToEpoch({ year: parts.year, month: 1, day: 1, hours: 0, minutes: 0, seconds: 0 });
}

// Verbrauch und Kosten einer Laufzeit.
function costOf(config, runtimeMs) {
  const hours = runtimeMs / 3600000;
  const consumption = hours * (Number(config.consumptionPerHour) || 0);
  return {
    hours,
    consumption,
    cost: consumption * (Number(config.pricePerUnit) || 0),
  };
}

// Auswertung für die Oberfläche: heute, 30 Tage, laufendes Jahr, gesamt.
async function burnerStatistics(db, config, now = Date.now()) {
  const [today, month, year, totalRow] = await Promise.all([
    runtimeMsSince(db, startOfLocalDay(now), now),
    runtimeMsSince(db, startOfLocalDay(now, 29), now),
    runtimeMsSince(db, startOfLocalYear(now), now),
    dbGet(db, 'SELECT COALESCE(SUM(duration_ms), 0) AS total, COUNT(*) AS runs FROM heizung_burner_runs'),
  ]);
  const total = Number((totalRow && totalRow.total) || 0);
  return {
    unit: config.unit,
    runs: Number((totalRow && totalRow.runs) || 0),
    today: { runtimeMs: today, ...costOf(config, today) },
    month: { runtimeMs: month, ...costOf(config, month) },
    year: { runtimeMs: year, ...costOf(config, year) },
    total: { runtimeMs: total, ...costOf(config, total) },
  };
}

// States ────────────────────────────────────────────────────────────────────

function stateId(suffix) {
  return `${ID_PREFIX}${suffix}`;
}
function stateTopic(suffix) {
  return topicForId(stateId(suffix));
}

// Beschreibbar ist allein der Schornsteinfeger-Modus.
const CENTRAL_STATES = [
  { suffix: 'kessel', label: 'Kessel', unit: '', writable: false },
  { suffix: 'brenner', label: 'Brenner', unit: '', writable: false },
  { suffix: 'pumpe', label: 'Umwälzpumpe', unit: '', writable: false },
  { suffix: 'anforderungen', label: 'Wärmeanforderungen', unit: '', writable: false },
  { suffix: 'aussentemperatur', label: 'Außentemperatur', unit: '°C', writable: false },
  { suffix: 'vorlauf', label: 'Vorlauftemperatur', unit: '°C', writable: false },
  { suffix: 'ruecklauf', label: 'Rücklauftemperatur', unit: '°C', writable: false },
  { suffix: 'laufzeit_heute', label: 'Laufzeit heute', unit: 'h', writable: false },
  { suffix: 'verbrauch_heute', label: 'Verbrauch heute', unit: '', writable: false },
  { suffix: 'kosten_heute', label: 'Heizkosten heute', unit: '€', writable: false },
  { suffix: 'schornsteinfeger', label: 'Schornsteinfeger-Modus', unit: '', writable: true,
    control: { type: 'switch', on: '1', off: '0' } },
];

function flowCacheKey(kind) {
  return `heizung:zentrale:${kind}`;
}

// Maßgebliche Außentemperatur: die eigene Quelle der Heizung, sonst die
// systemweite aus den MQTT-Einstellungen.
function readOutdoorTemperature(config, cache) {
  if (config && config.outdoorTopic) {
    const entry = cache ? cache.get(flowCacheKey('outdoor')) : null;
    return entry ? toNumber(entry.value) : null;
  }
  const environment = buildEnvironmentSnapshot(cache || new Map());
  return environment.temperature.value == null ? null : Number(environment.temperature.value);
}

function formatNumber(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits).replace('.', ',');
}

// Systemwert-Einträge der Zentralheizung (Ordner „System / Zentralheizung").
// Beschreibbar ist allein der Schornsteinfeger-Modus.
function centralEntries(config, snapshot = {}) {
  if (!config || !config.enabled) return [];
  const values = {
    kessel: snapshot.boilerOn ? 1 : 0,
    brenner: snapshot.burnerOn ? 1 : 0,
    pumpe: snapshot.pumpOn ? 1 : 0,
    anforderungen: Number(snapshot.demandCount || 0),
    aussentemperatur: snapshot.outdoorTemp == null ? null : snapshot.outdoorTemp,
    vorlauf: snapshot.flowTemp == null ? null : snapshot.flowTemp,
    ruecklauf: snapshot.returnTemp == null ? null : snapshot.returnTemp,
    laufzeit_heute: snapshot.todayHours == null ? 0 : snapshot.todayHours,
    verbrauch_heute: snapshot.todayConsumption == null ? 0 : snapshot.todayConsumption,
    kosten_heute: snapshot.todayCost == null ? 0 : snapshot.todayCost,
    schornsteinfeger: config.sweepEnabled ? 1 : 0,
  };
  const pumpConfigured = config.mode === 'relais' && !!config.pumpTopic;
  return CENTRAL_STATES.filter((state) => state.suffix !== 'pumpe' || pumpConfigured).map((state) => {
    const value = values[state.suffix];
    let display;
    if (['kessel', 'brenner', 'pumpe', 'schornsteinfeger'].includes(state.suffix)) display = value ? 'Ein' : 'Aus';
    else if (state.suffix === 'anforderungen') display = String(value);
    else if (state.suffix === 'kosten_heute') display = `${formatNumber(value, 2)} €`;
    else if (state.suffix === 'verbrauch_heute') display = `${formatNumber(value, 2)} ${config.unit}`;
    else if (state.unit) display = value == null ? '—' : `${formatNumber(value, state.unit === 'h' ? 2 : 1)} ${state.unit}`;
    else display = value == null ? '—' : String(value);
    return {
      id: stateId(state.suffix),
      label: `Zentralheizung – ${state.label}`,
      category: CATEGORY,
      unit: state.suffix === 'verbrauch_heute' ? config.unit : state.unit,
      writable: state.writable,
      control: state.control,
      value,
      display,
    };
  });
}

// Woher die Laufzeit für die Kostenrechnung stammt.
const FIRING_SOURCES = {
  feedback: 'Rückmeldung des Brenners',
  flow: 'geschätzt aus der steigenden Vorlauftemperatur',
  switch: 'Einschaltzeit des Kessels (keine Rückmeldung, keine Vorlauftemperatur)',
};

module.exports = {
  FIRING_SOURCES,
  ID_PREFIX, CATEGORY, MODES, SWEEP_TARGET_TEMP, CENTRAL_STATES,
  MIN_FLOW_WINDOW_SECONDS, MAX_FLOW_WINDOW_SECONDS, MAX_HOLD_MINUTES,
  MAX_PUMP_LEAD_SECONDS, MAX_PUMP_LAG_SECONDS,
  loadCentralConfig, saveCentralConfig, cleanConfigInput, setSweepMode, systemOutdoorTopic,
  readOutdoorTemperature,
  startBurnerRun, touchBurnerRun, finishBurnerRun, closeOpenRuns, listRuns,
  runtimeMsSince, burnerStatistics, costOf, startOfLocalDay, startOfLocalYear,
  stateId, stateTopic, flowCacheKey, centralEntries, formatNumber,
};
