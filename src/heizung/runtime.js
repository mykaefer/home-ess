'use strict';

// Regelung des Moduls „Heizung & Klima".
//
// Je Raum wird im Takt ausgewertet:
//   1. Ist-Temperatur  — Durchschnitt aller zugeordneten Temperaturquellen.
//   2. Kontakte        — ein offenes Fenster/eine offene Tür sperrt Heizen und
//                        Kühlen, wahlweise sofort oder nach der eingestellten
//                        Verzögerung (damit kurzes Lüften nichts abschaltet).
//   3. Soll-Temperatur — optional bidirektional mit einem Thermostat gekoppelt.
//   4. Geschaltet wird über **Aktionsfolgen** je Raum (heizung/actions.js), wie
//      beim Heimkino: Wertzuweisungen, Pausen und Schleifen mit zyklischer
//      Plausibilitätsprüfung. Je Gerät gibt es eine Folge „ein" und eine „aus";
//      bei jedem Wechsel läuft die passende einmal ab. Ein Raum hat ein Gerät
//      genau dann, wenn seine „ein"-Folge Aktionen enthält.
//   5. Schaltentscheidung mit Offsets und Hysterese:
//        Wärmebedarf bei Ist < Soll − Heiz-Offset, erfüllt ab Schwelle + Hysterese
//        Kühlen ein  bei Ist > Soll + Kühl-Offset, aus bei Ist ≤ Schwelle − Hysterese
//        — nie jedoch unterhalb der optionalen Mindesttemperatur zum Kühlen:
//        eine Nachtabsenkung am Thermostat darf die Klimaanlage nicht wecken.
//   6. Wer den Wärmebedarf deckt, entscheidet allein die **Außentemperatur**:
//        liegt sie unter der je Raum eingestellten Grenztemperatur (und der Raum
//        darf die Zentralheizung anfordern), übernimmt die Zentralheizung
//        **anstelle** des lokalen Heizgerätes; darüber heizt das lokale Gerät.
//        Auch hier gilt die eingestellte Hysterese.
//   7. Beide lokalen Geräte hängen am **Betriebslevel** (LEVEL_HANDLING.md): sie
//        laufen nur, wenn das aktuelle Level ihre Priorität abdeckt, und werden
//        bei einem Levelabfall sofort abgeschaltet. Für das Heizgerät lässt sich
//        zusätzlich einschalten, dass in diesem Fall **direkt die
//        Zentralheizung** heizt — dann entfällt für den Raum solange die
//        Außentemperaturgrenze.
//
// Eingestellte Werte werden nie automatisch verändert: steht die Grenze etwa auf
// 4 °C Außentemperatur und die Soll-Temperatur auf 21 °C, so heizt zwischen
// diesen beiden Punkten allein ein lokales Gerät — ist keines hinterlegt, wird
// dort bewusst nicht geheizt.
//
// Die Werte sind homeESS-Systemwerte (das Modul ist kein Adapter): sie liegen
// unter `system://homeess/raeume.<Raumname>.…` bzw. `…/zentralheizung.…` und
// erscheinen auf der States-Seite in den Ordnern „Räume/<Raum>" und
// „Zentralheizung". Ein Umbenennen ändert deshalb die Topics eines Raums; die
// alten verschwinden beim nächsten Neuladen aus dem State-Bus.
//
// Die Zentralheizung läuft, sobald mindestens ein Raum Wärme anfordert. Beim
// Schaltaktor wird sie erst abgestellt, wenn die Vorlauftemperatur wieder
// sinkt (der Rücklauf wird überwacht, entscheidet aber nicht — er hinkt einen
// Kreislauf hinterher). Ist eine Umwälzpumpe hinterlegt, gilt zwingend: erst läuft die Pumpe,
// dann darf der Brenner starten — und nach dem Brenner läuft sie die
// eingestellte Nachlaufzeit weiter (siehe heizung/central.js).

const bus = require('../state-bus');
const mqttClient = require('../mqtt/client');
const systemRouter = require('../states/system-router');
const { topicForId } = require('../states/system-topics');
const { registerValueProvider } = require('../states/system-values');
const { isEnabled } = require('../modules');
const levelHandler = require('../operating-level/handler');
const conditionEngine = require('../conditions/engine');
const { createActionRunner } = require('../automation/action-runner');
const rooms = require('./rooms');
const actionsRepo = require('./actions');
const central = require('./central');

// Ausführung der Aktionsfolgen (mit dem Heimkino geteilt).
const runner = createActionRunner('heizung');

const TICK_MS = 5000;
// Nach dem Start bekommt ein retained Thermostat-Wert Zeit einzutreffen, bevor
// homeESS seinerseits die Soll-Temperatur auf das Thermostat schreibt.
const THERMOSTAT_GRACE_MS = 10000;
// So lange nach einem eigenen Schreiben gilt ein abweichender Thermostat-Wert
// als verspätetes Echo eines älteren Schreibens und nicht als Verstellung von
// Hand. Ohne das würde etwa der Nachhall des Schornsteinfeger-Modus (28 °C) als
// neue Soll-Temperatur übernommen.
const THERMOSTAT_ECHO_MS = 15000;
// Weicht der zurückgelesene Zustand des Heizkörperlüfters dauerhaft vom
// gewünschten ab, wird der Schaltbefehl in diesem Abstand wiederholt.
const REASSERT_MS = 300000;
// So viele aufeinanderfolgende Messwerte müssen in dieselbe Richtung zeigen,
// damit die Brennererkennung über den Vorlauf umschlägt. Eine einzelne
// Schwankung nach oben oder unten bleibt damit folgenlos.
const FIRING_SAMPLES = 3;
// So lange nach einem eigenen Schaltbefehl gilt ein noch abweichender Readback
// des Brenners als verzögertes Echo und nicht als Fremdschaltung.
const READBACK_GRACE_MS = 30000;

let database = null;
let tickTimer = null;
let providersRegistered = false;

