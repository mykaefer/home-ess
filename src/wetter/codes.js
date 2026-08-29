'use strict';

// Übersetzung der WMO-Wettercodes (Open-Meteo `weather_code`) in deutschen
// Klartext und ein Piktogramm. Open-Meteo liefert ausschließlich die Zahl —
// Beschriftung und Symbol entstehen hier, damit Seite und States denselben
// Wortlaut verwenden.
//
// `icon` ist bewusst ein Emoji: es braucht keine Bilddateien, skaliert mit der
// Schriftgröße und bleibt im hellen wie im dunklen Thema lesbar.

// Je Code: Text + Tag-Symbol. `night` überschreibt das Symbol nach
// Sonnenuntergang (nur dort sinnvoll, wo die Sonne im Bild steckt).
const CODES = {
  0:  { label: 'Klar', icon: '☀️', night: '🌙' },
  1:  { label: 'Überwiegend klar', icon: '🌤️', night: '🌙' },
  2:  { label: 'Teilweise bewölkt', icon: '⛅', night: '☁️' },
  3:  { label: 'Bedeckt', icon: '☁️' },
  45: { label: 'Nebel', icon: '🌫️' },
  48: { label: 'Reifnebel', icon: '🌫️' },
  51: { label: 'Leichter Sprühregen', icon: '🌦️' },
  53: { label: 'Sprühregen', icon: '🌦️' },
  55: { label: 'Starker Sprühregen', icon: '🌧️' },
  56: { label: 'Leichter gefrierender Sprühregen', icon: '🌨️' },
  57: { label: 'Gefrierender Sprühregen', icon: '🌨️' },
  61: { label: 'Leichter Regen', icon: '🌦️' },
  63: { label: 'Regen', icon: '🌧️' },
  65: { label: 'Starker Regen', icon: '🌧️' },
  66: { label: 'Leichter gefrierender Regen', icon: '🌨️' },
  67: { label: 'Gefrierender Regen', icon: '🌨️' },
  71: { label: 'Leichter Schneefall', icon: '🌨️' },
  73: { label: 'Schneefall', icon: '❄️' },
  75: { label: 'Starker Schneefall', icon: '❄️' },
  77: { label: 'Schneegriesel', icon: '🌨️' },
  80: { label: 'Leichte Regenschauer', icon: '🌦️' },
  81: { label: 'Regenschauer', icon: '🌧️' },
  82: { label: 'Heftige Regenschauer', icon: '⛈️' },
  85: { label: 'Leichte Schneeschauer', icon: '🌨️' },
  86: { label: 'Starke Schneeschauer', icon: '❄️' },
  95: { label: 'Gewitter', icon: '⛈️' },
  96: { label: 'Gewitter mit leichtem Hagel', icon: '⛈️' },
  99: { label: 'Gewitter mit schwerem Hagel', icon: '⛈️' },
};

const UNKNOWN = { label: 'Unbekannt', icon: '❔' };

// Zahl aus einem Rohwert. Fehlende Werte (null/undefined/leer) ergeben null und
// nicht 0 — sonst würde ein fehlender Wettercode als „Klar" und eine fehlende
// Windrichtung als „Nord" gelesen.
function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Wetterlage zu einem Code. `isDay` false wählt – wo vorhanden – das
// Nachtsymbol. Unbekannte oder fehlende Codes liefern einen neutralen Eintrag
// mit `code: null`, damit die Seite nichts Falsches behauptet.
function describeWeather(code, isDay = true) {
  const key = toNumber(code);
  const entry = key == null ? null : CODES[key];
  if (!entry) return { code: null, label: UNKNOWN.label, icon: UNKNOWN.icon };
  return {
    code: key,
    label: entry.label,
    icon: !isDay && entry.night ? entry.night : entry.icon,
  };
}

// Die 16 Himmelsrichtungen; 0° = Nord, im Uhrzeigersinn.
const COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function windDirectionText(degrees) {
  const value = toNumber(degrees);
  if (value == null) return '';
  const index = Math.round(((value % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[index];
}

// Pfeil in Windrichtung (zeigt dorthin, wohin der Wind weht). Die Emoji-Pfeile
// decken nur acht Richtungen ab — auf diese wird gerundet.
const ARROWS = ['⬇️', '↙️', '⬅️', '↖️', '⬆️', '↗️', '➡️', '↘️'];

function windDirectionArrow(degrees) {
  const value = toNumber(degrees);
  if (value == null) return '';
  const index = Math.round(((value % 360) + 360) % 360 / 45) % 8;
  return ARROWS[index];
}

// Beaufort-Stufe aus km/h — als kurze Einordnung neben dem Zahlenwert.
const BEAUFORT_LIMITS = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];

function beaufort(kmh) {
  const value = toNumber(kmh);
  if (value == null) return null;
  for (let i = 0; i < BEAUFORT_LIMITS.length; i += 1) {
    if (value < BEAUFORT_LIMITS[i]) return i;
  }
  return 12;
}

// UV-Index in die amtliche Belastungsstufe übersetzen (WHO-Skala).
function uvLevel(index) {
  const value = toNumber(index);
  if (value == null) return { label: '', css: '' };
  if (value < 3) return { label: 'niedrig', css: 'good' };
  if (value < 6) return { label: 'mäßig', css: 'good' };
  if (value < 8) return { label: 'hoch', css: 'warn' };
  if (value < 11) return { label: 'sehr hoch', css: 'warn' };
  return { label: 'extrem', css: 'bad' };
}

module.exports = { describeWeather, windDirectionText, windDirectionArrow, beaufort, uvLevel };
