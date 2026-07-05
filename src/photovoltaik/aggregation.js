'use strict';

const { loadMqttConfig, buildEnvironmentSnapshot } = require('../mqtt/config');
const { converterEfficiency } = require('./converters');
const { loadFactors, currentBucket, getFactor, effectiveFactor } = require('./calibration');
const { DEFAULT_SUN_CUTOFF_PERCENT } = require('./plants');
const { recordDailyMetric } = require('../history/daily-metrics');

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function getDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getWeekKey(date = new Date()) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = local.getDay() || 7;
  local.setDate(local.getDate() + 4 - day);
  const yearStart = new Date(local.getFullYear(), 0, 1);
  const week = Math.ceil((((local - yearStart) / 86400000) + 1) / 7);
  return `${local.getFullYear()}-W${pad(week)}`;
}

function getYearKey(date = new Date()) {
  return String(date.getFullYear());
}

function getCacheValue(cache, key) {
  const entry = cache.get(key);
  return entry ? parseNumber(entry.value) : null;
}

function formatPower(value) {
  if (value == null) return '— W';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value)} W`;
}

function formatEnergy(value) {
  if (value == null) return '— kWh';
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} kWh`;
}

function formatFactor(value) {
  if (value == null) return '—';
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// tempCoeff: relativer Wirkungsgradverlust je °C Außentemperatur oberhalb von 20°C
//   (zelltyp-spezifischer Temperaturkoeffizient der Leistung).
// directThreshold: Anteil Ist-/Idealleistung, ab dem direkte Sonneneinstrahlung
//   angenommen wird. Zelltypen mit besserem Schwachlicht-/Diffuslichtverhalten
//   (z. B. Duennschicht, HJT) liefern auch bei Bewölkung einen höheren Anteil am
//   Klarhimmel-Idealwert und brauchen daher eine höhere Schwelle.
const CELL_TYPE_PARAMETERS = {
  Monokristallin: { tempCoeff: -0.0040, directThreshold: 0.55 },
  Polykristallin: { tempCoeff: -0.0043, directThreshold: 0.52 },
  Duennschicht: { tempCoeff: -0.0025, directThreshold: 0.62 },
  Bifazial: { tempCoeff: -0.0035, directThreshold: 0.58 },
  TOPCon: { tempCoeff: -0.0032, directThreshold: 0.55 },
  HJT: { tempCoeff: -0.0026, directThreshold: 0.60 },
  PERC: { tempCoeff: -0.0034, directThreshold: 0.55 },
  Sonstiges: { tempCoeff: -0.0040, directThreshold: 0.55 },
};

// Sonnenreferenz-Cutoff (Watt) einer Anlage zum aktuellen Sonnenstand: Der
// Klarhimmel-Idealwert muss mindestens diesen Anteil der kWp-Spitzenleistung
// erreichen, damit die Anlage als verlässliche Sonnenreferenz gilt. Skaliert mit
// der Anlagengröße – anders als ein absoluter Watt-Wert: Eine große Südanlage hat
// morgens (Sonne im Osten) nur einen winzigen Idealwert relativ zu ihrer Größe und
// liefert dann trotz Bewölkung aus Diffuslicht viel mehr als ihr Ideal, was das
// Ist/Ideal-Verhältnis verfälschen würde. Der Prozentwert ist je Anlage getrennt
// für morgens (vor Sonnenhöchststand) und abends konfigurierbar (Default 10 %).
function sunCutoffWatt(plant, solarContext) {
  const kwPeak = parseNumber(plant.kwPeak);
  if (kwPeak == null || kwPeak <= 0) return null;
  const isMorning = solarContext.decimalHours == null || solarContext.decimalHours < 12;
  const rawPercent = isMorning ? plant.sunCutoffMorning : plant.sunCutoffEvening;
  const percent = parseNumber(rawPercent);
  const fraction = (percent == null ? DEFAULT_SUN_CUTOFF_PERCENT : percent) / 100;
  return kwPeak * 1000 * fraction;
}

// Ob eine Anlage aktuell als Sonnenreferenz taugt (Sonne scheint brauchbar auf ihre
// Modulebene). Bewertet wird der reine Klarhimmel-Idealwert (idealBase, vor
// Auto-Kalibrierung) gegen den größenrelativen Cutoff.
function isSunReference(plant, idealBase, solarContext) {
  if (idealBase == null || idealBase <= 0) return false;
  const cutoffWatt = sunCutoffWatt(plant, solarContext);
  if (cutoffWatt == null) return false;
  return idealBase >= cutoffWatt;
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function normalizeAzimuth(value) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function getCellTypeParameters(cellType) {
  return CELL_TYPE_PARAMETERS[cellType] || CELL_TYPE_PARAMETERS.Sonstiges;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function getDayOfYear(year, month, day) {
  const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let total = 0;
  for (let index = 0; index < month - 1; index += 1) total += monthLengths[index];
  return total + day;
}

function loadMqttSettings(db) {
  return new Promise((resolve) => loadMqttConfig(db, resolve));
}

// Zeitgleichung (Equation of Time) in Minuten: Differenz zwischen wahrer und
// mittlerer Sonnenzeit durch Erdbahn-Exzentrizität und Achsneigung (±~16 min).
function getEquationOfTimeMinutes(dayOfYear) {
  const b = degToRad((360 / 365) * (dayOfYear - 81));
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

// UTC-Versatz (Minuten) einer Zeitzone zum gegebenen Zeitpunkt; positiv = östlich
// von UTC. Nutzt Intl, das die DST-Regeln der Zone kennt. null bei ungültiger Zone.
function getZoneOffsetMinutes(timeZone, instant) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const map = {};
    for (const part of dtf.formatToParts(instant)) {
      if (part.type !== 'literal') map[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
    return Math.round((asUtc - instant.getTime()) / 60000);
  } catch (_) {
    return null;
  }
}

// Standard-(Winter-)Versatz einer Zone: die Sommerzeit verschiebt die Uhr stets
// vor, daher ist der Standardversatz das Minimum über das Jahr (Jan/Jul deckt
// beide Hemisphären ab).
function getStandardOffsetMinutes(timeZone, year) {
  const jan = getZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 1, 12)));
  const jul = getZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 1, 12)));
  if (jan == null || jul == null) return null;
  return Math.min(jan, jul);
}

