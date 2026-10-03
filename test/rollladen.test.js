'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planRoom, HOUR } = require('../src/rollladen/model');
const { position, contact } = require('../src/rollladen/runtime');
const solar = require('../src/rollladen/solar');
const time = require('../src/time-handler');
const day = 100000000;
function step(state = {}, overrides = {}, shutter = {}) {
  return planRoom(state, { now: day, elevation: 20, brightness: 50, ...overrides,
    shutters: [{ id: 1, position: 0, ...shutter }] });
}
const risk = { temperature: 25.6, predictedTemperature: 26, limit: 26, sunReliable: true };
test('Sonnenschutz braucht Raumtemperatur und anhaltende Sonne; eine Stunde Sperre plus Hysterese', () => {
  assert.equal(step({}, {}, { ...risk, sunReliable: false }).decisions[0].target, 0);
  assert.equal(step({}, {}, { ...risk, temperature: null }).decisions[0].target, 0);
  let result = step({}, {}, risk);
  assert.equal(result.decisions[0].target, 100);
  result = step(result.state, { now: day + 1000 });
  result = step(result.state, { now: day + HOUR - 1 });
  assert.equal(result.decisions[0].target, 100);
  result = step(result.state, { now: day + HOUR + 1000 });
  assert.equal(result.decisions[0].target, 0);
  assert.equal(step(result.state, { now: day + HOUR + 2000 }, risk).decisions[0].target, 0);
});
test('Resthelligkeit 0 und 100 an beiden Dämmerungsgrenzen', () => {
  for (const [brightness, elevation, expected] of [[0, -18, 100], [0, -17.99, 0], [0, -12, 0], [100, -0.01, 100], [100, 0.01, 0], [50, -10, 100], [50, -8, 0]]) {
    assert.equal(step({}, { brightness, elevation }).decisions[0].target, expected);
  }
});
test('Manuelle Nachtöffnung bleibt nach Fensteröffnung und Schließen erhalten', () => {
  let r = step({}, { elevation: -10 }, { position: 100 });
  r = step(r.state, { elevation: -10 }, { position: 0, manualChange: true });
  assert.equal(r.state.manual, true);
  r = step(r.state, { elevation: -10 }, { position: 0, contactOpen: true });
  r = step(r.state, { elevation: -10 }, { position: 0 });
  assert.equal(r.decisions[0].target, 0);
  r = step(r.state, { elevation: -10 }, { position: 100, manualChange: true });
  assert.equal(r.state.manual, false);
});
test('Nachtöffnung ohne manuelle Übersteuerung schließt nach Fensterkontakt wieder', () => {
  let r = step({}, { elevation: -10 }, { position: 100 });
  r = step(r.state, { elevation: -10 }, { position: 100, contactOpen: true });
  assert.equal(r.decisions[0].target, 0);
  r = step(r.state, { elevation: -10 }, { position: 0 });
  assert.equal(r.decisions[0].target, 100);
});
test('Kino kehrt tags zur Handposition und nachts zum Nachtschluss zurück', () => {
  let r = step({}, {}, { position: 35, manualChange: true });
  r = step(r.state, {}, { position: 35, cinema: true });
  assert.equal(r.decisions[0].target, 100);
  r = step(r.state, {}, { position: 100 });
  assert.equal(r.decisions[0].target, 35);
  r = step(r.state, { elevation: -10 }, { position: 100, cinema: true });
  assert.equal(r.state.manual, false);
  assert.equal(step(r.state, { elevation: -10 }, { position: 100 }).decisions[0].target, 100);
});
test('Kino hat Vorrang vor Fensteröffnung; außerhalb des Kinos gilt die Kontaktsperre', () => {
  const r = step({}, {}, risk);
  assert.equal(step(r.state, {}, { ...risk, cinema: true, contactOpen: true }).decisions[0].target, 100);
  assert.equal(step({}, { elevation: -10 }, { contactUnknown: true }).decisions[0].target, null);
});
test('Manuell gilt raumweit, automatische Fremdfahrten reaktivieren nicht', () => {
  let r = planRoom({}, { now: day, elevation: 20, brightness: 50, shutters: [{ id: 1, position: 50, manualChange: true }, { id: 2, position: 0 }] });
  assert.equal(r.state.manual, true);
  r = planRoom(r.state, { now: day, elevation: 20, brightness: 50, shutters: [{ id: 1, position: 0 }, { id: 2, position: 0 }] });
  assert.equal(r.state.manual, true);
  assert.equal(r.decisions[0].target, 50);
  r = planRoom(r.state, { now: day, elevation: 20, brightness: 50, shutters: [{ id: 1, position: 0, manualChange: true }, { id: 2, position: 0 }] });
  assert.equal(r.state.manual, false);
});
test('Fehlender Standort löst keinen Nachtschluss aus; invertierte Aktoren und Kontakte', () => {
  assert.equal(step({}, { elevation: null }).decisions[0].target, null);
  assert.equal(position({ openValue: 100, closedValue: 0 }, '25'), 75);
  assert.equal(position({ openValue: 0, closedValue: 100 }, ''), null);
  assert.equal(contact('false', 'true'), false);
  assert.equal(contact('open', 'open'), true);
  assert.equal(contact('unknown', 'true'), null);
});
test('HmIP nutzt Kanal 3 als Istposition und Kanal 4 als Fahrbefehl', () => {
  const command = 'hm-rpc://zentrale/ABC%3A4/LEVEL';
  const actual = 'hm-rpc://zentrale/ABC%3A3/LEVEL';
  assert.equal(runtime.feedbackTopic({ positionTopic: command }), actual);
  assert.equal(runtime.feedbackTopic({ positionTopic: command, positionFeedbackTopic: actual }), actual);
  assert.equal(runtime.feedbackTopic({ positionTopic: 'other://x/ABC%3A4/LEVEL' }), 'other://x/ABC%3A4/LEVEL');
  assert.equal(runtime.position({ openValue: 100, closedValue: 0 }, 100), 0);
  assert.equal(runtime.position({ openValue: 100, closedValue: 0 }, 0), 100);
});
test('Prognose prüft eine volle Stunde Einfall auf das Fenster und verwirft Wolkenlücken', () => {
  time.configure({ timezone: 'Europe/Berlin' });
  const now = Date.parse('2026-06-21T10:00:00Z');
  const config = { latitude: 50, longitude: 10, timezone: 'Europe/Berlin' };
  const forecast = { fetchedAt: now, timezone: 'Europe/Berlin', minutes15: Array.from({ length: 5 }, (_, i) => ({ year: 2026, month: 6, day: 21, hour: 12 + Math.floor(i / 4), minute: i % 4 * 15, dni: 800 })) };
  assert.equal(solar.sustainedSun(config, forecast, 180, now), true);
  assert.equal(solar.sustainedSun(config, forecast, 0, now), false);
  forecast.minutes15[2].dni = 0;
  assert.equal(solar.sustainedSun(config, forecast, 180, now), false);
  assert.equal(solar.sustainedSun(config, null, 180, now), false);
});

