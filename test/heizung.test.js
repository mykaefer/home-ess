'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const bus = require('../src/state-bus');
const rooms = require('../src/heizung/rooms');
const actionsRepo = require('../src/heizung/actions');
const central = require('../src/heizung/central');
const billing = require('../src/heizung/billing');
const runtime = require('../src/heizung/runtime');
const modules = require('../src/modules');
const mqttClient = require('../src/mqtt/client');
const levelHandler = require('../src/operating-level/handler');
const { ENVIRONMENT_STATE_IDS } = require('../src/mqtt/config');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
}
function close(db) { return new Promise((resolve) => db.close(resolve)); }

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE heizung_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    position INTEGER NOT NULL DEFAULT 0, target_temp REAL NOT NULL DEFAULT 21,
    heat_offset REAL NOT NULL DEFAULT 0, cool_offset REAL NOT NULL DEFAULT 5,
    cool_min_temp REAL,
    hysteresis REAL NOT NULL DEFAULT 0.5, thermostat_topic TEXT NOT NULL DEFAULT '',
    heat_priority INTEGER NOT NULL DEFAULT 2, cool_priority INTEGER NOT NULL DEFAULT 4,
    heat_central_fallback INTEGER NOT NULL DEFAULT 0,
    heat_topic TEXT NOT NULL DEFAULT '', cool_topic TEXT NOT NULL DEFAULT '',
    central_allowed INTEGER NOT NULL DEFAULT 0, central_temp REAL,
    fan_topic TEXT NOT NULL DEFAULT '',
    contact_delay_seconds INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '')`);
  await run(db, `CREATE TABLE heizung_room_sensors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`);
  await run(db, `CREATE TABLE heizung_room_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL, inverted INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0)`);
  await run(db, `CREATE TABLE heizung_central (
    id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'relais', switch_topic TEXT NOT NULL DEFAULT '',
    outdoor_topic TEXT NOT NULL DEFAULT '',
    flow_topic TEXT NOT NULL DEFAULT '', return_topic TEXT NOT NULL DEFAULT '',
    burner_feedback_topic TEXT NOT NULL DEFAULT '',
    pump_topic TEXT NOT NULL DEFAULT '', pump_lead_seconds INTEGER NOT NULL DEFAULT 30,
    pump_lag_seconds INTEGER NOT NULL DEFAULT 300,
    flow_window_seconds INTEGER NOT NULL DEFAULT 120, flow_drop_delta REAL NOT NULL DEFAULT 0.3,
    max_hold_minutes INTEGER NOT NULL DEFAULT 0, consumption_per_hour REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'l', price_per_unit REAL NOT NULL DEFAULT 0,
    sweep_enabled INTEGER NOT NULL DEFAULT 0, sweep_started_at INTEGER)`);
  await run(db, `CREATE TABLE heizung_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('heat_on', 'heat_off', 'cool_on', 'cool_off')),
    parent_id INTEGER, type TEXT NOT NULL CHECK (type IN ('write', 'pause', 'loop')),
    position INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}')`);
  await run(db, `CREATE TABLE heizung_billing (
    id INTEGER PRIMARY KEY CHECK (id = 1), started_at INTEGER,
    start_consumption REAL NOT NULL DEFAULT 0, previous_started_at INTEGER, previous_ended_at INTEGER,
    previous_consumption REAL, previous_cost REAL, previous_metered REAL,
    last_calibration_at INTEGER, last_calibration_factor REAL)`);
  await run(db, `CREATE TABLE heizung_burner_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '')`);
  await run(db, 'CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)');
  await modules.setEnabled(db, 'heizung', true);
  // Freier Betrieb: die Prioritäten der Geräte sind damit abgedeckt. Die
  // Sperre bei zu niedrigem Level prüft ein eigener Test.
  levelHandler.applyLevel(5);
  return db;
}

function feed(key, value) {
  bus.ingest([key], value, { topic: key });
}

const baseRoom = {
  name: 'Wohnzimmer', targetTemp: '21', heatOffset: '0', coolOffset: '5', hysteresis: '0.5',
};

// Einfachster Fall: je eine Wertzuweisung für „ein" und „aus".
async function addSwitchSequences(db, roomId, device, topic) {
  await actionsRepo.addAction(db, roomId, {
    phase: `${device}_on`, type: 'write', topic, operation: 'set', value: '1',
  });
  await actionsRepo.addAction(db, roomId, {
    phase: `${device}_off`, type: 'write', topic, operation: 'set', value: '0',
  });
}

// Zuletzt an ein Topic geschriebener Wert.
function lastWrite(writes, topic) {
  const hit = writes.filter((write) => write.topic === topic).at(-1);
  return hit ? hit.value : null;
}

// Schreibvorgänge einsammeln statt zu senden.
function captureWrites() {
  const writes = [];
  const original = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  return { writes, restore: () => { mqttClient.publish = original; } };
}

test('Räume prüfen ihre Eingaben und liefern ihre Werte als States', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { ...baseRoom, name: ' Wohnzimmer ' });
  assert.equal(room.name, 'Wohnzimmer');
  assert.equal(room.targetTemp, 21);
  assert.equal(room.coolOffset, 5);
  assert.equal(room.centralAllowed, false);
  // Modulwerte sind Systemwerte und tragen den Raumnamen, nicht seine Nummer.
  assert.equal(rooms.stateTopic(room.name, 'temperatur'), 'system://homeess/raeume.Wohnzimmer.temperatur');
  assert.equal(rooms.stateTopic('Bad unten', 'soll'), 'system://homeess/raeume.Bad_unten.soll');
  // Punkte im Namen würden die id-Ebenen zerlegen und werden ersetzt.
  assert.equal(rooms.stateId('Zimmer 1.OG', 'temperatur'), 'raeume.Zimmer_1_OG.temperatur');

  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, name: 'wohnzimmer' }), /gibt es bereits/);
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, name: 'Bad/Dusche' }), /Schrägstrich/);
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, name: 'Bad', targetTemp: 'warm' }), /Soll-Temperatur/);
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, name: 'Bad', hysteresis: '99' }), /Schalthysterese/);
  // Freigabe ohne Grenztemperatur ist unvollständig. Die Grenze ist eine
  // Außentemperatur und darf deshalb auch über der Soll-Temperatur liegen.
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, name: 'Bad', centralAllowed: '1' }), /Außentemperatur angeben/);
  const mild = await rooms.createRoom(db,
    { ...baseRoom, name: 'Bad', centralAllowed: '1', centralTemp: '15' });
  assert.equal(mild.centralTemp, 15);
  await rooms.deleteRoom(db, mild.id);

  // Die States liegen im Ordner „Räume/<Raum>" der Systemwerte.
  const [ist, soll] = rooms.roomEntries(room, { temperature: 20.5, targetTemp: 21 });
  assert.equal(ist.id, 'raeume.Wohnzimmer.temperatur');
  assert.equal(ist.category, 'Räume/Wohnzimmer');
  assert.equal(ist.label, 'Wohnzimmer – Temperatur');
  assert.equal(ist.writable, false);
  assert.equal(ist.display, '20,5 °C');
  assert.equal(soll.category, 'Räume/Wohnzimmer');
  assert.equal(soll.writable, true);

  // Zwei Namen dürfen nicht auf dasselbe Topic fallen.
  const bad = await rooms.createRoom(db, { ...baseRoom, name: 'Bad 1' });
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, name: 'Bad_1' }), /belegt bereits die States/);
  await rooms.deleteRoom(db, bad.id);

  await rooms.deleteRoom(db, room.id);
  assert.deepEqual(await rooms.listRooms(db), []);
  await close(db);
});

