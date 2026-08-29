'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-wetter-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const { saveMqttConfig } = require('../src/mqtt/config');
const forecastModule = require('../src/wetter/forecast');
const timeHandler = require('../src/time-handler');
const { buildWeatherValues } = require('../src/wetter/values');
const { describeWeather, windDirectionText, beaufort, uvLevel } = require('../src/wetter/codes');
const renderWetter = require('../src/views/wetter');
const { renderWeatherChart } = require('../src/wetter/chart');
const wetterRoutes = require('../src/routes/wetter');
const { renderLayout, NAV } = require('../src/views/layout');
const { PAGES } = require('../src/auth/access');

const LATITUDE = 51.05;
const LONGITUDE = 10.62;

// Globalstrahlung der 14 Tagstunden (06:00–19:00) in W/m² als Tagesbogen.
// Aufsummiert 4520 Wh/m², also 4,52 kWh/m² Einstrahlung je Tag.
const RADIATION_BY_HOUR = [50, 120, 220, 330, 430, 500, 540, 540, 500, 430, 330, 220, 120, 190];

// Eine vollständige Open-Meteo-Antwort nachbilden: sieben Tage à 24 Stunden mit
// allen Variablen, die `forecast.js` anfragt.
function buildPayload() {
  const days = [];
  for (let d = 0; d < 7; d += 1) days.push(new Date(Date.UTC(2026, 7, 26 + d)));
  const key = (dt) => dt.toISOString().slice(0, 10);
  const hourly = {
    time: [], weather_code: [], temperature_2m: [], apparent_temperature: [],
    relative_humidity_2m: [], dew_point_2m: [], precipitation: [], precipitation_probability: [],
    rain: [], showers: [], snowfall: [], cloud_cover: [], pressure_msl: [], wind_speed_10m: [],
    wind_direction_10m: [], wind_gusts_10m: [], uv_index: [], visibility: [], is_day: [],
    shortwave_radiation: [], direct_radiation: [],
  };
  for (const dt of days) {
    for (let h = 0; h < 24; h += 1) {
      hourly.time.push(`${key(dt)}T${String(h).padStart(2, '0')}:00`);
      hourly.weather_code.push([0, 2, 3, 61, 95][h % 5]);
      hourly.temperature_2m.push(12 + h * 0.5);
      hourly.apparent_temperature.push(11 + h * 0.5);
      hourly.relative_humidity_2m.push(60);
      hourly.dew_point_2m.push(8);
      hourly.precipitation.push(h === 12 ? 1.5 : 0);
      hourly.precipitation_probability.push(h * 4);
      hourly.rain.push(0);
      hourly.showers.push(0);
      hourly.snowfall.push(0);
      hourly.cloud_cover.push(40);
      hourly.pressure_msl.push(1010);
      hourly.wind_speed_10m.push(10);
      hourly.wind_direction_10m.push(248);
      hourly.wind_gusts_10m.push(25);
      hourly.uv_index.push(h === 14 ? 5.5 : 0);
      hourly.visibility.push(24000);
      hourly.is_day.push(h >= 6 && h < 20 ? 1 : 0);
      // Tagsüber der Bogen, nachts null.
      hourly.shortwave_radiation.push(h >= 6 && h < 20 ? RADIATION_BY_HOUR[h - 6] : 0);
      hourly.direct_radiation.push(h >= 6 && h < 20 ? RADIATION_BY_HOUR[h - 6] / 2 : 0);
    }
  }
  const daily = {
    time: days.map(key),
    weather_code: [0, 2, 61, 3, 95, 71, 45],
    temperature_2m_max: [24.3, 22, 19.5, 21, 18, 3, 12],
    temperature_2m_min: [11.1, 12, 13, 10, 9, -2, 4],
    apparent_temperature_max: [25, 23, 20, 22, 19, 1, 11],
    apparent_temperature_min: [10, 11, 12, 9, 8, -5, 3],
    sunrise: days.map((d) => `${key(d)}T06:22`),
    sunset: days.map((d) => `${key(d)}T20:14`),
    daylight_duration: days.map(() => 49920),
    sunshine_duration: days.map(() => 32400),
    uv_index_max: [6.4, 5.1, 3.2, 7.8, 2.1, 1, 11.5],
    precipitation_sum: [0, 1.2, 8.4, 0.3, 12.6, 4, 0],
    rain_sum: [0, 1.2, 8.4, 0.3, 12.6, 0, 0],
    showers_sum: [0, 0, 0, 0, 0, 0, 0],
    snowfall_sum: [0, 0, 0, 0, 0, 2.8, 0],
    precipitation_hours: [0, 2, 7, 1, 9, 5, 0],
    precipitation_probability_max: [5, 35, 80, 20, 95, 70, 10],
    wind_speed_10m_max: [14, 22, 31, 18, 46, 25, 9],
    wind_gusts_10m_max: [28, 40, 55, 33, 82, 44, 18],
    wind_direction_10m_dominant: [225, 270, 315, 180, 45, 90, 135],
  };
  return {
    timezone: 'Europe/Berlin', timezone_abbreviation: 'CEST',
    latitude: LATITUDE, longitude: LONGITUDE, elevation: 312,
    current: {
      time: `${key(days[0])}T14:00`, weather_code: 2, temperature_2m: 21.4,
      apparent_temperature: 20.8, relative_humidity_2m: 58, is_day: 1, precipitation: 0,
      rain: 0, showers: 0, snowfall: 0, cloud_cover: 42, pressure_msl: 1014,
      surface_pressure: 978, wind_speed_10m: 12.6, wind_direction_10m: 248, wind_gusts_10m: 27,
    },
    hourly,
    daily,
  };
}

