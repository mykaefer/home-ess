'use strict';

// CRUD + Validierung der Messen-+-Schalten-Geräte (Aktoren). Vorbild:
// wallbox/boxes.js. Je Gerät bis zu fünf MQTT-Topics: schalten, remote, status, leistung,
// zähler. Mindestens eines von schalten/leistung/zähler muss gesetzt sein. Die
// Priorität (1–5) kann optional von der zugeordneten Gruppe übernommen werden.

const { normalizeMqttTopic } = require('../mqtt/topics');
const { PHASES, normalizePhase: normalizeSharedPhase } = require('../grid-control/load-shed');

const POWER_UNITS = ['W', 'kW'];
const COUNTER_UNITS = ['Wh', 'kWh'];
const LOAD_SHED_PHASES = PHASES;

// Zulässige Funktions-Schlüssel (Dropdown „Funktion"). Hier lokal gehalten,
// damit functions.js dieses Modul einbinden kann, ohne einen Zyklus zu bilden.
const FUNCTION_KEYS = ['licht', 'waschen', 'warmwasser', 'heizung_klima', 'kochen'];

function normalizeFunctionKey(value) {
  const key = String(value || '').trim();
  return FUNCTION_KEYS.includes(key) ? key : '';
}

function normalizeLoadShedPhase(value) {
  return normalizeSharedPhase(value, 'l1');
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

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

// Nennleistung: nur ein positiver Wert aktiviert die virtuelle Zählung; alles
// andere (leer, 0, negativ, keine Zahl) gilt als „nicht gesetzt".
function parseRatedPower(value) {
  const parsed = parseNumber(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function clampPriority(value, fallback) {
  const parsed = parseNumber(value);
  if (parsed == null) return fallback;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function normalizeUnit(value, allowed, fallback) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function parseGroupId(value) {
  if (value == null || value === '' || value === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRow(row = {}) {
  return {
    id: row.id,
    name: row.name || '',
    groupId: row.group_id == null ? null : row.group_id,
    position: row.position == null ? 0 : row.position,
    switchTopic: row.switch_topic || '',
    remoteTopic: row.remote_topic || '',
    statusTopic: row.status_topic || '',
    powerTopic: row.power_topic || '',
    powerUnit: normalizeUnit(row.power_unit, POWER_UNITS, 'W'),
    counterTopic: row.counter_topic || '',
    counterUnit: normalizeUnit(row.counter_unit, COUNTER_UNITS, 'kWh'),
    // Nennleistung + Einheit für die virtuelle Zählung (siehe aggregation.js).
    ratedPower: parseRatedPower(row.rated_power),
    ratedPowerUnit: normalizeUnit(row.rated_power_unit, POWER_UNITS, 'W'),
    priority: clampPriority(row.priority, 4),
    useGroupPriority: Number(row.use_group_priority) === 1,
    // Jedes schaltbare Gerät hat Zwangs-Aus unterhalb seiner Priorität. „Immer an"
    // schaltet es nach erneuter Freigabe automatisch wieder ein; ohne bleibt es aus.
    alwaysOn: Number(row.always_on) === 1,
    // Leer = Funktion der Gruppe übernehmen (falls gesetzt), sonst keine Funktion.
    functionKey: normalizeFunctionKey(row.function_key),
    loadShedEnabled: Number(row.load_shed_enabled) === 1,
    loadShedPhase: normalizeLoadShedPhase(row.load_shed_phase),
    // Zuordnung zu einer Schaltgruppe: wird nur über die Schaltgruppen-Seite
    // (Drag & Drop, schaltgruppen.js) gepflegt, nicht über den Geräte-Dialog.
    switchGroupId: row.switch_group_id == null ? null : row.switch_group_id,
  };
}

const COLUMNS = `id, name, group_id, position, switch_topic, remote_topic, status_topic, power_topic,
  power_unit, counter_topic, counter_unit, rated_power, rated_power_unit, priority, use_group_priority,
  always_on, function_key, load_shed_enabled, load_shed_phase, switch_group_id`;

async function listActors(db) {
  const rows = await dbAll(
    db,
    `SELECT ${COLUMNS} FROM mess_schalt_actors ORDER BY position ASC, id ASC`
  );
  return rows.map(normalizeRow);
}

async function getActor(db, id) {
  const row = await dbGet(db, `SELECT ${COLUMNS} FROM mess_schalt_actors WHERE id = ?`, [id]);
  return row ? normalizeRow(row) : null;
}

function normalizeInput(input = {}) {
  return {
    name: String(input.name || '').trim(),
    groupId: parseGroupId(input.groupId),
    switchTopic: normalizeMqttTopic(input.switchTopic || ''),
    remoteTopic: normalizeMqttTopic(input.remoteTopic || ''),
    statusTopic: normalizeMqttTopic(input.statusTopic || ''),
    powerTopic: normalizeMqttTopic(input.powerTopic || ''),
    powerUnit: normalizeUnit(input.powerUnit, POWER_UNITS, 'W'),
    counterTopic: normalizeMqttTopic(input.counterTopic || ''),
    counterUnit: normalizeUnit(input.counterUnit, COUNTER_UNITS, 'kWh'),
    ratedPower: parseRatedPower(input.ratedPower),
    ratedPowerUnit: normalizeUnit(input.ratedPowerUnit, POWER_UNITS, 'W'),
    priority: clampPriority(input.priority, 4),
    // Checkboxen: kommen als 'on'/'1'/'true' oder fehlen ganz.
    useGroupPriority: parseCheckbox(input.useGroupPriority),
    alwaysOn: parseCheckbox(input.alwaysOn),
    functionKey: normalizeFunctionKey(input.functionKey),
    loadShedEnabled: parseCheckbox(input.loadShedEnabled),
    loadShedPhase: normalizeLoadShedPhase(input.loadShedPhase),
  };
}

function parseCheckbox(value) {
  return value === true || ['on', '1', 'true'].includes(String(value || '').toLowerCase());
}

function validateInput(input) {
  const errors = [];
  if (!input.name) errors.push('Bitte einen Namen für das Gerät eingeben.');
  if (!input.switchTopic && !input.powerTopic && !input.counterTopic) {
    errors.push('Bitte mindestens ein Topic für Schalten, Leistung oder Zähler angeben.');
  }
  if (input.useGroupPriority && input.groupId == null) {
    errors.push('„Priorität der Gruppe verwenden" erfordert die Zuordnung zu einer Gruppe.');
  }
  if (input.loadShedEnabled && !input.switchTopic) {
    errors.push('„Zum Lastabwurf verwenden" erfordert ein Schalten-Topic.');
  }
  if (input.remoteTopic && !input.switchTopic) {
    errors.push('„Remote-Topic“ erfordert ein Schalten-Topic.');
  }
  return errors;
}

function throwIfInvalid(input) {
  const errors = validateInput(input);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validation = true;
    throw error;
  }
}

async function nextPosition(db) {
  const row = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM mess_schalt_actors');
  return row ? row.pos : 0;
}

async function createActor(db, rawInput) {
  const input = normalizeInput(rawInput);
  throwIfInvalid(input);
  const position = await nextPosition(db);
  const result = await dbRun(
    db,
    `INSERT INTO mess_schalt_actors
      (name, group_id, position, switch_topic, remote_topic, status_topic, power_topic, power_unit,
       counter_topic, counter_unit, rated_power, rated_power_unit, priority, use_group_priority,
       always_on, function_key, load_shed_enabled, load_shed_phase, desired_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      input.name, input.groupId, position, input.switchTopic, input.remoteTopic, input.statusTopic,
      input.powerTopic, input.powerUnit, input.counterTopic, input.counterUnit,
      input.ratedPower, input.ratedPowerUnit,
      input.priority, input.useGroupPriority ? 1 : 0, input.alwaysOn ? 1 : 0,
      input.functionKey, input.loadShedEnabled ? 1 : 0, input.loadShedPhase,
    ]
  );
  // Interner Zählerstand startet bei 0 und ohne Baseline: Der erste Rohwert des
  // Zähler-Topics basiert nur neu und darf nicht als Sprung in den Zähler eingehen.
  await dbRun(
    db,
    `INSERT INTO mess_schalt_actor_state (actor_id, last_counter_raw, last_progress_ts, derived_power_w, counter_total_kwh)
     VALUES (?, NULL, NULL, NULL, 0)`,
    [result.lastID]
  );
  return getActor(db, result.lastID);
}

async function updateActor(db, id, rawInput) {
  const input = normalizeInput(rawInput);
  throwIfInvalid(input);
  const previous = await getActor(db, id);
  await dbRun(
    db,
    `UPDATE mess_schalt_actors SET
       name = ?, group_id = ?, switch_topic = ?, remote_topic = ?, status_topic = ?, power_topic = ?,
       power_unit = ?, counter_topic = ?, counter_unit = ?, rated_power = ?, rated_power_unit = ?,
       priority = ?, use_group_priority = ?, always_on = ?, function_key = ?, load_shed_enabled = ?,
       load_shed_phase = ?
     WHERE id = ?`,
    [
      input.name, input.groupId, input.switchTopic, input.remoteTopic, input.statusTopic, input.powerTopic,
      input.powerUnit, input.counterTopic, input.counterUnit, input.ratedPower, input.ratedPowerUnit,
      input.priority, input.useGroupPriority ? 1 : 0, input.alwaysOn ? 1 : 0, input.functionKey,
      input.loadShedEnabled ? 1 : 0, input.loadShedPhase, id,
    ]
  );
  // Zähler-Topic oder -Einheit gewechselt: Baseline und Leistungsableitung
  // verwerfen, den internen Zählerstand aber behalten. Der nächste Rohwert
  // basiert dann nur neu, statt als Sprung in den Zähler einzugehen.
  if (previous && (previous.counterTopic !== input.counterTopic || previous.counterUnit !== input.counterUnit)) {
    await dbRun(
      db,
      `INSERT INTO mess_schalt_actor_state (actor_id, last_counter_raw, last_progress_ts, derived_power_w, counter_total_kwh)
       VALUES (?, NULL, NULL, NULL, 0)
       ON CONFLICT(actor_id) DO UPDATE SET
         last_counter_raw = NULL,
         last_progress_ts = NULL,
         derived_power_w = NULL,
         counter_total_kwh = COALESCE(counter_total_kwh, 0)`,
      [id]
    );
  }
  return getActor(db, id);
}

async function deleteActor(db, id) {
  await dbRun(db, 'DELETE FROM mess_schalt_actor_state WHERE actor_id = ?', [id]);
  await dbRun(db, 'DELETE FROM mess_schalt_actors WHERE id = ?', [id]);
}

// Neue Anordnung aus dem Drag&Drop persistieren: je Gerät Gruppe und Position.
async function reorderActors(db, items) {
  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    const id = Number(item.id);
    if (!Number.isFinite(id)) continue;
    const groupId = parseGroupId(item.groupId);
    const position = Number.isFinite(Number(item.position)) ? Number(item.position) : index;
    await dbRun(db, 'UPDATE mess_schalt_actors SET group_id = ?, position = ? WHERE id = ?', [
      groupId, position, id,
    ]);
  }
}

// Effektive Priorität eines Geräts: übernimmt die Gruppenpriorität, wenn
// „Priorität der Gruppe verwenden" aktiv ist und die Gruppe existiert.
function effectivePriority(actor, groupsById) {
  if (actor.useGroupPriority && actor.groupId != null) {
    const group = groupsById instanceof Map ? groupsById.get(actor.groupId) : (groupsById || {})[actor.groupId];
    if (group && group.priority != null) return group.priority;
  }
  return actor.priority;
}

// Cache-Key-Schema für die abonnierten Read-Topics eines Geräts.
function cacheKey(id, suffix) {
  return `messschalt:${id}:${suffix}`;
}

// MQTT-State-Definitionen für alle lesbaren Topics. Das Schalt-Topic wird zwar
// geschrieben, aber auch abonniert (dient ohne Status-Topic als Ist-Stand).
function buildMessSchaltStateDefinitions(actors) {
  const defs = [];
  for (const actor of actors || []) {
    if (actor.switchTopic) defs.push({ id: cacheKey(actor.id, 'switch'), topic: actor.switchTopic });
    if (actor.remoteTopic) defs.push({ id: cacheKey(actor.id, 'remote'), topic: actor.remoteTopic });
    if (actor.statusTopic) defs.push({ id: cacheKey(actor.id, 'status'), topic: actor.statusTopic });
    if (actor.powerTopic) defs.push({ id: cacheKey(actor.id, 'power'), topic: actor.powerTopic });
    if (actor.counterTopic) defs.push({ id: cacheKey(actor.id, 'counter'), topic: actor.counterTopic });
  }
  return defs;
}

module.exports = {
  POWER_UNITS, COUNTER_UNITS, FUNCTION_KEYS, LOAD_SHED_PHASES,
  listActors, getActor, createActor, updateActor, deleteActor, reorderActors,
  normalizeInput, validateInput, effectivePriority, cacheKey, buildMessSchaltStateDefinitions,
  parseNumber, clampPriority, normalizeFunctionKey, normalizeLoadShedPhase,
};
