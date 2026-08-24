'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  catalogManifests, normalizeCatalogUrl, normalizeDownloadUrl, parseArtifactName,
  DEFAULT_CATALOG_URL,
} = require('../adapter/hdp/firmware-catalog');
const { ReleaseStore } = require('../adapter/hdp/release-store');
const { checkCompatibility, otaHeaders } = require('../adapter/hdp/firmware');

const image = Buffer.alloc(4096, 5);
const sha256 = crypto.createHash('sha256').update(image).digest('hex');

function branch(version, name = `${version}-hdp-firmware-${version}-esp8266-d1-mini-generic.bin`, signing = {}) {
  return {
    version,
    download_url: `https://www.homeess.de/wp-content/uploads/hdp-firmware/esp8266/development/${name}`,
    file_name: name,
    file_size: image.length,
    sha256,
    signature: signing.signature || null,
    signature_algorithm: signing.signature ? 'ed25519-sha256' : null,
    signature_key_id: signing.signature ? 'hdp-2026' : null,
    signed_at: signing.signature ? '2026-08-24T18:00:00+00:00' : null,
    released_at: '2026-08-23T14:00:52+00:00',
    release_notes: `Notizen zu ${version}`,
  };
}

function payload(branches, extra = {}) {
  return {
    schema_version: 2,
    signing: {
      algorithm: 'ed25519-sha256', key_id: null,
      public_key: null, public_key_format: 'ed25519-raw-base64',
    },
    ...extra,
    generated_at: '2026-08-24T04:15:57+00:00',
    platforms: [{
      id: 1, name: 'ESP8266', slug: 'esp8266',
      chip_family: 'ESP8266', flash_offset: '0x0',
      branches,
    }],
  };
}

test('Katalogantwort wird in Release-Manifeste je Branch übersetzt', () => {
  const { releases, problems, generatedAt } = catalogManifests(payload({
    development: branch('0.7.6'), beta: branch('0.7.5'), stable: branch('0.7.5'),
  }));
  assert.deepEqual(problems, []);
  assert.equal(generatedAt, '2026-08-24T04:15:57+00:00');
  assert.deepEqual(releases.map((entry) => entry.channel), ['stable', 'beta', 'development']);

  const development = releases.find((entry) => entry.channel === 'development');
  assert.equal(development.manifest.release.version, '0.7.6');
  assert.equal(development.manifest.release.firmware_name, 'hdp-firmware');
  assert.equal(development.manifest.release.protocol_min, '1.0-draft');
  assert.equal(development.manifest.release.protocol_max, '1.0-draft');
  // Der Katalog nennt kein Konfigurationsschema; es bleibt offen.
  assert.equal(development.manifest.release.config_schema_version, null);
  assert.equal(development.manifest.release.release_notes, 'Notizen zu 0.7.6');
  assert.deepEqual(development.manifest.artifacts, [{
    platform: 'esp8266', board: 'd1_mini', variant: 'generic',
    filename: '0.7.6-hdp-firmware-0.7.6-esp8266-d1-mini-generic.bin',
    size_bytes: image.length, sha256,
    signature: null, signature_key_id: null, signed_at: null,
  }]);
  assert.deepEqual(development.platforms, [{ platform: 'esp8266', chip_family: 'ESP8266', flash_offset: '0x0' }]);
});

test('Nicht belegte Branches und fehlerhafte Einträge fallen sauber heraus', () => {
  const { releases, problems } = catalogManifests(payload({
    development: branch('0.7.6'), beta: null, stable: null,
  }));
  assert.deepEqual(releases.map((entry) => entry.channel), ['development']);
  assert.deepEqual(problems, []);

  const broken = catalogManifests(payload({
    development: { ...branch('0.7.6'), sha256: 'xyz' }, beta: null, stable: null,
  }));
  assert.deepEqual(broken.releases, []);
  assert.match(broken.problems[0], /esp8266\/development: SHA-256/);

  assert.throws(() => catalogManifests({ schema_version: 3, platforms: [] }),
    /Schema-Version 3; unterstützt werden 1 und 2/);
  assert.throws(() => catalogManifests({ schema_version: 2 }), /Plattformliste/);
});

