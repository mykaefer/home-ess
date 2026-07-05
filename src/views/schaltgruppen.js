'use strict';

// Unterseite „Schaltgruppen" von Messen + Schalten. Zwei unabhängig scrollbare
// Spalten: links die Schaltgruppen (Name, optionales Remote-Topic, „Gruppe
// schaltet als Einheit") mit ihren zugeordneten Geräten, rechts schmaler die
// noch keiner Schaltgruppe zugeordneten Geräte aus Messen + Schalten. Geräte
// werden per Drag & Drop in eine Gruppe gezogen (Zuordnung) bzw. zurück in die
// rechte Spalte (Lösen). Eine Gruppe gilt als AN, sobald ein Gerät an ist; der
// Toggle schaltet alle Geräte der Gruppe gemeinsam.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function statusDotClass(statusOn) {
  if (statusOn === true) return 'ms-status-dot is-on';
  if (statusOn === false) return 'ms-status-dot is-off';
  return 'ms-status-dot is-unknown';
}

// Kompakte Geräte-Zeile (beide Spalten): Drag-Fläche, Status, Name, Leistung.
function renderActorRow(actor) {
  return `              <div class="sg-row" data-id="${actor.id}">
                <span class="widget-drag" title="Zum Zuordnen in eine Schaltgruppe ziehen" aria-hidden="true">⠿</span>
                <span class="${statusDotClass(actor.statusOn)}" id="sg-status-${actor.id}"></span>
                <span class="sg-row-name">${escapeHtml(actor.name)}</span>
                <span class="sg-row-power" id="sg-power-${actor.id}">${escapeHtml(actor.powerDisplay)}</span>
              </div>`;
}

// Geräteliste einer Dropzone. Ohne Geräte bleibt die Zone wirklich leer
// (kein Whitespace), damit der CSS-:empty-Platzhalter greift.
function renderActorList(actors, groupId) {
  const rows = actors.length ? `\n${actors.map(renderActorRow).join('\n')}\n            ` : '';
  return `<div class="sg-dropzone" data-group="${groupId == null ? '' : groupId}">${rows}</div>`;
}

function renderGroupCard(group) {
  const unitBadge = group.switchAsUnit
    ? '<span class="sg-badge" title="Gruppe schaltet als Einheit: Jede Ein-/Ausschaltflanke zieht die übrigen mit.">Einheit</span>'
    : '';
  const remoteBadge = group.remoteTopic
    ? `<span class="sg-badge sg-badge--remote" title="Remote-Topic: ${escapeHtml(group.remoteTopic)}">Remote</span>`
    : '';
  const timerBadge = group.timerMinutes > 0
    ? `<span class="sg-badge" title="Schaltet die ganze Gruppe nach ${escapeHtml(group.timerMinutes)} Minuten aus">Timer ${escapeHtml(group.timerMinutes)} min</span>`
    : '';
  return `          <div class="sg-group" data-group-id="${group.id}">
            <div class="sg-group-head">
              <span class="${statusDotClass(group.on)}" id="sg-group-status-${group.id}" title="Schaltzustand der Gruppe (an, sobald ein Gerät an ist)"></span>
              <span class="sg-group-title">${escapeHtml(group.name)}</span>
              <span class="sg-group-count" id="sg-group-count-${group.id}">${group.actors.length}</span>
              ${unitBadge}
              ${remoteBadge}
              ${timerBadge}
              <label class="ms-toggle" title="Gruppe schalten: Einschalten schaltet alle Geräte ein, Ausschalten alle aus."><input type="checkbox" id="sg-switch-${group.id}" onchange="toggleGroup(${group.id}, this.checked)"${group.on === true ? ' checked' : ''}><span class="ms-toggle-slider"></span></label>
              <div class="widget-actions">
                <button type="button" class="widget-icon-btn" title="Schaltgruppe bearbeiten" onclick="openGroupDialog('edit', ${group.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Schaltgruppe entfernen" onclick="openDeleteGroupDialog(${group.id}, ${toJsStringLiteral(group.name)})">🗑</button>
              </div>
            </div>
            <div class="sg-group-body">${renderActorList(group.actors, group.id)}</div>
          </div>`;
}

