'use strict';

const { loadPoolConfig, readPoolValue } = require('./config');
const { isEnabled } = require('../modules');

const MAX_SAMPLES = 21;

function parseOn(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseSamples(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch (_) { return []; }
}

function readState(db) {
  return new Promise((resolve) => db.get('SELECT * FROM pool_energy_state WHERE id = 1', (err, row) => resolve(err ? null : row)));
}

function writeState(db, state) {
  return new Promise((resolve) => db.run(
    `INSERT INTO pool_energy_state
      (id, solar_power_w, filter_power_w, solar_samples, filter_samples,
       last_house_power_w, last_solar_on, last_filter_on, last_sample_ts,
       day_kwh, year_kwh, previous_year_kwh, day_key, year_key, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       solar_power_w=excluded.solar_power_w, filter_power_w=excluded.filter_power_w,
       solar_samples=excluded.solar_samples, filter_samples=excluded.filter_samples,
       last_house_power_w=excluded.last_house_power_w,
       last_solar_on=excluded.last_solar_on, last_filter_on=excluded.last_filter_on,
       last_sample_ts=excluded.last_sample_ts, day_kwh=excluded.day_kwh,
       year_kwh=excluded.year_kwh, previous_year_kwh=excluded.previous_year_kwh,
       day_key=excluded.day_key, year_key=excluded.year_key,
       updated_at=excluded.updated_at`,
    [state.solarPowerW, state.filterPowerW, JSON.stringify(state.solarSamples),
      JSON.stringify(state.filterSamples), state.housePowerW,
      state.solarOn ? 1 : 0, state.filterOn ? 1 : 0, state.now,
      state.dayKwh, state.yearKwh, state.previousYearKwh, state.dayKey, state.yearKey, state.now],
    () => resolve()
  ));
}

async function updatePoolEnergyModel(db, cache, housePowerW) {
  if (!isEnabled('pool') || !Number.isFinite(Number(housePowerW))) return { solarPowerW: 0, filterPowerW: 0, currentPowerW: 0 };
  const cfg = await new Promise((resolve) => loadPoolConfig(db, resolve));
  const solarOn = parseOn(readPoolValue(cache, cfg.solarPumpStatusTopic));
  const filterOn = parseOn(readPoolValue(cache, cfg.filterPumpStatusTopic));
  const row = await readState(db);
  const solarSamples = parseSamples(row && row.solar_samples);
  const filterSamples = parseSamples(row && row.filter_samples);
  const previousPower = row == null ? null : Number(row.last_house_power_w);
  const previousSolar = row == null ? solarOn : !!row.last_solar_on;
  const previousFilter = row == null ? filterOn : !!row.last_filter_on;
  const solarChanged = previousSolar !== solarOn;
  const filterChanged = previousFilter !== filterOn;
  if (Number.isFinite(previousPower) && solarChanged !== filterChanged) {
    const turnedOn = solarChanged ? solarOn : filterOn;
    const estimate = turnedOn ? Number(housePowerW) - previousPower : previousPower - Number(housePowerW);
    if (estimate >= 20 && estimate <= 5000) {
      const samples = solarChanged ? solarSamples : filterSamples;
      samples.push(estimate);
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    }
  }
  const now = Date.now();
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const yearKey = dayKey.slice(0, 4);
  let dayKwh = row && row.day_key === dayKey ? Number(row.day_kwh) || 0 : 0;
  let yearKwh = row && row.year_key === yearKey ? Number(row.year_kwh) || 0 : 0;
  let previousYearKwh = Number(row && row.previous_year_kwh) || 0;
  if (row && row.year_key && row.year_key !== yearKey) previousYearKwh = Number(row.year_kwh) || 0;
  const age = row ? now - Number(row.last_sample_ts || 0) : 0;
  if (age > 0 && age <= 5 * 60 * 1000) {
    const previousPumpPower = (previousSolar ? Number(row.solar_power_w) || 0 : 0) +
      (previousFilter ? Number(row.filter_power_w) || 0 : 0);
    const deltaKwh = previousPumpPower * age / 3600000000;
    dayKwh += deltaKwh;
    yearKwh += deltaKwh;
  }
  const state = {
    solarSamples, filterSamples,
    solarPowerW: median(solarSamples) || Number(row && row.solar_power_w) || 0,
    filterPowerW: median(filterSamples) || Number(row && row.filter_power_w) || 0,
    housePowerW: Number(housePowerW), solarOn, filterOn, now,
    dayKwh, yearKwh, previousYearKwh, dayKey, yearKey,
  };
  await writeState(db, state);
  return { ...state, currentPowerW: (solarOn ? state.solarPowerW : 0) + (filterOn ? state.filterPowerW : 0) };
}

async function loadPoolEnergyModel(db) {
  if (!isEnabled('pool')) return { enabled: false, solarPowerW: 0, filterPowerW: 0 };
  const [cfg, row] = await Promise.all([
    new Promise((resolve) => loadPoolConfig(db, resolve)), readState(db),
  ]);
  return {
    enabled: true, config: cfg,
    solarPowerW: Number(row && row.solar_power_w) || 0,
    filterPowerW: Number(row && row.filter_power_w) || 0,
    yearKwh: Number(row && row.year_kwh) || 0,
    previousYearKwh: Number(row && row.previous_year_kwh) || 0,
  };
}

function minutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function windowOverlapHours(start, end, hour) {
  const s = minutes(start); const e = minutes(end);
  if (s == null || e == null || s === e) return 0;
  const from = hour * 60; const to = from + 60;
  const ranges = s < e ? [[s, e]] : [[s, 1440], [0, e]];
  return ranges.reduce((sum, range) => sum + Math.max(0, Math.min(to, range[1]) - Math.max(from, range[0])), 0) / 60;
}

function poolLoadForHour(model, forecast, dateKey, hour, durationHours = 1, batterySoc = null) {
  if (!model || !model.enabled) return { totalKwh: 0, solarKwh: 0, filterKwh: 0 };
  const cfg = model.config || {};
  const pvKwh = forecast && Array.isArray(forecast.hours)
    ? forecast.hours.filter((slot) => slot.dateKey === dateKey && Number(slot.hour) === hour)
      .reduce((sum, slot) => sum + (Number(slot.kwh) || 0), 0)
    : 0;
  const solarHours = pvKwh > 0.02 ? durationHours : 0;
  let filterHours = cfg.filterPumpFollowSolar ? solarHours : Math.min(durationHours,
    [
      [cfg.filterTime1Start, cfg.filterTime1End],
      [cfg.filterTime2Start, cfg.filterTime2End],
      [cfg.filterTime3Start, cfg.filterTime3End],
    ].reduce((sum, window) => sum + windowOverlapHours(window[0], window[1], hour), 0));
  if (cfg.filterBatteryEnabled && (batterySoc == null || Number(batterySoc) >= Number(cfg.filterBatterySoc || 80))) {
    filterHours = durationHours;
  }
  const solarKwh = model.solarPowerW / 1000 * solarHours;
  const filterKwh = model.filterPowerW / 1000 * filterHours;
  return { totalKwh: solarKwh + filterKwh, solarKwh, filterKwh };
}

module.exports = { updatePoolEnergyModel, loadPoolEnergyModel, poolLoadForHour, windowOverlapHours, median };
