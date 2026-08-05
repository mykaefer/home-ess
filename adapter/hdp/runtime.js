'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { basicAuthorization } = require('./auth');
const { PROTOCOL_VERSION } = require('./validation');

const MAX_MESSAGE_BYTES = 1024;
const HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

function connectionErrorMessage(error) {
  if (error && error.code === 'HPE_INVALID_HEADER_TOKEN') {
    return 'Das Gerät sendet beim WebSocket-Upgrade syntaktisch ungültige HTTP-Header.';
  }
  if (error && /opening handshake has timed out/i.test(error.message || '')) {
    return 'Das Gerät hat den WebSocket-Upgrade nicht innerhalb von 3000 ms beantwortet.';
  }
  return error && error.message ? error.message : String(error || 'WebSocket-Verbindung fehlgeschlagen.');
}

function validEnvelope(message) {
  return message && typeof message === 'object' && !Array.isArray(message)
    && typeof message.type === 'string' && message.type.length > 0
    && typeof message.message_id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(message.message_id)
    && Number.isInteger(message.sequence) && message.sequence >= 1 && message.sequence <= 0xffffffff
    && message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload);
}

function uint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function validBinaryEntries(entries, input) {
  return Array.isArray(entries) && entries.every((entry) => entry
    && Number.isInteger(entry.pin) && entry.pin >= 0 && entry.pin <= 255
    && typeof entry.state === 'boolean'
    && (!input || ['switch', 'button'].includes(entry.input_type)));
}

function validBinaryMessage(message) {
  const payload = message && message.payload;
  if (!payload || !uint32(payload.config_revision)) return false;
  if (message.type === 'binary.input.event') {
    return Number.isInteger(payload.pin) && payload.pin >= 0 && payload.pin <= 255
      && ['switch', 'button'].includes(payload.input_type)
      && ((payload.input_type === 'switch' && payload.event === 'changed')
        || (payload.input_type === 'button' && payload.event === 'pressed' && payload.state === true))
      && typeof payload.state === 'boolean' && uint32(payload.event_sequence)
      && payload.event_sequence > 0 && uint32(payload.occurred_at_uptime_milliseconds);
  }
  if (message.type === 'binary.input.snapshot' || message.type === 'binary.status') {
    return uint32(payload.captured_at_uptime_milliseconds)
      && validBinaryEntries(payload.inputs, true)
      && validBinaryEntries(payload.outputs, false)
      && (message.type !== 'binary.status' || typeof payload.reply_to === 'string');
  }
  if (message.type === 'binary.output.applied') {
    return typeof payload.reply_to === 'string'
      && Number.isInteger(payload.pin) && payload.pin >= 0 && payload.pin <= 255
      && typeof payload.state === 'boolean'
      && uint32(payload.applied_at_uptime_milliseconds);
  }
  return false;
}

class RuntimeConnection extends EventEmitter {
  constructor(options) {
    super();
    this.device = { ...options.device };
    this.credentials = options.credentials;
    this.wsFactory = options.wsFactory || ((url, config) => new WebSocket(url, config));
    this.random = options.random || Math.random;
    this.synchronizeConfig = options.synchronizeConfig || (async () => {});
    this.getConfigRevision = options.getConfigRevision || (() => this.device.configRevision);
    this.socket = null;
    this.stopped = true;
    this.ready = false;
    this.outSequence = 0;
    this.inSequence = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.helloTimer = null;
    this.lastValidAt = 0;
    this.remoteConfigRevision = null;
    this.configSync = Promise.resolve();
    this.reconnectForbidden = false;
    this.replaced = false;
    this.lastConnectionError = null;
    this.pendingRequests = new Map();
    this.maximumMessageBytes = Number.isInteger(options.maximumMessageBytes)
      ? options.maximumMessageBytes : (this.device.runtimeProfile ? 2048 : MAX_MESSAGE_BYTES);
    this.legacyRuntime = !this.device.runtimeProfile;
  }

  updateDevice(device) {
    const changed = this.device.address !== device.address || this.device.wsPort !== device.wsPort;
    this.device = { ...this.device, ...device };
    if (changed && !this.stopped && !this.reconnectForbidden) this.reconnectNow();
  }

