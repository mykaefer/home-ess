'use strict';

// Wetter-Kachel des Dashboards: Konfiguration, Wertermittlung, Markup und der
// Weg über die Route (Anlegen, Seitenaufbau, Nachladen).

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-dashboard-weather-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const { saveMqttConfig } = require('../src/mqtt/config');
const widgetsRepo = require('../src/dashboard/widgets');
const dashboardRoutes = require('../src/routes/dashboard');
const renderDashboard = require('../src/views/dashboard');
const forecastModule = require('../src/wetter/forecast');
const {
  WEATHER_FIELDS,
  WEATHER_DAY_OPTIONS,
  DEFAULT_WEATHER_FIELDS,
  normalizeWeatherConfig,
  readWeatherWidget,
  weatherWidgetLabel,
  usesPvYield,
} = require('../src/dashboard/weather-widget');

const LATITUDE = 48.137;
const LONGITUDE = 11.575;

// Kompakte, aber echte Open-Meteo-Antwort: zwei Tage mit je zwei Stunden. Sie
// läuft durch dieselbe Normalisierung wie die Wetterseite — so prüft der Test
// die tatsächlichen Feldnamen des Datenmodells und nicht eine Attrappe.
function buildForecast() {
  const payload = {
    timezone: 'Europe/Berlin',
    latitude: LATITUDE,
    longitude: LONGITUDE,
    current: {
      time: '2026-08-28T14:00',
      weather_code: 2, temperature_2m: 21.4, apparent_temperature: 20.8,
      relative_humidity_2m: 58, is_day: 1, precipitation: 0.2, rain: 0.2, showers: 0,
      snowfall: 0, cloud_cover: 42, pressure_msl: 1014, surface_pressure: 978,
      wind_speed_10m: 12.6, wind_direction_10m: 248, wind_gusts_10m: 27,
    },
    hourly: {
      time: ['2026-08-28T13:00', '2026-08-28T14:00', '2026-08-29T13:00', '2026-08-29T14:00'],
      weather_code: [2, 2, 3, 3],
      temperature_2m: [20.1, 21.4, 18.2, 19.6],
      apparent_temperature: [19.5, 20.8, 17.4, 18.9],
      relative_humidity_2m: [60, 58, 71, 69],
      dew_point_2m: [12.4, 12.8, 13.1, 13.4],
      precipitation: [0, 0.2, 1.2, 0.4],
      precipitation_probability: [10, 20, 80, 60],
      rain: [0, 0.2, 1.2, 0.4],
      showers: [0, 0, 0, 0],
      snowfall: [0, 0, 0, 0],
      cloud_cover: [40, 44, 88, 92],
      pressure_msl: [1014, 1013, 1008, 1007],
      wind_speed_10m: [11, 12.6, 22, 25],
      wind_direction_10m: [240, 248, 270, 280],
      wind_gusts_10m: [24, 27, 44, 51],
      uv_index: [4.2, 3.8, 1.9, 1.4],
      visibility: [24000, 21000, 9000, 8000],
      is_day: [1, 1, 1, 1],
      shortwave_radiation: [640, 580, 210, 160],
      direct_radiation: [420, 380, 60, 40],
    },
    daily: {
      time: ['2026-08-28', '2026-08-29'],
      weather_code: [2, 61],
      temperature_2m_max: [24.3, 19.8],
      temperature_2m_min: [12.7, 11.4],
      apparent_temperature_max: [23.1, 18.9],
      apparent_temperature_min: [11.8, 10.6],
      sunrise: ['2026-08-28T06:22', '2026-08-29T06:24'],
      sunset: ['2026-08-28T20:14', '2026-08-29T20:12'],
      daylight_duration: [49920, 49680],
      sunshine_duration: [32400, 9000],
      uv_index_max: [5.4, 2.1],
      precipitation_sum: [0.2, 6.4],
      rain_sum: [0.2, 6.4],
      showers_sum: [0, 0],
      snowfall_sum: [0, 0],
      precipitation_hours: [1, 7],
      precipitation_probability_max: [20, 80],
      wind_speed_10m_max: [14, 31],
      wind_gusts_10m_max: [28, 55],
      wind_direction_10m_dominant: [248, 275],
    },
  };
  return forecastModule.normalize(payload);
}

const forecast = buildForecast();
// Erwarteter PV-Ertrag: die PV-Prognose liefert Tagesschlüssel und Tagesertrag.
const pvForecast = {
  days: forecast.days.map((day, index) => ({
    dateKey: day.dateKey,
    totalKwh: [31.08, 9.4][index],
    totalFormatted: ['31,08 kWh', '9,40 kWh'][index],
  })),
};

// ── Konfiguration ──────────────────────────────────────────────────────────

