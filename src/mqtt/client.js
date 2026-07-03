'use strict';

const mqtt = require('mqtt');
const bus = require('../state-bus');
const adapterRouter = require('../adapters/router');
const {
  normalizeMqttTopic,
  ioBrokerIdToMqttTopic,
  mqttReadCandidates,
  mqttSubscribeCandidates,
  unwrapMqttMessage,
  isMeaningfulValue,
  isCommandTopic,
  isSchemeTopic,
  parseValue,
} = require('./topics');

// Verbindungs-Manager für den ioBroker-MQTT-Broker. Hält eine einzige laufende
// Verbindung, abonniert konfigurierte Topics und cached eingehende Werte.
// Aufgebaut nach den Regeln in MQTT.md (clean-Session, Set beim connect leeren,
// Wildcard für Slash-States, exaktes Routing). Die Last-Schalt-Logik (Regel-
// Engine) setzt später auf dem hier gepflegten Wert-Cache auf.

let client = null;
let clientGeneration = 0;
let connected = false;
let lastError = null;

let subscribedTopics = new Set(); // Deduplizierung der Abos
// Zentraler Wert-Cache liegt im gemeinsamen state-bus (auch von Adaptern genutzt).
const valueCache = bus.getCache();
const topicRoutes = new Map(); // exaktes incomingTopic -> [{ cacheKey, configuredTopic }]

// Ad-hoc-Topics (Modul-Topics außerhalb der State-Definitionen).
// adhocRoutes: incomingCandidate -> cacheKey (alle Read-Varianten registriert)
// adhocConfigured: cacheKey -> configuredTopic (für Reconnect-Resubscription)
const adhocRoutes = new Map(); // incomingCandidate -> Set<cacheKey>
const adhocConfigured = new Map();

// Konfigurierte States/Lasten. Wird später aus der DB gefüllt; aktuell leer.
let stateDefinitions = [];
const stateRequestTimes = new Map();
const STATE_REQUEST_THROTTLE_MS = 5000;

