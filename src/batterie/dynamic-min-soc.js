'use strict';

// Dynamischer Mindest-SoC
// =======================
//
// Einmal je Kalendertag wird der Mindest-Ladezustand so gesetzt, dass der Akku
// am Folgetag laut Prognose planmäßig wieder 100 % erreicht. Je weniger morgen
// nachgeladen werden kann, desto höher muss die Reserve heute Nacht bleiben.
// Dafür zählt die PV-Kurve gegen den Hausverbrauch einschließlich Funktionen
// und Pool, aber vollständig OHNE Wallbox. Fahrzeugladungen werden separat
// geplant und dürfen weder Ladepotenzial noch Auslösezeitpunkt bestimmen.
//
// Auslösezeitpunkt ist der prognostizierte **Tageshöchststand des Akkus**, also
// der Übergang in die dauerhafte Entladung. Dieser ist erreicht, wenn
//   1. der PV-Höhepunkt des Tages überschritten ist (sonst würde ein trüber
//      Vormittag ohne Überschuss bereits nachts auslösen),
//   2. für keine verbleibende Stunde des Tages mehr ein PV-Überschuss über der
//      prognostizierten Last erwartet wird (keine erneut einsetzende Ladung),
//   3. der Akku auch real nicht mehr lädt. Das filtert das kurze Pendeln der
//      Ladeleistung um 100 % heraus, das noch keine echte Entladung ist.
//
// Ist der Wert für einen Tag gesetzt, sperrt der in der Datenbank festgehaltene
// Tagesschlüssel jede weitere Anpassung an diesem Tag – auch über einen
// Neustart hinweg. Der Mindest-SoC pendelt dadurch nicht hin und her.
//
// Grenzen: nie unter 10 %, absolut nie über 95 % (sonst werden DC-PV-Anlagen
// deaktiviert), nie über den aktuellen SoC minus 1 % (ein höherer
// Wert würde den Akku sofort als leer markieren). Gesetzt wird in **ganzen
// Prozent** — das 5-%-Raster gilt nur für den Schieberegler. Der Zielwert wird
// aufgerundet, damit die 100 % am Folgetag nicht systematisch knapp verfehlt
// werden; die Obergrenze dagegen abgerundet, damit sie nicht überschritten wird.

const mqttClient = require('../mqtt/client');
const { computePrognosis } = require('../prognosis/forecast');
const { loadBatterieConfig } = require('./config');
const { localCalendar } = require('../local-time');
const { loadMqttConfig } = require('../mqtt/config');
const minSocSync = require('./min-soc-sync');
const metrics = require('../runtime-metrics');

// Harte Grenzen der Anpassung (%).
const FLOOR_SOC = 10;
const CEILING_SOC = 95;
const SOC_HEADROOM = 1;
// Ab dieser Stundenenergie (kWh) gilt ein Überschuss als echte Ladeaussicht und
// nicht als Rundungsrest der Prognose.
const SURPLUS_EPS = 0.05;
// Ab dieser Ladeleistung (W) gilt der Akku als tatsächlich ladend. Darunter
// liegt das übliche Pendeln im oberen SoC-Bereich.
const CHARGE_POWER_EPS = 50;

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function readDailyState(db) {
  return dbGet(db, 'SELECT day_key, applied_min_soc, applied_at, note FROM battery_dynamic_min_soc_state WHERE id = 1')
    .then((row) => (row ? {
      dayKey: row.day_key || '',
      minSoc: row.applied_min_soc == null ? null : Number(row.applied_min_soc),
      appliedAt: row.applied_at || '',
      note: row.note || '',
    } : { dayKey: '', minSoc: null, appliedAt: '', note: '' }))
    .catch(() => ({ dayKey: '', minSoc: null, appliedAt: '', note: '' }));
}

