'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const validation = require('../adapter/hdp/validation');
const discovery = require('../adapter/hdp/discovery');
const auth = require('../adapter/hdp/auth');
const { HdpClient, validateManifestInfo } = require('../adapter/hdp/client');
const {
  RuntimeConnection, connectionErrorMessage, RECONNECT_DELAYS,
} = require('../adapter/hdp/runtime');
const { LegacyRuntimeAdapter, runtimePayload } = require('../adapter/hdp/legacy-runtime');
const { encodeTimeline } = require('../adapter/hdp/timeline');
const {
  renderPercentageFrame, frameBuffer, compileIndicatorTimeline,
} = require('../adapter/hdp/renderer');
const { OutputClient } = require('../adapter/hdp/output-client');
const firmware = require('../adapter/hdp/firmware');
const createHdpAdapter = require('../adapter/hdp');

const DEVICE_ID = 'hdp-esp8266-a1b2c3d4e5f60718';
const INSTANCE_ID = 'homeess-main';
const BINDING_KEY = 'a'.repeat(64);
const BINDING_ID = 'e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e';
const ADAPTER_NONCE = '0'.repeat(32);
const SESSION = '1'.repeat(32);
const DEVICE_NONCE = '2'.repeat(32);

function hardwareConfig(revision = 4) {
  return {
    revision,
    device_type: 'percentage_indicator',
    hardware: {
      argb_pin: 2, led_count: 10, led_type: 'WS2812', color_order: 'GRB', reverse: false,
    },
    display: {
      fractional_led: true, inactive_led_mode: 'off', transition_milliseconds: 250,
    },
    power: {
      maximum_brightness_percent: 35, maximum_current_milliamps: 500,
      current_per_led_milliamps: 60,
    },
    offline: { mode: 'retain_last_state' },
  };
}

function pixelManifest() {
  return {
    protocol_version: '1.0-draft', api_version: 'v1',
    auth_profile: 'local-binding-key-v1', runtime_profile: 'pixel-timeline-v1',
    device_type_profile: 'opaque-id-v1', output_types: ['argb_strip'],
    frame_encodings: ['rgb8-base64', 'pixel-list-v1'],
    timeline_encodings: ['hdtl-delta-v1'],
    features: {
      mdns: true, websocket: true, ota: true,
      frame_output: true, timeline_output: true, timeline_loop: true,
    },
    hardware_capabilities: {
      argb_pins: [2, 4], led_types: ['WS2812'], color_orders: ['RGB', 'GRB'],
    },
    limits: {
      maximum_json_body_bytes: 3072, maximum_websocket_message_bytes: 2048,
      maximum_outputs: 1, maximum_led_count: 300,
      minimum_frame_interval_milliseconds: 20, maximum_timeline_bytes: 65536,
      maximum_timeline_events: 4096, maximum_timeline_chunk_bytes: 512,
      maximum_timeline_duration_milliseconds: 86400000,
    },
  };
}

function outputConfig(revision = 4, pixelCount = 4) {
  return {
    revision, device_type: 'percentage_indicator',
    outputs: [{
      output_id: 'main', output_type: 'argb_strip', pin: 4,
      pixel_count: pixelCount, driver: 'WS2812', color_order: 'GRB',
      reverse: false, maximum_brightness_percent: 35,
      maximum_current_milliamps: 500, current_per_pixel_milliamps: 60,
      offline_mode: 'retain_last_frame',
    }],
  };
}

function deviceInfo(paired = false) {
  return {
    device_id: DEVICE_ID, model: 'HDP Universal ESP8266', platform: 'esp8266',
    firmware_version: '0.2.0', protocol_version: '1.0-draft',
    pairing_state: paired ? 'paired' : 'pairable', paired,
    binding_id: paired ? BINDING_ID : null,
    configured_device_type: 'percentage_indicator',
    hardware_config_present: true, hardware_config_revision: 4,
  };
}

function manifest() {
  return {
    protocol_version: '1.0-draft', api_version: 'v1', auth_profile: 'local-binding-key-v1',
    device_types: ['percentage_indicator'],
    inputs: ['percentage_value', 'display_color', 'dynamic_brightness', 'transition_milliseconds'],
    features: { mdns: true, websocket: true, ota: true },
    hardware_capabilities: { argb_pins: [2, 4], led_types: ['WS2812'], color_orders: ['RGB', 'GRB'] },
    limits: {
      maximum_json_body_bytes: 3072, maximum_websocket_message_bytes: 1024, maximum_led_count: 300,
    },
  };
}

function status() {
  return {
    state: 'pairable', uptime_seconds: 123, free_heap_bytes: 32000,
    wifi_connected: true, wifi_rssi_dbm: -50, ip_address: '192.168.1.20', paired: false,
    last_boot: {
      reset_reason: 'power_on', reset_detail: null, config_load_status: 'ok',
      config_load_source: 'primary', config_load_diagnostic: 'primary=valid', storage_generation: 1,
    },
  };
}

function sendJson(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: true, data }));
}

