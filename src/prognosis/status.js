'use strict';

// Ampelbewertung der Systemprognose. Sie wird auf der Prognoseseite als
// Kopfbereich und auf der Energie-Übersicht als Kurzhinweis gezeigt — Text und
// Einstufung kommen deshalb aus dieser gemeinsamen Quelle.
//
//   2    – Reserve reicht bis zum nächsten sichtbaren Ladebeginn
//   1    – Reserve wird bis dahin knapp
//   0    – Mindest-SoC wird vorher erreicht
//   null – Prognose unvollständig (keine PV-Wetterprognose)
function prognosisStatusInfo(status) {
  if (status === 2) {
    return {
      label: 'Gut versorgt',
      detail: 'Die Batteriereserve reicht voraussichtlich bis zum nächsten sichtbaren Ladebeginn.',
      css: 'good',
    };
  }
  if (status === 1) {
    return {
      label: 'Knapp kalkuliert',
      detail: 'Bis zum nächsten sichtbaren Ladebeginn wird die Batteriereserve voraussichtlich niedrig.',
      css: 'warn',
    };
  }
  if (status == null) {
    return {
      label: 'Prognose noch unvollständig',
      detail: 'Für die Bilanz fehlt derzeit eine PV-Wetterprognose.',
      css: 'warn',
    };
  }
  return {
    label: 'Mindeststand in Sicht',
    detail: 'Vor dem nächsten sichtbaren Ladebeginn wird der Mindest-SoC voraussichtlich erreicht.',
    css: 'bad',
  };
}

module.exports = { prognosisStatusInfo };
