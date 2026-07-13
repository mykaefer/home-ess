'use strict';

// Lademodus-Logik je Wallbox. Bewusst als (weitgehend) reine Funktion gehalten,
// damit sie ohne MQTT/DB getestet werden kann. Das Betriebslevel-Gate, die
// Mindesthaltedauer und das eigentliche Schalten liegen in automation.js.
//
// Modi: 1 = Privat, 2 = Beruflich, 3 = Immer voll. Jeder Modus liefert die für ihn
// konfigurierte Priorität an den Betriebslevel-Handler.

const FULL_SOC = 99;          // ab hier gilt das Fahrzeug als voll
const SURPLUS_ON_W = 1400;    // Einschaltschwelle für reinen Überschussbetrieb (ohne Soll-Topic)
const MIN_CHARGE_W = 300;     // darunter lohnt Laden nicht
const BUSINESS_FORCE_HOUR = 18; // ab dieser Stunde Garantieladung vor einem Arbeitstag
const BUSINESS_READY_HOUR = 6;
const BUSINESS_START_BUFFER_HOURS = 0.5;
const CHARGE_EFFICIENCY = 0.9;
const HOUSE_BATTERY_RESERVE_MARGIN_PERCENT = 5;
const FORECAST_ENERGY_EPSILON_KWH = 0.05;
const HOUSE_BATTERY_FULL_SOC_THRESHOLD = 95; // ab hier gilt der Hausakku als praktisch voll

// Sonderfälle (decideWallboxAction):
const SETTLE_MS = 8000;          // nach eigener Schaltung kurz nicht auf „manuell" prüfen
const RESTART_OFF_MS = 60 * 1000; // 1 Minute aus zum Neustart eines hängenden Ladevorgangs
const STALL_EXPECT_MIN_W = 1400; // Stall nur prüfen, wenn substanzielle Ladung erwartet wird
const MAX_RESTART_ATTEMPTS = 3;  // danach nicht weiter takten (z. B. wirklich kein Fahrzeug)

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function priorityForMode(box) {
  if (box.mode === 2) return box.priorityBusiness;
  if (box.mode === 3) return box.priorityFull;
  return box.priorityPrivate;
}

function isFull(soc) {
  return soc != null && soc >= FULL_SOC;
}

function isBusinessDay(box, weekday) {
  return Array.isArray(box.businessDays) && box.businessDays.includes(weekday);
}

// Überschussbetrieb: mit Soll-Topic fein modulieren, sonst An/Aus an der Schwelle.
function surplusPlan(box, surplusW) {
  const available = Math.max(0, surplusW == null ? 0 : surplusW);
  if (box.setpointTopic) {
    const setpointW = clamp(available, 0, box.maxPowerW || available);
    return { desiredOn: setpointW >= MIN_CHARGE_W, setpointW };
  }
  // Ohne Leistungs-Sollwert kann nur binär geschaltet werden. Dann erst starten,
  // wenn der Überschuss die feste Wallboxleistung deckt; andernfalls würde die
  // Differenz ungewollt aus Hausakku oder Netz kommen.
  const binaryThresholdW = Math.max(SURPLUS_ON_W, Number(box.maxPowerW) || 0);
  return { desiredOn: available >= binaryThresholdW, setpointW: null };
}

// Pflichtladung mit voller Leistung (Mindest-Ladestand, Immer-voll, Garantie).
function fullPowerPlan(box) {
  return { desiredOn: true, setpointW: box.setpointTopic ? (box.maxPowerW || null) : null };
}