test('HDP verwendet exakte Nonce-, Binding- und Identifikatorformate', () => {
  assert.equal(auth.bindingId(BINDING_KEY), BINDING_ID);
  assert.equal(auth.bindingId('0'.repeat(64)), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  assert.equal(auth.bindingId('0123456789abcdef'.repeat(4)), '4884fdaafea47c29fea7159d0daddd9c085d6200e1359e85bb81736af6b7c837');
  assert.match(auth.createAdapterNonce(), /^[0-9a-f]{32}$/);
  assert.match(auth.createBindingKey(), /^[0-9a-f]{64}$/);
  assert.equal(auth.basicAuthorization({ instanceId: INSTANCE_ID, bindingKey: BINDING_KEY }),
    `Basic ${Buffer.from(`${INSTANCE_ID}:${BINDING_KEY}`).toString('base64')}`);
  assert.throws(() => validation.validateDeviceId('hdp_device_123'), /Ungültige/);
  assert.throws(() => validation.validateProtocol('1.0'), /exakt/);
});

test('HDP validiert Konfiguration und Laufzeitwerte ohne Typkonvertierung', () => {
  const config = validation.validateHardwareConfig(hardwareConfig(), {
    argb_pins: [2], led_types: ['WS2812'], color_orders: ['GRB'], maximum_led_count: 20,
  });
  assert.deepEqual(config, hardwareConfig());
  assert.throws(() => validation.validateHardwareConfig({
    ...hardwareConfig(), hardware: { ...hardwareConfig().hardware, led_count: '10' },
  }), /JSON-Zahl/);
  assert.throws(() => validation.validateHardwareConfig({
    ...hardwareConfig(), hardware: { ...hardwareConfig().hardware, argb_pin: 4 },
  }, { argb_pins: [2] }), (error) => error.code === 'INVALID_CONFIGURATION');
  assert.throws(() => runtimePayload({
    percentage_value: 1, display_color: { r: 0, g: 0, b: 0 },
    dynamic_brightness: '50', transition_milliseconds: 0,
  }), /JSON-Zahl/);
  assert.deepEqual(runtimePayload({
    percentage_value: 50, display_color: { r: 1, g: 2, b: 3 },
    dynamic_brightness: 80, transition_milliseconds: 250,
    direction_indicator: {
      direction: 'rising', sweep_milliseconds: 600,
      pulse_interval_milliseconds: 4000, dimming_percent: 40,
    },
  }).direction_indicator, {
    direction: 'rising', sweep_milliseconds: 600,
    pulse_interval_milliseconds: 4000, dimming_percent: 40,
  });
  assert.throws(() => runtimePayload({
    percentage_value: 50, display_color: { r: 1, g: 2, b: 3 },
    dynamic_brightness: 80, transition_milliseconds: 250,
    direction_indicator: {
      direction: 'falling', sweep_milliseconds: 1000,
      pulse_interval_milliseconds: 500, dimming_percent: 40,
    },
  }), /nicht kürzer/);
});

test('HDP Richtungsindikator ist capability-gesteuert und löst Rising/Falling eindeutig auf', () => {
  const manifest = {
    protocol_version: '1.0-draft', api_version: 'v1', auth_profile: 'local-binding-key-v1',
    device_types: ['percentage_indicator'],
    inputs: ['percentage_value', 'display_color', 'dynamic_brightness', 'transition_milliseconds', 'direction_indicator'],
    features: { mdns: true, websocket: true, ota: true, direction_indicator: true },
    hardware_capabilities: { argb_pins: [2], led_types: ['WS2812'], color_orders: ['GRB'] },
    limits: { maximum_json_body_bytes: 3072, maximum_websocket_message_bytes: 1024, maximum_led_count: 300 },
  };
  assert.equal(validateManifestInfo(manifest), manifest);
  assert.throws(() => validateManifestInfo({
    ...manifest, inputs: manifest.inputs.filter((input) => input !== 'direction_indicator'),
  }), /Feature-Flags/);

  const device = {
    bindings: createHdpAdapter._test.defaultBindings(),
    rawPercentage: 42,
    rawRising: true,
    rawFalling: false,
    manifest,
    hardwareConfig: hardwareConfig(),
  };
  assert.equal(createHdpAdapter._test.calculateState(device).directionIndicator.direction, 'rising');
  device.rawFalling = true;
  assert.equal(createHdpAdapter._test.calculateState(device).directionIndicator.direction, null);
  assert.equal(createHdpAdapter._test.indicatorActive('on', 'Test'), true);
  assert.throws(() => createHdpAdapter._test.indicatorActive('steigend', 'Test'), /Booleanwert/);

  device.manifest = { ...manifest, inputs: manifest.inputs.slice(0, -1), features: { ...manifest.features, direction_indicator: false } };
  assert.equal(createHdpAdapter._test.calculateState(device).directionIndicator, undefined);
});

test('Entfernte oder gewechselte Indicator-Topics setzen gespeicherte Richtungen zurück', () => {
  const previous = createHdpAdapter._test.defaultBindings();
  previous.indicator.rising_topic = 'mqtt://main/rising';
  previous.indicator.falling_topic = 'mqtt://main/falling';
  const device = { rawRising: true, rawFalling: true };
  const next = structuredClone(previous);
  next.indicator.rising_topic = '';
  next.indicator.falling_topic = 'mqtt://main/other-falling';
  createHdpAdapter._test.resetChangedIndicatorState(device, previous, next);
  assert.equal(device.rawRising, false);
  assert.equal(device.rawFalling, false);
});

test('HDP normalisiert Skalierungsartefakte im Prozentwert', () => {
  const device = {
    bindings: createHdpAdapter._test.defaultBindings(),
    rawPercentage: 0.57,
    hardwareConfig: hardwareConfig(),
  };
  device.bindings.percentage.input_max = 1;
  const state = createHdpAdapter._test.calculateState(device);
  assert.equal(state.percentage, 57);
  assert.equal(device.calculatedPercentage, 57);
  assert.equal(createHdpAdapter._test.normalizedPercentage(12.34567), 12.346);
});

test('pixel-timeline-v1 rendert den normativen Vier-Pixel-Frame und Prozentgrenzen', () => {
  const render = (percentage) => renderPercentageFrame({
    pixelCount: 4, percentage, color: { r: 0, g: 255, b: 0 },
    brightness: 100, fractional: true,
  });
  assert.equal(frameBuffer(render(68.75)).toString('base64'), 'AP8AAP8AAL8AAAAA');
  assert.equal(frameBuffer(render(0)).toString('hex'), '000000000000000000000000');
  assert.equal(frameBuffer(render(12.5)).toString('hex'), '008000000000000000000000');
  assert.equal(frameBuffer(render(100)).toString('hex'), '00ff0000ff0000ff0000ff00');
});

test('hdtl-delta-v1 erzeugt den exakten normativen 28-Byte-Testvektor', () => {
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 255, b: 0 }] },
    {
      delta_milliseconds: 20,
      operations: [
        { op: 'SET_PIXEL', index: 0, r: 0, g: 150, b: 0 },
        { op: 'SET_PIXEL', index: 1, r: 0, g: 200, b: 0 },
      ],
    },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  assert.equal(timeline.program.length, 28);
  assert.equal(timeline.program.toString('base64'), 'AAAAAAEABAD/ABQAAAACAAEAAACWAAEBAADIAA==');
  assert.equal(timeline.sha256, '37657360dd397ea89a19031042604b6c6d7816e2f55826dc6ca050e3bd59a6ea');
});

