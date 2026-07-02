'use strict';

// Gemeinsamer Wert-Bus für homeESS. Hält den zentralen Wert-Cache und verteilt
// Änderungen als Event. Sowohl der MQTT-Broker-Client (mqtt/client.js) als auch
// die Adapter (über adapters/router.js) schreiben hier hinein; alle Konsumenten
// (SSE /live, Output-Engine, Dashboard) lesen aus genau diesem Cache und hängen
// sich an genau dieses Event. So bleibt es egal, ob ein Wert vom Broker oder von
// einem Adapter stammt.

const { EventEmitter } = require('events');

const valueCache = new Map(); // cacheKey -> { value, receivedAt }
const events = new EventEmitter();
events.setMaxListeners(0);

// Einen Wert für einen Cache-Schlüssel ablegen. Gibt true zurück, wenn ein Wert
// gesetzt wurde (immer der Fall) – der Aufrufer entscheidet über das Event.
function set(cacheKey, value, receivedAt = Date.now()) {
  valueCache.set(cacheKey, { value, receivedAt });
}

// Prüft, ob sich ein Wert gegenüber dem Cache tatsächlich geändert hat. Fehlt der
// Schlüssel bisher, gilt das als Änderung. Der String-Vergleich fängt harmlose
// Repräsentationswechsel (z. B. 42 vs "42") ab, ohne echte Änderungen zu schlucken.
function isChanged(prev, value) {
  if (prev === undefined) return true;
  return !Object.is(prev.value, value) && String(prev.value) !== String(value);
}

// Mehrere Cache-Schlüssel auf denselben Wert setzen und ein 'values'-Event mit den
// tatsächlich GEÄNDERTEN Schlüsseln auslösen. Der Cache (inkl. receivedAt) wird
// immer aktualisiert – so bleibt die Ist-Wert-Frische für die Readback-
// Verifikation erhalten –, das Event feuert aber nur bei echter Wertänderung.
//
// Das ist bewusst so: Ein Event bei jedem ingest (auch unverändert) erzeugt eine
// Rückkopplung, sobald ein Konsument auf ein Adapter-Topic zurückschreibt
// (write → Adapter-Echo → ingest → Event → write → …). „Nur bei Änderung liefern"
// entspricht dem gewünschten Broker-Verhalten und bricht diese Schleife.
function ingest(cacheKeys, value, meta = {}) {
  const keys = Array.isArray(cacheKeys) ? cacheKeys : [cacheKeys];
  const receivedAt = meta.receivedAt || Date.now();
  const changedKeys = [];
  for (const key of keys) {
    if (key == null) continue;
    if (isChanged(valueCache.get(key), value)) changedKeys.push(key);
    valueCache.set(key, { value, receivedAt });
  }
  if (changedKeys.length) {
    events.emit('values', { topic: meta.topic, changedKeys, receivedAt });
  }
  return changedKeys;
}

// Mehrere unterschiedliche Werte als einen gemeinsamen Burst übernehmen. Das
// aktualisiert die Frische jedes Keys, erzeugt aber höchstens ein Bus-Event.
function ingestBatch(items, meta = {}) {
  const receivedAt = meta.receivedAt || Date.now();
  const changedKeys = [];
  for (const item of items || []) {
    const keys = Array.isArray(item.cacheKeys) ? item.cacheKeys : [item.cacheKeys];
    for (const key of keys) {
      if (key == null) continue;
      if (isChanged(valueCache.get(key), item.value)) changedKeys.push(key);
      valueCache.set(key, { value: item.value, receivedAt });
    }
  }
  if (changedKeys.length) events.emit('values', { topic: meta.topic, changedKeys, receivedAt });
  return changedKeys;
}

function getCache() {
  return valueCache;
}

function remove(cacheKey) {
  valueCache.delete(cacheKey);
}

function onValuesChanged(listener) {
  events.on('values', listener);
  return () => events.off('values', listener);
}

module.exports = { set, ingest, ingestBatch, getCache, remove, onValuesChanged };
