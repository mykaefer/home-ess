'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const createAdapter = require('../adapter/hm-rpc');
const xmlrpc = require('../adapter/hm-rpc/xmlrpc');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('HM-RPC XML-Codec verarbeitet verschachtelte CCU-Gerätelisten', () => {
  const input = [{ ADDRESS: 'ABC', PARAMSETS: ['VALUES'], META: { TYPE: 'DEVICE' } }];
  const xml = xmlrpc.methodResponse(input);
  assert.deepEqual(xmlrpc.parseResponse(xml), input);
});

test('HM-RPC hält Werte per Event aktuell, liest lokal und sperrt Schreiben bei Duty Cycle', async (t) => {
  const calls = [];
  let callbackUrl = '';
  const descriptions = {
    STATE: { TYPE: 'BOOL', OPERATIONS: 7 },
    DUTY_CYCLE: { TYPE: 'INTEGER', OPERATIONS: 5, UNIT: '100%' },
  };
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      calls.push(request);
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'SWITCH', NAME: 'Lampe' },
        { ADDRESS: 'ABC:1', TYPE: 'SWITCH_TRANSMITTER', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] },
      ];
      if (request.method === 'getParamsetDescription') result = descriptions;
      if (request.method === 'getParamset') result = { STATE: false, DUTY_CYCLE: 10 };
      if (request.method === 'init' && request.params[0]) callbackUrl = request.params[0];
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);
  t.after(() => new Promise((resolve) => ccu.close(resolve)));

  const values = new Map();
  let catalog = [];
  const storage = {};
  const batches = [];
  const errors = [];
  const adapter = createAdapter({
    name: 'test',
    setStates(list) { catalog = list; },
    setStorage(key, value) { storage[key] = value; },
    publishState(address, value) { values.set(address, value); },
    publishStates(entries) { batches.push(entries); entries.forEach((entry) => values.set(entry.address, entry.value)); },
    setConnected() {}, log() {}, error(message) { errors.push(message); },
  });
  await adapter.start({ host: '127.0.0.1', port, callbackHost: '127.0.0.1', dutyCycleLimit: 80 });
  t.after(() => adapter.stop());

  assert.ok(catalog.some((state) => state.address === 'ABC%3A1/STATE' && state.writable));
  // Geräte-Metadaten für die Geräteseite: Top-Level-Gerät mit ID, CCU-Name und Kanälen.
  const device = (storage.devices || []).find((entry) => entry.address === 'ABC');
  assert.ok(device, 'Gerät ABC wird als Geräte-Metadatensatz gemeldet');
  assert.equal(device.name, 'Lampe');
  assert.equal(device.customName, '');
  assert.ok(device.channels.some((channel) => channel.address === 'ABC:1'
    && channel.states.some((state) => state.address === 'ABC%3A1/STATE')));
  assert.equal(values.get('ABC%3A1/STATE'), false);
  assert.ok(callbackUrl);
  assert.ok(calls.some((call) => call.method === 'init' && call.params[1] === 'homeESS-test'));
  assert.equal(batches.length, 1, 'alle Initialwerte werden in einem Bus-Batch publiziert');

  const sendEvent = async (key, value) => {
    const target = new URL(callbackUrl);
    const response = await xmlrpc.call({ host: target.hostname, port: Number(target.port) }, 'event', ['test', 'ABC:1', key, value]);
    assert.equal(response.value, '');
  };
  await sendEvent('STATE', true);
  assert.equal(values.get('ABC%3A1/STATE'), true);

  const target = new URL(callbackUrl);
  const batchesBeforeMulticall = batches.length;
  await xmlrpc.call({ host: target.hostname, port: Number(target.port) }, 'system.multicall', [[
    { methodName: 'event', params: ['test', 'ABC:1', 'STATE', false] },
    { methodName: 'event', params: ['test', 'ABC:1', 'DUTY_CYCLE', 12] },
  ]]);
  assert.equal(values.get('ABC%3A1/STATE'), false);
  assert.equal(batches.length, batchesBeforeMulticall + 1, 'ein Multicall erzeugt genau einen Bus-Batch');

  // read() ist ein aktiver Refresh aus dem CCU-Cache (getParamset) – KEIN Funk-Read
  // und KEIN Schreibvorgang. So werden CCU-Änderungen ohne Push-Event übernommen.
  const readsBefore = calls.filter((call) => call.method === 'getParamset').length;
  const setBefore = calls.filter((call) => call.method === 'setValue').length;
  assert.equal(typeof adapter.read, 'function', 'aktiver Refresh-Handler vorhanden');
  await adapter.read('ABC%3A1/STATE');
  assert.equal(calls.filter((call) => call.method === 'getParamset').length, readsBefore + 1, 'read() liest den CCU-Cache per getParamset');
  assert.equal(calls.filter((call) => call.method === 'setValue').length, setBefore, 'read() löst keinen Funkbefehl aus');

  await sendEvent('DUTY_CYCLE', 85);
  await adapter.write('ABC%3A1/STATE', false);
  assert.equal(calls.some((call) => call.method === 'setValue'), false);
  assert.match(errors.at(-1), /Duty Cycle 85%/);

  await sendEvent('DUTY_CYCLE', 20);
  await adapter.write('ABC%3A1/STATE', false);
  assert.ok(calls.some((call) => call.method === 'setValue'));
});

