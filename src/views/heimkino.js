'use strict';

// Übersicht des Heimkino-Moduls: alle Räume mit ihrem Kinomodus, im Zeilen- und
// Blockdesign der Adapterseite. Ein Raum wird bewusst nicht als Dialog, sondern
// als eigenständige Seite geöffnet (/heimkino/raum/<id>); hier stehen nur
// Anlegen, Umbenennen, Sync-Topic, Entfernen und der Schalter selbst.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function roomNote(room) {
  if (room.lastError) return `<span class="hk-room-note hk-room-note--error" title="${escapeHtml(room.lastError)}">Fehler: ${escapeHtml(room.lastError)}</span>`;
  if (!room.lastRunAt) return '<span class="hk-room-note muted">Noch nicht ausgeführt</span>';
  return `<span class="hk-room-note muted"><span data-heimkino-time="${room.lastRunAt}"></span> · ${escapeHtml(room.lastResult)}</span>`;
}

function roomRow(room) {
  const target = room.cinemaOn ? '0' : '1';
  return `              <div class="adapter-row hk-room-row" data-room-id="${room.id}">
                <span class="adapter-col-name">
                  <a class="hk-room-link" href="/heimkino/raum/${room.id}" title="Aktionsfolgen öffnen"><strong>${escapeHtml(room.name)}</strong></a>
                  ${roomNote(room)}
                </span>
                <span class="adapter-col-addr muted hk-col-state" title="${escapeHtml(room.stateTopic)}">${escapeHtml(room.stateTopic)}</span>
                <span class="adapter-col-addr muted hk-col-remote" title="${escapeHtml(room.remoteTopic || 'Kein Sync-Topic')}">${room.remoteTopic ? escapeHtml(room.remoteTopic) : '—'}</span>
                <span class="hk-col-mode"><span class="adapter-badge adapter-badge--${room.cinemaOn ? 'on' : 'off'}">${room.cinemaOn ? 'Kinomodus an' : 'Kinomodus aus'}</span></span>
                <span class="muted hk-room-counts" title="Aktionen der Folge An / Aus">${room.onCount} An / ${room.offCount} Aus</span>
                <span class="adapter-row-actions">
                  <a class="module-toggle-btn" href="/heimkino/raum/${room.id}">Aktionsfolgen</a>
                  <form action="/heimkino/rooms/${room.id}/state" method="POST">
                    <input type="hidden" name="on" value="${target}">
                    <button type="submit" class="module-toggle-btn">Kinomodus ${room.cinemaOn ? 'aus' : 'ein'}</button>
                  </form>
                  <button type="button" class="module-toggle-btn" onclick="openHeimkinoRoomDialog('edit', ${room.id})">Bearbeiten</button>
                  <button type="button" class="module-toggle-btn button-danger" onclick="openHeimkinoRoomDelete(${room.id})">Entfernen</button>
                </span>
              </div>`;
}

function roomBlock(rooms) {
  const header = rooms.length
    ? `              <div class="adapter-row hk-room-row adapter-row--head">
                <span>Raum</span><span class="hk-col-state">Kinomodus-State</span><span class="hk-col-remote">Sync-Topic</span><span class="hk-col-mode">Zustand</span><span class="hk-room-counts">Aktionen</span><span></span>
              </div>`
    : '';
  const rows = rooms.length
    ? rooms.map(roomRow).join('\n')
    : '              <div class="adapter-row adapter-row--empty"><span class="muted">Noch kein Raum angelegt.</span></div>';
  return `          <div class="adapter-block">
            <div class="adapter-block-head">
              <div class="adapter-block-title">
                <strong>Räume</strong>
                <span class="adapter-prefix">heimkino://</span>
                <span class="muted">Jede Zustandsänderung ruft die Aktionsfolge „An" bzw. „Aus" des Raums auf.</span>
              </div>
            </div>
            <div class="adapter-rows">
${header}
${rows}
            </div>
          </div>`;
}

