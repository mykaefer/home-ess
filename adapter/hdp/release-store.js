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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateManifest, selectArtifact, checkCompatibility, validateArtifactFile } = require('./firmware');
const { compareSemVer } = require('./validation');

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
    // kanal -> { manifest, storedAt }
    this.releases = new Map();
  }

  attach(directory) {
    this.directory = directory;
    this.load();
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

  // Das Manifest bestimmt den Kanal selbst; ein abweichender Wunsch wäre eine
  // stille Umetikettierung des Releases.
  saveManifest(input) {
    const manifest = validateManifest(input);
    const channel = validChannel(manifest.release.channel);
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
    return { channel, manifest, missing: this.missingArtifacts(channel) };
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
      file: this.artifactPath(channel, artifact.filename),
    };
  }
}

module.exports = { ReleaseStore, CHANNELS, validChannel, validFilename };
