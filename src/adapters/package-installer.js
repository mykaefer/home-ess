'use strict';

// Sichere Installation portabler Adapterpakete. Das ZIP wird vollständig in
// einem temporären Verzeichnis geprüft und entpackt. Erst ein gültiger Adapter
// wird in einem letzten Schritt in das produktive Adapterverzeichnis bewegt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const vm = require('vm');
const config = require('../config');
const registry = require('./registry');

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_MANIFEST_BYTES = 256 * 1024;
const ID_RE = /^[a-z][a-z0-9_-]*$/;
const SETTING_TYPES = new Set(['text', 'number', 'checkbox', 'select', 'password']);

function packageError(message, code = 'INVALID_ADAPTER_PACKAGE', status = 422) {
  return Object.assign(new Error(message), { code, status });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decodeName(bytes, utf8) {
  try {
    return utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : bytes.toString('latin1');
  } catch (_) {
    throw packageError('Das ZIP enthält einen ungültig kodierten Dateinamen.');
  }
}

function validateEntryName(name) {
  if (!name || name.length > 1024 || name.includes('\\') || /[\0-\x1f\x7f]/.test(name)
      || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw packageError(`Unsicherer ZIP-Pfad: ${JSON.stringify(name)}.`);
  }
  const directory = name.endsWith('/');
  const parts = name.slice(0, directory ? -1 : undefined).split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.length > 255)) {
    throw packageError(`Unsicherer ZIP-Pfad: ${JSON.stringify(name)}.`);
  }
  return { directory, parts };
}

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw packageError('Die Datei ist kein vollständiges ZIP-Archiv.');
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw packageError('Die Datei ist kein vollständiges ZIP-Archiv.');
  }
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw packageError(`Adapterpakete dürfen höchstens ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB groß sein.`,
      'ADAPTER_PACKAGE_TOO_LARGE', 413);
  }
  const end = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const entriesOnDisk = buffer.readUInt16LE(end + 8);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const commentLength = buffer.readUInt16LE(end + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount
      || entryCount > MAX_ENTRIES || end + 22 + commentLength !== buffer.length
      || centralOffset === 0xffffffff || centralSize === 0xffffffff
      || centralOffset + centralSize > end) {
    throw packageError('Mehrteilige, ZIP64- oder strukturell ungültige Archive werden nicht unterstützt.');
  }

  const entries = [];
  const names = new Set();
  let totalSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw packageError('Das zentrale ZIP-Verzeichnis ist beschädigt.');
    }
    const madeBy = buffer.readUInt16LE(offset + 4) >>> 8;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const unpackedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > end || !nameLength || startDisk !== 0
        || compressedSize === 0xffffffff || unpackedSize === 0xffffffff
        || localOffset === 0xffffffff) {
      throw packageError('Das ZIP enthält einen ungültigen oder nicht unterstützten Eintrag.');
    }
    if (flags & 0x0001) throw packageError('Verschlüsselte ZIP-Einträge sind nicht zulässig.');
    if (![0, 8].includes(method)) throw packageError('Das ZIP verwendet eine nicht unterstützte Kompressionsmethode.');
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeName(nameBytes, !!(flags & 0x0800));
    const pathInfo = validateEntryName(name);
    const duplicateKey = name.replace(/\/$/, '').toLowerCase();
    if (names.has(duplicateKey)) throw packageError(`Doppelter ZIP-Pfad: ${name}.`);
    names.add(duplicateKey);
    const mode = madeBy === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    const fileType = mode & 0xf000;
    if (fileType && fileType !== 0x4000 && fileType !== 0x8000) {
      throw packageError(`Links und Spezialdateien sind im Adapterpaket nicht zulässig: ${name}.`);
    }
    if ((fileType === 0x4000) !== pathInfo.directory && fileType !== 0) {
      throw packageError(`Widersprüchlicher Dateityp im ZIP: ${name}.`);
    }
    if (pathInfo.directory && (compressedSize !== 0 || unpackedSize !== 0)) {
      throw packageError(`Verzeichniseintrag mit Nutzdaten im ZIP: ${name}.`);
    }
    if (unpackedSize > MAX_FILE_BYTES) throw packageError(`Datei im Adapterpaket ist zu groß: ${name}.`);
    totalSize += unpackedSize;
    if (totalSize > MAX_UNPACKED_BYTES) {
      throw packageError(`Das entpackte Adapterpaket darf höchstens ${MAX_UNPACKED_BYTES / 1024 / 1024} MiB groß sein.`);
    }
    entries.push({
      name, nameBytes: Buffer.from(nameBytes), directory: pathInfo.directory, mode,
      flags, method, expectedCrc, compressedSize, unpackedSize, localOffset,
    });
    offset = next;
  }
  if (offset !== centralOffset + centralSize) throw packageError('Die Größenangabe des ZIP-Verzeichnisses ist ungültig.');
  return { entries, centralOffset };
}

