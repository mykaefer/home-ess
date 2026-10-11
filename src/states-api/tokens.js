'use strict';

// Bearer-Tokens der States API.
//
// Ein Token sind 32 zufällige Bytes (crypto.randomBytes, base64url). Der Server
// hält ausschließlich den SHA-256-Hash im Speicher — das Token selbst wird nach
// der Ausgabe nirgends aufbewahrt, nie persistiert und nie geloggt. Jeder
// Eintrag trägt Ablaufzeit und die Credential-Version, mit der er ausgestellt
// wurde: Ändert sich das Passwort, passt die Version nicht mehr und das Token
// ist ungültig. Nach einem Neustart von homeESS melden sich Clients neu an.

const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
// Obergrenze gleichzeitig gültiger Tokens. Darüber verdrängt ein neues Token
// das älteste, damit wiederholte Anmeldungen den Speicher nicht füllen.
const MAX_TOKENS = 100;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// Abgelaufene Einträge bleiben kurz erkennbar, damit ein Client
// „token_expired“ statt „token_invalid“ erhält und gezielt neu anmelden kann.
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

const tokens = new Map();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function prune(now = Date.now()) {
  for (const [key, entry] of tokens) {
    if (entry.expiresAt + EXPIRED_GRACE_MS < now) tokens.delete(key);
  }
}

function issue(credentialVersion, now = Date.now()) {
  prune(now);
  while (tokens.size >= MAX_TOKENS) {
    const oldest = tokens.keys().next().value;
    tokens.delete(oldest);
  }
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = now + TOKEN_TTL_MS;
  tokens.set(hashToken(token), { expiresAt, credentialVersion });
  return { token, expiresAt, expiresIn: Math.round(TOKEN_TTL_MS / 1000) };
}

// Ergebnis: { status: 'valid' | 'expired' | 'invalid', expiresAt? }
function verify(token, credentialVersion, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { status: 'invalid' };
  const key = hashToken(token);
  const entry = tokens.get(key);
  if (!entry) return { status: 'invalid' };
  if (entry.credentialVersion !== credentialVersion) {
    tokens.delete(key);
    return { status: 'invalid' };
  }
  if (entry.expiresAt <= now) return { status: 'expired' };
  return { status: 'valid', expiresAt: entry.expiresAt };
}

function revoke(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  return tokens.delete(hashToken(token));
}

// Alle Tokens verwerfen (Passwortänderung, API ausgeschaltet).
function revokeAll() {
  tokens.clear();
}

function count() {
  return tokens.size;
}

module.exports = { TOKEN_TTL_MS, MAX_TOKENS, issue, verify, revoke, revokeAll, count };
