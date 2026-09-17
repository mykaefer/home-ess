'use strict';

// Seite „Nachrichten": Übersicht und Pflege der Nachrichtenregeln.
//
// Die Seite ist server-gerendert wie alle übrigen Verwaltungsseiten und bindet
// sich über renderLayout() ein. Der State wird ausschließlich über den
// gemeinsamen State-Picker ausgewählt (kein freies Tippen einer State-Adresse);
// Trigger und Vergleichswert richten sich nach dem Werttyp des gewählten States.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { TRIGGER_TYPES, TRIGGER_LABELS, TRIGGER_NEEDS_VALUE, NUMERIC_TRIGGERS } = require('../notifications/triggers');
const { DEFAULT_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS } = require('../notifications/rules');
const { MAX_TITLE, MAX_BODY, MAX_EVENT_TYPE } = require('../notifications/service');

const SEVERITY_LABELS = { normal: 'Normal', critical: 'Kritisch' };

function severityBadge(severity) {
  const label = SEVERITY_LABELS[severity] || SEVERITY_LABELS.normal;
  const modifier = severity === 'critical' ? 'warn' : 'on';
  return `<span class="adapter-badge adapter-badge--${modifier}">${label}</span>`;
}

// Trigger-Beschriftung und Vergleichswert stehen in eigenen Elementen: der
// Übersetzungskatalog ersetzt nur vollständige Textknoten, ein „Ist gleich true"
// aus einem Stück bliebe in jeder Sprache deutsch.
function triggerText(rule) {
  const label = `<span>${TRIGGER_LABELS[rule.triggerType] || TRIGGER_LABELS.changed}</span>`;
  if (!TRIGGER_NEEDS_VALUE.has(rule.triggerType)) return label;
  return `${label} <span class="notification-state-id">${escapeHtml(rule.triggerValue)}</span>`;
}

// State-Spalte. Ein nicht mehr vorhandener State wird deutlich markiert: die
// Regel bleibt erhalten und reparierbar, löst aber nicht aus.
function stateCell(rule) {
  const address = `<span class="notification-state-id">${escapeHtml(rule.stateId)}</span>`;
  if (rule.stateMissing) {
    return `<span class="notification-state-invalid">${escapeHtml(rule.stateLabel)}</span>
                  ${address}
                  <span class="adapter-badge adapter-badge--warn">State nicht vorhanden</span>`;
  }
  return `<span>${escapeHtml(rule.stateLabel)}</span>
                  ${address}
                  <span class="muted" id="notification-value-${rule.id}">${escapeHtml(rule.stateDisplay)}</span>`;
}

function ruleRow(rule) {
  const toggleLabel = rule.enabled ? 'Deaktivieren' : 'Aktivieren';
  return `                <tr data-rule-id="${rule.id}">
                  <td>${escapeHtml(rule.name)}</td>
                  <td class="notification-state-cell">${stateCell(rule)}</td>
                  <td>${triggerText(rule)}</td>
                  <td class="notification-message-cell">
                    <span>${escapeHtml(rule.title)}</span>
                    <span class="muted">${escapeHtml(rule.body)}</span>
                    <span class="notification-state-id">${escapeHtml(rule.eventType)}</span>
                  </td>
                  <td>${severityBadge(rule.severity)}</td>
                  <td><span class="adapter-badge adapter-badge--${rule.enabled ? 'on' : 'off'}">${rule.enabled ? 'Aktiv' : 'Inaktiv'}</span></td>
                  <td><span class="muted" id="notification-last-${rule.id}"${rule.lastTriggeredAt ? ` data-notification-time="${rule.lastTriggeredAt}"` : ''}>${rule.lastTriggeredAt ? '' : 'Noch nicht ausgelöst'}</span></td>
                  <td class="notification-actions">
                    <button type="button" class="secondary-button" onclick="openNotificationDialog('edit', ${rule.id})">Bearbeiten</button>
                    <button type="button" class="secondary-button" onclick="testNotificationRule(${rule.id})">Testen</button>
                    <form method="POST" action="/notifications/rules/${rule.id}/toggle" class="notification-inline-form">
                      <input type="hidden" name="enabled" value="${rule.enabled ? '0' : '1'}">
                      <button type="submit" class="secondary-button">${toggleLabel}</button>
                    </form>
                    <button type="button" class="icon-button" aria-label="Nachricht löschen" title="Nachricht löschen" onclick="openNotificationDelete(${rule.id})">🗑</button>
                  </td>
                </tr>`;
}

