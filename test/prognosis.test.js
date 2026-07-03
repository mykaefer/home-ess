'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const {
  normalizedProfile, adjustedConsumptionDelta, recordConsumptionSample, simulateDays,
  selectUnlearnedDailyTarget,
  hoursUntilNextSunrise, projectedConsumptionForHours,
} = require('../src/prognosis/forecast');
const { localCalendar } = require('../src/local-time');
const { ENVIRONMENT_STATE_IDS } = require('../src/mqtt/config');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function baseInput() {
  const profile = Array(24).fill(0);
  profile[12] = 1;
  return {
    forecast: {
      todayRemainingKwh: 0,
      days: [{ dateKey: '2026-06-29', label: 'Heute', totalKwh: 0 }],
      hours: [],
    },
    model: {
      local: { time: { hours: 0, minutes: 0 } },
      dailyTarget: 2,
      profile,
      remainingToday: 2,
      remainingByHour: profile.map((share) => share * 2),
    },
    config: { chargeEfficiency: 100, dischargeEfficiency: 100 },
    batteryConfig: { minSoc: 20, capacityAh: 195.3125, batteryType: 'lifepo4', cellCount: 16 },
    batteryData: { soc: 100, minSoc: null },
  };
}

test('Verbrauchsprofil wird auf genau einen Tag normiert', () => {
  const profile = normalizedProfile(Array(24).fill(2));
  assert.equal(profile.length, 24);
  assert.ok(Math.abs(profile.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test('Batterieladung wird entfernt und Entladung dem Hausverbrauch zugerechnet', () => {
  assert.equal(adjustedConsumptionDelta(0.1, 100, 60 * 60 * 1000), 0);
  assert.equal(adjustedConsumptionDelta(0, -100, 60 * 60 * 1000), 0.1);
  assert.equal(adjustedConsumptionDelta(1, 0, 60 * 60 * 1000, 500), 0.5);
});

test('ungelernte Wochentage übernehmen den jüngsten Lerntag als Vorlage', () => {
  // Vortag vorhanden: er ist die Vorlage – nicht die Tageshochrechnung.
  assert.equal(selectUnlearnedDailyTarget({
    today: 10, elapsedShare: 0.5, previousDayKwh: 24, recentAverage: 35, annualAverage: 50,
  }), 24);
  // Ohne Vortag: gleitender Mittelwert vor dem Jahreswert.
  assert.equal(selectUnlearnedDailyTarget({
    today: 0.2, elapsedShare: 0.05, previousDayKwh: null, recentAverage: 22, annualAverage: 50,
  }), 22);
  assert.equal(selectUnlearnedDailyTarget({
    today: 0.2, elapsedShare: 0.05, previousDayKwh: null, recentAverage: null, annualAverage: 50,
  }), 50);
  // Kaltstart: Hochrechnung erst ab 30 % Tagesanteil – frühe Morgenstunden mit
  // ungelernter Profilform dürfen nicht mehr explodieren.
  assert.equal(selectUnlearnedDailyTarget({
    today: 5, elapsedShare: 0.1, previousDayKwh: null, recentAverage: null, annualAverage: null,
  }), 0);
  assert.equal(selectUnlearnedDailyTarget({
    today: 10, elapsedShare: 0.5, previousDayKwh: null, recentAverage: null, annualAverage: null,
  }), 20);
});

test('bereinigte Verbrauchssamples werden stündlich und täglich persistiert', async () => {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT
  )`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'Europe/Berlin', 1, '', '', '')");
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, max_temperature REAL,
    completed INTEGER, updated_at INTEGER
  )`);
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL, PRIMARY KEY(day_key, hour)
  )`);
  const start = new Date('2026-06-29T10:00:00Z');
  await recordConsumptionSample(db, 0, new Map(), { batteryPower: 0 }, start);
  await recordConsumptionSample(db, 0.1, new Map(), { batteryPower: 6000 }, new Date(start.getTime() + 60000));
  await recordConsumptionSample(db, 0.1, new Map(), { batteryPower: -6000 }, new Date(start.getTime() + 120000));
  const row = await dbGet(db, 'SELECT consumption_kwh, raw_consumption_kwh FROM prognosis_daily_consumption');
  assert.equal(row.raw_consumption_kwh, 0.1);
  assert.equal(row.consumption_kwh, 0.1);
  await new Promise((resolve) => db.close(resolve));
});

test('verspäteter Tageszähler-Reset übernimmt den Vortag nicht in den neuen Lerntag', async () => {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT
  )`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'Europe/Berlin', 1, '', '', '')");
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, max_temperature REAL,
    completed INTEGER, updated_at INTEGER
  )`);
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL, PRIMARY KEY(day_key, hour)
  )`);

  const midnight = new Date('2026-06-29T22:00:00Z'); // 00:00 Europe/Berlin
  await recordConsumptionSample(db, 30.7, new Map(), { batteryPower: 0 }, midnight);
  await recordConsumptionSample(db, 0.1, new Map(), { batteryPower: 0 }, new Date(midnight.getTime() + 60000));
  await recordConsumptionSample(db, 0.2, new Map(), { batteryPower: 0 }, new Date(midnight.getTime() + 120000));

  const row = await dbGet(db, 'SELECT consumption_kwh, raw_consumption_kwh FROM prognosis_daily_consumption');
  assert.ok(Math.abs(row.consumption_kwh - 0.1) < 1e-12);
  assert.equal(row.raw_consumption_kwh, 0.2);
  await new Promise((resolve) => db.close(resolve));
});

