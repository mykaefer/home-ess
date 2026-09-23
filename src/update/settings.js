'use strict';

const branches = require('./branches');

const INTERVALS = Object.freeze({
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
});

const INTERVAL_LABELS = Object.freeze({
  hourly: 'Stündlich',
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
});

const DEFAULTS = Object.freeze({
  automaticEnabled: false,
  maintenanceStart: '03:00',
  maintenanceEnd: '04:00',
  checkInterval: 'daily',
  // Zweig, aus dem geprüft und installiert wird. Standard ist der stabile.
  branch: branches.DEFAULT_BRANCH,
});

function normalizeTime(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? `${match[1]}:${match[2]}` : fallback;
}

function normalize(input = {}) {
  const interval = String(input.checkInterval || input.check_interval || '');
  return {
    automaticEnabled: input.automaticEnabled === true || input.automaticEnabled === 1 || input.automaticEnabled === '1' || input.automaticEnabled === 'on',
    maintenanceStart: normalizeTime(input.maintenanceStart || input.maintenance_start, DEFAULTS.maintenanceStart),
    maintenanceEnd: normalizeTime(input.maintenanceEnd || input.maintenance_end, DEFAULTS.maintenanceEnd),
    checkInterval: Object.hasOwn(INTERVALS, interval) ? interval : DEFAULTS.checkInterval,
    branch: branches.normalizeBranch(input.branch),
  };
}

function load(db) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT automatic_enabled AS automaticEnabled,
              maintenance_start AS maintenanceStart,
              maintenance_end AS maintenanceEnd,
              check_interval AS checkInterval,
              branch
         FROM update_config WHERE id = 1`,
      (error, row) => error ? reject(error) : resolve(normalize(row || DEFAULTS))
    );
  });
}

function save(db, input) {
  const value = normalize(input);
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO update_config
        (id, automatic_enabled, maintenance_start, maintenance_end, check_interval, branch)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         automatic_enabled = excluded.automatic_enabled,
         maintenance_start = excluded.maintenance_start,
         maintenance_end = excluded.maintenance_end,
         check_interval = excluded.check_interval,
         branch = excluded.branch`,
      [value.automaticEnabled ? 1 : 0, value.maintenanceStart, value.maintenanceEnd, value.checkInterval, value.branch],
      (error) => error ? reject(error) : resolve(value)
    );
  });
}

function timeInWindow(time, start, end) {
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const current = toMinutes(time);
  const from = toMinutes(start);
  const until = toMinutes(end);
  if (from === until) return true;
  return from < until
    ? current >= from && current < until
    : current >= from || current < until;
}

module.exports = { INTERVALS, INTERVAL_LABELS, DEFAULTS, normalize, load, save, timeInWindow };
