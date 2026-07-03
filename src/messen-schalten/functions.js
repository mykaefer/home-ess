'use strict';

// Funktionszuordnung der Messen-+-Schalten-Geräte und -Gruppen (Licht, Waschen,
// Warmwasser, Heizung / Klima, Kochen). Je Funktion wird minütlich die Leistung
// der zugeordneten Geräte zu Stundenenergien integriert. Daraus entstehen die
// Stundenprofile der Prognose: nach Wochentag – für Heizung / Klima nach
// Außentemperatur in 5-°C-Schritten, weil dort die Temperatur den Bedarf
// bestimmt, nicht der Wochentag. Die gemessene Funktionsleistung wird zugleich
// aus dem gelernten Haus-Grundverbrauch herausgerechnet (analog Wallbox/Pool),
// damit sporadische Lasten die Grundlastkurve nicht verfälschen.

const { listActors, FUNCTION_KEYS } = require('./actors');
const { listGroups } = require('./groups');
const { readActorValues } = require('./aggregation');
const { loadMqttConfig, buildEnvironmentSnapshot } = require('../mqtt/config');
const { localCalendar } = require('../local-time');

// Schlüssel kommen aus actors.js (dort werden Eingaben validiert); die Labels
// des Dropdowns/Wertekatalogs sind hier zentral gepflegt.
const FUNCTION_LABELS = {
  licht: 'Licht',
  waschen: 'Waschen',
  warmwasser: 'Warmwasser',
  heizung_klima: 'Heizung / Klima',
  kochen: 'Kochen',
};
const FUNCTIONS = FUNCTION_KEYS.map((key) => ({ key, label: FUNCTION_LABELS[key] || key }));
const TEMPERATURE_BUCKET_SIZE = 5;
// Wochentagsprofile aus demselben Fenster wie die Haus-Stundenprofile;
// Temperatur-Buckets brauchen ganze Saisons, um Sommer und Winter zu sehen.
const WEEKDAY_WINDOW_DAYS = 42;
const RETENTION_DAYS = 400;
const MAX_SAMPLE_AGE_MS = 5 * 60 * 1000;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function isFunctionKey(value) {
  return FUNCTION_KEYS.includes(String(value || ''));
}

function functionLabel(key) {
  const entry = FUNCTIONS.find((fn) => fn.key === key);
  return entry ? entry.label : '';
}

// Effektive Funktion eines Geräts: eigene Zuordnung vor der Gruppenzuordnung.
function effectiveFunction(actor, groupsById) {
  if (actor.functionKey) return actor.functionKey;
  if (actor.groupId != null) {
    const group = groupsById instanceof Map ? groupsById.get(actor.groupId) : (groupsById || {})[actor.groupId];
    if (group && group.functionKey) return group.functionKey;
  }
  return '';
}

function weekdayForDateKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function temperatureBucket(temperature) {
  return Math.floor(temperature / TEMPERATURE_BUCKET_SIZE) * TEMPERATURE_BUCKET_SIZE;
}

// Aktuelle Leistungssumme (W) je Funktion aus den Live-Werten der Geräte.
// Geräte ohne Leistungswert zählen nicht mit (kein Wert ≠ 0 W-Wissen).
function functionPowerSums(actors, groups, values) {
  const groupsById = new Map((groups || []).map((group) => [group.id, group]));
  const valueById = new Map((values || []).map((value) => [value.id, value]));
  const sums = new Map();
  for (const actor of actors || []) {
    const fn = effectiveFunction(actor, groupsById);
    if (!fn) continue;
    const value = valueById.get(actor.id);
    const power = value == null ? null : num(value.powerW);
    if (power == null) continue;
    sums.set(fn, (sums.get(fn) || 0) + Math.max(0, power));
  }
  return sums;
}

// Gesamt-Leistung (W) aller funktionszugeordneten Geräte – wird im Lernmodell
// des Haus-Grundverbrauchs abgezogen (recordConsumptionSample, analog Pool).
async function currentFunctionPowerW(db, cache, now = Date.now()) {
  const actors = await listActors(db);
  if (!actors.some((actor) => actor.functionKey || actor.groupId != null)) return 0;
  const groups = await listGroups(db);
  const values = await readActorValues(db, cache, actors, now);
  const sums = functionPowerSums(actors, groups, values);
  let total = 0;
  for (const power of sums.values()) total += power;
  return total;
}

