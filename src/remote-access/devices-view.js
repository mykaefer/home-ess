'use strict';

// Baut die Browser-Sicht der Sektion „Gekoppelte Geräte" (/remote-access).
//
// Führt die PERSISTENTEN Kopplungen (identity-store) mit dem FLÜCHTIGEN
// Laufzeitstatus (device-status) zusammen — beide bleiben getrennte Quellen:
//   - Persistenz liefert die Geräteliste (deviceId, Name, Plattform, Fingerprint,
//     pairedAt, lastKnownConnectedAt). Sie wird nie durch den Relay-Status gelöscht.
//   - Der Laufzeitstatus entscheidet allein über „aktiv verbunden".
//
// Ein Gerät gilt nur dann als aktiv, wenn der Origin-WebSocket authentifiziert ist
// UND der aktuelle Relay-Status für genau diese deviceId connected:true meldet.
// Fremde deviceIds im Laufzeitstatus haben keine persistente Entsprechung und
// tauchen daher nie auf. Bei Relay-Disconnect ist der Laufzeitstatus leer und alle
// Geräte gelten als „Status unbekannt".
//
// Es werden nur gekürzte, nicht-geheime Anzeigedaten ausgegeben: keine Tokens,
// keine (vollständigen) Public Keys, keine WebSocket-Secrets.

const defaultIdentityStore = require('./identity-store');
const defaultDeviceStatus = require('./device-status');
const defaultConnectionService = require('./connection-service');

// Kürzt eine ID auf ein anzeigefreundliches Präfix (nie vollständig ausgeben).
function shortenId(value, keep = 12) {
  if (typeof value !== 'string' || !value) return null;
  return value.length > keep ? `${value.slice(0, keep)}…` : value;
}

// Kürzt einen Fingerprint auf ein Präfix — der vollständige Wert (und erst recht
// der Public Key) verlässt den Server nie.
function shortenFingerprint(value, keepChars = 16) {
  if (typeof value !== 'string' || !value) return null;
  const stripped = value.replace(/-/g, '');
  return stripped.length > keepChars ? `${stripped.slice(0, keepChars)}…` : stripped;
}

async function buildDevicesView(deps = {}) {
  const identityStore = deps.identityStore || defaultIdentityStore;
  const deviceStatus = deps.deviceStatus || defaultDeviceStatus;
  const connectionService = deps.connectionService || defaultConnectionService;

  let prov = null;
  try {
    prov = await identityStore.getProvisionedIdentity();
  } catch (_) {
    // Beschädigter/nicht ladbarer Store darf die Seite nicht sprengen: leere Liste.
    prov = null;
  }
  const persistentDevices = prov && Array.isArray(prov.devices) ? prov.devices : [];

  const connStatus = (connectionService && connectionService.getStatus) ? connectionService.getStatus() : {};
  const relayConnected = Boolean(connStatus && connStatus.state === 'authenticated');
  const runtime = (deviceStatus && deviceStatus.getRuntime) ? deviceStatus.getRuntime() : { devices: {} };
  const runtimeDevices = runtime && runtime.devices ? runtime.devices : {};

  let active = 0;
  const devices = persistentDevices.map((d) => {
    let connection = 'unknown';
    if (relayConnected) {
      const rt = runtimeDevices[d.deviceId];
      if (rt) connection = rt.connected ? 'active' : 'offline';
      // Kein Laufzeiteintrag (Relay hat das Gerät nicht gemeldet): unbekannt.
    }
    if (connection === 'active') active += 1;
    return {
      // Vollständige deviceId für die Entfernungsaktion (kein Geheimnis, sie geht
      // ohnehin als remove_link-Ziel an den Relay); die Anzeige nutzt deviceIdShort.
      deviceId: d.deviceId,
      deviceName: d.name || 'Gerät',
      platform: d.platform || 'unknown',
      deviceIdShort: shortenId(d.deviceId),
      fingerprintShort: shortenFingerprint(d.fingerprintHex),
      pairedAt: d.pairedAt || null,
      lastKnownConnectedAt: d.lastKnownConnectedAt || null,
      connection,
    };
  });

  return {
    relay: { connected: relayConnected },
    counts: { paired: devices.length, active },
    devices,
  };
}

module.exports = { buildDevicesView, shortenId, shortenFingerprint };
