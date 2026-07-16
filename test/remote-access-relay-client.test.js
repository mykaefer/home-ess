'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRelayClient } = require('../src/remote-access/relay-client');

const BASE = 'https://relay.example.net';
const CLAIM_TOKEN = 'claimtoken1234567890';
const ORIGIN_TOKEN = 'origintoken1234567890';
const PAIRING_ID = 'pr_abcd1234';

// Minimales gültiges PNG (nur Signatur + etwas Füllung) als Base64.
function validPngBase64() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, Buffer.from('homeess-qr-demo')]).toString('base64');
}

function validPairingUri() {
  return `homeess://pair?v=1&relay=${encodeURIComponent(BASE)}&id=${PAIRING_ID}&token=${CLAIM_TOKEN}`;
}

function validCreateBody(overrides = {}) {
  return {
    pairingId: PAIRING_ID,
    claimToken: CLAIM_TOKEN,
    originToken: ORIGIN_TOKEN,
    pairingUri: validPairingUri(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    pollIntervalSeconds: 3,
    qrCode: { mimeType: 'image/png', base64: validPngBase64() },
    ...overrides,
  };
}

// Baut eine Response-artige Antwort für den injizierten fetch.
function fakeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text, 'utf8');
  const hdr = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (name) => (hdr.has(name.toLowerCase()) ? hdr.get(name.toLowerCase()) : null) },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

// Fetch-Fake: zeichnet den letzten Aufruf auf und liefert eine vorgegebene Antwort.
function fetchWith(responder) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const res = responder(url, options, calls.length - 1);
    if (res instanceof Error) throw res;
    return res;
  };
  return { impl, calls };
}

test('createPairingSession: korrekter POST, richtiger Body, KEIN Authorization-Header', async () => {
  const { impl, calls } = fetchWith(() => fakeResponse(201, validCreateBody()));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  const result = await client.createPairingSession({ instanceName: 'Keller' });

  const call = calls[0];
  assert.equal(call.url, `${BASE}/api/v1/pairing/sessions`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.redirect, 'error');
  assert.ok(call.options.signal, 'AbortController-Signal wird gesetzt');
  assert.equal(call.options.headers.Authorization, undefined, 'kein Authorization beim Erstellen');
  const sent = JSON.parse(call.options.body);
  assert.equal(sent.protocolVersion, '0.1');
  assert.equal(sent.instanceName, 'Keller');
  assert.equal(result.pairingId, PAIRING_ID);
  assert.equal(result.originToken, ORIGIN_TOKEN);
  assert.equal(result.qrCode.mimeType, 'image/png');
});

test('readPairingSessionStatus: GET mit Pairing-Origin-Authorization', async () => {
  const body = { pairingId: PAIRING_ID, status: 'pending', expiresAt: new Date(Date.now() + 300000).toISOString(), remainingSeconds: 300 };
  const { impl, calls } = fetchWith(() => fakeResponse(200, body));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  const result = await client.readPairingSessionStatus({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN });

  assert.equal(calls[0].url, `${BASE}/api/v1/pairing/sessions/${PAIRING_ID}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, `Pairing-Origin ${ORIGIN_TOKEN}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(result.status, 'pending');
  assert.equal(result.remainingSeconds, 300);
});

test('cancelPairingSession: DELETE mit Pairing-Origin-Authorization, 204 = Erfolg', async () => {
  const { impl, calls } = fetchWith(() => fakeResponse(204, ''));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  const result = await client.cancelPairingSession({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN });
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.headers.Authorization, `Pairing-Origin ${ORIGIN_TOKEN}`);
  assert.deepEqual(result, { ok: true });
});

test('cancelPairingSession: 404 wird als session_not_found gemeldet', async () => {
  const { impl } = fetchWith(() => fakeResponse(404, { code: 'pairing_session_not_found' }));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.cancelPairingSession({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN }), (err) => err.code === 'remote_access_session_not_found');
});