test('Rising und Falling werden ausschließlich als deterministische Timelines kompiliert', () => {
  const frame = renderPercentageFrame({
    pixelCount: 10, percentage: 57, color: { r: 10, g: 200, b: 30 },
    brightness: 70, fractional: true,
  });
  const settings = { sweep_milliseconds: 600, pulse_interval_milliseconds: 4000, dimming_percent: 40 };
  const rising = compileIndicatorTimeline(frame, { ...settings, direction: 'rising' }, pixelManifest().limits);
  const falling = compileIndicatorTimeline(frame, { ...settings, direction: 'falling' }, pixelManifest().limits);
  assert.notEqual(rising.sha256, falling.sha256);
  assert.equal(rising.durationMilliseconds, 4000);
  assert.ok(rising.program.length <= pixelManifest().limits.maximum_timeline_bytes);
  assert.equal(rising.program.includes(Buffer.from('rising')), false);
});

test('pixel-timeline-v1 Manifest und generische Outputkonfiguration werden strikt validiert', () => {
  const manifest = pixelManifest();
  assert.equal(validateManifestInfo(manifest), manifest);
  assert.deepEqual(validation.validateHardwareConfig(outputConfig(), manifest), outputConfig());
  assert.throws(() => validateManifestInfo({
    ...manifest, runtime_profile: 'other-runtime',
  }), (error) => error.code === 'UNSUPPORTED_RUNTIME_PROFILE');
  assert.throws(() => validation.validateHardwareConfig({
    ...outputConfig(), outputs: [{ ...outputConfig().outputs[0], pixel_count: 301 }],
  }, manifest), /Pixelanzahl/);
});

test('OutputClient beginnt mit Replace und verwendet danach einen bestätigten Patch', async () => {
  const calls = [];
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload });
      return {
        type: 'output.frame.applied',
        payload: {
          reply_to: 'adapter-1', output_id: payload.output_id,
          frame_id: payload.frame_id, config_revision: payload.config_revision,
          applied_at_uptime_milliseconds: 1,
        },
      };
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(4, 10),
  });
  const first = renderPercentageFrame({
    pixelCount: 10, percentage: 50, color: { r: 0, g: 255, b: 0 },
    brightness: 100, fractional: true,
  });
  await client.setFrame('main', first);
  const second = first.map((pixel) => ({ ...pixel }));
  second[1] = { r: 1, g: 2, b: 3 };
  await client.setFrame('main', second);
  assert.equal(calls[0].payload.mode, 'replace');
  assert.equal(calls[1].payload.mode, 'patch');
  client.sessionStarted();
  await client.setFrame('main', second, { force: true });
  assert.equal(calls[2].payload.mode, 'replace');
});

test('Ein statischer Frame beendet eine gemerkte Indicator-Timeline mit absolutem Replace', async () => {
  const calls = [];
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload });
      return {
        type: 'output.frame.applied',
        payload: {
          reply_to: 'adapter-1', output_id: payload.output_id,
          frame_id: payload.frame_id, config_revision: payload.config_revision,
          applied_at_uptime_milliseconds: 10,
        },
      };
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  client.baselines.add('main');
  client.frames.set('main', Buffer.alloc(12));
  client.desired.set('main', {
    kind: 'timeline', timelineId: 'indicator-old', timeline: { sha256: 'a'.repeat(64) },
  });
  client.activeTimelines.set('main', {
    timelineId: 'indicator-old', sha256: 'a'.repeat(64),
  });
  const frame = renderPercentageFrame({
    pixelCount: 4, percentage: 50, color: { r: 0, g: 255, b: 0 },
    brightness: 100, fractional: true,
  });
  await client.setFrame('main', frame);
  assert.equal(calls[0].type, 'output.frame.set');
  assert.equal(calls[0].payload.mode, 'replace');
  assert.equal(client.activeTimelines.has('main'), false);
  assert.equal(client.desired.get('main').kind, 'frame');
});

