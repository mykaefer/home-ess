'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function renderPhotovoltaik({
  plants = [],
  totals = {
    formatted: { current: '— W', today: '— kWh', week: '— kWh', year: '— kWh', previousYear: '— kWh' },
  },
  forecast = null,
  cellTypeOptions = [],
  cellTypeDefaultEfficiency = {},
  converterTypeOptions = [],
  formMessage = '',
  formError = '',
  reconcileMessage = '',
  reconcileError = '',
  dialogMode = '',
  dialogError = '',
  dialogValues = null,
  editingPlantId = null,
} = {}) {
  const body = `        <div class="panel-head">
          <h1>Photovoltaik</h1>
          <button type="button" class="secondary-button" onclick="openReconcileDialog()">Wert abgleichen</button>
        </div>

        <div class="kpi-row">
          <div class="kpi-card kpi-card--pv">
            <div class="kpi-label">Aktuelle Leistung</div>
            <div class="kpi-value" id="kpi-leistung">${escapeHtml(totals.formatted.current)}</div>
          </div>
          <div class="kpi-card kpi-card--pv">
            <div class="kpi-label">Ertrag heute</div>
            <div class="kpi-value" id="kpi-heute">${escapeHtml(totals.formatted.today)}</div>
          </div>
          <div class="kpi-card kpi-card--pv">
            <div class="kpi-label">Ertrag diese Woche</div>
            <div class="kpi-value" id="kpi-woche">${escapeHtml(totals.formatted.week)}</div>
          </div>
          <div class="kpi-card kpi-card--pv">
            <div class="kpi-label">Ertrag Jahr</div>
            <div class="kpi-value" id="kpi-jahr">${escapeHtml(totals.formatted.year)}</div>
            <div class="kpi-subvalue" id="kpi-vorjahr">Vorjahr: ${escapeHtml(totals.formatted.previousYear)}</div>
          </div>
        </div>

        ${renderForecast(forecast)}

        <div class="panel-card">
          <div class="panel-head">
            <div>
              <h2>PV-Anlagen</h2>
              <p class="muted">Leistung und Tagesertrag werden je Anlage ueber MQTT gelesen. Woche und Jahr werden oben als Gesamtwert abgeglichen und automatisch fortgeschrieben.</p>
            </div>
            <button type="button" class="settings-form button-inline" onclick="openPlantDialog('add')">Hinzufuegen</button>
          </div>
          ${statusText(formError)}
          ${statusText(formMessage, 'success')}
          ${statusText(reconcileError)}
          ${statusText(reconcileMessage, 'success')}
          ${plants.length ? renderPlantList(plants) : '<div class="info-card"><p class="muted">Noch keine PV-Anlage angelegt.</p></div>'}
        </div>

        ${renderPlantDialog({ cellTypeOptions, converterTypeOptions, dialogError, dialogValues, dialogMode, editingPlantId })}
        ${renderReconcileDialog()}
        ${renderDeleteDialog(plants)}
        ${renderClearCalibrationDialog()}`;

  const script = `    const pvPlants = ${JSON.stringify(plants.map(serializePlantForClient))};
    const cellTypeDefaultEfficiency = ${JSON.stringify(cellTypeDefaultEfficiency)};
    const initialDialogMode = ${JSON.stringify(dialogMode)};
    const initialEditingPlantId = ${editingPlantId == null ? 'null' : Number(editingPlantId)};
    const initialDialogValues = ${JSON.stringify(dialogValues || {})};

    function openPlantDialog(mode, plantId) {
      var dialog = document.getElementById('plantDialog');
      if (!dialog) return;
      var form = document.getElementById('plantForm');
      var title = document.getElementById('plantDialogTitle');
      var clearBtn = document.getElementById('clearCalibrationBtn');
      var plant = pvPlants.find(function (item) { return item.id === plantId; }) || null;

      if (mode === 'edit' && plant) {
        form.action = '/photovoltaik/plants/' + plant.id;
        title.textContent = 'PV-Anlage bearbeiten';
        setPlantFormValues(plant);
        if (clearBtn) {
          clearBtn.hidden = false;
          clearBtn.onclick = function () { openClearCalibrationDialog(plant.id); };
        }
      } else {
        form.action = '/photovoltaik/plants';
        title.textContent = 'PV-Anlage hinzufuegen';
        setPlantFormValues({
          name: '',
          kwPeak: '',
          efficiency: '',
          orientation: '',
          tilt: '',
          isConsumerSide: false,
          autoCalibrate: false,
          sunCutoffMorning: 10,
          sunCutoffEvening: 10,
          cellType: '',
          converterType: '',
          powerTopic: '',
          todayYieldTopic: '',
          todayYieldUnit: 'kWh'
        });
        if (clearBtn) clearBtn.hidden = true;
      }

      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function updateReconcileFields() {
      var select = document.getElementById('reconcileTarget');
      var option = select.options[select.selectedIndex];
      var isSeed = option && option.getAttribute('data-fields') === 'seed';
      var dateRow = document.getElementById('reconcileDateRow');
      var dateInput = document.getElementById('reconcileDate');
      dateRow.hidden = !isSeed;
      dateInput.required = isSeed;
      document.getElementById('reconcileHintSum').hidden = isSeed;
      document.getElementById('reconcileHintSeed').hidden = !isSeed;
    }

    function openReconcileDialog() {
      var dialog = document.getElementById('reconcileDialog');
      if (!dialog) return;
      updateReconcileFields();
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeReconcileDialog() {
      var dialog = document.getElementById('reconcileDialog');
      if (dialog) dialog.close();
    }

    function setPlantFormValues(values) {
      document.getElementById('plantName').value = values.name || '';
      document.getElementById('plantKwPeak').value = values.kwPeak == null ? '' : values.kwPeak;
      document.getElementById('plantEfficiency').value = values.efficiency == null ? '' : values.efficiency;
      document.getElementById('plantOrientation').value = values.orientation || '';
      document.getElementById('plantTilt').value = values.tilt == null ? '' : values.tilt;
      document.getElementById('plantConsumerSide').checked = Boolean(values.isConsumerSide);
      document.getElementById('plantAutoCalibrate').checked = Boolean(values.autoCalibrate);
      document.getElementById('plantSunCutoffMorning').value = values.sunCutoffMorning == null ? '' : values.sunCutoffMorning;
      document.getElementById('plantSunCutoffEvening').value = values.sunCutoffEvening == null ? '' : values.sunCutoffEvening;
      document.getElementById('plantCellType').value = values.cellType || '';
      document.getElementById('plantConverterType').value = values.converterType || '';
      document.getElementById('plantPowerTopic').value = values.powerTopic || '';
      document.getElementById('plantTodayYieldTopic').value = values.todayYieldTopic || '';
      document.getElementById('plantTodayYieldUnit').value = values.todayYieldUnit || 'kWh';
    }

    function closePlantDialog() {
      var dialog = document.getElementById('plantDialog');
      if (dialog) dialog.close();
    }

    function openDeleteDialog(plantId, plantName) {
      var dialog = document.getElementById('deletePlantDialog');
      if (!dialog) return;
      document.getElementById('deletePlantName').textContent = plantName;
      document.getElementById('deletePlantForm').action = '/photovoltaik/plants/' + plantId + '/delete';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeDeleteDialog() {
      var dialog = document.getElementById('deletePlantDialog');
      if (dialog) dialog.close();
    }

    function openClearCalibrationDialog(plantId) {
      var dialog = document.getElementById('clearCalibrationDialog');
      if (!dialog) return;
      var plant = pvPlants.find(function (p) { return p.id === plantId; });
      var nameEl = document.getElementById('clearCalibrationPlantName');
      if (nameEl) nameEl.textContent = plant ? plant.name : '';
      var form = document.getElementById('clearCalibrationForm');
      if (form) form.action = '/photovoltaik/plants/' + plantId + '/clear-calibration';
      if (typeof dialog.showModal === 'function') dialog.showModal();
    }

    function closeClearCalibrationDialog() {
      var dialog = document.getElementById('clearCalibrationDialog');
      if (dialog) dialog.close();
    }

    function applyPlantSun(node, direct) {
      if (!node) return;
      if (direct === true) {
        node.textContent = '☀️';
        node.title = 'Direkte Sonneneinstrahlung';
        node.className = 'plant-sun plant-sun--direct';
        node.hidden = false;
      } else if (direct === false) {
        node.textContent = '☁️';
        node.title = 'Keine direkte Sonneneinstrahlung (diffus/bewölkt)';
        node.className = 'plant-sun plant-sun--diffuse';
        node.hidden = false;
      } else {
        node.textContent = '';
        node.title = '';
        node.className = 'plant-sun plant-sun--unknown';
        node.hidden = true;
      }
    }

    async function refreshPhotovoltaikMetrics() {
      try {
        var response = await fetch('/photovoltaik/data', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        var data = await response.json();
        document.getElementById('kpi-leistung').textContent = data.totals.current;
        document.getElementById('kpi-heute').textContent = data.totals.today;
        document.getElementById('kpi-woche').textContent = data.totals.week;
        document.getElementById('kpi-jahr').textContent = data.totals.year;
        document.getElementById('kpi-vorjahr').textContent = 'Vorjahr: ' + data.totals.previousYear;
        data.plants.forEach(function (plant) {
          var currentNode = document.getElementById('pv-current-' + plant.id);
          var idealNode = document.getElementById('pv-ideal-' + plant.id);
          if (currentNode) currentNode.textContent = plant.current;
          if (idealNode) idealNode.textContent = plant.ideal;
          var calNode = document.getElementById('pv-calibration-' + plant.id);
          if (calNode) {
            if (plant.autoCalibrate) {
              calNode.textContent = 'Kalibrierung: ' + plant.calibrationFactor;
              calNode.hidden = false;
            } else {
              calNode.hidden = true;
            }
          }
          applyPlantSun(document.getElementById('pv-sun-' + plant.id), plant.directSunlight);
        });
      } catch (_) {
        // Anzeige bleibt auf dem letzten gueltigen Stand.
      }
    }

    // Bei Auswahl eines Zelltyps den zelltypischen Wirkungsgrad als Vorgabewert in
    // das Wirkungsgrad-Feld uebernehmen; manuelle Feinkalibrierung bleibt moeglich.
    var cellTypeSelect = document.getElementById('plantCellType');
    if (cellTypeSelect) {
      cellTypeSelect.addEventListener('change', function () {
        var preset = cellTypeDefaultEfficiency[cellTypeSelect.value];
        if (preset != null) document.getElementById('plantEfficiency').value = preset;
      });
    }

    if (initialDialogMode === 'add') {
      openPlantDialog('add');
      setPlantFormValues(initialDialogValues);
    } else if (initialDialogMode === 'edit' && initialEditingPlantId != null) {
      openPlantDialog('edit', initialEditingPlantId);
      setPlantFormValues(initialDialogValues);
    }

    async function refreshForecast() {
      try {
        var response = await fetch('/photovoltaik/forecast', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        var data = await response.json();
        var row = document.getElementById('pv-forecast-row');
        var hint = document.getElementById('pv-forecast-hint');
        var location = document.getElementById('pv-forecast-location');
        if (!row) return;
        if (!data.available || !data.days || !data.days.length) {
          if (hint) hint.hidden = false;
          if (location) location.textContent = '';
          return;
        }
        if (location) location.textContent = data.location ? ' Wetterdaten für ' + data.location + '.' : '';
        row.textContent = '';
        data.days.forEach(function (day, index) {
          var card = document.createElement('div');
          card.className = 'forecast-card';
          var label = document.createElement('div');
          label.className = 'forecast-label';
          label.textContent = day.label;
          card.appendChild(label);
          var value = document.createElement('div');
          value.className = 'forecast-value';
          if (index === 0) {
            // Heute: Tagesgesamtwert mit „gesamt"-Vorsatz plus Aufteilung.
            var prefix = document.createElement('span');
            prefix.className = 'forecast-prefix';
            prefix.textContent = 'gesamt';
            value.appendChild(prefix);
            value.appendChild(document.createTextNode(' ' + day.total));
            card.appendChild(value);
            var bisher = document.createElement('div');
            bisher.className = 'forecast-subvalue';
            bisher.textContent = 'bis jetzt: ' + (data.todayElapsed || '— kWh');
            var noch = document.createElement('div');
            noch.className = 'forecast-subvalue';
            noch.textContent = 'noch erwartet: ' + (data.todayRemaining || '— kWh');
            card.appendChild(bisher);
            card.appendChild(noch);
          } else {
            value.textContent = day.total;
            card.appendChild(value);
          }
          row.appendChild(card);
        });
        if (hint) hint.hidden = true;
      } catch (_) {
        // Anzeige bleibt auf dem letzten gueltigen Stand.
      }
    }

    refreshPhotovoltaikMetrics();
    window.addEventListener('homeess:mqtt', refreshPhotovoltaikMetrics);
    setInterval(refreshPhotovoltaikMetrics, 60000);

    // Wetterprognose ändert sich langsam → seltener aktualisieren als die Live-Werte.
    refreshForecast();
    setInterval(refreshForecast, 15 * 60 * 1000);`;

  return renderLayout({ title: 'Photovoltaik', activePath: '/photovoltaik', body, script });
}

