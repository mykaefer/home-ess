'use strict';

const { monitorEventLoopDelay, performance } = require('perf_hooks');

const enabled = /^(1|true)$/i.test(process.env.HOMEESS_PERF_DEBUG || '');
const counters = new Map();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
if (enabled) loopDelay.enable();

function counter(name, amount = 1) {
  if (!enabled) return;
  counters.set(name, (counters.get(name) || 0) + amount);
}

async function measure(name, fn) {
  if (!enabled) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    counter(`${name}.calls`);
    counter(`${name}.ms`, performance.now() - started);
  }
}

function snapshot({ reset = false } = {}) {
  const values = Object.fromEntries(counters);
  if (enabled) {
    values['eventLoop.meanMs'] = Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : 0;
    values['eventLoop.maxMs'] = Number.isFinite(loopDelay.max) ? loopDelay.max / 1e6 : 0;
  }
  if (reset) {
    counters.clear();
    if (enabled) loopDelay.reset();
  }
  return values;
}

let reportTimer = null;
function startReporter() {
  if (!enabled || reportTimer) return;
  reportTimer = setInterval(() => console.log('[perf]', JSON.stringify(snapshot({ reset: true }))), 60000);
  if (reportTimer.unref) reportTimer.unref();
}

startReporter();

module.exports = { enabled, counter, measure, snapshot };
