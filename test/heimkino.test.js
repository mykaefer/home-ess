'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const bus = require('../src/state-bus');
const rooms = require('../src/heimkino/rooms');
const actionsRepo = require('../src/heimkino/actions');
const runtime = require('../src/heimkino/runtime');
const modules = require('../src/modules');
const mqttClient = require('../src/mqtt/client');
const adapterRouter = require('../src/adapters/router');
const switches = require('../src/dashboard/switches');
const renderHeimkino = require('../src/views/heimkino');
const renderHeimkinoRoom = require('../src/views/heimkino-room');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
}
function close(db) { return new Promise((resolve) => db.close(resolve)); }
function wait(ms = 30) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE heimkino_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    position INTEGER NOT NULL DEFAULT 0, cinema_on INTEGER NOT NULL DEFAULT 0,
    remote_topic TEXT NOT NULL DEFAULT '',
    last_run_at INTEGER, last_result TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '')`);
  await run(db, `CREATE TABLE heimkino_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('on', 'off')), parent_id INTEGER,
    type TEXT NOT NULL CHECK (type IN ('write', 'pause', 'loop')),
    position INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}')`);
  await run(db, 'CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)');
  await modules.setEnabled(db, 'heimkino', true);
  return db;
}

function beamerOnInput(overrides = {}) {
  return { phase: 'on', type: 'write', topic: 'custom://Beamer', operation: 'set', value: '1', ...overrides };
}

test('Räume prüfen ihren Namen und liefern einen beschreibbaren Kinomodus-State', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: ' Wohnzimmer ' });
  assert.equal(room.name, 'Wohnzimmer');
  assert.equal(room.cinemaOn, false);
  assert.equal(rooms.stateTopic(room.id), `heimkino://raeume/${room.id}`);
  await assert.rejects(() => rooms.createRoom(db, { name: 'wohnzimmer' }), /gibt es bereits/);
  await assert.rejects(() => rooms.createRoom(db, { name: 'Keller/Kino' }), /Schrägstrich/);
  await assert.rejects(() => rooms.createRoom(db, { name: '  ' }), /Namen/);

  const block = await rooms.buildHeimkinoStatesBlock(db, new Map());
  assert.equal(block.prefix, 'heimkino');
  assert.equal(block.virtual, true);
  assert.equal(block.categories[0].name, 'Heimkino');
  const state = block.categories[0].states[0];
  assert.equal(state.name, 'Wohnzimmer');
  assert.equal(state.catalogLabel, 'Kinomodus Wohnzimmer');
  assert.equal(state.writable, true);
  assert.equal(state.topic, rooms.stateTopic(room.id));
  assert.equal(state.display, 'Aus');

  await rooms.setCinemaOn(db, room.id, true);
  const on = await rooms.buildHeimkinoStatesBlock(db, new Map());
  assert.equal(on.categories[0].states[0].display, 'Ein');

  await rooms.deleteRoom(db, room.id);
  assert.deepEqual(await rooms.listRooms(db), []);
  await close(db);
});

