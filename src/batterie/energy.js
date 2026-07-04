'use strict';

// Kumulierte Lade-/Entladeenergie des Hausakkus per Leistungsintegration
// (Vorbild: wallbox/aggregation.js's Power-Fallback, da der Akku i.d.R. keinen
// eigenen Energiezähler hat, nur eine Leistungsmessung).
//
// Grund: Eigenverbrauch (PV + Import - Export) enthält physikalisch auch die
// Akkuladung – die Energie steckt an dem Tag im Akku, nicht im Haus. Erst beim
// späteren Entladen "erscheint" sie wieder im tatsächlichen Verbrauch, ohne
// dass sie beim Entladen zusätzlich vom Eigenverbrauch abgezogen wird. Auf
// lange Sicht (Akku-SoC am Jahresende ≈ Jahresanfang) gleicht sich das aus,
// aber solange der Akku noch nicht "eingeschwungen" ist (z. B. kurz nach
// Inbetriebnahme), bleibt eine Netto-Ladung als Verzerrung im Jahreswert
// stehen. Dieses Modul verfolgt Netto-Ladung/-Entladung separat, damit die
// Prognosebasis (buildConsumptionModel) den Jahres-Eigenverbrauch analog zur
// Wallbox-Energie bereinigen kann.

const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { loadBatterieConfig, readBatterieData } = require('./config');

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

// Nur kurze, plausible Intervalle integrieren (kein Riesensprung nach einem
// Neustart, analog recordConsumptionSample/deriveCumulativeKwh).
const MAX_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_STATE = {
  lastPowerTs: null, dayChargeKwh: 0, dayDischargeKwh: 0,
  weekChargeOffset: 0, weekDischargeOffset: 0,
  monthChargeOffset: 0, monthDischargeOffset: 0,
  yearChargeOffset: 0, yearDischargeOffset: 0,
  previousYearChargeTotal: 0, previousYearDischargeTotal: 0,
  lastRolloverDate: '', weekKey: '', monthKey: '', yearKey: '',
};

function normalizeState(row) {
  if (!row) return { ...DEFAULT_STATE };
  return {
    lastPowerTs: parseNumber(row.last_power_ts),
    dayChargeKwh: parseNumber(row.day_charge_kwh) || 0,
    dayDischargeKwh: parseNumber(row.day_discharge_kwh) || 0,
    weekChargeOffset: parseNumber(row.week_charge_offset) || 0,
    weekDischargeOffset: parseNumber(row.week_discharge_offset) || 0,
    monthChargeOffset: parseNumber(row.month_charge_offset) || 0,
    monthDischargeOffset: parseNumber(row.month_discharge_offset) || 0,
    yearChargeOffset: parseNumber(row.year_charge_offset) || 0,
    yearDischargeOffset: parseNumber(row.year_discharge_offset) || 0,
    previousYearChargeTotal: parseNumber(row.previous_year_charge_total) || 0,
    previousYearDischargeTotal: parseNumber(row.previous_year_discharge_total) || 0,
    lastRolloverDate: row.last_rollover_date || '',
    weekKey: row.week_key || '',
    monthKey: row.month_key || '',
    yearKey: row.year_key || '',
  };
}

async function loadState(db) {
  return normalizeState(await dbGet(db, 'SELECT * FROM battery_energy_state WHERE id = 1'));
}

async function saveState(db, state) {
  await dbRun(
    db,
    `INSERT INTO battery_energy_state
      (id, last_power_ts, day_charge_kwh, day_discharge_kwh,
       week_charge_offset, week_discharge_offset,
       month_charge_offset, month_discharge_offset,
       year_charge_offset, year_discharge_offset,
       previous_year_charge_total, previous_year_discharge_total,
       last_rollover_date, week_key, month_key, year_key)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_power_ts=excluded.last_power_ts,
       day_charge_kwh=excluded.day_charge_kwh, day_discharge_kwh=excluded.day_discharge_kwh,
       week_charge_offset=excluded.week_charge_offset, week_discharge_offset=excluded.week_discharge_offset,
       month_charge_offset=excluded.month_charge_offset, month_discharge_offset=excluded.month_discharge_offset,
       year_charge_offset=excluded.year_charge_offset, year_discharge_offset=excluded.year_discharge_offset,
       previous_year_charge_total=excluded.previous_year_charge_total,
       previous_year_discharge_total=excluded.previous_year_discharge_total,
       last_rollover_date=excluded.last_rollover_date, week_key=excluded.week_key,
       month_key=excluded.month_key, year_key=excluded.year_key`,
    [state.lastPowerTs, state.dayChargeKwh, state.dayDischargeKwh,
      state.weekChargeOffset, state.weekDischargeOffset,
      state.monthChargeOffset, state.monthDischargeOffset,
      state.yearChargeOffset, state.yearDischargeOffset,
      state.previousYearChargeTotal, state.previousYearDischargeTotal,
      state.lastRolloverDate, state.weekKey, state.monthKey, state.yearKey]
  );
}

