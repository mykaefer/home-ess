'use strict';

// Reine (zustandslose) Kryptografie-Helfer für die dauerhafte homeESS-Instanz-
// identität. Bewusst OHNE Dateisystem- oder Netzwerkzugriff, damit die
// kanonische Serialisierung, die Fingerprint-Berechnung und die Signatur
// isoliert gegen die Testvektoren aus HOMEESS_TRANSPORT_API.md (Abschnitt 38)
// geprüft werden können.
//
// Es wird ausschließlich Ed25519 über Node.js `crypto` verwendet — keine
// eigene Kurven- oder Signaturimplementierung.

const crypto = require('crypto');

const ALGORITHM = 'Ed25519';

// Präfixzeilen der kanonischen Nutzlasten (Abschnitt 28.2 / 33). Bewusst als
// Konstanten, damit ein Tippfehler die Testvektoren sofort brechen lässt.
const INSTANCE_PROOF_PREFIX = 'homeess-instance-pairing-proof-v1';
const AUTH_PREFIX = 'homeess-auth-v1';

// ---- Low-Level-Hashing ------------------------------------------------------

// SHA-256 über die exakten UTF-8-Bytes eines Strings -> lowercase Hex.
function sha256HexUtf8(value) {
  if (typeof value !== 'string') {
    throw new TypeError('sha256HexUtf8 erwartet einen String.');
  }
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

// SHA-256 über beliebige Bytes -> lowercase Hex.
function sha256HexBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- Fingerprints -----------------------------------------------------------

// Lowercase-Hex-Fingerprint (64 Zeichen) über die kanonischen SPKI-DER-Bytes.
// Nur diese Form gehört in signierte Nutzlasten (Abschnitt 29).
function fingerprintHexFromSpkiDer(spkiDer) {
  return sha256HexBytes(spkiDer);
}

// Gruppierte Anzeigeform (Großbuchstaben, 4er-Blöcke mit Bindestrich). Nur für
// UI/Diagnose. Standardmäßig auf die ersten 8 Blöcke (32 Hexzeichen) gekürzt,
// wie sie der Relay ebenfalls anzeigt; mit { full: true } vollständige Form.
function fingerprintDisplayFromHex(hex, { full = false } = {}) {
  const norm = String(hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(norm)) {
    throw new Error('Fingerprint-Hex ist nicht 64 Hexzeichen lang.');
  }
  const upper = norm.toUpperCase();
  const slice = full ? upper : upper.slice(0, 32);
  return slice.match(/.{1,4}/g).join('-');
}

// Normalisiert einen möglicherweise gruppiert/angezeigten Fingerprint (z. B.
// "ABCD-EF12-...") in die kanonische 64-stellige Lowercase-Hex-Form. Nur wenn
// nach Entfernen der Bindestriche exakt 64 Hexzeichen übrig bleiben; alles
// andere wird strikt abgelehnt (keine tolerante Interpretation).
function normalizeFingerprintHex(value) {
  if (typeof value !== 'string') {
    throw new Error('Fingerprint fehlt.');
  }
  const stripped = value.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(stripped)) {
    throw new Error('Fingerprint hat nicht exakt 64 Hexzeichen.');
  }
  return stripped;
}

// Lockere Normalisierung eines extern gemeldeten Fingerprints (Anzeige- ODER
// Hex-Form, ggf. auf einen Präfix gekürzt, wie ihn der Relay anzeigt): entfernt
// Bindestriche, lowercase, verlangt gerade Hexlänge zwischen 8 und 64 Zeichen.
// Keine tolerante Interpretation sonstiger Zeichen.
function normalizeFingerprintLoose(value) {
  if (typeof value !== 'string') {
    throw new Error('Fingerprint fehlt.');
  }
  const stripped = value.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(stripped) || stripped.length < 8 || stripped.length > 64 || stripped.length % 2 !== 0) {
    throw new Error('Fingerprint ist keine gültige (ggf. gekürzte) Hexform.');
  }
  return stripped;
}

// Prüft, ob ein extern gemeldeter (evtl. gekürzter) Fingerprint zum kanonischen
// lokalen 64-Hex-Fingerprint passt: bei voller Länge exakte Gleichheit, sonst
// Präfix-Übereinstimmung. So bleibt die Bindung an den lokalen Schlüssel auch
// dann prüfbar, wenn der Relay nur eine gekürzte Anzeigeform liefert.
function fingerprintMatchesHex(reportedDisplayOrHex, canonicalHex) {
  const canonical = String(canonicalHex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(canonical)) return false;
  let reported;
  try {
    reported = normalizeFingerprintLoose(reportedDisplayOrHex);
  } catch (_) {
    return false;
  }
  return reported.length === 64 ? reported === canonical : canonical.startsWith(reported);
}

