'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { isEnabled } = require('../modules');
const { checkboxValue } = require('../conditions/values');
const rooms = require('../heizung/rooms');
const actionsRepo = require('../heizung/actions');
const central = require('../heizung/central');
const billing = require('../heizung/billing');
const runtime = require('../heizung/runtime');
const renderHeizung = require('../views/heizung');
const renderHeizungRoom = require('../views/heizung-room');
const renderHeizungZentrale = require('../views/heizung-zentrale');

function heizungRoutes(db) {
  const router = express.Router();

  // Regelung hochfahren (Vorbild Wallbox/Pool/Heimkino).
  runtime.init(db).catch(() => {});

  function requireHeizungEnabled(req, res, next) {
    if (!isEnabled('heizung')) return res.redirect('/module');
    next();
  }

  // Räume samt Momentaufnahme der Regelung für die Übersicht.
  async function roomsWithState() {
    const list = await rooms.listRooms(db);
    const snapshot = runtime.snapshot();
    const [sensors, contacts] = await Promise.all([rooms.listAllSensors(db), rooms.listAllContacts(db)]);
    const withState = [];
    for (const room of list) {
      const tree = await actionsRepo.actionTree(db, room.id);
      withState.push({
        ...room,
        state: snapshot.get(room.id) || {},
        sensorCount: sensors.filter((sensor) => sensor.roomId === room.id).length,
        contactCount: contacts.filter((contact) => contact.roomId === room.id).length,
        actionCount: actionsRepo.PHASE_KEYS.reduce((sum, phase) => sum + actionsRepo.countActions(tree[phase]), 0),
        hasHeatDevice: actionsRepo.hasDevice(tree, 'heat'),
        hasCoolDevice: actionsRepo.hasDevice(tree, 'cool'),
        temperatureTopic: rooms.stateTopic(room.name, 'temperatur'),
      });
    }
    return withState;
  }

  async function overview(res, options = {}) {
    const [list, config] = await Promise.all([roomsWithState(), central.loadCentralConfig(db)]);
    const period = await billing.loadBilling(db);
    res.status(options.status || 200).send(renderHeizung({
      rooms: list,
      central: config,
      centralState: runtime.centralSnapshot(),
      billing: await billing.billingStatistics(db, config, period),
      ...options,
    }));
  }

  async function roomPage(res, roomId, options = {}) {
    const room = await rooms.getRoom(db, roomId);
    if (!room) return res.redirect('/heizung');
    const [sensors, contacts, config, tree, actions] = await Promise.all([
      rooms.listSensors(db, room.id),
      rooms.listContacts(db, room.id),
      central.loadCentralConfig(db),
      actionsRepo.actionTree(db, room.id),
      actionsRepo.listActions(db, room.id),
    ]);
    return res.status(options.status || 200).send(renderHeizungRoom({
      room,
      sensors,
      contacts,
      central: config,
      tree,
      actions,
      state: runtime.snapshot().get(room.id) || {},
      stateTopics: rooms.ROOM_STATES.map((entry) => ({
        label: entry.label,
        topic: rooms.stateTopic(room.name, entry.suffix),
        writable: entry.writable,
      })),
      ...options,
    }));
  }

  async function centralPage(res, options = {}) {
    const [config, stats, runs] = await Promise.all([
      central.loadCentralConfig(db),
      central.loadCentralConfig(db).then((cfg) => central.burnerStatistics(db, cfg)),
      central.listRuns(db, 20),
    ]);
    return res.status(options.status || 200).send(renderHeizungZentrale({
      central: config,
      state: runtime.centralSnapshot(),
      stats,
      runs,
      demandRooms: (await roomsWithState()).filter((room) => room.state && room.state.centralDemand),
      ...options,
    }));
  }

  router.get('/heizung', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    try { await overview(res, { message: String(req.query.ok || '').slice(0, 200) }); } catch (error) { next(error); }
  });

  router.get('/heizung/raum/:id', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    try { await roomPage(res, req.params.id, { message: String(req.query.ok || '').slice(0, 200) }); } catch (error) { next(error); }
  });

  router.get('/heizung/zentrale', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    try { await centralPage(res, { message: String(req.query.ok || '').slice(0, 200) }); } catch (error) { next(error); }
  });

  // Live-Werte für die Übersicht (Polling wie bei der Poolsteuerung).
  router.get('/heizung/status', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    try {
      const snapshot = runtime.snapshot();
      const config = await central.loadCentralConfig(db);
      const stats = await central.burnerStatistics(db, config);
      res.json({
        rooms: [...snapshot.entries()].map(([id, state]) => ({ id, ...state })),
        central: { ...runtime.centralSnapshot(), enabled: config.enabled, sweepEnabled: config.sweepEnabled, unit: config.unit },
        stats: { todayHours: stats.today.hours, todayConsumption: stats.today.consumption, todayCost: stats.today.cost },
      });
    } catch (error) { next(error); }
  });

  // Raum-Verwaltung ───────────────────────────────────────────────────────
  const roomMutation = (action, message, dialog) => async (req, res, next) => {
    try {
      await action(req);
      await runtime.reload();
      await runtime.tick().catch(() => {});
      res.redirect(`/heizung?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        const initialDialog = typeof dialog === 'function' ? dialog(req) : dialog;
        if (initialDialog) initialDialog.error = error.message;
        await overview(res, { status: 400, error: error.message, initialDialog });
      } catch (renderError) { next(renderError); }
    }
  };

  router.post('/heizung/rooms', requireAuth, requireHeizungEnabled, roomMutation(
    (req) => rooms.createRoom(db, req.body), 'Raum angelegt.',
    (req) => ({ mode: 'add', values: req.body })
  ));
  router.post('/heizung/rooms/:id/delete', requireAuth, requireHeizungEnabled, roomMutation(
    (req) => rooms.deleteRoom(db, req.params.id), 'Raum entfernt.'
  ));

  // Einstellungen eines Raums (eigene Seite).
  const roomPageMutation = (action, message, dialog) => async (req, res, next) => {
    const roomId = Number(req.params.id);
    try {
      await action(req);
      await runtime.reload();
      await runtime.tick().catch(() => {});
      res.redirect(`/heizung/raum/${roomId}?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        const initialDialog = typeof dialog === 'function' ? dialog(req) : dialog;
        if (initialDialog) initialDialog.error = error.message;
        await roomPage(res, roomId, { status: 400, error: error.message, initialDialog });
      } catch (renderError) { next(renderError); }
    }
  };

  router.post('/heizung/raum/:id', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.updateRoom(db, req.params.id, req.body), 'Einstellungen gespeichert.'
  ));

  // Soll-Temperatur schnell verstellen (Übersicht und Raumseite).
  router.post('/heizung/raum/:id/soll', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    const roomId = Number(req.params.id);
    const room = String(req.body && req.body.redirect) === 'room';
    try {
      await rooms.setTargetTemp(db, roomId, req.body && req.body.targetTemp);
      await runtime.reload();
      await runtime.tick().catch(() => {});
      const target = room ? `/heizung/raum/${roomId}` : '/heizung';
      res.redirect(`${target}?ok=${encodeURIComponent('Soll-Temperatur gesetzt.')}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        if (room) await roomPage(res, roomId, { status: 400, error: error.message });
        else await overview(res, { status: 400, error: error.message });
      } catch (renderError) { next(renderError); }
    }
  });

  // Prioritäten und Ersatzschaltung: eigenes Formular, damit die übrigen
  // Einstellungen des Raums unberührt bleiben.
  router.post('/heizung/raum/:id/prioritaeten', requireAuth, requireHeizungEnabled, roomPageMutation(
    async (req) => {
      const current = await rooms.getRoom(db, req.params.id);
      if (!current) throw Object.assign(new Error('Raum nicht gefunden.'), { validation: true });
      await rooms.updateRoom(db, req.params.id, {
        ...current,
        heatPriority: req.body.heatPriority,
        coolPriority: req.body.coolPriority,
        heatCentralFallback: req.body.heatCentralFallback,
      });
    }, 'Prioritäten gespeichert.'
  ));

  router.post('/heizung/raum/:id/sensoren', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.addSensor(db, req.params.id, req.body), 'Temperaturquelle hinzugefügt.',
    (req) => ({ kind: 'sensor', mode: 'add', values: req.body })
  ));
  router.post('/heizung/raum/:id/sensoren/:sensorId', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.updateSensor(db, req.params.id, req.params.sensorId, req.body), 'Temperaturquelle gespeichert.',
    (req) => ({ kind: 'sensor', mode: 'edit', id: Number(req.params.sensorId), values: req.body })
  ));
  router.post('/heizung/raum/:id/sensoren/:sensorId/delete', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.deleteSensor(db, req.params.id, req.params.sensorId), 'Temperaturquelle entfernt.'
  ));

  router.post('/heizung/raum/:id/kontakte', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.addContact(db, req.params.id, req.body), 'Kontakt hinzugefügt.',
    (req) => ({ kind: 'contact', mode: 'add', values: req.body })
  ));
  router.post('/heizung/raum/:id/kontakte/:contactId', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.updateContact(db, req.params.id, req.params.contactId, req.body), 'Kontakt gespeichert.',
    (req) => ({ kind: 'contact', mode: 'edit', id: Number(req.params.contactId), values: req.body })
  ));
  router.post('/heizung/raum/:id/kontakte/:contactId/delete', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => rooms.deleteContact(db, req.params.id, req.params.contactId), 'Kontakt entfernt.'
  ));

  // Aktionsfolgen der Geräte ──────────────────────────────────────────────
  // Feste Pfade zuerst: sonst greift `/actions/:actionId` für den Layout-Aufruf.
  router.post('/heizung/raum/:id/layout', requireAuth, requireHeizungEnabled, async (req, res) => {
    try {
      await actionsRepo.updateLayout(db, req.params.id, req.body || {});
      await runtime.reload();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Layout konnte nicht gespeichert werden.' });
    }
  });

  router.post('/heizung/raum/:id/actions', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => actionsRepo.addAction(db, req.params.id, req.body), 'Aktion hinzugefügt.',
    (req) => ({ kind: 'action', mode: 'add', values: req.body })
  ));
  router.post('/heizung/raum/:id/actions/:actionId', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => actionsRepo.updateAction(db, req.params.id, req.params.actionId, req.body), 'Aktion gespeichert.',
    (req) => ({ kind: 'action', mode: 'edit', actionId: Number(req.params.actionId), values: req.body })
  ));
  router.post('/heizung/raum/:id/actions/:actionId/delete', requireAuth, requireHeizungEnabled, roomPageMutation(
    (req) => actionsRepo.deleteAction(db, req.params.id, req.params.actionId), 'Aktion entfernt.'
  ));

  // Zählwerk der Heizkosten ───────────────────────────────────────────────
  const billingMutation = (action, message) => async (req, res, next) => {
    try {
      const result = await action(req);
      res.redirect(`/heizung?ok=${encodeURIComponent(typeof message === 'function' ? message(result) : message)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try { await overview(res, { status: 400, error: error.message }); } catch (renderError) { next(renderError); }
    }
  };

  router.post('/heizung/zaehlwerk/startwert', requireAuth, requireHeizungEnabled, billingMutation(
    (req) => billing.setStartConsumption(db, req.body && req.body.startConsumption), 'Startwert gespeichert.'
  ));

  // Zeitraum abschließen: der laufende wandert ins Archiv, der neue beginnt
  // bei 0. Optional kalibriert der abgelesene Zählerstand die Schätzung.
  router.post('/heizung/zaehlwerk/reset', requireAuth, requireHeizungEnabled, billingMutation(
    (req) => billing.closePeriod(db, {
      metered: req.body && req.body.metered,
      calibrate: checkboxValue(req.body && req.body.calibrate),
    }),
    (result) => (result.factor == null
      ? 'Zeitraum abgeschlossen.'
      : `Zeitraum abgeschlossen und Verbrauch je Betriebsstunde um Faktor ${String(Math.round(result.factor * 1000) / 1000).replace('.', ',')} nachgezogen.`)
  ));

  // Zentralheizung ────────────────────────────────────────────────────────
  router.post('/heizung/zentrale', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    try {
      await central.saveCentralConfig(db, req.body);
      await runtime.reload();
      await runtime.tick().catch(() => {});
      res.redirect(`/heizung/zentrale?ok=${encodeURIComponent('Zentralheizung gespeichert.')}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        await centralPage(res, { status: 400, error: error.message, values: req.body });
      } catch (renderError) { next(renderError); }
    }
  });

  // Schornsteinfeger-Modus: alle Räume auf 28 °C, Zentralheizung an, lokale
  // Geräte aus.
  router.post('/heizung/zentrale/schornsteinfeger', requireAuth, requireHeizungEnabled, async (req, res, next) => {
    try {
      const on = !['', '0', 'false', 'off', 'aus', 'no'].includes(String(req.body && req.body.on).trim().toLowerCase());
      await runtime.setSweepMode(on);
      const message = on ? 'Schornsteinfeger-Modus eingeschaltet.' : 'Schornsteinfeger-Modus beendet.';
      res.redirect(`/heizung/zentrale?ok=${encodeURIComponent(message)}`);
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = heizungRoutes;
