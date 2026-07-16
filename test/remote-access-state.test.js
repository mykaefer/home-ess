'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pairingState = require('../src/remote-access/pairing-state');
const { RemoteAccessError } = require('../src/remote-access/errors');

let ownerSeq = 0;
function nextOwner() {
  ownerSeq += 1;
  return `owner-${ownerSeq}-${Math.random().toString(16).slice(2)}`;
}

const DEVICE_FP = '1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90';

// Fake-Identity-Store ohne Dateizugriff/echtes Schlüsselmaterial.
function makeIdentityStore(opts = {}) {
  return {
    async signInstancePairingProof() {
      if (opts.signError) throw opts.signError;
      return { proof: 'cHJvb2Y=', publicKeySpkiBase64: 'MCowBQYDK2VwAyEApe4=', instanceFingerprintHex: 'a'.repeat(64) };
    },
    async storeProvisionedIdentity(input) {
      if (opts.storeError) throw opts.storeError;
      return { instanceId: input.instanceId, pairedAt: input.pairedAt || new Date().toISOString(), devices: [] };
    },
    async getProvisionedIdentity() { return opts.provisioned || null; },
  };
}

// Optionen für confirm/provision inkl. fake identityStore und ohne
// Hintergrund-Retry (deterministische Tests).
function provisionOpts(idOpts = {}) {
  return { identityStore: makeIdentityStore(idOpts), backgroundRetry: false, relayBaseUrl: 'https://relay.example', protocolVersion: '0.1' };
}

// Fake-Relay-Client. Zählt Aufrufe und liefert konfigurierbare Antworten.
function makeRelay(opts = {}) {
  const calls = { create: 0, status: 0, cancel: 0, confirm: 0, reject: 0, provision: 0 };
  return {
    calls,
    async createPairingSession() {
      calls.create += 1;
      const expiresAtMs = Date.now() + (opts.ttlMs || 600000);
      return {
        pairingId: opts.pairingId || 'pr_test1234',
        originToken: 'origin-secret-abc',
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        pollIntervalSeconds: opts.poll || 3,
        qrCode: { mimeType: 'image/png', base64: 'iVBORw0KGgoQRDATA' },
      };
    },
    async readPairingSessionStatus() {
      calls.status += 1;
      if (opts.statusError) throw opts.statusError;
      const s = opts.remoteStatus || 'pending';
      const base = {
        pairingId: opts.pairingId || 'pr_test1234',
        status: s,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        expiresAtMs: Date.now() + 300000,
        remainingSeconds: s === 'pending' ? 300 : 0,
        claim: s === 'awaiting_confirmation'
          ? { deviceName: 'Android-Smartphone', platform: 'android', appVersion: '1.0.0', claimedAt: new Date().toISOString(), deviceFingerprint: DEVICE_FP }
          : null,
        identity: null,
      };
      if (s === 'paired') {
        base.identity = {
          instanceId: 'ins_test1234', deviceId: 'dev_test1234', instanceName: 'homeESS',
          instanceFingerprint: 'a'.repeat(64), deviceFingerprint: DEVICE_FP,
        };
      }
      return base;
    },
    async cancelPairingSession() {
      calls.cancel += 1;
      if (opts.cancelError) throw opts.cancelError;
      return { ok: true };
    },
    async confirmPairingSession() {
      calls.confirm += 1;
      if (opts.confirmError) throw opts.confirmError;
      return { ok: true };
    },
    async rejectPairingSession() {
      calls.reject += 1;
      if (opts.rejectError) throw opts.rejectError;
      return { ok: true };
    },
    async provisionPairingSession() {
      calls.provision += 1;
      if (opts.provisionError) throw opts.provisionError;
      return {
        pairingId: opts.pairingId || 'pr_test1234', status: 'paired',
        instance: { instanceId: 'ins_test1234', name: 'homeESS', algorithm: 'Ed25519', fingerprint: 'a'.repeat(64) },
        device: { deviceId: 'dev_test1234', name: 'Android-Smartphone', platform: 'android', algorithm: 'Ed25519', fingerprint: DEVICE_FP },
        pairedAt: new Date().toISOString(),
      };
    },
  };
}

