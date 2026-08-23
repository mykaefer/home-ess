'use strict';

// Zählwerk der Heizkosten: ein fortlaufender Abrechnungszeitraum, der bis zum
// nächsten Zurücksetzen weiterzählt — in aller Regel bis zur jährlichen
// Zählerablesung.
//
//   * Der **Startwert** deckt ab, was seit der letzten Ablesung schon
//     verbraucht wurde, bevor homeESS mitgezählt hat.
//   * Der **Monatsabschlag** ist schlicht die Summe geteilt durch 12.
//   * Beim **Abschließen** wandert der laufende Zeitraum als „vorheriger
//     Zeitraum" ins Archiv und der neue beginnt bei 0.
//   * Wird dabei der **tatsächlich abgelesene Zählerstand** eingetragen, kann er
//     auf Wunsch den geschätzten Verbrauch je Betriebsstunde **kalibrieren**.
//     Das ergibt nur Sinn, wenn am Zähler nichts anderes hängt — deshalb
//     ausdrücklich optional.

const central = require('./central');

// Grenzen der Kalibrierung: ein Faktor außerhalb davon deutet auf einen
// Zahlendreher oder auf Fremdverbraucher am Zähler hin.
const MIN_CALIBRATION_FACTOR = 0.2;
const MAX_CALIBRATION_FACTOR = 5;
const MAX_VALUE = 1000000;

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function done(err) {
    if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function validation(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value) {
  const raw = text(value).replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

// Eine Verbrauchsangabe (Startwert, Zählerstand). Leer bleibt leer.
function amount(value, label, { required = false } = {}) {
  if (text(value) === '') {
    if (required) throw validation(`Bitte ${label} angeben.`);
    return null;
  }
  const number = toNumber(value);
  if (number == null || number < 0 || number > MAX_VALUE) {
    throw validation(`Bitte ${label} als Zahl zwischen 0 und ${MAX_VALUE} angeben.`);
  }
  return Math.round(number * 1000) / 1000;
}

function rowToBilling(row = {}) {
  return {
    startedAt: row.started_at == null ? null : Number(row.started_at),
    // Verbrauch, der vor dem Mitzählen im laufenden Zeitraum schon angefallen ist.
    startConsumption: row.start_consumption == null ? 0 : Number(row.start_consumption),
    previousStartedAt: row.previous_started_at == null ? null : Number(row.previous_started_at),
    previousEndedAt: row.previous_ended_at == null ? null : Number(row.previous_ended_at),
    previousConsumption: row.previous_consumption == null ? null : Number(row.previous_consumption),
    previousCost: row.previous_cost == null ? null : Number(row.previous_cost),
    // Tatsächlich abgelesener Zählerstand des vorherigen Zeitraums (optional).
    previousMetered: row.previous_metered == null ? null : Number(row.previous_metered),
    lastCalibrationAt: row.last_calibration_at == null ? null : Number(row.last_calibration_at),
    lastCalibrationFactor: row.last_calibration_factor == null ? null : Number(row.last_calibration_factor),
  };
}

async function loadBilling(db) {
  const row = await dbGet(db, 'SELECT * FROM heizung_billing WHERE id = 1');
  return rowToBilling(row || {});
}

// Startwert des laufenden Zeitraums setzen. Er verschiebt nur die Summe, der
// Zeitraum selbst läuft weiter.
async function setStartConsumption(db, value) {
  const start = amount(value, 'den Startwert', { required: true });
  await dbRun(db, `INSERT INTO heizung_billing (id, start_consumption, started_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET start_consumption = excluded.start_consumption`,
  [start, Date.now()]);
  return loadBilling(db);
}

// Der Zeitraum beginnt beim ersten Aufruf still mit dem aktuellen Zeitpunkt —
// sonst stünde das Zählwerk ohne Anfang da.
async function ensureStarted(db, now = Date.now()) {
  const billing = await loadBilling(db);
  if (billing.startedAt != null) return billing;
  await dbRun(db, `INSERT INTO heizung_billing (id, started_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at`, [now]);
  return loadBilling(db);
}

// Zahlen des laufenden Zeitraums. `measured` ist das, was homeESS selbst
// gemessen hat, `consumption` zusätzlich der Startwert.
async function billingStatistics(db, config, billing, now = Date.now()) {
  const from = billing.startedAt == null ? now : billing.startedAt;
  const runtimeMs = await central.runtimeMsSince(db, from, now).catch(() => 0);
  const measured = central.costOf(config, runtimeMs);
  const consumption = (billing.startConsumption || 0) + measured.consumption;
  const cost = consumption * (Number(config.pricePerUnit) || 0);
  return {
    unit: config.unit,
    startedAt: billing.startedAt,
    days: Math.max(0, Math.floor((now - from) / 86400000)),
    runtimeMs,
    startConsumption: billing.startConsumption || 0,
    measuredConsumption: measured.consumption,
    consumption,
    cost,
    // Der Monatsabschlag ist die Summe des Zeitraums geteilt durch zwölf.
    monthly: cost / 12,
    previous: billing.previousEndedAt == null ? null : {
      startedAt: billing.previousStartedAt,
      endedAt: billing.previousEndedAt,
      consumption: billing.previousConsumption,
      metered: billing.previousMetered,
      cost: billing.previousCost,
      monthly: (billing.previousCost || 0) / 12,
    },
    lastCalibrationAt: billing.lastCalibrationAt,
    lastCalibrationFactor: billing.lastCalibrationFactor,
  };
}

/**
 * Zeitraum abschließen: der laufende wandert ins Archiv, der neue beginnt bei 0.
 *
 * @param {object} input
 * @param {string} [input.metered]   tatsächlich abgelesener Verbrauch
 * @param {boolean} input.calibrate  den Verbrauch je Betriebsstunde nachziehen
 */
async function closePeriod(db, input = {}, now = Date.now()) {
  const config = await central.loadCentralConfig(db);
  const billing = await ensureStarted(db, now);
  const stats = await billingStatistics(db, config, billing, now);
  const metered = amount(input.metered, 'den abgelesenen Zählerstand');
  const calibrate = input.calibrate === true;

  if (calibrate && metered == null) {
    throw validation('Zum Kalibrieren wird der abgelesene Zählerstand gebraucht.');
  }

  let factor = null;
  if (calibrate) {
    // Verglichen wird, was homeESS selbst gemessen hat: der Startwert stammt
    // nicht aus der Messung und darf den Faktor nicht verzerren.
    const measured = stats.measuredConsumption;
    const real = metered - stats.startConsumption;
    if (!(measured > 0)) throw validation('Ohne gemessene Brennerlaufzeit lässt sich nichts kalibrieren.');
    if (!(real > 0)) throw validation('Der abgelesene Zählerstand liegt unter dem Startwert — bitte prüfen.');
    factor = real / measured;
    if (factor < MIN_CALIBRATION_FACTOR || factor > MAX_CALIBRATION_FACTOR) {
      throw validation('Abgelesener und geschätzter Verbrauch liegen zu weit auseinander — hängen weitere Verbraucher am Zähler?');
    }
    const corrected = Math.round((Number(config.consumptionPerHour) || 0) * factor * 1000) / 1000;
    await dbRun(db, 'UPDATE heizung_central SET consumption_per_hour = ? WHERE id = 1', [corrected]);
  }

  const consumption = Math.round(stats.consumption * 1000) / 1000;
  const cost = (metered == null ? consumption : metered) * (Number(config.pricePerUnit) || 0);
  await dbRun(db, `UPDATE heizung_billing SET
      previous_started_at = ?, previous_ended_at = ?, previous_consumption = ?, previous_cost = ?,
      previous_metered = ?, started_at = ?, start_consumption = 0,
      last_calibration_at = ?, last_calibration_factor = ?
    WHERE id = 1`, [
    billing.startedAt, now, consumption, Math.round(cost * 100) / 100, metered, now,
    factor == null ? billing.lastCalibrationAt : now,
    factor == null ? billing.lastCalibrationFactor : Math.round(factor * 1000) / 1000,
  ]);
  return { billing: await loadBilling(db), factor };
}

module.exports = {
  MIN_CALIBRATION_FACTOR, MAX_CALIBRATION_FACTOR,
  loadBilling, setStartConsumption, ensureStarted, billingStatistics, closePeriod,
};
