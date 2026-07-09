'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  createGroup, updateGroup, deleteGroup, setGroupParent, setGroupColor, listGroups,
} = require('../src/messen-schalten/groups');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mess_schalt_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 4, position INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '',
    offset_total_consumption INTEGER NOT NULL DEFAULT 1,
    parent_id INTEGER,
    meter_group INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '')`);
  await dbRun(db, `CREATE TABLE mess_schalt_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER)`);
  return db;
}

test('Gruppen-Verrechnung wird gespeichert und kann deaktiviert werden', async () => {
  const db = await freshDb();
  const created = await createGroup(db, { title: 'Küche' });
  assert.equal(created.offsetTotalConsumption, true);

  const updated = await updateGroup(db, created.id, {
    title: 'Küche',
    offsetTotalConsumption: false,
  });
  assert.equal(updated.offsetTotalConsumption, false);
  await new Promise((resolve) => db.close(resolve));
});

test('Zählergruppe wird gespeichert und kann umgeschaltet werden', async () => {
  const db = await freshDb();
  const created = await createGroup(db, { title: 'Haus', meterGroup: 'on' });
  assert.equal(created.meterGroup, true);

  const updated = await updateGroup(db, created.id, { title: 'Haus' });
  assert.equal(updated.meterGroup, false); // Checkbox fehlt = aus
  await new Promise((resolve) => db.close(resolve));
});

test('setGroupColor speichert nur gültige Hex-Farben (sonst Standard)', async () => {
  const db = await freshDb();
  const g = await createGroup(db, { title: 'Haus' });
  assert.equal(g.color, ''); // Default

  await setGroupColor(db, g.id, '#0EA5E9');
  assert.equal((await listGroups(db)).find((x) => x.id === g.id).color, '#0ea5e9'); // normalisiert

  await setGroupColor(db, g.id, 'blau'); // ungültig -> Standard
  assert.equal((await listGroups(db)).find((x) => x.id === g.id).color, '');
  await new Promise((resolve) => db.close(resolve));
});

test('setGroupParent verschachtelt Gruppen und löst sie wieder', async () => {
  const db = await freshDb();
  const haus = await createGroup(db, { title: 'Haus' });
  const kueche = await createGroup(db, { title: 'Küche' });

  await setGroupParent(db, kueche.id, haus.id);
  let groups = await listGroups(db);
  assert.equal(groups.find((g) => g.id === kueche.id).parentId, haus.id);

  // Zurück auf die oberste Ebene lösen.
  await setGroupParent(db, kueche.id, null);
  groups = await listGroups(db);
  assert.equal(groups.find((g) => g.id === kueche.id).parentId, null);
  await new Promise((resolve) => db.close(resolve));
});

test('setGroupParent weist Zyklen ab (Gruppe in eigene Untergruppe)', async () => {
  const db = await freshDb();
  const a = await createGroup(db, { title: 'A' });
  const b = await createGroup(db, { title: 'B' });
  await setGroupParent(db, b.id, a.id); // B unter A

  await assert.rejects(
    () => setGroupParent(db, a.id, b.id), // A unter B → Zyklus
    (err) => err.validation === true
  );
  // A darf auch nicht direkt sich selbst als Parent bekommen.
  await setGroupParent(db, a.id, a.id);
  const groups = await listGroups(db);
  assert.equal(groups.find((g) => g.id === a.id).parentId, null);
  await new Promise((resolve) => db.close(resolve));
});

test('deleteGroup zieht Untergruppen eine Ebene hoch', async () => {
  const db = await freshDb();
  const haus = await createGroup(db, { title: 'Haus' });
  const eg = await createGroup(db, { title: 'Erdgeschoss' });
  const kueche = await createGroup(db, { title: 'Küche' });
  await setGroupParent(db, eg.id, haus.id);
  await setGroupParent(db, kueche.id, eg.id);

  // Mittlere Ebene löschen: Küche rückt an Haus (den Parent der gelöschten Gruppe).
  await deleteGroup(db, eg.id);
  const groups = await listGroups(db);
  assert.equal(groups.find((g) => g.id === kueche.id).parentId, haus.id);
  assert.equal(groups.some((g) => g.id === eg.id), false);
  await new Promise((resolve) => db.close(resolve));
});
