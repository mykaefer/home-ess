'use strict';

// Brücke zwischen Audio Bus und Adapter-Kindprozessen (Plugin-API
// host.audio.* in adapters/runtime.js).
//
// Nur Adapter, deren Manifest `"audioBus": true` erklärt, erhalten Zugriff.
// Ihre Kindprozesse laufen mit IPC-Serialisierung „advanced“, sodass
// Audio-Chunks als Buffer (binär, ohne Base64/JSON) übertragen werden.
//
// Input-Ereignisse werden erst nach Bestätigung des Kindprozesses
// (audio-ack) als zugestellt betrachtet. Damit wirkt die begrenzte Queue des
// Bus bis in den Adapter: Ein langsamer Adapter verliert Chunks, statt im
// Hauptprozess oder im Kind unbegrenzt Speicher zu belegen.
//
// IPC (Child → Parent): audio-subscribe{kinds}, audio-call{requestId, method, …}, audio-ack{eventId}
// IPC (Parent → Child): audio-event{eventId, kind, session, chunk?, info?, reason?}, audio-call-result{requestId, result|error, code}

const ACK_TIMEOUT_MS = 10 * 1000;
const KINDS = Object.freeze({ started: 'onSessionStarted', input: 'onInput', ended: 'onSessionEnded' });
const METHODS = Object.freeze(['startOutput', 'sendAudio', 'endOutput', 'getSession', 'listSessions']);

function defaultBus() {
  // eslint-disable-next-line global-require
  return require('./index').bus;
}

function permitted(entry) {
  return !!(entry && entry.manifest && entry.manifest.audioBus === true);
}

function label(entry) {
  return `adapter ${entry.manifest.prefix}://${entry.instance.name}`;
}

function stateFor(entry, bus) {
  if (!entry.audio) {
    entry.audio = {
      client: bus.createClient(label(entry)),
      unsubscribe: new Map(), // kind -> Abmeldefunktion
      pending: new Map(), // eventId -> { resolve, timer }
      sequence: 0,
    };
  }
  return entry.audio;
}

function settle(state, eventId) {
  const pending = state.pending.get(eventId);
  if (!pending) return;
  state.pending.delete(eventId);
  clearTimeout(pending.timer);
  pending.resolve();
}

function forwarder(entry, state, kind) {
  return (session, second, third) => new Promise((resolve) => {
    const child = entry.child;
    if (!child) return resolve();
    state.sequence += 1;
    const eventId = state.sequence;
    const timer = setTimeout(() => settle(state, eventId), ACK_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    state.pending.set(eventId, { resolve, timer });
    const message = { type: 'audio-event', eventId, kind, session };
    if (kind === 'input') {
      message.chunk = second;
      message.info = third;
    } else if (kind === 'ended') {
      message.reason = second;
    }
    try {
      child.send(message, (error) => { if (error) settle(state, eventId); });
    } catch (_) {
      settle(state, eventId);
    }
    return null;
  });
}

function subscribe(entry, state, kinds) {
  const wanted = new Set((Array.isArray(kinds) ? kinds : []).filter((kind) => Object.prototype.hasOwnProperty.call(KINDS, kind)));
  for (const [kind, off] of Array.from(state.unsubscribe)) {
    if (wanted.has(kind)) continue;
    off();
    state.unsubscribe.delete(kind);
  }
  for (const kind of wanted) {
    if (state.unsubscribe.has(kind)) continue;
    state.unsubscribe.set(kind, state.client[KINDS[kind]](forwarder(entry, state, kind)));
  }
}

function reply(entry, message) {
  if (!entry.child) return;
  try {
    entry.child.send(message);
  } catch (_) {
    /* Kanal weg – Kind startet neu */
  }
}

function call(entry, state, msg) {
  const response = { type: 'audio-call-result', requestId: msg.requestId };
  try {
    if (!METHODS.includes(msg.method)) throw Object.assign(new Error('Unbekannte Audio-Bus-Methode.'), { code: 'unknown_method' });
    const { client } = state;
    if (msg.method === 'startOutput') response.result = client.startOutput(msg.sessionId, msg.format);
    else if (msg.method === 'sendAudio') response.result = client.sendAudio(msg.sessionId, msg.chunk);
    else if (msg.method === 'endOutput') response.result = client.endOutput(msg.sessionId);
    else if (msg.method === 'getSession') response.result = client.getSession(msg.sessionId);
    else response.result = client.listSessions();
  } catch (error) {
    response.error = error && error.message ? error.message : String(error);
    response.code = error && error.code ? String(error.code) : 'error';
  }
  reply(entry, response);
}

// Audio-Nachricht eines Adapter-Kindprozesses verarbeiten. Liefert true, wenn
// die Nachricht zum Audio Bus gehörte.
function handleMessage(entry, msg, bus = defaultBus()) {
  if (!msg || !['audio-subscribe', 'audio-call', 'audio-ack'].includes(msg.type)) return false;
  if (!permitted(entry)) {
    if (msg.type === 'audio-call') {
      reply(entry, {
        type: 'audio-call-result',
        requestId: msg.requestId,
        error: 'Dieser Adapter hat keinen Zugriff auf den Audio Bus (Manifest: "audioBus": true).',
        code: 'audio_not_permitted',
      });
    }
    return true;
  }
  if (msg.type === 'audio-ack') {
    if (entry.audio) settle(entry.audio, msg.eventId);
    return true;
  }
  const state = stateFor(entry, bus);
  if (msg.type === 'audio-subscribe') subscribe(entry, state, msg.kinds);
  else call(entry, state, msg);
  return true;
}

// Kindprozess beendet oder Instanz gestoppt: Abos lösen, eigene Output-
// Streams beenden, wartende Zustellungen freigeben.
function release(entry) {
  const state = entry && entry.audio;
  if (!state) return;
  entry.audio = null;
  for (const eventId of Array.from(state.pending.keys())) settle(state, eventId);
  try {
    state.client.close();
  } catch (_) {
    /* Bus bereits beendet */
  }
}

module.exports = { handleMessage, release, permitted, ACK_TIMEOUT_MS };
