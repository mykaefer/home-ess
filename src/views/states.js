'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml } = require('./components');

// States-Seite: alle von Adaptern gemeldeten States als einklappbarer Baum
// (Instanz → Kategorie → State) mit aktuellem Wert. Live-Aktualisierung über den
// vorhandenen SSE-Kanal (homeess:mqtt) via /states/data.json.
function renderStates({ tree = [] } = {}) {
  const blocks = tree.length
    ? tree.map(renderInstanceBlock).join('\n')
    : '<div class="info-card"><p class="muted">Noch keine Adapter-States vorhanden. Lege auf der <a href="/adapter">Adapter-Seite</a> eine Instanz an und aktiviere sie.</p></div>';

  const body = `        <h1>States</h1>
        <p class="muted" style="margin-bottom:16px;">Von Adaptern bereitgestellte Werte. Angesprochen werden sie über <code>prefix://instanz/adresse</code>; hinter Topic-Feldern lassen sie sich direkt auswählen.</p>
        <div class="states-tree">
${blocks}
        </div>`;

  const script = `
    function statesRefresh() {
      fetch('/states/data.json', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.values) return;
          var nodes = document.querySelectorAll('[data-state-value]');
          for (var i = 0; i < nodes.length; i++) {
            var topic = nodes[i].getAttribute('data-state-value');
            if (Object.prototype.hasOwnProperty.call(data.values, topic)) {
              nodes[i].textContent = data.values[topic];
            }
          }
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
  const cats = inst.categories.length
    ? inst.categories.map((cat) => renderCategory(cat, 0, `${inst.prefix}://${inst.instanceName}`, '')).join('\n')
    : '          <p class="muted" style="margin:6px 0;">Dieser Adapter hat noch keine States gemeldet.</p>';

  return `          <div class="states-inst">
            <div class="states-inst-head">
              <span class="states-inst-name">${escapeHtml(inst.prefix)}://${escapeHtml(inst.instanceName)}</span>
              <span class="module-status ${statusClass}">${statusLabel}</span>
            </div>
${cats}
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
