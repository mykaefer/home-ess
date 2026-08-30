'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const repository = require('../src/conditions/repository');
const engine = require('../src/conditions/engine');
const mqttClient = require('../src/mqtt/client');
const adapterRouter = require('../src/adapters/router');
const renderConditions = require('../src/views/conditions');
const { renderLayout } = require('../src/views/layout');
const i18n = require('../src/i18n');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}
function close(db) { return new Promise((resolve) => db.close(resolve)); }
function wait(ms = 20) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE automation_condition_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0)`);
  await run(db, `CREATE UNIQUE INDEX idx_condition_folders_parent_name
    ON automation_condition_folders (IFNULL(parent_id, -1), name COLLATE NOCASE)`);
  await run(db, `CREATE TABLE automation_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1, when_enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
    last_triggered_at INTEGER, last_result TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '')`);
  await run(db, `CREATE TABLE automation_condition_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, condition_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trigger', 'when', 'then', 'else')), type TEXT NOT NULL,
    parent_id INTEGER, config_json TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0, last_fired_at INTEGER)`);
  return db;
}

function validInput(name = 'Kino') {
  return {
    name, enabled: '1',
    triggerType: 'event', triggerTopic: 'custom://Kino', triggerValue: '1',
    whenType: 'state', whenTopic: 'custom://Freigabe', whenOperator: 'eq', whenValue: 'true',
    thenType: 'write', thenTopic: 'custom://Licht', thenValue: '20',
  };
}

test('Bedingungen erzwingen Trigger, Wenn und Dann und bleiben vollständig editierbar', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, validInput());
  assert.deepEqual([condition.triggers.length, condition.whens.length, condition.thens.length], [1, 1, 1]);
  assert.equal(condition.enabled, true);
  assert.match(condition.triggers[0].description, /exakt 1/);

  await repository.updateCondition(db, condition.id, { name: 'Kinoabend' });
  const extra = await repository.addItem(db, condition.id, {
    kind: 'when', type: 'state', topic: 'custom://Anwesenheit', operator: 'truthy',
  });
  assert.equal(extra.config.operator, 'truthy');
  await repository.updateItem(db, condition.id, extra.id, {
    type: 'state', topic: 'custom://Anwesenheit', operator: 'eq', value: 'ja',
  });
  await repository.deleteItem(db, condition.id, extra.id);
  // Ohne Trigger und ohne selbstauslösende Schleife könnte die Bedingung nie
  // laufen – der letzte Trigger bleibt deshalb gesperrt.
  await assert.rejects(
    () => repository.deleteItem(db, condition.id, condition.triggers[0].id),
    /Trigger oder eine Schleife mit zyklischer Prüfung/,
  );
  const updated = await repository.getCondition(db, condition.id);
  assert.equal(updated.name, 'Kinoabend');
  assert.equal(updated.enabled, false);
  await close(db);
});

test('Zeittrigger validieren Intervalle, Wochenzeit und Wochentage', () => {
  assert.deepEqual(repository.normalizeItemInput('trigger', {
    type: 'time', mode: 'interval', intervalAmount: '2', intervalUnit: 'hours',
  }).config, { mode: 'interval', intervalAmount: 2, intervalUnit: 'hours', intervalSeconds: 7200 });
  assert.deepEqual(repository.normalizeItemInput('trigger', {
    type: 'time', mode: 'schedule', time: '08:15', weekdays: ['1', '3', '5'],
  }).config, { mode: 'schedule', time: '08:15', weekdays: [1, 3, 5] });
  assert.throws(() => repository.normalizeItemInput('trigger', {
    type: 'time', mode: 'schedule', time: '28:00', weekdays: [],
  }), /gültige Uhrzeit/);
  assert.throws(() => repository.normalizeItemInput('then', {
    type: 'write', topic: 'system://homeess/operating/time', value: '12:00',
  }), /schreibgeschützt/);
});

test('Layout sortiert Bedingungen und verschiebt sie zwischen Verzeichnissen', async () => {
  const db = await freshDb();
  const folder = await repository.addFolder(db, { name: 'Beleuchtung' });
  const first = await repository.createCondition(db, validInput('Erste'));
  const second = await repository.createCondition(db, validInput('Zweite'));
  await repository.updateLayout(db, {
    folders: [{ id: folder.id, parentId: null, position: 0 }],
    conditions: [{ id: second.id, folderId: null, position: 0 }, { id: first.id, folderId: folder.id, position: 0 }],
  });
  const { tree } = await repository.conditionTree(db);
  assert.deepEqual(tree.conditions.map((condition) => condition.name), ['Zweite']);
  assert.deepEqual(tree.folders[0].conditions.map((condition) => condition.name), ['Erste']);
  assert.equal(tree.folders[0].conditions[0].folderId, folder.id);
  await assert.rejects(() => repository.updateLayout(db, { folders: [], conditions: [] }), /unvollständig/);
  await assert.rejects(() => repository.updateLayout(db, {
    folders: [{ id: folder.id, parentId: null, position: 0 }],
    conditions: [{ id: second.id, folderId: 9999, position: 0 }, { id: first.id, folderId: null, position: 1 }],
  }), /Zielverzeichnis nicht gefunden/);
  await close(db);
});

test('Verzeichnisse verschachteln, benennen und entfernen sich mitsamt Inhalt', async () => {
  const db = await freshDb();
  const parent = await repository.addFolder(db, { name: 'Haus' });
  const child = await repository.addFolder(db, { name: 'Küche', parentId: parent.id });
  const condition = await repository.createCondition(db, { ...validInput('Kaffee'), folderId: child.id });
  await assert.rejects(() => repository.addFolder(db, { name: 'küche', parentId: parent.id }), /gibt es den Namen bereits/);
  await assert.rejects(() => repository.updateFolder(db, parent.id, { name: 'Haus', parentId: child.id }), /Unterverzeichnisse verschoben/);
  await assert.rejects(() => repository.createCondition(db, { ...validInput('Ungültig'), folderId: 9999 }), /Zielverzeichnis nicht gefunden/);

  const tree = await repository.conditionTree(db);
  assert.deepEqual(tree.folders.find((entry) => entry.id === child.id).path, ['Haus', 'Küche']);
  assert.equal(tree.tree.folders[0].conditionCount, 1);
  assert.equal(tree.tree.folders[0].folders[0].conditions[0].id, condition.id);

  await repository.updateCondition(db, condition.id, { name: 'Kaffee', enabled: '1', folderId: '' });
  assert.equal((await repository.getCondition(db, condition.id)).folderId, null);
  await repository.updateCondition(db, condition.id, { name: 'Kaffee', enabled: '1', folderId: child.id });

  await repository.deleteFolder(db, parent.id);
  assert.deepEqual(await repository.listFolders(db), []);
  assert.deepEqual(await repository.listConditions(db), []);
  const items = await new Promise((resolve, reject) => db.all('SELECT id FROM automation_condition_items', (error, rows) => error ? reject(error) : resolve(rows)));
  assert.equal(items.length, 0);
  await close(db);
});

test('Exakte Ereignisse führen Aktionen nur bei erfüllten Wenn-Prüfungen aus', async () => {
  const db = await freshDb();
  await repository.createCondition(db, validInput());
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Freigabe', true);
    adapterRouter.ingestTopic('custom://Kino', 0);
    await wait();
    assert.equal(writes.length, 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.deepEqual(writes, [{ topic: 'custom://Licht', value: 20 }]);
    const condition = (await repository.listConditions(db))[0];
    assert.match(condition.lastResult, /Ausgeführt/);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Wertänderungen verwenden das erste Sample nur als Startbasis', async () => {
  const db = await freshDb();
  const input = validInput('Temperaturänderung');
  input.triggerType = 'change';
  input.triggerTopic = 'custom://Temperatur';
  delete input.triggerValue;
  await repository.createCondition(db, input);
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Freigabe', true);
    adapterRouter.ingestTopic('custom://Temperatur', 20);
    await wait();
    assert.equal(writes.length, 0);
    adapterRouter.ingestTopic('custom://Temperatur', 21);
    await wait();
    assert.equal(writes.length, 1);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Intervalltrigger laufen über die zentrale Uhr und schreiben Aktionen in Reihenfolge', async () => {
  const db = await freshDb();
  await repository.createCondition(db, {
    name: 'Takt', enabled: '1', triggerType: 'time', triggerMode: 'interval',
    triggerIntervalAmount: '1', triggerIntervalUnit: 'minutes',
    whenType: 'state', whenTopic: 'custom://Bereit', whenOperator: 'truthy',
    thenType: 'write', thenTopic: 'custom://Impuls', thenValue: '1',
  });
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    const startedAt = Date.now();
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Bereit', true);
    await engine.checkTimeTriggers(startedAt + 61000);
    await wait();
    assert.deepEqual(writes, [{ topic: 'custom://Impuls', value: 1 }]);
    await engine.checkTimeTriggers(startedAt + 62000);
    await wait();
    assert.equal(writes.length, 1, 'darf innerhalb desselben Intervalls nicht erneut auslösen');
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Vergleiche behandeln Zahlen, Boolean, Text und Schwellwerte eindeutig', () => {
  assert.equal(engine.compare('20.0', 'eq', 20), true);
  assert.equal(engine.compare('true', 'eq', true), true);
  assert.equal(engine.compare('21', 'gt', '20'), true);
  assert.equal(engine.compare('Kinoabend', 'contains', 'abend'), true);
  assert.equal(engine.compare(false, 'falsy'), true);
});

test('Ausführungsschutz begrenzt versehentliche Automationsschleifen', async () => {
  const db = await freshDb();
  await repository.createCondition(db, validInput('Schleifenschutz'));
  const originalPublish = mqttClient.publish;
  let writes = 0;
  mqttClient.publish = () => { writes += 1; return true; };
  try {
    await engine.init(db);
    const condition = engine.getRuntime()[0];
    condition.whens = [];
    for (let index = 0; index < 61; index += 1) await engine.evaluateCondition(condition);
    assert.equal(writes, 60);
    const stored = (await repository.listConditions(db))[0];
    assert.match(stored.lastError, /Ausführungsschutz/);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Vergleichs- und Zielwerte fordern bei mathematischer Verwendung Zahlen, erlauben aber Topics', () => {
  assert.equal(repository.normalizeItemInput('when', {
    type: 'state', topic: 'custom://Temperatur', operator: 'gt', value: 'custom://Sollwert',
  }).config.value, 'custom://Sollwert');
  assert.equal(repository.normalizeItemInput('when', {
    type: 'state', topic: 'custom://Schalter', operator: 'eq', value: 'Standby',
  }).config.value, 'Standby');
  assert.throws(() => repository.normalizeItemInput('when', {
    type: 'state', topic: 'custom://Temperatur', operator: 'lte', value: 'warm',
  }), /numerisch/);
  // Boolesche Darstellungen gelten als numerisch.
  assert.equal(repository.normalizeItemInput('when', {
    type: 'state', topic: 'custom://Freigabe', operator: 'gte', value: 'ein',
  }).config.value, 'ein');
  assert.deepEqual(repository.normalizeItemInput('then', {
    type: 'write', topic: 'custom://Ziel', operation: 'add', value: 'custom://Basis', value2: '2,5', round: '1',
  }).config, { topic: 'custom://Ziel', operation: 'add', value: 'custom://Basis', value2: '2,5', round: 1 });
  assert.throws(() => repository.normalizeItemInput('then', {
    type: 'write', topic: 'custom://Ziel', operation: 'mul', value: 'zwei', value2: '3',
  }), /numerisch/);
  assert.throws(() => repository.normalizeItemInput('then', {
    type: 'write', topic: 'custom://Ziel', operation: 'add', value: '1', value2: '2', round: '9',
  }), /Nachkommastellen/);
  // Ohne Rundung darf ein direkt gesetzter Wert Text sein, mit Rundung nicht.
  assert.equal(repository.normalizeItemInput('then', {
    type: 'write', topic: 'custom://Ziel', operation: 'set', value: 'Standby',
  }).config.value, 'Standby');
  assert.throws(() => repository.normalizeItemInput('then', {
    type: 'write', topic: 'custom://Ziel', operation: 'set', value: 'Standby', round: '2',
  }), /numerisch/);
  assert.throws(() => repository.normalizeItemInput('else', {
    type: 'write', topic: 'custom://Ziel', operation: 'wurzel', value: '1', value2: '2',
  }), /Rechenfunktion/);
  const described = repository.describeItem({
    kind: 'then', type: 'write',
    config: { topic: 'custom://Ziel', operation: 'div', value: 'custom://Quelle', value2: '3', round: 2 },
  });
  assert.match(described, /custom:\/\/Ziel auf custom:\/\/Quelle ÷ 3 setzen, gerundet auf 2 Nachkommastellen/);
});

test('Wenn-Vergleiche lesen ihren Vergleichswert auf Wunsch aus einem Topic', async () => {
  const db = await freshDb();
  const input = validInput('Schwelle');
  input.whenTopic = 'custom://Temperatur';
  input.whenOperator = 'gt';
  input.whenValue = 'custom://Sollwert';
  await repository.createCondition(db, input);
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Sollwert', 21);
    adapterRouter.ingestTopic('custom://Temperatur', 20);
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.equal(writes.length, 0, 'unter dem Sollwert bleibt die Aktion aus');
    adapterRouter.ingestTopic('custom://Temperatur', 22);
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.deepEqual(writes, [{ topic: 'custom://Licht', value: 20 }]);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Dann-Aktionen rechnen mit festen Werten und Topic-Werten und runden auf Wunsch', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, {
    ...validInput('Rechnen'),
    thenTopic: 'custom://Summe', thenOperation: 'add', thenValue: 'custom://Bezug', thenValue2: '1000', thenRound: '1',
  });
  await repository.addItem(db, condition.id, {
    kind: 'then', type: 'write', topic: 'custom://Anteil',
    operation: 'div', value: 'custom://Bezug', value2: '3', round: '2',
  });
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Freigabe', true);
    adapterRouter.ingestTopic('custom://Bezug', 1234.567);
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.deepEqual(writes, [
      { topic: 'custom://Summe', value: 2234.6 },
      { topic: 'custom://Anteil', value: 411.52 },
    ]);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Ohne Wenn-Prüfung läuft der Dann-Zweig bedingungslos', async () => {
  const db = await freshDb();
  const input = validInput('Bedingungslos');
  input.whenEnabled = '0';
  delete input.whenTopic; delete input.whenOperator; delete input.whenValue;
  const condition = await repository.createCondition(db, input);
  assert.deepEqual([condition.whenEnabled, condition.whens.length], [false, 0]);
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.deepEqual(writes, [{ topic: 'custom://Licht', value: 20 }]);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Der Sonst-Zweig läuft bei nicht erfüllter Prüfung und nimmt wie das Dann mehrere Aktionen auf', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, {
    ...validInput('Sonstzweig'), elseEnabled: '1',
    elseType: 'write', elseTopic: 'custom://Notlicht', elseOperation: 'set', elseValue: '5',
  });
  assert.equal(condition.elses.length, 1);
  // Seit Dann und Sonst Aktionsfolgen sind (Wert, Pause, Schleife), darf auch
  // der Sonst-Zweig mehrere Aktionen enthalten.
  await repository.addItem(db, condition.id, {
    kind: 'else', type: 'write', topic: 'custom://Zweites', value: '1',
  });
  assert.equal((await repository.getCondition(db, condition.id)).elses.length, 2);
  await repository.deleteItem(db, condition.id,
    (await repository.getCondition(db, condition.id)).elses[1].id);
  await assert.rejects(
    () => repository.updateCondition(db, condition.id, { name: 'Sonstzweig', enabled: '1', whenEnabled: '0' }),
    /nicht deaktiviert/,
  );
  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Freigabe', false);
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.deepEqual(writes, [{ topic: 'custom://Notlicht', value: 5 }]);
    assert.match((await repository.listConditions(db))[0].lastResult, /Sonst ausgeführt/);
    adapterRouter.ingestTopic('custom://Freigabe', true);
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.deepEqual(writes[1], { topic: 'custom://Licht', value: 20 });
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Wenn-Prüfung und Wenn-Elemente bleiben gekoppelt, ein Sonst-Zweig braucht die Prüfung', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, validInput('Kopplung'));
  await repository.deleteItem(db, condition.id, condition.whens[0].id);
  const withoutWhen = await repository.getCondition(db, condition.id);
  assert.deepEqual([withoutWhen.whenEnabled, withoutWhen.whens.length], [false, 0]);
  await assert.rejects(() => repository.addItem(db, condition.id, {
    kind: 'else', type: 'write', topic: 'custom://Notlicht', value: '1',
  }), /aktive Wenn-Prüfung/);
  await repository.addItem(db, condition.id, {
    kind: 'when', type: 'state', topic: 'custom://Freigabe', operator: 'truthy',
  });
  assert.equal((await repository.getCondition(db, condition.id)).whenEnabled, true);
  await assert.rejects(() => repository.createCondition(db, {
    ...validInput('Sonst ohne Wenn'), whenEnabled: '0', elseEnabled: '1',
    elseType: 'write', elseTopic: 'custom://Notlicht', elseValue: '1',
  }), /aktive Wenn-Prüfung/);
  await close(db);
});

test('Rechenwerte und Zielwerte melden fehlende oder untaugliche Topic-Werte als Fehler', async () => {
  const db = await freshDb();
  await repository.createCondition(db, {
    ...validInput('Textwert'),
    thenTopic: 'custom://Summe', thenOperation: 'mul', thenValue: 'custom://Modus', thenValue2: '2',
  });
  const originalPublish = mqttClient.publish;
  let writes = 0;
  mqttClient.publish = () => { writes += 1; return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Freigabe', true);
    adapterRouter.ingestTopic('custom://Modus', 'Sommer');
    adapterRouter.ingestTopic('custom://Kino', 0);
    adapterRouter.ingestTopic('custom://Kino', 1);
    await wait();
    assert.equal(writes, 0);
    const stored = (await repository.listConditions(db))[0];
    assert.equal(stored.lastResult, 'Fehler');
    assert.match(stored.lastError, /numerisch/);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Bedingungsseite folgt dem Gruppenraster und bietet Pluszeile, Dialoge und mobile Bedienung', async () => {
  const db = await freshDb();
  await repository.createCondition(db, validInput());
  const html = renderConditions(await repository.conditionTree(db));
  assert.match(html, /class="ms-groups conditions-groups"/);
  assert.match(html, /class="ms-group condition-group"/);
  assert.match(html, /class="widget-drag ms-group-drag condition-drag"/);
  assert.match(html, /class="condition-add-row"/);
  assert.match(html, /Zeitliche Wiederholung/);
  assert.match(html, /Wertänderung/);
  assert.match(html, /Exaktes Ereignis/);
  assert.match(html, /data-state-picker/);
  assert.match(html, /data-state-picker-writable/);
  assert.match(html, /fetch\('\/conditions\/layout'/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) assert.doesNotThrow(() => new Function(script[1]));
  // Menüplatz: direkt hinter Messen + Schalten (dessen Geräte ausgewertet
  // werden) und vor den technischen Seiten Adapter/States.
  const navHtml = renderLayout({ activePath: '/conditions' });
  assert.ok(navHtml.indexOf('href="/messen-schalten"') < navHtml.indexOf('href="/conditions"'));
  assert.ok(navHtml.indexOf('href="/conditions"') < navHtml.indexOf('href="/adapter"'));
  assert.ok(navHtml.indexOf('href="/adapter"') < navHtml.indexOf('href="/output"'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.condition-item \{\s*display: grid;\s*grid-template-columns: 68px minmax\(0, 1fr\) 60px;/);
  assert.match(css, /\.access-read \.main-content \.condition-add-row/);
  await close(db);
});

test('Dialoge bieten Wenn-Schalter, Sonst-Bereich, Rechenfunktionen und Wertprüfung', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, {
    ...validInput('Vollausbau'), elseEnabled: '1',
    thenOperation: 'add', thenValue: 'custom://Bezug', thenValue2: '100', thenRound: '1',
    elseType: 'write', elseTopic: 'custom://Notlicht', elseOperation: 'set', elseValue: '5',
  });
  const html = renderConditions(await repository.conditionTree(db));
  // Vier Bereiche mit eigener Kennzeichnung. Trigger und Wenn tragen den
  // Bereich als Chip, Dann und Sonst die Aktionsart (Wert, Pause, Schleife) –
  // der Bereich steht dort in der Abschnittsüberschrift.
  assert.match(html, /class="condition-kind condition-kind--when">Wenn</);
  assert.match(html, /class="condition-section condition-section--else"/);
  assert.match(html, /class="condition-kind cnd-kind--write">Wert</);
  assert.match(html, /<option value="else">Sonst<\/option>/);
  // Wenn und Sonst sind im Anlegen-Dialog zuschaltbar.
  assert.match(html, /id="createWhenEnabled" type="checkbox" name="whenEnabled"/);
  assert.match(html, /id="createElseEnabled" type="checkbox" name="elseEnabled"/);
  assert.match(html, /id="conditionEditWhenEnabled" type="checkbox" name="whenEnabled"/);
  // Vergleichs- und Zielwerte nehmen Werte oder Topics auf: Hinweis, Picker und
  // roter Hinweistext gehören zu jedem dieser Felder.
  for (const id of ['createWhenValue', 'createThenValue', 'createThenValue2', 'createElseValue', 'conditionItemValue']) {
    assert.match(html, new RegExp(`id="${id}" name="[a-zA-Z0-9]+" data-condition-value data-state-picker`));
    assert.match(html, new RegExp(`id="${id}Error" hidden>Wert muss bei mathematischen Operatoren numerisch sein<`));
  }
  // Sieben Wertfelder plus die Vergleichswerte der beiden Schleifen-Prüfungen
  // (Anlegen-Dialog und Element-Dialog).
  assert.equal((html.match(/class="field-hint">Fester Wert oder Topic</g) || []).length, 9);
  assert.match(html, /<option value="mul">Multiplizieren \(×\)<\/option>/);
  assert.match(html, /id="conditionItemRound" name="round" type="number" min="0" max="6"/);
  assert.match(html, /custom:\/\/Licht auf custom:\/\/Bezug \+ 100 setzen, gerundet auf 1 Nachkommastellen/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) assert.doesNotThrow(() => new Function(script[1]));
  assert.match(html, /function syncConditionValidity\(\)/);
  assert.match(html, /button\[type="submit"\]/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.condition-kind--else \{/);
  assert.match(css, /\.dialog-grid\[hidden\] \{ display: none !important; \}/);
  assert.equal(condition.elses[0].description, 'custom://Notlicht auf 5 setzen');
  await close(db);
});

// ── Aktionsfolgen im Dann-/Sonst-Zweig: Wert, Pause und Schleife ──────────
test('Dann und Sonst nehmen Pausen und Schleifen auf und beschreiben sie verständlich', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, validInput('Folge'));
  const pause = await repository.addItem(db, condition.id, { kind: 'then', type: 'pause', seconds: '1,5' });
  assert.equal(pause.config.seconds, 1.5);
  assert.equal(pause.description, 'Pause für 1,5 s');
  assert.equal(pause.typeLabel, 'Pause');

  const loop = await repository.addItem(db, condition.id, {
    kind: 'then', type: 'loop', repeats: '3', checkEnabled: '1',
    checkTopic: 'custom://Licht', checkOperator: 'eq', checkValue: '20', checkIntervalSeconds: '60',
  });
  assert.equal(loop.config.repeats, 3);
  assert.equal(loop.config.check.topic, 'custom://Licht');
  assert.match(loop.description, /Schleife · 3× durchlaufen · Prüfung alle 60 s: custom:\/\/Licht ist gleich 20/);

  // Aktionen in der Schleife hängen als Kinder unter ihr.
  const inner = await repository.addItem(db, condition.id, {
    kind: 'then', type: 'write', parentId: loop.id, topic: 'custom://Licht', value: '20',
  });
  assert.equal(inner.parentId, loop.id);
  const tree = (await repository.getCondition(db, condition.id)).thenTree;
  const loopNode = tree.find((node) => node.type === 'loop');
  assert.equal(loopNode.children.length, 1);
  assert.equal(loopNode.children[0].id, inner.id);

  // Grenzen der Eingaben.
  await assert.rejects(() => repository.addItem(db, condition.id, { kind: 'then', type: 'pause', seconds: '0' }), /Pause muss/);
  await assert.rejects(() => repository.addItem(db, condition.id, { kind: 'then', type: 'loop', repeats: '0' }), /Durchläufe/);
  await assert.rejects(() => repository.addItem(db, condition.id, {
    kind: 'then', type: 'loop', repeats: '2', checkEnabled: '1', checkTopic: 'custom://X', checkOperator: 'eq', checkValue: '1', checkIntervalSeconds: '1',
  }), /Prüfabstand/);
  // Nur Schleifen nehmen Aktionen auf.
  await assert.rejects(() => repository.addItem(db, condition.id, {
    kind: 'then', type: 'write', parentId: pause.id, topic: 'custom://Y', value: '1',
  }), /nur in eine Schleife/);

  // Eine Schleife nimmt beim Löschen ihren Inhalt mit.
  await repository.deleteItem(db, condition.id, loop.id);
  const rest = await repository.getCondition(db, condition.id);
  assert.equal(rest.thens.some((item) => item.id === inner.id), false);
  await close(db);
});

test('Der Dann-Zweig läuft als Folge: Reihenfolge, Pause und Schleifendurchläufe', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, {
    name: 'Ablauf', enabled: '1', triggerType: 'event', triggerTopic: 'custom://Start', triggerValue: '1',
    whenEnabled: '0', thenType: 'write', thenTopic: 'custom://Eins', thenValue: '1',
  });
  await repository.addItem(db, condition.id, { kind: 'then', type: 'pause', seconds: '0.1' });
  const loop = await repository.addItem(db, condition.id, { kind: 'then', type: 'loop', repeats: '3' });
  await repository.addItem(db, condition.id, {
    kind: 'then', type: 'write', parentId: loop.id, topic: 'custom://Zwei', value: '2',
  });

  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Start', 0);
    adapterRouter.ingestTopic('custom://Start', 1);
    await wait(400);
    assert.deepEqual(writes, [
      { topic: 'custom://Eins', value: 1 },
      { topic: 'custom://Zwei', value: 2 },
      { topic: 'custom://Zwei', value: 2 },
      { topic: 'custom://Zwei', value: 2 },
    ], 'erst der Wert, dann die Pause, danach die Schleife dreimal');
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Zyklische Prüfung spult nur die Schleife des zuletzt gelaufenen Zweigs erneut ab', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, {
    name: 'Nachfassen', enabled: '1', triggerType: 'event', triggerTopic: 'custom://Start', triggerValue: '1',
    whenEnabled: '0', thenType: 'write', thenTopic: 'custom://Egal', thenValue: '0',
  });
  const loop = await repository.addItem(db, condition.id, {
    kind: 'then', type: 'loop', repeats: '1', checkEnabled: '1',
    checkTopic: 'custom://Ist', checkOperator: 'eq', checkValue: '20', checkIntervalSeconds: '5',
  });
  await repository.addItem(db, condition.id, {
    kind: 'then', type: 'write', parentId: loop.id, topic: 'custom://Soll', value: '20',
  });

  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    // Ohne gelaufenen Zweig wird nicht geprüft.
    adapterRouter.ingestTopic('custom://Ist', 0);
    await engine.checkLoops(Date.now() + 60000);
    await wait(80);
    assert.equal(writes.length, 0, 'vor der ersten Ausführung bleibt die Prüfung stumm');

    adapterRouter.ingestTopic('custom://Start', 0);
    adapterRouter.ingestTopic('custom://Start', 1);
    await wait(120);
    const afterRun = writes.length;
    assert.ok(afterRun >= 2, 'der Zweig ist einmal komplett gelaufen');

    // Der Ist-Wert passt nicht zur Prüfung: die Schleife läuft erneut.
    await engine.checkLoops(Date.now() + 60000);
    await wait(120);
    assert.deepEqual(writes[writes.length - 1], { topic: 'custom://Soll', value: 20 });
    assert.ok(writes.length > afterRun, 'die Schleife wurde nachgefasst');
    assert.match((await repository.listConditions(db))[0].lastResult, /Schleife nach Prüfung wiederholt/);

    // Stimmt der Ist-Wert, bleibt es dabei.
    const before = writes.length;
    adapterRouter.ingestTopic('custom://Ist', 20);
    await engine.checkLoops(Date.now() + 120000);
    await wait(80);
    assert.equal(writes.length, before, 'erfüllte Prüfung löst nichts aus');
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Die Reihenfolge der Aktionen lässt sich verschieben – auch in eine Schleife hinein', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, validInput('Sortieren'));
  const first = (await repository.getCondition(db, condition.id)).thens[0];
  const loop = await repository.addItem(db, condition.id, { kind: 'then', type: 'loop', repeats: '2' });

  await repository.updateItemLayout(db, condition.id, {
    items: [
      { id: loop.id, kind: 'then', parentId: null, position: 0 },
      { id: first.id, kind: 'then', parentId: loop.id, position: 0 },
    ],
  });
  const tree = (await repository.getCondition(db, condition.id)).thenTree;
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, loop.id);
  assert.equal(tree[0].children[0].id, first.id);

  // Eine Schleife kann nicht in sich selbst wandern, und der Zweig darf nicht leer werden.
  await assert.rejects(() => repository.updateItemLayout(db, condition.id, {
    items: [
      { id: loop.id, kind: 'then', parentId: loop.id, position: 0 },
      { id: first.id, kind: 'then', parentId: loop.id, position: 0 },
    ],
  }), /Kreis/);
  await assert.rejects(() => repository.updateItemLayout(db, condition.id, {
    items: [{ id: loop.id, kind: 'then', parentId: null, position: 0 }],
  }), /unvollständig/);
  await close(db);
});

test('Eine Schleife lässt sich ohne Bedingung anlegen – ihre Prüfung ist dann Pflicht und Auslöser', async () => {
  const db = await freshDb();
  const loopCondition = await repository.createCondition(db, {
    name: 'Rollladen nachfassen', enabled: '1', mode: 'loop', repeats: '1',
    checkTopic: 'custom://RollladenIst', checkOperator: 'eq', checkValue: '100', checkIntervalSeconds: '60',
  });
  // Weder Trigger noch Wenn noch Sonst – nur die Schleife als Dann-Aktion.
  assert.deepEqual(
    [loopCondition.triggers.length, loopCondition.whens.length, loopCondition.elses.length, loopCondition.thens.length],
    [0, 0, 0, 1],
  );
  assert.equal(loopCondition.whenEnabled, false);
  const loop = loopCondition.thens[0];
  assert.equal(loop.type, 'loop');
  assert.equal(loop.config.checkEnabled, true);
  assert.equal(loop.config.check.topic, 'custom://RollladenIst');

  // Ohne Prüfangaben kommt keine Schleifen-Automation zustande.
  await assert.rejects(() => repository.createCondition(db, {
    name: 'Unvollständig', mode: 'loop', repeats: '1', checkIntervalSeconds: '60',
  }), /Prüf-State|State fehlt/);

  // Die Prüfung dieser Schleife trägt die Auslösung und darf nicht weg.
  await assert.rejects(() => repository.updateItem(db, loopCondition.id, loop.id, {
    repeats: '2', checkEnabled: '0',
  }), /kann nicht abgeschaltet werden/);
  await assert.rejects(() => repository.deleteItem(db, loopCondition.id, loop.id), /Dann/);

  // Mit einem zusätzlichen Trigger wird sie zur gewöhnlichen Bedingung – dann
  // darf die Prüfung auch abgeschaltet werden.
  await repository.addItem(db, loopCondition.id, {
    kind: 'trigger', type: 'change', topic: 'custom://Start',
  });
  await repository.updateItem(db, loopCondition.id, loop.id, { repeats: '2', checkEnabled: '0' });
  const updated = await repository.getCondition(db, loopCondition.id);
  assert.equal(updated.thens[0].config.checkEnabled, false);
  await close(db);
});

test('Die Schleifen-Automation läuft ohne Trigger allein über ihre Prüfung', async () => {
  const db = await freshDb();
  const condition = await repository.createCondition(db, {
    name: 'Nachführen', enabled: '1', mode: 'loop', repeats: '1',
    checkTopic: 'custom://Ist', checkOperator: 'eq', checkValue: '20', checkIntervalSeconds: '5',
  });
  const loop = condition.thens[0];
  await repository.addItem(db, condition.id, {
    kind: 'then', type: 'write', parentId: loop.id, topic: 'custom://Soll', value: '20',
  });

  const writes = [];
  const originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };
  try {
    await engine.init(db);
    adapterRouter.ingestTopic('custom://Ist', 0);
    // Kein Trigger, kein vorheriger Lauf: die Prüfung allein löst aus.
    await engine.checkLoops(Date.now() + 60000);
    await wait(120);
    assert.deepEqual(writes, [{ topic: 'custom://Soll', value: 20 }]);

    // Stimmt der Ist-Wert, bleibt die Schleife stehen.
    adapterRouter.ingestTopic('custom://Ist', 20);
    await engine.checkLoops(Date.now() + 120000);
    await wait(80);
    assert.equal(writes.length, 1);
  } finally {
    engine.stop(); mqttClient.publish = originalPublish; await close(db);
  }
});

test('Trigger und Wenn sind nicht verschiebbar; Aktionen, Bedingungen und Verzeichnisse dagegen schon', async () => {
  const db = await freshDb();
  const folder = await repository.addFolder(db, { name: 'Heizung' });
  await repository.createCondition(db, { ...validInput('Warm'), folderId: folder.id });
  const html = renderConditions(await repository.conditionTree(db));
  assert.doesNotMatch(html, /condition-item-drag/);
  assert.equal(/class="condition-item"/.test(html), true);
  // Die Aktionen des Dann-/Sonst-Zweigs laufen der Reihe nach ab und tragen
  // deshalb eine eigene Dragfläche.
  assert.match(html, /class="condition-item cnd-node cnd-action"/);
  assert.match(html, /class="widget-drag cnd-drag"/);
  assert.match(html, /fetch\('\/conditions\/' \+ conditionId \+ '\/items\/layout'/);
  assert.match(html, /class="ms-group condition-folder"/);
  assert.match(html, /class="widget-drag ms-group-drag condition-folder-drag"/);
  assert.match(html, /class="condition-dropzone" data-folder-id="1"/);
  assert.match(html, /id="conditionFolderForm"/);
  assert.match(html, /'\/conditions\/folder\/' \+ id : '\/conditions\/folder'/);
  // Das Verzeichnis-/Bedingungslayout überträgt weiterhin nur Verzeichnisse und
  // Bedingungen; die Aktionsreihenfolge geht als eigener Baum an die Bedingung.
  assert.match(html, /folders: folders, conditions: conditions/);
  assert.match(html, /return \{ items: items \};/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) assert.doesNotThrow(() => new Function(script[1]));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.condition-folder-head\.condition-drag-over/);
  await close(db);
});

test('Die Layoutroute liegt vor der Bedingungsroute und antwortet mit JSON', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'conditions.js'), 'utf8');
  assert.ok(source.indexOf("'/conditions/layout'") < source.indexOf("'/conditions/:id'"));
  assert.ok(source.indexOf("'/conditions/folder'") < source.indexOf("'/conditions/:id'"));
  assert.ok(source.indexOf("'/conditions/folder/:id'") < source.indexOf("'/conditions/:id'"));
});

test('Bedingungsseite und Navigation folgen der systemweiten Sprachwahl', async () => {
  const db = await freshDb();
  await repository.createCondition(db, validInput());
  await i18n.select('en');
  try {
    const html = renderConditions(await repository.conditionTree(db));
    assert.match(html, /<h1>Conditions<\/h1>/);
    assert.match(html, />Add folder<\/button>/);
    assert.match(html, />Add condition<\/button>/);
    assert.match(html, /Timed repetition/);
  } finally {
    await i18n.select('de'); await close(db);
  }
});
