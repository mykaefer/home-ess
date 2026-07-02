'use strict';

// Fork-Ziel für eine Adapter-Instanz. Läuft als eigener Kindprozess, lädt die
// Adapter-Einstiegsdatei und stellt dem Adapter eine `host`-API bereit, die
// transparent auf IPC abgebildet wird. Der Adapter-Autor kennt kein IPC – er
// schreibt nur module.exports = (host) => ({ start, stop, write, read }).
//
// IPC (Parent -> Child):  init{mainPath,name,config}, stop, write{address,value}, read{address}
// IPC (Child -> Parent):  ready, states{list}, value{address,value}, log{level,message}, error{message}

let adapter = null;
let currentConfig = {};
let instanceName = '';

function send(message) {
  if (process.send) {
    try {
      process.send(message);
    } catch (_) {
      /* Parent weg – beim nächsten Lebenszyklus neu */
    }
  }
}

function buildHost() {
  return {
    get name() {
      return instanceName;
    },
    getConfig() {
      return currentConfig;
    },
    // Einen einzelnen State-Wert melden.
    publishState(address, value) {
      if (address == null) return;
      send({ type: 'value', address: String(address), value });
    },
    // Mehrere zusammen gelesene Werte in einer IPC-Nachricht melden. Der Parent
    // aktualisiert alle Frischezeitstempel und feuert nur ein gemeinsames Event.
    publishStates(values) {
      if (!Array.isArray(values) || !values.length) return;
      send({ type: 'values', values: values
        .filter((entry) => entry && entry.address != null)
        .map((entry) => ({ address: String(entry.address), value: entry.value })) });
    },
    // Den State-Katalog (Liste declarierter States) melden/aktualisieren.
    // Eintrag: { address, name?, category?, unit?, writable? }
    setStates(list) {
      const states = Array.isArray(list) ? list : [];
      send({ type: 'states', list: states });
    },
    // Verbindungszustand zum Gerät/Dienst melden (für die Adapter-Seite).
    setConnected(connected, detail) {
      send({ type: 'status', connected: !!connected, detail: detail == null ? '' : String(detail) });
    },
    log(...args) {
      send({ type: 'log', level: 'info', message: args.map(String).join(' ') });
    },
    error(...args) {
      send({ type: 'log', level: 'error', message: args.map(String).join(' ') });
    },
  };
}

async function start(mainPath, name, cfg) {
  instanceName = name;
  currentConfig = cfg || {};
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const factory = require(mainPath);
  const create = typeof factory === 'function' ? factory : factory && factory.createAdapter;
  if (typeof create !== 'function') {
    throw new Error('Adapter exportiert keine createAdapter(host)-Funktion');
  }
  adapter = create(buildHost());
  if (adapter && typeof adapter.start === 'function') {
    await adapter.start(currentConfig);
  }
  send({ type: 'ready' });
}

async function stop() {
  try {
    if (adapter && typeof adapter.stop === 'function') await adapter.stop();
  } catch (err) {
    send({ type: 'log', level: 'error', message: `stop fehlgeschlagen: ${err.message}` });
  } finally {
    process.exit(0);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    start(msg.mainPath, msg.name, msg.config).catch((err) => {
      send({ type: 'error', message: err && err.message ? err.message : String(err) });
      process.exit(1);
    });
  } else if (msg.type === 'stop') {
    stop();
  } else if (msg.type === 'write') {
    try {
      if (adapter && typeof adapter.write === 'function') adapter.write(msg.address, msg.value);
    } catch (err) {
      send({ type: 'log', level: 'error', message: `write fehlgeschlagen: ${err.message}` });
    }
  } else if (msg.type === 'read') {
    try {
      if (adapter && typeof adapter.read === 'function') adapter.read(msg.address);
    } catch (err) {
      send({ type: 'log', level: 'error', message: `read fehlgeschlagen: ${err.message}` });
    }
  } else if (msg.type === 'config') {
    currentConfig = msg.config || {};
  }
});

// Unbehandelte Fehler im Adapter dürfen nur diesen Kindprozess beenden – der
// Supervisor im Hauptprozess startet ihn neu. homeESS selbst bleibt unberührt.
process.on('uncaughtException', (err) => {
  send({ type: 'error', message: `uncaughtException: ${err && err.message}` });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ type: 'error', message: `unhandledRejection: ${err && (err.message || err)}` });
  process.exit(1);
});