// Einen Messpunkt fortschreiben: Tageszähler integrieren, bei Tageswechsel den
// Vortag in Woche/Monat/Jahr überführen (analog wallbox/aggregation.js).
async function updateBatteryEnergyCounter(db, power, calendar, now) {
  const state = await loadState(db);
  const dayKey = calendar.dateKey;
  let previousDayCharge = 0;
  let previousDayDischarge = 0;

  if (state.lastRolloverDate && state.lastRolloverDate !== dayKey) {
    previousDayCharge = state.dayChargeKwh;
    previousDayDischarge = state.dayDischargeKwh;
    state.dayChargeKwh = 0;
    state.dayDischargeKwh = 0;
  }

  const lastTs = state.lastPowerTs;
  if (power != null && lastTs != null && now > lastTs && now - lastTs <= MAX_INTERVAL_MS) {
    const hours = (now - lastTs) / 3600000;
    if (power > 0) state.dayChargeKwh += power * hours / 1000;
    else if (power < 0) state.dayDischargeKwh += Math.abs(power) * hours / 1000;
  }
  state.lastPowerTs = now;

  const { weekKey, monthKey, yearKey } = calendar;
  if (!state.lastRolloverDate) {
    state.lastRolloverDate = dayKey;
    state.weekKey = weekKey;
    state.monthKey = monthKey;
    state.yearKey = yearKey;
  } else if (state.lastRolloverDate !== dayKey) {
    state.weekChargeOffset = state.weekKey === weekKey ? state.weekChargeOffset + previousDayCharge : 0;
    state.weekDischargeOffset = state.weekKey === weekKey ? state.weekDischargeOffset + previousDayDischarge : 0;
    state.monthChargeOffset = state.monthKey === monthKey ? state.monthChargeOffset + previousDayCharge : 0;
    state.monthDischargeOffset = state.monthKey === monthKey ? state.monthDischargeOffset + previousDayDischarge : 0;
    if (state.yearKey === yearKey) {
      state.yearChargeOffset += previousDayCharge;
      state.yearDischargeOffset += previousDayDischarge;
    } else {
      state.previousYearChargeTotal = state.yearChargeOffset + previousDayCharge;
      state.previousYearDischargeTotal = state.yearDischargeOffset + previousDayDischarge;
      state.yearChargeOffset = 0;
      state.yearDischargeOffset = 0;
    }
    state.lastRolloverDate = dayKey;
    state.weekKey = weekKey;
    state.monthKey = monthKey;
    state.yearKey = yearKey;
  }

  await saveState(db, state);
  return state;
}

// Schreibende Fortschreibung – läuft im 60-Sekunden-Job (analog updateWallbox).
async function updateBatteryEnergy(db, cache, now = Date.now()) {
  const batteryConfig = await new Promise((resolve) => loadBatterieConfig(db, resolve));
  if (!batteryConfig.powerTopic) return null;
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date(now));
  const power = parseNumber(readBatterieData(cache).power);
  return updateBatteryEnergyCounter(db, power, calendar, now);
}

// Schreibfreier Lesezugriff für die Prognosebasis: Netto-Ladung (Laden minus
// Entladen) für dieses und das vorherige Jahr.
async function readBatteryEnergyValues(db) {
  const state = await loadState(db);
  const weekCharge = state.weekChargeOffset + state.dayChargeKwh;
  const weekDischarge = state.weekDischargeOffset + state.dayDischargeKwh;
  const monthCharge = state.monthChargeOffset + state.dayChargeKwh;
  const monthDischarge = state.monthDischargeOffset + state.dayDischargeKwh;
  const yearCharge = state.yearChargeOffset + state.dayChargeKwh;
  const yearDischarge = state.yearDischargeOffset + state.dayDischargeKwh;
  return {
    today: {
      charge: state.dayChargeKwh,
      discharge: state.dayDischargeKwh,
      netCharge: state.dayChargeKwh - state.dayDischargeKwh,
    },
    week: { charge: weekCharge, discharge: weekDischarge, netCharge: weekCharge - weekDischarge },
    month: { charge: monthCharge, discharge: monthDischarge, netCharge: monthCharge - monthDischarge },
    year: { charge: yearCharge, discharge: yearDischarge, netCharge: yearCharge - yearDischarge },
    previousYear: {
      charge: state.previousYearChargeTotal,
      discharge: state.previousYearDischargeTotal,
      netCharge: state.previousYearChargeTotal - state.previousYearDischargeTotal,
    },
  };
}

module.exports = {
  updateBatteryEnergy, updateBatteryEnergyCounter, readBatteryEnergyValues, loadState,
};
