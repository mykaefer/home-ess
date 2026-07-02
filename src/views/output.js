'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { renderValueCatalog, valueCatalogScript } = require('./value-catalog');
const { VALUE_CATEGORIES } = require('../output/internal-values');

function renderOutput({
  outputs = [],
  internalValues = [],
  formMessage = '',
  formError = '',
  dialogMode = '',
  dialogError = '',
  dialogValues = null,
  editingOutputId = null,
} = {}) {
  const body = `        <h1>Output</h1>

        <div class="panel-card">
          <div class="panel-head">
            <div>
              <h2>Outputs</h2>
              <p class="muted">Jeder Output wird alle 30 Sekunden aktiv aus ioBroker zurückgelesen. Fehlende oder abweichende Werte werden automatisch erneut geschrieben.</p>
            </div>
            <button type="button" class="settings-form button-inline" onclick="openOutputDialog('add')">Hinzufuegen</button>
          </div>
          ${statusText(formError)}
          ${statusText(formMessage, 'success')}
          ${outputs.length ? renderOutputList(outputs) : '<div class="info-card"><p class="muted">Noch kein Output angelegt.</p></div>'}
        </div>

        ${renderOutputDialog({ internalValues, dialogError, dialogValues, dialogMode, editingOutputId })}
        ${renderDeleteDialog()}`;

  const script = `${valueCatalogScript()}

    const outputs = ${JSON.stringify(outputs.map(serializeOutputForClient))};
    const initialDialogMode = ${JSON.stringify(dialogMode)};
    const initialEditingOutputId = ${editingOutputId == null ? 'null' : Number(editingOutputId)};
    const initialDialogValues = ${JSON.stringify(dialogValues || {})};

    function openOutputDialog(mode, outputId) {
      var dialog = document.getElementById('outputDialog');
      if (!dialog) return;
      var form = document.getElementById('outputForm');
      var title = document.getElementById('outputDialogTitle');
      var output = outputs.find(function (item) { return item.id === outputId; }) || null;

      if (mode === 'edit' && output) {
        form.action = '/output/outputs/' + output.id;
        title.textContent = 'Output bearbeiten';
        setOutputFormValues(output);
      } else {
        form.action = '/output/outputs';
        title.textContent = 'Output hinzufuegen';
        setOutputFormValues({ sourceId: '', targetTopic: '' });
      }

      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function setOutputFormValues(values) {
      valueCatalogSync('outputSourceId', values.sourceId || '');
      document.getElementById('outputTargetTopic').value = values.targetTopic || '';
    }

    function closeOutputDialog() {
      var dialog = document.getElementById('outputDialog');
      if (dialog) dialog.close();
    }

    function openDeleteDialog(outputId, outputLabel) {
      var dialog = document.getElementById('deleteOutputDialog');
      if (!dialog) return;
      document.getElementById('deleteOutputName').textContent = outputLabel;
      document.getElementById('deleteOutputForm').action = '/output/outputs/' + outputId + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeDeleteDialog() {
      var dialog = document.getElementById('deleteOutputDialog');
      if (dialog) dialog.close();
    }

    async function refreshOutputValues() {
      try {
        var response = await fetch('/output/data', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        var data = await response.json();
        data.outputs.forEach(function (output) {
          var node = document.getElementById('output-value-' + output.id);
          if (node) node.textContent = output.currentDisplay == null ? '—' : output.currentDisplay;
          var badge = document.getElementById('output-verify-' + output.id);
          if (badge && output.verification) setVerificationBadge(badge, output.verification.state);
        });
      } catch (_) {
        // Anzeige bleibt auf dem letzten gueltigen Stand.
      }
    }

    function setVerificationBadge(node, state) {
      var labels = {
        confirmed: 'bestätigt', mismatch: 'abweichend', waiting: 'warte auf Bestätigung',
        disconnected: 'MQTT getrennt', 'no-value': 'kein Sollwert', unsupported: 'nicht verifizierbar'
      };
      node.textContent = labels[state] || 'warte auf Bestätigung';
      node.className = state === 'confirmed' ? 'cmd-confirm cmd-confirm--ok' : 'cmd-confirm cmd-confirm--bad';
    }

    // Auf-/Zu-Zustand der Kategorien merken: die Namen der offenen Kategorien in
    // localStorage ablegen; liegt nichts vor, bleibt alles zugeklappt.
    var OUTPUT_CATS_KEY = 'homeess.output.openCats';

    function saveOutputCatState() {
      try {
        var open = [];
        document.querySelectorAll('.output-cats .value-cat[data-output-cat]').forEach(function (cat) {
          if (cat.classList.contains('is-open')) open.push(cat.getAttribute('data-output-cat'));
        });
        localStorage.setItem(OUTPUT_CATS_KEY, JSON.stringify(open));
      } catch (_) {
        // localStorage nicht verfügbar – Zustand wird dann nicht gemerkt.
      }
    }

    function applyOutputCatState() {
      var open = [];
      try {
        open = JSON.parse(localStorage.getItem(OUTPUT_CATS_KEY) || '[]');
      } catch (_) {
        open = [];
      }
      if (!Array.isArray(open)) open = [];
      document.querySelectorAll('.output-cats .value-cat[data-output-cat]').forEach(function (cat) {
        var isOpen = open.indexOf(cat.getAttribute('data-output-cat')) !== -1;
        cat.classList.toggle('is-open', isOpen);
        var head = cat.querySelector('.value-cat-head');
        if (head) head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    function outputCatToggle(head) {
      var cat = head.parentNode;
      var open = cat.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      saveOutputCatState();
    }

    if (initialDialogMode === 'add') {
      openOutputDialog('add');
      setOutputFormValues(initialDialogValues);
    } else if (initialDialogMode === 'edit' && initialEditingOutputId != null) {
      openOutputDialog('edit', initialEditingOutputId);
      setOutputFormValues(initialDialogValues);
    }

    // MQTT-Events kommen in Bursts (viele Topics gleichzeitig). Ohne Bremse würde
    // jedes Event ein /output/data-Fetch auslösen und den Server fluten
    // (listInternalValues ist teuer). Daher pro Burst nur EIN Nachladen (coalesced).
    var refreshQueued = false;
    function queueOutputRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(function () { refreshQueued = false; refreshOutputValues(); }, 1000);
    }

    applyOutputCatState();
    refreshOutputValues();
    window.addEventListener('homeess:mqtt', queueOutputRefresh);
    setInterval(refreshOutputValues, 60000);`;

  return renderLayout({ title: 'Output', activePath: '/output', body, script });
}

