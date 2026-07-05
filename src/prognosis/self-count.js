'use strict';

// Abhärtung der Prognose-Datenbasis (Vorschlag des Auftraggebers):
//
// Der stündliche Lernwert (prognosis_hourly_consumption.consumption_kwh) stammt
// primär aus dem zähler-/bilanzbasierten Eigenverbrauch (primary_kwh). Parallel
// integrieren wir die **Eigenverbrauch-Leistung** (am Wechselrichter-Ausgang für
// Verbraucher gemessen, zzgl. verbraucherseitiger PV) stundenweise zu einer
// unabhängigen **Selbstzählung** (self_kwh). Diese Leistung ist stets ≥ 0 und
// pendelt nicht um Null – sie hat also nicht den Sägezahn, den die Bilanz beim
// Akku-Lade-Übergang zeigt.
//
// Nach Abschluss einer Stunde vergleicht der Guard beide Werte. Weicht die
// Bilanz zu stark von der Selbstzählung ab (und liegt kein echter
// Eigenverbrauchszähler an), fließt die Selbstzählung als Ersatzwert in die
// Prognose. Liegt ein echter Zähler an, ist er maßgeblich und der Guard greift
// nicht. Beide Serien bleiben je Stunde gespeichert (Transparenz-Diagramm).

const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { invalidateConsumptionModel } = require('./forecast');

// Guard-Schwelle (bewusst als Konstante, damit leicht nachjustierbar): die
// Bilanz wird nur ersetzt, wenn sie **relativ** UND **absolut** deutlich abweicht.
const GUARD_REL = 0.25;
const GUARD_ABS_KWH = 0.2;

// Nur kurze, plausible Intervalle integrieren (kein Riesensprung nach Neustart).
const MAX_INTERVAL_MS = 5 * 60 * 1000;

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

async function calendarFor(db, cache, now) {
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  return localCalendar(cache, mqttConfig.timezone, now);
}

// Letzter Integrationszeitpunkt (im Speicher – nach Neustart überspringt der
// erste Tick die Integration, das ist verschmerzbar und vermeidet einen
// künstlichen Sprung über die Downtime).
let lastTs = null;

// Netto-Hausleistung (W, ≥ 0) über das seit dem letzten Aufruf vergangene
// Intervall in die Selbstzählung der aktuellen Stunde integrieren.
async function integrateSelfCount(db, cache, netHousePowerW, now = Date.now()) {
  const power = Math.max(0, num(netHousePowerW) || 0);
  const previousTs = lastTs;
  lastTs = now;
  if (previousTs == null || now <= previousTs || now - previousTs > MAX_INTERVAL_MS) return;
  const kwh = power * (now - previousTs) / 3600000000;
  if (!(kwh > 0)) return;
  const calendar = await calendarFor(db, cache, new Date(now));
  const hour = Math.max(0, Math.min(23, Number(calendar.hours) || 0));
  await dbRun(
    db,
    `INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, self_kwh)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(day_key, hour) DO UPDATE SET self_kwh = COALESCE(self_kwh, 0) + excluded.self_kwh`,
    [calendar.dateKey, hour, kwh]
  );
}

function divergesTooMuch(primary, self) {
  const diff = Math.abs(primary - self);
  if (diff <= GUARD_ABS_KWH) return false;
  const base = Math.max(Math.abs(primary), Math.abs(self), 1e-6);
  return diff / base > GUARD_REL;
}

// Abgeschlossene Stunden absichern: Bilanz ggf. durch die Selbstzählung ersetzen.
// Läuft nach jedem Sample; verarbeitet jede Stunde genau einmal (reconciled).
async function reconcileCompletedHours(db, cache, { selfMeterPresent = false } = {}, now = Date.now()) {
  const calendar = await calendarFor(db, cache, new Date(now));
  const dayKey = calendar.dateKey;
  const currentHour = Math.max(0, Math.min(23, Number(calendar.hours) || 0));
  // Alle noch nicht abgesicherten, bereits abgeschlossenen Stunden (heute vor der
  // aktuellen Stunde, plus ein Karenztag für die 23-Uhr-Stunde des Vortags).
  const rows = await dbAll(
    db,
    `SELECT day_key, hour, consumption_kwh, primary_kwh, self_kwh
       FROM prognosis_hourly_consumption
      WHERE reconciled = 0
        AND day_key >= date(?, '-1 day')
        AND (day_key < ? OR hour < ?)`,
    [dayKey, dayKey, currentHour]
  );
  const changedDays = new Set();
  for (const row of rows) {
    const primary = num(row.primary_kwh);
    const self = num(row.self_kwh);
    let replaced = false;
    // Kein echter Zähler + beide Serien vorhanden + zu große Abweichung
    // ⇒ Selbstzählung als Ersatzwert in die Prognose übernehmen.
    if (!selfMeterPresent && primary != null && self != null && divergesTooMuch(primary, self)) {
      await dbRun(
        db,
        'UPDATE prognosis_hourly_consumption SET consumption_kwh = ?, reconciled = 1 WHERE day_key = ? AND hour = ?',
        [self, row.day_key, row.hour]
      );
      replaced = true;
    } else {
      await dbRun(
        db,
        'UPDATE prognosis_hourly_consumption SET reconciled = 1 WHERE day_key = ? AND hour = ?',
        [row.day_key, row.hour]
      );
    }
    if (replaced) changedDays.add(row.day_key);
  }
  // Tageswert(e) mit ersetzten Stunden neu aus der Stundensumme bilden.
  for (const changedDay of changedDays) {
    await dbRun(
      db,
      `UPDATE prognosis_daily_consumption
          SET consumption_kwh = COALESCE(
            (SELECT SUM(consumption_kwh) FROM prognosis_hourly_consumption WHERE day_key = ?), 0)
        WHERE day_key = ?`,
      [changedDay, changedDay]
    );
  }
  if (changedDays.size) invalidateConsumptionModel(db);
  return { checked: rows.length, replaced: changedDays.size };
}

function resetForTests() {
  lastTs = null;
}

module.exports = {
  integrateSelfCount, reconcileCompletedHours, divergesTooMuch, resetForTests,
  GUARD_REL, GUARD_ABS_KWH,
};
