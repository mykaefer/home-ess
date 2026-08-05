'use strict';

const { escapeHtml } = require('./components');
const { getEnabledNavItems } = require('../modules');
const { getHdpNavItems } = require('../adapters/navigation');
const { statePickerModal, statePickerScript, statePickerAutoAttach } = require('./state-picker');
const { currentAccess, canSeePage, pageForPath } = require('../auth/access');
const i18n = require('../i18n');

let pkgVersion = '—';
try {
  // eslint-disable-next-line global-require
  pkgVersion = require('../../package.json').version || '—';
} catch (_) {
  /* Version bleibt unbekannt */
}

// Gemeinsame App-Hülle (Header + Sidebar) für alle authentifizierten Seiten.
// Kernseiten stehen fest; optionale Module fügen sich über getEnabledNavItems()
// dynamisch in die Hauptnavigation ein.
const NAV_CORE = [
  { path: '/dashboard', label: 'Dashboard', section: 'main' },
  { path: '/stromverbrauch', label: 'Stromverbrauch', section: 'main' },
  { path: '/photovoltaik', label: 'Photovoltaik', section: 'main' },
  { path: '/batterie', label: 'Batterie', section: 'main' },
  {
    path: '/messen-schalten',
    label: 'Messen + Schalten',
    section: 'main',
    children: [
      { path: '/messen-schalten/energiefluss', label: 'Energiefluss' },
      { path: '/messen-schalten/schaltgruppen', label: 'Schaltgruppen' },
    ],
  },
  { path: '/prognose', label: 'Prognose', section: 'main' },
  { path: '/adapter', label: 'Adapter', section: 'main' },
  {
    path: '/states', label: 'States', section: 'main',
    children: [{ path: '/states/custom', label: 'Custom States' }],
  },
  { path: '/output', label: 'Output', section: 'main' },
  // Module und Fernzugriff sind in die Einstellungsseite (Tabs) integriert; der
  // Footer trägt daher nur noch die Einstellungen.
  { path: '/settings', label: 'Einstellungen', section: 'footer' },
];

// NAV wird von außen noch als Array erwartet (z. B. in Tests) — exportieren wir
// die Kern-Liste unter dem alten Namen.
const NAV = NAV_CORE;

