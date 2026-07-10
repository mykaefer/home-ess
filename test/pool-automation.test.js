'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

// Singletons, die die Pool-Automation referenziert – vor runNow gezielt patchen.
const mqttClient = require('../src/mqtt/client');
const levelHandler = require('../src/operating-level/handler');
const modules = require('../src/modules');
const loadShed = require('../src/grid-control/load-shed');
const { normalizeMqttTopic } = require('../src/mqtt/topics');
const poolAutomation = require('../src/pool/automation');

// Baut einen MQTT-Cache-Stub mit denselben Schlüsseln, die readPoolValue nutzt.
function buildCache(entries = {}) {
  const map = new Map();
  for (const [topic, value] of Object.entries(entries)) {
    map.set(`pool:${normalizeMqttTopic(topic)}`, { value });
  }
  return { get: (key) => map.get(key) };
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb({ solarPriority = 5, solarStatusTopic = '' } = {}) {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)`);
  await dbRun(db, `INSERT INTO modules (key, enabled) VALUES ('pool', 1)`);
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
    filter_pump_status_topic TEXT NOT NULL DEFAULT '',
    filter_pump_command_topic TEXT NOT NULL DEFAULT '',
    filter_pump_priority INTEGER NOT NULL DEFAULT 4,
    filter_pump_phase TEXT NOT NULL DEFAULT 'l1',
    filter_pump_follow_solar INTEGER NOT NULL DEFAULT 0,
    filter_time_1_start TEXT NOT NULL DEFAULT '', filter_time_1_end TEXT NOT NULL DEFAULT '',
    filter_time_2_start TEXT NOT NULL DEFAULT '', filter_time_2_end TEXT NOT NULL DEFAULT '',
    filter_time_3_start TEXT NOT NULL DEFAULT '', filter_time_3_end TEXT NOT NULL DEFAULT '',
    filter_battery_enabled INTEGER NOT NULL DEFAULT 0, filter_battery_soc INTEGER NOT NULL DEFAULT 80,
    ph_topic TEXT NOT NULL DEFAULT '', chlor_topic TEXT NOT NULL DEFAULT ''
  )`);
  await dbRun(db,
    `INSERT INTO pool_config (id, solar_pump_command_topic, solar_pump_priority, solar_pump_status_topic)
     VALUES (1, 'pool.solar.cmd', ?, ?)`, [solarPriority, solarStatusTopic]);
  await modules.initModules(db);
  return db;
}

// Fängt alle publish()-Aufrufe ab und simuliert ein niedriges Betriebslevel.
function patchRuntime({ cache } = {}) {
  poolAutomation.resetForTests(); // kein Zustands-Leak aus vorherigen Tests
  const publishes = [];
  const originalPublish = mqttClient.publish;
  const originalGetCache = mqttClient.getCache;
  const originalIsAllowed = levelHandler.isAllowed;
  mqttClient.publish = (topic, value) => { publishes.push({ topic, value }); return true; };
  mqttClient.getCache = () => (cache || { get: () => undefined });
  // Betriebslevel unter der Solar-Priorität → im Automatik-Modus wäre gesperrt.
  levelHandler.isAllowed = () => false;
  return {
    publishes,
    restore() {
      mqttClient.publish = originalPublish;
      mqttClient.getCache = originalGetCache;
      levelHandler.isAllowed = originalIsAllowed;
      poolAutomation.setPumpMode('solar', 'auto');
    },
  };
}