// Sonnen-Bewertung je Anlage: true = direkte Sonne (☀️), false = diffus/bewölkt (☁️),
// null = keine verlässliche Aussage (z. B. Dämmerung) → ausgeblendet.
function sunIndicatorState(direct) {
  if (direct === true) {
    return { symbol: '☀️', title: 'Direkte Sonneneinstrahlung', modifier: 'direct', hidden: false };
  }
  if (direct === false) {
    return {
      symbol: '☁️',
      title: 'Keine direkte Sonneneinstrahlung (diffus/bewölkt)',
      modifier: 'diffuse',
      hidden: false,
    };
  }
  return { symbol: '', title: '', modifier: 'unknown', hidden: true };
}

function sunIndicatorMarkup(direct, id) {
  const state = sunIndicatorState(direct);
  return `<span class="plant-sun plant-sun--${state.modifier}" id="pv-sun-${id}" title="${escapeHtml(state.title)}"${state.hidden ? ' hidden' : ''}>${state.symbol}</span>`;
}

// Eine Prognosekarte. Für „heute" (today gesetzt) zeigt sie zusätzlich den bis
// jetzt erwarteten und den noch erwarteten Anteil unter dem Tagesgesamtwert.
function forecastCardMarkup(label, total, today) {
  if (today) {
    return `              <div class="forecast-card">
                <div class="forecast-label">${escapeHtml(label)}</div>
                <div class="forecast-value"><span class="forecast-prefix">gesamt</span> ${escapeHtml(total)}</div>
                <div class="forecast-subvalue">bis jetzt: ${escapeHtml(today.elapsed)}</div>
                <div class="forecast-subvalue">noch erwartet: ${escapeHtml(today.remaining)}</div>
              </div>`;
  }
  return `              <div class="forecast-card">
                <div class="forecast-label">${escapeHtml(label)}</div>
                <div class="forecast-value">${escapeHtml(total)}</div>
              </div>`;
}

