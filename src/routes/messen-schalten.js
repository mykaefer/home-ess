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
  listGroups, createGroup, updateGroup, deleteGroup, setGroupParent, setGroupColor,
} = require('../messen-schalten/groups');
const levelHandler = require('../operating-level/handler');
const {
  listSwitchGroups, createSwitchGroup, updateSwitchGroup, deleteSwitchGroup,
  assignActorToSwitchGroup,
} = require('../messen-schalten/schaltgruppen');
const { readActorValues, readGroupPowerTree, readGroupEnergyTree } = require('../messen-schalten/aggregation');
const { assembleEnergiefluss } = require('../messen-schalten/energiefluss');
const automation = require('../messen-schalten/automation');
const schaltgruppenAutomation = require('../messen-schalten/schaltgruppen-automation');
const renderMessenSchalten = require('../views/messen-schalten');
const renderSchaltgruppen = require('../views/schaltgruppen');
const renderEnergiefluss = require('../views/energiefluss');
const { listPvPlants } = require('../photovoltaik/plants');
const { readPhotovoltaikValues } = require('../photovoltaik/aggregation');
const { readStromverbrauchValues } = require('../stromverbrauch/aggregation');
const { readBatterieData, loadBatterieConfig } = require('../batterie/config');
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
// Reine Zahl ohne Einheit für die verkürzte „Ebene/Gesamt W"-Darstellung.
function powerNumber(watt) {
  return watt == null ? '—' : numberFmt0.format(Math.round(watt));
}
// Titelanzeige der Verbrauchssumme:
//  • Zählergruppe: nur die fixe Gesamtleistung (keine Ebene).
//  • Gruppe mit Untergruppen: verkürzt „Ebene/Gesamt W".
//  • sonst: die eine Zahl (Ebene = Gesamt, da keine Untergruppen).
function groupSumDisplay(tree) {
  if (!tree) return powerDisplay(null);
  if (tree.meterGroup) return powerDisplay(tree.gesamtW);
  return tree.hasChildren
    ? `${powerNumber(tree.ebeneW)}/${powerNumber(tree.gesamtW)} W`
    : powerDisplay(tree.gesamtW);
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
  const tree = readGroupPowerTree(groups, values);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const viewActors = actors.map((actor) => toViewActor(actor, valueById.get(actor.id), groupsById));
  const viewGroups = groups.map((group) => {
    const t = tree.get(group.id) || {};
    return {
      id: group.id,
      title: group.title,
      priority: group.priority,
      functionKey: group.functionKey,
      offsetTotalConsumption: group.offsetTotalConsumption,
      parentId: group.parentId,
      meterGroup: group.meterGroup === true,
      hasChildren: t.hasChildren === true,
      // „Sonstige Verbraucher"-Fußzeile nur bei Zählergruppen mit Untergruppen.
      showSonstige: t.meterGroup === true && t.hasChildren === true,
      // Verkürzte Titelanzeige plus die Einzelwerte für Live-Updates.
      sumDisplay: groupSumDisplay(t),
      ebeneDisplay: powerDisplay(t.ebeneW == null ? null : t.ebeneW),
      gesamtDisplay: powerDisplay(t.gesamtW == null ? null : t.gesamtW),
      sonstigeDisplay: powerDisplay(t.sonstigeW == null ? null : t.sonstigeW),
    };
  });
  return { actors, groups, viewActors, viewGroups };
}

// Flache, alphanumerisch sortierte Gruppenliste in Baum-Reihenfolge mit
// Tiefenangabe (für das eingerückte Auswahlfeld im Geräte-Dialog).
function flattenGroupsForSelect(viewGroups) {
  const childrenByParent = new Map();
  for (const g of viewGroups) {
    const parent = g.parentId == null ? null : g.parentId;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(g);
  }
  const out = [];
  const walk = (parentKey, depth, guard) => {
    for (const g of childrenByParent.get(parentKey) || []) {
      if (guard.has(g.id)) continue;
      guard.add(g.id);
      out.push({ id: g.id, title: g.title, depth });
      walk(g.id, depth + 1, guard);
    }
  };
  walk(null, 0, new Set());
  return out;
}

