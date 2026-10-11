'use strict';
const repo = require('./repository');
const actuator = require('./actuator');
const { planRoom, closeEnough } = require('./model');
const solar = require('./solar');
const bus = require('../state-bus');
const mqtt = require('../mqtt/client');
const modules = require('../modules');
const rooms = require('../heizung/rooms');
const weather = require('../wetter/client');
const { loadMqttConfig } = require('../mqtt/config');
const { parseSchemeTopic, buildSchemeTopic } = require('../mqtt/topics');

let database, timer, unsubscribe, busy = false, loadedAt = 0;
let shutters = [], policies = new Map(), subscriptions = new Map();
const status = new Map();
const directionBaselines = new Set();
let lastForecastRequest = 0, activeTick = null;
const key = (id, kind) => `rollladen:${id}:${kind}`;
const numeric = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
function feedbackTopic(shutter) {
  if (shutter.positionFeedbackTopic) return shutter.positionFeedbackTopic;
  const parsed = parseSchemeTopic(shutter.positionTopic);
  // HmIP-Rollladen: virtueller Empfänger :4 nimmt LEVEL-Befehle entgegen,
  // der Transmitter :3 meldet die echte Position. Bestehende Konfigurationen
  // mit :4/LEVEL bekommen so ohne Umkonfiguration die richtige Rückmeldung.
  if (parsed?.scheme === 'hm-rpc' && /%3A4\/LEVEL$/i.test(parsed.address)) {
    return buildSchemeTopic(parsed.scheme, parsed.instance, parsed.address.replace(/%3A4\/LEVEL$/i, '%3A3/LEVEL'));
  }
  return shutter.positionTopic;
}
function position(shutter, value) {
  const n = numeric(value);
  if (n == null || n < 0 || n > 100) return null;
  return Math.max(0, Math.min(100, (n - shutter.openValue) * 100 / (shutter.closedValue - shutter.openValue)));
}
function contact(value, openValue) {
  if (value == null || value === '') return null;
  const norm = v => String(v).trim().toLowerCase();
  const v = norm(value), open = norm(openValue);
  if (v === open) return true;
  for (const pair of [['true', 'false'], ['1', '0'], ['open', 'closed'], ['on', 'off']]) {
    if (pair.includes(open) && pair.includes(v)) return false;
  }
  return null;
}
async function reload() {
  if (activeTick) await activeTick;
  if (!database) return;
  const previous = new Map(shutters.map(s => [s.id, s]));
  shutters = modules.isEnabled('rollladen') ? await repo.list(database) : [];
  policies = await repo.policies(database);
  for (const s of shutters) {
    const memory = policies.get(s.roomId)?.memory;
    const state = memory?.shutters?.[s.id];
    if (!state) continue;
    const configChanged = previous.has(s.id) && JSON.stringify(previous.get(s.id)) !== JSON.stringify(s);
    const readback = feedbackTopic(s);
    // Bei alten HmIP-Konfigurationen war :4/LEVEL irrtümlich zugleich der
    // Istwert. Die jetzt verwendete :3-Rückmeldung benötigt eine neue Basis;
    // Fehlermeldungen aus dem falschen Wertebereich dürfen nicht sperren.
    const readbackChanged = s.positionTopic && readback !== s.positionTopic && state.readbackTopic !== readback;
    if (!configChanged && !readbackChanged) continue;
    directionBaselines.delete(s.id);
    for (const field of ['pending', 'observed', 'external', 'changedAt', 'fault', 'failedTarget', 'estimated', 'directionValues', 'commandEcho']) delete state[field];
    if (readbackChanged) state.readbackTopic = readback;
    await repo.remember(database, s.roomId, memory);
  }
  const wanted = new Map();
  for (const s of shutters) for (const kind of (s.positionTopic ? ['position', 'contact'] : ['up', 'down', 'contact'])) {
    const topic = kind === 'position' ? feedbackTopic(s) : s[`${kind}Topic`];
    if (topic) wanted.set(key(s.id, kind), topic);
  }
  for (const [k, topic] of subscriptions) if (wanted.get(k) !== topic) mqtt.unsubscribeAdHoc(k);
  for (const [k, topic] of wanted) if (subscriptions.get(k) !== topic) mqtt.subscribeAdHoc(topic, k);
  subscriptions = wanted;
  status.clear();
}
function tick(now = Date.now()) {
  if (activeTick) return activeTick;
  activeTick = runTick(now).finally(() => { activeTick = null; });
  return activeTick;
}
async function runTick(now) {
  // Ein aktiviertes, noch nicht eingerichtetes Modul darf keine Hintergrundlast erzeugen.
  if (busy || !database || !shutters.length || !modules.isEnabled('rollladen')) return;
  busy = true;
  try {
    const config = await new Promise(resolve => loadMqttConfig(database, resolve));
    if (now - lastForecastRequest > 15 * 60000) {
      lastForecastRequest = now;
      weather.fetchForecast(config.latitude, config.longitude).catch(() => {});
    }
    const forecast = weather.getCachedForecast(config.latitude, config.longitude);
    const elevation = solar.elevation(config, now);
    const roomList = await rooms.listRooms(database);
    const sensors = modules.isEnabled('heizung') ? await rooms.listAllSensors(database) : [];
    const cinemas = modules.isEnabled('heimkino') ? await repo.all(database, 'SELECT m.room_id FROM rollladen_cinema m JOIN heimkino_rooms c ON c.id=m.cinema_id WHERE c.cinema_on=1') : [];
    const samples = await repo.all(database, 'SELECT recorded_at, intensity FROM sun_intensity_samples WHERE recorded_at >= ? AND day_average_eligible=1 ORDER BY recorded_at', [now - 10 * 60000]);
    const cache = bus.getCache();
    for (const room of roomList) {
      const members = shutters.filter(s => s.roomId === room.id);
      if (!members.length) continue;
      const policy = policies.get(room.id) || { brightness: 50, memory: {} };
      const memory = policy.memory;
      const before = JSON.stringify(memory);
      memory.shutters ||= {};
      const freshSensors = sensors.filter(s => s.roomId === room.id && now - (cache.get(rooms.sensorCacheKey(s.id))?.receivedAt || 0) < 30 * 60000);
      const temperature = modules.isEnabled('heizung') && room.targetTemp != null ? rooms.averageTemperature(cache, freshSensors).value : null;
      memory.temperatures = (memory.temperatures || []).filter(v => now - v.at < 30 * 60000);
      if (temperature != null && (!memory.temperatures.length || now - memory.temperatures.at(-1).at >= 60000)) memory.temperatures.push({ at: now, value: temperature });
      const first = memory.temperatures[0];
      const slope = first && now - first.at >= 5 * 60000 ? Math.max(0, Math.min(2, (temperature - first.value) * 3600000 / (now - first.at))) : 0;
      const inputs = members.map(s => {
        const m = memory.shutters[s.id] ||= {};
        const readback = cache.get(key(s.id, 'position'));
        let p = s.positionTopic ? position(s, readback?.value) : null;
        const c = s.contactTopic ? contact(cache.get(key(s.id, 'contact'))?.value, s.contactOpenValue) : false;
        let manualChange = false;
        if (!s.positionTopic) {
          if (!directionBaselines.has(s.id)) { m.directionValues = {}; directionBaselines.add(s.id); }
          const feedback = actuator.directionFeedback(s, m, { up: cache.get(key(s.id, 'up')), down: cache.get(key(s.id, 'down')) }, now);
          p = feedback.position; manualChange = feedback.manualChange;
        }
        if (s.positionTopic && p != null) {
          if (m.observed != null && !closeEnough(p, m.observed)) {
            m.changedAt = now;
            const ownMotion = m.pending && now < m.pending.until;
            const reversed = ownMotion && (p - m.observed) * (m.pending.target - m.pending.from) < -2;
            m.external = !ownMotion || reversed;
            if (reversed) m.pending = null;
          }
          m.observed = p;
          if (m.pending && readback.receivedAt >= m.commandAt && closeEnough(p, m.pending.target)) { m.pending = null; m.external = false; }
          if (m.pending && now >= m.pending.until) {
            // Fahrt ohne bestätigtes Ziel sperren, statt den Motor zyklisch erneut anzufahren.
            m.fault = 'Ziel nicht bestätigt; Aktor prüfen'; m.failedTarget = m.pending.target; m.pending = null; m.external = false; manualChange = true;
          }
          if (m.external && now - m.changedAt >= 2000) { manualChange = true; m.external = false; m.fault = null; }
        }
        return { id: s.id, directionReadbacks: s.positionTopic ? null : ['up', 'down'].map(kind => cache.get(key(s.id, kind))), position: p, shadePercent: s.positionTopic ? (s.shadePercent ?? 100) : 100, manualChange, contactOpen: c === true, contactUnknown: c == null,
          cinema: cinemas.some(c => c.room_id === room.id), temperature,
          limit: room.targetTemp == null ? null : Math.max(room.targetTemp + room.coolOffset, room.coolMinTemp ?? -Infinity),
          predictedTemperature: temperature == null ? null : temperature + slope * 0.5,
          sunReliable: temperature != null && solar.sustainedSun(config, forecast, s.orientation, now, samples) };
      });
      const result = planRoom(memory, { now, elevation, brightness: policy.brightness, shutters: inputs });
      for (const decision of result.decisions) {
        const s = members.find(s => s.id === decision.id), input = inputs.find(i => i.id === s.id);
        const m = result.state.shutters[s.id];
        status.set(s.id, { ...decision, position: input.position, manual: !!result.state.manual, fault: m.fault, estimated: !s.positionTopic });
        if ((now - loadedAt < 10000 && !input.contactOpen) || decision.target == null || (s.positionTopic && input.position == null && (!input.contactOpen || input.cinema)) || m.external || input.manualChange) continue;
        if (closeEnough(input.position, decision.target) && (!m.pending || m.pending.target === decision.target)) continue;
        if (m.pending && m.pending.target === decision.target) continue;
        // Sicherheitsöffnung darf eine laufende Schließfahrt sofort umkehren.
        if (m.pending && !input.contactOpen && !input.cinema) continue;
        if (m.fault && (!input.contactOpen || m.failedTarget === 0)) continue;
        if (!input.cinema && decision.target > input.position && (input.contactOpen || input.contactUnknown)) continue;
        const command = actuator.command(s, decision.target);
        if (!command) continue;
        // Vor dem Schreiben speichern: auch synchrones Adapter-Echo ist eine eigene Fahrt.
        m.pending = { from: input.position, target: decision.target, until: now + (s.travelSeconds + 10) * 1000 };
        m.commandAt = now;
        m.commandEcho = { kind: command.kind, until: m.pending.until };
        if (decision.reason === 'Vorausschauender Sonnenschutz' && decision.target > 0) m.shadeSince = now;
        await repo.remember(database, room.id, result.state);
        // Während der Persistierung können Fenster- oder Handereignisse
        // eintreffen. Unmittelbar vor dem Aktorzugriff erneut sicher prüfen.
        const latestPosition = s.positionTopic ? position(s, cache.get(key(s.id, 'position'))?.value) : input.position;
        const latestContact = s.contactTopic ? contact(cache.get(key(s.id, 'contact'))?.value, s.contactOpenValue) : false;
        const changedPosition = latestPosition !== input.position;
        const changedDirection = input.directionReadbacks && ['up', 'down'].some((kind, index) => cache.get(key(s.id, kind)) !== input.directionReadbacks[index]);
        if (!modules.isEnabled('rollladen') || changedPosition || changedDirection || (decision.target > 0 && !input.cinema && latestContact !== false)) {
          m.pending = null; m.commandEcho = null;
          continue;
        }
        if (!mqtt.publish(command.topic, command.value)) { m.pending = null; m.failedTarget = decision.target; m.fault = 'Schreibziel nicht erreichbar'; }
      }
      if (before !== JSON.stringify(result.state)) await repo.remember(database, room.id, result.state);
      policies.set(room.id, { ...policy, memory: result.state });
    }
  } finally { busy = false; }
}
// Automatische Kühlung erhält nach erfolgreicher Beschattung eine begrenzte
// Wirkungszeit. Manuelle Klimabefehle und Räume mit offenen Fenstern bleiben frei.
function coolingHold(roomId, now = Date.now()) {
  if (!modules.isEnabled('rollladen')) return false;
  const policy = policies.get(roomId);
  if (!policy || policy.memory.manual) return false;
  return shutters.filter(s => s.roomId === roomId).some(s => {
    const m = policy.memory.shutters?.[s.id];
    const view = status.get(s.id);
    return m?.shaded && m.commandAt >= m.shadeSince && now - m.shadeSince < 15 * 60000
      && view?.planned > 0 && view?.reason === 'Vorausschauender Sonnenschutz' && !m.fault;
  });
}
function report(error) { console.error('[rollladen]', error.message); }
async function init(db) {
  database = db; loadedAt = Date.now();
  await reload();
  if (!timer) { timer = setInterval(() => tick().catch(report), 1000); timer.unref?.(); }
  if (!unsubscribe) unsubscribe = bus.onValuesChanged(({ changedKeys = [] } = {}) => {
    // Der gemeinsame Bus enthält auch sämtliche PV-, Zähler- und Adapterwerte.
    // Nur unsere Positions-/Fensterabos benötigen eine sofortige Auswertung;
    // Temperatur, Kino und Sonnenverlauf werden vom Sekundentakt erfasst.
    // Während eines Laufs übernimmt spätestens der nächste Takt neue Werte.
    if (activeTick || !changedKeys.some(key => subscriptions.has(key))) return;
    tick().catch(report);
  });
}
function stop() {
  clearInterval(timer); timer = null; unsubscribe?.(); unsubscribe = null;
  for (const k of subscriptions.keys()) mqtt.unsubscribeAdHoc(k);
  subscriptions.clear(); directionBaselines.clear(); shutters = []; status.clear(); database = null;
}
module.exports = { init, reload, tick, stop, coolingHold, snapshot: () => new Map(status), position, contact, feedbackTopic };
