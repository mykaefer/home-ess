'use strict';

// Zentraler Betriebslevel-Handler (Lastmanagement).
//
// Verbraucher registrieren sich mit einer Priorität. Die Priorität entspricht dem
// Betriebslevel, ab dem ein Verbraucher laufen darf: erlaubt ⇔ aktuelles Level >= Priorität.
// (Priorität 4 ⇒ erlaubt bei Level 4 und 5, verboten bei 1–3.)
//
// - Verbraucher melden sich über register() an und re-registrieren sich bei
//   Prioritätsänderung (erneuter register()-Aufruf überschreibt die Priorität).
// - Vor jedem Einschalten holt sich ein Verbraucher über requestTurnOn() die Bestätigung.
// - Sinkt das Betriebslevel, fordert der Handler alle nicht mehr erlaubten Verbraucher
//   über ihren onMustTurnOff-Callback zum sofortigen Abschalten auf.

const operatingState = require('../operating-state');

const consumers = new Map(); // id -> { priority, onMustTurnOff }
let currentLevel = null;
let unsubscribe = null;

function clampLevel(value) {
  return Math.min(5, Math.max(1, Math.round(Number(value) || 1)));
}

// Aktuelles Betriebslevel. Vor init() Rückgriff auf den persistierten Zustand.
function currentOperatingLevel() {
  return currentLevel != null ? currentLevel : operatingState.getState().operatingLevel;
}

// Darf ein Verbraucher mit der gegebenen Priorität beim aktuellen Betriebslevel laufen?
function isAllowed(priority) {
  return currentOperatingLevel() >= clampLevel(priority);
}

// Verbraucher anmelden oder Priorität aktualisieren (Re-Registrierung).
function register(id, priority, options = {}) {
  if (!id) return;
  const entry = consumers.get(id) || {};
  entry.priority = clampLevel(priority);
  if (typeof options.onMustTurnOff === 'function') entry.onMustTurnOff = options.onMustTurnOff;
  consumers.set(id, entry);
}

function unregister(id) {
  consumers.delete(id);
}

// Bestätigung vor dem Einschalten: true, wenn der Verbraucher registriert ist und laufen darf.
function requestTurnOn(id) {
  const entry = consumers.get(id);
  return !!entry && isAllowed(entry.priority);
}

// Auf einen Levelwechsel reagieren: nicht mehr erlaubte Verbraucher zum Abschalten auffordern.
function applyLevel(level) {
  currentLevel = clampLevel(level);
  for (const entry of consumers.values()) {
    if (!isAllowed(entry.priority) && typeof entry.onMustTurnOff === 'function') {
      try { entry.onMustTurnOff(); } catch (_) {}
    }
  }
}

function init() {
  currentLevel = clampLevel(operatingState.getState().operatingLevel);
  if (!unsubscribe) {
    unsubscribe = operatingState.onOperatingLevelChanged((level) => applyLevel(level));
  }
}

module.exports = {
  init, register, unregister, requestTurnOn, isAllowed,
  currentOperatingLevel, applyLevel,
};
