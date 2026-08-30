'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const values = require('../conditions/values');
const {
  MAX_PAUSE_SECONDS, MAX_REPEATS, MIN_CHECK_SECONDS, MAX_CHECK_SECONDS,
} = require('../conditions/repository');

const KIND_LABELS = { trigger: 'Trigger', when: 'Wenn', then: 'Dann', else: 'Sonst' };
const NUMERIC_HINT = 'Wert muss bei mathematischen Operatoren numerisch sein';
const VALUE_HINT = 'Fester Wert oder Topic';

// Trigger und Wenns haben keine wirksame Reihenfolge: alle Wenns werden
// gemeinsam geprüft. Diese Zeilen sind deshalb bewusst nicht verschiebbar –
// anders als die Aktionen des Dann- und Sonst-Zweigs (siehe actionNode).
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
  const required = kind === 'trigger';
  return `              <section class="condition-section condition-section--${kind}">
                <div class="condition-section-head"><span>${KIND_LABELS[kind]}</span><span class="condition-section-count">${items.length}</span></div>
                <div class="condition-item-zone">
${items.map((item) => itemRow(item, required && items.length === 1)).join('\n')}
                </div>
              </section>`;
}

// Eine Aktion des Dann-/Sonst-Zweigs: Wert zuweisen, Pause oder Schleife. Die
// Folge läuft von oben nach unten, deshalb trägt jede Zeile eine Dragfläche.
function actionRow(item, onlyItem) {
  return `                <div class="condition-item cnd-node cnd-action" data-item-id="${item.id}" data-item-kind="${item.kind}" data-node-type="${item.type}">
                  <span class="widget-drag cnd-drag" title="Aktion verschieben" aria-hidden="true">⠿</span>
                  <span class="condition-kind cnd-kind--${item.type}">${escapeHtml(item.typeLabel || KIND_LABELS[item.kind])}</span>
                  <span class="condition-item-description">${escapeHtml(item.description)}</span>
                  <span class="widget-actions">
                    <button type="button" class="widget-icon-btn" title="Aktion bearbeiten" onclick="openConditionItemDialog('edit', ${item.conditionId}, ${item.id})">✎</button>
                    <button type="button" class="widget-icon-btn" title="${onlyItem ? 'Mindestens ein Dann erforderlich' : 'Aktion entfernen'}"${onlyItem ? ' disabled' : ''} onclick="openConditionItemDelete(${item.conditionId}, ${item.id})">🗑</button>
                  </span>
                </div>`;
}

// Schleife: aufklappbarer Knoten, der weitere Aktionen (auch Schleifen) trägt.
function loopNode(item, onlyItem) {
  const children = (item.children || []).map((child) => actionNode(child, false)).join('\n');
  return `                <div class="cnd-node cnd-loop" data-item-id="${item.id}" data-item-kind="${item.kind}" data-node-type="loop" data-condition-key="loop-${item.id}">
                  <div class="ms-group-head cnd-loop-head" role="button" tabindex="0" aria-expanded="false">
                    <span class="ms-caret" aria-hidden="true">▸</span>
                    <span class="widget-drag cnd-drag" title="Schleife verschieben" aria-hidden="true">⠿</span>
                    <span class="condition-kind cnd-kind--loop">Schleife</span>
                    <span class="ms-group-title cnd-loop-title">${escapeHtml(String(item.description).replace(/^Schleife · /, ''))}</span>
                    <span class="ms-group-count">${(item.children || []).length}</span>
                    <div class="widget-group-actions">
                      <button type="button" class="widget-icon-btn" title="Aktion in die Schleife legen" onclick="event.stopPropagation(); openConditionItemDialog('add', ${item.conditionId}, null, '${item.kind}', ${item.id})">+</button>
                      <button type="button" class="widget-icon-btn" title="Schleife bearbeiten" onclick="event.stopPropagation(); openConditionItemDialog('edit', ${item.conditionId}, ${item.id})">✎</button>
                      <button type="button" class="widget-icon-btn" title="${onlyItem ? 'Mindestens ein Dann erforderlich' : 'Schleife entfernen'}"${onlyItem ? ' disabled' : ''} onclick="event.stopPropagation(); openConditionItemDelete(${item.conditionId}, ${item.id})">🗑</button>
                    </div>
                  </div>
                  <div class="ms-group-body cnd-loop-body">
                    <div class="condition-item-zone cnd-zone cnd-loop-zone" data-condition-id="${item.conditionId}" data-item-kind="${item.kind}" data-parent-id="${item.id}">
${children}
                    </div>
                  </div>
                </div>`;
}

function actionNode(item, onlyItem) {
  return item.type === 'loop' ? loopNode(item, onlyItem) : actionRow(item, onlyItem);
}

