'use strict';

// Katalog der auswählbaren internen Werte für Outputs. Angeboten werden die von
// home-ess BERECHNETEN Werte (Leistungen, Erträge, Summen, direkte Sonne) – nicht
// die Roh-Inputs aus dem ioBroker. Jeder Eintrag liefert:
//   id       – stabiler Schlüssel
//   label    – Anzeigename (alphabetisch sortiert)
//   value    – Roh-Wert zum Publizieren (Zahl/Boolean) oder null
//   display  – formatierte Anzeige für die Oberfläche
//   category – Herkunft des Wertes (Seite), abgeleitet aus dem id-Präfix

const { listPvPlants } = require('../photovoltaik/plants');
const { readPhotovoltaikValues } = require('../photovoltaik/aggregation');
const { computePvForecast } = require('../photovoltaik/forecast');
const { computeInstantSunIntensity, readSunIntensityAverages } = require('../photovoltaik/sun-intensity');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const {
  loadBatterieConfig, readBatterieData, batteryRemainingKwh,
  batteryCapacityKwh,
  batteryUsableStoredKwh, batteryTimeToLimitHours,
  batteryStatus, updateBatteryDailyState,
} = require('../batterie/config');
const { loadPoolConfig, readPoolValue } = require('../pool/config');
const { listWallboxes } = require('../wallbox/boxes');
const { readWallboxValues, readAggregateDailyHistory } = require('../wallbox/aggregation');
const wallboxAutomation = require('../wallbox/automation');
const { listActors } = require('../messen-schalten/actors');
const { listGroups: listMessSchaltGroups } = require('../messen-schalten/groups');
const { readActorValues, readGroupSums } = require('../messen-schalten/aggregation');
const { readFunctionValues } = require('../messen-schalten/functions');
const { isEnabled } = require('../modules');
const { getState: getGridControlState } = require('../grid-control/automation');
const operatingState = require('../operating-state');
const { loadPrognosisConfig } = require('../prognosis/config');
const { buildConsumptionModel, simulateDays } = require('../prognosis/forecast');
const { getBehaviorRecommendation } = require('../prognosis/behavior');
const { buildStatesTree, forEachState } = require('../adapters/states');
const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { computeYearStats, getDailyMetricValue, statsFromRows, dayKeyOffset } = require('../history/daily-metrics');
const metrics = require('../runtime-metrics');

// Kategorien entsprechen der Herkunft des Wertes (Seite, von der er stammt) und
// werden anhand des stabilen id-Präfix zugeordnet. Die Reihenfolge bestimmt die
// Anzeige im Wertekatalog.
const VALUE_CATEGORIES = [
  'Photovoltaik',
  'Stromverbrauch',
  'Batterie',
  'Prognose',
  'Netzsteuerung',
  'Pool',
  'Wallbox',
  'Geräte',
  'Funktionen',
  'Verbrauchssummen',
  'Betrieb',
  'Sonstiges',
];

const CATEGORY_BY_PREFIX = [
  ['pv.', 'Photovoltaik'],
  ['sun.', 'Photovoltaik'],
  ['strom.', 'Stromverbrauch'],
  ['batterie.', 'Batterie'],
  ['prognose.', 'Prognose'],
  ['grid.', 'Netzsteuerung'],
  ['pool.', 'Pool'],
  ['wallbox.', 'Wallbox'],
  ['geraet.', 'Geräte'],
  ['funktion.', 'Funktionen'],
  ['verbrauchssumme.', 'Verbrauchssummen'],
  ['operating.', 'Betrieb'],
];

