'use strict';
const i18n = require('../i18n');
const bus = require('../state-bus');
const { topicForId } = require('../states/system-topics');

// Gemeinsame Anzeigetexte für die erste Seitenausgabe und die Live-Aktualisierung.
function displayStatus(state = {}) {
  const percent = value => value == null ? i18n.localizeText('unbekannt')
    : i18n.t('rollladen.closed_position', { position: Math.round(value) });
  return {
    actual: i18n.t(state.estimated ? 'rollladen.estimated' : 'rollladen.actual', { value: percent(state.position) }),
    planned: i18n.t('rollladen.planned', { value: percent(state.planned) }),
    reason: i18n.localizeText(state.reason || 'Warte auf Auswertung'),
    fault: i18n.localizeText(state.fault || ''),
    manual: !!state.manual,
  };
}
// Den vorhandenen homeESS-Helligkeitswert verwenden, ohne eine zusätzliche
// Sonnen-/PV-Berechnung für Seitenaufrufe oder Statusabfragen auszulösen.
function displayBrightness(cache = bus.getCache()) {
  const raw = cache.get(topicForId('prognose.helligkeit'))?.value;
  const value = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return '— %';
  return new Intl.NumberFormat(i18n.current().locale, { maximumFractionDigits: 0 }).format(value) + ' %';
}
module.exports = { displayStatus, displayBrightness };
