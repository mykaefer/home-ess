'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const express = require('express');
const { runWithAccess, fullAccess } = require('../src/auth/access');
const { authorize, requireAuth } = require('../src/auth/session');
const { sharingMiddleware } = require('../src/page-sharing/middleware');
const sharingRoutes = require('../src/routes/page-sharing');
const store = require('../src/page-sharing/store');
const { isPage, allows } = require('../src/page-sharing/policy');
const { renderLayout } = require('../src/views/layout');

let db, server, origin;
let writes = 0;
const run = (sql) => new Promise((resolve, reject) => db.run(sql, err => err ? reject(err) : resolve()));

test.before(async () => {
  db = new sqlite3.Database(':memory:');
  await run(store.SCHEMA);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-test-user']) {
      req.session = { id: 'test' };
      req.access = fullAccess();
      if (req.headers['x-test-user'] === 'reader') req.access = { ...req.access, isAdmin: false, canWrite: false, canOperate: false, role: 'read' };
    }
    next();
  });
  app.use(sharingMiddleware(db));
  app.use(authorize());
  app.use(sharingRoutes(db));
  app.use(require('../src/routes/logs')());
  app.use(require('../src/routes/rollladen')(db));
  app.get('/batterie', requireAuth, (req, res) => res.send(renderLayout({
    title: 'Batterie', activePath: '/batterie',
    body: '<h1>Batterie</h1><form method="post" action="/batterie/min-soc"><input name="minSoc"><button>Speichern</button></form><a href="/settings">Einstellungen</a>',
    script: "fetch('/batterie/data');",
  })));
  app.get('/wallbox', requireAuth, (req, res) => res.redirect('/module'));
  app.get('/batterie/data', requireAuth, (req, res) => res.json({ soc: 42, write: req.access.canWrite }));
  app.post('/batterie/min-soc', requireAuth, (req, res) => { writes++; res.redirect('/batterie?ok=1'); });
  app.post('/settings', requireAuth, (req, res) => { writes++; res.send('settings'); });
  server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.close(resolve));
});

async function save(path, mode, user = 'writer', header = true) {
  const response = await fetch(`${origin}/page-sharing`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user,
      ...(header ? { 'X-HomeESS-Request': 'page-sharing' } : {}) },
    body: JSON.stringify({ path, mode }),
  });
  return { response, data: await response.json() };
}

test('Freigaben begrenzen Seiten, Unterseiten und Betriebsaktionen', () => {
  assert.equal(isPage('/settings'), false);
  assert.equal(isPage('/remote-access'), false);
  assert.equal(isPage('/batterie/data'), false);
  assert.equal(isPage('/heizung/raum/12'), true);
  assert.equal(isPage('/states/custom'), true);
  assert.equal(allows({ path: '/batterie', mode: 'read' }, '/batterie/min-soc', 'POST'), false);
  assert.equal(allows({ path: '/batterie', mode: 'write' }, '/settings', 'POST'), false);
  assert.equal(allows({ path: '/states', mode: 'write' }, '/states/custom', 'GET'), false);
  assert.equal(allows({ path: '/states', mode: 'write' }, '/states/custom/state', 'POST'), false);
  assert.equal(allows({ path: '/heizung', mode: 'write' }, '/heizung/raum/12', 'GET'), false);
  assert.equal(allows({ path: '/heizung', mode: 'write' }, '/heizung/raum/12/soll', 'POST'), true);
  assert.equal(allows({ path: '/heizung/raum/12', mode: 'write' }, '/heizung/raum/13/soll', 'POST'), false);
  assert.equal(allows({ path: '/batterie', mode: 'read' }, '/live/events', 'GET'), false);
  assert.equal(allows({ path: '/batterie', mode: 'read' }, '/states/catalog', 'GET'), false);
  assert.equal(allows({ path: '/batterie', mode: 'write' }, '/states/value', 'POST'), false);
});

test('Lesezugriff läuft ohne Login und ohne App-Hülle, Änderungen werden serverseitig gesperrt', async () => {
  const saved = await save('/batterie', 'read');
  assert.equal(saved.response.status, 200);
  assert.match(saved.data.url, /^\/share\/[a-f0-9]{64}$/);
  const response = await fetch(origin + saved.data.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /access-read/);
  assert.doesNotMatch(html, /class="sidebar"|dashboard-header|mobile-tabbar|page-share-button|update-status/);
  assert.ok(html.includes(`action="${saved.data.url}/batterie/min-soc?theme=hell"`));
  assert.match(html, new RegExp(`fetch\\('${saved.data.url}/batterie/data'\\)`));
  assert.doesNotMatch(html, /href="\/settings"/);
  const data = await fetch(origin + saved.data.url + '/batterie/data');
  assert.deepEqual(await data.json(), { soc: 42, write: false });
  const before = writes;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await fetch(origin + saved.data.url + '/batterie/min-soc', { method })).status, 403);
  }
  // Eine vorhandene Admin-Session darf den öffentlichen Lesezugriff nicht erweitern.
  assert.equal((await fetch(origin + saved.data.url + '/batterie/min-soc', { method: 'POST', headers: { 'X-Test-User': 'writer' } })).status, 403);
  assert.equal(writes, before);
});

