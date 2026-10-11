'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-speech-migration-'));
process.env.HOME_ESS_DB = path.join(directory, 'app.db');
const { openDatabase } = require('../src/db');
const rules = require('../src/notifications/rules');
const config = require('../src/speech/config');
const run = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (e) => e ? reject(e) : resolve()));
const close = (db) => new Promise((resolve, reject) => db.close((e) => e ? reject(e) : resolve()));
const get = (db, sql) => new Promise((resolve, reject) => db.get(sql, (e, row) => e ? reject(e) : resolve(row)));

test('Upgrade erhält alte Relay-Regeln, Endpunktzuordnung überlebt Neustart und wird bei Raumlöschung entfernt', async () => {
  let db = new sqlite3.Database(process.env.HOME_ESS_DB);
  try {
    await run(db, `CREATE TABLE notification_rules (
      id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER, state_id TEXT, trigger_type TEXT,
      trigger_value TEXT, title TEXT, body TEXT, event_type TEXT, severity TEXT,
      cooldown_seconds INTEGER, position INTEGER, created_at INTEGER, updated_at INTEGER, last_triggered_at INTEGER);
      INSERT INTO notification_rules VALUES (1, 'Alt', 1, 'custom://test', 'changed', '', 'Titel', 'Text', 'test', 'normal', 5, 0, 1, 1, NULL);`);
    await close(db);
    db = openDatabase();
    // Migrationen legen Spalten asynchron an; bis zum sichtbaren Schema warten.
    for (let attempt = 0; attempt < 100; attempt++) {
      const column = await get(db, "SELECT name FROM pragma_table_info('notification_rules') WHERE name = 'audio_target'");
      if (column) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rule = await rules.getRule(db, 1);
    assert.equal(rule.delivery, 'relay');
    assert.equal(rule.audioTarget, 'all');
    assert.equal(rule.body, 'Text');
    assert.deepEqual(await config.get(db), config.DEFAULTS);
    const settings = { volumePercent: 55, leadMs: 1750, tailMs: 600, chunkMs: 20 };
    await config.save(db, settings);
    for (const invalid of [{ leadMs: 0 }, { volumePercent: 101 }, { tailMs: -1 }, { chunkMs: 30 }, { leadMs: '' }, { leadMs: ['1000'] }, { leadMs: 100.5 }]) {
      await assert.rejects(config.save(db, { ...settings, ...invalid }), { validation: true });
    }
    assert.deepEqual(await config.get(db), settings);
    await run(db, `INSERT INTO heizung_rooms (id, name) VALUES (987, 'Küche');
      INSERT INTO speech_endpoints (device_id, source, name, room_id, last_seen) VALUES ('speaker', 'test', 'Ansage', 987, 1);`);
    await close(db);
    db = openDatabase();
    assert.deepEqual(await config.get(db), settings);
    assert.equal((await get(db, "SELECT name FROM speech_endpoints WHERE device_id = 'speaker'")).name, 'Ansage');
    await run(db, 'DELETE FROM heizung_rooms WHERE id = 987');
    assert.equal((await get(db, "SELECT room_id FROM speech_endpoints WHERE device_id = 'speaker'")).room_id, null);
  } finally {
    if (db) await close(db);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