test('Mehrere Temperaturquellen ergeben den Durchschnitt, unplausible Werte fallen heraus', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  const first = await rooms.addSensor(db, room.id, { name: 'Fensterseite', topic: 'hdp://sensor/1' });
  const second = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/2' });
  const broken = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/3' });
  const sensors = await rooms.listSensors(db, room.id);
  assert.equal(sensors.length, 3);
  assert.equal(sensors[1].name, 'hdp://sensor/2'); // ohne Bezeichnung zählt das Topic

  const cache = new Map();
  cache.set(rooms.sensorCacheKey(first), { value: 20 });
  assert.deepEqual(rooms.averageTemperature(cache, sensors), { value: 20, count: 1 });
  cache.set(rooms.sensorCacheKey(second), { value: '22,5' });
  assert.deepEqual(rooms.averageTemperature(cache, sensors), { value: 21.25, count: 2 });
  // Störwerte (Sensorausfall) verfälschen den Durchschnitt nicht.
  cache.set(rooms.sensorCacheKey(broken), { value: -999 });
  assert.deepEqual(rooms.averageTemperature(cache, sensors), { value: 21.25, count: 2 });
  assert.deepEqual(rooms.averageTemperature(new Map(), sensors), { value: null, count: 0 });

  await rooms.deleteSensor(db, room.id, second);
  assert.equal((await rooms.listSensors(db, room.id)).length, 2);
  await close(db);
});

test('Hysterese hält Heizen und Kühlen zwischen Ein- und Ausschaltpunkt', () => {
  // Soll 21, Heiz-Offset 0, Hysterese 0,5: ein unter 21, aus erst ab 21,5.
  assert.equal(runtime.hystereticBelow(false, 21.2, 21, 0.5), false);
  assert.equal(runtime.hystereticBelow(false, 20.9, 21, 0.5), true);
  assert.equal(runtime.hystereticBelow(true, 21.2, 21, 0.5), true);
  assert.equal(runtime.hystereticBelow(true, 21.6, 21, 0.5), false);
  // Kühlen bei Soll + 5 = 26: ein über 26, aus erst unter 25,5.
  assert.equal(runtime.hystereticAbove(false, 25.8, 26, 0.5), false);
  assert.equal(runtime.hystereticAbove(false, 26.2, 26, 0.5), true);
  assert.equal(runtime.hystereticAbove(true, 25.8, 26, 0.5), true);
  assert.equal(runtime.hystereticAbove(true, 25.2, 26, 0.5), false);
  // Ohne Messwert wird nicht geschaltet.
  assert.equal(runtime.hystereticBelow(true, null, 21, 0.5), false);
});

