'use strict';

// Aktionsfolgen: gemeinsame Datenschicht für alle Module, die zu einem Objekt
// (Raum, Gerät …) mehrere Folgen von Aktionen verwalten. Zuerst für das
// Heimkino gebaut, seit dem Modul „Heizung & Klima" geteilt — dort schaltet
// jede Folge ein Heiz- bzw. Kühlgerät.
//
// Aktionsarten:
//   write – wie das „Dann" der Bedingungen: einem State einen festen Wert oder
//           den Wert eines anderen Topics zuweisen (inkl. Rechenfunktion).
//   pause – hält die Folge für die angegebene Zeit an.
//   loop  – Container, der weitere Aktionen (auch Schleifen) enthält und sie
//           mehrfach durchläuft. Optional prüft er zusätzlich in festem Abstand
//           eine Bedingung; trifft sie nicht zu, wird nur diese Schleife erneut
//           abgespult (Plausibilitätsprüfung).
//
// Ein Modul erzeugt sich sein Repository mit createActionRepository(); Tabelle,
// Besitzer-Tabelle und die erlaubten Folgen (`phases`) sind das Einzige, worin
// sich die Module unterscheiden.

const conditions = require('../conditions/repository');

// Aktionsarten, Grenzen und Beschreibungen kommen aus den Bedingungen: dort
// sind dieselben Bausteine als Dann-/Sonst-Zweig zu Hause, und beide Seiten
// sollen sich in Validierung und Wortlaut nie auseinanderentwickeln.
const TYPES = new Set(['write', 'pause', 'loop']);
const {
  ACTION_TYPE_LABELS: TYPE_LABELS,
  MAX_PAUSE_SECONDS, MAX_REPEATS, MIN_CHECK_SECONDS, MAX_CHECK_SECONDS,
} = conditions;

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

// Vollständige Eingabe einer Aktion prüfen und in ihre gespeicherte Form
// bringen — Wert, Pause und Schleife sind exakt das „Dann" der Bedingungen.
function normalizeActionInput(input = {}) {
  const type = String(input.type || '').trim().toLowerCase();
  if (!TYPES.has(type)) throw validation('Die Aktionsart ist ungültig.');
  return { type, config: conditions.normalizeItemInput('then', { ...input, type }).config };
}

