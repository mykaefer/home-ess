'use strict';

// Serverseitiger Relay-Client (Fachkomponente) für die Pairing-Stufe.
//
// Verantwortlichkeiten:
//   createPairingSession       – POST  /api/v1/pairing/sessions   (ohne Auth)
//   readPairingSessionStatus   – GET   /api/v1/pairing/sessions/:id (Origin-Auth)
//   cancelPairingSession       – DELETE /api/v1/pairing/sessions/:id (Origin-Auth)
//   confirmPairingSession      – POST  /api/v1/pairing/sessions/:id/confirm
//   rejectPairingSession       – POST  /api/v1/pairing/sessions/:id/reject
//
// Der Browser ruft den Relay NIE direkt auf; nur dieser Client tut das. Er hält
// den Origin-Token ausschließlich serverseitig, erzwingt HTTPS, setzt Timeouts
// per AbortController, verbietet Redirects, begrenzt die Antwortgröße und
// validiert die Relay-Antwort streng. Relay-Fehler werden in stabile interne
// homeESS-Fehlercodes übersetzt.

const { RemoteAccessError } = require('./errors');

const PROTOCOL_VERSION = '0.1';
const PAIRING_URI_VERSION = '1';

// Timeouts (ms) — an Projektgepflogenheiten angelehnt, siehe Spezifikation.
const TIMEOUT_CREATE_MS = 10000;
const TIMEOUT_STATUS_MS = 5000;
const TIMEOUT_CANCEL_MS = 5000;
const TIMEOUT_DECISION_MS = 5000;

// Obergrenze der Antwortgröße. Das QR-PNG ist klein; 1 MiB ist großzügig.
const MAX_RESPONSE_BYTES = 1024 * 1024;
// Getrennt und knapper begrenztes rohes PNG (nach Base64-Dekodierung).
const MAX_PNG_BYTES = 512 * 1024;

// Plausibler Bereich für das Poll-Intervall.
const MIN_POLL_SECONDS = 2;
const MAX_POLL_SECONDS = 30;

const KNOWN_STATUS = new Set(['pending', 'awaiting_confirmation', 'confirmed', 'paired', 'rejected', 'expired', 'cancelled']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TIMEOUT_PROVISION_MS = 8000;
const TIMEOUT_CAPS_MS = 5000;

// Abbildung stabiler Relay-Fehlercodes -> interne homeESS-Fehlercodes.
const RELAY_ERROR_MAP = {
  rate_limit_exceeded: 'remote_access_rate_limited',
  too_many_active_pairing_sessions: 'remote_access_capacity_reached',
  pairing_session_not_found: 'remote_access_session_not_found',
  pairing_session_conflict: 'remote_access_session_conflict',
  pairing_session_expired: 'remote_access_session_expired',
  pairing_session_unavailable: 'remote_access_relay_unavailable',
  invalid_pairing_token: 'remote_access_session_not_found',
  invalid_claim_token: 'remote_access_session_not_found',
  invalid_pairing_request: 'remote_access_invalid_response',
  unsupported_protocol_version: 'remote_access_invalid_response',
  internal_error: 'remote_access_relay_unavailable',
  // Identität / Proof / Provisioning (essrelay 0.5.0, Abschnitt 37).
  invalid_instance_identity: 'remote_access_identity_proof_failed',
  invalid_instance_identity_proof: 'remote_access_identity_proof_failed',
  identity_algorithm_not_supported: 'remote_access_identity_proof_failed',
  identity_key_invalid: 'remote_access_identity_proof_failed',
  pairing_identity_missing: 'remote_access_provisioning_failed',
  pairing_session_not_confirmed: 'remote_access_provisioning_failed',
  pairing_session_already_provisioned: 'remote_access_session_conflict',
  pairing_provisioning_conflict: 'remote_access_provisioning_failed',
  identity_revoked: 'remote_access_identity_mismatch',
};

// Fetch-Implementierung — injizierbar für Tests, Default ist Node-Fetch.
function defaultFetch(...args) {
  if (typeof fetch !== 'function') {
    throw new RemoteAccessError('remote_access_internal_error', 'Kein fetch verfügbar.');
  }
  return fetch(...args);
}

// Führt einen Relay-Aufruf mit Timeout, ohne Redirects und mit Größenlimit aus.
// Gibt { status, bodyText } zurück. Netzwerk-/Timeoutfehler werden als
// remote_access_relay_unavailable geworfen.
async function relayFetch(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error', // Redirects strikt verbieten (SSRF-/Umleitungsschutz).
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Timeout, Redirect, TLS- oder Verbindungsfehler — nach außen einheitlich.
    throw new RemoteAccessError(
      'remote_access_relay_unavailable',
      'Relay nicht erreichbar.',
      { cause: err && err.name }
    );
  }

  try {
    // 204 hat keinen Body.
    if (response.status === 204) {
      return { status: response.status, bodyText: '' };
    }
    const bodyText = await readLimitedText(response, MAX_RESPONSE_BYTES);
    return { status: response.status, bodyText };
  } catch (err) {
    if (err instanceof RemoteAccessError) throw err;
    throw new RemoteAccessError('remote_access_relay_unavailable', 'Relay-Antwort unlesbar.');
  } finally {
    clearTimeout(timer);
  }
}

