'use strict';

const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth/session');
const { createRelayClient } = require('../remote-access/relay-client');
const pairingState = require('../remote-access/pairing-state');
const connectionService = require('../remote-access/connection-service');
const { buildDevicesView } = require('../remote-access/devices-view');
const { log } = require('../remote-access/redact');

// Fernzugriff-Routen: die Seite /remote-access sowie die lokalen, nur für
// authentifizierte Admins zugänglichen Pairing-Endpunkte. Der Browser spricht
// ausschließlich mit diesen Endpunkten; homeESS spricht mit dem essrelay.

// Interne Fehlercodes -> HTTP-Status für die Browser-Antwort.
const ERROR_STATUS = {
  remote_access_rate_limited: 429,
  remote_access_capacity_reached: 429,
  remote_access_relay_unavailable: 502,
  remote_access_invalid_response: 502,
  remote_access_session_not_found: 404,
  remote_access_session_conflict: 409,
  remote_access_session_expired: 409,
  remote_access_internal_error: 500,
  // Identität / Provisioning / WebSocket.
  remote_access_identity_invalid: 500,
  remote_access_identity_store_corrupt: 500,
  remote_access_identity_proof_failed: 502,
  remote_access_provisioning_failed: 502,
  remote_access_provisioning_expired: 409,
  remote_access_identity_mismatch: 409,
  remote_access_authentication_failed: 502,
  remote_access_authentication_timeout: 502,
  remote_access_connection_replaced: 409,
  remote_access_protocol_error: 502,
  // Entfernung einer aktiven Verknüpfung (remove_link / link_removed).
  remote_access_invalid_device_id: 400,
  remote_access_not_connected: 409,
  remote_access_link_removal_timeout: 504,
  remote_access_link_removal_failed: 502,
};

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
}

