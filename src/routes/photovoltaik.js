'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const {
  CELL_TYPE_OPTIONS,
  CELL_TYPE_DEFAULT_EFFICIENCY,
  CONVERTER_TYPE_OPTIONS,
  listPvPlants,
  createPvPlant,
  updatePvPlant,
  deletePvPlant,
  normalizePlantInput,
} = require('../photovoltaik/plants');
const {
  buildPhotovoltaikSnapshot,
  setManualOffset,
} = require('../photovoltaik/aggregation');
const { clearCalibration } = require('../photovoltaik/calibration');
const { computePvForecast } = require('../photovoltaik/forecast');
const { parseNumber } = require('../stromverbrauch/aggregation');
const { recordDailyMetric, isValidDayKey } = require('../history/daily-metrics');
const renderPhotovoltaik = require('../views/photovoltaik');

async function renderPage(db, res, options = {}) {
  const plants = await listPvPlants(db);
  const snapshot = await buildPhotovoltaikSnapshot(db, mqttClient.getCache(), plants);
  // Prognose ohne blockierenden Netzwerkabruf (nur Cache) — gefüllt durch den
  // periodischen Job; clientseitig später über /photovoltaik/forecast aktualisiert.
  const forecast = await computePvForecast(db, plants, {
    allowFetch: false,
    cache: mqttClient.getCache(),
  }).catch(() => null);
  const editingPlant =
    options.editingPlantId != null
      ? plants.find((plant) => plant.id === Number(options.editingPlantId)) || null
      : null;

  res.send(
    renderPhotovoltaik({
      plants: snapshot.plants,
      totals: snapshot.totals,
      forecast,
      cellTypeOptions: CELL_TYPE_OPTIONS,
      cellTypeDefaultEfficiency: CELL_TYPE_DEFAULT_EFFICIENCY,
      converterTypeOptions: CONVERTER_TYPE_OPTIONS,
      formMessage: options.formMessage || '',
      formError: options.formError || '',
      reconcileMessage: options.reconcileMessage || '',
      reconcileError: options.reconcileError || '',
      dialogMode: options.dialogMode || '',
      dialogError: options.dialogError || '',
      dialogValues: options.dialogValues || (editingPlant ? plantToFormValues(editingPlant) : null),
      editingPlantId: editingPlant ? editingPlant.id : null,
    })
  );
}

// Prognose für die JSON-Antwort auf das Nötige reduzieren (Tageslabels + kWh).
function serializeForecast(forecast) {
  if (!forecast || !Array.isArray(forecast.days) || !forecast.days.length) {
    return { available: false, days: [] };
  }
  return {
    available: true,
    location: forecast.locationLabel || null,
    todayElapsed: forecast.todayElapsedFormatted || null,
    todayRemaining: forecast.todayRemainingFormatted || null,
    days: forecast.days.map((day) => ({
      label: day.label,
      total: day.totalFormatted,
    })),
  };
}

function plantToFormValues(plant) {
  return {
    name: plant.name || '',
    kwPeak: plant.kwPeak ?? '',
    efficiency: plant.efficiency ?? '',
    orientation: plant.orientation || '',
    tilt: plant.tilt ?? '',
    isConsumerSide: Boolean(plant.isConsumerSide),
    autoCalibrate: Boolean(plant.autoCalibrate),
    sunCutoffMorning: plant.sunCutoffMorning ?? '',
    sunCutoffEvening: plant.sunCutoffEvening ?? '',
    cellType: plant.cellType || '',
    converterType: plant.converterType || '',
    powerTopic: plant.powerTopic || '',
    todayYieldTopic: plant.todayYieldTopic || '',
  };
}

async function refreshMqttDefinitions(db) {
  const defs = await loadAllStateDefinitions(db);
  mqttClient.setStateDefinitions(defs);
}

