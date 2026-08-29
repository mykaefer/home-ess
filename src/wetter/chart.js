'use strict';

// Verlaufsdiagramm der Wetterprognose über den gesamten Zeitraum: Temperatur
// und Sonnenintensität als Linien, Niederschlag als Balken dahinter.
//
// Wie alle Ansichten von homeESS entsteht das Diagramm serverseitig als
// Inline-SVG — der Browser bekommt fertiges Markup und braucht keine
// Diagrammbibliothek. Die drei Größen haben eigene Wertebereiche und daher
// eigene Achsen: Temperatur links, Sonnenintensität rechts, der Niederschlag
// liegt als Balken im unteren Bereich hinter den Linien und trägt seinen
// Maßstab in der Legende.
//
// Es gibt zwei Bauformen, weil ein einziges SVG beide Breiten nicht sauber
// bedienen kann:
//
//   `wide`     – Schreibtisch. Feste Höhe, Achsen und Beschriftungen stehen im
//                SVG. Die Zeichenfläche entspricht nahezu 1:1 der Anzeige, die
//                Schrift wird dadurch nicht verzerrt.
//   `compact`  – Telefon. Das SVG trägt **keine Schrift**, nur Flächen und
//                Linien; die Zeichenfläche füllt es randlos aus. Tagesnamen und
//                Wertebereiche stehen als HTML darüber und darunter. So bleibt
//                alles bei jeder Gerätebreite lesbar — Text kann nicht gestaucht
//                werden — und es muss nirgends seitlich gescrollt werden.

const { escapeHtml } = require('../views/components');

// Anteil der Zeichenfläche, den der höchste Niederschlagsbalken einnimmt. Die
// Balken sollen die Linien einordnen, nicht überdecken.
const RAIN_PLOT_SHARE = 0.45;

const LAYOUTS = {
  wide: {
    width: 1080,
    height: 200,
    padding: { top: 26, right: 58, bottom: 38, left: 50 },
    // Zeichenfläche und Anzeigefläche sind gleich hoch; die Breite darf sich
    // dehnen, ohne dass die Schrift sichtbar leidet.
    preserveAspectRatio: 'none',
    labels: true,
  },
  compact: {
    width: 360,
    height: 132,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    preserveAspectRatio: 'none',
    labels: false,
  },
};

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatNumber(value, decimals) {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(value);
}