test('ein ungültiges Intervall mit riesigem Zählersprung überschwemmt den Tageswert nicht', async () => {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT
  )`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'Europe/Berlin', 1, '', '', '')");
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, max_temperature REAL,
    completed INTEGER, updated_at INTEGER
  )`);
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL, PRIMARY KEY(day_key, hour)
  )`);

  const start = new Date('2026-06-29T10:00:00Z');
  await recordConsumptionSample(db, 10, new Map(), { batteryPower: 0 }, start);
  // Zeitstempel-Lücke > 5 Minuten und Sprung >= 2 kWh: ungültiges Intervall,
  // der Rohsprung darf trotzdem nur bis zur Obergrenze übernommen werden.
  await recordConsumptionSample(db, 510, new Map(), { batteryPower: 0 }, new Date(start.getTime() + 6 * 60000));

  const row = await dbGet(db, 'SELECT consumption_kwh, raw_consumption_kwh FROM prognosis_daily_consumption');
  assert.equal(row.raw_consumption_kwh, 510);
  assert.equal(row.consumption_kwh, 0);
  await new Promise((resolve) => db.close(resolve));
});

test('aufgeblähter Tageswert wird aus plausiblen Stundenwerten selbst geheilt', async () => {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT
  )`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'Europe/Berlin', 1, '', '', '')");
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, max_temperature REAL,
    completed INTEGER, updated_at INTEGER
  )`);
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL, PRIMARY KEY(day_key, hour)
  )`);
  const start = new Date('2026-06-29T10:00:00Z');
  await recordConsumptionSample(db, 0, new Map(), { batteryPower: 0 }, start);
  await recordConsumptionSample(db, 1, new Map(), { batteryPower: 0 }, new Date(start.getTime() + 60000));
  await dbRun(db, 'UPDATE prognosis_daily_consumption SET consumption_kwh = 150');
  await recordConsumptionSample(db, 1.1, new Map(), { batteryPower: 0 }, new Date(start.getTime() + 120000));
  const row = await dbGet(db, 'SELECT consumption_kwh FROM prognosis_daily_consumption');
  assert.ok(Math.abs(row.consumption_kwh - 1.1) < 1e-12);
  await new Promise((resolve) => db.close(resolve));
});

