'use strict';

// Zentrale homeESS-Uhr. Date.now() (typischerweise durch den Betriebssystem-
// Zeitdienst synchronisiert) ist die dauerhaft laufende Primärquelle. Ein
// konfiguriertes MQTT-Uhrzeittopic liefert ausschließlich Korrektur-Messpunkte:
// Aus den letzten Messungen wird ein gleitender mittlerer Versatz gebildet, der
// auch bei Ausfall des Brokers weiter auf die Systemzeit angewendet wird.

const bus = require('./state-bus');
const systemRouter = require('./states/system-router');
const { loadMqttConfig, normalizeTime, normalizeDate, ENVIRONMENT_STATE_IDS } = require('./mqtt/config');

const SAMPLE_WINDOW = 60;
const MQTT_FRESH_MS = 2 * 60 * 1000;
const TIME_STATE_ID = 'operating.time';
const DATE_STATE_ID = 'operating.date';

let settings = { timezone: 'Europe/Berlin', dstEnabled: true, clockTimeTopic: '', clockDateTopic: '' };
let offsetSamples = [];
let averageOffsetSeconds = 0;
let lastTimeReceivedAt = 0;
let lastDateReceivedAt = 0;
let lastMqttSeenAt = 0;
let lastMqttDisplay = '';
let initialized = false;
let unsubscribe = null;
let tickTimer = null;

function pad(value) { return String(value).padStart(2, '0'); }

function validTimezone(value) {
  const timezone = String(value || '').trim() || 'Europe/Berlin';
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch (_) {
    return 'Europe/Berlin';
  }
}

function booleanSetting(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') return !['', '0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function configure(config = {}) {
  const next = {
    timezone: validTimezone(config.timezone || settings.timezone),
    dstEnabled: booleanSetting(config.dstEnabled, settings.dstEnabled),
    clockTimeTopic: config.clockTimeTopic == null ? settings.clockTimeTopic : String(config.clockTimeTopic || '').trim(),
    clockDateTopic: config.clockDateTopic == null ? settings.clockDateTopic : String(config.clockDateTopic || '').trim(),
  };
  if (next.timezone !== settings.timezone || next.dstEnabled !== settings.dstEnabled ||
      next.clockTimeTopic !== settings.clockTimeTopic || next.clockDateTopic !== settings.clockDateTopic) {
    offsetSamples = [];
    averageOffsetSeconds = 0;
    lastTimeReceivedAt = 0;
    lastDateReceivedAt = 0;
    lastMqttSeenAt = 0;
    lastMqttDisplay = '';
  }
  settings = next;
  return { ...settings };
}

function zoneOffsetMinutes(timezone, instant) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second));
    return Math.round((localAsUtc - instant.getTime()) / 60000);
  } catch (_) { return 0; }
}

function standardOffsetMinutes(timezone, year) {
  return Math.min(
    zoneOffsetMinutes(timezone, new Date(Date.UTC(year, 0, 15, 12))),
    zoneOffsetMinutes(timezone, new Date(Date.UTC(year, 6, 15, 12)))
  );
}

function zonedParts(instant, timezone = settings.timezone, dstEnabled = settings.dstEnabled) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const zone = validTimezone(timezone);
  if (!dstEnabled) {
    const offset = standardOffsetMinutes(zone, date.getUTCFullYear());
    const fixed = new Date(date.getTime() + offset * 60000);
    return {
      year: fixed.getUTCFullYear(), month: fixed.getUTCMonth() + 1, day: fixed.getUTCDate(),
      hours: fixed.getUTCHours(), minutes: fixed.getUTCMinutes(), seconds: fixed.getUTCSeconds(),
      offsetMinutes: offset,
    };
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year), month: Number(values.month), day: Number(values.day),
      hours: Number(values.hour), minutes: Number(values.minute), seconds: Number(values.second),
      offsetMinutes: zoneOffsetMinutes(zone, date),
    };
  } catch (_) {
    return {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hours: date.getUTCHours(), minutes: date.getUTCMinutes(), seconds: date.getUTCSeconds(), offsetMinutes: 0,
    };
  }
}

function weekKey(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

function decorate(parts) {
  const dateKey = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const time = `${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`;
  return {
    ...parts,
    dateKey,
    weekKey: weekKey(parts),
    monthKey: `${parts.year}-${pad(parts.month)}`,
    yearKey: String(parts.year),
    time,
    date: `${pad(parts.day)}.${pad(parts.month)}.${parts.year}`,
  };
}

function now(baseMs = Date.now()) { return new Date(Number(baseMs) + averageOffsetSeconds * 1000); }
function calendar(base = new Date(), overrides = {}) {
  const baseMs = base instanceof Date ? base.getTime() : Number(base);
  return decorate(zonedParts(
    new Date(baseMs + averageOffsetSeconds * 1000),
    overrides.timezone || settings.timezone,
    overrides.dstEnabled == null ? settings.dstEnabled : Boolean(overrides.dstEnabled)
  ));
}
function systemCalendar(base = new Date(), overrides = {}) {
  return decorate(zonedParts(
    base instanceof Date ? base : new Date(base),
    overrides.timezone || settings.timezone,
    overrides.dstEnabled == null ? settings.dstEnabled : Boolean(overrides.dstEnabled)
  ));
}

// Lokale Wanduhrteile in einen UTC-Zeitpunkt der konfigurierten Zone umrechnen.
// Zweifache Offsetbestimmung behandelt DST-Umschaltgrenzen ausreichend stabil.
function wallPartsToEpoch(parts, timezone = settings.timezone, dstEnabled = settings.dstEnabled) {
  const wallUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours, parts.minutes, parts.seconds || 0);
  if (!dstEnabled) return wallUtc - standardOffsetMinutes(timezone, parts.year) * 60000;
  let guess = new Date(wallUtc);
  let offset = zoneOffsetMinutes(timezone, guess);
  guess = new Date(wallUtc - offset * 60000);
  offset = zoneOffsetMinutes(timezone, guess);
  return wallUtc - offset * 60000;
}

