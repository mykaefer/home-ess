'use strict';

const { normalizeMqttTopic } = require('../mqtt/topics');
const { CONVERTER_TYPE_OPTIONS } = require('./converters');

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

// Standard-Sonnenreferenz-Cutoff je Anlage (Prozent der Nennleistung): Eine Anlage
// zählt nur dann als Sonnenreferenz, wenn ihr Klarhimmel-Idealwert mindestens diesen
// Anteil ihrer kWp-Spitzenleistung erreicht – die Sonne also brauchbar auf ihre
// Ebene scheint. Getrennt für morgens/abends, da der Sonnenstand seitenabhängig wirkt.
const DEFAULT_SUN_CUTOFF_PERCENT = 10;

function parseCutoffPercent(value) {
  const parsed = parseNumber(value);
  if (parsed == null) return DEFAULT_SUN_CUTOFF_PERCENT;
  return Math.max(0, Math.min(100, parsed));
}

const CELL_TYPE_OPTIONS = [
  'Monokristallin',
  'Polykristallin',
  'Duennschicht',
  'Bifazial',
  'TOPCon',
  'HJT',
  'PERC',
  'Sonstiges',
];

// Zelltypische Vorgabe-Wirkungsgrade (%) – ausschließlich Startwert für das
// Wirkungsgrad-Feld bei Auswahl des Zelltyps. Sie gehen NICHT direkt ins
// Clear-Sky-Modell ein, sondern nur indirekt über das (frei feinkalibrierbare)
// Wirkungsgrad-Feld.
const CELL_TYPE_DEFAULT_EFFICIENCY = {
  Monokristallin: 90,
  Polykristallin: 85,
  Duennschicht: 80,
  Bifazial: 92,
  TOPCon: 91,
  HJT: 92,
  PERC: 90,
  Sonstiges: 88,
};

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function normalizePlantRow(row = {}) {
  return {
    id: row.id,
    name: row.name || '',
    kwPeak: parseNumber(row.kw_peak),
    efficiency: parseNumber(row.efficiency),
    orientation: row.orientation || '',
    tilt: parseNumber(row.tilt),
    isConsumerSide: Boolean(row.is_consumer_side),
    cellType: row.cell_type || '',
    converterType: row.converter_type || 'Direkt',
    powerTopic: row.power_topic || '',
    todayYieldTopic: row.today_yield_topic || '',
    autoCalibrate: Boolean(row.auto_calibrate),
    sunCutoffMorning: parseCutoffPercent(row.sun_cutoff_morning),
    sunCutoffEvening: parseCutoffPercent(row.sun_cutoff_evening),
  };
}

const plantListCache = new WeakMap();
function invalidatePvPlants(db) { if (db) plantListCache.delete(db); }

async function listPvPlants(db) {
  const cached = plantListCache.get(db);
  if (cached) return cached;
  const rows = await dbAll(
    db,
    `SELECT id, name, kw_peak, efficiency, orientation, tilt, is_consumer_side, cell_type,
            converter_type, power_topic, today_yield_topic, auto_calibrate,
            sun_cutoff_morning, sun_cutoff_evening
     FROM pv_plants
     ORDER BY id ASC`
  );
  const plants = rows.map(normalizePlantRow);
  plantListCache.set(db, plants);
  return plants;
}

async function getPvPlant(db, id) {
  const row = await dbGet(
    db,
    `SELECT id, name, kw_peak, efficiency, orientation, tilt, is_consumer_side, cell_type,
            converter_type, power_topic, today_yield_topic, auto_calibrate,
            sun_cutoff_morning, sun_cutoff_evening
     FROM pv_plants
     WHERE id = ?`,
    [id]
  );
  return row ? normalizePlantRow(row) : null;
}

function parseCheckbox(value) {
  return value === 'on' || value === 'true' || value === '1';
}

function normalizePlantInput(input = {}) {
  return {
    name: String(input.name || '').trim(),
    kwPeak: parseNumber(input.kwPeak),
    efficiency: parseNumber(input.efficiency),
    orientation: String(input.orientation || '').trim(),
    tilt: parseNumber(input.tilt),
    isConsumerSide: parseCheckbox(input.isConsumerSide),
    cellType: String(input.cellType || '').trim(),
    converterType: String(input.converterType || '').trim(),
    powerTopic: normalizeMqttTopic(input.powerTopic || ''),
    todayYieldTopic: normalizeMqttTopic(input.todayYieldTopic || ''),
    autoCalibrate: parseCheckbox(input.autoCalibrate),
    sunCutoffMorning: parseCutoffPercent(input.sunCutoffMorning),
    sunCutoffEvening: parseCutoffPercent(input.sunCutoffEvening),
  };
}