test('OutputClient chunkt geordnet, wiederholt unsichere Chunks und gleicht Play/Stop per Status ab', async () => {
  const calls = [];
  let chunkFailed = false;
  let playing = true;
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type === 'output.timeline.begin') {
        return { type: 'output.timeline.ready', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          next_offset: 0, maximum_chunk_bytes: 5,
        } };
      }
      if (type === 'output.timeline.chunk') {
        if (!chunkFailed) {
          chunkFailed = true;
          throw Object.assign(new Error('lost'), { uncertain: true });
        }
        return { type: 'output.timeline.chunk.accepted', payload: {
          reply_to: 'x', timeline_id: payload.timeline_id,
          next_offset: payload.offset + Buffer.from(payload.data, 'base64').length,
        } };
      }
      if (type === 'output.timeline.commit') {
        return { type: 'output.timeline.committed', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          program_sha256: timeline.sha256,
        } };
      }
      if (type === 'output.timeline.play') throw Object.assign(new Error('lost'), { uncertain: true });
      if (type === 'output.timeline.stop') throw Object.assign(new Error('lost'), { uncertain: true });
      if (type === 'output.status.get') {
        return { type: 'output.status', payload: {
          reply_to: 'x', output_id: 'main', config_revision: 4,
          mode: playing ? 'timeline_playing' : 'frame', frame_id: playing ? null : 'frame-1',
          timeline_id: playing ? 'loop-1' : null, loop: playing ? true : null,
          position_milliseconds: playing ? 20 : null,
        } };
      }
      throw new Error(type);
    },
  };
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  await client.uploadTimeline('main', 'loop-1', timeline);
  const chunks = calls.filter((call) => call.type === 'output.timeline.chunk');
  assert.deepEqual(chunks.slice(0, 2).map((call) => call.payload.offset), [0, 0]);
  assert.equal(chunks[0].payload.data, chunks[1].payload.data);
  assert.deepEqual([...new Set(chunks.slice(1).map((call) => call.payload.offset))], [0, 5]);
  await client.play('main', 'loop-1', true, 0);
  playing = false;
  await client.stop('main', 'loop-1', 'hold');
  assert.ok(calls.filter((call) => call.type === 'output.status.get').length >= 2);
});

test('OutputClient stoppt laufende Timelines vor dem Ersatz und unterstützt normativen Abort', async () => {
  const calls = [];
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload });
      if (type === 'output.timeline.abort') {
        return {
          type: 'output.timeline.aborted',
          payload: { reply_to: 'adapter-1', timeline_id: payload.timeline_id },
        };
      }
      throw new Error(`Unerwarteter Request ${type}`);
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  const oldTimeline = { sha256: 'a'.repeat(64) };
  const nextTimeline = { sha256: 'b'.repeat(64) };
  client.desired.set('main', { kind: 'timeline', timelineId: 'old-loop', timeline: oldTimeline });
  client.activeTimelines.set('main', { timelineId: 'old-loop', sha256: oldTimeline.sha256 });
  client.stop = async (outputId, timelineId, behavior) => {
    calls.push({ type: 'stop', outputId, timelineId, behavior });
    client.desired.delete(outputId);
    client.activeTimelines.delete(outputId);
  };
  client.uploadTimeline = async (outputId, timelineId) => {
    calls.push({ type: 'upload', outputId, timelineId });
  };
  client.play = async (outputId, timelineId) => {
    calls.push({ type: 'play', outputId, timelineId });
  };
  await client.setTimeline('main', 'new-loop', nextTimeline);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.type), ['stop', 'upload', 'play']);
  assert.equal((await client.setTimeline('main', 'new-loop', nextTimeline)).unchanged, true);
  await client.abort('staging-loop');
  assert.deepEqual(calls.at(-1), {
    type: 'output.timeline.abort', payload: { timeline_id: 'staging-loop' },
  });
});

test('OutputClient wiederholt verlorene Frames byteidentisch und reicht Gerätefehler durch', async () => {
  const calls = [];
  let uncertain = true;
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (uncertain) {
        uncertain = false;
        throw Object.assign(new Error('Antwort verloren'), { uncertain: true });
      }
      if (calls.length === 3) {
        throw Object.assign(new Error('Revision falsch'), {
          code: 'OUTPUT_CONFIG_REVISION_MISMATCH',
        });
      }
      return {
        type: 'output.frame.applied',
        payload: {
          reply_to: 'adapter-1', output_id: payload.output_id,
          frame_id: payload.frame_id, config_revision: payload.config_revision,
          applied_at_uptime_milliseconds: 10,
        },
      };
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  const first = renderPercentageFrame({
    pixelCount: 4, percentage: 50, color: { r: 0, g: 255, b: 0 },
    brightness: 100, fractional: true,
  });
  await client.setFrame('main', first);
  assert.deepEqual(calls[0], calls[1]);
  const changed = first.map((pixel) => ({ ...pixel }));
  changed[0] = { r: 1, g: 2, b: 3 };
  await assert.rejects(client.setFrame('main', changed), {
    code: 'OUTPUT_CONFIG_REVISION_MISMATCH',
  });
});

