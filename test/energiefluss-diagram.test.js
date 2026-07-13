'use strict';

// Geometrie-Tests des Energiefluss-Layouts (DOM-frei: nur die reine Layout-Funktion
// aus dem Diagramm-Modul; keine SVG-/Browser-Abhängigkeit).

const test = require('node:test');
const assert = require('node:assert/strict');

const { layout } = require('../public/energiefluss-diagram.js');

function sampleData() {
  return {
    eigenverbrauch: { powerW: 1200, todayKwh: 5, yearKwh: 900 },
    pv: { totalW: 2000, todayKwh: 8, yearKwh: 1500, plants: [{ id: 1, name: 'Dach Süd', powerW: 1200 }, { id: 2, name: 'Dach Ost', powerW: 800 }] },
    grid: { powerW: -300, todayKwh: 2, yearKwh: 400 },
    battery: { present: true, soc: 74, powerW: -500 },
    groups: [
      { id: 1, title: 'IT', powerW: 240, todayKwh: 1, yearKwh: 100, children: [] },
      { id: 8, title: 'EG-Keller', powerW: 900, meterGroup: true, children: [{ id: 7, title: 'Licht EG', powerW: 60, children: [] }], sonstigeW: 300 },
    ],
    sonstige: { powerW: 150, todayKwh: 0.3, yearKwh: 20 },
  };
}

test('vertikales Layout: schmal, hoch und ohne fehlerhafte Koordinaten', () => {
  const v = layout(sampleData(), true, true);
  const h = layout(sampleData(), true, false);
  assert.equal(v.vertical, true);
  // Vertikal ist deutlich schmaler (handytauglich) und höher als horizontal.
  assert.ok(v.width < h.width, 'vertikal schmaler als horizontal');
  assert.ok(v.height > h.height, 'vertikal höher als horizontal');
  // Keine NaN/Infinity in den Knoten-Koordinaten.
  for (const n of v.nodes) {
    for (const c of [n.x, n.y, n.w, n.h]) assert.ok(Number.isFinite(c));
  }
  // Jede Kante trägt einen fertigen Pfad (orthogonaler Polylinien-„Abzweig").
  assert.ok(v.links.length > 0);
  for (const l of v.links) assert.ok(typeof l.d === 'string' && l.d[0] === 'M');
});

test('vertikales Layout: Versorger (inkl. Batterie) oben eingerückt, Verbraucher unten', () => {
  const v = layout(sampleData(), true, true);
  const central = v.nodes.find((n) => n.key === 'central');
  const pv = v.nodes.find((n) => n.key === 'pv');
  const plant = v.nodes.find((n) => n.title === 'Dach Süd');
  const grid = v.nodes.find((n) => n.title === 'Netz');
  const battery = v.nodes.find((n) => n.key === 'battery');
  const it = v.nodes.find((n) => n.title === 'IT');
  const keller = v.nodes.find((n) => n.key === 'group-8');
  const licht = v.nodes.find((n) => n.title === 'Licht EG');
  // Versorger stehen ÜBER dem Eigenverbrauch, Einzel-Anlagen über PV gesamt.
  assert.ok(pv.y < central.y, 'PV gesamt über Eigenverbrauch');
  assert.ok(grid.y < central.y, 'Netz über Eigenverbrauch');
  assert.ok(plant.y < pv.y, 'Einzel-Anlage über PV gesamt');
  // Batterie ist eingerückt ÜBER dem Eigenverbrauch (wie eine Quelle), nicht daneben.
  assert.ok(battery.y < central.y, 'Batterie über Eigenverbrauch');
  assert.ok(battery.x > central.x, 'Batterie eingerückt (wie Anlagen an PV gesamt)');
  // Verbraucher unter dem Eigenverbrauch; Untergruppen tiefer eingerückt.
  assert.ok(it.y > central.y);
  assert.ok(licht.x > keller.x);
});

test('vertikales Layout: Kanten setzen nebeneinander an (verteilt), nicht deckungsgleich', () => {
  const v = layout(sampleData(), true, true);
  const central = v.nodes.find((n) => n.key === 'central');
  const startX = (l) => Number(l.d.match(/^M([\d.]+),/)[1]);
  // Die direkten Verbraucher-Kanten des Eigenverbrauchs (IT, EG-Keller, „Sonstige")
  // setzen an VERSCHIEDENEN x-Punkten der unteren Kante an → nebeneinander, nicht
  // exakt aufeinander (kein gemeinsamer Gutter-Strich mehr).
  const consumerKeys = ['l-group-1', 'l-group-8', 'l-sonstige-global'];
  const xs = v.links.filter((l) => consumerKeys.includes(l.key)).map(startX);
  assert.equal(xs.length, 3);
  assert.equal(new Set(xs.map((x) => x.toFixed(2))).size, 3, 'Ansatzpunkte sind verschieden');
  // … und liegen innerhalb der Breite des Eigenverbrauch-Knotens (Bündel am Stamm).
  for (const x of xs) assert.ok(x >= central.x && x <= central.x + central.w);
});

test('vertikales Layout: Verbraucher-Einrückung wächst dynamisch mit der Gruppenzahl', () => {
  const mk = (n) => ({
    eigenverbrauch: { powerW: 1200 },
    pv: { totalW: 2000, plants: [{ id: 1, name: 'A', powerW: 1200 }] },
    grid: { powerW: -300 },
    groups: Array.from({ length: n }, (_, i) => ({ id: i + 1, title: 'G' + (i + 1), powerW: 100, children: [] })),
  });
  const indent = (data, key) => {
    const v = layout(data, true, true);
    const c = v.nodes.find((x) => x.key === 'central');
    return v.nodes.find((x) => x.key === key).x - c.x;
  };
  // Mehr Gruppen → tiefere Einrückung der Verbraucher (breiterer Kanal-Spalt) …
  assert.ok(indent(mk(10), 'group-1') > indent(mk(3), 'group-1'));
  assert.ok(indent(mk(3), 'group-1') > indent(mk(1), 'group-1'));
  // … die wenigen Quellen oben bleiben davon unberührt (konstante Einrückung).
  assert.equal(indent(mk(2), 'pv'), indent(mk(10), 'pv'));
});

test('horizontales Layout bleibt unverändert nutzbar (Default ohne vertical-Flag)', () => {
  const h = layout(sampleData(), true);
  assert.ok(!h.vertical);
  assert.ok(h.width > 0 && h.height > 0);
  assert.ok(h.nodes.length > 1);
});
