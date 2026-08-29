'use strict';

// Vollständige Wetterprognose (Open-Meteo) für die Seite „Wetterprognose" und
// die System-States der Gruppe „Wetter".
//
// Abgrenzung zu `client.js`: jener Client holt ausschließlich die Strahlungs-
// werte für die PV-Prognose und darf dafür nicht mit zusätzlichen Variablen
// belastet werden. Dieses Modul stellt eine zweite, eigenständige Abfrage mit
// den allgemeinen Wettergrößen (Zustand, Temperatur, Niederschlag, Wind, UV,
// Sonnenzeiten) und hält sie in einem eigenen Cache (TTL) vor. Bei Fehlern
// bleibt der letzte gültige Stand erhalten — die Seite zeigt dann den älteren
// Stand statt einer Lücke.

const { loadMqttConfig } = require('../mqtt/config');
const timeHandler = require('../time-handler');
const { describeWeather, windDirectionText } = require('./codes');

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

const CURRENT_VARIABLES = [
  'weather_code', 'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'is_day', 'precipitation', 'rain', 'showers', 'snowfall', 'cloud_cover',
  'pressure_msl', 'surface_pressure', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
].join(',');

const HOURLY_VARIABLES = [
  'weather_code', 'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'dew_point_2m', 'precipitation', 'precipitation_probability', 'rain', 'showers',
  'snowfall', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m',
  'wind_gusts_10m', 'uv_index', 'visibility', 'is_day',
  // Globalstrahlung: die Sonnenintensität der Prognose. Sie ist die physikalische
  // Größe hinter dem PV-Ertrag und wird im Verlaufsdiagramm als Linie gezeigt.
  // Nicht zu verwechseln mit `sun.intensity.*`: jene States messen die reale
  // PV-Leistung gegen den Klarhimmel-Idealwert und gelten nur für den Istzustand.
  'shortwave_radiation', 'direct_radiation',
].join(',');

const DAILY_VARIABLES = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'apparent_temperature_max', 'apparent_temperature_min', 'sunrise', 'sunset',
  'daylight_duration', 'sunshine_duration', 'uv_index_max', 'precipitation_sum',
  'rain_sum', 'showers_sum', 'snowfall_sum', 'precipitation_hours',
  'precipitation_probability_max', 'wind_speed_10m_max', 'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
].join(',');

// Drei ausführliche Tage plus vier Kurztage — mehr liefert das freie Modell
// nicht in brauchbarer Güte.
const FORECAST_DAYS = 7;
// Zahl der ausführlich dargestellten Tage (heute, morgen, übermorgen).
const DETAIL_DAYS = 3;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 Minuten
const FETCH_TIMEOUT_MS = 10 * 1000;

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAY_NAMES = ['Heute', 'Morgen', 'Übermorgen'];

// Cache je Standort: key `lat,lon` → { data, pending }
const cache = new Map();

function cacheKey(latitude, longitude) {
  return `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
}

function num(arr, index) {
  if (!Array.isArray(arr)) return null;
  const value = arr[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(arr, index) {
  if (!Array.isArray(arr)) return null;
  const value = arr[index];
  return typeof value === 'string' && value ? value : null;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Lokale Zeitstempel von Open-Meteo ("2026-08-26T13:00") ohne Zonensuffix in
// ihre Bestandteile zerlegen. Rückgabe null, wenn das Format nicht passt.
function splitLocalTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!match) return null;
  return {
    dateKey: `${match[1]}-${match[2]}-${match[3]}`,
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: match[4] == null ? null : Number(match[4]),
    minute: match[5] == null ? null : Number(match[5]),
  };
}

// Wochentag aus dem Datum. Über Date.UTC gerechnet, damit die Zeitzone des
// Servers das Ergebnis nicht verschiebt.
function weekdayName(parts) {
  if (!parts) return '';
  return WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
}

function formatDate(parts) {
  if (!parts) return '';
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;
}

function formatClock(parts) {
  if (!parts || parts.hour == null) return '';
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute || 0).padStart(2, '0')}`;
}