// Schrittweite einer Achse auf einen „runden" Wert bringen (1 · 2 · 5 · 10 …).
function niceStep(rough) {
  if (!(rough > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

// Wertebereich mit runden Grenzen und Teilstrichen. `includeZero` zieht die
// Null in die Achse (nötig, wo eine Größe nie negativ wird und die Grundlinie
// etwas bedeutet).
function scaleFor(values, { includeZero = false, tickCount = 3 } = {}) {
  const usable = values.filter((value) => value != null && Number.isFinite(value));
  if (!usable.length) return null;
  let min = Math.min(...usable);
  let max = Math.max(...usable);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = niceStep((max - min) / tickCount);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = min; value <= max + step / 2; value += step) ticks.push(roundTo(value, 6));
  return { min, max, step, ticks };
}

// Punktfolge in zusammenhängende Abschnitte zerlegen. Lücken (fehlende Werte)
// trennen den Zug, statt ihn quer durch das Diagramm zu ziehen. Abschnitte aus
// nur einem Punkt ergeben keine Strecke und entfallen.
function toSegments(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point == null) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments.filter((segment) => segment.length > 1);
}

function linePath(points) {
  return toSegments(points)
    .map((segment) => segment
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${roundTo(point.x, 1)} ${roundTo(point.y, 1)}`)
      .join(' '))
    .join(' ');
}

// Derselbe Zug, aber zur Nulllinie hin geschlossen: die Fläche unter der Kurve.
// Je Abschnitt eigenständig geschlossen, damit eine Lücke nicht überbrückt wird.
function areaPath(points, baselineY) {
  const base = roundTo(baselineY, 1);
  return toSegments(points)
    .map((segment) => {
      const first = roundTo(segment[0].x, 1);
      const last = roundTo(segment[segment.length - 1].x, 1);
      const middle = segment
        .map((point) => `L${roundTo(point.x, 1)} ${roundTo(point.y, 1)}`)
        .join(' ');
      return `M${first} ${base} ${middle} L${last} ${base} Z`;
    })
    .join(' ');
}

// Alle Stunden aller Tage zu einer durchgehenden Reihe verketten und dabei
// merken, wo ein neuer Tag beginnt.
function flattenHours(days) {
  const hours = [];
  const boundaries = [];
  for (const day of days) {
    if (!day.hours || !day.hours.length) continue;
    boundaries.push({ start: hours.length, count: day.hours.length, day });
    for (const hour of day.hours) hours.push(hour);
  }
  return { hours, boundaries };
}

function renderFigure(variant, inner) {
  return `          <div class="wetter-chart-figure wetter-chart-figure--${variant}">
${inner}
          </div>`;
}

function renderEmpty(variant, message) {
  return renderFigure(variant, `            <div class="wetter-chart-empty">${escapeHtml(message)}</div>`);
}

// Kurzform eines Wochentags für die schmale Bauform („Mittwoch" → „Mi").
function shortWeekday(day) {
  const name = String((day && day.weekday) || (day && day.name) || '');
  return name.slice(0, 2);
}

// `current` markiert die laufende Stunde, damit sofort erkennbar ist, wo
// „jetzt" im Verlauf liegt.
function renderWeatherChart(days, current = null, { variant = 'wide' } = {}) {
  const layout = LAYOUTS[variant] || LAYOUTS.wide;
  const usable = (days || []).filter((day) => day && Array.isArray(day.hours) && day.hours.length);
  if (!usable.length) return renderEmpty(variant, 'Für den Verlauf liegen keine Stundenwerte vor.');

  const { hours, boundaries } = flattenHours(usable);
  const count = hours.length;
  if (count < 2) return renderEmpty(variant, 'Für den Verlauf liegen zu wenige Stundenwerte vor.');

  const tempScale = scaleFor(hours.map((hour) => hour.temperature));
  const sunScale = scaleFor(hours.map((hour) => hour.radiation), { includeZero: true });
  if (!tempScale) return renderEmpty(variant, 'Der Verlauf enthält keine Temperaturwerte.');

  const { width: WIDTH, height: HEIGHT, padding: PADDING } = layout;
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const slot = plotWidth / count;
  const xOf = (index) => PADDING.left + (index + 0.5) * slot;
  const yTemp = (value) => PADDING.top + plotHeight
    - ((value - tempScale.min) / (tempScale.max - tempScale.min)) * plotHeight;
  const ySun = (value) => (sunScale
    ? PADDING.top + plotHeight - ((value - sunScale.min) / (sunScale.max - sunScale.min)) * plotHeight
    : null);

  // Niederschlag hat einen eigenen Maßstab: der höchste Stundenwert füllt einen
  // festen Anteil der Fläche. Ohne Niederschlag entfallen die Balken ganz.
  const rainValues = hours.map((hour) => (hour.precipitation == null ? 0 : Math.max(0, hour.precipitation)));
  const rainMax = Math.max(...rainValues);
  const baseline = PADDING.top + plotHeight;
  const rainBars = rainMax > 0 ? hours.map((hour, index) => {
    const value = rainValues[index];
    if (value <= 0) return '';
    const height = (value / rainMax) * plotHeight * RAIN_PLOT_SHARE;
    const barWidth = Math.max(1.5, slot * 0.72);
    const x = xOf(index) - barWidth / 2;
    const rect = `<rect class="wetter-chart-rain" x="${roundTo(x, 1)}" y="${roundTo(baseline - height, 1)}" `
      + `width="${roundTo(barWidth, 1)}" height="${roundTo(height, 1)}">`;
    // Ein Hinweistext je Balken lohnt nur dort, wo gezeigt wird.
    return layout.labels
      ? `${rect}<title>${escapeHtml(`${hour.clock} Uhr · Niederschlag ${formatNumber(value, 1)} mm`)}</title></rect>`
      : `${rect}</rect>`;
  }).join('') : '';

  // Waagerechtes Raster; die linke Achse (Temperatur) nur in der breiten Form.
  const grid = tempScale.ticks.map((value) => {
    const y = roundTo(yTemp(value), 1);
    const line = `<line class="wetter-chart-grid" x1="${PADDING.left}" y1="${y}" x2="${PADDING.left + plotWidth}" y2="${y}"></line>`;
    if (!layout.labels) return line;
    return `${line}<text class="wetter-chart-axis wetter-chart-axis--temp" x="${PADDING.left - 8}" y="${y + 4}" text-anchor="end">${escapeHtml(formatNumber(value, 0))}</text>`;
  }).join('');

  // Rechte Achse (Sonnenintensität) ohne eigene Rasterlinien — ein zweites
  // Raster über demselben Feld wäre nicht mehr lesbar.
  const sunAxis = layout.labels && sunScale ? sunScale.ticks.map((value) => {
    const y = roundTo(ySun(value), 1);
    return `<text class="wetter-chart-axis wetter-chart-axis--sun" x="${PADDING.left + plotWidth + 8}" y="${y + 4}">${escapeHtml(formatNumber(value, 0))}</text>`;
  }).join('') : '';

  // Tagesgrenzen als senkrechte Linien; der Tagesname steht in der breiten Form
  // im SVG, in der schmalen als HTML-Zeile darüber.
  const dayMarks = boundaries.map((entry, index) => {
    const startX = roundTo(PADDING.left + entry.start * slot, 1);
    const centerX = roundTo(PADDING.left + (entry.start + entry.count / 2) * slot, 1);
    const separator = index === 0 ? '' : `<line class="wetter-chart-daysep" x1="${startX}" y1="${PADDING.top}" x2="${startX}" y2="${baseline}"></line>`;
    if (!layout.labels) return separator;
    return `${separator}<text class="wetter-chart-daylabel" x="${centerX}" y="${PADDING.top - 10}" text-anchor="middle">${escapeHtml(entry.day.name)}</text>`;
  }).join('');

  // Uhrzeit-Marken: 00 und 12 Uhr je Tag reichen, mehr würde bei sieben Tagen
  // ineinanderlaufen.
  const timeMarks = layout.labels ? hours.map((hour, index) => {
    if (hour.hour !== 0 && hour.hour !== 12) return '';
    return `<text class="wetter-chart-axis" x="${roundTo(xOf(index), 1)}" y="${HEIGHT - 22}" text-anchor="middle">${escapeHtml(String(hour.hour).padStart(2, '0'))}</text>`;
  }).join('') : '';

  const tempPath = linePath(hours.map((hour, index) => (hour.temperature == null
    ? null
    : { x: xOf(index), y: yTemp(hour.temperature) })));
  const sunPoints = sunScale ? hours.map((hour, index) => (hour.radiation == null
    ? null
    : { x: xOf(index), y: ySun(hour.radiation) })) : [];
  const sunPath = sunScale ? linePath(sunPoints) : '';
  // Die Sonnenkurve wird zur Null hin gefüllt. Die Fläche liegt ganz hinten:
  // halbtransparent lässt sie Raster und Niederschlagsbalken durchscheinen,
  // ohne sie einzufärben.
  const sunArea = sunScale ? areaPath(sunPoints, ySun(Math.max(0, sunScale.min))) : '';

  // Markierung der laufenden Stunde.
  let nowMark = '';
  if (current && current.dateKey != null && current.hour != null) {
    const index = hours.findIndex((hour) => hour.dateKey === current.dateKey && hour.hour === current.hour);
    if (index >= 0) {
      const x = roundTo(xOf(index), 1);
      nowMark = `<line class="wetter-chart-now" x1="${x}" y1="${PADDING.top}" x2="${x}" y2="${baseline}"></line>`;
      if (layout.labels) {
        nowMark += `<text class="wetter-chart-nowlabel" x="${x}" y="${PADDING.top - 10}" text-anchor="middle">jetzt</text>`;
      }
    }
  }

  const svg = `            <svg class="wetter-chart wetter-chart--${variant}" viewBox="0 0 ${WIDTH} ${HEIGHT}"
                 preserveAspectRatio="${layout.preserveAspectRatio}" role="img"
                 aria-label="Verlauf von Temperatur, Sonnenintensität und Niederschlag über den Prognosezeitraum">
              ${grid}
              ${sunArea ? `<path class="wetter-chart-area wetter-chart-area--sun" d="${sunArea}"></path>` : ''}
              ${rainBars}
              ${dayMarks}
              ${nowMark}
              <path class="wetter-chart-line wetter-chart-line--sun" d="${sunPath}"></path>
              <path class="wetter-chart-line wetter-chart-line--temp" d="${tempPath}"></path>
              ${sunAxis}
              ${timeMarks}
              <line class="wetter-chart-baseline" x1="${PADDING.left}" y1="${baseline}" x2="${PADDING.left + plotWidth}" y2="${baseline}"></line>
            </svg>`;

  // Schmale Bauform: Tagesnamen als gleich breite HTML-Zellen über dem SVG. Alle
  // Tage haben gleich viele Stunden, deshalb decken sie sich mit den Abschnitten
  // im SVG.
  const dayStrip = layout.labels ? '' : `            <div class="wetter-chart-days">
${boundaries.map((entry) => `              <span>${escapeHtml(shortWeekday(entry.day))}</span>`).join('\n')}
            </div>`;

  // Ohne Achsenbeschriftung trägt die Legende die Wertebereiche. Genannt wird
  // dabei der Bereich der **Daten**, nicht das gerundete Achsenmaximum — genau
  // wie in der Niederschlagszeile, die schon immer den echten Spitzenwert zeigt.
  const tempValues = hours.map((hour) => hour.temperature).filter((value) => value != null);
  const sunValues = hours.map((hour) => hour.radiation).filter((value) => value != null);
  const tempRange = layout.labels
    ? '(°C, linke Achse)'
    : `${formatNumber(Math.min(...tempValues), 0)} – ${formatNumber(Math.max(...tempValues), 0)} °C`;
  const sunRange = layout.labels
    ? '(W/m², rechte Achse)'
    : `bis ${formatNumber(sunValues.length ? Math.max(...sunValues) : 0, 0)} W/m²`;
  const rainRange = rainMax > 0
    ? `${layout.labels ? '(Balken, Spitze' : 'bis'} ${formatNumber(rainMax, 1)} mm${layout.labels ? ')' : '/h'}`
    : '(kein Niederschlag erwartet)';

  const legend = `            <div class="wetter-chart-legend">
              <span class="wetter-chart-key wetter-chart-key--temp">Temperatur ${escapeHtml(tempRange)}</span>
              <span class="wetter-chart-key wetter-chart-key--sun">Sonnenintensität ${escapeHtml(sunRange)}</span>
              <span class="wetter-chart-key wetter-chart-key--rain">Niederschlag ${escapeHtml(rainRange)}</span>
            </div>`;

  return renderFigure(variant, [dayStrip, svg, legend].filter(Boolean).join('\n'));
}

module.exports = {
  renderWeatherChart,
  scaleFor,
  niceStep,
  CHART_WIDTH: LAYOUTS.wide.width,
  CHART_HEIGHT: LAYOUTS.wide.height,
};