test('Die Konfiguration prüft Tageswahl und Feldliste', () => {
  const config = normalizeWeatherConfig({ day: '1', fields: ['uvIndex', 'sunrise', 'gibtesnicht'] });
  assert.equal(config.day, '1');
  assert.deepEqual(config.fields, ['uvIndex', 'sunrise'], 'unbekannte Schlüssel fallen weg');

  // Reihenfolge folgt immer dem Katalog, nicht der Eingabe.
  const sorted = normalizeWeatherConfig({ day: '0', fields: ['sunset', 'temperature'] });
  assert.deepEqual(sorted.fields, ['temperature', 'sunset']);

  // Unbrauchbare Tageswahl fällt auf die aktuelle Lage zurück.
  assert.equal(normalizeWeatherConfig({ day: '99' }).day, 'current');
  assert.equal(normalizeWeatherConfig({ day: 'übermorgen' }).day, 'current');
  assert.equal(normalizeWeatherConfig({}).day, 'current');

  // Leere Auswahl ergibt die Grundauswahl statt einer leeren Kachel.
  assert.deepEqual(normalizeWeatherConfig({ fields: [] }).fields, DEFAULT_WEATHER_FIELDS);

  // Die Tagesauswahl deckt den gesamten Prognosezeitraum ab.
  assert.equal(WEATHER_DAY_OPTIONS.length, forecastModule.FORECAST_DAYS + 1);
  assert.equal(WEATHER_DAY_OPTIONS[0].key, 'current');
  assert.deepEqual(
    WEATHER_DAY_OPTIONS.slice(1, 4).map((option) => option.label),
    ['Heute', 'Morgen', 'Übermorgen']
  );
});

test('Jedes Katalogfeld liefert in jeder erlaubten Anzeigeart einen Wert', () => {
  for (const field of WEATHER_FIELDS) {
    for (const scope of field.scopes) {
      assert.equal(typeof field[scope], 'function', `${field.key} fehlt für ${scope}`);
    }
    assert.ok(field.scopes.length, `${field.key} ohne Anzeigeart`);
  }
  // Die Grundauswahl muss in beiden Anzeigearten etwas ergeben.
  const current = readWeatherWidget({ day: 'current' }, { forecast });
  const day = readWeatherWidget({ day: '1' }, { forecast });
  assert.ok(current.fields.length >= 4);
  assert.ok(day.fields.length >= 4);
});

// ── Wertermittlung ─────────────────────────────────────────────────────────

test('Die aktuelle Lage füllt Kopfzeile und gewählte Werte', () => {
  const view = readWeatherWidget(
    { day: 'current', fields: ['temperature', 'windSpeed', 'uvIndex', 'visibility', 'sunrise'] },
    { forecast }
  );
  assert.equal(view.available, true);
  assert.equal(view.head.title, 'Jetzt');
  assert.equal(view.head.subtitle, '14:00 Uhr');
  assert.equal(view.head.value, '21,4 °C');

  const byKey = new Map(view.fields.map((field) => [field.key, field]));
  assert.equal(byKey.get('temperature').display, '21,4 °C');
  assert.equal(byKey.get('windSpeed').display, '13 km/h');
  assert.equal(byKey.get('windSpeed').hint, '3 Bft');
  // UV kommt aus der Stundenreihe und trägt die amtliche Einordnung.
  assert.equal(byKey.get('uvIndex').display, '3,8');
  assert.equal(byKey.get('uvIndex').hint, 'mäßig');
  assert.equal(byKey.get('uvIndex').tone, 'good');
  // Sichtweite rechnet Meter in Kilometer um.
  assert.equal(byKey.get('visibility').display, '21,0 km');
  // Sonnenaufgang gibt es nur für einen Tag — in der aktuellen Lage nicht.
  assert.equal(byKey.has('sunrise'), false);
});

test('Ein Prognosetag nutzt die Tagesgrößen und eigene Bezeichnungen', () => {
  const view = readWeatherWidget(
    {
      day: '1',
      fields: ['temperature', 'precipitationProbability', 'windSpeed', 'humidity', 'sunrise', 'pvYield'],
    },
    { forecast, pvForecast }
  );
  assert.equal(view.available, true);
  assert.equal(view.head.title, 'Morgen');
  assert.equal(view.head.value, '20 / 11 °C');

  const byKey = new Map(view.fields.map((field) => [field.key, field]));
  assert.equal(byKey.get('temperature').label, 'Höchst-/Tiefstwert');
  assert.equal(byKey.get('temperature').display, '19,8 / 11,4 °C');
  assert.equal(byKey.get('precipitationProbability').display, '80 %');
  assert.equal(byKey.get('windSpeed').label, 'Wind max.');
  assert.equal(byKey.get('windSpeed').display, '31 km/h');
  // Luftfeuchte am Tag ist das Mittel der Stundenwerte.
  assert.equal(byKey.get('humidity').label, 'Luftfeuchte (Mittel)');
  assert.equal(byKey.get('humidity').display, '70 %');
  assert.equal(byKey.get('sunrise').display, '06:24');
  // Der PV-Ertrag wird über den Tagesschlüssel aus der PV-Prognose geholt.
  assert.equal(byKey.get('pvYield').display, '9,40 kWh');
});

