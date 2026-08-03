'use strict';

// Kompatibilitätsschicht für bestehende Fachmodule. Die Zeit selbst kommt nur
// noch aus dem zentralen Timehandler; cache bleibt als alter Parameter erhalten.
const timeHandler = require('./time-handler');
const { buildEnvironmentSnapshot } = require('./mqtt/config');

function localCalendar(cache, timezone, now = new Date(), dstEnabled = null) {
  // Reine Unit-Tests ohne initialisierten App-Timehandler behalten die Möglichkeit,
  // einen expliziten MQTT-Snapshot als Zeitpunkt vorzugeben. Im laufenden Server
  // wird cache ignoriert: dort hat der Timehandler die Probe bereits genau einmal
  // anhand ihres receivedAt in den gleitenden Versatz aufgenommen.
  if (!timeHandler.isInitialized() && cache && typeof cache.get === 'function') {
    const environment = buildEnvironmentSnapshot(cache);
    if (environment.time.iso || environment.date.iso) {
      const system = timeHandler.zonedParts(now, timezone || 'Europe/Berlin', dstEnabled == null ? true : dstEnabled);
      const date = environment.date.iso ? environment.date : system;
      const clock = environment.time.iso ? environment.time : system;
      const epoch = timeHandler.wallPartsToEpoch({
        year: date.year, month: date.month, day: date.day,
        hours: clock.hours, minutes: clock.minutes, seconds: clock.seconds,
      }, timezone || 'Europe/Berlin', dstEnabled == null ? true : dstEnabled);
      const parts = timeHandler.zonedParts(new Date(epoch), timezone || 'Europe/Berlin', dstEnabled == null ? true : dstEnabled);
      return { ...parts,
        dateKey: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
        weekKey: timeHandler.weekKey(parts), monthKey: `${parts.year}-${String(parts.month).padStart(2, '0')}`, yearKey: String(parts.year) };
    }
  }
  return timeHandler.calendar(now, { timezone, dstEnabled: dstEnabled == null ? undefined : dstEnabled });
}

module.exports = { localCalendar, zonedParts: timeHandler.zonedParts, weekKey: timeHandler.weekKey };
