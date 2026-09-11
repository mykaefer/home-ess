'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderLayout } = require('../src/views/layout');

test('Hauptnavigation scrollt getrennt vom festen Desktop- und Mobil-Fußblock', () => {
  const html = renderLayout({ title: 'Navigation', activePath: '/dashboard', body: '<p>Test</p>' });
  const desktopNav = html.indexOf('<div class="sidebar-nav">');
  const desktopFoot = html.indexOf('<div class="sidebar-footer">');
  const mobileNav = html.indexOf('<nav class="mobile-nav-links">');
  const mobileFoot = html.indexOf('<div class="mobile-nav-foot">');
  const mobileSettings = html.indexOf('href="/settings"', mobileFoot);

  assert.ok(desktopNav >= 0 && desktopFoot > desktopNav);
  assert.ok(mobileNav >= 0 && mobileFoot > mobileNav);
  assert.ok(mobileSettings > mobileFoot, 'Einstellungen müssen zum festen mobilen Fußblock gehören');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.sidebar-nav\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.sidebar-footer\s*\{[^}]*flex:\s*0 0 auto;[^}]*background:/s);
  assert.match(css, /\.mobile-nav-links\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.mobile-nav-foot\s*\{[^}]*flex:\s*0 0 auto;[^}]*background:/s);
  assert.match(css, /\.sidebar-nav::\-webkit-scrollbar-thumb/);
  assert.match(css, /\.mobile-nav-links::\-webkit-scrollbar-thumb/);
  assert.match(css, /scrollbar-color:\s*#60756d\s+var\(--color-shell\)/);
  assert.match(css, /::\-webkit-scrollbar-button[^}]*display:\s*none;/s);
});

// Die Modulseiten bilden unterhalb der Kernseiten einen eigenen Navigationsblock.
// Innerhalb dieses Blocks – und in der Modulverwaltung – stehen sie
// alphanumerisch aufsteigend.
test('Module und ihre Menüeinträge stehen alphanumerisch aufsteigend', async () => {
  const sqlite3 = require('sqlite3').verbose();
  const modules = require('../src/modules');
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.run(
    'CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)',
    (error) => (error ? reject(error) : resolve())
  ));

  const labels = modules.getRegistry().map((entry) => entry.label);
  assert.deepEqual(labels, [...labels].sort((left, right) => left.localeCompare(right, 'de', { numeric: true })));

  for (const key of ['wallbox', 'heimkino', 'pool']) await modules.setEnabled(db, key, true);
  assert.deepEqual(modules.getEnabledNavItems().map((item) => item.label), ['Heimkino', 'Poolsteuerung', 'Wallbox']);

  const html = renderLayout({ title: 'Navigation', activePath: '/dashboard', body: '<p>Test</p>' });
  const core = html.indexOf('href="/output"');
  const heimkino = html.indexOf('href="/heimkino"');
  const pool = html.indexOf('href="/pool"');
  const wallbox = html.indexOf('href="/wallbox"');
  assert.ok(core < heimkino && heimkino < pool && pool < wallbox);

  for (const key of ['wallbox', 'heimkino', 'pool']) await modules.setEnabled(db, key, false);
  await new Promise((resolve) => db.close(resolve));
});

// Die mobile Tab-Bar führt die fünf Einstiegsseiten. Stromverbrauch und
// Photovoltaik sind nicht dabei — sie hängen an der Energieseite, die sich auf
// ihren Unterseiten mitmarkiert.
test('Mobile Tab-Bar führt Dashboard, Energie, Prognose, Messen und Wetter', () => {
  const html = renderLayout({ title: 'Navigation', activePath: '/dashboard', body: '<p>Test</p>' });
  const tabbar = html.slice(html.indexOf('<nav class="mobile-tabbar"'), html.indexOf('</nav>', html.indexOf('<nav class="mobile-tabbar"')));
  const paths = [...tabbar.matchAll(/class="mobile-tab[^"]*" href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(paths, ['/dashboard', '/energie', '/prognose', '/messen-schalten', '/wetter']);
});

// Ist Heizung & Klima aktiv, belegt das Modul den vierten Tab-Platz; Messen +
// Schalten bleibt über das Menü-Sheet erreichbar.
test('Der Heizungs-Tab verdrängt Messen, sobald das Modul aktiv ist', async () => {
  const sqlite3 = require('sqlite3').verbose();
  const modules = require('../src/modules');
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.run(
    'CREATE TABLE modules (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)',
    (error) => (error ? reject(error) : resolve())
  ));
  await modules.setEnabled(db, 'heizung', true);

  const html = renderLayout({ title: 'Navigation', activePath: '/heizung', body: '<p>Test</p>' });
  const tabbar = html.slice(html.indexOf('<nav class="mobile-tabbar"'), html.indexOf('</nav>', html.indexOf('<nav class="mobile-tabbar"')));
  const paths = [...tabbar.matchAll(/class="mobile-tab[^"]*" href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(paths, ['/dashboard', '/energie', '/prognose', '/heizung', '/wetter']);
  assert.match(tabbar, /class="mobile-tab active" href="\/heizung"/);

  // Unterseiten des Moduls markieren den Tab ebenfalls.
  const raum = renderLayout({ title: 'Navigation', activePath: '/heizung/zentrale', body: '<p>Test</p>' });
  assert.match(raum, /class="mobile-tab active" href="\/heizung"/);

  await modules.setEnabled(db, 'heizung', false);
  await new Promise((resolve) => db.close(resolve));
});

test('Der Energie-Tab bleibt auf Stromverbrauch und Photovoltaik markiert', () => {
  for (const activePath of ['/energie', '/stromverbrauch', '/photovoltaik', '/batterie']) {
    const html = renderLayout({ title: 'Navigation', activePath, body: '<p>Test</p>' });
    assert.match(html, /class="mobile-tab active" href="\/energie"/, `Energie-Tab fehlt auf ${activePath}`);
  }
  // Unterseiten markieren ihren Hauptpunkt ebenfalls.
  const energiefluss = renderLayout({ title: 'Navigation', activePath: '/messen-schalten/energiefluss', body: '<p>Test</p>' });
  assert.match(energiefluss, /class="mobile-tab active" href="\/messen-schalten"/);
});

// Die Energie-Übersicht darf auf dem Telefon nicht breiter werden als der
// Bildschirm: die Mindestbreite aus dem 720px-Layer wird zurückgenommen.
test('Die Übersichtstabelle der Energieseite bricht mobil um statt zu scrollen', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const reset = css.search(/\.energie-overview--flat \.energy-overview-head,\s*\.energie-overview--flat \.energy-overview-row \{[^}]*min-width:\s*0;/s);
  const scrollWidth = css.search(/\.energie-overview--flat \.energy-overview-head,\s*\.energie-overview--flat \.energy-overview-row \{[^}]*min-width:\s*620px;/s);
  assert.ok(reset >= 0, 'Die Mindestbreite muss im Mobil-Layer zurückgenommen werden');
  assert.ok(scrollWidth >= 0 && scrollWidth < reset, 'Die Rücknahme muss hinter der Regel des 720px-Layers stehen');
  assert.match(css.slice(reset), /\.energie-overview--flat \.energy-overview-row \{[^}]*grid-template-columns:\s*repeat\(2,/s);
});
