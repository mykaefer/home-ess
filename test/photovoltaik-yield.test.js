'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-pv-yield-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { createPvPlant, updatePvPlant, listPvPlants } = require('../src/photovoltaik/plants');
const {
  counterToKwh,
  advancePlantYield,
  plantTodayKwh,
  buildPhotovoltaikSnapshot,
} = require('../src/photovoltaik/aggregation');

function freshDb() {
  const dbPath = process.env.HOME_ESS_DB;
  fs.rmSync(dbPath, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

const PLANT = {
  name: 'AC-PV', kwPeak: 5, efficiency: 90, orientation: '180', tilt: 30,
  cellType: 'Monokristallin', converterType: 'Mikrowechselrichter',
};

// Cache-Attrappe wie der MQTT-Cache: get(key) → { value }.
function makeCache(entries = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(entries)) map.set(key, { value });
  map.setValue = (key, value) => map.set(key, { value });
  return map;
}

async function todayFor(db, cache) {
  const plants = await listPvPlants(db);
  const snap = await buildPhotovoltaikSnapshot(db, cache, plants);
  return snap.plants[0].metrics.raw.today;
}

test('counterToKwh rechnet Wh in kWh um, kWh bleibt unverändert', () => {
  assert.equal(counterToKwh(1000, 'kWh'), 1000);
  assert.equal(counterToKwh(1000, 'Wh'), 1);
  assert.equal(counterToKwh(null, 'Wh'), null);
});

test('advancePlantYield: Erststart nimmt den Rohwert NICHT als Ertrag (kein Sprung)', () => {
  const s = advancePlantYield(null, 1000, '2026-07-13');
  assert.equal(s.counterTotalKwh, 0);
  assert.equal(s.lastCounterRaw, 1000);
  assert.equal(plantTodayKwh(s, '2026-07-13'), 0);
});

test('advancePlantYield: nur Vorwärts-Deltas werden gezählt', () => {
  let s = advancePlantYield(null, 1000, '2026-07-13');
  s = advancePlantYield(s, 1005, '2026-07-13');
  assert.equal(plantTodayKwh(s, '2026-07-13'), 5);
  s = advancePlantYield(s, 1007.5, '2026-07-13');
  assert.equal(plantTodayKwh(s, '2026-07-13'), 7.5);
});

test('advancePlantYield: Rückwärtssprung (Zähler-Reset) basiert nur neu, ohne negativen Ertrag', () => {
  let s = advancePlantYield(null, 1000, '2026-07-13');
  s = advancePlantYield(s, 1010, '2026-07-13');
  assert.equal(plantTodayKwh(s, '2026-07-13'), 10);
  s = advancePlantYield(s, 3, '2026-07-13'); // Gerät zurückgesetzt
  assert.equal(plantTodayKwh(s, '2026-07-13'), 10, 'kein Rückgang durch den Reset');
  s = advancePlantYield(s, 5, '2026-07-13'); // wächst ab neuer Baseline
  assert.equal(plantTodayKwh(s, '2026-07-13'), 12);
});

test('advancePlantYield: Tageswechsel setzt die Tagesbasis, „heute" beginnt neu', () => {
  let s = advancePlantYield(null, 1000, '2026-07-13');
  s = advancePlantYield(s, 1008, '2026-07-13');
  assert.equal(plantTodayKwh(s, '2026-07-13'), 8);
  // Neuer Tag: Tagesbasis wird auf den aktuellen Zählerstand gezogen.
  s = advancePlantYield(s, 1008, '2026-07-14');
  assert.equal(plantTodayKwh(s, '2026-07-14'), 0);
  s = advancePlantYield(s, 1011, '2026-07-14');
  assert.equal(plantTodayKwh(s, '2026-07-14'), 3);
});

test('plantTodayKwh: veraltete Tagesbasis (Job seit Mitternacht nicht gelaufen) ⇒ 0', () => {
  const s = advancePlantYield(advancePlantYield(null, 1000, '2026-07-13'), 1005, '2026-07-13');
  assert.equal(plantTodayKwh(s, '2026-07-14'), 0);
});

test('Integration: Rohzähler-Topic wird als Zähler behandelt, nicht als Tagesertrag', async () => {
  const db = await freshDb();
  const plant = await createPvPlant(db, { ...PLANT, todayYieldTopic: 'pv.total', todayYieldUnit: 'kWh' });
  const cache = makeCache();

  // Erster Tick: Zähler steht bei 1000 kWh (Lebensdauer). Ertrag heute = 0, NICHT 1000.
  cache.setValue(`pv:${plant.id}:today`, 1000);
  assert.equal(await todayFor(db, cache), 0);

  // Zähler wächst → nur die Zuwächse zählen als Tagesertrag.
  cache.setValue(`pv:${plant.id}:today`, 1005);
  assert.equal(await todayFor(db, cache), 5);
  cache.setValue(`pv:${plant.id}:today`, 1006.25);
  assert.equal(await todayFor(db, cache), 6.25);
  db.close();
});

test('Integration: Wh-Einheit wird in kWh umgerechnet', async () => {
  const db = await freshDb();
  const plant = await createPvPlant(db, { ...PLANT, todayYieldTopic: 'pv.total.wh', todayYieldUnit: 'Wh' });
  const cache = makeCache();
  cache.setValue(`pv:${plant.id}:today`, 1000000); // 1000 kWh
  assert.equal(await todayFor(db, cache), 0);
  cache.setValue(`pv:${plant.id}:today`, 1005000); // +5000 Wh = 5 kWh
  assert.equal(await todayFor(db, cache), 5);
  db.close();
});

test('Integration: Topic-Wechsel setzt die Baseline neu, ohne Sprung im Tagesertrag', async () => {
  const db = await freshDb();
  const plant = await createPvPlant(db, { ...PLANT, todayYieldTopic: 'pv.total', todayYieldUnit: 'kWh' });
  const cache = makeCache();
  cache.setValue(`pv:${plant.id}:today`, 1000);
  await todayFor(db, cache);
  cache.setValue(`pv:${plant.id}:today`, 1007);
  assert.equal(await todayFor(db, cache), 7);

  // Nutzer wählt ein anderes Topic mit ganz anderem Zählerstand.
  await updatePvPlant(db, plant.id, { ...PLANT, todayYieldTopic: 'pv.other', todayYieldUnit: 'kWh' });
  cache.setValue(`pv:${plant.id}:today`, 50000); // neuer Rohzähler, riesig
  assert.equal(await todayFor(db, cache), 7, 'kein Sprung – der neue Rohwert wird nur Baseline');
  cache.setValue(`pv:${plant.id}:today`, 50003); // wächst um 3
  assert.equal(await todayFor(db, cache), 10);
  db.close();
});
