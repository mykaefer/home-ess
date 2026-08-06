'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-conditions-migration-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { openDatabase } = require('../src/db');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}
function close(db) { return new Promise((resolve) => db.close(resolve)); }

// Stand vor dem Sonst-Zweig: ohne `when_enabled` und mit einem CHECK, der nur
// Trigger, Wenn und Dann zulässt.
async function seedLegacyDatabase(file) {
  const db = new sqlite3.Database(file);
  await run(db, `CREATE TABLE automation_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
    last_triggered_at INTEGER, last_result TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '')`);
  await run(db, `CREATE TABLE automation_condition_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, condition_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trigger', 'when', 'then')), type TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, last_fired_at INTEGER)`);
  await run(db, "INSERT INTO automation_conditions (id, name, enabled) VALUES (1, 'Bestand', 1)");
  await run(db, `INSERT INTO automation_condition_items (id, condition_id, kind, type, config_json, position)
                 VALUES (7, 1, 'then', 'write', '{"topic":"custom://Licht","value":"20"}', 0)`);
  await close(db);
}

test('Bestandsdatenbanken bekommen die Wenn-Schaltung und den Sonst-Zweig nachgerüstet', async () => {
  await seedLegacyDatabase(process.env.HOME_ESS_DB);
  const db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const columns = await all(db, 'PRAGMA table_info(automation_conditions)');
    const names = columns.map((row) => row.name);
    assert.ok(names.includes('when_enabled'));
    const conditions = await all(db, 'SELECT when_enabled FROM automation_conditions WHERE id = 1');
    assert.equal(conditions[0].when_enabled, 1, 'bestehende Automationen behalten ihre Wenn-Prüfung');

    // Bestehende Elemente bleiben erhalten, neue Sonst-Elemente sind möglich.
    const items = await all(db, 'SELECT id, kind, config_json FROM automation_condition_items ORDER BY id');
    assert.deepEqual(items.map((row) => [row.id, row.kind]), [[7, 'then']]);
    await run(db, `INSERT INTO automation_condition_items (condition_id, kind, type, config_json, position)
                   VALUES (1, 'else', 'write', '{"topic":"custom://Notlicht","operation":"set","value":"5"}', 0)`);
    await assert.rejects(() => run(db, `INSERT INTO automation_condition_items (condition_id, kind, type, config_json, position)
                                        VALUES (1, 'unbekannt', 'write', '{}', 0)`), /CHECK/);
  } finally {
    await close(db);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});
