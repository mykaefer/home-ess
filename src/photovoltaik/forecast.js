'use strict';

// PV-Prognose: rechnet die stündliche Wetter-Strahlungsprognose (Open-Meteo) je
// Anlage in erwartete Tageserträge (kWh) um. Verwendet bewusst dieselbe Geometrie
// und Skalierung wie der Live-Idealwert (aggregation.js) — nur mit prognostizierter
// statt modellierter Clear-Sky-Strahlung. Read-only: schreibt nicht in die DB.

const { loadMqttConfig } = require('../mqtt/config');
const wetter = require('../wetter/client');
const {
  solarGeometryAt,
  transposePlaneIrradiance,
  idealPowerFromIrradiance,
  formatEnergy,
} = require('./aggregation');
const { bucketForParts, effectiveFactor, loadFactors, localDateTime } = require('./calibration');
const metrics = require('../runtime-metrics');

const FORECAST_CACHE_MS = 30000;
let forecastCache = null;
let forecastInFlight = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Lokales „Jetzt" (Datum + Uhrzeit) bevorzugt aus dem MQTT-Umfeld (wie das
// Idealmodell), Fallback Serverzeit. Dient der Aufteilung des heutigen Ertrags
// in „bereits erwartet" und „noch erwartet".
function localNowParts(cache) {
  const now = new Date();
  if (cache && typeof cache.get === 'function') return localDateTime(cache, now);
  return {
    date: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    time: { hours: now.getHours(), minutes: now.getMinutes() },
  };
}

