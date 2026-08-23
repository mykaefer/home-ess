'use strict';

// Eigenständige Seite eines Raums im Modul „Heizung & Klima": Schaltschwellen,
// gekoppeltes Thermostat, Freigabe der Zentralheizung, die Listen der
// Temperaturquellen und Kontakte — und die vier Aktionsfolgen, mit denen der
// Raum sein Heiz- und sein Kühlgerät schaltet (geteilter Baustein
// views/action-sequences.js, wie beim Heimkino).

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { renderActionSequences } = require('./action-sequences');
const { PHASES } = require('../heizung/actions');
const {
  MIN_TEMP, MAX_TEMP, MAX_OFFSET, MIN_HYSTERESIS, MAX_HYSTERESIS, MAX_CONTACT_DELAY_SECONDS,
  MIN_PRIORITY, MAX_PRIORITY,
} = require('../heizung/rooms');

function temp(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(1).replace('.', ',')} °C`;
}

// Priorität = Betriebslevel, ab dem das Gerät laufen darf (1 = höchste).
function priorityOptions(selected) {
  const value = Number(selected);
  const options = [];
  for (let level = MIN_PRIORITY; level <= MAX_PRIORITY; level += 1) {
    const label = level === MIN_PRIORITY ? '1 – höchste' : level === MAX_PRIORITY ? '5 – niedrigste' : String(level);
    options.push(`<option value="${level}"${level === value ? ' selected' : ''}>${label}</option>`);
  }
  return options.join('');
}

function num(value) {
  return value == null || !Number.isFinite(Number(value)) ? '' : String(Number(value));
}

// Zustandszeile: was die Regelung gerade tut und warum.
function stateLine(room, state) {
  const marks = [];
  if (state.heating) marks.push('<span class="condition-enabled is-enabled">Heizen</span>');
  if (state.cooling) marks.push('<span class="condition-enabled is-enabled">Kühlen</span>');
  if (state.centralDemand) marks.push('<span class="condition-enabled is-enabled">Zentralheizung angefordert</span>');
  if (!marks.length) marks.push('<span class="condition-enabled is-disabled">Keine Anforderung</span>');
  return `        <p class="hz-state-line">
          <span class="hz-current">${temp(state.temperature)}</span>
          <span class="muted">Ist (${state.sensorCount || 0} Quelle${state.sensorCount === 1 ? '' : 'n'}) · Soll ${temp(room.targetTemp)}</span>
          ${marks.join(' ')}
          ${state.note ? `<span class="muted">${escapeHtml(state.note)}</span>` : ''}
        </p>`;
}

// Schaltfläche einer Listenzeile: auf dem Telefon nur das Symbol (siehe
// views/heizung.js), damit die Zeile nicht umbricht.
function rowAction(label, icon, onclick, danger = false) {
  return `<button type="button" class="module-toggle-btn hz-row-action${danger ? ' button-danger' : ''}" onclick="${onclick}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="hz-action-label">${escapeHtml(label)}</span><span class="hz-action-icon" aria-hidden="true">${icon}</span></button>`;
}

function sensorRow(room, sensor) {
  return `              <div class="adapter-row hz-item-row">
                <span class="adapter-col-name"><strong>${escapeHtml(sensor.name)}</strong></span>
                <span class="adapter-col-addr muted" title="${escapeHtml(sensor.topic)}">${escapeHtml(sensor.topic)}</span>
                <span class="adapter-row-actions">
                  ${rowAction('Bearbeiten', '✎', `openHeizungSensor('edit', ${sensor.id})`)}
                  ${rowAction('Entfernen', '🗑', `openHeizungDelete('sensoren', ${sensor.id}, 'Temperaturquelle entfernen')`, true)}
                </span>
              </div>`;
}

function contactRow(room, contact) {
  return `              <div class="adapter-row hz-item-row">
                <span class="adapter-col-name"><strong>${escapeHtml(contact.name)}</strong>${contact.inverted ? ' <span class="muted">(invertiert)</span>' : ''}</span>
                <span class="adapter-col-addr muted" title="${escapeHtml(contact.topic)}">${escapeHtml(contact.topic)}</span>
                <span class="adapter-row-actions">
                  ${rowAction('Bearbeiten', '✎', `openHeizungContact('edit', ${contact.id})`)}
                  ${rowAction('Entfernen', '🗑', `openHeizungDelete('kontakte', ${contact.id}, 'Kontakt entfernen')`, true)}
                </span>
              </div>`;
}

