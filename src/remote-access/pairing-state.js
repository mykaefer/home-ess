'use strict';

// Serverseitiger, im Arbeitsspeicher gehaltener Pairing-Zustand plus
// Orchestrierung von Bestätigung (mit Instanz-Proof) und Provisioning gegen
// essrelay 0.5.0.
//
// Wichtige Änderung gegenüber der ersten Stufe: `confirmed` ist NICHT terminal.
// Der Origin-Token bleibt erhalten (pending → awaiting_confirmation → confirming
// → confirmed → provisioning) und wird erst bei einem terminalen Status
// (paired / rejected / cancelled / expired) aus dem Speicher entfernt.
//
// Der dauerhafte Instanz-Private-Key liegt ausschließlich im Identity Store;
// dieser Zustand hält nur den kurzlebigen Origin-Token und Anzeigedaten.
//
// Der aktive Instanz-Private-Key, Signaturen und Proofs verlassen den Server nie
// Richtung Browser und werden nie geloggt (siehe redact.js).

const { RemoteAccessError } = require('./errors');
const { log } = require('./redact');
const defaultIdentityStore = require('./identity-store');
const { fingerprintDisplayFromHex } = require('./identity-crypto');

// owner -> entry
const sessions = new Map();
// owner -> Promise (Lock-Kette)
const locks = new Map();
// owner -> Timeout (Hintergrund-Provisioning-Retry)
const provisionTimers = new Map();

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

// Retry-Staffel für Provisioning im Hintergrund (Abschnitt E). Nach Erschöpfung
// bleibt der Zustand `confirmed`; der Nutzer kann manuell erneut auslösen.
const PROVISION_RETRY_DELAYS_MS = [2000, 5000, 10000];

let cleanupTimer = null;

// Ereignis-Hooks, die die App setzt (z. B. WebSocket-Verbindung nach `paired`).
let hooks = { onPaired: null };

function setHooks(next) {
  hooks = { onPaired: (next && next.onPaired) || null };
}

// Zustände, in denen der Relay-Status aktiv abgefragt wird und der Countdown
// läuft.
const RELAY_POLL_STATUSES = new Set(['pending', 'awaiting_confirmation']);
// Zustände, die durch Ablauf der ursprünglichen expiresAt zu `expired` werden.
const EXPIRABLE_STATUSES = new Set(['pending', 'awaiting_confirmation', 'confirming', 'confirmed', 'provisioning']);
// Terminale Zustände: Origin-Token/QR sind entfernt, kein Übergang mehr.
const TERMINAL_STATUSES = new Set(['paired', 'rejected', 'cancelled', 'expired']);

function withLock(owner, fn) {
  const prev = locks.get(owner) || Promise.resolve();
  const gate = prev.then(() => fn(), () => fn());
  const tail = gate.then(() => {}, () => {});
  locks.set(owner, tail);
  tail.then(() => {
    if (locks.get(owner) === tail) locks.delete(owner);
  });
  return gate;
}

// Setzt eine nicht-terminale, abgelaufene Session auf `expired` und entfernt
// Geheimnisse.
function sweepEntry(entry) {
  if (entry && EXPIRABLE_STATUSES.has(entry.status) && Date.now() >= entry.expiresAtMs) {
    entry.status = 'expired';
    entry.terminalAtMs = Date.now();
    clearProvisionTimer(entry.owner);
    scrubSecrets(entry);
    log('Pairing-Session abgelaufen', { pairingId: entry.pairingId, status: 'expired' });
  }
  return entry;
}

// Entfernt Origin-Token und QR aus einem Eintrag. Behält nicht-geheime
// Anzeigedaten (Fingerprint, paired-Zusammenfassung).
function scrubSecrets(entry) {
  if (!entry) return;
  entry.originToken = null;
  entry.qrBase64 = null;
}

function remainingSeconds(entry) {
  if (!entry || !EXPIRABLE_STATUSES.has(entry.status)) return 0;
  return Math.max(0, Math.round((entry.expiresAtMs - Date.now()) / 1000));
}

function shorten(value, keep = 10) {
  if (typeof value !== 'string' || value.length <= keep) return value || null;
  return `${value.slice(0, keep)}…`;
}

// Fingerprint für die Anzeige aufbereiten (gruppierte Großform). Akzeptiert
// bereits gruppierte oder reine Hexformen; gekürzte Formen bleiben gekürzt.
function displayFingerprint(value) {
  if (typeof value !== 'string' || !value) return null;
  const hex = value.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return fingerprintDisplayFromHex(hex, { full: true });
  if (/^[0-9a-f-]+$/i.test(value)) return value.toUpperCase();
  return null;
}