test('HM-RPC verwendet den vergebenen Gerätenamen statt der Geräte-ID in den Kategorien', async (t) => {
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'SWITCH', NAME: 'Lampe' },
        { ADDRESS: 'ABC:1', TYPE: 'SWITCH_TRANSMITTER', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] },
      ];
      if (request.method === 'getParamsetDescription') result = { STATE: { TYPE: 'BOOL', OPERATIONS: 7 } };
      if (request.method === 'getParamset') result = { STATE: false };
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);
  t.after(() => new Promise((resolve) => ccu.close(resolve)));

  let catalog = [];
  const adapter = createAdapter({
    name: 'wohnzimmer',
    setStates(list) { catalog = list; },
    setStorage() {}, publishState() {}, publishStates() {},
    setConnected() {}, log() {}, error() {},
  });
  await adapter.start({
    host: '127.0.0.1', port, callbackHost: '127.0.0.1',
    devices: [{ address: 'ABC', customName: 'Wohnzimmerlampe' }],
  });
  t.after(() => adapter.stop());

  const state = catalog.find((entry) => entry.address === 'ABC%3A1/STATE');
  assert.ok(state, 'State der Lampe ist im Katalog');
  assert.ok(state.category.startsWith('Wohnzimmerlampe /'), `Kategorie nutzt den Klarnamen: ${state.category}`);
  assert.ok(!state.category.includes('ABC'), 'die Geräte-ID taucht nicht mehr in der Kategorie auf');
});

