'use strict';

const { EventEmitter } = require('events');
const { frameBuffer } = require('./renderer');

function sameBuffer(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function identifier(value, label, maximum = 64) {
  if (typeof value !== 'string'
      || value.length > maximum
      || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw Object.assign(new Error(`${label} ist ungültig.`), { code: 'INVALID_REQUEST' });
  }
  return value;
}

function envelopeBytes(type, payload) {
  return Buffer.byteLength(JSON.stringify({
    type,
    message_id: 'adapter-4294967295',
    sequence: 0xffffffff,
    payload,
  }), 'utf8');
}

function maximumChunkPayloadBytes(limit, timelineId, maximum) {
  let low = 0;
  let high = maximum;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const payload = {
      timeline_id: timelineId,
      offset: 0xffffffff,
      data: Buffer.alloc(candidate).toString('base64'),
    };
    if (envelopeBytes('output.timeline.chunk', payload) <= limit) low = candidate;
    else high = candidate - 1;
  }
  return low;
}

function validateStopped(message, outputId, timelineId, behavior) {
  return message && message.type === 'output.timeline.stopped' && message.payload
    && message.payload.output_id === outputId
    && message.payload.timeline_id === timelineId
    && message.payload.behavior === behavior;
}

function validatePlaying(message, outputId, timelineId, loop) {
  return message && message.type === 'output.timeline.playing' && message.payload
    && message.payload.output_id === outputId
    && message.payload.timeline_id === timelineId
    && message.payload.loop === loop
    && Number.isInteger(message.payload.scheduled_start_uptime_milliseconds)
    && message.payload.scheduled_start_uptime_milliseconds >= 0
    && message.payload.scheduled_start_uptime_milliseconds <= 0xffffffff;
}

function validateStatus(message, outputId, revision) {
  const payload = message && message.payload;
  if (!payload || payload.output_id !== outputId || payload.config_revision !== revision
      || !['idle', 'frame', 'timeline_scheduled', 'timeline_playing'].includes(payload.mode)
      || (payload.mode === 'frame'
        ? typeof payload.frame_id !== 'string'
          || payload.timeline_id !== null || payload.loop !== null
          || payload.position_milliseconds !== null
        : payload.mode === 'idle'
          ? payload.frame_id !== null || payload.timeline_id !== null
            || payload.loop !== null || payload.position_milliseconds !== null
          : payload.frame_id !== null || typeof payload.timeline_id !== 'string'
            || typeof payload.loop !== 'boolean'
            || !Number.isInteger(payload.position_milliseconds)
            || payload.position_milliseconds < 0)) {
    throw Object.assign(new Error('Ungültige output.status-Antwort.'), { code: 'INVALID_OUTPUT_STATE' });
  }
  return payload;
}

class OutputClient extends EventEmitter {
  constructor(options) {
    super();
    this.transport = options.transport;
    this.manifest = options.manifest;
    this.getConfig = options.getConfig;
    this.frames = new Map();
    this.baselines = new Set();
    this.frameCounter = 0;
    this.desired = new Map();
    this.activeTimelines = new Map();
    this.lastFrameAt = new Map();
  }

  sessionStarted() {
    this.baselines.clear();
    this.frames.clear();
    this.activeTimelines.clear();
    this.lastFrameAt.clear();
  }

  output(outputId) {
    identifier(outputId, 'Output-ID', 32);
    const config = this.getConfig();
    const output = config && config.outputs && config.outputs.find((item) => item.output_id === outputId);
    if (!output) throw Object.assign(new Error(`Output ${outputId} ist nicht konfiguriert.`), { code: 'OUTPUT_NOT_FOUND' });
    return { config, output };
  }

  request(type, payload, timeout = 5000) {
    if (envelopeBytes(type, payload) > this.manifest.limits.maximum_websocket_message_bytes) {
      return Promise.reject(Object.assign(new Error(`${type} passt nicht in maximum_websocket_message_bytes.`), {
        code: 'PAYLOAD_TOO_LARGE',
      }));
    }
    return this.transport.request(type, payload, timeout);
  }

  async requestRecovered(type, payload, timeout = 5000) {
    try {
      return await this.request(type, payload, timeout);
    } catch (error) {
      if (!error.uncertain || !this.transport.ready) throw error;
      return this.request(type, payload, timeout);
    }
  }