test('OutputClient erkennt Offsetfehler und reicht Checksum-/Programmfehler durch', async () => {
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  const makeClient = (commitCode, wrongOffset = false) => new OutputClient({
    manifest: pixelManifest(),
    getConfig: () => outputConfig(),
    transport: {
      ready: true,
      async request(type, payload) {
        if (type === 'output.timeline.begin') {
          return {
            type: 'output.timeline.ready',
            payload: {
              reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
              next_offset: 0, maximum_chunk_bytes: 512,
            },
          };
        }
        if (type === 'output.timeline.chunk') {
          return {
            type: 'output.timeline.chunk.accepted',
            payload: {
              reply_to: 'x', timeline_id: payload.timeline_id,
              next_offset: payload.offset
                + Buffer.from(payload.data, 'base64').length + (wrongOffset ? 1 : 0),
            },
          };
        }
        if (type === 'output.timeline.commit') {
          throw Object.assign(new Error(commitCode), { code: commitCode });
        }
        throw new Error(type);
      },
    },
  });
  await assert.rejects(makeClient(null, true).uploadTimeline('main', 'loop-offset', timeline), {
    code: 'TIMELINE_OFFSET_MISMATCH',
  });
  for (const code of ['TIMELINE_CHECKSUM_MISMATCH', 'TIMELINE_INVALID_PROGRAM']) {
    await assert.rejects(makeClient(code).uploadTimeline('main', `loop-${code}`, timeline), {
      code,
    });
  }
});

test('OutputClient startet einen nach Sitzungsverlust unterbrochenen Upload wieder bei Offset 0', async () => {
  const calls = [];
  let firstSession = true;
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type === 'output.timeline.begin') {
        return {
          type: 'output.timeline.ready',
          payload: {
            reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
            next_offset: 0, maximum_chunk_bytes: 5,
          },
        };
      }
      if (type === 'output.timeline.chunk' && firstSession) {
        firstSession = false;
        transport.ready = false;
        throw Object.assign(new Error('Sitzung verloren'), { uncertain: true });
      }
      if (type === 'output.timeline.chunk') {
        return {
          type: 'output.timeline.chunk.accepted',
          payload: {
            reply_to: 'x', timeline_id: payload.timeline_id,
            next_offset: payload.offset + Buffer.from(payload.data, 'base64').length,
          },
        };
      }
      if (type === 'output.timeline.commit') {
        return {
          type: 'output.timeline.committed',
          payload: {
            reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
            program_sha256: timeline.sha256,
          },
        };
      }
      if (type === 'output.timeline.play') {
        return {
          type: 'output.timeline.playing',
          payload: {
            reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
            loop: true, scheduled_start_uptime_milliseconds: 10,
          },
        };
      }
      throw new Error(type);
    },
  };
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  await assert.rejects(client.setTimeline('main', 'recover-loop', timeline), /Sitzung verloren/);
  transport.ready = true;
  await client.restoreDesired();
  assert.equal(calls.filter((call) => call.type === 'output.timeline.begin').length, 2);
  const chunks = calls.filter((call) => call.type === 'output.timeline.chunk');
  assert.equal(chunks[0].payload.offset, 0);
  assert.equal(chunks[1].payload.offset, 0);
});

test('Timelineencoder lehnt fehlende Baseline, Frameintervall und Manifestlimits ab', () => {
  const options = {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 1, maximumBytes: 32,
  };
  assert.throws(() => encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'SET_PIXEL', index: 0, r: 0, g: 0, b: 0 }] },
  ], options), /Baselineframe/);
  assert.throws(() => encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
    { delta_milliseconds: 10, operations: [{ op: 'SET_PIXEL', index: 0, r: 1, g: 2, b: 3 }] },
  ], { ...options, maximumEvents: 2 }), /Frameintervall/);
  assert.throws(() => encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'SET_RANGE_RGB', start: 0, pixels: Array(4).fill({ r: 1, g: 2, b: 3 }) }] },
  ], { ...options, maximumBytes: 10 }), /maximum_timeline_bytes/);
});

test('HDP Discovery akzeptiert nur den vollständigen normativen TXT-Vertrag', () => {
  const instance = `${DEVICE_ID}._homeess-hdp._tcp.local`;
  const txt = {
    device_id: DEVICE_ID, protocol_version: '1.0-draft', firmware_version: '0.2.0',
    platform: 'esp8266', pairing_state: 'paired', binding_id: BINDING_ID,
    configured_device_type: 'percentage_indicator', hardware_config_present: 'true',
    config_revision: '4', api_port: '80', ws_port: '81', ota_port: '8080',
  };
  const records = [
    { name: discovery.SERVICE, type: 12, value: instance },
    { name: instance, type: 33, value: { port: 80, target: 'badge.local' } },
    { name: instance, type: 16, value: txt },
    { name: 'badge.local', type: 1, value: '192.168.1.40' },
  ];
  assert.deepEqual(discovery.devicesFromRecords(records)[0], {
    deviceId: DEVICE_ID, serviceName: instance, hostname: 'badge.local',
    address: '192.168.1.40', apiPort: 80, wsPort: 81, otaPort: 8080,
    protocolVersion: '1.0-draft', firmwareVersion: '0.2.0', platform: 'esp8266',
    pairingState: 'paired', bindingId: BINDING_ID, deviceType: 'percentage_indicator',
    hardwareConfigPresent: true, configRevision: 4, pairable: false,
  });
  const profiled = records.map((record) => record.type === 16
    ? {
      ...record,
      value: {
        ...txt, runtime_profile: 'pixel-timeline-v1',
        configured_device_type: 'custom.plugin-view',
      },
    } : record);
  assert.equal(discovery.devicesFromRecords(profiled)[0].runtimeProfile, 'pixel-timeline-v1');
  assert.equal(discovery.devicesFromRecords(profiled)[0].runtimeCompatible, true);
  assert.equal(discovery.devicesFromRecords(profiled)[0].deviceType, 'custom.plugin-view');
  const mismatched = profiled.map((record) => record.type === 16
    ? { ...record, value: { ...record.value, runtime_profile: 'other-runtime' } } : record);
  assert.equal(discovery.devicesFromRecords(mismatched)[0].runtimeMismatch, true);
  const incomplete = records.map((record) => record.type === 16
    ? { ...record, value: { ...txt, binding_id: undefined } } : record);
  assert.deepEqual(discovery.devicesFromRecords(incomplete), []);
});

