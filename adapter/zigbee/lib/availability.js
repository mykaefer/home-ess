'use strict';

// Verfügbarkeit von Zigbee-Geräten.
//
// Der wichtigste Punkt: Batteriebetriebene Sensoren schlafen zwischen ihren
// Meldungen. Ein Fenstersensor meldet sich unter Umständen nur einmal am Tag —
// er ist deshalb nicht offline. Würde man ihn nach wenigen Minuten Stille als
// nicht verfügbar führen, wäre die Angabe wertlos.
//
// Unterschieden werden deshalb drei Klassen:
//   • Router                      – dauerhaft aktiv, kurzes Zeitfenster
//   • netzbetriebene Endgeräte    – dauerhaft aktiv, kurzes Zeitfenster
//   • batteriebetriebene Endgeräte – schlafend, langes Zeitfenster, nie geweckt

const MAINS_SOURCES = new Set([
  'Mains (single phase)',
  'Mains (3 phase)',
  'DC Source',
  'Emergency mains constantly powered',
  'Emergency mains and transfer switch',
]);

const CLASS_ROUTER = 'router';
const CLASS_MAINS = 'mains';
const CLASS_BATTERY = 'battery';

/**
 * Ordnet ein Gerät einer Verfügbarkeitsklasse zu.
 */
function classifyDevice(device) {
  if (!device) return CLASS_BATTERY;
  const powerSource = String(device.powerSource || '');
  const type = String(device.type || '');
  if (type === 'Router' || type === 'Coordinator') return CLASS_ROUTER;
  if (MAINS_SOURCES.has(powerSource)) return CLASS_MAINS;
  if (powerSource === 'Battery') return CLASS_BATTERY;
  // Unbekannte Energiequelle: Ein Endgerät wird vorsichtshalber als schlafend
  // behandelt. Ein fälschlich als offline geführtes Gerät ist der teurere
  // Fehler — es verschwindet aus der Bedienung, obwohl es funktioniert.
  return CLASS_BATTERY;
}

function isActivelyPowered(deviceClass) {
  return deviceClass === CLASS_ROUTER || deviceClass === CLASS_MAINS;
}

/**
 * Zeitfenster in Millisekunden, nach dem ein Gerät als nicht verfügbar gilt.
 */
function timeoutFor(deviceClass, config = {}) {
  if (isActivelyPowered(deviceClass)) {
    const minutes = Number(config.availabilityMainsMinutes);
    return Math.max(1, Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
  }
  const hours = Number(config.availabilityBatteryHours);
  return Math.max(1, Number.isFinite(hours) && hours > 0 ? hours : 25) * 60 * 60 * 1000;
}

/**
 * Bewertet die Verfügbarkeit eines Gerätes.
 *
 * @param {object} entry  { deviceClass, lastSeen }
 * @param {object} config Instanz-Einstellungen
 * @param {number} now    Zeitstempel
 */
function evaluate(entry, config = {}, now = Date.now()) {
  const deviceClass = entry.deviceClass || CLASS_BATTERY;
  const timeout = timeoutFor(deviceClass, config);
  const lastSeen = Number(entry.lastSeen) || 0;
  // Ohne je gesehene Meldung gilt ein Gerät als unbekannt, nicht als offline.
  if (!lastSeen) return { available: null, deviceClass, timeout, age: null };
  const age = now - lastSeen;
  return { available: age <= timeout, deviceClass, timeout, age };
}

/**
 * Soll dieses Gerät aktiv abgefragt werden? Batteriegeräte niemals — eine
 * Abfrage würde sie wecken und ihre Batterie belasten, ohne die Aussage zu
 * verbessern.
 */
function shouldPing(entry, config = {}, now = Date.now()) {
  if (config.activePing === false) return false;
  if (!isActivelyPowered(entry.deviceClass)) return false;
  const timeout = timeoutFor(entry.deviceClass, config);
  const lastSeen = Number(entry.lastSeen) || 0;
  const lastPing = Number(entry.lastPing) || 0;
  // Frühestens ab der Hälfte des Zeitfensters prüfen und nie öfter als einmal
  // je halbem Zeitfenster.
  const half = timeout / 2;
  if (lastSeen && now - lastSeen < half) return false;
  if (lastPing && now - lastPing < half) return false;
  return true;
}

module.exports = {
  CLASS_ROUTER,
  CLASS_MAINS,
  CLASS_BATTERY,
  MAINS_SOURCES,
  classifyDevice,
  isActivelyPowered,
  timeoutFor,
  evaluate,
  shouldPing,
};
