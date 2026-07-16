'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createRelayConnection } = require('../src/remote-access/relay-connection');

const INSTANCE_ID = 'ins_test1234567890';

// Fake-WebSocket mit ws-kompatibler Oberfläche (on/send/close/terminate,
// readyState, statisches OPEN). Sammelt gesendete Nachrichten und erlaubt dem
// Test, Servernachrichten und Close-Events einzuspeisen.
function makeFakeWs() {
  const created = [];
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.readyState = FakeWs.OPEN;
      this.sent = [];
      this.closed = false;
      created.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.emit('close', 1000); }
    terminate() { this.closed = true; }
    // Test-Helfer.
    open() { this.emit('open'); }
    serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj), 'utf8'), false); }
    serverSendRaw(data, isBinary) { this.emit('message', data, Boolean(isBinary)); }
    serverClose(code, reason) { this.emit('close', code || 1006, reason); }
    lastSent() { return this.sent[this.sent.length - 1]; }
  }
  FakeWs.OPEN = 1;
  FakeWs.CONNECTING = 0;
  FakeWs.CLOSING = 2;
  FakeWs.CLOSED = 3;
  return { FakeWs, created };
}

function makeIdentityStore(overrides = {}) {
  return {
    async getProvisionedIdentity() { return { instanceId: INSTANCE_ID }; },
    async signRelayChallenge(fields) {
      makeIdentityStore.lastFields = fields;
      return 'c2lnbmF0dXJl'; // base64 "signature"
    },
    ...overrides,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function captureLogger() {
  const entries = [];
  const logger = (event, meta) => entries.push({ event, meta: meta || {} });
  logger.entries = entries;
  logger.some = (predicate) => entries.some(predicate);
  return logger;
}

async function connectedTo(overrides = {}) {
  const { FakeWs, created } = makeFakeWs();
  const conn = createRelayConnection({
    wsUrl: 'wss://relay.example/api/v1/ws/homeess',
    WebSocketImpl: FakeWs,
    identityStore: makeIdentityStore(),
    logger: () => {},
    backoffMs: [20],
    authTimeoutMs: 50,
    idleTimeoutMs: 10000,
    ...overrides,
  });
  conn.start();
  await tick();
  return { conn, created };
}

test('Hello: sendet clientType homeess und die provisionierte instanceId', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  const hello = ws.sent[0];
  assert.equal(hello.type, 'hello');
  assert.equal(hello.clientType, 'homeess');
  assert.equal(hello.protocolVersion, '0.1');
  assert.equal(hello.identityId, INSTANCE_ID);
  conn.shutdown();
});

function validChallenge(over = {}) {
  return {
    type: 'challenge',
    challengeId: 'ch_abc12345',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15000).toISOString(),
    protocolVersion: '0.1',
    clientType: 'homeess',
    identityId: INSTANCE_ID,
    ...over,
  };
}

test('Challenge -> Auth-Nutzlast exakt aus Challenge, Signatur gesendet, authenticated erreicht', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  const chal = validChallenge();
  ws.serverSend(chal);
  await tick();
  // signRelayChallenge muss exakt die Challenge-Werte erhalten haben.
  const f = makeIdentityStore.lastFields;
  assert.equal(f.challengeId, chal.challengeId);
  assert.equal(f.nonce, chal.nonce);
  assert.equal(f.issuedAt, chal.issuedAt);
  assert.equal(f.expiresAt, chal.expiresAt);
  assert.equal(f.protocolVersion, '0.1');
  assert.equal(f.clientType, 'homeess');
  assert.equal(f.identityId, INSTANCE_ID);
  const authMsg = ws.lastSent();
  assert.equal(authMsg.type, 'authenticate');
  assert.equal(authMsg.challengeId, chal.challengeId);
  assert.ok(authMsg.signature, 'Signatur gesendet');

  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_abc123', capabilities: { authenticatedWebSocket: true, relayTunnel: false } });
  await tick();
  const st = conn.getStatus();
  assert.equal(st.state, 'authenticated');
  assert.equal(st.relayTunnel, false);
  conn.shutdown();
});

test('Challenge mit falscher identityId sendet KEIN authenticate', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge({ identityId: 'ins_wrong' }));
  await tick();
  assert.ok(!ws.sent.some((m) => m.type === 'authenticate'), 'kein authenticate bei fremder identityId');
  conn.shutdown();
});