function observesDst(config) {
  const value = config.dstEnabled;
  if (value == null) return true;
  if (typeof value === 'boolean') return value;
  return Number(value) !== 0;
}

// Aktiver UTC-Versatz (Stunden) der per MQTT gelieferten lokalen Wanduhrzeit am
// angegebenen Datum. Folgt die Uhr der automatischen Zeitumstellung, gilt im
// Sommer der DST-Versatz; ist sie deaktiviert, ganzjährig der Standardversatz.
// null, wenn keine gültige Zeitzone hinterlegt ist.
function resolveUtcOffsetHours(config, dateParts, timeParts) {
  const timeZone = config.timezone;
  if (!timeZone) return null;

  const guess = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day,
      timeParts.hours,
      timeParts.minutes,
      timeParts.seconds == null ? 0 : timeParts.seconds
    )
  );
  let offsetMin = getZoneOffsetMinutes(timeZone, guess);
  if (offsetMin == null) return null;

  // guess interpretierte die Wanduhrzeit als UTC; mit dem Erstversatz den echten
  // UTC-Moment annähern und den Versatz dort final bestimmen (DST-Umschaltgrenzen).
  const realInstant = new Date(guess.getTime() - offsetMin * 60000);
  const refined = getZoneOffsetMinutes(timeZone, realInstant);
  if (refined != null) offsetMin = refined;

  if (!observesDst(config)) {
    const standard = getStandardOffsetMinutes(timeZone, dateParts.year);
    if (standard != null) offsetMin = standard;
  }
  return offsetMin / 60;
}