test('Hand-„An" schaltet die Solarpumpe trotz gesperrtem Betriebslevel ein', async () => {
  const db = await freshDb({ solarPriority: 5 });
  const rt = patchRuntime();
  try {
    poolAutomation.setPumpMode('solar', 'on');
    await poolAutomation.runNow(db);
    const solarCmd = rt.publishes.find((p) => p.topic === 'pool.solar.cmd');
    assert.ok(solarCmd, 'Solarpumpe hätte einen Schaltbefehl senden müssen');
    assert.equal(solarCmd.value, '1'); // EIN, nicht AUS – Level wird ignoriert
    assert.equal(poolAutomation.getSolarOutput(), 'on');
  } finally {
    rt.restore();
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Veralteter Lastabwurf-Cutoff sperrt die Solarpumpe bei inaktivem Grid-Control nicht', async () => {
  const db = await freshDb({ solarPriority: 2 });
  const rt = patchRuntime();
  // Level reicht wieder aus – hier geht es allein um den Lastabwurf.
  levelHandler.isAllowed = () => true;
  // Einen echten Cutoff auf L1 erzeugen (frühere, jetzt beendete Grid-Control-Phase):
  loadShed.resetForTests();
  loadShed.registerProvider('probe', [{ id: 'x', phase: 'l1', priority: 2 }]);
  loadShed.update([2000, 0, 0], { loadEnabled: true, loadShedMaxL1: 1000, loadShedMaxL2: 0, loadShedMaxL3: 0 }, Date.now());
  assert.equal(loadShed.shouldShed('l1', 2), true, 'Vorbedingung: Cutoff steht (stale)');
  try {
    // Grid-Control ist NICHT aktiv (Modul aus) → der stale Cutoff darf nicht greifen.
    poolAutomation.setPumpMode('solar', 'on');
    await poolAutomation.runNow(db);
    const solarCmd = rt.publishes.find((p) => p.topic === 'pool.solar.cmd');
    assert.ok(solarCmd, 'Solarpumpe hätte trotz stale Cutoff schalten müssen');
    assert.equal(solarCmd.value, '1'); // EIN – der veraltete Lastabwurf wird ignoriert
    assert.equal(poolAutomation.getSolarOutput(), 'on');
  } finally {
    rt.restore();
    loadShed.resetForTests();
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Reconciliation: Glaube „on", aber Status meldet „aus" → Solarpumpe wird nachgeschaltet', async () => {
  const db = await freshDb({ solarPriority: 2, solarStatusTopic: 'pool.solar.status' });
  const statusKey = `pool:${normalizeMqttTopic('pool.solar.status')}`;
  const map = new Map([[statusKey, { value: '1' }]]); // Gerät meldet zunächst AN
  const cache = { get: (k) => map.get(k) };
  const rt = patchRuntime({ cache });
  levelHandler.isAllowed = () => true; // Freigaben erfüllt – es geht allein um den Ist-Abgleich
  try {
    poolAutomation.setPumpMode('solar', 'on');
    await poolAutomation.runNow(db);
    // Status = AN → interner Glaube wird auf „on" gesetzt, ohne (erneut) zu senden.
    assert.equal(poolAutomation.getSolarOutput(), 'on');
    assert.equal(rt.publishes.filter((p) => p.topic === 'pool.solar.cmd').length, 0,
      'kein Befehl, solange das Gerät bereits im Zielzustand ist');
    // Gerät fällt aus: Status meldet nun AUS, der interne Glaube bleibt „on".
    map.set(statusKey, { value: '0' });
    await poolAutomation.runNow(db);
    const cmds = rt.publishes.filter((p) => p.topic === 'pool.solar.cmd');
    assert.equal(cmds.length, 1, 'genau ein Nachschalt-Befehl trotz „on"-Glauben');
    assert.equal(cmds[0].value, '1'); // erneut EIN, weil der Ist-Zustand abweicht
  } finally {
    rt.restore();
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Hand-„Aus" schaltet die Solarpumpe unabhängig vom Betriebslevel ab', async () => {
  const db = await freshDb({ solarPriority: 5 });
  const rt = patchRuntime();
  try {
    poolAutomation.setPumpMode('solar', 'off');
    await poolAutomation.runNow(db);
    const solarCmd = rt.publishes.find((p) => p.topic === 'pool.solar.cmd');
    assert.ok(solarCmd, 'Solarpumpe hätte einen Schaltbefehl senden müssen');
    assert.equal(solarCmd.value, '0');
    assert.equal(poolAutomation.getSolarOutput(), 'off');
  } finally {
    rt.restore();
    await new Promise((resolve) => db.close(resolve));
  }
});
