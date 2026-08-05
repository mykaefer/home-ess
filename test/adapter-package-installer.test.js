'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-package-test-'));
process.env.HOME_ESS_ADAPTER_DIR = path.join(TMP, 'adapter');
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');
process.env.HOME_ESS_DATA_DIR = path.join(TMP, 'data');

const test = require('node:test');
const assert = require('node:assert/strict');
const installer = require('../src/adapters/package-installer');
const registry = require('../src/adapters/registry');
const selectionPolicy = require('../src/adapters/selection-policy');
const config = require('../src/config');

function zip(entries) {
  const local = [];
  const central = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '');
    const crc = entry.crc == null ? installer._crc32(data) : entry.crc;
    const declaredSize = entry.unpackedSize == null ? data.length : entry.unpackedSize;
    const directory = entry.name.endsWith('/');
    const mode = entry.mode == null ? (directory ? 0o040755 : 0o100644) : entry.mode;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(declaredSize, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(declaredSize, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(localOffset, 42);
    central.push(record, name);
    localOffset += header.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

function manifest(id, extra = {}) {
  return JSON.stringify({
    id, name: `${id} Adapter`, prefix: id, version: '1.0.0',
    main: 'index.js', multiInstance: true, settings: [], ...extra,
  });
}

function writeArchive(name, entries) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, zip(entries));
  return file;
}

test('gültiges ZIP wird erst nach vollständiger Prüfung als eigener Adapter installiert', () => {
  fs.mkdirSync(process.env.HOME_ESS_ADAPTER_DIR, { recursive: true });
  const archive = writeArchive('valid.zip', [
    { name: 'upload_ok/' },
    { name: 'upload_ok/adapter.json', data: manifest('upload_ok') },
    { name: 'upload_ok/index.js', data: 'global.__adapterUploadExecuted = true; module.exports = () => ({ start() {} });' },
    { name: 'upload_ok/assets/' },
    { name: 'upload_ok/assets/readme.txt', data: 'portable' },
  ]);
  delete global.__adapterUploadExecuted;
  const installed = installer.installAdapterPackage(archive);
  assert.equal(installed.id, 'upload_ok');
  assert.equal(global.__adapterUploadExecuted, undefined, 'Vorabprüfung führt Adaptercode nicht aus');
  assert.equal(fs.readFileSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'upload_ok/assets/readme.txt'), 'utf8'), 'portable');
  assert.ok(registry.loadRegistry().some((entry) => entry.id === 'upload_ok'));
});

test('fehlende Mindestwerte und Syntaxfehler werden vor /adapter abgewiesen', () => {
  const missing = writeArchive('missing.zip', [
    { name: 'adapter.json', data: JSON.stringify({ id: 'missing', prefix: 'missing', main: 'index.js' }) },
    { name: 'index.js', data: 'module.exports = () => ({})' },
  ]);
  assert.throws(() => installer.installAdapterPackage(missing), /name fehlt oder ist leer/);
  assert.equal(fs.existsSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'missing')), false);

  const syntax = writeArchive('syntax.zip', [
    { name: 'broken/adapter.json', data: manifest('broken') },
    { name: 'broken/index.js', data: 'module.exports = ( {' },
  ]);
  assert.throws(() => installer.installAdapterPackage(syntax), /ungültiges JavaScript/);
  assert.equal(fs.existsSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'broken')), false);
});

test('ZIP-Traversal, Symlinks, Prüfsummenfehler und Entpackbomben werden abgewiesen', () => {
  const cases = [
    ['traversal.zip', [
      { name: 'escape/adapter.json', data: manifest('escape') },
      { name: 'escape/index.js', data: 'module.exports = () => ({})' },
      { name: 'escape/../outside.js', data: 'x' },
    ], /Unsicherer ZIP-Pfad/],
    ['symlink.zip', [
      { name: 'linked/adapter.json', data: manifest('linked') },
      { name: 'linked/index.js', data: 'module.exports = () => ({})' },
      { name: 'linked/link', data: '../../outside', mode: 0o120777 },
    ], /Links und Spezialdateien/],
    ['crc.zip', [
      { name: 'badcrc/adapter.json', data: manifest('badcrc') },
      { name: 'badcrc/index.js', data: 'module.exports = () => ({})', crc: 1 },
    ], /Prüfsumme oder Größe/],
    ['bomb.zip', [
      { name: 'bomb/adapter.json', data: manifest('bomb') },
      { name: 'bomb/index.js', data: 'x', unpackedSize: installer.MAX_UNPACKED_BYTES + 1 },
    ], /zu groß/],
  ];
  for (const [filename, entries, expected] of cases) {
    const archive = writeArchive(filename, entries);
    assert.throws(() => installer.installAdapterPackage(archive), expected, filename);
  }
  assert.equal(fs.existsSync(path.join(TMP, 'outside.js')), false);
});