// Sonnenstands-Geometrie (Tag im Jahr + wahre Ortssonnenzeit) für ein beliebiges
// lokales Datum/Uhrzeit. Aus buildSolarContext herausgelöst, damit auch die
// Prognose (forecast.js) die Geometrie für künftige Stunden bestimmen kann.
//
// Wanduhrzeit → wahre Ortssonnenzeit. Der Stundenwinkel (15° je Stunde ab
// Sonnenhöchststand) verlangt die Sonnenzeit am Standort, nicht die Zonenzeit.
// Korrektur = Längengrad-Versatz zum Zeitzonen-Bezugsmeridian + Zeitgleichung,
// ausgehend von UTC (Wanduhrzeit minus aktivem Zonenversatz inkl. DST). Nur
// möglich, wenn Längengrad UND (über die Zeitzone) der UTC-Versatz vorliegen;
// sonst gilt die unkorrigierte lokale Uhrzeit.
function solarGeometryAt(config, dateParts, timeParts) {
  const latitude = parseNumber(config.latitude);
  const longitude = parseNumber(config.longitude);

  const dayOfYear = getDayOfYear(dateParts.year, dateParts.month, dateParts.day);
  const localDecimalHours =
    timeParts.hours +
    timeParts.minutes / 60 +
    (timeParts.seconds == null ? 0 : timeParts.seconds / 3600);

  let decimalHours = localDecimalHours;
  const offsetHours = resolveUtcOffsetHours(config, dateParts, timeParts);
  if (longitude != null && offsetHours != null) {
    const utcDecimalHours = localDecimalHours - offsetHours;
    const equationOfTimeHours = getEquationOfTimeMinutes(dayOfYear) / 60;
    decimalHours = utcDecimalHours + longitude / 15 + equationOfTimeHours;
  }

  return { latitude, longitude, dayOfYear, decimalHours };
}

function buildSolarContext(config, cache) {
  const environment = buildEnvironmentSnapshot(cache);
  const now = new Date();

  const dateParts =
    environment.date && environment.date.year != null
      ? {
          year: environment.date.year,
          month: environment.date.month,
          day: environment.date.day,
        }
      : {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          day: now.getDate(),
        };

  const timeParts =
    environment.time && environment.time.hours != null
      ? {
          hours: environment.time.hours,
          minutes: environment.time.minutes,
          seconds: environment.time.seconds,
        }
      : {
          hours: now.getHours(),
          minutes: now.getMinutes(),
          seconds: now.getSeconds(),
        };

  const geometry = solarGeometryAt(config, dateParts, timeParts);
  return {
    latitude: geometry.latitude,
    longitude: geometry.longitude,
    ambientTemperature: environment.temperature.value,
    dayOfYear: geometry.dayOfYear,
    decimalHours: geometry.decimalHours,
  };
}

// Projiziert gegebene Strahlungskomponenten auf die geneigte Modulebene
// (Plane-of-Array): Direktstrahlung über den Inzidenzwinkel, Himmelsdiffus über
// den Sichtfaktor zum Himmel, Bodenreflexion (Albedo 0.2) über den Sichtfaktor
// zum Boden. dni/dhi/ghi werden extern geliefert — aus dem Clear-Sky-Modell
// (calculatePlaneIrradiance) ODER aus der Wetterprognose (forecast.js), wodurch
// Live-Ideal und Prognose dieselbe Geometrie teilen.
function transposePlaneIrradiance({ dayOfYear, decimalHours, latitude, azimuth, tilt, dni, dhi, ghi }) {
  if (latitude == null) return null;

  const declination = degToRad(23.45 * Math.sin(degToRad((360 * (284 + dayOfYear)) / 365)));
  const hourAngle = degToRad(15 * (decimalHours - 12));
  const latitudeRad = degToRad(latitude);
  const tiltRad = degToRad(tilt);
  const azimuthRad = degToRad(normalizeAzimuth(azimuth));

  const up =
    Math.sin(latitudeRad) * Math.sin(declination) +
    Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  if (up <= 0) return 0;

  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north =
    Math.cos(latitudeRad) * Math.sin(declination) -
    Math.sin(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);

  const panelNormalEast = Math.sin(tiltRad) * Math.sin(azimuthRad);
  const panelNormalNorth = Math.sin(tiltRad) * Math.cos(azimuthRad);
  const panelNormalUp = Math.cos(tiltRad);

  const cosIncidence =
    east * panelNormalEast + north * panelNormalNorth + up * panelNormalUp;

  const directNormal = dni == null ? 0 : Math.max(0, dni);
  const diffuseHorizontal = dhi == null ? 0 : Math.max(0, dhi);
  const globalHorizontal = ghi == null ? 0 : Math.max(0, ghi);
  const diffusePlane = diffuseHorizontal * ((1 + Math.cos(tiltRad)) / 2);
  const reflectedPlane = globalHorizontal * 0.2 * ((1 - Math.cos(tiltRad)) / 2);

  return Math.max(0, directNormal * Math.max(0, cosIncidence) + diffusePlane + reflectedPlane);
}