test('create: legt In-Memory-Session an, Browser-View ohne Token/URI/pairingId', async () => {
  const owner = nextOwner();
  const relay = makeRelay();
  const view = await pairingState.create(owner, relay, 'homeESS');
  assert.equal(view.status, 'pending');
  assert.ok(view.qrCode && view.qrCode.base64, 'QR-Code enthalten');
  const json = JSON.stringify(view);
  assert.ok(!json.includes('origin-secret-abc'), 'kein Origin-Token im Browser-View');
  assert.ok(!json.includes('pairingUri'), 'keine pairingUri im Browser-View');
  assert.ok(!json.includes('pairingId'), 'keine pairingId im Browser-View');
  pairingState.removeForOwner(owner);
});

test('create: Doppel-POST erzeugt keine zweite Relay-Session', async () => {
  const owner = nextOwner();
  const relay = makeRelay();
  const [a, b] = await Promise.all([
    pairingState.create(owner, relay, 'homeESS'),
    pairingState.create(owner, relay, 'homeESS'),
  ]);
  assert.equal(relay.calls.create, 1, 'nur eine Relay-Erstellung');
  assert.equal(a.status, 'pending');
  assert.equal(b.status, 'pending');
  pairingState.removeForOwner(owner);
});

test('poll: pending bleibt pending; QR wird bei GET nicht erneut ausgegeben', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'pending' });
  await pairingState.create(owner, relay, 'homeESS');
  const view = await pairingState.poll(owner, relay);
  assert.equal(view.status, 'pending');
  assert.equal(view.qrCode, undefined, 'GET liefert kein QR-Bild');
  assert.ok(view.remainingSeconds > 0);
  pairingState.removeForOwner(owner);
});

test('poll: Relay meldet cancelled -> lokal cancelled, Token entfernt', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'cancelled' });
  await pairingState.create(owner, relay, 'homeESS');
  const view = await pairingState.poll(owner, relay);
  assert.equal(view.status, 'cancelled');
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.originToken, null, 'Origin-Token aus Speicher entfernt');
  assert.equal(entry.qrBase64, null, 'QR aus Speicher entfernt');
  pairingState.removeForOwner(owner);
});

test('poll: Relay meldet awaiting_confirmation -> Claim sichtbar, QR entfernt, Origin-Token bleibt serverseitig', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'awaiting_confirmation' });
  await pairingState.create(owner, relay, 'homeESS');
  const view = await pairingState.poll(owner, relay);
  assert.equal(view.status, 'awaiting_confirmation');
  assert.equal(view.qrCode, undefined, 'GET liefert kein QR-Bild');
  assert.equal(view.claim.deviceName, 'Android-Smartphone');
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.qrBase64, null, 'QR aus Speicher entfernt');
  assert.equal(entry.originToken, 'origin-secret-abc', 'Origin-Token bleibt bis terminalem Zustand');
  assert.ok(!JSON.stringify(view).includes('origin-secret-abc'), 'Origin-Token nicht im Browser-View');
  pairingState.removeForOwner(owner);
});

test('poll: Relay meldet session_not_found -> expired und bereinigt', async () => {
  const owner = nextOwner();
  const err = new Error('gone'); err.code = 'remote_access_session_not_found';
  const relay = makeRelay({ statusError: err });
  await pairingState.create(owner, relay, 'homeESS');
  const view = await pairingState.poll(owner, relay);
  assert.equal(view.status, 'expired');
  pairingState.removeForOwner(owner);
});

test('poll: Relay nicht erreichbar -> pending bleibt erhalten', async () => {
  const owner = nextOwner();
  const err = new Error('down'); err.code = 'remote_access_relay_unavailable';
  const relay = makeRelay({ statusError: err });
  await pairingState.create(owner, relay, 'homeESS');
  const view = await pairingState.poll(owner, relay);
  assert.equal(view.status, 'pending', 'transiente Störung kippt den Zustand nicht');
  pairingState.removeForOwner(owner);
});

