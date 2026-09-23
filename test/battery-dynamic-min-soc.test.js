'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dynamicMinSoc = require('../src/batterie/dynamic-min-soc');
const { simulateDays } = require('../src/prognosis/forecast');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE battery_dynamic_min_soc_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    day_key TEXT NOT NULL DEFAULT '',
    applied_min_soc INTEGER,
    applied_at TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  )`);
  return db;
}

// Ein Tagesprofil aus PV- und Lastwerten je Stunde; `from` blendet bereits
// vergangene Stunden als null aus, genau wie die Simulation es für heute tut.
function day({ pv, load, from = 0, pvPeakHour = null }) {
  const hourlyPvKwh = Array(24).fill(null);
  const hourlyLoadKwh = Array(24).fill(null);
  for (let hour = from; hour < 24; hour += 1) {
    hourlyPvKwh[hour] = pv[hour] || 0;
    hourlyLoadKwh[hour] = load[hour] == null ? 0.5 : load[hour];
  }
  return { hourlyPvKwh, hourlyLoadKwh, pvPeakHour };
}

const FLAT_LOAD = Array(24).fill(0.5);

test('Auslösung erst nach dem PV-Höhepunkt, auch wenn morgens noch kein Überschuss läuft', () => {
  const pv = Array(24).fill(0);
  pv[10] = 2; pv[11] = 3; pv[12] = 4; pv[13] = 3;
  const today = day({ pv, load: FLAT_LOAD, pvPeakHour: 12 });
  // 5:00 Uhr: kein Überschuss in den frühen Stunden, aber der Mittag kommt noch.
  assert.equal(dynamicMinSoc.evaluatePeakPassed(today, 5).passed, false);
  // 13:30 Uhr: Höhepunkt vorbei, aber Stunde 13 trägt noch Überschuss.
  assert.equal(dynamicMinSoc.evaluatePeakPassed(today, 13.5).passed, false);
});

test('Auslösung sobald keine verbleibende Stunde mehr Überschuss trägt', () => {
  const pv = Array(24).fill(0);
  pv[10] = 2; pv[11] = 3; pv[12] = 4; pv[13] = 3;
  // 14:00 Uhr: die Überschussstunden liegen hinter uns und sind ausgeblendet.
  const today = day({ pv, load: FLAT_LOAD, from: 14, pvPeakHour: 12 });
  const result = dynamicMinSoc.evaluatePeakPassed(today, 14);
  assert.equal(result.passed, true);
});

test('kurze Schwankung ohne echten Überschuss verhindert die Auslösung nicht', () => {
  const pv = Array(24).fill(0);
  pv[12] = 4;
  // Restlicher Nachmittag liefert noch etwas PV, bleibt aber unter der Last.
  pv[15] = 0.4; pv[16] = 0.52; pv[17] = 0.2;
  const today = day({ pv, load: FLAT_LOAD, from: 15, pvPeakHour: 12 });
  assert.equal(dynamicMinSoc.evaluatePeakPassed(today, 15).passed, true);
});

test('erneut einsetzende Ladung am späten Nachmittag verschiebt die Auslösung', () => {
  const pv = Array(24).fill(0);
  pv[12] = 4; pv[16] = 1.5;
  const today = day({ pv, load: FLAT_LOAD, from: 14, pvPeakHour: 12 });
  const result = dynamicMinSoc.evaluatePeakPassed(today, 14);
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'ueberschuss-erwartet');
  assert.equal(result.surplusHour, 16);
});

test('Zielwert füllt genau die Lücke zu 100 % und bleibt bei ganzen Prozent', () => {
  // 10 kWh Akku, morgen lassen sich 5,7 kWh nachladen -> 57 % -> Ziel 43 %.
  // Das 5-%-Raster des Schiebereglers gilt hier ausdrücklich nicht.
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 5.7, capacityKwh: 10, currentSoc: 95,
  });
  assert.equal(result.minSoc, 43);
});

test('angebrochene Prozent werden aufgerundet, damit die 100 % nicht verfehlt werden', () => {
  // 5,75 kWh von 10 kWh -> 57,5 % -> Lücke 42,5 % -> 43 %.
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 5.75, capacityKwh: 10, currentSoc: 95,
  });
  assert.equal(result.minSoc, 43);
});

test('Zielwert unterschreitet 10 % nicht', () => {
  // Sonniger Folgetag: mehr Ladepotenzial als Kapazität -> rechnerisch 0 %.
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 14, capacityKwh: 10, currentSoc: 90,
  });
  assert.equal(result.minSoc, dynamicMinSoc.FLOOR_SOC);
});

test('Zielwert überschreitet den aktuellen SoC minus 1 % nicht', () => {
  // Kein Ladepotenzial -> rechnerisch 100 %, gedeckelt auf 62 - 1 = 61.
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 0, capacityKwh: 10, currentSoc: 62,
  });
  assert.equal(result.minSoc, 61);
  assert.ok(result.minSoc <= 62 - dynamicMinSoc.SOC_HEADROOM);
});

test('gebrochener SoC wird für die Obergrenze abgerundet', () => {
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 0, capacityKwh: 10, currentSoc: 62.8,
  });
  assert.equal(result.minSoc, 61);
});

test('ohne gültigen Bereich zwischen 10 % und SoC minus 1 % wird kein Wert gesetzt', () => {
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 0, capacityKwh: 10, currentSoc: 8,
  });
  assert.equal(result.minSoc, null);
});

test('ohne konfigurierte Kapazität wird kein Wert gesetzt', () => {
  const result = dynamicMinSoc.computeTargetMinSoc({
    chargePotentialKwh: 5, capacityKwh: 0, currentSoc: 90,
  });
  assert.equal(result.minSoc, null);
});

test('deaktivierte Option führt zu keiner Auswertung', async () => {
  const db = await freshDb();
  const result = await dynamicMinSoc.evaluate(db, {
    prognosis: {}, config: { dynamicMinSoc: false }, local: { dateKey: '2026-09-21', hours: 18, minutes: 0 },
  });
  assert.equal(result.skipped, true);
  db.close();
});

test('am selben Tag wird nicht nachkorrigiert', async () => {
  const db = await freshDb();
  await dynamicMinSoc.writeDailyState(db, '2026-09-21', 45, 'gesetzt');
  const pv = Array(24).fill(0);
  pv[12] = 4;
  const prognosis = {
    battery: { soc: '90', power: '-500' },
    simulation: {
      available: true, capacityKwh: 10,
      days: [day({ pv, load: FLAT_LOAD, from: 18, pvPeakHour: 12 }), { chargePotentialKwh: 5, dateKey: '2026-09-22' }],
    },
  };
  const result = await dynamicMinSoc.evaluate(db, {
    prognosis, config: { dynamicMinSoc: true }, local: { dateKey: '2026-09-21', hours: 18, minutes: 0 },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.alreadyDone, true);

  // Der Folgetag ist wieder offen.
  const next = await dynamicMinSoc.evaluate(db, {
    prognosis, config: { dynamicMinSoc: true }, local: { dateKey: '2026-09-22', hours: 18, minutes: 0 },
  });
  assert.equal(next.skipped, false);
  assert.equal(next.minSoc, 50);
  db.close();
});

test('ladender Akku verzögert die Anpassung trotz erfüllter Prognosebedingung', async () => {
  const db = await freshDb();
  const pv = Array(24).fill(0);
  pv[12] = 4;
  const prognosis = {
    battery: { soc: '99', power: '800' },
    simulation: {
      available: true, capacityKwh: 10,
      days: [day({ pv, load: FLAT_LOAD, from: 18, pvPeakHour: 12 }), { chargePotentialKwh: 5, dateKey: '2026-09-22' }],
    },
  };
  const result = await dynamicMinSoc.evaluate(db, {
    prognosis, config: { dynamicMinSoc: true }, local: { dateKey: '2026-09-21', hours: 18, minutes: 0 },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'akku-laedt');
  db.close();
});

test('simulateDays liefert Ladepotenzial, PV-Stundenprofil und PV-Höhepunkt', () => {
  const forecast = {
    todayRemainingKwh: 10,
    days: [{ dateKey: '2026-09-21', label: 'Heute', totalKwh: 10 }],
    hours: [
      { dateKey: '2026-09-21', hour: 10, kwh: 2 },
      { dateKey: '2026-09-21', hour: 12, kwh: 6 },
      { dateKey: '2026-09-21', hour: 14, kwh: 2 },
    ],
  };
  const model = {
    local: { date: { year: 2026, month: 9, day: 21 }, time: { hours: 0, minutes: 0 } },
    profile: Array(24).fill(1 / 24),
    dailyTarget: 4.8,
    profilesByWeekday: {},
    dailyTargetsByWeekday: {},
    remainingByHour: Array(24).fill(0.2),
    weekdayProfileDays: {},
    functionModels: null,
    poolModel: null,
    wallboxModel: null,
  };
  const simulation = simulateDays({
    forecast, model,
    config: { chargeEfficiency: 100, dischargeEfficiency: 100 },
    batteryConfig: { capacityAh: 200, batteryType: 'lifepo4', cellCount: 16, chargeEfficiency: 100, dischargeEfficiency: 100, minSoc: 20 },
    batteryData: { soc: '50', minSoc: '20' },
  });
  const today = simulation.days[0];
  assert.equal(today.pvPeakHour, 12);
  assert.equal(today.hourlyPvKwh.filter((value) => value != null).length, 24);
  // Überschuss: (2-0.2) + (6-0.2) + (2-0.2) = 9,4 kWh bei 100 % Ladewirkungsgrad.
  assert.ok(Math.abs(today.chargePotentialKwh - 9.4) < 0.001, `chargePotentialKwh=${today.chargePotentialKwh}`);
  // Das Potenzial ist ungedeckelt und damit größer als der freie Platz im Akku.
  assert.ok(today.chargePotentialKwh > simulation.usableCapacity - simulation.initialStored);
});