test('Board und Variante werden aus dem Dateinamen gelesen', () => {
  assert.deepEqual(parseArtifactName('hdp-firmware-0.7.5-esp8266-d1-mini-generic.bin', 'esp8266', '0.7.5'),
    { board: 'd1_mini', variant: 'generic' });
  assert.deepEqual(parseArtifactName('0.7.5-hdp-firmware-0.7.5-esp32-esp32-s3-devkitc-1-ota.bin', 'esp32', '0.7.5'),
    { board: 'esp32_s3_devkitc_1', variant: 'ota' });
  assert.throws(() => parseArtifactName('firmware.bin', 'esp8266', '0.7.5'), /Muster/);
  assert.throws(() => parseArtifactName('hdp-firmware-0.7.5-esp8266-generic.bin', 'esp8266', '0.7.5'), /Board/);
});

test('Führt ein Kanal mehrere Plattformversionen, gilt die höchste', () => {
  const two = {
    schema_version: 2,
    platforms: [
      { slug: 'esp8266', chip_family: 'ESP8266', flash_offset: '0x0', branches: { stable: branch('0.7.5') } },
      {
        slug: 'esp32',
        chip_family: 'ESP32',
        flash_offset: '0x10000',
        branches: { stable: branch('0.7.4', 'hdp-firmware-0.7.4-esp32-devkit-generic.bin') },
      },
    ],
  };
  const { releases, problems } = catalogManifests(two);
  assert.equal(releases[0].manifest.release.version, '0.7.5');
  assert.deepEqual(releases[0].manifest.artifacts.map((a) => a.platform), ['esp8266']);
  assert.match(problems[0], /esp32\/stable: Version 0\.7\.4 bleibt liegen/);
});

test('URL-Prüfung lässt nur HTTPS auf dem Kataloghost zu', () => {
  assert.equal(normalizeCatalogUrl(DEFAULT_CATALOG_URL).hostname, 'www.homeess.de');
  assert.throws(() => normalizeCatalogUrl('http://www.homeess.de/x'), /HTTPS/);
  assert.throws(() => normalizeCatalogUrl('https://user:pw@www.homeess.de/x'), /Zugangsdaten/);

  const catalog = normalizeCatalogUrl(DEFAULT_CATALOG_URL);
  assert.equal(normalizeDownloadUrl('https://www.homeess.de/a.bin', catalog).pathname, '/a.bin');
  assert.equal(normalizeDownloadUrl('https://cdn.www.homeess.de/a.bin', catalog).hostname, 'cdn.www.homeess.de');
  assert.throws(() => normalizeDownloadUrl('https://evil.test/a.bin', catalog), /statt auf www\.homeess\.de/);
  assert.throws(() => normalizeDownloadUrl('http://www.homeess.de/a.bin', catalog), /HTTPS/);
});

test('Der Speicher holt neuere Kataloglstände und lässt aktuelle in Ruhe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let served = payload({ development: null, beta: null, stable: branch('0.7.5') });
  let downloads = 0;
  const catalogFactory = (url) => ({
    async fetch() {
      assert.equal(url, DEFAULT_CATALOG_URL);
      return catalogManifests(served);
    },
    async artifact(downloadUrl, expectedSize) {
      downloads += 1;
      assert.equal(expectedSize, image.length);
      assert.equal(String(downloadUrl).startsWith('https://www.homeess.de/'), true);
      return image;
    },
  });

  const store = new ReleaseStore({ directory, catalogFactory });
  store.load();
  assert.deepEqual(await store.syncFromCatalog(), [{ channel: 'stable', updated: true, version: '0.7.5' }]);
  assert.equal(downloads, 1);
  assert.equal(store.complete('stable'), true);
  assert.equal(store.origin('stable').kind, 'catalog');
  assert.equal(store.origin('stable').source, DEFAULT_CATALOG_URL);
  assert.equal(store.lastCatalogCheck.error, null);

  // Zweiter Lauf ohne neue Version lädt nichts nach.
  assert.deepEqual(await store.syncFromCatalog(), [{ channel: 'stable', updated: false, version: '0.7.5' }]);
  assert.equal(downloads, 1);

  served = payload({ development: null, beta: null, stable: branch('0.7.6') });
  assert.deepEqual(await store.syncFromCatalog(), [{ channel: 'stable', updated: true, version: '0.7.6' }]);
  assert.equal(downloads, 2);
  assert.equal(store.release('stable').release.version, '0.7.6');
});

