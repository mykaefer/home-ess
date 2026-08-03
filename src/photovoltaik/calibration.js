'use strict';

// Selbstkalibrierung des PV-Modells: je Anlage und 15-Minuten-Bucket des Tages
// (0..95) ein langsam nachgeführter Kalibrierfaktor (Default 1.0). Verglichen wird
// das gerade abgeschlossene 15-min-Fenster: der gemessene Leistungs-Durchschnitt
// der vergangenen 15 Minuten gegen die von Open-Meteo gelieferte Strahlung
// desselben Fensters (in erwartete Leistung umgerechnet). Da die Wetter-Strahlung
// die tatsächliche Bewölkung bereits enthält, isoliert das Verhältnis
// gemessen/erwartet anlagenspezifische, tageszeit-abhängige Effekte (z. B.
// Verschattung) — ein Klarhimmel-Gate ist dafür nicht mehr nötig.
//
// Der frisch berechnete Faktor wird zusätzlich als Startwert auf den neuen
// (aktuellen) Bucket übernommen, sofern dieser noch keinen Wert besitzt. Der
// 15-min-Messdurchschnitt wird im Speicher über die 60-Sekunden-Ticks gebildet.
//
// Für die Umrechnung der Wetter-Strahlung in erwartete Leistung werden die
// Geometrie-/Skalierungshelfer aus aggregation.js per lazy require im
// Funktionsrumpf geholt (aggregation.js requirt dieses Modul → Zyklus vermeiden).

const { loadMqttConfig } = require('../mqtt/config');
const wetter = require('../wetter/client');
const { localCalendar } = require('../local-time');

const BUCKET_MINUTES = 15;
const BUCKET_COUNT = (24 * 60) / BUCKET_MINUTES; // 96

// Sanfte Nachführung: kleine Verstärkung → Konvergenz über mehrere Tage, ein
// Ausreißer bewegt den Faktor um höchstens ~α·Bandbreite.
const ALPHA = 0.05;

// Gates für ein verwertbares Kalibrier-Fenster.
const CURTAIL_SOC_MAX = 95; // % Batterie-SoC — darüber droht Abregelung (Curtailment)
// Kein globales CALIB_MIN_FRACTION mehr — die Schwelle kommt je Anlage aus
// sunCutoffMorning / sunCutoffEvening (Standard 10 %).
const CALIB_CUTOFF_PERCENT_DEFAULT = 10;
const RATIO_MIN = 0.4; // Plausibilitätsband für gemessen/erwartet
const RATIO_MAX = 1.5; // war 1.3 — erlaubt nun auch Übererfüllung als Kalibrierimpuls
const FACTOR_MIN = 0.2; // Clamp des Kalibrierfaktors
const FACTOR_MAX = 1.5; // war 1.15 — Kalibrierung funktioniert jetzt in beide Richtungen

// Laufende 15-min-Messfenster je Anlage: plantId → { bucket, sum, count }.
// Wird über die 60-Sekunden-Ticks aufgefüllt und beim Bucket-Wechsel
// (Fensterabschluss) ausgewertet und neu gestartet.
const measureWindows = new Map();

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function loadMqttSettings(db) {
  return new Promise((resolve) => loadMqttConfig(db, resolve));
}

function getCacheValue(cache, key) {
  const entry = cache.get(key);
  return entry ? parseNumber(entry.value) : null;
}

// 15-Minuten-Bucket aus Stunde/Minute (lokale Wanduhrzeit).
function bucketForParts(hours, minutes) {
  const minuteOfDay = (hours % 24) * 60 + (minutes || 0);
  return Math.floor(minuteOfDay / BUCKET_MINUTES) % BUCKET_COUNT;
}

// Lokales Datum + Uhrzeit aus dem MQTT-Umfeld (wie das Idealmodell), Fallback now.
function localDateTime(cache, now = new Date()) {
  const clock = localCalendar(cache, null, now);
  const date = { year: clock.year, month: clock.month, day: clock.day };
  const time = { hours: clock.hours, minutes: clock.minutes };
  return { date, time };
}

function currentBucket(cache, now = new Date()) {
  const { time } = localDateTime(cache, now);
  return bucketForParts(time.hours, time.minutes);
}

// Alle Kalibrierfaktoren laden: Map plantId → Map bucket → { factor, sampleCount }.
async function loadFactors(db) {
  const rows = await dbAll(db, 'SELECT plant_id, bucket, factor, sample_count FROM pv_calibration_buckets');
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.plant_id)) map.set(row.plant_id, new Map());
    map.get(row.plant_id).set(row.bucket, {
      factor: row.factor,
      sampleCount: row.sample_count,
    });
  }
  return map;
}

function getFactor(factorsMap, plantId, bucket) {
  const perPlant = factorsMap && factorsMap.get(plantId);
  const entry = perPlant && perPlant.get(bucket);
  return entry || { factor: 1, sampleCount: 0 };
}

