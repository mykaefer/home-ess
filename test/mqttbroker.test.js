'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mqtt = require('mqtt');

const createBrokerAdapter = require('../adapter/mqttbroker');
const { topicMatches, isValidTopicFilter, isValidTopicName, ipAllowed } = require('../adapter/mqttbroker/broker');
const { decodePayload, encodeValue } = require('../adapter/mqttbroker/payload');
const { DeviceStates } = require('../adapter/mqttbroker/device-states');
const { SystemTree } = require('../adapter/mqttbroker/system-tree');
const { buildTopicTree, buildStateTree } = require('../adapter/mqttbroker/topic-tree');

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function createHost(config = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-mqttbroker-'));
  const record = {
    directory,
    catalogs: [],
    values: [],
    writes: [],
    logs: [],
    subscriptions: new Map(),
    listStatesCalls: 0,
  };
  let sequence = 0;
  const host = {
    name: options.instanceName || 'broker',
    getConfig: () => config,
    getDataDirectory: async () => directory,
    setStates(list) {
      record.catalogs.push(list);
    },
    publishState(address, value) {
      record.values.push({ address, value });
    },
    publishStates(values) {
      for (const entry of values) record.values.push(entry);
    },
    setConnected() {},
    setStorage() {},
    subscribeState(topic, listener) {
      const id = String(++sequence);
      record.subscriptions.set(id, { topic, listener });
      return () => record.subscriptions.delete(id);
    },
    writeState(topic, value) {
      record.writes.push({ topic, value });
      return Promise.resolve(true);
    },
    async listStates() {
      record.listStatesCalls += 1;
      return options.states || [];
    },
    t: (key, fallback) => fallback,
    log: (message) => record.logs.push(['log', message]),
    debug: (message) => record.logs.push(['debug', message]),
    warn: (message) => record.logs.push(['warn', message]),
    error: (message) => record.logs.push(['error', message]),
  };
  if (options.withoutListStates) delete host.listStates;
  return { host, record };
}

// Wert an einen abonnierten homeESS-State melden (simuliert den Bus).
function deliver(record, topic, value) {
  for (const entry of record.subscriptions.values()) {
    if (entry.topic === topic) entry.listener(value, { receivedAt: Date.now() });
  }
}

function connectClient(port, options = {}) {
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
    reconnectPeriod: 0,
    connectTimeout: 4000,
    ...options,
  });
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('error', reject);
    client.once('close', () => reject(new Error('Verbindung geschlossen')));
  });
}

function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = check();
      } catch (err) {
        reject(err);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Zeitüberschreitung beim Warten auf die erwartete Änderung.'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function startAdapter(settings = {}, hostOptions = {}) {
  const config = { port: 0, idleMinutes: 60, ...settings };
  const { host, record } = createHost(config, hostOptions);
  const adapter = createBrokerAdapter(host);
  await adapter.start(config);
  const internals = adapter._internals();
  const port = internals.broker().port;
  assert.ok(port > 0, 'Broker muss lauschen');
  return { adapter, host, record, internals, port, config };
}

function lastCatalog(record) {
  return record.catalogs[record.catalogs.length - 1] || [];
}

// ── Reine Funktionen ──────────────────────────────────────────────────────────

test('Topic-Abgleich folgt den MQTT-Wildcardregeln', () => {
  assert.equal(topicMatches('haus/+/temp', 'haus/kueche/temp'), true);
  assert.equal(topicMatches('haus/+/temp', 'haus/kueche/oben/temp'), false);
  assert.equal(topicMatches('haus/#', 'haus/kueche/temp'), true);
  assert.equal(topicMatches('haus/#', 'haus'), true);
  assert.equal(topicMatches('#', 'states/hdp/wz/temp'), true);
  assert.equal(topicMatches('#', '$SYS/clients'), false, '$-Topics bleiben von Wildcards ausgenommen');
  assert.equal(topicMatches('states/+/+/soc', 'states/hdp/wz/soc'), true);
});

