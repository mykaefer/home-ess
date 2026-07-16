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

async function authenticated(overrides = {}) {
  const { FakeWs, created } = makeFakeWs();
  const events = { linked: [], disconnects: 0 };
  const conn = createRelayConnection({
    wsUrl: 'wss://relay.example/ws',
    WebSocketImpl: FakeWs,
    identityStore: idStore(),
    logger: () => {},
    backoffMs: [1000],
    authTimeoutMs: 1000,
    idleTimeoutMs: 100000,
    onLinkedDevices: (s) => events.linked.push(s),
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

test('removeLink sendet korrektes remove_link (requestId + deviceId) und löst bei link_removed auf', async () => {
  const { conn, ws } = await authenticated();
  const p = conn.removeLink('dev_target0001');
  const sent = ws.lastSent();
  assert.equal(sent.type, 'remove_link');
  assert.equal(sent.deviceId, 'dev_target0001');
  assert.match(sent.requestId, /^req_[0-9a-f]+$/);
  // Eigene instanceId stammt aus der Verbindung, nicht aus der Nachricht.
  assert.equal(sent.instanceId, undefined);

  ws.serverSend({ type: 'link_removed', requestId: sent.requestId, instanceId: INSTANCE_ID, deviceId: 'dev_target0001', removedAt: new Date().toISOString() });
  const result = await p;
  assert.equal(result.deviceId, 'dev_target0001');
  conn.shutdown();
});

test('removeLink ohne authentifizierte Verbindung wird abgelehnt (kein Senden)', async () => {
  const { FakeWs, created } = makeFakeWs();
  const conn = createRelayConnection({
    wsUrl: 'wss://relay.example/ws', WebSocketImpl: FakeWs,
    identityStore: { async getProvisionedIdentity() { return null; } }, logger: () => {},
  });
  conn.start();
  await tick();
  await assert.rejects(() => conn.removeLink('dev_target0001'), (e) => e.code === 'remote_access_not_connected');
  assert.equal(created.length, 0);
  conn.shutdown();
});

test('removeLink mit ungültiger deviceId wird abgelehnt', async () => {
  const { conn } = await authenticated();
  await assert.rejects(() => conn.removeLink('not-a-device'), (e) => e.code === 'remote_access_invalid_device_id');
  conn.shutdown();
});

test('removeLink läuft in Timeout, wenn kein link_removed eintrifft', async () => {
  const { conn } = await authenticated({ removalTimeoutMs: 20 });
  await assert.rejects(() => conn.removeLink('dev_target0001'), (e) => e.code === 'remote_access_link_removal_timeout');
  conn.shutdown();
});

test('offene removeLink-Anfrage scheitert bei Verbindungsabbruch', async () => {
  const { conn, ws } = await authenticated();
  const p = conn.removeLink('dev_target0001');
  ws.serverClose(1006);
  await assert.rejects(() => p, (e) => e.code === 'remote_access_not_connected');
  conn.shutdown();
});

test('gültiges linked_devices wird validiert an die Senke übergeben', async () => {
  const { conn, ws, events } = await authenticated();
  ws.serverSend({
    type: 'linked_devices', instanceId: INSTANCE_ID, revision: 3, complete: true, generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_a1', deviceName: 'A', platform: 'android', pairedAt: new Date().toISOString(), connected: true, connectedAt: new Date().toISOString() }],
  });
  await tick();
  assert.equal(conn.getStatus().state, 'authenticated');
  assert.equal(events.linked.length, 1);
  assert.equal(events.linked[0].revision, 3);
  assert.equal(events.linked[0].complete, true);
  assert.equal(events.linked[0].devices[0].deviceId, 'dev_a1');
  conn.shutdown();
});

test('linked_devices mit fremder instanceId bricht die Verbindung ab (keine Übergabe)', async () => {
  const { conn, ws, events } = await authenticated();
  ws.serverSend({ type: 'linked_devices', instanceId: 'ins_wrongwrong', revision: 1, complete: true, generatedAt: new Date().toISOString(), devices: [] });
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  assert.equal(events.linked.length, 0);
  conn.shutdown();
});

test('linked_devices mit ungültiger Revision / unbekanntem Feld wird abgelehnt', async () => {
  let res = await authenticated();
  res.ws.serverSend({ type: 'linked_devices', instanceId: INSTANCE_ID, revision: -1, complete: true, generatedAt: new Date().toISOString(), devices: [] });
  await tick();
  assert.notEqual(res.conn.getStatus().state, 'authenticated');
  res.conn.shutdown();

  res = await authenticated();
  res.ws.serverSend({ type: 'linked_devices', instanceId: INSTANCE_ID, revision: 1, complete: true, generatedAt: new Date().toISOString(), devices: [], extra: 'nope' });
  await tick();
  assert.notEqual(res.conn.getStatus().state, 'authenticated');
  res.conn.shutdown();
});

test('link_removed mit fremder instanceId bricht ab', async () => {
  const { conn, ws } = await authenticated();
  ws.serverSend({ type: 'link_removed', requestId: 'req_x', instanceId: 'ins_wrongwrong', deviceId: 'dev_a1', removedAt: new Date().toISOString() });
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  conn.shutdown();
});