function calculatePlaneIrradiance(dayOfYear, decimalHours, latitude, azimuth, tilt) {
  if (latitude == null) return null;

  const declination = degToRad(23.45 * Math.sin(degToRad((360 * (284 + dayOfYear)) / 365)));
  const hourAngle = degToRad(15 * (decimalHours - 12));
  const latitudeRad = degToRad(latitude);

  const up =
    Math.sin(latitudeRad) * Math.sin(declination) +
    Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  if (up <= 0) return 0;

  // Clear-Sky-Strahlungsmodell: Direktnormalstrahlung aus Luftmasse + einfacher
  // Diffus-/Globalstrahlungsabschätzung; die Projektion auf die Modulebene
  // übernimmt der gemeinsame Helfer transposePlaneIrradiance.
  const elevationDeg = radToDeg(Math.asin(up));
  const airMass =
    1 /
    (up + 0.50572 * Math.pow(Math.max(elevationDeg, 0.1) + 6.07995, -1.6364));
  const extraterrestrial = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365));
  const directNormal = extraterrestrial * Math.pow(0.7, Math.pow(airMass, 0.678));
  const diffuseHorizontal = directNormal * 0.12 * up;
  const globalHorizontal = directNormal * up + diffuseHorizontal;

  return transposePlaneIrradiance({
    dayOfYear,
    decimalHours,
    latitude,
    azimuth,
    tilt,
    dni: directNormal,
    dhi: diffuseHorizontal,
    ghi: globalHorizontal,
  });
}

function calculateIdealPlantPower(plant, solarContext) {
  const azimuth = parseNumber(plant.orientation);
  const tilt = parseNumber(plant.tilt);
  const kwPeak = parseNumber(plant.kwPeak);
  const efficiencyPercent = parseNumber(plant.efficiency);
  if (
    solarContext.latitude == null ||
    azimuth == null ||
    tilt == null ||
    kwPeak == null ||
    efficiencyPercent == null ||
    efficiencyPercent <= 0
  ) {
    return null;
  }

  const irradiance = calculatePlaneIrradiance(
    solarContext.dayOfYear,
    solarContext.decimalHours,
    solarContext.latitude,
    azimuth,
    tilt
  );
  if (irradiance == null || irradiance <= 0) return 0;

  return idealPowerFromIrradiance(plant, irradiance, solarContext.ambientTemperature);
}

