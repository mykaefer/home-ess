'use strict';
const { solarGeometryAt, transposePlaneIrradiance, getSolarElevationDeg } = require('../photovoltaik/aggregation');
const time = require('../time-handler');

function geometry(config, at) {
  const parts = time.calendar(new Date(at), { timezone: config.timezone, dstEnabled: config.dstEnabled == null ? true : !!config.dstEnabled });
  return solarGeometryAt(config, parts, parts);
}
function elevation(config, at) {
  if (config.latitude == null || config.latitude === '' || config.longitude == null || config.longitude === '') return null;
  return getSolarElevationDeg(geometry(config, at));
}
function direct(config, at, orientation, dni) {
  return transposePlaneIrradiance({ ...geometry(config, at), azimuth: orientation, tilt: 90, dni, dhi: 0, ghi: 0 });
}
// Mindestens eine Stunde lückenlose 15-Minuten-Prognose. Stundenwerte sind
// absichtlich kein Ersatz: sie glätten kurze Sonne-Wolken-Wechsel zu stark.
function sustainedSun(config, forecast, orientation, now, samples = []) {
  if (!forecast || now - forecast.fetchedAt > 90 * 60000 || elevation(config, now) == null) return false;
  const slots = forecast.minutes15 || [];
  const values = [];
  for (let i = 0; i < 5; i++) {
    const at = now + i * 15 * 60000;
    const p = time.calendar(new Date(at), { timezone: forecast.timezone || config.timezone });
    const slot = slots.find(s => s.year === p.year && s.month === p.month && s.day === p.day && s.hour === p.hours && s.minute === Math.floor(p.minutes / 15) * 15);
    if (!slot || !Number.isFinite(slot.dni)) return false;
    values.push(direct(config, at, orientation, slot.dni));
  }
  if (!values.every(v => v >= 120)) return false;
  // PV-Messungen, falls verfügbar, müssen über zehn Minuten stabil sonnig sein.
  if (samples.length) {
    if (samples.length < 5 || now - samples[0].recorded_at < 8 * 60000) return false;
    if (samples.some(s => s.intensity < 55)) return false;
    if (samples.reduce((n, s) => n + s.intensity, 0) / samples.length < 70) return false;
  }
  return true;
}
module.exports = { elevation, direct, sustainedSun };