// Verschachtelte Gruppen zu einem Baum verknüpfen (parentId -> children).
// Reihenfolge bleibt die alphanumerische Sortierung aus listGroups.
function buildGroupTree(groups) {
  const nodeById = new Map(groups.map((g) => [g.id, { ...g, children: [] }]));
  const roots = [];
  for (const node of nodeById.values()) {
    if (node.parentId != null && nodeById.has(node.parentId) && node.parentId !== node.id) {
      nodeById.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function renderPage(db, res, options = {}) {
  const { actors, viewActors, viewGroups } = await buildLiveData(db);
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
  const withActors = viewGroups.map((g) => ({ ...g, actors: actorsByGroup.get(g.id) || [] }));
  res.send(renderMessenSchalten({
    ungrouped,
    groups: buildGroupTree(withActors),
    groupsForSelect: flattenGroupsForSelect(viewGroups),
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

// Daten der Schaltgruppen-Unterseite: Gruppen mit ihren zugeordneten Geräten
// (Schaltzustand aus den Ist-Werten abgeleitet) plus die noch nicht zugeordneten
// Geräte für die rechte Spalte.
async function buildSchaltgruppenData(db) {
  const cache = mqttClient.getCache();
  const actors = await listActors(db);
  const groups = await listSwitchGroups(db);
  const values = await readActorValues(db, cache, actors);
  const valueById = new Map(values.map((v) => [v.id, v]));
  const viewActors = actors.map((actor) => {
    const v = valueById.get(actor.id) || {};
    return {
      id: actor.id,
      name: actor.name,
      switchGroupId: actor.switchGroupId,
      statusOn: v.statusOn == null ? null : !!v.statusOn,
      powerDisplay: powerDisplay(v.powerW),
    };
  });
  const groupIds = new Set(groups.map((g) => g.id));
  const viewGroups = groups.map((group) => {
    const members = viewActors.filter((a) => a.switchGroupId === group.id);
    return {
      id: group.id,
      name: group.name,
      remoteTopic: group.remoteTopic,
      switchAsUnit: group.switchAsUnit,
      timerMinutes: group.timerMinutes,
      // Eine Gruppe gilt als AN, sobald ein Gerät an ist; als AUS erst, wenn
      // alle aus sind. Ohne bekannten Gerätezustand bleibt der Zustand offen.
      on: members.some((a) => a.statusOn === true) ? true
        : members.length && members.every((a) => a.statusOn === false) ? false : null,
      actors: members,
    };
  });
  const unassigned = viewActors.filter((a) => a.switchGroupId == null || !groupIds.has(a.switchGroupId));
  return { groups: viewGroups, unassigned, groupConfigs: groups };
}

// Momentaufnahme für das Energiefluss-Diagramm: PV (gebündelt), Netz, Batterie,
// zentraler Eigenverbrauch und die verschachtelten Gruppen als Ausgangszweige.
async function buildEnergieflussData(db) {
  const cache = mqttClient.getCache();
  const plants = await listPvPlants(db);
  const [pvValues, stromValues, batteryConfig] = await Promise.all([
    readPhotovoltaikValues(db, cache, plants),
    readStromverbrauchValues(db, cache),
    new Promise((resolve) => loadBatterieConfig(db, resolve)),
  ]);
  const batteryData = readBatterieData(cache);
  const actors = await listActors(db);
  const groups = await listGroups(db);
  const values = await readActorValues(db, cache, actors);
  const groupTree = readGroupPowerTree(groups, values);
  const groupStatus = computeGroupStatus(actors, groups);
  const groupEnergy = await readGroupEnergyTree(db, groups);
  return assembleEnergiefluss({ pvValues, stromValues, batteryData, batteryConfig, groups, groupTree, groupStatus, groupEnergy });
}

// Je Gruppe ermitteln, ob ihre schaltbaren Geräte gerade durch das Betriebslevel
// (Priorität) oder den Lastabwurf abgeschaltet sind. Eine Gruppe gilt als
// „deaktiviert", wenn sie schaltbare Geräte hat und diese ALLE gerade gesperrt
// sind – solche Gruppen werden im Diagramm ausgegraut.
function computeGroupStatus(actors, groups) {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const acc = new Map(); // groupId -> { hasSwitch, allGated }
  for (const actor of actors) {
    if (actor.groupId == null || !actor.switchTopic) continue;
    const priority = effectivePriority(actor, groupsById);
    const allowed = levelHandler.isAllowed(priority);
    const shed = automation.getActorAutomationState(actor.id).loadShedOff === true;
    const gated = !allowed || shed;
    const cur = acc.get(actor.groupId) || { hasSwitch: false, allGated: true };
    cur.hasSwitch = true;
    if (!gated) cur.allGated = false;
    acc.set(actor.groupId, cur);
  }
  const status = new Map();
  for (const [gid, s] of acc) status.set(gid, { deactivated: s.hasSwitch && s.allGated });
  return status;
}

async function renderSchaltgruppenPage(db, res, options = {}) {
  const { groups, unassigned, groupConfigs } = await buildSchaltgruppenData(db);
  res.send(renderSchaltgruppen({
    groups,
    unassigned,
    groupConfigs,
    formMessage: options.formMessage || '',
    formError: options.formError || '',
    groupDialogOpen: options.groupDialogOpen || false,
    groupDialogError: options.groupDialogError || '',
  }));
}

function messenSchaltenRoutes(db) {
  const router = express.Router();

  // Steuerschleifen starten (laufen beim Boot, unabhängig von Seitenaufrufen).
  automation.init(db);
  schaltgruppenAutomation.init(db);

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
      await createGroup(db, {
        ...req.body,
        offsetTotalConsumption: req.body.offsetTotalConsumption || false,
      });
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
      await updateGroup(db, Number(req.params.id), {
        ...req.body,
        offsetTotalConsumption: req.body.offsetTotalConsumption || false,
      });
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

  // Verschachtelung per Drag & Drop: Gruppe unter eine andere hängen (parentId)
  // bzw. mit parentId=null auf die oberste Ebene lösen. Zyklen werden abgewiesen.
  router.post('/messen-schalten/groups/:id/parent', requireAuth, async (req, res, next) => {
    try {
      await setGroupParent(db, Number(req.params.id), (req.body || {}).parentId);
      await automation.runNow(db).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      if (err.validation) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Freie Gruppenfarbe fürs Energiefluss-Diagramm setzen (leer = Standard).
  router.post('/messen-schalten/groups/:id/color', requireAuth, async (req, res, next) => {
    try {
      await setGroupColor(db, Number(req.params.id), (req.body || {}).color);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // --- Energiefluss (Unterseite) -------------------------------------------
  router.get('/messen-schalten/energiefluss', requireAuth, async (req, res, next) => {
    try {
      res.send(renderEnergiefluss({ data: await buildEnergieflussData(db) }));
    } catch (err) { next(err); }
  });

  router.get('/messen-schalten/energiefluss/data', requireAuth, async (req, res, next) => {
    try {
      res.json(await buildEnergieflussData(db));
    } catch (err) { next(err); }
  });

  // --- Schaltgruppen (Unterseite) ------------------------------------------
  router.get('/messen-schalten/schaltgruppen', requireAuth, async (req, res, next) => {
    try {
      await renderSchaltgruppenPage(db, res, {});
    } catch (err) { next(err); }
  });

  router.get('/messen-schalten/schaltgruppen/data', requireAuth, async (req, res, next) => {
    try {
      // Anzeige und Remote-Synchronisation aus demselben Snapshot ableiten. Wenn
      // die UI eine Gruppe als AN/AUS meldet, ist ihr Remote-Topic zuvor bereits
      // durch denselben Automations-Tick abgeglichen worden.
      await schaltgruppenAutomation.runNow(db);
      const { groups, unassigned } = await buildSchaltgruppenData(db);
      const actors = [...unassigned, ...groups.flatMap((g) => g.actors)];
      res.json({
        groups: groups.map((g) => ({ id: g.id, on: g.on })),
        actors: actors.map((a) => ({ id: a.id, statusOn: a.statusOn, powerDisplay: a.powerDisplay })),
      });
    } catch (err) { next(err); }
  });

  router.post('/messen-schalten/schaltgruppen', requireAuth, async (req, res, next) => {
    try {
      await createSwitchGroup(db, req.body);
      await refreshMqttDefinitions(db);
      await schaltgruppenAutomation.runNow(db).catch(() => {});
      await renderSchaltgruppenPage(db, res, { formMessage: 'Schaltgruppe hinzugefügt.' });
    } catch (err) {
      if (err.validation) {
        return renderSchaltgruppenPage(db, res, { groupDialogOpen: true, groupDialogError: err.message });
      }
      next(err);
    }
  });

  // Drag&Drop-Zuordnung: Gerät einer Schaltgruppe zuordnen bzw. lösen (groupId null).
  router.post('/messen-schalten/schaltgruppen/assign', requireAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      await assignActorToSwitchGroup(db, body.actorId, body.groupId);
      await schaltgruppenAutomation.runNow(db).catch(() => {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Gruppe schalten (UI-Toggle): Einschalten schaltet alle Geräte der Gruppe ein
  // (je Gerät durch die effektive Priorität gegatet), Ausschalten alle aus.
  router.post('/messen-schalten/schaltgruppen/:id/switch/:state', requireAuth, async (req, res, next) => {
    try {
      const on = req.params.state === '1' || req.params.state === 'on' || req.params.state === 'true';
      const ok = await schaltgruppenAutomation.commandGroup(db, Number(req.params.id), on);
      if (!ok) return res.status(404).json({ error: 'Schaltgruppe nicht gefunden.' });
      await schaltgruppenAutomation.runNow(db).catch(() => {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  router.post('/messen-schalten/schaltgruppen/:id', requireAuth, async (req, res, next) => {
    try {
      await updateSwitchGroup(db, Number(req.params.id), req.body);
      await refreshMqttDefinitions(db);
      await schaltgruppenAutomation.runNow(db).catch(() => {});
      await renderSchaltgruppenPage(db, res, { formMessage: 'Schaltgruppe gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderSchaltgruppenPage(db, res, { groupDialogOpen: true, groupDialogError: err.message });
      }
      next(err);
    }
  });

  router.post('/messen-schalten/schaltgruppen/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteSwitchGroup(db, Number(req.params.id));
      await refreshMqttDefinitions(db);
      await schaltgruppenAutomation.runNow(db).catch(() => {});
      await renderSchaltgruppenPage(db, res, { formMessage: 'Schaltgruppe gelöscht.' });
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