test('Schreibzugriff bedient dieselbe Seite und hält Weiterleitungen im Freigabekontext', async () => {
  const previous = await store.forPath(db, '/batterie');
  const saved = await save('/batterie', 'write');
  assert.equal(saved.data.url, `/share/${previous.token}`);
  const response = await fetch(origin + saved.data.url + '/batterie/min-soc', { method: 'POST', redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), saved.data.url + '/batterie?ok=1&theme=hell');
  assert.equal(writes, 1);
  for (const path of ['/settings', '/dashboard', '/page-sharing', '/login', '/api/remote-access/pairing', '/database/series', '/live/events']) {
    assert.equal((await fetch(origin + saved.data.url + path)).status, 403, path);
    assert.equal((await fetch(origin + saved.data.url + path, { method: 'POST' })).status, 403, path);
  }
  assert.equal(writes, 1);
});

test('Jede Freigabe liefert zwei Theme-URLs mit denselben Rechten und dauerhaftem Theme', async () => {
  for (const mode of ['read', 'write']) {
    const saved = await save('/batterie', mode);
    assert.deepEqual(saved.data.urls, {
      hell: saved.data.url + '?theme=hell', dunkel: saved.data.url + '?theme=dunkel',
    });
    for (const theme of ['hell', 'dunkel']) {
      const response = await fetch(origin + saved.data.urls[theme], { headers: { 'X-Test-User': 'writer' } });
      assert.equal(response.status, 200);
      assert.equal(new URL(response.url).searchParams.get('theme'), theme);
      const html = await response.text();
      assert.match(html, new RegExp(`data-theme="${theme}"`));
      assert.match(html, new RegExp(`access-${mode}`));
      assert.equal(/class="[^"\n]*theme-dark/.test(html), theme === 'dunkel');
      assert.ok(html.includes(`action="${saved.data.url}/batterie/min-soc?theme=${theme}"`));
      if (mode === 'write') {
        const result = await fetch(`${origin}${saved.data.url}/batterie/min-soc?theme=${theme}`, { method: 'POST', redirect: 'manual' });
        assert.equal(result.status, 302);
        assert.equal(result.headers.get('location'), `${saved.data.url}/batterie?ok=1&theme=${theme}`);
      } else {
        assert.equal((await fetch(`${origin}${saved.data.url}/batterie/min-soc?theme=${theme}`, { method: 'POST' })).status, 403);
      }
    }
  }
  const active = await store.forPath(db, '/batterie');
  const invalid = await fetch(`${origin}/share/${active.token}?theme=unknown`);
  assert.match(await invalid.text(), /data-theme="hell"/);
});

test('Widerruf und erneute Freigabe machen den alten Link dauerhaft ungültig', async () => {
  const before = await store.forPath(db, '/batterie');
  const revoked = await save('/batterie', 'none');
  assert.equal(revoked.data.url, null);
  assert.equal(revoked.data.urls, null);
  for (const theme of ['hell', 'dunkel']) {
    assert.equal((await fetch(`${origin}/share/${before.token}?theme=${theme}`)).status, 404);
  }
  assert.equal((await fetch(`${origin}/share/${before.token}`)).status, 404);
  const after = await save('/batterie', 'read');
  assert.notEqual(after.data.url, `/share/${before.token}`);
  assert.equal((await fetch(`${origin}/share/${before.token}/batterie/data`)).status, 404);
});

test('Nur angemeldete Schreibberechtigte können freigeben; Einstellungen und falsche Modi werden abgelehnt', async () => {
  assert.equal((await save('/batterie', 'write', 'reader')).response.status, 403);
  assert.equal((await save('/settings', 'write')).response.status, 400);
  assert.equal((await save('/api/remote-access', 'read')).response.status, 400);
  assert.equal((await save('/batterie', 'admin')).response.status, 400);
  assert.equal((await save('/batterie', 'write', 'writer', false)).response.status, 403);
  assert.equal((await fetch(origin + '/page-sharing?path=/batterie', { headers: { Accept: 'application/json' } })).status, 401);
});

test('Freigegebene Logs und Rollladen-Livedaten benötigen keine Login-Session', async () => {
  const logs = await save('/logs', 'read');
  const response = await fetch(origin + logs.data.url + '/logs/daten');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).entries));
  const shutters = await save('/rollladen', 'read');
  // Ohne aktiviertes Modul bleibt die bestehende Modulsperre erhalten; die
  // JSON-Anmeldung darf den gültigen Link jedoch nicht mit 401 abweisen.
  const status = await fetch(origin + shutters.data.url + '/rollladen/status');
  assert.equal(status.status, 403);
  assert.equal((await status.json()).error, 'Modul nicht aktiviert.');
});

test('Ein deaktiviertes Modul erzeugt keine Weiterleitungsschleife', async () => {
  const shared = await save('/wallbox', 'read');
  assert.equal((await fetch(origin + shared.data.url)).status, 404);
});

test('Normale Seiten erhalten den Freigabedialog, Einstellungen bleiben ausgenommen', () => {
  const html = renderLayout({ title: 'Batterie', activePath: '/batterie', body: '<h1>Batterie</h1>' });
  assert.match(html, /<h1>Batterie<\/h1><button[^>]+page-share-button/);
  assert.match(html, /value="none"/);
  assert.match(html, /value="read"/);
  assert.match(html, /value="write"/);
  assert.match(html, /id="page-share-copy"/);
  assert.match(html, /id="page-share-copy-dark"/);
  assert.match(html, /id="page-share-url-dark"/);
  assert.doesNotMatch(renderLayout({ title: 'Einstellungen', activePath: '/settings', body: '<h1>Einstellungen</h1>' }), /page-share-button|page-share-dialog/);
  const room = runWithAccess({ ...fullAccess(), pagePath: '/heizung/raum/12' }, () => renderLayout({
    activePath: '/heizung', body: '<h1>Wohnzimmer</h1>',
  }));
  assert.match(room, /data-share-path="\/heizung\/raum\/12"/);
});
