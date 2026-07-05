'use strict';

// Adapter-Registry: scannt das Adapter-Verzeichnis (config.ADAPTER_DIR) nach
// Unterordnern mit einer adapter.json (Manifest) und stellt die validierten
// Manifeste bereit. Das Manifest bestimmt u. a. Anzeigename, Prefix (Schema) und
// das Einstellungs-Schema. Siehe ADAPTER.md für das vollständige Regelwerk.

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Erlaubte Schema-/ID-Form: Kleinbuchstabe, dann Buchstaben/Ziffern/_/-.
const ID_RE = /^[a-z][a-z0-9_-]*$/;

let manifests = []; // validierte Manifeste, key = id

function adapterDir() {
  return config.ADAPTER_DIR;
}

function normalizeSettingField(field) {
  if (!field || typeof field !== 'object' || !field.key) return null;
  const type = ['text', 'number', 'checkbox', 'select', 'password'].includes(field.type)
    ? field.type
    : 'text';
  return {
    key: String(field.key),
    label: field.label ? String(field.label) : String(field.key),
    type,
    default: field.default == null ? '' : field.default,
    options: Array.isArray(field.options)
      ? field.options.map((o) => (typeof o === 'object' ? { value: String(o.value), label: String(o.label == null ? o.value : o.label) } : { value: String(o), label: String(o) }))
      : [],
    hint: field.hint ? String(field.hint) : '',
  };
}

// Spalten-Definition des optionalen State-Editors normalisieren (wie ein
// Settings-Feld, zusätzlich mit `required`).
function normalizeColumn(col) {
  const field = normalizeSettingField(col);
  if (!field) return null;
  return { ...field, required: !!col.required };
}

// Optionaler stateEditor-Block: erlaubt dem Adapter, eine generische Tabelle zur
// Pflege seiner Live-States (z. B. Modbus-Register) zu deklarieren. homeESS rendert
// daraus die Verwaltungs-Unterseite und – bei presets:true – das Preset-Panel.
function normalizeStateEditor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const columns = Array.isArray(raw.columns)
    ? raw.columns.map(normalizeColumn).filter(Boolean)
    : [];
  if (!columns.length) return null;
  const has = (key) => columns.some((c) => c.key === key);
  // Schlüssel kann zusammengesetzt sein (keyFields), z. B. unitId + address bei
  // Modbus. keyField bleibt als Einzel-/Erststufe für Anzeige und Rückwärtskompat.
  let keyFields = Array.isArray(raw.keyFields) ? raw.keyFields.map(String).filter(has) : [];
  if (!keyFields.length) keyFields = [raw.keyField && has(raw.keyField) ? String(raw.keyField) : columns[0].key];
  const keyField = keyFields[0];
  const nameField = raw.nameField && has(raw.nameField) ? String(raw.nameField) : keyField;
  // Optionales Kategorie-Feld: gruppiert die angelegten States auf der Verwaltungs-
  // und Preset-Seite (einklappbarer Baum). Nur gültig, wenn es eine Spalte ist.
  const categoryField = raw.categoryField && has(String(raw.categoryField)) ? String(raw.categoryField) : null;
  return {
    storageKey: raw.storageKey ? String(raw.storageKey) : 'states',
    keyField,
    keyFields,
    nameField,
    categoryField,
    label: raw.label ? String(raw.label) : 'States',
    columns,
    presets: !!raw.presets,
  };
}

// Optionaler, generischer Geräte-Browser. Der Adapter persistiert seine erkannten
// Geräte via host.setStorage(storageKey, [...]); homeESS zeigt und benennt sie,
// ohne adapterspezifische Routen oder Views zu benötigen.
function normalizeDevicePage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    storageKey: raw.storageKey ? String(raw.storageKey) : 'devices',
    label: raw.label ? String(raw.label) : 'Geräte',
    emptyText: raw.emptyText ? String(raw.emptyText) : 'Noch keine Geräte erkannt.',
  };
}

function readManifest(dir, folderName) {
  const manifestPath = path.join(dir, folderName, 'adapter.json');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (_) {
    return null; // kein Manifest -> kein Adapter
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[adapters] Ungültiges JSON in ${manifestPath}: ${err.message}`);
    return null;
  }
  const id = String(parsed.id || folderName).toLowerCase();
  const prefix = String(parsed.prefix || id).toLowerCase();
  if (!ID_RE.test(id)) {
    console.error(`[adapters] Ungültige Adapter-ID "${id}" (${manifestPath})`);
    return null;
  }
  if (!ID_RE.test(prefix)) {
    console.error(`[adapters] Ungültiger Prefix "${prefix}" (${manifestPath})`);
    return null;
  }
  const main = String(parsed.main || 'index.js');
  const mainPath = path.join(dir, folderName, main);
  if (!fs.existsSync(mainPath)) {
    console.error(`[adapters] Einstiegsdatei fehlt: ${mainPath}`);
    return null;
  }
  const settings = Array.isArray(parsed.settings)
    ? parsed.settings.map(normalizeSettingField).filter(Boolean)
    : [];
  return {
    id,
    folder: folderName,
    dir: path.join(dir, folderName),
    name: parsed.name ? String(parsed.name) : id,
    prefix,
    version: parsed.version ? String(parsed.version) : '0.0.0',
    description: parsed.description ? String(parsed.description) : '',
    copyright: parsed.copyright ? String(parsed.copyright) : '',
    multiInstance: parsed.multiInstance !== false,
    main,
    mainPath,
    settings,
    stateEditor: normalizeStateEditor(parsed.stateEditor),
    devicePage: normalizeDevicePage(parsed.devicePage),
    presetsDir: path.join(dir, folderName, 'presets'),
  };
}

// Verzeichnis (neu) einlesen. Doppelte Prefixe werden verworfen (erster gewinnt).
function loadRegistry() {
  const dir = adapterDir();
  const result = [];
  const seenPrefix = new Set();
  const seenId = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    manifests = [];
    return manifests;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(dir, entry.name);
    if (!manifest) continue;
    if (seenId.has(manifest.id)) {
      console.error(`[adapters] Doppelte Adapter-ID "${manifest.id}" – übersprungen.`);
      continue;
    }
    if (seenPrefix.has(manifest.prefix)) {
      console.error(`[adapters] Doppelter Prefix "${manifest.prefix}" – ${manifest.id} übersprungen.`);
      continue;
    }
    seenId.add(manifest.id);
    seenPrefix.add(manifest.prefix);
    result.push(manifest);
  }
  result.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  manifests = result;
  return manifests;
}

function getRegistry() {
  return manifests;
}

function getManifest(adapterId) {
  return manifests.find((m) => m.id === String(adapterId).toLowerCase()) || null;
}

module.exports = { loadRegistry, getRegistry, getManifest };
