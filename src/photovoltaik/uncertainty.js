'use strict';

// Lernmodell für positive Fehler der Vortagsprognose. Originalprognosen und
// Messungen werden getrennt gespeichert. Überertrag ist Lade-Spielraum, keine
// gesicherte Versorgung. Fehlende Messungen und Abregelung sind keine Nullfehler.
const { createHash } = require('node:crypto');

const MIN_SAMPLES = 12;
const MIN_DAYS = 3;
const RETENTION_DAYS = 90;
const MAX_SAMPLE_GAP_MS = 90000;
const MIN_COVERAGE_MS = 50 * 60000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pv_forecast_learning (
    signature TEXT NOT NULL, date_key TEXT NOT NULL, hour INTEGER NOT NULL,
    issued_at INTEGER NOT NULL, weather_class TEXT NOT NULL,
    expected_kwh REAL NOT NULL, clear_sky_kwh REAL NOT NULL,
    measured_kwh REAL NOT NULL DEFAULT 0, coverage_ms INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (signature, date_key, hour)
  );
  CREATE TABLE IF NOT EXISTS pv_forecast_measurement_state (
    signature TEXT PRIMARY KEY, sampled_at INTEGER NOT NULL, wall_at INTEGER NOT NULL,
    date_key TEXT NOT NULL, hour INTEGER NOT NULL, power_w REAL NOT NULL,
    valid INTEGER NOT NULL
  );`;

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}

function modelSignature(plants, config) {
  const fields = ['id', 'kwPeak', 'efficiency', 'orientation', 'tilt', 'cellType', 'converterType', 'autoCalibrate', 'powerTopic'];
  const plantData = [...plants].sort((a, b) => a.id - b.id).map(p => fields.map(key => p[key] ?? null));
  return createHash('sha256').update(JSON.stringify([
    config.latitude, config.longitude, config.timezone, config.dstEnabled, plantData,
  ])).digest('hex');
}

// Klassen beschreiben die VORHERGESAGTE Wetterlage, nicht die spätere Realität.
// Der Diffusanteil trennt dunkle Wolkendecken von wechselnder Direktstrahlung;
// Wolkenänderungen in benachbarten Stunden kennzeichnen wechselhaftes Wetter.
function weatherClass({ cloudCover, diffuseFraction, cloudChange = 0 }) {
  const cloud = num(cloudCover);
  const diffuse = num(diffuseFraction);
  if (cloud == null || diffuse == null) return 'unknown';
  if (cloud <= 20 && diffuse < 0.5) return 'clear';
  if (cloudChange >= 20 || (cloud > 20 && cloud < 80)) return 'variable';
  return diffuse >= 0.7 ? 'overcast-diffuse' : 'overcast-direct';
}

function wallEpoch(local) {
  const [year, month, day] = local.dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day, local.hours || 0, local.minutes || 0, local.seconds || 0);
}
function partsAt(wall) {
  const date = new Date(wall);
  return { dateKey: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
}

async function saveForecasts(db, forecast, local, now = new Date()) {
  if (!forecast || !forecast.signature || !Array.isArray(forecast.hours)) return;
  const issuedAt = num(forecast.fetchedAt);
  if (issuedAt == null || issuedAt > now.getTime() || now.getTime() - issuedAt > 3600000) return;
  const wallNow = wallEpoch(local);
  const tomorrow = partsAt(wallNow + 24 * 3600000).dateKey;
  for (const slot of forecast.hours) {
    // Strahlung zur Stunde h mittelt [h-1,h). Das Messfenster hat daher den
    // vorherigen Stunden-/Tagesschlüssel, einschließlich Mitternachtsübergang.
    const [year, month, day] = slot.dateKey.split('-').map(Number);
    const start = Date.UTC(year, month - 1, day, slot.hour - 1);
    const target = partsAt(start);
    if (target.dateKey !== tomorrow || start - wallNow < 6 * 3600000) continue;
    if (!(slot.clearSkyKwh > 0.05) || slot.weatherClass === 'unknown' || !slot.weatherClass) continue;
    await run(db, `INSERT INTO pv_forecast_learning
      (signature, date_key, hour, issued_at, weather_class, expected_kwh, clear_sky_kwh)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature, date_key, hour) DO UPDATE SET
        issued_at=excluded.issued_at, weather_class=excluded.weather_class,
        expected_kwh=excluded.expected_kwh, clear_sky_kwh=excluded.clear_sky_kwh
      WHERE pv_forecast_learning.issued_at < excluded.issued_at`,
    [forecast.signature, target.dateKey, target.hour, issuedAt, slot.weatherClass, slot.kwh, slot.clearSkyKwh]);
  }
  const cutoff = partsAt(wallNow - RETENTION_DAYS * 24 * 3600000).dateKey;
  await run(db, 'DELETE FROM pv_forecast_learning WHERE date_key < ?', [cutoff]);
  await run(db, 'DELETE FROM pv_forecast_measurement_state WHERE sampled_at < ?', [now.getTime() - 24 * 3600000]);
}

async function captureForecast(db, cache, now = new Date()) {
  const { listPvPlants } = require('./plants');
  const { computePvForecast } = require('./forecast');
  const { loadMqttConfig } = require('../mqtt/config');
  const { localCalendar } = require('../local-time');
  const config = await new Promise(resolve => loadMqttConfig(db, resolve));
  const plants = await listPvPlants(db);
  const forecast = await computePvForecast(db, plants, { cache });
  await saveForecasts(db, forecast, localCalendar(cache, config.timezone, now, config.dstEnabled), now);
}

function measurement(cache, plants, now) {
  const eligible = plants.filter(p => num(p.orientation) != null && num(p.tilt) != null && num(p.kwPeak) > 0 && num(p.efficiency) > 0);
  const soc = cache.get('batterie.soc');
  let valid = eligible.length > 0 && num(soc && soc.value) != null && num(soc.value) < 95 &&
    Number.isFinite(soc.receivedAt) && now - soc.receivedAt <= 10 * 60000 && now >= soc.receivedAt;
  let power = 0;
  for (const plant of eligible) {
    const entry = cache.get(`pv:${plant.id}:power`);
    const value = num(entry && entry.value);
    if (value == null || value < 0 || value > num(plant.kwPeak) * 2000 || !Number.isFinite(entry.receivedAt) || now - entry.receivedAt > 120000 || now < entry.receivedAt) {
      valid = false;
    } else power += value;
  }
  return { power, valid: !!valid };
}

async function recordMeasurement(db, { signature, local, power, valid, now = new Date() }) {
  const timestamp = now.getTime();
  const wall = wallEpoch(local);
  const [previous] = await all(db, 'SELECT * FROM pv_forecast_measurement_state WHERE signature = ?', [signature]);
  if (previous && timestamp <= previous.sampled_at) return;
  if (previous) {
    const elapsed = timestamp - previous.sampled_at;
    const clockConsistent = Math.abs(wall - previous.wall_at - elapsed) <= 2000;
    if (!clockConsistent) {
      const current = partsAt(wall);
      await run(db, `UPDATE pv_forecast_learning SET blocked = 1 WHERE signature = ?
        AND ((date_key = ? AND hour = ?) OR (date_key = ? AND hour = ?))`,
      [signature, previous.date_key, previous.hour, current.dateKey, current.hour]);
    }
    if (elapsed <= MAX_SAMPLE_GAP_MS && clockConsistent) {
      const usable = valid && previous.valid;
      const meanPower = (power + previous.power_w) / 2;
      let cursor = previous.wall_at;
      // Fenster an der echten Stundengrenze teilen; nie eine ganze Stunde aus
      // einer kurzen Stichprobe hochrechnen. Neustarts mit großen Lücken zählen nicht.
      while (cursor < wall) {
        const end = Math.min(wall, Math.floor(cursor / 3600000) * 3600000 + 3600000);
        const duration = end - cursor;
        const part = partsAt(cursor);
        await run(db, `UPDATE pv_forecast_learning SET
          measured_kwh = measured_kwh + ?, coverage_ms = coverage_ms + ?,
          blocked = MAX(blocked, ?) WHERE signature = ? AND date_key = ? AND hour = ?`,
        [usable ? meanPower * duration / 3600000000 : 0, usable ? duration : 0,
          usable ? 0 : 1, signature, part.dateKey, part.hour]);
        cursor = end;
      }
    }
  }
  const current = partsAt(wall);
  if (!valid) await run(db, 'UPDATE pv_forecast_learning SET blocked = 1 WHERE signature = ? AND date_key = ? AND hour = ?', [signature, current.dateKey, current.hour]);
  await run(db, `INSERT INTO pv_forecast_measurement_state
    (signature, sampled_at, wall_at, date_key, hour, power_w, valid) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signature) DO UPDATE SET sampled_at=excluded.sampled_at,
      wall_at=excluded.wall_at, date_key=excluded.date_key, hour=excluded.hour,
      power_w=excluded.power_w, valid=excluded.valid`,
  [signature, timestamp, wall, current.dateKey, current.hour, power, valid ? 1 : 0]);
}

async function recordObservation(db, cache, plants, now = new Date()) {
  const { loadMqttConfig } = require('../mqtt/config');
  const { localCalendar } = require('../local-time');
  const config = await new Promise(resolve => loadMqttConfig(db, resolve));
  await recordMeasurement(db, {
    signature: modelSignature(plants, config),
    local: localCalendar(cache, config.timezone, now, config.dstEnabled),
    ...measurement(cache, plants, now.getTime()), now,
  });
}

function learnModel(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.blocked || row.coverage_ms < MIN_COVERAGE_MS || row.coverage_ms > 3600000 ||
        !(row.clear_sky_kwh > row.expected_kwh + 0.01) || row.weather_class === 'clear' || row.weather_class === 'unknown') continue;
    // Nur nahezu vollständig gemessene Stunden verwenden. Die maximal zehn
    // fehlenden Minuten werden nicht als Unterertrag der Anlage interpretiert.
    const measured = row.measured_kwh * 3600000 / row.coverage_ms;
    const fraction = clamp((measured - row.expected_kwh) / (row.clear_sky_kwh - row.expected_kwh), 0, 1);
    const group = groups.get(row.weather_class) || { values: [], days: new Set() };
    group.values.push(fraction); // Null-/Untererträge gehören ebenfalls zur Verteilung.
    group.days.add(row.date_key);
    groups.set(row.weather_class, group);
  }
  const result = new Map();
  for (const [key, group] of groups) {
    const samples = group.values.length;
    const days = group.days.size;
    const ready = samples >= MIN_SAMPLES && days >= MIN_DAYS;
    group.values.sort((a, b) => a - b);
    const upper = group.values[Math.ceil(samples * 0.9) - 1] || 0;
    // Kleine Datenmengen sanft gewichten, statt sofort den vollen oberen
    // Erfahrungswert einzuplanen. Keine feste Sonnendauer und kein SoC-Pauschalabzug.
    result.set(key, { fraction: ready ? upper * samples / (samples + 20) : 0, samples, days, ready });
  }
  return result;
}

async function loadModel(db, signature, local) {
  const wall = wallEpoch(local);
  const current = partsAt(wall);
  const cutoff = partsAt(wall - RETENTION_DAYS * 24 * 3600000).dateKey;
  const rows = await all(db, `SELECT * FROM pv_forecast_learning WHERE signature = ?
    AND date_key >= ? AND (date_key < ? OR (date_key = ? AND hour < ?))`,
  [signature, cutoff, current.dateKey, current.dateKey, current.hour]);
  return learnModel(rows);
}

module.exports = {
  SCHEMA, modelSignature, weatherClass, saveForecasts, captureForecast,
  measurement, recordMeasurement, recordObservation, learnModel, loadModel,
  MIN_SAMPLES, MIN_DAYS, MIN_COVERAGE_MS,
};
