'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { renderValueCatalog, valueCatalogScript } = require('./value-catalog');
const {
  WIDGET_TYPE_DEFS,
  widgetTypeDef,
  mobileMinWidthFor,
} = require('../dashboard/widget-types');

// Dashboard mit frei konfigurierbaren Widgets, Gruppen und Tabs. Widgets zeigen
// einen internen Wert (gleicher Katalog wie die Outputs), schalten ein Gerät /
// eine Schaltgruppe oder listen System-Informationen. Anzeige- und
// Bearbeitungsmodus sind strikt getrennt: Im Anzeigemodus gibt es keine
// sichtbaren oder platzreservierenden Bearbeitungselemente; im
// Bearbeitungsmodus ist jedes Widget vollflächig per Maus/Touch/Pointer
// verschiebbar und trägt dauerhaft sichtbare Bearbeiten-/Löschen-Buttons.
function renderDashboard({
  tabs = [],
  groupsForSelect = [],
  groupWidths = [],
  internalValues = [],
  switchTargets = [],
  infoFields = [],
  systemInfo = {},
  maxTabTitleLength = 40,
  formMessage = '',
  formError = '',
  dialogMode = '',
  dialogError = '',
  dialogValues = null,
  editingWidgetId = null,
  groupDialogOpen = false,
  groupDialogError = '',
  tabDialogMode = '',
  tabDialogError = '',
  editingTabId = null,
  selectTabId = null,
} = {}) {
  const ctx = { infoFields, systemInfo };
  const tabTitleById = new Map(tabs.map((tab) => [tab.id, tab.title]));

  const body = `        <div class="panel-head panel-head--row">
          <div>
            <h1>Dashboard</h1>
          </div>
          <div class="dashboard-toolbar">
            <div class="dash-add-wrap" id="dashAddWrap" hidden>
              <button type="button" class="icon-button dash-add-btn" id="dashAddBtn" title="Hinzufügen" aria-label="Hinzufügen" aria-haspopup="true" aria-expanded="false" onclick="toggleAddMenu()">＋</button>
              <div class="dash-add-menu" id="dashAddMenu" hidden>
                <button type="button" onclick="addMenuChoose('group')">Gruppe hinzufügen</button>
                <button type="button" onclick="addMenuChoose('widget')">Widget hinzufügen</button>
              </div>
            </div>
            <button type="button" class="icon-button dash-edit-btn" id="dashEditBtn" title="Dashboard bearbeiten" aria-label="Dashboard bearbeiten" aria-pressed="false" onclick="toggleEditMode()">✎</button>
          </div>
        </div>
        ${statusText(formError)}
        ${statusText(formMessage, 'success')}
        ${groupDialogError ? statusText(groupDialogError) : ''}
        <p class="error-text" id="dashLayoutError" hidden></p>

        <div class="dash-tabbar" id="dashTabbar" role="tablist" aria-label="Dashboard-Tabs">
${tabs.map((tab) => renderTabButton(tab)).join('\n')}
          <button type="button" class="dash-tab-add" id="dashTabAdd" title="Tab hinzufügen" aria-label="Tab hinzufügen" onclick="openTabDialog('add')" hidden>＋</button>
        </div>

        <div class="dash-panels" id="dashPanels">
${tabs.map((tab) => renderTabPanel(tab, ctx)).join('\n')}
        </div>

        ${renderWidgetDialog({ internalValues, switchTargets, infoFields, tabs, groupsForSelect, tabTitleById, dialogError })}
        ${renderGroupDialog({ groupWidths, tabs })}
        ${renderTabDialog({ maxTabTitleLength, tabDialogError })}
        ${renderDeleteTabDialog()}
        ${renderDeleteWidgetDialog()}
        ${renderDeleteGroupDialog()}`;

  // Client-Daten: Widgets mit ihrem effektiven Tab (Gruppen-Widgets erben den
  // Tab der Gruppe) für die Dialog-Vorbelegung.
  const clientWidgets = tabs.flatMap((tab) =>
    [...tab.ungrouped, ...tab.groups.flatMap((group) => group.widgets)].map((widget) => ({
      id: widget.id,
      type: widget.type || 'value',
      sourceId: widget.sourceId,
      label: widget.label || '',
      infoFields: widget.infoFields || null,
      groupId: widget.groupId == null ? '' : widget.groupId,
      tabId: tab.id,
      size: widget.size || 'l',
      color: widget.color || '',
      switchLabel: widget.switchLabel || '',
      onColor: widget.onColor || '',
      offColor: widget.offColor || '',
    }))
  );
  const clientGroups = groupsForSelect.map((group) => ({
    id: group.id,
    title: group.title,
    width: group.width,
    tabId: group.tabId,
  }));
  const clientTabs = tabs.map((tab) => ({ id: tab.id, title: tab.title }));
  const clientTypeDefs = WIDGET_TYPE_DEFS.map((def) => ({
    type: def.type,
    needsSource: def.needsSource,
    supportsSize: def.supportsSize,
    supportsColor: def.supportsColor,
    mobileFull: def.mobileMinWidth === 'full',
  }));

  const script = `${valueCatalogScript()}

    var dashboardWidgets = ${JSON.stringify(clientWidgets)};
    var dashboardGroups = ${JSON.stringify(clientGroups)};
    var dashboardTabs = ${JSON.stringify(clientTabs)};
    var widgetTypeDefs = ${JSON.stringify(clientTypeDefs)};
    var initialDialogMode = ${JSON.stringify(dialogMode)};
    var initialEditingWidgetId = ${editingWidgetId == null ? 'null' : Number(editingWidgetId)};
    var initialDialogValues = ${JSON.stringify(dialogValues || {})};
    var initialGroupDialogOpen = ${groupDialogOpen ? 'true' : 'false'};
    var initialTabDialogMode = ${JSON.stringify(tabDialogMode)};
    var initialEditingTabId = ${editingTabId == null ? 'null' : Number(editingTabId)};
    var serverSelectTabId = ${selectTabId == null ? 'null' : Number(selectTabId)};

    var EDIT_STORAGE_KEY = 'homeess.dashboard.editing';
    var TAB_STORAGE_KEY = 'homeess.dashboard.activeTab';
    var editing = false;
    var activeTabId = null;

    function typeDef(type) {
      for (var i = 0; i < widgetTypeDefs.length; i++) {
        if (widgetTypeDefs[i].type === type) return widgetTypeDefs[i];
      }
      return widgetTypeDefs[0];
    }

    function findWidget(id) {
      for (var i = 0; i < dashboardWidgets.length; i++) {
        if (dashboardWidgets[i].id === id) return dashboardWidgets[i];
      }
      return null;
    }

    function findGroup(id) {
      for (var i = 0; i < dashboardGroups.length; i++) {
        if (dashboardGroups[i].id === id) return dashboardGroups[i];
      }
      return null;
    }

    // --- Tabs (Anzeige) ------------------------------------------------------
    function activateTab(tabId) {
      var known = false;
      for (var i = 0; i < dashboardTabs.length; i++) {
        if (dashboardTabs[i].id === tabId) known = true;
      }
      if (!known) tabId = dashboardTabs.length ? dashboardTabs[0].id : null;
      activeTabId = tabId;
      var buttons = document.querySelectorAll('.dash-tab');
      for (var b = 0; b < buttons.length; b++) {
        var isActive = Number(buttons[b].getAttribute('data-tab-id')) === tabId;
        buttons[b].classList.toggle('is-active', isActive);
        buttons[b].setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
      var panels = document.querySelectorAll('.dash-panel');
      for (var p = 0; p < panels.length; p++) {
        panels[p].hidden = Number(panels[p].getAttribute('data-tab-id')) !== tabId;
      }
      try { sessionStorage.setItem(TAB_STORAGE_KEY, String(tabId)); } catch (_) {}
    }

    function onTabClick(tabId) {
      activateTab(tabId);
    }

    function activePanel() {
      return document.querySelector('.dash-panel[data-tab-id="' + activeTabId + '"]');
    }

    // --- Bearbeitungsmodus ---------------------------------------------------
    // Der Stift-Button wird im Bearbeitungsmodus zum Übernehmen-Button (Haken);
    // der Plus-Button ist nur im Bearbeitungsmodus sichtbar.
    function setEditing(on) {
      editing = !!on;
      document.body.classList.toggle('dash-editing', editing);
      var editBtn = document.getElementById('dashEditBtn');
      editBtn.classList.toggle('is-active', editing);
      editBtn.classList.toggle('icon-button--confirm', editing);
      editBtn.setAttribute('aria-pressed', editing ? 'true' : 'false');
      editBtn.textContent = editing ? '✓' : '✎';
      var editLabel = editing ? 'Bearbeitung übernehmen und speichern' : 'Dashboard bearbeiten';
      editBtn.title = editLabel;
      editBtn.setAttribute('aria-label', editLabel);
      document.getElementById('dashAddWrap').hidden = !editing;
      document.getElementById('dashTabAdd').hidden = !editing;
      closeAddMenu();
      try {
        if (editing) sessionStorage.setItem(EDIT_STORAGE_KEY, '1');
        else sessionStorage.removeItem(EDIT_STORAGE_KEY);
      } catch (_) {}
    }

    function toggleEditMode() {
      if (editing) { applyEditMode(); return; }
      setEditing(true);
    }

    // Übernehmen: ausstehende Layout-Änderungen speichern, erst bei Erfolg den
    // Bearbeitungsmodus verlassen. Doppelklicks werden über die Serialisierung
    // der Speichervorgänge und den busy-Zustand abgefangen.
    function applyEditMode() {
      var btn = document.getElementById('dashEditBtn');
      if (btn.classList.contains('is-busy')) return;
      btn.classList.add('is-busy');
      saveLayoutNow()
        .then(function () {
          showLayoutError('');
          setEditing(false);
        })
        .catch(function () {
          showLayoutError('Speichern fehlgeschlagen. Die Änderungen wurden noch nicht übernommen – bitte erneut versuchen.');
        })
        .then(function () { btn.classList.remove('is-busy'); });
    }

    function showLayoutError(message) {
      var node = document.getElementById('dashLayoutError');
      if (!node) return;
      node.textContent = message || '';
      node.hidden = !message;
    }

    // --- Plus-Menü -----------------------------------------------------------
    function toggleAddMenu() {
      var menu = document.getElementById('dashAddMenu');
      var open = menu.hidden;
      menu.hidden = !open;
      document.getElementById('dashAddBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function closeAddMenu() {
      var menu = document.getElementById('dashAddMenu');
      if (menu) menu.hidden = true;
      var btn = document.getElementById('dashAddBtn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function addMenuChoose(kind) {
      closeAddMenu();
      if (kind === 'group') openGroupDialog('add');
      else openWidgetDialog('add');
    }

    document.addEventListener('click', function (event) {
      var wrap = document.getElementById('dashAddWrap');
      if (wrap && !wrap.contains(event.target)) closeAddMenu();
    });

    // --- Widget-Dialog -------------------------------------------------------
    function openWidgetDialog(mode, widgetId) {
      var dialog = document.getElementById('widgetDialog');
      if (!dialog) return;
      var form = document.getElementById('widgetForm');
      var title = document.getElementById('widgetDialogTitle');
      var widget = mode === 'edit' ? findWidget(widgetId) : null;
      if (mode === 'edit' && widget) {
        form.action = '/dashboard/widgets/' + widget.id;
        title.textContent = 'Widget bearbeiten';
        setWidgetFormValues(widget);
      } else {
        form.action = '/dashboard/widgets';
        title.textContent = 'Widget hinzufügen';
        setWidgetFormValues({ type: 'value', sourceId: '', groupId: '', tabId: activeTabId, infoFields: null, size: 'l', color: '' });
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    // Typ umschalten: versteckten Typ setzen, aktive Registerkarte markieren,
    // das passende Panel zeigen und die typabhängigen Felder (Größe) schalten.
    function setWidgetType(type) {
      var def = typeDef(type);
      var input = document.getElementById('widgetType');
      if (input) input.value = def.type;
      var tabs = document.querySelectorAll('#widgetDialog .dialog-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === def.type);
      }
      var panels = document.querySelectorAll('#widgetDialog .tab-panel');
      for (var j = 0; j < panels.length; j++) {
        panels[j].hidden = panels[j].getAttribute('data-panel') !== def.type;
      }
      document.getElementById('widgetSizeField').hidden = !def.supportsSize;
    }

    // Tab folgt der Gruppe: Bei gewählter Gruppe ist die Tab-Auswahl gesperrt
    // und zeigt den Tab der Gruppe (das Widget erbt die Zuordnung).
    function syncWidgetTabSelect() {
      var groupSelect = document.getElementById('widgetGroupId');
      var tabSelect = document.getElementById('widgetTabId');
      var hint = document.getElementById('widgetTabHint');
      var group = groupSelect.value ? findGroup(Number(groupSelect.value)) : null;
      tabSelect.disabled = !!group;
      if (group) tabSelect.value = String(group.tabId);
      if (hint) hint.hidden = !group;
    }

    function setWidgetSize(size) {
      var radios = document.querySelectorAll('#widgetDialog input[name="size"]');
      for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === (size || 'l');
    }

    function setWidgetFormValues(values) {
      setWidgetType(values.type || 'value');
      valueCatalogSync('widgetSourceId', values.type === 'value' ? (values.sourceId || '') : '');
      document.getElementById('widgetGroupId').value = values.groupId == null || values.groupId === '' ? '' : String(values.groupId);
      document.getElementById('widgetTabId').value = values.tabId == null ? String(activeTabId) : String(values.tabId);
      syncWidgetTabSelect();
      setWidgetSize(values.size || 'l');
      colorChoiceSync('widgetColor', values.color || '');
      var target = values.switchTarget != null ? values.switchTarget : (values.type === 'switch' ? (values.sourceId || '') : '');
      document.getElementById('widgetSwitchTarget').value = target;
      document.getElementById('widgetSwitchLabel').value = values.switchLabel || '';
      colorChoiceSync('widgetOnColor', values.onColor || '');
      colorChoiceSync('widgetOffColor', values.offColor || '');
      // Info-Felder: ohne Vorgabe (Neuanlage) sind alle aktiv.
      var selected = values.infoFields || null;
      var boxes = document.querySelectorAll('#widgetDialog input[name="infoFields"]');
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].checked = selected ? selected.indexOf(boxes[i].value) !== -1 : true;
      }
    }

    function closeWidgetDialog() {
      var dialog = document.getElementById('widgetDialog');
      if (dialog) dialog.close();
    }

    // --- Farbwahl (gemeinsame Mini-Komponente) -------------------------------
    // Verstecktes Feld hält den validierten Wert ('' = Standardfarbe); der
    // native Farbwähler dient nur der Eingabe.
    function colorChoiceSet(fieldId, value) {
      var field = document.getElementById(fieldId);
      if (field) field.value = value;
      colorChoiceRender(fieldId);
    }

    function colorChoiceReset(fieldId) {
      colorChoiceSet(fieldId, '');
    }

    function colorChoiceSync(fieldId, value) {
      var field = document.getElementById(fieldId);
      if (field) field.value = value || '';
      colorChoiceRender(fieldId);
    }

    function colorChoiceRender(fieldId) {
      var field = document.getElementById(fieldId);
      var picker = document.getElementById(fieldId + 'Picker');
      var state = document.getElementById(fieldId + 'State');
      var hasColor = !!(field && field.value);
      if (picker && hasColor) picker.value = field.value;
      if (state) state.textContent = hasColor ? field.value : 'Standard';
    }

    // --- Gruppen-Dialog ------------------------------------------------------
    function openGroupDialog(mode, groupId) {
      var dialog = document.getElementById('groupDialog');
      if (!dialog) return;
      var form = document.getElementById('groupForm');
      var title = document.getElementById('groupDialogTitle');
      var group = mode === 'edit' ? findGroup(groupId) : null;
      if (group) {
        form.action = '/dashboard/groups/' + group.id;
        title.textContent = 'Gruppe bearbeiten';
        document.getElementById('groupTitle').value = group.title;
        document.getElementById('groupWidth').value = group.width || 'full';
        document.getElementById('groupTabId').value = String(group.tabId);
      } else {
        form.action = '/dashboard/groups';
        title.textContent = 'Gruppe hinzufügen';
        document.getElementById('groupTitle').value = '';
        document.getElementById('groupWidth').value = 'full';
        document.getElementById('groupTabId').value = String(activeTabId);
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeGroupDialog() {
      var dialog = document.getElementById('groupDialog');
      if (dialog) dialog.close();
    }

    // --- Tab-Dialoge ---------------------------------------------------------
    function openTabDialog(mode, tabId) {
      var dialog = document.getElementById('tabDialog');
      if (!dialog) return;
      var form = document.getElementById('tabForm');
      var title = document.getElementById('tabDialogTitle');
      var input = document.getElementById('tabTitle');
      var tab = null;
      for (var i = 0; i < dashboardTabs.length; i++) {
        if (dashboardTabs[i].id === tabId) tab = dashboardTabs[i];
      }
      if (mode === 'edit' && tab) {
        form.action = '/dashboard/tabs/' + tab.id;
        title.textContent = 'Tab bearbeiten';
        input.value = tab.title;
      } else {
        form.action = '/dashboard/tabs';
        title.textContent = 'Tab hinzufügen';
        input.value = '';
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeTabDialog() {
      var dialog = document.getElementById('tabDialog');
      if (dialog) dialog.close();
    }

    function openDeleteTabDialog(tabId, tabTitle) {
      if (dashboardTabs.length <= 1) return;
      var dialog = document.getElementById('deleteTabDialog');
      if (!dialog) return;
      document.getElementById('deleteTabName').textContent = tabTitle;
      document.getElementById('deleteTabForm').action = '/dashboard/tabs/' + tabId + '/delete';
      var panel = document.querySelector('.dash-panel[data-tab-id="' + tabId + '"]');
      var hasContent = panel && (panel.querySelectorAll('.widget-card').length || panel.querySelectorAll('.widget-group').length);
      var moveBlock = document.getElementById('deleteTabMove');
      moveBlock.hidden = !hasContent;
      var select = document.getElementById('deleteTabTarget');
      select.innerHTML = '';
      for (var i = 0; i < dashboardTabs.length; i++) {
        if (dashboardTabs[i].id === tabId) continue;
        var option = document.createElement('option');
        option.value = String(dashboardTabs[i].id);
        option.textContent = dashboardTabs[i].title;
        select.appendChild(option);
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeDeleteTabDialog() {
      var dialog = document.getElementById('deleteTabDialog');
      if (dialog) dialog.close();
    }

    // --- Lösch-Dialoge Widget/Gruppe -----------------------------------------
    function openDeleteWidgetDialog(widgetId, widgetLabel) {
      var dialog = document.getElementById('deleteWidgetDialog');
      if (!dialog) return;
      document.getElementById('deleteWidgetName').textContent = widgetLabel;
      document.getElementById('deleteWidgetForm').action = '/dashboard/widgets/' + widgetId + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeDeleteWidgetDialog() {
      var dialog = document.getElementById('deleteWidgetDialog');
      if (dialog) dialog.close();
    }

    function openDeleteGroupDialog(groupId, groupTitle) {
      var dialog = document.getElementById('deleteGroupDialog');
      if (!dialog) return;
      document.getElementById('deleteGroupName').textContent = groupTitle;
      document.getElementById('deleteGroupForm').action = '/dashboard/groups/' + groupId + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeDeleteGroupDialog() {
      var dialog = document.getElementById('deleteGroupDialog');
      if (dialog) dialog.close();
    }

    // --- Layout speichern ----------------------------------------------------
    // Alle Zonen (auch der verborgenen Tabs) einsammeln: Widgets je Zone mit
    // Gruppe/Tab/Position, Gruppen in globaler DOM-Reihenfolge, Tab-Reihenfolge
    // aus der Tab-Leiste.
    function collectLayout() {
      var widgets = [];
      var groups = [];
      var tabItems = [];
      var tabEls = document.querySelectorAll('#dashTabbar .dash-tab');
      for (var t = 0; t < tabEls.length; t++) {
        tabItems.push({ id: Number(tabEls[t].getAttribute('data-tab-id')), position: t });
      }
      var panels = document.querySelectorAll('.dash-panel');
      for (var p = 0; p < panels.length; p++) {
        var tabId = Number(panels[p].getAttribute('data-tab-id'));
        var zones = panels[p].querySelectorAll('.widget-dropzone');
        for (var z = 0; z < zones.length; z++) {
          var groupId = zones[z].dataset.group ? Number(zones[z].dataset.group) : null;
          var cards = zones[z].querySelectorAll('.widget-card');
          for (var c = 0; c < cards.length; c++) {
            widgets.push({
              id: Number(cards[c].dataset.id),
              groupId: groupId,
              tabId: groupId == null ? tabId : null,
              position: c,
            });
          }
        }
        var groupEls = panels[p].querySelectorAll('.widget-group');
        for (var g = 0; g < groupEls.length; g++) {
          groups.push({ id: Number(groupEls[g].dataset.groupId), position: groups.length });
        }
      }
      return { widgets: widgets, groups: groups, tabs: tabItems };
    }

    var layoutDirty = false;
    var layoutSaving = null;
    var layoutSaveTimer = null;

    function markLayoutDirty() {
      layoutDirty = true;
      if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
      layoutSaveTimer = setTimeout(function () {
        layoutSaveTimer = null;
        saveLayoutNow().catch(function () {
          showLayoutError('Anordnung konnte nicht gespeichert werden – wird beim Übernehmen erneut versucht.');
        });
      }, 400);
    }

    // Speichervorgänge serialisieren: nie zwei parallele Requests, keine
    // doppelten Speichervorgänge; bei Fehler bleibt layoutDirty gesetzt.
    function saveLayoutNow() {
      if (layoutSaving) return layoutSaving.then(saveLayoutNow);
      if (!layoutDirty) return Promise.resolve();
      layoutDirty = false;
      layoutSaving = fetch('/dashboard/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectLayout()),
      }).then(function (response) {
        layoutSaving = null;
        if (!response.ok) { layoutDirty = true; throw new Error('layout save failed'); }
        showLayoutError('');
      }, function (err) {
        layoutSaving = null;
        layoutDirty = true;
        throw err;
      });
      return layoutSaving;
    }

    // --- Drag & Drop (Pointer Events: Maus, Touch, Stift) --------------------
    // Im Bearbeitungsmodus ist die gesamte Widget-Fläche Drag-Fläche; Buttons
    // im Bearbeitungs-Overlay starten keinen Drag. Auf Touch startet der Drag
    // nach kurzem Halten (vorher bleibt vertikales Scrollen möglich).
    var drag = null;

    function clearDropIndicators() {
      var marked = document.querySelectorAll('.drop-before, .drop-after, .group-drop-before, .group-drop-after, .tab-drop-before, .tab-drop-after');
      for (var i = 0; i < marked.length; i++) {
        marked[i].classList.remove('drop-before', 'drop-after', 'group-drop-before', 'group-drop-after', 'tab-drop-before', 'tab-drop-after');
      }
      var zones = document.querySelectorAll('.widget-dropzone.drag-over');
      for (var j = 0; j < zones.length; j++) zones[j].classList.remove('drag-over');
    }

    function dragClassFor(kind) {
      return kind === 'card' ? 'dragging' : kind === 'group' ? 'group-dragging' : 'tab-dragging';
    }

    function onDragPointerDown(event) {
      if (!editing || drag) return;
      if (event.button != null && event.button !== 0) return;
      if (event.target.closest('.widget-edit-bar') || event.target.closest('dialog')) return;
      var el = null;
      var kind = null;
      var grip = event.target.closest('.dash-tab-grip');
      var card = event.target.closest('.widget-card');
      if (grip) { el = grip.closest('.dash-tab'); kind = 'tab'; }
      else if (card) { el = card; kind = 'card'; }
      else {
        var head = event.target.closest('.widget-group-head');
        if (head) { el = head.closest('.widget-group'); kind = 'group'; }
      }
      if (!el) return;
      drag = {
        kind: kind,
        el: el,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
        holdTimer: null,
        zone: null,
        ref: null,
      };
      if (event.pointerType === 'touch') {
        drag.holdTimer = setTimeout(function () {
          if (drag && !drag.active) startDrag();
        }, 220);
      }
    }

    function startDrag() {
      if (!drag || drag.active) return;
      drag.active = true;
      var rect = drag.el.getBoundingClientRect();
      drag.offsetX = drag.startX - rect.left;
      drag.offsetY = drag.startY - rect.top;
      var ghost = drag.el.cloneNode(true);
      ghost.classList.add('dash-drag-ghost');
      ghost.style.width = rect.width + 'px';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.el.classList.add(dragClassFor(drag.kind));
      document.body.classList.add('dash-dragging');
    }

    function moveDrag(x, y) {
      if (!drag || !drag.active) return;
      drag.ghost.style.left = (x - drag.offsetX) + 'px';
      drag.ghost.style.top = (y - drag.offsetY) + 'px';
      var under = document.elementFromPoint(x, y);
      clearDropIndicators();
      drag.zone = null;
      drag.ref = null;
      if (!under) return;
      if (drag.kind === 'tab') {
        var bar = document.getElementById('dashTabbar');
        if (!bar || !bar.contains(under)) return;
        drag.zone = bar;
        drag.ref = insertionReference(bar, '.dash-tab', x, y);
        if (drag.ref && drag.ref !== drag.el) drag.ref.classList.add('tab-drop-before');
        else markLast(bar, '.dash-tab', 'tab-drop-after');
        return;
      }
      var panel = activePanel();
      if (!panel || !panel.contains(under)) return;
      if (drag.kind === 'card') {
        var zone = under.closest('.widget-dropzone') || nearestZone(panel, x, y);
        if (!zone) return;
        drag.zone = zone;
        drag.ref = insertionReference(zone, '.widget-card', x, y);
        zone.classList.add('drag-over');
        if (drag.ref && drag.ref !== drag.el) drag.ref.classList.add('drop-before');
        else markLast(zone, '.widget-card', 'drop-after');
      } else {
        var container = panel.querySelector('.widget-groups');
        if (!container) return;
        drag.zone = container;
        drag.ref = insertionReference(container, '.widget-group', x, y);
        if (drag.ref && drag.ref !== drag.el) drag.ref.classList.add('group-drop-before');
        else markLast(container, '.widget-group', 'group-drop-after');
      }
    }

    function markLast(zone, selector, cls) {
      var rest = zone.querySelectorAll(selector + ':not(.dragging):not(.group-dragging):not(.tab-dragging)');
      if (rest.length) rest[rest.length - 1].classList.add(cls);
    }

    // Fallback: Zone unter dem Zeiger fehlt (z. B. Lücke zwischen Kacheln) –
    // die räumlich nächste Zone des aktiven Panels verwenden.
    function nearestZone(panel, x, y) {
      var zones = panel.querySelectorAll('.widget-dropzone');
      var best = null;
      var bestDist = Infinity;
      for (var i = 0; i < zones.length; i++) {
        var box = zones[i].getBoundingClientRect();
        var dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
        var dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
        var dist = Math.hypot(dx, dy);
        if (dist < bestDist) { bestDist = dist; best = zones[i]; }
      }
      return bestDist <= 48 ? best : null;
    }

    // Einfügeziel bestimmen, OHNE das DOM zu verändern (verhindert Flackern):
    // gibt das Element zurück, vor dem eingefügt würde – oder null für „ans Ende".
    // Gemeinsame Logik für Kacheln, Gruppen und Tabs (auch mehrzeilig umbrechend).
    function insertionReference(container, selector, x, y) {
      var els = container.querySelectorAll(selector + ':not(.dragging):not(.group-dragging):not(.tab-dragging)');
      if (!els.length) return null;
      var nearest = null;
      var nearestDist = Infinity;
      for (var i = 0; i < els.length; i++) {
        var box = els[i].getBoundingClientRect();
        var cx = box.left + box.width / 2;
        var cy = box.top + box.height / 2;
        var dist = Math.hypot(x - cx, y - cy);
        if (dist < nearestDist) { nearestDist = dist; nearest = { el: els[i], cx: cx, cy: cy, h: box.height }; }
      }
      if (!nearest) return null;
      var before = (y < nearest.cy - nearest.h / 2) || (Math.abs(y - nearest.cy) <= nearest.h / 2 && x < nearest.cx);
      var ref = before ? nearest.el : nearest.el.nextElementSibling;
      if (ref === drag.el) ref = drag.el.nextElementSibling;
      return ref;
    }

    function finishDrag(apply) {
      if (!drag) return;
      if (drag.holdTimer) clearTimeout(drag.holdTimer);
      if (drag.active) {
        if (apply && drag.zone) {
          // In der Tab-Leiste bleibt der Plus-Button immer das letzte Element.
          var endRef = drag.kind === 'tab' ? document.getElementById('dashTabAdd') : null;
          var ref = drag.ref == null ? endRef : drag.ref;
          if (ref == null) drag.zone.appendChild(drag.el);
          else if (ref !== drag.el) drag.zone.insertBefore(drag.el, ref);
          markLayoutDirty();
          updateGroupMobileClasses();
        }
        drag.el.classList.remove('dragging', 'group-dragging', 'tab-dragging');
        if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
        document.body.classList.remove('dash-dragging');
        clearDropIndicators();
      }
      drag = null;
    }

    document.addEventListener('pointerdown', onDragPointerDown);
    document.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        var moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (drag.holdTimer) {
          // Touch: Bewegung vor Ablauf der Haltezeit = Scrollen, kein Drag.
          if (moved > 10) finishDrag(false);
          return;
        }
        if (moved > 6) startDrag();
        else return;
      }
      moveDrag(event.clientX, event.clientY);
    });
    document.addEventListener('pointerup', function (event) {
      if (drag && event.pointerId === drag.pointerId) finishDrag(true);
    });
    document.addEventListener('pointercancel', function (event) {
      if (drag && event.pointerId === drag.pointerId) finishDrag(false);
    });
    // Während eines aktiven Drags das Seiten-Scrollen unterbinden (Touch).
    document.addEventListener('touchmove', function (event) {
      if (drag && drag.active) event.preventDefault();
    }, { passive: false });

    // Mobile Mindestbreite: Gruppen erben die größte erforderliche mobile
    // Breite ihrer Widgets (zentral aus den Widget-Typ-Definitionen).
    function updateGroupMobileClasses() {
      var mobileFullTypes = {};
      for (var i = 0; i < widgetTypeDefs.length; i++) {
        if (widgetTypeDefs[i].mobileFull) mobileFullTypes[widgetTypeDefs[i].type] = true;
      }
      var groupEls = document.querySelectorAll('.widget-group');
      for (var g = 0; g < groupEls.length; g++) {
        var cards = groupEls[g].querySelectorAll('.widget-card');
        var needsFull = false;
        for (var c = 0; c < cards.length; c++) {
          if (mobileFullTypes[cards[c].dataset.type]) needsFull = true;
        }
        groupEls[g].classList.toggle('widget-group--mobile-full', needsFull);
      }
    }

    // --- Schalter ------------------------------------------------------------
    var switchPending = {};

    function setSwitchVisual(id, on) {
      var surface = document.getElementById('switch-surface-' + id);
      if (!surface) return;
      surface.setAttribute('data-on', on === true ? 'true' : on === false ? 'false' : 'unknown');
      surface.setAttribute('aria-pressed', on === true ? 'true' : 'false');
      var state = document.getElementById('switch-state-' + id);
      if (state) state.textContent = on === true ? 'Ein' : on === false ? 'Aus' : '—';
    }

    function showSwitchError(id, message) {
      var node = document.getElementById('switch-error-' + id);
      if (!node) return;
      node.textContent = message || '';
      node.hidden = !message;
      if (message) setTimeout(function () { node.hidden = true; }, 5000);
    }

    function toggleSwitchWidget(id) {
      if (editing || switchPending[id]) return;
      var surface = document.getElementById('switch-surface-' + id);
      if (!surface) return;
      var next = surface.getAttribute('data-on') !== 'true';
      switchPending[id] = true;
      surface.classList.add('is-pending');
      showSwitchError(id, '');
      setSwitchVisual(id, next);
      fetch('/dashboard/switch/' + id + '/' + (next ? '1' : '0'), { method: 'POST' })
        .then(function (response) {
          if (!response.ok) throw new Error('switch failed');
          return response.json();
        })
        .then(function (data) {
          if (data.blocked) showSwitchError(id, 'Einschalten derzeit gesperrt (Priorität/Betriebslevel).');
        })
        .catch(function () {
          showSwitchError(id, 'Schalten fehlgeschlagen.');
        })
        .then(function () {
          // Ist-Zustand nachladen; bei Fehlern fällt die Anzeige damit auf den
          // tatsächlichen Zustand zurück.
          setTimeout(function () {
            switchPending[id] = false;
            surface.classList.remove('is-pending');
            refreshWidgetValues();
          }, 700);
        });
    }

    // --- Live-Werte ----------------------------------------------------------
    function refreshWidgetValues() {
      return fetch('/dashboard/data', { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data) return;
          (data.widgets || []).forEach(function (widget) {
            var node = document.getElementById('widget-value-' + widget.id);
            if (node) node.textContent = widget.currentDisplay == null ? '—' : widget.currentDisplay;
          });
          (data.switches || []).forEach(function (entry) {
            if (switchPending[entry.id]) return;
            setSwitchVisual(entry.id, entry.on);
          });
          if (data.system) applySystemInfo(data.system);
        })
        .catch(function () {
          // Anzeige bleibt auf dem letzten gueltigen Stand.
        });
    }

    // Alle Info-Kacheln mit frischen System-Werten versorgen (Text + Balken).
    function applySystemInfo(system) {
      Object.keys(system).forEach(function (key) {
        var field = system[key];
        var vals = document.querySelectorAll('[data-info="' + key + '"]');
        for (var i = 0; i < vals.length; i++) {
          vals[i].textContent = field.display == null ? '—' : field.display;
        }
        if (field.percent != null) {
          var bars = document.querySelectorAll('[data-info-bar="' + key + '"]');
          for (var j = 0; j < bars.length; j++) bars[j].style.width = field.percent + '%';
        }
      });
    }

    // MQTT-Events kommen in Bursts (viele Topics gleichzeitig). Ohne Bremse würde
    // jedes Event ein /dashboard/data-Fetch auslösen und den Server fluten
    // (listInternalValues ist teuer). Daher pro Burst nur EIN Nachladen (coalesced).
    var refreshQueued = false;
    function queueWidgetRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(function () { refreshQueued = false; refreshWidgetValues(); }, 1000);
    }

    // --- Initialisierung -----------------------------------------------------
    var storedTab = null;
    try { storedTab = Number(sessionStorage.getItem(TAB_STORAGE_KEY)); } catch (_) {}
    activateTab(serverSelectTabId != null ? serverSelectTabId : (Number.isFinite(storedTab) ? storedTab : null));

    var storedEditing = false;
    try { storedEditing = sessionStorage.getItem(EDIT_STORAGE_KEY) === '1'; } catch (_) {}
    if (storedEditing) setEditing(true);

    updateGroupMobileClasses();

    if (initialDialogMode === 'add') {
      openWidgetDialog('add');
      setWidgetFormValues(initialDialogValues);
    } else if (initialDialogMode === 'edit' && initialEditingWidgetId != null) {
      openWidgetDialog('edit', initialEditingWidgetId);
      setWidgetFormValues(initialDialogValues);
    }
    if (initialGroupDialogOpen) openGroupDialog('add');
    if (initialTabDialogMode === 'add') openTabDialog('add');
    else if (initialTabDialogMode === 'edit' && initialEditingTabId != null) openTabDialog('edit', initialEditingTabId);

    refreshWidgetValues();
    window.addEventListener('homeess:mqtt', queueWidgetRefresh);
    setInterval(refreshWidgetValues, 60000);`;

  return renderLayout({ title: 'Dashboard', activePath: '/dashboard', body, script });
}

