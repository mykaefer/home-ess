'use strict';

// Serverseitige Auflösung und strenge Validierung der Relay-Basis-URL.
//
// Die Relay-Basis-URL wird ausschließlich serverseitig festgelegt (Env-Variable
// ESS_RELAY_BASE_URL, mit sicherem Default). Sie darf niemals aus einem Browser-
// Request übernommen werden — das ist der zentrale SSRF-Schutz dieser Stufe:
// homeESS spricht immer nur mit genau diesem einen, fest konfigurierten Host.

// Sicherer Default — der produktive essrelay.
const DEFAULT_RELAY_BASE_URL = 'https://essrelay.mykaefer.net';

// Neutraler, stabiler Instanzname, falls keiner konfiguriert ist.
const DEFAULT_INSTANCE_NAME = 'homeESS';

// Obergrenze für die Länge der Basis-URL (Schutz vor absurden Werten).
const MAX_RELAY_URL_LENGTH = 512;

// Validiert und normalisiert eine Relay-Basis-URL. Wirft bei Regelverstoß.
// Regeln: absolute https://-URL, kein Benutzer/Passwort, kein Query, kein
// Fragment, sinnvolle Länge, abschließender Slash normalisiert.
function resolveRelayBaseUrl(raw) {
  const value = raw == null || String(raw).trim() === '' ? DEFAULT_RELAY_BASE_URL : String(raw).trim();

  if (value.length > MAX_RELAY_URL_LENGTH) {
    throw new Error('ESS_RELAY_BASE_URL ist zu lang.');
  }

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('ESS_RELAY_BASE_URL ist keine gültige URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('ESS_RELAY_BASE_URL muss https:// verwenden.');
  }
  if (url.username || url.password) {
    throw new Error('ESS_RELAY_BASE_URL darf keine Zugangsdaten enthalten.');
  }
  if (url.search) {
    throw new Error('ESS_RELAY_BASE_URL darf keinen Query enthalten.');
  }
  if (url.hash) {
    throw new Error('ESS_RELAY_BASE_URL darf kein Fragment enthalten.');
  }
  if (!url.hostname) {
    throw new Error('ESS_RELAY_BASE_URL benötigt einen Host.');
  }

  // Pfad beibehalten (z. B. /relay), aber abschließenden Slash entfernen, damit
  // beim Zusammensetzen der API-Pfade kein doppelter Slash entsteht.
  let pathname = url.pathname || '/';
  if (pathname !== '/' && pathname.endsWith('/')) {
    pathname = pathname.replace(/\/+$/, '');
  }
  const normalizedPath = pathname === '/' ? '' : pathname;

  return `${url.protocol}//${url.host}${normalizedPath}`;
}

// Default-Pfad des homeESS-Origin-WebSocket-Endpunkts am Relay. Die
// Transport-API (Abschnitt 22/32) legt keinen konkreten Pfad fest; er ist daher
// über ESS_RELAY_WS_URL überschreibbar und wird sonst aus der Basis-URL
// abgeleitet (https → wss). Beim Wechsel auf einen anderen Relay muss der Pfad
// ggf. angepasst werden.
const DEFAULT_WS_PATH = '/api/v1/ws/homeess';

// Löst die WebSocket-URL des Origin-Endpunkts auf. Bevorzugt einen explizit
// gesetzten Wert (muss wss:// sein), sonst wird sie aus der validierten
// Relay-Basis-URL abgeleitet.
function resolveRelayWsUrl(rawWsUrl, relayBaseUrl) {
  const explicit = rawWsUrl == null ? '' : String(rawWsUrl).trim();
  if (explicit) {
    let url;
    try {
      url = new URL(explicit);
    } catch (_) {
      throw new Error('ESS_RELAY_WS_URL ist keine gültige URL.');
    }
    if (url.protocol !== 'wss:') {
      throw new Error('ESS_RELAY_WS_URL muss wss:// verwenden.');
    }
    if (url.username || url.password) {
      throw new Error('ESS_RELAY_WS_URL darf keine Zugangsdaten enthalten.');
    }
    return url.toString();
  }
  // Aus der (bereits validierten) Basis-URL ableiten.
  const base = new URL(relayBaseUrl);
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return `wss://${base.host}${basePath}${DEFAULT_WS_PATH}`;
}

// Löst den Instanznamen auf: konfigurierter Wert oder neutraler Default.
function resolveInstanceName(raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return DEFAULT_INSTANCE_NAME;
  // Auf eine vernünftige Länge begrenzen; der Relay erhält den Namen im Body.
  return value.slice(0, 120);
}

module.exports = {
  resolveRelayBaseUrl,
  resolveRelayWsUrl,
  resolveInstanceName,
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_INSTANCE_NAME,
  DEFAULT_WS_PATH,
  MAX_RELAY_URL_LENGTH,
};
