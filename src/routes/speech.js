'use strict';
const express = require('express');
const { requireAuth } = require('../auth/session');
const { isEnabled } = require('../modules');
const runtime = require('../speech/runtime');
const repository = require('../speech/repository');
const config = require('../speech/config');
const { listRooms } = require('../heizung/rooms');
const render = require('../views/speech');

module.exports = function speechRoutes(db) {
  const router = express.Router();
  router.use('/speech', requireAuth, (req, res, next) => {
    if (!isEnabled('speech')) return res.redirect('/module');
    next();
  });
  const page = async (res, error = '', settings, message = '') => res.status(error ? 400 : 200).send(render({
    endpoints: await runtime.list(), rooms: await listRooms(db), error, status: runtime.status(),
    settings: settings || await config.get(db), message,
  }));
  router.get('/speech', async (req, res, next) => { try { await page(res); } catch (e) { next(e); } });
  router.post('/speech/settings', async (req, res, next) => {
    try {
      await config.save(db, req.body);
      await page(res, '', undefined, 'Wiedergabeeinstellungen gespeichert. Sie gelten ab der nächsten Ansage.');
    } catch (e) {
      if (!e.validation) return next(e);
      try { await page(res, e.message, req.body); } catch (error) { next(error); }
    }
  });
  router.post('/speech/endpoints', async (req, res, next) => {
    try {
      await repository.update(db, req.body.deviceId, req.body);
      res.redirect('/speech');
    } catch (e) {
      if (!e.validation) return next(e);
      try { await page(res, e.message); } catch (error) { next(error); }
    }
  });
  return router;
};