function renderGroupDialog() {
  return `        <dialog id="sgGroupDialog" class="value-dialog">
          <form id="sgGroupForm" action="/messen-schalten/schaltgruppen" method="POST" class="dialog-form">
            <h3 id="sgGroupDialogTitle">Schaltgruppe hinzufügen</h3>
            <div id="sgGroupDialogError"></div>
            <div class="dialog-grid">
              <label class="field-block" for="sgName"><span>Name</span>
                <input type="text" id="sgName" name="name" required></label>
              <label class="field-block" for="sgRemote"><span>Remote-Topic <span class="pool-optional">(optional)</span></span>
                <input type="text" id="sgRemote" name="remoteTopic" placeholder="z.B. schaltgruppen.wohnzimmer">
                <small class="muted">Wird bidirektional mit dem Schaltzustand der Gruppe synchron gehalten.</small></label>
              <label class="remember-row remember-row--boxed" for="sgSwitchAsUnit">
                <input type="checkbox" id="sgSwitchAsUnit" name="switchAsUnit" value="on">
                <span>Gruppe schaltet als Einheit</span></label>
              <label class="field-block" for="sgTimerMinutes"><span>Timer (Minuten) <span class="pool-optional">(optional)</span></span>
                <input type="number" id="sgTimerMinutes" name="timerMinutes" min="0" max="525600" step="1" placeholder="0 = aus">
                <small class="muted">Nach Ablauf wird die gesamte Gruppe ausgeschaltet.</small></label>
              <p class="muted">Als Einheit: Wird ein Gerät ein- oder ausgeschaltet, werden die übrigen in denselben Zustand mitgezogen. Ohne diese Option gilt die Gruppe als an, sobald mindestens ein Gerät an ist.</p>
            </div>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeGroupDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteGroupDialog() {
  return `        <dialog id="sgDeleteGroupDialog" class="value-dialog">
          <form id="sgDeleteGroupForm" method="POST" class="dialog-form">
            <h3>Schaltgruppe entfernen</h3>
            <p class="muted">Soll die Schaltgruppe <strong id="sgDeleteGroupName"></strong> entfernt werden? Die zugeordneten Geräte bleiben als freie Geräte erhalten.</p>
            <div class="button-row">
              <button type="submit" class="button-danger">Ja, entfernen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteGroupDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderSchaltgruppen({
  groups = [],
  unassigned = [],
  groupConfigs = [],
  formMessage = '',
  formError = '',
  groupDialogOpen = false,
  groupDialogError = '',
} = {}) {
  const groupBlocks = groups.length
    ? groups.map(renderGroupCard).join('\n')
    : '          <p class="muted sg-empty-hint">Noch keine Schaltgruppe angelegt. Lege über „Schaltgruppe hinzufügen" die erste Gruppe an.</p>';

  const body = `        <div class="panel-head">
          <div>
            <h1>Schaltgruppen</h1>
            <p class="muted">Eine Schaltgruppe gilt als eingeschaltet, sobald eines ihrer Geräte an ist. Ihr Schaltzustand steht in der <a href="/states">States-Liste</a> (Kategorie Schaltgruppen) und im Wertekatalog zur Weiterverarbeitung bereit.</p>
          </div>
          <div class="dashboard-toolbar">
            <button type="button" class="secondary-button" onclick="openGroupDialog('add')">Schaltgruppe hinzufügen</button>
          </div>
        </div>
        ${statusText(formError)}
        ${statusText(formMessage, 'success')}

        <div class="sg-layout">
          <div class="sg-col sg-col--groups" id="sgGroupsColumn">
${groupBlocks}
          </div>
          <div class="sg-col sg-col--pool">
            <div class="sg-pool-head">
              <span class="sg-group-title">Nicht zugeordnete Geräte</span>
              <span class="sg-group-count" id="sg-group-count-none">${unassigned.length}</span>
            </div>
            <p class="muted sg-pool-hint">Geräte aus Messen + Schalten ohne Schaltgruppe. Zum Zuordnen in eine Gruppe ziehen; zum Lösen wieder hierher ziehen.</p>
            <div class="sg-group-body">${renderActorList(unassigned, null)}</div>
          </div>
        </div>

        ${renderGroupDialog()}
        ${renderDeleteGroupDialog()}`;

  const script = `
    var groupConfigs = ${JSON.stringify(groupConfigs)};
    var initialGroupDialogOpen = ${groupDialogOpen ? 'true' : 'false'};
    var initialGroupDialogError = ${JSON.stringify(groupDialogError || '')};
    var draggedCard = null, dropZone = null;

    // --- Dialoge ------------------------------------------------------------
    function openGroupDialog(mode, groupId) {
      var dialog = document.getElementById('sgGroupDialog');
      if (!dialog) return;
      var form = document.getElementById('sgGroupForm');
      var title = document.getElementById('sgGroupDialogTitle');
      document.getElementById('sgGroupDialogError').innerHTML = '';
      if (mode === 'edit' && groupId != null) {
        form.action = '/messen-schalten/schaltgruppen/' + groupId;
        title.textContent = 'Schaltgruppe bearbeiten';
        var cfg = null;
        for (var i = 0; i < groupConfigs.length; i++) {
          if (groupConfigs[i].id === groupId) { cfg = groupConfigs[i]; break; }
        }
        document.getElementById('sgName').value = cfg ? cfg.name : '';
        document.getElementById('sgRemote').value = cfg ? cfg.remoteTopic : '';
        document.getElementById('sgSwitchAsUnit').checked = !!(cfg && cfg.switchAsUnit);
        document.getElementById('sgTimerMinutes').value = cfg && cfg.timerMinutes > 0 ? cfg.timerMinutes : '';
      } else {
        form.action = '/messen-schalten/schaltgruppen';
        title.textContent = 'Schaltgruppe hinzufügen';
        document.getElementById('sgName').value = '';
        document.getElementById('sgRemote').value = '';
        document.getElementById('sgSwitchAsUnit').checked = false;
        document.getElementById('sgTimerMinutes').value = '';
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeGroupDialog() { var d = document.getElementById('sgGroupDialog'); if (d) d.close(); }

    function openDeleteGroupDialog(id, name) {
      var dialog = document.getElementById('sgDeleteGroupDialog');
      if (!dialog) return;
      document.getElementById('sgDeleteGroupName').textContent = name;
      document.getElementById('sgDeleteGroupForm').action = '/messen-schalten/schaltgruppen/' + id + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeDeleteGroupDialog() { var d = document.getElementById('sgDeleteGroupDialog'); if (d) d.close(); }

    // --- Gruppe schalten ------------------------------------------------------
    function toggleGroup(id, on) {
      fetch('/messen-schalten/schaltgruppen/' + id + '/switch/' + (on ? '1' : '0'), { method: 'POST' })
        .then(function () { setTimeout(refreshValues, 500); })
        .catch(function () {});
    }

    // --- Drag & Drop (Zuordnung Gerät -> Schaltgruppe) -----------------------
    function setupCard(card) {
      var handle = card.querySelector('.widget-drag');
      if (handle) {
        handle.addEventListener('mousedown', function () { card.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup', function () { card.removeAttribute('draggable'); });
      }
      card.addEventListener('dragstart', function (event) {
        draggedCard = card; dropZone = null;
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        if (event.dataTransfer.setData) event.dataTransfer.setData('text/plain', card.dataset.id);
      });
      card.addEventListener('dragend', function () {
        applyDrop();
        card.classList.remove('dragging'); card.removeAttribute('draggable');
        draggedCard = null; dropZone = null;
        clearDropIndicators(); updateCounts();
      });
    }

    function setupZone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedCard) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        dropZone = zone;
        clearDropIndicators();
        zone.classList.add('drag-over');
      });
      zone.addEventListener('drop', function (event) { event.preventDefault(); });
    }

    function clearDropIndicators() {
      var zones = document.querySelectorAll('.sg-dropzone.drag-over');
      for (var i = 0; i < zones.length; i++) zones[i].classList.remove('drag-over');
    }

    function applyDrop() {
      if (!draggedCard || !dropZone) return;
      var from = draggedCard.parentNode;
      if (from === dropZone) return;
      dropZone.appendChild(draggedCard);
      var groupId = dropZone.dataset.group ? Number(dropZone.dataset.group) : null;
      fetch('/messen-schalten/schaltgruppen/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorId: Number(draggedCard.dataset.id), groupId: groupId })
      }).then(function () { setTimeout(refreshValues, 300); }).catch(function () {});
    }

    function updateCounts() {
      var zones = document.querySelectorAll('.sg-dropzone');
      for (var z = 0; z < zones.length; z++) {
        var badge = document.getElementById('sg-group-count-' + (zones[z].dataset.group || 'none'));
        if (badge) badge.textContent = zones[z].querySelectorAll('.sg-row').length;
      }
    }

    function initDragAndDrop() {
      var cards = document.querySelectorAll('.sg-row');
      for (var i = 0; i < cards.length; i++) setupCard(cards[i]);
      var zones = document.querySelectorAll('.sg-dropzone');
      for (var j = 0; j < zones.length; j++) setupZone(zones[j]);
    }

    // --- Live-Aktualisierung --------------------------------------------------
    function applyStatusDot(el, statusOn) {
      if (!el) return;
      el.className = 'ms-status-dot ' + (statusOn === true ? 'is-on' : statusOn === false ? 'is-off' : 'is-unknown');
    }

    async function refreshValues() {
      try {
        var res = await fetch('/messen-schalten/schaltgruppen/data', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        var data = await res.json();
        (data.actors || []).forEach(function (a) {
          applyStatusDot(document.getElementById('sg-status-' + a.id), a.statusOn);
          var power = document.getElementById('sg-power-' + a.id);
          if (power) power.textContent = a.powerDisplay;
        });
        (data.groups || []).forEach(function (g) {
          applyStatusDot(document.getElementById('sg-group-status-' + g.id), g.on);
          var sw = document.getElementById('sg-switch-' + g.id);
          if (sw) sw.checked = g.on === true;
        });
      } catch (_) {}
    }

    var refreshQueued = false;
    function queueRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(function () { refreshQueued = false; refreshValues(); }, 1000);
    }

    initDragAndDrop();
    refreshValues();
    window.addEventListener('homeess:mqtt', queueRefresh);
    setInterval(refreshValues, 30000);

    if (initialGroupDialogOpen) openGroupDialog('add');
    if (initialGroupDialogError) {
      document.getElementById('sgGroupDialogError').innerHTML = '<p class="error-text"></p>';
      document.querySelector('#sgGroupDialogError .error-text').textContent = initialGroupDialogError;
    }`;

  return renderLayout({ title: 'Schaltgruppen', activePath: '/messen-schalten/schaltgruppen', body, script });
}

function toJsStringLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

module.exports = renderSchaltgruppen;
