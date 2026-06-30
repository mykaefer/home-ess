'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

const MODES = [
  { value: 1, label: 'Privat' },
  { value: 2, label: 'Beruflich' },
  { value: 3, label: 'Immer voll' },
];

const WEEKDAYS = [
  { index: 0, label: 'Mo' }, { index: 1, label: 'Di' }, { index: 2, label: 'Mi' },
  { index: 3, label: 'Do' }, { index: 4, label: 'Fr' }, { index: 5, label: 'Sa' },
  { index: 6, label: 'So' },
];

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

function modeButtons(box) {
  return MODES.map((m) =>
    `<button class="pump-mode-btn" id="wb-mode-${box.id}-${m.value}" onclick="setWallboxMode(${box.id}, ${m.value})">${m.label}</button>`
  ).join('');
}

function boxCard(box, live) {
  const v = live || {};
  const f = v.formatted || {};
  return `            <div class="plant-card">
              <div class="plant-main">
                <div>
                  <h3>${escapeHtml(box.name)}</h3>
                  <p class="muted">Max ${escapeHtml(box.maxPowerW)} W · Fahrzeug-Akku ${escapeHtml(box.batteryCapacityKwh)} kWh</p>
                  <div class="pump-mode-btns" id="wb-modes-${box.id}">${modeButtons(box)}</div>
                </div>
                <div class="plant-power-stack">
                  <div class="plant-power" id="wb-power-${box.id}">${escapeHtml(f.power || '— W')}</div>
                  <div class="plant-power-ideal">SoC: <span id="wb-soc-${box.id}">${escapeHtml(f.soc || '— %')}</span><span id="wb-plug-${box.id}">${v.plugged === true ? ' · 🔌 angesteckt' : v.plugged === false ? ' · nicht angesteckt' : ''}</span></div>
                </div>
              </div>
              <div class="plant-meta">
                <span class="plant-yield">Heute: <span id="wb-today-${box.id}">${escapeHtml(f.today || '— kWh')}</span></span>
                <span class="plant-yield">Woche: <span id="wb-week-${box.id}">${escapeHtml(f.week || '— kWh')}</span></span>
                <span class="plant-yield">Monat: <span id="wb-month-${box.id}">${escapeHtml(f.month || '— kWh')}</span></span>
                <span class="plant-yield">Jahr: <span id="wb-year-${box.id}">${escapeHtml(f.year || '— kWh')}</span> (Vorjahr: <span id="wb-prev-${box.id}">${escapeHtml(f.previousYear || '— kWh')}</span>)</span>
                <span class="plant-yield">Nächster Ladebeginn: <span id="wb-next-${box.id}">${escapeHtml(f.nextCharge || '—')}</span></span>
                <div class="plant-actions">
                  <button type="button" class="secondary-button" onclick="openBoxDialog('edit', ${box.id})">Bearbeiten</button>
                  <button type="button" class="icon-button" aria-label="Wallbox löschen" title="Wallbox löschen" onclick="openDeleteDialog(${box.id}, ${toJsStringLiteral(box.name)})">🗑</button>
                </div>
              </div>
            </div>`;
}

function topicField(id, name, label, value, optional, placeholder) {
  return `<label class="field-block" for="${id}">
                  <span>${escapeHtml(label)}${optional ? ' <span class="pool-optional">(optional)</span>' : ''}</span>
                  <input type="text" id="${id}" name="${name}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}">
                </label>`;
}

