'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { Writable, PassThrough } = require('stream');

const { createOriginTunnel } = require('../src/remote-access/origin-tunnel');

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail('Timeout beim Warten auf Testbedingung');
}

function makeSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
  };
}

function b64(value) {
  return Buffer.from(value).toString('base64');
}

function responseBodies(socket) {
  return socket.sent.filter((m) => m.type === 'tunnel_response_body');
}

function decodeResponseBody(socket) {
  return Buffer.concat(responseBodies(socket).map((m) => Buffer.from(m.data, 'base64')));
}

function assertRelayBodyMessage(msg, sequence, requestId = 'req_1') {
  assert.deepEqual(Object.keys(msg), ['type', 'requestId', 'sequence', 'data']);
  assert.equal(msg.type, 'tunnel_response_body');
  assert.equal(msg.requestId, requestId);
  assert.equal(msg.sequence, sequence);
  assert.equal(typeof msg.sequence, 'number');
  assert.equal(typeof msg.data, 'string');
  assert.match(msg.data, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
}

function validateRelayBodyMessage(msg, expectedMaxChunkBytes = 8192) {
  const allowed = ['type', 'requestId', 'sequence', 'data'];
  assert.deepEqual(Object.keys(msg), allowed);
  assert.equal(msg.type, 'tunnel_response_body');
  assert.equal(typeof msg.requestId, 'string');
  assert.equal(Number.isInteger(msg.sequence), true);
  assert.equal(typeof msg.data, 'string');
  assert.match(msg.data, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
  const raw = Buffer.from(msg.data, 'base64');
  assert.ok(raw.length <= expectedMaxChunkBytes, `chunk_exceeds_max_size: ${raw.length} > ${expectedMaxChunkBytes}`);
}

function captureLogger() {
  const entries = [];
  return {
    entries,
    logger(message, meta) {
      entries.push({ message, meta });
    },
  };
}

function makeRequestHarness() {
  const requests = [];
  function requestImpl(options, onResponse) {
    const req = new Writable({
      write(chunk, enc, cb) {
        entry.body.push(Buffer.from(chunk));
        cb();
      },
    });
    const entry = {
      options,
      body: [],
      ended: false,
      destroyed: false,
      req,
      respond(statusCode = 200, headers = [], chunks = []) {
        const res = new PassThrough();
        res.statusCode = statusCode;
        res.rawHeaders = headers.flatMap(([name, value]) => [name, value]);
        onResponse(res);
        for (const chunk of chunks) res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        res.end();
        return res;
      },
      openResponse(statusCode = 200, headers = []) {
        const res = new PassThrough();
        res.statusCode = statusCode;
        res.rawHeaders = headers.flatMap(([name, value]) => [name, value]);
        onResponse(res);
        return res;
      },
    };
    req.on('finish', () => { entry.ended = true; });
    req.destroy = () => {
      entry.destroyed = true;
      Writable.prototype.destroy.call(req);
    };
    requests.push(entry);
    return req;
  }
  return { requestImpl, requests };
}

function start(tunnel, socket, over = {}) {
  tunnel.handleMessage({
    type: 'tunnel_request_start',
    requestId: over.requestId || 'req_1',
    instanceId: 'ins_test',
    method: over.method || 'GET',
    path: over.path || '/dashboard/data',
    query: over.query || '',
    headers: over.headers || [['accept', 'application/json']],
    hasBody: over.hasBody === true,
    ...over.extra,
  }, socket);
}

test('GET ohne Body wird lokal mit Pfad und Query ausgeführt und streamt die Antwort', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxChunkRawBytes: 4 });
  start(tunnel, socket, { query: 'page=1&filter=a%2Bb' });
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'text/plain']], ['hello', 'world']);
  await tick();

  assert.equal(h.requests[0].options.host, '127.0.0.1');
  assert.equal(h.requests[0].options.path, '/dashboard/data?page=1&filter=a%2Bb');
  assert.equal(h.requests[0].options.method, 'GET');
  assert.deepEqual(socket.sent.map((m) => m.type), [
    'tunnel_response_start',
    'tunnel_response_body',
    'tunnel_response_body',
    'tunnel_response_body',
    'tunnel_response_body',
    'tunnel_response_end',
  ]);
  assert.deepEqual(socket.sent.filter((m) => m.type === 'tunnel_response_body').map((m) => m.sequence), [0, 1, 2, 3]);
  assert.equal(tunnel.activeCount(), 0);
});

