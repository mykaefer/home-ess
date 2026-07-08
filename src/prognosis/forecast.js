'use strict';

const { listPvPlants } = require('../photovoltaik/plants');
const { computePvForecast } = require('../photovoltaik/forecast');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const { loadBatterieConfig, readBatterieData, batteryCapacityKwh } = require('../batterie/config');
const { loadPrognosisConfig } = require('./config');
const operatingState = require('../operating-state');
const metrics = require('../runtime-metrics');
const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { solarGeometryAt } = require('../photovoltaik/aggregation');
const { buildWallboxModel, planWallboxSchedule, wallboxForecastForDay } = require('./wallbox-model');
const { isEnabled } = require('../modules');
const { loadPoolEnergyModel, poolLoadForHour } = require('../pool/energy-model');
const { loadFunctionModels, functionsLoadForHour } = require('../messen-schalten/functions');

// BDEW-nahe, geglättete Haushaltsform als reiner Kaltstart (noch kein einziger
// abgeschlossener Lerntag). Sobald ein Tag vollständig vorliegt, dient dessen
// Stundenkurve als Vorlage für alle noch ungelernten Wochentage.
const DEFAULT_PROFILE = [
  2.4, 2.0, 1.8, 1.7, 1.8, 2.5, 4.2, 5.6, 5.1, 4.3, 3.9, 3.8,
  4.0, 4.0, 3.8, 3.9, 4.4, 5.6, 6.5, 6.4, 5.6, 4.5, 3.5, 2.7,
];
// Obergrenze für den Fallback-Pfad bei ungültigem Intervall (siehe
// recordConsumptionSample). Ohne sie kann ein einzelner Zähler-Ausreißer
// (z. B. verwaister Zeitstempel nach einem Neustart oder ein Sprung im
// Quellzähler) den kompletten Rohsprung ungeprüft in den Tageswert
// übernehmen. Der Tageswert wird nur aufaddiert, ein solcher Ausreißer bliebe
// also für den ganzen Tag bestehen und würde als "gelernter" Verbrauch in die
// Prognose folgender Tage einfließen.
const MAX_SAMPLE_DELTA_KWH = 2;
// Kleine NEGATIVE Deltas des kumulierten Bilanz-Eigenverbrauchs sind kein
// Zähler-Reset, sondern der Sägezahn der Bilanz beim Akku-Laden (PV-, Netz- und
// Akkuzähler schreiten nicht exakt synchron fort). Sie müssen gegengerechnet
// werden: Eine reine Positiv-Delta-Lernung wirkt sonst als Gleichrichter und
// pumpt das Pendeln als Schein-Verbrauch in die Tagesstunden (real beobachtet:
// Bilanz-Stunden > 2× Selbstzählung). Erst größere Rücksprünge gelten als
// verspäteter Reset des Quellzählers und werden nur neu basiert.
const MAX_NEGATIVE_SAMPLE_DELTA_KWH = 0.5;

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
    const functions = functionsLoadForHour(model.functionModels, forecast, key, parts.time.hours, 1);
    let wallbox = wallboxForecastForDay(model.wallboxModel, key, isToday ? 0 : 1).hourly[parts.time.hours] || 0;
    // Der aktuelle Stunden-Slot enthält bereits nur die verbleibende Energie.
    // Für die Viertelstundenintegration wieder in eine Stundenrate umrechnen.
    if (isToday && parts.time.hours === model.local.time.hours) {
      wallbox /= Math.max(0.001, 1 - model.local.time.minutes / 60);
    }
    const pool = poolLoadForHour(model.poolModel, forecast, key, parts.time.hours, 1, null).totalKwh;
    total += (base + functions + wallbox + pool) * duration;
  }
  return total;
}