function roomDialog() {
  return `<dialog id="heimkinoRoomDialog" class="value-dialog"><form id="heimkinoRoomForm" method="POST" class="dialog-form">
    <div class="dialog-hero"><div><h3 id="heimkinoRoomTitle">Raum hinzufügen</h3><p class="muted">Jeder Raum bekommt unter „System / Heimkino" einen beschreibbaren Kinomodus-State mit seinem Namen.</p></div></div>
    <p id="heimkinoRoomError" class="error-text" hidden></p>
    <div class="dialog-section"><div class="dialog-grid dialog-grid--two">
      <label class="field-block"><span>Name</span><input id="heimkinoRoomName" name="name" required maxlength="100" data-no-state-picker></label>
      <label class="field-block condition-topic-field"><span>Sync-Topic (optional)</span><span class="field-hint">Wird bidirektional mit dem Kinomodus synchron gehalten</span><input id="heimkinoRoomRemote" name="remoteTopic" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label>
    </div></div>
    <div class="button-row"><button type="submit">Speichern</button><button type="button" class="secondary-button" onclick="document.getElementById('heimkinoRoomDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function deleteDialog() {
  return `<dialog id="heimkinoRoomDeleteDialog" class="value-dialog"><form id="heimkinoRoomDeleteForm" method="POST" class="dialog-form">
    <h3 id="heimkinoRoomDeleteTitle">Raum entfernen</h3>
    <p class="error-text">Der Raum, sein Kinomodus-State und beide Aktionsfolgen werden dauerhaft gelöscht.</p>
    <div class="button-row"><button class="button-danger" type="submit">Endgültig entfernen</button><button class="secondary-button" type="button" onclick="document.getElementById('heimkinoRoomDeleteDialog').close()">Abbrechen</button></div>
  </form></dialog>`;
}

function renderHeimkino({ rooms = [], error = '', message = '', initialDialog = null } = {}) {
  const safeRooms = JSON.stringify(rooms).replace(/</g, '\\u003c');
  const safeInitial = JSON.stringify(initialDialog).replace(/</g, '\\u003c');
  const body = `        <div class="panel-head"><div><h1>Heimkino</h1></div><div class="dashboard-toolbar"><button type="button" class="secondary-button" onclick="openHeimkinoRoomDialog('add')">Raum hinzufügen</button></div></div>
        ${statusText(error)}${statusText(message, 'success')}
        <div class="adapter-list hk-rooms" id="heimkinoRooms">
${roomBlock(rooms)}
        </div>
        ${roomDialog()}${deleteDialog()}`;

  const script = `
    var heimkinoRooms = ${safeRooms};
    var heimkinoInitialDialog = ${safeInitial};
    function findHeimkinoRoom(id) { return heimkinoRooms.find(function (room) { return room.id === Number(id); }); }
    function openHeimkinoRoomDialog(mode, id) {
      var room = mode === 'edit' ? findHeimkinoRoom(id) : null;
      document.getElementById('heimkinoRoomForm').action = room ? '/heimkino/rooms/' + room.id : '/heimkino/rooms';
      document.getElementById('heimkinoRoomTitle').textContent = room ? 'Raum bearbeiten' : 'Raum hinzufügen';
      document.getElementById('heimkinoRoomName').value = room ? room.name : '';
      document.getElementById('heimkinoRoomRemote').value = room ? (room.remoteTopic || '') : '';
      var error = document.getElementById('heimkinoRoomError');
      error.textContent = ''; error.hidden = true;
      document.getElementById('heimkinoRoomDialog').showModal();
    }
    function openHeimkinoRoomDelete(id) {
      var room = findHeimkinoRoom(id);
      document.getElementById('heimkinoRoomDeleteForm').action = '/heimkino/rooms/' + id + '/delete';
      document.getElementById('heimkinoRoomDeleteTitle').textContent = room ? '„' + room.name + '" entfernen' : 'Raum entfernen';
      document.getElementById('heimkinoRoomDeleteDialog').showModal();
    }
    document.querySelectorAll('[data-heimkino-time]').forEach(function (node) {
      var at = Number(node.dataset.heimkinoTime);
      if (at) node.textContent = 'Zuletzt ' + new Date(at).toLocaleString();
    });
    if (heimkinoInitialDialog) {
      openHeimkinoRoomDialog(heimkinoInitialDialog.mode === 'edit' ? 'edit' : 'add', heimkinoInitialDialog.roomId);
      var values = heimkinoInitialDialog.values || {};
      document.getElementById('heimkinoRoomName').value = values.name == null ? '' : values.name;
      document.getElementById('heimkinoRoomRemote').value = values.remoteTopic == null ? '' : values.remoteTopic;
      var err = document.getElementById('heimkinoRoomError');
      err.textContent = heimkinoInitialDialog.error || '';
      err.hidden = !err.textContent;
    }
  `;
  return renderLayout({ title: 'Heimkino', activePath: '/heimkino', body, script });
}

module.exports = renderHeimkino;
