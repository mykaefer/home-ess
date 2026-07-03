'use strict';

const mqttClient = require('../mqtt/client');
const { normalizeMqttTopic } = require('../mqtt/topics');
const { normalizePhase } = require('../grid-control/load-shed');

// Cache-Key-Präfix für Pool-Topics im MQTT-Werte-Cache.
function poolCacheKey(topic) {
  return `pool:${normalizeMqttTopic(topic)}`;
}

// Alle konfigurierten Pool-Topics beim MQTT-Client als Ad-hoc-Abonnements registrieren.
function subscribePoolTopics(cfg) {
  const topics = [
    cfg.temperatureTopic,
    cfg.solarPumpStatusTopic,
    cfg.filterPumpStatusTopic,
    cfg.phTopic,
    cfg.chlorTopic,
  ];
  for (const t of topics) {
    if (t) mqttClient.subscribeAdHoc(t, poolCacheKey(t));
  }
}

function rowToConfig(row) {
  return {
    temperatureTopic: row.temperature_topic || '',
    solarPumpStatusTopic: row.solar_pump_status_topic || '',
    solarPumpCommandTopic: row.solar_pump_command_topic || '',
    solarPumpPriority: row.solar_pump_priority != null ? row.solar_pump_priority : 2,
    solarPumpPhase: normalizePhase(row.solar_pump_phase, 'l1'),
    solarPumpMaxTemp: row.solar_pump_max_temp != null ? row.solar_pump_max_temp : '',
    solarPumpTempOnSeconds: row.solar_pump_temp_on_seconds != null ? row.solar_pump_temp_on_seconds : 30,
    solarPumpTempPauseMinutes: row.solar_pump_temp_pause_minutes != null ? row.solar_pump_temp_pause_minutes : 30,
    solarPumpTempUseFilter: !!row.solar_pump_temp_use_filter,
    filterPumpStatusTopic: row.filter_pump_status_topic || '',
    filterPumpCommandTopic: row.filter_pump_command_topic || '',
    filterPumpPriority: row.filter_pump_priority != null ? row.filter_pump_priority : 4,
    filterPumpPhase: normalizePhase(row.filter_pump_phase, 'l1'),
    filterPumpFollowSolar: !!row.filter_pump_follow_solar,
    filterTime1Start: row.filter_time_1_start || '',
    filterTime1End: row.filter_time_1_end || '',
    filterTime2Start: row.filter_time_2_start || '',
    filterTime2End: row.filter_time_2_end || '',
    filterTime3Start: row.filter_time_3_start || '',
    filterTime3End: row.filter_time_3_end || '',
    filterBatteryEnabled: !!row.filter_battery_enabled,
    filterBatterySoc: row.filter_battery_soc != null ? row.filter_battery_soc : 80,
    phTopic: row.ph_topic || '',
    chlorTopic: row.chlor_topic || '',
  };
}

function loadPoolConfig(db, callback) {
  db.get('SELECT * FROM pool_config', (err, row) => {
    callback((err || !row) ? rowToConfig({}) : rowToConfig(row));
  });
}

