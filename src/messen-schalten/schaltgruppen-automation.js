'use strict';

// Zustandslogik der Schaltgruppen (Vorbild: messen-schalten/automation.js).
// Eine Gruppe gilt als AN, sobald ein zugeordnetes Gerät an ist, und erst als
// AUS, wenn alle Geräte aus sind. „Gruppe schaltet als Einheit" zieht beim
// Einschalten eines Geräts die übrigen automatisch mit. Der Gruppenzustand wird
// als virtueller State (schaltgruppe://gruppen/<id>) im State-Bus veröffentlicht
// und ist dort auch beschreibbar (Einschalten = alle Geräte ein, Ausschalten =
// alle aus). Ein optionales Remote-Topic wird bidirektional synchron gehalten:
// eine externe Wertänderung dort gilt als Schaltwunsch für die ganze Gruppe;
// ein neuerer lokaler Ist-Zustand wird zurückgespiegelt. Einschalten bleibt je
// Gerät durch die effektive Priorität gegatet (commandManual).

const mqttClient = require('../mqtt/client');
const adapterRouter = require('../adapters/router');
const { registerStatesProvider } = require('../adapters/states');
const automation = require('./automation');
const { listActors, cacheKey } = require('./actors');
const { parseBool } = require('./aggregation');
const {
  SCHEME, INSTANCE, listSwitchGroups, remoteCacheKey, buildSchaltgruppenStatesBlock,
} = require('./schaltgruppen');

// In-Memory-Zustand je Gruppe. Es werden nur die zuletzt gesehenen Zustände und
// ein mögliches eigenes Remote-Echo gemerkt – keine Zeitstempel-Arbitrierung.
const state = new Map();
// Adapter- und MQTT-Events sind bereits entprellt/gebündelt. Hier genügt ein
// kurzes Fenster, um einen Burst gemeinsam auszuwerten, ohne sichtbare
// Verzögerung bei direkt am Gerät ausgelösten Zustandsänderungen.
const EVENT_DEBOUNCE_MS = 50;
// Kanonische Adapter-Topics der aktuell zugeordneten Gruppenmitglieder. Manche
// Adapter-Batches melden neben dem konfigurierten Cache-Key nur diesen Schlüssel;
// auch dann muss die Gruppenautomation sofort laufen.
const relevantMemberTopics = new Set();
function groupState(id) {
  let s = state.get(id);
  if (!s) {
    s = {
      remoteSeenOn: null,
      pendingRemote: null,
      remoteMirroredOn: null,
      groupSeenOn: null,
      timerMinutes: 0,
      timerDueAt: null,
      timerHandle: null,
      memberSeenOn: new Map(), // actorId -> zuletzt gesehener Ist-Zustand
    };
    state.set(id, s);
  }
  return s;
}

function clearGroupTimer(s) {
  if (s.timerHandle) clearTimeout(s.timerHandle);
  s.timerHandle = null;
  s.timerDueAt = null;
}

function armGroupTimer(db, group, s) {
  clearGroupTimer(s);
  s.timerMinutes = group.timerMinutes;
  if (!(group.timerMinutes > 0)) return;
  const delay = group.timerMinutes * 60 * 1000;
  s.timerDueAt = Date.now() + delay;
  s.timerHandle = setTimeout(() => {
    s.timerHandle = null;
    s.timerDueAt = null;
    pendingCommands.set(group.id, false);
    runNow(db).catch(() => {});
  }, delay);
  if (typeof s.timerHandle.unref === 'function') s.timerHandle.unref();
}

function readCachedBool(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.value == null || entry.value === '') return null;
  return { on: parseBool(entry.value), value: entry.value, receivedAt: Number(entry.receivedAt) || 0 };
}

// ioBroker prüft den Datentyp eines States. Ein Boolean-State darf deshalb
// nicht als numerische 1/0 beschrieben werden. Die vom Broker empfangene
// Darstellung bestimmt das passende Rückgabeformat.
function remotePayload(on, remote) {
  const value = remote && remote.value;
  if (typeof value === 'boolean' || /^(true|false|on|off|yes|no|ein|aus)$/i.test(String(value))) {
    return on ? 'true' : 'false';
  }
  return on ? '1' : '0';
}