test('Topic-Namen und -Filter werden validiert', () => {
  assert.equal(isValidTopicName('haus/kueche/temp'), true);
  assert.equal(isValidTopicName('haus/+/temp'), false);
  assert.equal(isValidTopicName(''), false);
  assert.equal(isValidTopicFilter('haus/#'), true);
  assert.equal(isValidTopicFilter('haus/#/temp'), false);
  assert.equal(isValidTopicFilter('haus/te+mp'), false);
});

test('IP-Bereiche akzeptieren Einzeladresse, Bereich und CIDR', () => {
  assert.equal(ipAllowed('192.168.178.5', ''), true);
  assert.equal(ipAllowed('192.168.178.5', '192.168.178.0/24'), true);
  assert.equal(ipAllowed('192.168.179.5', '192.168.178.0/24'), false);
  assert.equal(ipAllowed('192.168.178.20', '192.168.178.10-192.168.178.50'), true);
  assert.equal(ipAllowed('10.0.0.1', '10.0.0.1'), true);
});

test('Nutzlasten werden zu Zahlen, Booleans und Texten', () => {
  assert.equal(decodePayload(Buffer.from('21.5')), 21.5);
  assert.equal(decodePayload(Buffer.from('ON')), true);
  assert.equal(decodePayload(Buffer.from('aus')), false);
  assert.equal(decodePayload(Buffer.from('{"val":42,"ack":true}')), 42);
  assert.equal(decodePayload(Buffer.from('{"val":"an"}')), true);
  assert.equal(decodePayload(Buffer.from('Wohnzimmer')), 'Wohnzimmer');
  assert.equal(decodePayload(Buffer.from('{"val":7}'), { json: false }), '{"val":7}');
  assert.equal(encodeValue(true).toString(), 'true');
  assert.equal(encodeValue(null).length, 0);
});

test('Der Systembaum lässt nur die eigene Instanz aus', () => {
  const catalog = [
    { topic: 'hdp://wohnzimmer/messwerte/temperatur', name: 'Temperatur', writable: false },
    { topic: 'system://homeess/pv.current', name: 'PV', writable: false },
    { topic: 'mqttbroker://broker/haus/temp', name: 'Eigen', writable: true },
    { topic: 'mqttbroker://Broker EG/haus/temp', name: 'Nachbar', writable: true },
  ];

  const tree = new SystemTree({ ownPrefix: 'mqttbroker', ownInstance: 'broker' });
  const diff = tree.refresh(catalog);
  assert.equal(diff.total, 3);
  assert.ok(tree.entryByMqttTopic('states/hdp/wohnzimmer/messwerte/temperatur'));
  assert.ok(tree.entryByMqttTopic('states/system/homeess/pv/current'));
  assert.equal(tree.entryByMqttTopic('states/mqttbroker/broker/haus/temp'), null);
  assert.equal(tree.mqttTopicFor('mqttbroker://broker/haus/temp'), '');
  // Andere Broker-Instanzen sind gewöhnliche Fremd-States.
  assert.ok(tree.entryByMqttTopic('states/mqttbroker/Broker_EG/haus/temp'));

  // Ohne bekannten Instanznamen bleibt der gesamte eigene Prefix ausgespart.
  const ohneInstanz = new SystemTree({ ownPrefix: 'mqttbroker' });
  assert.equal(ohneInstanz.refresh(catalog).total, 2);
});

test('Die Idle-Haltezeit entfernt nur veraltete States', () => {
  const states = new DeviceStates({ maxStates: 10 });
  const now = Date.now();
  states.update('haus/alt', 1, { now: now - 7200000 });
  states.update('haus/neu', 2, { now });
  const removed = states.sweep(3600000, now);
  assert.deepEqual(removed, ['haus/alt']);
  assert.equal(states.size, 1);
  assert.equal(states.sweep(0, now).length, 0, '0 Minuten schaltet die Bereinigung ab');
});

test('Das Mengenlimit verhindert weitere States', () => {
  const states = new DeviceStates({ maxStates: 2 });
  assert.equal(states.update('a', 1).created, true);
  assert.equal(states.update('b', 2).created, true);
  assert.equal(states.update('c', 3).rejected, true);
  assert.equal(states.update('a', 9).rejected, false, 'bestehende States bleiben aktualisierbar');
  assert.equal(states.size, 2);
});

