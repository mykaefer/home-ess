'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bus = require('../src/state-bus');
const mqttClient = require('../src/mqtt/client');
const systemRouter = require('../src/states/system-router');
const { topicForId, parseSystemTopic } = require('../src/states/system-topics');
const { statePickerScript } = require('../src/views/state-picker');

test('Systemwerte besitzen stabile, adressierbare system://-Topics', () => {
  assert.equal(topicForId('pv.current'), 'system://homeess/pv.current');
  assert.deepEqual(parseSystemTopic('system://homeess/pv.current'), {
    id: 'pv.current',
    topic: 'system://homeess/pv.current',
  });
  assert.equal(parseSystemTopic('modbus://victron/soc'), null);
});

test('System-Topic wird an konfigurierte Cache-IDs weitergeleitet', () => {
  systemRouter.clear();
  mqttClient.setStateDefinitions([
    { id: 'verbrauch.test', topic: 'system://homeess/pv.current' },
  ]);

  systemRouter.publish([{ id: 'pv.current', value: 812 }], 1234);

  assert.equal(bus.getCache().get('system://homeess/pv.current').value, 812);
  assert.equal(bus.getCache().get('verbrauch.test').value, 812);
  assert.equal(bus.getCache().get('verbrauch.test').receivedAt, 1234);

  mqttClient.setStateDefinitions([]);
  systemRouter.clear();
  bus.remove('system://homeess/pv.current');
  bus.remove('verbrauch.test');
});

test('Topic-Picker rendert die zentrale System-Hauptgruppe sprechend', () => {
  const script = statePickerScript();
  assert.ok(script.includes("inst.system ? 'System'"));
  assert.ok(script.includes('st.topic'));
});