let roomList = [];
let sensorsByRoom = new Map();
let contactsByRoom = new Map();
// Aktionsfolgen je Raum und alle Schleifen flach (für die zyklische Prüfung).
let treesByRoom = new Map();
let loops = [];
let loadedAt = Date.now();
const loopBaselines = new Map();
let centralConfig = null;
// Abonnierte Fremd-Topics: Cache-Schlüssel -> Topic. Beim Neuladen werden nur
// tatsächlich geänderte Abos angefasst — ein Abbestellen löscht den zuletzt
// bekannten Wert aus dem Cache, und ohne Temperatur würde die Regelung die
// Geräte kurzzeitig abschalten.
let subscriptions = new Map();

// Laufzeitzustand je Raum. Er überlebt ein Neuladen der Konfiguration, damit
// Hysterese und Kontaktverzögerung nicht bei jeder Änderung von vorn beginnen.
const roomState = new Map();
// Zuletzt veröffentlichte Systemwerte (Topic -> { value, at }). Dient allein
// dazu, die Topics umbenannter oder entfernter Räume wieder aufzuräumen.
const published = new Map();
// Zuletzt geschalteter Heizkörperlüfter (Topic -> { on, at }).
const commandedFans = new Map();

// Die Zentralheizung kennt drei getrennte Zustände:
//   Kessel  – der Schaltzustand der Anlage (das, was homeESS schaltet)
//   Brenner – ob der Brenner tatsächlich feuert
//   Pumpe   – die Umwälzpumpe mit Vor- und Nachlauf
let boiler = {
  on: false,
  offRequestedAt: null, // seit wann keine Wärme mehr angefordert wird
  note: '',
  commandOn: null,      // zuletzt selbst geschalteter Zustand …
  commandAt: null,      // … und wann
};
// Zustand der Umwälzpumpe: seit wann sie läuft und wann ihr Nachlauf endet.
let pump = { on: false, since: null, stopAt: null };
// Brennererkennung. Maßgeblich für das Laufzeitprotokoll und damit für die
// Heizkosten: der Kessel kann eingeschaltet sein, ohne zu feuern (Taktung,
// Modulation, erreichte Kesseltemperatur). `last` ist der zuletzt gesehene
// Vorlaufwert, die Zähler sammeln aufeinanderfolgende Anstiege bzw. Rückgänge.
let burner = { on: false, source: 'switch', last: null, rising: 0, falling: 0, runId: null };
let thermostatEpoch = null;
let thermostatGraceFrom = Date.now();

function toNumber(value) {
  return rooms.toNumber(value);
}

function truthy(value) {
  return conditionEngine.compare(value, 'truthy');
}

function cacheValue(key) {
  const entry = bus.getCache().get(key);
  return entry ? entry.value : undefined;
}

function clearSubscriptions() {
  for (const key of subscriptions.keys()) mqttClient.unsubscribeAdHoc(key);
  subscriptions = new Map();
}

// Abos an den gewünschten Stand angleichen: unverändert Gebliebenes bleibt
// bestehen (und behält damit seinen zuletzt empfangenen Wert).
function applySubscriptions(desired) {
  for (const [key, topic] of [...subscriptions]) {
    if (desired.get(key) === topic) continue;
    mqttClient.unsubscribeAdHoc(key);
    subscriptions.delete(key);
  }
  for (const [key, topic] of desired) {
    if (!topic || subscriptions.get(key) === topic) continue;
    mqttClient.subscribeAdHoc(topic, key);
    subscriptions.set(key, topic);
  }
}

// ioBroker prüft den Datentyp eines States: ein Boolean-State darf nicht als
// numerische 1/0 beschrieben werden. Die zuletzt gesehene Darstellung des
// Ziel-States bestimmt deshalb das Format (wie bei Heimkino/Schaltgruppen).
function switchPayload(on, lastValue) {
  if (typeof lastValue === 'boolean' || /^(true|false|on|off|yes|no|ein|aus)$/i.test(String(lastValue))) {
    return on ? 'true' : 'false';
  }
  return on ? '1' : '0';
}

// Heizkörperlüfter schalten. Ein Lüfter ist ein simpler Verbraucher, deshalb
// genügt hier ein Topic statt einer Aktionsfolge: geschrieben wird bei einer
// Änderung des Wunsches und dann, wenn der zurückgelesene Zustand dauerhaft
// abweicht.
function commandFan(room, on, now = Date.now()) {
  const topic = room.fanTopic;
  if (!topic) return;
  const cacheKey = rooms.fanCacheKey(room.id);
  const last = commandedFans.get(topic);
  const readback = cacheValue(cacheKey);
  const known = readback !== undefined && readback !== '' && readback !== null;
  const matches = known ? truthy(readback) === on : true;
  // Steht der Lüfter beim ersten Takt schon richtig, wird nicht geschaltet.
  if (!last && known && matches) {
    commandedFans.set(topic, { on, at: now });
    return;
  }
  const changed = !last || last.on !== on;
  const stale = last && now - last.at >= REASSERT_MS;
  if (!changed && (matches || !stale)) return;
  if (mqttClient.publish(topic, switchPayload(on, readback))) commandedFans.set(topic, { on, at: now });
}

// Systemwerte veröffentlichen. Der State-Bus verteilt sie an alle Cache-Keys,
// die auf das jeweilige system://homeess/...-Topic hören; unveränderte Werte
// bleiben dabei folgenlos.
function publishEntries(entries, now = Date.now()) {
  if (!entries.length) return;
  for (const entry of entries) published.set(topicForId(entry.id), { value: entry.value, at: now });
  systemRouter.publish(entries, now);
}

// Schaltentscheidung mit Hysterese: Der Einschaltpunkt ist die Schwelle, der
// Ausschaltpunkt liegt um die Hysterese darüber (Heizen) bzw. darunter
// (Kühlen). `active` ist der bisherige Zustand.
function hystereticBelow(active, value, threshold, hysteresis) {
  if (value == null) return false;
  return active ? value < threshold + hysteresis : value < threshold;
}
function hystereticAbove(active, value, threshold, hysteresis) {
  if (value == null) return false;
  return active ? value > threshold - hysteresis : value > threshold;
}

