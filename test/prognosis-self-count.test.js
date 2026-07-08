'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const selfCount = require('../src/prognosis/self-count');
const { divergesTooMuch, integrateSelfCount, reconcileCompletedHours } = selfCount;

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL DEFAULT 0,
    primary_kwh REAL, self_kwh REAL, reconciled INTEGER DEFAULT 0,
    PRIMARY KEY(day_key, hour))`);
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, completed INTEGER, updated_at INTEGER)`);
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT)`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'UTC', 0, '', '', '')");
  return db;
}

test.beforeEach(() => selfCount.resetForTests());

test('divergesTooMuch verlangt relative UND absolute Abweichung', () => {
  // 1.0 vs 2.25: absolut 1.25 > 0.2, relativ 0.56 > 0.25 -> ja
  assert.equal(divergesTooMuch(1.0, 2.25), true);
  // 1.0 vs 1.1: absolut 0.1 <= 0.2 -> nein (auch wenn relativ 10 %)
  assert.equal(divergesTooMuch(1.0, 1.1), false);
  // 5.0 vs 5.3: absolut 0.3 > 0.2, relativ 0.057 <= 0.25 -> nein
  assert.equal(divergesTooMuch(5.0, 5.3), false);
});

test('divergesTooMuch respektiert eine abweichende konfigurierte Schwelle', () => {
  // 1.0 vs 1.5: absolut 0.5 > 0.2, relativ 0.33 — bei 25 % ersetzt, bei 60 % nicht.
  assert.equal(divergesTooMuch(1.0, 1.5, 0.25), true);
  assert.equal(divergesTooMuch(1.0, 1.5, 0.6), false);
  // Ungültige Schwelle fällt auf den Standard (25 %) zurück.
  assert.equal(divergesTooMuch(1.0, 1.5, null), true);
  assert.equal(divergesTooMuch(1.0, 1.5, 0), true);
});

test('divergesTooMuch respektiert eine konfigurierte Mindest-Abweichung (kWh)', () => {
  // 1.0 vs 1.5: absolut 0.5 — bei Mindest-Abweichung 0.6 kWh greift der Guard nicht.
  assert.equal(divergesTooMuch(1.0, 1.5, 0.25, 0.6), false);
  assert.equal(divergesTooMuch(1.0, 1.5, 0.25, 0.4), true);
  // 0 kWh ist gültig: allein die relative Schwelle entscheidet.
  assert.equal(divergesTooMuch(1.0, 1.15, 0.1, 0), true);
  // Ungültige Mindest-Abweichung fällt auf den Standard (0,2 kWh) zurück.
  assert.equal(divergesTooMuch(1.0, 1.1, 0.05, null), false);
  assert.equal(divergesTooMuch(1.0, 1.1, 0.05, -1), false);
});

test('Guard nutzt die in den Modellparametern konfigurierte Schwelle', async () => {
  const db = await freshDb();
  await dbRun(db, `CREATE TABLE prognosis_config (
    id INTEGER PRIMARY KEY, history_days INTEGER, behavior_model TEXT,
    behavior_active INTEGER, self_count_guard_percent REAL)`);
  await dbRun(db, "INSERT INTO prognosis_config VALUES (1, 28, 'grid_parallel', 0, 60)");
  // Abweichung 29 % (2.25 vs 1.6): bei Standard 25 % würde ersetzt,
  // bei konfigurierten 60 % bleibt die Bilanz maßgeblich.
  await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-05', 7, 2.25, 2.25, 1.6)");
  const now = Date.parse('2026-07-05T09:30:00Z');
  const res = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res.replaced, 0);
  const row = await dbGet(db, "SELECT round(consumption_kwh,2) c, reconciled r FROM prognosis_hourly_consumption WHERE hour=7");
  assert.equal(row.c, 2.25);
  assert.equal(row.r, 1);

  // Engere Schwelle (10 %): dieselbe Abweichung wird jetzt ersetzt.
  await dbRun(db, 'UPDATE prognosis_config SET self_count_guard_percent = 10 WHERE id = 1');
  await dbRun(db, 'UPDATE prognosis_hourly_consumption SET reconciled = 0 WHERE hour = 7');
  await dbRun(db, "INSERT INTO prognosis_daily_consumption (day_key, consumption_kwh, completed) VALUES ('2026-07-05', 2.25, 0)");
  const res2 = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res2.replaced, 1);
  const row2 = await dbGet(db, "SELECT round(consumption_kwh,2) c FROM prognosis_hourly_consumption WHERE hour=7");
  assert.equal(row2.c, 1.6);
  await new Promise((r) => db.close(r));
});

test('Guard nutzt die konfigurierte Mindest-Abweichung (kWh)', async () => {
  const db = await freshDb();
  await dbRun(db, `CREATE TABLE prognosis_config (
    id INTEGER PRIMARY KEY, history_days INTEGER, behavior_model TEXT,
    behavior_active INTEGER, self_count_guard_percent REAL, self_count_guard_min_kwh REAL)`);
  // Abweichung 0.65 kWh / 29 %: relative Schwelle 25 % wäre gerissen, aber die
  // konfigurierte Mindest-Abweichung von 1 kWh schützt die Stunde.
  await dbRun(db, "INSERT INTO prognosis_config VALUES (1, 28, 'grid_parallel', 0, 25, 1.0)");
  await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-05', 7, 2.25, 2.25, 1.6)");
  const now = Date.parse('2026-07-05T09:30:00Z');
  const res = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res.replaced, 0);

  // Kleinere Mindest-Abweichung (0,5 kWh): dieselbe Stunde wird jetzt ersetzt.
  await dbRun(db, 'UPDATE prognosis_config SET self_count_guard_min_kwh = 0.5 WHERE id = 1');
  await dbRun(db, 'UPDATE prognosis_hourly_consumption SET reconciled = 0 WHERE hour = 7');
  await dbRun(db, "INSERT INTO prognosis_daily_consumption (day_key, consumption_kwh, completed) VALUES ('2026-07-05', 2.25, 0)");
  const res2 = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res2.replaced, 1);
  const row = await dbGet(db, "SELECT round(consumption_kwh,2) c FROM prognosis_hourly_consumption WHERE hour=7");
  assert.equal(row.c, 1.6);
  await new Promise((r) => db.close(r));
});

test('integrateSelfCount integriert Leistung stundenweise (kein Sprung beim ersten Tick)', async () => {
  const db = await freshDb();
  const t0 = Date.parse('2026-07-05T07:10:00Z');
  await integrateSelfCount(db, new Map(), 1000, t0); // erster Tick: nur Basis
  await integrateSelfCount(db, new Map(), 1000, t0 + 60000); // +1 min @ 1000 W = 0.01667 kWh
  await integrateSelfCount(db, new Map(), 1000, t0 + 120000);
  const row = await dbGet(db, "SELECT round(self_kwh,4) s FROM prognosis_hourly_consumption WHERE day_key='2026-07-05' AND hour=7");
  assert.equal(row.s, 0.0333);
  await new Promise((r) => db.close(r));
});

test('Guard ersetzt eine stark abweichende Bilanzstunde durch die Selbstzählung', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-05', 7, 2.25, 2.25, 1.02)");
  await dbRun(db, "INSERT INTO prognosis_daily_consumption (day_key, consumption_kwh, completed) VALUES ('2026-07-05', 2.25, 0)");
  const now = Date.parse('2026-07-05T09:30:00Z'); // Stunde 9 -> Stunde 7 ist abgeschlossen
  const res = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res.replaced, 1);
  const row = await dbGet(db, "SELECT round(consumption_kwh,2) c, reconciled r FROM prognosis_hourly_consumption WHERE hour=7");
  assert.equal(row.c, 1.02);
  assert.equal(row.r, 1);
  const day = await dbGet(db, "SELECT round(consumption_kwh,2) c FROM prognosis_daily_consumption WHERE day_key='2026-07-05'");
  assert.equal(day.c, 1.02);
  await new Promise((r) => db.close(r));
});

test('Guard lässt eine plausible Bilanzstunde unverändert (Verbrauchsspitze bleibt erhalten)', async () => {
  const db = await freshDb();
  // Kochspitze: Bilanz 3.0, Selbstzählung 2.9 -> absolut 0.1 <= 0.2 -> nicht ersetzen
  await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-05', 7, 3.0, 3.0, 2.9)");
  const now = Date.parse('2026-07-05T09:30:00Z');
  const res = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res.replaced, 0);
  const row = await dbGet(db, "SELECT round(consumption_kwh,2) c, reconciled r FROM prognosis_hourly_consumption WHERE hour=7");
  assert.equal(row.c, 3.0);
  assert.equal(row.r, 1);
  await new Promise((r) => db.close(r));
});

test('mit echtem Zähler greift der Guard nicht (Zähler ist maßgeblich)', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-05', 7, 2.25, 2.25, 1.02)");
  const now = Date.parse('2026-07-05T09:30:00Z');
  const res = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: true }, now);
  assert.equal(res.replaced, 0);
  const row = await dbGet(db, "SELECT round(consumption_kwh,2) c, reconciled r FROM prognosis_hourly_consumption WHERE hour=7");
  assert.equal(row.c, 2.25);
  assert.equal(row.r, 1);
  await new Promise((r) => db.close(r));
});

test('die noch laufende Stunde wird nicht abgesichert', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh, self_kwh) VALUES ('2026-07-05', 9, 2.25, 2.25, 1.02)");
  const now = Date.parse('2026-07-05T09:30:00Z'); // Stunde 9 läuft noch
  const res = await reconcileCompletedHours(db, new Map(), { selfMeterPresent: false }, now);
  assert.equal(res.checked, 0);
  const row = await dbGet(db, "SELECT round(consumption_kwh,2) c, reconciled r FROM prognosis_hourly_consumption WHERE hour=9");
  assert.equal(row.c, 2.25);
  assert.equal(row.r, 0);
  await new Promise((r) => db.close(r));
});
