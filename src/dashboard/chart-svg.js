'use strict';

// Zeichnet eine Zeitreihe als Inline-SVG. Bewusst serverseitig — wie alle
// Ansichten von homeESS: Der Browser bekommt fertiges Markup, das er nur noch
// einsetzt, und braucht keine Diagrammbibliothek.
//
// Farben und Namen der Linien stehen in der Widget-Konfiguration; fehlt eine
// Angabe, greifen die Standardfarbe der Position (siehe chart-palette.js) und
// der Messreihenname.

const { escapeHtml } = require('../views/components');

// Seitenverhältnis der Zeichenfläche; die Kachel übernimmt es per CSS.

const {
  SERIES_COLORS, DEFAULT_AREA_OPACITY, MIN_AREA_OPACITY, MAX_AREA_OPACITY,
} = require('./chart-palette');

// Zeichenfläche in Nutzerkoordinaten; die Kachel skaliert sie über viewBox.
const WIDTH = 720;
const HEIGHT = 260;
const PADDING = { top: 16, right: 16, bottom: 28, left: 52 };

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

// Anzeigename einer Linie: der im Widget vergebene Name, sonst die Messreihe.
function seriesName(entry) {
  return String((entry && entry.label) || (entry && entry.measurement) || '');
}

// Farbe einer Linie: die im Widget vergebene, sonst die Standardfarbe der
// Position in der Liste.
function seriesColor(entry, index) {
  const color = String((entry && entry.color) || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : SERIES_COLORS[index % SERIES_COLORS.length];
}

// Deckkraft der Fläche einer Linie; ohne gültige Angabe die Vorgabe aus der
// Diagrammkonfiguration.
function seriesAreaOpacity(entry) {
  const value = Number(entry && entry.areaOpacity);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_AREA_OPACITY;
  return Math.min(MAX_AREA_OPACITY, Math.max(MIN_AREA_OPACITY, value));
}

function formatNumber(value, decimals) {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

// Achsenbeschriftung großer Zahlen kürzen: links stehen nur 44 px zur
// Verfügung, „1.500.000" liefe darüber hinaus und ragte in die Kachel.
// Die Einheit gilt für die **ganze** Achse — eine Achse, die „5.000" neben
// „10,0 k" stellt, liest sich schlechter als eine durchgehend in k. Der
// Ablesewert im Tooltip bleibt davon unberührt und wird voll ausgeschrieben.
function axisFormatter(scale) {
  const largest = Math.max(Math.abs(scale.min), Math.abs(scale.max));
  const divisor = largest >= 1000000 ? 1000000 : largest >= 10000 ? 1000 : 1;
  const suffix = divisor === 1000000 ? ' M' : divisor === 1000 ? ' k' : '';
  // So viele Nachkommastellen, dass zwei benachbarte Schritte unterscheidbar
  // bleiben — aber nicht mehr.
  const scaledStep = scale.step / divisor;
  const decimals = divisor === 1 ? scale.decimals : (scaledStep >= 1 ? 0 : scaledStep >= 0.1 ? 1 : 2);
  return (value) => `${formatNumber(roundTo(value / divisor, 3), decimals)}${suffix}`;
}

// Achsenbeschriftung: so wenige Nachkommastellen wie möglich, ohne dass zwei
// Schritte gleich aussehen.
function axisDecimals(step) {
  const size = Math.abs(step);
  if (size >= 100) return 0;
  if (size >= 10) return 0;
  if (size >= 1) return 1;
  if (size >= 0.1) return 2;
  return 3;
}

// „Schöne" Schrittweite (1/2/5 × Zehnerpotenz) für die Werteachse.
function niceStep(span, targetTicks) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  // Übliche „nice number"-Rundung: die Grenzen liegen zwischen den Stufen,
  // sonst wird die Achse zu grob (Spanne 100 ergäbe sonst nur zwei Schritte).
  const factor = normalized <= 1.5 ? 1 : normalized <= 3 ? 2 : normalized <= 7 ? 5 : 10;
  return factor * magnitude;
}

// Wertebereich aller Linien, auf glatte Schritte erweitert. Eine flache Linie
// bekommt trotzdem ein sichtbares Band.
//
// `includeZero` zieht die Achse bis zur Null herunter (bzw. herauf). Das ist
// nötig, sobald eine Linie ihre Fläche füllt: eine Fläche „bis 0" mit einer
// Grundlinie, die gar nicht die Null ist, würde die Größenverhältnisse
// vortäuschen. Ohne Flächenfüllung bleibt die Achse eng am Wertebereich.
function valueScale(series, { includeZero = false } = {}) {
  let min = Infinity;
  let max = -Infinity;
  for (const entry of series) {
    for (const point of entry.points) {
      if (typeof point.v !== 'number' || !Number.isFinite(point.v)) continue;
      if (point.v < min) min = point.v;
      if (point.v > max) max = point.v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const padding = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= padding;
    max += padding;
  }
  const step = niceStep(max - min, 4);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = niceMin; value <= niceMax + step / 1000; value += step) {
    ticks.push(Math.abs(value) < step / 1000 ? 0 : value);
  }
  return { min: niceMin, max: niceMax, step, ticks, decimals: axisDecimals(step) };
}

function formatTimeLabel(timestamp, durationMs) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  // Bis zu einem Tag reicht die Uhrzeit; darüber ist das Datum die Orientierung.
  if (durationMs <= 36 * 60 * 60 * 1000) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.`;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Punkte in zusammenhängende Abschnitte zerlegen. Lücken (fehlende Messwerte)
// trennen zwei Abschnitte, statt die Linie quer über das Loch zu ziehen — das
// Raster der Abfrage bestimmt, was eine Lücke ist. Mit `gapMs = 0` bleibt alles
// ein Abschnitt; welche Lückenbehandlung die Kachel eingestellt hat, entscheidet
// der Aufrufer.
function splitAtGaps(points, gapMs) {
  const segments = [];
  let current = null;
  let previousTime = null;
  for (const point of points) {
    const isGap = previousTime != null && gapMs > 0 && point.t - previousTime > gapMs;
    if (!current || isGap) {
      current = [];
      segments.push(current);
    }
    current.push(point);
    previousTime = point.t;
  }
  return segments;
}

// Punkte einer Linie in einen Pfad übersetzen.
function buildPath(points, xOf, yOf, gapMs) {
  return splitAtGaps(points, gapMs)
    .map((segment) => segment
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${roundTo(xOf(point.t), 1)} ${roundTo(yOf(point.v), 1)}`)
      .join(' '))
    .join(' ');
}

