'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-dashboard-chart-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { openDatabase } = require('../src/db');
const widgetsRepo = require('../src/dashboard/widgets');
const systemDatabase = require('../src/database');
const dashboardRoutes = require('../src/routes/dashboard');
const renderDashboard = require('../src/views/dashboard');
const { renderChartSvg, renderChartLegend, valueScale, niceStep, SERIES_COLORS } = require('../src/dashboard/chart-svg');
const { normalizeChartConfig, chartWindow, CHART_RANGES, MAX_SERIES } = require('../src/dashboard/chart-config');

// ── Konfiguration ──────────────────────────────────────────────────────────

test('die Diagramm-Konfiguration begrenzt Messreihen und prüft die Auswahllisten', () => {
  const config = normalizeChartConfig({
    measurements: ['pv.leistung', 'batterie.soc', 'pv.leistung', 'a', 'b', 'c'],
    range: '7d', aggregate: 'max', title: '  Erzeugung  ', unit: ' W ',
  });
  assert.equal(config.measurements.length, MAX_SERIES, 'höchstens vier Linien');
  assert.deepEqual(config.measurements.slice(0, 2), ['pv.leistung', 'batterie.soc']);
  assert.equal(config.measurements.filter((name) => name === 'pv.leistung').length, 1, 'keine Dubletten');
  assert.equal(config.range, '7d');
  assert.equal(config.aggregate, 'max');
  assert.equal(config.title, 'Erzeugung');
  assert.equal(config.unit, 'W');

  // Unbekannte Werte fallen auf die Vorgaben zurück.
  const fallback = normalizeChartConfig({ measurements: 'pv.leistung', range: 'ewig', aggregate: 'DROP' });
  assert.equal(fallback.range, '24h');
  assert.equal(fallback.aggregate, 'mean');
  assert.deepEqual(fallback.measurements, ['pv.leistung']);
});

test('jeder Zeitraum bringt eine Rasterweite mit, die eine flotte Kachel ergibt', () => {
  for (const range of CHART_RANGES) {
    const points = range.durationMs / range.intervalMs;
    assert.ok(points >= 100 && points <= 400, `${range.key}: ${points} Punkte je Linie`);
  }
  const window = chartWindow({ range: '24h' }, 1786531200000);
  assert.equal(window.to - window.from, 24 * 60 * 60 * 1000);
  assert.equal(window.intervalMs, 5 * 60 * 1000);
});

// ── Zeichnen ───────────────────────────────────────────────────────────────

test('die Werteachse rastet auf glatte Schritte ein', () => {
  assert.equal(niceStep(100, 4), 20);
  assert.equal(niceStep(0.9, 4), 0.2);
  const scale = valueScale([{ points: [{ t: 1, v: 3 }, { t: 2, v: 97 }] }]);
  assert.ok(scale.min <= 3 && scale.max >= 97);
  assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 8);

  // Eine flache Linie bekommt trotzdem ein sichtbares Band.
  const flat = valueScale([{ points: [{ t: 1, v: 50 }, { t: 2, v: 50 }] }]);
  assert.ok(flat.max > flat.min);
});

test('das Diagramm zeichnet je Messreihe eine Linie in fester Farbreihenfolge', () => {
  const svg = renderChartSvg([
    { measurement: 'pv.leistung', points: [{ t: 1000, v: 10 }, { t: 2000, v: 20 }] },
    { measurement: 'batterie.soc', points: [{ t: 1000, v: 50 }, { t: 2000, v: 55 }] },
  ], { from: 1000, to: 2000, intervalMs: 1000, unit: 'W' });

  assert.match(svg, /<svg class="chart-svg"/);
  assert.match(svg, new RegExp(`stroke="${SERIES_COLORS[0]}"`));
  assert.match(svg, new RegExp(`stroke="${SERIES_COLORS[1]}"`));
  // Seitenverhältnis bleibt erhalten — sonst würden Schrift und Punkte verzerrt.
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.doesNotMatch(svg, /preserveAspectRatio="none"/);
  assert.match(svg, /data-chart='/, 'Ablesepunkte hängen am SVG');
});

test('Lücken in den Daten brechen die Linie, statt quer darüber zu ziehen', () => {
  const svg = renderChartSvg([{
    measurement: 'pv.leistung',
    // Zwischen 2000 und 60000 fehlen Werte (Raster 1000 ms).
    points: [{ t: 1000, v: 10 }, { t: 2000, v: 12 }, { t: 60000, v: 30 }],
  }], { from: 1000, to: 60000, intervalMs: 1000 });
  const path = svg.match(/<path class="chart-line" d="([^"]+)"/)[1];
  assert.equal((path.match(/M/g) || []).length, 2, 'die Lücke beginnt einen neuen Teilpfad');
});

