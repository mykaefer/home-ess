'use strict';

const path = require('path');
const { resolveRelayBaseUrl, resolveRelayWsUrl, resolveInstanceName } = require('./remote-access/relay-config');

// Zentrale Konstanten der Anwendung. Eigene Datei, damit Werte an einer
// Stelle anpassbar sind und nicht über die Module verstreut liegen.
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

// Relay-Basis-URL beim Start streng validieren (SSRF-Schutz durch feste,
// serverseitig festgelegte URL). Ein ungültiger Wert soll früh scheitern.
const RELAY_BASE_URL = resolveRelayBaseUrl(process.env.ESS_RELAY_BASE_URL);
// WebSocket-URL des Origin-Endpunkts (Abschnitt 22/32). Ableitbar aus der
// Basis-URL oder per ESS_RELAY_WS_URL überschreibbar.
const RELAY_WS_URL = resolveRelayWsUrl(process.env.ESS_RELAY_WS_URL, RELAY_BASE_URL);
const INSTANCE_NAME = resolveInstanceName(process.env.HOME_ESS_INSTANCE_NAME);
// Transport-Protokollversion (Draft 0.1).
const RELAY_PROTOCOL_VERSION = '0.1';
// Verzeichnis der dauerhaften Instanzidentität (privater Schlüssel + Metadaten).
// Standard: <data>/identity (bereits per .gitignore ausgeschlossen). Per
// HOME_ESS_IDENTITY_DIR überschreibbar (z. B. /var/lib/home-ess/identity).
const IDENTITY_DIR = process.env.HOME_ESS_IDENTITY_DIR || path.join(DATA_DIR, 'identity');
// Origin-WebSocket-Autostart nach Provisioning. Standard an; per
// ESS_RELAY_CONNECTION_DISABLED=1 deaktivierbar (nur Identität/Pairing, kein WS).
const RELAY_CONNECTION_ENABLED = process.env.ESS_RELAY_CONNECTION_DISABLED !== '1';

module.exports = {
  ROOT_DIR,
  PORT: Number(process.env.PORT) || 3000,

  DATA_DIR,
  // Pfad zur SQLite-DB; per HOME_ESS_DB überschreibbar (z. B. für Tests).
  DB_PATH: process.env.HOME_ESS_DB || path.join(ROOT_DIR, 'data', 'app.db'),
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),
  // Verzeichnis mit den Adapter-Unterordnern (jeder Adapter ein Unterordner mit
  // adapter.json). Per HOME_ESS_ADAPTER_DIR überschreibbar (z. B. für Tests).
  ADAPTER_DIR: process.env.HOME_ESS_ADAPTER_DIR || path.join(ROOT_DIR, 'adapter'),

  // Standard-Zugangsdaten beim ersten Start (wird gehasht abgelegt).
  DEFAULT_PASSWORD: 'admin',

  // Session-/Cookie-Konfiguration.
  SESSION_COOKIE: 'ess_sid',
  // "Passwort merken" angehakt -> persistentes Cookie über 30 Tage.
  SESSION_REMEMBER_MS: 30 * 24 * 60 * 60 * 1000,
  // Ohne "merken" -> Session-Cookie, serverseitig nach 12 h ungültig.
  SESSION_DEFAULT_MS: 12 * 60 * 60 * 1000,

  // Fernzugriff / Pairing: serverseitig festgelegte Relay-Basis-URL. Wird nie
  // aus einem Browser-Request übernommen (SSRF-Schutz). Per ESS_RELAY_BASE_URL
  // überschreibbar; Default ist der produktive essrelay.
  RELAY_BASE_URL,
  // WebSocket-URL des Origin-Endpunkts am Relay (aus Basis-URL abgeleitet oder
  // per ESS_RELAY_WS_URL gesetzt).
  RELAY_WS_URL,
  // Transport-Protokollversion (Draft).
  RELAY_PROTOCOL_VERSION,
  // Verzeichnis der dauerhaften Instanzidentität.
  IDENTITY_DIR,
  // Autostart der Origin-WebSocket-Verbindung nach Provisioning.
  RELAY_CONNECTION_ENABLED,
  // Instanzname, den homeESS beim Erstellen einer Pairing-Session an den Relay
  // meldet. Per HOME_ESS_INSTANCE_NAME überschreibbar; Default "homeESS".
  INSTANCE_NAME,
};
