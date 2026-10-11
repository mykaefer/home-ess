'use strict';

// WebSocket-Endpunkt des Audio Bus: /api/v1/audio/ws
//
// Liegt auf demselben HTTP-Server wie die Weboberfläche und die States API
// (Upgrade-Handler, kein zweiter Server). Angemeldet wird exakt wie bei der
// States API: Bearer-Token aus POST /api/v1/auth im Authorization-Header des
// Upgrade-Requests. Ohne gültiges Token wird der Upgrade mit 401/403
// abgewiesen, bevor eine WebSocket-Verbindung entsteht. Das Token wird
// periodisch erneut geprüft — Ablauf, Logout, Passwortänderung oder das
// Abschalten der API beenden Session und Verbindung.
//
// Eine Verbindung führt höchstens eine aktive Session; Binärframes gehören
// immer zu dieser Session. Parallele Sessions laufen über getrennte
// Verbindungen. Die Zuordnung Session ↔ Verbindung liegt nur im Server.

const http = require('http');
const { WebSocketServer } = require('ws');
const apiAuth = require('../states-api/auth');
const { CODECS } = require('./formats');
const { parseControl, validateStart, validateEnd } = require('./protocol');

const AUDIO_WS_PATH = '/api/v1/audio/ws';
const PROTOCOL_VERSION = 1;

const DEFAULT_OPTIONS = Object.freeze({
  maxConnections: 32,
  // Abstand der erneuten Token-Prüfung offener Verbindungen.
  authCheckMs: 5000,
  // Ping-Intervall; ohne Pong bis zum nächsten Ping gilt der Client als weg.
  heartbeatMs: 15000,
  // Harte Obergrenze je WebSocket-Nachricht (darüber schließt ws mit 1009).
  maxPayloadBytes: 256 * 1024,
  // Nach so vielen Protokollfehlern wird die Verbindung getrennt.
  maxProtocolErrors: 20,
  // Höchstens so viele Control-Messages je Fenster.
  controlWindowMs: 10000,
  maxControlPerWindow: 60,
});

const REJECT_STATUS = { api_disabled: 403, unauthorized: 401, token_invalid: 401, token_expired: 401 };
const REJECT_MESSAGES = {
  api_disabled: 'Die States API ist deaktiviert.',
  unauthorized: 'Anmeldung erforderlich. Bearer-Token der States API im Authorization-Header senden.',
  token_invalid: 'Das Zugriffstoken ist ungültig.',
  token_expired: 'Das Zugriffstoken ist abgelaufen. Bitte neu anmelden.',
  too_many_connections: 'Zu viele Audio-Verbindungen.',
  unavailable: 'Der Audio Bus wird beendet.',
  not_found: 'Diesen Endpunkt gibt es nicht.',
};

// Close-Codes (4000–4999 anwendungsspezifisch).
const CLOSE_AUTH = 4401;
const CLOSE_POLICY = 1008;
const CLOSE_GOING_AWAY = 1001;

const REJECT_LOG_INTERVAL_MS = 60 * 1000;

const defaultLogger = {
  info: (message) => console.log(`[audio-bus] ${message}`),
  warn: (message) => console.warn(`[audio-bus] ${message}`),
  error: (message) => console.error(`[audio-bus] ${message}`),
};

function rejectUpgrade(socket, status, code, headers = {}) {
  const body = JSON.stringify({ error: code, message: REJECT_MESSAGES[code] || code });
  const lines = [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ''}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  try {
    socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
  } catch (_) {
    /* Socket bereits weg */
  }
  socket.destroy();
}

