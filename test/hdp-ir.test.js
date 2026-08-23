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

test('gelernte IR-Codes stehen jedem Blaster instanzweit zur Verfügung', () => {
  const receiverDevice = {
    paired: true, deviceId: 'hdp-receiver', name: 'IR-Empfänger',
    irRecordings: {
      fernseher_ein: { name: 'Fernseher_Ein', code, recorded_at: '2026-08-01T10:00:00.000Z' },
      avr_aus: { name: 'AVR_Aus', code, recorded_at: '2026-08-02T10:00:00.000Z' },
    },
    hardwareConfig: {
      device_type: 'ir_transceiver',
      receiver: { enabled: true, mode: 'record' }, blaster: { enabled: false },
    },
    bindings: { ir: {} },
  };
  const blasterDevice = {
    paired: true, deviceId: 'hdp-blaster', name: 'IR-Blaster Schlafzimmer',
    irRecordings: {},
    hardwareConfig: {
      device_type: 'ir_transceiver',
      receiver: { enabled: false }, blaster: { enabled: true, pin: 4 },
    },
    bindings: { ir: {} },
  };
  const library = hdp.irRecordingLibrary([receiverDevice, blasterDevice]);
  assert.deepEqual(library.map((item) => [item.id, item.device.deviceId]), [
    ['avr_aus', 'hdp-receiver'], ['fernseher_ein', 'hdp-receiver'],
  ]);
  // Nicht gekoppelte Geräte bleiben außen vor.
  assert.deepEqual(hdp.irRecordingLibrary([{ ...receiverDevice, paired: false }]), []);
});

test('die Geräteseite zeigt die Bibliothek auch bei reinem Blaster', () => {
  const source = fs.readFileSync(path.join(__dirname, '../adapter/hdp/index.js'), 'utf8');
  const page = source.slice(source.indexOf('function renderIrDevicePage'),
    source.indexOf('function renderDevicePage'));
  // Die Liste stammt aus der instanzweiten Bibliothek, nicht aus dem Einzelgerät.
  assert.match(page, /const library = irRecordingLibrary\(Array\.from\(devices\.values\(\)\)\)/);
  assert.doesNotMatch(page, /Object\.entries\(device\.irRecordings/);
  assert.match(page, /const canSend = !!blaster\.enabled/);
  assert.match(page, /const recordingSection = canRecord \|\| canSend/);
  assert.match(page, /Aufgezeichnet von /);
  // Senden hängt am Blaster der angezeigten Seite, nicht am Aufnahmemodus.
  assert.match(page, /\$\{canSend \? `<button class="button-secondary" formaction="\$\{base\}\/send/);
});

test('Senden, Umbenennen und Löschen finden Aufnahmen geräteübergreifend', () => {
  const source = fs.readFileSync(path.join(__dirname, '../adapter/hdp/index.js'), 'utf8');
  assert.match(source, /function findIrRecording\(recordingId\)/);
  const send = source.slice(source.indexOf("action.startsWith('ir/recordings/send/')"));
  assert.match(send.slice(0, 600), /const found = findIrRecording\(recordingId\);[\s\S]*writeIrBlaster\(device, found\.entry\.code\)/);
  const remove = source.slice(source.indexOf("action.startsWith('ir/recordings/delete/')"));
  assert.match(remove.slice(0, 500), /delete found\.device\.irRecordings\[recordingId\]/);
  const rename = source.slice(source.indexOf("action.startsWith('ir/recordings/rename/')"));
  assert.match(rename.slice(0, 800), /const owner = found\.device;/);
  // Der Live-Refresh reagiert auf Aufnahmen aller Geräte.
  assert.match(source, /function irRecordingLiveState\(device\)/);
  assert.match(source, /recordings: irRecordingLibrary\(Array\.from\(devices\.values\(\)\)\)/);
});