test('POST mit mehreren Body-Chunks bewahrt Body-Bytes und Header-Mehrfachwerte', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  const headers = [['x-a', '1'], ['x-a', '2'], ['cookie', 'ess_sid=abc'], ['cookie', 'pref=1']];
  start(tunnel, socket, { method: 'POST', path: '/api/remote-access/pairing/confirm', headers, hasBody: true });
  tunnel.handleMessage({ type: 'tunnel_request_body', requestId: 'req_1', sequence: 0, data: b64('ab') }, socket);
  tunnel.handleMessage({ type: 'tunnel_request_body', requestId: 'req_1', sequence: 1, data: b64('cd') }, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(204, [], []);
  await tick();

  assert.deepEqual(h.requests[0].options.headers, headers);
  assert.equal(Buffer.concat(h.requests[0].body).toString('utf8'), 'abcd');
  assert.equal(socket.sent[0].hasBody, false);
  assert.equal(tunnel.activeCount(), 0);
});

test('Set-Cookie und andere Response-Mehrfachheader bleiben getrennt', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['x-a', '1'], ['x-a', '2']], ['ok']);
  await tick();

  assert.deepEqual(socket.sent[0].headers, [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['x-a', '1'], ['x-a', '2']]);
});

test('ein einzelner Response-Body-Chunk entspricht exakt dem Relay-Wire-Schema', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: logs.logger, maxChunkRawBytes: 1024 });
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'text/plain']], ['hello']);
  await tick();

  assert.deepEqual(socket.sent.map((m) => m.type), ['tunnel_response_start', 'tunnel_response_body', 'tunnel_response_end']);
  assert.equal(responseBodies(socket).length, 1);
  assertRelayBodyMessage(responseBodies(socket)[0], 0);
  assert.equal(decodeResponseBody(socket).toString('utf8'), 'hello');
  const chunkLog = logs.entries.find((e) => e.message === 'Tunnel-Response-Body-Chunk wird gesendet');
  assert.deepEqual(chunkLog.meta.fields, ['type', 'requestId', 'sequence', 'data']);
  assert.equal(chunkLog.meta.sequence, 0);
  assert.equal(chunkLog.meta.rawBytes, 5);
  assert.equal(chunkLog.meta.base64Chars, responseBodies(socket)[0].data.length);
});

test('mehrere Response-Body-Chunks behalten Sequenz und Reihenfolge', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxChunkRawBytes: 3 });
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'text/plain']], ['abcdefghij']);
  await tick();

  assert.deepEqual(socket.sent.map((m) => m.type), [
    'tunnel_response_start',
    'tunnel_response_body',
    'tunnel_response_body',
    'tunnel_response_body',
    'tunnel_response_body',
    'tunnel_response_end',
  ]);
  responseBodies(socket).forEach((msg, index) => assertRelayBodyMessage(msg, index));
  assert.deepEqual(responseBodies(socket).map((m) => Buffer.from(m.data, 'base64').length), [3, 3, 3, 1]);
  assert.equal(decodeResponseBody(socket).toString('utf8'), 'abcdefghij');
});

test('156137 Bytes HTML wird in relay-konforme Response-Body-Chunks aufgeteilt', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: logs.logger });
  const prefix = Buffer.from('<!doctype html><main>');
  const suffix = Buffer.from('</main>');
  const html = Buffer.concat([
    prefix,
    Buffer.alloc(156137 - prefix.length - suffix.length, 'a'),
    suffix,
  ]);
  assert.equal(html.length, 156137);
  start(tunnel, socket, { path: '/messen-schalten' });
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'text/html']], [html]);
  await tick();

  assert.equal(socket.sent[0].type, 'tunnel_response_start');
  assert.equal(socket.sent.at(-1).type, 'tunnel_response_end');
  responseBodies(socket).forEach((msg, index) => {
    assertRelayBodyMessage(msg, index);
    assert.ok(msg.data.length <= 10924);
    assert.ok(Buffer.from(msg.data, 'base64').length <= 8192);
  });
  assert.equal(decodeResponseBody(socket).equals(html), true);
  const chunkLogs = logs.entries.filter((e) => e.message === 'Tunnel-Response-Body-Chunk wird gesendet');
  assert.equal(chunkLogs.length, responseBodies(socket).length);
  assert.ok(chunkLogs.every((e) => e.meta.rawBytes <= 8192));
  assert.ok(chunkLogs.every((e) => e.meta.base64Chars <= e.meta.maxChunkBase64Chars));
  assert.ok(chunkLogs.every((e) => e.meta.effectiveChunkRawBytes === 8192));
});