// Einschaltpunkt fürs Kühlen: Soll plus Offset, mindestens aber die
// eingestellte Mindesttemperatur. Sinkt die Soll-Temperatur (Nachtabsenkung),
// bleibt die Klimaanlage dadurch aus; liegt Soll plus Offset darüber, zählt
// dieser höhere Wert.
function coolThreshold(room, target) {
  const base = target + room.coolOffset;
  return room.coolMinTemp == null ? base : Math.max(base, room.coolMinTemp);
}

// Ein Raum hat ein Gerät, wenn die zugehörige „ein"-Folge Aktionen enthält.
function hasHeatDevice(room) {
  return actionsRepo.hasDevice(treesByRoom.get(room.id), 'heat');
}
function hasCoolDevice(room) {
  return actionsRepo.hasDevice(treesByRoom.get(room.id), 'cool');
}

// Verbraucher-ID eines Raumgerätes beim Betriebslevel-Handler.
function consumerId(roomId, device) {
  return `heizung.${roomId}.${device}`;
}

// Zwangsabschaltung bei Levelabfall: die „aus"-Folge läuft sofort, nicht erst
// im nächsten Takt (LEVEL_HANDLING.md, Schritt 5).
function forceOff(room, device) {
  const state = roomState.get(room.id);
  if (state) {
    if (device === 'heat') state.heating = false;
    else state.cooling = false;
  }
  runPhase(room, actionsRepo.phaseFor(device, false)).catch(() => {});
}

// Geräte am Betriebslevel an- bzw. abmelden. Gemeldet wird nur, was es gibt:
// ohne „ein"-Folge hat der Raum kein Gerät.
function syncLevelRegistration() {
  for (const room of roomList) {
    for (const [device, has, prio] of [
      ['heat', hasHeatDevice(room), room.heatPriority],
      ['cool', hasCoolDevice(room), room.coolPriority],
    ]) {
      const id = consumerId(room.id, device);
      if (has) levelHandler.register(id, prio, { onMustTurnOff: () => forceOff(room, device) });
      else levelHandler.unregister(id);
    }
  }
}

function clearLevelRegistration(list = roomList) {
  for (const room of list) {
    levelHandler.unregister(consumerId(room.id, 'heat'));
    levelHandler.unregister(consumerId(room.id, 'cool'));
  }
}

// Eine Folge abspulen. Heiz- und Kühlfolge laufen unabhängig voneinander; eine
// erneute Schaltung desselben Gerätes bricht die noch laufende ab.
async function runPhase(room, phase) {
  const list = (treesByRoom.get(room.id) || {})[phase] || [];
  if (!list.length) return;
  try {
    const result = await runner.run(`${room.id}:${phase.startsWith('heat') ? 'heat' : 'cool'}`, list);
    if (result.status === 'cancelled') return;
    if (database) await rooms.markError(database, room.id, '').catch(() => {});
  } catch (error) {
    const message = `${actionsRepo.phaseLabel(phase)}: ${String((error && error.message) || error)}`;
    if (database) await rooms.markError(database, room.id, message).catch(() => {});
  }
}

// Nur diese eine Schleife erneut abspulen – die übrige Folge bleibt unberührt.
async function rerunLoop(loop) {
  try {
    const result = await runner.runLoopOnce(loop);
    if (result.status !== 'done') return;
  } catch (error) {
    const message = `${actionsRepo.phaseLabel(loop.phase)}: ${String((error && error.message) || error)}`;
    if (database) await rooms.markError(database, loop.roomId, message).catch(() => {});
  } finally {
    loopBaselines.set(loop.id, Date.now());
  }
}

// Zyklische Plausibilitätsprüfung: geprüft wird nur die Folge, die zum aktuellen
// Zustand des Gerätes gehört — sonst würden „ein" und „aus" einander dauerhaft
// überschreiben.
function activePhases(roomId) {
  const state = roomState.get(roomId);
  return new Set([
    actionsRepo.phaseFor('heat', !!(state && state.heating)),
    actionsRepo.phaseFor('cool', !!(state && state.cooling)),
  ]);
}

function checkLoops(now = Date.now()) {
  for (const loop of loops) {
    const config = loop.config || {};
    if (!config.checkEnabled || !config.check) continue;
    if (!activePhases(loop.roomId).has(loop.phase)) continue;
    const intervalMs = Number(config.checkIntervalSeconds || 0) * 1000;
    if (!(intervalMs > 0)) continue;
    const baseline = loopBaselines.get(loop.id);
    if (baseline == null) {
      loopBaselines.set(loop.id, loadedAt);
      continue;
    }
    if (now - baseline < intervalMs) continue;
    loopBaselines.set(loop.id, now);
    // Läuft gerade eine vollständige Folge des Gerätes, hat sie Vorrang.
    const key = `${loop.roomId}:${loop.phase.startsWith('heat') ? 'heat' : 'cool'}`;
    if (runner.isBusy(key) || runner.isLoopBusy(loop.id)) continue;
    if (runner.checkFulfilled(loop)) continue;
    rerunLoop(loop).catch(() => {});
  }
}

function stateFor(roomId) {
  let state = roomState.get(roomId);
  if (!state) {
    state = {
      heating: false,
      cooling: false,
      // Wärme- bzw. Kühlbedarf des Raums (Hysterese-Gedächtnis). Sie sind
      // unabhängig davon, ob das Betriebslevel das Gerät gerade freigibt und ob
      // die Wärme vom lokalen Gerät oder der Zentralheizung kommt.
      heatDemand: false,
      coolDemand: false,
      // Außentemperatur unter der Grenze des Raums (eigenes Hysterese-Gedächtnis).
      outdoorCold: false,
      centralDemand: false,
      contactOpenSince: null,
      blocked: false,
      temperature: null,
      sensorCount: 0,
      thermostat: emptyThermostat(''),
      note: '',
    };
    roomState.set(roomId, state);
  }
  return state;
}

