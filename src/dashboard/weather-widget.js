'use strict';

// Wetter-Widget des Dashboards. Es zeigt entweder die **aktuelle Lage** oder
// **einen Prognosetag** aus der bestehenden Wetterprognose (`src/wetter/`) —
// welche Messgrößen dabei erscheinen, wählt der Nutzer im Widget-Dialog per
// Häkchen.
//
// Abgrenzung: Dieses Modul beschafft **keine** Daten. Es bekommt die bereits
// normalisierte Prognose (`getWeatherForecast`) und formt daraus die
// darzustellenden Zeilen. So teilen sich Seite „Wetterprognose" und Dashboard
// dieselbe Quelle, denselben Cache und dieselbe Fachlogik.
//
// Die Werte werden hier fertig formatiert (`display`), damit die Kachel beim
// Seitenaufbau **und** beim periodischen Nachladen (`/dashboard/data`) exakt
// dieselben Zeichenketten zeigt — der Browser rechnet nichts nach.

const { windDirectionArrow, beaufort, uvLevel } = require('../wetter/codes');
const { FORECAST_DAYS } = require('../wetter/forecast');

// Auswahl „Was zeigt die Kachel?". `current` ist die aktuelle Lage, sonst der
// Tagesindex der Prognose (0 = heute). Die Bezeichnungen sind bewusst relativ
// (nicht der Wochentag), damit die Auswahl dauerhaft gültig bleibt.
const DAY_OPTION_LABELS = ['Heute', 'Morgen', 'Übermorgen'];

function dayOptionLabel(index) {
  return index < DAY_OPTION_LABELS.length ? DAY_OPTION_LABELS[index] : `In ${index} Tagen`;
}

const WEATHER_DAY_OPTIONS = [{ key: 'current', label: 'Aktuelles Wetter' }].concat(
  Array.from({ length: FORECAST_DAYS }, (_, index) => ({
    key: String(index),
    label: dayOptionLabel(index),
  }))
);

const DEFAULT_DAY = 'current';

function formatNumber(raw, digits, unit) {
  const number = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(number)) return unit ? `— ${unit}` : '—';
  const formatted = number.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatText(raw) {
  return raw == null || raw === '' ? '—' : String(raw);
}

function windHint(kmh) {
  const stufe = beaufort(kmh);
  return stufe == null ? '' : `${stufe} Bft`;
}

function windText(degrees, directionText) {
  if (degrees == null && !directionText) return '—';
  const arrow = windDirectionArrow(degrees);
  return `${arrow ? `${arrow} ` : ''}${directionText || formatNumber(degrees, 0, '°')}`;
}

