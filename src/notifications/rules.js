'use strict';

// Persistenz und Validierung der Nachrichtenregeln (`notification_rules`).
//
// Eine Regel verweist über `state_id` auf einen bestehenden homeESS-State. Das
// ist dieselbe kanonische State-Adresse, die auch Bedingungen, Output und
// Dashboard verwenden (`system://…`, `custom://…`, `prefix://instanz/adresse`);
// es gibt bewusst keine zweite State-Verwaltung und keine eigene Kopie der
// State-Liste.
//
// Eine Regel speichert NIE instanceId, deviceId, Push-Token oder Firebase-Daten:
// sie kann damit auch keine fremde Instanz und keinen bestimmten Empfänger
// adressieren. Die Empfänger bestimmt allein der Relay über seine aktiven
// Kopplungen.

const service = require('./service');
const { TRIGGER_TYPES, TRIGGER_NEEDS_VALUE, NUMERIC_TRIGGERS, isNumericValue } = require('./triggers');

const MAX_NAME = 120;
const MAX_STATE_ID = 400;
const MAX_TRIGGER_VALUE = 200;
const MAX_COOLDOWN_SECONDS = 86400;
const DEFAULT_COOLDOWN_SECONDS = 5;

const COLUMNS = `id, name, enabled, state_id, trigger_type, trigger_value, title, body,
  event_type, severity, cooldown_seconds, position, created_at, updated_at, last_triggered_at`;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row || null))));
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

function normalizeRow(row = {}) {
  return {
    id: row.id,
    name: row.name || '',
    enabled: row.enabled === 1 || row.enabled === true,
    stateId: row.state_id || '',
    triggerType: row.trigger_type || 'changed',
    triggerValue: row.trigger_value == null ? '' : String(row.trigger_value),
    title: row.title || '',
    body: row.body || '',
    eventType: row.event_type || '',
    severity: row.severity === 'critical' ? 'critical' : 'normal',
    cooldownSeconds: Number.isFinite(Number(row.cooldown_seconds)) ? Number(row.cooldown_seconds) : DEFAULT_COOLDOWN_SECONDS,
    position: Number(row.position) || 0,
    createdAt: row.created_at == null ? null : Number(row.created_at),
    updatedAt: row.updated_at == null ? null : Number(row.updated_at),
    lastTriggeredAt: row.last_triggered_at == null ? null : Number(row.last_triggered_at),
  };
}

// Formulare senden zu einer Checkbox zusätzlich ein verstecktes „0"-Feld, damit
// auch das Abwählen ankommt; maßgeblich ist der letzte Wert.
function checkboxValue(value, fallback = false) {
  if (Array.isArray(value)) return value.length ? checkboxValue(value[value.length - 1], fallback) : fallback;
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return !['', '0', 'false', 'off', 'no', 'nein'].includes(String(value).trim().toLowerCase());
}

function cleanText(value, label, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw validation(`${label} fehlt.`);
  if (text.length > max) throw validation(`${label} ist zu lang.`);
  return text;
}

// Eingaben aus Formular oder JSON in die gespeicherte Form bringen und
// vollständig prüfen. `context.stateValueType` ist der aus dem State-Katalog
// abgeleitete Werttyp ('boolean' | 'number' | 'string' | null) — er sperrt nicht
// sinnvolle Kombinationen wie „Steigt über" auf einem Schalter. Ist der Typ
// unbekannt (State liefert noch keinen Wert), bleibt die Auswahl offen.
function normalizeInput(input = {}, context = {}) {
  const name = cleanText(input.name, 'Name', MAX_NAME);
  const stateId = cleanText(input.stateId != null ? input.stateId : input.state_id, 'State', MAX_STATE_ID);

  const triggerType = String(input.triggerType != null ? input.triggerType : input.trigger_type || '').trim();
  if (!TRIGGER_TYPES.includes(triggerType)) throw validation('Unbekannter Trigger.');

  const rawTriggerValue = input.triggerValue != null ? input.triggerValue : input.trigger_value;
  let triggerValue = String(rawTriggerValue == null ? '' : rawTriggerValue).trim();
  if (TRIGGER_NEEDS_VALUE.has(triggerType)) {
    if (!triggerValue) throw validation('Vergleichswert fehlt.');
    if (triggerValue.length > MAX_TRIGGER_VALUE) throw validation('Vergleichswert ist zu lang.');
    if (NUMERIC_TRIGGERS.has(triggerType) && !isNumericValue(triggerValue)) {
      throw validation('Vergleichswert muss bei Grenzwerten eine Zahl sein.');
    }
  } else {
    triggerValue = '';
  }
  if (NUMERIC_TRIGGERS.has(triggerType) && context.stateValueType && context.stateValueType !== 'number') {
    throw validation('Grenzwerte sind nur für numerische States möglich.');
  }

  // Titel, Nachricht, Ereignistyp und Priorität prüft der Nachrichtendienst —
  // dieselbe Prüfung wie beim späteren Versand, damit eine gespeicherte Regel
  // nicht erst beim Auslösen scheitern kann.
  const message = service.normalize({
    title: input.title,
    body: input.body,
    type: input.eventType != null ? input.eventType : input.event_type,
    severity: input.severity,
  });

  const rawCooldown = input.cooldownSeconds != null ? input.cooldownSeconds : input.cooldown_seconds;
  const cooldownSeconds = rawCooldown == null || rawCooldown === '' ? DEFAULT_COOLDOWN_SECONDS : Number(rawCooldown);
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    throw validation('Cooldown muss eine ganze Zahl von 0 bis 86400 Sekunden sein.');
  }

  return {
    name,
    enabled: checkboxValue(input.enabled, true),
    stateId,
    triggerType,
    triggerValue,
    title: message.title,
    body: message.body,
    eventType: message.type,
    severity: message.severity,
    cooldownSeconds,
  };
}

