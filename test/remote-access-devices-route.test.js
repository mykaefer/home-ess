'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const remoteAccessRoutes = require('../src/routes/remote-access');

const FP = 'abcd1234ef905678abcd1234ef905678abcd1234ef905678abcd1234ef905678';

function fakeIdentityStore(devices) {
  return {
    async getProvisionedIdentity() {
      return { instanceId: 'ins_route12345', devices };
    },
  };
}

function fakeDeviceStatus(runtime) {
  return { getRuntime: () => runtime };
}

async function startServer({ devices = [], runtime = { relayConnected: false, devices: {} }, connState = 'idle' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const sid = req.headers['x-test-session'];
    req.session = sid ? { id: String(sid) } : null;
    next();
  });
  const relayStub = { async createPairingSession() { return {}; } };
  const connectionStub = { getStatus: () => ({ state: connState }) };
  app.use(remoteAccessRoutes({
    relayClient: relayStub,
    connectionService: connectionStub,
    identityStore: fakeIdentityStore(devices),
    deviceStatus: fakeDeviceStatus(runtime),
    backgroundRetry: false,
  }));
  const { server, port } = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('error', reject);
    s.once('listening', () => resolve({ server: s, port: s.address().port }));
  });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('GET /api/remote-access/devices ohne Session -> 401 (Admin-Schutz)', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
});

test('GET /api/remote-access/devices mit Session -> 200, no-store, ohne Secrets', async (t) => {
  const device = { deviceId: 'dev_route123456', name: '<b>Kevins</b> Handy', platform: 'android', fingerprintHex: FP, pairedAt: '2026-07-10T10:00:00.000Z', lastKnownConnectedAt: '2026-07-14T09:00:00.000Z' };
  const runtime = { relayConnected: true, devices: { dev_route123456: { connected: true, connectedAt: '2026-07-14T09:00:00.000Z' } } };
  const srv = await startServer({ devices: [device], runtime, connState: 'authenticated' });
  t.after(srv.close);

  const res = await fetch(`${srv.base}/api/remote-access/devices`, { headers: { 'x-test-session': 'sid-1' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = await res.json();
  assert.equal(body.relay.connected, true);
  assert.equal(body.counts.paired, 1);
  assert.equal(body.counts.active, 1);
  assert.equal(body.devices[0].connection, 'active');
  // Name wird unverändert (roh) geliefert; das Escaping übernimmt der Browser via
  // textContent. Aber: nie der volle Fingerprint / keine Secrets.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(FP), 'kein vollständiger Fingerprint');
  assert.ok(!raw.toLowerCase().includes('token'), 'kein Token-Feld');
  assert.ok(!raw.toLowerCase().includes('publickey'), 'kein Public Key');
  assert.ok(body.devices[0].deviceIdShort.length < device.deviceId.length + 1);
});

test('GET /api/remote-access/devices: Relay nicht authentifiziert -> alle unbekannt', async (t) => {
  const device = { deviceId: 'dev_route123456', name: 'Handy', platform: 'android', fingerprintHex: FP, pairedAt: '2026-07-10T10:00:00.000Z', lastKnownConnectedAt: null };
  const srv = await startServer({ devices: [device], runtime: { relayConnected: false, devices: {} }, connState: 'reconnecting' });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/devices`, { headers: { 'x-test-session': 'sid-1' } });
  const body = await res.json();
  assert.equal(body.relay.connected, false);
  assert.equal(body.counts.active, 0);
  assert.equal(body.devices[0].connection, 'unknown');
});
