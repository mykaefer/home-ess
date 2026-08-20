'use strict';

// Verwaltungsseite des Zigbee-Adapters.
//
// Anmeldung, Rollenprüfung, Seitenlayout und Uploadgrenzen bleiben Aufgabe von
// homeESS. Der Adapter liefert nur Inhalt und beantwortet seine eigenen
// Aktionen — und prüft die Rechte dabei serverseitig noch einmal selbst.

const coordinatorLib = require('./coordinator');
const networkLib = require('./network');
const mapView = require('./map-view');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('de-DE');
}

function relativeAge(value) {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 90) return `vor ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `vor ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `vor ${hours} h`;
  return `vor ${Math.round(hours / 24)} Tagen`;
}

function availabilityBadge(available) {
  if (available === null || available === undefined) {
    return '<span class="zb-badge zb-badge--unknown">unbekannt</span>';
  }
  return available
    ? '<span class="zb-badge zb-badge--ok">erreichbar</span>'
    : '<span class="zb-badge zb-badge--off">nicht erreichbar</span>';
}

function renderStatus(status) {
  const rows = [];
  rows.push(['Verbindung', status.connected
    ? '<span class="zb-badge zb-badge--ok">verbunden</span>'
    : '<span class="zb-badge zb-badge--off">getrennt</span>']);
  rows.push(['Netzwerkstatus', escapeHtml(status.networkState)]);
  rows.push(['Anbindung', status.transport ? escapeHtml(status.transport.label) : '—']);
  if (status.coordinator) {
    const driver = coordinatorLib.DRIVERS[status.coordinator.type];
    rows.push(['Adapter-Typ', escapeHtml(driver ? driver.label : status.coordinator.type)]);
    rows.push(['Firmware', escapeHtml(`${status.coordinator.firmware.product} ${status.coordinator.firmware.version}`
      + ` (Rev. ${status.coordinator.firmware.revision}, Transport ${status.coordinator.firmware.transportRevision})`)]);
    rows.push(['Coordinator-IEEE', `<code>${escapeHtml(status.coordinator.ieeeAddress)}</code>`]);
  }
  if (status.network) {
    rows.push(['PAN-ID', `<code>${escapeHtml(status.network.panIdHex)}</code>`]);
    rows.push(['Extended PAN-ID', `<code>${escapeHtml(status.network.extendedPanId || '—')}</code>`]);
    rows.push(['Kanal', escapeHtml(String(status.network.channel))]);
  }
  rows.push(['Geräte', `${status.devicesOnline} von ${status.deviceCount} erreichbar`]);
  if (status.lastError) rows.push(['Letzter Fehler', `<span class="zb-error">${escapeHtml(status.lastError)}</span>`]);

  return `<div class="zb-status">${rows.map(([label, value]) => `
    <div class="zb-status-item"><span class="zb-status-label">${escapeHtml(label)}</span><span>${value}</span></div>`).join('')}</div>`;
}

