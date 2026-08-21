'use strict';

// Systemweite Datenbankanbindung.
//
// Eine Stelle im Kern, über die alle Auswertungen (Diagramme, Berichte) an
// Zeitreihen kommen — unabhängig davon, ob die Datenbank vom InfluxDB-Adapter
// befüllt wird oder extern läuft. Konfiguriert wird sie zentral in den
// Einstellungen unterhalb der MQTT-Einstellungen.

const { loadDatabaseConfig, saveDatabaseConfig, invalidateDatabaseConfig, isConfigured } = require('./config');
const { InfluxReader } = require('./influx-reader');

const STATUS_CACHE_MS = 15000;

let lastStatus = { checkedAt: 0, ok: false, message: 'Noch nicht geprüft.', version: '' };

function load(db) {
  return new Promise((resolve) => loadDatabaseConfig(db, resolve));
}

function save(db, input) {
  return new Promise((resolve, reject) => {
    saveDatabaseConfig(db, input, (err, stored) => {
      if (err) return reject(err);
      // Ein Wechsel der Zieldatenbank macht den letzten Status wertlos.
      lastStatus = { checkedAt: 0, ok: false, message: 'Noch nicht geprüft.', version: '' };
      resolve(stored);
    });
  });
}

// Client für die aktuell konfigurierte Datenbank. `null`, solange keine
// nutzbare Anbindung eingerichtet ist — Aufrufer prüfen das, statt in einen
// Verbindungsfehler zu laufen.
async function getReader(db, { requireEnabled = true } = {}) {
  const config = await load(db);
  if (requireEnabled && !isConfigured(config)) return null;
  if (!config.host) return null;
  return new InfluxReader(config);
}

// Verbindungstest für die Einstellungsseite. `config` erlaubt es, noch nicht
// gespeicherte Formulareingaben zu prüfen.
async function testConnection(db, config = null) {
  const effective = config || await load(db);
  if (!effective.host) {
    return { ok: false, message: 'Es ist kein Datenbankserver eingetragen.' };
  }
  const reader = new InfluxReader(effective);
  try {
    const info = await reader.ping();
    // Erreichbar heißt noch nicht nutzbar: Die konfigurierte Datenbank muss
    // auch existieren und lesbar sein.
    const measurements = await reader.listMeasurements();
    const status = {
      ok: true,
      checkedAt: Date.now(),
      version: info.version,
      message: `Verbindung erfolgreich${info.version ? ` (InfluxDB ${info.version})` : ''}. `
        + `${measurements.length} Messreihe${measurements.length === 1 ? '' : 'n'} in „${effective.database}".`,
      measurements: measurements.length,
    };
    lastStatus = status;
    return status;
  } catch (error) {
    const status = {
      ok: false,
      checkedAt: Date.now(),
      version: '',
      message: error && error.message ? error.message : 'Die Datenbank ist nicht erreichbar.',
    };
    lastStatus = status;
    return status;
  }
}

// Zuletzt ermittelter Status (für die Anzeige, ohne bei jedem Seitenaufruf eine
// Verbindung aufzubauen).
function getStatus() {
  return { ...lastStatus, fresh: lastStatus.checkedAt > 0 && Date.now() - lastStatus.checkedAt <= STATUS_CACHE_MS };
}

// ── Abfrage-API für Auswertungen ───────────────────────────────────────────

async function listMeasurements(db) {
  const reader = await getReader(db);
  if (!reader) return [];
  return reader.listMeasurements();
}

// Zeitreihe lesen. Siehe InfluxReader#readSeries für die Optionen.
async function readSeries(db, options = {}) {
  const reader = await getReader(db);
  if (!reader) throw new Error('Es ist keine Systemdatenbank eingerichtet.');
  return reader.readSeries(options);
}

// Mehrere Messreihen im selben Zeitfenster — die übliche Form für ein Diagramm
// mit mehreren Linien.
async function readSeriesSet(db, measurements, options = {}) {
  const reader = await getReader(db);
  if (!reader) throw new Error('Es ist keine Systemdatenbank eingerichtet.');
  const names = (Array.isArray(measurements) ? measurements : [measurements]).filter(Boolean);
  const results = [];
  for (const measurement of names) {
    // Bewusst nacheinander: eine einzelne InfluxDB soll nicht mit parallelen
    // Abfragen überfahren werden, wenn ein Diagramm viele Linien hat.
    results.push(await reader.readSeries({ ...options, measurement }));
  }
  return results;
}

module.exports = {
  load,
  save,
  invalidate: invalidateDatabaseConfig,
  isConfigured,
  getReader,
  testConnection,
  getStatus,
  listMeasurements,
  readSeries,
  readSeriesSet,
};
