'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-users-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const usersRepo = require('../src/auth/users');
const accessMod = require('../src/auth/access');
const { sessionMiddleware, authorize } = require('../src/auth/session');
const authRoutes = require('../src/auth/routes');
const settingsRoutes = require('../src/routes/settings');

function freshDb() {
  fs.rmSync(process.env.HOME_ESS_DB, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 400));
}

// --- Einheit: access.js ------------------------------------------------------
test('accessForUser: Administrator hat immer vollen Zugriff', () => {
  const acc = accessMod.accessForUser({ id: 1, name: 'Administrator', role: 'read', is_admin: 1, visible_pages: '["dashboard"]' });
  assert.equal(acc.isAdmin, true);
  assert.equal(acc.role, 'write');
  assert.equal(acc.canWrite, true);
  assert.equal(acc.canOperate, true);
  assert.equal(acc.visiblePages, null); // alle Seiten sichtbar
});

test('accessForUser: Rollen read/operate/write korrekt abgebildet', () => {
  const read = accessMod.accessForUser({ id: 2, role: 'read', is_admin: 0, visible_pages: null });
  assert.deepEqual([read.canWrite, read.canOperate], [false, false]);
  const operate = accessMod.accessForUser({ id: 3, role: 'operate', is_admin: 0, visible_pages: '["dashboard"]' });
  assert.deepEqual([operate.canWrite, operate.canOperate], [false, true]);
  assert.deepEqual(operate.visiblePages, ['dashboard']);
  const write = accessMod.accessForUser({ id: 4, role: 'write', is_admin: 0, visible_pages: null });
  assert.deepEqual([write.canWrite, write.canOperate], [true, true]);
});

test('pageForPath ordnet Unterrouten der Seite zu; canSeePage prüft Sichtbarkeit', () => {
  assert.equal(accessMod.pageForPath('/messen-schalten/schaltgruppen'), 'messen-schalten');
  assert.equal(accessMod.pageForPath('/stromverbrauch/data'), 'stromverbrauch');
  assert.equal(accessMod.pageForPath('/live/header'), null);
  // Module und Fernzugriff gehören zur Einstellungsseite (Tabs).
  assert.equal(accessMod.pageForPath('/module/pool/enable'), 'settings');
  assert.equal(accessMod.pageForPath('/remote-access'), 'settings');
  assert.equal(accessMod.pageForPath('/api/remote-access/pairing'), 'settings');
  const acc = accessMod.accessForUser({ role: 'read', is_admin: 0, visible_pages: '["dashboard"]' });
  assert.equal(accessMod.canSeePage(acc, 'dashboard'), true);
  assert.equal(accessMod.canSeePage(acc, 'photovoltaik'), false);
  assert.equal(accessMod.canSeePage(accessMod.fullAccess(), 'photovoltaik'), true);
});

// --- Einheit: users.js -------------------------------------------------------
test('Migration/Seed: erster Nutzer ist Administrator', async () => {
  const db = await freshDb();
  const users = await usersRepo.listUsers(db);
  assert.equal(users.length, 1);
  assert.equal(users[0].isAdmin, true);
  assert.equal(users[0].name, 'Administrator');
  db.close();
});

test('createUser/updateUser/deleteUser inkl. Admin-Schutz und Namensprüfung', async () => {
  const db = await freshDb();
  const user = await usersRepo.createUser(db, { name: 'Lars', password: 'geheim', role: 'operate', visiblePages: ['dashboard', 'messen-schalten'] });
  assert.equal(user.role, 'operate');
  assert.deepEqual(user.visiblePages, ['dashboard', 'messen-schalten']);

  // Doppelter Name (case-insensitive) wird abgelehnt.
  await assert.rejects(() => usersRepo.createUser(db, { name: 'lars', password: 'x', role: 'read' }), /vergeben/);
  // Ohne Passwort keine Neuanlage.
  await assert.rejects(() => usersRepo.createUser(db, { name: 'Neu', password: '', role: 'read' }), /Passwort/);

  // Update: Rolle ändern, Passwort leer lässt bestehendes unangetastet.
  const updated = await usersRepo.updateUser(db, user.id, { name: 'Lars', password: '', role: 'write', visiblePages: ['dashboard'] });
  assert.equal(updated.role, 'write');
  assert.deepEqual(updated.visiblePages, ['dashboard']);

  // Administrator kann nicht gelöscht werden.
  const [admin] = (await usersRepo.listUsers(db)).filter((u) => u.isAdmin);
  await assert.rejects(() => usersRepo.deleteUser(db, admin.id), /Administrator/);

  // Admin-Rolle/Sichtbarkeit bleiben bei Update voll (nicht herabstufbar).
  const adminUpdated = await usersRepo.updateUser(db, admin.id, { name: 'Chef', role: 'read', visiblePages: [] });
  assert.equal(adminUpdated.isAdmin, true);
  assert.equal(adminUpdated.role, 'write');
  assert.equal(adminUpdated.visiblePages, null);

  await usersRepo.deleteUser(db, user.id);
  assert.equal((await usersRepo.getUser(db, user.id)), null);
  db.close();
});

