'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const mqttClient = require('../src/mqtt/client');
const { STATE_IDS, loadBatterieConfig, saveBatterieConfig } = require('../src/batterie/config');
const minSocSync = require('../src/batterie/min-soc-sync');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function readMinSoc(db) {
  return new Promise((resolve) => loadBatterieConfig(db, (cfg) => resolve(cfg.minSoc)));
}

async function freshDb({ minSoc = 20, minSocTopic = 'battery.0.minimumSoc', remoteTopic = '0_userdata.0.minSoc' } = {}) {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE batterie_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    soc_topic TEXT NOT NULL DEFAULT '',
    power_topic TEXT NOT NULL DEFAULT '',
    voltage_topic TEXT NOT NULL DEFAULT '',
    temperatur_topic TEXT NOT NULL DEFAULT '',
    min_soc_topic TEXT NOT NULL DEFAULT '',
    remote_topic TEXT NOT NULL DEFAULT '',
    min_soc INTEGER NOT NULL DEFAULT 20,
    capacity_ah REAL NOT NULL DEFAULT 200,
    battery_type TEXT NOT NULL DEFAULT 'lifepo4',
    cell_count INTEGER NOT NULL DEFAULT 16,
    lower_voltage REAL NOT NULL DEFAULT 44.8,
    upper_voltage REAL NOT NULL DEFAULT 55.2,
    charge_efficiency REAL NOT NULL DEFAULT 95,
    discharge_efficiency REAL NOT NULL DEFAULT 95
  )`);
  await dbRun(
    db,
    'INSERT INTO batterie_config (id, min_soc, min_soc_topic, remote_topic) VALUES (1, ?, ?, ?)',
    [minSoc, minSocTopic, remoteTopic]
  );
  return db;
}

function withPublishCapture(fn) {
  const orig = mqttClient.publish;
  const published = [];
  mqttClient.publish = (topic, value) => { published.push([topic, String(value)]); return true; };
  return Promise.resolve(fn(published)).finally(() => { mqttClient.publish = orig; });
}

test.beforeEach(() => {
  mqttClient.getCache().clear();
  minSocSync.resetForTests();
});

test('neuerer Remote-Wert wird als Mindest-SoC übernommen und an das Ziel-Topic weitergegeben', async () => {
  const db = await freshDb({ minSoc: 20 });
  mqttClient.getCache().set(STATE_IDS.minSocRemote, { value: '35', receivedAt: 1000 });
  await withPublishCapture(async (published) => {
    await minSocSync.runSync(db);
    assert.deepEqual(published, [['battery.0.minimumSoc', '35']]);
  });
  assert.equal(await readMinSoc(db), 35);
  await new Promise((resolve) => db.close(resolve));
});

test('Remote-Wert wird auf 5-%-Schritte gerundet und der Rohwert korrigiert', async () => {
  const db = await freshDb({ minSoc: 20 });
  mqttClient.getCache().set(STATE_IDS.minSocRemote, { value: '33', receivedAt: 1000 });
  await withPublishCapture(async (published) => {
    await minSocSync.runSync(db);
    // 33 -> 35 an das Ziel-Topic, und der externe Rohwert 33 wird auf 35 korrigiert.
    assert.deepEqual(published, [['battery.0.minimumSoc', '35'], ['0_userdata.0.minSoc', '35']]);
  });
  assert.equal(await readMinSoc(db), 35);
  await new Promise((resolve) => db.close(resolve));
});

test('noteLocalChange verhindert das Zurückdrehen einer gerade gespeicherten Einstellung', async () => {
  const db = await freshDb({ minSoc: 20 });
  // Älterer Remote-Wert liegt im Cache; der Nutzer speichert danach 25.
  mqttClient.getCache().set(STATE_IDS.minSocRemote, { value: '35', receivedAt: 1000 });
  minSocSync.noteLocalChange();
  await withPublishCapture(async (published) => {
    await minSocSync.runSync(db);
    assert.equal(published.length, 0);
  });
  assert.equal(await readMinSoc(db), 20);
  await new Promise((resolve) => db.close(resolve));
});

test('bereits verarbeiteter Remote-Wert wird nicht erneut übernommen', async () => {
  const db = await freshDb({ minSoc: 20 });
  mqttClient.getCache().set(STATE_IDS.minSocRemote, { value: '35', receivedAt: 1000 });
  await withPublishCapture(async () => {
    await minSocSync.runSync(db);
  });
  assert.equal(await readMinSoc(db), 35);

  // Der Nutzer stellt manuell auf 25 (ohne neuen Broker-Wert am Remote-Topic).
  await new Promise((resolve) => loadBatterieConfig(db, (cfg) => {
    saveBatterieConfig(db, { ...cfg, minSoc: 25 }, () => resolve());
  }));

  await withPublishCapture(async (published) => {
    await minSocSync.runSync(db);
    assert.equal(published.length, 0);
  });
  assert.equal(await readMinSoc(db), 25);
  await new Promise((resolve) => db.close(resolve));
});

test('unveränderter Remote-Wert löst keinen Schreibvorgang aus', async () => {
  const db = await freshDb({ minSoc: 30 });
  mqttClient.getCache().set(STATE_IDS.minSocRemote, { value: '30', receivedAt: 1000 });
  await withPublishCapture(async (published) => {
    await minSocSync.runSync(db);
    assert.equal(published.length, 0);
  });
  assert.equal(await readMinSoc(db), 30);
  await new Promise((resolve) => db.close(resolve));
});

test('ohne Remote-Topic bleibt die Synchronisierung inaktiv', async () => {
  const db = await freshDb({ minSoc: 20, remoteTopic: '' });
  mqttClient.getCache().set(STATE_IDS.minSocRemote, { value: '80', receivedAt: 1000 });
  await withPublishCapture(async (published) => {
    await minSocSync.runSync(db);
    assert.equal(published.length, 0);
  });
  assert.equal(await readMinSoc(db), 20);
  await new Promise((resolve) => db.close(resolve));
});

test('isRelevantEvent erkennt nur Änderungen am Remote-Topic', () => {
  assert.equal(minSocSync.isRelevantEvent({ changedKeys: [STATE_IDS.minSocRemote] }), true);
  assert.equal(minSocSync.isRelevantEvent({ changedKeys: [STATE_IDS.minSoc] }), false);
  assert.equal(minSocSync.isRelevantEvent({ changedKeys: [STATE_IDS.soc] }), false);
});
