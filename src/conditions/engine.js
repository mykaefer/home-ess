'use strict';

const bus = require('../state-bus');
const mqttClient = require('../mqtt/client');
const timeHandler = require('../time-handler');
const repository = require('./repository');
const values = require('./values');

// Der Action-Runner führt die Dann-/Sonst-Folgen aus (geteilt mit den
// Aktionsfolgen der Module). Er wird bewusst erst beim ersten Gebrauch geladen:
// action-runner.js greift seinerseits auf diese Engine zu, und ein Require zur
// Ladezeit bekäme deren Exporte noch nicht vollständig zu sehen.
let runner = null;
function actionRunner() {
  if (!runner) runner = require('../automation/action-runner').createActionRunner('conditions');
  return runner;
}

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
// Schleifen mit zyklischer Prüfung: flache Liste über alle Bedingungen, dazu
// der Zeitpunkt der letzten Prüfung/Ausführung je Schleife.
let loops = [];
const loopBaselines = new Map();
// Zuletzt ausgeführter Zweig je Bedingung ('then' oder 'else'). Nur dessen
// Schleifen werden zyklisch geprüft – sonst würden Dann und Sonst einander
// dauerhaft überschreiben. Nach einem Neustart bleibt die Prüfung aus, bis die
// Bedingung einmal gelaufen ist.
const lastBranch = new Map();

// Das Element selbst hat den Basisschlüssel; Vergleichs- und Zielwerte, die auf
// ein Topic verweisen, bekommen je Feld einen eigenen Abo-Schlüssel.
function cacheKey(item, slot) { return `condition:${item.conditionId}:item:${item.id}${slot ? `:${slot}` : ''}`; }

// Felder, deren Inhalt wahlweise ein fester Wert oder ein Topic-Verweis ist.
function valueSlots(item) {
  if (item.kind === 'when') return ['truthy', 'falsy'].includes(item.config.operator) ? [] : ['value'];
  if (item.kind === 'then' || item.kind === 'else') {
    return (item.config.operation || 'set') === 'set' ? ['value'] : ['value', 'value2'];
  }
  return [];
}

function referencedSlots(item) {
  return valueSlots(item).filter((slot) => values.isTopicReference(item.config[slot]));
}

// Feste Eingaben werden wie bisher als Literal gelesen; Topic-Verweise liefern
// den zuletzt bekannten Wert des Ziel-States.
function operandValue(item, slot) {
  const raw = item.config[slot];
  if (!values.isTopicReference(raw)) return { known: true, value: literal(raw), topic: null };
  const entry = bus.getCache().get(cacheKey(item, slot));
  return { known: !!entry, value: entry ? entry.value : null, topic: String(raw).trim() };
}

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

// Ergebnis einer Wenn-Zeile: erfüllt, nicht erfüllt oder „unbekannt“, wenn ein
// beteiligter State noch keinen Wert geliefert hat. Unbekannt führt bewusst
// weder in den Dann- noch in den Sonst-Zweig.
function checkWhen(item) {
  const current = cachedValue(item);
  if (!current.known) return { known: false, topic: item.config.topic };
  const operator = item.config.operator;
  if (['truthy', 'falsy'].includes(operator)) return { known: true, passed: compare(current.value, operator) };
  const expected = operandValue(item, 'value');
  if (!expected.known) return { known: false, topic: expected.topic };
  // Ein nicht numerischer Wert ist bei größer/kleiner ein Konfigurations- oder
  // Datenfehler und darf nicht stillschweigend als „nicht erfüllt“ durchgehen.
  if (values.isMathOperator(operator)) {
    let source = null;
    if (values.toNumber(current.value) == null) source = item.config.topic;
    else if (values.toNumber(expected.value) == null) source = expected.topic || item.config.value;
    if (source) throw new Error(`Wert muss bei mathematischen Operatoren numerisch sein: ${source}`);
  }
  return { known: true, passed: compare(current.value, operator, expected.value) };
}