test('HDP Pairing sendet das exakte Binding-Profil und aktiviert erst nach match', async (t) => {
  const calls = [];
  let paired = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url === '/api/v1/device') return sendJson(res, deviceInfo(paired));
      if (req.url === '/api/v1/manifest') return sendJson(res, manifest());
      if (req.url === '/api/v1/status') return sendJson(res, status());
      if (req.url === '/api/v1/config') return sendJson(res, hardwareConfig());
      if (req.url === '/api/v1/pairing/status') return sendJson(res, paired ? {
        pairing_state: 'paired', paired: true, binding_id: BINDING_ID,
        binding_status: req.headers['x-hdp-binding-key'] === BINDING_KEY ? 'match' : 'not_checked',
        paired_to_requester: req.headers['x-hdp-binding-key'] === BINDING_KEY ? true : null,
      } : {
        pairing_state: 'pairable', paired: false, binding_id: null,
        binding_status: 'unpaired', paired_to_requester: req.headers['x-hdp-binding-key'] ? false : null,
      });
      if (req.url === '/api/v1/pairing/start') return sendJson(res, {
        pairing_session: SESSION, adapter_nonce: ADAPTER_NONCE, device_nonce: DEVICE_NONCE,
        expires_in_ms: 120000, security_profile: 'local-binding-key-v1',
      }, 201);
      if (req.url === '/api/v1/pairing/confirm') {
        paired = true;
        return sendJson(res, {
          paired: true, device_id: DEVICE_ID, instance_id: INSTANCE_ID, binding_id: BINDING_ID,
        });
      }
      res.statusCode = 404;
      return res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new HdpClient({
    deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: server.address().port,
  });
  const result = await client.pair({
    instanceId: INSTANCE_ID, adapterNonce: ADAPTER_NONCE, bindingKey: BINDING_KEY,
  });
  assert.equal(result.bindingId, BINDING_ID);
  assert.deepEqual(calls.find((call) => call.url.endsWith('/pairing/start')).body, {
    instance_id: INSTANCE_ID, protocol_version: '1.0-draft', adapter_nonce: ADAPTER_NONCE,
  });
  assert.deepEqual(calls.find((call) => call.url.endsWith('/pairing/confirm')).body, {
    pairing_session: SESSION, instance_id: INSTANCE_ID, adapter_nonce: ADAPTER_NONCE,
    device_nonce: DEVICE_NONCE, binding_key: BINDING_KEY,
  });
  const checked = calls.filter((call) => call.url.endsWith('/pairing/status')).at(-1);
  assert.equal(checked.headers['x-hdp-instance'], INSTANCE_ID);
  assert.equal(checked.headers['x-hdp-binding-key'], BINDING_KEY);
});

test('HDP Pairing rekonstruiert eine verlorene Confirm-Antwort und lehnt Konflikte ab', async () => {
  class RecoveryClient extends HdpClient {
    constructor(bindingStatus) {
      super({ deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80 });
      this.bindingStatusAfterConfirm = bindingStatus;
      this.confirmAttempts = 0;
    }

    async assertPairable() {
      return { device: { device_id: DEVICE_ID }, manifest: manifest(), status: status() };
    }

    async pairingStatus(withCredentials) {
      if (!withCredentials) {
        return {
          pairing_state: 'pairable', paired: false, binding_id: null,
          binding_status: 'unpaired', paired_to_requester: null,
        };
      }
      return {
        pairing_state: 'paired', paired: true, binding_id: BINDING_ID,
        binding_status: this.bindingStatusAfterConfirm,
        paired_to_requester: this.bindingStatusAfterConfirm === 'match',
      };
    }

    async config() {
      return hardwareConfig();
    }

    async request(endpoint) {
      if (endpoint === 'pairing/start') {
        return {
          pairing_session: SESSION, adapter_nonce: ADAPTER_NONCE,
          device_nonce: DEVICE_NONCE, expires_in_ms: 120000,
          security_profile: 'local-binding-key-v1',
        };
      }
      if (endpoint === 'pairing/confirm') {
        this.confirmAttempts += 1;
        throw Object.assign(new Error('Antwort verloren'), { uncertain: true });
      }
      throw new Error(endpoint);
    }
  }
  const recovered = await new RecoveryClient('match').pair({
    instanceId: INSTANCE_ID, adapterNonce: ADAPTER_NONCE, bindingKey: BINDING_KEY,
  });
  assert.equal(recovered.bindingId, BINDING_ID);
  assert.equal(recovered.confirmed.binding_id, BINDING_ID);

  await assert.rejects(new RecoveryClient('conflict').pair({
    instanceId: INSTANCE_ID, adapterNonce: ADAPTER_NONCE, bindingKey: BINDING_KEY,
  }), (error) => error.code === 'ALREADY_PAIRED');
});

