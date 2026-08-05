'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

const TYPE_LABELS = {
  boolean: 'Boolean', integer: 'Integer', float: 'Floating Point', text: 'Text', json: 'JSON',
};

function stateValueControl(state) {
  if (state.dataType === 'boolean') {
    return `<select id="custom-value-${state.id}" class="custom-state-value"><option value="true"${state.value === true ? ' selected' : ''}>Ein</option><option value="false"${state.value === false ? ' selected' : ''}>Aus</option></select>`;
  }
  const type = state.dataType === 'integer' || state.dataType === 'float' ? 'number' : 'text';
  const step = state.dataType === 'integer' ? '1' : state.dataType === 'float' ? 'any' : '';
  return `<input id="custom-value-${state.id}" class="custom-state-value" type="${type}"${step ? ` step="${step}"` : ''} value="${escapeHtml(state.valueInput)}">`;
}

function stateDot(state) {
  if (state.dataType !== 'boolean') return 'ms-status-dot is-unknown';
  return `ms-status-dot ${state.value ? 'is-on' : 'is-off'}`;
}

function renderStateRow(state) {
  return `              <div class="custom-state-row" data-state-id="${state.id}">
                <span class="widget-drag custom-state-drag" title="State verschieben" aria-hidden="true">⠿</span>
                <span class="${stateDot(state)}" aria-hidden="true"></span>
                <span class="custom-state-name">${escapeHtml(state.name)}</span>
                <code class="custom-state-topic">${escapeHtml(state.topic)}</code>
                <span class="custom-state-type">${escapeHtml(TYPE_LABELS[state.dataType] || state.dataType)}${state.unit ? ` · ${escapeHtml(state.unit)}` : ''}</span>
                <span class="custom-state-editor">${stateValueControl(state)}<button type="button" class="custom-value-save" onclick="saveCustomValue(${state.id})">Setzen</button></span>
                <span class="widget-actions">
                  <button type="button" class="widget-icon-btn" title="State bearbeiten" onclick="openStateDialog('edit', ${state.id})">✎</button>
                  <button type="button" class="widget-icon-btn" title="State entfernen" onclick="openDeleteStateDialog(${state.id})">🗑</button>
                </span>
              </div>`;
}

function renderStateDropzone(states, folderId) {
  const rows = states.length ? `\n${states.map(renderStateRow).join('\n')}\n            ` : '';
  return `<div class="custom-state-dropzone" data-folder-id="${folderId == null ? '' : folderId}">${rows}</div>`;
}

