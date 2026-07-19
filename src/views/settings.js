'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { PAGES, ROLES, ROLE_LABELS } = require('../auth/access');
const { modulesPanel } = require('./modules');
const { remoteAccessPanel } = require('./remote-access');

// Reihenfolge und Beschriftung der Einstellungs-Tabs.
const SETTINGS_TABS = [
  { key: 'allgemein', label: 'Allgemeine Einstellungen' },
  { key: 'benutzer', label: 'Benutzerverwaltung' },
  { key: 'module', label: 'Module' },
  { key: 'fernzugriff', label: 'Fernzugriff' },
];
const SETTINGS_TAB_KEYS = new Set(SETTINGS_TABS.map((tab) => tab.key));

// Auswahl gängiger Zeitzonen (IANA). Die erste Gruppe deckt den DACH-Raum ab,
// danach folgen weitere europäische und internationale Zonen.
const TIMEZONE_GROUPS = [
  {
    label: 'Europa',
    zones: [
      ['Europe/Berlin', 'Berlin (MEZ/MESZ)'],
      ['Europe/Vienna', 'Wien (MEZ/MESZ)'],
      ['Europe/Zurich', 'Zürich (MEZ/MESZ)'],
      ['Europe/London', 'London (GMT/BST)'],
      ['Europe/Paris', 'Paris'],
      ['Europe/Madrid', 'Madrid'],
      ['Europe/Rome', 'Rom'],
      ['Europe/Amsterdam', 'Amsterdam'],
      ['Europe/Warsaw', 'Warschau'],
      ['Europe/Athens', 'Athen'],
      ['Europe/Helsinki', 'Helsinki'],
      ['Europe/Moscow', 'Moskau'],
    ],
  },
  {
    label: 'Welt',
    zones: [
      ['UTC', 'UTC (koordinierte Weltzeit)'],
      ['Atlantic/Reykjavik', 'Reykjavík'],
      ['America/New_York', 'New York'],
      ['America/Chicago', 'Chicago'],
      ['America/Denver', 'Denver'],
      ['America/Los_Angeles', 'Los Angeles'],
      ['America/Sao_Paulo', 'São Paulo'],
      ['Asia/Dubai', 'Dubai'],
      ['Asia/Kolkata', 'Kolkata'],
      ['Asia/Shanghai', 'Shanghai'],
      ['Asia/Tokyo', 'Tokio'],
      ['Australia/Sydney', 'Sydney'],
    ],
  },
];