// Draht-Diagnose: mit HOMEESS_MQTT_DEBUG=1 werden alle ein- und ausgehenden
// MQTT-Nachrichten protokolliert (Topic, Wert, ack). Standardmäßig still.
const MQTT_DEBUG = process.env.HOMEESS_MQTT_DEBUG === '1' || process.env.HOMEESS_MQTT_DEBUG === 'true';
function dbg(direction, topic, payload, extra) {
  if (!MQTT_DEBUG) return;
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[mqtt ${direction}] ${topic} = ${typeof payload === 'string' ? payload : JSON.stringify(payload)}${suffix}`);
}

function buildOptions(cfg) {
  return {
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    clientId: 'homeess_' + Math.random().toString(16).slice(2),
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    keepalive: 60,
  };
}

// Adapter-Topics aus den State-Definitionen, die beim letzten buildTopicRoutes
// am Router registriert wurden – damit ein Rebuild sie sauber abmelden kann.
let registeredStateSchemeRoutes = [];

// Routing-Tabelle aus den konfigurierten States neu aufbauen (nur exakte Topics).
// Schema-Topics (prefix://) werden nicht über den Broker, sondern über den
// Adapter-Router aufgelöst.
function buildTopicRoutes() {
  topicRoutes.clear();
  for (const [topic, cacheKey] of registeredStateSchemeRoutes) {
    adapterRouter.unregisterRoute(topic, cacheKey);
  }
  registeredStateSchemeRoutes = [];
  for (const state of stateDefinitions) {
    if (isSchemeTopic(state.topic)) {
      adapterRouter.registerRoute(state.topic, String(state.id));
      registeredStateSchemeRoutes.push([state.topic, String(state.id)]);
      continue;
    }
    for (const candidate of mqttReadCandidates(state.topic)) {
      const routes = topicRoutes.get(candidate) || [];
      routes.push({ cacheKey: String(state.id), configuredTopic: state.topic });
      topicRoutes.set(candidate, routes);
    }
  }
}

function subscribeTopic(topic) {
  const clean = normalizeMqttTopic(topic);
  if (!clean || subscribedTopics.has(clean) || !client) return;
  client.subscribe(clean, { qos: 0 }, (err) => {
    if (!err) subscribedTopics.add(clean);
  });
}

function subscribeAllTopics() {
  for (const state of stateDefinitions) {
    if (isSchemeTopic(state.topic)) continue; // Adapter-Topics laufen über den Router.
    for (const candidate of mqttSubscribeCandidates(state.topic)) subscribeTopic(candidate);
  }
}


function requestAllStateValues() {
  if (!client || !connected) return;
  for (const state of stateDefinitions) {
    if (isSchemeTopic(state.topic)) continue;
    for (const candidate of mqttReadCandidates(state.topic)) {
      client.publish(`${candidate}/get`, '');
    }
  }
}

function handleMessage(topic, buffer) {
  const incomingTopic = normalizeMqttTopic(topic);
  const { value: payload, ack } = unwrapMqttMessage(buffer.toString('utf8'));
  dbg('<-', incomingTopic, payload, `ack=${ack}`);
  if (!isMeaningfulValue(payload)) return;
  // ack:false ist ein Schreibwunsch/Kommando (u. a. das Echo unserer eigenen
  // Schreibvorgänge auf dem Haupt-Topic) – kein bestätigter Ist-Zustand. Solche
  // Nachrichten dürfen den Readback-Cache nicht verfälschen, sonst meldet die
  // Verifikation fälschlich „bestätigt", obwohl ioBroker einen anderen Wert hält.
  if (ack === false) return;
  const receivedAt = Date.now();
  const changedKeys = [];
  for (const route of topicRoutes.get(incomingTopic) || []) {
    changedKeys.push(route.cacheKey);
  }
  const adhocKeys = adhocRoutes.get(incomingTopic);
  for (const adhocKey of adhocKeys || []) {
    if (!changedKeys.includes(adhocKey)) changedKeys.push(adhocKey);
  }
  // Werte setzen und ein gemeinsames Event über den state-bus auslösen.
  bus.ingest(changedKeys, payload, { topic: incomingTopic, receivedAt });
}

// Verbindung mit der übergebenen Konfiguration (neu) aufbauen.
function connect(cfg) {
  disconnect();
  buildTopicRoutes();

  const url = `mqtt://${cfg.host}:${cfg.port}`;
  const generation = ++clientGeneration;
  const currentClient = mqtt.connect(url, buildOptions(cfg));
  client = currentClient;

  currentClient.on('connect', () => {
    if (generation !== clientGeneration || client !== currentClient) return;
    connected = true;
    lastError = null;
    subscribedTopics = new Set(); // KRITISCH: bei jedem connect leeren (Auto-Reconnect)
    subscribeAllTopics();
    requestAllStateValues();
    subscribeAllAdhocTopics();
    requestAllAdhocValues();
  });
  currentClient.on('reconnect', () => {
    if (generation !== clientGeneration) return;
    connected = false;
  });
  currentClient.on('close', () => {
    if (generation !== clientGeneration) return;
    connected = false;
  });
  currentClient.on('error', (err) => {
    if (generation !== clientGeneration) return;
    lastError = err.message;
  });
  currentClient.on('message', (topic, buffer) => {
    if (generation === clientGeneration && client === currentClient) handleMessage(topic, buffer);
  });

  return client;
}

function disconnect() {
  clientGeneration += 1;
  if (client) {
    client.end(true);
    client = null;
  }
  connected = false;
  subscribedTopics = new Set();
}

function getStatus() {
  return {
    connected,
    lastError,
    cachedValues: valueCache.size,
    subscriptions: subscribedTopics.size,
  };
}

function getCache() {
  return valueCache;
}

// Façade auf den gemeinsamen state-bus, damit bestehende Konsumenten (Output-
// Engine, /live, Dashboard) unverändert mqttClient.onValuesChanged verwenden.
function onValuesChanged(listener) {
  return bus.onValuesChanged(listener);
}