test('ohne Werte erscheint ein Hinweis statt eines leeren Diagramms', () => {
  const svg = renderChartSvg([], { from: 0, to: 1000 });
  assert.match(svg, /chart-notice/);
  assert.match(svg, /keine Werte/);
});

test('die Legende trägt Namen und aktuellen Wert, damit kein Wert nur im Tooltip steht', () => {
  // Eine Linie: die Überschrift der Kachel nennt sie bereits, es genügt der Wert.
  const single = renderChartLegend([{ measurement: 'pv.leistung', points: [{ t: 1, v: 4210.7 }] }], { unit: 'W' });
  assert.match(single, /4\.211 W/);
  assert.doesNotMatch(single, /chart-legend-swatch/);

  // Ab zwei Linien hängt die Identität nie allein an der Farbe.
  const legend = renderChartLegend([
    { measurement: 'pv.leistung', points: [{ t: 1, v: 4210.7 }] },
    { measurement: 'batterie.soc', points: [{ t: 1, v: 87.25 }] },
  ], { unit: 'W' });
  assert.match(legend, /chart-legend-swatch/);
  assert.match(legend, /pv\.leistung/);
  assert.match(legend, /batterie\.soc/);
  assert.match(legend, /87,3/);

  // Ohne Werte bleibt die Legende leer.
  assert.equal(renderChartLegend([{ measurement: 'x', points: [] }]), '');
});

test('Messreihennamen werden escaped, auch in den Ablesepunkten', () => {
  const svg = renderChartSvg([{ measurement: '<script>alert(1)</script>', points: [{ t: 1, v: 1 }] }], { from: 0, to: 2 });
  assert.doesNotMatch(svg, /<script>/);
  const legend = renderChartLegend([
    { measurement: '<b>x</b>', points: [{ t: 1, v: 1 }] },
    { measurement: 'y', points: [{ t: 1, v: 2 }] },
  ]);
  assert.doesNotMatch(legend, /<b>/);
});

// ── Kachel und Route ───────────────────────────────────────────────────────

test('die Kachel rendert Rahmen und Platzhalter, das Diagramm wird nachgeladen', () => {
  const html = renderDashboard({
    tabs: [{
      id: 1, title: 'Test', groups: [],
      ungrouped: [{ id: 7, type: 'chart', label: 'Erzeugung', chart: { title: 'Erzeugung', measurements: ['pv.leistung'], range: '24h' } }],
    }],
    chartRanges: CHART_RANGES,
    chartAggregates: [{ key: 'mean', label: 'Mittelwert' }],
  });
  assert.match(html, /widget-card--chart/);
  assert.match(html, /data-chart-widget="7"/);
  assert.match(html, /Diagramm wird geladen/);
  assert.match(html, /24 Stunden/);
});

