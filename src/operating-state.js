'use strict';

const { normalizeMqttTopic } = require('./mqtt/topics');
const mqttClient = require('./mqtt/client');

const AUTARK_DAYS_STATE_ID = 'prognose.autarkDaysExternal';
const AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID = 'prognose.autarkDaysPreviousYearExternal';

let operatingLevel = 2;
let emergencyMode = false;
let autark = true;
let autarkDayKey = '';
let autarkDaysCount = 0;
let autarkDaysYear = '';
let autarkCountedDayKey = '';
let autarkDaysTopic = '';
let autarkDaysPreviousYearCount = 0;
let autarkDaysPreviousYear = '';
let autarkDaysPreviousYearTopic = '';
let unsubscribeMqtt = null;
let ignoreExternalUntil = 0;
const levelListeners = new Set();

// Abonnieren von Betriebslevel-Änderungen. Gibt eine Unsubscribe-Funktion zurück.
function onOperatingLevelChanged(callback) {
  if (typeof callback !== 'function') return () => {};
  levelListeners.add(callback);
  return () => levelListeners.delete(callback);
}

function notifyLevelChanged() {
  for (const callback of levelListeners) {
    try { callback(operatingLevel); } catch (_) {}
  }
}

function init(db) {
  return new Promise((resolve) => {
    db.all('PRAGMA table_info(operating_state)', (schemaError, rows) => {
      const existing = new Set(Array.isArray(rows) ? rows.map((row) => row.name) : []);
      const additions = [
        { name: 'autark', sql: 'ALTER TABLE operating_state ADD COLUMN autark INTEGER NOT NULL DEFAULT 1' },
        { name: 'autark_day_key', sql: "ALTER TABLE operating_state ADD COLUMN autark_day_key TEXT NOT NULL DEFAULT ''" },
        { name: 'autark_days_count', sql: 'ALTER TABLE operating_state ADD COLUMN autark_days_count INTEGER NOT NULL DEFAULT 0' },
        { name: 'autark_days_year', sql: "ALTER TABLE operating_state ADD COLUMN autark_days_year TEXT NOT NULL DEFAULT ''" },
        { name: 'autark_counted_day_key', sql: "ALTER TABLE operating_state ADD COLUMN autark_counted_day_key TEXT NOT NULL DEFAULT ''" },
        { name: 'autark_days_topic', sql: "ALTER TABLE operating_state ADD COLUMN autark_days_topic TEXT NOT NULL DEFAULT ''" },
        { name: 'autark_days_previous_year_count', sql: 'ALTER TABLE operating_state ADD COLUMN autark_days_previous_year_count INTEGER NOT NULL DEFAULT 0' },
        { name: 'autark_days_previous_year', sql: "ALTER TABLE operating_state ADD COLUMN autark_days_previous_year TEXT NOT NULL DEFAULT ''" },
        { name: 'autark_days_previous_year_topic', sql: "ALTER TABLE operating_state ADD COLUMN autark_days_previous_year_topic TEXT NOT NULL DEFAULT ''" },
      ].filter((addition) => !existing.has(addition.name));
      const addNext = (index) => {
        if (!schemaError && index < additions.length) {
          db.run(additions[index].sql, () => addNext(index + 1));
          return;
        }
        db.get('SELECT * FROM operating_state WHERE id = 1', (err, row) => {
          if (!err && row) {
            operatingLevel = Math.min(5, Math.max(1, Number(row.operating_level) || 2));
            emergencyMode = !!row.emergency_mode;
            autark = row.autark == null ? true : !!row.autark;
            autarkDayKey = row.autark_day_key || '';
            autarkDaysCount = Math.min(366, Math.max(0, Math.round(Number(row.autark_days_count) || 0)));
            autarkDaysYear = row.autark_days_year || '';
            autarkCountedDayKey = row.autark_counted_day_key || '';
            autarkDaysTopic = row.autark_days_topic || '';
            autarkDaysPreviousYearCount = Math.min(366, Math.max(0, Math.round(Number(row.autark_days_previous_year_count) || 0)));
            autarkDaysPreviousYear = row.autark_days_previous_year || '';
            autarkDaysPreviousYearTopic = row.autark_days_previous_year_topic || '';
          }
          resolve(getState());
        });
      };
      addNext(0);
    });
  });
}