test('HDP gleicht eine verlorene PUT-config-Antwort ab statt blind weiterzuschreiben', async (t) => {
  let config = hardwareConfig(4);
  let puts = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET') return sendJson(res, config);
      puts += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      config = { revision: 5, ...body.config };
      req.socket.destroy();
      return undefined;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new HdpClient({
    deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: server.address().port,
  }, { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY });
  const result = await client.putConfig(4, hardwareConfig(4), {
    argb_pins: [2], led_types: ['WS2812'], color_orders: ['GRB'], maximum_led_count: 300,
  });
  assert.equal(result.revision, 5);
  assert.equal(puts, 1);
});

test('HDP WebSocket wartet auf session.ready, prüft Sequenzen und nutzt exakten Backoff', async () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; this.rawSent = []; this.closed = false; }
    send(value) { this.rawSent.push(value); this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; this.readyState = 3; }
  }
  const sockets = [];
  let wsOptions;
  const connection = new RuntimeConnection({
    device: { deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80, wsPort: 81, configRevision: 4 },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    getConfigRevision: () => 4,
    random: () => 0,
    wsFactory(_url, options) {
      wsOptions = options;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  connection.start();
  const socket = sockets[0];
  socket.readyState = 1;
  socket.emit('open');
  const state = {
    percentage: 73.4, color: { r: 0, g: 255, b: 0 },
    brightness: 60, transitionMilliseconds: 250,
  };
  const legacyRuntime = new LegacyRuntimeAdapter(connection);
  legacyRuntime.sendState(state);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'device.hello', message_id: 'device-1', sequence: 1,
    payload: {
      device_id: DEVICE_ID, protocol_version: '1.0-draft', config_revision: 4,
      heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000,
    },
  })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.map((item) => item.type), ['homeess.hello']);
  assert.equal(typeof socket.rawSent[0], 'string');
  assert.ok(Buffer.byteLength(socket.rawSent[0], 'utf8') <= 1024);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'session.ready', message_id: 'device-2', sequence: 2, payload: { config_revision: 4 },
  })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.map((item) => item.type), ['homeess.hello', 'state.set']);
  assert.equal(wsOptions.headers.Authorization, auth.basicAuthorization({
    instanceId: INSTANCE_ID, bindingKey: BINDING_KEY,
  }));
  assert.deepEqual(RECONNECT_DELAYS, [1000, 2000, 5000, 10000, 30000]);
  assert.equal(connection.reconnectDelay(), 1000);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'pong', message_id: 'device-4', sequence: 4, payload: {},
  })), false);
  assert.equal(socket.closed, true);
  connection.stop();
});

test('HDP WebSocket macht Firmware-Headerfehler und den nächsten Retry sichtbar', async () => {
  class FakeSocket extends EventEmitter {
    close() { this.readyState = 3; }
  }
  const states = [];
  const warnings = [];
  let socket;
  const connection = new RuntimeConnection({
    device: { deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80, wsPort: 81 },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    random: () => 0,
    wsFactory() {
      socket = new FakeSocket();
      return socket;
    },
  });
  connection.on('connectionState', (event) => states.push(event));
  connection.on('warning', (error) => warnings.push(error));
  connection.start();
  socket.emit('error', Object.assign(new Error('Parse Error: Invalid header token'), {
    code: 'HPE_INVALID_HEADER_TOKEN',
  }));
  socket.emit('close');

  assert.equal(connectionErrorMessage(warnings[0]),
    'Das Gerät sendet beim WebSocket-Upgrade syntaktisch ungültige HTTP-Header.');
  assert.equal(connectionErrorMessage(new Error('Opening handshake has timed out')),
    'Das Gerät hat den WebSocket-Upgrade nicht innerhalb von 3000 ms beantwortet.');
  assert.deepEqual(states.map((event) => event.state), ['connecting', 'reconnecting']);
  assert.equal(states[1].attempt, 1);
  assert.equal(states[1].delay, 1000);
  assert.match(states[1].nextAttemptAt, /^\d{4}-\d\d-\d\dT/);
  connection.stop();
  assert.equal(connection.reconnectTimer, null);
  assert.equal(states.at(-1).state, 'stopped');
});

test('pixel-timeline-v1 wird in beiden Hello-Nachrichten exakt abgeglichen', async () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  let socket;
  const errors = [];
  const connection = new RuntimeConnection({
    device: {
      deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80, wsPort: 81,
      configRevision: 4, runtimeProfile: 'pixel-timeline-v1',
    },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    maximumMessageBytes: 2048,
    getConfigRevision: () => 4,
    wsFactory() { socket = new FakeSocket(); return socket; },
  });
  connection.on('deviceError', (error) => errors.push(error));
  assert.equal(connection.sendState, undefined);
  connection.start();
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'device.hello', message_id: 'device-1', sequence: 1,
    payload: {
      device_id: DEVICE_ID, protocol_version: '1.0-draft',
      runtime_profile: 'pixel-timeline-v1', config_revision: 4,
      heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000,
    },
  })), false);
  assert.equal(socket.sent[0].payload.runtime_profile, 'pixel-timeline-v1');
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'session.ready', message_id: 'device-2', sequence: 2,
    payload: { config_revision: 4, runtime_profile: 'pixel-timeline-v1' },
  })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.ready, true);
  connection.stop();

  const mismatch = new RuntimeConnection({
    device: {
      deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80, wsPort: 81,
      configRevision: 4, runtimeProfile: 'pixel-timeline-v1',
    },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    wsFactory() { socket = new FakeSocket(); return socket; },
  });
  mismatch.on('deviceError', (error) => errors.push(error));
  mismatch.start();
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'device.hello', message_id: 'device-1', sequence: 1,
    payload: {
      device_id: DEVICE_ID, protocol_version: '1.0-draft',
      runtime_profile: 'wrong', config_revision: 4,
      heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000,
    },
  })), false);
  assert.equal(errors.at(-1).code, 'UNSUPPORTED_RUNTIME_PROFILE');
  mismatch.stop();
});

