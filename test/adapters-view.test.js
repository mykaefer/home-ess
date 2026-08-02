'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAdapters } = require('../src/views/adapters');

test('Adapterfilter merkt sich „Inaktive ausblenden" browserlokal', () => {
  const html = renderAdapters();
  assert.match(html, /id="hide-inactive-adapters" checked/);
  assert.match(html, /homeess\.adapters\.hideInactive\.v1/);
  assert.match(html, /localStorage\.getItem\(ADAPTER_HIDE_INACTIVE_KEY\)/);
  assert.match(html, /localStorage\.setItem\(ADAPTER_HIDE_INACTIVE_KEY, toggle\.checked \? '1' : '0'\)/);
  assert.ok(
    html.indexOf('restoreAdapterVisibilityPreference(hideInactiveToggle)') <
      html.lastIndexOf('syncAdapterVisibility();'),
    'gespeicherte Auswahl wird vor der ersten Sichtbarkeitsberechnung geladen'
  );
});
