'use strict';

const {
  EIGENVERBRAUCH_L1_STATE_ID,
  EIGENVERBRAUCH_L2_STATE_ID,
  EIGENVERBRAUCH_L3_STATE_ID,
  NETZBEZUG_L1_STATE_ID,
  NETZBEZUG_L2_STATE_ID,
  NETZBEZUG_L3_STATE_ID,
  NETZBEZUG_ZAEHLER_L1_STATE_ID,
  NETZBEZUG_ZAEHLER_L2_STATE_ID,
  NETZBEZUG_ZAEHLER_L3_STATE_ID,
  EINSPEISUNG_ZAEHLER_L1_STATE_ID,
  EINSPEISUNG_ZAEHLER_L2_STATE_ID,
  EINSPEISUNG_ZAEHLER_L3_STATE_ID,
  EIGENVERBRAUCH_ZAEHLER_L1_STATE_ID,
  EIGENVERBRAUCH_ZAEHLER_L2_STATE_ID,
  EIGENVERBRAUCH_ZAEHLER_L3_STATE_ID,
} = require('./config');
const { listPvPlants } = require('../photovoltaik/plants');
const {
  buildPhotovoltaikSnapshot,
  readPhotovoltaikValues,
  getConsumerSidePvCurrentTotal,
  getConsumerSidePvTodayTotal,
} = require('../photovoltaik/aggregation');
const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { recordDailyMetric, getDailyMetricValue } = require('../history/daily-metrics');
const { readBatteryEnergyValues, updateBatteryEnergy } = require('../batterie/energy');

const IMPORT_COUNTER_KEYS = [
  { id: NETZBEZUG_ZAEHLER_L1_STATE_ID, key: 'import_l1' },
  { id: NETZBEZUG_ZAEHLER_L2_STATE_ID, key: 'import_l2' },
  { id: NETZBEZUG_ZAEHLER_L3_STATE_ID, key: 'import_l3' },
];

const EXPORT_COUNTER_KEYS = [
  { id: EINSPEISUNG_ZAEHLER_L1_STATE_ID, key: 'export_l1' },
  { id: EINSPEISUNG_ZAEHLER_L2_STATE_ID, key: 'export_l2' },
  { id: EINSPEISUNG_ZAEHLER_L3_STATE_ID, key: 'export_l3' },
];

// Optionaler echter Eigenverbrauchszähler (3 Phasen). Ist er verbaut und liefert
// Werte, gilt sein Tageszuwachs (plus verbraucherseitige PV) als tatsächlicher
// Eigenverbrauch – ohne die sonst nötige Bilanzierung.
const SELF_COUNTER_KEYS = [
  { id: EIGENVERBRAUCH_ZAEHLER_L1_STATE_ID, key: 'self_l1' },
  { id: EIGENVERBRAUCH_ZAEHLER_L2_STATE_ID, key: 'self_l2' },
  { id: EIGENVERBRAUCH_ZAEHLER_L3_STATE_ID, key: 'self_l3' },
];

// Zuordnung Konfig-Feld (Zähler-Topic) -> Zähler-Schlüssel. Ändert sich das Topic
// eines Zählers (z. B. Umstellung auf einen anderen Adapter oder Zählertausch),
// muss der gemerkte Rohstand verworfen werden, damit der erste Wert des neuen
// Zählers als neuer Ist-Stand gilt und nicht als Zählersprung gezählt wird.
const COUNTER_TOPIC_FIELDS = [
  { field: 'netzbezugZaehlerL1Topic', key: 'import_l1' },
  { field: 'netzbezugZaehlerL2Topic', key: 'import_l2' },
  { field: 'netzbezugZaehlerL3Topic', key: 'import_l3' },
  { field: 'einspeisungZaehlerL1Topic', key: 'export_l1' },
  { field: 'einspeisungZaehlerL2Topic', key: 'export_l2' },
  { field: 'einspeisungZaehlerL3Topic', key: 'export_l3' },
  { field: 'eigenverbrauchZaehlerL1Topic', key: 'self_l1' },
  { field: 'eigenverbrauchZaehlerL2Topic', key: 'self_l2' },
  { field: 'eigenverbrauchZaehlerL3Topic', key: 'self_l3' },
];

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCacheValue(cache, key) {
  const entry = cache.get(key);
  return entry ? parseNumber(entry.value) : null;
}

