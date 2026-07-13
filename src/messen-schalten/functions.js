'use strict';

// Funktionszuordnung der Messen-+-Schalten-Geräte und -Gruppen (Licht, Waschen,
// Warmwasser, Heizung / Klima, Kochen). Je Funktion wird minütlich die Leistung
// der zugeordneten Geräte zu Stundenenergien integriert. Daraus entstehen die
// Stundenprofile der Prognose: nach Wochentag – für Heizung / Klima nach
// Außentemperatur in 1-°C-Schritten, weil dort die Temperatur den Bedarf
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
const TEMPERATURE_BUCKET_SIZE = 1;
// Feste Temperaturfenster für Heizung / Klima: unterer Sammelbereich „< -20 °C",
// oberer Sammelbereich „> 50 °C", dazwischen 1-°C-Bereiche. Diese Grenzen gelten
// sowohl beim Erfassen (recordFunctionSamples) als auch beim Prognostizieren
// (nearestWindowPower) und im Balkendiagramm der Prognose-Datenbasis.
const TEMPERATURE_BUCKET_MIN = -20; // untere Kante des ersten 1-°C-Bereichs
const TEMPERATURE_BUCKET_MAX = 50;  // untere Kante des Sammelbereichs „> 50 °C"
const TEMPERATURE_BUCKET_BELOW = TEMPERATURE_BUCKET_MIN - TEMPERATURE_BUCKET_SIZE; // Schlüssel „< -20 °C"
// Wochentagsprofile aus demselben Fenster wie die Haus-Stundenprofile.
const WEEKDAY_WINDOW_DAYS = 42;
const RETENTION_DAYS = 400;
// Heizung / Klima: je 1-°C-Fenster bis zu 30 Messtage vorhalten, das Modell ist
// deren gleitendes Mittel. Bewusst begrenzt statt eines dauerhaften Mittelwerts –
// sonst flacht die Anpassung mit der Zeit immer weiter ab und reagiert kaum noch
// auf Veränderungen. Ein Fenster wird nur an Tagen belegt, an denen diese
// Außentemperatur real auftrat, daher kann der Sommer die Winterkurve nicht
// überschreiben (und umgekehrt).
const TEMPERATURE_POWER_DAYS = 30;
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

// Temperatur → Fenster-Schlüssel. Werte unter -20 °C fallen in den unteren
// Sammelbereich, ab 50 °C in den oberen; dazwischen exakte 5-°C-Bereiche.
function temperatureBucket(temperature) {
  const raw = Math.floor(temperature / TEMPERATURE_BUCKET_SIZE) * TEMPERATURE_BUCKET_SIZE;
  if (raw < TEMPERATURE_BUCKET_MIN) return TEMPERATURE_BUCKET_BELOW;
  if (raw >= TEMPERATURE_BUCKET_MAX) return TEMPERATURE_BUCKET_MAX;
  return raw;
}

// Geordnete Liste aller Temperaturfenster (unten „< -20 °C", 5-°C-Bereiche, oben
// „> 50 °C") für das Balkendiagramm und die Modellzusammenfassung.
function temperatureBucketList() {
  const list = [{
    key: TEMPERATURE_BUCKET_BELOW, below: true, min: null, max: TEMPERATURE_BUCKET_MIN,
    label: `< ${TEMPERATURE_BUCKET_MIN} °C`,
  }];
  for (let k = TEMPERATURE_BUCKET_MIN; k < TEMPERATURE_BUCKET_MAX; k += TEMPERATURE_BUCKET_SIZE) {
    list.push({ key: k, below: false, above: false, min: k, max: k + TEMPERATURE_BUCKET_SIZE,
      label: `${k} bis ${k + TEMPERATURE_BUCKET_SIZE} °C` });
  }
  list.push({
    key: TEMPERATURE_BUCKET_MAX, above: true, min: TEMPERATURE_BUCKET_MAX, max: null,
    label: `> ${TEMPERATURE_BUCKET_MAX} °C`,
  });
  return list;
}