const forecast = forecastModule.normalize(buildPayload());

// Die PV-Prognose deckt denselben Zeitraum ab wie die Wetterseite (sieben Tage),
// damit jeder angezeigte Tag einen erwarteten Ertrag trägt.
const PV_KWH = [12.34, 31.08, 18.7, 22.5, 9.6, 27.15, 14.02];
const PV_TEXT = [
  '12,34 kWh', '31,08 kWh', '18,70 kWh', '22,50 kWh', '9,60 kWh', '27,15 kWh', '14,02 kWh',
];
const pvForecast = {
  days: forecast.days.map((day, index) => ({
    dateKey: day.dateKey,
    totalKwh: PV_KWH[index],
    totalFormatted: PV_TEXT[index],
  })),
};

test('WMO-Codes ergeben deutschen Klartext, Nachtsymbol und Einordnungen', () => {
  assert.deepEqual(describeWeather(3), { code: 3, label: 'Bedeckt', icon: '☁️' });
  // Nachts trägt eine klare Lage den Mond, nicht die Sonne.
  assert.equal(describeWeather(0, false).icon, '🌙');
  assert.equal(describeWeather(0, true).icon, '☀️');
  // Unbekannte Codes behaupten nichts.
  assert.equal(describeWeather(1234).code, null);
  assert.equal(describeWeather(null).label, 'Unbekannt');

  assert.equal(windDirectionText(0), 'N');
  assert.equal(windDirectionText(248), 'WSW');
  assert.equal(windDirectionText(359), 'N');
  assert.equal(windDirectionText(null), '');

  assert.equal(beaufort(0), 0);
  assert.equal(beaufort(30), 5);
  assert.equal(beaufort(200), 12);
  assert.equal(uvLevel(2).label, 'niedrig');
  assert.equal(uvLevel(7).label, 'hoch');
  assert.equal(uvLevel(12).label, 'extrem');
});

test('Die Antwort wird in sieben Tage mit Stundenverlauf normalisiert', () => {
  assert.equal(forecast.days.length, 7);
  assert.equal(forecast.days[0].name, 'Heute');
  assert.equal(forecast.days[1].name, 'Morgen');
  assert.equal(forecast.days[2].name, 'Übermorgen');
  // Genau drei Tage werden ausführlich dargestellt.
  assert.deepEqual(forecast.days.map((day) => day.detailed), [true, true, true, false, false, false, false]);
  assert.equal(forecast.days[3].name, 'Samstag');

  const heute = forecast.days[0];
  assert.equal(heute.hours.length, 24);
  assert.equal(heute.date, '26.08.2026');
  assert.equal(heute.weekday, 'Mittwoch');
  assert.equal(heute.temperatureMax, 24.3);
  assert.equal(heute.sunrise, '06:22');
  assert.equal(heute.sunset, '20:14');
  // Sekundenangaben werden in Stunden umgerechnet.
  assert.equal(heute.daylightHours, 49920 / 3600);
  assert.equal(heute.sunshineHours, 9);
  assert.equal(heute.windDirectionText, 'SW');
  // Tagesmittel und Strahlungsgrößen entstehen aus den Stundenwerten.
  assert.equal(Math.round(heute.cloudCoverAvg), 40);
  assert.equal(heute.radiationMax, 540);
  assert.equal(heute.radiationSum, 4.52);

  // Nachtstunden sind als solche markiert, Tagstunden nicht.
  assert.equal(heute.hours[3].isDay, false);
  assert.equal(heute.hours[12].isDay, true);
});