test('UTF-8 über Chunkgrenzen bleibt bytegetreu', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxChunkRawBytes: 5 });
  const text = 'A€B😀C';
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'text/plain; charset=utf-8']], [Buffer.from(text, 'utf8')]);
  await tick();

  assert.ok(responseBodies(socket).length > 1);
  responseBodies(socket).forEach((msg, index) => assertRelayBodyMessage(msg, index));
  assert.equal(decodeResponseBody(socket).toString('utf8'), text);
});

test('Binärdaten werden als Base64-Chunks bytegetreu übertragen', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxChunkRawBytes: 4 });
  const bytes = Buffer.from([0, 1, 2, 3, 252, 253, 254, 255, 128]);
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'application/octet-stream']], [bytes]);
  await tick();

  responseBodies(socket).forEach((msg, index) => assertRelayBodyMessage(msg, index));
  assert.equal(decodeResponseBody(socket).equals(bytes), true);
});

test('maximale Response-Chunkgröße berücksichtigt Base64-Wire-Limit', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: () => {},
    maxChunkRawBytes: 100,
    maxChunkBase64Chars: 8,
  });
  const bytes = Buffer.from('abcdefghijkl');
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'application/octet-stream']], [bytes]);
  await tick();

  assert.deepEqual(responseBodies(socket).map((m) => Buffer.from(m.data, 'base64').length), [6, 6]);
  assert.deepEqual(responseBodies(socket).map((m) => m.data.length), [8, 8]);
  responseBodies(socket).forEach((msg, index) => assertRelayBodyMessage(msg, index));
  assert.equal(decodeResponseBody(socket).equals(bytes), true);
});

test('8192 Rohbytes werden als einzelner relay-kompatibler Response-Chunk akzeptiert', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: logs.logger });
  const bytes = Buffer.alloc(8192, 0x61);
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'application/octet-stream']], [bytes]);
  await tick();

  assert.equal(responseBodies(socket).length, 1);
  validateRelayBodyMessage(responseBodies(socket)[0], 8192);
  assert.equal(Buffer.from(responseBodies(socket)[0].data, 'base64').length, 8192);
  assert.equal(responseBodies(socket)[0].data.length, 10924);
  assert.equal(decodeResponseBody(socket).equals(bytes), true);
  const chunkLog = logs.entries.find((e) => e.message === 'Tunnel-Response-Body-Chunk wird gesendet');
  assert.equal(chunkLog.meta.maxChunkRawBytes, 8192);
  assert.equal(chunkLog.meta.maxChunkBase64Chars, 10924);
  assert.equal(chunkLog.meta.effectiveChunkRawBytes, 8192);
});

test('8193 Rohbytes werden nie als einzelner Response-Chunk erzeugt', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxChunkRawBytes: 64 * 1024 });
  const bytes = Buffer.alloc(8193, 0x62);
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'application/octet-stream']], [bytes]);
  await tick();

  assert.deepEqual(responseBodies(socket).map((m) => Buffer.from(m.data, 'base64').length), [8192, 1]);
  responseBodies(socket).forEach((msg) => validateRelayBodyMessage(msg, 8192));
  assert.equal(decodeResponseBody(socket).equals(bytes), true);
});

