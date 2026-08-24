'use strict';

// Zentraler Firmwarespeicher des Adapters. Es gibt genau eine universelle
// Firmware; ein Release-Manifest beschreibt sie je Plattform, Board und
// Variante. Hochgeladen wird deshalb einmal zentral, nicht je Gerät.
//
// Je Release-Kanal wird ein Release vorgehalten. Ein Gerät zieht ausschließlich
// den Kanal, der in seinen Updateeinstellungen steht; damit lassen sich ein
// stabiler und ein Entwicklungsstand gleichzeitig bereithalten.
//
// Ablage: <datenverzeichnis>/firmware/<kanal>/manifest.json plus die Artefakte
// unter ihrem im Manifest deklarierten Dateinamen.
//
// Mit der Installation kommt keine Firmware mehr mit. Beim ersten Start holt
// der Adapter die aktuellen Stände über den Online-Firmwarekatalog und prüft
// danach täglich nach; bis dahin sind die Kanäle schlicht leer.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateManifest, selectArtifact, checkCompatibility, validateArtifactFile } = require('./firmware');
const { compareSemVer } = require('./validation');
const { ReleaseSource } = require('./release-source');
const { FirmwareCatalog, DEFAULT_CATALOG_URL } = require('./firmware-catalog');

const CHANNELS = Object.freeze(['stable', 'beta', 'development']);
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function validChannel(value) {
  const channel = String(value || '');
  if (!CHANNELS.includes(channel)) throw new Error(`Unbekannter Release-Kanal ${channel}.`);
  return channel;
}

function validFilename(value) {
  const name = String(value || '');
  if (!FILENAME_RE.test(name) || name.includes('..')) {
    throw new Error('Artefaktdateiname ist ungültig.');
  }
  return name;
}

class ReleaseStore {
  constructor(options = {}) {
    this.directory = options.directory || null;
    this.publicKey = options.publicKey || null;
    this.source = options.source || '';
    this.sourceFactory = options.sourceFactory || ((url) => new ReleaseSource(url));
    this.catalogUrl = options.catalogUrl === undefined ? DEFAULT_CATALOG_URL : options.catalogUrl;
    this.catalogFactory = options.catalogFactory || ((url) => new FirmwareCatalog(url));
    // Letztes Ergebnis der Katalogprüfung, damit die Oberfläche sagen kann,
    // wann zuletzt gesucht wurde und was dabei herauskam.
    this.lastCatalogCheck = null;
    // kanal -> { manifest, storedAt }
    this.releases = new Map();
  }

  attach(directory) {
    this.directory = directory;
    this.load();
    return [];
  }

  channelDirectory(channel) {
    if (!this.directory) throw new Error('Firmwarespeicher ist nicht initialisiert.');
    return path.join(this.directory, 'firmware', validChannel(channel));
  }

  load() {
    this.releases.clear();
    if (!this.directory) return;
    for (const channel of CHANNELS) {
      const file = path.join(this.channelDirectory(channel), 'manifest.json');
      if (!fs.existsSync(file)) continue;
      try {
        const manifest = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
        this.releases.set(channel, { manifest, storedAt: fs.statSync(file).mtime.toISOString() });
      } catch (_) {
        // Ein unlesbares Manifest darf den Adapterstart nicht verhindern; der
        // Kanal gilt dann schlicht als leer und kann neu befüllt werden.
      }
    }
  }

  release(channel) {
    const entry = this.releases.get(validChannel(channel));
    return entry ? entry.manifest : null;
  }

  artifactPath(channel, filename) {
    return path.join(this.channelDirectory(channel), validFilename(filename));
  }

  originPath(channel) {
    return path.join(this.directory, '.firmware-origins', `${validChannel(channel)}.json`);
  }