test('HM-RPC stellt Geräteliste und Katalog nach Neustart aus der Persistenz her – ohne CCU-Sync', async (t) => {
  // 1. Lauf: mit CCU synchronisieren und die persistierte Geräteliste einsammeln.
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'SWITCH', NAME: 'Lampe' },
        { ADDRESS: 'ABC:1', TYPE: 'SWITCH_TRANSMITTER', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] },
      ];
      if (request.method === 'getParamsetDescription') result = { STATE: { TYPE: 'BOOL', OPERATIONS: 7 }, LEVEL: { TYPE: 'FLOAT', OPERATIONS: 5, UNIT: '%' } };
      if (request.method === 'getParamset') result = { STATE: false, LEVEL: 42 };
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);

  const storage = {};
  const first = createAdapter({
    name: 'flur',
    setStates() {}, setStorage(key, value) { storage[key] = value; },
    publishState() {}, publishStates() {}, setConnected() {}, log() {}, error() {},
  });
  await first.start({ host: '127.0.0.1', port, callbackHost: '127.0.0.1', devices: [{ address: 'ABC', customName: 'Flurlampe' }] });
  await first.stop();
  await new Promise((resolve) => ccu.close(resolve));
  assert.ok(Array.isArray(storage.devices) && storage.devices.length, 'Geräteliste wurde persistiert');

  // 2. Lauf: CCU nicht erreichbar (Port geschlossen), nur persistierte Konfig.
  const dead = http.createServer(() => {});
  const deadPort = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));

  let catalog2 = [];
  const storage2 = {};
  const second = createAdapter({
    name: 'flur',
    setStates(list) { catalog2 = list; }, setStorage(key, value) { storage2[key] = value; },
    publishState() {}, publishStates() {}, setConnected() {}, log() {}, error() {},
  });
  await second.start({ host: '127.0.0.1', port: deadPort, callbackHost: '127.0.0.1', devices: storage.devices });
  t.after(() => second.stop());

  // Der Katalog ist aus der Persistenz vollständig – obwohl keine CCU-Synchronisierung lief.
  const restored = catalog2.find((entry) => entry.address === 'ABC%3A1/STATE');
  assert.ok(restored, 'State der Lampe wurde aus der Persistenz wiederhergestellt');
  assert.ok(restored.writable, 'Schreibbarkeit bleibt erhalten');
  assert.ok(restored.category.startsWith('Flurlampe /'), `Klarname bleibt erhalten: ${restored.category}`);
  const level = catalog2.find((entry) => entry.address === 'ABC%3A1/LEVEL');
  assert.ok(level && level.unit === '%', 'Einheit bleibt über den Neustart erhalten');
});

test('HM-RPC trägt fehlende Einheiten nach, sobald die Beschreibung vorliegt', async (t) => {
  // Reproduziert den Race bei großen Anlagen: Der Wert (Event) ist da, bevor die
  // Parameterbeschreibung mit UNIT geladen wurde. Anfangs liefert die CCU eine
  // leere Beschreibung; später (newDevices) die echte – die Einheit muss dann im
  // Katalog erscheinen, statt dauerhaft leer zu bleiben.
  let describe = false;
  let callbackUrl = '';
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'METER', NAME: 'Zähler' },
        { ADDRESS: 'ABC:1', TYPE: 'ENERGY', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] },
      ];
      // Vor describe=true noch keine Beschreibung (Wert kommt trotzdem via getParamset).
      if (request.method === 'getParamsetDescription') result = describe ? { ENERGY_COUNTER: { TYPE: 'FLOAT', OPERATIONS: 5, UNIT: 'Wh' } } : {};
      if (request.method === 'getParamset') result = { ENERGY_COUNTER: 1234 };
      if (request.method === 'init' && request.params[0]) callbackUrl = request.params[0];
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);
  t.after(() => new Promise((resolve) => ccu.close(resolve)));

  let catalog = [];
  const adapter = createAdapter({
    name: 'test',
    setStates(list) { catalog = list; }, setStorage() {}, publishState() {}, publishStates() {},
    setConnected() {}, log() {}, error() {},
  });
  await adapter.start({ host: '127.0.0.1', port, callbackHost: '127.0.0.1' });
  t.after(() => adapter.stop());

  // 1. Sync ohne Beschreibung: der Wert kommt über den (debounced) Event-Pfad in
  // den Katalog – kurz auf den Katalog-Debounce warten.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const before = catalog.find((entry) => entry.address === 'ABC%3A1/ENERGY_COUNTER');
  assert.ok(before, 'ENERGY_COUNTER ist trotz fehlender Beschreibung im Katalog');
  assert.equal(before.unit, '', 'ohne Beschreibung zunächst keine Einheit');

  // Beschreibung nachliefern und den Kanal erneut melden (newDevices).
  describe = true;
  const target = new URL(callbackUrl);
  await xmlrpc.call({ host: target.hostname, port: Number(target.port) }, 'newDevices',
    ['test', [{ ADDRESS: 'ABC:1', TYPE: 'ENERGY', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] }]]);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const after = catalog.find((entry) => entry.address === 'ABC%3A1/ENERGY_COUNTER');
  assert.equal(after.unit, 'Wh', 'Einheit wird nachgetragen, sobald die Beschreibung vorliegt');
});

