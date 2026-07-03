'use strict';

// Steuerschleife der Messen-+-Schalten-Geräte (Vorbild: wallbox/automation.js).
// Alle Geräte mit Schalt-Topic nehmen am Betriebslevel teil. Unterhalb ihrer
// (effektiven) Priorität werden sie ausgeschaltet und dürfen auch manuell nicht
// eingeschaltet werden. „Immer an" bestimmt ausschließlich das Verhalten nach der
// erneuten Freigabe: automatische Wiedereinschaltung oder Warten auf den Benutzer.

const mqttClient = require('../mqtt/client');
const levelHandler = require('../operating-level/handler');
const { isEnabled } = require('../modules');
const gridControlAutomation = require('../grid-control/automation');
const { loadGridControlConfig } = require('../grid-control/config');
const loadShed = require('../grid-control/load-shed');
const {
  EIGENVERBRAUCH_L1_STATE_ID,
  EIGENVERBRAUCH_L2_STATE_ID,
  EIGENVERBRAUCH_L3_STATE_ID,
} = require('../stromverbrauch/config');
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
    s = {
      output: null,
      loadShedOff: false,
      remoteSeenOn: null,
      pendingSwitch: null,
      pendingRemote: null,
    };
    state.set(id, s);
  }
  return s;
}

function load(loader, db) {
  return new Promise((resolve) => loader(db, resolve));
}

function isActorShedByStage(actor, priority) {
  return actor.loadShedEnabled && loadShed.shouldShed(actor.loadShedPhase, priority);
}

function sendSwitch(actor, on) {
  if (!actor.switchTopic) return;
  const s = actorState(actor.id);
  const command = on ? 'on' : 'off';
  // Solange der Ist-Zustand einen bereits gesendeten Befehl nicht bestätigt
  // hat, denselben Funk-/MQTT-Befehl nicht bei jedem 30-s-Tick wiederholen.
  if (s.pendingSwitch === command) return false;
  mqttClient.publish(actor.switchTopic, on ? '1' : '0');
  s.pendingSwitch = command;
  if (actor.remoteTopic && s.pendingRemote !== command) {
    mqttClient.publish(actor.remoteTopic, on ? '1' : '0');
    s.pendingRemote = command;
  }
  return true;
}

function sendRemote(actor, on) {
  if (!actor.remoteTopic) return false;
  const s = actorState(actor.id);
  const command = on ? 'on' : 'off';
  if (s.pendingRemote === command) return false;
  mqttClient.publish(actor.remoteTopic, on ? '1' : '0');
  s.pendingRemote = command;
  return true;
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

function readCachedBool(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.value == null || entry.value === '') return null;
  return { on: parseBool(entry.value), receivedAt: Number(entry.receivedAt) || 0 };
}

function readActual(cache, actor) {
  const status = actor.statusTopic ? readCachedBool(cache, cacheKey(actor.id, 'status')) : null;
  if (status) return status;
  return actor.switchTopic ? readCachedBool(cache, cacheKey(actor.id, 'switch')) : null;
}

let _knownConsumers = new Set();

