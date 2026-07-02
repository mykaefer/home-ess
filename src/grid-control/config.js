'use strict';

const { normalizeMqttTopic } = require('../mqtt/topics');

const STATE_IDS = {
  gridCommand: 'gridcontrol.gridCommand', feedInCommand: 'gridcontrol.feedInCommand',
  temperatureWarning: 'gridcontrol.temperatureWarning', warningText: 'gridcontrol.warningText',
  warningActive: 'gridcontrol.warningActive',
  gridFrequencyL1: 'gridcontrol.gridFrequencyL1', gridFrequencyL2: 'gridcontrol.gridFrequencyL2',
  gridFrequencyL3: 'gridcontrol.gridFrequencyL3',
};

const DEFAULTS = {
  gridCommandTopic: '', feedInCommandTopic: '', temperatureWarningTopic: '',
  temperatureWarningValue: '1', warningTextTopic: '', warningActiveTopic: '',
  socEnabled: false, voltageEnabled: false, temperatureEnabled: false, loadEnabled: false,
  feedInAllowed: false, socLowerOffset: 0, socUpperOffset: 5,
  socHysteresis: 2, voltageHysteresis: 0.5,
  gridFrequencyL1Topic: '', gridFrequencyL2Topic: '', gridFrequencyL3Topic: '',
  gridDetectionSeconds: 30,
  loadOffDelaySeconds: 30,
  loadOnL1: '', loadOnL2: '', loadOnL3: '', loadOffL1: '', loadOffL2: '', loadOffL3: '',
};

let cachedDb = null;
let cachedConfig = null;

function number(value, min, max, fallback) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function optionalNumber(value) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nullableValue(value) { return value == null ? '' : value; }

function rowToConfig(row = {}) {
  return {
    gridCommandTopic: row.grid_command_topic || '', feedInCommandTopic: row.feed_in_command_topic || '',
    temperatureWarningTopic: row.temperature_warning_topic || '',
    temperatureWarningValue: row.temperature_warning_value == null || row.temperature_warning_value === '' ? '1' : String(row.temperature_warning_value),
    warningTextTopic: row.warning_text_topic || '', warningActiveTopic: row.warning_active_topic || '',
    socEnabled: !!row.soc_enabled, voltageEnabled: !!row.voltage_enabled,
    temperatureEnabled: !!row.temperature_enabled, loadEnabled: !!row.load_enabled,
    feedInAllowed: !!row.feed_in_allowed && !!row.feed_in_command_topic,
    socLowerOffset: row.soc_lower_offset == null ? DEFAULTS.socLowerOffset : row.soc_lower_offset,
    socUpperOffset: row.soc_upper_offset == null ? DEFAULTS.socUpperOffset : row.soc_upper_offset,
    socHysteresis: row.soc_hysteresis == null ? DEFAULTS.socHysteresis : row.soc_hysteresis,
    voltageHysteresis: row.voltage_hysteresis == null ? DEFAULTS.voltageHysteresis : row.voltage_hysteresis,
    gridFrequencyL1Topic: row.grid_frequency_l1_topic || row.grid_frequency_topic || '',
    gridFrequencyL2Topic: row.grid_frequency_l2_topic || '', gridFrequencyL3Topic: row.grid_frequency_l3_topic || '',
    gridDetectionSeconds: row.grid_detection_seconds == null ? DEFAULTS.gridDetectionSeconds : row.grid_detection_seconds,
    loadOffDelaySeconds: row.load_off_delay_seconds == null ? DEFAULTS.loadOffDelaySeconds : row.load_off_delay_seconds,
    loadOnL1: nullableValue(row.load_on_l1), loadOnL2: nullableValue(row.load_on_l2), loadOnL3: nullableValue(row.load_on_l3),
    loadOffL1: nullableValue(row.load_off_l1), loadOffL2: nullableValue(row.load_off_l2), loadOffL3: nullableValue(row.load_off_l3),
  };
}