// Idealleistung (W) einer Anlage aus der Strahlung auf die Modulebene (W/m²) und
// der Außentemperatur. Gemeinsame Skalierung für Live-Idealwert UND Prognose,
// damit beide denselben Wirkungsgrad-/Temperatur-/Konverter-Faktor verwenden.
function idealPowerFromIrradiance(plant, planeIrradiance, ambientTemperature) {
  const kwPeak = parseNumber(plant.kwPeak);
  const efficiencyPercent = parseNumber(plant.efficiency);
  if (kwPeak == null || efficiencyPercent == null || efficiencyPercent <= 0) return null;
  if (planeIrradiance == null || planeIrradiance <= 0) return 0;

  const { tempCoeff } = getCellTypeParameters(plant.cellType);
  const peakPowerWatt = kwPeak * 1000;
  // Einstrahlung relativ zur STC-Referenz (1000 W/m²) auf die kWp-Spitzenleistung skaliert.
  const irradianceRatio = planeIrradiance / 1000;
  // Der hinterlegte Wirkungsgrad wirkt als direkter Kalibrierfaktor des Idealwerts
  // (Gesamt-/Systemwirkungsgrad) und gilt als Bezugswert bei 20°C Außentemperatur.
  // Die zelltyp-spezifische Abweichung wird relativ zu dieser Außentemperatur angesetzt.
  const efficiencyFactor = efficiencyPercent / 100;
  const ambient = ambientTemperature == null ? 20 : ambientTemperature;
  const tempFactor = Math.max(0, 1 + tempCoeff * (ambient - 20));

  // Geräte-Wirkungsgrad des Konverters/Reglers (MPPT, Wechselrichter, …) inkl.
  // Temperaturdrosselung; die Geräte laufen etwa auf Außentemperaturniveau.
  const converterFactor = converterEfficiency(plant.converterType, ambientTemperature);

  return Math.max(
    0,
    peakPowerWatt * irradianceRatio * efficiencyFactor * tempFactor * converterFactor
  );
}

// Bewertet je Anlage, ob aktuell direkte Sonneneinstrahlung vorliegt: Vergleich der
// per MQTT gemeldeten Ist-Leistung mit dem zelltyp-/temperaturkorrigierten Idealwert.
// Rückgabe: true (direkte Sonne), false (diffus/bewölkt), null (keine Aussage möglich).
function assessDirectSunlight(plant, currentValue, idealValue, idealBase, solarContext) {
  if (currentValue == null || idealValue == null || idealValue <= 0) return null;
  // Nur bewerten, wenn die Anlage aktuell als Sonnenreferenz taugt (Sonne brauchbar
  // auf ihrer Ebene). Sonst liefert eine off-axis-Anlage aus Diffuslicht ein
  // verfälschtes Ist/Ideal-Verhältnis und würde fälschlich „direkte Sonne" melden.
  if (!isSunReference(plant, idealBase, solarContext)) return null;
  const { directThreshold } = getCellTypeParameters(plant.cellType);
  return currentValue / idealValue >= directThreshold;
}

function normalizeSummaryState(row = {}) {
  return {
    weekOffset: parseNumber(row.week_offset) || 0,
    yearOffset: parseNumber(row.year_offset) || 0,
    previousYearTotal: parseNumber(row.previous_year_total) || 0,
    lastTodayValue: parseNumber(row.last_today_value) || 0,
    lastRolloverDate: row.last_rollover_date || '',
    weekKey: row.week_key || '',
    yearKey: row.year_key || '',
  };
}

async function loadSummaryState(db) {
  const row = await dbGet(
    db,
    `SELECT week_offset, year_offset, previous_year_total, last_today_value, last_rollover_date, week_key, year_key
     FROM pv_summary_aggregation
     WHERE id = 1`
  );
  return normalizeSummaryState(row);
}

async function saveSummaryState(db, state) {
  await dbRun(
    db,
    `UPDATE pv_summary_aggregation
     SET week_offset = ?, year_offset = ?, previous_year_total = ?, last_today_value = ?, last_rollover_date = ?, week_key = ?, year_key = ?
     WHERE id = 1`,
    [
      state.weekOffset,
      state.yearOffset,
      state.previousYearTotal,
      state.lastTodayValue,
      state.lastRolloverDate,
      state.weekKey,
      state.yearKey,
    ]
  );
}

