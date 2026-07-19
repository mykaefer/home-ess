'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const {
  listWidgets,
  createWidget,
  updateWidget,
  deleteWidget,
  reorderWidgets,
  normalizeWidgetInput,
} = require('../dashboard/widgets');
const {
  GROUP_WIDTHS,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
} = require('../dashboard/groups');
const {
  listTabs,
  createTab,
  renameTab,
  deleteTab,
  reorderTabs,
  resolveTabId,
  MAX_TAB_TITLE_LENGTH,
} = require('../dashboard/tabs');
const { listSwitchTargets, readSwitchStates, commandSwitch } = require('../dashboard/switches');
const { listInternalValues } = require('../output/internal-values');
const { INFO_FIELDS, readSystemInfo } = require('../dashboard/system-info');
const renderDashboard = require('../views/dashboard');

function enrichWidget(widget, valuesById, switchStates) {
  if (widget.type === 'info') return { ...widget, label: 'System' };
  if (widget.type === 'switch') {
    const state = switchStates.get(widget.id) || { on: null, label: 'Kein Ziel' };
    return {
      ...widget,
      label: widget.switchLabel || state.label,
      targetLabel: state.label,
      on: state.on,
    };
  }
  const entry = valuesById.get(widget.sourceId);
  return {
    ...widget,
    label: entry ? entry.label : widget.sourceId,
    currentDisplay: entry ? entry.display : '—',
  };
}

// Gemeinsame Render-Funktion für `/` und `/dashboard` — beide Wege liefern
// dieselbe vollständig initialisierte Dashboard-Ansicht.
async function renderPage(db, res, options = {}) {
  const tabs = await listTabs(db);
  const [groups, widgets, internalValues, switchTargets] = await Promise.all([
    listGroups(db),
    listWidgets(db),
    listInternalValues(db, mqttClient.getCache()),
    listSwitchTargets(db),
  ]);
  const switchStates = await readSwitchStates(db, mqttClient.getCache(), widgets);
  const valuesById = new Map(internalValues.map((entry) => [entry.id, entry]));
  const enriched = widgets.map((widget) => enrichWidget(widget, valuesById, switchStates));
  const groupTabById = new Map(groups.map((group) => [group.id, resolveTabId(tabs, group.tabId)]));

  // Tab eines Widgets: Widgets in Gruppen erben den Tab der Gruppe, freie
  // Widgets tragen ihn selbst (unbekannte Verweise fallen auf den ersten Tab).
  const widgetTabId = (widget) =>
    widget.groupId != null && groupTabById.has(widget.groupId)
      ? groupTabById.get(widget.groupId)
      : resolveTabId(tabs, widget.tabId);

  const tabViews = tabs.map((tab) => ({
    ...tab,
    ungrouped: enriched.filter((widget) =>
      (widget.groupId == null || !groupTabById.has(widget.groupId)) && widgetTabId(widget) === tab.id),
    groups: groups
      .filter((group) => groupTabById.get(group.id) === tab.id)
      .map((group) => ({
        ...group,
        tabId: groupTabById.get(group.id),
        widgets: enriched.filter((widget) => widget.groupId === group.id),
      })),
  }));

  res.send(
    renderDashboard({
      tabs: tabViews,
      groupsForSelect: groups.map((group) => ({ ...group, tabId: groupTabById.get(group.id) })),
      groupWidths: GROUP_WIDTHS,
      internalValues: internalValues.map((entry) => ({
        id: entry.id,
        label: entry.label,
        display: entry.display,
        category: entry.category,
      })),
      switchTargets,
      infoFields: INFO_FIELDS,
      systemInfo: readSystemInfo(),
      maxTabTitleLength: MAX_TAB_TITLE_LENGTH,
      formMessage: options.formMessage || '',
      formError: options.formError || '',
      dialogMode: options.dialogMode || '',
      dialogError: options.dialogError || '',
      dialogValues: options.dialogValues || null,
      editingWidgetId: options.editingWidgetId != null ? options.editingWidgetId : null,
      groupDialogOpen: options.groupDialogOpen || false,
      groupDialogError: options.groupDialogError || '',
      tabDialogMode: options.tabDialogMode || '',
      tabDialogError: options.tabDialogError || '',
      editingTabId: options.editingTabId != null ? options.editingTabId : null,
      selectTabId: options.selectTabId != null ? options.selectTabId : null,
    })
  );
}

