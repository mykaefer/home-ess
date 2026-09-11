'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createAdapter = require('../adapter/hm-rpc');
const xmlrpc = require('../adapter/hm-rpc/xmlrpc');
const createQueue = require('../adapter/hm-rpc/rpc-queue');
const bus = require('../src/state-bus');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); }
  assert.fail('Erwarteter Zustand blieb aus');
}
async function fixture(t, count = 3) {
  const calls = [], statuses = [], errors = [], storage = {}, values = new Map();
  const devices = Array.from({ length: count }, (_, i) => ({ ADDRESS: `ABC:${i}`, VERSION: 1, PARAMSETS: ['VALUES'] }));
  let callback, active = 0, maxActive = 0, handler;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString());
      calls.push(request);
      active++;
      maxActive = Math.max(maxActive, active);
      let ended = false;
      const done = () => { if (!ended) { ended = true; active--; } };
      res.on('finish', done); res.on('close', done);
      if (request.method === 'init' && request.params[1]) callback = new URL(request.params[0]);
      if (handler && await handler(request, req, res)) return;
      let result = '';
      if (request.method === 'listDevices') result = devices;
      if (request.method === 'system.listMethods') result = ['init', 'listDevices'];
      if (request.method === 'getParamsetDescription') result = { STATE: { TYPE: 'BOOL', OPERATIONS: 7 }, PRESS: { TYPE: 'ACTION', OPERATIONS: 2 } };
      if (request.method === 'getParamset') result = { STATE: false };
      res.end(xmlrpc.methodResponse(result));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adapter = createAdapter({
    name: 'recovery', setStates() {}, setStorage(k, v) { storage[k] = v; },
    publishState(k, v) { values.set(k, v); },
    publishStates(entries) {
      for (const entry of entries) values.set(entry.address, entry.value);
      bus.ingestBatch(entries.map((entry) => ({ cacheKeys: `hm-recovery/${entry.address}`, value: entry.value })));
    },
    setConnected(connected, detail) { statuses.push({ connected, detail }); }, log() {}, error(e) { errors.push(e); },
  });
  const config = { host: '127.0.0.1', port: server.address().port, callbackHost: '127.0.0.1', reconnectInterval: 3600 };
  t.after(async () => { await adapter.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { adapter, config, calls, statuses, errors, storage, values,
    set handler(fn) { handler = fn; }, get maxActive() { return maxActive; },
    event: (parameter, value) => xmlrpc.call({ host: callback.hostname, port: Number(callback.port) }, 'event', ['homeESS-recovery', 'ABC:0', parameter, value]),
  };
}

test('400 Kanäle: Transportfehler bricht Sync ab; Wiederverbindung bleibt frei und setzt nur fehlende Daten fort', async (t) => {
  const f = await fixture(t, 400);
  let broken = true;
  f.handler = async (c, req) => {
    if (broken && c.method === 'getParamset' && c.params[0] === 'ABC:1') { req.socket.destroy(); return true; }
  };
  await f.adapter.start(f.config);
  assert.equal(f.statuses.at(-1).connected, false);
  assert.equal(f.calls.filter((c) => c.method === 'getParamset').length, 2, 'kein Durchlauf durch 400 tote Kanäle');
  assert.ok(f.errors.some((e) => /Geräteabgleich unterbrochen/.test(e)));
  broken = false;
  await pause(1100);
  await f.adapter._test.maintainConnection();
  assert.equal(f.statuses.at(-1).connected, true, 'Registrierung wartet nicht auf Gerätesync');
  await f.adapter._test.synchronize();
  assert.equal(f.calls.filter((c) => c.method === 'getParamsetDescription' && c.params[0] === 'ABC:0').length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'getParamset' && c.params[0] === 'ABC:0').length, 1);
  assert.equal(f.maxActive, 1);
  const lists = f.calls.filter((c) => c.method === 'listDevices').length;
  f.adapter._test.forceDisconnected();
  await f.adapter._test.maintainConnection();
  assert.equal(f.calls.filter((c) => c.method === 'listDevices').length, lists, 'fertiger Gerätebestand wird beim Reconnect nicht neu gelesen');
});