// Prognosestreifen unter den KPI-Kacheln. Solange keine Daten vorliegen (kein
// Standort, Wetter noch nicht geladen), bleibt nur der Hinweis sichtbar; der
// Streifen füllt sich danach clientseitig über /photovoltaik/forecast.
function renderForecast(forecast) {
  const days = forecast && Array.isArray(forecast.days) ? forecast.days : [];
  const available = days.length > 0;
  const elapsed = forecast && forecast.todayElapsedFormatted ? forecast.todayElapsedFormatted : '— kWh';
  const remaining = forecast && forecast.todayRemainingFormatted ? forecast.todayRemainingFormatted : '— kWh';
  // days[0] ist „heute" → bekommt die Aufteilung bis jetzt / noch erwartet.
  const cards = days
    .map((day, index) => forecastCardMarkup(day.label, day.totalFormatted, index === 0 ? { elapsed, remaining } : null))
    .join('\n');
  const location = forecast && forecast.locationLabel ? forecast.locationLabel : '';
  return `        <div class="panel-card pv-forecast">
          <div class="panel-head">
            <div>
              <h2>PV-Prognose</h2>
              <p class="muted">Erwarteter Tagesertrag aus der Wetterprognose (Open-Meteo) und den Anlagendaten.<span id="pv-forecast-location">${location ? ` Wetterdaten für ${escapeHtml(location)}.` : ''}</span></p>
            </div>
          </div>
          <div class="forecast-row" id="pv-forecast-row">
${cards}
          </div>
          <p class="muted forecast-hint" id="pv-forecast-hint"${available ? ' hidden' : ''}>Prognose wird geladen … (benötigt Standort unter Einstellungen).</p>
        </div>`;
}

