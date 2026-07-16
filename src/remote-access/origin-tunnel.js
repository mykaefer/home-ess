'use strict';

const http = require('http');
const { performance } = require('perf_hooks');
const { PassThrough } = require('stream');
const config = require('../config');

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const FORBIDDEN_REQUEST_HEADERS = new Set([...HOP_BY_HOP, 'host']);
const LOCAL_ONLY_REQUEST_HEADERS = new Set([...FORBIDDEN_REQUEST_HEADERS, 'expect']);
const REQUEST_START_FIELDS = new Set(['type', 'requestId', 'instanceId', 'method', 'path', 'query', 'headers', 'hasBody']);
const REQUEST_BODY_FIELDS = new Set(['type', 'requestId', 'sequence', 'data']);
const REQUEST_END_FIELDS = new Set(['type', 'requestId']);
const CANCEL_FIELDS = new Set(['type', 'requestId', 'reason']);
const RELAY_CANCEL_REASONS = new Set([
  'client_cancelled',
  'request_timeout',
  'backpressure_limit',
  'connection_closed',
  'link_removed',
  'invalid_tunnel_message',
  'request_state_invalid',
  'body_too_large',
  'chunk_too_large',
  'sequence_invalid',
  'internal_error',
]);

const DEFAULTS = {
  requestTimeoutMs: 120000,
  idleTimeoutMs: 30000,
  maxChunkRawBytes: 8192,
  maxChunkBase64Chars: 10924,
  maxBodyBytes: 32 * 1024 * 1024,
  maxHeaders: 128,
  maxHeaderBytes: 64 * 1024,
  maxBufferedAmount: 4 * 1024 * 1024,
};
const RELAY_MAX_CHUNK_RAW_BYTES = 8192;
const MIN_REQUEST_TIMEOUT_MS = 1000;
const MIN_IDLE_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function createOriginTunnel(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const WebSocketImpl = options.WebSocketImpl || null;
  const host = options.localHost || '127.0.0.1';
  const port = Number.isInteger(options.localPort) ? options.localPort : config.PORT;
  const limits = normalizeLimits(options);
  const requestImpl = typeof options.requestImpl === 'function' ? options.requestImpl : defaultRequestImpl;
  const contexts = new Map();

  function handleMessage(msg, socket) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return { handled: false, ok: false, reason: 'invalid_tunnel_message' };
    }
    if (!msg.type.startsWith('tunnel_')) return { handled: false, ok: false, reason: 'not_tunnel_message' };
    try {
      switch (msg.type) {
        case 'tunnel_request_start':
          onStart(msg, socket);
          return { handled: true, ok: true, handler: 'tunnel_request_start' };
        case 'tunnel_request_body':
          onBody(msg, socket);
          return { handled: true, ok: true, handler: 'tunnel_request_body' };
        case 'tunnel_request_end':
          onEnd(msg, socket);
          return { handled: true, ok: true, handler: 'tunnel_request_end' };
        case 'tunnel_cancel':
          onCancel(msg);
          return { handled: true, ok: true, handler: 'tunnel_cancel' };
        default:
          cancelFromInvalid(msg, 'invalid_tunnel_message');
          return { handled: true, ok: false, handler: 'tunnel_unknown', reason: 'invalid_tunnel_message' };
      }
    } catch (err) {
      const reason = stableTunnelReason(err);
      if (reason !== 'request_id_in_use') cancelFromInvalid(msg, reason);
      return { handled: true, ok: false, handler: msg.type, reason };
    }
  }

  function onStart(msg, socket) {
    validateExactFields(msg, REQUEST_START_FIELDS);
    validateRequestId(msg.requestId);
    if (contexts.has(msg.requestId)) throw new Error('request_id_in_use');
    if (typeof msg.instanceId !== 'string' || msg.instanceId.length < 4 || msg.instanceId.length > 128) throw new Error('invalid_instance_id');
    if (typeof msg.method !== 'string' || !TOKEN_RE.test(msg.method)) throw new Error('invalid_method');
    validatePath(msg.path);
    validateQuery(msg.query);
    if (typeof msg.hasBody !== 'boolean') throw new Error('invalid_has_body');
    const headers = validateRequestHeaders(msg.headers, limits, msg.method, msg.hasBody);

    const ctx = {
      requestId: msg.requestId,
      method: msg.method,
      pathOnly: msg.path,
      socket,
      hasRequestBody: msg.hasBody,
      nextRequestSequence: 0,
      nextResponseSequence: 0,
      requestBytes: 0,
      responseBytes: 0,
      startedAtMs: performance.now(),
      state: msg.hasBody ? 'receiving_request_body' : 'request_started',
      completed: false,
      cancelled: false,
      request: null,
      response: null,
      idleTimer: null,
      absoluteTimer: null,
    };
    contexts.set(msg.requestId, ctx);
    armTimers(ctx);
    logger('Tunnel-Request-Kontext angelegt', {
      requestIdShort: shortId(ctx.requestId),
      method: ctx.method,
      path: ctx.pathOnly,
      requestTimeoutMs: limits.requestTimeoutMs,
      idleTimeoutMs: limits.idleTimeoutMs,
      requestTimerDelayMs: limits.requestTimeoutMs,
      idleTimerDelayMs: limits.idleTimeoutMs,
      monotonicStartMs: 0,
    });

    const targetPath = msg.query ? `${msg.path}?${msg.query}` : msg.path;
    logger('Tunnel-Request lokale Header vorbereitet', {
      requestIdShort: shortId(ctx.requestId),
      method: ctx.method,
      path: ctx.pathOnly,
      target: targetPath,
      headerNames: summarizeHeaderNames(headers),
      localHeaderNames: ['host', ...summarizeHeaderNames(headers)],
      specialHeaders: summarizeSpecialHeaders(headers),
      hostHeaderSet: true,
      hostHeaderSource: 'local_origin',
      localHost: `${host}:${port}`,
    });
    const req = requestImpl({
      host,
      port,
      method: msg.method,
      path: targetPath,
      headers,
      signal: null,
    }, (res) => handleLocalResponse(ctx, res));
    ctx.request = req;
    req.on('error', () => {
      if (!ctx.cancelled && !ctx.completed) cancelContext(ctx, true, 'origin_cancelled');
    });
    req.on('close', () => {
      if (!ctx.completed && !ctx.cancelled && ctx.state !== 'response_started' && ctx.state !== 'receiving_response_body') {
        cancelContext(ctx, true, 'origin_cancelled');
      }
    });
    if (!msg.hasBody) {
      ctx.state = 'request_started';
    }
    return true;
  }

  function onBody(msg, socket) {
    validateExactFields(msg, REQUEST_BODY_FIELDS);
    validateRequestId(msg.requestId);
    const ctx = contexts.get(msg.requestId);
    if (!ctx || ctx.socket !== socket) return cancelFromInvalid(msg, 'request_not_found');
    if (!ctx.hasRequestBody || ctx.state !== 'receiving_request_body') return cancelContext(ctx, true, 'origin_cancelled');
    if (!Number.isInteger(msg.sequence) || msg.sequence !== ctx.nextRequestSequence) return cancelContext(ctx, true, 'origin_cancelled');
    const chunk = decodeBodyChunk(msg.data, limits);
    ctx.requestBytes += chunk.length;
    if (ctx.requestBytes > limits.maxBodyBytes) return cancelContext(ctx, true, 'origin_cancelled');
    ctx.nextRequestSequence += 1;
    armIdleTimer(ctx);
    if (!ctx.request.write(chunk)) {
      ctx.request.once('drain', () => {});
    }
    return true;
  }

  function onEnd(msg, socket) {
    validateExactFields(msg, REQUEST_END_FIELDS);
    validateRequestId(msg.requestId);
    const ctx = contexts.get(msg.requestId);
    if (!ctx || ctx.socket !== socket) return cancelFromInvalid(msg, 'request_not_found');
    if (ctx.state !== 'request_started' && ctx.state !== 'receiving_request_body') return cancelContext(ctx, true, 'origin_cancelled');
    ctx.state = 'request_complete';
    clearRequestTimer(ctx);
    armIdleTimer(ctx);
    ctx.request.end();
    return true;
  }

  function onCancel(msg) {
    validateExactFields(msg, CANCEL_FIELDS);
    validateRequestId(msg.requestId);
    if (!RELAY_CANCEL_REASONS.has(msg.reason)) throw new Error('invalid_cancel_reason');
    const ctx = contexts.get(msg.requestId);
    if (ctx) cancelContext(ctx, false, msg.reason);
    return true;
  }

  function handleLocalResponse(ctx, res) {
    if (!contexts.has(ctx.requestId) || ctx.cancelled) {
      res.resume();
      return;
    }
    ctx.response = res;
    ctx.state = 'response_started';
    if (!Number.isInteger(res.statusCode) || res.statusCode < 100 || res.statusCode > 999) {
      cancelContext(ctx, true, 'origin_cancelled');
      return;
    }
    const headers = validateHeaders(filterResponseHeaders(rawHeaderPairs(res.rawHeaders || [])), limits);
    const hasBody = responseCanHaveBody(ctx.method, res.statusCode, headers);
    if (!sendTunnel(ctx, {
      type: 'tunnel_response_start',
      requestId: ctx.requestId,
      status: res.statusCode,
      headers,
      hasBody,
    })) {
      return;
    }
    if (!hasBody) {
      res.resume();
      res.once('end', () => finishContext(ctx));
      res.once('close', () => { if (!ctx.completed && !ctx.cancelled) finishContext(ctx); });
      return;
    }
    ctx.state = 'receiving_response_body';
    res.on('data', (chunk) => {
      if (ctx.cancelled || ctx.completed) return;
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      for (let offset = 0; offset < chunk.length; offset += limits.effectiveChunkRawBytes) {
        const part = chunk.subarray(offset, offset + limits.effectiveChunkRawBytes);
        ctx.responseBytes += part.length;
        if (ctx.responseBytes > limits.maxBodyBytes || part.length > limits.effectiveChunkRawBytes) {
          cancelContext(ctx, true, 'origin_cancelled');
          return;
        }
        const data = part.toString('base64');
        if (data.length > limits.maxChunkBase64Chars) {
          cancelContext(ctx, true, 'origin_cancelled');
          return;
        }
        const msg = {
          type: 'tunnel_response_body',
          requestId: ctx.requestId,
          sequence: ctx.nextResponseSequence,
          data,
        };
        logger('Tunnel-Response-Body-Chunk wird gesendet', {
          type: msg.type,
          fields: Object.keys(msg),
          requestIdShort: shortId(ctx.requestId),
          sequence: msg.sequence,
          rawBytes: part.length,
          base64Chars: data.length,
          maxChunkRawBytes: limits.maxChunkRawBytes,
          maxChunkBase64Chars: limits.maxChunkBase64Chars,
          effectiveChunkRawBytes: limits.effectiveChunkRawBytes,
        });
        if (!sendTunnel(ctx, msg)) {
          return;
        }
        ctx.nextResponseSequence += 1;
      }
      armIdleTimer(ctx);
    });
    res.on('end', () => {
      if (!ctx.cancelled && !ctx.completed) finishContext(ctx);
    });
    res.on('error', () => {
      if (!ctx.cancelled && !ctx.completed) cancelContext(ctx, true, 'origin_cancelled');
    });
  }

  function sendTunnel(ctx, obj) {
    if (!contexts.has(ctx.requestId) || ctx.cancelled || ctx.completed) return false;
    const socket = ctx.socket;
    const OPEN = WebSocketImpl && WebSocketImpl.OPEN != null ? WebSocketImpl.OPEN : 1;
    if (!socket || socket.readyState !== OPEN) {
      cancelContext(ctx, false, 'connection_closed');
      return false;
    }
    if (Number(socket.bufferedAmount || 0) > limits.maxBufferedAmount) {
      cancelContext(ctx, true, 'origin_cancelled');
      return false;
    }
    socket.send(JSON.stringify(obj));
    if (Number(socket.bufferedAmount || 0) > limits.maxBufferedAmount) {
      cancelContext(ctx, true, 'origin_cancelled');
      return false;
    }
    return true;
  }

  function finishContext(ctx) {
    if (!contexts.has(ctx.requestId) || ctx.cancelled || ctx.completed) return;
    sendTunnel(ctx, { type: 'tunnel_response_end', requestId: ctx.requestId });
    ctx.completed = true;
    cleanupContext(ctx);
    logger('Tunnel-Request abgeschlossen', {
      requestIdShort: shortId(ctx.requestId),
      method: ctx.method,
      path: ctx.pathOnly,
      status: ctx.response && ctx.response.statusCode,
      bytes: ctx.responseBytes,
      durationMs: elapsedMs(ctx),
    });
  }

  function cancelContext(ctx, notifyRelay, reason, timerKind = null) {
    if (!contexts.has(ctx.requestId)) return true;
    ctx.cancelled = true;
    const durationMs = elapsedMs(ctx);
    cleanupContext(ctx);
    if (ctx.response && typeof ctx.response.destroy === 'function') {
      try { ctx.response.destroy(); } catch (_) { /* egal */ }
    }
    if (ctx.request && typeof ctx.request.destroy === 'function') {
      try { ctx.request.destroy(); } catch (_) { /* egal */ }
    }
    if (notifyRelay && ctx.socket) {
      try {
        const OPEN = WebSocketImpl && WebSocketImpl.OPEN != null ? WebSocketImpl.OPEN : 1;
        if (ctx.socket.readyState === OPEN) {
          ctx.socket.send(JSON.stringify({ type: 'tunnel_cancel', requestId: ctx.requestId, reason: 'origin_cancelled' }));
        }
      } catch (_) { /* egal */ }
    }
    logger('Tunnel-Request abgebrochen', {
      requestIdShort: shortId(ctx.requestId),
      method: ctx.method,
      path: ctx.pathOnly,
      bytes: ctx.responseBytes,
      durationMs,
      reason: reason || 'origin_cancelled',
      timerKind,
    });
    return true;
  }

  function cleanupContext(ctx) {
    contexts.delete(ctx.requestId);
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    if (ctx.absoluteTimer) clearTimeout(ctx.absoluteTimer);
    ctx.idleTimer = null;
    ctx.absoluteTimer = null;
  }

  function clearRequestTimer(ctx) {
    if (ctx.absoluteTimer) clearTimeout(ctx.absoluteTimer);
    ctx.absoluteTimer = null;
  }

  function armTimers(ctx) {
    ctx.absoluteTimer = setTimeout(() => cancelContext(ctx, true, 'request_timeout', 'request_timeout'), limits.requestTimeoutMs);
    if (ctx.absoluteTimer.unref) ctx.absoluteTimer.unref();
    armIdleTimer(ctx);
  }

  function armIdleTimer(ctx) {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = setTimeout(() => cancelContext(ctx, true, 'idle_timeout', 'idle_timeout'), limits.idleTimeoutMs);
    if (ctx.idleTimer.unref) ctx.idleTimer.unref();
  }

  function cancelFromInvalid(msg) {
    if (msg && typeof msg.requestId === 'string') {
      const ctx = contexts.get(msg.requestId);
      if (ctx) return cancelContext(ctx, true, 'origin_cancelled');
    }
    return true;
  }

  function abortAll(reason) {
    for (const ctx of Array.from(contexts.values())) {
      cancelContext(ctx, reason !== 'connection_closed', reason || 'connection_closed');
    }
  }

  return {
    handleMessage,
    abortAll,
    activeCount: () => contexts.size,
  };
}

