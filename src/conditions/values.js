'use strict';

// Wert- und Topic-Eingaben der Bedingungen. Vergleichs- und Zielwerte sind
// bewusst zweideutig: entweder ein fest eingetragener Wert (Zahl, Text,
// Ein/Aus) oder ein Verweis auf ein Topic. Ausschlaggebend ist allein ein
// gültiges Schema-Präfix (`prefix://instanz/adresse`, z. B. `hdp://…`); alles
// andere gilt unverändert als fester Wert.
//
// Server (Repository/Engine) und Dialogskript verwenden dieselben Regeln. Damit
// die Prüfung im Browser nicht auseinanderläuft, liefert dieses Modul Muster
// und Wortlisten als Rohdaten für das eingebettete Script mit.

const TOPIC_PATTERN = '^[a-z][a-z0-9_-]*:\\/\\/\\S+$';
const TOPIC_RE = new RegExp(TOPIC_PATTERN, 'i');

// Boolesche Zustände zählen als numerisch, egal wie sie dargestellt werden.
const TRUE_WORDS = ['true', 'on', 'ein', 'an'];
const FALSE_WORDS = ['false', 'off', 'aus'];

// Vergleiche, die zwingend Zahlen brauchen.
const MATH_OPERATORS = ['gt', 'gte', 'lt', 'lte'];
// Rechenfunktionen der Dann-/Sonst-Aktionen. `set` schreibt den Wert direkt,
// alle übrigen verrechnen zwei Operanden.
const OPERATIONS = ['set', 'add', 'sub', 'mul', 'div', 'mod', 'min', 'max'];
const MAX_ROUND_DIGITS = 6;

function text(value) {
  return String(value == null ? '' : value).trim();
}

// Ein Topic-Verweis liegt vor, sobald die Eingabe mit einem gültigen Präfix
// beginnt. Leerzeichen schließen einen Verweis aus – das ist dann ein Text.
function isTopicReference(value) {
  return TOPIC_RE.test(text(value));
}

// Zahl aus einem Wert gewinnen: Zahlen, Boolean, Ein/Aus-Texte und
// Dezimalkommas. `null`, wenn der Wert nicht numerisch ist.
function toNumber(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (TRUE_WORDS.includes(lower)) return 1;
  if (FALSE_WORDS.includes(lower)) return 0;
  const number = Number(lower.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function isNumericValue(value) {
  return toNumber(value) !== null;
}

function isMathOperator(operator) {
  return MATH_OPERATORS.includes(String(operator || '').trim().toLowerCase());
}

function roundTo(number, digits) {
  if (digits == null || !Number.isFinite(number)) return number;
  return Number(number.toFixed(digits));
}

// Grundrechenarten plus Rest, Minimum und Maximum. Division durch null bleibt
// bewusst ein Fehler statt „Infinity“ ins Zieltopic zu schreiben.
function applyOperation(operation, left, right) {
  if (operation === 'add') return left + right;
  if (operation === 'sub') return left - right;
  if (operation === 'mul') return left * right;
  if (operation === 'min') return Math.min(left, right);
  if (operation === 'max') return Math.max(left, right);
  if (right === 0) throw new Error('Division durch null ist nicht möglich.');
  if (operation === 'div') return left / right;
  if (operation === 'mod') return left % right;
  throw new Error(`Unbekannte Rechenfunktion: ${operation}`);
}

module.exports = {
  TOPIC_PATTERN, TRUE_WORDS, FALSE_WORDS, MATH_OPERATORS, OPERATIONS, MAX_ROUND_DIGITS,
  isTopicReference, toNumber, isNumericValue, isMathOperator, roundTo, applyOperation,
};
