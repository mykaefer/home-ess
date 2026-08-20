'use strict';

// Coordinator-Backup und Import.
//
// zigbee-herdsman schreibt und liest das Coordinator-Backup selbst — im
// „zigpy/open-coordinator-backup"-Format, das auch Zigbee2MQTT unter dem Namen
// `coordinator_backup.json` verwendet. Ein Wechsel von Zigbee2MQTT zu homeESS
// braucht deshalb keine Umwandlung, sondern nur die Datei an der richtigen
// Stelle im Adapter-Datenverzeichnis.
//
// Dieses Modul prüft eingehende Dateien, bevor sie dort landen, und legt vor
// jedem Überschreiben eine Sicherung an.

const fs = require('fs');
const path = require('path');

const BACKUP_FILE = 'coordinator_backup.json';
const DATABASE_FILE = 'devices.db';
const DATABASE_BACKUP_FILE = 'devices.db.backup';
const NETWORK_FILE = 'network.json';
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const MAX_DATABASE_BYTES = 4 * 1024 * 1024;

function fail(message, code = 'ZIGBEE_BACKUP') {
  return Object.assign(new Error(message), { code });
}

function paths(dataDirectory) {
  return {
    backup: path.join(dataDirectory, BACKUP_FILE),
    database: path.join(dataDirectory, DATABASE_FILE),
    databaseBackup: path.join(dataDirectory, DATABASE_BACKUP_FILE),
    network: path.join(dataDirectory, NETWORK_FILE),
  };
}

/**
 * Prüft, ob ein Text ein brauchbares Coordinator-Backup enthält, und liefert
 * eine Kurzbeschreibung. Der Netzwerkschlüssel wird dabei nicht ausgegeben.
 */