test('confirmPairingSession sendet Instanz-Proof-Body, rejectPairingSession bleibt bodylos; beide erwarten 204', async () => {
  const { impl, calls } = fetchWith(() => fakeResponse(204, ''));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await client.confirmPairingSession({
    pairingId: PAIRING_ID,
    originToken: ORIGIN_TOKEN,
    instanceName: 'homeESS Zuhause',
    instanceIdentity: { publicKey: 'MCowBQYDK2VwAyEApe4=', proof: 'c2ln' },
  });
  await client.rejectPairingSession({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN });
  assert.equal(calls[0].url, `${BASE}/api/v1/pairing/sessions/${PAIRING_ID}/confirm`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, `Pairing-Origin ${ORIGIN_TOKEN}`);
  const confirmBody = JSON.parse(calls[0].options.body);
  assert.equal(confirmBody.instanceIdentity.algorithm, 'Ed25519');
  assert.equal(confirmBody.instanceIdentity.proof, 'c2ln');
  assert.ok(confirmBody.instanceIdentity.publicKey, 'Public Key im Confirm-Body');
  assert.equal(calls[1].url, `${BASE}/api/v1/pairing/sessions/${PAIRING_ID}/reject`);
});

test('confirmPairingSession ohne Instanz-Proof scheitert lokal (kein Relay-Aufruf)', async () => {
  const { impl, calls } = fetchWith(() => fakeResponse(204, ''));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(
    () => client.confirmPairingSession({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN }),
    (err) => err.code === 'remote_access_identity_proof_failed'
  );
  assert.equal(calls.length, 0, 'kein Relay-Aufruf ohne Proof');
});

test('provisionPairingSession: POST /provision, validiert paired-Antwort', async () => {
  const body = {
    pairingId: PAIRING_ID,
    status: 'paired',
    instance: { instanceId: 'ins_abc12345', name: 'homeESS Zuhause', algorithm: 'Ed25519', fingerprint: 'ABCD-EF12-3456-7890' },
    device: { deviceId: 'dev_abc12345', name: 'Android-Smartphone', platform: 'android', algorithm: 'Ed25519', fingerprint: '1234-ABCD-5678-90EF' },
    pairedAt: new Date().toISOString(),
  };
  const { impl, calls } = fetchWith(() => fakeResponse(200, body));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  const res = await client.provisionPairingSession({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN });
  assert.equal(calls[0].url, `${BASE}/api/v1/pairing/sessions/${PAIRING_ID}/provision`);
  assert.equal(calls[0].options.headers.Authorization, `Pairing-Origin ${ORIGIN_TOKEN}`);
  assert.equal(res.status, 'paired');
  assert.equal(res.instance.instanceId, 'ins_abc12345');
  assert.equal(res.device.deviceId, 'dev_abc12345');
});

test('getCapabilities: liest bool-Fähigkeiten', async () => {
  const { impl } = fetchWith(() => fakeResponse(200, { pairingIdentityProvisioning: true, identityAuthentication: true, relay: false }));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  const caps = await client.getCapabilities();
  assert.equal(caps.pairingIdentityProvisioning, true);
  assert.equal(caps.identityAuthentication, true);
  assert.equal(caps.relay, false);
});

test('createPairingSession: Netzwerk-/Timeoutfehler -> relay_unavailable', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const { impl } = fetchWith(() => abort);
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({ instanceName: 'x' }), (err) => {
    assert.equal(err.code, 'remote_access_relay_unavailable');
    return true;
  });
});

test('createPairingSession: ungültiges JSON -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, 'nope{'));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: falscher HTTP-Status -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(200, validCreateBody()));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: zu große Antwort (content-length) -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody(), { 'content-length': String(5 * 1024 * 1024) }));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: ungültiges Base64 -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody({ qrCode: { mimeType: 'image/png', base64: 'not*base64*' } })));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: falsche PNG-Signatur -> invalid_response', async () => {
  const notPng = Buffer.from('JPEGdata-not-a-png').toString('base64');
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody({ qrCode: { mimeType: 'image/png', base64: notPng } })));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: falscher MIME-Type -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody({ qrCode: { mimeType: 'image/jpeg', base64: validPngBase64() } })));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: expiresAt in der Vergangenheit -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody({ expiresAt: new Date(Date.now() - 1000).toISOString() })));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: pollIntervalSeconds außerhalb des Bereichs -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody({ pollIntervalSeconds: 999 })));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: veraltetes pairingToken oder Origin-Token in URI -> invalid_response', async () => {
  const clientA = createRelayClient({
    baseUrl: BASE,
    fetchImpl: fetchWith(() => fakeResponse(201, validCreateBody({ pairingToken: 'old-secret' }))).impl,
  });
  await assert.rejects(() => clientA.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');

  const clientB = createRelayClient({
    baseUrl: BASE,
    fetchImpl: fetchWith(() => fakeResponse(201, validCreateBody({
      pairingUri: `homeess://pair?v=1&relay=x&id=${PAIRING_ID}&token=${ORIGIN_TOKEN}`,
    }))).impl,
  });
  await assert.rejects(() => clientB.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('createPairingSession: manipulierte pairingUri (fremdes Schema) -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(201, validCreateBody({ pairingUri: 'https://evil.example/pair?v=1&id=' + PAIRING_ID + '&token=x' })));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.createPairingSession({}), (err) => err.code === 'remote_access_invalid_response');
});

test('readPairingSessionStatus: unbekannter Status -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(200, { pairingId: PAIRING_ID, status: 'claimed' }));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.readPairingSessionStatus({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN }), (err) => err.code === 'remote_access_invalid_response');
});