// Dann und Sonst sind Aktionsfolgen: sie laufen der Reihe nach ab und lassen
// sich per Drag&Drop sortieren – auch in eine Schleife hinein und heraus.
function actionSection(condition, kind, nodes, total) {
  const onlyItem = kind === 'then' && total === 1;
  return `              <section class="condition-section condition-section--${kind}">
                <div class="condition-section-head"><span>${KIND_LABELS[kind]}</span><span class="condition-section-count">${total}</span>
                  <button type="button" class="widget-icon-btn condition-section-add" title="Aktion hinzufügen" onclick="openConditionItemDialog('add', ${condition.id}, null, '${kind}')">+</button>
                </div>
                <div class="condition-item-zone cnd-zone cnd-branch-zone" data-condition-id="${condition.id}" data-item-kind="${kind}" data-parent-id="">
${nodes.map((item) => actionNode(item, onlyItem)).join('\n')}
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
              ${condition.triggers.length ? '' : '<span class="condition-enabled condition-enabled--loop" title="Ausgelöst von der zyklischen Prüfung ihrer Schleife">Zyklisch</span>'}
              ${condition.triggers.length
    ? `<span class="ms-group-count" title="Trigger / Wenn / Dann / Sonst">${condition.triggers.length} / ${condition.whenEnabled ? condition.whens.length : '—'} / ${condition.thens.length} / ${(condition.elses || []).length}</span>`
    : `<span class="ms-group-count" title="Aktionen">${condition.thens.length}</span>`}
              ${conditionStatus(condition)}
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Bedingung bearbeiten" onclick="event.stopPropagation(); openConditionEdit(${condition.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Bedingung entfernen" onclick="event.stopPropagation(); openConditionDelete(${condition.id})">🗑</button>
              </div>
            </div>
            <div class="ms-group-body condition-body">
${condition.triggers.length ? `${itemSection(condition, 'trigger', condition.triggers)}\n` : ''}${condition.whenEnabled ? `${itemSection(condition, 'when', condition.whens)}\n` : ''}${actionSection(condition, 'then', condition.thenTree || condition.thens, condition.thens.length)}
${(condition.elses || []).length ? `${actionSection(condition, 'else', condition.elseTree || condition.elses, condition.elses.length)}\n` : ''}              <button type="button" class="condition-add-row" title="Trigger, Wenn, Dann oder Sonst hinzufügen" aria-label="Element hinzufügen" onclick="openConditionItemDialog('add', ${condition.id})"><span aria-hidden="true">+</span></button>
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
                <button type="button" class="widget-icon-btn" title="Schleife anlegen" onclick="event.stopPropagation(); openConditionCreate(${folder.id}, 'loop')">+S</button>
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

function topicField(id, name, label, writable = false, extraClass = '') {
  return `<label class="field-block condition-topic-field${extraClass ? ` ${extraClass}` : ''}"><span>${label}</span><input id="${id}" name="${name}" data-state-picker${writable ? ' data-state-picker-writable' : ''} autocomplete="off" placeholder="State auswählen…"></label>`;
}

// Vergleichs- und Zielwerte nehmen wahlweise einen festen Wert oder ein Topic
// auf. Der Hinweis steht über dem Feld, den Auswahl-Button hängt der globale
// State-Picker automatisch dahinter. Der rote Text darunter erscheint, sobald
// ein fester Wert bei einer mathematischen Verwendung nicht numerisch ist.
function valueField(id, name, label, extraClass = '') {
  return `<label class="field-block condition-value-field${extraClass ? ` ${extraClass}` : ''}"><span id="${id}Label">${label}</span><span class="field-hint">${VALUE_HINT}</span><input id="${id}" name="${name}" data-condition-value data-state-picker autocomplete="off" placeholder="Wert oder Topic"><span class="error-text condition-value-error" id="${id}Error" hidden>${NUMERIC_HINT}</span></label>`;
}

function operationOptions() {
  return '<option value="set">Wert direkt setzen</option><option value="add">Addieren (+)</option><option value="sub">Subtrahieren (−)</option><option value="mul">Multiplizieren (×)</option><option value="div">Dividieren (÷)</option><option value="mod">Rest der Division</option><option value="min">Kleineren Wert nehmen</option><option value="max">Größeren Wert nehmen</option>';
}

// Dann und Sonst sind derselbe Aktionsbaustein: Ziel, Rechenfunktion, ein oder
// zwei Werte und optionale Rundung.
function actionFields(id, name, cssPrefix) {
  return `${topicField(`${id}Topic`, `${name}Topic`, 'Ziel-State', true)}
      <label class="field-block"><span>Funktion</span><select id="${id}Operation" name="${name}Operation" onchange="syncConditionDialogs()">${operationOptions()}</select></label>
      ${valueField(`${id}Value`, `${name}Value`, 'Zielwert')}
      ${valueField(`${id}Value2`, `${name}Value2`, 'Zweiter Wert', `${cssPrefix}-second`)}
      <label class="field-block"><span>Runden auf Nachkommastellen</span><input id="${id}Round" name="${name}Round" type="number" min="0" max="${values.MAX_ROUND_DIGITS}" placeholder="ohne Rundung" data-no-state-picker></label>`;
}

function sectionToggle(id, name, label, checked) {
  return `<label class="remember-row condition-section-toggle"><input type="hidden" name="${name}" value="0"><input id="${id}" type="checkbox" name="${name}" value="1"${checked ? ' checked' : ''} onchange="syncConditionDialogs()"><span>${label}</span></label>`;
}

function createDialog(folders) {
  return `<dialog id="conditionCreateDialog" class="value-dialog condition-dialog"><form action="/conditions" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3>Bedingung hinzufügen</h3><p class="muted">Eine <strong>Bedingung</strong> besteht aus Trigger und Dann; Wenn und Sonst lassen sich per Haken zuschalten. Eine <strong>Schleife</strong> braucht davon nichts: ihre zyklische Prüfung ist zugleich die Ausführungsbedingung.</p></div></div>
    <p id="conditionCreateError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="conditionCreateName" name="name" required maxlength="120"></label>
      <label class="field-block"><span>Verzeichnis</span><select id="conditionCreateFolder" name="folderId">${folderOptions(folders)}</select></label>
      <label class="field-block"><span>Art</span><select id="conditionCreateMode" name="mode" onchange="syncConditionDialogs()"><option value="condition">Bedingung (Trigger, Wenn, Dann)</option><option value="loop">Schleife (zyklische Prüfung)</option></select></label>
      <label class="remember-row remember-row--boxed"><input id="conditionCreateEnabled" type="checkbox" name="enabled" value="1" checked><span>Bedingung aktiv</span></label>
    </div></div>
    <div class="dialog-section create-loop-section"><div class="dialog-section-head"><h4>Schleife</h4></div>
      <p class="muted condition-section-hint">Die Prüfung ist hier Pflicht: Sie wird im angegebenen Abstand bewertet, und solange sie nicht zutrifft, läuft die Schleife erneut. Weitere Aktionen kommen anschließend über das Pluszeichen der Schleife hinzu.</p>
      <div class="dialog-grid dialog-grid--two">
        <label class="field-block"><span>Durchläufe</span><input id="createLoopRepeats" name="repeats" type="number" min="1" max="${MAX_REPEATS}" step="1" value="1" data-no-state-picker></label>
        <label class="field-block"><span>Prüfabstand in Sekunden</span><input id="createLoopInterval" name="checkIntervalSeconds" type="number" min="${MIN_CHECK_SECONDS}" max="${MAX_CHECK_SECONDS}" step="1" value="120" data-no-state-picker></label>
        ${topicField('createLoopCheckTopic', 'checkTopic', 'Prüf-State')}
        <label class="field-block"><span>Vergleich</span><select id="createLoopCheckOperator" name="checkOperator" onchange="syncConditionDialogs()">${operatorOptions()}</select></label>
        ${valueField('createLoopCheckValue', 'checkValue', 'Vergleichswert', 'create-loop-check-value')}
      </div>
    </div>
    <div class="dialog-section create-condition-section"><div class="dialog-section-head"><h4>Trigger</h4></div><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Art</span><select id="createTriggerType" name="triggerType" onchange="syncCreateTrigger()"><option value="time">Zeitliche Wiederholung</option><option value="change">Wertänderung</option><option value="event">Exaktes Ereignis</option></select></label>
      <label class="field-block create-trigger-time"><span>Zeitmodus</span><select id="createTriggerMode" name="triggerMode" onchange="syncCreateTrigger()"><option value="interval">Intervall</option><option value="schedule">Fester Wochenzeitpunkt</option></select></label>
      <label class="field-block create-trigger-interval"><span>Alle</span><span class="condition-inline-fields"><input id="createTriggerIntervalAmount" name="triggerIntervalAmount" type="number" min="1" max="10000" value="5"><select id="createTriggerIntervalUnit" name="triggerIntervalUnit"><option value="minutes">Minuten</option><option value="hours">Stunden</option><option value="days">Tage</option></select></span></label>
      <label class="field-block create-trigger-schedule"><span>Uhrzeit</span><input id="createTriggerTime" name="triggerTime" type="time" value="08:00"></label>
      <div class="field-block create-trigger-schedule"><span>Wochentage</span>${weekdayFields('trigger')}</div>
      <div class="create-trigger-topic">${topicField('createTriggerTopic', 'triggerTopic', 'Trigger-State')}</div>
      <label class="field-block create-trigger-event"><span>Exakter Ereigniswert</span><input id="createTriggerValue" name="triggerValue"></label>
    </div></div>
    <div class="dialog-section create-condition-section"><div class="dialog-section-head condition-dialog-head"><h4>Wenn</h4>${sectionToggle('createWhenEnabled', 'whenEnabled', 'Wenn-Prüfung verwenden', true)}</div><div class="dialog-grid dialog-grid--two create-when-fields">
      <input type="hidden" name="whenType" value="state">${topicField('createWhenTopic', 'whenTopic', 'Prüf-State')}
      <label class="field-block"><span>Vergleich</span><select id="createWhenOperator" name="whenOperator" onchange="syncConditionDialogs()">${operatorOptions()}</select></label>
      ${valueField('createWhenValue', 'whenValue', 'Vergleichswert', 'create-when-value')}
    </div></div>
    <div class="dialog-section create-condition-section"><div class="dialog-section-head"><h4>Dann</h4></div><div class="dialog-grid dialog-grid--two">
      <input type="hidden" name="thenType" value="write">${actionFields('createThen', 'then', 'create-then')}
    </div></div>
    <div class="dialog-section create-condition-section" id="createElseSection"><div class="dialog-section-head condition-dialog-head"><h4>Sonst</h4>${sectionToggle('createElseEnabled', 'elseEnabled', 'Sonst-Zweig anlegen', false)}</div><p class="muted condition-section-hint">Der Sonst-Zweig läuft, wenn die Wenn-Prüfung nicht zutrifft. Je Bedingung ist er einmal möglich.</p><div class="dialog-grid dialog-grid--two create-else-fields">
      <input type="hidden" name="elseType" value="write">${actionFields('createElse', 'else', 'create-else')}
    </div></div>
    <div class="button-row"><button type="submit">Bedingung anlegen</button><button type="button" class="secondary-button" onclick="document.getElementById('conditionCreateDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function operatorOptions() {
  return '<option value="eq">ist gleich</option><option value="neq">ist ungleich</option><option value="gt">ist größer als</option><option value="gte">ist größer/gleich</option><option value="lt">ist kleiner als</option><option value="lte">ist kleiner/gleich</option><option value="contains">enthält</option><option value="truthy">ist wahr/ein</option><option value="falsy">ist falsch/aus</option>';
}

