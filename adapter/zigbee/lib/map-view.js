'use strict';

// Netzwerkkarte des Zigbee-Netzes.
//
// Gezeichnet wird als eingebettetes SVG im Browser: Die Knoten ordnen sich in
// einer kräftebasierten Simulation selbst an, die Kanten zeigen die tatsächlich
// gemessenen Funkstrecken. Strichstärke und Farbe folgen der
// Verbindungsqualität (LQI), damit eine schwache Strecke ohne Zahlenlesen
// auffällt.
//
// Bewusst ohne Fremdbibliothek: Der Adapter bringt für seine Oberfläche keine
// weiteren Abhängigkeiten mit, und die Seite bleibt damit vollständig
// eigenständig.

const topologyLib = require('./topology');
const mapLayout = require('./map-layout');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Symbole ─────────────────────────────────────────────────────────────────
//
// Jede Gattung bekommt ein eigenes Piktogramm. Die Pfade sind auf ein Feld von
// 24 × 24 gezeichnet und werden im Knoten zentriert skaliert. `currentColor`
// sorgt dafür, dass sie die Zustandsfarbe des Knotens übernehmen.

const ICONS = {
  coordinator: '<path d="M12 3v7M12 21v-4M5.6 6.6a9 9 0 0 0 0 12.7M18.4 6.6a9 9 0 0 1 0 12.7M8.5 9.5a5 5 0 0 0 0 6.9M15.5 9.5a5 5 0 0 1 0 6.9"/><circle cx="12" cy="13" r="2.2"/>',
  light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6v.5h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z"/>',
  outlet: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9.5 9v2.5M14.5 9v2.5M8.5 13.5h7a3.5 3.5 0 0 1-7 0z"/>',
  relay: '<rect x="3" y="7" width="18" height="10" rx="3"/><circle cx="8.5" cy="12" r="2.4"/><path d="M14 10.5h4M14 13.5h4"/>',
  cover: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 8h17M3.5 12h17M12 15v5.5M9 18l3 2.5 3-2.5"/>',
  thermostat: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 8v7"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.4"/>',
  fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-3 .8-5.5 3-5.5s2.4 3.4 0 4.6M14 12c3 0 5.5.8 5.5 3s-3.4 2.4-4.6 0M12 14c0 3-.8 5.5-3 5.5s-2.4-3.4 0-4.6M10 12c-3 0-5.5-.8-5.5-3s3.4-2.4 4.6 0"/>',
  motion: '<circle cx="13" cy="4.6" r="1.8"/><path d="M8 21l2.5-5.5.5-3.5-2.5 2-2-3M13 8l2 3.5 3.5 1M11 12.5l3 2 1 6.5"/>',
  contact: '<rect x="3.5" y="4" width="8" height="16" rx="1.5"/><rect x="14" y="4" width="6.5" height="16" rx="1.5"/><path d="M9.2 12h.01"/>',
  smoke: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"/>',
  water: '<path d="M12 3.5S5.5 11 5.5 15a6.5 6.5 0 0 0 13 0c0-4-6.5-11.5-6.5-11.5z"/>',
  button: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/>',
  sensor: '<path d="M6.5 20V9a5.5 5.5 0 0 1 11 0v11"/><path d="M4 20h16M9.5 12h5M9.5 16h5"/>',
  router: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M10.5 16.5h.01M12 10V6M8.8 8.2a4.5 4.5 0 0 1 6.4 0M6.3 5.7a8 8 0 0 1 11.4 0"/>',
  unknown: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.3 3.3c-.6.3-.9.9-.9 1.6v.3"/><path d="M12 18h.01"/>',
};

function iconSymbols() {
  return Object.entries(ICONS).map(([kind, body]) => `
    <symbol id="zbIcon-${escapeHtml(kind)}" viewBox="0 0 24 24">
      <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g>
    </symbol>`).join('');
}

/**
 * Legende der Verbindungsqualität. Sie erklärt genau die Kodierung, die die
 * Kanten verwenden — ohne sie wären Farbe und Stärke Dekoration.
 */