test('vorhandene Adapter und Prefixe werden niemals überschrieben', () => {
  const duplicate = writeArchive('duplicate.zip', [
    { name: 'upload_ok/adapter.json', data: manifest('upload_ok') },
    { name: 'upload_ok/index.js', data: 'module.exports = () => ({ changed: true })' },
  ]);
  assert.throws(() => installer.installAdapterPackage(duplicate), /bereits installiert/);
  assert.doesNotMatch(fs.readFileSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'upload_ok/index.js'), 'utf8'), /changed/);

  const prefix = writeArchive('prefix.zip', [
    { name: 'other/adapter.json', data: manifest('other', { prefix: 'upload_ok' }) },
    { name: 'other/index.js', data: 'module.exports = () => ({})' },
  ]);
  assert.throws(() => installer.installAdapterPackage(prefix), /Prefix upload_ok ist bereits vergeben/);
  assert.equal(fs.existsSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'other')), false);
});

test('Upload- und Löschroute sind adminbeschränkt, validieren sicher und halten den Server verfügbar', async () => {
  const express = require('express');
  const adapterRoutes = require('../src/routes/adapters');
  const { openDatabase } = require('../src/db');
  const instancesRepo = require('../src/adapters/instances');
  const access = require('../src/auth/access');
  const db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  let admin = false;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { id: 'adapter-upload-test', userId: 1 };
    req.access = { ...access.fullAccess(), isAdmin: admin };
    access.runWithAccess(req.access, () => next());
  });
  app.use(adapterRoutes(db));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const routeArchive = zip([
    { name: 'route_adapter/adapter.json', data: manifest('route_adapter') },
    { name: 'route_adapter/index.js', data: 'module.exports = () => ({ start() {} })' },
  ]);
  try {
    let response = await fetch(`${base}/adapter/upload`, {
      method: 'POST', body: routeArchive,
      headers: { 'Content-Type': 'application/zip', 'X-Upload-Filename': 'route.zip', Accept: 'application/json' },
    });
    assert.equal(response.status, 403);
    assert.equal(fs.existsSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'route_adapter')), false);

    admin = true;
    selectionPolicy.markRemoved(config.ADAPTER_SELECTION_FILE, 'route_adapter');
    response = await fetch(`${base}/adapter/upload`, {
      method: 'POST', body: Buffer.from('kein zip'),
      headers: { 'Content-Type': 'application/zip', 'X-Upload-Filename': 'broken.zip', Accept: 'application/json' },
    });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /ZIP/);

    response = await fetch(`${base}/adapter/upload`, {
      method: 'POST', body: routeArchive,
      headers: { 'Content-Type': 'application/zip', 'X-Upload-Filename': 'route.zip', Accept: 'application/json' },
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).adapter.id, 'route_adapter');
    assert.ok(registry.getManifest('route_adapter'));
    assert.equal(selectionPolicy.isRemoved(config.ADAPTER_SELECTION_FILE, 'route_adapter'), false,
      'erneuter Upload hebt die Entfernungsauswahl auf');

    admin = false;
    response = await fetch(`${base}/adapter/route_adapter/delete`, {
      method: 'POST', body: JSON.stringify({ confirmation: 'route_adapter' }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    assert.equal(response.status, 403, 'Löschen bleibt Administratoren vorbehalten');

    admin = true;
    response = await fetch(`${base}/adapter/route_adapter/delete`, {
      method: 'POST', body: JSON.stringify({ confirmation: 'falsch' }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    assert.equal(response.status, 422, 'exakte Adapter-ID ist als Bestätigung erforderlich');

    const instanceId = await instancesRepo.createInstance(db, 'route_adapter', 'delete-guard');
    response = await fetch(`${base}/adapter/route_adapter/delete`, {
      method: 'POST', body: JSON.stringify({ confirmation: 'route_adapter' }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    assert.equal(response.status, 409, 'Adapter mit Instanzen wird nicht gelöscht');
    assert.ok(fs.existsSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'route_adapter')));

    await instancesRepo.deleteInstance(db, instanceId);
    response = await fetch(`${base}/adapter/route_adapter/delete`, {
      method: 'POST', body: JSON.stringify({ confirmation: 'route_adapter' }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(process.env.HOME_ESS_ADAPTER_DIR, 'route_adapter')), false);
    assert.equal(registry.getManifest('route_adapter'), null);
    assert.equal(selectionPolicy.isRemoved(config.ADAPTER_SELECTION_FILE, 'route_adapter'), true,
      'Löschen bleibt für kommende Updates vorgemerkt');

    response = await fetch(`${base}/adapter`);
    assert.equal(response.status, 200, 'Server bleibt nach abgewiesenem und gelöschtem Paket erreichbar');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