test('Simulation verwendet für jeden Folgetag dessen eigene Wochentagskurve', () => {
  const input = baseInput();
  input.model.remainingByHour = Array(24).fill(0);
  input.model.remainingToday = 0;
  input.model.profilesByWeekday = Array.from({ length: 7 }, () => {
    const profile = Array(24).fill(0);
    profile[12] = 1;
    return profile;
  });
  input.model.dailyTargetsByWeekday = [1, 1, 2, 4, 1, 1, 1];
  input.forecast.days.push(
    { dateKey: '2026-06-30', label: 'Morgen', totalKwh: 0 },
    { dateKey: '2026-07-01', label: 'Mittwoch', totalKwh: 0 }
  );
  const result = simulateDays(input);
  assert.equal(result.days[1].loadKwh, 2);
  assert.equal(result.days[2].loadKwh, 4);
});

test('gelernte Funktionslasten werden je Stunde separat aufgeschlagen', () => {
  const input = baseInput();
  input.model.remainingByHour = Array(24).fill(0);
  input.model.remainingToday = 0;
  // Heizung / Klima nach Temperatur-Bucket, Kochen nach Wochentag.
  const kochenByWeekday = Array.from({ length: 7 }, () => Array(24).fill(0));
  const tuesday = 2; // 2026-06-30 ist ein Dienstag
  kochenByWeekday[tuesday][12] = 1.5;
  input.model.functionModels = {
    heizung_klima: { type: 'temperature', buckets: new Map([[30, (() => { const h = Array(24).fill(0); h[14] = 2; return h; })()]]) },
    kochen: { type: 'weekday', hourlyByWeekday: kochenByWeekday },
  };
  input.forecast.days.push({ dateKey: '2026-06-30', label: 'Morgen', totalKwh: 0 });
  input.forecast.hours = [{ dateKey: '2026-06-30', hour: 14, kwh: 0, temperature: 31 }];
  const result = simulateDays(input);
  assert.equal(result.days[1].functionsKwh, 3.5);
  assert.equal(result.days[1].loadKwh, 5.5);
});

test('Batteriesimulation respektiert Mindest-SoC', () => {
  const result = simulateDays(baseInput());
  assert.equal(result.today.gridKwh, 0);
  assert.equal(result.today.batterySocEnd, 80);
  assert.equal(result.initialStored, 8);
});

test('fehlende Energie wird als Netzbedarf ausgewiesen', () => {
  const input = baseInput();
  input.batteryData.soc = 20;
  const result = simulateDays(input);
  assert.equal(result.today.gridKwh, 2);
  assert.equal(result.status, 0);
  assert.equal(result.today.batterySocEnd, 20);
});

test('SoC beim rechnerischen Ladebeginn des Folgetags bewertet die Nacht', () => {
  const input = baseInput();
  input.batteryData.soc = 50;
  input.model.remainingByHour = Array(24).fill(0);
  input.model.remainingToday = 0;
  input.model.dailyTarget = 2.5;
  input.model.profile = Array(24).fill(0);
  input.model.profile[0] = 0.5;
  input.model.profile[1] = 0.5;
  input.forecast.days.push({ dateKey: '2026-06-30', label: 'Morgen', totalKwh: 3 });
  input.forecast.hours = [{ dateKey: '2026-06-30', hour: 2, kwh: 3 }];

  const result = simulateDays(input);
  assert.equal(result.nextChargeStart.hour, 2);
  assert.equal(result.nextChargeStart.soc, 25);
  assert.equal(result.nextChargeStart.dayOffset, 1);
  assert.equal(result.gridBeforeCharge, 0);
  assert.equal(result.status, 1);
});

test('Dunkelflaute wird bis zum ersten später sichtbaren Ladebeginn kumuliert', () => {
  const input = baseInput();
  input.model.remainingByHour = Array(24).fill(0);
  input.model.remainingToday = 0;
  input.model.dailyTarget = 2;
  input.model.profile = Array(24).fill(0);
  input.model.profile[0] = 0.5;
  input.model.profile[1] = 0.5;
  input.forecast.days.push(
    { dateKey: '2026-06-30', label: 'Morgen', totalKwh: 0 },
    { dateKey: '2026-07-01', label: 'Mittwoch', totalKwh: 3 }
  );
  input.forecast.hours = [{ dateKey: '2026-07-01', hour: 2, kwh: 3 }];

  const result = simulateDays(input);
  assert.equal(result.nextChargeStart.dayOffset, 2);
  assert.equal(result.nextChargeStart.hour, 2);
  assert.equal(result.nextChargeStart.soc, 60);
  assert.equal(result.minimumReached, null);
});