function renderPlantList(plants) {
  return `<div class="plant-list">
${plants.map(renderPlantCard).join('\n')}
          </div>`;
}

function renderPlantCard(plant) {
  return `            <div class="plant-card">
              <div class="plant-main">
                <div>
                  <h3>${escapeHtml(plant.name)} ${sunIndicatorMarkup(plant.metrics.raw.directSunlight, plant.id)}</h3>
                  <p class="muted">kWp ${escapeHtml(plant.kwPeak)} · ${escapeHtml(plant.cellType)}${plant.converterType && plant.converterType !== 'Direkt' ? ` · ${escapeHtml(plant.converterType)}` : ''} · Ausrichtung ${escapeHtml(plant.orientation || '—')}° · Neigung ${escapeHtml(plant.tilt)}°${plant.isConsumerSide ? ' · Verbraucherseite' : ''}</p>
                </div>
                <div class="plant-power-stack">
                  <div class="plant-power" id="pv-current-${plant.id}">${escapeHtml(plant.metrics.formatted.current)}</div>
                  <div class="plant-power-ideal">Ideal: <span id="pv-ideal-${plant.id}">${escapeHtml(plant.metrics.formatted.ideal)}</span></div>
                </div>
              </div>
              <div class="plant-meta">
                <span class="plant-yield">Heute: ${escapeHtml(plant.metrics.formatted.today)}</span>
                <span class="plant-calibration" id="pv-calibration-${plant.id}"${plant.autoCalibrate ? '' : ' hidden'}>Kalibrierung: ${escapeHtml(plant.metrics.formatted.calibrationFactor)}</span>
                <div class="plant-actions">
                  <button type="button" class="secondary-button" onclick="openPlantDialog('edit', ${plant.id})">Bearbeiten</button>
                  <button type="button" class="icon-button" aria-label="PV-Anlage loeschen" title="PV-Anlage loeschen" onclick="openDeleteDialog(${plant.id}, ${toJsStringLiteral(plant.name)})">🗑</button>
                </div>
              </div>
            </div>`;
}