function normalizeLimits(options) {
  const maxChunkRawBytes = normalizeChunkRawBytesOption(options);
  const maxChunkBase64Chars = normalizePositiveIntegerOption(options, 'maxChunkBase64Chars', DEFAULTS.maxChunkBase64Chars, 4);
  const effectiveChunkRawBytes = Math.min(
    maxChunkRawBytes,
    RELAY_MAX_CHUNK_RAW_BYTES,
    maxRawBytesForBase64Chars(maxChunkBase64Chars),
  );
  return {
    ...DEFAULTS,
    ...copyDefinedLimitOptions(options),
    requestTimeoutMs: normalizeTimeoutOption(options, 'requestTimeoutMs', DEFAULTS.requestTimeoutMs, MIN_REQUEST_TIMEOUT_MS),
    idleTimeoutMs: normalizeTimeoutOption(options, 'idleTimeoutMs', DEFAULTS.idleTimeoutMs, MIN_IDLE_TIMEOUT_MS),
    maxChunkRawBytes,
    maxChunkBase64Chars,
    effectiveChunkRawBytes,
  };
}

function copyDefinedLimitOptions(options) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'requestTimeoutMs' || key === 'idleTimeoutMs') continue;
    if (key === 'maxChunkRawBytes' || key === 'maxChunkBase64Chars') continue;
    if (Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined) {
      out[key] = options[key];
    }
  }
  return out;
}

