'use strict';

// Unterseite „Energiefluss" von Messen + Schalten. Zeigt ein vollständig
// animiertes SVG-Flussdiagramm (Zeichen-Logik in /energiefluss-diagram.js, von
// dieser Seite und den Exporten gemeinsam genutzt): eingangsseitig bündeln sich
// die PV-Anlagen zu einem Gesamtzweig, dazu Netzbezug (bei Einspeisung negativ)
// und die Batterie als neutrale Stabstelle; zentraler Knoten ist der
// Eigenverbrauch; ausgangsseitig verzweigt der Fluss auf die (verschachtelten)
// Gruppen sowie den „Sonstige"-Rest. Unter dem Diagramm lassen sich benannte,
// öffentlich abrufbare Exporte (hell/dunkel) verwalten.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function themeLabel(theme) {
  return theme === 'dark' ? 'Dunkel' : 'Hell';
}

function renderExportRow(entry) {
  const url = `/energiefluss/export/${escapeHtml(entry.slug)}`;
  return `            <li class="ef-export-row" data-id="${entry.id}" data-name="${escapeHtml(entry.name)}" data-theme="${escapeHtml(entry.theme)}">
              <div class="ef-export-main">
                <strong>${escapeHtml(entry.name)}</strong>
                <span class="ef-export-badge ef-export-badge--${escapeHtml(entry.theme)}">${themeLabel(entry.theme)}</span>
              </div>
              <a class="ef-export-url" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>
              <div class="ef-export-actions">
                <button type="button" class="widget-icon-btn" title="URL kopieren" onclick="copyExportUrl('${url}')">🔗</button>
                <button type="button" class="widget-icon-btn" title="Export bearbeiten" onclick="openExportDialog('edit', ${entry.id})">✎</button>
                <form method="POST" action="/messen-schalten/energiefluss/exports/${entry.id}/delete" onsubmit="return confirm('Export wirklich löschen?');">
                  <button type="submit" class="widget-icon-btn" title="Export entfernen">🗑</button>
                </form>
              </div>
            </li>`;
}