function categoryForId(id) {
  for (const [prefix, name] of CATEGORY_BY_PREFIX) {
    if (String(id).startsWith(prefix)) return name;
  }
  return 'Sonstiges';
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function powerEntry(id, label, value) {
  const rounded = value == null ? null : roundTo(value, 0);
  return {
    id,
    label,
    value: rounded,
    display: rounded == null ? '— W' : `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(rounded)} W`,
  };
}

function energyEntry(id, label, value) {
  const rounded = value == null ? null : roundTo(value, 2);
  return {
    id,
    label,
    value: rounded,
    display:
      rounded == null
        ? '— kWh'
        : `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded)} kWh`,
  };
}

function boolEntry(id, label, value) {
  return {
    id,
    label,
    value: value === true,
    display: value === true ? 'Ja' : 'Nein',
  };
}

function temperaturEntry(id, label, rawValue) {
  const n = rawValue == null ? null : parseFloat(String(rawValue).replace(',', '.'));
  const rounded = Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  return { id, label, value: rounded, display: rounded == null ? '— °C' : `${rounded.toFixed(1).replace('.', ',')} °C` };
}

function voltageEntry(id, label, rawValue) {
  const n = rawValue == null ? null : parseFloat(String(rawValue).replace(',', '.'));
  const rounded = Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  return { id, label, value: rounded, display: rounded == null ? '— V' : `${rounded.toFixed(1).replace('.', ',')} V` };
}

function pumpEntry(id, label, rawValue) {
  const on = rawValue != null && (rawValue === true || rawValue === 'true' || rawValue === 1 || rawValue === '1');
  return { id, label, value: on ? 1 : 0, display: rawValue == null ? '—' : (on ? 'Ein' : 'Aus') };
}

function phEntry(id, label, rawValue) {
  const n = rawValue == null ? null : parseFloat(String(rawValue).replace(',', '.'));
  const rounded = Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  return { id, label, value: rounded, display: rounded == null ? '—' : rounded.toFixed(2).replace('.', ',') };
}

function percentEntry(id, label, value) {
  const rounded = value == null ? null : roundTo(value, 0);
  return {
    id,
    label,
    value: rounded,
    display: rounded == null ? '— %' : `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(rounded)} %`,
  };
}

function numberEntry(id, label, value) {
  const rounded = value == null ? null : roundTo(value, 0);
  return { id, label, value: rounded, display: rounded == null ? '—' : String(rounded) };
}

function secondsUntilNextCharge(nextCharge, now = Date.now()) {
  if (!nextCharge) return 0;
  return Math.max(0, Math.round((nextCharge.at - now) / 1000));
}

function timeEntry(id, label, decimalHour) {
  const value = decimalHour == null ? null : roundTo(decimalHour, 2);
  if (value == null) return { id, label, value: null, display: '—' };
  const minutes = Math.max(0, Math.min(1439, Math.round(value * 60)));
  const display = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} Uhr`;
  return { id, label, value, display };
}

function decimalEntry(id, label, value, unit = '') {
  const rounded = value == null ? null : roundTo(value, 2);
  return {
    id, label, value: rounded,
    display: rounded == null ? '—' : `${rounded.toLocaleString('de-DE', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`,
  };
}

// Für Statistik-Werte aus der Tageshistorie (gestern/Durchschnitt/Min/Max):
// solange noch kein abgeschlossener Tag vorliegt, 0 statt "—" anzeigen, damit
// beim manuellen Abgleich ein eindeutiger Startwert erkennbar ist.
function orZero(value) {
  return value == null ? 0 : value;
}

// Für die Min-/Max-Datumsfelder: fehlt noch ein Datum (keine Historie), auf den
// 1. Januar des aktuellen Jahres statt "—" setzen.
function orYearStart(dayKey, yearKey) {
  return dayKey || `${yearKey}-01-01`;
}

// Durchschnittlicher Tageswert dieses Jahres = laufende Jahressumme geteilt durch
// die Zahl der bereits angebrochenen Tage. Bewusst nicht das Mittel der
// historisierten Einzeltage: die Tageshistorie beginnt erst ab Einführung dieser
// Funktion und wäre daher nie repräsentativ. So bleibt der Wert konsistent mit den
// Jahressummen (analog zur ioBroker-Rechnung Jahr ÷ DayCount).
function avgPerDay(yearValue, dayOfYear) {
  if (yearValue == null || !(dayOfYear > 0)) return 0;
  return yearValue / dayOfYear;
}

function dateEntry(id, label, dayKeyValue) {
  if (!dayKeyValue) return { id, label, value: null, display: '—' };
  const [year, month, day] = String(dayKeyValue).split('-');
  return { id, label, value: dayKeyValue, display: `${day}.${month}.${year}` };
}

function hoursEntry(id, label, value) {
  const rounded = value == null ? null : roundTo(value, 2);
  return {
    id, label, value: rounded,
    display: rounded == null
      ? '— h'
      : `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded)} h`,
  };
}

const PERIODS = [
  { key: 'today', label: 'heute' },
  { key: 'week', label: 'Woche' },
  { key: 'year', label: 'Jahr' },
  { key: 'previousYear', label: 'Vorjahr' },
];

// PV-Prognose: erwarteter Tagesertrag je Tagesindex (0 = heute … 3 = +3 Tage).
const FORECAST_VALUES = [
  { id: 'pv.forecast.today', index: 0, label: 'PV Prognose Ertrag heute' },
  { id: 'pv.forecast.tomorrow', index: 1, label: 'PV Prognose Ertrag morgen' },
  { id: 'pv.forecast.day2', index: 2, label: 'PV Prognose Ertrag in 2 Tagen' },
  { id: 'pv.forecast.day3', index: 3, label: 'PV Prognose Ertrag in 3 Tagen' },
];

async function buildInternalValues(db, cache) {
  const plants = await listPvPlants(db);
  const batCfg = await new Promise((resolve) => loadBatterieConfig(db, resolve));
  const poolCfg = isEnabled('pool') ? await new Promise((resolve) => loadPoolConfig(db, resolve)) : null;
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  // Für die Jahres-Statistik (gestern/Durchschnitt/Min/Max) aus der Tageshistorie:
  // dasselbe lokale Kalenderdatum, das auch die Tageswechsel-Erkennung der
  // Aggregationen verwendet.
  const calendar = localCalendar(cache, mqttConfig.timezone);
  const yesterdayKey = dayKeyOffset(calendar.dateKey, -1);
  // Angebrochene Tage des laufenden Jahres (1 = 1. Januar) für den Tagesdurchschnitt.
  const dayOfYear = Math.floor(
    (Date.UTC(calendar.year, calendar.month - 1, calendar.day) - Date.UTC(calendar.year, 0, 1)) / 86400000
  ) + 1;

  const [pv, strom, sunIntensity, sunIntensityNow, forecast, prognosisConfig] = await Promise.all([
    readPhotovoltaikValues(db, cache, plants),
    readStromverbrauchValues(db, cache),
    readSunIntensityAverages(db),
    computeInstantSunIntensity(db, cache),
    // Prognose ohne blockierenden Netzwerkabruf (nur Cache) – gefüllt vom periodischen Job.
    computePvForecast(db, plants, { allowFetch: false, cache }).catch(() => null),
    loadPrognosisConfig(db),
  ]);

  const entries = [];

  // Globaler Tagesstatus: bleibt nach einer Mindest-SoC-Netzschaltung bis zum
  // nächsten Tageswechsel auf false.
  entries.push(boolEntry('operating.autark', 'Autark', operatingState.getState().autark));
  entries.push(boolEntry('operating.notstrom', 'Notstrombetrieb', operatingState.getState().emergencyMode));
  entries.push(numberEntry('prognose.autarkeTageJahr', 'Prognose autarke Tage im Jahr', operatingState.getState().autarkDaysCount));
  entries.push(numberEntry(
    'prognose.autarkeTageVorjahr',
    'Prognose autarke Tage im Vorjahr',
    operatingState.getState().autarkDaysPreviousYearCount
  ));

  // Photovoltaik – Gesamtwerte
  entries.push(boolEntry('pv.directSunlight', 'Direkte Sonneneinstrahlung', pv.totals.directSunlight));

  // Sonnenintensität (Clear-Sky-Modell, in %, auf 100% gedeckelt)
  entries.push(percentEntry('sun.intensity.current', 'Sonnenintensität aktuell', sunIntensityNow));
  entries.push(percentEntry('sun.intensity.last10min', 'Sonnenintensität 10-Minuten-Mittel', sunIntensity.last10min));
  entries.push(percentEntry('sun.intensity.today', 'Sonnenintensität Tagesmittel', sunIntensity.today));
  entries.push(percentEntry('sun.intensity.yesterday', 'Sonnenintensität Vortagsmittel', sunIntensity.yesterday));
  entries.push(powerEntry('pv.current', 'PV Leistung aktuell', pv.totals.current));
  entries.push(powerEntry('pv.ideal', 'PV Leistung ideal', pv.totals.ideal));
  entries.push(powerEntry('pv.shadow', 'PV Leistung Schatten', pv.totals.shadow));
  entries.push(energyEntry('pv.today', 'PV Ertrag heute', pv.totals.today));
  entries.push(energyEntry('pv.week', 'PV Ertrag Woche', pv.totals.week));
  entries.push(energyEntry('pv.year', 'PV Ertrag Jahr', pv.totals.year));
  entries.push(energyEntry('pv.previousYear', 'PV Ertrag Vorjahr', pv.totals.previousYear));

  // Photovoltaik – Jahres-Statistik aus der Tageshistorie (ab Einführung dieser
  // Funktion; keine rückwirkende Befüllung möglich).
  const pvYesterday = await getDailyMetricValue(db, 'pv', yesterdayKey);
  const pvYearStats = await computeYearStats(db, 'pv', calendar.yearKey);
  entries.push(energyEntry('pv.yesterday', 'PV Ertrag gestern', orZero(pvYesterday)));
  entries.push(energyEntry('pv.avgYear', 'PV Ertrag Durchschnitt dieses Jahr', avgPerDay(pv.totals.year, dayOfYear)));
  entries.push(energyEntry('pv.minYear', 'PV Ertrag Minimum dieses Jahr', orZero(pvYearStats.min)));
  entries.push(dateEntry('pv.minYearDate', 'PV Ertrag Minimum dieses Jahr – Datum', orYearStart(pvYearStats.minDate, calendar.yearKey)));
  entries.push(energyEntry('pv.maxYear', 'PV Ertrag Maximum dieses Jahr', orZero(pvYearStats.max)));
  entries.push(dateEntry('pv.maxYearDate', 'PV Ertrag Maximum dieses Jahr – Datum', orYearStart(pvYearStats.maxDate, calendar.yearKey)));

  // Photovoltaik – Wetterprognose (Open-Meteo): erwarteter Tagesertrag heute + 3 Tage.
  // Tagesindex ist stabil (0 = heute), unabhängig vom Wochentag-Label der Oberfläche.
  const forecastDays = forecast && Array.isArray(forecast.days) ? forecast.days : [];
  for (const fc of FORECAST_VALUES) {
    const day = forecastDays[fc.index];
    entries.push(energyEntry(fc.id, fc.label, day ? day.totalKwh : null));
  }
  // Heutigen Prognose-Tagesertrag aufgeteilt: bis zum aktuellen Moment „bereits"
  // (Soll-Stand) und der für den Rest des Tages „noch" erwartete Ertrag.
  entries.push(energyEntry('pv.forecast.today.elapsed', 'PV Prognose Ertrag heute (bisher)', forecast ? forecast.todayElapsedKwh : null));
  entries.push(energyEntry('pv.forecast.today.remaining', 'PV Prognose Ertrag heute (noch)', forecast ? forecast.todayRemainingKwh : null));
  // Erwartete Momentanleistung laut Prognose (Stundenmittel der aktuellen Stunde).
  entries.push(powerEntry('pv.forecast.current', 'PV Prognose Leistung aktuell', forecast ? forecast.currentPowerWatt : null));

  // Photovoltaik – je Anlage
  for (const plant of pv.plants) {
    entries.push(powerEntry(`pv.plant.${plant.id}.current`, `PV ${plant.name} – Leistung aktuell`, plant.current));
    entries.push(powerEntry(`pv.plant.${plant.id}.ideal`, `PV ${plant.name} – Leistung ideal`, plant.ideal));
    entries.push(powerEntry(`pv.plant.${plant.id}.shadow`, `PV ${plant.name} – Leistung Schatten`, plant.shadow));
    entries.push(energyEntry(`pv.plant.${plant.id}.today`, `PV ${plant.name} – Ertrag heute`, plant.today));
    entries.push(boolEntry(`pv.plant.${plant.id}.directSunlight`, `PV ${plant.name} – direkte Sonne`, plant.directSunlight));
  }

  // Stromverbrauch – Leistungen
  entries.push(powerEntry('strom.eigenverbrauch.power', 'Eigenverbrauch Leistung', strom.eigenverbrauchPower));
  entries.push(powerEntry('strom.netzbezug.power', 'Netzbezug Leistung', strom.netzbezugPower));

  // Stromverbrauch – Energie je Zeitraum
  for (const period of PERIODS) {
    const bd = strom.breakdown[period.key];
    const cs = strom.counterSums[period.key];
    entries.push(energyEntry(`strom.eigenverbrauch.${period.key}`, `Eigenverbrauch ${period.label}`, bd.eigenverbrauch));
    entries.push(energyEntry(`strom.netzbezug.${period.key}`, `Netzbezug ${period.label}`, bd.netzbezug));
    entries.push(energyEntry(`strom.verbrauch.${period.key}`, `Verbrauch gesamt ${period.label}`, bd.summe));
    entries.push(energyEntry(`strom.bezug.summe.${period.key}`, `Netzbezug Zählersumme ${period.label}`, cs.import));
    entries.push(energyEntry(`strom.einspeisung.summe.${period.key}`, `Einspeisung Zählersumme ${period.label}`, cs.export));
  }

  // Netzbezug/Eigenverbrauch – Jahres-Statistik aus der Tageshistorie (ab
  // Einführung dieser Funktion; keine rückwirkende Befüllung möglich).
  const eigenverbrauchYesterday = await getDailyMetricValue(db, 'strom.eigenverbrauch', yesterdayKey);
  const netzbezugYesterday = await getDailyMetricValue(db, 'strom.netzbezug', yesterdayKey);
  const eigenverbrauchYearStats = await computeYearStats(db, 'strom.eigenverbrauch', calendar.yearKey);
  const netzbezugYearStats = await computeYearStats(db, 'strom.netzbezug', calendar.yearKey);
  entries.push(energyEntry('strom.eigenverbrauch.yesterday', 'Eigenverbrauch gestern', orZero(eigenverbrauchYesterday)));
  entries.push(energyEntry('strom.eigenverbrauch.avgYear', 'Eigenverbrauch Durchschnitt dieses Jahr', avgPerDay(strom.breakdown.year.eigenverbrauch, dayOfYear)));
  entries.push(energyEntry('strom.eigenverbrauch.minYear', 'Eigenverbrauch Minimum dieses Jahr', orZero(eigenverbrauchYearStats.min)));
  entries.push(dateEntry('strom.eigenverbrauch.minYearDate', 'Eigenverbrauch Minimum dieses Jahr – Datum', orYearStart(eigenverbrauchYearStats.minDate, calendar.yearKey)));
  entries.push(energyEntry('strom.eigenverbrauch.maxYear', 'Eigenverbrauch Maximum dieses Jahr', orZero(eigenverbrauchYearStats.max)));
  entries.push(dateEntry('strom.eigenverbrauch.maxYearDate', 'Eigenverbrauch Maximum dieses Jahr – Datum', orYearStart(eigenverbrauchYearStats.maxDate, calendar.yearKey)));
  entries.push(energyEntry('strom.netzbezug.yesterday', 'Netzbezug gestern', orZero(netzbezugYesterday)));
  entries.push(energyEntry('strom.netzbezug.avgYear', 'Netzbezug Durchschnitt dieses Jahr', avgPerDay(strom.breakdown.year.netzbezug, dayOfYear)));
  entries.push(energyEntry('strom.netzbezug.minYear', 'Netzbezug Minimum dieses Jahr', orZero(netzbezugYearStats.min)));
  entries.push(dateEntry('strom.netzbezug.minYearDate', 'Netzbezug Minimum dieses Jahr – Datum', orYearStart(netzbezugYearStats.minDate, calendar.yearKey)));
  entries.push(energyEntry('strom.netzbezug.maxYear', 'Netzbezug Maximum dieses Jahr', orZero(netzbezugYearStats.max)));
  entries.push(dateEntry('strom.netzbezug.maxYearDate', 'Netzbezug Maximum dieses Jahr – Datum', orYearStart(netzbezugYearStats.maxDate, calendar.yearKey)));

  // Batterie
  const bat = readBatterieData(cache);
  if (batCfg.socTopic) {
    entries.push(percentEntry('batterie.soc', 'Batterie Ladezustand (SoC)', bat.soc));
    entries.push(energyEntry(
      'batterie.freieKapazitaet',
      'Batterie freie Kapazität bis voll',
      batteryRemainingKwh(batCfg, bat.soc)
    ));
    entries.push(energyEntry(
      'batterie.nutzbarBisMindestSoc',
      'Batterie nutzbare Energie bis Mindest-SoC',
      batteryUsableStoredKwh(batCfg, bat.soc, bat.minSoc)
    ));
    if (batCfg.powerTopic) {
      entries.push(hoursEntry(
        'batterie.restzeitBisGrenze',
        'Batterie Restzeit bis 100 % oder Mindest-SoC',
        batteryTimeToLimitHours(batCfg, bat.soc, bat.minSoc, bat.power)
      ));
    }
  }
  if (batCfg.powerTopic)    entries.push(powerEntry  ('batterie.power',     'Batterie Leistung',         bat.power));
  if (batCfg.voltageTopic)  entries.push(voltageEntry('batterie.voltage',   'Batterie Spannung',         bat.voltage));
  if (batCfg.temperaturTopic) entries.push(temperaturEntry('batterie.temperatur', 'Batterie Temperatur', bat.temperatur));

  // Systemprognose – nutzt dieselben bereits gelesenen PV-, Verbrauchs- und
  // Batteriedaten wie die Prognoseseite und bleibt dadurch im Output konsistent.
  const consumptionModel = await buildConsumptionModel(db, strom, prognosisConfig, cache, forecast, {
    capacityKwh: batteryCapacityKwh(batCfg),
    minSoc: Number.isFinite(Number(bat.minSoc)) ? Number(bat.minSoc) : Number(batCfg.minSoc),
    soc: Number.isFinite(Number(bat.soc)) ? Number(bat.soc) : Number(batCfg.minSoc),
    chargeEfficiency: batCfg.chargeEfficiency / 100,
    dischargeEfficiency: batCfg.dischargeEfficiency / 100,
  });
  const gridState = getGridControlState();
  const currentSoc = Number(String(bat.soc == null ? '' : bat.soc).replace(',', '.'));
  const isCurrentlyFull = Number.isFinite(currentSoc) && currentSoc > 98;
  const chargedToday = await updateBatteryDailyState(
    db,
    `${consumptionModel.local.date.year}-${String(consumptionModel.local.date.month).padStart(2, '0')}-${String(consumptionModel.local.date.day).padStart(2, '0')}`,
    isCurrentlyFull
  );
  const status = batteryStatus(batCfg, bat, {
    chargedToday,
    overflow: (strom.netzbezugPower != null && Number(strom.netzbezugPower) < 0) ||
      (isEnabled('grid-control') && !!gridState.feedInActual),
  });
  entries.push(boolEntry('batterie.charge', 'Batterie Charge', status.charge));
  entries.push(boolEntry('batterie.chargedToday', 'Batterie Charged today', status.chargedToday));
  entries.push(boolEntry('batterie.discharging', 'Batterie Discharging', status.discharging));
  entries.push(boolEntry('batterie.empty', 'Batterie Empty', status.empty));
  entries.push(decimalEntry('batterie.emptySoc', 'Batterie EmptySOC', status.emptySoc, '%'));
  entries.push(boolEntry('batterie.full', 'Batterie Full', status.full));
  entries.push(boolEntry('batterie.good', 'Batterie Good', status.good));
  entries.push(boolEntry('batterie.halfCharged', 'Batterie HalfCharged', status.halfCharged));
  entries.push(decimalEntry('batterie.halfChargedSoc', 'Batterie HalfChargedSOC', status.halfChargedSoc, '%'));
  entries.push(boolEntry('batterie.high', 'Batterie High', status.high));
  entries.push(decimalEntry('batterie.minimalSoc', 'Batterie MinimalSOC', status.minimalSoc, '%'));
  entries.push(boolEntry('batterie.overflow', 'Batterie Overflow', status.overflow));
  entries.push(boolEntry('batterie.reserve', 'Batterie Reserve', status.reserve));
  entries.push(decimalEntry('batterie.reserveSoc', 'Batterie ReserveSOC', status.reserveSoc, '%'));
  const prognosis = simulateDays({
    forecast,
    model: consumptionModel,
    config: prognosisConfig,
    batteryConfig: batCfg,
    batteryData: bat,
  });
  const behaviorRecommendation = await getBehaviorRecommendation(db, {
    config: prognosisConfig,
    battery: bat,
    simulation: prognosis,
  });
  const prognosisToday = prognosis.today;
  const prognosisTomorrow = prognosis.days[1] || null;
  const freeBatteryKwh = batteryRemainingKwh(batCfg, bat.soc);
  const consumptionToSunrise = consumptionModel.consumptionToSunrise;
  const recentDailyProjection = consumptionModel.recentHourKwh == null
    ? null
    : consumptionModel.recentHourKwh * 24;
  const recentConsumptionToSunrise = consumptionModel.recentHourKwh == null || consumptionModel.hoursToSunrise == null
    ? null
    : consumptionModel.recentHourKwh * consumptionModel.hoursToSunrise;
  entries.push(numberEntry('prognose.status', 'Prognose Status (0 rot, 1 gelb, 2 grün)', prognosis.status));
  entries.push(numberEntry('operating.level', 'Betriebslevel', operatingState.getState().operatingLevel));
  entries.push(boolEntry('prognose.verhaltensmodellAktiv', 'Prognose Verhaltensmodell aktiv', prognosisConfig.behaviorActive));
  entries.push(numberEntry(
    'prognose.verhaltensmodell',
    'Prognose Verhaltensmodell (0 Netzparallel, 1 Autark)',
    prognosisConfig.behaviorModel === 'off_grid' ? 1 : 0
  ));
  entries.push(numberEntry('prognose.betriebslevelEmpfehlung', 'Prognose Betriebslevel Empfehlung', behaviorRecommendation.level));
  entries.push(boolEntry(
    'prognose.bedarfGedeckt',
    'Prognose Bedarf bis Ladebeginn gedeckt',
    prognosis.available && prognosis.gridBeforeCharge <= 0.05 && !prognosis.minimumBeforeCharge
  ));
  entries.push(boolEntry('prognose.batterieVoll', 'Prognose Batterie heute voll', prognosisToday.batteryFull));
  entries.push(energyEntry('prognose.batterieNutzbar', 'Prognose Batterie nutzbar', prognosis.initialStored));
  entries.push(percentEntry('prognose.batterieSocTagesende', 'Prognose Batterie SoC Tagesende', prognosisToday.batterySocEnd));
  entries.push(percentEntry(
    'prognose.batterieSocLadebeginn',
    'Prognose Batterie SoC bei Ladebeginn Folgetag',
    prognosis.nextChargeStart ? prognosis.nextChargeStart.soc : null
  ));
  entries.push(timeEntry(
    'prognose.ladebeginnUhrzeit',
    'Prognose Batterie Ladebeginn Folgetag Uhrzeit',
    prognosis.nextChargeStart ? prognosis.nextChargeStart.hour : null
  ));
  entries.push(numberEntry(
    'prognose.ladebeginnTage',
    'Prognose Batterie Ladebeginn Folgetag in Tagen',
    prognosis.nextChargeStart ? prognosis.nextChargeStart.dayOffset : null
  ));
  entries.push(boolEntry(
    'prognose.batterieMindeststandErreicht',
    'Prognose Batterie Mindeststand wird erreicht',
    !!prognosis.minimumReached
  ));
  entries.push(timeEntry(
    'prognose.batterieMindeststandUhrzeit',
    'Prognose Batterie Mindeststand Uhrzeit',
    prognosis.minimumReached ? prognosis.minimumReached.hour : null
  ));
  entries.push(numberEntry(
    'prognose.batterieMindeststandTage',
    'Prognose Batterie Mindeststand in Tagen',
    prognosis.minimumReached ? prognosis.minimumReached.dayOffset : null
  ));
  entries.push(energyEntry('prognose.verbrauchTag', 'Prognose Verbrauch heute gesamt', consumptionModel.today + prognosisToday.loadKwh));
  entries.push(energyEntry('prognose.verbrauchDurchschnitt', 'Prognose Hausverbrauch durchschnittlich pro Tag', consumptionModel.dailyTarget));
  entries.push(energyEntry('prognose.verbrauchHochrechnungLetzteStunde', 'Prognose Hausverbrauch Tageshochrechnung aus letzter Stunde', recentDailyProjection));
  entries.push(energyEntry('prognose.verbrauchBisSonnenaufgang', 'Prognose Verbrauch bis Sonnenaufgang', consumptionToSunrise));
  entries.push(energyEntry('prognose.verbrauchBisSonnenaufgangLetzteStunde', 'Prognose Verbrauch bis Sonnenaufgang aus letzter Stunde', recentConsumptionToSunrise));
  entries.push(energyEntry('prognose.verbrauchRest', 'Prognose Verbrauch heute noch', prognosisToday.loadKwh));
  entries.push(energyEntry('prognose.pvRest', 'Prognose PV-Ertrag heute noch', prognosisToday.pvKwh));
  entries.push(energyEntry('prognose.netzbedarf', 'Prognose Netzbedarf heute', prognosisToday.gridKwh));
  entries.push(energyEntry('prognose.ueberschuss', 'Prognose Überschuss heute', prognosisToday.surplusKwh));
  entries.push(energyEntry('prognose.verbrauchMorgen', 'Prognose Verbrauch morgen', prognosisTomorrow ? prognosisTomorrow.loadKwh : null));
  entries.push(energyEntry('prognose.pvMorgen', 'Prognose PV-Ertrag morgen', prognosisTomorrow ? prognosisTomorrow.pvKwh : null));
  entries.push(energyEntry('prognose.netzbedarfMorgen', 'Prognose Netzbedarf morgen', prognosisTomorrow ? prognosisTomorrow.gridKwh : null));
  entries.push(energyEntry(
    'prognose.bedarfMorgen',
    'Prognose Bedarf morgen inklusive Akkufüllung',
    prognosisTomorrow && freeBatteryKwh != null ? prognosisTomorrow.loadKwh + freeBatteryKwh : null
  ));
  entries.push(energyEntry(
    'prognose.gesamtbedarfBisSonnenaufgang',
    'Prognose Gesamtbedarf bis Sonnenaufgang inklusive Akkufüllung',
    consumptionToSunrise == null || freeBatteryKwh == null ? null : consumptionToSunrise + freeBatteryKwh
  ));
  entries.push(energyEntry(
    'prognose.kwhFehlen',
    'Prognose fehlende Energie bis Ladebeginn',
    prognosis.available ? prognosis.gridBeforeCharge : null
  ));
  entries.push(energyEntry('prognose.kwhFrei', 'Prognose freie Überschussenergie heute', prognosisToday.surplusKwh));
  entries.push(energyEntry(
    'prognose.verfuegbar',
    'Prognose verfügbare Energie aus Akku und PV heute',
    prognosis.available ? prognosis.initialStored + prognosisToday.pvKwh : null
  ));
  entries.push(energyEntry('prognose.funktionsVerbrauchHeute', 'Prognose Funktionslasten heute noch', prognosisToday.functionsKwh));
  entries.push(energyEntry('prognose.funktionsVerbrauchMorgen', 'Prognose Funktionslasten morgen', prognosisTomorrow ? prognosisTomorrow.functionsKwh : null));
  entries.push(energyEntry('prognose.wallboxVerbrauchHeute', 'Prognose Wallbox-Verbrauch heute noch', prognosisToday.wallboxKwh));
  entries.push(energyEntry('prognose.wallboxVerbrauchMorgen', 'Prognose Wallbox-Verbrauch morgen', prognosisTomorrow ? prognosisTomorrow.wallboxKwh : null));
  for (const box of (consumptionModel.wallboxModel && consumptionModel.wallboxModel.boxes) || []) {
    const todayBox = (prognosisToday.wallboxes || []).find((entry) => entry.id === box.id);
    const tomorrowBox = prognosisTomorrow
      ? (prognosisTomorrow.wallboxes || []).find((entry) => entry.id === box.id)
      : null;
    entries.push(energyEntry(
      `prognose.wallbox.${box.id}.heute`,
      `Prognose Wallbox ${box.name} – Verbrauch heute noch`,
      todayBox ? todayBox.energyKwh : null
    ));
    entries.push(energyEntry(
      `prognose.wallbox.${box.id}.morgen`,
      `Prognose Wallbox ${box.name} – Verbrauch morgen`,
      tomorrowBox ? tomorrowBox.energyKwh : null
    ));
  }

  // Pool (nur wenn Modul aktiv)
  if (poolCfg) {
    if (poolCfg.temperatureTopic)    entries.push(temperaturEntry('pool.wassertemperatur', 'Pool Wassertemperatur', readPoolValue(cache, poolCfg.temperatureTopic)));
    if (poolCfg.solarPumpStatusTopic) entries.push(pumpEntry     ('pool.solarPumpe',       'Pool Solarpumpe',       readPoolValue(cache, poolCfg.solarPumpStatusTopic)));
    if (poolCfg.filterPumpStatusTopic) entries.push(pumpEntry    ('pool.filterPumpe',      'Pool Filterpumpe',      readPoolValue(cache, poolCfg.filterPumpStatusTopic)));
    if (poolCfg.phTopic)             entries.push(phEntry        ('pool.ph',               'Pool pH-Wert',          readPoolValue(cache, poolCfg.phTopic)));
    if (poolCfg.chlorTopic)          entries.push(phEntry        ('pool.chlor',            'Pool Chlor (mg/l)',     readPoolValue(cache, poolCfg.chlorTopic)));
  }

  // Wallbox (nur wenn Modul aktiv): je Box Leistung, SoC, Plugged, Modus und
  // historische Energien (Tag/Woche/Monat/Jahr/Vorjahr).
  if (isEnabled('wallbox')) {
    const wbBoxes = await listWallboxes(db);
    const wbValues = await readWallboxValues(db, cache, wbBoxes);
    for (const wb of wbValues) {
      entries.push(powerEntry(`wallbox.${wb.id}.power`, `Wallbox ${wb.name} – Leistung`, wb.powerW));
      entries.push(percentEntry(`wallbox.${wb.id}.soc`, `Wallbox ${wb.name} – Fahrzeug-SoC`, wb.soc));
      entries.push(boolEntry(`wallbox.${wb.id}.plugged`, `Wallbox ${wb.name} – angesteckt`, wb.plugged === true));
      entries.push(numberEntry(`wallbox.${wb.id}.modus`, `Wallbox ${wb.name} – Lademodus (1 Privat, 2 Beruflich, 3 Immer voll)`, wb.mode));
      entries.push(energyEntry(`wallbox.${wb.id}.today`, `Wallbox ${wb.name} – Verbrauch heute`, wb.energy.today));
      entries.push(energyEntry(`wallbox.${wb.id}.week`, `Wallbox ${wb.name} – Verbrauch Woche`, wb.energy.week));
      entries.push(energyEntry(`wallbox.${wb.id}.month`, `Wallbox ${wb.name} – Verbrauch Monat`, wb.energy.month));
      entries.push(energyEntry(`wallbox.${wb.id}.year`, `Wallbox ${wb.name} – Verbrauch Jahr`, wb.energy.year));
      entries.push(energyEntry(`wallbox.${wb.id}.previousYear`, `Wallbox ${wb.name} – Verbrauch Vorjahr`, wb.energy.previousYear));
      // Voraussichtlicher nächster Ladebeginn (nur wenn gerade nicht geladen wird):
      // Restzeit in Sekunden plus Uhrzeit der erwarteten Stunde.
      const nextCharge = wallboxAutomation.getNextCharge(wb.id);
      const secondsToCharge = secondsUntilNextCharge(nextCharge);
      entries.push(numberEntry(`wallbox.${wb.id}.naechsterLadebeginnSekunden`, `Wallbox ${wb.name} – nächster Ladebeginn in Sekunden`, secondsToCharge));
      entries.push(timeEntry(`wallbox.${wb.id}.naechsterLadebeginn`, `Wallbox ${wb.name} – nächster Ladebeginn Uhrzeit`, nextCharge ? nextCharge.hour : null));
    }

    // E-Auto gesamt: alle Wallboxen zusammengefasst (heute/Jahr/Vorjahr aus den
    // laufenden Summen je Box, gestern/Durchschnitt/Min/Max aus der je Tag über
    // alle Boxen summierten Tageshistorie).
    if (wbValues.length) {
      let gesamtToday = 0;
      let gesamtYear = 0;
      let gesamtPreviousYear = 0;
      for (const wb of wbValues) {
        gesamtToday += wb.energy.today || 0;
        gesamtYear += wb.energy.year || 0;
        gesamtPreviousYear += wb.energy.previousYear || 0;
      }
      const aggregateDailyRows = await readAggregateDailyHistory(db);
      const gesamtYesterdayRow = aggregateDailyRows.find((row) => row.day_key === yesterdayKey);
      const gesamtYearRows = aggregateDailyRows.filter((row) => row.day_key.startsWith(`${calendar.yearKey}-`));
      const gesamtYearStats = statsFromRows(gesamtYearRows);
      entries.push(energyEntry('wallbox.gesamt.today', 'E-Auto gesamt – Verbrauch heute', gesamtToday));
      entries.push(energyEntry('wallbox.gesamt.yesterday', 'E-Auto gesamt – Verbrauch gestern', orZero(gesamtYesterdayRow ? gesamtYesterdayRow.value : null)));
      entries.push(energyEntry('wallbox.gesamt.avgYear', 'E-Auto gesamt – Durchschnitt dieses Jahr', avgPerDay(gesamtYear, dayOfYear)));
      entries.push(energyEntry('wallbox.gesamt.minYear', 'E-Auto gesamt – Minimum dieses Jahr', orZero(gesamtYearStats.min)));
      entries.push(dateEntry('wallbox.gesamt.minYearDate', 'E-Auto gesamt – Minimum dieses Jahr – Datum', orYearStart(gesamtYearStats.minDate, calendar.yearKey)));
      entries.push(energyEntry('wallbox.gesamt.maxYear', 'E-Auto gesamt – Maximum dieses Jahr', orZero(gesamtYearStats.max)));
      entries.push(dateEntry('wallbox.gesamt.maxYearDate', 'E-Auto gesamt – Maximum dieses Jahr – Datum', orYearStart(gesamtYearStats.maxDate, calendar.yearKey)));
      entries.push(energyEntry('wallbox.gesamt.year', 'E-Auto gesamt – Verbrauch Jahr', gesamtYear));
      entries.push(energyEntry('wallbox.gesamt.previousYear', 'E-Auto gesamt – Verbrauch Vorjahr', gesamtPreviousYear));
    }
  }

  if (isEnabled('grid-control')) {
    const grid = gridState;
    entries.push(boolEntry('grid.bySoc', 'Grid by SoC', grid.gridBySoc));
    entries.push(boolEntry('grid.byVoltage', 'Grid by Voltage', grid.gridByVoltage));
    entries.push(boolEntry('grid.byTemperature', 'Grid by Temperature', grid.gridByTemperature));
    entries.push(boolEntry('grid.byLoad', 'Grid by Load', grid.gridByLoad));
    entries.push(boolEntry('grid.actual', 'Grid actual', grid.gridActual));
  }

  // Messen + Schalten: je Gerät die Werte der gesetzten Topics (Kategorie „Geräte"),
  // je Gruppe die Verbrauchssumme der Leistung (Kategorie „Verbrauchssummen").
  const messSchaltActors = await listActors(db);
  if (messSchaltActors.length) {
    const messSchaltGroups = await listMessSchaltGroups(db);
    const actorValues = await readActorValues(db, cache, messSchaltActors);
    const valueByActorId = new Map(actorValues.map((v) => [v.id, v]));
    for (const actor of messSchaltActors) {
      const v = valueByActorId.get(actor.id) || {};
      if (actor.switchTopic) {
        entries.push(boolEntry(`geraet.${actor.id}.schalten`, `${actor.name} – Schalten`, v.switchOn === true));
      }
      entries.push(boolEntry(`geraet.${actor.id}.status`, `${actor.name} – Status`, v.statusOn === true));
      if (actor.powerTopic || actor.counterTopic) {
        entries.push(powerEntry(`geraet.${actor.id}.leistung`, `${actor.name} – Leistung`, v.powerW));
      }
      if (actor.counterTopic) {
        entries.push(energyEntry(`geraet.${actor.id}.zaehler`, `${actor.name} – Zähler`, v.counterKwh));
      }
    }
    const groupSums = readGroupSums(messSchaltGroups, actorValues);
    for (const group of messSchaltGroups) {
      const sum = groupSums.get(group.id);
      entries.push(powerEntry(
        `verbrauchssumme.${group.id}.leistung`,
        `${group.title} – Verbrauch (Leistung)`,
        sum ? sum.powerW : null
      ));
    }

    // Funktionen (Licht, Waschen, Warmwasser, Heizung / Klima, Kochen): je
    // zugeordneter Funktion die aktuelle Leistungssumme und der heute bereits
    // integrierte Verbrauch (Kategorie „Funktionen").
    const functionValues = await readFunctionValues(db, cache).catch(() => []);
    for (const fn of functionValues) {
      entries.push(powerEntry(`funktion.${fn.key}.leistung`, `Funktion ${fn.label} – Leistung`, fn.powerW));
      entries.push(energyEntry(`funktion.${fn.key}.verbrauchHeute`, `Funktion ${fn.label} – Verbrauch heute`, fn.todayKwh));
    }
  }

  for (const entry of entries) entry.category = categoryForId(entry.id);

  // Adapter-States: alle von Adaptern gemeldeten Roh-Werte erscheinen automatisch
  // im Wertekatalog (Herkunft = Adapterinstanz), zusätzlich zu den oben berechneten
  // Werten. Die id bleibt das Scheme-Topic (`prefix://instanz/adresse`), wodurch sie
  // sich eindeutig von den Katalog-Ids der berechneten Werte unterscheiden.
  const statesTree = await buildStatesTree(db);
  for (const instance of statesTree) {
    forEachState(instance.categories, (state) => entries.push({
      id: state.topic,
      label: `${instance.instanceName} – ${state.name}`,
      value: state.value,
      display: state.display,
      category: `Adapter: ${instance.instanceName}`,
    }));
  }

  entries.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  return entries;
}

const SNAPSHOT_CACHE_MS = 900;
let snapshotCache = null;
let snapshotInFlight = null;

async function listInternalValues(db, cache) {
  if (snapshotCache && snapshotCache.db === db && snapshotCache.cache === cache &&
      Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) {
    metrics.counter('internalValues.cacheHit');
    return snapshotCache.values;
  }
  if (snapshotInFlight && snapshotInFlight.db === db && snapshotInFlight.cache === cache) {
    metrics.counter('internalValues.shared');
    return snapshotInFlight.promise;
  }
  const promise = metrics.measure('internalValues.build', () => buildInternalValues(db, cache));
  snapshotInFlight = { db, cache, promise };
  try {
    const values = await promise;
    snapshotCache = { db, cache, at: Date.now(), values };
    return values;
  } finally {
    if (snapshotInFlight && snapshotInFlight.promise === promise) snapshotInFlight = null;
  }
}

function invalidateInternalValues() { snapshotCache = null; }

module.exports = { listInternalValues, invalidateInternalValues, categoryForId, secondsUntilNextCharge, VALUE_CATEGORIES };