// Liest den Response-Body als Text, bricht bei Überschreiten des Limits ab.
async function readLimitedText(response, maxBytes) {
  // Wenn der Server eine übergroße Content-Length meldet, sofort ablehnen.
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Relay-Antwort zu groß.');
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Relay-Antwort zu groß.');
  }
  return buf.toString('utf8');
}

function parseJson(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch (_) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Relay-Antwort ist kein gültiges JSON.');
  }
}

// Übersetzt eine Relay-Fehlerantwort (nicht-2xx) in einen internen Fehler.
function mapRelayError(status, bodyText) {
  let code = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.code === 'string') code = parsed.code;
  } catch (_) {
    /* Kein JSON-Body — allein anhand des HTTP-Status abbilden. */
  }
  if (code && RELAY_ERROR_MAP[code]) {
    return new RemoteAccessError(RELAY_ERROR_MAP[code], 'Relay meldete einen Fehler.');
  }
  if (status === 429) return new RemoteAccessError('remote_access_rate_limited', 'Rate-Limit erreicht.');
  if (status === 404) return new RemoteAccessError('remote_access_session_not_found', 'Session nicht gefunden.');
  if (status >= 500) return new RemoteAccessError('remote_access_relay_unavailable', 'Relay-Serverfehler.');
  return new RemoteAccessError('remote_access_invalid_response', `Unerwarteter Relay-Status ${status}.`);
}

function assertHttps(baseUrl) {
  if (!/^https:\/\//i.test(String(baseUrl))) {
    throw new RemoteAccessError('remote_access_internal_error', 'Relay-Basis-URL ist nicht HTTPS.');
  }
}

// Validiert und normalisiert die Erstellungsantwort des Relays.
function validateCreateResponse(data, baseUrl) {
  if (!data || typeof data !== 'object') {
    throw new RemoteAccessError('remote_access_invalid_response', 'Leere Relay-Antwort.');
  }

  rejectUnexpectedSecretFields(data, new Set(['claimToken', 'originToken']));
  if (Object.prototype.hasOwnProperty.call(data, 'pairingToken')) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Veraltetes pairingToken in Relay-Antwort.');
  }

  const { pairingId, claimToken, originToken, pairingUri, expiresAt, pollIntervalSeconds, qrCode } = data;

  if (typeof pairingId !== 'string' || !/^pr_[A-Za-z0-9_-]{4,}$/.test(pairingId)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültige pairingId.');
  }
  validateToken(claimToken, 'claimToken');
  validateToken(originToken, 'originToken');
  if (claimToken === originToken) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Tokenrollen sind nicht getrennt.');
  }
  const expiresMs = validateFutureDate(expiresAt);
  const pollSeconds = validatePollInterval(pollIntervalSeconds);
  validatePairingUri(pairingUri, pairingId, claimToken, originToken);

  if (!qrCode || typeof qrCode !== 'object') {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode fehlt.');
  }
  if (qrCode.mimeType !== 'image/png') {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode MIME-Type ist nicht image/png.');
  }
  const base64 = validateQrBase64(qrCode.base64);

  return {
    pairingId,
    originToken,
    expiresAt: new Date(expiresMs).toISOString(),
    expiresAtMs: expiresMs,
    pollIntervalSeconds: pollSeconds,
    qrCode: { mimeType: 'image/png', base64 },
  };
}

function validateToken(value, name) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) {
    throw new RemoteAccessError('remote_access_invalid_response', `Ungültiger ${name}.`);
  }
}

