'use strict';

// Audio Bus: WebSocket-Endpunkt mit States-API-Anmeldung, Sessions,
// Input/Output-Routing, Plugin-API (intern und über Adapter-IPC), Grenzen und
// Aufräumen.

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-audio-bus-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const childProcess = require('child_process');
const express = require('express');
const WebSocket = require('ws');

const { openDatabase } = require('../src/db');
const statesApiRoutes = require('../src/routes/states-api');
const apiConfig = require('../src/states-api/config');
const tokens = require('../src/states-api/tokens');
const rateLimit = require('../src/states-api/rate-limit');
const apiAuth = require('../src/states-api/auth');
const { createAudioBus } = require('../src/audio-bus/bus');
const { createAudioWsServer, AUDIO_WS_PATH } = require('../src/audio-bus/ws-server');
const adapterBridge = require('../src/audio-bus/adapter-bridge');
const formats = require('../src/audio-bus/formats');

const PASSWORD = 'audio-geheim-123';
const FRAME_LIMIT = 1024;
const MAX_PAYLOAD = 4096;

const silentLogger = { info() {}, warn() {}, error() {} };

let db;
let server;
let baseUrl;
let wsUrl;
let bus;
let wsServer;

const START = Object.freeze({
  type: 'audio.start',
  device_id: 'widgetbar-test-pc',
  source: 'widgetbar',
  room: 'buero',
  codec: 'pcm_s16le',
  sample_rate: 16000,
  channels: 1,
});

// ── Hilfen ────────────────────────────────────────────────────────────────

async function login() {
  const response = await fetch(`${baseUrl}/api/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

function waitUntil(predicate, timeoutMs = 2000, label = 'Bedingung') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        return reject(error);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Zeitüberschreitung: ${label}`));
      return setTimeout(tick, 5);
    };
    tick();
  });
}

// WebSocket-Client, der Control-Messages und Binärframes getrennt sammelt.
function connect(token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ws = new WebSocket(wsUrl, { headers });
    const client = { ws, messages: [], binaries: [], closed: null };
    ws.on('message', (data, isBinary) => {
      if (isBinary) client.binaries.push(Buffer.from(data));
      else client.messages.push(JSON.parse(data.toString('utf8')));
    });
    ws.on('close', (code, reason) => { client.closed = { code, reason: reason.toString() }; });
    ws.on('open', () => resolve(client));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const error = new Error(`Upgrade abgewiesen (${res.statusCode})`);
        error.status = res.statusCode;
        error.headers = res.headers;
        try {
          error.body = JSON.parse(body);
        } catch (_) {
          error.body = body;
        }
        reject(error);
      });
    });
    ws.on('error', (error) => { if (!error.status) reject(error); });
  });
}

// Nächste Control-Message des Typs (entnimmt sie aus der Liste).
async function next(client, type, timeoutMs = 2000) {
  const index = await waitUntil(() => {
    const found = client.messages.findIndex((message) => message.type === type);
    return found >= 0 ? found + 1 : 0;
  }, timeoutMs, `Nachricht ${type}`);
  return client.messages.splice(index - 1, 1)[0];
}

function sendJson(client, message) {
  client.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
}

async function startSession(client, overrides = {}) {
  sendJson(client, { ...START, ...overrides });
  const started = await next(client, 'audio.started');
  return started.session_id;
}

function pcm(bytes, fill = 1) {
  return Buffer.alloc(bytes, fill);
}

async function closeClient(client) {
  if (client.ws.readyState === WebSocket.CLOSED) return;
  client.ws.close();
  await waitUntil(() => client.closed, 2000, 'close');
}

