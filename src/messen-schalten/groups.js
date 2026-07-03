'use strict';

// CRUD für Messen-+-Schalten-Gruppen (Vorbild: dashboard/groups.js). Eine Gruppe
// ist ein benannter Container mit einer Priorität (1–5), die zugeordnete Geräte
// optional übernehmen (Checkbox „Priorität der Gruppe verwenden"). Gruppen lassen
// sich untereinander anordnen (position) und bilden die Verbrauchssummen ihrer
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
  };
}

async function listGroups(db) {
  const rows = await dbAll(
    db,
    'SELECT id, title, priority, position, function_key FROM mess_schalt_groups ORDER BY position ASC, id ASC'
  );
  return rows.map(normalizeGroupRow);
}

async function getGroup(db, id) {
  const row = await dbGet(
    db,
    'SELECT id, title, priority, position, function_key FROM mess_schalt_groups WHERE id = ?',
    [id]
  );
  return row ? normalizeGroupRow(row) : null;
}

function normalizeGroupInput(input = {}) {
  return {
    title: String(input.title || '').trim(),
    priority: clampPriority(input.priority, 4),
    functionKey: normalizeFunctionKey(input.functionKey),
  };
}

function ensureTitle(group) {
  if (!group.title) {
    const error = new Error('Bitte einen Titel für die Gruppe eingeben.');
    error.validation = true;
    throw error;
  }
}

async function nextPosition(db) {
  const row = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM mess_schalt_groups');
  return row ? row.pos : 0;
}

async function createGroup(db, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  const position = await nextPosition(db);
  const result = await dbRun(
    db,
    'INSERT INTO mess_schalt_groups (title, priority, position, function_key) VALUES (?, ?, ?, ?)',
    [group.title, group.priority, position, group.functionKey]
  );
  return getGroup(db, result.lastID);
}

async function updateGroup(db, id, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  await dbRun(db, 'UPDATE mess_schalt_groups SET title = ?, priority = ?, function_key = ? WHERE id = ?', [
    group.title,
    group.priority,
    group.functionKey,
    id,
  ]);
  return getGroup(db, id);
}

// Gruppe löschen: enthaltene Geräte werden wieder zu freien (gruppenlosen) Geräten.
async function deleteGroup(db, id) {
  await dbRun(db, 'UPDATE mess_schalt_actors SET group_id = NULL WHERE group_id = ?', [id]);
  await dbRun(db, 'DELETE FROM mess_schalt_groups WHERE id = ?', [id]);
}

async function reorderGroups(db, items) {
  for (let index = 0; index < (items || []).length; index += 1) {
    const id = Number(items[index].id);
    if (!Number.isFinite(id)) continue;
    const position = Number.isFinite(Number(items[index].position)) ? Number(items[index].position) : index;
    await dbRun(db, 'UPDATE mess_schalt_groups SET position = ? WHERE id = ?', [position, id]);
  }
}

module.exports = {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  clampPriority,
};