// Offener Kontakt? Ein invertierter Kontakt meldet 1 = geschlossen.
function contactsOpen(contacts) {
  let known = false;
  for (const contact of contacts || []) {
    const value = cacheValue(rooms.contactCacheKey(contact.id));
    if (value === undefined || value === null || value === '') continue;
    known = true;
    const open = contact.inverted ? !truthy(value) : truthy(value);
    if (open) return { open: true, known: true };
  }
  return { open: false, known };
}

function emptyThermostat(topic) {
  return { topic, seen: null, mirrored: null, wroteValue: null, wroteAt: null };
}

function near(left, right) {
  return left != null && right != null && Math.abs(left - right) < 0.05;
}

// Sollwert auf das Thermostat schreiben und merken, was wann geschrieben wurde.
function writeThermostat(thermostat, topic, value, now) {
  if (!mqttClient.publish(topic, value)) return;
  thermostat.mirrored = value;
  thermostat.seen = value;
  thermostat.wroteValue = value;
  thermostat.wroteAt = now;
}

// Eine fremde Verstellung am Thermostat in die Soll-Temperatur des Raums
// übernehmen.
async function adoptTarget(room, value) {
  if (near(value, room.targetTemp)) return;
  await rooms.setTargetTemp(database, room.id, value).catch(() => {});
  room.targetTemp = value;
}

// Soll-Temperatur mit einem Thermostat abgleichen: der erste (retained) Wert
// gilt als Ausgangsbasis, jede spätere externe Änderung übernimmt homeESS,
// jede lokale Änderung wird zurückgeschrieben. Im Schornsteinfeger-Modus
// bekommt das Thermostat die Sonder-Temperatur, ohne dass die eingestellte
// Soll-Temperatur verändert wird.
async function syncThermostat(room, state, sweep, now) {
  const topic = room.thermostatTopic;
  if (!topic) {
    state.thermostat = emptyThermostat('');
    return room.targetTemp;
  }
  if (state.thermostat.topic !== topic) state.thermostat = emptyThermostat(topic);
  const thermostat = state.thermostat;
  const remote = toNumber(cacheValue(rooms.thermostatCacheKey(room.id)));

  // Im Schornsteinfeger-Modus bekommt das Thermostat die Sonder-Temperatur; die
  // eingestellte Soll-Temperatur bleibt unangetastet und wird beim Beenden
  // wieder zurückgeschrieben.
  if (sweep) {
    if (thermostat.mirrored !== central.SWEEP_TARGET_TEMP) writeThermostat(thermostat, topic, central.SWEEP_TARGET_TEMP, now);
    return central.SWEEP_TARGET_TEMP;
  }

  // Ein abweichender Wert kurz nach einem eigenen Schreiben ist der Nachhall
  // des vorherigen Standes, keine Verstellung von Hand.
  const staleEcho = remote != null && thermostat.wroteAt != null
    && now - thermostat.wroteAt < THERMOSTAT_ECHO_MS
    && !near(remote, thermostat.wroteValue);

  if (remote != null && !staleEcho) {
    if (thermostat.seen == null) {
      // Maßgeblich nach dem Start: Wert übernehmen, ohne zurückzuschreiben.
      thermostat.seen = remote;
      thermostat.mirrored = remote;
      await adoptTarget(room, remote);
      return room.targetTemp;
    }
    if (!near(remote, thermostat.seen)) {
      // Fremde Änderung am Thermostat: sie gewinnt.
      thermostat.seen = remote;
      thermostat.mirrored = remote;
      await adoptTarget(room, remote);
      return room.targetTemp;
    }
  }
  if (thermostat.seen == null && now - thermostatGraceFrom < THERMOSTAT_GRACE_MS) return room.targetTemp;
  // Lokale Änderung auf das Thermostat spiegeln — auch nach dem Beenden des
  // Schornsteinfeger-Modus, der dort 28 °C hinterlassen hat.
  if (thermostat.mirrored == null || !near(thermostat.mirrored, room.targetTemp)) {
    writeThermostat(thermostat, topic, room.targetTemp, now);
  }
  return room.targetTemp;
}

