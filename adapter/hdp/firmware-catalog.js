'use strict';

// Online-Firmwarekatalog von homeess.de.
//
// Der öffentliche GET-Endpunkt liefert je Plattform und Branch (development,
// beta, stable) die jeweils neueste Version mit Download-URL, Dateiname,
// Dateigröße, SHA-256, Veröffentlichungszeit, Release Notes, Chip-Familie und
// Flash-Offset. Nicht belegte Branches kommen als `null`.
//
// Der Katalog spricht damit eine andere Sprache als der Firmwarespeicher, der
// Release-Manifeste nach Schema 1 ablegt. Dieses Modul übersetzt: Aus jedem
// belegten Branch wird ein Manifest mit genau den Artefakten, die zur Version
// dieses Branches gehören.
//
// Nicht im Katalog enthalten sind Board, Variante, Protokollgrenzen und das
// Konfigurationsschema. Board und Variante stecken im Dateinamen und werden
// dort gelesen; die Protokollgrenzen sind die einzige vom Adapter gesprochene
// Protokollversion. Das Konfigurationsschema bleibt offen (`null`) — das Gerät
// ist dafür ohnehin die normative Instanz und lehnt einen unpassenden Stand
// beim Empfang selbst ab.

const { requestBuffer } = require('./release-source');
const { PROTOCOL_VERSION, parseSemVer, compareSemVer } = require('./validation');

const DEFAULT_CATALOG_URL = 'https://www.homeess.de/wp-json/hdp-firmware/v1/firmware';
const FIRMWARE_NAME = 'hdp-firmware';
// Die Branch-Namen des Katalogs sind zugleich die Kanalnamen des Speichers.
const BRANCHES = Object.freeze(['stable', 'beta', 'development']);
const CATALOG_MAX_BYTES = 512 * 1024;
const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

function normalizeCatalogUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new Error('Firmware-Katalog-URL ist keine gültige URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Firmware-Katalog-URL muss HTTPS verwenden.');
  if (url.username || url.password) throw new Error('Firmware-Katalog-URL darf keine Zugangsdaten enthalten.');
  return url;
}

// Downloads dürfen den Rechner nicht zu beliebigen Zielen schicken. Zulässig
// ist deshalb nur HTTPS auf dem Host des Katalogs oder einer seiner
// Unterdomänen — mehr braucht eine Auslieferung von derselben Stelle nicht.
function normalizeDownloadUrl(value, catalogUrl) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new Error('Download-URL des Firmwarekatalogs ist ungültig.');
  }
  if (url.protocol !== 'https:') throw new Error('Download-URL des Firmwarekatalogs muss HTTPS verwenden.');
  if (url.username || url.password) throw new Error('Download-URL des Firmwarekatalogs darf keine Zugangsdaten enthalten.');
  const host = catalogUrl.hostname.toLowerCase();
  const target = url.hostname.toLowerCase();
  if (target !== host && !target.endsWith(`.${host}`)) {
    throw new Error(`Download-URL zeigt auf ${url.hostname} statt auf ${catalogUrl.hostname}.`);
  }
  return url;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Der Dateiname ist die einzige Stelle, an der Board und Variante stehen:
// `[<präfix>-]hdp-firmware-<version>-<plattform>-<board>-<variante>.bin`, das
// Board mit Bindestrichen statt Unterstrichen. Alles davor (der Katalog stellt
// die Version noch einmal voran) wird übersprungen.
function parseArtifactName(fileName, platform, version) {
  const name = text(fileName);
  if (!name.endsWith('.bin')) throw new Error(`Firmwaredateiname ${name || '(leer)'} endet nicht auf .bin.`);
  const marker = `${FIRMWARE_NAME}-${version}-${platform}-`;
  const index = name.indexOf(marker);
  if (index < 0) {
    throw new Error(`Firmwaredateiname ${name} passt nicht zum Muster ${marker}<board>-<variante>.bin.`);
  }
  const tail = name.slice(index + marker.length, -4);
  const parts = tail.split('-').filter((part) => part.length);
  if (parts.length < 2) {
    throw new Error(`Firmwaredateiname ${name} nennt weder Board noch Variante.`);
  }
  const variant = parts[parts.length - 1];
  const board = parts.slice(0, -1).join('_');
  return { board, variant };
}

function branchArtifact(entry, platform, catalogUrl) {
  const version = text(entry.version);
  parseSemVer(version);
  const fileName = text(entry.file_name);
  const size = Number(entry.file_size);
  if (!Number.isInteger(size) || size < 1 || size > ARTIFACT_MAX_BYTES) {
    throw new Error(`Dateigröße von ${fileName || platform} ist ungültig.`);
  }
  const sha256 = text(entry.sha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`SHA-256 von ${fileName || platform} ist ungültig.`);
  const { board, variant } = parseArtifactName(fileName, platform, version);
  return {
    version,
    releasedAt: text(entry.released_at) || null,
    releaseNotes: text(entry.release_notes),
    downloadUrl: normalizeDownloadUrl(entry.download_url, catalogUrl),
    artifact: {
      platform, board, variant, filename: fileName,
      size_bytes: size, sha256, signature: null,
    },
  };
}

