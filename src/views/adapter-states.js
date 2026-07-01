'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { rowKey } = require('../adapters/state-editor');

function keyFieldsOf(editor) {
  return editor.keyFields && editor.keyFields.length ? editor.keyFields : [editor.keyField];
}
function keyHeader(editor) {
  const byKey = new Map(editor.columns.map((c) => [c.key, c.label]));
  return keyFieldsOf(editor).map((k) => byKey.get(k) || k).join(' / ');
}
// Kategorie-Feld nur, wenn deklariert UND als Spalte vorhanden.
function categoryFieldOf(editor) {
  return editor.categoryField && editor.columns.some((c) => c.key === editor.categoryField)
    ? editor.categoryField
    : null;
}

// Verwaltungs-Unterseite für die Live-States einer Adapter-Instanz (generisch aus
// dem stateEditor-Schema). Angelegte States nach Kategorie gruppiert und einklappbar,
// Anlegen/Bearbeiten in einem Dialog. Presets liegen auf einer eigenen Seite.

function renderColumnField(column, value) {
  const id = `col-${escapeHtml(column.key)}`;
  const req = column.required ? ' required' : '';
  let control;
  if (column.type === 'checkbox') {
    const checked = value === true || value === 'true' || value === 1 || value === '1';
    control = `<input type="checkbox" id="${id}" name="${escapeHtml(column.key)}" value="1"${checked ? ' checked' : ''}>`;
    return `                <label class="field-block" style="flex-direction:row; align-items:center; gap:8px;">${control}<span>${escapeHtml(column.label)}</span></label>`;
  }
  if (column.type === 'select') {
    const opts = column.options.map((o) => `<option value="${escapeHtml(o.value)}"${String(value) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    control = `<select id="${id}" name="${escapeHtml(column.key)}"${req}>${opts}</select>`;
  } else {
    const type = column.type === 'number' ? 'number' : 'text';
    const step = column.type === 'number' ? ' step="any"' : '';
    control = `<input type="${type}"${step} id="${id}" name="${escapeHtml(column.key)}" value="${escapeHtml(value == null ? '' : value)}"${req} data-no-state-picker>`;
  }
  return `                <label class="field-block" for="${id}"><span>${escapeHtml(column.label)}${column.required ? ' *' : ''}</span>${control}${column.hint ? `<small>${escapeHtml(column.hint)}</small>` : ''}</label>`;
}

// Eine Tabelle für eine Menge Zeilen (Gruppierung/Leer-Fall erledigt der Aufrufer).
function renderRowsTable(editor, rows, detailCols) {
  const body = rows.map((row) => {
    const key = rowKey(row, editor);
    const details = detailCols
      .map((c) => `${escapeHtml(c.label)}: ${escapeHtml(row[c.key] === '' || row[c.key] == null ? '–' : row[c.key])}`)
      .join(' · ');
    return `                <tr>
                  <td><code>${escapeHtml(key)}</code></td>
                  <td>${escapeHtml(row[editor.nameField] == null ? '' : row[editor.nameField])}</td>
                  <td class="muted" style="font-size:12px;">${details}</td>
                  <td style="white-space:nowrap;">
                    <button type="button" class="module-toggle-btn" onclick="editRow('${escapeHtml(key)}')">Bearbeiten</button>
                    <button type="button" class="module-toggle-btn button-danger" onclick="deleteRow('${escapeHtml(key)}')">Löschen</button>
                  </td>
                </tr>`;
  }).join('\n');
  return `            <table class="states-edit-table">
              <thead><tr><th>${escapeHtml(keyHeader(editor))}</th><th>${escapeHtml(editor.nameField)}</th><th>Details</th><th></th></tr></thead>
              <tbody>
${body}
              </tbody>
            </table>`;
}

// Angelegte States: nach Kategorie gruppiert und einklappbar (falls categoryField),
// sonst eine einzelne Tabelle.
function renderRowGroups(editor, rows) {
  if (!rows.length) {
    return '<p class="muted">Noch keine States angelegt. Lege welche an oder übernimm ein Preset.</p>';
  }
  const keySet = new Set(keyFieldsOf(editor));
  const catField = categoryFieldOf(editor);
  // Kategorie steckt in der Gruppen-Überschrift → aus den Detail-Spalten nehmen.
  const detailCols = editor.columns.filter((c) => !keySet.has(c.key) && c.key !== editor.nameField && c.key !== catField);

  if (!catField) return renderRowsTable(editor, rows, detailCols);

  const groups = new Map();
  for (const row of rows) {
    const cat = row[catField] == null || row[catField] === '' ? 'Allgemein' : String(row[catField]);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(row);
  }
  return Array.from(groups.keys())
    .sort((a, b) => a.localeCompare(b, 'de'))
    .map((cat) => {
      const groupRows = groups.get(cat);
      return `          <details class="state-cat" open>
            <summary><span class="state-cat-name">${escapeHtml(cat)}</span><span class="state-cat-count">${groupRows.length}</span></summary>
${renderRowsTable(editor, groupRows, detailCols)}
          </details>`;
    }).join('\n');
}

// Dialog zum Anlegen/Bearbeiten eines States. Bei Validierungsfehler serverseitig
// vorbefüllt wieder geöffnet (dialogOpen), damit die Eingaben nicht verloren gehen.
function renderStateDialog(instance, editor, { dialogOpen, dialogError, dialogValues, dialogOriginalKey }) {
  const values = dialogOpen && dialogValues ? dialogValues : null;
  const fieldOf = (c) => renderColumnField(c, values && Object.prototype.hasOwnProperty.call(values, c.key) ? values[c.key] : c.default);
  const fields = editor.columns.map(fieldOf).join('\n');
  const title = values && dialogOriginalKey
    ? `Bearbeiten: ${escapeHtml(dialogOriginalKey)}`
    : `${escapeHtml(editor.label)} anlegen`;
  return `        <dialog id="stateDialog" class="value-dialog">
          <form id="stateForm" method="POST" action="/adapter/instance/${instance.id}/states/save" class="dialog-form">
            <h3 id="stateDialogTitle">${title}</h3>
            ${dialogOpen && dialogError ? statusText(dialogError) : ''}
            <input type="hidden" name="originalKey" id="originalKey" value="${values ? escapeHtml(dialogOriginalKey) : ''}">
            <div class="dialog-grid dialog-grid--two">
${fields}
            </div>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeStateDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderAdapterStates({ adapter, instance, editor, rows = [], message = '', error = '', dialogOpen = false, dialogError = '', dialogValues = null, dialogOriginalKey = '' } = {}) {
  const rowsJson = JSON.stringify(rows).replace(/</g, '\\u003c');
  const presetsLink = editor.presets
    ? `<a href="/adapter/instance/${instance.id}/presets" class="module-toggle-btn">Presets</a>`
    : '';

  const body = `        <h1>${escapeHtml(adapter.name)} – ${escapeHtml(instance.name)}: ${escapeHtml(editor.label)}</h1>
        <p class="muted" style="margin-bottom:16px;">Adresse: <code>${escapeHtml(adapter.prefix)}://${escapeHtml(instance.name)}/</code> · <a href="/adapter/instance/${instance.id}">Einstellungen</a></p>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}

        <div class="settings-card">
          <div class="settings-card-head" style="display:flex; gap:12px; align-items:center;">
            <h2 style="flex:1;">Angelegte States</h2>
            ${presetsLink}
            <button type="button" onclick="openStateDialog('add')">${escapeHtml(editor.label)} anlegen</button>
          </div>
${renderRowGroups(editor, rows)}
        </div>

${renderStateDialog(instance, editor, { dialogOpen, dialogError, dialogValues, dialogOriginalKey })}

        <form method="POST" action="/adapter/instance/${instance.id}/states/delete" id="deleteForm" style="display:none;">
          <input type="hidden" name="key" id="deleteKey">
        </form>`;

  const script = `
    var EDITOR_ROWS = ${rowsJson};
    var EDITOR_KEYFIELDS = ${JSON.stringify(keyFieldsOf(editor))};
    var EDITOR_COLS = ${JSON.stringify(editor.columns.map((c) => ({ key: c.key, type: c.type })))};
    var EDITOR_LABEL = ${JSON.stringify(editor.label)};
    var DIALOG_OPEN = ${dialogOpen ? 'true' : 'false'};

    function rowKeyOf(r) {
      return EDITOR_KEYFIELDS.map(function (f) { return String(r[f] == null ? '' : r[f]).trim(); })
        .filter(function (s) { return s !== ''; }).join('/');
    }
    function setField(col, value) {
      var el = document.getElementById('col-' + col.key);
      if (!el) return;
      if (col.type === 'checkbox') el.checked = (value === true || value === 'true' || value === 1 || value === '1');
      else el.value = (value == null ? '' : value);
    }
    function openStateDialog(mode, key) {
      var dialog = document.getElementById('stateDialog');
      var title = document.getElementById('stateDialogTitle');
      if (mode === 'edit' && key != null) {
        var row = EDITOR_ROWS.find(function (r) { return rowKeyOf(r) === String(key); });
        if (!row) return;
        EDITOR_COLS.forEach(function (col) { setField(col, row[col.key]); });
        document.getElementById('originalKey').value = key;
        title.textContent = 'Bearbeiten: ' + key;
      } else {
        EDITOR_COLS.forEach(function (col) {
          var el = document.getElementById('col-' + col.key);
          if (!el) return;
          if (col.type === 'checkbox') el.checked = false; else el.value = '';
        });
        document.getElementById('originalKey').value = '';
        title.textContent = EDITOR_LABEL + ' anlegen';
      }
      if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeStateDialog() { var d = document.getElementById('stateDialog'); if (d) d.close(); }
    function editRow(key) { openStateDialog('edit', key); }
    function deleteRow(key) {
      if (!confirm('State „' + key + '" löschen?')) return;
      document.getElementById('deleteKey').value = key;
      document.getElementById('deleteForm').submit();
    }
    // Nach Validierungsfehler serverseitig vorbefüllt wieder öffnen.
    if (DIALOG_OPEN) {
      var d = document.getElementById('stateDialog');
      if (d && typeof d.showModal === 'function') d.showModal();
    }
  `;

  return renderLayout({ title: `${adapter.name} – ${editor.label}`, activePath: '/adapter', body, script });
}

// Eigene Preset-Seite: Vorlagen laden, aktuelle States als Preset speichern, Upload.
function renderAdapterPresets({ adapter, instance, editor, presets = [], hasRows = false, message = '', error = '' } = {}) {
  const list = presets.length
    ? presets.map((p) => `            <div class="adapter-instance-row" style="display:flex; align-items:center; gap:8px; padding:8px 0; border-top:1px solid rgba(0,0,0,0.08);">
              <span style="flex:1;"><strong>${escapeHtml(p.name)}</strong>${p.device ? ` <span class="muted">(${escapeHtml(p.device)})</span>` : ''}<br><span class="muted" style="font-size:0.85em;">${p.count} Einträge${p.description ? ' · ' + escapeHtml(p.description) : ''}</span></span>
              <a class="module-toggle-btn" href="/adapter/instance/${instance.id}/presets/${encodeURIComponent(p.file)}">Laden …</a>
            </div>`).join('\n')
    : '            <p class="muted">Keine Presets im Verzeichnis <code>presets/</code> gefunden.</p>';

  const body = `        <h1>${escapeHtml(adapter.name)} – ${escapeHtml(instance.name)}: Presets</h1>
        <p class="muted" style="margin-bottom:16px;">Presets sind Vorlagen. Beim Laden wählst du, welche Einträge als States in dieser Instanz angelegt werden. · <a href="/adapter/instance/${instance.id}/states">Zurück zu ${escapeHtml(editor.label)}</a></p>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}

        <div class="settings-card">
          <div class="settings-card-head"><h2>Verfügbare Presets</h2></div>
          <div class="adapter-instances">
${list}
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-card-head">
            <h2>Preset erstellen</h2>
            <p class="settings-card-hint">Aktuelle States als Preset sichern oder eine Preset-Datei vom PC hochladen.</p>
          </div>
          <div class="field-grid">
            <form method="POST" action="/adapter/instance/${instance.id}/presets/save" class="settings-form" style="display:flex; gap:8px; align-items:flex-end;">
              <label class="field-block" style="flex:1;"><span>Aktuelle States als Preset speichern</span>
                <input type="text" name="name" placeholder="Preset-Name" required data-no-state-picker></label>
              <button type="submit"${hasRows ? '' : ' disabled title="Keine States vorhanden"'}>Speichern</button>
            </form>
            <div class="field-block">
              <span>Preset von PC hochladen (.json)</span>
              <div style="display:flex; gap:8px;">
                <input type="file" id="presetUpload" accept="application/json,.json" style="flex:1;">
                <button type="button" onclick="uploadPreset()">Hochladen</button>
              </div>
              <small class="muted" id="uploadMsg"></small>
            </div>
          </div>
        </div>`;

  const script = `
    function uploadPreset() {
      var input = document.getElementById('presetUpload');
      var msg = document.getElementById('uploadMsg');
      if (!input.files || !input.files[0]) { msg.textContent = 'Bitte eine Datei wählen.'; return; }
      var file = input.files[0];
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(reader.result); }
        catch (e) { msg.textContent = 'Keine gültige JSON-Datei.'; return; }
        fetch('/adapter/instance/${instance.id}/presets/upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: file.name, data: data })
        }).then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
          .then(function (res) {
            if (res && res.ok) window.location.reload();
            else msg.textContent = (res && res.error) || 'Upload fehlgeschlagen.';
          }).catch(function () { msg.textContent = 'Upload fehlgeschlagen.'; });
      };
      reader.readAsText(file);
    }
  `;

  return renderLayout({ title: `${adapter.name} – Presets`, activePath: '/adapter', body, script });
}

// Eine Tabelle von Preset-Einträgen (Checkbox + Schlüssel/Name/Details).
// data-search trägt den Suchindex je Zeile für die clientseitige Filterung.
function renderPresetRows(editor, entries) {
  return entries.map((e) => {
    const hay = `${e.key} ${e.name} ${e.category || ''} ${e.detail}`.toLowerCase();
    return `                <tr data-search="${escapeHtml(hay)}">
                  <td><input type="checkbox" name="keys" value="${escapeHtml(e.key)}" id="pk-${escapeHtml(e.key)}"></td>
                  <td><label for="pk-${escapeHtml(e.key)}"><code>${escapeHtml(e.key)}</code></label></td>
                  <td>${escapeHtml(e.name)}${e.exists ? ' <span class="module-status module-status--off">existiert</span>' : ''}</td>
                  <td class="muted" style="font-size:12px;">${escapeHtml(e.detail)}</td>
                </tr>`;
  }).join('\n');
}

function presetTable(editor, entries) {
  return `            <table class="states-edit-table">
              <thead><tr><th></th><th>${escapeHtml(keyHeader(editor))}</th><th>${escapeHtml(editor.nameField)}</th><th>Details</th></tr></thead>
              <tbody>
${renderPresetRows(editor, entries)}
              </tbody>
            </table>`;
}

// Auswahlseite beim Laden eines Presets: Einträge nach Kategorie gruppiert und
// eingeklappt, mit Suche. Standardmäßig ist alles abgewählt.
function renderPresetSelection({ adapter, instance, editor, file, presetName, entries = [], message = '', error = '' } = {}) {
  const hasCategories = entries.some((e) => e.category);
  let listMarkup;
  if (!hasCategories) {
    listMarkup = presetTable(editor, entries);
  } else {
    const groups = new Map();
    for (const e of entries) {
      const cat = e.category || 'Allgemein';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(e);
    }
    listMarkup = Array.from(groups.keys())
      .sort((a, b) => a.localeCompare(b, 'de'))
      .map((cat) => {
        const groupEntries = groups.get(cat);
        return `          <details class="state-cat">
            <summary><span class="state-cat-name">${escapeHtml(cat)}</span><span class="state-cat-count">${groupEntries.length}</span></summary>
${presetTable(editor, groupEntries)}
          </details>`;
      }).join('\n');
  }

  const body = `        <h1>Preset laden: ${escapeHtml(presetName)}</h1>
        <p class="muted" style="margin-bottom:16px;">Wähle die Einträge, die als States in <code>${escapeHtml(adapter.prefix)}://${escapeHtml(instance.name)}/</code> angelegt werden sollen.</p>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}
        <form method="POST" action="/adapter/instance/${instance.id}/presets/${encodeURIComponent(file)}/apply">
          <div class="settings-card">
            <div class="settings-card-head" style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
              <div class="button-row" style="margin:0;">
                <button type="submit">Ausgewählte übernehmen</button>
                <a href="/adapter/instance/${instance.id}/presets" class="module-toggle-btn">Abbrechen</a>
              </div>
              <label style="display:flex; gap:6px; align-items:center;"><input type="checkbox" id="overwrite" name="overwrite" value="1"> Vorhandene überschreiben</label>
              <button type="button" class="module-toggle-btn" onclick="toggleAll(this)">Alle sichtbaren</button>
              <input type="search" id="presetSearch" placeholder="Register suchen …" oninput="filterPresets(this.value)" data-no-state-picker style="flex:1; min-width:160px;">
            </div>
            <p class="muted" style="font-size:12px; margin:0 0 8px;">${entries.length} Einträge</p>
${listMarkup}
          </div>
        </form>`;

  const script = `
    function visibleBoxes() {
      return Array.prototype.filter.call(document.querySelectorAll('input[name="keys"]'), function (b) {
        var tr = b.closest('tr');
        var cat = b.closest('.state-cat');
        return tr && tr.style.display !== 'none' && (!cat || cat.style.display !== 'none');
      });
    }
    function toggleAll(btn) {
      var boxes = visibleBoxes();
      var anyOff = boxes.some(function (b) { return !b.checked; });
      boxes.forEach(function (b) { b.checked = anyOff; });
    }
    function filterPresets(term) {
      term = (term || '').trim().toLowerCase();
      var rows = document.querySelectorAll('tbody tr[data-search]');
      for (var i = 0; i < rows.length; i++) {
        var hay = rows[i].getAttribute('data-search') || '';
        rows[i].style.display = (!term || hay.indexOf(term) !== -1) ? '' : 'none';
      }
      var cats = document.querySelectorAll('.state-cat');
      for (var j = 0; j < cats.length; j++) {
        var visible = Array.prototype.some.call(cats[j].querySelectorAll('tbody tr[data-search]'), function (tr) { return tr.style.display !== 'none'; });
        cats[j].style.display = visible ? '' : 'none';
        cats[j].open = term ? visible : false; // beim Suchen Treffer aufklappen, sonst eingeklappt
      }
    }
  `;
  return renderLayout({ title: `Preset laden – ${presetName}`, activePath: '/adapter', body, script });
}

module.exports = { renderAdapterStates, renderAdapterPresets, renderPresetSelection };
