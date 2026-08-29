'use strict';

// Seite „Wetterprognose": die drei kommenden Tage ausführlich mit allen
// Messgrößen und Stundenverlauf, die weiteren Tage darunter als Kurzübersicht.
//
// Die Messgrößen eines Tages stehen nicht als eine lange Kachelreihe, sondern in
// thematischen Blöcken (Temperatur · Niederschlag · Wind · Sonne und Licht ·
// Luft). Jede Größe trägt ein Piktogramm. Datenquelle ist
// `src/wetter/forecast.js` (Open-Meteo); der erwartete PV-Ertrag stammt aus der
// bestehenden PV-Prognose (`src/photovoltaik/forecast.js`).

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const { windDirectionArrow, beaufort, uvLevel } = require('../wetter/codes');
const { renderWeatherChart } = require('../wetter/chart');
const { formatFetchedAt } = require('../wetter/forecast');

// Piktogramme der einzelnen Messgrößen. Sie stehen bewusst nicht im
// Datenmodell: sie sind reine Darstellung.
const ICONS = {
  temperatur: '🌡️',
  gefuehlt: '🤗',
  max: '🔺',
  min: '🔻',
  luftfeuchte: '💧',
  taupunkt: '💦',
  luftdruck: '🧭',
  bewoelkung: '☁️',
  niederschlag: '🌧️',
  regen: '💧',
  schnee: '❄️',
  wahrscheinlichkeit: '🎲',
  stunden: '⏱️',
  wind: '💨',
  boeen: '🌬️',
  richtung: '🧭',
  uv: '🕶️',
  sicht: '👁️',
  sonnenaufgang: '🌅',
  sonnenuntergang: '🌇',
  tageslicht: '🌓',
  sonnenschein: '🌞',
  strahlung: '🔆',
  pv: '⚡',
  zeit: '🕒',
};

// Piktogramme der Blockköpfe.
const GROUP_ICONS = {
  temperatur: '🌡️',
  niederschlag: '🌧️',
  wind: '💨',
  sonne: '🌞',
  luft: '🧭',
};

