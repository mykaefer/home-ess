'use strict';

// Seite „Messen + Schalten". Gruppen laufen als einklappbare Abschnitte über die
// gesamte Seitenbreite (Vorbild: Output-Kategorien; Auf/Zu-Zustand in localStorage,
// Standard zugeklappt) und sind fest alphanumerisch sortiert. Geräte sind
// einzeilige Zeilen über die volle Breite, per Drag&Drop frei anordbar und
// zwischen Gruppen verschiebbar; gruppenlose Geräte stehen am Ende unter den
// Gruppen. Geräte mit Schalt-Topic erhalten einen An/Aus-Toggle (Wunschzustand,
// wird über das Betriebslevel gegatet); Gruppen zeigen die Verbrauchssumme
// (Leistung) ihrer Geräte in der Titelzeile.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { FUNCTIONS } = require('../messen-schalten/functions');
const { LOAD_SHED_PHASES } = require('../messen-schalten/actors');

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

function loadShedPhaseOptions(selected) {
  const labels = {
    l1: 'L1',
    l2: 'L2',
    l3: 'L3',
    three_phase: 'Drehstrom',
  };
  return LOAD_SHED_PHASES.map((phase) =>
    `<option value="${phase}"${phase === selected ? ' selected' : ''}>${labels[phase]}</option>`).join('');
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
  if (actor.loadShedActive) return `Lastabwurf · ${priorityText(actor.priority, actor.priorityFromGroup)}`;
  if (actor.alwaysOn) return `Immer an · ${priorityText(actor.priority, actor.priorityFromGroup)}`;
  return 'manuell';
}

// Einzeilige Geräte-Zeile über die volle Breite: Drag-Fläche, Status, Name,
// Betriebsart, Leistung, Zähler, Toggle, Aktionen. Leere Platzhalter-Spans halten
// die Spalten auch ohne Zähler/Toggle in der Flucht.
function renderActorRow(actor) {
  // Manueller Toggle nur bei Geräten mit Schalt-Topic OHNE „Immer an". Auch dieser
  // Schaltweg wird durch Betriebslevel und Priorität freigegeben.
  const toggle = actor.hasSwitch && !actor.alwaysOn
    ? `<label class="ms-toggle" title="Ein-/Ausschalten (Einschalten nur bei freigegebener Priorität)"><input type="checkbox" id="ms-switch-${actor.id}" onchange="toggleActor(${actor.id}, this.checked)"${actor.statusOn === true ? ' checked' : ''}><span class="ms-toggle-slider"></span></label>`
    : '<span aria-hidden="true"></span>';
  const counter = actor.hasCounter
    ? `<span class="ms-row-counter" id="ms-counter-${actor.id}">${escapeHtml(actor.counterDisplay)}</span>`
    : '<span class="ms-row-counter" aria-hidden="true"></span>';
  const muted = !actor.hasSwitch || (actor.hasSwitch && !actor.alwaysOn);
  return `              <div class="ms-row" data-id="${actor.id}">
                <span class="widget-drag" title="Zum Verschieben ziehen" aria-hidden="true">⠿</span>
                <span class="${statusDotClass(actor.statusOn)}" id="ms-status-${actor.id}" title="Status"></span>
                <span class="ms-row-name">${escapeHtml(actor.name)}</span>
                <span class="ms-prio${muted ? ' ms-prio--muted' : ''}" id="ms-prio-${actor.id}" title="Betriebsart bzw. aktive Priorität, auf die dieses Gerät beim Betriebslevel reagiert">${escapeHtml(metaLabel(actor))}</span>
                <span class="ms-row-power" id="ms-power-${actor.id}">${escapeHtml(actor.powerDisplay)}</span>
                ${counter}
                ${toggle}
                <div class="widget-actions">
                  <button type="button" class="widget-icon-btn" title="Gerät bearbeiten" onclick="openActorDialog('edit', ${actor.id})">✎</button>
                  <button type="button" class="widget-icon-btn" title="Gerät entfernen" onclick="openDeleteActorDialog(${actor.id}, ${toJsStringLiteral(actor.name)})">🗑</button>
                </div>
              </div>`;
}

// Geräteliste einer Gruppe. Ohne Geräte bleibt die Dropzone wirklich leer
// (kein Whitespace), damit der CSS-:empty-Platzhalter greift.
function renderActorList(actors, groupId) {
  const rows = actors.length ? `\n${actors.map(renderActorRow).join('\n')}\n            ` : '';
  return `<div class="widget-dropzone ms-list" data-group="${groupId == null ? '' : groupId}">${rows}</div>`;
}

