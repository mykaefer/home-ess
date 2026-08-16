'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-host-ext-'));
const ADAPTER_DIR = path.join(TMP, 'adapter');
fs.mkdirSync(path.join(ADAPTER_DIR, 'managed'), { recursive: true });
fs.writeFileSync(path.join(ADAPTER_DIR, 'managed', 'adapter.json'), JSON.stringify({
  id: 'managed', prefix: 'managed', name: 'Managed', main: 'index.js',
  managementPage: { label: 'Verwalten', maxUploadBytes: 123456, stylesheet: 'management.css' },
}));
fs.writeFileSync(path.join(ADAPTER_DIR, 'managed', 'index.js'), 'module.exports=()=>({start(){}});');
fs.writeFileSync(path.join(ADAPTER_DIR, 'managed', 'management.css'), '.managed { color: green; }');
process.env.HOME_ESS_ADAPTER_DIR = ADAPTER_DIR;
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const registry = require('../src/adapters/registry');
const host = require('../src/adapters/host');
const instances = require('../src/adapters/instances');
const secrets = require('../src/adapters/secrets');
const { openDatabase } = require('../src/db');
const adapterRouter = require('../src/adapters/router');
const { renderLayout } = require('../src/views/layout');

test.after(async () => {
  await host.stopAll();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function database() {
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

test('Registry normalisiert die rückwärtskompatible Management-Seite', () => {
  registry.loadRegistry();
  const manifest = registry.getManifest('managed');
  assert.deepEqual(manifest.managementPage, {
    label: 'Verwalten',
    maxUploadBytes: 123456,
    stylesheet: 'management.css',
    // Ohne Angabe im Manifest bleibt der Einstellungsknopf wie bisher.
    asSettings: false,
  });
});

test('Layout bindet deklarierte Adapter-Styles nach dem Basis-Stylesheet ein', () => {
  const html = renderLayout({
    title: 'Managed',
    stylesheets: ['/adapter/instance/7/manage/assets/management.css'],
  });
  const base = html.indexOf('href="/styles.css"');
  const adapterStyle = html.indexOf('href="/adapter/instance/7/manage/assets/management.css"');
  assert.ok(base >= 0 && adapterStyle > base);
});

test('Host leitet Management-Requests korreliert an den Adapterprozess weiter', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  registry.loadRegistry();
  const id = await instances.createInstance(db, 'managed', 'one');
  await instances.setEnabled(db, id, true);
  let child;
  host._setForkImpl(() => {
    child = new EventEmitter();
    child.sent = [];
    child.send = (message) => {
      child.sent.push(message);
      if (message.type === 'management') {
        setImmediate(() => child.emit('message', {
          type: 'management-result', requestId: message.requestId,
          response: { status: 200, json: { path: message.request.path } },
        }));
      }
    };
    child.kill = () => child.emit('exit', 0);
    return child;
  });
  await host.initAdapters(db);
  const response = await host.managementRequest(id, { method: 'GET', path: '/api/status' });
  assert.deepEqual(response, { status: 200, json: { path: '/api/status' } });
  assert.ok(child.sent.some((message) => message.type === 'management'));
  await host.stopInstance(id);
});

test('Adapter-Secrets bleiben instanzgebunden in Dateien mit restriktiven Rechten', () => {
  const root = path.join(TMP, 'identity');
  secrets.init(root);
  secrets.set(7, 'device-test', 'top-secret');
  assert.equal(secrets.get(7, 'device-test'), 'top-secret');
  assert.equal(secrets.get(8, 'device-test'), null);
  const target = secrets._paths(7, 'device-test').file;
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(secrets.remove(7, 'device-test'), true);
  assert.equal(secrets.get(7, 'device-test'), null);
  assert.throws(() => secrets.set(7, '../escape', 'x'), /Ungültige/);
});

test('Host liefert abonnierte Adapter-States ereignisgesteuert und meldet sie sauber ab', () => {
  adapterRouter.registerScheme('source', 'source');
  adapterRouter.setInstanceScheme('source-one', 'source');
  const sent = [];
  const entry = {
    instance: { id: 99, name: 'managed-one' },
    manifest: { prefix: 'managed' },
    child: { send(message) { sent.push(message); } },
    subscriptions: new Map(),
    status: {},
  };
  host._handleMessage(entry, {
    type: 'subscribe', subscriptionId: 'percent', topic: 'source://source-one/soc',
  });
  adapterRouter.ingestFromInstance('source-one', 'soc', 73.4);
  host._deliverSubscriptions([entry], { changedKeys: ['adapter-sub:99:percent'] });
  assert.ok(sent.some((message) =>
    message.type === 'state-value' && message.subscriptionId === 'percent' && message.value === 73.4));
  host._handleMessage(entry, { type: 'unsubscribe', subscriptionId: 'percent' });
  assert.equal(entry.subscriptions.size, 0);
  adapterRouter.removeInstanceScheme('source-one');
});

test('Host-API schreibt Adapterwerte zentral über die MQTT-/Router-Schreibgrenze', async () => {
  const mqttClient = require('../src/mqtt/client');
  const originalPublish = mqttClient.publish;
  const writes = [];
  mqttClient.publish = (topic, value) => {
    writes.push([topic, value]);
    return topic !== 'system://protected/value';
  };
  try {
    const sent = [];
    const entry = {
      instance: { id: 100, name: 'managed-one', settings: {} },
      manifest: { prefix: 'managed' },
      child: { send(message) { sent.push(message); } },
      subscriptions: new Map(), status: {},
    };
    host._handleMessage(entry, {
      type: 'host-call', requestId: 'write-1', method: 'state.write',
      topic: 'source://source-one/switch', value: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes[0], ['source://source-one/switch', true]);
    assert.equal(sent.find((message) => message.requestId === 'write-1').result, true);
    host._handleMessage(entry, {
      type: 'host-call', requestId: 'write-2', method: 'state.write',
      topic: 'system://protected/value', value: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(sent.find((message) => message.requestId === 'write-2').error, /nicht verfügbar|schreibgeschützt/);
  } finally {
    mqttClient.publish = originalPublish;
  }
});

test('Host liefert Adaptern den vollständigen State-Katalog samt Schreibrechten', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  registry.loadRegistry();
  const id = await instances.createInstance(db, 'managed', 'katalog');
  host._setForkImpl(() => {
    const child = new EventEmitter();
    child.send = () => {};
    child.kill = () => child.emit('exit', 0);
    return child;
  });
  await host.initAdapters(db);

  const sent = [];
  const entry = {
    instance: await instances.getInstance(db, id),
    manifest: registry.getManifest('managed'),
    child: { send: (message) => sent.push(message) },
    subscriptions: new Map(),
    status: {},
  };
  host._handleMessage(entry, {
    type: 'states',
    list: [{ address: 'werte/soc', name: 'SoC', category: 'Werte', unit: '%', writable: true }],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  host._handleMessage(entry, { type: 'host-call', requestId: 'list-1', method: 'states.list' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const reply = sent.find((message) => message.requestId === 'list-1');
  assert.ok(reply && Array.isArray(reply.result), 'states.list liefert eine Liste');
  const adapterState = reply.result.find((state) => state.topic === 'managed://katalog/werte/soc');
  assert.ok(adapterState, 'der gemeldete Adapter-State ist enthalten');
  assert.equal(adapterState.writable, true);
  assert.equal(adapterState.name, 'katalog – SoC');
  // Berechnete Systemwerte sind lesbare Quellen, aber keine Schreibziele.
  const systemState = reply.result.find((state) => String(state.topic).startsWith('system://homeess/'));
  assert.ok(systemState, 'Systemwerte gehören zum Katalog');
  assert.equal(systemState.writable, false);
  await host.stopInstance(id);
});

test('Das Zugriffsobjekt führt canRead – die Verwaltungsbrücke hängt daran', () => {
  const { accessForUser, fullAccess } = require('../src/auth/access');
  // Ohne canRead bekäme jede Adapter-Verwaltungsseite „Keine Berechtigung.",
  // weil die Brücke in routes/adapters.js genau dieses Feld durchreicht.
  assert.equal(fullAccess().canRead, true);
  assert.equal(accessForUser({ id: 1, name: 'Admin', is_admin: 1 }).canRead, true);
  const reader = accessForUser({ id: 2, name: 'Lesen', role: 'read' });
  assert.deepEqual(
    { canRead: reader.canRead, canOperate: reader.canOperate, canWrite: reader.canWrite },
    { canRead: true, canOperate: false, canWrite: false }
  );
  const operator = accessForUser({ id: 3, name: 'Bedienen', role: 'operate' });
  assert.deepEqual(
    { canRead: operator.canRead, canOperate: operator.canOperate, canWrite: operator.canWrite },
    { canRead: true, canOperate: true, canWrite: false }
  );
});

test('Eine gestoppte Instanz meldet verständlich statt „nicht verfügbar"', async (t) => {
  const db = await database();
  t.after(() => new Promise((resolve) => db.close(resolve)));
  registry.loadRegistry();
  const id = await instances.createInstance(db, 'managed', 'gestoppt');
  host._setForkImpl(() => {
    const child = new EventEmitter();
    child.send = () => {};
    child.kill = () => child.emit('exit', 0);
    return child;
  });
  await host.initAdapters(db);
  // Die Instanz wurde nie aktiviert – es gibt keinen Prozess, der antworten könnte.
  await assert.rejects(
    () => host.managementRequest(id, { method: 'GET', path: '/' }),
    (error) => {
      assert.match(error.message, /nicht aktiv/);
      assert.equal(error.status, 409);
      return true;
    }
  );
});