test('Ohne PV-Prognose bleibt die Ertragszeile leer statt zu verschwinden', () => {
  const view = readWeatherWidget({ day: '0', fields: ['pvYield'] }, { forecast });
  const pv = view.fields.find((field) => field.key === 'pvYield');
  assert.ok(pv, 'die Zeile bleibt stehen');
  assert.equal(pv.display, '—');
  // Nur wenn der Ertrag gewählt ist, muss die Route die PV-Prognose laden.
  assert.equal(usesPvYield({ fields: ['pvYield'] }), true);
  assert.equal(usesPvYield({ fields: ['temperature'] }), false);
});

test('Ohne Wetterprognose behält die Kachel ihre Form und erklärt die Lücke', () => {
  const view = readWeatherWidget({ day: 'current', fields: ['temperature', 'windSpeed'] }, { forecast: null });
  assert.equal(view.available, false);
  assert.match(view.notice, /Standort/);
  // Kopf und Zeilen stehen mit „—" da, damit das Nachladen sie später füllen kann.
  assert.equal(view.head.title, 'Jetzt');
  assert.deepEqual(view.fields.map((field) => field.display), ['—', '—']);

  // Ein Tag außerhalb des Prognosezeitraums sagt das ausdrücklich.
  const zuWeit = readWeatherWidget({ day: '6', fields: ['temperature'] }, { forecast });
  assert.equal(zuWeit.available, false);
  assert.match(zuWeit.notice, /keine Prognose/);
});

test('Der Anzeigename nennt den gewählten Tag', () => {
  assert.equal(weatherWidgetLabel({ day: 'current' }), 'Wetter');
  assert.equal(weatherWidgetLabel({ day: '1' }), 'Wetter – Morgen');
  assert.equal(weatherWidgetLabel({ day: '4' }), 'Wetter – In 4 Tagen');
});

// ── Markup ─────────────────────────────────────────────────────────────────

function baseData(extra = {}) {
  return {
    tabs: [{ id: 1, title: 'Übersicht', ungrouped: [], groups: [] }],
    groupsForSelect: [],
    groupWidths: [{ value: 'full', label: 'Voll' }],
    switchTargets: [],
    infoFields: [],
    systemInfo: {},
    weatherFields: WEATHER_FIELDS,
    weatherDayOptions: WEATHER_DAY_OPTIONS,
    ...extra,
  };
}

function renderWithWidget(config, viewOptions = { forecast, pvForecast }) {
  const weather = normalizeWeatherConfig(config);
  return renderDashboard(baseData({
    tabs: [{
      id: 1,
      title: 'Übersicht',
      ungrouped: [{
        id: 12,
        type: 'weather',
        groupId: null,
        weather,
        label: weatherWidgetLabel(weather),
        weatherView: readWeatherWidget(weather, viewOptions),
      }],
      groups: [],
    }],
  }));
}

