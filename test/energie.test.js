'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-energie-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const energieRoutes = require('../src/routes/energie');
const { renderLayout, NAV } = require('../src/views/layout');
const { fullAccess, runWithAccess, PAGE_KEYS, pageForPath } = require('../src/auth/access');
const modules = require('../src/modules');
const { saveBatterieConfig } = require('../src/batterie/config');

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
  // Ohne konfigurierte Topics zeigt der Batterie-Abschnitt nur seinen Hinweis;
  // fuer die Kennzahlen wird deshalb eine Minimalkonfiguration hinterlegt.
  await new Promise((resolve, reject) => {
    saveBatterieConfig(db, { socTopic: 'battery.0.soc', powerTopic: 'battery.0.power', minSoc: 20, capacityAh: 200 },
      (err) => (err ? reject(err) : resolve()));
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(energieRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  if (db) db.close();
});

test('GET /energie fasst Photovoltaik, Stromverbrauch, Batterie und Prognose auf einer Seite zusammen', async () => {
  const html = await fetch(`${baseUrl}/energie`).then((res) => res.text());
  assert.match(html, /<h1>Energie<\/h1>/);
  // Jeder Abschnitt trägt einen Sprung auf die zugehörige Detailseite.
  assert.match(html, /class="energie-section-title" href="\/photovoltaik">Photovoltaik/);
  assert.match(html, /class="energie-section-title" href="\/stromverbrauch">Stromverbrauch/);
  assert.match(html, /class="energie-section-title" href="\/batterie">Batterie/);
  assert.match(html, /class="energie-section-title" href="\/prognose">Prognose/);
  // Kennzahlen aus allen drei Bereichen.
  assert.match(html, /id="en-pv-today"/);
  assert.match(html, /id="en-eigenverbrauch-current"/);
  assert.match(html, /id="en-netzbezug-year"/);
  assert.match(html, /id="en-bat-soc"/);
  // Prognose: Ampelchip plus die Restwerte des laufenden Tages.
  assert.match(html, /id="en-prog-status"/);
  assert.match(html, /id="en-prog-pv"/);
  assert.match(html, /id="en-prog-grid"/);
});

test('GET /energie/data liefert die Kennzahlen als JSON für die Live-Aktualisierung', async () => {
  const data = await fetch(`${baseUrl}/energie/data`).then((res) => res.json());
  assert.ok(data.photovoltaik.formatted.today.endsWith('kWh'));
  assert.ok(data.strom.formatted.netzbezugPower.endsWith('W'));
  assert.ok(data.batterie.formatted.soc.endsWith('%'));
  assert.equal(typeof data.gridControl.enabled, 'boolean');
  assert.equal(typeof data.prognose.available, 'boolean');
  if (data.prognose.available) {
    assert.ok(data.prognose.status.label);
    assert.ok(data.prognose.formatted.socEnd.endsWith('%'));
  }
});

test('Grid-Control erscheint nur bei aktiviertem Modul im Energie-Abschnitt', async () => {
  await modules.setEnabled(db, 'grid-control', true);
  const withModule = await fetch(`${baseUrl}/energie`).then((res) => res.text());
  assert.match(withModule, /class="energie-section-title" href="\/grid-control">Grid-Control/);

  await modules.setEnabled(db, 'grid-control', false);
  const withoutModule = await fetch(`${baseUrl}/energie`).then((res) => res.text());
  assert.ok(!withoutModule.includes('href="/grid-control"'));
});

test('Energie steht an zweiter Stelle der Navigation; die Energieseiten sind Unterpunkte', () => {
  const html = renderLayout({ activePath: '/energie' });
  const dashboard = html.indexOf('href="/dashboard"');
  const energie = html.indexOf('href="/energie"');
  const messen = html.indexOf('href="/messen-schalten"');
  assert.ok(dashboard < energie && energie < messen, 'Energie folgt direkt auf das Dashboard');

  // Stromverbrauch, Photovoltaik und Batterie hängen als Untermenü an Energie.
  const group = html.slice(energie, html.indexOf('</div>', html.indexOf('nav-subnav', energie)));
  for (const path of ['/stromverbrauch', '/photovoltaik', '/batterie', '/prognose']) {
    assert.ok(group.includes(`href="${path}"`), `${path} ist Unterpunkt von Energie`);
  }
  // Prognose ist kein eigener Hauptpunkt mehr: der Link steht nur im Untermenü
  // (Seitenmenue + mobiles Menue-Sheet) und in der mobilen Tab-Leiste.
  assert.ok(!NAV.some((item) => item.path === '/prognose'), 'Prognose ist kein Hauptpunkt der Navigation');
});

test('Grid-Control wandert bei aktivem Modul unter Energie statt in den Modulblock', async () => {
  await modules.setEnabled(db, 'grid-control', true);
  const html = renderLayout({ activePath: '/energie' });
  const subnavStart = html.indexOf('nav-subnav');
  const subnavEnd = html.indexOf('</div>', subnavStart);
  const subnav = html.slice(subnavStart, subnavEnd);
  assert.ok(subnav.includes('href="/grid-control"'), 'Grid-Control ist Unterpunkt von Energie');
  // Genau zwei Vorkommen: Seitenmenue und mobiles Menue-Sheet – kein
  // zusaetzlicher Eintrag im allgemeinen Modulblock.
  assert.equal(html.split('href="/grid-control"').length - 1, 2);
  await modules.setEnabled(db, 'grid-control', false);
});

test('Energie ist eine eigene Seite im Rechtemodell', () => {
  assert.ok(PAGE_KEYS.includes('energie'));
  assert.equal(pageForPath('/energie'), 'energie');
  assert.equal(pageForPath('/energie/data'), 'energie');
});

test('Gesperrte Energie-Seite: freigeschaltete Unterseiten bleiben als Hauptpunkte erreichbar', () => {
  const access = { ...fullAccess(), isAdmin: false, visiblePages: ['dashboard', 'photovoltaik'] };
  const html = runWithAccess(access, () => renderLayout({ activePath: '/dashboard' }));
  assert.ok(!html.includes('href="/energie"'), 'Energie bleibt ausgeblendet');
  assert.ok(html.includes('href="/photovoltaik"'), 'Photovoltaik rückt als Hauptpunkt nach');
  assert.ok(!html.includes('href="/batterie"'), 'gesperrte Unterseite bleibt aus dem Menü');
});