// Konfigurierte States setzen und Routing/Abos neu aufbauen.
function setStateDefinitions(defs) {
  const nextDefinitions = Array.isArray(defs) ? defs : [];
  const nextById = new Map(nextDefinitions.map((entry) => [String(entry.id), entry.topic]));
  for (const previous of stateDefinitions) {
    if (nextById.get(String(previous.id)) !== previous.topic) {
      valueCache.delete(String(previous.id));
      stateRequestTimes.delete(String(previous.id));
    }
  }
  stateDefinitions = nextDefinitions;
  buildTopicRoutes();
  if (connected) {
    subscribedTopics = new Set();
    subscribeAllTopics();
    requestAllStateValues();
  }
}

// Einen konfigurierten lokalen Adapter-State aktiv neu anfordern. Broker-Topics
// werden hier bewusst NICHT per /get gepollt: Bei Homematic kann jede solche
// Anfrage eine echte Funkabfrage auslösen und den Duty-Cycle hochtreiben.
// Die Drossel verhindert zusätzlich zu schnelle Reads lokaler Adapter.
function requestStateValue(cacheKey) {
  const key = String(cacheKey);
  const state = stateDefinitions.find((entry) => String(entry.id) === key);
  if (!state || !state.topic) return false;
  const now = Date.now();
  if (now - (stateRequestTimes.get(key) || 0) < STATE_REQUEST_THROTTLE_MS) return false;
  if (!isSchemeTopic(state.topic)) return false;
  const requested = adapterRouter.requestValue(state.topic);
  if (requested) stateRequestTimes.set(key, now);
  return requested;
}

// Wert an ein Ziel-Topic schreiben (ioBroker-Konvention aus MQTT.md):
// Command-Topics (_SET/.SET//SET) erhalten nur den Rohwert; normale States
// erhalten zusätzlich /set (Rohwert) und das Haupt-Topic als JSON {val, ack:false}.
//
// Wichtig: Auf ein Wildcard kann NICHT publiziert werden – das Slash-Wildcard
// hilft nur beim Abonnieren. Um die Notations-Unsicherheit beim Schreiben
// (Punkt- vs. Slash-Topic, abhängig von der topic2id-Rückbildung des Adapters)
// abzudecken, schreiben wir an alle konkreten Write-Kandidaten. Ein Adapter, der
// die Variante nicht auf eine State-ID abbilden kann, verwirft sie folgenlos.
function publish(targetTopic, value) {
  // Adapter-Topics (prefix://) gehen an die zuständige Instanz, nicht an den Broker.
  if (isSchemeTopic(targetTopic)) return adapterRouter.write(targetTopic, value);
  if (!client) return false;
  const baseTopic = ioBrokerIdToMqttTopic(normalizeMqttTopic(targetTopic));
  if (!baseTopic) return false;

  if (isCommandTopic(targetTopic)) {
    for (const candidate of mqttReadCandidates(targetTopic)) {
      client.publish(candidate, String(value));
      dbg('->', candidate, String(value), 'cmd');
    }
    return true;
  }

  const json = JSON.stringify({ val: parseValue(value), ack: false });
  for (const candidate of mqttReadCandidates(targetTopic)) {
    client.publish(`${candidate}/set`, String(value));
    client.publish(candidate, json);
    dbg('->', candidate, json, '(+/set)');
  }
  return true;
}

// Einmaliger Verbindungstest (eigener, kurzlebiger Client) für die Settings-Seite.
function testConnection(cfg) {
  return new Promise((resolve) => {
    const url = `mqtt://${cfg.host}:${cfg.port}`;
    const testClient = mqtt.connect(url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      connectTimeout: 5000,
      reconnectPeriod: 0,
      clean: true,
    });

    let settled = false;
    const done = (ok, message) => {
      if (settled) return;
      settled = true;
      testClient.end(true);
      resolve({ success: ok, message });
    };

    testClient.on('connect', () => done(true, 'MQTT Verbindung erfolgreich.'));
    testClient.on('error', (err) => done(false, 'Fehler: ' + err.message));
    setTimeout(() => done(false, 'Timeout beim Verbindungsaufbau.'), 6000);
  });
}

