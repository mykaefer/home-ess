'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const { resolveStates } = require('../states/catalog');
const repository = require('../notifications/rules');
const engine = require('../notifications/engine');
const service = require('../notifications/service');
const connectionService = require('../remote-access/connection-service');
const { valueType } = require('../notifications/triggers');
const renderNotifications = require('../views/notifications');

// Die States kommen aus der bestehenden zentralen State-Verwaltung. Eine Regel
// hält nur deren kanonische Adresse; Bezeichnung, aktueller Wert und Werttyp
// werden bei jeder Anzeige frisch daraus gelesen.
//
// Aufgelöst wird über `states/catalog.resolveStates()` — dieselbe gemeinsame
// Auflösungsgrenze, die auch die Output-Engine verwendet. Sie ist hier zwingend:
// berechnete Systemwerte stehen im flachen Wertekatalog unter ihrer fachlichen
// Kurz-ID (`operating.notstrom`), adressiert werden sie aber über ihr
// kanonisches Topic (`system://homeess/operating.notstrom`) — genau das, was der
// State-Picker einträgt und was die Rule Engine abonniert. Ein einfacher
// Abgleich gegen den Katalog würde solche States fälschlich als gelöscht melden.
async function resolveRuleStates(db, stateIds) {
  const wanted = [...new Set((stateIds || []).filter(Boolean))];
  if (!wanted.length) return new Map();
  const entries = await resolveStates(db, mqttClient.getCache(), wanted);
  return new Map(entries.map((entry) => [entry.id, entry]));
}

// Regel um die Sicht auf ihren State ergänzen. Zeigt eine Regel auf einen nicht
// mehr vorhandenen State, wird sie als ungültig markiert — sie bleibt erhalten,
// damit der Benutzer sie reparieren kann, löst aber nicht aus.
function enrich(rule, states) {
  const entry = states.get(rule.stateId) || null;
  return {
    ...rule,
    stateLabel: entry ? entry.label : rule.stateId,
    stateDisplay: entry ? entry.display : '—',
    stateValueType: entry ? valueType(entry.value) : null,
    stateMissing: !entry,
  };
}

function relayState() {
  const status = connectionService.getStatus() || {};
  return status.state === 'authenticated' ? 'connected' : 'disconnected';
}

// Rückmeldung der Testfunktion. Sie richtet sich allein nach dem Ergebnis des
// Nachrichtendienstes; homeESS kennt die Empfänger nicht selbst.
function testMessage(result) {
  if (result.accepted && result.recipients > 0) {
    return result.recipients === 1
      ? 'Nachricht an 1 Gerät gesendet.'
      : `Nachricht an ${result.recipients} Geräte gesendet.`;
  }
  if (result.accepted) return 'Keine gekoppelten Push-Geräte vorhanden.';
  if (result.reason === 'relay_unavailable' || result.reason === 'not_authenticated') {
    return 'Relay derzeit nicht verfügbar.';
  }
  return 'Nachricht konnte nicht gesendet werden.';
}

