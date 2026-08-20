'use strict';

// Belegungsmarke der Instanz.
//
// Hintergrund: homeESS startet eine Adapterinstanz bei jeder Änderung neu.
// Überlappen sich zwei solche Neustarts — etwa weil kurz hintereinander ein
// Gerät umbenannt und eines entfernt wird —, kann ein Kindprozess entstehen,
// den der Supervisor nicht mehr kennt und deshalb nie beendet. Er läuft weiter
// und hält den Coordinator besetzt; der aktuelle Prozess bekommt ihn nie und
// zeigt ein leeres Netz.
//
// Der Adapter kann das nicht verhindern, aber erkennen: Jeder Start hinterlegt
// im instanzeigenen Datenverzeichnis, wer gerade zuständig ist. Findet ein
// Prozess dort einen anderen vor, ist er der Überzählige — er gibt den
// Coordinator frei und beendet sich. Der zuletzt gestartete Prozess gewinnt,
// und genau der ist der vom Supervisor geführte.

const fs = require('fs');
const path = require('path');

const LOCK_FILE = 'instance.lock';
// Häufig genug, damit der Coordinator zügig frei wird, selten genug, um nicht
// dauernd das Dateisystem zu berühren.
const CHECK_INTERVAL_MS = 8000;

function lockPath(dataDirectory) {
  return path.join(dataDirectory, LOCK_FILE);
}

function readLock(dataDirectory) {
  try {
    const raw = fs.readFileSync(lockPath(dataDirectory), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { pid: Number(parsed.pid), startedAt: Number(parsed.startedAt) || 0 };
  } catch (_) {
    // Keine Marke, unlesbar oder halb geschrieben: Das ist kein Grund, einen
    // laufenden Adapter zu beenden.
    return null;
  }
}

/**
 * Trägt den eigenen Prozess als zuständig ein.
 */
function claim(dataDirectory, now = Date.now()) {
  const target = lockPath(dataDirectory);
  const record = { pid: process.pid, startedAt: now };
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (_) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch (_ignored) {
      /* nichts weiter zu tun */
    }
  }
  return record;
}

/**
 * Prüft, ob dieser Prozess noch der zuständige ist.
 *
 * Eine fehlende oder unlesbare Marke gilt ausdrücklich als „zuständig": Lieber
 * läuft der Adapter weiter, als dass ein Dateisystemfehler ihn beendet.
 */
function isOwner(dataDirectory, own) {
  const current = readLock(dataDirectory);
  if (!current || !Number.isInteger(current.pid)) return true;
  if (current.pid === process.pid) return true;
  // Ein Eintrag, der älter ist als der eigene Start, stammt aus einem bereits
  // beendeten Vorgänger und wird nicht als Übernahme gewertet.
  if (own && current.startedAt && current.startedAt < own.startedAt) return true;
  return false;
}

/**
 * Beobachtet die Marke und meldet die Übernahme durch einen anderen Prozess.
 *
 * @returns {function} beendet die Beobachtung
 */
function watch(dataDirectory, own, onSuperseded, intervalMs = CHECK_INTERVAL_MS) {
  const timer = setInterval(() => {
    if (isOwner(dataDirectory, own)) return;
    clearInterval(timer);
    const current = readLock(dataDirectory);
    try {
      onSuperseded(current);
    } catch (_) {
      /* Der Rückruf darf die Beobachtung nicht sprengen. */
    }
  }, Math.max(1000, intervalMs));
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { LOCK_FILE, CHECK_INTERVAL_MS, lockPath, readLock, claim, isOwner, watch };
