'use strict';

// States API v1 (Dokumentation: STATES-API.md) und die zugehörigen
// Einstellungs-Endpunkte des States-Katalogs.
//
// Die API ist eine reine Zugriffsschicht: Gelesen wird aus dem zentralen
// State-Baum (states/repository), geschrieben über mqttClient.publish() —
// denselben Weg wie die States-Seite und Aktionsfolgen. Anmeldung über das
// API-Passwort (Einstellungen → States API), danach Bearer-Token. Cookie-
// Sessions der Weboberfläche spielen für /api/v1 keine Rolle.

const express = require('express');
const { requireAuth } = require('../auth/session');
const { verifyPassword } = require('../auth/password');
const mqttClient = require('../mqtt/client');
const { invalidateStates } = require('../states/repository');
const apiConfig = require('../states-api/config');
const tokens = require('../states-api/tokens');
const rateLimit = require('../states-api/rate-limit');
const catalog = require('../states-api/catalog');
const apiAuth = require('../states-api/auth');

const API_BASE = '/api/v1';
const MAX_TOPIC_LENGTH = 1000;
const MAX_QUERY_LENGTH = 120;
const MAX_LIMIT = 5000;

const ERROR_STATUS = {
  api_disabled: 403,
  unauthorized: 401,
  invalid_credentials: 401,
  token_invalid: 401,
  token_expired: 401,
  too_many_attempts: 429,
  access_denied: 403,
  state_not_found: 404,
  folder_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  upgrade_required: 426,
  state_not_writable: 403,
  invalid_value: 422,
  invalid_request: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  write_failed: 502,
  internal_error: 500,
};

const ERROR_MESSAGES = {
  api_disabled: 'Die States API ist deaktiviert.',
  unauthorized: 'Anmeldung erforderlich. Bearer-Token im Authorization-Header senden.',
  invalid_credentials: 'Das API-Passwort ist falsch.',
  token_invalid: 'Das Zugriffstoken ist ungültig.',
  token_expired: 'Das Zugriffstoken ist abgelaufen. Bitte neu anmelden.',
  too_many_attempts: 'Zu viele fehlgeschlagene Anmeldungen. Bitte später erneut versuchen.',
  access_denied: 'Zugriff verweigert.',
  state_not_found: 'Dieser State existiert nicht.',
  folder_not_found: 'Dieses Verzeichnis existiert nicht.',
  not_found: 'Diesen Endpunkt gibt es nicht.',
  method_not_allowed: 'Diese Methode ist für den Endpunkt nicht erlaubt.',
  upgrade_required: 'Dieser Endpunkt ist ein WebSocket (Audio Bus). Verbindung per WebSocket-Upgrade aufbauen.',
  state_not_writable: 'Dieser State ist nicht beschreibbar.',
  invalid_value: 'Der Wert ist ungültig.',
  invalid_request: 'Die Anfrage ist ungültig.',
  unsupported_media_type: 'Der Request-Body muss als application/json gesendet werden.',
  payload_too_large: 'Der Request-Body ist zu groß.',
  write_failed: 'Der Wert konnte nicht geschrieben werden.',
  internal_error: 'Interner Fehler.',
};

function log(message) {
  console.log(`[states-api] ${message}`);
}

function sendError(res, code, message, extraHeaders = {}) {
  const status = ERROR_STATUS[code] || 500;
  res.set('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders)) res.set(name, value);
  if (status === 401) res.set('WWW-Authenticate', `Bearer realm="homeESS States API"${code === 'token_expired' || code === 'token_invalid' ? `, error="invalid_token"` : ''}`);
  return res.status(status).json({ error: code, message: message || ERROR_MESSAGES[code] || ERROR_MESSAGES.internal_error });
}

function sendData(res, status, body) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

// Adresse des Clients für das Rate-Limit. Ohne konfiguriertes „trust proxy“
// ist das die Socket-Adresse; ein X-Forwarded-For wird bewusst ignoriert, weil
// ein Client ihn frei setzen könnte.
function clientAddress(req) {
  return String((req.socket && req.socket.remoteAddress) || 'unknown');
}

function bearerToken(req) {
  return apiAuth.bearerFromHeader(req.get('Authorization'));
}

// Middleware: API eingeschaltet?
function requireEnabled(_req, res, next) {
  if (!apiConfig.isActive()) return sendError(res, 'api_disabled');
  return next();
}

// Middleware: gültiges Bearer-Token?
// Dieselbe Prüfung nutzt der Audio-Bus-WebSocket (states-api/auth.js).
function requireToken(req, res, next) {
  const result = apiAuth.verifyAuthorization(req.get('Authorization'));
  if (!result.ok) return sendError(res, result.code);
  return next();
}

// Methoden, die ein Endpunkt nicht kennt, mit 405 beantworten.
function onlyMethods(router, path, methods) {
  router.all(path, (req, res) => {
    res.set('Allow', methods.join(', '));
    return sendError(res, 'method_not_allowed');
  });
}

function textParam(value, maxLength) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  return value.length > maxLength ? null : value;
}

