'use strict';

// Übersteuerung der Klimaanlage eines Raums („Heizung & Klima").
//
// Ist in einem Raum eine Klimaanlage zum Kühlen eingerichtet (eine „Kühlen
// ein"-Aktionsfolge), lässt sich ihr Zustand von Hand übersteuern:
//
//   0 = Aus   – die Anlage bleibt aus
//   1 = An    – die Anlage läuft
//   2 = Automatik – die Regelung entscheidet (Voreinstellung)
//
// Eine Übersteuerung setzt die automatischen Aktionsschleifen des Kühlgerätes
// außer Kraft: die Anlage reagiert dann weder auf einen offenen Fenster-/
// Türkontakt noch auf die Raumtemperatur, sondern bleibt in ihrem geschalteten
// Zustand stehen. Zurück auf Automatik springt sie allein, wenn der Raum die
// eingestellte **Soll-Temperatur erreicht** — gemeint ist der Übergang dorthin
// (Ist-Temperatur fällt auf Soll oder darunter). War die Soll-Temperatur beim
// Umschalten bereits erreicht, ist das keine Flanke und hebt die Übersteuerung
// deshalb nicht sofort wieder auf.
//
// Zusätzlich lässt sich je Raum eine **Uhrzeit** hinterlegen, zu der eine
// Handschaltung von selbst auf Automatik zurückfällt (leer = keine). Maßgeblich
// ist die erste Fälligkeit **nach** dem Umschalten: wer um 23:00 Uhr auf „An"
// schaltet, dessen Rückkehr um 22:00 Uhr kommt erst am folgenden Tag. Gerechnet
// wird in lokaler Wandzeit über den zentralen Timehandler, damit ein Neustart
// den Zeitpunkt nachholt statt ihn zu verlieren.
//
// Vorrang behält das **Betriebslevel**: deckt das aktuelle Level die Priorität
// des Kühlgerätes nicht ab, bleibt die Anlage auch bei „An" aus
// (LEVEL_HANDLING.md). Die eingestellte Betriebsart bleibt dabei stehen und
// wirkt wieder, sobald das Level sie freigibt.
//
// Die Werte liegen als homeESS-Systemwerte unter `system://homeess/klima.…` und
// erscheinen auf der States-Seite im Ordner **Klima** mit einem Unterordner je
// Raum:
//
//   System / Klima / Wohnzimmer / Betriebsart   (beschreibbar: 0/1/2)
//   System / Klima / Wohnzimmer / Aktiv         (nur lesend)

const { topicForId } = require('../states/system-topics');
const timeHandler = require('../time-handler');

// Systemwerte der Klimaanlagen: id-Präfix und Ordner auf der States-Seite.
const ID_PREFIX = 'klima.';
const CATEGORY = 'Klima';

const MODE_OFF = 0;
const MODE_ON = 1;
const MODE_AUTO = 2;
const MODES = [MODE_OFF, MODE_ON, MODE_AUTO];

const MODE_LABELS = {
  [MODE_OFF]: 'Aus',
  [MODE_ON]: 'An',
  [MODE_AUTO]: 'Automatik',
};

// Je Raum zwei Werte: die beschreibbare Betriebsart und der tatsächliche
// Zustand der Anlage.
const CLIMATE_STATES = [
  // Die Betriebsart ist das einzige Schreibziel; auf der States-Seite wird sie
  // als Auswahl bedient.
  {
    suffix: 'betriebsart',
    label: 'Betriebsart',
    unit: '',
    writable: true,
    control: {
      type: 'select',
      options: [
        { value: MODE_OFF, label: MODE_LABELS[MODE_OFF] },
        { value: MODE_ON, label: MODE_LABELS[MODE_ON] },
        { value: MODE_AUTO, label: MODE_LABELS[MODE_AUTO] },
      ],
    },
  },
  { suffix: 'aktiv', label: 'Aktiv', unit: '', writable: false },
];

