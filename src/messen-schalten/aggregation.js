'use strict';

// Schreibfreie Live-Werte je Gerät + Ableitung „Leistung aus Zählerfortschritt".
// Vorbild: wallbox/aggregation.js. Ist nur ein Zähler-Topic gesetzt, wird die
// Leistung aus dem Fortschritt des Zählers (Δkwh/Δt) abgeleitet; bleibt der
// Fortschritt länger als STALL_MS aus, fällt die abgeleitete Leistung auf 0 W.
//
// Der angezeigte Zählerstand ist ein INTERNER Zähler (counter_total_kwh), der wie
// der Stromverbrauchs-Zähler nur die Deltas des Roh-Topics fortschreibt: Bei
// Geräte-Neuanlage oder Topic-/Einheitenwechsel wird lediglich die Baseline
// (last_counter_raw) neu gesetzt, ohne dass der aktuelle Rohwert als Sprung in
// den internen Zähler eingeht. Rückwärtssprünge des Rohwerts (Geräte-Reset)
// basieren ebenfalls nur neu.

const { listActors, cacheKey } = require('./actors');

const STALL_MS = 10 * 60 * 1000;   // > 10 min ohne Zählerfortschritt ⇒ 0 W
const POWER_ON_THRESHOLD_W = 1;    // ab dieser Leistung gilt ein Gerät als „an"

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function getCacheNumber(cache, key) {
  const entry = cache.get(key);
  return entry ? parseNumber(entry.value) : null;
}
function getCacheRaw(cache, key) {
  const entry = cache.get(key);
  return entry ? entry.value : undefined;
}

function powerToWatt(value, unit) {
  if (value == null) return null;
  return unit === 'kW' ? value * 1000 : value;
}
function counterToKwh(value, unit) {
  if (value == null) return null;
  return unit === 'Wh' ? value / 1000 : value;
}

async function loadStates(db) {
  const rows = await dbAll(
    db,
    'SELECT actor_id, last_counter_raw, last_progress_ts, derived_power_w, counter_total_kwh FROM mess_schalt_actor_state'
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.actor_id, {
      lastCounterRaw: parseNumber(row.last_counter_raw),
      lastProgressTs: row.last_progress_ts == null ? null : Number(row.last_progress_ts),
      derivedPowerW: parseNumber(row.derived_power_w),
      counterTotalKwh: parseNumber(row.counter_total_kwh),
    });
  }
  return map;
}

async function saveState(db, actorId, state) {
  await dbRun(
    db,
    `INSERT INTO mess_schalt_actor_state (actor_id, last_counter_raw, last_progress_ts, derived_power_w, counter_total_kwh)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(actor_id) DO UPDATE SET
       last_counter_raw = excluded.last_counter_raw,
       last_progress_ts = excluded.last_progress_ts,
       derived_power_w = excluded.derived_power_w,
       counter_total_kwh = excluded.counter_total_kwh`,
    [actorId, state.lastCounterRaw, state.lastProgressTs, state.derivedPowerW, state.counterTotalKwh]
  );
}

// Liefert die aus einem Zählerstand abgeleitete Leistung (W) unter Berücksichtigung
// des 10-Minuten-Cutoffs. Reine Funktion — für Tests und Reads wiederverwendbar.
function derivedPowerFromState(state, now) {
  if (!state) return null;
  if (state.lastProgressTs != null && now - state.lastProgressTs > STALL_MS) return 0;
  return state.derivedPowerW == null ? null : state.derivedPowerW;
}

