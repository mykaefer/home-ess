'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DEFAULTS, normalize } = require('./config');
const { validateFormat } = require('../audio-bus/formats');

// Piper liefert WAV im Speicher. Nur PCM-Daten gelangen auf den Bus;
// niemals der WAV-Container.
function decodeWav(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('tts_invalid_audio');
  let format;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === 'fmt ') {
      if (size < 16 || start + size > wav.length || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16) throw new Error('tts_invalid_audio');
      format = { codec: 'pcm_s16le', channels: wav.readUInt16LE(start + 2), sampleRate: wav.readUInt32LE(start + 4) };
    }
    if (kind === 'data' && format) {
      const pcm = wav.subarray(start, Math.min(start + size, wav.length));
      if (!pcm.length || pcm.length % (2 * format.channels) || !validateFormat(format).ok) throw new Error('tts_invalid_audio');
      return { ...format, pcm };
    }
    offset = start + size + (size % 2);
  }
  throw new Error('tts_invalid_audio');
}
const PIPER_DIR = '/opt/home-ess-tts';
const PYTHON_PATH = path.join(PIPER_DIR, 'venv/bin/python3');
const MODEL_PATH = path.join(PIPER_DIR, 'voices/de_DE-thorsten-high.onnx');
const WORKER_PATH = path.join(__dirname, 'piper-worker.py');

function failure(code) { return Object.assign(new Error(code), { code }); }

// Separater Prozess je Ansage: begrenzte Laufzeit, direkt abbrechbar und kein
// zusätzlicher HTTP-Server. Text wird ausschließlich über stdin übergeben.
function createSynthesizer({ pythonPath = PYTHON_PATH, modelPath = MODEL_PATH,
  workerPath = WORKER_PATH, timeoutMs = 30000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return async function synthesize(text, { signal, volumePercent = DEFAULTS.volumePercent } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 650) throw failure('tts_invalid_text');
    const settings = normalize({ ...DEFAULTS, volumePercent });
    try {
      await Promise.all([fs.access(pythonPath, fs.constants.X_OK), fs.access(modelPath, fs.constants.R_OK),
        fs.access(`${modelPath}.json`, fs.constants.R_OK)]);
    } catch (_) { throw failure('tts_unavailable'); }
    return new Promise((resolve, reject) => {
      const child = execFile(pythonPath, ['-I', '-B', workerPath, modelPath, String(settings.volumePercent)], {
        encoding: 'buffer', timeout: timeoutMs, maxBuffer, signal,
      }, (error, stdout) => {
        if (error) return reject(failure(error.code === 'ENOENT' ? 'tts_unavailable' : 'tts_failed'));
        try { resolve(decodeWav(stdout)); } catch (_) { reject(failure('tts_invalid_audio')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    });
  };
}
const synthesize = createSynthesizer();
module.exports = { synthesize, decodeWav, createSynthesizer, PYTHON_PATH, MODEL_PATH };
