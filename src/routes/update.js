'use strict';

const express = require('express');
const updateService = require('../update/service');

module.exports = function updateRoutes(service = updateService) {
  const router = express.Router();

  router.get('/update/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, version: service.currentVersion });
  });

  router.get('/update/status', (req, res) => {
    res.set('Cache-Control', 'no-store').json(service.getStatus());
  });

  router.post('/update/start', async (req, res) => {
    if (!req.access || !req.access.isAdmin) {
      return res.status(403).json({ error: 'Nur Administratoren dürfen homeESS aktualisieren.' });
    }
    if (req.get('X-HomeESS-Update') !== 'confirm') {
      return res.status(400).json({ error: 'Updatebestätigung fehlt.' });
    }
    try {
      const status = await service.requestUpdate(req.body && req.body.version);
      return res.status(202).json(status);
    } catch (error) {
      return res.status(409).json({ error: error.message || 'Update konnte nicht gestartet werden.' });
    }
  });

  return router;
};
