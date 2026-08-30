'use strict';

// Ausführung der Heimkino-Aktionsfolgen.
//
// Jeder Raum hat einen beschreibbaren Kinomodus (heimkino://raeume/<id>).
// Ändert er sich, läuft die zugehörige Folge („an" bzw. „aus") einmal
// nacheinander ab: Werte zuweisen, Pausen abwarten, Schleifen mehrfach
// durchlaufen. Eine neue Änderung bricht eine noch laufende Folge desselben
// Raums ab – der zuletzt gewünschte Zustand gewinnt.
//
// Schleifen mit aktivierter Prüfung sind zusätzlich eine dauerhafte
// Plausibilitätsprüfung: im eingestellten Abstand wird die Bedingung erneut
// bewertet; trifft sie nicht zu, wird ausschließlich diese Schleife noch einmal
// abgespult (nicht die übrige Folge). Der Abstand zählt ab der letzten
// Ausführung der Schleife bzw. ab dem Start von homeESS. Geprüft wird nur die
// Folge, die zum aktuellen Kinomodus des Raums gehört – sonst würden „an" und
// „aus" einander dauerhaft überschreiben.

const bus = require('../state-bus');
const mqttClient = require('../mqtt/client');
const adapterRouter = require('../adapters/router');
const { registerStatesProvider } = require('../adapters/states');
const { isEnabled } = require('../modules');
const conditionEngine = require('../conditions/engine');
const { createActionRunner } = require('../automation/action-runner');
const rooms = require('./rooms');
const actionsRepo = require('./actions');

// Ausführung der Aktionsfolgen (mit „Heizung & Klima" geteilt).
const runner = createActionRunner('heimkino');

const TICK_MS = 1000;
// Nach dem Start bekommt ein retained Sync-Wert Zeit einzutreffen, bevor
// homeESS seinerseits den lokalen Zustand auf das Sync-Topic schreibt.
const REMOTE_ADOPT_GRACE_MS = 10000;

let database = null;
let tickTimer = null;
let providerRegistered = false;
let loadedAt = Date.now();
let roomsById = new Map();
let treesByRoom = new Map();
let loops = [];
let subscriptions = new Set();
const loopBaselines = new Map(); // Schleifen-ID -> Zeitpunkt der letzten Prüfung/Ausführung
// Raum-ID -> { topic, seenOn, mirroredOn, pending }: zuletzt gesehener bzw.
// gespiegelter Sync-Zustand und das erwartete Echo eines eigenen Schreibens.
const remoteStates = new Map();
// Verbindungs-Epoche des MQTT-Clients und Beginn des aktuellen Zeitfensters, in
// dem retained Sync-Werte eintreffen dürfen, bevor homeESS selbst schreibt.
let remoteEpoch = null;
let remoteGraceFrom = Date.now();

function clearSubscriptions() {
  for (const key of subscriptions) mqttClient.unsubscribeAdHoc(key);
  subscriptions = new Set();
}

function phaseLabel(phase) {
  return phase === 'on' ? 'An' : 'Aus';
}

// Eine Folge komplett abarbeiten. Eine erneute Zustandsänderung desselben Raums
// bricht sie ab (Cancelled) und startet die andere Folge.
async function runPhase(roomId, phase) {
  const tree = treesByRoom.get(roomId) || { on: [], off: [] };
  const list = tree[phase] || [];
  try {
    const result = await runner.run(roomId, list);
    if (result.status === 'cancelled') return;
    if (database) {
      await rooms.markRun(database, roomId, `${phaseLabel(phase)}-Folge ausgeführt: ${list.length} Aktion${list.length === 1 ? '' : 'en'}`, '')
        .catch(() => {});
    }
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 1000);
    if (database) await rooms.markRun(database, roomId, `${phaseLabel(phase)}-Folge: Fehler`, message).catch(() => {});
  }
}

// Kinomodus eines Raums setzen. Nur eine echte Änderung wirkt; ein erneutes
// Schreiben desselben Wertes bleibt folgenlos. `runActions = false` übernimmt
// einen bereits bestehenden Zustand (retained Sync-Wert nach dem Start), ohne
// die Aktionsfolge zu durchlaufen.
async function applyRoomState(db, roomId, on, runActions) {
  const database_ = db || database;
  if (!database_) return false;
  const room = await rooms.getRoom(database_, roomId);
  if (!room) return false;
  const next = !!on;
  publishRoomState(room.id, next);
  if (room.cinemaOn === next) return true;
  await rooms.setCinemaOn(database_, room.id, next);
  const known = roomsById.get(room.id);
  if (known) known.cinemaOn = next;
  else roomsById.set(room.id, { ...room, cinemaOn: next, remoteTopic: room.remoteTopic });
  mirrorRemote(roomsById.get(room.id) || { ...room, cinemaOn: next });
  if (!runActions) return true;
  if (!treesByRoom.has(room.id)) await reload();
  runPhase(room.id, next ? 'on' : 'off').catch(() => {});
  return true;
}

