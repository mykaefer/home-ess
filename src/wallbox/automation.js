'use strict';

// Steuerschleife des Wallbox-Moduls (Vorbild: pool/automation.js).
// Pro Tick wird je Wallbox der Lademodus ausgewertet (planner.js), gegen das
// Betriebslevel gegatet und per MQTT geschaltet; jede Box ist als Verbraucher am
// zentralen Betriebslevel-Handler registriert (siehe LEVEL_HANDLING.md).

const mqttClient = require('../mqtt/client');
const { isEnabled } = require('../modules');
const levelHandler = require('../operating-level/handler');
const { loadMqttConfig } = require('../mqtt/config');
const { loadGridControlConfig } = require('../grid-control/config');
const gridControlAutomation = require('../grid-control/automation');
const loadShed = require('../grid-control/load-shed');
const { localCalendar } = require('../local-time');
const { listWallboxes, setWallboxMode, cacheKey } = require('./boxes');
const { readWallboxValues, parseNumber, parseBool } = require('./aggregation');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const {
  EIGENVERBRAUCH_L1_STATE_ID,
  EIGENVERBRAUCH_L2_STATE_ID,
  EIGENVERBRAUCH_L3_STATE_ID,
} = require('../stromverbrauch/config');
const { readBatterieData, loadBatterieConfig } = require('../batterie/config');
const { listPvPlants } = require('../photovoltaik/plants');
const { readPhotovoltaikValues } = require('../photovoltaik/aggregation');
const {
  planCharge, decideWallboxAction, predictNextChargeStart, FULL_SOC,
  HOUSE_BATTERY_RESERVE_MARGIN_PERCENT,
} = require('./planner');
const { computePrognosis } = require('../prognosis/forecast');

const HOLD_MS = 2 * 60 * 1000;        // Mindesthaltedauer für An/Aus-Wechsel
const SETPOINT_MIN_DELTA_W = 200;     // kleinere Soll-Änderungen nicht senden

function consumerId(box) {
  return `wallbox.${box.id}`;
}

// In-Memory-Zustand je Box (nach Neustart zurückgesetzt – akzeptabel).
const state = new Map(); // id -> siehe decideWallboxAction
function boxState(id) {
  let s = state.get(id);
  if (!s) {
    s = {
      output: null, changedAt: 0, setpointW: null, lastModeSync: null,
      lastBrokerStatus: null, brokerStatusInitialized: false, expectedBrokerStatus: null,
      manualFull: false, manualFullSawCharging: false,
      manualOff: false, manualOffDay: '', lastTodayKey: '',
      chargeStartedAt: null, restartUntil: 0, restartAttempts: 0,
      nextChargeAt: null, nextChargeHour: null,
      loadShedOff: false,
    };
    state.set(id, s);
  }
  return s;
}

// Broker-bestätigter Bedienwert am Steuer-Topic. Nur dieser Kanal darf manuelle
// Nutzerwünsche auslösen; das Status-Topic ist ein reiner Ist-Zustand.
function readBrokerCommand(cache, box) {
  const entry = cache.get(cacheKey(box.id, 'command'));
  if (!entry || entry.value == null || entry.value === '') return null;
  return parseBool(entry.value) ? 'on' : 'off';
}

function sendCommand(box, stateForBox, on) {
  if (!box.commandTopic) return;
  stateForBox.expectedBrokerStatus = on ? 'on' : 'off';
  mqttClient.publish(box.commandTopic, on ? '1' : '0');
}
function sendSetpoint(topic, watt) {
  if (topic && watt != null) mqttClient.publish(topic, String(Math.round(watt)));
}

function load(loader, db) {
  return new Promise((resolve) => loader(db, resolve));
}

function loadShedPriority(box) {
  return Number(box.mode === 2 ? box.priorityBusiness : box.mode === 3 ? box.priorityFull : box.priorityPrivate);
}

function weekdayMonZero(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=So
  return (wd + 6) % 7; // 0=Mo
}
function tomorrowWeekdayMonZero(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return (next.getUTCDay() + 6) % 7;
}