// Ein Raum: messen, sperren, entscheiden, schalten, veröffentlichen.
// `outdoor` ist die Außentemperatur (null, wenn unbekannt).
async function evaluateRoom(room, outdoor, sweep, now) {
  const state = stateFor(room.id);
  const previous = { heating: state.heating, cooling: state.cooling };
  const cache = bus.getCache();
  const measured = rooms.averageTemperature(cache, sensorsByRoom.get(room.id) || []);
  state.temperature = measured.value;
  state.sensorCount = measured.count;

  const contacts = contactsByRoom.get(room.id) || [];
  const { open } = contactsOpen(contacts);
  if (open) {
    if (state.contactOpenSince == null) state.contactOpenSince = now;
  } else {
    state.contactOpenSince = null;
  }
  // Schließen wirkt sofort, Öffnen erst nach der eingestellten Verzögerung.
  state.blocked = state.contactOpenSince != null
    && now - state.contactOpenSince >= room.contactDelaySeconds * 1000;

  const target = await syncThermostat(room, state, sweep, now);
  const temperature = state.temperature;

  let heatDemand = false;
  let coolDemand = false;
  let outdoorCold = false;
  let heating = false;
  let cooling = false;
  let centralDemand = false;
  let note = '';
  // Freigabe durch das Betriebslevel (Priorität = Level, ab dem das Gerät darf).
  const heatAllowed = levelHandler.isAllowed(room.heatPriority);
  const coolAllowed = levelHandler.isAllowed(room.coolPriority);

  if (temperature == null) {
    note = (sensorsByRoom.get(room.id) || []).length
      ? 'Keine gültige Temperatur — es wird nicht geschaltet.'
      : 'Keine Temperaturquelle zugeordnet.';
  } else if (state.blocked) {
    note = 'Fenster/Tür offen — Heizen und Kühlen sind gesperrt.';
  } else if (sweep) {
    // Schornsteinfeger: die dezentralen Geräte bleiben aus, damit sie nicht
    // mitlaufen; die Wärme kommt allein aus der Zentralheizung.
    centralDemand = room.centralAllowed;
    note = 'Schornsteinfeger-Modus — lokale Geräte sind deaktiviert.';
  } else {
    // Braucht der Raum überhaupt Wärme? Das entscheidet allein seine eigene
    // Temperatur gegen die Soll-Temperatur.
    heatDemand = hystereticBelow(state.heatDemand, temperature, target - room.heatOffset, room.hysteresis);
    coolDemand = hystereticAbove(state.coolDemand, temperature, coolThreshold(room, target), room.hysteresis);
    // Heizen und Kühlen schließen sich aus.
    if (heatDemand && coolDemand) coolDemand = false;
    // Wer die Wärme liefert, entscheidet die Außentemperatur gegen die Grenze
    // des Raums.
    if (room.centralAllowed && room.centralTemp != null) {
      outdoorCold = hystereticBelow(state.outdoorCold, outdoor, room.centralTemp, room.hysteresis);
      if (heatDemand && outdoor == null && !(room.heatCentralFallback && !heatAllowed)) {
        note = 'Keine Außentemperatur — die Zentralheizung übernimmt nicht.';
      }
    }
    // Sperrt das Betriebslevel das lokale Heizgerät, darf die Zentralheizung
    // auf Wunsch direkt einspringen — dann ohne Außentemperaturgrenze.
    const centralInsteadOfBlocked = room.centralAllowed && room.heatCentralFallback && !heatAllowed;
    centralDemand = heatDemand && (outdoorCold || centralInsteadOfBlocked);
    // Die Zentralheizung tritt an die Stelle des lokalen Heizgerätes.
    if (heatDemand && !centralDemand && hasHeatDevice(room) && heatAllowed) heating = true;
    if (coolDemand && hasCoolDevice(room) && coolAllowed) cooling = true;

    if (heatDemand && !heatAllowed && hasHeatDevice(room)) {
      note = centralInsteadOfBlocked
        ? `Betriebslevel ${levelHandler.currentOperatingLevel()} sperrt das Heizgerät (Priorität ${room.heatPriority}) — die Zentralheizung übernimmt.`
        : `Betriebslevel ${levelHandler.currentOperatingLevel()} sperrt das Heizgerät (Priorität ${room.heatPriority}).`;
    } else if (coolDemand && !coolAllowed && hasCoolDevice(room)) {
      note = `Betriebslevel ${levelHandler.currentOperatingLevel()} sperrt das Kühlgerät (Priorität ${room.coolPriority}).`;
    }
  }

  state.heatDemand = heatDemand;
  state.coolDemand = coolDemand;
  state.outdoorCold = outdoorCold;
  state.heating = heating;
  state.cooling = cooling;
  state.centralDemand = centralDemand;
  state.note = note;

  // Nur ein Wechsel löst eine Folge aus; ein unveränderter Zustand bleibt
  // folgenlos (die zyklische Prüfung einer Schleife hält ihn nach).
  if (previous.heating !== heating) runPhase(room, actionsRepo.phaseFor('heat', heating)).catch(() => {});
  if (previous.cooling !== cooling) runPhase(room, actionsRepo.phaseFor('cool', cooling)).catch(() => {});
  // Der Heizkörperlüfter läuft, solange der Raum Wärme von der Zentralheizung
  // anfordert — ohne Nachlauf: ist die Raumtemperatur erreicht, schließt auch
  // das Thermostatventil, und ob der Brenner noch für einen anderen Raum läuft,
  // lässt sich hier nicht beurteilen.
  commandFan(room, centralDemand, now);

  publishEntries(rooms.roomEntries(room, {
    temperature, targetTemp: target, heating, cooling, centralDemand, contactOpen: state.blocked,
  }), now);
  return state;
}

// Darf der Kessel abgeschaltet werden? Nur wenn keine Wärme mehr angefordert
// wird **und** der Brenner als aus erkannt ist. Solange er feuert, bleibt der
// Kessel an — das ist dieselbe Regel wie „nicht abschalten, während der Vorlauf
// steigt", nur an der Brennererkennung festgemacht.
function mayStopBoiler(config, state, burnerState, now) {
  if (config.mode !== 'relais') return { ok: true, reason: '' };
  const waitMs = now - (state.offRequestedAt == null ? now : state.offRequestedAt);
  if (config.maxHoldMinutes > 0 && waitMs >= config.maxHoldMinutes * 60000) {
    return { ok: true, reason: 'Notabschaltung nach Wartezeit' };
  }
  if (!burnerState.on) return { ok: true, reason: '' };
  if (burnerState.source === 'switch') {
    // Ohne Rückmeldung und ohne Vorlauf lässt sich der Brenner nicht erkennen;
    // dann bleibt nur das eingestellte Zeitfenster.
    if (waitMs >= config.flowWindowSeconds * 1000) {
      return { ok: true, reason: 'Keine Brennererkennung — nach Wartezeit abgestellt' };
    }
    return { ok: false, reason: 'Wartet auf die Brennererkennung' };
  }
  return { ok: false, reason: 'Brenner läuft noch — Kessel bleibt an' };
}

// Ist eine Umwälzpumpe hinterlegt? Sie gehört zum Schaltaktor-Betrieb.
function pumpConfigured(config) {
  return config.mode === 'relais' && !!config.pumpTopic;
}

function setPump(config, on, now) {
  if (pump.on === on) return;
  if (!mqttClient.publish(config.pumpTopic, switchPayload(on, cacheValue(central.flowCacheKey('pump'))))) return;
  pump.on = on;
  pump.since = on ? now : null;
  if (on) pump.stopAt = null;
}

