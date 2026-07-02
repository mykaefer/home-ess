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

const RUNTIME_PATH = path.join(__dirname, 'runtime.js');
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const STOP_KILL_MS = 3000;

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

function persistStates(instanceId, list) {
  if (!db) return;
  db.run('DELETE FROM adapter_states WHERE instance_id = ?', [instanceId], () => {
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
    case 'status':
      // Vom Adapter gemeldeter Verbindungszustand (z. B. Modbus-TCP verbunden).
      entry.status.connected = !!msg.connected;
      entry.status.detail = msg.detail ? String(msg.detail) : '';
      break;
    case 'log':
      console.log(`[adapter ${entry.manifest.prefix}://${name}] ${msg.message}`);
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
  });
}

function startInstance(instance) {
  const manifest = manifestFor(instance);
  if (!manifest) {
    console.error(`[adapters] Kein Adapter "${instance.adapterId}" für Instanz "${instance.name}".`);
    return;
  }
  const entry = { instance, manifest, child: null, restarts: 0, stopping: false, restartTimer: null, status: { connected: false, detail: '' } };
  running.set(instance.id, entry);
  spawnChild(entry);
}

function cleanup(instanceId) {
  const entry = running.get(instanceId);
  if (!entry) return;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  router.removeInstanceScheme(entry.instance.name);
  idByName.delete(entry.instance.name);
  running.delete(instanceId);
}

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
  startInstance,
  stopInstance,
  stopAll,
  isRunning,
  getStatus,
  _setForkImpl,
  _handleMessage: handleMessage,
};
