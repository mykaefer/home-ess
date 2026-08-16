'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const createInfluxAdapter = require('../adapter/influxdb');
const { InfluxClient, formatPoint, retentionPolicyName, retentionDuration } = require('../adapter/influxdb/client');
const setup = require('../adapter/influxdb/setup');

// ── Line Protocol und Aufbewahrung ───────────────────────────────────────────

test('Messpunkte werden im Line Protocol typrichtig kodiert', () => {
  assert.equal(formatPoint('haus.temperatur', 21.5, 1786531200000), 'haus.temperatur value=21.5 1786531200000');
  assert.equal(formatPoint('schalter', true, 1000), 'schalter value=true 1000');
  assert.equal(formatPoint('status', 'Standby', 1000), 'status value="Standby" 1000');
  // Zahlen in Textform bleiben Zahlen, damit Grafana sie zeichnen kann.
  assert.equal(formatPoint('zaehler', '42.7', 1000), 'zaehler value=42.7 1000');
  // Sonderzeichen im Namen werden maskiert.
  assert.equal(formatPoint('mein wert,mit', 1, 1000), 'mein\\ wert\\,mit value=1 1000');
  assert.equal(formatPoint('text', 'sagt "hallo"', 1000), 'text value="sagt \\"hallo\\"" 1000');
  assert.equal(formatPoint('leer', '', 1000), '', 'leere Werte erzeugen keinen Messpunkt');
});

test('Jede Aufbewahrungsdauer bekommt eine eigene Retention Policy', () => {
  assert.equal(retentionPolicyName(730), 'homeess_730d');
  assert.equal(retentionDuration(730), '730d');
  assert.equal(retentionPolicyName(0), 'homeess_forever');
  assert.equal(retentionDuration(0), 'INF');
});

// ── Client gegen einen echten HTTP-Server ────────────────────────────────────

function influxStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
      requests.push(entry);
      handler(entry, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

test('Der Client spricht ping, query und write der InfluxDB 1.x', async (t) => {
  const stub = await influxStub((request, response) => {
    if (request.url.startsWith('/ping')) {
      response.writeHead(204, { 'X-Influxdb-Version': '1.6.7' });
      response.end();
      return;
    }
    if (request.url.startsWith('/query')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ results: [{ series: [{ values: [['_internal'], ['homeess']] }] }] }));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  t.after(() => new Promise((resolve) => stub.server.close(resolve)));

  const client = new InfluxClient({ host: '127.0.0.1', port: stub.port, database: 'homeess', username: 'u', password: 'p' });
  assert.equal((await client.ping()).version, '1.6.7');
  assert.deepEqual(await client.listDatabases(), ['_internal', 'homeess']);
  assert.equal(await client.write(['a value=1 1000', 'b value=2 1000'], 'homeess_730d'), 2);

  const write = stub.requests.find((request) => request.url.startsWith('/write'));
  assert.match(write.url, /db=homeess/);
  assert.match(write.url, /rp=homeess_730d/);
  assert.match(write.url, /precision=ms/);
  assert.equal(write.body, 'a value=1 1000\nb value=2 1000');
  // Zugangsdaten gehen als Basic-Auth-Kopfzeile, nicht in der URL.
  assert.equal(write.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.doesNotMatch(write.url, /p=p|password/);
});

test('Der Client meldet Anmelde- und Datenbankfehler verständlich', async (t) => {
  const stub = await influxStub((request, response) => {
    if (request.url.startsWith('/ping')) {
      response.writeHead(204, { 'X-Influxdb-Version': '1.6.7' });
      response.end();
      return;
    }
    response.writeHead(request.url.startsWith('/write') ? 401 : 404);
    response.end('nope');
  });
  t.after(() => new Promise((resolve) => stub.server.close(resolve)));
  const client = new InfluxClient({ host: '127.0.0.1', port: stub.port, database: 'fehlt' });
  await assert.rejects(() => client.write(['a value=1 1000']), /Anmeldung/);
});

// ── Adapter im Betrieb ───────────────────────────────────────────────────────

function createHost(config, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-influx-'));
  const record = { catalogs: [], values: [], logs: [], subscriptions: new Map(), connected: [] };
  let sequence = 0;
  const host = {
    name: options.instanceName || 'historie',
    getConfig: () => config,
    getDataDirectory: async () => directory,
    setStates: (list) => record.catalogs.push(list),
    publishState: (address, value) => record.values.push({ address, value }),
    publishStates: (values) => values.forEach((entry) => record.values.push(entry)),
    setConnected: (connected, detail) => record.connected.push({ connected, detail }),
    setStorage() {},
    subscribeState(topic, listener) {
      const id = String(++sequence);
      record.subscriptions.set(id, { topic, listener });
      return () => record.subscriptions.delete(id);
    },
    listStateOptions: async () => options.stateOptions || [],
    t: (key, fallback) => fallback,
    log: (message) => record.logs.push(['log', message]),
    debug: (message) => record.logs.push(['debug', message]),
    warn: (message) => record.logs.push(['warn', message]),
    error: (message) => record.logs.push(['error', message]),
  };
  return { host, record, directory };
}

function deliver(record, topic, value) {
  for (const entry of record.subscriptions.values()) {
    if (entry.topic === topic) entry.listener(value, { receivedAt: Date.now() });
  }
}

test('Ausgewählte States werden abonniert und geschrieben', async (t) => {
  const written = [];
  const stub = await influxStub((request, response) => {
    if (request.url.startsWith('/ping')) {
      response.writeHead(204, { 'X-Influxdb-Version': '1.6.7' });
      response.end();
      return;
    }
    if (request.url.startsWith('/query')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ results: [{ series: [{ values: [['homeess']] }] }] }));
      return;
    }
    written.push(request);
    response.writeHead(204);
    response.end();
  });
  t.after(() => new Promise((resolve) => stub.server.close(resolve)));

  const config = { host: '127.0.0.1', port: stub.port, database: 'homeess', flushSeconds: 1 };
  const { host, record, directory } = createHost(config, {
    stateOptions: [
      { topic: 'hdp://wz/temperatur', options: { enabled: true, alias: 'wohnzimmer.temperatur', mode: 'change', debounceSeconds: 0, retentionDays: 730 } },
      { topic: 'hdp://wz/ignoriert', options: { enabled: false, alias: 'nein' } },
    ],
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  const internals = adapter._internals();

  assert.equal(internals.tracked().size, 1, 'nur aktivierte States werden verfolgt');
  assert.equal(record.subscriptions.size, 1);

  deliver(record, 'hdp://wz/temperatur', 21.5);
  assert.equal(internals.queue().length, 1);
  // Der Instanzname geht als Tag mit, damit mehrere Instanzen in derselben
  // Datenbank getrennte Serien schreiben.
  assert.match(internals.queue()[0].line, /^wohnzimmer\.temperatur,instance=historie value=21\.5 \d+$/);
  await internals.flush();
  assert.equal(written.length, 1);
  assert.equal(written[0].body, 'wohnzimmer.temperatur,instance=historie value=21.5 ' + written[0].body.split(' ').pop());
  assert.match(written[0].url, /rp=homeess_730d/);
});

test('Die Entprellzeit begrenzt die Schreibrate je State', async (t) => {
  const config = { host: '127.0.0.1', port: 1, database: 'homeess' };
  const { host, record, directory } = createHost(config, {
    stateOptions: [{ topic: 'demo://x/wert', options: { enabled: true, mode: 'change', debounceSeconds: 5, retentionDays: 30 } }],
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  const internals = adapter._internals();

  deliver(record, 'demo://x/wert', 1);
  deliver(record, 'demo://x/wert', 2);
  deliver(record, 'demo://x/wert', 3);
  // Nur der erste Wert geht sofort; die weiteren warten auf die Entprellzeit.
  assert.equal(internals.queue().length, 1);
  const entry = internals.tracked().get('demo://x/wert');
  assert.equal(entry.retention, 'homeess_30d');
  assert.equal(entry.lastValue, 3);
  assert.ok(entry.debounceTimer, 'ein Nachzügler ist eingeplant');
});

test('Ohne Verbindung bleiben Messpunkte begrenzt in der Warteschlange', async (t) => {
  const config = { host: '127.0.0.1', port: 1, database: 'homeess', queueLimit: 100 };
  const { host, record, directory } = createHost(config, {
    stateOptions: [{ topic: 'demo://x/wert', options: { enabled: true, mode: 'change', debounceSeconds: 0 } }],
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  const internals = adapter._internals();

  for (let i = 0; i < 150; i += 1) deliver(record, 'demo://x/wert', i);
  assert.equal(internals.queue().length, 100, 'die Warteschlange ist gedeckelt');
  assert.ok(internals.stats().dropped >= 50);
  assert.equal(record.connected[record.connected.length - 1].connected, false);
});

test('Geänderte State-Optionen werden ohne Neustart übernommen', async (t) => {
  const config = { host: '127.0.0.1', port: 1, database: 'homeess' };
  const options = [{ topic: 'demo://x/a', options: { enabled: true, alias: 'a', mode: 'change' } }];
  const { host, record, directory } = createHost(config, { stateOptions: options });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  const internals = adapter._internals();
  assert.equal(internals.tracked().size, 1);

  options.length = 0;
  options.push({ topic: 'demo://x/b', options: { enabled: true, alias: 'b', mode: 'change' } });
  await adapter.stateOptionsChanged();
  assert.deepEqual(Array.from(internals.tracked().keys()), ['demo://x/b']);
  assert.equal(record.subscriptions.size, 1, 'das alte Abo wurde abgemeldet');
});

// ── Ersteinrichtung ──────────────────────────────────────────────────────────

test('Die Ersteinrichtung wird nur ohne vorhandene Installation angeboten', async (t) => {
  const config = { host: '127.0.0.1', port: 1, database: 'homeess' };
  const { host, directory } = createHost(config);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  const internals = adapter._internals();

  const state = internals.setupState();
  assert.equal(state.local, true);
  assert.equal(state.connected, false);
  // Auf dem Testsystem ist keine InfluxDB installiert.
  assert.equal(state.installed, setup.localInstallationPresent());
  assert.equal(state.needed, !state.installed);
  assert.equal(state.privileged, setup.canInstallLocally());

  // Sobald eine Verbindung besteht, verschwindet das Angebot.
  internals.setConnected(true);
  assert.equal(internals.setupState().needed, false);
});

test('Ein entfernter Server bekommt keine lokale Ersteinrichtung', async (t) => {
  const config = { host: '192.168.178.40', port: 8086, database: 'homeess', timeoutMs: 300 };
  const { host, directory } = createHost(config);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  assert.equal(adapter._internals().setupState().needed, false);
});

test('Der genannte Befehl ruft das mitgelieferte Skript ohne Kennwort auf', () => {
  const command = setup.installCommand({ database: 'homeess', username: 'mess', password: 'geheim123', port: 8087, retentionDays: 365 });
  // Kein sudo: der Befehl wird in einer Root-Konsole eingegeben.
  assert.match(command, /^bash '.*\/adapter\/influxdb\/install-influxdb\.sh'/);
  assert.doesNotMatch(command, /sudo/);
  assert.match(command, /--database 'homeess'/);
  assert.match(command, /--user 'mess'/);
  assert.match(command, /--port '8087'/);
  assert.match(command, /--retention '365'/);
  // Das Kennwort darf weder in der Befehlszeile noch in der Prozessliste landen.
  assert.doesNotMatch(command, /geheim123/);
});

test('Das mitgelieferte Installationsskript ist vorhanden, ausführbar und gültige Shell', () => {
  const file = setup.scriptPath();
  assert.equal(path.basename(file), 'install-influxdb.sh');
  const stat = fs.statSync(file);
  assert.ok(stat.isFile());
  assert.ok(stat.mode & 0o111, 'das Skript ist ausführbar');
  const script = setup.readScript();
  assert.match(script, /apt-get install -y influxdb/);
  assert.match(script, /CREATE RETENTION POLICY/);
  assert.match(script, /auth-enabled/);
  // Das Kennwort kommt aus der Umgebung oder wird verdeckt abgefragt.
  assert.match(script, /INFLUX_SETUP_PASSWORD/);
  assert.match(script, /read -r -s -p/);
  const check = spawnSync('/bin/bash', ['-n', file]);
  assert.equal(check.status, 0, `bash -n meldet: ${check.stderr}`);
});

test('Ohne Rootrechte lehnt die Einrichtung ab, statt etwas anzufassen', async () => {
  const privileged = typeof process.getuid === 'function' && process.getuid() === 0;
  if (privileged) return; // Auf einem Root-Testlauf ist der Fall nicht prüfbar.
  assert.equal(setup.canInstallLocally(), false);
  await assert.rejects(() => setup.runLocalInstall({ database: 'homeess', username: 'homeess', password: 'geheim123' }),
    /fehlen die Rechte/);
});

test('Unzulässige Zugangsdaten werden vor jeder Ausführung abgewiesen', () => {
  assert.throws(() => setup.validate({ database: 'homeess', username: 'homeess', password: 'kurz' }), /acht Zeichen/);
  assert.throws(() => setup.validate({ database: 'home ess', username: 'homeess', password: 'geheim123' }), /Datenbankname/);
  assert.throws(() => setup.validate({ database: 'homeess', username: 'homeess', password: "mit'quote" }), /unzulässige Zeichen/);
  assert.deepEqual(setup.validate({ database: 'homeess', username: 'homeess', password: 'geheim123', port: 8086 }), {
    database: 'homeess', username: 'homeess', password: 'geheim123', port: 8086, retentionDays: 730,
  });
});

test('Ohne Rootrechte zeigt die Verwaltung die Anleitung statt einer Schaltfläche', async (t) => {
  // Im Normalbetrieb läuft homeESS unprivilegiert; der Testlauf hier kann root
  // sein und auf dem Build-Rechner kann InfluxDB bereits installiert sein.
  // Beide Hosteigenschaften werden isoliert, damit wirklich der beabsichtigte
  // Zustand „unprivilegiert und noch nicht installiert“ geprüft wird.
  const realGetuid = process.getuid;
  const realLocalInstallationPresent = setup.localInstallationPresent;
  process.getuid = () => 1000;
  setup.localInstallationPresent = () => false;
  t.after(() => {
    process.getuid = realGetuid;
    setup.localInstallationPresent = realLocalInstallationPresent;
  });

  const config = { host: '127.0.0.1', port: 1, database: 'homeess', username: 'homeess', password: 'geheim123', timeoutMs: 200 };
  const { host, directory } = createHost(config);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());

  assert.equal(adapter._internals().setupState().privileged, false);
  const response = await adapter.handleManagementRequest({
    method: 'GET', path: '/', basePath: '/adapter/instance/1/manage',
    access: { canRead: true, canWrite: true, isAdmin: true },
  });
  const body = response.view.body;
  assert.match(body, /Zur Installation von InfluxDB bitte folgendes in der Root-Konsole eingeben/);
  assert.match(body, /bash &#39;.*install-influxdb\.sh&#39;/);
  assert.doesNotMatch(body, /sudo/, 'in einer Root-Konsole braucht es kein sudo');
  assert.doesNotMatch(body, /id="influxSetupStart"/, 'ohne Rechte gibt es keine Schaltfläche');
  // Das Kennwort darf nirgends in der Seite auftauchen.
  assert.doesNotMatch(body, /geheim123/);

  // Auch der Endpunkt lehnt ab und nennt den Befehl.
  const denied = await adapter.handleManagementRequest({
    method: 'POST', path: '/setup/start', access: { canRead: true, canWrite: true, isAdmin: true },
  });
  assert.equal(denied.status, 409);
  assert.match(denied.json.error, /ohne erweiterte Rechte/);
  assert.match(denied.json.command, /install-influxdb\.sh/);
});

test('Zwei Instanzen in derselben Datenbank bleiben durch das Instanz-Tag getrennt', async (t) => {
  const config = { host: '127.0.0.1', port: 1, database: 'homeess', timeoutMs: 200 };
  const options = [{ topic: 'hdp://wz/temp', options: { enabled: true, alias: 'wz.temp', mode: 'change', debounceSeconds: 0 } }];
  const started = [];
  for (const name of ['erste', 'zweite']) {
    const { host, record, directory } = createHost(config, { stateOptions: options, instanceName: name });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const adapter = createInfluxAdapter(host);
    await adapter.start(config);
    t.after(async () => adapter.stop());
    deliver(record, 'hdp://wz/temp', 21.5);
    started.push(adapter._internals().queue()[0].line);
  }
  // Gleicher Alias, gleiche Datenbank – unterschiedliche Serien.
  assert.match(started[0], /^wz\.temp,instance=erste /);
  assert.match(started[1], /^wz\.temp,instance=zweite /);
  assert.notEqual(started[0].split(' ')[0], started[1].split(' ')[0]);
});

test('Das Instanz-Tag lässt sich abschalten', async (t) => {
  const config = { host: '127.0.0.1', port: 1, database: 'homeess', instanceTag: false, timeoutMs: 200 };
  const { host, record, directory } = createHost(config, {
    stateOptions: [{ topic: 'hdp://wz/temp', options: { enabled: true, alias: 'wz.temp', mode: 'change', debounceSeconds: 0 } }],
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createInfluxAdapter(host);
  await adapter.start(config);
  t.after(async () => adapter.stop());
  deliver(record, 'hdp://wz/temp', 21.5);
  assert.match(adapter._internals().queue()[0].line, /^wz\.temp value=21\.5 /);
});