test('Eine falsche Prüfsumme verhindert die Installation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-catalog-bad-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ReleaseStore({
    directory,
    catalogFactory: () => ({
      async fetch() { return catalogManifests(payload({ development: null, beta: null, stable: branch('0.7.5') })); },
      async artifact() { return Buffer.alloc(image.length, 6); },
    }),
  });
  store.load();
  const results = await store.syncFromCatalog();
  assert.match(results[0].error, /SHA-256/);
  assert.equal(store.release('stable'), null);
});

test('Schema 1 ohne Signaturfelder wird weiterhin gelesen', () => {
  const { releases, schemaVersion, signing } = catalogManifests({
    schema_version: 1,
    platforms: [{
      slug: 'esp8266',
      chip_family: 'ESP8266',
      flash_offset: '0x0',
      branches: {
        stable: {
          version: '0.7.5',
          download_url: 'https://www.homeess.de/f/hdp-firmware-0.7.5-esp8266-d1-mini-generic.bin',
          file_name: 'hdp-firmware-0.7.5-esp8266-d1-mini-generic.bin',
          file_size: image.length,
          sha256,
          released_at: '2026-08-23T14:00:52+00:00',
          release_notes: '',
        },
      },
    }],
  });
  assert.equal(schemaVersion, 1);
  assert.equal(signing, null);
  assert.equal(releases[0].manifest.artifacts[0].signature, null);
});

test('Signaturfelder aus Schema 2 landen im Manifest', () => {
  const signature = `${'A'.repeat(86)}==`;
  const { signing, releases } = catalogManifests(payload({
    development: null, beta: null, stable: branch('0.7.5', undefined, { signature }),
  }, {
    signing: {
      algorithm: 'ed25519-sha256', key_id: 'hdp-2026',
      public_key: 'Ns0k…', public_key_format: 'ed25519-raw-base64',
    },
  }));
  const artifact = releases[0].manifest.artifacts[0];
  assert.equal(artifact.signature, signature);
  assert.equal(artifact.signature_key_id, 'hdp-2026');
  assert.equal(artifact.signed_at, '2026-08-24T18:00:00+00:00');
  // Der Schlüssel des Katalogs wird mitgeführt, aber nie zum Vertrauensanker.
  assert.deepEqual(signing, {
    algorithm: 'ed25519-sha256', keyId: 'hdp-2026',
    publicKey: 'Ns0k…', publicKeyFormat: 'ed25519-raw-base64',
  });
});

test('Eine defekte oder fremd ausgezeichnete Signatur verwirft den Eintrag', () => {
  const kaputt = catalogManifests(payload({
    development: null, beta: null,
    stable: { ...branch('0.7.5'), signature: 'zu-kurz', signature_algorithm: 'ed25519-sha256' },
  }));
  assert.deepEqual(kaputt.releases, []);
  assert.match(kaputt.problems[0], /keine gültige Ed25519-Signatur/);

  const fremd = catalogManifests(payload({
    development: null, beta: null,
    stable: { ...branch('0.7.5', undefined, { signature: `${'A'.repeat(86)}==` }), signature_algorithm: 'rsa-sha256' },
  }));
  assert.deepEqual(fremd.releases, []);
  assert.match(fremd.problems[0], /statt ed25519-sha256/);

  // Ein Verfahren ohne Signatur ist ebenfalls ein Fehler: Sonst genügte das
  // Weglassen des Signaturfeldes, um die Prüfung zu umgehen.
  const halb = catalogManifests(payload({
    development: null, beta: null,
    stable: { ...branch('0.7.5'), signature_algorithm: 'ed25519-sha256' },
  }));
  assert.match(halb.problems[0], /Signaturverfahren ohne Signatur/);
});