// Der Brenner darf erst starten, wenn die Pumpe wirklich läuft: der
// zurückgelesene Zustand muss stimmen (sofern bekannt) und der eingestellte
// Vorlauf abgelaufen sein.
function pumpReady(config, now) {
  if (!pumpConfigured(config)) return { ok: true, reason: '' };
  if (!pump.on) return { ok: false, reason: 'Umwälzpumpe wird gestartet' };
  const readback = cacheValue(central.flowCacheKey('pump'));
  const known = readback !== undefined && readback !== null && readback !== '';
  if (known && !truthy(readback)) return { ok: false, reason: 'Wartet auf die Umwälzpumpe' };
  const leadMs = Math.max(0, Number(config.pumpLeadSeconds) || 0) * 1000;
  if (pump.since != null && now - pump.since < leadMs) return { ok: false, reason: 'Umwälzpumpe läuft an' };
  return { ok: true, reason: '' };
}

async function setBoiler(config, on, now) {
  if (config.switchTopic) {
    mqttClient.publish(config.switchTopic, switchPayload(on, cacheValue(central.flowCacheKey('switch'))));
  }
  boiler.commandOn = on;
  boiler.commandAt = now;
  boiler.on = on;
}

// Feuert der Brenner gerade?
//
// Erste Wahl ist die Rückmeldung der Steuerung (Flammensignal/Kontakt). Fehlt
// sie, wird der Vorlauf ausgewertet — und zwar nach dem tatsächlichen Verlauf
// einer Brennphase:
//   * Mehrere Messwerte hintereinander nach oben ⇒ der Brenner ist an. Eine
//     einzelne Schwankung reicht ausdrücklich nicht.
//   * Die anschließende Halte-Phase (der Vorlauf bleibt stehen, weil der
//     Brenner die Temperatur hält) zählt weiter als Brennerlauf.
//   * Erst mehrere Messwerte hintereinander nach unten beenden die Brennphase.
// Ohne Rückmeldung und ohne Vorlauf bleibt nur der Schaltzustand des Kessels.
function detectFiring(config, flow) {
  if (config.burnerFeedbackTopic) {
    const value = cacheValue(central.flowCacheKey('feedback'));
    if (value !== undefined && value !== null && value !== '') {
      burner.source = 'feedback';
      burner.on = truthy(value);
      return burner.on;
    }
  }
  if (flow == null) {
    burner.source = 'switch';
    burner.on = boiler.on;
    return burner.on;
  }
  burner.source = 'flow';
  const delta = Math.max(0.01, Number(config.flowDropDelta) || 0.1);
  if (burner.last == null) {
    burner.last = flow;
    return burner.on;
  }
  if (flow >= burner.last + delta) {
    burner.rising += 1;
    burner.falling = 0;
  } else if (flow <= burner.last - delta) {
    burner.falling += 1;
    burner.rising = 0;
  }
  // Ein Wert innerhalb des Rauschbandes hält den Stand: er beendet weder eine
  // Anstiegsreihe noch die Halte-Phase.
  burner.last = flow;
  if (burner.rising >= FIRING_SAMPLES) {
    burner.on = true;
    burner.rising = 0;
  } else if (burner.falling >= FIRING_SAMPLES) {
    burner.on = false;
    burner.falling = 0;
  }
  return burner.on;
}

// Laufzeitprotokoll führen — es zählt allein die Zeit, in der der Brenner
// tatsächlich feuert. Ein ausgeschalteter Kessel kann nicht feuern.
async function trackFiring(config, flow, now) {
  const was = burner.on;
  const on = detectFiring(config, flow) && boiler.on;
  burner.on = on;
  if (on && !was) {
    burner.runId = await central.startBurnerRun(database, now, central.FIRING_SOURCES[burner.source] || '')
      .catch(() => null);
  } else if (!on && was) {
    await central.finishBurnerRun(database, burner.runId, now).catch(() => {});
    burner.runId = null;
  }
  if (on && burner.runId) await central.touchBurnerRun(database, burner.runId, now).catch(() => {});
}

// Zentralheizung: einschalten, sobald ein Raum Wärme anfordert; abstellen,
// sobald keine Anforderung mehr besteht (beim Schaltaktor erst nach dem
// Vorlauf-Check).
async function evaluateCentral(config, demandCount, sweep, now) {
  const flow = toNumber(cacheValue(central.flowCacheKey('flow')));
  const back = toNumber(cacheValue(central.flowCacheKey('return')));

  if (!config.enabled) {
    if (boiler.on) await setBoiler(config, false, now);
    if (pump.on && config.pumpTopic) setPump(config, false, now);
    boiler.offRequestedAt = null;
    boiler.note = '';
    await trackFiring(config, flow, now);
    return { flow, back };
  }

  const wanted = sweep || demandCount > 0;

  // Fremdschaltung erkennen: der zurückgelesene Zustand des Schaltaktors ist
  // der wahre Kesselzustand.
  const readback = cacheValue(central.flowCacheKey('switch'));
  const echoWindow = boiler.commandAt != null && now - boiler.commandAt < READBACK_GRACE_MS;
  if (readback !== undefined && readback !== null && readback !== ''
      && !(echoWindow && truthy(readback) !== boiler.commandOn)) {
    boiler.on = truthy(readback);
  }

  // Die Pumpe läuft, solange Wärme gebraucht wird oder der Kessel an ist;
  // danach beginnt ihr Nachlauf.
  if (pumpConfigured(config)) {
    if (wanted || boiler.on) {
      setPump(config, true, now);
    } else if (pump.on) {
      if (pump.stopAt == null) pump.stopAt = now + Math.max(0, Number(config.pumpLagSeconds) || 0) * 1000;
      if (now >= pump.stopAt) {
        setPump(config, false, now);
        pump.stopAt = null;
      }
    }
  }

  if (wanted) {
    boiler.offRequestedAt = null;
    boiler.note = sweep ? 'Schornsteinfeger-Modus' : '';
    if (!boiler.on) {
      // Zwingend: erst die Pumpe, dann der Kessel.
      const ready = pumpReady(config, now);
      if (ready.ok) await setBoiler(config, true, now);
      else boiler.note = ready.reason;
    }
  } else if (boiler.on) {
    if (boiler.offRequestedAt == null) boiler.offRequestedAt = now;
    const decision = mayStopBoiler(config, boiler, burner, now);
    if (decision.ok) {
      await setBoiler(config, false, now);
      boiler.offRequestedAt = null;
      // Erst jetzt beginnt der Nachlauf der Pumpe.
      if (pumpConfigured(config) && pump.on) {
        pump.stopAt = now + Math.max(0, Number(config.pumpLagSeconds) || 0) * 1000;
      }
      boiler.note = pumpConfigured(config) && pump.on ? 'Umwälzpumpe läuft nach' : '';
    } else {
      boiler.note = decision.reason;
    }
  } else {
    boiler.offRequestedAt = null;
    boiler.note = '';
  }

  await trackFiring(config, flow, now);
  return { flow, back };
}