// --- Tab-Leiste und Panels ---------------------------------------------------
function renderTabButton(tab) {
  return `          <div class="dash-tab" role="tab" data-tab-id="${tab.id}" aria-selected="false" tabindex="0" onclick="onTabClick(${tab.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();onTabClick(${tab.id});}">
            <span class="dash-tab-grip" title="Tab verschieben" aria-hidden="true">⠿</span>
            <span class="dash-tab-label">${escapeHtml(tab.title)}</span>
            <span class="dash-tab-tools">
              <button type="button" class="widget-icon-btn" title="Tab bearbeiten" aria-label="Tab ${escapeHtml(tab.title)} bearbeiten" onclick="event.stopPropagation();openTabDialog('edit', ${tab.id})">✎</button>
              <button type="button" class="widget-icon-btn" title="Tab löschen" aria-label="Tab ${escapeHtml(tab.title)} löschen" onclick="event.stopPropagation();openDeleteTabDialog(${tab.id}, ${toJsStringLiteral(tab.title)})">🗑</button>
            </span>
          </div>`;
}

function renderTabPanel(tab, ctx) {
  const ungroupedCards = tab.ungrouped.map((widget) => renderWidgetCard(widget, ctx)).join('\n');
  return `          <section class="dash-panel" role="tabpanel" data-tab-id="${tab.id}" hidden>
            <div class="widget-dropzone widget-grid" data-group="">${ungroupedCards ? `\n${ungroupedCards}\n            ` : ''}</div>
            <div class="widget-groups">
${tab.groups.map((group) => renderGroup(group, ctx)).join('\n')}
            </div>
          </section>`;
}