function renderPlantDialog({ cellTypeOptions, converterTypeOptions, dialogError, dialogValues, dialogMode, editingPlantId }) {
  const values = dialogValues || {
    name: '',
    kwPeak: '',
    efficiency: '',
    orientation: '',
    tilt: '',
    isConsumerSide: false,
    autoCalibrate: false,
    sunCutoffMorning: 10,
    sunCutoffEvening: 10,
    cellType: '',
    converterType: '',
    powerTopic: '',
    todayYieldTopic: '',
    todayYieldUnit: 'kWh',
  };
  const action =
    dialogMode === 'edit' && editingPlantId != null
      ? `/photovoltaik/plants/${editingPlantId}`
      : '/photovoltaik/plants';

  return `        <dialog id="plantDialog" class="value-dialog">
          <form id="plantForm" action="${escapeHtml(action)}" method="POST" class="dialog-form dialog-form--plant">
            <div class="dialog-hero">
              <div>
                <h3 id="plantDialogTitle">PV-Anlage hinzufuegen</h3>
                <p class="muted">Stammdaten, Einbauparameter und MQTT-Zuordnung in einer kompakten Ansicht.</p>
              </div>
            </div>
            ${statusText(dialogError)}
            <div class="dialog-section">
              <div class="dialog-section-head">
                <h4>Stammdaten</h4>
              </div>
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="plantName">
                  <span>Name</span>
                  <input type="text" id="plantName" name="name" value="${escapeHtml(values.name)}" required>
                </label>
                <label class="field-block" for="plantCellType">
                  <span>Zelltyp</span>
                  <select id="plantCellType" name="cellType" required>
                    <option value="">Bitte waehlen</option>
                    ${cellTypeOptions
                      .map((option) => `<option value="${escapeHtml(option)}"${option === values.cellType ? ' selected' : ''}>${escapeHtml(option)}</option>`)
                      .join('')}
                  </select>
                </label>
                <label class="field-block" for="plantKwPeak">
                  <span>kW-Peak</span>
                  <input type="number" step="0.01" id="plantKwPeak" name="kwPeak" value="${escapeHtml(values.kwPeak)}" required>
                </label>
                <label class="field-block" for="plantEfficiency">
                  <span>Wirkungsgrad (%)</span>
                  <input type="number" step="0.1" id="plantEfficiency" name="efficiency" value="${escapeHtml(values.efficiency)}" required>
                  <small class="muted form-hint">Modul-/System­wirkungsgrad zur Kalibrierung des Idealwerts (bei 20°C). Bei Auswahl des Zelltyps mit einem zelltypischen Vorgabewert vorbelegt – frei feinkalibrierbar. Der Geräte-Wirkungsgrad des Konverters wird separat berücksichtigt.</small>
                </label>
                <label class="field-block" for="plantConverterType">
                  <span>Konverter / Regler</span>
                  <select id="plantConverterType" name="converterType" required>
                    <option value="">Bitte waehlen</option>
                    ${converterTypeOptions
                      .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === values.converterType ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
                      .join('')}
                  </select>
                  <small class="muted form-hint">Geräte-Wirkungsgrad (MPPT-Regler, Wechselrichter, …), temperaturabhängig auf Außentemperaturniveau.</small>
                </label>
              </div>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head">
                <h4>Einbaulage</h4>
              </div>
              <div class="dialog-grid dialog-grid--two">
                <label class="field-block" for="plantOrientation">
                  <span>Ausrichtung (Grad)</span>
                  <input type="number" step="0.1" id="plantOrientation" name="orientation" value="${escapeHtml(values.orientation)}" placeholder="z.B. 180" required>
                  <small class="muted form-hint">Exakter Gradwert fuer spaetere Berechnungen.</small>
                </label>
                <label class="field-block" for="plantTilt">
                  <span>Neigung (Grad)</span>
                  <input type="number" step="0.1" id="plantTilt" name="tilt" value="${escapeHtml(values.tilt)}" required>
                </label>
                <label class="field-block" for="plantSunCutoffMorning">
                  <span>Sonnenreferenz-Cutoff morgens (%)</span>
                  <input type="number" step="1" min="0" max="100" id="plantSunCutoffMorning" name="sunCutoffMorning" value="${escapeHtml(values.sunCutoffMorning)}" required>
                  <small class="muted form-hint">Vor Sonnenhöchststand: Die Anlage zählt nur als Sonnenreferenz, wenn ihr Klarhimmel-Idealwert mindestens diesen Anteil ihrer kWp-Spitzenleistung erreicht – sonst verfälscht sie bei tiefem/seitlichem Sonnenstand das Verhältnis. Standard 10 %.</small>
                </label>
                <label class="field-block" for="plantSunCutoffEvening">
                  <span>Sonnenreferenz-Cutoff abends (%)</span>
                  <input type="number" step="1" min="0" max="100" id="plantSunCutoffEvening" name="sunCutoffEvening" value="${escapeHtml(values.sunCutoffEvening)}" required>
                  <small class="muted form-hint">Nach Sonnenhöchststand. Standard 10 %.</small>
                </label>
              </div>
              <label class="remember-row remember-row--boxed" for="plantConsumerSide">
                <input type="checkbox" id="plantConsumerSide" name="isConsumerSide"${values.isConsumerSide ? ' checked' : ''}>
                <span>Auf Verbraucherseite angeschlossen</span>
              </label>
              <label class="remember-row remember-row--boxed" for="plantAutoCalibrate">
                <input type="checkbox" id="plantAutoCalibrate" name="autoCalibrate"${values.autoCalibrate ? ' checked' : ''}>
                <span>Automatische Kalibrierung (zieht den Idealwert je Tageszeit sanft nach – erkennt z. B. Verschattung)</span>
              </label>
            </div>

            <div class="dialog-section">
              <div class="dialog-section-head">
                <h4>MQTT-Zuordnung</h4>
              </div>
              <div class="dialog-grid">
                <label class="field-block" for="plantPowerTopic">
                  <span>MQTT Topic Leistung</span>
                  <input type="text" id="plantPowerTopic" name="powerTopic" value="${escapeHtml(values.powerTopic)}" placeholder="z.B. pv.0.power">
                </label>
                <label class="field-block" for="plantTodayYieldTopic">
                  <span>MQTT Topic Ertrags-Zähler</span>
                  <input type="text" id="plantTodayYieldTopic" name="todayYieldTopic" value="${escapeHtml(values.todayYieldTopic)}" placeholder="z.B. pv.0.totalYield">
                  <small class="muted">Kumulativer Zählerstand (Rohwert). Es werden nur die Zuwächse als Tagesertrag gezählt.</small>
                </label>
                <label class="field-block" for="plantTodayYieldUnit">
                  <span>Einheit des Ertrags-Zählers</span>
                  <select id="plantTodayYieldUnit" name="todayYieldUnit">
                    <option value="kWh"${values.todayYieldUnit === 'Wh' ? '' : ' selected'}>kWh</option>
                    <option value="Wh"${values.todayYieldUnit === 'Wh' ? ' selected' : ''}>Wh</option>
                  </select>
                </label>
              </div>
            </div>

            <div class="button-row">
              <button type="submit">Speichern</button>
              <button type="button" class="secondary-button" onclick="closePlantDialog()">Abbrechen</button>
              <button type="button" class="button-danger" id="clearCalibrationBtn" style="margin-left:auto" hidden>Kalibrierung loeschen</button>
            </div>
          </form>
        </dialog>`;
}

