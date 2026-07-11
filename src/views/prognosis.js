'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { BEHAVIOR_MODELS } = require('../prognosis/config');
const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function formatEnergy(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`
    : '— kWh';
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(0)} %` : '— %';
}

function formatForecastTime(decimalHour) {
  const number = Number(decimalHour);
  if (!Number.isFinite(number)) return '—';
  let totalMinutes = Math.round(number * 60);
  totalMinutes = Math.max(0, Math.min(24 * 60 - 1, totalMinutes));
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function statusInfo(status) {
  if (status === 2) return { label: 'Gut versorgt', detail: 'Die Batteriereserve reicht voraussichtlich bis zum nächsten sichtbaren Ladebeginn.', css: 'good' };
  if (status === 1) return { label: 'Knapp kalkuliert', detail: 'Bis zum nächsten sichtbaren Ladebeginn wird die Batteriereserve voraussichtlich niedrig.', css: 'warn' };
  if (status == null) return { label: 'Prognose noch unvollständig', detail: 'Für die Bilanz fehlt derzeit eine PV-Wetterprognose.', css: 'warn' };
  return { label: 'Mindeststand in Sicht', detail: 'Vor dem nächsten sichtbaren Ladebeginn wird der Mindest-SoC voraussichtlich erreicht.', css: 'bad' };
}

function formatShortEnergy(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`
    : '—';
}

// 24-h-Stundenprofil eines Prognosetages: erwarteter Hausverbrauch je Stunde
// (Soll, Tagesziel × Wochentagskurve). Für heute werden bereits gelernte
// Stunden als Ist-Balken in abweichender Farbe gezeigt; die Soll-Marke der
// Stunde bleibt sichtbar, sodass die Abweichung direkt ablesbar ist.
function renderHourProfile(day, model, isToday) {
  const profile = (model.profilesByWeekday && model.profilesByWeekday[day.weekday]) || model.profile || [];
  const target = model.dailyTargetsByWeekday && model.dailyTargetsByWeekday[day.weekday] != null
    ? model.dailyTargetsByWeekday[day.weekday]
    : model.dailyTarget;
  const plan = Array.from({ length: 24 }, (_, hour) => Math.max(0, (Number(target) || 0) * (Number(profile[hour]) || 0)));
  const actualByHour = isToday && Array.isArray(model.todayByHour) ? model.todayByHour : null;
  const currentHour = isToday && model.local && model.local.time ? Number(model.local.time.hours) || 0 : null;
  const max = Math.max(0.1, ...plan, ...(actualByHour || []).map((value) => Number(value) || 0));
  const cells = Array.from({ length: 24 }, (_, hour) => {
    const isLearned = isToday && currentHour != null && hour < currentHour;
    const actual = isLearned ? Math.max(0, Number(actualByHour && actualByHour[hour]) || 0) : null;
    const value = isLearned ? actual : plan[hour];
    const heightPct = Math.min(100, value / max * 100);
    const planPct = Math.min(100, plan[hour] / max * 100);
    const deviation = isLearned && plan[hour] > 0.01
      ? ` (${actual >= plan[hour] ? '+' : ''}${Math.round((actual / plan[hour] - 1) * 100)} %)`
      : '';
    const title = isLearned
      ? `${String(hour).padStart(2, '0')} Uhr · Ist ${formatShortEnergy(actual)} · Soll ${formatShortEnergy(plan[hour])}${deviation}`
      : `${String(hour).padStart(2, '0')} Uhr · Soll ${formatShortEnergy(plan[hour])}`;
    const marker = isLearned ? `<i class="fh-plan" style="bottom:${planPct.toFixed(1)}%"></i>` : '';
    return `<div class="fh-cell" title="${escapeHtml(title)}">${marker}<span class="fh-bar fh-bar--${isLearned ? 'ist' : 'soll'}" style="height:${heightPct.toFixed(1)}%"></span></div>`;
  }).join('');
  const legend = isToday
    ? `<div class="forecast-hours-legend"><span><i class="fh-key fh-key--ist"></i>Ist (gelernt)</span><span><i class="fh-key fh-key--soll"></i>Soll (Profil)</span><span><i class="fh-key fh-key--plan"></i>Soll-Marke</span></div>`
    : '';
  return `<div class="forecast-hours">
        <div class="forecast-hours-chart">${cells}</div>
        <div class="forecast-hours-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
        ${legend}
      </div>`;
}

// Transparenz der Prognose-Datenbasis: je Stunde des heutigen Tages zwei Balken
// nebeneinander — die Selbstzählung (aus der Eigenverbrauch-Leistung integriert)
// und die zähler-/bilanzbasierte Quelle. Eine Marke zeigt, welcher Wert in die
// Prognose eingeflossen ist (nach dem Guard). Die aktuelle Stunde wächst live
// (die Seite lädt minütlich neu).
function renderDataBasisChart(model = {}) {
  const toNum = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const currentHour = model.local && model.local.time
    ? Math.max(0, Math.min(23, Number(model.local.time.hours) || 0))
    : 23;
  const selfSeries = model.todaySelfByHour || [];
  const primarySeries = model.todayPrimaryByHour || [];
  const chosenSeries = model.todayByHour || [];
  const hasAny = selfSeries.some((v) => v != null) || primarySeries.some((v) => v != null);
  if (!hasAny) {
    return `<section class="panel-card">
          <div class="panel-head"><div><h2>Datenbasis der Prognose (heute)</h2><p class="muted">Selbstzählung vs. Bilanz je Stunde. Sammelt ab dem nächsten Messintervall Werte.</p></div></div>
        </section>`;
  }
  // Festes 24-Stunden-Raster: die Platzbreite bleibt über den Tag konstant,
  // die Balken füllen sich fortlaufend. Zukünftige Stunden bleiben leer.
  let max = 0.1;
  for (let h = 0; h < 24; h += 1) {
    max = Math.max(max, toNum(selfSeries[h]) || 0, toNum(primarySeries[h]) || 0, toNum(chosenSeries[h]) || 0);
  }
  const cells = [];
  for (let h = 0; h < 24; h += 1) {
    const selfValue = toNum(selfSeries[h]);
    const primaryValue = toNum(primarySeries[h]);
    const chosenValue = toNum(chosenSeries[h]);
    const isCurrent = h === currentHour;
    const isFuture = h > currentHour;
    const selfPct = selfValue == null ? 0 : Math.min(100, selfValue / max * 100);
    const primaryPct = primaryValue == null ? 0 : Math.min(100, primaryValue / max * 100);
    const replaced = !isCurrent && !isFuture && chosenValue != null && primaryValue != null
      && Math.abs(chosenValue - primaryValue) > 0.001;
    const chosenPct = chosenValue == null ? null : Math.min(100, chosenValue / max * 100);
    const marker = !isCurrent && !isFuture && chosenPct != null
      ? `<i class="db-mark" style="bottom:${chosenPct.toFixed(1)}%"></i>` : '';
    const fmt = (v) => (v == null ? '—' : `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`);
    const title = isFuture
      ? `${String(h).padStart(2, '0')} Uhr · noch offen`
      : `${String(h).padStart(2, '0')} Uhr${isCurrent ? ' (läuft)' : ''} · Selbstzählung ${fmt(selfValue)} · Bilanz/Messung ${fmt(primaryValue)}${replaced ? ` · in Prognose: ${fmt(chosenValue)} (ersetzt)` : ''}`;
    const cls = `db-cell${isCurrent ? ' db-cell--current' : ''}${isFuture ? ' db-cell--future' : ''}${replaced ? ' db-cell--replaced' : ''}`;
    cells.push(`<div class="${cls}" title="${escapeHtml(title)}">
          <span class="db-bar db-bar--self" style="height:${selfPct.toFixed(1)}%"></span>
          <span class="db-bar db-bar--primary" style="height:${primaryPct.toFixed(1)}%"></span>
          ${marker}
        </div>`);
  }
  return `<section class="panel-card">
          <div class="panel-head"><div><h2>Datenbasis der Prognose (heute)</h2><p class="muted">Selbstzählung (Eigenverbrauch-Leistung) vs. zähler-/bilanzbasierte Quelle je Stunde. Die aktuelle Stunde wächst bis zum Stundenende; die Marke zeigt den in die Prognose übernommenen Wert.</p></div></div>
          <div class="db-chart">
            <div class="db-chart-bars">${cells.join('')}</div>
            <div class="db-chart-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
            <div class="db-legend">
              <span><i class="db-key db-key--self"></i>Selbstzählung</span>
              <span><i class="db-key db-key--primary"></i>Bilanz/Messung</span>
              <span><i class="db-key db-key--mark"></i>in Prognose übernommen</span>
            </div>
          </div>
        </section>`;
}

// Leistungskurve der Funktionsgruppe Heizung / Klima über die Außentemperatur-
// Fenster (1-°C-Bereiche, unten „< -20 °C", oben „> 50 °C"). Balkenhöhe =
// mittlere Leistung (W) über die letzten (bis zu 30) Messtage des Fensters; die
// Markierungslinie zeigt den Wert des aktuellen Tages. Die Prognose errechnet aus
// dieser Leistung je Stunde nach der prognostizierten Außentemperatur den
// erwarteten Verbrauch.
function renderHeatingDemandChart(model = {}) {
  const windows = Array.isArray(model.heatingDemand) ? model.heatingDemand : [];
  const totalDays = windows.reduce((sum, w) => sum + (Number(w.days) || 0), 0);
  const head = `<div class="panel-head"><div><h2>Heizung / Klima nach Außentemperatur</h2><p class="muted">Gemessene mittlere Leistung der Funktionsgruppe Heizung / Klima je 1-°C-Fenster der Außentemperatur (Mittel der letzten bis zu 30 Messtage; die Markierungslinie zeigt den heutigen Wert). Die Prognose errechnet daraus je Stunde nach der prognostizierten Außentemperatur den erwarteten Verbrauch.</p></div></div>`;
  // Diagramm zeigen, sobald überhaupt ein Messtag in ein Temperaturfenster
  // eingeflossen ist (auch 0 W ist eine gültige Messung) – oder solange eine
  // Außentemperatur hereinkommt, damit sich die (noch leeren) Fenster füllen
  // können. Der Platzhalter erscheint nur, wenn beides fehlt: keine Temperatur
  // (Topic unbelegt oder Sensor/Server liefert nicht) UND noch keine Messdaten.
  if (!windows.length || (totalDays <= 0 && !model.heatingTemperatureAvailable)) {
    return `<section class="panel-card">
          ${head}
          <p class="muted">Noch keine Leistungskurve: Es kommt aktuell keine Außentemperatur herein (Topic in den Einstellungen prüfen bzw. Sensor/Server) und es liegen noch keine Messdaten vor. Sobald Messtage in die Temperaturfenster einfließen – eine Leistung von 0 W ist dabei eine gültige Messung – erscheint hier die Kurve.</p>
        </section>`;
  }
  const max = Math.max(1, ...windows.map((w) => Math.max(Number(w.avgPowerW) || 0, Number(w.todayPowerW) || 0)));
  const lastIndex = Math.max(1, windows.length - 1);
  const fmt = (value) => `${Math.round(Number(value) || 0).toLocaleString('de-DE')} W`;
  const cells = windows.map((w, index) => {
    const value = Math.max(0, Number(w.avgPowerW) || 0);
    const pct = Math.min(100, value / max * 100);
    const empty = (Number(w.days) || 0) <= 0;
    // Kalt (blau) → warm (rot) über die Fenster, damit die Temperaturachse sofort lesbar ist.
    const hue = Math.round(210 - (index / lastIndex) * 210);
    // Bei feiner 1-°C-Auflösung nur jedes 5. Fenster (Vielfache von 5 °C) sowie die
    // Sammelbereiche beschriften, sonst überlagern sich die Ticks; die Balken selbst
    // bleiben in voller 1-°C-Auflösung.
    const labelled = w.below || w.above || (Number(w.min) % 5 === 0);
    const tick = w.below ? `&lt;${w.max}` : w.above ? `&gt;${w.min}` : (labelled ? String(w.min) : '');
    // Markierungslinie: mittlere Leistung des aktuellen Tages in diesem Fenster.
    const hasToday = w.todayPowerW != null;
    const todayPct = hasToday ? Math.min(100, Math.max(0, (Number(w.todayPowerW) || 0) / max * 100)) : 0;
    const mark = hasToday
      ? `<span class="tb-mark" style="bottom:${todayPct.toFixed(1)}%" title="${escapeHtml(`${w.label} · heute Ø ${fmt(w.todayPowerW)}`)}"></span>`
      : '';
    const title = `${w.label} · Ø ${fmt(value)}${hasToday ? ` · heute ${fmt(w.todayPowerW)}` : ''} · ${empty ? 'keine Messtage' : `${w.days} Messtag${w.days === 1 ? '' : 'e'}`}`;
    return `<div class="tb-cell${empty ? ' tb-cell--empty' : ''}" title="${escapeHtml(title)}">
          <span class="tb-bar" style="height:${pct.toFixed(1)}%;background:hsl(${hue} 68% 50%)"></span>
          ${mark}
          <span class="tb-tick">${tick}</span>
        </div>`;
  }).join('');
  return `<section class="panel-card">
          ${head}
          <div class="tb-chart">
            <div class="tb-chart-bars">${cells}</div>
            <div class="tb-axis muted">Außentemperatur (°C) · Balkenhöhe = mittlere Leistung (W) · Markierung = heutiger Wert</div>
          </div>
        </section>`;
}

function renderDays(days = [], model = {}) {
  if (!days.length) return '<p class="muted">Noch keine PV-Wetterprognose verfügbar. Bitte Standort und PV-Anlagen prüfen.</p>';
  const max = Math.max(1, ...days.flatMap((day) => [day.pvKwh || 0, day.loadKwh || 0]));
  return days.map((day, index) => {
    const pvWidth = Math.max(2, (day.pvKwh || 0) / max * 100);
    const loadWidth = Math.max(2, (day.loadKwh || 0) / max * 100);
    const result = day.gridKwh > 0.05
      ? `<span class="forecast-chip forecast-chip--bad">${formatEnergy(day.gridKwh)} Netz</span>`
      : day.surplusKwh > 0.05
        ? `<span class="forecast-chip forecast-chip--good">${formatEnergy(day.surplusKwh)} Überschuss</span>`
        : '<span class="forecast-chip forecast-chip--neutral">ausgeglichen</span>';
    const wallboxes = (day.wallboxes || [])
      .filter((box) => Number(box.energyKwh) > 0.005)
      .map((box) => `${box.name}: ${formatEnergy(box.energyKwh)}`)
      .join(' · ');
    return `<article class="forecast-day">
      <div class="forecast-day-head"><strong>${escapeHtml(day.label)}</strong>${result}</div>
      <div class="forecast-day-body">
        <div class="forecast-day-bars">
          <div class="forecast-bar-row forecast-bar-row--pv"><span>PV</span><div class="forecast-bar-track"><i class="forecast-bar forecast-bar--pv" style="width:${pvWidth.toFixed(1)}%"></i></div><b>${formatEnergy(day.pvKwh)}</b></div>
          <div class="forecast-bar-row forecast-bar-row--load"><span>Bedarf</span><div class="forecast-bar-track"><i class="forecast-bar forecast-bar--load" style="width:${loadWidth.toFixed(1)}%"></i></div><b>${formatEnergy(day.loadKwh)}</b></div>
        </div>
        ${renderHourProfile(day, model, index === 0)}
      </div>
      ${wallboxes ? `<div class="forecast-day-foot">davon Wallbox: ${escapeHtml(wallboxes)}</div>` : ''}
      <div class="forecast-day-foot forecast-day-foot--battery">Batterie am Tagesende <strong>${formatPercent(day.batterySocEnd)}</strong>${day.batteryFull ? ' · wird voraussichtlich voll' : ''}</div>
    </article>`;
  }).join('');
}

function renderPrognosis({ prognosis, message = '', error = '' } = {}) {
  const config = prognosis.config;
  const model = prognosis.model;
  const simulation = prognosis.simulation;
  const operating = prognosis.operating || {
    autark: true, autarkDaysCount: 0, autarkDaysYear: '', autarkDaysTopic: '',
    autarkDaysPreviousYearCount: 0, autarkDaysPreviousYear: '', autarkDaysPreviousYearTopic: '',
  };
  const today = simulation.today;
  const status = statusInfo(simulation.status);
  const chargeStart = simulation.nextChargeStart;
  const chargeStartHint = chargeStart
    ? `${chargeStart.label} · ca. ${formatForecastTime(chargeStart.hour)} Uhr`
    : 'im sichtbaren Prognosezeitraum nicht erwartet';
  const minimumReached = simulation.minimumReached;
  const minimumHint = minimumReached
    ? `${minimumReached.label} · ca. ${formatForecastTime(minimumReached.hour)} Uhr`
    : 'im sichtbaren Prognosezeitraum nicht erwartet';
  const recentText = model.recentAverage == null ? 'lernt noch' : formatEnergy(model.recentAverage);
  const calibration = Math.round((model.intradayFactor - 1) * 100);
  const calibrationText = calibration === 0 ? 'heute neutral' : `heute ${calibration > 0 ? '+' : ''}${calibration} %`;
  const currentWeekday = model.currentWeekday == null ? null : Number(model.currentWeekday);
  const weekdaySamples = currentWeekday == null || !model.weekdayProfileDays
    ? 0
    : model.weekdayProfileDays[currentWeekday] || 0;
  const formatDayKey = (dayKey) => {
    const [year, month, day] = String(dayKey || '').split('-');
    return day ? `${day}.${month}.${year}` : '—';
  };
  const templateText = weekdaySamples > 0
    ? `${escapeHtml(WEEKDAY_NAMES[currentWeekday])} · ${weekdaySamples} Lerntage`
    : (model.previousDayKey ? `Vortageskurve vom ${escapeHtml(formatDayKey(model.previousDayKey))}` : 'Standardprofil (Kaltstart)');
  const wallboxFacts = ((model.wallboxModel && model.wallboxModel.boxes) || []).map((box) => {
    const expected = box.dailyByWeekday[currentWeekday] || 0;
    const samples = box.samplesByWeekday[currentWeekday] || 0;
    return `<div><dt>Wallbox ${escapeHtml(box.name)} (${escapeHtml(WEEKDAY_NAMES[currentWeekday])})</dt><dd>${formatEnergy(expected)} · ${samples} Lerntage</dd></div>`;
  }).join('');
  const body = `        <div class="forecast-page-head">
          <h1>Prognose</h1>
          <form action="/prognose/behavior" method="POST" class="forecast-behavior-form">
            <div class="forecast-behavior-status">
              <span>${config.behaviorActive ? 'Aktiv' : 'Nicht aktiv'}</span>
              <strong>Level ${escapeHtml(operating.operatingLevel || 2)}</strong>
            </div>
            <select name="behaviorModel" aria-label="Verhaltensmodell">
              ${Object.entries(BEHAVIOR_MODELS).map(([key, label]) => `<option value="${key}"${config.behaviorModel === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
            <button type="submit">Aktivieren</button>
          </form>
        </div>

        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}

        <section class="forecast-hero forecast-hero--${status.css}">
          <span class="forecast-signal" aria-hidden="true"></span>
          <div><div class="forecast-hero-title">${escapeHtml(status.label)}</div><p>${escapeHtml(status.detail)}</p></div>
          <div class="forecast-hero-metrics">
            <div class="forecast-hero-soc forecast-hero-soc--primary"><span>SoC bei nächstem Ladebeginn</span><strong>${formatPercent(chargeStart ? chargeStart.soc : null)}</strong><small>${escapeHtml(chargeStartHint)}</small></div>
            <div class="forecast-hero-soc forecast-hero-soc--minimum"><span>Voraussichtlich leer</span><strong>${minimumReached ? formatPercent(minimumReached.soc) : 'Nein'}</strong><small>${escapeHtml(minimumHint)}</small></div>
            <div class="forecast-hero-soc"><span>SoC Tagesende</span><strong>${formatPercent(today.batterySocEnd)}</strong><small>heute</small></div>
          </div>
        </section>

        <div class="kpi-row forecast-kpis">
          <div class="kpi-card kpi-card--pv"><div class="kpi-label">PV heute noch</div><div class="kpi-value">${formatEnergy(today.pvKwh)}</div></div>
          <div class="kpi-card"><div class="kpi-label">Verbrauch heute noch</div><div class="kpi-value">${formatEnergy(today.loadKwh)}</div></div>
          <div class="kpi-card kpi-card--bat"><div class="kpi-label">Batterie nutzbar</div><div class="kpi-value">${formatEnergy(simulation.initialStored)}</div><div class="kpi-subvalue">bis ${formatPercent(simulation.minSoc)} Mindest-SoC</div></div>
          <div class="kpi-card kpi-card--grid"><div class="kpi-label">Netzbedarf heute</div><div class="kpi-value">${formatEnergy(today.gridKwh)}</div></div>
          <div class="kpi-card forecast-autark-card"><div class="kpi-label">Heute autark</div><div class="kpi-value forecast-value--${operating.autark ? 'good' : 'bad'}">${operating.autark ? 'Ja' : 'Nein'}</div><div class="kpi-subvalue">${escapeHtml(operating.autarkDaysYear || 'aktuelles Jahr')}: ${escapeHtml(operating.autarkDaysCount)} Tage · ${escapeHtml(operating.autarkDaysPreviousYear || 'Vorjahr')}: ${escapeHtml(operating.autarkDaysPreviousYearCount)} Tage</div></div>
        </div>

        <section class="panel-card">
          <div class="panel-head"><div><h2>Energiebilanz</h2><p class="muted">PV-Ertrag, dynamischer Verbrauch und Batterieverlauf für heute plus drei Tage.</p></div></div>
          <div class="forecast-days">${renderDays(simulation.days, model)}</div>
        </section>

        ${renderDataBasisChart(model)}

        ${renderHeatingDemandChart(model)}

        <div class="content-grid content-grid--split forecast-details">
          <section class="info-card">
            <h2>Verbrauchsmodell</h2>
            <dl class="forecast-facts">
              <div><dt>Jahresmittel</dt><dd>${formatEnergy(model.annualAverage)}</dd></div>
              <div><dt>Gleitender Mittelwert</dt><dd>${escapeHtml(recentText)}</dd></div>
              <div><dt>Gelernte volle Tage</dt><dd>${model.historyDays}</dd></div>
              <div><dt>Aktive Verbrauchskurve</dt><dd>${currentWeekday == null ? '—' : templateText}</dd></div>
              <div><dt>Tageskalibrierung</dt><dd>${escapeHtml(calibrationText)}</dd></div>
              <div><dt>Prognose Hausverbrauch</dt><dd>${formatEnergy(model.expectedToday)}</dd></div>
              <div><dt>Funktionslasten heute noch</dt><dd>${formatEnergy(today.functionsKwh)}</dd></div>
              <div><dt>Wallboxbedarf heute noch</dt><dd>${formatEnergy(today.wallboxKwh)}</dd></div>
              ${wallboxFacts}
              <div><dt>Hausverbrauch heute ohne Akku/Wallbox</dt><dd>${formatEnergy(model.today)}</dd></div>
            </dl>
            <p class="muted forecast-note">Das Jahresmittel stabilisiert den Start. Mit jedem vollständigen Tag erhält der gleitende Mittelwert mehr Gewicht; das Stundenprofil lernt, wann im Haus typischerweise Energie gebraucht wird.</p>
          </section>

          <form action="/prognose/config" method="POST" class="settings-card forecast-config">
            <div class="settings-card-head"><h2>Modellparameter</h2><p class="settings-card-hint">Batteriekapazität, Mindest-SoC und Wirkungsgrade werden auf der Batterieseite gepflegt.</p></div>
            <div class="field-grid">
              <div class="field"><label for="historyDays">Lernzeitraum (Tage)</label><input id="historyDays" name="historyDays" type="number" min="7" max="90" step="1" value="${escapeHtml(config.historyDays)}"></div>
              <div class="field"><label for="selfCountGuardPercent">Max. Abweichung Bilanz ↔ Selbstzählung (%)</label><input id="selfCountGuardPercent" name="selfCountGuardPercent" type="number" min="1" max="100" step="1" value="${escapeHtml(config.selfCountGuardPercent)}"><span class="topic-current">Weicht die Bilanz einer abgeschlossenen Stunde stärker ab, übernimmt die Selbstzählung.</span></div>
              <div class="field"><label for="selfCountGuardMinKwh">Mindest-Abweichung (kWh)</label><input id="selfCountGuardMinKwh" name="selfCountGuardMinKwh" type="number" min="0" max="5" step="0.05" value="${escapeHtml(config.selfCountGuardMinKwh)}"><span class="topic-current">Unterhalb dieser absoluten Abweichung greift der Guard nie (Rauschschutz kleiner Stunden).</span></div>
            </div>
            <div class="forecast-topic-section">
              <h3>Autarkie-Zähler per MQTT</h3>
              <p class="settings-card-hint">Optionaler bidirektionaler Abgleich der Jahreszähler.</p>
              <div class="forecast-topic-grid">
                <div class="field"><label for="autarkDaysTopic">Autarke Tage – laufendes Jahr</label><input id="autarkDaysTopic" name="autarkDaysTopic" type="text" placeholder="z.B. 0_userdata.0.homeESS.AutarkeTage" value="${escapeHtml(operating.autarkDaysTopic || '')}"><span class="topic-current">Broker: <strong>${escapeHtml(prognosis.externalAutarkDays == null ? '—' : prognosis.externalAutarkDays)}</strong></span></div>
                <div class="field"><label for="autarkDaysPreviousYearTopic">Autarke Tage – Vorjahr</label><input id="autarkDaysPreviousYearTopic" name="autarkDaysPreviousYearTopic" type="text" placeholder="z.B. 0_userdata.0.homeESS.AutarkeTageVorjahr" value="${escapeHtml(operating.autarkDaysPreviousYearTopic || '')}"><span class="topic-current">Broker: <strong>${escapeHtml(prognosis.externalAutarkDaysPreviousYear == null ? '—' : prognosis.externalAutarkDaysPreviousYear)}</strong></span></div>
              </div>
            </div>
            <input type="hidden" id="adoptMqttStart" name="adoptMqttStart" value="no">
            <input type="hidden" id="adoptMqttPreviousYearStart" name="adoptMqttPreviousYearStart" value="no">
            <div class="button-row"><button type="submit">Einstellungen speichern</button></div>
          </form>
        </div>`;

  const script = `
    var prognosisForm = document.querySelector('form[action="/prognose/config"]');
    var originalAutarkTopic = ${JSON.stringify(operating.autarkDaysTopic || '')};
    var originalAutarkPreviousYearTopic = ${JSON.stringify(operating.autarkDaysPreviousYearTopic || '')};
    function askForMqttStart(label, targetId) {
      var adopt = window.confirm(
        'Soll der bereits im MQTT-Topic vorhandene Wert als Startwert für ' + label + ' übernommen werden?\\n\\n' +
        'OK = MQTT-Wert übernehmen\\nAbbrechen = aktuellen HomeESS-Zähler an MQTT senden'
      );
      document.getElementById(targetId).value = adopt ? 'yes' : 'no';
    }
    if (prognosisForm) prognosisForm.addEventListener('submit', function () {
      var topic = document.getElementById('autarkDaysTopic').value.trim();
      if (topic && topic !== originalAutarkTopic) {
        askForMqttStart('die autarken Tage des laufenden Jahres', 'adoptMqttStart');
      }
      var previousTopic = document.getElementById('autarkDaysPreviousYearTopic').value.trim();
      if (previousTopic && previousTopic !== originalAutarkPreviousYearTopic) {
        askForMqttStart('die autarken Tage des Vorjahres', 'adoptMqttPreviousYearStart');
      }
    });

    // Prognosewerte ändern sich langsamer als Live-Leistungen. Ein Minuten-Takt
    // hält die Seite aktuell, ohne jede MQTT-Nachricht neu durchzurechnen.
    window.setTimeout(function () {
      window.setInterval(function () {
        if (!document.hidden) window.location.reload();
      }, 60000);
    }, 60000 - (Date.now() % 60000));
  `;
  return renderLayout({ title: 'Prognose', activePath: '/prognose', body, script });
}

module.exports = renderPrognosis;
// Für gezielte Tests der Diagramm-Sichtbarkeit (Default-Export bleibt die View).
module.exports.renderHeatingDemandChart = renderHeatingDemandChart;
