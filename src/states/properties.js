'use strict';

// Anzeige-Eigenschaften und adapterspezifische Optionen eines beliebigen States.
//
// Ein State kann aus einem Adapter, aus den berechneten Systemwerten oder aus
// den Custom States stammen. Unabhängig davon lassen sich hier Nachkommastellen,
// Rundung und Einheit hinterlegen; sie überschreiben die Darstellung der Quelle.
// Weil die Anzeige an vielen Stellen synchron formatiert, hält dieses Modul die
// Eigenschaften zusätzlich in einem Cache, der beim Start gefüllt und bei jeder
// Änderung fortgeschrieben wird.

const ROUNDINGS = new Set(['nearest', 'floor', 'ceil', 'trunc']);
const MAX_UNIT_LENGTH = 24;
const MAX_DECIMALS = 12;

let activeDb = null;
const cache = new Map(); // topic -> { decimals, rounding, unit }

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function normalize(input = {}) {
  const rawDecimals = input.decimals === '' || input.decimals == null ? null : Number(input.decimals);
  const decimals = Number.isInteger(rawDecimals) && rawDecimals >= 0 && rawDecimals <= MAX_DECIMALS
    ? rawDecimals
    : null;
  return {
    decimals,
    rounding: ROUNDINGS.has(String(input.rounding)) ? String(input.rounding) : 'nearest',
    unit: String(input.unit == null ? '' : input.unit).trim().slice(0, MAX_UNIT_LENGTH),
  };
}

function isEmpty(properties) {
  return properties.decimals == null && !properties.unit;
}

function roundNumber(value, decimals, rounding) {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const fn = rounding === 'floor' ? Math.floor
    : rounding === 'ceil' ? Math.ceil
      : rounding === 'trunc' ? Math.trunc : Math.round;
  return fn(scaled + (rounding === 'nearest' ? Number.EPSILON : 0)) / factor;
}

// Synchroner Zugriff für die Anzeige. Ohne geladenen Cache (z. B. in Tests)
// bleibt alles beim Verhalten der Quelle.
function get(topic) {
  return cache.get(String(topic || '')) || null;
}

function all() {
  return new Map(cache);
}

// Wert eines States mit den hinterlegten Eigenschaften darstellen. `unit` ist
// die Einheit der Quelle; eine eigene Einheit ersetzt sie.
function format(value, unit, topic) {
  const properties = topic ? get(topic) : null;
  const effectiveUnit = properties && properties.unit ? properties.unit : String(unit || '');
  if (value == null || value === '') return '—';
  let text = value;
  if (properties && properties.decimals != null) {
    const numeric = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (Number.isFinite(numeric)) {
      text = roundNumber(numeric, properties.decimals, properties.rounding)
        .toFixed(properties.decimals)
        .replace('.', ',');
    }
  }
  return effectiveUnit ? `${text} ${effectiveUnit}` : String(text);
}

// Katalogeinträge ({ id, value, unit, display }) nachformatieren. Quellen wie
// Custom States oder berechnete Systemwerte liefern ihre Darstellung fertig mit;
// hinterlegte Eigenschaften gehen ihr vor.
function applyToEntries(entries) {
  if (!cache.size) return entries || [];
  for (const entry of entries || []) {
    if (!entry) continue;
    const topic = entry.id || entry.topic;
    const properties = get(topic);
    if (!properties) continue;
    if (properties.unit) entry.unit = properties.unit;
    entry.display = format(entry.value, entry.unit || '', topic);
  }
  return entries || [];
}

// Dasselbe für den States-Baum (Blöcke → Kategorien → States).
function applyToBlocks(blocks) {
  if (!cache.size) return blocks || [];
  const walk = (categories) => {
    for (const category of categories || []) {
      applyToEntries(category.states);
      walk(category.children);
    }
  };
  for (const block of blocks || []) walk(block && block.categories);
  return blocks || [];
}

async function init(db) {
  activeDb = db;
  await reload(db);
}

async function reload(db = activeDb) {
  if (!db) return cache;
  const rows = await dbAll(db, 'SELECT topic, decimals, rounding, unit FROM state_properties').catch(() => []);
  cache.clear();
  for (const row of rows) {
    const properties = normalize(row);
    if (!isEmpty(properties)) cache.set(String(row.topic), properties);
  }
  return cache;
}

async function save(db, topic, input) {
  const key = String(topic || '').trim();
  if (!key) throw new Error('Kein State angegeben.');
  const properties = normalize(input);
  if (isEmpty(properties)) {
    await dbRun(db, 'DELETE FROM state_properties WHERE topic = ?', [key]);
    cache.delete(key);
    return properties;
  }
  await dbRun(
    db,
    `INSERT INTO state_properties (topic, decimals, rounding, unit, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(topic) DO UPDATE SET
       decimals = excluded.decimals,
       rounding = excluded.rounding,
       unit = excluded.unit,
       updated_at = excluded.updated_at`,
    [key, properties.decimals, properties.rounding, properties.unit, Date.now()]
  );
  cache.set(key, properties);
  return properties;
}

// ── Adapterspezifische Optionen je State ─────────────────────────────────────

function parseOptions(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// Optionen aller States für eine Adapterinstanz – das liest der Adapter.
async function listOptionsForInstance(db, instanceId) {
  const rows = await dbAll(
    db,
    'SELECT topic, options_json FROM state_adapter_options WHERE instance_id = ? ORDER BY topic',
    [Number(instanceId)]
  ).catch(() => []);
  return rows.map((row) => ({ topic: String(row.topic), options: parseOptions(row.options_json) }));
}

// Optionen aller Instanzen für genau einen State – das braucht der Dialog.
async function listOptionsForTopic(db, topic) {
  const rows = await dbAll(
    db,
    'SELECT instance_id, options_json FROM state_adapter_options WHERE topic = ?',
    [String(topic || '')]
  ).catch(() => []);
  const result = new Map();
  for (const row of rows) result.set(Number(row.instance_id), parseOptions(row.options_json));
  return result;
}

async function saveOptions(db, instanceId, topic, options) {
  const key = String(topic || '').trim();
  const id = Number(instanceId);
  if (!key || !Number.isInteger(id)) throw new Error('Ungültige Zuordnung.');
  const value = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (!Object.keys(value).length) {
    await dbRun(db, 'DELETE FROM state_adapter_options WHERE instance_id = ? AND topic = ?', [id, key]);
    return {};
  }
  await dbRun(
    db,
    `INSERT INTO state_adapter_options (instance_id, topic, options_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(instance_id, topic) DO UPDATE SET
       options_json = excluded.options_json,
       updated_at = excluded.updated_at`,
    [id, key, JSON.stringify(value), Date.now()]
  );
  return value;
}

module.exports = {
  ROUNDINGS,
  normalize,
  roundNumber,
  init,
  reload,
  get,
  all,
  format,
  applyToEntries,
  applyToBlocks,
  save,
  listOptionsForInstance,
  listOptionsForTopic,
  saveOptions,
};
