'use strict';

// Zähler- und Summenfortschreibung je Wallbox (Vorbild: stromverbrauch/aggregation.js),
// erweitert um Monatszähler und einen Power-Integrations-Fallback, wenn kein
// Zähler-Topic gesetzt ist. Liefert außerdem die SoC-Schätzung aus geladener Energie
// und schreibfreie Live-Werte (readWallboxValues).

const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { listWallboxes, cacheKey } = require('./boxes');

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function getCacheNumber(cache, key) {
  const entry = cache.get(key);
  return entry ? parseNumber(entry.value) : null;
}

// Leistung des Zähler-Topics in kWh, der Leistung in W normalisieren.
function powerToWatt(value, unit) {
  if (value == null) return null;
  return unit === 'kW' ? value * 1000 : value;
}
function counterToKwh(value, unit) {
  if (value == null) return null;
  return unit === 'Wh' ? value / 1000 : value;
}

function formatEnergy(value) {
  if (value == null) return '— kWh';
  return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} kWh`;
}
function formatPower(value) {
  if (value == null) return '— W';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value)} W`;
}
function formatPercent(value) {
  if (value == null) return '— %';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value)} %`;
}

function normalizeCounterRow(row = {}) {
  return {
    lastRawValue: parseNumber(row.last_raw_value),
    dayTotal: parseNumber(row.day_total) || 0,
    lastDayKey: row.last_day_key || '',
    pluggedEnergyStart: parseNumber(row.plugged_energy_start),
    lastPowerTs: parseNumber(row.last_power_ts),
  };
}

function normalizeSummaryRow(row = {}) {
  return {
    weekOffset: parseNumber(row.week_offset) || 0,
    monthOffset: parseNumber(row.month_offset) || 0,
    yearOffset: parseNumber(row.year_offset) || 0,
    previousYearTotal: parseNumber(row.previous_year_total) || 0,
    lastRolloverDate: row.last_rollover_date || '',
    weekKey: row.week_key || '',
    monthKey: row.month_key || '',
    yearKey: row.year_key || '',
  };
}

async function loadCounterState(db, id) {
  const row = await dbGet(db, 'SELECT * FROM wallbox_counter_state WHERE wallbox_id = ?', [id]);
  return normalizeCounterRow(row || {});
}

async function saveCounterState(db, id, state) {
  await dbRun(
    db,
    `INSERT INTO wallbox_counter_state
      (wallbox_id, last_raw_value, day_total, last_day_key, plugged_energy_start, last_power_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallbox_id) DO UPDATE SET
       last_raw_value = excluded.last_raw_value,
       day_total = excluded.day_total,
       last_day_key = excluded.last_day_key,
       plugged_energy_start = excluded.plugged_energy_start,
       last_power_ts = excluded.last_power_ts`,
    [id, state.lastRawValue, state.dayTotal, state.lastDayKey, state.pluggedEnergyStart, state.lastPowerTs]
  );
}

async function loadSummaryState(db, id) {
  const row = await dbGet(db, 'SELECT * FROM wallbox_summary_state WHERE wallbox_id = ?', [id]);
  return normalizeSummaryRow(row || {});
}

async function saveSummaryState(db, id, state) {
  await dbRun(
    db,
    `INSERT INTO wallbox_summary_state
      (wallbox_id, week_offset, month_offset, year_offset, previous_year_total,
       last_rollover_date, week_key, month_key, year_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallbox_id) DO UPDATE SET
       week_offset = excluded.week_offset, month_offset = excluded.month_offset,
       year_offset = excluded.year_offset, previous_year_total = excluded.previous_year_total,
       last_rollover_date = excluded.last_rollover_date, week_key = excluded.week_key,
       month_key = excluded.month_key, year_key = excluded.year_key`,
    [id, state.weekOffset, state.monthOffset, state.yearOffset, state.previousYearTotal,
      state.lastRolloverDate, state.weekKey, state.monthKey, state.yearKey]
  );
}

// Aktuelle kumulierte Energie (kWh) einer Box: aus Zähler-Topic oder per
// Power-Integration in last_raw_value. Liefert den neuen kumulierten Wert und den
// neuen last_power_ts. rawKwh bleibt null, wenn weder Zähler noch Leistung vorliegen.
function deriveCumulativeKwh(cache, box, state, now) {
  if (box.counterTopic) {
    const raw = counterToKwh(getCacheNumber(cache, cacheKey(box.id, 'counter')), box.counterUnit);
    return { rawKwh: raw, lastPowerTs: now };
  }
  if (box.powerTopic) {
    const watt = powerToWatt(getCacheNumber(cache, cacheKey(box.id, 'power')), box.powerUnit);
    if (watt == null) return { rawKwh: state.lastRawValue, lastPowerTs: now };
    const base = state.lastRawValue || 0;
    const lastTs = state.lastPowerTs;
    // Nur kurze, plausible Intervalle integrieren (kein Riesensprung nach Neustart).
    if (lastTs != null && now > lastTs && now - lastTs <= 5 * 60 * 1000) {
      const added = Math.max(0, watt) * (now - lastTs) / 3600000000; // W·ms → kWh
      return { rawKwh: base + added, lastPowerTs: now };
    }
    return { rawKwh: base, lastPowerTs: now };
  }
  return { rawKwh: null, lastPowerTs: state.lastPowerTs };
}

// Eine Wallbox fortschreiben: Tageszähler aktualisieren, plugged-Energiebasis für die
// SoC-Schätzung pflegen, Vortagswert für den Summen-Rollover zurückgeben.
async function updateWallboxCounter(db, cache, box, calendar, now) {
  const dayKey = calendar.dateKey;
  const state = await loadCounterState(db, box.id);
  let previousDayTotal = 0;
  const previousSampleTs = state.lastPowerTs;
  let energyDelta = 0;

  if (state.lastDayKey && state.lastDayKey !== dayKey) {
    previousDayTotal = state.dayTotal || 0;
    state.dayTotal = 0;
    state.lastDayKey = dayKey;
  } else if (!state.lastDayKey) {
    state.lastDayKey = dayKey;
  }

  const { rawKwh, lastPowerTs } = deriveCumulativeKwh(cache, box, state, now);
  state.lastPowerTs = lastPowerTs;
  if (rawKwh != null) {
    if (state.lastRawValue == null) {
      state.lastRawValue = rawKwh;
    } else {
      // Fortlaufender Zähler: Differenz fortzählen, Reset (kleinerer Wert) abfangen.
      energyDelta = rawKwh >= state.lastRawValue ? rawKwh - state.lastRawValue : 0;
      if (energyDelta > 0) state.dayTotal += energyDelta;
      state.lastRawValue = rawKwh;
    }
  }

  // SoC-Schätzbasis: bei frischem Einstecken den aktuellen Zählerstand merken,
  // beim Abstecken verwerfen.
  const plugged = box.pluggedTopic ? parseBool((cache.get(cacheKey(box.id, 'plugged')) || {}).value) : null;
  if (plugged === true) {
    if (state.pluggedEnergyStart == null && state.lastRawValue != null) {
      state.pluggedEnergyStart = state.lastRawValue;
    }
  } else if (plugged === false) {
    state.pluggedEnergyStart = null;
  }

  await saveCounterState(db, box.id, state);
  const age = previousSampleTs == null ? null : now - previousSampleTs;
  const plausibleMax = age && age > 0
    ? Math.max(0.02, Number(box.maxPowerW || 0) * age / 3600000000 * 1.5)
    : 0;
  const hourlyDelta = age != null && age <= 5 * 60 * 1000 && energyDelta <= plausibleMax
    ? energyDelta
    : 0;
  return { previousDayTotal, state, energyDelta, hourlyDelta };
}

async function recordWallboxHistory(db, box, calendar, state, hourlyDelta, now) {
  await dbRun(
    db,
    `INSERT INTO wallbox_daily_consumption
      (wallbox_id, day_key, consumption_kwh, completed, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(wallbox_id, day_key) DO UPDATE SET
       consumption_kwh = excluded.consumption_kwh,
       completed = 0,
       updated_at = excluded.updated_at`,
    [box.id, calendar.dateKey, state.dayTotal || 0, now]
  );
  if (hourlyDelta > 0) {
    await dbRun(
      db,
      `INSERT INTO wallbox_hourly_consumption (wallbox_id, day_key, hour, consumption_kwh)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallbox_id, day_key, hour) DO UPDATE SET
         consumption_kwh = wallbox_hourly_consumption.consumption_kwh + excluded.consumption_kwh`,
      [box.id, calendar.dateKey, Number(calendar.hours) || 0, hourlyDelta]
    );
  }
  await dbRun(
    db,
    'UPDATE wallbox_daily_consumption SET completed = 1 WHERE wallbox_id = ? AND day_key <> ? AND completed = 0',
    [box.id, calendar.dateKey]
  );
  await dbRun(db, "DELETE FROM wallbox_daily_consumption WHERE day_key < date(?, '-400 days')", [calendar.dateKey]);
  await dbRun(db, "DELETE FROM wallbox_hourly_consumption WHERE day_key < date(?, '-90 days')", [calendar.dateKey]);
}

async function updateWallboxSummary(db, box, previousDayTotal, calendar) {
  const state = await loadSummaryState(db, box.id);
  const { dateKey: dayKey, weekKey, monthKey, yearKey } = calendar;

  if (!state.lastRolloverDate) {
    state.lastRolloverDate = dayKey;
    state.weekKey = weekKey;
    state.monthKey = monthKey;
    state.yearKey = yearKey;
    await saveSummaryState(db, box.id, state);
    return state;
  }
  if (state.lastRolloverDate !== dayKey) {
    const finishedYear = state.yearOffset + previousDayTotal;
    state.weekOffset = state.weekKey === weekKey ? state.weekOffset + previousDayTotal : 0;
    state.monthOffset = state.monthKey === monthKey ? state.monthOffset + previousDayTotal : 0;
    if (state.yearKey === yearKey) {
      state.yearOffset += previousDayTotal;
    } else {
      state.previousYearTotal = finishedYear;
      state.yearOffset = 0;
    }
    state.lastRolloverDate = dayKey;
    state.weekKey = weekKey;
    state.monthKey = monthKey;
    state.yearKey = yearKey;
    await saveSummaryState(db, box.id, state);
  }
  return state;
}

// SoC-Schätzung (%): bevorzugt das SoC-Topic, sonst aus geladener Energie seit
// Einstecken relativ zur Akkugröße (Startzustand konservativ = leer).
function estimateSoc(box, cache, counterState) {
  const fromTopic = box.socTopic ? getCacheNumber(cache, cacheKey(box.id, 'soc')) : null;
  if (fromTopic != null) {
    return { soc: Math.min(100, Math.max(0, fromTopic)), estimated: false };
  }
  const start = counterState ? counterState.pluggedEnergyStart : null;
  const raw = counterState ? counterState.lastRawValue : null;
  const capacity = box.batteryCapacityKwh;
  if (start != null && raw != null && capacity > 0) {
    const charged = Math.max(0, raw - start);
    return { soc: Math.min(100, charged / capacity * 100), estimated: true };
  }
  return { soc: null, estimated: true };
}

// Schreibende Fortschreibung aller Boxen – läuft im 60-Sekunden-Job.
async function buildWallboxSnapshot(db, cache, now = Date.now()) {
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date(now));
  const boxes = await listWallboxes(db);
  for (const box of boxes) {
    const { previousDayTotal, state, hourlyDelta } = await updateWallboxCounter(db, cache, box, calendar, now);
    await updateWallboxSummary(db, box, previousDayTotal, calendar);
    await recordWallboxHistory(db, box, calendar, state, hourlyDelta, now);
  }
}

function totalWallboxPowerWatt(cache, boxes) {
  let total = 0;
  let available = false;
  for (const box of boxes || []) {
    if (!box.powerTopic) continue;
    const watt = powerToWatt(getCacheNumber(cache, cacheKey(box.id, 'power')), box.powerUnit);
    if (watt == null) continue;
    total += Math.max(0, watt);
    available = true;
  }
  return available ? total : 0;
}

// Schreibfreie Live-Werte je Box für Seite, /data und Wertekatalog.
async function readWallboxValues(db, cache, boxes) {
  const list = boxes || (await listWallboxes(db));
  const result = [];
  for (const box of list) {
    const counter = await loadCounterState(db, box.id);
    const summary = await loadSummaryState(db, box.id);
    const today = counter.dayTotal || 0;
    const week = summary.weekOffset + today;
    const month = summary.monthOffset + today;
    const year = summary.yearOffset + today;
    const previousYear = summary.previousYearTotal;

    const powerW = box.powerTopic
      ? powerToWatt(getCacheNumber(cache, cacheKey(box.id, 'power')), box.powerUnit)
      : null;
    const plugged = box.pluggedTopic
      ? parseBool((cache.get(cacheKey(box.id, 'plugged')) || {}).value)
      : null;
    const status = parseBool((cache.get(cacheKey(box.id, 'status')) || {}).value);
    const { soc, estimated } = estimateSoc(box, cache, counter);

    result.push({
      id: box.id, name: box.name, mode: box.mode,
      powerW, plugged, status, soc, socEstimated: estimated,
      energy: { today, week, month, year, previousYear },
      formatted: {
        power: formatPower(powerW),
        soc: formatPercent(soc),
        today: formatEnergy(today), week: formatEnergy(week),
        month: formatEnergy(month), year: formatEnergy(year),
        previousYear: formatEnergy(previousYear),
      },
    });
  }
  return result;
}

module.exports = {
  buildWallboxSnapshot, readWallboxValues, estimateSoc,
  updateWallboxCounter, updateWallboxSummary, loadCounterState, loadSummaryState,
  recordWallboxHistory, powerToWatt, counterToKwh, parseBool, parseNumber, totalWallboxPowerWatt,
};
