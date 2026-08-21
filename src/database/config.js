'use strict';

// Zentrale Datenbankanbindung von homeESS (Tabelle system_database, id = 1).
//
// homeESS selbst speichert seine Betriebsdaten in SQLite; für Zeitreihen
// (Diagramme, Auswertungen über lange Zeiträume) wird eine InfluxDB 1.x
// angebunden. Das kann dieselbe Datenbank sein, in die der InfluxDB-Adapter
// schreibt — oder eine beliebige andere, auch auf einem anderen Server.
//
// Die Konfiguration ist bewusst eine eigenständige Kopie: Der Übernahme-Knopf
// eines Datenbank-Adapters füllt die Felder einmalig, danach bleiben sie frei
// bearbeitbar (siehe `sourceLabel`/`sourceInstanceId` für die Herkunft).

const DEFAULTS = {
  enabled: 0,
  type: 'influxdb1',
  protocol: 'http',
  host: '',
  port: 8086,
  database: 'homeess',
  username: '',
  password: '',
  verifyTls: 1,
  sourceLabel: '',
  sourceInstanceId: null,
  updatedAt: 0,
};

// Derzeit ist InfluxDB 1.x der einzige unterstützte Typ. Der Wert wird
// mitgeführt, damit weitere Typen später ohne Migration hinzukommen können.
const SUPPORTED_TYPES = new Set(['influxdb1']);

let cachedDb = null;
let cachedConfig = null;

function boolean(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') return !['', '0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function port(value) {
  const parsed = Math.round(Number(String(value == null ? '' : value).trim()));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULTS.port;
}

function text(value, fallback = '', maxLength = 200) {
  const result = String(value == null ? '' : value).trim().slice(0, maxLength);
  return result || fallback;
}

function rowToConfig(row = {}) {
  return {
    enabled: row.enabled ? 1 : 0,
    type: SUPPORTED_TYPES.has(row.type) ? row.type : DEFAULTS.type,
    protocol: row.protocol === 'https' ? 'https' : 'http',
    host: row.host || '',
    port: port(row.port),
    database: row.database_name || DEFAULTS.database,
    username: row.username || '',
    password: row.password || '',
    verifyTls: row.verify_tls == null ? 1 : (row.verify_tls ? 1 : 0),
    sourceLabel: row.source_label || '',
    sourceInstanceId: row.source_instance_id == null ? null : Number(row.source_instance_id),
    updatedAt: Number(row.updated_at) || 0,
  };
}

// Eingaben aus Formular oder Adapterübernahme in eine gültige Konfiguration
// überführen. Ohne Server bleibt die Anbindung aus — eine „aktive" Anbindung
// ohne Ziel wäre nur eine Fehlerquelle.
function normalizeDatabaseInput(input = {}) {
  const host = text(input.host);
  const config = {
    enabled: boolean(input.enabled, false) && !!host ? 1 : 0,
    type: SUPPORTED_TYPES.has(input.type) ? input.type : DEFAULTS.type,
    protocol: String(input.protocol || '').trim().toLowerCase() === 'https' ? 'https' : 'http',
    host,
    port: port(input.port),
    database: text(input.database, DEFAULTS.database),
    username: text(input.username),
    password: String(input.password == null ? '' : input.password).slice(0, 200),
    verifyTls: boolean(input.verifyTls, true) ? 1 : 0,
    sourceLabel: text(input.sourceLabel, '', 120),
    sourceInstanceId: Number.isInteger(Number(input.sourceInstanceId)) && Number(input.sourceInstanceId) > 0
      ? Number(input.sourceInstanceId)
      : null,
  };
  return config;
}

function loadDatabaseConfig(db, callback) {
  if (cachedDb === db && cachedConfig) {
    queueMicrotask(() => callback({ ...cachedConfig }));
    return;
  }
  db.get('SELECT * FROM system_database WHERE id = 1', (err, row) => {
    const config = err || !row ? { ...DEFAULTS } : rowToConfig(row);
    cachedDb = db;
    cachedConfig = config;
    callback({ ...config });
  });
}

function saveDatabaseConfig(db, input, callback) {
  const cfg = normalizeDatabaseInput(input);
  const updatedAt = Date.now();
  db.run(
    `INSERT INTO system_database
       (id, enabled, type, protocol, host, port, database_name, username, password, verify_tls,
        source_label, source_instance_id, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled=excluded.enabled, type=excluded.type, protocol=excluded.protocol,
       host=excluded.host, port=excluded.port, database_name=excluded.database_name,
       username=excluded.username, password=excluded.password, verify_tls=excluded.verify_tls,
       source_label=excluded.source_label, source_instance_id=excluded.source_instance_id,
       updated_at=excluded.updated_at`,
    [cfg.enabled, cfg.type, cfg.protocol, cfg.host, cfg.port, cfg.database, cfg.username,
      cfg.password, cfg.verifyTls, cfg.sourceLabel, cfg.sourceInstanceId, updatedAt],
    (err) => {
      const stored = { ...cfg, updatedAt };
      if (!err) {
        cachedDb = db;
        cachedConfig = stored;
      }
      callback(err, stored);
    }
  );
}

function invalidateDatabaseConfig(db = null) {
  if (!db || cachedDb === db) {
    cachedDb = null;
    cachedConfig = null;
  }
}

// Ist die Anbindung nutzbar? Genau diese Prüfung entscheidet, ob Diagramme
// überhaupt Daten anfragen dürfen.
function isConfigured(config) {
  return !!(config && config.enabled && config.host && config.database);
}

module.exports = {
  DEFAULTS,
  SUPPORTED_TYPES,
  loadDatabaseConfig,
  saveDatabaseConfig,
  invalidateDatabaseConfig,
  normalizeDatabaseInput,
  isConfigured,
};
