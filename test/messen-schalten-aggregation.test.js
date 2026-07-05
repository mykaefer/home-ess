'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { cacheKey, createActor, updateActor } = require('../src/messen-schalten/actors');
const {
  buildActorSnapshot, readActorValues, readGroupSums, derivedPowerFromState, STALL_MS, VALUE_STALE_MS,
} = require('../src/messen-schalten/aggregation');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
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
    load_shed_phase TEXT NOT NULL DEFAULT 'l1',
    switch_group_id INTEGER)`);
  await dbRun(db, 'CREATE TABLE mess_schalt_actor_state (actor_id INTEGER PRIMARY KEY, last_counter_raw REAL, last_progress_ts INTEGER, derived_power_w REAL, counter_total_kwh REAL)');
  return db;
}

function cacheFrom(pairs) {
  const map = new Map();
  for (const [key, value] of pairs) map.set(key, { value });
  return map;
}

test('Leistung wird aus dem Zählerfortschritt abgeleitet (Δkwh/Δt → W)', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, counter_topic, counter_unit) VALUES (1, 'Ofen', 'c.0', 'kWh')");
  const t0 = 1_000_000_000_000;
  // Erster Snapshot: Basis setzen (0 W).
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 10]]), t0);
  // Nach 30 min +0,5 kWh ⇒ 1 kWh/h ⇒ 1000 W.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 10.5]]), t0 + 30 * 60 * 1000);
  const row = await dbGet(db, 'SELECT derived_power_w FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.ok(Math.abs(row.derived_power_w - 1000) < 0.001);
  await new Promise((resolve) => db.close(resolve));
});

test('Ohne Zählerfortschritt fällt die abgeleitete Leistung nach 10 min auf 0 W', () => {
  const now = 2_000_000_000_000;
  const fresh = { lastProgressTs: now - 5 * 60 * 1000, derivedPowerW: 800 };
  assert.equal(derivedPowerFromState(fresh, now), 800);
  const stale = { lastProgressTs: now - (STALL_MS + 1), derivedPowerW: 800 };
  assert.equal(derivedPowerFromState(stale, now), 0);
});

test('readActorValues: Status fällt auf Schalt-Topic bzw. Leistung zurück', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic) VALUES (1, 'Nur Schalten', 's.1')");
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic) VALUES (2, 'Nur Leistung', 'p.2')");
  const cache = cacheFrom([
    [cacheKey(1, 'switch'), '1'],
    [cacheKey(2, 'power'), 42],
  ]);
  const values = await readActorValues(db, cache, null, 3_000_000_000_000);
  const a1 = values.find((v) => v.id === 1);
  const a2 = values.find((v) => v.id === 2);
  assert.equal(a1.statusOn, true);      // aus Schalt-Topic
  assert.equal(a1.switchOn, true);
  assert.equal(a2.statusOn, true);      // aus Leistung > Schwelle
  assert.equal(a2.powerW, 42);
  await new Promise((resolve) => db.close(resolve));
});

test('readActorValues: dediziertes Status-Topic hat Vorrang', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, status_topic) VALUES (1, 'X', 's.1', 'st.1')");
  const cache = cacheFrom([[cacheKey(1, 'switch'), '1'], [cacheKey(1, 'status'), 'false']]);
  const values = await readActorValues(db, cache, null);
  assert.equal(values[0].switchOn, true);
  assert.equal(values[0].statusOn, false); // Status-Topic übersteuert Schalt-Topic
  await new Promise((resolve) => db.close(resolve));
});

test('Neueres AUS setzt alten Leistungswert passiv auf 0 und markiert alte Werte', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, power_topic) VALUES (1, 'Licht', 's.1', 'p.1')");
  const now = 3_000_000_000_000;
  const cache = new Map([
    [cacheKey(1, 'power'), { value: 68, receivedAt: now - VALUE_STALE_MS - 1000 }],
    [cacheKey(1, 'switch'), { value: false, receivedAt: now - 1000 }],
  ]);
  const [value] = await readActorValues(db, cache, null, now);
  assert.equal(value.statusOn, false);
  assert.equal(value.powerW, 0);
  assert.equal(value.powerInferredOff, true);
  assert.equal(value.powerStale, false); // 0 W ist durch das neuere AUS abgesichert

  cache.set(cacheKey(1, 'switch'), { value: true, receivedAt: now - VALUE_STALE_MS - 2000 });
  const [stale] = await readActorValues(db, cache, null, now);
  assert.equal(stale.powerW, 68);
  assert.equal(stale.powerStale, true);
  assert.equal(stale.statusStale, true);
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand: Neuanlage übernimmt den Rohwert nicht als Sprung', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Boiler', counterTopic: 'c.0' });
  const t0 = 1_000_000_000_000;
  // Erster Rohwert (Lebenszeit-Total des Geräts) basiert nur neu: Zähler bleibt 0.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.5]]), t0);
  let values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.5]]), null, t0);
  assert.equal(values[0].counterKwh, 0);
  // Fortschritt +0,25 kWh geht als Delta ein.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.75]]), t0 + 60_000);
  values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.75]]), null, t0 + 60_000);
  assert.ok(Math.abs(values[0].counterKwh - 0.25) < 1e-9);
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand: Topic-Wechsel und Geräte-Reset basieren nur neu', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Boiler', counterTopic: 'c.alt' });
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 10]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 12]]), t0 + 60_000);
  // Stand: 2 kWh intern. Topic-Wechsel darf den Rohwert des neuen Topics nicht addieren.
  await updateActor(db, actor.id, { name: 'Boiler', counterTopic: 'c.neu' });
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 500]]), t0 + 120_000);
  let values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 500]]), null, t0 + 120_000);
  assert.equal(values[0].counterKwh, 2);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 500.5]]), t0 + 180_000);
  // Geräte-Reset (Rohwert fällt zurück): kein Rückschritt, danach zählen Deltas weiter.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 0]]), t0 + 240_000);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 0.2]]), t0 + 300_000);
  values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 0.2]]), null, t0 + 300_000);
  assert.ok(Math.abs(values[0].counterKwh - 2.7) < 1e-9);
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand: Altbestand übernimmt einmalig den Rohwert (nahtlose Anzeige)', async () => {
  const db = await freshDb();
  // Zustand wie vor der Migration: State-Zeile ohne counter_total_kwh (NULL).
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, counter_topic) VALUES (1, 'Alt', 'c.0')");
  await dbRun(db, 'INSERT INTO mess_schalt_actor_state (actor_id, last_counter_raw, last_progress_ts) VALUES (1, 10, 900000000000)');
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 10.5]]), t0);
  let values = await readActorValues(db, cacheFrom([[cacheKey(1, 'counter'), 10.5]]), null, t0);
  assert.equal(values[0].counterKwh, 10.5); // bisheriger Anzeigewert bleibt
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 11]]), t0 + 60_000);
  values = await readActorValues(db, cacheFrom([[cacheKey(1, 'counter'), 11]]), null, t0 + 60_000);
  assert.equal(values[0].counterKwh, 11); // und läuft per Delta weiter
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand zählt auch bei Geräten mit eigenem Leistungs-Topic', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Messdose', powerTopic: 'p.0', counterTopic: 'c.0' });
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 100]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 100.4]]), t0 + 60_000);
  const values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 100.4]]), null, t0 + 60_000);
  assert.ok(Math.abs(values[0].counterKwh - 0.4) < 1e-9);
  // Leistungsableitung bleibt Geräten ohne Leistungs-Topic vorbehalten.
  const row = await dbGet(db, 'SELECT derived_power_w FROM mess_schalt_actor_state WHERE actor_id = ?', [actor.id]);
  assert.equal(row.derived_power_w, null);
  await new Promise((resolve) => db.close(resolve));
});

test('readGroupSums summiert die Geräteleistungen je Gruppe', () => {
  const groups = [{ id: 5 }, { id: 6 }];
  const values = [
    { id: 1, groupId: 5, powerW: 100 },
    { id: 2, groupId: 5, powerW: 250 },
    { id: 3, groupId: 6, powerW: null },
    { id: 4, groupId: null, powerW: 999 },
  ];
  const sums = readGroupSums(groups, values);
  assert.equal(sums.get(5).powerW, 350);
  assert.equal(sums.get(6).powerW, null); // kein Mitglied mit Wert
});