function packageRoot(entries) {
  const manifests = entries.filter((entry) => !entry.directory
    && (entry.name === 'adapter.json' || entry.name.endsWith('/adapter.json')));
  if (manifests.length !== 1) throw packageError('Das Paket muss genau eine adapter.json enthalten.');
  const parts = manifests[0].name.split('/');
  if (parts.length > 2) throw packageError('adapter.json muss direkt im Paket oder in genau einem Adapterordner liegen.');
  const prefix = parts.length === 2 ? `${parts[0]}/` : '';
  for (const entry of entries) {
    if (prefix) {
      if (entry.name !== prefix && !entry.name.startsWith(prefix)) {
        throw packageError('Außerhalb des Adapterordners enthält das ZIP weitere Dateien.');
      }
    } else if (entry.name.split('/')[0] === '__MACOSX') {
      throw packageError('Das ZIP enthält paketfremde Metadaten.');
    }
  }
  return prefix;
}

function entryContents(buffer, entry, centralOffset) {
  const offset = entry.localOffset;
  if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw packageError(`Lokaler ZIP-Header fehlt: ${entry.name}.`);
  }
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (flags !== entry.flags || method !== entry.method || dataEnd > centralOffset
      || !buffer.subarray(nameStart, nameStart + nameLength).equals(entry.nameBytes)) {
    throw packageError(`ZIP-Eintrag ist zwischen den Verzeichnissen widersprüchlich: ${entry.name}.`);
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  let contents;
  try {
    contents = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, entry.unpackedSize),
    });
  } catch (_) {
    throw packageError(`ZIP-Eintrag lässt sich nicht sicher entpacken: ${entry.name}.`);
  }
  if (contents.length !== entry.unpackedSize || crc32(contents) !== entry.expectedCrc) {
    throw packageError(`Prüfsumme oder Größe des ZIP-Eintrags ist falsch: ${entry.name}.`);
  }
  return contents;
}

function extractChecked(buffer, destination) {
  const archive = readZipEntries(buffer);
  const prefix = packageRoot(archive.entries);
  for (const entry of archive.entries) {
    const relative = entry.name.slice(prefix.length).replace(/\/$/, '');
    if (!relative) continue;
    const target = path.join(destination, ...relative.split('/'));
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const contents = entryContents(buffer, entry, archive.centralOffset);
    fs.writeFileSync(target, contents, { flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 });
  }
}

function validateSettings(settings) {
  if (settings == null) return;
  if (!Array.isArray(settings)) throw packageError('adapter.json: settings muss ein Array sein.');
  const keys = new Set();
  for (const field of settings) {
    if (!field || typeof field !== 'object' || Array.isArray(field)
        || typeof field.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(field.key)
        || typeof field.type !== 'string' || !SETTING_TYPES.has(field.type)) {
      throw packageError('adapter.json: Ein Settings-Feld ist unvollständig oder ungültig.');
    }
    if (keys.has(field.key)) throw packageError(`adapter.json: Settings-Schlüssel ${field.key} ist doppelt.`);
    keys.add(field.key);
    if (field.type === 'select' && !Array.isArray(field.options)) {
      throw packageError(`adapter.json: Select-Feld ${field.key} benötigt options.`);
    }
  }
}

