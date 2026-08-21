'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { PAGES, ROLES, ROLE_LABELS } = require('../auth/access');
const { modulesPanel } = require('./modules');
const { remoteAccessPanel } = require('./remote-access');
const { INTERVAL_LABELS } = require('../update/settings');
const i18n = require('../i18n');

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
  timeStatus = null,
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
  updateConfig = {
    automaticEnabled: false,
    maintenanceStart: '03:00',
    maintenanceEnd: '04:00',
    checkInterval: 'daily',
  },
  updateStatus = null,
  updateMessage = '',
  database = null,
  databaseStatus = null,
  databaseMessage = '',
  databaseError = '',
  languages = [],
  currentLanguage = { code: 'de' },
  languageMessage = '',
  languageError = '',
  activeTab = 'allgemein',
} = {}) {
  const locale = i18n.current().locale;
  const dstChecked = mqtt.dstEnabled === undefined || mqtt.dstEnabled ? ' checked' : '';
  const currentTab = SETTINGS_TAB_KEYS.has(activeTab) ? activeTab : 'allgemein';
  const remote = remoteAccessPanel();
  const clock = timeStatus || {
    local: { time: '--:--:--', date: '--.--.----' },
    internal: { time: '--:--:--', date: '--.--.----' },
    mqtt: { available: false, fresh: false, display: '' }, offsetSeconds: 0,
  };
  const update = updateStatus || { currentVersion: '—', availableVersion: null, checkedAt: null, nextCheckAt: null, checkError: null, supported: false };
  const dbConfig = database || { enabled: 0, protocol: 'http', host: '', port: 8086, database: 'homeess', username: '', password: '', verifyTls: 1, sourceLabel: '', updatedAt: 0 };
  const dbStatus = databaseStatus || { ok: false, checkedAt: 0, message: '' };
  const automaticChecked = updateConfig.automaticEnabled ? ' checked' : '';
  const intervalOptions = Object.entries(INTERVAL_LABELS)
    .map(([value, label]) => `<option value="${value}"${updateConfig.checkInterval === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

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
                <p class="settings-card-hint">Die Systemuhr ist die dauerhaft laufende Primärquelle. Eine konfigurierte MQTT-Uhrzeit korrigiert sie über einen gleitenden mittleren Versatz. Zeitzone und automatische Sommer-/Winterzeit gelten für die interne homeESS-Zeit.</p>
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
              <div class="time-source-status" id="timeSourceStatus">
                <div><span>Lokale Systemzeit</span><strong id="localSystemTime">${escapeHtml(`${i18n.formatDate(clock.local.date)} ${clock.local.time}`)}</strong></div>
                <div><span>Interne homeESS-Zeit</span><strong id="internalHomeessTime">${escapeHtml(`${i18n.formatDate(clock.internal.date)} ${clock.internal.time}`)}</strong></div>
                <div><span>MQTT-Abgleich</span><strong id="mqttTimeStatus">${escapeHtml(clock.mqtt.available ? `${clock.mqtt.fresh ? 'aktiv' : 'zuletzt'} · ${clock.mqtt.display} · Versatz ${Number(clock.offsetSeconds).toFixed(2).replace('.', ',')} s` : 'nicht vorhanden · Versatz 0,00 s')}</strong></div>
              </div>
            </section>

            <section class="settings-card language-settings-card">
              <div class="settings-card-head">
                <h2>Sprache</h2>
                <p class="settings-card-hint">Die gewählte Sprache gilt systemweit und wird von mehrsprachigen Adaptern übernommen. Fehlende Texte fallen abhängig vom Standort auf Deutsch oder Englisch zurück.</p>
              </div>
              ${statusText(languageError)}
              ${statusText(languageMessage, 'success')}
              <div class="field-grid">
                <div class="field">
                  <label for="systemLanguage">Installierte Sprache</label>
                  <select id="systemLanguage" name="language">
                    ${languages.map((language) => `<option value="${escapeHtml(language.code)}"${language.code === currentLanguage.code ? ' selected' : ''}>${escapeHtml(language.name)} (${escapeHtml(language.code)})</option>`).join('')}
                  </select>
                </div>
                <div class="field">
                  <label for="languageFile">Neue Sprachdatei</label>
                  <input type="file" id="languageFile" accept="application/json,.json">
                </div>
              </div>
              <p class="settings-card-hint">UTF-8-kodierte JSON-Datei auswählen. Sie wird geprüft und die Sprachliste anschließend neu eingelesen.</p>
              <div class="button-row">
                <button type="submit" formaction="/settings/language" formmethod="POST" formnovalidate>Übernehmen</button>
                <button type="button" class="button-secondary" id="languageUploadButton" onclick="uploadLanguageFile()">Sprachdatei hochladen</button>
              </div>
              <p class="settings-card-hint settings-card-hint-strong" id="languageUploadStatus" aria-live="polite"></p>
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

          <form action="/settings/database" method="POST" class="settings-form settings-card-form database-form">
            <section class="settings-card">
              <div class="settings-card-head">
                <h2>Datenbank</h2>
                <p class="settings-card-hint">Zentrale Zeitreihen-Datenbank für Diagramme und Auswertungen (InfluxDB 1.x). Das kann die Datenbank sein, in die der InfluxDB-Adapter schreibt, oder eine beliebige andere — auch auf einem anderen Server. Auf der Einstellungsseite einer InfluxDB-Adapterinstanz genügt der Knopf „Als Standard-Datenbank für homeESS übernehmen“, um die dortigen Angaben hierher zu kopieren.</p>
              </div>
              ${databaseMessage ? statusText(databaseMessage, 'success') : ''}
              ${databaseError ? statusText(databaseError) : ''}
              <div class="field">
                <label style="display:flex; gap:8px; align-items:center;">
                  <input type="checkbox" id="databaseEnabled" name="enabled" value="1"${dbConfig.enabled ? ' checked' : ''}>
                  Datenbankanbindung verwenden
                </label>
                <p class="settings-card-hint">Ohne Häkchen fragen Diagramme keine Daten ab.</p>
              </div>
              <div class="field-grid">
                <div class="field">
                  <label for="databaseProtocol">Protokoll</label>
                  <select id="databaseProtocol" name="protocol">
                    <option value="http"${dbConfig.protocol === 'https' ? '' : ' selected'}>http</option>
                    <option value="https"${dbConfig.protocol === 'https' ? ' selected' : ''}>https</option>
                  </select>
                </div>
                <div class="field">
                  <label for="databaseHost">Server</label>
                  <input type="text" id="databaseHost" name="host" placeholder="z.B. 127.0.0.1" value="${escapeHtml(dbConfig.host)}">
                </div>
                <div class="field">
                  <label for="databasePort">Port</label>
                  <input type="number" id="databasePort" name="port" placeholder="8086" value="${escapeHtml(dbConfig.port)}">
                </div>
                <div class="field">
                  <label for="databaseName">Datenbank</label>
                  <input type="text" id="databaseName" name="database" placeholder="homeess" value="${escapeHtml(dbConfig.database)}">
                </div>
                <div class="field">
                  <label for="databaseUser">Benutzername</label>
                  <input type="text" id="databaseUser" name="username" placeholder="optional" value="${escapeHtml(dbConfig.username)}">
                </div>
                <div class="field">
                  <label for="databasePassword">Kennwort</label>
                  <input type="password" id="databasePassword" name="password" placeholder="optional" value="${escapeHtml(dbConfig.password)}">
                </div>
              </div>
              <div class="field">
                <label style="display:flex; gap:8px; align-items:center;">
                  <input type="checkbox" id="databaseVerifyTls" name="verifyTls" value="1"${dbConfig.verifyTls ? ' checked' : ''}>
                  TLS-Zertifikat prüfen
                </label>
                <p class="settings-card-hint">Nur bei https. Ausschalten, wenn der Server ein selbst ausgestelltes Zertifikat verwendet.</p>
              </div>
              ${dbConfig.sourceLabel ? `<p class="settings-card-hint">Übernommen aus: <strong>${escapeHtml(dbConfig.sourceLabel)}</strong>${dbConfig.updatedAt ? ` am ${escapeHtml(new Date(dbConfig.updatedAt).toLocaleString(locale))}` : ''}. Spätere Änderungen am Adapter wirken hier erst nach einer erneuten Übernahme.</p>` : ''}
              <div class="button-row">
                <button type="submit">Datenbank speichern</button>
                <button type="button" class="button-secondary" onclick="testDatabase()">Verbindung testen</button>
              </div>
              <p class="settings-card-hint settings-card-hint-strong" id="databaseTestResult" aria-live="polite">${escapeHtml(dbStatus.checkedAt ? dbStatus.message : '')}</p>
            </section>
          </form>

          <form action="/settings/update" method="POST" class="settings-card settings-form update-settings-card">
            <div class="settings-card-head">
              <h2>homeESS-Updates</h2>
              <p class="settings-card-hint">Prüft stabile Releases aus dem offiziellen GitHub-Repository. Die Prüfung läuft eigenständig; die automatische Installation ist davon unabhängig, standardmäßig ausgeschaltet und erfolgt ausschließlich im festgelegten Wartungsfenster.</p>
            </div>
            ${statusText(updateMessage, 'success')}
            <div class="update-settings-versions" aria-live="polite">
              <div><span>Installierte Version</span><strong id="settingsUpdateCurrent">${escapeHtml(update.currentVersion)}</strong></div>
              <div><span>Online verfügbar</span><strong id="settingsUpdateAvailable">${escapeHtml(update.availableVersion || 'Kein neueres Release')}</strong></div>
              <div><span>Letzte Prüfung</span><strong id="settingsUpdateChecked">${escapeHtml(update.checkedAt ? new Date(update.checkedAt).toLocaleString(locale) : 'Noch nicht geprüft')}</strong></div>
              <div><span>Nächste Prüfung</span><strong id="settingsUpdateNext">${escapeHtml(update.nextCheckAt ? new Date(update.nextCheckAt).toLocaleString(locale) : 'Wird geplant …')}</strong></div>
            </div>
            <p class="settings-card-hint settings-update-result" id="settingsUpdateResult">${escapeHtml(update.checkError || '')}</p>
            <div class="field-grid update-check-fields">
              <div class="field">
                <label for="updateCheckInterval">Automatisch auf Updates prüfen</label>
                <select id="updateCheckInterval" name="checkInterval">${intervalOptions}</select>
              </div>
            </div>
            <p class="settings-card-hint">Dieser Abstand gilt unabhängig von der automatischen Installation. Sobald eine neuere Version vorliegt, erscheint der Hinweis in der Kopfzeile. Nach einer fehlgeschlagenen Prüfung wird der nächste Versuch vorgezogen.</p>
            <label class="checkbox-field" for="automaticUpdatesEnabled">
              <input type="checkbox" id="automaticUpdatesEnabled" name="automaticEnabled" value="1"${automaticChecked} onchange="toggleUpdateMaintenanceFields()">
              <span>Gefundene Versionen automatisch im Wartungsfenster installieren</span>
            </label>
            <div class="field-grid update-maintenance-fields" id="updateMaintenanceFields">
              <div class="field">
                <label for="updateMaintenanceStart">Wartungsfenster von</label>
                <input type="time" id="updateMaintenanceStart" name="maintenanceStart" value="${escapeHtml(updateConfig.maintenanceStart)}">
              </div>
              <div class="field">
                <label for="updateMaintenanceEnd">Wartungsfenster bis</label>
                <input type="time" id="updateMaintenanceEnd" name="maintenanceEnd" value="${escapeHtml(updateConfig.maintenanceEnd)}">
              </div>
            </div>
            <p class="settings-card-hint">Das Wartungsfenster legt ausschließlich fest, wann ein bereits gefundenes Update eingespielt werden darf. Es verwendet die oben konfigurierte homeESS-Zeitzone; gleiche Start- und Endzeit bedeutet ganztägig, ein Fenster über Mitternacht ist möglich.</p>
            <div class="button-row update-settings-actions">
              <button type="submit">Updateeinstellungen speichern</button>
              <button type="button" class="button-secondary" id="settingsUpdateCheck" onclick="checkHomeessUpdate()">Jetzt auf Updates prüfen</button>
              <button type="button" id="settingsUpdateNow" data-version="${escapeHtml(update.availableVersion || '')}" onclick="installHomeessUpdate()"${update.availableVersion && update.supported ? '' : ' disabled'}>Jetzt updaten</button>
            </div>
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
    function uploadLanguageFile() {
      var input = document.getElementById('languageFile');
      var button = document.getElementById('languageUploadButton');
      var status = document.getElementById('languageUploadStatus');
      var file = input && input.files && input.files[0];
      if (!file) { if (status) status.textContent = 'Bitte eine JSON-Sprachdatei auswählen.'; return; }
      if (file.size > ${1024 * 1024}) { if (status) status.textContent = 'Die Sprachdatei ist zu groß.'; return; }
      if (button) button.disabled = true;
      file.text().then(function (text) {
        var language;
        try { language = JSON.parse(text); } catch (_) { throw new Error('Die Datei enthält kein gültiges JSON.'); }
        return fetch('/settings/language/upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ filename: file.name, language: language })
        });
      }).then(function (response) {
        return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || 'Sprachdatei konnte nicht installiert werden.'); return body; });
      }).then(function () {
        if (status) status.textContent = 'Sprachdatei wurde installiert.';
        window.setTimeout(function () { window.location.reload(); }, 500);
      }).catch(function (error) {
        if (status) status.textContent = error.message || 'Sprachdatei konnte nicht installiert werden.';
      }).finally(function () { if (button) button.disabled = false; });
    }
    function refreshTimeStatus() {
      function localeDate(value) {
        var match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (!match) return value;
        return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])))
          .toLocaleDateString(document.documentElement.lang || 'de-DE', { timeZone: 'UTC' });
      }
      fetch('/settings/time.json', { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (status) {
          if (!status) return;
          var local = document.getElementById('localSystemTime');
          var internal = document.getElementById('internalHomeessTime');
          var mqtt = document.getElementById('mqttTimeStatus');
          if (local) local.textContent = localeDate(status.local.date) + ' ' + status.local.time;
          if (internal) internal.textContent = localeDate(status.internal.date) + ' ' + status.internal.time;
          if (mqtt) mqtt.textContent = status.mqtt.available
            ? (status.mqtt.fresh ? 'aktiv' : 'zuletzt') + ' · ' + status.mqtt.display + ' · Versatz ' + Number(status.offsetSeconds).toFixed(2).replace('.', ',') + ' s'
            : 'nicht vorhanden · Versatz 0,00 s';
        }).catch(function () {});
    }
    refreshTimeStatus(); setInterval(refreshTimeStatus, 1000);
    function toggleUpdateMaintenanceFields() {
      var enabled = document.getElementById('automaticUpdatesEnabled');
      var fields = document.querySelectorAll('#updateMaintenanceFields input[type="time"]');
      for (var i = 0; i < fields.length; i++) fields[i].disabled = !(enabled && enabled.checked);
      var block = document.getElementById('updateMaintenanceFields');
      if (block) block.classList.toggle('is-disabled', !(enabled && enabled.checked));
    }

    function renderSettingsUpdateStatus(status) {
      if (!status) return;
      var current = document.getElementById('settingsUpdateCurrent');
      var available = document.getElementById('settingsUpdateAvailable');
      var checked = document.getElementById('settingsUpdateChecked');
      var result = document.getElementById('settingsUpdateResult');
      var updateNow = document.getElementById('settingsUpdateNow');
      if (current) current.textContent = status.currentVersion || '—';
      if (available) available.textContent = status.availableVersion || 'Kein neueres Release';
      if (checked) checked.textContent = status.checkedAt ? new Date(status.checkedAt).toLocaleString(document.documentElement.lang || 'de-DE') : 'Noch nicht geprüft';
      var next = document.getElementById('settingsUpdateNext');
      if (next) next.textContent = status.nextCheckAt ? new Date(status.nextCheckAt).toLocaleString(document.documentElement.lang || 'de-DE') : 'Wird geplant …';
      if (result) result.textContent = status.checkError || (status.availableVersion ? 'Eine neue Version ist verfügbar.' : 'homeESS ist aktuell.');
      if (updateNow) {
        updateNow.disabled = !(status.supported && status.availableVersion);
        updateNow.setAttribute('data-version', status.availableVersion || '');
      }
    }

    function checkHomeessUpdate() {
      var button = document.getElementById('settingsUpdateCheck');
      var result = document.getElementById('settingsUpdateResult');
      if (button) button.disabled = true;
      if (result) result.textContent = 'GitHub-Release wird geprüft …';
      var api = window.homeESSUpdate;
      if (!api || typeof api.checkNow !== 'function') return;
      api.checkNow().catch(function (error) {
        if (result) result.textContent = error.message || 'Updateprüfung fehlgeschlagen.';
      }).finally(function () { if (button) button.disabled = false; });
    }

    function installHomeessUpdate() {
      var button = document.getElementById('settingsUpdateNow');
      var version = button && button.getAttribute('data-version');
      if (version && window.homeESSUpdate) window.homeESSUpdate.confirm(version);
    }

    document.addEventListener('homeess:update-status', function (event) { renderSettingsUpdateStatus(event.detail); });
    toggleUpdateMaintenanceFields();
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

    // Verbindungstest der Systemdatenbank mit den aktuell im Formular
    // stehenden Werten — ohne sie vorher speichern zu müssen.
    async function testDatabase() {
      var result = document.getElementById('databaseTestResult');
      result.textContent = 'Teste Verbindung...';
      var payload = {
        protocol: document.getElementById('databaseProtocol').value,
        host: document.getElementById('databaseHost').value,
        port: document.getElementById('databasePort').value,
        database: document.getElementById('databaseName').value,
        username: document.getElementById('databaseUser').value,
        password: document.getElementById('databasePassword').value,
        verifyTls: document.getElementById('databaseVerifyTls').checked,
      };
      try {
        var response = await fetch('/settings/database/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var data = await response.json();
        result.textContent = data.message || 'Unbekanntes Ergebnis.';
      } catch (error) {
        result.textContent = 'Fehler: ' + error.message;
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
