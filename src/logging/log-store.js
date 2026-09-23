'use strict';

// Zentraler Ringpuffer für alle Hintergrund-Logs des Servers.
//
// homeESS schreibt seine Laufzeitmeldungen über `console.*` (Adapter, MQTT,
// Fernzugriff, Prognose, Update …). Diese Ausgabe geht weiterhin unverändert an
// die Prozessausgabe bzw. das Journal — zusätzlich landet jede Zeile hier im
// Speicher, damit die Seite „Logs" sie ohne Dateizugriff anzeigen kann.
//
// Bewusst rein flüchtig: kein Schreiben in SQLite, keine Logdatei. Ein Neustart
// beginnt mit leerem Puffer. So kostet das Mitschneiden weder Plattenplatz noch
// Datenbanklast, und der Speicherbedarf ist durch MAX_ENTRIES gedeckelt.

const util = require('util');

// Obergrenze des Puffers. Bei Überschreitung fallen die ältesten Einträge
// heraus (gezählt in `dropped`). 5000 Zeilen à max. 2000 Zeichen bleiben auch im
// schlechtesten Fall im einstelligen Megabyte-Bereich.
const MAX_ENTRIES = 5000;
// Erst bei MAX_ENTRIES + TRIM_SLACK wird beschnitten: ein Schnitt für viele
// Einträge statt eines Schnitts je Zeile.
const TRIM_SLACK = 250;
const MAX_MESSAGE_CHARS = 2000;
// Sichtbare Zeilen je Seite. Hoch genug, um selten blättern zu müssen, klein
// genug, damit eine Antwort nicht zum Datenpaket wird.
const PAGE_SIZE = 200;

// Dringlichkeitsstufen, absteigend. Sie tragen auch die Farbgebung der Seite.
const LEVELS = ['error', 'warn', 'info', 'debug'];
const LEVEL_SET = new Set(LEVELS);
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
// Meldungen ohne [Quelle]-Präfix (z. B. „homeESS läuft auf Port 3000").
const DEFAULT_SOURCE = 'system';
const SOURCE_RE = /^\[([^\]\n]{1,80})\]/;

let entries = [];
let nextId = 1;
let dropped = 0;
let installed = false;
let patchedConsole = null;
let originals = null;

// Quelle aus dem Präfix ableiten: `[adapters] …` → `adapters`,
// `[batterie dynMinSoc] …` → `batterie`.
//
// Adapter melden je Instanz (`[adapter hm-rpc://OpenCCU] …`). Dort ist genau
// die Instanz die brauchbare Quelle — im laufenden Betrieb kommt der Großteil
// der Meldungen von den Adaptern, und wer sucht, will eine einzelne Anbindung
// sehen und nicht alle zusammen.
function parseSource(message) {
  const match = SOURCE_RE.exec(message);
  if (!match) return DEFAULT_SOURCE;
  const inner = match[1].trim();
  const adapter = /^adapter\s+(\S+)/.exec(inner);
  if (adapter) return adapter[1].slice(0, 60);
  const first = inner.split(/\s+/)[0];
  return first ? first.slice(0, 40) : DEFAULT_SOURCE;
}

// Stufe bestimmen: in erster Linie aus der benutzten console-Methode. Der
// Adapter-Host und einige Fachmodule melden Störungen jedoch über console.log
// mit dem Schlüsselwort FEHLER/WARNUNG — die werden hochgestuft, sonst gingen
// sie in der Info-Flut unter.
function classify(method, message) {
  if (method === 'error') return 'error';
  if (method === 'warn') return 'warn';
  if (method === 'debug') return 'debug';
  if (/\bFEHLER\b/.test(message)) return 'error';
  if (/\bWARNUNG\b/.test(message)) return 'warn';
  return 'info';
}

// Eine Zeile aufnehmen. Wird sowohl von der console-Umleitung als auch direkt
// von Tests bzw. künftigen Nicht-console-Quellen benutzt.
function append(level, message, ts = Date.now()) {
  const raw = String(message == null ? '' : message);
  const text = raw.length > MAX_MESSAGE_CHARS ? `${raw.slice(0, MAX_MESSAGE_CHARS)} …` : raw;
  const entry = {
    id: nextId,
    ts: Number(ts) || Date.now(),
    level: LEVEL_SET.has(level) ? level : 'info',
    source: parseSource(text),
    line: text,
  };
  nextId += 1;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES + TRIM_SLACK) {
    const cut = entries.length - MAX_ENTRIES;
    entries.splice(0, cut);
    dropped += cut;
  }
  return entry;
}

