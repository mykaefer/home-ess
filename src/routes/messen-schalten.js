'use strict';

// Routen der Seite „Messen + Schalten" (Vorbild: routes/dashboard.js + routes/wallbox.js).
// Gruppen und Geräte werden wie Dashboard-Gruppen/Widgets verwaltet, per Drag&Drop
// angeordnet und liefern Live-Werte für Kacheln, /data und den Wertekatalog.

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const {
  listActors, getActor, createActor, updateActor, deleteActor,
  reorderActors, normalizeInput, effectivePriority,
} = require('../messen-schalten/actors');
const {
  listGroups, createGroup, updateGroup, deleteGroup,
} = require('../messen-schalten/groups');
const { readActorValues, readGroupSums } = require('../messen-schalten/aggregation');
const automation = require('../messen-schalten/automation');
const renderMessenSchalten = require('../views/messen-schalten');
const { isEnabled } = require('../modules');

async function refreshMqttDefinitions(db) {
  const defs = await loadAllStateDefinitions(db);
  mqttClient.setStateDefinitions(defs);
}

const numberFmt0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const numberFmt2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function powerDisplay(watt) {
  return watt == null ? '— W' : `${numberFmt0.format(Math.round(watt))} W`;
}
function counterDisplay(kwh) {
  return kwh == null ? '— kWh' : `${numberFmt2.format(kwh)} kWh`;
}
function freshnessDisplay(receivedAt) {
  if (!receivedAt) return 'noch kein Wert empfangen';
  const seconds = Math.max(0, Math.floor((Date.now() - receivedAt) / 1000));
  if (seconds < 60) return `vor ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} min`;
  return `vor ${Math.floor(minutes / 60)} h`;
}

// Live-Werte je Gerät in Anzeigefelder überführen (für Initial-Render und /data).
function toViewActor(actor, value, groupsById) {
  const v = value || {};
  const fromGroup = actor.useGroupPriority && actor.groupId != null && groupsById.has(actor.groupId);
  const runtime = automation.getActorAutomationState(actor.id);
  return {
    id: actor.id,
    name: actor.name,
    groupId: actor.groupId,
    hasSwitch: !!actor.switchTopic,
    hasCounter: !!actor.counterTopic,
    alwaysOn: actor.alwaysOn === true,
    statusOn: v.statusOn == null ? null : !!v.statusOn,
    powerDisplay: powerDisplay(v.powerW),
    counterDisplay: counterDisplay(v.counterKwh),
    statusStale: v.statusStale === true,
    powerStale: v.powerStale === true,
    counterStale: v.counterStale === true,
    statusFreshness: freshnessDisplay(v.statusReceivedAt),
    powerFreshness: v.powerInferredOff ? '0 W aus bestätigtem AUS-Zustand abgeleitet' : freshnessDisplay(v.powerReceivedAt),
    counterFreshness: freshnessDisplay(v.counterReceivedAt),
    priority: effectivePriority(actor, groupsById),
    priorityFromGroup: fromGroup,
    loadShedEnabled: actor.loadShedEnabled === true,
    loadShedActive: runtime.loadShedOff === true,
  };
}

async function buildLiveData(db) {
  const cache = mqttClient.getCache();
  const actors = await listActors(db);
  // Lokale Adapterwerte beim Live-Refresh gedrosselt neu anfordern. Externe
  // MQTT-Topics werden ausdrücklich nicht gepollt (Homematic-Duty-Cycle).
  for (const actor of actors) {
    for (const suffix of ['switch', 'status', 'power', 'counter']) {
      if (actor[`${suffix}Topic`]) mqttClient.requestStateValue(`messschalt:${actor.id}:${suffix}`);
    }
  }
  const groups = await listGroups(db);
  const values = await readActorValues(db, cache, actors);
  const valueById = new Map(values.map((v) => [v.id, v]));
  const sums = readGroupSums(groups, values);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const viewActors = actors.map((actor) => toViewActor(actor, valueById.get(actor.id), groupsById));
  const viewGroups = groups.map((group) => ({
    id: group.id,
    title: group.title,
    priority: group.priority,
    functionKey: group.functionKey,
    sumDisplay: powerDisplay(sums.get(group.id) ? sums.get(group.id).powerW : null),
  }));
  return { actors, groups, viewActors, viewGroups };
}

