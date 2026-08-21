'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const automation = require('../src/grid-control/automation');
const { updateExtremeWindows, updateLoadSwitch, updateLoadSwitchDelayed, hasPhaseFailure, allPhasesPresent } = automation;
const { normalizeGridControlInput } = require('../src/grid-control/config');
const sqlite3 = require('sqlite3').verbose();
const mqttClient = require('../src/mqtt/client');
const modulesState = require('../src/modules');
const operatingState = require('../src/operating-state');
const systemWarning = require('../src/system-warning');

test('SoC remains off between the two independent switching windows', () => {
  assert.deepEqual(
    updateExtremeWindows(50, 20, 95, 2, false, false),
    { low: false, high: false, available: true }
  );
});

test('lower window releases only above its local hysteresis', () => {
  assert.equal(updateExtremeWindows(20, 20, 95, 2, false, false).low, true);
  assert.equal(updateExtremeWindows(21, 20, 95, 2, true, false).low, true);
  assert.equal(updateExtremeWindows(22, 20, 95, 2, true, false).low, false);
});

test('upper window releases only below its local hysteresis', () => {
  assert.equal(updateExtremeWindows(95, 20, 95, 2, false, false).high, true);
  assert.equal(updateExtremeWindows(94, 20, 95, 2, false, true).high, true);
  assert.equal(updateExtremeWindows(93, 20, 95, 2, false, true).high, false);
});

test('SoC hysteresis is limited to five percent', () => {
  assert.equal(normalizeGridControlInput({ socHysteresis: 99 }).socHysteresis, 5);
});

test('feed-in permission is disabled without a target topic', () => {
  assert.equal(normalizeGridControlInput({ feedInAllowed: 'on' }).feedInAllowed, false);
});

test('one failed phase is enough, but all phases are required for recovery', () => {
  assert.equal(hasPhaseFailure([50, 0, 50]), true);
  assert.equal(allPhasesPresent([50, 0, 50]), false);
  assert.equal(allPhasesPresent([50, null, 50]), false);
  assert.equal(allPhasesPresent([50, 50, 50]), true);
});

test('load switches on by any phase and off only below all three return thresholds', () => {
  const on = [4000, 4000, 4000];
  const off = [3000, 3000, 3000];
  assert.equal(updateLoadSwitch([4100, 1000, 1000], on, off, false), true);
  assert.equal(updateLoadSwitch([2500, 3200, 2500], on, off, true), true);
  assert.equal(updateLoadSwitch([2500, 2500, 2500], on, off, true), false);
});

test('load off-delay requires continuously low load and resets on a short rise', () => {
  const on = [4000, 4000, 4000];
  const off = [3000, 3000, 3000];
  let result = updateLoadSwitchDelayed([2500, 2500, 2500], on, off, true, 0, 30000, 100000);
  assert.deepEqual(result, { active: true, offSince: 100000 });
  result = updateLoadSwitchDelayed([2500, 2500, 2500], on, off, result.active, result.offSince, 30000, 129999);
  assert.equal(result.active, true);
  result = updateLoadSwitchDelayed([2500, 3100, 2500], on, off, result.active, result.offSince, 30000, 130000);
  assert.deepEqual(result, { active: true, offSince: 0 });
  result = updateLoadSwitchDelayed([2500, 2500, 2500], on, off, result.active, result.offSince, 30000, 140000);
  assert.deepEqual(result, { active: true, offSince: 140000 });
  result = updateLoadSwitchDelayed([2500, 2500, 2500], on, off, result.active, result.offSince, 30000, 170000);
  assert.deepEqual(result, { active: false, offSince: 0 });
});

test('load off-delay is configurable from zero to one hour', () => {
  assert.equal(normalizeGridControlInput({ loadOffDelaySeconds: -1 }).loadOffDelaySeconds, 0);
  assert.equal(normalizeGridControlInput({ loadOffDelaySeconds: 45 }).loadOffDelaySeconds, 45);
  assert.equal(normalizeGridControlInput({ loadOffDelaySeconds: 9999 }).loadOffDelaySeconds, 3600);
});

test('load shed max values are normalized independently from grid load thresholds', () => {
  const cfg = normalizeGridControlInput({ loadShedMaxL1: 5000, loadOnL1: 3000, loadOffL1: 1500 });
  assert.equal(cfg.loadShedMaxL1, 5000);
  assert.equal(cfg.loadOnL1, 3000);
  assert.equal(cfg.loadOffL1, 1500);
});

