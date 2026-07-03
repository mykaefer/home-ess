'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

// Temp-Adapterverzeichnis und Temp-DB VOR dem Laden von config/db setzen.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapters-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(ADAPTER_DIR, { recursive: true });
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const registry = require('../src/adapters/registry');
const instancesRepo = require('../src/adapters/instances');
const router = require('../src/adapters/router');
const host = require('../src/adapters/host');
const bus = require('../src/state-bus');
const stateEditor = require('../src/adapters/state-editor');
const presetsRepo = require('../src/adapters/presets');
const { buildStatesTree } = require('../src/adapters/states');
const { openDatabase } = require('../src/db');
const createTasmotaAdapter = require('../adapter/tasmota');
const renderTasmotaDevices = require('../src/views/tasmota-devices');

const EDITOR = {
  storageKey: 'registers', keyField: 'address', nameField: 'name', label: 'Register', presets: true,
  columns: [
    { key: 'address', label: 'Adresse', type: 'text', required: true, default: '', options: [] },
    { key: 'name', label: 'Name', type: 'text', required: true, default: '', options: [] },
    { key: 'register', label: 'Register', type: 'number', required: true, default: '', options: [] },
    { key: 'registerType', label: 'Typ', type: 'select', default: 'holding', options: [{ value: 'holding', label: 'H' }, { value: 'coil', label: 'C' }] },
    { key: 'writable', label: 'Schreibbar', type: 'checkbox', default: false, options: [] },
    { key: 'scale', label: 'Scale', type: 'number', default: 1, options: [] },
  ],
};

// Beispiel-Adapter im Temp-Verzeichnis anlegen.
function writeAdapter(id, prefix, extra = {}) {
  const dir = path.join(ADAPTER_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'adapter.json'),
    JSON.stringify({ id, name: `${id} Adapter`, prefix, main: 'index.js', settings: extra.settings || [] })
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => ({ start() {} });');
}