async function renderPage(db, res, options = {}) {
  const { actors, groups, viewActors, viewGroups } = await buildLiveData(db);
  const actorsByGroup = new Map();
  const ungrouped = [];
  const groupById = new Map(viewGroups.map((g) => [g.id, g]));
  for (const actor of viewActors) {
    if (actor.groupId != null && groupById.has(actor.groupId)) {
      if (!actorsByGroup.has(actor.groupId)) actorsByGroup.set(actor.groupId, []);
      actorsByGroup.get(actor.groupId).push(actor);
    } else {
      ungrouped.push(actor);
    }
  }
  res.send(renderMessenSchalten({
    ungrouped,
    groups: viewGroups.map((g) => ({ ...g, actors: actorsByGroup.get(g.id) || [] })),
    groupsForSelect: groups,
    actorConfigs: actors.map((a) => ({
      id: a.id, name: a.name, groupId: a.groupId,
      switchTopic: a.switchTopic, remoteTopic: a.remoteTopic, statusTopic: a.statusTopic,
      powerTopic: a.powerTopic, powerUnit: a.powerUnit,
      counterTopic: a.counterTopic, counterUnit: a.counterUnit,
      priority: a.priority, useGroupPriority: a.useGroupPriority, alwaysOn: a.alwaysOn,
      functionKey: a.functionKey,
      loadShedEnabled: a.loadShedEnabled, loadShedPhase: a.loadShedPhase,
    })),
    gridControlEnabled: isEnabled('grid-control'),
    formMessage: options.formMessage || '',
    formError: options.formError || '',
    dialogMode: options.dialogMode || '',
    dialogError: options.dialogError || '',
    dialogValues: options.dialogValues || null,
    editingActorId: options.editingActorId != null ? options.editingActorId : null,
    groupDialogOpen: options.groupDialogOpen || false,
    groupDialogError: options.groupDialogError || '',
  }));
}

function messenSchaltenRoutes(db) {
  const router = express.Router();

  // Steuerschleife starten (läuft beim Boot, unabhängig von Seitenaufrufen).
  automation.init(db);

  router.get('/messen-schalten', requireAuth, async (req, res, next) => {
    try {
      await renderPage(db, res, {});
    } catch (err) { next(err); }
  });

  router.get('/messen-schalten/data', requireAuth, async (req, res, next) => {
    try {
      const { viewActors, viewGroups } = await buildLiveData(db);
      res.json({ actors: viewActors, groups: viewGroups });
    } catch (err) { next(err); }
  });

  // --- Geräte (Aktoren) ---------------------------------------------------
  router.post('/messen-schalten/actors', requireAuth, async (req, res, next) => {
    try {
      await createActor(db, req.body);
      await refreshMqttDefinitions(db);
      await automation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Gerät hinzugefügt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'add', dialogError: err.message, dialogValues: normalizeInput(req.body),
        });
      }
      next(err);
    }
  });

  router.post('/messen-schalten/actors/:id', requireAuth, async (req, res, next) => {
    try {
      await updateActor(db, Number(req.params.id), req.body);
      await refreshMqttDefinitions(db);
      await automation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Gerät gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'edit', dialogError: err.message,
          dialogValues: { id: Number(req.params.id), ...normalizeInput(req.body) },
          editingActorId: Number(req.params.id),
        });
      }
      next(err);
    }
  });

  router.post('/messen-schalten/actors/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteActor(db, Number(req.params.id));
      await refreshMqttDefinitions(db);
      await automation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Gerät gelöscht.' });
    } catch (err) { next(err); }
  });

  // Kachel-Toggle: Manuelles Einschalten wird durch die effektive Priorität gegatet.
  // Ausschalten ist immer erlaubt. Bei „Immer an" ist der Toggle ausgeblendet.
  router.post('/messen-schalten/actor/:id/switch/:state', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const on = req.params.state === '1' || req.params.state === 'on' || req.params.state === 'true';
      const actor = await getActor(db, id);
      if (!actor) return res.status(404).json({ error: 'Gerät nicht gefunden.' });
      const accepted = await automation.commandManual(db, id, on);
      res.json({ ok: true, on: accepted ? on : false, ignored: actor.alwaysOn === true,
        blocked: on && !accepted && actor.alwaysOn !== true });
    } catch (err) { next(err); }
  });

  // --- Gruppen ------------------------------------------------------------
  router.post('/messen-schalten/groups', requireAuth, async (req, res, next) => {
    try {
      await createGroup(db, req.body);
      await automation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Gruppe hinzugefügt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, { groupDialogOpen: true, groupDialogError: err.message });
      }
      next(err);
    }
  });

  router.post('/messen-schalten/groups/:id', requireAuth, async (req, res, next) => {
    try {
      await updateGroup(db, Number(req.params.id), req.body);
      await automation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Gruppe gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, { groupDialogOpen: true, groupDialogError: err.message });
      }
      next(err);
    }
  });

  router.post('/messen-schalten/groups/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteGroup(db, Number(req.params.id));
      await automation.runNow(db).catch(() => {});
      await renderPage(db, res, { formMessage: 'Gruppe gelöscht.' });
    } catch (err) { next(err); }
  });

  // Drag&Drop persistieren (Geräte: Gruppe + Position; Gruppen sind fest
  // alphanumerisch sortiert und nicht mehr verschiebbar).
  router.post('/messen-schalten/layout', requireAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (Array.isArray(body.actors)) await reorderActors(db, body.actors);
      await automation.runNow(db).catch(() => {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = messenSchaltenRoutes;