function setRoomState(db, roomId, on) {
  return applyRoomState(db, roomId, on, true);
}

function publishRoomState(roomId, on) {
  adapterRouter.ingestFromInstance(rooms.INSTANCE, String(roomId), on ? 1 : 0);
}

// Der MQTT-Broker prüft den Datentyp eines States: ein Boolean-State darf nicht als
// numerische 1/0 beschrieben werden. Die zuletzt empfangene Darstellung des
// Sync-Topics bestimmt deshalb das Format (wie bei den Schaltgruppen).
function remotePayload(on, remote) {
  const value = remote && remote.value;
  if (typeof value === 'boolean' || /^(true|false|on|off|yes|no|ein|aus)$/i.test(String(value))) {
    return on ? 'true' : 'false';
  }
  return on ? '1' : '0';
}

function readRemote(roomId) {
  const entry = bus.getCache().get(rooms.remoteCacheKey(roomId));
  if (!entry || entry.value == null || entry.value === '') return null;
  return { on: conditionEngine.compare(entry.value, 'truthy'), value: entry.value };
}

// Lokalen Zustand auf das Sync-Topic zurückschreiben. Das eigene Echo wird als
// `pending` gemerkt, damit es nicht als externe Schaltflanke gilt.
function mirrorRemote(room) {
  if (!room) return;
  const state = remoteStates.get(room.id);
  if (!state || !state.topic) return;
  if (room.cinemaOn === state.mirroredOn) return;
  if (mqttClient.publish(state.topic, remotePayload(room.cinemaOn, readRemote(room.id)))) {
    state.mirroredOn = room.cinemaOn;
    state.pending = room.cinemaOn;
  }
}

// Sync-Topics abgleichen: erster (retained) Wert = bestehender Zustand, jede
// spätere externe Änderung = Schaltwunsch, lokaler Wechsel = Rückschreiben.
async function syncRemotes(now = Date.now()) {
  if (!database || !isEnabled('heimkino')) return;
  // Nach jedem (Wieder-)Verbindungsaufbau zählt der erneut eingespielte
  // retained-Wert wieder als Ausgangsbasis, nicht als Schaltflanke.
  const epoch = mqttClient.getConnectEpoch();
  if (remoteEpoch !== epoch) {
    remoteEpoch = epoch;
    remoteGraceFrom = now;
    for (const state of remoteStates.values()) {
      state.seenOn = null;
      state.mirroredOn = null;
      state.pending = null;
    }
  }
  for (const room of roomsById.values()) {
    const state = remoteStates.get(room.id);
    if (!state || !state.topic) continue;
    const remote = readRemote(room.id);
    if (remote) {
      if (state.seenOn == null) {
        // Maßgeblich nach dem Start: Zustand übernehmen, ohne zu schalten.
        state.seenOn = remote.on;
        state.mirroredOn = remote.on;
        state.pending = null;
        if (room.cinemaOn !== remote.on) await applyRoomState(database, room.id, remote.on, false);
        continue;
      }
      if (remote.on !== state.seenOn) {
        state.seenOn = remote.on;
        state.mirroredOn = remote.on;
        const echo = state.pending === remote.on;
        state.pending = null;
        // Nur eine fremde Änderung ist ein Schaltwunsch, nicht das eigene Echo.
        if (!echo) await applyRoomState(database, room.id, remote.on, true);
        continue;
      }
    }
    // Noch kein Sync-Wert bekannt: dem retained Wert kurz Zeit lassen, bevor
    // homeESS das Topic mit dem lokalen Zustand initialisiert.
    if (state.seenOn == null && now - remoteGraceFrom < REMOTE_ADOPT_GRACE_MS) continue;
    mirrorRemote(room);
  }
}

// Nur diese eine Schleife erneut abspulen – die übrige Aktionsfolge bleibt
// unberührt.
async function rerunLoop(loop) {
  try {
    const result = await runner.runLoopOnce(loop);
    if (result.status !== 'done') return;
    if (database) {
      await rooms.markRun(database, loop.roomId,
        `${phaseLabel(loop.phase)}-Folge: Schleife nach Prüfung wiederholt`, '').catch(() => {});
    }
  } catch (error) {
    if (database) {
      await rooms.markRun(database, loop.roomId, `${phaseLabel(loop.phase)}-Folge: Fehler`,
        String((error && error.message) || error).slice(0, 1000)).catch(() => {});
    }
  } finally {
    loopBaselines.set(loop.id, Date.now());
  }
}

