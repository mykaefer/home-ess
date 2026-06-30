'use strict';

// Steuerschleife des Wallbox-Moduls (Vorbild: pool/automation.js).
// Pro Tick wird je Wallbox der Lademodus ausgewertet (planner.js), gegen das
// Betriebslevel gegatet und per MQTT geschaltet; jede Box ist als Verbraucher am
// zentralen Betriebslevel-Handler registriert (siehe LEVEL_HANDLING.md).

const mqttClient = require('../mqtt/client');
const { isEnabled } = require('../modules');
const levelHandler = require('../operating-level/handler');
const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { listWallboxes, setWallboxMode, cacheKey } = require('./boxes');
const { readWallboxValues, parseNumber, parseBool } = require('./aggregation');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const { readBatterieData, loadBatterieConfig } = require('../batterie/config');
const { listPvPlants } = require('../photovoltaik/plants');
const { readPhotovoltaikValues } = require('../photovoltaik/aggregation');
const { planCharge, decideWallboxAction, predictNextChargeStart, FULL_SOC } = require('./planner');
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
      lastBrokerStatus: null, manualFull: false, manualOff: false, manualOffDay: '',
      chargeStartedAt: null, restartUntil: 0, restartAttempts: 0,
      nextChargeAt: null, nextChargeHour: null,
    };
    state.set(id, s);
  }
  return s;
}

// Broker-bestätigter Schaltzustand einer Box: 'on' | 'off' | null (kein Wert).
// Quelle ist das Status-Topic bzw. – falls nicht gesetzt – das Steuer-Topic.
function readBrokerStatus(cache, box) {
  const entry = cache.get(cacheKey(box.id, 'status'));
  if (!entry || entry.value == null || entry.value === '') return null;
  return parseBool(entry.value) ? 'on' : 'off';
}

function sendCommand(topic, on) {
  if (topic) mqttClient.publish(topic, on ? '1' : '0');
}
function sendSetpoint(topic, watt) {
  if (topic && watt != null) mqttClient.publish(topic, String(Math.round(watt)));
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
function houseSurplusWatt(strom, battery, batteryMinSoc) {
  const netzbezug = parseNumber(strom.netzbezugPower); // positiv = Bezug
  let surplus = netzbezug != null ? Math.max(0, -netzbezug) : 0;
  const battPower = parseNumber(battery.power);        // positiv = laden
  const soc = parseNumber(battery.soc);
  const minSoc = parseNumber(battery.minSoc) ?? batteryMinSoc;
  if (battPower != null && battPower > 0 && soc != null && minSoc != null && soc > minSoc) {
    surplus += battPower;
  }
  return surplus;
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
  const surplusW = houseSurplusWatt(strom, battery, batterieConfig.minSoc);

  // Live-PV-Gesamtleistung (für die Freigabe nach manuellem Ausschalten).
  let pvPowerW = null;
  try {
    const pv = await readPhotovoltaikValues(db, cache, await listPvPlants(db));
    pvPowerW = pv.totals.current;
  } catch (_) {}

  // Prognose einmalig (cache-only); für die vorausschauende Bewertung verfügbar.
  const prognosis = await computePrognosis(db, cache, { allowFetch: false }).catch(() => null);
  const prognosisSurplusKwh = prognosis && prognosis.simulation && prognosis.simulation.days &&
    prognosis.simulation.days[0] ? Number(prognosis.simulation.days[0].surplusKwh) : null;
  const surplusSeries = prognosis ? buildSurplusSeries(prognosis.forecast, prognosis.model, calendar, now) : [];
  const forecastPlanById = new Map(
    (((prognosis || {}).model || {}).wallboxModel?.boxes || [])
      .map((plannedBox) => [Number(plannedBox.id), plannedBox.nextCharge])
  );

  const values = await readWallboxValues(db, cache, boxes);
  const valueById = new Map(values.map((v) => [v.id, v]));
  const seen = new Set();

  for (const box of boxes) {
    const s = boxState(box.id);
    const live = valueById.get(box.id) || {};
    const id = consumerId(box);
    seen.add(id);

    const ctx = {
      soc: live.soc,
      plugged: live.plugged,
      surplusW: surplusW + (live.powerW || 0), // eigene Ladeleistung als verfügbar zurückrechnen
      hour: calendar.hours,
      weekday: weekdayMonZero(calendar.dateKey),
      tomorrowWeekday: tomorrowWeekdayMonZero(calendar.dateKey),
      prognosisSurplusKwh,
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
      brokerStatus: readBrokerStatus(cache, box),
      powerW: live.powerW,
      pvPowerW,
      soc: live.soc,
      plugged: live.plugged,
      todayKey: calendar.dateKey,
      levelAllows: levelHandler.isAllowed(plan.priority),
      now,
    });

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
        sendCommand(box.commandTopic, decision.on);
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
  sendCommand(box.commandTopic, false);
  const s = boxState(box.id);
  s.output = 'off';
  s.changedAt = Date.now();
  s.setpointW = null;
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

function runNow(db) {
  const run = _tickChain.then(() => tick(db));
  _tickChain = run.catch(() => {});
  return run;
}

function init(db) {
  if (_timer) return;
  _timer = setInterval(() => runNow(db).catch(() => {}), 30000);
  runNow(db).catch(() => {});
}

module.exports = { init, runNow, tick, applyModeChange, getNextCharge, houseSurplusWatt };
