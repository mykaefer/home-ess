'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml } = require('./components');

// Zentrale States-Seite: berechnete Systemwerte und von Adaptern gemeldete
// States in einem gemeinsamen Baum mit aktuellem Wert.
// Nur der Baum selbst – die Seite lädt ihn bei Strukturänderungen nach, ohne
// dass der Nutzer neu laden muss.
function renderStatesTree(tree = []) {
  return tree.length
    ? tree.map(renderInstanceBlock).join('\n')
    : '<div class="info-card"><p class="muted">Noch keine States vorhanden.</p></div>';
}

function renderStates({ tree = [] } = {}) {
  const blocks = renderStatesTree(tree);

  const body = `        <h1>States</h1>
        <p class="muted" style="margin-bottom:16px;">Zentrale Übersicht aller internen Systemwerte, Custom States und Adapter-States. Eigene les- und schreibbare Werte lassen sich unter <a href="/states/custom">Custom States</a> verwalten.</p>
        <div class="states-tree">
${blocks}
        </div>`;

  const script = `
    function statesApplyValues(values) {
      var nodes = document.querySelectorAll('[data-state-value]');
      for (var i = 0; i < nodes.length; i++) {
        var topic = nodes[i].getAttribute('data-state-value');
        if (Object.prototype.hasOwnProperty.call(values, topic)) {
          nodes[i].textContent = values[topic];
        }
      }
    }
    // Kommen States dazu oder fallen welche weg (z. B. Broker-Clients, die
    // Topics anlegen, oder die Idle-Bereinigung), stimmt der gerenderte Baum
    // nicht mehr mit den gelieferten Werten überein.
    function statesStructureChanged(values) {
      var nodes = document.querySelectorAll('[data-state-value]');
      var known = {};
      for (var i = 0; i < nodes.length; i++) known[nodes[i].getAttribute('data-state-value')] = true;
      var count = 0;
      for (var topic in values) {
        if (!Object.prototype.hasOwnProperty.call(values, topic)) continue;
        count += 1;
        if (!known[topic]) return true;
      }
      return count !== nodes.length;
    }
    var statesTreeLoading = false;
    function statesReloadTree(values) {
      if (statesTreeLoading) return;
      statesTreeLoading = true;
      fetch('/states/tree.json', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          var container = document.querySelector('.states-tree');
          if (!data || typeof data.html !== 'string' || !container) return;
          container.innerHTML = data.html;
          statesRestoreExpansion();
          if (values) statesApplyValues(values);
        })
        .catch(function () {})
        .then(function () { statesTreeLoading = false; });
    }
    function statesRefresh() {
      fetch('/states/data.json', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.values) return;
          if (statesStructureChanged(data.values)) statesReloadTree(data.values);
          else statesApplyValues(data.values);
        })
        .catch(function () {});
    }
    var STATES_EXPANSION_KEY = 'homeess.states.expanded.v2';
    function statesExpansionLoad() {
      try { return JSON.parse(localStorage.getItem(STATES_EXPANSION_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }
    function statesToggle(head) {
      var cat = head.parentNode;
      cat.classList.toggle('is-open');
      var key = cat.getAttribute('data-tree-key');
      if (!key) return;
      var expanded = statesExpansionLoad();
      expanded[key] = cat.classList.contains('is-open');
      try { localStorage.setItem(STATES_EXPANSION_KEY, JSON.stringify(expanded)); } catch (_) {}
    }
    function statesRestoreExpansion() {
      var expanded = statesExpansionLoad();
      var cats = document.querySelectorAll('.states-tree [data-tree-key]');
      for (var i = 0; i < cats.length; i++) {
        var key = cats[i].getAttribute('data-tree-key');
        cats[i].classList.toggle('is-open', expanded[key] === true);
      }
    }
    // MQTT-Events kommen in Bursts – pro Burst nur EIN Nachladen (coalesced),
    // sonst flutet die offene Seite den Server mit /states/data.json-Anfragen.
    var statesQueued = false;
    function queueStatesRefresh() {
      if (statesQueued) return;
      statesQueued = true;
      setTimeout(function () { statesQueued = false; statesRefresh(); }, 1000);
    }
    statesRestoreExpansion();
    statesRefresh();
    window.addEventListener('pageshow', statesRestoreExpansion);
    window.addEventListener('homeess:mqtt', queueStatesRefresh);
    setInterval(statesRefresh, 15000);
  `;

  return renderLayout({ title: 'States', activePath: '/states', body, script });
}

