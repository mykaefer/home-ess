'use strict';

// Wetterdaten-Client (Open-Meteo). Kostenlos, ohne API-Key (nicht-kommerziell).
// Liefert die stündliche Strahlungsprognose (GHI/DNI/DHI) plus Temperatur als
// Eingang für die PV-Prognose (photovoltaik/forecast.js). Ein In-Memory-Cache
// hält das Ergebnis (TTL), damit die API nicht bei jedem Seitenaufruf belastet
// wird. Bei Fehlern bleibt der letzte gültige Cache erhalten.

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY_VARIABLES =
  'shortwave_radiation,direct_normal_irradiance,diffuse_radiation,temperature_2m,cloud_cover';
// 15-Minuten-Auflösung (Strahlung + Temperatur) für die Selbstkalibrierung: das
// gerade abgeschlossene 15-min-Fenster wird gegen den gemessenen 15-min-Schnitt
// verglichen. Open-Meteo liefert minutely_15 nur über einen kürzeren Horizont —
// die mehrtägige Prognose nutzt weiterhin die Stundenwerte (HOURLY_VARIABLES).
const MINUTELY_15_VARIABLES =
  'shortwave_radiation,direct_normal_irradiance,diffuse_radiation,temperature_2m';
// Horizont der PV-Strahlungsprognose. Er deckt denselben Zeitraum ab wie die
// Wetterseite (`wetter/forecast.js`), damit dort für jeden angezeigten Tag ein
// erwarteter PV-Ertrag vorliegt — auch in der Kurzübersicht der weiteren Tage.
const FORECAST_DAYS = 7; // heute + 6 Tage
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 Minuten
const FETCH_TIMEOUT_MS = 10 * 1000;

// Cache je Standort: key `lat,lon` → { fetchedAt, data, pending }
const cache = new Map();

function cacheKey(latitude, longitude) {
  return `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
}

// Open-Meteo-Antwort in eine flache Stundenliste normalisieren. Zeitstempel sind
// (timezone=auto) bereits lokale Standortzeit ohne Zonensuffix ("2026-06-27T13:00").
function normalize(payload) {
  const hourly = payload && payload.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return null;
  const hours = [];
  for (let i = 0; i < hourly.time.length; i += 1) {
    const time = hourly.time[i];
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(time || '');
    if (!match) continue;
    hours.push({
      time,
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      ghi: pickNumber(hourly.shortwave_radiation, i),
      dni: pickNumber(hourly.direct_normal_irradiance, i),
      dhi: pickNumber(hourly.diffuse_radiation, i),
      temp: pickNumber(hourly.temperature_2m, i),
      cloud: pickNumber(hourly.cloud_cover, i),
    });
  }
  if (!hours.length) return null;
  // Open-Meteo gibt die tatsächlich verwendeten Gitter-Koordinaten zurück (nächste
  // Gitterzelle zur angefragten Position) — diese als Ortsbezug weiterreichen.
  return {
    fetchedAt: Date.now(),
    timezone: payload.timezone || null,
    latitude: typeof payload.latitude === 'number' ? payload.latitude : null,
    longitude: typeof payload.longitude === 'number' ? payload.longitude : null,
    hours,
    minutes15: normalizeMinutely15(payload),
  };
}

// 15-Minuten-Strahlung (für die Kalibrierung) in dieselbe flache Form bringen
// wie die Stundenwerte. Fehlt der Block (Endpunkt liefert ihn nicht), leere Liste.
function normalizeMinutely15(payload) {
  const minutely = payload && payload.minutely_15;
  if (!minutely || !Array.isArray(minutely.time)) return [];
  const slots = [];
  for (let i = 0; i < minutely.time.length; i += 1) {
    const time = minutely.time[i];
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(time || '');
    if (!match) continue;
    slots.push({
      time,
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      ghi: pickNumber(minutely.shortwave_radiation, i),
      dni: pickNumber(minutely.direct_normal_irradiance, i),
      dhi: pickNumber(minutely.diffuse_radiation, i),
      temp: pickNumber(minutely.temperature_2m, i),
    });
  }
  return slots;
}

function pickNumber(arr, index) {
  if (!Array.isArray(arr)) return null;
  const value = arr[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Holt die Prognose (ggf. aus dem Cache). Erzwingt mit `force` eine Aktualisierung
// (z. B. periodischer Job). Gibt das normalisierte Objekt oder null zurück.
async function fetchForecast(latitude, longitude, { force = false } = {}) {
  if (latitude == null || longitude == null || latitude === '' || longitude === '') return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const key = cacheKey(lat, lon);
  const entry = cache.get(key);
  const fresh = entry && entry.data && Date.now() - entry.data.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return entry.data;
  // Bereits laufenden Abruf wiederverwenden (kein Doppel-Request).
  if (entry && entry.pending) return entry.pending;

  const previousData = entry && entry.data ? entry.data : null;
  let result = previousData;

  // Das Promise selbst fängt alle Fehler ab. Im finally-Block wird der
  // pending-Eintrag garantiert entfernt, damit ein fehlgeschlagener Abruf den
  // Cache nicht bis zum nächsten Prozessneustart blockiert.
  const pending = (async () => {
    try {
      result = (await requestForecast(lat, lon)) || previousData;
      return result;
    } catch (_) {
      return previousData;
    } finally {
      const current = cache.get(key);
      if (current && current.pending === pending) cache.set(key, { data: result });
    }
  })();

  cache.set(key, { data: previousData, pending });
  return pending;
}

async function requestForecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: HOURLY_VARIABLES,
    minutely_15: MINUTELY_15_VARIABLES,
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPEN_METEO_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return normalize(payload);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Letzten Cache-Stand ohne Netzwerkzugriff lesen (für read-only Auswertung).
function getCachedForecast(latitude, longitude) {
  if (latitude == null || longitude == null || latitude === '' || longitude === '') return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const entry = cache.get(cacheKey(lat, lon));
  return entry && entry.data ? entry.data : null;
}

module.exports = { fetchForecast, getCachedForecast, CACHE_TTL_MS };
