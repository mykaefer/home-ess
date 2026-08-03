'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const custom = require('../src/states/custom');
const bus = require('../src/state-bus');
const renderCustomStates = require('../src/views/custom-states');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE custom_state_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`);
  await run(db, `CREATE TABLE custom_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER, name TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'text', unit TEXT NOT NULL DEFAULT '', decimals INTEGER,
    rounding TEXT NOT NULL DEFAULT 'nearest', value_json TEXT NOT NULL DEFAULT '""',
    position INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
  await run(db, 'CREATE UNIQUE INDEX idx_test_custom_folders ON custom_state_folders (IFNULL(parent_id, -1), name COLLATE NOCASE)');
  await run(db, 'CREATE UNIQUE INDEX idx_test_custom_states ON custom_states (IFNULL(folder_id, -1), name COLLATE NOCASE)');
  return db;
}

function close(db) { return new Promise((resolve) => db.close(resolve)); }

test('Custom States bilden beliebig tiefe Verzeichnisse und lesbare custom://-Topics', async () => {
  const db = await freshDb();
  const house = await custom.addFolder(db, { name: 'Haus' });
  const cellar = await custom.addFolder(db, { name: 'Keller', parentId: house.id });
  const state = await custom.addState(db, {
    folderId: cellar.id, name: 'Pumpen Zähler', dataType: 'integer', unit: 'Starts', value: '4',
  });

  assert.equal(state.topic, 'custom://Haus/Keller/Pumpen%20Z%C3%A4hler');
  assert.equal(state.value, 4);
  assert.equal(state.display, '4 Starts');

  const tree = await custom.managementTree(db);
  assert.equal(tree.folders[0].folders[0].states[0].id, state.id);
  assert.equal(tree.folders[0].stateCount, 1);

  await custom.updateFolder(db, house.id, { name: 'Mein Haus' });
  const renamed = (await custom.rowsWithPaths(db)).states[0];
  assert.equal(renamed.topic, 'custom://Mein%20Haus/Keller/Pumpen%20Z%C3%A4hler');
  assert.equal(bus.getCache().get(renamed.topic).value, 4);
  await close(db);
  bus.remove(state.topic);
  bus.remove('custom://Mein%20Haus/Keller/Pumpen%20Z%C3%A4hler');
});

test('Custom States validieren Datentypen und wenden numerische Rundung beim Schreiben an', async () => {
  const db = await freshDb();
  const state = await custom.addState(db, {
    name: 'Temperatur', dataType: 'float', unit: '°C', decimals: '1', rounding: 'floor', value: '21.29',
  });
  assert.equal(state.value, 21.2);

  const updated = await custom.setValue(db, state.id, '19,99');
  assert.equal(updated.value, 19.9);
  assert.equal(updated.display, '19,9 °C');
  assert.equal(bus.getCache().get('custom://Temperatur').value, 19.9);

  await assert.rejects(() => custom.addState(db, { name: 'Kaputt', dataType: 'integer', value: '1.5' }), /ganze Zahl/);
  await close(db);
  bus.remove('custom://Temperatur');
});

test('Custom-State-Katalog kennzeichnet Werte als auswählbar und schreibbar', async () => {
  const db = await freshDb();
  await custom.addState(db, { name: 'Freigabe', dataType: 'boolean', value: 'true' });
  const entries = await custom.listCatalogEntries(db);
  assert.deepEqual(entries.map(({ id, writable, topicSelectable, category }) => ({ id, writable, topicSelectable, category })), [{
    id: 'custom://Freigabe', writable: true, topicSelectable: true, category: 'Custom / Ohne Verzeichnis',
  }]);
  await close(db);
  bus.remove('custom://Freigabe');
});

test('Custom-State-View bietet persistenten Baum und direkte Wertbearbeitung', async () => {
  const db = await freshDb();
  const folder = await custom.addFolder(db, { name: 'Automatik' });
  await custom.addState(db, { folderId: folder.id, name: 'Counter', dataType: 'integer', value: '2' });
  const data = await custom.rowsWithPaths(db);
  const html = renderCustomStates({ tree: await custom.managementTree(db), folders: data.folders, states: data.states });
  assert.ok(html.includes('homeess.custom-states.expanded.v1'));
  assert.ok(html.includes('custom://Automatik/Counter'));
  assert.ok(html.includes('saveCustomValue'));
  assert.ok(html.includes('Unterverzeichnis anlegen'));
  assert.ok(html.includes('homeess.custom-states.last-state-folder.v1'));
  assert.ok(html.includes('homeess.custom-states.last-state-type.v1'));
  assert.ok(html.includes('homeess.custom-states.last-folder-parent.v1'));
  assert.match(html, /secondary-button" onclick="openFolderDialog\('add'\)">Verzeichnis anlegen<\/button><button type="button" class="secondary-button" onclick="openStateDialog\('add'\)">State anlegen/);
  await close(db);
  bus.remove('custom://Automatik/Counter');
});
