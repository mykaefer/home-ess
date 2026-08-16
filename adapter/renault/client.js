'use strict';

const https = require('https');

const LOCALE_BASE_URL = 'https://renault-wrd-prod-1-euw1-myrapp-one.s3-eu-west-1.amazonaws.com';
const EUROPE_SERVERS = Object.freeze({
  gigyaProd: Object.freeze({
    target: 'https://accounts.eu1.gigya.com',
    apikey: '3_VgdkgtIRH3AdHvJm-cjV2ug2EFE0lxt0IJzMC4MFqZjFpn_GYFXVdNZ19L7wZX0N',
  }),
  wiredProd: Object.freeze({
    target: 'https://api-wired-prod-1-euw1.wrd-aws.com',
    apikey: 'YjkKtHmGfaceeuExUDKGxrLZGGvtVS0J',
  }),
});
const KNOWN_LOCALES = new Set(['de_DE', 'de_AT', 'de_CH', 'fr_FR', 'nl_NL', 'en_GB']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;

function requestJson(url, { method = 'GET', headers = {}, form, json } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') return Promise.reject(new Error('Renault-Anfragen benötigen HTTPS.'));
  let body = null;
  if (form) body = new URLSearchParams(form).toString();
  else if (json != null) body = JSON.stringify(json);
  const requestHeaders = { Accept: 'application/json', 'User-Agent': 'homeESS-renault/1.0', ...headers };
  if (body != null) {
    requestHeaders['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/vnd.api+json';
    requestHeaders['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(target, { method, headers: requestHeaders, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('Renault-Antwort ist zu groß.'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = text ? JSON.parse(text) : {}; }
        catch (_) { reject(new Error(`Renault-Cloud antwortete mit ungültigem JSON (HTTP ${res.statusCode}).`)); return; }
        const apiError = payload.errorDetails || payload.errors || payload.messages;
        const hasApiError = Array.isArray(apiError)
          ? apiError.length > 0
          : !!(apiError && (typeof apiError !== 'object' || Object.keys(apiError).length));
        if (res.statusCode < 200 || res.statusCode >= 300 || Number(payload.errorCode) > 0 || hasApiError) {
          const first = Array.isArray(apiError) ? apiError[0] : apiError;
          const detail = first && (first.errorMessage || first.message || first.errorCode)
            || payload.errorMessage || payload.statusReason || '';
          const error = new Error(`Renault-Cloud HTTP ${res.statusCode}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
          error.statusCode = res.statusCode;
          error.apiCode = payload.errorCode || (first && first.errorCode);
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung bei der Renault-Cloud.')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function firstPath(value, paths) {
  for (const path of paths) {
    const result = getPath(value, path);
    if (result !== undefined && result !== null && result !== '') return result;
  }
  return undefined;
}

function attributes(payload) {
  return firstPath(payload, ['data.attributes', 'attributes']) || {};
}

function accountRows(payload) {
  const rows = firstPath(payload, ['accounts', 'data.accounts', 'data.attributes.accounts']);
  return Array.isArray(rows) ? rows : [];
}

function vehicleRows(payload) {
  const rows = firstPath(payload, ['vehicleLinks', 'vehicles', 'data.vehicleLinks', 'data.vehicles']);
  return Array.isArray(rows) ? rows : [];
}

function vehicleVin(row) {
  return String(firstPath(row, ['vin', 'vehicleDetails.vin', 'vehicle.vin']) || '').trim().toUpperCase();
}

class RenaultClient {
  constructor({ locale = 'de_DE', request = requestJson, loginToken = null } = {}) {
    this.locale = /^[a-z]{2}_[A-Z]{2}$/.test(String(locale)) ? String(locale) : 'de_DE';
    this.country = this.locale.slice(-2);
    this.request = request;
    this.loginToken = loginToken || null;
    this.servers = null;
    this.jwt = null;
    this.jwtExpiresAt = 0;
  }

  async loadServers() {
    if (this.servers) return this.servers;
    // Renaults öffentliche App-Konfigurationsdatei antwortet zeitweise mit
    // HTTP 403. Der Referenzclient führt bekannte Regionen deshalb lokal und
    // lädt die Datei nur für unbekannte Locales nach.
    if (KNOWN_LOCALES.has(this.locale)) {
      this.servers = EUROPE_SERVERS;
      return this.servers;
    }
    const config = await this.request(`${LOCALE_BASE_URL}/configuration/android/config_${this.locale}.json`);
    const servers = config && config.servers;
    if (!servers || !servers.gigyaProd || !servers.wiredProd) throw new Error(`Renault-Konfiguration für ${this.locale} ist unvollständig.`);
    for (const name of ['gigyaProd', 'wiredProd']) {
      const target = new URL(servers[name].target);
      if (target.protocol !== 'https:') throw new Error('Renault-Konfiguration enthält eine unsichere Serveradresse.');
    }
    this.servers = servers;
    return servers;
  }

  async login(username, password) {
    const servers = await this.loadServers();
    const response = await this.request(`${servers.gigyaProd.target}/accounts.login`, {
      method: 'POST',
      form: { ApiKey: servers.gigyaProd.apikey, loginID: username, password },
    });
    const token = firstPath(response, ['sessionInfo.cookieValue', 'sessionInfo.login_token', 'login_token']);
    if (!token) throw new Error('Renault-Anmeldung lieferte kein Login-Token.');
    this.loginToken = String(token);
    this.jwt = null;
    return this.loginToken;
  }

  async gigya(endpoint, fields) {
    if (!this.loginToken) throw new Error('Renault-Anmeldung fehlt oder ist abgelaufen.');
    const servers = await this.loadServers();
    return this.request(`${servers.gigyaProd.target}/${endpoint}`, {
      method: 'POST',
      form: { ApiKey: servers.gigyaProd.apikey, login_token: this.loginToken, ...fields },
    });
  }

  async getJwt(force = false) {
    if (!force && this.jwt && Date.now() < this.jwtExpiresAt) return this.jwt;
    const response = await this.gigya('accounts.getJWT', {
      fields: 'data.personId,data.gigyaDataCenter', expiration: '900',
    });
    const jwt = firstPath(response, ['id_token', 'data.id_token']);
    if (!jwt) throw new Error('Renault-Anmeldung lieferte kein Zugriffstoken.');
    this.jwt = String(jwt);
    this.jwtExpiresAt = Date.now() + 12 * 60 * 1000;
    return this.jwt;
  }

  async getPersonId() {
    const response = await this.gigya('accounts.getAccountInfo');
    const id = firstPath(response, ['data.personId', 'personId']);
    if (!id) throw new Error('Renault-Konto enthält keine Personen-ID.');
    return String(id);
  }

  async kamereon(path, { method = 'GET', json } = {}, retry = true) {
    const servers = await this.loadServers();
    const separator = path.includes('?') ? '&' : '?';
    try {
      return await this.request(`${servers.wiredProd.target}${path}${separator}country=${encodeURIComponent(this.country)}`, {
        method,
        json,
        headers: {
          apikey: servers.wiredProd.apikey,
          'x-gigya-id_token': await this.getJwt(),
        },
      });
    } catch (error) {
      if (retry && (error.statusCode === 401 || error.statusCode === 403)) {
        this.jwt = null;
        return this.kamereon(path, { method, json }, false);
      }
      throw error;
    }
  }

  async getPerson() {
    return this.kamereon(`/commerce/v1/persons/${encodeURIComponent(await this.getPersonId())}`);
  }

  async getVehicles(accountId) {
    return this.kamereon(`/commerce/v1/accounts/${encodeURIComponent(accountId)}/vehicles`);
  }

  carPath(accountId, vin, version, endpoint) {
    return `/commerce/v1/accounts/${encodeURIComponent(accountId)}/kamereon/kca/car-adapter/v${version}/cars/${encodeURIComponent(vin)}/${endpoint}`;
  }

  getVehicleData(accountId, vin, version, endpoint) {
    return this.kamereon(this.carPath(accountId, vin, version, endpoint));
  }

  setVehicleAction(accountId, vin, endpoint, type, attributesValue) {
    return this.kamereon(this.carPath(accountId, vin, 1, `actions/${endpoint}`), {
      method: 'POST', json: { data: { type, attributes: attributesValue } },
    });
  }
}

module.exports = {
  RenaultClient, requestJson, attributes, accountRows, vehicleRows, vehicleVin, firstPath,
  LOCALE_BASE_URL, EUROPE_SERVERS,
};