// Privatregel: bis Mindest-Ladestand immer laden, darüber nur Überschuss.
function privatePlan(box, ctx) {
  if (ctx.soc != null && ctx.soc < box.minChargePercent) {
    return { ...fullPowerPlan(box), reason: `Privat: unter Mindest-Ladestand (${box.minChargePercent} %)` };
  }
  if (isFull(ctx.soc)) return { desiredOn: false, setpointW: null, reason: 'Privat: Fahrzeug voll' };

  const liveSurplus = surplusPlan(box, ctx.surplusW);
  const houseSoc = Number(ctx.houseBatterySoc);
  const houseMinSoc = Number(ctx.houseBatteryMinSoc);
  if (Number.isFinite(houseSoc) && Number.isFinite(houseMinSoc) &&
      houseSoc <= houseMinSoc + HOUSE_BATTERY_RESERVE_MARGIN_PERCENT) {
    return { desiredOn: false, setpointW: null,
      reason: 'Privat: Hausakku nahe Mindest-SoC' };
  }
  // Live-Überschuss ist eingetretene Realität und hat Vorrang vor dem
  // vorausschauenden Ladeplan. Die Prognose darf einen Start vorbereiten, aber
  // keine gerade gedeckte Überschussladung wieder ausschalten.
  if (liveSurplus.desiredOn) {
    return { ...liveSurplus, reason: 'Privat: Live-Überschuss' };
  }
  if (ctx.prognosisAvailable === false) {
    return { desiredOn: false, setpointW: null,
      reason: 'Privat: wartet auf vollständige Tagesprognose' };
  }
  const forecastOverflow = Number(ctx.prognosisOverflowKwh);
  if (ctx.prognosisOverflowKwh != null && Number.isFinite(forecastOverflow) &&
      forecastOverflow <= FORECAST_ENERGY_EPSILON_KWH) {
    return { desiredOn: false, setpointW: null,
      reason: 'Privat: Prognose ohne nicht speicherbaren Überschuss' };
  }
  return { ...liveSurplus,
    reason: 'Privat: nur Überschuss' };
}

// Mindest-Ladestand beruflich (Ziel der Garantieladung). Default 100 = das Auto
// wird für Arbeitstage voll bereitgestellt; der wirksame Zielwert ist auf
// FULL_SOC gedeckelt, damit „100" und „voll" identisch bleiben.
function businessTargetSoc(box) {
  const percent = Number(box.minChargeBusinessPercent);
  const min = Number.isFinite(percent) ? clamp(percent, 0, 100) : 100;
  return Math.min(min, FULL_SOC);
}

function businessEndHour(box) {
  const hour = Number(box.businessEndHour);
  return Number.isFinite(hour) ? clamp(hour, 0, 23) : 18;
}

// Beruflichregel: bis zum Mindest-Ladestand beruflich garantiert bereitstellen —
// vorbereitend (Vorabend/Nacht) rechtzeitig vor 06:00, AN einem Arbeitstag bei
// Unterschreitung sofort. Oberhalb des Mindest-Ladestands gilt die Privatregel
// (nur Überschuss). Folgt auf einen Arbeitstag ein freier Tag, gilt ab der
// einstellbaren Uhrzeit nur noch die Privatregel.
function businessPlan(box, ctx) {
  const hour = Number(ctx.hour) + (Number(ctx.minute) || 0) / 60;
  const workToday = isBusinessDay(box, ctx.weekday);
  const workTomorrow = isBusinessDay(box, ctx.tomorrowWeekday);
  const targetSoc = businessTargetSoc(box);

  // Arbeitstag vor einem freien Tag: ab der einstellbaren Uhrzeit nur noch Privat.
  if (workToday && !workTomorrow && hour >= businessEndHour(box)) {
    return { ...privatePlan(box, ctx), reason: 'Beruflich: Feierabend vor freiem Tag → Privatregel' };
  }

  // AN einem Arbeitstag unter dem Mindest-Ladestand: sofort nachladen, nicht auf
  // die vorbereitende Planung für den nächsten Tag warten.
  if (workToday && hour >= BUSINESS_READY_HOUR && ctx.soc != null && ctx.soc < targetSoc) {
    return { ...fullPowerPlan(box),
      reason: `Beruflich: unter Mindest-Ladestand (${targetSoc} %) → Sofortladung` };
  }

  const todayDeadline = workToday && hour < BUSINESS_READY_HOUR;
  if (!todayDeadline && !workTomorrow) {
    return { ...privatePlan(box, ctx), reason: 'Beruflich: freier Tag → Privatregel' };
  }
  if (isFull(ctx.soc)) return { desiredOn: false, setpointW: null, reason: 'Beruflich: Fahrzeug voll' };

  // Mindest-Ladestand erreicht: darüber wie Privat nur Überschuss verwenden.
  if (ctx.soc != null && ctx.soc >= targetSoc) {
    const flexible = privatePlan(box, ctx);
    return { ...flexible, reason: `Beruflich: über Mindest-Ladestand → ${flexible.reason}` };
  }

  const hoursUntilReady = todayDeadline
    ? BUSINESS_READY_HOUR - hour
    : 24 - hour + BUSINESS_READY_HOUR;
  const capacity = Math.max(0, Number(box.batteryCapacityKwh) || 0);
  const powerKw = Math.max(0, Number(box.maxPowerW) || 0) / 1000;
  const soc = ctx.soc == null ? 0 : clamp(Number(ctx.soc) || 0, 0, FULL_SOC);
  const remainingKwh = capacity * Math.max(0, targetSoc - soc) / 100;
  const requiredHours = powerKw > 0
    ? remainingKwh / (powerKw * CHARGE_EFFICIENCY)
    : Math.max(0, hoursUntilReady - BUSINESS_FORCE_HOUR);
  if (hoursUntilReady <= requiredHours + BUSINESS_START_BUFFER_HOURS) {
    return { ...fullPowerPlan(box),
      reason: `Beruflich: Garantieladung (${requiredHours.toFixed(1)} h Restladezeit)` };
  }
  const flexible = privatePlan(box, ctx);
  if (flexible.desiredOn) return { ...flexible, reason: 'Beruflich: Überschuss vor Garantieladung' };
  return { desiredOn: false, setpointW: null,
    reason: `Beruflich: wartet bis spätestens ${Math.max(0, hoursUntilReady - requiredHours - BUSINESS_START_BUFFER_HOURS).toFixed(1)} h vor Ladebeginn` };
}