function loadGridControlConfig(db, callback) {
  if (cachedDb === db && cachedConfig) {
    queueMicrotask(() => callback({ ...cachedConfig }));
    return;
  }
  db.get('SELECT * FROM grid_control_config WHERE id = 1', (err, row) => {
    const config = err || !row ? { ...DEFAULTS } : rowToConfig(row);
    cachedDb = db;
    cachedConfig = config;
    callback({ ...config });
  });
}

function invalidateGridControlConfig(db = null) {
  if (!db || cachedDb === db) {
    cachedDb = null;
    cachedConfig = null;
  }
}

function normalizeGridControlInput(input = {}) {
  return {
    gridCommandTopic: normalizeMqttTopic(input.gridCommandTopic || ''),
    feedInCommandTopic: normalizeMqttTopic(input.feedInCommandTopic || ''),
    temperatureWarningTopic: normalizeMqttTopic(input.temperatureWarningTopic || ''),
    temperatureWarningValue: String(input.temperatureWarningValue == null || input.temperatureWarningValue === '' ? '1' : input.temperatureWarningValue).trim(),
    warningTextTopic: normalizeMqttTopic(input.warningTextTopic || ''), warningActiveTopic: normalizeMqttTopic(input.warningActiveTopic || ''),
    socEnabled: !!input.socEnabled, voltageEnabled: !!input.voltageEnabled,
    temperatureEnabled: !!input.temperatureEnabled, loadEnabled: !!input.loadEnabled,
    feedInAllowed: !!input.feedInAllowed && !!normalizeMqttTopic(input.feedInCommandTopic || ''),
    socLowerOffset: number(input.socLowerOffset, 0, 20, DEFAULTS.socLowerOffset),
    socUpperOffset: number(input.socUpperOffset, 0, 20, DEFAULTS.socUpperOffset),
    socHysteresis: number(input.socHysteresis, 0, 5, DEFAULTS.socHysteresis),
    voltageHysteresis: number(input.voltageHysteresis, 0, 10, DEFAULTS.voltageHysteresis),
    gridFrequencyL1Topic: normalizeMqttTopic(input.gridFrequencyL1Topic || ''),
    gridFrequencyL2Topic: normalizeMqttTopic(input.gridFrequencyL2Topic || ''),
    gridFrequencyL3Topic: normalizeMqttTopic(input.gridFrequencyL3Topic || ''),
    gridDetectionSeconds: Math.round(number(input.gridDetectionSeconds, 1, 3600, DEFAULTS.gridDetectionSeconds)),
    loadOffDelaySeconds: Math.round(number(input.loadOffDelaySeconds, 0, 3600, DEFAULTS.loadOffDelaySeconds)),
    loadOnL1: optionalNumber(input.loadOnL1), loadOnL2: optionalNumber(input.loadOnL2), loadOnL3: optionalNumber(input.loadOnL3),
    loadOffL1: optionalNumber(input.loadOffL1), loadOffL2: optionalNumber(input.loadOffL2), loadOffL3: optionalNumber(input.loadOffL3),
  };
}