// Feldkatalog. Reihenfolge = Anzeigereihenfolge in der Kachel und im Dialog.
//
//   scopes  – in welchen Anzeigearten das Feld überhaupt existiert. Die
//             Kachel und der Dialog blenden unpassende Felder aus, statt sie
//             leer anzuzeigen.
//   value   – liefert { display, hint?, tone? } aus der jeweiligen Quelle.
//             `current` bekommt die aktuelle Lage, `day` den Prognosetag.
//
// Mehrere Größen tragen im Tagesmodus eine andere Bezeichnung (aus „Wind" wird
// „Wind max."); dafür gibt es `dayLabel`.
const WEATHER_FIELDS = [
  {
    key: 'temperature',
    label: 'Temperatur',
    dayLabel: 'Höchst-/Tiefstwert',
    icon: '🌡️',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.temperature, 1, '°C') }),
    day: (d) => ({
      display: `${formatNumber(d.temperatureMax, 1, '')} / ${formatNumber(d.temperatureMin, 1, '°C')}`,
    }),
  },
  {
    key: 'apparent',
    label: 'Gefühlt',
    dayLabel: 'Gefühlt max./min.',
    icon: '🤗',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.apparentTemperature, 1, '°C') }),
    day: (d) => ({
      display: `${formatNumber(d.apparentMax, 1, '')} / ${formatNumber(d.apparentMin, 1, '°C')}`,
    }),
  },
  {
    key: 'precipitationProbability',
    label: 'Regenwahrscheinlichkeit',
    icon: '🎲',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.precipitationProbability, 0, '%') }),
  },
  {
    key: 'precipitation',
    label: 'Niederschlag',
    dayLabel: 'Niederschlag gesamt',
    icon: '🌧️',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.precipitation, 1, 'mm') }),
    day: (d) => ({ display: formatNumber(d.precipitationSum, 1, 'mm') }),
  },
  {
    key: 'rain',
    label: 'davon Regen',
    icon: '💧',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.rainSum, 1, 'mm') }),
  },
  {
    key: 'snowfall',
    label: 'davon Schnee',
    icon: '❄️',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.snowfallSum, 1, 'cm') }),
  },
  {
    key: 'precipitationHours',
    label: 'Niederschlagsdauer',
    icon: '⏱️',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.precipitationHours, 0, 'h') }),
  },
  {
    key: 'windSpeed',
    label: 'Wind',
    dayLabel: 'Wind max.',
    icon: '💨',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.windSpeed, 0, 'km/h'), hint: windHint(c.windSpeed) }),
    day: (d) => ({ display: formatNumber(d.windSpeedMax, 0, 'km/h'), hint: windHint(d.windSpeedMax) }),
  },
  {
    key: 'windGusts',
    label: 'Böen',
    icon: '🌬️',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.windGusts, 0, 'km/h') }),
    day: (d) => ({ display: formatNumber(d.windGustsMax, 0, 'km/h') }),
  },
  {
    key: 'windDirection',
    label: 'Windrichtung',
    icon: '🧭',
    scopes: ['current', 'day'],
    current: (c) => ({ display: windText(c.windDirection, c.windDirectionText) }),
    day: (d) => ({ display: windText(d.windDirection, d.windDirectionText) }),
  },
  {
    key: 'humidity',
    label: 'Luftfeuchte',
    dayLabel: 'Luftfeuchte (Mittel)',
    icon: '💧',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.humidity, 0, '%') }),
    day: (d) => ({ display: formatNumber(d.humidityAvg, 0, '%') }),
  },
  {
    key: 'dewPoint',
    label: 'Taupunkt',
    icon: '💦',
    scopes: ['current'],
    current: (c) => ({ display: formatNumber(c.dewPoint, 1, '°C') }),
  },
  {
    key: 'pressure',
    label: 'Luftdruck',
    dayLabel: 'Luftdruck (Mittel)',
    icon: '🧭',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.pressure, 0, 'hPa') }),
    day: (d) => ({ display: formatNumber(d.pressureAvg, 0, 'hPa') }),
  },
  {
    key: 'cloudCover',
    label: 'Bewölkung',
    dayLabel: 'Bewölkung (Mittel)',
    icon: '☁️',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.cloudCover, 0, '%') }),
    day: (d) => ({ display: formatNumber(d.cloudCoverAvg, 0, '%') }),
  },
  {
    key: 'visibility',
    label: 'Sichtweite',
    icon: '👁️',
    scopes: ['current'],
    // Open-Meteo liefert Meter; angezeigt werden Kilometer.
    current: (c) => ({
      display: formatNumber(c.visibility == null ? null : c.visibility / 1000, 1, 'km'),
    }),
  },
  {
    key: 'uvIndex',
    label: 'UV-Index',
    dayLabel: 'UV-Index max.',
    icon: '🕶️',
    scopes: ['current', 'day'],
    current: (c) => {
      const uv = uvLevel(c.uvIndex);
      return { display: formatNumber(c.uvIndex, 1, ''), hint: uv.label, tone: uv.css };
    },
    day: (d) => {
      const uv = uvLevel(d.uvIndexMax);
      return { display: formatNumber(d.uvIndexMax, 1, ''), hint: uv.label, tone: uv.css };
    },
  },
  {
    key: 'radiation',
    label: 'Sonnenintensität',
    dayLabel: 'Sonnenintensität max.',
    icon: '🔆',
    scopes: ['current', 'day'],
    current: (c) => ({ display: formatNumber(c.radiation, 0, 'W/m²') }),
    day: (d) => ({ display: formatNumber(d.radiationMax, 0, 'W/m²') }),
  },
  {
    key: 'radiationSum',
    label: 'Einstrahlung',
    icon: '🔆',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.radiationSum, 2, 'kWh/m²') }),
  },
  {
    key: 'sunshine',
    label: 'Sonnenschein',
    icon: '🌞',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.sunshineHours, 1, 'h') }),
  },
  {
    key: 'daylight',
    label: 'Tageslicht',
    icon: '🌓',
    scopes: ['day'],
    day: (d) => ({ display: formatNumber(d.daylightHours, 1, 'h') }),
  },
  {
    key: 'sunrise',
    label: 'Sonnenaufgang',
    icon: '🌅',
    scopes: ['day'],
    day: (d) => ({ display: formatText(d.sunrise) }),
  },
  {
    key: 'sunset',
    label: 'Sonnenuntergang',
    icon: '🌇',
    scopes: ['day'],
    day: (d) => ({ display: formatText(d.sunset) }),
  },
  {
    // Erwarteter PV-Ertrag aus der bestehenden PV-Prognose. Er kommt nicht aus
    // der Wetterprognose, sondern über den Tagesschlüssel zugeordnet — ohne
    // Anlagen oder ohne Prognose bleibt die Zeile leer statt zu fehlen.
    key: 'pvYield',
    label: 'PV-Ertrag erwartet',
    icon: '⚡',
    scopes: ['day'],
    needsPv: true,
    day: (d, ctx) => ({ display: ctx.pvDisplay || '—' }),
  },
];