function renderOutputList(outputs) {
  const byCat = new Map();
  for (const output of outputs) {
    const cat = output.category || 'Sonstiges';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(output);
  }
  const known = VALUE_CATEGORIES.filter((cat) => byCat.has(cat));
  const extra = [...byCat.keys()].filter((cat) => !VALUE_CATEGORIES.includes(cat)).sort((a, b) => a.localeCompare(b, 'de'));
  const order = [...known, ...extra];

  const categories = order
    .map((cat) => {
      const items = byCat
        .get(cat)
        .slice()
        .sort((a, b) => String(a.label || a.sourceId).localeCompare(String(b.label || b.sourceId), 'de'));
      // Standardmäßig zugeklappt; der Auf-/Zu-Zustand je Kategorie wird clientseitig
      // in localStorage gemerkt und beim Laden über applyOutputCatState() angewandt.
      return `            <div class="value-cat" data-output-cat="${escapeHtml(cat)}">
              <button type="button" class="value-cat-head" aria-expanded="false" onclick="outputCatToggle(this)">
                <span class="value-cat-caret" aria-hidden="true">▸</span>
                <span class="value-cat-name">${escapeHtml(cat)}</span>
                <span class="value-cat-count">${items.length}</span>
              </button>
              <div class="value-cat-body">
                <div class="output-list">
${items.map(renderOutputRow).join('\n')}
                </div>
              </div>
            </div>`;
    })
    .join('\n');

  return `<div class="output-cats">
${categories}
          </div>`;
}

