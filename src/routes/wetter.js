'use strict';

// Routen der Seite „Wetterprognose". Die Daten stammen aus dem Cache, den der
// periodische Wetter-Job füllt; ist er noch leer (erster Aufruf nach dem Start,
// frisch hinterlegter Standort), wird einmalig abgerufen, damit die Seite nicht
// leer bleibt.

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { getWeatherForecast, refreshWeatherForecast } = require('../wetter/forecast');
const { listPvPlants } = require('../photovoltaik/plants');
const { computePvForecast } = require('../photovoltaik/forecast');
const renderWetter = require('../views/wetter');

async function loadForecast(db) {
  const cached = await getWeatherForecast(db, { allowFetch: false });
  if (cached) return cached;
  return getWeatherForecast(db, { allowFetch: true });
}

// Erwarteter PV-Tagesertrag aus der bestehenden PV-Prognose. Ohne Netzabruf —
// der Wetter-Job hält den zugrunde liegenden Strahlungs-Cache aktuell. Fehlt die
// Prognose (keine Anlagen, kein Standort), bleibt die Seite ohne PV-Angaben.
async function loadPvForecast(db) {
  try {
    const plants = await listPvPlants(db);
    if (!plants.length) return null;
    return await computePvForecast(db, plants, { allowFetch: false, cache: mqttClient.getCache() });
  } catch (_) {
    return null;
  }
}

// Rückmeldung eines vorangegangenen Abrufs aus der Adresse lesen. Übertragen
// wird nur ein Kennzeichen, der Wortlaut steht hier.
function refreshResult(req) {
  const query = req.query || {};
  if (query.ok) return { message: 'Wetterprognose aktualisiert.' };
  if (query.fehler) {
    return {
      error: 'Die Wetterprognose konnte nicht abgerufen werden. Angezeigt wird der letzte bekannte Stand.',
    };
  }
  return {};
}

function wetterRoutes(db) {
  const router = express.Router();

  router.get('/wetter', requireAuth, async (req, res, next) => {
    try {
      const [forecast, pvForecast] = await Promise.all([loadForecast(db), loadPvForecast(db)]);
      res.send(renderWetter({ forecast, pvForecast, ...refreshResult(req) }));
    } catch (err) { next(err); }
  });

  // Rohdaten der Prognose (gleiche Struktur wie die Seite) für Auswertungen.
  router.get('/wetter/daten', requireAuth, async (req, res, next) => {
    try {
      const forecast = await loadForecast(db);
      if (!forecast) return res.status(404).json({ error: 'Kein Standort hinterlegt oder keine Prognose verfügbar.' });
      return res.json(forecast);
    } catch (err) { return next(err); }
  });

  // Post/Redirect/Get: nach dem Abruf wird auf `/wetter` umgeleitet, statt die
  // Seite direkt auszuliefern. Sonst bliebe der Browser — und vor allem die
  // WebView der App, die ihre letzte Adresse merkt — auf einer Adresse stehen,
  // die nur POST beantwortet; ein späterer Aufruf endete dann im Nichts.
  // Das Ergebnis reist als Kennzeichen in der Adresse mit (Hausform: `?ok=`).
  router.post('/wetter/aktualisieren', requireAuth, async (req, res, next) => {
    try {
      const refreshed = await refreshWeatherForecast(db);
      // 303 macht ausdrücklich einen GET daraus — kein Client wiederholt den POST.
      res.redirect(303, refreshed ? '/wetter?ok=1' : '/wetter?fehler=1');
    } catch (err) { next(err); }
  });

  // Dieselbe Adresse per GET: das passiert, wenn eine gemerkte Adresse (App,
  // Lesezeichen, Verlauf) erneut geöffnet wird. Statt einer Fehlerseite führt
  // sie zurück auf die Seite.
  router.get('/wetter/aktualisieren', requireAuth, (req, res) => res.redirect('/wetter'));

  return router;
}

module.exports = wetterRoutes;
