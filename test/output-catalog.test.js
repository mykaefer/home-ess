'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-output-catalog-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/adapters/registry');
const { openDatabase } = require('../src/db');
const { buildSchemeTopic } = require('../src/mqtt/topics');
const {
  listCatalogLevel,
  searchCatalog,
  resolveInternalValues,
} = require('../src/output/catalog');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

let db;
let instanceId;
const cache = new Map();

test.before(async () => {
  registry.loadRegistry();
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const inserted = await run(
    db,
    `INSERT INTO adapter_instances (adapter_id, name, enabled, settings, position)
     VALUES ('hm-rpc', 'TestCCU', 1, '{}', 1)`
  );
  instanceId = inserted.lastID;
  await run(
    db,
    `INSERT INTO adapter_states
       (instance_id, address, name, category, unit, writable, last_value, updated_at)
     VALUES
       (?, 'dev1/temp', 'Temperatur', 'Wohnzimmer / Kanal 1', '°C', 0, '20', 1),
       (?, 'dev1/humidity', 'Feuchte', 'Wohnzimmer / Kanal 1', '%', 0, '50', 1),
       (?, 'dev2/state', 'Status', 'Garage / Kanal 2', '', 0, 'false', 1)`,
    [instanceId, instanceId, instanceId]
  );
  cache.set(buildSchemeTopic('hm-rpc', 'TestCCU', 'dev1/temp'), { value: '21.5' });
});

test('Lazy-Katalog lädt Adapterwerte nur bis zur geöffneten Ebene', async () => {
  const root = await listCatalogLevel(db, cache);
  assert.deepEqual(root.nodes[0], {
    name: 'System',
    path: 'System',
    count: null,
  });
  const adapter = root.nodes.find((node) => node.path === 'Adapter: TestCCU');
  assert.deepEqual(adapter, {
    name: 'Adapter: TestCCU',
    path: 'Adapter: TestCCU',
    count: 3,
  });
  assert.equal(root.items.length, 0);

  const adapterLevel = await listCatalogLevel(db, cache, adapter.path);
  assert.deepEqual(adapterLevel.nodes.map((node) => node.name), ['Garage', 'Wohnzimmer']);
  assert.equal(adapterLevel.items.length, 0, 'eingeklappte Gerätewerte werden nicht mitgeliefert');

  const room = await listCatalogLevel(db, cache, 'Adapter: TestCCU / Wohnzimmer');
  assert.deepEqual(room.nodes.map((node) => node.name), ['Kanal 1']);
  assert.equal(room.items.length, 0);

  const channel = await listCatalogLevel(db, cache, 'Adapter: TestCCU / Wohnzimmer / Kanal 1');
  assert.equal(channel.nodes.length, 0);
  assert.equal(channel.items.length, 2);
  assert.equal(channel.items.find((item) => item.label.includes('Temperatur')).display, '21.5 °C');
});

test('Katalogsuche und gezielte Wertauflösung liefern nur passende Adapterwerte', async () => {
  const search = await searchCatalog(db, cache, 'Temperatur');
  assert.ok(search.items.some((item) => item.id === 'hm-rpc://TestCCU/dev1/temp'));
  assert.ok(search.items.every((item) =>
    `${item.category} ${item.label} ${item.id}`.toLowerCase().includes('temperatur')
  ));

  const values = await resolveInternalValues(db, cache, [
    'hm-rpc://TestCCU/dev1/temp',
    'hm-rpc://TestCCU/dev2/state',
  ]);
  assert.equal(values.length, 2);
  assert.equal(values.find((item) => item.id.endsWith('/dev1/temp')).display, '21.5 °C');
});

test.after(() => {
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* egal */
  }
});
