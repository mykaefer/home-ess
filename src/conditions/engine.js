'use strict';

const bus = require('../state-bus');
const mqttClient = require('../mqtt/client');
const timeHandler = require('../time-handler');
const repository = require('./repository');

const TICK_MS = 1000;
const EXECUTION_WINDOW_MS = 60000;
const MAX_EXECUTIONS_PER_WINDOW = 60;
const TRIGGER_ARM_MS = 2000;
let database = null;
let conditions = [];
let triggerByCacheKey = new Map();
let subscriptions = new Set();
let unsubscribeBus = null;
let timer = null;
let reloading = false;
let loadedAt = Date.now();
const intervalBaselines = new Map();
const running = new Set();
const executionHistory = new Map();
const blockedUntil = new Map();
const pending = new Set();
let pendingTimer = null;
let armTimer = null;
const armedTriggers = new Set();

function cacheKey(item) { return `condition:${item.conditionId}:item:${item.id}`; }

function literal(value) {
  const text = String(value == null ? '' : value).trim();
  const lower = text.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;
  if (text !== '' && Number.isFinite(Number(text.replace(',', '.')))) return Number(text.replace(',', '.'));
  try {
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) return JSON.parse(text);
  } catch (_) {}
  return text;
}

function comparable(value) {
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : JSON.stringify(value);
  const lower = text.toLowerCase();
  if (lower === 'true' || lower === 'on' || lower === 'ein') return { type: 'boolean', value: true };
  if (lower === 'false' || lower === 'off' || lower === 'aus') return { type: 'boolean', value: false };
  if (text !== '' && Number.isFinite(Number(text.replace(',', '.')))) return { type: 'number', value: Number(text.replace(',', '.')) };
  return { type: 'string', value: text };
}

function valuesEqual(leftValue, rightValue) {
  const left = comparable(leftValue); const right = comparable(rightValue);
  if (left.type === 'number' && right.type === 'number') return Math.abs(left.value - right.value) <= 0.000001;
  if (left.type === 'boolean' && right.type === 'number') return Number(left.value) === right.value;
  if (left.type === 'number' && right.type === 'boolean') return left.value === Number(right.value);
  if (left.type === 'boolean' && right.type === 'boolean') return left.value === right.value;
  return String(left.value) === String(right.value);
}

function compare(actual, operator, expected) {
  if (operator === 'truthy') return !!comparable(actual).value;
  if (operator === 'falsy') return !comparable(actual).value;
  if (operator === 'eq') return valuesEqual(actual, expected);
  if (operator === 'neq') return !valuesEqual(actual, expected);
  if (operator === 'contains') return String(actual == null ? '' : actual).includes(String(expected == null ? '' : expected));
  const left = comparable(actual); const right = comparable(expected);
  if (left.type !== 'number' || right.type !== 'number') return false;
  if (operator === 'gt') return left.value > right.value;
  if (operator === 'gte') return left.value >= right.value;
  if (operator === 'lt') return left.value < right.value;
  if (operator === 'lte') return left.value <= right.value;
  return false;
}

function cachedValue(item) {
  const entry = bus.getCache().get(cacheKey(item));
  return entry ? { known: true, value: entry.value } : { known: false, value: null };
}

async function evaluateCondition(condition, trigger = null) {
  if (!database || !condition || !condition.enabled || running.has(condition.id)) return false;
  const now = Date.now();
  if ((blockedUntil.get(condition.id) || 0) > now) return false;
  const recent = (executionHistory.get(condition.id) || []).filter((at) => now - at < EXECUTION_WINDOW_MS);
  if (recent.length >= MAX_EXECUTIONS_PER_WINDOW) {
    const message = 'Ausführungsschutz aktiv: zu viele Auslösungen innerhalb einer Minute.';
    blockedUntil.set(condition.id, now + EXECUTION_WINDOW_MS);
    await repository.markTriggered(database, condition.id, 'Blockiert', message, now).catch(() => {});
    condition.lastTriggeredAt = now; condition.lastResult = 'Blockiert'; condition.lastError = message;
    return false;
  }
  recent.push(now);
  executionHistory.set(condition.id, recent);
  running.add(condition.id);
  try {
    for (const item of condition.whens) {
      const current = cachedValue(item);
      if (!current.known || !compare(current.value, item.config.operator, literal(item.config.value))) {
        const result = current.known ? `Nicht ausgeführt: ${item.description}` : `Nicht ausgeführt: kein Wert für ${item.config.topic}`;
        await repository.markTriggered(database, condition.id, result, '', now);
        condition.lastTriggeredAt = now; condition.lastResult = result; condition.lastError = '';
        return false;
      }
    }
    for (const item of condition.thens) {
      const value = literal(item.config.value);
      if (!mqttClient.publish(item.config.topic, value)) throw new Error(`Ziel-State ${item.config.topic} konnte nicht geschrieben werden.`);
    }
    const result = `Ausgeführt: ${condition.thens.length} Aktion${condition.thens.length === 1 ? '' : 'en'}`;
    await repository.markTriggered(database, condition.id, result, '', now);
    condition.lastTriggeredAt = now; condition.lastResult = result; condition.lastError = '';
    return true;
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 1000);
    await repository.markTriggered(database, condition.id, 'Fehler', message, now).catch(() => {});
    condition.lastTriggeredAt = now; condition.lastResult = 'Fehler'; condition.lastError = message;
    return false;
  } finally {
    running.delete(condition.id);
  }
}

