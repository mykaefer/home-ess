'use strict';

// Fehlererkennung der Verbrauchserfassung.
//
// `markSampleHealthy` merkt sich den Zeitpunkt des letzten Samples MIT
// verbraucherseitigen Daten. `checkSamplingHealth` läuft zu Beginn jedes
// Erfassungs-Ticks (auch wenn der Tick sonst früh abbricht) und erkennt an einem
// zu großen Abstand, dass ganze Stunden nicht sauber erfasst werden konnten
// (Verbindungsabbruch, fehlende Daten, Prozess-Downtime). Solche Stunden werden
// als „unvollständig" markiert und ihr Lernwert auf den Vortageswert gesetzt,
// damit keine falsche Kurve gelernt wird; die erfassten Rohwerte
// (primary_kwh/self_kwh) bleiben unangetastet und werden nur ausgegraut angezeigt.

const { loadMqttConfig } = require('../mqtt/config');
const { localCalendar } = require('../local-time');
const { invalidateConsumptionModel } = require('./forecast');
const { logSamplingEvent } = require('./sampling-log');

const HOUR_MS = 3600000;
// Erst ab einer komplett verpassten vollen Stunde greift die Markierung.
const MIN_GAP_MS = HOUR_MS;
// Sicherheitskappe gegen sehr lange Lücken (z. B. tagelange Downtime).
const MAX_HOURS = 60;

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function timezone(db) {
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  return mqttConfig.timezone;
}

async function loadLastOkTs(db) {
  const row = await dbGet(db, 'SELECT last_ok_ts FROM prognosis_sampling_state WHERE id = 1').catch(() => null);
  return row && row.last_ok_ts != null ? Number(row.last_ok_ts) : null;
}

// Nach einem Sample MIT verbraucherseitigen Daten aufrufen: markiert die Erfassung
// als „gesund" bis `now`.
async function markSampleHealthy(db, now = Date.now()) {
  await dbRun(
    db,
    `INSERT INTO prognosis_sampling_state (id, last_ok_ts) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_ok_ts = excluded.last_ok_ts`,
    [now]
  ).catch(() => {});
}

// Eine Stunde als unvollständig markieren: consumption_kwh auf den Vortageswert
// setzen (falls vorhanden), Flag setzen, als abgesichert (reconciled) markieren.
// Rohwerte primary_kwh/self_kwh bleiben unverändert. Liefert, ob die Stunde NEU
// markiert wurde (vorher nicht unvollständig) – nur dann wird protokolliert.
async function markHourIncomplete(db, dayKey, hour) {
  const existing = await dbGet(
    db, 'SELECT incomplete FROM prognosis_hourly_consumption WHERE day_key = ? AND hour = ?', [dayKey, hour]
  );
  const already = existing && Number(existing.incomplete) === 1;
  const prev = await dbGet(
    db, "SELECT consumption_kwh FROM prognosis_hourly_consumption WHERE day_key = date(?, '-1 day') AND hour = ?",
    [dayKey, hour]
  );
  const prevVal = prev && prev.consumption_kwh != null ? Number(prev.consumption_kwh) : null;
  if (prevVal != null) {
    await dbRun(
      db,
      `INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, incomplete, reconciled)
       VALUES (?, ?, ?, 1, 1)
       ON CONFLICT(day_key, hour) DO UPDATE SET consumption_kwh = ?, incomplete = 1, reconciled = 1`,
      [dayKey, hour, prevVal, prevVal]
    );
  } else {
    await dbRun(
      db,
      `INSERT INTO prognosis_hourly_consumption (day_key, hour, consumption_kwh, incomplete, reconciled)
       VALUES (?, ?, 0, 1, 1)
       ON CONFLICT(day_key, hour) DO UPDATE SET incomplete = 1, reconciled = 1`,
      [dayKey, hour]
    );
  }
  return { newlyMarked: !already, prevVal };
}

async function recomputeDailyTotal(db, dayKey) {
  await dbRun(
    db,
    `UPDATE prognosis_daily_consumption
        SET consumption_kwh = COALESCE(
          (SELECT SUM(consumption_kwh) FROM prognosis_hourly_consumption WHERE day_key = ?), 0)
      WHERE day_key = ?`,
    [dayKey, dayKey]
  );
}

// Eine feste Liste von Stunden eines Tages als unvollständig markieren (für den
// Einmalfix vergangener Stunden und für Tests). Setzt Vortageswerte ein und
// rechnet den Tageswert neu.
async function markHoursIncomplete(db, dayKey, hours = []) {
  const marked = [];
  for (const hour of hours) {
    const res = await markHourIncomplete(db, dayKey, Math.max(0, Math.min(23, Number(hour) || 0)));
    marked.push({ dayKey, hour, prevVal: res.prevVal });
  }
  if (marked.length) {
    await recomputeDailyTotal(db, dayKey);
    invalidateConsumptionModel(db);
  }
  return marked;
}

// Zu Beginn jedes Erfassungs-Ticks aufrufen (vor etwaigem Early-Return). Erkennt
// vollständig verpasste Stunden zwischen dem letzten gesunden Sample und jetzt und
// markiert sie als unvollständig. Aktualisiert last_ok_ts NICHT (das macht nur ein
// erfolgreiches Sample über markSampleHealthy).
async function checkSamplingHealth(db, cache, now = Date.now()) {
  const lastOk = await loadLastOkTs(db);
  if (lastOk == null || now - lastOk < MIN_GAP_MS) return { marked: [] };
  const tz = await timezone(db).catch(() => undefined);
  // Alle vollen Uhr-Stunden, die KOMPLETT in (lastOk, now) liegen (also ganz
  // verpasst; die laufende Stunde bleibt außen vor).
  let start = Math.ceil(lastOk / HOUR_MS) * HOUR_MS;
  const timestamps = [];
  while (start + HOUR_MS <= now && timestamps.length < MAX_HOURS) {
    timestamps.push(start);
    start += HOUR_MS;
  }
  const newlyMarked = [];
  const days = new Set();
  for (const ts of timestamps) {
    const cal = localCalendar(cache, tz, new Date(ts));
    const hour = Math.max(0, Math.min(23, Number(cal.hours) || 0));
    const res = await markHourIncomplete(db, cal.dateKey, hour);
    days.add(cal.dateKey);
    if (res.newlyMarked) newlyMarked.push({ dayKey: cal.dateKey, hour });
  }
  if (!newlyMarked.length) return { marked: [] };
  for (const dayKey of days) await recomputeDailyTotal(db, dayKey);
  invalidateConsumptionModel(db);
  logSamplingEvent(
    `Sampling-Lücke: ${Math.round((now - lastOk) / 60000)} min ohne verbraucherseitige Daten; `
    + `${newlyMarked.length} Stunde(n) als unvollständig markiert (Vortageswert eingesetzt).`,
    { marked: newlyMarked }
  );
  return { marked: newlyMarked };
}

module.exports = {
  markSampleHealthy, checkSamplingHealth, markHoursIncomplete, loadLastOkTs,
  MIN_GAP_MS,
};