// Prüft zwei extern gemeldete (evtl. gekürzte) Fingerprints auf Konsistenz:
// der kürzere muss Präfix des längeren sein.
function fingerprintsConsistent(a, b) {
  let na;
  let nb;
  try {
    na = normalizeFingerprintLoose(a);
    nb = normalizeFingerprintLoose(b);
  } catch (_) {
    return false;
  }
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return longer.startsWith(shorter);
}

// ---- Schlüssel-Handling -----------------------------------------------------

// Importiert einen öffentlichen Ed25519-Schlüssel aus striktem SPKI-DER-Base64
// und re-exportiert die kanonischen Bytes. Wirft bei falschem Format/Typ.
function importPublicKeyFromSpkiBase64(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('publicKey ist kein striktes Base64.');
  }
  const der = Buffer.from(base64, 'base64');
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('publicKey ist kein Ed25519-Schlüssel.');
  }
  return key;
}

// Kanonische SPKI-DER-Bytes eines öffentlichen KeyObject.
function exportPublicSpkiDer(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' });
}

// Kanonisches SPKI-DER-Base64 eines öffentlichen KeyObject.
function exportPublicSpkiBase64(publicKey) {
  return exportPublicSpkiDer(publicKey).toString('base64');
}

// ---- Kanonische Nutzlasten --------------------------------------------------

// Instanz-Proof-Nutzlast (Confirm, Abschnitt 28.2). LF-getrennt, UTF-8, keine
// abschließende Leerzeile, exakte Reihenfolge; nur lowercase-Hex-Werte.
function buildInstanceProofPayload({
  pairingId,
  originTokenHashHex,
  instanceFingerprintHex,
  deviceFingerprintHex,
}) {
  assertHex64(originTokenHashHex, 'originTokenHash');
  assertHex64(instanceFingerprintHex, 'instancePublicKeyFingerprint');
  assertHex64(deviceFingerprintHex, 'devicePublicKeyFingerprint');
  if (typeof pairingId !== 'string' || !pairingId) {
    throw new Error('pairingId fehlt für Instanz-Proof.');
  }
  return [
    INSTANCE_PROOF_PREFIX,
    `pairingId=${pairingId}`,
    `originTokenHash=${originTokenHashHex}`,
    `instancePublicKeyFingerprint=${instanceFingerprintHex}`,
    `devicePublicKeyFingerprint=${deviceFingerprintHex}`,
  ].join('\n');
}

// Auth-Nutzlast der WebSocket-Challenge-Response (Abschnitt 33). Werte exakt
// wie aus der Challenge/`hello`, ohne Normalisierung.
function buildAuthPayload({
  challengeId,
  nonce,
  issuedAt,
  expiresAt,
  protocolVersion,
  clientType,
  identityId,
}) {
  for (const [k, v] of Object.entries({
    challengeId,
    nonce,
    issuedAt,
    expiresAt,
    protocolVersion,
    clientType,
    identityId,
  })) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`Auth-Nutzlast: Feld ${k} fehlt.`);
    }
  }
  return [
    AUTH_PREFIX,
    `challengeId=${challengeId}`,
    `nonce=${nonce}`,
    `issuedAt=${issuedAt}`,
    `expiresAt=${expiresAt}`,
    `protocolVersion=${protocolVersion}`,
    `clientType=${clientType}`,
    `identityId=${identityId}`,
  ].join('\n');
}

function assertHex64(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} ist kein lowercase-Hex mit 64 Zeichen.`);
  }
}

// ---- Signatur ---------------------------------------------------------------

// Signiert eine kanonische UTF-8-Nutzlast mit einem privaten Ed25519-KeyObject
// und gibt die Base64-Signatur zurück.
function signPayload(privateKey, payload) {
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return sig.toString('base64');
}

// Verifiziert eine Base64-Signatur gegen ein öffentliches Ed25519-KeyObject.
function verifyPayload(publicKey, payload, signatureBase64) {
  let sig;
  try {
    sig = Buffer.from(signatureBase64, 'base64');
  } catch (_) {
    return false;
  }
  try {
    return crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, sig);
  } catch (_) {
    return false;
  }
}

module.exports = {
  ALGORITHM,
  INSTANCE_PROOF_PREFIX,
  AUTH_PREFIX,
  sha256HexUtf8,
  sha256HexBytes,
  fingerprintHexFromSpkiDer,
  fingerprintDisplayFromHex,
  normalizeFingerprintHex,
  normalizeFingerprintLoose,
  fingerprintMatchesHex,
  fingerprintsConsistent,
  importPublicKeyFromSpkiBase64,
  exportPublicSpkiDer,
  exportPublicSpkiBase64,
  buildInstanceProofPayload,
  buildAuthPayload,
  signPayload,
  verifyPayload,
};