function renderLegend() {
  const steps = topologyLib.QUALITY_STEPS.map((step) => {
    const quality = topologyLib.qualityFor(step.min === 0 ? 30 : step.min + 20);
    return `<span class="zb-legend-item">
      <svg class="zb-legend-line" viewBox="0 0 40 12" aria-hidden="true">
        <line x1="2" y1="6" x2="38" y2="6" class="zb-edge zb-edge--${escapeHtml(quality.key)}"
          style="stroke-width:${(1 + quality.ratio * 4).toFixed(1)}"/>
      </svg>
      ${escapeHtml(step.label)} <span class="zb-dim">(LQI ${step.min}${step.min === 192 ? '+' : `–${
  step.min === 0 ? 63 : (step.min === 64 ? 127 : 191)}`})</span>
    </span>`;
  }).join('');
  return `<div class="zb-legend">${steps}
    <span class="zb-legend-item"><span class="zb-legend-dot zb-legend-dot--off"></span>nicht erreichbar</span>
    <span class="zb-legend-item"><span class="zb-legend-dot zb-legend-dot--battery"></span>Batteriegerät</span>
    <span class="zb-legend-item">
      <svg class="zb-legend-line" viewBox="0 0 40 12" aria-hidden="true">
        <line x1="2" y1="6" x2="38" y2="6" class="zb-edge zb-edge--good zb-edge--stale" style="stroke-width:3"/>
      </svg>
      nur Eintrag des Coordinators
    </span>
  </div>`;
}

/**
 * Baut den Kartenabschnitt. Die eigentliche Anordnung entsteht im Browser;
 * serverseitig wird nur das Gerüst und der Datensatz geliefert.
 */
function renderMap(map, access) {
  const scanned = map.scannedAt
    ? `Zuletzt ermittelt: ${new Date(map.scannedAt).toLocaleString('de-DE')}`
      + (map.reason ? ` · Anlass: ${map.reason}` : '')
    : 'Die Funkstrecken werden selbsttätig ermittelt, sobald das Netz steht.';

  const laeuft = !!(map.progress && map.progress.running);
  let hinweis = '';
  if (laeuft) {
    hinweis = `<p class="zb-note zb-note--busy">Die Funkstrecken werden gerade ermittelt
      (${map.progress.current || 0} von ${map.progress.total || '?'} Knoten). Die Seite aktualisiert sich selbst.</p>`;
  } else if (!map.edges.length) {
    hinweis = `<p class="zb-note">Die Geräte sind bekannt, ihre Funkstrecken noch nicht. Sie werden selbsttätig
       ermittelt, sobald das Netz steht — und erneut, wenn sich etwas daran ändert. Der Vorgang fragt Coordinator
       und Router nach ihren Nachbartabellen und dauert je nach Netzgröße einige Minuten.</p>`;
  }

  // Adressen sind für die Fehlersuche wertlos, solange nicht dabeisteht, um
  // welches Gerät es geht.
  const namen = new Map((map.nodes || []).map((node) => [node.address, node.name]));
  const benenne = (adressen) => (adressen || [])
    .map((adresse) => namen.get(adresse) || adresse)
    .sort((links, rechts) => String(links).localeCompare(String(rechts), 'de'));

  const warnungen = [];
  if (map.unreachable && map.unreachable.length) {
    const liste = benenne(map.unreachable);
    warnungen.push(`<p class="zb-note zb-note--warn">Ohne Antwort auf die Abfrage der Nachbartabelle:
      <strong>${liste.map((name) => escapeHtml(name)).join(', ')}</strong>.
      Von ${liste.length === 1 ? 'diesem Gerät' : 'diesen Geräten'} fehlen die ausgehenden Verbindungen in der
      Karte. Das Gerät selbst kann dabei einwandfrei arbeiten — Router beantworten diese Abfrage nur, wenn sie
      gerade nicht ausgelastet sind, und manche Firmware beantwortet sie gar nicht.</p>`);
  }
  if (map.isolated && map.isolated.length) {
    const liste = benenne(map.isolated);
    warnungen.push(`<p class="zb-note">Ohne erkannte Funkstrecke und deshalb am Rand abgesetzt:
      <strong>${liste.map((name) => escapeHtml(name)).join(', ')}</strong>.
      Batteriegeräte tauchen in Nachbartabellen oft nicht auf — das ist kein Fehler, ihre Route ist nur nicht
      ermittelbar.</p>`);
  }

  return `
  <div class="zb-map-bar">
    <span class="zb-dim" id="zbMapScanned">${escapeHtml(scanned)}</span>
    ${access.canWrite ? `<button type="button" class="zb-button zb-button--secondary" id="zbMapScan"${
  laeuft ? ' disabled' : ''}>${laeuft ? 'Wird ermittelt …' : 'Jetzt neu ermitteln'}</button>` : ''}
    <button type="button" class="zb-button zb-button--secondary" id="zbMapRelayout">Neu anordnen</button>
    <label class="zb-confirm"><input type="checkbox" id="zbMapLabels" checked> Namen anzeigen</label>
  </div>
  ${hinweis}
  ${warnungen.join('')}
  <div class="zb-map" id="zbMap">
    <svg id="zbMapSvg" class="zb-map-svg" role="img"
         aria-label="Karte des Zigbee-Netzes mit Geräten und ihren Funkverbindungen">
      <defs>${iconSymbols()}</defs>
      <g id="zbMapEdges"></g>
      <g id="zbMapNodes"></g>
    </svg>
    <div class="zb-map-empty" id="zbMapEmpty" hidden>Noch keine Geräte im Netz.</div>
    <!-- Bedienkachel: erscheint über dem Knoten, sobald der Zeiger ihn berührt.
         Sie liegt bewusst als HTML über dem SVG — echte Regler und Schalter
         lassen sich in SVG nicht darstellen. -->
    <div class="zb-hover-card" id="zbHoverCard" hidden></div>
  </div>
  ${renderLegend()}
  <div class="zb-map-detail" id="zbMapDetail" hidden></div>`;
}

