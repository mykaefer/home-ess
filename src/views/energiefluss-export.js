'use strict';

// Eigenständige, öffentlich abrufbare Live-Ansicht des Energiefluss-Diagramms
// (keine App-Navigation, keine Titel/Erklärungen). Der Baum wird über die
// gemeinsame Zeichen-Logik (/energiefluss-diagram.js) gezeichnet und füllt den
// Viewport: Das SVG skaliert den kompletten Baum via viewBox proportional in die
// Fläche. Wird es zu klein, fallen zuerst die Zählersummen weg (kompakte Knoten),
// bevor die Schrift weiter schrumpft. Legende unten links, Wasserzeichen unten
// rechts – beide am Viewport-Rand. Theme hell (wie auf der Seite) oder dunkel
// (schwarzer Hintergrund, helle Schrift).

const { escapeHtml } = require('./components');

let pkgVersion = '—';
try {
  // eslint-disable-next-line global-require
  pkgVersion = require('../../package.json').version || '—';
} catch (_) { pkgVersion = '—'; }

const LEGEND = [
  ['var(--color-pv)', 'PV'],
  ['var(--color-grid)', 'Netz'],
  ['var(--color-battery)', 'Batterie'],
  ['var(--color-self)', 'Eigenverbrauch'],
  ['#0ea5e9', 'Verbrauchergruppe'],
  ['#94a3b8', 'Sonstige Verbraucher'],
];

const STYLE = `
    html, body { margin: 0; height: 100%; }
    .ef-export { position: fixed; inset: 0; overflow: hidden; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .ef-export--dark { background: #000000;
      --color-pv: var(--color-pv-bright); --color-grid: var(--color-grid-bright);
      --color-self: var(--color-self-bright); --color-battery: var(--color-battery-bright); }
    .ef-export-svg { position: absolute; inset: 8px 8px 40px 8px; width: calc(100% - 16px); height: calc(100% - 48px); display: block; }
    .ef-export-empty { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 15px; }
    .ef-export-empty[hidden] { display: none; }

    .ef-export-legend { position: fixed; left: 14px; bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: #475569; max-width: 58vw; z-index: 2; }
    .ef-export--dark .ef-export-legend { color: #cbd5e1; }
    .ef-export-legend .ef-legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .ef-export-legend .ef-swatch { width: 16px; height: 8px; border-radius: 2px; display: inline-block; }

    .ef-export-watermark { position: fixed; right: 14px; bottom: 12px; text-align: right; font-size: 11px; line-height: 1.4; color: #94a3b8; z-index: 2; }
    .ef-export--dark .ef-export-watermark { color: #6b7280; }

    /* Dunkles Theme: Knoten und Schrift invertieren. */
    .ef-export--dark .ef-box { fill: #111827; stroke: #334155; }
    .ef-export--dark .ef-node-central .ef-box { fill: #17131f; }
    .ef-export--dark .ef-node-sonstige .ef-box { fill: #0f172a; }
    .ef-export--dark .ef-title { fill: #f1f5f9; }
    .ef-export--dark .ef-node-sonstige .ef-title { fill: #94a3b8; }
    .ef-export--dark .ef-power { fill: #cbd5e1; }
    .ef-export--dark .ef-sub, .ef-export--dark .ef-energy { fill: #94a3b8; }
    .ef-export--dark .ef-base { stroke: #334155; }
    .ef-export--dark .ef-node.ef-deactivated .ef-title,
    .ef-export--dark .ef-node.ef-deactivated .ef-power { fill: #64748b; }`;

function renderEnergieflussExport({ data = {}, theme = 'light', slug = '' } = {}) {
  const themeClass = theme === 'dark' ? 'ef-export--dark' : 'ef-export--light';
  const legend = LEGEND
    .map(([color, label]) => `<span class="ef-legend-item"><i class="ef-swatch" style="background:${color}"></i>${escapeHtml(label)}</span>`)
    .join('');
  const dataUrl = `/energiefluss/export/${encodeURIComponent(slug)}/data`;

  const script = `
    var data = ${JSON.stringify(data)};
    var svg = document.getElementById('efSvg');
    var empty = document.getElementById('efEmpty');
    var diagram = EFDiagram(svg, { interactive: false, fitViewport: true });
    // .ef-title-Größe in viewBox-Einheiten; sinkt die skalierte Schrift darunter,
    // werden zuerst die Zählersummen ausgeblendet (kompakte Knoten), statt weiter
    // zu schrumpfen.
    var BASE_TITLE_PX = 12;
    var DROP_ENERGY_PX = 10;

    function render() {
      var vw = svg.clientWidth || window.innerWidth;
      var vh = svg.clientHeight || window.innerHeight;
      var full = diagram.measure(data, true);
      var scale = full.width > 0 && full.height > 0 ? Math.min(vw / full.width, vh / full.height) : 1;
      var showEnergy = (BASE_TITLE_PX * scale) >= DROP_ENERGY_PX;
      var res = diagram.draw(data, { showEnergy: showEnergy });
      empty.hidden = !res.empty;
    }

    window.addEventListener('resize', render);
    render();

    async function refresh() {
      try {
        var res = await fetch(${JSON.stringify(dataUrl)}, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        data = await res.json();
        render();
      } catch (_) {}
    }
    window.addEventListener('homeess:mqtt', refresh);
    setInterval(refresh, 5000);`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Energiefluss</title>
  <link rel="stylesheet" href="/styles.css">
  <style>${STYLE}</style>
</head>
<body class="ef-export ${themeClass}">
  <svg id="efSvg" class="ef-export-svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Energiefluss-Diagramm"></svg>
  <p class="ef-export-empty" id="efEmpty" hidden>Noch keine Energieflussdaten vorhanden.</p>
  <div class="ef-export-legend">${legend}</div>
  <div class="ef-export-watermark">Generiert mit homeESS Version: ${escapeHtml(pkgVersion)}<br>Copyright (C) 2026 Kevin Käfer | MyKaefer Apps</div>
  <script src="/energiefluss-diagram.js"></script>
  <script>
${script}
  </script>
</body>
</html>`;
}

module.exports = renderEnergieflussExport;
