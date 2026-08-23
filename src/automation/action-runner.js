'use strict';

// Ausführung von Aktionsfolgen (automation/action-sequences.js): Werte
// zuweisen, Pausen abwarten, Schleifen mehrfach durchlaufen.
//
// Eine Folge läuft von oben nach unten. Jede Folge hat einen Schlüssel (beim
// Heimkino der Raum, bei der Heizung Raum + Gerät); eine neue Ausführung
// desselben Schlüssels bricht die noch laufende ab — der zuletzt gewünschte
// Zustand gewinnt.
//
// Schleifen mit aktivierter Prüfung sind zusätzlich eine dauerhafte
// Plausibilitätsprüfung: trifft ihre Bedingung nicht zu, wird ausschließlich
// diese Schleife noch einmal abgespult (nicht die übrige Folge). Wann geprüft
// wird, entscheidet das aufrufende Modul — es weiß, welche Folge gerade gilt.

const bus = require('../state-bus');
const mqttClient = require('../mqtt/client');
const values = require('../conditions/values');
const conditionEngine = require('../conditions/engine');

class Cancelled extends Error {}

// Felder einer Aktion, die wahlweise einen festen Wert oder ein Topic tragen.
function referencedSlots(action) {
  const slots = [];
  if (action.type === 'write') {
    const config = action.config || {};
    if (values.isTopicReference(config.value)) slots.push(['value', config.value]);
    if ((config.operation || 'set') !== 'set' && values.isTopicReference(config.value2)) slots.push(['value2', config.value2]);
  }
  if (action.type === 'loop' && action.config && action.config.checkEnabled && action.config.check) {
    const check = action.config.check;
    slots.push(['check', check.topic]);
    if (!['truthy', 'falsy'].includes(check.operator) && values.isTopicReference(check.value)) {
      slots.push(['checkValue', check.value]);
    }
  }
  return slots;
}

function createActionRunner(namespace) {
  const runTokens = new Map(); // Schlüssel -> laufende Ausführung
  const busyKeys = new Set();
  const busyLoops = new Set();

  function cacheKey(actionId, slot) {
    return `${namespace}:action:${actionId}:${slot}`;
  }

  // Aktueller Wert eines Feldes: fester Wert als Literal, Topic-Verweis aus dem
  // zuletzt bekannten Wert des Ziel-States (wie bei den Bedingungen).
  function operandValue(action, slot, raw) {
    if (!values.isTopicReference(raw)) return { known: true, value: conditionEngine.literal(raw), topic: null };
    const entry = bus.getCache().get(cacheKey(action.id, slot));
    return { known: !!entry, value: entry ? entry.value : null, topic: String(raw).trim() };
  }

  // Zu schreibender Wert einer Wert-Zuweisung – identisch zum „Dann" der
  // Bedingungen: fester Wert, Topic-Wert oder Ergebnis der Rechenfunktion.
  function writeValue(action) {
    const config = action.config || {};
    const operation = config.operation || 'set';
    const round = config.round == null ? null : Number(config.round);
    const first = operandValue(action, 'value', config.value);
    if (!first.known) throw new Error(`Kein Wert für ${first.topic} verfügbar.`);
    if (operation === 'set') {
      if (round == null) return first.value;
      const number = values.toNumber(first.value);
      if (number == null) throw new Error(`Wert muss zum Runden numerisch sein: ${first.topic || config.value}`);
      return values.roundTo(number, round);
    }
    const second = operandValue(action, 'value2', config.value2);
    if (!second.known) throw new Error(`Kein Wert für ${second.topic} verfügbar.`);
    const left = values.toNumber(first.value);
    const right = values.toNumber(second.value);
    if (left == null) throw new Error(`Wert muss bei mathematischen Operatoren numerisch sein: ${first.topic || config.value}`);
    if (right == null) throw new Error(`Wert muss bei mathematischen Operatoren numerisch sein: ${second.topic || config.value2}`);
    return values.roundTo(values.applyOperation(operation, left, right), round);
  }

  function delay(ms, key, token) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (key != null && runTokens.get(key) !== token) reject(new Cancelled());
        else resolve();
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  function ensureActive(key, token) {
    if (key != null && runTokens.get(key) !== token) throw new Cancelled();
  }

  async function runList(list, key, token) {
    for (const action of list || []) {
      ensureActive(key, token);
      if (action.type === 'pause') {
        await delay(Math.max(0, Number(action.config.seconds || 0)) * 1000, key, token);
        continue;
      }
      if (action.type === 'write') {
        const value = writeValue(action);
        if (!mqttClient.publish(action.config.topic, value)) {
          throw new Error(`Ziel-State ${action.config.topic} konnte nicht geschrieben werden.`);
        }
        continue;
      }
      await runLoop(action, key, token);
    }
  }

  async function runLoop(loop, key, token, onFinished) {
    const repeats = Math.max(1, Number(loop.config.repeats) || 1);
    for (let pass = 0; pass < repeats; pass += 1) {
      ensureActive(key, token);
      await runList(loop.children, key, token);
    }
    if (typeof onFinished === 'function') onFinished(loop);
  }

  // Eine Folge komplett abarbeiten. Eine erneute Ausführung desselben
  // Schlüssels bricht sie ab.
  async function run(key, list) {
    const token = (runTokens.get(key) || 0) + 1;
    runTokens.set(key, token);
    busyKeys.add(key);
    try {
      await runList(list, key, token);
      return { status: 'done', count: (list || []).length };
    } catch (error) {
      if (error instanceof Cancelled) return { status: 'cancelled', count: 0 };
      throw error;
    } finally {
      if (runTokens.get(key) === token) busyKeys.delete(key);
    }
  }

  // Nur diese eine Schleife erneut abspulen – die übrige Folge bleibt unberührt.
  async function runLoopOnce(loop) {
    if (busyLoops.has(loop.id)) return { status: 'busy' };
    busyLoops.add(loop.id);
    try {
      await runLoop(loop, null, null);
      return { status: 'done' };
    } catch (error) {
      if (error instanceof Cancelled) return { status: 'cancelled' };
      throw error;
    } finally {
      busyLoops.delete(loop.id);
    }
  }

  // Prüfbedingung einer Schleife bewerten. Ein unbekannter Wert gilt bewusst als
  // „nicht erfüllt": genau dieser unklare Schaltzustand soll durch das erneute
  // Abspulen der Schleife aufgelöst werden.
  function checkFulfilled(loop) {
    const check = loop.config.check;
    if (!check) return true;
    const current = bus.getCache().get(cacheKey(loop.id, 'check'));
    if (!current) return false;
    if (['truthy', 'falsy'].includes(check.operator)) return conditionEngine.compare(current.value, check.operator);
    const expected = operandValue(loop, 'checkValue', check.value);
    if (!expected.known) return false;
    if (values.isMathOperator(check.operator)) {
      if (values.toNumber(current.value) == null || values.toNumber(expected.value) == null) return false;
    }
    return conditionEngine.compare(current.value, check.operator, expected.value);
  }

  function isBusy(key) {
    return busyKeys.has(key);
  }
  function isLoopBusy(loopId) {
    return busyLoops.has(loopId);
  }
  function reset() {
    runTokens.clear();
    busyKeys.clear();
    busyLoops.clear();
  }

  return {
    cacheKey, referencedSlots, writeValue, checkFulfilled,
    run, runLoopOnce, isBusy, isLoopBusy, reset, Cancelled,
  };
}

module.exports = { createActionRunner, referencedSlots, Cancelled };