test('HDP OTA signiert/verifiziert die rohen SHA-256-Bytes und nutzt Binding-Header', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-fw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'firmware.bin');
  const bytes = Buffer.from('firmware-image');
  fs.writeFileSync(file, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const keys = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, Buffer.from(sha256, 'hex'), keys.privateKey).toString('base64');
  const artifact = {
    platform: 'esp8266', board: 'd1_mini', variant: 'generic',
    filename: 'firmware.bin', size_bytes: bytes.length, sha256, signature,
  };
  const checked = await firmware.validateArtifactFile(file, artifact, {
    requireSignature: true, publicKey: keys.publicKey,
  });
  assert.equal(checked.signature.verified, true);
  const headers = firmware.otaHeaders({
    release: {
      firmware_name: 'hdp-firmware', version: '0.3.0', channel: 'development',
      config_schema_version: 1,
    },
  }, artifact, { protocol_version: '1.0-draft' }, {
    instanceId: INSTANCE_ID, bindingKey: BINDING_KEY,
  }, false);
  assert.equal(headers['X-HDP-Binding-Key'], BINDING_KEY);
  assert.equal(headers['X-HDP-OTA-Token'], undefined);
  assert.equal(headers['X-HDP-Firmware-Signature'], signature);
});

test('HDP Adapter persistiert Pairing-Secrets und gruppiert die Gerätekonfiguration', async () => {
  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {}
    stop() {}
    refresh() {}
  }
  const events = [];
  class FakeClient {
    constructor(device, credentials) { this.device = device; this.credentials = credentials; }
    update(device, credentials) { this.device = device; this.credentials = credentials; }
    async pair(pending) {
      events.push('pair');
      assert.match(pending.bindingKey, /^[0-9a-f]{64}$/);
      assert.match(pending.adapterNonce, /^[0-9a-f]{32}$/);
      assert.ok(events.indexOf('secret') < events.indexOf('pair'));
      assert.ok(events.indexOf('storage') < events.indexOf('pair'));
      return {
        device: deviceInfo(true), manifest: manifest(), status: { ...status(), state: 'paired', paired: true },
        existingConfig: hardwareConfig(), bindingId: auth.bindingId(pending.bindingKey),
      };
    }
    async firmware() { return { ota_supported: false }; }
    async firmwareStatus() { return { state: 'idle' }; }
  }
  class FakeConnection extends EventEmitter {
    start() {}
    stop() {}
    sendState() { return false; }
    updateDevice() {}
  }
  const storage = {};
  const secrets = new Map();
  const host = {
    async getInstanceIdentity() { return { instanceId: INSTANCE_ID, fingerprint: 'a'.repeat(64) }; },
    async getSecret(key) { return secrets.get(key) || null; },
    async setSecret(key, value) { events.push('secret'); secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
    async persistStorage(key, value) { events.push('storage'); storage[key] = value; },
    setStorage(key, value) { storage[key] = value; },
    subscribeState() { return () => {}; },
    setStates() {}, publishStates() {}, setConnected() {}, log() {}, warn() {}, error() {},
  };
  const adapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  await adapter.start({});
  FakeDiscovery.last.emit('found', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    firmwareVersion: '0.2.0', platform: 'esp8266', pairingState: 'pairable',
    bindingId: null, pairable: true, hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  const response = await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/pair`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  assert.equal(response.status, 303);
  assert.equal(storage.hdpDevices[0].bindingState, 'active');
  assert.equal(storage.hdpDevices[0].bindingKey, undefined);
  assert.match(secrets.get(`device-${DEVICE_ID}`), /^[0-9a-f]{64}$/);

  const devicePage = await adapter.handleManagementRequest({
    method: 'GET', path: `/device/${DEVICE_ID}`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  assert.equal(devicePage.status, 200);
  const body = devicePage.view.body;
  const sections = [
    'Anzeigewert und Skalierung',
    'Farbdarstellung',
    'Dynamische Helligkeit',
    'Richtungsindikator',
    'Update-Automatik',
    'Firmware manuell aktualisieren',
  ];
  for (let index = 1; index < sections.length; index += 1) {
    assert.ok(body.indexOf(sections[index - 1]) < body.indexOf(sections[index]),
      `${sections[index - 1]} steht vor ${sections[index]}`);
  }
  assert.match(body, /<dialog id="hdp-hardware-dialog"/);
  assert.match(body, /Hardware auf Gerät speichern/);
  assert.ok(body.indexOf('Gerät entkoppeln') < body.indexOf('id="hdp-hardware-dialog"'),
    'Hardwarefelder liegen außerhalb des regulären Seitenflusses im Unterdialog');
  assert.match(devicePage.view.script, /function hdpOpenHardware/);
  adapter.stop();
});
