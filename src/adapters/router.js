'use strict';

// Prefix-Router für Adapter-Topics (prefix://instanz/adresse). Spiegelt die
// Routing-Logik des MQTT-Clients (topicRoutes/adhocRoutes) für Adapter wider:
// Konfigurierte States und Ad-hoc-Abos registrieren hier einen Cache-Schlüssel
// für ein kanonisches Topic; meldet ein Adapter (über den Host) einen Wert, wird
// dieser in den gemeinsamen state-bus geschrieben und an alle Schlüssel verteilt.
//
// Der Host (adapters/host.js) registriert sich als Sink für ausgehende Aktionen
// (write/read an die jeweilige Instanz) via setHost().

const bus = require('../state-bus');
const { parseSchemeTopic, buildSchemeTopic } = require('../mqtt/topics');

// kanonisches Topic -> Set<cacheKey>
const routes = new Map();
// schema (prefix) -> adapterId – wird beim Laden der Registry gefüllt.
const schemes = new Map();

// Host-Anbindung (gesetzt von host.init). Erlaubt write/read an eine Instanz.
let host = null;
function setHost(nextHost) {
  host = nextHost;
}

// Virtuelle Instanzen: interne Module (z. B. die Schaltgruppen von Messen +
// Schalten) stellen eigene Scheme-Topics bereit, ohne ein Adapter-Prozess zu
// sein. write/read solcher Topics laufen an die registrierten Handler statt an
// den Host; Werte melden die Module selbst über ingestFromInstance.
const virtualInstances = new Map(); // instanceName -> { write?, read? }
function registerVirtualInstance(instanceName, scheme, handlers) {
  virtualInstances.set(String(instanceName), handlers || {});
  setInstanceScheme(instanceName, scheme);
}
function unregisterVirtualInstance(instanceName) {
  virtualInstances.delete(String(instanceName));
  removeInstanceScheme(instanceName);
}

function registerScheme(scheme, adapterId) {
  schemes.set(String(scheme).toLowerCase(), adapterId);
}
function clearSchemes() {
  schemes.clear();
}
function adapterIdForScheme(scheme) {
  return schemes.get(String(scheme).toLowerCase()) || null;
}

// Kanonisches Topic einer beliebigen Schreibweise. Gibt null zurück, wenn es kein
// Schema-Topic ist.
function canonicalTopic(topic) {
  const parsed = parseSchemeTopic(topic);
  if (!parsed) return null;
  return buildSchemeTopic(parsed.scheme, parsed.instance, parsed.address);
}

// Retained-Delivery wie bei einem MQTT-Broker: Den zuletzt bekannten Wert des
// kanonischen Topics sofort in den neuen Cache-Schlüssel spiegeln und das Bus-
// Event auslösen. So bekommt ein frisch registrierter Abonnent umgehend einen
// Wert, ohne auf den nächsten Adapter-Tick oder eine (optionale) read()-
// Implementierung zu warten. Ohne bekannten Wert passiert nichts (no-op).
function deliverRetained(canonical, cacheKey) {
  if (canonical === cacheKey) return; // kanonischer Key trägt den Wert bereits
  const cached = bus.getCache().get(canonical);
  if (!cached) return;
  bus.ingest([cacheKey], cached.value, { topic: canonical, receivedAt: cached.receivedAt });
}

// Einen Cache-Schlüssel an ein Adapter-Topic binden. Liefert true, wenn es ein
// Adapter-Topic war (und somit nicht über den Broker laufen soll).
function registerRoute(topic, cacheKey) {
  const canonical = canonicalTopic(topic);
  if (!canonical) return false;
  const key = String(cacheKey);
  const keys = routes.get(canonical) || new Set();
  keys.add(key);
  routes.set(canonical, keys);
  // Zuerst den retained-Wert durchreichen (funktioniert immer, sobald der Adapter
  // einmal gemeldet hat) …
  deliverRetained(canonical, key);
  // … und zusätzlich aktiv einen frischen Wert anfordern (falls read() vorhanden).
  requestValue(topic);
  return true;
}

