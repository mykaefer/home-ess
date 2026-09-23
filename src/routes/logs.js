'use strict';

// Routen der Seite „Logs". Die Seite selbst wird server-gerendert, die
// fortlaufende Aktualisierung holt sich der Browser über /logs/daten.
//
// Damit häufiges Nachladen den Server nicht belastet, gilt eine serverseitige
// Untergrenze für den Abstand zweier Abrufe je Sitzung (MIN_POLL_MS). Ein zu
// früher Abruf wird mit 429 abgewiesen, ohne den Puffer zu lesen.

const express = require('express');
const { requireAuth } = require('../auth/session');
const logStore = require('../logging/log-store');
const renderLogs = require('../views/logs');

// Kürzester zulässiger Abstand zweier Abrufe einer Sitzung. Der Browser fragt
// im kleinsten wählbaren Takt jede Sekunde; die Grenze liegt knapp darunter,
// damit Laufzeitschwankungen keinen regulären Abruf abweisen — schnellere
// Abrufe (manipulierter Takt, viele offene Tabs) fängt sie dagegen ab.
const MIN_POLL_MS = 750;
// Sitzungen, die seit dieser Zeit nicht mehr abgerufen haben, fallen aus der
// Merkliste — sie darf nicht unbegrenzt wachsen.
const POLL_TTL_MS = 5 * 60 * 1000;

const lastPoll = new Map();

function throttled(sessionId, now = Date.now()) {
  // Aufräumen kostet wenig und passiert genau dann, wenn ohnehin geschrieben wird.
  if (lastPoll.size > 200) {
    for (const [key, stamp] of lastPoll) if (now - stamp > POLL_TTL_MS) lastPoll.delete(key);
  }
  const previous = lastPoll.get(sessionId);
  if (previous != null && now - previous < MIN_POLL_MS) return MIN_POLL_MS - (now - previous);
  lastPoll.set(sessionId, now);
  return 0;
}

// JSON-Auth: bei fehlender Sitzung 401 statt Weiterleitung (die Weiterleitung
// käme im Browser als HTML-Antwort auf einen JSON-Abruf an).
function requireJsonAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet.' });
  return next();
}

function readOptions(query) {
  return {
    page: query.seite,
    levels: query.stufe,
    source: query.quelle,
    query: query.suche,
    anchorId: query.anker,
  };
}

function logsRoutes() {
  const router = express.Router();

  router.get('/logs', requireAuth, (req, res, next) => {
    try {
      const initial = logStore.read({});
      res.send(renderLogs({ initial, minIntervalMs: MIN_POLL_MS }));
    } catch (err) { next(err); }
  });

  // Gefilterte Seite als JSON. `bekannt` trägt die zuletzt gesehene ID samt
  // Gesamtzahl: stimmen beide noch, antwortet der Server nur mit einem Kennzeichen
  // statt der vollen Liste.
  router.get('/logs/daten', requireJsonAuth, (req, res, next) => {
    try {
      const wait = throttled(req.session.id);
      if (wait > 0) {
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        return res.status(429).json({ error: 'Zu viele Abrufe.', retryAfterMs: wait });
      }
      const data = logStore.read(readOptions(req.query || {}));
      const knownLatest = Number((req.query || {}).bekannt);
      const knownTotal = Number((req.query || {}).bekanntGesamt);
      if (Number.isFinite(knownLatest) && Number.isFinite(knownTotal)
        && knownLatest === data.latestId && knownTotal === data.total) {
        return res.json({ unchanged: true, page: data.page, totalPages: data.totalPages });
      }
      return res.json(data);
    } catch (err) { return next(err); }
  });

  return router;
}

module.exports = logsRoutes;