let db;
let server;
let baseUrl;
let influx;

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));

  influx = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ping') {
      res.writeHead(204, { 'X-Influxdb-Version': '1.8.10' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      results: [{ series: [{ values: [[1786531200000, 120], [1786531500000, 340]] }] }],
    }));
  });
  await new Promise((resolve) => influx.listen(0, '127.0.0.1', resolve));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(dashboardRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await systemDatabase.save(db, {
    enabled: true, host: '127.0.0.1', port: influx.address().port, database: 'homeess',
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (influx) await new Promise((resolve) => influx.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('ein Diagramm-Widget lässt sich anlegen und liefert fertiges SVG', async () => {
  const widget = await widgetsRepo.createWidget(db, {
    type: 'chart',
    chartMeasurements: ['pv.leistung', 'batterie.soc'],
    chartRange: '6h',
    chartAggregate: 'max',
    chartTitle: 'Erzeugung',
    chartUnit: 'W',
  });
  assert.equal(widget.type, 'chart');
  assert.deepEqual(widget.chart.measurements, ['pv.leistung', 'batterie.soc']);
  assert.equal(widget.chart.range, '6h');
  assert.equal(widget.chart.aggregate, 'max');

  const data = await fetch(`${baseUrl}/dashboard/widgets/${widget.id}/chart`).then((res) => res.json());
  assert.equal(data.ok, true);
  assert.equal(data.rangeLabel, '6 Stunden');
  assert.match(data.html, /<svg class="chart-svg"/);
  assert.match(data.legend, /chart-legend/);
});

test('ein Diagramm ohne Messreihe wird abgelehnt', async () => {
  await assert.rejects(
    () => widgetsRepo.createWidget(db, { type: 'chart', chartMeasurements: [] }),
    /mindestens eine Messreihe/
  );
});

test('ohne eingerichtete Datenbank zeigt die Kachel einen Hinweis statt eines Fehlers', async () => {
  const widget = await widgetsRepo.createWidget(db, { type: 'chart', chartMeasurements: ['pv.leistung'] });
  await systemDatabase.save(db, { enabled: false, host: '' });

  const response = await fetch(`${baseUrl}/dashboard/widgets/${widget.id}/chart`);
  assert.equal(response.status, 200, 'das Dashboard darf daran nicht scheitern');
  const data = await response.json();
  assert.equal(data.ok, false);
  assert.match(data.html, /keine Datenbank eingerichtet/);
});

test('ein Wert-Widget ist kein Diagramm', async () => {
  const widget = await widgetsRepo.createWidget(db, { type: 'value', stateTopic: 'system://homeess/pv.current' });
  const response = await fetch(`${baseUrl}/dashboard/widgets/${widget.id}/chart`);
  assert.equal(response.status, 404);
});

// ── Bearbeiten, Farben und Namen je Linie ──────────────────────────────────

test('der Bearbeiten-Dialog bekommt die Diagramm-Konfiguration mitgeliefert', () => {
  // Regression: ohne `chart` in der Client-Widgetliste blieben beim Bearbeiten
  // alle Felder des Diagramms leer.
  const widget = {
    id: 9, type: 'chart', label: 'Erzeugung',
    chart: {
      title: 'Erzeugung', unit: 'W', range: '7d', aggregate: 'max',
      series: [{ measurement: 'pv.leistung', label: 'PV', color: '#ff0000' }],
    },
  };
  const html = renderDashboard({
    tabs: [{ id: 1, title: 'Test', ungrouped: [widget], groups: [] }],
    chartRanges: CHART_RANGES,
    chartAggregates: [{ key: 'max', label: 'Maximum' }],
  });
  const list = JSON.parse(html.match(/var dashboardWidgets = (\[.*?\]);\n/s)[1]);
  const entry = list.find((item) => item.id === 9);
  assert.ok(entry.chart, 'die Konfiguration fehlt im Dialogdatensatz');
  assert.equal(entry.chart.title, 'Erzeugung');
  assert.equal(entry.chart.range, '7d');
  assert.equal(entry.chart.aggregate, 'max');
  assert.equal(entry.chart.unit, 'W');
  assert.deepEqual(entry.chart.series, [{ measurement: 'pv.leistung', label: 'PV', color: '#ff0000' }]);
});

test('jede Linie trägt Farbe und Anzeigename; ohne Angabe greifen die Vorgaben', () => {
  const config = normalizeChartConfig({
    seriesMeasurements: ['pv.leistung', 'batterie.soc'],
    seriesLabels: ['PV-Leistung', '  '],
    seriesColors: ['#FF0000', 'unsinn'],
  });
  assert.deepEqual(config.series, [
    { measurement: 'pv.leistung', label: 'PV-Leistung', color: '#ff0000' },
    { measurement: 'batterie.soc', label: '', color: SERIES_COLORS[1] },
  ]);
  assert.deepEqual(config.measurements, ['pv.leistung', 'batterie.soc']);
});

test('die Farbe hängt an der Linie, nicht an ihrer Position', () => {
  // Zweite Linie mit eigener Farbe; die erste wird entfernt. Die verbleibende
  // behält ihre Farbe, statt auf die Farbe von Position 1 umzuspringen.
  const before = normalizeChartConfig({
    seriesMeasurements: ['a', 'b'], seriesLabels: ['', ''], seriesColors: ['', '#123456'],
  });
  assert.equal(before.series[1].color, '#123456');
  const after = normalizeChartConfig({ series: [before.series[1]] });
  assert.equal(after.series[0].color, '#123456');
});

test('Zeichnung und Legende verwenden Name und Farbe der Linie', () => {
  const series = [
    { measurement: 'pv.leistung', label: 'PV-Leistung', color: '#ff0000', points: [{ t: 1, v: 10 }, { t: 2, v: 20 }] },
    { measurement: 'batterie.soc', label: '', color: '', points: [{ t: 1, v: 50 }, { t: 2, v: 55 }] },
  ];
  const svg = renderChartSvg(series, { from: 1, to: 2, intervalMs: 1 });
  assert.match(svg, /stroke="#ff0000"/);
  assert.match(svg, new RegExp(`stroke="${SERIES_COLORS[1]}"`), 'ohne eigene Farbe die Standardfarbe der Position');

  const legend = renderChartLegend(series, { unit: 'W' });
  assert.match(legend, /PV-Leistung/);
  assert.match(legend, /background:#ff0000/);
  // Ohne Namen steht die Messreihe in der Legende.
  assert.match(legend, /batterie\.soc/);
});

test('Farben und Namen überstehen Speichern und Laden', async () => {
  const created = await widgetsRepo.createWidget(db, {
    type: 'chart',
    chartSeriesMeasurements: ['pv.leistung', 'batterie.soc'],
    chartSeriesLabels: ['Erzeugung', 'Speicher'],
    chartSeriesColors: ['#ff0000', '#00ff00'],
    chartRange: '24h',
  });
  const loaded = await widgetsRepo.getWidget(db, created.id);
  assert.deepEqual(loaded.chart.series, [
    { measurement: 'pv.leistung', label: 'Erzeugung', color: '#ff0000' },
    { measurement: 'batterie.soc', label: 'Speicher', color: '#00ff00' },
  ]);

  // Ändern über den Dialog (parallele Feldlisten) ersetzt die Linien.
  const updated = await widgetsRepo.updateWidget(db, created.id, {
    type: 'chart',
    chartSeriesMeasurements: ['pv.leistung'],
    chartSeriesLabels: ['Erzeugung'],
    chartSeriesColors: ['#0000ff'],
    chartRange: '7d',
  });
  assert.deepEqual(updated.chart.series, [{ measurement: 'pv.leistung', label: 'Erzeugung', color: '#0000ff' }]);
  assert.equal(updated.chart.range, '7d');
});

test('die Kachel liefert Namen und Farben mit dem gezeichneten Diagramm aus', async () => {
  await systemDatabase.save(db, {
    enabled: true, host: '127.0.0.1', port: influx.address().port, database: 'homeess',
  });
  const widget = await widgetsRepo.createWidget(db, {
    type: 'chart',
    chartSeriesMeasurements: ['pv.leistung', 'batterie.soc'],
    chartSeriesLabels: ['Erzeugung', 'Speicher'],
    chartSeriesColors: ['#ff0000', ''],
    chartUnit: 'W',
  });
  const data = await fetch(`${baseUrl}/dashboard/widgets/${widget.id}/chart`).then((res) => res.json());
  assert.equal(data.ok, true);
  assert.match(data.html, /stroke="#ff0000"/);
  assert.match(data.legend, /Erzeugung/);
  assert.match(data.legend, /Speicher/);
});

test('der Farbwähler einer Linie zeigt die gewählte Farbe auf der ganzen Fläche', () => {
  // Ohne diese Regeln umrahmt der Browser die Farbfläche und der Knopf wirkt
  // grau, statt die Farbe der Linie zu tragen.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.chart-series-color\s*\{[^}]*padding:\s*0;/s);
  assert.match(css, /\.chart-series-color::-webkit-color-swatch-wrapper\s*\{\s*padding:\s*0;/);
  assert.match(css, /\.chart-series-color::-webkit-color-swatch\s*\{\s*border:\s*none;/);
  assert.match(css, /\.chart-series-color::-moz-color-swatch\s*\{\s*border:\s*none;/);
});