// Einklappbarer Gruppen-Abschnitt über die volle Seitenbreite (Vorbild:
// Output-Kategorien). Standard zugeklappt; msApplyOpenState() stellt den in
// localStorage gemerkten Zustand wieder her. Der Kopf ist zugleich Drop-Ziel,
// damit Geräte auch in zugeklappte Gruppen gezogen werden können.
function renderGroup(group) {
  return `          <div class="ms-group" data-group-id="${group.id}">
            <div class="ms-group-head" role="button" tabindex="0" aria-expanded="false">
              <span class="ms-caret" aria-hidden="true">▸</span>
              <span class="ms-group-title">${escapeHtml(group.title)}</span>
              <span class="ms-group-count" id="ms-group-count-${group.id}">${group.actors.length}</span>
              <span class="ms-group-prio" title="Priorität der Gruppe (Geräte mit „Priorität der Gruppe verwenden" erben sie)">Priorität ${Number(group.priority)}</span>
              <span class="ms-group-sum" id="ms-group-sum-${group.id}" title="Verbrauchssumme (Leistung)">${escapeHtml(group.sumDisplay)}</span>
              <div class="widget-group-actions">
                <button type="button" class="widget-icon-btn" title="Gruppe bearbeiten" onclick="event.stopPropagation(); openGroupDialog('edit', ${group.id}, ${toJsStringLiteral(group.title)}, ${Number(group.priority)}, ${toJsStringLiteral(group.functionKey || '')})">✎</button>
                <button type="button" class="widget-icon-btn" title="Gruppe entfernen" onclick="event.stopPropagation(); openDeleteGroupDialog(${group.id}, ${toJsStringLiteral(group.title)})">🗑</button>
              </div>
            </div>
            <div class="ms-group-body">${renderActorList(group.actors, group.id)}</div>
          </div>`;
}

// Gruppenlose Geräte: fester Abschnitt am Seitenende unter den Gruppen, immer
// sichtbar (nicht einklappbar), zugleich Dropzone zum Herauslösen aus Gruppen.
function renderUngrouped(ungrouped) {
  return `          <div class="ms-group ms-group--ungrouped">
            <div class="ms-group-head ms-group-head--static">
              <span class="ms-group-title">Ohne Gruppe</span>
              <span class="ms-group-count" id="ms-group-count-none">${ungrouped.length}</span>
            </div>
            <div class="ms-group-body">${renderActorList(ungrouped, null)}</div>
          </div>`;
}