// Minütliche Fortschreibung: Leistung je Funktion über das Intervall zu
// Stundenenergie integrieren und mit der Außentemperatur der Stunde ablegen.
async function recordFunctionSamples(db, cache, now = Date.now()) {
  const actors = await listActors(db);
  const groups = await listGroups(db);
  const values = await readActorValues(db, cache, actors, now);
  const sums = functionPowerSums(actors, groups, values);
  const state = await dbGet(db, 'SELECT last_sample_ts FROM mess_schalt_function_state WHERE id = 1');
  const lastTs = state == null ? null : Number(state.last_sample_ts);
  await dbRun(
    db,
    `INSERT INTO mess_schalt_function_state (id, last_sample_ts) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_sample_ts = excluded.last_sample_ts`,
    [now]
  );
  if (!sums.size) return;
  const age = lastTs == null ? null : now - lastTs;
  // Nur kurze, plausible Intervalle integrieren – ein Neustart nach Stunden darf
  // keine künstliche Energiemenge erzeugen (gleiche Regel wie im Haus-Lernmodell).
  if (age == null || age <= 0 || age > MAX_SAMPLE_AGE_MS) return;
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date(now));
  const hour = Math.min(23, Math.max(0, Number(calendar.hours) || 0));
  const temperature = num(buildEnvironmentSnapshot(cache).temperature.value);
  for (const [fn, powerW] of sums.entries()) {
    const kwh = powerW * age / 3600000000;
    await dbRun(
      db,
      `INSERT INTO mess_schalt_function_hourly (function_key, day_key, hour, consumption_kwh, temperature)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(function_key, day_key, hour) DO UPDATE SET
         consumption_kwh = mess_schalt_function_hourly.consumption_kwh + excluded.consumption_kwh,
         temperature = CASE
           WHEN excluded.temperature IS NULL THEN mess_schalt_function_hourly.temperature
           WHEN mess_schalt_function_hourly.temperature IS NULL THEN excluded.temperature
           WHEN mess_schalt_function_hourly.consumption_kwh + excluded.consumption_kwh <= 0
             THEN excluded.temperature
           ELSE (
             mess_schalt_function_hourly.temperature * mess_schalt_function_hourly.consumption_kwh +
             excluded.temperature * excluded.consumption_kwh
           ) / (mess_schalt_function_hourly.consumption_kwh + excluded.consumption_kwh)
         END`,
      [fn, calendar.dateKey, hour, kwh, temperature]
    );
  }
  await dbRun(
    db,
    "DELETE FROM mess_schalt_function_hourly WHERE day_key < date(?, ?)",
    [calendar.dateKey, `-${RETENTION_DAYS} days`]
  );
}

// Live-Werte je Funktion für den Wertekatalog: aktuelle Leistung + Verbrauch heute.
// Es erscheinen nur Funktionen, denen mindestens ein Gerät zugeordnet ist.
async function readFunctionValues(db, cache, now = Date.now()) {
  const actors = await listActors(db);
  const groups = await listGroups(db);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const assigned = new Set(actors.map((actor) => effectiveFunction(actor, groupsById)).filter(Boolean));
  if (!assigned.size) return [];
  const values = await readActorValues(db, cache, actors, now);
  const sums = functionPowerSums(actors, groups, values);
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date(now));
  const todayRows = await dbAll(
    db,
    'SELECT function_key, COALESCE(SUM(consumption_kwh), 0) AS kwh FROM mess_schalt_function_hourly WHERE day_key = ? GROUP BY function_key',
    [calendar.dateKey]
  );
  const todayByFunction = new Map(todayRows.map((row) => [row.function_key, num(row.kwh) || 0]));
  return FUNCTIONS
    .filter((fn) => assigned.has(fn.key))
    .map((fn) => ({
      key: fn.key,
      label: fn.label,
      powerW: sums.has(fn.key) ? sums.get(fn.key) : null,
      todayKwh: todayByFunction.get(fn.key) || 0,
    }));
}