function rejectUnexpectedSecretFields(data, allowedTokenKeys = new Set()) {
  if (!data || typeof data !== 'object') return;
  for (const key of Object.keys(data)) {
    const lower = key.toLowerCase();
    if (allowedTokenKeys.has(key)) continue;
    if (lower === 'authorization' || lower === 'pairingtoken' || lower === 'claimanttoken' || lower === 'token' || lower.endsWith('token')) {
      throw new RemoteAccessError('remote_access_invalid_response', 'Unerwartetes Secret-Feld in Relay-Antwort.');
    }
  }
}

function validateFutureDate(value) {
  if (typeof value !== 'string') {
    throw new RemoteAccessError('remote_access_invalid_response', 'expiresAt fehlt.');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'expiresAt ist kein gültiges Datum.');
  }
  if (ms <= Date.now()) {
    throw new RemoteAccessError('remote_access_invalid_response', 'expiresAt liegt nicht in der Zukunft.');
  }
  return ms;
}

function validatePollInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_POLL_SECONDS || n > MAX_POLL_SECONDS) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pollIntervalSeconds außerhalb des Bereichs.');
  }
  return Math.round(n);
}

function validatePairingUri(uri, pairingId, claimToken, originToken) {
  if (typeof uri !== 'string') {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri fehlt.');
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch (_) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri ist keine gültige URI.');
  }
  // Schema exakt homeess:, Aktion pair, Version 1, passende id.
  if (parsed.protocol !== 'homeess:') {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri hat falsches Schema.');
  }
  const isPair = parsed.host === 'pair' || parsed.pathname === 'pair' || parsed.pathname === '//pair';
  if (!isPair) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri hat falsche Aktion.');
  }
  if (parsed.searchParams.get('v') !== PAIRING_URI_VERSION) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri hat falsche Version.');
  }
  const expectedParams = new Set(['v', 'relay', 'id', 'token']);
  for (const key of parsed.searchParams.keys()) {
    if (!expectedParams.has(key)) {
      throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri enthält unerwartete Parameter.');
    }
  }
  for (const key of expectedParams) {
    if (parsed.searchParams.getAll(key).length !== 1) {
      throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri enthält fehlende oder doppelte Parameter.');
    }
  }
  if (parsed.searchParams.get('id') !== pairingId) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri-id passt nicht.');
  }
  const token = parsed.searchParams.get('token');
  if (!token) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri ohne Token.');
  }
  if (token !== claimToken) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri enthält nicht den Claim-Token.');
  }
  if (originToken && uri.includes(originToken)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'pairingUri enthält den Origin-Token.');
  }
}

function validateQrBase64(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode.base64 fehlt.');
  }
  // data:-Präfix ist laut Spezifikation nicht erlaubt.
  if (/^data:/i.test(base64)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode.base64 enthält data:-Präfix.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode.base64 ist kein gültiges Base64.');
  }
  const decoded = Buffer.from(base64, 'base64');
  // Grober Roundtrip-Check: ungültiges Base64 dekodiert verlustbehaftet.
  if (decoded.length === 0 || decoded.length > MAX_PNG_BYTES) {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode-PNG hat unplausible Größe.');
  }
  if (!decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'qrCode ist kein PNG.');
  }
  return base64;
}

// Validiert die Status-/GET-Antwort.
function validateStatusResponse(data, pairingId) {
  if (!data || typeof data !== 'object') {
    throw new RemoteAccessError('remote_access_invalid_response', 'Leere Status-Antwort.');
  }
  rejectUnexpectedSecretFields(data);
  if (data.pairingId != null && data.pairingId !== pairingId) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Status-pairingId passt nicht.');
  }
  if (typeof data.status !== 'string' || !KNOWN_STATUS.has(data.status)) {
    // Unbekannte Statuswerte als internen Protokollfehler behandeln.
    throw new RemoteAccessError('remote_access_invalid_response', 'Unbekannter Pairing-Status.');
  }
  const status = data.status;
  let expiresAtMs = null;
  let expiresAt = null;
  if (data.expiresAt != null) {
    const ms = Date.parse(data.expiresAt);
    if (Number.isFinite(ms)) {
      expiresAtMs = ms;
      expiresAt = new Date(ms).toISOString();
    }
  }
  let remainingSeconds = 0;
  if (status === 'pending' || status === 'awaiting_confirmation') {
    const n = Number(data.remainingSeconds);
    remainingSeconds = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  const claim = validateClaimForStatus(data.claim, status);
  const identity = validateIdentityForStatus(data.identity, status);
  return { pairingId, status, expiresAt, expiresAtMs, remainingSeconds, claim, identity };
}