// Zu schreibender Wert einer Dann-/Sonst-Aktion: fester Wert, Topic-Wert oder
// das Ergebnis der gewählten Rechenfunktion, optional gerundet.
function actionValue(item) {
  const config = item.config;
  const operation = config.operation || 'set';
  const round = config.round == null ? null : Number(config.round);
  const first = operandValue(item, 'value');
  if (!first.known) throw new Error(`Kein Wert für ${first.topic} verfügbar.`);
  if (operation === 'set') {
    if (round == null) return first.value;
    const number = values.toNumber(first.value);
    if (number == null) throw new Error(`Wert muss zum Runden numerisch sein: ${first.topic || config.value}`);
    return values.roundTo(number, round);
  }
  const second = operandValue(item, 'value2');
  if (!second.known) throw new Error(`Kein Wert für ${second.topic} verfügbar.`);
  const left = values.toNumber(first.value);
  const right = values.toNumber(second.value);
  if (left == null) throw new Error(`Wert muss bei mathematischen Operatoren numerisch sein: ${first.topic || config.value}`);
  if (right == null) throw new Error(`Wert muss bei mathematischen Operatoren numerisch sein: ${second.topic || config.value2}`);
  return values.roundTo(values.applyOperation(operation, left, right), round);
}

// Einen Zweig als Aktionsfolge abarbeiten: Werte zuweisen, Pausen abwarten,
// Schleifen mehrfach durchlaufen — von oben nach unten. Die Bedingung bleibt
// währenddessen in `running` und löst nicht erneut aus; erst danach ist sie
// wieder frei.
async function runBranch(condition, kind) {
  const list = (kind === 'else' ? condition.elseTree : condition.thenTree) || [];
  const result = await actionRunner().run(`${condition.id}:${kind}`, list);
  lastBranch.set(condition.id, kind);
  return result;
}

function actionSummary(prefix, count) {
  return `${prefix}: ${count} Aktion${count === 1 ? '' : 'en'}`;
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
    // Ohne aktive Wenn-Prüfung läuft der Dann-Zweig bedingungslos.
    const checks = condition.whenEnabled === false ? [] : condition.whens;
    let failed = null;
    for (const item of checks) {
      const outcome = checkWhen(item);
      if (!outcome.known) {
        const result = `Nicht ausgeführt: kein Wert für ${outcome.topic}`;
        await repository.markTriggered(database, condition.id, result, '', now);
        condition.lastTriggeredAt = now; condition.lastResult = result; condition.lastError = '';
        return false;
      }
      if (!outcome.passed) { failed = item; break; }
    }
    if (failed) {
      const elses = condition.elses || [];
      if (!elses.length) {
        const result = `Nicht ausgeführt: ${failed.description}`;
        await repository.markTriggered(database, condition.id, result, '', now);
        condition.lastTriggeredAt = now; condition.lastResult = result; condition.lastError = '';
        return false;
      }
      await runBranch(condition, 'else');
      const result = actionSummary('Sonst ausgeführt', elses.length);
      await repository.markTriggered(database, condition.id, result, '', now);
      condition.lastTriggeredAt = now; condition.lastResult = result; condition.lastError = '';
      return true;
    }
    await runBranch(condition, 'then');
    const result = actionSummary('Ausgeführt', condition.thens.length);
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

// Eine Schleife nach nicht erfüllter Prüfung erneut abspulen – nur diese
// Schleife, nicht der übrige Zweig.
async function rerunLoop(entry) {
  const condition = conditions.find((item) => item.id === entry.conditionId);
  try {
    const result = await actionRunner().runLoopOnce(entry.loop);
    if (result.status !== 'done' || !database) return;
    const message = `${entry.kind === 'else' ? 'Sonst' : 'Dann'}: Schleife nach Prüfung wiederholt`;
    await repository.markTriggered(database, entry.conditionId, message, '').catch(() => {});
    if (condition) { condition.lastTriggeredAt = Date.now(); condition.lastResult = message; condition.lastError = ''; }
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 1000);
    if (database) await repository.markTriggered(database, entry.conditionId, 'Fehler', message).catch(() => {});
    if (condition) { condition.lastTriggeredAt = Date.now(); condition.lastResult = 'Fehler'; condition.lastError = message; }
  } finally {
    loopBaselines.set(entry.loop.id, Date.now());
  }
}