function freshDb() {
  const dbPath = process.env.HOME_ESS_DB;
  fs.rmSync(dbPath, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test('Registry scannt /adapter und validiert Prefix/Manifest', () => {
  writeAdapter('demo', 'demo', { settings: [{ key: 'interval', type: 'number', default: 5 }] });
  writeAdapter('bad', 'Inv@lid'); // ungültiger Prefix -> verworfen
  const list = registry.loadRegistry();
  const ids = list.map((m) => m.id);
  assert.ok(ids.includes('demo'), 'demo gefunden');
  assert.ok(!ids.includes('bad'), 'ungültiger Prefix verworfen');
  const demo = registry.getManifest('demo');
  assert.equal(demo.prefix, 'demo');
  assert.equal(demo.settings.length, 1);
  assert.equal(demo.settings[0].type, 'number');
});

test('Instanzen-CRUD', async () => {
  const db = await freshDb();
  const id = await instancesRepo.createInstance(db, 'demo', 'sim1');
  let list = await instancesRepo.listInstances(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'sim1');
  assert.equal(list[0].enabled, false);

  await instancesRepo.renameInstance(db, id, 'sim-renamed');
  await instancesRepo.setEnabled(db, id, true);
  await instancesRepo.updateSettings(db, id, { interval: 7 });
  const inst = await instancesRepo.getInstance(db, id);
  assert.equal(inst.name, 'sim-renamed');
  assert.equal(inst.enabled, true);
  assert.deepEqual(inst.settings, { interval: 7 });

  await instancesRepo.deleteInstance(db, id);
  list = await instancesRepo.listInstances(db);
  assert.equal(list.length, 0);
  db.close();
});

test('Router routet Instanz-Werte in den Bus (kanonisch + registrierter Key)', () => {
  router.registerScheme('demo', 'demo');
  router.setInstanceScheme('sim1', 'demo');
  router.registerRoute('demo://sim1/messwerte/temperatur', 'mystate');
  router.ingestFromInstance('sim1', 'messwerte/temperatur', 21.5);

  const cache = bus.getCache();
  assert.equal(cache.get('demo://sim1/messwerte/temperatur').value, 21.5);
  assert.equal(cache.get('mystate').value, 21.5);

  router.unregisterRoute('demo://sim1/messwerte/temperatur', 'mystate');
  router.removeInstanceScheme('sim1');
});

test('Bus feuert nur bei echter Wertänderung (bricht Rückkopplung)', () => {
  let events = 0;
  const off = bus.onValuesChanged(() => { events += 1; });

  bus.ingest(['loop_key'], 7);       // neu -> Änderung -> Event
  bus.ingest(['loop_key'], 7);       // gleich -> kein Event
  bus.ingest(['loop_key'], '7');     // gleiche Repräsentation -> kein Event
  assert.equal(events, 1, 'nur die erste (echte) Änderung feuert');

  bus.ingest(['loop_key'], 8);       // geänderter Wert -> Event
  assert.equal(events, 2);

  // Cache bleibt trotz unterdrückter Events frisch (Frische für Verifikation).
  const before = bus.getCache().get('loop_key').receivedAt;
  bus.ingest(['loop_key'], 8, { receivedAt: before + 1000 });
  assert.equal(bus.getCache().get('loop_key').receivedAt, before + 1000);
  assert.equal(events, 2, 'unveränderter Wert löst kein weiteres Event aus');

  off();
  bus.remove('loop_key');
});

test('Router liefert retained-Wert sofort beim Abonnieren (kein Warten auf Tick)', () => {
  router.registerScheme('demo', 'demo');
  router.setInstanceScheme('sim2', 'demo');
  // Adapter meldet zuerst – noch ohne registrierten Konsumenten. Wert liegt nur
  // unter dem kanonischen Topic.
  router.ingestFromInstance('sim2', 'messwerte/leistung', 1234);
  const cache = bus.getCache();
  assert.equal(cache.get('demo://sim2/messwerte/leistung').value, 1234);
  assert.equal(cache.get('spaeter'), undefined);

  // Jetzt abonniert ein Konsument (z. B. per State-Picker gewähltes Topic) → er
  // muss den zuletzt bekannten Wert sofort erhalten, ohne auf den nächsten Tick
  // oder eine read()-Implementierung zu warten.
  router.registerRoute('demo://sim2/messwerte/leistung', 'spaeter');
  assert.equal(cache.get('spaeter').value, 1234);

  router.unregisterRoute('demo://sim2/messwerte/leistung', 'spaeter');
  router.removeInstanceScheme('sim2');
});

test('Router.write delegiert an den Host', () => {
  const calls = [];
  router.setHost({ write: (name, addr, val) => calls.push([name, addr, val]), read: () => {} });
  const handled = router.write('demo://sim1/steuerung/schalter', true);
  assert.equal(handled, true);
  assert.deepEqual(calls, [['sim1', 'steuerung/schalter', true]]);
  assert.equal(router.write('battery.0.soc', 1), false); // kein Adapter-Topic
});

test('Host startet Instanz als (Fake-)Kindprozess und verarbeitet IPC', async () => {
  const db = await freshDb();
  registry.loadRegistry();
  const id = await instancesRepo.createInstance(db, 'demo', 'simhost');
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
  assert.equal(children.length, 1, 'ein Kindprozess geforkt');
  const child = children[0];
  const initMsg = child.sent.find((m) => m.type === 'init');
  assert.ok(initMsg, 'init gesendet');
  assert.equal(initMsg.name, 'simhost');

  // Kind meldet States -> persistiert in adapter_states.
  child.emit('message', { type: 'states', list: [
    { address: 'messwerte/temperatur', name: 'Temperatur', category: 'Messwerte', unit: '°C' },
  ] });
  // Kind meldet Wert -> landet im Bus unter kanonischem Topic.
  child.emit('message', { type: 'value', address: 'messwerte/temperatur', value: 19 });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(bus.getCache().get('demo://simhost/messwerte/temperatur').value, 19);
  assert.equal(host.isRunning(id), true);

  // States-Baum spiegelt persistierte States + Live-Wert.
  const tree = await buildStatesTree(db);
  const inst = tree.find((t) => t.instanceName === 'simhost');
  assert.ok(inst);
  assert.equal(inst.categories[0].name, 'Messwerte');
  assert.equal(inst.categories[0].states[0].value, 19);

  await host.stopInstance(id);
  assert.equal(host.isRunning(id), false);
  const stopMsg = child.sent.find((m) => m.type === 'stop');
  assert.ok(stopMsg, 'stop gesendet');
  db.close();
});

test('Host persistiert dynamische Adapter-Instanzdaten via storage-IPC', async () => {
  const db = await freshDb();
  registry.loadRegistry();
  const id = await instancesRepo.createInstance(db, 'demo', 'simstorage');
  await instancesRepo.setEnabled(db, id, true);
  await host.initAdapters(db);

  const entry = { instance: { id, name: 'simstorage' }, manifest: { prefix: 'demo' }, status: {} };
  host._handleMessage(entry, { type: 'storage', key: 'devices', value: [{ topic: 'plug1', online: true }] });
  await new Promise((r) => setTimeout(r, 150));

  const instance = await instancesRepo.getInstance(db, id);
  assert.deepEqual(instance.settings.devices, [{ topic: 'plug1', online: true }]);
  await host.stopAll();
  db.close();
});

test('Host startet abgestürztes Kind automatisch neu', async () => {
  const db = await freshDb();
  registry.loadRegistry();
  const id = await instancesRepo.createInstance(db, 'demo', 'simcrash');
  await instancesRepo.setEnabled(db, id, true);

  const children = [];
  host._setForkImpl(() => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = (msg) => child.sent.push(msg);
    child.kill = () => child.emit('exit', 1);
    children.push(child);
    return child;
  });

  await host.initAdapters(db);
  assert.equal(children.length, 1);
  // Absturz simulieren (kein vorheriges stop) -> Backoff-Restart.
  children[0].emit('exit', 1);
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(children.length >= 2, 'Kind wurde neu gestartet');

  await host.stopInstance(id);
  db.close();
});

test('State-Editor normalisiert Zeilen typgerecht', () => {
  const row = stateEditor.normalizeRow(
    { address: 'batterie/soc', name: 'SoC', register: '843', registerType: 'unsinn', writable: '1', scale: '0,01' },
    EDITOR
  );
  assert.equal(row.register, 843);            // number-Coercion
  assert.equal(row.writable, true);           // checkbox
  assert.equal(row.registerType, 'holding');  // ungültige Option -> default
  assert.equal(row.scale, 0.01);              // Komma -> Punkt
});

test('State-Editor validiert Pflichtfelder', () => {
  assert.deepEqual(stateEditor.validateRow(stateEditor.normalizeRow({ address: 'a', name: 'n', register: 1 }, EDITOR), EDITOR), []);
  const errs = stateEditor.validateRow(stateEditor.normalizeRow({ name: 'n' }, EDITOR), EDITOR);
  assert.ok(errs.length >= 1, 'fehlende Pflichtfelder gemeldet');
});

test('Preset-Validierung: gültig, Duplikate übersprungen, Format geprüft', () => {
  const good = presetsRepo.validatePresetData({
    presetFormat: 1,
    registers: [
      { address: 'a', name: 'A', register: 1 },
      { address: 'a', name: 'A2', register: 2 }, // Duplikat -> skip
      { name: 'kein-key', register: 3 },         // ohne address -> skip
      { address: 'b', name: 'B', register: 4 },
    ],
  }, EDITOR);
  assert.equal(good.ok, true);
  assert.deepEqual(good.rows.map((r) => r.key), ['a', 'b']);
  assert.equal(good.skipped, 2);

  assert.equal(presetsRepo.validatePresetData({ registers: [] }, EDITOR).ok, false);
  assert.equal(presetsRepo.validatePresetData({ presetFormat: 99, registers: [{ address: 'a', name: 'A', register: 1 }] }, EDITOR).ok, false);
  assert.equal(presetsRepo.validatePresetData('nope', EDITOR).ok, false);
});

test('State-Editor: zusammengesetzter Schlüssel (unitId + address)', () => {
  const ed = {
    storageKey: 'registers', keyField: 'unitId', keyFields: ['unitId', 'address'], nameField: 'name', presets: true,
    columns: [
      { key: 'unitId', label: 'Unit', type: 'number', default: 1, options: [] },
      { key: 'address', label: 'Adresse', type: 'text', required: true, default: '', options: [] },
      { key: 'name', label: 'Name', type: 'text', required: true, default: '', options: [] },
    ],
  };
  const r1 = stateEditor.normalizeRow({ unitId: 1, address: 'batterie/soc', name: 'A' }, ed);
  const r2 = stateEditor.normalizeRow({ unitId: 2, address: 'batterie/soc', name: 'B' }, ed);
  assert.equal(stateEditor.rowKey(r1, ed), '1/batterie/soc');
  assert.equal(stateEditor.rowKey(r2, ed), '2/batterie/soc'); // gleiche address, andere Unit -> eindeutig

  const v = presetsRepo.validatePresetData({
    presetFormat: 1,
    registers: [
      { unitId: 1, address: 'a', name: 'A' },
      { unitId: 2, address: 'a', name: 'A2' }, // andere Unit -> erlaubt
      { unitId: 1, address: 'a', name: 'dup' }, // (1,a) doppelt -> skip
    ],
  }, ed);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows.map((r) => r.key), ['1/a', '2/a']);
  assert.equal(v.skipped, 1);
});

