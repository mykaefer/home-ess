'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../src/remote-access/identity-store');

const TEST_FP_HEX = 'a60895a8b707af6cb8f657d0095a4c25e03b943da64cb5df2ef630aa8ec48172';
const DEVICE_FP = '1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90';

function freshDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ess-id-'));
  const dir = path.join(base, 'identity');
  store._internal._resetForTests(dir);
  store.init(dir);
  return { base, dir };
}

test('erzeugt Ed25519-Identität, lädt denselben Schlüssel erneut (stabil)', async () => {
  const { base, dir } = freshDir();
  const id1 = await store.loadOrCreateInstanceIdentity();
  assert.equal(id1.algorithm, 'Ed25519');
  assert.match(id1.fingerprintHex, /^[0-9a-f]{64}$/);
  // Neu laden ohne Cache -> identischer Fingerprint.
  store._internal._resetForTests(dir);
  store.init(dir);
  const id2 = await store.loadOrCreateInstanceIdentity();
  assert.equal(id2.fingerprintHex, id1.fingerprintHex);
  fs.rmSync(base, { recursive: true, force: true });
});

test('Dateirechte: Private-Key 0600, Verzeichnis 0700; JSON ohne Private Key', async () => {
  const { base, dir } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  const privStat = fs.statSync(path.join(dir, store._internal.PRIV_FILE));
  assert.equal(privStat.mode & 0o777, 0o600);
  const dirStat = fs.statSync(dir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const json = fs.readFileSync(path.join(dir, store._internal.JSON_FILE), 'utf8');
  assert.ok(!/PRIVATE/i.test(json), 'kein PRIVATE-Material in JSON');
  assert.ok(!json.includes('privateKey'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('parallele Erzeugung ergibt genau eine Identität', async () => {
  const { base } = freshDir();
  const results = await Promise.all([
    store.loadOrCreateInstanceIdentity(),
    store.loadOrCreateInstanceIdentity(),
    store.loadOrCreateInstanceIdentity(),
  ]);
  assert.equal(results[0].fingerprintHex, results[1].fingerprintHex);
  assert.equal(results[1].fingerprintHex, results[2].fingerprintHex);
  fs.rmSync(base, { recursive: true, force: true });
});

test('Public Key passt zum Private Key; Fingerprint reproduzierbar', async () => {
  const { base } = freshDir();
  const id = await store.loadOrCreateInstanceIdentity();
  const derived = crypto.createPublicKey(id.privateKey).export({ format: 'der', type: 'spki' });
  const stored = id.publicKey.export({ format: 'der', type: 'spki' });
  assert.ok(derived.equals(stored));
  const recomputed = crypto.createHash('sha256').update(stored).digest('hex');
  assert.equal(recomputed, id.fingerprintHex);
  fs.rmSync(base, { recursive: true, force: true });
});

test('beschädigte JSON -> kontrollierter Fehler, KEINE automatische Neuerzeugung', async () => {
  const { base, dir } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  const priv = fs.readFileSync(path.join(dir, store._internal.PRIV_FILE));
  fs.writeFileSync(path.join(dir, store._internal.JSON_FILE), '{not json');
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');
  // Der bestehende Private Key wurde NICHT überschrieben.
  assert.ok(fs.readFileSync(path.join(dir, store._internal.PRIV_FILE)).equals(priv));
  fs.rmSync(base, { recursive: true, force: true });
});

test('falscher Algorithmus / zukünftige Version -> corrupt', async () => {
  const { base, dir } = freshDir();
  const id = await store.loadOrCreateInstanceIdentity();
  const meta = { version: 1, algorithm: 'RSA', publicKey: id.publicKeySpkiBase64, fingerprint: id.fingerprintHex, createdAt: id.createdAt };
  fs.writeFileSync(path.join(dir, store._internal.JSON_FILE), JSON.stringify(meta));
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');

  const meta2 = { version: 999, algorithm: 'Ed25519', publicKey: id.publicKeySpkiBase64, fingerprint: id.fingerprintHex, createdAt: id.createdAt };
  fs.writeFileSync(path.join(dir, store._internal.JSON_FILE), JSON.stringify(meta2));
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');
  fs.rmSync(base, { recursive: true, force: true });
});

test('fremder Private Key (passt nicht zum Public Key) -> corrupt', async () => {
  const { base, dir } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  // Fremden Ed25519-Private-Key unterschieben.
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  fs.writeFileSync(path.join(dir, store._internal.PRIV_FILE), other);
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');
  fs.rmSync(base, { recursive: true, force: true });
});

test('zu große Private-Key-Datei -> corrupt', async () => {
  const { base, dir } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  fs.writeFileSync(path.join(dir, store._internal.PRIV_FILE), Buffer.alloc(10000, 1));
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');
  fs.rmSync(base, { recursive: true, force: true });
});

test('Symlink als Identity-Datei wird abgelehnt', async () => {
  const { base, dir } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  const target = path.join(base, 'elsewhere.json');
  fs.writeFileSync(target, '{}');
  fs.unlinkSync(path.join(dir, store._internal.JSON_FILE));
  fs.symlinkSync(target, path.join(dir, store._internal.JSON_FILE));
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');
  fs.rmSync(base, { recursive: true, force: true });
});

test('halb vorhandene Identität (nur JSON) -> corrupt, keine Neuerzeugung', async () => {
  const { base, dir } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  fs.unlinkSync(path.join(dir, store._internal.PRIV_FILE));
  store._internal._resetForTests(dir);
  store.init(dir);
  await assert.rejects(() => store.loadOrCreateInstanceIdentity(), (e) => e.code === 'remote_access_identity_store_corrupt');
  fs.rmSync(base, { recursive: true, force: true });
});

test('signInstancePairingProof erzeugt verifizierbaren Proof gegen den lokalen Public Key', async () => {
  const { base } = freshDir();
  const id = await store.loadOrCreateInstanceIdentity();
  const ic = require('../src/remote-access/identity-crypto');
  const signed = await store.signInstancePairingProof({ pairingId: 'pr_x', originToken: 'tok', deviceFingerprintHex: DEVICE_FP });
  const payload = ic.buildInstanceProofPayload({
    pairingId: 'pr_x',
    originTokenHashHex: ic.sha256HexUtf8('tok'),
    instanceFingerprintHex: id.fingerprintHex,
    deviceFingerprintHex: DEVICE_FP,
  });
  assert.equal(ic.verifyPayload(id.publicKey, payload, signed.proof), true);
  assert.equal(signed.publicKeySpkiBase64, id.publicKeySpkiBase64);
  fs.rmSync(base, { recursive: true, force: true });
});

test('storeProvisionedIdentity persistiert IDs, prüft Instanzfingerprint, ist read-only ladbar', async () => {
  const { base, dir } = freshDir();
  const id = await store.loadOrCreateInstanceIdentity();
  const rec = await store.storeProvisionedIdentity({
    instanceId: 'ins_abcd1234',
    instanceName: 'homeESS Zuhause',
    instanceFingerprint: id.fingerprintHex,
    device: { deviceId: 'dev_abcd1234', name: 'Phone', platform: 'android', appVersion: '1.0.0', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP },
    relayBaseUrl: 'https://relay.example', protocolVersion: '0.1', pairedAt: new Date().toISOString(),
  });
  assert.equal(rec.instanceId, 'ins_abcd1234');
  assert.equal(rec.devices.length, 1);
  // Read-only-Neuladen ohne Schlüsselerzeugung.
  store._internal._resetForTests(dir);
  store.init(dir);
  const prov = await store.getProvisionedIdentity();
  assert.equal(prov.instanceId, 'ins_abcd1234');
  assert.equal(prov.devices[0].deviceId, 'dev_abcd1234');
  fs.rmSync(base, { recursive: true, force: true });
});

test('storeProvisionedIdentity lehnt fremden Instanzfingerprint ab (Sicherheit)', async () => {
  const { base } = freshDir();
  await store.loadOrCreateInstanceIdentity();
  await assert.rejects(() => store.storeProvisionedIdentity({
    instanceId: 'ins_abcd1234',
    instanceFingerprint: TEST_FP_HEX, // fremder Testvektor-Fingerprint
    device: { deviceId: 'dev_abcd1234', fingerprint: DEVICE_FP },
    pairedAt: new Date().toISOString(),
  }), (e) => e.code === 'remote_access_identity_mismatch');
  fs.rmSync(base, { recursive: true, force: true });
});

test('storeProvisionedIdentity lehnt inkonsistenten Gerätefingerprint gegen Claim ab', async () => {
  const { base } = freshDir();
  const id = await store.loadOrCreateInstanceIdentity();
  await assert.rejects(() => store.storeProvisionedIdentity({
    instanceId: 'ins_abcd1234',
    instanceFingerprint: id.fingerprintHex,
    device: { deviceId: 'dev_abcd1234', fingerprint: DEVICE_FP, claimFingerprint: 'ffffabcd5678ef90' },
    pairedAt: new Date().toISOString(),
  }), (e) => e.code === 'remote_access_identity_mismatch');
  fs.rmSync(base, { recursive: true, force: true });
});

test('getProvisionedIdentity ohne Identität legt KEIN Schlüsselmaterial an', async () => {
  const { base, dir } = freshDir();
  const prov = await store.getProvisionedIdentity();
  assert.equal(prov, null);
  assert.ok(!fs.existsSync(path.join(dir, store._internal.PRIV_FILE)), 'kein Key durch read-only-Zugriff');
  fs.rmSync(base, { recursive: true, force: true });
});