function photovoltaikRoutes(db) {
  const router = express.Router();

  router.get('/photovoltaik', requireAuth, async (req, res, next) => {
    try {
      await renderPage(db, res, {
        dialogMode: req.query.mode === 'add' || req.query.mode === 'edit' ? req.query.mode : '',
        editingPlantId: req.query.plantId || null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/photovoltaik/data', requireAuth, async (req, res, next) => {
    try {
      const plants = await listPvPlants(db);
      const snapshot = await buildPhotovoltaikSnapshot(db, mqttClient.getCache(), plants);
      res.json({
        totals: snapshot.totals.formatted,
        directSunlight: snapshot.totals.raw.directSunlight,
        plants: snapshot.plants.map((plant) => ({
          id: plant.id,
          current: plant.metrics.formatted.current,
          ideal: plant.metrics.formatted.ideal,
          directSunlight: plant.metrics.raw.directSunlight,
          autoCalibrate: Boolean(plant.autoCalibrate),
          calibrationFactor: plant.metrics.formatted.calibrationFactor,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/photovoltaik/forecast', requireAuth, async (req, res, next) => {
    try {
      const plants = await listPvPlants(db);
      // Hier darf ein (gecachter) Netzwerkabruf erfolgen, damit die Prognose auch
      // erscheint, bevor der periodische Job erstmals gelaufen ist.
      const forecast = await computePvForecast(db, plants, {
        allowFetch: true,
        cache: mqttClient.getCache(),
      }).catch(() => null);
      res.json(serializeForecast(forecast));
    } catch (err) {
      next(err);
    }
  });

  router.post('/photovoltaik/plants', requireAuth, async (req, res, next) => {
    try {
      await createPvPlant(db, req.body);
      await refreshMqttDefinitions(db);
      await renderPage(db, res, { formMessage: 'PV-Anlage hinzugefuegt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'add',
          dialogError: err.message,
          dialogValues: normalizePlantInput(req.body),
        });
      }
      next(err);
    }
  });

  router.post('/photovoltaik/plants/:id', requireAuth, async (req, res, next) => {
    try {
      await updatePvPlant(db, Number(req.params.id), req.body);
      await refreshMqttDefinitions(db);
      await renderPage(db, res, { formMessage: 'PV-Anlage gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'edit',
          dialogError: err.message,
          dialogValues: normalizePlantInput(req.body),
          editingPlantId: Number(req.params.id),
        });
      }
      next(err);
    }
  });

  router.post('/photovoltaik/plants/:id/clear-calibration', requireAuth, async (req, res, next) => {
    try {
      await clearCalibration(db, Number(req.params.id));
      await renderPage(db, res, { formMessage: 'Kalibrierung zurückgesetzt.' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/photovoltaik/plants/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deletePvPlant(db, Number(req.params.id));
      await refreshMqttDefinitions(db);
      await renderPage(db, res, { formMessage: 'PV-Anlage geloescht.' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/photovoltaik/reconcile', requireAuth, async (req, res, next) => {
    try {
      const target = req.body.target;
      const value = parseNumber(req.body.reconcileValue);
      if (value == null) {
        return renderPage(db, res, { reconcileError: 'Bitte einen gueltigen Wert eingeben.' });
      }
      // Summen (Woche/Jahr/Vorjahr) laufen über die Offset-Zähler; Minimum/Maximum
      // werden als Startwert für einen konkreten Tag in die Tageshistorie geschrieben,
      // aus der sich Min/Max/Durchschnitt/Datum automatisch ergeben.
      if (target === 'week' || target === 'year' || target === 'previousYear') {
        await setManualOffset(db, target, value);
      } else if (target === 'min' || target === 'max') {
        if (!isValidDayKey(req.body.reconcileDate)) {
          return renderPage(db, res, { reconcileError: 'Bitte ein gueltiges Datum eingeben.' });
        }
        await recordDailyMetric(db, 'pv', req.body.reconcileDate, value);
      } else {
        return renderPage(db, res, { reconcileError: 'Bitte eine Kennzahl auswaehlen.' });
      }
      await renderPage(db, res, { reconcileMessage: 'Wert uebernommen.' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = photovoltaikRoutes;
