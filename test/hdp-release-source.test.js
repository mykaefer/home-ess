'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReleaseStore } = require('../adapter/hdp/release-store');
const { normalizeBaseUrl } = require('../adapter/hdp/release-source');

function release(version, channel, filename, image, signature = null) {
  return {
    schema_version: 1,
    release: {
      firmware_name: 'hdp-firmware', version, channel,
      published_at: '2026-08-16T00:00:00Z', build_id: `build-${version}`,
      protocol_min: '1.0-draft', protocol_max: '1.0-draft', config_schema_version: 7,
    },
    artifacts: [{
      platform: 'esp8266', board: 'd1_mini', variant: 'generic', filename,
      size_bytes: image.length,
      sha256: crypto.createHash('sha256').update(image).digest('hex'),
      signature,
    }],
  };
}

function writeChannel(root, manifest, image) {
  const directory = path.join(root, manifest.release.channel);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, manifest.artifacts[0].filename), image);
}

test('Der Firmwarespeicher startet leer und liest nur vorhandene Kanäle ein', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-store-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = Buffer.alloc(2048, 7);
  const filename = 'hdp-firmware.bin';

  // Mit der Installation kommt keine Firmware mehr mit: Ein frisches
  // Datenverzeichnis bleibt leer, bis der Katalog oder ein Upload es füllt.
  const store = new ReleaseStore();
  assert.deepEqual(store.attach(data), []);
  assert.equal(store.release('stable'), null);
  assert.equal(store.complete('stable'), false);

  writeChannel(path.join(data, 'firmware'), release('0.7.3', 'stable', filename, image), image);
  store.load();
  assert.equal(store.release('stable').release.version, '0.7.3');
  assert.equal(store.complete('stable'), true);
  const candidate = store.candidateFor({
    name: 'hdp-firmware', version: '0.7.2', platform: 'esp8266', board: 'd1_mini',
    variant: 'generic', protocol_version: '1.0-draft', config_schema_version: 7,
    ota_supported: true, maximum_image_size_bytes: 1044464, free_update_space_bytes: 1044464,
  }, 'stable');
  assert.equal(candidate.available, true);
});

test('Online-Releases benötigen HTTPS, Prüfschlüssel und gültige Ed25519-Signaturen', async (t) => {
  assert.throws(() => normalizeBaseUrl('http://updates.example.test/hdp/'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('https://user:secret@updates.example.test/hdp/'), /Zugangsdaten/);
  assert.equal(normalizeBaseUrl('https://updates.example.test/hdp').href,
    'https://updates.example.test/hdp/');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-remote-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(4096, 9);
  const filename = 'hdp-firmware-0.8.0.bin';
  const keys = crypto.generateKeyPairSync('ed25519');
  const digest = crypto.createHash('sha256').update(image).digest();
  const signature = crypto.sign(null, digest, keys.privateKey).toString('base64');
  const manifest = release('0.8.0', 'stable', filename, image, signature);
  const sourceFactory = () => ({
    baseUrl: new URL('https://updates.example.test/hdp/'),
    async manifest(channel) {
      assert.equal(channel, 'stable');
      return manifest;
    },
    async artifact(channel, requested, expectedSize) {
      assert.equal(channel, 'stable');
      assert.equal(requested, filename);
      assert.equal(expectedSize, image.length);
      return image;
    },
  });

  const withoutKey = new ReleaseStore({ directory, catalogUrl: '', source: 'https://updates.example.test/hdp/', sourceFactory });
  await assert.rejects(() => withoutKey.syncFromSource(['stable']), /Prüfschlüssel/);

  const store = new ReleaseStore({
    directory, catalogUrl: '', source: 'https://updates.example.test/hdp/',
    sourceFactory, publicKey: keys.publicKey,
  });
  store.load();
  assert.deepEqual(await store.syncFromSource(['stable']), [{ channel: 'stable', updated: true, version: '0.8.0' }]);
  assert.equal(store.complete('stable'), true);
  assert.equal(store.origin('stable').kind, 'remote');

  const unsigned = release('0.8.1', 'stable', filename, image, null);
  store.sourceFactory = () => ({
    baseUrl: new URL('https://updates.example.test/hdp/'),
    async manifest() { return unsigned; },
    async artifact() { return image; },
  });
  const rejected = await store.syncFromSource(['stable']);
  assert.match(rejected[0].error, /keine authentifizierbare Signatur/);
  assert.equal(store.release('stable').release.version, '0.8.0');
});
