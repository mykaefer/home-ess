'use strict';

// Ende-zu-Ende-Prüfung der Seite „Nachrichten": Migration, CRUD über die
// Formular-POSTs, Testversand und das Verhalten bei einem gelöschten State.

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-notification-routes-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const notificationRoutes = require('../src/routes/notifications');
const repository = require('../src/notifications/rules');
const { fullAccess, runWithAccess } = require('../src/auth/access');

let db;
let server;
let baseUrl;

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function form(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.append(key, value);
  return { method: 'POST', body, redirect: 'manual' };
}

const ruleForm = (overrides = {}) => ({
  name: 'Türklingel',
  stateId: 'custom://Klingel',
  triggerType: 'equals',
  triggerValue: 'true',
  title: 'Türklingel',
  body: 'Es klingelt an der Tür.',
  eventType: 'doorbell',
  severity: 'normal',
  cooldownSeconds: '5',
  enabled: '1',
  ...overrides,
});

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(notificationRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Die Migration legt notification_rules ohne Empfänger- oder Instanzfelder an', async () => {
  const columns = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(notification_rules)', (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
  const names = columns.map((column) => column.name);
  for (const expected of ['id', 'name', 'enabled', 'state_id', 'trigger_type', 'trigger_value',
    'title', 'body', 'event_type', 'severity', 'cooldown_seconds',
    'created_at', 'updated_at', 'last_triggered_at']) {
    assert.ok(names.includes(expected), `Spalte ${expected} fehlt`);
  }
  for (const forbidden of ['instance_id', 'device_id', 'fcm_token', 'recipients']) {
    assert.equal(names.includes(forbidden), false, `Spalte ${forbidden} darf es nicht geben`);
  }
});

test('Die Seite ist erreichbar und zeigt zunächst keine Regel', async () => {
  const html = await fetch(`${baseUrl}/notifications`).then((res) => res.text());
  assert.match(html, /Nachrichtenregeln/);
  assert.match(html, /Noch keine Nachricht angelegt/);
});

test('CRUD über die Formular-POSTs legt an, speichert, schaltet um und löscht', async () => {
  const created = await fetch(`${baseUrl}/notifications/rules`, form(ruleForm()));
  assert.equal(created.status, 302);

  let rules = await repository.listRules(db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].eventType, 'doorbell');
  assert.equal(rules[0].enabled, true);
  const id = rules[0].id;

  const saved = await fetch(`${baseUrl}/notifications/rules/${id}`, form(ruleForm({ name: 'Klingel', cooldownSeconds: '30' })));
  assert.equal(saved.status, 302);
  rules = await repository.listRules(db);
  assert.equal(rules[0].name, 'Klingel');
  assert.equal(rules[0].cooldownSeconds, 30);

  await fetch(`${baseUrl}/notifications/rules/${id}/toggle`, form({ enabled: '0' }));
  assert.equal((await repository.getRule(db, id)).enabled, false);

  const html = await fetch(`${baseUrl}/notifications`).then((res) => res.text());
  assert.match(html, /Klingel/);

  await fetch(`${baseUrl}/notifications/rules/${id}/delete`, form({}));
  assert.equal((await repository.listRules(db)).length, 0);
});

test('Eine ungültige Eingabe liefert 400 mit erneut gefülltem Dialog', async () => {
  const response = await fetch(`${baseUrl}/notifications/rules`, form(ruleForm({ eventType: 'Tür Klingel' })));
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /Ereignistyp darf nur/);
  // Die Eingaben stehen wieder im Dialog, damit nichts verloren geht.
  assert.match(html, /value="Türklingel"/);
  assert.equal((await repository.listRules(db)).length, 0);
});

test('Ein Test ohne verbundenen Relay meldet das, ohne die Regel zu verändern', async () => {
  await fetch(`${baseUrl}/notifications/rules`, form(ruleForm({ name: 'Testregel' })));
  const rule = (await repository.listRules(db))[0];

  const result = await fetch(`${baseUrl}/notifications/rules/${rule.id}/test`, {
    method: 'POST', headers: { 'X-HomeESS-Request': '1' },
  }).then((res) => res.json());
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'relay_unavailable');
  assert.equal(result.message, 'Relay derzeit nicht verfügbar.');
  // Der Testversand ist kein Trigger.
  assert.equal((await repository.getRule(db, rule.id)).lastTriggeredAt, null);

  const missing = await fetch(`${baseUrl}/notifications/rules/999999/test`, { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('Eine Regel auf einen gelöschten State wird als ungültig angezeigt, nicht als Fehler', async () => {
  const html = await fetch(`${baseUrl}/notifications`).then((res) => res.text());
  // custom://Klingel existiert in dieser Testdatenbank nicht.
  assert.match(html, /State nicht vorhanden/);

  const data = await fetch(`${baseUrl}/notifications/data`).then((res) => res.json());
  assert.equal(data.rules[0].stateMissing, true);
  assert.equal(data.relayState, 'disconnected');

  const info = await fetch(`${baseUrl}/notifications/state-info?stateId=custom%3A%2F%2FKlingel`).then((res) => res.json());
  assert.equal(info.found, false);
});

// Regression: Berechnete Systemwerte stehen im flachen Wertekatalog unter ihrer
// fachlichen Kurz-ID (`operating.notstrom`), adressiert werden sie aber über ihr
// kanonisches Topic (`system://homeess/operating.notstrom`) — genau das trägt der
// State-Picker ein. Ein direkter Abgleich gegen den Katalog meldete solche States
// deshalb als gelöscht und ließ zugleich die Typprüfung ins Leere laufen.
const SYSTEM_STATE = 'system://homeess/operating.notstrom';

test('Ein Systemwert wird über sein kanonisches system://-Topic aufgelöst', async () => {
  const info = await fetch(`${baseUrl}/notifications/state-info?stateId=${encodeURIComponent(SYSTEM_STATE)}`)
    .then((res) => res.json());
  assert.equal(info.found, true, 'system://-Topic muss auflösbar sein');
  assert.equal(info.label, 'Notstrombetrieb');
  assert.equal(info.valueType, 'boolean');
});

test('Eine Regel auf einen Systemwert gilt als gültig, nicht als gelöscht', async () => {
  const created = await fetch(`${baseUrl}/notifications/rules`, form({
    name: 'Stromausfall',
    stateId: SYSTEM_STATE,
    triggerType: 'equals',
    triggerValue: 'true',
    title: 'Stromausfall',
    body: 'Die Netzversorgung ist ausgefallen.',
    eventType: 'power_failure',
    severity: 'critical',
    cooldownSeconds: '5',
    enabled: '1',
  }));
  assert.equal(created.status, 302);

  const rule = (await repository.listRules(db)).find((entry) => entry.name === 'Stromausfall');
  assert.equal(rule.stateId, SYSTEM_STATE, 'gespeichert wird die kanonische Adresse');

  const data = await fetch(`${baseUrl}/notifications/data`).then((res) => res.json());
  const view = data.rules.find((entry) => entry.id === rule.id);
  assert.equal(view.stateMissing, false);
  assert.notEqual(view.stateDisplay, '—');
});

test('Grenzwerte werden auch auf einem booleschen Systemwert abgewiesen', async () => {
  const response = await fetch(`${baseUrl}/notifications/rules`, form({
    name: 'Grenzwert auf Schalter',
    stateId: SYSTEM_STATE,
    triggerType: 'above',
    triggerValue: '1',
    title: 'T',
    body: 'B',
    eventType: 'test',
    severity: 'normal',
    cooldownSeconds: '5',
    enabled: '1',
  }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /nur für numerische States/);
});