function renderDeleteDialog() {
  return `        <dialog id="deletePlantDialog" class="value-dialog">
          <form id="deletePlantForm" method="POST" class="dialog-form">
            <h3>PV-Anlage loeschen</h3>
            <p class="muted">Soll die Anlage <strong id="deletePlantName"></strong> wirklich geloescht werden?</p>
            <div class="button-row">
              <button type="submit">Ja, loeschen</button>
              <button type="button" class="secondary-button" onclick="closeDeleteDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderClearCalibrationDialog() {
  return `        <dialog id="clearCalibrationDialog" class="value-dialog">
          <form id="clearCalibrationForm" method="POST" class="dialog-form">
            <h3>Kalibrierung loeschen</h3>
            <p class="muted">Alle gelernten Kalibrierwerte fuer <strong id="clearCalibrationPlantName"></strong> werden geloescht. Die Auto-Kalibrierung startet danach neu bei 1,0.</p>
            <div class="button-row">
              <button type="submit" class="button-danger">Ja, loeschen</button>
              <button type="button" class="secondary-button" onclick="closeClearCalibrationDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function renderReconcileDialog() {
  return `        <dialog id="reconcileDialog" class="value-dialog">
          <form action="/photovoltaik/reconcile" method="POST" class="dialog-form">
            <h3>Wert abgleichen</h3>
            <label for="reconcileTarget">Kennzahl</label>
            <select id="reconcileTarget" name="target" onchange="updateReconcileFields()">
              <option value="week" data-fields="sum">Ertrag Woche (Summe)</option>
              <option value="year" data-fields="sum">Ertrag Jahr (Summe)</option>
              <option value="previousYear" data-fields="sum">Ertrag Vorjahr (Summe)</option>
              <option value="min" data-fields="seed">Minimum dieses Jahr (Wert + Datum)</option>
              <option value="max" data-fields="seed">Maximum dieses Jahr (Wert + Datum)</option>
            </select>
            <p class="muted" id="reconcileHintSum">Wert zum Tagesstart eingeben. Der aktuelle Tagesertrag wird danach automatisch addiert und fortgeschrieben.</p>
            <p class="muted" id="reconcileHintSeed" hidden>Startwert und Datum eines Tages im aktuellen Jahr eingeben. Minimum, Maximum, Durchschnitt und Datum ergeben sich daraus automatisch.</p>
            <label for="reconcileValue">Wert (kWh)</label>
            <input type="number" step="0.01" id="reconcileValue" name="reconcileValue" required>
            <div id="reconcileDateRow" hidden>
              <label for="reconcileDate">Datum</label>
              <input type="date" id="reconcileDate" name="reconcileDate">
            </div>
            <div class="button-row">
              <button type="submit">Uebernehmen</button>
              <button type="button" class="secondary-button" onclick="closeReconcileDialog()">Abbrechen</button>
            </div>
          </form>
        </dialog>`;
}

function serializePlantForClient(plant) {
  return {
    id: plant.id,
    name: plant.name,
    kwPeak: plant.kwPeak,
    efficiency: plant.efficiency,
    orientation: plant.orientation,
    tilt: plant.tilt,
    isConsumerSide: plant.isConsumerSide,
    autoCalibrate: plant.autoCalibrate,
    sunCutoffMorning: plant.sunCutoffMorning,
    sunCutoffEvening: plant.sunCutoffEvening,
    cellType: plant.cellType,
    converterType: plant.converterType,
    powerTopic: plant.powerTopic,
    todayYieldTopic: plant.todayYieldTopic,
    todayYieldUnit: plant.todayYieldUnit || 'kWh',
  };
}

function toJsStringLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

module.exports = renderPhotovoltaik;
