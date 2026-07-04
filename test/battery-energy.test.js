'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const {
  updateBatteryEnergyCounter, readBatteryEnergyValues,
} = require('../src/batterie/energy');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE battery_energy_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_power_ts INTEGER,
    day_charge_kwh REAL NOT NULL DEFAULT 0,
    day_discharge_kwh REAL NOT NULL DEFAULT 0,
    week_charge_offset REAL NOT NULL DEFAULT 0,
    week_discharge_offset REAL NOT NULL DEFAULT 0,
    month_charge_offset REAL NOT NULL DEFAULT 0,
    month_discharge_offset REAL NOT NULL DEFAULT 0,
    year_charge_offset REAL NOT NULL DEFAULT 0,
    year_discharge_offset REAL NOT NULL DEFAULT 0,
    previous_year_charge_total REAL NOT NULL DEFAULT 0,
    previous_year_discharge_total REAL NOT NULL DEFAULT 0,
    last_rollover_date TEXT NOT NULL DEFAULT '',
    week_key TEXT NOT NULL DEFAULT '',
    month_key TEXT NOT NULL DEFAULT '',
    year_key TEXT NOT NULL DEFAULT ''
  )`);
  return db;
}

function cal(dateKey, weekKey, monthKey, yearKey) {
  return { dateKey, weekKey, monthKey, yearKey };
}

test('Ladeleistung wird über kurze Intervalle in die Tagesladung integriert', async () => {
  const db = await freshDb();
  const day = cal('2026-06-29', '2026-W27', '2026-06', '2026');
  await updateBatteryEnergyCounter(db, 3600, day, 0); // initialisiert last_power_ts
  await updateBatteryEnergyCounter(db, 3600, day, 5 * 60 * 1000); // 5 Minuten später
  const values = await readBatteryEnergyValues(db);
  // 3600 W über 300 s = 0,3 kWh
  assert.equal(Math.round(values.today.charge * 1000) / 1000, 0.3);
  assert.equal(values.today.discharge, 0);
});

test('Entladeleistung wird separat in die Tagesentladung integriert', async () => {
  const db = await freshDb();
  const day = cal('2026-06-29', '2026-W27', '2026-06', '2026');
  await updateBatteryEnergyCounter(db, -3600, day, 0);
  await updateBatteryEnergyCounter(db, -3600, day, 5 * 60 * 1000); // 5 Minuten später
  const values = await readBatteryEnergyValues(db);
  assert.equal(values.today.charge, 0);
  // 3600 W über 300 s = 0,3 kWh
  assert.equal(Math.round(values.today.discharge * 1000) / 1000, 0.3);
});

test('Lücken über 5 Minuten werden nicht integriert (kein Ausreißer nach Neustart)', async () => {
  const db = await freshDb();
  const day = cal('2026-06-29', '2026-W27', '2026-06', '2026');
  await updateBatteryEnergyCounter(db, 5000, day, 0);
  await updateBatteryEnergyCounter(db, 5000, day, 6 * 60 * 1000); // 6 Minuten Lücke
  const values = await readBatteryEnergyValues(db);
  assert.equal(values.today.charge, 0);
});

test('Tageswechsel überführt Netto-Ladung in Woche/Monat/Jahr', async () => {
  const db = await freshDb();
  const day1 = cal('2026-06-29', '2026-W27', '2026-06', '2026');
  const day2 = cal('2026-06-30', '2026-W27', '2026-06', '2026');
  await updateBatteryEnergyCounter(db, 3600, day1, 0);
  await updateBatteryEnergyCounter(db, 3600, day1, 5 * 60 * 1000); // +0,3 kWh geladen
  await updateBatteryEnergyCounter(db, 3600, day1, 10 * 60 * 1000); // +0,3 kWh geladen
  await updateBatteryEnergyCounter(db, -3600, day1, 15 * 60 * 1000); // +0,3 kWh entladen
  await updateBatteryEnergyCounter(db, 0, day2, 16 * 60 * 1000); // Tageswechsel

  const values = await readBatteryEnergyValues(db);
  assert.equal(Math.round(values.year.charge * 100) / 100, 0.6);
  assert.equal(Math.round(values.year.discharge * 100) / 100, 0.3);
  assert.equal(Math.round(values.year.netCharge * 100) / 100, 0.3);
  assert.equal(Math.round(values.week.netCharge * 100) / 100, 0.3);
});

test('Jahreswechsel verschiebt die Netto-Ladung ins Vorjahr', async () => {
  const db = await freshDb();
  const dec31 = cal('2025-12-31', '2025-W53', '2025-12', '2025');
  const jan01 = cal('2026-01-01', '2026-W01', '2026-01', '2026');
  await updateBatteryEnergyCounter(db, 3600, dec31, 0);
  await updateBatteryEnergyCounter(db, 3600, dec31, 5 * 60 * 1000); // 0,3 kWh geladen am 31.12.
  await updateBatteryEnergyCounter(db, 0, jan01, 6 * 60 * 1000); // Jahreswechsel

  const values = await readBatteryEnergyValues(db);
  assert.equal(Math.round(values.previousYear.netCharge * 1000) / 1000, 0.3);
  assert.equal(values.year.netCharge, 0);
});
