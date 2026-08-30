'use strict';

// Übersicht des Moduls „Heizung & Klima": alle Räume mit Ist- und
// Soll-Temperatur, ihrem Schaltzustand und ihren Kontakten, im Zeilen- und
// Blockdesign der Adapterseite. Die Einstellungen eines Raums stehen auf einer
// eigenen Seite (/heizung/raum/<id>); hier gibt es Anlegen, Entfernen und das
// schnelle Verstellen der Soll-Temperatur.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { MIN_TEMP, MAX_TEMP, MIN_HYSTERESIS, MAX_HYSTERESIS, MAX_OFFSET } = require('../heizung/rooms');

function temp(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(1).replace('.', ',')} °C`;
}

// Zustandsmarken eines Raums. Ohne hinterlegte Geräte bleibt es bei der reinen
// Temperaturerfassung — dann steht hier nur „Nur Messung".
function badges(room) {
  const state = room.state || {};
  const list = [];
  if (state.contactOpen) list.push('<span class="adapter-badge adapter-badge--warn">Fenster/Tür offen</span>');
  else if (state.contactPending) list.push('<span class="adapter-badge adapter-badge--warn">Kontakt offen — Verzögerung läuft</span>');
  if (state.heatDemand && !state.heatAllowed) list.push('<span class="adapter-badge adapter-badge--warn">Betriebslevel sperrt Heizen</span>');
  if (state.heating) list.push('<span class="adapter-badge adapter-badge--on">Heizen</span>');
  if (state.cooling) list.push('<span class="adapter-badge adapter-badge--on hz-badge-cool">Kühlen</span>');
  // Handschaltung der Klimaanlage (system://homeess/klima.<Raum>.betriebsart).
  if (state.climateOverride) {
    list.push(`<span class="adapter-badge adapter-badge--warn">Klima von Hand: ${state.climateMode === 1 ? 'An' : 'Aus'}</span>`);
  }
  if (state.centralDemand) list.push('<span class="adapter-badge adapter-badge--on hz-badge-central">Zentralheizung angefordert</span>');
  if (!list.length) {
    // Ohne Aktionsfolgen und ohne Zentralheizungs-Freigabe misst der Raum nur.
    const passive = !room.hasHeatDevice && !room.hasCoolDevice && !room.centralAllowed;
    list.push(`<span class="adapter-badge adapter-badge--off">${passive ? 'Nur Messung' : 'Aus'}</span>`);
  }
  return list.join(' ');
}

// Schaltfläche einer Zeile: auf dem Telefon steht nur das Symbol, damit die
// Zeile nicht umbricht; der Name bleibt als aria-label erhalten.
function rowAction(label, icon, attributes, danger = false) {
  const tag = attributes.startsWith('href') ? 'a' : 'button';
  const type = tag === 'button' ? ' type="button"' : '';
  return `<${tag} class="module-toggle-btn hz-row-action${danger ? ' button-danger' : ''}"${type} ${attributes} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="hz-action-label">${escapeHtml(label)}</span><span class="hz-action-icon" aria-hidden="true">${icon}</span></${tag}>`;
}

// Umschalter der Klimaanlage: An / Aus / Automatik, wie die Pumpenmodi der
// Poolsteuerung. Er erscheint nur bei Räumen mit eingerichtetem Kühlgerät —
// ohne Anlage gäbe es nichts zu übersteuern.
const CLIMATE_MODES = [[1, 'An', 'on'], [0, 'Aus', 'off'], [2, 'Automatik', 'auto']];

function climateModeClass(mode) {
  const entry = CLIMATE_MODES.find(([value]) => value === Number(mode));
  return entry ? ` pump-mode-btn--active-${entry[2]}` : '';
}

function climateSwitch(room) {
  if (!room.hasCoolDevice) return '';
  const current = Number(room.climateMode);
  const buttons = CLIMATE_MODES.map(([value, label]) =>
    `<button type="button" class="pump-mode-btn${value === current ? climateModeClass(value) : ''}" data-hz-klima-mode="${value}"
                      aria-pressed="${value === current ? 'true' : 'false'}" onclick="setHeizungKlima(${room.id}, ${value})">${escapeHtml(label)}</button>`).join('\n                    ');
  return `<div class="pump-mode-btns hz-klima-btns">
                    ${buttons}
                  </div>`;
}

function roomRow(room) {
  const state = room.state || {};
  const hint = [state.note, room.lastError].filter(Boolean).join(' · ');
  return `              <div class="adapter-row hz-room-row" data-room-id="${room.id}">
                <span class="adapter-col-name">
                  <a class="hz-room-link" href="/heizung/raum/${room.id}" title="Einstellungen öffnen"><strong>${escapeHtml(room.name)}</strong></a>
                  <span class="hz-room-note hz-room-counts muted">${room.sensorCount} Temperaturquelle${room.sensorCount === 1 ? '' : 'n'} · ${room.contactCount} Kontakt${room.contactCount === 1 ? '' : 'e'} · ${room.actionCount} Aktion${room.actionCount === 1 ? '' : 'en'}</span>
                  <span class="hz-room-note hz-room-hint muted" data-hz-hint="${room.id}">${escapeHtml(hint)}</span>
                </span>
                <span class="hz-col-temp" data-hz-temp="${room.id}">${temp(state.temperature)}</span>
                <span class="hz-col-target">
                  <form action="/heizung/raum/${room.id}/soll" method="POST" class="hz-inline-form">
                    <input type="number" name="targetTemp" value="${Number(room.targetTemp)}" min="${MIN_TEMP}" max="${MAX_TEMP}" step="0.5" data-no-state-picker>
                    <button type="submit" class="module-toggle-btn">Setzen</button>
                  </form>
                </span>
                <span class="hz-col-klima" data-hz-klima="${room.id}">${climateSwitch(room)}</span>
                <span class="hz-col-state" data-hz-badges="${room.id}">${badges(room)}</span>
                <span class="adapter-row-actions">
                  ${rowAction('Einstellungen', '⚙', `href="/heizung/raum/${room.id}"`)}
                  ${rowAction('Entfernen', '🗑', `onclick="openHeizungRoomDelete(${room.id})"`, true)}
                </span>
              </div>`;
}

function roomBlock(rooms) {
  const header = rooms.length
    ? `              <div class="adapter-row hz-room-row adapter-row--head">
                <span>Raum</span><span class="hz-col-temp">Ist</span><span class="hz-col-target">Soll</span><span class="hz-col-klima">Klima</span><span class="hz-col-state">Zustand</span><span></span>
              </div>`
    : '';
  const rows = rooms.length
    ? rooms.map(roomRow).join('\n')
    : '              <div class="adapter-row adapter-row--empty"><span class="muted">Noch kein Raum angelegt.</span></div>';
  return `          <div class="adapter-block">
            <div class="adapter-block-head">
              <div class="adapter-block-title">
                <strong>Räume</strong>
                <span class="adapter-prefix">System / Räume</span>
              </div>
            </div>
            <div class="adapter-rows">