// Übersetzt die Katalogantwort in je ein Release-Manifest pro Branch. Melden
// mehrere Plattformen in einem Branch verschiedene Versionen, gilt die höchste;
// die zurückgebliebenen Plattformen werden als übersprungen gemeldet, statt sie
// unter einer fremden Versionsnummer mitzuinstallieren.
function catalogManifests(payload, options = {}) {
  const catalogUrl = options.catalogUrl instanceof URL
    ? options.catalogUrl : normalizeCatalogUrl(options.catalogUrl || DEFAULT_CATALOG_URL);
  if (!payload || payload.schema_version !== 1 || !Array.isArray(payload.platforms)) {
    throw new Error('Firmwarekatalog liefert kein bekanntes Schema (Version 1 erwartet).');
  }
  const branches = new Map(BRANCHES.map((branch) => [branch, []]));
  const problems = [];
  for (const platform of payload.platforms) {
    const slug = text(platform && platform.slug);
    if (!slug) {
      problems.push('Ein Katalogeintrag nennt keine Plattform.');
      continue;
    }
    const entries = (platform && platform.branches) || {};
    for (const branch of BRANCHES) {
      const entry = entries[branch];
      if (entry === null || entry === undefined) continue;
      try {
        branches.get(branch).push({
          ...branchArtifact(entry, slug, catalogUrl),
          chipFamily: text(platform.chip_family) || null,
          flashOffset: text(platform.flash_offset) || null,
        });
      } catch (error) {
        problems.push(`${slug}/${branch}: ${error.message}`);
      }
    }
  }
  const releases = [];
  for (const branch of BRANCHES) {
    const candidates = branches.get(branch);
    if (!candidates.length) continue;
    const version = candidates
      .map((candidate) => candidate.version)
      .reduce((best, next) => (compareSemVer(next, best) > 0 ? next : best));
    const chosen = candidates.filter((candidate) => candidate.version === version);
    for (const skipped of candidates.filter((candidate) => candidate.version !== version)) {
      problems.push(`${skipped.artifact.platform}/${branch}: Version ${skipped.version} bleibt liegen,`
        + ` der Kanal führt ${version}.`);
    }
    const publishedAt = chosen
      .map((candidate) => candidate.releasedAt)
      .filter(Boolean)
      .sort()
      .pop() || null;
    releases.push({
      channel: branch,
      manifest: {
        schema_version: 1,
        release: {
          firmware_name: FIRMWARE_NAME,
          version,
          channel: branch,
          published_at: publishedAt,
          build_id: null,
          protocol_min: PROTOCOL_VERSION,
          protocol_max: PROTOCOL_VERSION,
          // Der Katalog nennt kein Konfigurationsschema. Offen lassen statt
          // raten: Der Adapter überspringt die Schemaprüfung dann und das
          // Gerät entscheidet beim Empfang.
          config_schema_version: null,
          release_notes: chosen.map((candidate) => candidate.releaseNotes).find(Boolean) || '',
        },
        artifacts: chosen.map((candidate) => ({ ...candidate.artifact })),
      },
      downloads: new Map(chosen.map((candidate) => [candidate.artifact.filename, candidate.downloadUrl])),
      platforms: chosen.map((candidate) => ({
        platform: candidate.artifact.platform,
        chip_family: candidate.chipFamily,
        flash_offset: candidate.flashOffset,
      })),
    });
  }
  return { generatedAt: text(payload.generated_at) || null, releases, problems };
}

class FirmwareCatalog {
  constructor(url = DEFAULT_CATALOG_URL, options = {}) {
    this.url = normalizeCatalogUrl(url);
    this.requestImpl = options.requestImpl;
  }

  async fetch() {
    const bytes = await requestBuffer(this.url, {
      requestImpl: this.requestImpl,
      maxBytes: CATALOG_MAX_BYTES,
      accept: 'application/json',
    });
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
      throw new Error('Firmwarekatalog lieferte kein gültiges JSON.');
    }
    return catalogManifests(payload, { catalogUrl: this.url });
  }

  artifact(downloadUrl, expectedSize) {
    const size = Number(expectedSize);
    if (!Number.isInteger(size) || size < 1 || size > ARTIFACT_MAX_BYTES) {
      return Promise.reject(new Error('Firmwareartefakt überschreitet die zulässige Größe.'));
    }
    let url;
    try {
      url = normalizeDownloadUrl(downloadUrl, this.url);
    } catch (error) {
      return Promise.reject(error);
    }
    return requestBuffer(url, {
      requestImpl: this.requestImpl,
      maxBytes: size,
      accept: 'application/octet-stream',
    });
  }
}

module.exports = {
  FirmwareCatalog, catalogManifests, normalizeCatalogUrl, normalizeDownloadUrl,
  parseArtifactName, DEFAULT_CATALOG_URL, FIRMWARE_NAME, BRANCHES,
  CATALOG_MAX_BYTES, ARTIFACT_MAX_BYTES,
};
