'use strict';

const { escapeHtml } = require('./components');
const { isPage, allows } = require('../page-sharing/policy');
const { withTheme } = require('../page-sharing/urls');

function shareButton(path, canWrite) {
  return `<button type="button" class="page-share-button" id="page-share-button" data-share-path="${escapeHtml(path)}" aria-label="Seite freigeben" title="Nicht freigegeben" data-share-edit="${canWrite ? 'true' : 'false'}">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/></svg>
  </button>`;
}

function sharingUi(body, path, canWrite) {
  if (!isPage(path)) return { body, extra: '' };
  const button = shareButton(path, canWrite);
  body = body.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/, heading => `<div class="page-title-sharing">${heading}${button}</div>`);
  const extra = `<dialog id="page-share-dialog" class="page-share-dialog" aria-labelledby="page-share-title">
    <h2 id="page-share-title">Seite freigeben</h2>
    <label for="page-share-mode">Freigabe</label>
    <select id="page-share-mode"${canWrite ? '' : ' disabled'}>
      <option value="none">Nicht freigegeben</option>
      <option value="read">Lesezugriff</option>
      <option value="write">Schreibzugriff</option>
    </select>
    <p>Jeder mit diesem Link erhält den ausgewählten Zugriff auf diese Seite.</p>
    <div id="page-share-link" hidden>
      <label for="page-share-url">Freigabe-URL (hell)</label>
      <div class="page-share-url-row"><input id="page-share-url" type="url" readonly><button type="button" id="page-share-copy" aria-label="Link kopieren (hell)" title="Link kopieren (hell)">⧉</button></div>
      <label for="page-share-url-dark">Freigabe-URL (dunkel)</label>
      <div class="page-share-url-row"><input id="page-share-url-dark" type="url" readonly><button type="button" id="page-share-copy-dark" aria-label="Link kopieren (dunkel)" title="Link kopieren (dunkel)">⧉</button></div>
    </div>
    <p id="page-share-message" role="status" aria-live="polite"></p>
    <div class="page-share-actions"><button type="button" id="page-share-close">Schließen</button><button type="button" id="page-share-save"${canWrite ? '' : ' hidden'}>Speichern</button></div>
  </dialog>
  <script src="/page-sharing.js" defer></script>`;
  return { body, extra };
}

// URLs in Formularen, Links und eingebetteten Skripten bleiben im selben
// Freigabekontext. Nicht freigegebene Seitenlinks werden entfernt.
function publicMarkup(html, share) {
  const base = `/share/${share.token}`;
  html = html.replace(/\b(href|action|src)="(\/[^"<>]*)"/g, (whole, attr, value) => {
    const path = value.split('?')[0];
    if (attr === 'src' || /\.(?:css|png|svg|ico|js)$/.test(path)) {
      return path.startsWith('/adapter/instance/') ? `${attr}="${base}${value}"` : whole;
    }
    if (!allows(share, path, 'GET') && attr === 'href') return 'aria-disabled="true"';
    return `${attr}="${escapeHtml(withTheme(`${base}${value.replace(/&amp;/g, '&')}`, share.theme))}"`;
  });
  // Auch direkte location-Zuweisungen und dynamisch zusammengesetzte Pfade
  // erhalten das Präfix. Regex-Literale und externe URLs bleiben unverändert.
  return html.replace(/(['"`])(\/(?:dashboard|energie|stromverbrauch|photovoltaik|batterie|prognose|messen-schalten|conditions|notifications|adapter|states|output|wetter|logs|pool|grid-control|wallbox|speech|rollladen|heimkino|heizung|database|me)(?:[\/?.][^'"`\s<>]*)?)\1/g,
    (whole, quote, path) => `${quote}${base}${path}${quote}`);
}

function publicRuntime(share) {
  return `<script src="/public-page.js" data-share-base="/share/${share.token}" data-share-mode="${share.mode}" data-share-theme="${share.theme}"></script>`;
}

module.exports = { sharingUi, publicMarkup, publicRuntime };
