'use strict';

// System-States der Gruppe „Wetter". Die Einträge entstehen aus der
// normalisierten Open-Meteo-Prognose (`forecast.js`) und folgen dem Aufbau der
// übrigen Systemwerte: id (stabiler Schlüssel), label (Anzeigename), value
// (Rohwert zum Publizieren), display (formatierte Anzeige), unit und category.
//
// Die Liste wird immer vollständig gebaut — auch ohne Prognose. Dann bleiben
// alle Werte leer (null), die States sind aber im Katalog vorhanden und können
// in Bedingungen, Outputs und Widgets ausgewählt werden.

const { uvLevel } = require('./codes');
const { formatFetchedAt } = require('./forecast');

// Gruppen innerhalb von „Wetter". Die Namen sind so gewählt, dass die
// alphanumerische Sortierung des States-Baums die zeitliche Reihenfolge ergibt.
const GROUP_CURRENT = 'Wetter / Aktuell';
const GROUP_LOCATION = 'Wetter / Standort';
const GROUP_FURTHER = 'Wetter / Weitere Tage';

// Die drei ausführlichen Tage: id-Teil, Gruppenname und Wortbestandteil des
// Anzeigenamens.
const DETAIL_DAYS = [
  { key: 'tag1', group: 'Wetter / Tag 1 – Heute', name: 'heute' },
  { key: 'tag2', group: 'Wetter / Tag 2 – Morgen', name: 'morgen' },
  { key: 'tag3', group: 'Wetter / Tag 3 – Übermorgen', name: 'übermorgen' },
];

// Kurztage 4–7 (gemeinsame Gruppe, nur die wichtigsten Größen).
const FURTHER_DAYS = [4, 5, 6, 7];

const numberFormat = (digits) => new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Zahlwert mit Einheit. `decimals` bestimmt Rundung und Anzeige.
function value(id, label, category, raw, unit, decimals = 1) {
  const rounded = raw == null || !Number.isFinite(Number(raw)) ? null : roundTo(Number(raw), decimals);
  const suffix = unit ? ` ${unit}` : '';
  return {
    id,
    label,
    category,
    unit: unit || '',
    value: rounded,
    display: rounded == null ? `—${suffix}` : `${numberFormat(decimals).format(rounded)}${suffix}`,
  };
}

function textValue(id, label, category, raw) {
  const clean = raw == null || raw === '' ? '' : String(raw);
  return { id, label, category, unit: '', value: clean, display: clean || '—' };
}

function boolValue(id, label, category, raw) {
  const flag = raw == null ? null : !!raw;
  return {
    id, label, category, unit: '',
    value: flag,
    display: flag == null ? '—' : (flag ? 'ja' : 'nein'),
  };
}

// Sichtweite kommt von Open-Meteo in Metern, angezeigt wird sie in Kilometern.
function metresToKm(metres) {
  return metres == null ? null : metres / 1000;
}

