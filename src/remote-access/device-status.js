'use strict';

// Prozessweiter, rein flüchtiger Laufzeit-Status der Geräteverbindungen.
//
// STRIKT getrennt von der persistenten Kopplungsdatenhaltung (identity-store):
// Hier wird NICHTS auf die Festplatte geschrieben und beim Relay-Disconnect
// alles verworfen. Gespeist wird der Store ausschließlich aus bereits validierten
// `connection_status`-Nachrichten (Abschnitt 39) des authentifizierten
// Origin-WebSockets, aber nur für Geräte aus einem zuvor akzeptierten
// vollständigen `linked_devices`-Snapshot. Persistente Kopplungen bleiben davon
// unberührt und werden nie gelöscht — bei Relay-Disconnect gelten Geräte
// lediglich als „Status unbekannt".

let relayConnected = false;
let generatedAt = null;
// deviceId -> { connected: boolean, connectedAt: string|null }
let statuses = new Map();
let authoritativeDeviceIds = new Set();
let authoritativeRevision = null;

// Übernimmt den akzeptierten, vollständigen linked_devices-Bestand. Das legt
// keinen Online-Status an; es begrenzt nur, welche deviceIds connection_status
// später aktualisieren darf. Fehlende Geräte werden aus dem Runtime-Status
// entfernt.
function setAuthoritativeLinks(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.devices)) return false;
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) return false;
  if (snapshot.complete !== true) return false;
  if (Number.isInteger(authoritativeRevision) && snapshot.revision < authoritativeRevision) return false;

  const nextIds = new Set();
  for (const d of snapshot.devices) {
    if (d && typeof d.deviceId === 'string') nextIds.add(d.deviceId);
  }
  authoritativeDeviceIds = nextIds;
  authoritativeRevision = snapshot.revision;
  statuses = new Map(Array.from(statuses.entries()).filter(([deviceId]) => authoritativeDeviceIds.has(deviceId)));
  return true;
}

// Übernimmt eine bereits strukturell validierte connection_status-Sicht. Die
// Liste ist die vollständige, frisch berechnete Momentaufnahme des Relays (kein
// Diff), aber nur bekannte, autoritativ verknüpfte Geräte dürfen einen
// Laufzeitstatus erhalten. Vor dem ersten accepted linked_devices-Snapshot wird
// connection_status vollständig ignoriert.
function applyConnectionStatus(view) {
  const devices = view && Array.isArray(view.devices) ? view.devices : [];
  const next = new Map();
  const accepted = [];
  for (const d of devices) {
    if (!d || typeof d.deviceId !== 'string') continue;
    if (!authoritativeDeviceIds.has(d.deviceId)) continue;
    const connected = d.connected === true;
    const entry = {
      deviceId: d.deviceId,
      connected,
      // connectedAt ist laut Spec nur bei connected:true aussagekräftig.
      connectedAt: connected && typeof d.connectedAt === 'string' ? d.connectedAt : null,
    };
    next.set(d.deviceId, { connected: entry.connected, connectedAt: entry.connectedAt });
    accepted.push(entry);
  }
  statuses = next;
  generatedAt = view && typeof view.generatedAt === 'string' ? view.generatedAt : null;
  relayConnected = true;
  return accepted;
}

// Bei Relay-Disconnect: Laufzeitstatus verwerfen (nicht die Persistenz!).
function markRelayDisconnected() {
  relayConnected = false;
  generatedAt = null;
  statuses = new Map();
  authoritativeDeviceIds = new Set();
  authoritativeRevision = null;
}

// Liefert eine flache Kopie des aktuellen Laufzeitstatus (kein internes State-Leak).
function getRuntime() {
  const out = {};
  for (const [deviceId, v] of statuses) {
    out[deviceId] = { connected: v.connected, connectedAt: v.connectedAt };
  }
  return { relayConnected, generatedAt, devices: out };
}

// Test-Hilfe: internen Zustand zurücksetzen.
function _reset() {
  relayConnected = false;
  generatedAt = null;
  statuses = new Map();
  authoritativeDeviceIds = new Set();
  authoritativeRevision = null;
}

module.exports = { applyConnectionStatus, setAuthoritativeLinks, markRelayDisconnected, getRuntime, _reset };