function renderEnergiefluss({ data = {}, exports = [], formMessage = '', formError = '' } = {}) {
  const exportList = exports.length
    ? `<ul class="ef-export-list">\n${exports.map(renderExportRow).join('\n')}\n          </ul>`
    : '<p class="muted">Noch keine Exporte angelegt.</p>';

  const body = `        <div class="panel-head">
          <div>
            <h1>Energiefluss</h1>
            <p class="muted">Live-Fluss von den Quellen (PV, Netz, Batterie) über den Eigenverbrauch zu den Verbrauchsgruppen. Untergruppen und der „Sonstige"-Rest verzweigen weiter nach rechts; einzelne Geräte werden bewusst nicht gezeigt. Über das Stift-Symbol lässt sich je Gruppe eine Farbe wählen.</p>
          </div>
        </div>

        ${formMessage ? statusText(formMessage, 'success') : ''}
        ${formError ? statusText(formError) : ''}

        <div class="ef-legend">
          <span class="ef-legend-item"><i class="ef-swatch" style="background:var(--color-pv)"></i>PV</span>
          <span class="ef-legend-item"><i class="ef-swatch" style="background:var(--color-grid)"></i>Netz</span>
          <span class="ef-legend-item"><i class="ef-swatch" style="background:var(--color-battery)"></i>Batterie</span>
          <span class="ef-legend-item"><i class="ef-swatch" style="background:var(--color-self)"></i>Eigenverbrauch</span>
          <span class="ef-legend-item"><i class="ef-swatch" style="background:#0ea5e9"></i>Verbrauchergruppe (eigene Farbe)</span>
          <span class="ef-legend-item"><i class="ef-swatch" style="background:#94a3b8"></i>Sonstige Verbraucher</span>
        </div>

        <div class="ef-wrap">
          <svg id="efSvg" class="ef-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Energiefluss-Diagramm"></svg>
          <p class="muted ef-empty" id="efEmpty" hidden>Noch keine Werte vorhanden. Sobald PV-, Netz-, Batterie- oder Gruppendaten vorliegen, erscheint der Energiefluss hier.</p>
        </div>

        <section class="panel-card ef-exports">
          <div class="panel-head">
            <div><h2>Exporte</h2><p class="muted">Öffentlich abrufbare Live-Ansichten des Diagramms. Die URL ergibt sich aus dem Namen; das Theme bestimmt helle oder dunkle Darstellung.</p></div>
            <button type="button" class="secondary-button" onclick="openExportDialog('add')">Export hinzufügen</button>
          </div>
          ${exportList}
        </section>

        <dialog id="efColorDialog" class="value-dialog ef-color-dialog">
          <form class="dialog-form" onsubmit="return false;">
            <h3>Gruppenfarbe wählen</h3>
            <div class="ef-swatch-grid" id="efSwatchGrid"></div>
            <label class="field-block" for="efColorInput"><span>Eigene Farbe</span>
              <input type="color" id="efColorInput" value="#0ea5e9"></label>
            <div class="button-row">
              <button type="button" onclick="saveColor()">Speichern</button>
              <button type="button" class="secondary-button" onclick="saveColor('')">Standardfarbe</button>
              <button type="button" class="secondary-button" onclick="closeColorDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>

        <dialog id="exportDialog" class="value-dialog">
          <form class="dialog-form" id="exportForm" method="POST" action="/messen-schalten/energiefluss/exports">
            <h3 id="exportDialogTitle">Export hinzufügen</h3>
            <label class="field-block" for="exportName"><span>Name</span>
              <input type="text" id="exportName" name="name" placeholder="z.B. Wohnzimmer-Display" required></label>
            <label class="field-block" for="exportTheme"><span>Theme</span>
              <select id="exportTheme" name="theme">
                <option value="light">Hell (wie auf der Seite)</option>
                <option value="dark">Dunkel (schwarzer Hintergrund)</option>
              </select></label>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeExportDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>

        <script src="/energiefluss-diagram.js"></script>`;

  const script = `
    var initialData = ${JSON.stringify(data)};
    var svg = document.getElementById('efSvg');
    var diagram = EFDiagram(svg, { interactive: true, onEdit: openColorDialog });
    var PALETTE = ['#0ea5e9', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
      '#10b981', '#14b8a6', '#0f766e', '#64748b', '#a16207', '#be123c'];

    // Schmale Viewports (Handy) zeichnen das Diagramm vertikal (eingerückter Baum),
    // breite horizontal. Bei Breitenwechsel wird mit den letzten Daten neu gezeichnet.
    var verticalMq = window.matchMedia('(max-width: 760px)');
    var lastData = null;
    function draw(data) {
      lastData = data;
      var res = diagram.draw(data, { showEnergy: true, vertical: verticalMq.matches });
      document.getElementById('efEmpty').hidden = !res.empty;
    }
    function onViewportChange() { if (lastData) draw(lastData); }
    if (verticalMq.addEventListener) verticalMq.addEventListener('change', onViewportChange);
    else if (verticalMq.addListener) verticalMq.addListener(onViewportChange);

    // --- Colorpicker-Dialog --------------------------------------------------
    var efColorGroupId = null;
    (function buildSwatches() {
      var grid = document.getElementById('efSwatchGrid');
      PALETTE.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ef-swatch-btn';
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', function () { document.getElementById('efColorInput').value = c; });
        grid.appendChild(b);
      });
    })();
    function openColorDialog(id, color) {
      efColorGroupId = id;
      document.getElementById('efColorInput').value = /^#/.test(color) ? color : '#0ea5e9';
      var d = document.getElementById('efColorDialog');
      if (typeof d.showModal === 'function') d.showModal();
    }
    function closeColorDialog() { var d = document.getElementById('efColorDialog'); if (d) d.close(); }
    function saveColor(forced) {
      if (efColorGroupId == null) return;
      var color = forced === '' ? '' : document.getElementById('efColorInput').value;
      fetch('/messen-schalten/groups/' + efColorGroupId + '/color', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: color })
      }).then(function () { closeColorDialog(); refresh(); }).catch(function () { closeColorDialog(); });
    }
    window.openColorDialog = openColorDialog;
    window.closeColorDialog = closeColorDialog;
    window.saveColor = saveColor;

    // --- Export-Verwaltung ---------------------------------------------------
    function openExportDialog(mode, id) {
      var dialog = document.getElementById('exportDialog');
      var form = document.getElementById('exportForm');
      var title = document.getElementById('exportDialogTitle');
      if (mode === 'edit' && id != null) {
        var row = document.querySelector('.ef-export-row[data-id="' + id + '"]');
        form.action = '/messen-schalten/energiefluss/exports/' + id;
        title.textContent = 'Export bearbeiten';
        document.getElementById('exportName').value = row ? row.getAttribute('data-name') : '';
        document.getElementById('exportTheme').value = row ? row.getAttribute('data-theme') : 'light';
      } else {
        form.action = '/messen-schalten/energiefluss/exports';
        title.textContent = 'Export hinzufügen';
        document.getElementById('exportName').value = '';
        document.getElementById('exportTheme').value = 'light';
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeExportDialog() { var d = document.getElementById('exportDialog'); if (d) d.close(); }
    function copyExportUrl(path) {
      var url = window.location.origin + path;
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
    }
    window.openExportDialog = openExportDialog;
    window.closeExportDialog = closeExportDialog;
    window.copyExportUrl = copyExportUrl;

    // --- Live-Aktualisierung -------------------------------------------------
    async function refresh() {
      try {
        var res = await fetch('/messen-schalten/energiefluss/data', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        draw(await res.json());
      } catch (_) {}
    }
    var refreshQueued = false;
    function queueRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(function () { refreshQueued = false; refresh(); }, 1000);
    }

    draw(initialData);
    window.addEventListener('homeess:mqtt', queueRefresh);
    setInterval(refresh, 5000);`;

  return renderLayout({ title: 'Energiefluss', activePath: '/messen-schalten/energiefluss', body, script });
}

module.exports = renderEnergiefluss;