function inspectBackup(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw fail(`Die Datei enthält kein gültiges JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('Die Datei enthält kein Coordinator-Backup.');
  }

  // Altes herdsman-Format.
  if (parsed.adapterType) {
    return {
      format: 'legacy',
      adapterType: String(parsed.adapterType),
      deviceCount: null,
      channel: null,
      panId: null,
      time: parsed.time ? String(parsed.time) : '',
    };
  }

  const metadata = parsed.metadata;
  if (!metadata || metadata.format !== 'zigpy/open-coordinator-backup') {
    throw fail('Unbekanntes Backupformat. Erwartet wird ein Coordinator-Backup im Format '
      + '„zigpy/open-coordinator-backup" — so speichert es auch Zigbee2MQTT als coordinator_backup.json.');
  }
  if (Number(metadata.version) !== 1) {
    throw fail(`Nicht unterstützte Backupversion: ${metadata.version}.`);
  }
  const network = parsed.network_key ? {} : null;
  if (!parsed.coordinator_ieee || !parsed.network_key || !parsed.pan_id) {
    throw fail('Dem Backup fehlen Pflichtangaben (Coordinator-Adresse, PAN-ID oder Netzwerkschlüssel).');
  }
  return {
    format: 'unified',
    adapterType: metadata.source ? String(metadata.source) : '',
    coordinatorIeee: String(parsed.coordinator_ieee),
    panId: String(parsed.pan_id),
    extendedPanId: String(parsed.extended_pan_id || ''),
    channel: Number(parsed.channel) || null,
    deviceCount: Array.isArray(parsed.devices) ? parsed.devices.length : 0,
    time: parsed.backup_time ? String(parsed.backup_time) : '',
    hasNetworkKey: !!network,
  };
}

/**
 * Übernimmt eine hochgeladene Backupdatei in das Adapter-Datenverzeichnis.
 * Ein vorhandenes Backup wird vorher zur Seite gelegt, nie einfach verworfen.
 */
function importBackup(dataDirectory, sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw fail('Die hochgeladene Datei ist keine reguläre Datei.');
  if (stat.size > MAX_BACKUP_BYTES) {
    throw fail(`Coordinator-Backups dürfen höchstens ${MAX_BACKUP_BYTES / 1024 / 1024} MiB groß sein.`);
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const info = inspectBackup(raw);

  const target = paths(dataDirectory).backup;
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(target, `${target}.${stamp}.bak`);
  }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, raw, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return info;
}

function readStoredBackupInfo(dataDirectory) {
  const target = paths(dataDirectory).backup;
  if (!fs.existsSync(target)) return null;
  try {
    const info = inspectBackup(fs.readFileSync(target, 'utf8'));
    return { ...info, size: fs.statSync(target).size, modified: fs.statSync(target).mtime.toISOString() };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Liest die vom Adapter selbst geführten Netzwerkmetadaten. Sie enthalten
 * bewusst kein Schlüsselmaterial — der Netzwerkschlüssel liegt ausschließlich
 * im Secret-Store von homeESS.
 */
/**
 * Liefert die im Coordinator-Backup verzeichneten Geräte.
 *
 * Wichtig für die Übernahme eines bestehenden Netzes: Der Coordinator kennt
 * seine Kinder und deren Link-Keys, zigbee-herdsman führt seine Gerätedaten
 * aber in einer eigenen Datenbank. Nach einem Umzug ist die Funkverbindung
 * daher intakt, die Geräte sind der Bibliothek jedoch unbekannt und ihre
 * Nachrichten werden verworfen. Diese Liste ist die Grundlage, um sie ohne
 * erneutes Anlernen wieder aufzunehmen.
 */
function readBackupDevices(dataDirectory) {
  const target = paths(dataDirectory).backup;
  if (!fs.existsSync(target)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    return [];
  }
  const devices = Array.isArray(parsed && parsed.devices) ? parsed.devices : [];
  const rows = [];
  for (const device of devices) {
    const ieee = String(device && device.ieee_address || '').replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(ieee)) continue;
    const networkAddress = Number.parseInt(String(device.nwk_address || ''), 16);
    if (!Number.isInteger(networkAddress) || networkAddress < 0 || networkAddress > 0xfffe) continue;
    rows.push({
      ieeeAddress: `0x${ieee}`,
      networkAddress,
      isChild: device.is_child === true,
      hasLinkKey: !!(device.link_key && device.link_key.key),
    });
  }
  return rows;
}

/**
 * Übernimmt eine hochgeladene Gerätedatenbank (das `database.db` von
 * Zigbee2MQTT beziehungsweise zigbee-herdsman). Sie enthält Modell, Endpunkte
 * und Interviewstand der Geräte — anders als das Coordinator-Backup, das nur
 * die Netzwerk- und Schlüsseldaten führt.
 */
function importDeviceDatabase(dataDirectory, sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw fail('Die hochgeladene Datei ist keine reguläre Datei.');
  if (stat.size > MAX_DATABASE_BYTES) {
    throw fail(`Gerätedatenbanken dürfen höchstens ${MAX_DATABASE_BYTES / 1024 / 1024} MiB groß sein.`);
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw fail('Die Datei enthält keine Einträge.');

  let devices = 0;
  let groups = 0;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      throw fail('Die Datei ist keine zigbee-herdsman-Gerätedatenbank: Sie enthält Zeilen ohne gültiges JSON. '
        + 'Erwartet wird das „database.db" von Zigbee2MQTT.');
    }
    if (!entry || typeof entry !== 'object' || entry.id == null || !entry.type) {
      throw fail('Die Datei ist keine zigbee-herdsman-Gerätedatenbank: Einträgen fehlen id oder type.');
    }
    if (entry.type === 'Group') groups += 1;
    else devices += 1;
  }

  const target = paths(dataDirectory).database;
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(target, `${target}.${stamp}.bak`);
  }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, raw, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return { devices, groups, entries: lines.length };
}

function readNetworkMetadata(dataDirectory) {
  const target = paths(dataDirectory).network;
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeNetworkMetadata(dataDirectory, metadata) {
  const target = paths(dataDirectory).network;
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

module.exports = {
  BACKUP_FILE,
  DATABASE_FILE,
  MAX_BACKUP_BYTES,
  MAX_DATABASE_BYTES,
  paths,
  readBackupDevices,
  importDeviceDatabase,
  inspectBackup,
  importBackup,
  readStoredBackupInfo,
  readNetworkMetadata,
  writeNetworkMetadata,
};
