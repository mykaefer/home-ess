'use strict';

const https = require('https');
const { normalizeVersion } = require('./version');

const RELEASE_API_URL = 'https://api.github.com/repos/mykaefer/home-ess/releases/latest';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requestJson(url, { etag, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'homeESS-update-check',
      'X-GitHub-Api-Version': '2022-11-28',
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
          request.destroy(new Error('GitHub-Antwort ist unerwartet groß.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve({
            data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            etag: response.headers.etag || null,
          });
        } catch (_) {
          reject(new Error('GitHub hat keine gültige Release-Antwort geliefert.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('GitHub-Zeitüberschreitung.')));
    request.on('error', reject);
  });
}

async function fetchLatestRelease(options = {}) {
  const result = await requestJson(RELEASE_API_URL, options);
  if (result.notModified) return result;
  const version = normalizeVersion(result.data && result.data.tag_name);
  if (!version || result.data.draft || result.data.prerelease) {
    throw new Error('Das neueste GitHub-Release besitzt keine gültige stabile Version.');
  }
  return {
    version,
    tag: `v${version}`,
    url: result.data.html_url || `https://github.com/mykaefer/home-ess/releases/tag/v${version}`,
    publishedAt: result.data.published_at || null,
    etag: result.etag,
  };
}

module.exports = { RELEASE_API_URL, requestJson, fetchLatestRelease };