function validatePlantInput(input) {
  const errors = [];
  if (!input.name) errors.push('Bitte einen Namen fuer die PV-Anlage eingeben.');
  if (input.kwPeak == null) errors.push('Bitte kW-Peak angeben.');
  if (input.efficiency == null) errors.push('Bitte den Wirkungsgrad angeben.');
  if (input.orientation === '' || input.orientation == null) {
    errors.push('Bitte die Ausrichtung in Grad angeben.');
  } else if (parseNumber(input.orientation) == null) {
    errors.push('Bitte eine gueltige Ausrichtung in Grad angeben.');
  }
  if (input.tilt == null) errors.push('Bitte die Neigung angeben.');
  if (!input.cellType) errors.push('Bitte einen Zelltyp auswaehlen.');
  if (!input.converterType) {
    errors.push('Bitte den Konverter-/Reglertyp auswaehlen.');
  } else if (!CONVERTER_TYPE_OPTIONS.some((option) => option.value === input.converterType)) {
    errors.push('Bitte einen gueltigen Konverter-/Reglertyp auswaehlen.');
  }
  return errors;
}

async function createPvPlant(db, input) {
  const plant = normalizePlantInput(input);
  const errors = validatePlantInput(plant);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validation = true;
    throw error;
  }

  const result = await dbRun(
    db,
    `INSERT INTO pv_plants
     (name, kw_peak, efficiency, orientation, tilt, is_consumer_side, cell_type, converter_type, power_topic, today_yield_topic, auto_calibrate, sun_cutoff_morning, sun_cutoff_evening)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      plant.name,
      plant.kwPeak,
      plant.efficiency,
      plant.orientation,
      plant.tilt,
      plant.isConsumerSide ? 1 : 0,
      plant.cellType,
      plant.converterType,
      plant.powerTopic,
      plant.todayYieldTopic,
      plant.autoCalibrate ? 1 : 0,
      plant.sunCutoffMorning,
      plant.sunCutoffEvening,
    ]
  );

  await dbRun(
    db,
    `INSERT INTO pv_aggregation
     (plant_id, week_offset, total_offset, last_today_value, last_rollover_date, week_key)
     VALUES (?, 0, 0, 0, '', '')`,
    [result.lastID]
  );
  invalidatePvPlants(db);
  return getPvPlant(db, result.lastID);
}

async function updatePvPlant(db, id, input) {
  const plant = normalizePlantInput(input);
  const errors = validatePlantInput(plant);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validation = true;
    throw error;
  }

  // Vor dem Schreiben den bisherigen Stand laden, um eine Geometrie-/Leistungs-
  // änderung zu erkennen.
  const existing = await getPvPlant(db, id);

  await dbRun(
    db,
    `UPDATE pv_plants
     SET name = ?, kw_peak = ?, efficiency = ?, orientation = ?, tilt = ?, is_consumer_side = ?,
         cell_type = ?, converter_type = ?, power_topic = ?, today_yield_topic = ?, auto_calibrate = ?,
         sun_cutoff_morning = ?, sun_cutoff_evening = ?
     WHERE id = ?`,
    [
      plant.name,
      plant.kwPeak,
      plant.efficiency,
      plant.orientation,
      plant.tilt,
      plant.isConsumerSide ? 1 : 0,
      plant.cellType,
      plant.converterType,
      plant.powerTopic,
      plant.todayYieldTopic,
      plant.autoCalibrate ? 1 : 0,
      plant.sunCutoffMorning,
      plant.sunCutoffEvening,
      id,
    ]
  );

  // Ändert sich die Ausrichtung oder die Gesamtleistung (kW-Peak), passt das
  // gelernte Kalibriermodell nicht mehr zur Geometrie/Skalierung der Anlage —
  // die hinterlegten Buckets werden daher verworfen und neu gelernt.
  if (existing) {
    const orientationChanged = parseNumber(existing.orientation) !== parseNumber(plant.orientation);
    const kwPeakChanged = existing.kwPeak !== plant.kwPeak;
    if (orientationChanged || kwPeakChanged) {
      await dbRun(db, 'DELETE FROM pv_calibration_buckets WHERE plant_id = ?', [id]);
    }
  }
  invalidatePvPlants(db);
  return getPvPlant(db, id);
}

async function deletePvPlant(db, id) {
  await dbRun(db, 'DELETE FROM pv_aggregation WHERE plant_id = ?', [id]);
  await dbRun(db, 'DELETE FROM pv_calibration_buckets WHERE plant_id = ?', [id]);
  await dbRun(db, 'DELETE FROM pv_plants WHERE id = ?', [id]);
  invalidatePvPlants(db);
}

function buildPhotovoltaikStateDefinitions(plants) {
  const defs = [];
  for (const plant of plants || []) {
    if (plant.powerTopic) defs.push({ id: `pv:${plant.id}:power`, topic: plant.powerTopic });
    if (plant.todayYieldTopic) defs.push({ id: `pv:${plant.id}:today`, topic: plant.todayYieldTopic });
  }
  return defs;
}

module.exports = {
  CELL_TYPE_OPTIONS,
  CELL_TYPE_DEFAULT_EFFICIENCY,
  DEFAULT_SUN_CUTOFF_PERCENT,
  CONVERTER_TYPE_OPTIONS,
  listPvPlants,
  invalidatePvPlants,
  getPvPlant,
  createPvPlant,
  updatePvPlant,
  deletePvPlant,
  normalizePlantInput,
  buildPhotovoltaikStateDefinitions,
};