function fakeTransport() {
  const transport = {
    controls: [],
    binaries: [],
    ended: [],
    open: true,
    buffered: 0,
    sendControl: (message) => transport.controls.push(message),
    sendBinary: (buffer) => transport.binaries.push(buffer),
    bufferedAmount: () => transport.buffered,
    isOpen: () => transport.open,
    sessionEnded: (session, reason) => transport.ended.push({ session, reason }),
  };
  return transport;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── Aufbau ────────────────────────────────────────────────────────────────

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await apiConfig.init(db);
  await apiConfig.savePassword(db, PASSWORD, PASSWORD);
  await apiConfig.saveEnabled(db, true);

  bus = createAudioBus({ logger: silentLogger, limits: { maxSessions: 8, maxInputFrameBytes: FRAME_LIMIT } });
  wsServer = createAudioWsServer({
    bus,
    logger: silentLogger,
    options: { authCheckMs: 50, heartbeatMs: 60000, maxPayloadBytes: MAX_PAYLOAD, maxProtocolErrors: 8 },
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(statesApiRoutes(db));
  app.use(statesApiRoutes.errorHandler);
  server = http.createServer(app);
  wsServer.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}${AUDIO_WS_PATH}`;
});

test.after(async () => {
  wsServer.shutdown();
  bus.shutdown();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test.beforeEach(() => {
  rateLimit.reset();
});

// ── 1. Authentifizierter Zugriff ─────────────────────────────────────────

test('1. Mit dem Bearer-Token der States API wird die WebSocket-Verbindung angenommen', async () => {
  const token = await login();
  const client = await connect(token);
  const ready = await next(client, 'audio.ready');
  assert.equal(ready.protocol, 1);
  assert.equal(ready.max_frame_bytes, FRAME_LIMIT);
  assert.ok(ready.codecs.pcm_s16le.sample_rates.includes(16000));
  await closeClient(client);
});

// ── 2. Ablehnung ohne gültige Credentials ────────────────────────────────

test('2. Ohne gültiges States-API-Token wird der Upgrade vor jeder Session abgewiesen', async () => {
  await assert.rejects(connect(null), (error) => error.status === 401 && error.body.error === 'unauthorized');
  await assert.rejects(connect('A'.repeat(43)), (error) => error.status === 401 && error.body.error === 'token_invalid');
  await assert.rejects(connect(null, { Authorization: `Basic ${Buffer.from(`x:${PASSWORD}`).toString('base64')}` }),
    (error) => error.status === 401);
  // Das API-Passwort selbst ist kein Token.
  await assert.rejects(connect(PASSWORD), (error) => error.status === 401);
  // Token im Query-Parameter wird wie bei der States API nicht akzeptiert.
  const token = await login();
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    ws.on('open', resolve);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('abgewiesen'), { status: res.statusCode })));
    ws.on('error', () => {});
  }), (error) => error.status === 401);
  assert.equal(bus.listSessions().length, 0);
});

test('2b. Abgelaufene Tokens und abgeschaltete API werden abgewiesen', async () => {
  const expired = tokens.issue(apiConfig.get().credentialVersion, Date.now() - tokens.TOKEN_TTL_MS - 1000);
  await assert.rejects(connect(expired.token), (error) => error.status === 401 && error.body.error === 'token_expired');

  const token = await login();
  await apiConfig.saveEnabled(db, false);
  try {
    await assert.rejects(connect(token), (error) => error.status === 403 && error.body.error === 'api_disabled');
  } finally {
    await apiConfig.saveEnabled(db, true);
  }
});

test('2c. Verlorene Anmeldung (Logout) beendet Session und Verbindung', async () => {
  const token = await login();
  const client = await connect(token);
  const plugin = bus.createClient('auth-test');
  const ended = [];
  plugin.onSessionEnded((session, reason) => { ended.push({ session, reason }); });
  try {
    const sessionId = await startSession(client);
    tokens.revoke(token);
    const error = await next(client, 'audio.error');
    assert.equal(error.code, 'token_invalid');
    await waitUntil(() => client.closed, 2000, 'close');
    assert.equal(client.closed.code, 4401);
    await waitUntil(() => ended.length, 2000, 'Session-Ende');
    assert.equal(ended[0].session.sessionId, sessionId);
    assert.equal(ended[0].reason, 'auth_lost');
    assert.equal(bus.getSession(sessionId), null);
  } finally {
    plugin.close();
  }
});

test('2d. Passwortänderung macht offene Audio-Verbindungen ungültig', async () => {
  const token = await login();
  const client = await connect(token);
  await startSession(client);
  const changed = `${PASSWORD}-neu`;
  await apiConfig.savePassword(db, changed, changed);
  try {
    await waitUntil(() => client.closed, 2000, 'close');
    assert.equal(client.closed.code, 4401);
  } finally {
    await apiConfig.savePassword(db, PASSWORD, PASSWORD);
  }
});

// ── 3./4. Session-Erstellung, eindeutige IDs ─────────────────────────────

test('3. audio.start erzeugt serverseitig eine Session mit Metadaten und authentifizierter Identität', async () => {
  const token = await login();
  const client = await connect(token);
  const plugin = bus.createClient('meta-test');
  const started = [];
  plugin.onSessionStarted((session) => { started.push(session); });
  try {
    // Clientangaben dürfen die Identität nicht überschreiben – weder als
    // Top-Level-Feld noch als Metadatum; eine vorgegebene session_id zählt nicht.
    const sessionId = await startSession(client, {
      session_id: '00000000-0000-4000-8000-000000000000',
      client: { type: 'internal', id: 'admin' },
      metadata: { client: 'gefaelscht', wake_word: 'hey homeess', gain: 3 },
    });
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(sessionId, '00000000-0000-4000-8000-000000000000');
    await waitUntil(() => started.length, 2000, 'started');
    const session = started[0];
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.deviceId, 'widgetbar-test-pc');
    assert.equal(session.source, 'widgetbar');
    assert.equal(session.room, 'buero');
    assert.equal(session.codec, 'pcm_s16le');
    assert.equal(session.sampleRate, 16000);
    assert.equal(session.channels, 1);
    assert.equal(session.status, 'active');
    assert.equal(session.client.type, 'states-api');
    assert.equal(session.client.id, apiAuth.tokenId(token));
    assert.ok(!JSON.stringify(session).includes(token), 'Token darf nicht in der Session stehen');
    assert.deepEqual({ ...session.metadata }, { client: 'gefaelscht', wake_word: 'hey homeess', gain: 3 });
    assert.ok(Number.isFinite(session.createdAt));
    assert.equal(session.lastInputAt, null);
    assert.ok(Object.isFrozen(session));
    assert.deepEqual(bus.getSession(sessionId).deviceId, 'widgetbar-test-pc');
  } finally {
    plugin.close();
    await closeClient(client);
  }
});

test('4. Session-IDs sind eindeutig', async () => {
  const token = await login();
  const clients = [];
  const ids = new Set();
  try {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const client = await connect(token);
      clients.push(client);
      // eslint-disable-next-line no-await-in-loop
      ids.add(await startSession(client, { device_id: `geraet-${i}` }));
    }
    assert.equal(ids.size, 5);
    // Nacheinander auf derselben Verbindung ebenfalls neue IDs.
    const first = [...ids][0];
    sendJson(clients[0], { type: 'audio.end', session_id: first });
    await next(clients[0], 'audio.ended');
    const again = await startSession(clients[0]);
    assert.ok(!ids.has(again));
  } finally {
    await Promise.all(clients.map(closeClient));
  }
});

// ── 5./6. Binärer Input und Weiterleitung an Plugins ────────────────────

test('5./6. Binäre Audio-Frames erreichen alle Input-Abonnenten mit Session-Kontext', async () => {
  const token = await login();
  const client = await connect(token);
  const pluginA = bus.createClient('input-a');
  const pluginB = bus.createClient('input-b');
  const receivedA = [];
  const receivedB = [];
  pluginA.onInput((session, chunk, info) => { receivedA.push({ session, chunk, info }); });
  pluginB.onInput(async (session, chunk) => { receivedB.push({ session, chunk }); });
  try {
    const sessionId = await startSession(client);
    const frames = [pcm(320, 1), pcm(640, 2), pcm(2, 3)];
    for (const frame of frames) client.ws.send(frame);
    await waitUntil(() => receivedA.length === 3 && receivedB.length === 3, 2000, 'Input');
    receivedA.forEach((entry, index) => {
      assert.equal(entry.session.sessionId, sessionId);
      assert.equal(entry.session.room, 'buero');
      assert.equal(entry.session.deviceId, 'widgetbar-test-pc');
      assert.ok(Buffer.isBuffer(entry.chunk));
      assert.ok(entry.chunk.equals(frames[index]));
      assert.equal(entry.info.seq, index + 1);
      assert.equal(entry.info.droppedBefore, 0);
    });
    assert.ok(receivedB.every((entry, index) => entry.chunk.equals(frames[index])));
    assert.ok(bus.getSession(sessionId).lastInputAt >= bus.getSession(sessionId).createdAt);
    // Audio läuft nie als JSON zurück an den Client.
    assert.equal(client.messages.filter((message) => message.type === 'audio.error').length, 0);
  } finally {
    pluginA.close();
    pluginB.close();
    await closeClient(client);
  }
});

// ── 7./8. Output eines Plugins, Routing zum richtigen Client ────────────

test('7./8. Plugin-Output geht nur an den Client der Ziel-Session', async () => {
  const token = await login();
  const clientA = await connect(token);
  const clientB = await connect(token);
  const plugin = bus.createClient('output');
  try {
    const sessionA = await startSession(clientA, { device_id: 'geraet-a', room: 'kueche' });
    await startSession(clientB, { device_id: 'geraet-b' });

    const output = plugin.startOutput(sessionA, { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 });
    assert.equal(output.sampleRate, 24000);
    const start = await next(clientA, 'audio.output.start');
    assert.deepEqual(start, { type: 'audio.output.start', session_id: sessionA, codec: 'pcm_s16le', sample_rate: 24000, channels: 1 });
    assert.equal(bus.getSession(sessionA).output.owner, 'output');
    assert.equal(bus.status().outputStreams, 1);

    const chunks = [pcm(480, 7), pcm(960, 8)];
    for (const chunk of chunks) plugin.sendAudio(sessionA, chunk);
    await waitUntil(() => clientA.binaries.length === 2, 2000, 'Output-Chunks');
    assert.ok(clientA.binaries[0].equals(chunks[0]));
    assert.ok(clientA.binaries[1].equals(chunks[1]));

    plugin.endOutput(sessionA);
    await next(clientA, 'audio.output.end');
    assert.equal(bus.status().outputStreams, 0);

    // Kurz warten: B darf weder Steuerereignisse noch Audio erhalten haben.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(clientB.binaries.length, 0);
    assert.ok(!clientB.messages.some((message) => String(message.type).startsWith('audio.output')));

    // Nach endOutput ist Senden ohne neuen Start ein Fehler.
    assert.throws(() => plugin.sendAudio(sessionA, pcm(2)), (error) => error.code === 'output_not_started');
    // Ungültige Formate/Chunks werden abgewiesen.
    assert.throws(() => plugin.startOutput(sessionA, { codec: 'mp3', sampleRate: 24000, channels: 1 }), (error) => error.code === 'unsupported_codec');
    plugin.startOutput(sessionA, { codec: 'pcm_s16le', sampleRate: 16000, channels: 2 });
    await next(clientA, 'audio.output.start');
    assert.throws(() => plugin.sendAudio(sessionA, pcm(6)), (error) => error.code === 'invalid_chunk');
    assert.throws(() => plugin.sendAudio(sessionA, pcm(bus.limits.maxOutputChunkBytes + 4)), (error) => error.code === 'chunk_too_large');
  } finally {
    plugin.close();
    await Promise.all([closeClient(clientA), closeClient(clientB)]);
  }
});

// ── 9. Parallele Sessions ────────────────────────────────────────────────

test('9. Parallele Sessions werden getrennt geroutet', async () => {
  const token = await login();
  const clients = await Promise.all([connect(token), connect(token), connect(token)]);
  const plugin = bus.createClient('parallel');
  const bySession = new Map();
  plugin.onInput((session, chunk) => {
    if (!bySession.has(session.sessionId)) bySession.set(session.sessionId, []);
    bySession.get(session.sessionId).push(chunk[0]);
  });
  try {
    const ids = await Promise.all(clients.map((client, index) => startSession(client, { device_id: `parallel-${index}` })));
    for (let round = 0; round < 10; round += 1) {
      clients.forEach((client, index) => client.ws.send(pcm(64, index + 1)));
    }
    await waitUntil(() => ids.every((id) => (bySession.get(id) || []).length === 10), 3000, 'parallele Frames');
    ids.forEach((id, index) => {
      assert.ok(bySession.get(id).every((value) => value === index + 1), `Session ${index} bekam fremde Daten`);
    });
    assert.equal(bus.status().sessions, 3);
    assert.equal(bus.status().inputSubscribers, 1);
    // Output an Session 2 erreicht nur Client 2.
    plugin.startOutput(ids[1], { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
    plugin.sendAudio(ids[1], pcm(32, 9));
    await waitUntil(() => clients[1].binaries.length === 1, 2000, 'Output');
    assert.equal(clients[0].binaries.length + clients[2].binaries.length, 0);
  } finally {
    plugin.close();
    await Promise.all(clients.map(closeClient));
  }
});

// ── 10. Cleanup bei audio.end ────────────────────────────────────────────

test('10. audio.end beendet die Session, bestätigt und informiert Plugins', async () => {
  const token = await login();
  const client = await connect(token);
  const plugin = bus.createClient('end');
  const events = [];
  plugin.onInput(() => { events.push('input'); });
  plugin.onSessionEnded((session, reason) => { events.push(`ended:${reason}:${session.status}`); });
  try {
    const sessionId = await startSession(client);
    plugin.startOutput(sessionId, { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
    client.ws.send(pcm(32));
    sendJson(client, { type: 'audio.end', session_id: sessionId });
    const ended = await next(client, 'audio.ended');
    assert.deepEqual(ended, { type: 'audio.ended', session_id: sessionId, reason: 'client_end' });
    // Laufender Output wird vor dem Session-Ende geschlossen.
    const outputEnd = await next(client, 'audio.output.end');
    assert.equal(outputEnd.session_id, sessionId);
    await waitUntil(() => events.length === 2, 2000, 'Plugin-Ereignisse');
    // Input vor Ende bleibt vor dem Ende-Ereignis.
    assert.deepEqual(events, ['input', 'ended:client_end:ended']);
    assert.equal(bus.getSession(sessionId), null);
    assert.throws(() => plugin.sendAudio(sessionId, pcm(2)), (error) => error.code === 'session_not_found');
    // Danach gehören Binärframes zu keiner Session mehr.
    client.ws.send(pcm(32));
    const error = await next(client, 'audio.error');
    assert.equal(error.code, 'no_active_session');
    assert.equal(client.ws.readyState, WebSocket.OPEN);
  } finally {
    plugin.close();
    await closeClient(client);
  }
});

// ── 11. Cleanup bei Verbindungsabbruch ───────────────────────────────────

test('11. Verbindungsabbruch und Client-Absturz beenden die Session', async () => {
  const token = await login();
  const plugin = bus.createClient('disconnect');
  const ended = [];
  plugin.onSessionEnded((session, reason) => { ended.push({ id: session.sessionId, reason }); });
  try {
    const orderly = await connect(token);
    const orderlyId = await startSession(orderly);
    orderly.ws.close();
    const crashed = await connect(token);
    const crashedId = await startSession(crashed);
    crashed.ws.terminate(); // Abbruch ohne Close-Handshake
    await waitUntil(() => ended.length === 2, 3000, 'Session-Enden');
    assert.deepEqual(ended.map((entry) => entry.id).sort(), [orderlyId, crashedId].sort());
    assert.ok(ended.every((entry) => entry.reason === 'disconnect'));
    assert.equal(bus.getSession(orderlyId), null);
    assert.equal(bus.getSession(crashedId), null);
    await waitUntil(() => wsServer.status().connections === 0, 2000, 'Verbindungen');
  } finally {
    plugin.close();
  }
});

test('11b. Heartbeat trennt Clients, die nicht mehr antworten', async () => {
  const localBus = createAudioBus({ logger: silentLogger });
  const localWs = createAudioWsServer({ bus: localBus, logger: silentLogger, options: { heartbeatMs: 40 } });
  const localServer = http.createServer();
  localWs.attach(localServer);
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const token = await login();
  const ws = new WebSocket(`ws://127.0.0.1:${localServer.address().port}${AUDIO_WS_PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
    autoPong: false,
  });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify(START));
  await waitUntil(() => messages.some((message) => message.type === 'audio.started'), 2000, 'started');
  let closed = false;
  ws.on('close', () => { closed = true; });
  await waitUntil(() => closed, 2000, 'Heartbeat-Abbruch');
  assert.equal(localBus.status().sessions, 0);
  localWs.shutdown();
  localBus.shutdown();
  await new Promise((resolve) => localServer.close(resolve));
});

