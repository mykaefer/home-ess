'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

const TYPE_LABELS = { boolean: 'Boolean', integer: 'Integer', float: 'Floating Point', text: 'Text', json: 'JSON' };

function stateValueControl(state) {
  if (state.dataType === 'boolean') {
    return `<select id="custom-value-${state.id}" class="custom-state-value"><option value="true"${state.value === true ? ' selected' : ''}>Ein</option><option value="false"${state.value === false ? ' selected' : ''}>Aus</option></select>`;
  }
  const type = state.dataType === 'integer' || state.dataType === 'float' ? 'number' : 'text';
  const step = state.dataType === 'integer' ? '1' : state.dataType === 'float' ? 'any' : '';
  return `<input id="custom-value-${state.id}" class="custom-state-value" type="${type}"${step ? ` step="${step}"` : ''} value="${escapeHtml(state.valueInput)}">`;
}

function renderStateRow(state) {
  return `              <div class="custom-state-row" data-state-id="${state.id}">
                <span class="custom-state-name">${escapeHtml(state.name)}</span>
                <code class="custom-state-topic">${escapeHtml(state.topic)}</code>
                <span class="custom-state-type">${escapeHtml(TYPE_LABELS[state.dataType] || state.dataType)}${state.unit ? ` · ${escapeHtml(state.unit)}` : ''}</span>
                <span class="custom-state-editor">${stateValueControl(state)}<button type="button" class="custom-value-save" onclick="saveCustomValue(${state.id})">Setzen</button></span>
                <span class="widget-actions">
                  <button type="button" class="widget-icon-btn" title="State bearbeiten" onclick="openStateDialog('edit', ${state.id})">✎</button>
                  <form method="POST" action="/states/custom/state/${state.id}/delete" onsubmit="return confirm('Custom State wirklich entfernen?')"><button type="submit" class="widget-icon-btn" title="State entfernen">🗑</button></form>
                </span>
              </div>`;
}

function renderFolder(folder, depth = 0) {
  const children = folder.folders.map((child) => renderFolder(child, depth + 1)).join('\n');
  const states = folder.states.map(renderStateRow).join('\n');
  return `          <div class="custom-folder" style="--tree-depth:${depth}" data-custom-tree-key="folder-${folder.id}">
            <div class="custom-folder-head" onclick="toggleCustomFolder(this)">
              <span class="value-cat-caret">▸</span>
              <span class="custom-folder-name">📁 ${escapeHtml(folder.name)}</span>
              <span class="value-cat-count">${folder.stateCount}</span>
              <span class="widget-actions" onclick="event.stopPropagation()">
                <button type="button" class="widget-icon-btn" title="Unterverzeichnis anlegen" onclick="openFolderDialog('add', null, ${folder.id})">+📁</button>
                <button type="button" class="widget-icon-btn" title="State anlegen" onclick="openStateDialog('add', null, ${folder.id})">+S</button>
                <button type="button" class="widget-icon-btn" title="Verzeichnis umbenennen" onclick="openFolderDialog('edit', ${folder.id})">✎</button>
                <form method="POST" action="/states/custom/folder/${folder.id}/delete" onsubmit="return confirm('Verzeichnis samt Unterverzeichnissen und States wirklich entfernen?')"><button type="submit" class="widget-icon-btn" title="Verzeichnis entfernen">🗑</button></form>
              </span>
            </div>
            <div class="custom-folder-body">
${states}
${children}
            </div>
          </div>`;
}

function folderOptions(folders, selectedId = null) {
  const rows = ['<option value="">Ohne Verzeichnis</option>'];
  for (const folder of folders) {
    rows.push(`<option value="${folder.id}"${folder.id === selectedId ? ' selected' : ''}>${escapeHtml(folder.path.join(' / '))}</option>`);
  }
  return rows.join('');
}

