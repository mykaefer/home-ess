'use strict';

const { escapeHtml, statusText } = require('./components');
const { TOKEN_TTL_MS } = require('../states-api/tokens');

// Reiter „States API“ der Einstellungsseite: Schalter, API-Passwort und der
// States-Katalog mit Freigaben. Liefert Inhalts-HTML und das zugehörige
// Browserskript; die Einstellungsseite bettet beides ein.
//
// Der Katalog wird ebenenweise nachgeladen (/settings/states-api/catalog.json):
// Nur geöffnete Verzeichnisse stehen im DOM, auch große Bäume bleiben damit
// bedienbar. Häkchen = für die API freigegeben. Ein ausgeschlossenes
// Verzeichnis zeigt keine Unterelemente mehr — sie sind nicht einzeln
// konfigurierbar, bis es wieder freigegeben wird.
function statesApiPanel({
  config = { enabled: false, hasPassword: false, excludedFolders: [], excludedStates: [] },
  baseUrl = '',
  canManage = false,
  message = '',
  error = '',
  passwordMessage = '',
  passwordError = '',
  audioBus = null,
} = {}) {
  const disabled = canManage ? '' : ' disabled';
  const hours = Math.round(TOKEN_TTL_MS / 3600000);
  const statusClass = config.enabled ? 'module-status--on' : 'module-status--off';
  const statusLabel = config.enabled ? 'Aktiv' : 'Inaktiv';
  const folderCount = (config.excludedFolders || []).length;
  const stateCount = (config.excludedStates || []).length;

  return `          <div class="settings-layout">
          <form action="/settings/states-api/enabled" method="POST" class="settings-card settings-form">
            <div class="settings-card-head">
              <h2>States API <span class="module-status ${statusClass}">${statusLabel}</span></h2>
              <p class="settings-card-hint">Lokale, versionierte Schnittstelle für eigene Programme und Drittanbieter-Clients (zum Beispiel eine Desktop-Widgetleiste). Clients melden sich mit dem API-Passwort an, erhalten ein zeitlich begrenztes Zugriffstoken und können damit den State-Baum durchsuchen, Werte lesen und beschreibbare States setzen. Die vollständige Beschreibung steht in der Datei STATES-API.md im homeESS-Verzeichnis.</p>
            </div>
            ${statusText(error)}
            ${statusText(message, 'success')}
            ${canManage ? '' : '<p class="settings-card-hint settings-card-hint-strong">Nur Administratoren dürfen die States API verwalten.</p>'}
            <label class="checkbox-field" for="statesApiEnabled">
              <input type="checkbox" id="statesApiEnabled" name="enabled" value="1"${config.enabled ? ' checked' : ''}${disabled}>
              <span>States API aktivieren</span>
            </label>
            <p class="settings-card-hint">Ausgeschaltet beantwortet die API jeden Zugriff mit dem Fehler „api_disabled“ und liefert keine States. Zum Einschalten muss ein API-Passwort festgelegt sein.</p>
            <div class="update-settings-versions states-api-facts">
              <div><span>Basis-URL</span><strong><code>${escapeHtml(baseUrl)}</code></strong></div>
              <div><span>Token-Gültigkeit</span><strong>${escapeHtml(String(hours))} h</strong></div>
            </div>
            <div class="button-row">
              <button type="submit"${disabled}>Speichern</button>
            </div>
          </form>

          <form action="/settings/states-api/password" method="POST" class="settings-card settings-form" autocomplete="off">
            <div class="settings-card-head">
              <h2>API-Passwort</h2>
              <p class="settings-card-hint">Die API hat genau einen Zugang. Das Passwort wird nur als Hash gespeichert und lässt sich nicht wieder anzeigen. Ein neues Passwort ersetzt das bisherige; bereits ausgegebene Zugriffstokens werden dabei ungültig.</p>
            </div>
            ${statusText(passwordError)}
            ${statusText(passwordMessage, 'success')}
            <p class="settings-card-hint settings-card-hint-strong">${config.hasPassword ? 'Ein API-Passwort ist festgelegt.' : 'Noch kein API-Passwort festgelegt.'}</p>
            <div class="field-grid">
              <div class="field">
                <label for="statesApiPassword">Neues Passwort</label>
                <input type="password" id="statesApiPassword" name="password" autocomplete="new-password" minlength="8" maxlength="256" required${disabled}>
                <small class="muted">Mindestens 8 Zeichen.</small>
              </div>
              <div class="field">
                <label for="statesApiPasswordRepeat">Passwort wiederholen</label>
                <input type="password" id="statesApiPasswordRepeat" name="passwordRepeat" autocomplete="new-password" minlength="8" maxlength="256" required${disabled}>
              </div>
            </div>
            <div class="button-row">
              <button type="submit"${disabled}>Passwort speichern</button>
            </div>
          </form>

${audioBusCard(audioBus, config, baseUrl, canManage)}
          <section class="settings-card">
            <div class="settings-card-head">
              <h2>States-Katalog</h2>
              <p class="settings-card-hint">Der vorhandene homeESS-State-Baum. Standardmäßig sind alle States für die API freigegeben. Ein entferntes Häkchen schließt den State oder das gesamte Verzeichnis samt allen Unterverzeichnissen aus; ausgeschlossene Einträge sind für API-Clients nicht sichtbar, nicht lesbar und nicht schreibbar. Änderungen gelten sofort.</p>
            </div>
            <p class="settings-card-hint settings-card-hint-strong" id="statesApiSummary" data-folders="${folderCount}" data-states="${stateCount}"></p>
            <p class="error-text" id="statesApiTreeError" hidden></p>
            <div class="states-api-tree" id="statesApiTree" data-can-manage="${canManage ? '1' : '0'}" aria-live="polite">
              <p class="muted">${canManage ? 'Wird geladen …' : 'Nur Administratoren dürfen die States API verwalten.'}</p>
            </div>
            <div class="button-row">
              <button type="button" class="secondary-button" id="statesApiReset" onclick="statesApiResetExclusions()"${disabled}>Alle Ausschlüsse aufheben</button>
            </div>
          </section>
          </div>`;
}

