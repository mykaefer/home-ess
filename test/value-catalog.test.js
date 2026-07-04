'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildValueCatalogTree, renderValueCatalog, valueCatalogScript } = require('../src/views/value-catalog');

test('Wertekatalog gruppiert mehrstufige Kategorien zu einem Verzeichnisbaum', () => {
  const values = [
    { id: 'pv.today', label: 'PV heute', display: '1 kWh', category: 'Photovoltaik' },
    { id: 'hm://i/a', label: 'Kanal 1 STATE', display: 'true', category: 'Adapter: i / Lampe / Kanal 1' },
    { id: 'hm://i/b', label: 'Kanal 2 STATE', display: 'false', category: 'Adapter: i / Lampe / Kanal 2' },
    { id: 'x.y', label: 'Sonst', display: '—', category: '' },
  ];
  const tree = buildValueCatalogTree(values);

  // Bekannte Kategorien zuerst (feste Reihenfolge), Adapter danach (alphabetisch).
  assert.deepEqual(tree.map((n) => n.name), ['Photovoltaik', 'Sonstiges', 'Adapter: i']);

  const pv = tree.find((n) => n.name === 'Photovoltaik');
  assert.equal(pv.depth, 0);
  assert.equal(pv.count, 1);
  assert.equal(pv.children.length, 0);

  // Leere Kategorie fällt auf „Sonstiges" zurück.
  assert.ok(tree.find((n) => n.name === 'Sonstiges' && n.items.some((i) => i.id === 'x.y')));

  // Adapter-Zweig ist mehrstufig: Adapter → Gerät → Kanal.
  const adapter = tree.find((n) => n.name === 'Adapter: i');
  assert.equal(adapter.count, 2, 'Zählwert summiert alle Nachfahren');
  const lampe = adapter.children[0];
  assert.equal(lampe.name, 'Lampe');
  assert.equal(lampe.depth, 1);
  assert.deepEqual(lampe.children.map((c) => c.name), ['Kanal 1', 'Kanal 2']);
  assert.equal(lampe.children[0].depth, 2);
  assert.equal(lampe.children[0].key, 'Adapter: i / Lampe / Kanal 1');
  assert.equal(lampe.children[0].items[0].id, 'hm://i/a');
});

test('Wertekatalog rendert verschachtelte Kategorien mit data-cat-key und öffnet die Auswahl', () => {
  const values = [
    { id: 'hm://i/a', label: 'Kanal 1 STATE', display: 'true', category: 'Adapter: i / Lampe / Kanal 1' },
    { id: 'pv.today', label: 'PV heute', display: '1 kWh', category: 'Photovoltaik' },
  ];
  const html = renderValueCatalog({ values, inputId: 'src', name: 'sourceId', selectedId: 'hm://i/a', label: 'Wert' });

  // Verschachtelte Ebenen tragen ihren Pfad als Persistenz-Schlüssel und die Tiefe.
  assert.ok(html.includes('data-cat-key="Adapter: i"'));
  assert.ok(html.includes('data-cat-key="Adapter: i / Lampe"'));
  assert.ok(html.includes('data-cat-key="Adapter: i / Lampe / Kanal 1"'));
  assert.ok(html.includes('value-cat--nested'), 'tiefere Ebenen sind eingerückt');
  assert.ok(html.includes('style="--tree-depth:2"'), 'Kanal-Ebene hat Tiefe 2');

  // Die Kette bis zum gewählten Wert ist serverseitig aufgeklappt (is-open).
  const kanalBlock = html.slice(html.indexOf('data-cat-key="Adapter: i / Lampe / Kanal 1"') - 120);
  assert.ok(/value-cat[^"]*is-open[^"]*"[^>]*data-cat-key="Adapter: i \/ Lampe \/ Kanal 1"/.test(html)
    || kanalBlock.includes('is-open'), 'gewählte Kategorie ist offen');

  // Die Suche findet auch über den Kategorie-Pfad (data-search enthält den Pfad).
  assert.ok(html.includes('data-search="adapter: i / lampe / kanal 1 kanal 1 state"'));
});

test('Wertekatalog-Client-Script bringt Merken- und Such-Reset-Logik mit', () => {
  const script = valueCatalogScript();
  // localStorage-Persistenz („Merken") wie beim Topic-Picker.
  assert.ok(script.includes('VALUE_CATALOG_EXPAND_KEY'));
  assert.ok(script.includes('valueCatalogSaveExpanded'));
  assert.ok(script.includes('valueCatalogLoadExpanded'));
  // Beim Leeren der Suche wird der gemerkte Zustand wiederhergestellt.
  assert.ok(script.includes('valueCatalogApplyExpanded'));
});
