'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-sun-intensity-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { ENVIRONMENT_STATE_IDS } = require('../src/mqtt/config');
const { createPvPlant } = require('../src/photovoltaik/plants');
const {
  computeInstantSunIntensity,
  recordSample,
  readSunIntensityAverages,
} = require('../src/photovoltaik/sun-intensity');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function freshDb() {
  fs.rmSync(process.env.HOME_ESS_DB, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

function solarCache(time) {
  return new Map([
    [ENVIRONMENT_STATE_IDS.clockDate, { value: '30.07.2026' }],
    [ENVIRONMENT_STATE_IDS.clockTime, { value: time }],
  ]);
}

async function configurePlant(db) {
  await dbRun(
    db,
    'UPDATE mqtt_config SET latitude = ?, longitude = ?, timezone = ?, dst_enabled = ? WHERE id = 1',
    [50, 10, 'UTC', 0]
  );
  return createPvPlant(db, {
    name: 'Südanlage',
    kwPeak: 5,
    efficiency: 90,
    orientation: '180',
    tilt: 30,
    cellType: 'Monokristallin',
    converterType: 'Direkt',
    powerTopic: 'pv/power',
  });
}

test('Clear-Sky-Sonnenintensität ist nachts 0 % statt unbekannt', async () => {
  const db = await freshDb();
  const plant = await configurePlant(db);
  const cache = solarCache('00:00:00');
  cache.set(`pv:${plant.id}:power`, { value: 0 });
  const now = new Date('2026-07-30T00:00:00Z');

  assert.equal(await computeInstantSunIntensity(db, cache), 0);
  assert.equal(await recordSample(db, cache, now), 0);
  assert.deepEqual(await readSunIntensityAverages(db, now), {
    last10min: 0,
    today: null,
    yesterday: null,
  });

  db.close();
});

test('Clear-Sky-Sonnenintensität ist nachts auch vor dem ersten Messwert 0 %', async () => {
  const db = await freshDb();
  await configurePlant(db);

  assert.equal(await computeInstantSunIntensity(db, solarCache('00:00:00')), 0);

  db.close();
});

test('Fehlender Leistungswert am Tag bleibt eine Datenlücke', async () => {
  const db = await freshDb();
  await configurePlant(db);

  assert.equal(await computeInstantSunIntensity(db, solarCache('12:00:00')), null);

  db.close();
});
