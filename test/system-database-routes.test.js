'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Temp-Adapterverzeichnis und Temp-DB VOR dem Laden von config/db setzen.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-system-database-routes-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(ADAPTER_DIR, { recursive: true });
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { openDatabase } = require('../src/db');
const registry = require('../src/adapters/registry');
const instancesRepo = require('../src/adapters/instances');
const adapterRoutes = require('../src/routes/adapters');
const databaseRoutes = require('../src/routes/database');
const settingsRoutes = require('../src/routes/settings');
const systemDatabase = require('../src/database');

let db;
let server;
let baseUrl;
let influx;
let influxPort;

// Datenbank-Adapter mit Manifest-Feld `systemDatabase`.
function writeDatabaseAdapter() {
  const dir = path.join(ADAPTER_DIR, 'testdb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify({
    id: 'testdb',
    name: 'TestDB',
    prefix: 'testdb',
    main: 'index.js',
    settings: [
      { key: 'protocol', label: 'Protokoll', type: 'select', default: 'http', options: ['http', 'https'] },
      { key: 'host', label: 'Server', type: 'text', default: '' },
      { key: 'port', label: 'Port', type: 'number', default: 8086 },
      { key: 'database', label: 'Datenbank', type: 'text', default: 'homeess' },
      { key: 'username', label: 'Benutzer', type: 'text', default: '' },
      { key: 'password', label: 'Kennwort', type: 'password', default: '' },
      { key: 'verifyTls', label: 'TLS prüfen', type: 'checkbox', default: true },
    ],
    systemDatabase: {
      type: 'influxdb1',
      label: 'Als Standard-Datenbank für homeESS übernehmen',
      hint: 'Kopiert die Verbindungsdaten.',
      fields: {
        protocol: 'protocol', host: 'host', port: 'port', database: 'database',
        username: 'username', password: 'password', verifyTls: 'verifyTls',
      },
    },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => ({ start() {} });');
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  writeDatabaseAdapter();
  registry.loadRegistry();
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Nachgebildete InfluxDB für die Abfrageschnittstelle.
  influx = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ping') {
      res.writeHead(204, { 'X-Influxdb-Version': '1.8.10' });
      return res.end();
    }
    const statement = url.searchParams.get('q') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (/SHOW MEASUREMENTS/.test(statement)) {
      return res.end(JSON.stringify({ results: [{ series: [{ values: [['pv.leistung'], ['batterie.soc']] }] }] }));
    }
    return res.end(JSON.stringify({ results: [{ series: [{ values: [[1786531200000, 42]] }] }] }));
  });
  await new Promise((resolve) => influx.listen(0, '127.0.0.1', resolve));
  influxPort = influx.address().port;

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(adapterRoutes(db));
  app.use(databaseRoutes(db));
  app.use(settingsRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (influx) await new Promise((resolve) => influx.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('die Instanzseite eines Datenbank-Adapters zeigt den Übernahme-Knopf', async () => {
  const id = await instancesRepo.createInstance(db, 'testdb', 'Haus');
  const html = await fetch(`${baseUrl}/adapter/instance/${id}`).then((res) => res.text());
  assert.match(html, /Als Standard-Datenbank für homeESS übernehmen/);
  assert.match(html, new RegExp(`/adapter/instance/${id}/system-database`));
});

test('ohne Server verweigert die Übernahme mit klarem Hinweis', async () => {
  const id = await instancesRepo.createInstance(db, 'testdb', 'Leer');
  const html = await fetch(`${baseUrl}/adapter/instance/${id}/system-database`, { method: 'POST' })
    .then((res) => res.text());
  assert.match(html, /noch keinen Server/);
  const config = await systemDatabase.load(db);
  assert.equal(config.enabled, 0, 'nichts übernommen');
});

test('der Knopf übernimmt die gespeicherten Verbindungsdaten in die Systemeinstellungen', async () => {
  const id = await instancesRepo.createInstance(db, 'testdb', 'Keller');
  await instancesRepo.updateSettingKeys(db, id, {
    protocol: 'http', host: '127.0.0.1', port: influxPort, database: 'homeess',
    username: 'homeess', password: 'geheim', verifyTls: true,
  });

  const html = await fetch(`${baseUrl}/adapter/instance/${id}/system-database`, { method: 'POST' })
    .then((res) => res.text());
  assert.match(html, /Übernommen/);

  systemDatabase.invalidate();
  const config = await systemDatabase.load(db);
  assert.equal(config.enabled, 1, 'die Anbindung wird dabei eingeschaltet');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, influxPort);
  assert.equal(config.database, 'homeess');
  assert.equal(config.password, 'geheim');
  assert.equal(config.sourceLabel, 'TestDB – Keller');
  assert.equal(config.sourceInstanceId, id);

  // Die Herkunft steht auf der Einstellungsseite.
  const settings = await fetch(`${baseUrl}/settings`).then((res) => res.text());
  assert.match(settings, /Übernommen aus: <strong>TestDB – Keller<\/strong>/);
  assert.match(settings, /<h2>Datenbank<\/h2>/);
});

test('die Abfrageschnittstelle liefert Messreihen und Zeitreihen', async () => {
  const status = await fetch(`${baseUrl}/database/status`).then((res) => res.json());
  assert.equal(status.configured, true);
  assert.equal(status.database, 'homeess');
  // Zugangsdaten dürfen die Schnittstelle nicht verlassen.
  assert.equal(status.password, undefined);
  assert.equal(status.username, undefined);

  const measurements = await fetch(`${baseUrl}/database/measurements`).then((res) => res.json());
  assert.deepEqual(measurements.measurements, ['pv.leistung', 'batterie.soc']);

  const series = await fetch(`${baseUrl}/database/series?measurement=pv.leistung,batterie.soc&interval=60000`)
    .then((res) => res.json());
  assert.equal(series.series.length, 2);
  assert.deepEqual(series.series[0].points, [{ t: 1786531200000, v: 42 }]);
  assert.equal(series.aggregate, 'mean');

  const missing = await fetch(`${baseUrl}/database/series`);
  assert.equal(missing.status, 400);
});

test('das Speichern von Hand löst die Herkunft aus dem Adapter', async () => {
  const response = await fetch(`${baseUrl}/settings/database`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `enabled=1&protocol=http&host=influx.local&port=8086&database=messwerte&username=&password=&verifyTls=1`,
  });
  const html = await response.text();
  assert.match(html, /Datenbankeinstellungen gespeichert/);

  systemDatabase.invalidate();
  const config = await systemDatabase.load(db);
  assert.equal(config.host, 'influx.local');
  assert.equal(config.sourceLabel, '', 'von Hand gepflegt: keine Adapter-Herkunft mehr');
  assert.equal(config.sourceInstanceId, null);
});

test('abgewählte Kontrollkästchen schalten die Anbindung und die TLS-Prüfung wirklich aus', async () => {
  await fetch(`${baseUrl}/settings/database`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // Wie der Browser: nicht angehakte Kästchen fehlen im Rumpf.
    body: 'protocol=https&host=influx.local&port=8086&database=messwerte&username=&password=',
  });
  systemDatabase.invalidate();
  const config = await systemDatabase.load(db);
  assert.equal(config.enabled, 0);
  assert.equal(config.verifyTls, 0);
});
