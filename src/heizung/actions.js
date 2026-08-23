'use strict';

// Aktionsfolgen eines Raums im Modul „Heizung & Klima".
//
// Ein einzelnes An-/Aus-Topic reicht für echte Geräte nicht: eine
// Splitklimaanlage will Betriebsart, Solltemperatur und Einschaltbefehl in
// bestimmter Reihenfolge, oft mit Pausen dazwischen, und ein IR-Befehl kommt
// nicht immer an. Deshalb steuert jeder Raum seine Geräte mit denselben
// Aktionsfolgen wie das Heimkino: Wertzuweisungen, Pausen und Schleifen mit
// zyklischer Plausibilitätsprüfung.
//
// Vier Folgen je Raum — je Gerät eine für „ein" und eine für „aus":
//   heat_on / heat_off  – lokales Heizgerät
//   cool_on / cool_off  – lokales Kühlgerät
//
// Ob ein Raum ein Heiz- bzw. Kühlgerät hat, ergibt sich daraus, ob seine
// „ein"-Folge Aktionen enthält (siehe heizung/runtime.js).

const { createActionRepository } = require('../automation/action-sequences');

const PHASES = [
  {
    key: 'heat_on',
    label: 'Heizen einschalten',
    hint: 'Läuft, sobald der Raum Wärme braucht und das lokale Gerät sie liefern soll.',
    device: 'heat',
    on: true,
  },
  {
    key: 'heat_off',
    label: 'Heizen ausschalten',
    hint: 'Läuft, sobald der Raum keine Wärme mehr braucht, ein Kontakt sperrt oder die Zentralheizung übernimmt.',
    device: 'heat',
    on: false,
  },
  {
    key: 'cool_on',
    label: 'Kühlen einschalten',
    hint: 'Läuft, sobald die Raumtemperatur den Kühl-Offset überschreitet.',
    device: 'cool',
    on: true,
  },
  {
    key: 'cool_off',
    label: 'Kühlen ausschalten',
    hint: 'Läuft, sobald nicht mehr gekühlt werden soll oder ein Kontakt sperrt.',
    device: 'cool',
    on: false,
  },
];

const PHASE_KEYS = PHASES.map((phase) => phase.key);

const repository = createActionRepository({
  table: 'heizung_actions',
  ownerTable: 'heizung_rooms',
  ownerColumn: 'room_id',
  phases: PHASE_KEYS,
  ownerMissing: 'Raum nicht gefunden.',
});

// Folge zu Gerät und Schaltrichtung.
function phaseFor(device, on) {
  return `${device}_${on ? 'on' : 'off'}`;
}

function phaseLabel(phase) {
  const entry = PHASES.find((item) => item.key === phase);
  return entry ? entry.label : phase;
}

// Zählt die Aktionen einer Folge (Schleifeninhalte mitgezählt).
function countActions(list) {
  return (list || []).reduce((sum, action) => sum + 1 + countActions(action.children), 0);
}

// Hat der Raum ein Gerät dieser Art? Maßgeblich ist die „ein"-Folge: ohne sie
// gibt es nichts einzuschalten, der Raum erfasst dann nur seine Temperatur.
function hasDevice(tree, device) {
  return countActions((tree || {})[phaseFor(device, true)]) > 0;
}

module.exports = { ...repository, PHASES, PHASE_KEYS, phaseFor, phaseLabel, countActions, hasDevice };