// Immer-voll: Ladegerät bleibt aktiv; allein die Priorität darf es sperren.
function fullModePlan(box) {
  return { ...fullPowerPlan(box), reason: 'Immer voll' };
}

// Hauptfunktion. ctx: { soc, plugged, surplusW, hour, weekday, tomorrowWeekday,
// prognosisAvailable, prognosisOverflowKwh, houseBatterySoc,
// houseBatteryMinSoc }. Liefert
// { desiredOn, setpointW, priority, reason }.
//
// Hinweis: Das „angesteckt"-Signal wird hier bewusst NICHT als Sperre verwendet.
// Es kommt per Mobilfunk vom Fahrzeug und kann veraltet/falsch-negativ sein – wenn
// der Plan laden möchte, wird eingeschaltet, auch wenn das Auto scheinbar nicht
// angesteckt ist. Ein tatsächlich fehlendes Fahrzeug fängt die Stall-Erkennung ab.
function planCharge(box, ctx = {}) {
  const priority = priorityForMode(box);
  let plan;
  if (box.mode === 3) plan = fullModePlan(box, ctx);
  else if (box.mode === 2) plan = businessPlan(box, ctx);
  else plan = privatePlan(box, ctx);
  return { priority, ...plan };
}

// Sonderfälle über dem Basisplan. Mutiert `state` (in-memory je Box) und liefert die
// effektiv zu schaltende Aktion. Testbar ohne MQTT/DB.
//
// state: { output:'on'|'off'|null, changedAt, lastSyncValue,
//          syncInitialized, expectedSyncValue, syncRebaselineUntil, ownSyncUntil, manualFull,
//          manualFullSawCharging, manualOff, manualOffDay, chargeStartedAt,
//          restartUntil, restartAttempts }
// ctx:   { plan, syncStatus:'on'|'off'|null, powerW, pvPowerW,
//          selfConsumptionW, houseBatterySoc, houseBatteryMinSoc, soc, todayKey,
//          levelAllows, now }
// `syncStatus` ist der am Steuerung-Sync-Topic beobachtete An/Aus-Wert. Nur eine
// EXTERNE Änderung dort (nicht von homeESS selbst gespiegelt) ist ein Bedienwunsch.
// Rückgabe: { on, setpointW, priority, bypassHold, reason }
function decideWallboxAction(box, state, ctx) {
  const { plan } = ctx;
  const priority = plan.priority;
  const now = ctx.now;
  const settleOk = !state.changedAt || (now - state.changedAt) >= SETTLE_MS;

  // Reconnect-Fenster: Nach einem MQTT-Wiederverbindungsaufbau spielt der Broker
  // alle retained-Werte erneut ein – auch den des Steuerung-Sync-Topics, u. U. mit
  // einem abweichenden Wert. Solange das Fenster offen ist, wird jeder Sync-Wert nur
  // als Ausgangszustand übernommen und NIE als Nutzerschaltung gewertet (Regel 3:
  // ein Reconnect/Refresh ändert den Schaltmodus nicht).
  const rebaselining = state.syncRebaselineUntil != null && now < state.syncRebaselineUntil;
  if (state.syncRebaselineUntil != null && now >= state.syncRebaselineUntil) {
    state.syncRebaselineUntil = null;
  }
  const ownSyncWindow = state.ownSyncUntil != null && now < state.ownSyncUntil;
  if (state.ownSyncUntil != null && now >= state.ownSyncUntil) {
    state.ownSyncUntil = null;
  }

  // Den ersten Sync-Wert nach einem Prozessstart nur als Ausgangszustand übernehmen.
  // Andernfalls würde eine bereits laufende Ladung fälschlich als manuelles
  // Einschalten gelten. Entspricht der Sync-Wert exakt dem zuletzt von homeESS
  // gespiegelten Wert, ist das nur unser eigener Readback und kein Nutzerwunsch.
  const ownReadback = ctx.syncStatus && state.expectedSyncValue === ctx.syncStatus;
  if (ownReadback) {
    state.expectedSyncValue = null;
    state.syncInitialized = true;
    state.lastSyncValue = ctx.syncStatus;
    if (state.output == null) state.output = ctx.syncStatus;
  } else if (ctx.syncStatus && ownSyncWindow) {
    // Manche Wallboxen nutzen dasselbe Topic gleichzeitig als Steuerung und als
    // Aktiv-Status. Nach einem homeESS-Schaltbefehl kann deshalb ein Folge-Status
    // (z. B. "off", weil kein Fahrzeug angesteckt ist) eintreffen. Auch wenn der
    // Wert nicht dem geschriebenen Befehl entspricht, ist das kein Nutzerwunsch.
    state.syncInitialized = true;
    state.lastSyncValue = ctx.syncStatus;
    if (state.output == null) state.output = ctx.syncStatus;
  } else if (ctx.syncStatus && (!state.syncInitialized || rebaselining)) {
    // Erstwert nach (Wieder-)Verbindung: nur Ausgangszustand, keine Bedienerkennung.
    state.syncInitialized = true;
    state.lastSyncValue = ctx.syncStatus;
    if (state.output == null) state.output = ctx.syncStatus;
  // (2)/(3) Externe Schaltung am Steuerung-Sync-Topic erkennen: ein späterer
  // Wertwechsel, den homeESS nicht selbst gespiegelt hat.
  } else if (settleOk && ctx.syncStatus && ctx.syncStatus !== state.lastSyncValue) {
    const autoWantsOn = plan.desiredOn === true && ctx.levelAllows === true;
    if (ctx.syncStatus === 'on' && state.output !== 'on' && !autoWantsOn) {
      // Extern EIN → einmalig voll laden, sofern die Modus-Priorität es zulässt.
      if (ctx.levelAllows) state.manualFull = true;
      state.manualFullSawCharging = false;
      state.manualOff = false;
      state.manualOffDay = '';
    } else if (ctx.syncStatus === 'off' && state.output === 'on' && autoWantsOn) {
      // Extern AUS → aus bleiben bis Folgetag, PV erstmals > Wallbox-Leistung.
      state.manualOff = true;
      state.manualOffDay = ctx.todayKey;
      state.manualFull = false;
      state.manualFullSawCharging = false;
      state.restartUntil = 0;
      state.restartAttempts = 0;
    }
  }
  if (ctx.syncStatus) state.lastSyncValue = ctx.syncStatus;

  let on = plan.desiredOn;
  let setpointW = plan.setpointW;
  let reason = plan.reason;

  // (2) Einmalige Volladung nach manuellem Einschalten.
  if (state.manualFull) {
    if (ctx.powerW != null && ctx.powerW >= box.stallPowerW) {
      state.manualFullSawCharging = true;
    }
    // „angesteckt = false" beendet die Volladung bewusst NICHT: manche Fahrzeuge
    // melden erst dann angesteckt, wenn die Ladung freigegeben ist. Ein echtes
    // Abziehen fängt finishedByPower ab (Leistung fällt nach gesehener Ladung weg).
    const finishedByPower = state.manualFullSawCharging && box.powerTopic &&
      ctx.powerW != null && ctx.powerW < box.stallPowerW;
    if (finishedByPower) {
      state.manualFull = false;
      state.manualFullSawCharging = false;
    } else {
      on = true;
      setpointW = box.setpointTopic ? (box.maxPowerW || null) : null;
      reason = 'Manuell eingeschaltet → einmalige Volladung';
    }
  }

  // (3) Sperre nach manuellem Ausschalten bis zum Folgetag. Erst wenn PV den
  // Eigenverbrauch plus feste Wallboxleistung deckt und der Hausakku genügend
  // Abstand zum Mindest-SoC hat, fällt die Übersteuerung zurück auf Automatik.
  if (state.manualOff) {
    const houseSoc = Number(ctx.houseBatterySoc);
    const houseMinSoc = Number(ctx.houseBatteryMinSoc);
    const batteryReady = Number.isFinite(houseSoc) && Number.isFinite(houseMinSoc) &&
      houseSoc > houseMinSoc + HOUSE_BATTERY_RESERVE_MARGIN_PERCENT;
    const pvThreshold = Math.max(0, Number(ctx.selfConsumptionW) || 0) +
      Math.max(0, Number(box.maxPowerW) || 0);
    const released = !!state.manualOffDay && ctx.todayKey !== state.manualOffDay &&
      ctx.pvPowerW != null && ctx.pvPowerW > pvThreshold && batteryReady;
    if (released) {
      state.manualOff = false;
      state.manualOffDay = '';
    } else {
      on = false;
      setpointW = null;
      reason = 'Manuell ausgeschaltet → wartet auf Folgetag, PV-Deckung und Hausakku-Reserve';
    }
  }

  // Betriebslevel-Gate.
  on = on && ctx.levelAllows;

  // Ladestart-Zeitpunkt für die Stall-Messung führen.
  if (on) {
    if (state.chargeStartedAt == null) state.chargeStartedAt = now;
  } else {
    state.chargeStartedAt = null;
    state.restartAttempts = 0;
    state.restartUntil = 0;
  }

  // (1) Ladestart-Neustart NUR bei tatsächlich eingestecktem Fahrzeug. Das
  // „angesteckt"-Signal sperrt zwar das Laden nicht (Mobilfunk, evtl. falsch-negativ),
  // ein Aus/Ein-Reconnect darf aber nicht ins Leere takten, solange kein Auto bestätigt
  // angesteckt ist. Ohne bestätigtes Anstecken: kein Neustart-Zyklus.
  // Ein volles Fahrzeug beendet die Leistungsaufnahme selbst. Das ist kein Stall:
  // keinen Neustart auslösen und einen bereits laufenden Zyklus sofort verwerfen.
  if (ctx.plugged === true && !isFull(ctx.soc)) {
    // Laufendes Neustart-Fenster: für 1 Minute zwingend aus.
    if (state.restartUntil && now < state.restartUntil) {
      return { on: false, setpointW: null, priority, bypassHold: true,
        reason: 'Ladestart hängt → 1 Minute Neustart (aus)' };
    }
    if (state.restartUntil && now >= state.restartUntil) {
      state.restartUntil = 0;
      state.chargeStartedAt = now; // frisches Stall-Fenster nach dem Wiedereinschalten
      return { on: true, setpointW: on ? setpointW : null, priority, bypassHold: true,
        reason: 'Neustart: wieder einschalten' };
    }

    // Stall-Erkennung: Ladebefehl steht, es wird substanzielle Leistung erwartet,
    // aber die Ist-Leistung hängt nach der Vorgabezeit im Leerlauf-Bereich.
    if (on && box.powerTopic && ctx.powerW != null) {
      const expectW = box.setpointTopic ? (setpointW || 0) : (box.maxPowerW || 0);
      const stalled = expectW >= STALL_EXPECT_MIN_W &&
        ctx.powerW < box.stallPowerW &&
        state.chargeStartedAt != null &&
        (now - state.chargeStartedAt) >= (box.stallTimeoutSeconds || 0) * 1000;
      if (stalled && (state.restartAttempts || 0) < MAX_RESTART_ATTEMPTS) {
        state.restartUntil = now + RESTART_OFF_MS;
        state.restartAttempts = (state.restartAttempts || 0) + 1;
        return { on: false, setpointW: null, priority, bypassHold: true,
          reason: 'Ladestart hängt → 1 Minute aus zum Neustart' };
      }
      if (ctx.powerW >= box.stallPowerW) state.restartAttempts = 0; // Ladung läuft gesund
    }
  } else {
    // Nicht (bestätigt) angesteckt oder bereits voll: kein Neustart-Zyklus.
    state.restartUntil = 0;
    state.restartAttempts = 0;
  }

  return { on, setpointW: on ? setpointW : null, priority, bypassHold: false, reason };
}

