'use strict';

const { normalizeMqttTopic } = require('../mqtt/topics');

const STATE_IDS = {
  soc: 'batterie.soc',
  power: 'batterie.power',
  voltage: 'batterie.voltage',
  temperatur: 'batterie.temperatur',
  minSoc: 'batterie.minSoc',
  minSocRemote: 'batterie.minSocRemote',
};

const BATTERY_PRESETS = {
  lifepo4: { label: 'LiFePO₄', lowerPerCell: 2.8, upperPerCell: 3.45, nominalPerCell: 3.2 },
  liion: { label: 'Lithium-Ionen (NMC/NCA)', lowerPerCell: 3.0, upperPerCell: 4.1, nominalPerCell: 3.7 },
  leadacid: { label: 'Bleiakku', lowerPerCell: 1.9, upperPerCell: 2.4, nominalPerCell: 2.0 },
  custom: { label: 'Benutzerdefiniert', lowerPerCell: null, upperPerCell: null, nominalPerCell: null },
};

const DEFAULTS = {
  socTopic: '', powerTopic: '', voltageTopic: '', temperaturTopic: '', minSocTopic: '', remoteTopic: '',
  minSoc: 20, capacityAh: 200, batteryType: 'lifepo4', cellCount: 16, lowerVoltage: 44.8, upperVoltage: 55.2,
  chargeEfficiency: 95, dischargeEfficiency: 95,
};
let configCacheDb = null;
let configCache = null;

function clamp(value, min, max, fallback) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function loadBatterieConfig(db, callback) {
  if (configCacheDb === db && configCache) {
    queueMicrotask(() => callback({ ...configCache }));
    return;
  }
  db.get('SELECT * FROM batterie_config WHERE id = 1', (err, row) => {
    const cfg = err || !row ? { ...DEFAULTS } : {
      socTopic: row.soc_topic || '',
      powerTopic: row.power_topic || '',
      voltageTopic: row.voltage_topic || '',
      temperaturTopic: row.temperatur_topic || '',
      minSocTopic: row.min_soc_topic || '',
      remoteTopic: row.remote_topic || '',
      minSoc: row.min_soc == null ? DEFAULTS.minSoc : row.min_soc,
      capacityAh: row.capacity_ah == null ? DEFAULTS.capacityAh : row.capacity_ah,
      batteryType: BATTERY_PRESETS[row.battery_type] ? row.battery_type : DEFAULTS.batteryType,
      cellCount: row.cell_count == null ? DEFAULTS.cellCount : row.cell_count,
      lowerVoltage: row.lower_voltage == null ? DEFAULTS.lowerVoltage : row.lower_voltage,
      upperVoltage: row.upper_voltage == null ? DEFAULTS.upperVoltage : row.upper_voltage,
      chargeEfficiency: clamp(row.charge_efficiency, 50, 100, DEFAULTS.chargeEfficiency),
      dischargeEfficiency: clamp(row.discharge_efficiency, 50, 100, DEFAULTS.dischargeEfficiency),
    };
    configCacheDb = db;
    configCache = cfg;
    callback({ ...cfg });
  });
}