function renderOutputRow(output) {
  const label = output.label || output.sourceId;
  const currentDisplay = output.currentDisplay == null ? '—' : output.currentDisplay;
  const verification = output.verification || { state: 'waiting' };
  const verificationLabels = {
    confirmed: 'bestätigt', mismatch: 'abweichend', waiting: 'warte auf Bestätigung',
    disconnected: 'MQTT getrennt', 'no-value': 'kein Sollwert', unsupported: 'nicht verifizierbar',
  };
  const verificationClass = verification.state === 'confirmed' ? 'cmd-confirm cmd-confirm--ok' : 'cmd-confirm cmd-confirm--bad';
  return `            <div class="output-row">
              <span class="output-row-label">${escapeHtml(label)}</span>
              <span class="output-row-topic muted">→ ${escapeHtml(output.targetTopic)}</span>
              <span class="output-row-value" id="output-value-${output.id}">${escapeHtml(currentDisplay)}</span>
              <span class="${verificationClass}" id="output-verify-${output.id}">${escapeHtml(verificationLabels[verification.state] || verificationLabels.waiting)}</span>
              <div class="output-row-actions">
                <button type="button" class="secondary-button" onclick="openOutputDialog('edit', ${output.id})">Bearbeiten</button>
                <button type="button" class="icon-button" aria-label="Output loeschen" title="Output loeschen" onclick="openDeleteDialog(${output.id}, ${toJsStringLiteral(label)})">🗑</button>
              </div>
            </div>`;
}

function renderOutputDialog({ internalValues, dialogError, dialogValues, dialogMode, editingOutputId }) {
  const values = dialogValues || { sourceId: '', targetTopic: '' };
  const action =
    dialogMode === 'edit' && editingOutputId != null
      ? `/output/outputs/${editingOutputId}`
      : '/output/outputs';

  return `        <dialog id="outputDialog" class="value-dialog">
          <form id="outputForm" action="${escapeHtml(action)}" method="POST" class="dialog-form">
            <div class="dialog-hero">
              <div>
                <h3 id="outputDialogTitle">Output hinzufuegen</h3>
                <p class="muted">Internen Wert auswaehlen und Ziel-Topic im ioBroker angeben.</p>
              </div>
            </div>
            ${statusText(dialogError)}
            <div class="dialog-grid">
              <label class="field-block" for="outputTargetTopic">
                <span>Ziel-Topic</span>
                <input type="text" id="outputTargetTopic" name="targetTopic" value="${escapeHtml(values.targetTopic)}" placeholder="z.B. 0_userdata.0.homeess.SoC" required>
                <small class="muted form-hint">Bestätigter State im ioBroker. Command-Topics sind nicht zulässig, weil sie keinen sicheren Istwert zurückmelden.</small>
              </label>
            </div>
            ${renderValueCatalog({ values: internalValues, inputId: 'outputSourceId', name: 'sourceId', selectedId: values.sourceId, label: 'Interner Wert' })}
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeOutputDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteDialog() {
  return `        <dialog id="deleteOutputDialog" class="value-dialog">
          <form id="deleteOutputForm" method="POST" class="dialog-form">
            <h3>Output loeschen</h3>
            <p class="muted">Soll der Output <strong id="deleteOutputName"></strong> wirklich geloescht werden?</p>
            <div class="button-row">
              <button type="submit">Ja, loeschen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function serializeOutputForClient(output) {
  return {
    id: output.id,
    sourceId: output.sourceId,
    targetTopic: output.targetTopic,
  };
}

function toJsStringLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

module.exports = renderOutput;
