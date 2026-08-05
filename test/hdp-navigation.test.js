'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const navigation = require('../src/adapters/navigation');
const { renderLayout } = require('../src/views/layout');

test.afterEach(() => navigation.setInstances([]));

test('nur hDP-Instanzen werden alphanumerisch als Geräteverwaltungen einsortiert', () => {
  navigation.setInstances([
    { id: 20, adapterId: 'hdp', name: 'Etage 10' },
    { id: 99, adapterId: 'modbus', name: 'Fremder Adapter' },
    { id: 2, adapterId: 'hdp', name: 'Etage 2' },
    { id: 1, adapterId: 'hdp', name: 'Anlage' },
  ]);

  assert.deepEqual(navigation.getHdpNavItems(), [
    { path: '/adapter/instance/1/manage', label: 'Anlage', section: 'main' },
    { path: '/adapter/instance/2/manage', label: 'Etage 2', section: 'main' },
    { path: '/adapter/instance/20/manage', label: 'Etage 10', section: 'main' },
  ]);

  const html = renderLayout({ activePath: '/adapter/instance/2/manage' });
  const adapter = html.indexOf('href="/adapter"');
  const anlage = html.indexOf('href="/adapter/instance/1/manage"');
  const etage2 = html.indexOf('href="/adapter/instance/2/manage"');
  const etage10 = html.indexOf('href="/adapter/instance/20/manage"');
  const states = html.indexOf('href="/states"');

  assert.ok(adapter < anlage && anlage < etage2 && etage2 < etage10 && etage10 < states);
  assert.match(html, /href="\/adapter\/instance\/2\/manage" class="active">Etage 2<\/a>/);
  assert.doesNotMatch(html, /Fremder Adapter/);
});