function groupWidthClass(width) {
  if (width === 'half') return 'widget-group--half';
  if (width === 'quarter') return 'widget-group--quarter';
  return 'widget-group--full';
}

function renderGroup(group, ctx = {}) {
  // Mobile Mindestbreite aus den enthaltenen Widget-Typen (zentrale Definition).
  const mobileClass = mobileMinWidthFor(group.widgets) === 'full' ? ' widget-group--mobile-full' : '';
  const cards = group.widgets.map((widget) => renderWidgetCard(widget, ctx)).join('\n');
  return `          <div class="widget-group ${groupWidthClass(group.width)}${mobileClass}" data-group-id="${group.id}">
            <div class="widget-group-head">
              <span class="widget-group-title">${escapeHtml(group.title)}</span>
              <div class="widget-edit-bar">
                <button type="button" class="widget-icon-btn" title="Gruppe bearbeiten" aria-label="Gruppe ${escapeHtml(group.title)} bearbeiten" onclick="openGroupDialog('edit', ${group.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Gruppe entfernen" aria-label="Gruppe ${escapeHtml(group.title)} entfernen" onclick="openDeleteGroupDialog(${group.id}, ${toJsStringLiteral(group.title)})">🗑</button>
              </div>
            </div>
            <div class="widget-dropzone widget-grid" data-group="${group.id}">${cards ? `\n${cards}\n            ` : ''}</div>
          </div>`;
}