// Zyklische Plausibilitätsprüfung der Schleifen: im eingestellten Abstand wird
// die Bedingung erneut bewertet; trifft sie nicht zu, läuft die Schleife noch
// einmal. Geprüft wird nur der Zweig, der zuletzt ausgeführt wurde.
async function checkLoops(now = Date.now()) {
  if (!database || reloading) return;
  for (const entry of loops) {
    const config = entry.loop.config || {};
    if (!config.checkEnabled || !config.check) continue;
    const condition = conditions.find((item) => item.id === entry.conditionId);
    if (!condition || !condition.enabled) continue;
    // Ohne Trigger ist die zyklische Prüfung selbst die Ausführungsbedingung:
    // der Dann-Zweig gilt dann von Anfang an als der maßgebliche. Mit Trigger
    // bleibt es beim zuletzt gelaufenen Zweig, damit Dann und Sonst einander
    // nicht dauerhaft überschreiben.
    const branch = lastBranch.get(entry.conditionId)
      || (condition.triggers.length ? null : 'then');
    if (branch !== entry.kind) continue;
    const intervalMs = Number(config.checkIntervalSeconds || 0) * 1000;
    if (!(intervalMs > 0)) continue;
    const baseline = loopBaselines.get(entry.loop.id);
    if (baseline == null) { loopBaselines.set(entry.loop.id, loadedAt); continue; }
    if (now - baseline < intervalMs) continue;
    loopBaselines.set(entry.loop.id, now);
    // Läuft der Zweig gerade vollständig, hat er Vorrang.
    if (running.has(condition.id)) continue;
    if (actionRunner().isBusy(`${condition.id}:${entry.kind}`) || actionRunner().isLoopBusy(entry.loop.id)) continue;
    if (actionRunner().checkFulfilled(entry.loop)) continue;
    rerunLoop(entry).catch(() => {});
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
    loops = [];
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
      // Vergleichswerte dürfen selbst auf ein Topic verweisen; diese Quellen
      // werden mitgelesen, lösen aber keine Auswertung aus.
      for (const item of condition.whens) {
        for (const slot of referencedSlots(item)) {
          const key = cacheKey(item, slot);
          mqttClient.subscribeAdHoc(String(item.config[slot]).trim(), key);
          subscriptions.add(key);
        }
      }
      // Dann und Sonst sind Aktionsfolgen: Ziel-/Zweitwerte einer Zuweisung und
      // die Prüfbedingung einer Schleife liest der Action-Runner unter seinen
      // eigenen Schlüsseln.
      for (const kind of ['then', 'else']) {
        const tree = (kind === 'else' ? condition.elseTree : condition.thenTree) || [];
        for (const action of repository.collectActionNodes(tree)) {
          for (const [slot, topic] of actionRunner().referencedSlots(action)) {
            const key = actionRunner().cacheKey(action.id, slot);
            mqttClient.subscribeAdHoc(topic, key);
            subscriptions.add(key);
          }
          if (action.type === 'loop' && action.config && action.config.checkEnabled) {
            loops.push({ conditionId: condition.id, kind, loop: action });
          }
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
    // Der Prüfabstand einer neu geladenen Schleife zählt ab dem Ladezeitpunkt.
    const currentLoopIds = new Set(loops.map((entry) => entry.loop.id));
    for (const id of [...loopBaselines.keys()]) if (!currentLoopIds.has(id)) loopBaselines.delete(id);
    for (const entry of loops) if (!loopBaselines.has(entry.loop.id)) loopBaselines.set(entry.loop.id, loadedAt);
    const currentConditionIds = new Set(conditions.map((entry) => entry.id));
    for (const id of [...lastBranch.keys()]) if (!currentConditionIds.has(id)) lastBranch.delete(id);
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
    timer = setInterval(() => {
      checkTimeTriggers().catch(() => {});
      checkLoops().catch(() => {});
    }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

function stop() {
  if (timer) clearInterval(timer);
  if (armTimer) clearTimeout(armTimer);
  if (pendingTimer) clearTimeout(pendingTimer);
  if (unsubscribeBus) unsubscribeBus();
  timer = null; pendingTimer = null; armTimer = null; unsubscribeBus = null; database = null; conditions = []; loops = []; pending.clear(); running.clear(); executionHistory.clear(); blockedUntil.clear(); intervalBaselines.clear(); loopBaselines.clear(); lastBranch.clear(); if (runner) runner.reset(); clearSubscriptions();
}

function getRuntime() { return conditions; }

module.exports = { init, reload, stop, getRuntime, evaluateCondition, checkTimeTriggers, checkLoops, compare, valuesEqual, literal, cacheKey };