async function updateSummaryState(db, todayValue, now = new Date()) {
  const state = await loadSummaryState(db);
  const dateKey = getDateKey(now);
  const weekKey = getWeekKey(now);
  const yearKey = getYearKey(now);
  const safeTodayValue = todayValue == null ? 0 : todayValue;
  let changed = false;

  if (!state.lastRolloverDate) {
    state.lastRolloverDate = dateKey;
    state.weekKey = weekKey;
    state.yearKey = yearKey;
    state.lastTodayValue = safeTodayValue;
    changed = true;
  } else if (state.lastRolloverDate !== dateKey) {
    // Der gerade zu Ende gegangene Tag ist ab hier abgeschlossen – für die
    // Jahres-Statistik (Min/Max/Durchschnitt) im Wertekatalog historisieren,
    // bevor lastTodayValue/lastRolloverDate unten auf den neuen Tag zeigen.
    await recordDailyMetric(db, 'pv', state.lastRolloverDate, state.lastTodayValue);
    const finishedYearTotal = state.yearOffset + state.lastTodayValue;
    state.weekOffset = state.weekKey === weekKey ? state.weekOffset + state.lastTodayValue : 0;

    if (state.yearKey === yearKey) {
      state.yearOffset += state.lastTodayValue;
    } else {
      state.previousYearTotal = finishedYearTotal;
      state.yearOffset = 0;
    }

    state.lastRolloverDate = dateKey;
    state.weekKey = weekKey;
    state.yearKey = yearKey;
    state.lastTodayValue = safeTodayValue;
    changed = true;
  } else {
    if (state.weekKey !== weekKey) {
      state.weekOffset = 0;
      state.weekKey = weekKey;
      changed = true;
    }
    if (state.yearKey !== yearKey) {
      state.previousYearTotal = state.yearOffset + state.lastTodayValue;
      state.yearOffset = 0;
      state.yearKey = yearKey;
      changed = true;
    }
    if (state.lastTodayValue !== safeTodayValue) {
      state.lastTodayValue = safeTodayValue;
      changed = true;
    }
  }

  if (changed) await saveSummaryState(db, state);
  return state;
}

async function setManualOffset(db, period, manualValue, now = new Date()) {
  const state = await loadSummaryState(db);
  state.lastRolloverDate = getDateKey(now);
  state.weekKey = getWeekKey(now);
  state.yearKey = getYearKey(now);

  if (period === 'week') {
    state.weekOffset = manualValue;
  } else if (period === 'year') {
    state.yearOffset = manualValue;
  } else if (period === 'previousYear') {
    state.previousYearTotal = manualValue;
  } else {
    throw new Error('Unbekannter Zeitraum.');
  }

  await saveSummaryState(db, state);
  return state;
}

async function buildPhotovoltaikSnapshot(db, cache, plants) {
  const mqttConfig = await loadMqttSettings(db);
  const solarContext = buildSolarContext(mqttConfig, cache);
  const factorsMap = await loadFactors(db);
  const bucket = currentBucket(cache);
  const enrichedPlants = [];
  let currentTotal = 0;
  let idealTotal = 0;
  let todayTotal = 0;
  let hasCurrent = false;
  let hasIdeal = false;
  let hasToday = false;
  let anyDirectSunlight = false;

  for (const plant of plants || []) {
    const currentValue = getCacheValue(cache, `pv:${plant.id}:power`);
    const todayValue = getCacheValue(cache, `pv:${plant.id}:today`);
    const idealBase = calculateIdealPlantPower(plant, solarContext);
    // Wirksamer Kalibrierfaktor (nur bei aktivierter Auto-Kalibrierung + genug
    // Samples) zieht den Idealwert tageszeit-abhängig nach (z. B. Verschattung).
    const idealValue = idealBase == null ? null : idealBase * effectiveFactor(factorsMap, plant, bucket);
    const directSunlight = assessDirectSunlight(plant, currentValue, idealValue, idealBase, solarContext);
    const sunReference = isSunReference(plant, idealBase, solarContext);
    // Gelernter Bucket-Faktor (roh, ungated) — für die Diagnose-Anzeige.
    const calibrationFactor = plant.autoCalibrate ? getFactor(factorsMap, plant.id, bucket).factor : null;

    if (currentValue != null) {
      currentTotal += currentValue;
      hasCurrent = true;
    }
    if (idealValue != null) {
      idealTotal += idealValue;
      hasIdeal = true;
    }
    if (todayValue != null) {
      todayTotal += todayValue;
      hasToday = true;
    }
    if (directSunlight === true) anyDirectSunlight = true;

    enrichedPlants.push({
      ...plant,
      metrics: {
        raw: {
          current: currentValue,
          ideal: idealValue,
          idealBase,
          today: todayValue,
          directSunlight,
          sunReference,
          calibrationFactor,
        },
        formatted: {
          current: formatPower(currentValue),
          ideal: formatPower(idealValue),
          today: formatEnergy(todayValue),
          calibrationFactor: formatFactor(calibrationFactor),
        },
      },
    });
  }

  const totalTodayValue = hasToday ? todayTotal : null;
  const state = await updateSummaryState(db, totalTodayValue);
  const effectiveToday = totalTodayValue == null ? 0 : totalTodayValue;
  const weekValue =
    totalTodayValue == null && state.weekOffset === 0 ? null : state.weekOffset + effectiveToday;
  const yearValue =
    totalTodayValue == null && state.yearOffset === 0 ? null : state.yearOffset + effectiveToday;

  return {
    plants: enrichedPlants,
    totals: {
      raw: {
        current: hasCurrent ? currentTotal : null,
        ideal: hasIdeal ? idealTotal : null,
        today: totalTodayValue,
        week: weekValue,
        year: yearValue,
        previousYear: state.previousYearTotal || null,
        directSunlight: anyDirectSunlight,
      },
      formatted: {
        current: formatPower(hasCurrent ? currentTotal : null),
        ideal: formatPower(hasIdeal ? idealTotal : null),
        today: formatEnergy(totalTodayValue),
        week: formatEnergy(weekValue),
        year: formatEnergy(yearValue),
        previousYear: formatEnergy(state.previousYearTotal || null),
      },
    },
  };
}