test('Aktionen kennen Wertzuweisung, Pause und Schleife samt Prüfung', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });

  const write = await actionsRepo.addAction(db, room.id, beamerOnInput());
  assert.equal(write.type, 'write');
  assert.match(write.description, /custom:\/\/Beamer auf 1 setzen/);

  const pause = await actionsRepo.addAction(db, room.id, { phase: 'on', type: 'pause', seconds: '2,5' });
  assert.equal(pause.config.seconds, 2.5);
  assert.match(pause.description, /Pause für 2,5 s/);

  const loop = await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'loop', repeats: '2', checkEnabled: ['0', '1'],
    checkTopic: 'custom://Steckdose', checkOperator: 'lt', checkValue: '10', checkIntervalSeconds: '120',
  });
  assert.equal(loop.config.repeats, 2);
  assert.equal(loop.config.checkEnabled, true);
  assert.equal(loop.config.checkIntervalSeconds, 120);
  assert.deepEqual(loop.config.check, { topic: 'custom://Steckdose', operator: 'lt', value: '10' });
  assert.match(loop.description, /Schleife · 2× durchlaufen · Prüfung alle 120 s: custom:\/\/Steckdose ist kleiner als 10/);

  await assert.rejects(() => actionsRepo.addAction(db, room.id, { phase: 'on', type: 'pause', seconds: '0' }), /Pause/);
  await assert.rejects(() => actionsRepo.addAction(db, room.id, { phase: 'on', type: 'loop', repeats: '0' }), /Durchläufe/);
  await assert.rejects(() => actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'loop', repeats: '1', checkEnabled: '1',
    checkTopic: 'custom://Steckdose', checkOperator: 'lt', checkValue: '10', checkIntervalSeconds: '1',
  }), /Prüfabstand/);
  await assert.rejects(() => actionsRepo.addAction(db, room.id, { phase: 'seitlich', type: 'pause', seconds: '1' }), /Aktionsfolge/);
  await assert.rejects(() => actionsRepo.addAction(db, room.id, {
    phase: 'on', type: 'write', topic: 'system://homeess/pv.current', value: '1',
  }), /schreibgeschützt/);

  // Aktionen wandern nur in Schleifen – nicht unter eine andere Aktion.
  await assert.rejects(() => actionsRepo.addAction(db, room.id, {
    ...beamerOnInput(), parentId: write.id,
  }), /nur in eine Schleife/);
  // …und nicht in die andere Folge ihrer Schleife.
  await assert.rejects(() => actionsRepo.addAction(db, room.id, {
    ...beamerOnInput({ phase: 'on' }), parentId: loop.id,
  }), /andere Aktionsfolge/);

  const inLoop = await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'write', topic: 'custom://Beamer', value: '0', parentId: loop.id,
  });
  const tree = await actionsRepo.actionTree(db, room.id);
  assert.deepEqual(tree.on.map((action) => action.id), [write.id, pause.id]);
  assert.deepEqual(tree.off.map((action) => action.id), [loop.id]);
  assert.deepEqual(tree.off[0].children.map((action) => action.id), [inLoop.id]);

  // Die Art bleibt beim Bearbeiten erhalten, die Konfiguration ändert sich.
  const edited = await actionsRepo.updateAction(db, room.id, pause.id, { type: 'write', seconds: '4' });
  assert.equal(edited.type, 'pause');
  assert.equal(edited.config.seconds, 4);

  // Die Schleife nimmt beim Löschen ihren Inhalt mit.
  assert.equal(await actionsRepo.deleteAction(db, room.id, loop.id), 2);
  assert.deepEqual((await actionsRepo.actionTree(db, room.id)).off, []);
  await close(db);
});

test('Layout verschiebt Aktionen zwischen Folgen und in Schleifen', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });
  const first = await actionsRepo.addAction(db, room.id, beamerOnInput());
  const second = await actionsRepo.addAction(db, room.id, { phase: 'on', type: 'pause', seconds: '1' });
  const loop = await actionsRepo.addAction(db, room.id, { phase: 'on', type: 'loop', repeats: '3' });

  await actionsRepo.updateLayout(db, room.id, {
    actions: [
      { id: loop.id, phase: 'on', parentId: null, position: 0 },
      { id: first.id, phase: 'on', parentId: loop.id, position: 0 },
      { id: second.id, phase: 'off', parentId: null, position: 0 },
    ],
  });
  const tree = await actionsRepo.actionTree(db, room.id);
  assert.deepEqual(tree.on.map((action) => action.id), [loop.id]);
  assert.deepEqual(tree.on[0].children.map((action) => action.id), [first.id]);
  assert.deepEqual(tree.off.map((action) => action.id), [second.id]);

  await assert.rejects(() => actionsRepo.updateLayout(db, room.id, { actions: [] }), /unvollständig/);
  await assert.rejects(() => actionsRepo.updateLayout(db, room.id, {
    actions: [
      { id: loop.id, phase: 'on', parentId: first.id, position: 0 },
      { id: first.id, phase: 'on', parentId: loop.id, position: 0 },
      { id: second.id, phase: 'off', parentId: null, position: 0 },
    ],
  }), /nur in eine Schleife/);
  await close(db);
});

