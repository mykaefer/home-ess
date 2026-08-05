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
const { ReleaseStore } = require('../adapter/hdp/release-store');
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

function binaryManifest(runtimeProfile = 'binary-io-v1') {
  return {
    ...pixelManifest(), runtime_profile: runtimeProfile,
    device_type_profile: 'boot-dispatch-v1',
    device_types: ['percentage_indicator', 'binary_io'],
    features: {
      ...pixelManifest().features, binary_input: true, binary_output: true,
    },
    hardware_capabilities: {
      ...pixelManifest().hardware_capabilities,
      // Wie die Referenzfirmware: Binary-I/O und ARGB teilen sich dieselben GPIOs.
      argb_pins: [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16],
      binary_pins: [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16],
      binary_pullup_pins: [0, 1, 2, 3, 4, 5, 12, 13, 14],
      binary_boot_sensitive_pins: [0, 2, 15],
      binary_serial_pins: [1, 3],
      binary_input_types: ['switch', 'button'],
    },
    limits: {
      ...pixelManifest().limits,
      maximum_binary_pins: 11,
      binary_input_debounce_milliseconds: 30,
    },
  };
}

function binaryConfig(revision = 7) {
  return {
    revision, device_type: 'binary_io',
    pins: [
      { pin: 4, direction: 'input', input_type: 'switch' },
      { pin: 5, direction: 'input', input_type: 'button' },
      { pin: 12, direction: 'output' },
    ],
  };
}

