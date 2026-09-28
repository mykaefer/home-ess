'use strict';
const i18n = require('../i18n');
const { renderLayout } = require('./layout');
const { escapeHtml: e, statusText } = require('./components');
const { DEFAULTS, CHUNK_SIZES } = require('../speech/config');

module.exports = function renderSpeech({ endpoints, rooms, error, status, settings = DEFAULTS, message = '' }) {
  const body = `<div class="comms-page speech-page">
    <header class="comms-page-head">
      <div><h1>Sprachausgabe</h1><p class="muted">Geräte verwalten und die lokale Sprachwiedergabe einstellen.</p></div>
      <div class="comms-page-actions"><a class="secondary-button" href="/notifications">Nachrichten verwalten</a><a class="secondary-button" href="/speech">Status aktualisieren</a></div>
    </header>
    <div class="comms-summary"><span class="adapter-badge adapter-badge--on">Piper · Thorsten High</span><span>${e(i18n.t('speech.online_count', { count: endpoints.filter((endpoint) => endpoint.active).length }))}</span><span>${e(i18n.t('speech.pending', { count: status.pending }))}</span></div>
    ${statusText(error)}${statusText(message, 'success')}
    ${status.discoveryError ? statusText('Ein Endpunkt konnte nicht gespeichert werden. Datenbank prüfen.') : ''}
    <div class="speech-layout">
      <section aria-labelledby="speechEndpointsHeading" class="speech-endpoints">
        <div class="comms-section-head"><h2 id="speechEndpointsHeading">Audio-Endpunkte</h2><p class="muted">Erkannte Geräte benennen und einem Raum zuordnen.</p></div>
        <div class="speech-endpoint-list">
        ${endpoints.length ? endpoints.map((endpoint) => `<form method="POST" action="/speech/endpoints" class="settings-form panel-card speech-endpoint">
          <input type="hidden" name="deviceId" value="${e(endpoint.device_id)}">
          <header class="comms-card-head"><h3>${e(endpoint.name || endpoint.device_id)}</h3><span class="adapter-badge adapter-badge--${endpoint.active ? 'on' : 'off'}">${endpoint.active ? 'Online' : 'Offline'}</span></header>
          <div class="speech-fields">
            <label class="field-block"><span>Lesbarer Name</span><input name="name" maxlength="120" value="${e(endpoint.name)}"></label>
            <label class="field-block"><span>Raum</span><select name="roomId"><option value="">Ohne Zuordnung</option>${rooms.map((r) => `<option value="${r.id}"${r.id === endpoint.room_id ? ' selected' : ''}>${e(r.name)}</option>`).join('')}</select></label>
          </div>
          <details class="comms-details"><summary>Gerätedetails</summary><dl><dt>Geräte-ID</dt><dd>${e(endpoint.device_id)}</dd><dt>Quelle</dt><dd>${e(endpoint.source)}</dd></dl><p class="muted">${e(i18n.t('speech.last_seen', { time: new Date(endpoint.last_seen).toLocaleString(i18n.current().locale) }))}</p></details>
          <div class="comms-form-actions"><button type="submit">Speichern</button></div>
        </form>`).join('') : '<div class="panel-card comms-empty"><h3>Noch keine Audio-Endpunkte</h3><p class="muted">Noch keine Audio-Endpunkte erkannt. Einen Client am Audiobus anmelden und eine Session starten.</p></div>'}
        </div>
        <p class="muted comms-section-note">Namen und Räume bleiben gespeichert, auch wenn ein Gerät offline ist.</p>
      </section>
      <section aria-labelledby="speechSettingsHeading" class="speech-settings">
        <div class="comms-section-head"><h2 id="speechSettingsHeading">Wiedergabeeinstellungen</h2><p class="muted">Gilt ab der nächsten Ansage.</p></div>
        <form method="POST" action="/speech/settings" class="settings-form panel-card speech-settings-form">
          <div class="speech-fields">
            <label class="field-block"><span>Pegel (%)</span><input required type="number" name="volumePercent" min="10" max="100" step="1" value="${e(settings.volumePercent)}"><small class="form-hint">10–100 % · Standard 70 %</small></label>
            <label class="field-block"><span>Audiovorlauf (ms)</span><input required type="number" name="leadMs" min="100" max="5000" step="1" value="${e(settings.leadMs)}"><small class="form-hint">100–5000 ms · Standard 1000 ms</small></label>
            <label class="field-block"><span>Nachlauf (ms)</span><input required type="number" name="tailMs" min="0" max="5000" step="1" value="${e(settings.tailMs)}"><small class="form-hint">0–5000 ms · Standard 1000 ms</small></label>
            <label class="field-block"><span>Paketdauer (ms)</span><select name="chunkMs">${CHUNK_SIZES.map((size) => `<option value="${size}"${Number(settings.chunkMs) === size ? ' selected' : ''}>${size}</option>`).join('')}</select><small class="form-hint">Standard 50 ms</small></label>
          </div>
          <details class="comms-details"><summary>Hinweise zur Wiedergabe</summary><p class="muted">So viel Audio sendet homeESS voraus. Standard: 1000 ms. Der Wiedergabepuffer des Clients wird damit nicht eingestellt.</p><p class="muted">Zusätzliche Wartezeit vor dem Stream-Ende. Standard: 1000 ms. Hilft bei abgeschnittenen Enden, nicht bei Knacksern zwischen Wörtern.</p><p class="muted">Standard: 50 ms. Kleinere Pakete erhöhen die Anzahl der Übertragungen. Zum Hörvergleich den Testversand einer Nachricht verwenden.</p></details>
          <div class="comms-form-actions"><button type="submit">Speichern</button></div>
        </form>
        <details class="comms-details speech-info"><summary>Über die lokale Sprachausgabe</summary><p class="muted">Lokale CPU-TTS: Piper mit der deutschen Stimme Thorsten High. Die Installer richten Piper und das Sprachmodell automatisch ein. Nachrichten verlassen für die Sprachausgabe das lokale System nicht.</p><p class="muted">Aktive Audiobus-Sessions werden automatisch erkannt. Namen und Raumzuordnungen bleiben gespeichert. Die Raumliste wird gemeinsam mit Heizung &amp; Klima und Messen + Schalten verwendet.</p></details>
      </section>
    </div>
  </div>`;
  return renderLayout({ title: 'Sprachausgabe', activePath: '/speech', body });
};
