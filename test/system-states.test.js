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

test('Topic-Picker klappt in die Richtung mit mehr Platz auf', () => {
  const script = statePickerScript();
  assert.match(script, /var openUp = spaceAbove > spaceBelow;/);

  // Dieselbe Entscheidung nachvollzogen: maßgeblich ist allein, auf welcher
  // Seite des Feldes mehr Raum bleibt.
  const opensUp = (viewportHeight, fieldTop, fieldBottom) =>
    fieldTop > viewportHeight - fieldBottom;
  // Feld in der unteren Hälfte → nach oben.
  assert.equal(opensUp(1000, 800, 830), true);
  // Feld in der oberen Hälfte → nach unten, auch wenn es unten eng wird.
  assert.equal(opensUp(1000, 120, 150), false);
  // Knapp unter der Mitte reicht bereits aus.
  assert.equal(opensUp(1000, 510, 540), true);
  // Genau mittig: es bleibt bei der gewohnten Richtung nach unten.
  assert.equal(opensUp(1000, 485, 515), false);
});

test('Topic-Picker öffnet bis zur doppelten Breite, soweit der Platz reicht', () => {
  const script = statePickerScript();
  // Grundbreite und Höchstbreite (das Doppelte davon) stehen im Skript …
  assert.match(script, /var STATE_PICKER_WIDTH = 460;/);
  assert.match(script, /var STATE_PICKER_WIDTH_MAX = STATE_PICKER_WIDTH \* 2;/);
  // … und die Positionierung nimmt sich so viel, wie der Viewport hergibt.
  assert.match(script, /var width = Math\.min\(STATE_PICKER_WIDTH_MAX, vw - 16\);/);

  // Dieselbe Rechnung nachvollzogen: breiter Bildschirm → doppelte Breite,
  // schmaler → so viel wie möglich.
  const widthFor = (vw) => Math.min(460 * 2, vw - 16);
  assert.equal(widthFor(1920), 920);
  assert.equal(widthFor(1000), 920);
  assert.equal(widthFor(800), 784);
  assert.equal(widthFor(400), 384);
});
