'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const learning = require('../src/photovoltaik/uncertainty');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
}
function get(db, sql) {
  return new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
}
async function database() {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec(learning.SCHEMA, err => err ? reject(err) : resolve()));
  return db;
}
function close(db) { return new Promise(resolve => db.close(resolve)); }

function observations(category, fraction, count = 20, dayCount = 5) {
  return Array.from({ length: count }, (_, index) => ({
    weather_class: category, date_key: `2026-10-${String(1 + index % dayCount).padStart(2, '0')}`,
    expected_kwh: 1, clear_sky_kwh: 6, measured_kwh: 1 + 5 * fraction,
    coverage_ms: 3600000, blocked: 0,
  }));
}

test('Wetterklassen trennen klare, wechselhafte und diffus bewölkte Prognosen', () => {
  assert.equal(learning.weatherClass({ cloudCover: 0, diffuseFraction: 0.1 }), 'clear');
  assert.equal(learning.weatherClass({ cloudCover: 50, diffuseFraction: 0.5 }), 'variable');
  assert.equal(learning.weatherClass({ cloudCover: 100, diffuseFraction: 0.95 }), 'overcast-diffuse');
  assert.equal(learning.weatherClass({ cloudCover: 90, diffuseFraction: 0.4 }), 'overcast-direct');
  assert.equal(learning.weatherClass({ cloudCover: 100, diffuseFraction: 0.95, cloudChange: 60 }), 'variable');
  assert.equal(learning.weatherClass({ cloudCover: null, diffuseFraction: 0.8 }), 'unknown');
});

test('Lernen passt den möglichen Mehrertrag je Wetterklasse an', () => {
  const model = learning.learnModel([
    ...observations('variable', 0.5), ...observations('overcast-diffuse', 0.2),
    ...observations('clear', 0.5),
  ]);
  assert.equal(model.get('variable').fraction, 0.25);
  assert.ok(Math.abs(model.get('overcast-diffuse').fraction - 0.1) < 1e-9);
  assert.equal(model.get('variable').days, 5);
  assert.equal(model.has('clear'), false);
  assert.ok(learning.learnModel(observations('variable', 0.5, 40)).get('variable').fraction > 0.25);
});

test('einzelne Tage, dünne Daten und Abregelung geben kein scheinbar gelerntes Potenzial', () => {
  assert.equal(learning.learnModel(observations('variable', 0.5, 20, 1)).get('variable').fraction, 0);
  assert.equal(learning.learnModel(observations('variable', 0.5, 8)).get('variable').fraction, 0);
  for (const bad of [{ blocked: 1 }, { coverage_ms: 20 * 60000 }, { coverage_ms: 7200000 }]) {
    assert.equal(learning.learnModel(observations('variable', 0.5).map(row => ({ ...row, ...bad }))).size, 0);
  }
  const model = learning.learnModel([
    ...observations('variable', 0, 50), ...observations('variable', 0.8, 4),
  ]);
  assert.equal(model.get('variable').fraction, 0, 'Null-/Untererträge dürfen nicht aus dem Lernen verschwinden');
});

test('Vortagsprognose bleibt nach Beginn des Prognosetags unverändert', async () => {
  const db = await database();
  try {
    const original = {
      signature: 'anlage', fetchedAt: Date.parse('2026-10-09T12:00:00Z'),
      hours: [{ dateKey: '2026-10-10', hour: 13, kwh: 1, clearSkyKwh: 6, weatherClass: 'variable' }],
    };
    await learning.saveForecasts(db, original, { dateKey: '2026-10-09', hours: 12 }, new Date(original.fetchedAt));
    let row = await get(db, 'SELECT * FROM pv_forecast_learning');
    assert.equal(row.hour, 12, 'Strahlungswert 13 Uhr gehört zum Messintervall 12–13 Uhr');
    const revised = { ...original, fetchedAt: Date.parse('2026-10-09T15:00:00Z'), hours: [{ ...original.hours[0], kwh: 1.2 }] };
    await learning.saveForecasts(db, revised, { dateKey: '2026-10-09', hours: 15 }, new Date(revised.fetchedAt));
    row = await get(db, 'SELECT * FROM pv_forecast_learning');
    assert.equal(row.expected_kwh, 1.2);
    await learning.saveForecasts(db, { ...revised, fetchedAt: Date.parse('2026-10-10T11:00:00Z'), hours: [{ ...original.hours[0], kwh: 5 }] },
      { dateKey: '2026-10-10', hours: 11 }, new Date('2026-10-10T11:00:00Z'));
    assert.equal((await get(db, 'SELECT * FROM pv_forecast_learning')).expected_kwh, 1.2);
  } finally { await close(db); }
});

