'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const CODE_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const MAX_FILE_BYTES = 1024 * 1024;
let catalog = new Map();
let selectedCode = 'de';
let timezone = 'Europe/Berlin';
let database = null;
let readyPromise = Promise.resolve();

function validateDocument(document, filename = '') {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Die Sprachdatei muss ein JSON-Objekt sein.');
  }
  const code = String(document.code || '').trim();
  if (!CODE_RE.test(code)) throw new Error('Der Sprachcode ist ungültig (z. B. de, en oder pt-BR).');
  if (filename && path.basename(filename, '.json') !== code) {
    throw new Error(`Dateiname und Sprachcode müssen übereinstimmen (${code}.json).`);
  }
  const name = String(document.name || '').trim();
  if (!name || name.length > 80) throw new Error('Ein gültiger Sprachname fehlt.');
  const locale = String(document.locale || code).trim();
  try { new Intl.Locale(locale); } catch (_) { throw new Error('Die Locale der Sprachdatei ist ungültig.'); }
  const messages = document.messages;
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
    throw new Error('Das Objekt „messages“ fehlt.');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(messages)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key) || key.length > 160) {
      throw new Error(`Ungültiger Übersetzungsschlüssel: ${key}`);
    }
    if (typeof value !== 'string') throw new Error(`Übersetzung „${key}“ muss Text sein.`);
    normalized[key] = value.normalize('NFC');
  }
  const aliases = {};
  if (document.aliases != null && (typeof document.aliases !== 'object' || Array.isArray(document.aliases))) {
    throw new Error('Das optionale Objekt „aliases“ ist ungültig.');
  }
  for (const [source, key] of Object.entries(document.aliases || {})) {
    if (!source || typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(normalized, key)) {
      throw new Error(`Ungültiger Alias für Übersetzungsschlüssel: ${key}`);
    }
    aliases[source.normalize('NFC')] = key;
  }
  return Object.freeze({ code, name: name.normalize('NFC'), locale, direction: document.direction === 'rtl' ? 'rtl' : 'ltr', messages: Object.freeze(normalized), aliases: Object.freeze(aliases) });
}

function readDirectory(directory, target) {
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = fs.lstatSync(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const language = validateDocument(parsed, entry.name);
      target.set(language.code, language);
    } catch (error) {
      console.error(`[i18n] Sprachdatei ${fullPath} wird ignoriert: ${error.message}`);
    }
  }
}

// Built-ins zuerst, updatefeste Uploads danach. Ein Upload desselben Codes darf
// damit eine mitgelieferte Datei aktualisieren, ohne das Git-Checkout zu ändern.
function scan() {
  const next = new Map();
  readDirectory(config.BUILTIN_LANGUAGE_DIR, next);
  readDirectory(config.LANGUAGE_DIR, next);
  catalog = next;
  if (!catalog.has('de') || !catalog.has('en')) {
    throw new Error('Die mitgelieferten Sprachen Deutsch und Englisch fehlen.');
  }
  if (!catalog.has(selectedCode)) selectedCode = fallbackCode();
  return listLanguages();
}

function fallbackCode() {
  return timezone === 'Europe/Berlin' ? 'de' : 'en';
}

function messageFor(code, key) {
  const language = catalog.get(code);
  return language && Object.prototype.hasOwnProperty.call(language.messages, key)
    ? language.messages[key]
    : undefined;
}

function ensureCatalog() {
  if (!catalog.size) scan();
}

function interpolate(value, params) {
  return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params || {}, key) ? String(params[key]) : match
  ));
}

function t(key, params = {}, defaultText) {
  ensureCatalog();
  const fallback = fallbackCode();
  const value = messageFor(selectedCode, key)
    ?? messageFor(fallback, key)
    ?? messageFor(fallback === 'de' ? 'en' : 'de', key)
    ?? defaultText
    ?? key;
  return interpolate(value, params);
}