test('Request- und Response-Richtung verwenden denselben 8192-Rohbytevertrag', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  const okChunk = Buffer.alloc(8192, 0x63);
  start(tunnel, socket, { method: 'POST', hasBody: true });
  tunnel.handleMessage({ type: 'tunnel_request_body', requestId: 'req_1', sequence: 0, data: okChunk.toString('base64') }, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'application/octet-stream']], [okChunk]);
  await tick();

  assert.equal(Buffer.concat(h.requests[0].body).equals(okChunk), true);
  assert.equal(responseBodies(socket).length, 1);
  validateRelayBodyMessage(responseBodies(socket)[0], 8192);
  assert.equal(decodeResponseBody(socket).equals(okChunk), true);

  const socket2 = makeSocket();
  const h2 = makeRequestHarness();
  const tunnel2 = createOriginTunnel({ requestImpl: h2.requestImpl, logger: () => {} });
  const tooLarge = Buffer.alloc(8193, 0x64);
  start(tunnel2, socket2, { method: 'POST', hasBody: true });
  tunnel2.handleMessage({ type: 'tunnel_request_body', requestId: 'req_1', sequence: 0, data: tooLarge.toString('base64') }, socket2);
  await tick();

  assert.equal(tunnel2.activeCount(), 0);
  assert.deepEqual(socket2.sent, [{ type: 'tunnel_cancel', requestId: 'req_1', reason: 'origin_cancelled' }]);
});

test('Relay-kompatibler Validator akzeptiert alle erzeugten Response-Body-Chunks', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxChunkRawBytes: 64 * 1024 });
  const bytes = Buffer.concat([
    Buffer.alloc(8192, 0x00),
    Buffer.from('UTF-8 Grenze € 😀'),
    Buffer.alloc(8193, 0xff),
  ]);
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['content-type', 'application/octet-stream']], [bytes]);
  await tick();

  assert.deepEqual(socket.sent.map((m) => m.type), [
    'tunnel_response_start',
    ...responseBodies(socket).map(() => 'tunnel_response_body'),
    'tunnel_response_end',
  ]);
  responseBodies(socket).forEach((msg, index) => {
    assertRelayBodyMessage(msg, index);
    validateRelayBodyMessage(msg, 8192);
  });
  assert.equal(decodeResponseBody(socket).equals(bytes), true);
});

test('lokale Response-Hop-by-Hop-Header werden nicht ueber den Tunnel gesendet', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(200, [['transfer-encoding', 'chunked'], ['connection', 'close'], ['content-type', 'text/plain']], ['ok']);
  await tick();

  assert.deepEqual(socket.sent[0].headers, [['content-type', 'text/plain']]);
  assert.equal(socket.sent.at(-1).type, 'tunnel_response_end');
});

test('mehrere parallele Requests laufen unabhängig', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { requestId: 'req_a', path: '/a' });
  start(tunnel, socket, { requestId: 'req_b', path: '/b' });
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_a' }, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_b' }, socket);
  h.requests[1].respond(200, [], ['b']);
  h.requests[0].respond(200, [], ['a']);
  await tick();

  assert.equal(h.requests.length, 2);
  assert.deepEqual(socket.sent.filter((m) => m.type === 'tunnel_response_start').map((m) => m.requestId), ['req_b', 'req_a']);
  assert.equal(tunnel.activeCount(), 0);
});

test('falsche Body-Sequenz bricht Request ab und räumt Kontext auf', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { hasBody: true });
  tunnel.handleMessage({ type: 'tunnel_request_body', requestId: 'req_1', sequence: 1, data: b64('x') }, socket);
  await tick();

  assert.equal(h.requests[0].destroyed, true);
  assert.deepEqual(socket.sent, [{ type: 'tunnel_cancel', requestId: 'req_1', reason: 'origin_cancelled' }]);
  assert.equal(tunnel.activeCount(), 0);
});

test('eingehender Cancel beendet lokale Anfrage und sendet keine weiteren Chunks', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { hasBody: true });
  tunnel.handleMessage({ type: 'tunnel_cancel', requestId: 'req_1', reason: 'client_cancelled' }, socket);
  h.requests[0].respond(200, [], ['late']);
  await tick();

  assert.equal(h.requests[0].destroyed, true);
  assert.deepEqual(socket.sent, []);
  assert.equal(tunnel.activeCount(), 0);
});

test('Disconnect-Cleanup bricht alle aktiven Requests ab', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { requestId: 'req_a', hasBody: true });
  start(tunnel, socket, { requestId: 'req_b', hasBody: true });
  tunnel.abortAll('connection_closed');

  assert.equal(h.requests[0].destroyed, true);
  assert.equal(h.requests[1].destroyed, true);
  assert.equal(tunnel.activeCount(), 0);
});

