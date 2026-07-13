'use strict';

// Logdatei für die Verbrauchserfassung. Hier landen auftretende Störungen
// (Sampling-Lücken, Fehler im Erfassungs-Job), damit man sie im Nachhinein direkt
// sieht, ohne die Prozessausgabe mitschneiden zu müssen. Bewusst schlank und
// wegwerf-sicher: Schreibfehler dürfen den Erfassungs-Job nie stören.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOG_PATH = path.join(path.dirname(config.DB_PATH), 'prognosis-sampling.log');
// Grobe Deckelung, damit die Datei nicht unbegrenzt wächst (bei Überschreitung
// wird sie einmalig auf die zweite Hälfte gekürzt).
const MAX_BYTES = 512 * 1024;

function timestamp(now = new Date()) {
  // Lokale, gut lesbare Zeit (ISO-nah, ohne Millisekunden).
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function trimIfLarge() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size <= MAX_BYTES) return;
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const half = content.slice(Math.floor(content.length / 2));
    const cut = half.indexOf('\n');
    fs.writeFileSync(LOG_PATH, (cut >= 0 ? half.slice(cut + 1) : half));
  } catch (_) { /* egal – Logging darf nie stören */ }
}

// Eine Zeile anhängen. `details` (optional) wird als kompaktes JSON ergänzt.
function logSamplingEvent(message, details = null) {
  try {
    const suffix = details ? ' ' + JSON.stringify(details) : '';
    fs.appendFileSync(LOG_PATH, `[${timestamp()}] ${message}${suffix}\n`);
    trimIfLarge();
  } catch (_) { /* egal – Logging darf nie stören */ }
}

module.exports = { logSamplingEvent, LOG_PATH };
