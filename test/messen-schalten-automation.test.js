'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const mqttClient = require('../src/mqtt/client');
const levelHandler = require('../src/messen-schalten/../operating-level/handler');
const automation = require('../src/messen-schalten/automation');
const modulesState = require('../src/modules');
const gridControlAutomation = require('../src/grid-control/automation');
const { cacheKey } = require('../src/messen-schalten/actors');

test.beforeEach(() => {
  automation.resetForTests();
  mqttClient.getCache().clear();
});

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
    remote_topic TEXT NOT NULL DEFAULT '',
    status_topic TEXT NOT NULL DEFAULT '', power_topic TEXT NOT NULL DEFAULT '',
    power_unit TEXT NOT NULL DEFAULT 'W', counter_topic TEXT NOT NULL DEFAULT '',
    counter_unit TEXT NOT NULL DEFAULT 'kWh', priority INTEGER NOT NULL DEFAULT 4,
    use_group_priority INTEGER NOT NULL DEFAULT 0, desired_on INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '',
    load_shed_enabled INTEGER NOT NULL DEFAULT 0,
    load_shed_phase TEXT NOT NULL DEFAULT 'l1')`);
  await dbRun(db, "CREATE TABLE mess_schalt_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, priority INTEGER NOT NULL DEFAULT 4, position INTEGER NOT NULL DEFAULT 0, function_key TEXT NOT NULL DEFAULT '')");
  await dbRun(db, 'CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)');
  await dbRun(db, `CREATE TABLE grid_control_config (
    id INTEGER PRIMARY KEY, load_enabled INTEGER NOT NULL DEFAULT 0,
    load_shed_max_l1 REAL, load_shed_max_l2 REAL, load_shed_max_l3 REAL,
    load_on_l1 REAL, load_on_l2 REAL, load_on_l3 REAL,
    load_off_l1 REAL, load_off_l2 REAL, load_off_l3 REAL
  )`);
  await dbRun(db, 'INSERT INTO grid_control_config (id, load_enabled, load_shed_max_l1, load_shed_max_l2, load_shed_max_l3, load_on_l1, load_on_l2, load_on_l3, load_off_l1, load_off_l2, load_off_l3) VALUES (1, 1, 4000, 4000, 4000, 4000, 4000, 4000, 3000, 3000, 3000)');
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

test('Unbestätigter Schaltbefehl wird nicht in jedem Tick wiederholt', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on) VALUES (12, 'Pumpe', 'repeat.0.state', 4, 1)");
  setActual(12, false);
  await withPublishCapture(async (published) => {
    levelHandler.applyLevel(5);
    await automation.tick(db);
    await automation.tick(db);
    assert.deepEqual(published, [['repeat.0.state', '1']]);

    // Bestätigung gibt den Befehl frei; eine spätere Abweichung darf erneut
    // genau einen Einschaltbefehl auslösen.
    setActual(12, true);
    await automation.tick(db);
    setActual(12, false);
    await automation.tick(db);
    assert.deepEqual(published, [['repeat.0.state', '1'], ['repeat.0.state', '1']]);
  });
  clearActual(12);
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

test('Remote-Topic schaltet das Gerät und wird bei Geräteänderungen synchronisiert', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, remote_topic, priority) VALUES (70, 'Remote', 'device.0.state', 'remote.0.state', 2)");
  levelHandler.applyLevel(5);
  mqttClient.getCache().set(cacheKey(70, 'remote'), { value: '1', receivedAt: 100 });
  await withPublishCapture(async (published) => {
    await automation.tick(db);
    assert.ok(published.some((p) => p[0] === 'device.0.state' && p[1] === '1'));
    assert.ok(published.some((p) => p[0] === 'remote.0.state' && p[1] === '1'));

    published.length = 0;
    mqttClient.getCache().set(cacheKey(70, 'switch'), { value: '0', receivedAt: 200 });
    await automation.tick(db);
    assert.deepEqual(published, [['remote.0.state', '0']]);
  });
  await new Promise((resolve) => db.close(resolve));
});

test('Gesperrtes Remote-Einschalten setzt Gerät und Remote-Topic auf aus', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, remote_topic, priority) VALUES (71, 'Gesperrt', 'device.1.state', 'remote.1.state', 5)");
  levelHandler.applyLevel(2);
  mqttClient.getCache().set(cacheKey(71, 'remote'), { value: '1', receivedAt: 100 });
  await withPublishCapture(async (published) => {
    await automation.tick(db);
    assert.ok(published.some((p) => p[0] === 'device.1.state' && p[1] === '0'));
    assert.ok(published.some((p) => p[0] === 'remote.1.state' && p[1] === '0'));
  });
  await new Promise((resolve) => db.close(resolve));
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

test('Lastabwurf schaltet nach 80 % der separaten Maximallast aus', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, always_on, load_shed_enabled, load_shed_phase) VALUES (50, 'Boiler', 'boiler.0.state', 1, 1, 'l2')");
  await dbRun(db, 'UPDATE grid_control_config SET load_shed_max_l2 = 4000, load_on_l2 = 6000 WHERE id = 1');
  await modulesState.setEnabled(db, 'grid-control', true);
  const origGetState = gridControlAutomation.getState;
  gridControlAutomation.getState = () => ({ inverterLoads: [1200, 3200, 900] });
  setActual(50, true);
  try {
    await withPublishCapture(async (published) => {
      levelHandler.applyLevel(5);
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'boiler.0.state' && p[1] === '0'));
    });
  } finally {
    gridControlAutomation.getState = origGetState;
    clearActual(50);
    await modulesState.setEnabled(db, 'grid-control', false);
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Lastabwurf schaltet „Immer an" unter 50 % wieder ein, manuelle Geräte aber nicht', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, always_on, load_shed_enabled, load_shed_phase) VALUES (60, 'WP', 'wp.0.state', 1, 1, 'three_phase')");
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, always_on, load_shed_enabled, load_shed_phase) VALUES (61, 'Licht', 'licht.0.state', 0, 1, 'l1')");
  await modulesState.setEnabled(db, 'grid-control', true);
  const origGetState = gridControlAutomation.getState;
  const origNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    gridControlAutomation.getState = () => ({ inverterLoads: [3300, 1800, 1800] });
    levelHandler.applyLevel(5);
    setActual(60, true);
    setActual(61, true);
    await automation.tick(db);

    gridControlAutomation.getState = () => ({ inverterLoads: [1500, 1500, 1500] });
    setActual(60, false);
    setActual(61, false);
    await withPublishCapture(async (published) => {
      now += 59000;
      await automation.tick(db);
      assert.ok(!published.some((p) => p[0] === 'wp.0.state' && p[1] === '1'));
      assert.ok(!published.some((p) => p[0] === 'licht.0.state' && p[1] === '1'));

      published.length = 0;
      now += 2000;
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'wp.0.state' && p[1] === '1'));
      assert.ok(!published.some((p) => p[0] === 'licht.0.state' && p[1] === '1'));
    });
  } finally {
    Date.now = origNow;
    gridControlAutomation.getState = origGetState;
    clearActual(60);
    clearActual(61);
    await modulesState.setEnabled(db, 'grid-control', false);
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Lastabwurf sendet die Wiedereinschaltung auch bei veraltetem Status-Topic erneut', async () => {
  const db = await freshDb();
  await dbRun(
    db,
    "INSERT INTO mess_schalt_actors (id, name, switch_topic, status_topic, always_on, load_shed_enabled, load_shed_phase) VALUES (62, 'WM', 'wm.0.switch', 'wm.0.status', 1, 1, 'l3')"
  );
  await modulesState.setEnabled(db, 'grid-control', true);
  const origGetState = gridControlAutomation.getState;
  const origNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    gridControlAutomation.getState = () => ({ inverterLoads: [200, 200, 3300] });
    levelHandler.applyLevel(5);
    mqttClient.getCache().set(cacheKey(62, 'status'), { value: '1' });
    await automation.tick(db);

    gridControlAutomation.getState = () => ({ inverterLoads: [200, 200, 1500] });
    await withPublishCapture(async (published) => {
      now += 61000;
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'wm.0.switch' && p[1] === '1'));
    });
  } finally {
    Date.now = origNow;
    gridControlAutomation.getState = origGetState;
    clearActual(62);
    mqttClient.getCache().delete(cacheKey(62, 'status'));
    await modulesState.setEnabled(db, 'grid-control', false);
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Lastabwurf eskaliert mit 10 s und erholt sich erst nach 60 s stufenweise', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on, load_shed_enabled, load_shed_phase) VALUES (70, 'P5', 'p5.0.state', 5, 1, 1, 'l1')");
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, always_on, load_shed_enabled, load_shed_phase) VALUES (71, 'P4', 'p4.0.state', 4, 1, 1, 'l1')");
  await modulesState.setEnabled(db, 'grid-control', true);
  const origGetState = gridControlAutomation.getState;
  const origNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  gridControlAutomation.getState = () => ({ inverterLoads: [3300, 1000, 1000] });
  setActual(70, true);
  setActual(71, true);
  try {
    await withPublishCapture(async (published) => {
      levelHandler.applyLevel(5);
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'p5.0.state' && p[1] === '0'));
      assert.ok(!published.some((p) => p[0] === 'p4.0.state' && p[1] === '0'));

      published.length = 0;
      now += 5000;
      await automation.tick(db);
      assert.ok(!published.some((p) => p[0] === 'p4.0.state' && p[1] === '0'), 'vor 10 s keine naechste Stufe');

      published.length = 0;
      now += 6000;
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'p4.0.state' && p[1] === '0'));

      published.length = 0;
      gridControlAutomation.getState = () => ({ inverterLoads: [1500, 1000, 1000] });
      setActual(70, false);
      setActual(71, false);
      now += 59000;
      await automation.tick(db);
      assert.ok(!published.some((p) => p[1] === '1'), 'erste Freigabe wartet 60 s unter 50 %');

      published.length = 0;
      now += 2000;
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'p4.0.state' && p[1] === '1'));
      assert.ok(!published.some((p) => p[0] === 'p5.0.state' && p[1] === '1'));

      published.length = 0;
      now += 30000;
      await automation.tick(db);
      assert.ok(!published.some((p) => p[0] === 'p5.0.state' && p[1] === '1'), 'zwischen Freigabestufen 60 s Pause');

      published.length = 0;
      now += 31000;
      await automation.tick(db);
      assert.ok(published.some((p) => p[0] === 'p5.0.state' && p[1] === '1'));
    });
  } finally {
    Date.now = origNow;
    gridControlAutomation.getState = origGetState;
    clearActual(70);
    clearActual(71);
    await modulesState.setEnabled(db, 'grid-control', false);
    await new Promise((resolve) => db.close(resolve));
  }
});
