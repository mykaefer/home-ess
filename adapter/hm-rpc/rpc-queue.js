'use strict';

// Eine Warteschlange für ALLE ausgehenden Aufrufe einer Schnittstelle. Das
// Netzwerkzeitlimit beginnt erst bei Ausführung, nicht während der Wartezeit.
module.exports = function createQueue() {
  const waiting = [];
  const keyed = new Map();
  let running = false;
  let closed = false;

  async function drain() {
    if (running) return;
    running = true;
    while (waiting.length) {
      waiting.sort((a, b) => b.priority - a.priority);
      const job = waiting.shift();
      // Schreibwerte dürfen nur ersetzt werden, solange sie noch warten.
      if (job.replace && job.key) keyed.delete(job.key);
      try {
        if (Date.now() > job.expires) throw Object.assign(new Error('RPC-Auftrag in Warteschlange abgelaufen'), { cancelled: true });
        job.resolve(await job.work());
      } catch (err) { job.reject(err); }
      finally { if (keyed.get(job.key) === job) keyed.delete(job.key); }
    }
    running = false;
  }

  return {
    run(work, { key, replace = false, priority = 0, maxAge = 30000 } = {}) {
      if (closed) return Promise.reject(new Error('RPC-Warteschlange gestoppt'));
      const existing = key && keyed.get(key);
      if (existing) {
        if (replace) { existing.work = work; existing.expires = Date.now() + maxAge; }
        return existing.promise;
      }
      if (waiting.length >= 1000) return Promise.reject(Object.assign(new Error('RPC-Warteschlange voll'), { cancelled: true }));
      const job = { work, key, replace, priority, expires: Date.now() + maxAge };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      if (key) keyed.set(key, job);
      waiting.push(job);
      queueMicrotask(drain);
      return job.promise;
    },
    close() {
      closed = true;
      for (const job of waiting.splice(0)) job.reject(new Error('RPC-Warteschlange gestoppt'));
      keyed.clear();
    },
  };
};