// Fläche zwischen Linie und Nulllinie. Je Abschnitt ein geschlossenes Vieleck,
// damit eine Aufzeichnungslücke auch die Fläche unterbricht und nicht als
// gefüllter Block erscheint, den es nie gab. Negative Werte füllen nach oben —
// die Grundlinie ist immer die Null, nicht der untere Rand.
function buildAreaPath(points, xOf, yOf, gapMs, baseline) {
  return splitAtGaps(points, gapMs)
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const first = roundTo(xOf(segment[0].t), 1);
      const last = roundTo(xOf(segment[segment.length - 1].t), 1);
      const line = segment
        .map((point) => `L${roundTo(xOf(point.t), 1)} ${roundTo(yOf(point.v), 1)}`)
        .join(' ');
      return `M${first} ${baseline} ${line} L${last} ${baseline} Z`;
    })
    .join(' ');
}

// Eine Meldung anstelle des Diagramms (keine Anbindung, keine Daten, Fehler).
function renderNotice(message, tone = 'muted') {
  return `<div class="chart-notice chart-notice--${escapeHtml(tone)}">${escapeHtml(message)}</div>`;
}

// series: [{ measurement, points: [{ t, v }] }] aus src/database/
function renderChartSvg(series, options = {}) {
  const from = Number(options.from) || 0;
  const to = Number(options.to) || Date.now();
  const unit = String(options.unit || '');
  const usable = (series || []).filter((entry) => entry && Array.isArray(entry.points) && entry.points.length);
  if (!usable.length) {
    return renderNotice('Für den gewählten Zeitraum liegen keine Werte in der Datenbank.');
  }
  // Sobald eine Linie ihre Fläche füllt, gehört die Null in die Achse — sonst
  // stünde die Fläche auf einer Grundlinie, die keine Null ist.
  const anyArea = usable.some((entry) => entry && entry.area);
  const scale = valueScale(usable, { includeZero: anyArea });
  if (!scale) {
    return renderNotice('Die Messreihe enthält keine Zahlenwerte.');
  }

  const span = Math.max(1, to - from);
  const xOf = (timestamp) => PADDING.left + ((timestamp - from) / span) * PLOT_WIDTH;
  const yOf = (value) => PADDING.top + PLOT_HEIGHT - ((value - scale.min) / (scale.max - scale.min)) * PLOT_HEIGHT;
  // Als Lücke gilt das Zweieinhalbfache der Rasterweite. Ohne Raster wird nichts
  // getrennt — und ebenso wenig, wenn die Kachel die Lücken füllen oder die
  // Linie durchziehen soll (`breakAtGaps: false`).
  const breakAtGaps = options.breakAtGaps !== false;
  const gapMs = breakAtGaps && Number(options.intervalMs) > 0 ? Number(options.intervalMs) * 2.5 : 0;

  const formatTick = axisFormatter(scale);
  const gridLines = scale.ticks.map((value) => {
    const y = roundTo(yOf(value), 1);
    return `<line class="chart-grid" x1="${PADDING.left}" y1="${y}" x2="${PADDING.left + PLOT_WIDTH}" y2="${y}"></line>`
      + `<text class="chart-axis-label chart-axis-label--y" x="${PADDING.left - 8}" y="${y + 4}">${escapeHtml(formatTick(value))}</text>`;
  }).join('');

  // Vier Zeitmarken plus Anfang und Ende des Fensters.
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const timestamp = from + span * fraction;
    const x = roundTo(PADDING.left + PLOT_WIDTH * fraction, 1);
    const anchor = fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle';
    return `<text class="chart-axis-label" x="${x}" y="${HEIGHT - 8}" text-anchor="${anchor}">${escapeHtml(formatTimeLabel(timestamp, span))}</text>`;
  }).join('');

  // Alle Flächen liegen unter allen Linien: sonst deckte die Fläche einer später
  // gezeichneten Linie die Linien darunter ab.
  const baseline = roundTo(yOf(0), 1);
  const areas = usable.map((entry, index) => {
    if (!entry.area) return '';
    const path = buildAreaPath(entry.points, xOf, yOf, gapMs, baseline);
    if (!path) return '';
    return `<path class="chart-area" d="${path}" fill="${seriesColor(entry, index)}"`
      + ` fill-opacity="${seriesAreaOpacity(entry)}"></path>`;
  }).join('');

  const paths = usable.map((entry, index) => {
    const color = seriesColor(entry, index);
    const path = buildPath(entry.points, xOf, yOf, gapMs);
    // Der letzte Wert bekommt einen Punkt — die Kurve endet damit sichtbar und
    // die Kachel zeigt zugleich den aktuellen Stand.
    const last = entry.points[entry.points.length - 1];
    const marker = typeof last.v === 'number' && Number.isFinite(last.v)
      ? `<circle class="chart-last" cx="${roundTo(xOf(last.t), 1)}" cy="${roundTo(yOf(last.v), 1)}" r="4" fill="${color}"></circle>`
      : '';
    return `<path class="chart-line" d="${path}" stroke="${color}" fill="none"></path>${marker}`;
  }).join('');

  // Datenpunkte für die Fadenkreuz-Anzeige: einmal als JSON am Wurzelelement,
  // damit die Kachel ohne zweite Abfrage darauf zugreifen kann.
  const hoverData = JSON.stringify({
    from,
    to,
    unit,
    decimals: scale.decimals,
    plot: { left: PADDING.left, top: PADDING.top, width: PLOT_WIDTH, height: PLOT_HEIGHT },
    series: usable.map((entry, index) => ({
      name: seriesName(entry),
      color: seriesColor(entry, index),
      points: entry.points.map((point) => [point.t, typeof point.v === 'number' ? roundTo(point.v, 3) : null]),
    })),
  });

  const unitLabel = unit
    ? `<text class="chart-axis-label chart-axis-label--unit" x="${PADDING.left - 8}" y="${PADDING.top - 4}" text-anchor="end">${escapeHtml(unit)}</text>`
    : '';

  // Seitenverhältnis bleibt erhalten (kein `none`) — sonst würden Schrift,
  // Punkte und Linienstärken mitverzerrt. Die Kachel gibt dem SVG über CSS
  // genau dieses Verhältnis vor.
  return `<svg class="chart-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" data-chart='${escapeHtml(hoverData)}'>
      <g class="chart-grid-group">${gridLines}</g>
      ${unitLabel}
      <g class="chart-axis-group">${timeTicks}</g>
      <g class="chart-areas">${areas}</g>
      <g class="chart-lines">${paths}</g>
      <g class="chart-cursor" hidden>
        <line class="chart-cursor-line" y1="${PADDING.top}" y2="${PADDING.top + PLOT_HEIGHT}"></line>
      </g>
    </svg>`;
}