test('Die Kachel zeigt Kopfzeile und die gewählten Werte mit Nachlade-Marken', () => {
  const html = renderWithWidget({ day: '1', fields: ['temperature', 'uvIndex', 'pvYield'] });

  assert.match(html, /widget-card--weather" data-id="12" data-type="weather"/);
  assert.match(html, /id="weather-tile-12"/);
  assert.match(html, /data-weather="title">Morgen</);
  assert.match(html, /data-weather="value">20 \/ 11 °C</);
  // Jede Wertzeile trägt ihren Schlüssel und eigene Marken für das Nachladen.
  assert.match(html, /data-weather-field="uvIndex"/);
  assert.match(html, /data-weather-display>2,1</);
  assert.match(html, /data-weather-hint[^>]*>niedrig</);
  assert.match(html, /data-weather-field="pvYield"[\s\S]*?data-weather-display>9,40 kWh</);
  // Genau die gewählten drei Zeilen, keine weiteren.
  assert.equal((html.match(/class="weather-value[^"]*" data-weather-field=/g) || []).length, 3);
  // Ohne Störung bleibt der Hinweis verborgen.
  assert.match(html, /data-weather="notice" hidden></);
});

test('Fehlt die Prognose, trägt die Kachel den Hinweis sichtbar', () => {
  const html = renderWithWidget({ day: 'current', fields: ['temperature'] }, { forecast: null });
  assert.match(html, /class="weather-notice" data-weather="notice">Keine Wetterprognose/);
  assert.match(html, /data-weather-display>—</);
});

test('Der Dialog bietet Anzeigewahl und Häkchen je Messgröße', () => {
  const html = renderDashboard(baseData());
  assert.match(html, /<div class="tab-panel" data-panel="weather" hidden>/);
  assert.match(html, /id="widgetWeatherDay" name="weatherDay" onchange="syncWeatherFieldChoices\(\)"/);
  assert.match(html, /<option value="current">Aktuelles Wetter<\/option>/);
  assert.match(html, /<option value="1">Morgen<\/option>/);
  // Jede Größe steht als Häkchen mit ihren Anzeigearten in der Liste.
  assert.match(html, /data-weather-check="uvIndex" data-scopes="current day"/);
  assert.match(html, /data-weather-check="sunrise" data-scopes="day"/);
  assert.match(html, /name="weatherFields" value="temperature"/);
  assert.equal(
    (html.match(/name="weatherFields" value="/g) || []).length,
    WEATHER_FIELDS.length,
    'jede Größe genau einmal'
  );
  // Der Typ-Umschalter kennt die Kachel.
  assert.match(html, /data-tab="weather" onclick="setWidgetType\('weather'\)">Wetter</);
});

test('Das Stylesheet skaliert die Kachel nach ihrer eigenen Breite', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Voll­breite in der Gruppe plus eigener Größen-Container.
  assert.match(css, /\.widget-card--weather\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*container-type:\s*inline-size;/);
  // Die Umbrüche hängen am Container, nicht am Fenster.
  assert.match(css, /@container weather \(max-width: 300px\)/);
  assert.match(css, /@container weather \(min-width: 460px\)/);
  assert.match(css, /@container weather \(min-width: 560px\)/);
  // Das Werteraster füllt die verfügbare Breite selbstständig.
  assert.match(css, /\.weather-values\s*\{[^}]*repeat\(auto-fit, minmax\(132px, 1fr\)\)/);
  // Häkchen, die zur gewählten Anzeigeart nicht passen, verschwinden wirklich:
  // das display:flex der Zeile wäre sonst stärker als das [hidden] des Browsers.
  assert.match(css, /\.info-check\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

// ── Route ──────────────────────────────────────────────────────────────────

let db;
let server;
let baseUrl;

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await new Promise((resolve) =>
    saveMqttConfig(db, { host: 'localhost', port: 1883, latitude: LATITUDE, longitude: LONGITUDE }, resolve));
  // Prognose-Cache füllen: die Route liest ausschließlich den Cache.
  forecastModule.resetForTests({ latitude: LATITUDE, longitude: LONGITUDE, data: forecast });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(dashboardRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await new Promise((resolve) => db.close(resolve));
  forecastModule.resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Ein Wetter-Widget lässt sich anlegen und übersteht das Neuladen', async () => {
  const created = await widgetsRepo.createWidget(db, {
    type: 'weather',
    weatherDay: '1',
    weatherFields: ['temperature', 'precipitationProbability', 'sunrise'],
  });
  assert.equal(created.type, 'weather');
  assert.deepEqual(created.weather, {
    day: '1',
    fields: ['temperature', 'precipitationProbability', 'sunrise'],
  });

  const reloaded = await widgetsRepo.getWidget(db, created.id);
  assert.deepEqual(reloaded.weather, created.weather);

  // Ändern über den Dialog (Tageswahl + Häkchen) ersetzt die Auswahl.
  const updated = await widgetsRepo.updateWidget(db, created.id, {
    type: 'weather',
    weatherDay: 'current',
    weatherFields: ['temperature', 'visibility'],
  });
  assert.deepEqual(updated.weather, { day: 'current', fields: ['temperature', 'visibility'] });
});

test('Das Dashboard rendert die Kachel aus dem Prognose-Cache', async () => {
  const widget = await widgetsRepo.createWidget(db, {
    type: 'weather',
    weatherDay: '0',
    weatherFields: ['temperature', 'uvIndex'],
  });
  const response = await fetch(`${baseUrl}/dashboard`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`id="weather-tile-${widget.id}"`));
  assert.match(html, /data-weather="title">Heute</);
  // Höchst-/Tiefstwert des ersten Tages aus der Prognose.
  assert.match(html, /data-weather="value">24 \/ 13 °C</);
});

test('Das Nachladen liefert Werte je Wetter-Kachel', async () => {
  const response = await fetch(`${baseUrl}/dashboard/data`, { headers: { Accept: 'application/json' } });
  const data = await response.json();
  assert.ok(Array.isArray(data.weather));
  assert.ok(data.weather.length >= 1);
  const entry = data.weather.find((item) => item.view && item.view.head.title === 'Heute');
  assert.ok(entry, 'die Kachel von heute ist dabei');
  assert.equal(entry.view.available, true);
  const uv = entry.view.fields.find((field) => field.key === 'uvIndex');
  assert.equal(uv.display, '5,4');
  assert.equal(uv.hint, 'mäßig');
});
