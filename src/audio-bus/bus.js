'use strict';

// Zentraler Audio Bus von homeESS.
//
// Transport- und Routing-Infrastruktur für bidirektionale Audio-Sessions —
// kein Audio-Processing: Der Bus transcodiert nicht, zeichnet nichts auf und
// transportiert Audio nie über das State-System.
//
//   Client (WebSocket) ──Input──▶ Bus ──▶ Plugin-Clients (je eigene Queue)
//   Client (WebSocket) ◀─Output── Bus ◀── genau ein Plugin je Session
//
// Eine Session gehört serverseitig genau einem Transport (der WebSocket-
// Verbindung, die sie eröffnet hat). Input wird nur über diesen Transport
// angenommen, Output nur an ihn ausgeliefert — Session-IDs aus Nachrichten
// eines Clients entscheiden nie über das Routing.
//
// Plugins (interne homeESS-Module oder Adapter über adapter-bridge.js) holen
// sich mit createClient(name) eine Plugin-Schnittstelle. Jeder Plugin-Client
// hat eine eigene, begrenzte Ereignis-Queue: Ein langsamer oder hängender
// Consumer blockiert weder den WebSocket-Empfang noch andere Plugins. Läuft
// seine Queue über, werden neue Audio-Chunks für ihn verworfen (gezählt und
// als Lücke im nächsten Chunk gemeldet); Start-/Ende-Ereignisse gehen nicht
// verloren.

const crypto = require('crypto');
const { validateFormat, isAlignedFrame } = require('./formats');

const DEFAULT_LIMITS = Object.freeze({
  // Gleichzeitig aktive Sessions über alle Clients.
  maxSessions: 16,
  // Größter Input-Frame eines Clients (32 KiB ≈ 1 s PCM 16 kHz mono).
  maxInputFrameBytes: 32 * 1024,
  // Größter Output-Chunk eines Plugins.
  maxOutputChunkBytes: 64 * 1024,
  // Queue je Plugin-Client: höchstens so viele Audio-Chunks bzw. Bytes.
  queueMaxItems: 256,
  queueMaxBytes: 1024 * 1024,
  // Obergrenze für wartende Start-/Ende-Ereignisse je Plugin-Client.
  lifecycleQueueMaxItems: 1024,
  // Längste Laufzeit eines einzelnen Plugin-Callbacks, bevor die Queue
  // weiterläuft (der Callback selbst wird nicht abgebrochen).
  handlerTimeoutMs: 10 * 1000,
  // Session endet ohne Input/Output-Aktivität nach dieser Zeit.
  idleTimeoutMs: 30 * 1000,
  // Harte Obergrenze der Session-Dauer.
  maxSessionMs: 15 * 60 * 1000,
  // Noch nicht an den Client übertragene Output-Bytes je Session.
  outputBufferBytes: 1024 * 1024,
  sweepIntervalMs: 1000,
});

const SESSION_END_REASONS = Object.freeze([
  'client_end', 'disconnect', 'idle_timeout', 'session_timeout', 'auth_lost', 'server_shutdown', 'protocol_error',
]);

const OVERFLOW_LOG_INTERVAL_MS = 10 * 1000;
const SUBSCRIBER_ERROR_LOG_INTERVAL_MS = 30 * 1000;

class AudioBusError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AudioBusError';
    this.code = code;
  }
}

const defaultLogger = {
  info: (message) => console.log(`[audio-bus] ${message}`),
  warn: (message) => console.warn(`[audio-bus] ${message}`),
  error: (message) => console.error(`[audio-bus] ${message}`),
};

// Kurzform der Session-ID für Logs. Gerätenamen, Räume und Audioinhalte
// gehören nicht ins normale Log.
function shortId(id) {
  return String(id || '').slice(0, 8);
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return null;
}

function formatFromParams(params = {}) {
  return validateFormat({
    codec: params.codec,
    sampleRate: params.sampleRate != null ? params.sampleRate : params.sample_rate,
    channels: params.channels,
  });
}

