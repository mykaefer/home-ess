'use strict';

// CRUD für Dashboard-Widgets. Ein Widget ist eine **Wert-Kachel** (type 'value',
// zeigt einen State aus dem zentralen States-Modell), ein
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
const { normalizeChartConfig, chartConfigForStorage, validateChartConfig } = require('./chart-config');
const { topicForId } = require('../states/system-topics');

const schemaReady = new WeakMap();

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

// Vor 1.3.35 lagen Wertbezüge in source_id. Adapter- und virtuelle Werte waren
// dort bereits topicförmig; berechnete Systemwerte verwendeten dagegen ihre
// fachliche Katalog-ID (z. B. pv.current). Beide Formen werden in das neue,
// eindeutige State-Topic-Schema überführt.
function stateTopicFromLegacySource(sourceId) {
  const value = String(sourceId || '').trim();
  if (!value) return '';
  return value.includes('://') ? value : topicForId(value);
}

function ensureStateTopicSchema(db) {
  if (schemaReady.has(db)) return schemaReady.get(db);
  const promise = dbAll(db, 'PRAGMA table_info(dashboard_widgets)').then(async (rows) => {
    if (!rows.some((row) => row.name === 'state_topic')) {
      try {
        await dbRun(db, "ALTER TABLE dashboard_widgets ADD COLUMN state_topic TEXT NOT NULL DEFAULT ''");
      } catch (error) {
        // Die zentrale DB-Migration kann dieselbe Spalte zwischen PRAGMA und
        // ALTER bereits ergänzt haben. Nur genau dieser harmlose Wettlauf darf
        // als erfolgreich gelten.
        if (!/duplicate column name:\s*state_topic/i.test(String(error && error.message))) throw error;
      }
    }
  });
  schemaReady.set(db, promise);
  return promise;
}

function normalizeWidgetRow(row = {}) {
  const type = WIDGET_TYPES.includes(row.type) ? row.type : 'value';
  const config = parseConfig(row.config);
  const stateTopic = type === 'value'
    ? (String(row.state_topic || '').trim() || stateTopicFromLegacySource(row.source_id))
    : '';
  const widget = {
    id: row.id,
    type,
    stateTopic,
    // Öffentliche Übergangskompatibilität für bestehende Aufrufer. Neue
    // Wert-Widget-Pfade verwenden stateTopic; Schalter weiterhin sourceId.
    sourceId: type === 'value' ? stateTopic : (row.source_id || ''),
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
  if (type === 'chart') widget.chart = normalizeChartConfig(config.chart || config);
  return widget;
}

async function listWidgets(db) {
  await ensureStateTopicSchema(db);
  const rows = await dbAll(
    db,
    'SELECT id, source_id, state_topic, type, config, group_id, position, tab_id FROM dashboard_widgets ORDER BY position ASC, id ASC'
  );
  await migrateLegacyValueRows(db, rows);
  return rows.map(normalizeWidgetRow);
}

async function getWidget(db, id) {
  await ensureStateTopicSchema(db);
  const row = await dbGet(
    db,
    'SELECT id, source_id, state_topic, type, config, group_id, position, tab_id FROM dashboard_widgets WHERE id = ?',
    [id]
  );
  if (row) await migrateLegacyValueRows(db, [row]);
  return row ? normalizeWidgetRow(row) : null;
}

async function migrateLegacyValueRows(db, rows) {
  const legacy = (rows || []).filter((row) =>
    (WIDGET_TYPES.includes(row.type) ? row.type : 'value') === 'value' &&
    !String(row.state_topic || '').trim() && String(row.source_id || '').trim()
  );
  if (!legacy.length) return;
  for (const row of legacy) {
    const stateTopic = stateTopicFromLegacySource(row.source_id);
    await dbRun(
      db,
      "UPDATE dashboard_widgets SET state_topic = ?, source_id = '' WHERE id = ? AND type = 'value' AND state_topic = ''",
      [stateTopic, row.id]
    );
    row.state_topic = stateTopic;
    row.source_id = '';
  }
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
    stateTopic: type === 'value'
      ? stateTopicFromLegacySource(input.stateTopic != null ? input.stateTopic : input.sourceId)
      : '',
    sourceId: type === 'value' ? '' : String(input.sourceId || '').trim(),
    groupId: parseGroupId(input.groupId),
    tabId: parseTabId(input.tabId),
  };
  if (def.supportsSize) normalized.size = normalizeSize(input.size);
  if (def.supportsColor) normalized.color = normalizeColor(input.color);
  if (type === 'info') normalized.infoFields = sanitizeFields(toArray(input.infoFields).map(String));
  if (type === 'switch') {
    // Schalter verwenden ein eigenes Zielfeld (switchTarget) statt des
    // State-Pickers; das Ziel landet normalisiert in sourceId.
    normalized.sourceId = normalizeSwitchTarget(input.switchTarget != null ? input.switchTarget : input.sourceId);
    normalized.switchLabel = String(input.switchLabel || '').trim().slice(0, 60);
    normalized.onColor = normalizeColor(input.onColor);
    normalized.offColor = normalizeColor(input.offColor);
  }
  if (type === 'chart') {
    // Die Linien kommen aus dem Dialog als drei parallele Feldlisten
    // (Messreihe, Name, Farbe) — oder bereits als fertige Liste (Tests, API).
    normalized.chart = normalizeChartConfig({
      series: Array.isArray(input.chartSeries) ? input.chartSeries : undefined,
      seriesMeasurements: input.chartSeriesMeasurements != null
        ? input.chartSeriesMeasurements
        : (input.chartMeasurements != null ? input.chartMeasurements : input.measurements),
      seriesLabels: input.chartSeriesLabels,
      seriesColors: input.chartSeriesColors,
      range: input.chartRange != null ? input.chartRange : input.range,
      aggregate: input.chartAggregate != null ? input.chartAggregate : input.aggregate,
      title: input.chartTitle != null ? input.chartTitle : input.title,
      unit: input.chartUnit != null ? input.chartUnit : input.unit,
    });
  }
  return normalized;
}

function validateWidgetInput(input) {
  const errors = [];
  if (input.type === 'value' && !input.stateTopic) errors.push('Bitte einen State auswählen.');
  if (input.type === 'switch' && !input.sourceId) {
    errors.push('Bitte ein schaltbares Gerät, eine Schaltgruppe oder einen Kinomodus auswählen.');
  }
  if (input.type === 'chart') errors.push(...validateChartConfig(input.chart || {}));
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
  if (widget.type === 'chart') config.chart = chartConfigForStorage(widget.chart);
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
  await ensureStateTopicSchema(db);
  const widget = normalizeWidgetInput(input);
  throwIfInvalid(widget);

  const position = await nextPosition(db);
  const result = await dbRun(
    db,
    'INSERT INTO dashboard_widgets (source_id, state_topic, type, config, group_id, position, tab_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [widget.sourceId, widget.stateTopic, widget.type, configFor(widget), widget.groupId, position, widget.groupId == null ? widget.tabId : null]
  );
  return getWidget(db, result.lastID);
}

async function updateWidget(db, id, input) {
  await ensureStateTopicSchema(db);
  const widget = normalizeWidgetInput(input);
  throwIfInvalid(widget);

  await dbRun(
    db,
    'UPDATE dashboard_widgets SET source_id = ?, state_topic = ?, type = ?, config = ?, group_id = ?, tab_id = ? WHERE id = ?',
    [widget.sourceId, widget.stateTopic, widget.type, configFor(widget), widget.groupId, widget.groupId == null ? widget.tabId : null, id]
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
  stateTopicFromLegacySource,
};
