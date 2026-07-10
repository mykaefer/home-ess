'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleEnergiefluss } = require('../src/messen-schalten/energiefluss');

function tree(entries) {
  return new Map(entries.map(([id, v]) => [id, v]));
}

test('assembleEnergiefluss bündelt PV, Netz, Batterie, Eigenverbrauch und Gruppenbaum', () => {
  const snap = assembleEnergiefluss({
    pvValues: {
      plants: [
        { id: 1, name: 'Süd', current: 3000 },
        { id: 2, name: 'Ost', current: 1200 },
      ],
      totals: { current: 4200 },
    },
    stromValues: { eigenverbrauchPower: 2500, netzbezugPower: -700 }, // Einspeisung
    batteryData: { power: '-450', soc: '82' }, // entlädt
    batteryConfig: { powerTopic: 'bat.power', socTopic: 'bat.soc' },
    groups: [
      { id: 10, title: 'Haus', parentId: null, meterGroup: false },
      { id: 11, title: 'Küche', parentId: 10, meterGroup: false },
    ],
    groupTree: tree([
      [10, { gesamtW: 1800, meterGroup: false, hasChildren: true }],
      [11, { gesamtW: 400, meterGroup: false, hasChildren: false }],
    ]),
  });

  assert.equal(snap.pv.totalW, 4200);
  assert.equal(snap.pv.plants.length, 2);
  assert.equal(snap.pv.plants[0].powerW, 3000);
  assert.equal(snap.grid.powerW, -700); // negativ = Einspeisung
  assert.equal(snap.battery.present, true);
  assert.equal(snap.battery.powerW, -450); // Rohwert-String korrekt geparst
  assert.equal(snap.battery.soc, 82);
  assert.equal(snap.eigenverbrauch.powerW, 2500);

  // Ausgangsbaum: Haus mit Untergruppe Küche.
  assert.equal(snap.groups.length, 1);
  assert.equal(snap.groups[0].title, 'Haus');
  assert.equal(snap.groups[0].powerW, 1800);
  assert.equal(snap.groups[0].children.length, 1);
  assert.equal(snap.groups[0].children[0].title, 'Küche');
  assert.equal(snap.groups[0].children[0].powerW, 400);
});

test('assembleEnergiefluss: nur angehakte Untergruppen werden gezeichnet, Rest fällt in Sonstige', () => {
  // Haus (gesamt 1800) mit A (400, Haken AN) und B (250, Haken AUS).
  const snap = assembleEnergiefluss({
    stromValues: { eigenverbrauchPower: 2500, netzbezugPower: 0 },
    groups: [
      { id: 10, title: 'Haus', parentId: null, meterGroup: false, offsetTotalConsumption: true, color: '#123456' },
      { id: 11, title: 'A', parentId: 10, meterGroup: false, offsetTotalConsumption: true },
      { id: 12, title: 'B', parentId: 10, meterGroup: false, offsetTotalConsumption: false },
    ],
    groupTree: tree([
      [10, { gesamtW: 1800, meterGroup: false }],
      [11, { gesamtW: 400, meterGroup: false }],
      [12, { gesamtW: 250, meterGroup: false }],
    ]),
  });
  const haus = snap.groups[0];
  assert.equal(haus.color, '#123456');
  // Nur A ist gezeichnetes Kind; B fällt in die Sonstige des Hauses.
  assert.equal(haus.children.length, 1);
  assert.equal(haus.children[0].title, 'A');
  assert.equal(haus.sonstigeW, 1400); // 1800 − 400 (B + eigene Ebene stecken drin)
  // Global: Eigenverbrauch 2500 − Haus 1800 = 700.
  assert.equal(snap.sonstige.powerW, 700);
});

test('assembleEnergiefluss: heute/Jahr auch für PV, Netz und Eigenverbrauch', () => {
  const snap = assembleEnergiefluss({
    pvValues: { plants: [], totals: { current: 4000, today: 12.5, year: 3400 } },
    stromValues: {
      eigenverbrauchPower: 2000, netzbezugPower: -500,
      breakdown: {
        today: { eigenverbrauch: 8.2, netzbezug: -1.5 },
        year: { eigenverbrauch: 2600, netzbezug: 900 },
      },
    },
  });
  assert.equal(snap.pv.todayKwh, 12.5);
  assert.equal(snap.pv.yearKwh, 3400);
  assert.equal(snap.grid.todayKwh, -1.5); // Netto (Bezug − Einspeisung)
  assert.equal(snap.grid.yearKwh, 900);
  assert.equal(snap.eigenverbrauch.todayKwh, 8.2);
  assert.equal(snap.eigenverbrauch.yearKwh, 2600);
});