// console.* umleiten. Die Originalausgabe bleibt erhalten (Journal/Terminal),
// der Mitschnitt kommt nur hinzu. Mehrfaches Aufrufen ist wirkungslos.
function install(target = console) {
  if (installed) return false;
  originals = {};
  for (const method of CONSOLE_METHODS) {
    const original = typeof target[method] === 'function' ? target[method].bind(target) : null;
    originals[method] = target[method];
    target[method] = (...args) => {
      if (original) original(...args);
      try {
        // util.format bildet die console-Formatierung exakt nach (%s, Objekte,
        // Fehler samt Stack).
        const text = util.format(...args);
        append(classify(method, text), text);
      } catch (_) { /* egal – Logging darf den Betrieb nie stören */ }
    };
  }
  patchedConsole = target;
  installed = true;
  return true;
}

function uninstall() {
  if (!installed) return false;
  for (const method of CONSOLE_METHODS) patchedConsole[method] = originals[method];
  patchedConsole = null;
  originals = null;
  installed = false;
  return true;
}

function isInstalled() {
  return installed;
}

// Alle vorkommenden Quellen, alphabetisch – füllt die Quellenauswahl.
function listSources() {
  const seen = new Set();
  for (const entry of entries) seen.add(entry.source);
  return [...seen].sort((left, right) => left.localeCompare(right, 'de'));
}

// Anzahl je Stufe über den gesamten Puffer (ungefiltert) – die Zahlen an den
// Stufenschaltern zeigen damit, was insgesamt vorliegt.
function countLevels() {
  const counts = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return counts;
}

function normalizeLevels(value) {
  const list = Array.isArray(value)
    ? value
    : String(value == null ? '' : value).split(',');
  const picked = list.map((item) => String(item).trim().toLowerCase()).filter((item) => LEVEL_SET.has(item));
  // Leere oder unbekannte Auswahl bedeutet „alle Stufen".
  return picked.length && picked.length < LEVELS.length ? new Set(picked) : null;
}

// Quellen werden unabhängig von Groß-/Kleinschreibung verglichen; angezeigt
// bleiben sie in ihrer ursprünglichen Schreibweise (`hm-rpc://OpenCCU`).
function normalizeSource(value) {
  return String(value == null ? '' : value).trim().toLowerCase().slice(0, 60);
}

function normalizeQuery(value) {
  return String(value == null ? '' : value).trim().toLowerCase().slice(0, 100);
}

// Gefilterte Seite lesen, neueste Zeile zuerst.
//
// `anchorId` friert die Blätterung ein: ab Seite 2 werden nur Einträge bis zu
// dieser ID berücksichtigt. Ohne diesen Anker würde jede neu eintreffende
// Meldung den Inhalt der aufgeschlagenen Seite verschieben.
function read(options = {}) {
  const levels = normalizeLevels(options.levels);
  const source = normalizeSource(options.source);
  const query = normalizeQuery(options.query);
  const anchorRaw = Number(options.anchorId);
  const anchorId = Number.isFinite(anchorRaw) && anchorRaw > 0 ? Math.floor(anchorRaw) : 0;

  const matched = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (anchorId && entry.id > anchorId) continue;
    if (levels && !levels.has(entry.level)) continue;
    if (source && entry.source.toLowerCase() !== source) continue;
    if (query && !entry.line.toLowerCase().includes(query) && !entry.source.toLowerCase().includes(query)) continue;
    matched.push(entry);
  }

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const wanted = Math.max(1, Math.floor(Number(options.page) || 1));
  const page = Math.min(wanted, totalPages);
  const offset = (page - 1) * PAGE_SIZE;

  return {
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages,
    // Neueste ID der gefilterten Menge – der Browser erkennt daran, ob sich
    // überhaupt etwas geändert hat.
    latestId: total ? matched[0].id : 0,
    entries: matched.slice(offset, offset + PAGE_SIZE),
    sources: listSources(),
    counts: countLevels(),
    stored: entries.length,
    capacity: MAX_ENTRIES,
    dropped,
  };
}

// Nur für Tests: Puffer leeren.
function reset() {
  entries = [];
  nextId = 1;
  dropped = 0;
}

module.exports = {
  install, uninstall, isInstalled, append, read, listSources, countLevels, reset,
  parseSource, classify,
  LEVELS, PAGE_SIZE, MAX_ENTRIES, DEFAULT_SOURCE,
};
