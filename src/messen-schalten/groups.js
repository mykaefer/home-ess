'use strict';

// CRUD für Messen-+-Schalten-Gruppen (Vorbild: dashboard/groups.js). Eine Gruppe
// ist ein benannter Container mit einer Priorität (1–5), die zugeordnete Geräte
// optional übernehmen (Checkbox „Priorität der Gruppe verwenden"). Gruppen sind
// fest alphanumerisch nach Titel sortiert und bilden die Verbrauchssummen ihrer
// Geräte. Die optionale Funktion (Licht, Waschen, …) vererbt sich auf Geräte
// ohne eigene Funktionszuordnung.

const { normalizeFunctionKey } = require('./actors');

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

function clampPriority(value, fallback) {
  const parsed = Number(String(value == null ? '' : value).trim().replace(',', '.'));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function normalizeGroupRow(row = {}) {
  return {
    id: row.id,
    title: row.title || '',
    priority: clampPriority(row.priority, 4),
    position: row.position == null ? 0 : row.position,
    // Geräte ohne eigene Funktion übernehmen die Funktion ihrer Gruppe.
    functionKey: normalizeFunctionKey(row.function_key),
    // Bestehende Gruppen werden durch den DB-Default weiterhin verrechnet.
    offsetTotalConsumption: row.offset_total_consumption !== 0,
  };
}

// Feste alphanumerische Sortierung nach Titel („Heizung 2" vor „Heizung 10").
async function listGroups(db) {
  const rows = await dbAll(
    db,
    'SELECT id, title, priority, position, function_key, offset_total_consumption FROM mess_schalt_groups'
  );
  return rows
    .map(normalizeGroupRow)
    .sort((a, b) => a.title.localeCompare(b.title, 'de', { numeric: true, sensitivity: 'base' }) || a.id - b.id);
}

async function getGroup(db, id) {
  const row = await dbGet(
    db,
    'SELECT id, title, priority, position, function_key, offset_total_consumption FROM mess_schalt_groups WHERE id = ?',
    [id]
  );
  return row ? normalizeGroupRow(row) : null;
}

function normalizeGroupInput(input = {}) {
  const hasOffsetSetting = Object.prototype.hasOwnProperty.call(input, 'offsetTotalConsumption');
  return {
    title: String(input.title || '').trim(),
    priority: clampPriority(input.priority, 4),
    functionKey: normalizeFunctionKey(input.functionKey),
    offsetTotalConsumption: !hasOffsetSetting || input.offsetTotalConsumption === true || input.offsetTotalConsumption === 'on' || input.offsetTotalConsumption === '1',
  };
}

function ensureTitle(group) {
  if (!group.title) {
    const error = new Error('Bitte einen Titel für die Gruppe eingeben.');
    error.validation = true;
    throw error;
  }
}

async function createGroup(db, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  const result = await dbRun(
    db,
    'INSERT INTO mess_schalt_groups (title, priority, function_key, offset_total_consumption) VALUES (?, ?, ?, ?)',
    [group.title, group.priority, group.functionKey, group.offsetTotalConsumption ? 1 : 0]
  );
  return getGroup(db, result.lastID);
}

async function updateGroup(db, id, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  await dbRun(db, 'UPDATE mess_schalt_groups SET title = ?, priority = ?, function_key = ?, offset_total_consumption = ? WHERE id = ?', [
    group.title,
    group.priority,
    group.functionKey,
    group.offsetTotalConsumption ? 1 : 0,
    id,
  ]);
  return getGroup(db, id);
}

// Gruppe löschen: enthaltene Geräte werden wieder zu freien (gruppenlosen) Geräten.
async function deleteGroup(db, id) {
  await dbRun(db, 'UPDATE mess_schalt_actors SET group_id = NULL WHERE group_id = ?', [id]);
  await dbRun(db, 'DELETE FROM mess_schalt_groups WHERE id = ?', [id]);
}

module.exports = {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  clampPriority,
};