test('assembleEnergiefluss: Verbrauch heute/Jahr landet an den Gruppen-Nodes', () => {
  const snap = assembleEnergiefluss({
    stromValues: { eigenverbrauchPower: 500 },
    groups: [{ id: 7, title: 'Bad', parentId: null, meterGroup: false, offsetTotalConsumption: true }],
    groupTree: tree([[7, { gesamtW: 120 }]]),
    groupEnergy: new Map([[7, { todayKwh: 3.5, yearKwh: 812, prevYearKwh: 1500 }]]),
  });
  assert.equal(snap.groups[0].todayKwh, 3.5);
  assert.equal(snap.groups[0].yearKwh, 812);
});

test('assembleEnergiefluss: Sonstige bekommt Tages-/Jahresenergie (pro Gruppe und global)', () => {
  const snap = assembleEnergiefluss({
    stromValues: {
      eigenverbrauchPower: 2500,
      breakdown: { today: { eigenverbrauch: 12 }, year: { eigenverbrauch: 4000 } },
    },
    groups: [
      { id: 10, title: 'Haus', parentId: null, meterGroup: false, offsetTotalConsumption: true },
      { id: 11, title: 'A', parentId: 10, meterGroup: false, offsetTotalConsumption: true },
      { id: 12, title: 'B', parentId: 10, meterGroup: false, offsetTotalConsumption: false },
    ],
    groupTree: tree([
      [10, { gesamtW: 1800, meterGroup: false }],
      [11, { gesamtW: 400, meterGroup: false }],
      [12, { gesamtW: 250, meterGroup: false }],
    ]),
    groupEnergy: new Map([
      [10, { todayKwh: 10, yearKwh: 3000 }],
      [11, { todayKwh: 3, yearKwh: 800 }],
    ]),
  });
  const haus = snap.groups[0];
  // „Sonstige" des Hauses = Gruppe − Σ(gezeichnete Kinder), analog zur Leistung.
  assert.equal(haus.sonstigeTodayKwh, 7); // 10 − 3 (A)
  assert.equal(haus.sonstigeYearKwh, 2200); // 3000 − 800 (A)
  // Global: Eigenverbrauch − gezeichnete oberste Gruppen.
  assert.equal(snap.sonstige.todayKwh, 2); // 12 − 10 (Haus)
  assert.equal(snap.sonstige.yearKwh, 1000); // 4000 − 3000 (Haus)
});

test('assembleEnergiefluss: Zählergruppe zeigt Sonstige-Rest; groupStatus grayt aus', () => {
  const snap = assembleEnergiefluss({
    stromValues: { eigenverbrauchPower: 1000 },
    groups: [
      { id: 1, title: 'Zähler', parentId: null, meterGroup: true, offsetTotalConsumption: true },
      { id: 2, title: 'Küche', parentId: 1, meterGroup: false, offsetTotalConsumption: true },
    ],
    groupTree: tree([
      [1, { gesamtW: 1000, meterGroup: true }],
      [2, { gesamtW: 400, meterGroup: false }],
    ]),
    groupStatus: new Map([[2, { deactivated: true }]]),
  });
  const z = snap.groups[0];
  assert.equal(z.meterGroup, true);
  assert.equal(z.sonstigeW, 600); // 1000 (Zähler) − 400 (Küche)
  assert.equal(z.children[0].deactivated, true); // Küche ausgegraut
});

test('assembleEnergiefluss: fehlende Batterie-Konfiguration => present false', () => {
  const snap = assembleEnergiefluss({
    pvValues: { plants: [], totals: { current: null } },
    stromValues: { eigenverbrauchPower: null, netzbezugPower: 500 },
    batteryData: {},
    batteryConfig: {},
    groups: [],
    groupTree: new Map(),
  });
  assert.equal(snap.battery.present, false);
  assert.equal(snap.grid.powerW, 500);
  assert.equal(snap.pv.totalW, null);
  assert.deepEqual(snap.groups, []);
});

test('assembleEnergiefluss: orphan-Untergruppe (fehlender Parent) wird zur Wurzel', () => {
  const snap = assembleEnergiefluss({
    groups: [{ id: 5, title: 'Waise', parentId: 999, meterGroup: false }],
    groupTree: tree([[5, { gesamtW: 100 }]]),
  });
  assert.equal(snap.groups.length, 1);
  assert.equal(snap.groups[0].id, 5);
});