test('readPairingSessionStatus: awaiting_confirmation mit streng validierten Claim-Daten', async () => {
  const claimedAt = new Date().toISOString();
  const { impl } = fetchWith(() => fakeResponse(200, {
    pairingId: PAIRING_ID,
    status: 'awaiting_confirmation',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    remainingSeconds: 300,
    claim: {
      deviceName: 'Android-Smartphone', platform: 'android', appVersion: '1.0.0', claimedAt,
      deviceIdentity: { algorithm: 'Ed25519', fingerprint: '1234-ABCD-5678-90EF' },
    },
  }));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  const result = await client.readPairingSessionStatus({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN });
  assert.equal(result.status, 'awaiting_confirmation');
  assert.equal(result.claim.deviceName, 'Android-Smartphone');
  assert.equal(result.claim.deviceFingerprint, '1234-ABCD-5678-90EF');
});

test('readPairingSessionStatus: Claim-Daten mit Secret-Feld -> invalid_response', async () => {
  const { impl } = fetchWith(() => fakeResponse(200, {
    pairingId: PAIRING_ID,
    status: 'awaiting_confirmation',
    claim: {
      deviceName: 'Android-Smartphone',
      platform: 'android',
      appVersion: '1.0.0',
      claimedAt: new Date().toISOString(),
      claimantToken: 'secret',
    },
  }));
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.readPairingSessionStatus({ pairingId: PAIRING_ID, originToken: ORIGIN_TOKEN }), (err) => err.code === 'remote_access_invalid_response');
});

test('Relay-Fehlercodes werden auf interne Codes abgebildet', async () => {
  const cases = [
    ['rate_limit_exceeded', 429, 'remote_access_rate_limited'],
    ['too_many_active_pairing_sessions', 429, 'remote_access_capacity_reached'],
    ['pairing_session_not_found', 404, 'remote_access_session_not_found'],
    ['pairing_session_conflict', 409, 'remote_access_session_conflict'],
    ['pairing_session_expired', 409, 'remote_access_session_expired'],
    ['internal_error', 500, 'remote_access_relay_unavailable'],
  ];
  for (const [relayCode, httpStatus, internal] of cases) {
    const { impl } = fetchWith(() => fakeResponse(httpStatus, { code: relayCode }));
    const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
    await assert.rejects(() => client.createPairingSession({}), (err) => {
      assert.equal(err.code, internal, `${relayCode} -> ${internal}`);
      return true;
    });
  }
});

test('Fehler enthalten keine Secrets (Token/URI) in der Meldung', async () => {
  const abort = new Error(`aborted with ${ORIGIN_TOKEN}`);
  abort.name = 'AbortError';
  const { impl } = fetchWith(() => abort);
  const client = createRelayClient({ baseUrl: BASE, fetchImpl: impl });
  try {
    await client.createPairingSession({});
    assert.fail('sollte werfen');
  } catch (err) {
    assert.ok(!String(err.message).includes(ORIGIN_TOKEN), 'Token nicht in Fehlermeldung');
  }
});

test('createRelayClient: nicht-HTTPS-Basis-URL wird abgelehnt', () => {
  assert.throws(() => createRelayClient({ baseUrl: 'http://relay.example.net' }), (err) => err.code === 'remote_access_internal_error');
});
