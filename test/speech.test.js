'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { createAudioBus } = require('../src/audio-bus/bus');
const { createRuntime } = require('../src/speech/runtime');
const repository = require('../src/speech/repository');
const service = require('../src/notifications/service');
const { decodeWav, synthesize } = require('../src/speech/tts');
const tick = () => new Promise((r) => setImmediate(r));
const run = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (e) => e ? reject(e) : resolve()));
const format = { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 };
const pcm = Buffer.alloc(320, 1);

async function fixture(t, overrides = {}) {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE heizung_rooms (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO heizung_rooms VALUES (1, 'Küche'), (2, 'Büro');
    CREATE TABLE speech_config (id INTEGER PRIMARY KEY, volume_percent INTEGER, lead_ms INTEGER, tail_ms INTEGER, chunk_ms INTEGER);
    CREATE TABLE speech_endpoints (device_id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', room_id INTEGER, last_seen INTEGER NOT NULL);`);
  const bus = createAudioBus({ logger: { info() {}, warn() {}, error() {} } });
  let enabled = true;
  const runtime = createRuntime({ bus, enabled: () => enabled, synthesize: async () => ({ ...format, pcm }), ...overrides });
  t.after(async () => { runtime.stop(); bus.shutdown(); await tick(); await new Promise((r) => db.close(r)); });
  const open = (deviceId) => {
    const frames = [], controls = [];
    const session = bus.openSession({ sendControl: (v) => controls.push(v), sendBinary: (v) => frames.push(v), isOpen: () => true, bufferedAmount: () => 0 }, { ...format, deviceId, source: 'test' }).session;
    return { frames, controls, session };
  };
  return { db, bus, runtime, open, disable: async () => { enabled = false; await runtime.reload(); } };
}

test('Registry erkennt bestehende und neue Sessions; Zuordnungen überleben Reconnect und Modulwechsel', async (t) => {
  const f = await fixture(t);
  const a = f.open('a');
  await f.runtime.init(f.db);
  f.open('b');
  await tick();
  assert.equal((await f.runtime.list()).length, 2);
  await repository.update(f.db, 'a', { name: 'Lautsprecher', roomId: '1' });
  f.bus.endSession(a.session.sessionId, 'client_end');
  await tick();
  assert.equal((await f.runtime.list()).find((e) => e.device_id === 'a').active, false);
  f.open('a');
  await tick();
  const endpoint = (await f.runtime.list()).find((e) => e.device_id === 'a');
  assert.equal(endpoint.name, 'Lautsprecher');
  assert.equal(endpoint.room_name, 'Küche');
  assert.equal(endpoint.active, true);
  await f.disable();
  assert.equal((await f.runtime.list()).every((e) => !e.active), true);
  assert.equal((await f.runtime.speak('Hallo')).reason, 'speech_disabled');
  assert.equal(f.bus.status().inputSubscribers, 0);
});

test('Endpunkt-, Raum- und Rundrufausgabe verwenden PCM und deduplizieren Gerätesessions', async (t) => {
  const f = await fixture(t);
  const a = f.open('a'), b = f.open('b'), duplicate = f.open('a');
  await f.runtime.init(f.db);
  await repository.update(f.db, 'a', { name: 'A', roomId: '1' });
  assert.equal((await f.runtime.speak('Hallo', 'room:1')).recipients, 1);
  assert.equal(a.frames.length, 0);
  assert.deepEqual(duplicate.frames, [pcm]);
  assert.equal(b.frames.length, 0);
  assert.equal((await f.runtime.speak('Hallo', 'endpoint:b')).recipients, 1);
  assert.deepEqual(b.frames, [pcm]);
  assert.equal((await f.runtime.speak('Hallo', 'all')).recipients, 2);
  assert.equal((await f.runtime.speak('Hallo', 'room:2')).reason, 'no_audio_endpoints');
  assert.equal(duplicate.controls.at(-1).type, 'audio.output.end');
});

test('Belegter Audio-Endpunkt verhindert nicht die Ausgabe an andere Geräte', async (t) => {
  const f = await fixture(t);
  const a = f.open('a'), b = f.open('b');
  await f.runtime.init(f.db);
  const other = f.bus.createClient('other');
  other.startOutput(a.session.sessionId, format);
  const result = await f.runtime.speak('Hallo');
  assert.equal(result.recipients, 1);
  assert.equal(result.partial, true);
  assert.equal(b.frames.length, 1);
  other.close();
});

test('Gespeicherter Pegel gilt ohne Reload ab der nächsten Ansage', async (t) => {
  const volumes = [];
  const config = require('../src/speech/config');
  const f = await fixture(t, { synthesize: async (_text, { volumePercent }) => {
    volumes.push(volumePercent);
    return { ...format, pcm };
  } });
  f.open('speaker');
  await f.runtime.init(f.db);
  await config.save(f.db, { ...config.DEFAULTS, volumePercent: 55, tailMs: 0 });
  assert.equal((await f.runtime.speak('Erste Ansage')).recipients, 1);
  await config.save(f.db, { ...config.DEFAULTS, volumePercent: 40, tailMs: 0 });
  assert.equal((await f.runtime.speak('Zweite Ansage')).recipients, 1);
  assert.deepEqual(volumes, [55, 40]);
});

test('Deaktivieren bricht TTS und wartende Ansagen ab; Queue ist begrenzt', async (t) => {
  let begun;
  const started = new Promise((r) => { begun = r; });
  const f = await fixture(t, { synthesize: (_text, { signal }) => new Promise((resolve, reject) => {
    begun(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const a = f.open('a');
  await f.runtime.init(f.db);
  const pending = Array.from({ length: 8 }, () => f.runtime.speak('Hallo'));
  assert.equal((await f.runtime.speak('Hallo')).reason, 'speech_queue_full');
  await started;
  await f.disable();
  assert.ok((await Promise.all(pending)).every((r) => r.reason === 'speech_disabled'));
  assert.equal(a.frames.length, 0);
});

test('Audio-only ruft Relay nicht auf; kombinierter Versand meldet Teilerfolg', async () => {
  let relayCalls = 0, audioCalls = 0;
  const options = {
    connectionService: { getStatus: () => { relayCalls++; return { state: 'idle' }; } },
    speechRuntime: { speak: async (text, target) => { audioCalls++; assert.equal(target, 'room:1'); assert.equal(text, 'Titel. Text'); return { accepted: true, recipients: 1 }; } },
  };
  const input = { title: 'Titel', body: 'Text', type: 'test', delivery: 'speech', audioTarget: 'room:1' };
  assert.equal((await service.push(input, options)).accepted, true);
  assert.equal(relayCalls, 0);
  const both = await service.push({ ...input, delivery: 'both' }, options);
  assert.equal(both.partial, true);
  assert.equal(both.channels.relay.reason, 'relay_unavailable');
  assert.equal(audioCalls, 2);
  await assert.rejects(service.push({ ...input, audioTarget: 'room:../1' }, options), /Audio-Ziel/);
});

test('Registry validiert Namen und Räume', async (t) => {
  const f = await fixture(t);
  f.open('a'); await f.runtime.init(f.db);
  await assert.rejects(repository.update(f.db, 'a', { roomId: '999' }), /Raum/);
  await assert.rejects(repository.update(f.db, 'a', { name: 'a\nb' }), /Name/);
  await assert.rejects(repository.update(f.db, 'missing', {}), /Endpunkt/);
});

test('WAV-Decoder entfernt Container, akzeptiert Streaming-Länge und weist falsches Format ab', () => {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(0x7ffff000, 40); pcm.copy(wav, 44);
  assert.deepEqual(decodeWav(wav), { ...format, pcm });
  wav.writeUInt16LE(8, 34);
  assert.throws(() => decodeWav(wav), /tts_invalid_audio/);
  assert.throws(() => decodeWav(Buffer.alloc(0)), /tts_invalid_audio/);
});

test('Reale lokale TTS liefert PCM oder einen verständlichen Installationsfehler', async () => {
  try {
    const audio = await synthesize('Lokaler Test.');
    assert.equal(audio.codec, 'pcm_s16le'); assert.ok(audio.pcm.length > 100);
    let peak = 0;
    for (let offset = 0; offset < audio.pcm.length; offset += 2) peak = Math.max(peak, Math.abs(audio.pcm.readInt16LE(offset)));
    assert.ok(peak > 100, 'Die Ausgabe darf nicht stumm sein.');
    assert.ok(peak <= 22937, 'Piper muss rund 3 dB Pegelreserve lassen.');
  } catch (error) {
    assert.equal(error.code, 'tts_unavailable');
  }
});

test('Abschalten während der PCM-Ausgabe beendet den Stream und weitere Frames', async (t) => {
  const f = await fixture(t, { synthesize: async () => ({ ...format, pcm: Buffer.alloc(32000) }) });
  const a = f.open('a'); await f.runtime.init(f.db);
  const sending = f.runtime.speak('Hallo');
  for (let attempts = 0; !a.frames.length && attempts < 100; attempts++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(a.frames.length);
  await f.disable();
  const count = a.frames.length;
  assert.equal((await sending).reason, 'speech_disabled');
  assert.equal(a.frames.length, count);
  assert.equal(a.controls.at(-1).type, 'audio.output.end');
});

test('Ansicht escaped Endpunktnamen und Gerätenamen', () => {
  const render = require('../src/views/speech');
  const html = render({ endpoints: [{ device_id: 'device', name: '<img src=x onerror=alert(1)>', source: 'test', last_seen: 1 }], rooms: [], status: { pending: 0 } });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
});

test('Rundruf erreicht auch eine gerade geöffnete, noch nicht persistierte Session', async (t) => {
  const f = await fixture(t);
  await f.runtime.init(f.db);
  const a = f.open('new-speaker');
  assert.equal((await f.runtime.speak('Hallo')).recipients, 1);
  assert.equal(a.frames.length, 1);
});
