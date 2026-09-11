'use strict';

// Temperaturdiagramm der Räume: Skala, Balken, Soll-Strich und die gespeicherte
// Reihenfolge der Spalten.

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const rooms = require('../src/heizung/rooms');
const chart = require('../src/views/heizung-chart');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
}
function close(db) { return new Promise((resolve) => db.close(resolve)); }

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE heizung_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    position INTEGER NOT NULL DEFAULT 0, target_temp REAL NOT NULL DEFAULT 21,
    heat_offset REAL NOT NULL DEFAULT 0, cool_offset REAL NOT NULL DEFAULT 5,
    cool_min_temp REAL,
    hysteresis REAL NOT NULL DEFAULT 0.5, thermostat_topic TEXT NOT NULL DEFAULT '',
    boost_active INTEGER NOT NULL DEFAULT 0, boost_topic TEXT NOT NULL DEFAULT '',
    heat_priority INTEGER NOT NULL DEFAULT 2, cool_priority INTEGER NOT NULL DEFAULT 4,
    heat_central_fallback INTEGER NOT NULL DEFAULT 0,
    central_allowed INTEGER NOT NULL DEFAULT 0, central_temp REAL,
    fan_topic TEXT NOT NULL DEFAULT '',
    contact_delay_seconds INTEGER NOT NULL DEFAULT 0,
    climate_mode INTEGER NOT NULL DEFAULT 2, climate_mode_since INTEGER,
    climate_reset_time TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '')`);
  return db;
}

const baseRoom = { targetTemp: '21', heatOffset: '0', coolOffset: '5', hysteresis: '0.5' };

test('Die Skala rundet auf ganze Schritte und behält einen Mindestbereich', () => {
  // Ein einzelner Wert spannt trotzdem einen lesbaren Bereich auf.
  assert.deepEqual(chart.domainFor([{ targetTemp: 21, state: { temperature: 21.4 } }]), { min: 20, max: 35 });
  // Weit auseinanderliegende Räume: gerundet auf 5-°C-Schritte mit Puffer.
  assert.deepEqual(chart.domainFor([
    { targetTemp: 21, state: { temperature: 16.2 } },
    { targetTemp: 24, state: { temperature: 28.9 } },
  ]), { min: 15, max: 30 });
  // Ohne jeden Messwert bleibt die Vorgabeskala stehen.
  assert.deepEqual(chart.domainFor([]), { min: 15, max: 30 });
  // Auch ein Raum ohne Ist-Temperatur zählt mit seiner Soll-Temperatur.
  assert.deepEqual(chart.domainFor([{ targetTemp: 21, state: {} }]), { min: 20, max: 35 });
});

test('Die Höhe eines Balkens ist sein Anteil an der Skala', () => {
  const domain = { min: 15, max: 30 };
  assert.equal(chart.percent(15, domain), 0);
  assert.equal(chart.percent(30, domain), 100);
  assert.equal(chart.percent(22.5, domain), 50);
  // Werte außerhalb der Skala werden an ihre Ränder gelegt, statt aus dem
  // Diagramm zu laufen.
  assert.equal(chart.percent(5, domain), 0);
  assert.equal(chart.percent(99, domain), 100);
});

test('Jeder Raum bekommt einen Balken mit Farbe, Soll-Strich, Namen und Griffleiste', () => {
  const html = chart.chartCard([
    { id: 7, name: 'Wohnzimmer', position: 0, targetTemp: 21, state: { temperature: 20, heating: true } },
    { id: 8, name: 'Bad', position: 1, targetTemp: 24, state: { temperature: 26, cooling: true } },
    { id: 9, name: 'Flur', position: 2, targetTemp: 18, state: {} },
    { id: 10, name: 'Küche', position: 3, targetTemp: 20, state: { temperature: 17, contactOpen: true } },
    { id: 11, name: 'Keller', position: 4, targetTemp: 16, state: { temperature: 14, heatDemand: true, heatAllowed: false } },
    { id: 12, name: 'Büro', position: 5, targetTemp: 21, state: { temperature: 19, centralDemand: true } },
  ]);
  // Regelzustand als Farbe: heizen rot, kühlen blau, gesperrt grau, sonst grün.
  assert.match(html, /data-hz-bar="7"[\s\S]*?hz-bar-fill--heat/);
  assert.match(html, /data-hz-bar="8"[\s\S]*?hz-bar-fill--cool/);
  assert.match(html, /data-hz-bar="9"[\s\S]*?hz-bar-fill--idle/);
  // Offener Fenster-/Türkontakt und ein sperrendes Betriebslevel schalten den
  // Raum ab — beides zeigt derselbe graue Balken.
  assert.match(html, /data-hz-bar="10"[\s\S]*?hz-bar-fill--blocked/);
  assert.match(html, /data-hz-bar="11"[\s\S]*?hz-bar-fill--blocked/);
  // Auch bei zentral gelieferter Wärme heizt der Raum und wird rot.
  assert.match(html, /data-hz-bar="12"[\s\S]*?hz-bar-fill--heat/);
  // Ohne Messwert bleibt der Balken leer, der Soll-Strich steht trotzdem.
  assert.match(html, /class="hz-bar-col hz-bar-col--empty" data-hz-bar="9"/);
  // Der Soll-Strich ist ein Bedienelement und trägt seinen Wert mit.
  assert.match(html, /data-hz-target="21"/);
  assert.match(html, /role="slider"[\s\S]*?aria-valuenow="21"/);
  assert.match(html, /data-hz-post="\/heizung\/raum\/7\/soll"/);
  // Name und Griffleiste stehen unter dem Balken.
  assert.match(html, /<div class="hz-bar-name"><span>Wohnzimmer<\/span><\/div>/);
  assert.match(html, /data-hz-grip/);
  // Ohne Räume gibt es kein Diagramm.
  assert.equal(chart.chartCard([]), '');
});

test('Das Diagramm folgt der gespeicherten Reihenfolge, die Liste bleibt alphabetisch', async () => {
  const db = await freshDb();
  const wohnzimmer = await rooms.createRoom(db, { ...baseRoom, name: 'Wohnzimmer' });
  const bad = await rooms.createRoom(db, { ...baseRoom, name: 'Bad' });
  const flur = await rooms.createRoom(db, { ...baseRoom, name: 'Flur' });

  // Angelegt wird in der Reihenfolge des Anlegens, gelistet alphabetisch.
  assert.deepEqual((await rooms.listRooms(db)).map((room) => room.name), ['Bad', 'Flur', 'Wohnzimmer']);
  assert.deepEqual(chart.inOrder(await rooms.listRooms(db)).map((room) => room.name),
    ['Wohnzimmer', 'Bad', 'Flur']);

  // Nachbarräume nebeneinander legen: nur das Diagramm ordnet sich um.
  await rooms.setRoomOrder(db, [bad.id, wohnzimmer.id, flur.id]);
  assert.deepEqual(chart.inOrder(await rooms.listRooms(db)).map((room) => room.name),
    ['Bad', 'Wohnzimmer', 'Flur']);
  assert.deepEqual((await rooms.listRooms(db)).map((room) => room.name), ['Bad', 'Flur', 'Wohnzimmer']);

  // Ein nicht genannter Raum hängt sich hinten an, statt die Position 0 zu erben.
  await rooms.setRoomOrder(db, [flur.id]);
  const positions = new Map((await rooms.listRooms(db)).map((room) => [room.name, room.position]));
  assert.equal(positions.get('Flur'), 0);
  assert.notEqual(positions.get('Bad'), 0);
  assert.notEqual(positions.get('Wohnzimmer'), 0);

  // Unbekannte Nummern zählen nicht; ohne einen einzigen bekannten Raum bleibt
  // die Reihenfolge unangetastet.
  await assert.rejects(() => rooms.setRoomOrder(db, [999]), /keinen bekannten Raum/);
  await assert.rejects(() => rooms.setRoomOrder(db, []), /keinen bekannten Raum/);
  await close(db);
});

// Das Verschieben der Spalten läuft im Browser. Damit der Fehler „nach einem
// Platz bleibt der Raum kleben" nicht zurückkommt, wird das ausgelieferte
// Skript hier gegen ein DOM-Gerüst ausgeführt: fünf Spalten von je 40 px, die
// ihre sichtbare Lage aus ihrer Flexbox-Ordnung beziehen.
const COLUMN_WIDTH = 40;

function node(children = {}) {
  const self = {
    attributes: new Map(),
    classes: new Set(),
    style: { order: '', setProperty() {} },
    listeners: new Map(),
    textContent: '',
    innerHTML: '',
    getAttribute: (name) => (self.attributes.has(name) ? self.attributes.get(name) : null),
    setAttribute: (name, value) => self.attributes.set(name, String(value)),
    querySelector: (selector) => children[selector] || null,
    addEventListener: (type, fn) => self.listeners.set(type, (self.listeners.get(type) || []).concat(fn)),
    classList: {
      add: (name) => self.classes.add(name),
      remove: (name) => self.classes.delete(name),
      toggle: (name, on) => (on ? self.classes.add(name) : self.classes.delete(name)),
    },
  };
  return self;
}

function fire(target, type, event = {}) {
  for (const fn of target.listeners.get(type) || []) fn({ preventDefault() {}, pointerId: 1, ...event });
}

// Sichtbare Lage: erst die gesetzte Flexbox-Ordnung, bei Gleichstand die
// Reihenfolge im Markup.
function layout(columns) {
  return columns.map((col, index) => ({ col, index, order: col.style.order === '' ? 0 : Number(col.style.order) }))
    .sort((left, right) => (left.order - right.order) || (left.index - right.index))
    .map((entry) => entry.col);
}

function chartDom(count) {
  const columns = [];
  for (let index = 0; index < count; index += 1) {
    const grip = node();
    const mark = node({ '[data-hz-mark-value]': node() });
    const col = node({
      '[data-hz-grip]': grip,
      '[data-hz-mark]': mark,
      '[data-hz-track]': node(),
      '[data-hz-value-text]': node(),
      '[data-hz-mark-value]': mark.querySelector('[data-hz-mark-value]'),
    });
    col.setAttribute('data-hz-bar', String(index + 1));
    col.setAttribute('data-hz-value', '21');
    col.setAttribute('data-hz-target', '21');
    col.getBoundingClientRect = () => {
      const position = layout(columns).indexOf(col);
      return { left: position * COLUMN_WIDTH, width: COLUMN_WIDTH, right: (position + 1) * COLUMN_WIDTH };
    };
    col.grip = grip;
    columns.push(col);
  }
  const bars = node();
  bars.querySelectorAll = () => columns.slice();
  const plot = node();
  const viewport = node();
  viewport.clientWidth = 200;
  const document = {
    getElementById: (id) => (id === 'heizungChartBars' ? bars : null),
    querySelector: (selector) => {
      if (selector === '.hz-chart-plot') return plot;
      if (selector === '.hz-chart-viewport') return viewport;
      return node();
    },
    activeElement: null,
  };
  return { columns, document, bars, plot, viewport };
}

// Das Skript der Seite in einer eigenen Umgebung starten.
function runChartScript(rooms, document, saved) {
  const script = chart.chartScript(rooms);
  const fetchStub = (url, options) => {
    saved.push({ url, body: options && options.body });
    return { then: () => ({ catch: () => {} }), catch: () => {} };
  };
  return new Function('document', 'fetch', 'setTimeout', 'clearTimeout', 'heizungTemp', 'heizungPoll',
    `${script}\nreturn { columns: hzChartOrderedColumns, measure: hzChartMeasure };`
  )(document, fetchStub, () => 0, () => {}, () => '', () => {});
}

test('Die horizontale Scrollleiste richtet sich nur nach der Mindestbreite der Spalten', () => {
  const roomList = [1, 2, 3, 4, 5].map((id) => ({
    id, name: 'Raum ' + id, position: id - 1, targetTemp: 21, state: { temperature: 21 },
  }));
  const { document, bars, plot, viewport } = chartDom(5);
  const previous = global.getComputedStyle;
  global.getComputedStyle = (target) => ({
    columnGap: target === bars ? '8px' : '0px',
    getPropertyValue: (name) => (target === plot && name === '--hz-col-min' ? '28px' : ''),
  });
  try {
    const api = runChartScript(roomList, document, []);
    // 5 × 28 px plus 4 × 8 px Abstand benötigen 172 px: bei 200 px ist kein
    // Scrollen nötig, auch wenn Soll-Griffe optisch überstehen.
    assert.equal(viewport.classes.has('hz-chart-viewport--scroll'), false);
    viewport.clientWidth = 160;
    api.measure();
    assert.equal(viewport.classes.has('hz-chart-viewport--scroll'), true);
  } finally {
    if (previous === undefined) delete global.getComputedStyle;
    else global.getComputedStyle = previous;
  }
});

test('Eine Spalte lässt sich in einem Zug über mehrere Plätze schieben', () => {
  const rooms = [1, 2, 3, 4, 5].map((id) => ({
    id, name: `Raum ${id}`, position: id - 1, targetTemp: 21, state: { temperature: 21 },
  }));
  const { columns, document } = chartDom(5);
  const saved = [];
  const api = runChartScript(rooms, document, saved);

  const first = columns[0];
  fire(first.grip, 'pointerdown');
  // Ein einziger Zeigerweg quer über drei Spalten: die erste landet an vierter
  // Stelle. Vor dem Fix blieb sie nach dem ersten Platz stehen.
  fire(first.grip, 'pointermove', { clientX: 170 });
  assert.deepEqual(api.columns().map((col) => col.getAttribute('data-hz-bar')), ['2', '3', '4', '1', '5']);
  assert.ok(first.classes.has('hz-bar-col--moving'));

  // Weiterziehen in derselben Geste bewegt sie erneut — die Zeigererfassung
  // bleibt bestehen, weil der DOM-Baum unangetastet bleibt.
  fire(first.grip, 'pointermove', { clientX: 195 });
  assert.deepEqual(api.columns().map((col) => col.getAttribute('data-hz-bar')), ['2', '3', '4', '5', '1']);

  // Loslassen beendet das Ziehen und sichert die sichtbare Reihenfolge.
  fire(first.grip, 'pointerup');
  assert.equal(first.classes.has('hz-bar-col--moving'), false);
  assert.deepEqual(saved.map((call) => call.url), ['/heizung/raeume/reihenfolge']);
  assert.deepEqual(JSON.parse(saved[0].body).order, [2, 3, 4, 5, 1]);

  // Ein verlorengegangenes Ziehen darf die Spalte nicht kleben lassen.
  fire(columns[1].grip, 'pointerdown');
  assert.ok(columns[1].classes.has('hz-bar-col--moving'));
  fire(columns[1].grip, 'lostpointercapture');
  assert.equal(columns[1].classes.has('hz-bar-col--moving'), false);
});