function createAudioWsServer({ bus, path = AUDIO_WS_PATH, auth = apiAuth, options = {}, logger = defaultLogger } = {}) {
  if (!bus) throw new TypeError('createAudioWsServer benötigt einen Audio Bus.');
  let opts = Object.freeze({ ...DEFAULT_OPTIONS, ...options });
  const log = logger;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes, perMessageDeflate: false });
  const connections = new Set();
  let authTimer = null;
  let heartbeatTimer = null;
  let closing = false;
  let rejectLoggedAt = 0;
  let rejectedSinceLog = 0;

  function send(conn, message) {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(message));
    } catch (_) {
      /* Verbindung bricht gerade ab */
    }
  }

  function sendError(conn, code, message, sessionId) {
    send(conn, { type: 'audio.error', code, message, ...(sessionId ? { session_id: sessionId } : {}) });
  }

  function protocolError(conn, code, message, sessionId) {
    conn.protocolErrors += 1;
    sendError(conn, code, message, sessionId);
    if (conn.protocolErrors === 1) log.warn(`Protocol error (${code}) von ${conn.remoteAddress}.`);
    if (conn.protocolErrors > opts.maxProtocolErrors) {
      log.warn(`Protocol error: ${conn.protocolErrors} Fehler von ${conn.remoteAddress}, Verbindung wird getrennt.`);
      closeConnection(conn, CLOSE_POLICY, 'protocol_error', 'protocol_error');
    }
  }

  // Session beenden (falls vorhanden) und Verbindung schließen.
  function closeConnection(conn, closeCode, closeReason, sessionReason) {
    conn.closing = true;
    if (conn.session) bus.endSession(conn.session.sessionId, sessionReason);
    try {
      conn.ws.close(closeCode, closeReason);
    } catch (_) {
      conn.ws.terminate();
    }
  }

  function dropForAuth(conn, code) {
    if (conn.closing) return;
    conn.closing = true;
    sendError(conn, code, REJECT_MESSAGES[code] || code, conn.session ? conn.session.sessionId : undefined);
    log.warn(`Anmeldung einer Audio-Verbindung (${conn.remoteAddress}) nicht mehr gültig (${code}), Verbindung wird getrennt.`);
    closeConnection(conn, CLOSE_AUTH, code, 'auth_lost');
  }

  function checkAuth(conn) {
    const result = auth.verifyToken(conn.token);
    if (!result.ok) {
      dropForAuth(conn, result.code);
      return false;
    }
    return true;
  }

  function withinControlRate(conn) {
    const at = Date.now();
    if (at - conn.windowStart >= opts.controlWindowMs) {
      conn.windowStart = at;
      conn.windowCount = 0;
    }
    conn.windowCount += 1;
    return conn.windowCount <= opts.maxControlPerWindow;
  }

  function handleStart(conn, message) {
    if (conn.session) {
      return protocolError(conn, 'session_active', 'Auf dieser Verbindung ist bereits eine Session aktiv. Zuerst audio.end senden.', conn.session.sessionId);
    }
    if (!checkAuth(conn)) return null;
    const validated = validateStart(message);
    if (!validated.ok) return protocolError(conn, validated.code, validated.message);
    const result = bus.openSession(conn.transport, {
      ...validated.params,
      client: { type: 'states-api', id: conn.tokenId, remoteAddress: conn.remoteAddress },
    });
    if (!result.ok) return sendError(conn, result.code, result.message);
    conn.session = result.session;
    return send(conn, {
      type: 'audio.started',
      session_id: result.session.sessionId,
      codec: result.session.codec,
      sample_rate: result.session.sampleRate,
      channels: result.session.channels,
    });
  }

  function handleEnd(conn, message) {
    const validated = validateEnd(message);
    if (!validated.ok) return protocolError(conn, validated.code, validated.message);
    // Nur die eigene Session. Fremde IDs werden wie unbekannte behandelt,
    // damit ein Client nicht einmal ihre Existenz erfährt.
    if (!conn.session || conn.session.sessionId !== validated.sessionId) {
      return protocolError(conn, 'session_not_found', 'Diese Session gehört nicht zu dieser Verbindung.');
    }
    // Bestätigung (audio.ended) sendet transport.sessionEnded().
    bus.endSession(validated.sessionId, 'client_end', { transport: conn.transport });
    return null;
  }

  function onMessage(conn, data, isBinary) {
    if (conn.closing) return;
    if (isBinary) {
      if (!conn.session) return protocolError(conn, 'no_active_session', 'Audio-Frames erst nach audio.start senden.');
      const result = bus.pushInput(conn.session.sessionId, conn.transport, data);
      if (!result.ok) protocolError(conn, result.code, result.message, conn.session && conn.session.sessionId);
      return;
    }
    if (!withinControlRate(conn)) {
      log.warn(`Protocol error: zu viele Control-Messages von ${conn.remoteAddress}, Verbindung wird getrennt.`);
      closeConnection(conn, CLOSE_POLICY, 'rate_limit', 'protocol_error');
      return;
    }
    const parsed = parseControl(data);
    if (!parsed.ok) return protocolError(conn, parsed.code, parsed.message);
    const { message } = parsed;
    if (message.type === 'ping') return send(conn, { type: 'pong' });
    if (message.type === 'audio.start') return handleStart(conn, message);
    if (message.type === 'audio.end') return handleEnd(conn, message);
    return null;
  }

  function onClose(conn, code) {
    if (!connections.delete(conn)) return;
    const session = conn.session;
    if (session) bus.endSession(session.sessionId, 'disconnect');
    log.info(`Client disconnected (${conn.remoteAddress}, Code ${code}${session ? `, Session ${String(session.sessionId).slice(0, 8)}` : ''}, verbunden: ${connections.size})`);
    stopTimersIfIdle();
  }

  function startTimers() {
    if (!authTimer) {
      authTimer = setInterval(() => {
        for (const conn of Array.from(connections)) if (!conn.closing) checkAuth(conn);
      }, opts.authCheckMs);
      if (typeof authTimer.unref === 'function') authTimer.unref();
    }
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        for (const conn of Array.from(connections)) {
          if (!conn.alive) {
            // Client abgestürzt oder Netz weg: close-Event räumt die Session auf.
            conn.ws.terminate();
            continue;
          }
          conn.alive = false;
          try {
            conn.ws.ping();
          } catch (_) {
            /* Abbruch folgt über close */
          }
        }
      }, opts.heartbeatMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    }
  }

  function stopTimersIfIdle() {
    if (connections.size) return;
    if (authTimer) clearInterval(authTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    authTimer = null;
    heartbeatTimer = null;
  }

  function onConnection(ws, req, authResult) {
    const conn = {
      ws,
      // Nur für die erneute Prüfung im Speicher; wird nie ausgegeben oder geloggt.
      token: authResult.token,
      tokenId: authResult.tokenId,
      remoteAddress: String((req.socket && req.socket.remoteAddress) || 'unknown'),
      session: null,
      protocolErrors: 0,
      alive: true,
      closing: false,
      windowStart: Date.now(),
      windowCount: 0,
    };
    conn.transport = {
      sendControl: (message) => send(conn, message),
      sendBinary: (buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(buffer, { binary: true });
      },
      bufferedAmount: () => ws.bufferedAmount,
      isOpen: () => ws.readyState === ws.OPEN,
      sessionEnded: (session, reason) => {
        if (conn.session && conn.session.sessionId === session.sessionId) conn.session = null;
        send(conn, { type: 'audio.ended', session_id: session.sessionId, reason });
      },
    };
    connections.add(conn);
    startTimers();
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('pong', () => { conn.alive = true; });
    ws.on('close', (code) => onClose(conn, code));
    ws.on('error', (error) => {
      // z. B. Nachricht über maxPayload (ws schließt dann selbst mit 1009).
      log.warn(`Protocol error: WebSocket-Fehler von ${conn.remoteAddress} (${error && error.code ? error.code : 'unbekannt'}).`);
    });
    send(conn, {
      type: 'audio.ready',
      protocol: PROTOCOL_VERSION,
      max_frame_bytes: bus.limits.maxInputFrameBytes,
      idle_timeout_ms: bus.limits.idleTimeoutMs,
      max_session_ms: bus.limits.maxSessionMs,
      codecs: Object.fromEntries(Object.entries(CODECS).map(([name, spec]) => [name, {
        sample_rates: spec.sampleRates,
        max_channels: spec.maxChannels,
      }])),
    });
  }

  function logRejected(code) {
    rejectedSinceLog += 1;
    const at = Date.now();
    if (at - rejectLoggedAt < REJECT_LOG_INTERVAL_MS) return;
    log.warn(`Audio-WebSocket abgewiesen (${code}; ${rejectedSinceLog} Abweisung(en) seit letzter Meldung).`);
    rejectLoggedAt = at;
    rejectedSinceLog = 0;
  }

  // Liefert false, wenn der Upgrade nicht diesem Endpunkt gilt.
  function handleUpgrade(req, socket, head) {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      pathname = '';
    }
    if (pathname !== path) return false;
    socket.on('error', () => {});
    if (closing) {
      rejectUpgrade(socket, 503, 'unavailable');
      return true;
    }
    const result = auth.verifyAuthorization(req.headers.authorization);
    if (!result.ok) {
      logRejected(result.code);
      const status = REJECT_STATUS[result.code] || 401;
      const headers = status === 401
        ? { 'WWW-Authenticate': `Bearer realm="homeESS States API"${result.code === 'unauthorized' ? '' : ', error="invalid_token"'}` }
        : {};
      rejectUpgrade(socket, status, result.code, headers);
      return true;
    }
    if (connections.size >= opts.maxConnections) {
      logRejected('too_many_connections');
      rejectUpgrade(socket, 503, 'too_many_connections');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, result));
    return true;
  }

  // An den HTTP-Server hängen. homeESS hat sonst keine WebSocket-Endpunkte;
  // unbekannte Upgrade-Pfade werden deshalb mit 404 beendet statt offen zu
  // hängen.
  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      if (!handleUpgrade(req, socket, head)) {
        socket.on('error', () => {});
        rejectUpgrade(socket, 404, 'not_found');
      }
    });
  }

  function shutdown() {
    closing = true;
    for (const conn of Array.from(connections)) {
      conn.closing = true;
      closeConnection(conn, CLOSE_GOING_AWAY, 'server_shutdown', 'server_shutdown');
    }
    const killTimer = setTimeout(() => {
      for (const conn of Array.from(connections)) conn.ws.terminate();
    }, 1000);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    stopTimersIfIdle();
    wss.close();
  }

  function status() {
    return { endpoint: path, connections: connections.size, maxConnections: opts.maxConnections };
  }

  return { path, handleUpgrade, attach, shutdown, status, setMaxConnections(value) {
    if (!Number.isInteger(value) || value < 1 || value > 512) throw new RangeError('invalid_connection_limit');
    opts = Object.freeze({ ...opts, maxConnections: value });
  } };
}

module.exports = { createAudioWsServer, AUDIO_WS_PATH, PROTOCOL_VERSION, DEFAULT_OPTIONS };
