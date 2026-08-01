'use strict';

// Instanzeigenes Datenverzeichnis für Adapter. Gedacht für Nutzdaten, die zu
// groß für die Instanz-Settings sind — etwa Firmwareimages. Die Settings liegen
// als ein JSON-Blob in SQLite und werden bei jedem Persistieren komplett neu
// geschrieben; ein halbes Megabyte gehört dort nicht hinein.
//
// Die öffentliche Host-API liefert ausschließlich das Verzeichnis der eigenen
// Instanz. Pfade sind nicht frei wählbar, der Adapter kann also nicht aus seinem
// Bereich ausbrechen.

const fs = require('fs');
const path = require('path');

let rootDir = null;

function init(dataDir) {
  rootDir = path.join(dataDir, 'adapters');
}

function directoryFor(adapterId, instanceId) {
  if (!rootDir) throw new Error('Adapter-Datenspeicher ist nicht initialisiert.');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(adapterId || ''))) {
    throw new Error('Ungültige Adapter-Kennung.');
  }
  if (!Number.isInteger(Number(instanceId)) || Number(instanceId) < 1) {
    throw new Error('Ungültige Adapter-Instanz.');
  }
  const dir = path.join(rootDir, String(adapterId), String(Number(instanceId)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function remove(adapterId, instanceId) {
  if (!rootDir) return false;
  const dir = path.join(rootDir, String(adapterId), String(Number(instanceId)));
  if (!dir.startsWith(path.join(rootDir, String(adapterId)) + path.sep)) return false;
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { init, directoryFor, remove };
