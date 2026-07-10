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
const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');

const STALL_MS = 10 * 60 * 1000;   // > 10 min ohne Zählerfortschritt ⇒ 0 W
const POWER_ON_THRESHOLD_W = 1;    // ab dieser Leistung gilt ein Gerät als „an"
const VALUE_STALE_MS = 5 * 60 * 1000; // nur passive Frischebewertung, kein /get

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
function getCacheEntry(cache, key) {
  const entry = cache.get(key);
  return entry ? { value: entry.value, receivedAt: Number(entry.receivedAt) || 0 } : null;
}

function isStale(entry, now) {
  return !!entry && entry.receivedAt > 0 && now - entry.receivedAt > VALUE_STALE_MS;
}

function powerToWatt(value, unit) {
  if (value == null) return null;
  return unit === 'kW' ? value * 1000 : value;
}
// Nennleistung eines Geräts in Watt (positiv) oder null. Basis der virtuellen
// Zählung, wenn kein Leistungs- und kein Zähler-Topic gesetzt ist.
function ratedPowerWatt(actor) {
  if (!actor || actor.ratedPower == null) return null;
  const w = powerToWatt(actor.ratedPower, actor.ratedPowerUnit);
  return w != null && w > 0 ? w : null;
}
function counterToKwh(value, unit) {
  if (value == null) return null;
  return unit === 'Wh' ? value / 1000 : value;
}

async function loadStates(db) {
  const rows = await dbAll(
    db,
    `SELECT actor_id, last_counter_raw, last_progress_ts, derived_power_w, counter_total_kwh,
            day_key, day_start_kwh, year_key, year_start_kwh, prev_year_kwh
     FROM mess_schalt_actor_state`
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.actor_id, {
      lastCounterRaw: parseNumber(row.last_counter_raw),
      lastProgressTs: row.last_progress_ts == null ? null : Number(row.last_progress_ts),
      derivedPowerW: parseNumber(row.derived_power_w),
      counterTotalKwh: parseNumber(row.counter_total_kwh),
      dayKey: row.day_key || null,
      dayStartKwh: parseNumber(row.day_start_kwh),
      yearKey: row.year_key || null,
      yearStartKwh: parseNumber(row.year_start_kwh),
      prevYearKwh: parseNumber(row.prev_year_kwh),
    });
  }
  return map;
}

