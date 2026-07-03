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
  { path: '/messen-schalten', label: 'Messen + Schalten', section: 'main' },
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
        var batNode  = document.getElementById('header-battery');
        var batFill  = document.getElementById('bat-fill');
        var batPct   = document.getElementById('bat-pct');
        if (batNode && data.batterySoc != null) {
          var pct = Math.min(100, Math.max(0, data.batterySoc));
          batFill.style.width = pct.toFixed(0) + '%';
          batFill.style.background = pct < 20 ? '#e74c3c' : pct < 50 ? '#d4a500' : '#2ecc71';
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title || 'homeESS')}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="page-dashboard">
  <div class="app-shell">
    <header class="dashboard-header">
      <img src="/homeESS.png" alt="homeESS" class="header-logo">
      <div class="header-statusbar" aria-label="Umgebungswerte">
        <span class="header-status-pill">
          <strong>Aussen</strong>
          <span id="header-temperature">-- °C</span>
        </span>
        <span class="header-status-pill">
          <strong>Zeit</strong>
          <span id="header-time">--:--</span>
        </span>
        <span class="header-status-pill">
          <strong>Datum</strong>
          <span id="header-date">--.--.----</span>
        </span>
        <span class="header-battery" id="header-battery" title="Batterie Ladezustand">
          <span class="bat-body"><span class="bat-fill" id="bat-fill"></span></span><span class="bat-cap"></span>
          <span class="bat-pct" id="bat-pct"></span>
        </span>
        <span class="header-operating-level" id="header-operating-level" data-level="2" title="Betriebslevel 2">
          <span class="operating-level-bar operating-level-bar--5" data-level="5"></span>
          <span class="operating-level-bar operating-level-bar--4" data-level="4"></span>
          <span class="operating-level-bar operating-level-bar--3" data-level="3"></span>
          <span class="operating-level-bar operating-level-bar--2 is-active" data-level="2"></span>
          <span class="operating-level-bar operating-level-bar--1 is-active" data-level="1"></span>
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
            Copyright (C) 2026 Kevin Käfer | MyKaefer Apps<br>
            Version: ${escapeHtml(pkgVersion)}
          </div>
        </div>
      </aside>

      <main class="main-content">
${body}
      </main>
    </div>
${statePickerModal()}
  </div>
${renderLiveScript()}
  <script>
${statePickerScript()}
${statePickerAutoAttach()}
  </script>
${script ? `  <script>\n${script}\n  </script>` : ''}
</body>
</html>`;
}

module.exports = { renderLayout, NAV };