test('SSE/lange Responses werden vor Response-Ende weitergeleitet', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  const res = h.requests[0].openResponse(200, [['content-type', 'text/event-stream']]);
  res.write('data: one\n\n');
  await tick();

  assert.deepEqual(socket.sent.map((m) => m.type), ['tunnel_response_start', 'tunnel_response_body']);
  assert.equal(Buffer.from(socket.sent[1].data, 'base64').toString('utf8'), 'data: one\n\n');
  res.end();
  await tick();
  assert.equal(socket.sent.at(-1).type, 'tunnel_response_end');
});

test('lokale Auth/CSRF-Prüfungen bleiben wirksam, weil keine Header ergänzt werden', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { method: 'POST', path: '/api/remote-access/pairing', headers: [['accept', 'application/json']], hasBody: false });
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].respond(403, [['content-type', 'application/json'], ['content-length', '16']], ['{"error":"csrf"}']);
  await tick();

  assert.deepEqual(h.requests[0].options.headers, [['accept', 'application/json']]);
  assert.equal(socket.sent[0].status, 403);
  assert.equal(Buffer.from(socket.sent[1].data, 'base64').toString('utf8'), '{"error":"csrf"}');
});

test('externe Ziel-URLs sind strukturell unmöglich', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { path: 'https://example.test/' });
  start(tunnel, socket, { requestId: 'req_2', path: '//example.test/' });

  assert.equal(h.requests.length, 0);
  assert.equal(tunnel.activeCount(), 0);
});

test('Hop-by-Hop/WebSocket/Host-Header werden nicht an den lokalen Server weitergegeben', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { headers: [['connection', 'keep-alive']] });
  start(tunnel, socket, { requestId: 'req_2', headers: [['sec-websocket-key', 'x']] });
  start(tunnel, socket, { requestId: 'req_3', headers: [['host', 'evil.example']] });

  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests.map((r) => r.options.headers), [[], [], []]);
  tunnel.abortAll('connection_closed');
});

test('bodyloser GET filtert problematische Client-Header vor dem lokalen Origin', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: logs.logger });
  start(tunnel, socket, {
    path: '/messen-schalten',
    headers: [
      ['host', '127.0.0.1:1'],
      ['connection', 'upgrade'],
      ['keep-alive', 'timeout=5'],
      ['transfer-encoding', 'chunked'],
      ['te', 'trailers'],
      ['trailer', 'x-late'],
      ['upgrade', 'websocket'],
      ['expect', '100-continue'],
      ['content-length', '99'],
      ['accept', 'text/html'],
    ],
  });

  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].options.headers, [['accept', 'text/html']]);
  assert.equal(h.requests[0].options.path, '/messen-schalten');
  const headerLog = logs.entries.find((e) => e.message === 'Tunnel-Request lokale Header vorbereitet');
  assert.deepEqual(headerLog.meta.headerNames, ['accept']);
  assert.equal(headerLog.meta.hostHeaderSet, true);
  assert.equal(headerLog.meta.hostHeaderSource, 'local_origin');
  assert.deepEqual(headerLog.meta.localHeaderNames, ['host', 'accept']);
  assert.equal(headerLog.meta.specialHeaders.host, false);
  assert.equal(headerLog.meta.specialHeaders['content-length'], false);
  assert.equal(headerLog.meta.specialHeaders['transfer-encoding'], false);
  tunnel.abortAll('connection_closed');
});

test('ungültige Headernamen und Headerwerte werden vor lokalem Request abgelehnt', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });

  start(tunnel, socket, { headers: [[undefined, 'x']] });
  start(tunnel, socket, { requestId: 'req_2', headers: [[null, 'x']] });
  start(tunnel, socket, { requestId: 'req_3', headers: [['', 'x']] });
  start(tunnel, socket, { requestId: 'req_4', headers: [['x-test', undefined]] });
  start(tunnel, socket, { requestId: 'req_5', headers: [['x-test', null]] });
  start(tunnel, socket, { requestId: 'req_6', headers: [['x-test', 1]] });
  start(tunnel, socket, { requestId: 'req_7', headers: [['x-test', 'a\r\nb']] });

  assert.equal(h.requests.length, 0);
  assert.equal(tunnel.activeCount(), 0);
});

