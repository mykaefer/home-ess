'use strict';

// CRUD für Dashboard-Widgets. Ein Widget ist eine **Wert-Kachel** (type 'value',
// zeigt einen internen Wert aus demselben Katalog wie die Outputs), ein
// **Schalter** (type 'switch', schaltet ein Gerät oder eine Schaltgruppe aus
// Messen + Schalten) oder eine **Info-Kachel** (type 'info', zeigt ausgewählte
// System-Informationen). Widgets können einer Gruppe zugeordnet (group_id) und
// per Drag&Drop angeordnet werden (position). Gruppenlose Widgets tragen ihre
// Tab-Zuordnung selbst (tab_id); Widgets in Gruppen erben den Tab der Gruppe.
// Typ-spezifische Optionen liegen als JSON in `config`.

const { sanitizeFields } = require('./system-info');
const {
  WIDGET_TYPES,
  widgetTypeDef,
  normalizeSize,
  normalizeColor,
} = require('./widget-types');
const { normalizeSwitchTarget } = require('./switches');

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function parseConfig(raw) {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeWidgetRow(row = {}) {
  const type = WIDGET_TYPES.includes(row.type) ? row.type : 'value';
  const config = parseConfig(row.config);
  const widget = {
    id: row.id,
    type,
    sourceId: row.source_id || '',
    groupId: row.group_id == null ? null : row.group_id,
    tabId: row.tab_id == null ? null : row.tab_id,
    position: row.position == null ? 0 : row.position,
  };
  const def = widgetTypeDef(type);
  // Größenwahl: Bestandswidgets ohne gespeicherte Größe erhalten 'l' — das
  // entspricht der bisherigen Darstellung (Rückwärtskompatibilität).
  if (def.supportsSize) widget.size = normalizeSize(config.size);
  if (def.supportsColor) widget.color = normalizeColor(config.color);
  if (type === 'info') widget.infoFields = sanitizeFields(config.fields);
  if (type === 'switch') {
    widget.switchLabel = String(config.label || '').trim();
    widget.onColor = normalizeColor(config.onColor);
    widget.offColor = normalizeColor(config.offColor);
  }
  return widget;
}

async function listWidgets(db) {
  const rows = await dbAll(
    db,
    'SELECT id, source_id, type, config, group_id, position, tab_id FROM dashboard_widgets ORDER BY position ASC, id ASC'
  );
  return rows.map(normalizeWidgetRow);
}

async function getWidget(db, id) {
  const row = await dbGet(
    db,
    'SELECT id, source_id, type, config, group_id, position, tab_id FROM dashboard_widgets WHERE id = ?',
    [id]
  );
  return row ? normalizeWidgetRow(row) : null;
}

function parseGroupId(value) {
  if (value == null || value === '' || value === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTabId(value) {
  if (value == null || value === '' || value === 'null') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Formularseitig kommen Checkbox-Felder als String oder Array (mehrfach gleicher
// name) an – beides auf ein Array normalisieren.
function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeWidgetInput(input = {}) {
  const type = WIDGET_TYPES.includes(input.type) ? input.type : 'value';
  const def = widgetTypeDef(type);
  const normalized = {
    type,
    sourceId: String(input.sourceId || '').trim(),
    groupId: parseGroupId(input.groupId),
    tabId: parseTabId(input.tabId),
  };
  if (def.supportsSize) normalized.size = normalizeSize(input.size);
  if (def.supportsColor) normalized.color = normalizeColor(input.color);
  if (type === 'info') normalized.infoFields = sanitizeFields(toArray(input.infoFields).map(String));
  if (type === 'switch') {
    // Schalter verwenden ein eigenes Zielfeld (switchTarget) statt des
    // Wertekatalogs; das Ziel landet normalisiert in sourceId.
    normalized.sourceId = normalizeSwitchTarget(input.switchTarget != null ? input.switchTarget : input.sourceId);
    normalized.switchLabel = String(input.switchLabel || '').trim().slice(0, 60);
    normalized.onColor = normalizeColor(input.onColor);
    normalized.offColor = normalizeColor(input.offColor);
  }
  return normalized;
}

function validateWidgetInput(input) {
  const errors = [];
  if (input.type === 'value' && !input.sourceId) errors.push('Bitte einen Wert auswählen.');
  if (input.type === 'switch' && !input.sourceId) {
    errors.push('Bitte ein schaltbares Gerät oder eine Schaltgruppe auswählen.');
  }
  return errors;
}

// JSON-Konfiguration je Typ (oder null, wenn keine nötig). Standardwerte werden
// nicht mitgeschrieben — Bestandsdaten bleiben so kompatibel lesbar.
function configFor(widget) {
  const config = {};
  if (widget.size && widget.size !== 'l') config.size = widget.size;
  if (widget.color) config.color = widget.color;
  if (widget.type === 'info') config.fields = widget.infoFields;
  if (widget.type === 'switch') {
    if (widget.switchLabel) config.label = widget.switchLabel;
    if (widget.onColor) config.onColor = widget.onColor;
    if (widget.offColor) config.offColor = widget.offColor;
  }
  return Object.keys(config).length ? JSON.stringify(config) : null;
}

async function nextPosition(db) {
  const row = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM dashboard_widgets');
  return row ? row.pos : 0;
}

function throwIfInvalid(widget) {
  const errors = validateWidgetInput(widget);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.validation = true;
    throw error;
  }
}

async function createWidget(db, input) {
  const widget = normalizeWidgetInput(input);
  throwIfInvalid(widget);

  const position = await nextPosition(db);
  const result = await dbRun(
    db,
    'INSERT INTO dashboard_widgets (source_id, type, config, group_id, position, tab_id) VALUES (?, ?, ?, ?, ?, ?)',
    [widget.sourceId, widget.type, configFor(widget), widget.groupId, position, widget.groupId == null ? widget.tabId : null]
  );
  return getWidget(db, result.lastID);
}

async function updateWidget(db, id, input) {
  const widget = normalizeWidgetInput(input);
  throwIfInvalid(widget);

  await dbRun(
    db,
    'UPDATE dashboard_widgets SET source_id = ?, type = ?, config = ?, group_id = ?, tab_id = ? WHERE id = ?',
    [widget.sourceId, widget.type, configFor(widget), widget.groupId, widget.groupId == null ? widget.tabId : null, id]
  );
  return getWidget(db, id);
}

async function deleteWidget(db, id) {
  await dbRun(db, 'DELETE FROM dashboard_widgets WHERE id = ?', [id]);
}

// Neue Anordnung aus dem Drag&Drop persistieren: je Widget Gruppe, Position und
// (für gruppenlose Widgets) der Tab, in dessen freiem Bereich es liegt.
async function reorderWidgets(db, items) {
  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    const id = Number(item.id);
    if (!Number.isFinite(id)) continue;
    const groupId = parseGroupId(item.groupId);
    const tabId = groupId == null ? parseTabId(item.tabId) : null;
    const position = Number.isFinite(Number(item.position)) ? Number(item.position) : index;
    await dbRun(db, 'UPDATE dashboard_widgets SET group_id = ?, position = ?, tab_id = ? WHERE id = ?', [
      groupId,
      position,
      tabId,
      id,
    ]);
  }
}

module.exports = {
  WIDGET_TYPES,
  listWidgets,
  getWidget,
  createWidget,
  updateWidget,
  deleteWidget,
  reorderWidgets,
  normalizeWidgetInput,
};
