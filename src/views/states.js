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
        </div>
        <dialog id="statePropertiesDialog" class="value-dialog state-props-dialog">
          <form id="statePropertiesForm" method="dialog" class="dialog-form">
            <div class="dialog-hero"><div>
              <h3 id="statePropertiesTitle">Eigenschaften</h3>
              <p class="muted"><code id="statePropertiesTopic"></code></p>
            </div></div>
            <p id="statePropertiesError" class="error-text" hidden></p>
            <div class="state-props-tabbar" id="statePropertiesTabs" role="tablist"></div>
            <div id="statePropertiesPanels"></div>
            <div class="button-row">
              <button type="button" id="statePropertiesSave" onclick="saveStateProperties()">Speichern</button>
              <button type="button" class="secondary-button" onclick="document.getElementById('statePropertiesDialog').close()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;

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
    // ── Eigenschaften-Dialog eines States ────────────────────────────────────
    var statePropsData = null;
    function statePropsEscape(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function statePropsField(field, value, prefix) {
      // Der Schlüssel stammt aus einem Adaptermanifest: auch die daraus
      // gebildete Element-ID wird maskiert, bevor sie ins Markup geht.
      var id = statePropsEscape(prefix + '-' + field.key);
      var current = value === undefined || value === null ? field.default : value;
      var input;
      if (field.type === 'checkbox') {
        input = '<input type="checkbox" id="' + id + '" data-key="' + statePropsEscape(field.key) + '" data-type="checkbox"'
          + (current === true || current === 1 || current === '1' || current === 'on' ? ' checked' : '') + '>';
        return '<label class="checkbox-field" for="' + id + '">' + input
          + '<span>' + statePropsEscape(field.label) + '</span></label>'
          + (field.hint ? '<p class="settings-card-hint">' + statePropsEscape(field.hint) + '</p>' : '');
      }
      if (field.type === 'select') {
        var options = (field.options || []).map(function (option) {
          return '<option value="' + statePropsEscape(option.value) + '"'
            + (String(current) === String(option.value) ? ' selected' : '') + '>'
            + statePropsEscape(option.label) + '</option>';
        }).join('');
        input = '<select id="' + id + '" data-key="' + statePropsEscape(field.key) + '" data-type="select">' + options + '</select>';
      } else {
        input = '<input type="' + (field.type === 'number' ? 'number' : 'text') + '" id="' + id
          + '" data-key="' + statePropsEscape(field.key) + '" data-type="' + statePropsEscape(field.type)
          + '" value="' + statePropsEscape(current) + '">';
      }
      return '<label class="field-block"><span>' + statePropsEscape(field.label) + '</span>' + input + '</label>'
        + (field.hint ? '<p class="settings-card-hint">' + statePropsEscape(field.hint) + '</p>' : '');
    }
    function statePropsRender(data) {
      statePropsData = data;
      document.getElementById('statePropertiesTitle').textContent = data.name || 'Eigenschaften';
      document.getElementById('statePropertiesTopic').textContent = data.topic;
      var error = document.getElementById('statePropertiesError');
      error.hidden = true;
      error.textContent = '';
      var roundingOptions = [['nearest', 'Kaufmännisch'], ['floor', 'Abrunden'], ['ceil', 'Aufrunden'], ['trunc', 'Abschneiden']]
        .map(function (entry) {
          return '<option value="' + entry[0] + '"' + (data.general.rounding === entry[0] ? ' selected' : '') + '>' + entry[1] + '</option>';
        }).join('');
      var tabs = [{ key: 'general', label: 'Allgemein', active: false }].concat((data.adapters || []).map(function (adapter) {
        return { key: 'adapter-' + adapter.instanceId, label: adapter.label, active: adapter.active };
      }));
      document.getElementById('statePropertiesTabs').innerHTML = tabs.map(function (tab, index) {
        return '<button type="button" class="state-props-tab' + (index === 0 ? ' is-active' : '')
          + (tab.active ? ' state-props-tab--used' : '')
          + '" data-tab="' + statePropsEscape(tab.key) + '" role="tab"'
          + (tab.active ? ' title="Dieser State wird hier bereits verwendet."' : '')
          + ' onclick="statePropsTab(\\'' + statePropsEscape(tab.key) + '\\')">'
          + statePropsEscape(tab.label) + (tab.active ? ' •' : '') + '</button>';
      }).join('');
      var panels = ['<div class="state-props-panel" data-panel="general">'
        + '<div class="dialog-grid dialog-grid--two">'
        + '<label class="field-block"><span>Nachkommastellen</span><input type="number" id="statePropsDecimals" min="0" max="12" step="1" value="'
        + statePropsEscape(data.general.decimals == null ? '' : data.general.decimals) + '" placeholder="unverändert"></label>'
        + '<label class="field-block"><span>Rundung</span><select id="statePropsRounding">' + roundingOptions + '</select></label>'
        + '<label class="field-block"><span>Einheit</span><input type="text" id="statePropsUnit" maxlength="24" value="'
        + statePropsEscape(data.general.unit || '') + '"></label>'
        + '</div>'
        + '<p class="settings-card-hint">Leere Nachkommastellen lassen den Wert unverändert. Die Einheit wird in der Anzeige an den Wert angehängt und überschreibt die Einheit der Quelle.</p>'
        + '</div>'];
      (data.adapters || []).forEach(function (adapter) {
        var fields = adapter.fields.map(function (field) {
          return statePropsField(field, adapter.values[field.key], 'adapter-' + adapter.instanceId);
        }).join('');
        panels.push('<div class="state-props-panel" data-panel="adapter-' + adapter.instanceId + '" data-instance="'
          + adapter.instanceId + '" hidden>'
          + (adapter.schemaLabel ? '<h4 class="state-props-heading">' + statePropsEscape(adapter.schemaLabel) + '</h4>' : '')
          + (adapter.hint ? '<p class="settings-card-hint">' + statePropsEscape(adapter.hint) + '</p>' : '')
          + (adapter.running ? '' : '<p class="error-text">Diese Instanz läuft gerade nicht. Änderungen werden beim nächsten Start übernommen.</p>')
          + '<div class="dialog-grid dialog-grid--two">' + fields + '</div></div>');
      });
      document.getElementById('statePropertiesPanels').innerHTML = panels.join('');
      var save = document.getElementById('statePropertiesSave');
      save.disabled = !data.canWrite;
      var dialog = document.getElementById('statePropertiesDialog');
      if (!dialog.open) dialog.showModal();
    }
    function statePropsTab(key) {
      var tabs = document.querySelectorAll('#statePropertiesTabs .state-props-tab');
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === key);
      var panels = document.querySelectorAll('#statePropertiesPanels .state-props-panel');
      for (var j = 0; j < panels.length; j++) panels[j].hidden = panels[j].getAttribute('data-panel') !== key;
    }
    function openStateProperties(topic, name) {
      fetch('/states/properties?topic=' + encodeURIComponent(topic) + '&name=' + encodeURIComponent(name || ''),
        { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : Promise.reject(new Error('Laden fehlgeschlagen')); })
        .then(statePropsRender)
        .catch(function () { alert('Die Eigenschaften konnten nicht geladen werden.'); });
    }
    function saveStateProperties() {
      if (!statePropsData) return;
      var decimals = document.getElementById('statePropsDecimals').value;
      var payload = {
        topic: statePropsData.topic,
        general: {
          decimals: decimals === '' ? null : Number(decimals),
          rounding: document.getElementById('statePropsRounding').value,
          unit: document.getElementById('statePropsUnit').value,
        },
        adapters: {},
      };
      var panels = document.querySelectorAll('#statePropertiesPanels .state-props-panel[data-instance]');
      for (var i = 0; i < panels.length; i++) {
        var values = {};
        var inputs = panels[i].querySelectorAll('[data-key]');
        for (var j = 0; j < inputs.length; j++) {
          var input = inputs[j];
          values[input.getAttribute('data-key')] = input.getAttribute('data-type') === 'checkbox' ? input.checked : input.value;
        }
        payload.adapters[panels[i].getAttribute('data-instance')] = values;
      }
      fetch('/states/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) throw new Error(data && data.error ? data.error : 'Speichern fehlgeschlagen');
            return data;
          });
        })
        .then(function () {
          document.getElementById('statePropertiesDialog').close();
          statesReloadTree();
          setTimeout(statesRefresh, 500);
        })
        .catch(function (err) {
          var error = document.getElementById('statePropertiesError');
          error.textContent = err.message || 'Speichern fehlgeschlagen';
          error.hidden = false;
        });
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
                <button type="button" class="state-edit-button" title="Eigenschaften bearbeiten" aria-label="Eigenschaften von ${escapeHtml(st.name)} bearbeiten" onclick="openStateProperties('${escapeHtml(st.topic).replace(/'/g, '&#39;')}', '${escapeHtml(st.name).replace(/'/g, '&#39;')}')">✎</button>
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