function renderActorDialog({ groupsForSelect, gridControlEnabled }) {
  const disabledAttr = gridControlEnabled ? '' : ' disabled';
  const hiddenMirrors = gridControlEnabled ? '' : `
                <input type="hidden" name="loadShedEnabled" id="msLoadShedHiddenEnabled" value="">
                <input type="hidden" name="loadShedPhase" id="msLoadShedHiddenPhase" value="l1">`;
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

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>Lastabwurf</h4>
                <p class="muted">Bei aktivem Grid-Control kann das Gerät schon vor dem Netzzuschalten abgeworfen werden: ab 80 % der konfigurierten Wechselrichterlast auf der gewählten Phase bzw. bei Drehstrom auf einer der drei Phasen. <strong>Immer an</strong> schaltet unter 50 % der zugehörigen Lastschwelle automatisch wieder ein.</p></div>
              <div class="dialog-grid dialog-grid--two">
                <label class="remember-row remember-row--boxed" for="msLoadShedEnabled" style="align-self:end;">
                  <input type="checkbox" id="msLoadShedEnabled" name="loadShedEnabled" value="on"${disabledAttr}>
                  <span>Zum Lastabwurf verwenden</span></label>
                <label class="field-block" for="msLoadShedPhase"><span>Phase</span>
                  <select id="msLoadShedPhase" name="loadShedPhase"${disabledAttr}>${loadShedPhaseOptions('l1')}</select>
                </label>
              </div>
              ${gridControlEnabled
                ? '<p class="muted">Drehstrom behandelt das Gerät als gleichmäßig auf L1, L2 und L3 verteilt.</p>'
                : '<p class="muted">Grid-Control ist deaktiviert. Diese Einstellungen stehen erst nach Aktivierung des Moduls zur Verfügung.</p>'}
              ${hiddenMirrors}
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
  gridControlEnabled = false,
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

        <div class="ms-groups" id="groupsContainer">
${groups.map(renderGroup).join('\n')}
${renderUngrouped(ungrouped)}
        </div>

        ${renderActorDialog({ groupsForSelect, gridControlEnabled })}
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
      document.getElementById('msLoadShedEnabled').checked = v.loadShedEnabled === true;
      document.getElementById('msLoadShedPhase').value = v.loadShedPhase || 'l1';
      var hiddenEnabled = document.getElementById('msLoadShedHiddenEnabled');
      var hiddenPhase = document.getElementById('msLoadShedHiddenPhase');
      if (hiddenEnabled) hiddenEnabled.value = v.loadShedEnabled === true ? 'on' : '';
      if (hiddenPhase) hiddenPhase.value = v.loadShedPhase || 'l1';
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

    // --- Einklappbare Gruppen (Vorbild: Output-Kategorien) ------------------
    // Standard zugeklappt; die IDs der offenen Gruppen liegen in localStorage.
    var MS_OPEN_KEY = 'homeess.ms.openGroups';

    function msSaveOpenState() {
      try {
        var open = [];
        document.querySelectorAll('.ms-group[data-group-id]').forEach(function (group) {
          if (group.classList.contains('is-open')) open.push(group.getAttribute('data-group-id'));
        });
        localStorage.setItem(MS_OPEN_KEY, JSON.stringify(open));
      } catch (_) {
        // localStorage nicht verfügbar – Zustand wird dann nicht gemerkt.
      }
    }

    function msApplyOpenState() {
      var open = [];
      try {
        open = JSON.parse(localStorage.getItem(MS_OPEN_KEY) || '[]');
      } catch (_) {
        open = [];
      }
      if (!Array.isArray(open)) open = [];
      document.querySelectorAll('.ms-group[data-group-id]').forEach(function (group) {
        var isOpen = open.indexOf(group.getAttribute('data-group-id')) !== -1;
        group.classList.toggle('is-open', isOpen);
        var head = group.querySelector('.ms-group-head');
        if (head) head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    function msToggleGroup(head) {
      var group = head.parentNode;
      var open = group.classList.toggle('is-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      msSaveOpenState();
    }

    function setupGroupHead(head) {
      head.addEventListener('click', function () { msToggleGroup(head); });
      head.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); msToggleGroup(head); }
      });
      // Der Kopf ist Drop-Ziel: Geräte lassen sich so auch in zugeklappte
      // Gruppen ziehen (sie landen dann am Ende der Gruppe).
      head.addEventListener('dragover', function (event) {
        if (!draggedCard) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        dropZone = head.parentNode.querySelector('.widget-dropzone');
        dropRef = null;
        clearDropIndicators();
        head.classList.add('drag-over');
      });
      head.addEventListener('drop', function (event) { event.preventDefault(); });
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
        clearDropIndicators(); updateGroupCounts(); persistLayout();
      });
    }

    function insertionReference(zone, x, y) {
      var cards = zone.querySelectorAll('.ms-row:not(.dragging)');
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
          var rest = zone.querySelectorAll('.ms-row:not(.dragging)');
          if (rest.length) rest[rest.length - 1].classList.add('drop-after');
        }
      });
      zone.addEventListener('drop', function (event) { event.preventDefault(); });
    }

    function clearDropIndicators() {
      var marked = document.querySelectorAll('.ms-row.drop-before, .ms-row.drop-after');
      for (var i = 0; i < marked.length; i++) { marked[i].classList.remove('drop-before'); marked[i].classList.remove('drop-after'); }
      var zones = document.querySelectorAll('.widget-dropzone.drag-over, .ms-group-head.drag-over');
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
        var cards = zones[z].querySelectorAll('.ms-row');
        for (var c = 0; c < cards.length; c++) {
          items.push({ id: Number(cards[c].dataset.id), groupId: groupId, position: c });
        }
      }
      fetch('/messen-schalten/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actors: items })
      }).then(function () { setTimeout(refreshValues, 300); }).catch(function () {});
    }

    // Geräteanzahl in den Gruppenköpfen nach Drag&Drop nachführen (ohne Reload).
    function updateGroupCounts() {
      var zones = document.querySelectorAll('.widget-dropzone');
      for (var z = 0; z < zones.length; z++) {
        var badge = document.getElementById('ms-group-count-' + (zones[z].dataset.group || 'none'));
        if (badge) badge.textContent = zones[z].querySelectorAll('.ms-row').length;
      }
    }

    function initDragAndDrop() {
      var cards = document.querySelectorAll('.ms-row');
      for (var i = 0; i < cards.length; i++) setupCard(cards[i]);
      var zones = document.querySelectorAll('.widget-dropzone');
      for (var j = 0; j < zones.length; j++) setupZone(zones[j]);
      var heads = document.querySelectorAll('.ms-group[data-group-id] > .ms-group-head');
      for (var k = 0; k < heads.length; k++) setupGroupHead(heads[k]);
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
              : a.loadShedActive ? ('Lastabwurf · Priorität ' + a.priority + (a.priorityFromGroup ? ' (Gruppe)' : ''))
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

    msApplyOpenState();
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
