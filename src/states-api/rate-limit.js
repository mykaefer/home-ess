'use strict';

// Begrenzung fehlgeschlagener Anmeldungen an der States API.
//
// Je Client-Adresse sind innerhalb eines Fensters von 15 Minuten höchstens
// fünf Fehlversuche erlaubt; danach ist die Adresse für 15 Minuten gesperrt.
// Zusätzlich gilt eine gemeinsame Obergrenze über alle Adressen, damit viele
// Geräte zusammen nicht unbegrenzt raten können. Eine erfolgreiche Anmeldung
// setzt den Zähler der Adresse zurück. Der Zustand liegt nur im Speicher.

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_CLIENT = 5;
const MAX_FAILURES_GLOBAL = 50;
const MAX_TRACKED_CLIENTS = 1000;

const clients = new Map();
let globalFailures = [];
let globalLockedUntil = 0;

function prune(now) {
  for (const [key, entry] of clients) {
    if (entry.lockedUntil <= now && entry.firstAt + WINDOW_MS <= now) clients.delete(key);
  }
  globalFailures = globalFailures.filter((at) => at + WINDOW_MS > now);
}

// Darf die Adresse gerade einen Anmeldeversuch unternehmen?
// Ergebnis: { allowed: true } oder { allowed: false, retryAfterSeconds }
function check(client, now = Date.now()) {
  if (globalLockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((globalLockedUntil - now) / 1000) };
  }
  const entry = clients.get(String(client));
  if (entry && entry.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

// Fehlversuch zählen. Ergebnis: { locked, failures, global } — `locked` ist
// nur beim Übergang in die Sperre true (für eine einmalige Logmeldung).
function recordFailure(client, now = Date.now()) {
  prune(now);
  const key = String(client);
  let entry = clients.get(key);
  if (!entry || entry.firstAt + WINDOW_MS <= now) {
    if (!entry && clients.size >= MAX_TRACKED_CLIENTS) {
      clients.delete(clients.keys().next().value);
    }
    entry = { firstAt: now, failures: 0, lockedUntil: 0 };
    clients.set(key, entry);
  }
  entry.failures += 1;
  let locked = false;
  if (entry.failures >= MAX_FAILURES_PER_CLIENT && entry.lockedUntil <= now) {
    entry.lockedUntil = now + LOCK_MS;
    locked = true;
  }
  globalFailures.push(now);
  let global = false;
  if (globalFailures.length >= MAX_FAILURES_GLOBAL && globalLockedUntil <= now) {
    globalLockedUntil = now + LOCK_MS;
    globalFailures = [];
    global = true;
  }
  return { locked, failures: entry.failures, global };
}

function recordSuccess(client) {
  clients.delete(String(client));
}

function reset() {
  clients.clear();
  globalFailures = [];
  globalLockedUntil = 0;
}

module.exports = {
  WINDOW_MS,
  LOCK_MS,
  MAX_FAILURES_PER_CLIENT,
  MAX_FAILURES_GLOBAL,
  check,
  recordFailure,
  recordSuccess,
  reset,
};
