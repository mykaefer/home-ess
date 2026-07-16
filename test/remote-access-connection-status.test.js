'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createRelayConnection } = require('../src/remote-access/relay-connection');

const INSTANCE_ID = 'ins_test1234567890';

function makeFakeWs() {
  const created = [];
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url; this.opts = opts;
      this.readyState = FakeWs.OPEN; this.sent = []; this.closed = false;
      created.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.emit('close', 1000); }
    terminate() { this.closed = true; }
    open() { this.emit('open'); }
    serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj), 'utf8'), false); }
    serverClose(code) { this.emit('close', code || 1006); }
    lastSent() { return this.sent[this.sent.length - 1]; }
  }
  FakeWs.OPEN = 1;
  return { FakeWs, created };
}

const tick = () => new Promise((r) => setImmediate(r));

function idStore() {
  return {
    async getProvisionedIdentity() { return { instanceId: INSTANCE_ID }; },
    async signRelayChallenge() { return 'c2lnbmF0dXJl'; },
  };
}

function validChallenge() {
  return {
    type: 'challenge', challengeId: 'ch_abc12345',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15000).toISOString(),
    protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID,
  };
}

// Baut eine authentifizierte Verbindung auf und liefert conn/ws sowie die
// gesammelten Callback-Aufrufe.
async function authenticated(overrides = {}) {
  const { FakeWs, created } = makeFakeWs();
  const events = { status: [], disconnects: 0 };
  const conn = createRelayConnection({
    wsUrl: 'wss://relay.example/ws',
    WebSocketImpl: FakeWs,
    identityStore: idStore(),
    logger: () => {},
    backoffMs: [1000],
    authTimeoutMs: 1000,
    idleTimeoutMs: 100000,
    onConnectionStatus: (v) => events.status.push(v),
    onDisconnected: () => { events.disconnects += 1; },
    ...overrides,
  });
  conn.start();
  await tick();
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: false } });
  await tick();
  assert.equal(conn.getStatus().state, 'authenticated');
  return { conn, ws, created, events };
}

function statusMsg(devices) {
  return { type: 'connection_status', instanceId: INSTANCE_ID, generatedAt: new Date().toISOString(), devices };
}

test('Gültiges connection_status wird validiert an die Senke übergeben', async () => {
  const { conn, ws, events } = await authenticated();
  ws.serverSend(statusMsg([
    { deviceId: 'dev_a1', deviceName: 'A', platform: 'android', pairedAt: new Date().toISOString(), connected: true, connectedAt: new Date().toISOString() },
    { deviceId: 'dev_b2', connected: false },
  ]));
  await tick();
  assert.equal(conn.getStatus().state, 'authenticated', 'Verbindung bleibt authentifiziert');
  assert.equal(events.status.length, 1);
  assert.equal(events.status[0].devices.length, 2);
  assert.equal(events.status[0].devices[0].connected, true);
  assert.equal(events.status[0].devices[1].connected, false);
  assert.equal(events.status[0].devices[1].connectedAt, null);
  conn.shutdown();
});

test('connection_status mit fremder instanceId bricht die Verbindung ab', async () => {
  const { conn, ws, events } = await authenticated();
  ws.serverSend({ type: 'connection_status', instanceId: 'ins_wrongwrong', generatedAt: new Date().toISOString(), devices: [] });
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  assert.equal(events.status.length, 0, 'keine Übergabe an die Senke');
  conn.shutdown();
});

test('connection_status mit unbekanntem Feld wird strikt abgelehnt', async () => {
  const { conn, ws, events } = await authenticated();
  const bad = statusMsg([]);
  bad.extra = 'nope';
  ws.serverSend(bad);
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  assert.equal(events.status.length, 0);
  conn.shutdown();
});

test('connection_status mit unbekanntem Geräte-Feld / falschem Typ wird abgelehnt', async () => {
  const { conn, ws, events } = await authenticated();
  ws.serverSend(statusMsg([{ deviceId: 'dev_a1', connected: 'yes' }]));
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  assert.equal(events.status.length, 0);
  conn.shutdown();
});

test('connectedAt bei connected:false ist unzulässig und wird abgelehnt', async () => {
  const { conn, ws, events } = await authenticated();
  ws.serverSend(statusMsg([{ deviceId: 'dev_a1', connected: false, connectedAt: new Date().toISOString() }]));
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  assert.equal(events.status.length, 0);
  conn.shutdown();
});

test('Disconnect nach authenticated ruft onDisconnected genau einmal', async () => {
  const { conn, ws, events } = await authenticated();
  assert.equal(events.disconnects, 0);
  ws.serverClose(1006);
  await tick();
  assert.equal(events.disconnects, 1, 'Laufzeitstatus-Senke wird beim Verlassen von authenticated informiert');
  conn.shutdown();
});