test('alte Wetterdaten und kurzfristige Prognosen dienen nicht als Vortagsreferenz', async () => {
  const db = await database();
  try {
    const forecast = { signature: 'anlage', fetchedAt: Date.parse('2026-10-09T12:00:00Z'), hours: [
      { dateKey: '2026-10-10', hour: 2, kwh: 1, clearSkyKwh: 6, weatherClass: 'variable' },
    ] };
    await learning.saveForecasts(db, forecast, { dateKey: '2026-10-09', hours: 23 }, new Date('2026-10-09T23:00:00Z'));
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM pv_forecast_learning')).n, 0);
    forecast.fetchedAt = Date.parse('2026-10-09T23:00:00Z');
    await learning.saveForecasts(db, forecast, { dateKey: '2026-10-09', hours: 23 }, new Date(forecast.fetchedAt));
    assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM pv_forecast_learning')).n, 0);
  } finally { await close(db); }
});

test('Messung integriert vollständige Stunden und bleibt nach einem Neustart fortsetzbar', async () => {
  const db = await database();
  try {
    await run(db, `INSERT INTO pv_forecast_learning (signature, date_key, hour, issued_at, weather_class, expected_kwh, clear_sky_kwh)
      VALUES ('anlage', '2026-10-10', 12, 1, 'variable', 0.5, 6)`);
    const start = Date.parse('2026-10-10T12:00:00Z');
    for (let minute = 0; minute <= 60; minute++) {
      await learning.recordMeasurement(db, { signature: 'anlage', power: 1000, valid: true,
        local: { dateKey: '2026-10-10', hours: minute === 60 ? 13 : 12, minutes: minute % 60 },
        now: new Date(start + minute * 60000) });
    }
    const row = await get(db, 'SELECT * FROM pv_forecast_learning');
    assert.equal(row.coverage_ms, 3600000);
    assert.ok(Math.abs(row.measured_kwh - 1) < 1e-9);
    assert.equal(row.blocked, 0);
    await learning.recordMeasurement(db, { signature: 'anlage', power: 1000, valid: true,
      local: { dateKey: '2026-10-10', hours: 13 }, now: new Date(start + 3600000) });
    assert.equal((await get(db, 'SELECT * FROM pv_forecast_learning')).coverage_ms, 3600000, 'Doppelte Ticks zählen nicht');
  } finally { await close(db); }
});

test('Abregelung, lange Messlücken und Zeitsprünge werden nicht als Wetterabweichung gelernt', async () => {
  const db = await database();
  try {
    await run(db, `INSERT INTO pv_forecast_learning (signature, date_key, hour, issued_at, weather_class, expected_kwh, clear_sky_kwh)
      VALUES ('anlage', '2026-10-10', 12, 1, 'variable', 0.5, 6)`);
    const sample = (minutes, valid = true, wallMinutes = minutes) => learning.recordMeasurement(db, {
      signature: 'anlage', power: 1000, valid, local: { dateKey: '2026-10-10', hours: 12, minutes: wallMinutes },
      now: new Date(Date.parse('2026-10-10T12:00:00Z') + minutes * 60000),
    });
    await sample(0); await sample(10);
    assert.equal((await get(db, 'SELECT * FROM pv_forecast_learning')).coverage_ms, 0);
    await sample(11, false);
    assert.equal((await get(db, 'SELECT * FROM pv_forecast_learning')).blocked, 1);
    await run(db, 'UPDATE pv_forecast_learning SET blocked = 0');
    await sample(12, true, 40);
    assert.equal((await get(db, 'SELECT * FROM pv_forecast_learning')).blocked, 1);
  } finally { await close(db); }
});

test('nur frische, vollständige PV-Messungen ohne vollen Akku sind verwertbar', () => {
  const now = Date.now();
  const plants = [{ id: 1, kwPeak: 6, efficiency: 100, orientation: 180, tilt: 30 }];
  const cache = new Map([
    ['pv:1:power', { value: 6000, receivedAt: now }], ['batterie.soc', { value: 90, receivedAt: now }],
  ]);
  assert.equal(learning.measurement(cache, plants, now).valid, true);
  cache.get('batterie.soc').value = 95;
  assert.equal(learning.measurement(cache, plants, now).valid, false);
  cache.get('batterie.soc').value = 90;
  cache.get('pv:1:power').receivedAt = now - 600000;
  assert.equal(learning.measurement(cache, plants, now).valid, false);
  cache.delete('pv:1:power');
  assert.equal(learning.measurement(cache, plants, now).valid, false);
});

