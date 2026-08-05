'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

const KIND_LABELS = { trigger: 'Trigger', when: 'Wenn', then: 'Dann' };

// Trigger, Wenns und Danns haben keine wirksame Reihenfolge: alle Wenns werden
// gemeinsam geprüft, alle Danns gemeinsam ausgeführt. Die Zeilen sind deshalb
// bewusst nicht verschiebbar; verschiebbar sind nur Bedingungen und
// Verzeichnisse.
function itemRow(item, onlyItem) {
  return `                <div class="condition-item" data-item-id="${item.id}" data-item-kind="${item.kind}">
                  <span class="condition-kind condition-kind--${item.kind}">${KIND_LABELS[item.kind]}</span>
                  <span class="condition-item-description">${escapeHtml(item.description)}</span>
                  <span class="widget-actions">
                    <button type="button" class="widget-icon-btn" title="Element bearbeiten" onclick="openConditionItemDialog('edit', ${item.conditionId}, ${item.id})">✎</button>
                    <button type="button" class="widget-icon-btn" title="${onlyItem ? 'Mindestens ein Element erforderlich' : 'Element entfernen'}"${onlyItem ? ' disabled' : ''} onclick="openConditionItemDelete(${item.conditionId}, ${item.id})">🗑</button>
                  </span>
                </div>`;
}

function itemSection(condition, kind, items) {
  return `              <section class="condition-section condition-section--${kind}">
                <div class="condition-section-head"><span>${KIND_LABELS[kind]}</span><span class="condition-section-count">${items.length}</span></div>
                <div class="condition-item-zone">
${items.map((item) => itemRow(item, items.length === 1)).join('\n')}
                </div>
              </section>`;
}

function conditionStatus(condition) {
  if (condition.lastError) return `<span class="condition-runtime condition-runtime--error" title="${escapeHtml(condition.lastError)}">Fehler</span>`;
  if (!condition.lastTriggeredAt) return '<span class="condition-runtime">Noch nicht ausgelöst</span>';
  return `<span class="condition-runtime" title="${escapeHtml(condition.lastResult)}"><span data-condition-time="${condition.lastTriggeredAt}"></span> · ${escapeHtml(condition.lastResult)}</span>`;
}

function conditionGroup(condition) {
  return `          <div class="ms-group condition-group" data-condition-id="${condition.id}" data-condition-key="condition-${condition.id}">
            <div class="ms-group-head condition-head" role="button" tabindex="0" aria-expanded="false">
              <span class="ms-caret" aria-hidden="true">▸</span>
              <span class="widget-drag ms-group-drag condition-drag" title="Bedingung sortieren" aria-hidden="true">⠿</span>
              <span class="ms-group-title">${escapeHtml(condition.name)}</span>
              <span class="condition-enabled ${condition.enabled ? 'is-enabled' : 'is-disabled'}">${condition.enabled ? 'Aktiv' : 'Inaktiv'}</span>
              <span class="ms-group-count" title="Trigger / Wenn / Dann">${condition.triggers.length} / ${condition.whens.length} / ${condition.thens.length}</span>
              ${conditionStatus(condition)}
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Bedingung bearbeiten" onclick="event.stopPropagation(); openConditionEdit(${condition.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Bedingung entfernen" onclick="event.stopPropagation(); openConditionDelete(${condition.id})">🗑</button>
              </div>
            </div>
            <div class="ms-group-body condition-body">
${itemSection(condition, 'trigger', condition.triggers)}
${itemSection(condition, 'when', condition.whens)}
${itemSection(condition, 'then', condition.thens)}
              <button type="button" class="condition-add-row" title="Trigger, Wenn oder Dann hinzufügen" aria-label="Element hinzufügen" onclick="openConditionItemDialog('add', ${condition.id})"><span aria-hidden="true">+</span></button>
            </div>
          </div>`;
}

function conditionDropzone(conditions, folderId) {
  const rows = conditions.length ? `\n${conditions.map(conditionGroup).join('\n')}\n          ` : '';
  return `<div class="condition-dropzone" data-folder-id="${folderId == null ? '' : folderId}">${rows}</div>`;
}

