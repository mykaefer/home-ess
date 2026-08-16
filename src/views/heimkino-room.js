'use strict';

// Eigenständige Seite eines Heimkino-Raums: die beiden Aktionsfolgen „An" und
// „Aus" in Liste und Design der Bedingungen. Jede Folge ist ein Verzeichnis,
// Schleifen sind darin beliebig tief verschachtelbare Container. Alle Aktionen
// lassen sich per Dragfläche frei verschieben – innerhalb einer Folge, in eine
// Schleife hinein und wieder heraus.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const values = require('../conditions/values');
const { MIN_CHECK_SECONDS, MAX_CHECK_SECONDS, MAX_REPEATS, MAX_PAUSE_SECONDS } = require('../heimkino/actions');

const PHASES = [
  { key: 'on', label: 'Aktionsfolge An', hint: 'Läuft, sobald der Kinomodus eingeschaltet wird.' },
  { key: 'off', label: 'Aktionsfolge Aus', hint: 'Läuft, sobald der Kinomodus ausgeschaltet wird.' },
];

function operatorOptions() {
  return '<option value="eq">ist gleich</option><option value="neq">ist ungleich</option><option value="gt">ist größer als</option><option value="gte">ist größer/gleich</option><option value="lt">ist kleiner als</option><option value="lte">ist kleiner/gleich</option><option value="contains">enthält</option><option value="truthy">ist wahr/ein</option><option value="falsy">ist falsch/aus</option>';
}

function operationOptions() {
  return '<option value="set">Wert direkt setzen</option><option value="add">Addieren (+)</option><option value="sub">Subtrahieren (−)</option><option value="mul">Multiplizieren (×)</option><option value="div">Dividieren (÷)</option><option value="mod">Rest der Division</option><option value="min">Kleineren Wert nehmen</option><option value="max">Größeren Wert nehmen</option>';
}

function actionButtons(action) {
  return `<span class="widget-actions">
                    <button type="button" class="widget-icon-btn" title="Aktion bearbeiten" onclick="event.stopPropagation(); openHeimkinoActionDialog('edit', ${action.id})">✎</button>
                    <button type="button" class="widget-icon-btn" title="Aktion entfernen" onclick="event.stopPropagation(); openHeimkinoActionDelete(${action.id})">🗑</button>
                  </span>`;
}

function actionRow(action) {
  return `                <div class="hk-node hk-action" data-action-id="${action.id}" data-node-type="${action.type}">
                  <span class="widget-drag hk-drag" title="Aktion verschieben" aria-hidden="true">⠿</span>
                  <span class="condition-kind hk-kind--${action.type}">${escapeHtml(action.typeLabel)}</span>
                  <span class="condition-item-description">${escapeHtml(action.description)}</span>
                  ${actionButtons(action)}
                </div>`;
}

function loopNode(action) {
  const children = (action.children || []).map(nodeHtml).join('\n');
  return `                <div class="hk-node hk-loop" data-action-id="${action.id}" data-node-type="loop" data-hk-key="loop-${action.id}">
                  <div class="ms-group-head hk-loop-head" role="button" tabindex="0" aria-expanded="false">
                    <span class="ms-caret" aria-hidden="true">▸</span>
                    <span class="widget-drag hk-drag" title="Schleife verschieben" aria-hidden="true">⠿</span>
                    <span class="condition-kind hk-kind--loop">Schleife</span>
                    <span class="ms-group-title hk-loop-title">${escapeHtml(action.description.replace(/^Schleife · /, ''))}</span>
                    <span class="ms-group-count">${(action.children || []).length}</span>
                    <div class="widget-group-actions">
                      <button type="button" class="widget-icon-btn" title="Aktion in die Schleife legen" onclick="event.stopPropagation(); openHeimkinoActionDialog('add', null, '${action.phase}', ${action.id})">+</button>
                      <button type="button" class="widget-icon-btn" title="Schleife bearbeiten" onclick="event.stopPropagation(); openHeimkinoActionDialog('edit', ${action.id})">✎</button>
                      <button type="button" class="widget-icon-btn" title="Schleife entfernen" onclick="event.stopPropagation(); openHeimkinoActionDelete(${action.id})">🗑</button>
                    </div>
                  </div>
                  <div class="ms-group-body hk-loop-body">
                    <div class="hk-zone hk-loop-zone" data-phase="${action.phase}" data-parent-id="${action.id}">
${children}
                    </div>
                  </div>
                </div>`;
}