// Reduziert einen Eintrag auf die für den Browser zulässigen Felder. Enthält
// niemals Token, Pairing-URI, Pairing-ID, Signaturen oder Private Keys.
function toBrowserView(entry, { includeQr = false } = {}) {
  if (!entry) return { status: 'none' };
  const s = entry.status;

  if (s === 'pending') {
    const view = {
      status: 'pending',
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      remainingSeconds: remainingSeconds(entry),
      pollIntervalSeconds: entry.pollIntervalSeconds,
    };
    if (includeQr && entry.qrBase64) view.qrCode = { mimeType: 'image/png', base64: entry.qrBase64 };
    return view;
  }

  if (s === 'awaiting_confirmation' || s === 'confirming') {
    return {
      status: s,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      remainingSeconds: remainingSeconds(entry),
      pollIntervalSeconds: entry.pollIntervalSeconds,
      claim: browserClaim(entry.claim),
    };
  }

  if (s === 'confirmed' || s === 'provisioning') {
    return {
      status: s,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      remainingSeconds: remainingSeconds(entry),
      pollIntervalSeconds: entry.pollIntervalSeconds,
      claim: browserClaim(entry.claim),
      provisioningError: entry.provisioningError || null,
    };
  }

  if (s === 'paired') {
    const p = entry.paired || {};
    return {
      status: 'paired',
      device: {
        name: p.deviceName || null,
        platform: p.devicePlatform || null,
        deviceIdShort: shorten(p.deviceId, 12),
        fingerprint: displayFingerprint(p.deviceFingerprint),
      },
      instance: {
        fingerprint: displayFingerprint(p.instanceFingerprint),
      },
      pairedAt: p.pairedAt || null,
    };
  }

  // rejected / cancelled / expired.
  return { status: s };
}

function browserClaim(claim) {
  if (!claim) return null;
  return {
    deviceName: claim.deviceName || null,
    platform: claim.platform || null,
    appVersion: claim.appVersion || null,
    claimedAt: claim.claimedAt || null,
    deviceFingerprint: displayFingerprint(claim.deviceFingerprint),
  };
}

// ---- Erstellung / Poll / Abbruch -------------------------------------------

async function create(owner, relayClient, instanceName) {
  return withLock(owner, async () => {
    const existing = sweepEntry(sessions.get(owner));
    if (existing && RELAY_POLL_STATUSES.has(existing.status)) {
      return toBrowserView(existing, { includeQr: existing.status === 'pending' });
    }
    // Eine noch laufende, nicht-terminale Kopplung (confirming/confirmed/…) nicht
    // durch eine neue Session ersetzen.
    if (existing && !TERMINAL_STATUSES.has(existing.status) && !RELAY_POLL_STATUSES.has(existing.status)) {
      return toBrowserView(existing);
    }

    const created = await relayClient.createPairingSession({ instanceName });
    const entry = {
      pairingId: created.pairingId,
      originToken: created.originToken,
      qrBase64: created.qrCode.base64,
      expiresAtMs: created.expiresAtMs,
      pollIntervalSeconds: created.pollIntervalSeconds,
      status: 'pending',
      createdAtMs: Date.now(),
      owner,
      instanceName: instanceName || 'homeESS',
      claim: null,
      deviceFingerprint: null,
      paired: null,
      provisioningError: null,
      provisionAttempts: 0,
    };
    sessions.set(owner, entry);
    log('Pairing-Session angefordert', {
      pairingId: entry.pairingId,
      status: 'pending',
      pollIntervalSeconds: entry.pollIntervalSeconds,
    });
    return toBrowserView(entry, { includeQr: true });
  });
}

async function poll(owner, relayClient) {
  return withLock(owner, async () => {
    const entry = sweepEntry(sessions.get(owner));
    if (!entry) return { status: 'none' };
    // Nur pending/awaiting_confirmation werden aktiv gegen den Relay abgeglichen.
    if (!RELAY_POLL_STATUSES.has(entry.status)) return toBrowserView(entry);

    try {
      const remote = await relayClient.readPairingSessionStatus({
        pairingId: entry.pairingId,
        originToken: entry.originToken,
      });
      applyRemoteStatus(entry, remote);
      return toBrowserView(entry);
    } catch (err) {
      const code = err && err.code;
      if (code === 'remote_access_session_not_found') {
        entry.status = 'expired';
        entry.terminalAtMs = Date.now();
        scrubSecrets(entry);
        return toBrowserView(entry);
      }
      if (code === 'remote_access_relay_unavailable') {
        return toBrowserView(entry);
      }
      throw err instanceof RemoteAccessError ? err : new RemoteAccessError('remote_access_internal_error', 'Poll fehlgeschlagen.');
    }
  });
}