function renderCustomStates({ tree, folders = [], states = [], error = '', message = '' } = {}) {
  const rootStates = tree.states.map(renderStateRow).join('\n');
  const folderRows = tree.folders.map((folder) => renderFolder(folder)).join('\n');
  const empty = !rootStates && !folderRows ? '<p class="muted custom-empty">Noch keine Custom States vorhanden.</p>' : '';
  const safeFolders = JSON.stringify(folders).replace(/</g, '\\u003c');
  const safeStates = JSON.stringify(states).replace(/</g, '\\u003c');

  const body = `        <div class="panel-head">
          <div><h1>Custom States</h1><p class="muted">Frei verwendbare, persistente Werte für Counter, Betriebszustände und weitere Verarbeitung. Jeder Wert ist unter <code>custom://...</code> les- und schreibbar.</p></div>
          <div class="dashboard-toolbar"><button type="button" class="secondary-button" onclick="openFolderDialog('add')">Verzeichnis anlegen</button><button type="button" class="secondary-button" onclick="openStateDialog('add')">State anlegen</button></div>
        </div>
        ${statusText(error)}${statusText(message, 'success')}
        <div class="custom-states-tree">
          ${rootStates ? `<div class="custom-root-states">${rootStates}</div>` : ''}
${folderRows}
${empty}
        </div>

        <dialog id="customFolderDialog" class="value-dialog"><form id="customFolderForm" method="POST" class="dialog-form">
          <h3 id="customFolderTitle">Verzeichnis anlegen</h3>
          <label class="field-block"><span>Name</span><input id="customFolderName" name="name" required maxlength="100"></label>
          <label class="field-block" id="customFolderParentRow"><span>Übergeordnetes Verzeichnis</span><select id="customFolderParent" name="parentId">${folderOptions(folders)}</select></label>
          <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('customFolderDialog').close()">Abbrechen</button></div>
        </form></dialog>

        <dialog id="customStateDialog" class="value-dialog"><form id="customStateForm" method="POST" class="dialog-form">
          <h3 id="customStateTitle">State anlegen</h3>
          <div class="dialog-grid">
            <label class="field-block"><span>Name</span><input id="customStateName" name="name" required maxlength="100"></label>
            <label class="field-block"><span>Verzeichnis</span><select id="customStateFolder" name="folderId">${folderOptions(folders)}</select></label>
            <label class="field-block"><span>Datentyp</span><select id="customStateType" name="dataType" onchange="syncCustomTypeFields()"><option value="boolean">Boolean</option><option value="integer">Integer</option><option value="float">Floating Point</option><option value="text">Text</option><option value="json">JSON</option></select></label>
            <label class="field-block"><span>Wert</span><input id="customStateValue" name="value"><select id="customStateBoolean"><option value="false">Aus</option><option value="true">Ein</option></select></label>
            <label class="field-block"><span>Einheitszeichen <span class="pool-optional">(optional)</span></span><input id="customStateUnit" name="unit" maxlength="24" placeholder="z. B. °C, kWh, %"></label>
            <div id="customRoundingFields" class="custom-rounding-fields">
              <label class="field-block"><span>Nachkommastellen <span class="pool-optional">(leer = unverändert)</span></span><input id="customStateDecimals" name="decimals" type="number" min="0" max="12"></label>
              <label class="field-block"><span>Rundungsverhalten</span><select id="customStateRounding" name="rounding"><option value="nearest">Kaufmännisch</option><option value="floor">Abrunden</option><option value="ceil">Aufrunden</option><option value="trunc">Abschneiden</option></select></label>
            </div>
          </div>
          <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('customStateDialog').close()">Abbrechen</button></div>
        </form></dialog>`;

  const script = `
    var customFolders = ${safeFolders};
    var customStates = ${safeStates};
    var CUSTOM_TREE_KEY = 'homeess.custom-states.expanded.v1';
    var CUSTOM_STATE_FOLDER_KEY = 'homeess.custom-states.last-state-folder.v1';
    var CUSTOM_STATE_TYPE_KEY = 'homeess.custom-states.last-state-type.v1';
    var CUSTOM_FOLDER_PARENT_KEY = 'homeess.custom-states.last-folder-parent.v1';
    var customStateDialogMode = 'add';
    var customFolderDialogMode = 'add';
    function customStored(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } }
    function customRemember(key, value) { try { localStorage.setItem(key, value == null ? '' : String(value)); } catch (_) {} }
    function customSelectHasValue(select, value) {
      if (!select) return false;
      for (var i = 0; i < select.options.length; i++) if (select.options[i].value === String(value)) return true;
      return false;
    }
    function customStoredChoice(select, key, fallback) {
      var stored = customStored(key);
      if (customSelectHasValue(select, stored)) return stored;
      return customSelectHasValue(select, fallback) ? String(fallback) : '';
    }
    function customExpanded() { try { return JSON.parse(localStorage.getItem(CUSTOM_TREE_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function toggleCustomFolder(head) {
      var folder = head.parentNode; folder.classList.toggle('is-open');
      var values = customExpanded(); values[folder.dataset.customTreeKey] = folder.classList.contains('is-open');
      try { localStorage.setItem(CUSTOM_TREE_KEY, JSON.stringify(values)); } catch (_) {}
    }
    function restoreCustomFolders() {
      var values = customExpanded(); var nodes = document.querySelectorAll('[data-custom-tree-key]');
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('is-open', values[nodes[i].dataset.customTreeKey] === true);
    }
    function customFolder(id) { for (var i = 0; i < customFolders.length; i++) if (customFolders[i].id === id) return customFolders[i]; return null; }
    function customState(id) { for (var i = 0; i < customStates.length; i++) if (customStates[i].id === id) return customStates[i]; return null; }
    function openFolderDialog(mode, id, parentId) {
      var form = document.getElementById('customFolderForm'); var item = customFolder(id);
      customFolderDialogMode = mode;
      form.action = mode === 'edit' ? '/states/custom/folder/' + id : '/states/custom/folder';
      document.getElementById('customFolderTitle').textContent = mode === 'edit' ? 'Verzeichnis umbenennen' : 'Verzeichnis anlegen';
      document.getElementById('customFolderName').value = item ? item.name : '';
      var parentSelect = document.getElementById('customFolderParent');
      parentSelect.value = mode === 'add' && parentId == null
        ? customStoredChoice(parentSelect, CUSTOM_FOLDER_PARENT_KEY, '')
        : parentId == null ? '' : String(parentId);
      document.getElementById('customFolderParentRow').style.display = mode === 'edit' ? 'none' : '';
      document.getElementById('customFolderDialog').showModal();
    }
    function syncCustomTypeFields() {
      var type = document.getElementById('customStateType').value;
      var text = document.getElementById('customStateValue'); var bool = document.getElementById('customStateBoolean');
      bool.style.display = type === 'boolean' ? '' : 'none'; text.style.display = type === 'boolean' ? 'none' : '';
      text.name = type === 'boolean' ? '' : 'value'; bool.name = type === 'boolean' ? 'value' : '';
      text.type = type === 'integer' || type === 'float' ? 'number' : 'text'; text.step = type === 'integer' ? '1' : type === 'float' ? 'any' : '';
      document.getElementById('customRoundingFields').style.display = type === 'float' ? 'contents' : 'none';
    }
    function openStateDialog(mode, id, folderId) {
      var form = document.getElementById('customStateForm'); var item = customState(id);
      customStateDialogMode = mode;
      form.action = mode === 'edit' ? '/states/custom/state/' + id : '/states/custom/state';
      document.getElementById('customStateTitle').textContent = mode === 'edit' ? 'Custom State bearbeiten' : 'Custom State anlegen';
      document.getElementById('customStateName').value = item ? item.name : '';
      var folderSelect = document.getElementById('customStateFolder');
      folderSelect.value = item && item.folderId != null ? String(item.folderId)
        : folderId != null ? String(folderId)
          : customStoredChoice(folderSelect, CUSTOM_STATE_FOLDER_KEY, '');
      var typeSelect = document.getElementById('customStateType');
      typeSelect.value = item ? item.dataType : customStoredChoice(typeSelect, CUSTOM_STATE_TYPE_KEY, 'text');
      document.getElementById('customStateValue').value = item ? item.valueInput : '';
      document.getElementById('customStateBoolean').value = item && item.value === true ? 'true' : 'false';
      document.getElementById('customStateUnit').value = item ? item.unit : '';
      document.getElementById('customStateDecimals').value = item && item.decimals != null ? item.decimals : '';
      document.getElementById('customStateRounding').value = item ? item.rounding : 'nearest';
      syncCustomTypeFields(); document.getElementById('customStateDialog').showModal();
    }
    function saveCustomValue(id) {
      var input = document.getElementById('custom-value-' + id); var button = input && input.parentNode.querySelector('.custom-value-save');
      if (!input) return; if (button) button.disabled = true;
      fetch('/states/custom/state/' + id + '/value', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ value: input.value }) })
        .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Wert konnte nicht gesetzt werden.'); return data; }); })
        .then(function (data) { input.value = data.valueInput; })
        .catch(function (err) { alert(err.message); })
        .finally(function () { if (button) button.disabled = false; });
    }
    document.getElementById('customStateForm').addEventListener('submit', function () {
      if (customStateDialogMode !== 'add') return;
      customRemember(CUSTOM_STATE_FOLDER_KEY, document.getElementById('customStateFolder').value);
      customRemember(CUSTOM_STATE_TYPE_KEY, document.getElementById('customStateType').value);
    });
    document.getElementById('customFolderForm').addEventListener('submit', function () {
      if (customFolderDialogMode !== 'add') return;
      customRemember(CUSTOM_FOLDER_PARENT_KEY, document.getElementById('customFolderParent').value);
    });
    restoreCustomFolders(); window.addEventListener('pageshow', restoreCustomFolders); syncCustomTypeFields();
  `;
  return renderLayout({ title: 'Custom States', activePath: '/states/custom', body, script });
}

module.exports = renderCustomStates;