// ── Broker im Betrieb ─────────────────────────────────────────────────────────

test('Ein Client legt mit seinem Topic einen State an und erhält ihn zurück', async (t) => {
  const { adapter, record, internals, port } = await startAdapter();
  t.after(async () => adapter.stop());

  const publisher = await connectClient(port, { clientId: 'sensor-1' });
  const subscriber = await connectClient(port, { clientId: 'anzeige-1' });
  t.after(() => {
    publisher.end(true);
    subscriber.end(true);
  });

  const received = [];
  subscriber.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }));
  await new Promise((resolve, reject) => subscriber.subscribe('haus/#', (err) => (err ? reject(err) : resolve())));

  publisher.publish('haus/wohnzimmer/temperatur', '21.5', { retain: true });

  await waitFor(() => record.values.some((entry) => entry.address === 'haus/wohnzimmer/temperatur' && entry.value === 21.5));
  await waitFor(() => received.length > 0);
  assert.equal(received[0].topic, 'haus/wohnzimmer/temperatur');

  await waitFor(() => lastCatalog(record).some((state) => state.address === 'haus/wohnzimmer/temperatur'));
  const state = lastCatalog(record).find((entry) => entry.address === 'haus/wohnzimmer/temperatur');
  assert.equal(state.name, 'temperatur');
  assert.equal(state.category, 'MQTT-Geräte / haus / wohnzimmer');
  assert.equal(state.writable, true);
  assert.equal(internals.deviceStates().size, 1);

  // Retained Message: ein später verbundener Client bekommt den letzten Wert.
  const late = await connectClient(port, { clientId: 'anzeige-2' });
  t.after(() => late.end(true));
  const retained = await new Promise((resolve, reject) => {
    late.on('message', (topic, payload) => resolve({ topic, payload: payload.toString() }));
    late.subscribe('haus/wohnzimmer/temperatur', (err) => { if (err) reject(err); });
  });
  assert.deepEqual(retained, { topic: 'haus/wohnzimmer/temperatur', payload: '21.5' });
});

test('homeESS schreibt über den Broker an das Gerät', async (t) => {
  const { adapter, record, port } = await startAdapter();
  t.after(async () => adapter.stop());

  const device = await connectClient(port, { clientId: 'lampe' });
  t.after(() => device.end(true));
  const received = [];
  device.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }));
  await new Promise((resolve, reject) => device.subscribe('lampe/schalter', (err) => (err ? reject(err) : resolve())));

  device.publish('lampe/schalter', 'off');
  await waitFor(() => record.values.some((entry) => entry.address === 'lampe/schalter' && entry.value === false));

  adapter.write('lampe/schalter', true);
  await waitFor(() => received.some((entry) => entry.topic === 'lampe/schalter' && entry.payload === 'true'));

  adapter.write('unbekannt/topic', true);
  assert.equal(received.some((entry) => entry.topic === 'unbekannt/topic'), false,
    'für unbekannte Topics entsteht kein State und keine Nachricht');
});

test('Abgelaufene States verschwinden aus Katalog und Retained-Speicher', async (t) => {
  const { adapter, record, internals, port } = await startAdapter({ idleMinutes: 1 });
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'kurzlebig' });
  t.after(() => client.end(true));
  client.publish('flur/bewegung', '1', { retain: true });
  await waitFor(() => internals.deviceStates().has('flur/bewegung'));

  // Frische künstlich zurückdatieren und die Bereinigung anstoßen.
  internals.deviceStates().get('flur/bewegung').updatedAt = Date.now() - 120000;
  const removed = internals.sweepIdleStates();
  assert.deepEqual(removed, ['flur/bewegung']);
  assert.equal(internals.deviceStates().size, 0);
  assert.equal(lastCatalog(record).some((state) => state.address === 'flur/bewegung'), false);
  assert.equal(internals.broker().retained.has('flur/bewegung'), false);
});

