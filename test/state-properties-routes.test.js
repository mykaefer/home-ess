'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-props-routes-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(path.join(ADAPTER_DIR, 'historie'), { recursive: true });
fs.writeFileSync(path.join(ADAPTER_DIR, 'historie', 'adapter.json'), JSON.stringify({
  id: 'historie', prefix: 'historie', name: 'Historie', main: 'index.js',
  stateOptions: {
    label: 'Historie',
    enabledField: 'enabled',
    fields: [
      { key: 'enabled', label: 'Speichern', type: 'checkbox', default: false },
      { key: 'alias', label: 'Alias', type: 'text', default: '' },
      { key: 'mode', label: 'Modus', type: 'select', default: 'change', options: ['change', 'interval'] },
      { key: 'debounceSeconds', label: 'Entprellung', type: 'number', default: 5 },
    ],
  },
}));
fs.writeFileSync(path.join(ADAPTER_DIR, 'historie', 'index.js'), 'module.exports=()=>({start(){}});');
// Zweiter Adapter, der bewusst kein Schema anhängt.
fs.mkdirSync(path.join(ADAPTER_DIR, 'ohneschema'), { recursive: true });
fs.writeFileSync(path.join(ADAPTER_DIR, 'ohneschema', 'adapter.json'), JSON.stringify({
  id: 'ohneschema', prefix: 'ohneschema', name: 'Ohne Schema', main: 'index.js',
}));
fs.writeFileSync(path.join(ADAPTER_DIR, 'ohneschema', 'index.js'), 'module.exports=()=>({start(){}});');
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { EventEmitter } = require('events');

const { openDatabase } = require('../src/db');
const statesRoutes = require('../src/routes/states');
const registry = require('../src/adapters/registry');
const instancesRepo = require('../src/adapters/instances');
const stateProperties = require('../src/states/properties');
const adapterHost = require('../src/adapters/host');

let db;
let server;
let baseUrl;
let instanceId;
let access = null;

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  registry.loadRegistry();
  await stateProperties.init(db);
  instanceId = await instancesRepo.createInstance(db, 'historie', 'archiv');
  await instancesRepo.setEnabled(db, instanceId, true);
  // Der Host braucht seine Datenbankbindung, um gemeldete Schemata zu sichern.
  // Kindprozesse werden dabei durch eine Attrappe ersetzt.
  adapterHost._setForkImpl(() => {
    const child = new EventEmitter();
    child.send = () => {};
    child.kill = () => child.emit('exit', 0);
    return child;
  });
  await adapterHost.initAdapters(db);

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = access || fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(statesRoutes(db));
  server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await adapterHost.stopAll();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function api(method, url, body) {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('Der Dialog liefert Allgemein-Werte und einen Tab je aktiver Adapterinstanz', async () => {
  const response = await api('GET', '/states/properties?topic=demo%3A%2F%2Fa%2Fb&name=Wert');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.topic, 'demo://a/b');
  assert.deepEqual(data.general, { decimals: null, rounding: 'nearest', unit: '' });
  assert.deepEqual(data.roundings, ['nearest', 'floor', 'ceil', 'trunc']);
  assert.equal(data.adapters.length, 1);
  assert.equal(data.adapters[0].instanceName, 'archiv');
  assert.deepEqual(data.adapters[0].fields.map((field) => field.key),
    ['enabled', 'alias', 'mode', 'debounceSeconds']);
  assert.deepEqual(data.adapters[0].values, {});
  assert.equal(data.adapters[0].active, false, 'ohne gespeicherte Auswahl ist der Tab nicht markiert');
});

test('Die eigene Instanz erscheint für ihre eigenen States nicht als Tab', async () => {
  const response = await api('GET', `/states/properties?topic=${encodeURIComponent('historie://archiv/status/x')}`);
  const data = await response.json();
  assert.deepEqual(data.adapters, [], 'ein Adapter kann sich nicht selbst als Quelle eintragen');
});

test('Speichern legt Anzeigeeigenschaften und Adapteroptionen typisiert ab', async () => {
  const response = await api('POST', '/states/properties', {
    topic: 'demo://a/b',
    general: { decimals: 2, rounding: 'floor', unit: 'kWh' },
    adapters: {
      [String(instanceId)]: { enabled: '1', alias: 'haus.zaehler', mode: 'interval', debounceSeconds: '12' },
      // Eine unbekannte Instanz darf nichts anlegen.
      '9999': { enabled: true },
    },
  });
  assert.equal(response.status, 200);

  assert.deepEqual(stateProperties.get('demo://a/b'), { decimals: 2, rounding: 'floor', unit: 'kWh' });
  assert.equal(stateProperties.format(1.239, '', 'demo://a/b'), '1,23 kWh');

  const saved = await stateProperties.listOptionsForInstance(db, instanceId);
  assert.deepEqual(saved, [{
    topic: 'demo://a/b',
    options: { enabled: true, alias: 'haus.zaehler', mode: 'interval', debounceSeconds: 12 },
  }]);
  assert.equal((await stateProperties.listOptionsForTopic(db, 'demo://a/b')).size, 1);

  // Beim erneuten Öffnen sind die Werte vorbelegt.
  const reopened = await (await api('GET', '/states/properties?topic=demo%3A%2F%2Fa%2Fb')).json();
  assert.equal(reopened.general.decimals, 2);
  assert.equal(reopened.adapters[0].values.alias, 'haus.zaehler');
  // enabledField aus dem Manifest markiert den Tab als belegt.
  assert.equal(reopened.adapters[0].active, true);
});