async function cancel(owner, relayClient) {
  return withLock(owner, async () => {
    const entry = sweepEntry(sessions.get(owner));
    if (!entry) return { status: 'none' };
    clearProvisionTimer(owner);

    // Relay-Abbruch nur aus pending/awaiting_confirmation (dort erlaubt).
    if (RELAY_POLL_STATUSES.has(entry.status) && entry.pairingId && entry.originToken) {
      try {
        await relayClient.cancelPairingSession({ pairingId: entry.pairingId, originToken: entry.originToken });
      } catch (err) {
        log('Pairing-Session-Abbruch: Relay-Fehler ignoriert', { pairingId: entry.pairingId, error: err && err.code });
      }
    }
    entry.status = 'cancelled';
    entry.terminalAtMs = Date.now();
    entry.claim = null;
    entry.provisioningError = null;
    scrubSecrets(entry);
    log('Pairing-Session abgebrochen', { pairingId: entry.pairingId, status: 'cancelled' });
    return { status: 'cancelled' };
  });
}

// ---- Ablehnung --------------------------------------------------------------

async function reject(owner, relayClient) {
  return withLock(owner, async () => {
    const entry = sweepEntry(sessions.get(owner));
    if (!entry) throw new RemoteAccessError('remote_access_session_not_found', 'Keine Pairing-Session.');
    if (entry.status === 'rejected') return { status: 'rejected' };
    if (entry.status !== 'awaiting_confirmation' || !entry.originToken) {
      throw new RemoteAccessError('remote_access_session_conflict', 'Pairing-Session ist nicht ablehnbar.');
    }
    try {
      await relayClient.rejectPairingSession({ pairingId: entry.pairingId, originToken: entry.originToken });
    } catch (err) {
      if (err && (err.code === 'remote_access_session_conflict' || err.code === 'remote_access_session_expired')) {
        await refreshAfterConflict(entry, relayClient);
      }
      throw err instanceof RemoteAccessError ? err : new RemoteAccessError('remote_access_internal_error', 'Ablehnung fehlgeschlagen.');
    }
    entry.status = 'rejected';
    entry.terminalAtMs = Date.now();
    entry.claim = null;
    scrubSecrets(entry);
    log('Pairing-Session abgelehnt', { pairingId: entry.pairingId, status: 'rejected' });
    return { status: 'rejected' };
  });
}

// ---- Bestätigung + Provisioning (orchestriert) ------------------------------

// Bestätigt mit Instanz-Proof und provisioniert unmittelbar danach. Idempotent:
// ein erneuter Aufruf bei bereits `confirmed`/`provisioning` überspringt den
// Confirm und wiederholt nur das Provisioning; bei `paired` passiert nichts.
async function confirm(owner, relayClient, options = {}) {
  return withLock(owner, () => confirmLocked(owner, relayClient, options));
}

