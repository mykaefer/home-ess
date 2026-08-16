'use strict';

// Aktionsfolgen eines Heimkino-Raums. Je Raum gibt es zwei Folgen: „an" und
// „aus". Sie werden bei jeder Änderung des Kinomodus der Reihe nach abgearbeitet
// (heimkino/runtime.js).
//
// Aktionsarten:
//   write – wie das „Dann" der Bedingungen: einem State einen festen Wert oder
//           den Wert eines anderen Topics zuweisen (inkl. Rechenfunktion).
//   pause – hält die Folge für die angegebene Zeit an.
//   loop  – Container, der weitere Aktionen (auch Schleifen) enthält und sie
//           mehrfach durchläuft. Optional prüft er zusätzlich in festem Abstand
//           eine Bedingung; trifft sie nicht zu, wird nur diese Schleife erneut
//           abgespult (Plausibilitätsprüfung).

const conditions = require('../conditions/repository');

const TYPES = new Set(['write', 'pause', 'loop']);
const PHASES = new Set(['on', 'off']);
const MAX_PAUSE_SECONDS = 86400;
const MAX_REPEATS = 1000;
const MIN_CHECK_SECONDS = 5;
const MAX_CHECK_SECONDS = 86400;

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

function validation(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

// Formulare senden zu einer Checkbox zusätzlich ein verstecktes „0"-Feld;
// maßgeblich ist dann der letzte Wert (wie bei den Bedingungen).
function booleanValue(value, fallback = false) {
  if (Array.isArray(value)) return value.length ? booleanValue(value[value.length - 1], fallback) : fallback;
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return !['', '0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

function decimal(value) {
  const raw = String(value == null ? '' : value).trim().replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function cleanPhase(value) {
  const phase = String(value == null ? '' : value).trim().toLowerCase();
  if (!PHASES.has(phase)) throw validation('Die Aktionsfolge ist ungültig.');
  return phase;
}

function pauseSeconds(value) {
  const seconds = decimal(value);
  if (seconds == null || seconds <= 0 || seconds > MAX_PAUSE_SECONDS) {
    throw validation(`Die Pause muss zwischen 0 und ${MAX_PAUSE_SECONDS} Sekunden liegen.`);
  }
  return Math.round(seconds * 10) / 10;
}

function loopConfig(input) {
  const repeats = decimal(input.repeats);
  if (repeats == null || !Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    throw validation(`Die Anzahl der Durchläufe muss zwischen 1 und ${MAX_REPEATS} liegen.`);
  }
  const config = { repeats, checkEnabled: booleanValue(input.checkEnabled, false) };
  if (!config.checkEnabled) return config;
  const interval = decimal(input.checkIntervalSeconds);
  if (interval == null || interval < MIN_CHECK_SECONDS || interval > MAX_CHECK_SECONDS) {
    throw validation(`Der Prüfabstand muss zwischen ${MIN_CHECK_SECONDS} und ${MAX_CHECK_SECONDS} Sekunden liegen.`);
  }
  config.checkIntervalSeconds = Math.round(interval);
  // Die Prüfbedingung ist exakt ein „Wenn" der Bedingungen – gleiche Eingaben,
  // gleiche Validierung, gleicher Vergleich zur Laufzeit.
  config.check = conditions.normalizeItemInput('when', {
    type: 'state', topic: input.checkTopic, operator: input.checkOperator, value: input.checkValue,
  }).config;
  return config;
}

// Vollständige Eingabe einer Aktion prüfen und in ihre gespeicherte Form
// bringen. Die Wert-Zuweisung übernimmt unverändert die Regeln des „Dann".
function normalizeActionInput(input = {}) {
  const type = String(input.type || '').trim().toLowerCase();
  if (!TYPES.has(type)) throw validation('Die Aktionsart ist ungültig.');
  if (type === 'write') return { type, config: conditions.normalizeItemInput('then', { ...input, type: 'write' }).config };
  if (type === 'pause') return { type, config: { seconds: pauseSeconds(input.seconds) } };
  return { type, config: loopConfig(input) };
}

function parseConfig(value) {
  try {
    const config = JSON.parse(value || '{}');
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch (_) { return {}; }
}

function formatSeconds(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number)) return '—';
  return `${number.toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
}

function describeAction(action) {
  const config = action.config || {};
  if (action.type === 'write') return conditions.describeItem({ kind: 'then', type: 'write', config });
  if (action.type === 'pause') return `Pause für ${formatSeconds(config.seconds)}`;
  const repeats = `${config.repeats || 1}× durchlaufen`;
  if (!config.checkEnabled || !config.check) return `Schleife · ${repeats}`;
  const check = conditions.describeItem({ kind: 'when', type: 'state', config: config.check });
  return `Schleife · ${repeats} · Prüfung alle ${formatSeconds(config.checkIntervalSeconds)}: ${check}`;
}

const TYPE_LABELS = { write: 'Wert', pause: 'Pause', loop: 'Schleife' };

function normalizeRow(row) {
  const action = {
    id: Number(row.id),
    roomId: Number(row.room_id),
    phase: row.phase,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    type: row.type,
    position: Number(row.position || 0),
    config: parseConfig(row.config_json),
  };
  action.typeLabel = TYPE_LABELS[action.type] || action.type;
  action.description = describeAction(action);
  return action;
}

async function listActions(db, roomId) {
  const rows = await dbAll(
    db,
    `SELECT id, room_id, phase, parent_id, type, position, config_json
       FROM heimkino_actions WHERE room_id = ? ORDER BY position, id`,
    [Number(roomId)]
  );
  return rows.map(normalizeRow);
}

// Baum je Folge: Schleifen tragen ihre Kinder, alles andere bleibt flach.
function buildPhaseTrees(actions) {
  const byId = new Map();
  for (const action of actions) byId.set(action.id, { ...action, children: [] });
  const trees = { on: [], off: [] };
  for (const action of byId.values()) {
    const parent = action.parentId == null ? null : byId.get(action.parentId);
    if (parent && parent.type === 'loop') parent.children.push(action);
    else if (trees[action.phase]) trees[action.phase].push(action);
  }
  const sort = (list) => {
    list.sort((left, right) => left.position - right.position || left.id - right.id);
    for (const entry of list) if (entry.children.length) sort(entry.children);
  };
  sort(trees.on);
  sort(trees.off);
  return trees;
}

async function actionTree(db, roomId) {
  return buildPhaseTrees(await listActions(db, roomId));
}

async function getAction(db, roomId, actionId) {
  const row = await dbGet(
    db,
    'SELECT id, room_id, phase, parent_id, type, position, config_json FROM heimkino_actions WHERE id = ? AND room_id = ?',
    [Number(actionId), Number(roomId)]
  );
  return row ? normalizeRow(row) : null;
}

// Nur Schleifen dürfen Aktionen aufnehmen; ihre Kinder gehören zwingend zu
// derselben Folge.
async function requireLoopParent(db, roomId, parentId, phase) {
  if (parentId == null) return;
  const parent = await getAction(db, roomId, parentId);
  if (!parent) throw validation('Die gewählte Schleife wurde nicht gefunden.');
  if (parent.type !== 'loop') throw validation('Aktionen können nur in eine Schleife verschoben werden.');
  if (parent.phase !== phase) throw validation('Eine Aktion kann nicht in die andere Aktionsfolge verschoben werden.');
}

function parentReference(value) {
  if (value === '' || value == null || value === 'null') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw validation('Die gewählte Schleife ist ungültig.');
  return id;
}

async function addAction(db, roomId, input = {}) {
  const room = await dbGet(db, 'SELECT id FROM heimkino_rooms WHERE id = ?', [Number(roomId)]);
  if (!room) throw validation('Raum nicht gefunden.');
  const phase = cleanPhase(input.phase);
  const parentId = parentReference(input.parentId);
  await requireLoopParent(db, roomId, parentId, phase);
  const entry = normalizeActionInput(input);
  const next = await dbGet(
    db,
    'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM heimkino_actions WHERE room_id = ? AND phase = ? AND parent_id IS ?',
    [Number(roomId), phase, parentId]
  );
  const result = await dbRun(
    db,
    'INSERT INTO heimkino_actions (room_id, phase, parent_id, type, position, config_json) VALUES (?, ?, ?, ?, ?, ?)',
    [Number(roomId), phase, parentId, entry.type, next.position, JSON.stringify(entry.config)]
  );
  return getAction(db, roomId, result.id);
}

// Die Aktionsart bleibt beim Bearbeiten erhalten: eine Schleife mit Inhalt
// könnte sonst ihre Kinder verlieren.
async function updateAction(db, roomId, actionId, input = {}) {
  const current = await getAction(db, roomId, actionId);
  if (!current) throw validation('Aktion nicht gefunden.');
  const entry = normalizeActionInput({ ...input, type: current.type });
  await dbRun(db, 'UPDATE heimkino_actions SET config_json = ? WHERE id = ?', [JSON.stringify(entry.config), current.id]);
  return getAction(db, roomId, current.id);
}

function descendantIds(actions, rootId) {
  const childrenByParent = new Map();
  for (const action of actions) {
    const key = action.parentId == null ? 'root' : action.parentId;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(action.id);
  }
  const ids = [];
  const stack = [Number(rootId)];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    stack.push(...(childrenByParent.get(id) || []));
  }
  return ids;
}

// Eine Schleife nimmt ihren gesamten Inhalt mit.
async function deleteAction(db, roomId, actionId) {
  const actions = await listActions(db, roomId);
  if (!actions.some((action) => action.id === Number(actionId))) throw validation('Aktion nicht gefunden.');
  const ids = descendantIds(actions, actionId);
  const marks = ids.map(() => '?').join(',');
  await dbRun(db, `DELETE FROM heimkino_actions WHERE room_id = ? AND id IN (${marks})`, [Number(roomId), ...ids]);
  return ids.length;
}

// Drag&Drop überträgt den vollständigen sichtbaren Baum beider Folgen. Er wird
// als konsistente Momentaufnahme geprüft und gespeichert (Vorbild: Bedingungen).
async function updateLayout(db, roomId, input = {}) {
  const known = new Map((await listActions(db, roomId)).map((action) => [action.id, action]));
  const entries = Array.isArray(input.actions) ? input.actions : [];
  if (entries.length !== known.size) throw validation('Das Layout ist unvollständig; bitte die Seite neu laden.');

  const layout = new Map();
  for (const entry of entries) {
    const id = Number(entry.id);
    if (!known.has(id) || layout.has(id)) throw validation('Das Layout enthält unbekannte oder doppelte Aktionen.');
    const position = Number(entry.position);
    if (!Number.isInteger(position) || position < 0) throw validation('Layoutposition ist ungültig.');
    layout.set(id, { phase: cleanPhase(entry.phase), parentId: parentReference(entry.parentId), position });
  }
  for (const [id, entry] of layout) {
    if (entry.parentId == null) continue;
    const parent = layout.get(entry.parentId);
    if (!parent) throw validation('Die gewählte Schleife wurde nicht gefunden.');
    if (known.get(entry.parentId).type !== 'loop') throw validation('Aktionen können nur in eine Schleife verschoben werden.');
    if (parent.phase !== entry.phase) throw validation('Eine Aktion kann nicht in die andere Aktionsfolge verschoben werden.');
    const seen = new Set([id]);
    let cursor = entry.parentId;
    while (cursor != null) {
      if (seen.has(cursor)) throw validation('Schleifen dürfen keinen Kreis bilden.');
      seen.add(cursor);
      cursor = layout.get(cursor).parentId;
    }
  }

  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    for (const [id, entry] of layout) {
      await dbRun(db, 'UPDATE heimkino_actions SET phase = ?, parent_id = ?, position = ? WHERE id = ? AND room_id = ?',
        [entry.phase, entry.parentId, entry.position, id, Number(roomId)]);
    }
    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

// Alle Schleifen (auch verschachtelte) einer Raum-Aktionsliste – die Runtime
// braucht sie flach für die zyklische Prüfung.
function collectLoops(trees) {
  const loops = [];
  const walk = (list) => {
    for (const action of list) {
      if (action.type !== 'loop') continue;
      loops.push(action);
      walk(action.children);
    }
  };
  walk(trees.on);
  walk(trees.off);
  return loops;
}

// Alle Aktionen eines Baums flach – für Abonnements der referenzierten Topics.
function collectActions(trees) {
  const all = [];
  const walk = (list) => {
    for (const action of list) {
      all.push(action);
      if (action.children && action.children.length) walk(action.children);
    }
  };
  walk(trees.on);
  walk(trees.off);
  return all;
}

module.exports = {
  TYPE_LABELS, MIN_CHECK_SECONDS, MAX_CHECK_SECONDS, MAX_REPEATS, MAX_PAUSE_SECONDS,
  listActions, actionTree, getAction, addAction, updateAction, deleteAction, updateLayout,
  normalizeActionInput, describeAction, buildPhaseTrees, collectLoops, collectActions,
};
