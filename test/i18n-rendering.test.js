'use strict';

// Prüft die Zweisprachigkeit am fertig gerenderten HTML statt am Quelltext.
//
// Die Quelltextprüfung (i18n-coverage) findet Textknoten, Attribute und
// Stringliterale. Sie kann aber nicht sehen, was erst beim Rendern entsteht:
// eine Beschriftung, die mit einem Messwert in einem Textknoten zusammenfällt,
// oder ein Stringliteral, dessen Leerzeichen den Katalogtreffer verfehlt. Genau
// solche Fälle bleiben in der englischen Oberfläche deutsch.
//
// Deshalb wird hier je Seite echtes HTML erzeugt, auf Englisch übersetzt und
// nach deutschen Resten durchsucht. Kommentare der eingebetteten Browserskripte
// zählen nicht — sie sind kein Anzeigetext.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.HOME_ESS_LANGUAGE_DIR = process.env.HOME_ESS_LANGUAGE_DIR || '/nonexistent';
const i18n = require('../src/i18n');

const VIEWS = path.join(__dirname, '..', 'src', 'views');

// Eigennamen und Beispieldaten der Testeingabe.
const EXEMPT = new Set([
  'Copyright (C) 2026 Kevin Käfer |',
  'Copyright (C) 2026 Kevin Käfer | MyKaefer Apps',
  'Wohnzimmer', 'Tür', 'Fenster',
]);

const GERMAN_WORD = /\b(der|die|das|den|dem|des|ein|eine|einen|einem|einer|ist|sind|war|wird|werden|wurde|nicht|kein|keine|keinen|noch|schon|beim|vom|zum|zur|und|oder|mit|ohne|für|auf|aus|bei|von|im|am|als|auch|nur|sich|dass|wenn|sobald|damit|bitte|kann|können|darf|dürfen|muss|müssen|soll|sollen|hier|dann|jede|jeder|jedes|alle|allen|ihre|ihren|seine|seinen)\b/;

function looksGerman(text) {
  if (EXEMPT.has(text)) return false;
  if (!/[A-Za-zÄÖÜäöüß]{3,}/.test(text)) return false;
  return /[äöüßÄÖÜ]/.test(text) || GERMAN_WORD.test(text);
}

// Alles, was ein Besucher lesen kann: Textknoten, sichtbare Attribute und die
// Stringliterale der Browserskripte.
function visibleStrings(html) {
  const out = new Set();
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  for (const match of markup.matchAll(/>([^<>]+)</g)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (text) out.add(text);
  }
  for (const match of markup.matchAll(/(?:title|placeholder|aria-label|alt|value)="([^"]+)"/g)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (text) out.add(text);
  }
  for (const block of html.matchAll(/<script[\s\S]*?<\/script>/g)) {
    // Kommentare sind kein Anzeigetext; `https://` bleibt geschützt, weil davor
    // ein Doppelpunkt und kein Zeilenanfang steht.
    const code = block[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const match of code.matchAll(/'([^'\\\n]{4,300})'|"([^"\\\n]{4,300})"/g)) {
      const text = (match[1] ?? match[2]).trim();
      if (text) out.add(text);
    }
  }
  return out;
}

// Beispieldaten je Seite: gefüllt genug, damit auch Zustände und Kacheln
// gerendert werden.
const room = {
  id: 1, name: 'Wohnzimmer', targetTemp: 21, heatOffset: 0, coolOffset: 5, coolMinTemp: null,
  hysteresis: 0.5, sensorCount: 2, contactCount: 1, actionCount: 4, climateMode: 2, climateResetTime: '',
  hasCoolDevice: true, hasHeatDevice: true, centralAllowed: true, centralTemp: 4, heatPriority: 3,
  coolPriority: 4, heatCentralFallback: false, thermostatTopic: '', fanTopic: '', contactDelaySeconds: 60,
  lastError: '', state: { temperature: 20.5, heating: true, cooling: false, centralDemand: false,
    contactOpen: false, note: '', climateOverride: false, sensorCount: 2 },
};

