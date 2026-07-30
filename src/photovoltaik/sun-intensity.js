'use strict';

// Sonnenintensität aus dem Clear-Sky-Modell: Verhältnis der tatsächlichen
// PV-Gesamtleistung zur idealen Klarhimmel-Leistung, in Prozent und auf 100%
// gedeckelt. Momentanwerte werden periodisch als Zeitreihe gespeichert, um
// Mittelwerte (10 Minuten, aktueller Tag, Vortag) zu bilden. Nachts wird 0 %
// erfasst, bei fehlenden Daten dagegen kein Sample. Tagesmittel beruecksichtigen
// davon nur Samples, bei denen mindestens eine Anlage oberhalb des
// Idealwert-Cutoffs liegt.

const { listPvPlants } = require('./plants');
const {
  readPhotovoltaikValues,
  buildSolarContext,
  getSolarElevationDeg,
} = require('./aggregation');

const SAMPLE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // 2 Tage (für Vortag)
const TEN_MINUTES_MS = 10 * 60 * 1000;
const CIVIL_TWILIGHT_ELEVATION_DEG = -6;
const SUN_INTENSITY_WEIGHT = 0.6;

function pad(value) {
  return String(value).padStart(2, '0');
}

function getDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getYesterdayKey(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  date.setDate(date.getDate() - 1);
  return getDateKey(date);
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Momentane Sonnenintensität in Prozent (0..100) oder null, wenn keine
// belastbare Klarhimmel-Referenz bzw. keine Leistungsdaten vorliegen. Eine durch
// das Modell eindeutig erkannte Nacht ist dagegen eine Intensität von 0 %.
//
// Wichtig: Das Verhältnis wird nur über Anlagen gebildet, die BEIDE Werte liefern
// (aktuelle Leistung UND Idealwert). Fehlt bei einer Anlage kurz der MQTT-Wert,
// würde ihr Idealanteil im Nenner das Verhältnis sonst künstlich nach unten ziehen
// und so einen scheinbaren Einbruch trotz voller Sonne erzeugen. Eine real auf 0
// produzierende Anlage (Leistung 0, nicht null) bleibt dagegen korrekt enthalten.
async function computeSunIntensitySample(db, cache) {
  const plants = await listPvPlants(db);
  const pv = await readPhotovoltaikValues(db, cache, plants);

  let currentSum = 0;
  let idealSum = 0;
  let hasMatch = false;
  let hasModeledIdeal = false;
  let hasPositiveModeledIdeal = false;
  for (const plant of pv.plants) {
    if (plant.idealBase != null) {
      hasModeledIdeal = true;
      if (plant.idealBase > 0) hasPositiveModeledIdeal = true;
    }
    // Nur Anlagen einbeziehen, die aktuell als Sonnenreferenz taugen (größenrelativer
    // Cutoff je nach Sonnenstand). off-axis-Anlagen – z. B. die große Südanlage
    // morgens – liefern aus Diffuslicht weit mehr als ihr winziges Ideal und würden
    // das Verhältnis sonst künstlich nach oben ziehen (scheinbar Sonne trotz Wolken).
    if (!plant.sunReference) continue;
    if (plant.current == null || plant.ideal == null || plant.ideal <= 0) continue;
    currentSum += plant.current;
    idealSum += plant.ideal;
    hasMatch = true;
  }
  if (!hasMatch || idealSum <= 0) {
    // Sind alle berechenbaren Klarhimmel-Idealwerte exakt 0, liegt die Sonne
    // unter dem Horizont. Das ist ein gültiger Messwert, keine Datenlücke.
    if (hasModeledIdeal && !hasPositiveModeledIdeal) {
      return { intensity: 0, dayAverageEligible: false };
    }
    return null;
  }

  const percent = (currentSum / idealSum) * 100;
  if (!Number.isFinite(percent)) return null;
  // Jede erfasste Probe stammt nun ausschließlich aus Sonnenreferenz-Anlagen und ist
  // damit für die Tagesmittel geeignet.
  return {
    intensity: Math.max(0, Math.min(100, percent)),
    dayAverageEligible: true,
  };
}

async function computeInstantSunIntensity(db, cache) {
  const sample = await computeSunIntensitySample(db, cache);
  return sample == null ? null : sample.intensity;
}

// Astronomisches Helligkeitstrapez: Während der bürgerlichen Dämmerung steigt
// die Helligkeit linear von 0 auf 100 %. Ab dem Horizont bleibt sie bis zum
// Sonnenuntergang auf dem 100-%-Plateau.
function astronomicalBrightnessPercent(solarElevationDeg) {
  if (!Number.isFinite(solarElevationDeg)) return null;
  if (solarElevationDeg <= CIVIL_TWILIGHT_ELEVATION_DEG) return 0;
  if (solarElevationDeg >= 0) return 100;
  return ((solarElevationDeg - CIVIL_TWILIGHT_ELEVATION_DEG) /
    -CIVIL_TWILIGHT_ELEVATION_DEG) * 100;
}

// Die gemessene Sonnenintensität beeinflusst 60 % des Trapezes. Die übrigen
// 40 % bilden das diffuse Tageslicht ab, das auch bei 0 % direkter
// Sonnenintensität vorhanden bleibt. Ohne belastbare Messung gilt allein das
// astronomische Trapez.
function combineBrightnessPercent(trapezoidPercent, sunIntensityPercent) {
  if (!Number.isFinite(trapezoidPercent)) return null;
  const trapezoid = Math.max(0, Math.min(100, trapezoidPercent));
  if (!Number.isFinite(sunIntensityPercent)) return trapezoid;
  const intensity = Math.max(0, Math.min(100, sunIntensityPercent)) / 100;
  const factor = (1 - SUN_INTENSITY_WEIGHT) + SUN_INTENSITY_WEIGHT * intensity;
  return trapezoid * factor;
}

function computeBrightnessPercent(mqttConfig, cache, sunIntensitySample) {
  const solarContext = buildSolarContext(mqttConfig, cache);
  const elevation = getSolarElevationDeg(solarContext);
  const trapezoid = astronomicalBrightnessPercent(elevation);
  // Nur eine echte Sonnenreferenz ist eine belastbare Messung für den
  // Bewölkungseinfluss. Modellierte Nacht-Nullwerte und Dämmerungslücken
  // verändern den linearen Dämmerungsverlauf nicht.
  const measuredIntensity = sunIntensitySample && sunIntensitySample.dayAverageEligible
    ? sunIntensitySample.intensity
    : null;
  return combineBrightnessPercent(trapezoid, measuredIntensity);
}

// Einen Messpunkt erfassen und alte Samples aufräumen.
async function recordSample(db, cache, now = new Date()) {
  const sample = await computeSunIntensitySample(db, cache);
  if (sample == null) return null;
  const ts = now.getTime();
  await dbRun(
    db,
    `INSERT INTO sun_intensity_samples
     (recorded_at, day_key, intensity, day_average_eligible)
     VALUES (?, ?, ?, ?)`,
    [ts, getDateKey(now), sample.intensity, sample.dayAverageEligible ? 1 : 0]
  );
  await dbRun(db, 'DELETE FROM sun_intensity_samples WHERE recorded_at < ?', [
    ts - SAMPLE_RETENTION_MS,
  ]);
  return sample.intensity;
}

// Mittelwerte (in Prozent) für die drei Zeitfenster; null, wenn keine Samples.
async function readSunIntensityAverages(db, now = new Date()) {
  const [tenMin, today, yesterday] = await Promise.all([
    dbGet(db, 'SELECT AVG(intensity) AS avg FROM sun_intensity_samples WHERE recorded_at >= ?', [
      now.getTime() - TEN_MINUTES_MS,
    ]),
    dbGet(
      db,
      'SELECT AVG(intensity) AS avg FROM sun_intensity_samples WHERE day_key = ? AND day_average_eligible = 1',
      [getDateKey(now)]
    ),
    dbGet(
      db,
      'SELECT AVG(intensity) AS avg FROM sun_intensity_samples WHERE day_key = ? AND day_average_eligible = 1',
      [getYesterdayKey(now)]
    ),
  ]);
  const value = (row) => (row && row.avg != null ? row.avg : null);
  return { last10min: value(tenMin), today: value(today), yesterday: value(yesterday) };
}

module.exports = {
  computeSunIntensitySample,
  computeInstantSunIntensity,
  computeBrightnessPercent,
  astronomicalBrightnessPercent,
  combineBrightnessPercent,
  recordSample,
  readSunIntensityAverages,
};
