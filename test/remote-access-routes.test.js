'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const remoteAccessRoutes = require('../src/routes/remote-access');
const pairingState = require('../src/remote-access/pairing-state');

const DEVICE_FP = '1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90';

// Fake-Identity-Store: signiert Platzhalter, provisioniert Platzhalter-IDs. Kein
// Dateizugriff, kein echtes Schlüsselmaterial.
function fakeIdentityStore() {
  return {
    async signInstancePairingProof() {
      return { proof: 'cHJvb2Y=', publicKeySpkiBase64: 'MCowBQYDK2VwAyEApe4=', instanceFingerprintHex: 'a'.repeat(64) };
    },
    async storeProvisionedIdentity(input) {
      return { instanceId: input.instanceId, pairedAt: input.pairedAt, devices: [] };
    },
    async getProvisionedIdentity() { return null; },
  };
}

function pairedRelay(extra = {}) {
  return {
    ...makeRelay(),
    async readPairingSessionStatus() {
      return {
        pairingId: 'pr_route1234',
        status: 'awaiting_confirmation',
        expiresAtMs: Date.now() + 300000,
        remainingSeconds: 300,
        claim: {
          deviceName: 'Android', platform: 'android', appVersion: '1.0.0',
          claimedAt: new Date().toISOString(), deviceFingerprint: DEVICE_FP,
        },
      };
    },
    async confirmPairingSession() { return { ok: true }; },
    async provisionPairingSession() {
      return {
        pairingId: 'pr_route1234', status: 'paired',
        instance: { instanceId: 'ins_route1234', name: 'homeESS', algorithm: 'Ed25519', fingerprint: 'a'.repeat(64) },
        device: { deviceId: 'dev_route1234', name: 'Android', platform: 'android', algorithm: 'Ed25519', fingerprint: DEVICE_FP },
        pairedAt: new Date().toISOString(),
      };
    },
    ...extra,
  };
}

let sidSeq = 0;
function nextSid() {
  sidSeq += 1;
  return `sid-${sidSeq}-${Math.random().toString(16).slice(2)}`;
}

function makeRelay(overrides = {}) {
  return {
    async createPairingSession() {
      const expiresAtMs = Date.now() + 600000;
      return {
        pairingId: 'pr_route1234',
        originToken: 'route-origin-secret-token',
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        pollIntervalSeconds: 3,
        qrCode: { mimeType: 'image/png', base64: 'iVBORw0KGgoQRDATA' },
      };
    },
    async readPairingSessionStatus() {
      return { pairingId: 'pr_route1234', status: 'pending', expiresAtMs: Date.now() + 300000, remainingSeconds: 300 };
    },
    async cancelPairingSession() { return { ok: true }; },
    async confirmPairingSession() { return { ok: true }; },
    async rejectPairingSession() { return { ok: true }; },
    ...overrides,
  };
}

// Startet einen Testserver mit fake-Session-Middleware (Header x-test-session
// setzt die Admin-Session) und injiziertem Relay-Client.
async function startServer(relay, routeOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const sid = req.headers['x-test-session'];
    req.session = sid ? { id: String(sid) } : null;
    next();
  });
  const connectionStub = { getStatus: () => ({ state: 'idle' }), connect: () => ({ state: 'idle' }), disconnect: () => ({ state: 'idle' }) };
  app.use(remoteAccessRoutes({
    relayClient: relay,
    instanceName: 'homeESS',
    connectionService: connectionStub,
    backgroundRetry: false,
    ...routeOptions,
  }));
  const { server, port } = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('error', reject);
    s.once('listening', () => resolve({ server: s, port: s.address().port }));
  });
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('GET /remote-access ohne Session -> Redirect', async (t) => {
  const srv = await startServer(makeRelay());
  t.after(srv.close);
  const res = await fetch(`${srv.base}/remote-access`, { redirect: 'manual' });
  assert.ok(res.status === 302 || res.status === 303, `Redirect erwartet, war ${res.status}`);
});

