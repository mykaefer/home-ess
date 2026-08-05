'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const repository = require('../conditions/repository');
const engine = require('../conditions/engine');
const renderConditions = require('../views/conditions');

function conditionsRoutes(db) {
  const router = express.Router();

  async function page(res, options = {}) {
    const { folders, conditions, tree } = await repository.conditionTree(db);
    res.status(options.status || 200).send(renderConditions({ folders, conditions, tree, ...options }));
  }

  router.get('/conditions', requireAuth, async (req, res, next) => {
    try { await page(res, { message: String(req.query.ok || '').slice(0, 200) }); } catch (error) { next(error); }
  });

  const mutate = (action, message, dialog) => async (req, res, next) => {
    try {
      await action(req);
      await engine.reload();
      res.redirect(`/conditions?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        const initialDialog = typeof dialog === 'function' ? dialog(req) : dialog;
        if (initialDialog) initialDialog.error = error.message;
        await page(res, { status: 400, error: error.message, initialDialog });
      } catch (renderError) { next(renderError); }
    }
  };

  // Feste Pfade zuerst: sonst greift `/conditions/:id` und beantwortet die
  // JSON- und Verzeichnisaufrufe mit einer HTML-Seite.
  router.post('/conditions/layout', requireAuth, async (req, res) => {
    try {
      await repository.updateLayout(db, req.body || {});
      await engine.reload();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Layout konnte nicht gespeichert werden.' });
    }
  });
  router.post('/conditions/folder', requireAuth, mutate(
    (req) => repository.addFolder(db, req.body), 'Verzeichnis angelegt.',
    (req) => ({ kind: 'folder-add', values: req.body })
  ));
  router.post('/conditions/folder/:id', requireAuth, mutate(
    (req) => repository.updateFolder(db, req.params.id, req.body), 'Verzeichnis gespeichert.',
    (req) => ({ kind: 'folder-edit', folderId: Number(req.params.id), values: req.body })
  ));
  router.post('/conditions/folder/:id/delete', requireAuth, mutate(
    (req) => repository.deleteFolder(db, req.params.id), 'Verzeichnis entfernt.'
  ));

  router.post('/conditions', requireAuth, mutate(
    (req) => repository.createCondition(db, req.body), 'Bedingung angelegt.',
    (req) => ({ kind: 'condition-create', values: req.body })
  ));
  router.post('/conditions/:id', requireAuth, mutate(
    (req) => repository.updateCondition(db, req.params.id, req.body), 'Bedingung gespeichert.',
    (req) => ({ kind: 'condition-edit', conditionId: Number(req.params.id), values: req.body })
  ));
  router.post('/conditions/:id/delete', requireAuth, mutate(
    (req) => repository.deleteCondition(db, req.params.id), 'Bedingung entfernt.'
  ));
  router.post('/conditions/:id/items', requireAuth, mutate(
    (req) => repository.addItem(db, req.params.id, req.body), 'Element hinzugefügt.',
    (req) => ({ kind: 'item-add', conditionId: Number(req.params.id), values: req.body })
  ));
  router.post('/conditions/:id/items/:itemId', requireAuth, mutate(
    (req) => repository.updateItem(db, req.params.id, req.params.itemId, req.body), 'Element gespeichert.',
    (req) => ({ kind: 'item-edit', conditionId: Number(req.params.id), itemId: Number(req.params.itemId), values: req.body })
  ));
  router.post('/conditions/:id/items/:itemId/delete', requireAuth, mutate(
    (req) => repository.deleteItem(db, req.params.id, req.params.itemId), 'Element entfernt.'
  ));

  return router;
}

module.exports = conditionsRoutes;
