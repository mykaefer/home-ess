'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAdapters } = require('../src/views/adapters');
const access = require('../src/auth/access');

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

test('Adapterupload steht als schmale erste Kachel nur Administratoren zur Verfügung', () => {
  const html = renderAdapters({ registry: [{
    id: 'demo', name: 'Demo', prefix: 'demo', description: '', version: '1.0.0',
  }] });
  assert.match(html, /class="adapter-upload-card"/);
  assert.match(html, /accept="\.zip,application\/zip"/);
  assert.match(html, /fetch\('\/adapter\/upload'/);
  assert.ok(html.indexOf('adapter-upload-card') < html.indexOf('adapter-list'));

  const nonAdmin = access.runWithAccess({
    isAdmin: false, canWrite: true, canOperate: true, visiblePages: null,
  }, () => renderAdapters());
  assert.doesNotMatch(nonAdmin, /<section class="adapter-upload-card"|<form id="adapter-upload-form"/);
});

test('Adapterlöschen warnt ausdrücklich, verlangt die ID und blockiert vorhandene Instanzen', () => {
  const adapter = { id: 'demo', name: 'Demo', prefix: 'demo', description: '', version: '1.0.0' };
  let html = renderAdapters({ registry: [adapter] });
  assert.match(html, /data-delete-adapter/);
  assert.match(html, /Sicherheitswarnung:/);
  assert.match(html, /unwiderruflich/);
  assert.match(html, /adapter-delete-confirmation/);
  assert.match(html, /JSON\.stringify\(\{ confirmation:/);
  assert.match(html, /adapterDeleteInput\.value\.trim\(\)\.toLowerCase\(\) !== adapterDeleteId/);

  html = renderAdapters({
    registry: [adapter],
    instancesByAdapter: new Map([['demo', [{ id: 1, name: 'eins', enabled: false }]]]),
  });
  assert.match(html, /data-adapter-id="demo"[^>]* disabled title="Zuerst die vorhandene Instanz löschen"/);

  const nonAdmin = access.runWithAccess({
    isAdmin: false, canWrite: true, canOperate: true, visiblePages: null,
  }, () => renderAdapters({ registry: [adapter] }));
  assert.doesNotMatch(nonAdmin, /<button[^>]+data-delete-adapter|<dialog[^>]+adapter-delete-dialog/);
});

test('managementPage.asSettings führt den Einstellungsknopf in die Adapterverwaltung', () => {
  const adapter = {
    id: 'display-dashboard', name: 'Display-Dashboard', prefix: 'display-dashboard',
    description: '', version: '1.0.0',
    managementPage: { label: 'Dashboard-Verwaltung', asSettings: true },
  };
  const html = renderAdapters({
    registry: [adapter],
    instancesByAdapter: new Map([['display-dashboard', [{ id: 4, name: 'wohnzimmer', enabled: true }]]]),
  });
  assert.match(html, /<a href="\/adapter\/instance\/4\/manage" class="module-toggle-btn">Einstellungen<\/a>/);
  // Ohne zweiten Link: die Verwaltung IST die Einstellungsseite dieses Adapters.
  assert.doesNotMatch(html, />Dashboard-Verwaltung</);
  assert.doesNotMatch(html, /<a href="\/adapter\/instance\/4" class="module-toggle-btn">Einstellungen<\/a>/);
});

test('Ohne asSettings bleiben Einstellungen und Verwaltung getrennte Links', () => {
  const adapter = {
    id: 'mqttbroker', name: 'MQTT-Broker', prefix: 'mqttbroker', description: '', version: '1.0.0',
    managementPage: { label: 'Broker' },
  };
  const html = renderAdapters({
    registry: [adapter],
    instancesByAdapter: new Map([['mqttbroker', [{ id: 2, name: 'broker', enabled: true }]]]),
  });
  assert.match(html, /<a href="\/adapter\/instance\/2" class="module-toggle-btn">Einstellungen<\/a>/);
  assert.match(html, /<a href="\/adapter\/instance\/2\/manage" class="module-toggle-btn">Broker<\/a>/);
});

test('Kompakte Ansicht ist umschaltbar, browserlokal gespeichert und reduziert die Zeilen', () => {
  const html = renderAdapters({
    registry: [{ id: 'demo', name: 'Demo', prefix: 'demo', description: 'Kurzbeschreibung', version: '1.0.0' }],
    instancesByAdapter: new Map([['demo', [{ id: 1, name: 'eins', enabled: true }]]]),
  });
  assert.match(html, /<input type="checkbox" id="compact-adapters">/);
  assert.match(html, /homeess\.adapters\.compact\.v1/);
  assert.match(html, /localStorage\.setItem\(ADAPTER_COMPACT_KEY, compactToggle\.checked \? '1' : '0'\)/);
  assert.match(html, /classList\.toggle\('adapters-compact'/);
  // Beschreibung und Version stehen getrennt, damit kompakt nur Name/Prefix/Version bleibt.
  assert.match(html, /<span class="adapter-desc muted">Kurzbeschreibung ·<\/span>/);
  assert.match(html, /<span class="adapter-version muted">v1\.0\.0<\/span>/);
});

test('Jeder Adapter trägt in der Titelzeile einen Neustart-Knopf', () => {
  const adapter = { id: 'demo', name: 'Demo', prefix: 'demo', description: '', version: '1.0.0' };
  const html = renderAdapters({ registry: [adapter] });
  assert.match(html, /<form action="\/adapter\/demo\/restart" method="POST" class="adapter-restart-form">/);
  // Nur der Pfeil; die Beschriftung liefert der Tooltip beim Verweilen.
  assert.match(html, /class="module-toggle-btn adapter-restart-btn" title="Neu starten" aria-label="Adapter neu starten">↻</);
  assert.doesNotMatch(html, />↻ Neu starten</);
  // Er liegt außerhalb der Aktionsgruppe und damit in beiden Ansichten oben
  // rechts – auch dort, wo die kompakte Ansicht die Aktionen ausblendet.
  assert.ok(html.indexOf('adapter-restart-form') > html.indexOf('adapter-add-form'));
  assert.ok(html.indexOf('adapter-restart-form') < html.indexOf('adapter-rows'));
});

test('Instanzen ohne Adapterverzeichnis bleiben löschbar sichtbar', () => {
  const html = renderAdapters({
    registry: [],
    orphanedByAdapter: new Map([['weg', [{ id: 7, name: 'alt', enabled: true }]]]),
    statusById: { 7: { running: false, connected: false, detail: '' } },
  });
  assert.match(html, /class="adapter-block adapter-block--orphan"/);
  assert.match(html, /Adapterverzeichnis nicht mehr vorhanden/);
  assert.match(html, /action="\/adapter\/instance\/7\/disable"/);
  assert.match(html, /action="\/adapter\/instance\/7\/delete"/);
  // Der Statuspoller lässt diese Zeilen und den Block in Ruhe.
  assert.match(html, /data-instance="7" data-orphaned="1"/);
  assert.match(html, /\[data-instance="' \+ id \+ '"\]:not\(\[data-orphaned\]\)/);
  assert.match(html, /block\.classList\.contains\('adapter-block--orphan'\)/);
  // Ohne Manifest gibt es keine Einstellungs- oder Verwaltungsseite.
  assert.doesNotMatch(html, /href="\/adapter\/instance\/7/);

  // Ist kein Adapter verwaist, entsteht auch kein Block.
  assert.doesNotMatch(renderAdapters({ registry: [] }), /class="adapter-block adapter-block--orphan"/);
});