  url() {
    const host = this.device.address || this.device.hostname;
    return `ws://${host}:${this.device.wsPort || this.device.apiPort}/api/v1/ws`;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectForbidden = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.socket || this.reconnectForbidden) return;
    const attempt = this.reconnectAttempt + 1;
    this.emit('connectionState', { state: 'connecting', attempt });
    let socket;
    try {
      socket = this.wsFactory(this.url(), {
        headers: { Authorization: basicAuthorization(this.credentials) },
        handshakeTimeout: 3000,
        maxPayload: this.maximumMessageBytes,
      });
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    this.socket = socket;
    const isCurrentSocket = () => this.socket === socket;
    this.ready = false;
    this.outSequence = 0;
    this.inSequence = 0;
    this.remoteConfigRevision = null;
    this.configSync = Promise.resolve();
    this.rejectPending(Object.assign(new Error('WebSocket-Sitzung wurde neu aufgebaut.'), { uncertain: true }));
    this.lastConnectionError = null;
    socket.on('open', () => {
      if (!isCurrentSocket()) return;
      this.emit('connectionState', { state: 'handshaking', attempt });
      this.lastValidAt = Date.now();
      this.helloTimer = setTimeout(() => {
        this.protocolFailure('SESSION_HELLO_TIMEOUT', 'device.hello/session.ready ist ausgeblieben.');
      }, HELLO_TIMEOUT_MS);
    });
    socket.on('message', (raw, isBinary) => {
      if (isCurrentSocket()) this.onMessage(raw, isBinary);
    });
    socket.on('unexpected-response', (_request, response) => {
      if (!isCurrentSocket()) return;
      if (response && response.statusCode === 401) {
        this.reconnectForbidden = true;
        this.emit('deviceError', { code: 'AUTH_REQUIRED', message: 'WebSocket-Authentifizierung abgelehnt.', details: {} });
      }
    });
    socket.on('error', (error) => {
      if (!isCurrentSocket()) return;
      const diagnostic = Object.assign(new Error(connectionErrorMessage(error)), {
        code: error && error.code,
        cause: error,
      });
      this.lastConnectionError = diagnostic;
      this.emit('warning', diagnostic);
    });
    socket.on('close', () => {
      if (!isCurrentSocket()) return;
      this.socket = null;
      const wasReady = this.ready;
      this.ready = false;
      this.clearSessionTimers();
      if (wasReady) this.emit('offline');
      if (!this.stopped && !this.reconnectForbidden) this.scheduleReconnect(this.lastConnectionError);
    });
  }

  message(type, payload = {}) {
    if (this.outSequence >= 0xffffffff) {
      this.protocolFailure('SEQUENCE_ERROR', 'Ausgehende WebSocket-Sequenz ist erschöpft.');
      return null;
    }
    this.outSequence += 1;
    return {
      type,
      message_id: `adapter-${this.outSequence}`,
      sequence: this.outSequence,
      payload,
    };
  }