// Legende mit dem jeweils letzten Messwert. Zwei Gründe für den Wert:
// Die Identität einer Linie darf nie allein an der Farbe hängen (der Name steht
// daneben), und kein Wert darf ausschließlich über den Tooltip erreichbar sein —
// der aktuelle Stand ist damit auch ohne Zeiger und auf dem Handy lesbar.
function lastValueOf(entry) {
  const points = (entry && entry.points) || [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index].v;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// Nachkommastellen nach Größenordnung des Werts, nicht nach Achsenraster.
function formatReading(value, unit) {
  if (value == null) return '—';
  const size = Math.abs(value);
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${formatNumber(roundTo(value, decimals), decimals)}${unit ? ` ${unit}` : ''}`;
}

function renderChartLegend(series, options = {}) {
  const entries = (series || []).filter((entry) => entry && Array.isArray(entry.points) && entry.points.length);
  if (!entries.length) return '';
  const unit = String(options.unit || '');
  const single = entries.length === 1;
  const items = entries.map((entry, index) => {
    const color = seriesColor(entry, index);
    // Bei genau einer Linie nennt die Überschrift der Kachel sie bereits; dann
    // genügt der Wert ohne Farbfeld.
    const swatch = single ? '' : `<span class="chart-legend-swatch" style="background:${color}"></span>`;
    const name = single ? '' : `<span class="chart-legend-name">${escapeHtml(seriesName(entry))}</span>`;
    return `<span class="chart-legend-item">${swatch}${name}`
      + `<span class="chart-legend-value">${escapeHtml(formatReading(lastValueOf(entry), unit))}</span></span>`;
  }).join('');
  return `<div class="chart-legend">${items}</div>`;
}

module.exports = { renderChartSvg, renderChartLegend, renderNotice, SERIES_COLORS, valueScale, niceStep, CHART_WIDTH: WIDTH, CHART_HEIGHT: HEIGHT };