function savePoolConfig(db, body, callback) {
  const str = (v) => (v || '').toString().trim();
  const int = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const float = (v) => {
    const s = str(v);
    if (!s) return null;
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const cfg = {
    temperatureTopic: str(body.temperatureTopic),
    solarPumpStatusTopic: str(body.solarPumpStatusTopic),
    solarPumpCommandTopic: str(body.solarPumpCommandTopic),
    solarPumpPriority: int(body.solarPumpPriority, 2),
    solarPumpPhase: normalizePhase(body.solarPumpPhase, 'l1'),
    solarPumpMaxTemp: float(body.solarPumpMaxTemp),
    solarPumpTempOnSeconds: int(body.solarPumpTempOnSeconds, 30),
    solarPumpTempPauseMinutes: int(body.solarPumpTempPauseMinutes, 30),
    solarPumpTempUseFilter: body.solarPumpTempUseFilter ? 1 : 0,
    filterPumpStatusTopic: str(body.filterPumpStatusTopic),
    filterPumpCommandTopic: str(body.filterPumpCommandTopic),
    filterPumpPriority: int(body.filterPumpPriority, 4),
    filterPumpPhase: normalizePhase(body.filterPumpPhase, 'l1'),
    filterPumpFollowSolar: body.filterPumpFollowSolar ? 1 : 0,
    filterTime1Start: str(body.filterTime1Start),
    filterTime1End: str(body.filterTime1End),
    filterTime2Start: str(body.filterTime2Start),
    filterTime2End: str(body.filterTime2End),
    filterTime3Start: str(body.filterTime3Start),
    filterTime3End: str(body.filterTime3End),
    filterBatteryEnabled: body.filterBatteryEnabled ? 1 : 0,
    filterBatterySoc: int(body.filterBatterySoc, 80),
    phTopic: str(body.phTopic),
    chlorTopic: str(body.chlorTopic),
  };

  db.run(
    `INSERT INTO pool_config
     (id, temperature_topic,
      solar_pump_status_topic, solar_pump_command_topic, solar_pump_priority, solar_pump_phase, solar_pump_max_temp,
      solar_pump_temp_on_seconds, solar_pump_temp_pause_minutes, solar_pump_temp_use_filter,
      filter_pump_status_topic, filter_pump_command_topic, filter_pump_priority, filter_pump_phase, filter_pump_follow_solar,
     filter_time_1_start, filter_time_1_end, filter_time_2_start, filter_time_2_end,
      filter_time_3_start, filter_time_3_end,
      filter_battery_enabled, filter_battery_soc,
      ph_topic, chlor_topic)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       temperature_topic = excluded.temperature_topic,
       solar_pump_status_topic = excluded.solar_pump_status_topic,
       solar_pump_command_topic = excluded.solar_pump_command_topic,
       solar_pump_priority = excluded.solar_pump_priority,
       solar_pump_phase = excluded.solar_pump_phase,
       solar_pump_max_temp = excluded.solar_pump_max_temp,
       solar_pump_temp_on_seconds = excluded.solar_pump_temp_on_seconds,
       solar_pump_temp_pause_minutes = excluded.solar_pump_temp_pause_minutes,
       solar_pump_temp_use_filter = excluded.solar_pump_temp_use_filter,
       filter_pump_status_topic = excluded.filter_pump_status_topic,
       filter_pump_command_topic = excluded.filter_pump_command_topic,
       filter_pump_priority = excluded.filter_pump_priority,
       filter_pump_phase = excluded.filter_pump_phase,
       filter_pump_follow_solar = excluded.filter_pump_follow_solar,
       filter_time_1_start = excluded.filter_time_1_start,
       filter_time_1_end = excluded.filter_time_1_end,
       filter_time_2_start = excluded.filter_time_2_start,
       filter_time_2_end = excluded.filter_time_2_end,
       filter_time_3_start = excluded.filter_time_3_start,
       filter_time_3_end = excluded.filter_time_3_end,
       filter_battery_enabled = excluded.filter_battery_enabled,
       filter_battery_soc = excluded.filter_battery_soc,
       ph_topic = excluded.ph_topic,
       chlor_topic = excluded.chlor_topic`,
    [
      cfg.temperatureTopic,
      cfg.solarPumpStatusTopic, cfg.solarPumpCommandTopic, cfg.solarPumpPriority, cfg.solarPumpPhase, cfg.solarPumpMaxTemp,
      cfg.solarPumpTempOnSeconds, cfg.solarPumpTempPauseMinutes, cfg.solarPumpTempUseFilter,
      cfg.filterPumpStatusTopic, cfg.filterPumpCommandTopic, cfg.filterPumpPriority, cfg.filterPumpPhase, cfg.filterPumpFollowSolar,
      cfg.filterTime1Start, cfg.filterTime1End, cfg.filterTime2Start, cfg.filterTime2End,
      cfg.filterTime3Start, cfg.filterTime3End,
      cfg.filterBatteryEnabled, cfg.filterBatterySoc,
      cfg.phTopic, cfg.chlorTopic,
    ],
    (err) => {
      if (!err) subscribePoolTopics(cfg);
      callback(err, cfg);
    }
  );
}

// Aktuellen Wert eines Pool-Topics aus dem MQTT-Cache lesen.
function readPoolValue(cache, topic) {
  if (!topic) return null;
  const entry = cache.get(poolCacheKey(topic));
  return entry ? entry.value : null;
}

module.exports = { loadPoolConfig, savePoolConfig, readPoolValue, subscribePoolTopics };
