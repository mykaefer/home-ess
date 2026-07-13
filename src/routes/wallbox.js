'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { isEnabled } = require('../modules');
const mqttClient = require('../mqtt/client');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const {
  listWallboxes, getWallbox, createWallbox, updateWallbox, deleteWallbox,
  setWallboxMode, normalizeInput,
} = require('../wallbox/boxes');
const { readWallboxValues } = require('../wallbox/aggregation');
const wallboxAutomation = require('../wallbox/automation');
const renderWallbox = require('../views/wallbox');

async function refreshMqttDefinitions(db) {
  const defs = await loadAllStateDefinitions(db);
  mqttClient.setStateDefinitions(defs);
}

function formatNextCharge(seconds, hour) {
  if (seconds == null) return null;
  const clock = `${String(hour).padStart(2, '0')}:00 Uhr`;
  if (seconds < 60) return `${clock} (jetzt)`;
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const span = h > 0 ? `in ${h} h ${m} min` : `in ${m} min`;
  return `${clock} (${span})`;
}

// Live-Werte um den voraussichtlichen nächsten Ladebeginn ergänzen (aus der
// Steuerschleife; Restzeit zur Lesezeit aus dem absoluten Zeitpunkt berechnet).
function enrichWithNextCharge(values) {
  return values.map((v) => {
    const nc = wallboxAutomation.getNextCharge(v.id);
    const seconds = nc ? Math.max(0, Math.round((nc.at - Date.now()) / 1000)) : null;
    return {
      ...v,
      controlMode: wallboxAutomation.getControlMode(v.id),
      nextChargeSeconds: seconds,
      formatted: { ...v.formatted, nextCharge: nc ? formatNextCharge(seconds, nc.hour) : '—' },
    };
  });
}

function boxToFormValues(box) {
  return {
    id: box.id,
    name: box.name || '',
    maxPowerW: box.maxPowerW ?? '',
    batteryCapacityKwh: box.batteryCapacityKwh ?? '',
    commandTopic: box.commandTopic || '',
    controlSyncTopic: box.controlSyncTopic || '',
    statusTopic: box.statusTopic || '',
    powerTopic: box.powerTopic || '',
    powerUnit: box.powerUnit || 'W',
    counterTopic: box.counterTopic || '',
    counterUnit: box.counterUnit || 'kWh',
    setpointTopic: box.setpointTopic || '',
    pluggedTopic: box.pluggedTopic || '',
    socTopic: box.socTopic || '',
    modeSyncTopic: box.modeSyncTopic || '',
    priorityPrivate: box.priorityPrivate ?? 5,
    priorityBusiness: box.priorityBusiness ?? 3,
    priorityFull: box.priorityFull ?? 4,
    loadShedPhase: box.loadShedPhase || 'three_phase',
    minChargePercent: box.minChargePercent ?? 30,
    minChargeBusinessPercent: box.minChargeBusinessPercent ?? 100,
    businessDays: box.businessDays || [],
    businessEndHour: box.businessEndHour ?? 18,
    stallTimeoutSeconds: box.stallTimeoutSeconds ?? 120,
    stallPowerW: box.stallPowerW ?? 200,
  };
}

async function renderPage(db, res, options = {}) {
  const boxes = await listWallboxes(db);
  const values = enrichWithNextCharge(await readWallboxValues(db, mqttClient.getCache(), boxes));
  const editingBox = options.editingBoxId != null
    ? boxes.find((b) => b.id === Number(options.editingBoxId)) || null
    : null;
  res.send(renderWallbox({
    boxes: boxes.map(boxToFormValues),
    values,
    gridControlEnabled: isEnabled('grid-control'),
    formMessage: options.formMessage || '',
    formError: options.formError || '',
    dialogMode: options.dialogMode || '',
    dialogError: options.dialogError || '',
    dialogValues: options.dialogValues || (editingBox ? boxToFormValues(editingBox) : null),
    editingBoxId: editingBox ? editingBox.id : null,
  }));
}

function wallboxRoutes(db) {
  const router = express.Router();

  // Steuerschleife starten (Vorbild Pool: Init aus dem Routen-Modul heraus).
  wallboxAutomation.init(db);

  function requireWallboxEnabled(req, res, next) {
    if (!isEnabled('wallbox')) return res.redirect('/module');
    next();
  }

  router.get('/wallbox', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      await renderPage(db, res, {
        dialogMode: req.query.mode === 'add' || req.query.mode === 'edit' ? req.query.mode : '',
        editingBoxId: req.query.boxId || null,
      });
    } catch (err) { next(err); }
  });

  router.get('/wallbox/data', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      const boxes = await listWallboxes(db);
      const values = enrichWithNextCharge(await readWallboxValues(db, mqttClient.getCache(), boxes));
      res.json({ boxes: values });
    } catch (err) { next(err); }
  });

  router.post('/wallbox/boxes', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      await createWallbox(db, req.body);
      await refreshMqttDefinitions(db);
      await wallboxAutomation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Wallbox hinzugefügt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'add', dialogError: err.message, dialogValues: normalizeInput(req.body),
        });
      }
      next(err);
    }
  });

  router.post('/wallbox/boxes/:id', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      await updateWallbox(db, Number(req.params.id), req.body);
      await refreshMqttDefinitions(db);
      await wallboxAutomation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Wallbox gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'edit', dialogError: err.message,
          dialogValues: { id: Number(req.params.id), ...normalizeInput(req.body) },
          editingBoxId: Number(req.params.id),
        });
      }
      next(err);
    }
  });

  router.post('/wallbox/boxes/:id/delete', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      await deleteWallbox(db, Number(req.params.id));
      await refreshMqttDefinitions(db);
      await renderPage(db, res, { formMessage: 'Wallbox gelöscht.' });
    } catch (err) { next(err); }
  });

  // Lademodus setzen: 1=Privat, 2=Beruflich, 3=Immer voll
  router.post('/wallbox/box/:id/mode/:mode', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const mode = Number(req.params.mode);
      if (![1, 2, 3].includes(mode)) return res.status(400).json({ error: 'Ungültiger Modus.' });
      await setWallboxMode(db, id, mode);
      const box = await getWallbox(db, id);
      if (box) await wallboxAutomation.applyModeChange(db, box);
      await wallboxAutomation.runNow(db).catch(() => {});
      res.json({ ok: true, mode });
    } catch (err) { next(err); }
  });

  // Manuelle Übersteuerung: Automatik / dauerhaft Aus / einmalig Vollladen.
  router.post('/wallbox/box/:id/control/:control', requireAuth, requireWallboxEnabled, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const control = String(req.params.control || '');
      if (!['auto', 'off', 'full'].includes(control)) {
        return res.status(400).json({ error: 'Ungültige Wallbox-Steuerung.' });
      }
      if (!await getWallbox(db, id)) return res.status(404).json({ error: 'Wallbox nicht gefunden.' });
      const controlMode = wallboxAutomation.setControlMode(db, id, control);
      await wallboxAutomation.runNow(db);
      res.json({ ok: true, controlMode });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = wallboxRoutes;
