'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bus = require('../src/state-bus');
const grid = require('../src/grid-control/automation');
const behavior = require('../src/prognosis/behavior');
const jobs = require('../src/job-scheduler');

test('Batch-Ingest aktualisiert alle Werte mit nur einem Event', () => {
  let events = 0;
  let changed = [];
  const off = bus.onValuesChanged((event) => { events += 1; changed = event.changedKeys; });
  bus.ingestBatch([
    { cacheKeys: ['perf.a'], value: 1 },
    { cacheKeys: ['perf.b'], value: 2 },
  ], { receivedAt: 100 });
  assert.equal(events, 1);
  assert.deepEqual(changed, ['perf.a', 'perf.b']);
  bus.ingestBatch([
    { cacheKeys: ['perf.a'], value: 1 },
    { cacheKeys: ['perf.b'], value: 2 },
  ], { receivedAt: 200 });
  assert.equal(events, 1);
  assert.equal(bus.getCache().get('perf.a').receivedAt, 200);
  off();
  bus.remove('perf.a');
  bus.remove('perf.b');
});

test('Regelungen filtern fachfremde Events', () => {
  assert.equal(grid.isRelevantEvent({ changedKeys: ['pv:1:power'] }), false);
  assert.equal(grid.isRelevantEvent({ changedKeys: ['batterie.soc'] }), true);
  assert.equal(behavior.isRelevantEvent({ changedKeys: ['pv:1:power'] }), false);
  assert.equal(behavior.isRelevantEvent({ changedKeys: ['stromverbrauch_netzbezug_zaehler_l1'] }), true);
});

test('Scheduler lässt denselben Job nicht überlappen', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = jobs.runExclusive('test-overlap', async () => { calls += 1; await blocked; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await jobs.runExclusive('test-overlap', async () => { calls += 1; }), false);
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});