function normalizeTimeoutOption(options, key, fallback, minValue) {
  if (!Object.prototype.hasOwnProperty.call(options, key) || options[key] === undefined || options[key] === null) {
    return fallback;
  }
  const value = Number(options[key]);
  if (!Number.isFinite(value) || value < minValue || value > MAX_TIMEOUT_MS) {
    throw new Error(`invalid_${key}`);
  }
  return Math.trunc(value);
}

function normalizeChunkRawBytesOption(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'maxChunkRawBytes')) {
    return normalizePositiveIntegerOption(options, 'maxChunkRawBytes', DEFAULTS.maxChunkRawBytes, 1);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'maxChunkBytes')) {
    return normalizePositiveIntegerOption(options, 'maxChunkBytes', DEFAULTS.maxChunkRawBytes, 1);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'responseChunkBytes')) {
    return normalizePositiveIntegerOption(options, 'responseChunkBytes', DEFAULTS.maxChunkRawBytes, 1);
  }
  return DEFAULTS.maxChunkRawBytes;
}

function normalizePositiveIntegerOption(options, key, fallback, minValue) {
  if (!Object.prototype.hasOwnProperty.call(options, key) || options[key] === undefined || options[key] === null) {
    return fallback;
  }
  const value = Number(options[key]);
  if (!Number.isFinite(value) || value < minValue) {
    throw new Error(`invalid_${key}`);
  }
  return Math.trunc(value);
}