function writeDailyState(db, dayKey, minSoc, note) {
  return dbRun(
    db,
    `INSERT INTO battery_dynamic_min_soc_state (id, day_key, applied_min_soc, applied_at, note)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       day_key = excluded.day_key,
       applied_min_soc = excluded.applied_min_soc,
       applied_at = excluded.applied_at,
       note = excluded.note`,
    [dayKey, minSoc == null ? null : Math.round(minSoc), new Date().toISOString(), note || '']
  );
}

// Prüft anhand des Stundenprofils von heute, ob der Akku seinen Höchststand
// überschritten hat und in die dauerhafte Entladung übergegangen ist.
function evaluatePeakPassed(today, decimalHour) {
  if (!today || !Array.isArray(today.hourlyPvKwh) || !Array.isArray(today.hourlyLoadKwh)) {
    return { passed: false, reason: 'keine-stundenprognose' };
  }
  const peakHour = today.pvPeakHour;
  // Ohne jeden PV-Ertrag (Polarnacht, Anlage aus) gibt es keinen Höchststand,
  // den man abwarten könnte – dann zählt allein die fehlende Ladeaussicht.
  if (peakHour != null && decimalHour < peakHour + 1) {
    return { passed: false, reason: 'pv-hoehepunkt-ausstehend', peakHour };
  }
  for (let hour = 0; hour < 24; hour += 1) {
    const pv = today.hourlyPvKwh[hour];
    const load = today.hourlyLoadKwh[hour];
    if (pv == null || load == null) continue;
    if (pv - load > SURPLUS_EPS) {
      return { passed: false, reason: 'ueberschuss-erwartet', surplusHour: hour };
    }
  }
  return { passed: true, reason: 'dauerhafte-entladung' };
}

// Zielwert aus dem Ladepotenzial des Folgetags. Gibt immer einen Befund zurück,
// auch wenn nichts gesetzt werden kann. `reason` ist ein maschinenlesbarer
// Schlüssel für Journal und Tagesprotokoll – kein Anzeigetext.
function computeTargetMinSoc({ chargePotentialKwh, capacityKwh, currentSoc }) {
  if (!Number.isFinite(capacityKwh) || capacityKwh <= 0) {
    return { minSoc: null, reason: 'keine-kapazitaet' };
  }
  if (currentSoc == null) {
    return { minSoc: null, reason: 'soc-unbekannt' };
  }
  const chargeablePercent = Math.max(0, (num(chargePotentialKwh) || 0) / capacityKwh * 100);
  const desired = Math.ceil(Math.min(100, Math.max(0, 100 - chargeablePercent)));
  const upper = Math.min(CEILING_SOC, Math.floor(currentSoc - SOC_HEADROOM));
  if (upper < FLOOR_SOC) {
    // Unterhalb von 11 % SoC liegen Unter- und Obergrenze über Kreuz; dann
    // bleibt der Mindest-SoC unverändert.
    return { minSoc: null, chargeablePercent, desired, reason: 'kein-spielraum' };
  }
  const minSoc = Math.min(Math.max(desired, FLOOR_SOC), upper);
  return { minSoc, chargeablePercent, desired, reason: 'gesetzt' };
}

async function evaluate(db, { prognosis, config, local }) {
  if (!config.dynamicMinSoc) return { skipped: true, reason: 'nicht-aktiviert' };

  const dayKey = local.dateKey;
  const state = await readDailyState(db);
  if (state.dayKey === dayKey) {
    return { skipped: true, alreadyDone: true, dayKey, reason: 'bereits-entschieden' };
  }

  const simulation = prognosis && prognosis.dynamicMinSocSimulation;
  const days = simulation && Array.isArray(simulation.days) ? simulation.days : [];
  if (!simulation || !simulation.available || days.length < 2) {
    return { skipped: true, dayKey, reason: 'prognose-fehlt' };
  }

  const decimalHour = (Number(local.hours) || 0) + (Number(local.minutes) || 0) / 60;
  const peak = evaluatePeakPassed(days[0], decimalHour);
  if (!peak.passed) return { skipped: true, dayKey, ...peak };

  // Regel 3: Solange der Akku real noch lädt, ist der Höchststand nicht
  // erreicht. Ohne Leistungs-Topic entfällt die Prüfung.
  const power = num(prognosis.battery && prognosis.battery.power);
  if (power != null && power > CHARGE_POWER_EPS) {
    return { skipped: true, dayKey, reason: 'akku-laedt', power };
  }

  const currentSoc = num(prognosis.battery && prognosis.battery.soc);
  const target = computeTargetMinSoc({
    chargePotentialKwh: days[1].chargePotentialKwh,
    capacityKwh: num(simulation.capacityKwh),
    currentSoc,
  });
  return { ...target, dayKey, skipped: false, currentSoc, tomorrow: days[1].dateKey };
}

