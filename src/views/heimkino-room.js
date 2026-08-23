'use strict';

// Eigenständige Seite eines Heimkino-Raums: die beiden Aktionsfolgen „An" und
// „Aus" in Liste und Design der Bedingungen. Liste, Dialoge und Drag&Drop kommen
// aus dem geteilten Baustein views/action-sequences.js (auch von „Heizung &
// Klima" verwendet); hier steht nur der Rahmen der Raumseite.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { renderActionSequences } = require('./action-sequences');

const PHASES = [
  { key: 'on', label: 'Aktionsfolge An', hint: 'Läuft, sobald der Kinomodus eingeschaltet wird.' },
  { key: 'off', label: 'Aktionsfolge Aus', hint: 'Läuft, sobald der Kinomodus ausgeschaltet wird.' },
];

function renderHeimkinoRoom({ room = null, tree = { on: [], off: [] }, actions = [], error = '', message = '', initialDialog = null } = {}) {
  const roomId = room ? room.id : 0;
  const sequences = renderActionSequences({
    prefix: 'hk',
    ns: 'Heimkino',
    varPrefix: 'heimkino',
    storageKey: 'homeess.heimkino.expanded.v1',
    basePath: `/heimkino/raum/${roomId}`,
    ownerId: roomId,
    phases: PHASES,
    tree,
    actions,
    initialDialog,
  });

  const toggleTarget = room && room.cinemaOn ? '0' : '1';
  const body = `        <div class="panel-head">
          <div>
            <h1>${escapeHtml(room ? room.name : 'Raum')}</h1>
            <p class="muted">Kinomodus-State: <code>${escapeHtml(room ? room.stateTopic : '')}</code>${room && room.remoteTopic ? ` · Sync-Topic: <code>${escapeHtml(room.remoteTopic)}</code>` : ''}</p>
          </div>
          <div class="dashboard-toolbar">
            <a class="secondary-button" href="/heimkino">Zurück zur Übersicht</a>
            <form action="/heimkino/rooms/${roomId}/state" method="POST" class="hk-inline-form">
              <input type="hidden" name="redirect" value="room">
              <input type="hidden" name="on" value="${toggleTarget}">
              <button type="submit" class="secondary-button">Kinomodus ${room && room.cinemaOn ? 'ausschalten' : 'einschalten'}</button>
            </form>
          </div>
        </div>
        ${statusText(error)}${statusText(message, 'success')}
        <p class="hk-state-line"><span class="condition-enabled ${room && room.cinemaOn ? 'is-enabled' : 'is-disabled'}">${room && room.cinemaOn ? 'Kinomodus an' : 'Kinomodus aus'}</span>${room && room.lastResult ? ` <span class="muted">${escapeHtml(room.lastResult)}</span>` : ''}${room && room.lastError ? ` <span class="error-text hk-inline-error">${escapeHtml(room.lastError)}</span>` : ''}</p>
${sequences.body}`;

  return renderLayout({
    title: `Heimkino – ${room ? room.name : ''}`,
    activePath: '/heimkino',
    body,
    script: sequences.script,
  });
}

module.exports = renderHeimkinoRoom;
