'use strict';

// Trigger-Typen des Nachrichtensystems und ihre Flankenerkennung.
//
// Alle fünf Trigger werten eine FLANKE aus, nicht einen Zustand: maßgeblich ist
// immer das Paar (alter Wert, neuer Wert). Damit entstehen keine wiederholten
// Pushs, solange eine Bedingung dauerhaft erfüllt bleibt — ein Taster, der
// mehrfach denselben Wert meldet, und ein Messwert, der oberhalb einer Grenze
// schwankt, lösen genau einmal aus.
//
// Ist der alte Wert unbekannt (Regel neu angelegt, Server gerade gestartet, State
// hat noch nie einen Wert geliefert), gibt es keine Flanke: die Regel löst nicht
// aus und der erste empfangene Wert dient nur als Ausgangsbasis. Sonst würde
// jeder Neustart eine Welle von Benachrichtigungen erzeugen.

const TRIGGER_TYPES = ['changed', 'equals', 'not_equals', 'above', 'below'];

const TRIGGER_LABELS = {
  changed: 'Wert ändert sich',
  equals: 'Ist gleich',
  not_equals: 'Ist ungleich',
  above: 'Steigt über',
  below: 'Fällt unter',
};

// Trigger, die zwingend einen Vergleichswert brauchen.
const TRIGGER_NEEDS_VALUE = new Set(['equals', 'not_equals', 'above', 'below']);
// Trigger, die zwingend einen numerischen State brauchen.
const NUMERIC_TRIGGERS = new Set(['above', 'below']);

const TRUE_WORDS = ['true', 'on', 'ein', 'an', 'ja'];
const FALSE_WORDS = ['false', 'off', 'aus', 'nein'];

// Einen Roh-Wert in seinen Vergleichstyp überführen. MQTT und Adapter liefern
// denselben Zustand je nach Quelle als Boolean, Zahl oder Text ("true", "1",
// "22.5"); die Regel soll davon unabhängig funktionieren.
function comparable(value) {
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : { type: 'string', value: String(value) };
  const text = String(value == null ? '' : value).trim();
  const lower = text.toLowerCase();
  if (TRUE_WORDS.includes(lower)) return { type: 'boolean', value: true };
  if (FALSE_WORDS.includes(lower)) return { type: 'boolean', value: false };
  if (text !== '' && Number.isFinite(Number(text.replace(',', '.')))) return { type: 'number', value: Number(text.replace(',', '.')) };
  return { type: 'string', value: text };
}

// Werttyp eines States für die Oberfläche: boolean, number oder string. Ohne
// bekannten Wert `null` — dann bleibt jede Trigger-Auswahl erlaubt.
function valueType(value) {
  if (value == null || value === '') return null;
  return comparable(value).type;
}

// Zahl aus einem Wert gewinnen; `null`, wenn er nicht numerisch ist. Boolean
// zählt bewusst NICHT als Zahl: „Steigt über 0" auf einem Schalter ist keine
// sinnvolle Regel und wird schon beim Speichern abgewiesen.
function toNumber(value) {
  const item = comparable(value);
  return item.type === 'number' ? item.value : null;
}

function isNumericValue(value) {
  return toNumber(value) !== null;
}

// Gleichheit über Darstellungsgrenzen hinweg: 1 und "true" sind derselbe
// Schaltzustand, "12.50" und 12,5 dieselbe Zahl.
function valuesEqual(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (a.type === 'number' && b.type === 'number') return Math.abs(a.value - b.value) <= 0.000001;
  if (a.type === 'boolean' && b.type === 'number') return Number(a.value) === b.value;
  if (a.type === 'number' && b.type === 'boolean') return a.value === Number(b.value);
  if (a.type === 'boolean' && b.type === 'boolean') return a.value === b.value;
  return String(a.value) === String(b.value);
}

// Kern der Flankenerkennung. `previous` ist { known, value }; `known: false`
// heißt „kein Vorwert" und löst nie aus.
//
//   changed     alt != neu
//   equals      alt != Wert  UND  neu == Wert
//   not_equals  alt == Wert  UND  neu != Wert
//   above       alt <= Wert  UND  neu >  Wert
//   below       alt >= Wert  UND  neu <  Wert
function matches(triggerType, triggerValue, previous, nextValue) {
  if (!previous || previous.known !== true) return false;
  const oldValue = previous.value;
  if (triggerType === 'changed') return !valuesEqual(oldValue, nextValue);
  if (triggerType === 'equals') return !valuesEqual(oldValue, triggerValue) && valuesEqual(nextValue, triggerValue);
  if (triggerType === 'not_equals') return valuesEqual(oldValue, triggerValue) && !valuesEqual(nextValue, triggerValue);
  if (triggerType !== 'above' && triggerType !== 'below') return false;

  // Grenzwertvergleiche sind ausschließlich numerisch: ein nicht numerischer
  // State oder Vergleichswert löst nie aus (statt stillschweigend als 0 zu gelten).
  const limit = toNumber(triggerValue);
  const before = toNumber(oldValue);
  const after = toNumber(nextValue);
  if (limit == null || before == null || after == null) return false;
  if (triggerType === 'above') return before <= limit && after > limit;
  return before >= limit && after < limit;
}

module.exports = {
  TRIGGER_TYPES,
  TRIGGER_LABELS,
  TRIGGER_NEEDS_VALUE,
  NUMERIC_TRIGGERS,
  comparable,
  valueType,
  toNumber,
  isNumericValue,
  valuesEqual,
  matches,
};