async function tick(now = Date.now()) {
  if (!database || !isEnabled('heizung')) return;
  // Nach jedem (Wieder-)Verbindungsaufbau zählt der erneut eingespielte
  // retained Thermostat-Wert wieder als Ausgangsbasis, nicht als Verstellung.
  const epoch = mqttClient.getConnectEpoch();
  if (thermostatEpoch !== epoch) {
    thermostatEpoch = epoch;
    thermostatGraceFrom = now;
    for (const state of roomState.values()) state.thermostat = emptyThermostat(state.thermostat.topic);
  }

  const config = centralConfig || (centralConfig = await central.loadCentralConfig(database));
  const sweep = !!(config.enabled && config.sweepEnabled);

  const outdoor = central.readOutdoorTemperature(config, bus.getCache());
  let demandCount = 0;
  for (const room of roomList) {
    const state = await evaluateRoom(room, outdoor, sweep, now).catch(() => null);
    if (state && state.centralDemand) demandCount += 1;
  }

  checkLoops(now);

  const { flow, back } = await evaluateCentral(config, demandCount, sweep, now);

  if (config.enabled) {
    publishEntries(central.centralEntries(config, await centralValueSnapshot(config, demandCount, outdoor, flow, back, now)), now);
  }
}

// Momentaufnahme der Zentralheizung inklusive Tagesbilanz (für Systemwerte).
async function centralValueSnapshot(config, demandCount, outdoor, flow, back, now = Date.now()) {
  const todayMs = await central.runtimeMsSince(database, central.startOfLocalDay(now), now).catch(() => 0);
  const today = central.costOf(config, todayMs);
  return {
    boilerOn: boiler.on,
    burnerOn: burner.on,
    pumpOn: pump.on,
    demandCount,
    outdoorTemp: outdoor == null ? null : outdoor,
    flowTemp: flow == null ? null : flow,
    returnTemp: back == null ? null : back,
    todayHours: Math.round(today.hours * 100) / 100,
    todayConsumption: Math.round(today.consumption * 1000) / 1000,
    todayCost: Math.round(today.cost * 100) / 100,
  };
}

// Momentaufnahme für Oberfläche und States-Seite.
function snapshot() {
  const byRoom = new Map();
  for (const room of roomList) {
    const state = roomState.get(room.id);
    byRoom.set(room.id, {
      temperature: state ? state.temperature : null,
      sensorCount: state ? state.sensorCount : 0,
      targetTemp: room.targetTemp,
      heating: !!(state && state.heating),
      cooling: !!(state && state.cooling),
      heatDemand: !!(state && state.heatDemand),
      heatAllowed: levelHandler.isAllowed(room.heatPriority),
      coolAllowed: levelHandler.isAllowed(room.coolPriority),
      centralDemand: !!(state && state.centralDemand),
      contactOpen: !!(state && state.blocked),
      contactPending: !!(state && state.contactOpenSince != null && !state.blocked),
      note: state ? state.note : '',
    });
  }
  return byRoom;
}

function centralSnapshot() {
  const demandCount = [...snapshot().values()].filter((entry) => entry.centralDemand).length;
  return {
    boilerOn: boiler.on,
    burnerOn: burner.on,
    firingSource: burner.source,
    pumpOn: pump.on,
    pumpStopAt: pump.stopAt,
    offRequestedAt: boiler.offRequestedAt,
    note: boiler.note,
    demandCount,
    outdoorTemp: central.readOutdoorTemperature(centralConfig, bus.getCache()),
    flowTemp: toNumber(cacheValue(central.flowCacheKey('flow'))),
    returnTemp: toNumber(cacheValue(central.flowCacheKey('return'))),
  };
}

