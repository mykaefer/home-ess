'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  planCharge, priorityForMode, decideWallboxAction, predictNextChargeStart,
  RESTART_OFF_MS, SURPLUS_ON_W,
} = require('../src/wallbox/planner');
const { houseSurplusWatt } = require('../src/wallbox/automation');
const {
  updateWallboxCounter, updateWallboxSummary, loadSummaryState, loadCounterState,
  estimateSoc, recordWallboxHistory,
} = require('../src/wallbox/aggregation');
const { cacheKey } = require('../src/wallbox/boxes');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE wallbox_counter_state (
    wallbox_id INTEGER PRIMARY KEY, last_raw_value REAL, day_total REAL NOT NULL DEFAULT 0,
    last_day_key TEXT NOT NULL DEFAULT '', plugged_energy_start REAL, last_power_ts INTEGER)`);
  await dbRun(db, `CREATE TABLE wallbox_summary_state (
    wallbox_id INTEGER PRIMARY KEY, week_offset REAL NOT NULL DEFAULT 0, month_offset REAL NOT NULL DEFAULT 0,
    year_offset REAL NOT NULL DEFAULT 0, previous_year_total REAL NOT NULL DEFAULT 0,
    last_rollover_date TEXT NOT NULL DEFAULT '', week_key TEXT NOT NULL DEFAULT '',
    month_key TEXT NOT NULL DEFAULT '', year_key TEXT NOT NULL DEFAULT '')`);
  await dbRun(db, `CREATE TABLE wallbox_daily_consumption (
    wallbox_id INTEGER, day_key TEXT, consumption_kwh REAL, completed INTEGER, updated_at INTEGER,
    PRIMARY KEY(wallbox_id, day_key))`);
  await dbRun(db, `CREATE TABLE wallbox_hourly_consumption (
    wallbox_id INTEGER, day_key TEXT, hour INTEGER, consumption_kwh REAL,
    PRIMARY KEY(wallbox_id, day_key, hour))`);
  return db;
}

function cal(dateKey, weekKey, monthKey, yearKey) {
  return { dateKey, weekKey, monthKey, yearKey };
}

test('Wallbox-Verbrauch wird je Box täglich und stündlich für die Prognose gespeichert', async () => {
  const db = await freshDb();
  const calendar = { ...cal('2026-06-30', '2026-W27', '2026-06', '2026'), hours: 8 };
  await recordWallboxHistory(db, { id: 7 }, calendar, { dayTotal: 3.5 }, 0.25, Date.now());
  const daily = await new Promise((resolve, reject) => db.get(
    'SELECT consumption_kwh FROM wallbox_daily_consumption WHERE wallbox_id = 7',
    (err, row) => err ? reject(err) : resolve(row)
  ));
  const hourly = await new Promise((resolve, reject) => db.get(
    'SELECT consumption_kwh FROM wallbox_hourly_consumption WHERE wallbox_id = 7 AND hour = 8',
    (err, row) => err ? reject(err) : resolve(row)
  ));
  assert.equal(daily.consumption_kwh, 3.5);
  assert.equal(hourly.consumption_kwh, 0.25);
  await new Promise((resolve) => db.close(resolve));
});

// ── Planner ─────────────────────────────────────────────────────────────────

test('Priorität folgt dem aktiven Lademodus', () => {
  const box = { mode: 1, priorityPrivate: 5, priorityBusiness: 3, priorityFull: 4 };
  assert.equal(priorityForMode({ ...box, mode: 1 }), 5);
  assert.equal(priorityForMode({ ...box, mode: 2 }), 3);
  assert.equal(priorityForMode({ ...box, mode: 3 }), 4);
});

test('Immer-voll lässt das Ladegerät bei erlaubter Priorität dauerhaft aktiv', () => {
  const box = { mode: 3, maxPowerW: 11000, priorityFull: 4, setpointTopic: 'x' };
  assert.equal(planCharge(box, { plugged: true, soc: 60 }).desiredOn, true);
  assert.equal(planCharge(box, { plugged: true, soc: 60 }).setpointW, 11000);
  assert.equal(planCharge(box, { plugged: true, soc: 100 }).desiredOn, true);
  // „angesteckt"-Signal sperrt nicht: bei scheinbar nicht angestecktem Auto wird
  // dennoch geladen, wenn der Plan es will (Mobilfunk-Signal unzuverlässig).
  assert.equal(planCharge(box, { plugged: false, soc: 50 }).desiredOn, true);
});

test('Privat: unter Mindest-Ladestand volle Leistung, darüber nur Überschuss', () => {
  const box = { mode: 1, maxPowerW: 11000, minChargePercent: 30, priorityPrivate: 5, setpointTopic: 'x' };
  // unter Mindeststand → volle Leistung
  let p = planCharge(box, { plugged: true, soc: 20, surplusW: 0 });
  assert.equal(p.desiredOn, true);
  assert.equal(p.setpointW, 11000);
  // über Mindeststand → nur Überschuss, fein moduliert
  p = planCharge(box, { plugged: true, soc: 50, surplusW: 4000 });
  assert.equal(p.desiredOn, true);
  assert.equal(p.setpointW, 4000);
  // Überschuss über Maximalleistung wird gekappt
  p = planCharge(box, { plugged: true, soc: 50, surplusW: 20000 });
  assert.equal(p.setpointW, 11000);
  // voll → aus
  assert.equal(planCharge(box, { plugged: true, soc: 100, surplusW: 5000 }).desiredOn, false);
});

test('Privat ohne Soll-Topic schaltet an der Überschussschwelle', () => {
  const box = { mode: 1, maxPowerW: 3000, minChargePercent: 30, priorityPrivate: 5, setpointTopic: '' };
  assert.equal(planCharge(box, { plugged: true, soc: 50, surplusW: 500 }).desiredOn, false);
  assert.equal(planCharge(box, { plugged: true, soc: 50, surplusW: 2000 }).desiredOn, false);
  assert.equal(planCharge(box, { plugged: true, soc: 50, surplusW: 3000 }).desiredOn, true);
});

test('Privat lädt oberhalb Mindeststand nur bei nicht speicherbarem Prognose-Überschuss', () => {
  const box = { mode: 1, maxPowerW: 3000, minChargePercent: 40, priorityPrivate: 5, setpointTopic: '' };

  // Ein momentaner PV-Peak reicht nicht, wenn der Hausakku ihn noch aufnehmen kann.
  let p = planCharge(box, {
    plugged: true, soc: 51, surplusW: 2300,
    prognosisOverflowKwh: 0,
  });
  assert.equal(p.desiredOn, false);
  assert.match(p.reason, /nicht speicherbaren Überschuss/);

  // Unterhalb des Mindeststands bleibt die Pflichtladung von der Prognose unabhängig.
  p = planCharge(box, {
    plugged: true, soc: 35, surplusW: 0,
    prognosisOverflowKwh: 0,
  });
  assert.equal(p.desiredOn, true);

  // Nur bei prognostizierter freier Energie darf der Live-Überschuss laden.
  p = planCharge(box, {
    plugged: true, soc: 51, surplusW: 3000,
    prognosisOverflowKwh: 2.5,
  });
  assert.equal(p.desiredOn, true);
});

test('Privat übersteuert eine zu vorsichtige Prognose, wenn der Hausakku bereits voll ist und real eingespeist wird', () => {
  const box = { mode: 1, maxPowerW: 3000, minChargePercent: 40, priorityPrivate: 5, setpointTopic: '' };
  const p = planCharge(box, {
    plugged: true, soc: 52, surplusW: 3500, prognosisOverflowKwh: 0,
    houseBatterySoc: 97, houseBatteryMinSoc: 20,
  });
  assert.equal(p.desiredOn, true);
  assert.match(p.reason, /Hausakku voll/);
});

test('Privat lässt die Prognose-Bremse bei vollem Hausakku ohne ausreichenden Live-Überschuss bestehen', () => {
  const box = { mode: 1, maxPowerW: 3000, minChargePercent: 40, priorityPrivate: 5, setpointTopic: '' };
  // Akku voll, aber die Einspeisung deckt die feste Wallbox-Leistung noch nicht.
  const p = planCharge(box, {
    plugged: true, soc: 52, surplusW: 2000, prognosisOverflowKwh: 0,
    houseBatterySoc: 97, houseBatteryMinSoc: 20,
  });
  assert.equal(p.desiredOn, false);
  assert.match(p.reason, /nicht speicherbaren Überschuss/);
});

test('Privat wartet oberhalb Mindeststand nach Neustart auf die Prognose', () => {
  const box = { mode: 1, maxPowerW: 3000, minChargePercent: 40, priorityPrivate: 5, setpointTopic: '' };
  const p = planCharge(box, {
    plugged: true, soc: 52, surplusW: 2300, prognosisAvailable: false,
  });
  assert.equal(p.desiredOn, false);
  assert.match(p.reason, /wartet auf vollständige Tagesprognose/);
});

test('Privat schützt die Reserve des Hausakkus trotz prognostiziertem Überlauf', () => {
  const box = { mode: 1, maxPowerW: 3000, minChargePercent: 40, priorityPrivate: 5, setpointTopic: 'x' };
  const p = planCharge(box, {
    soc: 52, surplusW: 2300, prognosisOverflowKwh: 3,
    houseBatterySoc: 24, houseBatteryMinSoc: 20,
  });
  assert.equal(p.desiredOn, false);
  assert.match(p.reason, /Hausakku nahe Mindest-SoC/);
});

test('Beruflich: Garantieladung startet nach berechneter Restladezeit', () => {
  const box = {
    mode: 2, maxPowerW: 11000, minChargePercent: 30, priorityBusiness: 3,
    priorityPrivate: 5, businessDays: [0], setpointTopic: 'x', batteryCapacityKwh: 50,
  };
  // Montag 02:35 Uhr: knapp 30 kWh Restenergie benötigen rund drei Stunden bis 06:00.
  const p = planCharge(box, {
    plugged: true, soc: 40, surplusW: 0, hour: 2, minute: 35,
    weekday: 0, tomorrowWeekday: 1,
  });
  assert.equal(p.desiredOn, true);
  assert.equal(p.setpointW, 11000);
  assert.equal(p.priority, 3);
});

test('Beruflich wartet vor dem spätesten notwendigen Ladebeginn', () => {
  const box = {
    mode: 2, maxPowerW: 11000, batteryCapacityKwh: 50, minChargePercent: 30,
    priorityBusiness: 3, priorityPrivate: 5, businessDays: [0], setpointTopic: 'x',
  };
  const p = planCharge(box, {
    plugged: true, soc: 40, surplusW: 0, hour: 20, minute: 0,
    weekday: 6, tomorrowWeekday: 0, prognosisOverflowKwh: 0,
  });
  assert.equal(p.desiredOn, false);
});

test('Beruflich: freier Tag fällt auf die Privatregel zurück', () => {
  const box = {
    mode: 2, maxPowerW: 11000, minChargePercent: 30, priorityBusiness: 3,
    priorityPrivate: 5, businessDays: [0], setpointTopic: 'x',
  };
  // weekday 2 (Mi), tomorrow 3 (Do) – beide keine Arbeitstage → Privatregel:
  // unter Mindeststand volle Leistung.
  const p = planCharge(box, { plugged: true, soc: 20, surplusW: 0, hour: 20, weekday: 2, tomorrowWeekday: 3 });
  assert.equal(p.desiredOn, true);
  assert.equal(p.setpointW, 11000);
});

// ── Sonderfälle (decideWallboxAction) ───────────────────────────────────────

function freshState() {
  return {
    output: null, changedAt: 0, setpointW: null, lastBrokerStatus: null,
    brokerStatusInitialized: true, expectedBrokerStatus: null,
    manualFull: false, manualFullSawCharging: false,
    manualOff: false, manualOffDay: '',
    chargeStartedAt: null, restartUntil: 0, restartAttempts: 0,
  };
}

function baseDecideCtx(over = {}) {
  return {
    plan: { desiredOn: false, setpointW: null, priority: 3 },
    brokerStatus: null, powerW: null, pvPowerW: null, selfConsumptionW: 0,
    houseBatterySoc: 30, houseBatteryMinSoc: 20, soc: null, plugged: true,
    todayKey: '2026-06-30', levelAllows: true, now: 1_000_000,
    ...over,
  };
}

test('Erster Broker-Status nach Neustart löst keine manuelle Volladung aus', () => {
  const box = { id: 1, maxPowerW: 3000, setpointTopic: '' };
  const s = freshState();
  s.brokerStatusInitialized = false;
  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: false, setpointW: null, priority: 5,
      reason: 'Privat: nur Überschuss' },
    brokerStatus: 'on', soc: 51,
  }));

  assert.equal(s.lastBrokerStatus, 'on');
  assert.equal(s.brokerStatusInitialized, true);
  assert.equal(s.manualFull, false);
  assert.equal(d.on, false);
});

test('Erst eine spätere Broker-Wertänderung löst manuelles Vollladen aus', () => {
  const box = { id: 1, maxPowerW: 3000, setpointTopic: '' };
  const s = freshState();
  s.brokerStatusInitialized = false;

  decideWallboxAction(box, s, baseDecideCtx({ brokerStatus: 'off' }));
  assert.equal(s.manualFull, false);

  const d = decideWallboxAction(box, s, baseDecideCtx({
    brokerStatus: 'on', levelAllows: true, now: 1_030_000,
  }));
  assert.equal(s.manualFull, true);
  assert.equal(d.on, true);
});

test('Readback eines Automatikbefehls ist kein manueller Schaltwunsch', () => {
  const box = { id: 1, maxPowerW: 3000, setpointTopic: '' };
  const s = freshState();
  s.output = 'on';
  s.lastBrokerStatus = 'off';
  s.expectedBrokerStatus = 'on';

  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 5 },
    brokerStatus: 'on',
  }));

  assert.equal(s.expectedBrokerStatus, null);
  assert.equal(s.lastBrokerStatus, 'on');
  assert.equal(s.manualFull, false);
  assert.equal(d.on, true);
});

test('Manuell EIN am Broker löst einmalige Volladung aus (wenn Level es zulässt)', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: 'x' };
  const s = freshState();
  s.output = 'off'; s.lastBrokerStatus = 'off';
  // Plan würde nicht laden; Broker meldet plötzlich „on".
  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: false, setpointW: null, priority: 3 },
    brokerStatus: 'on', levelAllows: true,
  }));
  assert.equal(s.manualFull, true);
  assert.equal(d.on, true);
  assert.equal(d.setpointW, 11000);
});

test('Manuell EIN wird ignoriert, wenn die Modus-Priorität es nicht zulässt', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: 'x' };
  const s = freshState();
  s.output = 'off'; s.lastBrokerStatus = 'off';
  const d = decideWallboxAction(box, s, baseDecideCtx({ brokerStatus: 'on', levelAllows: false }));
  assert.equal(s.manualFull, false);
  assert.equal(d.on, false);
});

test('Prioritäts-Gate sperrt auch Immer-voll bei vollem Fahrzeug', () => {
  const box = { id: 1, mode: 3, maxPowerW: 3000, priorityFull: 4, setpointTopic: '' };
  const s = freshState();
  const plan = planCharge(box, { soc: 100 });
  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan, soc: 100, levelAllows: false,
  }));
  assert.equal(plan.desiredOn, true);
  assert.equal(d.on, false);
});

test('Manuell AUS sperrt bis Folgetag mit PV über Wallbox-Leistung', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: 'x' };
  const s = freshState();
  s.output = 'on'; s.lastBrokerStatus = 'on';
  // Broker meldet „off" obwohl wir „on" kommandiert hatten → manuell aus.
  let d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: 11000, priority: 3 },
    brokerStatus: 'off', todayKey: '2026-06-30',
  }));
  assert.equal(s.manualOff, true);
  assert.equal(d.on, false);

  // Gleicher Tag, viel PV → bleibt gesperrt.
  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: 11000, priority: 3 },
    brokerStatus: 'off', todayKey: '2026-06-30', pvPowerW: 15000,
  }));
  assert.equal(d.on, false);

  // Folgetag, PV unter Wallbox-Leistung → weiter gesperrt.
  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: 11000, priority: 3 },
    brokerStatus: 'off', todayKey: '2026-07-01', pvPowerW: 8000,
  }));
  assert.equal(d.on, false);

  // Folgetag, PV erstmals über Wallbox-Leistung → Sperre fällt, Plan greift wieder.
  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: 11000, priority: 3 },
    brokerStatus: 'off', todayKey: '2026-07-01', pvPowerW: 12000,
  }));
  assert.equal(s.manualOff, false);
  assert.equal(d.on, true);
});

test('Umschalter AUS kehrt erst bei PV-Deckung und Hausakku-Reserve am Folgetag zurück', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: '' };
  const s = freshState();
  s.manualOff = true;
  s.manualOffDay = '2026-06-30';

  let d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 },
    todayKey: '2026-07-01', pvPowerW: 15000, selfConsumptionW: 3000,
    houseBatterySoc: 24, houseBatteryMinSoc: 20,
  }));
  assert.equal(s.manualOff, true);
  assert.equal(d.on, false);

  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 },
    todayKey: '2026-07-01', pvPowerW: 15000, selfConsumptionW: 3000,
    houseBatterySoc: 30, houseBatteryMinSoc: 20,
  }));
  assert.equal(s.manualOff, false);
  assert.equal(d.on, true);
});

test('Manuelles Vollladen endet nach echter Ladeleistung beim Abfall unter Leerlaufschwelle', () => {
  const box = { id: 1, maxPowerW: 3000, setpointTopic: '', powerTopic: 'p', stallPowerW: 20 };
  const s = freshState();
  s.manualFull = true;

  let d = decideWallboxAction(box, s, baseDecideCtx({ powerW: 2300 }));
  assert.equal(s.manualFull, true);
  assert.equal(s.manualFullSawCharging, true);
  assert.equal(d.on, true);

  d = decideWallboxAction(box, s, baseDecideCtx({ powerW: 0, now: 1_030_000 }));
  assert.equal(s.manualFull, false);
  assert.equal(s.manualFullSawCharging, false);
  assert.equal(d.on, false);
});

test('Manuelles Vollladen endet beim Abziehen des Fahrzeugs', () => {
  const box = { id: 1, maxPowerW: 3000, setpointTopic: '', powerTopic: 'p', stallPowerW: 20 };
  const s = freshState();
  s.manualFull = true;
  const d = decideWallboxAction(box, s, baseDecideCtx({ plugged: false, powerW: 0 }));
  assert.equal(s.manualFull, false);
  assert.equal(d.on, false);
});

test('Stall-Erkennung schaltet nach Vorgabezeit für einen Neustart ab', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: '', powerTopic: 'p',
    stallTimeoutSeconds: 120, stallPowerW: 200 };
  const s = freshState();
  const t0 = 1_000_000;
  // Ladebefehl an, Leistung hängt im Leerlauf.
  let d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0,
  }));
  assert.equal(d.on, true); // noch innerhalb der Vorgabezeit

  // Nach 120 s immer noch Leerlauf → Neustart (aus).
  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0 + 121000,
  }));
  assert.equal(d.on, false);
  assert.equal(d.bypassHold, true);
  assert.ok(s.restartUntil > 0);

  // Innerhalb der Neustart-Minute weiter aus.
  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0 + 121000 + 30000,
  }));
  assert.equal(d.on, false);

  // Nach Ablauf der Minute wieder einschalten.
  d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50,
    now: t0 + 121000 + RESTART_OFF_MS + 1,
  }));
  assert.equal(d.on, true);
  assert.equal(d.bypassHold, true);
});

test('Kein Neustart-Takten ohne tatsächlich eingestecktes Auto', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: '', powerTopic: 'p',
    stallTimeoutSeconds: 120, stallPowerW: 200 };
  const s = freshState();
  const t0 = 1_000_000;
  // Plan will laden (angesteckt-Signal ignoriert es nicht), aber plugged ist nicht true.
  decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0, plugged: false,
  }));
  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0 + 600000, plugged: false,
  }));
  // Bleibt eingeschaltet, kein Aus/Ein-Zyklus.
  assert.equal(d.on, true);
  assert.equal(s.restartUntil, 0);

  // Ebenso bei unbekanntem Anstecken (kein plugged-Topic → null).
  const s2 = freshState();
  decideWallboxAction(box, s2, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0, plugged: null,
  }));
  const d2 = decideWallboxAction(box, s2, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 50, now: t0 + 600000, plugged: null,
  }));
  assert.equal(d2.on, true);
  assert.equal(s2.restartUntil, 0);
});

test('Gesunde Ladeleistung löst keinen Neustart aus', () => {
  const box = { id: 1, maxPowerW: 11000, setpointTopic: '', powerTopic: 'p',
    stallTimeoutSeconds: 120, stallPowerW: 200 };
  const s = freshState();
  const t0 = 1_000_000;
  decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 7000, now: t0,
  }));
  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan: { desiredOn: true, setpointW: null, priority: 3 }, powerW: 7000, now: t0 + 300000,
  }));
  assert.equal(d.on, true);
  assert.equal(s.restartUntil, 0);
});

test('Volles Fahrzeug löst trotz aktivem Ladegerät keinen Neustart aus', () => {
  const box = { id: 1, mode: 3, maxPowerW: 3000, priorityFull: 4, setpointTopic: '',
    powerTopic: 'p', stallTimeoutSeconds: 120, stallPowerW: 20 };
  const s = freshState();
  const t0 = 1_000_000;
  const plan = planCharge(box, { soc: 100 });

  decideWallboxAction(box, s, baseDecideCtx({
    plan, powerW: 0, soc: 100, now: t0,
  }));
  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan, powerW: 0, soc: 100, now: t0 + 300000,
  }));

  assert.equal(d.on, true);
  assert.equal(s.restartUntil, 0);
  assert.equal(s.restartAttempts, 0);
});

test('Vollmeldung beendet einen bereits laufenden Neustartzyklus', () => {
  const box = { id: 1, mode: 3, maxPowerW: 3000, priorityFull: 4, setpointTopic: '',
    powerTopic: 'p', stallTimeoutSeconds: 120, stallPowerW: 20 };
  const s = freshState();
  s.restartUntil = 2_000_000;
  s.restartAttempts = 1;
  const plan = planCharge(box, { soc: 100 });

  const d = decideWallboxAction(box, s, baseDecideCtx({
    plan, powerW: 0, soc: 100, now: 1_500_000,
  }));

  assert.equal(d.on, true);
  assert.equal(s.restartUntil, 0);
  assert.equal(s.restartAttempts, 0);
});

// ── Vorhersage nächster Ladebeginn ──────────────────────────────────────────

test('Nächster Ladebeginn: erste Stunde mit ausreichend Überschuss', () => {
  const box = { id: 1, mode: 1, maxPowerW: 3000, setpointTopic: '' };
  const now = 1_000_000;
  const series = [
    { startMs: now + 3600000, dateKey: '2026-06-30', dayIndex: 0, hour: 10, pvW: 1000, surplusW: 500 },
    { startMs: now + 2 * 3600000, dateKey: '2026-06-30', dayIndex: 0, hour: 12, pvW: 5000, surplusW: 3000 },
  ];
  const next = predictNextChargeStart(box, freshState(), {
    series, nowMs: now, isCharging: false, full: false, weekdayMon: 1, tomorrowWeekdayMon: 2,
  });
  assert.equal(next.hour, 12);
  assert.equal(next.at, now + 2 * 3600000);
});

test('Nächster Ladebeginn: null wenn gerade geladen wird oder Fahrzeug voll', () => {
  const box = { id: 1, mode: 1, maxPowerW: 11000, setpointTopic: '' };
  const series = [{ startMs: 2_000_000, dateKey: '2026-06-30', dayIndex: 0, hour: 12, pvW: 5000, surplusW: 3000 }];
  const opts = { series, nowMs: 1_000_000, weekdayMon: 1, tomorrowWeekdayMon: 2 };
  assert.equal(predictNextChargeStart(box, freshState(), { ...opts, isCharging: true, full: false }), null);
  assert.equal(predictNextChargeStart(box, freshState(), { ...opts, isCharging: false, full: true }), null);
});

test('Nächster Ladebeginn nach manuellem Aus: Folgetag mit PV über Wallbox-Leistung', () => {
  const box = { id: 1, mode: 1, maxPowerW: 11000, setpointTopic: '' };
  const s = freshState();
  s.manualOff = true; s.manualOffDay = '2026-06-30';
  const now = 1_000_000;
  const series = [
    // gleicher Tag, viel PV → wird übersprungen
    { startMs: now + 3600000, dateKey: '2026-06-30', dayIndex: 0, hour: 13, pvW: 15000, surplusW: 9000 },
    // Folgetag, PV unter Wallbox-Leistung → nicht
    { startMs: now + 20 * 3600000, dateKey: '2026-07-01', dayIndex: 1, hour: 9, pvW: 8000, surplusW: 4000 },
    // Folgetag, Überschuss erstmals über Wallbox-Leistung → das ist es
    { startMs: now + 22 * 3600000, dateKey: '2026-07-01', dayIndex: 1, hour: 11, pvW: 15000, surplusW: 12000 },
  ];
  const next = predictNextChargeStart(box, s, {
    series, nowMs: now, isCharging: false, full: false, weekdayMon: 1, tomorrowWeekdayMon: 2,
  });
  assert.equal(next.hour, 11);
  assert.equal(next.at, now + 22 * 3600000);
});

test('Nächster Ladebeginn: Soll-Topic senkt die Überschussschwelle', () => {
  const box = { id: 1, mode: 1, maxPowerW: 11000, setpointTopic: 'x' };
  const now = 1_000_000;
  // 500 W Überschuss reicht mit Soll-Topic (MIN_CHARGE_W=300), ohne (SURPLUS_ON_W) nicht.
  const series = [{ startMs: now + 3600000, dateKey: '2026-06-30', dayIndex: 0, hour: 10, pvW: 1500, surplusW: 500 }];
  const opts = { series, nowMs: now, isCharging: false, full: false, weekdayMon: 1, tomorrowWeekdayMon: 2 };
  assert.equal(predictNextChargeStart(box, freshState(), opts).hour, 10);
  assert.equal(predictNextChargeStart({ ...box, setpointTopic: '' }, freshState(), opts), null);
  assert.ok(SURPLUS_ON_W > 500);
});

// ── Überschussleistung ──────────────────────────────────────────────────────

test('Überschuss = Einspeisung + Batterie-Ladeleistung über Mindest-SoC', () => {
  // Netzbezug negativ = Einspeisung 2000 W, Batterie lädt 1500 W, SoC 60 > MinSoC 20.
  const strom = { netzbezugPower: -2000 };
  const battery = { power: 1500, soc: 60, minSoc: null };
  assert.equal(houseSurplusWatt(strom, battery, 20), 3500);
});

test('Überschuss zählt Batterieladung nicht, wenn SoC am Mindest-SoC liegt', () => {
  const strom = { netzbezugPower: -2000 };
  const battery = { power: 1500, soc: 20, minSoc: null };
  assert.equal(houseSurplusWatt(strom, battery, 20), 2000);
});

test('Netzbezug (positiv) ergibt keinen Überschuss', () => {
  assert.equal(houseSurplusWatt({ netzbezugPower: 800 }, { power: -500, soc: 50 }, 20), 0);
});

test('Eigene Wallbox-Leistung wird gegen gleichzeitigen Netzbezug verrechnet', () => {
  // Die Box lädt mit 2300 W, die vollständig aus dem Netz kommen: ohne die Box
  // bliebe kein Überschuss übrig und die Privatladung muss oberhalb des Mindest-SoC
  // abschalten.
  assert.equal(
    houseSurplusWatt({ netzbezugPower: 2300 }, { power: -500, soc: 50 }, 20, 2300),
    0
  );
  // Deckt PV bereits 1500 W der laufenden Ladung, bleiben genau diese als
  // hypothetisch verfügbare Leistung erhalten.
  assert.equal(
    houseSurplusWatt({ netzbezugPower: 800 }, { power: -500, soc: 50 }, 20, 2300),
    1000
  );
});

test('Hausakku-Entladung gilt niemals als Wallbox-Überschuss', () => {
  assert.equal(
    houseSurplusWatt({ netzbezugPower: 0 }, { power: -2300, soc: 50 }, 20, 2300),
    0
  );
});

// ── Zähler-/Summenfortschreibung ────────────────────────────────────────────

async function tick(db, cache, box, calendar, now) {
  const { previousDayTotal } = await updateWallboxCounter(db, cache, box, calendar, now);
  await updateWallboxSummary(db, box, previousDayTotal, calendar);
}

test('Zähler-Topic zählt Differenzen und rollt Tag → Woche/Monat/Jahr', async () => {
  const db = await freshDb();
  const box = { id: 1, counterTopic: 'wb/c', counterUnit: 'kWh' };
  const cache = new Map();
  const day1 = cal('2026-06-29', '2026-W27', '2026-06', '2026');
  const day2 = cal('2026-06-30', '2026-W27', '2026-06', '2026');

  cache.set(cacheKey(1, 'counter'), { value: 10 });
  await tick(db, cache, box, day1, 1000);
  cache.set(cacheKey(1, 'counter'), { value: 12.5 });
  await tick(db, cache, box, day1, 2000);

  let counter = await loadCounterState(db, 1);
  assert.equal(Math.round(counter.dayTotal * 100) / 100, 2.5);

  // Tageswechsel: 2,5 kWh wandern in die Summen.
  await tick(db, cache, box, day2, 3000);
  const summary = await loadSummaryState(db, 1);
  assert.equal(Math.round(summary.weekOffset * 100) / 100, 2.5);
  assert.equal(Math.round(summary.monthOffset * 100) / 100, 2.5);
  assert.equal(Math.round(summary.yearOffset * 100) / 100, 2.5);
  const counter2 = await loadCounterState(db, 1);
  assert.equal(counter2.dayTotal, 0);
});

test('Jahreswechsel verschiebt den Jahreswert ins Vorjahr', async () => {
  const db = await freshDb();
  const box = { id: 1, counterTopic: 'wb/c', counterUnit: 'kWh' };
  const cache = new Map();
  const dec31 = cal('2025-12-31', '2025-W53', '2025-12', '2025');
  const jan01 = cal('2026-01-01', '2026-W01', '2026-01', '2026');

  cache.set(cacheKey(1, 'counter'), { value: 100 });
  await tick(db, cache, box, dec31, 1000);
  cache.set(cacheKey(1, 'counter'), { value: 104 });
  await tick(db, cache, box, dec31, 2000); // 4 kWh am 31.12.

  await tick(db, cache, box, jan01, 3000); // Jahreswechsel
  const summary = await loadSummaryState(db, 1);
  assert.equal(Math.round(summary.previousYearTotal * 100) / 100, 4);
  assert.equal(summary.yearOffset, 0);
});

test('Ohne Zähler-Topic wird der Verbrauch aus der Leistung integriert', async () => {
  const db = await freshDb();
  const box = { id: 2, powerTopic: 'wb/p', powerUnit: 'W' };
  const cache = new Map();
  const day = cal('2026-06-29', '2026-W27', '2026-06', '2026');

  cache.set(cacheKey(2, 'power'), { value: 3600 }); // 3600 W
  await tick(db, cache, box, day, 0);          // initialisiert last_power_ts
  await tick(db, cache, box, day, 5 * 60 * 1000); // 5 Minuten später (innerhalb des Plausibilitätsfensters)
  const counter = await loadCounterState(db, 2);
  // 3600 W über 300 s = 0,3 kWh
  assert.equal(Math.round(counter.dayTotal * 1000) / 1000, 0.3);
});

test('SoC-Schätzung aus geladener Energie und Akkugröße', () => {
  const box = { id: 1, socTopic: '', batteryCapacityKwh: 50 };
  const cache = new Map();
  // 5 kWh seit Einstecken geladen → 10 % von 50 kWh.
  const est = estimateSoc(box, cache, { pluggedEnergyStart: 10, lastRawValue: 15 });
  assert.equal(est.estimated, true);
  assert.equal(est.soc, 10);
  // mit SoC-Topic hat das gemeldete % Vorrang.
  const box2 = { id: 1, socTopic: 'wb/soc', batteryCapacityKwh: 50 };
  cache.set(cacheKey(1, 'soc'), { value: 73 });
  const est2 = estimateSoc(box2, cache, { pluggedEnergyStart: 10, lastRawValue: 15 });
  assert.equal(est2.estimated, false);
  assert.equal(est2.soc, 73);
});
