'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  markSampleHealthy, checkSamplingHealth, markHoursIncomplete, loadLastOkTs,
} = require('../src/prognosis/sampling-health');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL DEFAULT 0, primary_kwh REAL, self_kwh REAL,
    reconciled INTEGER DEFAULT 0, incomplete INTEGER DEFAULT 0, PRIMARY KEY(day_key, hour))`);
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, completed INTEGER, updated_at INTEGER)`);
  await dbRun(db, 'CREATE TABLE prognosis_sampling_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_ok_ts INTEGER)');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT)`);
  // Zeitzone UTC ⇒ lokale Stunde = UTC-Stunde (einfachere Testrechnung).
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'UTC', 0, '', '', '')");
  return db;
}

test('markSampleHealthy setzt last_ok_ts', async () => {
  const db = await freshDb();
  await markSampleHealthy(db, 1234567890);
  assert.equal(await loadLastOkTs(db), 1234567890);
  await markSampleHealthy(db, 1234567999);
  assert.equal(await loadLastOkTs(db), 1234567999);
  await new Promise((r) => db.close(r));
});

test('checkSamplingHealth markiert komplett verpasste Stunden und setzt Vortageswerte', async () => {
  const db = await freshDb();
  // Vortag mit sauberen Stundenwerten.
  for (const [h, v] of [[9, 1.1], [10, 1.2], [11, 1.3], [12, 1.4]]) {
    await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-14', ?, ?, ?, ?)", [h, v, v, v]);
  }
  // Heutiger Tageswert-Eintrag (wird neu berechnet).
  await dbRun(db, "INSERT INTO prognosis_daily_consumption (day_key, consumption_kwh, completed) VALUES ('2026-07-15', 0.1, 0)");
  // Letztes gesundes Sample um 08:30 UTC; jetzt 13:30 UTC ⇒ Stunden 9–12 komplett verpasst.
  const lastOk = Date.UTC(2026, 6, 15, 8, 30, 0);
  const now = Date.UTC(2026, 6, 15, 13, 30, 0);
  await markSampleHealthy(db, lastOk);

  const res = await checkSamplingHealth(db, new Map(), now);
  assert.deepEqual(res.marked.map((m) => m.hour), [9, 10, 11, 12]);

  const rows = await new Promise((resolve, reject) => db.all(
    "SELECT hour, consumption_kwh, incomplete, primary_kwh FROM prognosis_hourly_consumption WHERE day_key='2026-07-15' ORDER BY hour",
    (e, r) => (e ? reject(e) : resolve(r))
  ));
  assert.deepEqual(rows.map((r) => r.hour), [9, 10, 11, 12]);
  assert.deepEqual(rows.map((r) => r.consumption_kwh), [1.1, 1.2, 1.3, 1.4]); // Vortageswerte
  assert.ok(rows.every((r) => r.incomplete === 1));
  assert.ok(rows.every((r) => r.primary_kwh == null)); // Rohwerte unangetastet
  // Die laufende Stunde 13 bleibt unberührt.
  const h13 = await dbGet(db, "SELECT * FROM prognosis_hourly_consumption WHERE day_key='2026-07-15' AND hour=13");
  assert.equal(h13, undefined);
  // Tageswert neu aus der Stundensumme.
  const day = await dbGet(db, "SELECT consumption_kwh FROM prognosis_daily_consumption WHERE day_key='2026-07-15'");
  assert.ok(Math.abs(day.consumption_kwh - (1.1 + 1.2 + 1.3 + 1.4)) < 1e-9);
  await new Promise((r) => db.close(r));
});

test('checkSamplingHealth ignoriert kurze Lücken (keine volle Stunde verpasst)', async () => {
  const db = await freshDb();
  const lastOk = Date.UTC(2026, 6, 15, 8, 55, 0);
  const now = Date.UTC(2026, 6, 15, 9, 40, 0); // 45 min, keine volle Uhr-Stunde komplett drin
  await markSampleHealthy(db, lastOk);
  const res = await checkSamplingHealth(db, new Map(), now);
  assert.equal(res.marked.length, 0);
  await new Promise((r) => db.close(r));
});

test('checkSamplingHealth ohne vorheriges Sample tut nichts', async () => {
  const db = await freshDb();
  const res = await checkSamplingHealth(db, new Map(), Date.UTC(2026, 6, 15, 13, 0, 0));
  assert.equal(res.marked.length, 0);
  await new Promise((r) => db.close(r));
});

test('markHoursIncomplete setzt gezielte Stunden auf Vortageswerte (Einmalfix)', async () => {
  const db = await freshDb();
  for (const [h, v] of [[9, 2.0], [10, 2.1]]) {
    await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-11', ?, ?, ?, ?)", [h, v, v, v]);
  }
  // Kaputte Stunden von „gestern".
  for (const [h, v] of [[9, 0.01], [10, 0.02]]) {
    await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh, reconciled) VALUES ('2026-07-12', ?, ?, ?, ?, 1)", [h, v, v, v]);
  }
  await dbRun(db, "INSERT INTO prognosis_daily_consumption (day_key, consumption_kwh, completed) VALUES ('2026-07-12', 0.03, 1)");

  const marked = await markHoursIncomplete(db, '2026-07-12', [9, 10]);
  assert.equal(marked.length, 2);
  const rows = await new Promise((resolve, reject) => db.all(
    "SELECT hour, consumption_kwh, incomplete, primary_kwh FROM prognosis_hourly_consumption WHERE day_key='2026-07-12' ORDER BY hour",
    (e, r) => (e ? reject(e) : resolve(r))
  ));
  assert.deepEqual(rows.map((r) => r.consumption_kwh), [2.0, 2.1]); // Vortageswerte eingesetzt
  assert.ok(rows.every((r) => r.incomplete === 1));
  assert.deepEqual(rows.map((r) => r.primary_kwh), [0.01, 0.02]); // Rohwerte bleiben stehen
  await new Promise((r) => db.close(r));
});