test('Challenge mit falschem clientType wird abgelehnt', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge({ clientType: 'app' }));
  await tick();
  assert.ok(!ws.sent.some((m) => m.type === 'authenticate'));
  conn.shutdown();
});

test('Abgelaufene Challenge wird abgelehnt, kein authenticate', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge({ expiresAt: new Date(Date.now() - 60000).toISOString() }));
  await tick();
  assert.ok(!ws.sent.some((m) => m.type === 'authenticate'));
  conn.shutdown();
});

test('Unbekanntes Challenge-Feld wird strikt abgelehnt', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge({ extra: 'nope' }));
  await tick();
  assert.ok(!ws.sent.some((m) => m.type === 'authenticate'));
  conn.shutdown();
});

test('connection_replaced: kontrolliert stoppen, kein automatischer Reconnect', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  ws.serverSend({ type: 'error', code: 'connection_replaced' });
  await tick();
  const st = conn.getStatus();
  assert.equal(st.lastError, 'remote_access_connection_replaced');
  await new Promise((r) => setTimeout(r, 40));
  // Kein neuer Socket entstanden.
  assert.equal(created.length, 1, 'kein Reconnect nach connection_replaced');
  conn.shutdown();
});

test('authentication_failed: Reconnect bis Grenze, danach failed', async () => {
  const { conn, created } = await connectedTo({ maxAuthFailures: 2, backoffMs: [10] });
  created[0].open();
  created[0].serverSend({ type: 'error', code: 'authentication_failed' });
  await new Promise((r) => setTimeout(r, 30));
  // Zweiter Versuch.
  assert.ok(created.length >= 2, 'Reconnect nach erstem Auth-Fehler');
  created[created.length - 1].open();
  created[created.length - 1].serverSend({ type: 'error', code: 'authentication_failed' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(conn.getStatus().state, 'failed');
  conn.shutdown();
});

test('Reconnect nach unerwartetem Close', async () => {
  const { conn, created } = await connectedTo({ backoffMs: [10] });
  created[0].open();
  created[0].serverClose(1006);
  await tick();
  assert.equal(conn.getStatus().state, 'reconnecting');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(created.length >= 2, 'neue Verbindung aufgebaut');
  conn.shutdown();
});

test('Nach authenticated: ping wird mit pong beantwortet, Fremdnachricht bricht ab', async () => {
  const { conn, created } = await connectedTo({ backoffMs: [10] });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: false } });
  await tick();
  ws.serverSend({ type: 'ping' });
  await tick();
  assert.equal(ws.lastSent().type, 'pong', 'ping -> pong');
  // Keine Tunnel-/Fremdnachricht akzeptiert.
  ws.serverSend({ type: 'http_request', id: 1 });
  await tick();
  assert.notEqual(conn.getStatus().state, 'authenticated');
  conn.shutdown();
});

test('Nach authenticated mit relayTunnel: true werden Tunnel-Nachrichten lokal ausgeführt', async () => {
  const localRequests = [];
  function requestImpl(options, onResponse) {
    const { Writable, PassThrough } = require('stream');
    const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    req.on('finish', () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.rawHeaders = ['content-type', 'text/plain'];
      onResponse(res);
      res.end('ok');
    });
    localRequests.push({ options, req });
    return req;
  }
  const { conn, created } = await connectedTo({ requestImpl });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();
  assert.equal(conn.getStatus().relayTunnel, true);

  ws.serverSend({
    type: 'tunnel_request_start',
    requestId: 'req_ws',
    instanceId: INSTANCE_ID,
    method: 'GET',
    path: '/dashboard/data',
    query: '',
    headers: [['accept', 'text/plain']],
    hasBody: false,
  });
  ws.serverSend({ type: 'tunnel_request_end', requestId: 'req_ws' });
  await tick();

  assert.equal(localRequests[0].options.host, '127.0.0.1');
  assert.equal(localRequests[0].options.path, '/dashboard/data');
  assert.deepEqual(ws.sent.slice(-3).map((m) => m.type), ['tunnel_response_start', 'tunnel_response_body', 'tunnel_response_end']);
  conn.shutdown();
});