function saveBatterieConfig(db, input, callback) {
  const batteryType = BATTERY_PRESETS[input.batteryType] ? input.batteryType : DEFAULTS.batteryType;
  const cfg = {
    socTopic: normalizeMqttTopic(input.socTopic || ''),
    powerTopic: normalizeMqttTopic(input.powerTopic || ''),
    voltageTopic: normalizeMqttTopic(input.voltageTopic || ''),
    temperaturTopic: normalizeMqttTopic(input.temperaturTopic || ''),
    minSocTopic: normalizeMqttTopic(input.minSocTopic || ''),
    remoteTopic: normalizeMqttTopic(input.remoteTopic || ''),
    minSoc: Math.round(clamp(input.minSoc, 0, 100, DEFAULTS.minSoc) / 5) * 5,
    capacityAh: clamp(input.capacityAh, 0.1, 100000, DEFAULTS.capacityAh),
    batteryType,
    cellCount: Math.round(clamp(input.cellCount, 1, 100, DEFAULTS.cellCount)),
    lowerVoltage: clamp(input.lowerVoltage, 0.1, 1000, DEFAULTS.lowerVoltage),
    upperVoltage: clamp(input.upperVoltage, 0.1, 1000, DEFAULTS.upperVoltage),
    chargeEfficiency: clamp(input.chargeEfficiency, 50, 100, DEFAULTS.chargeEfficiency),
    dischargeEfficiency: clamp(input.dischargeEfficiency, 50, 100, DEFAULTS.dischargeEfficiency),
  };
  if (cfg.lowerVoltage >= cfg.upperVoltage) {
    const error = new Error('Die obere Batteriespannung muss über der unteren liegen.');
    return callback(error, cfg);
  }
  db.run(
    `INSERT INTO batterie_config
      (id, soc_topic, power_topic, voltage_topic, temperatur_topic, min_soc_topic, remote_topic,
       min_soc, capacity_ah, battery_type, cell_count, lower_voltage, upper_voltage,
       charge_efficiency, discharge_efficiency)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       soc_topic=excluded.soc_topic, power_topic=excluded.power_topic,
       voltage_topic=excluded.voltage_topic, temperatur_topic=excluded.temperatur_topic,
       min_soc_topic=excluded.min_soc_topic, remote_topic=excluded.remote_topic,
       min_soc=excluded.min_soc,
       capacity_ah=excluded.capacity_ah,
       battery_type=excluded.battery_type, cell_count=excluded.cell_count,
       lower_voltage=excluded.lower_voltage, upper_voltage=excluded.upper_voltage,
       charge_efficiency=excluded.charge_efficiency,
       discharge_efficiency=excluded.discharge_efficiency`,
    [cfg.socTopic, cfg.powerTopic, cfg.voltageTopic, cfg.temperaturTopic, cfg.minSocTopic, cfg.remoteTopic,
      cfg.minSoc, cfg.capacityAh, cfg.batteryType, cfg.cellCount, cfg.lowerVoltage, cfg.upperVoltage,
      cfg.chargeEfficiency, cfg.dischargeEfficiency],
    (err) => {
      if (!err) { configCacheDb = db; configCache = cfg; }
      callback(err, cfg);
    }
  );
}

function batteryNominalVoltage(config) {
  const preset = BATTERY_PRESETS[config.batteryType] || BATTERY_PRESETS.custom;
  if (preset.nominalPerCell != null) return preset.nominalPerCell * Number(config.cellCount || 0);
  return (Number(config.lowerVoltage) + Number(config.upperVoltage)) / 2;
}

function batteryCapacityKwh(config) {
  const ah = Number(config.capacityAh);
  const voltage = batteryNominalVoltage(config);
  return Number.isFinite(ah) && Number.isFinite(voltage) ? ah * voltage / 1000 : 0;
}

function batteryRemainingKwh(config, soc) {
  if (soc == null || String(soc).trim() === '') return null;
  const parsedSoc = Number(String(soc).replace(',', '.'));
  const capacity = batteryCapacityKwh(config);
  if (!Number.isFinite(parsedSoc) || !Number.isFinite(capacity) || capacity <= 0) return null;
  const boundedSoc = Math.min(100, Math.max(0, parsedSoc));
  return capacity * (100 - boundedSoc) / 100;
}

function batteryUsableStoredKwh(config, soc, minSoc = config.minSoc) {
  if (soc == null || String(soc).trim() === '') return null;
  const parsedSoc = Number(String(soc).replace(',', '.'));
  const parsedMinSoc = Number(String(minSoc == null ? config.minSoc : minSoc).replace(',', '.'));
  const capacity = batteryCapacityKwh(config);
  if (!Number.isFinite(parsedSoc) || !Number.isFinite(parsedMinSoc) || !Number.isFinite(capacity) || capacity <= 0) return null;
  const boundedSoc = Math.min(100, Math.max(0, parsedSoc));
  const boundedMinSoc = Math.min(100, Math.max(0, parsedMinSoc));
  return capacity * Math.max(0, boundedSoc - boundedMinSoc) / 100;
}