// Erwartete PV-Leistung (kW) einer Prognosestunde.
function pvKwForHour(forecast, dateKey, hour) {
  if (!forecast || !Array.isArray(forecast.hours)) return 0;
  return forecast.hours
    .filter((s) => s.dateKey === dateKey && Number(s.hour) === hour)
    .reduce((sum, s) => sum + (Number(s.kwh) || 0), 0);
}

// Stündliche Überschuss-Reihe (PV minus erwartete Hauslast) aus der System-Prognose,
// ab der aktuellen Stunde. Grundlage für die Vorhersage des nächsten Ladebeginns.
function buildSurplusSeries(forecast, model, calendar, nowMs) {
  if (!forecast || !Array.isArray(forecast.days) || !model) return [];
  const nowDecimal = (calendar.hours || 0) + (calendar.minutes || 0) / 60;
  const series = [];
  forecast.days.forEach((day, dayIndex) => {
    const [y, m, d] = String(day.dateKey).split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Index der Prognose-Profile (0=So)
    const profile = (model.profilesByWeekday && model.profilesByWeekday[wd]) || model.profile || [];
    const target = (model.dailyTargetsByWeekday && model.dailyTargetsByWeekday[wd] != null)
      ? model.dailyTargetsByWeekday[wd]
      : (model.dailyTarget || 0);
    for (let h = 0; h < 24; h += 1) {
      if (dayIndex === 0 && h < Math.floor(nowDecimal)) continue; // vergangene Stunden
      const pvKw = pvKwForHour(forecast, day.dateKey, h);
      const loadKw = target * (profile[h] || 0);
      // Lokale Wanduhr-Arithmetik genügt für eine Restzeit-Schätzung (DST vernachlässigt).
      const startMs = nowMs + ((dayIndex * 24 + h) - nowDecimal) * 3600000;
      series.push({
        startMs, dateKey: day.dateKey, dayIndex, hour: h,
        pvW: pvKw * 1000, surplusW: (pvKw - loadKw) * 1000,
      });
    }
  });
  return series;
}

// Aktuell verfügbare Überschussleistung im Haus (W): Netzeinspeisung plus
// Batterie-Ladeleistung, solange der Hausakku über dem Mindest-SoC liegt.
function houseSurplusWatt(strom, battery, batteryMinSoc, wallboxPowerW = 0) {
  const netzbezug = parseNumber(strom.netzbezugPower); // positiv = Bezug
  // Den Netzsaldo erst NACH dem Zurückrechnen der eigenen Wallbox-Leistung auf 0
  // begrenzen. Sonst wird z. B. 2,3 kW Netzbezug zunächst verworfen und die
  // gleichzeitig gemessene Wallbox-Leistung anschließend fälschlich als voller
  // PV-Überschuss gewertet – eine laufende Ladung hielte sich dadurch selbst an.
  let surplus = netzbezug != null ? -netzbezug : 0;
  surplus += Math.max(0, parseNumber(wallboxPowerW) || 0);
  const battPower = parseNumber(battery.power);        // positiv = laden
  const soc = parseNumber(battery.soc);
  const minSoc = parseNumber(battery.minSoc) ?? batteryMinSoc;
  if (battPower != null) {
    // Entladung immer gegenrechnen: Eine laufende Wallbox darf sich nicht durch
    // Leistung aus dem Hausakku selbst als Überschuss erhalten. Ladeleistung des
    // Hausakkus erst oberhalb einer Reservezone vorsichtig für das Auto freigeben.
    if (battPower < 0) surplus += battPower;
    else if (battPower > 0 && soc != null && minSoc != null &&
        soc > minSoc + HOUSE_BATTERY_RESERVE_MARGIN_PERCENT) surplus += battPower;
  }
  return Math.max(0, surplus);
}