test('lokaler Origin-Request für /messen-schalten bleibt semantisch ein normaler GET', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    received = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      rawHeaders: req.rawHeaders,
    };
    req.resume();
    res.statusCode = 302;
    res.setHeader('Location', '/');
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const socket = makeSocket();
    const port = server.address().port;
    const tunnel = createOriginTunnel({ localPort: port, logger: () => {} });
    start(tunnel, socket, {
      path: '/messen-schalten',
      headers: [
        ['host', '127.0.0.1:12345'],
        ['connection', 'upgrade'],
        ['transfer-encoding', 'chunked'],
        ['content-length', '4'],
        ['accept', 'text/html'],
      ],
    });
    tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
    await waitFor(() => socket.sent.some((m) => m.type === 'tunnel_response_end'));

    assert.equal(socket.sent[0].type, 'tunnel_response_start');
    assert.equal(socket.sent[0].status, 302);
    assert.ok(socket.sent[0].headers.some(([name, value]) => name === 'location' && value === '/'));
    assert.equal(received.method, 'GET');
    assert.equal(received.url, '/messen-schalten');
    assert.equal(received.headers.host, `127.0.0.1:${port}`);
    assert.equal(received.headers.host === '127.0.0.1:12345', false);
    assert.equal(received.headers['content-length'], undefined);
    assert.equal(received.headers['transfer-encoding'], undefined);
    assert.equal(received.headers.upgrade, undefined);
    assert.equal(received.headers.te, undefined);
    assert.equal(received.headers.trailer, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Backpressure bricht kontrolliert ab statt eine eigene Queue aufzubauen', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {}, maxBufferedAmount: 4 });
  start(tunnel, socket);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  socket.bufferedAmount = 5;
  h.requests[0].respond(200, [], ['x']);
  await tick();

  assert.equal(h.requests[0].destroyed, true);
  assert.deepEqual(socket.sent, [{ type: 'tunnel_cancel', requestId: 'req_1', reason: 'origin_cancelled' }]);
  assert.equal(tunnel.activeCount(), 0);
});

test('keine Wiederverwendung aktiver requestId', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({ requestImpl: h.requestImpl, logger: () => {} });
  start(tunnel, socket, { requestId: 'req_same', hasBody: true });
  start(tunnel, socket, { requestId: 'req_same' });

  assert.equal(h.requests.length, 1);
  assert.equal(tunnel.activeCount(), 1);
  tunnel.abortAll('connection_closed');
  assert.equal(tunnel.activeCount(), 0);
});

test('Request bleibt nach 100 ms ohne end aktiv, wenn die Frist größer ist', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: logs.logger,
    requestTimeoutMs: 2000,
    idleTimeoutMs: 2000,
  });
  start(tunnel, socket, { hasBody: true });
  await sleep(120);

  assert.equal(tunnel.activeCount(), 1);
  assert.deepEqual(socket.sent, []);
  assert.equal(logs.entries.find((e) => e.message === 'Tunnel-Request-Kontext angelegt').meta.requestTimerDelayMs, 2000);
  assert.equal(logs.entries.find((e) => e.message === 'Tunnel-Request-Kontext angelegt').meta.idleTimerDelayMs, 2000);
  tunnel.abortAll('connection_closed');
});

test('start und end im Abstand von 50 ms führen zum lokalen Origin-Aufruf', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: () => {},
    requestTimeoutMs: 2000,
    idleTimeoutMs: 2000,
  });
  start(tunnel, socket);
  await sleep(50);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);

  assert.equal(h.requests.length, 1);
  await tick();
  assert.equal(h.requests[0].ended, true);
  tunnel.abortAll('connection_closed');
});

test('vollständiger Request-Timeout tritt erst nach der konfigurierten Dauer ein', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: logs.logger,
    requestTimeoutMs: 1000,
    idleTimeoutMs: 5000,
  });
  start(tunnel, socket, { hasBody: true });
  await sleep(250);
  assert.equal(tunnel.activeCount(), 1);
  assert.deepEqual(socket.sent, []);

  await sleep(900);
  assert.equal(tunnel.activeCount(), 0);
  assert.deepEqual(socket.sent, [{ type: 'tunnel_cancel', requestId: 'req_1', reason: 'origin_cancelled' }]);
  const abortLog = logs.entries.find((e) => e.message === 'Tunnel-Request abgebrochen');
  assert.equal(abortLog.meta.reason, 'request_timeout');
  assert.equal(abortLog.meta.timerKind, 'request_timeout');
  assert.ok(abortLog.meta.durationMs >= 1000);
});

