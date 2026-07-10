'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  createActor, updateActor, getActor, listActors, deleteActor,
  validateInput, normalizeInput, effectivePriority, buildMessSchaltStateDefinitions, cacheKey,
} = require('../src/messen-schalten/actors');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mess_schalt_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', group_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0, switch_topic TEXT NOT NULL DEFAULT '',
    remote_topic TEXT NOT NULL DEFAULT '',
    status_topic TEXT NOT NULL DEFAULT '', power_topic TEXT NOT NULL DEFAULT '',
    power_unit TEXT NOT NULL DEFAULT 'W', counter_topic TEXT NOT NULL DEFAULT '',
    counter_unit TEXT NOT NULL DEFAULT 'kWh', rated_power REAL, rated_power_unit TEXT NOT NULL DEFAULT 'W', priority INTEGER NOT NULL DEFAULT 4,
    use_group_priority INTEGER NOT NULL DEFAULT 0, desired_on INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '',
    load_shed_enabled INTEGER NOT NULL DEFAULT 0,
    load_shed_phase TEXT NOT NULL DEFAULT 'l1',
    switch_group_id INTEGER)`);
  await dbRun(db, 'CREATE TABLE mess_schalt_actor_state (actor_id INTEGER PRIMARY KEY, last_counter_raw REAL, last_progress_ts INTEGER, derived_power_w REAL, counter_total_kwh REAL, day_key TEXT, day_start_kwh REAL, year_key TEXT, year_start_kwh REAL, prev_year_kwh REAL)');
  return db;
}

test('validateInput verlangt mindestens Schalten, Leistung oder Zähler', () => {
  const errNone = validateInput(normalizeInput({ name: 'Ofen' }));
  assert.ok(errNone.some((m) => /Schalten, Leistung oder Zähler/.test(m)));
  const okSwitch = validateInput(normalizeInput({ name: 'Ofen', switchTopic: 'a.0.state' }));
  assert.equal(okSwitch.length, 0);
  const okCounter = validateInput(normalizeInput({ name: 'Ofen', counterTopic: 'a.0.energy' }));
  assert.equal(okCounter.length, 0);
});

test('validateInput verlangt Gruppe bei „Priorität der Gruppe verwenden"', () => {
  const errors = validateInput(normalizeInput({ name: 'Ofen', powerTopic: 'a.0.p', useGroupPriority: 'on' }));
  assert.ok(errors.some((m) => /Gruppe/.test(m)));
});

test('createActor speichert und listActors liefert normalisierte Werte', async () => {
  const db = await freshDb();
  const created = await createActor(db, {
    name: 'Wärmepumpe', switchTopic: 'hp.0.state', powerTopic: 'hp.0.power', powerUnit: 'kW',
    priority: 2,
  });
  assert.equal(created.name, 'Wärmepumpe');
  assert.equal(created.powerUnit, 'kW');
  assert.equal(created.priority, 2);
  assert.equal(created.alwaysOn, false);
  const list = await listActors(db);
  assert.equal(list.length, 1);
  await new Promise((resolve) => db.close(resolve));
});

test('Nennleistung wird gespeichert; nur positive Werte aktivieren die virtuelle Zählung', async () => {
  const db = await freshDb();
  const a = await createActor(db, { name: 'Heizung', switchTopic: 's.0', ratedPower: '2,5', ratedPowerUnit: 'kW' });
  const loaded = await getActor(db, a.id);
  assert.equal(loaded.ratedPower, 2.5); // Komma-Dezimal normalisiert
  assert.equal(loaded.ratedPowerUnit, 'kW');

  // 0 bzw. negativ ⇒ nicht gesetzt (null), Einheit fällt auf W zurück.
  await updateActor(db, a.id, { name: 'Heizung', switchTopic: 's.0', ratedPower: '0', ratedPowerUnit: 'x' });
  const cleared = await getActor(db, a.id);
  assert.equal(cleared.ratedPower, null);
  assert.equal(cleared.ratedPowerUnit, 'W');
  await new Promise((resolve) => db.close(resolve));
});

test('„Immer an" wird gespeichert und beim Bearbeiten übernommen', async () => {
  const db = await freshDb();
  const a = await createActor(db, { name: 'A', switchTopic: 's.0', alwaysOn: 'on' });
  assert.equal((await getActor(db, a.id)).alwaysOn, true);
  await updateActor(db, a.id, { name: 'A', switchTopic: 's.0' }); // Häkchen entfernt
  assert.equal((await getActor(db, a.id)).alwaysOn, false);
  await new Promise((resolve) => db.close(resolve));
});

test('Lastabwurf-Felder werden gespeichert und normalisiert', async () => {
  const db = await freshDb();
  const actor = await createActor(db, {
    name: 'Boiler',
    switchTopic: 'boiler.0.state',
    loadShedEnabled: 'on',
    loadShedPhase: 'three_phase',
  });
  assert.equal(actor.loadShedEnabled, true);
  assert.equal(actor.loadShedPhase, 'three_phase');
  await updateActor(db, actor.id, {
    name: 'Boiler',
    switchTopic: 'boiler.0.state',
    loadShedEnabled: '',
    loadShedPhase: 'foo',
  });
  const updated = await getActor(db, actor.id);
  assert.equal(updated.loadShedEnabled, false);
  assert.equal(updated.loadShedPhase, 'l1');
  await new Promise((resolve) => db.close(resolve));
});

test('Lastabwurf erfordert ein Schalten-Topic', () => {
  const errors = validateInput(normalizeInput({ name: 'Messgeraet', powerTopic: 'x.0.power', loadShedEnabled: 'on' }));
  assert.ok(errors.some((m) => /Lastabwurf/.test(m)));
});

test('deleteActor entfernt Gerät samt Ableitungszustand', async () => {
  const db = await freshDb();
  const a = await createActor(db, { name: 'A', counterTopic: 'c.0' });
  // createActor legt die State-Zeile bereits an (interner Zähler = 0).
  await dbRun(db, 'UPDATE mess_schalt_actor_state SET last_counter_raw = 1 WHERE actor_id = ?', [a.id]);
  await deleteActor(db, a.id);
  assert.equal((await listActors(db)).length, 0);
  const state = await new Promise((resolve, reject) =>
    db.get('SELECT * FROM mess_schalt_actor_state WHERE actor_id = ?', [a.id], (e, r) => (e ? reject(e) : resolve(r))));
  assert.equal(state, undefined);
  await new Promise((resolve) => db.close(resolve));
});

test('effectivePriority übernimmt die Gruppenpriorität nur bei aktivem Häkchen', () => {
  const groups = new Map([[7, { id: 7, priority: 2 }]]);
  assert.equal(effectivePriority({ priority: 5, groupId: 7, useGroupPriority: true }, groups), 2);
  assert.equal(effectivePriority({ priority: 5, groupId: 7, useGroupPriority: false }, groups), 5);
  // Gruppe fehlt ⇒ eigene Priorität.
  assert.equal(effectivePriority({ priority: 5, groupId: 99, useGroupPriority: true }, groups), 5);
});

test('buildMessSchaltStateDefinitions nimmt nur gesetzte Topics auf', () => {
  const defs = buildMessSchaltStateDefinitions([
    { id: 1, switchTopic: 's.0', statusTopic: '', powerTopic: 'p.0', counterTopic: '' },
    { id: 2, switchTopic: '', statusTopic: '', powerTopic: '', counterTopic: 'c.0' },
  ]);
  const ids = defs.map((d) => d.id);
  assert.deepEqual(ids, [cacheKey(1, 'switch'), cacheKey(1, 'power'), cacheKey(2, 'counter')]);
});
