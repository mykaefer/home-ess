'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const ic = require('../src/remote-access/identity-crypto');

// Fest verdrahtetes Ed25519-Testschlüsselpaar aus HOMEESS_TRANSPORT_API.md
// Abschnitt 38 — ausschließlich für Tests, niemals produktiv.
const TEST_PUB_SPKI_B64 = 'MCowBQYDK2VwAyEApe4OEHRuvBb7SVPJrCwWiPY7Sua23A+aVRMe4n+AL58=';
const TEST_PRIV_PKCS8_B64 = 'MC4CAQAwBQYDK2VwBCIEIGaV2IQHxNv2/ytY/SFpaYXhZVSnR05mprmc0OzjYAbz';
const TEST_FP_HEX = 'a60895a8b707af6cb8f657d0095a4c25e03b943da64cb5df2ef630aa8ec48172';

function testPriv() {
  return crypto.createPrivateKey({ key: Buffer.from(TEST_PRIV_PKCS8_B64, 'base64'), format: 'der', type: 'pkcs8' });
}
function testPub() {
  return ic.importPublicKeyFromSpkiBase64(TEST_PUB_SPKI_B64);
}

test('Fingerprint: SHA-256 über kanonische SPKI-DER-Bytes reproduziert den Testvektor', () => {
  const pub = testPub();
  const hex = ic.fingerprintHexFromSpkiDer(ic.exportPublicSpkiDer(pub));
  assert.equal(hex, TEST_FP_HEX);
  assert.equal(ic.exportPublicSpkiBase64(pub), TEST_PUB_SPKI_B64);
});

test('Fingerprint-Anzeigeform ist gruppierte Großschrift; Hexform bleibt lowercase', () => {
  const display = ic.fingerprintDisplayFromHex(TEST_FP_HEX, { full: true });
  assert.match(display, /^[0-9A-F]{4}(-[0-9A-F]{4}){15}$/);
  assert.equal(display.replace(/-/g, '').toLowerCase(), TEST_FP_HEX);
  // Standard (gekürzt) sind 8 Gruppen.
  const short = ic.fingerprintDisplayFromHex(TEST_FP_HEX);
  assert.equal(short.split('-').length, 8);
});

test('normalizeFingerprintHex: entfernt Bindestriche, verlangt exakt 64 Hexzeichen', () => {
  const display = ic.fingerprintDisplayFromHex(TEST_FP_HEX, { full: true });
  assert.equal(ic.normalizeFingerprintHex(display), TEST_FP_HEX);
  assert.throws(() => ic.normalizeFingerprintHex('ABCD-EF'), /64/);
  assert.throws(() => ic.normalizeFingerprintHex('zz'.repeat(32)), /64/);
});

test('fingerprintMatchesHex: volle Gleichheit und Präfix (gekürzte Anzeige) passen, Fremdwert nicht', () => {
  assert.equal(ic.fingerprintMatchesHex(TEST_FP_HEX, TEST_FP_HEX), true);
  assert.equal(ic.fingerprintMatchesHex('A608-95A8-B707-AF6C', TEST_FP_HEX), true); // Präfix
  assert.equal(ic.fingerprintMatchesHex('DEAD-BEEF', TEST_FP_HEX), false);
  assert.equal(ic.fingerprintMatchesHex('nicht-hex!', TEST_FP_HEX), false);
});

test('Vektor 1 — Geräte-Pairing-Proof: kanonische Bytes und Signatur exakt', () => {
  // Kanonische Nutzlast (identisch zur App-Seite; hier direkt nachgebaut).
  const payload = [
    'homeess-device-pairing-proof-v1',
    'pairingId=pr_AAAAAAAAAAAAAAAAAAAAAA',
    'claimTokenHash=6a7baa5ec5a0cb1040d80c47f65faab6f1b3cbbadf281ffd6532cc10aace47dc',
    'publicKeyFingerprint=a60895a8b707af6cb8f657d0095a4c25e03b943da64cb5df2ef630aa8ec48172',
  ].join('\n');
  const sig = ic.signPayload(testPriv(), payload);
  assert.equal(sig, 'dQMXpYTWS2zAsZIAYUR0ohU6u5Sogk1zKNhP/GDrglhb//d9xkLL4jNtxRsWW1b+RguZ9HfryEtlSAhgSxWADg==');
  assert.equal(ic.verifyPayload(testPub(), payload, sig), true);
});