function renderInstanceBlock(inst) {
  const statusClass = inst.enabled ? (inst.running ? 'module-status--on' : 'module-status--off') : 'module-status--off';
  const statusLabel = !inst.enabled ? 'Inaktiv' : inst.running ? 'Läuft' : 'Startet…';
  const instanceKey = `${inst.prefix}://${inst.instanceName}`;
  const cats = inst.categories.length
    ? inst.categories.map((cat) => renderCategory(cat, 0, instanceKey, '')).join('\n')
    : '          <p class="muted" style="margin:6px 0;">Dieser Adapter hat noch keine States gemeldet.</p>';
  const stateCount = inst.categories.reduce((sum, cat) => sum + (cat.stateCount == null ? cat.states.length : cat.stateCount), 0);

  // System und virtuelle Blöcke haben keinen
  // Adapter-Prozess: sprechender Name statt prefix://instanz, kein Status-Badge.
  const title = inst.custom ? 'custom://' : inst.virtual
    ? escapeHtml(inst.adapterName || inst.instanceName)
    : `${escapeHtml(inst.prefix)}://${escapeHtml(inst.instanceName)}`;
  const status = inst.virtual ? '' : `
              <span class="module-status ${statusClass}">${statusLabel}</span>`;
  // Die Prefix-Gruppe ist genauso auf- und zuklappbar wie ihre Kategorien und
  // merkt sich den Zustand unter demselben Schlüssel.
  return `          <div class="states-inst" data-tree-key="${escapeHtml(instanceKey)}">
            <button type="button" class="states-inst-head" onclick="statesToggle(this)">
              <span class="states-inst-caret">▸</span>
              <span class="states-inst-name">${title}</span>${status}
              <span class="states-inst-count">${stateCount}</span>
            </button>
            <div class="states-inst-body">
${cats}
            </div>
          </div>`;
}

function renderCategory(cat, depth = 0, instanceKey = '', parentPath = '') {
  const rows = cat.states.map((st) => {
    const valueAttr = escapeHtml(st.topic);
    return `              <div class="value-row">
                <span class="value-row-label">${escapeHtml(st.name)}${st.writable ? ' <span class="muted" style="font-size:0.8em;">(schreibbar)</span>' : ''}</span>
                <span class="value-row-now" data-state-value="${valueAttr}">${escapeHtml(st.display == null ? '—' : st.display)}</span>
              </div>`;
  }).join('\n');

  const path = parentPath ? `${parentPath}/${cat.name}` : cat.name;
  const treeKey = `${instanceKey}/${path}`;
  const children = (cat.children || []).map((child) => renderCategory(child, depth + 1, instanceKey, path)).join('\n');
  return `            <div class="value-cat state-tree-level${depth ? ' value-cat--nested' : ''}" style="--tree-depth:${depth}" data-tree-key="${escapeHtml(treeKey)}">
              <button type="button" class="value-cat-head" onclick="statesToggle(this)">
                <span class="value-cat-caret">▸</span>
                <span class="value-cat-name">${escapeHtml(cat.name)}</span>
                <span class="value-cat-count">${cat.stateCount == null ? cat.states.length : cat.stateCount}</span>
              </button>
              <div class="value-cat-body">
${rows}
${children}
              </div>
            </div>`;
}

module.exports = renderStates;
module.exports.renderStatesTree = renderStatesTree;
