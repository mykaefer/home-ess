'use strict';

// Seite „Messen + Schalten" (Vorbild: views/dashboard.js). Frei anlegbare Gruppen
// und Geräte-Kacheln, per Drag&Drop anordbar (auch zwischen/ohne Gruppen). Jede
// Kachel fasst Status, Leistung und Zähler zusammen; Geräte mit Schalt-Topic
// erhalten einen An/Aus-Toggle (Wunschzustand, wird über das Betriebslevel gegatet).
// Gruppen zeigen die Verbrauchssumme (Leistung) ihrer Geräte in der Titelzeile.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { FUNCTIONS } = require('../messen-schalten/functions');

// Dropdown „Funktion": Gruppen vererben ihre Funktion an Geräte ohne eigene
// Zuordnung; die Prognose lernt je Funktion ein eigenes Stundenprofil.
function functionOptions(selected, emptyLabel) {
  const options = [`<option value=""${!selected ? ' selected' : ''}>${escapeHtml(emptyLabel)}</option>`];
  for (const fn of FUNCTIONS) {
    options.push(`<option value="${fn.key}"${fn.key === selected ? ' selected' : ''}>${escapeHtml(fn.label)}</option>`);
  }
  return options.join('');
}

function priorityOptions(selected, def) {
  const val = selected != null ? Number(selected) : def;
  return [1, 2, 3, 4, 5].map((n) => {
    const label = n === 1 ? '1 – höchste' : n === 5 ? '5 – niedrigste' : String(n);
    return `<option value="${n}"${n === val ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

function unitOptions(units, selected) {
  return units.map((u) => `<option value="${u}"${u === selected ? ' selected' : ''}>${u}</option>`).join('');
}

function statusDotClass(statusOn) {
  if (statusOn === true) return 'ms-status-dot is-on';
  if (statusOn === false) return 'ms-status-dot is-off';
  return 'ms-status-dot is-unknown';
}

// Anzeigetext der aktiven (effektiven) Priorität eines Geräts.
function priorityText(priority, fromGroup) {
  return `Priorität ${priority}${fromGroup ? ' (Gruppe)' : ''}`;
}

// Meta-Zeile je Gerät: Messen-only, „Immer an" (mit aktiver Priorität) oder manuell.
function metaLabel(actor) {
  if (!actor.hasSwitch) return 'nur Messen';
  if (actor.alwaysOn) return `Immer an · ${priorityText(actor.priority, actor.priorityFromGroup)}`;
  return 'manuell';
}

function actorCardHead(actor) {
  return `              <div class="widget-card-head">
                <span class="widget-drag" title="Zum Verschieben ziehen" aria-hidden="true">⠿</span>
                <div class="widget-actions">
                  <button type="button" class="widget-icon-btn" title="Gerät bearbeiten" onclick="openActorDialog('edit', ${actor.id})">✎</button>
                  <button type="button" class="widget-icon-btn" title="Gerät entfernen" onclick="openDeleteActorDialog(${actor.id}, ${toJsStringLiteral(actor.name)})">🗑</button>
                </div>
              </div>`;
}

function renderActorCard(actor) {
  // Manueller Toggle nur bei Geräten mit Schalt-Topic OHNE „Immer an". Auch dieser
  // Schaltweg wird durch Betriebslevel und Priorität freigegeben.
  const toggle = actor.hasSwitch && !actor.alwaysOn
    ? `              <label class="ms-toggle" title="Ein-/Ausschalten (Einschalten nur bei freigegebener Priorität)">
                <input type="checkbox" id="ms-switch-${actor.id}" onchange="toggleActor(${actor.id}, this.checked)"${actor.statusOn === true ? ' checked' : ''}>
                <span class="ms-toggle-slider"></span>
              </label>`
    : '';
  const counterRow = actor.hasCounter
    ? `                <div class="ms-counter" id="ms-counter-${actor.id}">${escapeHtml(actor.counterDisplay)}</div>`
    : '';
  const muted = !actor.hasSwitch || (actor.hasSwitch && !actor.alwaysOn);
  return `            <div class="widget-card ms-actor-card" data-id="${actor.id}">
${actorCardHead(actor)}
              <div class="ms-actor-title">
                <span class="${statusDotClass(actor.statusOn)}" id="ms-status-${actor.id}" title="Status"></span>
                <span class="widget-label">${escapeHtml(actor.name)}</span>
              </div>
              <div class="ms-actor-body">
                <div class="widget-value" id="ms-power-${actor.id}">${escapeHtml(actor.powerDisplay)}</div>
${counterRow}
              </div>
              <div class="ms-prio${muted ? ' ms-prio--muted' : ''}" id="ms-prio-${actor.id}" title="Betriebsart bzw. aktive Priorität, auf die dieses Gerät beim Betriebslevel reagiert">${escapeHtml(metaLabel(actor))}</div>
${toggle}
            </div>`;
}

function renderGroup(group) {
  return `          <div class="widget-group ms-group" data-group-id="${group.id}">
            <div class="widget-group-head">
              <span class="widget-group-drag" title="Gruppe verschieben" aria-hidden="true">⠿</span>
              <span class="widget-group-title">${escapeHtml(group.title)}</span>
              <span class="ms-group-prio" title="Priorität der Gruppe (Geräte mit „Priorität der Gruppe verwenden" erben sie)">Priorität ${Number(group.priority)}</span>
              <span class="ms-group-sum" id="ms-group-sum-${group.id}" title="Verbrauchssumme (Leistung)">${escapeHtml(group.sumDisplay)}</span>
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Gruppe bearbeiten" onclick="openGroupDialog('edit', ${group.id}, ${toJsStringLiteral(group.title)}, ${Number(group.priority)}, ${toJsStringLiteral(group.functionKey || '')})">✎</button>
                <button type="button" class="widget-icon-btn" title="Gruppe entfernen" onclick="openDeleteGroupDialog(${group.id}, ${toJsStringLiteral(group.title)})">🗑</button>
              </div>
            </div>
            <div class="widget-dropzone widget-grid" data-group="${group.id}">
${group.actors.map(renderActorCard).join('\n')}
            </div>
          </div>`;
}

function renderActorDialog({ groupsForSelect }) {
  return `        <dialog id="actorDialog" class="value-dialog">
          <form id="actorForm" action="/messen-schalten/actors" method="POST" class="dialog-form dialog-form--plant">
            <div class="dialog-hero">
              <div>
                <h3 id="actorDialogTitle">Gerät hinzufügen</h3>
                <p class="muted">Mindestens ein Topic für Schalten, Leistung oder Zähler ist erforderlich.</p>
              </div>
            </div>
            <div id="actorDialogError"></div>

            <div class="dialog-section">
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="msName"><span>Name</span>
                  <input type="text" id="msName" name="name" required></label>
                <label class="field-block" for="msGroup"><span>Gruppe</span>
                  <select id="msGroup" name="groupId">
                    <option value="">Keine Gruppe</option>
                    ${groupsForSelect.map((g) => `<option value="${g.id}">${escapeHtml(g.title)}</option>`).join('')}
                  </select></label>
                <label class="field-block" for="msFunction"><span>Funktion <span class="pool-optional">(für die Prognose-Statistik)</span></span>
                  <select id="msFunction" name="functionKey">${functionOptions('', 'Wie Gruppe (bzw. keine)')}</select></label>
              </div>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>MQTT-Topics</h4>
                <p class="muted">Ohne Status-Topic gilt das Schalt-Topic als Ist-Stand. Ist nur ein Zähler gesetzt, wird die Leistung aus dem Zählerfortschritt abgeleitet (0 W nach über 10 min ohne Fortschritt).</p></div>
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="msSwitch"><span>Schalten-Topic <span class="pool-optional">(an/aus)</span></span>
                  <input type="text" id="msSwitch" name="switchTopic" placeholder="z.B. steckdose.0.state"></label>
                <label class="field-block" for="msStatus"><span>Status-Topic <span class="pool-optional">(optional)</span></span>
                  <input type="text" id="msStatus" name="statusTopic" placeholder="z.B. steckdose.0.actual"></label>
                <label class="field-block" for="msPower"><span>Leistungs-Topic <span class="pool-optional">(optional)</span></span>
                  <div class="topic-input-row">
                    <input type="text" id="msPower" name="powerTopic" placeholder="z.B. steckdose.0.power">
                    <select name="powerUnit" aria-label="Leistungseinheit">${unitOptions(['W', 'kW'], 'W')}</select>
                  </div></label>
                <label class="field-block" for="msCounter"><span>Zähler-Topic <span class="pool-optional">(optional)</span></span>
                  <div class="topic-input-row">
                    <input type="text" id="msCounter" name="counterTopic" placeholder="z.B. steckdose.0.energy">
                    <select name="counterUnit" aria-label="Zählereinheit">${unitOptions(['Wh', 'kWh'], 'kWh')}</select>
                  </div></label>
              </div>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>Betriebsart & Priorität</h4>
                <p class="muted"><strong>Alle Geräte</strong> werden ausgeschaltet, sobald das Betriebslevel ihre Priorität unterschreitet. <strong>Immer an:</strong> Bei erneuter Freigabe schaltet das Gerät automatisch wieder ein; andernfalls bleibt es bis zum manuellen Einschalten aus. Priorität = Betriebslevel, ab dem das Gerät laufen darf (1 = immer, 5 = nur bei Überschuss).</p></div>
              <div class="dialog-grid dialog-grid--two">
                <label class="remember-row remember-row--boxed" for="msAlwaysOn" style="align-self:end;">
                  <input type="checkbox" id="msAlwaysOn" name="alwaysOn" value="on">
                  <span>Immer an (automatisch übers Betriebslevel)</span></label>
                <label class="field-block" for="msPriority"><span>Priorität</span>
                  <select id="msPriority" name="priority">${priorityOptions(4, 4)}</select></label>
                <label class="remember-row remember-row--boxed" for="msUseGroupPriority" style="align-self:end;">
                  <input type="checkbox" id="msUseGroupPriority" name="useGroupPriority" value="on">
                  <span>Priorität der Gruppe verwenden</span></label>
              </div>
            </div>

            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeActorDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderGroupDialog() {
  return `        <dialog id="groupDialog" class="value-dialog">
          <form id="groupForm" action="/messen-schalten/groups" method="POST" class="dialog-form">
            <h3 id="groupDialogTitle">Gruppe hinzufügen</h3>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block" for="groupTitle"><span>Titel</span>
                <input type="text" id="groupTitle" name="title" required></label>
              <label class="field-block" for="groupPriority"><span>Priorität</span>
                <select id="groupPriority" name="priority">${priorityOptions(4, 4)}</select></label>
              <label class="field-block" for="groupFunction"><span>Funktion <span class="pool-optional">(Geräte ohne eigene Funktion erben sie)</span></span>
                <select id="groupFunction" name="functionKey">${functionOptions('', 'Keine Funktion')}</select></label>
            </div>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeGroupDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteActorDialog() {
  return `        <dialog id="deleteActorDialog" class="value-dialog">
          <form id="deleteActorForm" method="POST" class="dialog-form">
            <h3>Gerät entfernen</h3>
            <p class="muted">Soll das Gerät <strong id="deleteActorName"></strong> wirklich entfernt werden?</p>
            <div class="button-row">
              <button type="submit" class="button-danger">Ja, entfernen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteActorDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteGroupDialog() {
  return `        <dialog id="deleteGroupDialog" class="value-dialog">
          <form id="deleteGroupForm" method="POST" class="dialog-form">
            <h3>Gruppe entfernen</h3>
            <p class="muted">Soll die Gruppe <strong id="deleteGroupName"></strong> entfernt werden? Die enthaltenen Geräte bleiben als freie Geräte erhalten.</p>
            <div class="button-row">
              <button type="submit" class="button-danger">Ja, entfernen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteGroupDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderMessenSchalten({
  ungrouped = [],
  groups = [],
  groupsForSelect = [],
  actorConfigs = [],
  formMessage = '',
  formError = '',
  dialogMode = '',
  dialogError = '',
  dialogValues = null,
  editingActorId = null,
  groupDialogOpen = false,
  groupDialogError = '',
} = {}) {
  const body = `        <div class="panel-head">
          <div>
            <h1>Messen + Schalten</h1>
          </div>
          <div class="dashboard-toolbar">
            <button type="button" class="secondary-button" onclick="openGroupDialog('add')">Gruppe hinzufügen</button>
            <button type="button" class="secondary-button" onclick="openActorDialog('add')">Gerät hinzufügen</button>
          </div>
        </div>
        ${statusText(formError)}
        ${statusText(formMessage, 'success')}
        ${groupDialogError ? statusText(groupDialogError) : ''}

        <div class="widget-dropzone widget-grid" data-group="">
${ungrouped.map(renderActorCard).join('\n')}
        </div>

        <div class="widget-groups" id="groupsContainer">
${groups.map(renderGroup).join('\n')}
        </div>

        ${renderActorDialog({ groupsForSelect })}
        ${renderGroupDialog()}
        ${renderDeleteActorDialog()}
        ${renderDeleteGroupDialog()}`;

  const script = `
    var actorConfigs = ${JSON.stringify(actorConfigs)};
    var initialDialogMode = ${JSON.stringify(dialogMode)};
    var initialEditingActorId = ${editingActorId == null ? 'null' : Number(editingActorId)};
    var initialDialogValues = ${JSON.stringify(dialogValues || {})};
    var initialGroupDialogOpen = ${groupDialogOpen ? 'true' : 'false'};
    var initialDialogError = ${JSON.stringify(dialogError || '')};
    var draggedCard = null, dropZone = null, dropRef = null;
    var draggedGroup = null, groupDropRef = null;

    // --- Dialoge ------------------------------------------------------------
    function setActorFormValues(v) {
      v = v || {};
      document.getElementById('msName').value = v.name || '';
      document.getElementById('msGroup').value = v.groupId == null ? '' : String(v.groupId);
      document.getElementById('msSwitch').value = v.switchTopic || '';
      document.getElementById('msStatus').value = v.statusTopic || '';
      document.getElementById('msPower').value = v.powerTopic || '';
      document.getElementById('msCounter').value = v.counterTopic || '';
      document.querySelector('#actorDialog [name=powerUnit]').value = v.powerUnit || 'W';
      document.querySelector('#actorDialog [name=counterUnit]').value = v.counterUnit || 'kWh';
      document.getElementById('msPriority').value = v.priority == null ? 4 : v.priority;
      document.getElementById('msUseGroupPriority').checked = v.useGroupPriority === true;
      document.getElementById('msAlwaysOn').checked = v.alwaysOn === true;
      document.getElementById('msFunction').value = v.functionKey || '';
    }

    function openActorDialog(mode, actorId) {
      var dialog = document.getElementById('actorDialog');
      if (!dialog) return;
      var form = document.getElementById('actorForm');
      var title = document.getElementById('actorDialogTitle');
      document.getElementById('actorDialogError').innerHTML = '';
      if (mode === 'edit' && actorId != null) {
        form.action = '/messen-schalten/actors/' + actorId;
        title.textContent = 'Gerät bearbeiten';
        var cfg = null;
        for (var i = 0; i < actorConfigs.length; i++) {
          if (actorConfigs[i].id === actorId) { cfg = actorConfigs[i]; break; }
        }
        if (cfg) setActorFormValues(cfg);
      } else {
        form.action = '/messen-schalten/actors';
        title.textContent = 'Gerät hinzufügen';
        setActorFormValues({ priority: 4, powerUnit: 'W', counterUnit: 'kWh' });
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeActorDialog() { var d = document.getElementById('actorDialog'); if (d) d.close(); }

    function openGroupDialog(mode, groupId, groupTitle, groupPriority, groupFunction) {
      var dialog = document.getElementById('groupDialog');
      if (!dialog) return;
      var form = document.getElementById('groupForm');
      var title = document.getElementById('groupDialogTitle');
      if (mode === 'edit' && groupId != null) {
        form.action = '/messen-schalten/groups/' + groupId;
        title.textContent = 'Gruppe bearbeiten';
        document.getElementById('groupTitle').value = groupTitle || '';
        document.getElementById('groupPriority').value = groupPriority || 4;
        document.getElementById('groupFunction').value = groupFunction || '';
      } else {
        form.action = '/messen-schalten/groups';
        title.textContent = 'Gruppe hinzufügen';
        document.getElementById('groupTitle').value = '';
        document.getElementById('groupPriority').value = 4;
        document.getElementById('groupFunction').value = '';
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeGroupDialog() { var d = document.getElementById('groupDialog'); if (d) d.close(); }

    function openDeleteActorDialog(id, name) {
      var dialog = document.getElementById('deleteActorDialog');
      if (!dialog) return;
      document.getElementById('deleteActorName').textContent = name;
      document.getElementById('deleteActorForm').action = '/messen-schalten/actors/' + id + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeDeleteActorDialog() { var d = document.getElementById('deleteActorDialog'); if (d) d.close(); }

    function openDeleteGroupDialog(id, title) {
      var dialog = document.getElementById('deleteGroupDialog');
      if (!dialog) return;
      document.getElementById('deleteGroupName').textContent = title;
      document.getElementById('deleteGroupForm').action = '/messen-schalten/groups/' + id + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeDeleteGroupDialog() { var d = document.getElementById('deleteGroupDialog'); if (d) d.close(); }

    // --- Schalten -----------------------------------------------------------
    function toggleActor(id, on) {
      fetch('/messen-schalten/actor/' + id + '/switch/' + (on ? '1' : '0'), { method: 'POST' })
        .then(function (response) { return response.json(); })
        .then(function (result) {
          var toggle = document.getElementById('ms-switch-' + id);
          if (toggle && result.blocked) toggle.checked = false;
          setTimeout(refreshValues, 300);
        })
        .catch(function () {});
    }

    // --- Drag & Drop (Geräte) ----------------------------------------------
    function setupCard(card) {
      var handle = card.querySelector('.widget-drag');
      if (handle) {
        handle.addEventListener('mousedown', function () { card.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup', function () { card.removeAttribute('draggable'); });
      }
      card.addEventListener('dragstart', function (event) {
        draggedCard = card; dropZone = null; dropRef = null;
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        if (event.dataTransfer.setData) event.dataTransfer.setData('text/plain', card.dataset.id);
      });
      card.addEventListener('dragend', function () {
        applyDrop();
        card.classList.remove('dragging'); card.removeAttribute('draggable');
        draggedCard = null; dropZone = null; dropRef = null;
        clearDropIndicators(); persistLayout();
      });
    }

    function insertionReference(zone, x, y) {
      var cards = zone.querySelectorAll('.widget-card:not(.dragging)');
      if (!cards.length) return null;
      var nearest = null, nearestDist = Infinity;
      for (var i = 0; i < cards.length; i++) {
        var box = cards[i].getBoundingClientRect();
        var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        var dist = Math.hypot(x - cx, y - cy);
        if (dist < nearestDist) { nearestDist = dist; nearest = { el: cards[i], cx: cx, cy: cy, h: box.height }; }
      }
      if (!nearest) return null;
      var before = (y < nearest.cy - nearest.h / 2) || (Math.abs(y - nearest.cy) <= nearest.h / 2 && x < nearest.cx);
      var ref = before ? nearest.el : nearest.el.nextElementSibling;
      if (ref === draggedCard) ref = draggedCard.nextElementSibling;
      return ref;
    }

    function setupZone(zone) {
      zone.addEventListener('dragover', function (event) {
        if (!draggedCard) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        dropZone = zone;
        dropRef = insertionReference(zone, event.clientX, event.clientY);
        clearDropIndicators();
        zone.classList.add('drag-over');
        if (dropRef && dropRef !== draggedCard) {
          dropRef.classList.add('drop-before');
        } else {
          var rest = zone.querySelectorAll('.widget-card:not(.dragging)');
          if (rest.length) rest[rest.length - 1].classList.add('drop-after');
        }
      });
      zone.addEventListener('drop', function (event) { event.preventDefault(); });
    }

    function clearDropIndicators() {
      var marked = document.querySelectorAll('.widget-card.drop-before, .widget-card.drop-after');
      for (var i = 0; i < marked.length; i++) { marked[i].classList.remove('drop-before'); marked[i].classList.remove('drop-after'); }
      var zones = document.querySelectorAll('.widget-dropzone.drag-over');
      for (var j = 0; j < zones.length; j++) zones[j].classList.remove('drag-over');
    }

    function applyDrop() {
      if (!draggedCard || !dropZone) return;
      if (dropRef == null) dropZone.appendChild(draggedCard);
      else if (dropRef !== draggedCard) dropZone.insertBefore(draggedCard, dropRef);
    }

    function persistLayout() {
      var items = [];
      var zones = document.querySelectorAll('.widget-dropzone');
      for (var z = 0; z < zones.length; z++) {
        var groupId = zones[z].dataset.group ? Number(zones[z].dataset.group) : null;
        var cards = zones[z].querySelectorAll('.widget-card');
        for (var c = 0; c < cards.length; c++) {
          items.push({ id: Number(cards[c].dataset.id), groupId: groupId, position: c });
        }
      }
      fetch('/messen-schalten/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actors: items })
      }).then(function () { setTimeout(refreshValues, 300); }).catch(function () {});
    }

    // --- Drag & Drop (Gruppen) ---------------------------------------------
    function setupGroup(groupEl) {
      var handle = groupEl.querySelector('.widget-group-drag');
      if (handle) {
        handle.addEventListener('mousedown', function () { groupEl.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup', function () { groupEl.removeAttribute('draggable'); });
      }
      groupEl.addEventListener('dragstart', function (event) {
        if (groupEl.getAttribute('draggable') !== 'true') return;
        event.stopPropagation();
        draggedGroup = groupEl; groupDropRef = null;
        groupEl.classList.add('group-dragging');
        event.dataTransfer.effectAllowed = 'move';
        if (event.dataTransfer.setData) event.dataTransfer.setData('text/plain', 'group:' + groupEl.dataset.groupId);
      });
      groupEl.addEventListener('dragend', function (event) {
        if (!draggedGroup) return;
        event.stopPropagation();
        applyGroupDrop();
        groupEl.classList.remove('group-dragging'); groupEl.removeAttribute('draggable');
        draggedGroup = null; groupDropRef = null;
        clearGroupIndicators(); persistGroupOrder();
      });
    }

    function groupInsertionReference(container, x, y) {
      var groupEls = container.querySelectorAll('.widget-group:not(.group-dragging)');
      if (!groupEls.length) return null;
      var nearest = null, nearestDist = Infinity;
      for (var i = 0; i < groupEls.length; i++) {
        var box = groupEls[i].getBoundingClientRect();
        var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        var dist = Math.hypot(x - cx, y - cy);
        if (dist < nearestDist) { nearestDist = dist; nearest = { el: groupEls[i], cx: cx, cy: cy, h: box.height }; }
      }
      if (!nearest) return null;
      var before = (y < nearest.cy - nearest.h / 2) || (Math.abs(y - nearest.cy) <= nearest.h / 2 && x < nearest.cx);
      var ref = before ? nearest.el : nearest.el.nextElementSibling;
      if (ref === draggedGroup) ref = draggedGroup.nextElementSibling;
      return ref;
    }

    function setupGroupsContainer(container) {
      container.addEventListener('dragover', function (event) {
        if (!draggedGroup) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        groupDropRef = groupInsertionReference(container, event.clientX, event.clientY);
        clearGroupIndicators();
        if (groupDropRef && groupDropRef !== draggedGroup) {
          groupDropRef.classList.add('group-drop-before');
        } else {
          var rest = container.querySelectorAll('.widget-group:not(.group-dragging)');
          if (rest.length) rest[rest.length - 1].classList.add('group-drop-after');
        }
      });
      container.addEventListener('drop', function (event) { if (draggedGroup) event.preventDefault(); });
    }

    function clearGroupIndicators() {
      var marked = document.querySelectorAll('.widget-group.group-drop-before, .widget-group.group-drop-after');
      for (var i = 0; i < marked.length; i++) { marked[i].classList.remove('group-drop-before'); marked[i].classList.remove('group-drop-after'); }
    }

    function applyGroupDrop() {
      var container = document.getElementById('groupsContainer');
      if (!draggedGroup || !container) return;
      if (groupDropRef == null) container.appendChild(draggedGroup);
      else if (groupDropRef !== draggedGroup) container.insertBefore(draggedGroup, groupDropRef);
    }

    function persistGroupOrder() {
      var container = document.getElementById('groupsContainer');
      if (!container) return;
      var items = [];
      var groupEls = container.querySelectorAll('.widget-group');
      for (var i = 0; i < groupEls.length; i++) items.push({ id: Number(groupEls[i].dataset.groupId), position: i });
      fetch('/messen-schalten/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: items })
      }).catch(function () {});
    }

    function initDragAndDrop() {
      var cards = document.querySelectorAll('.widget-card');
      for (var i = 0; i < cards.length; i++) setupCard(cards[i]);
      var zones = document.querySelectorAll('.widget-dropzone');
      for (var j = 0; j < zones.length; j++) setupZone(zones[j]);
      var groupEls = document.querySelectorAll('.widget-group');
      for (var k = 0; k < groupEls.length; k++) setupGroup(groupEls[k]);
      var groupsContainer = document.getElementById('groupsContainer');
      if (groupsContainer) setupGroupsContainer(groupsContainer);
    }

    // --- Live-Aktualisierung ------------------------------------------------
    function applyStatusDot(el, statusOn) {
      if (!el) return;
      el.className = 'ms-status-dot ' + (statusOn === true ? 'is-on' : statusOn === false ? 'is-off' : 'is-unknown');
    }

    async function refreshValues() {
      try {
        var res = await fetch('/messen-schalten/data', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        var data = await res.json();
        (data.actors || []).forEach(function (a) {
          var power = document.getElementById('ms-power-' + a.id);
          if (power) power.textContent = a.powerDisplay;
          var counter = document.getElementById('ms-counter-' + a.id);
          if (counter && a.counterDisplay != null) counter.textContent = a.counterDisplay;
          applyStatusDot(document.getElementById('ms-status-' + a.id), a.statusOn);
          // Toggle (nur bei manuellen Geräten) spiegelt den Ist-Zustand, damit er
          // zum tatsächlichen Gerät passt. Beim Fokus/Bedienen nicht überschreiben.
          var sw = document.getElementById('ms-switch-' + a.id);
          if (sw && document.activeElement !== sw) sw.checked = a.statusOn === true;
          var prio = document.getElementById('ms-prio-' + a.id);
          if (prio) {
            prio.textContent = !a.hasSwitch ? 'nur Messen'
              : a.alwaysOn ? ('Immer an · Priorität ' + a.priority + (a.priorityFromGroup ? ' (Gruppe)' : ''))
              : 'manuell';
          }
        });
        (data.groups || []).forEach(function (g) {
          var sum = document.getElementById('ms-group-sum-' + g.id);
          if (sum) sum.textContent = g.sumDisplay;
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

    if (initialDialogError) {
      document.getElementById('actorDialogError').innerHTML =
        '<p class="error-text"></p>';
      document.querySelector('#actorDialogError .error-text').textContent = initialDialogError;
    }
    if (initialDialogMode === 'add') { openActorDialog('add'); setActorFormValues(initialDialogValues); }
    else if (initialDialogMode === 'edit' && initialEditingActorId != null) {
      openActorDialog('edit', initialEditingActorId); setActorFormValues(initialDialogValues);
    }
    if (initialGroupDialogOpen) openGroupDialog('add');`;

  return renderLayout({ title: 'Messen + Schalten', activePath: '/messen-schalten', body, script });
}

function toJsStringLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

module.exports = renderMessenSchalten;
