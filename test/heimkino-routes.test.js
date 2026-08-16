'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-heimkino-routes-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const modules = require('../src/modules');
const heimkinoRoutes = require('../src/routes/heimkino');
const runtime = require('../src/heimkino/runtime');
const rooms = require('../src/heimkino/rooms');
const actionsRepo = require('../src/heimkino/actions');
const mqttClient = require('../src/mqtt/client');

let db;
let server;
let baseUrl;
let originalPublish;
const writes = [];

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function form(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  };
}

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(heimkinoRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  runtime.stop();
  mqttClient.publish = originalPublish;
  if (server) server.close();
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Ohne aktives Modul führt /heimkino zurück zur Modulverwaltung', async () => {
  const response = await fetch(`${baseUrl}/heimkino`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/module');
});

test('Räume, Aktionen, Layout und Kinomodus laufen über die Seiten', async () => {
  await modules.setEnabled(db, 'heimkino', true);
  await runtime.init(db);

  const created = await fetch(`${baseUrl}/heimkino/rooms`, form({ name: 'Wohnzimmer' }));
  assert.equal(created.status, 302);
  const [room] = await rooms.listRooms(db);
  assert.equal(room.name, 'Wohnzimmer');

  const overview = await fetch(`${baseUrl}/heimkino`).then((res) => res.text());
  assert.match(overview, new RegExp(`href="/heimkino/raum/${room.id}"`));

  // Doppelter Name: die Übersicht öffnet den Dialog erneut mit der Meldung.
  const duplicate = await fetch(`${baseUrl}/heimkino/rooms`, form({ name: 'wohnzimmer' }));
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /gibt es bereits/);

  const beamer = await fetch(`${baseUrl}/heimkino/raum/${room.id}/actions`, form({
    phase: 'on', type: 'write', topic: 'custom://Beamer', operation: 'set', value: '1',
  }));
  assert.equal(beamer.status, 302);
  const loop = await fetch(`${baseUrl}/heimkino/raum/${room.id}/actions`, form({
    phase: 'off', type: 'loop', repeats: '2', checkEnabled: '1',
    checkTopic: 'custom://Steckdose', checkOperator: 'lt', checkValue: '10', checkIntervalSeconds: '120',
  }));
  assert.equal(loop.status, 302);

  const actions = await actionsRepo.listActions(db, room.id);
  const loopAction = actions.find((action) => action.type === 'loop');
  const writeAction = actions.find((action) => action.type === 'write');

  const page = await fetch(`${baseUrl}/heimkino/raum/${room.id}`).then((res) => res.text());
  assert.match(page, /Aktionsfolge An/);
  assert.match(page, /Aktionsfolge Aus/);
  assert.match(page, /custom:\/\/Beamer auf 1 setzen/);
  assert.match(page, /Prüfung alle 120 s/);

  // Ungültige Pause: Seite kommt mit Fehler zurück, nichts wird gespeichert.
  const invalid = await fetch(`${baseUrl}/heimkino/raum/${room.id}/actions`, form({
    phase: 'on', type: 'pause', seconds: '0',
  }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Pause muss zwischen/);

  // Drag&Drop: die Wert-Aktion wandert in die Schleife der Aus-Folge.
  const layout = await fetch(`${baseUrl}/heimkino/raum/${room.id}/layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [
        { id: loopAction.id, phase: 'off', parentId: null, position: 0 },
        { id: writeAction.id, phase: 'off', parentId: loopAction.id, position: 0 },
      ],
    }),
  });
  assert.equal(layout.status, 200);
  const tree = await actionsRepo.actionTree(db, room.id);
  assert.deepEqual(tree.on, []);
  assert.deepEqual(tree.off[0].children.map((action) => action.id), [writeAction.id]);

  // Kinomodus einschalten: die (jetzt leere) An-Folge läuft, der State steht auf 1.
  writes.length = 0;
  const on = await fetch(`${baseUrl}/heimkino/rooms/${room.id}/state`, form({ on: '1', redirect: 'room' }));
  assert.equal(on.status, 302);
  assert.match(on.headers.get('location'), new RegExp(`^/heimkino/raum/${room.id}\\?ok=`));
  assert.equal((await rooms.getRoom(db, room.id)).cinemaOn, true);
  assert.equal(mqttClient.getCache().get(rooms.stateTopic(room.id)).value, 1);

  // Ausschalten: die Schleife läuft zweimal mit ihrer Wert-Aktion.
  writes.length = 0;
  const off = await fetch(`${baseUrl}/heimkino/rooms/${room.id}/state`, form({ on: '0' }));
  assert.equal(off.status, 302);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(writes, [
    { topic: 'custom://Beamer', value: 1 },
    { topic: 'custom://Beamer', value: 1 },
  ]);

  const removed = await fetch(`${baseUrl}/heimkino/raum/${room.id}/actions/${loopAction.id}/delete`, form({}));
  assert.equal(removed.status, 302);
  assert.deepEqual(await actionsRepo.listActions(db, room.id), []);

  const deleted = await fetch(`${baseUrl}/heimkino/rooms/${room.id}/delete`, form({}));
  assert.equal(deleted.status, 302);
  assert.deepEqual(await rooms.listRooms(db), []);
});