function maxRawBytesForBase64Chars(chars) {
  return Math.max(1, Math.floor(chars / 4) * 3);
}

function elapsedMs(ctx) {
  return Math.max(0, Math.round(performance.now() - ctx.startedAtMs));
}

function defaultRequestImpl(options, cb) {
  const req = http.request({
    host: options.host,
    port: options.port,
    method: options.method,
    path: options.path,
    headers: buildLocalHeaderList(options),
    agent: false,
  }, cb);
  return req;
}

function validateExactFields(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error('unknown_field');
  }
}

function validateRequestId(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 128 || /[\r\n]/.test(v)) throw new Error('invalid_request_id');
}

function validatePath(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 4096) throw new Error('invalid_path');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) throw new Error('invalid_path');
  if (/[\r\n]/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) throw new Error('invalid_path');
}

function validateQuery(query) {
  if (typeof query !== 'string' || query.length > 8192) throw new Error('invalid_query');
  if (query.startsWith('?') || query.includes('#') || /[\r\n]/.test(query)) throw new Error('invalid_query');
}

function validateHeaders(headers, limits) {
  if (!Array.isArray(headers) || headers.length > limits.maxHeaders) throw new Error('invalid_headers');
  let total = 0;
  const out = [];
  for (const h of headers) {
    if (!Array.isArray(h) || h.length !== 2) throw new Error('invalid_header');
    const [name, value] = h;
    if (typeof name !== 'string' || !TOKEN_RE.test(name)) throw new Error('invalid_header_name');
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('invalid_header_value');
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith('sec-websocket-')) throw new Error('hop_by_hop_header');
    total += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (total > limits.maxHeaderBytes) throw new Error('headers_too_large');
    out.push([name, value]);
  }
  return out;
}

