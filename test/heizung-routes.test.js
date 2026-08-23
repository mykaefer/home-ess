'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-heizung-routes-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { openDatabase } = require('../src/db');
const modules = require('../src/modules');
const heizungRoutes = require('../src/routes/heizung');
const runtime = require('../src/heizung/runtime');
const rooms = require('../src/heizung/rooms');
const actionsRepo = require('../src/heizung/actions');
const central = require('../src/heizung/central');
const billing = require('../src/heizung/billing');
const mqttClient = require('../src/mqtt/client');

let db;
let server;
let baseUrl;
let originalPublish;
const writes = [];

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function form(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  };
}

// Genau so schickt der Browser eine Checkbox: das versteckte „0"-Feld steht vor
// dem angehakten „1"-Feld, beide unter demselben Namen. express liefert daraus
// ein Array — maßgeblich ist der letzte Wert.
function formWithCheckbox(body, checkboxes) {
  const params = new URLSearchParams(body);
  for (const [name, checked] of Object.entries(checkboxes)) {
    params.append(name, '0');
    if (checked) params.append(name, '1');
  }
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  };
}

test.before(async () => {
  db = openDatabase();
  await new Promise((resolve) => setTimeout(resolve, 300));
  originalPublish = mqttClient.publish;
  mqttClient.publish = (topic, value) => { writes.push({ topic, value }); return true; };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const { fullAccess, runWithAccess } = require('../src/auth/access');
  app.use((req, res, next) => {
    req.session = { id: 'test-session', userId: 1 };
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(heizungRoutes(db));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  runtime.stop();
  mqttClient.publish = originalPublish;
  if (server) server.close();
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Ohne aktives Modul führt /heizung zurück zur Modulverwaltung', async () => {
  const response = await fetch(`${baseUrl}/heizung`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/module');
});

test('Räume, Temperaturquellen und Kontakte laufen über die Seiten', async () => {
  await modules.setEnabled(db, 'heizung', true);
  await runtime.init(db);

  const created = await fetch(`${baseUrl}/heizung/rooms`, form({
    name: 'Wohnzimmer', targetTemp: '21', heatOffset: '0', coolOffset: '5', hysteresis: '0.5',
  }));
  assert.equal(created.status, 302);
  const [room] = await rooms.listRooms(db);
  assert.equal(room.name, 'Wohnzimmer');
  assert.equal(room.targetTemp, 21);

  const overview = await fetch(`${baseUrl}/heizung`).then((res) => res.text());
  assert.match(overview, new RegExp(`href="/heizung/raum/${room.id}"`));
  assert.match(overview, /Nur Messung/);

  // Doppelter Name: die Übersicht öffnet den Dialog erneut mit der Meldung.
  const duplicate = await fetch(`${baseUrl}/heizung/rooms`, form({
    name: 'wohnzimmer', targetTemp: '21', hysteresis: '0.5',
  }));
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /gibt es bereits/);

  // Einstellungen des Raums inkl. Zentralheizungs-Freigabe.
  const saved = await fetch(`${baseUrl}/heizung/raum/${room.id}`, form({
    name: 'Wohnzimmer', targetTemp: '21', heatOffset: '0', coolOffset: '5', coolMinTemp: '28',
    hysteresis: '0.4', centralAllowed: '1', centralTemp: '4', fanTopic: 'custom://Luefter',
    contactDelaySeconds: '300',
  }));
  assert.equal(saved.status, 302);
  const updated = await rooms.getRoom(db, room.id);
  assert.equal(updated.fanTopic, 'custom://Luefter');
  assert.equal(updated.hysteresis, 0.4);
  assert.equal(updated.coolMinTemp, 28);
  assert.equal(updated.centralAllowed, true);
  assert.equal(updated.centralTemp, 4);
  assert.equal(updated.contactDelaySeconds, 300);

  // Freigabe ohne Grenz-Außentemperatur wird abgelehnt, nicht stillschweigend
  // ergänzt.
  const rejected = await fetch(`${baseUrl}/heizung/raum/${room.id}`, form({
    name: 'Wohnzimmer', targetTemp: '21', hysteresis: '0.4', centralAllowed: '1',
  }));
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /Außentemperatur angeben/);
  assert.equal((await rooms.getRoom(db, room.id)).centralTemp, 4);

  const sensor = await fetch(`${baseUrl}/heizung/raum/${room.id}/sensoren`, form({
    name: 'hDP Fensterseite', topic: 'custom://Temperatur1',
  }));
  assert.equal(sensor.status, 302);
  await fetch(`${baseUrl}/heizung/raum/${room.id}/sensoren`, form({ topic: 'custom://Temperatur2' }));
  assert.equal((await rooms.listSensors(db, room.id)).length, 2);

  const contact = await fetch(`${baseUrl}/heizung/raum/${room.id}/kontakte`, form({
    name: 'Terrassentür', topic: 'custom://Tuer', inverted: '1',
  }));
  assert.equal(contact.status, 302);
  const [savedContact] = await rooms.listContacts(db, room.id);
  assert.equal(savedContact.inverted, true);

  const page = await fetch(`${baseUrl}/heizung/raum/${room.id}`).then((res) => res.text());
  assert.match(page, /Mindesttemperatur zum Kühlen/);
  assert.match(page, /Heizkörperlüfter/);
  assert.match(page, /hDP Fensterseite/);
  assert.match(page, /Terrassentür/);
  assert.match(page, /system:\/\/homeess\/raeume\.Wohnzimmer\.temperatur/);

  // Soll-Temperatur schnell verstellen.
  const target = await fetch(`${baseUrl}/heizung/raum/${room.id}/soll`, form({ targetTemp: '22,5', redirect: 'room' }));
  assert.equal(target.status, 302);
  assert.equal((await rooms.getRoom(db, room.id)).targetTemp, 22.5);

  // Eintrag ohne State wird abgelehnt.
  const invalid = await fetch(`${baseUrl}/heizung/raum/${room.id}/sensoren`, form({ name: 'Ohne State' }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /State mit der Temperatur/);

  await fetch(`${baseUrl}/heizung/raum/${room.id}/kontakte/${savedContact.id}/delete`, form({}));
  assert.equal((await rooms.listContacts(db, room.id)).length, 0);
});

test('Aktionsfolgen der Geräte laufen über die Raumseite', async () => {
  const [room] = await rooms.listRooms(db);

  const created = await fetch(`${baseUrl}/heizung/raum/${room.id}/actions`, form({
    phase: 'heat_on', type: 'write', topic: 'custom://Klima/Modus', operation: 'set', value: 'heat',
  }));
  assert.equal(created.status, 302);
  const loop = await fetch(`${baseUrl}/heizung/raum/${room.id}/actions`, form({
    phase: 'heat_on', type: 'loop', repeats: '2', checkEnabled: '1',
    checkTopic: 'custom://Klima/Status', checkOperator: 'eq', checkValue: '1', checkIntervalSeconds: '60',
  }));
  assert.equal(loop.status, 302);

  const page = await fetch(`${baseUrl}/heizung/raum/${room.id}`).then((res) => res.text());
  assert.match(page, /Heizen einschalten/);
  assert.match(page, /Kühlen ausschalten/);
  assert.match(page, /data-phase="heat_on"/);
  assert.match(page, /hz-loop-zone/);
  assert.match(page, /Prüfung alle 60 s/);

  // Ungültige Eingabe: Seite kommt mit Fehler zurück, nichts wird gespeichert.
  const invalid = await fetch(`${baseUrl}/heizung/raum/${room.id}/actions`, form({
    phase: 'heat_on', type: 'pause', seconds: '0',
  }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Pause muss zwischen/);

  // Drag&Drop: die Wertzuweisung wandert in die Schleife.
  const actions = await actionsRepo.listActions(db, room.id);
  const loopAction = actions.find((action) => action.type === 'loop');
  const writeAction = actions.find((action) => action.type === 'write');
  const layout = await fetch(`${baseUrl}/heizung/raum/${room.id}/layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [
        { id: loopAction.id, phase: 'heat_on', parentId: null, position: 0 },
        { id: writeAction.id, phase: 'heat_on', parentId: loopAction.id, position: 0 },
      ],
    }),
  });
  assert.equal(layout.status, 200);
  const tree = await actionsRepo.actionTree(db, room.id);
  assert.deepEqual(tree.heat_on.map((action) => action.id), [loopAction.id]);
  assert.deepEqual(tree.heat_on[0].children.map((action) => action.id), [writeAction.id]);

  // Die Schleife nimmt beim Löschen ihren Inhalt mit.
  await fetch(`${baseUrl}/heizung/raum/${room.id}/actions/${loopAction.id}/delete`, form({}));
  assert.equal((await actionsRepo.listActions(db, room.id)).length, 0);
});

test('Zentralheizung wird über ihre Seite eingerichtet und geschaltet', async () => {
  const withoutOutdoor = await fetch(`${baseUrl}/heizung/zentrale`, form({
    enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner',
  }));
  assert.equal(withoutOutdoor.status, 400);
  assert.match(await withoutOutdoor.text(), /Außentemperatur/);

  const invalid = await fetch(`${baseUrl}/heizung/zentrale`, form({
    enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
  }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Vorlauf- und Rücklauftemperatur/);

  const saved = await fetch(`${baseUrl}/heizung/zentrale`, form({
    enabled: '1', mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    flowTopic: 'custom://Vorlauf', returnTopic: 'custom://Ruecklauf',
    pumpTopic: 'custom://Pumpe', pumpLeadSeconds: '45', pumpLagSeconds: '600',
    burnerFeedbackTopic: 'custom://Flamme',
    flowDropDelta: '0.3', flowWindowSeconds: '120', maxHoldMinutes: '0',
    consumptionPerHour: '2,5', unit: 'l', pricePerUnit: '1,30',
  }));
  assert.equal(saved.status, 302);
  const config = await central.loadCentralConfig(db);
  assert.equal(config.enabled, true);
  assert.equal(config.burnerFeedbackTopic, 'custom://Flamme');
  assert.equal(config.pumpTopic, 'custom://Pumpe');
  assert.equal(config.pumpLeadSeconds, 45);
  assert.equal(config.pumpLagSeconds, 600);
  assert.equal(config.outdoorTopic, 'custom://Aussen');
  assert.equal(config.consumptionPerHour, 2.5);
  assert.equal(config.pricePerUnit, 1.3);

  const page = await fetch(`${baseUrl}/heizung/zentrale`).then((res) => res.text());
  assert.match(page, /Brennerlaufzeit und Heizkosten/);
  assert.match(page, /Rückmeldung des Brenners/);
  assert.match(page, /Umwälzpumpe/);
  assert.match(page, /Schornsteinfeger-Modus starten/);

  const sweep = await fetch(`${baseUrl}/heizung/zentrale/schornsteinfeger`, form({ on: '1' }));
  assert.equal(sweep.status, 302);
  assert.equal((await central.loadCentralConfig(db)).sweepEnabled, true);
  // Erst die Pumpe: der Brenner wartet auf ihren Vorlauf.
  assert.equal(runtime.centralSnapshot().pumpOn, true);
  assert.ok(writes.some((write) => write.topic === 'custom://Pumpe' && write.value === '1'));

  await fetch(`${baseUrl}/heizung/zentrale/schornsteinfeger`, form({ on: '0' }));
  assert.equal((await central.loadCentralConfig(db)).sweepEnabled, false);

  const status = await fetch(`${baseUrl}/heizung/status`, { headers: { Accept: 'application/json' } })
    .then((res) => res.json());
  assert.ok(Array.isArray(status.rooms));
  // Die Übersicht führt Hinweise und Soll-Temperatur live nach — dafür müssen
  // sie in der Statusantwort stehen.
  assert.ok(Object.prototype.hasOwnProperty.call(status.rooms[0], 'note'));
  assert.ok(Object.prototype.hasOwnProperty.call(status.rooms[0], 'targetTemp'));
  assert.ok(Object.prototype.hasOwnProperty.call(status.central, 'note'));
  assert.ok(Object.prototype.hasOwnProperty.call(status.central, 'burnerOn'));
  assert.equal(status.central.enabled, true);
  assert.equal(typeof status.stats.todayHours, 'number');
});

test('Checkboxen aus dem Browser kommen als verstecktes 0 plus 1 an', async () => {
  // Regression: das Formular schickt beide Werte; wurde nur der erste gelesen,
  // blieb die Zentralheizung nach dem Speichern „nicht eingerichtet".
  const saved = await fetch(`${baseUrl}/heizung/zentrale`, formWithCheckbox({
    mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    flowTopic: 'custom://Vorlauf', returnTopic: 'custom://Ruecklauf',
    pumpTopic: 'custom://Pumpe', pumpLeadSeconds: '45', pumpLagSeconds: '600',
    flowDropDelta: '0.3', flowWindowSeconds: '120', maxHoldMinutes: '0',
    consumptionPerHour: '2,5', unit: 'l', pricePerUnit: '1,30',
  }, { enabled: true }));
  assert.equal(saved.status, 302);
  assert.equal((await central.loadCentralConfig(db)).enabled, true);

  // Die Übersicht zeigt die Zentralheizung danach als eingerichtet.
  const overview = await fetch(`${baseUrl}/heizung`).then((res) => res.text());
  assert.ok(!overview.includes('Nicht eingerichtet'), 'Übersicht zeigt die Zentralheizung als eingerichtet');
  assert.match(overview, /Brenner/);

  // Abwählen kommt genauso an.
  const off = await fetch(`${baseUrl}/heizung/zentrale`, formWithCheckbox({
    mode: 'relais', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    flowTopic: 'custom://Vorlauf', returnTopic: 'custom://Ruecklauf',
  }, { enabled: false }));
  assert.equal(off.status, 302);
  assert.equal((await central.loadCentralConfig(db)).enabled, false);

  // Dasselbe für die Freigabe der Zentralheizung und den invertierten Kontakt.
  const [room] = await rooms.listRooms(db);
  const roomSaved = await fetch(`${baseUrl}/heizung/raum/${room.id}`, formWithCheckbox({
    name: room.name, targetTemp: '21', heatOffset: '0', coolOffset: '5', hysteresis: '0.4',
    centralTemp: '4', contactDelaySeconds: '0',
  }, { centralAllowed: true }));
  assert.equal(roomSaved.status, 302);
  assert.equal((await rooms.getRoom(db, room.id)).centralAllowed, true);

  const contact = await fetch(`${baseUrl}/heizung/raum/${room.id}/kontakte`, formWithCheckbox({
    name: 'Fenster', topic: 'custom://Fenster',
  }, { inverted: true }));
  assert.equal(contact.status, 302);
  const [saved2] = await rooms.listContacts(db, room.id);
  assert.equal(saved2.inverted, true);
});

test('Prioritäten und Ersatzschaltung laufen über ein eigenes Formular', async () => {
  const [room] = await rooms.listRooms(db);
  // Der Raum darf die Zentralheizung anfordern (aus dem vorigen Test).
  assert.equal((await rooms.getRoom(db, room.id)).centralAllowed, true);

  const page = await fetch(`${baseUrl}/heizung/raum/${room.id}`).then((res) => res.text());
  assert.match(page, /Priorität Heizgerät/);
  assert.match(page, /1 – höchste/);
  assert.match(page, /darf die Zentralheizung einspringen/);

  const saved = await fetch(`${baseUrl}/heizung/raum/${room.id}/prioritaeten`, formWithCheckbox({
    heatPriority: '4', coolPriority: '5',
  }, { heatCentralFallback: true }));
  assert.equal(saved.status, 302);
  const updated = await rooms.getRoom(db, room.id);
  assert.equal(updated.heatPriority, 4);
  assert.equal(updated.coolPriority, 5);
  assert.equal(updated.heatCentralFallback, true);
  // Die übrigen Einstellungen des Raums bleiben unberührt.
  assert.equal(updated.centralTemp, 4);
  assert.equal(updated.hysteresis, 0.4);

  // Ohne Freigabe der Zentralheizung wird die Ersatzschaltung abgelehnt.
  await rooms.updateRoom(db, room.id, { ...updated, heatCentralFallback: false, centralAllowed: false });
  const rejected = await fetch(`${baseUrl}/heizung/raum/${room.id}/prioritaeten`, formWithCheckbox({
    heatPriority: '2', coolPriority: '4',
  }, { heatCentralFallback: true }));
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /nur einspringen, wenn der Raum sie anfordern darf/);
});

test('Das Zählwerk steht als Kachel auf der Übersicht und lässt sich abschließen', async () => {
  // Die Zentralheizung ist aus dem vorigen Test eingerichtet.
  await central.saveCentralConfig(db, {
    enabled: '1', mode: 'modbus', switchTopic: 'custom://Brenner', outdoorTopic: 'custom://Aussen',
    consumptionPerHour: '2', unit: 'l', pricePerUnit: '1,50',
  });

  const page = await fetch(`${baseUrl}/heizung`).then((res) => res.text());
  assert.match(page, /Heizkosten-Zählwerk/);
  assert.match(page, /Monatsabschlag/);
  assert.match(page, /Zeitraum abschließen/);
  assert.match(page, /Kosten ÷ 12 Monate/);
  assert.match(page, /heizungResetDialog/);

  // Startwert setzen.
  const startwert = await fetch(`${baseUrl}/heizung/zaehlwerk/startwert`, form({ startConsumption: '120,5' }));
  assert.equal(startwert.status, 302);
  assert.equal((await billing.loadBilling(db)).startConsumption, 120.5);

  // Unsinn wird abgelehnt und die Seite kommt mit der Meldung zurück.
  const invalid = await fetch(`${baseUrl}/heizung/zaehlwerk/startwert`, form({ startConsumption: 'abc' }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Startwert/);

  // Zeitraum abschließen (Checkbox wie im Browser, hier ohne Kalibrierung).
  const closed = await fetch(`${baseUrl}/heizung/zaehlwerk/reset`,
    formWithCheckbox({ metered: '200' }, { calibrate: false }));
  assert.equal(closed.status, 302);
  const after = await billing.loadBilling(db);
  assert.equal(after.startConsumption, 0);
  assert.equal(after.previousMetered, 200);
  assert.equal(after.lastCalibrationFactor, null);
  // Der Verbrauch je Betriebsstunde bleibt ohne Häkchen unangetastet.
  assert.equal((await central.loadCentralConfig(db)).consumptionPerHour, 2);

  const afterPage = await fetch(`${baseUrl}/heizung`).then((res) => res.text());
  assert.match(afterPage, /Vorheriger Zeitraum/);
  assert.match(afterPage, /abgelesen/);
});
