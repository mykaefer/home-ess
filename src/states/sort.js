'use strict';

// Einheitliche Sortierung für States, Kategorien und Katalogeinträge.
// Alphanumerisch aufsteigend: Groß-/Kleinschreibung spielt keine Rolle, und
// Zahlenanteile werden als Zahl verglichen (Kanal2 vor Kanal10).

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function compareText(left, right) {
  return collator.compare(String(left == null ? '' : left), String(right == null ? '' : right));
}

// Vergleich mit stabilem Zweitschlüssel (z. B. Adresse/Topic), damit Einträge
// mit gleichem Anzeigenamen eine feste Reihenfolge behalten.
function compareBy(primary, secondary) {
  return (left, right) => compareText(primary(left), primary(right))
    || (secondary ? compareText(secondary(left), secondary(right)) : 0);
}

// States nach Anzeigename, bei Gleichstand nach Adresse bzw. Topic.
const compareStates = compareBy(
  (state) => (state && state.name != null ? state.name : (state && state.address) || ''),
  (state) => (state && (state.address != null ? state.address : state.topic)) || ''
);

// Katalogeinträge des Wertepickers nach Beschriftung, dann nach Topic-ID.
const compareCatalogItems = compareBy((item) => item && item.label, (item) => item && item.id);

// Baumknoten (Kategorien/Verzeichnisse) nach Namen.
const compareNodes = compareBy((node) => node && node.name);

function sortStates(states) {
  return (states || []).sort(compareStates);
}

module.exports = { collator, compareText, compareStates, compareCatalogItems, compareNodes, sortStates };