test('Zustandswechsel spult die passende Aktionsfolge nacheinander ab', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });
  await actionsRepo.addAction(db, room.id, beamerOnInput());
  await actionsRepo.addAction(db, room.id, { phase: 'on', type: 'pause', seconds: '0.1' });
  await actionsRepo.addAction(db, room.id, {
    phase: 'on', type: 'write', topic: 'custom://Rollladen', operation: 'set', value: '100',
  });
  const loop = await actionsRepo.addAction(db, room.id, { phase: 'off', type: 'loop', repeats: '2' });
  await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'write', topic: 'custom://Beamer', value: '0', parentId: loop.id,
  });

  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await runtime.init(db);
    await runtime.setRoomState(db, room.id, true);
    await wait(250);
    assert.deepEqual(writes, [
      { topic: 'custom://Beamer', value: 1 },
      { topic: 'custom://Rollladen', value: 100 },
    ]);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, true);

    writes.length = 0;
    await runtime.setRoomState(db, room.id, false);
    await wait(60);
    // Zwei Durchläufe der Schleife – die übrige Folge bleibt unberührt.
    assert.deepEqual(writes, [
      { topic: 'custom://Beamer', value: 0 },
      { topic: 'custom://Beamer', value: 0 },
    ]);

    // Derselbe Wert erneut geschrieben: keine erneute Ausführung.
    writes.length = 0;
    await runtime.setRoomState(db, room.id, false);
    await wait(30);
    assert.deepEqual(writes, []);
  } finally {
    runtime.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Ein Schreiben auf den Raum-State schaltet den Kinomodus', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });
  await actionsRepo.addAction(db, room.id, beamerOnInput());
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await runtime.init(db);
    adapterRouter.write(rooms.stateTopic(room.id), 1);
    await wait(60);
    assert.deepEqual(writes, [{ topic: 'custom://Beamer', value: 1 }]);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, true);
    // Der Zustand ist zugleich lesbar im State-Bus.
    const cached = mqttClient.getCache().get(rooms.stateTopic(room.id));
    assert.equal(cached.value, 1);
  } finally {
    runtime.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Die Prüfung einer Schleife wiederholt nur diese Schleife und nur in ihrer Folge', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });
  await actionsRepo.addAction(db, room.id, { phase: 'off', type: 'write', topic: 'custom://Licht', value: '0' });
  const loop = await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'loop', repeats: '2', checkEnabled: '1',
    checkTopic: 'custom://Steckdose', checkOperator: 'lt', checkValue: '10', checkIntervalSeconds: '120',
  });
  await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'write', topic: 'custom://Beamer', value: '0', parentId: loop.id,
  });

  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await runtime.init(db);
    // Kinomodus aus: die Aus-Folge läuft einmal komplett.
    await runtime.setRoomState(db, room.id, true);
    await wait(40);
    writes.length = 0;
    await runtime.setRoomState(db, room.id, false);
    await wait(60);
    assert.equal(writes.length, 3, 'Licht + zwei Schleifendurchläufe');

    // Der Beamer zieht weiter Strom: die Prüfung schlägt fehl, nur die Schleife
    // läuft erneut (zwei Durchläufe, kein zweites Licht-Kommando).
    writes.length = 0;
    adapterRouter.ingestTopic('custom://Steckdose', 55);
    await runtime.checkLoops(Date.now() + 121000);
    await wait(60);
    assert.deepEqual(writes, [
      { topic: 'custom://Beamer', value: 0 },
      { topic: 'custom://Beamer', value: 0 },
    ]);

    // Beamer ist aus: die Prüfung trifft zu, es passiert nichts.
    writes.length = 0;
    adapterRouter.ingestTopic('custom://Steckdose', 5);
    await runtime.checkLoops(Date.now() + 242000);
    await wait(40);
    assert.deepEqual(writes, []);

    // Im Kinomodus „an" wird die Aus-Folge nicht mehr geprüft.
    await runtime.setRoomState(db, room.id, true);
    await wait(40);
    writes.length = 0;
    adapterRouter.ingestTopic('custom://Steckdose', 55);
    await runtime.checkLoops(Date.now() + 363000);
    await wait(40);
    assert.deepEqual(writes, []);
  } finally {
    runtime.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Ein unbekannter Prüfwert gilt als nicht erfüllt', () => {
  const loop = {
    id: 999999, type: 'loop',
    config: { repeats: 1, checkEnabled: true, checkIntervalSeconds: 120, check: { topic: 'custom://Unbekannt', operator: 'lt', value: '10' } },
  };
  assert.equal(runtime.checkFulfilled(loop), false);
});

