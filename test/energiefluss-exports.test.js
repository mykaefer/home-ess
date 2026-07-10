'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  slugify, listExports, getExportBySlug, createExport, updateExport, deleteExport,
} = require('../src/messen-schalten/energiefluss-exports');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE energiefluss_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT 'light')`);
  return db;
}
function closeDb(db) { return new Promise((resolve) => db.close(resolve)); }

test('slugify: Umlaute, Sonderzeichen, Leerzeichen und Leerfall', () => {
  assert.equal(slugify('Wohnzimmer Display'), 'wohnzimmer-display');
  assert.equal(slugify('Küche & Bäder!'), 'kueche-baeder');
  assert.equal(slugify('  ---  '), 'export');
  assert.equal(slugify(''), 'export');
});

test('createExport leitet Slug ab und macht ihn bei Namensgleichheit eindeutig', async () => {
  const db = await freshDb();
  const a = await createExport(db, { name: 'Display', theme: 'dark' });
  assert.equal(a.slug, 'display');
  assert.equal(a.theme, 'dark');
  const b = await createExport(db, { name: 'Display', theme: 'invalid' });
  assert.equal(b.slug, 'display-2'); // Kollision → -2
  assert.equal(b.theme, 'light'); // ungültiges Theme fällt auf hell zurück
  await closeDb(db);
});

test('createExport verlangt einen Namen', async () => {
  const db = await freshDb();
  await assert.rejects(() => createExport(db, { name: '   ' }), (err) => err.validation === true);
  await closeDb(db);
});

test('updateExport ändert Name/Theme/Slug und getExportBySlug findet den Export', async () => {
  const db = await freshDb();
  const created = await createExport(db, { name: 'Alt', theme: 'light' });
  const updated = await updateExport(db, created.id, { name: 'Neuer Name', theme: 'dark' });
  assert.equal(updated.name, 'Neuer Name');
  assert.equal(updated.slug, 'neuer-name');
  assert.equal(updated.theme, 'dark');
  // Alter Slug ist weg, neuer wird gefunden.
  assert.equal(await getExportBySlug(db, 'alt'), null);
  const found = await getExportBySlug(db, 'neuer-name');
  assert.equal(found.id, created.id);
  await closeDb(db);
});

test('updateExport behält den eigenen Slug ohne unnötiges Suffix', async () => {
  const db = await freshDb();
  const created = await createExport(db, { name: 'Stabil', theme: 'light' });
  const updated = await updateExport(db, created.id, { name: 'Stabil', theme: 'dark' });
  assert.equal(updated.slug, 'stabil'); // nicht 'stabil-2'
  await closeDb(db);
});

test('listExports sortiert alphanumerisch; deleteExport entfernt', async () => {
  const db = await freshDb();
  await createExport(db, { name: 'Zeta' });
  const beta = await createExport(db, { name: 'Beta' });
  await createExport(db, { name: 'Alpha 10' });
  await createExport(db, { name: 'Alpha 2' });
  let list = await listExports(db);
  assert.deepEqual(list.map((e) => e.name), ['Alpha 2', 'Alpha 10', 'Beta', 'Zeta']);
  await deleteExport(db, beta.id);
  list = await listExports(db);
  assert.deepEqual(list.map((e) => e.name), ['Alpha 2', 'Alpha 10', 'Zeta']);
  await closeDb(db);
});