${header}
${rows}
            </div>
          </div>`;
}

// Kopfzeile der Zentralheizung: Zustand und Weg zu ihren Einstellungen.
function centralCard(central, state) {
  if (!central.enabled) {
    return `        <div class="hz-central-card">
          <div><strong>Zentralheizung</strong><p class="muted">Nicht eingerichtet — Räume regeln bislang nur ihre eigenen Geräte.</p></div>
          <a class="secondary-button" href="/heizung/zentrale">Einrichten</a>
        </div>`;
  }
  const modeLabel = central.mode === 'modbus' ? 'Modbus/State' : 'Schaltaktor';
  const sweep = central.sweepEnabled
    ? '<span class="adapter-badge adapter-badge--warn">Schornsteinfeger-Modus</span>' : '';
  return `        <div class="hz-central-card">
          <div>
            <strong>Zentralheizung</strong>
            <p class="muted">${escapeHtml(modeLabel)} · Außen <span data-hz-outdoor>${temp(state.outdoorTemp)}</span> · Vorlauf <span data-hz-flow>${temp(state.flowTemp)}</span> · Rücklauf <span data-hz-return>${temp(state.returnTemp)}</span><span data-hz-central-note>${state.note ? ` · ${escapeHtml(state.note)}` : ''}</span></p>
          </div>
          <div class="hz-central-state">
            <span data-hz-sweep>${sweep}</span>
            <span class="adapter-badge adapter-badge--${state.boilerOn ? 'on' : 'off'}" data-hz-boiler>Kessel ${state.boilerOn ? 'ein' : 'aus'}</span>
            <span class="adapter-badge adapter-badge--${state.burnerOn ? 'on' : 'off'}" data-hz-burner>Brenner ${state.burnerOn ? 'an' : 'aus'}</span>
            ${central.mode === 'relais' && central.pumpTopic ? `<span class="adapter-badge adapter-badge--${state.pumpOn ? 'on' : 'off'}" data-hz-pump>Pumpe ${state.pumpOn ? 'läuft' : 'aus'}</span>` : ''}
            <span class="muted" data-hz-demand>${state.demandCount} Anforderung${state.demandCount === 1 ? '' : 'en'}</span>
            <a class="secondary-button" href="/heizung/zentrale">Zentralheizung</a>
          </div>
        </div>`;
}

function roomDialog() {
  return `<dialog id="heizungRoomDialog" class="value-dialog"><form id="heizungRoomForm" method="POST" action="/heizung/rooms" class="dialog-form">
    <div class="dialog-hero"><div><h3>Raum hinzufügen</h3><p class="muted">Der Name benennt die States des Raums (<code>System / Räume / &lt;Name&gt;</code>). Temperaturquellen, Geräte, Kontakte und die Zentralheizungs-Freigabe werden anschließend auf der Seite des Raums eingerichtet.</p></div></div>
    <p id="heizungRoomError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="heizungRoomName" name="name" required maxlength="100" data-no-state-picker></label>
      <label class="field-block"><span>Soll-Temperatur (°C)</span><input id="heizungRoomTarget" name="targetTemp" type="number" value="21" min="${MIN_TEMP}" max="${MAX_TEMP}" step="0.5" required data-no-state-picker></label>
      <label class="field-block"><span>Offset Heizen (°C nach unten)</span><span class="field-hint">Heizen ein bei Soll minus Offset</span><input id="heizungRoomHeatOffset" name="heatOffset" type="number" value="0" min="0" max="${MAX_OFFSET}" step="0.5" data-no-state-picker></label>
      <label class="field-block"><span>Offset Kühlen (°C nach oben)</span><span class="field-hint">Kühlen ein bei Soll plus Offset</span><input id="heizungRoomCoolOffset" name="coolOffset" type="number" value="5" min="0" max="${MAX_OFFSET}" step="0.5" data-no-state-picker></label>
      <label class="field-block"><span>Mindesttemperatur zum Kühlen (°C)</span><span class="field-hint">Darunter wird nie gekühlt — leer = keine Untergrenze</span><input id="heizungRoomCoolMin" name="coolMinTemp" type="number" min="${MIN_TEMP}" max="${MAX_TEMP}" step="0.5" placeholder="ohne Untergrenze" data-no-state-picker></label>
      <label class="field-block"><span>Schalthysterese (°C)</span><span class="field-hint">Verhindert ständiges An und Aus</span><input id="heizungRoomHysteresis" name="hysteresis" type="number" value="0.5" min="${MIN_HYSTERESIS}" max="${MAX_HYSTERESIS}" step="0.1" data-no-state-picker></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('heizungRoomDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function deleteDialog() {
  return `<dialog id="heizungRoomDeleteDialog" class="value-dialog"><form id="heizungRoomDeleteForm" method="POST" class="dialog-form">
    <h3 id="heizungRoomDeleteTitle">Raum entfernen</h3>
    <p class="error-text">Der Raum, seine Temperaturquellen, seine Kontakte und seine States werden dauerhaft gelöscht.</p>
    <div class="button-row"><button class="button-danger" type="submit">Endgültig entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('heizungRoomDeleteDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

// Zahl mit deutschem Dezimalkomma.
function num(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits).replace('.', ',');
}

function stamp(value) {
  return value ? new Date(Number(value)).toLocaleDateString('de-DE') : '—';
}

// Zählwerk der Heizkosten: der laufende Abrechnungszeitraum bis zur nächsten
// Zählerablesung, daneben der zuletzt abgeschlossene.
function billingCard(billing, central) {
  if (!central.enabled || !billing) return '';
  const unit = escapeHtml(billing.unit || '');
  const previous = billing.previous;
  return `        <div class="hz-billing">
          <div class="hz-billing-head">
            <div>
              <strong>Heizkosten-Zählwerk</strong>
              <p class="muted">Laufender Abrechnungszeitraum seit ${stamp(billing.startedAt)} (${billing.days} Tag${billing.days === 1 ? '' : 'e'}) — er zählt bis zum Abschließen weiter, in der Regel bis zur jährlichen Zählerablesung.</p>
            </div>
            <div class="hz-billing-actions">
              <button type="button" class="secondary-button" onclick="document.getElementById('heizungStartwertDialog').showModal()">Startwert</button>
              <button type="button" class="secondary-button" onclick="document.getElementById('heizungResetDialog').showModal()">Zeitraum abschließen</button>
            </div>
          </div>
          <div class="hz-billing-figures">
            <div class="hz-figure"><span class="hz-figure-label">Verbrauch</span><span class="hz-figure-value">${num(billing.consumption)} ${unit}</span><span class="hz-figure-note muted">davon ${num(billing.startConsumption)} ${unit} Startwert</span></div>
            <div class="hz-figure"><span class="hz-figure-label">Kosten</span><span class="hz-figure-value">${num(billing.cost)} €</span><span class="hz-figure-note muted">seit Beginn des Zeitraums</span></div>
            <div class="hz-figure hz-figure--accent"><span class="hz-figure-label">Monatsabschlag</span><span class="hz-figure-value">${num(billing.monthly)} €</span><span class="hz-figure-note muted">Kosten ÷ 12 Monate</span></div>
            <div class="hz-figure"><span class="hz-figure-label">Vorheriger Zeitraum</span><span class="hz-figure-value">${previous ? `${num(previous.cost)} €` : '—'}</span><span class="hz-figure-note muted">${previous
    ? `${stamp(previous.startedAt)} – ${stamp(previous.endedAt)} · ${num(previous.metered == null ? previous.consumption : previous.metered)} ${unit}${previous.metered == null ? ' geschätzt' : ' abgelesen'} · ${num(previous.monthly)} €/Monat`
    : 'Noch kein Zeitraum abgeschlossen'}</span></div>
          </div>
          ${billing.lastCalibrationFactor ? `<p class="muted hz-billing-hint">Zuletzt am ${stamp(billing.lastCalibrationAt)} mit Faktor ${num(billing.lastCalibrationFactor, 3)} kalibriert.</p>` : ''}
        </div>`;
}

function billingDialogs(billing) {
  const unit = escapeHtml((billing && billing.unit) || '');
  return `<dialog id="heizungStartwertDialog" class="value-dialog"><form method="POST" action="/heizung/zaehlwerk/startwert" class="dialog-form">
    <div class="dialog-hero"><div><h3>Startwert des Zeitraums</h3><p class="muted">Was seit der letzten Zählerablesung schon verbraucht wurde, bevor homeESS mitgezählt hat. Er verschiebt nur die Summe; der laufende Zeitraum bleibt bestehen.</p></div></div>
    <div class="dialog-section"><label class="field-block"><span>Startwert (${unit})</span><input name="startConsumption" type="number" min="0" step="0.001" value="${billing ? billing.startConsumption : 0}" required data-no-state-picker></label></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('heizungStartwertDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <dialog id="heizungResetDialog" class="value-dialog"><form method="POST" action="/heizung/zaehlwerk/reset" class="dialog-form">
    <div class="dialog-hero"><div><h3>Zeitraum abschließen</h3><p class="muted">Der laufende Zeitraum wird als vorheriger gespeichert, der neue beginnt bei 0. Das lässt sich nicht rückgängig machen.</p></div></div>
    <div class="dialog-section">
      <label class="field-block"><span>Abgelesener Zählerstand (${unit}, optional)</span><span class="field-hint">Der tatsächliche Verbrauch des Zeitraums laut Zähler</span><input name="metered" type="number" min="0" step="0.001" placeholder="nicht abgelesen" data-no-state-picker></label>
      <label class="remember-row"><input type="hidden" name="calibrate" value="0"><input type="checkbox" name="calibrate" value="1"><span>Damit den geschätzten Verbrauch je Betriebsstunde kalibrieren</span></label>
      <p class="muted condition-section-hint">Die Kalibrierung zieht den Verbrauch je Betriebsstunde auf den abgelesenen Wert nach. Das ergibt nur Sinn, wenn <strong>keine weiteren Verbraucher</strong> am selben Zähler hängen und der Startwert stimmt.</p>
    </div>
    <div class="button-row"><button class="button-danger" type="submit">Abschließen</button><button type="button" class="secondary-button" onclick="document.getElementById('heizungResetDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function renderHeizung({
  rooms = [], central = {}, centralState = {}, billing = null,
  error = '', message = '', initialDialog = null,
} = {}) {
  const safeRooms = JSON.stringify(rooms.map((room) => ({ id: room.id, name: room.name }))).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');
  const body = `        <div class="panel-head"><div><h1>Heizung &amp; Klima</h1></div><div class="dashboard-toolbar"><a class="secondary-button" href="/heizung/zentrale">Zentralheizung</a><button type="button" class="secondary-button" onclick="openHeizungRoomDialog()">Raum hinzufügen</button></div></div>
        ${statusText(error)}${statusText(message, 'success')}
${centralCard(central, centralState)}
        <div class="adapter-list hz-rooms" id="heizungRooms">
${roomBlock(rooms)}
        </div>
${billingCard(billing, central)}
        ${roomDialog()}${deleteDialog()}${billingDialogs(billing)}`;

  const script = `
    var heizungRooms = ${safeRooms};
    var heizungInitialDialog = ${safeInitial};
    function openHeizungRoomDialog() {
      var error = document.getElementById('heizungRoomError');
      error.textContent = ''; error.hidden = true;
      document.getElementById('heizungRoomDialog').showModal();
    }
    function openHeizungRoomDelete(id) {
      var room = heizungRooms.find(function (entry) { return entry.id === Number(id); });
      document.getElementById('heizungRoomDeleteForm').action = '/heizung/rooms/' + id + '/delete';
      document.getElementById('heizungRoomDeleteTitle').textContent = room ? '„' + room.name + '" entfernen' : 'Raum entfernen';
      document.getElementById('heizungRoomDeleteDialog').showModal();
    }
    if (heizungInitialDialog) {
      openHeizungRoomDialog();
      var values = heizungInitialDialog.values || {};
      ['name:heizungRoomName', 'targetTemp:heizungRoomTarget', 'heatOffset:heizungRoomHeatOffset',
       'coolOffset:heizungRoomCoolOffset', 'coolMinTemp:heizungRoomCoolMin',
       'hysteresis:heizungRoomHysteresis'].forEach(function (pair) {
        var parts = pair.split(':');
        var node = document.getElementById(parts[1]);
        if (node && values[parts[0]] != null) node.value = values[parts[0]];
      });
      var err = document.getElementById('heizungRoomError');
      err.textContent = heizungInitialDialog.error || '';
      err.hidden = !err.textContent;
    }

    // Live-Werte nachziehen, ohne die Seite neu zu laden.
    function heizungTemp(value) {
      if (value == null || isNaN(Number(value))) return '—';
      return Number(value).toFixed(1).replace('.', ',') + ' °C';
    }
    function heizungBadges(state) {
      var html = '';
      if (state.contactOpen) html += '<span class="adapter-badge adapter-badge--warn">Fenster/Tür offen</span> ';
      else if (state.contactPending) html += '<span class="adapter-badge adapter-badge--warn">Kontakt offen — Verzögerung läuft</span> ';
      if (state.heatDemand && !state.heatAllowed) html += '<span class="adapter-badge adapter-badge--warn">Betriebslevel sperrt Heizen</span> ';
      if (state.heating) html += '<span class="adapter-badge adapter-badge--on">Heizen</span> ';
      if (state.cooling) html += '<span class="adapter-badge adapter-badge--on hz-badge-cool">Kühlen</span> ';
      if (state.climateOverride) html += '<span class="adapter-badge adapter-badge--warn">Klima von Hand: ' + (state.climateMode === 1 ? 'An' : 'Aus') + '</span> ';
      if (state.centralDemand) html += '<span class="adapter-badge adapter-badge--on hz-badge-central">Zentralheizung angefordert</span> ';
      if (!html) html = '<span class="adapter-badge adapter-badge--off">Aus</span>';
      return html;
    }
    // Klimaanlage umschalten (0 = Aus, 1 = An, 2 = Automatik). Danach kurz
    // warten und den Stand nachziehen — die Regelung entscheidet im nächsten
    // Takt, ob die Anlage tatsächlich läuft.
    function setHeizungKlima(roomId, mode) {
      fetch('/heizung/raum/' + roomId + '/klima/' + mode, {
        method: 'POST', headers: { Accept: 'application/json' },
      })
        .then(function () { setTimeout(heizungPoll, 300); })
        .catch(function () {});
    }
    function heizungKlimaApply(roomId, mode) {
      var box = document.querySelector('[data-hz-klima="' + roomId + '"]');
      if (!box) return;
      var classes = { 0: 'pump-mode-btn--active-off', 1: 'pump-mode-btn--active-on', 2: 'pump-mode-btn--active-auto' };
      var buttons = box.querySelectorAll('[data-hz-klima-mode]');
      for (var i = 0; i < buttons.length; i++) {
        var value = Number(buttons[i].getAttribute('data-hz-klima-mode'));
        var active = value === Number(mode);
        buttons[i].classList.toggle(classes[value], active);
        buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    function heizungApply(data) {
      (data.rooms || []).forEach(function (room) {
        if (room.hasCoolDevice) heizungKlimaApply(room.id, room.climateMode);
        var tempNode = document.querySelector('[data-hz-temp="' + room.id + '"]');
        if (tempNode) tempNode.textContent = heizungTemp(room.temperature);
        var badgeNode = document.querySelector('[data-hz-badges="' + room.id + '"]');
        if (badgeNode) badgeNode.innerHTML = heizungBadges(room);
        // Hinweise veralten sonst bis zum nächsten Seitenaufbau.
        var hintNode = document.querySelector('[data-hz-hint="' + room.id + '"]');
        if (hintNode) hintNode.textContent = room.note || '';
        // Die Soll-Temperatur kann sich am Thermostat geändert haben; ein Feld
        // in Bearbeitung bleibt unangetastet.
        var targetNode = document.querySelector('[data-room-id="' + room.id + '"] input[name="targetTemp"]');
        if (targetNode && document.activeElement !== targetNode && room.targetTemp != null) {
          targetNode.value = room.targetTemp;
        }
      });
      var central = data.central || {};
      var boiler = document.querySelector('[data-hz-boiler]');
      if (boiler) {
        boiler.textContent = 'Kessel ' + (central.boilerOn ? 'ein' : 'aus');
        boiler.className = 'adapter-badge adapter-badge--' + (central.boilerOn ? 'on' : 'off');
      }
      var burner = document.querySelector('[data-hz-burner]');
      if (burner) {
        burner.textContent = 'Brenner ' + (central.burnerOn ? 'an' : 'aus');
        burner.className = 'adapter-badge adapter-badge--' + (central.burnerOn ? 'on' : 'off');
      }
      var pumpNode = document.querySelector('[data-hz-pump]');
      if (pumpNode) {
        pumpNode.textContent = 'Pumpe ' + (central.pumpOn ? 'läuft' : 'aus');
        pumpNode.className = 'adapter-badge adapter-badge--' + (central.pumpOn ? 'on' : 'off');
      }
      var demand = document.querySelector('[data-hz-demand]');
      if (demand) demand.textContent = (central.demandCount || 0) + ' Anforderung' + (central.demandCount === 1 ? '' : 'en');
      var outdoor = document.querySelector('[data-hz-outdoor]');
      if (outdoor) outdoor.textContent = heizungTemp(central.outdoorTemp);
      var flow = document.querySelector('[data-hz-flow]');
      if (flow) flow.textContent = heizungTemp(central.flowTemp);
      var back = document.querySelector('[data-hz-return]');
      if (back) back.textContent = heizungTemp(central.returnTemp);
      var centralNote = document.querySelector('[data-hz-central-note]');
      if (centralNote) centralNote.textContent = central.note ? ' · ' + central.note : '';
      var sweepNode = document.querySelector('[data-hz-sweep]');
      if (sweepNode) {
        sweepNode.innerHTML = central.sweepEnabled
          ? '<span class="adapter-badge adapter-badge--warn">Schornsteinfeger-Modus</span>' : '';
      }
    }
    function heizungPoll() {
      fetch('/heizung/status', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) heizungApply(d); })
        .catch(function () {});
    }
    heizungPoll();
    setInterval(heizungPoll, 5000);
  `;
  return renderLayout({ title: 'Heizung & Klima', activePath: '/heizung', body, script });
}

module.exports = renderHeizung;
