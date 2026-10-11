'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dynamicMinSoc = require('../src/batterie/dynamic-min-soc');
const { simulateDays, cloudBreakPotentialForHour } = require('../src/prognosis/forecast');

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

test('absolute Obergrenze von 95 % schützt DC-PV auch ohne Ladepotenzial', () => {
  for (const currentSoc of [96, 96.8, 99, 100]) {
    for (const chargePotentialKwh of [0, 0.01, 0.49, 0.5]) {
      const result = dynamicMinSoc.computeTargetMinSoc({
        chargePotentialKwh, capacityKwh: 10, currentSoc,
      });
      assert.equal(result.minSoc, 95);
    }
  }
});

test('unterhalb der absoluten Obergrenze gelten SoC-Abstand und Ladepotenzial weiter', () => {
  for (const [currentSoc, chargePotentialKwh, expected] of [
    [95, 0, 94], [95.9, 0, 94], [96, 0.6, 94], [100, 0.6, 94],
  ]) {
    const result = dynamicMinSoc.computeTargetMinSoc({
      chargePotentialKwh, capacityKwh: 10, currentSoc,
    });
    assert.equal(result.minSoc, expected);
  }
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
    dynamicMinSocSimulation: {
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
    dynamicMinSocSimulation: {
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

// 20 kWh PV, 4 kWh gleichzeitiger Hausverbrauch und 97 % Ladewirkungsgrad:
// 15,52 kWh können in den 28,672-kWh-Hausakku. Fahrzeugbedarf darf diesen
// Wert weder bei Pflichtladung noch bei Überschussladung verändern.
function wallboxScenario(wallboxKwhPerHour, currentHour = 18) {
  const keys = ['2026-09-25', '2026-09-26'];
  const forecast = {
    todayRemainingKwh: currentHour === 18 ? 0 : 7.5,
    days: keys.map((dateKey) => ({ dateKey, label: dateKey, totalKwh: 20 })),
    hours: keys.flatMap((dateKey) => Array.from({ length: 8 }, (_, index) => ({
      dateKey, hour: 10 + index, kwh: 2.5,
    }))),
  };
  const hourly = Array.from({ length: 24 }, (_, hour) => hour >= 10 && hour < 18 ? wallboxKwhPerHour : 0);
  const model = {
    local: { date: { year: 2026, month: 9, day: 25 }, time: { hours: currentHour, minutes: 0 } },
    profile: Array(24).fill(1 / 24), dailyTarget: 12,
    profilesByWeekday: {}, dailyTargetsByWeekday: {},
    remainingByHour: Array(24).fill(0.5), weekdayProfileDays: {},
    functionModels: null, poolModel: null,
    wallboxModel: {
      planned: true,
      boxes: [{
        id: 1, name: 'Auto', profilesByWeekday: {}, samplesByWeekday: {},
        plannedHourlyByDate: Object.fromEntries(keys.map((key) => [key, hourly])),
      }],
    },
  };
  return {
    forecast, model, config: {},
    batteryConfig: {
      capacityAh: 560, batteryType: 'lifepo4', cellCount: 16,
      chargeEfficiency: 97, dischargeEfficiency: 97, minSoc: 92,
    },
    batteryData: { soc: '100', minSoc: '92', power: '0' },
  };
}

test('20 kWh PV ergeben unabhängig von der Wallbox 15,52 kWh Ladepotenzial und 46 % Mindest-SoC', async () => {
  const db = await freshDb();
  try {
    for (const wallboxLoad of [0, 1.7, 6]) {
      const inputs = wallboxScenario(wallboxLoad);
      const simulation = simulateDays(inputs);
      const dynamicMinSocSimulation = simulateDays({ ...inputs, includeWallbox: false });
      const tomorrow = dynamicMinSocSimulation.days[1];
      assert.ok(Math.abs(tomorrow.chargePotentialKwh - 15.52) < 1e-9);
      assert.equal(tomorrow.wallboxKwh, 0);
      assert.ok(Math.abs(simulation.days[1].wallboxKwh - wallboxLoad * 8) < 1e-9);
      if (wallboxLoad === 1.7) {
        // Bisherige Vermischung reproduziert genau den zu hohen Zielwert.
        assert.equal(dynamicMinSoc.computeTargetMinSoc({
          chargePotentialKwh: simulation.days[1].chargePotentialKwh,
          capacityKwh: simulation.capacityKwh, currentSoc: 100,
        }).minSoc, 92);
      }
      const result = await dynamicMinSoc.evaluate(db, {
        prognosis: { battery: inputs.batteryData, simulation, dynamicMinSocSimulation },
        config: { dynamicMinSoc: true },
        local: { dateKey: '2026-09-25', hours: 18, minutes: 0 },
      });
      assert.equal(result.minSoc, 46);
    }
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Autoladung kann den Auslösezeitpunkt nicht vor das Ende der PV-Ladeaussicht ziehen', async () => {
  const db = await freshDb();
  try {
    const inputs = wallboxScenario(6, 15);
    const simulation = simulateDays(inputs);
    const dynamicMinSocSimulation = simulateDays({ ...inputs, includeWallbox: false });
    assert.equal(dynamicMinSoc.evaluatePeakPassed(simulation.days[0], 15).passed, true);
    const result = await dynamicMinSoc.evaluate(db, {
      prognosis: { battery: inputs.batteryData, simulation, dynamicMinSocSimulation },
      config: { dynamicMinSoc: true },
      local: { dateKey: '2026-09-25', hours: 15, minutes: 0 },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'ueberschuss-erwartet');
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
});

test('ohne separate Hausakku-Prognose wird keine Wallbox-belastete Ersatzberechnung verwendet', async () => {
  const db = await freshDb();
  try {
    const inputs = wallboxScenario(6);
    const result = await dynamicMinSoc.evaluate(db, {
      prognosis: { battery: inputs.batteryData, simulation: simulateDays(inputs) },
      config: { dynamicMinSoc: true },
      local: { dateKey: '2026-09-25', hours: 18, minutes: 0 },
    });
    assert.equal(result.reason, 'prognose-fehlt');
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
});


test('Wolkenlücken berücksichtigen kurze Leistungsspitzen trotz negativem Stundenmittel', () => {
  // 6 kW für 10 Minuten liefern 1 kWh. Die Grundlast läuft zeitgleich weiter.
  // Die Basisprognose von 0,2 kWh liegt unter 0,5 kWh Stundenlast und lädt nicht.
  const forecast = { hours: [{ dateKey: '2026-10-11', hour: 12, clearSkyKwh: 6, cloudCover: 100, cloudBreakFraction: 1 / 6, cloudBreakLearned: true }] };
  const result = cloudBreakPotentialForHour({
    forecast, dayKeyValue: '2026-10-11', hour: 12, pvKwh: 0.2, loadKwh: 0.5,
    chargeEfficiency: 0.95,
  });
  assert.ok(Math.abs(result.extraPvKwh - 5.8 / 6) < 1e-9);
  assert.ok(Math.abs(result.extraChargePotentialKwh - 5.5 / 6 * 0.95) < 1e-9);
});

test('klare Stunden, fehlende Daten und fehlender Sonnenstand bekommen keinen Mehrertrag', () => {
  for (const slot of [
    { clearSkyKwh: 6, cloudBreakFraction: 0, cloudBreakLearned: true },
    { clearSkyKwh: 0, cloudCover: 100 },
    { clearSkyKwh: 6 },
    { cloudCover: 100 },
    { clearSkyKwh: 0.2, cloudCover: 100 },
  ]) {
    const result = cloudBreakPotentialForHour({
      forecast: { hours: [{ dateKey: '2026-10-11', hour: 12, ...slot }] },
      dayKeyValue: '2026-10-11', hour: 12, pvKwh: 0.2, loadKwh: 0.5,
    });
    assert.deepEqual(result, { extraPvKwh: 0, extraChargePotentialKwh: 0 });
  }
  const result = cloudBreakPotentialForHour({
    forecast: { hours: [{ dateKey: '2026-10-11', hour: 12, clearSkyKwh: 6, cloudCover: 100, cloudBreakFraction: 1 / 6, cloudBreakLearned: true }] },
    dayKeyValue: '2026-10-11', hour: 12, pvKwh: 0.2, loadKwh: 7,
  });
  assert.equal(result.extraChargePotentialKwh, 0, 'Last oberhalb der Klarhimmel-Leistung lässt keine Ladung zu');
});

test('gelernte Variabilität und gleichzeitige Last bestimmen die zusätzliche Ladeenergie', () => {
  function scenario({ fraction = 1 / 6, learned = true, durationHours = 1 } = {}) {
    return cloudBreakPotentialForHour({
      forecast: { hours: [{ dateKey: '2026-10-11', hour: 12, clearSkyKwh: 6, cloudBreakFraction: fraction, cloudBreakLearned: learned }] },
      dayKeyValue: '2026-10-11', hour: 12,
      pvKwh: 2 * durationHours, loadKwh: 1 * durationHours, durationHours,
    });
  }
  assert.deepEqual(scenario({ learned: false }), { extraPvKwh: 0, extraChargePotentialKwh: 0 });
  const full = scenario();
  assert.ok(Math.abs(full.extraChargePotentialKwh - 4 / 6) < 1e-9, 'Basisladung wird nicht nochmals addiert');
  for (const result of [scenario({ fraction: 1 / 12 }), scenario({ durationHours: 0.5 })]) {
    assert.ok(Math.abs(result.extraChargePotentialKwh - full.extraChargePotentialKwh / 2) < 1e-9);
  }
});

test('zusätzliches Ladepotenzial verändert die Spanne zu 100 %, nicht den Abstand zum aktuellen SoC', () => {
  const base = { chargePotentialKwh: 0, capacityKwh: 10, currentSoc: 62 };
  assert.equal(dynamicMinSoc.computeTargetMinSoc(base).minSoc, 61);
  assert.equal(dynamicMinSoc.computeTargetMinSoc({ ...base, additionalChargePotentialKwh: 1 }).minSoc, 61);
  assert.equal(dynamicMinSoc.computeTargetMinSoc({ ...base, additionalChargePotentialKwh: 5 }).minSoc, 50);
  assert.equal(dynamicMinSoc.computeTargetMinSoc({ ...base, currentSoc: 100, additionalChargePotentialKwh: 1 }).minSoc, 90);
});

test('bewölkter Folgetag mit 2 kWh Prognose erhält getrenntes gelerntes Mehrertrags-Potenzial', async () => {
  const db = await freshDb();
  try {
    const inputs = wallboxScenario(0);
    inputs.batteryConfig.chargeEfficiency = 100;
    inputs.forecast.days[1].totalKwh = 2;
    for (const hour of inputs.forecast.hours) {
      if (hour.dateKey === '2026-09-26') {
        hour.kwh = 0.25;
        hour.clearSkyKwh = 6;
        hour.cloudCover = 100;
        hour.cloudBreakFraction = 1 / 6;
        hour.cloudBreakLearned = true;
      }
    }
    const simulation = simulateDays({ ...inputs, includeWallbox: false });
    const tomorrow = simulation.days[1];
    assert.equal(tomorrow.chargePotentialKwh, 0);
    assert.equal(tomorrow.pvKwh, 2);
    assert.ok(Math.abs(tomorrow.cloudBreakChargePotentialKwh - 8 * 5.5 / 6) < 1e-9);
    const result = await dynamicMinSoc.evaluate(db, {
      prognosis: { battery: inputs.batteryData, dynamicMinSocSimulation: simulation },
      config: { dynamicMinSoc: true }, local: { dateKey: '2026-09-25', hours: 18, minutes: 0 },
    });
    const expected = Math.ceil(100 - tomorrow.cloudBreakChargePotentialKwh / simulation.capacityKwh * 100);
    assert.equal(result.minSoc, expected);
    assert.ok(result.minSoc < 95);

    // Die Versorgungssimulation darf nicht optimistischer werden.
    const normal = simulateDays(inputs);
    assert.equal(normal.days[1].cloudBreakChargePotentialKwh, 0);
    for (const slot of inputs.forecast.hours) slot.cloudBreakLearned = false;
    const disabled = simulateDays({ ...inputs, includeWallbox: false });
    assert.equal(disabled.days[1].cloudBreakChargePotentialKwh, 0);
    assert.deepEqual(normal.days.map(d => d.gridKwh), disabled.days.map(d => d.gridKwh));
    assert.equal(normal.status, disabled.status);
    const withoutScenario = await dynamicMinSoc.evaluate(db, {
      prognosis: { battery: inputs.batteryData, dynamicMinSocSimulation: disabled },
      config: { dynamicMinSoc: true }, local: { dateKey: '2026-09-25', hours: 18, minutes: 0 },
    });
    assert.equal(withoutScenario.minSoc, 95);
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
});