test('Registry liest stateEditor-Schema (über Temp-Adapter)', () => {
  const dir = path.join(ADAPTER_DIR, 'withedit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify({
    id: 'withedit', prefix: 'we', main: 'index.js',
    stateEditor: { storageKey: 'registers', keyField: 'address', categoryField: 'category', nixField: 'x', presets: true, columns: [
      { key: 'address', label: 'Adresse', type: 'text', required: true },
      { key: 'category', label: 'Kategorie', type: 'text' },
      { key: 'register', label: 'Register', type: 'number' },
    ] },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => ({ start() {} });');
  registry.loadRegistry();
  const m = registry.getManifest('withedit');
  assert.ok(m.stateEditor);
  assert.equal(m.stateEditor.keyField, 'address');
  assert.equal(m.stateEditor.columns.length, 3);
  assert.equal(m.stateEditor.presets, true);
  assert.equal(m.stateEditor.categoryField, 'category'); // gültiges Kategorie-Feld übernommen
});

test('Einstellungen speichern behält den State-Editor-Speicher (Register)', async () => {
  const express = require('express');
  const http = require('http');
  const adapterRoutes = require('../src/routes/adapters');

  const db = await freshDb();
  // Adapter mit Settings-Schema (host) – Register liegen unter dem Nicht-Schema-Key.
  writeAdapter('mbx', 'mbx', { settings: [{ key: 'host', type: 'text', default: '' }] });
  registry.loadRegistry();
  const id = await instancesRepo.createInstance(db, 'mbx', 'inst1');
  await instancesRepo.updateSettings(db, id, { host: 'alt', registers: [{ address: 'b/soc', name: 'SoC' }] });

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.session = { user: 'test' }; next(); }); // Auth stubben
  app.use(adapterRoutes(db));
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  await new Promise((resolve, reject) => {
    const data = 'host=neu';
    const req = http.request({ method: 'POST', port, path: `/adapter/instance/${id}/settings`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(data);
  });
  server.close();

  const inst = await instancesRepo.getInstance(db, id);
  assert.equal(inst.settings.host, 'neu', 'Schema-Feld aktualisiert');
  assert.deepEqual(inst.settings.registers, [{ address: 'b/soc', name: 'SoC' }], 'Register bleiben erhalten');
  db.close();
});

test('Tasmota-Adapter nimmt MQTT-Verbindung an, fragt STATUS an und publiziert Werte', async () => {
  const mqtt = require('mqtt');
  const port = await getFreePort();
  const events = { states: [], values: [], storage: [], connections: [] };
  const adapter = createTasmotaAdapter({
    setStates(list) { events.states.push(list); },
    publishState(address, value) { events.values.push({ address, value }); },
    publishStates(values) { values.forEach((entry) => events.values.push(entry)); },
    setStorage(key, value) { events.storage.push({ key, value }); },
    setConnected(connected, detail) { events.connections.push({ connected, detail }); },
    log() {},
  });

  await adapter.start({
    port,
    username: 'user',
    password: 'secret',
    devices: [
      { topic: 'tasmota-test', clientId: 'tasmota-test', friendlyName: 'tasmota-test', fields: [] },
      { topic: 'plug1', clientId: 'tasmota-test', friendlyName: 'Kueche Boiler', fields: [] },
    ],
  });
  assert.equal(events.connections.at(-1).connected, false, 'Broker ohne Gerät ist nicht verbunden');

  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
    clientId: 'tasmota-test',
    username: 'user',
    password: 'secret',
    reconnectPeriod: 0,
  });

  const received = [];
  client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString('utf8') }));

  await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('connect', resolve);
  });
  assert.equal(events.connections.at(-1).connected, true, 'MQTT-Gerät setzt Verbindungsflag');

  await new Promise((resolve, reject) => client.subscribe('cmnd/plug1/POWER', (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(received.some((entry) => entry.topic === 'cmnd/plug1/STATUS' && entry.payload === '0'));

  await new Promise((resolve, reject) => client.publish('tele/plug1/LWT', 'Online', (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve, reject) => client.publish('tele/plug1/STATE', JSON.stringify({
    Time: '2026-07-03T10:00:00',
    POWER: 'ON',
    Wifi: { RSSI: 74 },
  }), (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve, reject) => client.publish('tele/plug1/SENSOR', JSON.stringify({
    ENERGY: { Total: 500.218, Today: 0.166, Yesterday: 0.472, Power: 42, Voltage: 229 },
  }), (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve, reject) => client.publish('tele/other-route/STATE', JSON.stringify({
    POWER: 'OFF',
  }), (err) => (err ? reject(err) : resolve())));

  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.ok(events.values.some((entry) => entry.address === 'plug1/online' && entry.value === true));
  assert.ok(events.values.some((entry) => entry.address === 'plug1/POWER' && entry.value === true));
  assert.ok(events.values.some((entry) => entry.address === 'plug1/ENERGY/Power' && entry.value === 42));
  assert.equal(events.values.some((entry) => entry.address === 'plug1/Wifi/RSSI'), false);
  assert.equal(events.values.some((entry) => entry.address === 'plug1/ENERGY/Voltage'), false);
  assert.ok(events.states.some((list) => list.some((entry) => entry.address === 'plug1/POWER')));
  const catalog = events.states.at(-1);
  assert.deepEqual(catalog.map((entry) => entry.address).sort(), [
    'plug1/ENERGY/Power',
    'plug1/ENERGY/Today',
    'plug1/ENERGY/Total',
    'plug1/ENERGY/Yesterday',
    'plug1/POWER',
  ]);
  assert.equal(catalog.find((entry) => entry.address === 'plug1/POWER').writable, true);
  assert.ok(events.storage.some((entry) => entry.key === 'devices' && Array.isArray(entry.value) && entry.value.some((row) => row.topic === 'plug1')));
  const storedDevices = events.storage.at(-1).value;
  assert.equal(storedDevices.filter((row) => row.clientId === 'tasmota-test').length, 1, 'Client-ID-Dublette wird zusammengeführt');
  assert.equal(storedDevices.some((row) => row.topic === 'tasmota-test'), false, 'vorläufiger Client-Eintrag wird entfernt');
  assert.equal(storedDevices.some((row) => row.topic === 'other-route'), false, 'kanonische Geräteadresse bleibt nach weiteren Topics stabil');

  adapter.write('plug1/POWER', false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(received.some((entry) => entry.topic === 'cmnd/plug1/POWER' && entry.payload === 'OFF'));

  await new Promise((resolve) => client.end(false, resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.connections.at(-1).connected, false, 'Letztes getrenntes Gerät löscht Verbindungsflag');
  await adapter.stop();
});

test('Tasmota-Adapter erkennt frei angeordnetes FullTopic', () => {
  const parsed = createTasmotaAdapter.parseTasmotaTopic('house/kitchen/plug1/tele/SENSOR');
  assert.deepEqual(parsed, {
    group: 'tele',
    deviceTopic: 'house/kitchen/plug1',
    messageType: 'SENSOR',
  });
  assert.deepEqual(createTasmotaAdapter.parseTasmotaTopic('custom/device/STATE'), {
    group: 'tele',
    deviceTopic: 'custom/device',
    messageType: 'STATE',
  });
  assert.equal(
    createTasmotaAdapter.commandTopicFromSubscription('house/kitchen/plug1/cmnd/#'),
    'house/kitchen/plug1/cmnd/STATUS'
  );
});

test('Tasmota-Gerätename überschreibt FriendlyName in Katalog und Geräteansicht', () => {
  const device = {
    topic: 'plug1',
    friendlyName: 'Tasmota Plug',
    customName: 'Boiler Keller',
    fields: [{ path: 'POWER', name: 'POWER', category: 'Schalten', writable: true }],
    values: [],
  };
  const catalog = createTasmotaAdapter.buildStateCatalog([device]);
  assert.equal(catalog[0].name, 'Boiler Keller POWER');
  assert.equal(catalog[0].category, 'Boiler Keller / Schalten');

  const html = renderTasmotaDevices({
    adapter: { name: 'Tasmota', prefix: 'tasmota' },
    instance: { id: 7, name: 'broker' },
    devices: [device],
  });
  assert.match(html, />Boiler Keller</);
  assert.match(html, /tasmota-devices\/rename/);
  assert.match(html, /value="Boiler Keller"/);
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* egal */
  }
});