const WEATHER_FIELD_KEYS = WEATHER_FIELDS.map((field) => field.key);
const FIELD_BY_KEY = new Map(WEATHER_FIELDS.map((field) => [field.key, field]));

// Standardauswahl: die Größen, die eine Wetterlage zuerst beschreiben. Sie gilt
// für neue Kacheln und immer dann, wenn eine gespeicherte Auswahl leer wäre.
const DEFAULT_WEATHER_FIELDS = [
  'temperature', 'apparent', 'precipitationProbability', 'precipitation',
  'windSpeed', 'humidity', 'uvIndex', 'sunrise', 'sunset',
];

// Braucht die Kachel die PV-Prognose? Nur dann lädt die Dashboard-Route sie —
// der Seitenaufbau soll für alle anderen Kacheln nichts zusätzlich tun.
function usesPvYield(config) {
  const fields = (config && config.fields) || [];
  return fields.some((key) => {
    const field = FIELD_BY_KEY.get(key);
    return !!(field && field.needsPv);
  });
}

// Nur gültige, deduplizierte Feldschlüssel in Katalog-Reihenfolge.
function sanitizeWeatherFields(fields) {
  if (!Array.isArray(fields)) return DEFAULT_WEATHER_FIELDS.slice();
  const wanted = new Set(fields.map(String));
  const picked = WEATHER_FIELD_KEYS.filter((key) => wanted.has(key));
  return picked.length ? picked : DEFAULT_WEATHER_FIELDS.slice();
}

function normalizeDay(value) {
  const day = String(value == null ? '' : value).trim().toLowerCase();
  if (day === 'current' || day === '') return day === '' ? DEFAULT_DAY : 'current';
  const index = Number(day);
  if (!Number.isInteger(index) || index < 0 || index >= FORECAST_DAYS) return DEFAULT_DAY;
  return String(index);
}

function normalizeWeatherConfig(input = {}) {
  return {
    day: normalizeDay(input.day),
    fields: sanitizeWeatherFields(input.fields),
  };
}

// Nur die Felder, die es in der gewählten Anzeigeart überhaupt gibt.
function fieldsForScope(scope) {
  return WEATHER_FIELDS.filter((field) => field.scopes.includes(scope));
}

function scopeOf(config) {
  return config && config.day !== 'current' ? 'day' : 'current';
}

// Kopfzeile der Kachel: Symbol, Bezeichnung des Zeitpunkts, Wetterlage und der
// Leitwert (jetzt die Temperatur, am Prognosetag Höchst-/Tiefstwert). Sie ist
// nicht abwählbar — ohne sie wüsste niemand, worauf sich die Werte beziehen.
function buildHead(config, source) {
  if (scopeOf(config) === 'current') {
    return {
      icon: source.icon || '🌡️',
      title: 'Jetzt',
      subtitle: source.clock ? `${source.clock} Uhr` : '',
      label: formatText(source.label),
      value: formatNumber(source.temperature, 1, '°C'),
    };
  }
  return {
    icon: source.icon || '🌡️',
    title: source.name || source.weekday || 'Prognose',
    subtitle: source.date ? `${source.weekday}, ${source.date}` : '',
    label: formatText(source.label),
    value: `${formatNumber(source.temperatureMax, 0, '')} / ${formatNumber(source.temperatureMin, 0, '°C')}`,
  };
}