test('GET /api/remote-access/pairing ohne Session -> 401 JSON', async (t) => {
  const srv = await startServer(makeRelay());
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/pairing`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
});

test('POST ohne CSRF-Header -> 403', async (t) => {
  const srv = await startServer(makeRelay());
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, {
    method: 'POST',
    headers: { 'x-test-session': nextSid() },
  });
  assert.equal(res.status, 403);
});

test('POST mit Session+CSRF -> 200, QR ohne Token, no-store', async (t) => {
  const sid = nextSid();
  const srv = await startServer(makeRelay());
  t.after(async () => { pairingState.removeForOwner(sid); await srv.close(); });
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, {
    method: 'POST',
    headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = await res.json();
  assert.equal(body.status, 'pending');
  assert.ok(body.qrCode && body.qrCode.base64);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('route-origin-secret-token'), 'kein Origin-Token in Browser-Antwort');
  assert.ok(!raw.toLowerCase().includes('authorization'), 'kein Authorization-Feld');
  assert.equal(body.pairingUri, undefined, 'keine pairingUri');
});

test('GET mit Session liefert pending ohne Token', async (t) => {
  const sid = nextSid();
  const srv = await startServer(makeRelay());
  t.after(async () => { pairingState.removeForOwner(sid); await srv.close(); });
  await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, { headers: { 'x-test-session': sid } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'pending');
  assert.ok(!JSON.stringify(body).includes('route-origin-secret-token'));
});

test('GET liefert awaiting_confirmation mit Claim-Daten, ohne QR oder Origin-Token', async (t) => {
  const sid = nextSid();
  const srv = await startServer(makeRelay({
    async readPairingSessionStatus() {
      return {
        pairingId: 'pr_route1234',
        status: 'awaiting_confirmation',
        expiresAtMs: Date.now() + 300000,
        remainingSeconds: 300,
        claim: { deviceName: '<Phone>', platform: 'android', appVersion: '1.0.0', claimedAt: new Date().toISOString() },
      };
    },
  }));
  t.after(async () => { pairingState.removeForOwner(sid); await srv.close(); });
  await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, { headers: { 'x-test-session': sid } });
  const body = await res.json();
  assert.equal(body.status, 'awaiting_confirmation');
  assert.equal(body.claim.deviceName, '<Phone>');
  assert.equal(body.qrCode, undefined);
  assert.ok(!JSON.stringify(body).includes('route-origin-secret-token'));
});

test('GET ohne aktive Session -> status none', async (t) => {
  const sid = nextSid();
  const srv = await startServer(makeRelay());
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, { headers: { 'x-test-session': sid } });
  const body = await res.json();
  assert.equal(body.status, 'none');
});

test('DELETE ohne CSRF -> 403; mit CSRF -> 204', async (t) => {
  const sid = nextSid();
  const srv = await startServer(makeRelay());
  t.after(async () => { pairingState.removeForOwner(sid); await srv.close(); });
  await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });

  const noCsrf = await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'DELETE', headers: { 'x-test-session': sid } });
  assert.equal(noCsrf.status, 403);

  const ok = await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'DELETE', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  assert.equal(ok.status, 204);
});

test('Reject verlangt CSRF und liefert 204 aus awaiting_confirmation', async (t) => {
  const sid = nextSid();
  const srv = await startServer(pairedRelay(), { identityStore: fakeIdentityStore() });
  t.after(async () => { pairingState.removeForOwner(sid); await srv.close(); });
  await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  await fetch(`${srv.base}/api/remote-access/pairing`, { headers: { 'x-test-session': sid } });
  const noCsrf = await fetch(`${srv.base}/api/remote-access/pairing/reject`, { method: 'POST', headers: { 'x-test-session': sid } });
  assert.equal(noCsrf.status, 403);
  const ok = await fetch(`${srv.base}/api/remote-access/pairing/reject`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  assert.equal(ok.status, 204);
});

test('Confirm orchestriert Provisioning und liefert paired-View ohne Secrets', async (t) => {
  const sid = nextSid();
  const srv = await startServer(pairedRelay(), { identityStore: fakeIdentityStore() });
  t.after(async () => { pairingState.removeForOwner(sid); await srv.close(); });
  await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  await fetch(`${srv.base}/api/remote-access/pairing`, { headers: { 'x-test-session': sid } });

  const noCsrf = await fetch(`${srv.base}/api/remote-access/pairing/confirm`, { method: 'POST', headers: { 'x-test-session': sid } });
  assert.equal(noCsrf.status, 403);

  const res = await fetch(`${srv.base}/api/remote-access/pairing/confirm`, { method: 'POST', headers: { 'x-test-session': sid, 'X-HomeESS-Request': '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.status, 'paired');
  assert.equal(body.device.deviceIdShort.startsWith('dev_route'), true);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('route-origin-secret-token'), 'kein Origin-Token');
  assert.ok(!raw.includes('cHJvb2Y'), 'kein Proof im Browser-View');
  assert.ok(!raw.includes('pr_route1234'), 'keine Pairing-ID im Browser-View');
});

test('GET /api/remote-access/connection liefert Status ohne Secrets', async (t) => {
  const srv = await startServer(pairedRelay(), { identityStore: fakeIdentityStore() });
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/connection`, { headers: { 'x-test-session': nextSid() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, 'idle');
});

test('Rate-Limit-Fehler wird als 429 + interner Code übersetzt', async (t) => {
  const relay = makeRelay({
    async createPairingSession() { const e = new Error('rl'); e.code = 'remote_access_rate_limited'; throw e; },
  });
  const srv = await startServer(relay);
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': nextSid(), 'X-HomeESS-Request': '1' } });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'remote_access_rate_limited');
});

test('Relay nicht erreichbar -> 502 + interner Code', async (t) => {
  const relay = makeRelay({
    async createPairingSession() { const e = new Error('down'); e.code = 'remote_access_relay_unavailable'; throw e; },
  });
  const srv = await startServer(relay);
  t.after(srv.close);
  const res = await fetch(`${srv.base}/api/remote-access/pairing`, { method: 'POST', headers: { 'x-test-session': nextSid(), 'X-HomeESS-Request': '1' } });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'remote_access_relay_unavailable');
});
