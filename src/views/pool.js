'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml } = require('./components');
const { PHASES } = require('../grid-control/load-shed');

function priorityOptions(selected, def) {
  const val = selected != null ? Number(selected) : def;
  return [1, 2, 3, 4, 5].map((n) => {
    const label = n === 1 ? '1 – höchste' : n === 5 ? '5 – niedrigste' : String(n);
    const sel = n === val ? ' selected' : '';
    return `<option value="${n}"${sel}>${label}</option>`;
  }).join('');
}

function timeField(name, value, disabled) {
  const dis = disabled ? ' disabled' : '';
  return `<input type="time" name="${name}" value="${escapeHtml(value || '')}"${dis} class="pool-time-input">`;
}

function phaseOptions(selected) {
  const labels = { l1: 'L1', l2: 'L2', l3: 'L3', three_phase: 'Drehstrom' };
  return PHASES.map((phase) => `<option value="${phase}"${phase === selected ? ' selected' : ''}>${labels[phase]}</option>`).join('');
}

function renderPool({ cfg = {}, message = '', solarOutput = null, filterOutput = null, batterieSocConfigured = false, gridControlEnabled = false } = {}) {
  const {
    temperatureTopic = '',
    solarPumpStatusTopic = '',
    solarPumpCommandTopic = '',
    solarPumpPriority = 2,
    solarPumpPhase = 'l1',
    solarPumpMaxTemp = '',
    solarPumpTempOnSeconds = 30,
    solarPumpTempPauseMinutes = 30,
    solarPumpTempUseFilter = false,
    solarPumpRatedPowerW = '',
    filterPumpStatusTopic = '',
    filterPumpCommandTopic = '',
    filterPumpPriority = 4,
    filterPumpPhase = 'l1',
    filterPumpFollowSolar = false,
    filterTime1Start = '', filterTime1End = '',
    filterTime2Start = '', filterTime2End = '',
    filterTime3Start = '', filterTime3End = '',
    filterBatteryEnabled = false,
    filterBatterySoc = 80,
    filterPumpRatedPowerW = '',
    phTopic = '',
    chlorTopic = '',
  } = cfg;

  const followSolarChecked = filterPumpFollowSolar ? ' checked' : '';
  const batteryChecked = filterBatteryEnabled ? ' checked' : '';
  const timesDisabled = !!filterPumpFollowSolar;
  const batteryDisplay = filterBatteryEnabled ? '' : ' style="display:none"';

  // ── KPI-Karten (nur wenn Topic konfiguriert) ──────────────────────────────
  const kpiCards = [];

  if (temperatureTopic) {
    kpiCards.push(`
          <div class="kpi-card kpi-card--pool">
            <div class="kpi-label">Wassertemperatur</div>
            <div class="kpi-value" id="kpi-temp">—</div>
          </div>`);
  }
  if (solarPumpStatusTopic) {
    kpiCards.push(`
          <div class="kpi-card kpi-card--pool">
            <div class="kpi-label">Solarpumpe</div>
            <div class="kpi-value" id="kpi-solar">—</div>
            ${solarPumpCommandTopic ? `<div class="kpi-action pump-mode-btns">
              <button class="pump-mode-btn" id="solar-btn-on"   onclick="setPumpMode('solar','on')">An</button>
              <button class="pump-mode-btn" id="solar-btn-off"  onclick="setPumpMode('solar','off')">Aus</button>
              <button class="pump-mode-btn" id="solar-btn-auto" onclick="setPumpMode('solar','auto')">Automatik</button>
            </div>` : ''}
          </div>`);
  }
  if (filterPumpStatusTopic) {
    kpiCards.push(`
          <div class="kpi-card kpi-card--pool">
            <div class="kpi-label">Filterpumpe</div>
            <div class="kpi-value" id="kpi-filter">—</div>
            ${filterPumpCommandTopic ? `<div class="kpi-action pump-mode-btns">
              <button class="pump-mode-btn" id="filter-btn-on"   onclick="setPumpMode('filter','on')">An</button>
              <button class="pump-mode-btn" id="filter-btn-off"  onclick="setPumpMode('filter','off')">Aus</button>
              <button class="pump-mode-btn" id="filter-btn-auto" onclick="setPumpMode('filter','auto')">Automatik</button>
            </div>` : ''}
          </div>`);
  }
  if (phTopic) {
    kpiCards.push(`
          <div class="kpi-card kpi-card--pool">
            <div class="kpi-label">pH-Wert</div>
            <div class="kpi-value" id="kpi-ph">—</div>
          </div>`);
  }
  if (chlorTopic) {
    kpiCards.push(`
          <div class="kpi-card kpi-card--pool">
            <div class="kpi-label">Chlor</div>
            <div class="kpi-value" id="kpi-chlor">—</div>
          </div>`);
  }

  const kpiSection = kpiCards.length
    ? `        <div class="kpi-row">${kpiCards.join('')}
        </div>`
    : '';

  // ── Konfigurations-Formular ───────────────────────────────────────────────
  const body = `        <h1>Poolsteuerung</h1>

${kpiSection}
        <form action="/pool/config" method="POST" class="settings-form" style="margin-top:24px;">
          ${message ? `<p class="module-message">${escapeHtml(message)}</p>` : ''}

          <section class="settings-card">
            <div class="settings-card-head">
              <h2>Messpunkte</h2>
              <p class="settings-card-hint">Sensor-Topics für Wassertemperatur und Wasserqualität.</p>
            </div>
            <div class="field-grid">
              <div class="field">
                <label for="temperatureTopic">Wassertemperatur</label>
                <input type="text" id="temperatureTopic" name="temperatureTopic"
                       placeholder="z.B. pool.0.waterTemperature"
                       value="${escapeHtml(temperatureTopic)}">
              </div>
              <div class="field">
                <label for="phTopic">pH-Wert <span class="pool-optional">(optional)</span></label>
                <input type="text" id="phTopic" name="phTopic"
                       placeholder="z.B. pool.0.phValue"
                       value="${escapeHtml(phTopic)}">
              </div>
              <div class="field">
                <label for="chlorTopic">Chlorgehalt <span class="pool-optional">(optional)</span></label>
                <input type="text" id="chlorTopic" name="chlorTopic"
                       placeholder="z.B. pool.0.chlorine"
                       value="${escapeHtml(chlorTopic)}">
              </div>
            </div>
          </section>

          <section class="settings-card">
            <div class="settings-card-head">
              <h2>Solarpumpe</h2>
              <p class="settings-card-hint">Schaltet automatisch bei direkter Sonneneinstrahlung. Nach jeder Schaltung wird der Zustand mindestens 2 Minuten gehalten. Bei Erreichen der Maximaltemperatur wechselt die Pumpe in einen Probebetrieb (30 s alle 30 min).</p>
            </div>
            <div class="field-grid">
              <div class="field">
                <label for="solarPumpStatusTopic">Status-Topic</label>
                <input type="text" id="solarPumpStatusTopic" name="solarPumpStatusTopic"
                       placeholder="z.B. pool.0.solarPumpRunning"
                       value="${escapeHtml(solarPumpStatusTopic)}">
              </div>
              <div class="field">
                <label for="solarPumpCommandTopic">Steuerungs-Topic <span class="pool-optional">(optional)</span></label>
                <input type="text" id="solarPumpCommandTopic" name="solarPumpCommandTopic"
                       placeholder="z.B. pool.0.solarPumpSwitch"
                       value="${escapeHtml(solarPumpCommandTopic)}">
              </div>
              <div class="field">
                <label for="solarPumpPriority">Priorität</label>
                <select id="solarPumpPriority" name="solarPumpPriority">
                  ${priorityOptions(solarPumpPriority, 2)}
                </select>
              </div>
              <div class="field">
                <label for="solarPumpPhase">Lastabwurf-Phase</label>
                <select id="solarPumpPhase" name="solarPumpPhase"${gridControlEnabled ? '' : ' disabled'}>
                  ${phaseOptions(solarPumpPhase)}
                </select>
                ${gridControlEnabled ? '' : '<input type="hidden" name="solarPumpPhase" value="' + escapeHtml(solarPumpPhase) + '">' }
              </div>
              <div class="field">
                <label for="solarPumpMaxTemp">Max. Wassertemperatur (°C) <span class="pool-optional">(optional)</span></label>
                <input type="number" step="0.5" id="solarPumpMaxTemp" name="solarPumpMaxTemp"
                       placeholder="z.B. 28"
                       value="${escapeHtml(String(solarPumpMaxTemp !== '' && solarPumpMaxTemp != null ? solarPumpMaxTemp : ''))}">
              </div>
              <div class="field">
                <label for="solarPumpTempOnSeconds">Einschaltdauer bei Überschreitung (s)</label>
                <input type="number" min="5" max="3600" id="solarPumpTempOnSeconds" name="solarPumpTempOnSeconds"
                       placeholder="30"
                       value="${escapeHtml(String(solarPumpTempOnSeconds || 30))}">
              </div>
              <div class="field">
                <label for="solarPumpTempPauseMinutes">Pause zwischen Probeläufen (min)</label>
                <input type="number" min="1" max="1440" id="solarPumpTempPauseMinutes" name="solarPumpTempPauseMinutes"
                       placeholder="30"
                       value="${escapeHtml(String(solarPumpTempPauseMinutes || 30))}">
              </div>
              <div class="field">
                <label for="solarPumpRatedPowerW">Nennleistung (W) <span class="pool-optional">(für Prognose)</span></label>
                <input type="number" min="0" step="1" id="solarPumpRatedPowerW" name="solarPumpRatedPowerW"
                       placeholder="z.B. 250"
                       value="${escapeHtml(String(solarPumpRatedPowerW !== '' && solarPumpRatedPowerW != null ? solarPumpRatedPowerW : ''))}">
              </div>
            </div>
            <label class="checkbox-field" style="margin-top:14px;" for="solarPumpTempUseFilter">
              <input type="checkbox" id="solarPumpTempUseFilter" name="solarPumpTempUseFilter"
                     value="1"${solarPumpTempUseFilter ? ' checked' : ''}
                     ${(filterPumpStatusTopic && filterPumpCommandTopic) ? '' : ' disabled'}>
              <span>Für Probelauf die Filterpumpe verwenden <span class="pool-optional" id="temp-use-filter-hint">${!(filterPumpStatusTopic && filterPumpCommandTopic) ? '(Filterpumpe nicht konfiguriert)' : ''}</span></span>
            </label>
          </section>

          <section class="settings-card">
            <div class="settings-card-head">
              <h2>Filterpumpe</h2>
              <p class="settings-card-hint">Feste Filterzeiten oder Kopplung an die Solarpumpensteuerung. Der Akku-Override schaltet die Pumpe zusätzlich zu, sobald ein einstellbarer Ladestand erreicht wird.</p>
            </div>
            <div class="field-grid">
              <div class="field">
                <label for="filterPumpStatusTopic">Status-Topic</label>
                <input type="text" id="filterPumpStatusTopic" name="filterPumpStatusTopic"
                       placeholder="z.B. pool.0.filterPumpRunning"
                       value="${escapeHtml(filterPumpStatusTopic)}">
              </div>
              <div class="field">
                <label for="filterPumpCommandTopic">Steuerungs-Topic <span class="pool-optional">(optional)</span></label>
                <input type="text" id="filterPumpCommandTopic" name="filterPumpCommandTopic"
                       placeholder="z.B. pool.0.filterPumpSwitch"
                       value="${escapeHtml(filterPumpCommandTopic)}">
              </div>
              <div class="field">
                <label for="filterPumpPriority">Priorität</label>
                <select id="filterPumpPriority" name="filterPumpPriority">
                  ${priorityOptions(filterPumpPriority, 4)}
                </select>
              </div>
              <div class="field">
                <label for="filterPumpPhase">Lastabwurf-Phase</label>
                <select id="filterPumpPhase" name="filterPumpPhase"${gridControlEnabled ? '' : ' disabled'}>
                  ${phaseOptions(filterPumpPhase)}
                </select>
                ${gridControlEnabled ? '' : '<input type="hidden" name="filterPumpPhase" value="' + escapeHtml(filterPumpPhase) + '">' }
              </div>
              <div class="field">
                <label for="filterPumpRatedPowerW">Nennleistung (W) <span class="pool-optional">(für Prognose)</span></label>
                <input type="number" min="0" step="1" id="filterPumpRatedPowerW" name="filterPumpRatedPowerW"
                       placeholder="z.B. 600"
                       value="${escapeHtml(String(filterPumpRatedPowerW !== '' && filterPumpRatedPowerW != null ? filterPumpRatedPowerW : ''))}">
              </div>
            </div>
            ${gridControlEnabled ? '' : '<p class="settings-card-hint">Grid-Control ist deaktiviert. Die Lastabwurf-Phase wird erst bei aktivem Modul verwendet.</p>'}

            <label class="checkbox-field" style="margin-top:16px;" for="filterPumpFollowSolar">
              <input type="checkbox" id="filterPumpFollowSolar" name="filterPumpFollowSolar"
                     value="1"${followSolarChecked} onchange="toggleFollowSolar()">
              <span>Pumpe folgt der Solarpumpensteuerung (Filterzeiten werden ignoriert)</span>
            </label>

            <div id="filter-times-section" style="margin-top:18px;${timesDisabled ? 'opacity:.45;pointer-events:none;' : ''}">
              <p class="settings-card-hint" style="margin-bottom:12px;">Bis zu 3 Filterzeitfenster (Start- und Endzeit):</p>
              <div class="pool-time-grid">
                <span class="pool-time-label">Fenster 1</span>
                ${timeField('filterTime1Start', filterTime1Start, timesDisabled)}
                <span class="pool-time-sep">–</span>
                ${timeField('filterTime1End', filterTime1End, timesDisabled)}

                <span class="pool-time-label">Fenster 2</span>
                ${timeField('filterTime2Start', filterTime2Start, timesDisabled)}
                <span class="pool-time-sep">–</span>
                ${timeField('filterTime2End', filterTime2End, timesDisabled)}

                <span class="pool-time-label">Fenster 3</span>
                ${timeField('filterTime3Start', filterTime3Start, timesDisabled)}
                <span class="pool-time-sep">–</span>
                ${timeField('filterTime3End', filterTime3End, timesDisabled)}
              </div>
            </div>

            <label class="checkbox-field" style="margin-top:18px;" for="filterBatteryEnabled">
              <input type="checkbox" id="filterBatteryEnabled" name="filterBatteryEnabled"
                     value="1"${batteryChecked} onchange="toggleBatterySection()"
                     ${batterieSocConfigured ? '' : 'disabled'}>
              <span>Automatisch zuschalten ab einem bestimmten Akkustand
                ${batterieSocConfigured ? '' : '<span class="pool-optional">(Batterie-SoC-Topic nicht konfiguriert)</span>'}
              </span>
            </label>

            <div id="battery-section"${batteryDisplay} style="margin-top:14px; padding:14px; background:#f8f9fb; border:1px solid #e2e6ea; border-radius:8px;">
              <div class="pool-soc-row">
                <label for="filterBatterySocSlider" style="font-weight:600;font-size:14px;">Mindest-Akkustand</label>
                <div class="pool-soc-control">
                  <input type="range" id="filterBatterySocSlider" name="filterBatterySoc"
                         min="0" max="100" value="${Number(filterBatterySoc) || 80}"
                         oninput="document.getElementById('battery-soc-label').textContent = this.value + ' %'">
                  <span id="battery-soc-label" class="pool-soc-label">${Number(filterBatterySoc) || 80} %</span>
                </div>
              </div>
            </div>
          </section>

          <div class="button-row">
            <button type="submit">Konfiguration speichern</button>
          </div>
        </form>`;

  const script = `
    // ── Formular-Interaktivität ──────────────────────────────────────────────
    function updateTempUseFilterState() {
      var statusOk = (document.getElementById('filterPumpStatusTopic').value || '').trim() !== '';
      var cmdOk    = (document.getElementById('filterPumpCommandTopic').value || '').trim() !== '';
      var available = statusOk && cmdOk;
      var cb   = document.getElementById('solarPumpTempUseFilter');
      var hint = document.getElementById('temp-use-filter-hint');
      cb.disabled = !available;
      if (!available) cb.checked = false;
      hint.textContent = available ? '' : '(Filterpumpe nicht konfiguriert)';
    }

    document.getElementById('filterPumpStatusTopic').addEventListener('input', updateTempUseFilterState);
    document.getElementById('filterPumpCommandTopic').addEventListener('input', updateTempUseFilterState);

    function toggleFollowSolar() {
      var checked = document.getElementById('filterPumpFollowSolar').checked;
      var section = document.getElementById('filter-times-section');
      section.style.opacity = checked ? '0.45' : '1';
      section.style.pointerEvents = checked ? 'none' : '';
      section.querySelectorAll('input').forEach(function(el) { el.disabled = checked; });
    }

    function toggleBatterySection() {
      var checked = document.getElementById('filterBatteryEnabled').checked;
      document.getElementById('battery-section').style.display = checked ? '' : 'none';
    }

    // ── Live-Status via Polling ──────────────────────────────────────────────
    function applyModeButtons(which, mode) {
      ['on', 'off', 'auto'].forEach(function(m) {
        var btn = document.getElementById(which + '-btn-' + m);
        if (!btn) return;
        btn.className = 'pump-mode-btn' + (m === mode ? ' pump-mode-btn--active-' + m : '');
      });
    }

    function applyStatus(data) {
      if (!data) return;
      var tempEl   = document.getElementById('kpi-temp');
      var solarEl  = document.getElementById('kpi-solar');
      var filterEl = document.getElementById('kpi-filter');
      var phEl     = document.getElementById('kpi-ph');
      var chlorEl  = document.getElementById('kpi-chlor');

      if (tempEl && data.temperature != null) {
        tempEl.textContent = parseFloat(data.temperature).toFixed(1) + ' °C';
      }
      if (solarEl && data.solarPump != null) {
        var sOn = data.solarPump === true || data.solarPump === 'true' || data.solarPump === 1 || data.solarPump === '1';
        solarEl.textContent = sOn ? 'Ein' : 'Aus';
        solarEl.style.color = sOn ? '#0ea5e9' : '#6b7280';
      }
      if (filterEl && data.filterPump != null) {
        var fOn = data.filterPump === true || data.filterPump === 'true' || data.filterPump === 1 || data.filterPump === '1';
        filterEl.textContent = fOn ? 'Ein' : 'Aus';
        filterEl.style.color = fOn ? '#0ea5e9' : '#6b7280';
      }
      if (phEl && data.ph != null) phEl.textContent = parseFloat(data.ph).toFixed(2);
      if (chlorEl && data.chlor != null) chlorEl.textContent = parseFloat(data.chlor).toFixed(2) + ' mg/l';

      if (data.solarMode)  applyModeButtons('solar',  data.solarMode);
      if (data.filterMode) applyModeButtons('filter', data.filterMode);
    }

    function pollStatus() {
      fetch('/pool/status', { headers: { Accept: 'application/json' } })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) { if (d) applyStatus(d); })
        .catch(function() {});
    }

    pollStatus();
    setInterval(pollStatus, 5000);

    // ── Pumpenmodus setzen ───────────────────────────────────────────────────
    function setPumpMode(which, mode) {
      fetch('/pool/pump/' + which + '/' + mode, { method: 'POST' })
        .then(function() { setTimeout(pollStatus, 300); })
        .catch(function() {});
    }
  `;

  return renderLayout({ title: 'Poolsteuerung', activePath: '/pool', body, script });
}

module.exports = renderPool;
