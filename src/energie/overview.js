'use strict';

// Datengrundlage der Energie-Übersicht: bündelt die Eckdaten der Seiten
// Photovoltaik, Stromverbrauch und Batterie (sowie den Schaltzustand von
// Grid-Control, sofern das Modul aktiv ist) zu einer Momentaufnahme.
//
// Es werden ausschließlich die schreibfreien Lesevarianten der Aggregationen
// verwendet: die Übersicht zeigt an, sie schreibt keine Summen fort. Die
// Fortschreibung bleibt Aufgabe der Fachseiten und der periodischen Jobs.

const mqttClient = require('../mqtt/client');
const { listPvPlants } = require('../photovoltaik/plants');
const { readPhotovoltaikValues } = require('../photovoltaik/aggregation');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const {
  loadBatterieConfig,
  readBatterieData,
  batteryCapacityKwh,
  batteryUsableStoredKwh,
} = require('../batterie/config');
const { computePrognosis } = require('../prognosis/forecast');
const { prognosisStatusInfo } = require('../prognosis/status');
const { isEnabled } = require('../modules');
const gridControlAutomation = require('../grid-control/automation');

function formatPower(value) {
  if (value == null) return '— W';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value)} W`;
}

function formatEnergy(value) {
  if (value == null) return '— kWh';
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} kWh`;
}

function formatDecimal(value, unit, digits = 1) {
  const parsed = toNumber(value);
  if (parsed == null) return `— ${unit}`;
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(parsed)} ${unit}`;
}

function toNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBreakdown(breakdown = {}) {
  return {
    eigenverbrauch: formatEnergy(breakdown.eigenverbrauch == null ? null : breakdown.eigenverbrauch),
    netzbezug: formatEnergy(breakdown.netzbezug == null ? null : breakdown.netzbezug),
    summe: formatEnergy(breakdown.summe == null ? null : breakdown.summe),
  };
}

// Batterie-Eckdaten: Ladezustand, Leistung, Spannung, Temperatur sowie die
// daraus abgeleitete nutzbare Restenergie bis zum Mindest-Ladezustand.
function buildBatterieSection(config, data) {
  const soc = toNumber(data.soc);
  const power = toNumber(data.power);
  // Der Mindest-SoC kommt bevorzugt vom Broker (dort kann er extern verstellt
  // werden) und fällt sonst auf die gespeicherte Einstellung zurück.
  const brokerMinSoc = toNumber(data.minSoc);
  const minSoc = brokerMinSoc != null ? brokerMinSoc : toNumber(config.minSoc);
  const usableKwh = batteryUsableStoredKwh(config, data.soc, minSoc);
  const capacityKwh = batteryCapacityKwh(config);
  return {
    configured: !!(config.socTopic || config.powerTopic || config.voltageTopic || config.temperaturTopic),
    socPercent: soc == null ? null : Math.min(100, Math.max(0, soc)),
    charging: power != null && power > 0,
    discharging: power != null && power < 0,
    formatted: {
      soc: formatDecimal(soc, '%'),
      power: formatPower(power),
      voltage: formatDecimal(data.voltage, 'V'),
      temperatur: formatDecimal(data.temperatur, '°C'),
      minSoc: formatDecimal(minSoc, '%', 0),
      usable: formatEnergy(usableKwh),
      capacity: formatEnergy(capacityKwh > 0 ? capacityKwh : null),
    },
  };
}

// Prognose-Eckdaten: Ampelbewertung und die Restwerte des laufenden Tages.
// Ohne Simulation (z. B. fehlende Wetterprognose) bleibt der Abschnitt leer und
// die Übersicht zeigt dort nur den Hinweis.
function buildPrognoseSection(prognosis) {
  if (!prognosis || !prognosis.simulation || !prognosis.simulation.today) {
    return { available: false, status: null, formatted: null };
  }
  const simulation = prognosis.simulation;
  const today = simulation.today;
  const status = prognosisStatusInfo(simulation.status);
  const operating = prognosis.operating || {};
  return {
    available: true,
    status: { label: status.label, detail: status.detail, css: status.css },
    autark: operating.autark == null ? null : !!operating.autark,
    formatted: {
      pvRest: formatEnergy(toNumber(today.pvKwh)),
      loadRest: formatEnergy(toNumber(today.loadKwh)),
      gridRest: formatEnergy(toNumber(today.gridKwh)),
      usable: formatEnergy(toNumber(simulation.initialStored)),
      minSoc: formatDecimal(simulation.minSoc, '%', 0),
      socEnd: formatDecimal(today.batterySocEnd, '%', 0),
    },
  };
}

// Momentaufnahme für Seite und JSON-Aktualisierung. Fehler einzelner Bereiche
// dürfen die Übersicht nicht kippen — der betroffene Block zeigt dann Striche.
async function buildEnergieOverview(db) {
  const cache = mqttClient.getCache();
  const plants = await listPvPlants(db).catch(() => []);
  const [pvValues, stromValues, batterieConfig, prognosis] = await Promise.all([
    readPhotovoltaikValues(db, cache, plants).catch(() => ({ plants: [], totals: {} })),
    readStromverbrauchValues(db, cache).catch(() => ({ breakdown: {} })),
    new Promise((resolve) => loadBatterieConfig(db, resolve)),
    // Wie die Prognoseseite selbst: nur der Prognose-Cache, nie ein Netzabruf.
    computePrognosis(db, cache, { allowFetch: false }).catch(() => null),
  ]);
  const batterieData = readBatterieData(cache);
  const pvTotals = pvValues.totals || {};
  const breakdown = stromValues.breakdown || {};
  const gridControlEnabled = isEnabled('grid-control');

  return {
    photovoltaik: {
      plantCount: plants.length,
      formatted: {
        current: formatPower(pvTotals.current == null ? null : pvTotals.current),
        today: formatEnergy(pvTotals.today == null ? null : pvTotals.today),
        week: formatEnergy(pvTotals.week == null ? null : pvTotals.week),
        year: formatEnergy(pvTotals.year == null ? null : pvTotals.year),
        previousYear: formatEnergy(pvTotals.previousYear == null ? null : pvTotals.previousYear),
      },
    },
    strom: {
      formatted: {
        eigenverbrauchPower: formatPower(
          stromValues.eigenverbrauchPower == null ? null : stromValues.eigenverbrauchPower
        ),
        netzbezugPower: formatPower(
          stromValues.netzbezugPower == null ? null : stromValues.netzbezugPower
        ),
        today: formatBreakdown(breakdown.today),
        week: formatBreakdown(breakdown.week),
        year: formatBreakdown(breakdown.year),
      },
    },
    batterie: buildBatterieSection(batterieConfig, batterieData),
    prognose: buildPrognoseSection(prognosis),
    gridControl: {
      enabled: gridControlEnabled,
      state: gridControlEnabled ? gridControlAutomation.getState() : null,
    },
  };
}

module.exports = { buildEnergieOverview };