test('Vektor 2 — Instanz-Pairing-Proof: buildInstanceProofPayload reproduziert die Signatur', () => {
  const payload = ic.buildInstanceProofPayload({
    pairingId: 'pr_BBBBBBBBBBBBBBBBBBBBBB',
    originTokenHashHex: 'dc26e1d819202c1661cd7ce635e516a19d78760fdcef5565fed469e93252fee8',
    instanceFingerprintHex: TEST_FP_HEX,
    deviceFingerprintHex: TEST_FP_HEX,
  });
  // Exakte kanonische Bytes prüfen (LF, keine abschließende Leerzeile).
  assert.equal(payload, [
    'homeess-instance-pairing-proof-v1',
    'pairingId=pr_BBBBBBBBBBBBBBBBBBBBBB',
    'originTokenHash=dc26e1d819202c1661cd7ce635e516a19d78760fdcef5565fed469e93252fee8',
    'instancePublicKeyFingerprint=a60895a8b707af6cb8f657d0095a4c25e03b943da64cb5df2ef630aa8ec48172',
    'devicePublicKeyFingerprint=a60895a8b707af6cb8f657d0095a4c25e03b943da64cb5df2ef630aa8ec48172',
  ].join('\n'));
  assert.ok(!payload.endsWith('\n'), 'keine abschließende Leerzeile');
  const sig = ic.signPayload(testPriv(), payload);
  assert.equal(sig, '4HOOoBeF6cSfxq0QVLF9z844vEjYS3bkS3mpiXt8tFRiZEnR9LcpEOPoFAggRCARlK8FxMnPebMpXRacBZH3Cw==');
});

test('Vektor 3 — WebSocket-Challenge-Response: buildAuthPayload reproduziert die Signatur', () => {
  const payload = ic.buildAuthPayload({
    challengeId: 'ch_CCCCCCCCCCCCCCCCCCCCCC',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:00:15.000Z',
    protocolVersion: '0.1',
    clientType: 'app',
    identityId: 'dev_DDDDDDDDDDDDDDDDDDDDDD',
  });
  assert.equal(payload.split('\n')[0], 'homeess-auth-v1');
  assert.ok(!payload.endsWith('\n'));
  const sig = ic.signPayload(testPriv(), payload);
  assert.equal(sig, 'h/APrzXNG7SSb7yGUzUT+GEVncVupwTOObSoe3tCWRD4G+EvhMOFySHDon/0tFDcWLHSBlm+duppsruhH8ddCw==');
});

test('sha256HexUtf8: exakte UTF-8-Bytes, lowercase hex', () => {
  assert.equal(ic.sha256HexUtf8('abc'), crypto.createHash('sha256').update('abc', 'utf8').digest('hex'));
});

test('importPublicKeyFromSpkiBase64 lehnt Nicht-Ed25519 und PKCS8 ab', () => {
  // RSA-SPKI ist kein Ed25519.
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaSpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => ic.importPublicKeyFromSpkiBase64(rsaSpki));
  // Privater (PKCS8) Schlüssel wird nicht als Public akzeptiert.
  assert.throws(() => ic.importPublicKeyFromSpkiBase64(TEST_PRIV_PKCS8_B64));
});

test('verifyPayload schlägt bei manipulierter Nutzlast fehl', () => {
  const payload = ic.buildAuthPayload({
    challengeId: 'ch_x', nonce: 'nonce123', issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:00:15.000Z', protocolVersion: '0.1', clientType: 'homeess', identityId: 'ins_x',
  });
  const sig = ic.signPayload(testPriv(), payload);
  assert.equal(ic.verifyPayload(testPub(), payload + 'x', sig), false);
});