test('Buffer mit gültigem tunnel_request_start wird geparst und dispatcht', async () => {
  const logger = captureLogger();
  const localRequests = [];
  function requestImpl(options, onResponse) {
    const { Writable, PassThrough } = require('stream');
    const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    req.on('finish', () => {
      const res = new PassThrough();
      res.statusCode = 204;
      res.rawHeaders = [];
      onResponse(res);
      res.end();
    });
    localRequests.push(options);
    return req;
  }
  const { conn, created } = await connectedTo({ requestImpl, logger });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();

  ws.serverSendRaw(Buffer.from(JSON.stringify({
    type: 'tunnel_request_start',
    requestId: 'req_buffer_001',
    instanceId: INSTANCE_ID,
    method: 'GET',
    path: '/dashboard/data',
    query: '',
    headers: [],
    hasBody: false,
  }), 'utf8'), false);
  ws.serverSendRaw(Buffer.from(JSON.stringify({ type: 'tunnel_request_end', requestId: 'req_buffer_001' }), 'utf8'), false);
  await tick();

  assert.equal(localRequests.length, 1);
  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket Nachricht Dispatch' && e.meta.messageType === 'tunnel_request_start' && e.meta.schemaOk === true && e.meta.dispatch === 'tunnel_request_start'));
  conn.shutdown();
});

test('String-Frame mit gültigem tunnel_request_start wird geparst und dispatcht', async () => {
  const logger = captureLogger();
  const localRequests = [];
  function requestImpl(options, onResponse) {
    const { Writable, PassThrough } = require('stream');
    const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    req.on('finish', () => {
      const res = new PassThrough();
      res.statusCode = 204;
      res.rawHeaders = [];
      onResponse(res);
      res.end();
    });
    localRequests.push(options);
    return req;
  }
  const { conn, created } = await connectedTo({ requestImpl, logger });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();

  ws.serverSendRaw(JSON.stringify({
    type: 'tunnel_request_start',
    requestId: 'req_string_001',
    instanceId: INSTANCE_ID,
    method: 'GET',
    path: '/dashboard/data',
    query: '',
    headers: [],
    hasBody: false,
  }), false);
  ws.serverSendRaw(JSON.stringify({ type: 'tunnel_request_end', requestId: 'req_string_001' }), false);
  await tick();

  assert.equal(localRequests.length, 1);
  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket Frame empfangen' && e.meta.frameType === 'text' && e.meta.length > 0));
  conn.shutdown();
});

test('tunnel_request_start gefolgt von tunnel_request_end bleibt in korrekter Reihenfolge', async () => {
  const seen = [];
  const originTunnel = {
    handleMessage(msg) {
      seen.push(msg.type);
      return { handled: true, ok: true, handler: msg.type };
    },
    abortAll() {},
  };
  const { conn, created } = await connectedTo({ originTunnel });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();
  ws.serverSend({ type: 'tunnel_request_start', requestId: 'req_order_001', instanceId: INSTANCE_ID, method: 'GET', path: '/', query: '', headers: [], hasBody: false });
  ws.serverSend({ type: 'tunnel_request_end', requestId: 'req_order_001' });
  await tick();

  assert.deepEqual(seen, ['tunnel_request_start', 'tunnel_request_end']);
  conn.shutdown();
});

test('ungültiger Wire-Type wird sichtbar abgelehnt', async () => {
  const logger = captureLogger();
  const { conn, created } = await connectedTo({ logger });
  const ws = created[0];
  ws.open();
  ws.serverSendRaw(Buffer.from([0, 1, 2, 3]), true);
  await tick();

  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket Nachricht abgelehnt' && e.meta.reason === 'binary_message' && e.meta.schemaOk === false));
  conn.shutdown();
});

test('Tunnel-Schemafehler wird sichtbar abgelehnt', async () => {
  const logger = captureLogger();
  const { conn, created } = await connectedTo({ logger });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();

  ws.serverSend({ type: 'tunnel_request_start', requestId: 'req_bad_schema', instanceId: INSTANCE_ID, method: 'GET', path: '/', query: '', hasBody: false });
  await tick();

  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket Nachricht Dispatch' && e.meta.messageType === 'tunnel_request_start' && e.meta.schemaOk === false && e.meta.reason === 'invalid_headers'));
  conn.shutdown();
});

