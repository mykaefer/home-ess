'use strict';

const { escapeHtml } = require('./components');

// Modul-Verwaltung als Fragment (Tab „Module" der Einstellungsseite): zeigt alle
// optionalen Module mit Status und Toggle. Liefert reines Inhalts-HTML ohne
// Layout, damit es in die Tab-Struktur der Einstellungen eingebettet werden kann.
function modulesPanel({ registry = [], enabledKeys = new Set(), message = '' } = {}) {
  const cards = registry
    .map((mod) => {
      const enabled = enabledKeys.has(mod.key);
      const statusLabel = enabled ? 'Aktiv' : 'Inaktiv';
      const statusClass = enabled ? 'module-status--on' : 'module-status--off';
      const actionLabel = enabled ? 'Deaktivieren' : 'Aktivieren';
      const actionClass = enabled ? 'button-danger' : '';
      const action = enabled
        ? `/module/${escapeHtml(mod.key)}/disable`
        : `/module/${escapeHtml(mod.key)}/enable`;

      return `          <div class="module-card">
            <div class="module-card-info">
              <div class="module-card-title">
                ${escapeHtml(mod.label)}
                <span class="module-status ${statusClass}">${statusLabel}</span>
              </div>
              <p class="module-card-desc">${escapeHtml(mod.description)}</p>
            </div>
            <form action="${action}" method="POST" class="module-card-action">
              <button type="submit" class="module-toggle-btn ${actionClass}">${actionLabel}</button>
            </form>
          </div>`;
    })
    .join('\n');

  return `        <p class="muted" style="margin-bottom: 20px;">Optionale Module können hier aktiviert oder deaktiviert werden. Aktivierte Module erscheinen in der Navigation.</p>
        ${message ? `<p class="module-message">${escapeHtml(message)}</p>` : ''}
        <div class="module-list">
${cards}
        </div>`;
}

module.exports = { modulesPanel };
