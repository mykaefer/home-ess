'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAdapterStates } = require('../src/views/adapter-states');

const editor = {
  label: 'Register',
  keyField: 'address',
  keyFields: ['address'],
  nameField: 'name',
  categoryField: 'category',
  presets: true,
  columns: [
    { key: 'address', label: 'Adresse', type: 'text', required: true },
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'category', label: 'Kategorie', type: 'text' },
    { key: 'unit', label: 'Einheit', type: 'text' },
  ],
};

test('Modbus-Registerseite merkt sich den Auf-/Zuklapp-Zustand der Kategorien', () => {
  const rows = [
    { address: '1', name: 'A', category: 'Zähler', unit: 'kWh' },
    { address: '2', name: 'B', category: 'Leistung', unit: 'W' },
  ];
  const html = renderAdapterStates({
    adapter: { name: 'Modbus TCP', prefix: 'modbus' },
    instance: { id: 42, name: 'wr1' },
    editor,
    rows,
  });

  // Jede Kategorie trägt ihren Merkschlüssel und ist standardmäßig offen.
  assert.match(html, /<details class="state-cat" open data-cat-key="Zähler">/);
  assert.match(html, /<details class="state-cat" open data-cat-key="Leistung">/);

  // Persistenz ist je Instanz getrennt (Scope = Instanz-ID) und wird beim Laden angewandt.
  assert.ok(html.includes('STATE_EDITOR_SCOPE = "42"'));
  assert.ok(html.includes('homeess.stateeditor.expanded.v1'));
  assert.ok(html.includes("addEventListener('toggle'"));
  assert.ok(html.includes('initStateCats();'));
});

test('Registerseite ohne Kategoriefeld rendert keine merkbaren Kategorien', () => {
  const flatEditor = { ...editor, categoryField: null };
  const html = renderAdapterStates({
    adapter: { name: 'Modbus TCP', prefix: 'modbus' },
    instance: { id: 7, name: 'wr2' },
    editor: flatEditor,
    rows: [{ address: '1', name: 'A', unit: 'kWh' }],
  });
  // Ohne Kategorien gibt es keine <details>-Gruppen (einfache Tabelle).
  assert.ok(!html.includes('data-cat-key='));
});
