'use strict';

// Audio Bus – Einstieg für den homeESS-Core.
//
//   const audioBus = require('./audio-bus');
//   audioBus.attach(server);                 // WebSocket /api/v1/audio/ws
//   const plugin = audioBus.createClient('mein-plugin');
//   plugin.onInput((session, chunk, info) => { … });
//   plugin.startOutput(session.sessionId, { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 });
//   plugin.sendAudio(session.sessionId, chunk);
//   plugin.endOutput(session.sessionId);
//
// Adapter nutzen dieselbe Schnittstelle als host.audio.* (adapter-bridge.js).
// Ins State-System gelangt nur eine Kennzahl: system://homeess/audio.active_sessions.
// Kurzlebige Sessions werden bewusst nicht als States angelegt; Details
// liefern getSession()/listSessions() und die Session-Ereignisse.

const { createAudioBus } = require('./bus');
const { createAudioWsServer, AUDIO_WS_PATH } = require('./ws-server');

const config = require('./config');
const bus = createAudioBus();
function applyMaxSessions(value) {
  bus.setMaxSessions(value);
  if (wsServer) wsServer.setMaxConnections(config.connectionLimit(value));
}
async function init(db) { applyMaxSessions(await config.load(db)); }
async function saveSettings(db, value) { applyMaxSessions(await config.save(db, value)); }
let wsServer = null;
let statesRegistered = false;

function attach(server) {
  if (!wsServer) {
    wsServer = createAudioWsServer({ bus, options: { maxConnections: config.connectionLimit(bus.limits.maxSessions) } });
    wsServer.attach(server);
  }
  return wsServer;
}

function createClient(name) {
  return bus.createClient(name);
}

// Diagnose ohne personenbezogene Sessioninhalte.
function status() {
  const current = bus.status();
  return {
    ...current,
    endpoint: AUDIO_WS_PATH,
    listening: !!wsServer,
    maxConnections: config.connectionLimit(current.limits.maxSessions),
    connections: wsServer ? wsServer.status().connections : 0,
  };
}

// Anzahl aktiver Sessions als System-State melden; Änderungen stoßen die
// (entprellte) Neuberechnung der System-States an.
function registerStates() {
  if (statesRegistered) return;
  statesRegistered = true;
  // eslint-disable-next-line global-require
  const { registerValueProvider } = require('../states/system-values');
  // eslint-disable-next-line global-require
  const systemRuntime = require('../states/system-runtime');
  registerValueProvider(() => {
    const count = bus.status().sessions;
    return [{
      id: 'audio.active_sessions',
      label: 'Audio Bus – aktive Sessions',
      value: count,
      display: String(count),
      category: 'Betrieb',
    }];
  });
  let last = bus.status().sessions;
  bus.onChange(() => {
    const count = bus.status().sessions;
    if (count === last) return;
    last = count;
    systemRuntime.schedule();
  });
}

function shutdown() {
  if (wsServer) wsServer.shutdown();
  bus.shutdown('server_shutdown');
}

module.exports = { init, saveSettings, bus, attach, createClient, status, registerStates, shutdown, AUDIO_WS_PATH };