function validateRequestHeaders(headers, limits, method, hasBody) {
  const pairs = validateHeaderPairs(headers, limits);
  return pairs.filter(([name]) => shouldForwardRequestHeader(name, method, hasBody));
}

function validateHeaderPairs(headers, limits) {
  if (!Array.isArray(headers) || headers.length > limits.maxHeaders) throw new Error('invalid_headers');
  let total = 0;
  const out = [];
  for (const h of headers) {
    if (!Array.isArray(h) || h.length !== 2) throw new Error('invalid_header');
    const [name, value] = h;
    if (typeof name !== 'string' || !TOKEN_RE.test(name)) throw new Error('invalid_header_name');
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('invalid_header_value');
    total += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (total > limits.maxHeaderBytes) throw new Error('headers_too_large');
    out.push([name, value]);
  }
  return out;
}

function shouldForwardRequestHeader(name, method, hasBody) {
  const lower = String(name).toLowerCase();
  if (LOCAL_ONLY_REQUEST_HEADERS.has(lower) || lower.startsWith('sec-websocket-')) return false;
  if (lower === 'content-length' && (!hasBody || method === 'GET' || method === 'HEAD')) return false;
  return true;
}

function flattenHeaderPairs(headers) {
  const out = [];
  for (const [name, value] of headers || []) {
    out.push(name, value);
  }
  return out;
}