test('running load off-delay survives a HomeESS database reopen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-grid-delay-'));
  const dbPath = path.join(dir, 'state.db');
  const open = () => new sqlite3.Database(dbPath);
  const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
  const close = (db) => new Promise((resolve) => db.close(resolve));
  let db = open();

  try {
    await exec(db, `
      CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
      INSERT INTO operating_state VALUES (1, 2, 0);
      CREATE TABLE batterie_config (
        id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
        temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
        cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
      );
      INSERT INTO batterie_config VALUES (1, '', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
      CREATE TABLE grid_control_config (
        id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
        temperature_warning_topic TEXT, temperature_warning_value TEXT,
        warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER, load_enabled INTEGER, load_off_delay_seconds INTEGER,
      load_shed_max_l1 REAL, load_shed_max_l2 REAL, load_shed_max_l3 REAL,
      load_on_l1 REAL, load_on_l2 REAL, load_on_l3 REAL,
      load_off_l1 REAL, load_off_l2 REAL, load_off_l3 REAL
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.command', '', '', '1', '', '', 0, 0, 0, 0, 0, 5, 2, 0.5,
       '', '', '', 30, 1, 30, 4000, 4000, 4000, 4000, 4000, 4000, 3000, 3000, 3000);
      CREATE TABLE grid_control_runtime (
        id INTEGER PRIMARY KEY, load_active INTEGER, load_off_since INTEGER, initialized INTEGER
      );
      INSERT INTO grid_control_runtime VALUES (1, 1, ${Date.now()}, 1);
    `);
    await operatingState.init(db);
    await modulesState.setEnabled(db, 'grid-control', true);

    const cache = mqttClient.getCache();
    cache.clear();
    cache.set('mqtt.clockDate', { value: '2026-06-30', receivedAt: Date.now() });
    cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: Date.now() });
    cache.set('stromverbrauch_eigenverbrauch_l1', { value: 2500, receivedAt: Date.now() });
    cache.set('stromverbrauch_eigenverbrauch_l2', { value: 2500, receivedAt: Date.now() });
    cache.set('stromverbrauch_eigenverbrauch_l3', { value: 2500, receivedAt: Date.now() });
    const originalPublish = mqttClient.publish;
    const originalGetStatus = mqttClient.getStatus;
    mqttClient.publish = () => true;
    mqttClient.getStatus = () => ({ connected: true });

    try {
      await automation.runNow(db);
      assert.equal(automation.getState().gridByLoad, true);
      await close(db);

      db = open();
      await operatingState.init(db);
      await modulesState.setEnabled(db, 'grid-control', true);
      await automation.runNow(db);
      assert.equal(automation.getState().gridByLoad, true, 'Neustart darf nicht sofort abschalten');

      await run(db, 'UPDATE grid_control_runtime SET load_off_since = ? WHERE id = 1', [Date.now() - 31000]);
      await close(db);
      db = open();
      await operatingState.init(db);
      await modulesState.setEnabled(db, 'grid-control', true);
      await automation.runNow(db);
      assert.equal(automation.getState().gridByLoad, false, 'nach Ablauf darf abgeschaltet werden');
    } finally {
      mqttClient.publish = originalPublish;
      mqttClient.getStatus = originalGetStatus;
    }
  } finally {
    if (db) await close(db).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Gemeinsames Schema für die Neustart-Tests (volle Spaltenliste inkl. Last).
async function createRestartDb(configValues, runtimeRow) {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 2, 0);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER, load_enabled INTEGER, load_off_delay_seconds INTEGER,
      load_shed_max_l1 REAL, load_shed_max_l2 REAL, load_shed_max_l3 REAL,
      load_on_l1 REAL, load_on_l2 REAL, load_on_l3 REAL,
      load_off_l1 REAL, load_off_l2 REAL, load_off_l3 REAL
    );
    INSERT INTO grid_control_config VALUES (${configValues});
    CREATE TABLE grid_control_runtime (
      id INTEGER PRIMARY KEY, load_active INTEGER, load_off_since INTEGER, initialized INTEGER
    );
    ${runtimeRow ? `INSERT INTO grid_control_runtime VALUES (${runtimeRow});` : ''}
  `);
  await operatingState.init(db);
  await modulesState.setEnabled(db, 'grid-control', true);
  return db;
}

test('Neustart schaltet ein eingeschaltetes Netz im Hystereseband nicht aus', async () => {
  // SoC-Trigger aktiv: minSoc 20 + Offset 0 = Einschalten ≤ 20, Freigabe ≥ 22.
  const db = await createRestartDb(
    `1, 'grid.cmd.restart1', '', '', '1', '', '', 1, 0, 0, 0, 0, 5, 2, 0.5,
     '', '', '', 30, 0, 0, 4000, 4000, 4000, 4000, 4000, 4000, 3000, 3000, 3000`,
    null
  );
  const cache = mqttClient.getCache();
  cache.clear();
  cache.set('mqtt.clockDate', { value: '2026-07-08', receivedAt: Date.now() });
  // Ist-Zustand vor dem Neustart: Netz EIN, SoC im Hystereseband (21 %).
  cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: Date.now() });
  cache.set('batterie.soc', { value: 21, receivedAt: Date.now() });

  const published = [];
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, true, 'Hystereseband hält das Netz an');
    assert.ok(!published.some(([t]) => t === 'grid.cmd.restart1'),
      'kein Schaltbefehl: Broker meldet bereits den Soll-Zustand');

    // Erst wenn der SoC das Band verlässt, wird regulär abgeschaltet.
    cache.set('batterie.soc', { value: 23, receivedAt: Date.now() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, false);
    assert.ok(published.some(([t, v]) => t === 'grid.cmd.restart1' && Number(v) === 0),
      'Abschalten außerhalb des Bands bleibt erlaubt');
  } finally {
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('kein Aus-Befehl, solange die Broker-Rückmeldung des Netz-Schützes unbekannt ist', async () => {
  const db = await createRestartDb(
    `1, 'grid.cmd.restart2', '', '', '1', '', '', 1, 0, 0, 0, 0, 5, 2, 0.5,
     '', '', '', 30, 0, 0, 4000, 4000, 4000, 4000, 4000, 4000, 3000, 3000, 3000`,
    null
  );
  const cache = mqttClient.getCache();
  cache.clear();
  cache.set('mqtt.clockDate', { value: '2026-07-08', receivedAt: Date.now() });
  cache.set('batterie.soc', { value: 50, receivedAt: Date.now() }); // kein Trigger

  const published = [];
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, false);
    assert.ok(!published.some(([t]) => t === 'grid.cmd.restart2'),
      'ohne bekannten Ist-Zustand geht kein Aus-Befehl raus');

    // Broker meldet EIN, SoC (50 %) liegt außerhalb aller Bänder → regulär aus.
    cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: Date.now() });
    await automation.runNow(db);
    assert.ok(published.some(([t, v]) => t === 'grid.cmd.restart2' && Number(v) === 0),
      'mit bekanntem Ist-Zustand und vollständigen Messwerten wird geschaltet');
  } finally {
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('unvollständige Messwerte halten ein laut Broker eingeschaltetes Netz', async () => {
  // Lastüberwachung aktiv, Runtime sagt „Last war aus": die Lastmesswerte fehlen
  // nach dem Neustart zunächst → kein Aus-Befehl, bis sie bekannt sind.
  const db = await createRestartDb(
    `1, 'grid.cmd.restart3', '', '', '1', '', '', 1, 0, 0, 0, 0, 5, 2, 0.5,
     '', '', '', 30, 1, 0, 4000, 4000, 4000, 4000, 4000, 4000, 3000, 3000, 3000`,
    '1, 0, 0, 1'
  );
  const cache = mqttClient.getCache();
  cache.clear();
  cache.set('mqtt.clockDate', { value: '2026-07-08', receivedAt: Date.now() });
  cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: Date.now() });
  cache.set('batterie.soc', { value: 50, receivedAt: Date.now() });

  const published = [];
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, true, 'Ist-Zustand wird gehalten');
    assert.ok(!published.some(([t]) => t === 'grid.cmd.restart3'),
      'kein Aus-Befehl auf unvollständiger Entscheidungsgrundlage');

    // Lastwerte treffen ein und liegen unter den Schwellen → regulär aus.
    cache.set('stromverbrauch_eigenverbrauch_l1', { value: 100, receivedAt: Date.now() });
    cache.set('stromverbrauch_eigenverbrauch_l2', { value: 100, receivedAt: Date.now() });
    cache.set('stromverbrauch_eigenverbrauch_l3', { value: 100, receivedAt: Date.now() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, false);
    assert.ok(published.some(([t, v]) => t === 'grid.cmd.restart3' && Number(v) === 0));
  } finally {
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('emergency mode stays latched until grid frequency returns', async () => {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 2, 0);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.command', '', '', '1', 'warning.text', 'warning.active', 1, 0, 0, 0, 0, 5, 2, 0.5,
       'grid.frequency.l1', 'grid.frequency.l2', 'grid.frequency.l3', 1);
  `);
  await operatingState.init(db);
  await modulesState.setEnabled(db, 'grid-control', true);

  const cache = mqttClient.getCache();
  cache.clear();
  cache.set('mqtt.clockDate', { value: '2026-06-28', receivedAt: Date.now() });
  cache.set('batterie.soc', { value: 10, receivedAt: Date.now() });
  cache.set('gridcontrol.gridFrequencyL1', { value: 0, receivedAt: Date.now() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: Date.now() });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: Date.now() });
  const published = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };

  const automation = require('../src/grid-control/automation');
  await automation.runNow(db);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await automation.runNow(db);
  assert.equal(operatingState.getState().emergencyMode, true);
  assert.equal(automation.getState().gridActual, true);
  assert.equal(operatingState.getState().operatingLevel, 2);
  assert.equal(operatingState.getState().autark, false);
  assert.ok(published.some(([topic, value]) => topic === 'warning.text' && String(value).includes('Kein Netz')));

  cache.set('batterie.soc', { value: 50, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().emergencyMode, true);
  assert.equal(operatingState.getState().operatingLevel, 2);

  cache.set('batterie.soc', { value: 10, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().operatingLevel, 2);

  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: Date.now() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 0, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().emergencyMode, true);

  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().emergencyMode, false);
  assert.equal(operatingState.getState().operatingLevel, 2);

  cache.set('batterie.soc', { value: 50, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().operatingLevel, 2);
  assert.equal(automation.getState().gridActual, false);
  assert.equal(operatingState.getState().autark, false);

  cache.set('mqtt.clockDate', { value: '2026-06-29', receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().autark, true);

  cache.set('batterie.soc', { value: 10, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().autark, false);

  mqttClient.publish = originalPublish;
  await new Promise((resolve) => db.close(resolve));
});

test('grid command is verified against broker readback and re-asserted on divergence', async () => {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 2, 0);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.cmd.recon', '', '', '1', 'warning.text', 'warning.active', 1, 0, 0, 0, 0, 5, 2, 0.5,
       'grid.frequency.l1', 'grid.frequency.l2', 'grid.frequency.l3', 30);
  `);
  await operatingState.init(db);
  await modulesState.setEnabled(db, 'grid-control', true);

  const cache = mqttClient.getCache();
  cache.clear();
  const fresh = () => Date.now();
  cache.set('mqtt.clockDate', { value: '2026-06-28', receivedAt: fresh() });
  cache.set('batterie.soc', { value: 10, receivedAt: fresh() }); // unter unterer Grenze → Netz an
  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: fresh() });

  const published = [];
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  const automation = require('../src/grid-control/automation');

  // Tick 1: Netz soll an, Broker hat noch nichts zurückgemeldet → nicht bestätigt,
  // Befehl 1 wird geschrieben.
  await automation.runNow(db);
  assert.equal(automation.getState().gridActual, true);
  assert.equal(automation.getState().gridCommandConfirmed, false);
  assert.ok(published.some(([t, v]) => t === 'grid.cmd.recon' && Number(v) === 1), 'Befehl 1 muss geschrieben werden');

  // Broker meldet 1 zurück → bestätigt.
  cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: fresh() });
  await automation.runNow(db);
  assert.equal(automation.getState().gridCommandConfirmed, true);

  // Broker-Stand kippt unbemerkt auf 0 (verlorener Write / externe Änderung),
  // Soll bleibt aber an → die Überwachung MUSS die Abweichung erkennen.
  published.length = 0;
  cache.set('gridcontrol.gridCommand', { value: 0, receivedAt: fresh() });
  await automation.runNow(db);
  assert.equal(automation.getState().gridCommandConfirmed, false, 'Divergenz muss erkannt werden');

  // Nach Ablauf des Wiederhol-Intervalls wird der Befehl selbstheilend erneut gesetzt.
  await new Promise((resolve) => setTimeout(resolve, 4100));
  await automation.runNow(db);
  assert.ok(published.some(([t, v]) => t === 'grid.cmd.recon' && Number(v) === 1), 'Befehl muss erneut geschrieben werden');

  // Bei getrennter Verbindung gilt der Befehl niemals als bestätigt.
  mqttClient.getStatus = () => ({ connected: false });
  cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: fresh() });
  await automation.runNow(db);
  assert.equal(automation.getState().gridCommandConfirmed, false, 'ohne Verbindung keine Bestätigung');
  assert.equal(automation.getState().mqttConnected, false);

  mqttClient.publish = originalPublish;
  mqttClient.getStatus = originalGetStatus;
  await new Promise((resolve) => db.close(resolve));
});

test('eine normale, kurz darauf bestätigte Schaltung erzeugt keinen „nicht bestätigt"-Fehlalarm im Protokoll', async () => {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 2, 0);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.command', '', '', '1', 'warning.text', 'warning.active', 1, 0, 0, 0, 0, 5, 2, 0.5,
       'grid.frequency.l1', 'grid.frequency.l2', 'grid.frequency.l3', 30);
    CREATE TABLE grid_control_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL,
      message TEXT NOT NULL, values_text TEXT
    );
  `);
  await operatingState.init(db);
  await operatingState.setEmergencyMode(db, false);
  await modulesState.setEnabled(db, 'grid-control', true);

  const cache = mqttClient.getCache();
  cache.clear();
  const fresh = () => Date.now();
  cache.set('mqtt.clockDate', { value: '2026-06-28', receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: fresh() });

  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = () => true;
  mqttClient.getStatus = () => ({ connected: true });

  const automation = require('../src/grid-control/automation');
  const dbAll = (sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

  // SoC unter der Schwelle → Netz an. Broker bestätigt kurz darauf.
  cache.set('batterie.soc', { value: 10, receivedAt: fresh() });
  await automation.runNow(db);
  cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: fresh() });
  await automation.runNow(db);
  assert.equal(automation.getState().gridCommandConfirmed, true, 'Schaltung wird kurz darauf bestätigt');

  // SoC steigt über die obere Schwelle → Netz aus. Der Broker meldet den neuen
  // Sollwert noch nicht zurück (Realität: Roundtrip dauert länger als ein Tick).
  cache.set('batterie.soc', { value: 100, receivedAt: fresh() });
  await automation.runNow(db);
  assert.equal(automation.getState().gridActual, false, 'Netz wird abgeschaltet');
  assert.equal(automation.getState().gridCommandConfirmed, false, 'im selben Tick noch nicht bestätigt');

  await flush();
  const rows = await dbAll('SELECT category, message FROM grid_control_log');
  const notConfirmed = rows.filter((r) => /nicht bestätigt/.test(r.message));
  assert.equal(notConfirmed.length, 0, 'kein sofortiger „nicht bestätigt"-Fehlalarm ohne abgelaufenes Timeout');
  // Die eigentliche Schaltaktion wird weiterhin protokolliert.
  assert.ok(rows.some((r) => r.category === 'action' && /Netz abgeschaltet/.test(r.message)), 'Schaltaktion bleibt im Protokoll');

  mqttClient.publish = originalPublish;
  mqttClient.getStatus = originalGetStatus;
  await new Promise((resolve) => db.close(resolve));
});

