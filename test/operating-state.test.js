'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const operatingState = require('../src/operating-state');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

test('nur ein vollständig autark beendeter Tag wird gezählt', async () => {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE operating_state (
    id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER,
    autark INTEGER, autark_day_key TEXT, autark_days_count INTEGER,
    autark_days_year TEXT, autark_counted_day_key TEXT, autark_days_topic TEXT
  )`);
  await run(db, `INSERT INTO operating_state VALUES (1, 2, 0, 1, '2026-06-28', 0, '2026', '', '')`);
  await operatingState.init(db);

  await operatingState.updateAutarkForDay(db, '2026-06-29', false);
  assert.equal(operatingState.getState().autarkDaysCount, 1);

  await operatingState.updateAutarkForDay(db, '2026-06-29', true);
  assert.equal(operatingState.getState().autark, false);
  await operatingState.updateAutarkForDay(db, '2026-06-30', false);
  assert.equal(operatingState.getState().autarkDaysCount, 1);

  await new Promise((resolve) => db.close(resolve));
});

test('Jahreswechsel übernimmt den vollständigen Zähler ins Vorjahr', async () => {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE operating_state (
    id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER,
    autark INTEGER, autark_day_key TEXT, autark_days_count INTEGER,
    autark_days_year TEXT, autark_counted_day_key TEXT, autark_days_topic TEXT,
    autark_days_previous_year_count INTEGER, autark_days_previous_year TEXT,
    autark_days_previous_year_topic TEXT
  )`);
  await run(db, `INSERT INTO operating_state VALUES
    (1, 2, 0, 1, '2026-12-30', 100, '2026', '', '', 88, '2025', '')`);
  await operatingState.init(db);

  await operatingState.updateAutarkForDay(db, '2026-12-31', false);
  await operatingState.updateAutarkForDay(db, '2027-01-01', false);
  const state = operatingState.getState();
  assert.equal(state.autarkDaysPreviousYearCount, 102);
  assert.equal(state.autarkDaysPreviousYear, '2026');
  assert.equal(state.autarkDaysCount, 0);
  assert.equal(state.autarkDaysYear, '2027');

  await new Promise((resolve) => db.close(resolve));
});

test('onOperatingLevelChanged feuert nur bei tatsächlicher Level/änderung', async () => {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE operating_state (
    id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER,
    autark INTEGER, autark_day_key TEXT, autark_days_count INTEGER,
    autark_days_year TEXT, autark_counted_day_key TEXT, autark_days_topic TEXT,
    autark_days_previous_year_count INTEGER, autark_days_previous_year TEXT,
    autark_days_previous_year_topic TEXT
  )`);
  await run(db, `INSERT INTO operating_state VALUES
    (1, 2, 0, 1, '', 0, '', '', '', 0, '', '')`);
  await operatingState.init(db);

  const levels = [];
  const unsubscribe = operatingState.onOperatingLevelChanged((level) => levels.push(level));

  await operatingState.setOperatingLevel(db, 4);
  await operatingState.setOperatingLevel(db, 4); // unverändert → kein Event
  await operatingState.setOperatingLevel(db, 1);
  unsubscribe();
  await operatingState.setOperatingLevel(db, 5); // nach Unsubscribe → kein Event

  assert.deepEqual(levels, [4, 1]);

  await new Promise((resolve) => db.close(resolve));
});
