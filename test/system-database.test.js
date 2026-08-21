'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-system-database-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { openDatabase } = require('../src/db');
const systemDatabase = require('../src/database');
const { normalizeDatabaseInput, isConfigured } = require('../src/database/config');
const { InfluxReader, quoteIdentifier, quoteLiteral } = require('../src/database/influx-reader');

// ── Konfiguration ──────────────────────────────────────────────────────────

test('ohne Server bleibt die Anbindung aus, auch wenn sie eingeschaltet wäre', () => {
  const config = normalizeDatabaseInput({ enabled: '1', host: '   ' });
  assert.equal(config.enabled, 0);
  assert.equal(isConfigured(config), false);
});

test('Eingaben werden auf gültige Werte gezogen', () => {
  const config = normalizeDatabaseInput({
    enabled: '1', protocol: 'HTTPS', host: ' influx.local ', port: '9999',
    database: 'messwerte', username: 'homeess', password: 'geheim', verifyTls: '0',
  });
  assert.deepEqual(
    { ...config, sourceLabel: config.sourceLabel },
    {
      enabled: 1, type: 'influxdb1', protocol: 'https', host: 'influx.local', port: 9999,
      database: 'messwerte', username: 'homeess', password: 'geheim', verifyTls: 0,
      sourceLabel: '', sourceInstanceId: null,
    }
  );
  // Unsinnige Ports fallen auf den Standard zurück.
  assert.equal(normalizeDatabaseInput({ host: 'x', port: '0' }).port, 8086);
  assert.equal(normalizeDatabaseInput({ host: 'x', port: '99999' }).port, 8086);
});

test('Konfiguration wird gespeichert und wieder geladen', async () => {
  const db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const saved = await systemDatabase.save(db, {
    enabled: '1', host: '127.0.0.1', port: '8086', database: 'homeess',
    username: 'user', password: 'pass', sourceLabel: 'InfluxDB – Haus', sourceInstanceId: 3,
  });
  assert.equal(saved.enabled, 1);
  assert.equal(saved.sourceLabel, 'InfluxDB – Haus');
  assert.equal(saved.sourceInstanceId, 3);
  assert.ok(saved.updatedAt > 0);

  systemDatabase.invalidate();
  const loaded = await systemDatabase.load(db);
  assert.equal(loaded.host, '127.0.0.1');
  assert.equal(loaded.database, 'homeess');
  assert.equal(loaded.password, 'pass');
  assert.equal(loaded.sourceInstanceId, 3);
  await new Promise((resolve) => db.close(resolve));
});

// ── InfluxQL-Erzeugung ─────────────────────────────────────────────────────

test('Bezeichner und Literale können die Abfrage nicht verlassen', () => {
  assert.equal(quoteIdentifier('pv"; DROP'), '"pv\\"; DROP"');
  assert.equal(quoteLiteral("Haus'; --"), "'Haus\\'; --'");
});

// ── Abfragen gegen einen nachgebildeten InfluxDB-Server ────────────────────

function startFakeInflux(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Messreihen und Zeitreihen werden gelesen und in Punkte übersetzt', async () => {
  const queries = [];
  const server = await startFakeInflux((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ping') {
      res.writeHead(204, { 'X-Influxdb-Version': '1.8.10' });
      return res.end();
    }
    const statement = url.searchParams.get('q') || '';
    queries.push(statement);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (/SHOW MEASUREMENTS/.test(statement)) {
      return res.end(JSON.stringify({ results: [{ series: [{ values: [['pv.leistung'], ['batterie.soc']] }] }] }));
    }
    return res.end(JSON.stringify({
      results: [{ series: [{ values: [[1786531200000, 1234.5], [1786531260000, '1300'], [1786531320000, null]] }] }],
    }));
  });
  const { port } = server.address();
  const reader = new InfluxReader({ host: '127.0.0.1', port, database: 'homeess' });

  const info = await reader.ping();
  assert.equal(info.version, '1.8.10');

  assert.deepEqual(await reader.listMeasurements(), ['pv.leistung', 'batterie.soc']);

  const series = await reader.readSeries({
    measurement: 'pv.leistung', from: 1786531200000, to: 1786534800000,
    intervalMs: 60000, aggregate: 'mean',
  });
  assert.deepEqual(series.points, [
    { t: 1786531200000, v: 1234.5 },
    { t: 1786531260000, v: 1300 },
  ], 'leere Werte werden übersprungen, Zahlen in Textform bleiben Zahlen');

  const statement = queries[queries.length - 1];
  assert.match(statement, /SELECT mean\("value"\) FROM "pv\.leistung"/);
  assert.match(statement, /time >= 1786531200000ms AND time <= 1786534800000ms/);
  assert.match(statement, /GROUP BY time\(60000ms\) fill\(none\)/);

  await new Promise((resolve) => server.close(resolve));
});

test('eine unbekannte Aggregatfunktion fällt auf den Mittelwert zurück', async () => {
  const queries = [];
  const server = await startFakeInflux((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    queries.push(url.searchParams.get('q') || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ series: [{ values: [] }] }] }));
  });
  const { port } = server.address();
  const reader = new InfluxReader({ host: '127.0.0.1', port, database: 'homeess' });
  await reader.readSeries({ measurement: 'x', intervalMs: 1000, aggregate: 'DELETE FROM' });
  assert.match(queries[0], /SELECT mean\("value"\)/);
  await new Promise((resolve) => server.close(resolve));
});

test('ein Fehler der Datenbank wird als Fehler gemeldet, nicht als leeres Ergebnis', async () => {
  const server = await startFakeInflux((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ error: 'database not found: homeess' }] }));
  });
  const { port } = server.address();
  const reader = new InfluxReader({ host: '127.0.0.1', port, database: 'homeess' });
  await assert.rejects(() => reader.listMeasurements(), /database not found/);
  await new Promise((resolve) => server.close(resolve));
});

test('der Verbindungstest meldet Erfolg samt Version und Anzahl der Messreihen', async () => {
  const server = await startFakeInflux((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ping') {
      res.writeHead(204, { 'X-Influxdb-Version': '1.8.10' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ results: [{ series: [{ values: [['pv.leistung']] }] }] }));
  });
  const { port } = server.address();
  const db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const result = await systemDatabase.testConnection(db, normalizeDatabaseInput({
    enabled: true, host: '127.0.0.1', port, database: 'homeess',
  }));
  assert.equal(result.ok, true);
  assert.match(result.message, /1\.8\.10/);
  assert.match(result.message, /1 Messreihe/);
  assert.equal(systemDatabase.getStatus().ok, true);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
});

test('ein nicht erreichbarer Server ergibt einen klaren Fehlertext statt eines Absturzes', async () => {
  const db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Port 1 ist auf keinem System belegt.
  const result = await systemDatabase.testConnection(db, normalizeDatabaseInput({
    enabled: true, host: '127.0.0.1', port: 1, database: 'homeess',
  }));
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
  await new Promise((resolve) => db.close(resolve));
});

test('ohne eingerichtete Anbindung liefern Abfragen keine Daten statt Verbindungsfehler', async () => {
  const db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await systemDatabase.save(db, { enabled: false, host: '' });
  assert.deepEqual(await systemDatabase.listMeasurements(db), []);
  await assert.rejects(() => systemDatabase.readSeries(db, { measurement: 'x' }), /keine Systemdatenbank/);
  await new Promise((resolve) => db.close(resolve));
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