function nodeHtml(action) {
  return action.type === 'loop' ? loopNode(action) : actionRow(action);
}

function countActions(list) {
  return (list || []).reduce((sum, action) => sum + 1 + countActions(action.children), 0);
}

function phaseSection(phase, list) {
  const nodes = (list || []).map(nodeHtml).join('\n');
  return `          <div class="ms-group hk-phase" data-hk-key="phase-${phase.key}">
            <div class="ms-group-head hk-phase-head" role="button" tabindex="0" aria-expanded="false">
              <span class="ms-caret" aria-hidden="true">▸</span>
              <span class="ms-group-title">${phase.label}</span>
              <span class="ms-group-count">${countActions(list)}</span>
              <span class="condition-runtime">${phase.hint}</span>
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Aktion hinzufügen" onclick="event.stopPropagation(); openHeimkinoActionDialog('add', null, '${phase.key}')">+</button>
              </div>
            </div>
            <div class="ms-group-body hk-phase-body">
              <div class="hk-zone hk-phase-zone" data-phase="${phase.key}" data-parent-id="">
${nodes}
              </div>
              <button type="button" class="condition-add-row" title="Aktion hinzufügen" aria-label="Aktion hinzufügen" onclick="openHeimkinoActionDialog('add', null, '${phase.key}')"><span aria-hidden="true">+</span></button>
            </div>
          </div>`;
}

function valueField(id, name, label, extraClass = '') {
  return `<label class="field-block condition-value-field${extraClass ? ` ${extraClass}` : ''}"><span id="${id}Label">${label}</span><span class="field-hint">Fester Wert oder Topic</span><input id="${id}" name="${name}" data-heimkino-value data-state-picker autocomplete="off" placeholder="Wert oder Topic"><span class="error-text condition-value-error" id="${id}Error" hidden>Wert muss bei mathematischen Operatoren numerisch sein</span></label>`;
}

