'use strict';

// Regressionstests zur Zusage, dass kein gekoppeltes hDP-Gerät dauerhaft aus
// dem Verbindungsaufbau fallen darf. Jeder Fall hier hat ein Gerät zuvor bis
// zum Adapterneustart stumm gelassen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const http = require('http');

const createHdpAdapter = require('../adapter/hdp');
const { RuntimeConnection, CONNECT_STALL_MS } = require('../adapter/hdp/runtime');
const { HdpClient } = require('../adapter/hdp/client');

const DEVICE_ID = 'hdp-esp8266-a1b2c3d4e5f60718';
const INSTANCE_ID = 'homeess-main';
const BINDING_KEY = 'a'.repeat(64);

function pixelManifest() {
  return {
    protocol_version: '1.0-draft', api_version: 'v1',
    auth_profile: 'local-binding-key-v1', runtime_profile: 'pixel-timeline-v1',
    device_type_profile: 'opaque-id-v1', output_types: ['argb_strip'],
    frame_encodings: ['rgb8-base64'], timeline_encodings: ['hdtl-delta-v1'],
    features: { mdns: true, websocket: true, ota: true, frame_output: true },
    hardware_capabilities: { argb_pins: [2, 4], led_types: ['WS2812'], color_orders: ['RGB', 'GRB'] },
    limits: {
      maximum_json_body_bytes: 3072, maximum_websocket_message_bytes: 2048,
      maximum_outputs: 1, maximum_led_count: 300,
      minimum_frame_interval_milliseconds: 20, maximum_timeline_bytes: 65536,
      maximum_timeline_events: 4096, maximum_timeline_chunk_bytes: 512,
      maximum_timeline_duration_milliseconds: 86400000,
    },
  };
}

function outputConfig(revision = 4) {
  return {
    revision, device_type: 'percentage_indicator',
    outputs: [{
      output_id: 'main', output_type: 'argb_strip', pin: 4,
      pixel_count: 4, driver: 'WS2812', color_order: 'GRB',
      reverse: false, maximum_brightness_percent: 35,
      maximum_current_milliamps: 500, current_per_pixel_milliamps: 60,
      offline_mode: 'retain_last_frame',
    }],
  };
}

function deviceStatus() {
  return {
    state: 'paired', uptime_seconds: 123, free_heap_bytes: 32000,
    wifi_connected: true, wifi_rssi_dbm: -50, ip_address: '192.168.1.20', paired: true,
    last_boot: {
      reset_reason: 'power_on', reset_detail: null, config_load_status: 'ok',
      config_load_source: 'primary', config_load_diagnostic: 'primary=valid', storage_generation: 1,
    },
  };
}

// Ein gekoppeltes Gerät, wie es nach einem Adapterneustart wiederhergestellt
// wird: bekannte Adresse, aber noch keine mDNS-Sichtung.
function storedDevice() {
  return {
    deviceId: DEVICE_ID, name: 'SoC-Badge Büro', address: '192.168.178.33',
    hostname: 'badge.local', apiPort: 80, wsPort: 81, otaPort: 8080,
    protocolVersion: '1.0-draft', runtimeProfile: 'pixel-timeline-v1',
    firmwareVersion: '0.7.5', platform: 'esp8266',
    bindingState: 'active', paired: true, pairingState: 'paired',
    manifest: pixelManifest(), hardwareConfig: outputConfig(), configRevision: 4,
  };
}

