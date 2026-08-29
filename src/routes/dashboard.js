'use strict';

const express = require('express');
const { requireAuth } = require('../auth/session');
const mqttClient = require('../mqtt/client');
const {
  listWidgets,
  getWidget,
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
const {
  listCatalogLevel,
  searchCatalog,
  resolveStates,
} = require('../states/catalog');
const { INFO_FIELDS, readSystemInfo } = require('../dashboard/system-info');
const {
  WEATHER_FIELDS,
  WEATHER_DAY_OPTIONS,
  readWeatherWidget,
  weatherWidgetLabel,
  usesPvYield,
} = require('../dashboard/weather-widget');
const { getWeatherForecast } = require('../wetter/forecast');
const { listPvPlants } = require('../photovoltaik/plants');
const { computePvForecast } = require('../photovoltaik/forecast');
const systemDatabase = require('../database');
const {
  chartWindow, breaksAtGaps, CHART_RANGES, AGGREGATE_OPTIONS, FILL_OPTIONS, MAX_SERIES,
} = require('../dashboard/chart-config');
const { renderChartSvg, renderChartLegend, renderNotice } = require('../dashboard/chart-svg');
const renderDashboard = require('../views/dashboard');

function enrichWidget(widget, valuesById, switchStates, weatherData = null) {
  if (widget.type === 'info') return { ...widget, label: 'System' };
  // Wetter-Kacheln lesen ausschließlich den Prognose-Cache (siehe
  // loadWeatherContext) — der Dashboard-Aufbau wartet nie auf einen Netzabruf.
  if (widget.type === 'weather') {
    return {
      ...widget,
      label: weatherWidgetLabel(widget.weather),
      weatherView: readWeatherWidget(widget.weather, weatherData || {}),
    };
  }
  // Diagramme werden ohne Daten gerendert und laden ihren Inhalt sofort danach
  // nach (/dashboard/widgets/:id/chart). So hängt der Aufbau des Dashboards
  // nicht an der Erreichbarkeit einer externen Datenbank.
  if (widget.type === 'chart') {
    const chart = widget.chart || {};
    return {
      ...widget,
      label: chart.title || (chart.measurements || []).join(', ') || 'Diagramm',
    };
  }
  if (widget.type === 'switch') {
    const state = switchStates.get(widget.id) || { on: null, label: 'Kein Ziel' };
    return {
      ...widget,
      label: widget.switchLabel || state.label,
      targetLabel: state.label,
      on: state.on,
    };
  }
  const entry = valuesById.get(widget.stateTopic);
  return {
    ...widget,
    label: entry ? entry.label : widget.stateTopic,
    currentDisplay: entry ? entry.display : '—',
  };
}

// Datengrundlage der Wetter-Kacheln. Gelesen wird ausschließlich der Cache, den
// der periodische Wetter-Job füllt (`allowFetch: false`) — das Dashboard darf
// nie auf einen Netzabruf warten. Die PV-Prognose kommt nur dazu, wenn
// mindestens eine Kachel den erwarteten Ertrag anzeigt; sonst bleibt es beim
// reinen Wetterabruf. Fehler beider Quellen enden in `null`: die Kachel zeigt
// dann ihren Hinweis, das übrige Dashboard bleibt unberührt.
async function loadWeatherContext(db, widgets) {
  const weatherWidgets = (widgets || []).filter((widget) => widget.type === 'weather');
  if (!weatherWidgets.length) return null;
  const needsPv = weatherWidgets.some((widget) => usesPvYield(widget.weather));
  const [forecast, pvForecast] = await Promise.all([
    getWeatherForecast(db, { allowFetch: false }).catch(() => null),
    needsPv ? loadPvForecast(db) : Promise.resolve(null),
  ]);
  return { forecast, pvForecast };
}

async function loadPvForecast(db) {
  try {
    const plants = await listPvPlants(db);
    if (!plants.length) return null;
    return await computePvForecast(db, plants, { allowFetch: false, cache: mqttClient.getCache() });
  } catch (_) {
    return null;
  }
}

// Gemeinsame Render-Funktion für `/` und `/dashboard` — beide Wege liefern
// dieselbe vollständig initialisierte Dashboard-Ansicht.
async function renderPage(db, res, options = {}) {
  const tabs = await listTabs(db);
  const [groups, widgets, switchTargets] = await Promise.all([
    listGroups(db),
    listWidgets(db),
    listSwitchTargets(db),
  ]);
  const internalValues = await resolveStates(
    db,
    mqttClient.getCache(),
    widgets.filter((widget) => widget.type === 'value').map((widget) => widget.stateTopic)
  );
  const switchStates = await readSwitchStates(db, mqttClient.getCache(), widgets);
  const weatherData = await loadWeatherContext(db, widgets);
  const valuesById = new Map(internalValues.map((entry) => [entry.id, entry]));
  const enriched = widgets.map((widget) => enrichWidget(widget, valuesById, switchStates, weatherData));
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
      switchTargets,
      infoFields: INFO_FIELDS,
      systemInfo: readSystemInfo(),
      weatherFields: WEATHER_FIELDS,
      weatherDayOptions: WEATHER_DAY_OPTIONS,
      maxTabTitleLength: MAX_TAB_TITLE_LENGTH,
      chartRanges: CHART_RANGES,
      chartAggregates: AGGREGATE_OPTIONS,
      chartFills: FILL_OPTIONS,
      maxChartSeries: MAX_SERIES,
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
      const widgets = await listWidgets(db);
      const internalValues = await resolveStates(
        db,
        mqttClient.getCache(),
        widgets.filter((widget) => widget.type === 'value').map((widget) => widget.stateTopic)
      );
      const switchStates = await readSwitchStates(db, mqttClient.getCache(), widgets);
      const weatherData = await loadWeatherContext(db, widgets);
      const valuesById = new Map(internalValues.map((entry) => [entry.id, entry]));
      res.json({
        widgets: widgets
          .filter((widget) => widget.type === 'value')
          .map((widget) => {
            const entry = valuesById.get(widget.stateTopic);
            return { id: widget.id, currentDisplay: entry ? entry.display : '—' };
          }),
        switches: widgets
          .filter((widget) => widget.type === 'switch')
          .map((widget) => {
            const state = switchStates.get(widget.id) || { on: null };
            return { id: widget.id, on: state.on };
          }),
        system: readSystemInfo(),
        // Wetter-Kacheln werden nicht neu gebaut, sondern nur nachgetragen: der
        // Browser schreibt die Werte in die vorhandenen Felder (siehe
        // applyWeather in views/dashboard.js).
        weather: widgets
          .filter((widget) => widget.type === 'weather')
          .map((widget) => ({
            id: widget.id,
            view: readWeatherWidget(widget.weather, weatherData || {}),
          })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Inhalt einer Diagramm-Kachel: fertiges SVG samt Legende. Serverseitig
  // gezeichnet (src/dashboard/chart-svg.js) — der Browser setzt es nur ein.
  router.get('/dashboard/widgets/:id/chart', requireAuth, async (req, res, next) => {
    try {
      const widget = await getWidget(db, Number(req.params.id));
      if (!widget || widget.type !== 'chart') {
        return res.status(404).json({ error: 'Diagramm nicht gefunden.' });
      }
      const chart = widget.chart || {};
      const config = await systemDatabase.load(db);
      if (!systemDatabase.isConfigured(config)) {
        return res.json({
          ok: false,
          html: renderNotice('Es ist keine Datenbank eingerichtet. Einstellungen → Allgemein → Datenbank.', 'hint'),
        });
      }
      const window = chartWindow(chart);
      const data = await systemDatabase.readSeriesSet(db, chart.measurements, {
        from: window.from,
        to: window.to,
        intervalMs: window.intervalMs,
        aggregate: chart.aggregate,
        fill: window.fill,
      });
      // Gelesene Punkte mit der Konfiguration der Linie zusammenführen (Name
      // für die Legende, Farbe). Die Reihenfolge entspricht der Konfiguration.
      const series = (chart.series || []).map((entry, index) => ({
        ...entry,
        points: (data[index] && data[index].points) || [],
      }));
      return res.json({
        ok: true,
        updatedAt: Date.now(),
        rangeLabel: window.range.label,
        html: renderChartSvg(series, {
          from: window.from,
          to: window.to,
          intervalMs: window.intervalMs,
          unit: chart.unit,
          breakAtGaps: breaksAtGaps(window.fill),
        }),
        legend: renderChartLegend(series, { unit: chart.unit }),
      });
    } catch (error) {
      if (error && error.validation) return res.status(400).json({ error: error.message });
      // Ein Datenbankfehler darf das Dashboard nicht kippen — die Kachel zeigt
      // ihn an, alles andere läuft weiter.
      return res.json({
        ok: false,
        html: renderNotice(error && error.message ? error.message : 'Die Datenbank ist nicht erreichbar.', 'error'),
      });
    }
  });

  // Der potenziell sehr große Wertekatalog wird hierarchisch und erst beim
  // Öffnen des Widget-Dialogs geladen. Ein Pfad liefert ausschließlich seine
  // direkten Unterordner und die unmittelbar darin liegenden Werte.
  router.get('/dashboard/catalog', requireAuth, async (req, res, next) => {
    try {
      const query = String(req.query.q || '').trim();
      const result = query
        ? await searchCatalog(db, mqttClient.getCache(), query)
        : await listCatalogLevel(db, mqttClient.getCache(), req.query.path, req.query.offset);
      res.json(result);
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