function currentEntries(current) {
  const now = current || {};
  const group = GROUP_CURRENT;
  const label = (name) => `Wetter aktuell – ${name}`;
  return [
    textValue('wetter.aktuell.zustand', label('Wetterlage'), group, now.label),
    value('wetter.aktuell.zustandCode', label('Wettercode (WMO)'), group, now.code, '', 0),
    textValue('wetter.aktuell.symbol', label('Piktogramm'), group, now.icon),
    value('wetter.aktuell.temperatur', label('Temperatur'), group, now.temperature, '°C'),
    value('wetter.aktuell.gefuehlteTemperatur', label('Gefühlte Temperatur'), group, now.apparentTemperature, '°C'),
    value('wetter.aktuell.taupunkt', label('Taupunkt'), group, now.dewPoint, '°C'),
    value('wetter.aktuell.luftfeuchte', label('Luftfeuchte'), group, now.humidity, '%', 0),
    value('wetter.aktuell.luftdruck', label('Luftdruck'), group, now.pressure, 'hPa', 0),
    value('wetter.aktuell.bewoelkung', label('Bewölkung'), group, now.cloudCover, '%', 0),
    value('wetter.aktuell.niederschlag', label('Niederschlag'), group, now.precipitation, 'mm'),
    value('wetter.aktuell.regen', label('Regen'), group, now.rain, 'mm'),
    value('wetter.aktuell.schneefall', label('Schneefall'), group, now.snowfall, 'cm'),
    value('wetter.aktuell.windgeschwindigkeit', label('Windgeschwindigkeit'), group, now.windSpeed, 'km/h'),
    value('wetter.aktuell.windboeen', label('Windböen'), group, now.windGusts, 'km/h'),
    value('wetter.aktuell.windrichtung', label('Windrichtung'), group, now.windDirection, '°', 0),
    textValue('wetter.aktuell.windrichtungText', label('Windrichtung (Himmelsrichtung)'), group, now.windDirectionText),
    // Sonnenintensität der Prognose ist die Globalstrahlung in W/m². Sie ist
    // unabhängig von `sun.intensity.*`, das die reale PV-Leistung gegen den
    // Klarhimmel-Idealwert misst und nur für den Istzustand gilt.
    value('wetter.aktuell.sonnenintensitaet', label('Sonnenintensität (Globalstrahlung)'), group, now.radiation, 'W/m²', 0),
    value('wetter.aktuell.uvIndex', label('UV-Index'), group, now.uvIndex, '', 1),
    textValue('wetter.aktuell.uvStufe', label('UV-Belastungsstufe'), group, uvLevel(now.uvIndex).label),
    value('wetter.aktuell.sichtweite', label('Sichtweite'), group, metresToKm(now.visibility), 'km'),
    boolValue('wetter.aktuell.istTag', label('Tageslicht'), group, now.isDay == null ? null : now.isDay),
    textValue('wetter.aktuell.zeitpunkt', label('Zeitpunkt'), group, now.clock),
  ];
}

// Alle Größen eines ausführlich dargestellten Tages.
function detailDayEntries(day, { key, group, name }) {
  const info = day || {};
  const label = (title) => `Wetter ${name} – ${title}`;
  const id = (suffix) => `wetter.${key}.${suffix}`;
  return [
    textValue(id('zustand'), label('Wetterlage'), group, info.label),
    value(id('zustandCode'), label('Wettercode (WMO)'), group, info.code, '', 0),
    textValue(id('symbol'), label('Piktogramm'), group, info.icon),
    textValue(id('datum'), label('Datum'), group, info.date),
    textValue(id('wochentag'), label('Wochentag'), group, info.weekday),
    value(id('temperaturMax'), label('Höchsttemperatur'), group, info.temperatureMax, '°C'),
    value(id('temperaturMin'), label('Tiefsttemperatur'), group, info.temperatureMin, '°C'),
    value(id('gefuehltMax'), label('Gefühlt maximal'), group, info.apparentMax, '°C'),
    value(id('gefuehltMin'), label('Gefühlt minimal'), group, info.apparentMin, '°C'),
    value(id('niederschlagSumme'), label('Niederschlagsmenge'), group, info.precipitationSum, 'mm'),
    value(id('regenSumme'), label('Regenmenge'), group, info.rainSum, 'mm'),
    value(id('schneeSumme'), label('Schneemenge'), group, info.snowfallSum, 'cm'),
    value(id('niederschlagWahrscheinlichkeit'), label('Niederschlagswahrscheinlichkeit'), group, info.precipitationProbability, '%', 0),
    value(id('niederschlagStunden'), label('Niederschlagsstunden'), group, info.precipitationHours, 'h'),
    value(id('windMax'), label('Windgeschwindigkeit maximal'), group, info.windSpeedMax, 'km/h'),
    value(id('windboeenMax'), label('Windböen maximal'), group, info.windGustsMax, 'km/h'),
    value(id('windrichtung'), label('Windrichtung'), group, info.windDirection, '°', 0),
    textValue(id('windrichtungText'), label('Windrichtung (Himmelsrichtung)'), group, info.windDirectionText),
    value(id('sonnenintensitaetMax'), label('Sonnenintensität maximal'), group, info.radiationMax, 'W/m²', 0),
    value(id('einstrahlung'), label('Einstrahlung gesamt'), group, info.radiationSum, 'kWh/m²', 2),
    value(id('uvIndexMax'), label('UV-Index maximal'), group, info.uvIndexMax, '', 1),
    textValue(id('uvStufe'), label('UV-Belastungsstufe'), group, uvLevel(info.uvIndexMax).label),
    textValue(id('sonnenaufgang'), label('Sonnenaufgang'), group, info.sunrise),
    textValue(id('sonnenuntergang'), label('Sonnenuntergang'), group, info.sunset),
    value(id('tageslichtDauer'), label('Tageslichtdauer'), group, info.daylightHours, 'h'),
    value(id('sonnenscheinDauer'), label('Sonnenscheindauer'), group, info.sunshineHours, 'h'),
    value(id('bewoelkung'), label('Bewölkung (Tagesmittel)'), group, info.cloudCoverAvg, '%', 0),
    value(id('luftfeuchte'), label('Luftfeuchte (Tagesmittel)'), group, info.humidityAvg, '%', 0),
    value(id('luftdruck'), label('Luftdruck (Tagesmittel)'), group, info.pressureAvg, 'hPa', 0),
  ];
}