// Hilfsfunktionen für Ad-hoc-Abonnements ─────────────────────────────────

// Routen für alle Lese-Kandidaten eines konfigurierten Topics eintragen.
function registerAdhocRoutes(configuredTopic, cacheKey) {
  for (const candidate of mqttReadCandidates(configuredTopic)) {
    const keys = adhocRoutes.get(candidate) || new Set();
    keys.add(cacheKey);
    adhocRoutes.set(candidate, keys);
  }
}

// Bei jedem Reconnect alle Ad-hoc-Topics mit vollständigen Subscribe-Kandidaten
// (inkl. Wildcard für Slash-eingebettete State-IDs) neu abonnieren.
function subscribeAllAdhocTopics() {
  for (const configuredTopic of adhocConfigured.values()) {
    for (const sub of mqttSubscribeCandidates(configuredTopic)) {
      subscribeTopic(sub);
    }
  }
}

// Aktive Wertanfrage (/get) für alle Ad-hoc-Topics.
function requestAllAdhocValues() {
  if (!client || !connected) return;
  for (const configuredTopic of adhocConfigured.values()) {
    for (const candidate of mqttReadCandidates(configuredTopic)) {
      client.publish(`${candidate}/get`, '');
    }
  }
}

// Öffentliche API: Topic für Ad-hoc-Empfang registrieren.
// Verwendet mqttReadCandidates für Routing (Punkt/Slash/Adapter-Varianten) und
// mqttSubscribeCandidates für das eigentliche Abo (inkl. Wildcard bei Slash-States).
function subscribeAdHoc(configuredTopic, cacheKey) {
  if (!cacheKey) return;
  // Adapter-Topics (prefix://) über den Router registrieren statt über den Broker.
  if (isSchemeTopic(configuredTopic)) {
    adapterRouter.registerRoute(configuredTopic, cacheKey);
    adhocConfigured.set(cacheKey, configuredTopic);
    return;
  }
  const clean = normalizeMqttTopic(configuredTopic);
  if (!clean) return;

  registerAdhocRoutes(clean, cacheKey);
  adhocConfigured.set(cacheKey, clean);

  if (connected) {
    for (const sub of mqttSubscribeCandidates(clean)) subscribeTopic(sub);
    for (const candidate of mqttReadCandidates(clean)) {
      client.publish(`${candidate}/get`, '');
    }
  }
}

function unsubscribeAdHoc(cacheKey) {
  const configuredTopic = adhocConfigured.get(cacheKey);
  if (!configuredTopic) return;
  if (isSchemeTopic(configuredTopic)) {
    adapterRouter.unregisterRoute(configuredTopic, cacheKey);
    adhocConfigured.delete(cacheKey);
    valueCache.delete(cacheKey);
    return;
  }
  for (const candidate of mqttReadCandidates(configuredTopic)) {
    const keys = adhocRoutes.get(candidate);
    if (!keys) continue;
    keys.delete(cacheKey);
    if (!keys.size) adhocRoutes.delete(candidate);
  }
  adhocConfigured.delete(cacheKey);
  valueCache.delete(cacheKey);
}

function requestAdHocValue(cacheKey) {
  const configuredTopic = adhocConfigured.get(cacheKey);
  if (!configuredTopic) return false;
  if (isSchemeTopic(configuredTopic)) return adapterRouter.requestValue(configuredTopic);
  if (!client || !connected) return false;
  for (const candidate of mqttReadCandidates(configuredTopic)) {
    client.publish(`${candidate}/get`, '');
  }
  return true;
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  getCache,
  onValuesChanged,
  setStateDefinitions,
  subscribeAdHoc,
  unsubscribeAdHoc,
  requestAdHocValue,
  requestStateValue,
  publish,
  testConnection,
};
