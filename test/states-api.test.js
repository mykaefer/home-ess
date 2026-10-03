'use strict';

// States API v1 (STATES-API.md): Einstellungen, Anmeldung per Passwort und
// Bearer-Token, Lesen/Schreiben über den zentralen State-Baum und serverseitige
// Ausschlüsse einzelner States und ganzer Verzeichnisse.

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-states-api-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const { authorize } = require('../src/auth/session');
const { fullAccess, runWithAccess } = require('../src/auth/access');
const statesApiRoutes = require('../src/routes/states-api');
const settingsRoutes = require('../src/routes/settings');
const customStates = require('../src/states/custom');
const stateProperties = require('../src/states/properties');
const apiConfig = require('../src/states-api/config');
const tokens = require('../src/states-api/tokens');
const rateLimit = require('../src/states-api/rate-limit');
const catalog = require('../src/states-api/catalog');

const PASSWORD = 'geheim-12345';

let db;
let server;
let baseUrl;
let token = null;

const TOPIC_WZ = 'custom://Heizung/Wohnzimmer/Solltemperatur';
const TOPIC_BAD = 'custom://Heizung/Bad/Solltemperatur';
const TOPIC_LICHT = 'custom://Wohnzimmer/Licht';
const TOPIC_TEMP = 'custom://Wohnzimmer/Temperatur';
const TOPIC_READONLY = 'system://homeess/pv.yesterday';

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await stateProperties.init(db);
  await customStates.init(db);
  await apiConfig.init(db);
  const heizung = await customStates.addFolder(db, { name: 'Heizung' });
  const wz = await customStates.addFolder(db, { name: 'Wohnzimmer', parentId: heizung.id });
  const bad = await customStates.addFolder(db, { name: 'Bad', parentId: heizung.id });
  const raum = await customStates.addFolder(db, { name: 'Wohnzimmer' });
  await customStates.addState(db, { name: 'Solltemperatur', dataType: 'float', unit: '°C', value: '21', folderId: wz.id });
  await customStates.addState(db, { name: 'Solltemperatur', dataType: 'float', unit: '°C', value: '19', folderId: bad.id });
  await customStates.addState(db, { name: 'Licht', dataType: 'boolean', value: 'false', folderId: raum.id });
  await customStates.addState(db, { name: 'Temperatur', dataType: 'float', unit: '°C', value: '21.6', folderId: raum.id });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));
  // Angemeldeter Administrator der Weboberfläche. Die API darf davon nichts
  // wissen: /api/v1 prüft ausschließlich ihr eigenes Bearer-Token.
  app.use((req, _res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(authorize({ openPaths: ['/api/v1'] }));
  app.use(settingsRoutes(db));
  app.use(statesApiRoutes(db));
  app.use(statesApiRoutes.errorHandler);
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

function request(method, url, { body, auth = token, headers = {} } = {}) {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function form(url, fields) {
  return fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

function exclusion(payload) {
  return fetch(`${baseUrl}/settings/states-api/exclusion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-HomeESS-Request': '1' },
    body: JSON.stringify(payload),
  });
}

async function settingsLevel(folderPath) {
  const response = await fetch(`${baseUrl}/settings/states-api/catalog.json?path=${encodeURIComponent(folderPath)}`);
  return json(response);
}

async function login(password = PASSWORD) {
  return json(await request('POST', '/api/v1/auth', { body: { password }, auth: null }));
}

const stateUrl = (topic) => `/api/v1/states/${encodeURIComponent(topic)}`;

async function allTopics() {
  const { status, body } = await json(await request('GET', '/api/v1/states'));
  assert.equal(status, 200);
  return body.states.map((state) => state.topic);
}

test('1. Die States API ist standardmäßig deaktiviert', async () => {
  assert.equal(apiConfig.get().enabled, false);
  assert.equal(apiConfig.get().hasPassword, false);
  const info = await json(await request('GET', '/api/v1', { auth: null }));
  assert.deepEqual(info.body, { name: 'homeESS States API', version: 'v1', enabled: false });
  const auth = await login();
  assert.equal(auth.status, 403);
  assert.equal(auth.body.error, 'api_disabled');
  const states = await json(await request('GET', '/api/v1/states', { auth: 'x'.repeat(43) }));
  assert.equal(states.status, 403);
  assert.equal(states.body.error, 'api_disabled');
});

test('2./3. Aktivieren erfordert ein Passwort; Passwort setzen und API einschalten', async () => {
  let response = await form('/settings/states-api/enabled', { enabled: '1' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Bitte zuerst ein API-Passwort festlegen\./);
  assert.equal(apiConfig.get().enabled, false);

  response = await form('/settings/states-api/password', { password: 'kurz', passwordRepeat: 'kurz' });
  assert.match(await response.text(), /mindestens 8 Zeichen/);
  response = await form('/settings/states-api/password', { password: PASSWORD, passwordRepeat: 'anders-12345' });
  assert.match(await response.text(), /stimmen nicht überein/);
  assert.equal(apiConfig.get().hasPassword, false);

  response = await form('/settings/states-api/password', { password: PASSWORD, passwordRepeat: PASSWORD });
  const html = await response.text();
  assert.match(html, /Das API-Passwort wurde festgelegt\./);
  // Das Passwort taucht weder in der Seite noch im Speicher im Klartext auf.
  assert.equal(html.includes(PASSWORD), false);
  const row = await new Promise((resolve) => db.get('SELECT * FROM states_api_config WHERE id = 1', (_e, r) => resolve(r)));
  assert.match(row.password_hash, /^scrypt\$/);
  assert.equal(row.password_hash.includes(PASSWORD), false);

  response = await form('/settings/states-api/enabled', { enabled: '1' });
  assert.match(await response.text(), /Die States API ist aktiviert\./);
  assert.equal(apiConfig.get().enabled, true);
  const info = await json(await request('GET', '/api/v1', { auth: null }));
  assert.equal(info.body.enabled, true);
});

test('Die Einstellungsseite zeigt den Reiter zwischen Module und Fernzugriff', async () => {
  const html = await (await fetch(`${baseUrl}/settings?tab=states-api`)).text();
  const module = html.indexOf('data-settings-tab="module"');
  const api = html.indexOf('data-settings-tab="states-api"');
  const remote = html.indexOf('data-settings-tab="fernzugriff"');
  assert.ok(module > 0 && module < api && api < remote);
  assert.match(html, /data-settings-panel="states-api" role="tabpanel">/);
  assert.match(html, /id="statesApiEnabled" name="enabled" value="1" checked/);
});

test('4. Anmeldung mit falschem Passwort schlägt fehl', async () => {
  rateLimit.reset();
  const result = await login('falsch-falsch');
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'invalid_credentials');
  assert.equal(typeof result.body.message, 'string');
  assert.equal('token' in result.body, false);
});

test('5. Anmeldung mit richtigem Passwort liefert ein Bearer-Token', async () => {
  const result = await login();
  assert.equal(result.status, 200);
  assert.equal(result.body.tokenType, 'Bearer');
  assert.match(result.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.body.expiresIn, 12 * 60 * 60);
  assert.ok(Date.parse(result.body.expiresAt) > Date.now());
  token = result.body.token;
});

test('6. Requests ohne oder mit ungültigem Token werden abgewiesen', async () => {
  let result = await json(await request('GET', '/api/v1/states', { auth: null }));
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'unauthorized');
  result = await json(await request('GET', '/api/v1/states', { auth: null, headers: { Authorization: 'Basic abc' } }));
  assert.equal(result.body.error, 'unauthorized');
  result = await json(await request('GET', '/api/v1/states', { auth: 'A'.repeat(43) }));
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'token_invalid');
  // Die Cookie-Session der Weboberfläche ersetzt das Token nicht.
  result = await json(await request('GET', stateUrl(TOPIC_LICHT), { auth: null }));
  assert.equal(result.status, 401);
});

test('Ein abgelaufenes Token meldet token_expired', async () => {
  const issued = tokens.issue(apiConfig.get().credentialVersion, Date.now() - tokens.TOKEN_TTL_MS - 1000);
  const result = await json(await request('GET', '/api/v1/states', { auth: issued.token }));
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'token_expired');
});

test('7. Der State-Katalog lässt sich vollständig und hierarchisch abrufen', async () => {
  const list = await json(await request('GET', '/api/v1/states'));
  assert.equal(list.status, 200);
  assert.equal(list.body.total, list.body.states.length);
  const topics = list.body.states.map((state) => state.topic);
  for (const topic of [TOPIC_WZ, TOPIC_BAD, TOPIC_LICHT, TOPIC_TEMP, TOPIC_READONLY]) assert.ok(topics.includes(topic), topic);

  const root = await json(await request('GET', '/api/v1/folders'));
  assert.equal(root.status, 200);
  assert.equal(root.body.path, '');
  assert.equal(root.body.parent, null);
  assert.deepEqual(root.body.folders.map((folder) => folder.name).slice(0, 2), ['System', 'Custom']);

  const heizung = await json(await request('GET', `/api/v1/folders?path=${encodeURIComponent('Custom / Heizung')}`));
  assert.equal(heizung.status, 200);
  assert.equal(heizung.body.parent, 'Custom');
  assert.deepEqual(heizung.body.folders.map((folder) => [folder.path, folder.stateCount]).sort(), [
    ['Custom / Heizung / Bad', 1],
    ['Custom / Heizung / Wohnzimmer', 1],
  ]);
  // Schreibweise mit abweichenden Leerzeichen führt zum selben Verzeichnis.
  const loose = await json(await request('GET', `/api/v1/folders?path=${encodeURIComponent('Custom/Heizung ')}`));
  assert.equal(loose.body.path, 'Custom / Heizung');

  const sub = await json(await request('GET', `/api/v1/states?path=${encodeURIComponent('Custom / Heizung')}`));
  assert.deepEqual(sub.body.states.map((state) => state.topic).sort(), [TOPIC_BAD, TOPIC_WZ]);
  const page = await json(await request('GET', '/api/v1/states?limit=2&offset=1'));
  assert.equal(page.body.states.length, 2);
  assert.equal(page.body.states[0].topic, list.body.states[1].topic);
  const search = await json(await request('GET', '/api/v1/states?q=solltemperatur'));
  assert.deepEqual(search.body.states.map((state) => state.topic).sort(), [TOPIC_BAD, TOPIC_WZ]);

  const missing = await json(await request('GET', '/api/v1/folders?path=Gibt%20es%20nicht'));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'folder_not_found');
});

test('8. Ein einzelner State liefert Wert und Metadaten', async () => {
  const result = await json(await request('GET', stateUrl(TOPIC_TEMP)));
  assert.equal(result.status, 200);
  assert.equal(result.body.topic, TOPIC_TEMP);
  assert.equal(result.body.name, 'Temperatur');
  assert.equal(result.body.folder, 'Custom / Wohnzimmer');
  assert.equal(result.body.value, 21.6);
  assert.equal(result.body.type, 'number');
  assert.equal(result.body.unit, '°C');
  assert.equal(result.body.readable, true);
  assert.equal(result.body.writable, true);
  assert.equal(result.body.source, 'custom');

  // Unkodiert übergebene Topics werden ebenfalls aufgelöst.
  const raw = await json(await request('GET', `/api/v1/states/${TOPIC_LICHT}`));
  assert.equal(raw.status, 200);
  assert.equal(raw.body.type, 'boolean');
  assert.equal(raw.body.value, false);

  const readonly = await json(await request('GET', stateUrl(TOPIC_READONLY)));
  assert.equal(readonly.status, 200);
  assert.equal(readonly.body.writable, false);
  assert.equal('control' in readonly.body, false);

  const missing = await json(await request('GET', stateUrl('custom://Gibt/Es/Nicht')));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'state_not_found');
});

test('9. Ein beschreibbarer State wird über den zentralen Schreibweg gesetzt', async () => {
  let result = await json(await request('PUT', stateUrl(TOPIC_LICHT), { body: { value: true } }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { topic: TOPIC_LICHT, value: true, written: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  catalog.invalidate();
  result = await json(await request('GET', stateUrl(TOPIC_LICHT)));
  assert.equal(result.body.value, true);

  result = await json(await request('PUT', stateUrl(TOPIC_WZ), { body: { value: 22.5 } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.value, 22.5);
  // Custom States liegen in der Datenbank: der Wert kommt dort über den
  // regulären (asynchronen) Schreibweg an.
  let stored = null;
  for (let i = 0; i < 40 && stored !== 22.5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const rows = await customStates.rowsWithPaths(db);
    stored = rows.states.find((state) => state.topic === TOPIC_WZ).value;
  }
  assert.equal(stored, 22.5);
});

test('Ungültige Werte und Anfragen werden mit passenden Fehlern abgewiesen', async () => {
  let result = await json(await request('PUT', stateUrl(TOPIC_LICHT), { body: { value: 'vielleicht' } }));
  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'invalid_value');
  result = await json(await request('PUT', stateUrl(TOPIC_WZ), { body: { value: 'warm' } }));
  assert.equal(result.body.error, 'invalid_value');
  result = await json(await request('PUT', stateUrl(TOPIC_WZ), { body: { value: null } }));
  assert.equal(result.body.error, 'invalid_value');
  result = await json(await request('PUT', stateUrl(TOPIC_WZ), { body: { wert: 1 } }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_request');
  const broken = await fetch(`${baseUrl}${stateUrl(TOPIC_WZ)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{"value":',
  });
  assert.equal(broken.status, 400);
  const brokenBody = await broken.json();
  assert.equal(brokenBody.error, 'invalid_request');
  assert.equal(JSON.stringify(brokenBody).includes('at '), false);
  const plain = await fetch(`${baseUrl}${stateUrl(TOPIC_WZ)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
    body: '22',
  });
  assert.equal(plain.status, 415);
  result = await json(await request('DELETE', stateUrl(TOPIC_WZ)));
  assert.equal(result.status, 405);
  assert.equal(result.body.error, 'method_not_allowed');
  result = await json(await request('GET', '/api/v1/gibt-es-nicht'));
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'not_found');
  const undecodable = await json(await request('GET', '/api/v1/states/%E0%A4%A'));
  assert.equal(undecodable.status, 400);
  assert.equal(undecodable.body.error, 'invalid_request');
});

test('Gerätschalter aus Messen + Schalten erscheinen als Schalter und schalten über die Automatik', async () => {
  const mqttClient = require('../src/mqtt/client');
  const systemRouter = require('../src/states/system-router');
  const automation = require('../src/messen-schalten/automation');
  const levelHandler = require('../src/operating-level/handler');
  await new Promise((resolve, reject) => db.run(
    "INSERT INTO mess_schalt_actors (id, name, switch_topic, status_topic, priority, always_on) VALUES (77, 'Steckdose', 'sd.0.state', 'sd.0.status', 4, 0), (78, 'Kühlschrank', 'ks.0.state', '', 4, 1)",
    (error) => (error ? reject(error) : resolve())));
  systemRouter.registerWriter('geraet.', (id, value) => automation.handleSwitchWrite(db, id, value));
  require('../src/states/system-values').invalidateInternalValues();
  catalog.invalidate();
  const topic = 'system://homeess/geraet.77.schalten';
  const state = await json(await request('GET', stateUrl(topic)));
  assert.equal(state.status, 200);
  assert.equal(state.body.type, 'boolean');
  assert.equal(state.body.writable, true);
  assert.deepEqual(state.body.control, { type: 'switch' });
  assert.equal(state.body.display, 'Aus');
  const status = await json(await request('GET', stateUrl('system://homeess/geraet.77.status')));
  assert.equal(status.body.writable, false);
  assert.equal(status.body.display, 'Aus');
  // „Immer an“-Geräte lassen sich auch hier nicht schalten.
  const always = await json(await request('GET', stateUrl('system://homeess/geraet.78.schalten')));
  assert.equal(always.body.writable, false);

  const original = mqttClient.publish;
  const sent = [];
  mqttClient.publish = (target, value) => {
    if (String(target).startsWith('system://')) return original(target, value);
    sent.push([target, String(value)]);
    return true;
  };
  try {
    levelHandler.applyLevel(5);
    const write = await json(await request('PUT', stateUrl(topic), { body: { value: true } }));
    assert.equal(write.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(sent.at(-1), ['sd.0.state', '1']);
  } finally {
    mqttClient.publish = original;
    systemRouter.unregisterWriter('geraet.');
    automation.resetForTests();
  }
});

test('10. Ein nicht schreibbarer State wird abgewiesen', async () => {
  const result = await json(await request('PUT', stateUrl(TOPIC_READONLY), { body: { value: 1 } }));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'state_not_writable');
});

test('11.–13. Ein einzelner State lässt sich ausschließen und ist danach unerreichbar', async () => {
  let response = await exclusion({ kind: 'state', topic: TOPIC_TEMP, excluded: true });
  assert.equal(response.status, 200);
  assert.deepEqual(apiConfig.get().excludedStates, [TOPIC_TEMP]);

  // Einstellungsansicht: weiterhin sichtbar, aber als ausgeschlossen markiert.
  const level = await settingsLevel('Custom / Wohnzimmer');
  assert.equal(level.body.states.find((state) => state.topic === TOPIC_TEMP).excluded, true);

  assert.equal((await allTopics()).includes(TOPIC_TEMP), false);
  const folder = await json(await request('GET', `/api/v1/folders?path=${encodeURIComponent('Custom / Wohnzimmer')}`));
  assert.deepEqual(folder.body.states.map((state) => state.topic), [TOPIC_LICHT]);
  const search = await json(await request('GET', '/api/v1/states?q=Temperatur'));
  assert.equal(search.body.states.some((state) => state.topic === TOPIC_TEMP), false);
  const root = await json(await request('GET', '/api/v1/folders?path=Custom'));
  assert.equal(root.body.folders.find((entry) => entry.path === 'Custom / Wohnzimmer').stateCount, 1);

  for (const variant of [TOPIC_TEMP, ` ${TOPIC_TEMP} `, 'CUSTOM://Wohnzimmer/Temperatur']) {
    const read = await json(await request('GET', stateUrl(variant)));
    assert.equal(read.status, 404, variant);
    assert.equal(read.body.error, 'state_not_found');
    const write = await json(await request('PUT', stateUrl(variant), { body: { value: 30 } }));
    assert.equal(write.status, 404, variant);
  }
});

test('14.–17. Ein komplettes Verzeichnis wird rekursiv ausgeschlossen', async () => {
  // Vorheriger Einzelausschluss unterhalb wird beim Ausschluss des Vorfahren
  // überflüssig und verschwindet aus der Liste.
  let response = await exclusion({ kind: 'state', topic: TOPIC_BAD, excluded: true });
  assert.equal(response.status, 200);
  response = await exclusion({ kind: 'folder', path: 'Custom / Heizung', excluded: true });
  assert.equal(response.status, 200);
  assert.deepEqual(apiConfig.get().excludedFolders, ['Custom / Heizung']);
  assert.deepEqual(apiConfig.get().excludedStates, [TOPIC_TEMP]);

  // 15. Einstellungsansicht: Unterelemente nicht mehr separat konfigurierbar.
  const parent = await settingsLevel('Custom');
  assert.equal(parent.body.folders.find((folder) => folder.path === 'Custom / Heizung').excluded, true);
  const inside = await settingsLevel('Custom / Heizung');
  assert.equal(inside.body.excluded, true);
  assert.deepEqual(inside.body.folders, []);
  assert.deepEqual(inside.body.states, []);
  const deeper = await settingsLevel('Custom / Heizung / Wohnzimmer');
  assert.equal(deeper.body.exclusion, 'parent');
  assert.deepEqual(deeper.body.states, []);
  // Widersprüchliche Regeln sind nicht einstellbar.
  response = await exclusion({ kind: 'folder', path: 'Custom / Heizung / Wohnzimmer', excluded: false });
  assert.equal(response.status, 409);
  response = await exclusion({ kind: 'state', topic: TOPIC_WZ, excluded: true });
  assert.equal(response.status, 409);

  // 16. API: weder in Liste noch in Verzeichnissen noch in der Suche.
  const topics = await allTopics();
  assert.equal(topics.includes(TOPIC_WZ), false);
  assert.equal(topics.includes(TOPIC_BAD), false);
  const custom = await json(await request('GET', '/api/v1/folders?path=Custom'));
  assert.equal(custom.body.folders.some((folder) => folder.path.startsWith('Custom / Heizung')), false);
  const search = await json(await request('GET', '/api/v1/states?q=Heizung'));
  assert.deepEqual(search.body.states, []);

  // 17. Direkter Zugriff auf Verzeichnis und untergeordnete States.
  for (const folderPath of ['Custom / Heizung', 'Custom/Heizung/Wohnzimmer', ' Custom /  Heizung / Bad ']) {
    const result = await json(await request('GET', `/api/v1/folders?path=${encodeURIComponent(folderPath)}`));
    assert.equal(result.status, 404, folderPath);
    const list = await json(await request('GET', `/api/v1/states?path=${encodeURIComponent(folderPath)}`));
    assert.equal(list.status, 404, folderPath);
  }
  for (const topic of [TOPIC_WZ, TOPIC_BAD, `/${TOPIC_WZ}`, 'custom://Heizung/Wohnzimmer//Solltemperatur']) {
    const read = await json(await request('GET', stateUrl(topic)));
    assert.equal(read.status, 404, topic);
    const write = await json(await request('PUT', stateUrl(topic), { body: { value: 30 } }));
    assert.equal(write.status, 404, topic);
  }
  const rows = await customStates.rowsWithPaths(db);
  assert.equal(rows.states.find((state) => state.topic === TOPIC_WZ).value, 22.5);
});

test('18./19. Wieder freigegebene Verzeichnisse zeigen ihre Einträge erneut', async () => {
  const response = await exclusion({ kind: 'folder', path: 'Custom / Heizung', excluded: false });
  assert.equal(response.status, 200);
  assert.deepEqual(apiConfig.get().excludedFolders, []);
  const inside = await settingsLevel('Custom / Heizung');
  assert.equal(inside.body.excluded, false);
  assert.deepEqual(inside.body.folders.map((folder) => folder.name).sort(), ['Bad', 'Wohnzimmer']);
  const topics = await allTopics();
  assert.ok(topics.includes(TOPIC_WZ));
  assert.ok(topics.includes(TOPIC_BAD));
  const read = await json(await request('GET', stateUrl(TOPIC_BAD)));
  assert.equal(read.status, 200);
});

test('20. Nach einer Passwortänderung gilt das alte Token nicht mehr', async () => {
  const before = await json(await request('GET', stateUrl(TOPIC_LICHT)));
  assert.equal(before.status, 200);
  const next = 'neues-passwort-99';
  const response = await form('/settings/states-api/password', { password: next, passwordRepeat: next });
  assert.match(await response.text(), /Das API-Passwort wurde geändert\./);
  const after = await json(await request('GET', stateUrl(TOPIC_LICHT)));
  assert.equal(after.status, 401);
  assert.equal(after.body.error, 'token_invalid');
  assert.equal((await login(PASSWORD)).status, 401);
  const fresh = await login(next);
  assert.equal(fresh.status, 200);
  token = fresh.body.token;
  // Auch ein vor der Änderung ausgestelltes, noch unbekanntes Token der alten
  // Credential-Version wird abgewiesen.
  const stale = tokens.issue(apiConfig.get().credentialVersion - 1);
  assert.equal(tokens.verify(stale.token, apiConfig.get().credentialVersion).status, 'invalid');
});

test('21. Die Konfiguration übersteht einen Neustart', async () => {
  await exclusion({ kind: 'folder', path: 'Custom / Heizung / Bad', excluded: true });
  const saved = apiConfig.get();
  // Neustart simulieren: Speicherabbild verwerfen und aus SQLite laden.
  apiConfig.resetForTests();
  assert.equal(apiConfig.get().enabled, false);
  const reloaded = await apiConfig.load(db);
  assert.equal(reloaded.enabled, true);
  assert.equal(reloaded.hasPassword, true);
  assert.equal(reloaded.credentialVersion, saved.credentialVersion);
  assert.deepEqual(reloaded.excludedFolders, ['Custom / Heizung / Bad']);
  assert.deepEqual(reloaded.excludedStates, [TOPIC_TEMP]);
  const read = await json(await request('GET', stateUrl(TOPIC_BAD)));
  assert.equal(read.status, 404);
});

test('Deaktivieren sperrt die API und verwirft ausgegebene Tokens', async () => {
  let response = await form('/settings/states-api/enabled', {});
  assert.match(await response.text(), /Die States API ist deaktiviert\./);
  let result = await json(await request('GET', '/api/v1/states'));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'api_disabled');
  response = await form('/settings/states-api/enabled', { enabled: '1' });
  result = await json(await request('GET', '/api/v1/states'));
  assert.equal(result.body.error, 'token_invalid');
  const fresh = await login('neues-passwort-99');
  token = fresh.body.token;
  const logout = await request('POST', '/api/v1/auth/logout');
  assert.equal(logout.status, 204);
  result = await json(await request('GET', '/api/v1/states'));
  assert.equal(result.body.error, 'token_invalid');
});

test('Ohne Administratorrecht bleiben Katalog und Freigaben gesperrt', async () => {
  const { accessForUser } = require('../src/auth/access');
  const writer = accessForUser({ id: 2, name: 'Schreiber', role: 'write', is_admin: 0, visible_pages: null });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { id: 'writer', userId: 2 };
    req.access = writer;
    runWithAccess(writer, () => next());
  });
  app.use(settingsRoutes(db));
  app.use(statesApiRoutes(db));
  const other = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  const url = `http://127.0.0.1:${other.address().port}`;
  try {
    assert.equal((await fetch(`${url}/settings/states-api/catalog.json`)).status, 403);
    const change = await fetch(`${url}/settings/states-api/exclusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HomeESS-Request': '1' },
      body: JSON.stringify({ kind: 'folder', path: 'Custom', excluded: true }),
    });
    assert.equal(change.status, 403);
    assert.equal((await fetch(`${url}/settings/audio-bus`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'maxSessions=64' })).status, 403);
    const password = await fetch(`${url}/settings/states-api/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=abcdefgh1&passwordRepeat=abcdefgh1',
    });
    assert.equal(password.status, 403);
    const page = await (await fetch(`${url}/settings?tab=states-api`)).text();
    assert.match(page, /id="statesApiEnabled" name="enabled" value="1" checked disabled/);
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
  // Der Katalog ohne CSRF-Header wird auch für Administratoren abgewiesen.
  const noCsrf = await fetch(`${baseUrl}/settings/states-api/exclusion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'folder', path: 'Custom', excluded: true }),
  });
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(apiConfig.get().excludedFolders, ['Custom / Heizung / Bad']);
});

test('Fehlgeschlagene Anmeldungen werden begrenzt', async () => {
  rateLimit.reset();
  for (let i = 0; i < rateLimit.MAX_FAILURES_PER_CLIENT; i += 1) {
    const result = await login('falsch-falsch');
    assert.equal(result.status, 401);
  }
  const blocked = await request('POST', '/api/v1/auth', { body: { password: 'neues-passwort-99' }, auth: null });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await blocked.json()).error, 'too_many_attempts');
  rateLimit.reset();
  assert.equal((await login('neues-passwort-99')).status, 200);
});

test('Das Rate-Limit sperrt nach Fehlversuchen und gibt nach Ablauf frei', () => {
  rateLimit.reset();
  const start = 1_000_000;
  for (let i = 1; i < rateLimit.MAX_FAILURES_PER_CLIENT; i += 1) {
    assert.equal(rateLimit.recordFailure('a', start + i).locked, false);
  }
  assert.equal(rateLimit.recordFailure('a', start + 10).locked, true);
  assert.equal(rateLimit.check('a', start + 11).allowed, false);
  assert.equal(rateLimit.check('b', start + 11).allowed, true);
  assert.equal(rateLimit.check('a', start + 10 + rateLimit.LOCK_MS).allowed, true);
  rateLimit.reset();
});

test('Schreibwerte werden gegen die Grenzen des Bedienelements geprüft', () => {
  const number = { writable: true, control: { type: 'number', min: 5, max: 30, step: 0.5 } };
  assert.equal(catalog.payloadFor(number, 21.5), '21.5');
  assert.equal(catalog.payloadFor(number, '22,0'), '22');
  assert.throws(() => catalog.payloadFor(number, 4), /Minimum/);
  assert.throws(() => catalog.payloadFor(number, 31), /Maximum/);
  assert.throws(() => catalog.payloadFor(number, 21.3), /Schrittweite/);
  assert.throws(() => catalog.payloadFor(number, true), /Zahl/);
  const select = { writable: true, control: { type: 'select', options: [{ value: '0', label: 'Aus' }, { value: '2', label: 'Auto' }] } };
  assert.equal(catalog.payloadFor(select, 2), '2');
  assert.throws(() => catalog.payloadFor(select, 1), /Optionen/);
  const sw = { writable: true, control: { type: 'switch', on: '1', off: '0' } };
  assert.equal(catalog.payloadFor(sw, true), '1');
  assert.equal(catalog.payloadFor(sw, false), '0');
  assert.throws(() => catalog.payloadFor(sw, 'an'), /true oder false/);
  const text = { writable: true, control: { type: 'text' } };
  assert.throws(() => catalog.payloadFor(text, 'x'.repeat(501)), /zu lang/);
  assert.throws(() => catalog.payloadFor(text, { a: 1 }), /Datentyp/);
});

test('Ein Topic in zwei Verzeichnissen gilt als ausgeschlossen, sobald eines davon gesperrt ist', () => {
  const state = { topic: 'demo://x/a', name: 'A', writable: false, value: 1 };
  const index = catalog.buildIndex([
    { system: true, categories: [{ name: 'Eins', states: [state], children: [] }, { name: 'Zwei', states: [state], children: [] }] },
  ], null);
  const view = catalog.apiView(index, { excludedFolders: ['System / Zwei'], excludedStates: [] });
  assert.equal(view.findState('demo://x/a'), null);
  assert.deepEqual(view.allStates().map((entry) => entry.topic), []);
  assert.equal(view.findFolder('System / Eins'), null);
});

test('Audiobus-Limit wird gespeichert, sofort angewandt und beim Laden wiederhergestellt', async () => {
  const audio = require('../src/audio-bus');
  const config = require('../src/audio-bus/config');
  try {
    const saved = await form('/settings/audio-bus', { maxSessions: '64' });
    assert.equal(saved.status, 200);
    assert.equal(audio.status().limits.maxSessions, 64);
    assert.equal(audio.status().maxConnections, 128);
    assert.equal(await config.load(db), 64);
    audio.bus.setMaxSessions(16);
    await audio.init(db);
    assert.equal(audio.status().limits.maxSessions, 64);
    for (const value of ['0', '257', '1.5', '', 'abc']) {
      assert.equal((await form('/settings/audio-bus', { maxSessions: value })).status, 400);
      assert.equal(audio.status().limits.maxSessions, 64);
      assert.equal(await config.load(db), 64);
    }
    const page = await (await fetch(`${baseUrl}/settings?tab=states-api`)).text();
    assert.match(page, /name="maxSessions"[^>]*value="64"/);
  } finally { await audio.saveSettings(db, 16); }
});