test('Raum heizt, kühlt und meldet Wärmebedarf an die Zentralheizung', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { ...baseRoom, centralAllowed: '1', centralTemp: '4' });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  await addSwitchSequences(db, room.id, 'heat', 'custom://Heizung');
  await addSwitchSequences(db, room.id, 'cool', 'custom://Klima');
  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 19);
    await runtime.tick();
    let state = runtime.snapshot().get(room.id);
    assert.equal(state.temperature, 19);
    assert.equal(state.heating, true);
    assert.equal(state.cooling, false);
    assert.equal(state.centralDemand, false);
    assert.equal(lastWrite(capture.writes, 'custom://Heizung'), 1);

    // Innerhalb der Hysterese bleibt das Heizgerät an.
    capture.writes.length = 0;
    feed(rooms.sensorCacheKey(sensor), 21.2);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).heating, true);
    assert.deepEqual(capture.writes, []);

    feed(rooms.sensorCacheKey(sensor), 21.6);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).heating, false);
    assert.equal(lastWrite(capture.writes, 'custom://Heizung'), 0);

    // Über Soll + 5 °C kühlt die Splitklimaanlage.
    feed(rooms.sensorCacheKey(sensor), 26.5);
    await runtime.tick();
    state = runtime.snapshot().get(room.id);
    assert.equal(state.cooling, true);
    assert.equal(state.heating, false);
    assert.equal(lastWrite(capture.writes, 'custom://Klima'), 1);

    // Solange es draußen mild ist, deckt das lokale Gerät den Wärmebedarf —
    // die Raumtemperatur allein löst keine Zentralheizung aus. Ohne eigene
    // Quelle zählt die systemweite Außentemperatur.
    feed(rooms.sensorCacheKey(sensor), 3.5);
    feed(ENVIRONMENT_STATE_IDS.outdoorTemperature, 12);
    await runtime.tick();
    state = runtime.snapshot().get(room.id);
    assert.equal(state.heatDemand, true);
    assert.equal(state.centralDemand, false);
    assert.equal(state.heating, true);

    // Erst unter der Grenz-Außentemperatur übernimmt die Zentralheizung; das
    // lokale Heizgerät bleibt dann aus.
    feed(ENVIRONMENT_STATE_IDS.outdoorTemperature, 3);
    await runtime.tick();
    state = runtime.snapshot().get(room.id);
    assert.equal(state.centralDemand, true);
    assert.equal(state.heating, false);
    assert.equal(lastWrite(capture.writes, 'custom://Heizung'), 0);

    // Draußen wieder mild: das lokale Gerät übernimmt zurück.
    feed(ENVIRONMENT_STATE_IDS.outdoorTemperature, 12);
    await runtime.tick();
    state = runtime.snapshot().get(room.id);
    assert.equal(state.centralDemand, false);
    assert.equal(state.heating, true);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Offene Kontakte sperren erst nach der eingestellten Verzögerung', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { ...baseRoom, contactDelaySeconds: '300' });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  await addSwitchSequences(db, room.id, 'heat', 'custom://Heizung');
  const contact = await rooms.addContact(db, room.id, { name: 'Fenster', topic: 'custom://Fenster' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 19);
    feed(rooms.contactCacheKey(contact), 0);
    const start = Date.now();
    await runtime.tick(start);
    assert.equal(runtime.snapshot().get(room.id).heating, true);

    // Kurzes Lüften: der Kontakt ist offen, die Verzögerung läuft noch.
    feed(rooms.contactCacheKey(contact), 1);
    await runtime.tick(start + 60000);
    let state = runtime.snapshot().get(room.id);
    assert.equal(state.contactOpen, false);
    assert.equal(state.contactPending, true);
    assert.equal(state.heating, true);

    // Fünf Minuten nach dem Öffnen wird abgeschaltet.
    await runtime.tick(start + 361000);
    state = runtime.snapshot().get(room.id);
    assert.equal(state.contactOpen, true);
    assert.equal(state.heating, false);
    assert.equal(lastWrite(capture.writes, 'custom://Heizung'), 0);

    // Schließen wirkt sofort.
    feed(rooms.contactCacheKey(contact), 0);
    await runtime.tick(start + 362000);
    state = runtime.snapshot().get(room.id);
    assert.equal(state.contactOpen, false);
    assert.equal(state.heating, true);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Ohne Geräte erfasst der Raum nur seine Temperatur', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 12);
    await runtime.tick();
    const state = runtime.snapshot().get(room.id);
    assert.equal(state.temperature, 12);
    assert.equal(state.heating, false);
    assert.equal(state.cooling, false);
    assert.equal(state.centralDemand, false);
    assert.deepEqual(capture.writes, []);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Der Kessel bleibt an, solange der Brenner feuert', async () => {
  const config = { mode: 'relais', flowWindowSeconds: 120, maxHoldMinutes: 0 };
  const now = Date.now();
  const waiting = { offRequestedAt: now };
  // Brenner feuert noch: der Kessel darf keinesfalls abgeschaltet werden.
  const running = runtime.mayStopBoiler(config, waiting, { on: true, source: 'flow' }, now + 30000);
  assert.equal(running.ok, false);
  assert.match(running.reason, /Brenner läuft noch/);
  // Brenner aus: jetzt darf abgeschaltet werden.
  assert.equal(runtime.mayStopBoiler(config, waiting, { on: false, source: 'flow' }, now + 30000).ok, true);
  // Ohne jede Erkennungsmöglichkeit greift das Zeitfenster.
  const blind = { on: true, source: 'switch' };
  assert.equal(runtime.mayStopBoiler(config, waiting, blind, now + 60000).ok, false);
  assert.equal(runtime.mayStopBoiler(config, waiting, blind, now + 121000).ok, true);
  // Notabschaltung nur, wenn sie eingestellt ist.
  assert.equal(runtime.mayStopBoiler({ ...config, maxHoldMinutes: 30 }, waiting,
    { on: true, source: 'flow' }, now + 1810000).ok, true);
  // Bei Modbus regelt die Anlage selbst.
  assert.equal(runtime.mayStopBoiler({ ...config, mode: 'modbus' }, waiting,
    { on: true, source: 'flow' }, now).ok, true);
});