async function confirmLocked(owner, relayClient, options) {
  const identityStore = options.identityStore || defaultIdentityStore;
  const entry = sweepEntry(sessions.get(owner));
  if (!entry) throw new RemoteAccessError('remote_access_session_not_found', 'Keine Pairing-Session.');
  if (entry.status === 'paired') return toBrowserView(entry);

  // Retry-Pfad: bereits bestätigt -> nur Provisioning wiederholen.
  if (entry.status === 'confirmed' || entry.status === 'provisioning') {
    return provisionLocked(entry, relayClient, options);
  }

  if (entry.status !== 'awaiting_confirmation' || !entry.originToken) {
    throw new RemoteAccessError('remote_access_session_conflict', 'Pairing-Session ist nicht bestätigbar.');
  }
  if (!entry.deviceFingerprint) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Gerätefingerprint fehlt für die Bestätigung.');
  }

  // Instanz-Proof erzeugen (Signatur mit dauerhaftem Instanz-Private-Key).
  let signed;
  try {
    signed = await identityStore.signInstancePairingProof({
      pairingId: entry.pairingId,
      originToken: entry.originToken,
      deviceFingerprintHex: entry.deviceFingerprint,
    });
  } catch (err) {
    log('Instanz-Proof konnte nicht erzeugt werden', { pairingId: entry.pairingId, error: err && err.code });
    throw err instanceof RemoteAccessError
      ? new RemoteAccessError('remote_access_identity_proof_failed', 'Instanz-Proof fehlgeschlagen.')
      : new RemoteAccessError('remote_access_identity_proof_failed', 'Instanz-Proof fehlgeschlagen.');
  }

  entry.status = 'confirming';
  try {
    await relayClient.confirmPairingSession({
      pairingId: entry.pairingId,
      originToken: entry.originToken,
      instanceName: entry.instanceName,
      instanceIdentity: { publicKey: signed.publicKeySpkiBase64, proof: signed.proof },
    });
  } catch (err) {
    if (err && (err.code === 'remote_access_session_conflict' || err.code === 'remote_access_session_expired')) {
      await refreshAfterConflict(entry, relayClient);
    } else {
      entry.status = 'awaiting_confirmation';
    }
    throw err instanceof RemoteAccessError ? err : new RemoteAccessError('remote_access_internal_error', 'Bestätigung fehlgeschlagen.');
  }

  entry.status = 'confirmed';
  entry.provisioningError = null;
  log('Pairing-Session bestätigt', { pairingId: entry.pairingId, status: 'confirmed' });

  // Unmittelbar provisionieren.
  return provisionLocked(entry, relayClient, options);
}

// Öffentlicher Provisioning-Endpunkt (manueller/automatischer Retry aus der UI).
async function provision(owner, relayClient, options = {}) {
  return withLock(owner, async () => {
    const entry = sweepEntry(sessions.get(owner));
    if (!entry) throw new RemoteAccessError('remote_access_session_not_found', 'Keine Pairing-Session.');
    if (entry.status === 'paired') return toBrowserView(entry);
    if (entry.status !== 'confirmed' && entry.status !== 'provisioning') {
      throw new RemoteAccessError('remote_access_session_conflict', 'Provisioning nur aus confirmed möglich.');
    }
    return provisionLocked(entry, relayClient, options);
  });
}

// Führt einen Provisioning-Versuch aus (Lock wird vom Aufrufer gehalten).
async function provisionLocked(entry, relayClient, options) {
  const identityStore = options.identityStore || defaultIdentityStore;
  const backgroundRetry = options.backgroundRetry !== false;

  if (entry.status === 'paired') return toBrowserView(entry);

  // Ablauf zuerst prüfen (expiresAt bleibt maßgeblich).
  if (Date.now() >= entry.expiresAtMs) {
    entry.status = 'expired';
    entry.terminalAtMs = Date.now();
    clearProvisionTimer(entry.owner);
    scrubSecrets(entry);
    throw new RemoteAccessError('remote_access_provisioning_expired', 'Session vor dem Provisioning abgelaufen.');
  }

  entry.status = 'provisioning';
  entry.provisionAttempts += 1;

  let provResult;
  try {
    provResult = await relayClient.provisionPairingSession({
      pairingId: entry.pairingId,
      originToken: entry.originToken,
    });
  } catch (err) {
    const code = (err && err.code) || 'remote_access_internal_error';
    // Bereits provisioniert / Konflikt: mit dem Relay-Status abgleichen.
    if (code === 'remote_access_session_conflict') {
      const reconciled = await reconcileFromStatus(entry, relayClient, identityStore, options);
      if (reconciled) return reconciled;
    }
    if (code === 'remote_access_session_expired' || code === 'remote_access_provisioning_expired') {
      entry.status = 'expired';
      entry.terminalAtMs = Date.now();
      clearProvisionTimer(entry.owner);
      scrubSecrets(entry);
      throw new RemoteAccessError('remote_access_provisioning_expired', 'Session vor dem Provisioning abgelaufen.');
    }
    // Transienter Fehler: Zustand bleibt confirmed, Hintergrund-Retry planen.
    entry.status = 'confirmed';
    entry.provisioningError = 'remote_access_provisioning_failed';
    log('Provisioning fehlgeschlagen, bleibt confirmed', { pairingId: entry.pairingId, error: code });
    if (backgroundRetry) scheduleProvisionRetry(entry.owner, relayClient, options);
    return toBrowserView(entry);
  }

  // Erfolg: Identität persistieren und Zustand auf paired setzen.
  return finalizePaired(entry, provResult, identityStore, options);
}

