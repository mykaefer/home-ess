'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const renderDashboard = require('../src/views/dashboard');
const { mobileMinWidthFor, widgetTypeDef, WIDGET_TYPE_DEFS } = require('../src/dashboard/widget-types');

function baseData(extra = {}) {
  return {
    tabs: [
      {
        id: 1,
        title: 'Übersicht',
        ungrouped: [],
        groups: [],
      },
    ],
    groupsForSelect: [],
    groupWidths: [
      { value: 'full', label: 'Voll' },
      { value: 'half', label: 'Halb' },
      { value: 'quarter', label: 'Viertel' },
    ],
    internalValues: [],
    switchTargets: [],
    infoFields: [],
    systemInfo: {},
    ...extra,
  };
}

test('Widget-Typen: Schalter steht an zweiter Stelle vor der Info-Kachel', () => {
  assert.deepEqual(WIDGET_TYPE_DEFS.map((def) => def.type), ['value', 'switch', 'info']);
  assert.equal(widgetTypeDef('info').mobileMinWidth, 'full');
  assert.equal(widgetTypeDef('value').mobileMinWidth, null);
  assert.equal(mobileMinWidthFor([{ type: 'value' }, { type: 'info' }]), 'full');
  assert.equal(mobileMinWidthFor([{ type: 'value' }, { type: 'switch' }]), null);
});

test('Dashboard rendert Tab-Leiste, Panels und Toolbar-Icon-Buttons', () => {
  const html = renderDashboard(baseData({
    tabs: [
      { id: 1, title: 'Übersicht', ungrouped: [], groups: [] },
      { id: 2, title: 'Energie', ungrouped: [], groups: [] },
    ],
  }));
  assert.match(html, /class="dash-tabbar"/);
  assert.match(html, /data-tab-id="1"/);
  assert.match(html, /data-tab-id="2"/);
  assert.match(html, /Energie/);
  // Jeder Tab trägt einen Drag-Griff (nur im Bearbeitungsmodus sichtbar).
  assert.match(html, /dash-tab-grip/);
  // Kompakte Icon-Buttons statt großer Text-Buttons: im Anzeigemodus nur der
  // Stift; Plus-Menü und Tab-Plus erscheinen erst im Bearbeitungsmodus.
  assert.match(html, /id="dashEditBtn"[^>]*aria-label="Dashboard bearbeiten"/);
  assert.match(html, /id="dashAddWrap" hidden/);
  assert.match(html, /id="dashTabAdd"[^>]*hidden/);
  assert.ok(!html.includes('dashApplyBtn'));
  assert.ok(!html.includes('Gruppe hinzufuegen</button>'));
});

test('Wert-Widget rendert Größenklasse und eigene Wertfarbe', () => {
  const html = renderDashboard(baseData({
    tabs: [{
      id: 1,
      title: 'Übersicht',
      ungrouped: [
        { id: 5, type: 'value', sourceId: 'pv.current', label: 'PV', currentDisplay: '512 W', size: 's', color: '#e67e22', groupId: null },
        { id: 6, type: 'value', sourceId: 'pv.today', label: 'Ertrag', currentDisplay: '3 kWh', size: 'l', color: '', groupId: null },
      ],
      groups: [],
    }],
  }));
  assert.match(html, /widget-card--size-s/);
  assert.match(html, /id="widget-value-5" style="color:#e67e22"/);
  // Ohne konfigurierte Farbe kein Inline-Style (Standard-Textfarbe).
  assert.match(html, /id="widget-value-6">3 kWh/);
});

test('Schalter-Widget rendert vollflächige Schaltfläche mit Zustand', () => {
  const label = 'Sehr langer Schaltername fuer kleine Kacheln';
  const html = renderDashboard(baseData({
    tabs: [{
      id: 1,
      title: 'Übersicht',
      ungrouped: [
        { id: 9, type: 'switch', sourceId: 'actor:3', label, on: true, size: 's', onColor: '#ffcc00', offColor: '', groupId: null },
      ],
      groups: [],
    }],
  }));
  assert.match(html, /widget-card--switch widget-card--size-s/);
  assert.match(html, /switch-surface" id="switch-surface-9" data-on="true"/);
  assert.match(html, new RegExp(`class="switch-name" title="${label}"`));
  assert.match(html, /--switch-on-bg:#ffcc00/);
  assert.match(html, /onclick="toggleSwitchWidget\(9\)"/);
  assert.match(html, /id="switch-state-9">Ein</);
});

test('Gruppe mit Info-Widget erzwingt volle mobile Breite (Typ-Eigenschaft)', () => {
  const html = renderDashboard(baseData({
    tabs: [{
      id: 1,
      title: 'Übersicht',
      ungrouped: [],
      groups: [
        {
          id: 4,
          title: 'System',
          width: 'quarter',
          tabId: 1,
          widgets: [{ id: 7, type: 'info', infoFields: null, groupId: 4 }],
        },
        {
          id: 5,
          title: 'Werte',
          width: 'quarter',
          tabId: 1,
          widgets: [{ id: 8, type: 'value', sourceId: 'x', label: 'X', groupId: 5 }],
        },
      ],
    }],
  }));
  assert.match(html, /widget-group--quarter widget-group--mobile-full" data-group-id="4"/);
  assert.ok(!/widget-group--quarter widget-group--mobile-full" data-group-id="5"/.test(html));
});

test('Dialoge enthalten Tab-Auswahl, Größenwahl und Schalter-Ziele', () => {
  const html = renderDashboard(baseData({
    tabs: [
      { id: 1, title: 'Übersicht', ungrouped: [], groups: [] },
      { id: 2, title: 'Pool', ungrouped: [], groups: [] },
    ],
    switchTargets: [
      { id: 'actor:3', label: 'Pumpe', kind: 'Gerät' },
      { id: 'schaltgruppe:1', label: 'Licht', kind: 'Schaltgruppe' },
    ],
  }));
  assert.match(html, /id="widgetTabId" name="tabId"/);
  assert.match(html, /id="groupTabId" name="tabId"/);
  assert.match(html, /name="size" value="s"/);
  assert.match(html, /option value="actor:3"/);
  assert.match(html, /option value="schaltgruppe:1"/);
  assert.match(html, /id="tabDialog"/);
  assert.match(html, /id="deleteTabDialog"/);
});
