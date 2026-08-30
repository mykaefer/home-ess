'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml } = require('./components');
const { currentAccess, canSeePage } = require('../auth/access');

// Energie-Übersicht: fasst die Eckdaten der Unterseiten Stromverbrauch,
// Photovoltaik und Batterie (und – falls aktiv – Grid-Control) zusammen und
// dient als Einstieg in diese Seiten. Angezeigt wird nur, was der angemeldete
// Benutzer auch aufrufen darf.

function kpiCard(label, value, id, variant = '', subvalue = null, subId = '') {
  const cls = variant ? ` kpi-card--${variant}` : '';
  const sub = subvalue == null
    ? ''
    : `\n            <div class="kpi-subvalue"${subId ? ` id="${subId}"` : ''}>${escapeHtml(subvalue)}</div>`;
  return `          <div class="kpi-card${cls}">
            <div class="kpi-label">${escapeHtml(label)}</div>
            <div class="kpi-value" id="${id}">${escapeHtml(value)}</div>${sub}
          </div>`;
}

// Abschnittskopf mit Sprungmarke auf die zugehörige Detailseite.
function sectionHead(title, path, hint) {
  return `        <div class="energie-section-head">
          <div>
            <h2><a class="energie-section-title" href="${path}">${escapeHtml(title)}</a></h2>
            <p class="muted">${escapeHtml(hint)}</p>
          </div>
          <a class="secondary-button energie-section-link" href="${path}">Zur Seite</a>
        </div>`;
}

function renderPhotovoltaikSection(pv) {
  const totals = pv.formatted;
  return `      <section class="panel-card energie-section">
${sectionHead('Photovoltaik', '/photovoltaik', pv.plantCount
    ? `${pv.plantCount} ${pv.plantCount === 1 ? 'Anlage' : 'Anlagen'} – Leistung und Ertrag.`
    : 'Noch keine PV-Anlage angelegt.')}
        <div class="kpi-row">
${kpiCard('Aktuelle Leistung', totals.current, 'en-pv-current', 'pv')}
${kpiCard('Ertrag heute', totals.today, 'en-pv-today', 'pv')}
${kpiCard('Ertrag diese Woche', totals.week, 'en-pv-week', 'pv')}
${kpiCard('Ertrag dieses Jahr', totals.year, 'en-pv-year', 'pv', `Vorjahr: ${totals.previousYear}`, 'en-pv-previous-year')}
        </div>
      </section>`;
}

function stromRow(label, key, values) {
  return `          <div class="energy-overview-row energy-overview-row--${key}">
            <strong>${escapeHtml(label)}</strong>
            <span id="en-${key}-current">${escapeHtml(values.current)}</span>
            <span id="en-${key}-today">${escapeHtml(values.today)}</span>
            <span id="en-${key}-week">${escapeHtml(values.week)}</span>
            <span id="en-${key}-year">${escapeHtml(values.year)}</span>
          </div>`;
}

function renderStromSection(strom) {
  const f = strom.formatted;
  return `      <section class="panel-card energie-section">
${sectionHead('Stromverbrauch', '/stromverbrauch', 'Eigenverbrauch und Netzbezug im Zeitverlauf.')}
        <div class="energy-overview energie-overview--flat">
          <div class="energy-overview-head">
            <span>Bereich</span>
            <span>Aktuell</span>
            <span>Heute</span>
            <span>Diese Woche</span>
            <span>Dieses Jahr</span>
          </div>
${stromRow('Eigenverbrauch', 'eigenverbrauch', {
    current: f.eigenverbrauchPower,
    today: f.today.eigenverbrauch,
    week: f.week.eigenverbrauch,
    year: f.year.eigenverbrauch,
  })}
${stromRow('Netzbezug', 'netzbezug', {
    current: f.netzbezugPower,
    today: f.today.netzbezug,
    week: f.week.netzbezug,
    year: f.year.netzbezug,
  })}
        </div>
      </section>`;
}