test('Ablauf wird erkannt: pending kippt nach expiresAt auf expired', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ ttlMs: 20 });
  await pairingState.create(owner, relay, 'homeESS');
  await new Promise((r) => setTimeout(r, 40));
  // poll ohne Relay-Kontakt (sweepEntry erkennt Ablauf vorab)
  const view = await pairingState.poll(owner, relay);
  assert.equal(view.status, 'expired');
  assert.equal(relay.calls.status, 0, 'kein Relay-Aufruf bei bereits abgelaufener Session');
  pairingState.removeForOwner(owner);
});

test('cancel: ruft Relay-Abbruch, bereinigt lokal, ist idempotent bei Relay-Fehler', async () => {
  const owner = nextOwner();
  const err = new Error('boom'); err.code = 'remote_access_relay_unavailable';
  const relay = makeRelay({ cancelError: err });
  await pairingState.create(owner, relay, 'homeESS');
  const view = await pairingState.cancel(owner, relay);
  assert.equal(view.status, 'cancelled');
  assert.equal(relay.calls.cancel, 1);
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.originToken, null, 'Origin-Token trotz Relay-Fehler entfernt');
  pairingState.removeForOwner(owner);
});

test('confirm: bestätigt mit Proof, provisioniert unmittelbar zu paired, Origin-Token entfernt', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'awaiting_confirmation' });
  await pairingState.create(owner, relay, 'homeESS');
  await pairingState.poll(owner, relay);
  const view = await pairingState.confirm(owner, relay, provisionOpts());
  assert.equal(view.status, 'paired');
  assert.equal(relay.calls.confirm, 1);
  assert.equal(relay.calls.provision, 1);
  assert.equal(view.device.deviceIdShort.startsWith('dev_test'), true);
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.originToken, null, 'Origin-Token nach paired entfernt');
  assert.equal(entry.qrBase64, null);
  assert.equal(entry.deviceFingerprint, null, 'Gerätefingerprint nach paired bereinigt');
  // Idempotenz: erneuter Confirm bei paired ändert nichts.
  const again = await pairingState.confirm(owner, relay, provisionOpts());
  assert.equal(again.status, 'paired');
  assert.equal(relay.calls.confirm, 1, 'kein zweiter Confirm');
  pairingState.removeForOwner(owner);
});

test('confirm: transienter Provisioning-Fehler hält confirmed, Origin-Token bleibt, Retry provisioniert', async () => {
  const owner = nextOwner();
  const provErr = new Error('down'); provErr.code = 'remote_access_relay_unavailable';
  const relay = makeRelay({ remoteStatus: 'awaiting_confirmation', provisionError: provErr });
  await pairingState.create(owner, relay, 'homeESS');
  await pairingState.poll(owner, relay);
  const view = await pairingState.confirm(owner, relay, provisionOpts());
  assert.equal(view.status, 'confirmed', 'bleibt confirmed bei Provisioning-Fehler');
  assert.equal(view.provisioningError, 'remote_access_provisioning_failed');
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.originToken, 'origin-secret-abc', 'Origin-Token bleibt bis paired erhalten');
  // Relay wird gesund -> manueller Provision-Retry führt zu paired.
  relay.calls.provision = 0;
  delete relay._noop;
  const healthy = makeRelay({ remoteStatus: 'awaiting_confirmation' });
  const view2 = await pairingState.provision(owner, healthy, provisionOpts());
  assert.equal(view2.status, 'paired');
  pairingState.removeForOwner(owner);
});