function createAudioBus(options = {}) {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
  const log = options.logger || defaultLogger;
  const now = options.now || Date.now;

  const sessions = new Map(); // sessionId -> interne Session
  const clients = new Set(); // Plugin-Clients
  const changeListeners = new Set();
  const counters = {
    sessionsStarted: 0,
    sessionsEnded: 0,
    inputFrames: 0,
    inputBytes: 0,
    droppedChunks: 0,
    subscriberErrors: 0,
    outputChunks: 0,
    outputRejected: 0,
  };
  let sweepTimer = null;
  let closed = false;

  // ── Hilfen ──────────────────────────────────────────────────────────────

  function outputView(output) {
    if (!output) return null;
    return Object.freeze({
      owner: output.owner.name,
      codec: output.format.codec,
      sampleRate: output.format.sampleRate,
      channels: output.format.channels,
      startedAt: output.startedAt,
    });
  }

  // Öffentliche, eingefrorene Sicht auf eine Session für Plugins. Neue
  // Metadaten kommen hier hinzu, ohne dass sich die Plugin-API ändert.
  function viewOf(session) {
    return Object.freeze({
      sessionId: session.id,
      status: session.status,
      // Serverseitig festgestellte Identität. Clientangaben können sie nicht
      // überschreiben — sie stehen getrennt unter deviceId/source/room/metadata.
      client: session.client,
      deviceId: session.deviceId,
      source: session.source,
      room: session.room,
      codec: session.format.codec,
      sampleRate: session.format.sampleRate,
      channels: session.format.channels,
      metadata: session.metadata,
      createdAt: session.createdAt,
      lastInputAt: session.lastInputAt,
      endedAt: session.endedAt,
      endReason: session.endReason,
      output: outputView(session.output),
    });
  }

  function notifyChange() {
    for (const listener of changeListeners) {
      try {
        listener();
      } catch (_) {
        /* Beobachter dürfen den Bus nicht stören */
      }
    }
  }

  function ensureSweep() {
    if (sweepTimer || !sessions.size) return;
    sweepTimer = setInterval(sweep, limits.sweepIntervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function stopSweepIfIdle() {
    if (sweepTimer && !sessions.size) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function sweep() {
    const at = now();
    for (const session of Array.from(sessions.values())) {
      if (at - session.createdAt >= limits.maxSessionMs) endSession(session.id, 'session_timeout');
      else if (at - session.lastActivityAt >= limits.idleTimeoutMs) endSession(session.id, 'idle_timeout');
    }
    stopSweepIfIdle();
  }

  // ── Plugin-Queues ──────────────────────────────────────────────────────

  function logOverflow(client, session) {
    const at = now();
    const last = client.overflowLoggedAt.get(session.id) || 0;
    if (at - last < OVERFLOW_LOG_INTERVAL_MS) return;
    client.overflowLoggedAt.set(session.id, at);
    log.warn(`Queue overflow: Plugin „${client.name}“ kommt nicht nach, Audio-Chunks der Session ${shortId(session.id)} werden verworfen (bisher ${client.dropped}).`);
  }

  function subscriberError(client, error) {
    counters.subscriberErrors += 1;
    client.errors += 1;
    const at = now();
    if (at - client.errorLoggedAt < SUBSCRIBER_ERROR_LOG_INTERVAL_MS) return;
    client.errorLoggedAt = at;
    const detail = error && error.message ? error.message : String(error);
    log.error(`Plugin subscriber error (${client.name}): ${detail} (Fehler gesamt: ${client.errors})`);
  }

  function enqueue(client, item) {
    if (client.closed) return;
    if (item.kind === 'input') {
      const size = item.chunk.length;
      if (client.inputItems >= limits.queueMaxItems || client.queueBytes + size > limits.queueMaxBytes) {
        client.dropped += 1;
        counters.droppedChunks += 1;
        item.session.droppedChunks += 1;
        client.gaps.set(item.session.id, (client.gaps.get(item.session.id) || 0) + 1);
        logOverflow(client, item.session);
        return;
      }
      item.droppedBefore = client.gaps.get(item.session.id) || 0;
      client.gaps.delete(item.session.id);
      client.inputItems += 1;
      client.queueBytes += size;
    } else if (client.queue.length - client.inputItems >= limits.lifecycleQueueMaxItems) {
      // Nur bei einem dauerhaft blockierten Consumer erreichbar.
      subscriberError(client, new Error('Ereignis-Queue voll, Session-Ereignis verworfen.'));
      return;
    }
    client.queue.push(item);
    if (!client.draining) {
      client.draining = true;
      // Nie synchron im Empfangspfad des WebSockets ausliefern.
      setImmediate(() => drain(client));
    }
  }

  function callHandler(client, handler, args) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        subscriberError(client, new Error(`Callback hat nach ${limits.handlerTimeoutMs} ms nicht geantwortet.`));
        resolve();
      }, limits.handlerTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    let result;
    try {
      result = handler(...args);
    } catch (error) {
      clearTimeout(timer);
      subscriberError(client, error);
      return null;
    }
    if (!result || typeof result.then !== 'function') {
      clearTimeout(timer);
      return null;
    }
    return Promise.race([
      Promise.resolve(result).catch((error) => subscriberError(client, error)),
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  async function drain(client) {
    try {
      while (client.queue.length && !client.closed) {
        const item = client.queue.shift();
        if (item.kind === 'input') {
          client.inputItems -= 1;
          client.queueBytes -= item.chunk.length;
        }
        const handlers = Array.from(client.handlers[item.kind]);
        const view = viewOf(item.session);
        let args;
        if (item.kind === 'input') {
          args = [view, item.chunk, Object.freeze({ seq: item.seq, receivedAt: item.receivedAt, droppedBefore: item.droppedBefore })];
        } else if (item.kind === 'ended') {
          args = [view, item.session.endReason];
        } else {
          args = [view];
        }
        for (const handler of handlers) {
          const pending = callHandler(client, handler, args);
          // eslint-disable-next-line no-await-in-loop
          if (pending) await pending;
        }
      }
    } finally {
      client.draining = false;
      if (client.queue.length && !client.closed) {
        client.draining = true;
        setImmediate(() => drain(client));
      }
    }
  }

  function broadcast(kind, session, extra = {}) {
    for (const client of clients) {
      if (!client.handlers[kind].size) continue;
      enqueue(client, { kind, session, ...extra });
    }
  }

  // ── Sessions (Transportseite) ──────────────────────────────────────────

  // Neue Session für einen Transport öffnen. `transport` ist die serverseitige
  // Verbindung ({ sendControl, sendBinary, bufferedAmount, isOpen,
  // sessionEnded }). `client` ist die authentifizierte Identität, alle übrigen
  // Felder sind Clientangaben (bereits vom Protokoll validiert).
  // Ergebnis: { ok: true, session } | { ok: false, code, message }
  function openSession(transport, params = {}) {
    if (closed) return { ok: false, code: 'bus_closed', message: 'Der Audio Bus wird beendet.' };
    if (!transport || typeof transport.sendControl !== 'function') {
      throw new TypeError('openSession benötigt einen Transport.');
    }
    if (sessions.size >= limits.maxSessions) {
      return { ok: false, code: 'too_many_sessions', message: 'Maximale Anzahl gleichzeitiger Audio-Sessions erreicht.' };
    }
    const format = formatFromParams(params);
    if (!format.ok) return format;
    let id = crypto.randomUUID();
    while (sessions.has(id)) id = crypto.randomUUID();
    const at = now();
    const session = {
      id,
      transport,
      status: 'active',
      client: Object.freeze({ ...(params.client || { type: 'internal', id: 'unknown' }) }),
      deviceId: String(params.deviceId || ''),
      source: String(params.source || ''),
      room: params.room == null || params.room === '' ? null : String(params.room),
      format: format.format,
      metadata: Object.freeze({ ...(params.metadata || {}) }),
      createdAt: at,
      lastInputAt: null,
      lastActivityAt: at,
      endedAt: null,
      endReason: null,
      inputSeq: 0,
      droppedChunks: 0,
      output: null,
    };
    sessions.set(id, session);
    counters.sessionsStarted += 1;
    log.info(`Audio session started ${shortId(id)} (Quelle ${session.source}, ${session.format.codec} ${session.format.sampleRate} Hz × ${session.format.channels}, aktiv: ${sessions.size})`);
    ensureSweep();
    broadcast('started', session);
    notifyChange();
    return { ok: true, session: viewOf(session) };
  }

  // Binären Input eines Clients annehmen. Nur der Transport, dem die Session
  // gehört, darf Input liefern.
  // Ergebnis: { ok: true, seq } | { ok: false, code, message }
  function pushInput(sessionId, transport, chunk) {
    const session = sessions.get(sessionId);
    if (!session || session.transport !== transport || session.status !== 'active') {
      return { ok: false, code: 'session_not_found', message: 'Keine aktive Session für diese Verbindung.' };
    }
    const buffer = toBuffer(chunk);
    if (!buffer || !buffer.length) return { ok: false, code: 'invalid_frame', message: 'Leerer oder ungültiger Audio-Frame.' };
    if (buffer.length > limits.maxInputFrameBytes) {
      return { ok: false, code: 'frame_too_large', message: `Audio-Frame zu groß (höchstens ${limits.maxInputFrameBytes} Bytes).` };
    }
    if (!isAlignedFrame(session.format, buffer.length)) {
      return { ok: false, code: 'invalid_frame', message: 'Audio-Frame enthält keine ganzen Samples.' };
    }
    const at = now();
    session.lastInputAt = at;
    session.lastActivityAt = at;
    session.inputSeq += 1;
    counters.inputFrames += 1;
    counters.inputBytes += buffer.length;
    broadcast('input', session, { chunk: buffer, seq: session.inputSeq, receivedAt: at });
    return { ok: true, seq: session.inputSeq };
  }

  // Session beenden. Mit `transport` nur, wenn sie diesem Transport gehört
  // (clientseitiges audio.end); ohne `transport` serverseitig (Timeout,
  // Shutdown, Verbindungsabbruch).
  function endSession(sessionId, reason = 'client_end', { transport = null } = {}) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (transport && session.transport !== transport) return false;
    const endReason = SESSION_END_REASONS.includes(reason) ? reason : 'client_end';
    sessions.delete(sessionId);
    session.status = 'ended';
    session.endedAt = now();
    session.endReason = endReason;
    if (session.output) {
      session.output.owner.outputs.delete(session.id);
      if (safeIsOpen(session.transport)) {
        safeControl(session.transport, { type: 'audio.output.end', session_id: session.id });
      }
      session.output = null;
    }
    counters.sessionsEnded += 1;
    const view = viewOf(session);
    try {
      if (typeof session.transport.sessionEnded === 'function') session.transport.sessionEnded(view, endReason);
    } catch (_) {
      /* Transport bereits geschlossen */
    }
    for (const client of clients) {
      client.gaps.delete(session.id);
      client.overflowLoggedAt.delete(session.id);
    }
    const seconds = Math.round((session.endedAt - session.createdAt) / 1000);
    log.info(`Audio session ended ${shortId(session.id)} (Grund ${endReason}, ${seconds} s, ${session.inputSeq} Frames${session.droppedChunks ? `, ${session.droppedChunks} verworfen` : ''}, aktiv: ${sessions.size})`);
    broadcast('ended', session);
    stopSweepIfIdle();
    notifyChange();
    return true;
  }

  function safeIsOpen(transport) {
    try {
      return typeof transport.isOpen !== 'function' || transport.isOpen();
    } catch (_) {
      return false;
    }
  }

  function safeControl(transport, message) {
    try {
      transport.sendControl(message);
    } catch (_) {
      /* Transport bereits geschlossen */
    }
  }

  // ── Output (Pluginseite) ───────────────────────────────────────────────

  function activeSession(sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.status !== 'active') throw new AudioBusError('session_not_found', 'Diese Audio-Session existiert nicht (mehr).');
    return session;
  }

  function startOutput(client, sessionId, params) {
    const session = activeSession(sessionId);
    const format = formatFromParams(params || {});
    if (!format.ok) throw new AudioBusError(format.code, format.message);
    if (session.output) {
      if (session.output.owner === client) throw new AudioBusError('output_active', 'Für diese Session läuft bereits ein Output-Stream.');
      throw new AudioBusError('output_busy', 'Ein anderes Plugin sendet bereits Audio an diese Session.');
    }
    if (!safeIsOpen(session.transport)) throw new AudioBusError('client_disconnected', 'Der Client ist nicht mehr verbunden.');
    session.output = { owner: client, format: format.format, startedAt: now(), chunks: 0, bytes: 0 };
    session.lastActivityAt = now();
    client.outputs.add(session.id);
    safeControl(session.transport, {
      type: 'audio.output.start',
      session_id: session.id,
      codec: format.format.codec,
      sample_rate: format.format.sampleRate,
      channels: format.format.channels,
    });
    notifyChange();
    return outputView(session.output);
  }

  function ownedOutput(client, session) {
    if (!session.output) throw new AudioBusError('output_not_started', 'Vor dem Senden muss startOutput() aufgerufen werden.');
    if (session.output.owner !== client) throw new AudioBusError('output_busy', 'Ein anderes Plugin sendet bereits Audio an diese Session.');
    return session.output;
  }

  function sendAudio(client, sessionId, chunk) {
    const session = activeSession(sessionId);
    const output = ownedOutput(client, session);
    const buffer = toBuffer(chunk);
    if (!buffer || !buffer.length) throw new AudioBusError('invalid_chunk', 'Leerer oder ungültiger Audio-Chunk.');
    if (buffer.length > limits.maxOutputChunkBytes) {
      throw new AudioBusError('chunk_too_large', `Audio-Chunk zu groß (höchstens ${limits.maxOutputChunkBytes} Bytes).`);
    }
    if (!isAlignedFrame(output.format, buffer.length)) throw new AudioBusError('invalid_chunk', 'Audio-Chunk enthält keine ganzen Samples.');
    if (!safeIsOpen(session.transport)) throw new AudioBusError('client_disconnected', 'Der Client ist nicht mehr verbunden.');
    const buffered = Number(session.transport.bufferedAmount ? session.transport.bufferedAmount() : 0) || 0;
    if (buffered + buffer.length > limits.outputBufferBytes) {
      counters.outputRejected += 1;
      const at = now();
      if (at - (session.outputOverflowLoggedAt || 0) >= OVERFLOW_LOG_INTERVAL_MS) {
        session.outputOverflowLoggedAt = at;
        log.warn(`Queue overflow: Output an Session ${shortId(session.id)} staut sich beim Client (${buffered} Bytes ausstehend).`);
      }
      throw new AudioBusError('output_backpressure', 'Der Client nimmt Audio gerade nicht schnell genug ab. Später erneut senden.');
    }
    session.transport.sendBinary(buffer);
    output.chunks += 1;
    output.bytes += buffer.length;
    session.lastActivityAt = now();
    counters.outputChunks += 1;
    return { bufferedAmount: buffered + buffer.length };
  }

  function endOutput(client, sessionId) {
    const session = activeSession(sessionId);
    ownedOutput(client, session);
    session.output = null;
    session.lastActivityAt = now();
    client.outputs.delete(session.id);
    if (safeIsOpen(session.transport)) safeControl(session.transport, { type: 'audio.output.end', session_id: session.id });
    notifyChange();
    return true;
  }

  // ── Plugin-API ─────────────────────────────────────────────────────────

  function getSession(sessionId) {
    const session = sessions.get(String(sessionId || ''));
    return session ? viewOf(session) : null;
  }

  function listSessions() {
    return Array.from(sessions.values(), viewOf);
  }

  // Plugin-Schnittstelle. Interne Plugins laufen im vertrauenswürdigen
  // homeESS-Kontext und authentifizieren sich nicht. `name` dient nur Logs und
  // der Output-Zuordnung.
  function createClient(name) {
    if (closed) throw new AudioBusError('bus_closed', 'Der Audio Bus wird beendet.');
    const client = {
      name: String(name || 'plugin'),
      handlers: { started: new Set(), input: new Set(), ended: new Set() },
      queue: [],
      inputItems: 0,
      queueBytes: 0,
      draining: false,
      closed: false,
      dropped: 0,
      errors: 0,
      errorLoggedAt: 0,
      gaps: new Map(),
      overflowLoggedAt: new Map(),
      outputs: new Set(),
    };
    clients.add(client);

    const subscribe = (kind) => (handler) => {
      if (typeof handler !== 'function') throw new TypeError('Callback muss eine Funktion sein.');
      if (client.closed) throw new AudioBusError('client_closed', 'Plugin-Client ist geschlossen.');
      client.handlers[kind].add(handler);
      notifyChange();
      return () => {
        if (client.handlers[kind].delete(handler)) notifyChange();
      };
    };

    const api = {
      get name() {
        return client.name;
      },
      // handler(session) – neue Session
      onSessionStarted: subscribe('started'),
      // handler(session, chunk, { seq, receivedAt, droppedBefore }) – Input
      // aller Sessions; darf ein Promise liefern (Backpressure).
      onInput: subscribe('input'),
      // handler(session, reason) – Session beendet
      onSessionEnded: subscribe('ended'),
      startOutput: (sessionId, format) => startOutput(client, sessionId, format),
      sendAudio: (sessionId, chunk) => sendAudio(client, sessionId, chunk),
      endOutput: (sessionId) => endOutput(client, sessionId),
      getSession,
      listSessions,
      // Alle Abos lösen und eigene Output-Streams beenden (Plugin stoppt).
      close() {
        if (client.closed) return;
        for (const sessionId of Array.from(client.outputs)) {
          try {
            endOutput(client, sessionId);
          } catch (_) {
            /* Session bereits beendet */
          }
        }
        client.closed = true;
        client.queue.length = 0;
        client.inputItems = 0;
        client.queueBytes = 0;
        for (const set of Object.values(client.handlers)) set.clear();
        clients.delete(client);
        notifyChange();
      },
    };
    return api;
  }

  // ── Status / Lebenszyklus ──────────────────────────────────────────────

  // Diagnose ohne personenbezogene Sessioninhalte (keine Geräte, Räume, IDs).
  function status() {
    let inputSubscribers = 0;
    let queuedChunks = 0;
    for (const client of clients) {
      if (client.handlers.input.size) inputSubscribers += 1;
      queuedChunks += client.inputItems;
    }
    let outputStreams = 0;
    for (const session of sessions.values()) if (session.output) outputStreams += 1;
    return {
      active: !closed,
      sessions: sessions.size,
      pluginClients: clients.size,
      inputSubscribers,
      outputStreams,
      queuedChunks,
      counters: { ...counters },
      limits,
    };
  }

  function onChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  // Server-Shutdown: alle Sessions sauber beenden, Plugins informieren.
  function shutdown(reason = 'server_shutdown') {
    if (closed) return;
    for (const id of Array.from(sessions.keys())) endSession(id, reason);
    closed = true;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    notifyChange();
  }

  return {
    limits,
    openSession,
    pushInput,
    endSession,
    getSession,
    listSessions,
    createClient,
    status,
    onChange,
    shutdown,
    // Nur für Tests: Timeout-Prüfung sofort ausführen.
    _sweep: sweep,
  };
}

module.exports = { createAudioBus, AudioBusError, DEFAULT_LIMITS, SESSION_END_REASONS };
