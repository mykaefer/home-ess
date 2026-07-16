'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redact } = require('../src/remote-access/redact');

test('redact entfernt Identitäts-/Auth-Secrets (Private Key, Signatur, Proof, Nonce, Challenge)', () => {
  const input = {
    privateKey: 'MC4CAQAwBQYDK2VwBCIEI...',
    instancePrivateKey: 'geheim',
    devicePrivateKey: 'geheim',
    signature: 'BASE64SIG==',
    proof: 'BASE64PROOF==',
    nonce: 'AAECAwQFBgc',
    challenge: { challengeId: 'ch_x', nonce: 'secret' },
    publicKey: 'MCowBQYDK2VwAyEA...',
    authorization: 'Pairing-Origin abc',
    fingerprint: 'ABCD-EF12',
    status: 'paired',
  };
  const out = redact(input);
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes('MC4CAQAwBQYDK2VwBCIE'), 'kein Private Key');
  assert.ok(!raw.includes('BASE64SIG'), 'keine Signatur');
  assert.ok(!raw.includes('BASE64PROOF'), 'kein Proof');
  assert.ok(!raw.includes('AAECAwQFBgc'), 'keine Nonce');
  assert.ok(!raw.includes('MCowBQYDK2VwAyEA'), 'kein voller Public Key');
  assert.ok(!raw.includes('Pairing-Origin abc'), 'kein Authorization');
  // Fingerprint (kein Geheimnis) und Status bleiben lesbar.
  assert.equal(out.fingerprint, 'ABCD-EF12');
  assert.equal(out.status, 'paired');
});

test('redact greift auch für verschachtelte Challenge-Nonce', () => {
  const out = redact({ msg: { type: 'challenge', nonce: 'topsecretnonce' } });
  assert.ok(!JSON.stringify(out).includes('topsecretnonce'));
});

test('Provisioning-/WebSocket-Ereignislogs enthalten keine Secrets', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const { log } = require('../src/remote-access/redact');
    log('Instanz-Proof erzeugt', { pairingId: 'pr_x', signature: 'SECRETSIG', proof: 'SECRETPROOF', originToken: 'SECRETTOKEN' });
    log('WebSocket authentifiziert', { nonce: 'SECRETNONCE', privateKey: 'SECRETKEY' });
  } finally {
    console.log = orig;
  }
  const joined = logs.join('\n');
  for (const secret of ['SECRETSIG', 'SECRETPROOF', 'SECRETTOKEN', 'SECRETNONCE', 'SECRETKEY']) {
    assert.ok(!joined.includes(secret), `Secret ${secret} nicht im Log`);
  }
});
