'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-device-rooms-'));
process.env.HOME_ESS_DB = path.join(tmp, 'app.db');
const { openDatabase } = require('../src/db');
const actors = require('../src/messen-schalten/actors');
const groups = require('../src/messen-schalten/groups');
const rooms = require('../src/heizung/rooms');
const { buildStatesTree } = require('../src/states/repository');
const { invalidateInternalValues } = require('../src/states/system-values');
const { buildIndex, apiView, serializeState } = require('../src/states-api/catalog');
const render = require('../src/views/messen-schalten');

let db;
test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
test.after(async () => {
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function snapshot() {
  invalidateInternalValues();
  const cache = new Map();
  return apiView(buildIndex(await buildStatesTree(db, cache), cache), {});
}

test('Alle Geräte sind optional Räumen zugeordnet; Metadaten unterscheiden Licht und Boiler', async () => {
  const kitchen = await rooms.createRoom(db, { name: 'Küche', targetTemp: 21 });
  const office = await rooms.createRoom(db, { name: 'Büro', targetTemp: 21 });
  const group = await groups.createGroup(db, { title: 'Beleuchtung', functionKey: 'licht' });
  const lamp = await actors.createActor(db, { name: 'Gerät A', switchTopic: 'test/a', groupId: group.id, roomId: kitchen.id });
  const boiler = await actors.createActor(db, { name: 'Gerät B', switchTopic: 'test/b', groupId: group.id, roomId: kitchen.id, functionKey: 'warmwasser' });
  const meter = await actors.createActor(db, { name: 'Gerät C', powerTopic: 'test/c', roomId: kitchen.id });
  const unassigned = await actors.createActor(db, { name: 'Gerät D', counterTopic: 'test/d' });
  assert.equal(unassigned.roomId, null);
  const topic = (actor, suffix = 'schalten') => `system://homeess/geraet.${actor.id}.${suffix}`;
  let view = await snapshot();
  const lampState = serializeState(view.findState(topic(lamp)));
  assert.equal(lampState.folder, 'System / Räume / Küche');
  assert.equal(lampState.type, 'boolean');
  assert.equal(lampState.writable, true);
  assert.equal(lampState.metadata.functionKey, 'licht');
  assert.equal(lampState.metadata.functionLabel, 'Licht');
  assert.equal(lampState.metadata.roomId, kitchen.id);
  assert.equal(serializeState(view.findState(topic(boiler))).metadata.functionKey, 'warmwasser');
  const candidates = view.allStates().map(serializeState).filter((state) =>
    state.writable && state.type === 'boolean' && state.metadata?.roomId === kitchen.id && state.metadata.functionKey === 'licht');
  assert.deepEqual(candidates.map((state) => state.topic), [topic(lamp)]);
  assert.equal(serializeState(view.findState(topic(meter, 'leistung'))).metadata.functionKey, null);
  assert.equal(serializeState(view.findState(topic(meter, 'leistung'))).folder, lampState.folder);
  assert.equal(serializeState(view.findState(topic(unassigned, 'zaehler'))).folder, 'System / Geräte');

  await assert.rejects(actors.updateActor(db, lamp.id, { ...lamp, roomId: 999999 }), /vorhandenen Raum/);
  await assert.rejects(actors.createActor(db, { name: 'Ungültig', powerTopic: 'test/e', roomId: 'abc' }), /vorhandenen Raum/);
  assert.equal((await actors.getActor(db, lamp.id)).roomId, kitchen.id);
  await actors.updateActor(db, lamp.id, { ...lamp, roomId: office.id });
  view = await snapshot();
  assert.equal(serializeState(view.findState(topic(lamp))).folder, 'System / Räume / Büro');
  await rooms.updateRoom(db, office.id, { ...office, name: 'Arbeitszimmer' });
  view = await snapshot();
  assert.equal(serializeState(view.findState(topic(lamp))).metadata.roomName, 'Arbeitszimmer');
  await actors.updateActor(db, meter.id, { ...meter, roomId: '' });
  assert.equal((await actors.getActor(db, meter.id)).roomId, null);
  await rooms.deleteRoom(db, kitchen.id);
  assert.equal((await actors.getActor(db, boiler.id)).roomId, null);
  view = await snapshot();
  assert.equal(serializeState(view.findState(topic(boiler))).folder, 'System / Geräte');
});

test('Geräteansicht enthält Raumspalte und optionale Raumauswahl mit escaped Namen', () => {
  const html = render({ roomsForSelect: [{ id: 1, name: '<Büro>' }], ungrouped: [{ id: 1, name: 'Messgerät', roomName: '<Büro>' }] });
  assert.match(html, /class="ms-row-room"/);
  assert.match(html, /id="msRoom" name="roomId"/);
  assert.match(html, /<option value="">Kein Raum<\/option>/);
  assert.match(html, /&lt;Büro&gt;/);
  assert.doesNotMatch(html, /<Büro>/);
});

test('Raum direkt aus Messen und Schalten anlegen, auch ohne Heizungsmodul', async (t) => {
  const express = require('express');
  const { fullAccess } = require('../src/auth/access');
  const { authorize } = require('../src/auth/session');
  const modules = require('../src/modules');
  await modules.setEnabled(db, 'heizung', false);
  // Die Route startet im Betrieb die bestehenden Automationen; hier wird nur
  // die Raumverwaltung getestet, ohne zusätzliche Hintergrund-Timer.
  t.mock.method(require('../src/messen-schalten/automation'), 'init', () => {});
  t.mock.method(require('../src/messen-schalten/schaltgruppen-automation'), 'init', () => {});
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = req.headers['x-test-login'] ? { userId: 1 } : null;
    req.access = req.session ? fullAccess() : null;
    next();
  });
  app.use(authorize());
  app.use(require('../src/routes/messen-schalten')(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/messen-schalten/rooms`;
  const post = (name, loggedIn = true) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(loggedIn ? { 'x-test-login': 'yes' } : {}) },
    body: JSON.stringify({ name }), signal: AbortSignal.timeout(5000),
  });
  assert.equal((await post('Ohne Login', false)).status, 403);
  assert.equal((await post('')).status, 400);
  assert.equal((await post('Ungültig/Raum')).status, 400);
  const response = await post('Speisekammer');
  assert.equal(response.status, 201);
  const { room } = await response.json();
  assert.equal(room.name, 'Speisekammer');
  const saved = await rooms.getRoom(db, room.id);
  assert.equal(saved.targetTemp, null);
  assert.deepEqual(rooms.roomEntries(saved), []);
  assert.equal((await post('speisekammer')).status, 400);
  const device = await actors.createActor(db, { name: 'Messung', powerTopic: 'test/pantry', roomId: room.id });
  const view = await snapshot();
  const state = serializeState(view.findState(`system://homeess/geraet.${device.id}.leistung`));
  assert.equal(state.metadata.roomName, 'Speisekammer');
  assert.equal(state.folder, 'System / Räume / Speisekammer');
});
