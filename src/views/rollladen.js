'use strict';
const i18n = require('../i18n');
const { displayStatus } = require('../rollladen/status');
const { renderLayout } = require('./layout');
const { escapeHtml: e, statusText } = require('./components');
const directions = [[0, 'Nord'], [45, 'Nordost'], [90, 'Ost'], [135, 'Südost'], [180, 'Süd'], [225, 'Südwest'], [270, 'West'], [315, 'Nordwest']];
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

module.exports = function render({ shutters = [], rooms = [], policies = new Map(), statuses = new Map(), brightness = '— %', error = '', input = null, dialogType = 'shutter' } = {}) {
  const field = (name, label, extra = '') => `<label class="field-block"><span>${label}</span><input name="${name}" ${extra}></label>`;
  const picker = (name, label, writable = false) => field(name, label, `${writable ? 'data-state-picker-writable' : ''} data-state-picker autocomplete="off" placeholder="State auswählen…"`);
  const buttons = id => `<div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('${id}').close()">Abbrechen</button></div>`;
  const visibleRooms = rooms.filter(room => shutters.some(s => s.roomId === room.id));
  const blocks = visibleRooms.map(room => {
    const members = shutters.filter(s => s.roomId === room.id);
    const policy = policies.get(room.id);
    const manual = members.some(s => statuses.get(s.id)?.manual) || policy?.memory.manual;
    return `<section class="adapter-block" data-shutter-room="${room.id}">
      <div class="adapter-block-head"><div class="adapter-block-title"><strong>${e(room.name)}</strong><span data-shutter-mode="${room.id}" class="adapter-badge adapter-badge--${manual ? 'off' : 'on'}">${manual ? 'Manuell' : 'Automatik'}</span><span class="muted">${e(i18n.t('rollladen.brightness_summary', { value: policy?.brightness ?? 50 }))}</span></div><button type="button" class="module-toggle-btn" onclick="openShutterRoom(${room.id})">Dämmerung einstellen</button></div>
      <div class="adapter-rows"><div class="adapter-row shutter-row adapter-row--head"><span>Rollladen</span><span>Position</span><span>Steuerung</span><span></span></div>
      ${members.map(s => {
        const view = displayStatus(statuses.get(s.id));
        const direction = directions.find(([value]) => value === Number(s.orientation));
        return `<div class="adapter-row shutter-row" data-shutter-id="${s.id}"><span class="adapter-col-name"><strong>${e(s.name)}</strong><span class="muted">${e(direction ? i18n.localizeText(direction[1]) : String(s.orientation) + '°')}</span></span>
          <span><span data-shutter-actual>${e(view.actual)}</span><span class="muted shutter-note" data-shutter-planned>${e(view.planned)}</span></span>
          <span><span data-shutter-reason>${e(view.reason)}</span><span class="error-text shutter-note" data-shutter-fault ${view.fault ? '' : 'hidden'}>${e(view.fault)}</span></span>
          <span class="adapter-row-actions"><button type="button" class="module-toggle-btn" onclick="openShutter(${s.id})">Bearbeiten</button><button type="button" class="module-toggle-btn button-danger" onclick="deleteShutter(${s.id})">Entfernen</button></span></div>`;
      }).join('')}</div></section>`;
  }).join('');
  const body = `<div class="panel-head"><div><h1>Rollladensteuerung</h1><p class="muted"><span>Helligkeit aktuell</span> <strong data-shutter-brightness>${e(brightness)}</strong></p></div><div class="dashboard-toolbar"><button type="button" class="secondary-button" onclick="openShutter()">Rollladen hinzufügen</button></div></div>
    ${statusText(input ? '' : error)}
    <div class="adapter-list">${blocks || '<div class="adapter-block"><div class="adapter-row adapter-row--empty"><span class="muted">Noch keine Rollläden angelegt.</span></div></div>'}</div>
    <dialog id="shutterDialog" class="value-dialog"><form id="shutterForm" action="/rollladen/save" method="POST" class="dialog-form">
      <div class="dialog-hero"><div><h3 id="shutterTitle">Rollladen hinzufügen</h3><p class="muted">Kino hat Vorrang vor Fensteröffnung. Manuelle Positionen bleiben für die anschließende Rückkehr gespeichert.</p></div></div>
      <p id="shutterError" class="error-text" hidden></p><input type="hidden" name="id">
      <div class="dialog-section"><h4>Zuordnung</h4><div class="dialog-grid dialog-grid--two">
        ${field('name', 'Name', 'required maxlength="100" data-no-state-picker')}
        <label class="field-block"><span>Raum</span><select name="roomId" id="shutterRoomId" required><option value="">Raum auswählen</option>${rooms.map(r => `<option value="${r.id}">${e(r.name)}</option>`).join('')}</select></label>
        ${field('newRoomName', 'Neuen Raum anlegen (optional)', 'id="shutterNewRoom" maxlength="100" data-no-state-picker placeholder="Raumname"')}
        <label class="field-block"><span>Fensterrichtung (Grad, 0° Nord, 90° Ost)</span><input name="orientation" type="number" min="0" max="359" step="1" list="shutterDirections" required><datalist id="shutterDirections">${directions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</datalist></label>
      </div></div>
      <div class="dialog-section"><h4>Aktor</h4><p class="muted">Hoch und Runter zusammen oder Prozent genügen. Endpositionen nutzen bevorzugt Hoch/Runter, Zwischenpositionen den Prozent-State. Bei HmIP-Aktoren mit SHUTTER_VIRTUAL_RECEIVER auf Kanal 4: dessen LEVEL als Fahrbefehl wählen; die Istposition von Kanal 3 wird automatisch gelesen.</p><div class="dialog-grid dialog-grid--two">
        ${picker('upTopic', 'State Hoch', true)}${field('upValue', 'Befehlswert Hoch', 'data-no-state-picker required')}
        ${picker('downTopic', 'State Runter', true)}${field('downValue', 'Befehlswert Runter', 'data-no-state-picker required')}
        ${picker('positionTopic', 'Prozent-State für Fahrbefehle (schreibbar)', true)}${picker('positionFeedbackTopic', 'Istposition (optional, lesbar)')}
        ${field('travelSeconds', 'Vollständige Fahrzeit (Sekunden)', 'type="number" min="10" max="180" required')}
        <label class="field-block"><span>Abdunkelung bei Sonne</span><span class="range-field shutter-shade-range"><span>Offen</span><input id="shutterShade" name="shadePercent" type="range" min="0" max="100" step="1" value="100" aria-label="Abdunkelung bei Sonne"><span>Geschlossen</span></span></label>
        ${field('openValue', 'Prozentwert vollständig offen', 'type="number" min="0" max="100" required')}${field('closedValue', 'Prozentwert vollständig geschlossen', 'type="number" min="0" max="100" required')}
      </div></div>
      <div class="dialog-section"><h4>Fensterkontakt</h4><div class="dialog-grid dialog-grid--two">${picker('contactTopic', 'Fenster-/Türkontakt (optional)')}${field('contactOpenValue', 'Kontaktwert bei geöffnetem Fenster', 'data-no-state-picker required')}</div></div>
      ${buttons('shutterDialog')}</form></dialog>
    <dialog id="shutterRoomDialog" class="value-dialog"><form id="shutterRoomForm" action="/rollladen/room" method="POST" class="dialog-form"><div class="dialog-hero"><div><h3>Dämmerung einstellen</h3><p id="shutterRoomName" class="muted"></p></div></div><p id="shutterRoomError" class="error-text" hidden></p><input name="roomId" type="hidden">
      <div class="dialog-section">${field('brightness', 'Resthelligkeit (%)', 'type="number" min="0" max="100" required')}<p class="muted">0 %: Schluss bei vollständiger Nacht, Öffnen bei erster Dämmerung. 100 %: Schluss bei Dämmerungsbeginn, Öffnen am Horizont.</p></div>${buttons('shutterRoomDialog')}</form></dialog>
    <dialog id="shutterDeleteDialog" class="value-dialog"><form action="/rollladen/delete" method="POST" class="dialog-form"><h3>Rollladen entfernen</h3><p id="shutterDeleteName"></p><input id="shutterDeleteId" name="id" type="hidden"><div class="button-row"><button type="submit" class="button-danger">Endgültig entfernen</button><button type="button" class="secondary-button" onclick="document.getElementById('shutterDeleteDialog').close()">Abbrechen</button></div></form></dialog>`;
  const script = `
    var shutterItems = ${json(shutters)};
    var shutterRooms = ${json(visibleRooms.map(r => ({ id: r.id, name: r.name, brightness: policies.get(r.id)?.brightness ?? 50 })))};
    var shutterInitial = ${json(input ? { type: dialogType, values: input, error } : null)};
    function syncShutterRoom() {
      var creating = document.getElementById('shutterNewRoom').value.trim().length > 0;
      var select = document.getElementById('shutterRoomId');
      select.disabled = creating; select.required = !creating;
    }
    function syncShutterActuator() {
      var form = document.getElementById('shutterForm');
      var percent = !!form.elements.positionTopic.value.trim();
      form.elements.upTopic.required = !percent;
      form.elements.downTopic.required = !percent;
      ['openValue', 'closedValue', 'shadePercent', 'positionFeedbackTopic'].forEach(function(key) { form.elements[key].disabled = !percent; });
      form.elements.upValue.required = !!form.elements.upTopic.value.trim();
      form.elements.downValue.required = !!form.elements.downTopic.value.trim();
      var shade = Number(form.elements.shadePercent.value);
      form.elements.shadePercent.setAttribute('aria-valuetext', shade === 0 ? ${json(i18n.t('rollladen.open_end'))} : shade === 100 ? ${json(i18n.t('rollladen.closed_end'))} : ${json(i18n.t('rollladen.closed_position', { position: '{position}' }))}.replace('{position}', shade));
    }
    function openShutter(id) {
      var item = shutterItems.find(function(s) { return s.id === Number(id); }) || {};
      var defaults = { id: '', name: '', roomId: '', newRoomName: '', orientation: 180, shadePercent: 100, upTopic: '', upValue: 'true', downTopic: '', downValue: 'true', positionTopic: '', positionFeedbackTopic: '', openValue: 0, closedValue: 100, travelSeconds: 60, contactTopic: '', contactOpenValue: 'true' };
      var form = document.getElementById('shutterForm');
      Object.keys(defaults).forEach(function(key) { form.elements[key].value = item[key] == null ? defaults[key] : item[key]; });
      document.getElementById('shutterTitle').textContent = item.id ? ${json(i18n.t('rollladen.edit'))} : ${json(i18n.t('rollladen.add_button'))};
      document.getElementById('shutterError').hidden = true;
      syncShutterRoom(); syncShutterActuator(); document.getElementById('shutterDialog').showModal();
    }
    function openShutterRoom(id) {
      var room = shutterRooms.find(function(r) { return r.id === Number(id); });
      if (!room) return;
      var form = document.getElementById('shutterRoomForm');
      form.elements.roomId.value = room.id; form.elements.brightness.value = room.brightness;
      document.getElementById('shutterRoomName').textContent = room.name;
      document.getElementById('shutterRoomError').hidden = true;
      document.getElementById('shutterRoomDialog').showModal();
    }
    function deleteShutter(id) {
      var item = shutterItems.find(function(s) { return s.id === Number(id); });
      if (!item) return;
      document.getElementById('shutterDeleteId').value = item.id;
      document.getElementById('shutterDeleteName').textContent = item.name;
      document.getElementById('shutterDeleteDialog').showModal();
    }
    document.getElementById('shutterForm').addEventListener('input', syncShutterActuator);
    document.getElementById('shutterForm').addEventListener('change', syncShutterActuator);
    document.getElementById('shutterNewRoom').addEventListener('input', syncShutterRoom);
    if (shutterInitial) {
      var roomMode = shutterInitial.type === 'room';
      if (roomMode) openShutterRoom(shutterInitial.values.roomId); else openShutter(shutterInitial.values.id);
      var form = document.getElementById(roomMode ? 'shutterRoomForm' : 'shutterForm');
      Object.keys(shutterInitial.values).forEach(function(key) { if (form.elements[key]) form.elements[key].value = shutterInitial.values[key]; });
      var error = document.getElementById(roomMode ? 'shutterRoomError' : 'shutterError');
      error.textContent = shutterInitial.error; error.hidden = false;
      syncShutterRoom(); syncShutterActuator();
    }
    function applyShutterStatus(data) {
      var brightness = document.querySelector('[data-shutter-brightness]');
      if (brightness && typeof data.brightness === 'string') brightness.textContent = data.brightness;
      var states = new Map();
      (data.shutters || []).forEach(function(state) {
        var id = Number(state.id);
        if (!Number.isInteger(id)) return;
        states.set(id, state);
        var row = document.querySelector('[data-shutter-id="' + id + '"]');
        if (!row) return;
        ['actual', 'planned', 'reason', 'fault'].forEach(function(field) {
          var node = row.querySelector('[data-shutter-' + field + ']');
          if (!node) return;
          node.textContent = state[field] || '';
          if (field === 'fault') node.hidden = !state.fault;
        });
      });
      shutterRooms.forEach(function(room) {
        var members = shutterItems.filter(function(item) { return item.roomId === room.id && states.has(item.id); });
        if (!members.length) return;
        var manual = members.some(function(item) { return states.get(item.id).manual; });
        var badge = document.querySelector('[data-shutter-mode="' + room.id + '"]');
        if (!badge) return;
        badge.textContent = manual ? 'Manuell' : 'Automatik';
        badge.classList.toggle('adapter-badge--off', manual);
        badge.classList.toggle('adapter-badge--on', !manual);
      });
    }
    var shutterPollBusy = false;
    var shutterPollStopped = false;
    async function pollShutterStatus() {
      if (shutterPollBusy || shutterPollStopped || document.hidden) return;
      shutterPollBusy = true;
      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, 8000);
      try {
        var response = await fetch('/rollladen/status', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        if (response.status === 401 || response.status === 403) { shutterPollStopped = true; return; }
        if (response.ok) applyShutterStatus(await response.json());
      } catch (_) { /* Beim nächsten Takt erneut versuchen; vorhandene Werte erhalten. */ }
      finally { clearTimeout(timeout); shutterPollBusy = false; }
    }
    pollShutterStatus();
    setInterval(pollShutterStatus, 5000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden) pollShutterStatus(); });`;
  return renderLayout({ title: 'Rollladensteuerung', activePath: '/rollladen', body, script });
};