function flushPending() {
  pendingTimer = null;
  const ids = [...pending]; pending.clear();
  for (const id of ids) evaluateCondition(conditions.find((entry) => entry.id === id)).catch(() => {});
}

function queueCondition(conditionId) {
  pending.add(Number(conditionId));
  if (!pendingTimer) {
    pendingTimer = setTimeout(flushPending, 0);
    if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
  }
}

function onValues(event) {
  if (reloading || !event || !Array.isArray(event.changedKeys)) return;
  for (const key of event.changedKeys) {
    const trigger = triggerByCacheKey.get(String(key));
    if (!trigger) continue;
    if (!armedTriggers.has(String(key))) {
      armedTriggers.add(String(key));
      continue;
    }
    if (trigger.type === 'event') {
      const current = bus.getCache().get(String(key));
      if (!current || !valuesEqual(current.value, literal(trigger.config.value))) continue;
    }
    queueCondition(trigger.conditionId);
  }
}

function localParts(now) {
  const parts = timeHandler.calendar(new Date(now));
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return { ...parts, weekday, minuteKey: `${parts.dateKey}T${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}` };
}

async function fireTimeTrigger(condition, trigger, now) {
  trigger.lastFiredAt = now;
  await repository.markItemFired(database, trigger.id, now).catch(() => {});
  queueCondition(condition.id);
}

async function checkTimeTriggers(now = Date.now()) {
  if (!database || reloading) return;
  const local = localParts(now);
  for (const condition of conditions) {
    if (!condition.enabled) continue;
    for (const trigger of condition.triggers.filter((item) => item.type === 'time')) {
      const config = trigger.config;
      if (config.mode === 'interval') {
        const remembered = intervalBaselines.get(trigger.id);
        const baseline = trigger.lastFiredAt || (remembered && remembered.at) || loadedAt;
        if (now - baseline >= Number(config.intervalSeconds || 0) * 1000) await fireTimeTrigger(condition, trigger, now);
        continue;
      }
      if (!(config.weekdays || []).includes(local.weekday) || config.time !== `${String(local.hours).padStart(2, '0')}:${String(local.minutes).padStart(2, '0')}`) continue;
      const previous = trigger.lastFiredAt ? localParts(trigger.lastFiredAt).minuteKey : '';
      if (previous !== local.minuteKey) await fireTimeTrigger(condition, trigger, now);
    }
  }
}

function clearSubscriptions() {
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  for (const key of subscriptions) mqttClient.unsubscribeAdHoc(key);
  subscriptions = new Set(); triggerByCacheKey = new Map(); armedTriggers.clear();
}

async function reload() {
  if (!database) return [];
  reloading = true;
  try {
    clearSubscriptions();
    conditions = await repository.listConditions(database);
    loadedAt = Date.now();
    const currentIntervalIds = new Set();
    for (const condition of conditions) {
      for (const trigger of condition.triggers) {
        if (trigger.type !== 'time' || trigger.config.mode !== 'interval') continue;
        currentIntervalIds.add(trigger.id);
        const signature = String(trigger.config.intervalSeconds || '');
        const remembered = intervalBaselines.get(trigger.id);
        if (!trigger.lastFiredAt && (!remembered || remembered.signature !== signature)) {
          intervalBaselines.set(trigger.id, { at: loadedAt, signature });
        }
      }
      for (const item of [...condition.triggers, ...condition.whens]) {
        if (!item.config.topic) continue;
        const key = cacheKey(item);
        mqttClient.subscribeAdHoc(item.config.topic, key);
        subscriptions.add(key);
        if (item.kind === 'trigger') {
          triggerByCacheKey.set(key, item);
          // Scheme-/System-Routen liefern bekannte Retained-Werte synchron beim
          // Registrieren. Dieses erste Sample ist nur die Ausgangsbasis.
          if (bus.getCache().has(key)) armedTriggers.add(key);
        }
      }
    }
    for (const id of intervalBaselines.keys()) if (!currentIntervalIds.has(id)) intervalBaselines.delete(id);
    armTimer = setTimeout(() => {
      armTimer = null;
      for (const key of triggerByCacheKey.keys()) armedTriggers.add(key);
    }, TRIGGER_ARM_MS);
    if (typeof armTimer.unref === 'function') armTimer.unref();
    return conditions;
  } finally { reloading = false; }
}

async function init(db) {
  database = db;
  if (!unsubscribeBus) unsubscribeBus = bus.onValuesChanged(onValues);
  await reload();
  if (!timer) {
    timer = setInterval(() => checkTimeTriggers().catch(() => {}), TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

function stop() {
  if (timer) clearInterval(timer);
  if (armTimer) clearTimeout(armTimer);
  if (pendingTimer) clearTimeout(pendingTimer);
  if (unsubscribeBus) unsubscribeBus();
  timer = null; pendingTimer = null; armTimer = null; unsubscribeBus = null; database = null; conditions = []; pending.clear(); running.clear(); executionHistory.clear(); blockedUntil.clear(); intervalBaselines.clear(); clearSubscriptions();
}

function getRuntime() { return conditions; }

module.exports = { init, reload, stop, getRuntime, evaluateCondition, checkTimeTriggers, compare, valuesEqual, literal, cacheKey };
