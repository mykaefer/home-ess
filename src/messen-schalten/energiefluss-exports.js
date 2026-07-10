'use strict';

// CRUD der Energiefluss-Exporte (Unterseite Energiefluss). Ein Export ist eine
// benannte, öffentlich abrufbare Live-Ansicht des Energiefluss-Diagramms mit
// heller oder dunkler Darstellung. Aus dem Namen wird ein eindeutiger Slug
// abgeleitet, der die Export-URL bildet (/energiefluss/export/<slug>). Vorbild:
// messen-schalten/schaltgruppen.js.

const THEMES = ['light', 'dark'];

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) { return err ? reject(err) : resolve(this); });
  });
}

// Namen zu URL-tauglichem Slug: Kleinbuchstaben, Umlaute entschärft, alles
// Nicht-Alphanumerische zu Bindestrichen, gekürzt. Leer → „export".
function slugify(name) {
  const base = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'export';
}

// Eindeutigen Slug bilden: bei Kollision -2, -3, … anhängen (den eigenen
// Datensatz beim Bearbeiten ausschließen).
async function uniqueSlug(db, name, excludeId = null) {
  const base = slugify(name);
  const rows = await dbAll(db, 'SELECT id, slug FROM energiefluss_exports');
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeTheme(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return THEMES.includes(text) ? text : 'light';
}

function normalizeRow(row = {}) {
  return {
    id: row.id,
    name: row.name || '',
    slug: row.slug || '',
    theme: normalizeTheme(row.theme),
  };
}

function normalizeInput(input = {}) {
  return {
    name: String(input.name || '').trim(),
    theme: normalizeTheme(input.theme),
  };
}

function ensureName(input) {
  if (!input.name) {
    const error = new Error('Bitte einen Namen für den Export eingeben.');
    error.validation = true;
    throw error;
  }
}

// Feste alphanumerische Sortierung nach Name (wie die übrigen Listen).
async function listExports(db) {
  const rows = await dbAll(db, 'SELECT id, name, slug, theme FROM energiefluss_exports');
  return rows
    .map(normalizeRow)
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' }) || a.id - b.id);
}

async function getExport(db, id) {
  const row = await dbGet(db, 'SELECT id, name, slug, theme FROM energiefluss_exports WHERE id = ?', [id]);
  return row ? normalizeRow(row) : null;
}

async function getExportBySlug(db, slug) {
  const row = await dbGet(db, 'SELECT id, name, slug, theme FROM energiefluss_exports WHERE slug = ?', [String(slug || '')]);
  return row ? normalizeRow(row) : null;
}

async function createExport(db, rawInput) {
  const input = normalizeInput(rawInput);
  ensureName(input);
  const slug = await uniqueSlug(db, input.name);
  const result = await dbRun(
    db,
    'INSERT INTO energiefluss_exports (name, slug, theme) VALUES (?, ?, ?)',
    [input.name, slug, input.theme]
  );
  return getExport(db, result.lastID);
}

async function updateExport(db, id, rawInput) {
  const input = normalizeInput(rawInput);
  ensureName(input);
  const slug = await uniqueSlug(db, input.name, Number(id));
  await dbRun(db, 'UPDATE energiefluss_exports SET name = ?, slug = ?, theme = ? WHERE id = ?', [
    input.name, slug, input.theme, id,
  ]);
  return getExport(db, id);
}

async function deleteExport(db, id) {
  await dbRun(db, 'DELETE FROM energiefluss_exports WHERE id = ?', [id]);
}

module.exports = {
  THEMES, slugify, uniqueSlug, normalizeInput, normalizeTheme,
  listExports, getExport, getExportBySlug, createExport, updateExport, deleteExport,
};