function intParam(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null;
  const number = Number(value);
  return number < min || number > max ? null : number;
}

function statesApiRoutes(db) {
  const router = express.Router();

  const view = async () => catalog.apiView(await catalog.loadIndex(db, mqttClient.getCache()), apiConfig.get());

  // Kurzinfo ohne Anmeldung: ob die API bereitsteht und welche Version sie
  // spricht. Sie verrät keine States und keine Systemdetails.
  router.get(API_BASE, (_req, res) => sendData(res, 200, {
    name: 'homeESS States API',
    version: 'v1',
    enabled: apiConfig.isActive(),
  }));
  onlyMethods(router, API_BASE, ['GET']);

  // ── Anmeldung ────────────────────────────────────────────────────────────
  router.post(`${API_BASE}/auth`, requireEnabled, (req, res) => {
    const client = clientAddress(req);
    const gate = rateLimit.check(client);
    if (!gate.allowed) {
      return sendError(res, 'too_many_attempts', null, { 'Retry-After': String(gate.retryAfterSeconds) });
    }
    if (!req.is('application/json')) return sendError(res, 'unsupported_media_type');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    const password = body ? body.password : undefined;
    if (typeof password !== 'string' || !password || password.length > apiConfig.MAX_PASSWORD_LENGTH) {
      return sendError(res, 'invalid_request', 'Das Feld password fehlt oder ist ungültig.');
    }
    let valid = false;
    try {
      valid = verifyPassword(password, apiConfig.passwordHash());
    } catch (_) {
      valid = false;
    }
    if (!valid) {
      const result = rateLimit.recordFailure(client);
      if (result.locked) log(`Anmeldung von ${client} nach ${result.failures} Fehlversuchen für ${Math.round(rateLimit.LOCK_MS / 60000)} Minuten gesperrt.`);
      else if (result.failures >= 3) log(`Wiederholt fehlgeschlagene Anmeldung von ${client} (${result.failures} Versuche).`);
      if (result.global) log(`Anmeldungen wegen zu vieler Fehlversuche für ${Math.round(rateLimit.LOCK_MS / 60000)} Minuten gesperrt.`);
      return sendError(res, 'invalid_credentials');
    }
    rateLimit.recordSuccess(client);
    const issued = tokens.issue(apiConfig.get().credentialVersion);
    return sendData(res, 200, {
      token: issued.token,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
      expiresAt: new Date(issued.expiresAt).toISOString(),
    });
  });
  onlyMethods(router, `${API_BASE}/auth`, ['POST']);

  // Token vorzeitig verwerfen (Abmelden).
  router.post(`${API_BASE}/auth/logout`, requireEnabled, requireToken, (req, res) => {
    tokens.revoke(bearerToken(req));
    return res.status(204).set('Cache-Control', 'no-store').end();
  });
  onlyMethods(router, `${API_BASE}/auth/logout`, ['POST']);

  // ── Verzeichnisse ────────────────────────────────────────────────────────
  router.get(`${API_BASE}/folders`, requireEnabled, requireToken, async (req, res, next) => {
    try {
      const path = textParam(req.query.path, MAX_TOPIC_LENGTH);
      if (path == null) return sendError(res, 'invalid_request', 'Der Parameter path ist ungültig.');
      const current = await view();
      const node = current.findFolder(path);
      if (!node) return sendError(res, 'folder_not_found');
      return sendData(res, 200, current.listFolder(node));
    } catch (error) {
      return next(error);
    }
  });
  onlyMethods(router, `${API_BASE}/folders`, ['GET']);

  // ── State-Liste (flach, optional je Verzeichnis, Suche, Seiten) ──────────
  router.get(`${API_BASE}/states`, requireEnabled, requireToken, async (req, res, next) => {
    try {
      const path = textParam(req.query.path, MAX_TOPIC_LENGTH);
      const query = textParam(req.query.q, MAX_QUERY_LENGTH);
      const offset = intParam(req.query.offset, 0, 0, 1e9);
      const limit = intParam(req.query.limit, MAX_LIMIT, 1, MAX_LIMIT);
      if (path == null || query == null || offset == null || limit == null) {
        return sendError(res, 'invalid_request', 'Ein Abfrageparameter ist ungültig.');
      }
      const current = await view();
      const node = current.findFolder(path);
      if (!node) return sendError(res, 'folder_not_found');
      let entries = current.allStates(node).map(current.serializeState);
      const needle = query.trim().toLocaleLowerCase('de');
      if (needle) {
        entries = entries.filter((state) =>
          `${state.topic}\n${state.name}\n${state.folder}`.toLocaleLowerCase('de').includes(needle));
      }
      return sendData(res, 200, {
        path: node.path,
        total: entries.length,
        offset,
        limit,
        states: entries.slice(offset, offset + limit),
      });
    } catch (error) {
      return next(error);
    }
  });
  onlyMethods(router, `${API_BASE}/states`, ['GET']);

  // ── Einzelner State ──────────────────────────────────────────────────────
  // Das Topic enthält „://“ und „/“ und wird deshalb als ein URL-kodiertes
  // Segment erwartet (encodeURIComponent). Unkodiert übergebene Segmente
  // werden wieder zusammengesetzt; entscheidend ist allein, auf welchen
  // Eintrag des Baums das Topic zeigt.
  const topicFromParams = (req) => {
    const raw = req.params.topic;
    const text = Array.isArray(raw) ? raw.join('/') : String(raw || '');
    if (!text || text.length > MAX_TOPIC_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) return null;
    return text;
  };

  router.get(`${API_BASE}/states/*topic`, requireEnabled, requireToken, async (req, res, next) => {
    try {
      const topic = topicFromParams(req);
      if (!topic) return sendError(res, 'invalid_request', 'Das State-Topic ist ungültig.');
      const current = await view();
      const entry = current.findState(topic);
      if (!entry) return sendError(res, 'state_not_found');
      return sendData(res, 200, current.serializeState(entry));
    } catch (error) {
      return next(error);
    }
  });

  router.put(`${API_BASE}/states/*topic`, requireEnabled, requireToken, async (req, res, next) => {
    try {
      const topic = topicFromParams(req);
      if (!topic) return sendError(res, 'invalid_request', 'Das State-Topic ist ungültig.');
      if (!req.is('application/json')) return sendError(res, 'unsupported_media_type');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      if (!body || !Object.prototype.hasOwnProperty.call(body, 'value')) {
        return sendError(res, 'invalid_request', 'Das Feld value fehlt.');
      }
      const current = await view();
      const entry = current.findState(topic);
      if (!entry) return sendError(res, 'state_not_found');
      if (entry.state.writable !== true) return sendError(res, 'state_not_writable');
      let payload;
      try {
        payload = catalog.payloadFor(entry.state, body.value);
      } catch (error) {
        if (error.code === 'invalid_value') return sendError(res, 'invalid_value', error.message);
        throw error;
      }
      // Geschrieben wird das kanonische Topic aus dem Baum, nie die Eingabe.
      if (!mqttClient.publish(entry.topic, payload)) return sendError(res, 'write_failed');
      invalidateStates();
      catalog.invalidate();
      return sendData(res, 200, {
        topic: entry.topic,
        value: catalog.apiValue(payload, catalog.dataType(entry.state)),
        written: true,
      });
    } catch (error) {
      return next(error);
    }
  });
  onlyMethods(router, `${API_BASE}/states/*topic`, ['GET', 'PUT']);

  // Audio Bus: Der WebSocket-Upgrade wird vor Express im HTTP-Server
  // behandelt (audio-bus/ws-server.js). Gewöhnliche HTTP-Aufrufe landen hier.
  router.all(`${API_BASE}/audio/ws`, (_req, res) => {
    res.set('Upgrade', 'websocket');
    return sendError(res, 'upgrade_required');
  });

  // Alles Weitere unter /api/v1 gibt es nicht.
  router.all(`${API_BASE}/*rest`, (_req, res) => sendError(res, 'not_found'));

  // ── Einstellungen: States-Katalog mit Freigabestatus ─────────────────────
  router.get('/settings/states-api/catalog.json', requireAuth, async (req, res) => {
    // Der Katalog zeigt Werte aller States – wie die Verwaltung der Freigaben
    // nur für Administratoren.
    if (!req.access || !req.access.isAdmin) return res.status(403).json({ error: 'Nur Administratoren dürfen die States API verwalten.' });
    try {
      const index = await catalog.loadIndex(db, mqttClient.getCache());
      const level = catalog.settingsLevel(index, apiConfig.get(), String(req.query.path || '').slice(0, MAX_TOPIC_LENGTH), req.query.offset);
      if (!level) return res.status(404).json({ error: 'Dieses Verzeichnis ist nicht bekannt.' });
      return res.json(level);
    } catch (error) {
      console.error('[states-api] Katalog nicht ladbar:', error && error.message);
      return res.status(500).json({ error: 'Der States-Katalog konnte nicht geladen werden.' });
    }
  });

  router.post('/settings/states-api/exclusion', requireAuth, async (req, res) => {
    if (!req.access || !req.access.isAdmin) return res.status(403).json({ error: 'Nur Administratoren dürfen die States API verwalten.' });
    if (req.get('X-HomeESS-Request') !== '1') return res.status(403).json({ error: 'csrf' });
    try {
      const body = req.body || {};
      const kind = body.kind === 'folder' ? 'folder' : body.kind === 'state' ? 'state' : null;
      if (!kind) return res.status(400).json({ error: 'Unbekannte Änderung.' });
      const index = await catalog.loadIndex(db, mqttClient.getCache());
      const result = catalog.applyExclusionChange(index, apiConfig.get(), {
        kind,
        path: String(body.path || '').slice(0, MAX_TOPIC_LENGTH),
        topic: String(body.topic || '').slice(0, MAX_TOPIC_LENGTH),
        excluded: body.excluded === true,
      });
      if (result.changed) {
        const saved = await apiConfig.saveExclusions(db, result);
        const target = kind === 'folder' ? `Verzeichnis „${result.node.path}“` : `State „${result.topic}“`;
        log(`${target} ${body.excluded === true ? 'vom API-Zugriff ausgeschlossen' : 'für den API-Zugriff freigegeben'}.`);
        return res.json({ ok: true, excludedFolders: saved.excludedFolders.length, excludedStates: saved.excludedStates.length });
      }
      const config = apiConfig.get();
      return res.json({ ok: true, excludedFolders: config.excludedFolders.length, excludedStates: config.excludedStates.length });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('[states-api] Freigabe nicht speicherbar:', error && error.message);
      return res.status(500).json({ error: 'Die Freigabe konnte nicht gespeichert werden.' });
    }
  });

  router.post('/settings/states-api/exclusions/reset', requireAuth, async (req, res) => {
    if (!req.access || !req.access.isAdmin) return res.status(403).json({ error: 'Nur Administratoren dürfen die States API verwalten.' });
    if (req.get('X-HomeESS-Request') !== '1') return res.status(403).json({ error: 'csrf' });
    try {
      await apiConfig.saveExclusions(db, { excludedFolders: [], excludedStates: [] });
      console.log('[states-api] Alle Ausschlüsse aufgehoben; sämtliche States sind wieder freigegeben.');
      return res.json({ ok: true, excludedFolders: 0, excludedStates: 0 });
    } catch (error) {
      console.error('[states-api] Ausschlüsse nicht zurücksetzbar:', error && error.message);
      return res.status(500).json({ error: 'Die Freigabe konnte nicht gespeichert werden.' });
    }
  });

  return router;
}

// Fehlerbehandlung für /api/v1: fehlerhaftes JSON, zu große Bodies, nicht
// dekodierbare Pfade und unerwartete Ausnahmen werden als JSON-Fehler ohne
// interne Details beantwortet. Die Ursache technischer Fehler steht im Log.
function statesApiErrorHandler(err, req, res, next) {
  if (!req.path.startsWith(API_BASE)) return next(err);
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return sendError(res, 'invalid_request', 'Der Request-Body ist kein gültiges JSON.');
  if (err && err.type === 'entity.too.large') return sendError(res, 'payload_too_large');
  if (err && (err.status === 400 || err instanceof URIError)) return sendError(res, 'invalid_request');
  console.error('[states-api] Technischer Fehler:', err && err.stack ? err.stack : err);
  return sendError(res, 'internal_error');
}

module.exports = statesApiRoutes;
module.exports.API_BASE = API_BASE;
module.exports.errorHandler = statesApiErrorHandler;
module.exports.ERROR_STATUS = ERROR_STATUS;
