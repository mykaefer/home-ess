'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-states-sort-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(path.join(ADAPTER_DIR, 'sorted'), { recursive: true });
fs.writeFileSync(path.join(ADAPTER_DIR, 'sorted', 'adapter.json'), JSON.stringify({
  id: 'sorted', prefix: 'sorted', name: 'Sortiert', main: 'index.js',
}));
fs.writeFileSync(path.join(ADAPTER_DIR, 'sorted', 'index.js'), 'module.exports=()=>({start(){}});');
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const { compareStates, compareCatalogItems, compareNodes, compareText, sortStates } = require('../src/states/sort');
const registry = require('../src/adapters/registry');
const instances = require('../src/adapters/instances');
const { buildStatesTree } = require('../src/adapters/states');
const { buildStatesTree: buildFullStatesTree } = require('../src/states/repository');
const { listCatalogLevel } = require('../src/states/catalog');
const { openDatabase } = require('../src/db');
const renderStates = require('../src/views/states');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function database() {
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

function dbRun(db, sql, params) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

test('States werden alphanumerisch aufsteigend sortiert', () => {
  const states = [
    { name: 'Kanal10', address: 'k10' },
    { name: 'kanal2', address: 'k2' },
    { name: 'Alarm', address: 'a' },
    { name: 'Kanal1', address: 'k1' },
  ];
  assert.deepEqual(sortStates(states).map((state) => state.name), ['Alarm', 'Kanal1', 'kanal2', 'Kanal10']);
  assert.ok(compareStates({ name: 'Wert2' }, { name: 'Wert10' }) < 0);
  assert.ok(compareNodes({ name: 'Gruppe2' }, { name: 'Gruppe10' }) < 0);
  assert.ok(compareCatalogItems({ label: 'a – Kanal2' }, { label: 'a – Kanal10' }) < 0);
  // Gleicher Anzeigename: die Adresse entscheidet und hält die Reihenfolge stabil.
  assert.ok(compareStates({ name: 'Gleich', address: 'b' }, { name: 'Gleich', address: 'a' }) > 0);
});

test('States-Baum und Katalog liefern dieselbe alphanumerische Reihenfolge', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  registry.loadRegistry();
  const id = await instances.createInstance(db, 'sorted', 'eins');
  const rows = [
    ['messwerte/kanal10', 'Kanal10', 'Werte / Gruppe10'],
    ['messwerte/kanal2', 'Kanal2', 'Werte / Gruppe2'],
    ['messwerte/kanal1', 'Kanal1', 'Werte / Gruppe2'],
    ['messwerte/alarm', 'Alarm', 'Werte / Gruppe2'],
  ];
  for (const [address, name, category] of rows) {
    await dbRun(db,
      `INSERT INTO adapter_states (instance_id, address, name, category, unit, writable, last_value, updated_at)
       VALUES (?, ?, ?, ?, '', 0, NULL, ?)`,
      [id, address, name, category, Date.now()]);
  }

  const tree = await buildStatesTree(db);
  const block = tree.find((entry) => entry.instanceName === 'eins');
  const werte = block.categories.find((category) => category.name === 'Werte');
  assert.deepEqual(werte.children.map((child) => child.name), ['Gruppe2', 'Gruppe10']);
  assert.deepEqual(
    werte.children[0].states.map((state) => state.name),
    ['Alarm', 'Kanal1', 'Kanal2']
  );

  const level = await listCatalogLevel(db, new Map(), 'Adapter: eins / Werte', 0);
  assert.deepEqual(level.nodes.map((node) => node.name), ['Gruppe2', 'Gruppe10']);
  const leaf = await listCatalogLevel(db, new Map(), 'Adapter: eins / Werte / Gruppe2', 0);
  assert.deepEqual(leaf.items.map((item) => item.label), ['eins – Alarm', 'eins – Kanal1', 'eins – Kanal2']);
});

test('Prefix-Gruppen stehen alphanumerisch unter dem System-Block', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  registry.loadRegistry();
  // Absichtlich in umgekehrter Reihenfolge angelegt: die Position in der
  // Datenbank darf die Anzeige nicht mehr bestimmen.
  for (const name of ['zwei', 'drei', 'eins']) {
    const id = await instances.createInstance(db, 'sorted', name);
    await dbRun(db,
      `INSERT INTO adapter_states (instance_id, address, name, category, unit, writable, last_value, updated_at)
       VALUES (?, 'a', 'A', 'Werte', '', 0, NULL, ?)`, [id, Date.now()]);
  }
  const tree = await buildFullStatesTree(db, new Map());
  const titles = tree.map((block) => (block.custom ? 'custom://'
    : block.virtual ? String(block.adapterName || block.instanceName)
      : `${block.prefix}://${block.instanceName}`));
  assert.equal(titles[0], 'System', 'System behält seinen festen Platz an der Spitze');
  const rest = titles.slice(1);
  assert.deepEqual(rest, [...rest].sort((a, b) => compareText(a, b)));
  assert.ok(rest.indexOf('sorted://drei') < rest.indexOf('sorted://eins'));
  assert.ok(rest.indexOf('sorted://eins') < rest.indexOf('sorted://zwei'));
});

test('Der States-Baum lässt sich als eigenständiges Fragment rendern', () => {
  const tree = [{
    instanceId: 1,
    instanceName: 'eins',
    adapterName: 'Sortiert',
    prefix: 'sorted',
    enabled: true,
    running: true,
    categories: [{
      name: 'Werte',
      states: [{ address: 'a', name: 'Alarm', topic: 'sorted://eins/a', unit: '', writable: false, value: 1, display: '1' }],
      children: [],
      stateCount: 1,
    }],
  }];
  const fragment = renderStates.renderStatesTree(tree);
  assert.ok(fragment.includes('data-state-value="sorted://eins/a"'));
  // Die Prefix-Gruppe selbst ist auf- und zuklappbar und merkt sich den Zustand.
  assert.ok(fragment.includes('<div class="states-inst" data-tree-key="sorted://eins">'));
  assert.ok(fragment.includes('class="states-inst-head" onclick="statesToggle(this)"'));
  assert.ok(fragment.includes('states-inst-body'));
  assert.ok(!fragment.includes('<html'), 'das Fragment enthält kein Seitengerüst');

  const page = renderStates({ tree });
  // Die Seite erkennt Strukturänderungen und lädt den Baum ohne Neuladen nach.
  assert.ok(page.includes('/states/tree.json'));
  assert.ok(page.includes('statesStructureChanged'));
  assert.ok(page.includes('statesReloadTree'));
});
