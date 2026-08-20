'use strict';

// Integrationstest des Zigbee-Adapters gegen echte Coordinator-Hardware.
//
// Der Test wird nur ausgeführt, wenn ein Ziel angegeben ist — ohne Hardware
// bleibt `npm test` dadurch unverändert grün:
//
//   ZIGBEE_TEST_HOST=192.168.1.50 ZIGBEE_TEST_PORT=6638 npm test
//
// Oder lokal am seriellen Anschluss:
//
//   ZIGBEE_TEST_SERIAL=/dev/serial/by-id/usb-ITead_... npm test
//
// Der Test ist ausdrücklich **nicht verändernd**: Er übernimmt das vorhandene
// Netz, liest Coordinator-Informationen, trennt die Verbindung und baut sie
// wieder auf. Er lernt nichts an, entfernt nichts und schaltet nichts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createAdapter = require('../adapter/zigbee');

const TCP_HOST = process.env.ZIGBEE_TEST_HOST;
const TCP_PORT = Number(process.env.ZIGBEE_TEST_PORT) || 6638;
const SERIAL_PATH = process.env.ZIGBEE_TEST_SERIAL;
const ENABLED = !!(TCP_HOST || SERIAL_PATH);

function transportConfig() {
  return SERIAL_PATH
    ? { transportType: 'serial', serialPath: SERIAL_PATH, baudRate: Number(process.env.ZIGBEE_TEST_BAUD) || 115200 }
    : { transportType: 'tcp', tcpHost: TCP_HOST, tcpPort: TCP_PORT };
}

function integrationHost(dataDirectory) {
  const secrets = new Map();
  const events = { states: [], values: [], status: [], storage: new Map(), logs: [] };
  return {
    events,
    secrets,
    name: 'zigbee-integration',
    language: 'de',
    getLanguage: () => ({ code: 'de', locale: 'de-DE', direction: 'ltr', fallback: 'de' }),
    t: (key, defaultText) => (defaultText == null ? key : defaultText),
    getConfig: () => ({}),
    setStates: (list) => { events.states = list; },
    publishState: (address, value) => events.values.push({ address, value }),
    publishStates: (values) => { for (const value of values) events.values.push(value); },
    setConnected: (connected, detail) => events.status.push({ connected, detail }),
    setStorage: (key, value) => events.storage.set(key, value),
    persistStorage: async (key, value) => { events.storage.set(key, value); },
    getDataDirectory: async () => dataDirectory,
    getSecret: async (key) => secrets.get(key) || null,
    setSecret: async (key, value) => { secrets.set(key, String(value)); },
    deleteSecret: async (key) => secrets.delete(key),
    log: (...a) => events.logs.push(['info', a.join(' ')]),
    error: (...a) => events.logs.push(['error', a.join(' ')]),
    warn: (...a) => events.logs.push(['warn', a.join(' ')]),
    debug: (...a) => events.logs.push(['debug', a.join(' ')]),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return false;
}

// Die Netzidentität — das, was bei einer Übernahme unverändert bleiben muss.
const identity = (network) => (network
  ? JSON.stringify({ panId: network.panId, extendedPanId: network.extendedPanId, channel: network.channel })
  : '');

test('Zigbee-Integration gegen echte Coordinator-Hardware', { skip: ENABLED ? false : 'ZIGBEE_TEST_HOST oder ZIGBEE_TEST_SERIAL nicht gesetzt' }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-zigbee-integration-'));
  const host = integrationHost(directory);
  const adapter = createAdapter(host);
  const config = {
    coordinatorType: 'zstack',
    ...transportConfig(),
    networkMode: 'adopt',
    permitJoinSeconds: 30,
    activePing: false,
  };

  let runtime;
  let networkBefore = '';
  let deviceCountBefore = 0;

  t.after(async () => {
    try {
      await adapter.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test('1–4: Verbindung, Coordinator-Antwort, Z-Stack-Start, Coordinator-Informationen', async () => {
    await adapter.start(config);
    runtime = adapter._internals().runtime();
    assert.ok(await until(() => runtime.status().connected, 120000),
      `keine Verbindung: ${runtime.status().lastError}`);

    const status = runtime.status();
    assert.ok(status.coordinator, 'der Coordinator antwortet');
    assert.match(status.coordinator.ieeeAddress, /^0x[0-9a-f]{16}$/i);
    assert.ok(status.coordinator.firmware.version, 'die Firmwareversion wird gelesen');
    assert.ok(status.coordinator.firmware.product, 'der Adapter-Typ wird erkannt');
    assert.ok(status.network && status.network.channel >= 11 && status.network.channel <= 26);
    // Das bestehende Netz wurde übernommen, nicht neu aufgebaut.
    assert.equal(status.planAction, 'adopt');
    assert.equal(status.networkState, 'übernommen');

    networkBefore = identity(status.network);
    deviceCountBefore = runtime.devices().length;
  });

  await t.test('5–9: Verbindungsabriss, Stabilität, Wiederaufbau, unveränderte Netzwerkdaten', async () => {
    const before = runtime.status().coordinator.ieeeAddress;
    // Die darunterliegende Verbindung hart zerstören — wie eine ausgefallene
    // Bridge oder ein abgezogenes USB-Kabel.
    const socket = runtime.__testControllerSocket();
    assert.ok(socket, 'die Verbindung ist erreichbar');
    socket.destroy();

    assert.ok(await until(() => !runtime.status().connected, 30000), 'der Abriss wird bemerkt');
    await wait(2000);
    // Weder Geräte noch Netzwerkdaten dürfen dabei verloren gehen.
    assert.equal(runtime.devices().length, deviceCountBefore);
    assert.equal(identity(runtime.status().network), networkBefore);

    // Der Adapter verbindet sich von selbst neu.
    assert.ok(await until(() => runtime.status().connected, 120000),
      `kein Wiederaufbau: ${runtime.status().lastError}`);
    const status = runtime.status();
    assert.equal(status.coordinator.ieeeAddress, before);
    assert.equal(identity(status.network), networkBefore, 'die Netzidentität ist unverändert');
    assert.equal(status.networkState, 'übernommen');
  });

  await t.test('Persistenz und Geheimnisse', async () => {
    assert.ok(fs.existsSync(path.join(directory, 'network.json')));
    const persisted = fs.readFileSync(path.join(directory, 'network.json'), 'utf8');
    // Kein Schlüsselmaterial in der Klartext-Persistenz.
    assert.equal(persisted.match(/[0-9a-f]{32}/i), null);
    const key = host.secrets.get('network-key');
    assert.equal(key && key.length, 32, 'der Schlüssel liegt im Secret-Store');
    // Und er taucht in keiner einzigen Logzeile auf.
    assert.ok(!host.events.logs.some(([, message]) => message.includes(key)));
  });

  await t.test('10–11: Anlernfenster öffnen und wieder schließen', async () => {
    const opened = await runtime.setPermitJoin(true, 20);
    assert.equal(opened.active, true);
    assert.equal(opened.remaining, 20);
    assert.equal(runtime.status().permitJoin.active, true);
    // Es bleibt nicht dauerhaft offen.
    const closed = await runtime.setPermitJoin(false);
    assert.equal(closed.active, false);
    assert.equal(runtime.status().permitJoin.active, false);
  });

  await t.test('Coordinator-Backup', async () => {
    const info = await runtime.createBackup();
    assert.ok(info && !info.error, `Backup fehlgeschlagen: ${info && info.error}`);
    assert.equal(info.format, 'unified');
    assert.ok(fs.existsSync(path.join(directory, 'coordinator_backup.json')));
  });
});