test('erwartetes Erreichen des Mindest-SoC erhält Datum und Uhrzeit', () => {
  const input = baseInput();
  input.batteryData.soc = 30;
  input.model.remainingByHour = Array(24).fill(0);
  input.model.remainingToday = 0;
  input.model.dailyTarget = 2;
  input.model.profile = Array(24).fill(0);
  input.model.profile[0] = 1;
  input.forecast.days.push(
    { dateKey: '2026-06-30', label: 'Morgen', totalKwh: 0 },
    { dateKey: '2026-07-01', label: 'Mittwoch', totalKwh: 3 }
  );
  input.forecast.hours = [{ dateKey: '2026-07-01', hour: 2, kwh: 3 }];

  const result = simulateDays(input);
  assert.equal(result.minimumReached.dayOffset, 1);
  assert.equal(result.minimumReached.hour, 0.5);
  assert.equal(result.minimumBeforeCharge, true);
  assert.equal(result.status, 0);
});

test('lokaler Tageswechsel folgt Europe/Berlin statt Server-UTC', () => {
  const calendar = localCalendar(new Map(), 'Europe/Berlin', new Date('2026-06-29T22:30:00Z'));
  assert.equal(calendar.dateKey, '2026-06-30');
  assert.equal(calendar.hours, 0);
});

test('MQTT-Datum hat für den Tageswechsel Vorrang', () => {
  const cache = new Map([
    [ENVIRONMENT_STATE_IDS.clockDate, { value: '04.07.2026' }],
    [ENVIRONMENT_STATE_IDS.clockTime, { value: '00:01:00' }],
  ]);
  const calendar = localCalendar(cache, 'UTC', new Date('2026-07-03T22:01:00Z'));
  assert.equal(calendar.dateKey, '2026-07-04');
  assert.equal(calendar.hours, 0);
});

test('Sonnenaufgangs-Horizont besitzt ohne Koordinaten einen stabilen Ersatzwert', () => {
  const config = { latitude: '', longitude: '', timezone: 'Europe/Berlin' };
  const morning = { date: { year: 2026, month: 6, day: 29 }, time: { hours: 5, minutes: 0, seconds: 0 } };
  const evening = { date: { year: 2026, month: 6, day: 29 }, time: { hours: 20, minutes: 0, seconds: 0 } };
  assert.equal(hoursUntilNextSunrise(config, morning), 1);
  assert.equal(hoursUntilNextSunrise(config, evening), 10);
});

test('Verbrauch bis Sonnenaufgang integriert die gelernte Stundenkurve', () => {
  const profile = Array(24).fill(1 / 24);
  const model = {
    local: { date: { year: 2026, month: 6, day: 29 }, time: { hours: 20, minutes: 0, seconds: 0 } },
    dailyTarget: 24,
    profile,
    profilesByWeekday: Array.from({ length: 7 }, () => profile),
    dailyTargetsByWeekday: Array(7).fill(24),
    intradayFactor: 1,
  };
  assert.equal(projectedConsumptionForHours(model, null, 2.5), 2.5);
});