function folderGroup(folder) {
  const children = folder.folders.map(folderGroup).join('\n');
  return `          <div class="ms-group condition-folder" data-folder-id="${folder.id}" data-parent-id="${folder.parentId == null ? '' : folder.parentId}" data-condition-key="folder-${folder.id}">
            <div class="ms-group-head condition-folder-head" role="button" tabindex="0" aria-expanded="false">
              <span class="ms-caret" aria-hidden="true">▸</span>
              <span class="widget-drag ms-group-drag condition-folder-drag" title="Verzeichnis verschieben" aria-hidden="true">⠿</span>
              <span class="ms-group-title">${escapeHtml(folder.name)}</span>
              <span class="ms-group-count">${folder.conditionCount}</span>
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Unterverzeichnis anlegen" onclick="event.stopPropagation(); openConditionFolderDialog('add', null, ${folder.id})">+📁</button>
                <button type="button" class="widget-icon-btn" title="Bedingung anlegen" onclick="event.stopPropagation(); openConditionCreate(${folder.id})">+B</button>
                <button type="button" class="widget-icon-btn" title="Verzeichnis bearbeiten" onclick="event.stopPropagation(); openConditionFolderDialog('edit', ${folder.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Verzeichnis entfernen" onclick="event.stopPropagation(); openConditionFolderDelete(${folder.id})">🗑</button>
              </div>
            </div>
            <div class="ms-group-body condition-folder-body">
              ${conditionDropzone(folder.conditions, folder.id)}
              <div class="ms-subgroups condition-folder-zone" data-parent-id="${folder.id}">${children}</div>
            </div>
          </div>`;
}

function folderOptions(folders) {
  const rows = ['<option value="">Ohne Verzeichnis</option>'];
  for (const folder of folders) rows.push(`<option value="${folder.id}">${escapeHtml(folder.path.join(' / '))}</option>`);
  return rows.join('');
}

function weekdayFields(prefix) {
  return `<div class="condition-weekdays" id="${prefix}Weekdays">
    ${[['1', 'Mo'], ['2', 'Di'], ['3', 'Mi'], ['4', 'Do'], ['5', 'Fr'], ['6', 'Sa'], ['0', 'So']].map(([value, label]) => `<label><input type="checkbox" name="${prefix}Weekdays" value="${value}" checked><span>${label}</span></label>`).join('')}
  </div>`;
}

function topicField(id, name, label, writable = false) {
  return `<label class="field-block condition-topic-field"><span>${label}</span><input id="${id}" name="${name}" data-state-picker${writable ? ' data-state-picker-writable' : ''} autocomplete="off" placeholder="State auswählen…"></label>`;
}

