'use strict';
const express = require('express');
const { requireAuth } = require('../auth/session');
const { isEnabled } = require('../modules');
const repo = require('../rollladen/repository');
const runtime = require('../rollladen/runtime');
const rooms = require('../heizung/rooms');
const render = require('../views/rollladen');
const { displayStatus, displayBrightness } = require('../rollladen/status');
module.exports = function (db) {
  const router = express.Router();
  router.get('/rollladen/status', (req, res) => {
    if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet.' });
    if (!isEnabled('rollladen')) return res.status(403).json({ error: 'Modul nicht aktiviert.' });
    // Ausschließlich den Laufzeit-Cache lesen: kein Steuertakt und keine DB-Abfragen.
    res.set('Cache-Control', 'no-store');
    res.json({ brightness: displayBrightness(), shutters: [...runtime.snapshot()].map(([id, state]) => ({ id, ...displayStatus(state) })) });
  });
  router.use('/rollladen', requireAuth, (req, res, next) => isEnabled('rollladen') ? next() : res.redirect('/module'));
  async function page(res, error = '', input = null, dialogType = 'shutter') {
    res.status(error ? 400 : 200).send(render({ shutters: await repo.list(db), rooms: await rooms.listRooms(db), policies: await repo.policies(db), statuses: runtime.snapshot(), brightness: displayBrightness(), error, input, dialogType }));
  }
  router.get('/rollladen', async (req, res, next) => { try { await page(res); } catch (e) { next(e); } });
  const mutate = (action, dialogType = 'shutter') => async (req, res, next) => {
    try { await action(req); await runtime.reload(); res.redirect('/rollladen'); }
    catch (e) { if (!e.validation) return next(e); try { await page(res, e.message, req.body, dialogType); } catch (e) { next(e); } }
  };
  router.post('/rollladen/save', mutate(async req => { await repo.save(db, req.body.id || null, req.body); if (req.body.newRoomName) await require('../heizung/runtime').reload(); }));
  router.post('/rollladen/delete', mutate(req => repo.run(db, 'DELETE FROM rollladen WHERE id = ?', [req.body.id])));
  router.post('/rollladen/room', mutate(req => repo.savePolicy(db, req.body.roomId, req.body.brightness), 'room'));
  return router;
};