function nearestDateForTime(time, receivedAt) {
  const local = zonedParts(new Date(receivedAt), settings.timezone, settings.dstEnabled);
  const base = { year: local.year, month: local.month, day: local.day, ...time };
  const center = wallPartsToEpoch(base);
  const candidates = [center - 86400000, center, center + 86400000];
  return candidates.reduce((best, value) => Math.abs(value - receivedAt) < Math.abs(best - receivedAt) ? value : best, center);
}

function addOffsetSample(offsetSeconds, receivedAt, mqttDisplay) {
  if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 12 * 60 * 60) return false;
  offsetSamples.push(offsetSeconds);
  if (offsetSamples.length > SAMPLE_WINDOW) offsetSamples.shift();
  averageOffsetSeconds = offsetSamples.reduce((sum, value) => sum + value, 0) / offsetSamples.length;
  lastMqttSeenAt = receivedAt;
  lastMqttDisplay = mqttDisplay;
  return true;
}

function observeCache(cache) {
  if (!settings.clockTimeTopic || !cache || typeof cache.get !== 'function') return false;
  const timeEntry = cache.get(ENVIRONMENT_STATE_IDS.clockTime);
  if (!timeEntry) return false;
  const dateEntry = cache.get(ENVIRONMENT_STATE_IDS.clockDate);
  const timeReceivedAt = Number(timeEntry.receivedAt) || 0;
  const dateReceivedAt = Number(dateEntry && dateEntry.receivedAt) || 0;
  if (!(timeReceivedAt > lastTimeReceivedAt) && !(dateReceivedAt > lastDateReceivedAt)) return false;
  const time = normalizeTime(timeEntry.value);
  if (!time.iso) return false;
  lastTimeReceivedAt = Math.max(lastTimeReceivedAt, timeReceivedAt);
  lastDateReceivedAt = Math.max(lastDateReceivedAt, dateReceivedAt);
  const date = normalizeDate(dateEntry && dateEntry.value);
  const receivedAt = Number(timeEntry.receivedAt) || Date.now();
  const timeParts = { hours: time.hours, minutes: time.minutes, seconds: time.seconds };
  let mqttEpoch = date.iso
    ? wallPartsToEpoch({ year: date.year, month: date.month, day: date.day, ...timeParts })
    : nearestDateForTime(timeParts, receivedAt);

  // Rund um Mitternacht kann das retained Datum wenige Millisekunden hinter der
  // Uhrzeit eintreffen. Ist die datumsbasierte Probe offenkundig einen Tag weg,
  // gewinnt die nächstgelegene reine Uhrzeitprobe.
  const nearest = nearestDateForTime(timeParts, receivedAt);
  if (Math.abs(mqttEpoch - receivedAt) > 6 * 60 * 60 * 1000 && Math.abs(nearest - receivedAt) < 6 * 60 * 60 * 1000) {
    mqttEpoch = nearest;
  }
  return addOffsetSample((mqttEpoch - receivedAt) / 1000, receivedAt, `${date.iso ? `${date.display} ` : ''}${time.iso}`);
}

function stateEntries(baseMs = Date.now()) {
  const current = calendar(new Date(baseMs));
  return [
    { id: TIME_STATE_ID, value: current.time, display: current.time },
    { id: DATE_STATE_ID, value: current.date, display: current.date },
  ];
}

function publishClock() { systemRouter.publish(stateEntries()); }

async function init(db) {
  const config = await new Promise((resolve) => loadMqttConfig(db, resolve));
  configure(config);
  initialized = true;
  observeCache(bus.getCache());
  if (!unsubscribe) unsubscribe = bus.onValuesChanged((event) => {
    const keys = event && event.changedKeys || [];
    if (keys.includes(ENVIRONMENT_STATE_IDS.clockTime) || keys.includes(ENVIRONMENT_STATE_IDS.clockDate)) {
      observeCache(bus.getCache());
    }
  });
  if (!tickTimer) {
    tickTimer = setInterval(publishClock, 1000);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
  }
  publishClock();
  return snapshot();
}

function snapshot(baseMs = Date.now()) {
  const local = systemCalendar(new Date(baseMs));
  const internal = calendar(new Date(baseMs));
  return {
    timezone: settings.timezone,
    dstEnabled: settings.dstEnabled,
    local: { time: local.time, date: local.date },
    internal: { time: internal.time, date: internal.date },
    mqtt: {
      available: lastMqttSeenAt > 0,
      fresh: lastMqttSeenAt > 0 && baseMs - lastMqttSeenAt <= MQTT_FRESH_MS,
      display: lastMqttDisplay,
      lastSeenAt: lastMqttSeenAt || null,
    },
    offsetSeconds: averageOffsetSeconds,
    sampleCount: offsetSamples.length,
  };
}

function isInitialized() { return initialized; }
function resetForTests() {
  offsetSamples = []; averageOffsetSeconds = 0; lastTimeReceivedAt = 0; lastDateReceivedAt = 0; lastMqttSeenAt = 0; lastMqttDisplay = '';
  initialized = false; settings = { timezone: 'Europe/Berlin', dstEnabled: true, clockTimeTopic: '', clockDateTopic: '' };
}

module.exports = {
  TIME_STATE_ID, DATE_STATE_ID, SAMPLE_WINDOW,
  init, configure, now, calendar, systemCalendar, snapshot, stateEntries, observeCache, isInitialized,
  zonedParts, wallPartsToEpoch, weekKey, resetForTests,
};