// Schreibfreie Variante von buildPhotovoltaikSnapshot: liefert die aktuellen
// berechneten Werte (Leistung, Ideal, Ertrag, direkte Sonne) ohne die DB-
// schreibende Summen-Fortschreibung. Geeignet für häufige Auswertung (Outputs).
async function readPhotovoltaikValues(db, cache, plants) {
  const mqttConfig = await loadMqttSettings(db);
  const solarContext = buildSolarContext(mqttConfig, cache);
  const factorsMap = await loadFactors(db);
  const bucket = currentBucket(cache);
  const state = await loadSummaryState(db);

  let currentTotal = 0;
  let idealTotal = 0;
  let shadowTotal = 0;
  let todayTotal = 0;
  let hasCurrent = false;
  let hasIdeal = false;
  let hasShadow = false;
  let hasToday = false;
  let anyDirectSunlight = false;
  const plantValues = [];

  for (const plant of plants || []) {
    const current = getCacheValue(cache, `pv:${plant.id}:power`);
    const idealBase = calculateIdealPlantPower(plant, solarContext);
    const ideal = idealBase == null ? null : idealBase * effectiveFactor(factorsMap, plant, bucket);
    const today = getCacheValue(cache, `pv:${plant.id}:today`);
    const directSunlight = assessDirectSunlight(plant, current, ideal, idealBase, solarContext);
    const sunReference = isSunReference(plant, idealBase, solarContext);
    // Grenzleistung Schatten → direkte Sonne: ab hier gilt die Anlage als besonnt.
    const shadow = ideal == null ? null : ideal * getCellTypeParameters(plant.cellType).directThreshold;
    const calibrationFactor = plant.autoCalibrate ? getFactor(factorsMap, plant.id, bucket).factor : null;

    if (current != null) {
      currentTotal += current;
      hasCurrent = true;
    }
    if (ideal != null) {
      idealTotal += ideal;
      hasIdeal = true;
    }
    if (shadow != null) {
      shadowTotal += shadow;
      hasShadow = true;
    }
    if (today != null) {
      todayTotal += today;
      hasToday = true;
    }
    if (directSunlight === true) anyDirectSunlight = true;

    plantValues.push({
      id: plant.id,
      name: plant.name,
      isConsumerSide: plant.isConsumerSide,
      autoCalibrate: plant.autoCalibrate,
      kwPeak: plant.kwPeak,
      current,
      ideal,
      idealBase,
      shadow,
      today,
      directSunlight,
      sunReference,
      calibrationFactor,
    });
  }

  const totalToday = hasToday ? todayTotal : null;
  const effectiveToday = totalToday == null ? 0 : totalToday;
  const week = totalToday == null && state.weekOffset === 0 ? null : state.weekOffset + effectiveToday;
  const year = totalToday == null && state.yearOffset === 0 ? null : state.yearOffset + effectiveToday;

  return {
    plants: plantValues,
    totals: {
      current: hasCurrent ? currentTotal : null,
      ideal: hasIdeal ? idealTotal : null,
      shadow: hasShadow ? shadowTotal : null,
      today: totalToday,
      week,
      year,
      previousYear: state.previousYearTotal || null,
      directSunlight: anyDirectSunlight,
    },
  };
}