function renderBatterieSection(batterie) {
  const f = batterie.formatted;
  const socPct = batterie.socPercent == null ? 0 : batterie.socPercent;
  const cards = `        <div class="kpi-row">
${kpiCard('Ladezustand (SoC)', f.soc, 'en-bat-soc', 'bat', `Mindestens: ${f.minSoc}`, 'en-bat-min-soc')}
${kpiCard('Leistung', f.power, 'en-bat-power', 'bat')}
${kpiCard('Nutzbare Energie', f.usable, 'en-bat-usable', 'bat', `Kapazität: ${f.capacity}`, 'en-bat-capacity')}
${kpiCard('Spannung', f.voltage, 'en-bat-voltage', 'bat', `Temperatur: ${f.temperatur}`, 'en-bat-temperatur')}
        </div>
        <div class="soc-bar-wrap">
          <div class="soc-bar-track">
            <div class="soc-bar-fill" id="en-bat-soc-bar" style="width:${socPct.toFixed(1)}%"></div>
          </div>
        </div>`;
  return `      <section class="panel-card energie-section">
${sectionHead('Batterie', '/batterie', 'Ladezustand, Leistung und Reserve des Speichers.')}
${batterie.configured ? cards : '        <div class="info-card"><p class="muted">Noch keine MQTT-Topics konfiguriert.</p></div>'}
      </section>`;
}

// Prognose: Ampel als Chip in der Kopfzeile, darunter die Restwerte des Tages.
function renderPrognoseSection(prognose) {
  const chip = prognose.available
    ? `<span class="forecast-chip forecast-chip--${prognose.status.css}" id="en-prog-status">${escapeHtml(prognose.status.label)}</span>`
    : '';
  const head = `        <div class="energie-section-head">
          <div>
            <h2><a class="energie-section-title" href="/prognose">Prognose</a>${chip}</h2>
            <p class="muted" id="en-prog-detail">${escapeHtml(prognose.available ? prognose.status.detail : 'Noch keine vollständige Prognose verfügbar.')}</p>
          </div>
          <a class="secondary-button energie-section-link" href="/prognose">Zur Seite</a>
        </div>`;
  if (!prognose.available) {
    return `      <section class="panel-card energie-section">
${head}
      </section>`;
  }
  const f = prognose.formatted;
  const autark = prognose.autark == null ? '—' : (prognose.autark ? 'Ja' : 'Nein');
  return `      <section class="panel-card energie-section">
${head}
        <div class="kpi-row">
${kpiCard('PV heute noch', f.pvRest, 'en-prog-pv', 'pv')}
${kpiCard('Verbrauch heute noch', f.loadRest, 'en-prog-load', 'self')}
${kpiCard('Netzbedarf heute', f.gridRest, 'en-prog-grid', 'grid')}
${kpiCard('SoC Tagesende', f.socEnd, 'en-prog-soc-end', 'bat', `Heute autark: ${autark}`, 'en-prog-autark')}
        </div>
      </section>`;
}

function stateCard(label, value, id) {
  return `          <div class="kpi-card kpi-card--grid">
            <div class="kpi-label">${escapeHtml(label)}</div>
            <div class="kpi-value grid-state" id="${id}">${value ? 'Ein' : 'Aus'}</div>
          </div>`;
}

function renderGridControlSection(state) {
  return `      <section class="panel-card energie-section">
${sectionHead('Grid-Control', '/grid-control', 'Schaltzustände der Netz- und Einspeisesteuerung.')}
        <div class="kpi-row">
${stateCard('Grid by SoC', state.gridBySoc, 'en-gc-soc')}
${stateCard('Grid by Voltage', state.gridByVoltage, 'en-gc-voltage')}
${stateCard('Warnung', state.gridByTemperature, 'en-gc-temperature')}
${stateCard('Grid by Load', state.gridByLoad, 'en-gc-load')}
${stateCard('Grid actual', state.gridActual, 'en-gc-actual')}
        </div>
      </section>`;
}

