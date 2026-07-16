'use strict';

// Prozessweiter Singleton-Wrapper um den Origin-WebSocket-Client. Hält genau
// EINE Verbindung je homeESS-Prozess (kein zweiter Relay-Client, kein separater
// Serverprozess). Die App initialisiert ihn beim Start; Routen lesen seinen
// Status und lösen (De-)Aktivierung aus; die Pairing-Orchestrierung startet ihn
// nach erfolgreichem `paired`.

const { createRelayConnection } = require('./relay-connection');
const config = require('../config');
const deviceStatus = require('./device-status');
const identityStore = require('./identity-store');
const { RemoteAccessError } = require('./errors');
const { log } = require('./redact');

let connection = null;
let enabled = false;

// Standard-Senke für validierte connection_status-Sichten: Laufzeitstatus
// aktualisieren (flüchtig) und den persistenten Merker lastKnownConnectedAt der
// aktuell verbundenen Geräte fortschreiben (fire-and-forget, nur bekannte Geräte).
function defaultOnConnectionStatus(view) {
  const accepted = deviceStatus.applyConnectionStatus(view);
  const entries = (Array.isArray(accepted) ? accepted : [])
    .filter((d) => d.connected && d.connectedAt)
    .map((d) => ({ deviceId: d.deviceId, connectedAt: d.connectedAt }));
  if (entries.length) {
    identityStore.updateDeviceLastConnected(entries).catch(() => {});
  }
}

// Standard-Senke für die autoritative Geräteliste (Abschnitt 41/43): zuerst den
// persistenten Bestand strikt abgleichen (Add/Update + Entfernung fehlender
// Geräte), danach den flüchtigen Runtime-Status auf genau diesen Bestand
// begrenzen. Online/offline kommt weiterhin nur aus connection_status.
function defaultOnLinkedDevices(snapshot) {
  identityStore.reconcileLinkedDevices(snapshot)
    .then((provisioning) => {
      if (!provisioning || snapshot.complete !== true || provisioning.linkedDevicesRevision !== snapshot.revision) return;
      deviceStatus.setAuthoritativeLinks({
        instanceId: provisioning.instanceId,
        revision: provisioning.linkedDevicesRevision,
        complete: true,
        devices: provisioning.devices,
      });
    })
    .catch(() => {});
}

function init(options = {}) {
  enabled = options.enabled !== false;
  connection = createRelayConnection({
    wsUrl: options.wsUrl,
    WebSocketImpl: options.WebSocketImpl,
    identityStore: options.identityStore,
    logger: options.logger || log,
    onConnectionStatus: options.onConnectionStatus || defaultOnConnectionStatus,
    onLinkedDevices: options.onLinkedDevices || defaultOnLinkedDevices,
    onDisconnected: options.onDisconnected || (() => deviceStatus.markRelayDisconnected()),
    removalTimeoutMs: options.removalTimeoutMs,
    localPort: options.localPort || config.PORT,
    localHost: options.localHost,
    requestImpl: options.requestImpl,
    tunnelRequestTimeoutMs: options.tunnelRequestTimeoutMs,
    tunnelIdleTimeoutMs: options.tunnelIdleTimeoutMs,
    tunnelMaxBufferedAmount: options.tunnelMaxBufferedAmount,
  });
  return connection;
}

// Wird nach erfolgreichem Provisioning aus der Pairing-Orchestrierung
// aufgerufen. Startet die Verbindung, sofern aktiviert.
function onPaired() {
  if (!connection || !enabled) return;
  connection.start().catch(() => {});
}

// Autostart beim Serverstart: nur verbinden, wenn eine provisionierte Identität
// existiert (das prüft der Client selbst) und der Subdienst aktiviert ist.
function autostart() {
  if (!connection || !enabled) return;
  connection.start().catch(() => {});
}

function connect() {
  if (!connection) return { state: 'idle' };
  if (!enabled) return connection.getStatus();
  connection.start().catch(() => {});
  return connection.getStatus();
}

function disconnect() {
  if (!connection) return { state: 'idle' };
  connection.disconnect();
  return connection.getStatus();
}

function reconnect() {
  if (!connection) return { state: 'idle' };
  connection.reconnect().catch(() => {});
  return connection.getStatus();
}

function getStatus() {
  if (!connection) return { state: enabled ? 'idle' : 'disabled' };
  const status = connection.getStatus();
  if (!enabled) status.state = 'disabled';
  return status;
}

// Entfernt eine aktive Geräteverknüpfung über den authentifizierten
// Origin-WebSocket (Abschnitt 40). Liefert ein Promise, das erst bei bestätigtem
// link_removed auflöst; scheitert bei fehlender Verbindung/Timeout. Der lokale
// Bestand folgt anschließend dem linked_devices-Snapshot.
function removeLink(deviceId) {
  if (!connection) {
    return Promise.reject(new RemoteAccessError('remote_access_not_connected', 'Fernzugriff nicht initialisiert.'));
  }
  if (!enabled) {
    return Promise.reject(new RemoteAccessError('remote_access_not_connected', 'Fernzugriff deaktiviert.'));
  }
  return connection.removeLink(deviceId);
}

function shutdown() {
  if (connection) connection.shutdown();
}

// Test-Hilfe.
function _reset() {
  if (connection) {
    try { connection.shutdown(); } catch (_) { /* egal */ }
  }
  connection = null;
  enabled = false;
}

module.exports = {
  init,
  onPaired,
  autostart,
  connect,
  disconnect,
  reconnect,
  removeLink,
  getStatus,
  shutdown,
  _reset,
};
