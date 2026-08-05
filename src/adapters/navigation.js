'use strict';

// Die Hauptnavigation wird synchron beim Rendern der Views aufgebaut. Deshalb
// halten wir die dafür benötigten hDP-Instanzen im Speicher und aktualisieren
// sie beim Start sowie nach Änderungen an der Instanzliste.

const instancesRepo = require('./instances');

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
let hdpNavItems = [];

function setInstances(instances) {
  hdpNavItems = (Array.isArray(instances) ? instances : [])
    .filter((instance) => instance.adapterId === 'hdp')
    .sort((left, right) => collator.compare(String(left.name), String(right.name)) || left.id - right.id)
    .map((instance) => ({
      path: `/adapter/instance/${instance.id}/manage`,
      label: String(instance.name),
      section: 'main',
    }));
}

async function refresh(db) {
  setInstances(await instancesRepo.listInstances(db));
}

function getHdpNavItems() {
  return hdpNavItems.map((item) => ({ ...item }));
}

module.exports = { refresh, setInstances, getHdpNavItems };
