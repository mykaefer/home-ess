'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-daily-history-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const {
  recordDailyMetric, getDailyMetricValue, computeYearStats, statsFromRows, dayKeyOffset, isValidDayKey,
} = require('../src/history/daily-metrics');
const {
  updateSummaryState: updatePvSummaryState,
  setManualOffset: setPvManualOffset,
} = require('../src/photovoltaik/aggregation');
const {
  updateSummaryState: updateStromSummaryState,
  setManualOffset: setStromManualOffset,
} = require('../src/stromverbrauch/aggregation');

function freshDb() {
  const dbPath = process.env.HOME_ESS_DB;
  fs.rmSync(dbPath, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

function cal(dateKey, weekKey, yearKey) {
  return { dateKey, weekKey, yearKey };
}

test('dayKeyOffset verschiebt Kalenderdaten tagesgenau, auch über Monats-/Jahresgrenzen', () => {
  assert.equal(dayKeyOffset('2026-07-02', -1), '2026-07-01');
  assert.equal(dayKeyOffset('2026-07-01', -1), '2026-06-30');
  assert.equal(dayKeyOffset('2026-01-01', -1), '2025-12-31');
});

test('statsFromRows liefert Durchschnitt/Min+Datum/Max+Datum/Summe', () => {
  const stats = statsFromRows([
    { day_key: '2026-06-01', value: 5 },
    { day_key: '2026-06-02', value: 8 },
    { day_key: '2026-06-03', value: 2 },
  ]);
  assert.equal(stats.sum, 15);
  assert.equal(stats.average, 5);
  assert.equal(stats.min, 2);
  assert.equal(stats.minDate, '2026-06-03');
  assert.equal(stats.max, 8);
  assert.equal(stats.maxDate, '2026-06-02');
});

test('statsFromRows liefert Nullwerte ohne Daten', () => {
  const stats = statsFromRows([]);
  assert.deepEqual(stats, { average: null, min: null, minDate: null, max: null, maxDate: null, sum: null });
});

test('recordDailyMetric/getDailyMetricValue/computeYearStats runden über mehrere Kennzahlen sauber', async () => {
  const db = await freshDb();
  await recordDailyMetric(db, 'pv', '2026-06-29', 5);
  await recordDailyMetric(db, 'pv', '2026-06-30', 8);
  await recordDailyMetric(db, 'pv', '2025-12-31', 99); // anderes Jahr, darf Statistik nicht beeinflussen
  await recordDailyMetric(db, 'strom.netzbezug', '2026-06-29', 3); // andere Kennzahl, eigener Namensraum

  assert.equal(await getDailyMetricValue(db, 'pv', '2026-06-29'), 5);
  assert.equal(await getDailyMetricValue(db, 'pv', '2026-07-01'), null);

  const stats = await computeYearStats(db, 'pv', '2026');
  assert.equal(stats.sum, 13);
  assert.equal(stats.average, 6.5);
  assert.equal(stats.min, 5);
  assert.equal(stats.minDate, '2026-06-29');
  assert.equal(stats.max, 8);
  assert.equal(stats.maxDate, '2026-06-30');
  db.close();
});

test('PV-Tageswechsel historisiert den abgeschlossenen Vortag', async () => {
  const db = await freshDb();
  await updatePvSummaryState(db, 5, new Date(2026, 5, 29, 12)); // Tag 1: 5 kWh
  assert.equal(await getDailyMetricValue(db, 'pv', '2026-06-29'), null, 'noch kein abgeschlossener Vortag');

  await updatePvSummaryState(db, 8, new Date(2026, 5, 30, 12)); // Tag 2: Rollover schließt Tag 1 ab
  assert.equal(await getDailyMetricValue(db, 'pv', '2026-06-29'), 5);

  await updatePvSummaryState(db, 3, new Date(2026, 6, 1, 12)); // Tag 3: Rollover schließt Tag 2 ab
  assert.equal(await getDailyMetricValue(db, 'pv', '2026-06-30'), 8);

  const stats = await computeYearStats(db, 'pv', '2026');
  assert.equal(stats.sum, 13);
  assert.equal(stats.min, 5);
  assert.equal(stats.max, 8);
  db.close();
});

test('Stromverbrauch-Tageswechsel historisiert Eigenverbrauch/Netzbezug aus dem bereits historisierten PV-Ertrag', async () => {
  const db = await freshDb();
  const day1 = cal('2026-06-29', '2026-W27', '2026');
  const day2 = cal('2026-06-30', '2026-W27', '2026');

  // PV-Ertrag des Vortags liegt bereits in der Historie (wie im echten Ablauf,
  // da buildPhotovoltaikSnapshot innerhalb von buildStromverbrauchSnapshot vor
  // den Zähler-/Summen-Updates läuft).
  await recordDailyMetric(db, 'pv', '2026-06-29', 5);

  await updateStromSummaryState(db, { import: 0, export: 0 }, day1); // Initialisierung, kein Rollover
  await updateStromSummaryState(db, { import: 6, export: 1 }, day2); // Rollover schließt Tag 1 ab

  // Eigenverbrauch = PV(5) + Import(6) - Export(1) = 10; Netzbezug = Import(6) - Export(1) = 5.
  assert.equal(await getDailyMetricValue(db, 'strom.eigenverbrauch', '2026-06-29'), 10);
  assert.equal(await getDailyMetricValue(db, 'strom.netzbezug', '2026-06-29'), 5);
  db.close();
});

test('isValidDayKey akzeptiert nur echte Kalenderdaten', () => {
  assert.equal(isValidDayKey('2026-06-15'), true);
  assert.equal(isValidDayKey('2026-01-01'), true);
  assert.equal(isValidDayKey('2026-02-30'), false); // 30. Februar existiert nicht
  assert.equal(isValidDayKey('2026-13-01'), false); // Monat 13
  assert.equal(isValidDayKey('15.06.2026'), false); // falsches Format
  assert.equal(isValidDayKey(''), false);
  assert.equal(isValidDayKey(null), false);
});

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

test('PV-Abgleich setzt Wochen-/Jahres-/Vorjahressumme direkt', async () => {
  const db = await freshDb();
  await setPvManualOffset(db, 'week', 12, new Date(2026, 6, 2, 12));
  await setPvManualOffset(db, 'year', 340, new Date(2026, 6, 2, 12));
  await setPvManualOffset(db, 'previousYear', 4100, new Date(2026, 6, 2, 12));
  const row = await dbGet(db, 'SELECT week_offset, year_offset, previous_year_total FROM pv_summary_aggregation WHERE id = 1');
  assert.equal(row.week_offset, 12);
  assert.equal(row.year_offset, 340);
  assert.equal(row.previous_year_total, 4100);
  await assert.rejects(() => setPvManualOffset(db, 'month', 1, new Date(2026, 6, 2, 12)), /Unbekannter Zeitraum/);
  db.close();
});

test('Stromverbrauch-Abgleich setzt Vorjahressumme für Netzbezug und Einspeisung', async () => {
  const db = await freshDb();
  await setStromManualOffset(db, 'previousYear', { netzbezug: 2500, einspeisung: 3300 }, new Date(2026, 6, 2, 12));
  const row = await dbGet(
    db,
    'SELECT previous_year_import_total, previous_year_export_total FROM stromverbrauch_aggregation WHERE id = 1'
  );
  assert.equal(row.previous_year_import_total, 2500);
  assert.equal(row.previous_year_export_total, 3300);
  db.close();
});

test('Extremwert-Abgleich (Seed) ergibt Minimum/Maximum + Datum aus der Historie', async () => {
  const db = await freshDb();
  // Zwei Tageswerte als Startwerte setzen – daraus ergeben sich Min/Max/Datum.
  await recordDailyMetric(db, 'strom.netzbezug', '2026-01-10', 3);
  await recordDailyMetric(db, 'strom.netzbezug', '2026-08-20', 21);
  const stats = await computeYearStats(db, 'strom.netzbezug', '2026');
  assert.equal(stats.min, 3);
  assert.equal(stats.minDate, '2026-01-10');
  assert.equal(stats.max, 21);
  assert.equal(stats.maxDate, '2026-08-20');
  db.close();
});