// Bearbeitungs-Overlay (nur im Bearbeitungsmodus sichtbar, liegt über der
// Drag-Fläche und startet selbst keinen Drag).
function widgetEditBar(widget, label) {
  return `              <div class="widget-edit-bar">
                <button type="button" class="widget-icon-btn" title="Widget bearbeiten" aria-label="Widget ${escapeHtml(label)} bearbeiten" onclick="openWidgetDialog('edit', ${widget.id})">✎</button>
                <button type="button" class="widget-icon-btn" title="Widget entfernen" aria-label="Widget ${escapeHtml(label)} entfernen" onclick="openDeleteWidgetDialog(${widget.id}, ${toJsStringLiteral(label)})">🗑</button>
              </div>`;
}

function sizeClass(widget) {
  const def = widgetTypeDef(widget.type);
  if (!def.supportsSize) return '';
  const size = widget.size === 's' || widget.size === 'm' ? widget.size : 'l';
  return ` widget-card--size-${size}`;
}

function renderWidgetCard(widget, ctx = {}) {
  if (widget.type === 'info') return renderInfoCard(widget, ctx);
  if (widget.type === 'switch') return renderSwitchCard(widget);
  const label = widget.label || widget.sourceId;
  const currentDisplay = widget.currentDisplay == null ? '—' : widget.currentDisplay;
  const colorStyle = widget.color ? ` style="color:${escapeHtml(widget.color)}"` : '';
  return `            <div class="widget-card widget-card--value${sizeClass(widget)}" data-id="${widget.id}" data-type="value">
              <div class="widget-body">
                <div class="widget-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
                <div class="widget-value" id="widget-value-${widget.id}"${colorStyle}>${escapeHtml(currentDisplay)}</div>
              </div>
${widgetEditBar(widget, label)}
            </div>`;
}