// JSON-Auth: gibt bei fehlender Session 401 zurück (statt Redirect wie bei
// Seitenaufrufen), damit fetch()-Aufrufe sauber scheitern.
function requireAuthJson(req, res, next) {
  if (!req.session) {
    noStore(res);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Leichter CSRF-Schutz für verändernde Aufrufe: ein Custom-Header, den ein
// fremdes HTML-Formular nicht setzen kann und der bei Cross-Origin-fetch einen
// Preflight erzwingt (den es ohne CORS-Freigabe nicht gibt). Ergänzt das
// bestehende SameSite=lax-Session-Cookie.
function requireCsrf(req, res, next) {
  if (req.get('X-HomeESS-Request') !== '1') {
    noStore(res);
    return res.status(403).json({ error: 'csrf' });
  }
  next();
}

function sendError(res, err) {
  const code = (err && err.code) || 'remote_access_internal_error';
  const status = ERROR_STATUS[code] || 500;
  noStore(res);
  return res.status(status).json({ error: code });
}

// Optionen dienen ausschließlich Tests (Relay-Client / Instanzname injizieren).
// In der App wird remoteAccessRoutes() ohne Argumente aufgerufen.
function remoteAccessRoutes(options = {}) {
  const router = express.Router();
  const relayClient = options.relayClient || createRelayClient({ baseUrl: config.RELAY_BASE_URL });
  const instanceName = options.instanceName || config.INSTANCE_NAME;
  const connection = options.connectionService || connectionService;
  // Optionen für die Confirm-/Provisioning-Orchestrierung. identityStore ist
  // injizierbar (Tests); in der App der Default-Store aus config.IDENTITY_DIR.
  const provisionOptions = {
    relayBaseUrl: config.RELAY_BASE_URL,
    protocolVersion: config.RELAY_PROTOCOL_VERSION,
  };
  if (options.identityStore) provisionOptions.identityStore = options.identityStore;
  if (options.backgroundRetry === false) provisionOptions.backgroundRetry = false;

  // Fernzugriff ist in die Einstellungsseite (Tab „Fernzugriff") integriert.
  // Der alte Direktlink bleibt als Weiterleitung erhalten (Lesezeichen/App).
  router.get('/remote-access', requireAuth, (req, res) => {
    noStore(res);
    res.redirect('/settings?tab=remote-access');
  });

  // Neue Pairing-Session erstellen.
  router.post('/api/remote-access/pairing', requireAuthJson, requireCsrf, async (req, res) => {
    try {
      const view = await pairingState.create(req.session.id, relayClient, instanceName);
      noStore(res);
      res.json(view);
    } catch (err) {
      log('Pairing-Erstellung fehlgeschlagen', { error: err && err.code });
      sendError(res, err);
    }
  });

  // Aktuellen Status lesen (gleicht bei aktiver Session mit dem Relay ab).
  router.get('/api/remote-access/pairing', requireAuthJson, async (req, res) => {
    try {
      const view = await pairingState.poll(req.session.id, relayClient);
      noStore(res);
      res.json(view);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Aktive Session abbrechen und lokalen Zustand bereinigen.
  router.delete('/api/remote-access/pairing', requireAuthJson, requireCsrf, async (req, res) => {
    try {
      await pairingState.cancel(req.session.id, relayClient);
      noStore(res);
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  // Smartphone-Claim bestätigen (bestätigt mit Instanz-Proof und provisioniert
  // unmittelbar; der Rückgabe-Status ist confirmed/provisioning/paired).
  router.post('/api/remote-access/pairing/confirm', requireAuthJson, requireCsrf, async (req, res) => {
    try {
      const view = await pairingState.confirm(req.session.id, relayClient, provisionOptions);
      noStore(res);
      res.json(view);
    } catch (err) {
      log('Bestätigung/Provisioning fehlgeschlagen', { error: err && err.code });
      sendError(res, err);
    }
  });

  // Provisioning erneut auslösen (manueller/automatischer Retry aus confirmed).
  router.post('/api/remote-access/pairing/provision', requireAuthJson, requireCsrf, async (req, res) => {
    try {
      const view = await pairingState.provision(req.session.id, relayClient, provisionOptions);
      noStore(res);
      res.json(view);
    } catch (err) {
      log('Provisioning-Retry fehlgeschlagen', { error: err && err.code });
      sendError(res, err);
    }
  });

  // Smartphone-Claim ablehnen.
  router.post('/api/remote-access/pairing/reject', requireAuthJson, requireCsrf, async (req, res) => {
    try {
      await pairingState.reject(req.session.id, relayClient);
      noStore(res);
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- Gekoppelte Geräte (Übersicht) ---------------------------------------

  // Persistente Kopplungen + flüchtiger Relay-Laufzeitstatus, zusammengeführt zu
  // einer nicht-geheimen Anzeigesicht (gekürzte IDs/Fingerprints, keine Tokens,
  // keine Public Keys). Admin-geschützt und no-store.
  router.get('/api/remote-access/devices', requireAuthJson, async (req, res) => {
    try {
      const view = await buildDevicesView({
        identityStore: options.identityStore,
        deviceStatus: options.deviceStatus,
        connectionService: connection,
      });
      noStore(res);
      res.json(view);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Entfernt eine aktive Geräteverknüpfung über den Relay (remove_link,
  // Abschnitt 40). Löst erst nach bestätigtem link_removed auf; der lokale
  // Bestand wird NICHT hier gelöscht, sondern folgt dem linked_devices-Snapshot.
  // Bei Fehler/Timeout bleibt das Gerät erhalten und der Fehlercode geht an die UI.
  router.post('/api/remote-access/devices/remove', requireAuthJson, requireCsrf, async (req, res) => {
    const deviceId = req.body && req.body.deviceId;
    if (typeof deviceId !== 'string' || !/^dev_[A-Za-z0-9_-]{4,}$/.test(deviceId)) {
      noStore(res);
      return res.status(ERROR_STATUS.remote_access_invalid_device_id).json({ error: 'remote_access_invalid_device_id' });
    }
    try {
      await connection.removeLink(deviceId);
      noStore(res);
      return res.json({ status: 'removal_requested' });
    } catch (err) {
      log('Geräteentfernung fehlgeschlagen', { error: err && err.code });
      return sendError(res, err);
    }
  });

  // ---- Origin-WebSocket-Verbindung (Diagnose/Steuerung) --------------------

  // Verbindungsstatus lesen (keine Secrets, keine ConnectionId als Credential).
  router.get('/api/remote-access/connection', requireAuthJson, (req, res) => {
    noStore(res);
    res.json(connection.getStatus());
  });

  // Verbindung (neu) aufbauen.
  router.post('/api/remote-access/connection/connect', requireAuthJson, requireCsrf, (req, res) => {
    noStore(res);
    res.json(connection.connect());
  });

  // Verbindung trennen (Subdienst anhalten).
  router.post('/api/remote-access/connection/disconnect', requireAuthJson, requireCsrf, (req, res) => {
    noStore(res);
    res.json(connection.disconnect());
  });

  return router;
}

module.exports = remoteAccessRoutes;