// Modus-Sync-Topic: einen extern gesetzten Modus übernehmen (ohne Rückschreiben).
async function adoptModeSync(db, box, cache, s) {
  if (!box.modeSyncTopic) return box.mode;
  const entry = cache.get(cacheKey(box.id, 'modeSync'));
  const value = entry ? Math.round(parseNumber(entry.value)) : null;
  if (![1, 2, 3].includes(value)) return box.mode;
  if (value === s.lastModeSync) return box.mode;
  s.lastModeSync = value;
  if (value !== box.mode) {
    await setWallboxMode(db, box.id, value);
    return value;
  }
  return box.mode;
}

let _knownConsumers = new Set();

async function tick(db) {
  if (!isEnabled('wallbox')) {
    for (const id of _knownConsumers) levelHandler.unregister(id);
    _knownConsumers = new Set();
    loadShed.unregisterProvider('wallbox');
    return;
  }

  const cache = mqttClient.getCache();
  const now = Date.now();
  const boxes = await listWallboxes(db);
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date(now));

  // Extern synchronisierte Modi zuerst übernehmen, damit Steuerentscheidung und
  // anschließend berechnete Systemprognose garantiert denselben Modus sehen.
  for (const box of boxes) {
    box.mode = await adoptModeSync(db, box, cache, boxState(box.id));
  }

  const strom = await readStromverbrauchValues(db, cache).catch(() => ({ netzbezugPower: null }));
  const battery = readBatterieData(cache);
  const batterieConfig = await new Promise((resolve) => loadBatterieConfig(db, resolve));
  // Live-PV-Gesamtleistung (für die Freigabe nach manuellem Ausschalten).
  let pvPowerW = null;
  try {
    const pv = await readPhotovoltaikValues(db, cache, await listPvPlants(db));
    pvPowerW = pv.totals.current;
  } catch (_) {}

  // Prognose einmalig (cache-only); für die vorausschauende Bewertung verfügbar.
  const prognosis = await computePrognosis(db, cache, { allowFetch: false }).catch(() => null);
  const prognosisAvailable = Boolean(prognosis && prognosis.simulation && prognosis.simulation.available);
  const surplusSeries = prognosis ? buildSurplusSeries(prognosis.forecast, prognosis.model, calendar, now) : [];
  const forecastPlanById = new Map(
    (((prognosis || {}).model || {}).wallboxModel?.boxes || [])
      .map((plannedBox) => [Number(plannedBox.id), plannedBox.nextCharge])
  );
  const forecastOverflowById = new Map(
    ((((prognosis || {}).model || {}).wallboxModel?.boxes || []).map((plannedBox) => [
      Number(plannedBox.id),
      Number((plannedBox.plannedFlexibleEnergyByDate || {})[calendar.dateKey]) || 0,
    ]))
  );

  const values = await readWallboxValues(db, cache, boxes);
  const valueById = new Map(values.map((v) => [v.id, v]));
  const gridControlEnabled = isEnabled('grid-control');
  const gridCfg = gridControlEnabled ? await load(loadGridControlConfig, db) : null;
  const gridState = gridControlEnabled ? gridControlAutomation.getState() : null;
  const loadShedActive = !!(gridControlEnabled && gridCfg && gridCfg.loadEnabled && gridState);
  if (!loadShedActive) {
    for (const box of boxes) boxState(box.id).loadShedOff = false;
  }
  loadShed.registerProvider('wallbox', boxes
    .filter((box) => {
      const s = boxState(box.id);
      return box.commandTopic && (s.output === 'on' || s.loadShedOff || readBrokerCommand(cache, box) === 'on');
    })
    .map((box) => ({
      id: consumerId(box),
      phase: box.loadShedPhase,
      priority: loadShedPriority(box),
    })));
  if (loadShedActive) loadShed.update(gridState.inverterLoads, gridCfg, now);
  const seen = new Set();

  for (const box of boxes) {
    const s = boxState(box.id);
    s.lastTodayKey = calendar.dateKey;
    const live = valueById.get(box.id) || {};
    const id = consumerId(box);
    seen.add(id);

    const ctx = {
      soc: live.soc,
      plugged: live.plugged,
      // Eigene Ladeleistung zurückrechnen, ohne dabei vorhandenen Netzbezug zu
      // verlieren (siehe houseSurplusWatt).
      surplusW: houseSurplusWatt(strom, battery, batterieConfig.minSoc, live.powerW),
      hour: calendar.hours,
      minute: calendar.minutes,
      weekday: weekdayMonZero(calendar.dateKey),
      tomorrowWeekday: tomorrowWeekdayMonZero(calendar.dateKey),
      prognosisAvailable,
      prognosisOverflowKwh: forecastOverflowById.get(Number(box.id)) ?? null,
      houseBatterySoc: parseNumber(battery.soc),
      houseBatteryMinSoc: parseNumber(battery.minSoc) ?? batterieConfig.minSoc,
    };
    const plan = planCharge(box, ctx);

    // Registrierung beim Betriebslevel-Handler: nur mit Steuer-Topic.
    if (box.commandTopic) {
      levelHandler.register(id, plan.priority, { onMustTurnOff: () => forceOff(box) });
      _knownConsumers.add(id);
    } else {
      levelHandler.unregister(id);
      _knownConsumers.delete(id);
      continue;
    }

    // Sonderfälle (manuelle Schaltung, Ladestart-Neustart, Level-Gate) anwenden.
    const decision = decideWallboxAction(box, s, {
      plan,
      brokerStatus: readBrokerCommand(cache, box),
      powerW: live.powerW,
      pvPowerW,
      selfConsumptionW: parseNumber(strom.eigenverbrauchPower),
      houseBatterySoc: parseNumber(battery.soc),
      houseBatteryMinSoc: parseNumber(battery.minSoc) ?? batterieConfig.minSoc,
      soc: live.soc,
      plugged: live.plugged,
      todayKey: calendar.dateKey,
      levelAllows: levelHandler.isAllowed(plan.priority),
      now,
    });
    const wantsOn = decision.on === true;
    if (loadShedActive && wantsOn && loadShed.shouldShed(box.loadShedPhase, plan.priority)) {
      decision.on = false;
      decision.setpointW = null;
      s.loadShedOff = true;
    } else if (wantsOn) {
      s.loadShedOff = false;
    } else {
      s.loadShedOff = false;
    }

    // Soll-Leistung (falls Topic) bei aktiver Ladung modulieren.
    if (box.setpointTopic && decision.on && decision.setpointW != null) {
      if (s.setpointW == null || Math.abs(decision.setpointW - s.setpointW) >= SETPOINT_MIN_DELTA_W) {
        sendSetpoint(box.setpointTopic, decision.setpointW);
        s.setpointW = decision.setpointW;
      }
    }

    // An/Aus mit Mindesthaltedauer gegen Flattern. bypassHold (Neustart-Zyklus)
    // schaltet sofort, Ausschalten ist ohnehin immer sofort erlaubt.
    const desired = decision.on ? 'on' : 'off';
    if (s.output !== desired) {
      const holdOk = decision.bypassHold || s.changedAt === 0 || now - s.changedAt >= HOLD_MS;
      if (desired === 'off' || holdOk) {
        sendCommand(box, s, decision.on);
        s.output = desired;
        s.changedAt = now;
        if (!decision.on) s.setpointW = null;
      }
    }

    // Voraussichtlicher nächster Ladebeginn, wenn gerade nicht geladen wird.
    const charging = decision.on || (live.powerW != null && live.powerW > box.stallPowerW);
    const full = live.soc != null && live.soc >= FULL_SOC;
    let next = null;
    const hasSharedForecastPlan = forecastPlanById.has(Number(box.id));
    if (!charging && !full && s.manualFull) {
      next = { at: now, hour: calendar.hours };
    } else if (!charging && !full && !s.manualOff) {
      next = forecastPlanById.get(Number(box.id)) || null;
    }
    // Manuelle Sperren müssen weiterhin nach ihrer besonderen Freigaberegel
    // ausgewertet werden. Ohne gemeinsamen Plan bleibt die bisherige Berechnung
    // als sicherer Fallback erhalten.
    if ((!hasSharedForecastPlan && !next && !charging && !full) || s.manualOff) {
      next = predictNextChargeStart(box, s, {
        series: surplusSeries,
        nowMs: now,
        isCharging: charging,
        full,
        weekdayMon: weekdayMonZero(calendar.dateKey),
        tomorrowWeekdayMon: tomorrowWeekdayMonZero(calendar.dateKey),
      });
    }
    s.nextChargeAt = next ? next.at : null;
    s.nextChargeHour = next ? next.hour : null;
  }

  // Registrierungen entfernter/umgestellter Boxen aufräumen.
  for (const id of [..._knownConsumers]) {
    if (!seen.has(id)) {
      levelHandler.unregister(id);
      _knownConsumers.delete(id);
    }
  }
}