// ── 12. Ungültige Control-Messages ───────────────────────────────────────

test('12. Ungültige Control-Messages werden abgewiesen, ohne eine Session anzulegen', async () => {
  const token = await login();
  let client = await connect(token);
  try {
    const cases = [
      ['{kein json', 'invalid_json'],
      ['[1,2]', 'invalid_message'],
      [{ type: 'audio.unbekannt' }, 'unknown_type'],
      [{ type: 'audio.output.start', session_id: 'x' }, 'unknown_type'],
      [{ ...START, device_id: undefined }, 'invalid_device_id'],
      [{ ...START, device_id: 'mit leerzeichen' }, 'invalid_device_id'],
      [{ ...START, source: '' }, 'invalid_source'],
      [{ ...START, room: 'a\u0000b' }, 'invalid_room'],
      [{ ...START, codec: 'opus' }, 'unsupported_codec'],
      [{ ...START, sample_rate: 12345 }, 'invalid_sample_rate'],
      [{ ...START, sample_rate: '16000' }, 'invalid_sample_rate'],
      [{ ...START, channels: 0 }, 'invalid_channels'],
      [{ ...START, metadata: { 'Böse Taste': 1 } }, 'invalid_metadata'],
      [{ type: 'audio.end' }, 'invalid_session_id'],
    ];
    for (const [index, [message, code]] of cases.entries()) {
      sendJson(client, message);
      // eslint-disable-next-line no-await-in-loop
      const error = await next(client, 'audio.error');
      assert.equal(error.code, code, JSON.stringify(message));
      // Nach einigen Fehlern trennt der Server; für die restlichen Fälle neu verbinden.
      if (index % 6 === 5) {
        // eslint-disable-next-line no-await-in-loop
        await closeClient(client);
        // eslint-disable-next-line no-await-in-loop
        client = await connect(token);
      }
    }
    assert.equal(bus.listSessions().length, 0);

    // Falsche Reihenfolge: Audio vor audio.start, doppeltes audio.start.
    const ordered = await connect(token);
    ordered.ws.send(pcm(32));
    assert.equal((await next(ordered, 'audio.error')).code, 'no_active_session');
    await startSession(ordered);
    sendJson(ordered, START);
    assert.equal((await next(ordered, 'audio.error')).code, 'session_active');
    assert.equal(bus.listSessions().length, 1);
    sendJson(ordered, { type: 'ping' });
    await next(ordered, 'pong');
    await closeClient(ordered);

    // Zu große Control-Message.
    const large = await connect(token);
    sendJson(large, { ...START, padding: 'x'.repeat(5000) });
    await waitUntil(() => large.closed, 2000, 'close wegen maxPayload');
    assert.equal(large.closed.code, 1009);
  } finally {
    await closeClient(client);
  }
});

