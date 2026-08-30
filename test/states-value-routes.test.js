'use strict';

// Bedienung beschreibbarer States direkt von der States-Seite aus:
// POST /states/value schreibt über denselben Weg wie eine Aktionsfolge und
// nimmt ausschließlich States an, die ihre Quelle als beschreibbar meldet.

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-states-value-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const statesRoutes = require('../src/routes/states');
const customStates = require('../src/states/custom');
const stateProperties = require('../src/states/properties');
const controls = require('../src/states/controls');
const { isOperatePost } = require('../src/auth/session');

let db;
let server;
let baseUrl;
let access = null;
let booleanId;
let numberId;

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await stateProperties.init(db);
  await customStates.init(db);
  booleanId = (await customStates.addState(db, { name: 'Schalter', dataType: 'boolean', value: 'false' })).id;
  numberId = (await customStates.addState(db, { name: 'Sollwert', dataType: 'float', unit: '°C', value: '20' })).id;

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = access || fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(statesRoutes(db));
  server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function api(method, url, body) {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('Der Datentyp bestimmt das Bedienelement', () => {
  // Angemeldete Steuerelemente gewinnen, sonst entscheidet der zuletzt
  // gesehene Wert.
  assert.deepEqual(controls.controlFor({ writable: true, value: true }), { type: 'switch', on: 'true', off: 'false' });
  assert.deepEqual(controls.controlFor({ writable: true, value: '1' }), { type: 'switch', on: '1', off: '0' });
  assert.deepEqual(controls.controlFor({ writable: true, value: '21,5' }), { type: 'number', step: 'any' });
  assert.deepEqual(controls.controlFor({ writable: true, value: 'Guten Morgen' }), { type: 'text' });
  // Ein nur lesbarer State bekommt kein Bedienelement.
  assert.equal(controls.controlFor({ writable: false, value: 1 }), null);
  // Eine Auswahl ohne Optionen ist keine Auswahl.
  assert.deepEqual(controls.controlFor({ writable: true, value: '', control: { type: 'select', options: [] } }), { type: 'text' });
  assert.deepEqual(
    controls.controlFor({ writable: true, value: 2, control: { type: 'select', options: [{ value: 2, label: 'Automatik' }] } }),
    { type: 'select', options: [{ value: '2', label: 'Automatik' }] }
  );
  assert.equal(controls.isOn('ein'), true);
  assert.equal(controls.isOn('0'), false);
});

test('Der States-Baum liefert zu beschreibbaren States ein Bedienelement', async () => {
  const { buildStatesTree } = require('../src/states/repository');
  const tree = await buildStatesTree(db);
  const custom = tree.find((block) => block.custom);
  const states = custom.categories.flatMap((category) => category.states);
  const schalter = states.find((state) => state.name === 'Schalter');
  const sollwert = states.find((state) => state.name === 'Sollwert');
  assert.deepEqual(schalter.control, { type: 'switch', on: 'true', off: 'false' });
  assert.equal(sollwert.control.type, 'number');
});

test('Ein beschreibbarer State lässt sich über die Seite setzen', async () => {
  const topic = 'custom://Schalter';
  const response = await api('POST', '/states/value', { topic, value: 'true' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, topic, value: 'true' });
  // Der Wert landet im Custom State selbst (der Schreibweg ist derselbe wie
  // aus einer Aktionsfolge).
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = await customStates.rowsWithPaths(db);
  assert.equal(rows.states.find((state) => state.id === booleanId).value, true);

  await api('POST', '/states/value', { topic: 'custom://Sollwert', value: '21.5' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await customStates.rowsWithPaths(db);
  assert.equal(after.states.find((state) => state.id === numberId).value, 21.5);
});

test('Live-Werte liefern zusätzlich die Rohwerte der beschreibbaren States', async () => {
  const data = await (await api('GET', '/states/data.json')).json();
  assert.equal(data.values['custom://Schalter'], 'Ein');
  // Die Anzeige ist formatiert, das Bedienelement braucht den echten Wert.
  assert.equal(data.raw['custom://Schalter'], 'true');
  assert.equal(data.raw['custom://Sollwert'], '21.5');
});

test('Unbekannte States und Nur-Lese-Werte werden abgewiesen', async () => {
  const unknown = await api('POST', '/states/value', { topic: 'custom://Gibt-es-nicht', value: '1' });
  assert.equal(unknown.status, 404);
  const empty = await api('POST', '/states/value', { topic: '  ', value: '1' });
  assert.equal(empty.status, 400);
});

test('Das Setzen eines States ist eine Bedienung, kein Konfigurieren', () => {
  // Damit dürfen auch Benutzer mit der Rolle „bedienen" schalten.
  assert.equal(isOperatePost('/states/value'), true);
  assert.equal(isOperatePost('/states/properties'), false);
});

test('Bedienelemente stehen in der Zeile — aber nur mit Bedienrecht', async (t) => {
  const withRights = await (await fetch(`${baseUrl}/states`)).text();
  assert.ok(withRights.includes('class="value-row-control"'), 'mit Bedienrecht wird bedient');
  assert.ok(withRights.includes('data-control-type="switch"'), 'der Boolean-State bekommt Ein/Aus');

  const { fullAccess } = require('../src/auth/access');
  access = { ...fullAccess(), canWrite: false, canOperate: false, isAdmin: false };
  t.after(() => { access = null; });
  const readOnly = await (await fetch(`${baseUrl}/states`)).text();
  assert.ok(readOnly.includes('value-row-label'), 'die States selbst bleiben sichtbar');
  assert.ok(!readOnly.includes('class="value-row-control"'), 'ohne Bedienrecht gibt es keine Bedienelemente');
});
