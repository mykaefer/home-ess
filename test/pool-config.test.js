'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { loadPoolConfig, savePoolConfig } = require('../src/pool/config');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function loadCfg(db) {
  return new Promise((resolve) => loadPoolConfig(db, resolve));
}

function saveCfg(db, body) {
  return new Promise((resolve, reject) => {
    savePoolConfig(db, body, (err, cfg) => (err ? reject(err) : resolve(cfg)));
  });
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE pool_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    temperature_topic TEXT NOT NULL DEFAULT '',
    solar_pump_status_topic TEXT NOT NULL DEFAULT '',
    solar_pump_command_topic TEXT NOT NULL DEFAULT '',
    solar_pump_priority INTEGER NOT NULL DEFAULT 2,
    solar_pump_phase TEXT NOT NULL DEFAULT 'l1',
    solar_pump_max_temp REAL,
    solar_pump_temp_on_seconds INTEGER NOT NULL DEFAULT 30,
    solar_pump_temp_pause_minutes INTEGER NOT NULL DEFAULT 30,
    solar_pump_temp_use_filter INTEGER NOT NULL DEFAULT 0,
    solar_pump_rated_power_w REAL,
    filter_pump_status_topic TEXT NOT NULL DEFAULT '',
    filter_pump_command_topic TEXT NOT NULL DEFAULT '',
    filter_pump_priority INTEGER NOT NULL DEFAULT 4,
    filter_pump_phase TEXT NOT NULL DEFAULT 'l1',
    filter_pump_follow_solar INTEGER NOT NULL DEFAULT 0,
    filter_time_1_start TEXT NOT NULL DEFAULT '',
    filter_time_1_end TEXT NOT NULL DEFAULT '',
    filter_time_2_start TEXT NOT NULL DEFAULT '',
    filter_time_2_end TEXT NOT NULL DEFAULT '',
    filter_time_3_start TEXT NOT NULL DEFAULT '',
    filter_time_3_end TEXT NOT NULL DEFAULT '',
    filter_battery_enabled INTEGER NOT NULL DEFAULT 0,
    filter_battery_soc INTEGER NOT NULL DEFAULT 80,
    filter_pump_rated_power_w REAL,
    ph_topic TEXT NOT NULL DEFAULT '',
    chlor_topic TEXT NOT NULL DEFAULT ''
  )`);
  return db;
}

test('Pool-Konfiguration speichert Lastabwurf-Phasen', async () => {
  const db = await freshDb();
  await saveCfg(db, {
    solarPumpPriority: 2,
    solarPumpPhase: 'l3',
    filterPumpPriority: 4,
    filterPumpPhase: 'three_phase',
  });
  const cfg = await loadCfg(db);
  assert.equal(cfg.solarPumpPhase, 'l3');
  assert.equal(cfg.filterPumpPhase, 'three_phase');
  await new Promise((resolve) => db.close(resolve));
});

test('Pool-Konfiguration normalisiert ungueltige Phasen auf L1', async () => {
  const db = await freshDb();
  await saveCfg(db, {
    solarPumpPhase: 'foo',
    filterPumpPhase: '',
  });
  const cfg = await loadCfg(db);
  assert.equal(cfg.solarPumpPhase, 'l1');
  assert.equal(cfg.filterPumpPhase, 'l1');
  await new Promise((resolve) => db.close(resolve));
});
