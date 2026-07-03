'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const {
  buildWallboxModel, planWallboxSchedule, wallboxForecastForDay,
} = require('../src/prognosis/wallbox-model');
const { materializeConsumptionModel } = require('../src/prognosis/forecast');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
}

test('Wallbox-Prognose lernt Verbrauch und Ladezeit je Box und Wochentag getrennt', async () => {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE wallboxes (
    id INTEGER PRIMARY KEY, name TEXT, max_power_w REAL, battery_capacity_kwh REAL,
    command_topic TEXT, status_topic TEXT, power_topic TEXT, power_unit TEXT,
    counter_topic TEXT, counter_unit TEXT, setpoint_topic TEXT, plugged_topic TEXT,
    soc_topic TEXT, mode_sync_topic TEXT, mode INTEGER, priority_private INTEGER,
    priority_business INTEGER, priority_full INTEGER, min_charge_percent INTEGER,
    business_days TEXT, stall_timeout_seconds INTEGER, stall_power_w REAL,
    load_shed_phase TEXT NOT NULL DEFAULT 'three_phase')`);
  await run(db, `CREATE TABLE wallbox_daily_consumption (
    wallbox_id INTEGER, day_key TEXT, consumption_kwh REAL, completed INTEGER, updated_at INTEGER,
    PRIMARY KEY(wallbox_id, day_key))`);
  await run(db, `CREATE TABLE wallbox_hourly_consumption (
    wallbox_id INTEGER, day_key TEXT, hour INTEGER, consumption_kwh REAL,
    PRIMARY KEY(wallbox_id, day_key, hour))`);
  await run(db, `CREATE TABLE wallbox_summary_state (
    wallbox_id INTEGER PRIMARY KEY, year_offset REAL, previous_year_total REAL)`);
  await run(db, `CREATE TABLE wallbox_counter_state (
    wallbox_id INTEGER PRIMARY KEY, day_total REAL)`);
  const values = `(?, ?, 11000, 50, '', '', '', 'W', '', 'kWh', '', '', '', '', 1, 5, 3, 4, 30, '', 120, 200, 'three_phase')`;
  await run(db, `INSERT INTO wallboxes VALUES ${values}`, [1, 'Auto A']);
  await run(db, `INSERT INTO wallboxes VALUES ${values}`, [2, 'Auto B']);
  await run(db, `INSERT INTO wallbox_summary_state VALUES (1, 20, 0), (2, 8, 0)`);
  await run(db, `INSERT INTO wallbox_counter_state VALUES (1, 0), (2, 0)`);
  for (const [id, energy, hour] of [[1, 10, 22], [2, 4, 1]]) {
    await run(db, 'INSERT INTO wallbox_daily_consumption VALUES (?, ?, ?, 1, 1)', [id, '2026-06-23', energy]);
    await run(db, 'INSERT INTO wallbox_hourly_consumption VALUES (?, ?, ?, ?)', [id, '2026-06-23', hour, energy]);
  }

  const model = await buildWallboxModel(db, '2026-06-30', 28, 8, 0);
  assert.equal(model.boxes.length, 2);
  const forecast = wallboxForecastForDay(model, '2026-07-07', 1); // Dienstag
  assert.ok(forecast.perBox.find((box) => box.id === 1).energyKwh > forecast.perBox.find((box) => box.id === 2).energyKwh);
  assert.ok(forecast.hourly[22] > forecast.hourly[12]);
  assert.ok(forecast.hourly[1] > forecast.hourly[12]);
  await new Promise((resolve) => db.close(resolve));
});

test('Wallbox-Ladeplan nutzt nur tatsächlichen Bedarf und plant Pflichtladung fest ein', () => {
  const common = {
    dailyByWeekday: Array(7).fill(6),
    profilesByWeekday: Array.from({ length: 7 }, () => Array(24).fill(1 / 24)),
    samplesByWeekday: Array(7).fill(3),
    todayRemainingKwh: 6,
    maxPowerW: 11000,
    batteryCapacityKwh: 50,
    minChargePercent: 30,
    businessDays: [],
    soc: null,
  };
  const model = {
    boxes: [
      { ...common, id: 1, name: 'Flex A', mode: 1, priority: 3 },
      { ...common, id: 2, name: 'Flex B', mode: 1, priority: 5 },
      { ...common, id: 3, name: 'Immer voll', mode: 3, priority: 4, soc: 89 },
    ],
  };
  const slots = [8, 9].map((hour) => ({
    dateKey: '2026-06-30', dayIndex: 0, hour, durationHours: 1,
    startMs: Date.UTC(2026, 5, 30, hour), pvKwh: 4, houseKwh: 1,
  }));

  planWallboxSchedule(model, slots);
  const flexA = model.boxes.find((box) => box.id === 1);
  const flexB = model.boxes.find((box) => box.id === 2);
  const full = model.boxes.find((box) => box.id === 3);
  assert.equal(flexA.plannedEnergyByDate['2026-06-30'], 0);
  assert.equal(flexB.plannedEnergyByDate['2026-06-30'], 0);
  assert.equal(full.plannedEnergyByDate['2026-06-30'], 5);
  assert.equal(full.nextCharge.hour, 8);
  assert.equal(wallboxForecastForDay(model, '2026-06-30', 0).totalKwh, 5);
});

test('Privat-Ladeplan nutzt nur Überschuss, der nicht mehr in den Hausakku passt', () => {
  const common = {
    dailyByWeekday: Array(7).fill(0), profilesByWeekday: Array.from({ length: 7 }, () => Array(24).fill(1 / 24)),
    samplesByWeekday: Array(7).fill(3), todayRemainingKwh: 0,
    maxPowerW: 3000, batteryCapacityKwh: 50, minChargePercent: 40,
    businessDays: [], soc: 50, id: 1, name: 'Privat', mode: 1, priority: 5,
  };
  const slots = [10, 11].map((hour) => ({
    dateKey: '2026-06-30', dayIndex: 0, hour, durationHours: 1,
    startMs: Date.UTC(2026, 5, 30, hour), pvKwh: 4, houseKwh: 1,
  }));
  const model = { boxes: [{ ...common }] };

  planWallboxSchedule(model, slots, {
    capacityKwh: 10, minSoc: 20, soc: 20, chargeEfficiency: 1, dischargeEfficiency: 1,
  });
  assert.equal(model.boxes[0].plannedFlexibleEnergyByDate['2026-06-30'], 0);

  const fullBatteryModel = { boxes: [{ ...common }] };
  planWallboxSchedule(fullBatteryModel, slots.map((slot) => ({ ...slot })), {
    capacityKwh: 10, minSoc: 20, soc: 100, chargeEfficiency: 1, dischargeEfficiency: 1,
  });
  assert.equal(fullBatteryModel.boxes[0].plannedFlexibleEnergyByDate['2026-06-30'], 6);
});

test('historischer Wallbox-Verbrauch erzeugt ohne tatsächlichen Fahrzeugbedarf keine Prognoselast', () => {
  const profile = Array(24).fill(0);
  profile[8] = 1;
  const model = {
    boxes: [{
      id: 1, name: 'Auto', mode: 1, priority: 5, maxPowerW: 11000,
      batteryCapacityKwh: 50, minChargePercent: 30, businessDays: [],
      soc: null, plugged: null, todayRemainingKwh: 12,
      dailyByWeekday: Array(7).fill(12),
      profilesByWeekday: Array.from({ length: 7 }, () => profile),
      samplesByWeekday: Array(7).fill(4),
    }],
  };
  const slots = [8, 9].map((hour) => ({
    dateKey: '2026-07-03', dayIndex: 0, hour, durationHours: 1,
    startMs: Date.UTC(2026, 6, 3, hour), pvKwh: 20, houseKwh: 1,
  }));

  planWallboxSchedule(model, slots);
  assert.equal(wallboxForecastForDay(model, '2026-07-03', 0).totalKwh, 0);
});

test('Privat-Restbedarf wird über den Tageswechsel in morgigen Überschuss getragen', () => {
  const box = {
    id: 1, name: 'Privat', mode: 1, priority: 5, maxPowerW: 3000,
    batteryCapacityKwh: 28, minChargePercent: 30, businessDays: [], soc: 50, plugged: true,
    dailyByWeekday: Array(7).fill(0),
    profilesByWeekday: Array.from({ length: 7 }, () => Array(24).fill(1 / 24)),
    samplesByWeekday: Array(7).fill(0), todayRemainingKwh: 0,
  };
  const slots = [
    { dateKey: '2026-07-02', dayIndex: 0, hour: 16, durationHours: 1, startMs: 1, pvKwh: 1, houseKwh: 1 },
    { dateKey: '2026-07-03', dayIndex: 1, hour: 11, durationHours: 1, startMs: 2, pvKwh: 8, houseKwh: 1 },
    { dateKey: '2026-07-03', dayIndex: 1, hour: 12, durationHours: 1, startMs: 3, pvKwh: 8, houseKwh: 1 },
  ];
  const model = { boxes: [box] };
  planWallboxSchedule(model, slots, {
    capacityKwh: 10, minSoc: 20, soc: 100, chargeEfficiency: 1, dischargeEfficiency: 1,
  });
  assert.equal(model.boxes[0].plannedEnergyByDate['2026-07-02'], 0);
  assert.equal(model.boxes[0].plannedEnergyByDate['2026-07-03'], 6);
  assert.equal(model.boxes[0].nextCharge.dateKey, '2026-07-03');
});

test('gecachtes Basismodell bleibt zwischen unterschiedlichen Akku-Kontexten unverändert', () => {
  const box = {
    id: 1, name: 'Privat', mode: 1, priority: 5, maxPowerW: 3000,
    batteryCapacityKwh: 50, minChargePercent: 40, businessDays: [], soc: 50,
    dailyByWeekday: Array(7).fill(0),
    profilesByWeekday: Array.from({ length: 7 }, () => Array(24).fill(1 / 24)),
    samplesByWeekday: Array(7).fill(0), todayRemainingKwh: 6,
  };
  const base = {
    wallboxModel: { boxes: [box] },
    _wallboxPlanningSlots: [8, 9].map((hour) => ({
      dateKey: '2026-06-30', dayIndex: 0, hour, durationHours: 1,
      startMs: Date.UTC(2026, 5, 30, hour), pvKwh: 4, houseKwh: 1,
    })),
    hoursToSunrise: null,
  };
  const emptyHouseBattery = materializeConsumptionModel(base, {
    capacityKwh: 10, minSoc: 20, soc: 20, chargeEfficiency: 1, dischargeEfficiency: 1,
  }, null);
  const fullHouseBattery = materializeConsumptionModel(base, {
    capacityKwh: 10, minSoc: 20, soc: 100, chargeEfficiency: 1, dischargeEfficiency: 1,
  }, null);
  assert.equal(emptyHouseBattery.wallboxModel.boxes[0].plannedFlexibleEnergyByDate['2026-06-30'], 0);
  assert.equal(fullHouseBattery.wallboxModel.boxes[0].plannedFlexibleEnergyByDate['2026-06-30'], 6);
  assert.equal(base.wallboxModel.planned, undefined);
  assert.equal(base._wallboxPlanningSlots[0].surplusRemainingKwh, undefined);
});