/**
 * Das Browserskript: Kräftesimulation, Zeichnen, Bedienen.
 */
function mapScript(map, access, basePath) {
  const laeuft = !!(map.progress && map.progress.running);
  return `(function () {
  var base = ${JSON.stringify(basePath)};
  var canWrite = ${access.canWrite ? 'true' : 'false'};
  var canOperate = ${access.canOperate ? 'true' : 'false'};
  var data = ${JSON.stringify({ nodes: map.nodes, edges: map.edges })};

  var svg = document.getElementById('zbMapSvg');
  var edgeLayer = document.getElementById('zbMapEdges');
  var nodeLayer = document.getElementById('zbMapNodes');
  var detail = document.getElementById('zbMapDetail');
  var empty = document.getElementById('zbMapEmpty');
  if (!svg) return;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var width = 1000;
  var height = 640;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

  // Die Startlage bestimmt das Layout selbst; hier entstehen nur Arbeitskopien.
  var nodes = data.nodes.map(function (node) {
    return Object.assign({}, node, { x: 0, y: 0, vx: 0, vy: 0, fixed: false, pinned: false });
  });
  var byAddress = {};
  nodes.forEach(function (node) { byAddress[node.address] = node; });

  var edges = data.edges.filter(function (edge) {
    return byAddress[edge.source] && byAddress[edge.target];
  }).map(function (edge) {
    return Object.assign({}, edge, { a: byAddress[edge.source], b: byAddress[edge.target] });
  });

  if (!nodes.length) { if (empty) empty.hidden = false; return; }

  // ── Anordnung ─────────────────────────────────────────────────────────────
  // Dieselbe Funktion wie in lib/map-layout.js: Sie wird von dort eingebettet
  // und ist damit dieselbe Fassung, die die Tests prüfen.
  ${mapLayout.layoutSource()}

  function relayout(iterations) {
    layoutNetwork(nodes, edges, { width: width, height: height, iterations: iterations || 420 });
  }


  function element(name, attributes) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        node.setAttribute(key, attributes[key]);
      }
    }
    return node;
  }

  function stateClass(node) {
    if (node.isCoordinator) return 'zb-node--coordinator';
    if (node.available === false) return 'zb-node--offline';
    if (node.available === null || node.available === undefined) return 'zb-node--unknown';
    return 'zb-node--online';
  }

  var showLabels = true;
  var selected = null;

  function draw() {
    edgeLayer.textContent = '';
    nodeLayer.textContent = '';
    // Wird während einer offenen Kachel neu gezeichnet (Ziehen, Neuanordnen),
    // muss sie dem Knoten folgen.
    if (hoverNode && hoverCard && !hoverCard.hidden) {
      setTimeout(function () { kachelPlatzieren(hoverNode); }, 0);
    }

    edges.forEach(function (edge) {
      var quality = edge.quality || {};
      // Eine Kante zu einem Knoten, von dem nie etwas empfangen wurde, belegt
      // nur, dass der Coordinator ihn noch in seinen Tabellen führt — nicht,
      // dass dort ein Gerät antwortet. Sie wird deshalb blass gezeichnet.
      var ungewiss = edge.a.available === null || edge.b.available === null;
      var line = element('line', {
        x1: edge.a.x, y1: edge.a.y, x2: edge.b.x, y2: edge.b.y,
        'stroke-width': (1.2 + (quality.ratio || 0) * 5).toFixed(2),
        'stroke-linecap': 'round',
        class: 'zb-edge zb-edge--' + (quality.key || 'unknown')
          + (edge.relationship === 'parent-child' ? ' zb-edge--direct' : '')
          + (ungewiss ? ' zb-edge--stale' : '')
      });
      var title = document.createElementNS(SVG_NS, 'title');
      title.textContent = edge.a.name + ' ↔ ' + edge.b.name
        + ' · Qualität ' + (quality.label || 'unbekannt') + ' (LQI ' + (quality.lqi == null ? '?' : quality.lqi) + ')'
        + (edge.relationship === 'parent-child' ? ' · direkte Route' : '')
        + (ungewiss ? ' · Eintrag des Coordinators, vom Gerät nie bestätigt' : '');
      line.appendChild(title);
      edgeLayer.appendChild(line);
    });

    nodes.forEach(function (node) {
      var group = element('g', {
        class: 'zb-node ' + stateClass(node) + (selected === node.address ? ' zb-node--selected' : ''),
        transform: 'translate(' + node.x.toFixed(1) + ',' + node.y.toFixed(1) + ')',
        tabindex: '0', role: 'button',
        'aria-label': node.name + ', ' + node.kindLabel
      });
      var radius = node.isCoordinator ? 28 : 22;
      group.appendChild(element('circle', { r: radius + 4, class: 'zb-node-halo' }));
      group.appendChild(element('circle', { r: radius, class: 'zb-node-body' }));

      var use = element('use', {
        href: '#zbIcon-' + (node.kind || 'unknown'),
        x: -radius * 0.62, y: -radius * 0.62,
        width: radius * 1.24, height: radius * 1.24,
        class: 'zb-node-icon'
      });
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#zbIcon-' + (node.kind || 'unknown'));
      group.appendChild(use);

      // Ein eingeschaltetes Gerät bekommt einen Ring — der Schaltzustand ist
      // damit ohne Anklicken sichtbar.
      if (node.control && isOn(node.control)) {
        group.appendChild(element('circle', { r: radius + 7, class: 'zb-node-on' }));
      }
      if (node.deviceClass === 'battery') {
        group.appendChild(element('circle', { r: 4.5, cx: radius - 3, cy: -radius + 3, class: 'zb-node-battery' }));
      }
      if (showLabels) {
        var label = element('text', { y: radius + 17, class: 'zb-node-label' });
        label.textContent = node.name.length > 22 ? node.name.slice(0, 21) + '…' : node.name;
        group.appendChild(label);
      }
      var title = document.createElementNS(SVG_NS, 'title');
      title.textContent = node.name + ' · ' + node.kindLabel
        + (node.model ? ' · ' + node.model : '')
        + (node.linkquality == null ? '' : ' · LQI ' + node.linkquality);
      group.appendChild(title);

      // Berühren des Knotens zeigt die Bedienkachel, Anklicken stellt sie fest.
      // Ohne Zeigegerät (Telefon) übernimmt der Klick beides.
      group.addEventListener('mouseenter', function () { kachelZeigen(node, false); });
      group.addEventListener('mouseleave', kachelSpaeterSchliessen);
      group.addEventListener('focus', function () { kachelZeigen(node, false); });
      group.addEventListener('click', function (event) {
        event.stopPropagation();
        kachelZeigen(node, true);
      });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); kachelZeigen(node, true); }
      });
      makeDraggable(group, node);
      nodeLayer.appendChild(group);
    });
  }

  function isOn(control) {
    var value = control.value;
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    var on = control.valueOn === undefined ? 'ON' : control.valueOn;
    return String(value).toUpperCase() === String(on).toUpperCase();
  }

  // ── Ziehen ────────────────────────────────────────────────────────────────
  function makeDraggable(group, node) {
    var dragging = false;
    var moved = false;
    function point(event) {
      var rect = svg.getBoundingClientRect();
      var source = event.touches ? event.touches[0] : event;
      return {
        x: (source.clientX - rect.left) / rect.width * width,
        y: (source.clientY - rect.top) / rect.height * height
      };
    }
    function start(event) {
      dragging = true; moved = false;
      group.classList.add('zb-node--dragging');
      event.preventDefault();
    }
    function move(event) {
      if (!dragging) return;
      var position = point(event);
      node.x = Math.max(46, Math.min(width - 46, position.x));
      node.y = Math.max(46, Math.min(height - 46, position.y));
      node.pinned = true;
      moved = true;
      draw();
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      group.classList.remove('zb-node--dragging');
      if (!moved) return;
      draw();
    }
    group.addEventListener('mousedown', start);
    group.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
  }

  // ── Auswahl und Bedienung ─────────────────────────────────────────────────
  // ── Bedienkachel über dem Knoten ──────────────────────────────────────────
  //
  // Die Bedienung gehört dorthin, wo das Gerät steht. Die Kachel folgt dem
  // Knoten, bleibt offen, solange der Zeiger auf ihr liegt (sonst ließe sich
  // kein Regler ziehen), und lässt sich durch Anklicken des Knotens feststellen.
  var hoverCard = document.getElementById('zbHoverCard');
  var hoverNode = null;
  var hoverPinned = false;
  var hoverTimer = null;

  function hoverAbbrechen() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  }

  function kachelSchliessen() {
    hoverAbbrechen();
    hoverNode = null;
    hoverPinned = false;
    if (hoverCard) { hoverCard.hidden = true; hoverCard.innerHTML = ''; }
  }

  function kachelSpaeterSchliessen() {
    if (hoverPinned) return;
    hoverAbbrechen();
    hoverTimer = setTimeout(function () {
      hoverTimer = null;
      if (!hoverPinned) kachelSchliessen();
    }, 260);
  }

  function kachelPlatzieren(node) {
    if (!hoverCard) return;
    var flaeche = svg.getBoundingClientRect();
    // Der Knoten sitzt im viewBox-Raster; hier wird daraus die Lage im Bild.
    var x = (node.x / width) * flaeche.width;
    var y = (node.y / height) * flaeche.height;
    hoverCard.style.left = '0px';
    hoverCard.style.top = '0px';
    var breite = hoverCard.offsetWidth || 240;
    var hoehe = hoverCard.offsetHeight || 120;
    var links = Math.max(6, Math.min(flaeche.width - breite - 6, x - breite / 2));
    // Bevorzugt oberhalb des Knotens; unten, wenn dort kein Platz ist.
    var oben = y - hoehe - 34;
    if (oben < 6) oben = Math.min(flaeche.height - hoehe - 6, y + 34);
    hoverCard.style.left = Math.round(links) + 'px';
    hoverCard.style.top = Math.round(Math.max(6, oben)) + 'px';
  }

  function kachelZeigen(node, festhalten) {
    if (!hoverCard) return;
    hoverAbbrechen();
    if (festhalten) hoverPinned = true;
    if (hoverNode === node && !hoverCard.hidden) {
      kachelPlatzieren(node);
      return;
    }
    hoverNode = node;
    hoverCard.innerHTML = kachelInhalt(node);
    hoverCard.hidden = false;
    kachelPlatzieren(node);
    kachelVerdrahten(node);
  }

  function zustandstext(node) {
    if (node.isCoordinator) return 'verbunden';
    if (node.available === true) return 'erreichbar';
    if (node.available === false) return 'nicht erreichbar';
    return 'Zustand unbekannt';
  }

  function kachelInhalt(node) {
    var controls = canOperate ? bedienelemente(node) : '';
    var zusatz = '';
    if (!controls) {
      zusatz = (node.controls && node.controls.length)
        ? '<p class="zb-hover-hint">Zum Bedienen fehlt die Berechtigung.</p>'
        : '<p class="zb-hover-hint">Dieses Gerät bietet nichts zum Bedienen an.</p>';
    }
    var kennwerte = [];
    if (node.linkquality != null) kennwerte.push('LQI ' + escape(node.linkquality));
    if (node.battery != null) kennwerte.push(escape(node.battery) + ' % Batterie');
    return '<div class="zb-hover-head">'
      + '<span class="zb-hover-icon"><svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<use href="#zbIcon-' + escape(node.kind) + '" xlink:href="#zbIcon-' + escape(node.kind) + '"></use>'
      + '</svg></span>'
      + '<span class="zb-hover-title"><strong>' + escape(node.name) + '</strong>'
      + '<span class="zb-dim">' + escape(node.kindLabel) + ' · ' + escape(zustandstext(node))
      + (kennwerte.length ? ' · ' + kennwerte.join(' · ') : '') + '</span></span>'
      + (hoverPinned ? '<button type="button" class="zb-hover-close" id="zbHoverClose"'
        + ' aria-label="Schließen">×</button>' : '')
      + '</div>'
      + controls + zusatz
      + '<button type="button" class="zb-hover-more" data-more="1">Alle Angaben und Funkstrecken</button>';
  }

  function kachelVerdrahten(node) {
    verdrahteBedienelemente(hoverCard, node);
    var schliessen = hoverCard.querySelector('#zbHoverClose');
    if (schliessen) schliessen.addEventListener('click', kachelSchliessen);
    var mehr = hoverCard.querySelector('[data-more]');
    if (mehr) mehr.addEventListener('click', function () { select(node); });
  }

  if (hoverCard) {
    hoverCard.addEventListener('mouseenter', hoverAbbrechen);
    hoverCard.addEventListener('mouseleave', kachelSpaeterSchliessen);
  }
  if (svg) svg.addEventListener('mouseleave', kachelSpaeterSchliessen);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') kachelSchliessen();
  });

  function select(node) {
    selected = node.address;
    draw();
    renderDetail(node);
  }

  // Gebräuchliche Ausprägungen bekommen eine deutsche Beschriftung. Das ist
  // reine Darstellung — die Werte selbst bleiben unverändert, und ein hier
  // unbekannter Wert wird schlicht so angezeigt, wie er heißt.
  var WERTTEXTE = {
    OPEN: 'Auf', CLOSE: 'Zu', STOP: 'Stopp',
    ON: 'Ein', OFF: 'Aus', TOGGLE: 'Umschalten',
    LOCK: 'Sperren', UNLOCK: 'Entsperren',
    off: 'Aus', on: 'Ein', auto: 'Automatik', heat: 'Heizen', cool: 'Kühlen',
    previous: 'Wie zuvor', toggle: 'Umschalten'
  };
  function werttext(wert) {
    return WERTTEXTE[wert] === undefined ? String(wert) : WERTTEXTE[wert];
  }

  // Aus jedem beschreibbaren Merkmal wird das Bedienelement, das zu seiner Art
  // passt: Schalter für Ja/Nein, Regler für Zahlen mit Bereich, Tasten oder
  // Auswahl für mehrwertige Zustände. Ein Rollladen erhält dadurch seine
  // Fahrbefehle und den Positionsregler, ohne dass der Adapter Rollläden kennt.
  function bedienelemente(node) {
    var controls = node.controls || [];
    if (!controls.length) return '';
    var haupt = controls.filter(function (c) { return c.category !== 'config'; });
    var einstellungen = controls.filter(function (c) { return c.category === 'config'; });
    var html = '<div class="zb-controls">' + haupt.map(control).join('') + '</div>';
    if (einstellungen.length) {
      html += '<details class="zb-controls-config"><summary>Geräteeinstellungen ('
        + einstellungen.length + ')</summary><div class="zb-controls">'
        + einstellungen.map(control).join('') + '</div></details>';
    }
    return html;
  }

  function control(c) {
    var id = escape(c.property);
    var kopf = '<span class="zb-control-label">' + escape(c.label || c.property) + '</span>';

    if (c.type === 'binary') {
      var an = c.value === true;
      return '<div class="zb-control" data-control="' + id + '">' + kopf
        + '<div class="zb-control-body">'
        + '<button type="button" class="zb-toggle' + (an ? ' zb-toggle--on' : '') + '"'
        + ' data-set="' + id + '" data-value="' + (an ? 'false' : 'true') + '"'
        + ' aria-pressed="' + (an ? 'true' : 'false') + '">'
        + '<span class="zb-toggle-knob"></span><span class="zb-toggle-text">'
        + (an ? 'Ein' : 'Aus') + '</span></button>'
        + '</div></div>';
    }

    if (c.type === 'enum' && Array.isArray(c.values)) {
      // Wenige Möglichkeiten als Tasten — bei einem Rollladen sind das genau
      // Auf, Zu und Stopp. Viele Möglichkeiten als Auswahlliste.
      if (c.values.length <= 4) {
        return '<div class="zb-control" data-control="' + id + '">' + kopf
          + '<div class="zb-control-body zb-control-buttons">'
          + c.values.map(function (v) {
            return '<button type="button" class="zb-button zb-button--secondary'
              + (c.value === v ? ' zb-button--active' : '') + '"'
              + ' data-set="' + id + '" data-value="' + escape(v) + '">' + escape(werttext(v)) + '</button>';
          }).join('')
          + '</div></div>';
      }
      return '<div class="zb-control" data-control="' + id + '">' + kopf
        + '<div class="zb-control-body"><select data-set="' + id + '">'
        + c.values.map(function (v) {
          return '<option value="' + escape(v) + '"' + (c.value === v ? ' selected' : '') + '>'
            + escape(werttext(v)) + '</option>';
        }).join('')
        + '</select></div></div>';
    }

    if (c.type === 'numeric') {
      var wert = typeof c.value === 'number' ? c.value : (c.min == null ? 0 : c.min);
      var einheit = c.unit ? ' ' + escape(c.unit) : '';
      if (c.min != null && c.max != null) {
        return '<div class="zb-control" data-control="' + id + '">' + kopf
          + '<div class="zb-control-body zb-control-slider">'
          + '<input type="range" min="' + escape(c.min) + '" max="' + escape(c.max) + '"'
          + ' step="' + escape(c.step || 1) + '" value="' + escape(wert) + '" data-set="' + id + '">'
          + '<output data-output="' + id + '" data-unit="' + einheit + '">' + escape(wert) + einheit + '</output>'
          + '</div></div>';
      }
      return '<div class="zb-control" data-control="' + id + '">' + kopf
        + '<div class="zb-control-body"><input type="number" value="' + escape(wert) + '"'
        + ' step="' + escape(c.step || 1) + '" data-set="' + id + '">'
        + (c.unit ? '<span class="zb-dim">' + escape(c.unit) + '</span>' : '')
        + '</div></div>';
    }

    return '<div class="zb-control" data-control="' + id + '">' + kopf
      + '<div class="zb-control-body"><input type="text" value="'
      + escape(c.value === undefined ? '' : c.value) + '" data-set="' + id + '"></div></div>';
  }

  function row(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return '<div class="zb-detail-row"><span>' + label + '</span><strong>' + value + '</strong></div>';
  }

  function escape(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderDetail(node) {
    var verfuegbar = node.isCoordinator ? 'verbunden'
      : (node.available === true ? 'erreichbar'
        : (node.available === false ? 'nicht erreichbar' : 'unbekannt'));
    var verbindungen = edges.filter(function (edge) {
      return edge.source === node.address || edge.target === node.address;
    }).sort(function (a, b) { return (b.quality.lqi || 0) - (a.quality.lqi || 0); });

    var liste = verbindungen.length ? verbindungen.map(function (edge) {
      var other = edge.source === node.address ? edge.b : edge.a;
      return '<li><span class="zb-quality zb-quality--' + escape(edge.quality.key) + '"></span>'
        + escape(other.name) + ' <span class="zb-dim">' + escape(edge.quality.label)
        + ', LQI ' + escape(edge.quality.lqi == null ? '?' : edge.quality.lqi)
        + (edge.relationship === 'parent-child' ? ', direkte Route' : '') + '</span></li>';
    }).join('') : '<li class="zb-dim">Keine Funkstrecke ermittelt.</li>';

    // Bedient wird in der Kachel über dem Knoten; hier stehen die Angaben.
    var steuerung = '';

    detail.hidden = false;
    detail.innerHTML = '<div class="zb-detail-head">'
      + '<span class="zb-detail-icon zb-node--' + (node.isCoordinator ? 'coordinator' : 'online') + '">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#zbIcon-' + escape(node.kind) + '"'
      + ' xlink:href="#zbIcon-' + escape(node.kind) + '"></use></svg></span>'
      + '<div><h3>' + escape(node.name) + '</h3>'
      + '<span class="zb-dim">' + escape(node.kindLabel)
      + (node.vendor || node.model ? ' · ' + escape(node.vendor + ' ' + node.model) : '') + '</span></div>'
      + '<button type="button" class="zb-detail-close" id="zbDetailClose" aria-label="Schließen">×</button></div>'
      + steuerung
      + '<div class="zb-detail-grid">'
      + row('Status', escape(verfuegbar))
      + row('IEEE', '<code>' + escape(node.ieeeAddress) + '</code>')
      + row('Netzadresse', node.networkAddress == null ? '' : '0x' + Number(node.networkAddress).toString(16))
      + row('Rolle', escape(node.deviceType))
      + row('Versorgung', escape(node.powerSource))
      + row('Batterie', node.battery == null ? '' : escape(node.battery) + ' %')
      + row('LQI zum Coordinator', node.linkquality == null ? '' : escape(node.linkquality))
      + row('Tiefe im Netz', node.depth == null ? '' : escape(node.depth))
      + row('Zuletzt gesehen', node.lastSeen ? new Date(node.lastSeen).toLocaleString('de-DE') : '')
      + '</div>'
      + '<h4>Funkstrecken (' + verbindungen.length + ')</h4><ul class="zb-detail-links">' + liste + '</ul>';

    var close = document.getElementById('zbDetailClose');
    if (close) close.addEventListener('click', function () {
      detail.hidden = true; selected = null; draw();
    });
  }

  // Alle Bedienelemente gleich verdrahten — gleich, ob sie in der Kachel oder
  // im Detailfeld stehen. Tasten und Auswahl schalten sofort, Regler erst beim
  // Loslassen: Sonst ginge für jede Zwischenstellung ein Funkbefehl hinaus.
  function verdrahteBedienelemente(wurzel, node) {
    if (!wurzel) return;
    Array.prototype.forEach.call(wurzel.querySelectorAll('[data-set]'), function (element) {
      var property = element.getAttribute('data-set');
      var tag = element.tagName.toLowerCase();

      if (tag === 'button') {
        element.addEventListener('click', function () {
          var roh = element.getAttribute('data-value');
          var wert = roh === 'true' ? true : (roh === 'false' ? false : roh);
          setzen(node, property, wert, element);
        });
        return;
      }
      if (tag === 'select') {
        element.addEventListener('change', function () { setzen(node, property, element.value, element); });
        return;
      }
      if (element.type === 'range') {
        var anzeige = wurzel.querySelector('[data-output="' + property + '"]');
        var einheit = anzeige ? String(anzeige.getAttribute('data-unit') || '') : '';
        element.addEventListener('input', function () {
          if (anzeige) anzeige.textContent = element.value + einheit;
        });
        element.addEventListener('change', function () {
          setzen(node, property, Number(element.value), element);
        });
        return;
      }
      element.addEventListener('change', function () {
        var wert = element.type === 'number' ? Number(element.value) : element.value;
        setzen(node, property, wert, element);
      });
    });
  }

  function setzen(node, property, wert, element) {
    if (element) element.disabled = true;
    schreiben(node, property, wert)
      .catch(function (error) { alert(error.message); })
      .then(function () { if (element) element.disabled = false; });
  }

  function schreiben(node, property, value) {
    return fetch(base + '/devices/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device: node.address, property: property, value: value })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error((payload && payload.error) || 'Schalten fehlgeschlagen.');
        if (payload.state) {
          Object.keys(payload.state).forEach(function (key) {
            if (node.control && node.control.property === key) node.control.value = payload.state[key];
            (node.controls || []).forEach(function (c) {
              if (c.property === key) c.value = payload.state[key];
            });
          });
        }
        draw();
        if (hoverNode === node && hoverCard && !hoverCard.hidden) {
          hoverCard.innerHTML = kachelInhalt(node);
          kachelPlatzieren(node);
          kachelVerdrahten(node);
        }
        if (selected === node.address) renderDetail(node);
        return payload;
      });
    });
  }

  function schalten(node, property, an) {
    var control = node.control || {};
    var wert = an
      ? (control.valueOn === undefined ? true : control.valueOn)
      : (control.valueOff === undefined ? false : control.valueOff);
    return schreiben(node, property, wert);
  }

  // ── Bedienleiste ──────────────────────────────────────────────────────────
  var labelsBox = document.getElementById('zbMapLabels');
  if (labelsBox) labelsBox.addEventListener('change', function () {
    showLabels = labelsBox.checked; draw();
  });
  // Bewusst nicht relayout genannt: Eine var gleichen Namens würde die
  // Layoutfunktion im selben Geltungsbereich überschreiben.
  var relayoutButton = document.getElementById('zbMapRelayout');
  if (relayoutButton) relayoutButton.addEventListener('click', function () {
    nodes.forEach(function (node) { node.pinned = false; });
    relayout(420);
    draw();
  });
  var scan = document.getElementById('zbMapScan');
  if (scan) scan.addEventListener('click', function () {
    scan.disabled = true;
    var text = scan.textContent;
    scan.textContent = 'Scan läuft …';
    fetch(base + '/topology/scan', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) throw new Error((payload && payload.error) || 'Scan fehlgeschlagen.');
          location.reload();
        });
      })
      .catch(function (error) { scan.disabled = false; scan.textContent = text; alert(error.message); });
  });

  // Läuft gerade ein Durchlauf, holt die Seite das Ergebnis selbst ab. Die
  // Ermittlung wird meist automatisch angestoßen, nicht von Hand.
  if (${laeuft ? 'true' : 'false'}) {
    var warten = setInterval(function () {
      fetch(base + '/topology/progress', { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (response) { return response.json(); })
        .then(function (fortschritt) {
          if (!fortschritt || !fortschritt.running) { clearInterval(warten); location.reload(); }
        })
        .catch(function () {});
    }, 4000);
  }

  relayout(420);
  draw();
}());`;
}

module.exports = { renderMap, mapScript, ICONS, iconSymbols, escapeHtml };