function renderBoxDialog({ dialogError, dialogValues, dialogMode, editingBoxId }) {
  const v = dialogValues || {
    name: '', maxPowerW: 11000, batteryCapacityKwh: 50, commandTopic: '', statusTopic: '',
    powerTopic: '', powerUnit: 'W', counterTopic: '', counterUnit: 'kWh', setpointTopic: '',
    pluggedTopic: '', socTopic: '', modeSyncTopic: '', priorityPrivate: 5, priorityBusiness: 3,
    priorityFull: 4, minChargePercent: 30, businessDays: [], stallTimeoutSeconds: 120, stallPowerW: 200,
  };
  const action = dialogMode === 'edit' && editingBoxId != null
    ? `/wallbox/boxes/${editingBoxId}` : '/wallbox/boxes';
  const businessDays = Array.isArray(v.businessDays) ? v.businessDays : [];

  return `        <dialog id="boxDialog" class="value-dialog">
          <form id="boxForm" action="${escapeHtml(action)}" method="POST" class="dialog-form dialog-form--plant">
            <div class="dialog-hero">
              <div>
                <h3 id="boxDialogTitle">Wallbox hinzufügen</h3>
                <p class="muted">Stammdaten, MQTT-Topics und Lademodus-Prioritäten in einer Ansicht.</p>
              </div>
            </div>
            ${statusText(dialogError)}

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>Stammdaten</h4></div>
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="wbName"><span>Name</span>
                  <input type="text" id="wbName" name="name" value="${escapeHtml(v.name)}" required></label>
                <label class="field-block" for="wbMaxPower"><span>Maximalleistung (W)</span>
                  <input type="number" step="100" id="wbMaxPower" name="maxPowerW" value="${escapeHtml(v.maxPowerW)}" required></label>
                <label class="field-block" for="wbCapacity"><span>Fahrzeug-Akkugröße (kWh)</span>
                  <input type="number" step="0.1" id="wbCapacity" name="batteryCapacityKwh" value="${escapeHtml(v.batteryCapacityKwh)}" required></label>
              </div>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>MQTT-Topics</h4>
                <p class="muted">Nur das Steuer-Topic ist erforderlich. Ohne Status-Topic dient das Steuer-Topic als Ist-Stand. Ohne Zähler-Topic wird der Verbrauch aus der Leistung abgeleitet.</p></div>
              <div class="dialog-grid dialog-grid--two">
                ${topicField('wbCommand', 'commandTopic', 'Steuer-Topic (an/aus)', v.commandTopic, false, 'z.B. wallbox.0.enabled')}
                ${topicField('wbStatus', 'statusTopic', 'Status-Topic', v.statusTopic, true, 'z.B. wallbox.0.charging')}
                <label class="field-block" for="wbPower"><span>Leistungs-Topic <span class="pool-optional">(optional)</span></span>
                  <div style="display:flex;gap:8px;">
                    <input type="text" id="wbPower" name="powerTopic" value="${escapeHtml(v.powerTopic)}" placeholder="z.B. wallbox.0.power" style="flex:1;">
                    <select name="powerUnit" aria-label="Leistungseinheit">${unitOptions(['W', 'kW'], v.powerUnit)}</select>
                  </div></label>
                <label class="field-block" for="wbCounter"><span>Zähler-Topic <span class="pool-optional">(optional)</span></span>
                  <div style="display:flex;gap:8px;">
                    <input type="text" id="wbCounter" name="counterTopic" value="${escapeHtml(v.counterTopic)}" placeholder="z.B. wallbox.0.totalEnergy" style="flex:1;">
                    <select name="counterUnit" aria-label="Zählereinheit">${unitOptions(['Wh', 'kWh'], v.counterUnit)}</select>
                  </div></label>
                ${topicField('wbSetpoint', 'setpointTopic', 'Soll-Leistungs-Topic', v.setpointTopic, true, 'z.B. wallbox.0.setpoint')}
                ${topicField('wbPlugged', 'pluggedTopic', 'Fahrzeug-angesteckt-Topic (true/false)', v.pluggedTopic, true, 'z.B. wallbox.0.plugged')}
                ${topicField('wbSoc', 'socTopic', 'Fahrzeug-SoC-Topic (%)', v.socTopic, true, 'z.B. wallbox.0.soc')}
                ${topicField('wbModeSync', 'modeSyncTopic', 'Modus-Sync-Topic', v.modeSyncTopic, true, 'z.B. wallbox.0.mode')}
              </div>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>Lademodi & Prioritäten</h4>
                <p class="muted">Priorität = Betriebslevel, ab dem geladen werden darf (1 = immer, 5 = nur bei Überschuss).</p></div>
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="wbPrioPrivate"><span>Priorität Privat</span>
                  <select id="wbPrioPrivate" name="priorityPrivate">${priorityOptions(v.priorityPrivate, 5)}</select></label>
                <label class="field-block" for="wbPrioBusiness"><span>Priorität Beruflich</span>
                  <select id="wbPrioBusiness" name="priorityBusiness">${priorityOptions(v.priorityBusiness, 3)}</select></label>
                <label class="field-block" for="wbPrioFull"><span>Priorität Immer voll</span>
                  <select id="wbPrioFull" name="priorityFull">${priorityOptions(v.priorityFull, 4)}</select></label>
                <label class="field-block" for="wbMinCharge"><span>Mindest-Ladestand Privat (%)</span>
                  <input type="number" min="0" max="100" step="1" id="wbMinCharge" name="minChargePercent" value="${escapeHtml(v.minChargePercent)}"></label>
              </div>
              <div class="dialog-section-head" style="margin-top:14px;"><h4 style="font-size:14px;">Beruflich: Arbeitstage (Auto muss voll bereitstehen)</h4></div>
              <div class="pump-mode-btns" style="flex-wrap:wrap;">
                ${WEEKDAYS.map((d) => `<label class="remember-row remember-row--boxed" style="margin:2px;" for="wbDay${d.index}">
                  <input type="checkbox" id="wbDay${d.index}" name="businessDays" value="${d.index}"${businessDays.includes(d.index) ? ' checked' : ''}>
                  <span>${d.label}</span></label>`).join('')}
              </div>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head"><h4>Sonderfälle</h4>
                <p class="muted">Hängt der Ladevorgang trotz Ladebefehl nach der Vorgabezeit unter der Leerlaufschwelle, wird einmal für eine Minute aus- und wieder eingeschaltet (Neustart). Nur wirksam mit Leistungs-Topic.</p></div>
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="wbStallTimeout"><span>Neustart nach Vorgabezeit (s)</span>
                  <input type="number" min="0" step="10" id="wbStallTimeout" name="stallTimeoutSeconds" value="${escapeHtml(v.stallTimeoutSeconds)}"></label>
                <label class="field-block" for="wbStallPower"><span>Leerlauf-Schwelle (W)</span>
                  <input type="number" min="0" step="10" id="wbStallPower" name="stallPowerW" value="${escapeHtml(v.stallPowerW)}"></label>
              </div>
            </div>

            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closeBoxDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteDialog() {
  return `        <dialog id="deleteBoxDialog" class="value-dialog">
          <form id="deleteBoxForm" method="POST" class="dialog-form">
            <h3>Wallbox löschen</h3>
            <p class="muted">Soll die Wallbox <strong id="deleteBoxName"></strong> wirklich gelöscht werden?</p>
            <div class="button-row">
              <button type="submit" class="button-danger">Ja, löschen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderWallbox({
  boxes = [], values = [], formMessage = '', formError = '',
  dialogMode = '', dialogError = '', dialogValues = null, editingBoxId = null,
} = {}) {
  const valueById = new Map(values.map((v) => [v.id, v]));
  const list = boxes.length
    ? `<div class="plant-list">\n${boxes.map((b) => boxCard(b, valueById.get(b.id))).join('\n')}\n          </div>`
    : '<div class="info-card"><p class="muted">Noch keine Wallbox angelegt.</p></div>';

  const body = `        <h1>Wallbox</h1>

        <div class="panel-card">
          <div class="panel-head">
            <div>
              <h2>Wallboxen</h2>
              <p class="muted">Jede Wallbox wird über MQTT gesteuert und gemessen. Der Lademodus (Privat / Beruflich / Immer voll) regelt vorausschauend gegen PV-Überschuss und den Mindest-SoC der Hausbatterie.</p>
            </div>
            <button type="button" class="settings-form button-inline" onclick="openBoxDialog('add')">Hinzufügen</button>
          </div>
          ${statusText(formError)}
          ${statusText(formMessage, 'success')}
          ${list}
        </div>

        ${renderBoxDialog({ dialogError, dialogValues, dialogMode, editingBoxId })}
        ${renderDeleteDialog()}`;

  const script = `    const wallboxes = ${JSON.stringify(boxes)};
    const modeByBox = ${JSON.stringify(Object.fromEntries(values.map((v) => [v.id, v.mode])))};
    const initialDialogMode = ${JSON.stringify(dialogMode)};
    const initialEditingBoxId = ${editingBoxId == null ? 'null' : Number(editingBoxId)};
    const initialDialogValues = ${JSON.stringify(dialogValues || {})};

    function applyModeButtons(id, mode) {
      [1, 2, 3].forEach(function (m) {
        var btn = document.getElementById('wb-mode-' + id + '-' + m);
        if (!btn) return;
        btn.className = 'pump-mode-btn' + (m === mode ? ' pump-mode-btn--active-on' : '');
      });
    }
    Object.keys(modeByBox).forEach(function (id) { applyModeButtons(Number(id), modeByBox[id]); });

    function setWallboxMode(id, mode) {
      fetch('/wallbox/box/' + id + '/mode/' + mode, { method: 'POST' })
        .then(function () { applyModeButtons(id, mode); setTimeout(refreshWallbox, 300); })
        .catch(function () {});
    }

    function setBoxFormValues(v) {
      document.getElementById('wbName').value = v.name || '';
      document.getElementById('wbMaxPower').value = v.maxPowerW == null ? '' : v.maxPowerW;
      document.getElementById('wbCapacity').value = v.batteryCapacityKwh == null ? '' : v.batteryCapacityKwh;
      document.getElementById('wbCommand').value = v.commandTopic || '';
      document.getElementById('wbStatus').value = v.statusTopic || '';
      document.getElementById('wbPower').value = v.powerTopic || '';
      document.getElementById('wbCounter').value = v.counterTopic || '';
      document.getElementById('wbSetpoint').value = v.setpointTopic || '';
      document.getElementById('wbPlugged').value = v.pluggedTopic || '';
      document.getElementById('wbSoc').value = v.socTopic || '';
      document.getElementById('wbModeSync').value = v.modeSyncTopic || '';
      document.querySelector('[name=powerUnit]').value = v.powerUnit || 'W';
      document.querySelector('[name=counterUnit]').value = v.counterUnit || 'kWh';
      document.getElementById('wbPrioPrivate').value = v.priorityPrivate == null ? 5 : v.priorityPrivate;
      document.getElementById('wbPrioBusiness').value = v.priorityBusiness == null ? 3 : v.priorityBusiness;
      document.getElementById('wbPrioFull').value = v.priorityFull == null ? 4 : v.priorityFull;
      document.getElementById('wbMinCharge').value = v.minChargePercent == null ? 30 : v.minChargePercent;
      document.getElementById('wbStallTimeout').value = v.stallTimeoutSeconds == null ? 120 : v.stallTimeoutSeconds;
      document.getElementById('wbStallPower').value = v.stallPowerW == null ? 200 : v.stallPowerW;
      var days = Array.isArray(v.businessDays) ? v.businessDays : [];
      [0,1,2,3,4,5,6].forEach(function (d) {
        var cb = document.getElementById('wbDay' + d);
        if (cb) cb.checked = days.indexOf(d) !== -1;
      });
    }

    function openBoxDialog(mode, boxId) {
      var dialog = document.getElementById('boxDialog');
      if (!dialog) return;
      var form = document.getElementById('boxForm');
      var title = document.getElementById('boxDialogTitle');
      var box = wallboxes.find(function (b) { return b.id === boxId; }) || null;
      if (mode === 'edit' && box) {
        form.action = '/wallbox/boxes/' + box.id;
        title.textContent = 'Wallbox bearbeiten';
        setBoxFormValues(box);
      } else {
        form.action = '/wallbox/boxes';
        title.textContent = 'Wallbox hinzufügen';
        setBoxFormValues({ powerUnit: 'W', counterUnit: 'kWh', priorityPrivate: 5,
          priorityBusiness: 3, priorityFull: 4, minChargePercent: 30, maxPowerW: 11000,
          batteryCapacityKwh: 50, businessDays: [], stallTimeoutSeconds: 120, stallPowerW: 200 });
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeBoxDialog() { var d = document.getElementById('boxDialog'); if (d) d.close(); }

    function openDeleteDialog(boxId, boxName) {
      var dialog = document.getElementById('deleteBoxDialog');
      if (!dialog) return;
      document.getElementById('deleteBoxName').textContent = boxName;
      document.getElementById('deleteBoxForm').action = '/wallbox/boxes/' + boxId + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }
    function closeDeleteDialog() { var d = document.getElementById('deleteBoxDialog'); if (d) d.close(); }

    async function refreshWallbox() {
      try {
        var res = await fetch('/wallbox/data', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        var data = await res.json();
        (data.boxes || []).forEach(function (b) {
          var f = b.formatted || {};
          var set = function (id, val) { var el = document.getElementById(id); if (el && val != null) el.textContent = val; };
          set('wb-power-' + b.id, f.power);
          set('wb-soc-' + b.id, f.soc);
          set('wb-today-' + b.id, f.today);
          set('wb-week-' + b.id, f.week);
          set('wb-month-' + b.id, f.month);
          set('wb-year-' + b.id, f.year);
          set('wb-prev-' + b.id, f.previousYear);
          set('wb-next-' + b.id, f.nextCharge || '—');
          var plug = document.getElementById('wb-plug-' + b.id);
          if (plug) plug.textContent = b.plugged === true ? ' · 🔌 angesteckt' : b.plugged === false ? ' · nicht angesteckt' : '';
          applyModeButtons(b.id, b.mode);
        });
      } catch (_) {}
    }

    refreshWallbox();
    window.addEventListener('homeess:mqtt', refreshWallbox);
    setInterval(refreshWallbox, 15000);

    if (initialDialogMode === 'add') { openBoxDialog('add'); setBoxFormValues(initialDialogValues); }
    else if (initialDialogMode === 'edit' && initialEditingBoxId != null) { openBoxDialog('edit', initialEditingBoxId); setBoxFormValues(initialDialogValues); }`;

  return renderLayout({ title: 'Wallbox', activePath: '/wallbox', body, script });
}

function toJsStringLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

module.exports = renderWallbox;
