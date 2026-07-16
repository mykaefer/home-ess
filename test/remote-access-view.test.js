'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const renderRemoteAccess = require('../src/views/remote-access');
const { NAV } = require('../src/views/layout');

test('View: Grundgerüst mit Titel und Panel', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes('<h1>Fernzugriff</h1>'));
  assert.ok(html.includes('id="ra-panel"'));
  assert.ok(html.includes('activePath') === false); // kein Leak interner Namen
});

test('View: Live-Region und aria-busy für Barrierefreiheit', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('aria-busy'));
});

test('View: QR-Bild mit zugänglichem Alternativtext, ohne CSS-Filter', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes('QR-Code zum Koppeln der homeESS-App'));
  assert.ok(html.includes("'data:image/png;base64,'"));
  assert.ok(!html.includes('filter:'), 'keine CSS-Filter auf dem QR');
});

test('View: sichere Formulierungen, kein „Fernzugriff aktiviert"', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes('Smartphone koppeln'));
  assert.ok(html.includes('Warte auf Smartphone'));
  assert.ok(!html.includes('Fernzugriff aktiviert'));
  assert.ok(html.includes('gewährt allein noch') , 'Hinweis: kein Zugriff durch Erstellung');
});

test('View: Polling gegen den lokalen Endpunkt, nie direkt gegen den Relay', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes("fetch('/api/remote-access/pairing'"));
  assert.ok(!html.includes('essrelay'), 'keine direkte Relay-URL im Frontend');
  assert.ok(!html.includes('Authorization'), 'kein Authorization-Header im Frontend');
});

test('View: CSRF-Header wird bei verändernden Aufrufen gesendet', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes("'X-HomeESS-Request': '1'"));
});

test('View: Countdown-Element und Polling-Stopp-Hooks vorhanden', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes('ra-countdown'));
  assert.ok(html.includes('beforeunload'));
  assert.ok(html.includes('visibilitychange'));
});

test('View: Geräte-Remove-Timeout räumt den Pending-Zustand wieder ab', () => {
  const html = renderRemoteAccess();
  assert.ok(html.includes("fetch('/api/remote-access/devices/remove'"));
  assert.ok(html.includes('delete removing[d.deviceId];'));
  assert.ok(html.includes('removeErrors[d.deviceId] = removeErrorText'));
});

test('Navigation: Fernzugriff-Eintrag im Footer', () => {
  const item = NAV.find((n) => n.path === '/remote-access');
  assert.ok(item, 'Nav-Eintrag existiert');
  assert.equal(item.label, 'Fernzugriff');
  assert.equal(item.section, 'footer');
});