function createDialog(folders) {
  return `<dialog id="conditionCreateDialog" class="value-dialog condition-dialog"><form action="/conditions" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3>Bedingung hinzufügen</h3><p class="muted">Die Mindestausstattung aus Trigger, Wenn und Dann wird gemeinsam angelegt.</p></div></div>
    <p id="conditionCreateError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="conditionCreateName" name="name" required maxlength="120"></label>
      <label class="field-block"><span>Verzeichnis</span><select id="conditionCreateFolder" name="folderId">${folderOptions(folders)}</select></label>
      <label class="remember-row remember-row--boxed"><input id="conditionCreateEnabled" type="checkbox" name="enabled" value="1" checked><span>Bedingung aktiv</span></label>
    </div></div>
    <div class="dialog-section"><div class="dialog-section-head"><h4>Trigger</h4></div><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Art</span><select id="createTriggerType" name="triggerType" onchange="syncCreateTrigger()"><option value="time">Zeitliche Wiederholung</option><option value="change">Wertänderung</option><option value="event">Exaktes Ereignis</option></select></label>
      <label class="field-block create-trigger-time"><span>Zeitmodus</span><select id="createTriggerMode" name="triggerMode" onchange="syncCreateTrigger()"><option value="interval">Intervall</option><option value="schedule">Fester Wochenzeitpunkt</option></select></label>
      <label class="field-block create-trigger-interval"><span>Alle</span><span class="condition-inline-fields"><input id="createTriggerIntervalAmount" name="triggerIntervalAmount" type="number" min="1" max="10000" value="5"><select id="createTriggerIntervalUnit" name="triggerIntervalUnit"><option value="minutes">Minuten</option><option value="hours">Stunden</option><option value="days">Tage</option></select></span></label>
      <label class="field-block create-trigger-schedule"><span>Uhrzeit</span><input id="createTriggerTime" name="triggerTime" type="time" value="08:00"></label>
      <div class="field-block create-trigger-schedule"><span>Wochentage</span>${weekdayFields('trigger')}</div>
      <div class="create-trigger-topic">${topicField('createTriggerTopic', 'triggerTopic', 'Trigger-State')}</div>
      <label class="field-block create-trigger-event"><span>Exakter Ereigniswert</span><input id="createTriggerValue" name="triggerValue"></label>
    </div></div>
    <div class="dialog-section"><div class="dialog-section-head"><h4>Wenn</h4></div><div class="dialog-grid dialog-grid--two">
      <input type="hidden" name="whenType" value="state">${topicField('createWhenTopic', 'whenTopic', 'Prüf-State')}
      <label class="field-block"><span>Vergleich</span><select id="createWhenOperator" name="whenOperator" onchange="syncWhenValue('create')">${operatorOptions()}</select></label>
      <label class="field-block" id="createWhenValueField"><span>Vergleichswert</span><input id="createWhenValue" name="whenValue"></label>
    </div></div>
    <div class="dialog-section"><div class="dialog-section-head"><h4>Dann</h4></div><div class="dialog-grid dialog-grid--two">
      <input type="hidden" name="thenType" value="write">${topicField('createThenTopic', 'thenTopic', 'Ziel-State', true)}
      <label class="field-block"><span>Zielwert</span><input id="createThenValue" name="thenValue"></label>
    </div></div>
    <div class="button-row"><button type="submit">Bedingung anlegen</button><button type="button" class="secondary-button" onclick="document.getElementById('conditionCreateDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function operatorOptions() {
  return '<option value="eq">ist gleich</option><option value="neq">ist ungleich</option><option value="gt">ist größer als</option><option value="gte">ist größer/gleich</option><option value="lt">ist kleiner als</option><option value="lte">ist kleiner/gleich</option><option value="contains">enthält</option><option value="truthy">ist wahr/ein</option><option value="falsy">ist falsch/aus</option>';
}

function editDialog(folders) {
  return `<dialog id="conditionEditDialog" class="value-dialog"><form id="conditionEditForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3>Bedingung bearbeiten</h3><p class="muted">Name, Verzeichnis und Aktivzustand können jederzeit geändert werden.</p></div></div>
    <p id="conditionEditError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="conditionEditName" name="name" required maxlength="120"></label>
      <label class="field-block"><span>Verzeichnis</span><select id="conditionEditFolder" name="folderId">${folderOptions(folders)}</select></label>
      <label class="remember-row remember-row--boxed"><input id="conditionEditEnabled" type="checkbox" name="enabled" value="1"><span>Bedingung aktiv</span></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('conditionEditDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function folderDialog(folders) {
  return `<dialog id="conditionFolderDialog" class="value-dialog"><form id="conditionFolderForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="conditionFolderTitle">Verzeichnis hinzufügen</h3><p class="muted">Verzeichnisse ordnen die Bedingungen; auf die Auswertung haben sie keinen Einfluss.</p></div></div>
    <p id="conditionFolderError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="conditionFolderName" name="name" required maxlength="100"></label>
      <label class="field-block"><span>Übergeordnetes Verzeichnis</span><select id="conditionFolderParent" name="parentId">${folderOptions(folders)}</select></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('conditionFolderDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function itemDialog() {
  return `<dialog id="conditionItemDialog" class="value-dialog condition-dialog"><form id="conditionItemForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="conditionItemTitle">Element hinzufügen</h3><p class="muted">Trigger starten die Auswertung, alle Wenns werden gemeinsam geprüft, danach laufen alle Danns.</p></div></div>
    <p id="conditionItemError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Bereich</span><select id="conditionItemKind" name="kind" onchange="syncConditionItemFields()"><option value="trigger">Trigger</option><option value="when">Wenn</option><option value="then">Dann</option></select></label>
      <label class="field-block"><span>Art</span><select id="conditionItemType" name="type" onchange="syncConditionItemFields()"></select></label>
      <label class="field-block condition-item-time"><span>Zeitmodus</span><select id="conditionItemMode" name="mode" onchange="syncConditionItemFields()"><option value="interval">Intervall</option><option value="schedule">Fester Wochenzeitpunkt</option></select></label>
      <label class="field-block condition-item-interval"><span>Alle</span><span class="condition-inline-fields"><input id="conditionItemIntervalAmount" name="intervalAmount" type="number" min="1" max="10000" value="5"><select id="conditionItemIntervalUnit" name="intervalUnit"><option value="minutes">Minuten</option><option value="hours">Stunden</option><option value="days">Tage</option></select></span></label>
      <label class="field-block condition-item-schedule"><span>Uhrzeit</span><input id="conditionItemTime" name="time" type="time" value="08:00"></label>
      <div class="field-block condition-item-schedule"><span>Wochentage</span>${weekdayFields('conditionItem')}</div>
      <div class="condition-item-topic">${topicField('conditionItemTopic', 'topic', 'State')}</div>
      <label class="field-block condition-item-operator"><span>Vergleich</span><select id="conditionItemOperator" name="operator" onchange="syncConditionItemFields()">${operatorOptions()}</select></label>
      <label class="field-block condition-item-value"><span id="conditionItemValueLabel">Wert</span><input id="conditionItemValue" name="value"></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('conditionItemDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function deleteDialogs() {
  return `<dialog id="conditionDeleteDialog" class="value-dialog"><form id="conditionDeleteForm" method="POST" class="dialog-form"><h3>Bedingung entfernen</h3><p class="error-text">Die Bedingung und alle Trigger, Wenns und Danns werden dauerhaft gelöscht.</p><div class="button-row"><button class="button-danger" type="submit">Endgültig entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('conditionDeleteDialog').close()">Abbrechen</button></div></form></dialog>
  <dialog id="conditionItemDeleteDialog" class="value-dialog"><form id="conditionItemDeleteForm" method="POST" class="dialog-form"><h3>Element entfernen</h3><p class="error-text">Das Element wird dauerhaft aus der Bedingung entfernt.</p><div class="button-row"><button class="button-danger" type="submit">Entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('conditionItemDeleteDialog').close()">Abbrechen</button></div></form></dialog>
  <dialog id="conditionFolderDeleteDialog" class="value-dialog"><form id="conditionFolderDeleteForm" method="POST" class="dialog-form"><h3>Verzeichnis entfernen</h3><p class="error-text">Das Verzeichnis, alle Unterverzeichnisse und die darin enthaltenen Bedingungen werden dauerhaft gelöscht.</p><div class="button-row"><button class="button-danger" type="submit">Endgültig entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('conditionFolderDeleteDialog').close()">Abbrechen</button></div></form></dialog>`;
}

function renderConditions({ conditions = [], folders = [], tree = null, error = '', message = '', initialDialog = null } = {}) {
  const rootFolders = Array.isArray(tree && tree.folders) ? tree.folders : [];
  const rootConditions = Array.isArray(tree && tree.conditions) ? tree.conditions : conditions;
  const safeConditions = JSON.stringify(conditions).replace(/</g, '\\u003c');
  const safeFolders = JSON.stringify(folders).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');
  const body = `        <div class="panel-head"><div><h1>Bedingungen</h1></div><div class="dashboard-toolbar"><button type="button" class="secondary-button" onclick="openConditionFolderDialog('add')">Verzeichnis hinzufügen</button><button type="button" class="secondary-button" onclick="openConditionCreate()">Bedingung hinzufügen</button></div></div>
        ${statusText(error)}${statusText(message, 'success')}
        <div class="ms-groups conditions-groups" id="conditionsContainer">
          <div class="condition-folder-zone condition-root-folder-zone" data-parent-id="">
${rootFolders.map(folderGroup).join('\n')}
          </div>
          <div class="ms-group ms-group--ungrouped condition-root-group">
            <div class="ms-group-head ms-group-head--static"><span class="ms-group-title">Ohne Verzeichnis</span><span class="ms-group-count">${rootConditions.length}</span></div>
            <div class="ms-group-body">${conditionDropzone(rootConditions, null)}</div>
          </div>
        </div>
        ${conditions.length ? '' : '<p class="muted conditions-empty">Noch keine Bedingungen angelegt.</p>'}
        ${createDialog(folders)}${editDialog(folders)}${folderDialog(folders)}${itemDialog()}${deleteDialogs()}`;

  const script = `
    var conditionData = ${safeConditions};
    var conditionFolders = ${safeFolders};
    var conditionInitialDialog = ${safeInitial};
    var CONDITION_OPEN_KEY = 'homeess.conditions.expanded.v1';
    var draggedCondition = null, draggedConditionFolder = null, conditionLayoutSaving = false;
    var conditionDropzoneTarget = null, conditionDropRef = null, conditionFolderDropzone = null, conditionFolderDropRef = null;
    var conditionFolderDialogMode = 'add';
    function findCondition(id) { return conditionData.find(function (entry) { return entry.id === Number(id); }); }
    function findConditionFolder(id) { return conditionFolders.find(function (entry) { return entry.id === Number(id); }); }
    function allConditionItems(condition) { return condition ? condition.triggers.concat(condition.whens, condition.thens) : []; }
    function findConditionItem(conditionId, itemId) { return allConditionItems(findCondition(conditionId)).find(function (item) { return item.id === Number(itemId); }); }
    function conditionOpenMap() { try { return JSON.parse(localStorage.getItem(CONDITION_OPEN_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveConditionOpen() { var map = {}; document.querySelectorAll('[data-condition-key]').forEach(function (group) { map[group.dataset.conditionKey] = group.classList.contains('is-open'); }); try { localStorage.setItem(CONDITION_OPEN_KEY, JSON.stringify(map)); } catch (_) {} }
    function restoreConditionOpen() { var map = conditionOpenMap(); document.querySelectorAll('[data-condition-key]').forEach(function (group) { var open = map[group.dataset.conditionKey] === true; group.classList.toggle('is-open', open); var head = group.querySelector(':scope > .condition-head, :scope > .condition-folder-head'); if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false'); }); }
    function toggleCondition(head) { var group = head.parentNode; var open = group.classList.toggle('is-open'); head.setAttribute('aria-expanded', open ? 'true' : 'false'); saveConditionOpen(); }
    function showNodes(selector, show) { document.querySelectorAll(selector).forEach(function (node) { node.hidden = !show; }); }
    function syncWhenValue(prefix) { var op = document.getElementById(prefix + 'WhenOperator').value; document.getElementById(prefix + 'WhenValueField').hidden = op === 'truthy' || op === 'falsy'; }
    function syncCreateTrigger() { var type = document.getElementById('createTriggerType').value; var mode = document.getElementById('createTriggerMode').value; showNodes('.create-trigger-time', type === 'time'); showNodes('.create-trigger-interval', type === 'time' && mode === 'interval'); showNodes('.create-trigger-schedule', type === 'time' && mode === 'schedule'); showNodes('.create-trigger-topic', type === 'change' || type === 'event'); showNodes('.create-trigger-event', type === 'event'); }
    function conditionSelectHasValue(select, value) { if (!select) return false; for (var i = 0; i < select.options.length; i++) if (select.options[i].value === String(value)) return true; return false; }
    function openConditionCreate(folderId) { var select = document.getElementById('conditionCreateFolder'); select.value = folderId != null && conditionSelectHasValue(select, folderId) ? String(folderId) : ''; document.getElementById('conditionCreateDialog').showModal(); syncCreateTrigger(); syncWhenValue('create'); }
    function openConditionEdit(id) { var condition = findCondition(id); var form = document.getElementById('conditionEditForm'); form.action = '/conditions/' + id; document.getElementById('conditionEditName').value = condition.name; var folderSelect = document.getElementById('conditionEditFolder'); folderSelect.value = condition.folderId == null ? '' : String(condition.folderId); document.getElementById('conditionEditEnabled').checked = condition.enabled; document.getElementById('conditionEditDialog').showModal(); }
    function openConditionDelete(id) { document.getElementById('conditionDeleteForm').action = '/conditions/' + id + '/delete'; document.getElementById('conditionDeleteDialog').showModal(); }
    function openConditionItemDelete(conditionId, itemId) { document.getElementById('conditionItemDeleteForm').action = '/conditions/' + conditionId + '/items/' + itemId + '/delete'; document.getElementById('conditionItemDeleteDialog').showModal(); }
    function conditionFolderIsDescendant(candidateId, ancestorId) { var cursor = findConditionFolder(candidateId); var seen = {}; while (cursor && cursor.parentId != null && !seen[cursor.id]) { if (cursor.parentId === Number(ancestorId)) return true; seen[cursor.id] = true; cursor = findConditionFolder(cursor.parentId); } return false; }
    function prepareFolderParentOptions(folderId) { var select = document.getElementById('conditionFolderParent'); for (var i = 0; i < select.options.length; i++) { var id = Number(select.options[i].value); select.options[i].disabled = !!select.options[i].value && folderId != null && (id === Number(folderId) || conditionFolderIsDescendant(id, folderId)); } }
    function openConditionFolderDialog(mode, id, parentId) {
      var folder = findConditionFolder(id); conditionFolderDialogMode = mode; prepareFolderParentOptions(mode === 'edit' ? id : null);
      document.getElementById('conditionFolderForm').action = mode === 'edit' ? '/conditions/folder/' + id : '/conditions/folder';
      document.getElementById('conditionFolderTitle').textContent = mode === 'edit' ? 'Verzeichnis bearbeiten' : 'Verzeichnis hinzufügen';
      document.getElementById('conditionFolderName').value = folder ? folder.name : '';
      var parentSelect = document.getElementById('conditionFolderParent');
      parentSelect.value = folder ? (folder.parentId == null ? '' : String(folder.parentId)) : (parentId != null && conditionSelectHasValue(parentSelect, parentId) ? String(parentId) : '');
      document.getElementById('conditionFolderDialog').showModal();
    }
    function openConditionFolderDelete(id) { var folder = findConditionFolder(id); document.getElementById('conditionFolderDeleteForm').action = '/conditions/folder/' + id + '/delete'; document.querySelector('#conditionFolderDeleteDialog h3').textContent = folder ? '„' + folder.name + '“ entfernen' : 'Verzeichnis entfernen'; document.getElementById('conditionFolderDeleteDialog').showModal(); }
    function itemTypes(kind) { return kind === 'trigger' ? [['time','Zeitliche Wiederholung'],['change','Wertänderung'],['event','Exaktes Ereignis']] : kind === 'when' ? [['state','State vergleichen']] : [['write','State schreiben']]; }
    function fillItemTypes(kind, selected) { var select = document.getElementById('conditionItemType'); select.innerHTML = ''; itemTypes(kind).forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; select.appendChild(option); }); if (selected) select.value = selected; }
    function syncConditionItemFields() { var kind = document.getElementById('conditionItemKind').value; var type = document.getElementById('conditionItemType').value; var mode = document.getElementById('conditionItemMode').value; showNodes('.condition-item-time', kind === 'trigger' && type === 'time'); showNodes('.condition-item-interval', kind === 'trigger' && type === 'time' && mode === 'interval'); showNodes('.condition-item-schedule', kind === 'trigger' && type === 'time' && mode === 'schedule'); showNodes('.condition-item-topic', !(kind === 'trigger' && type === 'time')); showNodes('.condition-item-operator', kind === 'when'); var topic=document.getElementById('conditionItemTopic');if(kind==='then')topic.setAttribute('data-state-picker-writable','');else topic.removeAttribute('data-state-picker-writable'); var op = document.getElementById('conditionItemOperator').value; var needsValue = kind === 'then' || (kind === 'trigger' && type === 'event') || (kind === 'when' && op !== 'truthy' && op !== 'falsy'); showNodes('.condition-item-value', needsValue); document.getElementById('conditionItemValueLabel').textContent = kind === 'then' ? 'Zielwert' : kind === 'trigger' ? 'Exakter Ereigniswert' : 'Vergleichswert'; }
    function valueArray(values) { return Array.isArray(values) ? values.map(String) : values == null || values === '' ? [] : String(values).split(','); }
    function setWeekdayGroup(id, values) { var wanted=valueArray(values); document.querySelectorAll('#'+id+' input').forEach(function (input) { input.checked = wanted.includes(input.value); }); }
    function openConditionItemDialog(mode, conditionId, itemId) { var item = mode === 'edit' ? findConditionItem(conditionId, itemId) : null; var kind = item ? item.kind : 'trigger'; var kindSelect = document.getElementById('conditionItemKind'); kindSelect.value = kind; kindSelect.disabled = !!item; fillItemTypes(kind, item && item.type); document.getElementById('conditionItemTitle').textContent = item ? KIND_LABELS_JS[kind] + ' bearbeiten' : 'Element hinzufügen'; var form = document.getElementById('conditionItemForm'); form.action = item ? '/conditions/' + conditionId + '/items/' + itemId : '/conditions/' + conditionId + '/items'; var c = item ? item.config : {}; document.getElementById('conditionItemMode').value = c.mode || 'interval'; document.getElementById('conditionItemIntervalAmount').value = c.intervalAmount || 5; document.getElementById('conditionItemIntervalUnit').value = c.intervalUnit || 'minutes'; document.getElementById('conditionItemTime').value = c.time || '08:00'; setWeekdayGroup('conditionItemWeekdays',c.weekdays || [0,1,2,3,4,5,6]); document.getElementById('conditionItemTopic').value = c.topic || ''; document.getElementById('conditionItemOperator').value = c.operator || 'eq'; document.getElementById('conditionItemValue').value = c.value == null ? '' : c.value; syncConditionItemFields(); document.getElementById('conditionItemDialog').showModal(); }
    var KIND_LABELS_JS = { trigger: 'Trigger', when: 'Wenn', then: 'Dann' };
    document.getElementById('conditionItemKind').addEventListener('change', function () { fillItemTypes(this.value); syncConditionItemFields(); });
    document.getElementById('conditionItemForm').addEventListener('submit', function () { document.getElementById('conditionItemKind').disabled = false; });
    function directChildren(zone, selector) { return Array.prototype.filter.call(zone.children, function (node) { return node.matches(selector); }); }
    function insertAtPointer(zone, selector, dragged, y) { var rows = directChildren(zone, selector).filter(function (row) { return row !== dragged; }); for (var i = 0; i < rows.length; i++) { var box = rows[i].getBoundingClientRect(); if (y < box.top + box.height / 2) return rows[i]; } return null; }
    function clearConditionDropIndicators() {
      document.querySelectorAll('.condition-drop-before, .condition-drop-after').forEach(function (node) { node.classList.remove('condition-drop-before', 'condition-drop-after'); });
      document.querySelectorAll('.condition-drag-over').forEach(function (node) { node.classList.remove('condition-drag-over'); });
    }
    function markConditionDrop(zone, ref, selector) {
      clearConditionDropIndicators(); zone.classList.add('condition-drag-over');
      if (ref) ref.classList.add('condition-drop-before');
      else { var rows = directChildren(zone, selector).filter(function (row) { return row !== draggedCondition && row !== draggedConditionFolder; }); if (rows.length) rows[rows.length - 1].classList.add('condition-drop-after'); }
    }
    // Das Layout überträgt den gesamten Baum: Verzeichnisse mit ihrer Verschachtelung
    // und alle Bedingungen mit ihrem Zielverzeichnis.
    function conditionLayoutPayload() {
      var folders = [], conditions = [];
      document.querySelectorAll('.condition-folder-zone').forEach(function (zone) {
        var parentId = zone.dataset.parentId ? Number(zone.dataset.parentId) : null;
        directChildren(zone, '.condition-folder').forEach(function (folder, position) { folders.push({ id: Number(folder.dataset.folderId), parentId: parentId, position: position }); });
      });
      document.querySelectorAll('.condition-dropzone').forEach(function (zone) {
        var folderId = zone.dataset.folderId ? Number(zone.dataset.folderId) : null;
        directChildren(zone, '.condition-group').forEach(function (group, position) { conditions.push({ id: Number(group.dataset.conditionId), folderId: folderId, position: position }); });
      });
      return { folders: folders, conditions: conditions };
    }
    function persistConditionLayout() {
      if (conditionLayoutSaving) return; conditionLayoutSaving = true;
      fetch('/conditions/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(conditionLayoutPayload()) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Layout konnte nicht gespeichert werden.'); }); })
        .then(function () { window.location.reload(); })
        .catch(function (error) { alert(error.message); window.location.reload(); });
    }
    function setupConditionDropzone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedCondition) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        conditionDropzoneTarget = zone; conditionDropRef = insertAtPointer(zone, '.condition-group', draggedCondition, event.clientY); markConditionDrop(zone, conditionDropRef, '.condition-group');
      });
      zone.addEventListener('drop', function (event) {
        if (!draggedCondition) return; event.preventDefault(); event.stopPropagation();
        if (conditionDropRef) zone.insertBefore(draggedCondition, conditionDropRef); else zone.appendChild(draggedCondition);
      });
    }
    function setupConditionGroup(group) {
      var head = group.querySelector(':scope > .condition-head'); var handle = head.querySelector('.condition-drag');
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions,.condition-drag')) toggleCondition(head); });
      head.addEventListener('keydown', function (event) { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggleCondition(head); } });
      handle.addEventListener('mousedown', function () { group.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', function () { group.removeAttribute('draggable'); });
      group.addEventListener('dragstart', function (event) { event.stopPropagation(); draggedCondition = group; conditionDropzoneTarget = null; conditionDropRef = null; group.classList.add('group-dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'condition:' + group.dataset.conditionId); });
      group.addEventListener('dragend', function (event) { event.stopPropagation(); group.removeAttribute('draggable'); group.classList.remove('group-dragging'); draggedCondition = null; conditionDropzoneTarget = null; conditionDropRef = null; clearConditionDropIndicators(); persistConditionLayout(); });
    }
    function folderCanEnter(folder, zone) { var owner = zone.closest('.condition-folder'); return !owner || (owner !== folder && !folder.contains(owner)); }
    function setupConditionFolderZone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedConditionFolder || !folderCanEnter(draggedConditionFolder, zone)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        conditionFolderDropzone = zone; conditionFolderDropRef = insertAtPointer(zone, '.condition-folder', draggedConditionFolder, event.clientY); markConditionDrop(zone, conditionFolderDropRef, '.condition-folder');
      });
      zone.addEventListener('drop', function (event) {
        if (!draggedConditionFolder || !folderCanEnter(draggedConditionFolder, zone)) return; event.preventDefault(); event.stopPropagation();
        if (conditionFolderDropRef) zone.insertBefore(draggedConditionFolder, conditionFolderDropRef); else zone.appendChild(draggedConditionFolder);
      });
    }
    function setupConditionFolder(folder) {
      var head = folder.querySelector(':scope > .condition-folder-head'); var handle = head.querySelector('.condition-folder-drag');
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions, .condition-folder-drag')) toggleCondition(head); });
      head.addEventListener('keydown', function (event) { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggleCondition(head); } });
      head.addEventListener('dragover', function (event) {
        if (draggedCondition) { event.preventDefault(); event.stopPropagation(); conditionDropzoneTarget = folder.querySelector(':scope > .condition-folder-body > .condition-dropzone'); conditionDropRef = null; clearConditionDropIndicators(); head.classList.add('condition-drag-over'); return; }
        if (!draggedConditionFolder || draggedConditionFolder === folder || draggedConditionFolder.contains(folder)) return;
        event.preventDefault(); event.stopPropagation(); conditionFolderDropzone = folder.querySelector(':scope > .condition-folder-body > .condition-folder-zone'); conditionFolderDropRef = null; clearConditionDropIndicators(); head.classList.add('condition-drag-over');
      });
      head.addEventListener('drop', function (event) {
        if (draggedCondition && conditionDropzoneTarget) { event.preventDefault(); event.stopPropagation(); conditionDropzoneTarget.appendChild(draggedCondition); folder.classList.add('is-open'); return; }
        if (draggedConditionFolder && conditionFolderDropzone) { event.preventDefault(); event.stopPropagation(); conditionFolderDropzone.appendChild(draggedConditionFolder); folder.classList.add('is-open'); }
      });
      handle.addEventListener('mousedown', function () { folder.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', function () { folder.removeAttribute('draggable'); });
      folder.addEventListener('dragstart', function (event) { event.stopPropagation(); draggedConditionFolder = folder; conditionFolderDropzone = null; conditionFolderDropRef = null; folder.classList.add('group-dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'folder:' + folder.dataset.folderId); });
      folder.addEventListener('dragend', function (event) { event.stopPropagation(); folder.removeAttribute('draggable'); folder.classList.remove('group-dragging'); draggedConditionFolder = null; conditionFolderDropzone = null; conditionFolderDropRef = null; clearConditionDropIndicators(); saveConditionOpen(); persistConditionLayout(); });
    }
    document.querySelectorAll('.condition-dropzone').forEach(setupConditionDropzone);
    document.querySelectorAll('.condition-folder-zone').forEach(setupConditionFolderZone);
    document.querySelectorAll('.condition-group').forEach(setupConditionGroup);
    document.querySelectorAll('.condition-folder').forEach(setupConditionFolder);
    restoreConditionOpen(); window.addEventListener('pageshow',restoreConditionOpen); syncCreateTrigger(); syncWhenValue('create'); fillItemTypes('trigger'); syncConditionItemFields();
    document.querySelectorAll('[data-condition-time]').forEach(function (node) { var at=Number(node.dataset.conditionTime); if(at) node.textContent='Zuletzt '+new Date(at).toLocaleString(); });
    if (conditionInitialDialog) { var v=conditionInitialDialog.values||{}; if(conditionInitialDialog.kind==='condition-create'){openConditionCreate(v.folderId);document.getElementById('conditionCreateName').value=v.name||'';document.getElementById('conditionCreateEnabled').checked=String(v.enabled)==='1';document.getElementById('createTriggerType').value=v.triggerType||'time';document.getElementById('createTriggerMode').value=v.triggerMode||'interval';document.getElementById('createTriggerIntervalAmount').value=v.triggerIntervalAmount||5;document.getElementById('createTriggerIntervalUnit').value=v.triggerIntervalUnit||'minutes';document.getElementById('createTriggerTime').value=v.triggerTime||'08:00';setWeekdayGroup('triggerWeekdays',v.triggerWeekdays||[0,1,2,3,4,5,6]);document.getElementById('createTriggerTopic').value=v.triggerTopic||'';document.getElementById('createTriggerValue').value=v.triggerValue||'';document.getElementById('createWhenTopic').value=v.whenTopic||'';document.getElementById('createWhenOperator').value=v.whenOperator||'eq';document.getElementById('createWhenValue').value=v.whenValue||'';document.getElementById('createThenTopic').value=v.thenTopic||'';document.getElementById('createThenValue').value=v.thenValue||'';syncCreateTrigger();syncWhenValue('create');} else if(conditionInitialDialog.kind==='condition-edit'){openConditionEdit(conditionInitialDialog.conditionId);document.getElementById('conditionEditName').value=v.name||'';if(conditionSelectHasValue(document.getElementById('conditionEditFolder'),v.folderId==null?'':v.folderId))document.getElementById('conditionEditFolder').value=v.folderId==null?'':String(v.folderId);document.getElementById('conditionEditEnabled').checked=String(v.enabled)==='1';} else if(conditionInitialDialog.kind==='folder-add'||conditionInitialDialog.kind==='folder-edit'){openConditionFolderDialog(conditionInitialDialog.kind==='folder-edit'?'edit':'add',conditionInitialDialog.folderId);document.getElementById('conditionFolderName').value=v.name||'';if(conditionSelectHasValue(document.getElementById('conditionFolderParent'),v.parentId==null?'':v.parentId))document.getElementById('conditionFolderParent').value=v.parentId==null?'':String(v.parentId);} else {openConditionItemDialog(conditionInitialDialog.kind==='item-edit'?'edit':'add',conditionInitialDialog.conditionId,conditionInitialDialog.itemId);var kind=v.kind||document.getElementById('conditionItemKind').value;document.getElementById('conditionItemKind').value=kind;fillItemTypes(kind,v.type);document.getElementById('conditionItemMode').value=v.mode||'interval';document.getElementById('conditionItemIntervalAmount').value=v.intervalAmount||5;document.getElementById('conditionItemIntervalUnit').value=v.intervalUnit||'minutes';document.getElementById('conditionItemTime').value=v.time||'08:00';setWeekdayGroup('conditionItemWeekdays',v.weekdays||[0,1,2,3,4,5,6]);document.getElementById('conditionItemTopic').value=v.topic||'';document.getElementById('conditionItemValue').value=v.value||'';document.getElementById('conditionItemOperator').value=v.operator||'eq';syncConditionItemFields();} var errorId=conditionInitialDialog.kind==='condition-create'?'conditionCreateError':conditionInitialDialog.kind==='condition-edit'?'conditionEditError':conditionInitialDialog.kind==='folder-add'||conditionInitialDialog.kind==='folder-edit'?'conditionFolderError':'conditionItemError';var err=document.getElementById(errorId);if(err){err.textContent=conditionInitialDialog.error||'';err.hidden=!err.textContent;} }
  `;
  return renderLayout({ title: 'Bedingungen', activePath: '/conditions', body, script });
}

module.exports = renderConditions;
