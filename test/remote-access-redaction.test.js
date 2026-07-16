'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redact } = require('../src/remote-access/redact');
const pairingState = require('../src/remote-access/pairing-state');

test('redact entfernt Token, URI, QR-Base64 und Authorization', () => {
  const input = {
    pairingId: 'pr_ok',
    pairingToken: 'super-secret',
    claimToken: 'claim-secret',
    originToken: 'origin-secret',
    claimantToken: 'claimant-secret',
    pairingUri: 'homeess://pair?token=super-secret',
    authorization: 'Pairing-Origin origin-secret',
    qrCode: { base64: 'iVBORw0KGgo' },
    status: 'pending',
  };
  const out = redact(input);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('super-secret'), 'kein altes Token/URI/Authorization im Ergebnis');
  assert.ok(!json.includes('claim-secret'), 'kein Claim-Token im Ergebnis');
  assert.ok(!json.includes('origin-secret'), 'kein Origin-Token im Ergebnis');
  assert.ok(!json.includes('claimant-secret'), 'kein Claimant-Token im Ergebnis');
  assert.ok(!json.includes('iVBORw0KGgo'), 'kein QR-Base64 im Ergebnis');
  assert.equal(out.pairingId, 'pr_ok', 'öffentliche ID bleibt erhalten');
  assert.equal(out.status, 'pending', 'Status bleibt erhalten');
});

test('redact behandelt Data-URLs und übergroße Strings', () => {
  const out = redact({ img: 'data:image/png;base64,AAAABBBB', big: 'x'.repeat(500) });
  assert.equal(out.img, '[redigiert]');
  assert.ok(out.big.length < 500);
});

// Sicherstellen, dass die geloggten Ereignisse keine Geheimnisse enthalten:
// wir fangen console.log ab und erzeugen echte Pairing-Ereignisse.
test('Logs enthalten keine Secrets bei realen Pairing-Ereignissen', async () => {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const owner = `redact-owner-${Math.random().toString(16).slice(2)}`;
    const relay = {
      async createPairingSession() {
        const expiresAtMs = Date.now() + 600000;
        return {
          pairingId: 'pr_logtest',
          originToken: 'LOG-ORIGIN-TOKEN',
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
          pollIntervalSeconds: 3,
          qrCode: { mimeType: 'image/png', base64: 'iVBORw0KGgoSECRETQR' },
        };
      },
      async cancelPairingSession() { return { ok: true }; },
      async readPairingSessionStatus() { return { pairingId: 'pr_logtest', status: 'pending', remainingSeconds: 300 }; },
    };
    await pairingState.create(owner, relay, 'homeESS');
    await pairingState.cancel(owner, relay);
    pairingState.removeForOwner(owner);
  } finally {
    console.log = original;
  }
  const all = lines.join('\n');
  assert.ok(all.includes('[remote-access]'), 'Ereignisse wurden geloggt');
  assert.ok(!all.includes('LOG-ORIGIN-TOKEN'), 'kein Origin-Token im Log');
  assert.ok(!all.includes('iVBORw0KGgoSECRETQR'), 'kein QR-Base64 im Log');
  assert.ok(!all.includes('homeess://pair'), 'keine Pairing-URI im Log');
});