const PAGES = [
  ['heizung.js', { rooms: [room], central: { enabled: true, mode: 'relais', pumpTopic: 'x' },
    centralState: { boilerOn: true, burnerOn: true, pumpOn: true, demandCount: 2, note: '',
      outdoorTemp: 5, flowTemp: 60, returnTemp: 45 },
    billing: { startedAt: Date.now(), days: 12, consumption: 120, startConsumption: 5, cost: 80,
      monthly: 6.7, previous: null, unit: 'l' } }],
  ['heizung-room.js', { room, sensors: [], contacts: [], central: { enabled: true },
    tree: { heat_on: [], heat_off: [], cool_on: [], cool_off: [] }, actions: [] }],
  ['heizung-zentrale.js', { config: { enabled: true, mode: 'relais', switchTopic: 'a', pumpTopic: 'b',
    flowTopic: 'c', returnTopic: 'd', outdoorTopic: '', burnerFeedbackTopic: '', pumpLeadSeconds: 30,
    pumpLagSeconds: 300, flowWindowSeconds: 120, flowDropDelta: 0.3, maxHoldMinutes: 0,
    consumptionPerHour: 1.2, unit: 'l', pricePerUnit: 1.1, sweepEnabled: false },
    state: { boilerOn: true, burnerOn: false, pumpOn: true, demandCount: 1, note: '', outdoorTemp: 5,
      flowTemp: 60, returnTemp: 45, runtimeTodayMs: 3600000, costToday: 1.5 }, runs: [] }],
  ['wetter.js', { weather: null }],
  ['login.js', {}],
  ['batterie.js', { config: { socTopic: 'a' }, data: { soc: 55, power: 500, voltage: 52, temperatur: 20 } }],
  ['pool.js', { config: {}, values: {} }],
  ['wallbox.js', { boxes: [], forecast: null }],
  ['grid-control.js', { config: {}, state: { inverterLoads: [100, 200, 300] },
    batteryConfig: { lowerVoltage: 44, upperVoltage: 58 }, log: { entries: [], page: 1, totalPages: 1 } }],
  ['schaltgruppen.js', { groups: [], actors: [] }],
  ['output.js', { outputs: [], values: [] }],
  ['states.js', { groups: [], values: [] }],
  ['custom-states.js', { tree: { folders: [], states: [] } }],
  ['conditions.js', { conditions: [], folders: [] }],
  ['heimkino.js', { rooms: [] }],
  ['messen-schalten.js', { actors: [], groups: [] }],
  ['stromverbrauch.js', { config: {}, values: {} }],
  ['energiefluss.js', { flow: null, exports: [] }],
  ['dashboard.js', { tabs: [], widgets: [] }],
  ['settings.js', { config: {}, users: [], modules: [], languages: [], dbConfig: {}, update: {} }],
  ['photovoltaik.js', {}],
  ['energie.js', { overview: {
    photovoltaik: { plantCount: 2, formatted: { current: '1 kW', today: '5 kWh', week: '30 kWh',
      year: '900 kWh', previousYear: '850 kWh' } },
    strom: { formatted: { eigenverbrauchPower: '500 W', netzbezugPower: '0 W',
      today: {}, week: {}, year: {} } },
    batterie: { configured: true, socPercent: 55, formatted: { soc: '55 %', minSoc: '20 %',
      power: '0 W', usable: '4 kWh', capacity: '10 kWh', voltage: '52 V', temperatur: '20 °C' } },
    prognose: { available: true, autark: true, status: { css: 'good', label: 'Gut versorgt', detail: 'ok' },
      formatted: { pvRest: '2 kWh', loadRest: '3 kWh', gridRest: '0 kWh', socEnd: '60 %' } },
    gridControl: { gridBySoc: true, gridByVoltage: false, gridByTemperature: false,
      gridByLoad: false, gridActual: true } } }],
  ['heimkino-room.js', { room: { id: 1, name: 'Kino', cinemaOn: false, stateTopic: 'a', remoteTopic: '' },
    tree: { on: [], off: [] }, actions: [] }],
  ['prognosis.js', { prognosis: { config: {}, model: {}, battery: {},
    simulation: { available: true, minSoc: 20, initialStored: 4, status: 'good',
      nextChargeStart: null, minimumReached: null,
      today: { dateKey: '2026-09-05', label: 'Heute', pvKwh: 12, loadKwh: 10, gridKwh: 0,
        surplusKwh: 2, batterySocEnd: 60, batteryFull: false, wallboxKwh: 0, functionKwh: 0,
        pvRestKwh: 3, loadRestKwh: 4, gridRestKwh: 0 },
      days: [{ dateKey: '2026-09-05', label: 'Heute', pvKwh: 12, loadKwh: 10, gridKwh: 0,
        surplusKwh: 2, batterySocEnd: 60, batteryFull: false, wallboxKwh: 0, functionKwh: 0 }] },
    hourProfile: [], heatingDemand: [],
    operating: { autark: false, autarkDaysCount: 0, autarkDaysYear: '', autarkDaysPreviousYear: '',
      autarkDaysPreviousYearCount: 0 } } }],
];

// Seiten, deren Modul mehrere Renderfunktionen ausliefert.
const NAMED_PAGES = [
  ['adapters.js', 'renderAdapters', { adapters: [], instances: [], statusById: new Map() }],
];

function renderAll() {
  return [
    ...PAGES.map(([file, input]) => [file, require(path.join(VIEWS, file))(input)]),
    ...NAMED_PAGES.map(([file, fn, input]) => [file, require(path.join(VIEWS, file))[fn](input)]),
  ];
}

// Die eingebetteten Browserskripte entstehen in Template-Literalen. Ein `\n` im
// Quelltext wird dabei schon beim Rendern zum echten Zeilenumbruch und zerreißt
// das Stringliteral, das im Browser stehen sollte — die ganze Seite bekommt dann
// ein Skript, das nicht mehr geparst wird, und keine ihrer Funktionen läuft
// mehr. Gegen Zeichen zu entkommen ist im Quelltext leicht zu übersehen, also
// wird hier jedes ausgelieferte Skript geparst.
test('Jedes eingebettete Browserskript der Seiten ist syntaktisch gültig', () => {
  const broken = [];
  for (const [file, html] of renderAll()) {
    for (const block of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      try { new Function(block[1]); } catch (error) { broken.push(`${file}: ${error.message}`); }
    }
  }
  assert.deepEqual(broken, [], `Diese Seiten liefern ein Skript aus, das der Browser nicht liest:\n${broken.join('\n')}`);
});

test('Die englische Oberfläche enthält keine deutschen Reste', async () => {
  i18n.scan();
  i18n.setTimezone('UTC');
  await i18n.select('en');

  const gaps = [];
  for (const [file, html] of renderAll()) {
    for (const text of visibleStrings(html)) {
      if (looksGerman(text)) gaps.push(`${file}: ${text}`);
    }
  }
  assert.deepEqual(gaps, [], `Auf Englisch bleiben diese Texte deutsch:\n${gaps.join('\n')}`);
});
