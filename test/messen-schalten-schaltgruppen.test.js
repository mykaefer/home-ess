'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const mqttClient = require('../src/mqtt/client');
const levelHandler = require('../src/operating-level/handler');
const adapterRouter = require('../src/adapters/router');
const automation = require('../src/messen-schalten/automation');
const sgAutomation = require('../src/messen-schalten/schaltgruppen-automation');
const { cacheKey } = require('../src/messen-schalten/actors');
const {
  SCHEME, INSTANCE,
  listSwitchGroups, createSwitchGroup, updateSwitchGroup, deleteSwitchGroup,
  assignActorToSwitchGroup, remoteCacheKey, stateTopic,
  buildSchaltgruppenStateDefinitions, buildSchaltgruppenStatesBlock,
} = require('../src/messen-schalten/schaltgruppen');

// Virtuelle Instanz registrieren, damit ingestFromInstance das kanonische
// schaltgruppe://gruppen/<id>-Topic bildet (im Betrieb erledigt das init()).
adapterRouter.registerVirtualInstance(INSTANCE, SCHEME, {});

test.beforeEach(() => {
  automation.resetForTests();
  sgAutomation.resetForTests();
  mqttClient.getCache().clear();
  levelHandler.applyLevel(5);
});

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mess_schalt_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', group_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0, switch_topic TEXT NOT NULL DEFAULT '',
    remote_topic TEXT NOT NULL DEFAULT '',
    status_topic TEXT NOT NULL DEFAULT '', power_topic TEXT NOT NULL DEFAULT '',
    power_unit TEXT NOT NULL DEFAULT 'W', counter_topic TEXT NOT NULL DEFAULT '',
    counter_unit TEXT NOT NULL DEFAULT 'kWh', priority INTEGER NOT NULL DEFAULT 4,
    use_group_priority INTEGER NOT NULL DEFAULT 0, desired_on INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '',
    load_shed_enabled INTEGER NOT NULL DEFAULT 0,
    load_shed_phase TEXT NOT NULL DEFAULT 'l1',
    switch_group_id INTEGER)`);
  await dbRun(db, "CREATE TABLE mess_schalt_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, priority INTEGER NOT NULL DEFAULT 4, position INTEGER NOT NULL DEFAULT 0, function_key TEXT NOT NULL DEFAULT '', offset_total_consumption INTEGER NOT NULL DEFAULT 1)");
  await dbRun(db, `CREATE TABLE mess_schalt_switch_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    remote_topic TEXT NOT NULL DEFAULT '',
    switch_as_unit INTEGER NOT NULL DEFAULT 0,
    timer_minutes REAL NOT NULL DEFAULT 0)`);
  await dbRun(db, 'CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)');
  return db;
}

function closeDb(db) {
  return new Promise((resolve) => db.close(resolve));
}

// Ist-Zustand eines Geräts (Schalt-Topic-Readback) im gemeinsamen Cache setzen.
function setActual(id, on, receivedAt = Date.now()) {
  mqttClient.getCache().set(cacheKey(id, 'switch'), { value: on ? '1' : '0', receivedAt });
}
function setRemote(groupId, on, receivedAt = Date.now()) {
  mqttClient.getCache().set(remoteCacheKey(groupId), { value: on ? '1' : '0', receivedAt });
}
function setRemoteBoolean(groupId, on, receivedAt = Date.now()) {
  mqttClient.getCache().set(remoteCacheKey(groupId), { value: !!on, receivedAt });
}

function withPublishCapture(fn) {
  const orig = mqttClient.publish;
  const published = [];
  mqttClient.publish = (topic, value) => {
    published.push([topic, String(value)]);
    return true;
  };
  return Promise.resolve(fn(published)).finally(() => { mqttClient.publish = orig; });
}

// --- CRUD -------------------------------------------------------------------

test('CRUD: anlegen, ändern, löschen – Löschen löst die Gerätezuordnung', async () => {
  const db = await freshDb();
  const created = await createSwitchGroup(db, { name: 'Wohnzimmer', remoteTopic: ' licht.remote ', switchAsUnit: 'on', timerMinutes: '15' });
  assert.equal(created.name, 'Wohnzimmer');
  assert.equal(created.remoteTopic, 'licht.remote');
  assert.equal(created.switchAsUnit, true);
  assert.equal(created.timerMinutes, 15);

  const updated = await updateSwitchGroup(db, created.id, { name: 'Wohnzimmer Licht', remoteTopic: '', switchAsUnit: '', timerMinutes: '' });
  assert.equal(updated.name, 'Wohnzimmer Licht');
  assert.equal(updated.remoteTopic, '');
  assert.equal(updated.switchAsUnit, false);
  assert.equal(updated.timerMinutes, 0);

  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (1, 'Lampe', 'lampe.0.state', ?)", [created.id]);
  await deleteSwitchGroup(db, created.id);
  assert.equal((await listSwitchGroups(db)).length, 0);
  const row = await dbGet(db, 'SELECT switch_group_id FROM mess_schalt_actors WHERE id = 1');
  assert.equal(row.switch_group_id, null);
  await closeDb(db);
});

test('CRUD: leerer Name wird als Validierungsfehler abgewiesen', async () => {
  const db = await freshDb();
  await assert.rejects(() => createSwitchGroup(db, { name: '  ' }), (err) => err.validation === true);
  await closeDb(db);
});

test('assignActorToSwitchGroup ordnet zu und löst wieder', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Keller' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic) VALUES (2, 'Pumpe', 'pumpe.0.state')");
  await assignActorToSwitchGroup(db, 2, group.id);
  assert.equal((await dbGet(db, 'SELECT switch_group_id FROM mess_schalt_actors WHERE id = 2')).switch_group_id, group.id);
  await assignActorToSwitchGroup(db, 2, null);
  assert.equal((await dbGet(db, 'SELECT switch_group_id FROM mess_schalt_actors WHERE id = 2')).switch_group_id, null);
  await closeDb(db);
});

// --- Zustandsableitung --------------------------------------------------------

test('Gruppe gilt als AN, sobald ein Gerät an ist – als AUS erst, wenn alle aus sind', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Test' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (10, 'A', 'a.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (11, 'B', 'b.state', ?)", [group.id]);

  await withPublishCapture(async () => {
    setActual(10, true);
    setActual(11, false);
    await sgAutomation.tick(db);
    assert.equal(mqttClient.getCache().get(stateTopic(group.id)).value, 1);

    setActual(10, false);
    await sgAutomation.tick(db);
    assert.equal(mqttClient.getCache().get(stateTopic(group.id)).value, 0);
  });
  await closeDb(db);
});

test('„Gruppe schaltet als Einheit": Schaltflanke eines Geräts zieht die übrigen mit', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Einheit', switchAsUnit: 'on' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (20, 'A', 'ea.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (21, 'B', 'eb.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    // Erstbeobachtung (beide aus) ist keine Flanke.
    setActual(20, false);
    setActual(21, false);
    await sgAutomation.tick(db);
    assert.equal(published.length, 0);

    // A schaltet ein ⇒ B wird mit eingeschaltet.
    setActual(20, true);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'eb.state' && p[1] === '1'));
    assert.ok(!published.some((p) => p[0] === 'ea.state'));

    // Bestätigung von B übernehmen, danach schaltet A aus ⇒ B ebenfalls aus.
    setActual(21, true);
    await sgAutomation.tick(db);
    published.length = 0;
    setActual(20, false);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'eb.state' && p[1] === '0'));
  });
  await closeDb(db);
});

test('Ohne „als Einheit" bleibt das Einschalten eines Geräts folgenlos für die übrigen', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Lose' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (30, 'A', 'la.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (31, 'B', 'lb.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(30, false);
    setActual(31, false);
    await sgAutomation.tick(db);
    setActual(30, true);
    await sgAutomation.tick(db);
    assert.ok(!published.some((p) => p[0] === 'lb.state'));
    // Gruppe gilt trotzdem als an.
    assert.equal(mqttClient.getCache().get(stateTopic(group.id)).value, 1);
  });
  await closeDb(db);
});

test('Optionaler Timer schaltet nach Ablauf die gesamte Gruppe aus', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Timer', timerMinutes: 0.001 });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (32, 'A', 'timer-a.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (33, 'B', 'timer-b.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(32, false);
    setActual(33, false);
    await sgAutomation.tick(db);
    setActual(32, true);
    setActual(33, true);
    await sgAutomation.tick(db);
    published.length = 0;

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(published.some((p) => p[0] === 'timer-a.state' && p[1] === '0'));
    assert.ok(published.some((p) => p[0] === 'timer-b.state' && p[1] === '0'));
  });
  await closeDb(db);
});

test('Vorzeitiges Ausschalten löscht den Gruppentimer', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Timer aus', timerMinutes: 0.001 });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (34, 'A', 'timer-c.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(34, false);
    await sgAutomation.tick(db);
    setActual(34, true);
    await sgAutomation.tick(db);
    setActual(34, false);
    await sgAutomation.tick(db);
    published.length = 0;

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(published.length, 0);
  });
  await closeDb(db);
});

// --- Gruppe schalten ----------------------------------------------------------

test('commandGroup schaltet alle Geräte ein bzw. aus', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Cmd' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (40, 'A', 'ca.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (41, 'B', 'cb.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic) VALUES (42, 'Fremd', 'cx.state')");

  await withPublishCapture(async (published) => {
    assert.equal(await sgAutomation.commandGroup(db, group.id, true), true);
    assert.ok(published.some((p) => p[0] === 'ca.state' && p[1] === '1'));
    assert.ok(published.some((p) => p[0] === 'cb.state' && p[1] === '1'));
    assert.ok(!published.some((p) => p[0] === 'cx.state'));
    published.length = 0;

    setActual(40, true);
    setActual(41, true);
    assert.equal(await sgAutomation.commandGroup(db, group.id, false), true);
    assert.ok(published.some((p) => p[0] === 'ca.state' && p[1] === '0'));
    assert.ok(published.some((p) => p[0] === 'cb.state' && p[1] === '0'));
  });
  assert.equal(await sgAutomation.commandGroup(db, 999, true), false);
  await closeDb(db);
});

test('Einschalten über die Gruppe bleibt je Gerät durch die Priorität gegatet', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Gate' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, switch_group_id) VALUES (50, 'Hoch', 'ga.state', 1, ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, priority, switch_group_id) VALUES (51, 'Nieder', 'gb.state', 5, ?)", [group.id]);

  await withPublishCapture(async (published) => {
    // Geräte am Betriebslevel registrieren, damit isAllowed korrekt gatet.
    levelHandler.applyLevel(3);
    await automation.tick(db);
    published.length = 0;
    await sgAutomation.commandGroup(db, group.id, true);
    assert.ok(published.some((p) => p[0] === 'ga.state' && p[1] === '1'));
    // Priorität 5 ist bei Level 3 nicht freigegeben ⇒ Einschalten abgewiesen.
    assert.ok(!published.some((p) => p[0] === 'gb.state' && p[1] === '1'));
  });
  await closeDb(db);
});

// --- Remote-Topic --------------------------------------------------------------

test('Remote-Änderung schaltet die Gruppe sofort; erster/refreshter Wert ist nur Baseline', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Remote', remoteTopic: 'gruppe.remote' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (60, 'A', 'ra.state', ?)", [group.id]);
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (61, 'B', 'rb.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    // Retained-/Refresh-Wert beim Start ist keine Änderung und darf die reale
    // Gruppe nicht schalten.
    setActual(60, false);
    setActual(61, false);
    setRemote(group.id, false, Date.now() - 1000);
    await sgAutomation.tick(db);
    assert.ok(!published.some((p) => p[0] === 'ra.state' || p[0] === 'rb.state'));
    published.length = 0;

    // Erst eine echte externe Wertänderung auf AN schaltet alle Geräte.
    setRemote(group.id, true);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'ra.state' && p[1] === '1'));
    assert.ok(published.some((p) => p[0] === 'rb.state' && p[1] === '1'));
  });
  await closeDb(db);
});

test('Laufende Gruppe überschreibt einen alten retained Remote-Wert statt auszuschalten', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Retained', remoteTopic: 'retained.remote' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (62, 'A', 'retained.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(62, true);
    setRemote(group.id, false, Date.now() - 1000);
    await sgAutomation.tick(db);

    assert.ok(!published.some((p) => p[0] === 'retained.state' && p[1] === '0'));
    assert.ok(published.some((p) => p[0] === 'retained.remote' && p[1] === '1'));
  });
  await closeDb(db);
});

test('Boolean-Remote-State wird typgetreu mit true/false synchronisiert', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Boolean', remoteTopic: 'boolean.remote' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (63, 'A', 'boolean.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(63, true);
    setRemoteBoolean(group.id, false);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'boolean.remote' && p[1] === 'true'));

    // Erst das bestätigte Broker-Echo markiert beide Seiten als synchron.
    published.length = 0;
    setRemoteBoolean(group.id, true);
    await sgAutomation.tick(db);
    assert.ok(!published.some((p) => p[0] === 'boolean.state'));
  });
  await closeDb(db);
});

test('Kanonisches HM-RPC-Mitglieder-Event startet die Gruppenautomation', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'HM Event' });
  const topic = 'hm-rpc://OpenCCU/ABC%3A3/STATE';
  await dbRun(db, 'INSERT INTO mess_schalt_actors (id, name, switch_topic, status_topic, switch_group_id) VALUES (?, ?, ?, ?, ?)',
    [64, 'HM', 'hm-rpc://OpenCCU/ABC%3A4/STATE', topic, group.id]);
  await sgAutomation.tick(db);
  assert.equal(sgAutomation.isRelevantEvent({ changedKeys: [topic] }), true);
  await closeDb(db);
});

test('Neuerer lokaler Zustand wird an das Remote-Topic gespiegelt', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Spiegel', remoteTopic: 'spiegel.remote' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (70, 'A', 'sa.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    const t0 = Date.now() - 5000;
    setActual(70, false, t0);
    setRemote(group.id, false, t0);
    await sgAutomation.tick(db);
    published.length = 0;

    // Gerät wird lokal eingeschaltet (neuer als der Remote-Wert).
    setActual(70, true);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'spiegel.remote' && p[1] === '1'));
  });
  await closeDb(db);
});

test('Lokale Einschaltflanke wird trotz jüngerem unverändertem Remote-Wert gespiegelt', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Direkt', remoteTopic: 'direkt.remote' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (71, 'A', 'da.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(71, false, 1000);
    setRemote(group.id, false, 2000);
    await sgAutomation.tick(db);
    published.length = 0;

    // Das Remote-Topic wurde später empfangen, hat sich aber nicht geändert.
    // Eine anschließend direkt am Gerät beobachtete AN-Flanke muss gewinnen.
    setActual(71, true, 1500);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'direkt.remote' && p[1] === '1'));
  });
  await closeDb(db);
});

test('Lokale Ausschaltflanke wird trotz jüngerem unverändertem Remote-Wert gespiegelt', async () => {
  const db = await freshDb();
  const group = await createSwitchGroup(db, { name: 'Direkt aus', remoteTopic: 'direkt-aus.remote' });
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, switch_group_id) VALUES (72, 'A', 'aus.state', ?)", [group.id]);

  await withPublishCapture(async (published) => {
    setActual(72, true, 1000);
    setRemote(group.id, true, 2000);
    await sgAutomation.tick(db);
    published.length = 0;

    setActual(72, false, 1500);
    await sgAutomation.tick(db);
    assert.ok(published.some((p) => p[0] === 'direkt-aus.remote' && p[1] === '0'));
  });
  await closeDb(db);
});

// --- States-Integration ---------------------------------------------------------

test('State-Definitionen und States-Block der Schaltgruppen', async () => {
  const db = await freshDb();
  const withRemote = await createSwitchGroup(db, { name: 'Zeta', remoteTopic: 'zeta.remote' });
  const withoutRemote = await createSwitchGroup(db, { name: 'Alpha' });

  const defs = buildSchaltgruppenStateDefinitions(await listSwitchGroups(db));
  assert.deepEqual(defs, [{ id: remoteCacheKey(withRemote.id), topic: 'zeta.remote' }]);

  mqttClient.getCache().set(stateTopic(withoutRemote.id), { value: 1, receivedAt: Date.now() });
  const block = await buildSchaltgruppenStatesBlock(db, mqttClient.getCache());
  assert.equal(block.virtual, true);
  assert.equal(block.adapterName, 'Schaltgruppen');
  assert.equal(block.categories.length, 1);
  const states = block.categories[0].states;
  // Alphanumerisch sortiert: Alpha vor Zeta.
  assert.deepEqual(states.map((s) => s.name), ['Alpha', 'Zeta']);
  assert.equal(states[0].topic, stateTopic(withoutRemote.id));
  assert.equal(states[0].writable, true);
  assert.equal(states[0].display, 'Ein');
  assert.equal(states[1].display, '—');
  await closeDb(db);
});

test('Ohne Schaltgruppen liefert der States-Block null', async () => {
  const db = await freshDb();
  assert.equal(await buildSchaltgruppenStatesBlock(db, mqttClient.getCache()), null);
  await closeDb(db);
});

test('Write auf das virtuelle Scheme-Topic erreicht den registrierten Handler', () => {
  const calls = [];
  adapterRouter.registerVirtualInstance('sg-test', 'sgtest', { write: (address, value) => calls.push([address, value]) });
  try {
    assert.equal(mqttClient.publish('sgtest://sg-test/7', '1'), true);
    assert.deepEqual(calls, [['7', '1']]);
  } finally {
    adapterRouter.unregisterVirtualInstance('sg-test');
  }
});