// Geschrieben werden darf die Betriebsart als Zahl (0/1/2) oder als Wort.
// Alles andere bleibt folgenlos (null), damit ein Tippfehler die Anlage nicht
// stillschweigend abstellt.
function normalizeMode(value, fallback = null) {
  if (value === true) return MODE_ON;
  if (value === false) return MODE_OFF;
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  if (['0', 'aus', 'off', 'false', 'nein', 'no'].includes(raw)) return MODE_OFF;
  if (['1', 'an', 'ein', 'on', 'true', 'ja', 'yes'].includes(raw)) return MODE_ON;
  if (['2', 'auto', 'automatik', 'automatic'].includes(raw)) return MODE_AUTO;
  return fallback;
}

function modeLabel(mode) {
  return MODE_LABELS[normalizeMode(mode, MODE_AUTO)];
}

// Uhrzeit der selbsttätigen Rückkehr auf Automatik. Leer heißt: keine.
// `null` meldet eine unbrauchbare Eingabe — der Aufrufer entscheidet, ob das
// eine Fehlermeldung wert ist.
function parseResetTime(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.replace(/\s+/g, ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function minutesOfDay(time) {
  const parts = String(time).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

// Fortlaufende Tagesnummer der lokalen Wandzeit — damit die Rechnung über
// Mitternacht hinweg aufgeht.
function dayNumber(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
}

function wallMinutes(at) {
  const parts = timeHandler.calendar(new Date(at));
  return dayNumber(parts) * 1440 + parts.hours * 60 + parts.minutes;
}

// Ist die eingestellte Uhrzeit seit dem Umschalten erreicht? Fällig ist der
// erste Zeitpunkt nach `since`; eine Umschaltung genau zur eingestellten Minute
// zählt noch nicht (sonst wäre sie sofort wieder aufgehoben).
function resetDue(resetTime, since, now = Date.now()) {
  const time = parseResetTime(resetTime);
  if (!time || since == null) return false;
  const target = minutesOfDay(time);
  const parts = timeHandler.calendar(new Date(since));
  const sinceDay = dayNumber(parts);
  const sinceMinutes = parts.hours * 60 + parts.minutes;
  const dueDay = sinceMinutes < target ? sinceDay : sinceDay + 1;
  return wallMinutes(now) >= dueDay * 1440 + target;
}

// Eine Betriebsart ungleich Automatik übersteuert die Regelung.
function isOverride(mode) {
  return normalizeMode(mode, MODE_AUTO) !== MODE_AUTO;
}

// id und Topic eines Klima-Wertes, benannt nach dem Raum. Die Adressbildung
// teilt sich der Ordner mit den Raumwerten (heizung/rooms.js).
function stateId(address, suffix) {
  return `${ID_PREFIX}${address}.${suffix}`;
}
function stateTopic(address, suffix) {
  return topicForId(stateId(address, suffix));
}

// Systemwert-Einträge eines Raums mit Klimaanlage. Räume ohne Kühlgerät haben
// nichts zu übersteuern und tauchen deshalb gar nicht erst auf.
function climateEntries(room, address, state = {}) {
  const mode = normalizeMode(state.climateMode == null ? room.climateMode : state.climateMode, MODE_AUTO);
  const values = { betriebsart: mode, aktiv: state.cooling ? 1 : 0 };
  return CLIMATE_STATES.map((definition) => {
    const value = values[definition.suffix];
    return {
      id: stateId(address, definition.suffix),
      // Der Wertekatalog ist eine flache Liste — deshalb trägt die Beschriftung
      // den Raum, auch wenn die States-Seite ihn schon als Ordner zeigt.
      label: `${room.name} – Klimaanlage ${definition.label}`,
      category: `${CATEGORY}/${room.name}`,
      unit: definition.unit,
      writable: definition.writable,
      control: definition.control,
      value,
      display: definition.suffix === 'betriebsart' ? MODE_LABELS[value] : (value ? 'Ein' : 'Aus'),
    };
  });
}

module.exports = {
  ID_PREFIX, CATEGORY, CLIMATE_STATES, MODES, MODE_OFF, MODE_ON, MODE_AUTO, MODE_LABELS,
  normalizeMode, modeLabel, isOverride, stateId, stateTopic, climateEntries,
  parseResetTime, resetDue,
};
