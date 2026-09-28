'use strict';

// Gemeinsame Bearer-Prüfung der States API. Genutzt von den HTTP-Endpunkten
// unter /api/v1 (routes/states-api.js) und vom Audio-Bus-WebSocket
// (audio-bus/ws-server.js): Beide akzeptieren exakt dieselben Tokens unter
// denselben Regeln (API eingeschaltet, Token gültig, nicht abgelaufen,
// Credential-Version aktuell). Es gibt keinen zweiten Zugang.

const crypto = require('crypto');
const apiConfig = require('./config');
const tokens = require('./tokens');

// Token aus einem Authorization-Header („Bearer <token>“). Query-Parameter und
// Cookies werden bewusst nicht akzeptiert (STATES-API.md, Abschnitt 3).
function bearerFromHeader(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  return match ? match[1] : null;
}

// Nicht umkehrbare Kurzkennung eines Tokens. Ordnet Audio-Sessions dem
// ausstellenden Token zu, ohne das Token selbst aufzubewahren.
function tokenId(token) {
  return crypto.createHash('sha256').update(`homeess-client:${token}`).digest('hex').slice(0, 16);
}

// Ergebnis: { ok: true, token, tokenId, expiresAt }
//        oder { ok: false, code } mit code aus
//        api_disabled | unauthorized | token_invalid | token_expired
function verifyAuthorization(header) {
  if (!apiConfig.isActive()) return { ok: false, code: 'api_disabled' };
  const token = bearerFromHeader(header);
  if (!header || !token) return { ok: false, code: 'unauthorized' };
  return verifyToken(token);
}

// Ein bereits angenommenes Token erneut prüfen (z. B. periodisch für eine
// offene WebSocket-Verbindung): Passwortänderung, Logout, Ablauf und
// Abschalten der API entziehen die Berechtigung sofort.
function verifyToken(token) {
  if (!apiConfig.isActive()) return { ok: false, code: 'api_disabled' };
  const result = tokens.verify(token, apiConfig.get().credentialVersion);
  if (result.status === 'expired') return { ok: false, code: 'token_expired' };
  if (result.status !== 'valid') return { ok: false, code: 'token_invalid' };
  return { ok: true, token, tokenId: tokenId(token), expiresAt: result.expiresAt };
}

module.exports = { bearerFromHeader, verifyAuthorization, verifyToken, tokenId };