function actionDialog(roomId) {
  return `<dialog id="heimkinoActionDialog" class="value-dialog condition-dialog"><form id="heimkinoActionForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="heimkinoActionTitle">Aktion hinzufügen</h3><p class="muted">Die Aktionen einer Folge laufen von oben nach unten. Schleifen wiederholen ihren Inhalt und können zusätzlich zyklisch prüfen, ob der gewünschte Zustand tatsächlich erreicht wurde.</p></div></div>
    <p id="heimkinoActionError" class="error-text" hidden></p>
    <input type="hidden" id="heimkinoActionPhase" name="phase" value="on">
    <input type="hidden" id="heimkinoActionParent" name="parentId" value="">
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Art</span><select id="heimkinoActionType" name="type" onchange="syncHeimkinoActionFields()"><option value="write">Wert zuweisen</option><option value="pause">Pause</option><option value="loop">Schleife</option></select></label>
      <div class="hk-field-write"><label class="field-block condition-topic-field"><span>Ziel-State</span><input id="heimkinoActionTopic" name="topic" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label></div>
      <label class="field-block hk-field-write"><span>Funktion</span><select id="heimkinoActionOperation" name="operation" onchange="syncHeimkinoActionFields()">${operationOptions()}</select></label>
      ${valueField('heimkinoActionValue', 'value', 'Zielwert', 'hk-field-write')}
      ${valueField('heimkinoActionValue2', 'value2', 'Zweiter Wert', 'hk-field-write-second')}
      <label class="field-block hk-field-write"><span>Runden auf Nachkommastellen</span><input id="heimkinoActionRound" name="round" type="number" min="0" max="${values.MAX_ROUND_DIGITS}" placeholder="ohne Rundung" data-no-state-picker></label>
      <label class="field-block hk-field-pause"><span>Pause in Sekunden</span><input id="heimkinoActionSeconds" name="seconds" type="number" min="0.1" max="${MAX_PAUSE_SECONDS}" step="0.1" value="2" data-no-state-picker></label>
      <label class="field-block hk-field-loop"><span>Durchläufe</span><input id="heimkinoActionRepeats" name="repeats" type="number" min="1" max="${MAX_REPEATS}" step="1" value="2" data-no-state-picker></label>
    </div></div>
    <div class="dialog-section hk-field-loop"><div class="dialog-section-head condition-dialog-head"><h4>Prüfung</h4><label class="remember-row condition-section-toggle"><input type="hidden" name="checkEnabled" value="0"><input id="heimkinoActionCheckEnabled" type="checkbox" name="checkEnabled" value="1" onchange="syncHeimkinoActionFields()"><span>Zyklisch prüfen</span></label></div>
      <p class="muted condition-section-hint">Die Bedingung wird im angegebenen Abstand immer wieder geprüft – gezählt ab der letzten Ausführung dieser Schleife bzw. ab dem Start von homeESS. Trifft sie nicht zu, wird ausschließlich diese Schleife erneut abgespult. Geprüft wird nur die Folge, die zum aktuellen Kinomodus des Raums gehört.</p>
      <div class="dialog-grid dialog-grid--two hk-field-check">
        <label class="field-block condition-topic-field"><span>Prüf-State</span><input id="heimkinoActionCheckTopic" name="checkTopic" data-state-picker autocomplete="off" placeholder="State auswählen…"></label>
        <label class="field-block"><span>Vergleich</span><select id="heimkinoActionCheckOperator" name="checkOperator" onchange="syncHeimkinoActionFields()">${operatorOptions()}</select></label>
        ${valueField('heimkinoActionCheckValue', 'checkValue', 'Vergleichswert', 'hk-field-check-value')}
        <label class="field-block"><span>Prüfabstand in Sekunden</span><input id="heimkinoActionCheckInterval" name="checkIntervalSeconds" type="number" min="${MIN_CHECK_SECONDS}" max="${MAX_CHECK_SECONDS}" step="1" value="120" data-no-state-picker></label>
      </div>
    </div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('heimkinoActionDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <dialog id="heimkinoActionDeleteDialog" class="value-dialog"><form id="heimkinoActionDeleteForm" method="POST" class="dialog-form">
    <h3>Aktion entfernen</h3>
    <p class="error-text">Die Aktion wird dauerhaft entfernt. Bei einer Schleife verschwindet auch ihr gesamter Inhalt.</p>
    <div class="button-row"><button class="button-danger" type="submit">Entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('heimkinoActionDeleteDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <input type="hidden" id="heimkinoRoomId" value="${roomId}">`;
}

