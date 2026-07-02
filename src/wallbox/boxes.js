'use strict';

// CRUD + Validierung der einzelnen Wallboxen (Vorbild: photovoltaik/plants.js).
// Jede Wallbox wird einzeln angelegt und über sechs/sieben MQTT-Topics gesteuert
// und gemessen; die Lademodi (1=Privat, 2=Beruflich, 3=Immer voll) haben je eine
// eigene Priorität für den Betriebslevel-Handler.

const { normalizeMqttTopic } = require('../mqtt/topics');

const CHARGE_MODES = [
  { value: 1, key: 'private', label: 'Privat' },
  { value: 2, key: 'business', label: 'Beruflich' },
  { value: 3, key: 'full', label: 'Immer voll' },
];

const POWER_UNITS = ['W', 'kW'];
const COUNTER_UNITS = ['Wh', 'kWh'];

// Wochentage Mo..So als Bitmaske-Indizes (0=Mo ... 6=So) für den Beruflich-Modus.
const WEEKDAYS = [
  { index: 0, label: 'Mo' },
  { index: 1, label: 'Di' },
  { index: 2, label: 'Mi' },
  { index: 3, label: 'Do' },
  { index: 4, label: 'Fr' },
  { index: 5, label: 'Sa' },
  { index: 6, label: 'So' },
];

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPriority(value, fallback) {
  const parsed = parseNumber(value);
  if (parsed == null) return fallback;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function clampPercent(value, fallback) {
  const parsed = parseNumber(value);
  if (parsed == null) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function normalizeUnit(value, allowed, fallback) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function normalizeBusinessDays(value) {
  // Akzeptiert ein Array (Formular-Checkboxen) oder einen CSV-String.
  let parts = [];
  if (Array.isArray(value)) parts = value;
  else if (typeof value === 'string') parts = value.split(',');
  const set = new Set();
  for (const part of parts) {
    const index = parseNumber(part);
    if (index != null && index >= 0 && index <= 6) set.add(Math.round(index));
  }
  return [...set].sort((a, b) => a - b).join(',');
}

function businessDaysToArray(csv) {
  if (!csv) return [];
  return csv.split(',').map((part) => parseNumber(part)).filter((n) => n != null);
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function normalizeRow(row = {}) {
  return {
    id: row.id,
    name: row.name || '',
    maxPowerW: parseNumber(row.max_power_w),
    batteryCapacityKwh: parseNumber(row.battery_capacity_kwh),
    commandTopic: row.command_topic || '',
    statusTopic: row.status_topic || '',
    powerTopic: row.power_topic || '',
    powerUnit: normalizeUnit(row.power_unit, POWER_UNITS, 'W'),
    counterTopic: row.counter_topic || '',
    counterUnit: normalizeUnit(row.counter_unit, COUNTER_UNITS, 'kWh'),
    setpointTopic: row.setpoint_topic || '',
    pluggedTopic: row.plugged_topic || '',
    socTopic: row.soc_topic || '',
    modeSyncTopic: row.mode_sync_topic || '',
    mode: [1, 2, 3].includes(Number(row.mode)) ? Number(row.mode) : 1,
    priorityPrivate: clampPriority(row.priority_private, 5),
    priorityBusiness: clampPriority(row.priority_business, 3),
    priorityFull: clampPriority(row.priority_full, 4),
    minChargePercent: clampPercent(row.min_charge_percent, 30),
    businessDays: businessDaysToArray(row.business_days),
    stallTimeoutSeconds: row.stall_timeout_seconds != null ? Math.max(0, Math.round(row.stall_timeout_seconds)) : 120,
    stallPowerW: parseNumber(row.stall_power_w) != null ? parseNumber(row.stall_power_w) : 200,
  };
}

const COLUMNS = `id, name, max_power_w, battery_capacity_kwh, command_topic, status_topic,
  power_topic, power_unit, counter_topic, counter_unit, setpoint_topic, plugged_topic,
  soc_topic, mode_sync_topic, mode, priority_private, priority_business, priority_full,
  min_charge_percent, business_days, stall_timeout_seconds, stall_power_w`;

const wallboxListCache = new WeakMap();
function invalidateWallboxes(db) { if (db) wallboxListCache.delete(db); }

async function listWallboxes(db) {
  const cached = wallboxListCache.get(db);
  if (cached) return cached;
  const rows = await dbAll(db, `SELECT ${COLUMNS} FROM wallboxes ORDER BY id ASC`);
  const boxes = rows.map(normalizeRow);
  wallboxListCache.set(db, boxes);
  return boxes;
}

async function getWallbox(db, id) {
  const row = await dbGet(db, `SELECT ${COLUMNS} FROM wallboxes WHERE id = ?`, [id]);
  return row ? normalizeRow(row) : null;
}

function normalizeInput(input = {}) {
  return {
    name: String(input.name || '').trim(),
    maxPowerW: parseNumber(input.maxPowerW),
    batteryCapacityKwh: parseNumber(input.batteryCapacityKwh),
    commandTopic: normalizeMqttTopic(input.commandTopic || ''),
    statusTopic: normalizeMqttTopic(input.statusTopic || ''),
    powerTopic: normalizeMqttTopic(input.powerTopic || ''),
    powerUnit: normalizeUnit(input.powerUnit, POWER_UNITS, 'W'),
    counterTopic: normalizeMqttTopic(input.counterTopic || ''),
    counterUnit: normalizeUnit(input.counterUnit, COUNTER_UNITS, 'kWh'),
    setpointTopic: normalizeMqttTopic(input.setpointTopic || ''),
    pluggedTopic: normalizeMqttTopic(input.pluggedTopic || ''),
    socTopic: normalizeMqttTopic(input.socTopic || ''),
    modeSyncTopic: normalizeMqttTopic(input.modeSyncTopic || ''),
    priorityPrivate: clampPriority(input.priorityPrivate, 5),
    priorityBusiness: clampPriority(input.priorityBusiness, 3),
    priorityFull: clampPriority(input.priorityFull, 4),
    minChargePercent: clampPercent(input.minChargePercent, 30),
    businessDays: normalizeBusinessDays(input.businessDays),
    stallTimeoutSeconds: (() => {
      const n = parseNumber(input.stallTimeoutSeconds);
      return n != null && n >= 0 ? Math.round(n) : 120;
    })(),
    stallPowerW: (() => {
      const n = parseNumber(input.stallPowerW);
      return n != null && n >= 0 ? n : 200;
    })(),
  };
}

function validateInput(input) {
  const errors = [];
  if (!input.name) errors.push('Bitte einen Namen für die Wallbox eingeben.');
  if (input.maxPowerW == null || input.maxPowerW <= 0) {
    errors.push('Bitte die Maximalleistung der Wallbox (W) angeben.');
  }
  if (input.batteryCapacityKwh == null || input.batteryCapacityKwh <= 0) {
    errors.push('Bitte die Akkugröße des Fahrzeugs (kWh) angeben.');
  }
  if (!input.commandTopic) errors.push('Bitte das Steuer-Topic (an/aus) angeben.');
  return errors;
}

const INSERT_PARAMS = (input, mode) => [
  input.name, input.maxPowerW, input.batteryCapacityKwh, input.commandTopic,
  input.statusTopic, input.powerTopic, input.powerUnit, input.counterTopic,
  input.counterUnit, input.setpointTopic, input.pluggedTopic, input.socTopic,
  input.modeSyncTopic, mode, input.priorityPrivate, input.priorityBusiness,
  input.priorityFull, input.minChargePercent, input.businessDays,
  input.stallTimeoutSeconds, input.stallPowerW,
];

async function createWallbox(db, rawInput) {
  const input = normalizeInput(rawInput);
  const errors = validateInput(input);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validation = true;
    throw error;
  }
  const result = await dbRun(
    db,
    `INSERT INTO wallboxes
     (name, max_power_w, battery_capacity_kwh, command_topic, status_topic, power_topic,
      power_unit, counter_topic, counter_unit, setpoint_topic, plugged_topic, soc_topic,
      mode_sync_topic, mode, priority_private, priority_business, priority_full,
      min_charge_percent, business_days, stall_timeout_seconds, stall_power_w)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    INSERT_PARAMS(input, 1)
  );
  await dbRun(
    db,
    `INSERT INTO wallbox_counter_state (wallbox_id, last_raw_value, day_total, last_day_key)
     VALUES (?, NULL, 0, '')`,
    [result.lastID]
  );
  await dbRun(
    db,
    `INSERT INTO wallbox_summary_state (wallbox_id) VALUES (?)`,
    [result.lastID]
  );
  invalidateWallboxes(db);
  return getWallbox(db, result.lastID);
}

async function updateWallbox(db, id, rawInput) {
  const input = normalizeInput(rawInput);
  const errors = validateInput(input);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validation = true;
    throw error;
  }
  await dbRun(
    db,
    `UPDATE wallboxes SET
       name = ?, max_power_w = ?, battery_capacity_kwh = ?, command_topic = ?, status_topic = ?,
       power_topic = ?, power_unit = ?, counter_topic = ?, counter_unit = ?, setpoint_topic = ?,
       plugged_topic = ?, soc_topic = ?, mode_sync_topic = ?, priority_private = ?,
       priority_business = ?, priority_full = ?, min_charge_percent = ?, business_days = ?,
       stall_timeout_seconds = ?, stall_power_w = ?
     WHERE id = ?`,
    [
      input.name, input.maxPowerW, input.batteryCapacityKwh, input.commandTopic,
      input.statusTopic, input.powerTopic, input.powerUnit, input.counterTopic,
      input.counterUnit, input.setpointTopic, input.pluggedTopic, input.socTopic,
      input.modeSyncTopic, input.priorityPrivate, input.priorityBusiness,
      input.priorityFull, input.minChargePercent, input.businessDays,
      input.stallTimeoutSeconds, input.stallPowerW, id,
    ]
  );
  invalidateWallboxes(db);
  return getWallbox(db, id);
}

async function deleteWallbox(db, id) {
  await dbRun(db, 'DELETE FROM wallbox_hourly_consumption WHERE wallbox_id = ?', [id]);
  await dbRun(db, 'DELETE FROM wallbox_daily_consumption WHERE wallbox_id = ?', [id]);
  await dbRun(db, 'DELETE FROM wallbox_counter_state WHERE wallbox_id = ?', [id]);
  await dbRun(db, 'DELETE FROM wallbox_summary_state WHERE wallbox_id = ?', [id]);
  await dbRun(db, 'DELETE FROM wallboxes WHERE id = ?', [id]);
  invalidateWallboxes(db);
}

async function setWallboxMode(db, id, mode) {
  const value = [1, 2, 3].includes(Number(mode)) ? Number(mode) : 1;
  await dbRun(db, 'UPDATE wallboxes SET mode = ? WHERE id = ?', [value, id]);
  invalidateWallboxes(db);
  return value;
}

// Cache-Key-Schema für die abonnierten Read-Topics einer Wallbox.
function cacheKey(id, suffix) {
  return `wallbox:${id}:${suffix}`;
}

// MQTT-State-Definitionen für alle lesbaren Topics (Schalt-/Soll-Topics werden
// geschrieben, nicht abonniert).
function buildWallboxStateDefinitions(boxes) {
  const defs = [];
  for (const box of boxes || []) {
    // Das Steuer-Topic separat abonnieren: nur Änderungen hier können als
    // Bedienwunsch gelten. Automatik-Readbacks werden in automation.js abgefangen.
    if (box.commandTopic) defs.push({ id: cacheKey(box.id, 'command'), topic: box.commandTopic });
    if (box.statusTopic) defs.push({ id: cacheKey(box.id, 'status'), topic: box.statusTopic });
    if (box.powerTopic) defs.push({ id: cacheKey(box.id, 'power'), topic: box.powerTopic });
    if (box.counterTopic) defs.push({ id: cacheKey(box.id, 'counter'), topic: box.counterTopic });
    if (box.pluggedTopic) defs.push({ id: cacheKey(box.id, 'plugged'), topic: box.pluggedTopic });
    if (box.socTopic) defs.push({ id: cacheKey(box.id, 'soc'), topic: box.socTopic });
    if (box.modeSyncTopic) defs.push({ id: cacheKey(box.id, 'modeSync'), topic: box.modeSyncTopic });
    // Ohne dediziertes Status-Topic dient das Steuer-Topic als Ist-Stand-Quelle.
    if (!box.statusTopic && box.commandTopic) {
      defs.push({ id: cacheKey(box.id, 'status'), topic: box.commandTopic });
    }
  }
  return defs;
}

module.exports = {
  CHARGE_MODES, POWER_UNITS, COUNTER_UNITS, WEEKDAYS,
  listWallboxes, invalidateWallboxes, getWallbox, createWallbox, updateWallbox, deleteWallbox, setWallboxMode,
  normalizeInput, buildWallboxStateDefinitions, cacheKey,
  parseNumber, businessDaysToArray,
};
