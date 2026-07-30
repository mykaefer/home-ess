'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const {
  listOutputs,
  createOutput,
  updateOutput,
  deleteOutput,
  normalizeOutputInput,
} = require('../output/outputs');
const { listAllStates } = require('../states/repository');
const outputEngine = require('../output/engine');
const renderOutput = require('../views/output');

function enrichOutputs(outputs, valuesById) {
  return outputs.map((output) => {
    const entry = valuesById.get(output.sourceId);
    return {
      ...output,
      label: entry ? entry.label : output.sourceId,
      category: entry ? entry.category : 'Sonstiges',
      currentDisplay: entry ? entry.display : '—',
      verification: outputEngine.getStatus(output.id),
    };
  });
}

async function renderPage(db, res, options = {}) {
  const [outputs, internalValues] = await Promise.all([
    listOutputs(db),
    listAllStates(db, mqttClient.getCache()),
  ]);
  const valuesById = new Map(internalValues.map((entry) => [entry.id, entry]));
  const enriched = enrichOutputs(outputs, valuesById);
  const editingOutput =
    options.editingOutputId != null
      ? outputs.find((output) => output.id === Number(options.editingOutputId)) || null
      : null;

  res.send(
    renderOutput({
      outputs: enriched,
      internalValues: internalValues.map((entry) => ({
        id: entry.id,
        label: entry.label,
        display: entry.display,
        category: entry.category,
      })),
      formMessage: options.formMessage || '',
      formError: options.formError || '',
      dialogMode: options.dialogMode || '',
      dialogError: options.dialogError || '',
      dialogValues: options.dialogValues || (editingOutput || null),
      editingOutputId: editingOutput ? editingOutput.id : null,
    })
  );
}

function outputRoutes(db) {
  const router = express.Router();

  router.get('/output', requireAuth, async (req, res, next) => {
    try {
      await renderPage(db, res, {
        dialogMode: req.query.mode === 'add' || req.query.mode === 'edit' ? req.query.mode : '',
        editingOutputId: req.query.outputId || null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/output/data', requireAuth, async (req, res, next) => {
    try {
      const [outputs, internalValues] = await Promise.all([
        listOutputs(db),
        listAllStates(db, mqttClient.getCache()),
      ]);
      const valuesById = new Map(internalValues.map((entry) => [entry.id, entry]));
      res.json({
        outputs: outputs.map((output) => {
          const entry = valuesById.get(output.sourceId);
          return {
            id: output.id,
            currentDisplay: entry ? entry.display : '—',
            verification: outputEngine.getStatus(output.id),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/output/outputs', requireAuth, async (req, res, next) => {
    try {
      await createOutput(db, req.body);
      await outputEngine.reload();
      await outputEngine.evaluate();
      await renderPage(db, res, { formMessage: 'Output hinzugefuegt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'add',
          dialogError: err.message,
          dialogValues: normalizeOutputInput(req.body),
        });
      }
      next(err);
    }
  });

  router.post('/output/outputs/:id', requireAuth, async (req, res, next) => {
    try {
      await updateOutput(db, Number(req.params.id), req.body);
      await outputEngine.reload();
      await outputEngine.evaluate();
      await renderPage(db, res, { formMessage: 'Output gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'edit',
          dialogError: err.message,
          dialogValues: normalizeOutputInput(req.body),
          editingOutputId: Number(req.params.id),
        });
      }
      next(err);
    }
  });

  router.post('/output/outputs/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteOutput(db, Number(req.params.id));
      await outputEngine.reload();
      await renderPage(db, res, { formMessage: 'Output geloescht.' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = outputRoutes;