// Schalter-Kachel: die gesamte sichtbare Fläche ist die Schaltfläche. Der
// Zustand steckt in data-on (true/false/unknown); eigene Ein-/Aus-Farben
// überschreiben die Standarddarstellung über CSS-Variablen.
function renderSwitchCard(widget) {
  const label = widget.label || widget.targetLabel || 'Schalter';
  const on = widget.on === true ? 'true' : widget.on === false ? 'false' : 'unknown';
  const stateText = widget.on === true ? 'Ein' : widget.on === false ? 'Aus' : '—';
  const styleVars = [
    widget.onColor ? `--switch-on-bg:${escapeHtml(widget.onColor)}` : '',
    widget.offColor ? `--switch-off-bg:${escapeHtml(widget.offColor)}` : '',
  ].filter(Boolean).join(';');
  return `            <div class="widget-card widget-card--switch${sizeClass(widget)}" data-id="${widget.id}" data-type="switch">
              <button type="button" class="switch-surface" id="switch-surface-${widget.id}" data-on="${on}" aria-pressed="${widget.on === true ? 'true' : 'false'}"${styleVars ? ` style="${styleVars}"` : ''} onclick="toggleSwitchWidget(${widget.id})">
                <span class="switch-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                <span class="switch-state" id="switch-state-${widget.id}">${stateText}</span>
              </button>
              <p class="switch-error" id="switch-error-${widget.id}" hidden></p>
${widgetEditBar(widget, label)}
            </div>`;
}

