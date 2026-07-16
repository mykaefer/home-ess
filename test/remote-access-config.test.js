'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRelayBaseUrl,
  resolveInstanceName,
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_INSTANCE_NAME,
} = require('../src/remote-access/relay-config');

test('Relay-Basis-URL: gültige https-URL wird akzeptiert', () => {
  assert.equal(resolveRelayBaseUrl('https://relay.example.net'), 'https://relay.example.net');
});

test('Relay-Basis-URL: leer/undefined verwendet den sicheren Default', () => {
  assert.equal(resolveRelayBaseUrl(undefined), DEFAULT_RELAY_BASE_URL);
  assert.equal(resolveRelayBaseUrl(''), DEFAULT_RELAY_BASE_URL);
  assert.equal(resolveRelayBaseUrl('   '), DEFAULT_RELAY_BASE_URL);
});

test('Relay-Basis-URL: HTTP wird abgelehnt', () => {
  assert.throws(() => resolveRelayBaseUrl('http://relay.example.net'), /https/);
});

test('Relay-Basis-URL: Query wird abgelehnt', () => {
  assert.throws(() => resolveRelayBaseUrl('https://relay.example.net/?a=1'), /Query/);
});

test('Relay-Basis-URL: Fragment wird abgelehnt', () => {
  assert.throws(() => resolveRelayBaseUrl('https://relay.example.net/#x'), /Fragment/);
});

test('Relay-Basis-URL: Zugangsdaten werden abgelehnt', () => {
  assert.throws(() => resolveRelayBaseUrl('https://user:pass@relay.example.net'), /Zugangsdaten/);
});

test('Relay-Basis-URL: ungültige URL wird abgelehnt', () => {
  assert.throws(() => resolveRelayBaseUrl('not a url'), /gültige URL/);
});

test('Relay-Basis-URL: übermäßige Länge wird abgelehnt', () => {
  assert.throws(() => resolveRelayBaseUrl('https://relay.example.net/' + 'a'.repeat(600)), /zu lang/);
});

test('Relay-Basis-URL: abschließender Slash wird normalisiert', () => {
  assert.equal(resolveRelayBaseUrl('https://relay.example.net/'), 'https://relay.example.net');
  assert.equal(resolveRelayBaseUrl('https://relay.example.net/relay/'), 'https://relay.example.net/relay');
});

test('Instanzname: Default, wenn leer', () => {
  assert.equal(resolveInstanceName(''), DEFAULT_INSTANCE_NAME);
  assert.equal(resolveInstanceName(undefined), DEFAULT_INSTANCE_NAME);
  assert.equal(resolveInstanceName('  Keller  '), 'Keller');
});
