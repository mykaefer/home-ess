'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { createGroup, updateGroup } = require('../src/messen-schalten/groups');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mess_schalt_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 4, position INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '',
    offset_total_consumption INTEGER NOT NULL DEFAULT 1)`);
  return db;
}

test('Gruppen-Verrechnung wird gespeichert und kann deaktiviert werden', async () => {
  const db = await freshDb();
  const created = await createGroup(db, { title: 'Küche' });
  assert.equal(created.offsetTotalConsumption, true);

  const updated = await updateGroup(db, created.id, {
    title: 'Küche',
    offsetTotalConsumption: false,
  });
  assert.equal(updated.offsetTotalConsumption, false);
  await new Promise((resolve) => db.close(resolve));
});