function formatNumber(raw, digits, unit) {
  const number = Number(raw);
  if (raw == null || !Number.isFinite(number)) return unit ? `— ${unit}` : '—';
  const formatted = number.toLocaleString('de-DE', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatText(raw) {
  return raw == null || raw === '' ? '—' : String(raw);
}

// Eine Messgröße: Piktogramm, Bezeichnung, Wert. `hint` trägt eine kurze
// Einordnung (z. B. Windstärke, UV-Stufe).
//
// Dieselbe Auszeichnung trägt beide Darstellungen: am Schreibtisch eine
// schmucklose Zeile (Bezeichnung links, Wert rechts) innerhalb einer
// Gruppenspalte, am Telefon die gewohnte Kachel. Den Unterschied macht
// ausschließlich das Stylesheet — `wetter-metric-figure` fasst dafür Wert und
// Einordnung zu einer rechtsbündigen Einheit zusammen.
function metric(icon, label, displayValue, hint = '', css = '') {
  const cls = css ? ` wetter-metric--${css}` : '';
  return `                <div class="wetter-metric${cls}">
                  <span class="wetter-metric-icon" aria-hidden="true">${icon}</span>
                  <span class="wetter-metric-body">
                    <span class="wetter-metric-label">${escapeHtml(label)}</span>
                    <span class="wetter-metric-figure">
                      <span class="wetter-metric-value">${escapeHtml(displayValue)}</span>
                      ${hint ? `<span class="wetter-metric-hint">${escapeHtml(hint)}</span>` : ''}
                    </span>
                  </span>
                </div>`;
}

// Ein thematischer Block. Am Schreibtisch wird daraus eine Spalte, am Telefon
// ein Abschnitt mit Kachelraster. Leere Blöcke entfallen.
function metricGroup(icon, title, tiles) {
  const usable = tiles.filter(Boolean);
  if (!usable.length) return '';
  return `            <section class="wetter-group">
              <h3 class="wetter-group-head"><span aria-hidden="true">${icon}</span>${escapeHtml(title)}</h3>
              <div class="wetter-metrics">
${usable.join('\n')}
              </div>
            </section>`;
}

function windHint(kmh) {
  const stufe = beaufort(kmh);
  return stufe == null ? '' : `Windstärke ${stufe} Bft`;
}

function windText(degrees, directionText) {
  if (degrees == null && !directionText) return '—';
  const arrow = windDirectionArrow(degrees);
  return `${arrow ? `${arrow} ` : ''}${directionText || formatNumber(degrees, 0, '°')}`;
}

// Aktuelle Lage: großes Symbol mit Temperatur, daneben die Einzelgrößen.
function renderCurrent(current, location) {
  if (!current) return '';
  const uv = uvLevel(current.uvIndex);
  const ort = location && location.latitude != null
    ? `${formatNumber(location.latitude, 3, '°')} / ${formatNumber(location.longitude, 3, '°')}`
    : '';
  return `        <section class="wetter-now panel-card">
          <div class="wetter-now-main">
            <span class="wetter-now-icon" aria-hidden="true">${current.icon}</span>
            <div class="wetter-now-head">
              <div class="wetter-now-temp">${escapeHtml(formatNumber(current.temperature, 1, '°C'))}</div>
              <div class="wetter-now-label">${escapeHtml(formatText(current.label))}</div>
              <div class="wetter-now-sub">Gefühlt ${escapeHtml(formatNumber(current.apparentTemperature, 1, '°C'))}${ort ? ` · ${escapeHtml(ort)}` : ''}</div>
            </div>
          </div>
          <div class="wetter-groups">
${[
    metricGroup(GROUP_ICONS.sonne, 'Sonne', [
      metric(ICONS.strahlung, 'Intensität', formatNumber(current.radiation, 0, 'W/m²')),
      metric(ICONS.uv, 'UV-Index', formatNumber(current.uvIndex, 1, ''), uv.label, uv.css),
      metric(ICONS.bewoelkung, 'Bewölkung', formatNumber(current.cloudCover, 0, '%')),
      metric(ICONS.sicht, 'Sichtweite', formatNumber(current.visibility == null ? null : current.visibility / 1000, 1, 'km')),
    ]),
    metricGroup(GROUP_ICONS.wind, 'Wind', [
      metric(ICONS.wind, 'Aktuell', formatNumber(current.windSpeed, 0, 'km/h'), windHint(current.windSpeed)),
      metric(ICONS.boeen, 'Böen', formatNumber(current.windGusts, 0, 'km/h')),
      metric(ICONS.richtung, 'Richtung', windText(current.windDirection, current.windDirectionText)),
    ]),
    metricGroup(GROUP_ICONS.luft, 'Luft und Niederschlag', [
      metric(ICONS.niederschlag, 'Niederschlag', formatNumber(current.precipitation, 1, 'mm')),
      metric(ICONS.luftfeuchte, 'Luftfeuchte', formatNumber(current.humidity, 0, '%')),
      metric(ICONS.taupunkt, 'Taupunkt', formatNumber(current.dewPoint, 1, '°C')),
      metric(ICONS.luftdruck, 'Luftdruck', formatNumber(current.pressure, 0, 'hPa')),
    ]),
  ].filter(Boolean).join('\n')}
          </div>
        </section>`;
}

// Verlauf über den gesamten Prognosezeitraum. Steht bewusst zwischen der
// aktuellen Lage und dem ersten Tag: er ordnet die Einzeltage darunter ein.
//
// Beide Bauformen werden ausgeliefert; das Stylesheet zeigt je nach Breite nur
// eine davon. Das kostet etwas Markup, spart aber jede Skalierungsakrobatik im
// Browser — und am Telefon muss nichts seitlich gescrollt werden.
function renderChartSection(forecast) {
  return `        <section class="wetter-trend panel-card">
          <div class="panel-head">
            <h2>Verlauf über alle Tage</h2>
            <p class="wetter-short-hint">Temperatur und Sonnenintensität als Linien, Niederschlag je Stunde als Balken.</p>
          </div>
${renderWeatherChart(forecast.days, forecast.current, { variant: 'wide' })}
${renderWeatherChart(forecast.days, forecast.current, { variant: 'compact' })}
        </section>`;
}

// Stundenverlauf eines Tages. Der Balken zeigt die Niederschlags-
// wahrscheinlichkeit, die Zahl darunter die Menge, sofern welche erwartet wird.
//
// Er steht **neben** dem Spaltenbehälter `wetter-groups`, nicht darin: er ist
// keine Wertespalte, sondern eine durchgehende Zeile unter den Spalten. Als
// eigenes Geschwisterelement gilt das in jeder Breite, ohne ihn im Raster über
// alle Spalten ziehen zu müssen.
function renderHours(hours) {
  if (!hours || !hours.length) return '';
  const columns = hours.map((hour) => {
    const probability = hour.precipitationProbability == null ? 0 : hour.precipitationProbability;
    const height = Math.max(2, Math.min(100, probability));
    const amount = hour.precipitation != null && hour.precipitation > 0
      ? formatNumber(hour.precipitation, 1, 'mm')
      : '';
    return `                <div class="wetter-hour${hour.isDay ? '' : ' wetter-hour--night'}">
                  <span class="wetter-hour-clock">${escapeHtml(hour.clock)}</span>
                  <span class="wetter-hour-icon" aria-hidden="true" title="${escapeHtml(hour.label)}">${hour.icon}</span>
                  <span class="wetter-hour-temp">${escapeHtml(formatNumber(hour.temperature, 0, '°'))}</span>
                  <span class="wetter-hour-bar" title="Niederschlagswahrscheinlichkeit ${escapeHtml(formatNumber(probability, 0, '%'))}">
                    <span class="wetter-hour-bar-fill" style="height:${height.toFixed(0)}%"></span>
                  </span>
                  <span class="wetter-hour-prob">${escapeHtml(formatNumber(probability, 0, '%'))}</span>
                  <span class="wetter-hour-rain">${escapeHtml(amount)}</span>
                  <span class="wetter-hour-wind">${escapeHtml(formatNumber(hour.windSpeed, 0, ''))}</span>
                </div>`;
  }).join('\n');

  return `            <section class="wetter-group wetter-group--wide">
              <h3 class="wetter-group-head"><span aria-hidden="true">${ICONS.zeit}</span>Stundenverlauf</h3>
              <div class="wetter-hours-legend">
                <span>${ICONS.zeit} Uhrzeit</span>
                <span>${ICONS.temperatur} Temperatur</span>
                <span>${ICONS.wahrscheinlichkeit} Niederschlagswahrscheinlichkeit</span>
                <span>${ICONS.regen} Menge</span>
                <span>${ICONS.wind} Wind in km/h</span>
                <span class="wetter-hours-note">Am Telefon in 3-Stunden-Schritten</span>
              </div>
              <div class="wetter-hours">
${columns}
              </div>
            </section>`;
}

// Ausführliche Tageskachel: Kopfzeile mit erwartetem PV-Ertrag, die Messgrößen
// in thematischen Blöcken, darunter der Stundenverlauf.
function renderDetailDay(day, pvYield) {
  const uv = uvLevel(day.uvIndexMax);
  return `        <section class="wetter-day panel-card">
          <div class="wetter-day-head">
            <span class="wetter-day-icon" aria-hidden="true">${day.icon}</span>
            <div class="wetter-day-title">
              <h2>${escapeHtml(day.name)}</h2>
              <p class="wetter-day-date">${escapeHtml(day.weekday)}, ${escapeHtml(day.date)}</p>
              <p class="wetter-day-label">${escapeHtml(formatText(day.label))}</p>
            </div>
            <div class="wetter-day-figures">
              <div class="wetter-day-temps">
                <span class="wetter-day-max">${ICONS.max} ${escapeHtml(formatNumber(day.temperatureMax, 1, '°C'))}</span>
                <span class="wetter-day-min">${ICONS.min} ${escapeHtml(formatNumber(day.temperatureMin, 1, '°C'))}</span>
              </div>
              ${renderPvBadge(pvYield)}
            </div>
          </div>
          <div class="wetter-groups">
${[
    metricGroup(GROUP_ICONS.temperatur, 'Temperatur', [
      metric(ICONS.max, 'Höchstwert', formatNumber(day.temperatureMax, 1, '°C')),
      metric(ICONS.min, 'Tiefstwert', formatNumber(day.temperatureMin, 1, '°C')),
      metric(ICONS.gefuehlt, 'Gefühlt max.', formatNumber(day.apparentMax, 1, '°C')),
      metric(ICONS.gefuehlt, 'Gefühlt min.', formatNumber(day.apparentMin, 1, '°C')),
    ]),
    metricGroup(GROUP_ICONS.niederschlag, 'Niederschlag', [
      metric(ICONS.wahrscheinlichkeit, 'Wahrscheinlichkeit', formatNumber(day.precipitationProbability, 0, '%')),
      metric(ICONS.niederschlag, 'Menge gesamt', formatNumber(day.precipitationSum, 1, 'mm')),
      metric(ICONS.regen, 'davon Regen', formatNumber(day.rainSum, 1, 'mm')),
      metric(ICONS.schnee, 'davon Schnee', formatNumber(day.snowfallSum, 1, 'cm')),
      metric(ICONS.stunden, 'Dauer', formatNumber(day.precipitationHours, 0, 'h')),
    ]),
    metricGroup(GROUP_ICONS.wind, 'Wind', [
      metric(ICONS.wind, 'Maximal', formatNumber(day.windSpeedMax, 0, 'km/h'), windHint(day.windSpeedMax)),
      metric(ICONS.boeen, 'Böen', formatNumber(day.windGustsMax, 0, 'km/h')),
      metric(ICONS.richtung, 'Richtung', windText(day.windDirection, day.windDirectionText)),
    ]),
    metricGroup(GROUP_ICONS.sonne, 'Sonne und Licht', [
      pvYield ? metric(ICONS.pv, 'PV-Ertrag', pvYield.display) : '',
      metric(ICONS.strahlung, 'Intensität Spitze', formatNumber(day.radiationMax, 0, 'W/m²')),
      metric(ICONS.strahlung, 'Einstrahlung', formatNumber(day.radiationSum, 2, 'kWh/m²')),
      metric(ICONS.uv, 'UV-Index max.', formatNumber(day.uvIndexMax, 1, ''), uv.label, uv.css),
      metric(ICONS.sonnenschein, 'Sonnenschein', formatNumber(day.sunshineHours, 1, 'h')),
      metric(ICONS.tageslicht, 'Tageslicht', formatNumber(day.daylightHours, 1, 'h')),
      metric(ICONS.sonnenaufgang, 'Sonnenaufgang', formatText(day.sunrise)),
      metric(ICONS.sonnenuntergang, 'Sonnenuntergang', formatText(day.sunset)),
    ]),
    metricGroup(GROUP_ICONS.luft, 'Luft (Tagesmittel)', [
      metric(ICONS.bewoelkung, 'Bewölkung', formatNumber(day.cloudCoverAvg, 0, '%')),
      metric(ICONS.luftfeuchte, 'Luftfeuchte', formatNumber(day.humidityAvg, 0, '%')),
      metric(ICONS.luftdruck, 'Luftdruck', formatNumber(day.pressureAvg, 0, 'hPa')),
    ]),
  ].filter(Boolean).join('\n')}
          </div>
${renderHours(day.hours)}
        </section>`;
}

// Erwarteter PV-Ertrag als Plakette in der Kopfzeile. Ohne Anlagen oder ohne
// Prognose entfällt sie — eine leere Angabe wäre irreführend.
function renderPvBadge(pvYield) {
  if (!pvYield) return '';
  return `<div class="wetter-day-pv" title="Erwarteter Ertrag laut PV-Prognose">
                <span aria-hidden="true">${ICONS.pv}</span>
                <span class="wetter-day-pv-value">${escapeHtml(pvYield.display)}</span>
                <span class="wetter-day-pv-label">PV-Ertrag erwartet</span>
              </div>`;
}

// Kurzübersicht der weiteren Tage: eine Zeile je Tag mit dem Wichtigsten.
function renderFurtherDays(days, pvByDateKey) {
  if (!days.length) return '';
  const rows = days.map((day) => {
    const pvYield = pvByDateKey.get(day.dateKey) || null;
    return `              <div class="wetter-short-row">
                <span class="wetter-short-day">
                  <strong>${escapeHtml(day.weekday)}</strong>
                  <span class="wetter-short-date">${escapeHtml(day.date)}</span>
                </span>
                <span class="wetter-short-icon" aria-hidden="true" title="${escapeHtml(day.label)}">${day.icon}</span>
                <span class="wetter-short-label">${escapeHtml(formatText(day.label))}</span>
                <span class="wetter-short-temp">
                  <span class="wetter-day-max">${ICONS.max} ${escapeHtml(formatNumber(day.temperatureMax, 0, '°C'))}</span>
                  <span class="wetter-day-min">${ICONS.min} ${escapeHtml(formatNumber(day.temperatureMin, 0, '°C'))}</span>
                </span>
                <span class="wetter-short-cell" title="Niederschlagswahrscheinlichkeit">${ICONS.wahrscheinlichkeit} ${escapeHtml(formatNumber(day.precipitationProbability, 0, '%'))}</span>
                <span class="wetter-short-cell" title="Niederschlagsmenge">${ICONS.niederschlag} ${escapeHtml(formatNumber(day.precipitationSum, 1, 'mm'))}</span>
                <span class="wetter-short-cell" title="Wind maximal">${ICONS.wind} ${escapeHtml(formatNumber(day.windSpeedMax, 0, 'km/h'))}</span>
                <span class="wetter-short-cell" title="UV-Index maximal">${ICONS.uv} ${escapeHtml(formatNumber(day.uvIndexMax, 1, ''))}</span>
                ${pvYield ? `<span class="wetter-short-cell wetter-short-cell--pv" title="Erwarteter PV-Ertrag">${ICONS.pv} ${escapeHtml(pvYield.display)}</span>` : ''}
              </div>`;
  }).join('\n');

  return `        <section class="wetter-short panel-card">
          <div class="panel-head">
            <h2>Weitere Tage</h2>
            <p class="wetter-short-hint">Kurzübersicht der Tage nach dem Detailzeitraum.</p>
          </div>
          <div class="wetter-short-list">
${rows}
          </div>
        </section>`;
}

// `pvForecast` ist die bestehende PV-Prognose (`computePvForecast`). Genutzt
// werden daraus Tagesschlüssel und Tagesertrag; fehlt sie, entfallen die
// PV-Angaben ersatzlos.
function buildPvIndex(pvForecast) {
  const index = new Map();
  const days = pvForecast && Array.isArray(pvForecast.days) ? pvForecast.days : [];
  for (const day of days) {
    if (!day || !day.dateKey || day.totalKwh == null) continue;
    index.set(day.dateKey, {
      totalKwh: day.totalKwh,
      display: day.totalFormatted || formatNumber(day.totalKwh, 2, 'kWh'),
    });
  }
  return index;
}

function renderWetter({ forecast = null, pvForecast = null, message = '', error = '' } = {}) {
  const days = forecast && Array.isArray(forecast.days) ? forecast.days : [];
  const detailDays = days.filter((day) => day.detailed);
  const furtherDays = days.filter((day) => !day.detailed);
  const pvByDateKey = buildPvIndex(pvForecast);
  // Stand des Abrufs in der korrigierten homeESS-Zeit, nicht in der Systemzeit.
  const stand = forecast ? formatFetchedAt(forecast.fetchedAt) : '';

  const content = forecast
    ? `${renderCurrent(forecast.current, forecast.location || forecast)}
${renderChartSection(forecast)}
${detailDays.map((day) => renderDetailDay(day, pvByDateKey.get(day.dateKey) || null)).join('\n')}
${renderFurtherDays(furtherDays, pvByDateKey)}`
    : `        <div class="info-card">
          <p class="muted">Für die Wetterprognose werden Breiten- und Längengrad des Standortes benötigt.
          Sie werden unter <a href="/settings">Einstellungen</a> hinterlegt; danach steht die Prognose
          nach dem nächsten Abruf zur Verfügung.</p>
        </div>`;

  const body = `        <div class="page-head page-head--split">
          <h1>Wetterprognose</h1>
          <form action="/wetter/aktualisieren" method="POST" class="wetter-refresh">
            ${stand ? `<span class="wetter-stand">Stand: ${escapeHtml(stand)}</span>` : ''}
            <button type="submit" class="secondary-button">Aktualisieren</button>
          </form>
        </div>

        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}

${content}

        <p class="wetter-source">Datenquelle: Open-Meteo. Alle Werte stehen zusätzlich als States in der
        Systemgruppe <a href="/states">Wetter</a> zur Verfügung.</p>`;

  return renderLayout({ title: 'Wetterprognose', activePath: '/wetter', body });
}

module.exports = renderWetter;