test('stale grid frequencies do not unlatch emergency mode', async () => {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 1, 1);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.command', '', '', '1', 'warning.text', 'warning.active', 1, 0, 0, 0, 0, 5, 2, 0.5,
       'grid.frequency.l1', 'grid.frequency.l2', 'grid.frequency.l3', 30);
  `);
  await operatingState.init(db);
  await modulesState.setEnabled(db, 'grid-control', true);

  const cache = mqttClient.getCache();
  cache.clear();
  cache.set('mqtt.clockDate', { value: '2026-06-28', receivedAt: Date.now() });
  cache.set('batterie.soc', { value: 30, receivedAt: Date.now() });
  // Alle drei Frequenzen "vorhanden", aber überaltert (älter als 60 s) →
  // dürfen den Notstrom NICHT entriegeln.
  const stale = Date.now() - 120000;
  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: stale });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: stale });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: stale });

  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = () => true;
  mqttClient.getStatus = () => ({ connected: true });

  const automation = require('../src/grid-control/automation');
  await operatingState.setEmergencyMode(db, true);
  await automation.runNow(db);
  assert.equal(operatingState.getState().emergencyMode, true, 'stale Frequenzen entriegeln nicht');

  // Frische Werte → Entriegelung.
  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: Date.now() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: Date.now() });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: Date.now() });
  await automation.runNow(db);
  assert.equal(operatingState.getState().emergencyMode, false, 'frische Frequenzen entriegeln');

  mqttClient.publish = originalPublish;
  mqttClient.getStatus = originalGetStatus;
  await new Promise((resolve) => db.close(resolve));
});

// Gemeinsames Schema für die Last-Warnungs-Tests: SoC + Last aktiviert.
async function setupLoadWarningDb() {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 2, 0);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER, load_enabled INTEGER, load_off_delay_seconds INTEGER,
      load_shed_max_l1 REAL, load_shed_max_l2 REAL, load_shed_max_l3 REAL,
      load_on_l1 REAL, load_on_l2 REAL, load_on_l3 REAL,
      load_off_l1 REAL, load_off_l2 REAL, load_off_l3 REAL
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.command', '', '', '1', 'warning.text', 'warning.active', 1, 0, 0, 0, 0, 5, 2, 0.5,
       'grid.frequency.l1', 'grid.frequency.l2', 'grid.frequency.l3', 30,
       1, 0, 5000, 5000, 5000, 4000, 4000, 4000, 3000, 3000, 3000);
    CREATE TABLE grid_control_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL,
      message TEXT NOT NULL, values_text TEXT
    );
    CREATE TABLE grid_control_runtime (
      id INTEGER PRIMARY KEY, load_active INTEGER, load_off_since INTEGER, initialized INTEGER
    );
    INSERT INTO grid_control_runtime VALUES (1, 0, 0, 1);
  `);
  await operatingState.init(db);
  await operatingState.setEmergencyMode(db, false);
  await modulesState.setEnabled(db, 'grid-control', true);
  return db;
}