async function reload() {
  if (!database) return;
  const previousRooms = roomList;
  clearLevelRegistration(previousRooms);
  roomList = [];
  sensorsByRoom = new Map();
  contactsByRoom = new Map();
  centralConfig = null;
  if (!isEnabled('heizung')) {
    clearSubscriptions();
    clearLevelRegistration(previousRooms);
    roomState.clear();
    published.clear();
    treesByRoom = new Map();
    loops = [];
    loopBaselines.clear();
    return;
  }
  const desired = new Map();
  roomList = await rooms.listRooms(database);
  const [sensors, contacts] = await Promise.all([rooms.listAllSensors(database), rooms.listAllContacts(database)]);
  for (const sensor of sensors) {
    if (!sensorsByRoom.has(sensor.roomId)) sensorsByRoom.set(sensor.roomId, []);
    sensorsByRoom.get(sensor.roomId).push(sensor);
    desired.set(rooms.sensorCacheKey(sensor.id), sensor.topic);
  }
  for (const contact of contacts) {
    if (!contactsByRoom.has(contact.roomId)) contactsByRoom.set(contact.roomId, []);
    contactsByRoom.get(contact.roomId).push(contact);
    desired.set(rooms.contactCacheKey(contact.id), contact.topic);
  }
  treesByRoom = new Map();
  loops = [];
  loadedAt = Date.now();
  for (const room of roomList) {
    desired.set(rooms.thermostatCacheKey(room.id), room.thermostatTopic);
    desired.set(rooms.fanCacheKey(room.id), room.fanTopic);
    const tree = await actionsRepo.actionTree(database, room.id);
    treesByRoom.set(room.id, tree);
    for (const action of actionsRepo.collectActions(tree)) {
      for (const [slot, topic] of runner.referencedSlots(action)) desired.set(runner.cacheKey(action.id, slot), topic);
    }
    for (const loop of actionsRepo.collectLoops(tree)) loops.push(loop);
  }
  syncLevelRegistration();
  // Der Prüfabstand einer neu geladenen Schleife startet mit dem Ladezeitpunkt.
  const currentLoopIds = new Set(loops.map((loop) => loop.id));
  for (const id of [...loopBaselines.keys()]) if (!currentLoopIds.has(id)) loopBaselines.delete(id);
  for (const loop of loops) if (!loopBaselines.has(loop.id)) loopBaselines.set(loop.id, loadedAt);
  for (const id of [...roomState.keys()]) if (!roomList.some((room) => room.id === id)) roomState.delete(id);
  // Nach einem Umbenennen oder Entfernen dürfen die alten Topics nicht als
  // Karteileichen im State-Bus stehen bleiben.
  const liveTopics = new Set();
  for (const room of roomList) {
    for (const state of rooms.ROOM_STATES) liveTopics.add(rooms.stateTopic(room.name, state.suffix));
  }
  for (const topic of [...published.keys()]) {
    if (topic.startsWith(topicForId(rooms.ID_PREFIX)) && !liveTopics.has(topic)) {
      published.delete(topic);
      bus.remove(topic);
    }
  }

  centralConfig = await central.loadCentralConfig(database);
  desired.set(central.flowCacheKey('switch'), centralConfig.switchTopic);
  desired.set(central.flowCacheKey('pump'), centralConfig.pumpTopic);
  desired.set(central.flowCacheKey('feedback'), centralConfig.burnerFeedbackTopic);
  desired.set(central.flowCacheKey('outdoor'), centralConfig.outdoorTopic);
  desired.set(central.flowCacheKey('flow'), centralConfig.flowTopic);
  desired.set(central.flowCacheKey('return'), centralConfig.returnTopic);
  applySubscriptions(desired);
}

// Raum zu einer State-id (raeume.<Raum>.<wert>). Der Vergleich läuft ohne
// Rücksicht auf Groß- und Kleinschreibung, damit ein von Hand eingetragenes
// Topic ebenso trifft.
function roomByAddress(address) {
  const wanted = rooms.addressFor(String(address || '')).toLowerCase();
  if (!wanted) return null;
  return roomList.find((room) => rooms.addressFor(room.name).toLowerCase() === wanted) || null;
}

// Schreibzugriff auf system://homeess/raeume.<Raum>.soll: setzt die
// Soll-Temperatur. Alle übrigen Raumwerte sind Messwerte und bleiben gesperrt.
function handleRoomWrite(id, value) {
  const parts = String(id || '').slice(rooms.ID_PREFIX.length).split('.');
  const suffix = parts.pop();
  const room = roomByAddress(parts.join('_'));
  if (!room || suffix !== 'soll' || !database) return;
  rooms.setTargetTemp(database, room.id, value)
    .then(async (target) => {
      room.targetTemp = target;
      await tick().catch(() => {});
    })
    .catch(() => {});
}

// Schreibzugriff auf system://homeess/zentralheizung.schornsteinfeger.
function handleCentralWrite(id, value) {
  if (String(id) !== central.stateId('schornsteinfeger') || !database) return;
  setSweepMode(truthy(value)).catch(() => {});
}

// Schornsteinfeger-Modus umschalten. Beim Verlassen bekommen gekoppelte
// Thermostate ihre eingestellte Soll-Temperatur zurück.
async function setSweepMode(enabled) {
  if (!database) return;
  await central.setSweepMode(database, enabled);
  centralConfig = await central.loadCentralConfig(database);
  await tick().catch(() => {});
}

// Alle Systemwerte des Moduls aus dem zuletzt berechneten Stand. Über diesen
// Provider erscheinen sie auf der States-Seite, im State-Picker und im
// Wertekatalog — auch zwischen zwei Takten.
async function currentValues() {
  if (!isEnabled('heizung') || !centralConfig) return [];
  const states = snapshot();
  const entries = [];
  for (const room of roomList) entries.push(...rooms.roomEntries(room, states.get(room.id) || {}));
  if (centralConfig.enabled && database) {
    const view = centralSnapshot();
    entries.push(...central.centralEntries(centralConfig, await centralValueSnapshot(
      centralConfig, view.demandCount, view.outdoorTemp, view.flowTemp, view.returnTemp
    )));
  }
  return entries;
}

async function init(db) {
  database = db;
  if (!providersRegistered) {
    registerValueProvider(() => currentValues());
    systemRouter.registerWriter(rooms.ID_PREFIX, handleRoomWrite);
    systemRouter.registerWriter(central.ID_PREFIX, handleCentralWrite);
    providersRegistered = true;
  }
  await central.closeOpenRuns(db).catch(() => {});
  boiler = { on: false, offRequestedAt: null, note: '', commandOn: null, commandAt: null };
  pump = { on: false, since: null, stopAt: null };
  burner = { on: false, source: 'switch', last: null, rising: 0, falling: 0, runId: null };
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
  clearLevelRegistration();
  roomList = [];
  sensorsByRoom = new Map();
  contactsByRoom = new Map();
  centralConfig = null;
  roomState.clear();
  published.clear();
  treesByRoom = new Map();
  loops = [];
  loopBaselines.clear();
  commandedFans.clear();
  runner.reset();
  boiler = { on: false, offRequestedAt: null, note: '', commandOn: null, commandAt: null };
  pump = { on: false, since: null, stopAt: null };
  burner = { on: false, source: 'switch', last: null, rising: 0, falling: 0, runId: null };
  thermostatEpoch = null;
  database = null;
}

module.exports = {
  init, reload, stop, tick, snapshot, centralSnapshot, setSweepMode, runPhase, checkLoops,
  hystereticBelow, hystereticAbove, coolThreshold, mayStopBoiler, pumpReady, switchPayload, consumerId,
  detectFiring,
  TICK_MS,
};