function unregisterRoute(topic, cacheKey) {
  const canonical = canonicalTopic(topic);
  if (!canonical) return false;
  const keys = routes.get(canonical);
  if (keys) {
    keys.delete(String(cacheKey));
    if (!keys.size) routes.delete(canonical);
  }
  return true;
}

// Wert an ein Adapter-Topic schreiben (an die zuständige Instanz). Liefert true,
// wenn das Topic ein Adapter-Topic ist (unabhängig davon, ob der Adapter läuft).
function write(topic, value) {
  const parsed = parseSchemeTopic(topic);
  if (!parsed) return false;
  const virtual = virtualInstances.get(parsed.instance);
  if (virtual) {
    if (typeof virtual.write === 'function') virtual.write(parsed.address, value);
    return true;
  }
  if (host) host.write(parsed.instance, parsed.address, value);
  return true;
}

// Aktiven Lese-/Refresh-Wunsch an die Instanz weiterreichen (für /get-Analoga).
function requestValue(topic) {
  const parsed = parseSchemeTopic(topic);
  if (!parsed) return false;
  const virtual = virtualInstances.get(parsed.instance);
  if (virtual) {
    if (typeof virtual.read === 'function') virtual.read(parsed.address);
    return true;
  }
  if (host) host.read(parsed.instance, parsed.address);
  return true;
}

// Vom Host aufgerufen, wenn eine Instanz einen Wert meldet. Schreibt in den Bus
// und verteilt an alle für dieses Topic registrierten Cache-Schlüssel.
function ingestFromInstance(instanceName, address, value, receivedAt) {
  const canonical = buildSchemeTopic(schemeForInstance(instanceName), instanceName, address);
  const keys = routes.get(canonical);
  const targetKeys = keys ? Array.from(keys) : [];
  // Das kanonische Topic ist immer auch selbst ein Cache-Schlüssel, damit die
  // States-Seite den Live-Wert ohne konfigurierten State zeigen kann.
  if (!targetKeys.includes(canonical)) targetKeys.push(canonical);
  bus.ingest(targetKeys, value, { topic: canonical, receivedAt: receivedAt || Date.now() });
}

function ingestBatchFromInstance(instanceName, values, receivedAt) {
  const scheme = schemeForInstance(instanceName);
  const items = [];
  for (const entry of values || []) {
    if (!entry || entry.address == null) continue;
    const canonical = buildSchemeTopic(scheme, instanceName, String(entry.address));
    const keys = routes.get(canonical);
    const targetKeys = keys ? Array.from(keys) : [];
    if (!targetKeys.includes(canonical)) targetKeys.push(canonical);
    items.push({ cacheKeys: targetKeys, value: entry.value });
  }
  bus.ingestBatch(items, { topic: `${scheme}://${instanceName}`, receivedAt: receivedAt || Date.now() });
}

// Das Schema (prefix) einer Instanz – wird vom Host gepflegt; hier nur als
// Rückgriff, falls nicht gesetzt, der erste registrierte Scheme.
const instanceSchemes = new Map(); // instanceName -> scheme
function setInstanceScheme(instanceName, scheme) {
  instanceSchemes.set(instanceName, String(scheme).toLowerCase());
}
function removeInstanceScheme(instanceName) {
  instanceSchemes.delete(instanceName);
}
function schemeForInstance(instanceName) {
  return instanceSchemes.get(instanceName) || '';
}

module.exports = {
  setHost,
  registerVirtualInstance,
  unregisterVirtualInstance,
  registerScheme,
  clearSchemes,
  adapterIdForScheme,
  canonicalTopic,
  registerRoute,
  unregisterRoute,
  write,
  requestValue,
  ingestFromInstance,
  ingestBatchFromInstance,
  setInstanceScheme,
  removeInstanceScheme,
  schemeForInstance,
};
