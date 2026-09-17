'use strict';

// Tests des zentralen Nachrichtensystems: Versandweg über den bestehenden
// Relay-WebSocket, Flankenerkennung der Trigger, Cooldown, Regel-CRUD und die
// Zusagen gegenüber der State-Verarbeitung (nichts blockiert, nichts bricht ab).

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { EventEmitter } = require('events');

const { createRelayConnection } = require('../src/remote-access/relay-connection');
const service = require('../src/notifications/service');
const repository = require('../src/notifications/rules');
const engine = require('../src/notifications/engine');
const { matches, valueType } = require('../src/notifications/triggers');
const bus = require('../src/state-bus');
const mqttClient = require('../src/mqtt/client');
const { testMessage } = require('../src/routes/notifications');

const INSTANCE_ID = 'ins_test1234567890';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
}

async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE notification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    state_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('changed', 'equals', 'not_equals', 'above', 'below')),
    trigger_value TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal', 'critical')),
    cooldown_seconds INTEGER NOT NULL DEFAULT 5,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_triggered_at INTEGER)`);
  return db;
}

function ruleInput(overrides = {}) {
  return {
    name: 'Türklingel',
    enabled: '1',
    stateId: 'custom://Klingel',
    triggerType: 'equals',
    triggerValue: 'true',
    title: 'Türklingel',
    body: 'Es klingelt an der Tür.',
    eventType: 'doorbell',
    severity: 'normal',
    cooldownSeconds: '5',
    ...overrides,
  };
}

// ── Versand über den bestehenden Relay-WebSocket ────────────────────────────

function makeFakeWs() {
  const created = [];
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url; this.opts = opts;
      this.readyState = FakeWs.OPEN; this.sent = []; this.closed = false;
      created.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.emit('close', 1000); }
    terminate() { this.closed = true; }
    open() { this.emit('open'); }
    serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj), 'utf8'), false); }
    lastSent() { return this.sent[this.sent.length - 1]; }
  }
  FakeWs.OPEN = 1;
  return { FakeWs, created };
}

async function authenticatedConnection() {
  const { FakeWs, created } = makeFakeWs();
  const conn = createRelayConnection({
    wsUrl: 'wss://relay.example/ws',
    WebSocketImpl: FakeWs,
    identityStore: {
      async getProvisionedIdentity() { return { instanceId: INSTANCE_ID }; },
      async signRelayChallenge() { return 'c2lnbmF0dXJl'; },
    },
    logger: () => {},
    backoffMs: [1000],
    authTimeoutMs: 1000,
    idleTimeoutMs: 100000,
    pushTimeoutMs: 60,
  });
  conn.start();
  await tick();
  const ws = created[0];
  ws.open();
  ws.serverSend({
    type: 'challenge', challengeId: 'ch_abc12345',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15000).toISOString(),
    protocolVersion: '0.1', clientType: 'homeess', identityId: INSTANCE_ID,
  });
  await tick();
  ws.serverSend({
    type: 'authenticated', protocolVersion: '0.1', clientType: 'homeess',
    identityId: INSTANCE_ID, connectionId: 'conn_x',
    capabilities: { authenticatedWebSocket: true, relayTunnel: false },
  });
  await tick();
  assert.equal(conn.getStatus().state, 'authenticated');
  return { conn, ws };
}

test('NotificationService sendet über den bestehenden authentifizierten Relay-WebSocket', async () => {
  const { conn, ws } = await authenticatedConnection();
  const pending = service.push(
    { title: 'Türklingel', body: 'Es klingelt an der Tür.', type: 'doorbell', severity: 'normal' },
    { connectionService: { getStatus: () => conn.getStatus(), pushNotification: (p) => conn.pushNotification(p) } }
  );
  const sent = ws.lastSent();
  assert.equal(sent.type, 'push_notification');
  assert.equal(sent.title, 'Türklingel');
  assert.equal(sent.body, 'Es klingelt an der Tür.');
  assert.equal(sent.eventType, 'doorbell');
  assert.equal(sent.severity, 'normal');

  ws.serverSend({ type: 'push_notification_result', accepted: true, recipients: 1 });
  assert.deepEqual(await pending, { accepted: true, recipients: 1 });
  conn.shutdown();
});

test('Der Push-Payload enthält weder instanceId noch deviceId noch Empfängerangaben', async () => {
  const { conn, ws } = await authenticatedConnection();
  const pending = conn.pushNotification({ title: 'T', body: 'B', eventType: 'doorbell', severity: 'critical' });
  const sent = ws.lastSent();
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'eventType', 'severity', 'title', 'type']);
  assert.equal(sent.instanceId, undefined);
  assert.equal(sent.deviceId, undefined);
  assert.equal(sent.recipients, undefined);
  assert.equal(sent.devices, undefined);
  assert.equal(sent.token, undefined);
  ws.serverSend({ type: 'push_notification_result', accepted: true, recipients: 2 });
  assert.deepEqual(await pending, { accepted: true, recipients: 2 });
  conn.shutdown();
});

test('Eine Regel kann weder Empfänger noch Installation vorgeben', async () => {
  const db = await freshDb();
  const rule = await repository.createRule(db, ruleInput({
    instanceId: 'ins_fremd', deviceId: 'dev_fremd', fcmToken: 'geheim', recipients: ['dev_a'],
  }));
  // Die Zusatzfelder werden nicht übernommen und damit auch nicht gespeichert.
  for (const forbidden of ['instanceId', 'deviceId', 'fcmToken', 'recipients']) {
    assert.equal(rule[forbidden], undefined, `${forbidden} darf nicht gespeichert werden`);
  }
  const { conn, ws } = await authenticatedConnection();
  const pending = service.push(
    { title: rule.title, body: rule.body, type: rule.eventType, severity: rule.severity },
    { connectionService: { getStatus: () => conn.getStatus(), pushNotification: (p) => conn.pushNotification(p) } }
  );
  assert.deepEqual(Object.keys(ws.lastSent()).sort(), ['body', 'eventType', 'severity', 'title', 'type']);
  ws.serverSend({ type: 'push_notification_result', accepted: true, recipients: 1 });
  await pending;
  conn.shutdown();
  db.close();
});

test('Ohne authentifizierte Verbindung liefert der Dienst ein strukturiertes Ergebnis', async () => {
  const offline = { getStatus: () => ({ state: 'idle' }), pushNotification: () => assert.fail('darf nicht senden') };
  assert.deepEqual(
    await service.push({ title: 'T', body: 'B', type: 'doorbell', severity: 'normal' }, { connectionService: offline }),
    { accepted: false, recipients: 0, reason: 'relay_unavailable' }
  );

  const connecting = { getStatus: () => ({ state: 'connecting' }), pushNotification: () => assert.fail('darf nicht senden') };
  assert.deepEqual(
    await service.push({ title: 'T', body: 'B', type: 'doorbell', severity: 'normal' }, { connectionService: connecting }),
    { accepted: false, recipients: 0, reason: 'not_authenticated' }
  );
});

test('Zeitüberschreitung und Sendefehler werden als Grund gemeldet', async () => {
  const { conn } = await authenticatedConnection();
  const timeoutService = { getStatus: () => conn.getStatus(), pushNotification: (p) => conn.pushNotification(p) };
  // Der Relay antwortet nicht: pushTimeoutMs der Testverbindung greift. Der
  // Timeout-Timer ist bewusst unref'd (eine offene Zustellung darf den Prozess
  // nie wach halten), deshalb hält der Test die Ereignisschleife selbst offen.
  const keepAlive = setTimeout(() => {}, 500);
  assert.deepEqual(
    await service.push({ title: 'T', body: 'B', type: 'doorbell', severity: 'normal' }, { connectionService: timeoutService }),
    { accepted: false, recipients: 0, reason: 'timeout' }
  );
  clearTimeout(keepAlive);
  conn.shutdown();

  const broken = {
    getStatus: () => ({ state: 'authenticated' }),
    pushNotification: () => Promise.reject(new Error('kaputt')),
  };
  assert.deepEqual(
    await service.push({ title: 'T', body: 'B', type: 'doorbell', severity: 'normal' }, { connectionService: broken }),
    { accepted: false, recipients: 0, reason: 'send_failed' }
  );
});

test('Eine abgelehnte Push-Quittung trennt die Relay-Verbindung nicht', async () => {
  const { conn, ws } = await authenticatedConnection();
  const pending = conn.pushNotification({ title: 'T', body: 'B', eventType: 'doorbell', severity: 'normal' });
  ws.serverSend({ type: 'push_notification_result', accepted: false, recipients: 0 });
  await assert.rejects(() => pending, (error) => error.code === 'remote_access_push_failed');
  assert.equal(conn.getStatus().state, 'authenticated', 'Tunnel und Fernzugriff bleiben bestehen');
  conn.shutdown();
});

// ── Trigger-Typen und Flankenerkennung ──────────────────────────────────────

const known = (value) => ({ known: true, value });
const unknown = { known: false, value: null };

test('changed löst bei jeder echten Wertänderung aus', () => {
  assert.equal(matches('changed', '', known('1'), '2'), true);
  assert.equal(matches('changed', '', known('2'), '2'), false);
  // Ohne Vorwert gibt es keine Flanke (erster Wert nach dem Start).
  assert.equal(matches('changed', '', unknown, '2'), false);
});

test('equals löst nur beim Übergang auf den Zielwert aus', () => {
  assert.equal(matches('equals', 'true', known(false), true), true);
  assert.equal(matches('equals', 'true', known('false'), 'true'), true);
  // Derselbe Wert erneut empfangen: keine Flanke, kein Push.
  assert.equal(matches('equals', 'true', known(true), true), false);
  assert.equal(matches('equals', 'true', known('true'), '1'), false);
  assert.equal(matches('equals', 'true', known(true), false), false);
});

test('not_equals löst beim Übergang weg vom Wert aus', () => {
  assert.equal(matches('not_equals', 'open', known('open'), 'closed'), true);
  assert.equal(matches('not_equals', 'open', known('closed'), 'ajar'), false);
  assert.equal(matches('not_equals', 'open', known('open'), 'open'), false);
});

test('above löst ausschließlich beim Überschreiten aus', () => {
  assert.equal(matches('above', '-10', known(-12), -8), true);
  assert.equal(matches('above', '-10', known(-10), -9), true);
  // Bereits oberhalb: weitere Werte lösen nicht erneut aus.
  assert.equal(matches('above', '-10', known(-8), -5), false);
  assert.equal(matches('above', '80', known(85), 90), false);
  assert.equal(matches('above', '80', known(70), 80), false);
});

test('below löst ausschließlich beim Unterschreiten aus', () => {
  assert.equal(matches('below', '10', known(12), 8), true);
  assert.equal(matches('below', '10', known(10), 9), true);
  assert.equal(matches('below', '10', known(8), 5), false);
  assert.equal(matches('below', '10', known(12), 10), false);
});

test('Grenzwert-Trigger greifen nur bei numerischen Werten', () => {
  assert.equal(matches('above', '10', known('auf'), 'zu'), false);
  assert.equal(matches('above', 'zehn', known(1), 20), false);
  // Boolean ist kein Zahlenwert: ein Schalter löst keinen Grenzwert aus.
  assert.equal(matches('above', '0', known(false), true), false);
  assert.equal(valueType(true), 'boolean');
  assert.equal(valueType('22,5'), 'number');
  assert.equal(valueType('open'), 'string');
});

test('Boolesche und textliche Regeln funktionieren über Darstellungsgrenzen hinweg', () => {
  assert.equal(matches('equals', 'true', known('off'), 'on'), true);
  assert.equal(matches('equals', 'false', known(1), 0), true);
  assert.equal(matches('equals', 'open', known('closed'), 'open'), true);
  assert.equal(matches('not_equals', 'closed', known('closed'), 'open'), true);
});

// ── Rule Engine: State-Anbindung, Cooldown, Robustheit ──────────────────────

// Regelmaschine mit einem gefälschten State-Bus-Ereignis betreiben: Werte
// werden über den echten Bus eingespeist, der Versand wird abgefangen.
async function engineFixture(rules, options = {}) {
  const db = await freshDb();
  for (const input of rules) await repository.createRule(db, input);
  const sent = [];
  const original = service.push;
  service.push = (message) => {
    sent.push(message);
    return Promise.resolve(options.result || { accepted: true, recipients: 1 });
  };
  const subscribed = new Map();
  const originalSubscribe = mqttClient.subscribeAdHoc;
  const originalUnsubscribe = mqttClient.unsubscribeAdHoc;
  mqttClient.subscribeAdHoc = (topic, key) => { subscribed.set(key, topic); };
  mqttClient.unsubscribeAdHoc = (key) => { subscribed.delete(key); bus.remove(key); };
  await engine.init(db);

  return {
    db,
    sent,
    subscribed,
    // Einen neuen Wert für die Regel setzen — genau so, wie MQTT-Client und
    // Adapter ihn über den gemeinsamen Bus veröffentlichen.
    feed(ruleId, value) {
      bus.ingest(engine.cacheKey(ruleId), value);
    },
    async close() {
      engine.stop();
      service.push = original;
      mqttClient.subscribeAdHoc = originalSubscribe;
      mqttClient.unsubscribeAdHoc = originalUnsubscribe;
      for (const key of subscribed.keys()) bus.remove(key);
      await new Promise((resolve) => db.close(resolve));
    },
  };
}

test('Die Engine abonniert die States ihrer Regeln und löst über den State-Bus aus', async () => {
  const fixture = await engineFixture([ruleInput({ cooldownSeconds: '0' })]);
  assert.equal(fixture.subscribed.get(engine.cacheKey(1)), 'custom://Klingel');

  // Erster Wert ist nur die Ausgangsbasis (kein Push nach dem Start).
  fixture.feed(1, 'false');
  assert.equal(fixture.sent.length, 0);
  // false → true: der Türklingel-Push.
  fixture.feed(1, 'true');
  assert.equal(fixture.sent.length, 1);
  assert.deepEqual(fixture.sent[0], {
    title: 'Türklingel', body: 'Es klingelt an der Tür.', type: 'doorbell', severity: 'normal',
  });
  // true → true wird vom Bus gar nicht erst gemeldet und löst nicht aus.
  fixture.feed(1, 'true');
  assert.equal(fixture.sent.length, 1);
  await fixture.close();
});

test('Eine deaktivierte Regel löst nicht aus', async () => {
  const fixture = await engineFixture([ruleInput({ enabled: '0' })]);
  assert.equal(fixture.subscribed.size, 0, 'inaktive Regeln werden nicht abonniert');
  fixture.feed(1, 'false');
  fixture.feed(1, 'true');
  assert.equal(fixture.sent.length, 0);
  await fixture.close();
});

test('Der Cooldown verhindert die Wiederholung und lässt danach wieder zu', async () => {
  const fixture = await engineFixture([ruleInput({ triggerType: 'changed', triggerValue: '', cooldownSeconds: '5' })]);
  fixture.feed(1, '1');
  fixture.feed(1, '2');
  assert.equal(fixture.sent.length, 1);
  const first = engine.getRuntime()[0].lastTriggeredAt;

  // Sofortige weitere Änderung: unterdrückt, und der Zeitstempel bleibt stehen.
  fixture.feed(1, '3');
  assert.equal(fixture.sent.length, 1);
  assert.equal(engine.getRuntime()[0].lastTriggeredAt, first);

  // Nach Ablauf des Cooldowns darf erneut ausgelöst werden.
  engine.getRuntime()[0].lastTriggeredAt = Date.now() - 6000;
  fixture.feed(1, '4');
  assert.equal(fixture.sent.length, 2);
  await fixture.close();
});

test('Cooldown 0 lässt jede Flanke durch', async () => {
  const fixture = await engineFixture([ruleInput({ triggerType: 'changed', triggerValue: '', cooldownSeconds: '0' })]);
  fixture.feed(1, '1');
  fixture.feed(1, '2');
  fixture.feed(1, '3');
  assert.equal(fixture.sent.length, 2);
  await fixture.close();
});

test('Mehrere Regeln auf demselben State arbeiten unabhängig voneinander', async () => {
  const fixture = await engineFixture([
    ruleInput({ name: 'Netz weg', stateId: 'custom://Netz', triggerType: 'equals', triggerValue: 'false', title: 'Stromausfall', body: 'Die Netzversorgung ist ausgefallen.', eventType: 'power_failure', severity: 'critical', cooldownSeconds: '0' }),
    ruleInput({ name: 'Netz da', stateId: 'custom://Netz', triggerType: 'equals', triggerValue: 'true', title: 'Netzversorgung', body: 'Die Stromversorgung wurde wiederhergestellt.', eventType: 'power_restored', severity: 'normal', cooldownSeconds: '0' }),
  ]);
  // Beide Regeln hängen am selben State, aber an eigenen Cache-Schlüsseln.
  fixture.feed(1, 'true'); fixture.feed(2, 'true');
  assert.equal(fixture.sent.length, 0);
  fixture.feed(1, 'false'); fixture.feed(2, 'false');
  assert.deepEqual(fixture.sent.map((m) => m.type), ['power_failure']);
  fixture.feed(1, 'true'); fixture.feed(2, 'true');
  assert.deepEqual(fixture.sent.map((m) => m.type), ['power_failure', 'power_restored']);
  await fixture.close();
});

test('Ein nicht vorhandener State verursacht keinen Fehler und keine Auslösung', async () => {
  const fixture = await engineFixture([ruleInput({ stateId: 'custom://GibtEsNicht' })]);
  // Es kommt nie ein Wert: die Engine bleibt still und wirft nicht.
  engine.onValues({ changedKeys: ['custom://GibtEsNicht'] });
  engine.onValues({ changedKeys: [engine.cacheKey(1)] });
  engine.onValues(null);
  engine.onValues({});
  assert.equal(fixture.sent.length, 0);
  await fixture.close();
});

test('Relay offline und Push-Fehler brechen die State-Verarbeitung nicht ab', async () => {
  const fixture = await engineFixture(
    [ruleInput({ triggerType: 'changed', triggerValue: '', cooldownSeconds: '0' })],
    { result: { accepted: false, recipients: 0, reason: 'relay_unavailable' } }
  );
  let seen = 0;
  const off = bus.onValuesChanged(() => { seen += 1; });
  fixture.feed(1, '1');
  fixture.feed(1, '2');
  assert.equal(fixture.sent.length, 1);
  assert.equal(seen, 2, 'der Bus verteilt weiter an alle Konsumenten');
  off();

  // Ein werfender Dienst darf den State-Update-Pfad ebenso wenig abbrechen.
  const throwing = service.push;
  service.push = () => { throw new Error('Push kaputt'); };
  assert.doesNotThrow(() => fixture.feed(1, '3'));
  service.push = throwing;
  await fixture.close();
});

// ── Testfunktion ────────────────────────────────────────────────────────────

test('Die Testfunktion sendet ohne Stateänderung und ohne last_triggered_at zu verändern', async () => {
  const db = await freshDb();
  const rule = await repository.createRule(db, ruleInput());
  assert.equal(rule.lastTriggeredAt, null);

  const sent = [];
  const result = await service.push(
    { title: rule.title, body: rule.body, type: rule.eventType, severity: rule.severity },
    {
      connectionService: {
        getStatus: () => ({ state: 'authenticated' }),
        pushNotification: (payload) => { sent.push(payload); return Promise.resolve({ accepted: true, recipients: 1 }); },
      },
    }
  );
  assert.deepEqual(result, { accepted: true, recipients: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventType, 'doorbell');

  // Der Testversand fasst weder den State noch den letzten Trigger an.
  const after = await repository.getRule(db, rule.id);
  assert.equal(after.lastTriggeredAt, null);
  assert.equal(bus.getCache().has(engine.cacheKey(rule.id)), false);
  await new Promise((resolve) => db.close(resolve));
});

test('Die Testfunktion meldet Zustellung, fehlende Geräte und fehlenden Relay getrennt', () => {
  assert.equal(testMessage({ accepted: true, recipients: 1 }), 'Nachricht an 1 Gerät gesendet.');
  assert.equal(testMessage({ accepted: true, recipients: 3 }), 'Nachricht an 3 Geräte gesendet.');
  assert.equal(testMessage({ accepted: true, recipients: 0 }), 'Keine gekoppelten Push-Geräte vorhanden.');
  assert.equal(testMessage({ accepted: false, recipients: 0, reason: 'relay_unavailable' }), 'Relay derzeit nicht verfügbar.');
  assert.equal(testMessage({ accepted: false, recipients: 0, reason: 'not_authenticated' }), 'Relay derzeit nicht verfügbar.');
  assert.equal(testMessage({ accepted: false, recipients: 0, reason: 'timeout' }), 'Nachricht konnte nicht gesendet werden.');
});

// ── CRUD und Validierung ────────────────────────────────────────────────────

async function rejectsValidation(db, input, pattern, context) {
  await assert.rejects(
    () => repository.createRule(db, input, context),
    (error) => error.validation === true && pattern.test(error.message),
    `erwartet: ${pattern}`
  );
}

test('Regel-CRUD legt an, speichert, schaltet um und löscht', async () => {
  const db = await freshDb();
  const rule = await repository.createRule(db, ruleInput());
  assert.equal(rule.name, 'Türklingel');
  assert.equal(rule.enabled, true);
  assert.equal(rule.cooldownSeconds, 5);
  assert.equal(rule.triggerValue, 'true');

  const updated = await repository.updateRule(db, rule.id, ruleInput({ name: 'Klingel', cooldownSeconds: '30' }));
  assert.equal(updated.name, 'Klingel');
  assert.equal(updated.cooldownSeconds, 30);

  const off = await repository.setEnabled(db, rule.id, false);
  assert.equal(off.enabled, false);
  assert.equal((await repository.listActiveRules(db)).length, 0);

  await repository.deleteRule(db, rule.id);
  assert.equal((await repository.listRules(db)).length, 0);
  await assert.rejects(() => repository.deleteRule(db, rule.id), (error) => error.validation === true);
  await new Promise((resolve) => db.close(resolve));
});

test('Regelvalidierung weist ungültige Eingaben ab', async () => {
  const db = await freshDb();
  await rejectsValidation(db, ruleInput({ name: '' }), /Name fehlt/);
  await rejectsValidation(db, ruleInput({ stateId: '' }), /State fehlt/);
  await rejectsValidation(db, ruleInput({ triggerType: 'irgendwas' }), /Unbekannter Trigger/);
  await rejectsValidation(db, ruleInput({ triggerValue: '' }), /Vergleichswert fehlt/);
  await rejectsValidation(db, ruleInput({ triggerType: 'above', triggerValue: 'viel' }), /Zahl sein/);
  await rejectsValidation(db, ruleInput({ severity: 'egal' }), /Priorität/);
  await rejectsValidation(db, ruleInput({ cooldownSeconds: '-1' }), /Cooldown/);
  await rejectsValidation(db, ruleInput({ cooldownSeconds: '2,5' }), /Cooldown/);

  // Name bleibt eindeutig.
  await repository.createRule(db, ruleInput());
  await rejectsValidation(db, ruleInput(), /bereits vergeben/);
  await new Promise((resolve) => db.close(resolve));
});

test('Grenzwert-Trigger sind nur für numerische States zulässig', async () => {
  const db = await freshDb();
  await rejectsValidation(
    db,
    ruleInput({ triggerType: 'above', triggerValue: '10' }),
    /numerische States/,
    { stateValueType: 'boolean' }
  );
  // Bei einem Zahlen-State geht dieselbe Regel durch.
  const rule = await repository.createRule(
    db,
    ruleInput({ name: 'Gefrierschrank', triggerType: 'above', triggerValue: '-10', eventType: 'temperature_warning', severity: 'critical' }),
    { stateValueType: 'number' }
  );
  assert.equal(rule.triggerType, 'above');
  assert.equal(rule.severity, 'critical');
  await new Promise((resolve) => db.close(resolve));
});

test('Titel, Nachricht und Ereignistyp werden serverseitig begrenzt und geprüft', async () => {
  const db = await freshDb();
  await rejectsValidation(db, ruleInput({ title: 'x'.repeat(121) }), /Titel ist zu lang/);
  await rejectsValidation(db, ruleInput({ body: 'y'.repeat(501) }), /Nachricht ist zu lang/);
  await rejectsValidation(db, ruleInput({ eventType: 'Tür Klingel' }), /Ereignistyp darf nur/);
  await rejectsValidation(db, ruleInput({ eventType: 'Doorbell' }), /Ereignistyp darf nur/);
  await rejectsValidation(db, ruleInput({ eventType: 'z'.repeat(65) }), /Ereignistyp ist zu lang/);
  await rejectsValidation(db, ruleInput({ eventType: '' }), /Ereignistyp fehlt/);

  // Die Grenzwerte selbst bleiben gültig.
  const rule = await repository.createRule(db, ruleInput({ title: 'x'.repeat(120), body: 'y'.repeat(500), eventType: 'z'.repeat(64) }));
  assert.equal(rule.title.length, 120);
  assert.equal(rule.body.length, 500);
  assert.equal(rule.eventType.length, 64);
  await new Promise((resolve) => db.close(resolve));
});

test('Der Nachrichtendienst weist ungültige Nachrichten unabhängig von Regeln ab', () => {
  assert.throws(() => service.normalize({ title: '', body: 'B', type: 'doorbell' }), (e) => e.validation === true);
  assert.throws(() => service.normalize({ title: 'T', body: 'B', type: 'door bell' }), (e) => e.validation === true);
  assert.throws(() => service.normalize({ title: 'T', body: 'B', type: 'doorbell', severity: 'hoch' }), (e) => e.validation === true);
  assert.deepEqual(
    service.normalize({ title: ' T ', body: ' B ', type: 'doorbell' }),
    { title: 'T', body: 'B', type: 'doorbell', severity: 'normal' }
  );
});