function dateKeyFromParts(date) {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadMqttSettings(db) {
  return new Promise((resolve) => loadMqttConfig(db, resolve));
}

function dayKey(hour) {
  return `${hour.year}-${String(hour.month).padStart(2, '0')}-${String(hour.day).padStart(2, '0')}`;
}

// Nur Anlagen mit vollständigen Geometrie-/Leistungsdaten sind prognostizierbar.
function eligiblePlants(plants) {
  return plants
    .map((plant) => ({
      plant,
      azimuth: parseNumber(plant.orientation),
      tilt: parseNumber(plant.tilt),
    }))
    .filter((entry) => entry.azimuth != null && entry.tilt != null);
}

// Wandelt die normalisierte Wetterprognose + Anlagen in Tageserträge um.
// Rückgabe: { days: [{ dateKey, label, totalKwh, totalFormatted, perPlant }] } oder null.
function buildForecast(weather, plants, config, factorsMap = null, nowLocal = null) {
  if (!weather || !Array.isArray(weather.hours) || !weather.hours.length) return null;
  const eligible = eligiblePlants(plants);
  if (!eligible.length) return null;

  // Aufteilung des heutigen Ertrags in „bereits" / „noch": lokaler Tagesschlüssel
  // und Dezimalstunde des aktuellen Moments. Open-Meteo-Strahlung ist das Mittel
  // der vorangehenden Stunde → der Wert zur Stunde h deckt das Intervall [h-1, h).
  const todayKey = nowLocal ? dateKeyFromParts(nowLocal.date) : null;
  const nowDecimal = nowLocal ? nowLocal.time.hours + (nowLocal.time.minutes || 0) / 60 : null;

  // Stunde, die den aktuellen Moment enthält: Open-Meteo-Eintrag h deckt [h-1, h).
  // Bei nowDecimal = 13,75 ist die relevante Stunde h = 14.
  const currentHourIndex = nowDecimal != null ? Math.floor(nowDecimal) + 1 : null;

  // Wh je Tag (Schlüssel = lokales Datum) und je Anlage aufsummieren.
  const dayOrder = [];
  const dayTotals = new Map(); // dateKey -> { total, elapsed, perPlant: Map }
  const hourlyTotals = new Map(); // `${dateKey}:${hour}` -> { wh, temp }
  let currentPowerWatt = null; // erwartete Gesamtleistung im aktuellen Stunden-Slot

  for (const hour of weather.hours) {
    const key = dayKey(hour);
    if (!dayTotals.has(key)) {
      dayOrder.push(key);
      dayTotals.set(key, { total: 0, elapsed: 0, perPlant: new Map() });
    }
    const bucket = dayTotals.get(key);

    // Anteil dieser Stunde, der zum aktuellen Moment bereits verstrichen ist
    // (nur für heute relevant; laufende Stunde anteilig).
    const elapsedFraction =
      todayKey != null && key === todayKey ? clamp(nowDecimal - hour.hour + 1, 0, 1) : 0;

    // Aktuelle Stunde erkennen (Datum + Stunden-Index).
    const isCurrentHour =
      todayKey != null &&
      key === todayKey &&
      currentHourIndex != null &&
      hour.hour === currentHourIndex;
    let currentHourTotal = 0;
    let hourTotal = 0;

    const geometry = solarGeometryAt(
      config,
      { year: hour.year, month: hour.month, day: hour.day },
      { hours: hour.hour, minutes: hour.minute, seconds: 0 }
    );

    for (const { plant, azimuth, tilt } of eligible) {
      const planeIrradiance = transposePlaneIrradiance({
        dayOfYear: geometry.dayOfYear,
        decimalHours: geometry.decimalHours,
        latitude: geometry.latitude,
        azimuth,
        tilt,
        dni: hour.dni,
        dhi: hour.dhi,
        ghi: hour.ghi,
      });
      const wattBase = idealPowerFromIrradiance(plant, planeIrradiance, hour.temp);
      if (wattBase == null || wattBase <= 0) continue;
      // Gelernten Kalibrierfaktor des passenden Tageszeit-Buckets anwenden
      // (z. B. Verschattung) — wirkt nur bei aktivierter Auto-Kalibrierung + genug Samples.
      const factor = effectiveFactor(factorsMap, plant, bucketForParts(hour.hour, hour.minute));
      const watt = wattBase * factor;
      // Stündliche Strahlung ist ein Stundenmittel → Leistung (W) × 1 h = Wh.
      bucket.total += watt;
      if (elapsedFraction > 0) bucket.elapsed += watt * elapsedFraction;
      bucket.perPlant.set(plant.id, (bucket.perPlant.get(plant.id) || 0) + watt);
      hourTotal += watt;
      if (isCurrentHour) currentHourTotal += watt;
    }

    const hourKey = `${key}:${hour.hour}`;
    const previousHour = hourlyTotals.get(hourKey) || { wh: 0, temperature: null };
    hourlyTotals.set(hourKey, {
      wh: previousHour.wh + hourTotal,
      temperature: hour.temp == null ? previousHour.temperature : hour.temp,
    });

    if (isCurrentHour) currentPowerWatt = currentHourTotal;
  }

  // Heutigen Tag in „bereits erwartet" und „noch erwartet" aufteilen.
  let todayElapsedKwh = null;
  let todayRemainingKwh = null;
  if (todayKey != null && dayTotals.has(todayKey)) {
    const todayBucket = dayTotals.get(todayKey);
    todayElapsedKwh = todayBucket.elapsed / 1000;
    todayRemainingKwh = Math.max(0, todayBucket.total / 1000 - todayElapsedKwh);
  }

  const days = dayOrder.map((key, index) => {
    const bucket = dayTotals.get(key);
    const totalKwh = bucket.total / 1000;
    const perPlant = {};
    for (const [plantId, wh] of bucket.perPlant.entries()) perPlant[plantId] = wh / 1000;
    return {
      dateKey: key,
      label: dayLabel(index, key),
      totalKwh,
      totalFormatted: formatEnergy(totalKwh),
      perPlant,
    };
  });

  return {
    fetchedAt: weather.fetchedAt,
    days,
    // Standort für geometrische Clear-Sky-Berechnungen (z. B. Pool-Solarpumpen-
    // Laufzeit je Prognosestunde). Kommt aus der von Open-Meteo gemeldeten Zelle.
    latitude: weather.latitude,
    longitude: weather.longitude,
    locationLabel: formatLocation(weather),
    todayElapsedKwh,
    todayRemainingKwh,
    todayElapsedFormatted: todayElapsedKwh == null ? null : formatEnergy(todayElapsedKwh),
    todayRemainingFormatted: todayRemainingKwh == null ? null : formatEnergy(todayRemainingKwh),
    currentPowerWatt,
    // Interne Prognose nutzt die Stundenenergie zur realistischeren Batterie-
    // simulation. Das bestehende öffentliche PV-JSON bleibt davon unberührt.
    hours: Array.from(hourlyTotals.entries()).map(([key, values]) => {
      const splitAt = key.lastIndexOf(':');
      return {
        dateKey: key.slice(0, splitAt),
        hour: Number(key.slice(splitAt + 1)),
        kwh: values.wh / 1000,
        temperature: values.temperature,
      };
    }),
  };
}

// Ortsbezug der Wetterdaten als Koordinaten-Label (die von Open-Meteo
// tatsächlich verwendete Gitterzelle), z. B. „48,14° N, 11,57° O".
function formatLocation(weather) {
  if (!weather || weather.latitude == null || weather.longitude == null) return null;
  return `${formatCoordinate(weather.latitude, 'N', 'S')}, ${formatCoordinate(weather.longitude, 'O', 'W')}`;
}

function formatCoordinate(value, positive, negative) {
  const abs = Math.abs(value).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${abs}° ${value >= 0 ? positive : negative}`;
}

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });

function dayLabel(index, dateKey) {
  if (index === 0) return 'Heute';
  if (index === 1) return 'Morgen';
  const [year, month, day] = dateKey.split('-').map(Number);
  return WEEKDAY_FORMAT.format(new Date(year, month - 1, day));
}

// Lädt Konfiguration + Wetter und baut die Prognose. `allowFetch` erlaubt einen
// (gecachten) Netzwerkabruf; sonst wird nur der vorhandene Cache gelesen, damit
// der Seitenaufbau nicht blockiert.
async function computePvForecast(db, plants, { allowFetch = false, cache = null } = {}) {
  const signature = (plants || []).map((plant) => [
    plant.id, plant.kwPeak, plant.orientation, plant.tilt, plant.efficiency,
    plant.cellType, plant.converterType, plant.autoCalibrate,
  ].join(':')).join('|');
  if (!allowFetch && forecastCache && forecastCache.db === db &&
      forecastCache.signature === signature && Date.now() - forecastCache.at < FORECAST_CACHE_MS) {
    metrics.counter('pvForecast.cacheHit');
    return forecastCache.value;
  }
  if (!allowFetch && forecastInFlight && forecastInFlight.db === db && forecastInFlight.signature === signature) {
    metrics.counter('pvForecast.shared');
    return forecastInFlight.promise;
  }
  const promise = metrics.measure('pvForecast.compute', async () => {
  const config = await loadMqttSettings(db);
  const latitude = parseNumber(config.latitude);
  const longitude = parseNumber(config.longitude);
  if (latitude == null || longitude == null) return null;

  const weather = allowFetch
    ? await wetter.fetchForecast(latitude, longitude)
    : wetter.getCachedForecast(latitude, longitude);

  const factorsMap = await loadFactors(db);
    return buildForecast(weather, plants, config, factorsMap, localNowParts(cache));
  });
  if (!allowFetch) forecastInFlight = { db, signature, promise };
  try {
    const value = await promise;
    if (!allowFetch) forecastCache = { db, signature, at: Date.now(), value };
    return value;
  } finally {
    if (!allowFetch && forecastInFlight && forecastInFlight.promise === promise) forecastInFlight = null;
  }
}

function invalidateForecastCache() { forecastCache = null; }

// Wetter-Cache aktiv aktualisieren (periodischer Job / Startup-Prime).
async function refreshWeather(db) {
  const config = await loadMqttSettings(db);
  const latitude = parseNumber(config.latitude);
  const longitude = parseNumber(config.longitude);
  if (latitude == null || longitude == null) return;
  await wetter.fetchForecast(latitude, longitude, { force: true });
  invalidateForecastCache();
}

module.exports = { computePvForecast, refreshWeather, invalidateForecastCache, buildForecast };