test('Mit Prüfschlüssel wird eine echte Katalogsignatur akzeptiert', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-catalog-signed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  // Signiert werden die 32 rohen Bytes des SHA-256-Digests, wie in hDP 15.3.
  const digest = crypto.createHash('sha256').update(image).digest();
  const signature = crypto.sign(null, digest, keys.privateKey).toString('base64');
  const store = new ReleaseStore({
    directory,
    publicKey: keys.publicKey,
    catalogFactory: () => ({
      async fetch() {
        return catalogManifests(payload({
          development: null, beta: null, stable: branch('0.7.5', undefined, { signature }),
        }));
      },
      async artifact() { return image; },
    }),
  });
  store.load();
  assert.deepEqual(await store.syncFromCatalog(), [{ channel: 'stable', updated: true, version: '0.7.5' }]);
  assert.equal(store.origin('stable').signed, true);
  assert.equal(store.release('stable').artifacts[0].signature, signature);
});

test('Eine Signatur von fremdem Schlüssel wird abgewiesen', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-catalog-wrongkey-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const digest = crypto.createHash('sha256').update(image).digest();
  const foreign = crypto.sign(null, digest, crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
  const store = new ReleaseStore({
    directory,
    publicKey: crypto.generateKeyPairSync('ed25519').publicKey,
    catalogFactory: () => ({
      async fetch() {
        return catalogManifests(payload({
          development: null, beta: null, stable: branch('0.7.5', undefined, { signature: foreign }),
        }));
      },
      async artifact() { return image; },
    }),
  });
  store.load();
  const results = await store.syncFromCatalog();
  assert.match(results[0].error, /Signatur ist ungültig/);
  assert.equal(store.release('stable'), null);
});

test('Mit hinterlegtem Prüfschlüssel bleibt der signaturlose Katalog ungenutzt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-catalog-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ReleaseStore({
    directory,
    publicKey: crypto.generateKeyPairSync('ed25519').publicKey,
    catalogFactory: () => ({
      async fetch() { return catalogManifests(payload({ development: null, beta: null, stable: branch('0.7.5') })); },
      async artifact() { throw new Error('darf nicht geladen werden'); },
    }),
  });
  store.load();
  const results = await store.syncFromCatalog();
  assert.match(results[0].error, /keine Signatur/);
  assert.equal(store.release('stable'), null);
});

test('Leere Katalog-URL schaltet den Abruf ab', async () => {
  const store = new ReleaseStore({ catalogUrl: '' });
  assert.deepEqual(await store.syncFromCatalog(), []);
  assert.equal(store.lastCatalogCheck.disabled, true);
});

test('Ohne deklariertes Schema entscheidet das Gerät und der OTA-Header spiegelt es', () => {
  const { releases } = catalogManifests(payload({ development: null, beta: null, stable: branch('0.7.5') }));
  const manifest = releases[0].manifest;
  const artifact = manifest.artifacts[0];
  const info = {
    name: 'hdp-firmware', version: '0.7.4', platform: 'esp8266', board: 'd1_mini',
    variant: 'generic', protocol_version: '1.0-draft', config_schema_version: 7,
    ota_supported: true, maximum_image_size_bytes: 1044464, free_update_space_bytes: 1044464,
  };
  assert.equal(checkCompatibility(manifest, artifact, info), true);
  const headers = otaHeaders(manifest, artifact, info, { instanceId: 'homeess-test', bindingKey: 'a'.repeat(64) }, false);
  assert.equal(headers['X-hDP-Config-Schema-Version'], '7');

  // Ein Gerät ohne bestimmbares Schema bleibt weiterhin abgewiesen.
  assert.throws(() => checkCompatibility(manifest, artifact, { ...info, config_schema_version: null }),
    /nicht bestimmbar/);
});