test('12b. Dauerhafte Protokollverstöße trennen die Verbindung', async () => {
  const token = await login();
  const client = await connect(token);
  for (let i = 0; i < 12; i += 1) sendJson(client, { type: 'nix' });
  await waitUntil(() => client.closed, 2000, 'close');
  assert.equal(client.closed.code, 1008);
});

// ── 13. Zu große Audio-Frames ────────────────────────────────────────────

test('13. Zu große oder unvollständige Audio-Frames werden verworfen', async () => {
  const token = await login();
  const client = await connect(token);
  const plugin = bus.createClient('frames');
  const received = [];
  plugin.onInput((_session, chunk) => { received.push(chunk.length); });
  try {
    await startSession(client);
    client.ws.send(pcm(FRAME_LIMIT + 2));
    assert.equal((await next(client, 'audio.error')).code, 'frame_too_large');
    client.ws.send(pcm(33)); // kein ganzes 16-Bit-Sample
    assert.equal((await next(client, 'audio.error')).code, 'invalid_frame');
    client.ws.send(pcm(FRAME_LIMIT));
    await waitUntil(() => received.length === 1, 2000, 'gültiger Frame');
    assert.deepEqual(received, [FRAME_LIMIT]);
    assert.equal(client.ws.readyState, WebSocket.OPEN);

    // Über der harten WebSocket-Grenze schließt der Server die Verbindung.
    client.ws.send(pcm(MAX_PAYLOAD + 2));
    await waitUntil(() => client.closed, 2000, 'close');
    assert.equal(client.closed.code, 1009);
    await waitUntil(() => bus.listSessions().length === 0, 2000, 'Cleanup');
  } finally {
    plugin.close();
  }
});

