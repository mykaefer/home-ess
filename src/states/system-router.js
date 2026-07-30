'use strict';

// Verteilt veröffentlichte Systemwerte an alle konfigurierten State-Definitionen,
// die ein system://homeess/...-Topic als Quelle verwenden.

const bus = require('../state-bus');
const { topicForId, parseSystemTopic } = require('./system-topics');

const routes = new Map(); // systemTopic -> Set<cacheKey>

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

module.exports = { registerRoute, unregisterRoute, publish, clear };