function sumCacheValues(cache, keys) {
  let sum = 0;
  let hasValue = false;
  for (const key of keys) {
    const value = getCacheValue(cache, key);
    if (value == null) continue;
    sum += value;
    hasValue = true;
  }
  return hasValue ? sum : null;
}

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

function formatRawValue(value) {
  if (value == null) return '—';
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatBreakdown(breakdown) {
  return {
    eigenverbrauch: formatEnergy(breakdown.eigenverbrauch),
    netzbezug: formatEnergy(breakdown.netzbezug),
    summe: formatEnergy(breakdown.summe),
  };
}

function buildBreakdown(eigenverbrauch, netzbezug) {
  const summe =
    eigenverbrauch == null && netzbezug == null
      ? null
      : (eigenverbrauch || 0) + (netzbezug || 0);
  return { eigenverbrauch, netzbezug, summe };
}

function deriveEigenverbrauchFromPv(pvValue, exportValue) {
  if (pvValue == null && exportValue == null) return null;
  const value = (pvValue || 0) - (exportValue || 0);
  return value < 0 ? 0 : value;
}

function deriveEigenverbrauch(pvValue, importValue, exportValue, batteryEnergy = {}) {
  if (pvValue == null && importValue == null && exportValue == null) return null;
  const charge = Math.max(0, parseNumber(batteryEnergy.charge) || 0);
  const discharge = Math.max(0, parseNumber(batteryEnergy.discharge) || 0);
  const value = (pvValue || 0) + (importValue || 0) - (exportValue || 0)
    - charge + discharge;
  return value < 0 ? 0 : value;
}

function deriveEigenverbrauchPower(inverterValue, consumerSidePvValue) {
  if (inverterValue == null && consumerSidePvValue == null) return null;
  return (inverterValue || 0) + (consumerSidePvValue || 0);
}

function deriveNetzbezug(importValue, exportValue) {
  if (importValue == null && exportValue == null) return null;
  return (importValue || 0) - (exportValue || 0);
}

function normalizeSummaryState(row = {}) {
  return {
    weekImportOffset: parseNumber(row.week_import_offset) || 0,
    weekExportOffset: parseNumber(row.week_export_offset) || 0,
    yearImportOffset: parseNumber(row.year_import_offset) || 0,
    yearExportOffset: parseNumber(row.year_export_offset) || 0,
    previousYearImportTotal: parseNumber(row.previous_year_import_total) || 0,
    previousYearExportTotal: parseNumber(row.previous_year_export_total) || 0,
    lastRolloverDate: row.last_rollover_date || '',
    weekKey: row.week_key || '',
    yearKey: row.year_key || '',
  };
}

function normalizeCounterState(row = {}) {
  return {
    lastRawValue: parseNumber(row.last_raw_value),
    dayTotal: parseNumber(row.day_total) || 0,
    lastDayKey: row.last_day_key || '',
  };
}

async function loadSummaryState(db) {
  const row = await dbGet(
    db,
    `SELECT week_import_offset, week_export_offset,
            year_import_offset, year_export_offset,
            previous_year_import_total, previous_year_export_total,
            last_rollover_date, week_key, year_key
     FROM stromverbrauch_aggregation
     WHERE id = 1`
  );
  return normalizeSummaryState(row);
}

async function saveSummaryState(db, state) {
  await dbRun(
    db,
    `UPDATE stromverbrauch_aggregation
     SET week_import_offset = ?, week_export_offset = ?,
         year_import_offset = ?, year_export_offset = ?,
         previous_year_import_total = ?, previous_year_export_total = ?,
         last_rollover_date = ?, week_key = ?, year_key = ?
     WHERE id = 1`,
    [
      state.weekImportOffset,
      state.weekExportOffset,
      state.yearImportOffset,
      state.yearExportOffset,
      state.previousYearImportTotal,
      state.previousYearExportTotal,
      state.lastRolloverDate,
      state.weekKey,
      state.yearKey,
    ]
  );
}

async function loadCounterStates(db) {
  const rows = await dbAll(
    db,
    'SELECT counter_key, last_raw_value, day_total, last_day_key FROM stromverbrauch_counter_state'
  );
  const states = new Map();
  for (const row of rows) {
    states.set(row.counter_key, normalizeCounterState(row));
  }
  return states;
}

async function saveCounterState(db, key, state) {
  await dbRun(
    db,
    `INSERT INTO stromverbrauch_counter_state (counter_key, last_raw_value, day_total, last_day_key)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(counter_key) DO UPDATE SET
       last_raw_value = excluded.last_raw_value,
       day_total = excluded.day_total,
       last_day_key = excluded.last_day_key`,
    [key, state.lastRawValue, state.dayTotal, state.lastDayKey]
  );
}

async function updateCounterStates(db, cache, calendar) {
  const dayKey = calendar.dateKey;
  const existing = await loadCounterStates(db);
  const previousDayTotals = { import: 0, export: 0, self: 0 };
  const dayTotals = { import: 0, export: 0, self: 0 };
  const selfHasReading = { value: false };
  const rawValues = {
    import: { l1: null, l2: null, l3: null },
    export: { l1: null, l2: null, l3: null },
    self: { l1: null, l2: null, l3: null },
  };

  const bucketOf = (key) =>
    key.startsWith('import') ? 'import' : key.startsWith('export') ? 'export' : 'self';

  for (const entry of [...IMPORT_COUNTER_KEYS, ...EXPORT_COUNTER_KEYS, ...SELF_COUNTER_KEYS]) {
    const bucket = bucketOf(entry.key);
    const phase = entry.key.endsWith('_l1') ? 'l1' : entry.key.endsWith('_l2') ? 'l2' : 'l3';
    const rawValue = getCacheValue(cache, entry.id);
    const state = existing.get(entry.key) || normalizeCounterState();

    if (state.lastDayKey && state.lastDayKey !== dayKey) {
      previousDayTotals[bucket] += state.dayTotal || 0;
      state.dayTotal = 0;
      state.lastDayKey = dayKey;
    } else if (!state.lastDayKey) {
      state.lastDayKey = dayKey;
    }

    if (rawValue != null) {
      if (bucket === 'self') selfHasReading.value = true;
      if (state.lastRawValue == null) {
        state.lastRawValue = rawValue;
      } else {
        const delta = rawValue >= state.lastRawValue ? rawValue - state.lastRawValue : rawValue + 0.01;
        if (delta > 0) state.dayTotal += delta;
        state.lastRawValue = rawValue;
      }
    }

    dayTotals[bucket] += state.dayTotal || 0;
    rawValues[bucket][phase] = state.lastRawValue;
    await saveCounterState(db, entry.key, state);
  }

  return { previousDayTotals, dayTotals, rawValues, dayKey, selfMeterPresent: selfHasReading.value };
}

// Sicherheitsschranke gegen Zählersprünge beim Topic-Wechsel: Für jedes Zähler-
// Topic, das sich zwischen alter und neuer Konfiguration geändert hat, wird der
// gemerkte Rohstand verworfen (last_raw_value = NULL). Der erste Wert des neuen
// Zählers wird dadurch als neuer Ist-Stand übernommen, ohne die Abweichung zum
// alten Zählerstand als Tageszuwachs zu zählen. Der bisher heute gezählte Wert
// (day_total) bleibt erhalten. Liefert die zurückgesetzten Zähler-Schlüssel.
async function resetCountersForChangedTopics(db, previousConfig = {}, newConfig = {}) {
  const resetKeys = [];
  for (const { field, key } of COUNTER_TOPIC_FIELDS) {
    if ((previousConfig[field] || '') !== (newConfig[field] || '')) resetKeys.push(key);
  }
  for (const key of resetKeys) {
    await dbRun(db, 'UPDATE stromverbrauch_counter_state SET last_raw_value = NULL WHERE counter_key = ?', [key]);
  }
  return resetKeys;
}

async function updateSummaryState(db, previousDayTotals, calendar) {
  const state = await loadSummaryState(db);
  const { dateKey: dayKey, weekKey, yearKey } = calendar;
  let changed = false;

  if (!state.lastRolloverDate) {
    state.lastRolloverDate = dayKey;
    state.weekKey = weekKey;
    state.yearKey = yearKey;
    changed = true;
  } else if (state.lastRolloverDate !== dayKey) {
    // Der gerade zu Ende gegangene Tag (state.lastRolloverDate) ist ab hier
    // abgeschlossen – Eigenverbrauch/Netzbezug für die Jahres-Statistik im
    // Wertekatalog historisieren. Der PV-Ertrag desselben Tages steht bereits
    // in der Historie, da buildPhotovoltaikSnapshot innerhalb dieses Laufs vor
    // den Zähler-/Summen-Updates ausgeführt wird.
    const finishedDayPv = await getDailyMetricValue(db, 'pv', state.lastRolloverDate);
    await recordDailyMetric(
      db,
      'strom.eigenverbrauch',
      state.lastRolloverDate,
      deriveEigenverbrauch(finishedDayPv, previousDayTotals.import, previousDayTotals.export)
    );
    await recordDailyMetric(
      db,
      'strom.netzbezug',
      state.lastRolloverDate,
      deriveNetzbezug(previousDayTotals.import, previousDayTotals.export)
    );

    const finishedYearImport = state.yearImportOffset + previousDayTotals.import;
    const finishedYearExport = state.yearExportOffset + previousDayTotals.export;

    state.weekImportOffset =
      state.weekKey === weekKey ? state.weekImportOffset + previousDayTotals.import : 0;
    state.weekExportOffset =
      state.weekKey === weekKey ? state.weekExportOffset + previousDayTotals.export : 0;

    if (state.yearKey === yearKey) {
      state.yearImportOffset += previousDayTotals.import;
      state.yearExportOffset += previousDayTotals.export;
    } else {
      state.previousYearImportTotal = finishedYearImport;
      state.previousYearExportTotal = finishedYearExport;
      state.yearImportOffset = 0;
      state.yearExportOffset = 0;
    }

    state.lastRolloverDate = dayKey;
    state.weekKey = weekKey;
    state.yearKey = yearKey;
    changed = true;
  }

  if (changed) await saveSummaryState(db, state);
  return state;
}

async function setManualOffset(db, period, values, now = new Date()) {
  const state = await loadSummaryState(db);
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(null, mqttConfig.timezone, now);
  state.lastRolloverDate = calendar.dateKey;
  state.weekKey = calendar.weekKey;
  state.yearKey = calendar.yearKey;

  if (period === 'week') {
    state.weekImportOffset = values.netzbezug;
    state.weekExportOffset = values.einspeisung;
  } else if (period === 'year') {
    state.yearImportOffset = values.netzbezug;
    state.yearExportOffset = values.einspeisung;
  } else if (period === 'previousYear') {
    state.previousYearImportTotal = values.netzbezug;
    state.previousYearExportTotal = values.einspeisung;
  } else {
    throw new Error('Unbekannter Zeitraum.');
  }

  await saveSummaryState(db, state);
  return state;
}

async function buildStromverbrauchSnapshot(db, cache) {
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const calendar = localCalendar(cache, mqttConfig.timezone);
  const eigenverbrauchMeterValue = sumCacheValues(cache, [
    EIGENVERBRAUCH_L1_STATE_ID,
    EIGENVERBRAUCH_L2_STATE_ID,
    EIGENVERBRAUCH_L3_STATE_ID,
  ]);
  const netzbezugPowerValue = sumCacheValues(cache, [
    NETZBEZUG_L1_STATE_ID,
    NETZBEZUG_L2_STATE_ID,
    NETZBEZUG_L3_STATE_ID,
  ]);

  const pvSnapshot = await buildPhotovoltaikSnapshot(db, cache, await listPvPlants(db));
  const consumerSidePvValue = getConsumerSidePvCurrentTotal(pvSnapshot);
  // Die Momentanleistung kommt bereits direkt vom Wechselrichter. Anders als
  // die Energiezähler-Bilanz braucht sie keine Batteriekorrektur; lediglich
  // verbraucherseitig einspeisende PV-Anlagen werden ergänzt.
  const eigenverbrauchPowerValue = deriveEigenverbrauchPower(
    eigenverbrauchMeterValue,
    consumerSidePvValue
  );

  const counterUpdate = await updateCounterStates(db, cache, calendar);
  const todayImport = counterUpdate.dayTotals.import || 0;
  const todayExport = counterUpdate.dayTotals.export || 0;
  const summaryState = await updateSummaryState(
    db,
    counterUpdate.previousDayTotals,
    calendar
  );

  const weekImport = summaryState.weekImportOffset + todayImport;
  const weekExport = summaryState.weekExportOffset + todayExport;
  const yearImport = summaryState.yearImportOffset + todayImport;
  const yearExport = summaryState.yearExportOffset + todayExport;
  // Akku-Lade-/Entladezähler im selben Takt wie die PV-/Netzzähler
  // fortschreiben, bevor er in die Bilanz eingeht. Sonst sägt der sonst nur
  // asynchron gepflegte Ladezähler den batteriebereinigten Eigenverbrauch
  // minütlich hoch und runter; die Positiv-Delta-Lernung (recordConsumptionSample)
  // verwirft die Abwärtsspitzen und bläht die Ladestunden massiv auf.
  await updateBatteryEnergy(db, cache);
  const batteryEnergy = await readBatteryEnergyValues(db);

  // Eigenverbrauch heute: liegt ein echter Eigenverbrauchszähler an (3 Phasen,
  // liefert Werte), gilt sein Tageszuwachs plus die verbraucherseitig ins
  // Hausnetz einspeisende PV als tatsächlicher Eigenverbrauch. Sonst bilanzieren.
  const balanceEigenverbrauchToday =
    deriveEigenverbrauch(pvSnapshot.totals.raw.today, todayImport, todayExport, batteryEnergy.today);
  const consumerPvToday = getConsumerSidePvTodayTotal(pvSnapshot);
  const meterEigenverbrauchToday = counterUpdate.selfMeterPresent
    ? (counterUpdate.dayTotals.self || 0) + (consumerPvToday || 0)
    : null;
  const todayBreakdown = buildBreakdown(
    meterEigenverbrauchToday != null ? meterEigenverbrauchToday : balanceEigenverbrauchToday,
    deriveNetzbezug(todayImport, todayExport)
  );
  const weekBreakdown = buildBreakdown(
    deriveEigenverbrauch(pvSnapshot.totals.raw.week, weekImport, weekExport, batteryEnergy.week),
    deriveNetzbezug(weekImport, weekExport)
  );
  const yearBreakdown = buildBreakdown(
    deriveEigenverbrauch(pvSnapshot.totals.raw.year, yearImport, yearExport, batteryEnergy.year),
    deriveNetzbezug(yearImport, yearExport)
  );
  const previousYearBreakdown = buildBreakdown(
    deriveEigenverbrauch(
      pvSnapshot.totals.raw.previousYear,
      summaryState.previousYearImportTotal,
      summaryState.previousYearExportTotal,
      batteryEnergy.previousYear
    ),
    deriveNetzbezug(
      summaryState.previousYearImportTotal,
      summaryState.previousYearExportTotal
    )
  );

  return {
    raw: {
      eigenverbrauchPower: eigenverbrauchPowerValue,
      netzbezugPower: netzbezugPowerValue,
      today: todayBreakdown,
      week: weekBreakdown,
      year: yearBreakdown,
      previousYear: previousYearBreakdown,
      rawCounters: counterUpdate.rawValues,
      // Transparenz/Guard: gemessene vs. bilanzierte Ist-Quelle für heute.
      selfMeterPresent: !!counterUpdate.selfMeterPresent,
      eigenverbrauchTodayMeter: meterEigenverbrauchToday,
      eigenverbrauchTodayBalance: balanceEigenverbrauchToday,
    },
    formatted: {
      eigenverbrauchPower: formatPower(eigenverbrauchPowerValue),
      netzbezugPower: formatPower(netzbezugPowerValue),
      today: formatBreakdown(todayBreakdown),
      week: formatBreakdown(weekBreakdown),
      year: formatBreakdown(yearBreakdown),
      previousYear: formatBreakdown(previousYearBreakdown),
      rawCounters: {
        import: {
          l1: formatRawValue(counterUpdate.rawValues.import.l1),
          l2: formatRawValue(counterUpdate.rawValues.import.l2),
          l3: formatRawValue(counterUpdate.rawValues.import.l3),
        },
        export: {
          l1: formatRawValue(counterUpdate.rawValues.export.l1),
          l2: formatRawValue(counterUpdate.rawValues.export.l2),
          l3: formatRawValue(counterUpdate.rawValues.export.l3),
        },
      },
    },
  };
}

// Reine Cache-Momentanwerte für die Kopfzeile: Netzsaldo (positiv = Bezug,
// negativ = Einspeisung) und Eigenverbrauchsleistung inkl. verbraucherseitiger
// PV. Optional werden bereits gelesene PV-Werte (readPhotovoltaikValues)
// übergeben, damit der Aufrufer sie nicht doppelt ermittelt.
function readLivePowerValues(cache, pvValues = null) {
  const eigenverbrauchMeterValue = sumCacheValues(cache, [
    EIGENVERBRAUCH_L1_STATE_ID,
    EIGENVERBRAUCH_L2_STATE_ID,
    EIGENVERBRAUCH_L3_STATE_ID,
  ]);
  const netzbezugPowerValue = sumCacheValues(cache, [
    NETZBEZUG_L1_STATE_ID,
    NETZBEZUG_L2_STATE_ID,
    NETZBEZUG_L3_STATE_ID,
  ]);
  let consumerSidePvValue = null;
  if (pvValues && Array.isArray(pvValues.plants)) {
    let total = 0;
    let has = false;
    for (const plant of pvValues.plants) {
      if (plant.isConsumerSide && plant.current != null) {
        total += plant.current;
        has = true;
      }
    }
    if (has) consumerSidePvValue = total;
  }
  return {
    eigenverbrauchPower: deriveEigenverbrauchPower(eigenverbrauchMeterValue, consumerSidePvValue),
    netzbezugPower: netzbezugPowerValue,
  };
}

// Schreibfreie Variante: liefert die aktuellen berechneten Strom-Werte (Leistungen,
// Eigenverbrauch/Netzbezug/Summen je Zeitraum sowie die Zählersummen Bezug/Einspeisung)
// ohne die DB-schreibende Zähler-/Summen-Fortschreibung. Die persistierten Tageswerte
// werden gelesen (max. so frisch wie der letzte 60-Sekunden-Lauf).
async function readStromverbrauchValues(db, cache) {
  const eigenverbrauchMeterValue = sumCacheValues(cache, [
    EIGENVERBRAUCH_L1_STATE_ID,
    EIGENVERBRAUCH_L2_STATE_ID,
    EIGENVERBRAUCH_L3_STATE_ID,
  ]);
  const netzbezugPowerValue = sumCacheValues(cache, [
    NETZBEZUG_L1_STATE_ID,
    NETZBEZUG_L2_STATE_ID,
    NETZBEZUG_L3_STATE_ID,
  ]);

  const plants = await listPvPlants(db);
  const pvValues = await readPhotovoltaikValues(db, cache, plants);
  let consumerCurrent = 0;
  let hasConsumer = false;
  for (const plant of pvValues.plants) {
    if (plant.isConsumerSide && plant.current != null) {
      consumerCurrent += plant.current;
      hasConsumer = true;
    }
  }
  const consumerSidePvValue = hasConsumer ? consumerCurrent : null;
  const eigenverbrauchPowerValue = deriveEigenverbrauchPower(
    eigenverbrauchMeterValue,
    consumerSidePvValue
  );

  const counters = await loadCounterStates(db);
  const sumDayTotals = (keys) => {
    let sum = 0;
    let has = false;
    for (const key of keys) {
      const state = counters.get(key);
      if (state) {
        sum += state.dayTotal || 0;
        has = true;
      }
    }
    return has ? sum : 0;
  };
  const todayImport = sumDayTotals(['import_l1', 'import_l2', 'import_l3']);
  const todayExport = sumDayTotals(['export_l1', 'export_l2', 'export_l3']);

  const summary = await loadSummaryState(db);
  const weekImport = summary.weekImportOffset + todayImport;
  const weekExport = summary.weekExportOffset + todayExport;
  const yearImport = summary.yearImportOffset + todayImport;
  const yearExport = summary.yearExportOffset + todayExport;
  const prevImport = summary.previousYearImportTotal;
  const prevExport = summary.previousYearExportTotal;
  const batteryEnergy = await readBatteryEnergyValues(db);

  const breakdown = (pvEnergy, importValue, exportValue, batteryPeriod) =>
    buildBreakdown(
      deriveEigenverbrauch(pvEnergy, importValue, exportValue, batteryPeriod),
      deriveNetzbezug(importValue, exportValue)
    );

  return {
    eigenverbrauchPower: eigenverbrauchPowerValue,
    netzbezugPower: netzbezugPowerValue,
    breakdown: {
      today: breakdown(pvValues.totals.today, todayImport, todayExport, batteryEnergy.today),
      week: breakdown(pvValues.totals.week, weekImport, weekExport, batteryEnergy.week),
      year: breakdown(pvValues.totals.year, yearImport, yearExport, batteryEnergy.year),
      previousYear: breakdown(pvValues.totals.previousYear, prevImport, prevExport, batteryEnergy.previousYear),
    },
    counterSums: {
      today: { import: todayImport, export: todayExport },
      week: { import: weekImport, export: weekExport },
      year: { import: yearImport, export: yearExport },
      previousYear: { import: prevImport, export: prevExport },
    },
  };
}

module.exports = {
  buildStromverbrauchSnapshot,
  readStromverbrauchValues,
  readLivePowerValues,
  setManualOffset,
  parseNumber,
  updateSummaryState,
  updateCounterStates,
  resetCountersForChangedTopics,
  deriveEigenverbrauch,
  deriveEigenverbrauchPower,
};