test('Der Kinomodus steht als Schaltziel für Dashboard-Widgets bereit', async () => {
  const db = await freshDb();
  await run(db, `CREATE TABLE mess_schalt_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', group_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0, switch_topic TEXT NOT NULL DEFAULT '', remote_topic TEXT NOT NULL DEFAULT '',
    status_topic TEXT NOT NULL DEFAULT '', power_topic TEXT NOT NULL DEFAULT '', power_unit TEXT NOT NULL DEFAULT 'W',
    counter_topic TEXT NOT NULL DEFAULT '', counter_unit TEXT NOT NULL DEFAULT 'kWh', rated_power REAL,
    rated_power_unit TEXT NOT NULL DEFAULT 'W', priority INTEGER NOT NULL DEFAULT 4,
    use_group_priority INTEGER NOT NULL DEFAULT 0, desired_on INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0, function_key TEXT NOT NULL DEFAULT '',
    load_shed_enabled INTEGER NOT NULL DEFAULT 0, load_shed_phase TEXT NOT NULL DEFAULT 'l1', switch_group_id INTEGER)`);
  await run(db, `CREATE TABLE mess_schalt_actor_state (
    actor_id INTEGER PRIMARY KEY, last_counter_raw REAL, last_progress_ts INTEGER, derived_power_w REAL,
    counter_total_kwh REAL, day_key TEXT, day_start_kwh REAL, year_key TEXT, year_start_kwh REAL,
    prev_year_kwh REAL, power_energy_kwh REAL, power_energy_day_start_kwh REAL, last_power_ts INTEGER)`);
  await run(db, `CREATE TABLE mess_schalt_switch_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', remote_topic TEXT NOT NULL DEFAULT '',
    switch_as_unit INTEGER NOT NULL DEFAULT 0, timer_minutes REAL NOT NULL DEFAULT 0)`);
  const room = await rooms.createRoom(db, { name: 'Wohnzimmer' });

  const targets = await switches.listSwitchTargets(db);
  assert.deepEqual(targets, [{ id: `heimkino:${room.id}`, label: 'Kinomodus Raum Wohnzimmer', kind: 'Heimkino' }]);
  assert.equal(switches.normalizeSwitchTarget(`heimkino:${room.id}`), `heimkino:${room.id}`);
  assert.deepEqual(switches.parseSwitchTarget(`heimkino:${room.id}`), { kind: 'heimkino', id: room.id });

  const states = await switches.readSwitchStates(db, new Map(), [
    { id: 7, type: 'switch', sourceId: `heimkino:${room.id}` },
  ]);
  assert.deepEqual(states.get(7), { on: false, label: 'Kinomodus Wohnzimmer' });

  const originalPublish = mqttClient.publish;
  mqttClient.publish = () => true;
  try {
    await runtime.init(db);
    assert.deepEqual(await switches.commandSwitch(db, `heimkino:${room.id}`, true), { ok: true, blocked: false, missing: false });
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, true);
  } finally {
    runtime.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Die Übersicht zeigt Räume im Adapterdesign und verlinkt ihre eigene Seite', async () => {
  const html = renderHeimkino({
    rooms: [{
      id: 3, name: 'Wohnzimmer', cinemaOn: true, onCount: 2, offCount: 4,
      stateTopic: 'heimkino://raeume/3', remoteTopic: 'kino/sync',
      lastRunAt: null, lastResult: '', lastError: '',
    }],
  });
  assert.ok(html.includes('href="/heimkino/raum/3"'));
  assert.ok(html.includes('class="adapter-row hk-room-row"'));   // Zeilendesign der Adapterseite
  assert.ok(html.includes('adapter-badge--on'));
  assert.ok(html.includes('heimkino://raeume/3'));
  assert.ok(html.includes('kino/sync'));                          // Sync-Topic in eigener Spalte
  assert.ok(html.includes('action="/heimkino/rooms/3/state"'));
  assert.ok(html.includes('openHeimkinoRoomDialog(\'edit\', 3)'));
  assert.ok(html.includes('name="remoteTopic"'));                 // im Dialog pflegbar
  // Ein Raum ist kein Dialog: die Aktionsfolgen erscheinen nicht auf der Übersicht.
  assert.ok(!html.includes('hk-zone'));
});

