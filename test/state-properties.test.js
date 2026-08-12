'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-state-props-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(path.join(ADAPTER_DIR, 'historie'), { recursive: true });
fs.writeFileSync(path.join(ADAPTER_DIR, 'historie', 'adapter.json'), JSON.stringify({
  id: 'historie', prefix: 'historie', name: 'Historie', main: 'index.js',
  stateOptions: {
    label: 'Historie',
    hint: 'Historie dieses States.',
    enabledField: 'enabled',
    fields: [
      { key: 'enabled', label: 'Speichern', type: 'checkbox', default: false },
      { key: 'alias', label: 'Alias', type: 'text', default: '' },
      { key: 'mode', label: 'Modus', type: 'select', default: 'change', options: ['change', 'interval'] },
      { key: 'debounceSeconds', label: 'Entprellung', type: 'number', default: 5 },
    ],
  },
}));
fs.writeFileSync(path.join(ADAPTER_DIR, 'historie', 'index.js'), 'module.exports=()=>({start(){}});');
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const stateProperties = require('../src/states/properties');
const registry = require('../src/adapters/registry');
const { displayValue } = require('../src/adapters/states');
const renderStates = require('../src/views/states');
const { openDatabase } = require('../src/db');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function database() {
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

test('Eigenschaften runden und ergänzen die Einheit nur für ihr Topic', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  await stateProperties.init(db);

  assert.equal(stateProperties.format(21.4567, 'W', 'demo://a/b'), '21.4567 W');
  await stateProperties.save(db, 'demo://a/b', { decimals: 2, rounding: 'nearest', unit: 'kW' });
  assert.equal(stateProperties.format(21.4567, 'W', 'demo://a/b'), '21,46 kW');
  assert.equal(stateProperties.format(21.4567, 'W', 'demo://a/anderer'), '21.4567 W');
  // Andere Rundungsarten und Textwerte.
  await stateProperties.save(db, 'demo://a/b', { decimals: 0, rounding: 'ceil', unit: '' });
  assert.equal(stateProperties.format(21.2, 'W', 'demo://a/b'), '22 W');
  assert.equal(stateProperties.format('Standby', 'W', 'demo://a/b'), 'Standby W');
  assert.equal(stateProperties.format(null, 'W', 'demo://a/b'), '—');

  // Leere Eingaben entfernen den Eintrag wieder.
  await stateProperties.save(db, 'demo://a/b', { decimals: '', unit: '' });
  assert.equal(stateProperties.get('demo://a/b'), null);
  assert.equal(displayValue(21.4567, 'W', 'demo://a/b'), '21.4567 W');
});

test('Ein Neustart lädt die Eigenschaften aus der Datenbank', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  await stateProperties.save(db, 'demo://a/persistent', { decimals: 1, unit: '°C' });
  await stateProperties.reload(db);
  assert.deepEqual(stateProperties.get('demo://a/persistent'), { decimals: 1, rounding: 'nearest', unit: '°C' });
  assert.equal(displayValue(7.25, '', 'demo://a/persistent'), '7,3 °C');
});

test('Vorformatierte Werte anderer Quellen werden nachformatiert', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  await stateProperties.save(db, 'custom://Heizung/Soll', { decimals: 1, unit: '°C' });
  const entries = [
    { id: 'custom://Heizung/Soll', value: 21.44, display: '21.44', unit: '' },
    { id: 'custom://Heizung/Ist', value: 20.5, display: '20.5', unit: '' },
  ];
  stateProperties.applyToEntries(entries);
  assert.equal(entries[0].display, '21,4 °C');
  assert.equal(entries[1].display, '20.5', 'ohne Eigenschaften bleibt die Quelle unverändert');

  const blocks = [{ categories: [{ states: [{ topic: 'custom://Heizung/Soll', value: 19.96, display: '19.96' }], children: [] }] }];
  stateProperties.applyToBlocks(blocks);
  assert.equal(blocks[0].categories[0].states[0].display, '20,0 °C');
});

test('Adapteroptionen werden je Instanz und Topic gespeichert', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  await stateProperties.saveOptions(db, 3, 'demo://a/b', { enabled: true, alias: 'ab' });
  await stateProperties.saveOptions(db, 4, 'demo://a/b', { enabled: false });
  await stateProperties.saveOptions(db, 3, 'demo://a/c', { enabled: true });

  const instance = await stateProperties.listOptionsForInstance(db, 3);
  assert.deepEqual(instance.map((entry) => entry.topic), ['demo://a/b', 'demo://a/c']);
  assert.deepEqual(instance[0].options, { enabled: true, alias: 'ab' });

  const topic = await stateProperties.listOptionsForTopic(db, 'demo://a/b');
  assert.equal(topic.size, 2);
  assert.equal(topic.get(3).alias, 'ab');
  assert.equal(topic.get(4).enabled, false);

  // Leere Optionen entfernen den Datensatz.
  await stateProperties.saveOptions(db, 4, 'demo://a/b', {});
  assert.equal((await stateProperties.listOptionsForTopic(db, 'demo://a/b')).size, 1);
});

