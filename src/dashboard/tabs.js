'use strict';

// CRUD für Dashboard-Tabs. Jede Gruppe und jedes gruppenlose Widget gehört zu
// genau einem Tab (Widgets in Gruppen erben den Tab ihrer Gruppe). Mindestens
// ein Tab bleibt immer bestehen; Bestandsdaten ohne Tab-Zuordnung werden beim
// Laden dem ersten (Standard-)Tab zugewiesen.

const DEFAULT_TAB_TITLE = 'Übersicht';
const MAX_TAB_TITLE_LENGTH = 40;

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

function normalizeTabRow(row = {}) {
  return {
    id: row.id,
    title: row.title || '',
    position: row.position == null ? 0 : row.position,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

// Titel prüfen: nicht leer, sinnvoll begrenzt (Anzeige in der Tab-Leiste).
function normalizeTitle(value) {
  const title = String(value == null ? '' : value).trim();
  if (!title) throw validationError('Bitte einen Namen für den Tab eingeben.');
  if (title.length > MAX_TAB_TITLE_LENGTH) {
    throw validationError(`Der Tab-Name darf höchstens ${MAX_TAB_TITLE_LENGTH} Zeichen lang sein.`);
  }
  return title;
}

// Tabs auflisten und dabei sicherstellen, dass (a) mindestens ein Tab existiert
// und (b) Bestandsdaten ohne tab_id dem ersten Tab zugeordnet sind. Diese
// Normalisierung beim Laden macht die Migration alter Konfigurationen
// rückwärtskompatibel, ohne ein einmaliges Migrationsskript zu benötigen.
async function listTabs(db) {
  let rows = await dbAll(db, 'SELECT id, title, position FROM dashboard_tabs ORDER BY position ASC, id ASC');
  if (!rows.length) {
    await dbRun(db, 'INSERT INTO dashboard_tabs (title, position) VALUES (?, 0)', [DEFAULT_TAB_TITLE]);
    rows = await dbAll(db, 'SELECT id, title, position FROM dashboard_tabs ORDER BY position ASC, id ASC');
  }
  const defaultTabId = rows[0].id;
  await dbRun(db, 'UPDATE dashboard_groups SET tab_id = ? WHERE tab_id IS NULL', [defaultTabId]);
  await dbRun(db, 'UPDATE dashboard_widgets SET tab_id = ? WHERE tab_id IS NULL AND group_id IS NULL', [defaultTabId]);
  return rows.map(normalizeTabRow);
}

async function getTab(db, id) {
  const row = await dbGet(db, 'SELECT id, title, position FROM dashboard_tabs WHERE id = ?', [id]);
  return row ? normalizeTabRow(row) : null;
}

async function createTab(db, input = {}) {
  const title = normalizeTitle(input.title);
  const row = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM dashboard_tabs');
  const result = await dbRun(db, 'INSERT INTO dashboard_tabs (title, position) VALUES (?, ?)', [
    title,
    row ? row.pos : 0,
  ]);
  return getTab(db, result.lastID);
}

async function renameTab(db, id, input = {}) {
  const title = normalizeTitle(input.title);
  const tab = await getTab(db, id);
  if (!tab) throw validationError('Tab nicht gefunden.');
  await dbRun(db, 'UPDATE dashboard_tabs SET title = ? WHERE id = ?', [title, id]);
  return getTab(db, id);
}

// Tab löschen: Der letzte verbleibende Tab ist nicht löschbar. Enthaltene
// Gruppen und gruppenlose Widgets werden auf den Ziel-Tab verschoben — nie
// stillschweigend gelöscht.
async function deleteTab(db, id, targetTabId) {
  const tabs = await listTabs(db);
  const tab = tabs.find((entry) => entry.id === Number(id));
  if (!tab) throw validationError('Tab nicht gefunden.');
  if (tabs.length <= 1) throw validationError('Der letzte Tab kann nicht gelöscht werden.');

  const fallback = tabs.find((entry) => entry.id !== tab.id);
  const target = tabs.find((entry) => entry.id === Number(targetTabId) && entry.id !== tab.id) || fallback;
  await dbRun(db, 'UPDATE dashboard_groups SET tab_id = ? WHERE tab_id = ?', [target.id, tab.id]);
  await dbRun(db, 'UPDATE dashboard_widgets SET tab_id = ? WHERE tab_id = ?', [target.id, tab.id]);
  await dbRun(db, 'DELETE FROM dashboard_tabs WHERE id = ?', [tab.id]);
  return target.id;
}

// Neue Tab-Reihenfolge aus dem Drag&Drop der Tab-Leiste persistieren.
async function reorderTabs(db, items) {
  for (let index = 0; index < (items || []).length; index += 1) {
    const id = Number(items[index].id);
    if (!Number.isFinite(id)) continue;
    const position = Number.isFinite(Number(items[index].position)) ? Number(items[index].position) : index;
    await dbRun(db, 'UPDATE dashboard_tabs SET position = ? WHERE id = ?', [position, id]);
  }
}

// Prüft eine (Formular-)Tab-Angabe gegen die vorhandenen Tabs; ungültige oder
// fehlende Angaben fallen auf den Standard-Tab (erster Tab) zurück.
function resolveTabId(tabs, value) {
  const parsed = Number(value);
  const found = tabs.find((tab) => tab.id === parsed);
  return found ? found.id : tabs[0].id;
}

module.exports = {
  DEFAULT_TAB_TITLE,
  MAX_TAB_TITLE_LENGTH,
  listTabs,
  getTab,
  createTab,
  renameTab,
  deleteTab,
  reorderTabs,
  resolveTabId,
};
