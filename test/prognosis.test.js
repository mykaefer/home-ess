'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const {
  normalizedProfile, adjustedConsumptionDelta, recordConsumptionSample, simulateDays,
  buildCoolingModel, hoursUntilNextSunrise, projectedConsumptionForHours,
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

test('signifikanter Mehrverbrauch heißer Tage bildet ein separates Kühlmodell', () => {
  const model = buildCoolingModel([
    { day_key: '2026-06-01', consumption_kwh: 10, max_temperature: 20 },
    { day_key: '2026-06-08', consumption_kwh: 10, max_temperature: 21 },
    { day_key: '2026-06-15', consumption_kwh: 16, max_temperature: 30 },
    { day_key: '2026-06-22', consumption_kwh: 18, max_temperature: 32 },
  ]);
  assert.equal(model.enabled, true);
  assert.equal(model.sampleCount, 2);
  assert.equal(model.kwhPerDegree, 1);
  assert.equal(model.climateDayKeys.has('2026-06-15'), true);
});

test('Kühlbedarf wird nach prognostizierter Temperatur separat aufgeschlagen', () => {
  const input = baseInput();
  input.model.remainingByHour = Array(24).fill(0);
  input.model.remainingToday = 0;
  input.model.coolingModel = {
    enabled: true, sampleCount: 2, kwhPerDegree: 1,
    baseTemperature: 24, hotDayTemperature: 26,
  };
  input.forecast.days.push({ dateKey: '2026-06-30', label: 'Morgen', totalKwh: 0 });
  input.forecast.hours = [{ dateKey: '2026-06-30', hour: 14, kwh: 0, temperature: 30 }];
  const result = simulateDays(input);
  assert.equal(result.days[1].coolingKwh, 6);
  assert.equal(result.days[1].loadKwh, 8);
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
    coolingModel: { enabled: false },
  };
  assert.equal(projectedConsumptionForHours(model, null, 2.5), 2.5);
});
