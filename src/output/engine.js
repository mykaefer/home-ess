'use strict';

// Geschlossene Output-Regelschleife: Ein gesendeter Wert gilt erst dann als
// erfolgreich, wenn ioBroker ihn auf dem Ziel-State bestätigt zurückmeldet.
// Eigene ack:false-Schreib-Echos werden bereits im MQTT-Client verworfen.

const mqttClient = require('../mqtt/client');
const { normalizeMqttTopic, isCommandTopic } = require('../mqtt/topics');
const { listOutputs } = require('./outputs');
const { listInternalValues } = require('./internal-values');
const metrics = require('../runtime-metrics');

const DEBOUNCE_MS = 1000;
const VERIFY_MS = 30000;
// Prüf-Ticker: verteilt die /get-Anfragen der einzelnen Outputs über das
// Prüffenster, statt alle gleichzeitig alle VERIFY_MS zu senden.
const VERIFY_TICK_MS = 1000;
const RETRY_MS = 10000;

let database = null;
let outputs = [];
let lastAttempts = new Map(); // outputId -> { value, at }
let statuses = new Map(); // outputId -> { state, desired, actual, checkedAt }
let registeredReadbacks = new Map(); // cacheKey -> topic
let verificationRequestedAt = new Map(); // cacheKey -> Zeitpunkt der letzten /get-Anfrage
let verificationDueAt = new Map(); // cacheKey -> nächster geplanter /get-Zeitpunkt (zufällig übers Fenster verteilt)
let unsubscribe = null;
let debounceTimer = null;
let verifyTimer = null;
let verifyEvaluateTimer = null;
let evaluating = false;

function readbackKey(topic) {
  return `output.readback:${normalizeMqttTopic(topic)}`;
}

function comparable(value) {
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
  const text = String(value == null ? '' : value).trim();
  const lower = text.toLowerCase();
  if (lower === 'true' || lower === 'false') return { type: 'boolean', value: lower === 'true' };
  if (text !== '' && Number.isFinite(Number(text.replace(',', '.')))) {
    return { type: 'number', value: Number(text.replace(',', '.')) };
  }
  return { type: 'string', value: text };
}

function valuesEqual(actual, desired) {
  const left = comparable(actual);
  const right = comparable(desired);
  if (left.type === 'number' && right.type === 'number') {
    return Math.abs(left.value - right.value) <= 0.000001;
  }
  if (left.type === 'boolean' && right.type === 'number') return Number(left.value) === right.value;
  if (left.type === 'number' && right.type === 'boolean') return left.value === Number(right.value);
  if (left.type === 'boolean' && right.type === 'boolean') return left.value === right.value;
  return String(left.value) === String(right.value);
}

function mayRetry(outputId, desired, now) {
  const previous = lastAttempts.get(outputId);
  return !previous || !valuesEqual(previous.value, desired) || now - previous.at >= RETRY_MS;
}

async function evaluate() {
  if (!database || evaluating) {
    if (evaluating) metrics.counter('output.coalesced');
    return;
  }
  evaluating = true;
  try {
    if (!outputs.length) return;
    const values = await metrics.measure('output.catalog', () => listInternalValues(database, mqttClient.getCache()));
    const byId = new Map(values.map((entry) => [entry.id, entry]));
    const cache = mqttClient.getCache();
    const connected = mqttClient.getStatus().connected;
    const now = Date.now();

    for (const output of outputs) {
      if (isCommandTopic(output.targetTopic)) {
        statuses.set(output.id, { state: 'unsupported', desired: null, actual: null, checkedAt: now });
        continue;
      }
      const entry = byId.get(output.sourceId);
      if (!entry || entry.value == null) {
        statuses.set(output.id, { state: 'no-value', desired: null, actual: null, checkedAt: now });
        continue;
      }
      const readback = cache.get(readbackKey(output.targetTopic));
      const actual = readback ? readback.value : null;
      const requestedAt = verificationRequestedAt.get(readbackKey(output.targetTopic)) || 0;
      const freshReadback = readback && Number(readback.receivedAt || 0) >= requestedAt;
      if (freshReadback && valuesEqual(actual, entry.value)) {
        statuses.set(output.id, { state: 'confirmed', desired: entry.value, actual, checkedAt: now });
        continue;
      }

      const state = connected ? (freshReadback ? 'mismatch' : 'waiting') : 'disconnected';
      statuses.set(output.id, { state, desired: entry.value, actual, checkedAt: now });
      if (!connected || !mayRetry(output.id, entry.value, now)) continue;
      if (mqttClient.publish(output.targetTopic, entry.value)) {
        lastAttempts.set(output.id, { value: entry.value, at: now });
      }
    }
  } finally {
    evaluating = false;
  }
}