// Jede Zeile der Übersicht ist ein eigenes Grid: Kopf- und Datenzeile müssen
// dieselbe Spurdefinition und gleich viele Zellen haben, und keine Spur darf
// inhaltsabhängig sein – sonst stünden die Überschriften nicht über den Spalten.
test('Kopf- und Raumzeile teilen sich Spaltenraster und Zellenzahl', () => {
  const html = renderHeimkino({
    rooms: [{
      id: 3, name: 'Wohnzimmer', cinemaOn: true, onCount: 2, offCount: 4,
      stateTopic: 'heimkino://raeume/3', remoteTopic: 'kino/sync',
      lastRunAt: null, lastResult: '', lastError: '',
    }],
  });
  const rows = html.match(/<div class="adapter-row hk-room-row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="adapter-row|<\/div>)/g) || [];
  const cells = (row) => (row.match(/<span[ >]/g) || []).length;
  const head = rows.find((row) => row.includes('adapter-row--head'));
  const data = rows.find((row) => !row.includes('adapter-row--head'));
  assert.ok(head && data);
  assert.equal(cells(head), 6);
  for (const cls of ['hk-col-state', 'hk-col-remote', 'hk-col-mode', 'hk-room-counts']) {
    assert.ok(head.includes(cls), `Kopfzelle ${cls} fehlt`);
    assert.ok(data.includes(cls), `Datenzelle ${cls} fehlt`);
  }

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const track = css.match(/\.hk-room-row \{[^}]*grid-template-columns:([^;]+);/);
  assert.ok(track, 'Spurdefinition der Raumzeile fehlt');
  assert.equal(track[1].split('minmax(0,').length - 1, 6);
  assert.ok(!/\bauto\b/.test(track[1]), 'inhaltsabhängige Spur würde die Kopfzeile verschieben');
});

test('Räume stehen alphanumerisch aufsteigend', async () => {
  const db = await freshDb();
  for (const name of ['Kino 10', 'Wohnzimmer', 'Kino 2', 'Atelier']) await rooms.createRoom(db, { name });
  assert.deepEqual((await rooms.listRooms(db)).map((room) => room.name), ['Atelier', 'Kino 2', 'Kino 10', 'Wohnzimmer']);
  await close(db);
});