test('ungelernte Wochentage erhalten Kurve und Ziel des jüngsten Lerntags', async () => {
  const { buildConsumptionModel } = require('../src/prognosis/forecast');
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mqtt_config (
    id INTEGER PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
    latitude REAL, longitude REAL, timezone TEXT, dst_enabled INTEGER,
    outdoor_temperature_topic TEXT, clock_time_topic TEXT, clock_date_topic TEXT
  )`);
  await dbRun(db, "INSERT INTO mqtt_config VALUES (1, '', 1883, '', '', NULL, NULL, 'Europe/Berlin', 1, '', '', '')");
  await dbRun(db, `CREATE TABLE prognosis_daily_consumption (
    day_key TEXT PRIMARY KEY, consumption_kwh REAL, raw_consumption_kwh REAL, max_temperature REAL,
    completed INTEGER, updated_at INTEGER
  )`);
  await dbRun(db, `CREATE TABLE prognosis_hourly_consumption (
    day_key TEXT, hour INTEGER, consumption_kwh REAL, PRIMARY KEY(day_key, hour)
  )`);
  await dbRun(db, `CREATE TABLE battery_energy_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), last_power_ts INTEGER,
    day_charge_kwh REAL NOT NULL DEFAULT 0, day_discharge_kwh REAL NOT NULL DEFAULT 0,
    week_charge_offset REAL NOT NULL DEFAULT 0, week_discharge_offset REAL NOT NULL DEFAULT 0,
    month_charge_offset REAL NOT NULL DEFAULT 0, month_discharge_offset REAL NOT NULL DEFAULT 0,
    year_charge_offset REAL NOT NULL DEFAULT 0, year_discharge_offset REAL NOT NULL DEFAULT 0,
    previous_year_charge_total REAL NOT NULL DEFAULT 0, previous_year_discharge_total REAL NOT NULL DEFAULT 0,
    last_rollover_date TEXT NOT NULL DEFAULT '', week_key TEXT NOT NULL DEFAULT '',
    month_key TEXT NOT NULL DEFAULT '', year_key TEXT NOT NULL DEFAULT ''
  )`);
  await dbRun(db, `CREATE TABLE mess_schalt_function_hourly (
    function_key TEXT NOT NULL, day_key TEXT NOT NULL, hour INTEGER NOT NULL,
    consumption_kwh REAL NOT NULL DEFAULT 0, temperature REAL,
    PRIMARY KEY (function_key, day_key, hour))`);

  // Jüngster Lerntag: 02.07.2026 (Donnerstag) mit 24 kWh und flacher Kurve.
  await dbRun(db, "INSERT INTO prognosis_daily_consumption VALUES ('2026-07-02', 24, 24, NULL, 1, 0)");
  for (let hour = 0; hour < 24; hour += 1) {
    await dbRun(db, "INSERT INTO prognosis_hourly_consumption VALUES ('2026-07-02', ?, 1)", [hour]);
  }
  await dbRun(db, "INSERT INTO prognosis_daily_consumption VALUES ('2026-07-03', 8, 8, NULL, 0, 0)");

  // Lokale Zeit über die MQTT-Uhr fixieren: Freitag, 03.07.2026, 08:00.
  const cache = new Map([
    [ENVIRONMENT_STATE_IDS.clockDate, { value: '03.07.2026' }],
    [ENVIRONMENT_STATE_IDS.clockTime, { value: '08:00:00' }],
  ]);
  const strom = { breakdown: {
    today: { eigenverbrauch: 8 },
    year: { eigenverbrauch: null },
    previousYear: { eigenverbrauch: null },
  } };
  const config = { historyDays: 28, chargeEfficiency: 95, dischargeEfficiency: 95 };
  const model = await buildConsumptionModel(db, strom, config, cache, null, null);

  assert.equal(model.previousDayKey, '2026-07-02');
  assert.equal(model.previousDayKwh, 24);
  // Samstag (6) hat keine Lerntage: exakt Vortagesziel und flache Vortageskurve.
  assert.equal(model.dailyTargetsByWeekday[6], 24);
  for (let hour = 0; hour < 24; hour += 1) {
    assert.ok(Math.abs(model.profilesByWeekday[6][hour] - 1 / 24) < 1e-9);
  }
  // Auch der heutige Freitag (5, ungelernt) startet vom Vortagesziel; keine
  // explodierende Morgen-Hochrechnung mehr.
  assert.equal(model.dailyTargetsByWeekday[5], 24);
  assert.ok(model.expectedToday < 30);
  // Ist-Stunden des laufenden Tages stehen für die Seite bereit.
  assert.equal(model.todayByHour.filter((value) => value != null).length, 0);
  await new Promise((resolve) => db.close(resolve));
});