// Übernimmt ein Provisioning-Ergebnis, persistiert die Identität und schaltet
// auf `paired`. Bei Fingerprint-Mismatch bleibt der Origin-Token erhalten
// (Reconciliation möglich) und ein Sicherheitsfehler wird geworfen.
async function finalizePaired(entry, provResult, identityStore, options) {
  let record;
  try {
    record = await identityStore.storeProvisionedIdentity({
      instanceId: provResult.instance.instanceId,
      instanceName: provResult.instance.name || entry.instanceName,
      instanceFingerprint: provResult.instance.fingerprint,
      device: {
        deviceId: provResult.device.deviceId,
        name: provResult.device.name || (entry.claim && entry.claim.deviceName),
        platform: provResult.device.platform || (entry.claim && entry.claim.platform),
        appVersion: entry.claim && entry.claim.appVersion,
        fingerprint: provResult.device.fingerprint,
        claimFingerprint: entry.deviceFingerprint,
      },
      relayBaseUrl: relayBaseUrlOf(options),
      protocolVersion: options.protocolVersion || '0.1',
      pairedAt: provResult.pairedAt,
    });
  } catch (err) {
    const code = (err && err.code) || 'remote_access_provisioning_failed';
    // Sicherheitsfehler (Mismatch): Origin-Token NICHT scrubben, Zustand bleibt
    // confirmed für mögliche Reconciliation; kein WebSocket-Aufbau.
    entry.status = 'confirmed';
    entry.provisioningError = code === 'remote_access_identity_mismatch' ? code : 'remote_access_provisioning_failed';
    log('Provisioning-Ergebnis abgelehnt', { pairingId: entry.pairingId, error: code });
    throw err instanceof RemoteAccessError ? err : new RemoteAccessError('remote_access_provisioning_failed', 'Provisioning fehlgeschlagen.');
  }

  clearProvisionTimer(entry.owner);
  entry.status = 'paired';
  entry.terminalAtMs = Date.now();
  entry.provisioningError = null;
  entry.paired = {
    instanceId: provResult.instance.instanceId,
    instanceFingerprint: provResult.instance.fingerprint,
    deviceId: provResult.device.deviceId,
    deviceName: provResult.device.name || (entry.claim && entry.claim.deviceName) || null,
    devicePlatform: provResult.device.platform || (entry.claim && entry.claim.platform) || null,
    deviceFingerprint: provResult.device.fingerprint,
    pairedAt: (record && record.pairedAt) || provResult.pairedAt || new Date().toISOString(),
  };
  scrubSecrets(entry);
  entry.claim = null;
  entry.deviceFingerprint = null;
  log('Pairing abgeschlossen (paired)', {
    pairingId: entry.pairingId,
    status: 'paired',
    instanceId: shorten(provResult.instance.instanceId, 12),
    deviceId: shorten(provResult.device.deviceId, 12),
  });

  if (hooks.onPaired) {
    try { hooks.onPaired(record); } catch (_) { /* Verbindungsaufbau darf Pairing nicht scheitern lassen. */ }
  }
  return toBrowserView(entry);
}

// Reconciliation: Origin-Status abrufen; falls `paired`, Identität übernehmen.
async function reconcileFromStatus(entry, relayClient, identityStore, options) {
  let remote;
  try {
    remote = await relayClient.readPairingSessionStatus({ pairingId: entry.pairingId, originToken: entry.originToken });
  } catch (_) {
    return null;
  }
  if (remote.status === 'paired' && remote.identity) {
    const provResult = {
      instance: {
        instanceId: remote.identity.instanceId,
        name: remote.identity.instanceName,
        fingerprint: remote.identity.instanceFingerprint,
      },
      device: {
        deviceId: remote.identity.deviceId,
        name: entry.claim && entry.claim.deviceName,
        platform: entry.claim && entry.claim.platform,
        fingerprint: remote.identity.deviceFingerprint,
      },
      pairedAt: null,
    };
    return finalizePaired(entry, provResult, identityStore, options);
  }
  if (remote.status === 'expired' || TERMINAL_STATUSES.has(remote.status)) {
    applyRemoteStatus(entry, remote);
    return toBrowserView(entry);
  }
  return null;
}

function relayBaseUrlOf(options) {
  if (options.relayBaseUrl) return options.relayBaseUrl;
  return null;
}

// ---- Hintergrund-Retry ------------------------------------------------------