// Ist-Zustand eines Geräts: bevorzugt Status-Topic, sonst Schalt-Topic-Readback.
function readMemberActual(cache, actor) {
  if (actor.statusTopic) {
    const status = readCachedBool(cache, cacheKey(actor.id, 'status'));
    if (status) return status;
  }
  return actor.switchTopic ? readCachedBool(cache, cacheKey(actor.id, 'switch')) : null;
}

// Alle schaltbaren Mitglieder gemeinsam schalten. „Immer an"-Geräte werden vom
// Betriebslevel geführt und hier ausgelassen; Einschalten bleibt je Gerät durch
// die effektive Priorität gegatet (commandManual weist es sonst ab).
async function switchMembers(db, members, on) {
  for (const member of members || []) {
    if (!member.switchTopic || member.alwaysOn) continue;
    await automation.commandManual(db, member.id, on).catch(() => {});
  }
}

async function tick(db) {
  const cache = mqttClient.getCache();
  const groups = await listSwitchGroups(db);
  const actors = await listActors(db);
  const membersByGroup = new Map();
  relevantMemberTopics.clear();
  for (const actor of actors) {
    if (actor.switchGroupId == null) continue;
    for (const topic of [actor.switchTopic, actor.statusTopic]) {
      const canonical = topic && adapterRouter.canonicalTopic(topic);
      if (canonical) relevantMemberTopics.add(canonical);
    }
    if (!membersByGroup.has(actor.switchGroupId)) membersByGroup.set(actor.switchGroupId, []);
    membersByGroup.get(actor.switchGroupId).push(actor);
  }

  const seen = new Set();
  for (const group of groups) {
    seen.add(group.id);
    const s = groupState(group.id);
    const members = membersByGroup.get(group.id) || [];

    // 1) Schaltwunsch über den virtuellen State (schaltgruppe://gruppen/<id>).
    if (pendingCommands.has(group.id)) {
      const on = pendingCommands.get(group.id);
      pendingCommands.delete(group.id);
      await switchMembers(db, members, on);
    }

    // 2) Remote-Topic geändert: genau wie beim Remote-Topic eines Geräts die
    // ganze Gruppe schalten. Nur das Echo eines eigenen Publishes wird ignoriert.
    const remote = group.remoteTopic ? readCachedBool(cache, remoteCacheKey(group.id)) : null;
    // Der erste/retained Wert ist nur die Ausgangsbasis. Ein MQTT-Refresh darf
    // niemals als Schaltflanke gelten und eine laufende Gruppe ausschalten.
    const remoteInitialized = !!remote && s.remoteSeenOn == null;
    const remoteChanged = !!remote && !remoteInitialized && remote.on !== s.remoteSeenOn;
    if (remoteInitialized) {
      s.remoteSeenOn = remote.on;
      s.remoteMirroredOn = remote.on;
      if (s.pendingRemote === remote.on) s.pendingRemote = null;
    }
    if (remoteChanged) {
      s.remoteSeenOn = remote.on;
      s.remoteMirroredOn = remote.on;
      if (s.pendingRemote === remote.on) {
        s.pendingRemote = null;
      } else {
        s.pendingRemote = null;
        await switchMembers(db, members, remote.on);
      }
    }

    // 3) Ist-Zustände einlesen; bei „Gruppe schaltet als Einheit" zieht jede
    // Schaltflanke eines Geräts die übrigen in denselben Zustand mit.
    let anyOn = false;
    const memberOnById = new Map();
    const changedMembers = [];
    for (const member of members) {
      const actual = readMemberActual(cache, member);
      const on = actual ? actual.on : null;
      memberOnById.set(member.id, on);
      if (on === true) anyOn = true;
      if (on != null) {
        const prev = s.memberSeenOn.get(member.id);
        if (prev !== undefined && prev !== on) changedMembers.push({ member, on });
        s.memberSeenOn.set(member.id, on);
      }
    }
    for (const id of [...s.memberSeenOn.keys()]) {
      if (!memberOnById.has(id)) s.memberSeenOn.delete(id);
    }
    if (group.switchAsUnit && changedMembers.length) {
      const change = changedMembers[changedMembers.length - 1];
      await switchMembers(db, members.filter((m) => m.id !== change.member.id), change.on);
    }

    // 4) Gruppenzustand veröffentlichen: in den State-Bus (kanonisches Topic samt
    // registrierter Abonnenten) …
    const groupOn = anyOn;
    const turnedOn = groupOn && s.groupSeenOn !== true;
    const timerChanged = s.timerMinutes !== group.timerMinutes;
    if (!groupOn) {
      clearGroupTimer(s);
      s.timerMinutes = group.timerMinutes;
    } else if (turnedOn || timerChanged) {
      armGroupTimer(db, group, s);
    }
    s.groupSeenOn = groupOn;
    adapterRouter.ingestFromInstance(INSTANCE, String(group.id), groupOn ? 1 : 0);

    // 5) Abgeleiteter Gruppenzustand geändert: Remote-Topic sofort mitziehen.
    // Im Tick einer externen Remote-Änderung wird der noch alte Geräte-Iststand
    // nicht zurückgeschrieben; die Bestätigung der Geräte folgt als eigenes Event.
    if (group.remoteTopic && !remoteChanged && groupOn !== s.remoteMirroredOn) {
      if (mqttClient.publish(group.remoteTopic, remotePayload(groupOn, remote))) {
        // Erst das Broker-Echo setzt remoteMirroredOn. Bis dahin bleibt die
        // Abweichung sichtbar und der nächste Tick versucht erneut zu spiegeln.
        s.pendingRemote = groupOn;
      }
    }
  }

  // Runtime gelöschter Gruppen aufräumen.
  for (const id of [...state.keys()]) {
    if (!seen.has(id)) {
      clearGroupTimer(state.get(id));
      state.delete(id);
    }
  }
}

