'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Temp-Adapterverzeichnis und Temp-DB VOR dem Laden von config/db setzen.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-internal-values-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(ADAPTER_DIR, { recursive: true });
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const registry = require('../src/adapters/registry');
const instancesRepo = require('../src/adapters/instances');
const host = require('../src/adapters/host');
const { openDatabase } = require('../src/db');
const { listInternalValues } = require('../src/output/internal-values');

function writeAdapter(id, prefix) {
  const dir = path.join(ADAPTER_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'adapter.json'),
    JSON.stringify({ id, name: `${id} Adapter`, prefix, main: 'index.js', settings: [] })
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => ({ start() {} });');
}

function freshDb() {
  const dbPath = process.env.HOME_ESS_DB;
  fs.rmSync(dbPath, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

test('Adapter-States erscheinen automatisch im Wertekatalog (listInternalValues)', async () => {
  writeAdapter('demo', 'demo');
  registry.loadRegistry();
  const db = await freshDb();
  const id = await instancesRepo.createInstance(db, 'demo', 'simcat');
  await instancesRepo.setEnabled(db, id, true);

  const children = [];
  host._setForkImpl(() => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = (msg) => child.sent.push(msg);
    child.kill = () => child.emit('exit', 0);
    children.push(child);
    return child;
  });

  await host.initAdapters(db);
  const child = children[0];
  child.emit('message', { type: 'states', list: [
    { address: 'messwerte/temperatur', name: 'Temperatur', category: 'Messwerte', unit: '°C' },
  ] });
  child.emit('message', { type: 'value', address: 'messwerte/temperatur', value: 21.5 });
  await new Promise((r) => setTimeout(r, 150));

  const values = await listInternalValues(db, new Map());
  const entry = values.find((v) => v.id === 'demo://simcat/messwerte/temperatur');
  assert.ok(entry, 'Adapter-State ist im Wertekatalog vorhanden');
  assert.equal(entry.label, 'simcat – Temperatur');
  assert.equal(entry.category, 'Adapter: simcat');
  assert.equal(entry.value, 21.5);

  await host.stopInstance(id);
  db.close();
});
