'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const validation = require('../adapter/hdp/validation');
const runtime = require('../adapter/hdp/runtime');
const hdp = require('../adapter/hdp')._test;

const capabilities = {
  hardware_capabilities: {
    binary_pins: [2, 4, 5, 12, 13, 14],
    binary_pullup_pins: [2, 4, 5, 12, 13, 14],
    ir_default_status_led_pin: 2,
    ir_receiver_modes: ['passthrough', 'record'],
  },
};

const code = {
  encoding: 'raw-microseconds-v1', carrier_frequency_hz: 38000,
  durations: [9000, 4500, 560, 560],
};

test('IR-Hardwareprofil erlaubt Receiver, Blaster oder beides mit eindeutigen Pins', () => {
  assert.deepEqual(validation.validateIrConfig({
    device_type: 'ir_transceiver',
    receiver: { enabled: true, pin: 14, carrier_frequency_hz: 38000, mode: 'record', trigger_pin: 13 },
    blaster: { enabled: true, pin: 4 },
    status_led_pin: 2,
  }, capabilities), {
    device_type: 'ir_transceiver',
    receiver: { enabled: true, pin: 14, carrier_frequency_hz: 38000, mode: 'record', trigger_pin: 13 },
    blaster: { enabled: true, pin: 4 },
    status_led_pin: 2,
  });
  assert.throws(() => validation.validateIrConfig({
    device_type: 'ir_transceiver',
    receiver: { enabled: true, pin: 4, mode: 'passthrough', trigger_pin: null },
    blaster: { enabled: true, pin: 4 },
  }, capabilities), /eindeutig/);
  assert.throws(() => validation.validateIrConfig({
    device_type: 'ir_transceiver', status_led_pin: 14,
    receiver: { enabled: true, pin: 14, mode: 'passthrough', trigger_pin: null },
    blaster: { enabled: false, pin: 4 },
  }, capabilities), /eindeutig/);
});

test('IR-Wirecodes werden strikt und protokollunabhängig validiert', () => {
  assert.deepEqual(hdp.normalizeIrCode(JSON.stringify(code)), code);
  assert.equal(runtime.validIrCode(code), true);
  assert.equal(runtime.validIrMessage({ type: 'ir.recorded', payload: {
    config_revision: 1, event_sequence: 1,
    occurred_at_uptime_milliseconds: 20, code,
  } }), true);
  assert.equal(runtime.validIrMessage({ type: 'ir.record.status', payload: {
    config_revision: 1, reply_to: 'cancel-1', armed: false,
  } }), true);
  assert.throws(() => hdp.normalizeIrCode({ ...code, durations: [0, 1] }), /ungültig/);
});

test('IR-Code-IDs bleiben lesbar und kollisionsfrei', () => {
  assert.equal(hdp.normalizeIrRecordingName('Fernseher Ein - Wohnzimmer'), 'Fernseher_Ein_Wohnzimmer');
  assert.equal(hdp.irRecordingId('Fernseher Ein', {}), 'fernseher_ein');
  assert.equal(hdp.irRecordingId('Fernseher Ein', { fernseher_ein: {} }), 'fernseher_ein_2');
});

test('Aufgezeichnete Codes erscheinen in einer eigenen globalen State-Gruppe', () => {
  const device = {
    paired: true, deviceId: 'hdp-one', name: 'IR-Empfänger',
    irRecordings: { fernseher_ein: { name: 'Fernseher_Ein', code } },
    hardwareConfig: {
      device_type: 'ir_transceiver',
      receiver: { enabled: true, mode: 'record' }, blaster: { enabled: true },
    },
    bindings: { ir: {} },
  };
  const ownChannels = hdp.deviceStateChannels(device);
  assert.equal(ownChannels.some((channel) => channel.address === 'ir-recordings'), false);
  assert.deepEqual(hdp.irRecordingStateCatalog([device]), [{
    address: 'ir_recordings/fernseher_ein', name: 'Fernseher_Ein',
    value: code, category: 'Aufgezeichnete_IR_Codes',
  }]);
});

test('alle State-Namen und Topicsegmente verwenden ausschließlich Unterstriche', () => {
  assert.deepEqual(hdp.normalizePublishedState({
    address: 'devices/my-device/status-state',
    name: 'Status State-Test', category: 'Mein Gerät / IR-Codes', value: true,
  }), {
    address: 'devices/my_device/status_state',
    name: 'Status_State_Test', category: 'Mein_Gerät/IR_Codes', value: true,
  });
  assert.equal(hdp.normalizeStateToken(' - Status State - '), 'Status_State');
  assert.equal(hdp.normalizeStateCategory(' Mein Gerät / - IR Codes - '), 'Mein_Gerät/IR_Codes');
  const device = {
    paired: true, deviceId: 'hdp-test-device', name: 'Test Device', online: true,
    hardwareConfig: {
      device_type: 'ir_transceiver',
      receiver: { enabled: true, mode: 'record' }, blaster: { enabled: true },
    },
    bindings: { ir: {} }, irRecordings: {},
  };
  for (const state of hdp.deviceStateChannels(device).flatMap((channel) => channel.states)) {
    assert.doesNotMatch(state.address, /[\s-]/);
    assert.doesNotMatch(state.name, /[\s-]/);
  }
});

test('IR-Aufnahme ist oben angeordnet und kann erneut gedrückt werden', () => {
  const source = fs.readFileSync(path.join(__dirname, '../adapter/hdp/index.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../adapter/hdp/management.css'), 'utf8');
  const page = source.slice(source.indexOf('function renderIrDevicePage'),
    source.indexOf('function renderDevicePage'));
  assert.ok(page.indexOf('${recordingSection}') < page.indexOf('<form class="hdp-settings-form"'));
  assert.match(page, /Aufnahme beenden/);
  assert.match(source, /ir\.record\.cancel/);
  assert.match(page, /data-hdp-ir-revision/);
  assert.match(source, /action === 'ir\/status'/);
  assert.match(page, /hdp-ir-record-form/);
  assert.match(page, /hdp-ir-code-list/);
  assert.match(page, /formaction="\$\{base\}\/send/);
  assert.match(source, /action\.startsWith\('ir\/recordings\/send\/'\)/);
  assert.match(page, />Senden</);
  assert.match(page, />Umbenennen</);
  assert.match(styles, /\.hdp-ir-code-list-head,[\s\S]*grid-template-columns/);
  assert.match(styles, /\.hdp-ir-state-path[\s\S]*text-overflow: ellipsis/);
  assert.match(styles, /\.hdp-ir-settings-grid/);
});