function editDialog(folders) {
  return `<dialog id="conditionEditDialog" class="value-dialog"><form id="conditionEditForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3>Bedingung bearbeiten</h3><p class="muted">Name, Verzeichnis, Aktivzustand und die Wenn-Prüfung können jederzeit geändert werden.</p></div></div>
    <p id="conditionEditError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="conditionEditName" name="name" required maxlength="120"></label>
      <label class="field-block"><span>Verzeichnis</span><select id="conditionEditFolder" name="folderId">${folderOptions(folders)}</select></label>
      <label class="remember-row remember-row--boxed"><input id="conditionEditEnabled" type="checkbox" name="enabled" value="1"><span>Bedingung aktiv</span></label>
      <label class="remember-row remember-row--boxed"><input type="hidden" name="whenEnabled" value="0"><input id="conditionEditWhenEnabled" type="checkbox" name="whenEnabled" value="1"><span>Wenn-Prüfung verwenden</span></label>
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
    <div class="dialog-hero"><div><h3 id="conditionItemTitle">Element hinzufügen</h3><p class="muted">Trigger starten die Auswertung, alle Wenns werden gemeinsam geprüft, danach läuft der Dann-Zweig – oder der Sonst-Zweig. Dann und Sonst sind Aktionsfolgen: sie laufen von oben nach unten und können Pausen und Schleifen enthalten.</p></div></div>
    <p id="conditionItemError" class="error-text" hidden></p>
    <input type="hidden" id="conditionItemParent" name="parentId" value="">
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Bereich</span><select id="conditionItemKind" name="kind" onchange="syncConditionItemFields()"><option value="trigger">Trigger</option><option value="when">Wenn</option><option value="then">Dann</option><option value="else">Sonst</option></select></label>
      <label class="field-block"><span>Art</span><select id="conditionItemType" name="type" onchange="syncConditionItemFields()"></select></label>
      <label class="field-block condition-item-time"><span>Zeitmodus</span><select id="conditionItemMode" name="mode" onchange="syncConditionItemFields()"><option value="interval">Intervall</option><option value="schedule">Fester Wochenzeitpunkt</option></select></label>
      <label class="field-block condition-item-interval"><span>Alle</span><span class="condition-inline-fields"><input id="conditionItemIntervalAmount" name="intervalAmount" type="number" min="1" max="10000" value="5"><select id="conditionItemIntervalUnit" name="intervalUnit"><option value="minutes">Minuten</option><option value="hours">Stunden</option><option value="days">Tage</option></select></span></label>
      <label class="field-block condition-item-schedule"><span>Uhrzeit</span><input id="conditionItemTime" name="time" type="time" value="08:00"></label>
      <div class="field-block condition-item-schedule"><span>Wochentage</span>${weekdayFields('conditionItem')}</div>
      <div class="condition-item-topic">${topicField('conditionItemTopic', 'topic', 'State')}</div>
      <label class="field-block condition-item-operator"><span>Vergleich</span><select id="conditionItemOperator" name="operator" onchange="syncConditionItemFields()">${operatorOptions()}</select></label>
      <label class="field-block condition-item-event"><span>Exakter Ereigniswert</span><input id="conditionItemEventValue" name="value" data-no-state-picker></label>
      <label class="field-block condition-item-operation"><span>Funktion</span><select id="conditionItemOperation" name="operation" onchange="syncConditionItemFields()">${operationOptions()}</select></label>
      ${valueField('conditionItemValue', 'value', 'Wert', 'condition-item-value')}
      ${valueField('conditionItemValue2', 'value2', 'Zweiter Wert', 'condition-item-second')}
      <label class="field-block condition-item-round"><span>Runden auf Nachkommastellen</span><input id="conditionItemRound" name="round" type="number" min="0" max="${values.MAX_ROUND_DIGITS}" placeholder="ohne Rundung" data-no-state-picker></label>
      <label class="field-block condition-item-pause"><span>Pause in Sekunden</span><input id="conditionItemSeconds" name="seconds" type="number" min="0.1" max="${MAX_PAUSE_SECONDS}" step="0.1" value="2" data-no-state-picker></label>
      <label class="field-block condition-item-loop"><span>Durchläufe</span><input id="conditionItemRepeats" name="repeats" type="number" min="1" max="${MAX_REPEATS}" step="1" value="2" data-no-state-picker></label>
    </div></div>
    <div class="dialog-section condition-item-loop"><div class="dialog-section-head condition-dialog-head"><h4>Prüfung</h4><label class="remember-row condition-section-toggle"><input type="hidden" name="checkEnabled" value="0"><input id="conditionItemCheckEnabled" type="checkbox" name="checkEnabled" value="1" onchange="syncConditionItemFields()"><span>Zyklisch prüfen</span></label></div>
      <p class="muted condition-section-hint">Die Bedingung wird im angegebenen Abstand immer wieder geprüft – gezählt ab der letzten Ausführung dieser Schleife bzw. ab dem Start von homeESS. Trifft sie nicht zu, wird ausschließlich diese Schleife erneut abgespult. Geprüft wird nur der Zweig, der zuletzt ausgeführt wurde.</p>
      <div class="dialog-grid dialog-grid--two condition-item-check">
        ${topicField('conditionItemCheckTopic', 'checkTopic', 'Prüf-State')}
        <label class="field-block"><span>Vergleich</span><select id="conditionItemCheckOperator" name="checkOperator" onchange="syncConditionItemFields()">${operatorOptions()}</select></label>
        ${valueField('conditionItemCheckValue', 'checkValue', 'Vergleichswert', 'condition-item-check-value')}
        <label class="field-block"><span>Prüfabstand in Sekunden</span><input id="conditionItemCheckInterval" name="checkIntervalSeconds" type="number" min="${MIN_CHECK_SECONDS}" max="${MAX_CHECK_SECONDS}" step="1" value="120" data-no-state-picker></label>
      </div>
    </div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('conditionItemDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function deleteDialogs() {
  return `<dialog id="conditionDeleteDialog" class="value-dialog"><form id="conditionDeleteForm" method="POST" class="dialog-form"><h3>Bedingung entfernen</h3><p class="error-text">Die Bedingung und alle Trigger, Wenns und Danns werden dauerhaft gelöscht.</p><div class="button-row"><button class="button-danger" type="submit">Endgültig entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('conditionDeleteDialog').close()">Abbrechen</button></div></form></dialog>
  <dialog id="conditionItemDeleteDialog" class="value-dialog"><form id="conditionItemDeleteForm" method="POST" class="dialog-form"><h3>Element entfernen</h3><p class="error-text">Das Element wird dauerhaft aus der Bedingung entfernt. Bei einer Schleife verschwindet auch ihr gesamter Inhalt.</p><div class="button-row"><button class="button-danger" type="submit">Entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('conditionItemDeleteDialog').close()">Abbrechen</button></div></form></dialog>
  <dialog id="conditionFolderDeleteDialog" class="value-dialog"><form id="conditionFolderDeleteForm" method="POST" class="dialog-form"><h3>Verzeichnis entfernen</h3><p class="error-text">Das Verzeichnis, alle Unterverzeichnisse und die darin enthaltenen Bedingungen werden dauerhaft gelöscht.</p><div class="button-row"><button class="button-danger" type="submit">Endgültig entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('conditionFolderDeleteDialog').close()">Abbrechen</button></div></form></dialog>`;
}