test('Zentralheizung läuft bei Wärmeanforderung und protokolliert die Laufzeit', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    flowTopic: 'custom://Vorlauf', returnTopic: 'custom://Ruecklauf',
    consumptionPerHour: '2', unit: 'l', pricePerUnit: '1,20', flowDropDelta: '0.3',
  });
  const room = await rooms.createRoom(db, { ...baseRoom, centralAllowed: '1', centralTemp: '5' });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    const start = Date.now();
    feed(rooms.sensorCacheKey(sensor), 17);
    feed(central.flowCacheKey('outdoor'), 2);
    feed(central.flowCacheKey('flow'), 40);
    feed(central.flowCacheKey('return'), 30);
    await runtime.tick(start);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    assert.equal(runtime.centralSnapshot().demandCount, 1);
    assert.equal(lastWrite(capture.writes, 'custom://Brenner'), '1');

    // Der Vorlauf steigt über mehrere Messwerte: ab dem dritten Anstieg gilt
    // der Brenner als an (eine einzelne Schwankung reicht nicht).
    feed(central.flowCacheKey('flow'), 42);
    await runtime.tick(start + 30000);
    assert.equal(runtime.centralSnapshot().burnerOn, false);
    feed(central.flowCacheKey('flow'), 44);
    await runtime.tick(start + 60000);
    assert.equal(runtime.centralSnapshot().burnerOn, false);
    feed(central.flowCacheKey('flow'), 46);
    await runtime.tick(start + 90000);
    assert.equal(runtime.centralSnapshot().burnerOn, true);

    // Anforderung entfällt (Raum warm genug). Der Brenner feuert noch, deshalb
    // bleibt der Kessel an — auch in der Halte-Phase, in der die Temperatur
    // steht.
    feed(rooms.sensorCacheKey(sensor), 22);
    feed(central.flowCacheKey('flow'), 46);
    await runtime.tick(start + 120000);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    assert.equal(runtime.centralSnapshot().burnerOn, true);
    assert.match(runtime.centralSnapshot().note, /Brenner läuft noch/);

    // Der Vorlauf sinkt über mehrere Messwerte: der Brenner gilt als aus …
    feed(central.flowCacheKey('flow'), 45.5);
    await runtime.tick(start + 150000);
    feed(central.flowCacheKey('flow'), 45);
    await runtime.tick(start + 180000);
    assert.equal(runtime.centralSnapshot().burnerOn, true);
    feed(central.flowCacheKey('flow'), 44.5);
    await runtime.tick(start + 210000);
    assert.equal(runtime.centralSnapshot().burnerOn, false);

    // … und damit darf auch der Kessel abschalten.
    await runtime.tick(start + 240000);
    assert.equal(runtime.centralSnapshot().boilerOn, false);
    assert.equal(lastWrite(capture.writes, 'custom://Brenner'), '0');

    // Protokolliert wird allein die Brennphase: 90 s bis 210 s = zwei Minuten,
    // obwohl der Kessel vier Minuten eingeschaltet war.
    const runs = await central.listRuns(db, 10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].duration_ms, 120000);
    assert.match(runs[0].reason, /Vorlauftemperatur/);
    const config = await central.loadCentralConfig(db);
    const stats = await central.burnerStatistics(db, config);
    // Zwei Minuten × 2 l/h = 0,0667 l; bei 1,20 €/l rund 0,08 €.
    assert.ok(Math.abs(stats.total.consumption - 0.0667) < 0.001, String(stats.total.consumption));
    assert.ok(Math.abs(stats.total.cost - 0.08) < 0.001, String(stats.total.cost));
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Schornsteinfeger-Modus dreht alle Räume auf und hält die lokalen Geräte aus', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
  });
  const room = await rooms.createRoom(db, {
    ...baseRoom, thermostatTopic: 'custom://Thermostat', centralAllowed: '1', centralTemp: '4',
  });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  await addSwitchSequences(db, room.id, 'heat', 'custom://Heizung');
  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 19);
    feed(central.flowCacheKey('outdoor'), 12);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).heating, true);

    // Im Schornsteinfeger-Modus zählt die Außentemperatur nicht: alle Räume
    // fordern die Zentralheizung an, die lokalen Geräte bleiben aus.
    capture.writes.length = 0;
    await runtime.setSweepMode(true);
    const state = runtime.snapshot().get(room.id);
    assert.equal(state.heating, false);
    assert.equal(state.centralDemand, true);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    // Das Thermostat bekommt 28 °C, die eingestellte Soll-Temperatur bleibt.
    assert.deepEqual(capture.writes.find((write) => write.topic === 'custom://Thermostat'),
      { topic: 'custom://Thermostat', value: 28 });
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 21);

    await runtime.setSweepMode(false);
    assert.equal(runtime.centralSnapshot().boilerOn, false);
    assert.equal((await central.loadCentralConfig(db)).sweepEnabled, false);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Zentralheizung verlangt beim Schaltaktor Vor- und Rücklauf', async () => {
  const db = await freshDb();
  await assert.rejects(() => central.saveCentralConfig(db, { enabled: '1', mode: 'relais' }),
    /State zum Schalten/);
  // Ohne irgendeine Außentemperatur könnte kein Raum die Zentralheizung je
  // anfordern (die Test-Datenbank hat auch keine systemweite).
  await assert.rejects(() => central.saveCentralConfig(db,
    { enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner' }), /Außentemperatur auswählen/);
  await assert.rejects(() => central.saveCentralConfig(db,
    { enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen' }),
  /Vorlauf- und Rücklauftemperatur/);
  // Bei Modbus regelt die Anlage selbst, dort genügen Schalt-State und Außen.
  const config = await central.saveCentralConfig(db,
    { enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen' });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'modbus');
  assert.equal(config.outdoorTopic, 'custom://Aussen');
  await close(db);
});

test('Soll-Temperatur ist über ihren State beschreibbar', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  // Hier läuft bewusst der echte Schreibweg (kein Stub): der Raum hat keine
  // Geräte, es geht also nichts an den Broker.
  try {
    await runtime.init(db);
    // Schreiben auf system://homeess/raeume.<Raum>.soll ist ausdrücklich
    // freigegeben, obwohl Systemwerte sonst schreibgeschützt sind.
    mqttClient.publish(rooms.stateTopic(room.name, 'soll'), '19,5');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 19.5);
    // Der gemeldete Wert steht im State-Bus.
    const entry = bus.getCache().get(rooms.stateTopic(room.name, 'soll'));
    assert.equal(entry && entry.value, 19.5);
  } finally {
    runtime.stop();
    await close(db);
  }
});

test('Außentemperatur kommt systemweit oder aus der eigenen Quelle', () => {
  const cache = new Map();
  cache.set(ENVIRONMENT_STATE_IDS.outdoorTemperature, { value: '7,5' });
  cache.set(central.flowCacheKey('outdoor'), { value: 2 });
  // Ohne eigenes Topic zählt die systemweite Außentemperatur …
  assert.equal(central.readOutdoorTemperature({ outdoorTopic: '' }, cache), 7.5);
  // … mit eigenem Topic gewinnt dieses.
  assert.equal(central.readOutdoorTemperature({ outdoorTopic: 'custom://Aussen' }, cache), 2);
  // Ohne jeden Wert bleibt sie unbekannt.
  assert.equal(central.readOutdoorTemperature({ outdoorTopic: '' }, new Map()), null);
  assert.equal(central.readOutdoorTemperature({ outdoorTopic: 'custom://Aussen' }, new Map()), null);
});

test('Umbenennen zieht die States mit und lässt keine Karteileichen zurück', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 20);
    await runtime.tick();
    assert.equal(bus.getCache().get('system://homeess/raeume.Wohnzimmer.temperatur').value, 20);

    await rooms.updateRoom(db, room.id, { ...baseRoom, name: 'Wohnzimmer Süd' });
    await runtime.reload();
    await runtime.tick();
    // Neues Topic trägt den Wert, das alte ist verschwunden.
    assert.equal(bus.getCache().get('system://homeess/raeume.Wohnzimmer_Süd.temperatur').value, 20);
    assert.equal(bus.getCache().get('system://homeess/raeume.Wohnzimmer.temperatur'), undefined);

    // Auch der Schreibzugriff findet den Raum unter seinem neuen Namen.
    mqttClient.publish('system://homeess/raeume.Wohnzimmer_Süd.soll', '18');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 18);
  } finally {
    runtime.stop();
    await close(db);
  }
});

