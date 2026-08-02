'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-dashboard-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const widgetsRepo = require('../src/dashboard/widgets');
const systemInfo = require('../src/dashboard/system-info');
const { openDatabase } = require('../src/db');

function freshDb() {
  fs.rmSync(process.env.HOME_ESS_DB, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

test('Wert-Widget: State-Topic Pflicht, Typ default value', async () => {
  const db = await freshDb();
  const widget = await widgetsRepo.createWidget(db, { stateTopic: 'system://homeess/pv_leistung' });
  assert.equal(widget.type, 'value');
  assert.equal(widget.stateTopic, 'system://homeess/pv_leistung');
  assert.equal(widget.infoFields, undefined);

  await assert.rejects(() => widgetsRepo.createWidget(db, { type: 'value', stateTopic: '' }), /State/);
  db.close();
});

test('Alte Wertekatalog-Bezüge werden dauerhaft als State-Topic migriert', async () => {
  const db = await freshDb();
  await new Promise((resolve, reject) => db.run(
    "INSERT INTO dashboard_widgets (source_id, state_topic, type) VALUES ('pv.current', '', 'value')",
    (error) => (error ? reject(error) : resolve())
  ));

  const [widget] = await widgetsRepo.listWidgets(db);
  assert.equal(widget.stateTopic, 'system://homeess/pv.current');
  const stored = await new Promise((resolve, reject) => db.get(
    'SELECT source_id, state_topic FROM dashboard_widgets WHERE id = ?',
    [widget.id],
    (error, row) => (error ? reject(error) : resolve(row))
  ));
  assert.deepEqual(stored, { source_id: '', state_topic: 'system://homeess/pv.current' });
  db.close();
});

test('Alte Widget-Tabelle erhält das neue State-Feld vor der Datenmigration', async () => {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.run(
    `CREATE TABLE dashboard_widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'value',
      config TEXT, group_id INTEGER, position INTEGER NOT NULL DEFAULT 0, tab_id INTEGER
    )`,
    (error) => (error ? reject(error) : resolve())
  ));
  await new Promise((resolve, reject) => db.run(
    "INSERT INTO dashboard_widgets (source_id, type) VALUES ('pv.today', 'value')",
    (error) => (error ? reject(error) : resolve())
  ));

  const [widget] = await widgetsRepo.listWidgets(db);
  assert.equal(widget.stateTopic, 'system://homeess/pv.today');
  const columns = await new Promise((resolve, reject) => db.all(
    'PRAGMA table_info(dashboard_widgets)',
    (error, rows) => (error ? reject(error) : resolve(rows))
  ));
  assert.ok(columns.some((column) => column.name === 'state_topic'));
  db.close();
});

test('Topicförmige alte Adapter-Bezüge werden unverändert übernommen', async () => {
  const db = await freshDb();
  await new Promise((resolve, reject) => db.run(
    "INSERT INTO dashboard_widgets (source_id, state_topic, type) VALUES ('modbus://wechselrichter/power', '', 'value')",
    (error) => (error ? reject(error) : resolve())
  ));

  const [widget] = await widgetsRepo.listWidgets(db);
  assert.equal(widget.stateTopic, 'modbus://wechselrichter/power');
  const stored = await new Promise((resolve, reject) => db.get(
    'SELECT source_id, state_topic FROM dashboard_widgets WHERE id = ?',
    [widget.id],
    (error, row) => (error ? reject(error) : resolve(row))
  ));
  assert.deepEqual(stored, { source_id: '', state_topic: 'modbus://wechselrichter/power' });
  db.close();
});

test('Info-Widget: kein sourceId nötig, Felder default = alle', async () => {
  const db = await freshDb();
  const widget = await widgetsRepo.createWidget(db, { type: 'info' });
  assert.equal(widget.type, 'info');
  assert.deepEqual(widget.infoFields, systemInfo.DEFAULT_INFO_FIELDS);

  // Runtrip über die DB (persistiert als JSON in config).
  const [loaded] = await widgetsRepo.listWidgets(db);
  assert.equal(loaded.type, 'info');
  assert.deepEqual(loaded.infoFields, systemInfo.DEFAULT_INFO_FIELDS);
  db.close();
});

test('Info-Widget: nur gewählte, gültige Felder in Katalog-Reihenfolge', async () => {
  const db = await freshDb();
  const widget = await widgetsRepo.createWidget(db, {
    type: 'info',
    infoFields: ['mem_usage', 'unbekannt', 'node_version'],
  });
  // Reihenfolge folgt dem Katalog, ungültige verworfen.
  assert.deepEqual(widget.infoFields, ['node_version', 'mem_usage']);

  const updated = await widgetsRepo.updateWidget(db, widget.id, {
    type: 'info',
    infoFields: ['cpu_load'],
  });
  assert.deepEqual(updated.infoFields, ['cpu_load']);
  db.close();
});

test('Wert-Widget: Größe/Farbe werden validiert und persistiert, Default L', async () => {
  const db = await freshDb();
  const plain = await widgetsRepo.createWidget(db, { stateTopic: 'system://homeess/pv.current' });
  // Bestandskompatibler Standard: ohne Angabe Größe L und Standardfarbe.
  assert.equal(plain.size, 'l');
  assert.equal(plain.color, '');

  const styled = await widgetsRepo.createWidget(db, {
    stateTopic: 'system://homeess/pv.today',
    size: 'm',
    color: '#E67E22',
  });
  assert.equal(styled.size, 'm');
  assert.equal(styled.color, '#e67e22');

  // Ungültige Werte fallen auf die Defaults zurück (serverseitige Validierung).
  const invalid = await widgetsRepo.updateWidget(db, styled.id, {
    stateTopic: 'system://homeess/pv.today',
    size: 'riesig',
    color: 'rot',
  });
  assert.equal(invalid.size, 'l');
  assert.equal(invalid.color, '');
  db.close();
});

test('Schalter-Widget: Ziel Pflicht, Konfiguration wird persistiert', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => widgetsRepo.createWidget(db, { type: 'switch', switchTarget: '' }),
    /schaltbares/
  );
  // Ungültige Zielformate werden verworfen (kein freies Topic-Schreiben).
  await assert.rejects(
    () => widgetsRepo.createWidget(db, { type: 'switch', switchTarget: 'topic/evil' }),
    /schaltbares/
  );

  const widget = await widgetsRepo.createWidget(db, {
    type: 'switch',
    switchTarget: 'actor:7',
    switchLabel: 'Poolpumpe',
    onColor: '#ffcc00',
    offColor: '#dddddd',
    size: 's',
  });
  assert.equal(widget.sourceId, 'actor:7');
  assert.equal(widget.switchLabel, 'Poolpumpe');
  assert.equal(widget.onColor, '#ffcc00');
  assert.equal(widget.offColor, '#dddddd');
  assert.equal(widget.size, 's');

  const [loaded] = await widgetsRepo.listWidgets(db);
  assert.equal(loaded.type, 'switch');
  assert.equal(loaded.sourceId, 'actor:7');
  assert.equal(loaded.onColor, '#ffcc00');
  db.close();
});

test('readSystemInfo liefert Anzeige + Prozent für Auslastungen', () => {
  const info = systemInfo.readSystemInfo();
  assert.ok(info.homeess_version.display);
  assert.ok(info.node_version.display.startsWith('v'));
  for (const key of ['cpu_load', 'mem_usage']) {
    assert.ok(typeof info[key].percent === 'number');
    assert.ok(info[key].percent >= 0 && info[key].percent <= 100);
  }
});

test('formatBytes und formatDuration formatieren menschenlesbar', () => {
  assert.equal(systemInfo.formatBytes(0), '0 B');
  assert.equal(systemInfo.formatBytes(1536), '1.5 KB');
  assert.equal(systemInfo.formatDuration(0), '0 min');
  assert.equal(systemInfo.formatDuration(90061), '1 d 1 h 1 min');
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* egal */
  }
});
