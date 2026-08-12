'use strict';

// Adapter-Registry: scannt das Adapter-Verzeichnis (config.ADAPTER_DIR) nach
// Unterordnern mit einer adapter.json (Manifest) und stellt die validierten
// Manifeste bereit. Das Manifest bestimmt u. a. Anzeigename, Prefix (Schema) und
// das Einstellungs-Schema. Siehe ADAPTER.md für das vollständige Regelwerk.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const i18n = require('../i18n');

// Erlaubte Schema-/ID-Form: Kleinbuchstabe, dann Buchstaben/Ziffern/_/-.
const ID_RE = /^[a-z][a-z0-9_-]*$/;

let manifests = []; // validierte Manifeste, key = id

function adapterDir() {
  return config.ADAPTER_DIR;
}

// Feldschlüssel landen als HTML-Attribut (id/name/data-key) in der Oberfläche
// und als JSON-Schlüssel in der Datenbank. Sie kommen aus einem Manifest, das
// auch per ZIP hochgeladen worden sein kann — deshalb hier eine feste,
// unkritische Zeichenmenge statt bloßer Stringkonvertierung.
const FIELD_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function normalizeSettingField(field) {
  if (!field || typeof field !== 'object' || !field.key) return null;
  if (!FIELD_KEY_RE.test(String(field.key))) {
    console.error(`[adapters] Ungültiger Feldschlüssel "${String(field.key).slice(0, 40)}" – Feld wird verworfen.`);
    return null;
  }
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

// Optionales, ausdrücklich als öffentlich erklärtes Unterverzeichnis des
// Adapter-Datenverzeichnisses. Der Host liefert es ohne Anmeldung nur lesend
// aus — gedacht für Artefakte, die Werkzeuge außerhalb des Browsers abholen
// müssen. Ein Adapter ohne diese Erklärung gibt nichts preis.
function normalizePublicFiles(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const subdirectory = (value) => {
    const relative = String(value || '');
    return /^[a-z0-9][a-z0-9_-]*$/i.test(relative) ? relative : null;
  };
  // `data` liegt im Datenverzeichnis der Instanz und wächst zur Laufzeit;
  // `assets` wird mit dem Adapter ausgeliefert und ist unveränderlich.
  const data = subdirectory(raw.data);
  const assets = subdirectory(raw.assets);
  if (!data && !assets) return null;
  return {
    data,
    assets,
    label: raw.label ? String(raw.label) : 'Öffentliche Adapterdateien',
    hint: raw.hint ? String(raw.hint) : '',
  };
}

// Optionale Einstellungen je State: Der Adapter deklariert ein Formularschema,
// homeESS rendert daraus im Eigenschaften-Dialog eines States einen eigenen Tab
// je aktiver Instanz und speichert die Werte je (Instanz, Topic). Der Adapter
// liest sie über host.listStateOptions().
function normalizeStateOptions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fields = Array.isArray(raw.fields) ? raw.fields.map(normalizeSettingField).filter(Boolean) : [];
  if (!fields.length) return null;
  return {
    label: raw.label ? String(raw.label) : 'Adapter',
    hint: raw.hint ? String(raw.hint) : '',
    // Feld, dessen aktivierter Zustand entscheidet, ob der State überhaupt
    // vom Adapter berücksichtigt wird. Ohne Angabe gilt jeder gespeicherte
    // Datensatz als aktiv.
    enabledField: raw.enabledField ? String(raw.enabledField) : '',
    fields,
  };
}

