'use strict';

const mqttClient = require('../mqtt/client');
const operatingState = require('../operating-state');
const { computePrognosis } = require('./forecast');
const { isEnabled } = require('../modules');
const { loadGridControlConfig } = require('../grid-control/config');
const metrics = require('../runtime-metrics');

function number(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function forecastMetrics(prognosis) {
  const simulation = prognosis.simulation || {};
  const days = Array.isArray(simulation.days) ? simulation.days : [];
  const socValues = days.map((day) => number(day.batterySocEnd, 100));
  if (simulation.nextChargeStart) socValues.push(number(simulation.nextChargeStart.soc, 100));
  return {
    days,
    minSoc: number(simulation.minSoc, 20),
    currentSoc: number(prognosis.battery && prognosis.battery.soc, simulation.soc),
    minProjectedSoc: socValues.length ? Math.min(...socValues) : number(simulation.soc, 0),
    gridKwh: days.reduce((sum, day) => sum + number(day.gridKwh), 0),
    totalBalanceKwh: days.reduce((sum, day) => sum + number(day.pvKwh) - number(day.loadKwh), 0),
    totalSurplusKwh: days.reduce((sum, day) => sum + number(day.surplusKwh), 0),
    today: days[0] || simulation.today || {},
    minimumReached: simulation.minimumReached || null,
    minimumBeforeCharge: !!simulation.minimumBeforeCharge,
    assessmentSoc: number(
      simulation.assessmentSoc,
      simulation.nextChargeStart ? simulation.nextChargeStart.soc : (days[0] && days[0].batterySocEnd)
    ),
    gridBeforeCharge: number(simulation.gridBeforeCharge, 0),
  };
}

function gridParallelLevel(metrics, context) {
  const { minSoc, currentSoc, assessmentSoc, gridBeforeCharge, today } = metrics;
  const fullThreshold = number(context.fullSocThreshold, 90);
  const hasExcess = number(today.balanceKwh, number(today.pvKwh) - number(today.loadKwh)) > 0.5 ||
    number(today.surplusKwh) >= 0.5;
  if (currentSoc < minSoc) {
    return { level: 1, reason: 'Mindest-SoC unterschritten' };
  }
  if (hasExcess && (currentSoc >= fullThreshold || number(today.batterySocEnd) >= fullThreshold)) {
    return { level: 5, reason: `Überschuss bei vollem Akku (Schwelle ${fullThreshold} %)` };
  }
  // Netzparallel betrachtet bewusst nur das Fenster bis zum nächsten
  // Ladebeginn. Risiken späterer Tage übernimmt bei Bedarf das verfügbare Netz.
  if (metrics.minimumBeforeCharge || assessmentSoc <= minSoc + 5) {
    return { level: 2, reason: 'Reserve bis zum nächsten Ladebeginn fast aufgebraucht' };
  }
  if (gridBeforeCharge > 0.05) {
    return { level: 3, reason: 'Netzbedarf vor dem nächsten Ladebeginn erwartet' };
  }
  return { level: 4, reason: 'Bedarf bis zum nächsten Ladebeginn sicher gedeckt' };
}

function offGridLevel(metrics) {
  const { minSoc, currentSoc, minProjectedSoc, today } = metrics;
  const hasExcess = number(today.balanceKwh, number(today.pvKwh) - number(today.loadKwh)) > 0.5 ||
    number(today.surplusKwh) >= 0.5;
  // Im Autarkbetrieb gilt der Akku erst oberhalb 98 % als voll. Dann müssen
  // verfügbare Überschüsse sofort Level 5 freigeben, um Abregelung zu vermeiden.
  if (currentSoc > 98 && hasExcess) {
    return { level: 5, reason: 'Akku über 98 % und Überschuss – Abregelung vermeiden' };
  }
  // Autarkbetrieb reagiert deutlich früher: Das Minimum aller sichtbaren Tage
  // ist wichtiger als nur der heutige Endstand.
  if (currentSoc <= minSoc || metrics.minimumBeforeCharge || metrics.gridKwh > 0.05) {
    return { level: 1, reason: 'Mindeststand in der Mehrtagesprognose gefährdet' };
  }
  if (metrics.minimumReached || minProjectedSoc <= minSoc + 25) {
    return { level: 2, reason: 'Langfristige Reserve gefährdet – Lasten früh begrenzen' };
  }
  if (minProjectedSoc <= minSoc + 45 || metrics.totalBalanceKwh < 0) {
    return { level: 3, reason: 'Mehrtagessaldo erfordert vorsichtigen Betrieb' };
  }
  return { level: 4, reason: 'Autarker Regelbetrieb mit guter Reserve' };
}

function evaluateBehaviorLevel(prognosis, context = {}) {
  const config = prognosis.config || {};
  const metrics = forecastMetrics(prognosis);
  const recommendation = config.behaviorModel === 'off_grid'
    ? offGridLevel(metrics)
    : gridParallelLevel(metrics, context);
  return { ...recommendation, model: config.behaviorModel || 'grid_parallel', metrics };
}

async function loadBehaviorContext(db) {
  if (!isEnabled('grid-control')) return { fullSocThreshold: 90, gridControlActive: false };
  const config = await new Promise((resolve) => loadGridControlConfig(db, resolve));
  return {
    fullSocThreshold: Math.min(100, Math.max(0, 100 - number(config.socUpperOffset, 5))),
    gridControlActive: true,
  };
}

async function getBehaviorRecommendation(db, prognosis) {
  return evaluateBehaviorLevel(prognosis, await loadBehaviorContext(db));
}

async function applyBehaviorLevel(db, prognosis) {
  if (!prognosis || !prognosis.config) return null;
  const currentSoc = number(prognosis.battery && prognosis.battery.soc, null);
  const minSoc = number(prognosis.simulation && prognosis.simulation.minSoc, 20);
  if (currentSoc == null) return null;
  // Sicherheits-Level 1 gehört vollständig der Prognose und greift auch ohne
  // aktiviertes Modell, damit deaktiviertes Grid-Control keine Lücke erzeugt.
  if (currentSoc < minSoc) {
    const recommendation = { level: 1, reason: 'Mindest-SoC unterschritten', model: prognosis.config.behaviorModel };
    await operatingState.setOperatingLevel(db, 1);
    return recommendation;
  }
  if (!prognosis.config.behaviorActive) return null;
  if (!prognosis.simulation || !prognosis.simulation.available) return null;
  const recommendation = await getBehaviorRecommendation(db, prognosis);
  await operatingState.setOperatingLevel(db, recommendation.level);
  return recommendation;
}

async function runNow(db) {
  const prognosis = await computePrognosis(db, mqttClient.getCache(), { allowFetch: false });
  return applyBehaviorLevel(db, prognosis);
}

let timer = null;
let unsubscribe = null;
let debounceTimer = null;
let chain = Promise.resolve();

function runSerialized(db) {
  const run = chain.then(() => runNow(db));
  chain = run.catch(() => {});
  return run;
}

function scheduleRun(db) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSerialized(db).catch(() => {});
  }, 1000);
}

function isRelevantEvent(event) {
  const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
  return keys.some((raw) => {
    const key = String(raw);
    return key === 'batterie.soc' || key === 'batterie.minSoc' ||
      key.startsWith('stromverbrauch_') || key.startsWith('wallbox:');
  });
}

function init(db) {
  if (!unsubscribe) unsubscribe = mqttClient.onValuesChanged((event) => {
    if (isRelevantEvent(event)) scheduleRun(db);
    else metrics.counter('prognosis.irrelevantEvents');
  });
  if (!timer) timer = setInterval(() => metrics.measure('prognosis.behavior', () => runSerialized(db)).catch(() => {}), 30000);
  return runSerialized(db);
}

module.exports = {
  evaluateBehaviorLevel, getBehaviorRecommendation, applyBehaviorLevel,
  loadBehaviorContext, runNow, init, forecastMetrics, isRelevantEvent,
};