function saveGridControlConfig(db, input, callback) {
  const cfg = normalizeGridControlInput(input);
  db.run(
    `INSERT INTO grid_control_config
      (id, grid_command_topic, feed_in_command_topic, temperature_warning_topic, temperature_warning_value,
       warning_text_topic, warning_active_topic, soc_enabled, voltage_enabled, temperature_enabled, feed_in_allowed,
       soc_lower_offset, soc_upper_offset, soc_hysteresis, voltage_hysteresis,
       grid_frequency_l1_topic, grid_frequency_l2_topic, grid_frequency_l3_topic, grid_detection_seconds,
       load_enabled, load_off_delay_seconds,
       load_on_l1, load_on_l2, load_on_l3, load_off_l1, load_off_l2, load_off_l3)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       grid_command_topic=excluded.grid_command_topic, feed_in_command_topic=excluded.feed_in_command_topic,
       temperature_warning_topic=excluded.temperature_warning_topic, temperature_warning_value=excluded.temperature_warning_value,
       warning_text_topic=excluded.warning_text_topic, warning_active_topic=excluded.warning_active_topic,
       soc_enabled=excluded.soc_enabled, voltage_enabled=excluded.voltage_enabled,
       temperature_enabled=excluded.temperature_enabled, feed_in_allowed=excluded.feed_in_allowed,
       soc_lower_offset=excluded.soc_lower_offset, soc_upper_offset=excluded.soc_upper_offset,
       soc_hysteresis=excluded.soc_hysteresis, voltage_hysteresis=excluded.voltage_hysteresis,
       grid_frequency_l1_topic=excluded.grid_frequency_l1_topic,
       grid_frequency_l2_topic=excluded.grid_frequency_l2_topic,
       grid_frequency_l3_topic=excluded.grid_frequency_l3_topic,
       grid_detection_seconds=excluded.grid_detection_seconds, load_enabled=excluded.load_enabled,
       load_off_delay_seconds=excluded.load_off_delay_seconds,
       load_on_l1=excluded.load_on_l1, load_on_l2=excluded.load_on_l2, load_on_l3=excluded.load_on_l3,
       load_off_l1=excluded.load_off_l1, load_off_l2=excluded.load_off_l2, load_off_l3=excluded.load_off_l3`,
    [cfg.gridCommandTopic, cfg.feedInCommandTopic, cfg.temperatureWarningTopic, cfg.temperatureWarningValue,
      cfg.warningTextTopic, cfg.warningActiveTopic, cfg.socEnabled ? 1 : 0, cfg.voltageEnabled ? 1 : 0,
      cfg.temperatureEnabled ? 1 : 0, cfg.feedInAllowed ? 1 : 0, cfg.socLowerOffset, cfg.socUpperOffset,
      cfg.socHysteresis, cfg.voltageHysteresis, cfg.gridFrequencyL1Topic, cfg.gridFrequencyL2Topic,
      cfg.gridFrequencyL3Topic, cfg.gridDetectionSeconds, cfg.loadEnabled ? 1 : 0, cfg.loadOffDelaySeconds,
      cfg.loadOnL1, cfg.loadOnL2, cfg.loadOnL3, cfg.loadOffL1, cfg.loadOffL2, cfg.loadOffL3],
    (err) => {
      if (!err) {
        cachedDb = db;
        cachedConfig = cfg;
      }
      callback(err, cfg);
    }
  );
}

function buildGridControlStateDefinitions(cfg) {
  return [
    { id: STATE_IDS.gridCommand, topic: cfg.gridCommandTopic }, { id: STATE_IDS.feedInCommand, topic: cfg.feedInCommandTopic },
    { id: STATE_IDS.temperatureWarning, topic: cfg.temperatureWarningTopic }, { id: STATE_IDS.warningText, topic: cfg.warningTextTopic },
    { id: STATE_IDS.warningActive, topic: cfg.warningActiveTopic },
    { id: STATE_IDS.gridFrequencyL1, topic: cfg.gridFrequencyL1Topic }, { id: STATE_IDS.gridFrequencyL2, topic: cfg.gridFrequencyL2Topic },
    { id: STATE_IDS.gridFrequencyL3, topic: cfg.gridFrequencyL3Topic },
  ].filter((entry) => entry.topic);
}

function readGridControlBrokerValues(cache) {
  const read = (id) => cache.get(id)?.value ?? null;
  return {
    gridCommand: read(STATE_IDS.gridCommand), feedInCommand: read(STATE_IDS.feedInCommand),
    temperatureWarning: read(STATE_IDS.temperatureWarning), warningText: read(STATE_IDS.warningText),
    warningActive: read(STATE_IDS.warningActive),
    gridFrequencyL1: read(STATE_IDS.gridFrequencyL1), gridFrequencyL2: read(STATE_IDS.gridFrequencyL2),
    gridFrequencyL3: read(STATE_IDS.gridFrequencyL3),
  };
}

module.exports = { loadGridControlConfig, saveGridControlConfig, invalidateGridControlConfig, normalizeGridControlInput, buildGridControlStateDefinitions, readGridControlBrokerValues, STATE_IDS, DEFAULTS };