function listBlock(title, prefix, hint, rows, onAdd, emptyText) {
  return `          <div class="adapter-block">
            <div class="adapter-block-head">
              <div class="adapter-block-title">
                <strong>${title}</strong>
                <span class="muted">${hint}</span>
              </div>
              <button type="button" class="module-toggle-btn" onclick="${onAdd}">Hinzufügen</button>
            </div>
            <div class="adapter-rows">
${rows.length ? rows.join('\n') : `              <div class="adapter-row adapter-row--empty"><span class="muted">${emptyText}</span></div>`}
            </div>
          </div>`;
}

function settingsForm(room, central) {
  const centralChecked = room.centralAllowed ? ' checked' : '';
  return `        <form action="/heizung/raum/${room.id}" method="POST" class="hz-settings">
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Regelung</h4></div>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block"><span>Name</span><span class="field-hint">Steht in den State-Topics des Raums — ein Umbenennen ändert sie</span><input name="name" value="${escapeHtml(room.name)}" required maxlength="100" data-no-state-picker></label>
              <label class="field-block"><span>Soll-Temperatur (°C)</span><input name="targetTemp" type="number" value="${num(room.targetTemp)}" min="${MIN_TEMP}" max="${MAX_TEMP}" step="0.5" required data-no-state-picker></label>
              <label class="field-block"><span>Offset Heizen (°C nach unten)</span><span class="field-hint">Heizen ein bei Soll minus Offset — 0 heißt: genau bei der Soll-Temperatur</span><input name="heatOffset" type="number" value="${num(room.heatOffset)}" min="0" max="${MAX_OFFSET}" step="0.5" data-no-state-picker></label>
              <label class="field-block"><span>Offset Kühlen (°C nach oben)</span><span class="field-hint">Kühlen ein bei Soll plus Offset</span><input name="coolOffset" type="number" value="${num(room.coolOffset)}" min="0" max="${MAX_OFFSET}" step="0.5" data-no-state-picker></label>
              <label class="field-block"><span>Mindesttemperatur zum Kühlen (°C)</span><span class="field-hint">Darunter wird nie gekühlt — eine Nachtabsenkung am Thermostat weckt die Klimaanlage damit nicht. Leer = keine Untergrenze. Liegt Soll plus Offset höher, gilt dieser Wert.</span><input name="coolMinTemp" type="number" value="${num(room.coolMinTemp)}" min="${MIN_TEMP}" max="${MAX_TEMP}" step="0.5" placeholder="ohne Untergrenze" data-no-state-picker></label>
              <label class="field-block"><span>Schalthysterese (°C)</span><span class="field-hint">Abstand zwischen Ein- und Ausschaltpunkt, damit die Anlage nicht taktet</span><input name="hysteresis" type="number" value="${num(room.hysteresis)}" min="${MIN_HYSTERESIS}" max="${MAX_HYSTERESIS}" step="0.1" data-no-state-picker></label>
              <label class="field-block condition-topic-field"><span>Thermostat (optional)</span><span class="field-hint">Soll-Temperatur bleibt bidirektional synchron, z. B. Homematic IP Wandthermostat</span><input name="thermostatTopic" value="${escapeHtml(room.thermostatTopic)}" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label>
            </div>
          </div>
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Zentralheizung</h4>
              <label class="remember-row condition-section-toggle"><input type="hidden" name="centralAllowed" value="0"><input type="checkbox" name="centralAllowed" value="1"${centralChecked} onchange="syncHeizungCentral(this)"><span>Dieser Raum darf die Zentralheizung anfordern</span></label>
            </div>
            <p class="muted condition-section-hint">Maßgeblich ist die <strong>Außentemperatur</strong>: Liegt sie unter der angegebenen Grenze, versorgt die Zentralheizung den Raum <strong>anstelle</strong> des lokalen Heizgerätes; es gilt dieselbe Schalthysterese. Darüber heizt allein das lokale Gerät — ist keines hinterlegt, wird in diesem Bereich bewusst nicht geheizt. Ob der Raum überhaupt Wärme braucht, entscheidet weiterhin seine eigene Temperatur gegen die Soll-Temperatur.${central && central.enabled ? '' : ' <strong>Die Zentralheizung ist derzeit nicht eingerichtet.</strong>'}</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block"><span>Zentralheizung ab Außentemperatur unter (°C)</span><input name="centralTemp" type="number" value="${num(room.centralTemp)}" min="${MIN_TEMP}" max="${MAX_TEMP}" step="0.5" data-no-state-picker></label>
              <label class="field-block condition-topic-field"><span>Heizkörperlüfter (optional)</span><span class="field-hint">Wird eingeschaltet, solange dieser Raum Wärme von der Zentralheizung anfordert, und danach wieder aus</span><input name="fanTopic" value="${escapeHtml(room.fanTopic)}" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label>
            </div>
          </div>
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Fenster und Türen</h4></div>
            <p class="muted condition-section-hint">Ist ein zugeordneter Kontakt offen, werden Heizen und Kühlen abgeschaltet. Mit einer Verzögerung bleibt kurzes Lüften folgenlos; 0 Sekunden schaltet sofort ab. Das Schließen wirkt immer sofort.</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block"><span>Verzögerung (Sekunden)</span><input name="contactDelaySeconds" type="number" value="${Number(room.contactDelaySeconds) || 0}" min="0" max="${MAX_CONTACT_DELAY_SECONDS}" step="10" data-no-state-picker></label>
            </div>
          </div>
          <div class="button-row"><button type="submit">Speichern</button></div>
        </form>`;
}