test('Der Aktuellwert wird um die nur stündlich gelieferten Größen ergänzt', () => {
  const now = forecast.current;
  assert.equal(now.temperature, 21.4);
  assert.equal(now.label, 'Teilweise bewölkt');
  assert.equal(now.windDirectionText, 'WSW');
  assert.equal(now.clock, '14:00');
  // UV, Taupunkt und Sichtweite stammen aus der zum Zeitstempel passenden Stunde.
  assert.equal(now.uvIndex, 5.5);
  assert.equal(now.dewPoint, 8);
  assert.equal(now.visibility, 24000);
  // 14:00 ist die neunte Tagstunde ab 06:00.
  assert.equal(now.radiation, 500);
});

test('Eine unbrauchbare Antwort ergibt keine Prognose', () => {
  assert.equal(forecastModule.normalize({}), null);
  assert.equal(forecastModule.normalize({ daily: { time: [] } }), null);
});

test('Alle Wetterwerte stehen als States in sauber sortierten Untergruppen', () => {
  const values = buildWeatherValues(forecast);

  const ids = values.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'State-IDs müssen eindeutig sein');
  const labels = values.map((entry) => entry.label);
  assert.equal(new Set(labels).size, labels.length, 'Anzeigenamen müssen eindeutig sein');
  assert.ok(ids.every((id) => id.startsWith('wetter.')), 'alle IDs tragen das Präfix wetter.');

  // Untergruppen der Systemgruppe „Wetter": alphanumerisch sortiert ergeben sie
  // die zeitliche Reihenfolge.
  const groups = [...new Set(values.map((entry) => entry.category))];
  assert.ok(groups.every((group) => group.startsWith('Wetter / ')));
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  assert.deepEqual([...groups].sort(collator.compare), [
    'Wetter / Aktuell',
    'Wetter / Standort',
    'Wetter / Tag 1 – Heute',
    'Wetter / Tag 2 – Morgen',
    'Wetter / Tag 3 – Übermorgen',
    'Wetter / Weitere Tage',
  ]);

  const byId = new Map(values.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('wetter.aktuell.temperatur').value, 21.4);
  assert.equal(byId.get('wetter.aktuell.temperatur').display, '21,4 °C');
  assert.equal(byId.get('wetter.aktuell.windrichtungText').value, 'WSW');
  assert.equal(byId.get('wetter.tag1.temperaturMax').value, 24.3);
  assert.equal(byId.get('wetter.tag2.niederschlagWahrscheinlichkeit').value, 35);
  assert.equal(byId.get('wetter.tag3.niederschlagSumme').display, '8,4 mm');
  assert.equal(byId.get('wetter.tag3.sonnenaufgang').value, '06:22');
  assert.equal(byId.get('wetter.tag1.uvStufe').value, 'hoch');
  // Sonnenintensität der Prognose ist die Globalstrahlung, nicht sun.intensity.*.
  assert.equal(byId.get('wetter.aktuell.sonnenintensitaet').display, '500 W/m²');
  assert.equal(byId.get('wetter.tag1.sonnenintensitaetMax').value, 540);
  assert.equal(byId.get('wetter.tag2.einstrahlung').display, '4,52 kWh/m²');
  assert.equal(byId.get('wetter.standort.zeitzone').value, 'Europe/Berlin');
  assert.equal(byId.get('wetter.standort.verfuegbar').value, true);

  // Die Kurztage 4–7 liegen in einer gemeinsamen Gruppe.
  for (const day of [4, 5, 6, 7]) {
    assert.equal(byId.get(`wetter.tag${day}.temperaturMax`).category, 'Wetter / Weitere Tage');
  }
  assert.equal(byId.get('wetter.tag7.uvIndexMax').value, 11.5);
  // Kurztage tragen bewusst keine Stundengrößen.
  assert.equal(byId.has('wetter.tag4.sonnenaufgang'), false);
});

test('Ohne Prognose bleiben die Wetter-States vorhanden, aber leer', () => {
  const withData = buildWeatherValues(forecast);
  const empty = buildWeatherValues(null);
  assert.equal(empty.length, withData.length, 'die Zahl der States hängt nicht von den Daten ab');
  assert.deepEqual(empty.map((entry) => entry.id), withData.map((entry) => entry.id));

  const byId = new Map(empty.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('wetter.aktuell.temperatur').value, null);
  assert.equal(byId.get('wetter.aktuell.temperatur').display, '— °C');
  assert.equal(byId.get('wetter.standort.verfuegbar').value, false);
});