function dashboardRoutes(db) {
  const router = express.Router();

  router.get('/dashboard', requireAuth, async (req, res, next) => {
    try {
      await renderPage(db, res, {});
    } catch (err) {
      next(err);
    }
  });

  router.get('/dashboard/data', requireAuth, async (req, res, next) => {
    try {
      const [widgets, internalValues] = await Promise.all([
        listWidgets(db),
        listInternalValues(db, mqttClient.getCache()),
      ]);
      const switchStates = await readSwitchStates(db, mqttClient.getCache(), widgets);
      const valuesById = new Map(internalValues.map((entry) => [entry.id, entry]));
      res.json({
        widgets: widgets
          .filter((widget) => widget.type === 'value')
          .map((widget) => {
            const entry = valuesById.get(widget.sourceId);
            return { id: widget.id, currentDisplay: entry ? entry.display : '—' };
          }),
        switches: widgets
          .filter((widget) => widget.type === 'switch')
          .map((widget) => {
            const state = switchStates.get(widget.id) || { on: null };
            return { id: widget.id, on: state.on };
          }),
        system: readSystemInfo(),
      });
    } catch (err) {
      next(err);
    }
  });

  // Schalter-Widget betätigen: nutzt die bestehenden Schalt-Mechanismen von
  // Messen + Schalten (Gerät bzw. Schaltgruppe) inklusive Prioritäts-Gating.
  router.post('/dashboard/switch/:id/:state', requireAuth, async (req, res, next) => {
    try {
      const widgets = await listWidgets(db);
      const widget = widgets.find((entry) => entry.id === Number(req.params.id));
      if (!widget || widget.type !== 'switch') {
        return res.status(404).json({ error: 'Schalter nicht gefunden.' });
      }
      const on = req.params.state === '1' || req.params.state === 'on' || req.params.state === 'true';
      const result = await commandSwitch(db, widget.sourceId, on);
      if (result.missing) return res.status(404).json({ error: 'Schaltziel nicht mehr vorhanden.' });
      res.json({ ok: true, blocked: result.blocked === true });
    } catch (err) {
      if (err.validation) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  router.post('/dashboard/widgets', requireAuth, async (req, res, next) => {
    try {
      await createWidget(db, req.body);
      await renderPage(db, res, { formMessage: 'Widget hinzugefuegt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'add',
          dialogError: err.message,
          dialogValues: normalizeWidgetInput(req.body),
        });
      }
      next(err);
    }
  });

  router.post('/dashboard/widgets/:id', requireAuth, async (req, res, next) => {
    try {
      await updateWidget(db, Number(req.params.id), req.body);
      await renderPage(db, res, { formMessage: 'Widget gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          dialogMode: 'edit',
          dialogError: err.message,
          dialogValues: normalizeWidgetInput(req.body),
          editingWidgetId: Number(req.params.id),
        });
      }
      next(err);
    }
  });

  router.post('/dashboard/widgets/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteWidget(db, Number(req.params.id));
      await renderPage(db, res, { formMessage: 'Widget entfernt.' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/dashboard/layout', requireAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (Array.isArray(body.widgets)) await reorderWidgets(db, body.widgets);
      if (Array.isArray(body.groups)) await reorderGroups(db, body.groups);
      if (Array.isArray(body.tabs)) await reorderTabs(db, body.tabs);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/dashboard/groups', requireAuth, async (req, res, next) => {
    try {
      await createGroup(db, req.body);
      await renderPage(db, res, { formMessage: 'Gruppe hinzugefuegt.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, { groupDialogOpen: true, groupDialogError: err.message });
      }
      next(err);
    }
  });

  router.post('/dashboard/groups/:id', requireAuth, async (req, res, next) => {
    try {
      await updateGroup(db, Number(req.params.id), req.body);
      await renderPage(db, res, { formMessage: 'Gruppe gespeichert.' });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, { groupDialogOpen: true, groupDialogError: err.message });
      }
      next(err);
    }
  });

  router.post('/dashboard/groups/:id/delete', requireAuth, async (req, res, next) => {
    try {
      await deleteGroup(db, Number(req.params.id));
      await renderPage(db, res, { formMessage: 'Gruppe entfernt.' });
    } catch (err) {
      next(err);
    }
  });

  // --- Tabs ---------------------------------------------------------------
  router.post('/dashboard/tabs', requireAuth, async (req, res, next) => {
    try {
      const tab = await createTab(db, req.body);
      await renderPage(db, res, { formMessage: 'Tab hinzugefuegt.', selectTabId: tab.id });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, { tabDialogMode: 'add', tabDialogError: err.message });
      }
      next(err);
    }
  });

  router.post('/dashboard/tabs/:id', requireAuth, async (req, res, next) => {
    try {
      const tab = await renameTab(db, Number(req.params.id), req.body);
      await renderPage(db, res, { formMessage: 'Tab gespeichert.', selectTabId: tab.id });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, {
          tabDialogMode: 'edit',
          tabDialogError: err.message,
          editingTabId: Number(req.params.id),
        });
      }
      next(err);
    }
  });

  router.post('/dashboard/tabs/:id/delete', requireAuth, async (req, res, next) => {
    try {
      const targetId = await deleteTab(db, Number(req.params.id), req.body ? req.body.targetTabId : null);
      await renderPage(db, res, { formMessage: 'Tab entfernt.', selectTabId: targetId });
    } catch (err) {
      if (err.validation) {
        return renderPage(db, res, { formError: err.message });
      }
      next(err);
    }
  });

  return router;
}

dashboardRoutes.renderPage = renderPage;

module.exports = dashboardRoutes;