test('Anlagen- und Standortänderungen trennen unpassende Lerndaten', () => {
  const plant = { id: 1, kwPeak: 6, orientation: 180, tilt: 30 };
  const config = { latitude: 48, longitude: 11, timezone: 'Europe/Berlin' };
  assert.notEqual(learning.modelSignature([plant], config), learning.modelSignature([{ ...plant, tilt: 60 }], config));
  assert.notEqual(learning.modelSignature([plant], config), learning.modelSignature([plant], { ...config, latitude: 50 }));
});

test('gelernte Vortagsabweichung fließt automatisch in den Mindest-SoC, nicht in die Versorgungsprognose', async () => {
  const { buildForecast } = require('../src/photovoltaik/forecast');
  const { simulateDays } = require('../src/prognosis/forecast');
  const { computeTargetMinSoc } = require('../src/batterie/dynamic-min-soc');
  const db = await database();
  try {
    const plant = { id: 1, kwPeak: 6, efficiency: 100, orientation: 180, tilt: 30, cellType: 'Monokristallin' };
    const config = { latitude: 48, longitude: 11, timezone: 'Europe/Berlin' };
    const signature = learning.modelSignature([plant], config);
    for (const [index, row] of observations('variable', 0.5).entries()) {
      await run(db, `INSERT INTO pv_forecast_learning
        (signature, date_key, hour, issued_at, weather_class, expected_kwh, clear_sky_kwh, measured_kwh, coverage_ms)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [signature, row.date_key, Math.floor(index / 5), row.weather_class, row.expected_kwh,
        row.clear_sky_kwh, row.measured_kwh, row.coverage_ms]);
    }
    // Noch laufende/zukünftige Stunden dürfen nicht in das Modell gelangen.
    await run(db, `INSERT INTO pv_forecast_learning
      (signature, date_key, hour, issued_at, weather_class, expected_kwh, clear_sky_kwh, measured_kwh, coverage_ms)
      VALUES (?, '2026-10-11', 12, 1, 'variable', 1, 6, 6, 3600000)`, [signature]);
    const learned = await learning.loadModel(db, signature, { dateKey: '2026-10-10', hours: 18 });
    assert.equal(learned.get('variable').samples, 20);
    assert.equal(learned.get('variable').fraction, 0.25);

    const weather = { hours: [10, 11].map(day => ({
      year: 2026, month: 10, day, hour: 12, minute: 0, ghi: 100, dni: 100, dhi: 50, cloud: 50, temp: 20,
    })) };
    const nowLocal = { date: { year: 2026, month: 10, day: 10 }, time: { hours: 18, minutes: 0 } };
    const forecast = buildForecast(weather, [plant], config, null, nowLocal, learned);
    const input = {
      forecast, config: {},
      model: { local: nowLocal, profile: Array(24).fill(1 / 24), dailyTarget: 12,
        profilesByWeekday: {}, dailyTargetsByWeekday: {}, remainingByHour: Array(24).fill(0.5) },
      batteryConfig: { capacityAh: 200, batteryType: 'lifepo4', cellCount: 16,
        chargeEfficiency: 100, dischargeEfficiency: 100, minSoc: 20 },
      batteryData: { soc: 100, minSoc: 20 },
    };
    const normal = simulateDays(input);
    const charging = simulateDays({ ...input, includeWallbox: false });
    assert.ok(charging.days[1].cloudBreakChargePotentialKwh > 0);
    assert.equal(charging.days[1].cloudBreakLearned, true);
    assert.equal(normal.days[1].cloudBreakChargePotentialKwh, 0);
    assert.deepEqual(normal.days.map(day => day.gridKwh), charging.days.map(day => day.gridKwh));
    assert.equal(normal.status, charging.status);
    const base = { chargePotentialKwh: charging.days[1].chargePotentialKwh,
      capacityKwh: charging.capacityKwh, currentSoc: 100 };
    assert.ok(computeTargetMinSoc({ ...base, additionalChargePotentialKwh: charging.days[1].cloudBreakChargePotentialKwh }).minSoc <
      computeTargetMinSoc(base).minSoc);
    const unlearned = buildForecast(weather, [plant], config, null, nowLocal);
    const noExperience = simulateDays({ ...input, forecast: unlearned, includeWallbox: false });
    assert.equal(noExperience.days[1].cloudBreakChargePotentialKwh, 0);
    assert.equal(noExperience.days[1].cloudBreakLearned, false);
  } finally { await close(db); }
});