function ruleTable(rules) {
  return `          <div class="notification-table-wrap">
            <table class="states-edit-table notification-table">
              <thead>
                <tr>
                  <th>Name</th><th>State</th><th>Trigger</th><th>Nachricht</th>
                  <th>Priorität</th><th>Aktiv</th><th>Letzter Trigger</th><th>Aktionen</th>
                </tr>
              </thead>
              <tbody>
${rules.map(ruleRow).join('\n')}
              </tbody>
            </table>
          </div>`;
}

function triggerOptions(selected) {
  return TRIGGER_TYPES
    .map((type) => `<option value="${type}"${type === selected ? ' selected' : ''}>${TRIGGER_LABELS[type]}</option>`)
    .join('\n                    ');
}

function ruleDialog({ values, dialogMode, editingRuleId }) {
  const current = values || {};
  const action = dialogMode === 'edit' && editingRuleId != null
    ? `/notifications/rules/${editingRuleId}`
    : '/notifications/rules';
  const enabled = current.enabled === undefined ? true : current.enabled;
  const cooldown = current.cooldownSeconds == null || current.cooldownSeconds === ''
    ? DEFAULT_COOLDOWN_SECONDS : current.cooldownSeconds;
  return `        <dialog id="notificationDialog" class="value-dialog">
          <form id="notificationForm" action="${escapeHtml(action)}" method="POST" class="dialog-form">
            <div class="dialog-hero">
              <div>
                <h3 id="notificationDialogTitle">Nachricht erstellen</h3>
                <p class="muted">Eine Nachricht wird gesendet, sobald der gewählte State die Bedingung erfüllt.</p>
              </div>
            </div>
            <div class="dialog-grid">
              <label class="field-block" for="notificationName">
                <span>Name</span>
                <input type="text" id="notificationName" name="name" value="${escapeHtml(current.name || '')}" required>
              </label>
              <label class="field-block" for="notificationStateId">
                <span>State</span>
                <input type="text" id="notificationStateId" name="stateId" value="${escapeHtml(current.stateId || '')}" data-state-picker readonly placeholder="State auswählen" required>
                <small class="muted form-hint" id="notificationStateInfo">Über die Auswahl neben dem Feld aus der State-Liste wählen.</small>
              </label>
            </div>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block" for="notificationTriggerType">
                <span>Trigger</span>
                <select id="notificationTriggerType" name="triggerType" onchange="notificationTriggerChanged()">
                    ${triggerOptions(current.triggerType || 'changed')}
                </select>
              </label>
              <label class="field-block" for="notificationTriggerValue" id="notificationTriggerValueField">
                <span>Vergleichswert</span>
                <input type="text" id="notificationTriggerValue" name="triggerValue" value="${escapeHtml(current.triggerValue || '')}">
                <select id="notificationTriggerValueBool" hidden aria-label="Vergleichswert">
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
                <small class="muted form-hint" id="notificationTriggerHint">Wert, auf den der State wechseln muss.</small>
              </label>
            </div>
            <div class="dialog-grid">
              <label class="field-block" for="notificationTitle">
                <span>Titel</span>
                <input type="text" id="notificationTitle" name="title" value="${escapeHtml(current.title || '')}" maxlength="${MAX_TITLE}" required>
              </label>
              <label class="field-block" for="notificationBody">
                <span>Nachricht</span>
                <textarea id="notificationBody" name="body" rows="3" maxlength="${MAX_BODY}" required>${escapeHtml(current.body || '')}</textarea>
              </label>
            </div>
            <div class="dialog-grid dialog-grid--three">
              <label class="field-block" for="notificationEventType">
                <span>Ereignistyp</span>
                <input type="text" id="notificationEventType" name="eventType" value="${escapeHtml(current.eventType || '')}" maxlength="${MAX_EVENT_TYPE}" pattern="[a-z0-9_-]+" placeholder="z. B. doorbell" required>
                <small class="muted form-hint">Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich.</small>
              </label>
              <label class="field-block" for="notificationSeverity">
                <span>Priorität</span>
                <select id="notificationSeverity" name="severity">
                  <option value="normal"${current.severity === 'critical' ? '' : ' selected'}>Normal</option>
                  <option value="critical"${current.severity === 'critical' ? ' selected' : ''}>Kritisch</option>
                </select>
              </label>
              <label class="field-block" for="notificationCooldown">
                <span>Cooldown in Sekunden</span>
                <input type="number" id="notificationCooldown" name="cooldownSeconds" min="0" max="${MAX_COOLDOWN_SECONDS}" step="1" value="${escapeHtml(cooldown)}">
                <small class="muted form-hint">0 bedeutet kein Cooldown.</small>
              </label>
            </div>
            <label class="field-block notification-check" for="notificationEnabled">
              <span>Aktiv</span>
              <input type="hidden" name="enabled" value="0">
              <input type="checkbox" id="notificationEnabled" name="enabled" value="1"${enabled ? ' checked' : ''}>
            </label>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeNotificationDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function deleteDialog() {
  return `        <dialog id="notificationDeleteDialog" class="value-dialog">
          <form id="notificationDeleteForm" method="POST" class="dialog-form">
            <h3>Nachricht löschen</h3>
            <p class="muted">Soll die Nachricht <strong id="notificationDeleteName"></strong> wirklich gelöscht werden?</p>
            <div class="button-row">
              <button type="submit">Ja, löschen</button>
              <button type="button" class="secondary-button" onclick="closeNotificationDelete()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function serialize(rule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    stateId: rule.stateId,
    stateLabel: rule.stateLabel,
    stateDisplay: rule.stateDisplay,
    stateValueType: rule.stateValueType,
    stateMissing: rule.stateMissing,
    triggerType: rule.triggerType,
    triggerValue: rule.triggerValue,
    title: rule.title,
    body: rule.body,
    eventType: rule.eventType,
    severity: rule.severity,
    cooldownSeconds: rule.cooldownSeconds,
  };
}