test('Die Systemwerte melden die Gruppe Wetter mit', async () => {
  const systemValues = require('../src/states/system-values');
  assert.ok(systemValues.VALUE_CATEGORIES.includes('Wetter'));
  assert.equal(systemValues.categoryForId('wetter.aktuell.temperatur'), 'Wetter');
});

function renderFullPage() {
  return renderWetter({
    forecast: { ...forecast, location: { latitude: LATITUDE, longitude: LONGITUDE } },
    pvForecast,
  });
}

test('Die Seite zeigt drei Tage ausführlich und die weiteren kurz', () => {
  const html = renderFullPage();

  // Drei ausführliche Tageskacheln mit Stundenverlauf (3 × 24 Spalten).
  assert.equal((html.match(/class="wetter-day panel-card"/g) || []).length, 3);
  assert.equal((html.match(/class="wetter-hour(?: wetter-hour--night)?"/g) || []).length, 72);
  // Vier Kurzzeilen für die restlichen Tage.
  assert.equal((html.match(/class="wetter-short-row"/g) || []).length, 4);

  assert.match(html, /Heute/);
  assert.match(html, /Übermorgen/);
  assert.match(html, /Sonnenaufgang/);
  assert.match(html, /Sichtweite/);
  // Piktogramme: die Wetterlage und die Messgrößen tragen Symbole.
  assert.match(html, /wetter-metric-icon/);
  assert.match(html, /🌡️|☀️|🌧️/);
  // Werte erscheinen in deutscher Schreibweise.
  assert.match(html, /24,3 °C/);
});

test('Die Messgrößen stehen in thematischen Blöcken statt in einer langen Reihe', () => {
  const html = renderFullPage();
  const headings = [...html.matchAll(/class="wetter-group-head">.*?<\/span>([^<]+)</g)].map((match) => match[1]);

  // Aktuelle Lage: drei Blöcke. Je Detailtag fünf Messblöcke + Stundenverlauf.
  assert.deepEqual(headings.slice(0, 3), ['Sonne', 'Wind', 'Luft und Niederschlag']);
  assert.deepEqual(headings.slice(3, 9), [
    'Temperatur', 'Niederschlag', 'Wind', 'Sonne und Licht', 'Luft (Tagesmittel)', 'Stundenverlauf',
  ]);
  assert.equal(headings.length, 3 + 3 * 6);
  // Jeder Block trägt ein eigenes Kachelraster.
  assert.equal((html.match(/class="wetter-metrics"/g) || []).length, 3 + 3 * 5);
});

test('Am Schreibtisch wird jede Gruppe eine Spalte mit schmucklosen Wertezeilen', () => {
  const html = renderFullPage();
  // Wert und Einordnung bilden eine rechtsbündige Einheit je Zeile.
  const zeilen = (html.match(/class="wetter-metric(?: wetter-metric--\w+)?"/g) || []).length;
  assert.equal((html.match(/class="wetter-metric-figure"/g) || []).length, zeilen);
  // Der Stundenverlauf ist keine Wertespalte: er ist als vollbreit markiert.
  assert.equal((html.match(/wetter-group--wide/g) || []).length, 3);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const desktop = css.slice(css.indexOf('@media (min-width: 769px)'));
  // Gruppen nebeneinander als Raster.
  assert.match(desktop, /\.wetter-groups\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fit/s);
  // Werte untereinander statt im Kachelraster …
  assert.match(desktop, /\.wetter-metrics\s*\{[^}]*display:\s*block;/s);
  // … und ohne sichtbare Kachel: kein Rahmen, kein eigener Grund.
  assert.match(desktop, /\.wetter-metric\s*\{[^}]*border:\s*0;[^}]*background:\s*none;/s);
  // Bezeichnung links, Wert rechts auf gemeinsamer Grundlinie.
  assert.match(desktop, /\.wetter-metric-body\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*baseline;/s);
  assert.match(desktop, /\.wetter-metric-figure\s*\{[^}]*align-items:\s*flex-end;/s);

  // Am Telefon bleibt das Kachelraster unverändert bestehen.
  assert.match(css, /\.wetter-metrics\s*\{\s*display:\s*grid;/);
  const mobil = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
  assert.match(mobil, /\.wetter-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
});

// Ende des Behälters finden, der an `start` beginnt (div-Tiefe mitzählen).
function closingIndex(html, start) {
  const pattern = /<div\b[^>]*>|<\/div>/g;
  pattern.lastIndex = start;
  let depth = 0;
  let match = pattern.exec(html);
  while (match) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return match.index;
    match = pattern.exec(html);
  }
  return -1;
}