function renderEnergie({ overview } = {}) {
  const access = currentAccess();
  const sections = [];
  if (canSeePage(access, 'photovoltaik')) sections.push(renderPhotovoltaikSection(overview.photovoltaik));
  if (canSeePage(access, 'stromverbrauch')) sections.push(renderStromSection(overview.strom));
  if (canSeePage(access, 'batterie')) sections.push(renderBatterieSection(overview.batterie));
  if (overview.gridControl.enabled && overview.gridControl.state && canSeePage(access, 'grid-control')) {
    sections.push(renderGridControlSection(overview.gridControl.state));
  }
  // Der Ausblick steht hinter dem Ist-Zustand — wie im Menü.
  if (canSeePage(access, 'prognose')) sections.push(renderPrognoseSection(overview.prognose));

  const body = `        <div class="panel-head">
          <h1>Energie</h1>
        </div>
        <p class="muted energie-intro">Die wichtigsten Zahlen der Energieseiten auf einen Blick. Jeder Abschnitt führt zur ausführlichen Seite mit Konfiguration und Verlauf.</p>

      <div class="energie-sections">
${sections.length ? sections.join('\n') : '        <div class="info-card"><p class="muted">Keine Energieseite freigeschaltet.</p></div>'}
      </div>`;

  const script = `    function setText(id, value) {
      var node = document.getElementById(id);
      if (node && value != null) node.textContent = value;
    }

    function applyEnergieData(data) {
      var pv = data.photovoltaik ? data.photovoltaik.formatted : null;
      if (pv) {
        setText('en-pv-current', pv.current);
        setText('en-pv-today', pv.today);
        setText('en-pv-week', pv.week);
        setText('en-pv-year', pv.year);
        setText('en-pv-previous-year', 'Vorjahr: ' + pv.previousYear);
      }
      var strom = data.strom ? data.strom.formatted : null;
      if (strom) {
        setText('en-eigenverbrauch-current', strom.eigenverbrauchPower);
        setText('en-eigenverbrauch-today', strom.today.eigenverbrauch);
        setText('en-eigenverbrauch-week', strom.week.eigenverbrauch);
        setText('en-eigenverbrauch-year', strom.year.eigenverbrauch);
        setText('en-netzbezug-current', strom.netzbezugPower);
        setText('en-netzbezug-today', strom.today.netzbezug);
        setText('en-netzbezug-week', strom.week.netzbezug);
        setText('en-netzbezug-year', strom.year.netzbezug);
      }
      var bat = data.batterie;
      if (bat) {
        setText('en-bat-soc', bat.formatted.soc);
        setText('en-bat-min-soc', 'Mindestens: ' + bat.formatted.minSoc);
        setText('en-bat-power', bat.formatted.power);
        setText('en-bat-usable', bat.formatted.usable);
        setText('en-bat-capacity', 'Kapazität: ' + bat.formatted.capacity);
        setText('en-bat-voltage', bat.formatted.voltage);
        setText('en-bat-temperatur', 'Temperatur: ' + bat.formatted.temperatur);
        var bar = document.getElementById('en-bat-soc-bar');
        if (bar) bar.style.width = (bat.socPercent == null ? 0 : bat.socPercent).toFixed(1) + '%';
      }
      var prog = data.prognose;
      if (prog && prog.available) {
        setText('en-prog-status', prog.status.label);
        setText('en-prog-detail', prog.status.detail);
        var chip = document.getElementById('en-prog-status');
        if (chip) chip.className = 'forecast-chip forecast-chip--' + prog.status.css;
        setText('en-prog-pv', prog.formatted.pvRest);
        setText('en-prog-load', prog.formatted.loadRest);
        setText('en-prog-grid', prog.formatted.gridRest);
        setText('en-prog-soc-end', prog.formatted.socEnd);
        setText('en-prog-autark', 'Heute autark: ' + (prog.autark == null ? '—' : (prog.autark ? 'Ja' : 'Nein')));
      }
      var gc = data.gridControl && data.gridControl.state;
      if (gc) {
        setText('en-gc-soc', gc.gridBySoc ? 'Ein' : 'Aus');
        setText('en-gc-voltage', gc.gridByVoltage ? 'Ein' : 'Aus');
        setText('en-gc-temperature', gc.gridByTemperature ? 'Ein' : 'Aus');
        setText('en-gc-load', gc.gridByLoad ? 'Ein' : 'Aus');
        setText('en-gc-actual', gc.gridActual ? 'Ein' : 'Aus');
      }
    }

    async function refreshEnergie() {
      try {
        var response = await fetch('/energie/data', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        applyEnergieData(await response.json());
      } catch (_) {
        // Anzeige bleibt auf dem letzten gueltigen Stand.
      }
    }

    window.addEventListener('homeess:mqtt', refreshEnergie);
    setInterval(refreshEnergie, 60000);`;

  return renderLayout({
    title: 'Energie',
    activePath: '/energie',
    body,
    script,
  });
}

module.exports = renderEnergie;
