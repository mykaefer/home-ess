'use strict';

// Verteilt veröffentlichte Systemwerte an alle konfigurierten State-Definitionen,
// die ein system://homeess/...-Topic als Quelle verwenden.

const bus = require('../state-bus');
const { topicForId, parseSystemTopic } = require('./system-topics');

const routes = new Map(); // systemTopic -> Set<cacheKey>
// Berechnete Systemwerte sind reine Lesequellen. Module dürfen einzelne ihrer
// Werte dennoch als Schreibziel anbieten (z. B. die Soll-Temperatur eines
// Raums); sie melden dafür ein id-Präfix mit Schreibfunktion an.
const writers = new Map(); // id-Präfix -> handler(id, value)

function registerRoute(topic, cacheKey) {
  const parsed = parseSystemTopic(topic);
  if (!parsed || cacheKey == null) return false;
  if (!routes.has(parsed.topic)) routes.set(parsed.topic, new Set());
  routes.get(parsed.topic).add(String(cacheKey));
  const cached = bus.getCache().get(parsed.topic);
  if (cached) bus.ingest(String(cacheKey), cached.value, { receivedAt: cached.receivedAt, topic: parsed.topic });
  return true;
}

function unregisterRoute(topic, cacheKey) {
  const parsed = parseSystemTopic(topic);
  if (!parsed) return;
  const targets = routes.get(parsed.topic);
  if (!targets) return;
  targets.delete(String(cacheKey));
  if (!targets.size) routes.delete(parsed.topic);
}

function registerWriter(prefix, handler) {
  if (!prefix || typeof handler !== 'function') return;
  writers.set(String(prefix), handler);
}

function unregisterWriter(prefix) {
  writers.delete(String(prefix));
}

// Schreibwunsch an ein system://homeess/...-Topic. Liefert false, wenn für die
// id kein Schreibziel angemeldet ist — dann bleibt der Wert schreibgeschützt.
function write(topic, value) {
  const parsed = parseSystemTopic(topic);
  if (!parsed) return false;
  for (const [prefix, handler] of writers) {
    if (!parsed.id.startsWith(prefix)) continue;
    try {
      handler(parsed.id, value);
    } catch (_) {
      return false;
    }
    return true;
  }
  return false;
}

function publish(values, receivedAt = Date.now()) {
  const items = [];
  for (const entry of values || []) {
    const topic = topicForId(entry.id);
    if (!topic) continue;
    items.push({
      cacheKeys: [topic, ...(routes.get(topic) || [])],
      value: entry.value,
    });
  }
  return bus.ingestBatch(items, { topic: 'system://homeess', receivedAt });
}

function clear() {
  routes.clear();
}

module.exports = { registerRoute, unregisterRoute, registerWriter, unregisterWriter, write, publish, clear };