function renderNotifications({
  rules = [],
  relayState = 'disconnected',
  message = '',
  error = '',
  dialogMode = '',
  dialogValues = null,
  editingRuleId = null,
} = {}) {
  const relayHint = relayState === 'connected'
    ? '<span class="adapter-badge adapter-badge--on">Relay verbunden</span>'
    : '<span class="adapter-badge adapter-badge--off">Relay derzeit nicht verfügbar</span>';

  const body = `        <h1>Nachrichten</h1>

        <div class="panel-card">
          <div class="panel-head">
            <div>
              <h2>Nachrichtenregeln</h2>
              <p class="muted">Push-Benachrichtigungen an gekoppelte Geräte, ausgelöst von den States dieser Anlage.</p>
              ${relayHint}
            </div>
            <button type="button" class="settings-form button-inline" onclick="openNotificationDialog('add')">+ Nachricht erstellen</button>
          </div>
          ${statusText(error)}
          ${statusText(message, 'success')}
          <p class="error-text" id="notificationTestError" hidden></p>
          <p class="success-text" id="notificationTestMessage" hidden></p>
          ${rules.length ? ruleTable(rules) : '<div class="info-card"><p class="muted">Noch keine Nachricht angelegt.</p></div>'}
        </div>

${ruleDialog({ values: dialogValues, dialogMode, editingRuleId })}
${deleteDialog()}`;

  const script = `    var notificationRules = ${JSON.stringify(rules.map(serialize))};
    var notificationInitialMode = ${JSON.stringify(dialogMode)};
    var notificationInitialRuleId = ${editingRuleId == null ? 'null' : Number(editingRuleId)};
    var notificationInitialValues = ${JSON.stringify(dialogValues || {})};
    var notificationNumericTriggers = ${JSON.stringify([...NUMERIC_TRIGGERS])};
    var notificationValueTriggers = ${JSON.stringify([...TRIGGER_NEEDS_VALUE])};

    function notificationRuleById(id) {
      for (var i = 0; i < notificationRules.length; i++) {
        if (notificationRules[i].id === id) return notificationRules[i];
      }
      return null;
    }

    // Werttyp des zuletzt gewählten States ('boolean' | 'number' | 'string' oder
    // null, solange er noch keinen Wert geliefert hat).
    var notificationStateType = null;

    // Vergleichswert nur zeigen, wenn der Trigger ihn braucht, und den
    // Eingabetyp passend zum State darstellen: Zahlenfeld bei Grenzwerten,
    // true/false-Auswahl bei Schaltzuständen, sonst ein Textfeld.
    function notificationTriggerChanged() {
      var select = document.getElementById('notificationTriggerType');
      var field = document.getElementById('notificationTriggerValueField');
      var input = document.getElementById('notificationTriggerValue');
      var bool = document.getElementById('notificationTriggerValueBool');
      if (!select || !field || !input || !bool) return;
      var needsValue = notificationValueTriggers.indexOf(select.value) !== -1;
      field.hidden = !needsValue;
      if (!needsValue) input.value = '';
      var numeric = notificationNumericTriggers.indexOf(select.value) !== -1;
      input.setAttribute('type', numeric ? 'number' : 'text');
      if (numeric) input.setAttribute('step', 'any'); else input.removeAttribute('step');

      // Das Textfeld trägt immer den abgesendeten Namen; die Auswahl spiegelt
      // ihren Wert hinein. Ein ausgeblendetes Pflichtfeld würde das Absenden
      // blockieren, deshalb wandert die Pflichtangabe mit der Sichtbarkeit.
      var asBoolean = needsValue && !numeric && notificationStateType === 'boolean';
      if (asBoolean && input.value !== 'true' && input.value !== 'false') input.value = 'true';
      bool.hidden = !asBoolean;
      bool.value = input.value === 'false' ? 'false' : 'true';
      input.hidden = asBoolean;
      input.required = needsValue && !asBoolean;

      var hint = document.getElementById('notificationTriggerHint');
      if (hint) {
        hint.textContent = numeric
          ? 'Grenzwert als Zahl. Ausgelöst wird nur beim Überschreiten oder Unterschreiten.'
          : 'Wert, auf den der State wechseln muss.';
      }
    }

    // Trigger, die zum Werttyp des States nicht passen, werden gesperrt.
    function notificationApplyStateType(type) {
      notificationStateType = type || null;
      var select = document.getElementById('notificationTriggerType');
      if (!select) return;
      for (var i = 0; i < select.options.length; i++) {
        var option = select.options[i];
        var numericOnly = notificationNumericTriggers.indexOf(option.value) !== -1;
        option.disabled = numericOnly && !!type && type !== 'number';
      }
      if (select.selectedOptions[0] && select.selectedOptions[0].disabled) select.value = 'changed';
      notificationTriggerChanged();
    }

    // Bezeichnung, aktueller Wert und Werttyp des gewählten States kommen aus der
    // bestehenden State-Verwaltung; die Regel speichert nur die Adresse.
    function notificationLoadStateInfo() {
      var input = document.getElementById('notificationStateId');
      var info = document.getElementById('notificationStateInfo');
      if (!input || !input.value) { notificationApplyStateType(null); return; }
      fetch('/notifications/state-info?stateId=' + encodeURIComponent(input.value), { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (info) {
            info.textContent = data.found
              ? data.label + ' · ' + data.display
              : 'Dieser State ist nicht mehr vorhanden.';
          }
          notificationApplyStateType(data.found ? data.valueType : null);
        })
        .catch(function () { notificationApplyStateType(null); });
    }

    function notificationSetValues(values) {
      document.getElementById('notificationName').value = values.name || '';
      document.getElementById('notificationStateId').value = values.stateId || '';
      document.getElementById('notificationTriggerType').value = values.triggerType || 'changed';
      document.getElementById('notificationTriggerValue').value = values.triggerValue || '';
      document.getElementById('notificationTitle').value = values.title || '';
      document.getElementById('notificationBody').value = values.body || '';
      document.getElementById('notificationEventType').value = values.eventType || '';
      document.getElementById('notificationSeverity').value = values.severity === 'critical' ? 'critical' : 'normal';
      document.getElementById('notificationCooldown').value = values.cooldownSeconds == null ? ${DEFAULT_COOLDOWN_SECONDS} : values.cooldownSeconds;
      document.getElementById('notificationEnabled').checked = values.enabled === undefined ? true : !!values.enabled;
      notificationTriggerChanged();
      notificationLoadStateInfo();
    }

    function openNotificationDialog(mode, ruleId) {
      var dialog = document.getElementById('notificationDialog');
      if (!dialog) return;
      var form = document.getElementById('notificationForm');
      var title = document.getElementById('notificationDialogTitle');
      var rule = ruleId == null ? null : notificationRuleById(ruleId);
      if (mode === 'edit' && rule) {
        form.action = '/notifications/rules/' + rule.id;
        title.textContent = 'Nachricht bearbeiten';
        notificationSetValues(rule);
      } else {
        form.action = '/notifications/rules';
        title.textContent = 'Nachricht erstellen';
        notificationSetValues({ triggerType: 'changed', severity: 'normal', enabled: true });
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeNotificationDialog() {
      var dialog = document.getElementById('notificationDialog');
      if (dialog) dialog.close();
    }

    function openNotificationDelete(ruleId) {
      var rule = notificationRuleById(ruleId);
      var dialog = document.getElementById('notificationDeleteDialog');
      if (!dialog || !rule) return;
      document.getElementById('notificationDeleteName').textContent = rule.name;
      document.getElementById('notificationDeleteForm').action = '/notifications/rules/' + ruleId + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeNotificationDelete() {
      var dialog = document.getElementById('notificationDeleteDialog');
      if (dialog) dialog.close();
    }

    function notificationShowResult(text, isError) {
      var ok = document.getElementById('notificationTestMessage');
      var bad = document.getElementById('notificationTestError');
      if (!ok || !bad) return;
      ok.hidden = !!isError; bad.hidden = !isError;
      (isError ? bad : ok).textContent = text;
    }

    // Testversand: sendet die Nachricht sofort, ohne den State zu verändern und
    // ohne den letzten Trigger fortzuschreiben.
    function testNotificationRule(ruleId) {
      fetch('/notifications/rules/' + ruleId + '/test', {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-HomeESS-Request': '1' },
        credentials: 'same-origin'
      })
        .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
        .then(function (result) {
          notificationShowResult(result.data.message || result.data.error || '', !result.ok || !result.data.accepted);
        })
        .catch(function () { notificationShowResult('Relay derzeit nicht verfügbar.', true); });
    }

    function notificationRenderTimes() {
      var nodes = document.querySelectorAll('[data-notification-time]');
      for (var i = 0; i < nodes.length; i++) {
        var at = Number(nodes[i].getAttribute('data-notification-time'));
        nodes[i].textContent = at ? new Date(at).toLocaleString() : '';
      }
    }

    function refreshNotificationData() {
      fetch('/notifications/data', { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data) return;
          data.rules.forEach(function (rule) {
            var value = document.getElementById('notification-value-' + rule.id);
            if (value) value.textContent = rule.stateDisplay == null ? '—' : rule.stateDisplay;
            var last = document.getElementById('notification-last-' + rule.id);
            if (last && rule.lastTriggeredAt) last.setAttribute('data-notification-time', rule.lastTriggeredAt);
          });
          notificationRenderTimes();
        })
        .catch(function () { /* Anzeige bleibt auf dem letzten Stand. */ });
    }

    var notificationStateInput = document.getElementById('notificationStateId');
    if (notificationStateInput) notificationStateInput.addEventListener('change', notificationLoadStateInfo);
    var notificationBoolSelect = document.getElementById('notificationTriggerValueBool');
    if (notificationBoolSelect) {
      notificationBoolSelect.addEventListener('change', function () {
        document.getElementById('notificationTriggerValue').value = notificationBoolSelect.value;
      });
    }

    if (notificationInitialMode === 'add') {
      openNotificationDialog('add');
      notificationSetValues(notificationInitialValues);
    } else if (notificationInitialMode === 'edit' && notificationInitialRuleId != null) {
      openNotificationDialog('edit', notificationInitialRuleId);
      notificationSetValues(notificationInitialValues);
    }

    notificationRenderTimes();
    refreshNotificationData();
    setInterval(refreshNotificationData, 30000);`;

  return renderLayout({ title: 'Nachrichten', activePath: '/notifications', body, script });
}

module.exports = renderNotifications;
