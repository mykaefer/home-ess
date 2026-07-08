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

function renderEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Momentanleistung für die Kopfzeile (Desktop-Pills), Format wie formatPower.
function formatHeaderPower(value) {
  const parsed = value == null ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return '— W';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(parsed)} W`;
}

function liveRoutes(db) {
  const router = express.Router();

  router.get('/live/header', requireAuth, async (req, res) => {
    const cache = mqttClient.getCache();
    const snapshot = buildEnvironmentSnapshot(cache);
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
      sky,
      batterySoc: Number.isFinite(batterySoc) ? batterySoc : null,
      power: {
        pv: formatHeaderPower(pvPower),
        grid: formatHeaderPower(gridPower),
        self: formatHeaderPower(selfPower),
        battery: formatHeaderPower(Number.isFinite(batteryPower) ? batteryPower : null),
      },
      ...operatingState.getState(),
    });
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