function harness(clientBehaviour = {}) {
  const events = { warnings: [], errors: [] };
  const connections = [];

  class FakeDiscovery extends EventEmitter {
    constructor() { super(); FakeDiscovery.last = this; }
    start() {} stop() {} refresh() {}
  }
  class FakeConnection extends EventEmitter {
    constructor(options) {
      super();
      this.device = options.device;
      this.stopped = true;
      this.stalled = false;
      connections.push(this);
    }
    start() { this.stopped = false; FakeConnection.last = this; }
    stop() { this.stopped = true; }
    updateDevice() {}
    sendState() { return false; }
    reconnectNow() {}
  }
  class FakeClient {
    constructor(device, credentials) { this.credentials = credentials; }
    update(device, credentials) { this.credentials = credentials; }
    async pairingStatus() {
      if (clientBehaviour.pairingStatus) return clientBehaviour.pairingStatus();
      return {
        pairing_state: 'paired', paired: true, binding_status: 'match',
        binding_id: 'b'.repeat(64), paired_to_requester: true,
      };
    }
    async manifest() { return pixelManifest(); }
    async config() { return outputConfig(); }
    async status() { return deviceStatus(); }
    async firmware() { return { firmware_version: '0.7.5', platform: 'esp8266' }; }
  }

  const secrets = new Map([[`device-${DEVICE_ID}`, BINDING_KEY]]);
  const host = {
    async getInstanceIdentity() { return { instanceId: INSTANCE_ID, fingerprint: 'a'.repeat(64) }; },
    async getDataDirectory() { throw new Error('kein Datenverzeichnis im Test'); },
    async getSecret(key) { return secrets.get(key) || null; },
    async setSecret(key, value) { secrets.set(key, value); },
    async deleteSecret(key) { secrets.delete(key); },
    async persistStorage() {}, setStorage() {}, subscribeState() { return () => {}; },
    setStates() {}, publishStates() {}, setConnected() {},
    log() {}, warn(message) { events.warnings.push(String(message)); },
    error(message) { events.errors.push(String(message)); },
  };
  const adapter = createHdpAdapter(host, {
    Discovery: FakeDiscovery, HdpClient: FakeClient, RuntimeConnection: FakeConnection,
  });
  return { adapter, events, connections, FakeDiscovery, FakeConnection };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Zeitüberschreitung beim Warten auf ${label}`);
}

test('Ein gekoppeltes Gerät ohne mDNS-Sichtung wird weiter gesucht und verbunden', async (t) => {
  const { adapter, connections } = harness();
  t.after(() => adapter.stop());
  await adapter.start({ firmwareCatalogUrl: '', hdpDevices: [storedDevice()] });

  // Ohne Discovery-Ereignis gab es bisher keinen einzigen Verbindungsversuch.
  assert.equal(connections.length, 0, 'ohne Wächter bleibt das Gerät unangetastet');

  adapter.superviseConnections();
  await waitFor(() => connections.length === 1, 'erzwungenen Verbindungsaufbau');
  assert.equal(connections[0].stopped, false, 'die erzwungene Verbindung wurde gestartet');
});

test('Ein Binding-Abgleich ohne Antwort sperrt das Gerät nicht dauerhaft', async (t) => {
  let hang = true;
  let calls = 0;
  const { adapter, connections, events } = harness({
    pairingStatus() {
      calls += 1;
      // Erster Aufruf kehrt nie zurück — genau der Zustand, der ein Gerät bis
      // zum Adapterneustart blockiert hat.
      if (hang) return new Promise(() => {});
      return Promise.resolve({
        pairing_state: 'paired', paired: true, binding_status: 'match',
        binding_id: 'b'.repeat(64), paired_to_requester: true,
      });
    },
  });
  t.after(() => adapter.stop());
  await adapter.start({ firmwareCatalogUrl: '', hdpDevices: [storedDevice()] });

  adapter.superviseConnections();
  await waitFor(() => calls === 1, 'ersten Abgleich');
  assert.equal(connections.length, 0, 'der hängende Abgleich hat keine Verbindung erzeugt');

  // Solange die Frist läuft, bleibt die Sperre bestehen.
  adapter.superviseConnections();
  await settle();
  assert.equal(calls, 1, 'innerhalb der Frist wird kein zweiter Abgleich gestartet');

  // Nach Ablauf der Frist muss der Wächter die Sperre lösen.
  hang = false;
  adapter.superviseConnections(Date.now() + 10 * 60 * 1000);
  await waitFor(() => connections.length === 1, 'Verbindung nach gelöster Sperre');
  assert.ok(events.warnings.some((line) => /Sperre aufgehoben/.test(line)),
    'die aufgehobene Sperre wird protokolliert');
});

test('Eine stillstehende Verbindung wird verworfen und neu aufgebaut', async (t) => {
  const { adapter, connections } = harness();
  t.after(() => adapter.stop());
  await adapter.start({ firmwareCatalogUrl: '', hdpDevices: [storedDevice()] });

  adapter.superviseConnections();
  await waitFor(() => connections.length === 1, 'erste Verbindung');
  const first = connections[0];

  // Solange die Verbindung arbeitet, fasst der Wächter sie nicht an.
  adapter.superviseConnections(Date.now() + 10 * 60 * 1000);
  await settle();
  assert.equal(connections.length, 1, 'eine arbeitende Verbindung bleibt unberührt');

  // Ein Stillstand — etwa nach abgelehnter Authentifizierung — muss aufgelöst werden.
  first.stalled = true;
  adapter.superviseConnections(Date.now() + 20 * 60 * 1000);
  await waitFor(() => connections.length === 2, 'Ersatzverbindung');
  assert.equal(first.stopped, true, 'die stillstehende Verbindung wurde beendet');
  assert.equal(connections[1].stopped, false, 'die Ersatzverbindung läuft');
});

test('Der Backoff ist gedeckelt und gibt weitere Versuche immer wieder frei', async (t) => {
  let failures = 0;
  const { adapter, connections } = harness({
    pairingStatus() {
      failures += 1;
      return Promise.reject(Object.assign(new Error('Gerät antwortet nicht.'), { code: 'DEVICE_OFFLINE' }));
    },
  });
  t.after(() => adapter.stop());
  await adapter.start({ firmwareCatalogUrl: '', hdpDevices: [storedDevice()] });

  let now = Date.now();
  for (let round = 0; round < 12; round += 1) {
    adapter.superviseConnections(now);
    await settle();
    // Deutlich über dem gedeckelten Höchstabstand von fünf Minuten.
    now += 10 * 60 * 1000;
  }
  assert.equal(failures, 12, 'jeder Durchgang startet einen neuen Versuch');
  assert.equal(connections.length, 0, 'ohne Antwort entsteht keine Verbindung');

  // Auch nach vielen Fehlversuchen bleibt das Gerät ansprechbar.
  assert.ok(failures > 0);
});

test('RuntimeConnection meldet jeden Zustand, aus dem sie nicht von allein zurückkehrt', () => {
  const connection = new RuntimeConnection({
    device: { deviceId: DEVICE_ID, address: '127.0.0.1', wsPort: 81 },
    credentials: { instanceId: INSTANCE_ID, bindingKey: BINDING_KEY },
    wsFactory: () => new EventEmitter(),
  });

  assert.equal(connection.stalled, true, 'eine nie gestartete Verbindung steht still');

  connection.stopped = false;
  connection.reconnectForbidden = true;
  assert.equal(connection.stalled, true, 'eine gesperrte Verbindung steht still');

  connection.reconnectForbidden = false;
  connection.reconnectTimer = setTimeout(() => {}, 60000);
  assert.equal(connection.stalled, false, 'ein geplanter Neuversuch ist kein Stillstand');
  clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;

  connection.ready = true;
  assert.equal(connection.stalled, false, 'eine bestehende Sitzung ist kein Stillstand');

  // Ein Socket, der die Aufbauphase nie verlässt, hielte die Verbindung sonst
  // unbegrenzt fest: weder Handshake- noch Hello-Timer laufen dann noch.
  connection.ready = false;
  connection.socket = {};
  connection.connectStartedAt = Date.now();
  assert.equal(connection.stalled, false, 'ein frischer Verbindungsaufbau darf laufen');
  connection.connectStartedAt = Date.now() - CONNECT_STALL_MS - 1000;
  assert.equal(connection.stalled, true, 'ein festgefahrener Aufbau wird erkannt');
});

test('Eine abbrechende HTTP-Antwort lässt die Anfrage nicht offen stehen', async (t) => {
  // Header und Content-Length ankündigen, dann die Verbindung mitten im Rumpf
  // kappen: Danach feuert weder 'end' noch der Socket-Timeout.
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': '400',
    });
    res.write('{"ok":true,"data":{');
    setTimeout(() => res.socket.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new HdpClient({
    deviceId: DEVICE_ID, address: '127.0.0.1', apiPort: server.address().port,
  }, null);

  await assert.rejects(
    client.status(),
    (error) => error && typeof error.message === 'string',
    'die Anfrage endet mit einem Fehler statt unbegrenzt zu warten',
  );
});