// Optionale, adapterspezifische Verwaltungsseite. Die Seite selbst bleibt im
// isolierten Adapterprozess; der Host übernimmt Authentifizierung, Rechte,
// Layout und begrenzte, auf Platte gestreamte Uploads.
function normalizeManagementPage(raw, adapterPath) {
  if (!raw || typeof raw !== 'object') return null;
  const maxUploadBytes = Number(raw.maxUploadBytes);
  const result = {
    label: raw.label ? String(raw.label) : 'Verwalten',
    maxUploadBytes: Number.isInteger(maxUploadBytes) && maxUploadBytes > 0
      ? Math.min(maxUploadBytes, 64 * 1024 * 1024)
      : 2 * 1024 * 1024,
  };
  const stylesheet = raw.stylesheet == null ? '' : String(raw.stylesheet).trim();
  // Styles werden bewusst nur als einzelne, deklarierte Datei direkt aus dem
  // Adapterwurzelverzeichnis freigegeben. Keine freien statischen Verzeichnisse
  // und keine relativen Pfade: so kann ein Manifest nie aus seinem Ordner lesen.
  if (stylesheet) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.css$/.test(stylesheet)) {
      console.error(`[adapters] Ungültiges Management-Stylesheet "${stylesheet}" (${adapterPath})`);
    } else {
      const stylesheetPath = path.join(adapterPath, stylesheet);
      try {
        const stat = fs.lstatSync(stylesheetPath);
        if (stat.isFile() && !stat.isSymbolicLink()) result.stylesheet = stylesheet;
        else console.error(`[adapters] Management-Stylesheet ist keine reguläre Datei: ${stylesheetPath}`);
      } catch (_) {
        console.error(`[adapters] Management-Stylesheet fehlt: ${stylesheetPath}`);
      }
    }
  }
  return result;
}

function readManifest(dir, folderName, options = {}) {
  const report = typeof options.report === 'function' ? options.report : (message) => console.error(message);
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
    report(`[adapters] Ungültiges JSON in ${manifestPath}: ${err.message}`);
    return null;
  }
  // Adapter liefern ihre UI-Texte eigenständig mit. Ohne Sprachverzeichnis
  // bleibt das Manifest unverändert und damit vollständig abwärtskompatibel.
  const translations = options.localize === false
    ? {} : i18n.adapterTranslations(path.join(dir, folderName));
  const localize = (value) => {
    if (typeof value === 'string') return i18n.localizeText(value, translations);
    if (Array.isArray(value)) return value.map(localize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, localize(entry)]));
    }
    return value;
  };
  parsed = localize(parsed);
  const id = String(parsed.id || folderName).toLowerCase();
  const prefix = String(parsed.prefix || id).toLowerCase();
  if (!ID_RE.test(id)) {
    report(`[adapters] Ungültige Adapter-ID "${id}" (${manifestPath})`);
    return null;
  }
  if (!ID_RE.test(prefix)) {
    report(`[adapters] Ungültiger Prefix "${prefix}" (${manifestPath})`);
    return null;
  }
  const main = String(parsed.main || 'index.js');
  const adapterPath = path.join(dir, folderName);
  if (main.includes('\\') || path.isAbsolute(main)
      || main.split('/').some((part) => !part || part === '.' || part === '..')) {
    report(`[adapters] Ungültiger Pfad der Einstiegsdatei "${main}" (${manifestPath})`);
    return null;
  }
  const mainPath = path.join(adapterPath, ...main.split('/'));
  let mainStat;
  try {
    mainStat = fs.lstatSync(mainPath);
  } catch (_) {
    report(`[adapters] Einstiegsdatei fehlt: ${mainPath}`);
    return null;
  }
  if (!mainStat.isFile() || mainStat.isSymbolicLink()) {
    report(`[adapters] Einstiegsdatei ist keine reguläre Datei: ${mainPath}`);
    return null;
  }
  const settings = Array.isArray(parsed.settings)
    ? parsed.settings.map(normalizeSettingField).filter(Boolean)
    : [];
  return {
    id,
    folder: folderName,
    dir: adapterPath,
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
    stateOptions: normalizeStateOptions(parsed.stateOptions),
    devicePage: normalizeDevicePage(parsed.devicePage),
    managementPage: normalizeManagementPage(parsed.managementPage, path.join(dir, folderName)),
    publicFiles: normalizePublicFiles(parsed.publicFiles),
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
    // Versteckte Verzeichnisse sind interne/transiente Arbeitsordner und nie
    // eigenständige Adapter. Das verhindert insbesondere, dass ein nach einem
    // Prozessabbruch übrig gebliebenes Upload-Staging geladen wird.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
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
  result.sort((a, b) => a.name.localeCompare(b.name, i18n.current().locale));
  manifests = result;
  return manifests;
}

function getRegistry() {
  return manifests;
}

function getManifest(adapterId) {
  return manifests.find((m) => m.id === String(adapterId).toLowerCase()) || null;
}

module.exports = {
  FIELD_KEY_RE, normalizeStateOptions, loadRegistry, getRegistry, getManifest, readManifest };
