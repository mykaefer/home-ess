'use strict';

// Unterseite „Energiefluss" von Messen + Schalten. Zeigt ein vollständig
// animiertes SVG-Flussdiagramm: eingangsseitig bündeln sich die PV-Anlagen zu
// einem Gesamtzweig, dazu Netzbezug (bei Einspeisung negativ) und die Batterie
// als neutrale Stabstelle; zentraler Knoten ist der Eigenverbrauch; ausgangs-
// seitig verzweigt der Fluss auf die (verschachtelten) Gruppen sowie den
// „Sonstige Verbraucher"-Rest (global und hinter jeder Zählergruppe), sodass das
// Bild in sich geschlossen ist. Quellen tragen ihre Systemfarbe (PV/Netz/
// Batterie/Eigenverbrauch), Gruppen eine frei wählbare Farbe; gerade durch
// Priorität oder Lastabwurf abgeschaltete Gruppen werden ausgegraut. Das Diagramm
// wird clientseitig aus dem /data-Snapshot gezeichnet und – ohne die Animation
// neu zu starten – live aktualisiert.

const { renderLayout } = require('./layout');

function renderEnergiefluss({ data = {} } = {}) {
  const body = `        <div class="panel-head">
          <div>
            <h1>Energiefluss</h1>
            <p class="muted">Live-Fluss von den Quellen (PV, Netz, Batterie) über den Eigenverbrauch zu den Verbrauchsgruppen. Untergruppen und der „Sonstige Verbraucher"-Rest verzweigen weiter nach rechts; einzelne Geräte werden bewusst nicht gezeigt. Über das Stift-Symbol lässt sich je Gruppe eine Farbe wählen.</p>
          </div>
        </div>

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
        </dialog>`;

  const script = `
    var initialData = ${JSON.stringify(data)};
    var SVGNS = 'http://www.w3.org/2000/svg';
    var svg = document.getElementById('efSvg');
    var flowState = { sig: '', nodeEls: {}, linkEls: {} };

    var COLORS = {
      central: 'var(--color-self)', pv: 'var(--color-pv)',
      grid: 'var(--color-grid)', battery: 'var(--color-battery)',
    };
    var GROUP_DEFAULT = '#0ea5e9';
    var SONSTIGE_COLOR = '#94a3b8';
    var DEACTIVATED_COLOR = '#cbd5e1';
    var PALETTE = ['#0ea5e9', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
      '#10b981', '#14b8a6', '#0f766e', '#64748b', '#a16207', '#be123c'];

    function el(tag, attrs) {
      var e = document.createElementNS(SVGNS, tag);
      if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
    function fmtW(w) {
      if (w == null) return '– W';
      var a = Math.abs(w);
      if (a >= 1000) return (w / 1000).toFixed(a >= 10000 ? 0 : 1).replace('.', ',') + ' kW';
      return Math.round(w) + ' W';
    }
    function fmtKwh(v) {
      if (v == null) return '–';
      var a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(1).replace('.', ',') + ' MWh';
      if (a >= 100) return Math.round(v) + ' kWh';
      if (a >= 10) return v.toFixed(1).replace('.', ',') + ' kWh';
      return v.toFixed(2).replace('.', ',') + ' kWh';
    }
    function strokeW(p) {
      if (p == null) return 2.5;
      return 2.5 + Math.min(9, Math.sqrt(Math.abs(p)) / 6);
    }
    function animDur(p) {
      var a = p == null ? 0 : Math.abs(p);
      if (a < 10) return 0;
      return Math.max(0.6, 2.6 - Math.min(2.0, a / 1500));
    }
    function pathD(p1, p2) {
      var dx = (p2.x - p1.x) * 0.5;
      return 'M' + p1.x + ',' + p1.y + ' C' + (p1.x + dx) + ',' + p1.y + ' ' + (p2.x - dx) + ',' + p2.y + ' ' + p2.x + ',' + p2.y;
    }

    // Ausgangs-Baum inkl. synthetischer „Sonstige Verbraucher"-Blätter.
    function groupLN(g) {
      var kids = (g.children || []).map(groupLN);
      if (g.sonstigeW != null) {
        kids.push({ key: 'sonstige-' + g.id, kind: 'sonstige', title: 'Sonstige Verbraucher', powerW: g.sonstigeW, color: SONSTIGE_COLOR, children: [] });
      }
      return { key: 'group-' + g.id, kind: 'group', id: g.id, title: g.title, powerW: g.powerW,
        color: g.color || GROUP_DEFAULT, meterGroup: g.meterGroup, deactivated: g.deactivated === true,
        todayKwh: g.todayKwh, yearKwh: g.yearKwh, children: kids };
    }
    function outputRoots(data) {
      var roots = (data.groups || []).map(groupLN);
      if (data.sonstige && data.sonstige.powerW != null) {
        roots.push({ key: 'sonstige-global', kind: 'sonstige', title: 'Sonstige Verbraucher', powerW: data.sonstige.powerW, color: SONSTIGE_COLOR, children: [] });
      }
      return roots;
    }

    // --- Layout: Snapshot -> Knoten + Kanten mit Koordinaten -----------------
    function layout(data) {
      var PAD = 24, COL_GAP = 88, ROW_GAP = 16;
      var NODE_H = 48, PLANT_H = 30;
      var W_PLANT = 128, W_SRC = 176, W_CENTRAL = 176, W_GROUP = 172;

      var plants = (data.pv && data.pv.plants) ? data.pv.plants : [];
      var hasPv = plants.length > 0 || (data.pv && data.pv.totalW != null);
      var hasGrid = data.grid && data.grid.powerW != null;
      var hasBattery = data.battery && data.battery.present;
      var roots = outputRoots(data);

      var cursor = 0, maxDepth = 0;
      function lo(node, depth) {
        node.__depth = depth; if (depth > maxDepth) maxDepth = depth;
        if (!node.children || !node.children.length) {
          node.__y = cursor + NODE_H / 2; cursor += NODE_H + ROW_GAP;
        } else {
          node.children.forEach(function (c) { lo(c, depth + 1); });
          node.__y = (node.children[0].__y + node.children[node.children.length - 1].__y) / 2;
        }
      }
      roots.forEach(function (r) { lo(r, 0); });
      var outputsH = Math.max(0, cursor - ROW_GAP);

      var plantsH = plants.length ? plants.length * (PLANT_H + ROW_GAP) - ROW_GAP : 0;
      var sources = [];
      if (hasPv) sources.push('pv');
      if (hasGrid) sources.push('grid');
      if (hasBattery) sources.push('battery');
      var sourcesH = sources.length ? sources.length * (NODE_H + ROW_GAP) - ROW_GAP : 0;

      var contentH = Math.max(outputsH, sourcesH, plantsH, NODE_H);
      var height = contentH + 2 * PAD;

      var xPlants = PAD;
      var xSrc = xPlants + (plants.length ? W_PLANT + COL_GAP : 0);
      var xCentral = xSrc + W_SRC + COL_GAP;
      var xGroup0 = xCentral + W_CENTRAL + COL_GAP;
      var width = (roots.length ? xGroup0 + (maxDepth + 1) * (W_GROUP + COL_GAP) - COL_GAP : xCentral + W_CENTRAL) + PAD;

      function centerOffset(blockH) { return PAD + (contentH - blockH) / 2; }
      function anchorR(n) { return { x: n.x + n.w, y: n.y + n.h / 2 }; }
      function anchorL(n) { return { x: n.x, y: n.y + n.h / 2 }; }
      var srcIndex = {}; sources.forEach(function (s, i) { srcIndex[s] = i; });
      var srcOff = centerOffset(sourcesH);

      var nodes = [], links = [];
      var ev = data.eigenverbrauch || {};
      var central = { key: 'central', kind: 'central', x: xCentral, y: centerOffset(NODE_H), w: W_CENTRAL, h: NODE_H, title: 'Eigenverbrauch', powerW: ev.powerW == null ? null : ev.powerW, accent: COLORS.central, todayKwh: ev.todayKwh, yearKwh: ev.yearKwh };
      nodes.push(central);

      if (hasPv) {
        var pvNode = { key: 'pv', kind: 'pv', x: xSrc, y: srcOff + srcIndex.pv * (NODE_H + ROW_GAP), w: W_SRC, h: NODE_H, title: 'PV gesamt', powerW: data.pv.totalW, accent: COLORS.pv, todayKwh: data.pv.todayKwh, yearKwh: data.pv.yearKwh };
        nodes.push(pvNode);
        var poff = centerOffset(plantsH);
        plants.forEach(function (p, i) {
          var pn = { key: 'plant-' + p.id, kind: 'pv-plant', x: xPlants, y: poff + i * (PLANT_H + ROW_GAP), w: W_PLANT, h: PLANT_H, title: p.name, powerW: p.powerW, accent: COLORS.pv };
          nodes.push(pn);
          links.push({ key: 'l-plant-' + p.id, powerW: p.powerW, color: COLORS.pv, p1: anchorR(pn), p2: anchorL(pvNode) });
        });
        links.push({ key: 'l-pv', powerW: data.pv.totalW, color: COLORS.pv, p1: anchorR(pvNode), p2: anchorL(central) });
      }
      if (hasGrid) {
        var gn = { key: 'grid', kind: 'grid', x: xSrc, y: srcOff + srcIndex.grid * (NODE_H + ROW_GAP), w: W_SRC, h: NODE_H, title: 'Netz', powerW: data.grid.powerW, accent: COLORS.grid, todayKwh: data.grid.todayKwh, yearKwh: data.grid.yearKwh };
        nodes.push(gn);
        var imp = data.grid.powerW >= 0;
        links.push({ key: 'l-grid', powerW: data.grid.powerW, color: COLORS.grid,
          p1: imp ? anchorR(gn) : anchorL(central), p2: imp ? anchorL(central) : anchorR(gn) });
      }
      if (hasBattery) {
        var soc = data.battery.soc;
        var pw = data.battery.powerW;
        var bn = { key: 'battery', kind: 'battery', x: xSrc, y: srcOff + srcIndex.battery * (NODE_H + ROW_GAP), w: W_SRC, h: NODE_H, title: 'Batterie', powerW: pw, accent: COLORS.battery, sub: (soc != null ? Math.round(soc) + ' %' : '') + (pw != null && pw < 0 ? ' entlädt' : (pw != null && pw > 0 ? ' lädt' : '')) };
        nodes.push(bn);
        if (pw != null && pw < 0) {
          links.push({ key: 'l-batt', powerW: pw, color: COLORS.battery, p1: anchorR(bn), p2: anchorL(central) });
        } else {
          links.push({ key: 'l-batt', powerW: pw, color: COLORS.battery, p1: anchorL(central), p2: anchorR(bn) });
        }
      }

      var outOff = centerOffset(outputsH);
      function place(node, parentNode) {
        var w = node.kind === 'sonstige' ? W_GROUP : W_GROUP;
        var n = { key: node.key, kind: node.kind, id: node.id, x: xGroup0 + node.__depth * (W_GROUP + COL_GAP), y: outOff + node.__y - NODE_H / 2, w: w, h: NODE_H, title: node.title, powerW: node.powerW, accent: node.color, color: node.color, meterGroup: node.meterGroup, deactivated: node.deactivated, todayKwh: node.todayKwh, yearKwh: node.yearKwh };
        nodes.push(n);
        links.push({ key: 'l-' + node.key, powerW: node.powerW, color: node.color, deactivated: node.deactivated,
          p1: parentNode ? anchorR(parentNode) : anchorR(central), p2: anchorL(n) });
        (node.children || []).forEach(function (c) { place(c, n); });
      }
      roots.forEach(function (r) { place(r, null); });

      return { nodes: nodes, links: links, width: Math.ceil(width), height: Math.ceil(height),
        empty: nodes.length <= 1 && !hasPv && !hasGrid && !hasBattery };
    }

    // --- Zeichnen ------------------------------------------------------------
    function buildLink(link) {
      var base = el('path', { class: 'ef-base', d: pathD(link.p1, link.p2) });
      var flow = el('path', { d: pathD(link.p1, link.p2) });
      svg.appendChild(base);
      svg.appendChild(flow);
      return { base: base, flow: flow };
    }
    function updateLink(refs, link) {
      var d = pathD(link.p1, link.p2);
      refs.base.setAttribute('d', d);
      refs.flow.setAttribute('d', d);
      var dur = link.deactivated ? 0 : animDur(link.powerW);
      refs.flow.setAttribute('class', 'ef-flow' + (dur === 0 ? ' ef-idle' : ''));
      refs.flow.style.stroke = link.deactivated ? DEACTIVATED_COLOR : link.color;
      refs.flow.style.strokeWidth = strokeW(link.powerW);
      refs.flow.style.animationDuration = dur ? dur + 's' : '';
    }
    function buildNode(node) {
      var g = el('g', { class: 'ef-node ef-node-' + node.kind, transform: 'translate(' + node.x + ',' + node.y + ')' });
      g.appendChild(el('rect', { class: 'ef-box', x: 0, y: 0, rx: 10, ry: 10, width: node.w, height: node.h }));
      var hasEnergy = ['group', 'pv', 'grid', 'central'].indexOf(node.kind) !== -1;
      // Zeile 1: Titel links, Leistung rechtsbündig.
      var line1 = hasEnergy || node.kind === 'battery' ? 19 : Math.round(node.h / 2) + 4;
      var title = el('text', { class: 'ef-title', x: 12, y: line1 });
      title.textContent = node.title;
      g.appendChild(title);
      var power = el('text', { class: 'ef-power', x: node.w - 12, y: line1, 'text-anchor': 'end' });
      g.appendChild(power);
      // Zeile 2: Verbrauchswerte bzw. Batterie-Info (gleiche Schriftgröße).
      var sub = el('text', { class: 'ef-sub', x: 12, y: node.h - 9 });
      g.appendChild(sub);
      // Energie heute / dieses Jahr (Gruppen sowie PV/Netz/Eigenverbrauch). Der
      // sichtbare Text liegt in einem tspan, damit der <title>-Tooltip bleibt.
      var energyVal = null;
      if (hasEnergy) {
        var energy = el('text', { class: 'ef-energy', x: 12, y: node.h - 9 });
        var tip = el('title');
        tip.textContent = 'heute · dieses Jahr';
        energy.appendChild(tip);
        energyVal = el('tspan');
        energy.appendChild(energyVal);
        g.appendChild(energy);
      }
      var edit = null;
      if (node.kind === 'group') {
        edit = el('g', { class: 'ef-edit' });
        edit.appendChild(el('circle', { cx: node.w - 13, cy: node.h - 13, r: 9 }));
        var pen = el('text', { class: 'ef-edit-icon', x: node.w - 13, y: node.h - 9, 'text-anchor': 'middle' });
        pen.textContent = '✎';
        edit.appendChild(pen);
        edit.dataset.groupId = node.id;
        edit.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openColorDialog(Number(this.dataset.groupId), this.dataset.color || '');
        });
        g.appendChild(edit);
      }
      svg.appendChild(g);
      return { g: g, power: power, sub: sub, energy: energyVal, rect: g.querySelector('.ef-box'), edit: edit };
    }
    function updateNode(refs, node) {
      refs.power.textContent = fmtW(node.powerW);
      refs.sub.textContent = node.sub || '';
      if (refs.energy) refs.energy.textContent = 'H ' + fmtKwh(node.todayKwh) + ' · J ' + fmtKwh(node.yearKwh);
      refs.rect.style.stroke = node.deactivated ? DEACTIVATED_COLOR : node.accent;
      refs.g.classList.toggle('ef-deactivated', node.deactivated === true);
      if (refs.edit) refs.edit.dataset.color = node.color || '';
    }

    function draw(data) {
      var model = layout(data);
      document.getElementById('efEmpty').hidden = !model.empty;
      var sig = model.nodes.map(function (n) { return n.key; }).join('|') + '::' + model.links.map(function (l) { return l.key; }).join('|');
      if (sig !== flowState.sig) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        flowState.nodeEls = {}; flowState.linkEls = {};
        svg.setAttribute('viewBox', '0 0 ' + model.width + ' ' + model.height);
        svg.setAttribute('width', model.width);
        svg.setAttribute('height', model.height);
        model.links.forEach(function (l) { flowState.linkEls[l.key] = buildLink(l); });
        model.nodes.forEach(function (n) { flowState.nodeEls[n.key] = buildNode(n); });
        flowState.sig = sig;
      }
      model.links.forEach(function (l) { if (flowState.linkEls[l.key]) updateLink(flowState.linkEls[l.key], l); });
      model.nodes.forEach(function (n) { if (flowState.nodeEls[n.key]) updateNode(flowState.nodeEls[n.key], n); });
    }

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
