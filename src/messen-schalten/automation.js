'use strict';

// Steuerschleife der Messen-+-Schalten-Geräte (Vorbild: wallbox/automation.js).
// Alle Geräte mit Schalt-Topic nehmen am Betriebslevel teil. Unterhalb ihrer
// (effektiven) Priorität werden sie ausgeschaltet und dürfen auch manuell nicht
// eingeschaltet werden. „Immer an" bestimmt ausschließlich das Verhalten nach der
// erneuten Freigabe: automatische Wiedereinschaltung oder Warten auf den Benutzer.

const mqttClient = require('../mqtt/client');
const levelHandler = require('../operating-level/handler');
const { listActors, effectivePriority, cacheKey } = require('./actors');
const { listGroups } = require('./groups');
const { parseBool } = require('./aggregation');

function consumerId(actor) {
  return `geraet.${actor.id}`;
}

// In-Memory-Zustand je Gerät (nach Neustart zurückgesetzt – akzeptabel; der nächste
// Tick schreibt den korrekten Sollzustand ohnehin erneut).
const state = new Map();
function actorState(id) {
  let s = state.get(id);
  if (!s) {
    s = { output: null };
    state.set(id, s);
  }
  return s;
}

function sendSwitch(actor, on) {
  if (!actor.switchTopic) return;
  mqttClient.publish(actor.switchTopic, on ? '1' : '0');
}

// Tatsächlicher Ein-/Aus-Zustand eines Geräts aus dem Cache: bevorzugt das
// Status-Topic (echter Ist-Zustand), sonst das Schalt-Topic (Readback bzw. extern
// gesetzter Wert). null, solange kein Wert vorliegt.
function readActualOn(cache, actor) {
  if (actor.statusTopic) {
    const raw = (cache.get(cacheKey(actor.id, 'status')) || {}).value;
    if (raw != null && raw !== '') return parseBool(raw);
  }
  if (actor.switchTopic) {
    const raw = (cache.get(cacheKey(actor.id, 'switch')) || {}).value;
    if (raw != null && raw !== '') return parseBool(raw);
  }
  return null;
}

let _knownConsumers = new Set();

async function tick(db) {
  const cache = mqttClient.getCache();
  const actors = await listActors(db);
  const groups = await listGroups(db);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set();

  for (const actor of actors) {
    const id = consumerId(actor);
    const s = actorState(actor.id);

    // Nur reine Messgeräte ohne Schalt-Topic sind keine Verbraucher.
    if (!actor.switchTopic) {
      levelHandler.unregister(id);
      _knownConsumers.delete(id);
      continue;
    }

    const priority = effectivePriority(actor, groupsById);
    levelHandler.register(id, priority, { onMustTurnOff: () => forceOff(actor) });
    _knownConsumers.add(id);
    seen.add(id);

    const allowed = levelHandler.isAllowed(priority);
    const actualOn = readActualOn(cache, actor);

    if (allowed) {
      // Nur „Immer an" schaltet nach der Freigabe automatisch wieder ein. Manuelle
      // Geräte behalten ihren Zustand und warten gegebenenfalls auf den Benutzer.
      if (actor.alwaysOn) {
        if (actualOn !== true) sendSwitch(actor, true);
        s.output = 'on';
      }
    } else {
      // Priorität nicht erreicht ⇒ AUSschalten (auch extern/am Gerät eingeschaltet).
      if (actualOn === true || (actualOn == null && s.output !== 'off')) sendSwitch(actor, false);
      s.output = 'off';
    }
  }

  // Registrierungen entfernter/umgestellter Geräte aufräumen.
  for (const id of [..._knownConsumers]) {
    if (!seen.has(id)) {
      levelHandler.unregister(id);
      _knownConsumers.delete(id);
    }
  }
}

// Manuelles Schalten über den Kachel-Toggle. Ausschalten ist immer zulässig;
// Einschalten nur, wenn die effektive Priorität vom Betriebslevel freigegeben ist.
async function commandManual(db, actorId, on) {
  const actor = (await listActors(db)).find((a) => a.id === Number(actorId));
  if (!actor || !actor.switchTopic || actor.alwaysOn) return false;
  if (on) {
    const groups = await listGroups(db);
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    if (!levelHandler.isAllowed(effectivePriority(actor, groupsById))) {
      sendSwitch(actor, false);
      actorState(actor.id).output = 'off';
      return false;
    }
  }
  sendSwitch(actor, on);
  actorState(actor.id).output = on ? 'on' : 'off';
  return true;
}

// Sofort-Abschaltung auf Anforderung des Betriebslevel-Handlers (Level gesunken).
function forceOff(actor) {
  if (!actor.switchTopic) return;
  const s = actorState(actor.id);
  sendSwitch(actor, false);
  s.output = 'off';
}

let _timer = null;
let _tickChain = Promise.resolve();
let _unsubscribe = null;
let _debounce = null;

function runNow(db) {
  const run = _tickChain.then(() => tick(db));
  _tickChain = run.catch(() => {});
  return run;
}

// Entprellter Tick nach relevanten MQTT-Änderungen (Schalt-/Status-Topics), damit
// das Gate auf externes Ein-/Ausschalten prompt reagiert – nicht erst beim 30-s-Tick.
function scheduleRun(db) {
  if (_debounce) return;
  _debounce = setTimeout(() => {
    _debounce = null;
    runNow(db).catch(() => {});
  }, 1000);
}

function isRelevantEvent(event) {
  const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
  return keys.some((key) => String(key).startsWith('messschalt:'));
}

function init(db) {
  if (_timer) return;
  _timer = setInterval(() => runNow(db).catch(() => {}), 30000);
  if (!_unsubscribe) {
    _unsubscribe = mqttClient.onValuesChanged((event) => {
      if (isRelevantEvent(event)) scheduleRun(db);
    });
  }
  runNow(db).catch(() => {});
}

module.exports = { init, runNow, tick, commandManual, consumerId, isRelevantEvent };
