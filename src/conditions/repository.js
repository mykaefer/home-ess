'use strict';

const values = require('./values');

const KINDS = new Set(['trigger', 'when', 'then', 'else']);
const ACTION_KINDS = new Set(['then', 'else']);
const TRIGGER_TYPES = new Set(['time', 'change', 'event']);
const WHEN_TYPES = new Set(['state']);
const THEN_TYPES = new Set(['write']);
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'truthy', 'falsy']);
const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 };
const NUMERIC_HINT = 'Wert muss bei mathematischen Operatoren numerisch sein.';

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function done(error) {
    if (error) reject(error); else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function validation(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

function cleanText(value, label, max = 160) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw validation(`${label} fehlt.`);
  if (text.length > max) throw validation(`${label} ist zu lang.`);
  return text;
}

function cleanTopic(value, label = 'State') {
  const topic = cleanText(value, label, 1000);
  if (/\s/.test(topic)) throw validation(`${label} darf keine Leerzeichen enthalten.`);
  return topic;
}

// Formulare senden zu einer Checkbox zusätzlich ein verstecktes „0“-Feld, damit
// auch der abgewählte Zustand ankommt. Maßgeblich ist dann der letzte Wert.
function booleanValue(value, fallback = true) {
  if (Array.isArray(value)) return value.length ? booleanValue(value[value.length - 1], fallback) : fallback;
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return !['', '0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

// Vergleichs- und Zielwerte nehmen entweder einen festen Wert oder einen
// Topic-Verweis auf. Bei mathematischen Operatoren muss ein fester Wert
// numerisch sein; bei Topic-Verweisen kann das erst die Engine mit dem
// tatsächlichen Wert prüfen.
function cleanValue(value, label, requireNumeric = false) {
  const raw = cleanText(value, label, 1000);
  if (values.isTopicReference(raw)) return raw;
  if (requireNumeric && !values.isNumericValue(raw)) throw validation(NUMERIC_HINT);
  return raw;
}

function roundDigits(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') return null;
  const digits = Number(raw);
  if (!Number.isInteger(digits) || digits < 0 || digits > values.MAX_ROUND_DIGITS) {
    throw validation(`Die Nachkommastellen müssen zwischen 0 und ${values.MAX_ROUND_DIGITS} liegen.`);
  }
  return digits;
}

function weekdays(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  const result = [...new Set(raw.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  if (!result.length) throw validation('Bitte mindestens einen Wochentag auswählen.');
  return result;
}

function normalizeItemInput(kindValue, input = {}) {
  const kind = String(kindValue || input.kind || '').trim().toLowerCase();
  if (!KINDS.has(kind)) throw validation('Elementart ist ungültig.');
  const type = String(input.type || '').trim().toLowerCase();

  if (kind === 'trigger') {
    if (!TRIGGER_TYPES.has(type)) throw validation('Triggertyp ist ungültig.');
    if (type === 'change') return { kind, type, config: { topic: cleanTopic(input.topic, 'Trigger-State') } };
    if (type === 'event') {
      return { kind, type, config: {
        topic: cleanTopic(input.topic, 'Ereignis-State'),
        value: cleanText(input.value, 'Ereigniswert', 1000),
      } };
    }
    const mode = String(input.mode || 'interval').trim().toLowerCase();
    if (mode === 'interval') {
      const amount = Number(input.intervalAmount);
      const unit = String(input.intervalUnit || 'minutes').trim().toLowerCase();
      if (!Number.isInteger(amount) || amount < 1 || amount > 10000) throw validation('Das Wiederholungsintervall muss zwischen 1 und 10000 liegen.');
      if (!UNIT_SECONDS[unit]) throw validation('Zeiteinheit ist ungültig.');
      return { kind, type, config: { mode, intervalAmount: amount, intervalUnit: unit, intervalSeconds: amount * UNIT_SECONDS[unit] } };
    }
    if (mode !== 'schedule') throw validation('Zeitmodus ist ungültig.');
    const time = String(input.time || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw validation('Bitte eine gültige Uhrzeit auswählen.');
    return { kind, type, config: { mode, time, weekdays: weekdays(input.weekdays) } };
  }

  if (kind === 'when') {
    if (!WHEN_TYPES.has(type)) throw validation('Wenn-Typ ist ungültig.');
    const operator = String(input.operator || 'eq').trim().toLowerCase();
    if (!OPERATORS.has(operator)) throw validation('Vergleich ist ungültig.');
    const config = { topic: cleanTopic(input.topic, 'Prüf-State'), operator };
    if (!['truthy', 'falsy'].includes(operator)) {
      config.value = cleanValue(input.value, 'Vergleichswert', values.isMathOperator(operator));
    }
    return { kind, type, config };
  }

  if (!THEN_TYPES.has(type)) throw validation(`${kind === 'else' ? 'Sonst' : 'Dann'}-Typ ist ungültig.`);
  const label = kind === 'else' ? 'Sonst' : 'Dann';
  const targetTopic = cleanTopic(input.topic, 'Ziel-State');
  if (/^system:\/\//i.test(targetTopic)) throw validation(`Berechnete System-States sind schreibgeschützt und können kein ${label}-Ziel sein.`);
  const operation = String(input.operation || 'set').trim().toLowerCase();
  if (!values.OPERATIONS.includes(operation)) throw validation('Die Rechenfunktion ist ungültig.');
  const digits = roundDigits(input.round);
  // Gerechnet und gerundet wird nur mit Zahlen; ein reines `set` ohne Rundung
  // darf dagegen auch Text schreiben.
  const config = { topic: targetTopic, operation, value: cleanValue(input.value, 'Zielwert', operation !== 'set' || digits != null) };
  if (operation !== 'set') config.value2 = cleanValue(input.value2, 'Zweiter Wert', true);
  if (digits != null) config.round = digits;
  return { kind, type, config };
}

function parseConfig(value) {
  try {
    const config = JSON.parse(value || '{}');
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch (_) { return {}; }
}

const OPERATOR_LABELS = {
  eq: 'ist gleich', neq: 'ist ungleich', gt: 'ist größer als', gte: 'ist größer/gleich',
  lt: 'ist kleiner als', lte: 'ist kleiner/gleich', contains: 'enthält', truthy: 'ist wahr/ein', falsy: 'ist falsch/aus',
};
const DAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const OPERATION_SIGNS = { add: '+', sub: '−', mul: '×', div: '÷', mod: 'mod' };

// Dann und Sonst schreiben denselben Aktionstyp; ohne Rechenfunktion bleibt es
// beim direkt gesetzten Wert (so wie bei Bestandsautomationen ohne `operation`).
function describeAction(config) {
  const operation = config.operation || 'set';
  const suffix = config.round == null ? '' : `, gerundet auf ${config.round} Nachkommastellen`;
  if (operation === 'set') return `${config.topic} auf ${config.value} setzen${suffix}`;
  const term = OPERATION_SIGNS[operation]
    ? `${config.value} ${OPERATION_SIGNS[operation]} ${config.value2}`
    : `${operation}(${config.value}, ${config.value2})`;
  return `${config.topic} auf ${term} setzen${suffix}`;
}

function describeItem(item) {
  const c = item.config;
  if (item.kind === 'trigger' && item.type === 'change') return `Bei jeder Wertänderung von ${c.topic}`;
  if (item.kind === 'trigger' && item.type === 'event') return `Wenn ${c.topic} exakt ${c.value} meldet`;
  if (item.kind === 'trigger' && c.mode === 'interval') {
    const units = { minutes: c.intervalAmount === 1 ? 'Minute' : 'Minuten', hours: c.intervalAmount === 1 ? 'Stunde' : 'Stunden', days: c.intervalAmount === 1 ? 'Tag' : 'Tage' };
    return `Alle ${c.intervalAmount} ${units[c.intervalUnit] || c.intervalUnit}`;
  }
  if (item.kind === 'trigger') return `${(c.weekdays || []).map((day) => DAY_LABELS[day]).join(', ')} um ${c.time} Uhr`;
  if (item.kind === 'when') return `${c.topic} ${OPERATOR_LABELS[c.operator] || c.operator}${['truthy', 'falsy'].includes(c.operator) ? '' : ` ${c.value}`}`;
  return describeAction(c);
}

function normalizeItemRow(row) {
  const item = {
    id: Number(row.id), conditionId: Number(row.condition_id), kind: row.kind, type: row.type,
    position: Number(row.position || 0), config: parseConfig(row.config_json), lastFiredAt: row.last_fired_at == null ? null : Number(row.last_fired_at),
  };
  item.description = describeItem(item);
  return item;
}

async function listFolders(db) {
  const rows = await dbAll(db, 'SELECT id, parent_id, name, position FROM automation_condition_folders ORDER BY position, name COLLATE NOCASE, id');
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const pathOf = (id) => {
    const names = []; const seen = new Set(); let cursor = id;
    while (cursor != null && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); const folder = byId.get(cursor); names.unshift(folder.name); cursor = folder.parent_id == null ? null : Number(folder.parent_id);
    }
    return names;
  };
  return rows.map((row) => ({
    id: Number(row.id), parentId: row.parent_id == null ? null : Number(row.parent_id),
    name: row.name, position: Number(row.position || 0), path: pathOf(Number(row.id)),
  }));
}

async function listConditions(db) {
  const [conditions, items] = await Promise.all([
    dbAll(db, `SELECT id, folder_id, name, enabled, when_enabled, position, last_triggered_at, last_result, last_error
                 FROM automation_conditions ORDER BY position, name COLLATE NOCASE, id`),
    dbAll(db, `SELECT id, condition_id, kind, type, config_json, position, last_fired_at
                 FROM automation_condition_items ORDER BY condition_id, kind, position, id`),
  ]);
  const byCondition = new Map();
  for (const row of items) {
    const item = normalizeItemRow(row);
    if (!byCondition.has(item.conditionId)) byCondition.set(item.conditionId, []);
    byCondition.get(item.conditionId).push(item);
  }
  return conditions.map((row) => {
    const all = byCondition.get(Number(row.id)) || [];
    return {
      id: Number(row.id), folderId: row.folder_id == null ? null : Number(row.folder_id),
      name: row.name, enabled: !!row.enabled, whenEnabled: row.when_enabled == null ? true : !!row.when_enabled,
      position: Number(row.position || 0),
      lastTriggeredAt: row.last_triggered_at == null ? null : Number(row.last_triggered_at),
      lastResult: row.last_result || '', lastError: row.last_error || '',
      triggers: all.filter((item) => item.kind === 'trigger'),
      whens: all.filter((item) => item.kind === 'when'),
      thens: all.filter((item) => item.kind === 'then'),
      elses: all.filter((item) => item.kind === 'else'),
    };
  });
}

// Der Baum spiegelt exakt die Ansicht: Verzeichnisse mit Unterverzeichnissen
// und ihren Bedingungen, dazu die Bedingungen ohne Verzeichnis.
function buildTree(folders, conditions) {
  const byParent = new Map();
  for (const folder of folders) {
    const key = folder.parentId == null ? 'root' : folder.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push({ ...folder, folders: [], conditions: [] });
  }
  const nodeById = new Map();
  for (const nodes of byParent.values()) for (const node of nodes) nodeById.set(node.id, node);
  for (const node of nodeById.values()) node.folders = byParent.get(node.id) || [];
  const rootConditions = [];
  for (const condition of conditions) {
    const node = nodeById.get(condition.folderId);
    if (node) node.conditions.push(condition); else rootConditions.push(condition);
  }
  const count = (node) => node.conditions.length + node.folders.reduce((sum, child) => sum + count(child), 0);
  for (const node of nodeById.values()) node.conditionCount = count(node);
  return { folders: byParent.get('root') || [], conditions: rootConditions };
}

async function conditionTree(db) {
  const [folders, conditions] = await Promise.all([listFolders(db), listConditions(db)]);
  return { folders, conditions, tree: buildTree(folders, conditions) };
}

async function descendantFolderIds(db, id) {
  const rows = await dbAll(db, `WITH RECURSIVE tree(id) AS (
      SELECT id FROM automation_condition_folders WHERE id = ?
      UNION ALL SELECT f.id FROM automation_condition_folders f JOIN tree t ON f.parent_id = t.id
    ) SELECT id FROM tree`, [Number(id)]);
  return rows.map((row) => Number(row.id));
}

function folderReference(value) {
  if (value === '' || value == null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw validation('Das gewählte Verzeichnis ist ungültig.');
  return id;
}

async function requireFolder(db, id) {
  if (id == null) return;
  if (!(await dbGet(db, 'SELECT id FROM automation_condition_folders WHERE id = ?', [id]))) throw validation('Zielverzeichnis nicht gefunden.');
}

async function addFolder(db, input = {}) {
  const name = cleanText(input.name, 'Name', 100);
  const parentId = folderReference(input.parentId);
  await requireFolder(db, parentId);
  const next = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM automation_condition_folders WHERE parent_id IS ?', [parentId]);
  try {
    const result = await dbRun(db, 'INSERT INTO automation_condition_folders (parent_id, name, position) VALUES (?, ?, ?)', [parentId, name, next.position]);
    return { id: result.id, parentId, name };
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('In diesem Verzeichnis gibt es den Namen bereits.');
    throw error;
  }
}

async function updateFolder(db, idValue, input = {}) {
  const folderId = Number(idValue);
  const current = await dbGet(db, 'SELECT id, parent_id, position FROM automation_condition_folders WHERE id = ?', [folderId]);
  if (!current) throw validation('Verzeichnis nicht gefunden.');
  const name = cleanText(input.name, 'Name', 100);
  const parentId = Object.prototype.hasOwnProperty.call(input, 'parentId')
    ? folderReference(input.parentId)
    : (current.parent_id == null ? null : Number(current.parent_id));
  if (parentId === folderId) throw validation('Ein Verzeichnis kann nicht sein eigenes übergeordnetes Verzeichnis sein.');
  if (parentId != null) {
    await requireFolder(db, parentId);
    if ((await descendantFolderIds(db, folderId)).includes(parentId)) {
      throw validation('Ein Verzeichnis kann nicht in eines seiner Unterverzeichnisse verschoben werden.');
    }
  }
  const moved = parentId !== (current.parent_id == null ? null : Number(current.parent_id));
  const next = moved
    ? await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM automation_condition_folders WHERE parent_id IS ?', [parentId])
    : { position: current.position };
  try {
    await dbRun(db, 'UPDATE automation_condition_folders SET name = ?, parent_id = ?, position = ? WHERE id = ?', [name, parentId, next.position, folderId]);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('In diesem Verzeichnis gibt es den Namen bereits.');
    throw error;
  }
}

async function deleteFolder(db, idValue) {
  const ids = await descendantFolderIds(db, idValue);
  if (!ids.length) throw validation('Verzeichnis nicht gefunden.');
  const marks = ids.map(() => '?').join(',');
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    await dbRun(db, `DELETE FROM automation_condition_items WHERE condition_id IN (SELECT id FROM automation_conditions WHERE folder_id IN (${marks}))`, ids);
    await dbRun(db, `DELETE FROM automation_conditions WHERE folder_id IN (${marks})`, ids);
    await dbRun(db, `DELETE FROM automation_condition_folders WHERE id IN (${marks})`, ids);
    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

async function getCondition(db, id) {
  return (await listConditions(db)).find((condition) => condition.id === Number(id)) || null;
}

function initialItem(input, kind) {
  return normalizeItemInput(kind, {
    type: input[`${kind}Type`], mode: input[`${kind}Mode`], topic: input[`${kind}Topic`],
    value: input[`${kind}Value`], value2: input[`${kind}Value2`], operator: input[`${kind}Operator`],
    operation: input[`${kind}Operation`], round: input[`${kind}Round`],
    intervalAmount: input[`${kind}IntervalAmount`], intervalUnit: input[`${kind}IntervalUnit`],
    time: input[`${kind}Time`], weekdays: input[`${kind}Weekdays`],
  });
}

async function createCondition(db, input = {}) {
  const name = cleanText(input.name, 'Name', 120);
  const enabled = booleanValue(input.enabled, false);
  const whenEnabled = booleanValue(input.whenEnabled, true);
  const elseEnabled = booleanValue(input.elseEnabled, false);
  if (elseEnabled && !whenEnabled) throw validation('Ein Sonst-Zweig setzt eine aktive Wenn-Prüfung voraus.');
  const folderId = folderReference(input.folderId);
  await requireFolder(db, folderId);
  const entries = [initialItem(input, 'trigger')];
  if (whenEnabled) entries.push(initialItem(input, 'when'));
  entries.push(initialItem(input, 'then'));
  if (elseEnabled) entries.push(initialItem(input, 'else'));
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const next = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM automation_conditions WHERE folder_id IS ?', [folderId]);
    const result = await dbRun(db, 'INSERT INTO automation_conditions (folder_id, name, enabled, when_enabled, position) VALUES (?, ?, ?, ?, ?)', [folderId, name, enabled ? 1 : 0, whenEnabled ? 1 : 0, next.position]);
    for (const entry of entries) {
      await dbRun(db, `INSERT INTO automation_condition_items (condition_id, kind, type, config_json, position)
                       VALUES (?, ?, ?, ?, 0)`, [result.id, entry.kind, entry.type, JSON.stringify(entry.config)]);
    }
    await dbRun(db, 'COMMIT');
    return getCondition(db, result.id);
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Eine Bedingung mit diesem Namen existiert bereits.');
    throw error;
  }
}

async function itemCount(db, conditionId, kind) {
  const row = await dbGet(db, 'SELECT COUNT(*) AS count FROM automation_condition_items WHERE condition_id = ? AND kind = ?', [Number(conditionId), kind]);
  return Number(row ? row.count : 0);
}

async function updateCondition(db, id, input = {}) {
  const conditionId = Number(id);
  const current = await dbGet(db, 'SELECT id, folder_id, when_enabled, position FROM automation_conditions WHERE id = ?', [conditionId]);
  if (!current) throw validation('Bedingung nicht gefunden.');
  const name = cleanText(input.name, 'Name', 120);
  const enabled = booleanValue(input.enabled, false);
  const whenEnabled = Object.prototype.hasOwnProperty.call(input, 'whenEnabled')
    ? booleanValue(input.whenEnabled, false)
    : current.when_enabled !== 0;
  // Prüfung und Wenn-Elemente bleiben gekoppelt: ohne Wenn keine Prüfung, und
  // ein Sonst-Zweig verliert ohne Prüfung seinen Sinn.
  if (whenEnabled && current.when_enabled === 0 && !(await itemCount(db, conditionId, 'when'))) {
    throw validation('Für die Wenn-Prüfung fehlt noch ein Wenn-Element.');
  }
  if (!whenEnabled && await itemCount(db, conditionId, 'else')) {
    throw validation('Solange ein Sonst-Zweig besteht, kann die Wenn-Prüfung nicht deaktiviert werden.');
  }
  const folderId = Object.prototype.hasOwnProperty.call(input, 'folderId')
    ? folderReference(input.folderId)
    : (current.folder_id == null ? null : Number(current.folder_id));
  await requireFolder(db, folderId);
  const moved = folderId !== (current.folder_id == null ? null : Number(current.folder_id));
  const next = moved
    ? await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM automation_conditions WHERE folder_id IS ?', [folderId])
    : { position: current.position };
  try {
    await dbRun(db, 'UPDATE automation_conditions SET folder_id = ?, name = ?, enabled = ?, when_enabled = ?, position = ? WHERE id = ?', [folderId, name, enabled ? 1 : 0, whenEnabled ? 1 : 0, next.position, conditionId]);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Eine Bedingung mit diesem Namen existiert bereits.');
    throw error;
  }
  return getCondition(db, conditionId);
}

async function deleteCondition(db, id) {
  const conditionId = Number(id);
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    await dbRun(db, 'DELETE FROM automation_condition_items WHERE condition_id = ?', [conditionId]);
    const result = await dbRun(db, 'DELETE FROM automation_conditions WHERE id = ?', [conditionId]);
    if (!result.changes) throw validation('Bedingung nicht gefunden.');
    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

async function addItem(db, conditionIdValue, input = {}) {
  const conditionId = Number(conditionIdValue);
  const condition = await dbGet(db, 'SELECT id, when_enabled FROM automation_conditions WHERE id = ?', [conditionId]);
  if (!condition) throw validation('Bedingung nicht gefunden.');
  const entry = normalizeItemInput(input.kind, input);
  // Der Sonst-Zweig läuft genau dann, wenn die Wenn-Prüfung nicht zutrifft. Er
  // bleibt deshalb einmalig und an eine aktive Prüfung gebunden.
  if (entry.kind === 'else') {
    if (condition.when_enabled === 0) throw validation('Ein Sonst-Zweig setzt eine aktive Wenn-Prüfung voraus.');
    if (await itemCount(db, conditionId, 'else')) throw validation('Je Bedingung ist nur ein Sonst-Zweig möglich.');
  }
  const next = await dbGet(db, `SELECT COALESCE(MAX(position), -1) + 1 AS position
                                  FROM automation_condition_items WHERE condition_id = ? AND kind = ?`, [conditionId, entry.kind]);
  const result = await dbRun(db, `INSERT INTO automation_condition_items (condition_id, kind, type, config_json, position)
                                  VALUES (?, ?, ?, ?, ?)`, [conditionId, entry.kind, entry.type, JSON.stringify(entry.config), next.position]);
  // Ein neu angelegtes Wenn schaltet die Prüfung wieder ein; sonst bliebe es
  // ohne sichtbaren Grund wirkungslos.
  if (entry.kind === 'when' && condition.when_enabled === 0) {
    await dbRun(db, 'UPDATE automation_conditions SET when_enabled = 1 WHERE id = ?', [conditionId]);
  }
  return normalizeItemRow(await dbGet(db, `SELECT id, condition_id, kind, type, config_json, position, last_fired_at
                                            FROM automation_condition_items WHERE id = ?`, [result.id]));
}

async function updateItem(db, conditionIdValue, itemIdValue, input = {}) {
  const conditionId = Number(conditionIdValue);
  const itemId = Number(itemIdValue);
  const current = await dbGet(db, 'SELECT id, kind FROM automation_condition_items WHERE id = ? AND condition_id = ?', [itemId, conditionId]);
  if (!current) throw validation('Element nicht gefunden.');
  const entry = normalizeItemInput(current.kind, { ...input, kind: current.kind });
  await dbRun(db, 'UPDATE automation_condition_items SET type = ?, config_json = ?, last_fired_at = NULL WHERE id = ?', [entry.type, JSON.stringify(entry.config), itemId]);
  return normalizeItemRow(await dbGet(db, `SELECT id, condition_id, kind, type, config_json, position, last_fired_at
                                            FROM automation_condition_items WHERE id = ?`, [itemId]));
}

async function deleteItem(db, conditionIdValue, itemIdValue) {
  const conditionId = Number(conditionIdValue);
  const itemId = Number(itemIdValue);
  const item = await dbGet(db, 'SELECT id, kind FROM automation_condition_items WHERE id = ? AND condition_id = ?', [itemId, conditionId]);
  if (!item) throw validation('Element nicht gefunden.');
  const remaining = (await itemCount(db, conditionId, item.kind)) - 1;
  if (remaining < 1 && (item.kind === 'trigger' || item.kind === 'then')) {
    throw validation('Jede Bedingung benötigt mindestens einen Trigger und ein Dann.');
  }
  // Das letzte Wenn zu entfernen schaltet die Prüfung ab – solange kein
  // Sonst-Zweig davon abhängt.
  if (item.kind === 'when' && remaining < 1 && await itemCount(db, conditionId, 'else')) {
    throw validation('Solange ein Sonst-Zweig besteht, wird mindestens ein Wenn benötigt.');
  }
  await dbRun(db, 'DELETE FROM automation_condition_items WHERE id = ?', [itemId]);
  if (item.kind === 'when' && remaining < 1) {
    await dbRun(db, 'UPDATE automation_conditions SET when_enabled = 0 WHERE id = ?', [conditionId]);
  }
}

// Drag&Drop überträgt den vollständigen sichtbaren Baum. Verzeichnisse und
// Bedingungen werden dadurch als konsistente Momentaufnahme geprüft und
// gespeichert. Trigger, Wenns und Danns sind bewusst nicht sortierbar: ihre
// Reihenfolge hat für die Auswertung keine Bedeutung.
async function updateLayout(db, input = {}) {
  const [knownFolderList, knownConditionList] = await Promise.all([listFolders(db), listConditions(db)]);
  const knownFolders = new Map(knownFolderList.map((folder) => [folder.id, folder]));
  const knownConditions = new Map(knownConditionList.map((condition) => [condition.id, condition]));
  const folders = Array.isArray(input.folders) ? input.folders : [];
  const conditions = Array.isArray(input.conditions) ? input.conditions : [];
  if (folders.length !== knownFolders.size || conditions.length !== knownConditions.size) {
    throw validation('Das Layout ist unvollständig; bitte die Seite neu laden.');
  }
  const cleanPosition = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw validation('Layoutposition ist ungültig.');
    return number;
  };
  const folderLayout = new Map();
  const conditionLayout = new Map();
  for (const entry of folders) {
    const id = Number(entry.id);
    if (!knownFolders.has(id) || folderLayout.has(id)) throw validation('Das Verzeichnislayout enthält unbekannte oder doppelte Einträge.');
    folderLayout.set(id, { parentId: folderReference(entry.parentId), position: cleanPosition(entry.position) });
  }
  for (const entry of conditions) {
    const id = Number(entry.id);
    if (!knownConditions.has(id) || conditionLayout.has(id)) throw validation('Bedingungslayout enthält unbekannte oder doppelte Einträge.');
    conditionLayout.set(id, { folderId: folderReference(entry.folderId), position: cleanPosition(entry.position) });
  }
  for (const [id, entry] of folderLayout) {
    if (entry.parentId != null && !folderLayout.has(entry.parentId)) throw validation('Zielverzeichnis nicht gefunden.');
    const seen = new Set([id]);
    let cursor = entry.parentId;
    while (cursor != null) {
      if (seen.has(cursor)) throw validation('Verzeichnisse dürfen keinen Kreis bilden.');
      seen.add(cursor); cursor = folderLayout.get(cursor).parentId;
    }
  }
  for (const entry of conditionLayout.values()) {
    if (entry.folderId != null && !folderLayout.has(entry.folderId)) throw validation('Zielverzeichnis nicht gefunden.');
  }
  const folderNames = new Set();
  for (const folder of knownFolderList) {
    const parentId = folderLayout.get(folder.id).parentId;
    const key = `${parentId == null ? 'root' : parentId} ${folder.name.toLocaleLowerCase('de')}`;
    if (folderNames.has(key)) throw validation('Im Zielverzeichnis gibt es bereits ein Verzeichnis mit diesem Namen.');
    folderNames.add(key);
  }
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    for (const [id, entry] of folderLayout) {
      await dbRun(db, 'UPDATE automation_condition_folders SET parent_id = ?, position = ? WHERE id = ?', [entry.parentId, entry.position, id]);
    }
    for (const [id, entry] of conditionLayout) {
      await dbRun(db, 'UPDATE automation_conditions SET folder_id = ?, position = ? WHERE id = ?', [entry.folderId, entry.position, id]);
    }
    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Das Ziel enthält bereits einen gleichnamigen Eintrag.');
    throw error;
  }
}

async function markTriggered(db, conditionId, result, error = '', at = Date.now()) {
  await dbRun(db, `UPDATE automation_conditions
                      SET last_triggered_at = ?, last_result = ?, last_error = ? WHERE id = ?`,
  [at, String(result || ''), String(error || '').slice(0, 1000), Number(conditionId)]);
}
async function markItemFired(db, itemId, at = Date.now()) {
  await dbRun(db, 'UPDATE automation_condition_items SET last_fired_at = ? WHERE id = ?', [at, Number(itemId)]);
}

module.exports = {
  listConditions, listFolders, conditionTree, getCondition, createCondition, updateCondition, deleteCondition,
  addFolder, updateFolder, deleteFolder, addItem, updateItem, deleteItem, updateLayout,
  normalizeItemInput, describeItem, markTriggered, markItemFired, dbGet,
};