async function checkLoops(now = Date.now()) {
  if (!database || !isEnabled('heimkino')) return;
  for (const loop of loops) {
    const config = loop.config || {};
    if (!config.checkEnabled || !config.check) continue;
    const room = roomsById.get(loop.roomId);
    if (!room) continue;
    // Geprüft wird nur die Folge, die zum aktuellen Kinomodus gehört.
    if ((room.cinemaOn ? 'on' : 'off') !== loop.phase) continue;
    const intervalMs = Number(config.checkIntervalSeconds || 0) * 1000;
    if (!(intervalMs > 0)) continue;
    const baseline = loopBaselines.get(loop.id);
    if (baseline == null) {
      loopBaselines.set(loop.id, loadedAt);
      continue;
    }
    if (now - baseline < intervalMs) continue;
    loopBaselines.set(loop.id, now);
    // Läuft gerade eine vollständige Folge des Raums, hat sie Vorrang.
    if (runner.isBusy(loop.roomId) || runner.isLoopBusy(loop.id)) continue;
    if (runner.checkFulfilled(loop)) continue;
    rerunLoop(loop).catch(() => {});
  }
}

// Ein Takt: erst die Sync-Topics abgleichen, dann die Schleifen prüfen.
async function tick(now = Date.now()) {
  await syncRemotes(now);
  await checkLoops(now);
}

async function reload() {
  if (!database) return;
  clearSubscriptions();
  roomsById = new Map();
  treesByRoom = new Map();
  loops = [];
  loadedAt = Date.now();
  if (!isEnabled('heimkino')) {
    loopBaselines.clear();
    return;
  }
  remoteGraceFrom = loadedAt;
  const list = await rooms.listRooms(database);
  for (const room of list) {
    roomsById.set(room.id, room);
    publishRoomState(room.id, room.cinemaOn);
    // Sync-Topic abonnieren. Der gemerkte Sync-Zustand bleibt über ein Neuladen
    // erhalten, solange dasselbe Topic konfiguriert ist – ein Wechsel (oder der
    // Start) beginnt bewusst wieder mit „Wert übernehmen, nicht schalten".
    if (room.remoteTopic) {
      const remoteKey = rooms.remoteCacheKey(room.id);
      mqttClient.subscribeAdHoc(room.remoteTopic, remoteKey);
      subscriptions.add(remoteKey);
      const state = remoteStates.get(room.id);
      if (!state || state.topic !== room.remoteTopic) {
        remoteStates.set(room.id, { topic: room.remoteTopic, seenOn: null, mirroredOn: null, pending: null });
      }
    } else {
      remoteStates.delete(room.id);
    }
    const trees = await actionsRepo.actionTree(database, room.id);
    treesByRoom.set(room.id, trees);
    for (const action of actionsRepo.collectActions(trees)) {
      for (const [slot, topic] of runner.referencedSlots(action)) {
        const key = runner.cacheKey(action.id, slot);
        mqttClient.subscribeAdHoc(topic, key);
        subscriptions.add(key);
      }
    }
    for (const loop of actionsRepo.collectLoops(trees)) loops.push(loop);
  }
  for (const id of [...remoteStates.keys()]) if (!roomsById.has(id)) remoteStates.delete(id);
  // Der Prüfabstand startet bei einem neu geladenen Loop mit dem Ladezeitpunkt.
  const currentLoopIds = new Set(loops.map((loop) => loop.id));
  for (const id of [...loopBaselines.keys()]) if (!currentLoopIds.has(id)) loopBaselines.delete(id);
  for (const loop of loops) if (!loopBaselines.has(loop.id)) loopBaselines.set(loop.id, loadedAt);
}

// Schreibzugriff auf heimkino://raeume/<id>: 1/true schaltet den Kinomodus ein,
// 0/false aus.
function handleStateWrite(address, value) {
  const roomId = Number(address);
  if (!Number.isFinite(roomId) || !database) return;
  const on = conditionEngine.compare(value, 'truthy');
  setRoomState(database, roomId, on).catch(() => {});
}

async function init(db) {
  database = db;
  adapterRouter.registerVirtualInstance(rooms.INSTANCE, rooms.SCHEME, {
    write: handleStateWrite,
    read: (address) => {
      const room = roomsById.get(Number(address));
      if (room) publishRoomState(room.id, room.cinemaOn);
    },
  });
  if (!providerRegistered) {
    registerStatesProvider((providerDb, cache) =>
      (isEnabled('heimkino') ? rooms.buildHeimkinoStatesBlock(providerDb, cache) : null));
    providerRegistered = true;
  }
  await reload();
  if (!tickTimer) {
    tickTimer = setInterval(() => tick().catch(() => {}), TICK_MS);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
  }
}

function stop() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  clearSubscriptions();
  roomsById = new Map();
  treesByRoom = new Map();
  loops = [];
  loopBaselines.clear();
  runner.reset();
  remoteStates.clear();
  remoteEpoch = null;
  database = null;
}

module.exports = {
  init, reload, stop, tick, setRoomState, syncRemotes, checkLoops, runPhase,
  checkFulfilled: (loop) => runner.checkFulfilled(loop),
  writeValue: (action) => runner.writeValue(action),
};
