'use strict';

// Supervisor für Adapter-Instanzen. Startet je aktiver Instanz einen eigenen
// Kindprozess (adapters/runtime.js), hält ihn am Leben (Auto-Restart mit Backoff),
// routet gemeldete Werte über adapters/router.js in den gemeinsamen state-bus und
// persistiert den gemeldeten States-Katalog (adapter_states) für die States-Seite
// und den State-Picker.

const path = require('path');
const childProcess = require('child_process');
const registry = require('./registry');
const router = require('./router');
const instancesRepo = require('./instances');
const metrics = require('../runtime-metrics');
const bus = require('../state-bus');
const identityStore = require('../remote-access/identity-store');
const secretStore = require('./secrets');
const dataStore = require('./data-store');
const crypto = require('crypto');
const i18n = require('../i18n');

const RUNTIME_PATH = path.join(__dirname, 'runtime.js');
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const STOP_KILL_MS = 3000;
const MANAGEMENT_TIMEOUT_MS = 180000;

let db = null;
// Kindprozesse spawnen – überschreibbar für Tests (Fake-Child ohne echten fork).
let forkImpl = (modulePath) => childProcess.fork(modulePath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
function _setForkImpl(fn) {
  forkImpl = fn;
}

// instanceId -> { instance, manifest, child, restarts, stopping, restartTimer }
const running = new Map();
// instanceName -> instanceId (für write/read-Routing vom Router)
const idByName = new Map();
const managementPending = new Map();
let requestSequence = 0;

function subscriptionKey(entry, subscriptionId) {
  return `adapter-sub:${entry.instance.id}:${subscriptionId}`;
}

function removeSubscriptions(entry) {
  const mqttClient = require('../mqtt/client');
  for (const key of entry.subscriptions.values()) mqttClient.unsubscribeAdHoc(key);
  entry.subscriptions.clear();
}

async function handleHostCall(entry, msg) {
  const reply = { type: 'host-call-result', requestId: msg.requestId };
  try {
    if (msg.method === 'identity') {
      const identity = await identityStore.getInstancePublicIdentity();
      reply.result = {
        instanceId: `homeess-${identity.fingerprintHex.slice(0, 32)}`,
        fingerprint: identity.fingerprintHex,
      };
    } else if (msg.method === 'secret.get') {
      reply.result = secretStore.get(entry.instance.id, msg.key);
    } else if (msg.method === 'secret.set') {
      secretStore.set(entry.instance.id, msg.key, msg.value);
      reply.result = true;
    } else if (msg.method === 'secret.delete') {
      reply.result = secretStore.remove(entry.instance.id, msg.key);
    } else if (msg.method === 'storage.dir') {
      reply.result = dataStore.directoryFor(entry.instance.adapterId, entry.instance.id);
    } else if (msg.method === 'storage.set') {
      await instancesRepo.updateSettingKey(db, entry.instance.id, String(msg.key), msg.value);
      entry.instance.settings = { ...(entry.instance.settings || {}), [String(msg.key)]: msg.value };
      reply.result = true;
    } else if (msg.method === 'states.list') {
      // Vollständiger, quellenübergreifender State-Katalog (System, Custom, alle
      // Adapter-Instanzen). Nur Metadaten inklusive Schreibbarkeit – Werte laufen
      // weiterhin über subscribeState. Lazy require: states/repository lädt
      // seinerseits adapters/states und damit diese Datei.
      if (!db) throw new Error('States sind noch nicht verfügbar.');
      const { listAllStates } = require('../states/repository');
      const { topicForId } = require('../states/system-topics');
      const values = await listAllStates(db, require('../mqtt/client').getCache());
      const limit = Math.max(1, Math.min(50000, Number(msg.limit) || 20000));
      // Berechnete Systemwerte tragen intern ihre fachliche Kurz-ID; nach außen
      // ist ausschließlich das kanonische system://-Topic adressierbar.
      const canonical = (entry) => (/^[a-z][a-z0-9_-]*:\/\//i.test(String(entry.id))
        ? String(entry.id)
        : topicForId(entry.id));
      reply.result = values.slice(0, limit).map((entry) => ({
        topic: canonical(entry),
        name: entry.label == null ? String(entry.id) : String(entry.label),
        category: entry.category == null ? '' : String(entry.category),
        unit: entry.unit == null ? '' : String(entry.unit),
        value: entry.value === undefined ? null : entry.value,
        writable: !!entry.writable,
        sourceType: entry.sourceType || 'adapter',
      }));
    } else if (msg.method === 'states.options') {
      // Adapterspezifische Einstellungen, die der Benutzer je State im
      // Eigenschaften-Dialog hinterlegt hat (Schema siehe manifest.stateOptions).
      if (!db) throw new Error('States sind noch nicht verfügbar.');
      reply.result = await require('../states/properties').listOptionsForInstance(db, entry.instance.id);
    } else if (msg.method === 'state.write') {
      const topic = String(msg.topic || '').trim();
      if (!topic) throw new Error('Schreibziel fehlt.');
      const accepted = require('../mqtt/client').publish(topic, msg.value);
      if (!accepted) throw new Error('Schreibziel ist nicht verfügbar oder schreibgeschützt.');
      reply.result = true;
    } else {
      throw new Error('Unbekannter Host-Aufruf.');
    }
  } catch (err) {
    reply.error = err && err.message ? err.message : String(err);
  }
  if (entry.child) entry.child.send(reply);
}

function subscribe(entry, msg) {
  const topic = String(msg.topic || '').trim();
  const subscriptionId = String(msg.subscriptionId || '');
  if (!topic || !subscriptionId) return;
  const mqttClient = require('../mqtt/client');
  const oldKey = entry.subscriptions.get(subscriptionId);
  if (oldKey) mqttClient.unsubscribeAdHoc(oldKey);
  const key = subscriptionKey(entry, subscriptionId);
  entry.subscriptions.set(subscriptionId, key);
  mqttClient.subscribeAdHoc(topic, key);
  const cached = bus.getCache().get(key);
  if (cached && entry.child) {
    entry.child.send({ type: 'state-value', subscriptionId, value: cached.value, receivedAt: cached.receivedAt });
  }
}

function unsubscribe(entry, subscriptionId) {
  const id = String(subscriptionId || '');
  const key = entry.subscriptions.get(id);
  if (!key) return;
  require('../mqtt/client').unsubscribeAdHoc(key);
  entry.subscriptions.delete(id);
}

function manifestFor(instance) {
  return registry.getManifest(instance.adapterId);
}

// Registry laden und Schema->Adapter-Map im Router neu aufbauen.
function reloadRegistry() {
  const manifests = registry.loadRegistry();
  router.clearSchemes();
  for (const manifest of manifests) router.registerScheme(manifest.prefix, manifest.id);
  return manifests;
}

// Von einer Instanz gemeldetes Tab-Schema für den Eigenschaften-Dialog.
// Es wird mit derselben Funktion normalisiert wie ein Manifestschema und
// persistiert, damit der Dialog es auch bei gestoppter Instanz kennt.
function persistStateOptionsSchema(instanceId, raw) {
  if (!db) return null;
  const schema = raw == null ? null : registry.normalizeStateOptions(raw);
  if (!schema) {
    db.run('DELETE FROM adapter_state_schemas WHERE instance_id = ?', [instanceId]);
    return null;
  }
  db.run(
    `INSERT INTO adapter_state_schemas (instance_id, schema_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       schema_json = excluded.schema_json,
       updated_at = excluded.updated_at`,
    [instanceId, JSON.stringify(schema), Date.now()]
  );
  return schema;
}

// Das gültige Tab-Schema einer Instanz: gemeldetes Schema vor Manifestschema.
function stateOptionsSchema(instanceId, manifest) {
  return new Promise((resolve) => {
    const fallback = manifest && manifest.stateOptions ? manifest.stateOptions : null;
    if (!db) return resolve(fallback);
    db.get('SELECT schema_json FROM adapter_state_schemas WHERE instance_id = ?', [instanceId], (error, row) => {
      if (error || !row || !row.schema_json) return resolve(fallback);
      try {
        resolve(registry.normalizeStateOptions(JSON.parse(row.schema_json)) || fallback);
      } catch (_) {
        resolve(fallback);
      }
    });
  });
}

function persistStates(instanceId, list) {
  if (!db) return;
  // Große dynamische Kataloge (z. B. RPC-Geräte) stets in genau einer
  // Transaktion schreiben. Einzelne Autocommit-INSERTs blockieren SQLite und
  // damit bei tausenden States die gesamte Anwendung für lange Zeit.
  db.serialize(() => {
    db.run('BEGIN');
    db.run('DELETE FROM adapter_states WHERE instance_id = ?', [instanceId]);
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO adapter_states
        (instance_id, address, name, category, unit, writable, last_value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const s of list) {
      if (!s || s.address == null) continue;
      stmt.run([
        instanceId,
        String(s.address),
        s.name ? String(s.name) : String(s.address),
        s.category ? String(s.category) : '',
        s.unit ? String(s.unit) : '',
        s.writable ? 1 : 0,
        s.value == null ? null : String(s.value),
        now,
      ]);
    }
    stmt.finalize();
    db.run('COMMIT');
  });
}

function handleMessage(entry, msg) {
  if (!msg || typeof msg !== 'object') return;
  const name = entry.instance.name;
  switch (msg.type) {
    case 'ready':
      console.log(`[adapter ${entry.manifest.prefix}://${name}] bereit`);
      break;
    case 'value':
      metrics.counter('adapter.valueMessages');
      router.ingestFromInstance(name, String(msg.address), msg.value);
      break;
    case 'values':
      metrics.counter('adapter.batchMessages');
      metrics.counter('adapter.batchValues', Array.isArray(msg.values) ? msg.values.length : 0);
      router.ingestBatchFromInstance(name, Array.isArray(msg.values) ? msg.values : []);
      break;
    case 'states':
      persistStates(entry.instance.id, Array.isArray(msg.list) ? msg.list : []);
      break;
    case 'state-options-schema':
      persistStateOptionsSchema(entry.instance.id, msg.schema);
      break;
    case 'status':
      // Vom Adapter gemeldeter Verbindungszustand (z. B. Modbus-TCP verbunden).
      entry.status.connected = !!msg.connected;
      entry.status.detail = msg.detail ? String(msg.detail) : '';
      break;
    case 'storage':
      if (msg.key != null) {
        instancesRepo.updateSettingKey(db, entry.instance.id, String(msg.key), msg.value).catch(() => {});
      }
      break;
    case 'subscribe':
      subscribe(entry, msg);
      break;
    case 'unsubscribe':
      unsubscribe(entry, msg.subscriptionId);
      break;
    case 'host-call':
      handleHostCall(entry, msg).catch(() => {});
      break;
    case 'management-result': {
      const pending = managementPending.get(String(msg.requestId));
      if (pending && pending.instanceId === entry.instance.id) {
        managementPending.delete(String(msg.requestId));
        clearTimeout(pending.timer);
        pending.resolve(msg.response || {});
      }
      break;
    }
    case 'log':
      if (msg.level === 'error') console.error(`[adapter ${entry.manifest.prefix}://${name}] FEHLER: ${msg.message}`);
      else if (msg.level === 'warn') console.warn(`[adapter ${entry.manifest.prefix}://${name}] WARNUNG: ${msg.message}`);
      else if (msg.level === 'debug') {
        if (process.env.HOME_ESS_ADAPTER_DEBUG === '1') console.debug(`[adapter ${entry.manifest.prefix}://${name}] DEBUG: ${msg.message}`);
      } else console.log(`[adapter ${entry.manifest.prefix}://${name}] ${msg.message}`);
      break;
    case 'error':
      console.error(`[adapter ${entry.manifest.prefix}://${name}] FEHLER: ${msg.message}`);
      break;
    default:
      break;
  }
}

function spawnChild(entry) {
  const { instance, manifest } = entry;
  const child = forkImpl(RUNTIME_PATH);
  entry.child = child;
  router.setInstanceScheme(instance.name, manifest.prefix);
  idByName.set(instance.name, instance.id);

  child.on('message', (msg) => handleMessage(entry, msg));
  child.on('exit', (code) => {
    removeSubscriptions(entry);
    entry.child = null;
    entry.status.connected = false;
    if (entry.stopping) {
      cleanup(instance.id);
      return;
    }
    // Unerwarteter Absturz -> Backoff-Restart.
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** entry.restarts);
    entry.restarts += 1;
    console.error(
      `[adapter ${manifest.prefix}://${instance.name}] beendet (code=${code}), Neustart in ${delay} ms`
    );
    entry.restartTimer = setTimeout(() => {
      if (running.get(instance.id) === entry) spawnChild(entry);
    }, delay);
  });
  child.on('error', (err) => {
    console.error(`[adapter ${manifest.prefix}://${instance.name}] Prozessfehler: ${err.message}`);
  });

  child.send({
    type: 'init',
    mainPath: manifest.mainPath,
    name: instance.name,
    config: instance.settings || {},
    language: i18n.current(),
    translations: i18n.adapterTranslations(manifest.dir),
  });
}