function renderFolder(folder) {
  const children = folder.folders.map(renderFolder).join('\n');
  return `          <div class="ms-group custom-folder" data-folder-id="${folder.id}" data-parent-id="${folder.parentId == null ? '' : folder.parentId}" data-custom-tree-key="folder-${folder.id}">
            <div class="ms-group-head custom-folder-head" role="button" tabindex="0" aria-expanded="false">
              <span class="ms-caret" aria-hidden="true">▸</span>
              <span class="widget-drag ms-group-drag custom-folder-drag" title="Verzeichnis verschieben" aria-hidden="true">⠿</span>
              <span class="ms-group-title">${escapeHtml(folder.name)}</span>
              <span class="ms-group-count">${folder.stateCount}</span>
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Unterverzeichnis anlegen" onclick="event.stopPropagation(); openFolderDialog('add', null, ${folder.id})">+📁</button>
                <button type="button" class="widget-icon-btn" title="State anlegen" onclick="event.stopPropagation(); openStateDialog('add', null, ${folder.id})">+S</button>
                <button type="button" class="widget-icon-btn" title="Verzeichnis bearbeiten" onclick="event.stopPropagation(); openFolderDialog('edit', ${folder.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Verzeichnis entfernen" onclick="event.stopPropagation(); openDeleteFolderDialog(${folder.id})">🗑</button>
              </div>
            </div>
            <div class="ms-group-body custom-folder-body">
              ${renderStateDropzone(folder.states, folder.id)}
              <div class="ms-subgroups custom-folder-zone" data-parent-id="${folder.id}">${children}</div>
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

function deleteDialog(id, title, text, confirmation, formId) {
  return `<dialog id="${id}" class="value-dialog"><form id="${formId}" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(text)}</p></div></div>
    <p class="error-text">${escapeHtml(confirmation)}</p>
    <div class="button-row"><button type="submit" class="button-danger">Endgültig entfernen</button><button type="button" class="secondary-button" onclick="document.getElementById('${id}').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function renderCustomStates({ tree, folders = [], states = [], error = '', message = '', initialDialog = null } = {}) {
  const rootStates = Array.isArray(tree && tree.states) ? tree.states : [];
  const rootFolders = Array.isArray(tree && tree.folders) ? tree.folders : [];
  const safeFolders = JSON.stringify(folders).replace(/</g, '\\u003c');
  const safeStates = JSON.stringify(states).replace(/</g, '\\u003c');
  const safeInitialDialog = JSON.stringify(initialDialog).replace(/</g, '\\u003c');

  const body = `        <div class="panel-head">
          <div><h1>Custom States</h1></div>
          <div class="dashboard-toolbar"><button type="button" class="secondary-button" onclick="openFolderDialog('add')">Verzeichnis hinzufügen</button><button type="button" class="secondary-button" onclick="openStateDialog('add')">State hinzufügen</button></div>
        </div>
        ${statusText(error)}${statusText(message, 'success')}
        <div class="ms-groups custom-states-groups" id="customStatesContainer">
          <div class="custom-folder-zone custom-root-folder-zone" data-parent-id="">${rootFolders.map(renderFolder).join('\n')}</div>
          <div class="ms-group ms-group--ungrouped custom-root-group">
            <div class="ms-group-head ms-group-head--static"><span class="ms-group-title">Ohne Verzeichnis</span><span class="ms-group-count" id="custom-root-count">${rootStates.length}</span></div>
            <div class="ms-group-body">${renderStateDropzone(rootStates, null)}</div>
          </div>
        </div>

        <dialog id="customFolderDialog" class="value-dialog"><form id="customFolderForm" method="POST" class="dialog-form">
          <div class="dialog-hero"><div><h3 id="customFolderTitle">Verzeichnis hinzufügen</h3><p class="muted">Name und Position im Verzeichnisbaum können jederzeit geändert werden.</p></div></div>
          <p id="customFolderDialogError" class="error-text" hidden></p>
          <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
            <label class="field-block"><span>Name</span><input id="customFolderName" name="name" required maxlength="100"></label>
            <label class="field-block"><span>Übergeordnetes Verzeichnis</span><select id="customFolderParent" name="parentId">${folderOptions(folders)}</select></label>
          </div></div>
          <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('customFolderDialog').close()">Abbrechen</button></div>
        </form></dialog>

        <dialog id="customStateDialog" class="value-dialog"><form id="customStateForm" method="POST" class="dialog-form">
          <div class="dialog-hero"><div><h3 id="customStateTitle">State hinzufügen</h3><p class="muted">Definition, Ablage und aktueller Wert lassen sich vollständig bearbeiten.</p></div></div>
          <p id="customStateDialogError" class="error-text" hidden></p>
          <div class="dialog-section"><div class="dialog-section-head"><h4>Zuordnung</h4></div><div class="dialog-grid dialog-grid--two">
            <label class="field-block"><span>Name</span><input id="customStateName" name="name" required maxlength="100"></label>
            <label class="field-block"><span>Verzeichnis</span><select id="customStateFolder" name="folderId">${folderOptions(folders)}</select></label>
            <label class="field-block"><span>Datentyp</span><select id="customStateType" name="dataType" onchange="syncCustomTypeFields()"><option value="boolean">Boolean</option><option value="integer">Integer</option><option value="float">Floating Point</option><option value="text">Text</option><option value="json">JSON</option></select></label>
            <label class="field-block"><span>Einheitszeichen <span class="pool-optional">(optional)</span></span><input id="customStateUnit" name="unit" maxlength="24" placeholder="z. B. °C, kWh, %"></label>
          </div></div>
          <div class="dialog-section"><div class="dialog-section-head"><h4>Wert und Formatierung</h4></div><div class="dialog-grid dialog-grid--two">
            <label class="field-block custom-state-value-field"><span>Wert</span><input id="customStateValue" name="value"><select id="customStateBoolean"><option value="false">Aus</option><option value="true">Ein</option></select><textarea id="customStateJson" rows="5" spellcheck="false"></textarea></label>
            <div id="customRoundingFields" class="custom-rounding-fields">
              <label class="field-block"><span>Nachkommastellen <span class="pool-optional">(leer = unverändert)</span></span><input id="customStateDecimals" name="decimals" type="number" min="0" max="12"></label>
              <label class="field-block"><span>Rundungsverhalten</span><select id="customStateRounding" name="rounding"><option value="nearest">Kaufmännisch</option><option value="floor">Abrunden</option><option value="ceil">Aufrunden</option><option value="trunc">Abschneiden</option></select></label>
            </div>
          </div></div>
          <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('customStateDialog').close()">Abbrechen</button></div>
        </form></dialog>

        ${deleteDialog('customDeleteFolderDialog', 'Verzeichnis entfernen', 'Das Verzeichnis und sein gesamter Unterbau werden gelöscht.', 'Alle enthaltenen Unterverzeichnisse und States gehen dauerhaft verloren.', 'customDeleteFolderForm')}
        ${deleteDialog('customDeleteStateDialog', 'State entfernen', 'Der Custom State wird dauerhaft gelöscht.', 'Alle Verknüpfungen auf sein custom://-Topic verlieren damit ihre Quelle.', 'customDeleteStateForm')}`;

  const script = `
    var customFolders = ${safeFolders};
    var customStates = ${safeStates};
    var customInitialDialog = ${safeInitialDialog};
    var CUSTOM_TREE_KEY = 'homeess.custom-states.expanded.v1';
    var CUSTOM_STATE_FOLDER_KEY = 'homeess.custom-states.last-state-folder.v1';
    var CUSTOM_STATE_TYPE_KEY = 'homeess.custom-states.last-state-type.v1';
    var CUSTOM_FOLDER_PARENT_KEY = 'homeess.custom-states.last-folder-parent.v1';
    var customStateDialogMode = 'add', customFolderDialogMode = 'add';
    var draggedCustomState = null, customStateDropzone = null, customStateDropRef = null;
    var draggedCustomFolder = null, customFolderDropzone = null, customFolderDropRef = null;
    var customLayoutSaving = false;

    function customStored(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } }
    function customRemember(key, value) { try { localStorage.setItem(key, value == null ? '' : String(value)); } catch (_) {} }
    function customSelectHasValue(select, value) { if (!select) return false; for (var i = 0; i < select.options.length; i++) if (select.options[i].value === String(value)) return true; return false; }
    function customStoredChoice(select, key, fallback) { var stored = customStored(key); if (customSelectHasValue(select, stored)) return stored; return customSelectHasValue(select, fallback) ? String(fallback) : ''; }
    function customExpanded() { try { return JSON.parse(localStorage.getItem(CUSTOM_TREE_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function customFolder(id) { for (var i = 0; i < customFolders.length; i++) if (customFolders[i].id === Number(id)) return customFolders[i]; return null; }
    function customState(id) { for (var i = 0; i < customStates.length; i++) if (customStates[i].id === Number(id)) return customStates[i]; return null; }

    function customSaveOpenState() {
      var values = {};
      document.querySelectorAll('[data-custom-tree-key]').forEach(function (folder) { values[folder.dataset.customTreeKey] = folder.classList.contains('is-open'); });
      try { localStorage.setItem(CUSTOM_TREE_KEY, JSON.stringify(values)); } catch (_) {}
    }
    function restoreCustomFolders() {
      var values = customExpanded();
      document.querySelectorAll('[data-custom-tree-key]').forEach(function (folder) {
        var open = values[folder.dataset.customTreeKey] === true;
        folder.classList.toggle('is-open', open);
        var head = folder.querySelector(':scope > .custom-folder-head');
        if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    function toggleCustomFolder(head) {
      var folder = head.parentNode; var open = folder.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false'); customSaveOpenState();
    }

    function customFolderIsDescendant(candidateId, ancestorId) {
      var cursor = customFolder(candidateId); var seen = {};
      while (cursor && cursor.parentId != null && !seen[cursor.id]) {
        if (cursor.parentId === Number(ancestorId)) return true;
        seen[cursor.id] = true; cursor = customFolder(cursor.parentId);
      }
      return false;
    }
    function prepareFolderParentOptions(folderId) {
      var select = document.getElementById('customFolderParent');
      for (var i = 0; i < select.options.length; i++) {
        var id = Number(select.options[i].value);
        select.options[i].disabled = !!select.options[i].value && (id === Number(folderId) || customFolderIsDescendant(id, folderId));
      }
    }
    function openFolderDialog(mode, id, parentId) {
      var form = document.getElementById('customFolderForm'); var item = customFolder(id);
      customFolderDialogMode = mode; prepareFolderParentOptions(mode === 'edit' ? id : null);
      form.action = mode === 'edit' ? '/states/custom/folder/' + id : '/states/custom/folder';
      document.getElementById('customFolderTitle').textContent = mode === 'edit' ? 'Verzeichnis bearbeiten' : 'Verzeichnis hinzufügen';
      document.getElementById('customFolderName').value = item ? item.name : '';
      var parentSelect = document.getElementById('customFolderParent');
      parentSelect.value = item && item.parentId != null ? String(item.parentId)
        : item ? '' : parentId != null ? String(parentId) : customStoredChoice(parentSelect, CUSTOM_FOLDER_PARENT_KEY, '');
      document.getElementById('customFolderDialog').showModal();
    }

    function syncCustomTypeFields() {
      var type = document.getElementById('customStateType').value;
      var text = document.getElementById('customStateValue'); var bool = document.getElementById('customStateBoolean'); var json = document.getElementById('customStateJson');
      text.style.display = type === 'boolean' || type === 'json' ? 'none' : '';
      bool.style.display = type === 'boolean' ? '' : 'none'; json.style.display = type === 'json' ? '' : 'none';
      text.name = type !== 'boolean' && type !== 'json' ? 'value' : '';
      bool.name = type === 'boolean' ? 'value' : ''; json.name = type === 'json' ? 'value' : '';
      text.type = type === 'integer' || type === 'float' ? 'number' : 'text'; text.step = type === 'integer' ? '1' : type === 'float' ? 'any' : '';
      document.getElementById('customRoundingFields').style.display = type === 'float' ? 'contents' : 'none';
    }
    function openStateDialog(mode, id, folderId) {
      var form = document.getElementById('customStateForm'); var item = customState(id);
      customStateDialogMode = mode; form.action = mode === 'edit' ? '/states/custom/state/' + id : '/states/custom/state';
      document.getElementById('customStateTitle').textContent = mode === 'edit' ? 'Custom State bearbeiten' : 'State hinzufügen';
      document.getElementById('customStateName').value = item ? item.name : '';
      var folderSelect = document.getElementById('customStateFolder');
      folderSelect.value = item && item.folderId != null ? String(item.folderId) : folderId != null ? String(folderId) : customStoredChoice(folderSelect, CUSTOM_STATE_FOLDER_KEY, '');
      var typeSelect = document.getElementById('customStateType'); typeSelect.value = item ? item.dataType : customStoredChoice(typeSelect, CUSTOM_STATE_TYPE_KEY, 'text');
      document.getElementById('customStateValue').value = item && item.dataType !== 'json' ? item.valueInput : '';
      document.getElementById('customStateJson').value = item && item.dataType === 'json' ? item.valueInput : '';
      document.getElementById('customStateBoolean').value = item && item.value === true ? 'true' : 'false';
      document.getElementById('customStateUnit').value = item ? item.unit : '';
      document.getElementById('customStateDecimals').value = item && item.decimals != null ? item.decimals : '';
      document.getElementById('customStateRounding').value = item ? item.rounding : 'nearest';
      syncCustomTypeFields(); document.getElementById('customStateDialog').showModal();
    }
    function openDeleteFolderDialog(id) { var item = customFolder(id); document.getElementById('customDeleteFolderForm').action = '/states/custom/folder/' + id + '/delete'; document.querySelector('#customDeleteFolderDialog h3').textContent = '„' + (item ? item.name : 'Verzeichnis') + '“ entfernen'; document.getElementById('customDeleteFolderDialog').showModal(); }
    function openDeleteStateDialog(id) { var item = customState(id); document.getElementById('customDeleteStateForm').action = '/states/custom/state/' + id + '/delete'; document.querySelector('#customDeleteStateDialog h3').textContent = '„' + (item ? item.name : 'State') + '“ entfernen'; document.getElementById('customDeleteStateDialog').showModal(); }

    function saveCustomValue(id) {
      var input = document.getElementById('custom-value-' + id); var button = input && input.parentNode.querySelector('.custom-value-save');
      if (!input) return; if (button) button.disabled = true;
      fetch('/states/custom/state/' + id + '/value', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ value: input.value }) })
        .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Wert konnte nicht gesetzt werden.'); return data; }); })
        .then(function (data) { input.value = data.valueInput; })
        .catch(function (err) { alert(err.message); })
        .finally(function () { if (button) button.disabled = false; });
    }

    function directChildren(zone, selector) { return Array.prototype.filter.call(zone.children, function (child) { return child.matches(selector); }); }
    function insertionReference(zone, selector, dragged, y) {
      var items = directChildren(zone, selector).filter(function (item) { return item !== dragged; });
      for (var i = 0; i < items.length; i++) { var box = items[i].getBoundingClientRect(); if (y < box.top + box.height / 2) return items[i]; }
      return null;
    }
    function clearCustomDropIndicators() {
      document.querySelectorAll('.custom-drop-before, .custom-drop-after').forEach(function (node) { node.classList.remove('custom-drop-before', 'custom-drop-after'); });
      document.querySelectorAll('.custom-drag-over').forEach(function (node) { node.classList.remove('custom-drag-over'); });
    }
    function markDrop(zone, ref, selector) {
      clearCustomDropIndicators(); zone.classList.add('custom-drag-over');
      if (ref) ref.classList.add('custom-drop-before'); else { var items = directChildren(zone, selector).filter(function (item) { return item !== draggedCustomState && item !== draggedCustomFolder; }); if (items.length) items[items.length - 1].classList.add('custom-drop-after'); }
    }

    function setupStateDropzone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedCustomState) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        customStateDropzone = zone; customStateDropRef = insertionReference(zone, '.custom-state-row', draggedCustomState, event.clientY); markDrop(zone, customStateDropRef, '.custom-state-row');
      });
      zone.addEventListener('drop', function (event) {
        if (!draggedCustomState) return; event.preventDefault(); event.stopPropagation();
        if (customStateDropRef) zone.insertBefore(draggedCustomState, customStateDropRef); else zone.appendChild(draggedCustomState);
      });
    }
    function setupCustomState(row) {
      var handle = row.querySelector('.custom-state-drag');
      handle.addEventListener('mousedown', function () { row.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', function () { row.removeAttribute('draggable'); });
      row.addEventListener('dragstart', function (event) { event.stopPropagation(); draggedCustomState = row; customStateDropzone = null; customStateDropRef = null; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'state:' + row.dataset.stateId); });
      row.addEventListener('dragend', function (event) { event.stopPropagation(); row.classList.remove('dragging'); row.removeAttribute('draggable'); draggedCustomState = null; customStateDropzone = null; customStateDropRef = null; clearCustomDropIndicators(); persistCustomLayout(); });
    }

    function folderCanEnter(folder, zone) { var owner = zone.closest('.custom-folder'); return !owner || (owner !== folder && !folder.contains(owner)); }
    function setupFolderZone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedCustomFolder || !folderCanEnter(draggedCustomFolder, zone)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        customFolderDropzone = zone; customFolderDropRef = insertionReference(zone, '.custom-folder', draggedCustomFolder, event.clientY); markDrop(zone, customFolderDropRef, '.custom-folder');
      });
      zone.addEventListener('drop', function (event) {
        if (!draggedCustomFolder || !folderCanEnter(draggedCustomFolder, zone)) return; event.preventDefault(); event.stopPropagation();
        if (customFolderDropRef) zone.insertBefore(draggedCustomFolder, customFolderDropRef); else zone.appendChild(draggedCustomFolder);
      });
    }
    function setupCustomFolder(folder) {
      var head = folder.querySelector(':scope > .custom-folder-head'); var handle = head.querySelector('.custom-folder-drag');
      head.addEventListener('click', function (event) { if (!event.target.closest('.widget-group-actions, .custom-folder-drag')) toggleCustomFolder(head); });
      head.addEventListener('keydown', function (event) { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.widget-group-actions')) { event.preventDefault(); toggleCustomFolder(head); } });
      head.addEventListener('dragover', function (event) {
        if (draggedCustomState) { event.preventDefault(); event.stopPropagation(); customStateDropzone = folder.querySelector(':scope > .custom-folder-body > .custom-state-dropzone'); customStateDropRef = null; markDrop(head, null, '.custom-state-row'); head.classList.add('custom-drag-over'); return; }
        if (!draggedCustomFolder || draggedCustomFolder === folder || draggedCustomFolder.contains(folder)) return;
        event.preventDefault(); event.stopPropagation(); customFolderDropzone = folder.querySelector(':scope > .custom-folder-body > .custom-folder-zone'); customFolderDropRef = null; clearCustomDropIndicators(); head.classList.add('custom-drag-over');
      });
      head.addEventListener('drop', function (event) {
        if (draggedCustomState && customStateDropzone) { event.preventDefault(); event.stopPropagation(); customStateDropzone.appendChild(draggedCustomState); folder.classList.add('is-open'); return; }
        if (draggedCustomFolder && customFolderDropzone) { event.preventDefault(); event.stopPropagation(); customFolderDropzone.appendChild(draggedCustomFolder); folder.classList.add('is-open'); }
      });
      handle.addEventListener('mousedown', function () { folder.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', function () { folder.removeAttribute('draggable'); });
      folder.addEventListener('dragstart', function (event) { event.stopPropagation(); draggedCustomFolder = folder; customFolderDropzone = null; customFolderDropRef = null; folder.classList.add('group-dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'folder:' + folder.dataset.folderId); });
      folder.addEventListener('dragend', function (event) { event.stopPropagation(); folder.classList.remove('group-dragging'); folder.removeAttribute('draggable'); draggedCustomFolder = null; customFolderDropzone = null; customFolderDropRef = null; clearCustomDropIndicators(); customSaveOpenState(); persistCustomLayout(); });
    }

    function customLayoutPayload() {
      var folders = [], states = [];
      document.querySelectorAll('.custom-folder-zone').forEach(function (zone) {
        var parentId = zone.dataset.parentId ? Number(zone.dataset.parentId) : null;
        directChildren(zone, '.custom-folder').forEach(function (folder, position) { folders.push({ id: Number(folder.dataset.folderId), parentId: parentId, position: position }); });
      });
      document.querySelectorAll('.custom-state-dropzone').forEach(function (zone) {
        var folderId = zone.dataset.folderId ? Number(zone.dataset.folderId) : null;
        directChildren(zone, '.custom-state-row').forEach(function (state, position) { states.push({ id: Number(state.dataset.stateId), folderId: folderId, position: position }); });
      });
      return { folders: folders, states: states };
    }
    function persistCustomLayout() {
      if (customLayoutSaving) return; customLayoutSaving = true;
      fetch('/states/custom/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(customLayoutPayload()) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Layout konnte nicht gespeichert werden.'); return data; }); })
        .then(function () { window.location.reload(); })
        .catch(function (error) { alert(error.message); window.location.reload(); });
    }

    function initCustomInteractions() {
      document.querySelectorAll('.custom-state-row').forEach(setupCustomState);
      document.querySelectorAll('.custom-state-dropzone').forEach(setupStateDropzone);
      document.querySelectorAll('.custom-folder-zone').forEach(setupFolderZone);
      document.querySelectorAll('.custom-folder').forEach(setupCustomFolder);
    }
    document.getElementById('customStateForm').addEventListener('submit', function () { if (customStateDialogMode === 'add') { customRemember(CUSTOM_STATE_FOLDER_KEY, document.getElementById('customStateFolder').value); customRemember(CUSTOM_STATE_TYPE_KEY, document.getElementById('customStateType').value); } });
    document.getElementById('customFolderForm').addEventListener('submit', function () { if (customFolderDialogMode === 'add') customRemember(CUSTOM_FOLDER_PARENT_KEY, document.getElementById('customFolderParent').value); });
    restoreCustomFolders(); window.addEventListener('pageshow', restoreCustomFolders); syncCustomTypeFields(); initCustomInteractions();
    if (customInitialDialog && customInitialDialog.kind === 'folder') {
      openFolderDialog(customInitialDialog.mode || 'add', customInitialDialog.id || null, customInitialDialog.parentId);
      var fv = customInitialDialog.values || {}; document.getElementById('customFolderName').value = fv.name || '';
      if (customSelectHasValue(document.getElementById('customFolderParent'), fv.parentId == null ? '' : fv.parentId)) document.getElementById('customFolderParent').value = fv.parentId == null ? '' : String(fv.parentId);
      var fe = document.getElementById('customFolderDialogError'); fe.textContent = customInitialDialog.error || ''; fe.hidden = !fe.textContent;
    }
    if (customInitialDialog && customInitialDialog.kind === 'state') {
      openStateDialog(customInitialDialog.mode || 'add', customInitialDialog.id || null, customInitialDialog.folderId);
      var sv = customInitialDialog.values || {};
      document.getElementById('customStateName').value = sv.name || '';
      if (customSelectHasValue(document.getElementById('customStateFolder'), sv.folderId == null ? '' : sv.folderId)) document.getElementById('customStateFolder').value = sv.folderId == null ? '' : String(sv.folderId);
      document.getElementById('customStateType').value = sv.dataType || 'text'; document.getElementById('customStateUnit').value = sv.unit || '';
      document.getElementById('customStateValue').value = sv.value == null ? '' : String(sv.value); document.getElementById('customStateJson').value = sv.value == null ? '' : String(sv.value); document.getElementById('customStateBoolean').value = String(sv.value) === 'true' ? 'true' : 'false';
      document.getElementById('customStateDecimals').value = sv.decimals == null ? '' : sv.decimals; document.getElementById('customStateRounding').value = sv.rounding || 'nearest'; syncCustomTypeFields();
      var se = document.getElementById('customStateDialogError'); se.textContent = customInitialDialog.error || ''; se.hidden = !se.textContent;
    }
  `;
  return renderLayout({ title: 'Custom States', activePath: '/states/custom', body, script });
}

module.exports = renderCustomStates;
