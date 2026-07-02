'use strict';

const { listPvPlants } = require('../photovoltaik/plants');
const { computePvForecast } = require('../photovoltaik/forecast');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const { loadBatterieConfig, readBatterieData, batteryCapacityKwh } = require('../batterie/config');
const { readBatteryEnergyValues } = require('../batterie/energy');
const { loadPrognosisConfig } = require('./config');
const operatingState = require('../operating-state');
const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { solarGeometryAt } = require('../photovoltaik/aggregation');
const { buildWallboxModel, planWallboxSchedule, wallboxForecastForDay } = require('./wallbox-model');
const { isEnabled } = require('../modules');

// BDEW-nahe, geglättete Haushaltsform als Kaltstart. Sobald genügend echte
// Stundenwerte vorliegen, wird sie stufenlos durch das persönliche Profil ersetzt.
const DEFAULT_PROFILE = [
  2.4, 2.0, 1.8, 1.7, 1.8, 2.5, 4.2, 5.6, 5.1, 4.3, 3.9, 3.8,
  4.0, 4.0, 3.8, 3.9, 4.4, 5.6, 6.5, 6.4, 5.6, 4.5, 3.5, 2.7,
];
const COOLING_BASE_TEMPERATURE = 24;
const COOLING_HOT_DAY_TEMPERATURE = 26;
const COOLING_MIN_EXTRA_KWH = 1;
const COOLING_MIN_EXTRA_FRACTION = 0.15;
const COOLING_MIN_SAMPLES = 2;
// Obergrenze für den Fallback-Pfad bei ungültigem Intervall (siehe
// recordConsumptionSample). Ohne sie kann ein einzelner Zähler-Ausreißer
// (z. B. verwaister Zeitstempel nach einem Neustart oder ein Sprung im
// Quellzähler) den kompletten Rohsprung ungeprüft in den Tageswert
// übernehmen. Der Tageswert wird nur aufaddiert, ein solcher Ausreißer bliebe
// also für den ganzen Tag bestehen und würde als "gelernter" Verbrauch in die
// Prognose folgender Tage einfließen.
const MAX_FALLBACK_DELTA_KWH = 50;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function pad(value) { return String(value).padStart(2, '0'); }
function dateKey(parts) { return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`; }
function weekdayForDateKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function shiftLocalParts(local, minutes) {
  const timestamp = Date.UTC(
    local.date.year, local.date.month - 1, local.date.day,
    local.time.hours, local.time.minutes + minutes, local.time.seconds || 0
  );
  const date = new Date(timestamp);
  return {
    date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    time: { hours: date.getUTCHours(), minutes: date.getUTCMinutes(), seconds: date.getUTCSeconds() },
  };
}

function solarElevationDegrees(context) {
  if (!context || context.latitude == null) return null;
  const radians = (degrees) => degrees * Math.PI / 180;
  const declination = radians(23.45 * Math.sin(radians((360 * (284 + context.dayOfYear)) / 365)));
  const hourAngle = radians(15 * (context.decimalHours - 12));
  const latitude = radians(context.latitude);
  const up = Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, up))) * 180 / Math.PI;
}

function hoursUntilNextSunrise(mqttConfig, local) {
  const currentGeometry = solarGeometryAt(mqttConfig, local.date, local.time);
  if (currentGeometry.latitude == null) {
    const now = local.time.hours + local.time.minutes / 60;
    return now < 6 ? 6 - now : 30 - now;
  }
  let nightSeen = solarElevationDegrees(currentGeometry) <= 0;
  for (let minutes = 5; minutes <= 36 * 60; minutes += 5) {
    const candidate = shiftLocalParts(local, minutes);
    const elevation = solarElevationDegrees(solarGeometryAt(mqttConfig, candidate.date, candidate.time));
    if (elevation == null) return null;
    if (elevation <= 0) nightSeen = true;
    if (nightSeen && elevation > 0) return minutes / 60;
  }
  return null;
}

function projectedConsumptionForHours(model, forecast, hours) {
  if (!Number.isFinite(hours) || hours < 0) return null;
  let total = 0;
  // Viertelstunden-Schritte bilden Stundenprofil, Tageswechsel und einen nur
  // teilweise erreichten Sonnenaufgang ohne lineare 24-h-Näherung ab.
  for (let elapsed = 0; elapsed < hours; elapsed += 0.25) {
    const duration = Math.min(0.25, hours - elapsed);
    const parts = shiftLocalParts(model.local, (elapsed + duration / 2) * 60);
    const key = dateKey(parts.date);
    const weekday = weekdayForDateKey(key);
    const profile = model.profilesByWeekday[weekday] || model.profile;
    const target = model.dailyTargetsByWeekday[weekday] ?? model.dailyTarget;
    const isToday = key === dateKey(model.local.date);
    const base = Math.max(0, target * profile[parts.time.hours] * (isToday ? model.intradayFactor : 1));
    const cooling = buildCoolingForecastForDay(forecast, key, model.coolingModel).hourly[parts.time.hours] || 0;
    let wallbox = wallboxForecastForDay(model.wallboxModel, key, isToday ? 0 : 1).hourly[parts.time.hours] || 0;
    // Der aktuelle Stunden-Slot enthält bereits nur die verbleibende Energie.
    // Für die Viertelstundenintegration wieder in eine Stundenrate umrechnen.
    if (isToday && parts.time.hours === model.local.time.hours) {
      wallbox /= Math.max(0.001, 1 - model.local.time.minutes / 60);
    }
    total += (base + cooling + wallbox) * duration;
  }
  return total;
}

function normalizedProfile(values) {
  const safe = values.map((value) => Math.max(0, Number(value) || 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  return total > 0 ? safe.map((value) => value / total) : DEFAULT_PROFILE.map((value) => value / 100);
}

function medianOf(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildCoolingModel(rows) {
  const valid = (rows || []).map((row) => ({
    dayKey: row.day_key,
    weekday: weekdayForDateKey(row.day_key),
    consumption: num(row.consumption_kwh),
    maxTemperature: num(row.max_temperature),
  })).filter((row) => row.consumption != null && row.consumption > 0 && row.maxTemperature != null);
  const nonHot = valid.filter((row) => row.maxTemperature < COOLING_HOT_DAY_TEMPERATURE);
  // Ohne mindestens einen nicht-heißen Vergleichstag gibt es keine Baseline für
  // "normalen" Verbrauch. Ein Rückfall auf den Median der (nur) heißen Tage
  // würde Hitzetage nur gegeneinander vergleichen und selbst bei völlig
  // gleichem Kühlbedarf zwangsläufig einen der beiden als "signifikant erhöht"
  // markieren – ein Scheinsignal aus reinem Stichprobenrauschen.
  const fallbackBaseline = medianOf(nonHot.map((row) => row.consumption));
  const baselinesByWeekday = Array.from({ length: 7 }, (_, weekday) =>
    medianOf(nonHot.filter((row) => row.weekday === weekday).map((row) => row.consumption)) || fallbackBaseline
  );
  const samples = [];
  const climateDayKeys = new Set();
  for (const row of valid) {
    if (row.maxTemperature < COOLING_HOT_DAY_TEMPERATURE) continue;
    const baseline = baselinesByWeekday[row.weekday];
    if (!(baseline > 0)) continue;
    const residual = row.consumption - baseline;
    const significant = residual >= Math.max(COOLING_MIN_EXTRA_KWH, baseline * COOLING_MIN_EXTRA_FRACTION);
    if (!significant) continue;
    const degreeHours = row.maxTemperature - COOLING_BASE_TEMPERATURE;
    if (degreeHours <= 0) continue;
    climateDayKeys.add(row.dayKey);
    samples.push({ ...row, baseline, residual, degreeHours });
  }
  const denominator = samples.reduce((sum, row) => sum + row.degreeHours ** 2, 0);
  const slope = denominator > 0
    ? clamp(samples.reduce((sum, row) => sum + row.degreeHours * row.residual, 0) / denominator, 0, 10)
    : 0;
  return {
    baseTemperature: COOLING_BASE_TEMPERATURE,
    hotDayTemperature: COOLING_HOT_DAY_TEMPERATURE,
    sampleCount: samples.length,
    enabled: samples.length >= COOLING_MIN_SAMPLES && slope > 0,
    kwhPerDegree: slope,
    climateDayKeys,
    baselinesByWeekday,
  };
}

function baseConsumptionForRow(row, coolingModel) {
  const value = num(row.consumption_kwh);
  if (value == null) return null;
  if (!coolingModel.climateDayKeys.has(row.day_key)) return value;
  return coolingModel.baselinesByWeekday[weekdayForDateKey(row.day_key)] || value;
}

function adjustedConsumptionDelta(rawDelta, batteryPower, durationMs, wallboxPower = 0) {
  const raw = Math.max(0, num(rawDelta) || 0);
  const power = num(batteryPower) || 0;
  const duration = Math.max(0, Number(durationMs) || 0);
  // Batterie-Leistung: positiv = laden, negativ = entladen.
  // Gesamtverbrauch enthält Laden und unterschlägt Entladen → signiert abziehen.
  const wallbox = Math.max(0, num(wallboxPower) || 0);
  return Math.max(0, raw - (power + wallbox) * duration / 3600000000);
}

async function recordConsumptionSample(db, totalKwh, cache, options = {}, now = new Date()) {
  const total = num(totalKwh);
  if (total == null || total < 0) return;
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const local = localCalendar(cache, mqttConfig.timezone, now);
  const key = local.dateKey;
  const hour = clamp(Number(local.hours) || 0, 0, 23);
  const timestamp = now.getTime();
  const previous = await dbGet(
    db,
    `SELECT consumption_kwh, raw_consumption_kwh, max_temperature, updated_at
       FROM prognosis_daily_consumption WHERE day_key = ?`,
    [key]
  );
  // Ein neuer lokaler Tag beginnt im Lernmodell immer bei 0. Das erste gelesene
  // Tagestotal ist ausschließlich die Differenz-Basis. Externe Tageszähler
  // springen häufig erst einige Sekunden/Minuten nach unserer lokalen
  // Mitternacht zurück; würde ihr alter Stand hier als heutiger Verbrauch
  // übernommen, enthielte der neue Tag den kompletten Vortag.
  let adjustedTotal = 0;
  const measuredTemperature = num(options.outdoorTemperature);
  let maxTemperature = measuredTemperature;

  // Nur kurze, plausible Intervalle integrieren. So erzeugt ein Neustart nach
  // Stunden keine künstliche Lastspitze, der Tageszähler selbst bleibt aber korrekt.
  if (previous) {
    const previousMaxTemperature = num(previous.max_temperature);
    if (previousMaxTemperature != null) {
      maxTemperature = measuredTemperature == null
        ? previousMaxTemperature
        : Math.max(previousMaxTemperature, measuredTemperature);
    }
    const rawBefore = num(previous.raw_consumption_kwh) ?? num(previous.consumption_kwh) ?? 0;
    const rawDelta = total - rawBefore;
    const age = timestamp - Number(previous.updated_at || 0);
    const previousAdjusted = num(previous.consumption_kwh) || 0;
    const batteryPower = num(options.batteryPower) || 0;
    const validInterval = rawDelta >= 0 && rawDelta < 2 && age > 0 && age <= 5 * 60 * 1000;
    // Ein negativer Delta ist der verspätete Reset eines Quellzählers. Dabei
    // wird raw_consumption_kwh unten auf den neuen Stand basiert, der bereits
    // integrierte heutige Verbrauch bleibt jedoch unverändert.
    const adjustedDelta = validInterval
      ? adjustedConsumptionDelta(rawDelta, batteryPower, age, options.wallboxPower)
      : Math.min(Math.max(0, rawDelta), MAX_FALLBACK_DELTA_KWH);
    adjustedTotal = previousAdjusted + adjustedDelta;
    if (validInterval && adjustedDelta > 0 && adjustedDelta < 2) {
      await dbRun(
        db,
        `INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh)
         VALUES (?, ?, ?)
         ON CONFLICT(day_key, hour) DO UPDATE SET
          consumption_kwh=prognosis_hourly_consumption.consumption_kwh + excluded.consumption_kwh`,
        [key, hour, adjustedDelta]
      );
    }
  }

  await dbRun(
    db,
    `INSERT INTO prognosis_daily_consumption
      (day_key, consumption_kwh, raw_consumption_kwh, max_temperature, completed, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(day_key) DO UPDATE SET
      consumption_kwh=excluded.consumption_kwh,
      raw_consumption_kwh=excluded.raw_consumption_kwh,
      max_temperature=COALESCE(excluded.max_temperature, prognosis_daily_consumption.max_temperature),
      completed=0, updated_at=excluded.updated_at`,
    [key, adjustedTotal, total, maxTemperature, timestamp]
  );
  await dbRun(db, 'UPDATE prognosis_daily_consumption SET completed = 1 WHERE day_key <> ? AND completed = 0', [key]);
  await dbRun(db, 'DELETE FROM prognosis_daily_consumption WHERE day_key < date(?, \'-400 days\')', [key]);
  await dbRun(db, 'DELETE FROM prognosis_hourly_consumption WHERE day_key < date(?, \'-90 days\')', [key]);
}

function elapsedDayCount(localDate) {
  const start = Date.UTC(localDate.year, 0, 1);
  const current = Date.UTC(localDate.year, localDate.month - 1, localDate.day);
  return Math.max(0, Math.round((current - start) / 86400000));
}

async function buildConsumptionModel(db, strom, config, cache, forecast = null, storage = null) {
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date());
  const local = {
    date: { year: calendar.year, month: calendar.month, day: calendar.day },
    time: { hours: calendar.hours, minutes: calendar.minutes, seconds: calendar.seconds },
  };
  const key = dateKey(local.date);
  const wallboxModel = isEnabled('wallbox')
    ? await buildWallboxModel(db, key, config.historyDays, local.time.hours, local.time.minutes, cache)
    : { boxes: [], todayRemainingByHour: Array(24).fill(0), yearKwh: 0, previousYearKwh: 0 };
  const previousHour = shiftLocalParts(local, -60);
  const recentHourRows = await dbAll(
    db,
    `SELECT day_key, hour, consumption_kwh FROM prognosis_hourly_consumption
      WHERE (day_key = ? AND hour = ?) OR (day_key = ? AND hour = ?)`,
    [key, local.time.hours, dateKey(previousHour.date), previousHour.time.hours]
  );
  const currentHourRow = recentHourRows.find(
    (row) => row.day_key === key && Number(row.hour) === Number(local.time.hours)
  );
  const previousHourRow = recentHourRows.find(
    (row) => row.day_key === dateKey(previousHour.date) && Number(row.hour) === Number(previousHour.time.hours)
  );
  const currentHourEnergy = num(currentHourRow && currentHourRow.consumption_kwh);
  const previousHourEnergy = num(previousHourRow && previousHourRow.consumption_kwh);
  const currentHourFraction = local.time.minutes / 60;
  const todayRow = await dbGet(
    db,
    'SELECT consumption_kwh FROM prognosis_daily_consumption WHERE day_key = ?',
    [key]
  );
  const rawToday = Math.max(0, num(strom.breakdown.today.summe) || 0);
  const today = Math.max(
    0,
    num(todayRow && todayRow.consumption_kwh) ?? rawToday
  );
  const batteryEnergy = await readBatteryEnergyValues(db);
  const year = num(strom.breakdown.year.summe);
  const previousYear = num(strom.breakdown.previousYear.summe);
  // Eigenverbrauch (PV+Import-Export) enthält auch die Akku- und Wallbox-
  // Ladung mit; beide werden hier abgezogen, damit die Jahresbasis dieselbe
  // "reine" Hausverbrauchsgröße abbildet wie der tagesweise angepasste Wert
  // (siehe adjustedConsumptionDelta).
  const houseYear = year == null ? null
    : Math.max(0, year - wallboxModel.yearKwh - batteryEnergy.year.netCharge);
  const housePreviousYear = previousYear == null ? null
    : Math.max(0, previousYear - wallboxModel.previousYearKwh - batteryEnergy.previousYear.netCharge);
  const completedDays = elapsedDayCount(local.date);
  const annualAverage = completedDays > 0 && houseYear != null
    ? Math.max(0, houseYear - today) / completedDays
    : (housePreviousYear != null && housePreviousYear > 0 ? housePreviousYear / 365 : null);

  const dailyRows = await dbAll(db,
    `SELECT day_key, consumption_kwh, max_temperature FROM prognosis_daily_consumption
     WHERE completed = 1 AND day_key < ? ORDER BY day_key DESC LIMIT ?`,
    [key, config.historyDays]
  );
  const coolingRows = await dbAll(db,
    `SELECT day_key, consumption_kwh, max_temperature FROM prognosis_daily_consumption
     WHERE completed = 1 AND day_key < ? AND max_temperature IS NOT NULL
     ORDER BY day_key DESC LIMIT 120`,
    [key]
  );
  const coolingModel = buildCoolingModel(coolingRows);
  const dailyValues = dailyRows
    .map((row) => baseConsumptionForRow(row, coolingModel))
    .filter((value) => value != null && value > 0)
    .sort((a, b) => a - b);
  const median = dailyValues.length
    ? dailyValues[Math.floor(dailyValues.length / 2)]
    : null;
  let weight = 0;
  let weightedTotal = 0;
  dailyRows.forEach((row, index) => {
    const value = baseConsumptionForRow(row, coolingModel);
    if (value == null || value <= 0) return;
    // Einzelne Sondertage (Urlaub, E-Auto, Heizstab) dürfen das Modell bewegen,
    // aber nicht dominieren. Winsorisierung hält sie im Bereich 50–200 % des Medians.
    const robustValue = median == null ? value : clamp(value, median * 0.5, median * 2);
    const w = Math.exp(-index / 14);
    weight += w;
    weightedTotal += robustValue * w;
  });
  const recentAverage = weight > 0 ? weightedTotal / weight : null;
  const learnedWeight = recentAverage == null ? 0 : Math.min(0.75, dailyRows.length / 21 * 0.75);
  let dailyTarget = annualAverage != null && annualAverage > 0
    ? annualAverage * (1 - learnedWeight) + (recentAverage || annualAverage) * learnedWeight
    : recentAverage;

  const hourlyRows = await dbAll(db,
    `SELECT h.day_key, h.hour, h.consumption_kwh AS energy,
            d.consumption_kwh AS day_total
       FROM prognosis_hourly_consumption h
       JOIN prognosis_daily_consumption d ON d.day_key = h.day_key
      WHERE d.completed = 1 AND h.day_key >= date(?, '-42 days')
      ORDER BY h.day_key DESC, h.hour`,
    [key]
  );
  const learnedRaw = Array(24).fill(0);
  const weekdayRaw = Array.from({ length: 7 }, () => Array(24).fill(0));
  const weekdayProfileDays = Array.from({ length: 7 }, () => new Set());
  hourlyRows.forEach((row) => {
    if (coolingModel.climateDayKeys.has(row.day_key)) return;
    const hourIndex = Number(row.hour);
    const energy = num(row.energy) || 0;
    const dayTotal = num(row.day_total) || 0;
    const share = dayTotal > 0 ? energy / dayTotal : 0;
    const weekday = weekdayForDateKey(row.day_key);
    // Jede Tageskurve gleich gewichten; große Verbrauchstage dürfen nicht
    // automatisch die Form des Wochentagsprofils dominieren.
    learnedRaw[hourIndex] += share;
    weekdayRaw[weekday][hourIndex] += share;
    weekdayProfileDays[weekday].add(row.day_key);
  });
  const learned = normalizedProfile(learnedRaw);
  const fallback = normalizedProfile(DEFAULT_PROFILE);
  const profileWeight = Math.min(1, dailyRows.length / 14);
  const profile = fallback.map((value, hour) => value * (1 - profileWeight) + learned[hour] * profileWeight);
  const profilesByWeekday = weekdayRaw.map((raw, weekday) => {
    const learnedWeekday = normalizedProfile(raw);
    const learnedDays = weekdayProfileDays[weekday].size;
    const weekdayWeight = Math.min(1, learnedDays / 6);
    return profile.map(
      (value, hourIndex) => value * (1 - weekdayWeight) + learnedWeekday[hourIndex] * weekdayWeight
    );
  });

  const dailyTargetsByWeekday = Array(7).fill(dailyTarget || 0);
  const weekdayDailyCounts = Array(7).fill(0);
  for (let weekday = 0; weekday < 7; weekday += 1) {
    let weekdayWeightTotal = 0;
    let weekdayWeightedEnergy = 0;
    dailyRows.forEach((row, index) => {
      if (weekdayForDateKey(row.day_key) !== weekday) return;
      const value = baseConsumptionForRow(row, coolingModel);
      if (value == null || value <= 0) return;
      const robustValue = median == null ? value : clamp(value, median * 0.5, median * 2);
      const recencyWeight = Math.exp(-index / 28);
      weekdayWeightTotal += recencyWeight;
      weekdayWeightedEnergy += robustValue * recencyWeight;
      weekdayDailyCounts[weekday] += 1;
    });
    if (weekdayWeightTotal > 0) {
      const weekdayAverage = weekdayWeightedEnergy / weekdayWeightTotal;
      const weekdayLevelWeight = Math.min(0.6, weekdayDailyCounts[weekday] / 6 * 0.6);
      dailyTargetsByWeekday[weekday] = (dailyTarget || weekdayAverage) * (1 - weekdayLevelWeight) +
        weekdayAverage * weekdayLevelWeight;
    }
  }

  const currentWeekday = weekdayForDateKey(key);
  const currentProfile = profilesByWeekday[currentWeekday] || profile;
  dailyTarget = dailyTargetsByWeekday[currentWeekday] || dailyTarget;

  const hour = clamp(Number(local.time.hours) || 0, 0, 23);
  const minute = clamp(Number(local.time.minutes) || 0, 0, 59);
  const elapsedShare = currentProfile.slice(0, hour).reduce((sum, value) => sum + value, 0) +
    currentProfile[hour] * minute / 60;
  if (!(dailyTarget > 0) && elapsedShare > 0.05) dailyTarget = today / elapsedShare;
  if (!(dailyTarget > 0)) dailyTarget = 0;

  const expectedSoFar = dailyTarget * elapsedShare;
  const coolingForecastToday = buildCoolingForecastForDay(forecast, key, coolingModel);
  const coolingElapsedToday = coolingForecastToday.hourly
    .reduce((sum, value, index) => {
      if (index < hour) return sum + value;
      if (index === hour) return sum + value * minute / 60;
      return sum;
    }, 0);
  const baseTodayForCalibration = Math.max(0, today - coolingElapsedToday);
  const intradayFactor = expectedSoFar > 0.5
    ? clamp(baseTodayForCalibration / expectedSoFar, 0.75, 1.35)
    : 1;
  const remainingByHour = currentProfile.map((share, index) => {
    if (index < hour) return 0;
    if (index === hour) return dailyTarget * intradayFactor * share * (1 - minute / 60);
    return dailyTarget * intradayFactor * share;
  });

  planWallboxSchedule(wallboxModel, buildWallboxPlanningSlots({
    forecast, local, remainingByHour, profilesByWeekday, dailyTargetsByWeekday,
    profile: currentProfile, dailyTarget, coolingModel,
  }), storage);

  let recentHourKwh = null;
  if (currentHourEnergy != null && previousHourEnergy != null) {
    recentHourKwh = currentHourEnergy + previousHourEnergy * (1 - currentHourFraction);
  } else if (currentHourEnergy != null && currentHourFraction > 0) {
    recentHourKwh = currentHourEnergy / currentHourFraction;
  } else if (previousHourEnergy != null) {
    recentHourKwh = previousHourEnergy;
  }
  if (recentHourKwh == null) recentHourKwh = dailyTarget * currentProfile[hour];

  const hoursToSunrise = hoursUntilNextSunrise(mqttConfig, local);
  const consumptionToSunrise = projectedConsumptionForHours({
    local, dailyTarget, profile: currentProfile, profilesByWeekday, dailyTargetsByWeekday,
    intradayFactor, coolingModel, wallboxModel,
  }, forecast, hoursToSunrise);

  return {
    local, today, rawToday, annualAverage, recentAverage, dailyTarget,
    expectedToday: today + remainingByHour.reduce((sum, value) => sum + value, 0),
    remainingToday: remainingByHour.reduce((sum, value) => sum + value, 0),
    intradayFactor, profile: currentProfile, profilesByWeekday, dailyTargetsByWeekday,
    weekdayProfileDays: weekdayProfileDays.map((days) => days.size), weekdayDailyCounts,
    currentWeekday, coolingModel, coolingElapsedToday,
    wallboxModel,
    remainingByHour, recentHourKwh, hoursToSunrise, consumptionToSunrise,
    historyDays: dailyRows.length,
  };
}

function forecastPvForHour(forecast, dayKeyValue, hour) {
  if (!forecast || !Array.isArray(forecast.hours)) return 0;
  return forecast.hours
    .filter((slot) => slot.dateKey === dayKeyValue && Number(slot.hour) === hour)
    .reduce((sum, slot) => sum + (num(slot.kwh) || 0), 0);
}

function forecastTemperatureForHour(forecast, dayKeyValue, hour) {
  if (!forecast || !Array.isArray(forecast.hours)) return null;
  const slot = forecast.hours.find(
    (entry) => entry.dateKey === dayKeyValue && Number(entry.hour) === hour
  );
  return slot ? num(slot.temperature) : null;
}

function buildCoolingForecastForDay(forecast, dayKeyValue, coolingModel = {}) {
  const model = {
    enabled: false, baseTemperature: COOLING_BASE_TEMPERATURE,
    hotDayTemperature: COOLING_HOT_DAY_TEMPERATURE, kwhPerDegree: 0,
    ...coolingModel,
  };
  const temperatures = Array.from(
    { length: 24 },
    (_, hour) => forecastTemperatureForHour(forecast, dayKeyValue, hour)
  );
  const finiteTemperatures = temperatures.filter((value) => value != null);
  const maxTemperature = finiteTemperatures.length ? Math.max(...finiteTemperatures) : null;
  const total = model.enabled && maxTemperature != null && maxTemperature >= model.hotDayTemperature
    ? model.kwhPerDegree * Math.max(0, maxTemperature - model.baseTemperature)
    : 0;
  const weights = temperatures.map(
    (temperature) => temperature == null ? 0 : Math.max(0, temperature - model.hotDayTemperature)
  );
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  return {
    temperatures,
    maxTemperature,
    total,
    hourly: weights.map((weight) => weightTotal > 0 ? total * weight / weightTotal : 0),
  };
}

function buildWallboxPlanningSlots({
  forecast, local, remainingByHour, profilesByWeekday,
  dailyTargetsByWeekday, profile, dailyTarget, coolingModel,
}) {
  if (!forecast || !Array.isArray(forecast.days)) return [];
  const currentHour = Number(local.time.hours) || 0;
  const currentMinute = Number(local.time.minutes) || 0;
  const nowDecimal = currentHour + currentMinute / 60;
  const nowMs = Date.now();
  const slots = [];

  forecast.days.slice(0, 4).forEach((day, dayIndex) => {
    const wd = weekdayForDateKey(day.dateKey);
    const dayProfile = profilesByWeekday[wd] || profile;
    const dayTarget = dailyTargetsByWeekday[wd] ?? dailyTarget;
    const cooling = buildCoolingForecastForDay(forecast, day.dateKey, coolingModel).hourly;
    const rawPv = Array.from({ length: 24 }, (_, hour) => {
      if (dayIndex === 0 && hour < currentHour) return 0;
      const duration = dayIndex === 0 && hour === currentHour ? 1 - currentMinute / 60 : 1;
      return forecastPvForHour(forecast, day.dateKey, hour) * duration;
    });
    const rawTotal = rawPv.reduce((sum, value) => sum + value, 0);
    const targetTotal = dayIndex === 0
      ? Math.max(0, num(forecast.todayRemainingKwh) || 0)
      : Math.max(0, num(day.totalKwh) || 0);
    const pvScale = rawTotal > 0 ? targetTotal / rawTotal : 0;

    for (let hour = 0; hour < 24; hour += 1) {
      if (dayIndex === 0 && hour < currentHour) continue;
      const durationHours = dayIndex === 0 && hour === currentHour
        ? Math.max(0, 1 - currentMinute / 60)
        : 1;
      const base = dayIndex === 0
        ? remainingByHour[hour]
        : Math.max(0, dayTarget * (dayProfile[hour] || 0));
      const coolingKwh = Math.max(0, cooling[hour] || 0) * durationHours;
      slots.push({
        dateKey: day.dateKey,
        dayIndex,
        hour,
        durationHours,
        startMs: dayIndex === 0 && hour === currentHour
          ? nowMs
          : nowMs + ((dayIndex * 24 + hour) - nowDecimal) * 3600000,
        pvKwh: rawPv[hour] * pvScale,
        houseKwh: Math.max(0, base || 0) + coolingKwh,
      });
    }
  });
  return slots;
}

function simulateDays({ forecast, model, config, batteryConfig, batteryData }) {
  const minSoc = clamp(num(batteryData.minSoc) ?? num(batteryConfig.minSoc) ?? 20, 0, 100);
  const soc = clamp(num(batteryData.soc) ?? minSoc, 0, 100);
  const capacity = batteryCapacityKwh(batteryConfig);
  const usableCapacity = capacity * (1 - minSoc / 100);
  let stored = clamp(capacity * (soc - minSoc) / 100, 0, usableCapacity);
  const initialStored = stored;
  const chargeEfficiency = config.chargeEfficiency / 100;
  const dischargeEfficiency = config.dischargeEfficiency / 100;
  const currentHour = Number(model.local.time.hours) || 0;
  const currentMinute = Number(model.local.time.minutes) || 0;
  const forecastDays = forecast && Array.isArray(forecast.days) ? forecast.days.slice(0, 4) : [];
  let nextChargeStart = null;
  let minimumReached = stored <= 0.000001 && forecastDays.length
    ? {
        dateKey: forecastDays[0].dateKey,
        label: forecastDays[0].label,
        dayOffset: 0,
        hour: currentHour + currentMinute / 60,
        soc: minSoc,
      }
    : null;
  let gridBeforeNextChargeKwh = 0;

  const days = forecastDays.map((pvDay, dayIndex) => {
    let gridKwh = 0;
    let surplusKwh = 0;
    let loadKwh = 0;
    let pvKwh = 0;
    let coolingKwh = 0;
    let houseLoadKwh = 0;
    let wallboxKwh = 0;
    let reachedFull = false;
    let chargeStartSoc = null;
    let chargeStartHour = null;
    const weekday = weekdayForDateKey(pvDay.dateKey);
    const dayProfile = model.profilesByWeekday && model.profilesByWeekday[weekday]
      ? model.profilesByWeekday[weekday]
      : model.profile;
    const dayTarget = model.dailyTargetsByWeekday && model.dailyTargetsByWeekday[weekday] != null
      ? model.dailyTargetsByWeekday[weekday]
      : model.dailyTarget;
    const coolingForecast = buildCoolingForecastForDay(forecast, pvDay.dateKey, model.coolingModel);
    const wallboxForecast = wallboxForecastForDay(model.wallboxModel, pvDay.dateKey, dayIndex);
    const maxTemperature = coolingForecast.maxTemperature;
    const coolingHourly = coolingForecast.hourly.map((value, hour) => {
      if (dayIndex === 0 && hour < currentHour) return 0;
      if (dayIndex === 0 && hour === currentHour) return value * (1 - currentMinute / 60);
      return value;
    });
    const pvHourly = Array.from({ length: 24 }, (_, hour) => {
      if (dayIndex === 0 && hour < currentHour) return 0;
      const raw = forecastPvForHour(forecast, pvDay.dateKey, hour);
      return dayIndex === 0 && hour === currentHour ? raw * (1 - currentMinute / 60) : raw;
    });
    const rawPvTotal = pvHourly.reduce((sum, value) => sum + value, 0);
    const targetPvTotal = dayIndex === 0
      ? Math.max(0, num(forecast.todayRemainingKwh) || 0)
      : Math.max(0, num(pvDay.totalKwh) || 0);
    const pvScale = rawPvTotal > 0 ? targetPvTotal / rawPvTotal : 0;
    for (let hour = 0; hour < 24; hour += 1) {
      if (dayIndex === 0 && hour < currentHour) continue;
      let houseLoad = dayIndex === 0 ? model.remainingByHour[hour] : dayTarget * dayProfile[hour];
      houseLoad += coolingHourly[hour];
      const wallboxLoad = wallboxForecast.hourly[hour] || 0;
      let load = houseLoad + wallboxLoad;
      let pv = pvHourly[hour] * pvScale;
      load = Math.max(0, load || 0);
      pv = Math.max(0, pv || 0);
      loadKwh += load;
      houseLoadKwh += houseLoad;
      wallboxKwh += wallboxLoad;
      coolingKwh += coolingHourly[hour];
      pvKwh += pv;
      const direct = Math.min(load, pv);
      const shortfall = load - direct;
      const excess = pv - direct;
      if (excess > 0) {
        const roomInput = (usableCapacity - stored) / chargeEfficiency;
        const chargedInput = Math.min(excess, Math.max(0, roomInput));
        if (chargedInput > 0.001 && chargeStartSoc == null) {
          chargeStartSoc = capacity > 0 ? minSoc + stored / capacity * 100 : minSoc;
          chargeStartHour = dayIndex === 0 && hour === currentHour
            ? hour + currentMinute / 60
            : hour;
          // Für die Autarkie-Bewertung zählt der erste sichtbare Ladebeginn ab
          // dem Folgetag. Bei Dunkelflaute wird über weitere Prognosetage
          // kumuliert; ein heutiger Überschuss beendet das Nachtfenster nicht.
          if (!nextChargeStart && dayIndex >= 1) {
            nextChargeStart = {
              dateKey: pvDay.dateKey,
              label: pvDay.label,
              dayOffset: dayIndex,
              hour: chargeStartHour,
              soc: chargeStartSoc,
              gridBeforeKwh: gridBeforeNextChargeKwh,
            };
          }
        }
        stored += chargedInput * chargeEfficiency;
        surplusKwh += excess - chargedInput;
        if (stored >= usableCapacity - 0.001) reachedFull = true;
      }
      if (shortfall > 0) {
        const availableOutput = stored * dischargeEfficiency;
        const intervalStart = dayIndex === 0 && hour === currentHour
          ? hour + currentMinute / 60
          : hour;
        const intervalDuration = dayIndex === 0 && hour === currentHour
          ? 1 - currentMinute / 60
          : 1;
        if (!minimumReached && shortfall >= availableOutput - 0.000001) {
          const fraction = shortfall > 0 ? clamp(availableOutput / shortfall, 0, 1) : 0;
          minimumReached = {
            dateKey: pvDay.dateKey,
            label: pvDay.label,
            dayOffset: dayIndex,
            hour: intervalStart + intervalDuration * fraction,
            soc: minSoc,
          };
        }
        const supplied = Math.min(shortfall, availableOutput);
        stored -= supplied / dischargeEfficiency;
        const grid = shortfall - supplied;
        gridKwh += grid;
        if (!nextChargeStart) gridBeforeNextChargeKwh += grid;
      }
    }
    return {
      dateKey: pvDay.dateKey,
      label: pvDay.label,
      pvKwh, loadKwh, gridKwh, surplusKwh,
      balanceKwh: pvKwh - loadKwh,
      batterySocEnd: capacity > 0 ? minSoc + stored / capacity * 100 : minSoc,
      batteryFull: reachedFull,
      chargeStartSoc,
      chargeStartHour,
      weekday,
      consumptionProfileDays: model.weekdayProfileDays ? model.weekdayProfileDays[weekday] : 0,
      coolingKwh,
      houseLoadKwh,
      wallboxKwh,
      wallboxes: wallboxForecast.perBox,
      maxTemperature,
    };
  });

  const today = days[0] || {
    label: 'Heute', pvKwh: null,
    loadKwh: model.remainingToday, gridKwh: null, surplusKwh: null,
    balanceKwh: null,
    batterySocEnd: soc, batteryFull: false,
  };
  const available = days.length > 0;
  const assessmentSoc = nextChargeStart
    ? nextChargeStart.soc
    : (days.length ? days[days.length - 1].batterySocEnd : today.batterySocEnd);
  const gridBeforeCharge = nextChargeStart
    ? nextChargeStart.gridBeforeKwh
    : days.reduce((sum, day) => sum + (day.gridKwh || 0), 0);
  const minimumBeforeCharge = !!(
    minimumReached &&
    (!nextChargeStart ||
      minimumReached.dayOffset < nextChargeStart.dayOffset ||
      (minimumReached.dayOffset === nextChargeStart.dayOffset && minimumReached.hour <= nextChargeStart.hour))
  );
  const status = !available
    ? null
    : (gridBeforeCharge > 0.05 || minimumBeforeCharge ? 0 : (assessmentSoc < minSoc + 10 ? 1 : 2));
  return {
    days, today, status, available, minSoc, soc, usableCapacity, initialStored,
    nextChargeStart, minimumReached, minimumBeforeCharge, assessmentSoc, gridBeforeCharge,
  };
}

async function computePrognosis(db, cache, { allowFetch = false } = {}) {
  const [plants, config, batteryConfig, strom] = await Promise.all([
    listPvPlants(db), loadPrognosisConfig(db),
    new Promise((resolve) => loadBatterieConfig(db, resolve)),
    readStromverbrauchValues(db, cache),
  ]);
  const forecast = await computePvForecast(db, plants, { allowFetch, cache }).catch(() => null);
  const batteryData = readBatterieData(cache);
  const model = await buildConsumptionModel(db, strom, config, cache, forecast, {
    capacityKwh: batteryCapacityKwh(batteryConfig),
    minSoc: num(batteryData.minSoc) ?? num(batteryConfig.minSoc) ?? 20,
    soc: num(batteryData.soc) ?? num(batteryConfig.minSoc) ?? 20,
    chargeEfficiency: config.chargeEfficiency / 100,
    dischargeEfficiency: config.dischargeEfficiency / 100,
  });
  const simulation = simulateDays({ forecast, model, config, batteryConfig, batteryData });
  return {
    config, forecast, model, battery: batteryData, simulation,
    operating: operatingState.getState(),
    externalAutarkDays: cache.get(operatingState.AUTARK_DAYS_STATE_ID)?.value ?? null,
    externalAutarkDaysPreviousYear:
      cache.get(operatingState.AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID)?.value ?? null,
  };
}

module.exports = {
  computePrognosis, recordConsumptionSample, buildConsumptionModel,
  normalizedProfile, adjustedConsumptionDelta, buildCoolingModel, simulateDays,
  hoursUntilNextSunrise, projectedConsumptionForHours, buildWallboxPlanningSlots,
};
