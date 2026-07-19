'use strict';

// Zentrale Definition der Dashboard-Widget-Typen und ihrer Fähigkeiten. Alle
// typabhängigen Entscheidungen (Dialog-Reihenfolge, Größenwahl, Wertfarbe,
// mobile Mindest-Gruppenbreite) leiten sich aus diesem Katalog ab — keine
// verstreuten Sonderfälle für einzelne Widget-Namen.
//
// Fähigkeiten je Typ:
//   label          – Anzeigename im Typ-Umschalter des Widget-Dialogs
//   needsSource    – braucht einen Wert aus dem internen Wertekatalog (sourceId)
//   supportsSize   – Größenvarianten S/M/L (Anzeige-Layout der Kachel)
//   supportsColor  – konfigurierbare Farbe für den angezeigten Wert
//   mobileMinWidth – erzwungene Mindest-Gruppenbreite auf Smartphones
//                    (null = keine Vorgabe, 'full' = volle mobile Breite).
//                    Enthält eine Gruppe mehrere Widgets, gilt die größte
//                    erforderliche Breite aller enthaltenen Widgets.

const WIDGET_SIZES = ['s', 'm', 'l'];
const DEFAULT_WIDGET_SIZE = 'l';

// Reihenfolge = Reihenfolge im Typ-Umschalter des Dialogs.
const WIDGET_TYPE_DEFS = [
  {
    type: 'value',
    label: 'Wert',
    needsSource: true,
    supportsSize: true,
    supportsColor: true,
    mobileMinWidth: null,
  },
  {
    type: 'switch',
    label: 'Schalter',
    needsSource: false,
    supportsSize: true,
    supportsColor: false,
    mobileMinWidth: null,
  },
  {
    type: 'info',
    label: 'Info-Kachel',
    needsSource: false,
    supportsSize: false,
    supportsColor: false,
    mobileMinWidth: 'full',
  },
];

const WIDGET_TYPES = WIDGET_TYPE_DEFS.map((def) => def.type);
const TYPE_BY_NAME = new Map(WIDGET_TYPE_DEFS.map((def) => [def.type, def]));

function widgetTypeDef(type) {
  return TYPE_BY_NAME.get(type) || TYPE_BY_NAME.get('value');
}

function normalizeSize(value) {
  const size = String(value || '').trim().toLowerCase();
  return WIDGET_SIZES.includes(size) ? size : DEFAULT_WIDGET_SIZE;
}

// Farbwert validieren: leerer String = Standardfarbe (keine Überschreibung),
// sonst nur ein 6-stelliger Hex-Wert (#rrggbb).
function normalizeColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '';
}

// Größte erforderliche mobile Mindestbreite einer Widget-Menge ('full' > null).
function mobileMinWidthFor(widgets) {
  let width = null;
  for (const widget of widgets || []) {
    const def = widgetTypeDef(widget.type);
    if (def.mobileMinWidth === 'full') width = 'full';
  }
  return width;
}

module.exports = {
  WIDGET_TYPE_DEFS,
  WIDGET_TYPES,
  WIDGET_SIZES,
  DEFAULT_WIDGET_SIZE,
  widgetTypeDef,
  normalizeSize,
  normalizeColor,
  mobileMinWidthFor,
};