function renderDevices(devices, access) {
  if (!devices.length) {
    return `<p class="zb-note">Noch kein Zigbee-Gerät bekannt. Oben das Anlernen starten und das Gerät in seinen
      Anlernmodus bringen — bei den meisten Geräten durch mehrsekündiges Drücken der Reset-Taste.</p>`;
  }
  const hinweis = access.canWrite
    ? `<p class="zb-note">Ein eigener Name ist reiner Anzeigetext: Die State-Adressen folgen der IEEE-Adresse und
       bleiben beim Umbenennen unverändert — eingetragene Topics gelten also weiter. Ein leeres Feld stellt den
       Standardnamen wieder her.</p>`
    : '';
  // data-label trägt auf dem Telefon die Spaltenüberschrift vor den Wert;
  // dort wird aus der Tabelle eine Kartenliste (siehe management.css).
  const rows = devices.map((device) => `
    <tr>
      <td>
        <strong>${escapeHtml(device.friendlyName)}</strong><br>
        <code class="zb-dim">${escapeHtml(device.ieeeAddress)}</code>
      </td>
      <td data-label="Modell">
        ${device.unidentified
    ? `<span class="zb-badge zb-badge--unknown">nicht identifiziert</span><br>
           <span class="zb-dim">hat sich nie gemeldet</span>`
    : `${escapeHtml(device.manufacturer || '—')} ${escapeHtml(device.model || '')}<br>
           <span class="zb-dim">${escapeHtml(device.zigbeeModel || '')}${device.generated ? ' · automatisch erzeugt' : ''}</span>`}
      </td>
      <td data-label="Typ">${escapeHtml(device.deviceType)} · <span class="zb-dim">${escapeHtml(device.powerSource || '—')}</span></td>
      <td data-label="Batterie">${device.battery == null ? '—' : `${escapeHtml(String(device.battery))} %`}</td>
      <td data-label="LQI">${device.linkquality == null ? '—' : escapeHtml(String(device.linkquality))}</td>
      <td data-label="Zuletzt gesehen">${escapeHtml(relativeAge(device.lastSeen))}</td>
      <td data-label="Status">${availabilityBadge(device.available)} <span class="zb-dim">${escapeHtml(device.interviewState)}</span></td>
      <td data-label="Werte">${device.propertyCount}</td>
      <td>${access.canWrite ? `
        <div class="zb-device-actions">
          <input type="text" class="zb-rename-input" value="${escapeHtml(device.customName || '')}"
            placeholder="${escapeHtml(device.friendlyName)}" aria-label="Name für ${escapeHtml(device.friendlyName)}"
            data-rename="${escapeHtml(device.slug)}" maxlength="80">
          <button type="button" class="zb-button zb-button--secondary" data-rename-save="${escapeHtml(device.slug)}">
            Umbenennen</button>
          <button type="button" class="zb-button zb-button--danger" data-remove="${escapeHtml(device.slug)}"
            data-name="${escapeHtml(device.friendlyName)}">Entfernen</button>
        </div>` : ''}</td>
    </tr>`).join('');

  const unbekannt = devices.filter((device) => device.unidentified).length;
  const altlast = unbekannt
    ? `<p class="zb-note zb-note--warn">${unbekannt} Eintrag${unbekannt === 1 ? '' : 'e'} ohne Hersteller und Modell:
       ${unbekannt === 1 ? 'Dieses Gerät hat' : 'Diese Geräte haben'} sich nie gemeldet und
       ${unbekannt === 1 ? 'besitzt' : 'besitzen'} keine auswertbaren Eigenschaften. Solche Einträge stammen meist
       aus der Adressverwaltung des Coordinators — ein abgebrochener Anlernversuch oder ein längst entferntes
       Gerät — und lassen sich gefahrlos entfernen. Entfernte Einträge werden bei einer Geräteübernahme nicht
       erneut angelegt.</p>`
    : '';
  return `${hinweis}${altlast}<div class="zb-table-wrap"><table class="zb-table">
    <thead><tr>
      <th>Gerät</th><th>Modell</th><th>Typ</th><th>Batterie</th><th>LQI</th>
      <th>Zuletzt gesehen</th><th>Status</th><th>Werte</th><th>Name / Aktionen</th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderNetworkPanel(status, config, access) {
  const mode = String(config.networkMode || 'adopt');
  if (mode !== 'create') {
    return `<p class="zb-note zb-note--ok">Der Adapter übernimmt das vorhandene Zigbee-Netz und verändert
      Netzwerkschlüssel, PAN-ID, Extended PAN-ID und Kanal nicht. Angelernte Geräte bleiben erhalten.</p>`;
  }
  if (!access.isAdmin) {
    return `<p class="zb-note zb-note--warn">In den Einstellungen ist „Neues Netzwerk erstellen“ ausgewählt.
      Der Vorgang muss von einem Administrator bestätigt werden und ist bis dahin nicht ausgeführt.</p>`;
  }
  if (status.createConfirmed) {
    return `<p class="zb-note zb-note--warn">Der Neuaufbau ist bestätigt und wird beim nächsten
      Verbindungsaufbau ausgeführt. Um ihn abzubrechen, in den Instanz-Einstellungen wieder
      „Bestehendes Netzwerk übernehmen“ auswählen.</p>`;
  }
  const channels = [];
  for (let channel = coordinatorLib.CHANNEL_MIN; channel <= coordinatorLib.CHANNEL_MAX; channel += 1) {
    channels.push(`<option value="${channel}"${channel === networkLib.DEFAULT_CHANNEL ? ' selected' : ''}>Kanal ${channel}</option>`);
  }
  return `
    <p class="zb-note zb-note--danger"><strong>Achtung:</strong> In den Einstellungen ist „Neues Netzwerk erstellen“
      ausgewählt. Damit werden Netzwerkschlüssel, PAN-ID und Extended PAN-ID neu erzeugt. <strong>Alle bisher
      angelernten Geräte verlieren die Verbindung und müssen einzeln neu angelernt werden.</strong>
      Solange die Bestätigung fehlt, bleibt das vorhandene Netz unverändert und der Adapter startet nicht.</p>
    <div class="zb-row">
      <label>Kanal <select id="zbCreateChannel">${channels.join('')}</select></label>
      <label class="zb-confirm">
        <input type="checkbox" id="zbCreateAck">
        Ich habe verstanden, dass alle Geräte neu angelernt werden müssen.
      </label>
      <button type="button" class="zb-button zb-button--danger" id="zbCreateConfirm" disabled>
        Neues Netzwerk erstellen
      </button>
    </div>`;
}

function renderBackupPanel(status, access) {
  const backup = status.backup;
  let current;
  if (!backup) {
    current = '<p class="zb-note">Es liegt noch kein Coordinator-Backup vor. Es entsteht automatisch, sobald der Adapter verbunden ist.</p>';
  } else if (backup.error) {
    current = `<p class="zb-note zb-note--warn">Das gespeicherte Backup ist nicht lesbar: ${escapeHtml(backup.error)}</p>`;
  } else {
    current = `<p class="zb-note">Gespeichertes Backup vom ${escapeHtml(formatTime(backup.modified))}
      (Format ${escapeHtml(backup.format)}${backup.deviceCount == null ? '' : `, ${backup.deviceCount} Geräte`}).</p>`;
  }
  if (!access.canWrite) return current;
  return `${current}
    <div class="zb-row">
      <button type="button" class="zb-button" id="zbBackupNow">Backup jetzt erstellen</button>
      <label class="zb-upload">
        <input type="file" id="zbBackupFile" accept="application/json,.json">
        <span>Coordinator-Backup einspielen</span>
      </label>
    </div>
    <p class="zb-note">Zum Übernehmen eines vorhandenen Zigbee2MQTT-Netzes dessen <code>coordinator_backup.json</code>
      einspielen. Die Datei wird geprüft und ein vorhandenes Backup vorher gesichert. Sie wird beim nächsten
      Verbindungsaufbau berücksichtigt.</p>
    <div class="zb-row">
      <label class="zb-upload">
        <input type="file" id="zbDatabaseFile" accept=".db,application/json,text/plain">
        <span>Gerätedatenbank einspielen</span>
      </label>
    </div>
    <p class="zb-note">Zusätzlich lässt sich das <code>database.db</code> von Zigbee2MQTT übernehmen. Es enthält
      Modelle, Endpunkte und Interviewstand der Geräte; damit entfällt das erneute Abfragen. Der Coordinator muss
      dafür getrennt sein — die Datei wird beim nächsten Verbindungsaufbau geladen.</p>`;
}

function renderAdoptPanel(status, access) {
  // Nach dem Übernehmen eines bestehenden Netzes stimmen die Funkparameter,
  // die Geräte sind der Zigbee-Bibliothek aber noch unbekannt. Erst dieser
  // Schritt macht sie nutzbar — ohne sie neu anzulernen.
  if (!status.adoptableDevices) {
    return `<p class="zb-note">Alle im Coordinator-Backup verzeichneten Geräte sind bereits übernommen.</p>`;
  }
  const count = status.adoptableDevices;
  return `
    <p class="zb-note zb-note--warn">Der Coordinator kennt ${count} Gerät${count === 1 ? '' : 'e'},
      ${count === 1 ? 'das' : 'die'} in homeESS noch nicht angelegt ${count === 1 ? 'ist' : 'sind'}.
      Beim Übernehmen eines bestehenden Netzes ist das der Normalfall: Netzwerkschlüssel und PAN-ID stimmen,
      die Geräte funken also weiter — die Zigbee-Bibliothek führt ihre Gerätedaten aber in einer eigenen
      Datenbank. Die Übernahme legt sie daraus an und fragt ihre Eigenschaften ab.
      <strong>Ein erneutes Anlernen ist dafür nicht nötig.</strong></p>
    ${access.canWrite ? `<div class="zb-row">
      <button type="button" class="zb-button" id="zbAdoptDevices"${status.connected ? '' : ' disabled'}>
        ${count} Gerät${count === 1 ? '' : 'e'} übernehmen
      </button>
      <button type="button" class="zb-button zb-button--secondary" id="zbInterviewPending"${status.connected ? '' : ' disabled'}>
        Offene Interviews wiederholen
      </button>
    </div>
    <p class="zb-note">Batteriebetriebene Geräte antworten erst, wenn sie aufwachen. Sie erscheinen zunächst mit
      dem Interviewstatus „ausstehend“ und vervollständigen sich später von selbst; ein Tastendruck am Gerät
      beschleunigt das.</p>` : ''}`;
}

/**
 * Verweis auf die Netzwerkkarte. Sie hat eine eigene Seite, weil sie den ganzen
 * verfügbaren Platz braucht — zwischen Statuszahlen und Gerätetabelle bliebe
 * von ihr zu wenig übrig, und die Verwaltungsseite würde unübersichtlich.
 */
function renderMapLink(map, basePath) {
  const knoten = map ? map.nodes.length : 0;
  const kanten = map ? map.edges.length : 0;
  const laeuft = !!(map && map.progress && map.progress.running);
  let stand;
  if (laeuft) {
    stand = `Der Topologiescan läuft (${map.progress.current || 0} von ${map.progress.total || '?'} Knoten).`;
  } else if (map && map.scannedAt) {
    stand = `${kanten} Funkstrecke${kanten === 1 ? '' : 'n'} zwischen ${knoten} Geräten, `
      + `ermittelt am ${formatTime(map.scannedAt)}.`;
  } else {
    stand = `${knoten} Gerät${knoten === 1 ? '' : 'e'}; die Funkstrecken werden ermittelt, sobald das Netz steht.`;
  }
  // Bewusst ganz oben und als Kachel: Die Karte ist die Gerätesicht des
  // Adapters und tritt an die Stelle der früheren generischen Geräteseite.
  return `
    <a class="zb-map-teaser" href="${escapeHtml(basePath)}/map">
      <span class="zb-map-teaser-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="2.6"/><circle cx="4.5" cy="6" r="2.2"/><circle cx="19.5" cy="6" r="2.2"/>
          <circle cx="5.5" cy="19" r="2.2"/><circle cx="18.5" cy="18" r="2.2"/>
          <path d="M6.4 7.4 10 10.4M17.6 7.4 14 10.4M7.2 17.6 10.4 13.8M16.7 16.4 13.7 13.6"/>
        </svg>
      </span>
      <span class="zb-map-teaser-text">
        <strong>Netzwerkkarte öffnen</strong>
        <span class="zb-dim">${escapeHtml(stand)}</span>
      </span>
      <span class="zb-map-teaser-arrow" aria-hidden="true">→</span>
    </a>`;
}

function buildView({ status, devices, map, config, access, basePath, instanceName }) {
  const permit = status.permitJoin;
  const permitPanel = access.canOperate ? `
    <div class="zb-row">
      <button type="button" class="zb-button" id="zbPermitStart"${status.connected ? '' : ' disabled'}>
        Anlernen starten
      </button>
      <button type="button" class="zb-button zb-button--secondary" id="zbPermitStop"${permit.active ? '' : ' disabled'}>
        Anlernen beenden
      </button>
      <span id="zbPermitState" class="zb-permit">${permit.active
    ? `Anlernen aktiv – noch ${permit.remaining} s`
    : 'Anlernen ist geschlossen'}</span>
    </div>
    <p class="zb-note">Das Anlernfenster schließt sich immer von selbst (Einstellung: ${escapeHtml(String(config.permitJoinSeconds || 120))} s).
      Ein dauerhaft offenes Zigbee-Netz ist nicht möglich.</p>`
    : '<p class="zb-note">Zum Anlernen von Geräten fehlt die Berechtigung.</p>';

  const body = `
<section class="zigbee">
  <h1>Zigbee-Netzwerk – ${escapeHtml(instanceName)}</h1>

  ${renderMapLink(map, basePath)}

  <h2>Status</h2>
  ${renderStatus(status)}
  ${access.canWrite ? `<div class="zb-row">
    <button type="button" class="zb-button zb-button--secondary" id="zbReconnect">Neu verbinden</button>
  </div>` : ''}

  <h2>Zigbee-Netz</h2>
  ${renderNetworkPanel(status, config, access)}

  <h2>Geräte anlernen</h2>
  ${permitPanel}

  <h2>Bestehendes Netz übernehmen</h2>
  ${renderAdoptPanel(status, access)}

  <h2>Geräte (${devices.length})</h2>
  ${renderDevices(devices, access)}

  <h2>Backup und Übernahme</h2>
  ${renderBackupPanel(status, access)}
</section>`;

  const script = `(function () {
  var base = ${JSON.stringify(basePath)};
  function send(path, payload, method) {
    return fetch(base + path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || 'Aktion fehlgeschlagen.');
        return data;
      });
    });
  }
  function bind(id, handler) {
    var element = document.getElementById(id);
    if (element) element.addEventListener('click', handler);
  }
  bind('zbReconnect', function () { send('/reconnect').then(function () { location.reload(); })
    .catch(function (error) { alert(error.message); }); });
  bind('zbPermitStart', function () { send('/permit-join', { enabled: true }).then(function () { location.reload(); })
    .catch(function (error) { alert(error.message); }); });
  bind('zbPermitStop', function () { send('/permit-join', { enabled: false }).then(function () { location.reload(); })
    .catch(function (error) { alert(error.message); }); });
  bind('zbBackupNow', function () { send('/backup').then(function () { location.reload(); })
    .catch(function (error) { alert(error.message); }); });
  bind('zbAdoptDevices', function () {
    var button = document.getElementById('zbAdoptDevices');
    button.disabled = true;
    button.textContent = 'Uebernahme laeuft ...';
    send('/devices/adopt').then(function (data) {
      alert('Uebernommen: ' + data.added + ' Geraete. Bereits bekannt: ' + data.known
        + (data.failed ? '. Fehlgeschlagen: ' + data.failed : ''));
      location.reload();
    }).catch(function (error) { button.disabled = false; alert(error.message); });
  });
  bind('zbInterviewPending', function () {
    var button = document.getElementById('zbInterviewPending');
    button.disabled = true;
    send('/devices/interview').then(function (data) {
      alert('Interviews: ' + data.interviewed + ' erfolgreich, ' + data.failed + ' ohne Antwort.');
      location.reload();
    }).catch(function (error) { button.disabled = false; alert(error.message); });
  });

  var ack = document.getElementById('zbCreateAck');
  var confirmButton = document.getElementById('zbCreateConfirm');
  if (ack && confirmButton) {
    ack.addEventListener('change', function () { confirmButton.disabled = !ack.checked; });
    confirmButton.addEventListener('click', function () {
      var channel = document.getElementById('zbCreateChannel').value;
      if (!window.confirm('Wirklich ein neues Zigbee-Netz erstellen? Alle Geraete muessen danach neu angelernt werden.')) return;
      send('/network/create', { channel: Number(channel), confirm: true })
        .then(function () { location.reload(); })
        .catch(function (error) { alert(error.message); });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-rename-save]'), function (button) {
    var slug = button.getAttribute('data-rename-save');
    var feld = document.querySelector('[data-rename="' + slug + '"]');
    button.addEventListener('click', function () {
      button.disabled = true;
      send('/devices/rename', { device: slug, name: feld ? feld.value : '' })
        .then(function () { location.reload(); })
        .catch(function (error) { button.disabled = false; alert(error.message); });
    });
    if (feld) feld.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); button.click(); }
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-remove]'), function (button) {
    button.addEventListener('click', function () {
      var name = button.getAttribute('data-name');
      if (!window.confirm('Geraet "' + name + '" wirklich aus dem Zigbee-Netz entfernen?')) return;
      button.disabled = true;
      send('/devices/remove', { device: button.getAttribute('data-remove'), force: false })
        .then(function () { location.reload(); })
        .catch(function (error) {
          button.disabled = false;
          if (window.confirm(error.message + '\\n\\nEintrag trotzdem lokal entfernen?')) {
            send('/devices/remove', { device: button.getAttribute('data-remove'), force: true })
              .then(function () { location.reload(); })
              .catch(function (forceError) { alert(forceError.message); });
          }
        });
    });
  });

  var file = document.getElementById('zbBackupFile');
  if (file) file.addEventListener('change', function () {
    var chosen = file.files && file.files[0];
    if (!chosen) return;
    chosen.arrayBuffer().then(function (buffer) {
      return fetch(base + '/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Filename': chosen.name, Accept: 'application/json' },
        body: buffer,
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || 'Import fehlgeschlagen.');
        location.reload();
      });
    }).catch(function (error) { alert(error.message); });
  });

  var database = document.getElementById('zbDatabaseFile');
  if (database) database.addEventListener('change', function () {
    var chosen = database.files && database.files[0];
    if (!chosen) return;
    chosen.arrayBuffer().then(function (buffer) {
      return fetch(base + '/database/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Filename': chosen.name, Accept: 'application/json' },
        body: buffer,
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || 'Import fehlgeschlagen.');
        location.reload();
      });
    }).catch(function (error) { alert(error.message); });
  });

  var permitState = document.getElementById('zbPermitState');
  if (permitState && ${permit.active ? 'true' : 'false'}) {
    var remaining = ${permit.remaining};
    var ticker = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(ticker); location.reload(); return; }
      permitState.textContent = 'Anlernen aktiv – noch ' + remaining + ' s';
    }, 1000);
  }
}());`;

  return { title: `Zigbee-Netzwerk – ${instanceName}`, body, script };
}

/**
 * Eigenständige Seite der Netzwerkkarte.
 */
function buildMapView({ map, status, access, basePath, instanceName }) {
  const body = `
