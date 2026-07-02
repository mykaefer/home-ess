'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { evaluateBehaviorLevel, getBehaviorRecommendation, applyBehaviorLevel } = require('../src/prognosis/behavior');
const operatingState = require('../src/operating-state');
const modulesState = require('../src/modules');

function prognosis(model, { soc = 90, endSoc = 90, surplus = 0, batteryFull = false, minimum = null, futureEnd = 80 } = {}) {
  const pvToday = surplus > 0 ? 10 : 8;
  return {
    config: { behaviorModel: model, behaviorActive: true },
    battery: { soc },
    simulation: {
      minSoc: 20, soc, minimumReached: minimum, minimumBeforeCharge: !!minimum,
      assessmentSoc: endSoc, gridBeforeCharge: 0,
      days: [
        { batterySocEnd: endSoc, surplusKwh: surplus, batteryFull, gridKwh: 0, pvKwh: pvToday, loadKwh: 8 },
        { batterySocEnd: futureEnd, surplusKwh: 0, batteryFull: false, gridKwh: 0, pvKwh: 6, loadKwh: 7 },
      ],
      today: { batterySocEnd: endSoc, surplusKwh: surplus, batteryFull },
    },
  };
}

test('Netzparallelbetrieb gibt Level 5 nur bei abgesichertem Überschuss', () => {
  assert.equal(evaluateBehaviorLevel(prognosis('grid_parallel', { surplus: 2, batteryFull: true })).level, 5);
  assert.equal(evaluateBehaviorLevel(prognosis('grid_parallel', { surplus: 0, batteryFull: false })).level, 4);
});

test('Netzparallelbetrieb verwendet die konfigurierte Voll-Schwelle', () => {
  const data = prognosis('grid_parallel', { soc: 94, endSoc: 94, surplus: 2 });
  assert.notEqual(evaluateBehaviorLevel(data, { fullSocThreshold: 95 }).level, 5);
  data.battery.soc = 95;
  assert.equal(evaluateBehaviorLevel(data, { fullSocThreshold: 95 }).level, 5);
});

test('Netzparallelbetrieb liest die Voll-Schwelle aus aktivem Grid-Control', async () => {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE grid_control_config (id INTEGER PRIMARY KEY, soc_upper_offset INTEGER);
    INSERT INTO grid_control_config VALUES (1, 5);
  `, (err) => err ? reject(err) : resolve()));
  const data = prognosis('grid_parallel', { soc: 92, endSoc: 92, surplus: 2 });

  await modulesState.setEnabled(db, 'grid-control', false);
  assert.equal((await getBehaviorRecommendation(db, data)).level, 5);

  await modulesState.setEnabled(db, 'grid-control', true);
  assert.notEqual((await getBehaviorRecommendation(db, data)).level, 5);

  await modulesState.setEnabled(db, 'grid-control', false);
  await new Promise((resolve) => db.close(resolve));
});

test('Netzparallelbetrieb bildet die rote Ampel als Level 2 ab', () => {
  const data = prognosis('grid_parallel', { soc: 30, endSoc: 24, futureEnd: 22 });
  data.simulation.status = 0;
  assert.equal(evaluateBehaviorLevel(data).level, 2);
});

test('Netzparallelbetrieb bildet die gelbe Ampel als Level 3 ab', () => {
  const data = prognosis('grid_parallel', { soc: 40, endSoc: 27, futureEnd: 25 });
  data.simulation.assessmentSoc = 27;
  data.simulation.gridBeforeCharge = 0;
  data.simulation.minimumBeforeCharge = false;
  data.simulation.status = 1;
  assert.equal(evaluateBehaviorLevel(data).level, 3);
});

test('Netzparallelbetrieb ignoriert Risiken nach dem nächsten Ladebeginn', () => {
  const data = prognosis('grid_parallel', { soc: 60, endSoc: 45, futureEnd: 20 });
  data.simulation.assessmentSoc = 45;
  assert.equal(evaluateBehaviorLevel(data).level, 4);
});

test('Netzparallelbetrieb bildet Netzbedarf vor dem Ladebeginn als rote Ampel und Level 2 ab', () => {
  const data = prognosis('grid_parallel', { soc: 55, endSoc: 45 });
  data.simulation.gridBeforeCharge = 0.2;
  assert.equal(evaluateBehaviorLevel(data).level, 2);
});

test('Netzparallelbetrieb gibt Level 4 bei sicherer Deckung auch unter 80 Prozent SoC', () => {
  const data = prognosis('grid_parallel', { soc: 55, endSoc: 45, futureEnd: 30 });
  data.simulation.assessmentSoc = 45;
  data.simulation.gridBeforeCharge = 0;
  assert.equal(evaluateBehaviorLevel(data).level, 4);
});

test('Netzparallelbetrieb setzt Level 1 erst unterhalb Mindest-SoC', () => {
  assert.notEqual(evaluateBehaviorLevel(prognosis('grid_parallel', { soc: 20, endSoc: 20 })).level, 1);
  assert.equal(evaluateBehaviorLevel(prognosis('grid_parallel', { soc: 19, endSoc: 19 })).level, 1);
});

test('Autarkbetrieb reagiert auf mehrtägige Risiken früher', () => {
  const recommendation = evaluateBehaviorLevel(prognosis('off_grid', { soc: 80, endSoc: 65, futureEnd: 50 }));
  assert.equal(recommendation.level, 3);
});

test('Autarkbetrieb gibt Level 5 erst oberhalb 98 Prozent und bei Überschuss', () => {
  assert.notEqual(evaluateBehaviorLevel(prognosis('off_grid', { soc: 98, surplus: 2 })).level, 5);
  assert.equal(evaluateBehaviorLevel(prognosis('off_grid', { soc: 99, surplus: 2 })).level, 5);
  assert.notEqual(evaluateBehaviorLevel(prognosis('off_grid', { soc: 99, surplus: 0 })).level, 5);
});

test('Autarkbetrieb kann bei absehbarem Mindeststand vorausschauend Level 1 setzen', () => {
  const minimum = { dayOffset: 1, hour: 5, soc: 20 };
  assert.equal(evaluateBehaviorLevel(prognosis('off_grid', { minimum })).level, 1);
});

test('Prognose verwaltet Level 1 auch ohne aktives Verhaltensmodell', async () => {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 1, 1);
  `, (err) => err ? reject(err) : resolve()));
  await operatingState.init(db);

  const recovered = prognosis('grid_parallel', { soc: 90, endSoc: 90, futureEnd: 80 });
  recovered.simulation.available = true;
  await applyBehaviorLevel(db, recovered);
  assert.equal(operatingState.getState().operatingLevel, 4);

  await operatingState.setOperatingLevel(db, 1);
  const empty = prognosis('grid_parallel', { soc: 19, endSoc: 19, futureEnd: 19 });
  empty.config.behaviorActive = false;
  empty.simulation.available = true;
  await applyBehaviorLevel(db, empty);
  assert.equal(operatingState.getState().operatingLevel, 1);

  await new Promise((resolve) => db.close(resolve));
});
