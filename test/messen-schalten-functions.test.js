'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { createActor, cacheKey } = require('../src/messen-schalten/actors');
const { createGroup } = require('../src/messen-schalten/groups');
const {
  FUNCTIONS, effectiveFunction, functionPowerSums, currentFunctionPowerW,
  recordFunctionSamples, readFunctionValues, loadFunctionModels,
  functionsLoadForHour, temperatureBucket,
} = require('../src/messen-schalten/functions');
const { ENVIRONMENT_STATE_IDS } = require('../src/mqtt/config');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
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
  await dbRun(db, "CREATE TABLE mess_schalt_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, priority INTEGER NOT NULL DEFAULT 4, position INTEGER NOT NULL DEFAULT 0, function_key TEXT NOT NULL DEFAULT '', offset_total_consumption INTEGER NOT NULL DEFAULT 1, parent_id INTEGER, meter_group INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '')");
  await dbRun(db, 'CREATE TABLE mess_schalt_actor_state (actor_id INTEGER PRIMARY KEY, last_counter_raw REAL, last_progress_ts INTEGER, derived_power_w REAL, counter_total_kwh REAL, day_key TEXT, day_start_kwh REAL, year_key TEXT, year_start_kwh REAL, prev_year_kwh REAL)');
  await dbRun(db, `CREATE TABLE mess_schalt_function_hourly (
    function_key TEXT NOT NULL, day_key TEXT NOT NULL, hour INTEGER NOT NULL,
    consumption_kwh REAL NOT NULL DEFAULT 0, temperature REAL,
    PRIMARY KEY (function_key, day_key, hour))`);
  await dbRun(db, 'CREATE TABLE mess_schalt_function_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_sample_ts INTEGER)');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT
  )`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'Europe/Berlin', 1, '', '', '')");
  return db;
}

test('Funktionsliste enthält die fünf vorgesehenen Funktionen', () => {
  assert.deepEqual(FUNCTIONS.map((fn) => fn.label), [
    'Licht', 'Waschen', 'Warmwasser', 'Heizung / Klima', 'Kochen',
  ]);
});

test('effectiveFunction: eigene Zuordnung vor Gruppenfunktion', () => {
  const groups = new Map([[7, { id: 7, functionKey: 'licht' }]]);
  assert.equal(effectiveFunction({ functionKey: 'kochen', groupId: 7 }, groups), 'kochen');
  assert.equal(effectiveFunction({ functionKey: '', groupId: 7 }, groups), 'licht');
  assert.equal(effectiveFunction({ functionKey: '', groupId: null }, groups), '');
});

test('functionPowerSums summiert nur Geräte mit Funktion und Leistungswert', () => {
  const actors = [
    { id: 1, functionKey: 'licht', groupId: null },
    { id: 2, functionKey: 'licht', groupId: null },
    { id: 3, functionKey: '', groupId: null },
  ];
  const values = [
    { id: 1, powerW: 60 },
    { id: 2, powerW: null },
    { id: 3, powerW: 500 },
  ];
  const sums = functionPowerSums(actors, [], values);
  assert.equal(sums.get('licht'), 60);
  assert.equal(sums.size, 1);
});

test('recordFunctionSamples integriert Leistung in Stundenenergie samt Temperatur', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Herd', powerTopic: 'herd.0.power', functionKey: 'kochen' });
  const cache = new Map([
    [cacheKey(actor.id, 'power'), { value: '2000' }],
    [ENVIRONMENT_STATE_IDS.outdoorTemperature, { value: '21.5' }],
  ]);
  const start = new Date('2026-06-30T10:00:00Z').getTime(); // 12 Uhr Europe/Berlin
  await recordFunctionSamples(db, cache, start);
  await recordFunctionSamples(db, cache, start + 60000);
  await recordFunctionSamples(db, cache, start + 120000);
  const rows = await dbAll(db, 'SELECT * FROM mess_schalt_function_hourly');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].function_key, 'kochen');
  assert.equal(rows[0].day_key, '2026-06-30');
  assert.equal(rows[0].hour, 12);
  // 2 kW über 2 Minuten = 0,0667 kWh
  assert.ok(Math.abs(rows[0].consumption_kwh - 2000 * 120000 / 3600000000) < 1e-9);
  assert.equal(rows[0].temperature, 21.5);
  await new Promise((resolve) => db.close(resolve));
});

test('Heizung/Klima verwendet die energiegewichtete Stundentemperatur', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Waermepumpe', powerTopic: 'wp.0.power', functionKey: 'heizung_klima' });
  const cache = new Map([
    [cacheKey(actor.id, 'power'), { value: '1000' }],
    [ENVIRONMENT_STATE_IDS.outdoorTemperature, { value: '4' }],
  ]);
  const start = new Date('2026-01-15T10:00:00Z').getTime();
  await recordFunctionSamples(db, cache, start);
  await recordFunctionSamples(db, cache, start + 60000);
  cache.set(ENVIRONMENT_STATE_IDS.outdoorTemperature, { value: '14' });
  await recordFunctionSamples(db, cache, start + 120000);

  const rows = await dbAll(db, 'SELECT temperature FROM mess_schalt_function_hourly');
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].temperature - 9) < 1e-9);
  assert.equal(temperatureBucket(rows[0].temperature), 5);
  await new Promise((resolve) => db.close(resolve));
});

test('recordFunctionSamples überspringt unplausibel lange Intervalle (Neustart)', async () => {
  const db = await freshDb();
  await createActor(db, { name: 'Herd', powerTopic: 'herd.0.power', functionKey: 'kochen' });
  const cache = new Map([['messschalt:1:power', { value: '2000' }]]);
  const start = new Date('2026-06-30T10:00:00Z').getTime();
  await recordFunctionSamples(db, cache, start);
  await recordFunctionSamples(db, cache, start + 6 * 60000);
  const rows = await dbAll(db, 'SELECT * FROM mess_schalt_function_hourly');
  assert.equal(rows.length, 0);
  await new Promise((resolve) => db.close(resolve));
});

test('readFunctionValues liefert Leistung und Tagesverbrauch je zugeordneter Funktion', async () => {
  const db = await freshDb();
  const group = await createGroup(db, { title: 'Beleuchtung', priority: 4, functionKey: 'licht' });
  const actor = await createActor(db, { name: 'Flurlicht', powerTopic: 'l.0.p', groupId: group.id });
  const cache = new Map([[cacheKey(actor.id, 'power'), { value: '42' }]]);
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('licht', ?, 9, 0.4, NULL)",
    [new Date().toISOString().slice(0, 10)]);
  const values = await readFunctionValues(db, cache);
  assert.equal(values.length, 1);
  assert.equal(values[0].key, 'licht');
  assert.equal(values[0].powerW, 42);
  await new Promise((resolve) => db.close(resolve));
});

test('loadFunctionModels: Wochentagsprofil und Temperatur-Buckets in 5-Grad-Schritten', async () => {
  const db = await freshDb();
  // Kochen: zwei Dienstage (30.06. und 07.07.2026? 07.07. ist Dienstag) mit 12-Uhr-Werten.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('kochen', '2026-06-30', 12, 1.0, NULL)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('kochen', '2026-06-23', 12, 2.0, NULL)");
  // Heizung / Klima: gleiche Stunde in zwei Temperatur-Buckets.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-06-29', 14, 2.0, 31.0)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-06-28', 14, 0.5, 22.0)");
  const models = await loadFunctionModels(db, '2026-07-01');
  const tuesday = 2;
  assert.equal(models.kochen.type, 'weekday');
  assert.equal(models.kochen.hourlyByWeekday[tuesday][12], 1.5);
  assert.equal(models.heizung_klima.type, 'temperature');
  assert.equal(temperatureBucket(31), 30);
  assert.equal(models.heizung_klima.buckets.get(30)[14], 2);
  assert.equal(models.heizung_klima.buckets.get(20)[14], 0.5);

  // Prognose: Wochentagslast plus Temperatur-Bucket nach Prognosetemperatur.
  const forecast = { hours: [{ dateKey: '2026-07-07', hour: 14, kwh: 0, temperature: 32 }] };
  assert.equal(functionsLoadForHour(models, forecast, '2026-07-07', 14, 1), 2);
  assert.equal(functionsLoadForHour(models, forecast, '2026-07-07', 12, 1), 1.5);
  // Fehlende Temperaturprognose: Mittel über die gelernten Buckets.
  assert.equal(functionsLoadForHour(models, null, '2026-07-07', 14, 1), 1.25);
  await new Promise((resolve) => db.close(resolve));
});

test('currentFunctionPowerW liefert die Summe für die Grundlast-Bereinigung', async () => {
  const db = await freshDb();
  const a1 = await createActor(db, { name: 'Boiler', powerTopic: 'b.0.p', functionKey: 'warmwasser' });
  const a2 = await createActor(db, { name: 'Herd', powerTopic: 'h.0.p', functionKey: 'kochen' });
  await createActor(db, { name: 'Ohne Funktion', powerTopic: 'x.0.p' });
  const cache = new Map([
    [cacheKey(a1.id, 'power'), { value: '1500' }],
    [cacheKey(a2.id, 'power'), { value: '500' }],
    ['messschalt:3:power', { value: '999' }],
  ]);
  assert.equal(await currentFunctionPowerW(db, cache), 2000);
  await new Promise((resolve) => db.close(resolve));
});