test('HM-RPC fasst einen updateDevice-Burst zu genau einem Re-Sync zusammen', async (t) => {
  const calls = [];
  let callbackUrl = '';
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      calls.push(request.method);
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'SWITCH', NAME: 'Lampe' },
        { ADDRESS: 'ABC:1', TYPE: 'SWITCH_TRANSMITTER', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] },
      ];
      if (request.method === 'getParamsetDescription') result = { STATE: { TYPE: 'BOOL', OPERATIONS: 7 } };
      if (request.method === 'getParamset') result = { STATE: false };
      if (request.method === 'init' && request.params[0]) callbackUrl = request.params[0];
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);
  t.after(() => new Promise((resolve) => ccu.close(resolve)));

  const adapter = createAdapter({
    name: 'test',
    setStates() {}, setStorage() {}, publishState() {}, publishStates() {},
    setConnected() {}, log() {}, error() {},
  });
  await adapter.start({ host: '127.0.0.1', port, callbackHost: '127.0.0.1', reconnectInterval: 3600 });
  t.after(() => adapter.stop());

  const RESYNC_DEBOUNCE_MS = 2000; // muss zum Debounce-Fenster im Adapter passen
  const listAfterStart = calls.filter((m) => m === 'listDevices').length;
  const target = new URL(callbackUrl);
  // Burst aus fünf updateDevice-Callbacks in schneller Folge.
  for (let i = 0; i < 5; i++) {
    await xmlrpc.call({ host: target.hostname, port: Number(target.port) }, 'updateDevice', ['test', 'ABC:1', 0]);
  }
  // Vor Ablauf des Debounce-Fensters darf noch kein Re-Sync gelaufen sein.
  assert.equal(calls.filter((m) => m === 'listDevices').length, listAfterStart, 'kein sofortiger Re-Sync je updateDevice');
  await new Promise((resolve) => setTimeout(resolve, RESYNC_DEBOUNCE_MS + 500));
  assert.equal(
    calls.filter((m) => m === 'listDevices').length,
    listAfterStart + 1,
    'der gesamte Burst löst genau einen Re-Sync aus',
  );
});

test('HM-RPC beobachtet nach einem Steuerbefehl das Gerät aktiv, damit der Status nachzieht', async (t) => {
  const getParamsetCalls = []; // { channel, t }
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      const addr = request.params[0];
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'SWITCH', NAME: 'Schalter' },
        { ADDRESS: 'ABC:1', TYPE: 'SWITCH', PARENT: 'ABC', NAME: 'Schaltkanal', PARAMSETS: ['VALUES'] },
        { ADDRESS: 'ABC:2', TYPE: 'POWERMETER', PARENT: 'ABC', NAME: 'Messkanal', PARAMSETS: ['VALUES'] },
      ];
      if (request.method === 'getParamsetDescription') {
        result = addr === 'ABC:1' ? { STATE: { TYPE: 'BOOL', OPERATIONS: 7 } } : { POWER: { TYPE: 'FLOAT', OPERATIONS: 5, UNIT: 'W' } };
      }
      if (request.method === 'getParamset') {
        getParamsetCalls.push({ channel: addr, t: Date.now() });
        result = addr === 'ABC:1' ? { STATE: false } : { POWER: 0 };
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);
  t.after(() => new Promise((resolve) => ccu.close(resolve)));

  const adapter = createAdapter({
    name: 'test',
    setStates() {}, setStorage() {}, publishState() {}, publishStates() {},
    setConnected() {}, log() {}, error() {},
  });
  await adapter.start({ host: '127.0.0.1', port, callbackHost: '127.0.0.1', reconnectInterval: 3600 });
  t.after(() => adapter.stop());

  const baseline = getParamsetCalls.length;
  // Steuer-Topic des Geräts ändern.
  await adapter.write('ABC%3A1/STATE', true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const watched = getParamsetCalls.slice(baseline);

  // Der Messkanal (Status/Leistung) wird im Fenster mehrfach aktiv nachgefragt –
  // deutlich häufiger als die normale 3-s-Drossel erlauben würde.
  const powerRefreshes = watched.filter((c) => c.channel === 'ABC:2').length;
  assert.ok(powerRefreshes >= 2, `Status-/Messkanal wird aktiv beobachtet (Refreshs: ${powerRefreshes})`);
  // Auch der geschaltete Kanal selbst wird zur Readback-Bestätigung aufgefrischt.
  assert.ok(watched.some((c) => c.channel === 'ABC:1'), 'auch der Schaltkanal wird aufgefrischt');
});