// Schreibende Fortschreibung (60-s-Job) für alle Geräte mit Zähler-Topic:
// interner Zählerstand (Delta-Fortschreibung) und – nur ohne eigenes
// Leistungs-Topic – die Ableitung der Leistung aus dem Zählerfortschritt.
async function buildActorSnapshot(db, cache, now = Date.now()) {
  const actors = await listActors(db);
  const states = await loadStates(db);
  for (const actor of actors) {
    if (!actor.counterTopic) continue;
    const raw = counterToKwh(getCacheNumber(cache, cacheKey(actor.id, 'counter')), actor.counterUnit);
    if (raw == null) continue;
    const prev = states.get(actor.id)
      || { lastCounterRaw: null, lastProgressTs: null, derivedPowerW: null, counterTotalKwh: null };
    const next = { ...prev };

    // Interner Zählerstand: nur Deltas des Rohwerts zählen. Ist die Baseline
    // leer (Neuanlage, Topic-/Einheitenwechsel), wird nur neu basiert – der
    // aktuelle Rohwert darf NICHT als Sprung eingehen.
    if (prev.counterTotalKwh == null) {
      // Altbestand ohne internen Zähler: bisher wurde der Rohwert angezeigt –
      // einmalig als Startstand übernehmen, damit die Anzeige nahtlos weiterläuft.
      next.counterTotalKwh = raw;
    } else if (prev.lastCounterRaw != null && raw > prev.lastCounterRaw) {
      next.counterTotalKwh = prev.counterTotalKwh + (raw - prev.lastCounterRaw);
    }

    // Leistungsableitung nur für Geräte ohne eigenes Leistungs-Topic.
    if (!actor.powerTopic) {
      if (prev.lastCounterRaw == null) {
        next.derivedPowerW = 0;
      } else if (raw > prev.lastCounterRaw) {
        const dtH = prev.lastProgressTs != null ? (now - prev.lastProgressTs) / 3600000 : 0;
        if (dtH > 0) next.derivedPowerW = Math.max(0, (raw - prev.lastCounterRaw) / dtH * 1000);
      } else if (raw === prev.lastCounterRaw && prev.lastProgressTs != null && now - prev.lastProgressTs > STALL_MS) {
        next.derivedPowerW = 0;
      }
      // raw < Baseline (Zähler-Reset, z. B. Geräteneustart): nicht leiten, nur neu basieren.
    }

    if (prev.lastCounterRaw == null || raw !== prev.lastCounterRaw) {
      next.lastCounterRaw = raw;
      next.lastProgressTs = now;
    }
    await saveState(db, actor.id, next);
  }
}

// Leistung (W) eines Geräts: Leistungs-Topic bevorzugt, sonst aus dem
// Zählerfortschritt (mit Live-Cutoff), sonst null.
function resolvePowerW(cache, actor, state, now) {
  if (actor.powerTopic) {
    return powerToWatt(getCacheNumber(cache, cacheKey(actor.id, 'power')), actor.powerUnit);
  }
  if (actor.counterTopic) return derivedPowerFromState(state, now);
  return null;
}

// Status (an/aus): Status-Topic → sonst Schalt-Topic → sonst aus der Leistung.
function resolveStatus(cache, actor, switchOn, powerW) {
  if (actor.statusTopic) {
    const raw = getCacheRaw(cache, cacheKey(actor.id, 'status'));
    return raw === undefined || raw == null || raw === '' ? null : parseBool(raw);
  }
  if (actor.switchTopic) return switchOn;
  if (powerW != null) return powerW > POWER_ON_THRESHOLD_W;
  return null;
}

// Schreibfreie Live-Werte je Gerät für Seite, /data und Wertekatalog.
async function readActorValues(db, cache, actors, now = Date.now()) {
  const list = actors || (await listActors(db));
  const states = await loadStates(db);
  return list.map((actor) => {
    const state = states.get(actor.id) || null;
    const switchOn = actor.switchTopic
      ? (() => {
          const raw = getCacheRaw(cache, cacheKey(actor.id, 'switch'));
          return raw === undefined || raw == null || raw === '' ? null : parseBool(raw);
        })()
      : null;
    const powerW = resolvePowerW(cache, actor, state, now);
    const statusOn = resolveStatus(cache, actor, switchOn, powerW);
    // Interner Zählerstand statt Roh-Topic-Wert. Altbestände ohne fortgeschriebenen
    // internen Zähler zeigen bis zum ersten Snapshot den Rohwert (wie bisher).
    const counterKwh = actor.counterTopic
      ? (state && state.counterTotalKwh != null
        ? state.counterTotalKwh
        : counterToKwh(getCacheNumber(cache, cacheKey(actor.id, 'counter')), actor.counterUnit))
      : null;
    return {
      id: actor.id,
      name: actor.name,
      groupId: actor.groupId,
      switchOn,
      statusOn,
      powerW,
      counterKwh,
      powerFromCounter: !actor.powerTopic && !!actor.counterTopic,
      hasSwitch: !!actor.switchTopic,
      alwaysOn: actor.alwaysOn,
    };
  });
}

// Verbrauchssumme (Leistung, W) je Gruppe: Summe der Geräteleistungen der Mitglieder.
// Gibt null zurück, wenn kein Mitglied einen Leistungswert liefert.
function readGroupSums(groups, values) {
  const byGroup = new Map();
  for (const value of values || []) {
    if (value.groupId == null || value.powerW == null) continue;
    const acc = byGroup.get(value.groupId) || { powerW: 0 };
    acc.powerW += value.powerW;
    byGroup.set(value.groupId, acc);
  }
  const result = new Map();
  for (const group of groups || []) {
    const acc = byGroup.get(group.id);
    result.set(group.id, { powerW: acc ? acc.powerW : null });
  }
  return result;
}

module.exports = {
  STALL_MS, POWER_ON_THRESHOLD_W,
  buildActorSnapshot, readActorValues, readGroupSums,
  derivedPowerFromState, resolvePowerW, resolveStatus,
  powerToWatt, counterToKwh, parseNumber, parseBool,
};