// Wirksamer Faktor für die Anwendung auf den Idealwert. Hat der aktuelle Bucket
// noch keinen eigenen Eintrag (z. B. morgens/abends außerhalb des Kalibrierfensters),
// wird rückwärts im Tageskreis gesucht – so erben nicht kalibrierte Randzeiten vom
// letzten bekannten Bucket statt auf 1,0 zurückzufallen.
function effectiveFactor(factorsMap, plant, bucket) {
  if (!plant || !plant.autoCalibrate) return 1;
  const perPlant = factorsMap && factorsMap.get(plant.id);
  if (!perPlant || perPlant.size === 0) return 1;
  const entry = perPlant.get(bucket);
  if (entry) return entry.factor;
  for (let offset = 1; offset < BUCKET_COUNT; offset++) {
    const prev = perPlant.get((bucket - offset + BUCKET_COUNT) % BUCKET_COUNT);
    if (prev) return prev.factor;
  }
  return 1;
}

function upsertBucket(db, plantId, bucket, factor, sampleCount, ts) {
  return dbRun(
    db,
    `INSERT INTO pv_calibration_buckets (plant_id, bucket, factor, sample_count, updated_at, window_minutes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(plant_id, bucket) DO UPDATE SET
       factor = excluded.factor,
       sample_count = excluded.sample_count,
       updated_at = excluded.updated_at,
       window_minutes = excluded.window_minutes`,
    [plantId, bucket, factor, sampleCount, ts, BUCKET_MINUTES]
  );
}

// Erwartete Leistung (W) einer Anlage für ein 15-min-Fenster aus der von
// Open-Meteo gelieferten Strahlung — über dieselbe Geometrie/Skalierung wie der
// Live-Idealwert und die Prognose.
function expectedPowerFromWeather(config, weather, plant, date, time) {
  if (!weather || !Array.isArray(weather.minutes15) || !weather.minutes15.length) return null;
  const azimuth = parseNumber(plant.orientation);
  const tilt = parseNumber(plant.tilt);
  if (azimuth == null || tilt == null) return null;

  const entry = weather.minutes15.find(
    (slot) =>
      slot.year === date.year &&
      slot.month === date.month &&
      slot.day === date.day &&
      slot.hour === time.hours &&
      slot.minute === time.minutes
  );
  if (!entry || entry.ghi == null) return null;

  // Lazy require: aggregation.js requirt dieses Modul (Zyklus) — zum Aufrufzeit-
  // punkt ist es vollständig geladen.
  const { solarGeometryAt, transposePlaneIrradiance, idealPowerFromIrradiance } = require('./aggregation');
  const geometry = solarGeometryAt(config, date, { hours: time.hours, minutes: time.minutes, seconds: 0 });
  const planeIrradiance = transposePlaneIrradiance({
    dayOfYear: geometry.dayOfYear,
    decimalHours: geometry.decimalHours,
    latitude: geometry.latitude,
    azimuth,
    tilt,
    dni: entry.dni,
    dhi: entry.dhi,
    ghi: entry.ghi,
  });
  return idealPowerFromIrradiance(plant, planeIrradiance, entry.temp);
}

