'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-system-warning-routes-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const liveRoutes = require('../src/routes/live');
const systemWarning = require('../src/system-warning');
const { isOperatePost } = require('../src/auth/session');

let db;
let server;
let baseUrl;

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await systemWarning.init(db);

  const app = express();
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(liveRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('die Kopfdaten führen die systemweite Warnung mit', async () => {
  await systemWarning.raise(db, 'Netzschaltung dauerhaft nicht bestätigt', { source: 'Netzsteuerung' });
  const data = await fetch(`${baseUrl}/live/header`).then((res) => res.json());
  assert.equal(data.warning.active, true);
  assert.equal(data.warning.text, 'Netzschaltung dauerhaft nicht bestätigt');
  assert.equal(data.warning.source, 'Netzsteuerung');
});

test('POST /live/warnung/quittieren setzt Flag und Text zurück', async () => {
  await systemWarning.raise(db, 'Bitte Anlage prüfen');
  const res = await fetch(`${baseUrl}/live/warnung/quittieren`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.warning, { active: false, text: '' });

  const data = await fetch(`${baseUrl}/live/header`).then((r) => r.json());
  assert.equal(data.warning.active, false);
  assert.equal(data.warning.text, '');
});

test('Quittieren ist eine Bedienhandlung, kein Schreibrecht', () => {
  assert.equal(isOperatePost('/live/warnung/quittieren'), true);
  assert.equal(isOperatePost('/live/header'), false);
});

test('Warntext und Warnung-aktiv stehen als Systemwerte unter Betrieb bereit', async () => {
  const { listCalculatedInternalValues, invalidateInternalValues } = require('../src/states/system-values');
  const mqttClient = require('../src/mqtt/client');

  await systemWarning.raise(db, 'Anlage prüfen', { source: 'Netzsteuerung' });
  invalidateInternalValues();
  let values = await listCalculatedInternalValues(db, mqttClient.getCache());
  const text = values.find((entry) => entry.id === 'operating.warnungText');
  const active = values.find((entry) => entry.id === 'operating.warnungAktiv');
  assert.ok(text, 'operating.warnungText fehlt');
  assert.ok(active, 'operating.warnungAktiv fehlt');
  assert.equal(text.category, 'Betrieb');
  assert.equal(active.category, 'Betrieb');
  assert.equal(text.label, 'Warnungstext');
  assert.equal(active.label, 'Warnung aktiv');
  assert.equal(text.value, 'Anlage prüfen');
  assert.equal(active.value, true);

  await systemWarning.acknowledge(db);
  invalidateInternalValues();
  values = await listCalculatedInternalValues(db, mqttClient.getCache());
  assert.equal(values.find((entry) => entry.id === 'operating.warnungText').value, '');
  assert.equal(values.find((entry) => entry.id === 'operating.warnungAktiv').value, false);
});