test('Schreiben, Lesen und Prüfen laufen seriell; wartender Gegenbefehl bleibt erhalten, Aktionen bleiben einzeln', async (t) => {
  const f = await fixture(t);
  await f.adapter.start(f.config);
  let release;
  f.handler = async (c) => {
    if (c.method === 'setValue' && !release) await new Promise((resolve) => { release = resolve; });
  };
  const first = f.adapter.write('ABC%3A0/STATE', true);
  await until(() => release);
  const waiting = [
    f.adapter.write('ABC%3A0/STATE', true),
    f.adapter.write('ABC%3A0/STATE', false),
    f.adapter.write('ABC%3A1/PRESS', true),
    f.adapter.write('ABC%3A1/PRESS', true),
    f.adapter._test.refreshChannel('ABC:2', true),
    f.adapter._test.refreshChannel('ABC:2', true),
    f.adapter._test.maintainConnection(),
  ];
  release();
  await Promise.all([first, ...waiting]);
  assert.equal(f.maxActive, 1);
  assert.deepEqual(f.calls.filter((c) => c.method === 'setValue' && c.params[1] === 'STATE').map((c) => c.params[2]), [true, false]);
  assert.equal(f.calls.filter((c) => c.method === 'setValue' && c.params[1] === 'PRESS').length, 2);
  assert.equal(f.calls.filter((c) => c.method === 'getParamset' && c.params[0] === 'ABC:2').length, 2, 'Initialwert und eine gemeinsame Lesung');
});

test('13 gleichzeitige Heizungsbefehle teilen eine fehlgeschlagene Erreichbarkeitsprüfung', async (t) => {
  const f = await fixture(t, 13);
  await f.adapter.start(f.config);
  f.adapter._test.forceDisconnected();
  const before = f.calls.filter((c) => c.method === 'system.listMethods').length;
  f.handler = async (c, req) => { if (c.method === 'system.listMethods') { req.socket.destroy(); return true; } };
  await Promise.all(Array.from({ length: 13 }, (_, i) => f.adapter.write(`ABC%3A${i}/STATE`, true)));
  assert.equal(f.calls.filter((c) => c.method === 'system.listMethods').length - before, 1);
  assert.equal(f.calls.filter((c) => c.method === 'setValue').length, 0);
});

test('Event während setValue bleibt bestätigt; unveränderte Events erneuern Frische ohne Änderungsaktion', async (t) => {
  const f = await fixture(t, 1);
  await f.adapter.start(f.config);
  f.handler = async (c) => { if (c.method === 'setValue') await f.event('STATE', true); };
  await f.adapter.write('ABC%3A0/STATE', true);
  const realNow = Date.now;
  const events = [];
  const off = bus.onValuesChanged((e) => events.push(e));
  try {
    Date.now = () => realNow() + 120000;
    await f.event('STATE', true);
    await f.adapter.write('ABC%3A0/STATE', true);
    assert.equal(f.calls.filter((c) => c.method === 'setValue').length, 1);
    assert.equal(events.flatMap((event) => event.changedKeys || [])
      .filter((key) => key === 'hm-recovery/ABC%3A0/STATE').length, 0);
    assert.ok(bus.getCache().get('hm-recovery/ABC%3A0/STATE').receivedAt > realNow());
    assert.equal(f.values.get('status/callback-connected'), true);
    assert.equal(f.values.get('status/event-count'), 2);
    assert.match(f.values.get('status/last-event-at'), /^\d{4}-\d{2}-\d{2}T/);
  } finally { Date.now = realNow; off(); }
});

test('Alte Leseantwort überschreibt kein währenddessen empfangenes Event', async (t) => {
  const f = await fixture(t, 1);
  await f.adapter.start(f.config);
  f.handler = async (c) => { if (c.method === 'getParamset') await f.event('STATE', true); };
  await f.adapter._test.refreshChannel('ABC:0', true);
  assert.equal(f.values.get('ABC%3A0/STATE'), true);
});

test('Fehlgeschlagener Schreibauftrag bleibt sofort wiederholbar', async (t) => {
  const f = await fixture(t, 1);
  await f.adapter.start(f.config);
  let fail = true;
  f.handler = async (c, req) => { if (c.method === 'setValue' && fail) { req.socket.destroy(); return true; } };
  await f.adapter.write('ABC%3A0/STATE', true);
  fail = false;
  await f.adapter.write('ABC%3A0/STATE', true);
  assert.equal(f.calls.filter((c) => c.method === 'setValue').length, 2);
});