test('Der Stundenverlauf steht als volle Zeile unter den Spalten, nicht darin', () => {
  const html = renderFullPage();
  let position = 0;
  let tage = 0;

  while ((position = html.indexOf('class="wetter-day panel-card"', position)) >= 0) {
    tage += 1;
    const start = html.indexOf('<div class="wetter-groups">', position);
    const ende = closingIndex(html, start);
    const verlauf = html.indexOf('wetter-group--wide', position);
    assert.ok(start > 0 && ende > start, 'der Spaltenbehälter ist geschlossen');

    // Im Raster stehen ausschließlich die fünf Wertespalten …
    assert.equal((html.slice(start, ende).match(/class="wetter-group"/g) || []).length, 5);
    // … und der Stundenverlauf folgt erst danach, außerhalb des Behälters.
    assert.ok(verlauf > ende, 'der Stundenverlauf liegt außerhalb des Spaltenrasters');
    position = ende;
  }
  assert.equal(tage, 3);

  // Als eigenes Geschwisterelement braucht er denselben Abstand wie die Spalten
  // untereinander — und keinen Rastertrick, der ihn in eine Spalte quetschen kann.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.wetter-group--wide\s*\{\s*margin-top:\s*14px;\s*\}/);
  // Im Desktop-Block darf er gar nicht mehr auftauchen: er ist kein Rasterfeld.
  const desktop = css.slice(css.indexOf('@media (min-width: 769px)'));
  assert.doesNotMatch(desktop.slice(0, desktop.indexOf('\n}')), /wetter-group--wide/);
});

