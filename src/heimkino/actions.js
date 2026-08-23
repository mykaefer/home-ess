'use strict';

// Aktionsfolgen eines Heimkino-Raums. Je Raum gibt es zwei Folgen: „an" und
// „aus". Sie werden bei jeder Änderung des Kinomodus der Reihe nach abgearbeitet
// (heimkino/runtime.js).
//
// Datenschicht, Validierung und Layout sind mit den übrigen Modulen geteilt
// (automation/action-sequences.js); hier stehen nur Tabelle und Folgen.

const { createActionRepository } = require('../automation/action-sequences');

const repository = createActionRepository({
  table: 'heimkino_actions',
  ownerTable: 'heimkino_rooms',
  ownerColumn: 'room_id',
  phases: ['on', 'off'],
  ownerMissing: 'Raum nicht gefunden.',
});

module.exports = repository;