test('Eine leere Retained Message räumt den State ab', async (t) => {
  const { adapter, internals, port } = await startAdapter();
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'aufraeumer' });
  t.after(() => client.end(true));
  client.publish('garage/tor', 'offen', { retain: true });
  await waitFor(() => internals.deviceStates().has('garage/tor'));

  client.publish('garage/tor', '', { retain: true });
  await waitFor(() => !internals.deviceStates().has('garage/tor'));
  assert.equal(internals.broker().retained.has('garage/tor'), false);
});

test('Ohne systemweiten Zugriff bleibt der states/-Baum unsichtbar', async (t) => {
  const { adapter, record, internals, port } = await startAdapter({ systemAccess: false }, {
    states: [{ topic: 'hdp://wz/temp', name: 'Temperatur', writable: true }],
  });
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'neugierig' });
  t.after(() => client.end(true));
  client.publish('states/hdp/wz/temp', '5');
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(internals.deviceStates().size, 0, 'states/ legt niemals Geräte-States an');
  assert.equal(record.writes.length, 0);
  assert.equal(record.listStatesCalls, 0);
});

test('Der Systembaum spiegelt States und achtet auf die Schreibrechte', async (t) => {
  const states = [
    { topic: 'hdp://wohnzimmer/messwerte/temperatur', name: 'Temperatur', writable: false, category: 'Adapter: wohnzimmer' },
    { topic: 'hdp://wohnzimmer/steuerung/schalter', name: 'Schalter', writable: true, category: 'Adapter: wohnzimmer' },
    { topic: 'system://homeess/pv.current', name: 'PV-Leistung', writable: false, category: 'System' },
    { topic: 'mqttbroker://broker/haus/temp', name: 'Eigener State', writable: true, category: 'MQTT-Geräte' },
  ];
  const { adapter, record, internals, port } = await startAdapter({ systemAccess: true }, { states });
  t.after(async () => adapter.stop());

  assert.equal(internals.systemTree().size, 3, 'der eigene Prefix bleibt ausgespart');

  const client = await connectClient(port, { clientId: 'bruecke' });
  t.after(() => client.end(true));
  const received = [];
  client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }));
  await new Promise((resolve, reject) => client.subscribe('states/#', (err) => (err ? reject(err) : resolve())));

  // Erst durch das Abo entstehen Spiegel-Abos im Host.
  await waitFor(() => internals.mirrors().size === 3);
  assert.equal(record.subscriptions.size, 3);

  deliver(record, 'hdp://wohnzimmer/messwerte/temperatur', 21.5);
  await waitFor(() => received.some((entry) => entry.topic === 'states/hdp/wohnzimmer/messwerte/temperatur' && entry.payload === '21.5'));

  // Schreiben auf einen schreibbaren State geht an homeESS …
  client.publish('states/hdp/wohnzimmer/steuerung/schalter', 'true');
  await waitFor(() => record.writes.length === 1);
  assert.deepEqual(record.writes[0], { topic: 'hdp://wohnzimmer/steuerung/schalter', value: true });

  // … schreibgeschützte States und unbekannte Topics werden verworfen.
  client.publish('states/hdp/wohnzimmer/messwerte/temperatur', '99');
  client.publish('states/hdp/wohnzimmer/gibtesnicht', '1');
  client.publish('states/mqttbroker/broker/haus/temp', '1');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(record.writes.length, 1, 'kein Schreibvorgang auf geschützte oder unbekannte States');
  assert.equal(internals.deviceStates().size, 0, 'im states/-Baum entstehen keine neuen States');
  assert.ok(record.logs.some(([level, message]) => level === 'warn' && message.includes('schreibgeschützt')));
  assert.ok(record.logs.some(([level, message]) => level === 'warn' && message.includes('keine neuen States')));

  // Nach dem Abmelden werden die Spiegel-Abos wieder abgebaut.
  await new Promise((resolve, reject) => client.unsubscribe('states/#', (err) => (err ? reject(err) : resolve())));
  await waitFor(() => internals.mirrors().size === 0);
  assert.equal(record.subscriptions.size, 0);
});