test('HM-RPC frischt Kanäle im Hintergrund nacheinander auf – kein Burst, kein Funk', async (t) => {
  const getParamsetCalls = []; // { channel, t }
  const ccu = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString('utf8'));
      let result = '';
      if (request.method === 'listDevices') result = [
        { ADDRESS: 'ABC', TYPE: 'METER', NAME: 'Zähler' },
        { ADDRESS: 'ABC:1', TYPE: 'ENERGY', PARENT: 'ABC', NAME: 'Kanal 1', PARAMSETS: ['VALUES'] },
        { ADDRESS: 'ABC:2', TYPE: 'ENERGY', PARENT: 'ABC', NAME: 'Kanal 2', PARAMSETS: ['VALUES'] },
        { ADDRESS: 'ABC:3', TYPE: 'ENERGY', PARENT: 'ABC', NAME: 'Kanal 3', PARAMSETS: ['VALUES'] },
      ];
      if (request.method === 'getParamsetDescription') result = { STATE: { TYPE: 'BOOL', OPERATIONS: 5 } };
      if (request.method === 'getParamset') { getParamsetCalls.push({ channel: request.params[0], t: Date.now() }); result = { STATE: false }; }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xmlrpc.methodResponse(result));
    });
  });
  const port = await listen(ccu);
  t.after(() => new Promise((resolve) => ccu.close(resolve)));

  const setValues = [];
  const adapter = createAdapter({
    name: 'test',
    setStates() {}, setStorage() {}, publishState() {}, publishStates() {},
    setConnected() {}, log() {}, error() {},
  });
  // 1 s Fenster über 3 Kanäle → ~333 ms Abstand, ein Kanal nach dem anderen.
  await adapter.start({ host: '127.0.0.1', port, callbackHost: '127.0.0.1', reconnectInterval: 3600, refreshInterval: 1 });
  t.after(() => adapter.stop());

  const baseline = getParamsetCalls.length; // getParamset des Initial-Syncs ausklammern
  await new Promise((resolve) => setTimeout(resolve, 1400));
  const drip = getParamsetCalls.slice(baseline);

  // Jeder der drei Kanäle wurde im ersten Zyklus genau einmal aufgefrischt.
  const channels = new Set(drip.map((c) => c.channel));
  assert.deepEqual([...channels].sort(), ['ABC:1', 'ABC:2', 'ABC:3'], 'alle Kanäle werden abgedeckt');

  // Kein Burst: aufeinanderfolgende Refreshs sind zeitlich gestreckt (serialisiert).
  const times = drip.map((c) => c.t).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 150, `Refreshs gestreckt (Abstand ${times[i] - times[i - 1]} ms)`);
  }
  // Und niemals ein Funk-/Schreibbefehl.
  assert.equal(setValues.length, 0, 'Hintergrund-Refresh löst keinen setValue aus');
});
