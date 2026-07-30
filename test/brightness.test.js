'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  astronomicalBrightnessPercent,
  combineBrightnessPercent,
  computeBrightnessPercent,
} = require('../src/photovoltaik/sun-intensity');
const { ENVIRONMENT_STATE_IDS } = require('../src/mqtt/config');

test('Helligkeit bildet Dämmerung, Tagesplateau und Nacht als Trapez ab', () => {
  assert.equal(astronomicalBrightnessPercent(-7), 0);
  assert.equal(astronomicalBrightnessPercent(-6), 0);
  assert.equal(astronomicalBrightnessPercent(-3), 50);
  assert.equal(astronomicalBrightnessPercent(0), 100);
  assert.equal(astronomicalBrightnessPercent(45), 100);
});

test('Sonnenintensität beeinflusst 60 %, diffuses Tageslicht bleibt zu 40 % erhalten', () => {
  assert.equal(combineBrightnessPercent(100, 100), 100);
  assert.equal(combineBrightnessPercent(100, 50), 70);
  assert.equal(combineBrightnessPercent(100, 0), 40);
  assert.equal(combineBrightnessPercent(50, 0), 20);
  assert.equal(combineBrightnessPercent(50, null), 50);
});

test('Helligkeit bleibt nachts auch ohne Leistungswert bei 0 %', () => {
  const cache = new Map([
    [ENVIRONMENT_STATE_IDS.clockDate, { value: '30.07.2026' }],
    [ENVIRONMENT_STATE_IDS.clockTime, { value: '00:00:00' }],
  ]);
  const config = { latitude: 50, longitude: 10, timezone: 'UTC', dstEnabled: 0 };

  assert.equal(computeBrightnessPercent(config, cache, null), 0);
});
