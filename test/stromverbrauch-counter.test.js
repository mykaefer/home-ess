'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-strom-counter-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { updateCounterStates, resetCountersForChangedTopics } = require('../src/stromverbrauch/aggregation');
const { deriveEigenverbrauch, deriveEigenverbrauchPower } = require('../src/stromverbrauch/aggregation');
const { EINSPEISUNG_ZAEHLER_L2_STATE_ID } = require('../src/stromverbrauch/config');

test('Eigenverbrauch zieht Akkuladung ab und rechnet Akkuentladung hinzu', () => {
  assert.equal(deriveEigenverbrauch(10, 2, 1, { charge: 3, discharge: 0 }), 8);
  assert.equal(deriveEigenverbrauch(0, 0, 0, { charge: 0, discharge: 1.5 }), 1.5);
});

test('Eigenverbrauchsleistung übernimmt den Wechselrichterwert und ergänzt nur Verbraucher-PV', () => {
  assert.equal(deriveEigenverbrauchPower(1200, null), 1200);
  assert.equal(deriveEigenverbrauchPower(1200, 350), 1550);
  assert.equal(deriveEigenverbrauchPower(null, 350), 350);
});

function freshDb() {
  fs.rmSync(process.env.HOME_ESS_DB, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

const DAY = { dateKey: '2026-07-02' };

test('Zählertausch beim Topic-Wechsel wird nicht als Zählersprung gezählt', async () => {
  const db = await freshDb();
  const cache = new Map();

  // Alter Zähler zählt normal hoch: 5000 -> 5010 kWh (echter Zuwachs 10 kWh).
  cache.set(EINSPEISUNG_ZAEHLER_L2_STATE_ID, { value: 5000 });
  await updateCounterStates(db, cache, DAY);
  cache.set(EINSPEISUNG_ZAEHLER_L2_STATE_ID, { value: 5010 });
  await updateCounterStates(db, cache, DAY);

  let row = await dbGet(db, "SELECT last_raw_value, day_total FROM stromverbrauch_counter_state WHERE counter_key = 'export_l2'");
  assert.equal(row.last_raw_value, 5010);
  assert.equal(Math.round(row.day_total * 100) / 100, 10);

  // Topic-Wechsel (Zählertausch / anderer Adapter): Rohstand zurücksetzen. In der
  // echten Route leert setStateDefinitions zusätzlich den Value-Cache – hier
  // simuliert durch das Setzen des neuen Zählerstands.
  const resetKeys = await resetCountersForChangedTopics(
    db,
    { einspeisungZaehlerL2Topic: 'altes/topic' },
    { einspeisungZaehlerL2Topic: 'modbus://gx/neu' }
  );
  assert.deepEqual(resetKeys, ['export_l2']);

  // Neuer Zähler steht bei 144 kWh (viel niedriger als der alte). Ohne Fix würde
  // der komplette Stand (~144) als Tageszuwachs gezählt.
  cache.set(EINSPEISUNG_ZAEHLER_L2_STATE_ID, { value: 144 });
  await updateCounterStates(db, cache, DAY);

  row = await dbGet(db, "SELECT last_raw_value, day_total FROM stromverbrauch_counter_state WHERE counter_key = 'export_l2'");
  assert.equal(row.last_raw_value, 144, 'neuer Zählerstand wird als Ist-Stand übernommen');
  assert.equal(Math.round(row.day_total * 100) / 100, 10, 'kein Sprung gezählt – day_total unverändert');

  // Ab jetzt zählt der neue Zähler wieder korrekt weiter: 144 -> 145 = +1 kWh.
  cache.set(EINSPEISUNG_ZAEHLER_L2_STATE_ID, { value: 145 });
  await updateCounterStates(db, cache, DAY);
  row = await dbGet(db, "SELECT day_total FROM stromverbrauch_counter_state WHERE counter_key = 'export_l2'");
  assert.equal(Math.round(row.day_total * 100) / 100, 11);
  db.close();
});

test('resetCountersForChangedTopics setzt nur wirklich geänderte Zähler zurück', async () => {
  const db = await freshDb();
  const same = {
    netzbezugZaehlerL1Topic: 'a', netzbezugZaehlerL2Topic: 'b', netzbezugZaehlerL3Topic: 'c',
    einspeisungZaehlerL1Topic: 'd', einspeisungZaehlerL2Topic: 'e', einspeisungZaehlerL3Topic: 'f',
  };
  assert.deepEqual(await resetCountersForChangedTopics(db, same, same), []);
  const changed = { ...same, netzbezugZaehlerL1Topic: 'a2', einspeisungZaehlerL3Topic: 'f2' };
  assert.deepEqual(await resetCountersForChangedTopics(db, same, changed), ['import_l1', 'export_l3']);
  db.close();
});