test('XML-RPC verwendet pro Aufruf eine neue Verbindung und lehnt abgebrochene Antworten ab', async (t) => {
  const sockets = new Set();
  let abort = false;
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    req.resume();
    if (abort) {
      res.writeHead(200, { 'Content-Length': 1000 });
      res.write('<methodResponse>');
      setTimeout(() => res.destroy(), 5);
    } else res.end(xmlrpc.methodResponse('ok'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = { host: '127.0.0.1', port: server.address().port };
  for (let i = 0; i < 3; i++) await xmlrpc.call(options, 'system.listMethods', [], 500);
  assert.equal(sockets.size, 3);
  abort = true;
  await assert.rejects(xmlrpc.call(options, 'system.listMethods', [], 500), /abgebrochen/);
});

test('Stopp verwirft wartende RPC-Aufträge und lässt den laufenden Auftrag abschließen', async () => {
  const queue = createQueue();
  let release;
  const running = queue.run(() => new Promise((resolve) => { release = resolve; }));
  await until(() => release);
  let sent = false;
  const pending = queue.run(() => { sent = true; });
  const rejected = assert.rejects(pending, /gestoppt/);
  queue.close();
  release();
  await Promise.all([running, rejected]);
  assert.equal(sent, false);
});

test('Persistierte Beschreibungen bleiben nach Neustart nutzbar, ohne erneute Beschreibung je Kanal', async (t) => {
  const first = await fixture(t, 3);
  await first.adapter.start(first.config);
  const second = await fixture(t, 3);
  await second.adapter.start({ ...second.config, devices: first.storage.devices, rpcMetadata: first.storage.rpcMetadata });
  assert.equal(second.calls.filter((c) => c.method === 'getParamsetDescription').length, 0);
  await second.adapter.write('ABC%3A0/STATE', true);
  assert.equal(second.calls.filter((c) => c.method === 'setValue').length, 1);
  assert.equal(second.values.get('status/callback-connected'), false, 'RPC-Antwort beweist keinen Callback');
});

test('Abgelaufener wartender Auftrag ist kein Transportausfall und wird nicht gesendet', async () => {
  const queue = createQueue();
  let release;
  const running = queue.run(() => new Promise((resolve) => { release = resolve; }));
  await until(() => release);
  let sent = false;
  const expired = queue.run(() => { sent = true; }, { maxAge: -1 });
  const rejected = assert.rejects(expired, (err) => err.cancelled === true && /abgelaufen/.test(err.message));
  release();
  await Promise.all([running, rejected]);
  assert.equal(sent, false);
  queue.close();
});

// Heizungsanlage mit Wartungskanal: DEV1 ist erreichbar, DEV2 meldet sich als
// nicht erreichbar (UNREACH). Beide führen einen Sollwert von 19 °C.
async function heizungFixture(t, { unreach = { DEV1: false, DEV2: true }, slowListDevices = 0 } = {}) {
  const calls = [];
  const devices = [];
  for (const device of ['DEV1', 'DEV2']) {
    devices.push({ ADDRESS: device, VERSION: 1, PARAMSETS: [] });
    devices.push({ ADDRESS: `${device}:0`, PARENT: device, VERSION: 1, PARAMSETS: ['VALUES'] });
    devices.push({ ADDRESS: `${device}:1`, PARENT: device, VERSION: 1, PARAMSETS: ['VALUES'] });
  }
  const beschreibung = (address) => (address.endsWith(':0')
    ? { UNREACH: { TYPE: 'BOOL', OPERATIONS: 5 } }
    : { SET_POINT_TEMPERATURE: { TYPE: 'FLOAT', OPERATIONS: 7, UNIT: '°C' } });
  // Wie im Betrieb: Gerätebestand und Parameterbeschreibungen liegen aus dem
  // letzten Lauf vor, der Regelzyklus kann also sofort nach dem Start schreiben.
  const rpcMetadata = {
    channels: devices,
    schemas: devices.filter((entry) => entry.PARAMSETS.includes('VALUES'))
      .map((entry) => [entry.ADDRESS, { version: entry.VERSION, description: beschreibung(entry.ADDRESS) }]),
  };
  let callback;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const request = xmlrpc.parseCall(Buffer.concat(chunks).toString());
      calls.push(request);
      if (request.method === 'init' && request.params[1]) callback = new URL(request.params[0]);
      if (request.method === 'listDevices' && slowListDevices) await pause(slowListDevices);
      const address = String(request.params[0] || '');
      const device = address.split(':')[0];
      let result = '';
      if (request.method === 'listDevices') result = devices;
      if (request.method === 'system.listMethods') result = ['init', 'listDevices', 'setValue'];
      if (request.method === 'getParamsetDescription') result = beschreibung(address);
      if (request.method === 'getParamset') {
        result = address.endsWith(':0') ? { UNREACH: !!unreach[device] } : { SET_POINT_TEMPERATURE: 19 };
      }
      res.end(xmlrpc.methodResponse(result));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const errors = [];
  const adapter = createAdapter({
    name: 'heizung', setStates() {}, setStorage() {}, publishState() {}, publishStates() {},
    setConnected() {}, log() {}, error(message) { errors.push(message); },
  });
  const config = { host: '127.0.0.1', port: server.address().port, callbackHost: '127.0.0.1', reconnectInterval: 3600, rpcMetadata };
  t.after(async () => { await adapter.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const setValues = () => calls.filter((c) => c.method === 'setValue');
  return { adapter, config, calls, errors, setValues,
    event: (channel, parameter, value) => xmlrpc.call({ host: callback.hostname, port: Number(callback.port) },
      'event', ['homeESS-heizung', channel, parameter, value]) };
}

// Der Regelzyklus setzt beim Start alle Sollwerte durch, bevor der Abgleich die
// Istwerte geliefert hat. Ohne Vorab-Lesung ginge jeder dieser Befehle blind über
// Funk – und blockierte die gemeinsame Warteschlange bis zum Geräte-Timeout.
test('Schreiben auf einen ungelesenen Kanal liest zuerst dessen Istwerte und unterlässt den unnötigen Funkbefehl', async (t) => {
  const f = await heizungFixture(t, { unreach: { DEV1: false, DEV2: false }, slowListDevices: 150 });
  const start = f.adapter.start(f.config);
  await until(() => f.calls.some((c) => c.method === 'listDevices'));
  await f.adapter.write('DEV1%3A1/SET_POINT_TEMPERATURE', 19);
  const gelesen = f.calls.findIndex((c) => c.method === 'getParamset' && c.params[0] === 'DEV1:1');
  assert.ok(gelesen >= 0, 'Der Zielkanal muss vor dem Schreiben gelesen werden');
  assert.deepEqual(f.setValues(), [], 'Bei bereits passendem Sollwert darf kein Funkbefehl rausgehen');
  await start;
  // Ein abweichender Sollwert geht weiterhin sofort raus.
  await f.adapter.write('DEV1%3A1/SET_POINT_TEMPERATURE', 21);
  assert.deepEqual(f.setValues().map((c) => c.params[2]), [21]);
});

test('Nicht erreichbares Gerät bekommt keinen Funkbefehl; der Auftrag wird bei Rückkehr nachgeholt', async (t) => {
  const f = await heizungFixture(t);
  await f.adapter.start(f.config);
  await f.adapter.write('DEV2%3A1/SET_POINT_TEMPERATURE', 21);
  assert.deepEqual(f.setValues(), [], 'An ein UNREACH-Gerät geht kein setValue');
  assert.match(f.errors.join('\n'), /vorgemerkt/);
  // Wiederholungen des Regelzyklus fluten das Protokoll nicht.
  await f.adapter.write('DEV2%3A1/SET_POINT_TEMPERATURE', 21);
  assert.equal(f.errors.filter((message) => message.includes('vorgemerkt')).length, 1);

  // Das Gerät meldet sich zurück: der vorgemerkte Sollwert geht jetzt raus.
  await f.event('DEV2:0', 'UNREACH', false);
  await until(() => f.setValues().length === 1);
  assert.deepEqual(f.setValues()[0].params, ['DEV2:1', 'SET_POINT_TEMPERATURE', 21]);

  // Ein erreichbares Gerät bleibt davon unberührt.
  await f.adapter.write('DEV1%3A1/SET_POINT_TEMPERATURE', 22);
  assert.equal(f.setValues().length, 2);
});

// Der erste Abgleich dauert nur Sekundenbruchteile und liefert die Istwerte, an
// denen unnötige Funkbefehle erkennbar sind. Ein Schreibbefehl darf ihn deshalb
// beim Start nicht überholen (danach gilt wieder Vorrang für Schaltbefehle).
test('Der erste Geräteabgleich läuft vor einem gleichzeitig eintreffenden Schreibbefehl', async (t) => {
  const f = await heizungFixture(t, { unreach: { DEV1: false, DEV2: false }, slowListDevices: 100 });
  const start = f.adapter.start(f.config);
  await until(() => f.calls.some((c) => c.method === 'listDevices'));
  const write = f.adapter.write('DEV1%3A1/SET_POINT_TEMPERATURE', 23);
  await Promise.all([start, write]);
  const letzterAbgleich = f.calls.map((c) => c.method).lastIndexOf('getParamset');
  const schreiben = f.calls.findIndex((c) => c.method === 'setValue');
  assert.ok(schreiben > letzterAbgleich, 'Der Abgleich muss vor dem Schreibbefehl abgeschlossen sein');
});
