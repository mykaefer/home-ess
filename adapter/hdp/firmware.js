'use strict';

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { bindingHeaders } = require('./auth');
const { parseSemVer, compareSemVer, compatibleProtocol } = require('./validation');

function validateManifest(input) {
  if (!input || input.schema_version !== 1 || !input.release || !Array.isArray(input.artifacts)) {
    throw new Error('Ungültiges Firmware-Release-Manifest (Schema 1 erwartet).');
  }
  const release = input.release;
  parseSemVer(release.version);
  if (!release.firmware_name || !['stable', 'beta', 'development'].includes(release.channel)) {
    throw new Error('Firmware-Name oder Release-Kanal ist ungültig.');
  }
  const artifacts = input.artifacts.map((artifact) => {
    if (!artifact.platform || !artifact.board || !artifact.variant || !artifact.filename) {
      throw new Error('Firmwareartefakt ist unvollständig.');
    }
    if (!Number.isInteger(artifact.size_bytes) || artifact.size_bytes < 1) throw new Error('Artefaktgröße ist ungültig.');
    if (!/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ''))) throw new Error('Artefakt-SHA-256 ist ungültig.');
    return { ...artifact };
  });
  return { schema_version: 1, release: { ...release }, artifacts };
}

function selectArtifact(manifest, firmwareInfo) {
  const valid = validateManifest(manifest);
  const artifact = valid.artifacts.find((item) =>
    item.platform === firmwareInfo.platform
    && item.board === firmwareInfo.board
    && item.variant === firmwareInfo.variant);
  if (!artifact) throw new Error('Kein Firmwareartefakt passt exakt zu Plattform, Board und Variante.');
  return artifact;
}

function checkCompatibility(manifest, artifact, firmwareInfo, options = {}) {
  const release = manifest.release;
  if (release.firmware_name !== firmwareInfo.name) throw new Error('Firmware-Familie stimmt nicht überein.');
  if (artifact.platform !== firmwareInfo.platform) throw new Error('Firmware-Plattform stimmt nicht überein.');
  if (artifact.board !== firmwareInfo.board) throw new Error('Firmware-Board stimmt nicht überein.');
  if (artifact.variant !== firmwareInfo.variant) throw new Error('Firmware-Variante stimmt nicht überein.');
  if (!compatibleProtocol(firmwareInfo.protocol_version, release.protocol_min)
      || !compatibleProtocol(firmwareInfo.protocol_version, release.protocol_max)) {
    throw new Error('Firmware und HDP-Protokoll sind nicht kompatibel.');
  }
  if (Number(release.config_schema_version) !== Number(firmwareInfo.config_schema_version)) {
    throw new Error('Konfigurationsschema kann nicht sicher migriert werden.');
  }
  if (compareSemVer(release.version, firmwareInfo.version) < 0 && !options.allowDowngrade) {
    throw new Error('Firmware-Downgrade ist nicht freigegeben.');
  }
  const limit = Math.min(
    Number(firmwareInfo.maximum_image_size_bytes) || Infinity,
    Number(firmwareInfo.free_update_space_bytes) || Infinity
  );
  if (artifact.size_bytes > limit) throw new Error('Firmwareartefakt ist für den verfügbaren OTA-Speicher zu groß.');
  if (!firmwareInfo.ota_supported) throw new Error('Das Gerät unterstützt kein OTA.');
  return true;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => { size += chunk.length; hash.update(chunk); });
    input.on('error', reject);
    input.on('end', () => resolve({ size, sha256: hash.digest('hex') }));
  });
}

function signatureBytes(signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return null;
  const decoded = Buffer.from(signature, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== signature) return null;
  return decoded;
}

function verifySignature(file, signature, publicKey) {
  if (!signature) return { status: 'not_present', verified: false };
  if (!publicKey) return { status: 'not_configured', verified: false };
  const bytes = signatureBytes(signature);
  if (!bytes) return { status: 'invalid', verified: false };
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest();
  const ok = crypto.verify(null, digest, publicKey, bytes);
  return { status: ok ? 'verified' : 'invalid', verified: ok };
}