// Leistungskurve Heizung / Klima über die Temperaturfenster: je Fenster die
// mittlere Leistung (W) über die (bis zu 30) Messtage, der Wert des aktuellen
// Tages (Markierungslinie) und die Zahl der Messtage. `model` ist das
// Temperatur-Funktionsmodell aus loadFunctionModels; fehlt es, sind alle Fenster
// leer (0).
function summarizeTemperatureDemand(model) {
  const windows = model && model.windows instanceof Map ? model.windows : new Map();
  return temperatureBucketList().map((window) => {
    const entry = windows.get(window.key) || null;
    return {
      ...window,
      avgPowerW: entry ? entry.meanPowerW : 0,
      todayPowerW: entry ? entry.todayPowerW : null,
      days: entry ? entry.days : 0,
      // Für den 24-Stunden-Klick-Dialog: mittlere Leistung (W) je Tagesstunde über
      // die Messtage sowie – als Markierung – der heutige Wert je Stunde.
      hourlyPowerW: entry && Array.isArray(entry.hourlyPowerW) ? entry.hourlyPowerW : Array(24).fill(null),
      hourlyDays: entry && Array.isArray(entry.hourlyDays) ? entry.hourlyDays : Array(24).fill(0),
      todayHourlyPowerW: entry && Array.isArray(entry.todayHourlyPowerW) ? entry.todayHourlyPowerW : Array(24).fill(null),
    };
  });
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

  // Heizung / Klima zusätzlich nach Außentemperatur lernen: je 1-°C-Fenster, Tag
  // UND Tagesstunde die zeitgewichtete mittlere Leistung (W). Die Stunde hält fest,
  // zu welcher Tageszeit bei dieser Temperatur wie viel Energie nötig war (Kühlen
  // v.a. abends, Heizen morgens stärker als abends). Ohne Außentemperatur lässt sich
  // das Fenster nicht bestimmen; eine gemessene 0 W ist eine gültige Beobachtung.
  if (sums.has('heizung_klima') && temperature != null) {
    const bucket = temperatureBucket(temperature);
    const seconds = age / 1000;
    const powerW = Math.max(0, sums.get('heizung_klima'));
    await dbRun(
      db,
      `INSERT INTO mess_schalt_temperature_power (bucket, day_key, hour, avg_power_w, weight_seconds)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket, day_key, hour) DO UPDATE SET
         avg_power_w = (mess_schalt_temperature_power.avg_power_w * mess_schalt_temperature_power.weight_seconds
                        + excluded.avg_power_w * excluded.weight_seconds)
                       / (mess_schalt_temperature_power.weight_seconds + excluded.weight_seconds),
         weight_seconds = mess_schalt_temperature_power.weight_seconds + excluded.weight_seconds`,
      [bucket, calendar.dateKey, hour, powerW, seconds]
    );
    // Je Fenster nur die letzten 30 Messtage behalten (keine lange Historie) –
    // gezählt über verschiedene Tage, unabhängig von der Zahl belegter Stunden.
    await dbRun(
      db,
      `DELETE FROM mess_schalt_temperature_power
        WHERE bucket = ? AND day_key NOT IN (
          SELECT DISTINCT day_key FROM mess_schalt_temperature_power
           WHERE bucket = ? ORDER BY day_key DESC LIMIT ?
        )`,
      [bucket, bucket, TEMPERATURE_POWER_DAYS]
    );
  }
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

// Heizung / Klima: Modell aus der Temperaturfenster-Tabelle. Je 1-°C-Fenster für
// jede der 24 Tagesstunden das Mittel der (bis zu 30) Messtage (`hourlyPowerW`),
// das Gesamtmittel über die belegten Stunden (`meanPowerW`, = Balkenhöhe) sowie –
// für die Markierungslinien – die Werte des aktuellen Tages je Stunde
// (`todayHourlyPowerW`) und deren Mittel (`todayPowerW`). `todayKey` benennt den
// laufenden Tag (aus der Prognose).
async function loadTemperaturePowerModel(db, todayKey = null) {
  const rows = await dbAll(
    db,
    `SELECT bucket, day_key, hour, avg_power_w FROM mess_schalt_temperature_power
       ORDER BY bucket ASC, day_key DESC`
  ).catch(() => []);
  const byBucket = new Map(); // bucket -> { days:Set, hourValues:[24][], today:[24] }
  for (const row of rows) {
    const bucket = Math.round(Number(row.bucket));
    let entry = byBucket.get(bucket);
    if (!entry) {
      entry = {
        days: new Set(),
        hourValues: Array.from({ length: 24 }, () => []),
        today: Array(24).fill(null),
      };
      byBucket.set(bucket, entry);
    }
    // Nur die neuesten 30 Messtage je Fenster berücksichtigen (Zeilen sind nach
    // day_key absteigend sortiert, ein Tag belegt bis zu 24 Stunden-Zeilen).
    if (!entry.days.has(row.day_key)) {
      if (entry.days.size >= TEMPERATURE_POWER_DAYS) continue;
      entry.days.add(row.day_key);
    }
    const hour = Math.min(23, Math.max(0, Number(row.hour) || 0));
    const powerW = Math.max(0, num(row.avg_power_w) || 0);
    entry.hourValues[hour].push(powerW);
    if (todayKey != null && row.day_key === todayKey) entry.today[hour] = powerW;
  }
  const windows = new Map();
  for (const [bucket, entry] of byBucket.entries()) {
    const hourlyPowerW = entry.hourValues.map((values) =>
      (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null));
    const hourlyDays = entry.hourValues.map((values) => values.length);
    const present = hourlyPowerW.filter((value) => value != null);
    const meanPowerW = present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : 0;
    const todayPresent = entry.today.filter((value) => value != null);
    const todayPowerW = todayPresent.length
      ? todayPresent.reduce((sum, value) => sum + value, 0) / todayPresent.length
      : null;
    windows.set(bucket, {
      meanPowerW,
      days: entry.days.size,
      todayPowerW,
      hourlyPowerW,
      hourlyDays,
      todayHourlyPowerW: entry.today,
    });
  }
  return { type: 'temperature', windows };
}

// Gelerntes Prognosemodell je Funktion: Stundenmittel nach Wochentag – für
// Heizung / Klima die mittlere Leistung (W) je Außentemperatur-Fenster (1-°C).
async function loadFunctionModels(db, referenceDayKey = null) {
  const rows = await dbAll(
    db,
    referenceDayKey
      ? `SELECT function_key, day_key, hour, consumption_kwh
           FROM mess_schalt_function_hourly WHERE day_key < ?`
      : `SELECT function_key, day_key, hour, consumption_kwh
           FROM mess_schalt_function_hourly`,
    referenceDayKey ? [referenceDayKey] : []
  ).catch(() => []);
  // Wochentagsmodelle für alle Funktionen außer Heizung / Klima (die kommt aus
  // der Temperaturfenster-Tabelle, nicht aus dem Stunden-Energielog).
  const models = {};
  for (const fn of FUNCTION_KEYS) {
    if (fn === 'heizung_klima') continue;
    models[fn] = { sums: Array.from({ length: 7 }, () => Array(24).fill(0)), counts: Array.from({ length: 7 }, () => Array(24).fill(0)), sampleDays: new Set() };
  }
  const newestByFunction = new Map();
  for (const row of rows) {
    if (row.function_key === 'heizung_klima') continue;
    const newest = newestByFunction.get(row.function_key);
    if (!newest || row.day_key > newest) newestByFunction.set(row.function_key, row.day_key);
  }
  for (const row of rows) {
    const model = models[row.function_key];
    if (!model) continue; // heizung_klima oder unbekannt
    const hour = Math.min(23, Math.max(0, Number(row.hour) || 0));
    const kwh = Math.max(0, num(row.consumption_kwh) || 0);
    // Wochentagsprofile bewusst auf das jüngere Fenster begrenzen; ältere
    // Gewohnheiten sollen aktuelle Muster nicht verwässern.
    const newest = newestByFunction.get(row.function_key);
    if (newest && dayKeyDiff(newest, row.day_key) > WEEKDAY_WINDOW_DAYS) continue;
    model.sampleDays.add(row.day_key);
    const weekday = weekdayForDateKey(row.day_key);
    model.sums[weekday][hour] += kwh;
    model.counts[weekday][hour] += 1;
  }
  const result = {};
  for (const fn of FUNCTION_KEYS) {
    if (fn === 'heizung_klima') continue;
    const model = models[fn];
    result[fn] = {
      type: 'weekday',
      hourlyByWeekday: model.sums.map((hours, weekday) =>
        hours.map((sum, hour) => (model.counts[weekday][hour] > 0 ? sum / model.counts[weekday][hour] : 0))),
      sampleDays: model.sampleDays.size,
    };
  }
  result.heizung_klima = await loadTemperaturePowerModel(db, referenceDayKey);
  return result;
}

function forecastTemperatureForHour(forecast, dateKey, hour) {
  if (!forecast || !Array.isArray(forecast.hours)) return null;
  const slot = forecast.hours.find(
    (entry) => entry.dateKey === dateKey && Number(entry.hour) === hour
  );
  return slot ? num(slot.temperature) : null;
}

// Leistung (W) eines Fensters für eine Tagesstunde: der gelernte Stundenwert,
// falls für diese Stunde Messdaten vorliegen, sonst das Fenstermittel über alle
// Stunden (`hour === null` fragt direkt das Fenstermittel ab).
function hourWindowPower(entry, hour) {
  if (!entry) return null;
  if (hour != null && Array.isArray(entry.hourlyPowerW)) {
    const h = Math.min(23, Math.max(0, Number(hour) || 0));
    if (entry.hourlyPowerW[h] != null) return entry.hourlyPowerW[h];
  }
  return entry.meanPowerW != null ? entry.meanPowerW : null;
}

// Erwartete Heizleistung (W) für eine Außentemperatur und – optional – eine
// Tagesstunde: das nächstgelegene gelernte Temperaturfenster, darin der Stundenwert
// (bzw. das Fenstermittel, falls die Stunde noch nicht gelernt ist). Ohne
// Temperaturprognose das Mittel über alle gelernten Fenster.
function nearestWindowPower(model, temperature, hour = null) {
  if (!model || !model.windows || !model.windows.size) return null;
  if (temperature == null) {
    let sum = 0;
    let count = 0;
    for (const entry of model.windows.values()) {
      const value = hourWindowPower(entry, hour);
      if (value != null) { sum += value; count += 1; }
    }
    return count ? sum / count : null;
  }
  const target = temperatureBucket(temperature);
  let best = null;
  let bestDistance = Infinity;
  for (const [bucket, entry] of model.windows.entries()) {
    const distance = Math.abs(bucket - target);
    if (distance < bestDistance) { bestDistance = distance; best = entry; }
  }
  return hourWindowPower(best, hour);
}

// Erwartete Funktionslast (kWh) einer Stunde eines Prognosetages: Summe über
// alle Funktionen – Wochentagsprofil bzw. bei Heizung / Klima die erwartete
// Leistung des Temperaturfensters, aus der der Verbrauch errechnet wird
// (kWh = W / 1000 × Stunden).
function functionsLoadForHour(models, forecast, dateKey, hour, durationHours = 1) {
  if (!models) return 0;
  const weekday = weekdayForDateKey(dateKey);
  let total = 0;
  for (const fn of FUNCTION_KEYS) {
    const model = models[fn];
    if (!model) continue;
    if (model.type === 'temperature') {
      const powerW = nearestWindowPower(model, forecastTemperatureForHour(forecast, dateKey, hour), hour);
      if (powerW != null) total += powerW / 1000; // erwartete Leistung → kWh dieser Stunde
    } else if (model.hourlyByWeekday) {
      total += model.hourlyByWeekday[weekday][hour] || 0;
    }
  }
  return total * durationHours;
}

// Nur der Heizung-/Klima-Anteil (kWh) einer Prognosestunde nach der prognostizierten
// Stundentemperatur – für den gestapelten Klima-Balken über der Grundlast. Die
// Grundlastberechnung selbst bleibt unberührt (dieser Wert wird nur zusätzlich
// angezeigt, nicht neu verrechnet).
function climateLoadForHour(models, forecast, dateKey, hour, durationHours = 1) {
  const model = models && models.heizung_klima;
  if (!model || model.type !== 'temperature') return 0;
  const powerW = nearestWindowPower(model, forecastTemperatureForHour(forecast, dateKey, hour), hour);
  return powerW != null ? (powerW / 1000) * durationHours : 0;
}

function dayKeyDiff(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

module.exports = {
  FUNCTIONS, FUNCTION_KEYS, TEMPERATURE_BUCKET_SIZE,
  TEMPERATURE_BUCKET_MIN, TEMPERATURE_BUCKET_MAX, TEMPERATURE_BUCKET_BELOW,
  TEMPERATURE_POWER_DAYS,
  isFunctionKey, functionLabel, effectiveFunction, functionPowerSums,
  currentFunctionPowerW, recordFunctionSamples, readFunctionValues,
  loadFunctionModels, functionsLoadForHour, climateLoadForHour, temperatureBucket,
  temperatureBucketList, summarizeTemperatureDemand,
};
