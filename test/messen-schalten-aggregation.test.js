'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { cacheKey, createActor, updateActor } = require('../src/messen-schalten/actors');
const {
  buildActorSnapshot, readActorValues, readGroupSums, readGroupPowerTree, derivedPowerFromState, STALL_MS, VALUE_STALE_MS,
  applyPeriodRollover, computeActorEnergy, buildGroupEnergyTree, counterPowerMismatch,
} = require('../src/messen-schalten/aggregation');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE mess_schalt_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', group_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0, switch_topic TEXT NOT NULL DEFAULT '',
    remote_topic TEXT NOT NULL DEFAULT '',
    status_topic TEXT NOT NULL DEFAULT '', power_topic TEXT NOT NULL DEFAULT '',
    power_unit TEXT NOT NULL DEFAULT 'W', counter_topic TEXT NOT NULL DEFAULT '',
    counter_unit TEXT NOT NULL DEFAULT 'kWh', rated_power REAL, rated_power_unit TEXT NOT NULL DEFAULT 'W', priority INTEGER NOT NULL DEFAULT 4,
    use_group_priority INTEGER NOT NULL DEFAULT 0, desired_on INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    function_key TEXT NOT NULL DEFAULT '',
    load_shed_enabled INTEGER NOT NULL DEFAULT 0,
    load_shed_phase TEXT NOT NULL DEFAULT 'l1',
    switch_group_id INTEGER)`);
  await dbRun(db, 'CREATE TABLE mess_schalt_actor_state (actor_id INTEGER PRIMARY KEY, last_counter_raw REAL, last_progress_ts INTEGER, derived_power_w REAL, counter_total_kwh REAL, day_key TEXT, day_start_kwh REAL, year_key TEXT, year_start_kwh REAL, prev_year_kwh REAL, power_energy_kwh REAL, power_energy_day_start_kwh REAL, last_power_ts INTEGER)');
  return db;
}

function cacheFrom(pairs) {
  const map = new Map();
  for (const [key, value] of pairs) map.set(key, { value });
  return map;
}

test('Leistung wird aus dem Zählerfortschritt abgeleitet (Δkwh/Δt → W)', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, counter_topic, counter_unit) VALUES (1, 'Ofen', 'c.0', 'kWh')");
  const t0 = 1_000_000_000_000;
  // Erster Snapshot: Basis setzen (0 W).
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 10]]), t0);
  // Nach 30 min +0,5 kWh ⇒ 1 kWh/h ⇒ 1000 W.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 10.5]]), t0 + 30 * 60 * 1000);
  const row = await dbGet(db, 'SELECT derived_power_w FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.ok(Math.abs(row.derived_power_w - 1000) < 0.001);
  await new Promise((resolve) => db.close(resolve));
});

test('Ohne Zählerfortschritt fällt die abgeleitete Leistung nach 10 min auf 0 W', () => {
  const now = 2_000_000_000_000;
  const fresh = { lastProgressTs: now - 5 * 60 * 1000, derivedPowerW: 800 };
  assert.equal(derivedPowerFromState(fresh, now), 800);
  const stale = { lastProgressTs: now - (STALL_MS + 1), derivedPowerW: 800 };
  assert.equal(derivedPowerFromState(stale, now), 0);
});

test('readActorValues: Status fällt auf Schalt-Topic bzw. Leistung zurück', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic) VALUES (1, 'Nur Schalten', 's.1')");
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic) VALUES (2, 'Nur Leistung', 'p.2')");
  const cache = cacheFrom([
    [cacheKey(1, 'switch'), '1'],
    [cacheKey(2, 'power'), 42],
  ]);
  const values = await readActorValues(db, cache, null, 3_000_000_000_000);
  const a1 = values.find((v) => v.id === 1);
  const a2 = values.find((v) => v.id === 2);
  assert.equal(a1.statusOn, true);      // aus Schalt-Topic
  assert.equal(a1.switchOn, true);
  assert.equal(a2.statusOn, true);      // aus Leistung > Schwelle
  assert.equal(a2.powerW, 42);
  await new Promise((resolve) => db.close(resolve));
});

test('readActorValues: dediziertes Status-Topic hat Vorrang', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, status_topic) VALUES (1, 'X', 's.1', 'st.1')");
  const cache = cacheFrom([[cacheKey(1, 'switch'), '1'], [cacheKey(1, 'status'), 'false']]);
  const values = await readActorValues(db, cache, null);
  assert.equal(values[0].switchOn, true);
  assert.equal(values[0].statusOn, false); // Status-Topic übersteuert Schalt-Topic
  await new Promise((resolve) => db.close(resolve));
});

test('Neueres AUS setzt alten Leistungswert passiv auf 0 und markiert alte Werte', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic, power_topic) VALUES (1, 'Licht', 's.1', 'p.1')");
  const now = 3_000_000_000_000;
  const cache = new Map([
    [cacheKey(1, 'power'), { value: 68, receivedAt: now - VALUE_STALE_MS - 1000 }],
    [cacheKey(1, 'switch'), { value: false, receivedAt: now - 1000 }],
  ]);
  const [value] = await readActorValues(db, cache, null, now);
  assert.equal(value.statusOn, false);
  assert.equal(value.powerW, 0);
  assert.equal(value.powerInferredOff, true);
  assert.equal(value.powerStale, false); // 0 W ist durch das neuere AUS abgesichert

  cache.set(cacheKey(1, 'switch'), { value: true, receivedAt: now - VALUE_STALE_MS - 2000 });
  const [stale] = await readActorValues(db, cache, null, now);
  assert.equal(stale.powerW, 68);
  assert.equal(stale.powerStale, true);
  assert.equal(stale.statusStale, true);
  await new Promise((resolve) => db.close(resolve));
});

// --- Virtuelle Zählung aus Nennleistung × Schaltzustand ----------------------

test('readActorValues: virtuelle Leistung aus Nennleistung × Schaltzustand', async () => {
  const db = await freshDb();
  // Kein Leistungs-/Zähler-Topic, aber Nennleistung 2 kW.
  await createActor(db, { name: 'Heizung', switchTopic: 's.1', ratedPower: '2', ratedPowerUnit: 'kW' });
  const [on] = await readActorValues(db, cacheFrom([[cacheKey(1, 'switch'), '1']]), null);
  assert.equal(on.powerW, 2000);
  assert.equal(on.statusOn, true);
  assert.equal(on.powerFromRated, true);

  const [off] = await readActorValues(db, cacheFrom([[cacheKey(1, 'switch'), '0']]), null);
  assert.equal(off.powerW, 0);
  assert.equal(off.statusOn, false);
  await new Promise((resolve) => db.close(resolve));
});

test('readActorValues: Leistungs-Topic hat Vorrang vor der Nennleistung', async () => {
  const db = await freshDb();
  await createActor(db, { name: 'Steckdose', switchTopic: 's.1', powerTopic: 'p.1', ratedPower: '2000' });
  const [v] = await readActorValues(db, cacheFrom([[cacheKey(1, 'switch'), '1'], [cacheKey(1, 'power'), 55]]), null);
  assert.equal(v.powerW, 55);
  assert.equal(v.powerFromRated, false);
  await new Promise((resolve) => db.close(resolve));
});

test('Virtuelle Zählung integriert Energie aus Nennleistung × Einschaltdauer', async () => {
  const db = await freshDb();
  await createActor(db, { name: 'Heizung', switchTopic: 's.1', ratedPower: '2000' }); // 2000 W
  const t0 = 1_000_000_000_000;
  const on = () => cacheFrom([[cacheKey(1, 'switch'), '1']]);
  const off = () => cacheFrom([[cacheKey(1, 'switch'), '0']]);

  // Erster Snapshot: Basis setzen (an), noch keine Energie.
  await buildActorSnapshot(db, on(), t0);
  let row = await dbGet(db, 'SELECT counter_total_kwh, derived_power_w FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.equal(row.counter_total_kwh, 0);
  assert.equal(row.derived_power_w, 2000);

  // 30 min an ⇒ 2000 W × 0,5 h = 1 kWh.
  await buildActorSnapshot(db, on(), t0 + 30 * 60 * 1000);
  row = await dbGet(db, 'SELECT counter_total_kwh FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.ok(Math.abs(row.counter_total_kwh - 1) < 1e-9);

  // Weitere 30 min (Intervall lief noch mit alter Leistung an) ⇒ 2 kWh, dann aus.
  await buildActorSnapshot(db, off(), t0 + 60 * 60 * 1000);
  row = await dbGet(db, 'SELECT counter_total_kwh, derived_power_w FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.ok(Math.abs(row.counter_total_kwh - 2) < 1e-9);
  assert.equal(row.derived_power_w, 0);

  // Aus bleibt aus ⇒ keine weitere Energie; der interne Zähler erscheint im Read.
  await buildActorSnapshot(db, off(), t0 + 90 * 60 * 1000);
  const [val] = await readActorValues(db, off(), null, t0 + 90 * 60 * 1000);
  assert.ok(Math.abs(val.counterKwh - 2) < 1e-9);
  assert.equal(val.powerW, 0);
  await new Promise((resolve) => db.close(resolve));
});

test('Wechsel von Zähler- auf Nennleistungs-Zählung führt den internen Zähler fort', async () => {
  const db = await freshDb();
  const a = await createActor(db, { name: 'Ofen', counterTopic: 'c.0', counterUnit: 'kWh' });
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(a.id, 'counter'), 100]]), t0); // Basis
  await buildActorSnapshot(db, cacheFrom([[cacheKey(a.id, 'counter'), 105]]), t0 + 60_000); // +5 kWh
  let row = await dbGet(db, 'SELECT counter_total_kwh FROM mess_schalt_actor_state WHERE actor_id = ?', [a.id]);
  assert.ok(Math.abs(row.counter_total_kwh - 5) < 1e-9);

  // Umstellen auf Nennleistung: Zähler-Topic entfernt, Nennwert gesetzt.
  await updateActor(db, a.id, { name: 'Ofen', switchTopic: 's.0', ratedPower: '2000' });
  row = await dbGet(db, 'SELECT counter_total_kwh, last_progress_ts FROM mess_schalt_actor_state WHERE actor_id = ?', [a.id]);
  assert.ok(Math.abs(row.counter_total_kwh - 5) < 1e-9); // fortlaufender Zähler bleibt erhalten
  assert.equal(row.last_progress_ts, null); // Integrations-Timing neu basiert

  // Der Read zeigt den erhaltenen Stand auch ohne Zähler-Topic (nicht ausgeblendet).
  const [v] = await readActorValues(db, cacheFrom([[cacheKey(a.id, 'switch'), '1']]), null);
  assert.ok(Math.abs(v.counterKwh - 5) < 1e-9);
  assert.equal(v.powerFromRated, true);

  // Weiter zählen: 30 min an ⇒ +1 kWh ⇒ 6 kWh.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(a.id, 'switch'), '1']]), t0 + 120_000);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(a.id, 'switch'), '1']]), t0 + 120_000 + 30 * 60 * 1000);
  row = await dbGet(db, 'SELECT counter_total_kwh FROM mess_schalt_actor_state WHERE actor_id = ?', [a.id]);
  assert.ok(Math.abs(row.counter_total_kwh - 6) < 1e-9);
  await new Promise((resolve) => db.close(resolve));
});

test('Ohne Nennleistung und ohne Mess-Topic bleibt Leistung/Energie leer', async () => {
  const db = await freshDb();
  await createActor(db, { name: 'Nur Schalten', switchTopic: 's.1' });
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'switch'), '1']]), 1_000_000_000_000);
  const row = await dbGet(db, 'SELECT derived_power_w, last_progress_ts FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.equal(row.derived_power_w, null); // virtuelle Zählung nicht aktiv
  assert.equal(row.last_progress_ts, null);
  const [v] = await readActorValues(db, cacheFrom([[cacheKey(1, 'switch'), '1']]), null);
  assert.equal(v.powerW, null);
  assert.equal(v.counterKwh, null);
  assert.equal(v.powerFromRated, false);
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand: Neuanlage übernimmt den Rohwert nicht als Sprung', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Boiler', counterTopic: 'c.0' });
  const t0 = 1_000_000_000_000;
  // Erster Rohwert (Lebenszeit-Total des Geräts) basiert nur neu: Zähler bleibt 0.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.5]]), t0);
  let values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.5]]), null, t0);
  assert.equal(values[0].counterKwh, 0);
  // Fortschritt +0,25 kWh geht als Delta ein.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.75]]), t0 + 60_000);
  values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 1234.75]]), null, t0 + 60_000);
  assert.ok(Math.abs(values[0].counterKwh - 0.25) < 1e-9);
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand: Topic-Wechsel und Geräte-Reset basieren nur neu', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Boiler', counterTopic: 'c.alt' });
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 10]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 12]]), t0 + 60_000);
  // Stand: 2 kWh intern. Topic-Wechsel darf den Rohwert des neuen Topics nicht addieren.
  await updateActor(db, actor.id, { name: 'Boiler', counterTopic: 'c.neu' });
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 500]]), t0 + 120_000);
  let values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 500]]), null, t0 + 120_000);
  assert.equal(values[0].counterKwh, 2);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 500.5]]), t0 + 180_000);
  // Geräte-Reset (Rohwert fällt zurück): kein Rückschritt, danach zählen Deltas weiter.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 0]]), t0 + 240_000);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 0.2]]), t0 + 300_000);
  values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 0.2]]), null, t0 + 300_000);
  assert.ok(Math.abs(values[0].counterKwh - 2.7) < 1e-9);
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand: Altbestand übernimmt einmalig den Rohwert (nahtlose Anzeige)', async () => {
  const db = await freshDb();
  // Zustand wie vor der Migration: State-Zeile ohne counter_total_kwh (NULL).
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, counter_topic) VALUES (1, 'Alt', 'c.0')");
  await dbRun(db, 'INSERT INTO mess_schalt_actor_state (actor_id, last_counter_raw, last_progress_ts) VALUES (1, 10, 900000000000)');
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 10.5]]), t0);
  let values = await readActorValues(db, cacheFrom([[cacheKey(1, 'counter'), 10.5]]), null, t0);
  assert.equal(values[0].counterKwh, 10.5); // bisheriger Anzeigewert bleibt
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'counter'), 11]]), t0 + 60_000);
  values = await readActorValues(db, cacheFrom([[cacheKey(1, 'counter'), 11]]), null, t0 + 60_000);
  assert.equal(values[0].counterKwh, 11); // und läuft per Delta weiter
  await new Promise((resolve) => db.close(resolve));
});

test('Interner Zählerstand zählt auch bei Geräten mit eigenem Leistungs-Topic', async () => {
  const db = await freshDb();
  const actor = await createActor(db, { name: 'Messdose', powerTopic: 'p.0', counterTopic: 'c.0' });
  const t0 = 1_000_000_000_000;
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 100]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(actor.id, 'counter'), 100.4]]), t0 + 60_000);
  const values = await readActorValues(db, cacheFrom([[cacheKey(actor.id, 'counter'), 100.4]]), null, t0 + 60_000);
  assert.ok(Math.abs(values[0].counterKwh - 0.4) < 1e-9);
  // Leistungsableitung bleibt Geräten ohne Leistungs-Topic vorbehalten.
  const row = await dbGet(db, 'SELECT derived_power_w FROM mess_schalt_actor_state WHERE actor_id = ?', [actor.id]);
  assert.equal(row.derived_power_w, null);
  await new Promise((resolve) => db.close(resolve));
});

test('readGroupSums summiert die Geräteleistungen je Gruppe', () => {
  const groups = [{ id: 5 }, { id: 6 }];
  const values = [
    { id: 1, groupId: 5, powerW: 100 },
    { id: 2, groupId: 5, powerW: 250 },
    { id: 3, groupId: 6, powerW: null },
    { id: 4, groupId: null, powerW: 999 },
  ];
  const sums = readGroupSums(groups, values);
  assert.equal(sums.get(5).powerW, 350);
  assert.equal(sums.get(6).powerW, null); // kein Mitglied mit Wert
});

test('applyPeriodRollover + computeActorEnergy: Tag/Jahr/Vorjahr sauber', () => {
  const s = { counterTotalKwh: 100 };
  applyPeriodRollover(s, { dateKey: '2025-06-01', yearKey: '2025' });
  assert.deepEqual(computeActorEnergy(s), { todayKwh: 0, yearKwh: 0, prevYearKwh: null });

  s.counterTotalKwh = 130; // gleicher Tag
  applyPeriodRollover(s, { dateKey: '2025-06-01', yearKey: '2025' });
  assert.deepEqual(computeActorEnergy(s), { todayKwh: 30, yearKwh: 30, prevYearKwh: null });

  s.counterTotalKwh = 140; // neuer Tag, gleiches Jahr
  applyPeriodRollover(s, { dateKey: '2025-06-02', yearKey: '2025' });
  assert.deepEqual(computeActorEnergy(s), { todayKwh: 0, yearKwh: 40, prevYearKwh: null });

  s.counterTotalKwh = 200; // Jahreswechsel
  applyPeriodRollover(s, { dateKey: '2026-01-01', yearKey: '2026' });
  const e = computeActorEnergy(s);
  assert.equal(e.todayKwh, 0);
  assert.equal(e.yearKwh, 0);
  assert.equal(e.prevYearKwh, 100); // 2025 komplett: 200 − 100
});

test('buildGroupEnergyTree: additiv summiert, Zählergruppe fix aus eigenen Zählern', () => {
  const actorEnergies = [
    { groupId: 1, todayKwh: 5, yearKwh: 50, prevYearKwh: 40 },
    { groupId: 2, todayKwh: 2, yearKwh: 20, prevYearKwh: 15 },
  ];
  const additive = buildGroupEnergyTree(
    [{ id: 1, parentId: null, meterGroup: false }, { id: 2, parentId: 1, meterGroup: false }],
    actorEnergies
  );
  assert.deepEqual(additive.get(1), { todayKwh: 7, yearKwh: 70, prevYearKwh: 55 });
  assert.deepEqual(additive.get(2), { todayKwh: 2, yearKwh: 20, prevYearKwh: 15 });

  const meter = buildGroupEnergyTree(
    [{ id: 1, parentId: null, meterGroup: true }, { id: 2, parentId: 1, meterGroup: false }],
    actorEnergies
  );
  // Zählergruppe zählt nur ihre eigenen Zähler (nicht + Untergruppe).
  assert.deepEqual(meter.get(1), { todayKwh: 5, yearKwh: 50, prevYearKwh: 40 });
});

test('readGroupPowerTree bildet Ebene (eigene) und Gesamt (inkl. Untergruppen)', () => {
  // Haus (eigenes Gerät 1000) → Küche (400) → Herd-Untergruppe (150)
  const groups = [
    { id: 1, parentId: null }, // Haus
    { id: 2, parentId: 1 },    // Küche
    { id: 3, parentId: 2 },    // Herd (Untergruppe der Küche)
  ];
  const values = [
    { id: 10, groupId: 1, powerW: 1000 },
    { id: 20, groupId: 2, powerW: 400 },
    { id: 30, groupId: 3, powerW: 150 },
  ];
  const tree = readGroupPowerTree(groups, values);
  // Ebene = nur eigene Geräte
  assert.equal(tree.get(1).ebeneW, 1000);
  assert.equal(tree.get(2).ebeneW, 400);
  assert.equal(tree.get(3).ebeneW, 150);
  // Gesamt = eigene + alle Nachfahren
  assert.equal(tree.get(1).gesamtW, 1550);
  assert.equal(tree.get(2).gesamtW, 550);
  assert.equal(tree.get(3).gesamtW, 150);
  // hasChildren steuert die „Ebene/Gesamt"-Anzeige
  assert.equal(tree.get(1).hasChildren, true);
  assert.equal(tree.get(3).hasChildren, false);
});

test('readGroupPowerTree: verrechnete Zählergruppe = Sperrschicht (voller Zweig, Nachfahren 0)', () => {
  // Haus = Zählergruppe MIT Haken (Hauptzähler 1000, misst den ganzen Zweig)
  //   → Küche (400)
  const groups = [
    { id: 1, parentId: null, meterGroup: true, offsetTotalConsumption: true },
    { id: 2, parentId: 1, meterGroup: false, offsetTotalConsumption: true },
  ];
  const values = [
    { id: 10, groupId: 1, powerW: 1000 }, // Hauptzähler
    { id: 20, groupId: 2, powerW: 400 },
  ];
  const tree = readGroupPowerTree(groups, values);
  // Gesamt der Zählergruppe = fix aus den eigenen Zählern (NICHT + Untergruppen).
  assert.equal(tree.get(1).gesamtW, 1000);
  // Sonstige Verbraucher dieser Gruppe = 1000 − 400 (nur Anzeige/Fußzeile).
  assert.equal(tree.get(1).sonstigeW, 600);
  // Global: die Zählergruppe trägt den VOLLEN Zweig bei, die Untergruppe 0.
  assert.equal(tree.get(1).contributionW, 1000);
  assert.equal(tree.get(2).contributionW, 0);
  // Untergruppe selbst unverändert additiv im Gesamt.
  assert.equal(tree.get(2).gesamtW, 400);
});

test('readGroupPowerTree: Unter-Haken steuert die Sonstige der Zählergruppe', () => {
  // Zählergruppe (1000) mit zwei Untergruppen: A (400, Haken AN), B (250, Haken AUS).
  const groups = [
    { id: 1, parentId: null, meterGroup: true, offsetTotalConsumption: true },
    { id: 2, parentId: 1, meterGroup: false, offsetTotalConsumption: true },  // A
    { id: 3, parentId: 1, meterGroup: false, offsetTotalConsumption: false }, // B
  ];
  const values = [
    { id: 10, groupId: 1, powerW: 1000 },
    { id: 20, groupId: 2, powerW: 400 },
    { id: 30, groupId: 3, powerW: 250 },
  ];
  const tree = readGroupPowerTree(groups, values);
  // Nur A (Haken AN) wird herausgerechnet: 1000 − 400 = 600. B bleibt in Sonstige.
  assert.equal(tree.get(1).sonstigeW, 600);
  // Global unverändert: Zählergruppe voller Zweig, Untergruppen 0.
  assert.equal(tree.get(1).contributionW, 1000);
  assert.equal(tree.get(2).contributionW, 0);
  assert.equal(tree.get(3).contributionW, 0);

  // Wird B ebenfalls angehakt, sinkt Sonstige auf 1000 − 400 − 250 = 350.
  const tree2 = readGroupPowerTree(
    groups.map((g) => (g.id === 3 ? { ...g, offsetTotalConsumption: true } : g)),
    values
  );
  assert.equal(tree2.get(1).sonstigeW, 350);
  // Global weiterhin voller Zweig.
  assert.equal(tree2.get(1).contributionW, 1000);
});

test('readGroupPowerTree: Sperrschicht ignoriert die Haken der Untergruppen (global)', () => {
  // Untergruppe hat Haken AUS – trotzdem 0 global, weil Zählergruppe verrechnet.
  const groups = [
    { id: 1, parentId: null, meterGroup: true, offsetTotalConsumption: true },
    { id: 2, parentId: 1, meterGroup: false, offsetTotalConsumption: false },
    { id: 3, parentId: 2, meterGroup: false, offsetTotalConsumption: true }, // Enkel
  ];
  const tree = readGroupPowerTree(groups, [
    { id: 10, groupId: 1, powerW: 1000 },
    { id: 20, groupId: 2, powerW: 400 },
    { id: 30, groupId: 3, powerW: 100 },
  ]);
  assert.equal(tree.get(1).contributionW, 1000);
  assert.equal(tree.get(2).contributionW, 0);
  assert.equal(tree.get(3).contributionW, 0); // auch der Enkel bleibt gesperrt
});

test('readGroupPowerTree: Zählergruppe OHNE Haken sperrt nicht', () => {
  const groups = [
    { id: 1, parentId: null, meterGroup: true, offsetTotalConsumption: false },
    { id: 2, parentId: 1, meterGroup: false, offsetTotalConsumption: true },
  ];
  const tree = readGroupPowerTree(groups, [
    { id: 10, groupId: 1, powerW: 1000 },
    { id: 20, groupId: 2, powerW: 400 },
  ]);
  // Zählergruppe ohne Haken: trägt selbst nichts bei …
  assert.equal(tree.get(1).contributionW, 0);
  // … und sperrt nicht: die Untergruppe zählt mit ihren eigenen Geräten.
  assert.equal(tree.get(2).contributionW, 400);
});

test('readGroupPowerTree: Zählergruppe kappt negative Sonstige bei 0', () => {
  const groups = [
    { id: 1, parentId: null, meterGroup: true, offsetTotalConsumption: true },
    { id: 2, parentId: 1, meterGroup: false, offsetTotalConsumption: true },
  ];
  // Untergruppe misst mehr als der Zähler (Messrauschen) → Sonstige nicht negativ.
  const tree = readGroupPowerTree(groups, [
    { id: 10, groupId: 1, powerW: 300 },
    { id: 20, groupId: 2, powerW: 500 },
  ]);
  assert.equal(tree.get(1).sonstigeW, 0);
  // Global trägt die Zählergruppe ihren vollen (fixen) Zweigwert bei.
  assert.equal(tree.get(1).contributionW, 300);
  assert.equal(tree.get(2).contributionW, 0);
});

test('readGroupPowerTree: Gesamt bleibt null, wenn Ast keinerlei Werte liefert', () => {
  const groups = [
    { id: 1, parentId: null },
    { id: 2, parentId: 1 },
  ];
  const values = [
    { id: 10, groupId: 1, powerW: null },
    { id: 20, groupId: 2, powerW: null },
  ];
  const tree = readGroupPowerTree(groups, values);
  assert.equal(tree.get(1).ebeneW, null);
  assert.equal(tree.get(1).gesamtW, null);
  // Liefert eine Untergruppe einen Wert, zählt die Ebene der Elterngruppe als 0.
  const tree2 = readGroupPowerTree(groups, [
    { id: 10, groupId: 1, powerW: null },
    { id: 20, groupId: 2, powerW: 300 },
  ]);
  assert.equal(tree2.get(1).ebeneW, null);
  assert.equal(tree2.get(1).gesamtW, 300);
});

// --- Zähler-Gegenprobe (Guardrail gegen stille Fehlzählung, z. B. Wh statt kWh) ---

test('counterPowerMismatch warnt, wenn Zähler-Energie stark von der Leistungs-Energie abweicht', () => {
  const actor = { counterTopic: 'c', powerTopic: 'p' };
  // Zähler zählt heute fast nichts, Leistung integriert 0,08 kWh → Faktor >> 3 → warnen.
  assert.equal(
    counterPowerMismatch(actor, { counterTotalKwh: 100.0004, dayStartKwh: 100, powerEnergyKwh: 0.08, powerEnergyDayStart: 0 }).warn,
    true
  );
  // Konsistent (0,075 vs 0,08) → keine Warnung.
  assert.equal(
    counterPowerMismatch(actor, { counterTotalKwh: 100.075, dayStartKwh: 100, powerEnergyKwh: 0.08, powerEnergyDayStart: 0 }).warn,
    false
  );
  // Zu wenig Energie am Tagesanfang (< 0,05 kWh) → keine Warnung trotz Divergenz.
  assert.equal(
    counterPowerMismatch(actor, { counterTotalKwh: 100, dayStartKwh: 100, powerEnergyKwh: 0.02, powerEnergyDayStart: 0 }).warn,
    false
  );
  // Ohne Leistungs-Topic nicht bewertbar.
  assert.equal(counterPowerMismatch({ counterTopic: 'c' }, { counterTotalKwh: 100, dayStartKwh: 0 }), null);
});

test('buildActorSnapshot integriert die Leistungs-Energie und warnt bei fehlkonfiguriertem Zähler', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic, counter_topic, counter_unit) VALUES (1, 'Server', 'p.1', 'c.1', 'kWh')");
  const t0 = new Date('2026-06-15T09:00:00Z').getTime();
  // Zähler steht praktisch (z. B. Wh statt kWh → 1000× zu klein), Leistung 240 W dauerhaft.
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100.0002]]), t0 + 10 * 60 * 1000);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100.0004]]), t0 + 20 * 60 * 1000);
  const [v] = await readActorValues(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100.0004]]), null, t0 + 20 * 60 * 1000);
  assert.equal(v.counterWarning, true);
  assert.ok(v.powerTodayKwh > 0.05);   // Leistung wurde integriert (~0,08 kWh)
  assert.ok(v.counterTodayKwh < 0.01); // Zähler zählte kaum
  await new Promise((resolve) => db.close(resolve));
});

test('buildActorSnapshot: konsistenter Zähler löst keine Warnung aus', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic, counter_topic, counter_unit) VALUES (1, 'Server', 'p.1', 'c.1', 'kWh')");
  const t0 = new Date('2026-06-15T09:00:00Z').getTime();
  // Zähler wächst passend zur Leistung (240 W über 10 min ≈ 0,04 kWh).
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100.04]]), t0 + 10 * 60 * 1000);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100.08]]), t0 + 20 * 60 * 1000);
  const [v] = await readActorValues(db, cacheFrom([[cacheKey(1, 'power'), 240], [cacheKey(1, 'counter'), 100.08]]), null, t0 + 20 * 60 * 1000);
  assert.equal(v.counterWarning, false);
  await new Promise((resolve) => db.close(resolve));
});

test('buildActorSnapshot integriert Leistungs-Energie auch für Geräte ohne Zähler-Topic', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic) VALUES (1, 'AC-PV', 'p.1')");
  const t0 = new Date('2026-06-15T09:00:00Z').getTime();
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 100]]), t0);
  await buildActorSnapshot(db, cacheFrom([[cacheKey(1, 'power'), 100]]), t0 + 10 * 60 * 1000);
  const row = await dbGet(db, 'SELECT power_energy_kwh, power_energy_day_start_kwh FROM mess_schalt_actor_state WHERE actor_id = 1');
  assert.ok(Math.abs(row.power_energy_kwh - 100 * (10 / 60) / 1000) < 1e-9); // 100 W über 10 min
  // Ohne Zähler-Topic keine Gegenprobe-Warnung.
  const [v] = await readActorValues(db, cacheFrom([[cacheKey(1, 'power'), 100]]), null, t0 + 10 * 60 * 1000);
  assert.equal(v.counterWarning, false);
  await new Promise((resolve) => db.close(resolve));
});

// --- Geräte-Verbindungsstatus (offline nur bei schweigender Telemetrie) --------

test('readActorValues meldet offline, wenn Leistung/Zähler länger als die Schwelle schweigen', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic, counter_topic, counter_unit) VALUES (1, 'Server', 'p.1', 'c.1', 'kWh')");
  const now = 5_000_000_000_000;
  // Beide Telemetrie-Topics zuletzt vor 40 min empfangen (> 30 min) → offline.
  const cache = new Map([
    [cacheKey(1, 'power'), { value: 240, receivedAt: now - 40 * 60 * 1000 }],
    [cacheKey(1, 'counter'), { value: 100, receivedAt: now - 40 * 60 * 1000 }],
  ]);
  const [v] = await readActorValues(db, cache, null, now);
  assert.equal(v.offline, true);
  await new Promise((resolve) => db.close(resolve));
});

test('readActorValues: frische Leistung hält das Gerät online, auch wenn der Zähler alt ist', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, power_topic, counter_topic, counter_unit) VALUES (1, 'Server', 'p.1', 'c.1', 'kWh')");
  const now = 5_000_000_000_000;
  // Leistung frisch, Zähler-Topic seit 40 min still → Gerät ist verbunden (nicht offline),
  // und der Zähler wird ohnehin nicht als „veraltet" geführt.
  const cache = new Map([
    [cacheKey(1, 'power'), { value: 240, receivedAt: now - 30 * 1000 }],
    [cacheKey(1, 'counter'), { value: 100, receivedAt: now - 40 * 60 * 1000 }],
  ]);
  const [v] = await readActorValues(db, cache, null, now);
  assert.equal(v.offline, false);
  await new Promise((resolve) => db.close(resolve));
});

test('readActorValues: reines Schalt-Gerät (ohne Telemetrie) wird nie als offline gemeldet', async () => {
  const db = await freshDb();
  await dbRun(db, "INSERT INTO mess_schalt_actors (id, name, switch_topic) VALUES (1, 'Licht', 's.1')");
  const now = 5_000_000_000_000;
  // Schalt-Topic vor 3 h empfangen (Licht lange aus) – kein Telemetrie-Topic ⇒ nicht offline.
  const cache = new Map([[cacheKey(1, 'switch'), { value: '0', receivedAt: now - 3 * 60 * 60 * 1000 }]]);
  const [v] = await readActorValues(db, cache, null, now);
  assert.equal(v.offline, false);
  await new Promise((resolve) => db.close(resolve));
});