function getConsumerSidePvCurrentTotal(snapshot) {
  let total = 0;
  let hasValue = false;
  for (const plant of snapshot.plants || []) {
    if (!plant.isConsumerSide) continue;
    const value = plant.metrics.raw.current;
    if (value == null) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

// Tagesertrag (kWh) der verbraucherseitig ins Hausnetz einspeisenden PV-Anlagen.
// Ein echter Eigenverbrauchszähler misst diese Energie nicht (sie fließt hinter
// dem Zähler direkt zu den Lasten), daher wird sie zum Zählerstand addiert.
function getConsumerSidePvTodayTotal(snapshot) {
  let total = 0;
  let hasValue = false;
  for (const plant of snapshot.plants || []) {
    if (!plant.isConsumerSide) continue;
    const value = plant.metrics.raw.today;
    if (value == null) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

async function touchPhotovoltaikAggregation(db, cache, plants) {
  return buildPhotovoltaikSnapshot(db, cache, plants);
}

// Sonnenhöhe (Grad) aus Sonnenstand-Kontext; null, wenn kein Breitengrad hinterlegt.
function getSolarElevationDeg(solarContext) {
  if (solarContext.latitude == null) return null;
  const declination = degToRad(23.45 * Math.sin(degToRad((360 * (284 + solarContext.dayOfYear)) / 365)));
  const hourAngle = degToRad(15 * (solarContext.decimalHours - 12));
  const latitudeRad = degToRad(solarContext.latitude);
  const up =
    Math.sin(latitudeRad) * Math.sin(declination) +
    Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  return radToDeg(Math.asin(Math.max(-1, Math.min(1, up))));
}

function isDaytime(solarContext) {
  const elevation = getSolarElevationDeg(solarContext);
  if (elevation != null) return elevation > 0;
  // Ohne Breitengrad ersatzweise grobe Uhrzeit-Heuristik.
  const hours = solarContext.decimalHours;
  return hours != null && hours >= 6 && hours < 20;
}

// Zustand für das Titelzeilen-Symbol: 'sun' (direkte Sonne an mind. einer Anlage),
// 'cloud' (tagsüber ohne direkte Sonne) oder 'moon' (Nacht). Leichtgewichtig,
// ohne die DB-schreibende Summen-Fortschreibung aus buildPhotovoltaikSnapshot.
async function assessHeaderSkyState(db, cache, plants) {
  const mqttConfig = await loadMqttSettings(db);
  const solarContext = buildSolarContext(mqttConfig, cache);
  for (const plant of plants || []) {
    const currentValue = getCacheValue(cache, `pv:${plant.id}:power`);
    const idealValue = calculateIdealPlantPower(plant, solarContext);
    // calculateIdealPlantPower liefert den unkalibrierten Idealwert → zugleich idealBase.
    if (assessDirectSunlight(plant, currentValue, idealValue, idealValue, solarContext) === true) {
      return 'sun';
    }
  }
  return isDaytime(solarContext) ? 'cloud' : 'moon';
}

module.exports = {
  buildPhotovoltaikSnapshot,
  readPhotovoltaikValues,
  getConsumerSidePvCurrentTotal,
  getConsumerSidePvTodayTotal,
  setManualOffset,
  touchPhotovoltaikAggregation,
  assessHeaderSkyState,
  solarGeometryAt,
  transposePlaneIrradiance,
  idealPowerFromIrradiance,
  formatEnergy,
  isSunReference,
  updateSummaryState,
};