// Gelerntes Prognosemodell je Funktion: Stundenmittel nach Wochentag – für
// Heizung / Klima Stundenmittel nach Außentemperatur-Bucket (5-°C-Schritte).
async function loadFunctionModels(db, referenceDayKey = null) {
  const rows = await dbAll(
    db,
    referenceDayKey
      ? `SELECT function_key, day_key, hour, consumption_kwh, temperature
           FROM mess_schalt_function_hourly WHERE day_key < ?`
      : `SELECT function_key, day_key, hour, consumption_kwh, temperature
           FROM mess_schalt_function_hourly`,
    referenceDayKey ? [referenceDayKey] : []
  ).catch(() => []);
  const models = {};
  for (const fn of FUNCTION_KEYS) {
    models[fn] = fn === 'heizung_klima'
      ? { type: 'temperature', buckets: new Map(), sampleDays: new Set() }
      : { type: 'weekday', sums: Array.from({ length: 7 }, () => Array(24).fill(0)), counts: Array.from({ length: 7 }, () => Array(24).fill(0)), sampleDays: new Set() };
  }
  const newestByFunction = new Map();
  for (const row of rows) {
    const newest = newestByFunction.get(row.function_key);
    if (!newest || row.day_key > newest) newestByFunction.set(row.function_key, row.day_key);
  }
  for (const row of rows) {
    const model = models[row.function_key];
    if (!model) continue;
    const hour = Math.min(23, Math.max(0, Number(row.hour) || 0));
    const kwh = Math.max(0, num(row.consumption_kwh) || 0);
    model.sampleDays.add(row.day_key);
    if (model.type === 'temperature') {
      const temperature = num(row.temperature);
      if (temperature == null) continue;
      const bucket = temperatureBucket(temperature);
      let entry = model.buckets.get(bucket);
      if (!entry) {
        entry = { sums: Array(24).fill(0), counts: Array(24).fill(0) };
        model.buckets.set(bucket, entry);
      }
      entry.sums[hour] += kwh;
      entry.counts[hour] += 1;
    } else {
      // Wochentagsprofile bewusst auf das jüngere Fenster begrenzen; ältere
      // Gewohnheiten sollen aktuelle Muster nicht verwässern.
      const newest = newestByFunction.get(row.function_key);
      if (newest && dayKeyDiff(newest, row.day_key) > WEEKDAY_WINDOW_DAYS) continue;
      const weekday = weekdayForDateKey(row.day_key);
      model.sums[weekday][hour] += kwh;
      model.counts[weekday][hour] += 1;
    }
  }
  const result = {};
  for (const fn of FUNCTION_KEYS) {
    const model = models[fn];
    if (model.type === 'temperature') {
      const buckets = new Map();
      for (const [bucket, entry] of model.buckets.entries()) {
        buckets.set(bucket, entry.sums.map((sum, hour) => (entry.counts[hour] > 0 ? sum / entry.counts[hour] : 0)));
      }
      result[fn] = { type: 'temperature', buckets, sampleDays: model.sampleDays.size };
    } else {
      result[fn] = {
        type: 'weekday',
        hourlyByWeekday: model.sums.map((hours, weekday) =>
          hours.map((sum, hour) => (model.counts[weekday][hour] > 0 ? sum / model.counts[weekday][hour] : 0))),
        sampleDays: model.sampleDays.size,
      };
    }
  }
  return result;
}

function forecastTemperatureForHour(forecast, dateKey, hour) {
  if (!forecast || !Array.isArray(forecast.hours)) return null;
  const slot = forecast.hours.find(
    (entry) => entry.dateKey === dateKey && Number(entry.hour) === hour
  );
  return slot ? num(slot.temperature) : null;
}

function nearestBucketHourly(model, temperature) {
  if (!model || !model.buckets || !model.buckets.size) return null;
  if (temperature == null) {
    // Ohne Temperaturprognose das Mittel über alle gelernten Buckets verwenden.
    const totals = Array(24).fill(0);
    for (const hourly of model.buckets.values()) hourly.forEach((value, hour) => { totals[hour] += value; });
    return totals.map((value) => value / model.buckets.size);
  }
  const target = temperatureBucket(temperature);
  let best = null;
  let bestDistance = Infinity;
  for (const [bucket, hourly] of model.buckets.entries()) {
    const distance = Math.abs(bucket - target);
    if (distance < bestDistance) { bestDistance = distance; best = hourly; }
  }
  return best;
}

// Erwartete Funktionslast (kWh) einer Stunde eines Prognosetages: Summe über
// alle Funktionen – Wochentagsprofil bzw. Temperatur-Bucket bei Heizung / Klima.
function functionsLoadForHour(models, forecast, dateKey, hour, durationHours = 1) {
  if (!models) return 0;
  const weekday = weekdayForDateKey(dateKey);
  let total = 0;
  for (const fn of FUNCTION_KEYS) {
    const model = models[fn];
    if (!model) continue;
    if (model.type === 'temperature') {
      const hourly = nearestBucketHourly(model, forecastTemperatureForHour(forecast, dateKey, hour));
      if (hourly) total += hourly[hour] || 0;
    } else if (model.hourlyByWeekday) {
      total += model.hourlyByWeekday[weekday][hour] || 0;
    }
  }
  return total * durationHours;
}

function dayKeyDiff(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

module.exports = {
  FUNCTIONS, FUNCTION_KEYS, TEMPERATURE_BUCKET_SIZE,
  isFunctionKey, functionLabel, effectiveFunction, functionPowerSums,
  currentFunctionPowerW, recordFunctionSamples, readFunctionValues,
  loadFunctionModels, functionsLoadForHour, temperatureBucket,
};