function parseConfig(value) {
  try {
    const config = JSON.parse(value || '{}');
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch (_) { return {}; }
}

function describeAction(action) {
  return conditions.describeActionItem({ type: action.type, config: action.config || {} });
}

// Alle Aktionen eines Baums flach – für Abonnements der referenzierten Topics.
function collectActions(trees) {
  const all = [];
  const walk = (list) => {
    for (const action of list || []) {
      all.push(action);
      if (action.children && action.children.length) walk(action.children);
    }
  };
  for (const list of Object.values(trees || {})) walk(list);
  return all;
}

// Alle Schleifen (auch verschachtelte) – die Runtime braucht sie flach für die
// zyklische Prüfung.
function collectLoops(trees) {
  return collectActions(trees).filter((action) => action.type === 'loop');
}

/**
 * Repository für die Aktionsfolgen eines Moduls.
 *
 * @param {object} options
 * @param {string} options.table        Tabelle der Aktionen
 * @param {string} options.ownerTable   Tabelle des Besitzers (Raum, Gerät …)
 * @param {string} options.ownerColumn  Fremdschlüsselspalte in `table`
 * @param {string[]} options.phases     erlaubte Folgen, z. B. ['on', 'off']
 * @param {string} [options.ownerMissing] Meldung, wenn der Besitzer fehlt
 */
function createActionRepository({
  table, ownerTable, ownerColumn = 'room_id', phases, ownerMissing = 'Eintrag nicht gefunden.',
}) {
  const PHASES = new Set(phases);
  const COLUMNS = `id, ${ownerColumn}, phase, parent_id, type, position, config_json`;

  function cleanPhase(value) {
    const phase = String(value == null ? '' : value).trim().toLowerCase();
    if (!PHASES.has(phase)) throw validation('Die Aktionsfolge ist ungültig.');
    return phase;
  }

  function normalizeRow(row) {
    const action = {
      id: Number(row.id),
      roomId: Number(row[ownerColumn]),
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

  async function listActions(db, ownerId) {
    const rows = await dbAll(db,
      `SELECT ${COLUMNS} FROM ${table} WHERE ${ownerColumn} = ? ORDER BY position, id`, [Number(ownerId)]);
    return rows.map(normalizeRow);
  }

  // Baum je Folge: Schleifen tragen ihre Kinder, alles andere bleibt flach.
  function buildPhaseTrees(actions) {
    const byId = new Map();
    for (const action of actions) byId.set(action.id, { ...action, children: [] });
    const trees = {};
    for (const phase of phases) trees[phase] = [];
    for (const action of byId.values()) {
      const parent = action.parentId == null ? null : byId.get(action.parentId);
      if (parent && parent.type === 'loop') parent.children.push(action);
      else if (trees[action.phase]) trees[action.phase].push(action);
    }
    const sort = (list) => {
      list.sort((left, right) => left.position - right.position || left.id - right.id);
      for (const entry of list) if (entry.children.length) sort(entry.children);
    };
    for (const phase of phases) sort(trees[phase]);
    return trees;
  }

  async function actionTree(db, ownerId) {
    return buildPhaseTrees(await listActions(db, ownerId));
  }

  async function getAction(db, ownerId, actionId) {
    const row = await dbGet(db, `SELECT ${COLUMNS} FROM ${table} WHERE id = ? AND ${ownerColumn} = ?`,
      [Number(actionId), Number(ownerId)]);
    return row ? normalizeRow(row) : null;
  }

  // Nur Schleifen dürfen Aktionen aufnehmen; ihre Kinder gehören zwingend zu
  // derselben Folge.
  async function requireLoopParent(db, ownerId, parentId, phase) {
    if (parentId == null) return;
    const parent = await getAction(db, ownerId, parentId);
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

  async function addAction(db, ownerId, input = {}) {
    const owner = await dbGet(db, `SELECT id FROM ${ownerTable} WHERE id = ?`, [Number(ownerId)]);
    if (!owner) throw validation(ownerMissing);
    const phase = cleanPhase(input.phase);
    const parentId = parentReference(input.parentId);
    await requireLoopParent(db, ownerId, parentId, phase);
    const entry = normalizeActionInput(input);
    const next = await dbGet(db,
      `SELECT COALESCE(MAX(position), -1) + 1 AS position FROM ${table}
        WHERE ${ownerColumn} = ? AND phase = ? AND parent_id IS ?`,
      [Number(ownerId), phase, parentId]);
    const result = await dbRun(db,
      `INSERT INTO ${table} (${ownerColumn}, phase, parent_id, type, position, config_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [Number(ownerId), phase, parentId, entry.type, next.position, JSON.stringify(entry.config)]);
    return getAction(db, ownerId, result.id);
  }

  // Die Aktionsart bleibt beim Bearbeiten erhalten: eine Schleife mit Inhalt
  // könnte sonst ihre Kinder verlieren.
  async function updateAction(db, ownerId, actionId, input = {}) {
    const current = await getAction(db, ownerId, actionId);
    if (!current) throw validation('Aktion nicht gefunden.');
    const entry = normalizeActionInput({ ...input, type: current.type });
    await dbRun(db, `UPDATE ${table} SET config_json = ? WHERE id = ?`, [JSON.stringify(entry.config), current.id]);
    return getAction(db, ownerId, current.id);
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
  async function deleteAction(db, ownerId, actionId) {
    const actions = await listActions(db, ownerId);
    if (!actions.some((action) => action.id === Number(actionId))) throw validation('Aktion nicht gefunden.');
    const ids = descendantIds(actions, actionId);
    const marks = ids.map(() => '?').join(',');
    await dbRun(db, `DELETE FROM ${table} WHERE ${ownerColumn} = ? AND id IN (${marks})`, [Number(ownerId), ...ids]);
    return ids.length;
  }

  // Drag&Drop überträgt den vollständigen sichtbaren Baum aller Folgen. Er wird
  // als konsistente Momentaufnahme geprüft und gespeichert (Vorbild: Bedingungen).
  async function updateLayout(db, ownerId, input = {}) {
    const known = new Map((await listActions(db, ownerId)).map((action) => [action.id, action]));
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
        await dbRun(db, `UPDATE ${table} SET phase = ?, parent_id = ?, position = ? WHERE id = ? AND ${ownerColumn} = ?`,
          [entry.phase, entry.parentId, entry.position, id, Number(ownerId)]);
      }
      await dbRun(db, 'COMMIT');
    } catch (error) {
      await dbRun(db, 'ROLLBACK').catch(() => {});
      throw error;
    }
  }

  return {
    TYPE_LABELS, MIN_CHECK_SECONDS, MAX_CHECK_SECONDS, MAX_REPEATS, MAX_PAUSE_SECONDS,
    phases: [...phases],
    listActions, actionTree, getAction, addAction, updateAction, deleteAction, updateLayout,
    normalizeActionInput, describeAction, buildPhaseTrees, collectLoops, collectActions,
  };
}

module.exports = {
  createActionRepository,
  TYPE_LABELS, MIN_CHECK_SECONDS, MAX_CHECK_SECONDS, MAX_REPEATS, MAX_PAUSE_SECONDS,
  normalizeActionInput, describeAction, collectLoops, collectActions,
};
