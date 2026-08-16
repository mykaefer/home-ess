'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { isEnabled } = require('../modules');
const rooms = require('../heimkino/rooms');
const actionsRepo = require('../heimkino/actions');
const runtime = require('../heimkino/runtime');
const renderHeimkino = require('../views/heimkino');
const renderHeimkinoRoom = require('../views/heimkino-room');

function countActions(list) {
  return (list || []).reduce((sum, action) => sum + 1 + countActions(action.children), 0);
}

function heimkinoRoutes(db) {
  const router = express.Router();

  // Aktionsfolgen und Kinomodus-States hochfahren (Vorbild Wallbox/Pool).
  runtime.init(db).catch(() => {});

  function requireHeimkinoEnabled(req, res, next) {
    if (!isEnabled('heimkino')) return res.redirect('/module');
    next();
  }

  async function overview(res, options = {}) {
    const list = await rooms.listRooms(db);
    const withCounts = [];
    for (const room of list) {
      const tree = await actionsRepo.actionTree(db, room.id);
      withCounts.push({
        ...room,
        stateTopic: rooms.stateTopic(room.id),
        onCount: countActions(tree.on),
        offCount: countActions(tree.off),
      });
    }
    res.status(options.status || 200).send(renderHeimkino({ rooms: withCounts, ...options }));
  }

  async function roomPage(res, roomId, options = {}) {
    const room = await rooms.getRoom(db, roomId);
    if (!room) return res.redirect('/heimkino');
    const [tree, actions] = await Promise.all([
      actionsRepo.actionTree(db, room.id),
      actionsRepo.listActions(db, room.id),
    ]);
    return res.status(options.status || 200).send(renderHeimkinoRoom({
      room: { ...room, stateTopic: rooms.stateTopic(room.id) },
      tree,
      actions,
      ...options,
    }));
  }

  router.get('/heimkino', requireAuth, requireHeimkinoEnabled, async (req, res, next) => {
    try { await overview(res, { message: String(req.query.ok || '').slice(0, 200) }); } catch (error) { next(error); }
  });

  router.get('/heimkino/raum/:id', requireAuth, requireHeimkinoEnabled, async (req, res, next) => {
    try { await roomPage(res, req.params.id, { message: String(req.query.ok || '').slice(0, 200) }); } catch (error) { next(error); }
  });

  // Raum-Verwaltung ───────────────────────────────────────────────────────
  const roomMutation = (action, message, dialog) => async (req, res, next) => {
    try {
      await action(req);
      await runtime.reload();
      res.redirect(`/heimkino?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        const initialDialog = typeof dialog === 'function' ? dialog(req) : dialog;
        if (initialDialog) initialDialog.error = error.message;
        await overview(res, { status: 400, error: error.message, initialDialog });
      } catch (renderError) { next(renderError); }
    }
  };

  router.post('/heimkino/rooms', requireAuth, requireHeimkinoEnabled, roomMutation(
    (req) => rooms.createRoom(db, req.body), 'Raum angelegt.',
    (req) => ({ mode: 'add', values: req.body })
  ));
  router.post('/heimkino/rooms/:id', requireAuth, requireHeimkinoEnabled, roomMutation(
    (req) => rooms.updateRoom(db, req.params.id, req.body), 'Raum gespeichert.',
    (req) => ({ mode: 'edit', roomId: Number(req.params.id), values: req.body })
  ));
  router.post('/heimkino/rooms/:id/delete', requireAuth, requireHeimkinoEnabled, roomMutation(
    (req) => rooms.deleteRoom(db, req.params.id), 'Raum entfernt.'
  ));

  // Kinomodus schalten: startet die zugehörige Aktionsfolge.
  router.post('/heimkino/rooms/:id/state', requireAuth, requireHeimkinoEnabled, async (req, res, next) => {
    try {
      const on = !['', '0', 'false', 'off', 'aus', 'no'].includes(String(req.body && req.body.on).trim().toLowerCase());
      const ok = await runtime.setRoomState(db, req.params.id, on);
      if (!ok) return res.redirect('/heimkino');
      const message = `Kinomodus ${on ? 'eingeschaltet' : 'ausgeschaltet'}.`;
      const target = String(req.body && req.body.redirect) === 'room'
        ? `/heimkino/raum/${Number(req.params.id)}`
        : '/heimkino';
      res.redirect(`${target}?ok=${encodeURIComponent(message)}`);
    } catch (error) { next(error); }
  });

  // Aktionsfolgen ─────────────────────────────────────────────────────────
  const actionMutation = (action, message, dialog) => async (req, res, next) => {
    const roomId = Number(req.params.id);
    try {
      await action(req);
      await runtime.reload();
      res.redirect(`/heimkino/raum/${roomId}?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        const initialDialog = typeof dialog === 'function' ? dialog(req) : dialog;
        if (initialDialog) initialDialog.error = error.message;
        await roomPage(res, roomId, { status: 400, error: error.message, initialDialog });
      } catch (renderError) { next(renderError); }
    }
  };

  // Feste Pfade zuerst: sonst greift `/actions/:actionId` für den Layout-Aufruf.
  router.post('/heimkino/raum/:id/layout', requireAuth, requireHeimkinoEnabled, async (req, res) => {
    try {
      await actionsRepo.updateLayout(db, req.params.id, req.body || {});
      await runtime.reload();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Layout konnte nicht gespeichert werden.' });
    }
  });

  router.post('/heimkino/raum/:id/actions', requireAuth, requireHeimkinoEnabled, actionMutation(
    (req) => actionsRepo.addAction(db, req.params.id, req.body), 'Aktion hinzugefügt.',
    (req) => ({ mode: 'add', values: req.body })
  ));
  router.post('/heimkino/raum/:id/actions/:actionId', requireAuth, requireHeimkinoEnabled, actionMutation(
    (req) => actionsRepo.updateAction(db, req.params.id, req.params.actionId, req.body), 'Aktion gespeichert.',
    (req) => ({ mode: 'edit', actionId: Number(req.params.actionId), values: req.body })
  ));
  router.post('/heimkino/raum/:id/actions/:actionId/delete', requireAuth, requireHeimkinoEnabled, actionMutation(
    (req) => actionsRepo.deleteAction(db, req.params.id, req.params.actionId), 'Aktion entfernt.'
  ));

  return router;
}

module.exports = heimkinoRoutes;