// ── 14. Queue-Overflow ───────────────────────────────────────────────────

test('14. Ein langsames Plugin verliert Chunks, blockiert aber weder Empfang noch andere Plugins', async () => {
  const localBus = createAudioBus({ logger: silentLogger, limits: { queueMaxItems: 3, queueMaxBytes: 1024 * 1024 } });
  const transport = fakeTransport();
  const slow = localBus.createClient('langsam');
  const fast = localBus.createClient('schnell');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowReceived = [];
  const fastReceived = [];
  const ended = [];
  slow.onInput(async (_session, chunk, info) => {
    slowReceived.push({ value: chunk[0], info });
    await gate;
  });
  slow.onSessionEnded((_session, reason) => { ended.push(reason); });
  fast.onInput((_session, chunk) => { fastReceived.push(chunk[0]); });

  const opened = localBus.openSession(transport, { deviceId: 'd', source: 's', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
  assert.ok(opened.ok);
  const id = opened.session.sessionId;
  await tick();
  for (let i = 1; i <= 10; i += 1) {
    // pushInput kehrt sofort zurück, auch wenn ein Plugin hängt.
    assert.equal(localBus.pushInput(id, transport, Buffer.alloc(4, i)).ok, true);
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  await waitUntil(() => fastReceived.length === 10, 2000, 'schnelles Plugin');
  assert.deepEqual(fastReceived, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const status = localBus.status();
  assert.ok(status.counters.droppedChunks >= 6, `verworfen: ${status.counters.droppedChunks}`);
  assert.ok(status.queuedChunks <= 3);

  release();
  // Erst wenn die Queue abgearbeitet ist, ist wieder Platz.
  await waitUntil(() => slowReceived.length === 4, 2000, 'Queue abgearbeitet');
  localBus.pushInput(id, transport, Buffer.alloc(4, 11));
  localBus.endSession(id, 'client_end');
  await waitUntil(() => ended.length === 1, 2000, 'Ende trotz Overflow');
  // Die Lücke wird dem nächsten zugestellten Chunk mitgegeben.
  const last = slowReceived[slowReceived.length - 1];
  assert.equal(last.value, 11);
  assert.ok(last.info.droppedBefore >= 6);
  assert.ok(slowReceived.length <= 5);
  assert.deepEqual(ended, ['client_end']);
  localBus.shutdown();
});

test('14b. Byte-Limit der Queue und hängende Callbacks sind begrenzt', async () => {
  const localBus = createAudioBus({ logger: silentLogger, limits: { queueMaxItems: 100, queueMaxBytes: 100, handlerTimeoutMs: 30 } });
  const transport = fakeTransport();
  const plugin = localBus.createClient('haengt');
  const calls = [];
  plugin.onInput(() => { calls.push(1); return new Promise(() => {}); });
  const { session } = localBus.openSession(transport, { deviceId: 'd', source: 's', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
  for (let i = 0; i < 5; i += 1) localBus.pushInput(session.sessionId, transport, Buffer.alloc(40));
  // 100 Bytes Queue: nur zwei Chunks à 40 Bytes passen, der Rest wird verworfen.
  assert.equal(localBus.status().counters.droppedChunks, 3);
  // Nach dem Callback-Timeout läuft die Queue trotz hängendem Plugin weiter.
  await waitUntil(() => calls.length === 2, 2000, 'Timeout-Fortschritt');
  assert.ok(localBus.status().counters.subscriberErrors >= 1);
  localBus.shutdown();
});

test('14c. Output-Backpressure: staut sich der Client, wird Output abgewiesen', () => {
  const localBus = createAudioBus({ logger: silentLogger, limits: { outputBufferBytes: 100 } });
  const transport = fakeTransport();
  const plugin = localBus.createClient('tts');
  const { session } = localBus.openSession(transport, { deviceId: 'd', source: 's', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
  plugin.startOutput(session.sessionId, { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  plugin.sendAudio(session.sessionId, Buffer.alloc(50));
  transport.buffered = 80;
  assert.throws(() => plugin.sendAudio(session.sessionId, Buffer.alloc(50)), (error) => error.code === 'output_backpressure');
  assert.equal(transport.binaries.length, 1);
  assert.equal(localBus.status().counters.outputRejected, 1);
  localBus.shutdown();
});

// ── 15. Zugriff auf fremde Sessions ──────────────────────────────────────

test('15. Clients und Plugins können fremde Sessions nicht übernehmen', async () => {
  const token = await login();
  const owner = await connect(token);
  const intruder = await connect(token);
  const pluginA = bus.createClient('besitzer');
  const pluginB = bus.createClient('fremd');
  const received = [];
  pluginA.onInput((session, chunk) => { received.push({ id: session.sessionId, value: chunk[0] }); });
  try {
    const ownerId = await startSession(owner);
    const intruderId = await startSession(intruder, { device_id: 'eindringling' });

    // Fremde session_id in audio.end: abgewiesen, Session läuft weiter.
    sendJson(intruder, { type: 'audio.end', session_id: ownerId });
    assert.equal((await next(intruder, 'audio.error')).code, 'session_not_found');
    assert.equal(bus.getSession(ownerId).status, 'active');

    // Binärframes landen immer in der eigenen Session – nie in der fremden.
    intruder.ws.send(pcm(32, 5));
    await waitUntil(() => received.length === 1, 2000, 'Input');
    assert.deepEqual(received, [{ id: intruderId, value: 5 }]);

    // Direkter Bus-Zugriff mit fremdem Transport wird abgewiesen.
    const other = fakeTransport();
    assert.equal(bus.pushInput(ownerId, other, pcm(32)).code, 'session_not_found');
    assert.equal(bus.endSession(ownerId, 'client_end', { transport: other }), false);
    assert.equal(bus.getSession(ownerId).status, 'active');

    // Output: ein zweites Plugin kann einen laufenden Stream nicht übernehmen.
    pluginA.startOutput(ownerId, { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
    assert.throws(() => pluginB.startOutput(ownerId, { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }), (error) => error.code === 'output_busy');
    assert.throws(() => pluginB.sendAudio(ownerId, pcm(2)), (error) => error.code === 'output_busy');
    assert.throws(() => pluginB.endOutput(ownerId), (error) => error.code === 'output_busy');
    // Unbekannte Sessions.
    assert.throws(() => pluginB.startOutput('00000000-0000-4000-8000-000000000000', { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }),
      (error) => error.code === 'session_not_found');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(!intruder.messages.some((message) => message.type === 'audio.output.start'));
  } finally {
    pluginA.close();
    pluginB.close();
    await Promise.all([closeClient(owner), closeClient(intruder)]);
  }
});

// ── Grenzen, Timeouts, Shutdown ──────────────────────────────────────────

test('Maximale Sessionanzahl wird durchgesetzt', () => {
  const localBus = createAudioBus({ logger: silentLogger, limits: { maxSessions: 2 } });
  const params = { deviceId: 'd', source: 's', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 };
  assert.ok(localBus.openSession(fakeTransport(), params).ok);
  assert.ok(localBus.openSession(fakeTransport(), params).ok);
  assert.equal(localBus.openSession(fakeTransport(), params).code, 'too_many_sessions');
  localBus.shutdown();
});

test('Idle- und Session-Timeout beenden Sessions und informieren Client und Plugins', async () => {
  let clock = 1000000;
  const localBus = createAudioBus({ logger: silentLogger, now: () => clock, limits: { idleTimeoutMs: 1000, maxSessionMs: 5000 } });
  const plugin = localBus.createClient('timeouts');
  const ended = [];
  plugin.onSessionEnded((session, reason) => { ended.push(reason); });
  const params = { deviceId: 'd', source: 's', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 };
  const idle = fakeTransport();
  const busy = fakeTransport();
  const idleSession = localBus.openSession(idle, params).session.sessionId;
  const busySession = localBus.openSession(busy, params).session.sessionId;
  for (let step = 0; step < 6; step += 1) {
    clock += 900;
    localBus.pushInput(busySession, busy, Buffer.alloc(2));
    localBus._sweep();
  }
  assert.equal(idle.ended[0].reason, 'idle_timeout');
  assert.equal(busy.ended[0].reason, 'session_timeout');
  assert.equal(localBus.getSession(idleSession), null);
  await waitUntil(() => ended.length === 2, 2000, 'Plugin-Ende');
  assert.deepEqual(ended.sort(), ['idle_timeout', 'session_timeout']);
  localBus.shutdown();
});

test('Server-Shutdown beendet alle Sessions sauber', async () => {
  const localBus = createAudioBus({ logger: silentLogger });
  const localWs = createAudioWsServer({ bus: localBus, logger: silentLogger });
  const localServer = http.createServer();
  localWs.attach(localServer);
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const plugin = localBus.createClient('shutdown');
  const ended = [];
  plugin.onSessionEnded((_session, reason) => { ended.push(reason); });
  const token = await login();
  const ws = new WebSocket(`ws://127.0.0.1:${localServer.address().port}${AUDIO_WS_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  const messages = [];
  let closeCode = null;
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  ws.on('close', (code) => { closeCode = code; });
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify(START));
  await waitUntil(() => messages.some((message) => message.type === 'audio.started'), 2000, 'started');
  localWs.shutdown();
  localBus.shutdown();
  await waitUntil(() => closeCode !== null, 2000, 'close');
  assert.equal(closeCode, 1001);
  assert.ok(messages.some((message) => message.type === 'audio.ended' && message.reason === 'server_shutdown'));
  await waitUntil(() => ended.length === 1, 2000, 'Plugin-Ende');
  assert.deepEqual(ended, ['server_shutdown']);
  assert.equal(localBus.status().active, false);
  await new Promise((resolve) => localServer.close(resolve));
});

test('Unbekannte Upgrade-Pfade und HTTP-Aufrufe ohne Upgrade', async () => {
  const response = await fetch(`${baseUrl}${AUDIO_WS_PATH}`);
  assert.equal(response.status, 426);
  assert.equal((await response.json()).error, 'upgrade_required');
  const token = await login();
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/v1/anderes`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', resolve);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('abgewiesen'), { status: res.statusCode })));
    ws.on('error', () => {});
  }), (error) => error.status === 404);
});

test('Status enthält nur Kennzahlen, keine Sessioninhalte', async () => {
  const token = await login();
  const client = await connect(token);
  try {
    await startSession(client, { device_id: 'geheimes-geraet', room: 'Schlafzimmer' });
    const text = JSON.stringify(bus.status());
    assert.ok(!text.includes('geheimes-geraet'));
    assert.ok(!text.includes('Schlafzimmer'));
    assert.equal(bus.status().sessions, 1);
    assert.equal(wsServer.status().connections >= 1, true);
  } finally {
    await closeClient(client);
  }
});

test('Formatbeschreibung: Codec, Samplerate und Kanäle', () => {
  assert.ok(formats.validateFormat({ codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }).ok);
  assert.ok(formats.validateFormat({ codec: 'pcm_s16le', sampleRate: 48000, channels: 2 }).ok);
  assert.equal(formats.validateFormat({ codec: 'opus', sampleRate: 48000, channels: 1 }).code, 'unsupported_codec');
  assert.equal(formats.frameAlignment({ codec: 'pcm_s16le', sampleRate: 16000, channels: 2 }), 4);
  assert.equal(formats.isAlignedFrame({ codec: 'pcm_s16le', sampleRate: 16000, channels: 2 }, 6), false);
});

// ── Adapter-Plugins über IPC ─────────────────────────────────────────────

test('Adapter ohne Manifest-Freigabe erhalten keinen Audio-Bus-Zugriff', () => {
  const sent = [];
  const entry = {
    manifest: { prefix: 'ohne', audioBus: false },
    instance: { name: 'x' },
    child: { send: (message) => sent.push(message) },
    audio: null,
  };
  assert.equal(adapterBridge.handleMessage(entry, { type: 'audio-subscribe', kinds: ['input'] }, bus), true);
  assert.equal(adapterBridge.handleMessage(entry, { type: 'audio-call', requestId: '1', method: 'listSessions' }, bus), true);
  assert.equal(sent[0].code, 'audio_not_permitted');
  assert.equal(entry.audio, null);
  // Andere Nachrichten bleiben unberührt.
  assert.equal(adapterBridge.handleMessage(entry, { type: 'value', address: 'a', value: 1 }, bus), false);
});

test('Adapter-Plugin (echter Kindprozess): Input per IPC, Echo als Output zum Client', async () => {
  const adapterDir = fs.mkdtempSync(path.join(TMP, 'echo-adapter-'));
  const mainPath = path.join(adapterDir, 'main.js');
  fs.writeFileSync(mainPath, `'use strict';
module.exports = (host) => ({
  start() {
    host.audio.onSessionStarted(async (session) => {
      await host.audio.startOutput(session.sessionId, { codec: 'pcm_s16le', sampleRate: 24000, channels: 1 });
    });
    host.audio.onInput(async (session, chunk, info) => {
      if (!Buffer.isBuffer(chunk)) throw new Error('kein Buffer');
      const listed = await host.audio.listSessions();
      if (!listed.some((entry) => entry.sessionId === session.sessionId)) throw new Error('Session fehlt');
      await host.audio.sendAudio(session.sessionId, chunk);
      if (info.seq === 2) await host.audio.endOutput(session.sessionId);
    });
  },
});
`);
  const runtimePath = path.join(__dirname, '..', 'src', 'adapters', 'runtime.js');
  const child = childProcess.fork(runtimePath, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const entry = { manifest: { prefix: 'echo', audioBus: true }, instance: { name: 'echo1' }, child, audio: null };
  const logs = [];
  let ready = false;
  child.on('message', (message) => {
    if (adapterBridge.handleMessage(entry, message, bus)) return;
    if (message.type === 'ready') ready = true;
    if (message.type === 'log' || message.type === 'error') logs.push(message.message);
  });
  child.send({ type: 'init', mainPath, name: 'echo1', config: {}, translations: {}, audioBus: true });
  const token = await login();
  let client;
  try {
    await waitUntil(() => ready && entry.audio && entry.audio.unsubscribe.size === 2, 5000, 'Adapter bereit');
    client = await connect(token);
    const sessionId = await startSession(client);
    const start = await next(client, 'audio.output.start', 5000);
    assert.equal(start.session_id, sessionId);
    assert.equal(start.sample_rate, 24000);
    const frames = [pcm(320, 4), pcm(160, 6)];
    for (const frame of frames) client.ws.send(frame);
    await waitUntil(() => client.binaries.length === 2, 5000, 'Echo');
    assert.ok(client.binaries[0].equals(frames[0]));
    assert.ok(client.binaries[1].equals(frames[1]));
    await next(client, 'audio.output.end', 5000);
    assert.deepEqual(logs, []);
  } finally {
    if (client) await closeClient(client);
    adapterBridge.release(entry);
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  assert.equal(bus.status().pluginClients, 0);
});