// Sofort-Abschaltung auf Anforderung des Betriebslevel-Handlers (Level gesunken).
function forceOff(box) {
  if (!box.commandTopic) return;
  const s = boxState(box.id);
  sendCommand(box, s, false);
  s.output = 'off';
  s.changedAt = Date.now();
  s.setpointW = null;
  s.loadShedOff = false;
}

// Sichtbare manuelle Übersteuerung je Wallbox. MQTT-Schaltänderungen im laufenden
// Betrieb nutzen dieselben Zustände; der erste Readback nach einem Neustart nicht.
function getControlMode(boxId) {
  const s = state.get(Number(boxId));
  if (!s) return 'auto';
  if (s.manualOff) return 'off';
  if (s.manualFull) return 'full';
  return 'auto';
}

function setControlMode(boxId, mode) {
  const normalized = ['auto', 'off', 'full'].includes(mode) ? mode : 'auto';
  const s = boxState(Number(boxId));
  s.manualFull = normalized === 'full';
  s.manualFullSawCharging = false;
  s.manualOff = normalized === 'off';
  s.manualOffDay = normalized === 'off' ? s.lastTodayKey : '';
  s.restartUntil = 0;
  s.restartAttempts = 0;
  if (normalized !== 'full') s.chargeStartedAt = null;
  return getControlMode(boxId);
}

