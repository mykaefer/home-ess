'use strict';

const { setMaxListeners } = require('node:events');
const { playAudio } = require('./playback');
const repository = require('./repository');
const config = require('./config');

function createRuntime({ bus = require('../audio-bus'), enabled = () => require('../modules').isEnabled('speech'), synthesize = require('./tts').synthesize } = {}) {
  let db;
  let client;
  let generation = 0;
  let controller;
  let pending = 0;
  let queue = Promise.resolve();
  let discovery = Promise.resolve();
  let discoveryError = false;
  const failure = (reason) => ({ accepted: false, recipients: 0, reason });

  function remember(session) {
    discovery = discovery.then(() => repository.discover(db, session)).catch(() => { discoveryError = true; });
    return discovery;
  }
  async function init(database) { db = database; await reload(); }
  async function reload() {
    stop();
    if (!db || !enabled()) return;
    client = bus.createClient('speech');
    client.onSessionStarted(remember);
    client.onSessionEnded(remember);
    for (const session of client.listSessions()) remember(session);
    await discovery;
  }
  function stop() {
    generation += 1;
    if (controller) controller.abort();
    if (client) client.close();
    client = null;
  }
  async function list() {
    await discovery;
    const active = new Set(client ? client.listSessions().map((s) => s.deviceId) : []);
    return (await repository.list(db)).map((row) => ({ ...row, active: active.has(row.device_id) }));
  }
  async function deliver(text, target, epoch) {
    if (!client || !enabled() || epoch !== generation) return failure('speech_disabled');
    const output = client;
    const abort = new AbortController();
    // Die Zahl der Abbruch-Listener richtet sich nach den Ausgabezielen.
    controller = abort;
    try {
      const endpoints = await list();
      const wanted = new Set(endpoints.filter((e) => e.room_name && target === `room:${e.room_id}`).map((e) => e.device_id));
      // Pro Gerät nur eine Session verwenden, damit eine Ansage nicht doppelt läuft.
      const selected = new Map();
      for (const s of output.listSessions()) {
        if (target === 'all' || target === `endpoint:${s.deviceId}` || wanted.has(s.deviceId)) selected.set(s.deviceId, s.sessionId);
      }
      if (!selected.size) return failure('no_audio_endpoints');
      setMaxListeners(Math.max(32, selected.size * 2 + 4), abort.signal);
      // Eine Einstellungskopie je Ansage: Speichern beeinflusst erst die nächste.
      const settings = await config.get(db);
      const audio = await synthesize(text, { signal: abort.signal, volumePercent: settings.volumePercent });
      if (epoch !== generation || abort.signal.aborted) return failure('speech_disabled');
      const results = await Promise.all([...selected.values()].map(async (id) => {
        try {
          await playAudio(output, id, audio, abort.signal, settings);
          return true;
        } catch (_) { return false; }
      }));
      if (abort.signal.aborted) return failure('speech_disabled');
      const recipients = results.filter(Boolean).length;
      return { accepted: recipients > 0, recipients, partial: recipients > 0 && recipients < results.length, ...(recipients ? {} : { reason: 'audio_output_failed' }) };
    } catch (error) { return failure(abort.signal.aborted ? 'speech_disabled' : error.code === 'tts_unavailable' ? 'tts_unavailable' : 'speech_failed'); }
    finally { if (controller === abort) controller = null; }
  }
  function speak(text, target = 'all') {
    if (!client || !enabled()) return Promise.resolve(failure('speech_disabled'));
    if (pending >= 8) return Promise.resolve(failure('speech_queue_full'));
    if (typeof text !== 'string' || !text.trim() || text.length > 650) return Promise.resolve(failure('speech_invalid_text'));
    pending += 1;
    const epoch = generation;
    const result = queue.then(() => deliver(text, target, epoch)).finally(() => { pending -= 1; });
    queue = result.catch(() => {});
    return result;
  }
  return { init, reload, stop, list, speak, status: () => ({ active: !!client, pending, discoveryError }) };
}
const runtime = createRuntime();
module.exports = { ...runtime, createRuntime };
