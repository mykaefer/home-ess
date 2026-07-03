'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  unwrapMqttMessage,
  unwrapMqttPayload,
  parseSchemeTopic,
  isSchemeTopic,
  buildSchemeTopic,
  normalizeMqttTopic,
  isRadioTopic,
  mqttReadCandidates,
  mqttWriteCandidates,
} = require('../src/mqtt/topics');

test('normalizeMqttTopic zerstört das "://" von Adapter-Topics nicht', () => {
  // Regression: Kollabieren doppelter Slashes machte modbus://… zu modbus:/…,
  // wodurch das Topic nicht mehr als Adapter-Topic erkannt und fälschlich über
  // den Broker geroutet wurde → beim Konsumenten kam kein Wert an.
  const topic = 'modbus://victron/1/40001';
  assert.equal(normalizeMqttTopic(topic), topic);
  assert.equal(isSchemeTopic(normalizeMqttTopic(topic)), true);
  // Normale Broker-Topics werden weiterhin bereinigt.
  assert.equal(normalizeMqttTopic('/Heizung//Vorlauf/'), 'Heizung/Vorlauf/');
});

test('ack:true marks a confirmed broker state', () => {
  assert.deepEqual(unwrapMqttMessage('{"val":1,"ack":true}'), { value: 1, ack: true });
});

test('ack:false is recognised as a write command, not confirmed state', () => {
  // Das ist u. a. das Echo unserer eigenen Schreibvorgänge auf dem Haupt-Topic.
  assert.deepEqual(unwrapMqttMessage('{"val":0,"ack":false}'), { value: 0, ack: false });
});

test('plain values and ack-less JSON carry no ack flag', () => {
  assert.deepEqual(unwrapMqttMessage('50.1'), { value: '50.1', ack: null });
  assert.deepEqual(unwrapMqttMessage('{"val":5}'), { value: 5, ack: null });
  assert.deepEqual(unwrapMqttMessage('{"power":123}'), { value: '{"power":123}', ack: null });
});

test('unwrapMqttPayload stays backward compatible (value only)', () => {
  assert.equal(unwrapMqttPayload('{"val":42,"ack":true}'), 42);
  assert.equal(unwrapMqttPayload('hello'), 'hello');
});

test('parseSchemeTopic erkennt Adapter-Topics prefix://instanz/adresse', () => {
  assert.deepEqual(parseSchemeTopic('modbus://victron/register/123'), {
    scheme: 'modbus',
    instance: 'victron',
    address: 'register/123',
  });
  assert.deepEqual(parseSchemeTopic('demo://sim1'), {
    scheme: 'demo',
    instance: 'sim1',
    address: '',
  });
});

test('parseSchemeTopic liefert null für normale ioBroker-Topics', () => {
  assert.equal(parseSchemeTopic('battery.0.soc'), null);
  assert.equal(parseSchemeTopic('Heizung/Vorlauf'), null);
  assert.equal(parseSchemeTopic(''), null);
  assert.equal(isSchemeTopic('mqtt.0.foo'), false);
  assert.equal(isSchemeTopic('demo://sim1/x'), true);
});

test('isRadioTopic erkennt Homematic-Topics in Punkt- und Slash-Notation', () => {
  assert.equal(isRadioTopic('hm-rpc.0.00085A499BECF6.4.STATE'), true);
  assert.equal(isRadioTopic('hm-rpc/0/00085A499BECF6/4/STATE'), true);
  assert.equal(isRadioTopic('HM-RPC.1.ABC.3.STATE'), true);
  // Andere Adapter und Schema-Topics sind keine Funk-Topics.
  assert.equal(isRadioTopic('zigbee.0.b0c7defffe8165af.state'), false);
  assert.equal(isRadioTopic('0_userdata.0.Status.PV-Direct-Sun'), false);
  assert.equal(isRadioTopic('shelly.0.SHSW-1#244CAB44336A#1.Relay0.Switch'), false);
  assert.equal(isRadioTopic('tasmota://Tasmota/Kueche/Boiler/POWER'), false);
  assert.equal(isRadioTopic(''), false);
});

test('mqttWriteCandidates fächert Funk-Topics NICHT auf', () => {
  // Duty-Cycle: Punkt- und Slash-Variante landen beim Broker auf derselben
  // hm-rpc-State-ID – jede Variante wäre ein eigener Funkbefehl. Beim
  // Schreiben darf es deshalb genau einen Kandidaten geben.
  const topic = 'hm-rpc.0.00085A499BECF6.4.STATE';
  assert.ok(mqttReadCandidates(topic).length > 1); // Lesen fächert weiterhin auf
  assert.deepEqual(mqttWriteCandidates(topic), [topic]);
});

test('mqttWriteCandidates behält die Auffächerung für Nicht-Funk-Topics', () => {
  const topic = '0_userdata.0.Status.PV-Direct-Sun';
  assert.deepEqual(mqttWriteCandidates(topic), mqttReadCandidates(topic));
});

test('buildSchemeTopic ist invers zu parseSchemeTopic', () => {
  const topic = buildSchemeTopic('Modbus', 'victron', 'reg/1');
  assert.equal(topic, 'modbus://victron/reg/1');
  const parsed = parseSchemeTopic(topic);
  assert.equal(buildSchemeTopic(parsed.scheme, parsed.instance, parsed.address), topic);
});