test('Das Sync-Topic hält den Kinomodus bidirektional synchron', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino', remoteTopic: 'kino/sync' });
  assert.equal(room.remoteTopic, 'kino/sync');
  await actionsRepo.addAction(db, room.id, beamerOnInput());
  await actionsRepo.addAction(db, room.id, { phase: 'off', type: 'write', topic: 'custom://Beamer', value: '0' });

  const writes = [];
  const originalPublish = mqttClient.publish;
  const originalEpoch = mqttClient.getConnectEpoch;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  const feedRemote = (value) => bus.ingest([rooms.remoteCacheKey(room.id)], value, { topic: 'kino/sync' });
  try {
    await runtime.init(db);

    // Neustart: der retained Wert des Sync-Topics ist maßgeblich und wird
    // übernommen, ohne die Aktionsfolge zu durchlaufen.
    feedRemote(1);
    await runtime.syncRemotes();
    await wait(40);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, true);
    assert.deepEqual(writes, []);

    // Externe Änderung auf aus: schaltet den Raum inklusive Aktionsfolge.
    feedRemote(0);
    await runtime.syncRemotes();
    await wait(40);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, false);
    assert.deepEqual(writes, [{ topic: 'custom://Beamer', value: 0 }]);

    // Lokal eingeschaltet: das Sync-Topic wird sofort nachgezogen.
    writes.length = 0;
    await runtime.setRoomState(db, room.id, true);
    await wait(40);
    assert.deepEqual(writes, [
      { topic: 'kino/sync', value: '1' },
      { topic: 'custom://Beamer', value: 1 },
    ]);

    // Das eigene Echo gilt nicht als Schaltwunsch.
    writes.length = 0;
    feedRemote(1);
    await runtime.syncRemotes();
    await wait(40);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, true);
    assert.deepEqual(writes, []);

    // Nach einem MQTT-Reconnect ist der erneut eingespielte retained-Wert nur
    // die neue Ausgangsbasis: übernommen, aber ohne Aktionsfolge.
    writes.length = 0;
    mqttClient.getConnectEpoch = () => originalEpoch() + 1;
    feedRemote(0);
    await runtime.syncRemotes();
    await wait(40);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, false);
    assert.deepEqual(writes, []);
  } finally {
    runtime.stop();
    mqttClient.publish = originalPublish;
    mqttClient.getConnectEpoch = originalEpoch;
    await close(db);
  }
});

test('Ohne Sync-Topic bleibt alles beim Alten', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await runtime.init(db);
    await runtime.tick(Date.now() + 60000);
    assert.deepEqual(writes, []);
    assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, false);
  } finally {
    runtime.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Die Raumseite zeigt beide Aktionsfolgen mit Dragflächen und Schleifen', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { name: 'Kino' });
  await actionsRepo.addAction(db, room.id, beamerOnInput());
  const loop = await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'loop', repeats: '2', checkEnabled: '1',
    checkTopic: 'custom://Steckdose', checkOperator: 'lt', checkValue: '10', checkIntervalSeconds: '120',
  });
  await actionsRepo.addAction(db, room.id, {
    phase: 'off', type: 'write', topic: 'custom://Beamer', value: '0', parentId: loop.id,
  });
  const html = renderHeimkinoRoom({
    room: { ...(await rooms.getRoom(db, room.id)), stateTopic: rooms.stateTopic(room.id) },
    tree: await actionsRepo.actionTree(db, room.id),
    actions: await actionsRepo.listActions(db, room.id),
  });

  assert.ok(html.includes('Aktionsfolge An'));
  assert.ok(html.includes('Aktionsfolge Aus'));
  assert.ok(html.includes('data-phase="on"'));
  assert.ok(html.includes('data-phase="off"'));
  assert.ok(html.includes('class="widget-drag hk-drag"'));      // Dragfläche je Aktion
  assert.ok(html.includes('hk-loop-zone'));                      // Schleife nimmt Aktionen auf
  assert.ok(html.includes(`data-parent-id="${loop.id}"`));
  assert.ok(html.includes('heimkinoLayoutPayload'));             // Drag&Drop speichert das Layout
  assert.ok(html.includes('/heimkino/raum/'));
  assert.ok(html.includes('Wert zuweisen'));
  assert.ok(html.includes('>Pause<'));
  assert.ok(html.includes('>Schleife<'));
  assert.ok(html.includes('Zyklisch prüfen'));
  assert.ok(html.includes('Prüfabstand in Sekunden'));
  await close(db);
});