function renderTimezoneOptions(selected) {
  const current = selected || 'Europe/Berlin';
  return TIMEZONE_GROUPS.map((group) => {
    const options = group.zones
      .map(([value, label]) => {
        const isSelected = value === current ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(label)}</option>`;
      })
      .join('\n            ');
    return `<optgroup label="${escapeHtml(group.label)}">\n            ${options}\n          </optgroup>`;
  }).join('\n          ');
}

// Zeile eines Benutzers in der Verwaltungsliste. Doppelklick oder Auswahl +
// „Bearbeiten" öffnet den Bearbeiten-Dialog.
function renderUserRow(user) {
  const roleLabel = user.isAdmin ? 'Administrator' : (ROLE_LABELS[user.role] || user.role);
  const badgeClass = user.isAdmin ? 'user-badge user-badge--admin' : `user-badge user-badge--${user.role}`;
  return `                <li class="user-row" data-id="${user.id}" data-admin="${user.isAdmin ? '1' : '0'}" tabindex="0"
                  onclick="selectUserRow(this)" ondblclick="editSelectedUser(${user.id})"
                  onkeydown="if(event.key==='Enter'){editSelectedUser(${user.id});}">
                  <span class="user-row-name">${escapeHtml(user.name)}</span>
                  <span class="${badgeClass}">${escapeHtml(roleLabel)}</span>
                </li>`;
}

// Einstellungen als Tab-Seite: Allgemeine Einstellungen (Standort/Zeit + MQTT),
// Benutzerverwaltung, Module und Fernzugriff. Module und Fernzugriff waren früher
// eigene Menüpunkte und sind hier als Tabs zusammengefasst.
function renderSettings({
  mqtt = {
    host: '',
    port: '',
    username: '',
    password: '',
    latitude: '',
    longitude: '',
    timezone: 'Europe/Berlin',
    dstEnabled: 1,
    outdoorTemperatureTopic: '',
    clockTimeTopic: '',
    clockDateTopic: '',
  },
  mqttMessage = '',
  users = [],
  userMessage = '',
  userError = '',
  userDialogOpen = false,
  userDialogMode = 'add',
  userDialogError = '',
  userDialogValues = null,
  registry = [],
  enabledKeys = new Set(),
  moduleMessage = '',
  activeTab = 'allgemein',
} = {}) {
  const dstChecked = mqtt.dstEnabled === undefined || mqtt.dstEnabled ? ' checked' : '';
  const currentTab = SETTINGS_TAB_KEYS.has(activeTab) ? activeTab : 'allgemein';
  const remote = remoteAccessPanel();

  const tabBar = SETTINGS_TABS
    .map((tab) => {
      const active = tab.key === currentTab;
      return `          <button type="button" class="settings-tab${active ? ' is-active' : ''}" data-settings-tab="${tab.key}" role="tab" aria-selected="${active ? 'true' : 'false'}" onclick="settingsTab('${tab.key}')">${escapeHtml(tab.label)}</button>`;
    })
    .join('\n');

  const panelAttr = (key) => `class="settings-panel" data-settings-panel="${key}" role="tabpanel"${key === currentTab ? '' : ' hidden'}`;

  const userPanel = `          <section class="settings-card">
            <div class="settings-card-head">
              <h2>Benutzer</h2>
              <p class="settings-card-hint">Zugänge zur Weboberfläche verwalten: Rolle (Lesen, Bedienen, Schreiben) und sichtbare Seiten je Benutzer. Der Administrator hat immer alle Rechte.</p>
            </div>
            ${statusText(userError)}
            ${statusText(userMessage, 'success')}
            <ul class="user-list" id="userList">
${users.map(renderUserRow).join('\n')}
            </ul>
            <div class="button-row">
              <button type="button" class="secondary-button" id="userEditBtn" onclick="editSelectedUser()" disabled>Bearbeiten</button>
              <button type="button" onclick="openUserDialog('add')">Benutzer hinzufügen</button>
            </div>
          </section>`;

  const body = `        <h1>Einstellungen</h1>

        <div class="settings-tabbar" role="tablist" aria-label="Einstellungsbereiche">
${tabBar}
        </div>

        <div ${panelAttr('allgemein')}>
          <div class="settings-layout">
          <form action="/settings/mqtt" method="POST" class="settings-form mqtt-form settings-card-form">
            <section class="settings-card">
              <div class="settings-card-head">
                <h2>Standort &amp; Zeit</h2>
                <p class="settings-card-hint">Geografische Position und Zeitzone für die spätere Verfeinerung des Clear-Sky-Modells. Diese Werte beeinflussen weder die übermittelte Uhrzeit noch das Datum – die per MQTT empfangenen Zeiten entsprechen bereits der lokalen Ortszeit.</p>
              </div>
              <div class="field-grid">
                <div class="field">
                  <label for="latitude">Geografischer Breitengrad</label>
                  <input type="number" step="0.000001" id="latitude" name="latitude" placeholder="z.B. 52.520008" value="${escapeHtml(mqtt.latitude)}">
                </div>
                <div class="field">
                  <label for="longitude">Geografischer Längengrad</label>
                  <input type="number" step="0.000001" id="longitude" name="longitude" placeholder="z.B. 13.404954" value="${escapeHtml(mqtt.longitude)}">
                </div>
                <div class="field">
                  <label for="timezone">Zeitzone</label>
                  <select id="timezone" name="timezone">
                    ${renderTimezoneOptions(mqtt.timezone)}
                  </select>
                </div>
              </div>
              <label class="checkbox-field" for="dstEnabled">
                <input type="checkbox" id="dstEnabled" name="dstEnabled" value="1"${dstChecked}>
                <span>Automatische Zeitumstellung (Sommer-/Winterzeit) aktivieren</span>
              </label>
            </section>

            <section class="settings-card">
              <div class="settings-card-head">
                <h2>MQTT Verbindung</h2>
                <p class="settings-card-hint">Verbindungsdaten zum MQTT-Broker.</p>
              </div>
              <div class="field-grid">
                <div class="field">
                  <label for="mqttHost">Broker Host</label>
                  <input type="text" id="mqttHost" name="host" placeholder="z.B. localhost" value="${escapeHtml(mqtt.host)}" required>
                </div>
                <div class="field">
                  <label for="mqttPort">Port</label>
                  <input type="number" id="mqttPort" name="port" placeholder="1883" value="${escapeHtml(mqtt.port)}" required>
                </div>
                <div class="field">
                  <label for="mqttUser">Benutzername</label>
                  <input type="text" id="mqttUser" name="username" placeholder="optional" value="${escapeHtml(mqtt.username)}">
                </div>
                <div class="field">
                  <label for="mqttPass">Passwort</label>
                  <input type="password" id="mqttPass" name="password" placeholder="optional" value="${escapeHtml(mqtt.password)}">
                </div>
              </div>
            </section>

            <section class="settings-card">
              <div class="settings-card-head">
                <h2>MQTT Topics</h2>
                <p class="settings-card-hint">Quell-Topics für Umgebungswerte.</p>
              </div>
              <div class="field">
                <label for="outdoorTemperatureTopic">Topic Aussentemperatur</label>
                <input type="text" id="outdoorTemperatureTopic" name="outdoorTemperatureTopic" placeholder="z.B. weather.0.outdoorTemp" value="${escapeHtml(mqtt.outdoorTemperatureTopic)}">
              </div>
              <div class="field">
                <label for="clockTimeTopic">Topic Uhrzeit</label>
                <input type="text" id="clockTimeTopic" name="clockTimeTopic" placeholder="z.B. system.0.timeText" value="${escapeHtml(mqtt.clockTimeTopic)}">
              </div>
              <div class="field">
                <label for="clockDateTopic">Topic Datum</label>
                <input type="text" id="clockDateTopic" name="clockDateTopic" placeholder="z.B. system.0.dateText" value="${escapeHtml(mqtt.clockDateTopic)}">
              </div>
            </section>

            <section class="settings-card">
              <div class="button-row">
                <button type="submit">Einstellungen speichern</button>
                <button type="button" class="button-secondary" onclick="testMqtt()">MQTT-Verbindung testen</button>
              </div>
              ${mqttMessage ? `<p class="settings-card-hint settings-card-hint-strong">${escapeHtml(mqttMessage)}</p>` : ''}
              <label for="mqttLog">MQTT Protokoll</label>
              <textarea id="mqttLog" readonly class="mqtt-log" placeholder="Protokollausgabe">${escapeHtml(mqttMessage)}</textarea>
            </section>
          </form>
          </div>
        </div>

        <div ${panelAttr('benutzer')}>
          <div class="settings-layout">
${userPanel}
          </div>
        </div>

        <div ${panelAttr('module')}>
          <div class="settings-card-head">
            <h2>Module</h2>
          </div>
${modulesPanel({ registry, enabledKeys, message: moduleMessage })}
        </div>

        <div ${panelAttr('fernzugriff')}>
${remote.body}
        </div>

        ${renderUserDialog()}`;

  // Für die clientseitige Vorbelegung des Dialogs beim Bearbeiten.
  const clientUsers = users.map((user) => ({
    id: user.id,
    name: user.name,
    role: user.role,
    isAdmin: user.isAdmin,
    // null (alle Seiten) im Dialog als „alle angehakt" darstellen.
    pages: user.visiblePages == null ? PAGES.map((p) => p.key) : user.visiblePages,
  }));

  const script = `    var settingsUsers = ${JSON.stringify(clientUsers)};
    var allPageKeys = ${JSON.stringify(PAGES.map((p) => p.key))};
    var initialUserDialog = ${userDialogOpen ? JSON.stringify({
      mode: userDialogMode,
      error: userDialogError,
      values: userDialogValues || {},
    }) : 'null'};
    var selectedUserId = null;

    // --- Tab-Umschaltung (client-seitig, ohne Neuladen) ---------------------
    function settingsTab(key) {
      var tabs = document.querySelectorAll('.settings-tab');
      for (var i = 0; i < tabs.length; i++) {
        var active = tabs[i].getAttribute('data-settings-tab') === key;
        tabs[i].classList.toggle('is-active', active);
        tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
      }
      var panels = document.querySelectorAll('.settings-panel');
      for (var p = 0; p < panels.length; p++) {
        panels[p].hidden = panels[p].getAttribute('data-settings-panel') !== key;
      }
      try { history.replaceState(null, '', '/settings?tab=' + key); } catch (_) {}
      try {
        document.dispatchEvent(new CustomEvent('homeess:settings-tab', { detail: { tab: key } }));
      } catch (_) {}
    }

    function findUser(id) {
      for (var i = 0; i < settingsUsers.length; i++) {
        if (settingsUsers[i].id === id) return settingsUsers[i];
      }
      return null;
    }

    function selectUserRow(row) {
      var rows = document.querySelectorAll('.user-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('is-selected');
      row.classList.add('is-selected');
      selectedUserId = Number(row.getAttribute('data-id'));
      var btn = document.getElementById('userEditBtn');
      if (btn) btn.disabled = false;
    }

    function editSelectedUser(id) {
      var userId = id != null ? id : selectedUserId;
      if (userId == null) return;
      openUserDialog('edit', userId);
    }

    // Rolle/Seiten sind für den Administrator gesperrt (immer alle Rechte).
    function applyAdminLock(isAdmin) {
      var roleSelect = document.getElementById('userRole');
      var pageBox = document.getElementById('userPagesBlock');
      var hint = document.getElementById('userAdminHint');
      roleSelect.disabled = !!isAdmin;
      var boxes = document.querySelectorAll('#userPagesBlock input[type="checkbox"]');
      for (var i = 0; i < boxes.length; i++) boxes[i].disabled = !!isAdmin;
      if (pageBox) pageBox.classList.toggle('is-locked', !!isAdmin);
      if (hint) hint.hidden = !isAdmin;
    }

    function setUserPages(pageKeys) {
      var wanted = {};
      (pageKeys || []).forEach(function (key) { wanted[key] = true; });
      var boxes = document.querySelectorAll('#userPagesBlock input[type="checkbox"]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = !!wanted[boxes[i].value];
    }

    function openUserDialog(mode, userId) {
      var dialog = document.getElementById('userDialog');
      if (!dialog) return;
      var form = document.getElementById('userForm');
      var title = document.getElementById('userDialogTitle');
      var passHint = document.getElementById('userPassHint');
      var user = mode === 'edit' ? findUser(userId) : null;
      document.getElementById('userDialogError').innerHTML = '';
      if (mode === 'edit' && user) {
        form.action = '/settings/users/' + user.id;
        title.textContent = 'Benutzer bearbeiten';
        document.getElementById('userName').value = user.name;
        document.getElementById('userRole').value = user.role;
        document.getElementById('userPassword').value = '';
        if (passHint) passHint.hidden = false;
        setUserPages(user.pages);
        applyAdminLock(user.isAdmin);
      } else {
        form.action = '/settings/users';
        title.textContent = 'Benutzer hinzufügen';
        document.getElementById('userName').value = '';
        document.getElementById('userRole').value = 'read';
        document.getElementById('userPassword').value = '';
        if (passHint) passHint.hidden = true;
        setUserPages(allPageKeys);
        applyAdminLock(false);
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeUserDialog() {
      var dialog = document.getElementById('userDialog');
      if (dialog) dialog.close();
    }

    if (initialUserDialog) {
      openUserDialog(initialUserDialog.mode, initialUserDialog.values && initialUserDialog.values.id);
      var v = initialUserDialog.values || {};
      if (v.name != null) document.getElementById('userName').value = v.name;
      if (v.role) document.getElementById('userRole').value = v.role;
      if (v.pages) setUserPages(v.pages);
      if (v.isAdmin != null) applyAdminLock(v.isAdmin);
      if (initialUserDialog.error) {
        var errBox = document.getElementById('userDialogError');
        errBox.innerHTML = '<p class="error-text"></p>';
        errBox.querySelector('.error-text').textContent = initialUserDialog.error;
      }
    }

    async function testMqtt() {
      const payload = {
        host: document.getElementById('mqttHost').value,
        port: document.getElementById('mqttPort').value,
        username: document.getElementById('mqttUser').value,
        password: document.getElementById('mqttPass').value,
        latitude: document.getElementById('latitude').value,
        longitude: document.getElementById('longitude').value,
        timezone: document.getElementById('timezone').value,
        dstEnabled: document.getElementById('dstEnabled').checked,
        outdoorTemperatureTopic: document.getElementById('outdoorTemperatureTopic').value,
        clockTimeTopic: document.getElementById('clockTimeTopic').value,
        clockDateTopic: document.getElementById('clockDateTopic').value,
      };
      const logBox = document.getElementById('mqttLog');
      logBox.value = 'Teste Verbindung...';
      try {
        const resp = await fetch('/settings/mqtt/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        logBox.value = data.message || JSON.stringify(data);
      } catch (e) {
        logBox.value = 'Fehler: ' + e.message;
      }
    }

    // Fernzugriff-Controller (Tab „Fernzugriff"): eigenständige IIFEs, die auf den
    // DOM-Elementen der Fernzugriff-Sektion arbeiten und ihren Status pollen.
${remote.script}`;

  return renderLayout({ title: 'Einstellungen', activePath: '/settings', body, script });
}

// Bearbeiten-/Hinzufügen-Dialog für Benutzer. Name, Passwort (beim Bearbeiten
// optional), Rolle (Choicebox) und die sichtbaren Seiten (Checkboxen). Für den
// Administrator sind Rolle und Seiten gesperrt (immer alle Rechte).
function renderUserDialog() {
  const roleOptions = ROLES
    .map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(ROLE_LABELS[role] || role)}</option>`)
    .join('\n                ');
  const pageChecks = PAGES
    .map(
      (page) => `                <label class="user-page-check">
                  <input type="checkbox" name="pages" value="${escapeHtml(page.key)}">
                  <span>${escapeHtml(page.label)}</span>
                </label>`
    )
    .join('\n');
  return `        <dialog id="userDialog" class="value-dialog">
          <form id="userForm" action="/settings/users" method="POST" class="dialog-form">
            <h3 id="userDialogTitle">Benutzer hinzufügen</h3>
            <div id="userDialogError"></div>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block" for="userName">
                <span>Benutzername</span>
                <input type="text" id="userName" name="name" required maxlength="60" autocomplete="off">
              </label>
              <label class="field-block" for="userPassword">
                <span>Passwort</span>
                <input type="password" id="userPassword" name="password" autocomplete="new-password">
                <small class="muted" id="userPassHint" hidden>Leer lassen, um das bestehende Passwort beizubehalten.</small>
              </label>
              <label class="field-block" for="userRole">
                <span>Rolle</span>
                <select id="userRole" name="role">
                ${roleOptions}
                </select>
                <small class="muted">Lesen: nur ansehen · Bedienen: zusätzlich schalten · Schreiben: Vollzugriff.</small>
              </label>
            </div>
            <div class="field-block" id="userPagesBlock">
              <span>Sichtbare Seiten im Menü</span>
              <small class="muted" id="userAdminHint" hidden>Der Administrator sieht immer alle Seiten.</small>
              <div class="user-page-list">
${pageChecks}
              </div>
            </div>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeUserDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

module.exports = renderSettings;