// Info-Kachel: listet die gewählten System-Felder untereinander. „usage"-Felder
// bekommen einen Fortschrittsbalken. Die Werte werden per data-info-Attribut
// live aktualisiert (siehe applySystemInfo).
function renderInfoCard(widget, { infoFields = [], systemInfo = {} } = {}) {
  const selected = widget.infoFields || infoFields.map((field) => field.key);
  const selectedSet = new Set(selected);
  const rows = infoFields
    .filter((field) => selectedSet.has(field.key))
    .map((field) => {
      const info = systemInfo[field.key] || {};
      const display = info.display == null ? '—' : info.display;
      if (field.type === 'usage') {
        const percent = info.percent == null ? 0 : info.percent;
        return `                <div class="info-row info-row--bar">
                  <div class="info-row-head">
                    <span class="info-row-key">${escapeHtml(field.label)}</span>
                    <span class="info-row-val" data-info="${escapeHtml(field.key)}">${escapeHtml(display)}</span>
                  </div>
                  <div class="progress"><div class="progress-bar" data-info-bar="${escapeHtml(field.key)}" style="width:${percent}%"></div></div>
                </div>`;
      }
      return `                <div class="info-row">
                  <span class="info-row-key">${escapeHtml(field.label)}</span>
                  <span class="info-row-val" data-info="${escapeHtml(field.key)}">${escapeHtml(display)}</span>
                </div>`;
    })
    .join('\n');
  return `            <div class="widget-card widget-card--info" data-id="${widget.id}" data-type="info">
              <div class="widget-body">
                <div class="widget-label">System</div>
                <div class="info-list">
${rows}
                </div>
              </div>
${widgetEditBar(widget, 'System')}
            </div>`;
}