const sqlite3 = require('sqlite3');
const fs = require('fs');
const repo = require('../src/rollladen/repository');
const runtime = require('../src/rollladen/runtime');
const modules = require('../src/modules');
const mqtt = require('../src/mqtt/client');
const bus = require('../src/state-bus');
const weather = require('../src/wetter/client');
async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  const source = fs.readFileSync(require.resolve('../src/db'), 'utf8');
  for (const name of ['rollladen', 'rollladen_rooms', 'rollladen_cinema', 'heizung_rooms', 'heimkino_rooms', 'modules', 'mqtt_config', 'sun_intensity_samples', 'heizung_room_sensors']) {
    const sql = source.match(new RegExp('`(CREATE TABLE IF NOT EXISTS ' + name + ' \\([\\s\\S]*?)`'));
    assert.ok(sql, name);
    await repo.run(db, sql[1]);
  }
  for (const col of ['heat_priority', 'cool_priority', 'heat_central_fallback']) await repo.run(db, `ALTER TABLE heizung_rooms ADD COLUMN ${col} INTEGER DEFAULT 0`);
  await repo.run(db, "INSERT INTO heizung_rooms (name, temperature_configured) VALUES ('Wohnzimmer', 0)");
  await repo.run(db, "INSERT INTO mqtt_config (id, latitude, longitude, timezone) VALUES (1,50,10,'Europe/Berlin')");
  await modules.setEnabled(db, 'rollladen', true);
  await modules.setEnabled(db, 'heizung', false);
  await modules.setEnabled(db, 'heimkino', true);
  return db;
}
const actor = { name: 'Terrasse', roomId: 1, orientation: 180, upTopic: 'test/up', downTopic: 'test/down', positionTopic: 'test/pos', contactTopic: 'test/contact', openValue: 0, closedValue: 100, travelSeconds: 60 };
test('Konfiguration validiert Raum, doppelte Aktoren und persistiert Zuordnungen', async () => {
  const db = await freshDb();
  try {
    const id = await repo.save(db, null, actor);
    assert.equal((await repo.list(db))[0].roomId, 1);
    await assert.rejects(repo.save(db, null, actor), /bereits/);
    await assert.rejects(repo.save(db, null, { ...actor, roomId: 999 }), /Raum/);
    await assert.rejects(repo.savePolicy(db, 1, 101), /Resthelligkeit/);
    await repo.savePolicy(db, 1, 0);
    await repo.remember(db, 1, { manual: true });
    assert.equal((await repo.policies(db)).get(1).brightness, 0);
    await repo.run(db, "INSERT INTO heimkino_rooms (name) VALUES ('Kino')");
    await repo.setCinemaRoom(db, 1, 1);
    assert.equal((await repo.all(db, 'SELECT * FROM rollladen_cinema'))[0].room_id, 1);
    await repo.save(db, id, { ...actor, orientation: 90 });
    assert.equal((await repo.list(db))[0].orientation, 90);
  } finally { await new Promise(resolve => db.close(resolve)); }
});
test('HmIP-Wechsel auf echten Istwert verwirft alte Fehlposition und Zielsperre', async () => {
  const db = await freshDb();
  const originalSubscribe = mqtt.subscribeAdHoc;
  const subscribed = [];
  mqtt.subscribeAdHoc = (topic, key) => { subscribed.push({ topic, key }); };
  try {
    const positionTopic = 'hm-rpc://zentrale/ABC%3A4/LEVEL';
    const id = await repo.save(db, null, { ...actor, upTopic: '', downTopic: '', positionTopic,
      openValue: 100, closedValue: 0 });
    await repo.remember(db, 1, { manual: false, shutters: { [id]: {
      observed: 99, fault: 'Ziel nicht bestätigt; Aktor prüfen', failedTarget: 0,
    } } });
    await runtime.init(db);
    const state = (await repo.policies(db)).get(1).memory.shutters[id];
    assert.equal(state.readbackTopic, 'hm-rpc://zentrale/ABC%3A3/LEVEL');
    assert.ok(subscribed.some(entry => entry.topic === state.readbackTopic && entry.key === `rollladen:${id}:position`));
    assert.equal(state.observed, undefined);
    assert.equal(state.fault, undefined);
    assert.equal(state.failedTarget, undefined);
  } finally {
    runtime.stop();
    mqtt.subscribeAdHoc = originalSubscribe;
    await new Promise(resolve => db.close(resolve));
  }
});
test('Laufzeit: keine Wiederholbefehle, Fenster unterbricht Fahrt, Handposition überlebt Neustart und Kino', async () => {
  const db = await freshDb();
  const originalPublish = mqtt.publish, originalFetch = weather.fetchForecast;
  const commands = [];
  weather.fetchForecast = async () => null;
  mqtt.publish = (topic, value) => { commands.push({ topic, value }); return true; };
  let now = Date.now() + 20000;
  // Deterministische Nacht, ohne die reale Uhr oder Einstellungen zu verändern.
  const originalElevation = solar.elevation;
  solar.elevation = () => -15;
  try {
    await repo.save(db, null, actor);
    await runtime.init(db);
    bus.set('rollladen:1:position', 0, now + 3000);
    bus.set('rollladen:1:contact', false);
    await runtime.tick(now);
    assert.equal(commands.at(-1).topic, 'test/down');
    await runtime.tick(now + 1000);
    assert.equal(commands.length, 1);
    // Kontakt öffnet, während die Rückmeldung noch oben steht: trotzdem Stop/Umkehr.
    bus.set('rollladen:1:contact', true);
    await runtime.tick(now + 2000);
    assert.equal(commands.at(-1).topic, 'test/up');
    bus.set('rollladen:1:position', 0, now + 3000);
    await runtime.tick(now + 3000);
    bus.set('rollladen:1:contact', false);
    await runtime.tick(now + 4000);
    assert.equal(commands.at(-1).topic, 'test/down');
    bus.set('rollladen:1:position', 100, now + 5000);
    await runtime.tick(now + 5000);
    bus.set('rollladen:1:position', 0);
    await runtime.tick(now + 6000);
    await runtime.tick(now + 9000);
    assert.equal(runtime.snapshot().get(1).manual, true);
    const count = commands.length;
    bus.set('rollladen:1:contact', true);
    await runtime.tick(now + 10000);
    bus.set('rollladen:1:contact', false);
    await runtime.tick(now + 11000);
    assert.equal(commands.length, count);
    runtime.stop();
    await runtime.init(db);
    bus.set('rollladen:1:position', 0);
    bus.set('rollladen:1:contact', false);
    await runtime.tick(now + 12000);
    assert.equal(runtime.snapshot().get(1).manual, true);
    assert.equal(commands.length, count);
    await repo.run(db, "INSERT INTO heimkino_rooms (name, cinema_on) VALUES ('Kino', 1)");
    await repo.setCinemaRoom(db, 1, 1);
    await runtime.tick(now + 13000);
    assert.equal(commands.at(-1).topic, 'test/down');
    bus.set('rollladen:1:position', 100, now + 14000);
    await runtime.tick(now + 14000);
    await repo.run(db, 'UPDATE heimkino_rooms SET cinema_on=0');
    await runtime.tick(now + 15000);
    assert.equal(commands.at(-1).topic, 'test/up');
  } finally {
    await runtime.tick(now + 16000);
    runtime.stop(); mqtt.publish = originalPublish; weather.fetchForecast = originalFetch; solar.elevation = originalElevation;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Sonnenschutz fährt vor Kühlung, begrenzt deren Wartezeit und verlangt aktive Temperaturregelung', async () => {
  const db = await freshDb();
  const old = { publish: mqtt.publish, fetch: weather.fetchForecast, elevation: solar.elevation, sun: solar.sustainedSun };
  const commands = [];
  mqtt.publish = (topic, value) => { commands.push({ topic, value }); return true; };
  weather.fetchForecast = async () => null;
  solar.elevation = () => 30;
  solar.sustainedSun = () => true;
  const now = Date.now() + 20000;
  try {
    await repo.save(db, null, actor);
    await repo.run(db, 'UPDATE heizung_rooms SET temperature_configured=1');
    await repo.run(db, "INSERT INTO heizung_room_sensors (room_id, name, topic) VALUES (1,'Temperatur','test/temp')");
    await runtime.init(db);
    bus.set('rollladen:1:position', 0, now);
    bus.set('rollladen:1:contact', false, now);
    // Derselbe Cache-Schlüssel wie im bestehenden Klimamodul.
    bus.set(require('../src/heizung/rooms').sensorCacheKey(1), 25.8, now);
    await runtime.tick(now);
    assert.equal(commands.length, 0);
    await modules.setEnabled(db, 'heizung', true);
    await runtime.tick(now + 1000);
    assert.equal(commands.at(-1).topic, 'test/down');
    assert.equal(runtime.coolingHold(1, now + 2000), true);
    bus.set('rollladen:1:position', 100, now + 2000);
    await runtime.tick(now + 2000);
    assert.equal(runtime.coolingHold(1, now + 16 * 60000), false);
    await runtime.tick(now + 16 * 60000);
    assert.equal(commands.length, 1);
  } finally {
    runtime.stop(); mqtt.publish = old.publish; weather.fetchForecast = old.fetch; solar.elevation = old.elevation; solar.sustainedSun = old.sun;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Fehlende Zielbestätigung führt zu Fehler und Handmodus, niemals zu wiederholtem Schließen', async () => {
  const db = await freshDb();
  const oldPublish = mqtt.publish, oldFetch = weather.fetchForecast, oldElevation = solar.elevation;
  const commands = [];
  mqtt.publish = topic => { commands.push(topic); return true; };
  weather.fetchForecast = async () => null;
  solar.elevation = () => -15;
  const now = Date.now() + 20000;
  try {
    await repo.save(db, null, actor);
    await runtime.init(db);
    bus.set('rollladen:1:position', 0, now);
    bus.set('rollladen:1:contact', false, now);
    await runtime.tick(now);
    await runtime.tick(now + 71000);
    await runtime.tick(now + 74000);
    assert.deepEqual(commands, ['test/down']);
    assert.equal(runtime.snapshot().get(1).manual, true);
    assert.match(runtime.snapshot().get(1).fault, /Ziel nicht bestätigt/);
  } finally {
    runtime.stop(); mqtt.publish = oldPublish; weather.fetchForecast = oldFetch; solar.elevation = oldElevation;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Ansicht escaped Benutzernamen und übersetzt Beschriftungen inklusive Status', async () => {
  const render = require('../src/views/rollladen');
  const i18n = require('../src/i18n');
  await i18n.select('en');
  try {
    const html = render({ shutters: [{ ...actor, id: 1, name: '<script>alert(1)</script>' }], rooms: [{ id: 1, name: 'Wohnzimmer' }], statuses: new Map([[1, { reason: 'Nachtschluss', planned: 100, position: 0 }]]) });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /Night closure/);
    assert.match(html, /Shutter control/);
    assert.match(html, /Actual 0% closed/);
  } finally { await i18n.select('de'); }
});

test('Aktivierung ohne Rollläden führt keine zyklischen Datenbank- oder Wetterabfragen aus', async () => {
  const db = await freshDb();
  const oldGet = db.get, oldFetch = weather.fetchForecast;
  let reads = 0, fetches = 0;
  try {
    await runtime.init(db);
    db.get = function (...args) { reads++; return oldGet.apply(this, args); };
    weather.fetchForecast = async () => { fetches++; return null; };
    await runtime.tick(Date.now() + 20 * 60000);
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
  } finally {
    await runtime.tick();
    runtime.stop(); db.get = oldGet; weather.fetchForecast = oldFetch;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Fremde State-Flut startet keine Rollladenauswertung; Fensterkontakt bleibt unmittelbar wirksam', async () => {
  const db = await freshDb();
  const oldGet = db.get, oldFetch = weather.fetchForecast, oldPublish = mqtt.publish;
  let reads = 0;
  const commands = [];
  try {
    await repo.save(db, null, actor);
    weather.fetchForecast = async () => null;
    mqtt.publish = topic => { commands.push(topic); return true; };
    await runtime.init(db);
    db.get = function (...args) { reads++; return oldGet.apply(this, args); };
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 100; i++) bus.ingest('unrelated:power', batch * 100 + i);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(reads, 0, '1000 fremde State-Änderungen dürfen keine DB-Auswertung auslösen');
    bus.set('rollladen:1:position', 100);
    bus.ingest('rollladen:1:contact', true);
    await runtime.tick();
    assert.deepEqual(commands, ['test/up']);
    assert.ok(reads > 0, 'Der zugeordnete Kontakt muss weiterhin sofort ausgewertet werden');
  } finally {
    await runtime.tick();
    runtime.stop(); db.get = oldGet; weather.fetchForecast = oldFetch; mqtt.publish = oldPublish;
    bus.remove('unrelated:power');
    await new Promise(resolve => db.close(resolve));
  }
});

test('Rollladendialog legt bei gültigen Angaben einen gemeinsamen Raum an', async () => {
  const db = await freshDb();
  try {
    await assert.rejects(repo.save(db, null, { ...actor, name: '', newRoomName: 'Arbeitszimmer' }));
    assert.equal((await repo.all(db, 'SELECT id FROM heizung_rooms')).length, 1);
    const id = await repo.save(db, null, { ...actor, roomId: '', newRoomName: 'Arbeitszimmer' });
    const shutter = (await repo.list(db)).find(s => s.id === id);
    const room = (await repo.all(db, 'SELECT * FROM heizung_rooms WHERE id=?', [shutter.roomId]))[0];
    assert.equal(room.name, 'Arbeitszimmer');
    assert.equal(room.temperature_configured, 0);
  } finally { await new Promise(resolve => db.close(resolve)); }
});

test('Übersicht zeigt nur belegte Räume, alle Räume bleiben im Dialog auswählbar', () => {
  const html = require('../src/views/rollladen')({ shutters: [{ ...actor, id: 1 }], rooms: [{ id: 1, name: 'Wohnzimmer' }, { id: 2, name: 'Leerer Raum' }] });
  assert.match(html, /data-shutter-room="1"/);
  assert.doesNotMatch(html, /data-shutter-room="2"/);
  assert.match(html, /<option value="2">Leerer Raum<\/option>/);
  assert.match(html, /<dialog id="shutterDialog"/);
  assert.match(html, /name="newRoomName"/);
  assert.doesNotMatch(html, /action="\/rollladen\/rooms"/);
  assert.doesNotMatch(html, /<details/);
});

test('Laufzeit schließt im Kino trotz offenem Kontakt und öffnet erst nach Kinoende', async () => {
  const db = await freshDb();
  const oldPublish = mqtt.publish, oldFetch = weather.fetchForecast, oldElevation = solar.elevation;
  const commands = [];
  mqtt.publish = topic => { commands.push(topic); return true; };
  weather.fetchForecast = async () => null;
  solar.elevation = () => -15;
  const now = Date.now() + 20000;
  try {
    await repo.save(db, null, actor);
    await repo.run(db, "INSERT INTO heimkino_rooms (name, cinema_on) VALUES ('Kino',1)");
    await repo.setCinemaRoom(db, 1, 1);
    await runtime.init(db);
    bus.set('rollladen:1:position', 0, now);
    bus.set('rollladen:1:contact', true, now);
    await runtime.tick(now);
    assert.deepEqual(commands, ['test/down']);
    bus.set('rollladen:1:position', 100, now + 1000);
    await runtime.tick(now + 1000);
    await runtime.tick(now + 2000);
    assert.deepEqual(commands, ['test/down']);
    await repo.run(db, 'UPDATE heimkino_rooms SET cinema_on=0');
    await runtime.tick(now + 3000);
    assert.deepEqual(commands, ['test/down', 'test/up']);
  } finally {
    runtime.stop(); mqtt.publish = oldPublish; weather.fetchForecast = oldFetch; solar.elevation = oldElevation;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Aktorvalidierung erlaubt Richtungen, Prozent und Kombinationen; leere States kollidieren nicht', async () => {
  const db = await freshDb();
  try {
    await repo.save(db, null, { ...actor, positionTopic: '', openValue: '', closedValue: '' });
    await repo.save(db, null, { ...actor, name: 'Zweiter', upTopic: 'second/up', downTopic: 'second/down', positionTopic: '' });
    await repo.save(db, null, { ...actor, name: 'Prozent', upTopic: '', downTopic: '', positionTopic: 'percent/position', shadePercent: 65 });
    await repo.save(db, null, { ...actor, name: 'Prozent 2', upTopic: '', downTopic: '', positionTopic: 'percent2/position' });
    await assert.rejects(repo.save(db, null, { ...actor, upTopic: '', downTopic: '', positionTopic: '' }), /zusammen/);
    await assert.rejects(repo.save(db, null, { ...actor, downTopic: '', positionTopic: '' }), /zusammen/);
    await assert.rejects(repo.save(db, null, { ...actor, upTopic: '', positionTopic: '' }), /zusammen/);
    assert.equal((await repo.list(db)).length, 4);
  } finally { await new Promise(resolve => db.close(resolve)); }
});

test('Befehlsauswahl verwendet Richtungen an Endlagen und Prozent für Zwischenpositionen', () => {
  const { command } = require('../src/rollladen/actuator');
  assert.deepEqual(command({ ...actor, upValue: 'true' }, 0), { topic: actor.upTopic, value: 'true', kind: 'up' });
  assert.deepEqual(command({ ...actor, downValue: 'true' }, 100), { topic: actor.downTopic, value: 'true', kind: 'down' });
  assert.deepEqual(command(actor, 65), { topic: actor.positionTopic, value: 65, kind: 'position' });
  assert.equal(command({ ...actor, positionTopic: '' }, 65), null);
  assert.equal(command({ ...actor, upTopic: '', downTopic: '', openValue: 100, closedValue: 0 }, 100).value, 0);
  assert.equal(step({}, {}, { ...risk, shadePercent: 65 }).decisions[0].target, 65);
});

test('Prozent-Aktor fährt Endlagen und stellt manuelle Zwischenlage nach Kino wieder her', async () => {
  const db = await freshDb();
  const oldPublish = mqtt.publish, oldFetch = weather.fetchForecast, oldElevation = solar.elevation;
  const commands = [];
  mqtt.publish = (topic, value) => { commands.push({ topic, value }); return true; };
  weather.fetchForecast = async () => null;
  solar.elevation = () => 30;
  const now = Date.now() + 20000;
  try {
    await repo.save(db, null, { ...actor, upTopic: '', downTopic: '' });
    await repo.remember(db, 1, { night: false, manual: true, manualTargets: { 1: 35 } });
    await repo.run(db, "INSERT INTO heimkino_rooms (name, cinema_on) VALUES ('Kino',1)");
    await repo.setCinemaRoom(db, 1, 1);
    await runtime.init(db);
    bus.set('rollladen:1:position', 35, now);
    bus.set('rollladen:1:contact', false, now);
    await runtime.tick(now);
    assert.deepEqual(commands.at(-1), { topic: actor.positionTopic, value: 100 });
    bus.set('rollladen:1:position', 100, now + 1000);
    await runtime.tick(now + 1000);
    await repo.run(db, 'UPDATE heimkino_rooms SET cinema_on=0');
    await runtime.tick(now + 2000);
    assert.deepEqual(commands.at(-1), { topic: actor.positionTopic, value: 35 });
  } finally {
    runtime.stop(); mqtt.publish = oldPublish; weather.fetchForecast = oldFetch; solar.elevation = oldElevation;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Richtungsaktor ohne Prozent fährt einmal, behält Endlage nach Neustart und übernimmt Handbefehl', async () => {
  const db = await freshDb();
  const oldPublish = mqtt.publish, oldFetch = weather.fetchForecast, oldElevation = solar.elevation;
  const commands = [];
  mqtt.publish = topic => { commands.push(topic); return true; };
  weather.fetchForecast = async () => null;
  solar.elevation = () => -15;
  const now = Date.now() + 20000;
  try {
    await repo.save(db, null, { ...actor, positionTopic: '' });
    await runtime.init(db);
    bus.set('rollladen:1:contact', false, now);
    bus.set('rollladen:1:up', false, now);
    bus.set('rollladen:1:down', false, now);
    await runtime.tick(now);
    assert.deepEqual(commands, ['test/down']);
    bus.set('rollladen:1:down', true, now + 1000);
    await runtime.tick(now + 1000);
    assert.equal(runtime.snapshot().get(1).manual, false);
    await runtime.tick(now + 71000);
    await runtime.tick(now + 72000);
    assert.deepEqual(commands, ['test/down']);
    assert.equal(runtime.snapshot().get(1).estimated, true);
    assert.equal(runtime.snapshot().get(1).position, 100);
    assert.equal(runtime.snapshot().get(1).fault, undefined);
    runtime.stop(); await runtime.init(db);
    bus.set('rollladen:1:contact', false, now + 73000);
    bus.set('rollladen:1:up', false, now + 73000);
    await runtime.tick(now + 73000);
    assert.deepEqual(commands, ['test/down']);
    bus.set('rollladen:1:up', true, now + 74000);
    await runtime.tick(now + 74000);
    assert.equal(runtime.snapshot().get(1).manual, true);
    await runtime.tick(now + 150000);
    assert.deepEqual(commands, ['test/down']);
  } finally {
    runtime.stop(); mqtt.publish = oldPublish; weather.fetchForecast = oldFetch; solar.elevation = oldElevation;
    await new Promise(resolve => db.close(resolve));
  }
});

test('Regler-Endlagen und Zwischenlagen sind unabhängig von der Prozentkonvention', async () => {
  const { command } = require('../src/rollladen/actuator');
  const inverted = { ...actor, upTopic: '', downTopic: '', openValue: 100, closedValue: 0 };
  assert.equal(command(inverted, 0).value, 100);
  assert.equal(command(inverted, 100).value, 0);
  assert.equal(command(inverted, 25).value, 75);
  assert.equal(command({ ...inverted, openValue: 0, closedValue: 100 }, 25).value, 25);
  assert.equal(step({}, {}, { ...risk, shadePercent: 0 }).decisions[0].target, 0);
  const db = await freshDb();
  try {
    await repo.save(db, null, { ...actor, shadePercent: 0 });
    assert.equal((await repo.list(db))[0].shadePercent, 0);
  } finally { await new Promise(resolve => db.close(resolve)); }
  const html = require('../src/views/rollladen')();
  assert.match(html, /name="shadePercent" type="range" min="0" max="100"/);
  assert.match(html, /<span>Offen<\/span>/);
  assert.match(html, /<span>Geschlossen<\/span>/);
});

test('Status-API liest nur den Laufzeitcache und schützt JSON-Zugriffe', async () => {
  const db = await freshDb();
  const oldSnapshot = runtime.snapshot;
  const brightnessTopic = 'system://homeess/prognose.helligkeit';
  const previousBrightness = bus.getCache().get(brightnessTopic);
  bus.set(brightnessTopic, 42);
  const fakeDb = new Proxy({}, { get() { throw new Error('Status darf nicht auf die DB zugreifen'); } });
  const router = require('../src/routes/rollladen')(fakeDb);
  const handler = router.stack.find(layer => layer.route?.path === '/rollladen/status').route.stack[0].handle;
  const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } });
  try {
    runtime.snapshot = () => new Map([[1, { position: 25, planned: 75, manual: true, reason: 'Heimkino', fault: '<b>Fehler</b>' }]]);
    let res = response();
    handler({}, res);
    assert.equal(res.code, 401);
    res = response(); handler({ session: {} }, res);
    assert.equal(res.code, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.brightness, '42 %');
    bus.set(brightnessTopic, 0);
    const night = response(); handler({ session: {} }, night);
    assert.equal(night.body.brightness, '0 %');
    bus.remove(brightnessTopic);
    const unknown = response(); handler({ session: {} }, unknown);
    assert.equal(unknown.body.brightness, '— %');
    assert.equal(res.body.shutters[0].actual, 'Ist 25% geschlossen');
    assert.equal(res.body.shutters[0].manual, true);
    await modules.setEnabled(db, 'rollladen', false);
    res = response(); handler({ session: {} }, res);
    assert.equal(res.code, 403);
  } finally { if (previousBrightness) bus.getCache().set(brightnessTopic, previousBrightness); else bus.remove(brightnessTopic); runtime.snapshot = oldSnapshot; await new Promise(resolve => db.close(resolve)); }
});

test('Live-Skript aktualisiert Status ohne Dialogeingaben anzufassen und begrenzt Abfragen', async () => {
  const vm = require('node:vm');
  const html = require('../src/views/rollladen')({ shutters: [{ ...actor, id: 1 }], rooms: [{ id: 1, name: 'Wohnzimmer' }] });
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('var shutterItems ='));
  const fields = Object.fromEntries(['actual', 'planned', 'reason', 'fault'].map(k => [k, { textContent: '', hidden: false }]));
  const brightness = { textContent: '— %' };
  const badge = { textContent: '', classList: { toggle() {} } };
  const form = { elements: { shadePercent: { value: '37' }, name: { value: 'Ungespeichert' } }, addEventListener() {} };
  let resolveFetch, fetchCount = 0;
  const intervals = [];
  const context = {
    AbortController, Map,
    setTimeout: () => 1, clearTimeout() {}, setInterval: (callback, delay) => intervals.push({ callback, delay }),
    fetch: () => { fetchCount++; return new Promise(resolve => { resolveFetch = resolve; }); },
    document: {
      hidden: false, getElementById: () => form, addEventListener() {},
      querySelector(selector) {
        if (selector === '[data-shutter-brightness]') return brightness;
        if (selector === '[data-shutter-mode="1"]') return badge;
        if (selector === '[data-shutter-id="1"]') return { querySelector: s => fields[s.slice(14, -1)] };
        return null;
      },
    },
  };
  vm.runInNewContext(script, context);
  assert.equal(fetchCount, 1);
  assert.equal(intervals[0].delay, 5000);
  await context.pollShutterStatus();
  assert.equal(fetchCount, 1, 'Keine parallelen Polls');
  resolveFetch({ ok: true, status: 200, json: async () => ({ brightness: '42 %', shutters: [{ id: 1, actual: 'Ist 75% geschlossen', planned: 'Plan 100% geschlossen', reason: 'Heimkino', fault: '<img src=x>', manual: true }] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fields.actual.textContent, 'Ist 75% geschlossen');
  assert.equal(brightness.textContent, '42 %');
  assert.equal(fields.fault.textContent, '<img src=x>');
  assert.equal(badge.textContent, 'Manuell');
  assert.equal(form.elements.shadePercent.value, '37');
  assert.equal(form.elements.name.value, 'Ungespeichert');
  context.applyShutterStatus({ shutters: [{ id: 1, actual: 'Ist 0% geschlossen', planned: 'Plan 0% geschlossen', reason: 'Tagesposition', fault: '', manual: false }] });
  assert.equal(fields.fault.hidden, true);
  assert.equal(badge.textContent, 'Automatik');
  context.document.hidden = true;
  await context.pollShutterStatus();
  assert.equal(fetchCount, 1);
});
