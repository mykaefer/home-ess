'use strict';

// Authentifizierter Origin-WebSocket-Client (Abschnitt 22/32/33). homeESS
// verbindet sich nach erfolgreichem Pairing als `homeess`-Origin mit dem Relay,
// beantwortet die Challenge mit einer Ed25519-Signatur und hält die Verbindung
// mit begrenztem Reconnect-Backoff. Nach `authenticated` verarbeitet die
// Verbindung zusätzlich den Relay-Tunnel, sofern der Relay die Capability meldet.
//
// Der Instanz-Private-Key bleibt im Identity Store; hier wird nur signiert.
// Vollständige Nachrichten, Nonces, Signaturen und Challenges werden nie
// geloggt.

const crypto = require('crypto');
const defaultIdentityStore = require('./identity-store');
const { RemoteAccessError } = require('./errors');
const { log } = require('./redact');
const { createOriginTunnel } = require('./origin-tunnel');

// Zustände der Verbindungs-State-Machine (Abschnitt I).
const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  WAITING_FOR_CHALLENGE: 'waiting_for_challenge',
  AUTHENTICATING: 'authenticating',
  AUTHENTICATED: 'authenticated',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

const PROTOCOL_VERSION = '0.1';
const CLIENT_TYPE = 'homeess';

// Reconnect-Backoff mit Jitter (Abschnitt I).
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
// Nach so vielen aufeinanderfolgenden Auth-Fehlschlägen (ohne zwischenzeitlichen
// Erfolg) wird nicht weiter versucht — kein Endlos-Auth-Sturm.
const MAX_AUTH_FAILURES = 5;
// Timeout für Handshake/Auth ab Verbindungsaufbau.
const AUTH_TIMEOUT_MS = 20000;
// Liveness: ohne Nachricht in diesem Fenster gilt die Verbindung als tot.
const IDLE_TIMEOUT_MS = 60000;
// Nachrichtengrößenlimit (Handshake-Nachrichten sind klein).
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Erlaubte Feldnamen der Challenge — unbekannte Felder werden strikt abgelehnt.
const CHALLENGE_FIELDS = new Set(['type', 'challengeId', 'nonce', 'issuedAt', 'expiresAt', 'protocolVersion', 'clientType', 'identityId']);

// Erlaubte Feldnamen der connection_status-Nachricht (Abschnitt 39) und ihrer
// Geräteeinträge — unbekannte Felder werden strikt abgelehnt.
const CONNECTION_STATUS_FIELDS = new Set(['type', 'instanceId', 'generatedAt', 'devices']);
const DEVICE_STATUS_FIELDS = new Set(['deviceId', 'deviceName', 'platform', 'pairedAt', 'connected', 'connectedAt']);
// Obergrenze gegen überdimensionierte Nachrichten (das echte Limit ist relay-intern).
const MAX_STATUS_DEVICES = 256;

// Erlaubte Feldnamen der Snapshots/Bestätigungen zur Verknüpfungsentfernung
// (Abschnitt 40/41/43). linked_devices trägt dieselbe Gerätestruktur wie
// connection_status (DEVICE_STATUS_FIELDS).
const LINKED_DEVICES_FIELDS = new Set(['type', 'instanceId', 'revision', 'complete', 'generatedAt', 'devices']);
const LINK_REMOVED_FIELDS = new Set(['type', 'requestId', 'instanceId', 'deviceId', 'removedAt']);

// Timeout für eine remove_link-Anfrage (bis link_removed eintrifft).
const REMOVAL_TIMEOUT_MS = 15000;
const TUNNEL_MESSAGE_TYPES = new Set(['tunnel_request_start', 'tunnel_request_body', 'tunnel_request_end', 'tunnel_cancel']);

function loadDefaultWebSocketImpl() {
  try {
    // ws ist als Abhängigkeit vorhanden (auch transitiv über mqtt).
    return require('ws');
  } catch (_) {
    return null;
  }
}