// Gruppe gezielt schalten (UI-Toggle, State-Write): alle Geräte ein bzw. aus.
async function commandGroup(db, groupId, on) {
  const groups = await listSwitchGroups(db);
  const group = groups.find((g) => g.id === Number(groupId));
  if (!group) return false;
  const actors = await listActors(db);
  await switchMembers(db, actors.filter((a) => a.switchGroupId === group.id), !!on);
  return true;
}

let _db = null;
let _timer = null;
let _tickChain = Promise.resolve();
let _unsubscribe = null;
let _debounce = null;
const pendingCommands = new Map(); // groupId -> gewünschter Zustand (bool)

function runNow(db) {
  const run = _tickChain.then(() => tick(db));
  _tickChain = run.catch(() => {});
  return run;
}

function scheduleRun(db) {
  if (_debounce) return;
  _debounce = setTimeout(() => {
    _debounce = null;
    runNow(db).catch(() => {});
  }, EVENT_DEBOUNCE_MS);
}

function isRelevantEvent(event) {
  const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
  return keys.some((key) => {
    const text = String(key);
    return text.startsWith('messschalt:') || text.startsWith('schaltgruppe:')
      || relevantMemberTopics.has(text);
  });
}

// Write auf den virtuellen State: 1/true schaltet alle Geräte der Gruppe ein,
// 0/false alle aus. Läuft serialisiert über die Tick-Kette.
function handleStateWrite(address, value) {
  const groupId = Number(address);
  if (!Number.isFinite(groupId) || !_db) return;
  pendingCommands.set(groupId, parseBool(value));
  const db = _db;
  _tickChain = _tickChain.then(() => tick(db)).catch(() => {});
}

function init(db) {
  if (_timer) return;
  _db = db;
  adapterRouter.registerVirtualInstance(INSTANCE, SCHEME, {
    write: handleStateWrite,
    read: () => scheduleRun(db),
  });
  registerStatesProvider((providerDb, cache) => buildSchaltgruppenStatesBlock(providerDb, cache));
  _timer = setInterval(() => runNow(db).catch(() => {}), 30000);
  if (!_unsubscribe) {
    _unsubscribe = mqttClient.onValuesChanged((event) => {
      if (isRelevantEvent(event)) scheduleRun(db);
    });
  }
  runNow(db).catch(() => {});
}

function resetForTests() {
  for (const s of state.values()) clearGroupTimer(s);
  state.clear();
  relevantMemberTopics.clear();
  pendingCommands.clear();
}

module.exports = { init, runNow, tick, commandGroup, isRelevantEvent, resetForTests };