test('Der erwartete PV-Ertrag steht im Titel der ausführlichen Tage', () => {
  const html = renderFullPage();
  assert.equal((html.match(/class="wetter-day-pv"/g) || []).length, 3);
  assert.match(html, /wetter-day-pv-value">12,34 kWh/);
  assert.match(html, /wetter-day-pv-value">31,08 kWh/);
  assert.match(html, /wetter-day-pv-value">18,70 kWh/);
  // Die PV-Prognose reicht so weit wie die Wetterprognose: jeder Kurztag trägt
  // sie, keine Zeile fällt aus der Reihe.
  assert.equal((html.match(/wetter-short-cell--pv/g) || []).length, 4);
  assert.match(html, /wetter-short-cell--pv"[^>]*>⚡ 14,02 kWh</);

  // Ohne PV-Prognose entfällt die Angabe ersatzlos statt leer dazustehen.
  const ohnePv = renderWetter({ forecast });
  assert.doesNotMatch(ohnePv, /wetter-day-pv/);
});

test('Zwischen aktueller Lage und dem ersten Tag steht das Verlaufsdiagramm', () => {
  const html = renderFullPage();
  const jetzt = html.indexOf('class="wetter-now panel-card"');
  const verlauf = html.indexOf('class="wetter-trend panel-card"');
  const heute = html.indexOf('class="wetter-day panel-card"');
  assert.ok(jetzt >= 0 && verlauf > jetzt && heute > verlauf,
    'die Reihenfolge ist aktuelle Lage, Verlauf, erster Tag');

  // Die Verlaufskachel bekommt denselben Abstand nach unten wie die übrigen
  // Kacheln — sonst klebt sie am ersten Tag.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.wetter-now,\s*\.wetter-trend,\s*\.wetter-day,\s*\.wetter-short\s*\{[^}]*margin-bottom:\s*18px;/s);
});

test('Der Stand oben rechts nutzt die korrigierte homeESS-Zeit', () => {
  // Ein Zeitstempel, dessen rohe Systemdarstellung sich von der korrigierten
  // homeESS-Zeit unterscheidet, sobald Zone oder Offset abweichen.
  const fetchedAt = Date.UTC(2026, 7, 26, 4, 56, 0);
  const erwartet = forecastModule.formatFetchedAt(fetchedAt);
  const parts = timeHandler.calendar(new Date(fetchedAt));
  assert.equal(erwartet, `${parts.date}, ${parts.time.slice(0, 5)}`);

  const html = renderWetter({ forecast: { ...forecast, fetchedAt }, pvForecast });
  assert.match(html, new RegExp(`Stand: ${erwartet.replace(/\./g, '\\.')}`));

  // Derselbe Wortlaut steht im State „Stand der Prognose".
  const stand = buildWeatherValues({ ...forecast, fetchedAt })
    .find((entry) => entry.id === 'wetter.standort.stand');
  assert.equal(stand.value, erwartet);

  // Ohne Abruf bleibt die Angabe leer statt auf 1970 zu zeigen.
  assert.equal(forecastModule.formatFetchedAt(null), '');
  assert.equal(forecastModule.formatFetchedAt(0), '');
});

test('Das Verlaufsdiagramm baut flach, damit es die Seite nicht dominiert', () => {
  const svg = renderWeatherChart(forecast.days, forecast.current);
  assert.match(svg, /viewBox="0 0 1080 200"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.wetter-chart--wide\s*\{\s*height:\s*200px;\s*\}/);
});

test('Die schmale Bauform des Diagramms trägt keine Schrift im SVG', () => {
  const compact = renderWeatherChart(forecast.days, forecast.current, { variant: 'compact' });
  const svg = /<svg[\s\S]*?<\/svg>/.exec(compact)[0];

  // Ohne Text im SVG kann die Beschriftung beim Dehnen nicht gestaucht werden.
  assert.doesNotMatch(svg, /<text/);
  assert.match(svg, /viewBox="0 0 360 132"/);
  // Flächen und Linien sind vollständig vorhanden.
  assert.match(svg, /wetter-chart-line--temp/);
  assert.match(svg, /wetter-chart-line--sun/);
  assert.match(svg, /wetter-chart-area--sun/);
  assert.match(svg, /wetter-chart-rain/);

  // Die Tagesnamen stehen als HTML darüber — sieben gleich breite Zellen,
  // deckungsgleich mit den Tagesabschnitten im SVG.
  const tage = [...compact.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(tage.length, 7);
  assert.equal(tage[0], forecast.days[0].weekday.slice(0, 2));

  // Die Legende ersetzt die fehlenden Achsen und nennt die echten Datenbereiche,
  // nicht das gerundete Achsenmaximum.
  const stunden = forecast.days.flatMap((day) => day.hours);
  const tempMin = Math.min(...stunden.map((hour) => hour.temperature));
  const tempMax = Math.max(...stunden.map((hour) => hour.temperature));
  const sonneMax = Math.max(...stunden.map((hour) => hour.radiation));
  assert.match(compact, new RegExp(`Temperatur ${Math.round(tempMin)} – ${Math.round(tempMax)} °C`));
  assert.match(compact, new RegExp(`Sonnenintensität bis ${sonneMax} W/m²`));

  // Beide Bauformen liegen im Markup, sichtbar ist je Breite genau eine.
  const html = renderFullPage();
  assert.equal((html.match(/wetter-chart-figure--wide/g) || []).length, 1);
  assert.equal((html.match(/wetter-chart-figure--compact/g) || []).length, 1);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.wetter-chart-figure--compact\s*\{\s*display:\s*none;\s*\}/);
  const mobil = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
  assert.match(mobil, /\.wetter-chart-figure--wide\s*\{\s*display:\s*none;\s*\}/);
  assert.match(mobil, /\.wetter-chart-figure--compact\s*\{\s*display:\s*block;\s*\}/);
});

test('Am Telefon muss nichts seitlich gescrollt werden', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const wetterCss = css.slice(css.indexOf('   Wetterprognose'));
  const mobil = css.slice(css.lastIndexOf('@media (max-width: 768px)'));

  // Kein Abschnitt der Seite erzwingt eine Mindestbreite. Gesucht wird nur in
  // Deklarationen (nach `{` oder `;`) — die Bedingung einer @media-Regel steht
  // hinter `(` und ist keine Breitenvorgabe an ein Element.
  assert.doesNotMatch(wetterCss, /[;{]\s*min-width:\s*(?:[2-9]\d\d|\d{4,})px/);
  // … und der Stundenverlauf scrollt am Telefon nicht mehr seitlich.
  assert.match(mobil, /\.wetter-hours\s*\{[^}]*overflow-x:\s*hidden;/s);

  // Statt 24 schmaler Spalten werden nur die 3-Stunden-Schritte gezeigt; die
  // verbleibenden acht teilen sich die Breite.
  assert.match(mobil, /\.wetter-hour\s*\{[^}]*display:\s*none;[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0;/s);
  assert.match(mobil, /\.wetter-hour:nth-child\(3n \+ 1\)\s*\{\s*display:\s*flex;\s*\}/);

  // Die Spalten liegen so im Markup, dass jede dritte eine volle Stunde ist.
  const html = renderFullPage();
  const spalten = [...html.matchAll(/wetter-hour-clock">(\d\d):\d\d</g)].map((match) => Number(match[1]));
  const sichtbar = spalten.slice(0, 24).filter((_, index) => index % 3 === 0);
  assert.deepEqual(sichtbar, [0, 3, 6, 9, 12, 15, 18, 21]);

  // Der Hinweis auf die Ausdünnung steht nur in der Telefonansicht.
  assert.match(html, /Am Telefon in 3-Stunden-Schritten/);
  assert.match(wetterCss, /\.wetter-hours-note\s*\{\s*display:\s*none;\s*\}/);
  assert.match(mobil, /\.wetter-hours-note\s*\{\s*display:\s*inline;/);
});

test('Das Verlaufsdiagramm zeichnet Temperatur, Sonnenintensität und Niederschlag', () => {
  const svg = renderWeatherChart(forecast.days, forecast.current);

  // Zwei Linien mit eigener Farbrolle.
  assert.match(svg, /class="wetter-chart-line wetter-chart-line--temp" d="M/);
  assert.match(svg, /class="wetter-chart-line wetter-chart-line--sun" d="M/);
  // Niederschlag als Balken: je Tag genau eine Stunde mit 1,5 mm.
  assert.equal((svg.match(/class="wetter-chart-rain"/g) || []).length, 7);
  assert.match(svg, /Niederschlag 1,5 mm/);
  // Alle sieben Tage sind beschriftet, die laufende Stunde ist markiert.
  assert.equal((svg.match(/class="wetter-chart-daylabel"/g) || []).length, 7);
  assert.match(svg, /class="wetter-chart-now"/);
  // Beide Achsen sind beschriftet.
  assert.match(svg, /wetter-chart-axis--temp/);
  assert.match(svg, /wetter-chart-axis--sun/);
  assert.match(svg, /Sonnenintensität \(W\/m², rechte Achse\)/);
});

test('Die Sonnenkurve ist halbtransparent zur Nulllinie hin gefüllt', () => {
  const svg = renderWeatherChart(forecast.days, forecast.current);
  const flaeche = /class="wetter-chart-area wetter-chart-area--sun" d="([^"]+)"/.exec(svg);
  assert.ok(flaeche, 'die Fläche unter der Sonnenkurve wird gezeichnet');

  // Der Zug beginnt und endet auf der Grundlinie und ist geschlossen.
  const pfad = flaeche[1];
  const grundlinie = /^M[\d.]+ ([\d.]+) /.exec(pfad)[1];
  assert.match(pfad, new RegExp(`L[\\d.]+ ${grundlinie} Z$`));

  // Die Grundlinie ist die Null der Sonnenachse — hier die Unterkante der
  // Zeichenfläche, weil die Strahlung nie negativ wird.
  assert.equal(Number(grundlinie), 200 - 38);

  // Sie liegt ganz hinten: vor den Niederschlagsbalken und vor beiden Linien.
  assert.ok(svg.indexOf('wetter-chart-area') < svg.indexOf('wetter-chart-rain'));
  assert.ok(svg.indexOf('wetter-chart-rain') < svg.indexOf('wetter-chart-line--sun'));

  // 50 % Deckkraft, aus einer gemeinsamen Quelle für Diagramm und Legende.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /--wetter-sun-fill:\s*rgba\(204, 154, 30, 0\.5\);/);
  assert.match(css, /\.wetter-chart-area--sun\s*\{\s*fill:\s*var\(--wetter-sun-fill\);\s*\}/);
  // Auch das dunkle Thema hat einen eigenen halbtransparenten Ton.
  assert.match(css, /--wetter-sun-fill:\s*rgba\(242, 201, 76, 0\.5\);/);
});

test('Eine Lücke in der Strahlung bleibt eine Lücke, statt überbrückt zu werden', () => {
  // Mittagsstunde ohne Messwert: die Fläche zerfällt in zwei geschlossene Züge.
  const tag = forecast.days[0];
  const mitLuecke = {
    ...tag,
    hours: tag.hours.map((hour) => (hour.hour === 12 ? { ...hour, radiation: null } : hour)),
  };
  const svg = renderWeatherChart([mitLuecke], forecast.current);
  const pfad = /class="wetter-chart-area wetter-chart-area--sun" d="([^"]+)"/.exec(svg)[1];
  assert.equal((pfad.match(/Z/g) || []).length, 2);
});

test('Ohne Stundenwerte erklärt das Diagramm die Lücke statt leer zu bleiben', () => {
  assert.match(renderWeatherChart([]), /keine Stundenwerte/);
  assert.match(renderWeatherChart([{ hours: [] }]), /keine Stundenwerte/);
  // Eine einzelne Stunde ergibt noch keinen Verlauf.
  assert.match(renderWeatherChart([{ name: 'Heute', hours: [forecast.days[0].hours[0]] }]), /zu wenige Stundenwerte/);
});

test('Ohne hinterlegten Standort erklärt die Seite den fehlenden Wert', () => {
  const html = renderWetter({ forecast: null });
  assert.match(html, /Breiten- und Längengrad/);
  assert.doesNotMatch(html, /wetter-short-row/);
});

test('Die Wetterprognose steht an letzter Stelle im Hauptmenü', () => {
  const html = renderLayout({ title: 'Navigation', activePath: '/wetter', body: '<p>Test</p>' });
  const link = html.indexOf('href="/wetter"');
  assert.ok(link > 0, 'der Menüpunkt ist vorhanden');
  // Kein anderer Hauptmenüpunkt steht dahinter.
  for (const item of NAV.filter((entry) => entry.section === 'main' && entry.path !== '/wetter')) {
    assert.ok(html.indexOf(`href="${item.path}"`) < link, `${item.path} muss vor der Wetterprognose stehen`);
  }
  // Die Seite ist im Rechtemodell hinterlegt, damit sie ausgeblendet werden kann.
  assert.ok(PAGES.some((page) => page.key === 'wetter' && page.prefix === '/wetter'));
});

// --- Routen -----------------------------------------------------------------

let db;
let server;
let baseUrl;
let echtesFetch;

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await new Promise((resolve) => saveMqttConfig(db, { host: 'localhost', port: 1883, latitude: LATITUDE, longitude: LONGITUDE }, resolve));
  // Cache vorbelegen, damit die Routen ohne Netzzugriff antworten.
  forecastModule.resetForTests({ latitude: LATITUDE, longitude: LONGITUDE, data: forecast });

  // Der Weg nach draußen wird stillgelegt: Aufrufe an Open-Meteo beantwortet die
  // Testantwort, alles andere (die Anfragen an den Testserver) läuft normal.
  // Ohne das würde ein Aktualisieren-Test wirklich ins Netz greifen — langsam,
  // wetterabhängig und damit unbrauchbar als Zusicherung.
  echtesFetch = global.fetch;
  global.fetch = (url, init) => (String(url).includes('api.open-meteo.com')
    ? Promise.resolve({ ok: true, json: async () => buildPayload() })
    : echtesFetch(url, init));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(wetterRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (echtesFetch) global.fetch = echtesFetch;
  if (server) server.close();
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /wetter liefert die Seite aus dem Cache', async () => {
  const html = await fetch(`${baseUrl}/wetter`).then((res) => res.text());
  assert.match(html, /Wetterprognose/);
  assert.match(html, /24,3 °C/);
  assert.equal((html.match(/class="wetter-short-row"/g) || []).length, 4);
});

test('Ein Abruf leitet zurück auf die Seite, statt auf der POST-Adresse zu bleiben', async () => {
  const response = await fetch(`${baseUrl}/wetter/aktualisieren`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
    redirect: 'manual',
  });
  // 303 macht ausdrücklich einen GET daraus; die Adresse zeigt wieder auf /wetter.
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/wetter?ok=1');

  // Die Rückmeldung steht auf der Zielseite.
  const html = await fetch(`${baseUrl}/wetter?ok=1`).then((res) => res.text());
  assert.match(html, /Wetterprognose aktualisiert\./);

  // Schlägt der Abruf fehl, meldet die Seite das und zeigt den letzten Stand.
  const fehlerseite = await fetch(`${baseUrl}/wetter?fehler=1`).then((res) => res.text());
  assert.match(fehlerseite, /konnte nicht abgerufen werden/);

  // Ohne Kennzeichen bleibt die Seite meldungsfrei.
  const ohne = await fetch(`${baseUrl}/wetter`).then((res) => res.text());
  assert.doesNotMatch(ohne, /Wetterprognose aktualisiert\./);
});

test('Eine gemerkte Abruf-Adresse per GET führt zurück auf die Seite', async () => {
  // Genau das passiert, wenn die App ihre zuletzt besuchte Adresse wieder
  // öffnet: früher endete das in „Cannot GET /wetter/aktualisieren".
  const response = await fetch(`${baseUrl}/wetter/aktualisieren`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/wetter');

  const gefolgt = await fetch(`${baseUrl}/wetter/aktualisieren`);
  assert.equal(gefolgt.status, 200);
  assert.match(await gefolgt.text(), /Wetterprognose/);
});

test('GET /wetter/daten liefert die Prognose als JSON', async () => {
  const response = await fetch(`${baseUrl}/wetter/daten`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.days.length, 7);
  assert.equal(data.days[0].name, 'Heute');
  assert.equal(data.current.temperature, 21.4);
  assert.equal(data.location.latitude, LATITUDE);
});