function buildLocalHeaderList(options) {
  return ['Host', formatHostHeader(options.host, options.port), ...flattenHeaderPairs(options.headers)];
}

function formatHostHeader(host, port) {
  const value = String(host || '127.0.0.1');
  const hostPart = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `${hostPart}:${port}`;
}

function summarizeHeaderNames(headers) {
  return (headers || []).map(([name]) => String(name).toLowerCase());
}

function summarizeSpecialHeaders(headers) {
  const names = new Set(summarizeHeaderNames(headers));
  const special = {};
  for (const name of ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect']) {
    special[name] = names.has(name);
  }
  return special;
}

function hasHeader(headers, wanted) {
  const lower = String(wanted).toLowerCase();
  return (headers || []).some(([name]) => String(name).toLowerCase() === lower);
}

function stableTunnelReason(err) {
  const reason = err && typeof err.message === 'string' ? err.message : 'invalid_tunnel_message';
  if (/^[a-z_]{3,64}$/.test(reason)) return reason;
  return 'invalid_tunnel_message';
}

function shortId(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function rawHeaderPairs(rawHeaders) {
  const pairs = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    pairs.push([String(rawHeaders[i]).toLowerCase(), String(rawHeaders[i + 1])]);
  }
  return pairs;
}

function filterResponseHeaders(headers) {
  return headers.filter(([name]) => {
    const lower = String(name).toLowerCase();
    return !HOP_BY_HOP.has(lower) && !lower.startsWith('sec-websocket-');
  });
}

function decodeBodyChunk(data, limits) {
  if (typeof data !== 'string' || data.length === 0) throw new Error('invalid_data');
  if (data.length > limits.maxChunkBase64Chars) throw new Error('chunk_too_large');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid_base64');
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0 || buf.length > limits.effectiveChunkRawBytes) throw new Error('chunk_too_large');
  return buf;
}

function responseCanHaveBody(method, status, headers) {
  if (method === 'HEAD') return false;
  if (status === 204 || status === 304 || (status >= 100 && status < 200)) return false;
  const contentLength = headers.find(([name]) => name.toLowerCase() === 'content-length');
  return !(contentLength && contentLength[1] === '0');
}

function createFakeLocalResponse({ statusCode = 200, headers = [], chunks = [], delayMs = 0 }) {
  const res = new PassThrough();
  res.statusCode = statusCode;
  res.rawHeaders = [];
  for (const [name, value] of headers) {
    res.rawHeaders.push(name, value);
  }
  process.nextTick(() => {
    for (const chunk of chunks) {
      res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    if (delayMs > 0) setTimeout(() => res.end(), delayMs);
    else res.end();
  });
  return res;
}

module.exports = {
  createOriginTunnel,
  createFakeLocalResponse,
  validateHeaders,
};
