'use strict';

// Bedienelemente beschreibbarer States.
//
// Auf der States-Seite lässt sich jeder beschreibbare State direkt bedienen.
// Welches Element dafür passt, sagt entweder die Quelle selbst (Module und
// Custom States kennen ihren Datentyp und liefern `control` mit) oder es wird
// aus dem zuletzt gesehenen Wert abgeleitet — Adapter melden zu ihren States
// nur, ob sie beschreibbar sind, nicht wie.
//
//   switch – Ein/Aus mit zwei Schaltflächen
//   select – feste Auswahl (z. B. Aus/An/Automatik)
//   number – Zahlenfeld mit „Setzen"
//   text   – Textfeld mit „Setzen"
//
// Beim Schalten zählt die Darstellung des Ziel-States: ein Boolean-State darf
// nicht mit einer numerischen 1/0 beschrieben werden und umgekehrt (derselbe
// Grundsatz wie in heizung/runtime.js `switchPayload`). Die abgeleiteten
// Schaltwerte richten sich deshalb nach dem zuletzt gesehenen Wert.

const TRUE_WORDS = ['1', 'true', 'on', 'ein', 'an', 'ja', 'yes'];
const FALSE_WORDS = ['0', 'false', 'off', 'aus', 'nein', 'no'];
const BOOLEAN_WORDS = [...TRUE_WORDS, ...FALSE_WORDS];

const TYPES = ['switch', 'select', 'number', 'text'];

function text(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value) {
  const raw = text(value).replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

// Gilt der Wert als „ein"? Zahlen zählen ab ungleich null, Worte nach der
// obigen Liste.
function isOn(value) {
  if (value === true) return true;
  if (value === false) return false;
  const raw = text(value).toLowerCase();
  if (!raw) return false;
  if (TRUE_WORDS.includes(raw)) return true;
  if (FALSE_WORDS.includes(raw)) return false;
  const number = toNumber(raw);
  return number == null ? false : number !== 0;
}

// Zu welchem Wertepaar passt der zuletzt gesehene Wert? Ein Boolean-State
// bekommt „true"/„false", ein numerischer „1"/„0".
function switchPayloads(value) {
  if (typeof value === 'boolean') return { on: 'true', off: 'false' };
  const raw = text(value).toLowerCase();
  if (['true', 'false'].includes(raw)) return { on: 'true', off: 'false' };
  if (['on', 'off'].includes(raw)) return { on: 'on', off: 'off' };
  return { on: '1', off: '0' };
}

function looksBoolean(value) {
  if (typeof value === 'boolean') return true;
  const raw = text(value).toLowerCase();
  return raw !== '' && BOOLEAN_WORDS.includes(raw);
}

// Auswahlliste vereinheitlichen: Werte und Beschriftungen sind Zeichenketten,
// damit der Vergleich in der Oberfläche eindeutig bleibt.
function normalizeOptions(options) {
  const list = [];
  for (const option of options || []) {
    if (option == null) continue;
    const entry = typeof option === 'object' ? option : { value: option, label: option };
    if (entry.value == null) continue;
    list.push({ value: String(entry.value), label: String(entry.label == null ? entry.value : entry.label) });
  }
  return list;
}

// Angemeldetes Steuerelement vervollständigen. Eine Auswahl ohne Optionen ist
// keine Auswahl — dann bleibt es beim Eingabefeld.
function normalizeControl(control, value) {
  const type = TYPES.includes(control.type) ? control.type : 'text';
  if (type === 'switch') {
    const fallback = switchPayloads(value);
    return {
      type: 'switch',
      on: control.on == null ? fallback.on : String(control.on),
      off: control.off == null ? fallback.off : String(control.off),
    };
  }
  if (type === 'select') {
    const options = normalizeOptions(control.options);
    if (!options.length) return { type: 'text' };
    return { type: 'select', options };
  }
  if (type === 'number') {
    const result = { type: 'number' };
    if (control.min != null) result.min = Number(control.min);
    if (control.max != null) result.max = Number(control.max);
    result.step = control.step == null ? 'any' : String(control.step);
    return result;
  }
  return { type: 'text' };
}

// Passendes Steuerelement eines States. `null` bedeutet: nicht bedienbar.
function controlFor(state) {
  if (!state || state.writable !== true) return null;
  if (state.control && typeof state.control === 'object') return normalizeControl(state.control, state.value);
  const value = state.value;
  if (looksBoolean(value)) return { type: 'switch', ...switchPayloads(value) };
  if (toNumber(value) != null) return { type: 'number', step: 'any' };
  return { type: 'text' };
}

// Steuerelemente in einen fertigen States-Baum eintragen (alle Quellen: System,
// Custom States, Adapter und virtuelle Blöcke).
function applyToBlocks(blocks) {
  const walk = (categories) => {
    for (const category of categories || []) {
      for (const state of category.states || []) {
        const control = controlFor(state);
        if (control) state.control = control;
        else delete state.control;
      }
      walk(category.children);
    }
  };
  for (const block of blocks || []) walk(block.categories);
  return blocks;
}

module.exports = { controlFor, applyToBlocks, isOn, normalizeControl, switchPayloads, TYPES };