async function tick(db) {
  const now = Date.now();
  const cache = mqttClient.getCache();
  const actors = await listActors(db);
  const groups = await listGroups(db);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const gridControlEnabled = isEnabled('grid-control');
  const gridCfg = gridControlEnabled ? await load(loadGridControlConfig, db) : null;
  const gridState = gridControlEnabled ? gridControlAutomation.getState() : null;
  const loadShedActive = !!(gridControlEnabled && gridCfg && gridCfg.loadEnabled && gridState);
  const seen = new Set();

  loadShed.registerProvider('messschalt', actors
    .filter((actor) => {
      if (!actor.switchTopic || !actor.loadShedEnabled) return false;
      const actualOn = readActualOn(cache, actor);
      const s = actorState(actor.id);
      return actualOn === true || s.output === 'on' || s.loadShedOff === true;
    })
    .map((actor) => ({
      id: consumerId(actor),
      phase: actor.loadShedPhase,
      priority: effectivePriority(actor, groupsById),
    })));

  if (loadShedActive) {
    loadShed.update(gridState.inverterLoads, gridCfg, now);
  } else {
    loadShed.unregisterProvider('messschalt');
  }

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
    const shedByStage = loadShedActive ? isActorShedByStage(actor, priority) : false;
    const actual = readActual(cache, actor);
    const remote = actor.remoteTopic ? readCachedBool(cache, cacheKey(actor.id, 'remote')) : null;
    const remoteChanged = remote && remote.on !== s.remoteSeenOn;
    if (remoteChanged) s.remoteSeenOn = remote.on;
    // Erst eine bestätigte Zustandsmeldung gibt denselben Befehl wieder frei.
    // Weicht das Gerät später erneut ab, kann die Regel genau einmal reagieren.
    if (actual && s.pendingSwitch === (actual.on ? 'on' : 'off')) s.pendingSwitch = null;
    if (remote && s.pendingRemote === (remote.on ? 'on' : 'off')) s.pendingRemote = null;

    if (!loadShedActive || !actor.loadShedEnabled) {
      s.loadShedOff = false;
    }

    if (remoteChanged) {
      if (remote.on && (!allowed || shedByStage)) {
        sendSwitch(actor, false);
        s.output = 'off';
        s.loadShedOff = !!shedByStage;
      } else {
        sendSwitch(actor, remote.on);
        s.output = remote.on ? 'on' : 'off';
      }
    }

    if (allowed && shedByStage) {
      if (actualOn === true || (actualOn == null && s.output !== 'off')) sendSwitch(actor, false);
      s.output = 'off';
      s.loadShedOff = true;
    } else if (allowed) {
      const resumingAfterLoadShed = s.loadShedOff === true;
      if (resumingAfterLoadShed) s.loadShedOff = false;
      // Nur „Immer an" schaltet nach der Freigabe automatisch wieder ein. Manuelle
      // Geräte behalten ihren Zustand und warten gegebenenfalls auf den Benutzer.
      if (actor.alwaysOn && !actor.remoteTopic) {
        // Nach einem Lastabwurf wird der EIN-Befehl bewusst erneut gesendet,
        // auch wenn ein Status-Topic noch veraltet "an" meldet.
        if (resumingAfterLoadShed || actualOn !== true) sendSwitch(actor, true);
        s.output = 'on';
      }
    } else {
      // Priorität nicht erreicht ⇒ AUSschalten (auch extern/am Gerät eingeschaltet).
      if (actualOn === true || (actualOn == null && s.output !== 'off')) sendSwitch(actor, false);
      s.output = 'off';
      s.loadShedOff = false;
    }

    // Eine lokale/physische Zustandsänderung nach der letzten Remote-Nachricht
    // wird zurückgespiegelt. Damit gewinnt bei Abweichungen stets die neuere Seite.
    if (actor.remoteTopic && actual && !remote && allowed && !shedByStage) {
      sendRemote(actor, actual.on);
    } else if (actor.remoteTopic && actual && remote && !remoteChanged && allowed && !shedByStage
      && actual.on !== remote.on
      && actual.receivedAt > remote.receivedAt) {
      sendRemote(actor, actual.on);
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
  return keys.some((key) => {
    const text = String(key);
    return text.startsWith('messschalt:')
      || text === EIGENVERBRAUCH_L1_STATE_ID
      || text === EIGENVERBRAUCH_L2_STATE_ID
      || text === EIGENVERBRAUCH_L3_STATE_ID;
  });
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

function resetForTests() {
  state.clear();
  _knownConsumers = new Set();
  loadShed.resetForTests();
}

function getActorAutomationState(actorId) {
  const s = state.get(Number(actorId));
  return s ? { output: s.output, loadShedOff: !!s.loadShedOff } : { output: null, loadShedOff: false };
}

module.exports = {
  init, runNow, tick, commandManual, consumerId, isRelevantEvent, resetForTests, getActorAutomationState,
};