test('asynchroner Message-Handlerfehler wird abgefangen und geloggt', async () => {
  const logger = captureLogger();
  const originTunnel = {
    handleMessage() { throw new Error('boom'); },
    abortAll() {},
  };
  const { conn, created } = await connectedTo({ logger, originTunnel, backoffMs: [10] });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();

  ws.serverSend({ type: 'tunnel_request_end', requestId: 'req_throw_001' });
  await tick();

  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket Message-Handler Fehler'));
  assert.notEqual(conn.getStatus().state, 'authenticated');
  conn.shutdown();
});

test('authentifizierter Socket behält seinen Message-Listener', async () => {
  const logger = captureLogger();
  const { conn, created } = await connectedTo({ logger });
  const ws = created[0];
  ws.open();
  assert.equal(ws.listenerCount('message'), 1);
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: true } });
  await tick();

  assert.equal(ws.listenerCount('message'), 1);
  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket message-Listener registriert' && e.meta.listenerCount === 1));
  conn.shutdown();
});

test('WebSocket-Close loggt Code und sanitizten Grund', async () => {
  const logger = captureLogger();
  const { conn, created } = await connectedTo({ logger, backoffMs: [10] });
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_x', capabilities: { authenticatedWebSocket: true, relayTunnel: false } });
  await tick();
  ws.serverClose(4001, Buffer.from('policy close'));
  await tick();

  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket geschlossen' && e.meta.code === 4001 && e.meta.reason === 'policy_close'));
  conn.shutdown();
});

test('WebSocket-Fehlerereignis wird stabil geloggt', async () => {
  const logger = captureLogger();
  const { conn, created } = await connectedTo({ logger });
  const ws = created[0];
  ws.open();
  const err = new Error('secret details');
  err.code = 'ECONNRESET';
  ws.emit('error', err);
  await tick();

  assert.ok(logger.some((e) => e.event === 'Relay-WebSocket Fehlerereignis' && e.meta.error === 'ECONNRESET'));
  conn.shutdown();
});

test('Auth-Timeout schließt und plant Reconnect', async () => {
  const { conn, created } = await connectedTo({ authTimeoutMs: 15, backoffMs: [10] });
  created[0].open();
  // Keine Challenge senden -> Auth-Timeout.
  await new Promise((r) => setTimeout(r, 30));
  const st = conn.getStatus();
  assert.ok(st.lastError === 'remote_access_authentication_timeout' || created.length >= 2);
  conn.shutdown();
});

test('shutdown stoppt sauber und verhindert weitere Verbindungen', async () => {
  const { conn, created } = await connectedTo({ backoffMs: [10] });
  created[0].open();
  conn.shutdown();
  const before = created.length;
  created[0].serverClose(1006);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(created.length, before, 'kein Reconnect nach shutdown');
  assert.equal(conn.getStatus().state, 'stopped');
});

test('nicht provisioniert: Verbindung bleibt idle (kein Socket)', async () => {
  const { FakeWs, created } = makeFakeWs();
  const conn = createRelayConnection({
    wsUrl: 'wss://relay.example/ws',
    WebSocketImpl: FakeWs,
    identityStore: { async getProvisionedIdentity() { return null; } },
    logger: () => {},
  });
  conn.start();
  await tick();
  assert.equal(created.length, 0, 'kein Verbindungsaufbau ohne Provisioning');
  assert.equal(conn.getStatus().state, 'idle');
  conn.shutdown();
});

test('getStatus liefert nur gekürzte, nicht-geheime Diagnose', async () => {
  const { conn, created } = await connectedTo();
  const ws = created[0];
  ws.open();
  ws.serverSend(validChallenge());
  await tick();
  ws.serverSend({ type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID, connectionId: 'conn_supersecretlongid', capabilities: { authenticatedWebSocket: true, relayTunnel: false } });
  await tick();
  const st = conn.getStatus();
  assert.ok(st.connectionId.length <= 14, 'connectionId gekürzt');
  assert.ok(!JSON.stringify(st).includes('c2lnbmF0dXJl'), 'keine Signatur im Status');
  conn.shutdown();
});