  send(type, payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const message = this.message(type, payload);
    if (!message) return false;
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, 'utf8') > this.maximumMessageBytes) {
      this.protocolFailure('INVALID_REQUEST', 'Ausgehende hDP-WebSocket-Nachricht überschreitet das Manifestlimit.');
      return false;
    }
    this.socket.send(encoded);
    return message;
  }

  request(type, payload, timeoutMs = 5000) {
    const sent = this.send(type, payload);
    if (!sent) return Promise.reject(Object.assign(new Error('WebSocket ist nicht sendebereit.'), { code: 'DEVICE_OFFLINE', uncertain: true }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(sent.message_id);
        reject(Object.assign(new Error(
          `${type} wurde nicht innerhalb von ${timeoutMs} ms bestätigt. `
          + 'Die hDP-Verbindung ist weiterhin aktiv; ob der Befehl übernommen wurde, ist unklar.',
        ), {
          code: 'REQUEST_TIMEOUT', uncertain: true, request: sent,
        }));
      }, timeoutMs);
      this.pendingRequests.set(sent.message_id, { resolve, reject, timer, request: sent });
    });
  }

  rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  async synchronizeIfNeeded(revision) {
    if (!Number.isInteger(revision) || revision < 0 || revision > 0xffffffff) {
      throw new Error('Ungültige Konfigurationsrevision im WebSocket-Handshake.');
    }
    this.remoteConfigRevision = revision;
    if (revision !== this.getConfigRevision()) await this.synchronizeConfig(revision);
  }

  onMessage(raw, isBinary = false) {
    if (isBinary || !Buffer.isBuffer(raw) && typeof raw !== 'string') {
      this.protocolFailure('INVALID_REQUEST', 'Binäre WebSocket-Nachrichten sind nicht erlaubt.');
      return;
    }
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    if (bytes.length > this.maximumMessageBytes) {
      this.protocolFailure('INVALID_REQUEST', 'WebSocket-Nachricht überschreitet das Manifestlimit.');
      return;
    }
    let message;
    try { message = JSON.parse(bytes.toString('utf8')); } catch (_) {
      this.protocolFailure('INVALID_REQUEST', 'Ungültige WebSocket-JSON-Nachricht.');
      return;
    }
    if (!validEnvelope(message)) {
      this.protocolFailure('INVALID_REQUEST', 'Unvollständiges WebSocket-Envelope.');
      return;
    }
    if (message.sequence !== this.inSequence + 1) {
      this.protocolFailure('SEQUENCE_ERROR', 'WebSocket-Sequenz ist nicht lückenlos.');
      return;
    }
    this.inSequence = message.sequence;
    this.lastValidAt = Date.now();
    if (message.type.startsWith('binary.') && !validBinaryMessage(message)) {
      this.protocolFailure('INVALID_REQUEST', 'Ungültige Binary-I/O-Nachricht.');
      return;
    }
    const replyTo = message.payload && message.payload.reply_to;
    if (typeof replyTo === 'string' && message.type !== 'error') {
      const pending = this.pendingRequests.get(replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(replyTo);
        pending.resolve(message);
      }
    }

    if (this.inSequence === 1 && message.type !== 'device.hello') {
      this.protocolFailure('INVALID_REQUEST', 'Erste Gerätenachricht ist nicht device.hello.');
      return;
    }
    if (!this.ready && !['device.hello', 'session.ready', 'error'].includes(message.type)) {
      this.protocolFailure('INVALID_REQUEST', 'Nachricht vor session.ready ist unzulässig.');
      return;
    }
    if (message.type === 'device.hello') {
      const payload = message.payload;
      const expectedRuntimeProfile = this.device.runtimeProfile;
      if (message.sequence !== 1 || payload.device_id !== this.device.deviceId
          || payload.protocol_version !== PROTOCOL_VERSION
          || (!this.legacyRuntime && payload.runtime_profile !== expectedRuntimeProfile)
          || payload.heartbeat_interval_ms !== HEARTBEAT_MS
          || payload.heartbeat_timeout_ms !== HEARTBEAT_TIMEOUT_MS) {
        this.protocolFailure(payload.protocol_version !== PROTOCOL_VERSION
          ? 'UNSUPPORTED_PROTOCOL_VERSION'
          : (!this.legacyRuntime && payload.runtime_profile !== expectedRuntimeProfile)
            ? 'UNSUPPORTED_RUNTIME_PROFILE' : 'INVALID_REQUEST',
        'WebSocket-Geräteidentität oder Runtime-Profil stimmt nicht.');
        return;
      }
      this.send('homeess.hello', {
        instance_id: this.credentials.instanceId,
        protocol_version: PROTOCOL_VERSION,
        ...(this.legacyRuntime ? {} : { runtime_profile: expectedRuntimeProfile }),
      });
      this.configSync = this.synchronizeIfNeeded(payload.config_revision)
        .then(() => true)
        .catch((error) => {
          this.protocolFailure(error.code || 'INVALID_REQUEST', error.message);
          return false;
        });
      return;
    }
    if (message.type === 'session.ready') {
      const expectedRuntimeProfile = this.device.runtimeProfile;
      if (message.sequence !== 2
          || (!this.legacyRuntime && message.payload.runtime_profile !== expectedRuntimeProfile)) {
        this.protocolFailure(message.sequence !== 2 ? 'SEQUENCE_ERROR' : 'UNSUPPORTED_RUNTIME_PROFILE',
          'session.ready besitzt eine ungültige Sequenz oder ein inkompatibles Runtime-Profil.');
        return;
      }
      const readySocket = this.socket;
      this.configSync.then((synchronized) => {
        if (!synchronized || this.socket !== readySocket) {
          throw new Error('Konfigurationsabgleich im Handshake fehlgeschlagen.');
        }
        return this.synchronizeIfNeeded(message.payload.config_revision);
      })
        .then(() => {
          if (this.socket !== readySocket) return;
          this.ready = true;
          this.reconnectAttempt = 0;
          this.replaced = false;
          this.lastConnectionError = null;
          if (this.helloTimer) clearTimeout(this.helloTimer);
          this.helloTimer = null;
          this.startHeartbeat();
          this.emit('connectionState', { state: 'connected', attempt: 0 });
          this.emit('online');
        })
        .catch((error) => {
          if (this.socket === readySocket) {
            this.protocolFailure(error.code || 'INVALID_REQUEST', error.message);
          }
        });
    } else if (message.type === 'ping') {
      this.send('pong', { reply_to: message.message_id });
    } else if (message.type === 'pong') {
      // Der gültige Empfang aktualisiert lastValidAt.
    } else if (message.type === 'state.applied') {
      this.emit('applied', message.payload);
    } else if (message.type === 'device.status') {
      this.emit('status', message.payload);
    } else if (message.type === 'config.changed') {
      this.synchronizeIfNeeded(message.payload.config_revision)
        .then(() => this.emit('configChanged', message.payload))
        .catch((error) => this.emit('warning', error));
    } else if (message.type === 'error') {
      if (typeof message.payload.reply_to === 'string') {
        const pending = this.pendingRequests.get(message.payload.reply_to);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(message.payload.reply_to);
          pending.reject(Object.assign(new Error(message.payload.message), {
            code: message.payload.code, details: message.payload.details,
          }));
        }
      }
      this.emit('deviceError', message.payload);
      if (message.payload.code === 'AUTH_REQUIRED') this.reconnectForbidden = true;
      if (message.payload.code === 'SESSION_REPLACED') this.replaced = true;
      if (['AUTH_REQUIRED', 'HEARTBEAT_TIMEOUT', 'SESSION_REPLACED', 'SEQUENCE_ERROR'].includes(message.payload.code)) {
        this.stopSocket();
      }
    } else if (message.type.startsWith('firmware.update.')) {
      this.emit('firmware', message);
    } else if (message.type.startsWith('output.')) {
      this.emit('output', message);
    } else if (message.type.startsWith('binary.')) {
      this.emit('binary', message);
    } else {
      this.emit('warning', Object.assign(new Error(`Nicht unterstützter Nachrichtentyp ${message.type}.`), {
        code: 'UNSUPPORTED_MESSAGE_TYPE',
      }));
    }
  }

  protocolFailure(code, message) {
    this.emit('deviceError', { code, message, details: {} });
    this.stopSocket();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastValidAt >= HEARTBEAT_TIMEOUT_MS) {
        this.protocolFailure('HEARTBEAT_TIMEOUT', 'hDP-Heartbeat ist 45 Sekunden ausgeblieben.');
        return;
      }
      this.send('ping', {});
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  clearSessionTimers() {
    this.stopHeartbeat();
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  reconnectDelay() {
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    const base = RECONNECT_DELAYS[index];
    return base + Math.floor(this.random() * 251);
  }

  scheduleReconnect(error) {
    if (this.stopped || this.reconnectTimer || this.reconnectForbidden) return;
    const delay = Math.max(this.replaced ? 30000 : 0, this.reconnectDelay());
    this.reconnectAttempt += 1;
    const event = {
      state: 'reconnecting',
      attempt: this.reconnectAttempt,
      delay,
      nextAttemptAt: new Date(Date.now() + delay).toISOString(),
      error,
    };
    this.emit('connectionState', event);
    this.emit('reconnect', event);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  reconnectNow() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopSocket(false);
    if (!this.stopped && !this.reconnectForbidden) this.connect();
  }

  stopSocket(reconnect = true) {
    const socket = this.socket;
    const wasReady = this.ready;
    this.socket = null;
    this.ready = false;
    this.clearSessionTimers();
    this.rejectPending(Object.assign(new Error('WebSocket-Verbindung wurde getrennt.'), {
      code: 'DEVICE_OFFLINE', uncertain: true,
    }));
    if (wasReady) this.emit('offline');
    if (socket) {
      try { socket.close(); } catch (_) { /* bereits geschlossen */ }
    }
    if (reconnect && !this.stopped && !this.reconnectForbidden) {
      this.scheduleReconnect(this.lastConnectionError);
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopSocket(false);
    this.emit('connectionState', { state: 'stopped', attempt: this.reconnectAttempt });
  }
}

module.exports = {
  MAX_MESSAGE_BYTES, HELLO_TIMEOUT_MS, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS,
  RECONNECT_DELAYS, connectionErrorMessage, validEnvelope, validBinaryMessage,
  RuntimeConnection,
};
