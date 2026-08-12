'use strict';

// Schmaler HTTP-Client für InfluxDB 1.x. Kennt weder homeESS noch den Adapter:
// er spricht ausschließlich /ping, /query (InfluxQL) und /write (Line Protocol).
// Keine externen Abhängigkeiten — http/https aus Node genügen.

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 262144;

// Line-Protocol-Escaping: Messreihen- und Tag-Namen dürfen Komma, Leerzeichen
// und Gleichheitszeichen nur maskiert enthalten.
function escapeKey(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/ /g, '\\ ')
    .replace(/=/g, '\\=');
}

function escapeStringValue(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Einen Messpunkt in das Line Protocol übersetzen. Zahlen bleiben Zahlen,
// Booleans werden zu true/false, alles andere zu einem Textfeld.
function formatPoint(measurement, value, timestampMs, tags = {}) {
  const name = escapeKey(measurement);
  if (!name) return '';
  const tagPart = Object.entries(tags)
    .filter(([key, tagValue]) => key && tagValue !== undefined && tagValue !== null && tagValue !== '')
    .map(([key, tagValue]) => `,${escapeKey(key)}=${escapeKey(tagValue)}`)
    .join('');
  let field;
  if (typeof value === 'number' && Number.isFinite(value)) field = `value=${value}`;
  else if (typeof value === 'boolean') field = `value=${value ? 'true' : 'false'}`;
  else {
    const text = String(value == null ? '' : value);
    if (!text) return '';
    const numeric = Number(text.replace(',', '.'));
    field = Number.isFinite(numeric) && text.trim() !== ''
      ? `value=${numeric}`
      : `value="${escapeStringValue(text)}"`;
  }
  return `${name}${tagPart} ${field} ${Math.round(timestampMs)}`;
}

// Aufbewahrungsdauer → Name der Retention Policy. Je Dauer genau eine Policy;
// so kann jeder State seine eigene Keepalive-Zeit haben.
function retentionPolicyName(days) {
  const value = Math.max(0, Math.round(Number(days) || 0));
  return value > 0 ? `homeess_${value}d` : 'homeess_forever';
}

function retentionDuration(days) {
  const value = Math.max(0, Math.round(Number(days) || 0));
  return value > 0 ? `${value}d` : 'INF';
}

class InfluxClient {
  constructor(options = {}) {
    this.protocol = options.protocol === 'https' ? 'https' : 'http';
    this.host = String(options.host || '127.0.0.1');
    this.port = Number(options.port) || 8086;
    this.database = String(options.database || 'homeess');
    this.username = String(options.username || '');
    this.password = String(options.password || '');
    this.verifyTls = options.verifyTls !== false;
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  }

  get baseUrl() {
    return `${this.protocol}://${this.host}:${this.port}`;
  }

  isLocal() {
    const host = this.host.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  authHeader() {
    if (!this.username) return {};
    const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  request(method, path, body, headers = {}) {
    const transport = this.protocol === 'https' ? https : http;
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(body, 'utf8');
      const request = transport.request({
        method,
        host: this.host,
        port: this.port,
        path,
        timeout: this.timeoutMs,
        rejectUnauthorized: this.protocol === 'https' ? this.verifyTls : undefined,
        headers: {
          ...this.authHeader(),
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on('end', () => resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('timeout', () => request.destroy(new Error('Zeitüberschreitung bei der Verbindung zur InfluxDB.')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  // Erreichbarkeit und Version. InfluxDB meldet die Version im Header.
  async ping() {
    const response = await this.request('GET', '/ping?verbose=true');
    if (response.status !== 200 && response.status !== 204) {
      throw new Error(`InfluxDB antwortet mit Status ${response.status}.`);
    }
    const version = response.headers['x-influxdb-version'] || '';
    return { version: String(version), build: String(response.headers['x-influxdb-build'] || '') };
  }

  async query(statement, options = {}) {
    const parameters = new URLSearchParams({ q: statement });
    if (options.database !== false) parameters.set('db', this.database);
    const response = await this.request(
      'POST',
      `/query?${parameters.toString()}`,
      '',
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );
    if (response.status === 401 || response.status === 403) {
      throw new Error('Anmeldung an der InfluxDB fehlgeschlagen (Benutzername oder Kennwort).');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`InfluxDB lehnt die Abfrage ab (Status ${response.status}): ${response.body.slice(0, 200)}`);
    }
    try {
      return JSON.parse(response.body || '{}');
    } catch (_) {
      return {};
    }
  }

  // Werte der ersten Serie einer Abfrage als Array von Zeilen.
  static rows(result) {
    const series = result && result.results && result.results[0] && result.results[0].series;
    return series && series[0] && Array.isArray(series[0].values) ? series[0].values : [];
  }

  async listDatabases() {
    const result = await this.query('SHOW DATABASES', { database: false });
    return InfluxClient.rows(result).map((row) => String(row[0]));
  }

  async listRetentionPolicies() {
    const result = await this.query(`SHOW RETENTION POLICIES ON "${this.database.replace(/"/g, '')}"`, { database: false });
    return InfluxClient.rows(result).map((row) => ({ name: String(row[0]), duration: String(row[1]) }));
  }

  async createDatabase() {
    await this.query(`CREATE DATABASE "${this.database.replace(/"/g, '')}"`, { database: false });
    return true;
  }

  // Policy je Aufbewahrungsdauer anlegen. Idempotent: eine vorhandene Policy
  // wird nicht verändert.
  async ensureRetentionPolicy(days, existing) {
    const name = retentionPolicyName(days);
    const policies = existing || await this.listRetentionPolicies();
    if (policies.some((policy) => policy.name === name)) return name;
    const database = this.database.replace(/"/g, '');
    await this.query(
      `CREATE RETENTION POLICY "${name}" ON "${database}" DURATION ${retentionDuration(days)} REPLICATION 1`,
      { database: false }
    );
    return name;
  }

  // Messpunkte einer Retention Policy schreiben.
  async write(lines, retentionPolicy) {
    const payload = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || '');
    if (!payload) return 0;
    const parameters = new URLSearchParams({ db: this.database, precision: 'ms' });
    if (retentionPolicy) parameters.set('rp', retentionPolicy);
    const response = await this.request(
      'POST',
      `/write?${parameters.toString()}`,
      payload,
      { 'Content-Type': 'text/plain; charset=utf-8' }
    );
    if (response.status === 401 || response.status === 403) {
      throw new Error('Schreiben abgelehnt: Anmeldung an der InfluxDB fehlgeschlagen.');
    }
    if (response.status === 404) {
      throw new Error(`Datenbank "${this.database}" existiert nicht.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Schreiben fehlgeschlagen (Status ${response.status}): ${response.body.slice(0, 200)}`);
    }
    return Array.isArray(lines) ? lines.filter(Boolean).length : 1;
  }
}

module.exports = {
  InfluxClient,
  formatPoint,
  escapeKey,
  escapeStringValue,
  retentionPolicyName,
  retentionDuration,
};