function normalizedProfile(values) {
  const safe = values.map((value) => Math.max(0, Number(value) || 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  return total > 0 ? safe.map((value) => value / total) : DEFAULT_PROFILE.map((value) => value / 100);
}

function adjustedConsumptionDelta(
  rawDelta, batteryPower, durationMs, wallboxPower = 0, poolPower = 0, functionPower = 0,
  wallboxEnergyDelta = null
) {
  const raw = num(rawDelta) || 0;
  const power = num(batteryPower) || 0;
  const duration = Math.max(0, Number(durationMs) || 0);
  // Batterie-Leistung: positiv = laden, negativ = entladen.
  // Gesamtverbrauch enthält Laden und unterschlägt Entladen → signiert abziehen.
  const wallbox = Math.max(0, num(wallboxPower) || 0);
  const measuredWallboxKwh = num(wallboxEnergyDelta);
  const pool = Math.max(0, num(poolPower) || 0);
  const functions = Math.max(0, num(functionPower) || 0);
  const powerBasedCorrection = (power + pool + functions) * duration / 3600000000;
  const wallboxCorrection = measuredWallboxKwh == null
    ? wallbox * duration / 3600000000
    : Math.max(0, measuredWallboxKwh);
  // Bewusst NICHT bei 0 kappen: kleine negative Deltas (Bilanz-Sägezahn beim
  // Akku-Laden) müssen die zuvor gelernten Aufwärtsspitzen wieder ausgleichen.
  // Die Stunden-/Tagessummen werden erst beim Aufsummieren bei 0 begrenzt.
  return raw - powerBasedCorrection - wallboxCorrection;
}

// Tagesziel eines Wochentags ohne eigene Lerntage: Vorlage ist ausschließlich
// der jüngste abgeschlossene Lerntag ("Lernkurve des Vortages"). Erst wenn es
// noch gar keinen vollen Tag gibt, greifen gleitender Mittelwert, Jahreswert
// und zuletzt eine vorsichtige Hochrechnung des heutigen Verlaufs. Die frühere
// Hochrechnung `heute / Tagesanteil` als Erstwahl konnte morgens explodieren,
// weil der kleine Tagesanteil aus einer noch ungelernten Profilform stammt.
function selectUnlearnedDailyTarget({ today, elapsedShare, previousDayKwh, recentAverage, annualAverage }) {
  if (previousDayKwh > 0) return previousDayKwh;
  if (recentAverage > 0) return recentAverage;
  if (annualAverage > 0) return annualAverage;
  return elapsedShare >= 0.3 && today >= 1 ? today / elapsedShare : 0;
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
    `SELECT consumption_kwh, raw_consumption_kwh, updated_at
       FROM prognosis_daily_consumption WHERE day_key = ?`,
    [key]
  );
  // Ein neuer lokaler Tag beginnt im Lernmodell immer bei 0. Das erste gelesene
  // Tagestotal ist ausschließlich die Differenz-Basis. Externe Tageszähler
  // springen häufig erst einige Sekunden/Minuten nach unserer lokalen
  // Mitternacht zurück; würde ihr alter Stand hier als heutiger Verbrauch
  // übernommen, enthielte der neue Tag den kompletten Vortag.
  let adjustedTotal = 0;

  // Nur kurze, plausible Intervalle integrieren. So erzeugt ein Neustart nach
  // Stunden keine künstliche Lastspitze, der Tageszähler selbst bleibt aber korrekt.
  if (previous) {
    const rawBefore = num(previous.raw_consumption_kwh) ?? num(previous.consumption_kwh) ?? 0;
    const rawDelta = total - rawBefore;
    const age = timestamp - Number(previous.updated_at || 0);
    let previousAdjusted = num(previous.consumption_kwh) || 0;
    // Tages- und Stundenwert werden aus denselben plausibilisierten Deltas
    // aufgebaut. Alte Versionen konnten große Korrekturausreißer ausschließlich
    // in den Tageswert schreiben. Einen solchen belegbaren Drift reparieren wir
    // beim nächsten Sample aus der Summe der plausiblen Stundenwerte.
    const hourly = await dbGet(
      db,
      'SELECT COALESCE(SUM(consumption_kwh), 0) AS total FROM prognosis_hourly_consumption WHERE day_key = ?',
      [key]
    );
    const hourlyTotal = num(hourly && hourly.total) || 0;
    if (previousAdjusted - hourlyTotal > MAX_SAMPLE_DELTA_KWH) previousAdjusted = hourlyTotal;
    const batteryPower = num(options.batteryPower) || 0;
    // Kleine negative Deltas (Bilanz-Sägezahn) sind gültig und werden
    // gegengerechnet. Ein großer Rücksprung ist der verspätete Reset eines
    // Quellzählers: raw_consumption_kwh wird unten auf den neuen Stand basiert,
    // der bereits integrierte heutige Verbrauch bleibt unverändert.
    const validInterval = rawDelta > -MAX_NEGATIVE_SAMPLE_DELTA_KWH && rawDelta < 2 &&
      age > 0 && age <= 5 * 60 * 1000;
    const candidateDelta = validInterval
      ? adjustedConsumptionDelta(
        rawDelta, batteryPower, age, options.wallboxPower, options.poolPower,
        options.functionPower, options.wallboxEnergyDelta
      )
      : 0;
    // Auch bei einem formal gültigen Rohintervall kann ein fehlerhafter oder
    // falsch skalierter Leistungswert die Akku-Korrektur explodieren lassen.
    // In diesem Fall bleibt der begrenzte Rohfortschritt die sicherere Näherung.
    // Nach unten symmetrisch begrenzen: mehr als der zulässige Sägezahn wird
    // nie gegengerechnet.
    const boundedCandidate = Math.max(candidateDelta, -MAX_NEGATIVE_SAMPLE_DELTA_KWH);
    const adjustedDelta = boundedCandidate <= MAX_SAMPLE_DELTA_KWH
      ? boundedCandidate
      : Math.min(Math.max(0, rawDelta), MAX_SAMPLE_DELTA_KWH);
    adjustedTotal = Math.max(0, previousAdjusted + adjustedDelta);
    if (adjustedDelta !== 0 && adjustedDelta <= MAX_SAMPLE_DELTA_KWH) {
      await dbRun(
        db,
        `INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, primary_kwh)
         VALUES (?, ?, MAX(0, ?), MAX(0, ?))
         ON CONFLICT(day_key, hour) DO UPDATE SET
          consumption_kwh=MAX(0, prognosis_hourly_consumption.consumption_kwh + ?),
          primary_kwh=MAX(0, COALESCE(prognosis_hourly_consumption.primary_kwh, 0) + ?)`,
        [key, hour, adjustedDelta, adjustedDelta, adjustedDelta, adjustedDelta]
      );
    }
  }

  await dbRun(
    db,
    `INSERT INTO prognosis_daily_consumption
      (day_key, consumption_kwh, raw_consumption_kwh, completed, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(day_key) DO UPDATE SET
      consumption_kwh=excluded.consumption_kwh,
      raw_consumption_kwh=excluded.raw_consumption_kwh,
      completed=0, updated_at=excluded.updated_at`,
    [key, adjustedTotal, total, timestamp]
  );

  await dbRun(db, 'UPDATE prognosis_daily_consumption SET completed = 1 WHERE day_key <> ? AND completed = 0', [key]);
  await dbRun(db, 'DELETE FROM prognosis_daily_consumption WHERE day_key < date(?, \'-400 days\')', [key]);
  await dbRun(db, 'DELETE FROM prognosis_hourly_consumption WHERE day_key < date(?, \'-90 days\')', [key]);
  invalidateConsumptionModel(db);
}

function elapsedDayCount(localDate) {
  const start = Date.UTC(localDate.year, 0, 1);
  const current = Date.UTC(localDate.year, localDate.month - 1, localDate.day);
  return Math.max(0, Math.round((current - start) / 86400000));
}

async function buildConsumptionModelUncached(db, strom, config, cache, forecast = null, storage = null) {
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
  const poolModel = await loadPoolEnergyModel(db);
  const functionModels = await loadFunctionModels(db, key).catch(() => null);
  const previousHour = shiftLocalParts(local, -60);
  // Alle bereits gelernten Stunden des heutigen Tages: Grundlage der laufenden
  // Kalibrierung und der Ist/Soll-Darstellung auf der Prognoseseite.
  const todayHourRows = await dbAll(
    db,
    'SELECT hour, consumption_kwh, primary_kwh, self_kwh FROM prognosis_hourly_consumption WHERE day_key = ?',
    [key]
  );
  const todayByHour = Array(24).fill(null);
  // Transparenz-Serien: in die Prognose eingeflossener Wert (chosen), die
  // zähler-/bilanzbasierte Quelle (primary) und die Selbstzählung (self).
  const todayPrimaryByHour = Array(24).fill(null);
  const todaySelfByHour = Array(24).fill(null);
  for (const row of todayHourRows) {
    const hourIndex = clamp(Number(row.hour) || 0, 0, 23);
    todayByHour[hourIndex] = (todayByHour[hourIndex] || 0) + (num(row.consumption_kwh) || 0);
    const primaryValue = num(row.primary_kwh);
    if (primaryValue != null) todayPrimaryByHour[hourIndex] = (todayPrimaryByHour[hourIndex] || 0) + primaryValue;
    const selfValue = num(row.self_kwh);
    if (selfValue != null) todaySelfByHour[hourIndex] = (todaySelfByHour[hourIndex] || 0) + selfValue;
  }
  const previousHourRow = previousHour.date && dateKey(previousHour.date) === key
    ? todayHourRows.find((row) => Number(row.hour) === Number(previousHour.time.hours))
    : await dbGet(
      db,
      'SELECT consumption_kwh FROM prognosis_hourly_consumption WHERE day_key = ? AND hour = ?',
      [dateKey(previousHour.date), previousHour.time.hours]
    );
  const currentHourEnergy = todayByHour[clamp(Number(local.time.hours) || 0, 0, 23)];
  const previousHourEnergy = num(previousHourRow && previousHourRow.consumption_kwh);
  const currentHourFraction = local.time.minutes / 60;
  const todayRow = await dbGet(
    db,
    'SELECT consumption_kwh FROM prognosis_daily_consumption WHERE day_key = ?',
    [key]
  );
  const rawToday = Math.max(0, num(strom.breakdown.today.eigenverbrauch) || 0);
  const today = Math.max(
    0,
    num(todayRow && todayRow.consumption_kwh) ?? rawToday
  );
  const year = num(strom.breakdown.year.eigenverbrauch);
  const previousYear = num(strom.breakdown.previousYear.eigenverbrauch);
  const climateTotals = await dbAll(
    db,
    `SELECT substr(day_key, 1, 4) AS year_key, COALESCE(SUM(consumption_kwh), 0) AS total
       FROM mess_schalt_function_hourly
      WHERE substr(day_key, 1, 4) IN (?, ?)
      GROUP BY substr(day_key, 1, 4)`,
    [String(local.date.year), String(local.date.year - 1)]
  ).catch(() => []);
  const functionsByYear = new Map(climateTotals.map((row) => [String(row.year_key), num(row.total) || 0]));
  // Der Stromverbrauch ist zentral bereits um die Netto-Akkuladung bereinigt.
  // Wallbox-, Pool- und Funktionslasten werden für den Haus-Grundverbrauch
  // weiterhin separat herausgerechnet.
  const houseYear = year == null ? null
    : Math.max(0, year - wallboxModel.yearKwh - poolModel.yearKwh -
      (functionsByYear.get(String(local.date.year)) || 0));
  const housePreviousYear = previousYear == null ? null
    : Math.max(0, previousYear - wallboxModel.previousYearKwh - poolModel.previousYearKwh -
      (functionsByYear.get(String(local.date.year - 1)) || 0));
  const completedDays = elapsedDayCount(local.date);
  const annualAverage = completedDays > 0 && houseYear != null
    ? Math.max(0, houseYear - today) / completedDays
    : (housePreviousYear != null && housePreviousYear > 0 ? housePreviousYear / 365 : null);

  const dailyRows = await dbAll(db,
    `SELECT day_key, consumption_kwh FROM prognosis_daily_consumption
     WHERE completed = 1 AND day_key < ? ORDER BY day_key DESC LIMIT ?`,
    [key, config.historyDays]
  );
  const dailyValues = dailyRows
    .map((row) => num(row.consumption_kwh))
    .filter((value) => value != null && value > 0)
    .sort((a, b) => a - b);
  const median = dailyValues.length
    ? dailyValues[Math.floor(dailyValues.length / 2)]
    : null;
  let weight = 0;
  let weightedTotal = 0;
  dailyRows.forEach((row, index) => {
    const value = num(row.consumption_kwh);
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
  const previousDayRaw = Array(24).fill(0);
  const previousDayKey = dailyRows.length ? dailyRows[0].day_key : null;
  let previousDayHasHours = false;
  hourlyRows.forEach((row) => {
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
    if (row.day_key === previousDayKey) {
      previousDayRaw[hourIndex] += share;
      previousDayHasHours = true;
    }
  });
  const learned = normalizedProfile(learnedRaw);
  const fallback = normalizedProfile(DEFAULT_PROFILE);
  const profileWeight = Math.min(1, dailyRows.length / 14);
  // Vorlage für alle noch ungelernten Wochentage ist ausschließlich die
  // Stundenkurve des jüngsten abgeschlossenen Lerntags. Erst ganz ohne
  // abgeschlossenen Tag greift die generische BDEW-Form als Kaltstart.
  const previousDayCurve = previousDayHasHours ? normalizedProfile(previousDayRaw) : null;
  const baseProfile = previousDayCurve ||
    fallback.map((value, hour) => value * (1 - profileWeight) + learned[hour] * profileWeight);
  const profilesByWeekday = weekdayRaw.map((raw, weekday) => {
    const learnedDays = weekdayProfileDays[weekday].size;
    if (!learnedDays) return baseProfile.slice();
    const learnedWeekday = normalizedProfile(raw);
    const weekdayWeight = Math.min(1, learnedDays / 6);
    return baseProfile.map(
      (value, hourIndex) => value * (1 - weekdayWeight) + learnedWeekday[hourIndex] * weekdayWeight
    );
  });
  const profile = baseProfile;

  const currentWeekday = weekdayForDateKey(key);
  const currentProfile = profilesByWeekday[currentWeekday] || profile;
  const hour = clamp(Number(local.time.hours) || 0, 0, 23);
  const minute = clamp(Number(local.time.minutes) || 0, 0, 59);
  const elapsedShare = currentProfile.slice(0, hour).reduce((sum, value) => sum + value, 0) +
    currentProfile[hour] * minute / 60;
  // Ungelernte Wochentage übernehmen den jüngsten abgeschlossenen Lerntag als
  // Vorlage; die Tageskalibrierung unten passt ihn an den heutigen Verlauf an.
  const previousDayKwh = dailyRows.length ? num(dailyRows[0].consumption_kwh) : null;
  const unlearnedDailyTarget = selectUnlearnedDailyTarget({
    today, elapsedShare, previousDayKwh, recentAverage, annualAverage,
  });
  const dailyTargetsByWeekday = Array(7).fill(unlearnedDailyTarget);
  const weekdayDailyCounts = Array(7).fill(0);
  for (let weekday = 0; weekday < 7; weekday += 1) {
    let weekdayWeightTotal = 0;
    let weekdayWeightedEnergy = 0;
    dailyRows.forEach((row, index) => {
      if (weekdayForDateKey(row.day_key) !== weekday) return;
      const value = num(row.consumption_kwh);
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
      dailyTargetsByWeekday[weekday] = (unlearnedDailyTarget || weekdayAverage) * (1 - weekdayLevelWeight) +
        weekdayAverage * weekdayLevelWeight;
    }
  }

  dailyTarget = dailyTargetsByWeekday[currentWeekday] || unlearnedDailyTarget;
  if (!(dailyTarget > 0) && elapsedShare > 0.05) dailyTarget = today / elapsedShare;
  if (!(dailyTarget > 0)) dailyTarget = 0;

  const expectedSoFar = dailyTarget * elapsedShare;
  const intradayFactor = expectedSoFar > 0.5
    ? clamp(today / expectedSoFar, 0.75, 1.35)
    : 1;
  const remainingByHour = currentProfile.map((share, index) => {
    if (index < hour) return 0;
    if (index === hour) return dailyTarget * intradayFactor * share * (1 - minute / 60);
    return dailyTarget * intradayFactor * share;
  });

  const wallboxPlanningSlots = buildWallboxPlanningSlots({
    forecast, local, remainingByHour, profilesByWeekday, dailyTargetsByWeekday,
    profile: currentProfile, dailyTarget, functionModels, poolModel,
  });

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
  return {
    local, today, rawToday, annualAverage, recentAverage, dailyTarget,
    expectedToday: today + remainingByHour.reduce((sum, value) => sum + value, 0),
    remainingToday: remainingByHour.reduce((sum, value) => sum + value, 0),
    intradayFactor, profile: currentProfile, profilesByWeekday, dailyTargetsByWeekday,
    weekdayProfileDays: weekdayProfileDays.map((days) => days.size), weekdayDailyCounts,
    currentWeekday, previousDayKey, previousDayKwh,
    wallboxModel, poolModel, functionModels, todayByHour,
    todayPrimaryByHour, todaySelfByHour,
    remainingByHour, recentHourKwh, hoursToSunrise, consumptionToSunrise: null,
    _wallboxPlanningSlots: wallboxPlanningSlots,
    historyDays: dailyRows.length,
  };
}

const MODEL_CACHE_MS = 30000;
const modelCache = new WeakMap();
const modelInFlight = new WeakMap();

function consumptionFingerprint(strom, config, forecast) {
  const today = strom && strom.breakdown && strom.breakdown.today
    ? strom.breakdown.today.eigenverbrauch : null;
  return JSON.stringify([
    today,
    config && config.historyDays,
    config && config.chargeEfficiency,
    config && config.dischargeEfficiency,
    forecast && forecast.fetchedAt,
  ]);
}

function materializeConsumptionModel(base, storage, forecast) {
  // Planung mutiert Wallboxen und Slots. Jeder Verbraucher bekommt deshalb
  // eine eigene Kopie; das gecachte Basismodell bleibt garantiert unverändert.
  const model = structuredClone(base);
  planWallboxSchedule(model.wallboxModel, model._wallboxPlanningSlots, storage);
  delete model._wallboxPlanningSlots;
  model.consumptionToSunrise = projectedConsumptionForHours(model, forecast, model.hoursToSunrise);
  return model;
}

async function buildConsumptionModel(db, strom, config, cache, forecast = null, storage = null) {
  const fingerprint = consumptionFingerprint(strom, config, forecast);
  const cached = modelCache.get(db);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < MODEL_CACHE_MS) {
    metrics.counter('consumptionModel.cacheHit');
    return materializeConsumptionModel(cached.value, storage, forecast);
  }
  const pending = modelInFlight.get(db);
  if (pending && pending.fingerprint === fingerprint) {
    metrics.counter('consumptionModel.shared');
    return materializeConsumptionModel(await pending.promise, storage, forecast);
  }
  const promise = metrics.measure('consumptionModel.build', () =>
    buildConsumptionModelUncached(db, strom, config, cache, forecast));
  modelInFlight.set(db, { fingerprint, promise });
  try {
    const value = await promise;
    modelCache.set(db, { fingerprint, at: Date.now(), value });
    return materializeConsumptionModel(value, storage, forecast);
  } finally {
    const current = modelInFlight.get(db);
    if (current && current.promise === promise) modelInFlight.delete(db);
  }
}

function invalidateConsumptionModel(db) {
  if (db) modelCache.delete(db);
}

function forecastPvForHour(forecast, dayKeyValue, hour) {
  if (!forecast || !Array.isArray(forecast.hours)) return 0;
  return forecast.hours
    .filter((slot) => slot.dateKey === dayKeyValue && Number(slot.hour) === hour)
    .reduce((sum, slot) => sum + (num(slot.kwh) || 0), 0);
}

function buildWallboxPlanningSlots({
  forecast, local, remainingByHour, profilesByWeekday,
  dailyTargetsByWeekday, profile, dailyTarget, functionModels, poolModel,
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
      const functionsKwh = functionsLoadForHour(functionModels, forecast, day.dateKey, hour, durationHours);
      const poolKwh = poolLoadForHour(poolModel, forecast, day.dateKey, hour, durationHours, null).totalKwh;
      slots.push({
        dateKey: day.dateKey,
        dayIndex,
        hour,
        durationHours,
        startMs: dayIndex === 0 && hour === currentHour
          ? nowMs
          : nowMs + ((dayIndex * 24 + hour) - nowDecimal) * 3600000,
        pvKwh: rawPv[hour] * pvScale,
        houseKwh: Math.max(0, base || 0) + functionsKwh + poolKwh,
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
  const chargeEfficiency = (num(batteryConfig.chargeEfficiency) ?? num(config.chargeEfficiency) ?? 95) / 100;
  const dischargeEfficiency = (num(batteryConfig.dischargeEfficiency) ?? num(config.dischargeEfficiency) ?? 95) / 100;
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
    let functionsKwh = 0;
    let houseLoadKwh = 0;
    let wallboxKwh = 0;
    let poolKwh = 0;
    let poolSolarKwh = 0;
    let poolFilterKwh = 0;
    let reachedFull = false;
    let chargeStartSoc = null;
    let chargeStartHour = null;
    // Erwartete Stundenlast des Tages (Haus + Funktionen + Wallbox + Pool) für
    // das 24-h-Balkendiagramm; bereits verstrichene Stunden von heute sind null.
    const hourlyLoadKwh = Array(24).fill(null);
    const weekday = weekdayForDateKey(pvDay.dateKey);
    const dayProfile = model.profilesByWeekday && model.profilesByWeekday[weekday]
      ? model.profilesByWeekday[weekday]
      : model.profile;
    const dayTarget = model.dailyTargetsByWeekday && model.dailyTargetsByWeekday[weekday] != null
      ? model.dailyTargetsByWeekday[weekday]
      : model.dailyTarget;
    const wallboxForecast = wallboxForecastForDay(model.wallboxModel, pvDay.dateKey, dayIndex);
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
      const houseLoad = dayIndex === 0 ? model.remainingByHour[hour] : dayTarget * dayProfile[hour];
      const wallboxLoad = wallboxForecast.hourly[hour] || 0;
      const currentBatterySoc = capacity > 0 ? minSoc + stored / capacity * 100 : minSoc;
      const durationHours = dayIndex === 0 && hour === currentHour ? 1 - currentMinute / 60 : 1;
      const functionsLoad = functionsLoadForHour(model.functionModels, forecast, pvDay.dateKey, hour, durationHours);
      const poolLoad = poolLoadForHour(model.poolModel, forecast, pvDay.dateKey, hour, durationHours, currentBatterySoc);
      let load = houseLoad + functionsLoad + wallboxLoad + poolLoad.totalKwh;
      let pv = pvHourly[hour] * pvScale;
      load = Math.max(0, load || 0);
      pv = Math.max(0, pv || 0);
      loadKwh += load;
      houseLoadKwh += houseLoad;
      wallboxKwh += wallboxLoad;
      poolKwh += poolLoad.totalKwh;
      poolSolarKwh += poolLoad.solarKwh;
      poolFilterKwh += poolLoad.filterKwh;
      functionsKwh += functionsLoad;
      hourlyLoadKwh[hour] = load;
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
      functionsKwh,
      houseLoadKwh,
      wallboxKwh,
      poolKwh,
      poolSolarKwh,
      poolFilterKwh,
      wallboxes: wallboxForecast.perBox,
      hourlyLoadKwh,
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
  const [plants, prognosisConfig, batteryConfig, strom] = await Promise.all([
    listPvPlants(db), loadPrognosisConfig(db),
    new Promise((resolve) => loadBatterieConfig(db, resolve)),
    readStromverbrauchValues(db, cache),
  ]);
  const config = {
    ...prognosisConfig,
    chargeEfficiency: batteryConfig.chargeEfficiency,
    dischargeEfficiency: batteryConfig.dischargeEfficiency,
  };
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
  invalidateConsumptionModel, materializeConsumptionModel,
  normalizedProfile, adjustedConsumptionDelta, simulateDays,
  selectUnlearnedDailyTarget, MAX_NEGATIVE_SAMPLE_DELTA_KWH,
  hoursUntilNextSunrise, projectedConsumptionForHours, buildWallboxPlanningSlots,
};