test('Geräte werden über Aktionsfolgen geschaltet, nicht über ein festes Topic', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  // Eine Splitklimaanlage braucht Betriebsart, Solltemperatur und Einschalten
  // nacheinander — genau dafür gibt es die Folgen.
  await actionsRepo.addAction(db, room.id, {
    phase: 'heat_on', type: 'write', topic: 'custom://Klima/Modus', operation: 'set', value: 'heat',
  });
  await actionsRepo.addAction(db, room.id, { phase: 'heat_on', type: 'pause', seconds: '0.05' });
  await actionsRepo.addAction(db, room.id, {
    phase: 'heat_on', type: 'write', topic: 'custom://Klima/Power', operation: 'set', value: '1',
  });
  await actionsRepo.addAction(db, room.id, {
    phase: 'heat_off', type: 'write', topic: 'custom://Klima/Power', operation: 'set', value: '0',
  });

  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 19);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(runtime.snapshot().get(room.id).heating, true);
    // Reihenfolge und Pause der Folge werden eingehalten.
    assert.deepEqual(capture.writes, [
      { topic: 'custom://Klima/Modus', value: 'heat' },
      { topic: 'custom://Klima/Power', value: 1 },
    ]);

    // Kein Wechsel: die Folge läuft nicht erneut.
    capture.writes.length = 0;
    await runtime.tick();
    assert.deepEqual(capture.writes, []);

    feed(rooms.sensorCacheKey(sensor), 22);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runtime.snapshot().get(room.id).heating, false);
    assert.deepEqual(capture.writes, [{ topic: 'custom://Klima/Power', value: 0 }]);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Eine Schleife prüft zyklisch nach und spult nur sich selbst erneut ab', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  const loop = await actionsRepo.addAction(db, room.id, {
    phase: 'heat_on', type: 'loop', repeats: '1', checkEnabled: '1',
    checkTopic: 'custom://Klima/Status', checkOperator: 'eq', checkValue: '1', checkIntervalSeconds: '5',
  });
  await actionsRepo.addAction(db, room.id, {
    phase: 'heat_on', type: 'write', topic: 'custom://Klima/Power', operation: 'set', value: '1',
    parentId: loop.id,
  });

  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 19);
    // Der IR-Befehl kommt nicht an: die Rückmeldung bleibt auf 0.
    feed('heizung:action:' + loop.id + ':check', 0);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(capture.writes.length, 1);

    // Nach dem Prüfabstand wird die Schleife erneut abgespult.
    capture.writes.length = 0;
    runtime.checkLoops(Date.now() + 6000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(capture.writes, [{ topic: 'custom://Klima/Power', value: 1 }]);

    // Sobald die Rückmeldung stimmt, bleibt es ruhig.
    capture.writes.length = 0;
    feed('heizung:action:' + loop.id + ':check', 1);
    runtime.checkLoops(Date.now() + 12000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(capture.writes, []);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Ohne „ein"-Folge hat der Raum kein Gerät', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, baseRoom);
  assert.equal(actionsRepo.hasDevice(await actionsRepo.actionTree(db, room.id), 'heat'), false);
  await actionsRepo.addAction(db, room.id, {
    phase: 'heat_off', type: 'write', topic: 'custom://Heizung', operation: 'set', value: '0',
  });
  // Nur eine „aus"-Folge macht noch kein Heizgerät.
  assert.equal(actionsRepo.hasDevice(await actionsRepo.actionTree(db, room.id), 'heat'), false);
  await actionsRepo.addAction(db, room.id, {
    phase: 'heat_on', type: 'write', topic: 'custom://Heizung', operation: 'set', value: '1',
  });
  assert.equal(actionsRepo.hasDevice(await actionsRepo.actionTree(db, room.id), 'heat'), true);
  // Folgen anderer Module bleiben unberührt.
  await assert.rejects(() => actionsRepo.addAction(db, room.id, { phase: 'on', type: 'pause', seconds: '1' }),
    /Aktionsfolge ist ungültig/);
  await close(db);
});

test('Die Umwälzpumpe läuft vor dem Brenner an und nach ihm nach', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    flowTopic: 'custom://Vorlauf', returnTopic: 'custom://Ruecklauf',
    pumpTopic: 'custom://Pumpe', pumpLeadSeconds: '60', pumpLagSeconds: '300', flowDropDelta: '0.3',
  });
  const room = await rooms.createRoom(db, { ...baseRoom, centralAllowed: '1', centralTemp: '5' });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    const start = Date.now();
    feed(rooms.sensorCacheKey(sensor), 17);
    feed(central.flowCacheKey('outdoor'), 2);
    feed(central.flowCacheKey('flow'), 40);
    feed(central.flowCacheKey('return'), 30);

    // Erster Takt: nur die Pumpe läuft an, der Brenner wartet.
    await runtime.tick(start);
    assert.equal(runtime.centralSnapshot().pumpOn, true);
    assert.equal(runtime.centralSnapshot().boilerOn, false);
    assert.deepEqual(capture.writes, [{ topic: 'custom://Pumpe', value: '1' }]);
    assert.match(runtime.centralSnapshot().note, /Umwälzpumpe läuft an/);

    // Meldet die Pumpe zurück, der Vorlauf ist aber noch nicht abgelaufen:
    // der Brenner bleibt aus.
    feed(central.flowCacheKey('pump'), 1);
    await runtime.tick(start + 30000);
    assert.equal(runtime.centralSnapshot().boilerOn, false);

    // Nach dem Vorlauf darf der Brenner starten.
    capture.writes.length = 0;
    await runtime.tick(start + 61000);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    assert.deepEqual(capture.writes, [{ topic: 'custom://Brenner', value: '1' }]);

    // Anforderung entfällt. Der Vorlauf steht (der Brenner gilt damit nicht als
    // feuernd), also darf der Kessel abschalten — die Pumpe läuft nach.
    capture.writes.length = 0;
    feed(rooms.sensorCacheKey(sensor), 22);
    await runtime.tick(start + 125000);
    assert.equal(runtime.centralSnapshot().boilerOn, false);
    assert.equal(runtime.centralSnapshot().pumpOn, true);
    assert.deepEqual(capture.writes, [{ topic: 'custom://Brenner', value: '0' }]);
    assert.match(runtime.centralSnapshot().note, /läuft nach/);

    // Erst nach der Nachlaufzeit schaltet auch die Pumpe ab.
    capture.writes.length = 0;
    await runtime.tick(start + 400000);
    assert.equal(runtime.centralSnapshot().pumpOn, true);
    await runtime.tick(start + 426000);
    assert.equal(runtime.centralSnapshot().pumpOn, false);
    assert.deepEqual(capture.writes, [{ topic: 'custom://Pumpe', value: '0' }]);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Ohne laufende Pumpe startet der Brenner nicht', () => {
  const config = { mode: 'relais', pumpTopic: 'custom://Pumpe', pumpLeadSeconds: 60 };
  // Ohne Pumpe im Betrieb gibt es keine Freigabe.
  assert.equal(runtime.pumpReady(config, Date.now()).ok, false);
  // Ohne hinterlegte Pumpe entfällt die Bedingung.
  assert.equal(runtime.pumpReady({ mode: 'relais', pumpTopic: '' }, Date.now()).ok, true);
  // Bei Modbus regelt die Anlage ihre Pumpe selbst.
  assert.equal(runtime.pumpReady({ mode: 'modbus', pumpTopic: 'custom://Pumpe' }, Date.now()).ok, true);
});