async function validateArtifactFile(file, artifact, options = {}) {
  const digest = await hashFile(file);
  if (digest.size !== artifact.size_bytes) throw new Error('Firmwaredateigröße stimmt nicht mit dem Manifest überein.');
  if (digest.sha256 !== artifact.sha256) throw new Error('SHA-256-Prüfsumme der Firmwaredatei stimmt nicht.');
  const signature = verifySignature(file, artifact.signature, options.publicKey);
  if (options.requireSignature && !signature.verified) {
    throw new Error(signature.status === 'not_configured'
      ? 'Signaturprüfung ist nicht konfiguriert.'
      : signature.status === 'not_present'
        ? 'Das Releaseartefakt besitzt keine authentifizierbare Signatur.'
      : 'Firmware-Signatur ist ungültig.');
  }
  return { ...digest, signature };
}

function otaHeaders(manifest, artifact, firmwareInfo, credentials, allowDowngrade) {
  const release = manifest.release;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(artifact.size_bytes),
    'X-HDP-Firmware-Name': release.firmware_name,
    'X-HDP-Firmware-Version': release.version,
    'X-HDP-Firmware-Channel': release.channel,
    'X-HDP-Platform': artifact.platform,
    'X-HDP-Board': artifact.board,
    'X-HDP-Variant': artifact.variant,
    'X-HDP-Protocol-Version': firmwareInfo.protocol_version,
    'X-HDP-Config-Schema-Version': String(release.config_schema_version),
    'X-HDP-Firmware-Size': String(artifact.size_bytes),
    'X-HDP-Firmware-SHA256': artifact.sha256,
    'X-HDP-Restart-After-Success': 'false',
    ...bindingHeaders(credentials),
  };
  if (artifact.signature) headers['X-HDP-Firmware-Signature'] = artifact.signature;
  if (allowDowngrade) headers['X-HDP-Allow-Downgrade'] = 'true';
  return headers;
}

function uploadFirmware({ file, device, firmwareInfo, manifest, artifact, credentials, allowDowngrade = false, onProgress }) {
  const host = device.address || device.hostname;
  const port = Number(device.otaPort || firmwareInfo.ota_port);
  if (!port) return Promise.reject(new Error('Gerät hat keinen OTA-Port gemeldet.'));
  const path = '/api/v1/firmware/update';
  const headers = otaHeaders(manifest, artifact, firmwareInfo, credentials, allowDowngrade);
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'POST', headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(text); } catch (_) {
          reject(new Error('OTA-Antwort ist kein gültiges JSON.'));
          return;
        }
        const contentType = String(res.headers['content-type'] || '').toLowerCase().trim();
        const noStore = String(res.headers['cache-control'] || '').toLowerCase().split(',').map((v) => v.trim()).includes('no-store');
        if (contentType !== 'application/json' || !noStore) {
          reject(new Error('OTA-Antwort verletzt HDP Content-Type oder Cache-Control.'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const remote = payload.error || {};
          reject(Object.assign(new Error(remote.message || `OTA HTTP ${res.statusCode}`), { code: remote.code }));
        } else if (res.statusCode !== 202 || payload.ok !== true || !payload.data
            || payload.data.state !== 'ready_to_restart' || payload.data.restart_required !== true) {
          reject(new Error('OTA-Erfolgsantwort entspricht nicht HDP 1.0-draft.'));
        } else resolve(payload.data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('OTA-Upload-Zeitüberschreitung.')));
    req.on('error', reject);
    let sent = 0;
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress({ sent, total: artifact.size_bytes, percent: Math.floor(sent * 100 / artifact.size_bytes) });
    });
    input.on('error', (err) => req.destroy(err));
    input.pipe(req);
  });
}

class ReleaseService {
  constructor(options = {}) {
    this.source = options.source || '';
    this.publicKey = options.publicKey || null;
  }

  choose(manifest, firmwareInfo) {
    const valid = validateManifest(manifest);
    const artifact = selectArtifact(valid, firmwareInfo);
    checkCompatibility(valid, artifact, firmwareInfo);
    return { manifest: valid, artifact };
  }
}

module.exports = {
  validateManifest, selectArtifact, checkCompatibility, hashFile, signatureBytes, verifySignature,
  validateArtifactFile, otaHeaders, uploadFirmware, ReleaseService,
};