function persist(db) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO operating_state
        (id, operating_level, emergency_mode, autark, autark_day_key,
         autark_days_count, autark_days_year, autark_counted_day_key, autark_days_topic,
         autark_days_previous_year_count, autark_days_previous_year, autark_days_previous_year_topic)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET operating_level=excluded.operating_level,
       emergency_mode=excluded.emergency_mode, autark=excluded.autark,
       autark_day_key=excluded.autark_day_key,
       autark_days_count=excluded.autark_days_count,
       autark_days_year=excluded.autark_days_year,
       autark_counted_day_key=excluded.autark_counted_day_key,
       autark_days_topic=excluded.autark_days_topic,
       autark_days_previous_year_count=excluded.autark_days_previous_year_count,
       autark_days_previous_year=excluded.autark_days_previous_year,
       autark_days_previous_year_topic=excluded.autark_days_previous_year_topic`,
      [operatingLevel, emergencyMode ? 1 : 0, autark ? 1 : 0, autarkDayKey,
        autarkDaysCount, autarkDaysYear, autarkCountedDayKey, autarkDaysTopic,
        autarkDaysPreviousYearCount, autarkDaysPreviousYear, autarkDaysPreviousYearTopic],
      () => resolve(getState())
    );
  });
}

async function setOperatingLevel(db, level) {
  const next = Math.min(5, Math.max(1, Math.round(Number(level) || 1)));
  if (next === operatingLevel) return getState();
  operatingLevel = next;
  const result = await persist(db);
  notifyLevelChanged();
  return result;
}

async function setEmergencyMode(db, active) {
  const next = !!active;
  if (next === emergencyMode) return getState();
  emergencyMode = next;
  return persist(db);
}

async function updateAutarkForDay(db, dayKey, minimumSocGridActive) {
  const normalizedDay = String(dayKey || '').trim();
  if (!normalizedDay) return getState();
  let changed = false;
  let countChanged = false;
  if (autarkDayKey !== normalizedDay) {
    const finishedDay = autarkDayKey;
    const finishedYear = finishedDay.slice(0, 4);
    const nextYear = normalizedDay.slice(0, 4);
    if (!autarkDaysYear && finishedYear) autarkDaysYear = finishedYear;
    if (finishedDay && autark && autarkCountedDayKey !== finishedDay && autarkDaysYear === finishedYear) {
      autarkDaysCount = Math.min(366, autarkDaysCount + 1);
      autarkCountedDayKey = finishedDay;
      countChanged = true;
    }
    // Der veröffentlichte Zähler beschreibt immer das laufende Kalenderjahr.
    if (nextYear && autarkDaysYear !== nextYear) {
      if (autarkDaysYear) {
        autarkDaysPreviousYearCount = autarkDaysCount;
        autarkDaysPreviousYear = autarkDaysYear;
      }
      autarkDaysYear = nextYear;
      autarkDaysCount = 0;
      autarkCountedDayKey = '';
      countChanged = true;
    }
    autarkDayKey = normalizedDay;
    autark = !minimumSocGridActive;
    changed = true;
  } else if (minimumSocGridActive && autark) {
    autark = false;
    changed = true;
  }
  const result = changed ? await persist(db) : getState();
  if (countChanged) publishAutarkDays();
  return result;
}

function publishAutarkDays() {
  if (autarkDaysTopic) mqttClient.publish(autarkDaysTopic, autarkDaysCount);
  if (autarkDaysPreviousYearTopic) mqttClient.publish(autarkDaysPreviousYearTopic, autarkDaysPreviousYearCount);
}

async function setAutarkDaysTopic(db, topic) {
  autarkDaysTopic = normalizeMqttTopic(topic || '');
  await persist(db);
  return getState();
}

async function setAutarkDaysPreviousYearTopic(db, topic) {
  autarkDaysPreviousYearTopic = normalizeMqttTopic(topic || '');
  await persist(db);
  return getState();
}

async function setAutarkDaysCount(db, value, { publish = false } = {}) {
  const number = Number(String(value == null ? '' : value).replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) return getState();
  const next = Math.min(366, Math.round(number));
  if (next !== autarkDaysCount) {
    autarkDaysCount = next;
    await persist(db);
  }
  if (publish) publishAutarkDays();
  return getState();
}

async function setAutarkDaysPreviousYearCount(db, value, { publish = false } = {}) {
  const number = Number(String(value == null ? '' : value).replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) return getState();
  const next = Math.min(366, Math.round(number));
  if (next !== autarkDaysPreviousYearCount) {
    autarkDaysPreviousYearCount = next;
    await persist(db);
  }
  if (publish) publishAutarkDays();
  return getState();
}

function startMqttSync(db) {
  if (unsubscribeMqtt) unsubscribeMqtt();
  unsubscribeMqtt = mqttClient.onValuesChanged((event) => {
    if (!event.changedKeys.includes(AUTARK_DAYS_STATE_ID) &&
        !event.changedKeys.includes(AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID)) return;
    if (Date.now() < ignoreExternalUntil) return;
    const cache = mqttClient.getCache();
    if (event.changedKeys.includes(AUTARK_DAYS_STATE_ID)) {
      setAutarkDaysCount(db, cache.get(AUTARK_DAYS_STATE_ID)?.value).catch(() => {});
    }
    if (event.changedKeys.includes(AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID)) {
      setAutarkDaysPreviousYearCount(db, cache.get(AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID)?.value).catch(() => {});
    }
  });
}

function suppressExternalSync(milliseconds = 3000) {
  ignoreExternalUntil = Date.now() + Math.max(0, Number(milliseconds) || 0);
}

function buildStateDefinition(state = getState()) {
  return [
    state.autarkDaysTopic ? { id: AUTARK_DAYS_STATE_ID, topic: state.autarkDaysTopic } : null,
    state.autarkDaysPreviousYearTopic
      ? { id: AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID, topic: state.autarkDaysPreviousYearTopic }
      : null,
  ].filter(Boolean);
}

function getState() {
  return {
    operatingLevel, emergencyMode, autark, autarkDayKey,
    autarkDaysCount, autarkDaysYear, autarkCountedDayKey, autarkDaysTopic,
    autarkDaysPreviousYearCount, autarkDaysPreviousYear, autarkDaysPreviousYearTopic,
  };
}

module.exports = {
  init, getState, setOperatingLevel, setEmergencyMode, updateAutarkForDay,
  setAutarkDaysTopic, setAutarkDaysCount, startMqttSync, buildStateDefinition,
  setAutarkDaysPreviousYearTopic, setAutarkDaysPreviousYearCount,
  publishAutarkDays, AUTARK_DAYS_STATE_ID,
  AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID,
  suppressExternalSync, onOperatingLevelChanged,
};