test('Entfernte System-States verlieren ihre Spiegelung', async (t) => {
  const states = [{ topic: 'hdp://wz/temp', name: 'Temperatur', writable: false }];
  const { adapter, internals, port } = await startAdapter({ systemAccess: true }, { states });
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'beobachter' });
  t.after(() => client.end(true));
  await new Promise((resolve, reject) => client.subscribe('states/#', (err) => (err ? reject(err) : resolve())));
  await waitFor(() => internals.mirrors().size === 1);

  states.length = 0;
  await internals.refreshSystemCatalog();
  assert.equal(internals.mirrors().size, 0);
  assert.equal(internals.systemTree().size, 0);
});

test('Das Mengenlimit begrenzt die gespiegelten System-States', async (t) => {
  const states = Array.from({ length: 5 }, (_, index) => ({
    topic: `hdp://wz/wert${index}`, name: `Wert ${index}`, writable: false,
  }));
  const { adapter, record, internals, port } = await startAdapter(
    { systemAccess: true, maxSystemStates: 2 }, { states }
  );
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'viel' });
  t.after(() => client.end(true));
  await new Promise((resolve, reject) => client.subscribe('states/#', (err) => (err ? reject(err) : resolve())));
  await waitFor(() => internals.mirrors().size === 2);
  await waitFor(() => record.logs.some(([level, message]) => level === 'warn' && message.includes('gespiegelt')));
});

test('Zugangsdaten werden geprüft', async (t) => {
  const { adapter, port } = await startAdapter({
    username: 'homeess', password: 'geheim', allowAnonymous: false,
  });
  t.after(async () => adapter.stop());

  await assert.rejects(() => connectClient(port, { clientId: 'falsch', username: 'homeess', password: 'daneben' }));
  const client = await connectClient(port, { clientId: 'richtig', username: 'homeess', password: 'geheim' });
  t.after(() => client.end(true));
  assert.ok(client.connected);
});

