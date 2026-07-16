'use strict';

// Stabile interne Fehlercodes für den Fernzugriff. Der Browser erhält nie die
// vollständige Relay-Fehlerantwort, sondern nur diese abstrahierten Codes.
const REMOTE_ACCESS_ERROR_CODES = new Set([
  'remote_access_relay_unavailable',
  'remote_access_rate_limited',
  'remote_access_capacity_reached',
  'remote_access_invalid_response',
  'remote_access_session_not_found',
  'remote_access_session_conflict',
  'remote_access_session_expired',
  'remote_access_internal_error',
  // Identität / Provisioning / WebSocket (essrelay 0.5.0).
  'remote_access_identity_invalid',
  'remote_access_identity_store_corrupt',
  'remote_access_identity_proof_failed',
  'remote_access_provisioning_failed',
  'remote_access_provisioning_expired',
  'remote_access_identity_mismatch',
  'remote_access_authentication_failed',
  'remote_access_authentication_timeout',
  'remote_access_connection_replaced',
  'remote_access_protocol_error',
  // Entfernung einer aktiven Verknüpfung (remove_link / link_removed, Abschnitt 40).
  'remote_access_invalid_device_id',
  'remote_access_not_connected',
  'remote_access_link_removal_timeout',
  'remote_access_link_removal_failed',
]);

// Fehler mit stabilem, maschinenlesbarem Code. `detail` ist rein technisch und
// wird nie an den Browser ausgegeben.
class RemoteAccessError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'RemoteAccessError';
    this.code = REMOTE_ACCESS_ERROR_CODES.has(code) ? code : 'remote_access_internal_error';
    this.detail = detail;
  }
}

module.exports = { RemoteAccessError, REMOTE_ACCESS_ERROR_CODES };
