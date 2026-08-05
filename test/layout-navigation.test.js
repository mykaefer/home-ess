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