// Ein abgeschlossenes 15-min-Fenster auswerten: gemessenen Durchschnitt gegen die
// erwartete (Wetter-)Leistung kalibrieren und den Bucket sanft nachziehen.
async function finalizeWindow(db, cache, config, weather, plant, completedBucket, avgMeasured, ts) {
  if (avgMeasured == null || avgMeasured <= 0) return;
  const kwPeak = parseNumber(plant.kwPeak);
  if (kwPeak == null) return;

  // Open-Meteo labelt den Strahlungswert am Fensterende und mittelt das
  // vorangehende Intervall → der Wert am Ende des abgeschlossenen Buckets deckt
  // genau dieses Fenster ab.
  const endMinute = (completedBucket + 1) * BUCKET_MINUTES;
  if (endMinute >= 24 * 60) return; // Mitternachts-Übergang — ohnehin keine Sonne
  const matchTime = { hours: Math.floor(endMinute / 60), minutes: endMinute % 60 };
  const { date } = localDateTime(cache, new Date(ts));

  const expected = expectedPowerFromWeather(config, weather, plant, date, matchTime);
  if (expected == null || expected <= 0) return;
  // Anlagen-spezifischer Sonnenstand-Gate: Kalibrierung nur wenn die erwartete
  // Leistung den morgens/abends konfigurierten Cutoff (Prozent der Peakleistung)
  // überschreitet. Damit wird eine Anlage nur dann kalibriert, wenn die Sonne in
  // einem sinnvollen Winkel zu ihrer Modulebene steht.
  const endDecimalHours = matchTime.hours + matchTime.minutes / 60;
  const calibCutoff = endDecimalHours < 12
    ? (plant.sunCutoffMorning ?? CALIB_CUTOFF_PERCENT_DEFAULT)
    : (plant.sunCutoffEvening ?? CALIB_CUTOFF_PERCENT_DEFAULT);
  if (expected < (calibCutoff / 100) * kwPeak * 1000) return;

  // Abregelungs-Gate: voller Akku → gemessen kann gedrosselt sein.
  const soc = getCacheValue(cache, 'batterie.soc');
  if (soc != null && soc >= CURTAIL_SOC_MAX) return;

  const ratio = avgMeasured / expected;
  if (!Number.isFinite(ratio) || ratio < RATIO_MIN || ratio > RATIO_MAX) return;

  // Startwert des abgeschlossenen Buckets: vorhandener Wert, sonst den des
  // vorangehenden Buckets übernehmen (statt bei 1.0 zu beginnen).
  const row = await dbGet(
    db,
    'SELECT factor, sample_count FROM pv_calibration_buckets WHERE plant_id = ? AND bucket = ?',
    [plant.id, completedBucket]
  );
  let prevFactor = 1;
  let prevCount = 0;
  if (row) {
    prevFactor = row.factor;
    prevCount = row.sample_count;
  } else {
    const prevBucket = (completedBucket - 1 + BUCKET_COUNT) % BUCKET_COUNT;
    const neighbor = await dbGet(
      db,
      'SELECT factor FROM pv_calibration_buckets WHERE plant_id = ? AND bucket = ?',
      [plant.id, prevBucket]
    );
    if (neighbor) prevFactor = neighbor.factor;
  }

  const target = clamp(ratio, FACTOR_MIN, FACTOR_MAX);
  const next = clamp(prevFactor + ALPHA * (target - prevFactor), FACTOR_MIN, FACTOR_MAX);
  await upsertBucket(db, plant.id, completedBucket, next, prevCount + 1, ts);

  // Den frisch berechneten Faktor als Startwert auf den neuen (aktuellen) Bucket
  // übernehmen — aber nur, wenn dort noch kein (z. B. vorjähriger) Wert liegt.
  const newBucket = (completedBucket + 1) % BUCKET_COUNT;
  const exists = await dbGet(
    db,
    'SELECT 1 AS x FROM pv_calibration_buckets WHERE plant_id = ? AND bucket = ?',
    [plant.id, newBucket]
  );
  if (!exists) await upsertBucket(db, plant.id, newBucket, next, 0, ts);
}

// Ein Kalibrier-Tick (alle 60 s): den aktuellen Messwert je Anlage in das laufende
// 15-min-Fenster aufnehmen und bei Fensterwechsel das abgeschlossene Fenster
// auswerten. `plants` sind die vollständigen Anlagen (Geometrie/Leistung).
async function recordCalibration(db, cache, plants, now = new Date()) {
  if (!Array.isArray(plants) || !plants.length) return;
  const active = plants.filter((p) => p.autoCalibrate);
  if (!active.length) {
    measureWindows.clear();
    return;
  }

  const { time } = localDateTime(cache, now);
  const bucket = bucketForParts(time.hours, time.minutes);
  const ts = now.getTime();

  // Konfiguration/Wetter erst laden, wenn tatsächlich ein Fenster abgeschlossen
  // wird (spart Arbeit in den Ticks innerhalb desselben Fensters).
  let config = null;
  let weather = null;
  let weatherLoaded = false;
  const ensureWeather = async () => {
    if (weatherLoaded) return;
    weatherLoaded = true;
    config = await loadMqttSettings(db);
    const lat = parseNumber(config.latitude);
    const lon = parseNumber(config.longitude);
    weather = lat != null && lon != null ? wetter.getCachedForecast(lat, lon) : null;
  };

  for (const plant of active) {
    const current = getCacheValue(cache, `pv:${plant.id}:power`);
    const acc = measureWindows.get(plant.id);

    if (acc && acc.bucket !== bucket) {
      // Fenster abgeschlossen → auswerten, dann neues Fenster starten.
      if (acc.count > 0) {
        await ensureWeather();
        try {
          await finalizeWindow(db, cache, config, weather, plant, acc.bucket, acc.sum / acc.count, ts);
        } catch (_) {
          // Kalibrierung darf den Tick nie sprengen.
        }
      }
      measureWindows.set(plant.id, {
        bucket,
        sum: current != null ? current : 0,
        count: current != null ? 1 : 0,
      });
    } else {
      const entry = acc || { bucket, sum: 0, count: 0 };
      entry.bucket = bucket;
      if (current != null) {
        entry.sum += current;
        entry.count += 1;
      }
      measureWindows.set(plant.id, entry);
    }
  }
}

async function clearCalibration(db, plantId) {
  await dbRun(db, 'DELETE FROM pv_calibration_buckets WHERE plant_id = ?', [plantId]);
}

module.exports = {
  BUCKET_COUNT,
  bucketForParts,
  currentBucket,
  localDateTime,
  loadFactors,
  getFactor,
  effectiveFactor,
  recordCalibration,
  clearCalibration,
};
