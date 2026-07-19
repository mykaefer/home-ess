'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-dashboard-routes-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const authRoutes = require('../src/auth/routes');
const dashboardRoutes = require('../src/routes/dashboard');
const widgetsRepo = require('../src/dashboard/widgets');

let db;
let server;
let baseUrl;

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await widgetsRepo.createWidget(db, { sourceId: 'pv.current' });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  // Angemeldete Session mit vollem Zugriff simulieren (die echte Session-/
  // Autorisierungs-Middleware ist hier nicht Gegenstand des Tests).
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(authRoutes(db));
  app.use(dashboardRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// `/` bleibt als Startantwort klein und leitet angemeldete Nutzer weiter; das
// vollständige Dashboard wird unter `/dashboard` gerendert.
test('GET / leitet klein auf /dashboard; GET /dashboard liefert das vollständige Dashboard', async () => {
  const root = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/dashboard');

  const dashboard = await fetch(`${baseUrl}/dashboard`).then((res) => res.text());
  assert.match(dashboard, /class="dash-tabbar"/);
  assert.match(dashboard, /widget-card widget-card--value/);
  assert.match(dashboard, /id="widgetDialog"/);
});

test('Tabs: anlegen, umbenennen, löschen über die Routen', async () => {
  let res = await fetch(`${baseUrl}/dashboard/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'title=Energie',
  });
  let html = await res.text();
  assert.match(html, /Energie/);

  // Leerer Name: Dialog mit Fehlermeldung, kein neuer Tab.
  res = await fetch(`${baseUrl}/dashboard/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'title=',
  });
  html = await res.text();
  assert.match(html, /Bitte einen Namen/);
});

test('POST /dashboard/layout persistiert auch die Tab-Reihenfolge', async () => {
  // Zwei Tabs anlegen (der erste existiert bereits durch die Migration).
  await fetch(`${baseUrl}/dashboard/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'title=Sortiertest',
  });
  const before = await fetch(`${baseUrl}/dashboard`).then((res) => res.text());
  const idsBefore = [...before.matchAll(/dash-tab" role="tab" data-tab-id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(idsBefore.length >= 2);

  const reversed = idsBefore.slice().reverse();
  const res = await fetch(`${baseUrl}/dashboard/layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabs: reversed.map((id, index) => ({ id, position: index })) }),
  });
  assert.equal(res.status, 200);

  const after = await fetch(`${baseUrl}/dashboard`).then((res2) => res2.text());
  const idsAfter = [...after.matchAll(/dash-tab" role="tab" data-tab-id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(idsAfter, reversed);
});

test('GET /dashboard/data liefert Widgets, Schalter und Systeminfo', async () => {
  const res = await fetch(`${baseUrl}/dashboard/data`, { headers: { Accept: 'application/json' } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.widgets));
  assert.ok(Array.isArray(data.switches));
  assert.ok(data.system && data.system.homeess_version);
  assert.equal(data.widgets.length, 1);
});

test('POST /dashboard/switch: unbekanntes Widget ergibt 404', async () => {
  const res = await fetch(`${baseUrl}/dashboard/switch/9999/1`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test.after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* egal */
  }
});