// --- Integration: Login + Autorisierung -------------------------------------
function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function loginAs(baseUrl, userId, password) {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `userId=${userId}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return cookie;
}

test('Login + Rechtemodell über die echte Middleware', async () => {
  const db = await freshDb();
  // Zusätzliche Nutzer anlegen.
  const reader = await usersRepo.createUser(db, { name: 'Leser', password: 'lesen', role: 'read', visiblePages: ['dashboard'] });
  const operator = await usersRepo.createUser(db, { name: 'Bediener', password: 'op', role: 'operate', visiblePages: ['dashboard', 'messen-schalten'] });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(sessionMiddleware(db));
  app.use(authorize({ openPaths: ['/', '/login', '/logout'], sharedPaths: ['/live', '/me'] }));
  app.use(authRoutes(db));
  app.use(settingsRoutes(db));
  // Test-Schreib- und Schalt-/Bedienrouten.
  app.post('/dashboard/groups', (req, res) => res.json({ ok: true }));
  app.post('/messen-schalten/actor/:id/switch/:state', (req, res) => res.json({ ok: true }));
  app.post('/wallbox/box/:id/mode/:mode', (req, res) => res.json({ ok: true }));
  app.get('/photovoltaik', (req, res) => res.send('pv'));
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const [admin] = (await usersRepo.listUsers(db)).filter((u) => u.isAdmin);

  // Falsches Passwort -> kein Cookie.
  const badCookie = await loginAs(baseUrl, admin.id, 'falsch');
  assert.ok(!badCookie.includes('ess_sid=') || badCookie === '');

  // Leser: darf lesen, nicht schreiben/schalten; gesperrte Seite -> Redirect.
  const readCookie = await loginAs(baseUrl, reader.id, 'lesen');
  const meRead = await fetch(`${baseUrl}/me/access`, { headers: { Cookie: readCookie, Accept: 'application/json' } }).then((r) => r.json());
  assert.deepEqual([meRead.canWrite, meRead.canOperate], [false, false]);
  const readWrite = await fetch(`${baseUrl}/dashboard/groups`, { method: 'POST', headers: { Cookie: readCookie } });
  assert.equal(readWrite.status, 403);
  const readSwitch = await fetch(`${baseUrl}/messen-schalten/actor/1/switch/1`, { method: 'POST', headers: { Cookie: readCookie } });
  assert.equal(readSwitch.status, 403);
  const readMode = await fetch(`${baseUrl}/wallbox/box/1/mode/2`, { method: 'POST', headers: { Cookie: readCookie } });
  assert.equal(readMode.status, 403);
  const readHidden = await fetch(`${baseUrl}/photovoltaik`, { headers: { Cookie: readCookie }, redirect: 'manual' });
  assert.equal(readHidden.status, 302);

  // Bediener: darf schalten, nicht schreiben.
  const opCookie = await loginAs(baseUrl, operator.id, 'op');
  const opSwitch = await fetch(`${baseUrl}/messen-schalten/actor/1/switch/1`, { method: 'POST', headers: { Cookie: opCookie } });
  assert.equal(opSwitch.status, 200);
  // Wallbox-Lademodus ist ein Bedienelement und für „Bedienen" erlaubt.
  const opMode = await fetch(`${baseUrl}/wallbox/box/1/mode/2`, { method: 'POST', headers: { Cookie: opCookie } });
  assert.equal(opMode.status, 200);
  const opWrite = await fetch(`${baseUrl}/dashboard/groups`, { method: 'POST', headers: { Cookie: opCookie } });
  assert.equal(opWrite.status, 403);

  // Admin: darf alles.
  const adminCookie = await loginAs(baseUrl, admin.id, 'admin');
  const adminWrite = await fetch(`${baseUrl}/dashboard/groups`, { method: 'POST', headers: { Cookie: adminCookie } });
  assert.equal(adminWrite.status, 200);

  server.close();
  db.close();
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* egal */
  }
});
