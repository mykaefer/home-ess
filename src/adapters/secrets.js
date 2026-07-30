'use strict';

// Restriktiver Dateispeicher für Adapter-Secrets. Die öffentliche Host-API gibt
// nur den Wert für die eigene Instanz zurück; Pfade sind nicht frei wählbar.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^[a-zA-Z0-9_.-]{1,80}$/;
const MAX_SECRET_BYTES = 16 * 1024;
let rootDir = null;

function init(identityDir) {
  rootDir = path.join(identityDir, 'adapter-secrets');
}

function paths(instanceId, key) {
  if (!rootDir) throw new Error('Adapter-Secret-Store ist nicht initialisiert.');
  if (!Number.isInteger(Number(instanceId)) || Number(instanceId) < 1) throw new Error('Ungültige Adapter-Instanz.');
  if (!NAME_RE.test(String(key))) throw new Error('Ungültiger Secret-Schlüssel.');
  const dir = path.join(rootDir, String(Number(instanceId)));
  return { dir, file: path.join(dir, String(key)) };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function set(instanceId, key, value) {
  const data = Buffer.from(String(value == null ? '' : value), 'utf8');
  if (data.length > MAX_SECRET_BYTES) throw new Error('Adapter-Secret ist zu groß.');
  const target = paths(instanceId, key);
  ensureDir(rootDir);
  ensureDir(target.dir);
  const tmp = path.join(target.dir, `.${key}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target.file);
}

function get(instanceId, key) {
  const target = paths(instanceId, key);
  let stat;
  try {
    stat = fs.lstatSync(target.file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SECRET_BYTES) {
    throw new Error('Adapter-Secret-Datei ist ungültig.');
  }
  return fs.readFileSync(target.file, 'utf8');
}

function remove(instanceId, key) {
  const target = paths(instanceId, key);
  try {
    fs.unlinkSync(target.file);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function removeInstance(instanceId) {
  const target = paths(instanceId, 'placeholder').dir;
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { init, set, get, remove, removeInstance, _paths: paths };