// Validiert den identity-Block, den Origin-/Claimant-Status bei `paired`
// enthält (Abschnitt 31). Nur bei `paired` erlaubt.
function validateIdentityForStatus(identity, status) {
  if (status !== 'paired') {
    if (identity != null) {
      throw new RemoteAccessError('remote_access_invalid_response', 'identity-Block nur bei paired erlaubt.');
    }
    return null;
  }
  return validateIdentityBlock(identity);
}

function validateIdentityBlock(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'identity-Block fehlt.');
  }
  const { instanceId, deviceId, instanceName, instanceFingerprint, deviceFingerprint } = identity;
  if (typeof instanceId !== 'string' || !/^ins_[A-Za-z0-9_-]{4,}$/.test(instanceId)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültige instanceId.');
  }
  if (typeof deviceId !== 'string' || !/^dev_[A-Za-z0-9_-]{4,}$/.test(deviceId)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültige deviceId.');
  }
  return {
    instanceId,
    deviceId,
    instanceName: typeof instanceName === 'string' ? instanceName.slice(0, 120) : null,
    instanceFingerprint: validateDisplayFingerprint(instanceFingerprint, 'instanceFingerprint'),
    deviceFingerprint: validateDisplayFingerprint(deviceFingerprint, 'deviceFingerprint'),
  };
}

// Fingerprint in Anzeige- oder Hex-Form: nur Hexziffern und Bindestriche,
// begrenzte Länge. Die kanonische Normalisierung erfolgt später im Store.
function validateDisplayFingerprint(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[0-9a-fA-F-]+$/.test(value)) {
    throw new RemoteAccessError('remote_access_invalid_response', `Ungültiger ${name}.`);
  }
  return value;
}

function validateClaimForStatus(claim, status) {
  if (status !== 'awaiting_confirmation') {
    if (claim != null) {
      throw new RemoteAccessError('remote_access_invalid_response', 'Claim-Daten nur bei awaiting_confirmation erlaubt.');
    }
    return null;
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Claim-Daten fehlen.');
  }
  const allowed = new Set(['deviceName', 'platform', 'appVersion', 'claimedAt', 'deviceIdentity']);
  for (const key of Object.keys(claim)) {
    if (!allowed.has(key)) {
      throw new RemoteAccessError('remote_access_invalid_response', 'Unerwartetes Feld in Claim-Daten.');
    }
  }
  rejectUnexpectedSecretFields(claim);
  const { deviceName, platform, appVersion, claimedAt, deviceIdentity } = claim;
  if (typeof deviceName !== 'string' || deviceName.length < 1 || deviceName.length > 100) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültiger Gerätename.');
  }
  if (typeof platform !== 'string' || platform.length < 1 || platform.length > 50 || platform !== 'android') {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültige Plattform.');
  }
  if (typeof appVersion !== 'string' || appVersion.length < 1 || appVersion.length > 50) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültige App-Version.');
  }
  const claimedAtMs = Date.parse(claimedAt);
  if (typeof claimedAt !== 'string' || !Number.isFinite(claimedAtMs)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültiger Claim-Zeitpunkt.');
  }
  // Gerätefingerprint aus deviceIdentity (Abschnitt 27.5). Wird für den
  // Instanz-Proof (devicePublicKeyFingerprint) und die Provisioning-Konsistenz
  // benötigt. Der Relay gibt standardmäßig nur den Fingerprint aus, nicht den
  // vollständigen Public Key.
  if (!deviceIdentity || typeof deviceIdentity !== 'object' || Array.isArray(deviceIdentity)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Claim ohne deviceIdentity.');
  }
  for (const key of Object.keys(deviceIdentity)) {
    if (key !== 'algorithm' && key !== 'fingerprint') {
      throw new RemoteAccessError('remote_access_invalid_response', 'Unerwartetes Feld in deviceIdentity.');
    }
  }
  if (deviceIdentity.algorithm !== 'Ed25519') {
    throw new RemoteAccessError('remote_access_invalid_response', 'deviceIdentity: falscher Algorithmus.');
  }
  const deviceFingerprint = validateDisplayFingerprint(deviceIdentity.fingerprint, 'deviceIdentity.fingerprint');
  return {
    deviceName,
    platform,
    appVersion,
    claimedAt: new Date(claimedAtMs).toISOString(),
    deviceFingerprint,
  };
}

