'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../src/operating-level/handler');

test('isAllowed: Verbraucher darf ab Level >= Priorität laufen', () => {
  handler.applyLevel(3);
  assert.equal(handler.isAllowed(2), true);
  assert.equal(handler.isAllowed(3), true);
  assert.equal(handler.isAllowed(4), false);
  assert.equal(handler.isAllowed(5), false);
});

test('requestTurnOn nur für registrierte und erlaubte Verbraucher', () => {
  handler.applyLevel(4);
  handler.register('t.a', 4);
  handler.register('t.b', 5);
  assert.equal(handler.requestTurnOn('t.a'), true);
  assert.equal(handler.requestTurnOn('t.b'), false);
  assert.equal(handler.requestTurnOn('t.unknown'), false);
  handler.unregister('t.a');
  handler.unregister('t.b');
});

test('Levelabsenkung fordert nur nicht mehr erlaubte Verbraucher zum Abschalten auf', () => {
  let lowOff = 0;
  let highOff = 0;
  handler.register('t.low', 2, { onMustTurnOff: () => { lowOff += 1; } });
  handler.register('t.high', 4, { onMustTurnOff: () => { highOff += 1; } });

  handler.applyLevel(5); // beide erlaubt
  assert.equal(lowOff, 0);
  assert.equal(highOff, 0);

  handler.applyLevel(3); // Priorität 4 nicht mehr erlaubt
  assert.equal(lowOff, 0);
  assert.equal(highOff, 1);

  handler.applyLevel(1); // beide verboten
  assert.equal(lowOff, 1);
  assert.equal(highOff, 2);

  handler.unregister('t.low');
  handler.unregister('t.high');
});

test('Re-Registrierung aktualisiert die Priorität', () => {
  handler.applyLevel(3);
  handler.register('t.c', 2);
  assert.equal(handler.requestTurnOn('t.c'), true);
  handler.register('t.c', 4); // neue Priorität
  assert.equal(handler.requestTurnOn('t.c'), false);
  handler.unregister('t.c');
});

test('unregister entfernt den Verbraucher aus dem Lastmanagement', () => {
  let off = 0;
  handler.register('t.d', 5, { onMustTurnOff: () => { off += 1; } });
  handler.unregister('t.d');
  handler.applyLevel(1);
  assert.equal(off, 0);
  assert.equal(handler.requestTurnOn('t.d'), false);
});

test('Priorität wird auf 1–5 begrenzt', () => {
  handler.applyLevel(1);
  assert.equal(handler.isAllowed(0), true); // < 1 → 1
  assert.equal(handler.isAllowed(9), false); // > 5 → 5
  handler.applyLevel(5);
  assert.equal(handler.isAllowed(9), true);
});