// Statuskarte des Audio Bus. Zeigt nur Kennzahlen — keine Geräte, Räume oder
// Session-IDs.
function audioBusCard(status, config, baseUrl, canManage) {
  if (!status) return '';
  const usable = status.active && status.listening && config.enabled;
  const statusClass = usable ? 'module-status--on' : 'module-status--off';
  const statusLabel = usable ? 'Aktiv' : 'Inaktiv';
  const wsUrl = String(baseUrl || '/api/v1').replace(/^http(s?):/, 'ws$1:') + '/audio/ws';
  const fact = (label, value) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
  return `          <section class="settings-card">
            <div class="settings-card-head">
              <h2>Audio Bus <span class="module-status ${statusClass}">${statusLabel}</span></h2>
              <p class="settings-card-hint">Bidirektionale Audio-Verbindung für Clients wie Sprachsatelliten oder Desktop-Widgets. Clients melden sich mit demselben Zugriffstoken wie bei der States API an; ohne aktivierte States API ist der Audio Bus nicht erreichbar. Audio wird nur weitergeleitet, nicht gespeichert.</p>
            </div>
            <div class="update-settings-versions states-api-facts">
              <div><span>WebSocket</span><strong><code>${escapeHtml(wsUrl)}</code></strong></div>
              ${fact('Aktive Sessions', `${status.sessions} / ${status.limits ? status.limits.maxSessions : '—'}`)}
              ${fact('Verbindungen', `${status.connections} / ${status.maxConnections || 32}`)}
              ${fact('Input-Abonnenten', status.inputSubscribers)}
              ${fact('Output-Streams', status.outputStreams)}
              ${fact('Verworfene Chunks', status.counters ? status.counters.droppedChunks : 0)}
            </div>
            ${canManage ? `<form method="POST" action="/settings/audio-bus" class="settings-form">
              <label class="field-block"><span>Maximale Audio-Sessions</span><input required type="number" name="maxSessions" min="1" max="256" step="1" value="${escapeHtml(String(status.limits ? status.limits.maxSessions : 16))}"></label>
              <p class="muted">1–256 gleichzeitige Sessions, Standard 16. Das Verbindungslimit beträgt automatisch mindestens 32 oder das Doppelte der Session-Anzahl. Änderungen gelten sofort; beim Senken bleiben bestehende Sessions erhalten.</p>
              <div class="button-row"><button type="submit">Speichern</button></div>
            </form>` : ''}
          </section>
`;
}