async function listRules(db) {
  const rows = await dbAll(db, `SELECT ${COLUMNS} FROM notification_rules ORDER BY position ASC, id ASC`);
  return rows.map(normalizeRow);
}

// Nur die Regeln, die der Engine-Lauf braucht: aktiv und mit State.
async function listActiveRules(db) {
  const rows = await dbAll(
    db,
    `SELECT ${COLUMNS} FROM notification_rules WHERE enabled = 1 ORDER BY position ASC, id ASC`
  );
  return rows.map(normalizeRow);
}

async function getRule(db, id) {
  const row = await dbGet(db, `SELECT ${COLUMNS} FROM notification_rules WHERE id = ?`, [Number(id)]);
  return row ? normalizeRow(row) : null;
}

async function nextPosition(db) {
  const row = await dbGet(db, 'SELECT MAX(position) AS maxPosition FROM notification_rules');
  return Number(row && row.maxPosition ? row.maxPosition : 0) + 1;
}

function uniqueNameError(error) {
  return /UNIQUE/i.test(String((error && error.message) || '')) ? validation('Dieser Name ist bereits vergeben.') : error;
}

async function createRule(db, input, context = {}) {
  const rule = normalizeInput(input, context);
  const now = Date.now();
  const position = await nextPosition(db);
  let result;
  try {
    result = await dbRun(
      db,
      `INSERT INTO notification_rules
         (name, enabled, state_id, trigger_type, trigger_value, title, body, event_type,
          severity, cooldown_seconds, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rule.name, rule.enabled ? 1 : 0, rule.stateId, rule.triggerType, rule.triggerValue,
        rule.title, rule.body, rule.eventType, rule.severity, rule.cooldownSeconds, position, now, now]
    );
  } catch (error) {
    throw uniqueNameError(error);
  }
  return getRule(db, result.id);
}

async function updateRule(db, id, input, context = {}) {
  const existing = await getRule(db, id);
  if (!existing) throw validation('Nachricht nicht gefunden.');
  const rule = normalizeInput(input, context);
  try {
    await dbRun(
      db,
      `UPDATE notification_rules
          SET name = ?, enabled = ?, state_id = ?, trigger_type = ?, trigger_value = ?,
              title = ?, body = ?, event_type = ?, severity = ?, cooldown_seconds = ?, updated_at = ?
        WHERE id = ?`,
      [rule.name, rule.enabled ? 1 : 0, rule.stateId, rule.triggerType, rule.triggerValue,
        rule.title, rule.body, rule.eventType, rule.severity, rule.cooldownSeconds, Date.now(), Number(id)]
    );
  } catch (error) {
    throw uniqueNameError(error);
  }
  return getRule(db, id);
}

// Nur den Aktiv-Schalter umlegen, ohne die übrigen Felder erneut zu prüfen.
async function setEnabled(db, id, enabled) {
  const existing = await getRule(db, id);
  if (!existing) throw validation('Nachricht nicht gefunden.');
  await dbRun(
    db,
    'UPDATE notification_rules SET enabled = ?, updated_at = ? WHERE id = ?',
    [enabled ? 1 : 0, Date.now(), Number(id)]
  );
  return getRule(db, id);
}

async function deleteRule(db, id) {
  const result = await dbRun(db, 'DELETE FROM notification_rules WHERE id = ?', [Number(id)]);
  if (!result.changes) throw validation('Nachricht nicht gefunden.');
}

// Einen erfolgten Auslöser vermerken. Wird ausschließlich von der Rule Engine
// nach einem tatsächlich gesendeten Push aufgerufen — nie von der Testfunktion
// und nie bei unterdrücktem Cooldown.
async function markTriggered(db, id, at = Date.now()) {
  await dbRun(db, 'UPDATE notification_rules SET last_triggered_at = ? WHERE id = ?', [Number(at), Number(id)]);
}

module.exports = {
  listRules,
  listActiveRules,
  getRule,
  createRule,
  updateRule,
  setEnabled,
  deleteRule,
  markTriggered,
  normalizeInput,
  normalizeRow,
  checkboxValue,
  DEFAULT_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  MAX_NAME,
  MAX_TRIGGER_VALUE,
};