function scheduleProvisionRetry(owner, relayClient, options) {
  const entry = sessions.get(owner);
  if (!entry) return;
  const attempt = entry.provisionAttempts - 1; // 0-basiert
  if (attempt >= PROVISION_RETRY_DELAYS_MS.length) return; // Retries erschöpft
  if (provisionTimers.has(owner)) return;
  const delay = PROVISION_RETRY_DELAYS_MS[attempt];
  const timer = setTimeout(() => {
    provisionTimers.delete(owner);
    // Über den Lock laufen lassen, damit kein paralleles Provisioning entsteht.
    withLock(owner, async () => {
      const cur = sweepEntry(sessions.get(owner));
      if (!cur || cur.status !== 'confirmed') return;
      try {
        await provisionLocked(cur, relayClient, options);
      } catch (_) {
        /* Fehler wurde bereits im Zustand vermerkt; nächster Retry ggf. geplant. */
      }
    }).catch(() => {});
  }, delay);
  if (timer.unref) timer.unref();
  provisionTimers.set(owner, timer);
}

function clearProvisionTimer(owner) {
  const t = provisionTimers.get(owner);
  if (t) {
    clearTimeout(t);
    provisionTimers.delete(owner);
  }
}

// ---- Relay-Status übernehmen -----------------------------------------------

function applyRemoteStatus(entry, remote) {
  const previous = entry.status;
  // Lokale Zwischenzustände (confirming/provisioning/paired) nicht durch einen
  // rohen Relay-Status überschreiben — sie werden von der Orchestrierung geführt.
  if (entry.status === 'confirming' || entry.status === 'provisioning' || entry.status === 'paired') {
    if (remote.status === 'paired' || remote.status === 'confirmed') return;
  }

  if (remote.status === 'awaiting_confirmation') {
    entry.status = 'awaiting_confirmation';
    entry.claim = remote.claim || null;
    entry.deviceFingerprint = (remote.claim && remote.claim.deviceFingerprint) || entry.deviceFingerprint;
    entry.qrBase64 = null;
    if (previous === 'pending') {
      log('Pairing-Session wartet auf Bestätigung', { pairingId: entry.pairingId, status: 'awaiting_confirmation' });
    }
  } else if (remote.status === 'pending') {
    entry.status = 'pending';
    entry.claim = null;
  } else if (remote.status === 'confirmed') {
    // Nur relevant, falls homeESS confirmed nicht selbst gesetzt hat.
    entry.status = 'confirmed';
  } else if (TERMINAL_STATUSES.has(remote.status)) {
    entry.status = remote.status;
    entry.terminalAtMs = Date.now();
    entry.claim = null;
    clearProvisionTimer(entry.owner);
    scrubSecrets(entry);
    log(`Pairing-Session ${remote.status}`, { pairingId: entry.pairingId, status: remote.status });
  }
  if (remote.expiresAtMs && !TERMINAL_STATUSES.has(entry.status)) entry.expiresAtMs = remote.expiresAtMs;
}

async function refreshAfterConflict(entry, relayClient) {
  if (!entry || !entry.originToken) return;
  try {
    const remote = await relayClient.readPairingSessionStatus({ pairingId: entry.pairingId, originToken: entry.originToken });
    applyRemoteStatus(entry, remote);
  } catch (_) {
    /* Der ursprüngliche Konflikt ist aussagekräftiger. */
  }
}

// ---- Lebenszyklus -----------------------------------------------------------

function removeForOwner(owner) {
  const entry = sessions.get(owner);
  if (entry) scrubSecrets(entry);
  clearProvisionTimer(owner);
  sessions.delete(owner);
  locks.delete(owner);
}

function sweepAll() {
  const now = Date.now();
  for (const [owner, entry] of sessions) {
    sweepEntry(entry);
    if (TERMINAL_STATUSES.has(entry.status)) {
      const since = entry.terminalAtMs || entry.expiresAtMs || 0;
      if (now - since > TERMINAL_RETENTION_MS) {
        scrubSecrets(entry);
        clearProvisionTimer(owner);
        sessions.delete(owner);
      }
    }
  }
}

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(sweepAll, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function shutdown() {
  stopCleanup();
  for (const owner of provisionTimers.keys()) clearProvisionTimer(owner);
  for (const entry of sessions.values()) scrubSecrets(entry);
  sessions.clear();
  locks.clear();
  provisionTimers.clear();
}

module.exports = {
  create,
  poll,
  cancel,
  confirm,
  reject,
  provision,
  setHooks,
  removeForOwner,
  startCleanup,
  stopCleanup,
  shutdown,
  _internal: { sessions, provisionTimers, sweepAll, toBrowserView, remainingSeconds, TERMINAL_RETENTION_MS, PROVISION_RETRY_DELAYS_MS },
};