function average(values) {
  const usable = values.filter((value) => value != null);
  if (!usable.length) return null;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function maximum(values) {
  const usable = values.filter((value) => value != null);
  return usable.length ? Math.max(...usable) : null;
}

function sum(values) {
  const usable = values.filter((value) => value != null);
  return usable.length ? usable.reduce((total, value) => total + value, 0) : null;
}

// Stundenwerte in eine flache Liste bringen; die Tageszuordnung erfolgt später
// über `dateKey`.
function normalizeHours(payload) {
  const hourly = payload && payload.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const hours = [];
  for (let i = 0; i < hourly.time.length; i += 1) {
    const parts = splitLocalTime(hourly.time[i]);
    if (!parts) continue;
    const isDay = num(hourly.is_day, i) !== 0;
    const code = num(hourly.weather_code, i);
    const direction = num(hourly.wind_direction_10m, i);
    hours.push({
      time: hourly.time[i],
      dateKey: parts.dateKey,
      hour: parts.hour,
      clock: formatClock(parts),
      isDay,
      ...describeWeather(code, isDay),
      temperature: num(hourly.temperature_2m, i),
      apparentTemperature: num(hourly.apparent_temperature, i),
      humidity: num(hourly.relative_humidity_2m, i),
      dewPoint: num(hourly.dew_point_2m, i),
      precipitation: num(hourly.precipitation, i),
      precipitationProbability: num(hourly.precipitation_probability, i),
      rain: num(hourly.rain, i),
      showers: num(hourly.showers, i),
      snowfall: num(hourly.snowfall, i),
      cloudCover: num(hourly.cloud_cover, i),
      pressure: num(hourly.pressure_msl, i),
      windSpeed: num(hourly.wind_speed_10m, i),
      windGusts: num(hourly.wind_gusts_10m, i),
      windDirection: direction,
      windDirectionText: windDirectionText(direction),
      uvIndex: num(hourly.uv_index, i),
      // Open-Meteo liefert die Sichtweite in Metern; die Seite rechnet in km.
      visibility: num(hourly.visibility, i),
      radiation: num(hourly.shortwave_radiation, i),
      directRadiation: num(hourly.direct_radiation, i),
    });
  }
  return hours;
}

// Sekundenangaben (daylight_duration / sunshine_duration) in Stunden.
function secondsToHours(value) {
  return value == null ? null : value / 3600;
}

function normalizeDays(payload, hours) {
  const daily = payload && payload.daily;
  if (!daily || !Array.isArray(daily.time)) return [];
  const hoursByDate = new Map();
  for (const hour of hours) {
    if (!hoursByDate.has(hour.dateKey)) hoursByDate.set(hour.dateKey, []);
    hoursByDate.get(hour.dateKey).push(hour);
  }

  const days = [];
  for (let i = 0; i < daily.time.length; i += 1) {
    const parts = splitLocalTime(daily.time[i]);
    if (!parts) continue;
    const dayHours = hoursByDate.get(parts.dateKey) || [];
    const code = num(daily.weather_code, i);
    const direction = num(daily.wind_direction_10m_dominant, i);
    const sunrise = splitLocalTime(text(daily.sunrise, i));
    const sunset = splitLocalTime(text(daily.sunset, i));
    days.push({
      index: i,
      dateKey: parts.dateKey,
      date: formatDate(parts),
      weekday: weekdayName(parts),
      // „Heute"/„Morgen"/„Übermorgen" für die ersten drei Tage, danach der
      // Wochentag als Name.
      name: i < DAY_NAMES.length ? DAY_NAMES[i] : weekdayName(parts),
      detailed: i < DETAIL_DAYS,
      // Die Tageslage bekommt immer das Tagsymbol — eine Tageskachel soll auch
      // abends nicht plötzlich mit Mond erscheinen.
      ...describeWeather(code, true),
      temperatureMax: num(daily.temperature_2m_max, i),
      temperatureMin: num(daily.temperature_2m_min, i),
      apparentMax: num(daily.apparent_temperature_max, i),
      apparentMin: num(daily.apparent_temperature_min, i),
      sunrise: formatClock(sunrise),
      sunset: formatClock(sunset),
      daylightHours: secondsToHours(num(daily.daylight_duration, i)),
      sunshineHours: secondsToHours(num(daily.sunshine_duration, i)),
      uvIndexMax: num(daily.uv_index_max, i),
      precipitationSum: num(daily.precipitation_sum, i),
      rainSum: num(daily.rain_sum, i),
      showersSum: num(daily.showers_sum, i),
      snowfallSum: num(daily.snowfall_sum, i),
      precipitationHours: num(daily.precipitation_hours, i),
      precipitationProbability: num(daily.precipitation_probability_max, i),
      windSpeedMax: num(daily.wind_speed_10m_max, i),
      windGustsMax: num(daily.wind_gusts_10m_max, i),
      windDirection: direction,
      windDirectionText: windDirectionText(direction),
      // Tagesmittel aus den Stundenwerten — Open-Meteo liefert dafür keine
      // Tagesgröße, für die Einordnung sind sie aber aussagekräftig.
      cloudCoverAvg: average(dayHours.map((hour) => hour.cloudCover)),
      humidityAvg: average(dayHours.map((hour) => hour.humidity)),
      pressureAvg: average(dayHours.map((hour) => hour.pressure)),
      // Sonnenintensität des Tages: Spitzenwert der Globalstrahlung und die
      // daraus integrierte Einstrahlungsmenge (Stundenwerte in W/m² ergeben
      // aufsummiert Wh/m², geteilt durch 1000 kWh/m²).
      radiationMax: maximum(dayHours.map((hour) => hour.radiation)),
      radiationSum: sum(dayHours.map((hour) => hour.radiation)) == null
        ? null
        : sum(dayHours.map((hour) => hour.radiation)) / 1000,
      hours: dayHours,
    });
  }
  return days;
}

function normalizeCurrent(payload) {
  const current = payload && payload.current;
  if (!current) return null;
  const parts = splitLocalTime(current.time);
  const isDay = current.is_day !== 0;
  const direction = parseNumber(current.wind_direction_10m);
  return {
    time: current.time || null,
    dateKey: parts ? parts.dateKey : null,
    clock: formatClock(parts),
    date: formatDate(parts),
    weekday: weekdayName(parts),
    hour: parts ? parts.hour : null,
    isDay,
    ...describeWeather(parseNumber(current.weather_code), isDay),
    temperature: parseNumber(current.temperature_2m),
    apparentTemperature: parseNumber(current.apparent_temperature),
    humidity: parseNumber(current.relative_humidity_2m),
    precipitation: parseNumber(current.precipitation),
    rain: parseNumber(current.rain),
    showers: parseNumber(current.showers),
    snowfall: parseNumber(current.snowfall),
    cloudCover: parseNumber(current.cloud_cover),
    pressure: parseNumber(current.pressure_msl),
    surfacePressure: parseNumber(current.surface_pressure),
    windSpeed: parseNumber(current.wind_speed_10m),
    windGusts: parseNumber(current.wind_gusts_10m),
    windDirection: direction,
    windDirectionText: windDirectionText(direction),
  };
}

// Werte, die nur stündlich geliefert werden (UV, Taupunkt, Sicht), für den
// aktuellen Zeitpunkt aus der Stundenreihe nachtragen: gesucht ist die zum
// Zeitstempel des Aktuellwerts passende Stunde.
function enrichCurrent(current, hours) {
  if (!current || !current.dateKey) return current;
  const match = hours.find((hour) => hour.dateKey === current.dateKey && hour.hour === current.hour);
  const hour = match || hours.find((entry) => entry.dateKey === current.dateKey) || null;
  return {
    ...current,
    uvIndex: hour ? hour.uvIndex : null,
    dewPoint: hour ? hour.dewPoint : null,
    visibility: hour ? hour.visibility : null,
    radiation: hour ? hour.radiation : null,
  };
}

function normalize(payload) {
  const hours = normalizeHours(payload);
  const days = normalizeDays(payload, hours);
  if (!days.length) return null;
  return {
    fetchedAt: Date.now(),
    timezone: payload.timezone || null,
    timezoneAbbreviation: payload.timezone_abbreviation || null,
    latitude: typeof payload.latitude === 'number' ? payload.latitude : null,
    longitude: typeof payload.longitude === 'number' ? payload.longitude : null,
    elevation: typeof payload.elevation === 'number' ? payload.elevation : null,
    current: enrichCurrent(normalizeCurrent(payload), hours),
    days,
  };
}

async function requestForecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: CURRENT_VARIABLES,
    hourly: HOURLY_VARIABLES,
    daily: DAILY_VARIABLES,
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
    return normalize(await response.json());
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Prognose für einen Standort holen (ggf. aus dem Cache). `force` erzwingt die
// Aktualisierung (periodischer Job). Gleiche Cache-Mechanik wie client.js:
// laufende Abrufe werden geteilt, ein Fehlschlag lässt den alten Stand stehen.
async function fetchForecast(latitude, longitude, { force = false } = {}) {
  const lat = parseNumber(latitude);
  const lon = parseNumber(longitude);
  if (lat == null || lon == null) return null;

  const key = cacheKey(lat, lon);
  const entry = cache.get(key);
  const fresh = entry && entry.data && Date.now() - entry.data.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return entry.data;
  if (entry && entry.pending) return entry.pending;

  const previousData = entry && entry.data ? entry.data : null;
  let result = previousData;

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

function getCachedForecast(latitude, longitude) {
  const lat = parseNumber(latitude);
  const lon = parseNumber(longitude);
  if (lat == null || lon == null) return null;
  const entry = cache.get(cacheKey(lat, lon));
  return entry && entry.data ? entry.data : null;
}

function loadLocation(db) {
  return new Promise((resolve) => loadMqttConfig(db, (config) => resolve({
    latitude: parseNumber(config.latitude),
    longitude: parseNumber(config.longitude),
    timezone: config.timezone || null,
  })));
}

// Prognose zum konfigurierten Standort. Ohne `allowFetch` wird nur der
// vorhandene Cache gelesen, damit Seitenaufbau und State-Berechnung nie auf
// dem Netz warten. Ohne hinterlegte Koordinaten gibt es keine Prognose.
async function getWeatherForecast(db, { allowFetch = false } = {}) {
  const location = await loadLocation(db);
  if (location.latitude == null || location.longitude == null) return null;
  const data = allowFetch
    ? await fetchForecast(location.latitude, location.longitude)
    : getCachedForecast(location.latitude, location.longitude);
  return data ? { ...data, location } : null;
}

// Wetter-Cache aktiv aktualisieren (periodischer Job / Start).
async function refreshWeatherForecast(db) {
  const location = await loadLocation(db);
  if (location.latitude == null || location.longitude == null) return null;
  return fetchForecast(location.latitude, location.longitude, { force: true });
}

// Zeitpunkt des letzten Abrufs als Text „TT.MM.JJJJ, HH:MM".
//
// Maßgeblich ist die **in homeESS korrigierte Zeit** (`time-handler`), nicht die
// rohe Systemzeit: die Oberfläche zeigt überall dieselbe Uhr. Der Zeitstempel
// selbst bleibt eine normale Epoch-Millisekunde; nur seine Darstellung läuft
// über den Zeit-Handler.
function formatFetchedAt(fetchedAt) {
  if (!fetchedAt) return '';
  const parts = timeHandler.calendar(new Date(Number(fetchedAt)));
  return `${parts.date}, ${parts.time.slice(0, 5)}`;
}

// Nur für Tests: Cache leeren bzw. einen Stand vorgeben.
function resetForTests(seed = null) {
  cache.clear();
  if (seed) cache.set(cacheKey(seed.latitude, seed.longitude), { data: seed.data });
}

module.exports = {
  getWeatherForecast,
  refreshWeatherForecast,
  formatFetchedAt,
  fetchForecast,
  getCachedForecast,
  normalize,
  resetForTests,
  CACHE_TTL_MS,
  FORECAST_DAYS,
  DETAIL_DAYS,
};