function validateManifest(candidate) {
  const manifestPath = path.join(candidate, 'adapter.json');
  let stat;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch (_) {
    throw packageError('adapter.json fehlt im Paketwurzelverzeichnis.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw packageError('adapter.json ist keine zulässige Manifestdatei.');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw packageError(`adapter.json enthält ungültiges JSON: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw packageError('adapter.json muss ein Objekt enthalten.');
  for (const key of ['id', 'prefix']) {
    if (typeof raw[key] !== 'string' || !ID_RE.test(raw[key])) {
      throw packageError(`adapter.json: ${key} fehlt oder ist ungültig.`);
    }
  }
  for (const key of ['name', 'version', 'main']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) {
      throw packageError(`adapter.json: ${key} fehlt oder ist leer.`);
    }
  }
  if (raw.multiInstance != null && typeof raw.multiInstance !== 'boolean') {
    throw packageError('adapter.json: multiInstance muss ein Booleanwert sein.');
  }
  validateSettings(raw.settings);
  const main = raw.main;
  if (main.includes('\\') || path.isAbsolute(main) || main.split('/').some((part) => !part || part === '.' || part === '..')
      || !/\.(?:c?js)$/.test(main)) {
    throw packageError('adapter.json: main muss eine relative JavaScript-Datei innerhalb des Adapters sein.');
  }
  const mainPath = path.join(candidate, ...main.split('/'));
  let mainStat;
  try {
    mainStat = fs.lstatSync(mainPath);
  } catch (_) {
    throw packageError(`Deklarierte Einstiegsdatei fehlt: ${main}.`);
  }
  if (!mainStat.isFile() || mainStat.isSymbolicLink() || mainStat.size > MAX_FILE_BYTES) {
    throw packageError(`Deklarierte Einstiegsdatei ist unzulässig: ${main}.`);
  }
  try {
    new vm.Script(fs.readFileSync(mainPath, 'utf8'), { filename: main });
  } catch (error) {
    throw packageError(`Einstiegsdatei enthält ungültiges JavaScript: ${error.message}`);
  }
  const errors = [];
  const normalized = registry.readManifest(path.dirname(candidate), path.basename(candidate), {
    report: (message) => errors.push(message), localize: false,
  });
  if (!normalized) throw packageError(errors[0] || 'Das Manifest entspricht nicht der Adapter-Spezifikation.');
  if (raw.stateEditor != null && !normalized.stateEditor) {
    throw packageError('adapter.json: stateEditor ist unvollständig oder ungültig.');
  }
  if (raw.devicePage != null && !normalized.devicePage) {
    throw packageError('adapter.json: devicePage ist unvollständig oder ungültig.');
  }
  if (raw.publicFiles != null && !normalized.publicFiles) {
    throw packageError('adapter.json: publicFiles enthält kein gültiges Daten- oder Assetverzeichnis.');
  }
  if (raw.managementPage != null) {
    if (!raw.managementPage || typeof raw.managementPage !== 'object' || Array.isArray(raw.managementPage)) {
      throw packageError('adapter.json: managementPage muss ein Objekt sein.');
    }
    const stylesheet = raw.managementPage.stylesheet;
    if (stylesheet != null) {
      if (typeof stylesheet !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.css$/.test(stylesheet)) {
        throw packageError('adapter.json: managementPage.stylesheet ist ungültig.');
      }
      const stylesheetPath = path.join(candidate, stylesheet);
      try {
        const stylesheetStat = fs.lstatSync(stylesheetPath);
        if (!stylesheetStat.isFile() || stylesheetStat.isSymbolicLink()) throw new Error();
      } catch (_) {
        throw packageError(`Deklariertes Management-Stylesheet fehlt: ${stylesheet}.`);
      }
    }
  }
  return normalized;
}

function ensureNoCollision(manifest, adapterRoot) {
  if (fs.existsSync(path.join(adapterRoot, manifest.id))) {
    throw packageError(`Adapter ${manifest.id} ist bereits installiert.`, 'ADAPTER_ALREADY_EXISTS', 409);
  }
  for (const installed of registry.getRegistry()) {
    if (installed.id === manifest.id) {
      throw packageError(`Adapter-ID ${manifest.id} ist bereits vergeben.`, 'ADAPTER_ALREADY_EXISTS', 409);
    }
    if (installed.prefix === manifest.prefix) {
      throw packageError(`Adapter-Prefix ${manifest.prefix} ist bereits vergeben.`, 'ADAPTER_PREFIX_EXISTS', 409);
    }
  }
}

function installAdapterPackage(zipPath, options = {}) {
  const adapterRoot = options.adapterDir || config.ADAPTER_DIR;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-package-'));
  const candidate = path.join(temporary, 'candidate');
  let staging = null;
  try {
    fs.mkdirSync(candidate, { mode: 0o755 });
    const archiveStat = fs.statSync(zipPath);
    if (!archiveStat.isFile() || archiveStat.size > MAX_ARCHIVE_BYTES) {
      throw packageError(`Adapterpakete dürfen höchstens ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB groß sein.`,
        'ADAPTER_PACKAGE_TOO_LARGE', 413);
    }
    const zip = fs.readFileSync(zipPath);
    extractChecked(zip, candidate);
    const manifest = validateManifest(candidate);
    ensureNoCollision(manifest, adapterRoot);
    fs.mkdirSync(adapterRoot, { recursive: true, mode: 0o750 });
    staging = path.join(adapterRoot, `.upload-${manifest.id}-${crypto.randomBytes(8).toString('hex')}`);
    fs.cpSync(candidate, staging, { recursive: true, errorOnExist: true, force: false });
    ensureNoCollision(manifest, adapterRoot);
    const destination = path.join(adapterRoot, manifest.id);
    fs.renameSync(staging, destination);
    staging = null;
    return { ...manifest, dir: destination, folder: manifest.id,
      mainPath: path.join(destination, manifest.main) };
  } catch (error) {
    if (error && error.code && error.status) throw error;
    throw packageError(`Adapterpaket konnte nicht installiert werden: ${error.message}`,
      'ADAPTER_INSTALL_FAILED', 500);
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function removeAdapterPackage(adapterId, options = {}) {
  const id = String(adapterId || '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw packageError('Ungültige Adapter-ID.', 'INVALID_ADAPTER_ID', 422);
  const adapterRoot = path.resolve(options.adapterDir || config.ADAPTER_DIR);
  const manifest = registry.getManifest(id);
  if (!manifest) throw packageError(`Adapter ${id} wurde nicht gefunden.`, 'ADAPTER_NOT_FOUND', 404);
  const target = path.resolve(manifest.dir);
  if (path.dirname(target) !== adapterRoot || path.basename(target) !== id) {
    throw packageError('Der Adapterpfad kann nicht sicher gelöscht werden.', 'UNSAFE_ADAPTER_PATH', 422);
  }
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (_) {
    throw packageError(`Adapter ${id} wurde nicht gefunden.`, 'ADAPTER_NOT_FOUND', 404);
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw packageError('Der Adapterpfad ist kein reguläres Adapterverzeichnis.', 'UNSAFE_ADAPTER_PATH', 422);
  }

  // Das Verzeichnis zuerst atomar aus dem von der Registry gescannten
  // Namensraum nehmen. Scheitert das endgültige Entfernen, wird es nach
  // Möglichkeit unter seinem ursprünglichen Namen wiederhergestellt.
  const quarantine = path.join(adapterRoot, `.delete-${id}-${crypto.randomBytes(8).toString('hex')}`);
  fs.renameSync(target, quarantine);
  try {
    fs.rmSync(quarantine, { recursive: true, force: false });
  } catch (error) {
    try {
      if (!fs.existsSync(target) && fs.existsSync(quarantine)) fs.renameSync(quarantine, target);
    } catch (_) {
      // Ein verbliebener versteckter Quarantäneordner wird nie als Adapter geladen.
    }
    throw packageError(`Adapter ${id} konnte nicht vollständig gelöscht werden: ${error.message}`,
      'ADAPTER_DELETE_FAILED', 500);
  }
  return { id, name: manifest.name, prefix: manifest.prefix };
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_UNPACKED_BYTES,
  readZipEntries,
  extractChecked,
  validateManifest,
  installAdapterPackage,
  removeAdapterPackage,
  _crc32: crc32,
};
