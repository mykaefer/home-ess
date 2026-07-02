'use strict';

const metrics = require('./runtime-metrics');

const running = new Set();

async function runExclusive(name, job) {
  if (running.has(name)) {
    metrics.counter(`job.${name}.overlapSkipped`);
    return false;
  }
  running.add(name);
  try {
    await metrics.measure(`job.${name}`, job);
    return true;
  } finally {
    running.delete(name);
  }
}

function schedule(name, intervalMs, job) {
  const timer = setInterval(() => runExclusive(name, job).catch(() => {}), intervalMs);
  return timer;
}

module.exports = { runExclusive, schedule };
