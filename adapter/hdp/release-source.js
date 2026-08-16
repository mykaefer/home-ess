'use strict';

const https = require('https');

const MANIFEST_MAX_BYTES = 256 * 1024;
const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new Error('Firmware-Releasequelle ist keine gültige URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Firmware-Releasequelle muss HTTPS verwenden.');
  if (url.username || url.password) throw new Error('Firmware-Releasequelle darf keine Zugangsdaten in der URL enthalten.');
  if (url.search || url.hash) throw new Error('Firmware-Releasequelle darf keine Abfrage oder Sprungmarke enthalten.');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function requestBuffer(url, options = {}) {
  const limit = Number(options.maxBytes) || MANIFEST_MAX_BYTES;
  const requestImpl = options.requestImpl || https.request;
  const accept = options.accept || '*/*';
  return new Promise((resolve, reject) => {
    const req = requestImpl(url, {
      method: 'GET',
      headers: { Accept: accept, 'User-Agent': 'homeESS-hDP-release-client/1' },
      timeout: Number(options.timeoutMs) || REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Releasequelle antwortete mit HTTP ${res.statusCode}.`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        res.resume();
        reject(new Error('Antwort der Releasequelle ist zu groß.'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          req.destroy(new Error('Antwort der Releasequelle ist zu groß.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Abruf der Firmware-Releasequelle.')));
    req.on('error', reject);
    req.end();
  });
}

class ReleaseSource {
  constructor(baseUrl, options = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.requestImpl = options.requestImpl;
  }

  channelUrl(channel, filename) {
    return new URL(`${encodeURIComponent(channel)}/${encodeURIComponent(filename)}`, this.baseUrl);
  }

  async manifest(channel) {
    const bytes = await requestBuffer(this.channelUrl(channel, 'manifest.json'), {
      requestImpl: this.requestImpl,
      maxBytes: MANIFEST_MAX_BYTES,
      accept: 'application/json',
    });
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch (_) {
      throw new Error('Releasequelle lieferte kein gültiges JSON-Manifest.');
    }
  }

  artifact(channel, filename, expectedSize) {
    const size = Number(expectedSize);
    if (!Number.isInteger(size) || size < 1 || size > ARTIFACT_MAX_BYTES) {
      return Promise.reject(new Error('Firmwareartefakt überschreitet die zulässige Größe.'));
    }
    return requestBuffer(this.channelUrl(channel, filename), {
      requestImpl: this.requestImpl,
      maxBytes: size,
      accept: 'application/octet-stream',
    });
  }
}

module.exports = {
  ReleaseSource, normalizeBaseUrl, requestBuffer,
  MANIFEST_MAX_BYTES, ARTIFACT_MAX_BYTES, REQUEST_TIMEOUT_MS,
};