test('confirm: Fingerprint-Mismatch verwirft Provisioning, Origin-Token bleibt (Reconciliation möglich)', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'awaiting_confirmation' });
  await pairingState.create(owner, relay, 'homeESS');
  await pairingState.poll(owner, relay);
  const mismatchErr = new RemoteAccessError('remote_access_identity_mismatch', 'mismatch');
  await assert.rejects(
    () => pairingState.confirm(owner, relay, provisionOpts({ storeError: mismatchErr })),
    (err) => err.code === 'remote_access_identity_mismatch'
  );
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.status, 'confirmed', 'kein paired bei Mismatch');
  assert.equal(entry.originToken, 'origin-secret-abc', 'Origin-Token nicht gescrubbt');
  pairingState.removeForOwner(owner);
});

test('provision: bereits provisioniert -> Reconciliation übernimmt Identität aus paired-Status', async () => {
  const owner = nextOwner();
  const conflictErr = new Error('conflict'); conflictErr.code = 'remote_access_session_conflict';
  // Provision wirft Konflikt, Status meldet paired -> Reconciliation.
  const relay = makeRelay({ remoteStatus: 'paired', provisionError: conflictErr });
  await pairingState.create(owner, relay, 'homeESS');
  // Session in confirmed bringen: awaiting -> confirm (mit gesundem confirm, aber
  // provision-Konflikt).
  const entry = pairingState._internal.sessions.get(owner);
  entry.status = 'awaiting_confirmation';
  entry.claim = { deviceName: 'Android-Smartphone', platform: 'android', appVersion: '1.0.0', claimedAt: new Date().toISOString(), deviceFingerprint: DEVICE_FP };
  entry.deviceFingerprint = DEVICE_FP;
  const view = await pairingState.confirm(owner, relay, provisionOpts());
  assert.equal(view.status, 'paired', 'Reconciliation aus paired-Status');
  pairingState.removeForOwner(owner);
});

test('reject: nur aus awaiting_confirmation, danach rejected und Secrets entfernt', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'awaiting_confirmation' });
  await pairingState.create(owner, relay, 'homeESS');
  await pairingState.poll(owner, relay);
  const view = await pairingState.reject(owner, relay);
  assert.equal(view.status, 'rejected');
  assert.equal(relay.calls.reject, 1);
  const entry = pairingState._internal.sessions.get(owner);
  assert.equal(entry.originToken, null);
  pairingState.removeForOwner(owner);
});

test('confirm aus pending wird stabil als Konflikt abgelehnt', async () => {
  const owner = nextOwner();
  const relay = makeRelay({ remoteStatus: 'pending' });
  await pairingState.create(owner, relay, 'homeESS');
  await assert.rejects(() => pairingState.confirm(owner, relay), (err) => err.code === 'remote_access_session_conflict');
  pairingState.removeForOwner(owner);
});

test('cancel ohne Session -> none', async () => {
  const owner = nextOwner();
  const relay = makeRelay();
  const view = await pairingState.cancel(owner, relay);
  assert.equal(view.status, 'none');
});

test('POST/DELETE-Race wird serialisiert (kein Fehler, konsistenter Endzustand)', async () => {
  const owner = nextOwner();
  const relay = makeRelay();
  const [, cancelView] = await Promise.all([
    pairingState.create(owner, relay, 'homeESS'),
    pairingState.cancel(owner, relay),
  ]);
  // Beide Operationen liefen ohne Ausnahme; die Endzustand-Abfrage ist eindeutig.
  const finalView = await pairingState.poll(owner, relay);
  assert.ok(['pending', 'cancelled'].includes(finalView.status));
  assert.ok(cancelView.status === 'cancelled' || cancelView.status === 'none');
  pairingState.removeForOwner(owner);
});

test('removeForOwner entfernt Session und Geheimnisse', async () => {
  const owner = nextOwner();
  const relay = makeRelay();
  await pairingState.create(owner, relay, 'homeESS');
  pairingState.removeForOwner(owner);
  assert.equal(pairingState._internal.sessions.get(owner), undefined);
});

test('shutdown leert alle Sessions', async () => {
  const owner = nextOwner();
  const relay = makeRelay();
  await pairingState.create(owner, relay, 'homeESS');
  pairingState.shutdown();
  assert.equal(pairingState._internal.sessions.size, 0);
});