test('Das Betriebslevel sperrt die lokalen Geräte nach ihrer Priorität', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, {
    ...baseRoom, heatPriority: '4', coolPriority: '5', centralAllowed: '1', centralTemp: '4',
  });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  await addSwitchSequences(db, room.id, 'heat', 'custom://Heizung');
  const capture = captureWrites();
  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 19);
    feed(ENVIRONMENT_STATE_IDS.outdoorTemperature, 12);
    levelHandler.applyLevel(5);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.snapshot().get(room.id).heating, true);

    // Levelabfall: das Gerät wird sofort abgeschaltet, nicht erst im nächsten Takt.
    capture.writes.length = 0;
    levelHandler.applyLevel(3);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(lastWrite(capture.writes, 'custom://Heizung'), 0);
    await runtime.tick();
    const state = runtime.snapshot().get(room.id);
    assert.equal(state.heating, false);
    // Der Wärmebedarf besteht weiter — nur decken darf ihn niemand.
    assert.equal(state.heatDemand, true);
    assert.equal(state.centralDemand, false);
    assert.match(state.note, /Betriebslevel 3 sperrt das Heizgerät \(Priorität 4\)/);

    // Wieder freigegeben: das Gerät läuft erneut an.
    capture.writes.length = 0;
    levelHandler.applyLevel(4);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.snapshot().get(room.id).heating, true);
    assert.equal(lastWrite(capture.writes, 'custom://Heizung'), 1);
  } finally {
    levelHandler.applyLevel(5);
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Ersatzweise heizt die Zentralheizung, wenn das Level das Gerät sperrt', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
  });
  const room = await rooms.createRoom(db, {
    ...baseRoom, heatPriority: '4', centralAllowed: '1', centralTemp: '4', heatCentralFallback: '1',
  });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  await addSwitchSequences(db, room.id, 'heat', 'custom://Heizung');
  const capture = captureWrites();
  try {
    await runtime.init(db);
    // Draußen mild: die Außentemperaturgrenze von 4 °C ist weit entfernt.
    feed(rooms.sensorCacheKey(sensor), 19);
    feed(central.flowCacheKey('outdoor'), 12);
    levelHandler.applyLevel(5);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    let state = runtime.snapshot().get(room.id);
    assert.equal(state.heating, true);
    assert.equal(state.centralDemand, false);

    // Level zu niedrig: die Zentralheizung springt ein — trotz 12 °C draußen.
    levelHandler.applyLevel(3);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runtime.tick();
    state = runtime.snapshot().get(room.id);
    assert.equal(state.heating, false);
    assert.equal(state.centralDemand, true);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    assert.match(state.note, /die Zentralheizung übernimmt/);

    // Ohne die Option bleibt es bei der Außentemperaturgrenze.
    await rooms.updateRoom(db, room.id, {
      ...baseRoom, heatPriority: '4', centralAllowed: '1', centralTemp: '4', heatCentralFallback: '0',
    });
    await runtime.reload();
    await runtime.tick();
    state = runtime.snapshot().get(room.id);
    assert.equal(state.centralDemand, false);
    assert.equal(state.heating, false);
    assert.equal(runtime.centralSnapshot().boilerOn, false);
  } finally {
    levelHandler.applyLevel(5);
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Die Ersatzschaltung setzt die Freigabe der Zentralheizung voraus', async () => {
  const db = await freshDb();
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, heatCentralFallback: '1' }),
    /nur einspringen, wenn der Raum sie anfordern darf/);
  await assert.rejects(() => rooms.createRoom(db, { ...baseRoom, heatPriority: '9' }),
    /Priorität des Heizgerätes/);
  await close(db);
});

test('Die Mindesttemperatur verhindert Kühlen bei Nachtabsenkung', () => {
  const room = { coolOffset: 5, coolMinTemp: 28 };
  // Nachtabsenkung auf 18 °C: Soll plus Offset wären 23 °C — die Untergrenze
  // von 28 °C gewinnt.
  assert.equal(runtime.coolThreshold(room, 18), 28);
  // Tagsüber 21 °C: 26 °C lägen ebenfalls unter der Untergrenze.
  assert.equal(runtime.coolThreshold(room, 21), 28);
  // Steht das Soll hoch genug, zählt wieder Soll plus Offset.
  assert.equal(runtime.coolThreshold(room, 24), 29);
  // Ohne Untergrenze bleibt es bei Soll plus Offset.
  assert.equal(runtime.coolThreshold({ coolOffset: 5, coolMinTemp: null }, 18), 23);
});

