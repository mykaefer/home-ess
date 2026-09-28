'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { playAudio, LEAD_MS } = require('../src/speech/playback');

function fixture({ sampleRate = 22050, jitter = 17, duration = 3 } = {}) {
  let time = 0;
  const received = [];
  const events = [];
  const pcm = Buffer.alloc(sampleRate * 2 * duration);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  const audio = { codec: 'pcm_s16le', sampleRate, channels: 1, pcm };
  const timing = { now: () => time, wait: async (ms) => { time += ms + jitter; } };
  const client = {
    startOutput: () => events.push({ type: 'start', time }),
    sendAudio: (_id, chunk) => received.push({ chunk: Buffer.from(chunk), time }),
    endOutput: () => events.push({ type: 'end', time }),
  };
  return { client, audio, timing, received, events, time: () => time };
}

test('Vorlauf verhindert Unterläufe trotz Timer-Jitter; PCM bleibt samplegenau', async () => {
  const f = fixture();
  await playAudio(f.client, 'speaker', f.audio, undefined, f.timing);
  const bytesPerMs = f.audio.sampleRate * 2 / 1000;
  let receivedBytes = 0;
  for (const { chunk, time } of f.received) {
    if (time > 0) assert.ok(receivedBytes / bytesPerMs >= time, 'Die Gegenstelle darf zwischen Paketen nicht leer laufen.');
    assert.equal(chunk.length % 2, 0);
    receivedBytes += chunk.length;
    assert.ok(receivedBytes / bytesPerMs - time <= LEAD_MS + 1, 'Vorlauf muss begrenzt bleiben.');
  }
  assert.deepEqual(Buffer.concat(f.received.map((r) => r.chunk)), f.audio.pcm);
  assert.ok(f.events.at(-1).time >= 3000 + LEAD_MS);
  assert.ok(f.events.at(-1).time < 3000 + LEAD_MS + 20, 'Timer-Jitter darf sich nicht aufsummieren.');
  assert.ok(f.received.filter((r) => r.time === 0).length >= 4, 'Mehrere Startpakete müssen sofort bereitstehen.');
});

test('Backpressure wiederholt dasselbe Paket ohne Samples zu verlieren oder zu verdoppeln', async () => {
  const f = fixture({ jitter: 0, duration: 1 });
  const send = f.client.sendAudio;
  let busy = 2;
  f.client.sendAudio = (id, chunk) => {
    if (busy-- > 0) throw Object.assign(new Error('busy'), { code: 'output_backpressure' });
    send(id, chunk);
  };
  await playAudio(f.client, 'speaker', f.audio, undefined, f.timing);
  assert.deepEqual(Buffer.concat(f.received.map((r) => r.chunk)), f.audio.pcm);
  assert.equal(f.events.at(-1).type, 'end');
});

test('Konfigurierbarer Vorlauf und Paketdauer erhalten PCM; Nachlauf ist unabhängig', async () => {
  for (const chunkMs of [10, 20, 50, 100]) {
    const f = fixture({ jitter: 0 });
    await playAudio(f.client, 'speaker', f.audio, undefined, { ...f.timing, leadMs: 1500, tailMs: 725, chunkMs });
    const packetBytes = Math.floor(f.audio.sampleRate * chunkMs / 1000) * 2;
    assert.ok(f.received.every(({ chunk }) => chunk.length <= packetBytes));
    const firstBurst = f.received.filter(({ time }) => time === 0).reduce((sum, { chunk }) => sum + chunk.length, 0);
    const burstMs = firstBurst / (f.audio.sampleRate * 2) * 1000;
    assert.ok(burstMs <= 1500 && burstMs >= 1500 - chunkMs);
    assert.deepEqual(Buffer.concat(f.received.map(({ chunk }) => chunk)), f.audio.pcm);
    assert.equal(f.events.at(-1).time, 3725);
  }
});

test('Dauerhafte Backpressure bleibt begrenzt und beendet den eigenen Stream', async () => {
  const f = fixture({ jitter: 0 });
  f.client.sendAudio = () => { throw Object.assign(new Error('busy'), { code: 'output_backpressure' }); };
  await assert.rejects(playAudio(f.client, 'speaker', f.audio, undefined, f.timing), { code: 'output_backpressure' });
  assert.ok(f.time() <= 2025);
  assert.equal(f.events.at(-1).type, 'end');
});

test('Abbruch während Vorpufferung beendet den Stream ohne weitere Audio-Pakete', async () => {
  const f = fixture();
  const abort = new AbortController();
  const send = f.client.sendAudio;
  f.client.sendAudio = (id, chunk) => { send(id, chunk); abort.abort(); };
  await assert.rejects(playAudio(f.client, 'speaker', f.audio, abort.signal, f.timing), { code: 'speech_disabled' });
  assert.equal(f.received.length, 1);
  assert.equal(f.events.at(-1).type, 'end');
});
