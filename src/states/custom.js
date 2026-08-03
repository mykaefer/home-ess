'use strict';

// Persistente, frei verwendbare homeESS-States unter custom://<ordner>/<name>.
// Der Anzeigename bildet zugleich das lesbare Topic-Segment; reservierte URL-
// Zeichen werden kodiert, damit auch Leerzeichen/Umlaute sicher adressierbar sind.

const adapterRouter = require('../adapters/router');
const bus = require('../state-bus');

const TYPES = new Set(['boolean', 'integer', 'float', 'text', 'json']);
const ROUNDINGS = new Set(['nearest', 'floor', 'ceil', 'trunc']);
let activeDb = null;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function done(err) {
    if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function cleanName(value) {
  const name = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Bitte einen Namen angeben.');
  if (name.length > 100) throw new Error('Der Name darf höchstens 100 Zeichen lang sein.');
  if (name.includes('/')) throw new Error('Der Name darf keinen Schrägstrich enthalten.');
  return name;
}
function segment(name) { return encodeURIComponent(String(name)); }
function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function roundNumber(value, decimals, rounding) {
  if (decimals == null) return value;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const fn = rounding === 'floor' ? Math.floor
    : rounding === 'ceil' ? Math.ceil
      : rounding === 'trunc' ? Math.trunc : Math.round;
  return fn(scaled + (rounding === 'nearest' ? Number.EPSILON : 0)) / factor;
}

function normalizeDefinition(input = {}) {
  const dataType = TYPES.has(String(input.dataType)) ? String(input.dataType) : 'text';
  const unit = String(input.unit || '').trim().slice(0, 24);
  const rawDecimals = input.decimals === '' || input.decimals == null ? null : Number(input.decimals);
  const decimals = dataType === 'float' && Number.isInteger(rawDecimals) && rawDecimals >= 0 && rawDecimals <= 12
    ? rawDecimals : null;
  const rounding = ROUNDINGS.has(String(input.rounding)) ? String(input.rounding) : 'nearest';
  return { name: cleanName(input.name), dataType, unit, decimals, rounding };
}

function coerceValue(raw, definition) {
  const type = definition.dataType;
  if (type === 'boolean') {
    if (raw === true || raw === 1) return true;
    if (raw === false || raw === 0) return false;
    const value = String(raw == null ? '' : raw).trim().toLowerCase();
    if (['true', '1', 'on', 'an', 'ja', 'yes'].includes(value)) return true;
    if (['false', '0', 'off', 'aus', 'nein', 'no'].includes(value)) return false;
    throw new Error('Boolean-Werte müssen true/false, 1/0 oder an/aus sein.');
  }
  if (type === 'integer') {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isSafeInteger(value)) throw new Error('Bitte eine ganze Zahl im sicheren Zahlenbereich angeben.');
    return value;
  }
  if (type === 'float') {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
    if (!Number.isFinite(value)) throw new Error('Bitte eine gültige Fließkommazahl angeben.');
    return roundNumber(value, definition.decimals, definition.rounding);
  }
  if (type === 'json') {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (_) { throw new Error('Bitte gültiges JSON angeben.'); }
    }
    if (raw !== undefined) return raw;
    throw new Error('Bitte gültiges JSON angeben.');
  }
  return String(raw == null ? '' : raw).slice(0, 10000);
}

function parseStored(row) {
  try { return JSON.parse(row.value_json); } catch (_) { return row.data_type === 'text' ? String(row.value_json || '') : null; }
}
function formatValue(value, row) {
  if (value == null) return '—';
  let display;
  if (row.data_type === 'boolean') display = value ? 'Ein' : 'Aus';
  else if (row.data_type === 'json') display = JSON.stringify(value);
  else if (row.data_type === 'float' && row.decimals != null) display = Number(value).toFixed(row.decimals).replace('.', ',');
  else display = String(value);
  return row.unit ? `${display} ${row.unit}` : display;
}

async function rowsWithPaths(db) {
  const [folders, states] = await Promise.all([
    dbAll(db, 'SELECT id, parent_id, name, position FROM custom_state_folders ORDER BY position, name COLLATE NOCASE'),
    dbAll(db, 'SELECT id, folder_id, name, data_type, unit, decimals, rounding, value_json, position, updated_at FROM custom_states ORDER BY position, name COLLATE NOCASE'),
  ]);
  const folderById = new Map(folders.map((row) => [row.id, row]));
  const folderPath = (id) => {
    const names = []; const seen = new Set(); let cursor = id;
    while (cursor != null && folderById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); const folder = folderById.get(cursor); names.unshift(folder.name); cursor = folder.parent_id;
    }
    return names;
  };
  return {
    folders: folders.map((row) => ({ id: row.id, parentId: row.parent_id, name: row.name, position: row.position, path: folderPath(row.id) })),
    states: states.map((row) => {
      const path = [...folderPath(row.folder_id), row.name];
      const topic = `custom://${path.map(segment).join('/')}`;
      const value = parseStored(row);
      return { id: row.id, folderId: row.folder_id, name: row.name, dataType: row.data_type, unit: row.unit,
        decimals: row.decimals, rounding: row.rounding, value, valueInput: row.data_type === 'json' ? JSON.stringify(value) : String(value == null ? '' : value),
        position: row.position, updatedAt: row.updated_at, path, topic, display: formatValue(value, row) };
    }),
  };
}