// Voraussichtlicher nächster Ladebeginn einer Box: { at: ms, hour } oder null.
// Die Restzeit in Sekunden wird vom Aufrufer aus `at` zur Lesezeit berechnet.
function getNextCharge(boxId) {
  const s = state.get(boxId);
  if (!s || s.nextChargeAt == null) return null;
  return { at: s.nextChargeAt, hour: s.nextChargeHour };
}

// Modus über die Oberfläche setzen → optional auf das Sync-Topic spiegeln.
async function applyModeChange(db, box) {
  const s = boxState(box.id);
  s.lastModeSync = box.mode;
  if (box.modeSyncTopic) mqttClient.publish(box.modeSyncTopic, String(box.mode));
}

let _timer = null;
let _tickChain = Promise.resolve();
let _unsubscribe = null;

function runNow(db) {
  const run = _tickChain.then(() => tick(db));
  _tickChain = run.catch(() => {});
  return run;
}

function init(db) {
  if (_timer) return;
  if (!_unsubscribe) {
    _unsubscribe = mqttClient.onValuesChanged((event) => {
      const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
      if (keys.some((key) => [EIGENVERBRAUCH_L1_STATE_ID, EIGENVERBRAUCH_L2_STATE_ID, EIGENVERBRAUCH_L3_STATE_ID].includes(String(key)))) {
        runNow(db).catch(() => {});
      }
    });
  }
  _timer = setInterval(() => runNow(db).catch(() => {}), 30000);
  runNow(db).catch(() => {});
}

module.exports = {
  init, runNow, tick, applyModeChange, getNextCharge, houseSurplusWatt,
  getControlMode, setControlMode,
};
