'use strict';

// CRUD für Dashboard-Gruppen. Eine Gruppe ist ein benannter Container mit einer
// Breite (voll/halb/viertel), in den Widgets per Drag&Drop einsortiert werden.
// Gruppen lassen sich zudem untereinander/nebeneinander anordnen (position).

const GROUP_WIDTHS = [
  { value: 'full', label: 'Voll' },
  { value: 'half', label: 'Halb' },
  { value: 'quarter', label: 'Viertel' },
];
const GROUP_WIDTH_VALUES = new Set(GROUP_WIDTHS.map((entry) => entry.value));

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

function normalizeWidth(value) {
  const width = String(value || '').trim();
  return GROUP_WIDTH_VALUES.has(width) ? width : 'full';
}

function parseTabId(value) {
  if (value == null || value === '' || value === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGroupRow(row = {}) {
  return {
    id: row.id,
    title: row.title || '',
    width: normalizeWidth(row.width),
    position: row.position == null ? 0 : row.position,
    tabId: row.tab_id == null ? null : row.tab_id,
  };
}

async function listGroups(db) {
  const rows = await dbAll(
    db,
    'SELECT id, title, width, position, tab_id FROM dashboard_groups ORDER BY position ASC, id ASC'
  );
  return rows.map(normalizeGroupRow);
}

async function getGroup(db, id) {
  const row = await dbGet(db, 'SELECT id, title, width, position, tab_id FROM dashboard_groups WHERE id = ?', [id]);
  return row ? normalizeGroupRow(row) : null;
}

function normalizeGroupInput(input = {}) {
  return {
    title: String(input.title || '').trim(),
    width: normalizeWidth(input.width),
    tabId: parseTabId(input.tabId),
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
  const row = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM dashboard_groups');
  return row ? row.pos : 0;
}

async function createGroup(db, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  const position = await nextPosition(db);
  const result = await dbRun(
    db,
    'INSERT INTO dashboard_groups (title, width, position, tab_id) VALUES (?, ?, ?, ?)',
    [group.title, group.width, position, group.tabId]
  );
  return getGroup(db, result.lastID);
}

async function updateGroup(db, id, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  await dbRun(db, 'UPDATE dashboard_groups SET title = ?, width = ?, tab_id = ? WHERE id = ?', [
    group.title,
    group.width,
    group.tabId,
    id,
  ]);
  return getGroup(db, id);
}

// Gruppe löschen: enthaltene Widgets werden wieder zu freien Dashboard-Widgets
// auf dem Tab der gelöschten Gruppe (keine Inhalte verlieren).
async function deleteGroup(db, id) {
  const group = await getGroup(db, id);
  await dbRun(db, 'UPDATE dashboard_widgets SET group_id = NULL, tab_id = ? WHERE group_id = ?', [
    group ? group.tabId : null,
    id,
  ]);
  await dbRun(db, 'DELETE FROM dashboard_groups WHERE id = ?', [id]);
}

async function reorderGroups(db, items) {
  for (let index = 0; index < (items || []).length; index += 1) {
    const id = Number(items[index].id);
    if (!Number.isFinite(id)) continue;
    const position = Number.isFinite(Number(items[index].position)) ? Number(items[index].position) : index;
    await dbRun(db, 'UPDATE dashboard_groups SET position = ? WHERE id = ?', [position, id]);
  }
}

module.exports = {
  GROUP_WIDTHS,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
};