// Zustand einer Wetter-Kachel ermitteln.
//
// `forecast` ist die normalisierte Prognose (oder null), `pvForecast` die
// bestehende PV-Prognose (oder null). Fehlt die Wetterprognose, trägt das
// Ergebnis `available: false` samt Hinweistext — die Kachel bleibt sichtbar und
// erklärt, was fehlt, statt leer dazustehen.
function readWeatherWidget(config, { forecast = null, pvForecast = null } = {}) {
  const normalized = normalizeWeatherConfig(config || {});
  const scope = scopeOf(normalized);
  const days = forecast && Array.isArray(forecast.days) ? forecast.days : [];
  const source = scope === 'current'
    ? (forecast ? forecast.current : null)
    : days[Number(normalized.day)] || null;

  // Ohne Quelle bleibt die Kachel formgleich: Kopf und alle gewählten Zeilen
  // stehen mit „—" da und tragen den Hinweis. Nur so kann das periodische
  // Nachladen (/dashboard/data) sie später ohne Seitenneuaufbau füllen.
  if (!source) {
    const option = WEATHER_DAY_OPTIONS.find((entry) => entry.key === normalized.day);
    return {
      available: false,
      day: normalized.day,
      notice: forecast
        ? 'Für diesen Tag liegt keine Prognose vor.'
        : 'Keine Wetterprognose verfügbar — bitte Standort unter Einstellungen hinterlegen.',
      head: {
        icon: '🌡️',
        title: normalized.day === 'current' ? 'Jetzt' : (option ? option.label : 'Prognose'),
        subtitle: '',
        label: '—',
        value: '—',
      },
      fields: placeholderFields(normalized, scope),
    };
  }

  const pvDisplay = pvDisplayFor(pvForecast, source.dateKey);
  const selected = new Set(normalized.fields);
  const fields = fieldsForScope(scope)
    .filter((field) => selected.has(field.key))
    .map((field) => {
      const value = field[scope](source, { pvDisplay }) || {};
      return {
        key: field.key,
        label: (scope === 'day' && field.dayLabel) || field.label,
        icon: field.icon,
        display: value.display == null ? '—' : value.display,
        hint: value.hint || '',
        tone: value.tone || '',
      };
    });

  return {
    available: true,
    day: normalized.day,
    notice: '',
    head: buildHead(normalized, source),
    fields,
  };
}

// Gewählte Felder ohne Werte — gleiche Reihenfolge und Beschriftung wie im
// Normalfall, damit die Kachel ihre Form behält.
function placeholderFields(config, scope) {
  const selected = new Set(config.fields);
  return fieldsForScope(scope)
    .filter((field) => selected.has(field.key))
    .map((field) => ({
      key: field.key,
      label: (scope === 'day' && field.dayLabel) || field.label,
      icon: field.icon,
      display: '—',
      hint: '',
      tone: '',
    }));
}

function pvDisplayFor(pvForecast, dateKey) {
  const days = pvForecast && Array.isArray(pvForecast.days) ? pvForecast.days : [];
  if (!dateKey) return '';
  const match = days.find((day) => day && day.dateKey === dateKey);
  if (!match || match.totalKwh == null) return '';
  return match.totalFormatted || formatNumber(match.totalKwh, 2, 'kWh');
}

// Anzeigename einer Kachel (Bearbeiten-Leiste, Löschdialog).
function weatherWidgetLabel(config) {
  const normalized = normalizeWeatherConfig(config || {});
  const option = WEATHER_DAY_OPTIONS.find((entry) => entry.key === normalized.day);
  return option && option.key !== 'current' ? `Wetter – ${option.label}` : 'Wetter';
}

module.exports = {
  WEATHER_FIELDS,
  WEATHER_FIELD_KEYS,
  DEFAULT_WEATHER_FIELDS,
  WEATHER_DAY_OPTIONS,
  normalizeWeatherConfig,
  sanitizeWeatherFields,
  readWeatherWidget,
  weatherWidgetLabel,
  usesPvYield,
  fieldsForScope,
};
