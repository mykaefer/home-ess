'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const mqttClient = require('../src/mqtt/client');
const levelHandler = require('../src/messen-schalten/../operating-level/handler');
const automation = require('../src/messen-schalten/automation');
const { cacheKey } = require('../src/messen-schalten/actors');

// Externen/Ist-Zustand eines Geräts im gemeinsamen Cache setzen bzw. entfernen.
function setActual(id, on) {
  mqttClient.getCache().set(cacheKey(id, 'switch'), { value: on ? '1' : '0' });
}
function clearActual(id) {
  mqttClient.getCache().delete(cacheKey(id, 'switch'));
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mess_schalt_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', group_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0, switch_topic TEXT NOT NULL DEFAULT '',
    status_topic TEXT NOT NULL DEFAULT '', power_topic TEXT NOT NULL DEFAULT '',
    power_unit TEXT NOT NULL DEFAULT 'W', counter_topic TEXT NOT NULL DEFAULT '',
    counter_unit TEXT NOT NULL DEFAULT 'kWh', priority INTEGER NOT NULL DEFAULT 4,
    use_group_priority INTEGER NOT NULL DEFAULT 0, desired_on INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '')`);
  await dbRun(db, "CREATE TABLE mess_schalt_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, priority INTEGER NOT NULL DEFAULT 4, position INTEGER NOT NULL DEFAULT 0, function_key TEXT NOT NULL DEFAULT '')");
  return db;
}

// publish abfangen (automation ruft mqttClient.publish über das Modulobjekt auf).
function withPublishCapture(fn) {
  const orig = mqttClient.publish;
  const published = [];
  mqttClient.publish = (topic, value) => published.push([topic, String(value)]);
  return Promise.resolve(fn(published)).finally(() => { mqttClient.publish = orig; });
}

test('„Immer an" schaltet automatisch ein, sobald die Priorität erreicht ist – darunter aus', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on) VALUES (10, 'Ofen', 'ofen.0.state', 4, 1)");
  await withPublishCapture(async (published) => {
    levelHandler.applyLevel(5);           // Level ≥ Priorität ⇒ automatisch ein
    await automation.tick(db);
    assert.deepEqual(published.at(-1), ['ofen.0.state', '1']);
    published.length = 0;

    levelHandler.applyLevel(2);           // Level < Priorität ⇒ Zwangsabschaltung
    assert.ok(published.some((p) => p[0] === 'ofen.0.state' && p[1] === '0'));
  });
  await new Promise((resolve) => db.close(resolve));
});

test('„Immer an" schaltet bei externem Ausschalten wieder ein', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on) VALUES (11, 'Pumpe', 'pu.0.state', 4, 1)");
  setActual(11, false); // extern ausgeschaltet, Level lässt es aber zu
  await withPublishCapture(async (published) => {
    levelHandler.applyLevel(5);
    await automation.tick(db);
    assert.deepEqual(published.at(-1), ['pu.0.state', '1']); // wieder ein
  });
  clearActual(11);
  await new Promise((resolve) => db.close(resolve));
});

test('Ohne „Immer an" wird das Gerät unterhalb der Priorität ausgeschaltet', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on) VALUES (20, 'Licht', 'licht.0.state', 4, 0)");
  setActual(20, true); // manuell/extern an
  await automation.tick(db); // zuerst evtl. Alt-Registrierungen aus anderen Tests aufräumen
  await withPublishCapture(async (published) => {
    levelHandler.applyLevel(2);
    await automation.tick(db);
    assert.ok(published.some((p) => p[0] === 'licht.0.state' && p[1] === '0'));
    published.length = 0;
    setActual(20, false);
    levelHandler.applyLevel(5);
    await automation.tick(db);
    assert.ok(!published.some((p) => p[0] === 'licht.0.state' && p[1] === '1'));
  });
  clearActual(20);
  await new Promise((resolve) => db.close(resolve));
});

test('commandManual erlaubt Einschalten nur bei freigegebener Priorität', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on) VALUES (21, 'Steckdose', 'sd.0.state', 4, 0)");
  await withPublishCapture(async (published) => {
    levelHandler.applyLevel(1);
    assert.equal(await automation.commandManual(db, 21, true), false);
    assert.deepEqual(published.at(-1), ['sd.0.state', '0']);
    levelHandler.applyLevel(4);
    assert.equal(await automation.commandManual(db, 21, true), true);
    assert.deepEqual(published.at(-1), ['sd.0.state', '1']);
    assert.equal(await automation.commandManual(db, 21, false), true);
    assert.deepEqual(published.at(-1), ['sd.0.state', '0']);
  });
  await new Promise((resolve) => db.close(resolve));
});

test('commandManual ignoriert „Immer an"-Geräte (Toggle ist dort ausgeblendet)', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on) VALUES (22, 'Auto', 'auto.0.state', 4, 1)");
  await withPublishCapture(async (published) => {
    await automation.commandManual(db, 22, false);
    assert.equal(published.length, 0);
  });
  await new Promise((resolve) => db.close(resolve));
});

test('Gruppenpriorität wird für die „Immer an"-Freigabe verwendet', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_groups (id, title, priority) VALUES (3, 'Wichtig', 2)");
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, group_id, switch_topic, priority, use_group_priority, always_on) VALUES (30, 'Gerät', 3, 'g.0.state', 5, 1, 1)");
  await withPublishCapture(async (published) => {
    // Level 3 ≥ Gruppenpriorität 2 ⇒ ein (obwohl eigene Priorität 5 sperren würde).
    levelHandler.applyLevel(3);
    await automation.tick(db);
    assert.deepEqual(published.at(-1), ['g.0.state', '1']);
  });
  await new Promise((resolve) => db.close(resolve));
});

test('isRelevantEvent erkennt nur Messen-+-Schalten-Topics', () => {
  assert.equal(automation.isRelevantEvent({ changedKeys: ['messschalt:7:switch'] }), true);
  assert.equal(automation.isRelevantEvent({ changedKeys: ['messschalt:7:status', 'pv.current'] }), true);
  assert.equal(automation.isRelevantEvent({ changedKeys: ['wallbox:1:power'] }), false);
  assert.equal(automation.isRelevantEvent({}), false);
});

test('Geräte ohne Schalt-Topic nehmen nicht am Level teil', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic, always_on) VALUES (40, 'Nur Messen', 'm.0.power', 1)");
  await withPublishCapture(async (published) => {
    levelHandler.applyLevel(5);
    await automation.tick(db);
    assert.equal(published.length, 0);   // kein Schalt-Topic ⇒ nichts geschaltet
  });
  await new Promise((resolve) => db.close(resolve));
});
