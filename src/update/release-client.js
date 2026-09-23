'use strict';

// Onlineprüfung der verfügbaren Version.
//
// Maßgeblich ist die VERSION.json des eingestellten Zweigs, nicht mehr das
// neueste GitHub-Release: nur so können `main` und `development` gleichzeitig
// unterschiedliche Versionsnummern führen. Abgerufen wird ausschließlich eine
// aus der festen Zweigliste gebildete Adresse.

const https = require('https');
const { normalizeVersion, parseVersionFile } = require('./version');
const branches = require('./branches');

const MAX_RESPONSE_BYTES = 64 * 1024;

function requestText(url, { etag, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/json, text/plain;q=0.5',
      'User-Agent': 'homeESS-update-check',
    };
    if (etag) headers['If-None-Match'] = etag;

    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      if (response.statusCode === 304) {
        response.resume();
        resolve({ notModified: true, etag: response.headers.etag || etag });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub antwortet mit HTTP ${response.statusCode}.`));
        return;
      }

      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Die Versionsdatei ist unerwartet groß.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        etag: response.headers.etag || null,
        lastModified: response.headers['last-modified'] || null,
      }));
    });
    request.on('timeout', () => request.destroy(new Error('GitHub-Zeitüberschreitung.')));
    request.on('error', reject);
  });
}

// Version des Zweigs abrufen. `notModified` wird durchgereicht, damit der
// Dienst den zwischengespeicherten Stand behalten kann.
async function fetchBranchVersion(options = {}) {
  const branch = branches.normalizeBranch(options.branch);
  const result = await requestText(branches.versionFileUrl(branch), options);
  if (result.notModified) return { ...result, branch };
  const version = normalizeVersion(parseVersionFile(result.text));
  if (!version) {
    throw new Error('Die Versionsdatei des Zweigs enthält keine gültige Version.');
  }
  return {
    version,
    branch,
    url: branches.branchWebUrl(branch),
    publishedAt: result.lastModified ? new Date(result.lastModified).toISOString() : null,
    etag: result.etag,
  };
}

module.exports = { requestText, fetchBranchVersion };