function deviceInfo(paired = false) {
  return {
    device_id: DEVICE_ID, model: 'hDP Universal ESP8266', platform: 'esp8266',
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

test('hDP verwendet exakte Nonce-, Binding- und Identifikatorformate', () => {
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

test('hDP validiert Konfiguration und Laufzeitwerte ohne Typkonvertierung', () => {
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

test('hDP Richtungsindikator ist capability-gesteuert und löst Rising/Falling eindeutig auf', () => {
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

test('hDP normalisiert Skalierungsartefakte im Prozentwert', () => {
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

  device.bindings.brightness.mode = 'separate_numeric_source';
  device.rawBrightness = 42.6;
  const brightnessState = createHdpAdapter._test.calculateState(device);
  assert.equal(brightnessState.brightness, 43);
  assert.equal(device.requestedBrightness, 43);
  assert.equal(createHdpAdapter._test.hardwareBrightnessLimit(device), 35);
  assert.equal(createHdpAdapter._test.effectiveDynamicBrightness(device), 15);
  device.reportedBrightnessLimit = 35;
  device.rawBrightness = 50;
  createHdpAdapter._test.calculateState(device);
  assert.equal(device.effectiveBrightness, 18);
  assert.doesNotThrow(() => renderPercentageFrame({
    pixelCount: 4,
    percentage: brightnessState.percentage,
    color: brightnessState.color,
    brightness: brightnessState.brightness,
    fractional: true,
  }));
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

test('binary-io-v1 Manifest, Pinkonfiguration und Adapteraktionen sind strikt getrennt', () => {
  const manifest = binaryManifest();
  assert.equal(validateManifestInfo(manifest), manifest);
  assert.deepEqual(validation.validateHardwareConfig(binaryConfig(), manifest), binaryConfig());
  assert.throws(() => validation.validateHardwareConfig({
    ...binaryConfig(), pins: [...binaryConfig().pins, { pin: 4, direction: 'output' }],
  }, manifest), /eindeutig/);
  // Binary-I/O nutzt dieselben GPIOs wie der ARGB-Ausgang; GPIO 2 trägt sonst
  // die LED-Leiste und muss deshalb auch hier wählbar sein.
  assert.deepEqual(
    manifest.hardware_capabilities.binary_pins,
    manifest.hardware_capabilities.argb_pins,
  );
  for (const pin of manifest.hardware_capabilities.binary_pins) {
    assert.deepEqual(validation.validateHardwareConfig({
      ...binaryConfig(), pins: [{ pin, direction: 'output' }],
    }, manifest).pins, [{ pin, direction: 'output' }]);
  }
  assert.throws(() => validation.validateHardwareConfig({
    ...binaryConfig(), pins: [{ pin: 6, direction: 'input', input_type: 'switch' }],
  }, manifest), /nicht unterstützt/);
  assert.throws(() => validation.validateHardwareConfig({
    ...binaryConfig(), pins: [{ pin: 4, direction: 'output', input_type: 'button' }],
  }, manifest), /keinen input_type/);
  // Die Pineigenschaften sind optional (Firmware 0.4.0), müssen aber eine
  // eindeutige Teilmenge von binary_pins sein, wenn sie vorhanden sind.
  const withoutTraits = { ...manifest, hardware_capabilities: { ...manifest.hardware_capabilities } };
  for (const key of require('../adapter/hdp/client').BINARY_PIN_TRAIT_KEYS) {
    delete withoutTraits.hardware_capabilities[key];
  }
  assert.equal(validateManifestInfo(withoutTraits), withoutTraits);
  assert.throws(() => validateManifestInfo({
    ...manifest,
    hardware_capabilities: { ...manifest.hardware_capabilities, binary_pullup_pins: [4, 4] },
  }), /binary_pullup_pins/);
  assert.throws(() => validateManifestInfo({
    ...manifest,
    hardware_capabilities: { ...manifest.hardware_capabilities, binary_serial_pins: [99] },
  }), /binary_serial_pins/);
  const helpers = createHdpAdapter._test;
  assert.equal(helpers.binaryEventTarget({ action: 'state' }, null, true), true);
  assert.equal(helpers.binaryEventTarget({ action: 'toggle' }, 'on', true), false);
  assert.equal(helpers.binaryEventTarget({ action: 'set', set_value: 'scene-a' }, null, true), 'scene-a');
  assert.equal(helpers.binaryEventTarget({ action: 'counter', counter_step: 2 }, 7, true), 9);
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

test('OutputClient ändert Laufzeithelligkeit ohne Frame oder Timeline neu zu starten', async () => {
  const calls = [];
  const manifest = pixelManifest();
  manifest.features.runtime_brightness = true;
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type !== 'output.brightness.set') throw new Error(`Unerwarteter Request ${type}`);
      return { type: 'output.brightness.applied', payload: {
        reply_to: 'x', output_id: payload.output_id,
        config_revision: payload.config_revision,
        brightness_percent: payload.brightness_percent,
        applied_at_uptime_milliseconds: 123,
      } };
    },
  };
  const client = new OutputClient({
    transport, manifest, getConfig: () => outputConfig(),
  });

  assert.equal((await client.setRuntimeBrightness('main', 72)).unchanged, false);
  assert.equal((await client.setRuntimeBrightness('main', 72)).unchanged, true);
  assert.deepEqual(calls.map((call) => call.type), ['output.brightness.set']);
  assert.equal(client.activeTimelines.size, 0);
});

test('Ein statischer Frame beendet eine gemerkte Indicator-Timeline mit absolutem Replace', async () => {
  const calls = [];
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload });
      if (type === 'output.timeline.stop') {
        return {
          type: 'output.timeline.stopped',
          payload: {
            reply_to: 'adapter-1', output_id: payload.output_id,
            timeline_id: payload.timeline_id, behavior: payload.behavior,
          },
        };
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
  assert.equal(calls[0].type, 'output.timeline.stop');
  assert.equal(calls[0].payload.behavior, 'hold');
  assert.equal(calls[1].type, 'output.frame.set');
  assert.equal(calls[1].payload.mode, 'replace');
  assert.equal(client.activeTimelines.has('main'), false);
  assert.equal(client.desired.get('main').kind, 'frame');
});

test('OutputClient serialisiert parallele Frames und wiederholt eine Rate-Limit-Ablehnung einmal', async () => {
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let rateLimited = true;
  const calls = [];
  const transport = {
    ready: true,
    async request(type, payload) {
      assert.equal(type, 'output.frame.set');
      calls.push(payload.frame_id);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeRequests -= 1;
      if (rateLimited) {
        rateLimited = false;
        throw Object.assign(new Error('zu schnell'), { code: 'OUTPUT_RATE_LIMITED' });
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
    pixelCount: 4, percentage: 25, color: { r: 255, g: 0, b: 0 },
    brightness: 100, fractional: true,
  });
  const second = renderPercentageFrame({
    pixelCount: 4, percentage: 75, color: { r: 0, g: 255, b: 0 },
    brightness: 100, fractional: true,
  });
  await Promise.all([client.setFrame('main', first), client.setFrame('main', second)]);
  assert.equal(maximumActiveRequests, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], calls[1], 'die Rate-Limit-Wiederholung behält dieselbe Frame-ID');
  assert.notEqual(calls[1], calls[2]);
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

test('OutputClient startet eine bereits laufende identische Timeline nicht neu', async () => {
  const calls = [];
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type === 'output.status.get') {
        return { type: 'output.status', payload: {
          reply_to: 'x', output_id: 'main', config_revision: 4,
          mode: 'timeline_playing', frame_id: null,
          timeline_id: 'indicator-loop', loop: true,
          position_milliseconds: 137,
        } };
      }
      throw new Error(`Unerwarteter Request ${type}`);
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });

  assert.equal((await client.play('main', 'indicator-loop', true, 0)).unchanged, true);
  assert.deepEqual(calls.map((call) => call.type), ['output.status.get']);
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

test('OutputClient räumt eine nach Sitzungsneuaufbau weiterlaufende Timeline vor dem Upload frei', async () => {
  const calls = [];
  let playing = true;
  let busy = true;
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type === 'output.status.get') {
        return { type: 'output.status', payload: {
          reply_to: 'x', output_id: 'main', config_revision: 4,
          mode: playing ? 'timeline_playing' : 'idle',
          frame_id: null, timeline_id: playing ? 'fremde-loop' : null,
          loop: playing ? true : null, position_milliseconds: playing ? 40 : null,
        } };
      }
      if (type === 'output.timeline.stop') {
        playing = false;
        busy = false;
        return { type: 'output.timeline.stopped', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          behavior: payload.behavior,
        } };
      }
      if (type === 'output.timeline.begin') {
        if (busy) {
          throw Object.assign(new Error('Stop or replace the running timeline first.'), {
            code: 'OUTPUT_BUSY',
          });
        }
        return { type: 'output.timeline.ready', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          next_offset: 0, maximum_chunk_bytes: 512,
        } };
      }
      if (type === 'output.timeline.chunk') {
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
      if (type === 'output.timeline.play') {
        return { type: 'output.timeline.playing', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          loop: payload.loop, scheduled_start_uptime_milliseconds: 0,
        } };
      }
      throw new Error(`Unerwarteter Request ${type}`);
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  // Sitzungsverlust: Der Adapter kennt die laufende Timeline nicht mehr, das
  // Gerät spielt sie aber weiter.
  client.desired.set('main', { kind: 'timeline', timelineId: 'eigene-loop', timeline });
  client.sessionStarted();

  await client.setTimeline('main', 'eigene-loop', timeline);
  const types = calls.map((call) => call.type);
  assert.deepEqual(types.slice(0, 2), ['output.status.get', 'output.timeline.stop']);
  assert.equal(calls[1].payload.timeline_id, 'fremde-loop');
  assert.equal(calls[1].payload.behavior, 'hold');
  assert.equal(types.filter((type) => type === 'output.timeline.begin').length, 1);
  assert.deepEqual(client.activeTimelines.get('main'), {
    timelineId: 'eigene-loop', sha256: timeline.sha256,
  });
  // Die Wunschlage überlebt das Freiräumen, sonst ginge sie beim nächsten
  // Sitzungsneuaufbau verloren.
  assert.equal(client.desired.get('main').timelineId, 'eigene-loop');

  // Der Sitzungsabgleich läuft genau einmal; der zusätzliche Statusabruf ist
  // ausschließlich die Play-Sicherung gegen einen doppelten Neustart.
  const before = calls.filter((call) => call.type === 'output.status.get').length;
  await client.setTimeline('main', 'andere-loop', timeline);
  assert.equal(calls.filter((call) => call.type === 'output.status.get').length, before + 1);
});

test('OutputClient übernimmt eine bereits laufende Wunschtimeline ohne Neustart', async () => {
  const calls = [];
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type === 'output.status.get') {
        return { type: 'output.status', payload: {
          reply_to: 'x', output_id: 'main', config_revision: 4, mode: 'timeline_playing',
          frame_id: null, timeline_id: 'eigene-loop', loop: true, position_milliseconds: 30,
        } };
      }
      throw new Error(`Unerwarteter Request ${type}`);
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  client.desired.set('main', { kind: 'timeline', timelineId: 'eigene-loop', timeline });
  client.sessionStarted();

  assert.equal((await client.setTimeline('main', 'eigene-loop', timeline)).unchanged, true);
  assert.deepEqual(calls.map((call) => call.type), ['output.status.get']);
  assert.deepEqual(client.activeTimelines.get('main'), {
    timelineId: 'eigene-loop', sha256: timeline.sha256,
  });
});

test('OutputClient räumt einen unerwarteten OUTPUT_BUSY beim Begin einmalig frei', async () => {
  const calls = [];
  let busy = true;
  const timeline = encodeTimeline([
    { delta_milliseconds: 0, operations: [{ op: 'FILL', r: 0, g: 0, b: 0 }] },
  ], {
    pixelCount: 4, durationMilliseconds: 100,
    minimumFrameIntervalMilliseconds: 20, maximumEvents: 4096, maximumBytes: 65536,
  });
  const transport = {
    ready: true,
    async request(type, payload) {
      calls.push({ type, payload: structuredClone(payload) });
      if (type === 'output.timeline.begin') {
        if (busy) {
          throw Object.assign(new Error('Stop or replace the running timeline first.'), {
            code: 'OUTPUT_BUSY',
          });
        }
        return { type: 'output.timeline.ready', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          next_offset: 0, maximum_chunk_bytes: 512,
        } };
      }
      if (type === 'output.status.get') {
        return { type: 'output.status', payload: {
          reply_to: 'x', output_id: 'main', config_revision: 4,
          mode: busy ? 'timeline_playing' : 'idle', frame_id: null,
          timeline_id: busy ? 'fremde-loop' : null, loop: busy ? true : null,
          position_milliseconds: busy ? 10 : null,
        } };
      }
      if (type === 'output.timeline.stop') {
        busy = false;
        return { type: 'output.timeline.stopped', payload: {
          reply_to: 'x', output_id: 'main', timeline_id: payload.timeline_id,
          behavior: payload.behavior,
        } };
      }
      if (type === 'output.timeline.chunk') {
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
      throw new Error(`Unerwarteter Request ${type}`);
    },
  };
  const client = new OutputClient({
    transport, manifest: pixelManifest(), getConfig: () => outputConfig(),
  });
  // Der Ausgang gilt als abgeglichen; der Konflikt tritt erst beim Begin auf.
  client.reconciled.add('main');
  await client.uploadTimeline('main', 'eigene-loop', timeline);
  assert.deepEqual(calls.slice(0, 4).map((call) => call.type), [
    'output.timeline.begin', 'output.status.get', 'output.timeline.stop', 'output.timeline.begin',
  ]);
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
      if (type === 'output.status.get') {
        // Der abgebrochene Upload wurde nie committet; der Ausgang ist frei.
        return {
          type: 'output.status',
          payload: {
            reply_to: 'x', output_id: 'main', config_revision: 4, mode: 'idle',
            frame_id: null, timeline_id: null, loop: null, position_milliseconds: null,
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

test('hDP Discovery akzeptiert nur den vollständigen normativen TXT-Vertrag', () => {
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

test('hDP Discovery meldet unveränderte mDNS-Antworten nicht wiederholt', () => {
  const found = [];
  const updated = [];
  const instance = new discovery.Discovery({ intervalMs: 30000 });
  instance.on('found', (device) => found.push(device));
  instance.on('updated', (device) => updated.push(device));
  const device = {
    deviceId: DEVICE_ID, address: '192.168.1.20', hostname: 'hdp.local',
    apiPort: 80, wsPort: 81, pairingState: 'paired', bindingId: BINDING_ID,
  };
  instance.ingest([device], 1000);
  instance.ingest([device], 2000);
  assert.equal(found.length, 1);
  assert.equal(updated.length, 0);
  assert.equal(instance.devices.get(DEVICE_ID).lastSeenAt, 2000);
  instance.ingest([{ ...device, address: '192.168.1.21' }], 3000);
  assert.equal(updated.length, 1);
});

test('hDP Pairing sendet das exakte Binding-Profil und aktiviert erst nach match', async (t) => {
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

test('hDP Pairing rekonstruiert eine verlorene Confirm-Antwort und lehnt Konflikte ab', async () => {
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

test('hDP gleicht eine verlorene PUT-config-Antwort ab statt blind weiterzuschreiben', async (t) => {
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

test('hDP WebSocket wartet auf session.ready, prüft Sequenzen und nutzt exakten Backoff', async () => {
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

test('hDP WebSocket macht Firmware-Headerfehler und den nächsten Retry sichtbar', async () => {
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

test('hDP WebSocket ignoriert das verspätete Close einer ersetzten Sitzung', () => {
  class FakeSocket extends EventEmitter {
    close() { this.readyState = 3; }
  }
  const sockets = [];
  const connection = new RuntimeConnection({
    device: {
      deviceId: DEVICE_ID, address: '192.168.1.20', apiPort: 80, wsPort: 81,
    },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    random: () => 0,
    wsFactory() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  let offline = 0;
  connection.on('offline', () => { offline += 1; });
  connection.start();
  const oldSocket = sockets[0];
  connection.ready = true;
  connection.updateDevice({
    deviceId: DEVICE_ID, address: '192.168.1.21', apiPort: 80, wsPort: 81,
  });
  assert.equal(sockets.length, 2);
  assert.equal(offline, 1);
  const newSocket = sockets[1];
  connection.ready = true;
  connection.heartbeatTimer = setInterval(() => {}, 60000);
  const heartbeat = connection.heartbeatTimer;
  oldSocket.emit('close');
  assert.equal(connection.socket, newSocket);
  assert.equal(connection.ready, true);
  assert.equal(connection.heartbeatTimer, heartbeat);
  assert.equal(offline, 1);
  connection.stop();
});

test('hDP gleicht aktive passende Bindings nicht bei jedem mDNS-Paket ab', () => {
  const { bindingNeedsReconcile } = createHdpAdapter._test;
  const active = {
    bindingState: 'active', paired: true, bindingId: BINDING_ID,
  };
  assert.equal(bindingNeedsReconcile(active, {
    pairingState: 'paired', bindingId: BINDING_ID,
  }), false);
  assert.equal(bindingNeedsReconcile(active, {
    pairingState: 'pairable', bindingId: null,
  }), true);
  assert.equal(bindingNeedsReconcile({
    bindingState: 'pending', paired: false, bindingId: null, pairingInProgress: true,
  }, {
    pairingState: 'pairing', bindingId: null,
  }), false);
  assert.equal(bindingNeedsReconcile({ ...active, bindingId: null }, {
    pairingState: 'paired', bindingId: BINDING_ID,
  }), true);
});

test('Eine erfolgreiche Ausgabe löscht nur einen vorherigen Outputfehler', () => {
  const { clearAppliedOutputError } = createHdpAdapter._test;
  const recovered = { lastError: '[OUTPUT_RATE_LIMITED] zu schnell' };
  assert.equal(clearAppliedOutputError(recovered), true);
  assert.equal(recovered.lastError, '');
  const confirmationRecovered = { lastError: '[REQUEST_TIMEOUT] Bestätigung fehlt' };
  assert.equal(clearAppliedOutputError(confirmationRecovered), true);
  assert.equal(confirmationRecovered.lastError, '');
  const unrelated = { lastError: '[WEBSOCKET] Verbindung verloren' };
  assert.equal(clearAppliedOutputError(unrelated), false);
  assert.equal(unrelated.lastError, '[WEBSOCKET] Verbindung verloren');
});

test('Ein hDP-Bestätigungstimeout erklärt den unklaren Befehl ohne das Gerät offline zu melden', async () => {
  const sent = [];
  const connection = new RuntimeConnection({
    device: { deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80, wsPort: 81 },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
  });
  connection.socket = {
    readyState: 1,
    send(value) { sent.push(JSON.parse(value)); },
  };
  connection.ready = true;

  await assert.rejects(connection.request('output.brightness.set', {
    output_id: 'main', config_revision: 4, brightness_percent: 72,
  }, 5), (error) => {
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    assert.equal(error.uncertain, true);
    assert.match(error.message, /hDP-Verbindung ist weiterhin aktiv/);
    assert.doesNotMatch(error.message, /offline/i);
    return true;
  });
  assert.equal(connection.ready, true);
  assert.equal(sent.length, 1);
});

test('pixel-timeline-v1 übernimmt den Gerätenamen getrennt vom Wire-Configobjekt', () => {
  const { requestedDeviceName } = createHdpAdapter._test;
  assert.equal(requestedDeviceName({ device_name: '  Kelleranzeige  ' }, 'Alt'),
    'Kelleranzeige');
  assert.equal(requestedDeviceName({}, 'Alt'), 'Alt');
  assert.equal(requestedDeviceName({ device_name: 'x'.repeat(120) }, '').length, 100);
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

test('binary-io-v1 wird ausgehandelt und aktive Eingangsereignisse werden validiert', async () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  let socket;
  const events = [];
  const errors = [];
  const connection = new RuntimeConnection({
    device: {
      deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: 80, wsPort: 81,
      configRevision: 7, runtimeProfile: 'binary-io-v1',
    },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    maximumMessageBytes: 2048,
    getConfigRevision: () => 7,
    wsFactory() { socket = new FakeSocket(); return socket; },
  });
  connection.on('binary', (message) => events.push(message));
  connection.on('deviceError', (error) => errors.push(error));
  connection.start();
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'device.hello', message_id: 'device-1', sequence: 1,
    payload: {
      device_id: DEVICE_ID, protocol_version: '1.0-draft',
      runtime_profile: 'binary-io-v1', config_revision: 7,
      heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000,
    },
  })), false);
  assert.equal(socket.sent[0].payload.runtime_profile, 'binary-io-v1');
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'session.ready', message_id: 'device-2', sequence: 2,
    payload: { config_revision: 7, runtime_profile: 'binary-io-v1' },
  })), false);
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'binary.input.event', message_id: 'device-3', sequence: 3,
    payload: {
      pin: 5, input_type: 'button', event: 'pressed', state: true,
      event_sequence: 1, occurred_at_uptime_milliseconds: 1234,
      config_revision: 7,
    },
  })), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.pin, 5);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'binary.input.event', message_id: 'device-4', sequence: 4,
    payload: {
      pin: 5, input_type: 'button', event: 'pressed', state: false,
      event_sequence: 2, occurred_at_uptime_milliseconds: 1300,
      config_revision: 7,
    },
  })), false);
  assert.equal(errors.at(-1).code, 'INVALID_REQUEST');
  connection.stop();
});

test('hDP OTA signiert/verifiziert die rohen SHA-256-Bytes und nutzt Binding-Header', async (t) => {
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
  assert.equal(headers['X-hDP-Binding-Key'], BINDING_KEY);
  assert.equal(headers['X-hDP-OTA-Token'], undefined);
  assert.equal(headers['X-hDP-Firmware-Signature'], signature);
});

test('Signatur wird nur mit hinterlegtem Prüfschlüssel erzwungen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-signature-'));
  const file = path.join(directory, 'image.bin');
  const payload = Buffer.from('firmware-image');
  fs.writeFileSync(file, payload);
  const digest = crypto.createHash('sha256').update(payload).digest();
  const artifact = {
    platform: 'esp8266', board: 'd1_mini', variant: 'generic', filename: 'image.bin',
    size_bytes: payload.length, sha256: digest.toString('hex'), signature: null,
  };
  const keys = crypto.generateKeyPairSync('ed25519');

  // Ohne Prüfschlüssel bleibt ein selbst gebautes, unsigniertes Image zulässig.
  const open = await firmware.validateArtifactFile(file, artifact, {});
  assert.equal(open.signature.status, 'not_present');

  // Sobald ein Vertrauensanker konfiguriert ist, ist die Signatur Pflicht.
  await assert.rejects(
    firmware.validateArtifactFile(file, artifact, { publicKey: keys.publicKey }),
    /keine authentifizierbare Signatur/,
  );

  const signed = {
    ...artifact,
    signature: crypto.sign(null, digest, keys.privateKey).toString('base64'),
  };
  const verified = await firmware.validateArtifactFile(file, signed, { publicKey: keys.publicKey });
  assert.equal(verified.signature.verified, true);

  // Eine kaputte Signatur ist auch ohne Prüfschlüssel niemals akzeptabel.
  const foreign = crypto.generateKeyPairSync('ed25519');
  const wrong = { ...artifact, signature: crypto.sign(null, digest, foreign.privateKey).toString('base64') };
  await assert.rejects(
    firmware.validateArtifactFile(file, wrong, { publicKey: keys.publicKey }),
    /Signatur ist ungültig/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Manueller Upload darf den Kanal überschreiben, das Manifest bleibt dabei wahrheitsgemäß', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-channel-'));
  const store = new ReleaseStore({ directory });
  const image = Buffer.alloc(1024, 3);
  const source = path.join(directory, 'upload.bin');
  fs.writeFileSync(source, image);
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');
  const manifest = {
    schema_version: 1,
    release: {
      firmware_name: 'hdp-firmware', version: '0.5.1', channel: 'development',
      published_at: '2026-08-02T06:01:24Z', build_id: '20260802-060124',
      protocol_min: '1.0-draft', protocol_max: '1.0-draft', config_schema_version: 3,
    },
    artifacts: [{
      platform: 'esp8266', board: 'd1_mini', variant: 'generic',
      filename: 'hdp-0.5.1-esp8266.bin', size_bytes: image.length, sha256, signature: null,
    }],
  };

  // Ohne Wunsch gilt die Vorgabe aus dem Manifest — so muss es auch beim
  // späteren automatischen Abholen bleiben.
  const untouched = store.saveManifest(manifest);
  assert.equal(untouched.channel, 'development');
  assert.equal(untouched.retargetedFrom, null);

  // Mit ausdrücklichem Wunsch wandert das Release in den gewählten Kanal — und
  // das dort abgelegte Manifest nennt ihn selbst, sonst widerspräche die Datei
  // ihrem Ablageort.
  const moved = store.saveManifest(manifest, { channel: 'beta' });
  assert.equal(moved.channel, 'beta');
  assert.equal(moved.retargetedFrom, 'development');
  assert.equal(moved.manifest.release.channel, 'beta');
  const written = JSON.parse(fs.readFileSync(path.join(directory, 'firmware', 'beta', 'manifest.json'), 'utf8'));
  assert.equal(written.release.channel, 'beta');
  assert.equal(store.release('beta').release.version, '0.5.1');

  // Das Artefakt landet dadurch in beiden Kanälen, weil beide es deklarieren.
  const stored = await store.saveArtifact({ path: source, filename: 'hdp-0.5.1-esp8266.bin' });
  assert.deepEqual(stored.stored.map((entry) => entry.channel).sort(), ['beta', 'development']);
  assert.ok(store.complete('beta') && store.complete('development'));

  // Die Eingabe selbst wird nicht verändert; der Aufrufer behält sein Objekt.
  assert.equal(manifest.release.channel, 'development');
  // Ein unbekannter Kanal ist ein Fehler, kein stiller Rückfall.
  assert.throws(() => store.saveManifest(manifest, { channel: 'nightly' }), /Unbekannter Release-Kanal/);
  // Ein leerer Wunsch ist kein Wunsch.
  assert.equal(store.saveManifest(manifest, { channel: '' }).channel, 'development');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Firmwarespeicher hält je Kanal ein vollständiges Release und wählt exakt passende Artefakte', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-store-'));
  const store = new ReleaseStore({ directory });
  const image = Buffer.alloc(2048, 7);
  const source = path.join(directory, 'upload.bin');
  fs.writeFileSync(source, image);
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');
  const manifest = (version, channel = 'development') => ({
    schema_version: 1,
    release: {
      firmware_name: 'hdp-firmware', version, channel,
      published_at: '2026-07-31T19:42:08Z', build_id: '20260731-194208',
      protocol_min: '1.0-draft', protocol_max: '1.0-draft', config_schema_version: 3,
    },
    artifacts: [
      { platform: 'esp8266', board: 'd1_mini', variant: 'generic', filename: 'hdp-0.4.1-esp8266.bin', size_bytes: image.length, sha256, signature: null },
      { platform: 'esp32', board: 'esp32dev', variant: 'generic', filename: 'hdp-0.4.1-esp32.bin', size_bytes: image.length, sha256, signature: null },
    ],
  });

  const saved = store.saveManifest(manifest('0.4.1'));
  assert.equal(saved.channel, 'development');
  assert.equal(saved.missing.length, 2, 'ohne Dateien ist der Kanal unvollständig');
  assert.equal(store.complete('development'), false);

  const info = {
    name: 'hdp-firmware', version: '0.4.0', platform: 'esp8266', board: 'd1_mini',
    variant: 'generic', protocol_version: '1.0-draft', config_schema_version: 3,
    ota_supported: true, maximum_image_size_bytes: 1044464, free_update_space_bytes: 2670592,
  };
  const incomplete = store.candidateFor(info, 'development');
  assert.equal(incomplete.available, false);
  assert.match(incomplete.reason, /fehlt im Firmwarespeicher/);

  await store.saveArtifact({ path: source, filename: 'hdp-0.4.1-esp8266.bin' });
  await store.saveArtifact({ path: source, filename: 'hdp-0.4.1-esp32.bin' });
  assert.equal(store.complete('development'), true);

  const candidate = store.candidateFor(info, 'development');
  assert.equal(candidate.available, true);
  // Eine Firmware, viele Varianten: Es zählt die exakte Plattform/Board/Variante.
  assert.equal(candidate.artifact.filename, 'hdp-0.4.1-esp8266.bin');
  assert.equal(candidate.release.version, '0.4.1');
  assert.equal(fs.readFileSync(candidate.file).length, image.length);
  assert.equal(store.candidateFor({ ...info, platform: 'esp32', board: 'esp32dev' }, 'development')
    .artifact.filename, 'hdp-0.4.1-esp32.bin');

  // Ein Schemasprung darf ein Update nicht verhindern — die Firmware bringt
  // dafür eine Migration mit und prüft die Metadaten beim Empfang erneut.
  const older = store.candidateFor({ ...info, version: '0.3.1', config_schema_version: 2 }, 'development');
  assert.equal(older.available, true);
  assert.equal(older.release.version, '0.4.1');
  // Ein Rückschritt des Schemas bleibt gesperrt.
  const backwards = store.candidateFor({ ...info, version: '0.4.0', config_schema_version: 4 }, 'development');
  assert.equal(backwards.available, false);
  assert.match(backwards.reason, /lässt sich nicht auf 3 zurücksetzen/);

  // Derselbe Stand ist kein Update, eine bewusste Neuinstallation aber möglich.
  const current = store.candidateFor({ ...info, version: '0.4.1' }, 'development');
  assert.equal(current.available, false);
  assert.match(current.reason, /läuft bereits auf 0\.4\.1/);
  assert.equal(store.candidateFor({ ...info, version: '0.4.1' }, 'development',
    { allowDowngrade: true }).available, true);
  const newer = store.candidateFor({ ...info, version: '0.5.0' }, 'development');
  assert.equal(newer.available, false);
  assert.match(newer.reason, /Downgrade/);

  // Andere Kanäle bleiben unberührt.
  assert.equal(store.candidateFor(info, 'stable').available, false);
  assert.equal(store.release('stable'), null);
  assert.throws(() => store.candidateFor(info, 'nightly'), /Unbekannter Release-Kanal/);

  // Ein Versionswechsel räumt die Artefakte des Vorgängers weg, damit im Kanal
  // keine zwei Stände nebeneinander liegen.
  const previousFile = candidate.file;
  store.saveManifest(manifest('0.4.2'));
  assert.equal(fs.existsSync(previousFile), false);
  assert.equal(store.complete('development'), false);

  // Ein Artefakt ohne passendes Manifest wird nicht angenommen.
  await assert.rejects(
    store.saveArtifact({ path: source, filename: 'fremde-firmware.bin' }),
    /kein Release-Manifest hinterlegt/,
  );
  await assert.rejects(store.saveArtifact({ path: source, filename: '../escape.bin' }), /ungültig/);

  // Ein neu erzeugter Speicher liest den Bestand von der Platte.
  const reopened = new ReleaseStore({ directory });
  reopened.load();
  assert.equal(reopened.release('development').release.version, '0.4.2');
  reopened.removeChannel('development');
  assert.equal(reopened.release('development'), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

// Gemeinsames Prüfgerüst für die Updatepfade: ein HTTP-Gerätestub, das den
// normativen OTA-Ablauf spielt, plus ein Adapter mit eigenem Datenverzeichnis.
async function createOtaHarness(t, adapterConfig = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-ota-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(4096, 3);
  const upload = path.join(directory, 'upload.bin');
  fs.writeFileSync(upload, image);
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');

  const state = {
    installedVersion: '0.4.0', otaState: 'idle', restarts: 0,
    received: [], logs: [], rejectUpdate: null,
  };
  let pendingVersion = null;
  const firmwareInfo = () => ({
    name: 'hdp-firmware', version: state.installedVersion, channel: 'development',
    platform: 'esp8266', board: 'd1_mini', variant: 'generic',
    build_id: '20260730-190338', build_timestamp: '2026-07-30T19:03:38Z',
    protocol_version: '1.0-draft', config_schema_version: 3, ota_supported: true,
    ota_port: 0, maximum_image_size_bytes: 1044464, free_update_space_bytes: 2678784,
    signature_verification: 'not_configured',
  });
  const applyRestart = () => {
    state.restarts += 1;
    if (pendingVersion) state.installedVersion = pendingVersion;
    pendingVersion = null;
    state.otaState = 'completed';
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/api/v1/firmware') return sendJson(res, firmwareInfo());
      if (req.url === '/api/v1/firmware/status') {
        return sendJson(res, {
          state: state.otaState, progress_percent: state.otaState === 'ready_to_restart' ? 100 : 0,
          restart_required: state.otaState === 'ready_to_restart',
        });
      }
      if (req.url === '/api/v1/firmware/update') {
        if (state.rejectUpdate) {
          res.statusCode = state.rejectUpdate.status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(JSON.stringify({
            ok: false,
            error: { code: state.rejectUpdate.code, message: state.rejectUpdate.message, details: {} },
          }));
        }
        pendingVersion = req.headers['x-hdp-firmware-version'];
        state.received.push({
          bytes: Buffer.concat(chunks).length,
          version: pendingVersion,
          sha256: req.headers['x-hdp-firmware-sha256'],
          binding: req.headers['x-hdp-binding-key'],
        });
        state.otaState = 'ready_to_restart';
        return sendJson(res, { state: 'ready_to_restart', restart_required: true }, 202);
      }
      if (req.url === '/api/v1/firmware/restart') {
        applyRestart();
        return sendJson(res, { state: 'restarting' }, 202);
      }
      res.statusCode = 404;
      return res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {} stop() {} refresh() {}
  }
  class FakeConnection extends EventEmitter {
    start() { FakeConnection.last = this; }
    stop() {} sendState() { return false; } updateDevice() {}
  }
  class FakeClient {
    constructor(device, credentials) { this.credentials = credentials; }
    update(device, credentials) { this.credentials = credentials; }
    async pairingStatus() {
      return {
        pairing_state: 'paired', paired: true,
        binding_id: auth.bindingId(this.credentials.bindingKey),
        binding_status: 'match', paired_to_requester: true,
      };
    }
    async pair(pending) {
      return {
        device: deviceInfo(true), manifest: pixelManifest(),
        status: { ...status(), state: 'paired', paired: true },
        existingConfig: outputConfig(), bindingId: auth.bindingId(pending.bindingKey),
      };
    }
    async manifest() { return pixelManifest(); }
    async config() { return outputConfig(); }
    async status() { return status(); }
    async firmware() { return firmwareInfo(); }
    async firmwareStatus() {
      return {
        state: state.otaState, progress_percent: 0,
        restart_required: state.otaState === 'ready_to_restart',
      };
    }
    async restartFirmware() { applyRestart(); return { state: 'restarting' }; }
  }
  const secrets = new Map();
  const host = {
    async getInstanceIdentity() { return { instanceId: INSTANCE_ID, fingerprint: 'a'.repeat(64) }; },
    async getDataDirectory() { return directory; },
    async getSecret(key) { return secrets.get(key) || null; },
    async setSecret(key, value) { secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
    async persistStorage() {}, setStorage() {}, subscribeState() { return () => {}; },
    setStates() {}, publishStates() {}, setConnected() {},
    log(message) { state.logs.push(String(message)); }, warn() {}, error() {},
  };
  const adapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  await adapter.start({ updateChannel: 'development', ...adapterConfig });
  FakeDiscovery.last.emit('found', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: port, wsPort: 81, otaPort: port, protocolVersion: '1.0-draft',
    runtimeProfile: 'pixel-timeline-v1', runtimeCompatible: true,
    firmwareVersion: '0.4.0', platform: 'esp8266', pairingState: 'pairable',
    bindingId: null, pairable: true, hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  const call = (method, requestPath, body = {}, uploadInfo) => adapter.handleManagementRequest({
    method, path: requestPath, basePath: '/adapter/instance/1/manage',
    body, upload: uploadInfo, access: { canWrite: true },
  });
  await call('POST', `/api/devices/${DEVICE_ID}/pair`);
  t.after(() => adapter.stop());
  const releaseManifest = (version) => ({
    schema_version: 1,
    release: {
      firmware_name: 'hdp-firmware', version, channel: 'development',
      published_at: '2026-07-31T19:42:08Z', build_id: '20260731-194208',
      protocol_min: '1.0-draft', protocol_max: '1.0-draft', config_schema_version: 3,
    },
    artifacts: [{
      platform: 'esp8266', board: 'd1_mini', variant: 'generic',
      filename: `hdp-firmware-${version}-esp8266-d1-mini-generic.bin`,
      size_bytes: image.length, sha256, signature: null,
    }],
  });
  const publish = async (version) => {
    const filename = `hdp-firmware-${version}-esp8266-d1-mini-generic.bin`;
    const stored = await call('POST', '/api/firmware/manifest', { manifest: releaseManifest(version) });
    if (stored.status !== 200) throw new Error(stored.json.error);
    const artifact = await call('POST', '/api/firmware/artifact', {}, { path: upload, filename });
    if (artifact.status !== 200) throw new Error(artifact.json.error);
    return { stored, artifact, filename };
  };
  // Der Rollout nach einer Rückkehr wird bewusst nicht abgewartet, damit die
  // Sitzung nicht am Update hängt. Der Test muss deshalb auf die Wirkung warten
  // statt auf eine feste Anzahl Ticks: Dazwischen liegen Dateihashing und eine
  // echte HTTP-Übertragung, deren Dauer von der Systemlast abhängt.
  const waitFor = async (predicate, label, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Zeitüberschreitung beim Warten auf ${label}`);
  };
  // Nach einem OTA gilt das Gerät bis zur Rückkehr der WebSocket-Sitzung als
  // offline. Erst danach darf ein weiterer Rollout greifen.
  const reconnect = () => FakeConnection.last.emit('online');
  return { adapter, call, state, publish, reconnect, waitFor, releaseManifest, image, sha256, upload };
}

test('Ein-Klick-Update installiert aus dem zentralen Speicher', async (t) => {
  const { call, state, publish, image, sha256 } = await createOtaHarness(t);

  // Ohne hinterlegtes Release wird kein Update angeboten.
  const empty = await call('GET', '/api/firmware');
  assert.deepEqual(empty.json.channels.map((entry) => entry.present), [false, false, false]);
  const before = (await call('GET', `/device/${DEVICE_ID}`)).view.body;
  assert.match(before, /Kein Update verfügbar/);
  await assert.rejects(async () => {
    const response = await call('POST', `/api/devices/${DEVICE_ID}/firmware/update`, { json: true });
    if (response.status >= 400) throw new Error(response.json.error);
  }, /keine Firmware hinterlegt/);

  // Die Übersicht erklärt den USB-Weg, weil Web Serial im Browser einen
  // sicheren Kontext voraussetzt und hier deshalb ausscheidet.
  const overview = (await call('GET', '/')).view.body;
  assert.match(overview, /Über USB flashen/);
  assert.match(overview, /hdp-flash\.exe --list/);
  assert.match(overview, /nicht<\/strong> gelöscht/);
  assert.match(overview, /adapter-public/);
  // Das Werkzeug wird mit dem Adapter ausgeliefert und ist von hier aus ladbar.
  assert.match(overview, /href="\/adapter-public\/1\/assets\/hdp-flash\.exe" download/);
  // Keine fest eingebaute Serveradresse in den Beispielaufrufen.
  assert.doesNotMatch(overview, /--server https?:\/\//);

  // Release zentral hinterlegen: erst das Manifest, dann das Artefakt.
  const { stored, artifact, filename } = await publish('0.4.1');
  assert.deepEqual(stored.json.missing, [filename]);
  assert.deepEqual(artifact.json.missing, []);

  // Jetzt meldet die Geräteseite das Update und der Klick installiert es.
  const offered = (await call('GET', `/device/${DEVICE_ID}`)).view.body;
  assert.match(offered, /Version 0\.4\.1 steht bereit/);
  assert.match(offered, /Jetzt aktualisieren/);
  const updated = await call('POST', `/api/devices/${DEVICE_ID}/firmware/update`, { json: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.installed.version, '0.4.1');
  assert.equal(state.restarts, 1);
  assert.equal(state.received.length, 1);
  assert.equal(state.received[0].bytes, image.length);
  assert.equal(state.received[0].version, '0.4.1');
  assert.equal(state.received[0].sha256, sha256);
  assert.match(state.received[0].binding, /^[0-9a-f]{64}$/);

  // Danach ist derselbe Stand kein Angebot mehr.
  const after = (await call('GET', `/device/${DEVICE_ID}`)).view.body;
  assert.match(after, /läuft bereits auf 0\.4\.1/);
});

test('Geräteverwaltung bietet ein Sammelupdate nur für veraltete Firmware an', async (t) => {
  const { call, state, publish } = await createOtaHarness(t);

  const before = await call('GET', '/');
  assert.doesNotMatch(before.view.body, /id="hdp-update-all-button"/);

  await publish('0.4.1');
  const offered = await call('GET', '/');
  assert.match(offered.view.body,
    /id="hdp-update-all-button"[\s\S]*data-count="1"[\s\S]*Alle aktualisieren \(1\)/);
  assert.match(offered.view.script, /function hdpRunUpdateAll/);
  assert.match(offered.view.script, /api\/firmware\/update-all/);

  const updated = await call('POST', '/api/firmware/update-all', { json: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.total, 1);
  assert.equal(updated.json.updated, 1);
  assert.equal(updated.json.failed, 0);
  assert.equal(updated.json.results[0].status, 'updated');
  assert.equal(updated.json.results[0].fromVersion, '0.4.0');
  assert.equal(updated.json.results[0].version, '0.4.1');
  assert.equal(state.installedVersion, '0.4.1');

  const after = await call('GET', '/');
  assert.doesNotMatch(after.view.body, /id="hdp-update-all-button"/);
});

test('Ein abgelehntes Update meldet den Gerätefehler und lässt den Button bedienbar', async (t) => {
  const { call, state, publish } = await createOtaHarness(t);
  state.rejectUpdate = { status: 422, code: 'OTA_CONFIG_SCHEMA_INCOMPATIBLE', message: 'Config schema is not migratable.' };
  await publish('0.4.1');

  const failed = await call('POST', `/api/devices/${DEVICE_ID}/firmware/update`, { json: true });
  assert.ok(failed.status >= 400, 'ein abgelehntes Update darf nicht als Erfolg gelten');
  assert.equal(failed.json.code, 'OTA_CONFIG_SCHEMA_INCOMPATIBLE');
  assert.equal(state.restarts, 0);
  assert.equal(state.installedVersion, '0.4.0');

  const page = await call('GET', `/device/${DEVICE_ID}`);
  const body = page.view.body;
  // Der Button bleibt bedienbar: Ein zweiter Versuch muss ohne Neuladen gehen.
  assert.match(body, /id="hdp-update-button"[^>]*onclick="hdpRunUpdate\(this\)"/);
  assert.doesNotMatch(body.slice(body.indexOf('hdp-update-button'), body.indexOf('hdp-update-button') + 200), / disabled/);
  // Das Update läuft per fetch, damit ein Fehler nicht auf die JSON-Antwort
  // navigiert und den Button im Zurück-Verlauf gesperrt zurücklässt.
  assert.doesNotMatch(body, /firmware\/update"[^>]*>\s*<button/);
  assert.match(page.view.script, /function hdpRunUpdate/);
  assert.match(page.view.script, /button\.disabled = false/);
  assert.match(page.view.script,
    /installiert\. Seite wird neu geladen[\s\S]*button\.disabled = false;[\s\S]*button\.textContent = label/);
  // Kein confirm(): Ein unterdrückter Browserdialog liefert still false und der
  // Knopf wäre danach ohne jede Rückmeldung wirkungslos.
  const scriptCode = page.view.script.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(scriptCode, /confirm\(/);
  assert.match(page.view.script, /data-armed/);
  assert.match(page.view.script, /Wirklich übertragen\?/);
  assert.match(page.view.script, /addEventListener\('pageshow'/);
  assert.match(body, /data-armed="0"/);
  assert.match(page.view.script, /OTA_CONFIG_SCHEMA_INCOMPATIBLE: 'Die installierte Firmware lehnt/);
  assert.doesNotThrow(() => new Function(page.view.script));

  // Nach dem Wegfall der Ablehnung greift derselbe Klick.
  state.rejectUpdate = null;
  const retried = await call('POST', `/api/devices/${DEVICE_ID}/firmware/update`, { json: true });
  assert.equal(retried.status, 200);
  assert.equal(state.installedVersion, '0.4.1');
});

test('Binary-Ausgänge werden während einer OTA-Transaktion nicht geschaltet', () => {
  const { otaInProgress } = createHdpAdapter._test;
  for (const otaState of ['uploading', 'ready_to_restart', 'restarting']) {
    assert.equal(otaInProgress({ otaProgress: { state: otaState } }), true, otaState);
  }
  for (const otaState of ['idle', 'completed', 'failed']) {
    assert.equal(otaInProgress({ otaProgress: { state: otaState } }), false, otaState);
  }
  assert.equal(otaInProgress({}), false);
});

test('Persistierte OTA-Zwischenzustände sperren nach Adapterneustart kein Update', () => {
  const { releaseInterruptedOta } = createHdpAdapter._test;
  for (const otaState of ['uploading', 'ready_to_restart', 'restarting']) {
    const device = { otaProgress: { state: otaState, progress_percent: 100 } };
    assert.equal(releaseInterruptedOta(device), true, otaState);
    assert.equal(device.otaProgress.state, 'failed');
    assert.match(device.otaProgress.message, /neuer Versuch ist möglich/);
  }
  const completed = { otaProgress: { state: 'completed', progress_percent: 100 } };
  assert.equal(releaseInterruptedOta(completed), false);
  assert.equal(completed.otaProgress.state, 'completed');
});

test('Automatischer Rollout installiert selbst, „nur benachrichtigen“ nicht', async (t) => {
  const notified = await createOtaHarness(t, { updateMode: 'notify_only' });
  await notified.publish('0.4.1');
  // Der Rollout erkennt den Kandidaten, installiert aber bewusst nicht.
  assert.equal(notified.state.received.length, 0);
  assert.equal(notified.state.installedVersion, '0.4.0');
  assert.match((await notified.call('GET', `/device/${DEVICE_ID}`)).view.body,
    /Version 0\.4\.1 steht bereit/);

  const automatic = await createOtaHarness(t, { updateMode: 'automatic' });
  await automatic.publish('0.4.1');
  // Das Hinterlegen eines Releases stößt den Rollout an; es genügt also, die
  // Firmware bereitzustellen.
  assert.equal(automatic.state.installedVersion, '0.4.1');
  assert.equal(automatic.state.restarts, 1);
  assert.equal(automatic.state.received[0].version, '0.4.1');
  assert.ok(automatic.state.logs.some((line) => /automatisches Update auf 0\.4\.1/.test(line)),
    'der Rollout protokolliert die Installation');

  // Solange die Sitzung nach dem Neustart nicht zurück ist, gilt das Gerät als
  // nicht erreichbar und der Rollout wartet.
  await automatic.publish('0.4.2');
  assert.equal(automatic.state.installedVersion, '0.4.1');
  assert.match((await automatic.call('GET', `/device/${DEVICE_ID}`)).view.body,
    /Automatik wartet: Gerät ist nicht erreichbar/);

  // Nach der Rückkehr wird das zweite Release nachgezogen.
  automatic.reconnect();
  await automatic.waitFor(() => automatic.state.installedVersion === '0.4.2',
    'das nachgeholte Update nach der Rückkehr');
  assert.equal(automatic.state.restarts, 2);
});

test('Wartungsfenster gilt auch über Mitternacht', () => {
  const { insideMaintenanceWindow } = createHdpAdapter._test;
  const at = (hour, minute = 0) => new Date(2026, 6, 31, hour, minute, 0);
  assert.equal(insideMaintenanceWindow({ enabled: false, start: '02:00', end: '04:00' }, at(12)), true);
  const night = { enabled: true, start: '02:00', end: '04:00' };
  assert.equal(insideMaintenanceWindow(night, at(2)), true);
  assert.equal(insideMaintenanceWindow(night, at(3, 59)), true);
  assert.equal(insideMaintenanceWindow(night, at(4)), false);
  assert.equal(insideMaintenanceWindow(night, at(1, 59)), false);
  const overMidnight = { enabled: true, start: '23:00', end: '01:00' };
  assert.equal(insideMaintenanceWindow(overMidnight, at(23, 30)), true);
  assert.equal(insideMaintenanceWindow(overMidnight, at(0, 30)), true);
  assert.equal(insideMaintenanceWindow(overMidnight, at(1)), false);
  assert.equal(insideMaintenanceWindow(overMidnight, at(12)), false);
  // Ein unbrauchbares Fenster darf Updates nicht dauerhaft blockieren.
  assert.equal(insideMaintenanceWindow({ enabled: true, start: 'x', end: 'y' }, at(12)), true);
});

test('Geräteverwaltung schaltet Seite und Hardwaredialog exklusiv auf den Gerätetyp um', async () => {
  const { deviceTypeOf, supportedDeviceTypes, binaryPinSlots } = createHdpAdapter._test;
  // Reine Ableitung: Maßgeblich ist die Hardwarekonfiguration, nicht das Profil.
  assert.equal(deviceTypeOf({ hardwareConfig: outputConfig(), runtimeProfile: 'binary-io-v1' }), 'percentage_indicator');
  assert.equal(deviceTypeOf({
    hardwareConfig: { revision: 5, device_type: 'binary_io', pins: [] },
    runtimeProfile: 'pixel-timeline-v1',
  }), 'binary_io');
  assert.equal(deviceTypeOf({ runtimeProfile: 'binary-io-v1' }), 'binary_io');
  assert.equal(deviceTypeOf({}), 'percentage_indicator');
  assert.deepEqual(supportedDeviceTypes(pixelManifest()), ['percentage_indicator']);
  assert.deepEqual(supportedDeviceTypes(binaryManifest()), ['percentage_indicator', 'binary_io']);
  assert.equal(binaryPinSlots(binaryManifest()), 11);
  assert.equal(binaryPinSlots(pixelManifest()), 5);

  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {} stop() {} refresh() {}
  }
  class FakeConnection extends EventEmitter {
    start() { FakeConnection.last = this; }
    stop() {} sendState() { return false; } updateDevice() {}
  }
  // Firmware 0.4.0: boot-dispatch-v1, Profil folgt erst nach dem Neustart.
  let deviceManifest = binaryManifest('pixel-timeline-v1');
  let remoteConfig = outputConfig();
  let devicePaired = false;
  class FakeClient {
    constructor(device, credentials) { this.credentials = credentials; }
    update(device, credentials) { this.credentials = credentials; }
    async pairingStatus() {
      // Nach dem Pairing meldet das Gerät dauerhaft ein passendes Binding.
      if (devicePaired) {
        return {
          pairing_state: 'paired', paired: true,
          binding_id: auth.bindingId(this.credentials.bindingKey),
          binding_status: 'match', paired_to_requester: true,
        };
      }
      return {
        pairing_state: 'pairable', paired: false, binding_id: null,
        binding_status: 'unpaired', paired_to_requester: null,
      };
    }
    async pair(pending) {
      devicePaired = true;
      return {
        device: { ...deviceInfo(true), firmware_version: '0.4.0' },
        manifest: deviceManifest,
        status: { ...status(), state: 'paired', paired: true },
        existingConfig: remoteConfig, bindingId: auth.bindingId(pending.bindingKey),
      };
    }
    async manifest() { return deviceManifest; }
    async config() { return remoteConfig; }
    async putConfig(expectedRevision, config) {
      // Das Gerät übernimmt exakt die gesendete Konfiguration und zählt hoch.
      remoteConfig = { ...config, revision: expectedRevision + 1 };
      return remoteConfig;
    }
    async status() { return status(); }
    async firmware() { return { ota_supported: false }; }
    async firmwareStatus() { return { state: 'idle' }; }
  }
  const storage = {};
  const secrets = new Map();
  const host = {
    async getInstanceIdentity() { return { instanceId: INSTANCE_ID, fingerprint: 'a'.repeat(64) }; },
    async getSecret(key) { return secrets.get(key) || null; },
    async setSecret(key, value) { secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
    async persistStorage(key, value) { storage[key] = value; },
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
    runtimeProfile: 'pixel-timeline-v1', runtimeCompatible: true,
    firmwareVersion: '0.4.0', platform: 'esp8266', pairingState: 'pairable',
    bindingId: null, pairable: true, hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/pair`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  const pageFor = async () => (await adapter.handleManagementRequest({
    method: 'GET', path: `/device/${DEVICE_ID}`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  })).view;
  // Der Prozentanzeigenabschnitt enthält eine eigene GPIO-Auswahl; die
  // Binary-Zusicherungen müssen deshalb auf ihr Panel begrenzt werden.
  const binaryPanel = (body) => {
    const start = body.indexOf('data-hdp-type-panel="binary_io"');
    assert.ok(start >= 0, 'Binary-Panel fehlt in der Seite');
    return body.slice(start);
  };
  // Ein mDNS-Update kann eine mehrstufige Reaktivierung anstoßen. Erst wenn die
  // vollständig durchgelaufen ist, beschreibt der Gerätezustand das Gerät.
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const percentage = await pageFor();
  // Als Prozentanzeige: Prozentseite, beide Typen wählbar, beide Dialogabschnitte
  // vorhanden, aber jeweils dem Typ zugeordnet.
  assert.match(percentage.body, /Anzeigewert und Skalierung/);
  assert.match(percentage.body, /<select id="hdp-device-type" name="device_type"><option value="percentage_indicator" selected>/);
  assert.match(percentage.body, /<option value="binary_io">Binary-I\/O<\/option>/);
  // Prozentanzeige und ARGB-Ausgang beschreiben denselben Strang; der
  // LED-Abschnitt gilt deshalb für beide Typen.
  assert.match(percentage.body, /data-hdp-type-panel="percentage_indicator argb_output"[^>]*><div class="dialog-section-head"><h4>LED-Ausgang/);
  assert.match(percentage.body, /data-hdp-type-panel="binary_io"[^>]*><div class="dialog-section-head"><h4>Binary-Pins/);
  // Kein Abschnitt darf ohne Typzuordnung im Dialog stehen.
  const dialog = percentage.body.slice(percentage.body.indexOf('id="hdp-hardware-dialog"'));
  const sections = dialog.match(/<section class="dialog-section"[^>]*>/g);
  assert.equal(sections.filter((tag) => !tag.includes('data-hdp-type-panel')).length, 1,
    'nur der gemeinsame Geräteabschnitt bleibt typunabhängig');
  assert.match(percentage.script, /function hdpBindHardwareType/);
  assert.match(percentage.script, /field\.disabled = !active/);
  assert.doesNotMatch(percentage.body, /Nur relevant, wenn als Gerätetyp/);
  // Jeder GPIO des ARGB-Ausgangs steht auch für Binary-I/O zur Verfügung; die
  // Eigenheiten einzelner Pins stehen als Hinweis daneben, statt sie zu sperren.
  for (const pin of binaryManifest().hardware_capabilities.binary_pins) {
    assert.match(percentage.body, new RegExp(`<option value="${pin}"[^>]*>GPIO ${pin}[ ·<]`));
  }
  assert.match(percentage.body, /GPIO 2 · Boot-Pin</);
  assert.match(percentage.body, /GPIO 16 · externer Pull-up nötig</);
  assert.match(percentage.body, /GPIO 15 · externer Pull-up nötig, Boot-Pin</);
  assert.match(percentage.body, /GPIO 1 · serielle Konsole</);
  assert.match(percentage.body, /GPIO 4<\/option>/);
  assert.match(percentage.body, /hdp-pin-legend/);
  assert.equal((percentage.body.match(/hdp-binary-pin-row/g) || []).length, 11);

  // Gerätetyp auf Binary-I/O umgestellt: Das Gerät startet neu, das Profil folgt
  // erst danach — die Verwaltung muss sofort umschalten.
  await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/config`,
    basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    body: {
      revision: 4, device_type: 'binary_io',
      binary_pin_0: '4', binary_direction_0: 'input', binary_input_type_0: 'switch',
      binary_pin_1: '5', binary_direction_1: 'output',
    },
  });
  const binary = await pageFor();
  assert.match(binary.body, /GPIO 4 · Schalter/);
  assert.match(binary.body, /GPIO 5 · Ausgang/);
  assert.match(binary.body, /<select id="hdp-device-type" name="device_type"><option value="percentage_indicator">/);
  assert.match(binary.body, /<option value="binary_io" selected>/);
  // Der Dialog behält beide Abschnitte, damit auch der Rückweg möglich bleibt.
  assert.match(binary.body, /data-hdp-type-panel="percentage_indicator argb_output"/);
  assert.doesNotMatch(binary.body, /Anzeigewert und Skalierung|Richtungsindikator/);

  // Nach einem OTA meldet dieselbe Hardware ein erweitertes Manifest. Das
  // zwischengespeicherte Manifest der Vorgängerversion darf nicht bestehen
  // bleiben, sonst zeigt die Verwaltung dauerhaft zu wenige GPIOs.
  assert.deepEqual(
    binaryManifest().hardware_capabilities.binary_pins.filter((pin) =>
      binary.body.includes(`<option value="${pin}"`)).length,
    binaryManifest().hardware_capabilities.binary_pins.length,
  );
  const narrowed = binaryManifest('binary-io-v1');
  narrowed.hardware_capabilities = {
    ...narrowed.hardware_capabilities, binary_pins: [4, 5, 12, 13, 14],
  };
  delete narrowed.hardware_capabilities.binary_pullup_pins;
  delete narrowed.hardware_capabilities.binary_boot_sensitive_pins;
  delete narrowed.hardware_capabilities.binary_serial_pins;
  narrowed.limits = { ...narrowed.limits, maximum_binary_pins: 5 };
  deviceManifest = narrowed;
  FakeDiscovery.last.emit('updated', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    runtimeProfile: 'binary-io-v1', runtimeCompatible: true,
    firmwareVersion: '0.4.0', platform: 'esp8266', pairingState: 'paired',
    bindingId: null, pairable: false, hardwareConfigPresent: true,
    configRevision: 5, online: true,
  });
  await settle();
  const downgraded = await pageFor();
  assert.doesNotMatch(binaryPanel(downgraded.body), /<option value="2"/);
  assert.equal((downgraded.body.match(/hdp-binary-pin-row/g) || []).length, 5);
  assert.doesNotMatch(downgraded.body, /hdp-pin-legend/);

  deviceManifest = binaryManifest('binary-io-v1');
  FakeDiscovery.last.emit('updated', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    runtimeProfile: 'binary-io-v1', runtimeCompatible: true,
    firmwareVersion: '0.4.1', platform: 'esp8266', pairingState: 'paired',
    bindingId: null, pairable: false, hardwareConfigPresent: true,
    configRevision: 5, online: true,
  });
  await settle();
  const upgraded = await pageFor();
  assert.match(binaryPanel(upgraded.body), /<option value="2">GPIO 2 · Boot-Pin</);
  assert.equal((upgraded.body.match(/hdp-binary-pin-row/g) || []).length, 11);
  assert.match(upgraded.body, /hdp-pin-legend/);
  adapter.stop();

  // Ein opaque-id-v1-Gerät bietet Binary-I/O gar nicht erst an.
  deviceManifest = pixelManifest();
  remoteConfig = outputConfig();
  devicePaired = false;
  const legacyAdapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  await legacyAdapter.start({});
  FakeDiscovery.last.emit('found', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    runtimeProfile: 'pixel-timeline-v1', runtimeCompatible: true,
    firmwareVersion: '0.3.1', platform: 'esp8266', pairingState: 'pairable',
    bindingId: null, pairable: true, hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  await legacyAdapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/pair`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  const legacy = (await legacyAdapter.handleManagementRequest({
    method: 'GET', path: `/device/${DEVICE_ID}`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  })).view;
  assert.doesNotMatch(legacy.body, /data-hdp-type-panel="binary_io"/);
  assert.doesNotMatch(legacy.body, /<option value="binary_io"/);
  assert.match(legacy.body, /Dieses Gerät bietet laut Manifest nur diesen Gerätetyp an/);
  const rejected = await legacyAdapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/config`,
    basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    body: { revision: 4, device_type: 'binary_io', binary_pin_0: '4', binary_direction_0: 'input' },
  });
  assert.equal(rejected.status, 422);
  legacyAdapter.stop();
});

test('veröffentlichte hDP-States folgen einem einheitlichen Schema je Gerätetyp', () => {
  const {
    defaultBindings, deviceStateChannels, deviceStateCatalog, deviceStateValues, applyDeviceStatus,
  } = createHdpAdapter._test;
  const common = {
    deviceId: DEVICE_ID, name: 'Flur', online: true, connectionState: 'connected',
    address: '192.168.1.20', platform: 'esp8266', firmwareVersion: '0.5.1',
    configRevision: 4, rssi: -51, bindings: defaultBindings(),
  };

  const percentage = {
    ...common, hardwareConfig: outputConfig(), calculatedPercentage: 42,
    calculatedColor: { r: 1, g: 2, b: 3 }, requestedBrightness: 80,
    outputMode: 'timeline_playing', activeTimelineId: 'indicator-1',
    effectiveBrightness: 28, estimatedCurrent: 120, powerLimited: false,
  };
  const percentageChannels = deviceStateChannels(percentage);
  assert.deepEqual(percentageChannels.map((channel) => channel.name), ['Status', 'Prozentanzeige']);
  assert.deepEqual(percentageChannels[0].states.map((state) => state.name).filter((name) =>
    ['Prozentwert', 'Aktive Timeline', 'Ausgabemodus'].includes(name)), []);
  assert.ok(percentageChannels[0].states.some((state) => state.name === 'Maximalhelligkeit'));
  assert.ok(percentageChannels[1].states.some((state) => state.name === 'Prozentwert'));
  assert.ok(percentageChannels[1].states.some((state) => state.name === 'Aktive Timeline'));
  assert.ok(deviceStateCatalog(percentage)
    .find((state) => state.name === 'Prozentwert').category.endsWith('/ Prozentanzeige'));

  const binary = {
    ...common,
    hardwareConfig: {
      revision: 7, device_type: 'binary_io', pins: [
        { pin: 4, direction: 'input', input_type: 'switch' },
        { pin: 15, direction: 'output' }, { pin: 16, direction: 'output' },
      ],
    },
    binaryStates: { 4: true, 15: false, 16: true },
  };
  const binaryChannels = deviceStateChannels(binary);
  assert.deepEqual(binaryChannels.map((channel) => channel.name),
    ['Status', 'Binary-Eingänge', 'Binary-Ausgänge']);
  assert.deepEqual(binaryChannels.find((channel) => channel.name === 'Binary-Ausgänge')
    .states.map((state) => state.name), ['GPIO 15', 'GPIO 16']);
  const binaryAddresses = deviceStateValues(binary).map((state) => state.address);
  assert.ok(binaryAddresses.includes(`devices/${DEVICE_ID}/binary/pin-15`));
  assert.ok(binaryAddresses.includes(`devices/${DEVICE_ID}/binary/pin-16`));
  assert.ok(!binaryAddresses.some((address) => /percentage|timeline|brightness|current|argb/.test(address)));

  const argb = {
    ...common,
    hardwareConfig: {
      ...outputConfig(), device_type: 'argb_output',
      pins: [
        { pin: 0, direction: 'input', input_type: 'button' },
        { pin: 15, direction: 'output' }, { pin: 16, direction: 'output' },
      ],
    },
    bindings: { ...defaultBindings(), argb: { 0: { topic: 'a' }, 2: { topic: 'b' } } },
    argbStates: { 0: true, 2: false }, binaryStates: { 0: false, 15: true, 16: false },
    requestedBrightness: 75, outputMode: 'frame', effectiveBrightness: 26,
    estimatedCurrent: 33, powerLimited: false,
  };
  const argbChannels = deviceStateChannels(argb);
  assert.deepEqual(argbChannels.map((channel) => channel.name),
    ['Status', 'ARGB-Ausgang', 'LED-Zustände', 'Binary-Eingänge', 'Binary-Ausgänge']);
  assert.ok(!deviceStateValues(argb).some((state) => /percentage|timeline-id/.test(state.address)));
  assert.deepEqual(argbChannels.find((channel) => channel.name === 'Binary-Ausgänge')
    .states.map((state) => state.name), ['GPIO 15', 'GPIO 16']);

  applyDeviceStatus(argb, {
    wifi_connected: true, wifi_rssi_dbm: -47, ip_address: '192.168.1.42',
    uptime_seconds: 123, free_heap_bytes: 32000,
    last_boot: { reset_reason: 'power_on', config_load_status: 'ok' },
  });
  const statusStates = deviceStateChannels(argb)[0].states;
  assert.equal(statusStates.find((state) => state.name === 'IP-Adresse').value, '192.168.1.42');
  assert.equal(statusStates.find((state) => state.name === 'Gerätelaufzeit').value, 123);
});

test('Gemerkter OTA-Fehlschlag weicht dem, was das Gerät selbst meldet', () => {
  const { reconcileOtaProgress, releaseInterruptedOta } = createHdpAdapter._test;
  const failed = () => ({
    deviceId: DEVICE_ID,
    otaProgress: { state: 'failed', progress_percent: 0, message: 'hDP-Gerät antwortet nicht.' },
  });

  // Der Regelfall: Die Nachverifikation scheiterte, das Gerät kam danach aber
  // sauber auf der Zielversion hoch. Der gemerkte Fehlschlag ist damit überholt.
  const recovered = failed();
  assert.equal(reconcileOtaProgress(recovered, { state: 'completed' }), true);
  assert.equal(recovered.otaProgress, null);

  // Bestätigt das Gerät den Fehlschlag, bleibt er stehen.
  const stillFailed = failed();
  assert.equal(reconcileOtaProgress(stillFailed, { state: 'failed' }), false);
  assert.equal(stillFailed.otaProgress.state, 'failed');

  // Ein laufendes Update gehört updateFirmware und wird nicht angefasst.
  const running = failed();
  assert.equal(reconcileOtaProgress(running, { state: 'idle' }, true), false);
  assert.equal(running.otaProgress.state, 'failed');

  // Nicht-terminale Zustände bleiben unberührt; die räumt releaseInterruptedOta.
  const uploading = { deviceId: DEVICE_ID, otaProgress: { state: 'uploading' } };
  assert.equal(reconcileOtaProgress(uploading, { state: 'idle' }), false);
  assert.equal(uploading.otaProgress.state, 'uploading');
  assert.equal(releaseInterruptedOta(uploading), true);
  assert.equal(uploading.otaProgress.state, 'failed');

  // Ohne gemerkten Vorgang gibt es nichts abzugleichen.
  assert.equal(reconcileOtaProgress({ deviceId: DEVICE_ID }, { state: 'completed' }), false);
  assert.equal(reconcileOtaProgress(null, { state: 'completed' }), false);
});

test('Nachverifikation nach dem OTA-Neustart wartet das Hochfahren ab', async (t) => {
  // Ein Gerät, das erst Image kopiert, Konfiguration vervollständigt und Pins
  // einrichtet, ist mehr als eine Minute weg. Vorher meldete der Adapter dann
  // einen Fehlschlag, obwohl das Update sauber durchgelaufen war.
  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {} stop() {} refresh() {}
  }
  class FakeConnection extends EventEmitter {
    start() {} stop() {} sendState() { return false; } updateDevice() {}
  }
  // Das Gerät ist nach dem Neustart eine Weile schlicht weg — genau wie in der
  // Wirklichkeit. Gesteuert über die Uhr statt über Aufrufzähler, weil
  // refreshFirmware beide Abfragen nebenläufig stellt.
  const device = {
    version: '0.4.4', otaState: 'ready_to_restart',
    reachable: true, offlineMilliseconds: 9000,
    afterRestart: { version: '0.5.1', otaState: 'completed' },
  };
  let probes = 0;
  const offline = () => Object.assign(new Error('hDP-Gerät antwortet nicht.'), { code: 'DEVICE_OFFLINE' });
  const firmwareInfo = () => ({
    name: 'hdp-firmware', version: device.version, channel: 'development',
    platform: 'esp8266', board: 'd1_mini', variant: 'generic',
    build_id: '20260802-060124', build_timestamp: '2026-08-02T06:01:24Z',
    protocol_version: '1.0-draft', config_schema_version: 3, ota_supported: true,
    ota_port: 8080, maximum_image_size_bytes: 1044464, free_update_space_bytes: 2670592,
    signature_verification: 'not_configured',
  });
  class FakeClient {
    constructor(_, credentials) { this.credentials = credentials; }
    update(_, credentials) { this.credentials = credentials; }
    async pairingStatus() {
      return {
        pairing_state: 'paired', paired: true,
        binding_id: auth.bindingId(this.credentials.bindingKey),
        binding_status: 'match', paired_to_requester: true,
      };
    }
    async pair(pending) {
      return {
        device: deviceInfo(true), manifest: pixelManifest(),
        status: { ...status(), state: 'paired', paired: true },
        existingConfig: outputConfig(), bindingId: auth.bindingId(pending.bindingKey),
      };
    }
    async manifest() { return pixelManifest(); }
    async config() { return outputConfig(); }
    async status() { return status(); }
    async firmware() {
      if (!device.reachable) throw offline();
      return firmwareInfo();
    }
    async firmwareStatus() {
      probes += 1;
      if (!device.reachable) throw offline();
      return {
        state: device.otaState, progress_percent: 0,
        target_version: '0.5.1',
        restart_required: device.otaState === 'ready_to_restart',
        last_error: device.otaState === 'failed'
          ? { code: 'OTA_BOOT_VALIDATION_FAILED', message: 'Firmware validation after restart failed.' } : null,
      };
    }
    async restartFirmware() {
      device.reachable = false;
      const returning = setTimeout(() => {
        device.version = device.afterRestart.version;
        device.otaState = device.afterRestart.otaState;
        device.reachable = true;
      }, device.offlineMilliseconds);
      returning.unref?.();
      return { state: 'restarting' };
    }
  }
  const secrets = new Map();
  const host = {
    async getInstanceIdentity() { return { instanceId: INSTANCE_ID, fingerprint: 'a'.repeat(64) }; },
    async getSecret(key) { return secrets.get(key) || null; },
    async setSecret(key, value) { secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
    async persistStorage() {}, setStorage() {}, subscribeState() { return () => {}; },
    setStates() {}, publishStates() {}, setConnected() {}, log() {}, warn() {}, error() {},
  };
  const adapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  await adapter.start({});
  t.after(() => adapter.stop());
  FakeDiscovery.last.emit('found', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    runtimeProfile: 'pixel-timeline-v1', runtimeCompatible: true,
    firmwareVersion: '0.4.4', platform: 'esp8266', pairingState: 'pairable',
    bindingId: null, pairable: true, hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  const call = (method, requestPath, body = {}) => adapter.handleManagementRequest({
    method, path: requestPath, basePath: '/adapter/instance/1/manage',
    body, access: { canWrite: true },
  });
  await call('POST', `/api/devices/${DEVICE_ID}/pair`);

  // Kein laufendes Update im Speicher: Die Sollversion muss aus dem Gerät
  // kommen, sonst könnte der eigenständige Neustart nie erfolgreich sein.
  const restarted = await call('POST', `/api/devices/${DEVICE_ID}/firmware/restart`, { json: true });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.json.info.version, '0.5.1');
  assert.equal(restarted.json.status.state, 'completed');
  assert.ok(probes > 3, 'die Prüfung muss mehrere Runden durchhalten');

  // Meldet das Gerät dagegen einen endgültigen Fehlschlag, wird sofort
  // abgebrochen statt das volle Fenster auszusitzen — und die Meldung nennt,
  // was das Gerät berichtet.
  device.otaState = 'ready_to_restart';
  device.offlineMilliseconds = 0;
  device.afterRestart = { version: '0.4.4', otaState: 'failed' };
  const startedAt = Date.now();
  const failed = await call('POST', `/api/devices/${DEVICE_ID}/firmware/restart`, { json: true });
  assert.equal(failed.json.code, 'OTA_BOOT_VALIDATION_FAILED');
  assert.match(failed.json.error, /Version 0\.4\.4 im Zustand failed \(OTA_BOOT_VALIDATION_FAILED\)/);
  assert.ok(Date.now() - startedAt < 30000, 'ein gemeldeter Fehlschlag darf nicht ausgesessen werden');
});

test('Leeres Formularfeld fällt auf seinen Standardwert zurück, nicht auf null', () => {
  const { number } = createHdpAdapter._test;
  // Number('') ist 0. Ohne Sonderbehandlung würde ein geleertes Feld still als
  // Null gespeichert — etwa ein Counter-Schritt, der dann nichts mehr zählt.
  assert.equal(number('', 1), 1);
  assert.equal(number('   ', 1), 1);
  assert.equal(number(undefined, 1), 1);
  assert.equal(number(null, 1), 1);
  assert.equal(number('unsinn', 1), 1);
  // Eine echte Null bleibt eine Null.
  assert.equal(number('0', 1), 0);
  assert.equal(number(0, 1), 0);
  // Dezimalkomma bleibt erlaubt.
  assert.equal(number('2,5', 1), 2.5);
  assert.equal(number('-3', 1), -3);
});

test('ARGB-Ausgang leitet die GPIO-Belegung aus der Pull-up-Fähigkeit ab', () => {
  const { argbOutputPinRoles, argbOutputPins, validateHardwareConfig } = validation;
  const manifest = binaryManifest('pixel-timeline-v1');
  const hardware = manifest.hardware_capabilities;

  // GPIO 15 und 16 fehlen in binary_pullup_pins und sind damit fest Ausgänge.
  const roles = argbOutputPinRoles(hardware, 4);
  assert.deepEqual(roles.fixedOutputs, [15, 16]);
  assert.deepEqual(roles.dataCandidates, [0, 1, 2, 3, 4, 5, 12, 13, 14]);
  assert.deepEqual(roles.inputs, [0, 1, 2, 3, 5, 12, 13, 14]);
  // Der Datenpin wandert mit: Wird 13 gewählt, ist 4 wieder Eingang.
  assert.deepEqual(argbOutputPinRoles(hardware, 13).inputs, [0, 1, 2, 3, 4, 5, 12, 14]);

  // Jeder verbleibende GPIO taucht genau einmal auf, Eingangstypen kommen aus
  // der Auswahl, Ausgänge tragen niemals einen Eingangstyp.
  const pins = argbOutputPins(hardware, 4, { 0: 'button', 15: 'button' });
  assert.equal(pins.length, 10);
  assert.equal(new Set(pins.map((pin) => pin.pin)).size, 10);
  assert.ok(!pins.some((pin) => pin.pin === 4));
  assert.deepEqual(pins.find((pin) => pin.pin === 0), { pin: 0, direction: 'input', input_type: 'button' });
  assert.deepEqual(pins.find((pin) => pin.pin === 1), { pin: 1, direction: 'input', input_type: 'switch' });
  assert.deepEqual(pins.find((pin) => pin.pin === 15), { pin: 15, direction: 'output' });

  // Die Prüfung erfindet keine Pinliste: Meldet ein Gerät keine, hat es auch
  // keine. Das unterscheidet eine 0.5.0-Firmware von einer 0.5.1.
  const base = {
    device_type: 'argb_output', revision: 4,
    outputs: [{
      output_id: 'main', output_type: 'argb_strip', pin: 4, pixel_count: 10,
      driver: 'WS2812', color_order: 'GRB', reverse: false,
      maximum_brightness_percent: 35, maximum_current_milliamps: 500,
      current_per_pixel_milliamps: 60, offline_mode: 'retain_last_frame',
    }],
  };
  assert.equal(validateHardwareConfig(base, manifest).pins, undefined);
  const validated = validateHardwareConfig({ ...base, pins }, manifest);
  assert.equal(validated.pins.length, 10);
  assert.ok(validated.pins.every((pin) => pin.pin !== 4));
  assert.equal(validated.pins.filter((pin) => pin.direction === 'output').length, 2);
  assert.equal(validated.pins.find((pin) => pin.pin === 0).input_type, 'button');

  // Eine falsche Richtung oder der Datenpin in einer Binary-Rolle sind Fehler.
  assert.throws(() => validateHardwareConfig({
    ...base, pins: pins.map((pin) => (pin.pin === 15 ? { pin: 15, direction: 'input', input_type: 'switch' } : pin)),
  }, manifest), /GPIO 15 muss beim ARGB-Ausgang Ausgang sein/);
  assert.throws(() => validateHardwareConfig({
    ...base, pins: [...pins, { pin: 4, direction: 'input', input_type: 'switch' }],
  }, manifest), /Datenpin darf keine Binary-Rolle/);

  // Ein GPIO ohne Pull-up taugt nicht als Datenpin.
  assert.throws(() => validateHardwareConfig({
    ...base, outputs: [{ ...base.outputs[0], pin: 16 }],
  }, manifest), /Pull-up/);

  // Die Prozentanzeige bleibt von der Regel unberührt und bekommt keine Pins.
  const percentage = validateHardwareConfig({
    ...base, device_type: 'percentage_indicator',
  }, manifest);
  assert.equal(percentage.pins, undefined);

  // binary_io bleibt frei konfigurierbar.
  assert.deepEqual(validateHardwareConfig(binaryConfig(), manifest), binaryConfig());
});

test('ARGB-Ausgang verknüpft einzelne LEDs über Einschaltkriterien mit States', async () => {
  const {
    deviceTypeOf, isArgbDevice, supportedDeviceTypes, argbPixelCount,
    defaultArgbBinding, normalizeArgbBindings, renderArgbFrame, hexColor, colorHex,
  } = createHdpAdapter._test;
  const argbPins = (argbPin = 4, inputTypes = {}) =>
    [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16]
      .filter((pin) => pin !== argbPin)
      .map((pin) => ([15, 16].includes(pin)
        ? { pin, direction: 'output' }
        : {
          pin,
          direction: 'input',
          input_type: inputTypes[String(pin)] === 'button' ? 'button' : 'switch',
        }));
  const argbConfig = (revision = 4, pixelCount = 4) => ({
    ...outputConfig(revision, pixelCount),
    device_type: 'argb_output',
    outputs: [{ ...outputConfig(revision, pixelCount).outputs[0], pin: 4 }],
    pins: argbPins(4),
  });

  // Der Gerätetyp folgt der Konfiguration, nicht dem Profil: Beide Pixeltypen
  // melden pixel-timeline-v1.
  assert.equal(deviceTypeOf({ hardwareConfig: argbConfig(), runtimeProfile: 'pixel-timeline-v1' }), 'argb_output');
  assert.equal(isArgbDevice({ hardwareConfig: argbConfig() }), true);
  assert.equal(isArgbDevice({ hardwareConfig: outputConfig() }), false);
  assert.equal(argbPixelCount({ hardwareConfig: argbConfig(4, 12) }), 12);
  assert.equal(argbPixelCount({ hardwareConfig: binaryConfig() }), 0);
  const argbManifest = {
    ...binaryManifest('pixel-timeline-v1'),
    device_types: ['percentage_indicator', 'argb_output', 'binary_io'],
  };
  assert.deepEqual(supportedDeviceTypes(argbManifest),
    ['percentage_indicator', 'argb_output', 'binary_io']);

  // Farben laufen als #rrggbb durch das Formular und als RGB durch hDP.
  assert.deepEqual(hexColor('#00ff80', { r: 1, g: 1, b: 1 }), { r: 0, g: 255, b: 128 });
  assert.deepEqual(hexColor('unsinn', { r: 1, g: 2, b: 3 }), { r: 1, g: 2, b: 3 });
  assert.equal(colorHex({ r: 0, g: 255, b: 128 }), '#00ff80');

  // Plätze ohne State sind keine Zuordnung; Indizes jenseits des Strangs
  // verschwinden mit ihm.
  assert.deepEqual(Object.keys(normalizeArgbBindings({
    argb: { 0: { topic: 'a/b' }, 1: { topic: '   ' }, 9: { topic: 'c/d' } },
  }, 4)), ['0']);

  // Vier LEDs, vier Kriterien: gleich, kleiner, größer, Bereich.
  const device = {
    hardwareConfig: argbConfig(4, 4),
    argbValues: { 0: true, 1: 12, 2: 90, 3: 55 },
    bindings: {
      argb: {
        0: { ...defaultArgbBinding(), topic: 'a', operator: 'equals', value: '1' },
        1: { ...defaultArgbBinding(), topic: 'b', operator: 'less_than', value: '20', color_on: { r: 255, g: 0, b: 0 } },
        2: { ...defaultArgbBinding(), topic: 'c', operator: 'greater_than', value: '95' },
        3: {
          ...defaultArgbBinding(), topic: 'd', operator: 'between', value: '50', value_max: '60',
          color_on: { r: 0, g: 0, b: 255 }, color_off: { r: 30, g: 30, b: 30 },
        },
      },
    },
  };
  const rendered = renderArgbFrame(device);
  assert.deepEqual(rendered.states, { 0: true, 1: true, 2: false, 3: true });
  assert.deepEqual(rendered.pixels, [
    { r: 0, g: 255, b: 0 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 255 },
  ]);
  // Ein noch nie gelieferter State erfüllt kein Kriterium und zeigt die
  // Aus-Farbe, statt einen Zustand zu erfinden.
  device.argbValues = {};
  assert.deepEqual(renderArgbFrame(device).pixels[3], { r: 30, g: 30, b: 30 });

  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {} stop() {} refresh() {}
  }
  class FakeConnection extends EventEmitter {
    start() { FakeConnection.last = this; }
    stop() {} sendState() { return false; } updateDevice() {}
  }
  let remoteConfig = outputConfig(4, 4);
  let devicePaired = false;
  class FakeClient {
    constructor(device_, credentials) { this.credentials = credentials; }
    update(device_, credentials) { this.credentials = credentials; }
    async pairingStatus() {
      if (devicePaired) {
        return {
          pairing_state: 'paired', paired: true,
          binding_id: auth.bindingId(this.credentials.bindingKey),
          binding_status: 'match', paired_to_requester: true,
        };
      }
      return {
        pairing_state: 'pairable', paired: false, binding_id: null,
        binding_status: 'unpaired', paired_to_requester: null,
      };
    }
    async pair(pending) {
      devicePaired = true;
      return {
        device: { ...deviceInfo(true), firmware_version: '0.5.0' },
        manifest: argbManifest,
        status: { ...status(), state: 'paired', paired: true },
        existingConfig: remoteConfig, bindingId: auth.bindingId(pending.bindingKey),
      };
    }
    async manifest() { return argbManifest; }
    async config() { return remoteConfig; }
    async putConfig(expectedRevision, config) {
      remoteConfig = { ...config, revision: expectedRevision + 1 };
      return remoteConfig;
    }
    async status() { return status(); }
    async firmware() { return { ota_supported: false }; }
    async firmwareStatus() { return { state: 'idle' }; }
  }
  const storage = {};
  const secrets = new Map();
  const subscriptions = [];
  const published = [];
  const host = {
    async getInstanceIdentity() { return { instanceId: INSTANCE_ID, fingerprint: 'a'.repeat(64) }; },
    async getSecret(key) { return secrets.get(key) || null; },
    async setSecret(key, value) { secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
    async persistStorage(key, value) { storage[key] = value; },
    setStorage(key, value) { storage[key] = value; },
    subscribeState(topic, listener) {
      subscriptions.push({ topic, listener });
      return () => {};
    },
    setStates() {},
    publishStates(values) { published.push(values); },
    setConnected() {}, log() {}, warn() {}, error() {},
  };
  const adapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  await adapter.start({});
  FakeDiscovery.last.emit('found', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    runtimeProfile: 'pixel-timeline-v1', runtimeCompatible: true,
    firmwareVersion: '0.5.0', platform: 'esp8266', pairingState: 'pairable',
    bindingId: null, pairable: true, hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/pair`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  const pageFor = async () => (await adapter.handleManagementRequest({
    method: 'GET', path: `/device/${DEVICE_ID}`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  })).view;

  // Umschalten auf den ARGB-Ausgang: Die LED-Hardware bleibt unverändert, nur
  // der Gerätetyp wechselt.
  const switched = await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/config`,
    basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    body: {
      revision: 4, device_type: 'argb_output', argb_pin: '4', led_count: '4',
      led_type: 'WS2812', color_order: 'GRB', maximum_brightness_percent: '35',
      maximum_current_milliamps: '500', current_per_led_milliamps: '60',
      offline_mode: 'retain_last_frame',
      binary_input_type_0: 'button', binary_input_type_1: 'switch',
    },
  });
  assert.equal(switched.status, 303);
  assert.equal(remoteConfig.device_type, 'argb_output');
  assert.equal(remoteConfig.outputs[0].pixel_count, 4);

  // Die Pinliste kommt vom Adapter, nicht aus dem Formular: zwei feste
  // Ausgänge, acht Eingänge, der Datenpin bleibt frei.
  assert.equal(remoteConfig.pins.length, 10);
  assert.ok(remoteConfig.pins.every((pin) => pin.pin !== 4));
  assert.deepEqual(remoteConfig.pins.filter((pin) => pin.direction === 'output').map((pin) => pin.pin), [15, 16]);
  assert.equal(remoteConfig.pins.find((pin) => pin.pin === 0).input_type, 'button');
  assert.equal(remoteConfig.pins.find((pin) => pin.pin === 1).input_type, 'switch');

  const argbPage = await pageFor();
  assert.match(argbPage.body, /<span>ARGB-Ausgang<\/span>/);
  assert.match(argbPage.body, /States auf LEDs/);
  // Neben den LEDs erscheinen die Binary-Rollen mit demselben Schema wie beim
  // reinen Binary-I/O-Gerät.
  assert.match(argbPage.body, /Taster, Schalter und Ausgänge/);
  assert.match(argbPage.body, /GPIO 15 · Ausgang/);
  assert.match(argbPage.body, /GPIO 0 · Taster/);
  assert.match(argbPage.body, /GPIO 1 · Schalter/);
  assert.match(argbPage.body, /name="binary_topic_15"/);
  assert.match(argbPage.body, /name="binary_action_0"/);
  assert.doesNotMatch(argbPage.body, /name="binary_topic_4"/);
  // Der Hardwaredialog bietet nur Pull-up-fähige GPIOs als Datenpin an.
  const dialog = argbPage.body.slice(argbPage.body.indexOf('id="hdp-hardware-dialog"'));
  const dataPinSelect = dialog.slice(dialog.indexOf('id="hdp-argb-data-pin"'));
  assert.doesNotMatch(dataPinSelect.slice(0, dataPinSelect.indexOf('</select>')), /value="1[56]"/);
  assert.match(dialog, /data-hdp-argb-input="0"/);
  assert.doesNotMatch(dialog, /data-hdp-argb-input="15"/);
  assert.doesNotMatch(argbPage.body, /Anzeigewert und Skalierung|Richtungsindikator/);
  assert.match(argbPage.body, /<option value="argb_output" selected>ARGB-Ausgang<\/option>/);
  // Eine Zeile je LED des Strangs, inklusive Farbwählern.
  assert.equal((argbPage.body.match(/class="hdp-argb-row"/g) || []).length, 4);
  assert.match(argbPage.body, /name="argb_topic_3"/);
  assert.doesNotMatch(argbPage.body, /name="argb_topic_4"/);
  assert.match(argbPage.body, /type="color" name="argb_color_on_0" value="#00ff00"/);

  // Zwei LEDs verknüpfen — eine per Bereich, eine per Gleichheit.
  const saved = await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/bindings`,
    basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    body: {
      argb_topic_0: 'batterie/soc', argb_operator_0: 'between',
      argb_value_0: '20', argb_value_max_0: '80',
      argb_color_on_0: '#ffaa00', argb_color_off_0: '#000000',
      argb_topic_2: 'wallbox/laedt', argb_operator_2: 'equals', argb_value_2: '1',
      argb_color_on_2: '#0000ff', argb_color_off_2: '#101010',
      // Ein Taster schaltet ein Topic um, ein fester Ausgang folgt einem Topic.
      binary_topic_0: 'licht/kueche', binary_action_0: 'toggle',
      binary_topic_15: 'relais/pumpe', binary_invert_15: 'on',
      brightness_mode: 'fixed', brightness_fixed: '100',
      update_mode: 'manual', update_channel: 'stable',
    },
  });
  assert.equal(saved.status, 303);
  const current = (await adapter.handleManagementRequest({
    method: 'GET', path: `/api/devices/${DEVICE_ID}`,
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  })).json;
  const stored = current.bindings.argb;
  assert.deepEqual(Object.keys(stored), ['0', '2']);
  assert.deepEqual(stored['0'], {
    topic: 'batterie/soc', operator: 'between', value: '20', value_max: '80',
    color_on: { r: 255, g: 170, b: 0 }, color_off: { r: 0, g: 0, b: 0 },
  });

  // Die Binary-Bindungen laufen über dasselbe Schema wie beim Binary-I/O-Gerät.
  assert.deepEqual(current.bindings.binary['0'], {
    topic: 'licht/kueche', action: 'toggle', set_value: true, counter_step: 1,
  });
  assert.deepEqual(current.bindings.binary['15'], { topic: 'relais/pumpe', invert: true });
  assert.equal(current.bindings.binary['1'].topic, '');

  // Genau die verknüpften States werden abonniert und als eigene homeESS-States
  // veröffentlicht.
  const argbTopics = subscriptions.filter((entry) => ['batterie/soc', 'wallbox/laedt'].includes(entry.topic));
  assert.equal(argbTopics.length, 2);
  // Auch die Binary-Topics werden abonniert.
  assert.equal(subscriptions.filter((entry) => entry.topic === 'licht/kueche').length, 1);
  assert.equal(subscriptions.filter((entry) => entry.topic === 'relais/pumpe').length, 1);
  const ledAddresses = published.at(-1).map((value) => value.address)
    .filter((address) => address.includes('/argb/'));
  assert.deepEqual(ledAddresses, [
    `devices/${DEVICE_ID}/argb/led-0`, `devices/${DEVICE_ID}/argb/led-2`,
  ]);

  // Ein eintreffender Wert schaltet genau die zugehörige LED.
  subscriptions.find((entry) => entry.topic === 'batterie/soc').listener(55);
  const active = published.at(-1)
    .find((value) => value.address === `devices/${DEVICE_ID}/argb/led-0`);
  assert.equal(active.value, true);
  subscriptions.find((entry) => entry.topic === 'batterie/soc').listener(95);
  assert.equal(published.at(-1)
    .find((value) => value.address === `devices/${DEVICE_ID}/argb/led-0`).value, false);

  // Unerfüllbare Kriterien werden beim Speichern abgewiesen, nicht still
  // verworfen.
  const rejectedRange = await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/bindings`,
    basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    body: {
      argb_topic_0: 'batterie/soc', argb_operator_0: 'between',
      argb_value_0: '80', argb_value_max_0: '20',
      brightness_mode: 'fixed', brightness_fixed: '100',
    },
  });
  assert.equal(rejectedRange.status, 422);
  assert.match(rejectedRange.json.error, /LED 1: Der obere Bereichswert/);
  const rejectedText = await adapter.handleManagementRequest({
    method: 'POST', path: `/api/devices/${DEVICE_ID}/bindings`,
    basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    body: {
      argb_topic_1: 'wallbox/status', argb_operator_1: 'greater_than',
      argb_value_1: 'laedt',
      brightness_mode: 'fixed', brightness_fixed: '100',
    },
  });
  assert.equal(rejectedText.status, 422);
  assert.match(rejectedText.json.error, /LED 2: Der Vergleichswert muss numerisch sein/);
  adapter.stop();
});

test('hDP Adapter persistiert Pairing-Secrets und gruppiert die Gerätekonfiguration', async () => {
  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {}
    stop() {}
    refresh() {}
  }
  const events = [];
  let pairCalls = 0;
  let restoring = false;
  class FakeClient {
    constructor(device, credentials) { this.device = device; this.credentials = credentials; }
    update(device, credentials) { this.device = device; this.credentials = credentials; }
    async pairingStatus() {
      if (restoring) {
        return {
          pairing_state: 'paired', paired: true,
          binding_id: auth.bindingId(this.credentials.bindingKey),
          binding_status: 'match', paired_to_requester: true,
        };
      }
      return {
        pairing_state: 'pairable', paired: false, binding_id: null,
        binding_status: 'unpaired', paired_to_requester: null,
      };
    }
    async pair(pending) {
      pairCalls += 1;
      events.push('pair');
      assert.match(pending.bindingKey, /^[0-9a-f]{64}$/);
      assert.match(pending.adapterNonce, /^[0-9a-f]{32}$/);
      assert.ok(events.indexOf('secret') < events.indexOf('pair'));
      assert.ok(events.indexOf('storage') < events.indexOf('pair'));
      if (pairCalls === 1) {
        FakeDiscovery.last.emit('updated', {
          deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
          apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
          firmwareVersion: '0.2.0', platform: 'esp8266', pairingState: 'pairing',
          bindingId: null, pairable: false, hardwareConfigPresent: true,
          configRevision: 4, online: true,
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      return {
        device: deviceInfo(true), manifest: manifest(), status: { ...status(), state: 'paired', paired: true },
        existingConfig: hardwareConfig(), bindingId: auth.bindingId(pending.bindingKey),
      };
    }
    async manifest() { return manifest(); }
    async config() { return hardwareConfig(); }
    async status() { return status(); }
    async firmware() { return { ota_supported: false }; }
    async firmwareStatus() { return { state: 'idle' }; }
  }
  class FakeConnection extends EventEmitter {
    start() { FakeConnection.last = this; }
    stop() {}
    sendState() { return false; }
    updateDevice() {}
  }
  const storage = {};
  const secrets = new Map();
  const host = {
    name: 'HDP Testinstanz',
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
  assert.equal(pairCalls, 1, 'mDNS-Updates starten während der manuellen Kopplung keinen zweiten Pairing-Lauf');
  assert.equal(storage.hdpDevices[0].bindingState, 'active');
  assert.equal(storage.hdpDevices[0].bindingKey, undefined);
  assert.equal(storage.hdpDevices[0].pairingInProgress, undefined);
  assert.match(secrets.get(`device-${DEVICE_ID}`), /^[0-9a-f]{64}$/);

  FakeConnection.last.emit('status', {
    wifi_rssi: -58,
    effective_brightness: 42,
    estimated_current_milliamps: 120,
    power_limit_active: false,
  });
  const overviewPage = await adapter.handleManagementRequest({
    method: 'GET', path: '/',
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  assert.equal(overviewPage.view.title, 'Geräteverwaltung');
  assert.match(overviewPage.view.body, /<h1>HDP Testinstanz – Geräteverwaltung<\/h1>/);
  assert.match(overviewPage.view.body, /WLAN-Signal/);
  assert.match(overviewPage.view.body, /Gut <small>-58 dBm<\/small>/);
  assert.match(overviewPage.view.body, />Verwalten <span/);
  assert.doesNotMatch(overviewPage.view.body, /Runtime Legacy|nächster Versuch|nicht konfiguriert/);
  assert.match(overviewPage.view.script, /api\/overview/);
  assert.match(overviewPage.view.script, /setTimeout\(tick, 1000\)/);
  assert.doesNotThrow(() => new Function(overviewPage.view.script));

  const initialRevision = /data-hdp-revision="([^"]+)"/.exec(overviewPage.view.body)[1];
  FakeConnection.last.emit('status', {
    wifi_rssi: -78,
    effective_brightness: 42,
    estimated_current_milliamps: 120,
    power_limit_active: false,
  });
  const liveOverview = await adapter.handleManagementRequest({
    method: 'GET', path: '/api/overview',
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  assert.equal(liveOverview.status, 200);
  assert.notEqual(liveOverview.json.revision, initialRevision);
  assert.match(liveOverview.json.html, /has-critical-signal/);
  assert.match(liveOverview.json.html, /Schwach <small>-78 dBm<\/small>/);

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
    '<h2>Firmware</h2>',
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

  const restoredAdapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  await restoredAdapter.start({
    hdpDevices: storage.hdpDevices.map((record) => ({
      ...record, paired: false, rssi: -42, connectionState: 'connected',
    })),
  });
  const restoredOverview = await restoredAdapter.handleManagementRequest({
    method: 'GET', path: '/',
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  assert.match(restoredOverview.view.body, /badge\.local/);
  assert.match(restoredOverview.view.body, /status-badge status-off">Offline/);
  assert.doesNotMatch(restoredOverview.view.body, /Sehr gut|Letztes WLAN-Signal|-42 dBm/);
  assert.match(restoredOverview.view.body, />Verwalten <span/);

  restoring = true;
  FakeDiscovery.last.emit('found', {
    deviceId: DEVICE_ID, address: '127.0.0.1', hostname: 'badge.local',
    apiPort: 80, wsPort: 81, otaPort: 8080, protocolVersion: '1.0-draft',
    firmwareVersion: '0.2.0', platform: 'esp8266', pairingState: 'paired',
    bindingId: auth.bindingId(secrets.get(`device-${DEVICE_ID}`)), pairable: false,
    hardwareConfigPresent: true, configRevision: 4, online: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(FakeConnection.last, 'wiedergefundenes Gerät erhält erneut eine Laufzeitverbindung');
  FakeConnection.last.emit('online');
  FakeConnection.last.emit('status', {
    wifi_rssi: -42, effective_brightness: 42,
    estimated_current_milliamps: 120, power_limit_active: false,
  });
  const reconnectedOverview = await restoredAdapter.handleManagementRequest({
    method: 'GET', path: '/api/overview',
    basePath: '/adapter/instance/1/manage', body: {}, access: { canWrite: true },
  });
  assert.match(reconnectedOverview.json.html, /status-badge status-ok">Online/);
  assert.match(reconnectedOverview.json.html, /Sehr gut <small>-42 dBm<\/small>/);
  restoredAdapter.stop();
});