// Übergangshilfe für die bestehenden servergerenderten Views: Die deutsche
// Basisdatei ordnet jeden Ausgangstext einem stabilen Schlüssel zu. Neue Views
// verwenden t() direkt; die Bestandsansichten werden hier vollständig durch
// denselben Katalog geführt, einschließlich eingebetteter Browsermeldungen.
function localizeText(source, adapterMessages) {
  ensureCatalog();
  let result = String(source == null ? '' : source);
  const replaceExact = (input, original, translated) => {
    if (!original || original === translated) return input;
    if (input === original) return translated;
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexibleWhitespace = escaped.replace(/\s+/g, '\\s+');
    // Sichtbarer HTML-Text muss den gesamten Textknoten bilden. Dadurch werden
    // weder Nutzernamen noch Bestandteile wie „aktiv“ in „aktiviert“ verändert.
    input = input.replace(new RegExp(`(>\\s*)${flexibleWhitespace}(\\s*<)`, 'gu'), (_match, before, after) => `${before}${translated}${after}`);
    // Attribute und Browsermeldungen liegen als vollständige Stringliterale vor.
    for (const quote of ['"', "'", '`']) {
      if (original.includes(quote)) continue;
      const quoted = new RegExp(`${quote}${escaped}${quote}`, 'gu');
      input = input.replace(quoted, `${quote}${translated}${quote}`);
    }
    return input;
  };
  const base = catalog.get('de');
  if (base) {
    const replacements = [
      ...Object.entries(base.messages).map(([key, german]) => [german, t(key)]),
      ...Object.entries(base.aliases || {}).map(([source, key]) => [source, t(key)]),
    ]
      .filter(([german, translated]) => german && german !== translated)
      .sort((left, right) => right[0].length - left[0].length);
    for (const [german, translated] of replacements) result = replaceExact(result, german, translated);
  }
  if (adapterMessages) {
    const replacements = Object.entries(adapterMessages)
      .filter(([from, to]) => from && from !== to)
      .sort((left, right) => right[0].length - left[0].length);
    for (const [from, to] of replacements) result = replaceExact(result, from, to);
  }
  return result;
}

function current() {
  ensureCatalog();
  const language = catalog.get(selectedCode) || catalog.get(fallbackCode());
  return { code: language.code, name: language.name, locale: language.locale, direction: language.direction, fallback: fallbackCode() };
}

function listLanguages() {
  ensureCatalog();
  return Array.from(catalog.values())
    .map(({ code, name, locale, direction }) => ({ code, name, locale, direction }))
    .sort((a, b) => a.name.localeCompare(b.name, current().locale));
}

function setTimezone(value) { timezone = String(value || ''); }

function init(db) {
  database = db;
  scan();
  readyPromise = new Promise((resolve) => {
    db.get('SELECT language FROM language_config WHERE id = 1', (error, row) => {
      if (!error && row && catalog.has(row.language)) selectedCode = row.language;
      resolve(current());
    });
  });
  return readyPromise;
}

function ready() { return readyPromise; }

function select(code) {
  ensureCatalog();
  const next = String(code || '');
  if (!catalog.has(next)) return Promise.reject(new Error('Die gewählte Sprache ist nicht installiert.'));
  selectedCode = next;
  if (!database) return Promise.resolve(current());
  return new Promise((resolve, reject) => database.run(
    'INSERT INTO language_config (id, language) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET language = excluded.language',
    [next],
    (error) => error ? reject(error) : resolve(current())
  ));
}

function install(filename, document) {
  const language = validateDocument(document, String(filename || ''));
  fs.mkdirSync(config.LANGUAGE_DIR, { recursive: true, mode: 0o700 });
  const destination = path.join(config.LANGUAGE_DIR, `${language.code}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(document, null, 2).normalize('NFC')}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) throw new Error('Die Sprachdatei ist zu groß.');
  fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  scan();
  return language;
}

function adapterTranslations(adapterDir) {
  ensureCatalog();
  const available = new Map();
  readDirectory(path.join(adapterDir, 'languages'), available);
  const base = available.get('de');
  if (!base) return {};
  const chosen = available.get(selectedCode);
  const fallback = available.get(fallbackCode());
  const other = available.get(fallbackCode() === 'de' ? 'en' : 'de');
  const result = {};
  for (const [key, source] of Object.entries(base.messages)) {
    const translated = chosen?.messages[key] ?? fallback?.messages[key] ?? other?.messages[key] ?? source;
    result[source] = translated;
    result[`@${key}`] = translated;
  }
  for (const [source, key] of Object.entries(base.aliases || {})) {
    result[source] = chosen?.messages[key] ?? fallback?.messages[key] ?? other?.messages[key] ?? base.messages[key] ?? source;
  }
  return result;
}

function formatDate(value) {
  ensureCatalog();
  let date = value instanceof Date ? value : null;
  const match = !date && String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match) date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  if (!date || Number.isNaN(date.getTime())) return String(value == null ? '' : value);
  return new Intl.DateTimeFormat(current().locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function localizePayload(value, parentKey = '') {
  if (typeof value === 'string') {
    return new Set(['error', 'message', 'title', 'detail', 'text']).has(parentKey)
      ? localizeText(value)
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => localizePayload(entry, parentKey));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, localizePayload(entry, key)]));
}

module.exports = {
  MAX_FILE_BYTES, init, ready, scan, install, select, setTimezone, current,
  listLanguages, t, localizeText, localizePayload, adapterTranslations, validateDocument, formatDate,
};
