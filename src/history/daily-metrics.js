'use strict';

// Gemeinsame Ablage für abgeschlossene Tageswerte einzelner Kennzahlen (PV-Ertrag,
// Netzbezug, Eigenverbrauch, ...). Jede Kennzahl
// schreibt genau einmal je abgeschlossenem Tag (beim Tageswechsel der Quelle);
// daraus lässt sich die Jahres-Statistik (Durchschnitt/Minimum/Maximum inkl.
// Datum/Summe) für den Wertekatalog ableiten. 400 Tage Aufbewahrung decken das
// laufende Jahr plus Vorjahresvergleich vollständig ab.

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

async function recordDailyMetric(db, metric, dayKey, value) {
  if (!dayKey || value == null || !Number.isFinite(value)) return;
  await dbRun(
    db,
    `INSERT INTO daily_metric_history (metric, day_key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(metric, day_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [metric, dayKey, value, Date.now()]
  );
  await dbRun(db, "DELETE FROM daily_metric_history WHERE metric = ? AND day_key < date(?, '-400 days')", [metric, dayKey]);
}

async function getDailyMetricValue(db, metric, dayKey) {
  const row = await dbGet(db, 'SELECT value FROM daily_metric_history WHERE metric = ? AND day_key = ?', [metric, dayKey]);
  return row ? row.value : null;
}

// Prüft, ob ein String ein gültiger Kalender-Datumsschlüssel (YYYY-MM-DD) ist –
// inklusive echter Tages-/Monatsgrenzen (z. B. 2026-02-30 ist ungültig).
function isValidDayKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Datumsschlüssel (YYYY-MM-DD) um eine Anzahl Tage verschieben (rein kalendarisch,
// UTC-Arithmetik genügt, da dateKey bereits ein lokales Kalenderdatum ist).
function dayKeyOffset(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Durchschnitt/Minimum(+Datum)/Maximum(+Datum)/Summe aus bereits geladenen
// { day_key, value }-Zeilen eines Jahres (z. B. je Tag über mehrere Boxen summiert).
function statsFromRows(rows) {
  if (!rows || !rows.length) {
    return { average: null, min: null, minDate: null, max: null, maxDate: null, sum: null };
  }
  let sum = 0;
  let min = null;
  let minDate = null;
  let max = null;
  let maxDate = null;
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    sum += value;
    if (min == null || value < min) {
      min = value;
      minDate = row.day_key;
    }
    if (max == null || value > max) {
      max = value;
      maxDate = row.day_key;
    }
  }
  return { average: sum / rows.length, min, minDate, max, maxDate, sum };
}

async function computeYearStats(db, metric, yearKey) {
  const rows = await dbAll(
    db,
    'SELECT day_key, value FROM daily_metric_history WHERE metric = ? AND day_key LIKE ? ORDER BY day_key',
    [metric, `${yearKey}-%`]
  );
  return statsFromRows(rows);
}

module.exports = { recordDailyMetric, getDailyMetricValue, computeYearStats, statsFromRows, dayKeyOffset, isValidDayKey };