test('Sekunden-/Millisekunden-Verwechslung wird durch Mindestdauer erkannt', () => {
  assert.throws(
    () => createOriginTunnel({ requestImpl: () => {}, logger: () => {}, requestTimeoutMs: 2 }),
    /invalid_requestTimeoutMs/,
  );
});

test('absolute Deadline wird nicht als relative Timeout-Dauer verwendet', () => {
  assert.throws(
    () => createOriginTunnel({ requestImpl: () => {}, logger: () => {}, requestTimeoutMs: Date.now() + 5000 }),
    /invalid_requestTimeoutMs/,
  );
});

test('NaN, 0, negativer und fehlender Timeout-Konfigurationswert werden korrekt behandelt', async () => {
  for (const requestTimeoutMs of [Number.NaN, 0, -1]) {
    assert.throws(
      () => createOriginTunnel({ requestImpl: () => {}, logger: () => {}, requestTimeoutMs }),
      /invalid_requestTimeoutMs/,
    );
  }

  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: logs.logger,
    requestTimeoutMs: undefined,
    idleTimeoutMs: undefined,
  });
  start(tunnel, socket, { hasBody: true });
  await sleep(120);

  assert.equal(tunnel.activeCount(), 1);
  assert.deepEqual(socket.sent, []);
  const contextLog = logs.entries.find((e) => e.message === 'Tunnel-Request-Kontext angelegt');
  assert.equal(contextLog.meta.requestTimeoutMs, 120000);
  assert.equal(contextLog.meta.idleTimeoutMs, 30000);
  tunnel.abortAll('connection_closed');
});

test('Timer-Callback wird nicht synchron bei Kontextanlage ausgeführt', () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: () => {},
    requestTimeoutMs: 1000,
    idleTimeoutMs: 1000,
  });
  start(tunnel, socket, { hasBody: true });

  assert.equal(tunnel.activeCount(), 1);
  assert.equal(socket.sent.some((m) => m.type === 'tunnel_cancel'), false);
  tunnel.abortAll('connection_closed');
});

test('Idle-Timeout und vollständiger Request-Timeout sind getrennt', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const logs = captureLogger();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: logs.logger,
    requestTimeoutMs: 5000,
    idleTimeoutMs: 1000,
  });
  start(tunnel, socket, { hasBody: true });
  await sleep(1150);

  assert.equal(tunnel.activeCount(), 0);
  const abortLog = logs.entries.find((e) => e.message === 'Tunnel-Request abgebrochen');
  assert.equal(abortLog.meta.reason, 'idle_timeout');
  assert.equal(abortLog.meta.timerKind, 'idle_timeout');
});

test('nach normalem end wird der vollständige Request-Timer entfernt', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: () => {},
    requestTimeoutMs: 1000,
    idleTimeoutMs: 5000,
  });
  start(tunnel, socket);
  await sleep(50);
  tunnel.handleMessage({ type: 'tunnel_request_end', requestId: 'req_1' }, socket);
  h.requests[0].openResponse(200, [['content-type', 'text/event-stream']]);
  await sleep(1100);

  assert.equal(tunnel.activeCount(), 1);
  assert.equal(socket.sent.some((m) => m.type === 'tunnel_cancel'), false);
  tunnel.abortAll('connection_closed');
});

test('nach Timeout wird genau ein tunnel_cancel gesendet', async () => {
  const socket = makeSocket();
  const h = makeRequestHarness();
  const tunnel = createOriginTunnel({
    requestImpl: h.requestImpl,
    logger: () => {},
    requestTimeoutMs: 1000,
    idleTimeoutMs: 5000,
  });
  start(tunnel, socket, { hasBody: true });
  await sleep(1150);

  assert.deepEqual(socket.sent, [{ type: 'tunnel_cancel', requestId: 'req_1', reason: 'origin_cancelled' }]);
  assert.equal(tunnel.activeCount(), 0);
});
