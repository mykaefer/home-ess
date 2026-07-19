'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { remoteAccessPanel } = require('../src/views/remote-access');
const { NAV } = require('../src/views/layout');

test('Panel: Body + Script getrennt, Pairing-Panel vorhanden', () => {
  const { body, script } = remoteAccessPanel();
  assert.ok(body.includes('id="ra-panel"'));
  assert.ok(body.includes('Smartphone koppeln'));
  assert.ok(typeof script === 'string' && script.length > 0);
});

test('Panel: Live-Region und aria-busy für Barrierefreiheit', () => {
  const { body } = remoteAccessPanel();
  assert.ok(body.includes('role="status"'));
  assert.ok(body.includes('aria-live="polite"'));
  assert.ok(body.includes('aria-busy'));
});

test('Panel: QR-Bild mit zugänglichem Alternativtext, ohne CSS-Filter', () => {
  const { script } = remoteAccessPanel();
  assert.ok(script.includes('QR-Code zum Koppeln der homeESS-App'));
  assert.ok(script.includes("'data:image/png;base64,'"));
  assert.ok(!script.includes('filter:'), 'keine CSS-Filter auf dem QR');
});

test('Panel: sichere Formulierungen, kein „Fernzugriff aktiviert"', () => {
  const { body, script } = remoteAccessPanel();
  const html = body + script;
  assert.ok(html.includes('Smartphone koppeln'));
  assert.ok(html.includes('Warte auf Smartphone'));
  assert.ok(!html.includes('Fernzugriff aktiviert'));
  assert.ok(body.includes('gewährt allein noch'), 'Hinweis: kein Zugriff durch Erstellung');
});

test('Panel: Polling gegen den lokalen Endpunkt, nie direkt gegen den Relay', () => {
  const { script } = remoteAccessPanel();
  assert.ok(script.includes("fetch('/api/remote-access/pairing'"));
  assert.ok(!script.includes('essrelay'), 'keine direkte Relay-URL im Frontend');
  assert.ok(!script.includes('Authorization'), 'kein Authorization-Header im Frontend');
});

test('Panel: CSRF-Header wird bei verändernden Aufrufen gesendet', () => {
  const { script } = remoteAccessPanel();
  assert.ok(script.includes("'X-HomeESS-Request': '1'"));
});

test('Panel: Countdown-Element und Polling-Stopp-Hooks vorhanden', () => {
  const { script } = remoteAccessPanel();
  assert.ok(script.includes('ra-countdown'));
  assert.ok(script.includes('beforeunload'));
  assert.ok(script.includes('visibilitychange'));
});

test('Panel: Geräte-Remove-Timeout räumt den Pending-Zustand wieder ab', () => {
  const { script } = remoteAccessPanel();
  assert.ok(script.includes("fetch('/api/remote-access/devices/remove'"));
  assert.ok(script.includes('delete removing[d.deviceId];'));
  assert.ok(script.includes('removeErrors[d.deviceId] = removeErrorText'));
});

test('Navigation: Fernzugriff/Module sind in die Einstellungen integriert', () => {
  // Kein eigener Menüpunkt mehr für Fernzugriff/Module – nur noch Einstellungen
  // im Footer.
  assert.ok(!NAV.find((n) => n.path === '/remote-access'), 'kein Fernzugriff-Menüpunkt');
  assert.ok(!NAV.find((n) => n.path === '/module'), 'kein Module-Menüpunkt');
  const settings = NAV.find((n) => n.path === '/settings');
  assert.ok(settings && settings.section === 'footer', 'Einstellungen im Footer');
});