function renderHeimkinoRoom({ room = null, tree = { on: [], off: [] }, actions = [], error = '', message = '', initialDialog = null } = {}) {
  const safeActions = JSON.stringify(actions).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');
  const toggleTarget = room && room.cinemaOn ? '0' : '1';
  const body = `        <div class="panel-head">
          <div>
            <h1>${escapeHtml(room ? room.name : 'Raum')}</h1>
            <p class="muted">Kinomodus-State: <code>${escapeHtml(room ? room.stateTopic : '')}</code>${room && room.remoteTopic ? ` · Sync-Topic: <code>${escapeHtml(room.remoteTopic)}</code>` : ''}</p>
          </div>
          <div class="dashboard-toolbar">
            <a class="secondary-button" href="/heimkino">Zurück zur Übersicht</a>
            <form action="/heimkino/rooms/${room ? room.id : 0}/state" method="POST" class="hk-inline-form">
              <input type="hidden" name="redirect" value="room">
              <input type="hidden" name="on" value="${toggleTarget}">
              <button type="submit" class="secondary-button">Kinomodus ${room && room.cinemaOn ? 'ausschalten' : 'einschalten'}</button>
            </form>
          </div>
        </div>
        ${statusText(error)}${statusText(message, 'success')}
        <p class="hk-state-line"><span class="condition-enabled ${room && room.cinemaOn ? 'is-enabled' : 'is-disabled'}">${room && room.cinemaOn ? 'Kinomodus an' : 'Kinomodus aus'}</span>${room && room.lastResult ? ` <span class="muted">${escapeHtml(room.lastResult)}</span>` : ''}${room && room.lastError ? ` <span class="error-text hk-inline-error">${escapeHtml(room.lastError)}</span>` : ''}</p>
        <div class="ms-groups hk-groups" id="heimkinoActions">
${PHASES.map((phase) => phaseSection(phase, tree[phase.key])).join('\n')}
        </div>
        ${actionDialog(room ? room.id : 0)}`;

  const script = `
    var heimkinoActions = ${safeActions};
    var heimkinoInitialDialog = ${safeInitial};
    var heimkinoRoomId = Number(document.getElementById('heimkinoRoomId').value);
    var HEIMKINO_OPEN_KEY = 'homeess.heimkino.expanded.v1';
    var heimkinoDragged = null, heimkinoDropRef = null, heimkinoDropZone = null, heimkinoLayoutSaving = false;
    function findHeimkinoAction(id) { return heimkinoActions.find(function (action) { return action.id === Number(id); }); }
    function heimkinoOpenMap() { try { return JSON.parse(localStorage.getItem(HEIMKINO_OPEN_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function heimkinoKey(node) { return heimkinoRoomId + ':' + node.dataset.hkKey; }
    function saveHeimkinoOpen() {
      var map = heimkinoOpenMap();
      document.querySelectorAll('[data-hk-key]').forEach(function (node) { map[heimkinoKey(node)] = node.classList.contains('is-open'); });
      try { localStorage.setItem(HEIMKINO_OPEN_KEY, JSON.stringify(map)); } catch (_) {}
    }
    // Die Folgen stehen beim ersten Besuch offen; Schleifen bleiben zugeklappt.
    function restoreHeimkinoOpen() {
      var map = heimkinoOpenMap();
      document.querySelectorAll('[data-hk-key]').forEach(function (node) {
        var stored = map[heimkinoKey(node)];
        var open = stored === undefined ? node.classList.contains('hk-phase') : stored === true;
        node.classList.toggle('is-open', open);
        var head = node.querySelector(':scope > .ms-group-head');
        if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    function toggleHeimkino(head) {
      var group = head.parentNode;
      var open = group.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      saveHeimkinoOpen();
    }
    function showNodes(selector, show) {
      document.querySelectorAll(selector).forEach(function (node) {
        node.hidden = !show;
        if (node.matches('input, select, textarea')) node.disabled = !show;
        node.querySelectorAll('input, select, textarea').forEach(function (field) { field.disabled = !show; });
      });
    }
    var HEIMKINO_TOPIC_RE = new RegExp(${JSON.stringify(values.TOPIC_PATTERN)}, 'i');
    var HEIMKINO_BOOLEAN_WORDS = ${JSON.stringify(values.TRUE_WORDS.concat(values.FALSE_WORDS))};
    var HEIMKINO_MATH_OPERATORS = ${JSON.stringify(values.MATH_OPERATORS)};
    function heimkinoValueOf(id) { var node = document.getElementById(id); return node ? node.value : ''; }
    function heimkinoIsTopic(raw) { return HEIMKINO_TOPIC_RE.test(String(raw == null ? '' : raw).trim()); }
    function heimkinoIsNumeric(raw) {
      var text = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!text) return false;
      if (HEIMKINO_BOOLEAN_WORDS.indexOf(text) !== -1) return true;
      return isFinite(Number(text.replace(',', '.')));
    }
    function heimkinoFieldVisible(node) { for (var cursor = node; cursor && cursor.nodeType === 1; cursor = cursor.parentNode) { if (cursor.hidden) return false; } return true; }
    // Ein fest eingetragener Wert muss numerisch sein, sobald damit gerechnet
    // oder mathematisch verglichen wird; Topic-Verweise prüft erst die Laufzeit.
    var HEIMKINO_VALUE_FIELDS = [
      ['heimkinoActionValue', function () { return heimkinoValueOf('heimkinoActionOperation') !== 'set' || String(heimkinoValueOf('heimkinoActionRound')).trim() !== ''; }],
      ['heimkinoActionValue2', function () { return true; }],
      ['heimkinoActionCheckValue', function () { return HEIMKINO_MATH_OPERATORS.indexOf(heimkinoValueOf('heimkinoActionCheckOperator')) !== -1; }]
    ];
    function syncHeimkinoValidity() {
      var form = document.getElementById('heimkinoActionForm');
      var valid = true;
      HEIMKINO_VALUE_FIELDS.forEach(function (entry) {
        var input = document.getElementById(entry[0]);
        if (!input) return;
        var raw = String(input.value || '').trim();
        var bad = raw !== '' && heimkinoFieldVisible(input) && entry[1]() && !heimkinoIsTopic(raw) && !heimkinoIsNumeric(raw);
        var hint = document.getElementById(entry[0] + 'Error');
        if (hint) hint.hidden = !bad;
        input.classList.toggle('is-invalid', bad);
        if (bad) valid = false;
      });
      form.querySelectorAll('button[type="submit"]').forEach(function (button) { button.disabled = !valid; });
    }
    function syncHeimkinoActionFields() {
      var type = heimkinoValueOf('heimkinoActionType');
      var checkEnabled = document.getElementById('heimkinoActionCheckEnabled').checked;
      showNodes('.hk-field-write', type === 'write');
      showNodes('.hk-field-write-second', type === 'write' && heimkinoValueOf('heimkinoActionOperation') !== 'set');
      showNodes('.hk-field-pause', type === 'pause');
      showNodes('.hk-field-loop', type === 'loop');
      showNodes('.hk-field-check', type === 'loop' && checkEnabled);
      showNodes('.hk-field-check-value', type === 'loop' && checkEnabled && ['truthy', 'falsy'].indexOf(heimkinoValueOf('heimkinoActionCheckOperator')) === -1);
      syncHeimkinoValidity();
    }
    function heimkinoSetValue(id, value, fallback) {
      var node = document.getElementById(id);
      if (node) node.value = value == null || value === '' ? (fallback == null ? '' : fallback) : value;
    }
    function openHeimkinoActionDialog(mode, actionId, phase, parentId) {
      var action = mode === 'edit' ? findHeimkinoAction(actionId) : null;
      var config = action ? (action.config || {}) : {};
      var check = config.check || {};
      var form = document.getElementById('heimkinoActionForm');
      form.action = action
        ? '/heimkino/raum/' + heimkinoRoomId + '/actions/' + action.id
        : '/heimkino/raum/' + heimkinoRoomId + '/actions';
      document.getElementById('heimkinoActionTitle').textContent = action ? 'Aktion bearbeiten' : 'Aktion hinzufügen';
      document.getElementById('heimkinoActionPhase').value = action ? action.phase : (phase || 'on');
      document.getElementById('heimkinoActionParent').value = action
        ? (action.parentId == null ? '' : String(action.parentId))
        : (parentId == null ? '' : String(parentId));
      var typeSelect = document.getElementById('heimkinoActionType');
      typeSelect.value = action ? action.type : 'write';
      // Die Art bleibt beim Bearbeiten fest: eine Schleife verlöre sonst ihren Inhalt.
      typeSelect.disabled = !!action;
      heimkinoSetValue('heimkinoActionTopic', config.topic);
      heimkinoSetValue('heimkinoActionOperation', config.operation, 'set');
      heimkinoSetValue('heimkinoActionValue', config.value);
      heimkinoSetValue('heimkinoActionValue2', config.value2);
      heimkinoSetValue('heimkinoActionRound', config.round == null ? '' : config.round);
      heimkinoSetValue('heimkinoActionSeconds', config.seconds, 2);
      heimkinoSetValue('heimkinoActionRepeats', config.repeats, 2);
      document.getElementById('heimkinoActionCheckEnabled').checked = config.checkEnabled === true;
      heimkinoSetValue('heimkinoActionCheckTopic', check.topic);
      heimkinoSetValue('heimkinoActionCheckOperator', check.operator, 'eq');
      heimkinoSetValue('heimkinoActionCheckValue', check.value);
      heimkinoSetValue('heimkinoActionCheckInterval', config.checkIntervalSeconds, 120);
      var error = document.getElementById('heimkinoActionError');
      error.textContent = ''; error.hidden = true;
      syncHeimkinoActionFields();
      document.getElementById('heimkinoActionDialog').showModal();
    }
    function openHeimkinoActionDelete(actionId) {
      document.getElementById('heimkinoActionDeleteForm').action = '/heimkino/raum/' + heimkinoRoomId + '/actions/' + actionId + '/delete';
      document.getElementById('heimkinoActionDeleteDialog').showModal();
    }
    // Die Art wird beim Bearbeiten gesperrt; für das Absenden muss sie kurz
    // wieder aktiv sein, sonst fehlte sie im Formular.
    document.getElementById('heimkinoActionForm').addEventListener('submit', function () {
      document.getElementById('heimkinoActionType').disabled = false;
    });
    function directChildren(zone) {
      return Array.prototype.filter.call(zone.children, function (node) { return node.classList.contains('hk-node'); });
    }
    function insertAtPointer(zone, dragged, y) {
      var rows = directChildren(zone).filter(function (row) { return row !== dragged; });
      for (var i = 0; i < rows.length; i++) {
        var box = rows[i].getBoundingClientRect();
        if (y < box.top + box.height / 2) return rows[i];
      }
      return null;
    }
    function clearHeimkinoDropIndicators() {
      document.querySelectorAll('.condition-drop-before, .condition-drop-after').forEach(function (node) { node.classList.remove('condition-drop-before', 'condition-drop-after'); });
      document.querySelectorAll('.condition-drag-over').forEach(function (node) { node.classList.remove('condition-drag-over'); });
    }
    function markHeimkinoDrop(zone, ref) {
      clearHeimkinoDropIndicators();
      zone.classList.add('condition-drag-over');
      if (ref) ref.classList.add('condition-drop-before');
      else {
        var rows = directChildren(zone).filter(function (row) { return row !== heimkinoDragged; });
        if (rows.length) rows[rows.length - 1].classList.add('condition-drop-after');
      }
    }
    // Eine Schleife darf nicht in sich selbst (oder eine ihrer eigenen
    // Schleifen) gezogen werden.
    function heimkinoCanDrop(zone) {
      if (!heimkinoDragged) return false;
      return !heimkinoDragged.contains(zone);
    }
    // Das Layout überträgt beide Folgen vollständig: Zielfolge, Schleifen-
    // Zugehörigkeit und Reihenfolge als eine Momentaufnahme.
    function heimkinoLayoutPayload() {
      var actions = [];
      document.querySelectorAll('.hk-zone').forEach(function (zone) {
        var parentId = zone.dataset.parentId ? Number(zone.dataset.parentId) : null;
        directChildren(zone).forEach(function (node, position) {
          actions.push({ id: Number(node.dataset.actionId), phase: zone.dataset.phase, parentId: parentId, position: position });
        });
      });
      return { actions: actions };
    }
    function persistHeimkinoLayout() {
      if (heimkinoLayoutSaving) return;
      heimkinoLayoutSaving = true;
      fetch('/heimkino/raum/' + heimkinoRoomId + '/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(heimkinoLayoutPayload())
      })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Layout konnte nicht gespeichert werden.'); }); })
        .then(function () { window.location.reload(); })
        .catch(function (error) { alert(error.message); window.location.reload(); });
    }
    function setupHeimkinoZone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!heimkinoCanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        heimkinoDropZone = zone;
        heimkinoDropRef = insertAtPointer(zone, heimkinoDragged, event.clientY);
        markHeimkinoDrop(zone, heimkinoDropRef);
      });
      zone.addEventListener('drop', function (event) {
        if (!heimkinoCanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        if (heimkinoDropRef) zone.insertBefore(heimkinoDragged, heimkinoDropRef);
        else zone.appendChild(heimkinoDragged);
      });
    }
    function setupHeimkinoNode(node) {
      var handle = node.querySelector('.hk-drag');
      if (handle) {
        handle.addEventListener('mousedown', function () { node.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup', function () { node.removeAttribute('draggable'); });
      }
      node.addEventListener('dragstart', function (event) {
        event.stopPropagation();
        heimkinoDragged = node; heimkinoDropZone = null; heimkinoDropRef = null;
        node.classList.add('group-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'heimkino:' + node.dataset.actionId);
      });
      node.addEventListener('dragend', function (event) {
        event.stopPropagation();
        node.removeAttribute('draggable');
        node.classList.remove('group-dragging');
        heimkinoDragged = null; heimkinoDropZone = null; heimkinoDropRef = null;
        clearHeimkinoDropIndicators();
        persistHeimkinoLayout();
      });
      if (!node.classList.contains('hk-loop')) return;
      var head = node.querySelector(':scope > .hk-loop-head');
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions, .hk-drag')) toggleHeimkino(head); });
      head.addEventListener('keydown', function (event) {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggleHeimkino(head); }
      });
      // Auf den Kopf einer zugeklappten Schleife gezogen: ans Ende ihres Inhalts.
      head.addEventListener('dragover', function (event) {
        var zone = node.querySelector(':scope > .hk-loop-body > .hk-zone');
        if (!heimkinoCanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        heimkinoDropZone = zone; heimkinoDropRef = null;
        clearHeimkinoDropIndicators();
        head.classList.add('condition-drag-over');
      });
      head.addEventListener('drop', function (event) {
        var zone = node.querySelector(':scope > .hk-loop-body > .hk-zone');
        if (!heimkinoCanDrop(zone)) return;
        event.preventDefault(); event.stopPropagation();
        zone.appendChild(heimkinoDragged);
        node.classList.add('is-open');
      });
    }
    document.querySelectorAll('.hk-phase-head').forEach(function (head) {
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions')) toggleHeimkino(head); });
      head.addEventListener('keydown', function (event) {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggleHeimkino(head); }
      });
    });
    document.querySelectorAll('.hk-zone').forEach(setupHeimkinoZone);
    document.querySelectorAll('.hk-node').forEach(setupHeimkinoNode);
    document.querySelectorAll('[data-heimkino-value]').forEach(function (input) {
      input.addEventListener('input', syncHeimkinoValidity);
      input.addEventListener('change', syncHeimkinoValidity);
    });
    document.getElementById('heimkinoActionRound').addEventListener('input', syncHeimkinoValidity);
    restoreHeimkinoOpen();
    window.addEventListener('pageshow', restoreHeimkinoOpen);
    syncHeimkinoActionFields();
    // Nach einer abgelehnten Eingabe öffnet der Dialog erneut mit den zuletzt
    // eingetragenen Werten.
    if (heimkinoInitialDialog) {
      var v = heimkinoInitialDialog.values || {};
      openHeimkinoActionDialog(heimkinoInitialDialog.mode === 'edit' ? 'edit' : 'add', heimkinoInitialDialog.actionId, v.phase, v.parentId);
      if (heimkinoInitialDialog.mode !== 'edit') heimkinoSetValue('heimkinoActionType', v.type, 'write');
      heimkinoSetValue('heimkinoActionTopic', v.topic);
      heimkinoSetValue('heimkinoActionOperation', v.operation, 'set');
      heimkinoSetValue('heimkinoActionValue', v.value);
      heimkinoSetValue('heimkinoActionValue2', v.value2);
      heimkinoSetValue('heimkinoActionRound', v.round);
      heimkinoSetValue('heimkinoActionSeconds', v.seconds, 2);
      heimkinoSetValue('heimkinoActionRepeats', v.repeats, 2);
      document.getElementById('heimkinoActionCheckEnabled').checked = ['1', 'true', 'on'].indexOf(String(Array.isArray(v.checkEnabled) ? v.checkEnabled[v.checkEnabled.length - 1] : v.checkEnabled)) !== -1;
      heimkinoSetValue('heimkinoActionCheckTopic', v.checkTopic);
      heimkinoSetValue('heimkinoActionCheckOperator', v.checkOperator, 'eq');
      heimkinoSetValue('heimkinoActionCheckValue', v.checkValue);
      heimkinoSetValue('heimkinoActionCheckInterval', v.checkIntervalSeconds, 120);
      syncHeimkinoActionFields();
      var err = document.getElementById('heimkinoActionError');
      err.textContent = heimkinoInitialDialog.error || '';
      err.hidden = !err.textContent;
    }
  `;
  return renderLayout({ title: `Heimkino – ${room ? room.name : ''}`, activePath: '/heimkino', body, script });
}

module.exports = renderHeimkinoRoom;
