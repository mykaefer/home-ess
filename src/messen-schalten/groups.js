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
    // Übergeordnete Gruppe (mehrschichtige Verschachtelung); NULL = oberste Ebene.
    parentId: row.parent_id == null ? null : row.parent_id,
    // Zählergruppe: eigene Geräte sind Zähler → Gesamtverbrauch ist fix; die
    // Untergruppen werden als „Sonstige Verbraucher dieser Gruppe" abgezogen.
    meterGroup: Number(row.meter_group) === 1,
    // Freie Farbe (Hex) für das Energiefluss-Diagramm; leer = Standardfarbe.
    color: normalizeColor(row.color),
  };
}

// Nur #rgb / #rrggbb zulassen (sonst leer = Standardfarbe).
function normalizeColor(value) {
  const text = String(value == null ? '' : value).trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text) ? text.toLowerCase() : '';
}

// Feste alphanumerische Sortierung nach Titel („Heizung 2" vor „Heizung 10").
async function listGroups(db) {
  const rows = await dbAll(
    db,
    'SELECT id, title, priority, position, function_key, offset_total_consumption, parent_id, meter_group, color FROM mess_schalt_groups'
  );
  return rows
    .map(normalizeGroupRow)
    .sort((a, b) => a.title.localeCompare(b.title, 'de', { numeric: true, sensitivity: 'base' }) || a.id - b.id);
}

async function getGroup(db, id) {
  const row = await dbGet(
    db,
    'SELECT id, title, priority, position, function_key, offset_total_consumption, parent_id, meter_group, color FROM mess_schalt_groups WHERE id = ?',
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
    meterGroup: input.meterGroup === true || input.meterGroup === 'on' || input.meterGroup === '1',
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
    'INSERT INTO mess_schalt_groups (title, priority, function_key, offset_total_consumption, meter_group) VALUES (?, ?, ?, ?, ?)',
    [group.title, group.priority, group.functionKey, group.offsetTotalConsumption ? 1 : 0, group.meterGroup ? 1 : 0]
  );
  return getGroup(db, result.lastID);
}

async function updateGroup(db, id, input) {
  const group = normalizeGroupInput(input);
  ensureTitle(group);
  await dbRun(db, 'UPDATE mess_schalt_groups SET title = ?, priority = ?, function_key = ?, offset_total_consumption = ?, meter_group = ? WHERE id = ?', [
    group.title,
    group.priority,
    group.functionKey,
    group.offsetTotalConsumption ? 1 : 0,
    group.meterGroup ? 1 : 0,
    id,
  ]);
  return getGroup(db, id);
}

// Gruppe löschen: enthaltene Geräte werden wieder zu freien (gruppenlosen)
// Geräten. Untergruppen rücken eine Ebene hoch (an den Parent der gelöschten
// Gruppe), damit die Verschachtelung darunter nicht verloren geht.
async function deleteGroup(db, id) {
  const group = await getGroup(db, id);
  const newParent = group ? group.parentId : null;
  await dbRun(db, 'UPDATE mess_schalt_actors SET group_id = NULL WHERE group_id = ?', [id]);
  await dbRun(db, 'UPDATE mess_schalt_groups SET parent_id = ? WHERE parent_id = ?', [newParent, id]);
  await dbRun(db, 'DELETE FROM mess_schalt_groups WHERE id = ?', [id]);
}

// Prüft, ob candidateParent im Ast unter groupId liegt (oder groupId selbst ist).
// Verhindert Zyklen: Eine Gruppe darf nicht in sich selbst oder eine ihrer
// eigenen Untergruppen geschoben werden.
function wouldCreateCycle(groupsById, groupId, candidateParentId) {
  let cursor = candidateParentId;
  const guard = new Set();
  while (cursor != null) {
    if (cursor === groupId) return true;
    if (guard.has(cursor)) break; // defensiv gegen vorhandene Datenzyklen
    guard.add(cursor);
    const parent = groupsById.get(cursor);
    cursor = parent ? parent.parentId : null;
  }
  return false;
}

// Verschachtelung per Drag & Drop: Gruppe unter eine andere hängen (parentId)
// oder mit null auf die oberste Ebene lösen. Zyklen werden abgewiesen.
async function setGroupParent(db, groupId, parentId) {
  const id = Number(groupId);
  if (!Number.isFinite(id)) return;
  const parsed = parentId == null || parentId === '' || parentId === 'null' ? null : Number(parentId);
  const parent = parsed != null && Number.isFinite(parsed) ? parsed : null;
  if (parent === id) return; // Gruppe kann nicht ihr eigener Parent sein.
  const groups = await listGroups(db);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  if (!groupsById.has(id)) return;
  if (parent != null && !groupsById.has(parent)) return;
  if (parent != null && wouldCreateCycle(groupsById, id, parent)) {
    const error = new Error('Eine Gruppe kann nicht in eine ihrer eigenen Untergruppen verschoben werden.');
    error.validation = true;
    throw error;
  }
  await dbRun(db, 'UPDATE mess_schalt_groups SET parent_id = ? WHERE id = ?', [parent, id]);
}

// Freie Gruppenfarbe setzen (leer = Standardfarbe). Wird über den Colorpicker
// im Energiefluss-Diagramm gepflegt.
async function setGroupColor(db, groupId, color) {
  const id = Number(groupId);
  if (!Number.isFinite(id)) return;
  await dbRun(db, 'UPDATE mess_schalt_groups SET color = ? WHERE id = ?', [normalizeColor(color), id]);
}

module.exports = {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  setGroupParent,
  setGroupColor,
  normalizeColor,
  wouldCreateCycle,
  clampPriority,
};
