'use strict';

// Lesender InfluxDB-1.x-Client des Kerns.
//
// Bewusst eigenständig und nicht aus `adapter/influxdb/` importiert: Adapter
// sind austauschbar und können gelöscht werden, die systemweite Anbindung muss
// aber auch dann funktionieren, wenn gar kein Influx-Adapter installiert ist
// (externe Datenbank). Geschrieben wird hier nichts — das bleibt Sache des
// Adapters; der Kern liest ausschließlich (`/ping`, `/query`).

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Bezeichner (Messreihe, Datenbank, Feld) für InfluxQL in Anführungszeichen
// setzen. Anführungszeichen im Namen werden verdoppelt — damit kann ein Name
// die Abfrage nicht verlassen.
function quoteIdentifier(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '\\"')}"`;
}

// Zeichenkette als InfluxQL-Literal.
function quoteLiteral(value) {
  return `'${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Zeitfenster in Millisekunden → InfluxQL-Zeitausdruck.
function timeLiteral(ms) {
  return `${Math.round(Number(ms))}ms`;
}

// Erlaubte Aggregatfunktionen. Alles andere wird abgelehnt, statt es in die
// Abfrage durchzureichen.
const AGGREGATES = new Set(['mean', 'min', 'max', 'sum', 'last', 'first', 'count']);

// Umgang mit Rasterpunkten ohne Messwert (Lücken in der Aufzeichnung). Der
// Schlüssel kommt aus der Diagrammkonfiguration, der Wert ist das InfluxQL-
// Argument von `fill(...)`:
//   none/connect – die Datenbank liefert nur vorhandene Punkte; ob die Linie
//                  über die Lücke gezogen oder unterbrochen wird, entscheidet
//                  allein die Zeichnung (src/dashboard/chart-svg.js).
//   previous     – der letzte bekannte Wert wird gehalten.
//   zero         – die Lücke wird als 0 gewertet.
// Alles Unbekannte fällt auf `none` zurück, statt in die Abfrage zu gelangen.
const FILL_MODES = new Map([
  ['none', 'none'],
  ['connect', 'none'],
  ['previous', 'previous'],
  ['zero', '0'],
]);

function fillArgument(value) {
  return FILL_MODES.get(String(value == null ? '' : value)) || 'none';
}

class InfluxReader {
  constructor(options = {}) {
    this.protocol = options.protocol === 'https' ? 'https' : 'http';
    this.host = String(options.host || '127.0.0.1');
    this.port = Number(options.port) || 8086;
    this.database = String(options.database || 'homeess');
    this.username = String(options.username || '');
    this.password = String(options.password || '');
    this.verifyTls = options.verifyTls !== false && options.verifyTls !== 0;
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  }

  get baseUrl() {
    return `${this.protocol}://${this.host}:${this.port}`;
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
      request.on('timeout', () => request.destroy(new Error('Zeitüberschreitung bei der Verbindung zur Datenbank.')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  // Erreichbarkeit und Version.
  async ping() {
    const response = await this.request('GET', '/ping?verbose=true');
    if (response.status !== 200 && response.status !== 204) {
      throw new Error(`Die Datenbank antwortet mit Status ${response.status}.`);
    }
    return { version: String(response.headers['x-influxdb-version'] || '') };
  }

  async query(statement, options = {}) {
    const parameters = new URLSearchParams({ q: statement, epoch: 'ms' });
    if (options.database !== false) parameters.set('db', this.database);
    const response = await this.request(
      'POST',
      `/query?${parameters.toString()}`,
      '',
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );
    if (response.status === 401 || response.status === 403) {
      throw new Error('Anmeldung an der Datenbank fehlgeschlagen (Benutzername oder Kennwort).');
    }
    if (response.status === 404) {
      throw new Error(`Datenbank „${this.database}" existiert nicht.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Die Datenbank lehnt die Abfrage ab (Status ${response.status}): ${response.body.slice(0, 200)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(response.body || '{}');
    } catch (_) {
      throw new Error('Die Datenbank liefert keine gültige Antwort.');
    }
    const failure = parsed && parsed.results && parsed.results.find((entry) => entry && entry.error);
    if (failure) throw new Error(String(failure.error));
    return parsed;
  }

  static series(result, index = 0) {
    const entry = result && result.results && result.results[index];
    return entry && Array.isArray(entry.series) ? entry.series : [];
  }

  static rows(result) {
    const series = InfluxReader.series(result);
    return series[0] && Array.isArray(series[0].values) ? series[0].values : [];
  }

  // Alle Messreihen der Datenbank (Namen der Zeitreihen für die Auswahl im
  // Diagramm).
  async listMeasurements() {
    const result = await this.query('SHOW MEASUREMENTS');
    return InfluxReader.rows(result).map((row) => String(row[0])).filter(Boolean);
  }

  // Vorhandene Tag-Werte einer Messreihe, z. B. instance=<Adapterinstanz>.
  async listTagValues(measurement, tagKey) {
    const result = await this.query(
      `SHOW TAG VALUES FROM ${quoteIdentifier(measurement)} WITH KEY = ${quoteIdentifier(tagKey)}`
    );
    return InfluxReader.rows(result).map((row) => String(row[1])).filter(Boolean);
  }

  // Zeitreihe einer Messreihe lesen.
  //   from/to        – Zeitfenster in Millisekunden
  //   intervalMs     – Rasterweite; 0 = Rohwerte ohne Verdichtung
  //   aggregate      – mean/min/max/sum/last/first/count (nur mit Raster)
  //   field          – Feldname, Standard `value` (so schreibt der Adapter)
  //   fill           – Lückenbehandlung (siehe FILL_MODES; nur mit Raster)
  //   tags           – zusätzliche Gleichheitsfilter, z. B. { instance: 'Haus' }
  //   limit          – Obergrenze der zurückgegebenen Punkte
  async readSeries(options = {}) {
    const measurement = String(options.measurement || '').trim();
    if (!measurement) throw new Error('Ohne Messreihe kann nichts gelesen werden.');
    const to = Number(options.to) || Date.now();
    const from = Number(options.from) || (to - 24 * 60 * 60 * 1000);
    if (!(from < to)) throw new Error('Das Zeitfenster ist leer.');
    const field = String(options.field || 'value').trim() || 'value';
    const intervalMs = Math.max(0, Math.round(Number(options.intervalMs) || 0));
    const aggregate = AGGREGATES.has(String(options.aggregate)) ? String(options.aggregate) : 'mean';
    const limit = Math.min(Math.max(1, Math.round(Number(options.limit) || 5000)), 20000);

    const filters = [`time >= ${timeLiteral(from)}`, `time <= ${timeLiteral(to)}`];
    for (const [key, value] of Object.entries(options.tags || {})) {
      if (!key || value == null || value === '') continue;
      filters.push(`${quoteIdentifier(key)} = ${quoteLiteral(value)}`);
    }

    const selection = intervalMs > 0
      ? `${aggregate}(${quoteIdentifier(field)})`
      : quoteIdentifier(field);
    const fill = fillArgument(options.fill);
    const grouping = intervalMs > 0
      ? ` GROUP BY time(${timeLiteral(intervalMs)}) fill(${fill})`
      : '';
    const statement = `SELECT ${selection} FROM ${quoteIdentifier(measurement)}`
      + ` WHERE ${filters.join(' AND ')}${grouping} LIMIT ${limit}`;

    const result = await this.query(statement);
    const rows = InfluxReader.rows(result);
    const points = [];
    for (const row of rows) {
      const timestamp = Number(row[0]);
      const raw = row[1];
      if (!Number.isFinite(timestamp) || raw == null) continue;
      const numeric = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      points.push({ t: timestamp, v: Number.isFinite(numeric) ? numeric : raw });
    }
    return { measurement, field, from, to, intervalMs, aggregate, fill, points };
  }
}

module.exports = { InfluxReader, AGGREGATES, FILL_MODES, quoteIdentifier, quoteLiteral, timeLiteral };
