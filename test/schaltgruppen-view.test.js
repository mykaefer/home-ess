'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const renderSchaltgruppen = require('../src/views/schaltgruppen');

function sampleHtml() {
  return renderSchaltgruppen({
    groups: [{
      id: 1, name: 'Wohnzimmer', on: true, switchAsUnit: false, remoteTopic: '', timerMinutes: 0,
      actors: [{ id: 10, name: 'TV', statusOn: true, powerDisplay: '55 W' }],
    }],
    unassigned: [{ id: 20, name: 'Stehlampe', statusOn: false, powerDisplay: '0 W' }],
    groupConfigs: [{ id: 1, name: 'Wohnzimmer', remoteTopic: '', switchAsUnit: false, timerMinutes: 0 }],
  });
}

test('Schaltgruppen-View: „+ Gerät hinzufügen" öffnet den Geräte-Auswahldialog', () => {
  const html = sampleHtml();
  assert.ok(html.includes('id="sgDevicePicker"'));            // Auswahldialog vorhanden
  assert.ok(html.includes('+ Gerät hinzufügen'));             // Add-Button je Gruppe
  assert.ok(html.includes('openDevicePicker(1'));             // an die Gruppe gebunden
  assert.ok(html.includes('function renderPickerList'));      // füllt sich aus dem Pool
});

test('Schaltgruppen-View: klickbares Lösen (×) als Drag-&-Drop-Alternative', () => {
  const html = sampleHtml();
  assert.ok(html.includes('unassignActor(10)'));   // Mitglied lösbar
  assert.ok(html.includes('sg-row-remove'));        // ×-Button gerendert
  assert.ok(html.includes('function unassignActor'));
  assert.ok(html.includes('function assignActor'));
});