function startInstance(instance) {
  const manifest = manifestFor(instance);
  if (!manifest) {
    console.error(`[adapters] Kein Adapter "${instance.adapterId}" für Instanz "${instance.name}".`);
    return;
  }
  const entry = { instance, manifest, child: null, restarts: 0, stopping: false,
    restartTimer: null, subscriptions: new Map(), status: { connected: false, detail: '' } };
  running.set(instance.id, entry);
  spawnChild(entry);
}

function cleanup(instanceId) {
  const entry = running.get(instanceId);
  if (!entry) return;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  removeSubscriptions(entry);
  router.removeInstanceScheme(entry.instance.name);
  idByName.delete(entry.instance.name);
  running.delete(instanceId);
}

// Leitet einen authentifizierten Management-Request an den isolierten
// Adapterprozess weiter. Bestehende Adapter ohne managementPage bleiben davon
// vollständig unberührt.
function managementRequest(instanceId, request, timeoutMs = MANAGEMENT_TIMEOUT_MS) {
  const entry = running.get(Number(instanceId));
  if (!entry || !entry.child) {
    // Die Verwaltung lebt im Adapterprozess: ohne laufende Instanz gibt es
    // niemanden, der die Seite beantworten könnte.
    const error = new Error('Diese Instanz ist nicht aktiv. Bitte sie auf der Adapterseite aktivieren und danach erneut öffnen.');
    error.status = 409;
    return Promise.reject(error);
  }
  if (!entry.manifest.managementPage) {
    const error = new Error('Dieser Adapter stellt keine Verwaltungsseite bereit.');
    error.status = 404;
    return Promise.reject(error);
  }
  const requestId = `${process.pid}-${Date.now()}-${++requestSequence}-${crypto.randomBytes(4).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      managementPending.delete(requestId);
      reject(new Error('Adapterverwaltung hat nicht rechtzeitig geantwortet.'));
    }, Math.max(1000, Number(timeoutMs) || MANAGEMENT_TIMEOUT_MS));
    managementPending.set(requestId, { instanceId: entry.instance.id, resolve, reject, timer });
    try {
      entry.child.send({ type: 'management', requestId, request });
    } catch (err) {
      clearTimeout(timer);
      managementPending.delete(requestId);
      reject(err);
    }
  });
}

// Der Benutzer hat die State-Optionen dieser Instanz geändert: der laufende
// Adapter zieht sie selbst nach, ohne dass die Instanz neu starten muss.
function notifyStateOptions(instanceId) {
  const entry = running.get(Number(instanceId));
  if (!entry || !entry.child) return false;
  try {
    entry.child.send({ type: 'state-options' });
    return true;
  } catch (_) {
    return false;
  }
}

function deliverSubscriptions(entries, event) {
  const changed = new Set(event && Array.isArray(event.changedKeys) ? event.changedKeys : []);
  if (!changed.size) return;
  for (const entry of entries) {
    if (!entry.child) continue;
    for (const [subscriptionId, key] of entry.subscriptions) {
      if (!changed.has(key)) continue;
      const cached = bus.getCache().get(key);
      if (cached) entry.child.send({ type: 'state-value', subscriptionId, value: cached.value, receivedAt: cached.receivedAt });
    }
  }
}

const offBus = bus.onValuesChanged((event) => deliverSubscriptions(running.values(), event));

function stopInstance(instanceId) {
  const entry = running.get(instanceId);
  if (!entry) return Promise.resolve();
  entry.stopping = true;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  const child = entry.child;
  if (!child) {
    cleanup(instanceId);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    try {
      child.send({ type: 'stop' });
    } catch (_) {
      /* Kanal weg */
    }
    setTimeout(() => {
      if (entry.child) {
        try {
          entry.child.kill('SIGKILL');
        } catch (_) {
          /* schon weg */
        }
      }
      finish();
    }, STOP_KILL_MS);
  });
}

// Instanz aus der DB neu laden: laufenden Prozess stoppen und – falls aktiviert –
// frisch starten (übernimmt geänderte Einstellungen/Namen).
async function reloadInstance(instanceId) {
  await stopInstance(instanceId);
  if (!db) return;
  const instance = await instancesRepo.getInstance(db, instanceId);
  if (instance && instance.enabled) startInstance(instance);
}

async function reloadAllForLanguage() {
  const ids = Array.from(running.keys());
  // Parallel stoppen, danach aus der DB mit den frisch lokalisierten Manifesten
  // wieder starten. Deaktivierte Instanzen bleiben deaktiviert.
  await Promise.all(ids.map((id) => stopInstance(id)));
  if (!db) return;
  const instances = await instancesRepo.listInstances(db);
  for (const instance of instances) if (instance.enabled) startInstance(instance);
  await require('./navigation').refresh(db).catch(() => {});
}

// Aktivierte Instanzen aus der DB starten und Router an diesen Host binden.
async function initAdapters(database) {
  db = database;
  router.setHost({
    write: (name, address, value) => write(name, address, value),
    read: (name, address) => read(name, address),
  });
  reloadRegistry();
  const instances = await instancesRepo.listInstances(db);
  for (const instance of instances) {
    if (instance.enabled) startInstance(instance);
  }
}

function write(instanceName, address, value) {
  const id = idByName.get(instanceName);
  const entry = id != null ? running.get(id) : null;
  if (entry && entry.child) {
    try {
      entry.child.send({ type: 'write', address, value });
    } catch (_) {
      /* Kanal weg – Restart läuft */
    }
  }
}

function read(instanceName, address) {
  const id = idByName.get(instanceName);
  const entry = id != null ? running.get(id) : null;
  if (entry && entry.child) {
    try {
      entry.child.send({ type: 'read', address });
    } catch (_) {
      /* Kanal weg */
    }
  }
}

async function stopAll() {
  await Promise.all(Array.from(running.keys()).map((id) => stopInstance(id)));
}

function isRunning(instanceId) {
  const entry = running.get(instanceId);
  return !!(entry && entry.child);
}

// Laufzeit-/Verbindungsstatus einer Instanz für die Adapter-Seite.
function getStatus(instanceId) {
  const entry = running.get(instanceId);
  if (!entry) return { running: false, connected: false, detail: '' };
  return {
    running: !!entry.child,
    connected: !!(entry.status && entry.status.connected),
    detail: entry.status ? entry.status.detail : '',
  };
}

module.exports = {
  initAdapters,
  reloadRegistry,
  reloadInstance,
  reloadAllForLanguage,
  startInstance,
  stopInstance,
  stopAll,
  isRunning,
  getStatus,
  managementRequest,
  notifyStateOptions,
  stateOptionsSchema,
  _setForkImpl,
  _handleMessage: handleMessage,
  _deliverSubscriptions: deliverSubscriptions,
  _offBus: offBus,
};