test('Unterhalb der Mindesttemperatur springt die Klimaanlage nicht an', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, {
    ...baseRoom, targetTemp: '18', coolOffset: '5', coolMinTemp: '28', hysteresis: '0.5',
  });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  await addSwitchSequences(db, room.id, 'cool', 'custom://Klima');
  const capture = captureWrites();
  try {
    await runtime.init(db);
    // 24 °C liegen über Soll + Offset (23 °C), aber unter der Untergrenze.
    feed(rooms.sensorCacheKey(sensor), 24);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.snapshot().get(room.id).cooling, false);
    assert.equal(lastWrite(capture.writes, 'custom://Klima'), null);

    // Erst über 28 °C wird gekühlt.
    feed(rooms.sensorCacheKey(sensor), 28.4);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.snapshot().get(room.id).cooling, true);
    assert.equal(lastWrite(capture.writes, 'custom://Klima'), 1);

    // Die Hysterese gilt auch hier: aus erst unter 27,5 °C.
    feed(rooms.sensorCacheKey(sensor), 27.8);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).cooling, true);
    feed(rooms.sensorCacheKey(sensor), 27.2);
    await runtime.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.snapshot().get(room.id).cooling, false);
    assert.equal(lastWrite(capture.writes, 'custom://Klima'), 0);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Der Heizkörperlüfter folgt der Wärmeanforderung an die Zentralheizung', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
  });
  const room = await rooms.createRoom(db, {
    ...baseRoom, centralAllowed: '1', centralTemp: '5', fanTopic: 'custom://Luefter',
  });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    // Draußen mild: keine Anforderung, der Lüfter bleibt aus.
    feed(rooms.sensorCacheKey(sensor), 19);
    feed(central.flowCacheKey('outdoor'), 12);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).centralDemand, false);
    assert.equal(lastWrite(capture.writes, 'custom://Luefter'), '0');

    // Kalt draußen: der Raum fordert Wärme an, der Lüfter läuft mit.
    capture.writes.length = 0;
    feed(central.flowCacheKey('outdoor'), 2);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).centralDemand, true);
    assert.equal(lastWrite(capture.writes, 'custom://Luefter'), '1');

    // Unveränderter Zustand schaltet nicht erneut.
    capture.writes.length = 0;
    await runtime.tick();
    assert.deepEqual(capture.writes, []);

    // Raum warm genug: Anforderung entfällt, der Lüfter geht aus.
    feed(rooms.sensorCacheKey(sensor), 22);
    await runtime.tick();
    assert.equal(runtime.snapshot().get(room.id).centralDemand, false);
    assert.equal(lastWrite(capture.writes, 'custom://Luefter'), '0');
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Das Beenden des Schornsteinfeger-Modus stellt Soll-Temperatur und Anforderung zurück', async () => {
  // Regression: das Thermostat meldet die 28 °C des Modus zurück; wurde dieses
  // Echo als Verstellung von Hand gelesen, blieb die Soll-Temperatur auf 28 °C
  // stehen — und damit auch die Wärmeanforderung des Raums.
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
  });
  const room = await rooms.createRoom(db, {
    ...baseRoom, thermostatTopic: 'custom://Thermostat', centralAllowed: '1', centralTemp: '5',
  });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });

  // Träges Thermostat: es meldet den geschriebenen Sollwert erst später zurück.
  const writes = [];
  const originalPublish = mqttClient.publish;
  let pendingEcho = null;
  mqttClient.publish = (topic, value) => {
    writes.push({ topic, value });
    if (topic === 'custom://Thermostat') pendingEcho = value;
    return true;
  };
  const echo = () => {
    if (pendingEcho != null) feed(rooms.thermostatCacheKey(room.id), pendingEcho);
  };

  try {
    await runtime.init(db);
    feed(rooms.sensorCacheKey(sensor), 22);
    // Draußen mild: über der Grenze von 5 °C fordert der Raum keine Wärme an.
    feed(central.flowCacheKey('outdoor'), 14);
    await runtime.tick();
    echo();
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 21);

    await runtime.setSweepMode(true);
    echo();
    assert.equal(lastWrite(writes, 'custom://Thermostat'), 28);
    assert.equal(runtime.snapshot().get(room.id).centralDemand, true);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    // Die eingestellte Soll-Temperatur bleibt dabei unangetastet.
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 21);

    await runtime.setSweepMode(false);
    echo();
    await runtime.tick();
    echo();
    await runtime.tick();

    // Das Thermostat bekommt seinen alten Sollwert zurück …
    assert.equal(lastWrite(writes, 'custom://Thermostat'), 21);
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 21);
    // … und damit fällt die Wärmeanforderung weg: 14 °C liegen über der Grenze.
    const state = runtime.snapshot().get(room.id);
    assert.equal(state.centralDemand, false);
    assert.equal(state.heatDemand, false);
    assert.equal(runtime.centralSnapshot().boilerOn, false);
  } finally {
    mqttClient.publish = originalPublish;
    runtime.stop();
    await close(db);
  }
});

test('Eine echte Verstellung am Thermostat gilt weiterhin', async () => {
  const db = await freshDb();
  const room = await rooms.createRoom(db, { ...baseRoom, thermostatTopic: 'custom://Thermostat' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    // Erster Wert nach dem Start ist die Ausgangsbasis.
    feed(rooms.thermostatCacheKey(room.id), 21);
    await runtime.tick();
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 21);

    // Verstellung von Hand: sie gewinnt und wird übernommen.
    feed(rooms.thermostatCacheKey(room.id), 23.5);
    await runtime.tick(Date.now() + 60000);
    assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 23.5);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

test('Die Kostenzeit folgt der Rückmeldung des Brenners, sonst dem Vorlauf', async () => {
  const config = { mode: 'relais', burnerFeedbackTopic: 'custom://Flamme' };
  // Mit Rückmeldung zählt allein sie — auch bei steigendem Vorlauf.
  feed(central.flowCacheKey('feedback'), 1);
  assert.equal(runtime.detectFiring(config, 60), true);
  feed(central.flowCacheKey('feedback'), 0);
  assert.equal(runtime.detectFiring(config, 61), false);

  // Ohne Rückmeldung entscheidet der Verlauf des Vorlaufs. Mit 0,3 K
  // Mindest-Änderung gilt alles darunter als Rauschen.
  const estimate = { mode: 'relais', burnerFeedbackTopic: '', flowDropDelta: 0.3 };
  assert.equal(runtime.detectFiring(estimate, 50), false);        // erster Messwert
  // Eine einzelne Erhöhung reicht ausdrücklich nicht …
  assert.equal(runtime.detectFiring(estimate, 50.5), false);
  // … und ein Wert im Rauschband beendet die Reihe nicht, er zählt aber auch
  // nicht mit.
  assert.equal(runtime.detectFiring(estimate, 50.4), false);
  assert.equal(runtime.detectFiring(estimate, 51), false);        // zweiter Anstieg
  assert.equal(runtime.detectFiring(estimate, 52), true);         // dritter ⇒ Brenner an
  // Die Halte-Phase zählt weiter als Brennerlauf.
  assert.equal(runtime.detectFiring(estimate, 52), true);
  assert.equal(runtime.detectFiring(estimate, 52.1), true);
  assert.equal(runtime.detectFiring(estimate, 51.9), true);
  // Erst mehrere Messwerte in Folge nach unten beenden die Brennphase.
  assert.equal(runtime.detectFiring(estimate, 51.5), true);
  assert.equal(runtime.detectFiring(estimate, 51), true);
  assert.equal(runtime.detectFiring(estimate, 50.5), false);
});


test('Ohne Feuern des Brenners läuft keine Kostenzeit', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    flowTopic: 'custom://Vorlauf', returnTopic: 'custom://Ruecklauf',
    burnerFeedbackTopic: 'custom://Flamme', consumptionPerHour: '2', unit: 'l', pricePerUnit: '1',
  });
  const room = await rooms.createRoom(db, { ...baseRoom, centralAllowed: '1', centralTemp: '5' });
  const sensor = await rooms.addSensor(db, room.id, { topic: 'hdp://sensor/1' });
  const capture = captureWrites();
  try {
    await runtime.init(db);
    const start = Date.now();
    feed(rooms.sensorCacheKey(sensor), 17);
    feed(central.flowCacheKey('outdoor'), 2);
    feed(central.flowCacheKey('flow'), 40);
    feed(central.flowCacheKey('return'), 30);
    // Kessel eingeschaltet, aber der Brenner meldet noch kein Feuer.
    feed(central.flowCacheKey('feedback'), 0);
    await runtime.tick(start);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    assert.equal(runtime.centralSnapshot().burnerOn, false);
    assert.equal((await central.listRuns(db, 5)).length, 0);

    // Jetzt feuert er — ab hier läuft die Kostenzeit.
    feed(central.flowCacheKey('feedback'), 1);
    await runtime.tick(start + 30000);
    assert.equal(runtime.centralSnapshot().burnerOn, true);
    assert.equal((await central.listRuns(db, 5)).length, 1);

    // Der Kessel taktet: Brenner aus, Kessel weiter eingeschaltet.
    feed(central.flowCacheKey('feedback'), 0);
    await runtime.tick(start + 90000);
    assert.equal(runtime.centralSnapshot().boilerOn, true);
    assert.equal(runtime.centralSnapshot().burnerOn, false);
    const runs = await central.listRuns(db, 5);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].duration_ms, 60000);
    assert.match(runs[0].reason, /Rückmeldung/);

    // Zweite Brennphase: eigener Eintrag.
    feed(central.flowCacheKey('feedback'), 1);
    await runtime.tick(start + 120000);
    assert.equal((await central.listRuns(db, 5)).length, 2);
  } finally {
    runtime.stop();
    capture.restore();
    await close(db);
  }
});

