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

test('Custom-State-Verzeichnisse lassen sich bearbeiten und ohne Zyklen umhängen', async () => {
  const db = await freshDb();
  const first = await custom.addFolder(db, { name: 'Erste Ebene' });
  const second = await custom.addFolder(db, { name: 'Zweite Ebene' });
  const child = await custom.addFolder(db, { name: 'Kind', parentId: first.id });
  const state = await custom.addState(db, {
    folderId: child.id, name: 'Status', dataType: 'boolean', value: 'true',
  });

  await custom.updateFolder(db, child.id, { name: 'Bearbeitet', parentId: second.id });
  const moved = (await custom.rowsWithPaths(db)).states.find((item) => item.id === state.id);
  assert.equal(moved.topic, 'custom://Zweite%20Ebene/Bearbeitet/Status');
  await assert.rejects(
    () => custom.updateFolder(db, second.id, { name: 'Zweite Ebene', parentId: child.id }),
    /Unterverzeichnisse/,
  );

  await close(db);
  bus.remove(state.topic);
  bus.remove(moved.topic);
});

test('Custom-State-Layout verschiebt und sortiert Verzeichnisse und States konsistent', async () => {
  const db = await freshDb();
  const alpha = await custom.addFolder(db, { name: 'Alpha' });
  const beta = await custom.addFolder(db, { name: 'Beta' });
  const one = await custom.addState(db, { folderId: alpha.id, name: 'Eins', dataType: 'integer', value: '1' });
  const two = await custom.addState(db, { folderId: alpha.id, name: 'Zwei', dataType: 'integer', value: '2' });

  await custom.updateLayout(db, {
    folders: [
      { id: beta.id, parentId: null, position: 0 },
      { id: alpha.id, parentId: beta.id, position: 0 },
    ],
    states: [
      { id: two.id, folderId: alpha.id, position: 0 },
      { id: one.id, folderId: beta.id, position: 0 },
    ],
  });
  const data = await custom.rowsWithPaths(db);
  assert.deepEqual(
    data.folders.filter((item) => item.id === beta.id).map(({ name, parentId, position }) => ({ name, parentId, position })),
    [{ name: 'Beta', parentId: null, position: 0 }],
  );
  assert.deepEqual(
    data.folders.filter((item) => item.id === alpha.id).map(({ name, parentId, position }) => ({ name, parentId, position })),
    [{ name: 'Alpha', parentId: beta.id, position: 0 }],
  );
  assert.equal(data.states.find((item) => item.id === one.id).topic, 'custom://Beta/Eins');
  assert.equal(data.states.find((item) => item.id === two.id).topic, 'custom://Beta/Alpha/Zwei');
  assert.equal(bus.getCache().has('custom://Alpha/Eins'), false);
  assert.equal(bus.getCache().get('custom://Beta/Eins').value, 1);

  await assert.rejects(() => custom.updateLayout(db, {
    folders: [
      { id: alpha.id, parentId: beta.id, position: 0 },
      { id: beta.id, parentId: alpha.id, position: 0 },
    ],
    states: [
      { id: one.id, folderId: beta.id, position: 0 },
      { id: two.id, folderId: alpha.id, position: 0 },
    ],
  }), /keinen Kreis/);

  await close(db);
  for (const state of data.states) bus.remove(state.topic);
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

test('Custom States lassen alle Eigenschaften einschließlich Verzeichnis nachträglich bearbeiten', async () => {
  const db = await freshDb();
  const folder = await custom.addFolder(db, { name: 'Messwerte' });
  const state = await custom.addState(db, { name: 'Rohwert', dataType: 'text', value: '21.29' });
  const updated = await custom.updateState(db, state.id, {
    folderId: folder.id, name: 'Temperatur', dataType: 'float', value: '21.29',
    unit: '°C', decimals: '1', rounding: 'floor',
  });
  assert.deepEqual({
    folderId: updated.folderId, name: updated.name, dataType: updated.dataType,
    value: updated.value, unit: updated.unit, decimals: updated.decimals,
    rounding: updated.rounding, topic: updated.topic,
  }, {
    folderId: folder.id, name: 'Temperatur', dataType: 'float', value: 21.2,
    unit: '°C', decimals: 1, rounding: 'floor', topic: 'custom://Messwerte/Temperatur',
  });
  assert.equal(bus.getCache().has('custom://Rohwert'), false);
  assert.equal(bus.getCache().get(updated.topic).value, 21.2);
  await close(db);
  bus.remove(updated.topic);
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

test('Custom-State-View entspricht dem Gruppenraster und bietet Bearbeitung sowie Dragflächen', async () => {
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
  assert.match(html, /class="ms-groups custom-states-groups"/);
  assert.match(html, /class="ms-group custom-folder"/);
  assert.match(html, /class="ms-group-head custom-folder-head"/);
  assert.match(html, /class="widget-drag ms-group-drag custom-folder-drag"/);
  assert.match(html, /class="widget-drag custom-state-drag"/);
  assert.match(html, /data-folder-id="1"/);
  assert.match(html, /fetch\('\/states\/custom\/layout'/);
  assert.match(html, /Verzeichnis bearbeiten/);
  assert.match(html, /name="parentId"/);
  assert.match(html, /Custom State bearbeiten/);
  assert.match(html, /secondary-button" onclick="openFolderDialog\('add'\)">Verzeichnis hinzufügen<\/button><button type="button" class="secondary-button" onclick="openStateDialog\('add'\)">State hinzufügen/);
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(inlineScripts.length > 0);
  assert.doesNotThrow(() => new Function(inlineScripts.at(-1)[1]));
  await close(db);
  bus.remove('custom://Automatik/Counter');
});
