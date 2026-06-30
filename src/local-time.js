'use strict';

const { buildEnvironmentSnapshot } = require('./mqtt/config');

function pad(value) { return String(value).padStart(2, '0'); }

function zonedParts(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year), month: Number(values.month), day: Number(values.day),
      hours: Number(values.hour), minutes: Number(values.minute), seconds: Number(values.second),
    };
  } catch (_) {
    return {
      year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(),
      hours: now.getUTCHours(), minutes: now.getUTCMinutes(), seconds: now.getUTCSeconds(),
    };
  }
}

function weekKey(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

function localCalendar(cache, timezone, now = new Date()) {
  const fallback = zonedParts(now, timezone);
  const environment = cache && typeof cache.get === 'function' ? buildEnvironmentSnapshot(cache) : null;
  const date = environment && environment.date && environment.date.iso ? environment.date : null;
  const time = environment && environment.time && environment.time.iso ? environment.time : null;
  const parts = {
    year: date ? date.year : fallback.year,
    month: date ? date.month : fallback.month,
    day: date ? date.day : fallback.day,
    hours: time ? time.hours : fallback.hours,
    minutes: time ? time.minutes : fallback.minutes,
    seconds: time ? time.seconds : fallback.seconds,
  };
  return {
    ...parts,
    dateKey: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    weekKey: weekKey(parts),
    monthKey: `${parts.year}-${pad(parts.month)}`,
    yearKey: String(parts.year),
  };
}

module.exports = { localCalendar, zonedParts, weekKey };