async function runNow(db) {
  const config = await new Promise((resolve) => loadBatterieConfig(db, resolve));
  if (!config.dynamicMinSoc) return { skipped: true, reason: 'nicht-aktiviert' };
  const cache = mqttClient.getCache();
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const local = localCalendar(cache, mqttConfig.timezone, new Date());
  const prognosis = await computePrognosis(db, cache, { allowFetch: false });
  const result = await evaluate(db, { prognosis, config, local });
  if (result.skipped) return result;

  // Auch ein nicht anwendbarer Befund schließt den Tag ab: Der Auslösezeitpunkt
  // ist einmalig, ein späteres Nachziehen wäre genau das ständige Schwanken,
  // das die Automatik vermeiden soll.
  await writeDailyState(db, result.dayKey, result.minSoc, result.reason);
  if (result.minSoc == null) {
    console.log('[batterie dynMinSoc]', JSON.stringify({
      ts: new Date().toISOString(), dayKey: result.dayKey, applied: false, reason: result.reason,
    }));
    return { ...result, applied: false };
  }
  if (result.minSoc === config.minSoc) {
    console.log('[batterie dynMinSoc]', JSON.stringify({
      ts: new Date().toISOString(), dayKey: result.dayKey, applied: false,
      minSoc: result.minSoc, reason: 'unveraendert',
    }));
    return { ...result, applied: false };
  }
  console.log('[batterie dynMinSoc]', JSON.stringify({
    ts: new Date().toISOString(), dayKey: result.dayKey, applied: true,
    from: config.minSoc, to: result.minSoc,
    currentSoc: result.currentSoc,
    chargeablePercent: result.chargeablePercent == null ? null : Number(result.chargeablePercent.toFixed(1)),
    tomorrow: result.tomorrow,
  }));
  await minSocSync.setLocalMinSoc(db, result.minSoc, {
    source: 'dynamischer-mindest-soc',
    // In 1-%-Schritten: das 5-%-Raster des Schiebereglers würde den berechneten
    // Zielwert verschieben und damit die 100 % am Folgetag verfehlen.
    snapToStep: false,
  });
  return { ...result, applied: true };
}

// Statuszeile für die Batterieseite.
async function readStatus(db) {
  const state = await readDailyState(db);
  return state.dayKey ? state : null;
}

let timer = null;
let chain = Promise.resolve();

function runSerialized(db) {
  const run = chain.then(() => runNow(db));
  chain = run.catch(() => {});
  return run;
}

function init(db) {
  // Fünf Minuten genügen: Die Entscheidung fällt einmal am Tag und wird
  // stundenscharf aus der Prognose abgeleitet.
  if (!timer) {
    timer = setInterval(
      () => metrics.measure('batterie.dynamicMinSoc', () => runSerialized(db)).catch(() => {}),
      5 * 60 * 1000
    );
  }
  return runSerialized(db).catch(() => {});
}

function resetForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  chain = Promise.resolve();
}

module.exports = {
  init, runNow, runSerialized, evaluate, evaluatePeakPassed, computeTargetMinSoc,
  readDailyState, writeDailyState, readStatus, resetForTests,
  FLOOR_SOC, SOC_HEADROOM, SURPLUS_EPS, CHARGE_POWER_EPS,
};