test('Geräte-States überleben einen Neustart des Adapters', async (t) => {
  const { adapter, host, record, port } = await startAdapter({ idleMinutes: 60 });
  const client = await connectClient(port, { clientId: 'dauerhaft' });
  client.publish('keller/feuchte', '55', { retain: true });
  await waitFor(() => record.values.some((entry) => entry.address === 'keller/feuchte'));
  client.end(true);
  await adapter.stop();

  const stored = JSON.parse(fs.readFileSync(path.join(record.directory, 'device-states.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].address, 'keller/feuchte');

  // Zweiter Start mit demselben Datenverzeichnis: der State ist sofort wieder da.
  const config = { port: 0, idleMinutes: 60 };
  const restarted = createBrokerAdapter({ ...host, getDataDirectory: async () => record.directory });
  await restarted.start(config);
  t.after(async () => restarted.stop());
  assert.equal(restarted._internals().deviceStates().has('keller/feuchte'), true);
  assert.ok(lastCatalog(record).some((state) => state.address === 'keller/feuchte'));

  fs.rmSync(record.directory, { recursive: true, force: true });
});

// ── Topic-Browser ─────────────────────────────────────────────────────────────

test('Der Topic-Baum bildet Verzeichnisebenen und Blätter ab', () => {
  const root = buildTopicTree([
    { topic: 'haus/wohnzimmer/temperatur', source: 'device' },
    { topic: 'haus/wohnzimmer', source: 'device' },
    { topic: 'haus/kueche/temperatur', source: 'device' },
    { topic: 'keller', source: 'device' },
    { topic: 'haus/wohnzimmer/temperatur', source: 'device' },
    { topic: '', source: 'device' },
  ]);

  assert.equal(root.count, 4, 'doppelte und leere Topics zählen nur einmal');
  // Verzeichnisse zuerst, danach die Blätter der gleichen Ebene.
  assert.deepEqual(root.children.map((node) => node.name), ['haus', 'keller']);

  const haus = root.children[0];
  assert.equal(haus.entry, null, 'reine Zwischenebenen tragen keinen State');
  assert.equal(haus.count, 3);
  assert.deepEqual(haus.children.map((node) => node.path), ['haus/kueche', 'haus/wohnzimmer']);

  // Ein Knoten darf gleichzeitig Blatt und Verzeichnis sein.
  const wohnzimmer = haus.children[1];
  assert.equal(wohnzimmer.entry.topic, 'haus/wohnzimmer');
  assert.equal(wohnzimmer.children[0].path, 'haus/wohnzimmer/temperatur');
  assert.equal(root.children[1].entry.topic, 'keller');
});

test('Der States-Baum gliedert nach Kategorie und Klarname', () => {
  const root = buildStateTree([
    { topic: 'states/system/homeess/geraet/3/leistung', name: 'Poolpumpe – Leistung', category: 'System / Geräte' },
    { topic: 'states/system/homeess/batterie/charge', name: 'Ladung', category: 'System / Batterie' },
    { topic: 'states/schaltgruppe/gruppen/1', name: 'Wohnzimmer', category: 'System / Schaltgruppen' },
    { topic: 'haus/temp', name: 'Temperatur', category: 'MQTT-Geräte / haus' },
    { topic: 'ohne/kategorie', name: 'Namenlos', category: '' },
  ]);

  assert.equal(root.count, 5);
  assert.deepEqual(root.children.map((node) => node.name), ['Allgemein', 'MQTT-Geräte', 'System']);

  const system = root.children[2];
  assert.deepEqual(system.children.map((node) => node.name), ['Batterie', 'Geräte', 'Schaltgruppen']);
  assert.equal(system.count, 3);

  // Blätter tragen den Klarnamen und trotzdem den vollständigen MQTT-Pfad.
  const gruppe = system.children[2].children[0];
  assert.equal(gruppe.name, 'Wohnzimmer');
  assert.equal(gruppe.path, 'states/schaltgruppe/gruppen/1');
  assert.equal(gruppe.entry.topic, 'states/schaltgruppe/gruppen/1');
  assert.equal(root.children[0].children[0].name, 'Namenlos', 'ohne Kategorie landet alles unter Allgemein');
});

test('Punkte in der State-Adresse öffnen eine eigene Topic-Ebene', () => {
  const tree = new SystemTree({ ownPrefix: 'mqttbroker' });
  tree.refresh([
    { topic: 'system://homeess/geraet.3.leistung', name: 'Poolpumpe – Leistung', category: 'System / Geräte', writable: false },
    { topic: 'system://homeess/pv.current', name: 'PV', category: 'System / Photovoltaik', writable: false },
    { topic: 'hdp://wz/messwerte/temperatur', name: 'Temperatur', writable: false },
  ]);

  assert.ok(tree.entryByMqttTopic('states/system/homeess/geraet/3/leistung'));
  assert.ok(tree.entryByMqttTopic('states/system/homeess/pv/current'));
  // Die Rückabbildung auf die homeESS-Adresse bleibt exakt erhalten.
  assert.equal(
    tree.entryByMqttTopic('states/system/homeess/geraet/3/leistung').homeTopic,
    'system://homeess/geraet.3.leistung'
  );
  assert.equal(tree.mqttTopicFor('hdp://wz/messwerte/temperatur'), 'states/hdp/wz/messwerte/temperatur');
});

test('Der Topic-Browser liefert Geräte-Topics und den Systembaum', async (t) => {
  const states = [
    { topic: 'hdp://wz/messwerte/temperatur', name: 'Temperatur', writable: false, category: 'hDP wz / Messwerte' },
    { topic: 'hdp://wz/steuerung/schalter', name: 'Schalter', writable: true, category: 'hDP wz / Steuerung' },
  ];
  const { adapter, record, internals, port } = await startAdapter({ systemAccess: true }, { states });
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'browser' });
  t.after(() => client.end(true));
  client.publish('haus/wohnzimmer/temperatur', '21.5', { retain: true });
  await waitFor(() => record.values.some((entry) => entry.address === 'haus/wohnzimmer/temperatur'));
  await new Promise((resolve, reject) => client.subscribe('states/#', (err) => (err ? reject(err) : resolve())));
  await waitFor(() => internals.mirrors().size === 2);
  deliver(record, 'hdp://wz/messwerte/temperatur', 19.5);

  const response = await adapter.handleManagementRequest({
    method: 'GET', path: '/topics', query: { group: 'path' }, access: { canRead: true },
  });
  assert.equal(response.status, 200);
  const data = response.json;
  assert.equal(data.group, 'path');
  assert.equal(data.systemAccess, true);
  assert.equal(data.device, 1);
  assert.equal(data.system, 2);
  assert.equal(data.total, 3);

  const flat = new Map();
  (function walk(nodes) {
    for (const node of nodes) {
      if (node.entry) flat.set(node.path, node.entry);
      walk(node.children);
    }
  }(data.nodes));
  assert.deepEqual(Array.from(flat.keys()).sort(), [
    'haus/wohnzimmer/temperatur',
    'states/hdp/wz/messwerte/temperatur',
    'states/hdp/wz/steuerung/schalter',
  ]);

  const device = flat.get('haus/wohnzimmer/temperatur');
  assert.equal(device.value, 21.5);
  assert.equal(device.writable, true);
  assert.equal(device.name, 'temperatur');
  assert.equal(device.category, 'MQTT-Geräte / broker / haus / wohnzimmer');
  assert.equal(device.homeTopic, 'mqttbroker://broker/haus/wohnzimmer/temperatur');

  // Der Systembaum übernimmt Name, Kategorie und Schreibrechte des States.
  const readOnly = flat.get('states/hdp/wz/messwerte/temperatur');
  assert.equal(readOnly.writable, false);
  assert.equal(readOnly.name, 'Temperatur');
  assert.equal(readOnly.category, 'hDP wz / Messwerte');
  assert.equal(readOnly.homeTopic, 'hdp://wz/messwerte/temperatur');
  assert.equal(readOnly.value, 19.5);
  assert.equal(readOnly.mirrored, true);
  assert.equal(flat.get('states/hdp/wz/steuerung/schalter').writable, true);

  // Diagnose-States werden nicht über MQTT verteilt und gehören nicht in den Baum.
  assert.equal(Array.from(flat.keys()).some((topic) => topic.startsWith('$SYS/')), false);

  // Dieselben Topics, gegliedert wie der States-Baum von homeESS.
  const byState = await adapter.handleManagementRequest({
    method: 'GET', path: '/topics', query: { group: 'category' }, access: { canRead: true },
  });
  assert.equal(byState.json.group, 'category');
  assert.equal(byState.json.total, 3);
  assert.deepEqual(byState.json.nodes.map((node) => node.name), ['hDP wz', 'MQTT-Geräte']);
  const messwerte = byState.json.nodes[0].children[0];
  assert.equal(messwerte.name, 'Messwerte');
  assert.equal(messwerte.children[0].name, 'Temperatur');
  assert.equal(messwerte.children[0].path, 'states/hdp/wz/messwerte/temperatur');

  // Die eigenen Geräte-Topics stehen unter „MQTT-Geräte / <Instanz>".
  const eigene = byState.json.nodes[1].children[0];
  assert.equal(eigene.name, 'broker');
  assert.equal(eigene.children[0].children[0].children[0].path, 'haus/wohnzimmer/temperatur');
});

test('Andere Broker-Instanzen erscheinen unter MQTT-Geräte, die eigene nicht', async (t) => {
  const states = [
    { topic: 'mqttbroker://Broker EG/haus/kueche/temp', name: 'Broker EG – temp', writable: true, category: 'Adapter: Broker EG / MQTT-Geräte / haus / kueche' },
    { topic: 'mqttbroker://broker/haus/eigen', name: 'broker – eigen', writable: true, category: 'Adapter: broker / MQTT-Geräte / haus' },
    { topic: 'hdp://wz/temp', name: 'Temperatur', writable: false, category: 'Adapter: wz / Messwerte' },
  ];
  const { adapter, internals, port } = await startAdapter({ systemAccess: true }, { states });
  t.after(async () => adapter.stop());

  // Nur die eigene Instanz bleibt ausgespart — sonst spiegelte sie sich selbst.
  assert.equal(internals.systemTree().size, 2);
  assert.ok(internals.systemTree().entryByMqttTopic('states/mqttbroker/Broker_EG/haus/kueche/temp'));
  assert.equal(internals.systemTree().entryByMqttTopic('states/mqttbroker/broker/haus/eigen'), null);

  // Ein Client kann den fremden Broker mitlesen wie jeden anderen State.
  const client = await connectClient(port, { clientId: 'nachbar' });
  t.after(() => client.end(true));
  await new Promise((resolve, reject) => client.subscribe('states/mqttbroker/#', (err) => (err ? reject(err) : resolve())));
  await waitFor(() => internals.mirrors().has('states/mqttbroker/Broker_EG/haus/kueche/temp'));

  const data = (await adapter.handleManagementRequest({
    method: 'GET', path: '/topics', access: { canRead: true },
  })).json;
  assert.equal(data.broker, 1);

  const geraete = data.nodes.find((node) => node.name === 'MQTT-Geräte');
  assert.deepEqual(geraete.children.map((node) => node.name), ['broker', 'Broker EG']);

  // Das eigene Verzeichnis steht auch ohne einen einzigen Geräte-State im Baum.
  const eigene = geraete.children[0];
  assert.equal(eigene.folder, true);
  assert.equal(eigene.count, 0);

  // Der fremde Broker behält seine Topic-Gliederung unterhalb der Instanz.
  const fremd = geraete.children[1];
  assert.deepEqual(fremd.children.map((node) => node.name), ['haus']);
  const leaf = fremd.children[0].children[0].children[0];
  assert.equal(leaf.name, 'temp', 'der doppelte Instanzname fällt weg');
  assert.equal(leaf.path, 'states/mqttbroker/Broker_EG/haus/kueche/temp');
  assert.equal(leaf.entry.writable, true);
});

test('Der Topic-Browser bleibt ohne Leserecht verschlossen', async (t) => {
  const { adapter } = await startAdapter();
  t.after(async () => adapter.stop());

  const denied = await adapter.handleManagementRequest({
    method: 'GET', path: '/topics', access: {},
  });
  assert.equal(denied.status, 403);

  const view = await adapter.handleManagementRequest({
    method: 'GET', path: '/', basePath: '/adapter/instance/1/manage', access: { canRead: true },
  });
  assert.equal(view.status, 200);
  assert.ok(view.view.body.includes('Topic-Browser'));
  assert.ok(view.view.body.includes('mqttbroker-group'));
  assert.ok(view.view.script.includes("'/topics?group='"));
});

test('Ohne systemweiten Zugriff zeigt der Topic-Browser nur Geräte-Topics', async (t) => {
  const states = [{ topic: 'hdp://wz/temp', name: 'Temperatur', writable: false }];
  const { adapter, record, port } = await startAdapter({ systemAccess: false }, { states });
  t.after(async () => adapter.stop());

  const client = await connectClient(port, { clientId: 'ohne-system' });
  t.after(() => client.end(true));
  client.publish('keller/feuchte', '55');
  await waitFor(() => record.values.some((entry) => entry.address === 'keller/feuchte'));

  const response = await adapter.handleManagementRequest({
    method: 'GET', path: '/topics', query: { group: 'path' }, access: { canRead: true },
  });
  assert.equal(response.json.systemAccess, false);
  assert.equal(response.json.system, 0);
  assert.deepEqual(response.json.nodes.map((node) => node.name), ['keller']);

  // Ohne ausdrückliche Angabe gilt die homeESS-Gliederung.
  const fallback = await adapter.handleManagementRequest({
    method: 'GET', path: '/topics', access: { canRead: true },
  });
  assert.equal(fallback.json.group, 'category');
  assert.deepEqual(fallback.json.nodes.map((node) => node.name), ['MQTT-Geräte']);
});
