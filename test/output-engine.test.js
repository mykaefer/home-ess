'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { valuesEqual, readbackNeedsVerification, readbackKey } = require('../src/output/engine');
const { secondsUntilNextCharge } = require('../src/output/internal-values');

test('Output-Readback vergleicht Zahlen unabhängig von MQTT-Darstellung', () => {
  assert.equal(valuesEqual('12.50', 12.5), true);
  assert.equal(valuesEqual('12,50', 12.5), true);
  assert.equal(valuesEqual('12.51', 12.5), false);
});

test('Output-Readback erkennt boolesche ioBroker-Darstellungen', () => {
  assert.equal(valuesEqual('true', true), true);
  assert.equal(valuesEqual(1, true), true);
  assert.equal(valuesEqual('0', false), true);
  assert.equal(valuesEqual(false, true), false);
});

test('Nächster Wallbox-Ladebeginn liefert ohne Sollwert 0 Sekunden', () => {
  assert.equal(secondsUntilNextCharge(null, 1_000_000), 0);
  assert.equal(secondsUntilNextCharge({ at: 1_045_000 }, 1_000_000), 45);
});

const NOW = 100000;
const VERIFY_MS = 30000;

test('Bestätigte Outputs brauchen keine erneute Prüfung, solange die Bestätigung frisch ist', () => {
  const output = { id: 1, targetTopic: 'haus/licht' };
  const key = readbackKey(output.targetTopic);
  const outputs = [output];
  const statuses = new Map([[1, { state: 'confirmed' }]]);

  // Bestätigt und innerhalb des letzten Prüffensters empfangen -> kein /get nötig.
  const freshCache = new Map([[key, { receivedAt: NOW - 5000 }]]);
  assert.equal(readbackNeedsVerification(key, NOW, freshCache, outputs, statuses), false);

  // Bestätigt, aber der angezeigte Wert ist älter als ein Prüffenster -> erneut prüfen.
  const staleCache = new Map([[key, { receivedAt: NOW - VERIFY_MS - 1000 }]]);
  assert.equal(readbackNeedsVerification(key, NOW, staleCache, outputs, statuses), true);
});

test('Nicht bestätigte Outputs werden unabhängig vom Alter geprüft', () => {
  const output = { id: 1, targetTopic: 'haus/licht' };
  const key = readbackKey(output.targetTopic);
  const outputs = [output];
  const freshCache = new Map([[key, { receivedAt: NOW }]]);

  // waiting -> Prüfung nötig, auch bei frischem Wert.
  assert.equal(
    readbackNeedsVerification(key, NOW, freshCache, outputs, new Map([[1, { state: 'waiting' }]])),
    true
  );
  // Noch kein Status vorhanden -> Prüfung nötig.
  assert.equal(readbackNeedsVerification(key, NOW, freshCache, outputs, new Map()), true);
});

test('Prüfung nötig, wenn einer von mehreren Outputs auf dasselbe Ziel nicht bestätigt ist', () => {
  const outputs = [
    { id: 1, targetTopic: 'haus/licht' },
    { id: 2, targetTopic: 'haus/licht' },
  ];
  const key = readbackKey('haus/licht');
  const cache = new Map([[key, { receivedAt: NOW }]]);
  const statuses = new Map([
    [1, { state: 'confirmed' }],
    [2, { state: 'mismatch' }],
  ]);
  assert.equal(readbackNeedsVerification(key, NOW, cache, outputs, statuses), true);
});

test('Command-Topics werden bei der Prüfung ignoriert', () => {
  const outputs = [{ id: 1, targetTopic: 'haus/licht.SET' }];
  const key = readbackKey('haus/licht.SET');
  // .SET ist ein Kommando-Topic -> kein Readback -> keine Prüfung.
  assert.equal(readbackNeedsVerification(key, NOW, new Map(), outputs, new Map()), false);
});