async function saveState(db, actorId, state) {
  await dbRun(
    db,
    `INSERT INTO mess_schalt_actor_state
       (actor_id, last_counter_raw, last_progress_ts, derived_power_w, counter_total_kwh,
        day_key, day_start_kwh, year_key, year_start_kwh, prev_year_kwh)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(actor_id) DO UPDATE SET
       last_counter_raw = excluded.last_counter_raw,
       last_progress_ts = excluded.last_progress_ts,
       derived_power_w = excluded.derived_power_w,
       counter_total_kwh = excluded.counter_total_kwh,
       day_key = excluded.day_key,
       day_start_kwh = excluded.day_start_kwh,
       year_key = excluded.year_key,
       year_start_kwh = excluded.year_start_kwh,
       prev_year_kwh = excluded.prev_year_kwh`,
    [actorId, state.lastCounterRaw, state.lastProgressTs, state.derivedPowerW, state.counterTotalKwh,
      state.dayKey == null ? null : state.dayKey, state.dayStartKwh == null ? null : state.dayStartKwh,
      state.yearKey == null ? null : state.yearKey, state.yearStartKwh == null ? null : state.yearStartKwh,
      state.prevYearKwh == null ? null : state.prevYearKwh]
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
// Tages-/Jahres-Baseline auf dem internen Zähler fortschreiben. „Heute" bzw.
// „dieses Jahr" ergeben sich beim Lesen als (Zählerstand − Baseline). Beim
// Jahreswechsel wird der abgeschlossene Jahresverbrauch als Vorjahr festgehalten.
function applyPeriodRollover(state, calendar) {
  const total = state.counterTotalKwh;
  if (total == null || !calendar) return;
  if (state.dayKey !== calendar.dateKey || state.dayStartKwh == null) {
    state.dayKey = calendar.dateKey;
    state.dayStartKwh = total;
  }
  if (state.yearKey !== calendar.yearKey || state.yearStartKwh == null) {
    if (state.yearKey != null && state.yearStartKwh != null) {
      state.prevYearKwh = Math.max(0, total - state.yearStartKwh);
    }
    state.yearKey = calendar.yearKey;
    state.yearStartKwh = total;
  }
}

// Virtuelle Zählung für ein Gerät ohne Leistungs- und Zähler-Topic, aber mit
// Nennleistung: Energie des vergangenen Intervalls mit der DAMALS gültigen
// Leistung integrieren (interner Zähler wie bei echten Zählern, inkl. Tages-/
// Jahres-Baseline), danach die aktuelle Leistung aus dem Schaltzustand ableiten
// (Nennleistung wenn an, sonst 0). Ist der Schaltzustand unbekannt, wird nichts
// fortgeschrieben. Kein Effekt, wenn ein Leistungs-Topic vorhanden ist.
async function updateVirtualState(db, cache, actor, prevState, calendar, now) {
  if (actor.powerTopic) return;
  const rated = ratedPowerWatt(actor);
  if (rated == null) return;
  const switchRaw = actor.switchTopic ? getCacheRaw(cache, cacheKey(actor.id, 'switch')) : undefined;
  const switchOn = switchRaw === undefined || switchRaw == null || switchRaw === ''
    ? null : parseBool(switchRaw);
  const on = resolveTopicStatus(cache, actor, switchOn);
  if (on == null) return; // kein Schaltzustand bekannt ⇒ nicht zählen
  const prev = prevState
    || { lastCounterRaw: null, lastProgressTs: null, derivedPowerW: null, counterTotalKwh: 0 };
  const next = { ...prev };
  if (next.counterTotalKwh == null) next.counterTotalKwh = 0;
  if (prev.lastProgressTs != null && prev.derivedPowerW != null && prev.derivedPowerW > 0) {
    const dtH = (now - prev.lastProgressTs) / 3600000;
    if (dtH > 0) next.counterTotalKwh += prev.derivedPowerW * dtH / 1000;
  }
  next.derivedPowerW = on ? rated : 0;
  next.lastProgressTs = now;
  applyPeriodRollover(next, calendar);
  await saveState(db, actor.id, next);
}

async function buildActorSnapshot(db, cache, now = Date.now()) {
  const actors = await listActors(db);
  const states = await loadStates(db);
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone, new Date(now));
  for (const actor of actors) {
    if (!actor.counterTopic) {
      await updateVirtualState(db, cache, actor, states.get(actor.id), calendar, now);
      continue;
    }
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
    applyPeriodRollover(next, calendar);
    await saveState(db, actor.id, next);
  }
}

// Verbrauch (kWh) eines Geräts je Zeitraum aus dem persistierten Zustand:
//   heute   = interner Zähler − Tages-Baseline
//   jahr    = interner Zähler − Jahres-Baseline
//   vorjahr = abgeschlossener Vorjahresverbrauch
function computeActorEnergy(state) {
  if (!state || state.counterTotalKwh == null) {
    return { todayKwh: null, yearKwh: null, prevYearKwh: state ? state.prevYearKwh ?? null : null };
  }
  const total = state.counterTotalKwh;
  return {
    todayKwh: state.dayStartKwh == null ? 0 : Math.max(0, total - state.dayStartKwh),
    yearKwh: state.yearStartKwh == null ? 0 : Math.max(0, total - state.yearStartKwh),
    prevYearKwh: state.prevYearKwh == null ? null : state.prevYearKwh,
  };
}

// Ist-Zustand allein aus Status-/Schalt-Topic (ohne Leistungs-Rückschluss). Für
// die virtuelle Zählung, deren Leistung erst aus diesem Zustand entsteht.
function resolveTopicStatus(cache, actor, switchOn) {
  if (actor.statusTopic) {
    const raw = getCacheRaw(cache, cacheKey(actor.id, 'status'));
    return raw === undefined || raw == null || raw === '' ? null : parseBool(raw);
  }
  if (actor.switchTopic) return switchOn;
  return null;
}

// Leistung (W) eines Geräts: Leistungs-Topic bevorzugt, sonst aus dem
// Zählerfortschritt (mit Live-Cutoff), sonst virtuell aus Nennleistung ×
// Schaltzustand, sonst null. topicStatus ist der aus Status-/Schalt-Topic
// bekannte Ist-Zustand (nur für die virtuelle Zählung nötig).
function resolvePowerW(cache, actor, state, now, topicStatus = null) {
  if (actor.powerTopic) {
    return powerToWatt(getCacheNumber(cache, cacheKey(actor.id, 'power')), actor.powerUnit);
  }
  if (actor.counterTopic) return derivedPowerFromState(state, now);
  const rated = ratedPowerWatt(actor);
  if (rated != null && topicStatus != null) return topicStatus ? rated : 0;
  return null;
}

// Status (an/aus): Status-Topic → sonst Schalt-Topic → sonst aus der Leistung.
function resolveStatus(cache, actor, switchOn, powerW) {
  if (actor.statusTopic || actor.switchTopic) return resolveTopicStatus(cache, actor, switchOn);
  if (powerW != null) return powerW > POWER_ON_THRESHOLD_W;
  return null;
}

// Schreibfreie Live-Werte je Gerät für Seite, /data und Wertekatalog.
async function readActorValues(db, cache, actors, now = Date.now()) {
  const list = actors || (await listActors(db));
  const states = await loadStates(db);
  return list.map((actor) => {
    const state = states.get(actor.id) || null;
    const switchEntry = actor.switchTopic ? getCacheEntry(cache, cacheKey(actor.id, 'switch')) : null;
    const statusEntry = actor.statusTopic ? getCacheEntry(cache, cacheKey(actor.id, 'status')) : switchEntry;
    const powerEntry = actor.powerTopic ? getCacheEntry(cache, cacheKey(actor.id, 'power')) : null;
    const counterEntry = actor.counterTopic ? getCacheEntry(cache, cacheKey(actor.id, 'counter')) : null;
    const switchOn = switchEntry && switchEntry.value != null && switchEntry.value !== ''
      ? parseBool(switchEntry.value) : null;
    // Virtuelle Zählung: kein Leistungs-/Zähler-Topic, aber eine Nennleistung. Der
    // Schaltzustand kommt dann aus Status-/Schalt-Topic; Leistung/Energie werden
    // daraus abgeleitet, der Frische-Bezug ist das Status-/Schalt-Topic.
    const isVirtualRated = !actor.powerTopic && !actor.counterTopic && ratedPowerWatt(actor) != null;
    const topicStatus = resolveTopicStatus(cache, actor, switchOn);
    let powerW = resolvePowerW(cache, actor, state, now, topicStatus);
    const statusOn = resolveStatus(cache, actor, switchOn, powerW);
    let powerInferredOff = false;
    // Homematic meldet beim Ausschalten gelegentlich keinen neuen POWER-Wert.
    // Ein bestätigtes AUS ist für ein schaltbares Gerät dennoch hinreichend
    // sicher: Ein alter Messwert darf dann nicht weiter als Verbrauch erscheinen.
    if (actor.powerTopic && statusOn === false && statusEntry) {
      powerW = 0;
      powerInferredOff = true;
    }
    // Interner Zählerstand statt Roh-Topic-Wert – für Zähler-Topics wie für die
    // virtuelle Zählung (beide schreiben counter_total_kwh im Snapshot-Job fort).
    // Altbestände ohne fortgeschriebenen Zähler zeigen bis zum ersten Snapshot den
    // Rohwert (wie bisher).
    const counterKwh = actor.counterTopic
      ? (state && state.counterTotalKwh != null
        ? state.counterTotalKwh
        : counterToKwh(getCacheNumber(cache, cacheKey(actor.id, 'counter')), actor.counterUnit))
      : (isVirtualRated && state && state.counterTotalKwh != null ? state.counterTotalKwh : null);
    const virtualEntry = isVirtualRated ? statusEntry : null;
    return {
      id: actor.id,
      name: actor.name,
      groupId: actor.groupId,
      switchOn,
      statusOn,
      powerW,
      counterKwh,
      statusReceivedAt: statusEntry ? statusEntry.receivedAt : null,
      powerReceivedAt: powerEntry ? powerEntry.receivedAt
        : counterEntry ? counterEntry.receivedAt
          : (virtualEntry ? virtualEntry.receivedAt : null),
      counterReceivedAt: counterEntry ? counterEntry.receivedAt : (virtualEntry ? virtualEntry.receivedAt : null),
      statusStale: isStale(statusEntry, now),
      powerStale: !powerInferredOff && isStale(powerEntry || counterEntry || virtualEntry, now),
      counterStale: isStale(counterEntry || virtualEntry, now),
      powerInferredOff,
      powerFromCounter: !actor.powerTopic && !!actor.counterTopic,
      powerFromRated: isVirtualRated,
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

// Ebene/Gesamt je Gruppe für die mehrschichtige Darstellung. Zwei Modelle:
//
//   Normale Gruppe (additiv):
//     ebeneW  = Leistung der EIGENEN Geräte (wie readGroupSums)
//     gesamtW = ebeneW + Σ(gesamtW der direkten Untergruppen), rekursiv
//
//   Zählergruppe (meterGroup): die eigenen Geräte sind Zähler und messen den
//   ganzen Zweig inklusive Untergruppen. Der Gesamtverbrauch ist damit fix:
//     gesamtW   = ebeneW (die Zähler)
//     sonstigeW = ebeneW − Σ(gesamtW der Untergruppen)  (bei 0 gekappt)
//   „Ebene" wird bei Zählergruppen nicht angezeigt; stattdessen erscheint
//   sonstigeW als Fußzeile („Sonstige Verbraucher dieser Gruppe").
//
// contributionW ist der Beitrag der Gruppe zum globalen „Sonstige Verbraucher"-
// Restposten. Er berücksichtigt bereits den eigenen Haken (offsetTotalConsumption)
// UND die Sperrschicht-Regel und wird darum in einem Top-down-Lauf gebildet:
//   • Eine VERRECHNETE Zählergruppe (meterGroup + Haken) trägt ihren vollen
//     Zweig-Gesamtwert (gesamtW) bei und wird zur Sperrschicht: alle Nachfahren
//     tragen 0 bei, egal was dort angehakt ist – der Zweig ist über den Zähler
//     bereits vollständig erfasst.
//   • Sonst trägt eine Gruppe mit gesetztem Haken ihre eigenen Geräte (ebeneW)
//     bei; ohne Haken 0.
//
// Ein Wert ist null, wenn kein passender Leistungswert vorliegt; sonst zählen
// fehlende Teilwerte als 0.
function readGroupPowerTree(groups, values) {
  const own = readGroupSums(groups, values); // id -> { powerW }
  const groupById = new Map((groups || []).map((g) => [g.id, g]));
  const childrenByParent = new Map();
  for (const group of groups || []) {
    const parent = group.parentId == null ? null : group.parentId;
    if (parent == null) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(group.id);
  }

  // Summe der Gesamtleistungen der direkten Untergruppen (null wenn keine liefert).
  const childrenTotalMemo = new Map();
  function childrenTotal(id, guard) {
    if (childrenTotalMemo.has(id)) return childrenTotalMemo.get(id);
    let acc = 0;
    let hasValue = false;
    for (const childId of childrenByParent.get(id) || []) {
      const childTotal = computeTotal(childId, guard);
      if (childTotal != null) { acc += childTotal; hasValue = true; }
    }
    const total = hasValue ? acc : null;
    childrenTotalMemo.set(id, total);
    return total;
  }

  const totalMemo = new Map();
  function computeTotal(id, guard) {
    if (totalMemo.has(id)) return totalMemo.get(id);
    if (guard.has(id)) return null; // defensiv gegen Datenzyklen
    guard.add(id);
    const ebene = own.get(id) ? own.get(id).powerW : null;
    const kids = childrenTotal(id, guard);
    guard.delete(id);
    let total;
    if (groupById.get(id) && groupById.get(id).meterGroup) {
      // Zählergruppe: der Gesamtverbrauch ist durch die eigenen Zähler fixiert.
      total = ebene;
    } else if (ebene == null && kids == null) {
      total = null;
    } else {
      total = (ebene || 0) + (kids || 0);
    }
    totalMemo.set(id, total);
    return total;
  }

  const result = new Map();
  for (const group of groups || []) {
    const children = childrenByParent.get(group.id) || [];
    const ebeneW = own.get(group.id) ? own.get(group.id).powerW : null;
    const gesamtW = computeTotal(group.id, new Set());
    const isMeter = group.meterGroup === true;
    // „Sonstige Verbraucher dieser Gruppe" nur bei Zählergruppen mit Untergruppen.
    // Abgezogen werden nur die Untergruppen, deren Haken „mit Gesamtverbrauch
    // verrechnen" gesetzt ist – sie werden aus der Sonstige-Summe herausgerechnet.
    // Untergruppen ohne Haken bleiben in „Sonstige" enthalten.
    let countedKidsW = 0;
    for (const childId of children) {
      const child = groupById.get(childId);
      if (!child || child.offsetTotalConsumption === false) continue;
      const ct = computeTotal(childId, new Set());
      if (ct != null) countedKidsW += ct;
    }
    const sonstigeW = isMeter && children.length > 0 && ebeneW != null
      ? Math.max(0, ebeneW - countedKidsW)
      : null;
    result.set(group.id, {
      ebeneW,
      gesamtW,
      sonstigeW,
      // Beitrag zum globalen Restposten – im Top-down-Lauf unten gesetzt.
      contributionW: 0,
      meterGroup: isMeter,
      hasChildren: children.length > 0,
      childCount: children.length,
    });
  }

  // Globalen Beitrag je Gruppe im Top-down-Lauf bilden (Sperrschicht beachten).
  function walkGlobal(id, blocked, guard) {
    if (guard.has(id)) return; // defensiv gegen Datenzyklen
    guard.add(id);
    const group = groupById.get(id);
    const res = result.get(id);
    const offset = group.offsetTotalConsumption !== false; // Default: verrechnen
    let childBlocked;
    if (blocked) {
      res.contributionW = 0;
      childBlocked = true;
    } else if (res.meterGroup && offset) {
      // Verrechnete Zählergruppe: voller Zweigwert, danach Sperrschicht.
      res.contributionW = res.gesamtW == null ? 0 : res.gesamtW;
      childBlocked = true;
    } else {
      res.contributionW = offset && res.ebeneW != null ? res.ebeneW : 0;
      childBlocked = false;
    }
    for (const childId of childrenByParent.get(id) || []) walkGlobal(childId, childBlocked, guard);
  }
  const globalGuard = new Set();
  for (const group of groups || []) {
    const parent = group.parentId;
    const isRoot = parent == null || !groupById.has(parent) || parent === group.id;
    if (isRoot) walkGlobal(group.id, false, globalGuard);
  }

  return result;
}

// Verbrauch (kWh) je Gruppe und Zeitraum (heute/Jahr/Vorjahr), baum-konsistent
// mit dem Leistungsmodell: eine Zählergruppe zählt nur ihre eigenen Zähler
// (die den ganzen Zweig messen), sonst additiv eigene Geräte + Untergruppen.
function buildGroupEnergyTree(groups, actorEnergies) {
  const fields = ['todayKwh', 'yearKwh', 'prevYearKwh'];
  const own = new Map();
  for (const g of groups || []) own.set(g.id, { todayKwh: null, yearKwh: null, prevYearKwh: null });
  for (const e of actorEnergies || []) {
    if (e.groupId == null || !own.has(e.groupId)) continue;
    const acc = own.get(e.groupId);
    for (const f of fields) if (e[f] != null) acc[f] = (acc[f] || 0) + e[f];
  }
  const groupById = new Map((groups || []).map((g) => [g.id, g]));
  const childrenByParent = new Map();
  for (const g of groups || []) {
    const parent = g.parentId == null ? null : g.parentId;
    if (parent == null) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(g.id);
  }
  const memo = new Map();
  function total(id, field, guard) {
    const key = id + '|' + field;
    if (memo.has(key)) return memo.get(key);
    if (guard.has(id)) return null; // defensiv gegen Datenzyklen
    guard.add(id);
    const g = groupById.get(id);
    const ownV = own.get(id) ? own.get(id)[field] : null;
    let val;
    if (g && g.meterGroup) {
      val = ownV; // Zählergruppe: fix aus den eigenen Zählern
    } else {
      let acc = 0; let has = false;
      if (ownV != null) { acc += ownV; has = true; }
      for (const childId of childrenByParent.get(id) || []) {
        const cv = total(childId, field, guard);
        if (cv != null) { acc += cv; has = true; }
      }
      val = has ? acc : null;
    }
    guard.delete(id);
    memo.set(key, val);
    return val;
  }
  const result = new Map();
  for (const g of groups || []) {
    result.set(g.id, {
      todayKwh: total(g.id, 'todayKwh', new Set()),
      yearKwh: total(g.id, 'yearKwh', new Set()),
      prevYearKwh: total(g.id, 'prevYearKwh', new Set()),
    });
  }
  return result;
}

// Wie buildGroupEnergyTree, aber lädt Geräte + persistierten Zustand aus der DB.
async function readGroupEnergyTree(db, groups) {
  const actors = await listActors(db);
  const states = await loadStates(db);
  const actorEnergies = actors.map((a) => ({ groupId: a.groupId, ...computeActorEnergy(states.get(a.id)) }));
  return buildGroupEnergyTree(groups, actorEnergies);
}

module.exports = {
  STALL_MS, VALUE_STALE_MS, POWER_ON_THRESHOLD_W,
  buildActorSnapshot, readActorValues, readGroupSums, readGroupPowerTree,
  applyPeriodRollover, computeActorEnergy, buildGroupEnergyTree, readGroupEnergyTree,
  derivedPowerFromState, resolvePowerW, resolveStatus, resolveTopicStatus,
  ratedPowerWatt, updateVirtualState,
  powerToWatt, counterToKwh, parseNumber, parseBool,
};