const statesApiScript = `
    // ── States API: Katalog mit Freigaben ────────────────────────────────────
    var statesApiLoaded = false;
    var statesApiResetArmed = false;
    function statesApiCanManage() {
      var tree = document.getElementById('statesApiTree');
      return !!tree && tree.getAttribute('data-can-manage') === '1';
    }
    function statesApiError(text) {
      var box = document.getElementById('statesApiTreeError');
      if (!box) return;
      box.textContent = text || '';
      box.hidden = !text;
    }
    function statesApiSummary(folders, states) {
      var node = document.getElementById('statesApiSummary');
      if (!node) return;
      if (folders != null) node.setAttribute('data-folders', String(folders));
      if (states != null) node.setAttribute('data-states', String(states));
      var f = Number(node.getAttribute('data-folders')) || 0;
      var s = Number(node.getAttribute('data-states')) || 0;
      node.textContent = f || s
        ? 'Ausgeschlossene Verzeichnisse:' + ' ' + f + ' · ' + 'Ausgeschlossene States:' + ' ' + s
        : 'Alle States sind freigegeben.';
    }
    function statesApiEl(tag, className, text) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      if (text != null) el.textContent = text;
      return el;
    }
    function statesApiPost(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-HomeESS-Request': '1' },
        body: JSON.stringify(payload || {}),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data && data.error ? data.error : 'Die Freigabe konnte nicht gespeichert werden.');
          return data;
        });
      });
    }
    function statesApiFetchLevel(path, offset) {
      var url = '/settings/states-api/catalog.json?path=' + encodeURIComponent(path || '') + '&offset=' + (offset || 0);
      return fetch(url, { headers: { Accept: 'application/json' } }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data && data.error ? data.error : 'Der States-Katalog konnte nicht geladen werden.');
          return data;
        });
      });
    }
    function statesApiSetExcluded(node, excluded) {
      node.classList.toggle('is-excluded', excluded);
      var badge = node.querySelector(':scope > .states-api-row .states-api-badge');
      if (badge) badge.hidden = !excluded;
    }
    function statesApiFolderNode(folder, depth) {
      var node = statesApiEl('div', 'states-api-node states-api-node--folder');
      node.setAttribute('data-path', folder.path);
      node.style.setProperty('--tree-depth', depth);
      var row = statesApiEl('div', 'states-api-row');
      var caret = statesApiEl('button', 'states-api-caret', '▸');
      caret.type = 'button';
      caret.setAttribute('aria-expanded', 'false');
      caret.setAttribute('aria-label', 'Verzeichnis auf- oder zuklappen');
      var label = statesApiEl('label', 'states-api-check');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !folder.excluded;
      box.disabled = !statesApiCanManage();
      box.title = 'Für die API freigegeben';
      label.appendChild(box);
      label.appendChild(statesApiEl('span', 'states-api-name', folder.name));
      var badge = statesApiEl('span', 'states-api-badge', 'Ausgeschlossen');
      badge.hidden = !folder.excluded;
      var count = statesApiEl('span', 'value-cat-count', String(folder.stateCount));
      row.appendChild(caret);
      row.appendChild(label);
      row.appendChild(badge);
      row.appendChild(count);
      var children = statesApiEl('div', 'states-api-children');
      children.hidden = true;
      node.appendChild(row);
      node.appendChild(children);
      if (folder.excluded) node.classList.add('is-excluded');
      caret.addEventListener('click', function () { statesApiToggleFolder(node, depth); });
      box.addEventListener('change', function () {
        var excluded = !box.checked;
        box.disabled = true;
        statesApiError('');
        statesApiPost('/settings/states-api/exclusion', { kind: 'folder', path: folder.path, excluded: excluded })
          .then(function (data) {
            statesApiSetExcluded(node, excluded);
            // Unterelemente eines ausgeschlossenen Verzeichnisses verschwinden;
            // nach dem Freigeben werden sie beim Aufklappen frisch geladen.
            statesApiCollapse(node);
            statesApiSummary(data.excludedFolders, data.excludedStates);
          })
          .catch(function (error) {
            box.checked = !excluded;
            statesApiError(error.message);
          })
          .then(function () { box.disabled = !statesApiCanManage(); });
      });
      return node;
    }
    function statesApiStateNode(state, depth) {
      var node = statesApiEl('div', 'states-api-node states-api-node--state');
      node.style.setProperty('--tree-depth', depth);
      var row = statesApiEl('div', 'states-api-row');
      row.appendChild(statesApiEl('span', 'states-api-caret states-api-caret--leaf', ''));
      var label = statesApiEl('label', 'states-api-check');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !state.excluded;
      box.disabled = !statesApiCanManage();
      box.title = 'Für die API freigegeben';
      label.appendChild(box);
      label.appendChild(statesApiEl('span', 'states-api-name', state.name));
      row.appendChild(label);
      row.appendChild(statesApiEl('code', 'states-api-topic', state.topic));
      var badge = statesApiEl('span', 'states-api-badge', 'Ausgeschlossen');
      badge.hidden = !state.excluded;
      row.appendChild(badge);
      row.appendChild(statesApiEl('span', 'states-api-value', state.display || ''));
      node.appendChild(row);
      if (state.excluded) node.classList.add('is-excluded');
      box.addEventListener('change', function () {
        var excluded = !box.checked;
        box.disabled = true;
        statesApiError('');
        statesApiPost('/settings/states-api/exclusion', { kind: 'state', topic: state.topic, excluded: excluded })
          .then(function (data) {
            statesApiSetExcluded(node, excluded);
            statesApiSummary(data.excludedFolders, data.excludedStates);
          })
          .catch(function (error) {
            box.checked = !excluded;
            statesApiError(error.message);
          })
          .then(function () { box.disabled = !statesApiCanManage(); });
      });
      return node;
    }
    function statesApiRenderLevel(container, data, depth) {
      var i;
      for (i = 0; i < (data.folders || []).length; i++) container.appendChild(statesApiFolderNode(data.folders[i], depth));
      for (i = 0; i < (data.states || []).length; i++) container.appendChild(statesApiStateNode(data.states[i], depth));
      if (data.nextOffset != null) {
        var more = statesApiEl('button', 'secondary-button states-api-more', 'Weitere laden');
        more.type = 'button';
        more.addEventListener('click', function () {
          more.disabled = true;
          statesApiFetchLevel(data.path, data.nextOffset)
            .then(function (next) {
              more.remove();
              // Nur die States der nächsten Seite, die Verzeichnisse stehen schon.
              next.folders = [];
              statesApiRenderLevel(container, next, depth);
            })
            .catch(function (error) { more.disabled = false; statesApiError(error.message); });
        });
        container.appendChild(more);
      }
      if (!container.children.length) container.appendChild(statesApiEl('p', 'muted states-api-empty', 'Keine Einträge.'));
    }
    function statesApiCollapse(node) {
      var children = node.querySelector(':scope > .states-api-children');
      var caret = node.querySelector(':scope > .states-api-row .states-api-caret');
      if (children) { children.hidden = true; children.innerHTML = ''; }
      if (caret) caret.setAttribute('aria-expanded', 'false');
      node.classList.remove('is-open');
    }
    function statesApiToggleFolder(node, depth) {
      var children = node.querySelector(':scope > .states-api-children');
      var caret = node.querySelector(':scope > .states-api-row .states-api-caret');
      if (node.classList.contains('is-open')) return statesApiCollapse(node);
      node.classList.add('is-open');
      caret.setAttribute('aria-expanded', 'true');
      children.hidden = false;
      if (node.classList.contains('is-excluded')) {
        children.innerHTML = '';
        children.appendChild(statesApiEl('p', 'muted states-api-empty', 'Ausgeschlossen – die Unterelemente sind für die API nicht erreichbar.'));
        return;
      }
      children.innerHTML = '';
      children.appendChild(statesApiEl('p', 'muted states-api-empty', 'Wird geladen …'));
      statesApiFetchLevel(node.getAttribute('data-path'), 0)
        .then(function (data) {
          children.innerHTML = '';
          statesApiRenderLevel(children, data, depth + 1);
        })
        .catch(function (error) {
          children.innerHTML = '';
          statesApiError(error.message);
        });
    }
    function statesApiLoadRoot() {
      var tree = document.getElementById('statesApiTree');
      if (!tree || !statesApiCanManage()) return;
      statesApiLoaded = true;
      statesApiFetchLevel('', 0)
        .then(function (data) {
          tree.innerHTML = '';
          statesApiRenderLevel(tree, data, 0);
        })
        .catch(function (error) {
          tree.innerHTML = '';
          statesApiError(error.message);
          statesApiLoaded = false;
        });
    }
    function statesApiResetExclusions() {
      var button = document.getElementById('statesApiReset');
      if (!statesApiResetArmed) {
        statesApiResetArmed = true;
        button.textContent = 'Wirklich alle Ausschlüsse aufheben?';
        setTimeout(function () {
          statesApiResetArmed = false;
          button.textContent = 'Alle Ausschlüsse aufheben';
        }, 4000);
        return;
      }
      statesApiResetArmed = false;
      button.textContent = 'Alle Ausschlüsse aufheben';
      statesApiPost('/settings/states-api/exclusions/reset', {})
        .then(function (data) {
          statesApiSummary(data.excludedFolders, data.excludedStates);
          statesApiLoadRoot();
        })
        .catch(function (error) { statesApiError(error.message); });
    }
    statesApiSummary();
    (function () {
      var panel = document.querySelector('[data-settings-panel="states-api"]');
      if (panel && !panel.hidden) statesApiLoadRoot();
      document.addEventListener('homeess:settings-tab', function (event) {
        if (event.detail && event.detail.tab === 'states-api' && !statesApiLoaded) statesApiLoadRoot();
      });
    })();
`;

module.exports = { statesApiPanel, statesApiScript };