// Voraussichtlicher nächster Ladebeginn, wenn gerade NICHT geladen wird.
// `series` ist eine aufsteigende Liste künftiger Stunden-Slots
//   { startMs, dateKey, dayIndex, hour, pvW, surplusW }
// (surplusW = erwartete PV-Leistung minus erwartete Hauslast in dieser Stunde).
// opts: { series, nowMs, isCharging, full, weekdayMon, tomorrowWeekdayMon }
// Rückgabe: { at: ms, hour } oder null (lädt gerade / voll / nichts absehbar).
function predictNextChargeStart(box, state, opts = {}) {
  const { series, nowMs, isCharging, full, weekdayMon, tomorrowWeekdayMon } = opts;
  if (isCharging || full) return null;
  if (!Array.isArray(series) || !series.length) return null;

  // Nach manuellem Ausschalten erst am Folgetag, sobald der prognostizierte
  // PV-Überschuss die Wallbox-Maximalleistung übersteigt. Die Hausakku-Reserve
  // wird zusätzlich live in decideWallboxAction geprüft.
  if (state.manualOff) {
    for (const slot of series) {
      if (slot.dateKey !== state.manualOffDay && slot.surplusW > (box.maxPowerW || 0)) {
        return { at: Math.max(nowMs, slot.startMs), hour: slot.hour };
      }
    }
    return null;
  }

  // Überschuss-Kandidat: erste Stunde mit ausreichend erwartetem Überschuss.
  const startThresholdW = box.setpointTopic
    ? MIN_CHARGE_W
    : Math.max(SURPLUS_ON_W, Number(box.maxPowerW) || 0);
  let surplus = null;
  for (const slot of series) {
    if (slot.surplusW >= startThresholdW) { surplus = slot; break; }
  }

  // Beruflich: Garantieladung am Vorabend eines Arbeitstags (BUSINESS_FORCE_HOUR).
  let business = null;
  if (box.mode === 2 && (isBusinessDay(box, weekdayMon) || isBusinessDay(box, tomorrowWeekdayMon))) {
    business = series.find((s) => s.dayIndex === 0 && s.hour === BUSINESS_FORCE_HOUR) || null;
  }

  const candidates = [surplus, business].filter(Boolean);
  if (!candidates.length) return null;
  const chosen = candidates.reduce((a, b) => (b.startMs < a.startMs ? b : a));
  return { at: Math.max(nowMs, chosen.startMs), hour: chosen.hour };
}

module.exports = {
  planCharge, decideWallboxAction, predictNextChargeStart, priorityForMode, isBusinessDay,
  businessTargetSoc, businessEndHour,
  FULL_SOC, SURPLUS_ON_W, MIN_CHARGE_W, BUSINESS_FORCE_HOUR,
  BUSINESS_READY_HOUR, BUSINESS_START_BUFFER_HOURS, CHARGE_EFFICIENCY,
  HOUSE_BATTERY_RESERVE_MARGIN_PERCENT, FORECAST_ENERGY_EPSILON_KWH,
  HOUSE_BATTERY_FULL_SOC_THRESHOLD,
  SETTLE_MS, RESTART_OFF_MS, STALL_EXPECT_MIN_W, MAX_RESTART_ATTEMPTS,
};