// --- Dialoge -----------------------------------------------------------------
// Kompakte Farbwahl: verstecktes (validiertes) Feld + nativer Farbwähler +
// Zurücksetzen auf die Standardfarbe.
function renderColorChoice({ fieldId, name, label, defaultPicker }) {
  return `              <div class="field-block color-choice-block">
                <span>${escapeHtml(label)}</span>
                <div class="color-choice">
                  <input type="hidden" id="${fieldId}" name="${escapeHtml(name)}" value="">
                  <input type="color" id="${fieldId}Picker" value="${escapeHtml(defaultPicker)}" aria-label="${escapeHtml(label)} wählen" oninput="colorChoiceSet('${fieldId}', this.value)">
                  <span class="color-choice-state" id="${fieldId}State">Standard</span>
                  <button type="button" class="secondary-button color-choice-reset" onclick="colorChoiceReset('${fieldId}')">Standard</button>
                </div>
              </div>`;
}

function renderWidgetDialog({ internalValues, switchTargets, infoFields = [], tabs = [], groupsForSelect = [], tabTitleById = new Map(), dialogError = '' }) {
  const typeTabs = WIDGET_TYPE_DEFS
    .map((def, index) => `              <button type="button" class="dialog-tab${index === 0 ? ' is-active' : ''}" data-tab="${def.type}" onclick="setWidgetType('${def.type}')">${escapeHtml(def.label)}</button>`)
    .join('\n');
  const infoChecklist = infoFields
    .map(
      (field) => `                <label class="info-check">
                  <input type="checkbox" name="infoFields" value="${escapeHtml(field.key)}" checked>
                  <span>${escapeHtml(field.label)}</span>
                </label>`
    )
    .join('\n');
  const tabOptions = tabs
    .map((tab) => `<option value="${tab.id}">${escapeHtml(tab.title)}</option>`)
    .join('');
  const groupOptions = groupsForSelect
    .map((group) => {
      const tabTitle = tabTitleById.get(group.tabId);
      const suffix = tabs.length > 1 && tabTitle ? ` (${tabTitle})` : '';
      return `<option value="${group.id}">${escapeHtml(group.title + suffix)}</option>`;
    })
    .join('');
  const switchTargetOptions = switchTargets
    .map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(`${target.label} (${target.kind})`)}</option>`)
    .join('');
  const switchTargetHint = switchTargets.length
    ? ''
    : '<small class="muted">Keine schaltbaren Ziele vorhanden. Lege unter Messen + Schalten ein Gerät mit Schalt-Topic oder eine Schaltgruppe an.</small>';
  return `        <dialog id="widgetDialog" class="value-dialog">
          <form id="widgetForm" action="/dashboard/widgets" method="POST" class="dialog-form">
            <div class="dialog-hero">
              <div>
                <h3 id="widgetDialogTitle">Widget hinzufügen</h3>
              </div>
            </div>
            ${statusText(dialogError)}
            <input type="hidden" id="widgetType" name="type" value="value">
            <div class="dialog-tabs" role="tablist">