// Kurztage: nur die Größen, die auch auf der Seite in der Kurzübersicht stehen.
function furtherDayEntries(day, dayNumber) {
  const info = day || {};
  const group = GROUP_FURTHER;
  const label = (title) => `Wetter Tag ${dayNumber} – ${title}`;
  const id = (suffix) => `wetter.tag${dayNumber}.${suffix}`;
  return [
    textValue(id('zustand'), label('Wetterlage'), group, info.label),
    value(id('zustandCode'), label('Wettercode (WMO)'), group, info.code, '', 0),
    textValue(id('symbol'), label('Piktogramm'), group, info.icon),
    textValue(id('datum'), label('Datum'), group, info.date),
    textValue(id('wochentag'), label('Wochentag'), group, info.weekday),
    value(id('temperaturMax'), label('Höchsttemperatur'), group, info.temperatureMax, '°C'),
    value(id('temperaturMin'), label('Tiefsttemperatur'), group, info.temperatureMin, '°C'),
    value(id('niederschlagSumme'), label('Niederschlagsmenge'), group, info.precipitationSum, 'mm'),
    value(id('niederschlagWahrscheinlichkeit'), label('Niederschlagswahrscheinlichkeit'), group, info.precipitationProbability, '%', 0),
    value(id('windMax'), label('Windgeschwindigkeit maximal'), group, info.windSpeedMax, 'km/h'),
    value(id('uvIndexMax'), label('UV-Index maximal'), group, info.uvIndexMax, '', 1),
  ];
}

// Standort- und Metadaten der Prognose. Breite/Länge sind die von Open-Meteo
// tatsächlich verwendeten Gitterkoordinaten (nächste Gitterzelle zur
// konfigurierten Position), nicht die Eingabe aus den Einstellungen.
function locationEntries(forecast) {
  const info = forecast || {};
  const group = GROUP_LOCATION;
  const label = (title) => `Wetter Standort – ${title}`;
  // Wie in der Oberfläche: korrigierte homeESS-Zeit, nicht die Systemzeit.
  const stand = formatFetchedAt(info.fetchedAt);
  return [
    value('wetter.standort.breite', label('Breitengrad'), group, info.latitude, '°', 4),
    value('wetter.standort.laenge', label('Längengrad'), group, info.longitude, '°', 4),
    value('wetter.standort.hoehe', label('Höhe über NN'), group, info.elevation, 'm', 0),
    textValue('wetter.standort.zeitzone', label('Zeitzone'), group, info.timezone),
    textValue('wetter.standort.stand', label('Stand der Prognose'), group, stand),
    boolValue('wetter.standort.verfuegbar', label('Prognose verfügbar'), group, !!(forecast && forecast.days && forecast.days.length)),
  ];
}

// Alle Wetter-States. `forecast` darf null sein (kein Standort hinterlegt oder
// noch kein Abruf erfolgt) — dann bleiben die Werte leer.
function buildWeatherValues(forecast) {
  const days = (forecast && Array.isArray(forecast.days)) ? forecast.days : [];
  const entries = [
    ...currentEntries(forecast ? forecast.current : null),
    ...locationEntries(forecast),
  ];
  DETAIL_DAYS.forEach((definition, index) => {
    entries.push(...detailDayEntries(days[index] || null, definition));
  });
  for (const dayNumber of FURTHER_DAYS) {
    entries.push(...furtherDayEntries(days[dayNumber - 1] || null, dayNumber));
  }
  return entries;
}

module.exports = { buildWeatherValues, DETAIL_DAYS, FURTHER_DAYS };
