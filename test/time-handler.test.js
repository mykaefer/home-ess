'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timeHandler = require('../src/time-handler');
const { ENVIRONMENT_STATE_IDS } = require('../src/mqtt/config');
const { topicForId } = require('../src/states/system-topics');

test.afterEach(() => timeHandler.resetForTests());

function cacheSample(isoDate, isoTime, receivedAt) {
  return new Map([
    [ENVIRONMENT_STATE_IDS.clockDate, { value: isoDate, receivedAt }],
    [ENVIRONMENT_STATE_IDS.clockTime, { value: isoTime, receivedAt }],
  ]);
}

test('ohne MQTT läuft die interne Uhr dauerhaft aus der lokalen Systemzeit weiter', () => {
  timeHandler.configure({ timezone: 'Europe/Berlin', dstEnabled: 1 });
  const first = timeHandler.snapshot(Date.parse('2026-08-03T10:00:00Z'));
  const later = timeHandler.snapshot(Date.parse('2026-08-03T10:05:17Z'));
  assert.equal(first.internal.time, '12:00:00');
  assert.equal(later.internal.time, '12:05:17');
  assert.equal(later.mqtt.available, false);
});

test('ein Cachewert wird ohne konfiguriertes MQTT-Zeittopic nicht als Zeitquelle verwendet', () => {
  timeHandler.configure({ timezone: 'UTC', dstEnabled: true, clockTimeTopic: '', clockDateTopic: '' });
  const t0 = Date.parse('2026-08-03T10:00:00Z');
  assert.equal(timeHandler.observeCache(cacheSample('03.08.2026', '11:00:00', t0)), false);
  assert.equal(timeHandler.snapshot(t0).internal.time, '10:00:00');
});

test('MQTT-Zeit bildet einen gleitenden Versatz, der nach MQTT-Ausfall weiterläuft', () => {
  timeHandler.configure({ timezone: 'UTC', dstEnabled: 1, clockTimeTopic: 'clock/time', clockDateTopic: 'clock/date' });
  const t0 = Date.parse('2026-08-03T10:00:00Z');
  assert.equal(timeHandler.observeCache(cacheSample('03.08.2026', '10:00:10', t0)), true);
  const t1 = t0 + 60000;
  assert.equal(timeHandler.observeCache(cacheSample('03.08.2026', '10:01:14', t1)), true);

  const status = timeHandler.snapshot(t1 + 5 * 60000);
  assert.equal(status.offsetSeconds, 12);
  assert.equal(status.internal.time, '10:06:12');
  assert.equal(status.mqtt.available, true);
  assert.equal(status.mqtt.fresh, false);
});

test('Zeitzone und deaktivierte Sommerzeit bestimmen die interne Wanduhr', () => {
  const noonUtc = Date.parse('2026-07-15T12:00:00Z');
  timeHandler.configure({ timezone: 'Europe/Berlin', dstEnabled: 1 });
  assert.equal(timeHandler.snapshot(noonUtc).internal.time, '14:00:00');
  timeHandler.configure({ timezone: 'Europe/Berlin', dstEnabled: 0 });
  assert.equal(timeHandler.snapshot(noonUtc).internal.time, '13:00:00');
});

test('interne Uhrzeit und Datum werden als Betrieb-Systemstates formatiert', () => {
  timeHandler.configure({ timezone: 'UTC', dstEnabled: 1 });
  const entries = timeHandler.stateEntries(Date.parse('2026-08-03T04:05:06Z'));
  assert.deepEqual(entries, [
    { id: 'operating.time', value: '04:05:06', display: '04:05:06' },
    { id: 'operating.date', value: '03.08.2026', display: '03.08.2026' },
  ]);
  assert.equal(topicForId(entries[0].id), 'system://homeess/operating.time');
  assert.equal(topicForId(entries[1].id), 'system://homeess/operating.date');
});

test('der Datumswechsel folgt der versetzten internen Uhr', () => {
  timeHandler.configure({ timezone: 'UTC', dstEnabled: true, clockTimeTopic: 'clock/time', clockDateTopic: 'clock/date' });
  const beforeMidnight = Date.parse('2026-08-03T23:59:55Z');
  timeHandler.observeCache(cacheSample('04.08.2026', '00:00:05', beforeMidnight));
  const status = timeHandler.snapshot(beforeMidnight);
  assert.equal(status.offsetSeconds, 10);
  assert.equal(status.internal.time, '00:00:05');
  assert.equal(status.internal.date, '04.08.2026');
});