<section class="zigbee zigbee--map">
  <div class="zb-page-head">
    <a class="zb-back" href="${escapeHtml(basePath)}">← Zigbee-Netzwerk</a>
    <h1>Netzwerkkarte – ${escapeHtml(instanceName)}</h1>
  </div>
  ${status.connected ? '' : `<p class="zb-note zb-note--warn">Der Coordinator ist derzeit nicht verbunden.
    Die Karte zeigt den zuletzt bekannten Stand${status.lastError ? `: ${escapeHtml(status.lastError)}` : '.'}</p>`}
  ${mapView.renderMap(map, access)}
</section>`;
  return {
    title: `Netzwerkkarte – ${instanceName}`,
    body,
    script: mapView.mapScript(map, access, basePath),
  };
}

/**
 * Beantwortet eine Anfrage der Verwaltungsseite.
 */
async function handleRequest(request, context) {
  const { runtime, config, instanceName } = context;
  const access = request.access || {};
  const method = String(request.method || 'GET').toUpperCase();
  const subpath = String(request.path || '/') || '/';
  const body = request.body || {};

  // Die Verwaltung bleibt die Startseite des Adapters.
  if (method === 'GET' && (subpath === '/' || subpath === '' || subpath === '/verwaltung')) {
    if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    return {
      status: 200,
      view: buildView({
        status: runtime.status(),
        devices: runtime.devices(),
        map: typeof runtime.networkMap === 'function' ? runtime.networkMap() : null,
        config,
        access,
        basePath: String(request.basePath || ''),
        instanceName,
      }),
    };
  }

  if (method === 'GET' && subpath === '/status') {
    if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    return { status: 200, json: { status: runtime.status(), devices: runtime.devices() } };
  }

  if (method === 'POST' && subpath === '/permit-join') {
    if (!access.canOperate) return { status: 403, json: { error: 'Zum Anlernen von Geräten fehlt die Berechtigung.' } };
    const result = await runtime.setPermitJoin(body.enabled !== false, body.seconds);
    return { status: 200, json: { ok: true, permitJoin: result } };
  }

  if (method === 'POST' && subpath === '/reconnect') {
    if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    const result = await runtime.reconnectNow();
    return { status: result.connected ? 200 : 503, json: result.connected ? { ok: true } : { error: result.error || 'Verbindung fehlgeschlagen.' } };
  }

  if (method === 'POST' && subpath === '/devices/remove') {
    if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    const result = await runtime.removeDevice(String(body.device || ''), { force: body.force === true });
    return { status: 200, json: { ok: true, ...result } };
  }

  if (method === 'POST' && subpath === '/network/create') {
    // Ein Netzneuaufbau entwertet das gesamte bestehende Zigbee-Netz. Diese
    // Aktion bleibt deshalb Administratoren vorbehalten.
    if (!access.isAdmin) {
      return { status: 403, json: { error: 'Nur Administratoren dürfen ein neues Zigbee-Netz erstellen.' } };
    }
    if (body.confirm !== true) {
      return { status: 400, json: { error: 'Die Bestätigung fehlt.' } };
    }
    if (String(config.networkMode || 'adopt') !== 'create') {
      return { status: 409, json: {
        error: 'In den Instanz-Einstellungen ist „Bestehendes Netzwerk übernehmen“ ausgewählt. '
          + 'Ein neues Netz wird nur erstellt, wenn beides übereinstimmt.',
      } };
    }
    runtime.confirmNetworkCreation(body.channel);
    const result = await runtime.reconnectNow();
    return { status: 200, json: { ok: true, connected: result.connected, error: result.error || '' } };
  }

  // Die Netzwerkkarte ersetzt die frühere generische Geräteseite: Sie zeigt die
  // Geräte samt ihrer Funkstrecken, ihres Zustands und ihrer Gattung.
  if (method === 'GET' && (subpath === '/map' || subpath === '/map/')) {
    if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    if (typeof runtime.networkMap !== 'function') {
      return { status: 404, json: { error: 'Die Netzwerkkarte ist nicht verfügbar.' } };
    }
    return {
      status: 200,
      view: buildMapView({
        map: runtime.networkMap(),
        status: runtime.status(),
        access,
        basePath: String(request.basePath || ''),
        instanceName,
      }),
    };
  }

  if (method === 'GET' && subpath === '/topology') {
    if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    return { status: 200, json: runtime.networkMap() };
  }

  if (method === 'POST' && subpath === '/topology/scan') {
    // Der Scan fragt jeden Router nach seiner Nachbartabelle und erzeugt damit
    // Funkverkehr im gesamten Netz. Das ist eine bewusste Aktion, keine Anzeige.
    if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    const result = await runtime.scanTopology();
    return { status: 200, json: {
      ok: true,
      edges: result.edges.length,
      nodes: result.nodes.length,
      unreachable: result.unreachable.length,
      scannedAt: result.scannedAt,
    } };
  }

  if (method === 'GET' && subpath === '/topology/progress') {
    if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    return { status: 200, json: runtime.topologyProgress() || { running: false } };
  }

  if (method === 'POST' && subpath === '/devices/write') {
    // Schalten von der Karte aus. Bedienrechte genügen — es ist dieselbe
    // Handlung wie ein Schaltwidget, keine Konfigurationsänderung.
    if (!access.canOperate) return { status: 403, json: { error: 'Zum Schalten fehlt die Berechtigung.' } };
    const device = String(body.device || '').trim();
    const property = String(body.property || '').trim();
    if (!device || !property) return { status: 400, json: { error: 'Gerät oder Eigenschaft fehlt.' } };
    const state = await runtime.writeProperty(device, property, body.value);
    return { status: 200, json: { ok: true, state } };
  }

  if (method === 'POST' && subpath === '/devices/rename') {
    if (!access.canWrite) return { status: 403, json: { error: 'Zum Umbenennen fehlt die Berechtigung.' } };
    const device = String(body.device || '').trim();
    if (!device) return { status: 400, json: { error: 'Gerät fehlt.' } };
    const result = await runtime.renameDevice(device, body.name);
    return { status: 200, json: { ok: true, ...result } };
  }

  if (method === 'POST' && subpath === '/devices/adopt') {
    if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    const result = await runtime.adoptDevicesFromBackup();
    return { status: 200, json: { ok: true, ...result } };
  }

  if (method === 'POST' && subpath === '/devices/interview') {
    if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    const result = await runtime.interviewPendingDevices();
    return { status: 200, json: { ok: true, ...result } };
  }

  if (method === 'POST' && subpath === '/database/import') {
    if (!access.isAdmin) {
      return { status: 403, json: { error: 'Nur Administratoren dürfen eine Gerätedatenbank einspielen.' } };
    }
    if (!request.upload || !request.upload.path) {
      return { status: 400, json: { error: 'Es wurde keine Datei übertragen.' } };
    }
    const info = runtime.importDeviceDatabaseFile(request.upload.path);
    return { status: 200, json: { ok: true, database: info } };
  }

  if (method === 'POST' && subpath === '/backup') {
    if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
    const info = await runtime.createBackup();
    return { status: 200, json: { ok: true, backup: info } };
  }

  if (method === 'POST' && subpath === '/backup/import') {
    if (!access.isAdmin) {
      return { status: 403, json: { error: 'Nur Administratoren dürfen ein Coordinator-Backup einspielen.' } };
    }
    if (!request.upload || !request.upload.path) {
      return { status: 400, json: { error: 'Es wurde keine Datei übertragen.' } };
    }
    const info = runtime.importBackupFile(request.upload.path);
    return { status: 200, json: { ok: true, backup: info } };
  }

  return { status: 404, json: { error: 'Unbekannte Aktion.' } };
}

module.exports = { handleRequest, buildView, buildMapView, renderMapLink, escapeHtml, relativeAge, formatTime };
