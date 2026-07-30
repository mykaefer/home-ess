'use strict';

// Kompatibilitätsschicht für bestehende Verbraucher. Der Wertekatalog ist keine
// eigene Datenquelle mehr: System- und Adapterwerte kommen aus dem zentralen
// States-Repository. Die bisherigen Funktionsnamen und stabilen IDs bleiben
// erhalten, damit gespeicherte Outputs und Widgets unverändert funktionieren.

const repository = require('../states/repository');
const systemValues = require('../states/system-values');

module.exports = {
  listInternalValues: repository.listAllStates,
  listCalculatedInternalValues: systemValues.listCalculatedInternalValues,
  invalidateInternalValues() {
    systemValues.invalidateInternalValues();
    repository.invalidateStates();
  },
  categoryForId: systemValues.categoryForId,
  secondsUntilNextCharge: systemValues.secondsUntilNextCharge,
  VALUE_CATEGORIES: systemValues.VALUE_CATEGORIES,
};
