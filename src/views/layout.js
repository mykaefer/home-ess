'use strict';

const { escapeHtml } = require('./components');
const { getEnabledNavItems } = require('../modules');
const { statePickerModal, statePickerScript, statePickerAutoAttach } = require('./state-picker');

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
  {
    path: '/adapter',
    label: 'Adapter',
    section: 'main',
    children: [{ path: '/states', label: 'States' }],
  },
  { path: '/output', label: 'Output', section: 'main' },
  { path: '/module', label: 'Module', section: 'footer' },
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

function renderNavLinks(section, activePath) {
  const extra = section === 'main' ? getEnabledNavItems() : [];
  return [...NAV_CORE.filter((item) => item.section === section), ...extra]
    .map((item) => renderNavItem(item, activePath))
    .join('\n          ');
}

// Mobile Navigation: untere Tab-Bar + Menü-Sheet mit allen Seiten (inkl.
// aktivierter Module, Footer-Seiten, Abmelden und Version). Wird immer
// gerendert, aber nur im Mobile-Layer (styles.css, ≤ 768px) sichtbar.
function renderMobileNav(activePath) {
  const tabs = MOBILE_TABS.map((tab) => {
    const active = tab.path === activePath ? ' active' : '';
    return `<a class="mobile-tab${active}" href="${tab.path}"><span class="mobile-tab-icon" aria-hidden="true">${tab.icon}</span><span class="mobile-tab-label">${escapeHtml(tab.label)}</span></a>`;
  }).join('\n      ');

  const flatLinks = [];
  const mainItems = [...NAV_CORE.filter((item) => item.section === 'main'), ...getEnabledNavItems()];
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
      if (!button || !sheet) return;
      function setOpen(open) {
        sheet.classList.toggle('is-open', open);
        document.body.classList.toggle('mobile-nav-open', open);
      }
      button.addEventListener('click', function () {
        // Das Titellogo ist nur in der Smartphone-Ansicht eine Menüschaltfläche.
        if (!window.matchMedia('(max-width: 768px)').matches) return;
        setOpen(!sheet.classList.contains('is-open'));
      });
      var closeButton = document.getElementById('mobile-nav-close');
      if (closeButton) closeButton.addEventListener('click', function () { setOpen(false); });
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

// renderLayout({ title, activePath, body, script })
function renderLayout({ title, activePath = '', body = '', script = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>${escapeHtml(title || 'homeESS')}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="page-dashboard">
  <div class="app-shell">
    <header class="dashboard-header">
      <button type="button" class="header-logo-button" id="mobile-menu-button" aria-controls="mobile-nav-sheet" aria-label="Menü öffnen">
        <img src="/homeESS.png" alt="homeESS" class="header-logo">
      </button>
      <div class="header-statusbar" aria-label="Umgebungswerte">
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

    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-nav">
          ${renderNavLinks('main', activePath)}
        </div>
        <div class="sidebar-footer">
          ${renderNavLinks('footer', activePath)}
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
${renderMobileNav(activePath)}
${statePickerModal()}
  </div>
${renderLiveScript()}
  <script>
${mobileNavScript()}
${statePickerScript()}
${statePickerAutoAttach()}
  </script>
${script ? `  <script>\n${script}\n  </script>` : ''}
</body>
</html>`;
}

module.exports = { renderLayout, NAV };