function renderConditions({ conditions = [], folders = [], tree = null, error = '', message = '', initialDialog = null } = {}) {
  const rootFolders = Array.isArray(tree && tree.folders) ? tree.folders : [];
  const rootConditions = Array.isArray(tree && tree.conditions) ? tree.conditions : conditions;
  const safeConditions = JSON.stringify(conditions).replace(/</g, '\\u003c');
  const safeFolders = JSON.stringify(folders).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');
  const body = `        <div class="panel-head"><div><h1>Bedingungen</h1></div><div class="dashboard-toolbar"><button type="button" class="secondary-button" onclick="openConditionFolderDialog('add')">Verzeichnis hinzufügen</button><button type="button" class="secondary-button" onclick="openConditionCreate()">Bedingung hinzufügen</button><button type="button" class="secondary-button" onclick="openConditionCreate(null, 'loop')">Schleife hinzufügen</button></div></div>
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
    function allConditionItems(condition) { return condition ? condition.triggers.concat(condition.whens, condition.thens, condition.elses || []) : []; }
    function findConditionItem(conditionId, itemId) { return allConditionItems(findCondition(conditionId)).find(function (item) { return item.id === Number(itemId); }); }
    function conditionOpenMap() { try { return JSON.parse(localStorage.getItem(CONDITION_OPEN_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveConditionOpen() { var map = {}; document.querySelectorAll('[data-condition-key]').forEach(function (group) { map[group.dataset.conditionKey] = group.classList.contains('is-open'); }); try { localStorage.setItem(CONDITION_OPEN_KEY, JSON.stringify(map)); } catch (_) {} }
    function restoreConditionOpen() { var map = conditionOpenMap(); document.querySelectorAll('[data-condition-key]').forEach(function (group) { var open = map[group.dataset.conditionKey] === true; group.classList.toggle('is-open', open); var head = group.querySelector(':scope > .condition-head, :scope > .condition-folder-head'); if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false'); }); }
    function toggleCondition(head) { var group = head.parentNode; var open = group.classList.toggle('is-open'); head.setAttribute('aria-expanded', open ? 'true' : 'false'); saveConditionOpen(); }
    // Ausgeblendete Felder werden zusätzlich deaktiviert: so sendet das Formular
    // nur die Angaben des tatsächlich gewählten Bereichs.
    function showNodes(selector, show) { document.querySelectorAll(selector).forEach(function (node) { node.hidden = !show; if (node.matches('input, select, textarea')) node.disabled = !show; node.querySelectorAll('input, select, textarea').forEach(function (field) { field.disabled = !show; }); }); }
    var CONDITION_TOPIC_RE = new RegExp(${JSON.stringify(values.TOPIC_PATTERN)}, 'i');
    var CONDITION_BOOLEAN_WORDS = ${JSON.stringify(values.TRUE_WORDS.concat(values.FALSE_WORDS))};
    var CONDITION_MATH_OPERATORS = ${JSON.stringify(values.MATH_OPERATORS)};
    function conditionValueOf(id) { var node = document.getElementById(id); return node ? node.value : ''; }
    function conditionIsTopic(raw) { return CONDITION_TOPIC_RE.test(String(raw == null ? '' : raw).trim()); }
    function conditionIsNumeric(raw) { var text = String(raw == null ? '' : raw).trim().toLowerCase(); if (!text) return false; if (CONDITION_BOOLEAN_WORDS.indexOf(text) !== -1) return true; return isFinite(Number(text.replace(',', '.'))); }
    function conditionFieldVisible(node) { for (var cursor = node; cursor && cursor.nodeType === 1; cursor = cursor.parentNode) { if (cursor.hidden) return false; } return true; }
    function conditionActionNumeric(prefix) { return conditionValueOf(prefix + 'Operation') !== 'set' || String(conditionValueOf(prefix + 'Round')).trim() !== ''; }
    function conditionItemNumeric() { var kind = conditionValueOf('conditionItemKind'); if (kind === 'when') return CONDITION_MATH_OPERATORS.indexOf(conditionValueOf('conditionItemOperator')) !== -1; if ((kind === 'then' || kind === 'else') && conditionValueOf('conditionItemType') === 'write') return conditionActionNumeric('conditionItem'); return false; }
    var CONDITION_VALUE_FIELDS = [
      ['createWhenValue', function () { return CONDITION_MATH_OPERATORS.indexOf(conditionValueOf('createWhenOperator')) !== -1; }],
      ['createThenValue', function () { return conditionActionNumeric('createThen'); }],
      ['createThenValue2', function () { return true; }],
      ['createElseValue', function () { return conditionActionNumeric('createElse'); }],
      ['createElseValue2', function () { return true; }],
      ['createLoopCheckValue', function () { return CONDITION_MATH_OPERATORS.indexOf(conditionValueOf('createLoopCheckOperator')) !== -1; }],
      ['conditionItemValue', conditionItemNumeric],
      ['conditionItemValue2', function () { return true; }],
      ['conditionItemCheckValue', function () { return CONDITION_MATH_OPERATORS.indexOf(conditionValueOf('conditionItemCheckOperator')) !== -1; }]
    ];
    // Ein fest eingetragener Wert muss numerisch sein, sobald damit gerechnet
    // oder mathematisch verglichen wird. Topic-Verweise prüft erst die Engine
    // mit dem tatsächlichen Wert des Ziel-States.
    function syncConditionValidity() {
      var forms = [], valid = [];
      CONDITION_VALUE_FIELDS.forEach(function (entry) {
        var input = document.getElementById(entry[0]);
        if (!input) return;
        var raw = String(input.value || '').trim();
        var bad = raw !== '' && conditionFieldVisible(input) && entry[1]() && !conditionIsTopic(raw) && !conditionIsNumeric(raw);
        var hint = document.getElementById(entry[0] + 'Error');
        if (hint) hint.hidden = !bad;
        input.classList.toggle('is-invalid', bad);
        var index = forms.indexOf(input.form);
        if (index === -1) { forms.push(input.form); valid.push(true); index = forms.length - 1; }
        if (bad) valid[index] = false;
      });
      forms.forEach(function (form, index) {
        if (!form) return;
        form.querySelectorAll('button[type="submit"]').forEach(function (button) { button.disabled = !valid[index]; });
      });
    }
    // Wenn und Sonst sind im Anlegen-Dialog zuschaltbar und bleiben sonst
    // ausgeblendet; ohne Wenn-Prüfung gibt es keinen Sonst-Zweig.
    // Die Art entscheidet, welche Hälfte des Dialogs gilt: eine Bedingung mit
    // Trigger/Wenn/Dann/Sonst – oder eine Schleife, die sich über ihre zyklische
    // Prüfung selbst auslöst. Ausgeblendete Felder werden zusätzlich deaktiviert,
    // damit das Formular nur die Angaben der gewählten Art sendet.
    function conditionCreateIsLoop() { return conditionValueOf('conditionCreateMode') === 'loop'; }
    function syncConditionDialogs() {
      var loop = conditionCreateIsLoop();
      var whenBox = document.getElementById('createWhenEnabled');
      var elseBox = document.getElementById('createElseEnabled');
      var when = whenBox.checked;
      if (!when) elseBox.checked = false;
      elseBox.disabled = !when;
      document.getElementById('createElseSection').hidden = !when;
      showNodes('.create-condition-section', !loop);
      showNodes('.create-loop-section', loop);
      showNodes('.create-loop-check-value', loop && ['truthy', 'falsy'].indexOf(conditionValueOf('createLoopCheckOperator')) === -1);
      showNodes('.create-when-fields', !loop && when);
      showNodes('.create-when-value', !loop && when && ['truthy', 'falsy'].indexOf(conditionValueOf('createWhenOperator')) === -1);
      showNodes('.create-else-fields', !loop && when && elseBox.checked);
      showNodes('.create-then-second', !loop && conditionValueOf('createThenOperation') !== 'set');
      showNodes('.create-else-second', !loop && when && elseBox.checked && conditionValueOf('createElseOperation') !== 'set');
      if (!loop) syncCreateTrigger();
      syncConditionValidity();
    }
    function syncCreateTrigger() { if (conditionCreateIsLoop()) return; var type = document.getElementById('createTriggerType').value; var mode = document.getElementById('createTriggerMode').value; showNodes('.create-trigger-time', type === 'time'); showNodes('.create-trigger-interval', type === 'time' && mode === 'interval'); showNodes('.create-trigger-schedule', type === 'time' && mode === 'schedule'); showNodes('.create-trigger-topic', type === 'change' || type === 'event'); showNodes('.create-trigger-event', type === 'event'); }
    function conditionSelectHasValue(select, value) { if (!select) return false; for (var i = 0; i < select.options.length; i++) if (select.options[i].value === String(value)) return true; return false; }
    function openConditionCreate(folderId, mode) { var select = document.getElementById('conditionCreateFolder'); select.value = folderId != null && conditionSelectHasValue(select, folderId) ? String(folderId) : ''; document.getElementById('conditionCreateMode').value = mode === 'loop' ? 'loop' : 'condition'; document.getElementById('conditionCreateDialog').showModal(); syncConditionDialogs(); }
    function openConditionEdit(id) { var condition = findCondition(id); var form = document.getElementById('conditionEditForm'); form.action = '/conditions/' + id; document.getElementById('conditionEditName').value = condition.name; var folderSelect = document.getElementById('conditionEditFolder'); folderSelect.value = condition.folderId == null ? '' : String(condition.folderId); document.getElementById('conditionEditEnabled').checked = condition.enabled; document.getElementById('conditionEditWhenEnabled').checked = condition.whenEnabled !== false; document.getElementById('conditionEditDialog').showModal(); }
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
    // Dann und Sonst sind Aktionsfolgen und kennen deshalb dieselben Bausteine
    // wie die Aktionsfolgen der Module: Wert, Pause, Schleife.
    function itemTypes(kind) { return kind === 'trigger' ? [['time','Zeitliche Wiederholung'],['change','Wertänderung'],['event','Exaktes Ereignis']] : kind === 'when' ? [['state','State vergleichen']] : [['write','State schreiben'],['pause','Pause'],['loop','Schleife']]; }
    // Der Sonst-Zweig braucht eine aktive Wenn-Prüfung; Aktionen darf er wie das
    // Dann beliebig viele enthalten.
    function syncConditionItemKindOptions(condition, item) {
      var option = document.getElementById('conditionItemKind').querySelector('option[value="else"]');
      if (!option) return;
      var blocked = !item && !!condition && condition.whenEnabled === false;
      option.disabled = blocked;
      option.textContent = blocked ? 'Sonst (braucht eine Wenn-Prüfung)' : 'Sonst';
    }
    function fillItemTypes(kind, selected) { var select = document.getElementById('conditionItemType'); select.innerHTML = ''; itemTypes(kind).forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; select.appendChild(option); }); if (selected) select.value = selected; }
    function syncConditionItemFields() {
      var kind = document.getElementById('conditionItemKind').value;
      var type = document.getElementById('conditionItemType').value;
      var mode = document.getElementById('conditionItemMode').value;
      var op = document.getElementById('conditionItemOperator').value;
      var action = kind === 'then' || kind === 'else';
      // Innerhalb einer Aktionsfolge entscheidet die Art über die Felder: eine
      // Wert-Zuweisung schreibt, eine Pause wartet, eine Schleife wiederholt.
      var write = action && type === 'write';
      var pause = action && type === 'pause';
      var loop = action && type === 'loop';
      var checkEnabled = document.getElementById('conditionItemCheckEnabled').checked;
      showNodes('.condition-item-time', kind === 'trigger' && type === 'time');
      showNodes('.condition-item-interval', kind === 'trigger' && type === 'time' && mode === 'interval');
      showNodes('.condition-item-schedule', kind === 'trigger' && type === 'time' && mode === 'schedule');
      showNodes('.condition-item-topic', write || kind === 'when' || (kind === 'trigger' && type !== 'time'));
      showNodes('.condition-item-operator', kind === 'when');
      showNodes('.condition-item-event', kind === 'trigger' && type === 'event');
      showNodes('.condition-item-operation', write);
      showNodes('.condition-item-round', write);
      showNodes('.condition-item-value', write || (kind === 'when' && op !== 'truthy' && op !== 'falsy'));
      showNodes('.condition-item-second', write && conditionValueOf('conditionItemOperation') !== 'set');
      showNodes('.condition-item-pause', pause);
      showNodes('.condition-item-loop', loop);
      showNodes('.condition-item-check', loop && checkEnabled);
      showNodes('.condition-item-check-value', loop && checkEnabled && ['truthy', 'falsy'].indexOf(conditionValueOf('conditionItemCheckOperator')) === -1);
      var topic = document.getElementById('conditionItemTopic');
      if (write) topic.setAttribute('data-state-picker-writable', ''); else topic.removeAttribute('data-state-picker-writable');
      document.getElementById('conditionItemValueLabel').textContent = write ? 'Zielwert' : 'Vergleichswert';
      syncConditionValidity();
    }
    function valueArray(values) { return Array.isArray(values) ? values.map(String) : values == null || values === '' ? [] : String(values).split(','); }
    function setWeekdayGroup(id, values) { var wanted=valueArray(values); document.querySelectorAll('#'+id+' input').forEach(function (input) { input.checked = wanted.includes(input.value); }); }
    // Bereich und Schleife werden vorbelegt, wenn der Dialog aus einem Zweig
    // oder aus einer Schleife heraus geöffnet wird.
    function openConditionItemDialog(mode, conditionId, itemId, presetKind, parentId) {
      var item = mode === 'edit' ? findConditionItem(conditionId, itemId) : null;
      var kind = item ? item.kind : (presetKind || 'trigger');
      var kindSelect = document.getElementById('conditionItemKind');
      syncConditionItemKindOptions(findCondition(conditionId), item);
      kindSelect.value = kind; kindSelect.disabled = !!item;
      fillItemTypes(kind, item && item.type);
      // Die Aktionsart bleibt beim Bearbeiten erhalten – eine Schleife mit
      // Inhalt würde beim Wechsel ihre Aktionen verlieren.
      var typeSelect = document.getElementById('conditionItemType');
      typeSelect.disabled = !!item && (kind === 'then' || kind === 'else');
      document.getElementById('conditionItemParent').value = item ? (item.parentId == null ? '' : String(item.parentId)) : (parentId == null ? '' : String(parentId));
      document.getElementById('conditionItemTitle').textContent = item ? KIND_LABELS_JS[kind] + ' bearbeiten' : 'Element hinzufügen';
      var form = document.getElementById('conditionItemForm');
      form.action = item ? '/conditions/' + conditionId + '/items/' + itemId : '/conditions/' + conditionId + '/items';
      var c = item ? item.config : {};
      var check = c.check || {};
      document.getElementById('conditionItemSeconds').value = c.seconds == null ? 2 : c.seconds;
      document.getElementById('conditionItemRepeats').value = c.repeats == null ? 2 : c.repeats;
      document.getElementById('conditionItemCheckEnabled').checked = !!c.checkEnabled;
      document.getElementById('conditionItemCheckTopic').value = check.topic || '';
      document.getElementById('conditionItemCheckOperator').value = check.operator || 'eq';
      document.getElementById('conditionItemCheckValue').value = check.value == null ? '' : check.value;
      document.getElementById('conditionItemCheckInterval').value = c.checkIntervalSeconds == null ? 120 : c.checkIntervalSeconds;
      document.getElementById('conditionItemMode').value = c.mode || 'interval';
      document.getElementById('conditionItemIntervalAmount').value = c.intervalAmount || 5;
      document.getElementById('conditionItemIntervalUnit').value = c.intervalUnit || 'minutes';
      document.getElementById('conditionItemTime').value = c.time || '08:00';
      setWeekdayGroup('conditionItemWeekdays', c.weekdays || [0,1,2,3,4,5,6]);
      document.getElementById('conditionItemTopic').value = c.topic || '';
      document.getElementById('conditionItemOperator').value = c.operator || 'eq';
      document.getElementById('conditionItemOperation').value = c.operation || 'set';
      document.getElementById('conditionItemRound').value = c.round == null ? '' : c.round;
      // Ereigniswert und Vergleichs-/Zielwert teilen sich den Feldnamen; gesendet
      // wird nur das sichtbare Feld.
      document.getElementById('conditionItemEventValue').value = c.value == null ? '' : c.value;
      document.getElementById('conditionItemValue').value = c.value == null ? '' : c.value;
      document.getElementById('conditionItemValue2').value = c.value2 == null ? '' : c.value2;
      syncConditionItemFields();
      document.getElementById('conditionItemDialog').showModal();
    }
    var KIND_LABELS_JS = { trigger: 'Trigger', when: 'Wenn', then: 'Dann', else: 'Sonst' };
    document.getElementById('conditionItemKind').addEventListener('change', function () { fillItemTypes(this.value); syncConditionItemFields(); });
    document.getElementById('conditionItemForm').addEventListener('submit', function () {
      // Gesperrte Felder senden nichts: Bereich und Art werden zum Absenden
      // kurz freigegeben, damit der Server sie wie eingestellt erhält.
      document.getElementById('conditionItemKind').disabled = false;
      document.getElementById('conditionItemType').disabled = false;
    });
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
    // Aktionen des Dann-/Sonst-Zweigs sind verschiebbar: innerhalb ihres Zweigs,
    // in eine Schleife hinein und wieder heraus. Gespeichert wird der gesamte
    // Baum beider Zweige der betroffenen Bedingung.
    var draggedConditionAction = null, conditionActionZone = null, conditionActionRef = null;
    function conditionActionZoneOf(node) { return node.closest('.cnd-zone'); }
    function conditionActionOwner(node) { var zone = conditionActionZoneOf(node); return zone ? Number(zone.dataset.conditionId) : null; }
    function conditionActionCanEnter(action, zone) {
      if (Number(zone.dataset.conditionId) !== conditionActionOwner(action)) return false;
      if (zone.dataset.itemKind !== action.dataset.itemKind) return false;
      var owner = zone.closest('.cnd-loop');
      return !owner || (owner !== action && !action.contains(owner));
    }
    function conditionActionPayload(conditionId) {
      var items = [];
      document.querySelectorAll('.cnd-zone[data-condition-id="' + conditionId + '"]').forEach(function (zone) {
        var parentId = zone.dataset.parentId ? Number(zone.dataset.parentId) : null;
        directChildren(zone, '.cnd-node').forEach(function (node, position) {
          items.push({ id: Number(node.dataset.itemId), kind: zone.dataset.itemKind, parentId: parentId, position: position });
        });
      });
      return { items: items };
    }
    function persistConditionActions(conditionId) {
      if (conditionLayoutSaving) return; conditionLayoutSaving = true;
      fetch('/conditions/' + conditionId + '/items/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(conditionActionPayload(conditionId)) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Reihenfolge konnte nicht gespeichert werden.'); }); })
        .then(function () { window.location.reload(); })
        .catch(function (error) { alert(error.message); window.location.reload(); });
    }
    function setupConditionActionZone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedConditionAction || !conditionActionCanEnter(draggedConditionAction, zone)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        conditionActionZone = zone;
        conditionActionRef = insertAtPointer(zone, '.cnd-node', draggedConditionAction, event.clientY);
        markConditionDrop(zone, conditionActionRef, '.cnd-node');
      });
      zone.addEventListener('drop', function (event) {
        if (!draggedConditionAction || !conditionActionCanEnter(draggedConditionAction, zone)) return;
        event.preventDefault(); event.stopPropagation();
        if (conditionActionRef) zone.insertBefore(draggedConditionAction, conditionActionRef); else zone.appendChild(draggedConditionAction);
      });
    }
    function setupConditionAction(node) {
      var handle = node.querySelector(':scope > .cnd-drag, :scope > .cnd-loop-head > .cnd-drag');
      if (!handle) return;
      handle.addEventListener('mousedown', function () { node.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', function () { node.removeAttribute('draggable'); });
      node.addEventListener('dragstart', function (event) {
        event.stopPropagation(); draggedConditionAction = node; conditionActionZone = null; conditionActionRef = null;
        node.classList.add('group-dragging'); event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'action:' + node.dataset.itemId);
      });
      node.addEventListener('dragend', function (event) {
        event.stopPropagation(); node.removeAttribute('draggable'); node.classList.remove('group-dragging');
        var conditionId = conditionActionOwner(node);
        draggedConditionAction = null; conditionActionZone = null; conditionActionRef = null;
        clearConditionDropIndicators(); saveConditionOpen();
        if (conditionId != null) persistConditionActions(conditionId);
      });
      var head = node.querySelector(':scope > .cnd-loop-head');
      if (!head) return;
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions, .cnd-drag')) toggleCondition(head); });
      head.addEventListener('keydown', function (event) { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggleCondition(head); } });
    }
    document.querySelectorAll('.cnd-zone').forEach(setupConditionActionZone);
    document.querySelectorAll('.cnd-node').forEach(setupConditionAction);
    document.querySelectorAll('.condition-dropzone').forEach(setupConditionDropzone);
    document.querySelectorAll('.condition-folder-zone').forEach(setupConditionFolderZone);
    document.querySelectorAll('.condition-group').forEach(setupConditionGroup);
    document.querySelectorAll('.condition-folder').forEach(setupConditionFolder);
    document.querySelectorAll('[data-condition-value]').forEach(function (input) { input.addEventListener('input', syncConditionValidity); input.addEventListener('change', syncConditionValidity); });
    document.querySelectorAll('#createThenRound, #createElseRound, #conditionItemRound').forEach(function (input) { input.addEventListener('input', syncConditionValidity); });
    restoreConditionOpen(); window.addEventListener('pageshow',restoreConditionOpen); syncConditionDialogs(); fillItemTypes('trigger'); syncConditionItemFields();
    document.querySelectorAll('[data-condition-time]').forEach(function (node) { var at=Number(node.dataset.conditionTime); if(at) node.textContent='Zuletzt '+new Date(at).toLocaleString(); });
    // Nach einem abgelehnten Formular wird der Dialog mit den zuletzt
    // eingegebenen Werten erneut geöffnet.
    function conditionSetValue(id, value, fallback) { var node = document.getElementById(id); if (node) node.value = value == null || value === '' ? (fallback == null ? '' : fallback) : value; }
    function conditionSetChecked(id, value, fallback) {
      var node = document.getElementById(id);
      if (!node) return;
      var raw = Array.isArray(value) ? (value.length ? value[value.length - 1] : null) : value;
      node.checked = raw == null ? !!fallback : ['1', 'true', 'on'].indexOf(String(raw)) !== -1;
    }
    function restoreConditionAction(prefix, key, v) {
      conditionSetValue(prefix + 'Topic', v[key + 'Topic']);
      conditionSetValue(prefix + 'Operation', v[key + 'Operation'], 'set');
      conditionSetValue(prefix + 'Value', v[key + 'Value']);
      conditionSetValue(prefix + 'Value2', v[key + 'Value2']);
      conditionSetValue(prefix + 'Round', v[key + 'Round']);
    }
    if (conditionInitialDialog) {
      var v = conditionInitialDialog.values || {};
      var dialogKind = conditionInitialDialog.kind;
      if (dialogKind === 'condition-create') {
        openConditionCreate(v.folderId, v.mode);
        conditionSetValue('conditionCreateName', v.name);
        conditionSetValue('createLoopRepeats', v.repeats, 1);
        conditionSetValue('createLoopInterval', v.checkIntervalSeconds, 120);
        conditionSetValue('createLoopCheckTopic', v.checkTopic);
        conditionSetValue('createLoopCheckOperator', v.checkOperator, 'eq');
        conditionSetValue('createLoopCheckValue', v.checkValue);
        conditionSetChecked('conditionCreateEnabled', v.enabled, false);
        conditionSetChecked('createWhenEnabled', v.whenEnabled, true);
        conditionSetChecked('createElseEnabled', v.elseEnabled, false);
        conditionSetValue('createTriggerType', v.triggerType, 'time');
        conditionSetValue('createTriggerMode', v.triggerMode, 'interval');
        conditionSetValue('createTriggerIntervalAmount', v.triggerIntervalAmount, 5);
        conditionSetValue('createTriggerIntervalUnit', v.triggerIntervalUnit, 'minutes');
        conditionSetValue('createTriggerTime', v.triggerTime, '08:00');
        setWeekdayGroup('triggerWeekdays', v.triggerWeekdays || [0,1,2,3,4,5,6]);
        conditionSetValue('createTriggerTopic', v.triggerTopic);
        conditionSetValue('createTriggerValue', v.triggerValue);
        conditionSetValue('createWhenTopic', v.whenTopic);
        conditionSetValue('createWhenOperator', v.whenOperator, 'eq');
        conditionSetValue('createWhenValue', v.whenValue);
        restoreConditionAction('createThen', 'then', v);
        restoreConditionAction('createElse', 'else', v);
        syncConditionDialogs();
      } else if (dialogKind === 'condition-edit') {
        openConditionEdit(conditionInitialDialog.conditionId);
        conditionSetValue('conditionEditName', v.name);
        if (conditionSelectHasValue(document.getElementById('conditionEditFolder'), v.folderId == null ? '' : v.folderId)) document.getElementById('conditionEditFolder').value = v.folderId == null ? '' : String(v.folderId);
        conditionSetChecked('conditionEditEnabled', v.enabled, false);
        conditionSetChecked('conditionEditWhenEnabled', v.whenEnabled, true);
      } else if (dialogKind === 'folder-add' || dialogKind === 'folder-edit') {
        openConditionFolderDialog(dialogKind === 'folder-edit' ? 'edit' : 'add', conditionInitialDialog.folderId);
        conditionSetValue('conditionFolderName', v.name);
        if (conditionSelectHasValue(document.getElementById('conditionFolderParent'), v.parentId == null ? '' : v.parentId)) document.getElementById('conditionFolderParent').value = v.parentId == null ? '' : String(v.parentId);
      } else {
        openConditionItemDialog(dialogKind === 'item-edit' ? 'edit' : 'add', conditionInitialDialog.conditionId, conditionInitialDialog.itemId);
        var kind = v.kind || document.getElementById('conditionItemKind').value;
        document.getElementById('conditionItemKind').value = kind;
        fillItemTypes(kind, v.type);
        conditionSetValue('conditionItemMode', v.mode, 'interval');
        conditionSetValue('conditionItemIntervalAmount', v.intervalAmount, 5);
        conditionSetValue('conditionItemIntervalUnit', v.intervalUnit, 'minutes');
        conditionSetValue('conditionItemTime', v.time, '08:00');
        setWeekdayGroup('conditionItemWeekdays', v.weekdays || [0,1,2,3,4,5,6]);
        conditionSetValue('conditionItemTopic', v.topic);
        conditionSetValue('conditionItemOperator', v.operator, 'eq');
        conditionSetValue('conditionItemOperation', v.operation, 'set');
        conditionSetValue('conditionItemRound', v.round);
        conditionSetValue('conditionItemEventValue', v.value);
        conditionSetValue('conditionItemValue', v.value);
        conditionSetValue('conditionItemValue2', v.value2);
        conditionSetValue('conditionItemParent', v.parentId);
        conditionSetValue('conditionItemSeconds', v.seconds, 2);
        conditionSetValue('conditionItemRepeats', v.repeats, 2);
        conditionSetChecked('conditionItemCheckEnabled', v.checkEnabled, false);
        conditionSetValue('conditionItemCheckTopic', v.checkTopic);
        conditionSetValue('conditionItemCheckOperator', v.checkOperator, 'eq');
        conditionSetValue('conditionItemCheckValue', v.checkValue);
        conditionSetValue('conditionItemCheckInterval', v.checkIntervalSeconds, 120);
        syncConditionItemFields();
      }
      var errorId = dialogKind === 'condition-create' ? 'conditionCreateError' : dialogKind === 'condition-edit' ? 'conditionEditError' : dialogKind === 'folder-add' || dialogKind === 'folder-edit' ? 'conditionFolderError' : 'conditionItemError';
      var err = document.getElementById(errorId);
      if (err) { err.textContent = conditionInitialDialog.error || ''; err.hidden = !err.textContent; }
    }
  `;
  return renderLayout({ title: 'Bedingungen', activePath: '/conditions', body, script });
}

module.exports = renderConditions;
