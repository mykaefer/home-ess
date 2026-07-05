'use strict';

// CRUD der Schaltgruppen (Unterseite von Messen + Schalten). Eine Schaltgruppe
// ist ein benannter Container für Geräte (Aktoren), deren gemeinsamer
// Schaltzustand sich aus den Mitgliedern ableitet: an, sobald ein Gerät an ist;
// aus erst, wenn alle Geräte aus sind. Das optionale Remote-Topic hält den
// Zustand bidirektional synchron; „Gruppe schaltet als Einheit" zieht
// Schaltflanken auf alle Mitglieder. Ein optionaler Timer schaltet die gesamte
// Gruppe nach der konfigurierten Laufzeit wieder aus. Der Zustand jeder
// Gruppe steht als beschreibbarer State (schaltgruppe://gruppen/<id>) in der
// States-Liste und damit automatisch im Wertekatalog und State-Picker.

const { normalizeMqttTopic } = require('../mqtt/topics');

// Virtuelle States-Instanz: Schema + Instanzname der Schaltgruppen-Topics.
const SCHEME = 'schaltgruppe';
const INSTANCE = 'gruppen';

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
    remoteTopic: row.remote_topic || '',
    switchAsUnit: Number(row.switch_as_unit) === 1,
    timerMinutes: Math.max(0, Number(row.timer_minutes) || 0),
  };
}

// Feste alphanumerische Sortierung nach Name (wie die Verbrauchsgruppen).
async function listSwitchGroups(db) {
  const rows = await dbAll(db, 'SELECT id, name, remote_topic, switch_as_unit, timer_minutes FROM mess_schalt_switch_groups');
  return rows
    .map(normalizeRow)
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' }) || a.id - b.id);
}

async function getSwitchGroup(db, id) {
  const row = await dbGet(db, 'SELECT id, name, remote_topic, switch_as_unit, timer_minutes FROM mess_schalt_switch_groups WHERE id = ?', [id]);
  return row ? normalizeRow(row) : null;
}

function normalizeInput(input = {}) {
  const rawTimer = Number(String(input.timerMinutes == null ? '' : input.timerMinutes).replace(',', '.'));
  return {
    name: String(input.name || '').trim(),
    remoteTopic: normalizeMqttTopic(input.remoteTopic || ''),
    switchAsUnit: input.switchAsUnit === true || ['on', '1', 'true'].includes(String(input.switchAsUnit || '').toLowerCase()),
    timerMinutes: Number.isFinite(rawTimer) && rawTimer > 0 ? Math.min(rawTimer, 525600) : 0,
  };
}

function ensureName(group) {
  if (!group.name) {
    const error = new Error('Bitte einen Namen für die Schaltgruppe eingeben.');
    error.validation = true;
    throw error;
  }
}

async function createSwitchGroup(db, rawInput) {
  const group = normalizeInput(rawInput);
  ensureName(group);
  const result = await dbRun(
    db,
    'INSERT INTO mess_schalt_switch_groups (name, remote_topic, switch_as_unit, timer_minutes) VALUES (?, ?, ?, ?)',
    [group.name, group.remoteTopic, group.switchAsUnit ? 1 : 0, group.timerMinutes]
  );
  return getSwitchGroup(db, result.lastID);
}

async function updateSwitchGroup(db, id, rawInput) {
  const group = normalizeInput(rawInput);
  ensureName(group);
  await dbRun(db, 'UPDATE mess_schalt_switch_groups SET name = ?, remote_topic = ?, switch_as_unit = ?, timer_minutes = ? WHERE id = ?', [
    group.name, group.remoteTopic, group.switchAsUnit ? 1 : 0, group.timerMinutes, id,
  ]);
  return getSwitchGroup(db, id);
}

// Gruppe löschen: zugeordnete Geräte werden wieder zu freien Geräten.
async function deleteSwitchGroup(db, id) {
  await dbRun(db, 'UPDATE mess_schalt_actors SET switch_group_id = NULL WHERE switch_group_id = ?', [id]);
  await dbRun(db, 'DELETE FROM mess_schalt_switch_groups WHERE id = ?', [id]);
}

// Drag&Drop-Zuordnung: ein Gerät einer Schaltgruppe zuordnen (oder mit null lösen).
async function assignActorToSwitchGroup(db, actorId, groupId) {
  const id = Number(actorId);
  if (!Number.isFinite(id)) return;
  const parsed = groupId == null || groupId === '' || groupId === 'null' ? null : Number(groupId);
  await dbRun(db, 'UPDATE mess_schalt_actors SET switch_group_id = ? WHERE id = ?', [
    parsed != null && Number.isFinite(parsed) ? parsed : null, id,
  ]);
}

// Cache-Schlüssel des abonnierten Remote-Topics einer Gruppe.
function remoteCacheKey(id) {
  return `schaltgruppe:${id}:remote`;
}

// Kanonisches Scheme-Topic des Gruppen-Schaltzustands. Über dieses Topic ist der
// Zustand lesbar (State-Bus) und beschreibbar (Einschalten = alle Geräte ein).
function stateTopic(id) {
  return `${SCHEME}://${INSTANCE}/${id}`;
}

// MQTT-State-Definitionen der konfigurierten Remote-Topics (bidirektionaler Sync).
function buildSchaltgruppenStateDefinitions(groups) {
  const defs = [];
  for (const group of groups || []) {
    if (group.remoteTopic) defs.push({ id: remoteCacheKey(group.id), topic: group.remoteTopic });
  }
  return defs;
}

// Block für die States-Liste (Form wie eine Adapter-Instanz aus buildStatesTree):
// Kategorie „Schaltgruppen" mit dem Schaltzustand jeder Gruppe. Erscheint dadurch
// automatisch auf der States-Seite, im State-Picker und im Wertekatalog.
async function buildSchaltgruppenStatesBlock(db, cache) {
  const groups = await listSwitchGroups(db);
  if (!groups.length) return null;
  const states = groups.map((group) => {
    const topic = stateTopic(group.id);
    const cached = cache.get(topic);
    const on = cached != null && (cached.value === 1 || cached.value === '1' || cached.value === true || cached.value === 'true');
    return {
      address: String(group.id),
      name: group.name,
      catalogLabel: `Schaltgruppe ${group.name} – Schaltzustand`,
      topic,
      unit: '',
      writable: true,
      value: cached == null ? null : (on ? 1 : 0),
      display: cached == null ? '—' : (on ? 'Ein' : 'Aus'),
    };
  });
  return {
    instanceId: 'schaltgruppen',
    instanceName: INSTANCE,
    adapterId: null,
    adapterName: 'Schaltgruppen',
    prefix: SCHEME,
    enabled: true,
    running: true,
    virtual: true,
    categories: [{ name: 'Schaltgruppen', states, children: [], stateCount: states.length }],
  };
}

module.exports = {
  SCHEME, INSTANCE,
  listSwitchGroups, getSwitchGroup, createSwitchGroup, updateSwitchGroup, deleteSwitchGroup,
  assignActorToSwitchGroup, normalizeInput,
  remoteCacheKey, stateTopic, buildSchaltgruppenStateDefinitions, buildSchaltgruppenStatesBlock,
};
