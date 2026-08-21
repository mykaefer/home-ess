'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { buildEnvironmentSnapshot } = require('../mqtt/config');
const { listPvPlants } = require('../photovoltaik/plants');
const { assessHeaderSkyState, readPhotovoltaikValues } = require('../photovoltaik/aggregation');
const { readLivePowerValues } = require('../stromverbrauch/aggregation');
const { readBatterieData } = require('../batterie/config');
const operatingState = require('../operating-state');
const timeHandler = require('../time-handler');
const systemWarning = require('../system-warning');
const i18n = require('../i18n');

function renderEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Momentanleistung für die Kopfzeile (Desktop-Pills), Format wie formatPower.
function formatHeaderPower(value) {
  const parsed = value == null ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return '— W';
  return `${new Intl.NumberFormat(i18n.current().locale, { maximumFractionDigits: 0 }).format(parsed)} W`;
}

function liveRoutes(db) {
  const router = express.Router();

  router.get('/live/header', requireAuth, async (req, res) => {
    const cache = mqttClient.getCache();
    const snapshot = buildEnvironmentSnapshot(cache);
    const internalClock = timeHandler.snapshot();
    let sky = 'moon';
    let pvPower = null;
    let gridPower = null;
    let selfPower = null;
    try {
      const plants = await listPvPlants(db);
      sky = await assessHeaderSkyState(db, cache, plants);
      const pvValues = await readPhotovoltaikValues(db, cache, plants);
      pvPower = pvValues.totals.current;
      const live = readLivePowerValues(cache, pvValues);
      gridPower = live.netzbezugPower;
      selfPower = live.eigenverbrauchPower;
    } catch (_) {
      sky = 'moon';
    }
    const battery = readBatterieData(cache);
    const batteryPower = battery.power != null ? parseFloat(String(battery.power)) : NaN;
    const socRaw = cache.get('batterie.soc');
    const batterySoc = socRaw != null ? parseFloat(String(socRaw.value)) : NaN;
    res.json({
      ...snapshot,
      time: { iso: internalClock.internal.time, display: internalClock.internal.time.slice(0, 5) },
      date: { iso: internalClock.internal.date, display: i18n.formatDate(internalClock.internal.date) },
      sky,
      batterySoc: Number.isFinite(batterySoc) ? batterySoc : null,
      power: {
        pv: formatHeaderPower(pvPower),
        grid: formatHeaderPower(gridPower),
        self: formatHeaderPower(selfPower),
        battery: formatHeaderPower(Number.isFinite(batteryPower) ? batteryPower : null),
      },
      ...operatingState.getState(),
      // Systemweite Warnung für das Warnband im Layout. Sie steht erst, wenn
      // ein Fehler als persistent gilt, und bleibt bis zur Quittierung.
      warning: (() => {
        const current = systemWarning.getState();
        return { active: current.active, text: current.text, source: current.source, raisedAt: current.raisedAt || null };
      })(),
    });
  });

  // Quittierung der systemweiten Warnung: Flag auf false, Warntext leeren.
  router.post('/live/warnung/quittieren', requireAuth, async (req, res) => {
    try {
      const result = await systemWarning.acknowledge(db);
      res.json({ ok: true, warning: { active: result.active, text: result.text } });
    } catch (error) {
      res.status(500).json({ error: 'Warnung konnte nicht quittiert werden.' });
    }
  });

  router.get('/live/events', requireAuth, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders && res.flushHeaders();
    res.write(renderEvent('ready', { connected: true, receivedAt: Date.now() }));

    const unsubscribe = mqttClient.onValuesChanged((event) => {
      res.write(renderEvent('mqtt', event));
    });

    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  return router;
}

module.exports = liveRoutes;