async function init(db) {
  activeDb = db;
  adapterRouter.registerVirtualScheme('custom', {
    write: (path, value) => writeByPath(path, value).catch(() => {}),
    read: (path) => publishByPath(path).catch(() => {}),
  });
  const data = await rowsWithPaths(db);
  for (const state of data.states) adapterRouter.ingestTopic(state.topic, state.value, state.updatedAt || Date.now());
}

async function findByPath(db, rawPath) {
  const names = String(rawPath || '').split('/').filter(Boolean).map(decodeSegment);
  if (!names.length) return null;
  const data = await rowsWithPaths(db);
  return data.states.find((state) => state.path.length === names.length && state.path.every((part, i) => part === names[i])) || null;
}
async function publishByPath(path) {
  if (!activeDb) return false;
  const state = await findByPath(activeDb, path);
  if (!state) return false;
  adapterRouter.ingestTopic(state.topic, state.value, state.updatedAt || Date.now());
  return true;
}
async function writeByPath(path, rawValue) {
  if (!activeDb) return false;
  const state = await findByPath(activeDb, path);
  if (!state) return false;
  return setValue(activeDb, state.id, rawValue);
}
async function setValue(db, id, rawValue) {
  const row = await dbGet(db, 'SELECT * FROM custom_states WHERE id = ?', [Number(id)]);
  if (!row) throw new Error('Custom State nicht gefunden.');
  const definition = { dataType: row.data_type, decimals: row.decimals, rounding: row.rounding };
  const value = coerceValue(rawValue, definition);
  const updatedAt = Date.now();
  await dbRun(db, 'UPDATE custom_states SET value_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(value), updatedAt, row.id]);
  const state = (await rowsWithPaths(db)).states.find((item) => item.id === row.id);
  if (state) adapterRouter.ingestTopic(state.topic, value, updatedAt);
  return state;
}

async function addFolder(db, input) {
  const name = cleanName(input.name);
  const parentId = input.parentId === '' || input.parentId == null ? null : Number(input.parentId);
  if (parentId != null && !(await dbGet(db, 'SELECT id FROM custom_state_folders WHERE id = ?', [parentId]))) throw new Error('Zielverzeichnis nicht gefunden.');
  try { return await dbRun(db, 'INSERT INTO custom_state_folders (parent_id, name) VALUES (?, ?)', [parentId, name]); }
  catch (err) { if (err && err.code === 'SQLITE_CONSTRAINT') throw new Error('In diesem Verzeichnis gibt es den Namen bereits.'); throw err; }
}
async function updateFolder(db, id, input) {
  const name = cleanName(input.name);
  const before = await rowsWithPaths(db);
  try { await dbRun(db, 'UPDATE custom_state_folders SET name = ? WHERE id = ?', [name, Number(id)]); }
  catch (err) { if (err && err.code === 'SQLITE_CONSTRAINT') throw new Error('In diesem Verzeichnis gibt es den Namen bereits.'); throw err; }
  // Ein Ordnername ist Teil aller Topics seines Unterbaums. Neue kanonische
  // Keys sofort bereitstellen und die alten Cache-Keys nicht als Geisterwerte
  // stehen lassen.
  const after = await rowsWithPaths(db);
  const oldById = new Map(before.states.map((state) => [state.id, state]));
  for (const state of after.states) {
    const old = oldById.get(state.id);
    if (old && old.topic !== state.topic) {
      bus.remove(old.topic);
      adapterRouter.ingestTopic(state.topic, state.value, state.updatedAt || Date.now());
    }
  }
}
async function descendantFolderIds(db, id) {
  const rows = await dbAll(db, `WITH RECURSIVE tree(id) AS (SELECT id FROM custom_state_folders WHERE id = ? UNION ALL SELECT f.id FROM custom_state_folders f JOIN tree t ON f.parent_id = t.id) SELECT id FROM tree`, [Number(id)]);
  return rows.map((row) => row.id);
}
async function deleteFolder(db, id) {
  const ids = await descendantFolderIds(db, id);
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  const old = await rowsWithPaths(db);
  await dbRun(db, `DELETE FROM custom_states WHERE folder_id IN (${marks})`, ids);
  await dbRun(db, `DELETE FROM custom_state_folders WHERE id IN (${marks})`, ids);
  for (const state of old.states.filter((item) => ids.includes(item.folderId))) bus.remove(state.topic);
}
async function addState(db, input) {
  const def = normalizeDefinition(input);
  const folderId = input.folderId === '' || input.folderId == null ? null : Number(input.folderId);
  if (folderId != null && !(await dbGet(db, 'SELECT id FROM custom_state_folders WHERE id = ?', [folderId]))) throw new Error('Zielverzeichnis nicht gefunden.');
  const value = coerceValue(input.value, def);
  try {
    const result = await dbRun(db, `INSERT INTO custom_states (folder_id, name, data_type, unit, decimals, rounding, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [folderId, def.name, def.dataType, def.unit, def.decimals, def.rounding, JSON.stringify(value), Date.now()]);
    const state = (await rowsWithPaths(db)).states.find((item) => item.id === result.id);
    if (state) adapterRouter.ingestTopic(state.topic, state.value, state.updatedAt);
    return state;
  } catch (err) { if (err && err.code === 'SQLITE_CONSTRAINT') throw new Error('In diesem Verzeichnis gibt es den Namen bereits.'); throw err; }
}
async function updateState(db, id, input) {
  const oldData = await rowsWithPaths(db);
  const old = oldData.states.find((item) => item.id === Number(id));
  if (!old) throw new Error('Custom State nicht gefunden.');
  const def = normalizeDefinition(input);
  const folderId = input.folderId === '' || input.folderId == null ? null : Number(input.folderId);
  const value = coerceValue(input.value, def);
  try {
    await dbRun(db, `UPDATE custom_states SET folder_id = ?, name = ?, data_type = ?, unit = ?, decimals = ?, rounding = ?, value_json = ?, updated_at = ? WHERE id = ?`,
      [folderId, def.name, def.dataType, def.unit, def.decimals, def.rounding, JSON.stringify(value), Date.now(), Number(id)]);
  } catch (err) { if (err && err.code === 'SQLITE_CONSTRAINT') throw new Error('In diesem Verzeichnis gibt es den Namen bereits.'); throw err; }
  const state = (await rowsWithPaths(db)).states.find((item) => item.id === Number(id));
  if (old.topic !== state.topic) bus.remove(old.topic);
  adapterRouter.ingestTopic(state.topic, state.value, state.updatedAt);
  return state;
}
async function deleteState(db, id) {
  const data = await rowsWithPaths(db); const old = data.states.find((item) => item.id === Number(id));
  await dbRun(db, 'DELETE FROM custom_states WHERE id = ?', [Number(id)]);
  if (old) bus.remove(old.topic);
}

function buildTree(data) {
  const byParent = new Map();
  for (const folder of data.folders) {
    const key = folder.parentId == null ? 'root' : folder.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push({ ...folder, folders: [], states: [] });
  }
  const nodeById = new Map();
  for (const nodes of byParent.values()) for (const node of nodes) nodeById.set(node.id, node);
  for (const node of nodeById.values()) node.folders = byParent.get(node.id) || [];
  const rootStates = [];
  for (const state of data.states) {
    const node = nodeById.get(state.folderId);
    if (node) node.states.push(state); else rootStates.push(state);
  }
  const count = (node) => node.states.length + node.folders.reduce((sum, child) => sum + count(child), 0);
  for (const node of nodeById.values()) node.stateCount = count(node);
  return { folders: byParent.get('root') || [], states: rootStates };
}

async function managementTree(db) { return buildTree(await rowsWithPaths(db)); }

async function buildStatesBlock(db) {
  const data = await rowsWithPaths(db);
  const tree = buildTree(data);
  const mapFolder = (folder) => ({
    name: folder.name,
    states: folder.states.map(mapState),
    children: folder.folders.map(mapFolder),
    stateCount: folder.stateCount,
  });
  function mapState(state) {
    return { address: state.path.join('/'), name: state.name, topic: state.topic, unit: state.unit,
      writable: true, topicSelectable: true, sourceType: 'custom', value: state.value, display: state.display };
  }
  const categories = tree.folders.map(mapFolder);
  if (tree.states.length) categories.unshift({ name: 'Ohne Verzeichnis', states: tree.states.map(mapState), children: [], stateCount: tree.states.length });
  return {
    instanceId: 'custom', instanceName: '', adapterId: null, adapterName: 'custom://', prefix: 'custom',
    enabled: true, running: true, virtual: true, custom: true, sourceType: 'custom', categories,
  };
}

async function listCatalogEntries(db) {
  const data = await rowsWithPaths(db);
  return data.states.map((state) => ({ id: state.topic, label: state.name, value: state.value, display: state.display,
    unit: state.unit, category: `Custom / ${state.path.length > 1 ? state.path.slice(0, -1).join(' / ') : 'Ohne Verzeichnis'}`,
    sourceType: 'custom', writable: true, topicSelectable: true }));
}

module.exports = { init, rowsWithPaths, addFolder, updateFolder, deleteFolder, addState, updateState, deleteState, setValue,
  coerceValue, normalizeDefinition, formatValue, managementTree, buildStatesBlock, listCatalogEntries, TYPES, ROUNDINGS };
