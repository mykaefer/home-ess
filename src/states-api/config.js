'use strict';

// Persistente Einstellungen der States API (Tabelle states_api_config, eine
// Zeile). Die API liest bei jedem Request aus dem Speicherabbild; geschrieben
// wird ausschließlich über save*(), das Datenbank und Abbild gemeinsam
// aktualisiert.
//
// Gespeichert werden:
//   enabled            – API an/aus (Standard: aus)
//   passwordHash       – scrypt-Hash aus auth/password.js, nie Klartext
//   credentialVersion  – steigt bei jeder Passwortänderung; ein Token trägt die
//                        Version, mit der es ausgestellt wurde
//   excludedFolders    – Verzeichnispfade (Form „System / Photovoltaik“)
//   excludedStates     – kanonische State-Topics

const { hashPassword, isHashed } = require('../auth/password');
const { normalizePath } = require('../states/catalog');

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MAX_EXCLUSIONS = 5000;
const MAX_ENTRY_LENGTH = 1000;

const DEFAULTS = Object.freeze({
  enabled: false,
  passwordHash: '',
  credentialVersion: 0,
  excludedFolders: [],
  excludedStates: [],
  updatedAt: 0,
});

let current = { ...DEFAULTS };

function validationError(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

function parseList(text) {
  try {
    const value = JSON.parse(String(text || '[]'));
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

// Ein Verzeichnispfad in kanonischer Schreibweise (Segmente getrimmt, mit
// „ / “ verbunden) — dieselbe Normalisierung wie im States-Katalog.
function normalizeFolder(value) {
  return normalizePath(String(value == null ? '' : value).slice(0, MAX_ENTRY_LENGTH));
}

function normalizeTopic(value) {
  return String(value == null ? '' : value).trim().slice(0, MAX_ENTRY_LENGTH);
}

function uniqueList(values, normalize) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const entry = normalize(value);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
    if (result.length >= MAX_EXCLUSIONS) break;
  }
  return result;
}

function fromRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    enabled: row.enabled === 1 || row.enabled === true,
    passwordHash: isHashed(row.password_hash) ? row.password_hash : '',
    credentialVersion: Number(row.credential_version) || 0,
    excludedFolders: uniqueList(parseList(row.excluded_folders), normalizeFolder),
    excludedStates: uniqueList(parseList(row.excluded_states), normalizeTopic),
    updatedAt: Number(row.updated_at) || 0,
  };
}

function load(db) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM states_api_config WHERE id = 1', (error, row) => {
      if (error) return reject(error);
      current = fromRow(row);
      return resolve(snapshot());
    });
  });
}

// Beim Start einmal laden. Ein Fehler lässt die API ausgeschaltet.
function init(db) {
  return load(db).catch((error) => {
    current = { ...DEFAULTS };
    throw error;
  });
}

function persist(db, next) {
  const value = { ...next, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO states_api_config
        (id, enabled, password_hash, credential_version, excluded_folders, excluded_states, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         password_hash = excluded.password_hash,
         credential_version = excluded.credential_version,
         excluded_folders = excluded.excluded_folders,
         excluded_states = excluded.excluded_states,
         updated_at = excluded.updated_at`,
      [
        value.enabled ? 1 : 0,
        value.passwordHash,
        value.credentialVersion,
        JSON.stringify(value.excludedFolders),
        JSON.stringify(value.excludedStates),
        value.updatedAt,
      ],
      (error) => {
        if (error) return reject(error);
        current = value;
        return resolve(snapshot());
      }
    );
  });
}

// Öffentliches Abbild ohne Passwort-Hash (für Oberfläche und Logik).
function snapshot() {
  return {
    enabled: current.enabled,
    hasPassword: !!current.passwordHash,
    credentialVersion: current.credentialVersion,
    excludedFolders: [...current.excludedFolders],
    excludedStates: [...current.excludedStates],
    updatedAt: current.updatedAt,
  };
}

function get() {
  return snapshot();
}

// Nur für die Passwortprüfung – verlässt dieses Modul nicht in Richtung Browser.
function passwordHash() {
  return current.passwordHash;
}

// Die API ist nur nutzbar, wenn sie eingeschaltet ist und ein Passwort hat.
function isActive() {
  return current.enabled && !!current.passwordHash;
}

async function saveEnabled(db, enabled) {
  const wanted = !!enabled;
  if (wanted && !current.passwordHash) {
    throw validationError('Bitte zuerst ein API-Passwort festlegen.');
  }
  return persist(db, { ...current, enabled: wanted });
}

function validatePassword(password, repeat) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw validationError('Das Passwort muss mindestens 8 Zeichen lang sein.');
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw validationError('Das Passwort darf höchstens 256 Zeichen lang sein.');
  }
  if (value !== repeat) throw validationError('Die Passwörter stimmen nicht überein.');
  return value;
}

// Neues Passwort setzen: alter Hash wird ersetzt, die Credential-Version steigt
// (alle bisher ausgestellten Tokens verlieren damit ihre Gültigkeit).
async function savePassword(db, password, repeat) {
  const value = validatePassword(password, repeat);
  return persist(db, {
    ...current,
    passwordHash: hashPassword(value),
    credentialVersion: current.credentialVersion + 1,
  });
}

async function saveExclusions(db, { excludedFolders, excludedStates }) {
  return persist(db, {
    ...current,
    excludedFolders: uniqueList(excludedFolders, normalizeFolder),
    excludedStates: uniqueList(excludedStates, normalizeTopic),
  });
}

// Nur für Tests: Speicherabbild zurücksetzen.
function resetForTests() {
  current = { ...DEFAULTS };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  init,
  load,
  get,
  isActive,
  passwordHash,
  saveEnabled,
  savePassword,
  saveExclusions,
  normalizeFolder,
  normalizeTopic,
  resetForTests,
};