test('Unbekannte Auswahlwerte fallen auf den Standard zurück', async () => {
  await api('POST', '/states/properties', {
    topic: 'demo://a/c',
    general: {},
    adapters: { [String(instanceId)]: { enabled: true, mode: 'unsinn', debounceSeconds: 'abc' } },
  });
  const saved = await stateProperties.listOptionsForTopic(db, 'demo://a/c');
  assert.equal(saved.get(instanceId).mode, 'change');
  assert.equal(saved.get(instanceId).debounceSeconds, 5);
});

test('Ohne Schreibrecht bleibt der Dialog lesbar, aber nicht speicherbar', async (t) => {
  const { fullAccess } = require('../src/auth/access');
  access = { ...fullAccess(), canWrite: false, isAdmin: false };
  t.after(() => { access = null; });
  const readable = await api('GET', '/states/properties?topic=demo%3A%2F%2Fa%2Fb');
  assert.equal(readable.status, 200);
  assert.equal((await readable.json()).canWrite, false);
  const denied = await api('POST', '/states/properties', { topic: 'demo://a/b', general: { unit: 'x' } });
  assert.equal(denied.status, 403);
});

test('Ein zur Laufzeit gemeldetes Schema geht dem Manifest vor', async (t) => {
  // Der Host nimmt das Schema so entgegen, wie es ein Adapterprozess meldet.
  const entry = {
    instance: await instancesRepo.getInstance(db, instanceId),
    manifest: registry.getManifest('historie'),
    child: { send() {} },
    subscriptions: new Map(),
    status: {},
  };
  adapterHost._handleMessage(entry, {
    type: 'state-options-schema',
    schema: {
      label: 'Historie · live',
      hint: 'Zur Laufzeit gemeldet.',
      enabledField: 'enabled',
      fields: [
        { key: 'enabled', label: 'Aufzeichnen', type: 'checkbox', default: false },
        { key: 'ziel', label: 'Ziel', type: 'select', default: 'a', options: ['a', 'b'] },
        // Unzulässiger Schlüssel wird auch hier verworfen.
        { key: 'böse"<script>', label: 'Nein', type: 'text' },
      ],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  t.after(async () => {
    adapterHost._handleMessage(entry, { type: 'state-options-schema', schema: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  const data = await (await api('GET', '/states/properties?topic=demo%3A%2F%2Fa%2Fneu')).json();
  assert.equal(data.adapters.length, 1);
  assert.equal(data.adapters[0].label, 'archiv', 'die Tab-Beschriftung bleibt der Instanzname');
  assert.equal(data.adapters[0].schemaLabel, 'Historie · live');
  assert.equal(data.adapters[0].hint, 'Zur Laufzeit gemeldet.');
  assert.deepEqual(data.adapters[0].fields.map((field) => field.key), ['enabled', 'ziel']);

  // Gespeichert wird gegen das gemeldete Schema, nicht gegen das Manifest.
  await api('POST', '/states/properties', {
    topic: 'demo://a/neu',
    general: {},
    adapters: { [String(instanceId)]: { enabled: true, ziel: 'b', alias: 'aus-dem-manifest' } },
  });
  const saved = await stateProperties.listOptionsForTopic(db, 'demo://a/neu');
  assert.deepEqual(saved.get(instanceId), { enabled: true, ziel: 'b' });
});

test('Ohne angehängtes Schema bleibt nur der Tab Allgemein', async (t) => {
  const id = await instancesRepo.createInstance(db, 'ohneschema', 'leer');
  await instancesRepo.setEnabled(db, id, true);
  t.after(() => new Promise((resolve) => db.run('DELETE FROM adapter_instances WHERE id = ?', [id], resolve)));
  const data = await (await api('GET', '/states/properties?topic=demo%3A%2F%2Fa%2Fohne')).json();
  assert.equal(data.adapters.some((tab) => tab.instanceId === id), false,
    'eine Instanz ohne Schema hängt keinen Tab an');
});
