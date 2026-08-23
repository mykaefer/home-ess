'use strict';

// Darstellung und Bedienung von Aktionsfolgen (automation/action-sequences.js).
// Liste und Design folgen den Bedingungen; jede Aktion trägt eine Dragfläche und
// lässt sich frei verschieben – innerhalb einer Folge, in eine Schleife hinein
// und wieder heraus.
//
// Der Baustein wird von mehreren Modulen verwendet (Heimkino, Heizung & Klima).
// Er unterscheidet sich je Modul nur in: CSS-Präfix, Namensraum der erzeugten
// JS-Funktionen, Basis-Pfad der Formulare und der Liste der Folgen.

const { escapeHtml } = require('./components');
const values = require('../conditions/values');
const { MIN_CHECK_SECONDS, MAX_CHECK_SECONDS, MAX_REPEATS, MAX_PAUSE_SECONDS } = require('../automation/action-sequences');

function operatorOptions() {
  return '<option value="eq">ist gleich</option><option value="neq">ist ungleich</option><option value="gt">ist größer als</option><option value="gte">ist größer/gleich</option><option value="lt">ist kleiner als</option><option value="lte">ist kleiner/gleich</option><option value="contains">enthält</option><option value="truthy">ist wahr/ein</option><option value="falsy">ist falsch/aus</option>';
}

function operationOptions() {
  return '<option value="set">Wert direkt setzen</option><option value="add">Addieren (+)</option><option value="sub">Subtrahieren (−)</option><option value="mul">Multiplizieren (×)</option><option value="div">Dividieren (÷)</option><option value="mod">Rest der Division</option><option value="min">Kleineren Wert nehmen</option><option value="max">Größeren Wert nehmen</option>';
}

function countActions(list) {
  return (list || []).reduce((sum, action) => sum + 1 + countActions(action.children), 0);
}

/**
 * @param {object} options
 * @param {string} options.prefix     CSS-Präfix, z. B. 'hk'
 * @param {string} options.ns         Namensraum der JS-Funktionen, z. B. 'Heimkino'
 * @param {string} options.varPrefix  Präfix der Variablen/Element-IDs, z. B. 'heimkino'
 * @param {string} options.storageKey localStorage-Schlüssel der offenen Gruppen
 * @param {string} options.basePath   Basis der Formularziele, z. B. '/heimkino/raum/3'
 * @param {number} options.ownerId    ID des Besitzers (Raum)
 * @param {Array}  options.phases     [{ key, label, hint }]
 * @param {object} options.tree       Aktionsbaum je Folge
 * @param {Array}  options.actions    flache Aktionsliste (für die Dialoge)
 * @param {object} [options.initialDialog] erneut zu öffnender Dialog nach einer Ablehnung
 * @param {boolean} [options.defaultOpen] Folgen beim ersten Besuch aufgeklappt
 * @returns {{ body: string, script: string }}
 */