function notificationRoutes(db) {
  const router = express.Router();

  async function page(res, options = {}) {
    const rawRules = await repository.listRules(db);
    const states = await resolveRuleStates(db, rawRules.map((rule) => rule.stateId));
    const rules = rawRules.map((rule) => enrich(rule, states));
    res.status(options.status || 200).send(renderNotifications({
      rules,
      relayState: relayState(),
      message: options.message || '',
      error: options.error || '',
      dialogMode: options.dialogMode || '',
      dialogValues: options.dialogValues || null,
      editingRuleId: options.editingRuleId == null ? null : Number(options.editingRuleId),
    }));
  }

  // Kontext für die Validierung: der Werttyp des gewählten States sperrt nicht
  // sinnvolle Kombinationen (Grenzwerte nur auf Zahlen).
  async function contextFor(input) {
    const stateId = String((input && (input.stateId || input.state_id)) || '').trim();
    if (!stateId) return {};
    const entry = (await resolveRuleStates(db, [stateId])).get(stateId);
    return entry ? { stateValueType: valueType(entry.value) } : {};
  }

  router.get('/notifications', requireAuth, async (req, res, next) => {
    try {
      await page(res, {
        message: String(req.query.ok || '').slice(0, 200),
        dialogMode: req.query.mode === 'add' || req.query.mode === 'edit' ? req.query.mode : '',
        editingRuleId: req.query.ruleId || null,
      });
    } catch (error) { next(error); }
  });

  // Bezeichnung, aktueller Wert und Werttyp eines States für den Dialog. Die
  // Auskunft kommt aus der bestehenden State-Verwaltung; die Regel speichert
  // ausschließlich die Adresse.
  router.get('/notifications/state-info', requireAuth, async (req, res, next) => {
    try {
      const stateId = String(req.query.stateId || '').slice(0, 400).trim();
      if (!stateId) return res.json({ found: false });
      const entry = (await resolveRuleStates(db, [stateId])).get(stateId);
      if (!entry) return res.json({ found: false });
      res.json({
        found: true,
        label: entry.label,
        display: entry.display == null ? '—' : entry.display,
        valueType: valueType(entry.value),
      });
    } catch (error) { next(error); }
  });

  // Livedaten der Übersicht (aktueller State-Wert, letzter Trigger,
  // Relay-Zustand). Wie überall im Projekt: JSON-Antwort für angemeldete Sitzungen.
  router.get('/notifications/data', requireAuth, async (req, res, next) => {
    try {
      const rawRules = await repository.listRules(db);
      const states = await resolveRuleStates(db, rawRules.map((rule) => rule.stateId));
      res.json({
        relayState: relayState(),
        rules: rawRules.map((rule) => {
          const enriched = enrich(rule, states);
          return {
            id: enriched.id,
            stateDisplay: enriched.stateDisplay,
            stateMissing: enriched.stateMissing,
            lastTriggeredAt: enriched.lastTriggeredAt,
          };
        }),
      });
    } catch (error) { next(error); }
  });

  // Anlegen, Speichern, Umschalten und Löschen laufen wie in den übrigen
  // Verwaltungsseiten über Formular-POSTs; ein Validierungsfehler rendert den
  // Dialog mit den eingegebenen Werten erneut.
  const mutate = (action, successMessage, dialog) => async (req, res, next) => {
    try {
      await action(req);
      await engine.reload();
      res.redirect(`/notifications?ok=${encodeURIComponent(successMessage)}`);
    } catch (error) {
      if (!error.validation) return next(error);
      try {
        const initial = typeof dialog === 'function' ? dialog(req) : dialog;
        // Das Formular sendet zur Checkbox zusätzlich ein verstecktes „0"; für
        // die erneute Anzeige wird daraus wieder ein einfacher Schalter.
        if (initial && initial.values) {
          initial.values = { ...initial.values, enabled: repository.checkboxValue(initial.values.enabled, true) };
        }
        await page(res, {
          status: 400,
          error: error.message,
          dialogMode: initial ? initial.mode : '',
          dialogValues: initial ? initial.values : null,
          editingRuleId: initial ? initial.ruleId : null,
        });
      } catch (renderError) { next(renderError); }
    }
  };

  router.post('/notifications/rules', requireAuth, mutate(
    async (req) => repository.createRule(db, req.body, await contextFor(req.body)),
    'Nachricht angelegt.',
    (req) => ({ mode: 'add', values: req.body, ruleId: null })
  ));

  router.post('/notifications/rules/:id/delete', requireAuth, mutate(
    (req) => repository.deleteRule(db, req.params.id),
    'Nachricht entfernt.'
  ));

  router.post('/notifications/rules/:id/toggle', requireAuth, mutate(
    (req) => repository.setEnabled(db, req.params.id, repository.checkboxValue(req.body && req.body.enabled, false)),
    'Nachricht gespeichert.'
  ));

  // Testversand: sendet die Nachricht der Regel sofort über den
  // NotificationService — unabhängig vom Trigger. Der State wird dabei nicht
  // verändert, die Triggerbedingung nicht simuliert und `last_triggered_at`
  // ausdrücklich nicht fortgeschrieben.
  router.post('/notifications/rules/:id/test', requireAuth, async (req, res, next) => {
    try {
      const rule = await repository.getRule(db, req.params.id);
      if (!rule) return res.status(404).json({ error: 'Nachricht nicht gefunden.' });
      const result = await service.push({
        title: rule.title, body: rule.body, type: rule.eventType, severity: rule.severity,
      });
      res.json({ ...result, message: testMessage(result) });
    } catch (error) {
      if (error.validation) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.post('/notifications/rules/:id', requireAuth, mutate(
    async (req) => repository.updateRule(db, req.params.id, req.body, await contextFor(req.body)),
    'Nachricht gespeichert.',
    (req) => ({ mode: 'edit', values: req.body, ruleId: Number(req.params.id) })
  ));

  return router;
}

module.exports = notificationRoutes;
module.exports.testMessage = testMessage;