test('Wechselrichterlast bei bereits geschaltetem Netz: keine Warnung, aber Grid-by-Load rastet ein und hält das Netz', async () => {
  const db = await setupLoadWarningDb();
  const dbAll = (sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
  const cache = mqttClient.getCache();
  cache.clear();
  const fresh = () => Date.now();
  cache.set('mqtt.clockDate', { value: '2026-06-28', receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: fresh() });

  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = () => true;
  mqttClient.getStatus = () => ({ connected: true });

  try {
    // SoC unter der Schwelle → Netz an; Last noch niedrig.
    cache.set('batterie.soc', { value: 10, receivedAt: fresh() });
    cache.set('stromverbrauch_eigenverbrauch_l1', { value: 1000, receivedAt: fresh() });
    cache.set('stromverbrauch_eigenverbrauch_l2', { value: 1000, receivedAt: fresh() });
    cache.set('stromverbrauch_eigenverbrauch_l3', { value: 1000, receivedAt: fresh() });
    await automation.runNow(db);
    cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: fresh() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, true, 'Netz ist wegen SoC geschaltet');
    assert.equal(automation.getState().gridByLoad, false);

    // Last überschreitet die Ein-Schwelle, während das Netz schon per SoC an ist.
    cache.set('stromverbrauch_eigenverbrauch_l1', { value: 4500, receivedAt: fresh() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridByLoad, true, 'Grid-by-Load rastet dennoch ein');

    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = await dbAll('SELECT category, message FROM grid_control_log');
    assert.equal(
      rows.some((r) => /Wechselrichterlast zu hoch/.test(r.message)), false,
      'keine Last-Warnung, da Netz bereits aus anderem Grund geschaltet war'
    );

    // SoC erholt sich in den grünen Bereich → der ursprüngliche Grund bricht weg,
    // die Last hält das Netz weiter geschaltet.
    cache.set('batterie.soc', { value: 60, receivedAt: fresh() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridBySoc, false, 'SoC-Grund ist weg');
    assert.equal(automation.getState().gridByLoad, true, 'Last hält weiter');
    assert.equal(automation.getState().gridActual, true, 'Netz bleibt geschaltet, solange die Phase überlastet ist');
  } finally {
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('Wechselrichterlast als alleiniger Auslöser wird weiterhin als kritisch protokolliert', async () => {
  const db = await setupLoadWarningDb();
  const dbAll = (sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
  const cache = mqttClient.getCache();
  cache.clear();
  const fresh = () => Date.now();
  cache.set('mqtt.clockDate', { value: '2026-06-28', receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL1', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL2', { value: 50, receivedAt: fresh() });
  cache.set('gridcontrol.gridFrequencyL3', { value: 50, receivedAt: fresh() });

  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  mqttClient.publish = () => true;
  mqttClient.getStatus = () => ({ connected: true });

  try {
    // SoC im grünen Bereich, Netz aus, Last niedrig.
    cache.set('batterie.soc', { value: 60, receivedAt: fresh() });
    cache.set('stromverbrauch_eigenverbrauch_l1', { value: 1000, receivedAt: fresh() });
    cache.set('stromverbrauch_eigenverbrauch_l2', { value: 1000, receivedAt: fresh() });
    cache.set('stromverbrauch_eigenverbrauch_l3', { value: 1000, receivedAt: fresh() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridActual, false, 'Netz ist zunächst aus');

    // Last als einziger Auslöser schaltet das Netz zu → das bleibt eine Warnung.
    cache.set('stromverbrauch_eigenverbrauch_l1', { value: 4500, receivedAt: fresh() });
    await automation.runNow(db);
    assert.equal(automation.getState().gridByLoad, true);
    assert.equal(automation.getState().gridActual, true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = await dbAll('SELECT category, message FROM grid_control_log');
    assert.ok(
      rows.some((r) => r.category === 'critical' && /Wechselrichterlast zu hoch/.test(r.message)),
      'Last als alleiniger Schaltgrund bleibt kritisch protokolliert'
    );
  } finally {
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

// ── Trägheit der Bestätigungsüberwachung ───────────────────────────────────
// Sporadische Aussetzer (Netzwerk, spät antwortendes Cerbo-GX) dürfen den
// Nutzer nicht alarmieren. Gewarnt wird erst, wenn der Fehler über Minuten und
// trotz mehrfacher Wiederholungen bestehen bleibt.

// Gemeinsames Grundgerüst für die Persistenztests: SoC unter der unteren
// Schwelle → Netz soll ein; der Broker bestätigt bewusst nie.
async function setupConfirmScenario({ feedInTopic = '' } = {}) {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
  await exec(`
    CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operating_state (id INTEGER PRIMARY KEY, operating_level INTEGER, emergency_mode INTEGER);
    INSERT INTO operating_state VALUES (1, 2, 0);
    CREATE TABLE batterie_config (
      id INTEGER PRIMARY KEY, soc_topic TEXT, power_topic TEXT, voltage_topic TEXT,
      temperatur_topic TEXT, min_soc_topic TEXT, min_soc INTEGER, battery_type TEXT,
      cell_count INTEGER, lower_voltage REAL, upper_voltage REAL
    );
    INSERT INTO batterie_config VALUES (1, 'battery.soc', '', '', '', '', 20, 'lifepo4', 16, 44.8, 55.2);
    CREATE TABLE grid_control_config (
      id INTEGER PRIMARY KEY, grid_command_topic TEXT, feed_in_command_topic TEXT,
      temperature_warning_topic TEXT, temperature_warning_value TEXT,
      warning_text_topic TEXT, warning_active_topic TEXT, soc_enabled INTEGER,
      voltage_enabled INTEGER, temperature_enabled INTEGER, feed_in_allowed INTEGER,
      soc_lower_offset INTEGER, soc_upper_offset INTEGER, soc_hysteresis INTEGER,
      voltage_hysteresis REAL, grid_frequency_l1_topic TEXT,
      grid_frequency_l2_topic TEXT, grid_frequency_l3_topic TEXT,
      grid_detection_seconds INTEGER
    );
    INSERT INTO grid_control_config VALUES
      (1, 'grid.command', '${feedInTopic}', '', '1', 'warning.text', 'warning.active', 1, 0, 0,
       ${feedInTopic ? 1 : 0}, 0, 5, 2, 0.5,
       'grid.frequency.l1', 'grid.frequency.l2', 'grid.frequency.l3', 30);
    CREATE TABLE grid_control_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL,
      message TEXT NOT NULL, values_text TEXT
    );
  `);
  await operatingState.init(db);
  await operatingState.setEmergencyMode(db, false);
  await modulesState.setEnabled(db, 'grid-control', true);
  require('../src/grid-control/config').invalidateGridControlConfig();
  systemWarning.resetForTests();
  // Die Bestätigungs-Tracks leben modulweit; ohne Rücksetzen schleppte ein
  // vorheriger Test seinen Warnzustand in den nächsten.
  automation.acknowledgeWarnings(null);
  return db;
}

// Zeitgesteuerte Ticks: Date.now() wird vorgespult, damit Minuten ohne echte
// Wartezeit vergehen. Der Deckel je Durchlauf (15 s) verlangt entsprechend
// viele Ticks — genau wie im Betrieb.
async function advanceTicks(db, { steps, stepMs, cache, base }) {
  let current = base;
  for (let i = 0; i < steps; i += 1) {
    current += stepMs;
    Date.now = () => current;
    cache.set('batterie.soc', { value: 10, receivedAt: current });
    await automation.runNow(db);
  }
  return current;
}

test('ein kurzer Bestätigungsaussetzer erzeugt weder Warntopic noch systemweite Warnung', async () => {
  const db = await setupConfirmScenario();
  const cache = mqttClient.getCache();
  cache.clear();
  const originalNow = Date.now;
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  const published = [];
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    let base = originalNow();
    Date.now = () => base;
    cache.set('mqtt.clockDate', { value: '2026-08-21', receivedAt: base });
    cache.set('batterie.soc', { value: 10, receivedAt: base });
    await automation.runNow(db);

    // Zwei Minuten ohne Bestätigung: über der Kulanzfrist, aber weit unter der
    // Persistenzschwelle.
    await advanceTicks(db, { steps: 8, stepMs: 15000, cache, base });

    assert.equal(published.some(([t]) => t === 'warning.text'), false, 'kein Warntext auf dem Warntopic');
    assert.equal(systemWarning.getState().active, false, 'keine systemweite Warnung');
    const rows = await new Promise((resolve, reject) => db.all('SELECT message FROM grid_control_log', (err, r) => err ? reject(err) : resolve(r || [])));
    assert.equal(rows.some((r) => /nicht bestätigt/.test(r.message)), false, 'kein roter Protokolleintrag');
  } finally {
    Date.now = originalNow;
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('erst eine über Minuten anhaltende Abweichung gilt als persistent und warnt', async () => {
  const db = await setupConfirmScenario();
  const cache = mqttClient.getCache();
  cache.clear();
  const originalNow = Date.now;
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  const published = [];
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    const base = originalNow();
    Date.now = () => base;
    cache.set('mqtt.clockDate', { value: '2026-08-21', receivedAt: base });
    cache.set('batterie.soc', { value: 10, receivedAt: base });
    await automation.runNow(db);

    // Gut sechs Minuten ohne Bestätigung, jeder Durchlauf schreibt den Befehl erneut.
    await advanceTicks(db, { steps: 25, stepMs: 15000, cache, base });

    const warningText = published.filter(([t]) => t === 'warning.text');
    assert.equal(warningText.length, 1, 'genau eine Warnung, keine Wiederholung');
    assert.match(String(warningText[0][1]), /Netzschaltung nicht bestätigt/);
    assert.match(String(warningText[0][1]), /Wiederholungen/);
    assert.ok(published.some(([t, v]) => t === 'warning.active' && v === true), 'Warnung-aktiv wird gesetzt');
    assert.equal(systemWarning.getState().active, true, 'systemweite Warnung steht');
    assert.equal(automation.getState().gridCommandWarned, true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = await new Promise((resolve, reject) => db.all('SELECT category, message FROM grid_control_log', (err, r) => err ? reject(err) : resolve(r || [])));
    assert.ok(rows.some((r) => r.category === 'critical' && /Netzschaltung dauerhaft nicht bestätigt/.test(r.message)), 'roter Protokolleintrag');
  } finally {
    Date.now = originalNow;
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('ohne Broker-Verbindung läuft die Persistenzzeit nicht weiter', async () => {
  const db = await setupConfirmScenario();
  const cache = mqttClient.getCache();
  cache.clear();
  const originalNow = Date.now;
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  const published = [];
  // Ohne Verbindung schlägt das Schreiben fehl – wie im Betrieb.
  let connected = true;
  mqttClient.publish = (topic, value) => {
    if (!connected) return false;
    published.push([topic, value]);
    return true;
  };
  mqttClient.getStatus = () => ({ connected });

  try {
    const base = originalNow();
    Date.now = () => base;
    cache.set('mqtt.clockDate', { value: '2026-08-21', receivedAt: base });
    cache.set('batterie.soc', { value: 10, receivedAt: base });
    await automation.runNow(db);
    cache.set('gridcontrol.gridCommand', { value: 1, receivedAt: base });
    await automation.runNow(db);
    assert.equal(automation.getState().gridCommandConfirmed, true);

    // Verbindungsabriss über eine Viertelstunde: Der zuletzt bestätigte Stand
    // bleibt stehen, gewarnt wird nicht.
    connected = false;
    await advanceTicks(db, { steps: 60, stepMs: 15000, cache, base });

    assert.equal(published.some(([t]) => t === 'warning.text'), false, 'ein Verbindungsabriss ist kein Schaltfehler');
    assert.equal(systemWarning.getState().active, false, 'keine systemweite Warnung');
  } finally {
    Date.now = originalNow;
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('die Überschusseinspeisung warnt nicht, solange sie gar nicht gefordert ist', async () => {
  const db = await setupConfirmScenario({ feedInTopic: 'feedin.command' });
  const cache = mqttClient.getCache();
  cache.clear();
  const originalNow = Date.now;
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  const published = [];
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    const base = originalNow();
    Date.now = () => base;
    cache.set('mqtt.clockDate', { value: '2026-08-21', receivedAt: base });
    // SoC unter der unteren Schwelle: Netz soll ein, Einspeisung ausdrücklich
    // aus (es gibt keinen Überschuss). Der Broker meldet für die Einspeisung
    // einen unbrauchbaren Wert – bestätigt ist damit nichts.
    cache.set('batterie.soc', { value: 10, receivedAt: base });
    cache.set('gridcontrol.feedInCommand', { value: 'unbekannt', receivedAt: base });
    await automation.runNow(db);

    await advanceTicks(db, { steps: 25, stepMs: 15000, cache, base });

    const warnings = published.filter(([t]) => t === 'warning.text').map(([, v]) => String(v));
    assert.equal(warnings.some((text) => /Überschusseinspeisung/.test(text)), false,
      'keine Warnung über eine Einspeisung, die nicht gefordert ist');
    // Die Netzschaltung selbst wird sehr wohl gemeldet.
    assert.equal(warnings.some((text) => /Netzschaltung nicht bestätigt/.test(text)), true);
    assert.equal(automation.getState().feedInCommandWarned, false);
  } finally {
    Date.now = originalNow;
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});

test('das Quittieren der Warnung leert das Warntopic und setzt die Persistenzzählung zurück', async () => {
  const db = await setupConfirmScenario();
  const cache = mqttClient.getCache();
  cache.clear();
  const originalNow = Date.now;
  const originalPublish = mqttClient.publish;
  const originalGetStatus = mqttClient.getStatus;
  const published = [];
  mqttClient.publish = (topic, value) => { published.push([topic, value]); return true; };
  mqttClient.getStatus = () => ({ connected: true });

  try {
    const base = originalNow();
    Date.now = () => base;
    cache.set('mqtt.clockDate', { value: '2026-08-21', receivedAt: base });
    cache.set('batterie.soc', { value: 10, receivedAt: base });
    await automation.runNow(db);
    const end = await advanceTicks(db, { steps: 25, stepMs: 15000, cache, base });
    assert.equal(systemWarning.getState().active, true);

    published.length = 0;
    automation.acknowledgeWarnings(db);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(published.some(([t, v]) => t === 'warning.text' && v === ''), 'Warntext wird geleert');
    assert.ok(published.some(([t, v]) => t === 'warning.active' && v === false), 'Warnung-aktiv wird zurückgesetzt');
    assert.equal(automation.getState().gridCommandWarned, false);

    // Der Fehler besteht weiter, muss die Persistenzzeit aber erneut durchlaufen.
    published.length = 0;
    await advanceTicks(db, { steps: 8, stepMs: 15000, cache, base: end });
    assert.equal(published.some(([t]) => t === 'warning.text'), false, 'keine sofortige Wiederholung der Warnung');
  } finally {
    Date.now = originalNow;
    mqttClient.publish = originalPublish;
    mqttClient.getStatus = originalGetStatus;
    await new Promise((resolve) => db.close(resolve));
  }
});