  origin(channel) {
    try {
      return JSON.parse(fs.readFileSync(this.originPath(channel), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  clearOrigin(channel) {
    try { fs.rmSync(this.originPath(channel), { force: true }); } catch (_) { /* egal */ }
  }

  writeOrigin(channel, origin) {
    const target = this.originPath(channel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(origin, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  async validateReleaseFiles(manifest, files, options = {}) {
    for (const artifact of manifest.artifacts) {
      const file = files.get(artifact.filename);
      if (!file) throw new Error(`Firmwaredatei ${artifact.filename} fehlt.`);
      await validateArtifactFile(file, artifact, options);
    }
  }

  installRelease(manifestInput, files, origin) {
    const manifest = validateManifest(manifestInput);
    const channel = validChannel(manifest.release.channel);
    const firmwareDirectory = path.join(this.directory, 'firmware');
    fs.mkdirSync(firmwareDirectory, { recursive: true, mode: 0o700 });
    const directory = this.channelDirectory(channel);
    const staging = fs.mkdtempSync(path.join(firmwareDirectory, `.${channel}-install-`));
    fs.chmodSync(staging, 0o700);
    for (const artifact of manifest.artifacts) {
      const source = files.get(artifact.filename);
      const target = path.join(staging, validFilename(artifact.filename));
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const backup = path.join(firmwareDirectory,
      `.${channel}-previous-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    let movedPrevious = false;
    try {
      if (fs.existsSync(directory)) {
        fs.renameSync(directory, backup);
        movedPrevious = true;
      }
      fs.renameSync(staging, directory);
      if (movedPrevious) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      try {
        if (!fs.existsSync(directory) && movedPrevious && fs.existsSync(backup)) fs.renameSync(backup, directory);
      } catch (_) { /* ursprünglichen Fehler beibehalten */ }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* egal */ }
      throw error;
    }
    this.releases.set(channel, { manifest, storedAt: new Date().toISOString() });
    this.writeOrigin(channel, origin);
    return { channel, manifest, origin, missing: this.missingArtifacts(channel) };
  }

  // Prüft den Online-Firmwarekatalog und holt neuere Stände. Ein Kanal wird nur
  // angefasst, wenn der Katalog dort eine höhere Version führt oder der lokale
  // Kanal unvollständig ist; alles andere bleibt unberührt.
  //
  // Signaturpolitik: Ohne hinterlegten Prüfschlüssel bürgen HTTPS und die im
  // Katalog deklarierte SHA-256, die vor der Installation gegen die Datei
  // geprüft wird. Mit Prüfschlüssel hat der Betreiber sich für Signaturen als
  // Vertrauensanker entschieden — dann muss jedes Artefakt eine tragen und gegen
  // genau diesen Schlüssel aufgehen. Führt der Katalog keine, bleibt er
  // ungenutzt, statt die Entscheidung still zu unterlaufen.
  //
  // Der im Katalog genannte öffentliche Schlüssel wird dabei nie verwendet: Er
  // käme aus derselben Quelle wie das Artefakt und würde nichts absichern.
  async syncFromCatalog(channels = CHANNELS) {
    const url = String(this.catalogUrl || '').trim();
    const checkedAt = new Date().toISOString();
    if (!url) {
      this.lastCatalogCheck = { checkedAt, url: '', results: [], error: null, disabled: true };
      return [];
    }
    if (!this.directory) throw new Error('Firmwarespeicher ist nicht initialisiert.');
    const wanted = channels.map(validChannel);
    const client = this.catalogFactory(url);
    let catalog;
    try {
      catalog = await client.fetch();
    } catch (error) {
      this.lastCatalogCheck = { checkedAt, url, results: [], error: error.message };
      throw error;
    }
    const results = [];
    for (const problem of catalog.problems) results.push({ channel: null, updated: false, error: problem });
    for (const entry of catalog.releases) {
      if (!wanted.includes(entry.channel)) continue;
      const signed = entry.manifest.artifacts.every((artifact) => artifact.signature);
      if (this.publicKey && !signed) {
        results.push({
          channel: entry.channel,
          updated: false,
          error: 'Der Online-Firmwarekatalog führt für diesen Kanal keine Signatur;'
            + ' bei gesetztem Prüfschlüssel bleibt er ungenutzt.',
        });
        continue;
      }
      let temporaryDirectory = null;
      try {
        const manifest = validateManifest(entry.manifest);
        const current = this.release(entry.channel);
        if (current && this.complete(entry.channel)
            && compareSemVer(manifest.release.version, current.release.version) <= 0) {
          results.push({ channel: entry.channel, updated: false, version: current.release.version });
          continue;
        }
        temporaryDirectory = fs.mkdtempSync(path.join(this.directory, '.firmware-catalog-'));
        fs.chmodSync(temporaryDirectory, 0o700);
        const files = new Map();
        for (const artifact of manifest.artifacts) {
          const filename = validFilename(artifact.filename);
          const target = path.join(temporaryDirectory, filename);
          const downloadUrl = entry.downloads.get(artifact.filename);
          if (!downloadUrl) throw new Error(`Zu ${filename} nennt der Katalog keine Download-URL.`);
          fs.writeFileSync(target, await client.artifact(downloadUrl, artifact.size_bytes), { mode: 0o600 });
          files.set(filename, target);
        }
        await this.validateReleaseFiles(manifest, files, this.publicKey
          ? { publicKey: this.publicKey, requireSignature: true }
          : { requireSignature: false });
        this.installRelease(manifest, files, {
          kind: 'catalog',
          version: manifest.release.version,
          source: url,
          published_at: manifest.release.published_at,
          release_notes: manifest.release.release_notes || '',
          signed,
        });
        results.push({ channel: entry.channel, updated: true, version: manifest.release.version });
      } catch (error) {
        results.push({ channel: entry.channel, updated: false, error: error.message });
      } finally {
        if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
    this.lastCatalogCheck = {
      checkedAt, url, generatedAt: catalog.generatedAt, results, error: null,
    };
    return results;
  }

  async syncFromSource(channels = CHANNELS) {
    if (!String(this.source || '').trim()) return [];
    if (!this.publicKey) throw new Error('Für Online-Firmwareupdates muss ein Ed25519-Prüfschlüssel konfiguriert sein.');
    if (!this.directory) throw new Error('Firmwarespeicher ist nicht initialisiert.');
    const source = this.sourceFactory(this.source);
    const results = [];
    for (const rawChannel of channels) {
      const channel = validChannel(rawChannel);
      let temporaryDirectory = null;
      try {
        const manifest = validateManifest(await source.manifest(channel));
        if (manifest.release.channel !== channel) throw new Error(`Remote-Manifest ist nicht dem Kanal ${channel} zugeordnet.`);
        const current = this.release(channel);
        if (current && this.complete(channel)
            && compareSemVer(manifest.release.version, current.release.version) <= 0) {
          results.push({ channel, updated: false, version: current.release.version });
          continue;
        }
        temporaryDirectory = fs.mkdtempSync(path.join(this.directory, '.firmware-download-'));
        fs.chmodSync(temporaryDirectory, 0o700);
        const files = new Map();
        for (const artifact of manifest.artifacts) {
          const filename = validFilename(artifact.filename);
          const target = path.join(temporaryDirectory, filename);
          fs.writeFileSync(target, await source.artifact(channel, filename, artifact.size_bytes), { mode: 0o600 });
          files.set(filename, target);
        }
        await this.validateReleaseFiles(manifest, files, {
          publicKey: this.publicKey, requireSignature: true,
        });
        this.installRelease(manifest, files, {
          kind: 'remote', version: manifest.release.version,
          source: source.baseUrl.origin + source.baseUrl.pathname,
        });
        results.push({ channel, updated: true, version: manifest.release.version });
      } catch (error) {
        results.push({ channel, updated: false, error: error.message });
      } finally {
        if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
    return results;
  }

  artifactStored(channel, artifact) {
    try {
      return fs.statSync(this.artifactPath(channel, artifact.filename)).size === artifact.size_bytes;
    } catch (_) {
      return false;
    }
  }

  // Ein Kanal ist erst vollständig, wenn zu jedem deklarierten Artefakt auch
  // die Datei vorliegt. Vorher darf daraus kein Update laufen.
  missingArtifacts(channel) {
    const manifest = this.release(channel);
    if (!manifest) return [];
    return manifest.artifacts.filter((artifact) => !this.artifactStored(channel, artifact));
  }

  complete(channel) {
    return !!this.release(channel) && this.missingArtifacts(channel).length === 0;
  }

  summary() {
    return CHANNELS.map((channel) => {
      const manifest = this.release(channel);
      if (!manifest) return { channel, present: false };
      const entry = this.releases.get(channel);
      return {
        channel,
        present: true,
        complete: this.complete(channel),
        storedAt: entry.storedAt,
        origin: this.origin(channel),
        release: manifest.release,
        artifacts: manifest.artifacts.map((artifact) => ({
          filename: artifact.filename,
          platform: artifact.platform,
          board: artifact.board,
          variant: artifact.variant,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
          signed: !!artifact.signature,
          stored: this.artifactStored(channel, artifact),
        })),
      };
    });
  }

  // Standardmäßig bestimmt das Manifest seinen Kanal selbst — so kommt es von
  // der Release-Quelle, und so muss es beim automatischen Abholen auch bleiben.
  // Beim Hochladen von Hand darf der Kanal ausdrücklich überschrieben werden;
  // dann wird das Manifest entsprechend umgeschrieben und mit dem geänderten
  // Kanal abgelegt. Eine stille Umetikettierung ist das nicht: Sie passiert nur
  // auf ausdrückliche Angabe, und das Gespeicherte sagt danach die Wahrheit.
  saveManifest(input, options = {}) {
    const requested = options.channel == null || options.channel === ''
      ? null : validChannel(options.channel);
    const source = validateManifest(input);
    const manifest = requested && requested !== source.release.channel
      ? { ...source, release: { ...source.release, channel: requested } }
      : source;
    const channel = validChannel(manifest.release.channel);
    this.clearOrigin(channel);
    for (const artifact of manifest.artifacts) validFilename(artifact.filename);
    const directory = this.channelDirectory(channel);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const previous = this.release(channel);
    if (previous && previous.release.version !== manifest.release.version) {
      // Beim Versionswechsel die Artefakte des Vorgängers entfernen, damit der
      // Kanal nicht unbemerkt zwei Stände mischt.
      for (const artifact of previous.artifacts) {
        try { fs.rmSync(this.artifactPath(channel, artifact.filename), { force: true }); } catch (_) { /* egal */ }
      }
    }
    const target = path.join(directory, 'manifest.json');
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
    this.releases.set(channel, { manifest, storedAt: new Date().toISOString() });
    return {
      channel,
      manifest,
      missing: this.missingArtifacts(channel),
      // Damit die Oberfläche sagen kann, dass sie den Kanal verlegt hat.
      retargetedFrom: channel === source.release.channel ? null : source.release.channel,
    };
  }

  async saveArtifact(uploadInfo) {
    if (!uploadInfo || !uploadInfo.path) throw new Error('Firmwaredatei fehlt.');
    const filename = validFilename(uploadInfo.filename);
    const matches = [];
    for (const channel of CHANNELS) {
      const manifest = this.release(channel);
      if (!manifest) continue;
      const artifact = manifest.artifacts.find((item) => item.filename === filename);
      if (artifact) matches.push({ channel, artifact });
    }
    if (!matches.length) {
      throw new Error(`Zu „${filename}“ ist kein Release-Manifest hinterlegt. Zuerst das Manifest hochladen.`);
    }
    const results = [];
    for (const { channel, artifact } of matches) {
      const check = await validateArtifactFile(uploadInfo.path, artifact, { publicKey: this.publicKey });
      const target = this.artifactPath(channel, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(uploadInfo.path, target);
      fs.chmodSync(target, 0o600);
      results.push({ channel, filename, sha256: check.sha256, signature: check.signature.status });
    }
    return { filename, stored: results, missing: this.missingArtifacts(results[0].channel) };
  }

  // Mit dem Adapter ausgelieferte Werkzeuge. Sie liegen im Adapterverzeichnis,
  // nicht in den Nutzerdaten: Sie kommen mit der Installation und werden nie
  // hochgeladen.
  bundledTools() {
    const directory = path.join(__dirname, 'tools');
    try {
      return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => ({
          filename: entry.name,
          size_bytes: fs.statSync(path.join(directory, entry.name)).size,
        }))
        .sort((left, right) => left.filename.localeCompare(right.filename));
    } catch (_) {
      return [];
    }
  }

  removeChannel(channel) {
    const directory = this.channelDirectory(channel);
    fs.rmSync(directory, { recursive: true, force: true });
    this.clearOrigin(channel);
    this.releases.delete(validChannel(channel));
    return true;
  }

  // Prüft, ob der Kanal für dieses konkrete Gerät ein installierbares, neueres
  // Release bereithält. Liefert immer eine Begründung, damit die Oberfläche
  // erklären kann, warum nichts angeboten wird.
  candidateFor(firmwareInfo, channel, options = {}) {
    const manifest = this.release(channel);
    if (!manifest) return { available: false, reason: 'Für diesen Kanal ist keine Firmware hinterlegt.' };
    let artifact;
    try {
      artifact = selectArtifact(manifest, firmwareInfo);
    } catch (error) {
      return { available: false, reason: error.message };
    }
    if (!this.artifactStored(channel, artifact)) {
      return { available: false, reason: `Die Datei ${artifact.filename} fehlt im Firmwarespeicher.`, artifact };
    }
    try {
      checkCompatibility(manifest, artifact, firmwareInfo, { allowDowngrade: !!options.allowDowngrade });
    } catch (error) {
      return { available: false, reason: error.message, artifact, release: manifest.release };
    }
    // checkCompatibility lässt die identische Version durch — für eine erneute
    // Installation desselben Stands ist das richtig, als Updateangebot nicht.
    if (!options.allowDowngrade
        && compareSemVer(manifest.release.version, firmwareInfo.version) <= 0) {
      return {
        available: false,
        reason: `Das Gerät läuft bereits auf ${firmwareInfo.version}.`,
        artifact,
        release: manifest.release,
      };
    }
    return {
      available: true,
      channel,
      manifest,
      artifact,
      release: manifest.release,
      origin: this.origin(channel),
      file: this.artifactPath(channel, artifact.filename),
    };
  }
}

module.exports = { ReleaseStore, CHANNELS, validChannel, validFilename };