${typeTabs}
            </div>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block" for="widgetTabId">
                <span>Tab</span>
                <select id="widgetTabId" name="tabId">${tabOptions}</select>
                <small class="muted" id="widgetTabHint" hidden>Tab folgt der gewählten Gruppe.</small>
              </label>
              <label class="field-block" for="widgetGroupId">
                <span>Gruppe</span>
                <select id="widgetGroupId" name="groupId" onchange="syncWidgetTabSelect()">
                  <option value="">Direkt aufs Dashboard (keine Gruppe)</option>
                  ${groupOptions}
                </select>
              </label>
            </div>
            <div class="field-block" id="widgetSizeField">
              <span>Größe</span>
              <div class="size-choice" role="radiogroup" aria-label="Widget-Größe">
                <label><input type="radio" name="size" value="s"><span>S</span></label>
                <label><input type="radio" name="size" value="m"><span>M</span></label>
                <label><input type="radio" name="size" value="l" checked><span>L</span></label>
              </div>
            </div>
            <div class="tab-panel" data-panel="value">
              ${renderValueCatalog({ values: internalValues, inputId: 'widgetSourceId', name: 'sourceId', selectedId: '', label: 'Wert' })}
              ${renderColorChoice({ fieldId: 'widgetColor', name: 'color', label: 'Farbe des Werts', defaultPicker: '#1a1a2e' })}
            </div>
            <div class="tab-panel" data-panel="switch" hidden>
              <label class="field-block" for="widgetSwitchTarget">
                <span>Schaltet</span>
                <select id="widgetSwitchTarget" name="switchTarget">
                  <option value="">Bitte wählen…</option>
                  ${switchTargetOptions}
                </select>
                ${switchTargetHint}
              </label>
              <label class="field-block" for="widgetSwitchLabel">
                <span>Bezeichnung <span class="pool-optional">(optional, sonst Zielname)</span></span>
                <input type="text" id="widgetSwitchLabel" name="switchLabel" maxlength="60">
              </label>
              <div class="dialog-grid dialog-grid--two">
                ${renderColorChoice({ fieldId: 'widgetOnColor', name: 'onColor', label: 'Farbe „Ein"', defaultPicker: '#f6c945' })}
                ${renderColorChoice({ fieldId: 'widgetOffColor', name: 'offColor', label: 'Farbe „Aus"', defaultPicker: '#ffffff' })}
              </div>
            </div>
            <div class="tab-panel" data-panel="info" hidden>
              <div class="field-block">
                <span>Angezeigte Informationen</span>
                <div class="info-check-list">
${infoChecklist}
                </div>
              </div>
            </div>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeWidgetDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderGroupDialog({ groupWidths = [], tabs = [] } = {}) {
  const tabOptions = tabs
    .map((tab) => `<option value="${tab.id}">${escapeHtml(tab.title)}</option>`)
    .join('');
  return `        <dialog id="groupDialog" class="value-dialog">
          <form id="groupForm" action="/dashboard/groups" method="POST" class="dialog-form">
            <h3 id="groupDialogTitle">Gruppe hinzufügen</h3>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block" for="groupTitle">
                <span>Titel</span>
                <input type="text" id="groupTitle" name="title" required>
              </label>
              <label class="field-block" for="groupWidth">
                <span>Breite</span>
                <select id="groupWidth" name="width">
                  ${groupWidths
                    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
                    .join('')}
                </select>
              </label>
              <label class="field-block" for="groupTabId">
                <span>Tab</span>
                <select id="groupTabId" name="tabId">${tabOptions}</select>
              </label>
            </div>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeGroupDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderTabDialog({ maxTabTitleLength, tabDialogError = '' }) {
  return `        <dialog id="tabDialog" class="value-dialog">
          <form id="tabForm" action="/dashboard/tabs" method="POST" class="dialog-form">
            <h3 id="tabDialogTitle">Tab hinzufügen</h3>
            ${statusText(tabDialogError)}
            <label class="field-block" for="tabTitle">
              <span>Name</span>
              <input type="text" id="tabTitle" name="title" required maxlength="${Number(maxTabTitleLength)}">
            </label>
            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeTabDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteTabDialog() {
  return `        <dialog id="deleteTabDialog" class="value-dialog">
          <form id="deleteTabForm" method="POST" class="dialog-form">
            <h3>Tab löschen</h3>
            <p class="muted">Soll der Tab <strong id="deleteTabName"></strong> gelöscht werden?</p>
            <label class="field-block" id="deleteTabMove" for="deleteTabTarget">
              <span>Enthaltene Gruppen und Widgets verschieben nach</span>
              <select id="deleteTabTarget" name="targetTabId"></select>
            </label>
            <div class="button-row">
              <button type="submit" class="button-danger">Ja, löschen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteTabDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteWidgetDialog() {
  return `        <dialog id="deleteWidgetDialog" class="value-dialog">
          <form id="deleteWidgetForm" method="POST" class="dialog-form">
            <h3>Widget entfernen</h3>
            <p class="muted">Soll das Widget <strong id="deleteWidgetName"></strong> wirklich entfernt werden?</p>
            <div class="button-row">
              <button type="submit">Ja, entfernen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteWidgetDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteGroupDialog() {
  return `        <dialog id="deleteGroupDialog" class="value-dialog">
          <form id="deleteGroupForm" method="POST" class="dialog-form">
            <h3>Gruppe entfernen</h3>
            <p class="muted">Soll die Gruppe <strong id="deleteGroupName"></strong> entfernt werden? Die enthaltenen Widgets bleiben als freie Dashboard-Widgets auf dem Tab erhalten.</p>
            <div class="button-row">
              <button type="submit">Ja, entfernen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteGroupDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function toJsStringLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

module.exports = renderDashboard;
