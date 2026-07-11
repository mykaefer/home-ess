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
  TEMPERATURE_POWER_DAYS,
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
  await dbRun(db, `CREATE TABLE mess_schalt_temperature_power (
    bucket INTEGER NOT NULL, day_key TEXT NOT NULL,
    avg_power_w REAL NOT NULL DEFAULT 0, weight_seconds REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, day_key))`);
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
  assert.equal(temperatureBucket(rows[0].temperature), 9);
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

test('loadFunctionModels: Wochentagsprofil (kWh) und Heiz-Temperaturfenster (mittlere Leistung)', async () => {
  const db = await freshDb();
  // Kochen: zwei Dienstage (30.06. und 07.07.2026? 07.07. ist Dienstag) mit 12-Uhr-Werten.
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('kochen', '2026-06-30', 12, 1.0, NULL)");
  await dbRun(db, "INSERT INTO mess_schalt_function_hourly VALUES ('kochen', '2026-06-23', 12, 2.0, NULL)");
  // Heizung / Klima: mittlere Leistung (W) je 1-°C-Temperaturfenster (Fenstertabelle).
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (31, '2026-06-29', 2000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (22, '2026-06-28', 500, 3600)");
  const models = await loadFunctionModels(db, '2026-07-01');
  const tuesday = 2;
  assert.equal(models.kochen.type, 'weekday');
  assert.equal(models.kochen.hourlyByWeekday[tuesday][12], 1.5);
  assert.equal(models.heizung_klima.type, 'temperature');
  assert.equal(temperatureBucket(31), 31);
  assert.equal(models.heizung_klima.windows.get(31).meanPowerW, 2000);
  assert.equal(models.heizung_klima.windows.get(22).meanPowerW, 500);

  // Prognose: Wochentagslast plus aus der Fensterleistung errechneter Verbrauch.
  // Stunde 14 warm (32 °C → Fenster 31 → 2000 W → 2,0 kWh, kein Kochen),
  // Stunde 12 kühler (22 °C → Fenster 22 → 500 W → 0,5 kWh) plus Kochen 1,5 kWh.
  const forecast = { hours: [
    { dateKey: '2026-07-07', hour: 14, kwh: 0, temperature: 32 },
    { dateKey: '2026-07-07', hour: 12, kwh: 0, temperature: 22 },
  ] };
  assert.equal(functionsLoadForHour(models, forecast, '2026-07-07', 14, 1), 2);
  assert.equal(functionsLoadForHour(models, forecast, '2026-07-07', 12, 1), 2.0); // 1,5 + 0,5
  // Fehlende Temperaturprognose: Mittel über die gelernten Fenster (2000+500)/2 = 1250 W.
  assert.equal(functionsLoadForHour(models, null, '2026-07-07', 14, 1), 1.25);
  await new Promise((resolve) => db.close(resolve));
});

test('temperatureBucket klemmt auf den unteren (< -20) und oberen (> 50) Sammelbereich', () => {
  assert.equal(temperatureBucket(-100), TEMPERATURE_BUCKET_BELOW);
  assert.equal(temperatureBucket(-21), TEMPERATURE_BUCKET_BELOW);
  assert.equal(temperatureBucket(-20), -20); // Untergrenze bleibt eigener 1-°C-Bereich
  assert.equal(temperatureBucket(-16), -16);
  assert.equal(temperatureBucket(0), 0);
  assert.equal(temperatureBucket(49.9), 49);
  assert.equal(temperatureBucket(50), TEMPERATURE_BUCKET_MAX); // ab 50 °C Sammelbereich
  assert.equal(temperatureBucket(80), TEMPERATURE_BUCKET_MAX);
  // Fensterliste: <-20, 70 × 1-°C-Bereiche (-20 … 49), >50 = 72 Fenster.
  const windows = temperatureBucketList();
  assert.equal(windows.length, 72);
  assert.equal(windows[0].below, true);
  assert.equal(windows[windows.length - 1].above, true);
});

test('summarizeTemperatureDemand liefert alle Fenster mit mittlerer Leistung, Heutewert und Messtagen', async () => {
  const db = await freshDb();
  // Zwei Messtage im Sammelbereich < -20 °C (Fenster -21) und einer bei > 50 °C.
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (-21, '2026-01-01', 3000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (-21, '2026-01-02', 1000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (50, '2026-07-01', 500, 3600)");
  const models = await loadFunctionModels(db, '2026-01-02');
  const summary = summarizeTemperatureDemand(models.heizung_klima);
  assert.equal(summary.length, 72);

  const below = summary[0];
  assert.equal(below.below, true);
  assert.equal(below.days, 2); // beide Tage im <-20-Fenster
  assert.equal(below.avgPowerW, 2000); // Mittel der Messtage: (3000 + 1000) / 2
  assert.equal(below.todayPowerW, 1000); // Markierung = heutiger Wert (02.01.)

  const above = summary[summary.length - 1];
  assert.equal(above.above, true);
  assert.equal(above.days, 1);
  assert.equal(above.avgPowerW, 500);

  const mildEmpty = summary.find((w) => w.min === 0);
  assert.equal(mildEmpty.days, 0);
  assert.equal(mildEmpty.avgPowerW, 0);
  assert.equal(mildEmpty.todayPowerW, null);
  await new Promise((resolve) => db.close(resolve));
});

test('loadFunctionModels: Heizmodell ist das ungewichtete Mittel der Messtage je Fenster', async () => {
  const db = await freshDb();
  // Vier Messtage im selben 1-°C-Fenster (0 °C): der Sprung nach oben geht als
  // gleichwertiger Messtag in den Mittelwert ein (kein träges EWMA mehr, damit die
  // Anpassung nicht mit der Zeit abflacht).
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (0, '2026-01-01', 1000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (0, '2026-01-02', 1000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (0, '2026-01-03', 1000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (0, '2026-01-04', 5000, 3600)");
  const models = await loadFunctionModels(db);
  const window0 = models.heizung_klima.windows.get(0);
  assert.equal(window0.days, 4);
  assert.equal(window0.meanPowerW, (1000 + 1000 + 1000 + 5000) / 4); // 2000 W
  await new Promise((resolve) => db.close(resolve));
});

test('loadFunctionModels: 0-W-Messtag ist eine gültige Beobachtung des Fensters', async () => {
  const db = await freshDb();
  // Gemessene mittlere Leistung 0 W bei 18 °C – gültige Messung, das Fenster ist belegt.
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (18, '2026-05-01', 0, 3600)");
  const models = await loadFunctionModels(db, '2026-05-01');
  const summary = summarizeTemperatureDemand(models.heizung_klima);
  const window18 = summary.find((w) => w.min === 18);
  assert.equal(window18.days, 1);          // Messtag vorhanden …
  assert.equal(window18.avgPowerW, 0);     // … mit erwarteter Leistung 0 W.
  assert.equal(window18.todayPowerW, 0);   // Heutewert (Markierung) = 0 W, gültig.
  await new Promise((resolve) => db.close(resolve));
});

test('recordFunctionSamples lernt Heizleistung je Temperaturfenster (30-Tage-Cap, Heutewert)', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'WP', powerTopic: 'wp.0.power', functionKey: 'heizung_klima' });
  // 31 Alt-Messtage im Fenster 3 °C vorbelegen.
  for (let d = 1; d <= 31; d += 1) {
    const day = `2026-03-${String(d).padStart(2, '0')}`;
    await dbRun(db, 'INSERT INTO mess_schalt_temperature_power VALUES (3, ?, 1000, 3600)', [day]);
  }
  const cache = new Map([
    [cacheKey(actor.id, 'power'), { value: '2000' }],
    [ENVIRONMENT_STATE_IDS.outdoorTemperature, { value: '3.4' }], // Fenster 3
  ]);
  const start = new Date('2026-04-01T09:00:00Z').getTime();
  await recordFunctionSamples(db, cache, start);         // age null → nur Zeitmarke
  await recordFunctionSamples(db, cache, start + 60000); // 1 min @ 2000 W → heutiger Tageswert

  const rows = await dbAll(db,
    'SELECT day_key, avg_power_w FROM mess_schalt_temperature_power WHERE bucket = 3 ORDER BY day_key');
  assert.equal(rows.length, TEMPERATURE_POWER_DAYS);        // auf 30 Messtage begrenzt
  assert.equal(rows[0].day_key, '2026-03-03');             // die zwei ältesten Tage fielen heraus
  const today = rows.find((r) => r.day_key === '2026-04-01');
  assert.ok(today && Math.abs(today.avg_power_w - 2000) < 1e-9);

  const models = await loadFunctionModels(db, '2026-04-01');
  const window3 = models.heizung_klima.windows.get(3);
  assert.equal(window3.days, TEMPERATURE_POWER_DAYS);
  assert.equal(window3.todayPowerW, 2000);                 // Markierung = heutiger Wert
  assert.ok(Math.abs(window3.meanPowerW - (29 * 1000 + 2000) / 30) < 1e-9);
  await new Promise((resolve) => db.close(resolve));
});

test('functionsLoadForHour plant Heizung/Klima je Stunde nach der Stundentemperatur', async () => {
  const db = await freshDb();
  // Kalt (0 °C) hohe Leistung (2000 W), mild (15 °C) geringe (400 W).
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (0, '2026-01-01', 2000, 3600)");
  await dbRun(db, "INSERT INTO mess_schalt_temperature_power VALUES (15, '2026-01-02', 400, 3600)");
  const models = await loadFunctionModels(db);
  // Selber Tag, aber Stunde 8 kalt (0 °C) und Stunde 9 mild (15 °C) prognostiziert.
  // Aus der Fensterleistung wird der Stundenverbrauch errechnet: 2000 W → 2,0 kWh,
  // 400 W → 0,4 kWh.
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
