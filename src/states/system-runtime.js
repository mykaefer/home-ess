'use strict';

// Berechnet die Systemwerte reaktiv und veröffentlicht sie als adressierbare
// system://homeess/...-Topics. Ein kurzer Debounce bündelt MQTT-/Adapter-Bursts;
// der Intervalllauf hält rein zeitabhängige Werte aktuell.

const bus = require('../state-bus');
const { listCalculatedInternalValues, invalidateInternalValues } = require('./system-values');
const systemRouter = require('./system-router');

const DEBOUNCE_MS = 1000;
const REFRESH_MS = 15000;

let database = null;
let timer = null;
let interval = null;
let unsubscribe = null;
let evaluating = false;
let rerun = false;

async function evaluate() {
  if (!database) return;
  if (evaluating) {
    rerun = true;
    return;
  }
  evaluating = true;
  try {
    invalidateInternalValues();
    const values = await listCalculatedInternalValues(database, bus.getCache());
    systemRouter.publish(values);
  } finally {
    evaluating = false;
    if (rerun) {
      rerun = false;
      schedule();
    }
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    evaluate().catch(() => {});
  }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function init(db) {
  database = db;
  if (!unsubscribe) {
    unsubscribe = bus.onValuesChanged((event) => {
      // Eigene Veröffentlichungen dürfen keine dauernde Neuberechnungsschleife
      // auslösen (einige Systemwerte, z. B. Countdowns, ändern sich zeitabhängig).
      if (event && event.topic === 'system://homeess') return;
      schedule();
    });
  }
  if (!interval) {
    interval = setInterval(() => evaluate().catch(() => {}), REFRESH_MS);
    if (typeof interval.unref === 'function') interval.unref();
  }
  evaluate().catch(() => {});
}

module.exports = { init, evaluate, schedule };
