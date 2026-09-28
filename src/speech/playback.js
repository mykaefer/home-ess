'use strict';

const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const { DEFAULTS, normalize } = require('./config');
const LEAD_MS = DEFAULTS.leadMs;
const CHUNK_MS = DEFAULTS.chunkMs;
const BACKPRESSURE_MS = 2000;

// Einen begrenzten Audio-Vorlauf liefern. Absolute Sample-Zeiten verhindern,
// dass sich Event-Loop-Verzögerungen von Paket zu Paket aufsummieren.
async function playAudio(client, sessionId, audio, signal, { now = () => performance.now(), wait = delay, ...options } = {}) {
  const { leadMs, tailMs, chunkMs } = normalize({ ...DEFAULTS, ...options });
  const assertActive = () => {
    if (signal && signal.aborted) throw Object.assign(new Error('speech_disabled'), { code: 'speech_disabled' });
  };
  const waitUntil = async (at) => {
    assertActive();
    while (now() < at) {
      await wait(Math.ceil(at - now()), undefined, { signal });
      assertActive();
    }
  };
  const bytesPerSecond = audio.sampleRate * audio.channels * 2;
  const size = Math.floor(audio.sampleRate * chunkMs / 1000) * audio.channels * 2;
  let started = false;
  try {
    assertActive();
    client.startOutput(sessionId, audio);
    started = true;
    const origin = now();
    for (let offset = 0; offset < audio.pcm.length; offset += size) {
      const chunk = audio.pcm.subarray(offset, offset + size);
      await waitUntil(origin + (offset + chunk.length) / bytesPerSecond * 1000 - leadMs);
      const deadline = now() + BACKPRESSURE_MS;
      for (;;) {
        assertActive();
        try { client.sendAudio(sessionId, chunk); break; } catch (error) {
          if (error.code !== 'output_backpressure' || now() >= deadline) throw error;
          await wait(25, undefined, { signal });
        }
      }
    }
    // Die Gegenstelle kann ebenfalls vorpuffern. Das Stream-Ende darf die
    // letzten Samples nicht abschneiden; auch die Abbruchquelle bleibt aktiv.
    await waitUntil(Math.max(origin + audio.pcm.length / bytesPerSecond * 1000, now()) + tailMs);
  } finally {
    if (started) { try { client.endOutput(sessionId); } catch (_) { /* Session bereits beendet. */ } }
  }
}

module.exports = { playAudio, LEAD_MS, CHUNK_MS };