function batteryTimeToLimitHours(config, soc, minSoc, powerWatt) {
  if (powerWatt == null || String(powerWatt).trim() === '') return null;
  const power = Number(String(powerWatt).replace(',', '.'));
  if (!Number.isFinite(power) || power === 0) return null;
  const energy = power > 0
    ? batteryRemainingKwh(config, soc)
    : batteryUsableStoredKwh(config, soc, minSoc);
  if (energy == null) return null;
  return energy / (Math.abs(power) / 1000);
}

function batteryStatus(config, data = {}, options = {}) {
  const parse = (value) => {
    if (value == null || String(value).trim() === '') return null;
    const parsed = Number(String(value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const soc = parse(data.soc);
  const power = parse(data.power);
  const dynamicMinSoc = parse(data.minSoc);
  const configuredMinSoc = parse(config.minSoc);
  const minSoc = Math.min(100, Math.max(0, dynamicMinSoc ?? configuredMinSoc ?? 20));
  const halfChargedSoc = minSoc + (100 - minSoc) * 0.5;
  const goodSoc = minSoc + (halfChargedSoc - minSoc) * 0.5;
  const reserveSoc = minSoc + (100 - minSoc) * 0.3;
  return {
    charge: power != null && power > 0,
    discharging: power != null && power < 0,
    empty: soc != null && soc <= minSoc,
    emptySoc: minSoc,
    full: soc != null && soc > 98,
    good: soc != null && soc >= goodSoc,
    halfCharged: soc != null && soc >= halfChargedSoc,
    halfChargedSoc,
    high: soc != null && soc > 90,
    minimalSoc: minSoc,
    overflow: !!options.overflow,
    reserve: soc != null && soc <= reserveSoc,
    reserveSoc,
    chargedToday: !!options.chargedToday,
  };
}

function updateBatteryDailyState(db, dayKey, isFull) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO battery_daily_state (id, day_key, charged_today)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         charged_today = CASE
           WHEN battery_daily_state.day_key = excluded.day_key
             THEN MAX(battery_daily_state.charged_today, excluded.charged_today)
           ELSE excluded.charged_today
         END,
         day_key = excluded.day_key`,
      [dayKey || '', isFull ? 1 : 0],
      (err) => {
        if (err) return reject(err);
        db.get('SELECT charged_today FROM battery_daily_state WHERE id = 1', (readErr, row) => {
          if (readErr) return reject(readErr);
          resolve(!!(row && row.charged_today));
        });
      }
    );
  });
}

function buildBatterieStateDefinitions(cfg) {
  return [
    { id: STATE_IDS.soc, topic: cfg.socTopic },
    { id: STATE_IDS.power, topic: cfg.powerTopic },
    { id: STATE_IDS.voltage, topic: cfg.voltageTopic },
    { id: STATE_IDS.temperatur, topic: cfg.temperaturTopic },
    { id: STATE_IDS.minSoc, topic: cfg.minSocTopic },
    { id: STATE_IDS.minSocRemote, topic: cfg.remoteTopic },
  ].filter((entry) => entry.topic);
}

function readBatterieData(cache) {
  const get = (id) => { const entry = cache.get(id); return entry ? entry.value : null; };
  return {
    soc: get(STATE_IDS.soc), power: get(STATE_IDS.power),
    voltage: get(STATE_IDS.voltage), temperatur: get(STATE_IDS.temperatur),
    minSoc: get(STATE_IDS.minSoc), minSocRemote: get(STATE_IDS.minSocRemote),
  };
}

module.exports = {
  loadBatterieConfig, saveBatterieConfig, buildBatterieStateDefinitions,
  readBatterieData, batteryNominalVoltage, batteryCapacityKwh, batteryRemainingKwh,
  batteryUsableStoredKwh, batteryTimeToLimitHours,
  batteryStatus, updateBatteryDailyState,
  STATE_IDS, DEFAULTS, BATTERY_PRESETS,
};
