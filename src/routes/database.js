'use strict';

// JSON-Schnittstelle zur systemweiten Datenbank (siehe src/database/).
// Diagramme und Auswertungen holen ihre Zeitreihen ausschließlich hierüber —
// der Browser spricht nie direkt mit der Datenbank, und Zugangsdaten verlassen
// den Server nicht.

const express = require('express');
const { requireAuth } = require('../auth/session');
const systemDatabase = require('../database');
const { AGGREGATES } = require('../database/influx-reader');

const MAX_SERIES = 10;

function parseTime(value, fallback) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return fallback;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function databaseRoutes(db) {
  const router = express.Router();

  // Status der Anbindung (ohne Zugangsdaten) für Anzeigen und Diagramme.
  router.get('/database/status', requireAuth, async (_req, res, next) => {
    try {
      const config = await systemDatabase.load(db);
      res.json({
        configured: systemDatabase.isConfigured(config),
        type: config.type,
        host: config.host,
        database: config.database,
        sourceLabel: config.sourceLabel,
        lastCheck: systemDatabase.getStatus(),
      });
    } catch (error) {
      next(error);
    }
  });

  // Verfügbare Messreihen (Auswahlliste im Diagramm).
  router.get('/database/measurements', requireAuth, async (_req, res) => {
    try {
      const measurements = await systemDatabase.listMeasurements(db);
      res.json({ measurements });
    } catch (error) {
      res.status(502).json({ error: error && error.message ? error.message : 'Abfrage fehlgeschlagen.' });
    }
  });

  // Zeitreihe(n) lesen. Mehrere Messreihen durch Komma getrennt.
  router.get('/database/series', requireAuth, async (req, res) => {
    const names = String(req.query.measurement || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, MAX_SERIES);
    if (!names.length) return res.status(400).json({ error: 'Es wurde keine Messreihe angegeben.' });

    const to = parseTime(req.query.to, Date.now());
    const from = parseTime(req.query.from, to - 24 * 60 * 60 * 1000);
    const aggregate = AGGREGATES.has(String(req.query.aggregate)) ? String(req.query.aggregate) : 'mean';
    const intervalMs = Math.max(0, Math.round(Number(req.query.interval) || 0));

    try {
      const series = await systemDatabase.readSeriesSet(db, names, {
        from,
        to,
        intervalMs,
        aggregate,
        field: req.query.field,
        limit: req.query.limit,
      });
      res.json({ from, to, intervalMs, aggregate, series });
    } catch (error) {
      res.status(502).json({ error: error && error.message ? error.message : 'Abfrage fehlgeschlagen.' });
    }
  });

  return router;
}

module.exports = databaseRoutes;