function sensorDialog(roomId) {
  return `<dialog id="heizungSensorDialog" class="value-dialog"><form id="heizungSensorForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="heizungSensorTitle">Temperaturquelle hinzufügen</h3><p class="muted">Mehrere Quellen je Raum sind möglich — dann zählt ihr Durchschnitt als Ist-Temperatur.</p></div></div>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Bezeichnung</span><input id="heizungSensorName" name="name" maxlength="100" placeholder="z. B. hDP Fensterseite" data-no-state-picker></label>
      <label class="field-block condition-topic-field"><span>State mit der Temperatur</span><input id="heizungSensorTopic" name="topic" data-state-picker autocomplete="off" placeholder="State auswählen…" required></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('heizungSensorDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <dialog id="heizungContactDialog" class="value-dialog"><form id="heizungContactForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="heizungContactTitle">Kontakt hinzufügen</h3><p class="muted">Fenster- und Türkontakte sperren Heizen und Kühlen, solange sie offen sind.</p></div></div>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Bezeichnung</span><input id="heizungContactName" name="name" maxlength="100" placeholder="z. B. Terrassentür" data-no-state-picker></label>
      <label class="field-block condition-topic-field"><span>State des Kontakts</span><input id="heizungContactTopic" name="topic" data-state-picker autocomplete="off" placeholder="State auswählen…" required></label>
      <label class="remember-row"><input type="hidden" name="inverted" value="0"><input id="heizungContactInverted" type="checkbox" name="inverted" value="1"><span>Invertiert (1 bedeutet geschlossen)</span></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('heizungContactDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <dialog id="heizungDeleteDialog" class="value-dialog"><form id="heizungDeleteForm" method="POST" class="dialog-form">
    <h3 id="heizungDeleteTitle">Entfernen</h3>
    <p class="error-text">Der Eintrag wird dauerhaft entfernt.</p>
    <div class="button-row"><button class="button-danger" type="submit">Entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('heizungDeleteDialog').close()">Abbrechen</button></div>
  </form></dialog>
  <input type="hidden" id="heizungRoomId" value="${roomId}">`;
}