// Mobile Tab-Bar (≤ 768px): die fünf wichtigsten Seiten als Direktzugriff.
// Alles Weitere über das Titellogo im Header (öffnet das vollflächige
// Navigations-Sheet) — ein eigener Menü-Tab entfällt.
const MOBILE_TABS = [
  { path: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { path: '/stromverbrauch', label: 'Strom', icon: '⚡' },
  { path: '/photovoltaik', label: 'PV', icon: '☀️' },
  { path: '/batterie', label: 'Batterie', icon: '🔋' },
  { path: '/prognose', label: 'Prognose', icon: '📈' },
];

function renderNavItem(item, activePath) {
  const children = item.children || [];
  const childActive = children.some((child) => child.path === activePath);
  const active = item.path === activePath || childActive ? ' class="active"' : '';
  const link = `<a href="${item.path}"${active}>${escapeHtml(item.label)}</a>`;
  if (!children.length) return link;

  const childLinks = children
    .map((child) => {
      const childActiveCls = child.path === activePath ? ' class="active"' : '';
      return `<a href="${child.path}"${childActiveCls}>${escapeHtml(child.label)}</a>`;
    })
    .join('\n            ');
  const expanded = item.path === activePath || childActive ? ' expanded' : '';
  return `<div class="nav-group${expanded}">
          ${link}
          <div class="nav-subnav">
            ${childLinks}
          </div>
        </div>`;
}

// Ein Navigationspunkt ist sichtbar, wenn die zugehörige Seite für den Nutzer
// freigeschaltet ist (Administrator/uneingeschränkt: alles sichtbar). Punkte
// ohne zugeordnete Seite bleiben sichtbar.
function navItemVisible(item, access) {
  const pageKey = pageForPath(item.path);
  if (!pageKey) return true;
  return canSeePage(access, pageKey);
}

// hDP ist das universelle homeESS-Geräteprotokoll. Seine instanzbezogenen
// Geräteverwaltungen stehen als eigene Hauptpunkte direkt hinter „Adapter“;
// andere Adapter erhalten unabhängig von ihren Unterseiten keinen Eintrag.
function getMainNavItems() {
  const items = NAV_CORE.filter((item) => item.section === 'main');
  const adapterIndex = items.findIndex((item) => item.path === '/adapter');
  items.splice(adapterIndex + 1, 0, ...getHdpNavItems());
  return [...items, ...getEnabledNavItems()];
}

function renderNavLinks(section, activePath, access) {
  const items = section === 'main'
    ? getMainNavItems()
    : NAV_CORE.filter((item) => item.section === section);
  return items
    .filter((item) => navItemVisible(item, access))
    .map((item) => renderNavItem(item, activePath))
    .join('\n          ');
}

// Mobile Navigation: untere Tab-Bar + Menü-Sheet mit allen Seiten (inkl.
// aktivierter Module, Footer-Seiten, Abmelden und Version). Wird immer
// gerendert, aber nur im Mobile-Layer (styles.css, ≤ 768px) sichtbar.
function renderMobileNav(activePath, access) {
  const tabs = MOBILE_TABS
    .filter((tab) => navItemVisible(tab, access))
    .map((tab) => {
      const active = tab.path === activePath ? ' active' : '';
      return `<a class="mobile-tab${active}" href="${tab.path}"><span class="mobile-tab-icon" aria-hidden="true">${tab.icon}</span><span class="mobile-tab-label">${escapeHtml(tab.label)}</span></a>`;
    }).join('\n      ');

  const flatLinks = [];
  const mainItems = getMainNavItems()
    .filter((item) => navItemVisible(item, access));
  for (const item of mainItems) {
    flatLinks.push({ path: item.path, label: item.label, sub: false });
    for (const child of item.children || []) {
      flatLinks.push({ path: child.path, label: child.label, sub: true });
    }
  }
  const renderSheetLink = (link) => {
    const classes = ['mobile-nav-link'];
    if (link.sub) classes.push('mobile-nav-link--sub');
    if (link.path === activePath) classes.push('active');
    return `<a class="${classes.join(' ')}" href="${link.path}">${escapeHtml(link.label)}</a>`;
  };
  const mainLinks = flatLinks.map(renderSheetLink).join('\n        ');
  const footerLinks = NAV_CORE.filter((item) => item.section === 'footer')
    .filter((item) => navItemVisible(item, access))
    .map((item) => renderSheetLink({ path: item.path, label: item.label, sub: false }))
    .join('\n        ');

  return `    <div class="mobile-nav-sheet" id="mobile-nav-sheet" aria-label="Hauptmenü">
      <div class="mobile-nav-head">
        <img src="/homeESS.png" alt="homeESS" class="mobile-nav-logo">
        <button type="button" class="mobile-nav-close" id="mobile-nav-close" aria-label="Menü schließen">✕</button>
      </div>
      <nav class="mobile-nav-links">
        ${mainLinks}
        <div class="mobile-nav-divider"></div>
        ${footerLinks}
      </nav>
      <div class="mobile-nav-foot">
        <button class="logout-button" onclick="window.location.href='/logout'">Abmelden</button>
        <div class="sidebar-copyright">
          Copyright (C) 2026 Kevin Käfer | <a class="sidebar-copyright-link" href="https://apps.mykaefer.net" target="_blank" rel="noopener noreferrer">MyKaefer Apps</a><br>
          Version: ${escapeHtml(pkgVersion)}
        </div>
      </div>
    </div>
    <nav class="mobile-tabbar" aria-label="Hauptnavigation">
      ${tabs}
    </nav>`;
}

function mobileNavScript() {
  return `    (function () {
      var button = document.getElementById('mobile-menu-button');
      var sheet = document.getElementById('mobile-nav-sheet');
      if (!sheet) return;
      function setOpen(open) {
        sheet.classList.toggle('is-open', !!open);
        document.body.classList.toggle('mobile-nav-open', !!open);
      }
      function isOpen() {
        return sheet.classList.contains('is-open');
      }
      if (button) {
        button.addEventListener('click', function () {
          // Das Titellogo ist nur in der Smartphone-Ansicht eine Menüschaltfläche.
          if (!window.matchMedia('(max-width: 768px)').matches) return;
          setOpen(!isOpen());
        });
      }
      var closeButton = document.getElementById('mobile-nav-close');
      if (closeButton) closeButton.addEventListener('click', function () { setOpen(false); });

      // Öffentliche Schnittstelle für die native App-Hülle (WebView):
      //   window.homeESSApp.openMenu()  – Menü-Sheet per Geste öffnen
      //   window.homeESSApp.closeMenu() – Menü-Sheet schließen
      //   window.homeESSApp.toggleMenu()/isMenuOpen() – umschalten/abfragen
      // Rückgabewert true = ausgeführt, false = kein Menü im DOM.
      var app = window.homeESSApp || (window.homeESSApp = {});
      app.openMenu = function () { setOpen(true); return true; };
      app.closeMenu = function () { setOpen(false); return true; };
      app.toggleMenu = function () { setOpen(!isOpen()); return isOpen(); };
      app.isMenuOpen = function () { return isOpen(); };
    })();`;
}

function renderLiveScript() {
  return `  <script>
    (function () {
      var source = null;
      var refreshTimer = null;

      function applyHeaderData(data) {
        if (!data) return;
        var temperatureNode = document.getElementById('header-temperature');
        var timeNode = document.getElementById('header-time');
        var dateNode = document.getElementById('header-date');
        if (temperatureNode && data.temperature) temperatureNode.textContent = data.temperature.display;
        if (timeNode && data.time) timeNode.textContent = data.time.display;
        if (dateNode && data.date) dateNode.textContent = data.date.display;
        if (data.power) {
          [['header-power-pv', data.power.pv], ['header-power-grid', data.power.grid],
           ['header-power-self', data.power.self], ['header-power-battery', data.power.battery]
          ].forEach(function (pair) {
            var node = document.getElementById(pair[0]);
            if (node && pair[1] != null) node.textContent = pair[1];
          });
        }
        var batNode  = document.getElementById('header-battery');
        var batFill  = document.getElementById('bat-fill');
        var batPct   = document.getElementById('bat-pct');
        if (batNode && data.batterySoc != null) {
          var pct = Math.min(100, Math.max(0, data.batterySoc));
          batFill.style.width = pct.toFixed(0) + '%';
          batFill.style.background = pct < 20 ? '#c53030' : pct < 50 ? '#c99a2e' : '#27ae60';
          batPct.textContent = pct.toFixed(0) + ' %';
          batNode.classList.add('bat-visible');
        }

        var levelNode = document.getElementById('header-operating-level');
        if (levelNode && data.operatingLevel != null) {
          var level = Math.min(5, Math.max(1, Number(data.operatingLevel) || 1));
          levelNode.setAttribute('data-level', String(level));
          levelNode.title = 'Betriebslevel ' + level + (data.emergencyMode ? ' · Notstrombetrieb / kein Netz' : '');
          levelNode.classList.toggle('operating-level--emergency', !!data.emergencyMode);
          Array.prototype.forEach.call(levelNode.querySelectorAll('.operating-level-bar'), function (bar) {
            bar.classList.toggle('is-active', Number(bar.getAttribute('data-level')) <= level);
          });
          var numNode = document.getElementById('operating-level-num');
          if (numNode) numNode.textContent = String(level);
        }

        var skyNode = document.getElementById('header-sky');
        if (skyNode && data.sky) {
          if (data.sky === 'sun') {
            skyNode.textContent = '☀️';
            skyNode.title = 'Direkte Sonneneinstrahlung an mindestens einer PV-Anlage';
          } else if (data.sky === 'cloud') {
            skyNode.textContent = '☁️';
            skyNode.title = 'Tagsüber, keine direkte Sonneneinstrahlung';
          } else {
            skyNode.textContent = '🌙';
            skyNode.title = 'Nacht';
          }
        }
      }

      function refreshHeaderData() {
        fetch('/live/header', { headers: { Accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (data) {
            if (data) applyHeaderData(data);
          })
          .catch(function () {});
      }

      function queueHeaderRefresh() {
        if (refreshTimer) return;
        refreshTimer = window.setTimeout(function () {
          refreshTimer = null;
          refreshHeaderData();
        }, 50);
      }

      refreshHeaderData();
      window.setInterval(refreshHeaderData, 10000);
      if (!window.EventSource) return;
      source = new EventSource('/live/events');
      source.addEventListener('mqtt', function (event) {
        var detail = {};
        try {
          detail = JSON.parse(event.data || '{}');
        } catch (_) {
          detail = {};
        }
        queueHeaderRefresh();
        window.dispatchEvent(new CustomEvent('homeess:mqtt', { detail: detail }));
      });
      window.addEventListener('beforeunload', function () {
        if (source) source.close();
      });
    })();
  </script>`;
}

function renderUpdateScript() {
  return `  <script>
    (function () {
      var pill = document.getElementById('header-update-pill');
      var dialog = document.getElementById('update-confirm-dialog');
      var versionNode = document.getElementById('update-confirm-version');
      var confirmButton = document.getElementById('update-confirm-yes');
      var cancelButton = document.getElementById('update-confirm-no');
      var targetVersion = null;
      var updateScreenActive = false;
      var pollTimer = null;
      var connectionMessageShown = false;

      function activeOperation(operation) {
        return operation && !['completed', 'failed', 'failed_rollback'].includes(operation.state);
      }

      function appendLocalMessage(text, kind) {
        var list = document.getElementById('update-progress-messages');
        if (!list) return;
        var item = document.createElement('li');
        item.className = kind ? 'update-progress-message update-progress-message--' + kind : 'update-progress-message';
        item.textContent = text;
        list.appendChild(item);
        item.scrollIntoView({ block: 'nearest' });
      }

      function showUpdateScreen(version) {
        if (updateScreenActive) return;
        updateScreenActive = true;
        document.body.classList.add('page-update');
        var shell = document.querySelector('.app-shell');
        if (!shell) return;
        shell.innerHTML = '<main class="update-progress"><section class="update-progress-card">' +
          '<img src="/homeESS.png" alt="homeESS" class="update-progress-logo">' +
          '<div class="update-progress-spinner" aria-hidden="true"></div>' +
          '<h1>homeESS wird aktualisiert</h1>' +
          '<p class="update-progress-target">Zielversion: <strong></strong></p>' +
          '<ol class="update-progress-messages" id="update-progress-messages" aria-live="polite"></ol>' +
          '<p class="update-progress-hint">Dieses Fenster bitte geöffnet lassen. Der Server ist während des Neustarts kurz nicht erreichbar.</p>' +
          '<button type="button" class="update-progress-back" id="update-progress-back" hidden>Zurück zum Dashboard</button>' +
          '</section></main>';
        shell.querySelector('.update-progress-target strong').textContent = version || '—';
      }

      function renderOperation(operation, currentVersion) {
        if (!operation) return;
        if (activeOperation(operation) || updateScreenActive) showUpdateScreen(operation.targetVersion);
        if (!updateScreenActive) return;
        var list = document.getElementById('update-progress-messages');
        if (list) {
          list.innerHTML = '';
          (operation.messages || []).forEach(function (message) {
            var item = document.createElement('li');
            item.className = 'update-progress-message';
            item.textContent = message.text || '';
            list.appendChild(item);
          });
        }
        connectionMessageShown = false;
        var spinner = document.querySelector('.update-progress-spinner');
        var back = document.getElementById('update-progress-back');
        if (operation.state === 'completed' && currentVersion === operation.targetVersion) {
          if (spinner) spinner.classList.add('is-complete');
          window.setTimeout(function () { window.location.replace('/dashboard'); }, 1500);
        } else if (operation.state === 'failed' || operation.state === 'failed_rollback') {
          if (spinner) spinner.classList.add('is-failed');
          if (back) {
            back.hidden = false;
            back.onclick = function () { window.location.assign('/dashboard'); };
          }
        }
      }

      function applyStatus(status) {
        if (!status) return;
        targetVersion = status.availableVersion;
        if (pill) {
          pill.hidden = !(status.supported && targetVersion);
          if (targetVersion) pill.textContent = 'Version ' + targetVersion + ' verfügbar';
        }
        renderOperation(status.operation, status.currentVersion);
        try { document.dispatchEvent(new CustomEvent('homeess:update-status', { detail: status })); } catch (_) {}
      }

      function fetchStatus() {
        fetch('/update/status', { headers: { Accept: 'application/json' }, cache: 'no-store' })
          .then(function (response) { return response.ok ? response.json() : Promise.reject(new Error('offline')); })
          .then(function (status) {
            applyStatus(status);
            schedule(updateScreenActive ? 1000 : 300000);
          })
          .catch(function () {
            if (updateScreenActive && !connectionMessageShown) {
              appendLocalMessage('Verbindung zum Server unterbrochen – Neustart läuft …', 'waiting');
              connectionMessageShown = true;
            }
            schedule(updateScreenActive ? 1000 : 60000);
          });
      }

      function schedule(delay) {
        if (pollTimer) window.clearTimeout(pollTimer);
        pollTimer = window.setTimeout(fetchStatus, delay);
      }

      if (pill && dialog) {
        pill.addEventListener('click', function () {
          if (!targetVersion) return;
          if (versionNode) versionNode.textContent = targetVersion;
          if (typeof dialog.showModal === 'function') dialog.showModal();
          else dialog.setAttribute('open', '');
        });
      }
      if (cancelButton && dialog) cancelButton.addEventListener('click', function () { dialog.close(); });
      if (confirmButton && dialog) {
        confirmButton.addEventListener('click', function () {
          var version = targetVersion;
          dialog.close();
          showUpdateScreen(version);
          appendLocalMessage('Update wird vorbereitet …');
          fetch('/update/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-HomeESS-Update': 'confirm' },
            body: JSON.stringify({ version: version })
          }).then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error(body.error || 'Update konnte nicht gestartet werden.');
              applyStatus(body);
              schedule(500);
            });
          }).catch(function (error) {
            appendLocalMessage(error.message || 'Update konnte nicht gestartet werden.', 'error');
            var spinner = document.querySelector('.update-progress-spinner');
            if (spinner) spinner.classList.add('is-failed');
            var back = document.getElementById('update-progress-back');
            if (back) { back.hidden = false; back.onclick = function () { window.location.reload(); }; }
          });
        });
      }
      window.homeESSUpdate = {
        checkNow: function () {
          return fetch('/update/check', {
            method: 'POST',
            headers: { Accept: 'application/json', 'X-HomeESS-Update': 'check' }
          }).then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error(body.error || 'Updateprüfung fehlgeschlagen.');
              applyStatus(body);
              return body;
            });
          });
        },
        confirm: function (version) {
          targetVersion = version;
          if (versionNode) versionNode.textContent = version;
          if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
        }
      };
      fetchStatus();
      window.addEventListener('beforeunload', function () { if (pollTimer) window.clearTimeout(pollTimer); });
    })();
  </script>`;
}

// renderLayout({ title, activePath, body, script, stylesheets })
function renderLayout({
  title, activePath = '', body = '', script = '', stylesheets = [],
} = {}) {
  // Zugriffsrechte des aktuellen Nutzers (request-gebunden über AsyncLocalStorage).
  // Außerhalb eines Requests (Tests/Direktrender) liefert currentAccess() vollen
  // Zugriff, sodass bestehendes Verhalten unverändert bleibt.
  const access = currentAccess();
  // Body-Klasse steuert die zentrale, seitenübergreifende Read-Only-/Bedienen-
  // Darstellung in styles.css (Formularfelder, Bearbeiten-/Löschen-Buttons,
  // Drag-Griffe, Topic-Picker gesperrt; bei „bedienen" bleiben Schalter aktiv).
  const accessClass = access.canWrite
    ? 'access-write'
    : access.canOperate
      ? 'access-operate'
      : 'access-read';
  const extraStylesheets = (Array.isArray(stylesheets) ? stylesheets : [])
    .filter((href) => typeof href === 'string' && href.startsWith('/') && !href.startsWith('//'))
    .map((href) => `  <link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n');
  const language = i18n.current();
  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(language.code)}" dir="${escapeHtml(language.direction)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>${escapeHtml(title || 'homeESS')}</title>
  <link rel="icon" href="/homeess-icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/homeess-icon.svg">
  <link rel="stylesheet" href="/styles.css">
${extraStylesheets}
</head>
<body class="page-dashboard ${accessClass}" data-access="${access.canWrite ? 'write' : access.canOperate ? 'operate' : 'read'}" data-admin="${access.isAdmin ? 'true' : 'false'}">
  <div class="app-shell">
    <header class="dashboard-header">
      <button type="button" class="header-logo-button" id="mobile-menu-button" aria-controls="mobile-nav-sheet" aria-label="Menü öffnen">
        <img src="/homeESS.png" alt="homeESS" class="header-logo">
      </button>
      <div class="header-statusbar" aria-label="Umgebungswerte">
        ${access.isAdmin ? '<button type="button" class="header-update-pill" id="header-update-pill" hidden></button>' : ''}
        <span class="header-status-pill header-status-pill--power only-desktop" aria-label="Aktuelle Leistungswerte">
          <span class="header-power-item" title="Aktuelle PV-Leistung"><span class="header-power-icon" aria-hidden="true">☀️</span><span id="header-power-pv" class="header-power-value header-power-value--pv">— W</span></span>
          <span class="header-power-item" title="Aktueller Netzbezug (negativ = Einspeisung)"><span class="header-power-icon" aria-hidden="true">⚡</span><span id="header-power-grid" class="header-power-value header-power-value--grid">— W</span></span>
          <span class="header-power-item" title="Aktueller Eigenverbrauch"><span class="header-power-icon" aria-hidden="true">🏠</span><span id="header-power-self" class="header-power-value header-power-value--self">— W</span></span>
          <span class="header-power-item" title="Aktuelle Akkuladung (negativ = Entladung)"><span class="header-power-icon" aria-hidden="true">🔋</span><span id="header-power-battery" class="header-power-value header-power-value--battery">— W</span></span>
        </span>
        <span class="header-status-pill header-status-pill--temperature">
          <strong>Aussen</strong>
          <span id="header-temperature">-- °C</span>
        </span>
        <span class="header-status-pill header-status-pill--time">
          <strong>Zeit</strong>
          <span id="header-time">--:--</span>
        </span>
        <span class="header-status-pill header-status-pill--date">
          <strong>Datum</strong>
          <span id="header-date">--.--.----</span>
        </span>
        <span class="header-battery" id="header-battery" title="Batterie Ladezustand">
          <span class="bat-body"><span class="bat-fill" id="bat-fill"></span></span><span class="bat-cap"></span>
          <span class="bat-pct" id="bat-pct"></span>
        </span>
        <span class="header-operating-level" id="header-operating-level" data-level="2" title="Betriebslevel 2">
          <span class="operating-level-bars">
            <span class="operating-level-bar operating-level-bar--5" data-level="5"></span>
            <span class="operating-level-bar operating-level-bar--4" data-level="4"></span>
            <span class="operating-level-bar operating-level-bar--3" data-level="3"></span>
            <span class="operating-level-bar operating-level-bar--2 is-active" data-level="2"></span>
            <span class="operating-level-bar operating-level-bar--1 is-active" data-level="1"></span>
          </span>
          <span class="operating-level-num" id="operating-level-num">2</span>
        </span>
        <span class="header-sky" id="header-sky" title="Himmelszustand">🌙</span>
      </div>
    </header>
    ${access.isAdmin ? `<dialog class="update-confirm-dialog" id="update-confirm-dialog">
      <form method="dialog">
        <h2>homeESS aktualisieren?</h2>
        <p>Version <strong id="update-confirm-version">—</strong> wird geladen und ersetzt die aktuelle Installation. homeESS wird dabei kurz neu gestartet.</p>
        <div class="update-confirm-actions">
          <button type="button" class="secondary-button" id="update-confirm-no">Nein</button>
          <button type="button" class="primary-button" id="update-confirm-yes">Ja, jetzt aktualisieren</button>
        </div>
      </form>
    </dialog>` : ''}

    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-nav">
          ${renderNavLinks('main', activePath, access)}
        </div>
        <div class="sidebar-footer">
          ${renderNavLinks('footer', activePath, access)}
          <button class="logout-button" onclick="window.location.href='/logout'">Abmelden</button>
          <div class="sidebar-copyright">
            Copyright (C) 2026 Kevin Käfer | <a class="sidebar-copyright-link" href="https://apps.mykaefer.net" target="_blank" rel="noopener noreferrer">MyKaefer Apps</a><br>
            Version: ${escapeHtml(pkgVersion)}
          </div>
        </div>
      </aside>

      <main class="main-content">
${body}
      </main>
    </div>
${renderMobileNav(activePath, access)}
${statePickerModal()}
  </div>
${renderLiveScript()}
${renderUpdateScript()}
  <script>
${mobileNavScript()}
${statePickerScript()}
${statePickerAutoAttach()}
  </script>
${script ? `  <script>\n${script}\n  </script>` : ''}
</body>
</html>`;
  return i18n.localizeText(html);
}

module.exports = { renderLayout, NAV };