function scheduleEvaluate() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    metrics.measure('output.evaluate', evaluate).catch(() => {});
  }, DEBOUNCE_MS);
}

function evaluateReadbacks(changedKeys) {
  const cache = mqttClient.getCache();
  const connected = mqttClient.getStatus().connected;
  const now = Date.now();
  let needsCatalog = false;
  for (const cacheKey of changedKeys) {
    const readback = cache.get(cacheKey);
    const requestedAt = verificationRequestedAt.get(cacheKey) || 0;
    const fresh = readback && Number(readback.receivedAt || 0) >= requestedAt;
    for (const output of outputs) {
      if (readbackKey(output.targetTopic) !== cacheKey) continue;
      const previous = statuses.get(output.id);
      if (!previous || previous.desired == null) {
        needsCatalog = true;
        continue;
      }
      const actual = readback ? readback.value : null;
      if (fresh && valuesEqual(actual, previous.desired)) {
        statuses.set(output.id, { state: 'confirmed', desired: previous.desired, actual, checkedAt: now });
        continue;
      }
      statuses.set(output.id, {
        state: connected ? (fresh ? 'mismatch' : 'waiting') : 'disconnected',
        desired: previous.desired, actual, checkedAt: now,
      });
      if (connected && mayRetry(output.id, previous.desired, now) &&
          mqttClient.publish(output.targetTopic, previous.desired)) {
        lastAttempts.set(output.id, { value: previous.desired, at: now });
      }
    }
  }
  if (needsCatalog) scheduleEvaluate();
}

function handleValuesChanged(event) {
  const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys.map(String) : [];
  if (keys.length && keys.every((key) => key.startsWith('output.readback:'))) {
    metrics.counter('output.readbackFastPath');
    evaluateReadbacks(keys);
    return;
  }
  scheduleEvaluate();
}

// Ob ein Readback aktuell aktiv per /get abgefragt werden muss. Der Prüfschritt
// entfällt nur, wenn ALLE zugehörigen Outputs bestätigt sind UND der bestätigte
// Ist-Wert innerhalb des letzten Prüffensters (VERIFY_MS) empfangen wurde. Ist der
// angezeigte Wert älter als ein Prüffenster, wird weiterhin aktiv nachgefragt –
// er könnte inzwischen veraltet sein. now/cache/outputList/statusMap sind
// parametrisierbar, damit die Entscheidung isoliert testbar ist; im Betrieb
// greifen die Modul-Zustände.
function readbackNeedsVerification(
  cacheKey,
  now = Date.now(),
  cache = mqttClient.getCache(),
  outputList = outputs,
  statusMap = statuses
) {
  let hasReadbackOutput = false;
  for (const output of outputList) {
    if (isCommandTopic(output.targetTopic)) continue;
    if (readbackKey(output.targetTopic) !== cacheKey) continue;
    hasReadbackOutput = true;
    const status = statusMap.get(output.id);
    if (!status || status.state !== 'confirmed') return true;
  }
  if (!hasReadbackOutput) return false;
  const readback = cache && cache.get(cacheKey);
  const receivedAt = readback ? Number(readback.receivedAt || 0) : 0;
  return now - receivedAt > VERIFY_MS;
}