// Brennerlaufzeit von Hand ins Protokoll legen (statt sie zu simulieren).
async function logBurnerRun(db, startedAt, durationMs) {
  await run(db, 'INSERT INTO heizung_burner_runs (started_at, ended_at, duration_ms) VALUES (?, ?, ?)',
    [startedAt, startedAt + durationMs, durationMs]);
}

test('Das Zählwerk summiert bis zum Abschließen und weist den Monatsabschlag aus', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    consumptionPerHour: '2', unit: 'l', pricePerUnit: '1,50',
  });
  const now = Date.now();
  const start = now - 30 * 86400000;
  await run(db, 'INSERT INTO heizung_billing (id, started_at) VALUES (1, ?)', [start]);

  // Startwert: was vor dem Mitzählen schon verbraucht wurde.
  await billing.setStartConsumption(db, '100');
  // 10 Stunden Brennerlaufzeit im Zeitraum = 20 l.
  await logBurnerRun(db, start + 86400000, 10 * 3600000);

  const config = await central.loadCentralConfig(db);
  let stats = await billing.billingStatistics(db, config, await billing.loadBilling(db), now);
  assert.equal(stats.startConsumption, 100);
  assert.ok(Math.abs(stats.measuredConsumption - 20) < 0.001, String(stats.measuredConsumption));
  assert.ok(Math.abs(stats.consumption - 120) < 0.001, String(stats.consumption));
  assert.ok(Math.abs(stats.cost - 180) < 0.01, String(stats.cost));
  // Monatsabschlag = Kosten ÷ 12.
  assert.ok(Math.abs(stats.monthly - 15) < 0.01, String(stats.monthly));
  assert.equal(stats.previous, null);
  assert.equal(stats.days, 30);

  // Abschließen ohne Ablesung: der Zeitraum wandert ins Archiv, der neue
  // beginnt bei 0.
  const closed = await billing.closePeriod(db, {}, now);
  assert.equal(closed.factor, null);
  assert.equal(closed.billing.startConsumption, 0);
  assert.equal(closed.billing.startedAt, now);
  assert.ok(Math.abs(closed.billing.previousConsumption - 120) < 0.001);
  assert.ok(Math.abs(closed.billing.previousCost - 180) < 0.01);

  stats = await billing.billingStatistics(db, config, closed.billing, now);
  assert.equal(stats.consumption, 0);
  assert.ok(Math.abs(stats.previous.cost - 180) < 0.01);
  assert.ok(Math.abs(stats.previous.monthly - 15) < 0.01);
  await close(db);
});

test('Der abgelesene Zählerstand kann den geschätzten Verbrauch kalibrieren', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    consumptionPerHour: '2', unit: 'l', pricePerUnit: '1',
  });
  const now = Date.now();
  const start = now - 365 * 86400000;
  await run(db, 'INSERT INTO heizung_billing (id, started_at, start_consumption) VALUES (1, ?, 50)', [start]);
  // 100 Stunden × 2 l/h = 200 l geschätzt, dazu 50 l Startwert.
  await logBurnerRun(db, start + 86400000, 100 * 3600000);

  // Abgelesen wurden 300 l: 250 l entfallen auf die gemessene Laufzeit,
  // der Verbrauch je Betriebsstunde war also um Faktor 1,25 zu niedrig.
  const closed = await billing.closePeriod(db, { metered: '300', calibrate: true }, now);
  assert.ok(Math.abs(closed.factor - 1.25) < 0.001, String(closed.factor));
  assert.equal((await central.loadCentralConfig(db)).consumptionPerHour, 2.5);
  // Die Kosten des Zeitraums rechnen mit dem abgelesenen Wert.
  assert.equal(closed.billing.previousMetered, 300);
  assert.ok(Math.abs(closed.billing.previousCost - 300) < 0.01);
  assert.equal(closed.billing.lastCalibrationFactor, 1.25);
  await close(db);
});

test('Das Zählwerk weist unplausible Eingaben ab', async () => {
  const db = await freshDb();
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    consumptionPerHour: '2', unit: 'l', pricePerUnit: '1',
  });
  const now = Date.now();
  await run(db, 'INSERT INTO heizung_billing (id, started_at, start_consumption) VALUES (1, ?, 50)',
    [now - 86400000]);
  await logBurnerRun(db, now - 80000000, 10 * 3600000);   // 20 l geschätzt

  await assert.rejects(() => billing.setStartConsumption(db, 'viel'), /Startwert/);
  await assert.rejects(() => billing.closePeriod(db, { calibrate: true }, now), /abgelesene Zählerstand/);
  // Unter dem Startwert kann der Zähler nicht stehen.
  await assert.rejects(() => billing.closePeriod(db, { metered: '40', calibrate: true }, now),
    /liegt unter dem Startwert/);
  // Faktor 10 deutet auf Fremdverbraucher am Zähler hin.
  await assert.rejects(() => billing.closePeriod(db, { metered: '250', calibrate: true }, now),
    /weit auseinander/);
  // Ohne Kalibrierung bleibt der Verbrauch je Betriebsstunde unangetastet.
  await billing.closePeriod(db, { metered: '250' }, now);
  assert.equal((await central.loadCentralConfig(db)).consumptionPerHour, 2);
  await close(db);
});