async function expectNoContent(fetchImpl, url, originToken, timeoutMs) {
  const { status, bodyText } = await relayFetch(
    fetchImpl,
    url,
    { method: 'POST', headers: { Authorization: `Pairing-Origin ${originToken}` } },
    timeoutMs
  );
  if (status === 204) return { ok: true };
  throw mapRelayError(status, bodyText);
}

// ---- Öffentliche Client-Fabrik --------------------------------------------

function createRelayClient({ baseUrl, fetchImpl = defaultFetch } = {}) {
  assertHttps(baseUrl);
  const root = String(baseUrl).replace(/\/+$/, '');

  async function createPairingSession({ instanceName } = {}) {
    const body = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, instanceName: instanceName || 'homeESS' });
    // Bewusst KEIN Authorization-Header beim Erstellen.
    const { status, bodyText } = await relayFetch(
      fetchImpl,
      `${root}/api/v1/pairing/sessions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body },
      TIMEOUT_CREATE_MS
    );
    if (status !== 201) throw mapRelayError(status, bodyText);
    return validateCreateResponse(parseJson(bodyText), root);
  }

  async function readPairingSessionStatus({ pairingId, originToken }) {
    const { status, bodyText } = await relayFetch(
      fetchImpl,
      `${root}/api/v1/pairing/sessions/${encodeURIComponent(pairingId)}`,
      { method: 'GET', headers: { Accept: 'application/json', Authorization: `Pairing-Origin ${originToken}` } },
      TIMEOUT_STATUS_MS
    );
    if (status !== 200) throw mapRelayError(status, bodyText);
    return validateStatusResponse(parseJson(bodyText), pairingId);
  }

  async function cancelPairingSession({ pairingId, originToken }) {
    const { status, bodyText } = await relayFetch(
      fetchImpl,
      `${root}/api/v1/pairing/sessions/${encodeURIComponent(pairingId)}`,
      { method: 'DELETE', headers: { Authorization: `Pairing-Origin ${originToken}` } },
      TIMEOUT_CANCEL_MS
    );
    if (status === 204) return { ok: true };
    throw mapRelayError(status, bodyText);
  }

  // Bestätigung mit Instanz-Proof (Abschnitt 27.6/28.2). Der Body enthält die
  // Instanzidentität (Public Key + Proof); der private Schlüssel bleibt lokal.
  async function confirmPairingSession({ pairingId, originToken, instanceName, instanceIdentity }) {
    if (!instanceIdentity || typeof instanceIdentity !== 'object'
      || typeof instanceIdentity.publicKey !== 'string'
      || typeof instanceIdentity.proof !== 'string') {
      throw new RemoteAccessError('remote_access_identity_proof_failed', 'Instanz-Proof unvollständig.');
    }
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      instanceName: instanceName || 'homeESS',
      instanceIdentity: {
        algorithm: 'Ed25519',
        publicKey: instanceIdentity.publicKey,
        proof: instanceIdentity.proof,
      },
    });
    const { status, bodyText } = await relayFetch(
      fetchImpl,
      `${root}/api/v1/pairing/sessions/${encodeURIComponent(pairingId)}/confirm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Pairing-Origin ${originToken}`,
        },
        body,
      },
      TIMEOUT_DECISION_MS
    );
    if (status === 204) return { ok: true };
    throw mapRelayError(status, bodyText);
  }

  async function rejectPairingSession({ pairingId, originToken }) {
    return expectNoContent(fetchImpl, `${root}/api/v1/pairing/sessions/${encodeURIComponent(pairingId)}/reject`, originToken, TIMEOUT_DECISION_MS);
  }

  // Provisioning (Abschnitt 30). Kein Body; erwartet 200 mit strengem Schema.
  // Idempotent: ein erneuter Aufruf einer bereits `paired` Session liefert
  // dasselbe Ergebnis.
  async function provisionPairingSession({ pairingId, originToken }) {
    const { status, bodyText } = await relayFetch(
      fetchImpl,
      `${root}/api/v1/pairing/sessions/${encodeURIComponent(pairingId)}/provision`,
      { method: 'POST', headers: { Accept: 'application/json', Authorization: `Pairing-Origin ${originToken}` } },
      TIMEOUT_PROVISION_MS
    );
    if (status !== 200) throw mapRelayError(status, bodyText);
    return validateProvisionResponse(parseJson(bodyText), pairingId);
  }

  // Capabilities des Relay (Abschnitt 7/36). Nur zur Kompatibilitätsprüfung.
  async function getCapabilities() {
    const { status, bodyText } = await relayFetch(
      fetchImpl,
      `${root}/api/v1/capabilities`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      TIMEOUT_CAPS_MS
    );
    if (status !== 200) throw mapRelayError(status, bodyText);
    return validateCapabilities(parseJson(bodyText));
  }

  return {
    createPairingSession,
    readPairingSessionStatus,
    cancelPairingSession,
    confirmPairingSession,
    rejectPairingSession,
    provisionPairingSession,
    getCapabilities,
    baseUrl: root,
  };
}

// Validiert die Provisioning-Antwort (Abschnitt 30). Gibt nur öffentliche,
// nicht-geheime Felder zurück; Fingerprints in Anzeigeform.
function validateProvisionResponse(data, pairingId) {
  if (!data || typeof data !== 'object') {
    throw new RemoteAccessError('remote_access_invalid_response', 'Leere Provisioning-Antwort.');
  }
  rejectUnexpectedSecretFields(data);
  if (data.pairingId != null && data.pairingId !== pairingId) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Provisioning-pairingId passt nicht.');
  }
  if (data.status !== 'paired') {
    throw new RemoteAccessError('remote_access_invalid_response', 'Provisioning-Status ist nicht paired.');
  }
  const instance = validateProvisionParty(data.instance, 'ins_', 'instance');
  const device = validateProvisionParty(data.device, 'dev_', 'device');
  const pairedAtMs = Date.parse(data.pairedAt);
  if (typeof data.pairedAt !== 'string' || !Number.isFinite(pairedAtMs)) {
    throw new RemoteAccessError('remote_access_invalid_response', 'Ungültiges pairedAt.');
  }
  return {
    pairingId,
    status: 'paired',
    instance,
    device,
    pairedAt: new Date(pairedAtMs).toISOString(),
  };
}

function validateProvisionParty(party, idPrefix, name) {
  if (!party || typeof party !== 'object' || Array.isArray(party)) {
    throw new RemoteAccessError('remote_access_invalid_response', `${name}-Block fehlt.`);
  }
  rejectUnexpectedSecretFields(party);
  const idKey = name === 'instance' ? 'instanceId' : 'deviceId';
  const id = party[idKey];
  const idRe = new RegExp(`^${idPrefix}[A-Za-z0-9_-]{4,}$`);
  if (typeof id !== 'string' || !idRe.test(id)) {
    throw new RemoteAccessError('remote_access_invalid_response', `Ungültige ${idKey}.`);
  }
  if (party.algorithm !== 'Ed25519') {
    throw new RemoteAccessError('remote_access_invalid_response', `${name}: falscher Algorithmus.`);
  }
  const fingerprint = validateDisplayFingerprint(party.fingerprint, `${name}.fingerprint`);
  const result = { algorithm: 'Ed25519', fingerprint };
  result[idKey] = id;
  if (party.name != null) {
    if (typeof party.name !== 'string' || party.name.length > 100) {
      throw new RemoteAccessError('remote_access_invalid_response', `${name}: ungültiger Name.`);
    }
    result.name = party.name;
  }
  if (name === 'device') {
    if (party.platform != null) {
      if (typeof party.platform !== 'string' || party.platform.length > 50) {
        throw new RemoteAccessError('remote_access_invalid_response', 'device: ungültige Plattform.');
      }
      result.platform = party.platform;
    }
  }
  return result;
}

function validateCapabilities(data) {
  if (!data || typeof data !== 'object') {
    throw new RemoteAccessError('remote_access_invalid_response', 'Leere Capability-Antwort.');
  }
  const pick = (key) => (typeof data[key] === 'boolean' ? data[key] : false);
  return {
    pairingIdentityProvisioning: pick('pairingIdentityProvisioning'),
    identityAuthentication: pick('identityAuthentication'),
    relay: pick('relay'),
    transportProtocolVersions: Array.isArray(data.transportProtocolVersions)
      ? data.transportProtocolVersions.filter((v) => typeof v === 'string').slice(0, 16)
      : [],
  };
}

module.exports = {
  createRelayClient,
  // Für Tests / gezielte Wiederverwendung offengelegt.
  _internal: {
    validateCreateResponse,
    validateStatusResponse,
    validateProvisionResponse,
    validateCapabilities,
    validateIdentityBlock,
    validatePairingUri,
    validateQrBase64,
    mapRelayError,
    RELAY_ERROR_MAP,
    PROTOCOL_VERSION,
    MIN_POLL_SECONDS,
    MAX_POLL_SECONDS,
  },
};
