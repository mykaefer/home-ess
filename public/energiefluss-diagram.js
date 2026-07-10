'use strict';

// Gemeinsame Zeichen-Logik des Energiefluss-Diagramms. Wird sowohl von der
// interaktiven Unterseite (mit Farb-Stift) als auch von der eigenständigen
// Export-Ansicht (viewport-füllend, ohne Bedienelemente) genutzt.
//
//   var diagram = EFDiagram(svgEl, { interactive: true, onEdit: fn });
//   diagram.draw(data, { showEnergy: true });      // zeichnen/aktualisieren
//   var size = diagram.measure(data, true);         // nur ausmessen (DOM-frei)
//
// showEnergy = false blendet die Zählersummen (heute/dieses Jahr bzw. Batterie-
// Info) aus und verkürzt die Knoten auf eine Zeile – Grundlage der stufenweisen
// Anpassung an kleine Viewports in der Export-Ansicht.

(function () {
  var SVGNS = 'http://www.w3.org/2000/svg';
  var COLORS = {
    central: 'var(--color-self)', pv: 'var(--color-pv)',
    grid: 'var(--color-grid)', battery: 'var(--color-battery)',
  };
  var GROUP_DEFAULT = '#0ea5e9';
  var SONSTIGE_COLOR = '#94a3b8';
  var DEACTIVATED_COLOR = '#cbd5e1';
  var ENERGY_KINDS = ['group', 'pv', 'grid', 'central', 'sonstige'];

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

  // Ausgangs-Baum inkl. synthetischer „Sonstige"-Blätter.
  function groupLN(g) {
    var kids = (g.children || []).map(groupLN);
    if (g.sonstigeW != null) {
      kids.push({ key: 'sonstige-' + g.id, kind: 'sonstige', title: 'Sonstige', powerW: g.sonstigeW, color: SONSTIGE_COLOR, todayKwh: g.sonstigeTodayKwh, yearKwh: g.sonstigeYearKwh, children: [] });
    }
    return { key: 'group-' + g.id, kind: 'group', id: g.id, title: g.title, powerW: g.powerW,
      color: g.color || GROUP_DEFAULT, meterGroup: g.meterGroup, deactivated: g.deactivated === true,
      todayKwh: g.todayKwh, yearKwh: g.yearKwh, children: kids };
  }
  function outputRoots(data) {
    var roots = (data.groups || []).map(groupLN);
    if (data.sonstige && data.sonstige.powerW != null) {
      roots.push({ key: 'sonstige-global', kind: 'sonstige', title: 'Sonstige', powerW: data.sonstige.powerW, color: SONSTIGE_COLOR, todayKwh: data.sonstige.todayKwh, yearKwh: data.sonstige.yearKwh, children: [] });
    }
    return roots;
  }

  // --- Layout: Snapshot -> Knoten + Kanten mit Koordinaten -------------------
  function layout(data, showEnergy) {
    var PAD = 24, COL_GAP = 88, ROW_GAP = 16;
    var NODE_H = showEnergy ? 48 : 32, PLANT_H = 30;
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
      var n = { key: node.key, kind: node.kind, id: node.id, x: xGroup0 + node.__depth * (W_GROUP + COL_GAP), y: outOff + node.__y - NODE_H / 2, w: W_GROUP, h: NODE_H, title: node.title, powerW: node.powerW, accent: node.color, color: node.color, meterGroup: node.meterGroup, deactivated: node.deactivated, todayKwh: node.todayKwh, yearKwh: node.yearKwh };
      nodes.push(n);
      links.push({ key: 'l-' + node.key, powerW: node.powerW, color: node.color, deactivated: node.deactivated,
        p1: parentNode ? anchorR(parentNode) : anchorR(central), p2: anchorL(n) });
      (node.children || []).forEach(function (c) { place(c, n); });
    }
    roots.forEach(function (r) { place(r, null); });

    return { nodes: nodes, links: links, width: Math.ceil(width), height: Math.ceil(height),
      empty: nodes.length <= 1 && !hasPv && !hasGrid && !hasBattery };
  }

  function EFDiagram(svg, opts) {
    opts = opts || {};
    var state = { sig: '', nodeEls: {}, linkEls: {}, showEnergy: true };

    function el(tag, attrs) {
      var e = document.createElementNS(SVGNS, tag);
      if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
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
      var wantsSecond = node.kind === 'battery' || ENERGY_KINDS.indexOf(node.kind) !== -1;
      var twoLine = state.showEnergy && wantsSecond;
      var g = el('g', { class: 'ef-node ef-node-' + node.kind, transform: 'translate(' + node.x + ',' + node.y + ')' });
      g.appendChild(el('rect', { class: 'ef-box', x: 0, y: 0, rx: 10, ry: 10, width: node.w, height: node.h }));
      var line1 = twoLine ? 19 : Math.round(node.h / 2) + 4;
      var title = el('text', { class: 'ef-title', x: 12, y: line1 });
      title.textContent = node.title;
      g.appendChild(title);
      var power = el('text', { class: 'ef-power', x: node.w - 12, y: line1, 'text-anchor': 'end' });
      g.appendChild(power);
      // Zeile 2: Batterie-Info bzw. Energie heute/dieses Jahr – nur mit showEnergy.
      var sub = null;
      var energyVal = null;
      if (twoLine && node.kind === 'battery') {
        sub = el('text', { class: 'ef-sub', x: 12, y: node.h - 9 });
        g.appendChild(sub);
      }
      if (twoLine && ENERGY_KINDS.indexOf(node.kind) !== -1) {
        var energy = el('text', { class: 'ef-energy', x: 12, y: node.h - 9 });
        var tip = el('title');
        tip.textContent = 'heute · dieses Jahr';
        energy.appendChild(tip);
        energyVal = el('tspan');
        energy.appendChild(energyVal);
        g.appendChild(energy);
      }
      var edit = null;
      if (opts.interactive && node.kind === 'group') {
        edit = el('g', { class: 'ef-edit' });
        edit.appendChild(el('circle', { cx: node.w - 13, cy: node.h - 13, r: 9 }));
        var pen = el('text', { class: 'ef-edit-icon', x: node.w - 13, y: node.h - 9, 'text-anchor': 'middle' });
        pen.textContent = '✎';
        edit.appendChild(pen);
        edit.dataset.groupId = node.id;
        edit.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (typeof opts.onEdit === 'function') opts.onEdit(Number(this.dataset.groupId), this.dataset.color || '');
        });
        g.appendChild(edit);
      }
      svg.appendChild(g);
      return { g: g, power: power, sub: sub, energy: energyVal, rect: g.querySelector('.ef-box'), edit: edit };
    }
    function updateNode(refs, node) {
      refs.power.textContent = fmtW(node.powerW);
      if (refs.sub) refs.sub.textContent = node.sub || '';
      if (refs.energy) refs.energy.textContent = 'H ' + fmtKwh(node.todayKwh) + ' · J ' + fmtKwh(node.yearKwh);
      refs.rect.style.stroke = node.deactivated ? DEACTIVATED_COLOR : node.accent;
      refs.g.classList.toggle('ef-deactivated', node.deactivated === true);
      if (refs.edit) refs.edit.dataset.color = node.color || '';
    }

    function draw(data, drawOpts) {
      var showEnergy = (drawOpts && 'showEnergy' in drawOpts) ? !!drawOpts.showEnergy : (opts.showEnergy !== false);
      state.showEnergy = showEnergy;
      var model = layout(data, showEnergy);
      var sig = model.nodes.map(function (n) { return n.key; }).join('|')
        + '::' + model.links.map(function (l) { return l.key; }).join('|')
        + '::' + (showEnergy ? 1 : 0);
      if (sig !== state.sig) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        state.nodeEls = {}; state.linkEls = {};
        svg.setAttribute('viewBox', '0 0 ' + model.width + ' ' + model.height);
        if (!opts.fitViewport) {
          svg.setAttribute('width', model.width);
          svg.setAttribute('height', model.height);
        }
        model.links.forEach(function (l) { state.linkEls[l.key] = buildLink(l); });
        model.nodes.forEach(function (n) { state.nodeEls[n.key] = buildNode(n); });
        state.sig = sig;
      }
      model.links.forEach(function (l) { if (state.linkEls[l.key]) updateLink(state.linkEls[l.key], l); });
      model.nodes.forEach(function (n) { if (state.nodeEls[n.key]) updateNode(state.nodeEls[n.key], n); });
      return { width: model.width, height: model.height, empty: model.empty };
    }

    return {
      draw: draw,
      measure: function (data, showEnergy) { return layout(data, showEnergy !== false); },
    };
  }

  window.EFDiagram = EFDiagram;
})();