test('Die Registry übernimmt das stateOptions-Schema aus dem Manifest', () => {
  registry.loadRegistry();
  const manifest = registry.getManifest('historie');
  assert.ok(manifest.stateOptions, 'das Schema wird erkannt');
  assert.equal(manifest.stateOptions.label, 'Historie');
  assert.equal(manifest.stateOptions.enabledField, 'enabled');
  assert.deepEqual(manifest.stateOptions.fields.map((field) => field.key),
    ['enabled', 'alias', 'mode', 'debounceSeconds']);
  const mode = manifest.stateOptions.fields.find((field) => field.key === 'mode');
  assert.deepEqual(mode.options, [
    { value: 'change', label: 'change' },
    { value: 'interval', label: 'interval' },
  ]);
});

test('Ein Manifest ohne verwertbares Schema bekommt keine State-Optionen', () => {
  const dir = path.join(ADAPTER_DIR, 'ohne');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify({
    id: 'ohne', prefix: 'ohne', main: 'index.js', stateOptions: { label: 'Leer', fields: [] },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports=()=>({start(){}});');
  registry.loadRegistry();
  assert.equal(registry.getManifest('ohne').stateOptions, null);
  fs.rmSync(dir, { recursive: true, force: true });
  registry.loadRegistry();
});

test('Jede Wertzeile trägt eine Stiftschaltfläche zum Eigenschaften-Dialog', () => {
  const tree = [{
    instanceName: 'eins', prefix: 'demo', enabled: true, running: true,
    categories: [{
      name: 'Werte',
      states: [{ address: 'a', name: 'Alarm', topic: 'demo://eins/a', unit: '', writable: false, value: 1, display: '1' }],
      children: [], stateCount: 1,
    }],
  }];
  const fragment = renderStates.renderStatesTree(tree);
  assert.match(fragment, /class="state-edit-button"/);
  assert.match(fragment, /openStateProperties\('demo:\/\/eins\/a', 'Alarm'\)/);

  const page = renderStates({ tree });
  // Dialog mit Tableiste, Allgemein-Feldern und Speichern über die JSON-Route.
  assert.match(page, /id="statePropertiesDialog"/);
  assert.match(page, /id="statePropertiesTabs"/);
  assert.match(page, /statePropsDecimals/);
  assert.match(page, /statePropsRounding/);
  assert.match(page, /statePropsUnit/);
  assert.match(page, /'\/states\/properties'/);
});

test('Manifeste mit gefährlichen Feldschlüsseln werden verworfen', () => {
  const dir = path.join(ADAPTER_DIR, 'boese');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify({
    id: 'boese', prefix: 'boese', main: 'index.js',
    settings: [{ key: 'sauber', label: 'Sauber', type: 'text' }],
    stateOptions: {
      label: 'Böse',
      fields: [
        { key: 'ok_feld', label: 'Gut', type: 'text' },
        // Schlüssel, der als HTML-Attribut ausbrechen würde.
        { key: 'x" onfocus=alert(1) autofocus="', label: 'Böse', type: 'text' },
        { key: '<script>', label: 'Auch böse', type: 'text' },
      ],
    },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports=()=>({start(){}});');
  registry.loadRegistry();
  const manifest = registry.getManifest('boese');
  assert.deepEqual(manifest.stateOptions.fields.map((field) => field.key), ['ok_feld'],
    'nur unkritische Schlüssel überleben die Normalisierung');
  assert.deepEqual(manifest.settings.map((field) => field.key), ['sauber']);
  assert.equal(registry.FIELD_KEY_RE.test('mein.feld-1'), true);
  assert.equal(registry.FIELD_KEY_RE.test('feld mit leer'), false);
  fs.rmSync(dir, { recursive: true, force: true });
  registry.loadRegistry();
});

test('Wert und Stiftschaltfläche stehen rechtsbündig nebeneinander', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const label = css.slice(css.indexOf('.value-row-label {'));
  const value = css.slice(css.indexOf('.value-row-now {'));
  // Das Label nimmt den freien Platz; sonst landet der Wert bei
  // justify-content: space-between zwischen Beschriftung und Schaltfläche und
  // wandert mit der Beschriftungslänge.
  assert.match(label.slice(0, 200), /flex:\s*1 1 auto/);
  assert.match(value.slice(0, 200), /margin-left:\s*auto/);
  assert.match(value.slice(0, 200), /flex:\s*0 0 auto/);
  // Die Schaltfläche behält ihren Platz auch ungehovert (nur Deckkraft),
  // damit beim Überfahren nichts springt.
  const button = css.slice(css.indexOf('.state-edit-button {'));
  assert.match(button.slice(0, 400), /opacity:\s*0;/);
  assert.doesNotMatch(button.slice(0, 400), /display:\s*none/);
});