// Fabrik: ein Origin-Connection-Service je Prozess (Subdienst). Der normale
// lokale Betrieb darf bei Relay-Ausfall nicht blockieren.
function createRelayConnection(options = {}) {
  const identityStore = options.identityStore || defaultIdentityStore;
  const WebSocketImpl = options.WebSocketImpl || loadDefaultWebSocketImpl();
  const wsUrl = options.wsUrl || null;
  const logger = options.logger || log;
  // Senken für den Geräte-Laufzeitstatus (Abschnitt 39). Reine Diagnose; ein
  // Fehler darf die Verbindung nie stören. Defaults sind No-Ops (Tests/Isolation).
  const onConnectionStatus = typeof options.onConnectionStatus === 'function' ? options.onConnectionStatus : () => {};
  const onDisconnected = typeof options.onDisconnected === 'function' ? options.onDisconnected : () => {};
  // Senke für die autoritative Geräteliste (Abschnitt 41). Reine Fachreaktion;
  // ein Fehler darf die Verbindung nie stören.
  const onLinkedDevices = typeof options.onLinkedDevices === 'function' ? options.onLinkedDevices : () => {};
  const removalTimeoutMs = Number.isFinite(options.removalTimeoutMs) ? options.removalTimeoutMs : REMOVAL_TIMEOUT_MS;
  const originTunnel = options.originTunnel || createOriginTunnel({
    WebSocketImpl,
    logger,
    localPort: options.localPort,
    localHost: options.localHost,
    requestImpl: options.requestImpl,
    requestTimeoutMs: options.tunnelRequestTimeoutMs,
    idleTimeoutMs: options.tunnelIdleTimeoutMs,
    maxBufferedAmount: options.tunnelMaxBufferedAmount,
  });
  // Timing/Grenzen — überschreibbar für Tests.
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length ? options.backoffMs : BACKOFF_MS;
  const maxAuthFailures = Number.isFinite(options.maxAuthFailures) ? options.maxAuthFailures : MAX_AUTH_FAILURES;
  const authTimeoutMs = Number.isFinite(options.authTimeoutMs) ? options.authTimeoutMs : AUTH_TIMEOUT_MS;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : IDLE_TIMEOUT_MS;

  let state = STATE.IDLE;
  let ws = null;
  let stopped = false;
  let backoffIndex = 0;
  let authFailures = 0;
  let reconnectTimer = null;
  let authTimer = null;
  let idleTimer = null;
  let generation = 0; // erhöht sich bei jedem Verbindungsversuch; alte Sockets ignorieren
  let identityId = null;
  let connectionId = null;
  let lastError = null;
  let capabilities = null;
  let sinceMs = Date.now();
  const processedChallenges = new Set();
  // Offene remove_link-Anfragen: requestId -> { deviceId, resolve, reject, timer }.
  const pendingRemovals = new Map();

  function setState(next, reason) {
    if (state === next) return;
    const prev = state;
    state = next;
    sinceMs = Date.now();
    logger('WebSocket-Zustand', { state: next, reason: reason || undefined });
    // Verlässt die Verbindung den authentifizierten Zustand, gilt der
    // Geräte-Laufzeitstatus als überholt: Senke informieren (verwirft ihn), ohne
    // die persistenten Kopplungen anzutasten.
    if (prev === STATE.AUTHENTICATED && next !== STATE.AUTHENTICATED) {
      try { originTunnel.abortAll('connection_closed'); } catch (_) { /* Tunnel-Cleanup darf den Reconnect nie stören. */ }
      rejectPendingRemovals('remote_access_not_connected');
      try { onDisconnected(); } catch (_) { /* Laufzeitstatus darf nie stören. */ }
    }
  }

  // Offene Entfernungsanfragen scheitern lassen (Verbindung getrennt): die UI
  // behält das Gerät und zeigt einen Fehler.
  function rejectPendingRemovals(code) {
    for (const [, p] of pendingRemovals) {
      if (p.timer) clearTimeout(p.timer);
      try { p.reject(new RemoteAccessError(code || 'remote_access_not_connected', 'Verbindung getrennt.')); } catch (_) { /* egal */ }
    }
    pendingRemovals.clear();
  }

  function getStatus() {
    return {
      state,
      connectionId: connectionId ? `${String(connectionId).slice(0, 12)}…` : null,
      identityId: identityId ? `${String(identityId).slice(0, 12)}…` : null,
      lastError,
      relayTunnel: capabilities ? Boolean(capabilities.relayTunnel) : false,
      authenticatedWebSocket: capabilities ? Boolean(capabilities.authenticatedWebSocket) : false,
      sinceMs,
    };
  }

  function clearTimer(t) {
    if (t) clearTimeout(t);
    return null;
  }

  function clearAllTimers() {
    reconnectTimer = clearTimer(reconnectTimer);
    authTimer = clearTimer(authTimer);
    idleTimer = clearTimer(idleTimer);
  }

  function resetIdleTimer() {
    idleTimer = clearTimer(idleTimer);
    idleTimer = setTimeout(() => {
      logger('WebSocket idle-Timeout, Verbindung wird verworfen', {});
      dropSocket('idle_timeout');
      scheduleReconnect();
    }, idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  // Baut eine neue Verbindung auf.
  async function connect() {
    if (stopped) return;
    if (state === STATE.CONNECTING || state === STATE.WAITING_FOR_CHALLENGE
      || state === STATE.AUTHENTICATING || state === STATE.AUTHENTICATED) {
      return;
    }
    if (!WebSocketImpl) {
      lastError = 'remote_access_relay_unavailable';
      setState(STATE.FAILED, 'no_websocket_impl');
      return;
    }
    if (!wsUrl) {
      lastError = 'remote_access_relay_unavailable';
      setState(STATE.FAILED, 'no_ws_url');
      return;
    }

    // Provisionierte Instanz-ID laden.
    try {
      const prov = await identityStore.getProvisionedIdentity();
      if (!prov || !prov.instanceId) {
        setState(STATE.IDLE, 'not_provisioned');
        return;
      }
      identityId = prov.instanceId;
    } catch (err) {
      lastError = (err && err.code) || 'remote_access_identity_store_corrupt';
      setState(STATE.FAILED, 'identity_unavailable');
      return;
    }

    const gen = ++generation;
    setState(STATE.CONNECTING);
    let socket;
    try {
      socket = new WebSocketImpl(wsUrl, { maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: authTimeoutMs });
    } catch (err) {
      lastError = 'remote_access_relay_unavailable';
      setState(STATE.DISCONNECTED, 'connect_throw');
      scheduleReconnect();
      return;
    }
    ws = socket;

    armAuthTimeout(gen);

    socket.on('open', () => {
      if (gen !== generation) return;
      resetIdleTimer();
      sendJson({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientType: CLIENT_TYPE, identityId });
      setState(STATE.WAITING_FOR_CHALLENGE);
    });
    socket.on('message', (data, isBinary) => {
      if (gen !== generation) return;
      handleMessage(data, isBinary, gen).catch((err) => {
        logger('Relay-WebSocket Message-Handler Fehler', { error: stableErrorCode(err) });
        protocolAbort(gen, 'message_handler_error');
      });
    });
    logger('Relay-WebSocket message-Listener registriert', { generation: gen, listenerCount: listenerCountOf(socket, 'message') });
    socket.on('ping', () => { if (gen === generation) resetIdleTimer(); });
    socket.on('pong', () => { if (gen === generation) resetIdleTimer(); });
    socket.on('error', (err) => {
      if (gen !== generation) return;
      lastError = 'remote_access_relay_unavailable';
      logger('Relay-WebSocket Fehlerereignis', { error: stableErrorCode(err) });
    });
    socket.on('close', (code, reason) => {
      if (gen !== generation) return;
      onClose(gen, code, reason);
    });
  }

  function armAuthTimeout(gen) {
    authTimer = clearTimer(authTimer);
    authTimer = setTimeout(() => {
      if (gen !== generation) return;
      if (state === STATE.AUTHENTICATED) return;
      lastError = 'remote_access_authentication_timeout';
      logger('WebSocket-Auth-Timeout', {});
      dropSocket('auth_timeout');
      scheduleReconnect();
    }, authTimeoutMs);
    if (authTimer.unref) authTimer.unref();
  }

  async function handleMessage(data, isBinary, gen) {
    resetIdleTimer();
    const frame = describeFrame(data, isBinary);
    logger('Relay-WebSocket Frame empfangen', {
      frameType: frame.frameType,
      length: frame.length,
      parseOk: false,
      messageType: null,
      requestIdShort: null,
      schemaOk: false,
      dispatch: null,
    });
    if (isBinary || frame.frameType === 'binary') {
      logger('Relay-WebSocket Nachricht abgelehnt', {
        frameType: frame.frameType,
        length: frame.length,
        parseOk: false,
        schemaOk: false,
        reason: 'binary_message',
      });
      return protocolAbort(gen, 'binary_message');
    }
    if (frame.length > MAX_PAYLOAD_BYTES) {
      logger('Relay-WebSocket Nachricht abgelehnt', {
        frameType: frame.frameType,
        length: frame.length,
        parseOk: false,
        schemaOk: false,
        reason: 'message_too_large',
      });
      return protocolAbort(gen, 'message_too_large');
    }
    let text;
    try {
      text = decodeTextFrame(data);
    } catch (_) {
      logger('Relay-WebSocket Nachricht abgelehnt', {
        frameType: frame.frameType,
        length: frame.length,
        parseOk: false,
        schemaOk: false,
        reason: 'unsupported_wire_type',
      });
      return protocolAbort(gen, 'unsupported_wire_type');
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      logger('Relay-WebSocket Nachricht geparst', {
        frameType: frame.frameType,
        length: frame.length,
        parseOk: false,
        messageType: null,
        requestIdShort: null,
        schemaOk: false,
        dispatch: null,
        reason: 'invalid_json',
      });
      return protocolAbort(gen, 'invalid_json');
    }
    const messageType = safeMessageType(msg && msg.type);
    const requestIdShort = messageType && messageType.startsWith('tunnel_') ? shortId(msg && msg.requestId) : null;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      logger('Relay-WebSocket Nachricht geparst', {
        frameType: frame.frameType,
        length: frame.length,
        parseOk: true,
        messageType,
        requestIdShort,
        schemaOk: false,
        dispatch: null,
        reason: 'invalid_message',
      });
      return protocolAbort(gen, 'invalid_message');
    }

    logger('Relay-WebSocket Nachricht geparst', {
      frameType: frame.frameType,
      length: frame.length,
      parseOk: true,
      messageType,
      requestIdShort,
      schemaOk: null,
      dispatch: dispatchNameFor(msg.type),
    });

    switch (msg.type) {
      case 'challenge':
        logDispatch('challenge', 'handleChallenge', true, null, null);
        return handleChallenge(msg, gen);
      case 'authenticated':
        logDispatch('authenticated', 'handleAuthenticated', true, null, null);
        return handleAuthenticated(msg, gen);
      case 'ping':
        // App-Level-Ping beantworten (Abschnitt 32: ping/pong erlaubt).
        logDispatch('ping', 'ping', true, null, null);
        if (state === STATE.AUTHENTICATED) sendJson({ type: 'pong' });
        return undefined;
      case 'pong':
        logDispatch('pong', 'pong', true, null, null);
        return undefined;
      case 'connection_status':
        logDispatch('connection_status', 'handleConnectionStatus', true, null, null);
        return handleConnectionStatus(msg, gen);
      case 'link_removed':
        logDispatch('link_removed', 'handleLinkRemoved', true, null, null);
        return handleLinkRemoved(msg, gen);
      case 'linked_devices':
        logDispatch('linked_devices', 'handleLinkedDevices', true, null, null);
        return handleLinkedDevices(msg, gen);
      case 'error':
        logDispatch('error', 'handleErrorMessage', true, null, null);
        return handleErrorMessage(msg, gen);
      default:
        if (msg.type.startsWith('tunnel_')) {
          if (state !== STATE.AUTHENTICATED || !capabilities || capabilities.relayTunnel !== true) {
            logDispatch(msg.type, null, false, requestIdShort, 'unexpected_tunnel_message');
            return protocolAbort(gen, 'unexpected_tunnel_message');
          }
          if (!TUNNEL_MESSAGE_TYPES.has(msg.type)) {
            logDispatch(msg.type, 'originTunnel.handleMessage', false, requestIdShort, 'invalid_tunnel_message');
            originTunnel.handleMessage(msg, ws);
            return undefined;
          }
          const result = originTunnel.handleMessage(msg, ws);
          logDispatch(msg.type, result && result.handler ? result.handler : 'originTunnel.handleMessage', Boolean(result && result.ok), requestIdShort, result && result.ok ? null : ((result && result.reason) || 'invalid_tunnel_message'));
          return undefined;
        }
        // Nach authenticated sind nur ping/pong/connection_status/link_removed/
        // linked_devices sowie bei Capability die Tunnel-Nachrichten zulässig.
        logDispatch(msg.type, null, false, null, 'unexpected_message');
        return protocolAbort(gen, 'unexpected_message');
    }
  }

  function logDispatch(messageType, dispatch, schemaOk, requestIdShort, reason) {
    logger('Relay-WebSocket Nachricht Dispatch', {
      messageType: safeMessageType(messageType),
      requestIdShort: requestIdShort || null,
      schemaOk: schemaOk === true,
      dispatch: dispatch || null,
      reason: reason || null,
    });
  }

  async function handleChallenge(msg, gen) {
    if (state !== STATE.WAITING_FOR_CHALLENGE) {
      return protocolAbort(gen, 'unexpected_challenge');
    }
    // Strikte Validierung: nur bekannte Felder, korrekte Typen/Werte.
    for (const key of Object.keys(msg)) {
      if (!CHALLENGE_FIELDS.has(key)) return protocolAbort(gen, 'unknown_challenge_field');
    }
    const { challengeId, nonce, issuedAt, expiresAt, protocolVersion, clientType, identityId: chalId } = msg;
    if (!isStr(challengeId, 4, 128) || !isStr(nonce, 8, 512) || !isStr(issuedAt, 10, 40) || !isStr(expiresAt, 10, 40)) {
      return protocolAbort(gen, 'invalid_challenge_fields');
    }
    if (protocolVersion !== PROTOCOL_VERSION) return protocolAbort(gen, 'unsupported_protocol_version');
    if (clientType !== CLIENT_TYPE) return protocolAbort(gen, 'client_type_mismatch');
    if (chalId !== identityId) return protocolAbort(gen, 'identity_mismatch');
    const issuedMs = Date.parse(issuedAt);
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return protocolAbort(gen, 'invalid_challenge_time');
    // Kleine Uhr-Toleranz, aber abgelaufene Challenge ablehnen.
    if (expiresMs <= Date.now() - 2000) return protocolAbort(gen, 'challenge_expired');
    if (processedChallenges.has(challengeId)) return protocolAbort(gen, 'duplicate_challenge');
    processedChallenges.add(challengeId);
    if (processedChallenges.size > 64) {
      // Set klein halten.
      const first = processedChallenges.values().next().value;
      processedChallenges.delete(first);
    }

    setState(STATE.AUTHENTICATING);
    let signature;
    try {
      signature = await identityStore.signRelayChallenge({
        challengeId,
        nonce,
        issuedAt,
        expiresAt,
        protocolVersion,
        clientType,
        identityId: chalId,
      });
    } catch (err) {
      lastError = 'remote_access_identity_store_corrupt';
      return protocolAbort(gen, 'sign_failed');
    }
    // Verbindung könnte während des Signierens ersetzt/geschlossen worden sein.
    if (gen !== generation || state !== STATE.AUTHENTICATING) return undefined;
    sendJson({ type: 'authenticate', challengeId, signature });
    return undefined;
  }

  function handleAuthenticated(msg, gen) {
    if (state !== STATE.AUTHENTICATING) return protocolAbort(gen, 'unexpected_authenticated');
    if (msg.protocolVersion !== PROTOCOL_VERSION) return protocolAbort(gen, 'unsupported_protocol_version');
    if (msg.clientType !== CLIENT_TYPE) return protocolAbort(gen, 'client_type_mismatch');
    if (msg.identityId !== identityId) return protocolAbort(gen, 'identity_mismatch');
    if (!isStr(msg.connectionId, 4, 128)) return protocolAbort(gen, 'invalid_connection_id');
    const caps = msg.capabilities && typeof msg.capabilities === 'object' ? msg.capabilities : {};
    capabilities = {
      authenticatedWebSocket: caps.authenticatedWebSocket === true,
      relayTunnel: caps.relayTunnel === true,
    };
    connectionId = msg.connectionId; // nur Diagnose, kein Credential
    authFailures = 0;
    backoffIndex = 0;
    lastError = null;
    authTimer = clearTimer(authTimer);
    setState(STATE.AUTHENTICATED, 'authenticated');
    logger('WebSocket authentifiziert', { relayTunnel: capabilities.relayTunnel });
    return undefined;
  }

  // Strikte Validierung von connection_status (Abschnitt 39). Nur nach
  // erfolgreicher Authentifizierung zulässig; nur bekannte Felder/Typen; die
  // gemeldete instanceId muss der eigenen Origin-Identität entsprechen. Die
  // validierte Sicht geht an die Laufzeit-Senke; abgeglichen mit den persistenten
  // Kopplungen (und damit gegen fremde deviceIds) wird erst in der Ansichtsschicht.
  function handleConnectionStatus(msg, gen) {
    if (state !== STATE.AUTHENTICATED) return protocolAbort(gen, 'unexpected_connection_status');
    for (const key of Object.keys(msg)) {
      if (!CONNECTION_STATUS_FIELDS.has(key)) return protocolAbort(gen, 'unknown_connection_status_field');
    }
    if (!isStr(msg.instanceId, 4, 128) || msg.instanceId !== identityId) {
      return protocolAbort(gen, 'connection_status_identity_mismatch');
    }
    if (!isStr(msg.generatedAt, 10, 40) || !Number.isFinite(Date.parse(msg.generatedAt))) {
      return protocolAbort(gen, 'connection_status_invalid_time');
    }
    if (!Array.isArray(msg.devices) || msg.devices.length > MAX_STATUS_DEVICES) {
      return protocolAbort(gen, 'connection_status_invalid_devices');
    }
    const devices = [];
    for (const d of msg.devices) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return protocolAbort(gen, 'connection_status_invalid_device');
      for (const key of Object.keys(d)) {
        if (!DEVICE_STATUS_FIELDS.has(key)) return protocolAbort(gen, 'connection_status_unknown_device_field');
      }
      if (!isStr(d.deviceId, 4, 128)) return protocolAbort(gen, 'connection_status_invalid_device_id');
      if (typeof d.connected !== 'boolean') return protocolAbort(gen, 'connection_status_invalid_connected');
      if (d.deviceName != null && !isStr(d.deviceName, 1, 200)) return protocolAbort(gen, 'connection_status_invalid_device_name');
      if (d.platform != null && !isStr(d.platform, 1, 64)) return protocolAbort(gen, 'connection_status_invalid_platform');
      if (d.pairedAt != null && !isStr(d.pairedAt, 10, 40)) return protocolAbort(gen, 'connection_status_invalid_paired_at');
      if (d.connected) {
        if (d.connectedAt != null && !isStr(d.connectedAt, 10, 40)) return protocolAbort(gen, 'connection_status_invalid_connected_at');
      } else if (d.connectedAt != null) {
        // connectedAt darf nur bei connected:true vorkommen (Abschnitt 39.1).
        return protocolAbort(gen, 'connection_status_unexpected_connected_at');
      }
      devices.push({
        deviceId: d.deviceId,
        deviceName: typeof d.deviceName === 'string' ? d.deviceName : null,
        platform: typeof d.platform === 'string' ? d.platform : null,
        pairedAt: typeof d.pairedAt === 'string' ? d.pairedAt : null,
        connected: d.connected,
        connectedAt: d.connected && typeof d.connectedAt === 'string' ? d.connectedAt : null,
      });
    }
    try {
      onConnectionStatus({ instanceId: msg.instanceId, generatedAt: msg.generatedAt, devices });
    } catch (_) { /* Laufzeitstatus darf die Verbindung nie stören. */ }
    return undefined;
  }

  // Strikte Validierung von link_removed (Abschnitt 40.3). Bestätigt eine
  // Entfernung und löst — bei passender requestId — die offene remove_link-
  // Anfrage auf. Autoritativ für den lokalen Bestand ist aber erst linked_devices.
  function handleLinkRemoved(msg, gen) {
    if (state !== STATE.AUTHENTICATED) return protocolAbort(gen, 'unexpected_link_removed');
    for (const key of Object.keys(msg)) {
      if (!LINK_REMOVED_FIELDS.has(key)) return protocolAbort(gen, 'unknown_link_removed_field');
    }
    if (!isStr(msg.instanceId, 4, 128) || msg.instanceId !== identityId) {
      return protocolAbort(gen, 'link_removed_identity_mismatch');
    }
    if (!isStr(msg.deviceId, 4, 128)) return protocolAbort(gen, 'link_removed_invalid_device_id');
    if (!isStr(msg.requestId, 1, 128)) return protocolAbort(gen, 'link_removed_invalid_request_id');
    if (!isStr(msg.removedAt, 10, 40) || !Number.isFinite(Date.parse(msg.removedAt))) {
      return protocolAbort(gen, 'link_removed_invalid_time');
    }
    const pending = pendingRemovals.get(msg.requestId);
    if (pending) {
      pendingRemovals.delete(msg.requestId);
      if (pending.timer) clearTimeout(pending.timer);
      // Idempotenz-Sicherung: nur auflösen, wenn die deviceId übereinstimmt.
      if (pending.deviceId === msg.deviceId) {
        pending.resolve({ deviceId: msg.deviceId, removedAt: msg.removedAt });
      } else {
        pending.reject(new RemoteAccessError('remote_access_link_removal_failed', 'Antwort betrifft ein anderes Gerät.'));
      }
    }
    return undefined;
  }

  // Strikte Validierung der autoritativen Geräteliste (Abschnitt 41/43). Die
  // validierte Sicht geht an die Senke, die Persistenz und Laufzeitstatus
  // abgleicht; die eigentliche Reconciliation (inkl. Revision/complete) liegt dort.
  function handleLinkedDevices(msg, gen) {
    if (state !== STATE.AUTHENTICATED) return protocolAbort(gen, 'unexpected_linked_devices');
    for (const key of Object.keys(msg)) {
      if (!LINKED_DEVICES_FIELDS.has(key)) return protocolAbort(gen, 'unknown_linked_devices_field');
    }
    if (!isStr(msg.instanceId, 4, 128) || msg.instanceId !== identityId) {
      return protocolAbort(gen, 'linked_devices_identity_mismatch');
    }
    if (!Number.isInteger(msg.revision) || msg.revision < 0) return protocolAbort(gen, 'linked_devices_invalid_revision');
    if (typeof msg.complete !== 'boolean') return protocolAbort(gen, 'linked_devices_invalid_complete');
    if (!isStr(msg.generatedAt, 10, 40) || !Number.isFinite(Date.parse(msg.generatedAt))) {
      return protocolAbort(gen, 'linked_devices_invalid_time');
    }
    if (!Array.isArray(msg.devices) || msg.devices.length > MAX_STATUS_DEVICES) {
      return protocolAbort(gen, 'linked_devices_invalid_devices');
    }
    const devices = [];
    for (const d of msg.devices) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return protocolAbort(gen, 'linked_devices_invalid_device');
      for (const key of Object.keys(d)) {
        if (!DEVICE_STATUS_FIELDS.has(key)) return protocolAbort(gen, 'linked_devices_unknown_device_field');
      }
      if (!isStr(d.deviceId, 4, 128)) return protocolAbort(gen, 'linked_devices_invalid_device_id');
      if (typeof d.connected !== 'boolean') return protocolAbort(gen, 'linked_devices_invalid_connected');
      if (d.deviceName != null && !isStr(d.deviceName, 1, 200)) return protocolAbort(gen, 'linked_devices_invalid_name');
      if (d.platform != null && !isStr(d.platform, 1, 64)) return protocolAbort(gen, 'linked_devices_invalid_platform');
      if (d.pairedAt != null && !isStr(d.pairedAt, 10, 40)) return protocolAbort(gen, 'linked_devices_invalid_paired_at');
      if (d.connected) {
        if (d.connectedAt != null && !isStr(d.connectedAt, 10, 40)) return protocolAbort(gen, 'linked_devices_invalid_connected_at');
      } else if (d.connectedAt != null) {
        return protocolAbort(gen, 'linked_devices_unexpected_connected_at');
      }
      devices.push({
        deviceId: d.deviceId,
        deviceName: typeof d.deviceName === 'string' ? d.deviceName : null,
        platform: typeof d.platform === 'string' ? d.platform : null,
        pairedAt: typeof d.pairedAt === 'string' ? d.pairedAt : null,
        connected: d.connected,
        connectedAt: d.connected && typeof d.connectedAt === 'string' ? d.connectedAt : null,
      });
    }
    try {
      onLinkedDevices({
        instanceId: msg.instanceId,
        revision: msg.revision,
        complete: msg.complete,
        generatedAt: msg.generatedAt,
        devices,
      });
    } catch (_) { /* Reconciliation darf die Verbindung nie stören. */ }
    return undefined;
  }

  function handleErrorMessage(msg, gen) {
    const code = typeof msg.code === 'string' ? msg.code : 'error';
    if (code === 'connection_replaced') {
      // Durch eine neuere Verbindung derselben Identität ersetzt: kontrolliert
      // beenden, KEIN aggressiver Reconnect (verhindert wechselseitige
      // Verdrängung).
      lastError = 'remote_access_connection_replaced';
      logger('WebSocket ersetzt (connection_replaced)', {});
      stopped = true;
      dropSocket('connection_replaced');
      setState(STATE.DISCONNECTED, 'connection_replaced');
      return undefined;
    }
    if (code === 'authentication_failed' || code === 'authentication_timeout') {
      lastError = code === 'authentication_timeout' ? 'remote_access_authentication_timeout' : 'remote_access_authentication_failed';
      authFailures += 1;
      logger('WebSocket-Auth abgelehnt', { code, failures: authFailures });
      dropSocket(code);
      if (authFailures >= maxAuthFailures) {
        setState(STATE.FAILED, 'auth_failures_exhausted');
      } else {
        scheduleReconnect();
      }
      return undefined;
    }
    // Sonstiger Protokollfehler.
    lastError = 'remote_access_protocol_error';
    return protocolAbort(gen, `error_${code}`);
  }

  function onClose(gen, code, reason) {
    if (gen !== generation) return;
    authTimer = clearTimer(authTimer);
    idleTimer = clearTimer(idleTimer);
    ws = null;
    if (stopped) {
      setState(STATE.STOPPED, 'closed_after_stop');
      return;
    }
    // War die Verbindung authentifiziert und wird geschlossen -> Reconnect.
    if (state === STATE.FAILED) return;
    logger('Relay-WebSocket geschlossen', { code: Number.isFinite(code) ? code : undefined, reason: shortReason(reason) });
    setState(STATE.DISCONNECTED, 'closed');
    scheduleReconnect();
  }

  // Bricht die Verbindung kontrolliert wegen eines Protokollfehlers ab.
  function protocolAbort(gen, reason) {
    if (gen !== generation) return undefined;
    lastError = lastError || 'remote_access_protocol_error';
    logger('WebSocket-Protokollabbruch', { reason });
    dropSocket(reason);
    if (!stopped && state !== STATE.FAILED) scheduleReconnect();
    return undefined;
  }

  function dropSocket(reason) {
    const socket = ws;
    ws = null;
    // Alte Generation invalidieren, damit verspätete Events ignoriert werden.
    generation += 1;
    authTimer = clearTimer(authTimer);
    idleTimer = clearTimer(idleTimer);
    if (socket) {
      try {
        socket.removeAllListeners();
      } catch (_) { /* egal */ }
      try {
        socket.terminate ? socket.terminate() : socket.close();
      } catch (_) { /* egal */ }
    }
    if (state !== STATE.FAILED && state !== STATE.STOPPED) setState(STATE.DISCONNECTED, reason);
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    if (state === STATE.FAILED) return;
    const base = backoffMs[Math.min(backoffIndex, backoffMs.length - 1)];
    backoffIndex += 1;
    const jitter = Math.floor(Math.random() * Math.min(base, 1000));
    const delay = base + jitter;
    setState(STATE.RECONNECTING, `backoff_${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {});
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function reconnect() {
    backoffIndex = 0;
    dropSocket('manual_reconnect');
    stopped = false;
    return connect();
  }

  function disconnect() {
    stopped = true;
    clearAllTimers();
    dropSocket('manual_disconnect');
    setState(STATE.STOPPED, 'disconnect');
  }

  // Fordert die Entfernung einer aktiven Geräteverknüpfung an (Abschnitt 40.2).
  // Nur über den authentifizierten Origin-WebSocket. Löst auf, sobald das
  // zugehörige link_removed eintrifft; scheitert bei Timeout/Trennung, sodass die
  // UI das Gerät behalten und einen Fehler anzeigen kann. Der lokale Bestand wird
  // hier NICHT verändert — das übernimmt allein der linked_devices-Snapshot.
  function removeLink(deviceId) {
    if (typeof deviceId !== 'string' || !/^dev_[A-Za-z0-9_-]{4,}$/.test(deviceId)) {
      return Promise.reject(new RemoteAccessError('remote_access_invalid_device_id', 'Ungültige deviceId.'));
    }
    if (state !== STATE.AUTHENTICATED) {
      return Promise.reject(new RemoteAccessError('remote_access_not_connected', 'Origin-WebSocket nicht authentifiziert.'));
    }
    const requestId = `req_${crypto.randomBytes(12).toString('hex')}`;
    return new Promise((resolve, reject) => {
      // Request-scoped Timeout: bewusst NICHT unref'd — solange der Nutzer auf die
      // Bestätigung wartet, soll der Prozess wach bleiben. Bei Trennung/Shutdown
      // wird er über rejectPendingRemovals() abgeräumt.
      const timer = setTimeout(() => {
        pendingRemovals.delete(requestId);
        reject(new RemoteAccessError('remote_access_link_removal_timeout', 'Zeitüberschreitung bei der Entfernung.'));
      }, removalTimeoutMs);
      pendingRemovals.set(requestId, { deviceId, resolve, reject, timer });
      sendJson({ type: 'remove_link', requestId, deviceId });
    });
  }

  function sendJson(obj) {
    const socket = ws;
    if (!socket) return;
    const OPEN = (WebSocketImpl && WebSocketImpl.OPEN != null) ? WebSocketImpl.OPEN : 1;
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(obj));
    } catch (_) { /* Sendefehler -> close/error-Handler greifen. */ }
  }

  // Startet den Subdienst (nach Provisioning / beim Autostart).
  function start() {
    stopped = false;
    authFailures = 0;
    backoffIndex = 0;
    return connect();
  }

  function shutdown() {
    stopped = true;
    clearAllTimers();
    try { originTunnel.abortAll('connection_closed'); } catch (_) { /* egal */ }
    const socket = ws;
    ws = null;
    generation += 1;
    if (socket) {
      try { socket.removeAllListeners(); } catch (_) { /* egal */ }
      try { socket.close(1001); } catch (_) { try { socket.terminate && socket.terminate(); } catch (_) { /* egal */ } }
    }
    setState(STATE.STOPPED, 'shutdown');
  }

  return {
    start,
    connect,
    disconnect,
    reconnect,
    removeLink,
    getStatus,
    shutdown,
    STATE,
  };
}

function isStr(v, min, max) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function describeFrame(data, isBinary) {
  const frameType = isBinary ? 'binary' : 'text';
  if (typeof data === 'string') return { frameType, length: Buffer.byteLength(data, 'utf8') };
  if (Buffer.isBuffer(data)) return { frameType, length: data.length };
  if (data instanceof ArrayBuffer) return { frameType, length: data.byteLength };
  if (ArrayBuffer.isView(data)) return { frameType, length: data.byteLength };
  return { frameType: 'unknown', length: 0 };
}

function decodeTextFrame(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  throw new Error('unsupported_wire_type');
}

function safeMessageType(value) {
  if (typeof value !== 'string') return null;
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return safe.length > 64 ? `${safe.slice(0, 64)}…` : safe;
}

function dispatchNameFor(type) {
  switch (type) {
    case 'challenge': return 'handleChallenge';
    case 'authenticated': return 'handleAuthenticated';
    case 'ping': return 'ping';
    case 'pong': return 'pong';
    case 'connection_status': return 'handleConnectionStatus';
    case 'link_removed': return 'handleLinkRemoved';
    case 'linked_devices': return 'handleLinkedDevices';
    case 'error': return 'handleErrorMessage';
    default:
      return typeof type === 'string' && type.startsWith('tunnel_') ? 'originTunnel.handleMessage' : null;
  }
}

function shortId(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function shortReason(value) {
  let text = null;
  if (Buffer.isBuffer(value)) text = value.toString('utf8');
  else if (value instanceof ArrayBuffer) text = Buffer.from(value).toString('utf8');
  else if (ArrayBuffer.isView(value)) text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  else if (typeof value === 'string') text = value;
  if (!text) return null;
  const safe = text.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return safe.length > 64 ? `${safe.slice(0, 64)}…` : safe;
}

function stableErrorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  if (code && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  return 'error';
}

function listenerCountOf(socket, eventName) {
  if (socket && typeof socket.listenerCount === 'function') return socket.listenerCount(eventName);
  if (socket && typeof socket.listeners === 'function') return socket.listeners(eventName).length;
  return null;
}

module.exports = { createRelayConnection, STATE };
