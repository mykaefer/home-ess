'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const remoteAccessRoutes = require('../src/routes/remote-access');
const { RemoteAccessError } = require('../src/remote-access/errors');

const FP = 'abcd1234ef905678abcd1234ef905678abcd1234ef905678abcd1234ef905678';

// Fake-Persistenz, die den lokalen Bestand hält, damit „kein sofortiges lokales
// Löschen" beobachtbar ist: der Entfern-Endpunkt darf sie NICHT anfassen.
function fakeIdentityStore(devices) {
  return {
    async getProvisionedIdentity() { return { instanceId: 'ins_route12345', devices: devices.slice() }; },
  };
}

async function startServer({ devices = [], removeLink } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const sid = req.headers['x-test-session'];
    req.session = sid ? { id: String(sid) } : null;
    next();
  });
  const relayStub = { async createPairingSession() { return {}; } };
  const connectionStub = {
    getStatus: () => ({ state: 'authenticated' }),
    removeLink: removeLink || (async () => ({ deviceId: 'dev_route123456' })),
  };
  app.use(remoteAccessRoutes({
    relayClient: relayStub,
    connectionService: connectionStub,
    identityStore: fakeIdentityStore(devices),
    deviceStatus: { getRuntime: () => ({ relayConnected: true, devices: {} }) },
    backgroundRetry: false,
  }));
  const { server, port } = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('error', reject);
    s.once('listening', () => resolve({ server: s, port: s.address().port }));
  });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const DEVICE = { deviceId: 'dev_route123456', name: 'Handy', platform: 'android', fingerprintHex: FP, pairedAt: '2026-07-10T10:00:00.000Z', lastKnownConnectedAt: null };

test('POST devices/remove ohne CSRF -> 403', async (t) => {
  const srv = await startServer({ devices: [DEVICE] });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices/remove`, {
    method: 'POST', headers: { 'x-test-session': 'sid-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev_route123456' }),
  });
  assert.equal(res.status, 403);
});

test('POST devices/remove ohne Session -> 401', async (t) => {
  const srv = await startServer({ devices: [DEVICE] });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices/remove`, {
    method: 'POST', headers: { 'X-HomeESS-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev_route123456' }),
  });
  assert.equal(res.status, 401);
});

test('POST devices/remove mit ungültiger deviceId -> 400', async (t) => {
  const srv = await startServer({ devices: [DEVICE] });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices/remove`, {
    method: 'POST', headers: { 'x-test-session': 'sid-1', 'X-HomeESS-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'not-a-device' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'remote_access_invalid_device_id');
});

test('POST devices/remove: Erfolg -> 200, no-store, KEIN sofortiges lokales Löschen', async (t) => {
  let called = null;
  const srv = await startServer({ devices: [DEVICE], removeLink: async (id) => { called = id; return { deviceId: id }; } });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices/remove`, {
    method: 'POST', headers: { 'x-test-session': 'sid-1', 'X-HomeESS-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev_route123456' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.status, 'removal_requested');
  assert.equal(called, 'dev_route123456', 'remove_link mit deviceId ausgelöst');

  // Der Bestand ist unverändert — die Liste zeigt das Gerät weiterhin, bis der
  // linked_devices-Snapshot es entfernt.
  const list = await fetch(`${srv.base}/api/remote-access/devices`, { headers: { 'x-test-session': 'sid-1' } });
  const listBody = await list.json();
  assert.equal(listBody.counts.paired, 1, 'Gerät nicht sofort lokal gelöscht');
});

test('POST devices/remove: nicht verbunden -> 409', async (t) => {
  const srv = await startServer({ devices: [DEVICE], removeLink: async () => { throw new RemoteAccessError('remote_access_not_connected', 'x'); } });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices/remove`, {
    method: 'POST', headers: { 'x-test-session': 'sid-1', 'X-HomeESS-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev_route123456' }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'remote_access_not_connected');
});

test('POST devices/remove: Timeout -> 504', async (t) => {
  const srv = await startServer({ devices: [DEVICE], removeLink: async () => { throw new RemoteAccessError('remote_access_link_removal_timeout', 'x'); } });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices/remove`, {
    method: 'POST', headers: { 'x-test-session': 'sid-1', 'X-HomeESS-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev_route123456' }),
  });
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.error, 'remote_access_link_removal_timeout');
});