  async setFrame(outputId, pixels, options = {}) {
    if (this.manifest.features.frame_output !== true) {
      throw Object.assign(new Error('Manifest unterstützt keine Frameausgabe.'), {
        code: 'UNSUPPORTED_MESSAGE_TYPE',
      });
    }
    const { config, output } = this.output(outputId);
    if (!Array.isArray(pixels) || pixels.length !== output.pixel_count) throw new Error('Framegröße stimmt nicht mit pixel_count überein.');
    const next = frameBuffer(pixels);
    const previous = this.frames.get(outputId);
    const desired = this.desired.get(outputId);
    if (!options.force && desired && desired.kind === 'frame' && sameBuffer(previous, next)) return { unchanged: true };
    const changes = [];
    if (this.baselines.has(outputId) && previous) {
      for (let index = 0; index < output.pixel_count; index += 1) {
        const offset = index * 3;
        if (previous[offset] !== next[offset] || previous[offset + 1] !== next[offset + 1]
            || previous[offset + 2] !== next[offset + 2]) {
          changes.push({ index, r: next[offset], g: next[offset + 1], b: next[offset + 2] });
        }
      }
    }
    this.frameCounter += 1;
    const frameId = `frame-${this.frameCounter}`;
    const patch = desired && desired.kind === 'frame'
      && this.baselines.has(outputId) && changes.length > 0
      && changes.length * 36 < next.length * 2;
    let payload = patch ? {
      output_id: outputId, config_revision: config.revision, frame_id: frameId,
      mode: 'patch', encoding: 'pixel-list-v1', data: null, pixels: changes,
    } : {
      output_id: outputId, config_revision: config.revision, frame_id: frameId,
      mode: 'replace', encoding: 'rgb8-base64', data: next.toString('base64'), pixels: null,
    };
    const messageLimit = this.manifest.limits.maximum_websocket_message_bytes;
    if (patch && envelopeBytes('output.frame.set', payload) > messageLimit) {
      payload = {
        output_id: outputId, config_revision: config.revision, frame_id: frameId,
        mode: 'replace', encoding: 'rgb8-base64', data: next.toString('base64'), pixels: null,
      };
    }
    if (envelopeBytes('output.frame.set', payload) > messageLimit) {
      throw Object.assign(new Error('Frame passt nicht in maximum_websocket_message_bytes.'), {
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    const elapsed = Date.now() - (this.lastFrameAt.get(outputId) || 0);
    const minimum = this.manifest.limits.minimum_frame_interval_milliseconds;
    if (elapsed < minimum) await delay(minimum - elapsed);
    const response = await this.requestRecovered('output.frame.set', payload, 5000);
    if (response.type !== 'output.frame.applied' || !response.payload
        || response.payload.output_id !== outputId || response.payload.frame_id !== frameId
        || response.payload.config_revision !== config.revision
        || !Number.isInteger(response.payload.applied_at_uptime_milliseconds)
        || response.payload.applied_at_uptime_milliseconds < 0
        || response.payload.applied_at_uptime_milliseconds > 0xffffffff) {
      throw Object.assign(new Error('Ungültige Framebestätigung.'), { code: 'INVALID_OUTPUT_STATE' });
    }
    this.lastFrameAt.set(outputId, Date.now());
    this.frames.set(outputId, next);
    this.activeTimelines.delete(outputId);
    this.baselines.add(outputId);
    this.desired.set(outputId, { kind: 'frame', pixels });
    this.emit('state', { outputId, mode: 'frame', frameId, timelineId: null });
    return { mode: payload.mode, frameId };
  }

  async status(outputId) {
    const { config } = this.output(outputId);
    const result = validateStatus(
      await this.request('output.status.get', { output_id: outputId }, 5000),
      outputId,
      config.revision,
    );
    this.emit('state', {
      outputId, mode: result.mode, frameId: result.frame_id, timelineId: result.timeline_id,
    });
    return result;
  }

  async stop(outputId, timelineId, behavior = 'hold') {
    identifier(timelineId, 'Timeline-ID');
    if (!['hold', 'clear'].includes(behavior)) {
      throw Object.assign(new Error('Timeline-Stoppverhalten ist ungültig.'), {
        code: 'INVALID_REQUEST',
      });
    }
    const payload = { output_id: outputId, timeline_id: timelineId, behavior };
    try {
      const response = await this.request('output.timeline.stop', payload, 5000);
      if (!validateStopped(response, outputId, timelineId, behavior)) {
        throw new Error('Ungültige Timeline-Stoppbestätigung.');
      }
    } catch (error) {
      if (!error.uncertain) throw error;
      const status = await this.status(outputId);
      if (!['idle', 'frame'].includes(status.mode)) {
        const retried = await this.request('output.timeline.stop', payload, 5000);
        if (!validateStopped(retried, outputId, timelineId, behavior)) {
          throw new Error('Ungültige Timeline-Stoppbestätigung.');
        }
      }
    }
    this.desired.delete(outputId);
    this.activeTimelines.delete(outputId);
    this.frames.delete(outputId);
    this.baselines.delete(outputId);
  }

  async abort(timelineId) {
    identifier(timelineId, 'Timeline-ID');
    const response = await this.requestRecovered('output.timeline.abort', { timeline_id: timelineId }, 5000);
    if (response.type !== 'output.timeline.aborted' || !response.payload
        || response.payload.timeline_id !== timelineId) {
      throw Object.assign(new Error('Ungültige Timeline-Abbruchbestätigung.'), {
        code: 'INVALID_OUTPUT_STATE',
      });
    }
  }

  async uploadTimeline(outputId, timelineId, timeline) {
    if (this.manifest.features.timeline_output !== true) {
      throw Object.assign(new Error('Manifest unterstützt keine Timelineausgabe.'), {
        code: 'UNSUPPORTED_MESSAGE_TYPE',
      });
    }
    identifier(timelineId, 'Timeline-ID');
    const { config } = this.output(outputId);
    const limits = this.manifest.limits;
    if (!timeline || !Buffer.isBuffer(timeline.program)
        || !Number.isInteger(timeline.eventCount) || timeline.eventCount < 1
        || !Number.isInteger(timeline.durationMilliseconds) || timeline.durationMilliseconds < 1
        || typeof timeline.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(timeline.sha256)
        || timeline.program.length > limits.maximum_timeline_bytes
        || timeline.eventCount > limits.maximum_timeline_events
        || timeline.durationMilliseconds > limits.maximum_timeline_duration_milliseconds) {
      throw Object.assign(new Error('Timeline überschreitet ein Manifestlimit.'), { code: 'TIMELINE_CAPACITY_EXCEEDED' });
    }
    const metadata = {
      output_id: outputId,
      config_revision: config.revision,
      timeline_id: timelineId,
      encoding: 'hdtl-delta-v1',
      duration_milliseconds: timeline.durationMilliseconds,
      event_count: timeline.eventCount,
      program_size_bytes: timeline.program.length,
      program_sha256: timeline.sha256,
    };
    const ready = await this.requestRecovered('output.timeline.begin', metadata, 5000);
    if (ready.type !== 'output.timeline.ready' || !ready.payload
        || ready.payload.output_id !== outputId || ready.payload.next_offset !== 0
        || ready.payload.timeline_id !== timelineId
        || !Number.isInteger(ready.payload.maximum_chunk_bytes)
        || ready.payload.maximum_chunk_bytes < 1
        || ready.payload.maximum_chunk_bytes > limits.maximum_timeline_chunk_bytes) {
      throw new Error('Ungültige Timeline-Begin-Bestätigung.');
    }
    const chunkMaximum = Math.min(limits.maximum_timeline_chunk_bytes, ready.payload.maximum_chunk_bytes);
    const chunkSize = maximumChunkPayloadBytes(
      limits.maximum_websocket_message_bytes, timelineId, chunkMaximum,
    );
    if (chunkSize < 1) {
      throw Object.assign(new Error('Timeline-Chunk passt nicht in maximum_websocket_message_bytes.'), {
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    let offset = 0;
    while (offset < timeline.program.length) {
      const bytes = timeline.program.subarray(offset, Math.min(offset + chunkSize, timeline.program.length));
      const payload = { timeline_id: timelineId, offset, data: bytes.toString('base64') };
      const accepted = await this.requestRecovered('output.timeline.chunk', payload, 5000);
      const expected = offset + bytes.length;
      if (accepted.type !== 'output.timeline.chunk.accepted' || !accepted.payload
          || accepted.payload.timeline_id !== timelineId || accepted.payload.next_offset !== expected) {
        throw Object.assign(new Error('Timeline-Chunkoffset stimmt nicht.'), { code: 'TIMELINE_OFFSET_MISMATCH' });
      }
      offset = expected;
    }
    const committed = await this.requestRecovered('output.timeline.commit', { timeline_id: timelineId }, 10000);
    if (committed.type !== 'output.timeline.committed' || !committed.payload
        || committed.payload.output_id !== outputId
        || committed.payload.timeline_id !== timelineId
        || committed.payload.program_sha256 !== timeline.sha256) {
      throw new Error('Ungültige Timeline-Commitbestätigung.');
    }
  }

  async play(outputId, timelineId, loop = true, startDelay = 0) {
    if (loop && this.manifest.features.timeline_loop !== true) {
      throw Object.assign(new Error('Manifest unterstützt keine geloopten Timelines.'), {
        code: 'UNSUPPORTED_MESSAGE_TYPE',
      });
    }
    identifier(timelineId, 'Timeline-ID');
    if (typeof loop !== 'boolean' || !Number.isInteger(startDelay)
        || startDelay < 0 || startDelay > 60000) {
      throw Object.assign(new Error('Timeline-Startparameter sind ungültig.'), {
        code: 'INVALID_REQUEST',
      });
    }
    const { config } = this.output(outputId);
    const payload = {
      output_id: outputId, config_revision: config.revision, timeline_id: timelineId,
      loop, start_delay_milliseconds: startDelay,
    };
    try {
      const response = await this.request('output.timeline.play', payload, 5000);
      if (!validatePlaying(response, outputId, timelineId, loop)) {
        throw new Error('Ungültige Timeline-Playbestätigung.');
      }
    } catch (error) {
      if (!error.uncertain) throw error;
      const status = await this.status(outputId);
      if (!['timeline_scheduled', 'timeline_playing'].includes(status.mode)
          || status.timeline_id !== timelineId || status.loop !== loop) {
        const retried = await this.request('output.timeline.play', payload, 5000);
        if (!validatePlaying(retried, outputId, timelineId, loop)) {
          throw new Error('Ungültige Timeline-Playbestätigung.');
        }
      }
    }
    this.baselines.add(outputId);
    this.frames.delete(outputId);
    this.emit('state', {
      outputId, mode: startDelay > 0 ? 'timeline_scheduled' : 'timeline_playing',
      frameId: null, timelineId,
    });
  }

  async setTimeline(outputId, timelineId, timeline) {
    const active = this.activeTimelines.get(outputId);
    if (active && active.timelineId === timelineId
        && active.sha256 === timeline.sha256) return { unchanged: true };
    if (active) {
      await this.stop(outputId, active.timelineId, 'hold');
    }
    // Vor dem Upload merken: Nach Sitzungsverlust beginnt restoreDesired den
    // flüchtigen Upload normativ wieder mit Begin und Offset 0.
    this.desired.set(outputId, { kind: 'timeline', timelineId, timeline });
    let uploaded = false;
    try {
      await this.uploadTimeline(outputId, timelineId, timeline);
      uploaded = true;
      await this.play(outputId, timelineId, true, 0);
      this.activeTimelines.set(outputId, { timelineId, sha256: timeline.sha256 });
      return { timelineId };
    } catch (error) {
      if (!uploaded && this.transport.ready) {
        try { await this.abort(timelineId); } catch (_) { /* Ursprungsfehler bleibt maßgeblich. */ }
      }
      throw error;
    }
  }

  async restoreDesired() {
    const desired = Array.from(this.desired.entries());
    this.sessionStarted();
    for (const [outputId, state] of desired) {
      if (state.kind === 'frame') await this.setFrame(outputId, state.pixels, { force: true });
      else await this.setTimeline(outputId, state.timelineId, state.timeline);
    }
  }
}

module.exports = {
  OutputClient, validateStatus, validateStopped, validatePlaying,
  envelopeBytes, maximumChunkPayloadBytes,
};
