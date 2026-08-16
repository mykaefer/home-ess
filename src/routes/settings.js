'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const { loadMqttConfig, saveMqttConfig } = require('../mqtt/config');
const mqttClient = require('../mqtt/client');
const { loadAllStateDefinitions } = require('../mqtt/state-definitions');
const { listUsers, createUser, updateUser, deleteUser, getUser } = require('../auth/users');
const modulesState = require('../modules');
const renderSettings = require('../views/settings');
const timeHandler = require('../time-handler');
const updateSettings = require('../update/settings');
const updateService = require('../update/service');
const i18n = require('../i18n');
const adapterHost = require('../adapters/host');
const heimkinoRuntime = require('../heimkino/runtime');

// Query-Parameter (?tab=) auf einen gültigen Tab abbilden. Der alte
// /remote-access-Link leitet mit ?tab=remote-access hierher.
function tabFromQuery(value) {
  const map = { allgemein: 'allgemein', benutzer: 'benutzer', module: 'module', fernzugriff: 'fernzugriff', 'remote-access': 'fernzugriff' };
  return map[String(value || '')] || 'allgemein';
}

// Einstellungs-Routen: Tab-Seite (Allgemein/Benutzer/Module/Fernzugriff),
// Benutzerverwaltung, Modul-Umschaltung, MQTT speichern/testen.
function settingsRoutes(db) {
  const router = express.Router();

  // Seite mit MQTT-Konfiguration, Benutzerliste und Modulstatus rendern.
  // Zusätzliche Zustände (Dialog offen, Fehler, Erfolgsmeldung, aktiver Tab)
  // werden durchgereicht.
  async function sendSettings(res, extra = {}) {
    const [cfg, users, updateConfig] = await Promise.all([
      new Promise((resolve) => loadMqttConfig(db, resolve)),
      listUsers(db),
      updateSettings.load(db),
    ]);
    const registry = modulesState.getRegistry();
    const enabledKeys = new Set(registry.filter((m) => modulesState.isEnabled(m.key)).map((m) => m.key));
    res.send(renderSettings({
      mqtt: cfg,
      timeStatus: timeHandler.snapshot(),
      users,
      registry,
      enabledKeys,
      updateConfig,
      updateStatus: updateService.getStatus(),
      languages: i18n.listLanguages(),
      currentLanguage: i18n.current(),
      ...extra,
    }));
  }

  router.get('/settings', requireAuth, (req, res, next) => {
    sendSettings(res, { activeTab: tabFromQuery(req.query.tab) }).catch(next);
  });

  router.get('/settings/time.json', requireAuth, (_req, res) => {
    res.json(timeHandler.snapshot());
  });

  // --- Sprache -------------------------------------------------------------
  router.post('/settings/language', requireAuth, async (req, res, next) => {
    try {
      await i18n.select(req.body.language);
      // Manifesttexte, Navigation, State-Kataloge und adaptereigene Ansichten
      // müssen denselben Sprachstand verwenden.
      adapterHost.reloadRegistry();
      await adapterHost.reloadAllForLanguage();
      return sendSettings(res, { activeTab: 'allgemein', languageMessage: i18n.t('language.applied') });
    } catch (error) {
      return sendSettings(res, { activeTab: 'allgemein', languageError: error.message }).catch(next);
    }
  });

  router.post('/settings/language/upload', requireAuth, async (req, res) => {
    try {
      const filename = String(req.body && req.body.filename || '');
      const document = req.body && req.body.language;
      const installed = i18n.install(filename, document);
      return res.json({ ok: true, installed: installed.code, languages: i18n.listLanguages() });
    } catch (error) {
      return res.status(400).json({ error: error.message || i18n.t('language.invalid') });
    }
  });

  // --- Module (früher eigener Menüpunkt, jetzt Tab „Module") ---------------
  const toggleModule = (req, res, next, enable) => {
    const { key } = req.params;
    const mod = modulesState.getRegistry().find((m) => m.key === key);
    if (!mod) return res.status(404).send('Unbekanntes Modul.');
    modulesState
      .setEnabled(db, key, enable)
      // Das Heimkino stellt eigene States bereit und prüft Schleifen zyklisch;
      // beides richtet sich erst nach dem erneuten Laden nach dem Modulstatus.
      .then(() => (key === 'heimkino' ? heimkinoRuntime.reload().catch(() => {}) : null))
      .then(() => sendSettings(res, {
        activeTab: 'module',
        moduleMessage: `Modul "${mod.label}" wurde ${enable ? 'aktiviert' : 'deaktiviert'}.`,
      }))
      .catch(() => sendSettings(res, { activeTab: 'module', moduleMessage: `Fehler beim ${enable ? 'Aktivieren' : 'Deaktivieren'}.` }))
      .catch(next);
  };

  router.post('/module/:key/enable', requireAuth, (req, res, next) => toggleModule(req, res, next, true));
  router.post('/module/:key/disable', requireAuth, (req, res, next) => toggleModule(req, res, next, false));
  // Alter Direktlink -> Einstellungen, Tab „Module".
  router.get('/module', requireAuth, (req, res) => res.redirect('/settings?tab=module'));

  // --- Benutzerverwaltung --------------------------------------------------
  router.post('/settings/users', requireAuth, async (req, res, next) => {
    try {
      await createUser(db, {
        name: req.body.name,
        password: req.body.password,
        role: req.body.role,
        visiblePages: req.body.pages,
      });
      await sendSettings(res, { activeTab: 'benutzer', userMessage: 'Benutzer angelegt.' });
    } catch (err) {
      if (err.validation) {
        return sendSettings(res, {
          activeTab: 'benutzer',
          userDialogOpen: true,
          userDialogMode: 'add',
          userDialogError: err.message,
          userDialogValues: {
            name: req.body.name || '',
            role: req.body.role || 'read',
            pages: normalizePagesEcho(req.body.pages),
          },
        });
      }
      next(err);
    }
  });

  router.post('/settings/users/:id', requireAuth, async (req, res, next) => {
    try {
      await updateUser(db, Number(req.params.id), {
        name: req.body.name,
        password: req.body.password,
        role: req.body.role,
        visiblePages: req.body.pages,
      });
      await sendSettings(res, { activeTab: 'benutzer', userMessage: 'Benutzer gespeichert.' });
    } catch (err) {
      if (err.validation) {
        const existing = await getUser(db, Number(req.params.id)).catch(() => null);
        return sendSettings(res, {
          activeTab: 'benutzer',
          userDialogOpen: true,
          userDialogMode: 'edit',
          userDialogError: err.message,
          userDialogValues: {
            id: Number(req.params.id),
            name: req.body.name || '',
            role: req.body.role || 'read',
            isAdmin: existing ? existing.isAdmin : false,
            pages: normalizePagesEcho(req.body.pages),
          },
        });
      }
      next(err);
    }
  });

  router.post('/settings/users/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteUser(db, Number(req.params.id));
      await sendSettings(res, { activeTab: 'benutzer', userMessage: 'Benutzer gelöscht.' });
    } catch (err) {
      if (err.validation) return sendSettings(res, { activeTab: 'benutzer', userError: err.message });
      next(err);
    }
  });

  // --- MQTT ----------------------------------------------------------------
  router.post('/settings/mqtt', requireAuth, (req, res, next) => {
    saveMqttConfig(db, req.body, (err, cfg) => {
      if (err) {
        return sendSettings(res, { mqtt: req.body, mqttMessage: 'Fehler beim Speichern.' }).catch(next);
      }
      timeHandler.configure(cfg);
      i18n.setTimezone(cfg.timezone);
      loadAllStateDefinitions(db)
        .then((definitions) => {
          mqttClient.setStateDefinitions(definitions);
          mqttClient.connect(cfg);
        })
        .catch(() => mqttClient.connect(cfg))
        .then(() => sendSettings(res, { mqttMessage: 'MQTT-Konfiguration gespeichert.' }))
        .catch(() => sendSettings(res, { mqttMessage: 'MQTT-Konfiguration gespeichert.' }));
    });
  });

  router.post('/settings/mqtt/test', requireAuth, async (req, res) => {
    const result = await mqttClient.testConnection(req.body);
    res.json(result);
  });

  // --- homeESS-Updates -----------------------------------------------------
  router.post('/settings/update', requireAuth, async (req, res, next) => {
    if (!req.access || !req.access.isAdmin) {
      return res.status(403).send('Nur Administratoren dürfen Updateeinstellungen ändern.');
    }
    try {
      // Deaktivierte Zeitfelder werden vom Browser nicht übertragen. In dem
      // Fall die bereits gespeicherten Werte behalten, damit Ausschalten der
      // Automatik das vorbereitete Wartungsfenster nicht zurücksetzt.
      const existing = await updateSettings.load(db);
      const saved = await updateSettings.save(db, {
        ...existing,
        ...req.body,
        automaticEnabled: req.body.automaticEnabled === '1' || req.body.automaticEnabled === 'on',
      });
      updateService.configure(saved);
      return sendSettings(res, {
        activeTab: 'allgemein',
        updateMessage: 'Updateeinstellungen gespeichert.',
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

// Für das erneute Öffnen des Dialogs bei Validierungsfehlern: die angehakten
// Seiten wieder als Array zurückgeben.
function normalizePagesEcho(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

module.exports = settingsRoutes;
