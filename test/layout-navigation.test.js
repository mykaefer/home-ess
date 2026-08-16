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