function renderActionSequences({
  prefix, ns, varPrefix, storageKey, basePath, ownerId,
  phases = [], tree = {}, actions = [], initialDialog = null, defaultOpen = true,
}) {
  const p = prefix;
  const V = varPrefix;
  const N = ns;
  const U = ns.toUpperCase();

  const actionButtons = (action) => `<span class="widget-actions">
                    <button type="button" class="widget-icon-btn" title="Aktion bearbeiten" onclick="event.stopPropagation(); open${N}ActionDialog('edit', ${action.id})">✎</button>
                    <button type="button" class="widget-icon-btn" title="Aktion entfernen" onclick="event.stopPropagation(); open${N}ActionDelete(${action.id})">🗑</button>
                  </span>`;

  const actionRow = (action) => `                <div class="${p}-node ${p}-action" data-action-id="${action.id}" data-node-type="${action.type}">
                  <span class="widget-drag ${p}-drag" title="Aktion verschieben" aria-hidden="true">⠿</span>
                  <span class="condition-kind ${p}-kind--${action.type}">${escapeHtml(action.typeLabel)}</span>
                  <span class="condition-item-description">${escapeHtml(action.description)}</span>
                  ${actionButtons(action)}
                </div>`;

  const loopNode = (action) => {
    const children = (action.children || []).map(nodeHtml).join('\n');
    return `                <div class="${p}-node ${p}-loop" data-action-id="${action.id}" data-node-type="loop" data-${p}-key="loop-${action.id}">
                  <div class="ms-group-head ${p}-loop-head" role="button" tabindex="0" aria-expanded="false">
                    <span class="ms-caret" aria-hidden="true">▸</span>
                    <span class="widget-drag ${p}-drag" title="Schleife verschieben" aria-hidden="true">⠿</span>
                    <span class="condition-kind ${p}-kind--loop">Schleife</span>
                    <span class="ms-group-title ${p}-loop-title">${escapeHtml(action.description.replace(/^Schleife · /, ''))}</span>
                    <span class="ms-group-count">${(action.children || []).length}</span>
                    <div class="widget-group-actions">
                      <button type="button" class="widget-icon-btn" title="Aktion in die Schleife legen" onclick="event.stopPropagation(); open${N}ActionDialog('add', null, '${action.phase}', ${action.id})">+</button>
                      <button type="button" class="widget-icon-btn" title="Schleife bearbeiten" onclick="event.stopPropagation(); open${N}ActionDialog('edit', ${action.id})">✎</button>
                      <button type="button" class="widget-icon-btn" title="Schleife entfernen" onclick="event.stopPropagation(); open${N}ActionDelete(${action.id})">🗑</button>
                    </div>
                  </div>
                  <div class="ms-group-body ${p}-loop-body">
                    <div class="${p}-zone ${p}-loop-zone" data-phase="${action.phase}" data-parent-id="${action.id}">
${children}
                    </div>
                  </div>
                </div>`;
  };

  function nodeHtml(action) {
    return action.type === 'loop' ? loopNode(action) : actionRow(action);
  }

  const phaseSection = (phase) => {
    const list = tree[phase.key] || [];
    const nodes = list.map(nodeHtml).join('\n');
    return `          <div class="ms-group ${p}-phase" data-${p}-key="phase-${phase.key}">
            <div class="ms-group-head ${p}-phase-head" role="button" tabindex="0" aria-expanded="false">
              <span class="ms-caret" aria-hidden="true">▸</span>
              <span class="ms-group-title">${escapeHtml(phase.label)}</span>
              <span class="ms-group-count">${countActions(list)}</span>
              <span class="condition-runtime">${escapeHtml(phase.hint || '')}</span>
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Aktion hinzufügen" onclick="event.stopPropagation(); open${N}ActionDialog('add', null, '${phase.key}')">+</button>
              </div>
            </div>
            <div class="ms-group-body ${p}-phase-body">
              <div class="${p}-zone ${p}-phase-zone" data-phase="${phase.key}" data-parent-id="">
${nodes}
              </div>
              <button type="button" class="condition-add-row" title="Aktion hinzufügen" aria-label="Aktion hinzufügen" onclick="open${N}ActionDialog('add', null, '${phase.key}')"><span aria-hidden="true">+</span></button>
            </div>
          </div>`;
  };

  const valueField = (id, name, label, extraClass = '') =>
    `<label class="field-block condition-value-field${extraClass ? ` ${extraClass}` : ''}"><span id="${id}Label">${label}</span><span class="field-hint">Fester Wert oder Topic</span><input id="${id}" name="${name}" data-${V}-value data-state-picker autocomplete="off" placeholder="Wert oder Topic"><span class="error-text condition-value-error" id="${id}Error" hidden>Wert muss bei mathematischen Operatoren numerisch sein</span></label>`;

  const dialogs = `<dialog id="${V}ActionDialog" class="value-dialog condition-dialog"><form id="${V}ActionForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="${V}ActionTitle">Aktion hinzufügen</h3><p class="muted">Die Aktionen einer Folge laufen von oben nach unten. Schleifen wiederholen ihren Inhalt und können zusätzlich zyklisch prüfen, ob der gewünschte Zustand tatsächlich erreicht wurde.</p></div></div>
    <p id="${V}ActionError" class="error-text" hidden></p>
    <input type="hidden" id="${V}ActionPhase" name="phase" value="${phases.length ? phases[0].key : ''}">
    <input type="hidden" id="${V}ActionParent" name="parentId" value="">
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Art</span><select id="${V}ActionType" name="type" onchange="sync${N}ActionFields()"><option value="write">Wert zuweisen</option><option value="pause">Pause</option><option value="loop">Schleife</option></select></label>
      <div class="${p}-field-write"><label class="field-block condition-topic-field"><span>Ziel-State</span><input id="${V}ActionTopic" name="topic" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label></div>
      <label class="field-block ${p}-field-write"><span>Funktion</span><select id="${V}ActionOperation" name="operation" onchange="sync${N}ActionFields()">${operationOptions()}</select></label>
      ${valueField(`${V}ActionValue`, 'value', 'Zielwert', `${p}-field-write`)}
      ${valueField(`${V}ActionValue2`, 'value2', 'Zweiter Wert', `${p}-field-write-second`)}
      <label class="field-block ${p}-field-write"><span>Runden auf Nachkommastellen</span><input id="${V}ActionRound" name="round" type="number" min="0" max="${values.MAX_ROUND_DIGITS}" placeholder="ohne Rundung" data-no-state-picker></label>
      <label class="field-block ${p}-field-pause"><span>Pause in Sekunden</span><input id="${V}ActionSeconds" name="seconds" type="number" min="0.1" max="${MAX_PAUSE_SECONDS}" step="0.1" value="2" data-no-state-picker></label>
      <label class="field-block ${p}-field-loop"><span>Durchläufe</span><input id="${V}ActionRepeats" name="repeats" type="number" min="1" max="${MAX_REPEATS}" step="1" value="2" data-no-state-picker></label>
    </div></div>
    <div class="dialog-section ${p}-field-loop"><div class="dialog-section-head condition-dialog-head"><h4>Prüfung</h4><label class="remember-row condition-section-toggle"><input type="hidden" name="checkEnabled" value="0"><input id="${V}ActionCheckEnabled" type="checkbox" name="checkEnabled" value="1" onchange="sync${N}ActionFields()"><span>Zyklisch prüfen</span></label></div>
      <p class="muted condition-section-hint">Die Bedingung wird im angegebenen Abstand immer wieder geprüft – gezählt ab der letzten Ausführung dieser Schleife bzw. ab dem Start von homeESS. Trifft sie nicht zu, wird ausschließlich diese Schleife erneut abgespult. Geprüft wird nur die Folge, die zum aktuellen Zustand gehört.</p>
      <div class="dialog-grid dialog-grid--two ${p}-field-check">
        <label class="field-block condition-topic-field"><span>Prüf-State</span><input id="${V}ActionCheckTopic" name="checkTopic" data-state-picker autocomplete="off" placeholder="State auswählen…"></label>
        <label class="field-block"><span>Vergleich</span><select id="${V}ActionCheckOperator" name="checkOperator" onchange="sync${N}ActionFields()">${operatorOptions()}</select></label>
        ${valueField(`${V}ActionCheckValue`, 'checkValue', 'Vergleichswert', `${p}-field-check-value`)}
        <label class="field-block"><span>Prüfabstand in Sekunden</span><input id="${V}ActionCheckInterval" name="checkIntervalSeconds" type="number" min="${MIN_CHECK_SECONDS}" max="${MAX_CHECK_SECONDS}" step="1" value="120" data-no-state-picker></label>
      </div>
    </div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('${V}ActionDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <dialog id="${V}ActionDeleteDialog" class="value-dialog"><form id="${V}ActionDeleteForm" method="POST" class="dialog-form">
    <h3>Aktion entfernen</h3>
    <p class="error-text">Die Aktion wird dauerhaft entfernt. Bei einer Schleife verschwindet auch ihr gesamter Inhalt.</p>
    <div class="button-row"><button class="button-danger" type="submit">Entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('${V}ActionDeleteDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <input type="hidden" id="${V}OwnerId" value="${ownerId}">`;

  const body = `        <div class="ms-groups ${p}-groups" id="${V}Actions">
${phases.map(phaseSection).join('\n')}
        </div>
        ${dialogs}`;

  const safeActions = JSON.stringify(actions).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');

  const script = `
    var ${V}Actions = ${safeActions};
    var ${V}InitialDialog = ${safeInitial};
    var ${V}OwnerId = Number(document.getElementById('${V}OwnerId').value);
    var ${V}BasePath = ${JSON.stringify(basePath)};
    var ${U}_OPEN_KEY = ${JSON.stringify(storageKey)};
    var ${U}_DEFAULT_OPEN = ${defaultOpen ? 'true' : 'false'};
    var ${V}Dragged = null, ${V}DropRef = null, ${V}DropZone = null, ${V}LayoutSaving = false;
    function find${N}Action(id) { return ${V}Actions.find(function (action) { return action.id === Number(id); }); }
    function ${V}OpenMap() { try { return JSON.parse(localStorage.getItem(${U}_OPEN_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function ${V}Key(node) { return ${V}OwnerId + ':' + node.dataset.${V}Key; }
    function save${N}Open() {
      var map = ${V}OpenMap();
      document.querySelectorAll('[data-${p}-key]').forEach(function (node) { map[${V}Key(node)] = node.classList.contains('is-open'); });
      try { localStorage.setItem(${U}_OPEN_KEY, JSON.stringify(map)); } catch (_) {}
    }
    // Die Folgen stehen beim ersten Besuch offen (sofern gewünscht); Schleifen
    // bleiben zugeklappt.
    function restore${N}Open() {
      var map = ${V}OpenMap();
      document.querySelectorAll('[data-${p}-key]').forEach(function (node) {
        var stored = map[${V}Key(node)];
        var open = stored === undefined ? (${U}_DEFAULT_OPEN && node.classList.contains('${p}-phase')) : stored === true;
        node.classList.toggle('is-open', open);
        var head = node.querySelector(':scope > .ms-group-head');
        if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    function toggle${N}(head) {
      var group = head.parentNode;
      var open = group.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      save${N}Open();
    }
    function show${N}Nodes(selector, show) {
      document.querySelectorAll(selector).forEach(function (node) {
        node.hidden = !show;
        if (node.matches('input, select, textarea')) node.disabled = !show;
        node.querySelectorAll('input, select, textarea').forEach(function (field) { field.disabled = !show; });
      });
    }
    var ${U}_TOPIC_RE = new RegExp(${JSON.stringify(values.TOPIC_PATTERN)}, 'i');
    var ${U}_BOOLEAN_WORDS = ${JSON.stringify(values.TRUE_WORDS.concat(values.FALSE_WORDS))};
    var ${U}_MATH_OPERATORS = ${JSON.stringify(values.MATH_OPERATORS)};
    function ${V}ValueOf(id) { var node = document.getElementById(id); return node ? node.value : ''; }
    function ${V}IsTopic(raw) { return ${U}_TOPIC_RE.test(String(raw == null ? '' : raw).trim()); }
    function ${V}IsNumeric(raw) {
      var text = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!text) return false;
      if (${U}_BOOLEAN_WORDS.indexOf(text) !== -1) return true;
      return isFinite(Number(text.replace(',', '.')));
    }
    function ${V}FieldVisible(node) { for (var cursor = node; cursor && cursor.nodeType === 1; cursor = cursor.parentNode) { if (cursor.hidden) return false; } return true; }
    // Ein fest eingetragener Wert muss numerisch sein, sobald damit gerechnet
    // oder mathematisch verglichen wird; Topic-Verweise prüft erst die Laufzeit.
    var ${U}_VALUE_FIELDS = [
      ['${V}ActionValue', function () { return ${V}ValueOf('${V}ActionOperation') !== 'set' || String(${V}ValueOf('${V}ActionRound')).trim() !== ''; }],
      ['${V}ActionValue2', function () { return true; }],
      ['${V}ActionCheckValue', function () { return ${U}_MATH_OPERATORS.indexOf(${V}ValueOf('${V}ActionCheckOperator')) !== -1; }]
    ];
    function sync${N}Validity() {
      var form = document.getElementById('${V}ActionForm');
      var valid = true;
      ${U}_VALUE_FIELDS.forEach(function (entry) {
        var input = document.getElementById(entry[0]);
        if (!input) return;
        var raw = String(input.value || '').trim();
        var bad = raw !== '' && ${V}FieldVisible(input) && entry[1]() && !${V}IsTopic(raw) && !${V}IsNumeric(raw);
        var hint = document.getElementById(entry[0] + 'Error');
        if (hint) hint.hidden = !bad;
        input.classList.toggle('is-invalid', bad);
        if (bad) valid = false;
      });
      form.querySelectorAll('button[type="submit"]').forEach(function (button) { button.disabled = !valid; });
    }
    function sync${N}ActionFields() {
      var type = ${V}ValueOf('${V}ActionType');
      var checkEnabled = document.getElementById('${V}ActionCheckEnabled').checked;
      show${N}Nodes('.${p}-field-write', type === 'write');
      show${N}Nodes('.${p}-field-write-second', type === 'write' && ${V}ValueOf('${V}ActionOperation') !== 'set');
      show${N}Nodes('.${p}-field-pause', type === 'pause');
      show${N}Nodes('.${p}-field-loop', type === 'loop');
      show${N}Nodes('.${p}-field-check', type === 'loop' && checkEnabled);
      show${N}Nodes('.${p}-field-check-value', type === 'loop' && checkEnabled && ['truthy', 'falsy'].indexOf(${V}ValueOf('${V}ActionCheckOperator')) === -1);
      sync${N}Validity();
    }
    function ${V}SetValue(id, value, fallback) {
      var node = document.getElementById(id);
      if (node) node.value = value == null || value === '' ? (fallback == null ? '' : fallback) : value;
    }
    function open${N}ActionDialog(mode, actionId, phase, parentId) {
      var action = mode === 'edit' ? find${N}Action(actionId) : null;
      var config = action ? (action.config || {}) : {};
      var check = config.check || {};
      var form = document.getElementById('${V}ActionForm');
      form.action = action ? ${V}BasePath + '/actions/' + action.id : ${V}BasePath + '/actions';
      document.getElementById('${V}ActionTitle').textContent = action ? 'Aktion bearbeiten' : 'Aktion hinzufügen';
      document.getElementById('${V}ActionPhase').value = action ? action.phase : (phase || ${JSON.stringify(phases.length ? phases[0].key : '')});
      document.getElementById('${V}ActionParent').value = action
        ? (action.parentId == null ? '' : String(action.parentId))
        : (parentId == null ? '' : String(parentId));
      var typeSelect = document.getElementById('${V}ActionType');
      typeSelect.value = action ? action.type : 'write';
      // Die Art bleibt beim Bearbeiten fest: eine Schleife verlöre sonst ihren Inhalt.
      typeSelect.disabled = !!action;
      ${V}SetValue('${V}ActionTopic', config.topic);
      ${V}SetValue('${V}ActionOperation', config.operation, 'set');
      ${V}SetValue('${V}ActionValue', config.value);
      ${V}SetValue('${V}ActionValue2', config.value2);
      ${V}SetValue('${V}ActionRound', config.round == null ? '' : config.round);
      ${V}SetValue('${V}ActionSeconds', config.seconds, 2);
      ${V}SetValue('${V}ActionRepeats', config.repeats, 2);
      document.getElementById('${V}ActionCheckEnabled').checked = config.checkEnabled === true;
      ${V}SetValue('${V}ActionCheckTopic', check.topic);
      ${V}SetValue('${V}ActionCheckOperator', check.operator, 'eq');
      ${V}SetValue('${V}ActionCheckValue', check.value);
      ${V}SetValue('${V}ActionCheckInterval', config.checkIntervalSeconds, 120);
      var error = document.getElementById('${V}ActionError');
      error.textContent = ''; error.hidden = true;
      sync${N}ActionFields();
      document.getElementById('${V}ActionDialog').showModal();
    }
    function open${N}ActionDelete(actionId) {
      document.getElementById('${V}ActionDeleteForm').action = ${V}BasePath + '/actions/' + actionId + '/delete';
      document.getElementById('${V}ActionDeleteDialog').showModal();
    }
    // Die Art wird beim Bearbeiten gesperrt; für das Absenden muss sie kurz
    // wieder aktiv sein, sonst fehlte sie im Formular.
    document.getElementById('${V}ActionForm').addEventListener('submit', function () {
      document.getElementById('${V}ActionType').disabled = false;
    });
    function ${V}DirectChildren(zone) {
      return Array.prototype.filter.call(zone.children, function (node) { return node.classList.contains('${p}-node'); });
    }
    function ${V}InsertAtPointer(zone, dragged, y) {
      var rows = ${V}DirectChildren(zone).filter(function (row) { return row !== dragged; });
      for (var i = 0; i < rows.length; i++) {
        var box = rows[i].getBoundingClientRect();
        if (y < box.top + box.height / 2) return rows[i];
      }
      return null;
    }
    function clear${N}DropIndicators() {
      document.querySelectorAll('.condition-drop-before, .condition-drop-after').forEach(function (node) { node.classList.remove('condition-drop-before', 'condition-drop-after'); });
      document.querySelectorAll('.condition-drag-over').forEach(function (node) { node.classList.remove('condition-drag-over'); });
    }
    function mark${N}Drop(zone, ref) {
      clear${N}DropIndicators();
      zone.classList.add('condition-drag-over');
      if (ref) ref.classList.add('condition-drop-before');
      else {
        var rows = ${V}DirectChildren(zone).filter(function (row) { return row !== ${V}Dragged; });
        if (rows.length) rows[rows.length - 1].classList.add('condition-drop-after');
      }
    }
    // Eine Schleife darf nicht in sich selbst (oder eine ihrer eigenen
    // Schleifen) gezogen werden.
    function ${V}CanDrop(zone) {
      if (!${V}Dragged) return false;
      return !${V}Dragged.contains(zone);
    }
    // Das Layout überträgt alle Folgen vollständig: Zielfolge, Schleifen-
    // Zugehörigkeit und Reihenfolge als eine Momentaufnahme.
    function ${V}LayoutPayload() {
      var actions = [];
      document.querySelectorAll('.${p}-zone').forEach(function (zone) {
        var parentId = zone.dataset.parentId ? Number(zone.dataset.parentId) : null;
        ${V}DirectChildren(zone).forEach(function (node, position) {
          actions.push({ id: Number(node.dataset.actionId), phase: zone.dataset.phase, parentId: parentId, position: position });
        });
      });
      return { actions: actions };
    }
    function persist${N}Layout() {
      if (${V}LayoutSaving) return;
      ${V}LayoutSaving = true;
      fetch(${V}BasePath + '/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(${V}LayoutPayload())
      })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Layout konnte nicht gespeichert werden.'); }); })
        .then(function () { window.location.reload(); })
        .catch(function (error) { alert(error.message); window.location.reload(); });
    }
    function setup${N}Zone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!${V}CanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        ${V}DropZone = zone;
        ${V}DropRef = ${V}InsertAtPointer(zone, ${V}Dragged, event.clientY);
        mark${N}Drop(zone, ${V}DropRef);
      });
      zone.addEventListener('drop', function (event) {
        if (!${V}CanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        if (${V}DropRef) zone.insertBefore(${V}Dragged, ${V}DropRef);
        else zone.appendChild(${V}Dragged);
      });
    }
    function setup${N}Node(node) {
      var handle = node.querySelector('.${p}-drag');
      if (handle) {
        handle.addEventListener('mousedown', function () { node.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup', function () { node.removeAttribute('draggable'); });
      }
      node.addEventListener('dragstart', function (event) {
        event.stopPropagation();
        ${V}Dragged = node; ${V}DropZone = null; ${V}DropRef = null;
        node.classList.add('group-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', '${V}:' + node.dataset.actionId);
      });
      node.addEventListener('dragend', function (event) {
        event.stopPropagation();
        node.removeAttribute('draggable');
        node.classList.remove('group-dragging');
        ${V}Dragged = null; ${V}DropZone = null; ${V}DropRef = null;
        clear${N}DropIndicators();
        persist${N}Layout();
      });
      if (!node.classList.contains('${p}-loop')) return;
      var head = node.querySelector(':scope > .${p}-loop-head');
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions, .${p}-drag')) toggle${N}(head); });
      head.addEventListener('keydown', function (event) {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggle${N}(head); }
      });
      // Auf den Kopf einer zugeklappten Schleife gezogen: ans Ende ihres Inhalts.
      head.addEventListener('dragover', function (event) {
        var zone = node.querySelector(':scope > .${p}-loop-body > .${p}-zone');
        if (!${V}CanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        ${V}DropZone = zone; ${V}DropRef = null;
        clear${N}DropIndicators();
        head.classList.add('condition-drag-over');
      });
      head.addEventListener('drop', function (event) {
        var zone = node.querySelector(':scope > .${p}-loop-body > .${p}-zone');
        if (!${V}CanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        zone.appendChild(${V}Dragged);
        node.classList.add('is-open');
      });
    }
    document.querySelectorAll('.${p}-phase-head').forEach(function (head) {
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions')) toggle${N}(head); });
      head.addEventListener('keydown', function (event) {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggle${N}(head); }
      });
    });
    document.querySelectorAll('.${p}-zone').forEach(setup${N}Zone);
    document.querySelectorAll('.${p}-node').forEach(setup${N}Node);
    document.querySelectorAll('[data-${V}-value]').forEach(function (input) {
      input.addEventListener('input', sync${N}Validity);
      input.addEventListener('change', sync${N}Validity);
    });
    document.getElementById('${V}ActionRound').addEventListener('input', sync${N}Validity);
    restore${N}Open();
    window.addEventListener('pageshow', restore${N}Open);
    sync${N}ActionFields();
    // Nach einer abgelehnten Eingabe öffnet der Dialog erneut mit den zuletzt
    // eingetragenen Werten.
    if (${V}InitialDialog) {
      var v = ${V}InitialDialog.values || {};
      open${N}ActionDialog(${V}InitialDialog.mode === 'edit' ? 'edit' : 'add', ${V}InitialDialog.actionId, v.phase, v.parentId);
      if (${V}InitialDialog.mode !== 'edit') ${V}SetValue('${V}ActionType', v.type, 'write');
      ${V}SetValue('${V}ActionTopic', v.topic);
      ${V}SetValue('${V}ActionOperation', v.operation, 'set');
      ${V}SetValue('${V}ActionValue', v.value);
      ${V}SetValue('${V}ActionValue2', v.value2);
      ${V}SetValue('${V}ActionRound', v.round);
      ${V}SetValue('${V}ActionSeconds', v.seconds, 2);
      ${V}SetValue('${V}ActionRepeats', v.repeats, 2);
      document.getElementById('${V}ActionCheckEnabled').checked = ['1', 'true', 'on'].indexOf(String(Array.isArray(v.checkEnabled) ? v.checkEnabled[v.checkEnabled.length - 1] : v.checkEnabled)) !== -1;
      ${V}SetValue('${V}ActionCheckTopic', v.checkTopic);
      ${V}SetValue('${V}ActionCheckOperator', v.checkOperator, 'eq');
      ${V}SetValue('${V}ActionCheckValue', v.checkValue);
      ${V}SetValue('${V}ActionCheckInterval', v.checkIntervalSeconds, 120);
      sync${N}ActionFields();
      var err = document.getElementById('${V}ActionError');
      err.textContent = ${V}InitialDialog.error || '';
      err.hidden = !err.textContent;
    }
  `;

  return { body, script };
}

module.exports = { renderActionSequences, countActions };
