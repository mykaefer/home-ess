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
  return { desiredOn: available >= SURPLUS_ON_W, setpointW: null };
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
  return { ...surplusPlan(box, ctx.surplusW), reason: 'Privat: nur Überschuss' };
}

// Beruflichregel: an Arbeitstagen (bzw. am Vorabend) voll bereitstellen. Tagsüber
// bevorzugt Überschuss, abends Garantieladung, sonst Rückfall auf Privat.
function businessPlan(box, ctx) {
  const beforeBusinessDay = isBusinessDay(box, ctx.weekday) || isBusinessDay(box, ctx.tomorrowWeekday);
  if (!beforeBusinessDay) {
    return { ...privatePlan(box, ctx), reason: 'Beruflich: freier Tag → Privatregel' };
  }
  if (isFull(ctx.soc)) return { desiredOn: false, setpointW: null, reason: 'Beruflich: Fahrzeug voll' };
  // Abends/nachts Garantieladung, damit das Auto am Arbeitstag voll bereitsteht —
  // lieber etwas Reserve als zu knapp.
  if (ctx.hour >= BUSINESS_FORCE_HOUR) {
    return { ...fullPowerPlan(box), reason: 'Beruflich: Garantieladung vor Arbeitstag' };
  }
  // Tagsüber bevorzugt Überschuss laden, statt nachts den Hausakku zu leeren.
  const surplus = surplusPlan(box, ctx.surplusW);
  if (surplus.desiredOn) return { ...surplus, reason: 'Beruflich: Überschuss tagsüber' };
  return { desiredOn: false, setpointW: null, reason: 'Beruflich: warte auf Überschuss/Abend' };
}

// Immer-voll: laden bis voll, sonst aus.
function fullModePlan(box, ctx) {
  if (isFull(ctx.soc)) return { desiredOn: false, setpointW: null, reason: 'Immer voll: Fahrzeug voll' };
  return { ...fullPowerPlan(box), reason: 'Immer voll' };
}

// Hauptfunktion. ctx: { soc, plugged, surplusW, hour, weekday, tomorrowWeekday,
// prognosisSurplusKwh }. Liefert { desiredOn, setpointW, priority, reason }.
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
// state: { output:'on'|'off'|null, changedAt, lastBrokerStatus, manualFull, manualOff,
//          manualOffDay, chargeStartedAt, restartUntil, restartAttempts }
// ctx:   { plan, brokerStatus:'on'|'off'|null, powerW, pvPowerW, soc, todayKey,
//          levelAllows, now }
// Rückgabe: { on, setpointW, priority, bypassHold, reason }
function decideWallboxAction(box, state, ctx) {
  const { plan } = ctx;
  const priority = plan.priority;
  const now = ctx.now;
  const settleOk = !state.changedAt || (now - state.changedAt) >= SETTLE_MS;

  // (2)/(3) Manuelle Schaltung am Broker erkennen: ein Statuswechsel, den wir nicht
  // selbst kommandiert haben (Broker-Status weicht vom zuletzt gesendeten Befehl ab).
  if (settleOk && ctx.brokerStatus && ctx.brokerStatus !== state.lastBrokerStatus) {
    if (ctx.brokerStatus === 'on' && state.output !== 'on') {
      // Manuell EIN → einmalig voll laden, sofern die Modus-Priorität es zulässt.
      if (ctx.levelAllows) state.manualFull = true;
      state.manualOff = false;
      state.manualOffDay = '';
    } else if (ctx.brokerStatus === 'off' && state.output === 'on') {
      // Manuell AUS → aus bleiben bis Folgetag, PV erstmals > Wallbox-Leistung.
      state.manualOff = true;
      state.manualOffDay = ctx.todayKey;
      state.manualFull = false;
      state.restartUntil = 0;
      state.restartAttempts = 0;
    }
  }
  if (ctx.brokerStatus) state.lastBrokerStatus = ctx.brokerStatus;

  let on = plan.desiredOn;
  let setpointW = plan.setpointW;
  let reason = plan.reason;

  // (2) Einmalige Volladung nach manuellem Einschalten.
  if (state.manualFull) {
    if (ctx.soc != null && ctx.soc >= FULL_SOC) {
      state.manualFull = false;
    } else {
      on = true;
      setpointW = box.setpointTopic ? (box.maxPowerW || null) : null;
      reason = 'Manuell eingeschaltet → einmalige Volladung';
    }
  }

  // (3) Sperre nach manuellem Ausschalten bis Folgetag + PV > Wallbox-Leistung.
  if (state.manualOff) {
    const released = ctx.todayKey !== state.manualOffDay &&
      ctx.pvPowerW != null && ctx.pvPowerW > (box.maxPowerW || 0);
    if (released) {
      state.manualOff = false;
      state.manualOffDay = '';
    } else {
      on = false;
      setpointW = null;
      reason = 'Manuell ausgeschaltet → wartet auf Folgetag mit PV > Wallbox-Leistung';
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
  if (ctx.plugged === true) {
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
    // Nicht (bestätigt) angesteckt: kein laufender Neustart-Zyklus.
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

  // Nach manuellem Ausschalten erst am Folgetag, sobald die PV-Leistung die
  // Wallbox-Maximalleistung übersteigt (siehe decideWallboxAction).
  if (state.manualOff) {
    for (const slot of series) {
      if (slot.dateKey !== state.manualOffDay && slot.pvW > (box.maxPowerW || 0)) {
        return { at: Math.max(nowMs, slot.startMs), hour: slot.hour };
      }
    }
    return null;
  }

  // Überschuss-Kandidat: erste Stunde mit ausreichend erwartetem Überschuss.
  const startThresholdW = box.setpointTopic ? MIN_CHARGE_W : SURPLUS_ON_W;
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
  FULL_SOC, SURPLUS_ON_W, MIN_CHARGE_W, BUSINESS_FORCE_HOUR,
  SETTLE_MS, RESTART_OFF_MS, STALL_EXPECT_MIN_W, MAX_RESTART_ATTEMPTS,
};