// Vergibt einem Readback einen zufälligen Prüfzeitpunkt innerhalb des Prüffensters,
// damit nicht alle Outputs im selben Moment ein /get senden und den Broker
// intervallweise stark belasten.
function scheduleVerification(cacheKey, now = Date.now()) {
  verificationDueAt.set(cacheKey, now + Math.floor(Math.random() * VERIFY_MS));
}

// Prüf-Ticker (läuft alle VERIFY_TICK_MS): fragt nur die gerade fälligen und noch
// nicht bestätigten Readbacks per /get ab und plant den nächsten Slot je Readback,
// wodurch der ursprüngliche zufällige Phasenversatz erhalten bleibt.
function verifyTick() {
  const now = Date.now();
  const requestedKeys = [];
  for (const cacheKey of registeredReadbacks.keys()) {
    const dueAt = verificationDueAt.get(cacheKey);
    if (dueAt == null) {
      scheduleVerification(cacheKey, now);
      continue;
    }
    if (dueAt > now) continue;
    verificationDueAt.set(cacheKey, now + VERIFY_MS);
    if (!readbackNeedsVerification(cacheKey, now)) continue;
    if (mqttClient.requestAdHocValue(cacheKey)) {
      verificationRequestedAt.set(cacheKey, now);
      requestedKeys.push(cacheKey);
    }
  }
  if (!requestedKeys.length) return;
  if (verifyEvaluateTimer) clearTimeout(verifyEvaluateTimer);
  // Kurzes Fenster für die Broker-Antwort; eingehende Werte lösen zusätzlich
  // selbst eine entprellte Auswertung aus.
  verifyEvaluateTimer = setTimeout(() => {
    verifyEvaluateTimer = null;
    evaluateReadbacks(requestedKeys);
  }, 1000);
}

async function reload() {
  if (!database) return [];
  const nextOutputs = await listOutputs(database);
  const needed = new Map();
  for (const output of nextOutputs) {
    if (!isCommandTopic(output.targetTopic)) needed.set(readbackKey(output.targetTopic), output.targetTopic);
  }

  for (const cacheKey of registeredReadbacks.keys()) {
    if (!needed.has(cacheKey)) mqttClient.unsubscribeAdHoc(cacheKey);
  }
  for (const [cacheKey, topic] of needed) {
    if (!registeredReadbacks.has(cacheKey)) mqttClient.subscribeAdHoc(topic, cacheKey);
  }
  registeredReadbacks = needed;
  verificationRequestedAt = new Map();
  // Verifikations-Slots pflegen: neue Readbacks zufällig übers Prüffenster
  // verteilen, entfernte herausnehmen; bestehende behalten ihren Phasenversatz.
  for (const cacheKey of needed.keys()) {
    if (!verificationDueAt.has(cacheKey)) scheduleVerification(cacheKey);
  }
  for (const cacheKey of [...verificationDueAt.keys()]) {
    if (!needed.has(cacheKey)) verificationDueAt.delete(cacheKey);
  }
  outputs = nextOutputs;
  lastAttempts = new Map();
  statuses = new Map();
  return outputs;
}

async function init(db) {
  database = db;
  await reload();
  if (!unsubscribe) unsubscribe = mqttClient.onValuesChanged(handleValuesChanged);
  if (!verifyTimer) verifyTimer = setInterval(verifyTick, VERIFY_TICK_MS);
  evaluate().catch(() => {});
}

function getStatus(outputId) {
  return statuses.get(Number(outputId)) || { state: 'waiting', desired: null, actual: null, checkedAt: null };
}

module.exports = { init, reload, evaluate, evaluateReadbacks, handleValuesChanged, verifyTick, readbackNeedsVerification, readbackKey, getStatus, valuesEqual };
