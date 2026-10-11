'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSynthesizer } = require('../src/speech/tts');

function fixture(t, source, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-piper-process-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, 'voice.onnx');
  const workerPath = path.join(directory, 'worker.py');
  fs.writeFileSync(modelPath, 'model');
  fs.writeFileSync(`${modelPath}.json`, '{}');
  fs.writeFileSync(workerPath, source);
  return { modelPath, synthesize: createSynthesizer({ pythonPath: '/usr/bin/python3', modelPath, workerPath, ...options }) };
}

test('Piper-Prozess erhält Text unverändert über stdin und liefert PCM ohne WAV-Header', async (t) => {
  const text = 'Tür offen. "Hallo"; $(echo nichts)\nZweite Zeile.';
  const { synthesize } = fixture(t, `
import sys, io, wave, json
text = sys.stdin.buffer.read().decode('utf-8')
assert text == json.loads(${JSON.stringify(JSON.stringify(text))})
assert len(sys.argv) == 3
assert sys.argv[2] == "70"
assert sys.argv[1].endswith('voice.onnx')
out = io.BytesIO()
with wave.open(out, 'wb') as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(22050)
    wav.writeframes(b'\\x01\\x02' * 20)
sys.stdout.buffer.write(out.getvalue())
`);
  const audio = await synthesize(text);
  assert.equal(audio.sampleRate, 22050);
  assert.equal(audio.codec, 'pcm_s16le');
  assert.equal(audio.channels, 1);
  assert.deepEqual(audio.pcm, Buffer.from(Array.from({ length: 40 }, (_, i) => i % 2 + 1)));
});

test('Fehlende Installation und fehlendes Modell ergeben tts_unavailable', async (t) => {
  const { synthesize, modelPath } = fixture(t, 'raise AssertionError("darf nicht starten")');
  fs.unlinkSync(modelPath);
  await assert.rejects(synthesize('Hallo'), { code: 'tts_unavailable' });
  await assert.rejects(createSynthesizer({ pythonPath: '/does-not-exist/piper-python' })('Hallo'), { code: 'tts_unavailable' });
});

test('Defekte Ausgabe und Prozessfehler werden ohne Textinhalte weitergereicht', async (t) => {
  const invalid = fixture(t, "print('kein WAV')");
  await assert.rejects(invalid.synthesize('Privater Text'), { code: 'tts_invalid_audio' });
  const failed = fixture(t, "import sys; sys.stderr.write(sys.stdin.read()); sys.exit(1)");
  await assert.rejects(failed.synthesize('Privater Text'), (error) => error.code === 'tts_failed' && !error.message.includes('Privater'));
});

test('Zeitlimit und Abbruchsignal beenden einen blockierten Piper-Prozess', async (t) => {
  const timed = fixture(t, 'import time; time.sleep(60)', { timeoutMs: 100 });
  await assert.rejects(timed.synthesize('Hallo'), { code: 'tts_failed' });
  const aborted = fixture(t, 'import time; time.sleep(60)');
  const controller = new AbortController();
  const result = aborted.synthesize('Hallo', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(result, { code: 'tts_failed' });
});

test('Zu große Ausgabe und überlange Eingabe bleiben begrenzt', async (t) => {
  const { synthesize } = fixture(t, "import sys; sys.stdout.buffer.write(b'x' * 4096)", { maxBuffer: 1024 });
  await assert.rejects(synthesize('Hallo'), { code: 'tts_failed' });
  await assert.rejects(synthesize('a'.repeat(651)), { code: 'tts_invalid_text' });
});