function statesBlock(room, stateTopics) {
  const rows = stateTopics.map((entry) => `              <div class="adapter-row hz-item-row">
                <span class="adapter-col-name"><strong>${escapeHtml(entry.label)}</strong></span>
                <span class="adapter-col-addr muted" title="${escapeHtml(entry.topic)}"><code>${escapeHtml(entry.topic)}</code></span>
                <span class="muted">${entry.writable ? 'beschreibbar' : 'nur lesen'}</span>
              </div>`);
  return `          <div class="adapter-block">
            <div class="adapter-block-head"><div class="adapter-block-title"><strong>States des Raums</strong><span class="muted">Als Systemwerte unter <code>System / Räume / ${escapeHtml(room.name)}</code> — überall verwendbar: Bedingungen, Dashboard, Wertekatalog.</span></div></div>
            <div class="adapter-rows">
${rows.join('\n')}
            </div>
          </div>`;
}

function renderHeizungRoom({
  room = null, sensors = [], contacts = [], central = {}, state = {}, stateTopics = [],
  tree = {}, actions = [], error = '', message = '', initialDialog = null,
} = {}) {
  if (!room) return renderLayout({ title: 'Heizung & Klima', activePath: '/heizung', body: '<p>Raum nicht gefunden.</p>' });
  // Die Aktionsfolgen kommen aus demselben Baustein wie beim Heimkino.
  const sequences = renderActionSequences({
    prefix: 'hz',
    ns: 'HeizungSeq',
    varPrefix: 'heizungSeq',
    storageKey: 'homeess.heizung.expanded.v1',
    basePath: `/heizung/raum/${room.id}`,
    ownerId: room.id,
    phases: PHASES,
    tree,
    actions,
    initialDialog: initialDialog && initialDialog.kind === 'action' ? initialDialog : null,
    // Vier Folgen: zugeklappt bleibt die Seite überschaubar.
    defaultOpen: false,
  });
  const safeSensors = JSON.stringify(sensors).replace(/</g, '\\u003c');
  const safeContacts = JSON.stringify(contacts).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');

  const body = `        <div class="panel-head">
          <div>
            <h1>${escapeHtml(room.name)}</h1>
            <p class="muted">Raum im Modul Heizung &amp; Klima</p>
          </div>
          <div class="dashboard-toolbar"><a class="secondary-button" href="/heizung">Zurück zur Übersicht</a></div>
        </div>
        ${statusText(error)}${statusText(message, 'success')}
${stateLine(room, state)}
        <div class="adapter-list hz-lists">
${listBlock('Temperaturquellen', 'sensor', 'Bei mehreren Quellen wird der Durchschnitt verwendet.',
    sensors.map((sensor) => sensorRow(room, sensor)), "openHeizungSensor('add')", 'Noch keine Temperaturquelle zugeordnet.')}
${listBlock('Fenster- und Türkontakte', 'contact', 'Offene Kontakte sperren Heizen und Kühlen.',
    contacts.map((contact) => contactRow(room, contact)), "openHeizungContact('add')", 'Noch kein Kontakt zugeordnet.')}
${statesBlock(room, stateTopics)}
        </div>
        <div class="dialog-section hz-sequences">
          <div class="dialog-section-head"><h4>Geräte schalten</h4></div>
          <form action="/heizung/raum/${room.id}/prioritaeten" method="POST" class="hz-priorities">
            <p class="muted condition-section-hint">Die <strong>Priorität</strong> ist das Betriebslevel, ab dem ein Gerät laufen darf (1 = höchste, läuft immer; 5 = nur bei freiem Überschuss). Deckt das aktuelle Betriebslevel die Priorität nicht ab, bleibt das Gerät aus und wird bei einem Levelabfall sofort abgeschaltet.</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block"><span>Priorität Heizgerät</span><select name="heatPriority">${priorityOptions(room.heatPriority)}</select></label>
              <label class="field-block"><span>Priorität Kühlgerät</span><select name="coolPriority">${priorityOptions(room.coolPriority)}</select></label>
              <label class="remember-row hz-priority-toggle"><input type="hidden" name="heatCentralFallback" value="0"><input type="checkbox" name="heatCentralFallback" value="1"${room.heatCentralFallback ? ' checked' : ''}><span>Sperrt das Betriebslevel das Heizgerät, darf die Zentralheizung einspringen</span></label>
            </div>
            <p class="muted condition-section-hint">Ist das aktiviert, <strong>entfällt für diesen Raum solange die Außentemperaturgrenze</strong>: statt des gesperrten lokalen Gerätes heizt direkt die Zentralheizung. Sobald das Betriebslevel die Priorität wieder abdeckt, gilt die Grenze erneut. Setzt voraus, dass der Raum die Zentralheizung anfordern darf.</p>
            <div class="button-row"><button type="submit">Prioritäten speichern</button></div>
          </form>
          <p class="muted condition-section-hint">Heiz- und Kühlgerät werden über Aktionsfolgen geschaltet — Wertzuweisungen, Pausen und Schleifen, die zyklisch prüfen können, ob der gewünschte Zustand tatsächlich erreicht wurde. So lässt sich auch eine Splitklimaanlage bedienen, die Betriebsart, Solltemperatur und Einschaltbefehl nacheinander braucht. <strong>Beide Geräte sind optional:</strong> ein Raum ohne Aktionen in der „ein"-Folge erfasst nur seine Temperatur.</p>
${sequences.body}
        </div>
${settingsForm(room, central)}
        ${sensorDialog(room.id)}`;

  const script = `
    var heizungSensors = ${safeSensors};
    var heizungContacts = ${safeContacts};
    var heizungInitialDialog = ${safeInitial};
    var heizungRoomId = Number(document.getElementById('heizungRoomId').value);
    function syncHeizungCentral(box) {
      var field = document.querySelector('input[name="centralTemp"]');
      if (field) field.required = !!box.checked;
    }
    document.querySelectorAll('input[name="centralAllowed"][type="checkbox"]').forEach(syncHeizungCentral);
    function openHeizungSensor(mode, id) {
      var sensor = mode === 'edit' ? heizungSensors.find(function (entry) { return entry.id === Number(id); }) : null;
      document.getElementById('heizungSensorForm').action = '/heizung/raum/' + heizungRoomId + '/sensoren' + (sensor ? '/' + sensor.id : '');
      document.getElementById('heizungSensorTitle').textContent = sensor ? 'Temperaturquelle bearbeiten' : 'Temperaturquelle hinzufügen';
      document.getElementById('heizungSensorName').value = sensor ? sensor.name : '';
      document.getElementById('heizungSensorTopic').value = sensor ? sensor.topic : '';
      document.getElementById('heizungSensorDialog').showModal();
    }
    function openHeizungContact(mode, id) {
      var contact = mode === 'edit' ? heizungContacts.find(function (entry) { return entry.id === Number(id); }) : null;
      document.getElementById('heizungContactForm').action = '/heizung/raum/' + heizungRoomId + '/kontakte' + (contact ? '/' + contact.id : '');
      document.getElementById('heizungContactTitle').textContent = contact ? 'Kontakt bearbeiten' : 'Kontakt hinzufügen';
      document.getElementById('heizungContactName').value = contact ? contact.name : '';
      document.getElementById('heizungContactTopic').value = contact ? contact.topic : '';
      document.getElementById('heizungContactInverted').checked = !!(contact && contact.inverted);
      document.getElementById('heizungContactDialog').showModal();
    }
    function openHeizungDelete(kind, id, title) {
      document.getElementById('heizungDeleteForm').action = '/heizung/raum/' + heizungRoomId + '/' + kind + '/' + id + '/delete';
      document.getElementById('heizungDeleteTitle').textContent = title;
      document.getElementById('heizungDeleteDialog').showModal();
    }
    if (heizungInitialDialog) {
      var values = heizungInitialDialog.values || {};
      if (heizungInitialDialog.kind === 'sensor') {
        openHeizungSensor(heizungInitialDialog.mode, heizungInitialDialog.id);
        document.getElementById('heizungSensorName').value = values.name == null ? '' : values.name;
        document.getElementById('heizungSensorTopic').value = values.topic == null ? '' : values.topic;
      } else if (heizungInitialDialog.kind === 'contact') {
        openHeizungContact(heizungInitialDialog.mode, heizungInitialDialog.id);
        document.getElementById('heizungContactName').value = values.name == null ? '' : values.name;
        document.getElementById('heizungContactTopic').value = values.topic == null ? '' : values.topic;
      }
    }
  `;
  return renderLayout({
    title: `${room.name} – Heizung & Klima`,
    activePath: '/heizung',
    body,
    script: `${script}\n${sequences.script}`,
  });
}

module.exports = renderHeizungRoom;
