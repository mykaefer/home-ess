'use strict';

// Redaction- und Logging-Helfer für den Fernzugriff.
//
// Es dürfen NIE geloggt werden: Claim-/Origin-/Claimant-/Pairing-Token,
// Pairing-URI, QR-Base64, Authorization-Header, Data-URLs, das komplette
// Session-Objekt oder die volle Relay-Antwort. Dieser Helfer stellt sicher,
// dass nur zulässige Metadaten
// (öffentliche Pairing-ID, Status, Fehlercode, Dauer, Zeitstempel) den Weg ins
// Log finden — auch wenn versehentlich mehr übergeben wird.

const SENSITIVE_KEYS = new Set([
  'pairingtoken',
  'claimtoken',
  'origintoken',
  'claimanttoken',
  'pairinguri',
  'authorization',
  'token',
  'base64',
  'qrcode',
  'qr',
  // Dauerhafte Identität / WebSocket-Auth (essrelay 0.5.0).
  'privatekey',
  'instanceprivatekey',
  'deviceprivatekey',
  'publickey',
  'publickeyspkibase64',
  'signature',
  'proof',
  'nonce',
  'challenge',
  'secret',
]);

const REDACTED = '[redigiert]';

// Ersetzt sensible Felder rekursiv durch einen Platzhalter. Robuster Fallback,
// falls doch einmal ein reichhaltiges Objekt in einen Log-Aufruf gerät.
function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (typeof value === 'string') {
    // Data-URLs und offensichtliche base64-PNG-Blobs nicht ausgeben.
    if (/^data:/i.test(value)) return REDACTED;
    if (value.length > 256) return `${value.slice(0, 16)}…[gekürzt]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// Einheitliches, redigiertes Log für Fernzugriff-Ereignisse.
function log(event, meta) {
  const safe = meta ? redact(meta) : undefined;
  const suffix = safe ? ` ${JSON.stringify(safe)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[remote-access] ${event}${suffix}`);
}

module.exports = { redact, log, REDACTED };
