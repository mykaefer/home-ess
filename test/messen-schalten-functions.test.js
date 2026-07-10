'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { createActor, cacheKey } = require('../src/messen-schalten/actors');
const { createGroup } = require('../src/messen-schalten/groups');
const {
  FUNCTIONS, effectiveFunction, functionPowerSums, currentFunctionPowerW,
  recordFunctionSamples, readFunctionValues, loadFunctionModels,
  functionsLoadForHour, temperatureBucket, summarizeTemperatureDemand,
  temperatureBucketList, TEMPERATURE_BUCKET_BELOW, TEMPERATURE_BUCKET_MAX,
  TEMPERATURE_BUCKET_ALPHA,
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
    counter_unit TEXT NOT NULL DEFAULT 'kWh', rated_power REAL, rated_power_unit TEXT NOT NULL DEFAULT 'W', priority INTEGER NOT NULL DEFAULT 4,
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

test('temperatureBucket klemmt auf den unteren (< -20) und oberen (> 50) Sammelbereich', () => {
  assert.equal(temperatureBucket(-100), TEMPERATURE_BUCKET_BELOW);
  assert.equal(temperatureBucket(-21), TEMPERATURE_BUCKET_BELOW);
  assert.equal(temperatureBucket(-20), -20); // Untergrenze bleibt eigener 5-°C-Bereich
  assert.equal(temperatureBucket(-16), -20);
  assert.equal(temperatureBucket(0), 0);
  assert.equal(temperatureBucket(49.9), 45);
  assert.equal(temperatureBucket(50), TEMPERATURE_BUCKET_MAX); // ab 50 °C Sammelbereich
  assert.equal(temperatureBucket(80), TEMPERATURE_BUCKET_MAX);
  // Fensterliste: <-20, 14 × 5-°C-Bereiche, >50 = 16 Fenster.
  const windows = temperatureBucketList();
  assert.equal(windows.length, 16);
  assert.equal(windows[0].below, true);
  assert.equal(windows[windows.length - 1].above, true);
});

test('summarizeTemperatureDemand liefert alle Fenster mit Tagesenergie und Messstunden', async () => {
  const db = await freshDb();
  // Zwei Messstunden im Sammelbereich < -20 °C (−30/−28 °C) und eine bei > 50 °C.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-01', 6, 3.0, -30)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-02', 6, 1.0, -28)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-07-01', 14, 0.5, 60)");
  const models = await loadFunctionModels(db);
  const summary = summarizeTemperatureDemand(models.heizung_klima);
  assert.equal(summary.length, 16);

  const below = summary[0];
  assert.equal(below.below, true);
  assert.equal(below.samples, 2); // beide Stunden im <-20-Fenster
  // Fenster ziehen träge mit (EWMA, alt → neu): 3,0 → dann 3,0·0,8 + 1,0·0,2 = 2,6.
  assert.ok(Math.abs(below.dailyKwh - 2.6) < 1e-9);

  const above = summary[summary.length - 1];
  assert.equal(above.above, true);
  assert.equal(above.samples, 1);
  assert.ok(Math.abs(above.dailyKwh - 0.5) < 1e-9);

  const mildEmpty = summary.find((w) => w.min === 0);
  assert.equal(mildEmpty.samples, 0);
  assert.equal(mildEmpty.dailyKwh, 0);
  await new Promise((resolve) => db.close(resolve));
});

test('loadFunctionModels: Temperaturfenster ziehen langsam mit statt hart zu überschreiben', async () => {
  const db = await freshDb();
  const a = TEMPERATURE_BUCKET_ALPHA;
  // Vier Tage im selben Fenster (0 °C) / derselben Stunde: ein Sprung nach oben
  // darf den gelernten Wert nur schrittweise mitziehen, nicht ersetzen.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-01', 7, 1.0, 0)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-02', 7, 1.0, 1)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-03', 7, 1.0, 2)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-04', 7, 5.0, 3)");
  const models = await loadFunctionModels(db);
  // EWMA (alt → neu): 1 → 1 → 1 → 1·(1−a) + 5·a. Mit a=0,2 ergibt das 1,8 – die
  // letzte Messung hat den Wert mitgezogen, aber nicht auf 5 überschrieben.
  const expected = 1 * (1 - a) + 5 * a;
  assert.ok(Math.abs(models.heizung_klima.buckets.get(0)[7] - expected) < 1e-9);
  assert.ok(models.heizung_klima.buckets.get(0)[7] < 5);
  await new Promise((resolve) => db.close(resolve));
});

test('loadFunctionModels: 0-kWh-Messung ist eine gültige Beobachtung des Fensters', async () => {
  const db = await freshDb();
  // Gemessener Bedarf 0,0 kWh bei 18 °C – gültige Messung, das Fenster ist belegt.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-05-01', 13, 0.0, 18)");
  const models = await loadFunctionModels(db);
  const summary = summarizeTemperatureDemand(models.heizung_klima);
  const window15 = summary.find((w) => w.min === 15);
  assert.equal(window15.samples, 1);      // Messstunde vorhanden …
  assert.equal(window15.dailyKwh, 0);      // … mit erwartetem Bedarf 0,0 kWh.
  await new Promise((resolve) => db.close(resolve));
});

test('functionsLoadForHour plant Heizung/Klima je Stunde nach der Stundentemperatur', async () => {
  const db = await freshDb();
  // Kalt (0 °C) hoher Bedarf, mild (15 °C) geringer – jeweils in Stunde 8 und 9.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-01', 8, 2.0, 0)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-01', 9, 2.0, 0)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-02', 8, 0.4, 15)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('heizung_klima', '2026-01-02', 9, 0.4, 15)");
  const models = await loadFunctionModels(db);
  // Selber Tag, aber Stunde 8 kalt (0 °C) und Stunde 9 mild (15 °C) prognostiziert.
  const forecast = { hours: [
    { dateKey: '2026-07-07', hour: 8, kwh: 0, temperature: 0 },
    { dateKey: '2026-07-07', hour: 9, kwh: 0, temperature: 15 },
  ] };
  assert.equal(functionsLoadForHour(models, forecast, '2026-07-07', 8, 1), 2.0);
  assert.equal(functionsLoadForHour(models, forecast, '2026-07-07', 9, 1), 0.4);
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
