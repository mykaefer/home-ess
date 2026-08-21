'use strict';

// Konfiguration einer Diagramm-Kachel: welche Messreihen der systemweiten
// Datenbank (siehe src/database/) über welchen Zeitraum und mit welcher
// Verdichtung gezeichnet werden.

const { AGGREGATES } = require('../database/influx-reader');
const { SERIES_COLORS } = require('./chart-palette');

// Höchstens vier Linien je Kachel: darüber wird ein Dashboard-Diagramm
// unlesbar, und die Farbzuordnung wäre nicht mehr eindeutig unterscheidbar.
const MAX_SERIES = 4;
const MAX_TITLE_LENGTH = 60;
const MAX_LABEL_LENGTH = 40;
const MAX_UNIT_LENGTH = 12;
const MAX_MEASUREMENT_LENGTH = 200;

// Zeiträume mit passender Rasterweite. Die Rasterweite bestimmt, wie viele
// Punkte die Datenbank liefert — grob 150 bis 300 Punkte je Linie, genug für
// eine saubere Kurve und wenig genug für eine flotte Kachel.
const CHART_RANGES = [
  { key: '6h', label: '6 Stunden', durationMs: 6 * 60 * 60 * 1000, intervalMs: 2 * 60 * 1000 },
  { key: '24h', label: '24 Stunden', durationMs: 24 * 60 * 60 * 1000, intervalMs: 5 * 60 * 1000 },
  { key: '7d', label: '7 Tage', durationMs: 7 * 24 * 60 * 60 * 1000, intervalMs: 30 * 60 * 1000 },
  { key: '30d', label: '30 Tage', durationMs: 30 * 24 * 60 * 60 * 1000, intervalMs: 3 * 60 * 60 * 1000 },
];

const RANGE_BY_KEY = new Map(CHART_RANGES.map((range) => [range.key, range]));
const DEFAULT_RANGE = '24h';
const DEFAULT_AGGREGATE = 'mean';

// Auswahlliste für den Dialog.
const AGGREGATE_OPTIONS = [
  { key: 'mean', label: 'Mittelwert' },
  { key: 'min', label: 'Minimum' },
  { key: 'max', label: 'Maximum' },
  { key: 'sum', label: 'Summe' },
  { key: 'last', label: 'Letzter Wert' },
];

function rangeByKey(key) {
  return RANGE_BY_KEY.get(String(key || '')) || RANGE_BY_KEY.get(DEFAULT_RANGE);
}

// Formularwerte kommen als Array (mehrfach gleicher Name) oder als einzelner
// String an — beides auf ein Array normalisieren.
function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// Farbwert einer Linie: leer = Standardfarbe der Position in der Liste.
function normalizeSeriesColor(value, index) {
  const color = String(value == null ? '' : value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

// Eine Linie: Messreihe (Pflicht), Anzeigename für die Legende (optional, sonst
// der Messreihenname) und Farbe. Die Farbe hängt bewusst an der Linie und nicht
// an ihrer Position — entfernt man eine Linie, behalten die übrigen ihre Farbe.
function normalizeSeriesEntry(entry, index) {
  const source = entry && typeof entry === 'object' ? entry : { measurement: entry };
  const measurement = String(source.measurement == null ? '' : source.measurement)
    .trim().slice(0, MAX_MEASUREMENT_LENGTH);
  if (!measurement) return null;
  const label = String(source.label == null ? '' : source.label).trim().slice(0, MAX_LABEL_LENGTH);
  return { measurement, label, color: normalizeSeriesColor(source.color, index) };
}

// Aus Formularfeldern kommen drei parallele Listen (Messreihe, Name, Farbe);
// aus der Datenbank kommt eine fertige Liste von Objekten. Ältere Konfigurationen
// kennen nur `measurements` als Namensliste.
function collectSeriesInput(input = {}) {
  if (Array.isArray(input.series)) return input.series;
  const measurements = toArray(
    input.seriesMeasurements != null ? input.seriesMeasurements : input.measurements
  );
  const labels = toArray(input.seriesLabels);
  const colors = toArray(input.seriesColors);
  const entries = [];
  measurements.forEach((measurement, index) => {
    // Ein Feld darf mehrere kommagetrennte Namen enthalten; die Namens- und
    // Farblisten beziehen sich dann auf den ersten davon.
    String(measurement == null ? '' : measurement).split(',').forEach((part, offset) => {
      entries.push({
        measurement: part,
        label: offset === 0 ? labels[index] : '',
        color: offset === 0 ? colors[index] : '',
      });
    });
  });
  return entries;
}

function normalizeSeries(input) {
  const seen = new Set();
  const result = [];
  collectSeriesInput(input).forEach((entry) => {
    if (result.length >= MAX_SERIES) return;
    const normalized = normalizeSeriesEntry(entry, result.length);
    if (!normalized || seen.has(normalized.measurement)) return;
    seen.add(normalized.measurement);
    result.push(normalized);
  });
  return result;
}

function normalizeChartConfig(input = {}) {
  const series = normalizeSeries(input);
  return {
    series,
    // Abgeleitet für die Datenbankabfrage — nicht gespeichert.
    measurements: series.map((entry) => entry.measurement),
    range: RANGE_BY_KEY.has(String(input.range)) ? String(input.range) : DEFAULT_RANGE,
    aggregate: AGGREGATES.has(String(input.aggregate)) ? String(input.aggregate) : DEFAULT_AGGREGATE,
    title: String(input.title == null ? '' : input.title).trim().slice(0, MAX_TITLE_LENGTH),
    unit: String(input.unit == null ? '' : input.unit).trim().slice(0, MAX_UNIT_LENGTH),
  };
}

// Nur das Wesentliche persistieren; `measurements` ergibt sich beim Laden.
function chartConfigForStorage(config) {
  return {
    series: (config.series || []).map((entry) => ({
      measurement: entry.measurement,
      label: entry.label,
      color: entry.color,
    })),
    range: config.range,
    aggregate: config.aggregate,
    title: config.title,
    unit: config.unit,
  };
}

function validateChartConfig(config) {
  if (!config.series || !config.series.length) {
    return ['Bitte mindestens eine Messreihe auswählen.'];
  }
  return [];
}

// Zeitfenster der Kachel zum Abfragezeitpunkt.
function chartWindow(config, now = Date.now()) {
  const range = rangeByKey(config.range);
  return { from: now - range.durationMs, to: now, intervalMs: range.intervalMs, range };
}

module.exports = {
  CHART_RANGES,
  AGGREGATE_OPTIONS,
  MAX_SERIES,
  DEFAULT_RANGE,
  DEFAULT_AGGREGATE,
  rangeByKey,
  normalizeChartConfig,
  chartConfigForStorage,
  validateChartConfig,
  MAX_LABEL_LENGTH,
  chartWindow,
};
