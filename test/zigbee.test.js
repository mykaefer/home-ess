'use strict';

// Tests des Zigbee-Adapters. Der Schwerpunkt liegt bewusst auf der Frage, die
// im Fehlerfall ein ganzes Zigbee-Netz kostet: Wird ein bestehendes Netz unter
// allen Umständen übernommen statt neu aufgebaut?

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createAdapter = require('../adapter/zigbee');
const transport = require('../adapter/zigbee/lib/transport');
const coordinator = require('../adapter/zigbee/lib/coordinator');
const network = require('../adapter/zigbee/lib/network');
const backup = require('../adapter/zigbee/lib/backup');
const exposesLib = require('../adapter/zigbee/lib/exposes');
const availability = require('../adapter/zigbee/lib/availability');
const converters = require('../adapter/zigbee/lib/converters');
const logging = require('../adapter/zigbee/lib/logging');
const management = require('../adapter/zigbee/lib/management');
const topology = require('../adapter/zigbee/lib/topology');
const mapLayout = require('../adapter/zigbee/lib/map-layout');
const mapView = require('../adapter/zigbee/lib/map-view');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-zigbee-test-'));
}

// Ein bestehendes, konfiguriertes Netz, wie es ein Coordinator meldet.
function existingNetwork(overrides = {}) {
  const key = Array.from({ length: 16 }, (_, index) => index + 1);
  return {
    coordinatorType: 'zstack',
    reachable: true,
    configured: true,
    ieeeAddress: '0x00124b002c3a7f69',
    firmware: { product: 'Z-Stack 3.x.0', version: '2.7.1', revision: '20210708', transportRevision: 2 },
    network: {
      panId: 0x1a62,
      extendedPanId: [0x00, 0x12, 0x4b, 0x00, 0x2c, 0x3a, 0x7f, 0x69],
      channel: 11,
      channelList: [11],
      networkKey: key,
      alternateNetworkKey: key,
    },
    ...overrides,
  };
}

// ── Manifest ────────────────────────────────────────────────────────────────

test('Zigbee-Manifest entspricht der Adapter-Spezifikation', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'adapter', 'zigbee', 'adapter.json'), 'utf8'));
  assert.equal(manifest.id, 'zigbee');
  assert.equal(manifest.prefix, 'zigbee');
  assert.match(manifest.id, /^[a-z][a-z0-9_-]*$/);
  assert.equal(manifest.main, 'index.js');
  assert.ok(manifest.version && manifest.name && manifest.description);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'adapter', 'zigbee', manifest.main)));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'adapter', 'zigbee', manifest.managementPage.stylesheet)));
  // Die generische Geräteseite entfällt: Die Netzwerkkarte zeigt die Geräte
  // samt ihren Verbindungen, das Umbenennen liegt in der Verwaltung.
  assert.equal(manifest.devicePage, undefined);
  for (const field of manifest.settings) {
    assert.match(field.key, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/, `Settings-Schlüssel ${field.key}`);
    assert.ok(['text', 'number', 'checkbox', 'select', 'password'].includes(field.type));
    if (field.type === 'select') assert.ok(Array.isArray(field.options) && field.options.length);
  }
  // Keine fest codierte Adresse, kein fest codierter Pfad im Auslieferungsstand.
  assert.equal(manifest.settings.find((f) => f.key === 'tcpHost').default, '');
  assert.equal(manifest.settings.find((f) => f.key === 'serialPath').default, '');
});

test('Der Adapter bündelt seine Abhängigkeiten im eigenen Verzeichnis', () => {
  const adapterDir = path.join(__dirname, '..', 'adapter', 'zigbee');
  const pkg = JSON.parse(fs.readFileSync(path.join(adapterDir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['zigbee-herdsman']);
  assert.ok(pkg.dependencies['zigbee-herdsman-converters']);
  // Die Bibliotheken müssen aus dem Adapterverzeichnis auflösbar sein und
  // dürfen nicht in den homeESS-Abhängigkeiten stehen.
  assert.ok(fs.existsSync(path.join(adapterDir, 'node_modules', 'zigbee-herdsman')));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(rootPkg.dependencies['zigbee-herdsman'], undefined);
  assert.equal(rootPkg.dependencies['zigbee-herdsman-converters'], undefined);
});

// ── Transport ───────────────────────────────────────────────────────────────

test('Transport trennt Coordinator-Typ und Anbindung', () => {
  const tcp = transport.resolveTransport({ transportType: 'tcp', tcpHost: '192.168.10.20', tcpPort: 6638 });
  assert.equal(tcp.path, 'tcp://192.168.10.20:6638');
  assert.equal(tcp.type, 'tcp');

  const serial = transport.resolveTransport({
    transportType: 'serial',
    serialPath: '/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus-if00-port0',
    baudRate: 115200,
  });
  assert.equal(serial.type, 'serial');
  assert.equal(serial.warnings.length, 0, 'stabiler Pfad wird nicht bemängelt');

  // Instabile Gerätepfade werden benannt, aber nicht abgelehnt.
  const unstable = transport.resolveTransport({ transportType: 'serial', serialPath: '/dev/ttyUSB0' });
  assert.equal(unstable.warnings.length, 1);
  assert.match(unstable.warnings[0], /by-id/);
});

test('Transport weist unbrauchbare Angaben ab', () => {
  assert.throws(() => transport.resolveTransport({ transportType: 'tcp', tcpHost: '', tcpPort: 6638 }), /Adresse/);
  assert.throws(() => transport.resolveTransport({ transportType: 'tcp', tcpHost: 'a.b', tcpPort: 0 }), /Port/);
  assert.throws(() => transport.resolveTransport({ transportType: 'tcp', tcpHost: 'host/pfad?x=1', tcpPort: 1 }), /Adresse/);
  assert.throws(() => transport.resolveTransport({ transportType: 'serial', serialPath: 'ttyUSB0' }), /absolut/);
  // Eine Netzwerkadresse im seriellen Feld würde stillschweigend zu TCP werden.
  assert.throws(() => transport.resolveTransport({ transportType: 'serial', serialPath: 'tcp://1.2.3.4:1' }), /absolut|Netzwerkadresse/);
  assert.throws(() => transport.resolveTransport({ transportType: 'usb' }), /Anbindung/);
});

// ── Coordinator-Treiber ─────────────────────────────────────────────────────

test('Nur freigegebene Coordinator-Typen werden in Betrieb genommen', () => {
  assert.equal(coordinator.getDriver('zstack').herdsmanAdapter, 'zstack');
  assert.equal(coordinator.getDriver().id, 'zstack', 'Standard ist Z-Stack');
  // Ember und deCONZ sind vorbereitet, aber ohne lesende Netzabfrage nicht
  // freigegeben — sonst drohte ein unbemerkter Netzneuaufbau.
  assert.throws(() => coordinator.getDriver('ember'), /nicht freigegeben/);
  assert.throws(() => coordinator.getDriver('deconz'), /nicht freigegeben/);
  assert.throws(() => coordinator.getDriver('irgendwas'), /Unbekannter Coordinator-Typ/);
  assert.equal(coordinator.listDrivers().length, 3);
});

// ── Netzwerkübernahme: der sicherheitskritische Kern ────────────────────────

test('Ein bestehendes Netz wird unverändert übernommen', () => {
  const plan = network.planNetwork(existingNetwork(), null, { mode: 'adopt' });
  assert.equal(plan.action, 'adopt');
  assert.equal(plan.destructive, false);
  const options = network.herdsmanNetworkOptions(plan);
  // Genau die Werte des Coordinators – nur so erkennt zigbee-herdsman das Netz
  // als passend und startet es, statt neu zu kommissionieren.
  assert.equal(options.panID, 0x1a62);
  assert.deepEqual(options.channelList, [11]);
  assert.deepEqual(options.extendedPanID, [0x00, 0x12, 0x4b, 0x00, 0x2c, 0x3a, 0x7f, 0x69]);
  assert.deepEqual(options.networkKey, existingNetwork().network.networkKey);
});

test('Fehlende homeESS-Persistenz erzeugt niemals ein neues Netz', () => {
  // Der Ausgangspunkt eines Umzugs: Coordinator mit Netz, homeESS ohne jede
  // gespeicherte Information. Das darf keine Neukommissionierung auslösen.
  const plan = network.planNetwork(existingNetwork(), null, { mode: 'adopt' });
  assert.equal(plan.action, 'adopt');
  assert.equal(plan.destructive, false);
});

test('Abweichende gespeicherte Daten ändern das Netz nicht — der Coordinator gilt', () => {
  const plan = network.planNetwork(existingNetwork(), { panId: 0x2222 }, { mode: 'adopt' });
  assert.equal(plan.action, 'adopt');
  assert.equal(plan.network.panId, 0x1a62);
  assert.match(plan.note, /Maßgeblich ist der Coordinator/);
});

test('Ein Coordinator ohne Netz wird nicht selbsttätig kommissioniert', () => {
  const probe = { ...existingNetwork(), configured: false, network: null };
  assert.throws(() => network.planNetwork(probe, null, { mode: 'adopt' }), (error) => {
    assert.equal(error.code, 'ZIGBEE_NO_NETWORK');
    return true;
  });
});

test('Ein neues Netz entsteht nur mit ausdrücklicher Bestätigung', () => {
  // Die Einstellung allein genügt nicht.
  assert.throws(() => network.planNetwork(existingNetwork(), null, { mode: 'create' }), (error) => {
    assert.equal(error.code, 'ZIGBEE_CREATE_UNCONFIRMED');
    return true;
  });
  const plan = network.planNetwork(existingNetwork(), null, { mode: 'create', createConfirmed: true, channel: 15 });
  assert.equal(plan.action, 'create');
  assert.equal(plan.destructive, true);
  assert.equal(plan.network.channel, 15);
  assert.equal(plan.network.networkKey.length, 16);
  // Frische Zufallswerte, nicht die des bestehenden Netzes.
  assert.notDeepEqual(plan.network.networkKey, existingNetwork().network.networkKey);
  assert.notEqual(plan.network.panId, 0x1a62);
});

test('Zwei erzeugte Netze unterscheiden sich in Schlüssel und PAN-ID', () => {
  const intent = { mode: 'create', createConfirmed: true };
  const first = network.planNetwork(existingNetwork(), null, intent);
  const second = network.planNetwork(existingNetwork(), null, intent);
  assert.notDeepEqual(first.network.networkKey, second.network.networkKey);
  assert.notDeepEqual(first.network.extendedPanId, second.network.extendedPanId);
});

test('Abweichender Alternativschlüssel verhindert den Start statt das Netz zu verlieren', () => {
  // zigbee-herdsman verlangt Übereinstimmung von aktivem UND alternativem
  // Schlüssel. Ohne diese Prüfung würde es das Netz neu aufbauen.
  const probe = existingNetwork();
  probe.network.alternateNetworkKey = Array.from({ length: 16 }, () => 0xaa);
  assert.throws(() => network.planNetwork(probe, null, { mode: 'adopt' }), (error) => {
    assert.equal(error.code, 'ZIGBEE_ADOPT_KEY_MISMATCH');
    return true;
  });
});

test('Ein Netz ohne auslesbaren Schlüssel wird nicht überschrieben', () => {
  const probe = existingNetwork();
  probe.network.networkKey = null;
  assert.throws(() => network.planNetwork(probe, null, { mode: 'adopt' }), (error) => {
    assert.equal(error.code, 'ZIGBEE_ADOPT_NO_KEY');
    return true;
  });
});

test('Ein nicht erreichbarer Coordinator führt nicht zu einem neuen Netz', () => {
  assert.throws(() => network.planNetwork({ reachable: false }, null, { mode: 'adopt' }), (error) => {
    assert.equal(error.code, 'ZIGBEE_COORDINATOR_UNREACHABLE');
    return true;
  });
});

test('Der Netzwerkschlüssel wird von der normalen Persistenz getrennt', () => {
  const plan = network.planNetwork(existingNetwork(), null, { mode: 'adopt' });
  const split = network.splitPersistence(plan.network);
  assert.equal(JSON.stringify(split.metadata).match(/[0-9a-f]{32}/i), null,
    'die persistierten Metadaten enthalten kein Schlüsselmaterial');
  assert.equal(split.secret.length, 32, 'der Schlüssel geht als Hex in den Secret-Store');
  const restored = network.mergePersistence(split.metadata, split.secret);
  assert.deepEqual(restored.networkKey, plan.network.networkKey);
  assert.equal(restored.panId, 0x1a62);
});

// ── Sicherheit: Logausgaben ─────────────────────────────────────────────────

test('Schlüsselmaterial wird aus Logausgaben entfernt', () => {
  assert.match(logging.redact('networkKey: 000102030405060708090a0b0c0d0e0f'), /«entfernt»/);
  assert.doesNotMatch(logging.redact('networkKey: 000102030405060708090a0b0c0d0e0f'), /000102030405/);
  // Genau die Meldung, mit der zigbee-herdsman bei Konfigurationsabweichung
  // Schlüssel im Klartext ausgibt.
  const herdsmanLine = '- Network Key: configured=000102030405060708090a0b0c0d0e0f, '
    + 'adapter:active=0f0e0d0c0b0a09080706050403020100';
  assert.doesNotMatch(logging.redact(herdsmanLine), /0f0e0d0c/);
  // Bytelisten ebenso.
  assert.doesNotMatch(logging.redact('key [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]'), /\[1, 2/);
  // Die IEEE-Adresse ist kein Geheimnis und muss lesbar bleiben.
  assert.match(logging.redact('ieeeAddr 0x00124b002c3a7f69'), /00124b002c3a7f69/);
});

test('Der Bibliothekslogger reicht Meldungen redigiert an homeESS weiter', () => {
  const lines = [];
  const host = {
    log: (m) => lines.push(['info', m]), error: (m) => lines.push(['error', m]),
    warn: (m) => lines.push(['warn', m]), debug: (m) => lines.push(['debug', m]),
  };
  const logger = logging.createLibraryLogger(host, () => ['GEHEIMESTOKEN123']);
  logger.error('Fehler mit GEHEIMESTOKEN123', 'zh:test');
  logger.warning('Warnung', 'zh:test');
  logger.info('Info', 'zh:test');
  assert.equal(lines[0][0], 'error');
  assert.doesNotMatch(lines[0][1], /GEHEIMESTOKEN123/);
  assert.equal(lines[1][0], 'warn');
  // Infomeldungen der Bibliothek sind sehr gesprächig und gehören ins Debuglog.
  assert.equal(lines[2][0], 'debug');
});

// ── States aus Exposes ──────────────────────────────────────────────────────

test('Exposes werden zu States mit korrekter Schreibbarkeit', () => {
  // Die Converter liegen im Adapterverzeichnis, nicht in den homeESS-Modulen.
  const zhc = require('../adapter/zigbee/lib/converters').zhc;
  const features = exposesLib.flattenExposes([
    new zhc.Light().withBrightness().withColorTemp([150, 500]),
    new zhc.Numeric('power', 5).withUnit('W'),
    new zhc.Numeric('battery', 1).withUnit('%'),
    new zhc.Enum('mode', 7, ['auto', 'heat']),
  ]);
  const byProperty = new Map(features.map((f) => [f.property, f]));
  // Sammelnde Typen werden flachgeklopft: Die Merkmale der Lampe stehen direkt.
  assert.ok(byProperty.has('state'));
  assert.ok(byProperty.has('brightness'));
  assert.equal(byProperty.get('state').writable, true);
  assert.equal(byProperty.get('state').readable, true);
  // Access 5 = STATE|GET, also lesbar aber nicht beschreibbar.
  assert.equal(byProperty.get('power').writable, false);
  assert.equal(byProperty.get('power').unit, 'W');
  // Access 1 = nur Status.
  assert.equal(byProperty.get('battery').writable, false);
  assert.equal(byProperty.get('mode').writable, true);
  assert.deepEqual(byProperty.get('mode').values, ['auto', 'heat']);
});

test('State-Adressen bleiben über eine Umbenennung stabil', () => {
  const device = { ieeeAddress: '0x00124B002C3A7F69', friendlyName: 'Wohnzimmer Lampe' };
  const states = exposesLib.deviceStates(device, [
    { property: 'state', label: 'Schalter', unit: '', writable: true },
  ]);
  // Die Adresse folgt der IEEE-Adresse, der Anzeigename nur der Kategorie.
  assert.equal(states[0].address, '00124b002c3a7f69/state');
  assert.match(states[0].category, /Wohnzimmer Lampe/);
  const renamed = exposesLib.deviceStates({ ...device, friendlyName: 'Esszimmer Lampe' }, [
    { property: 'state', label: 'Schalter', unit: '', writable: true },
  ]);
  assert.equal(renamed[0].address, states[0].address, 'die Adresse überlebt die Umbenennung');
});

test('Jedes Gerät erhält Diagnosewerte, der Coordinator eigene States', () => {
  const states = exposesLib.deviceStates({ ieeeAddress: '0xabc', friendlyName: 'Sensor' }, []);
  const addresses = states.map((s) => s.address);
  for (const property of ['linkquality', 'available', 'last_seen', 'interview_state']) {
    assert.ok(addresses.includes(`abc/${property}`), `Diagnosewert ${property}`);
  }
  assert.ok(states.every((s) => s.writable === false), 'Diagnosewerte sind nie beschreibbar');

  const coordinatorAddresses = exposesLib.coordinatorStates().map((s) => s.address);
  for (const address of ['coordinator/connected', 'coordinator/ieee_address', 'coordinator/pan_id',
    'coordinator/channel', 'coordinator/permit_join']) {
    assert.ok(coordinatorAddresses.includes(address), address);
  }
  const permit = exposesLib.coordinatorStates().find((s) => s.address === 'coordinator/permit_join');
  assert.equal(permit.writable, true, 'Anlernen lässt sich über einen State schalten');
});

test('Werte werden auf homeESS-taugliche Typen gebracht', () => {
  assert.equal(exposesLib.normalizeValue(21.5), 21.5);
  assert.equal(exposesLib.normalizeValue('ON'), 'ON');
  assert.equal(exposesLib.normalizeValue(true), true);
  assert.equal(exposesLib.normalizeValue(null), null);
  assert.equal(exposesLib.normalizeValue(Number.NaN), null);
  // Zusammengesetzte Werte werden als JSON geführt, weil ein State genau einen
  // Zahl-, Wahrheits- oder Textwert hält.
  assert.equal(exposesLib.normalizeValue({ x: 0.5, y: 0.4 }), '{"x":0.5,"y":0.4}');
});

// ── Befehle ─────────────────────────────────────────────────────────────────

test('Schreibwerte werden gemäß Expose umgesetzt, nicht gerätespezifisch', () => {
  const binary = { property: 'state', type: 'binary', valueOn: 'ON', valueOff: 'OFF' };
  assert.equal(converters.coerceValue(binary, true), 'ON');
  assert.equal(converters.coerceValue(binary, false), 'OFF');
  assert.equal(converters.coerceValue(binary, 'ein'), 'ON');
  assert.equal(converters.coerceValue(binary, 0), 'OFF');
  assert.equal(converters.coerceValue(binary, 'OFF'), 'OFF');

  const numeric = { property: 'brightness', type: 'numeric', min: 0, max: 254 };
  assert.equal(converters.coerceValue(numeric, '128'), 128);
  assert.equal(converters.coerceValue(numeric, 5000), 254, 'wird auf das erlaubte Maximum begrenzt');
  assert.equal(converters.coerceValue(numeric, -5), 0);
  assert.throws(() => converters.coerceValue(numeric, 'hell'), /erwartet eine Zahl/);

  const enumeration = { property: 'system_mode', type: 'enum', values: ['off', 'heat', 'auto'] };
  assert.equal(converters.coerceValue(enumeration, 'HEAT'), 'heat');
  assert.throws(() => converters.coerceValue(enumeration, 'warm'), /erlaubt nur/);

  const composite = { property: 'color', type: 'composite', structured: true };
  assert.deepEqual(converters.coerceValue(composite, '{"x":0.7,"y":0.3}'), { x: 0.7, y: 0.3 });
  assert.throws(() => converters.coerceValue(composite, 'rot'), /JSON/);
});

test('Der passende toZigbee-Converter wird über den Merkmalsschlüssel gefunden', () => {
  const definition = {
    toZigbee: [
      { key: ['state'], convertSet: () => {} },
      { key: ['state'], endpoints: ['left'], convertSet: () => {} },
      { key: ['brightness'], convertSet: () => {} },
    ],
  };
  assert.equal(converters.findSendConverter(definition, 'state', 'left'), definition.toZigbee[1],
    'endpunktgebundene Converter haben Vorrang');
  assert.equal(converters.findSendConverter(definition, 'state', undefined), definition.toZigbee[0]);
  assert.equal(converters.findSendConverter(definition, 'unbekannt'), undefined);
});

test('Empfangene Nachrichten werden über die passenden Converter ausgewertet', async () => {
  const definition = {
    fromZigbee: [
      { cluster: 'msTemperatureMeasurement', type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => ({ temperature: msg.data.measuredValue / 100 }) },
      { cluster: 'genBasic', type: 'attributeReport', convert: () => ({ ignoriert: true }) },
      { cluster: 'msTemperatureMeasurement', type: 'attributeReport',
        convert: () => { throw new Error('kaputter Converter'); } },
    ],
  };
  const errors = [];
  const payload = await converters.convertReceived({
    definition,
    message: { cluster: 'msTemperatureMeasurement', type: 'attributeReport', data: { measuredValue: 2137 } },
    device: {}, state: {}, options: {},
    onError: (error) => errors.push(error.message),
  });
  assert.equal(payload.temperature, 21.37);
  assert.equal(payload.ignoriert, undefined, 'ein anderer Cluster wird nicht ausgewertet');
  // Ein fehlerhafter Converter darf die übrigen Werte nicht verhindern.
  assert.ok(errors.some((message) => /kaputter Converter/.test(message)));
});

// ── Verfügbarkeit ───────────────────────────────────────────────────────────

test('Verfügbarkeit unterscheidet Router, Netz- und Batteriegeräte', () => {
  assert.equal(availability.classifyDevice({ type: 'Router', powerSource: 'Mains (single phase)' }), 'router');
  assert.equal(availability.classifyDevice({ type: 'EndDevice', powerSource: 'Mains (single phase)' }), 'mains');
  assert.equal(availability.classifyDevice({ type: 'EndDevice', powerSource: 'Battery' }), 'battery');
  // Unbekannte Energiequelle wird vorsichtshalber als schlafend behandelt.
  assert.equal(availability.classifyDevice({ type: 'EndDevice', powerSource: 'Unknown' }), 'battery');
});

test('Schlafende Batteriegeräte gelten nicht als offline', () => {
  const now = Date.now();
  const config = { availabilityMainsMinutes: 15, availabilityBatteryHours: 25 };
  // Ein Fenstersensor, der sich seit zwölf Stunden nicht gemeldet hat, ist in
  // Ordnung — ein netzbetriebenes Gerät nach derselben Zeit nicht.
  assert.equal(availability.evaluate({ deviceClass: 'battery', lastSeen: now - 12 * 3600e3 }, config, now).available, true);
  assert.equal(availability.evaluate({ deviceClass: 'mains', lastSeen: now - 12 * 3600e3 }, config, now).available, false);
  assert.equal(availability.evaluate({ deviceClass: 'battery', lastSeen: now - 30 * 3600e3 }, config, now).available, false);
  // Ohne je empfangene Meldung ist der Zustand unbekannt, nicht offline.
  assert.equal(availability.evaluate({ deviceClass: 'battery', lastSeen: 0 }, config, now).available, null);
});

test('Batteriegeräte werden niemals aktiv geweckt', () => {
  const now = Date.now();
  const config = { availabilityMainsMinutes: 15, availabilityBatteryHours: 25, activePing: true };
  assert.equal(availability.shouldPing({ deviceClass: 'battery', lastSeen: 0 }, config, now), false);
  assert.equal(availability.shouldPing({ deviceClass: 'battery', lastSeen: now - 40 * 3600e3 }, config, now), false);
  // Netzbetriebene Geräte dagegen schon – aber nicht ununterbrochen.
  assert.equal(availability.shouldPing({ deviceClass: 'router', lastSeen: now - 12 * 60e3 }, config, now), true);
  assert.equal(availability.shouldPing({ deviceClass: 'router', lastSeen: now - 60e3 }, config, now), false);
  assert.equal(availability.shouldPing({ deviceClass: 'router', lastSeen: now - 12 * 60e3 },
    { ...config, activePing: false }, now), false);
});

// ── Backup und Import ───────────────────────────────────────────────────────

test('Coordinator-Backups werden geprüft, bevor sie übernommen werden', () => {
  const valid = {
    metadata: { format: 'zigpy/open-coordinator-backup', version: 1, source: 'zigbee2mqtt' },
    coordinator_ieee: '00124b002c3a7f69', pan_id: '1a62', extended_pan_id: '00124b002c3a7f69',
    channel: 11, network_key: { key: '00'.repeat(16) },
    devices: [{ nwk_address: '423', ieee_address: 'b4e3f9fffe15be72', is_child: true }],
  };
  const info = backup.inspectBackup(JSON.stringify(valid));
  assert.equal(info.format, 'unified');
  assert.equal(info.deviceCount, 1);
  assert.equal(info.channel, 11);

  assert.throws(() => backup.inspectBackup('kein json'), /gültiges JSON/);
  assert.throws(() => backup.inspectBackup('{"foo":1}'), /Unbekanntes Backupformat/);
  assert.throws(() => backup.inspectBackup(JSON.stringify({
    metadata: { format: 'zigpy/open-coordinator-backup', version: 9 },
  })), /Backupversion/);
  assert.throws(() => backup.inspectBackup(JSON.stringify({
    metadata: { format: 'zigpy/open-coordinator-backup', version: 1 }, pan_id: '1a62',
  })), /Pflichtangaben/);
});

test('Ein Zigbee2MQTT-Backup wird übernommen und das vorherige gesichert', () => {
  const directory = tempDir();
  try {
    const first = path.join(directory, 'erste.json');
    const second = path.join(directory, 'zweite.json');
    const build = (panId) => JSON.stringify({
      metadata: { format: 'zigpy/open-coordinator-backup', version: 1, source: 'zigbee2mqtt' },
      coordinator_ieee: '00124b002c3a7f69', pan_id: panId, extended_pan_id: '00124b002c3a7f69',
      channel: 11, network_key: { key: '00'.repeat(16) }, devices: [],
    });
    fs.writeFileSync(first, build('1a62'));
    fs.writeFileSync(second, build('2b73'));

    backup.importBackup(directory, first);
    assert.ok(fs.existsSync(backup.paths(directory).backup));
    backup.importBackup(directory, second);
    // Das vorherige Backup darf nicht spurlos verschwinden.
    const backups = fs.readdirSync(directory).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(backup.paths(directory).backup, 'utf8')).pan_id, '2b73');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Die Geräte des Coordinator-Backups sind für die Übernahme auswertbar', () => {
  const directory = tempDir();
  try {
    fs.writeFileSync(backup.paths(directory).backup, JSON.stringify({
      metadata: { format: 'zigpy/open-coordinator-backup', version: 1 },
      coordinator_ieee: '00124b002c3a7f69', pan_id: '1a62', channel: 11,
      network_key: { key: '00'.repeat(16) },
      devices: [
        { nwk_address: '423', ieee_address: 'b4e3f9fffe15be72', is_child: true },
        { nwk_address: 'd857', ieee_address: 'e8e07efffeefd93a', is_child: false, link_key: { key: 'ab' } },
        { nwk_address: 'zzz', ieee_address: 'ungültig' },
      ],
    }));
    const rows = backup.readBackupDevices(directory);
    assert.equal(rows.length, 2, 'ungültige Einträge werden übersprungen');
    assert.equal(rows[0].ieeeAddress, '0xb4e3f9fffe15be72');
    assert.equal(rows[0].networkAddress, 0x423);
    assert.equal(rows[1].hasLinkKey, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Die Gerätedatenbank von Zigbee2MQTT wird geprüft übernommen', () => {
  const directory = tempDir();
  try {
    const source = path.join(directory, 'database.db');
    fs.writeFileSync(source, [
      JSON.stringify({ id: 1, type: 'Coordinator', ieeeAddr: '0x00124b002c3a7f69' }),
      JSON.stringify({ id: 2, type: 'EndDevice', ieeeAddr: '0xb4e3f9fffe15be72', modelId: 'lumi.weather' }),
      JSON.stringify({ id: 3, type: 'Group', groupID: 1 }),
    ].join('\n'));
    const info = backup.importDeviceDatabase(directory, source);
    assert.equal(info.devices, 2);
    assert.equal(info.groups, 1);
    assert.ok(fs.existsSync(backup.paths(directory).database));

    const broken = path.join(directory, 'kaputt.db');
    fs.writeFileSync(broken, 'das ist keine datenbank');
    assert.throws(() => backup.importDeviceDatabase(directory, broken), /Gerätedatenbank/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ── Verwaltungsseite und Rechte ─────────────────────────────────────────────

function managementContext(overrides = {}) {
  return {
    instanceName: 'testinstanz',
    config: { networkMode: 'adopt', permitJoinSeconds: 120 },
    runtime: {
      status: () => ({
        connected: true, starting: false, stopped: false, networkState: 'übernommen', lastError: '',
        transport: { type: 'tcp', label: 'TCP 10.0.0.5:6638' },
        coordinator: { type: 'zstack', ieeeAddress: '0x00124b002c3a7f69', configured: true,
          firmware: { product: 'Z-Stack 3.x.0', version: '2.7.1', revision: '20210708', transportRevision: 2 } },
        network: { panId: 6754, panIdHex: '0x1a62', extendedPanId: '00124b002c3a7f69', channel: 11, updatedAt: '' },
        planAction: 'adopt', createConfirmed: false, permitJoin: { active: false, remaining: 0 },
        deviceCount: 2, devicesOnline: 1, backup: null, adoptableDevices: 0, dataDirectory: '/tmp',
      }),
      devices: () => [],
      setPermitJoin: async () => ({ active: true, remaining: 60 }),
      removeDevice: async () => ({ removed: 'Lampe' }),
      confirmNetworkCreation: () => ({ channel: 11 }),
      reconnectNow: async () => ({ connected: true, error: '' }),
      createBackup: async () => ({ format: 'unified' }),
      adoptDevicesFromBackup: async () => ({ added: 1, known: 0, failed: 0, total: 1 }),
      interviewPendingDevices: async () => ({ interviewed: 1, failed: 0, skipped: 0 }),
      networkMap: () => ({ nodes: [], edges: [], scannedAt: null, unreachable: [], isolated: [],
        progress: { running: false }, connected: true }),
      scanTopology: async () => ({ nodes: [], edges: [], unreachable: [], scannedAt: 'jetzt' }),
      topologyProgress: () => ({ running: false }),
      writeProperty: async (device, property, value) => ({ [property]: value }),
      renameDevice: async (slug, name) => ({ slug, name, customName: name }),
      importBackupFile: () => ({ format: 'unified' }),
      importDeviceDatabaseFile: () => ({ devices: 1, groups: 0 }),
      ...overrides,
    },
  };
}

const ACCESS_ADMIN = { canRead: true, canOperate: true, canWrite: true, isAdmin: true };
const ACCESS_READ = { canRead: true, canOperate: false, canWrite: false, isAdmin: false };
const ACCESS_OPERATE = { canRead: true, canOperate: true, canWrite: false, isAdmin: false };

test('Die Verwaltungsseite zeigt Coordinator und Netz an', async () => {
  const response = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_ADMIN, basePath: '/adapter/instance/1/manage' },
    managementContext());
  assert.equal(response.status, 200);
  assert.match(response.view.body, /0x00124b002c3a7f69/);
  assert.match(response.view.body, /0x1a62/);
  assert.match(response.view.body, /Z-Stack 3\.x\.0/);
  assert.match(response.view.body, /TCP 10\.0\.0\.5:6638/);
  // Bei Übernahme wird ausdrücklich zugesichert, dass nichts verändert wird.
  assert.match(response.view.body, /übernimmt das vorhandene Zigbee-Netz/);
});

test('Die Verwaltung setzt Rechte serverseitig durch', async () => {
  const context = managementContext();
  // Lesender Zugriff darf weder schalten noch verändern.
  for (const [method, subpath] of [['POST', '/permit-join'], ['POST', '/devices/remove'],
    ['POST', '/reconnect'], ['POST', '/backup'], ['POST', '/network/create']]) {
    const response = await management.handleRequest(
      { method, path: subpath, access: ACCESS_READ, body: { confirm: true } }, context);
    assert.equal(response.status, 403, `${method} ${subpath} muss abgewiesen werden`);
  }
  // Bedienrechte genügen für das Anlernen, nicht für die Konfiguration.
  const permit = await management.handleRequest(
    { method: 'POST', path: '/permit-join', access: ACCESS_OPERATE, body: { enabled: true } }, context);
  assert.equal(permit.status, 200);
  const remove = await management.handleRequest(
    { method: 'POST', path: '/devices/remove', access: ACCESS_OPERATE, body: { device: 'abc' } }, context);
  assert.equal(remove.status, 403);
});

test('Ein neues Netz verlangt Administrator, Bestätigung und passende Einstellung', async () => {
  // Ohne Administratorrecht.
  let response = await management.handleRequest(
    { method: 'POST', path: '/network/create', access: { ...ACCESS_ADMIN, isAdmin: false }, body: { confirm: true } },
    managementContext());
  assert.equal(response.status, 403);

  // Ohne Bestätigung.
  response = await management.handleRequest(
    { method: 'POST', path: '/network/create', access: ACCESS_ADMIN, body: {} },
    managementContext());
  assert.equal(response.status, 400);

  // Mit Bestätigung, aber die Instanz steht auf „übernehmen".
  response = await management.handleRequest(
    { method: 'POST', path: '/network/create', access: ACCESS_ADMIN, body: { confirm: true, channel: 15 } },
    managementContext());
  assert.equal(response.status, 409);
  assert.match(response.json.error, /Bestehendes Netzwerk übernehmen/);

  // Erst beides zusammen wird ausgeführt.
  const context = managementContext();
  context.config.networkMode = 'create';
  let confirmed = null;
  context.runtime.confirmNetworkCreation = (channel) => { confirmed = channel; return { channel }; };
  response = await management.handleRequest(
    { method: 'POST', path: '/network/create', access: ACCESS_ADMIN, body: { confirm: true, channel: 15 } },
    context);
  assert.equal(response.status, 200);
  assert.equal(confirmed, 15);
});

test('Ein Backupimport bleibt Administratoren vorbehalten', async () => {
  const context = managementContext();
  let response = await management.handleRequest(
    { method: 'POST', path: '/backup/import', access: { ...ACCESS_ADMIN, isAdmin: false } }, context);
  assert.equal(response.status, 403);
  response = await management.handleRequest(
    { method: 'POST', path: '/backup/import', access: ACCESS_ADMIN, upload: null }, context);
  assert.equal(response.status, 400, 'ohne Datei kein Import');
  response = await management.handleRequest(
    { method: 'POST', path: '/backup/import', access: ACCESS_ADMIN, upload: { path: '/tmp/x', size: 1 } }, context);
  assert.equal(response.status, 200);
});

test('Die Geräteübernahme aus dem Backup ist über die Verwaltung erreichbar', async () => {
  const context = managementContext();
  context.runtime.status = () => ({
    ...managementContext().runtime.status(), adoptableDevices: 12,
  });
  const view = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_ADMIN, basePath: '/x' }, context);
  // Der entscheidende Hinweis: Übernahme statt erneutem Anlernen.
  assert.match(view.view.body, /12 Geräte übernehmen/);
  assert.match(view.view.body, /erneutes Anlernen ist dafür nicht nötig/);

  const adopt = await management.handleRequest(
    { method: 'POST', path: '/devices/adopt', access: ACCESS_ADMIN }, context);
  assert.equal(adopt.status, 200);
  assert.equal(adopt.json.added, 1);

  // Ohne Schreibrecht nicht.
  const denied = await management.handleRequest(
    { method: 'POST', path: '/devices/adopt', access: ACCESS_OPERATE }, context);
  assert.equal(denied.status, 403);
});

test('Der Import einer Gerätedatenbank bleibt Administratoren vorbehalten', async () => {
  const context = managementContext();
  let response = await management.handleRequest(
    { method: 'POST', path: '/database/import', access: { ...ACCESS_ADMIN, isAdmin: false } }, context);
  assert.equal(response.status, 403);
  response = await management.handleRequest(
    { method: 'POST', path: '/database/import', access: ACCESS_ADMIN, upload: { path: '/tmp/x', size: 1 } }, context);
  assert.equal(response.status, 200);
  assert.equal(response.json.database.devices, 1);
});


// ── Netzwerkkarte ───────────────────────────────────────────────────────────

test('Die Verbindungsqualität wird aus dem LQI eingestuft', () => {
  assert.equal(topology.qualityFor(250).key, 'excellent');
  assert.equal(topology.qualityFor(150).key, 'good');
  assert.equal(topology.qualityFor(100).key, 'fair');
  assert.equal(topology.qualityFor(30).key, 'poor');
  // Ein fehlender Wert ist nicht dasselbe wie ein schlechter Wert: Number(null)
  // wäre 0 und damit fälschlich „schwach".
  assert.equal(topology.qualityFor(null).key, 'unknown');
  assert.equal(topology.qualityFor(undefined).key, 'unknown');
  assert.equal(topology.qualityFor('quatsch').key, 'unknown');
  // Der Anteil steuert Strichstärke und Federlänge und bleibt im Bereich 0..1.
  for (const value of [0, 60, 128, 255, 999, -5]) {
    const quality = topology.qualityFor(value);
    assert.ok(quality.ratio >= 0 && quality.ratio <= 1, `ratio für ${value}`);
  }
});

test('Aus den Nachbartabellen entsteht ein Graph ohne Doppelkanten', async () => {
  // Zwei Router melden dieselbe Strecke mit unterschiedlichem LQI.
  const nodes = [
    { address: 'aa', name: 'Coordinator', zh: { async lqi() {
      return [{ eui64: '0xbb', nwkAddress: 2, deviceType: 1, relationship: 1, depth: 1, lqi: 200 }];
    } } },
    { address: 'bb', name: 'Router', zh: { async lqi() {
      return [{ eui64: '0xaa', nwkAddress: 0, deviceType: 0, relationship: 0, depth: 0, lqi: 120 }];
    } } },
    { address: 'cc', name: 'Stumm', zh: { async lqi() { throw new Error('keine Antwort'); } } },
  ];
  const warnings = [];
  const scan = await topology.scanTopology({ nodes, onWarning: (node, message) => warnings.push(message) });

  // Beide Richtungen ergeben eine Kante, nicht zwei.
  assert.equal(scan.edges.length, 1);
  // Behalten wird die bessere Messung — maßgeblich ist, ob die Strecke trägt.
  assert.equal(scan.edges[0].lqi, 200);
  assert.equal(scan.edges[0].lqiMin, 120);
  assert.equal(scan.edges[0].reports, 2);
  assert.equal(scan.edges[0].relationship, 'parent-child');
  assert.equal(scan.edges[0].quality.key, 'excellent');
  // Ein stummer Knoten ist kein Fehler des Adapters.
  assert.deepEqual(scan.unreachable, ['cc']);
  assert.equal(warnings.length, 1);
});

test('Der Graph erfindet keine Knoten für unbekannte Nachbarn', () => {
  const scan = {
    edges: [
      { source: 'aa', target: 'bb', lqi: 200, quality: topology.qualityFor(200) },
      // Ein Nachbar, den homeESS nicht kennt — etwa ein Gerät eines anderen Netzes.
      { source: 'aa', target: 'fremd', lqi: 90, quality: topology.qualityFor(90) },
    ],
    scanned: ['aa'], unreachable: [], depths: new Map([['bb', 1]]),
  };
  const graph = topology.buildGraph({
    nodes: [{ address: 'aa', name: 'A' }, { address: 'bb', name: 'B' }, { address: 'cc', name: 'C' }],
    scan,
  });
  assert.equal(graph.edges.length, 1, 'die Kante ins Unbekannte entfällt');
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes.find((node) => node.address === 'bb').depth, 1);
  assert.equal(graph.nodes.find((node) => node.address === 'bb').links, 1);
  // Ein Knoten ohne Kante wird als solcher ausgewiesen, statt eine Verbindung
  // zu erfinden.
  assert.deepEqual(graph.isolated, ['cc']);
});

test('Die Gerätegattung entsteht aus den Exposes, nicht aus einer Geräteliste', () => {
  const zhc = require('../adapter/zigbee/lib/converters').zhc;
  const kind = (exposes, device) => exposesLib.deviceKind(exposes, device || {});
  assert.equal(kind([new zhc.Light().withBrightness()]), 'light');
  assert.equal(kind([new zhc.Cover().withPosition()]), 'cover');
  assert.equal(kind([new zhc.Climate().withSetpoint('occupied_heating_setpoint', 5, 30, 0.5)]), 'thermostat');
  // Eine Steckdose misst mit, ein reiner Schaltaktor nicht.
  assert.equal(kind([new zhc.Switch().withState('state', true, 'x'), new zhc.Numeric('power', 1)]), 'outlet');
  assert.equal(kind([new zhc.Switch().withState('state', true, 'x')]), 'relay');
  assert.equal(kind([new zhc.Binary('occupancy', 1, true, false)]), 'motion');
  assert.equal(kind([new zhc.Binary('contact', 1, true, false)]), 'contact');
  assert.equal(kind([new zhc.Numeric('temperature', 1)]), 'sensor');
  assert.equal(kind([new zhc.Enum('action', 1, ['on'])]), 'button');
  assert.equal(kind([], { deviceType: 'Coordinator' }), 'coordinator');
  // Ein Router ohne eigene Funktion ist praktisch ein Repeater.
  assert.equal(kind([], { deviceType: 'Router' }), 'router');
  assert.equal(kind([], { deviceType: 'EndDevice' }), 'unknown');
  // Für jede Gattung existiert ein Symbol — sonst bliebe der Knoten leer.
  for (const kindName of Object.keys(exposesLib.KINDS)) {
    assert.ok(mapView.ICONS[kindName], `Symbol für ${kindName}`);
    assert.ok(exposesLib.kindLabel(kindName), `Bezeichnung für ${kindName}`);
  }
});

test('Das Kartenlayout verteilt die Knoten überschneidungsfrei im Bild', () => {
  const nodes = [{ address: 'c', isCoordinator: true, name: 'Coordinator' }];
  const edges = [];
  for (let index = 0; index < 12; index += 1) {
    nodes.push({ address: `r${index}`, name: `Gerät ${index}` });
    edges.push({
      source: index < 3 ? 'c' : `r${index - 3}`,
      target: `r${index}`,
      quality: topology.qualityFor(40 + ((index * 37) % 200)),
    });
  }
  // Zwei Geräte ohne erkannte Funkstrecke.
  nodes.push({ address: 'iso1', name: 'Ohne Route' }, { address: 'iso2', name: 'Ohne Route 2' });

  const width = 1000;
  const height = 640;
  const margin = 46;
  mapLayout.layoutNetwork(nodes, edges, { width, height, iterations: 420 });

  for (const node of nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.address} hat Koordinaten`);
    assert.ok(node.x >= margin - 0.01 && node.x <= width - margin + 0.01, `${node.address} waagerecht im Bild`);
    assert.ok(node.y >= margin - 0.01 && node.y <= height - margin + 0.01, `${node.address} senkrecht im Bild`);
  }
  // Der Coordinator ist der feste Bezugspunkt in der Mitte.
  const coordinator = nodes.find((node) => node.isCoordinator);
  assert.equal(coordinator.x, width / 2);
  assert.equal(coordinator.y, height / 2);
  // Keine übereinanderliegenden Knoten — ein Knoten ist rund 48 px breit.
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      assert.ok(distance >= 48, `${nodes[i].address} und ${nodes[j].address} überlappen (${distance.toFixed(1)} px)`);
    }
  }
  // Knoten ohne Funkstrecke stehen abgesetzt am unteren Rand, statt Nähe
  // vorzutäuschen, die nicht gemessen wurde.
  for (const address of ['iso1', 'iso2']) {
    const node = nodes.find((entry) => entry.address === address);
    assert.equal(node.isolated, true);
    assert.ok(node.y > height * 0.75, `${address} steht im unteren Streifen`);
  }
});

test('Gute Funkstrecken werden kürzer gezeichnet als schwache', () => {
  // Die Qualität steckt nicht nur in Farbe und Strichstärke, sondern auch im
  // Abstand — sonst wäre die Anordnung beliebig.
  const nodes = [
    { address: 'c', isCoordinator: true },
    { address: 'gut' }, { address: 'schwach' },
  ];
  const edges = [
    { source: 'c', target: 'gut', quality: topology.qualityFor(250) },
    { source: 'c', target: 'schwach', quality: topology.qualityFor(20) },
  ];
  mapLayout.layoutNetwork(nodes, edges, { width: 1000, height: 640, iterations: 420 });
  const coordinator = nodes[0];
  const abstand = (node) => Math.hypot(node.x - coordinator.x, node.y - coordinator.y);
  assert.ok(abstand(nodes[1]) < abstand(nodes[2]),
    `gute Strecke ${abstand(nodes[1]).toFixed(0)} px, schwache ${abstand(nodes[2]).toFixed(0)} px`);
});

test('Das Kartenlayout bleibt bei entarteten Eingaben stabil', () => {
  const faelle = [
    ['leer', [], []],
    ['nur Coordinator', [{ address: 'c', isCoordinator: true }], []],
    ['Kante auf unbekannten Knoten', [{ address: 'a', isCoordinator: true }],
      [{ source: 'a', target: 'weg', quality: topology.qualityFor(100) }]],
    ['Selbstkante', [{ address: 'a', isCoordinator: true }, { address: 'b' }],
      [{ source: 'b', target: 'b', quality: topology.qualityFor(100) }]],
    ['Kante ohne Qualitätsangabe', [{ address: 'a', isCoordinator: true }, { address: 'b' }],
      [{ source: 'a', target: 'b' }]],
  ];
  for (const [name, nodes, edges] of faelle) {
    assert.doesNotThrow(() => mapLayout.layoutNetwork(nodes, edges, { iterations: 60 }), name);
    for (const node of nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${name}: ${node.address}`);
    }
  }
});

test('Die Karte liefert gültiges Markup und ein gültiges Skript', async () => {
  const map = {
    nodes: [
      { address: 'c', ieeeAddress: '0xc', networkAddress: 0, name: 'Coordinator', kind: 'coordinator',
        kindLabel: 'Coordinator', deviceType: 'Coordinator', deviceClass: 'router', isCoordinator: true,
        available: true, control: null, dimmer: null },
      { address: 'l', ieeeAddress: '0xl', networkAddress: 5, name: '<script>böse</script>', kind: 'light',
        kindLabel: 'Licht', deviceType: 'Router', deviceClass: 'router', available: true, linkquality: 80,
        control: { property: 'state', type: 'binary', value: 'ON', valueOn: 'ON', valueOff: 'OFF' },
        dimmer: { property: 'brightness', min: 1, max: 254, value: 200 } },
    ],
    edges: [{ source: 'c', target: 'l', lqi: 200, relationship: 'parent-child', quality: topology.qualityFor(200) }],
    scannedAt: new Date().toISOString(), unreachable: [], isolated: [], progress: { running: false }, connected: true,
  };
  const access = { canRead: true, canOperate: true, canWrite: true, isAdmin: true };
  const body = mapView.renderMap(map, access);
  const script = mapView.mapScript(map, access, '/adapter/instance/1/manage');

  // Für jede Gattung liegt ein Symbol im SVG.
  assert.equal((body.match(/<symbol id="zbIcon-/g) || []).length, Object.keys(mapView.ICONS).length);
  assert.match(body, /id="zbMap"/);
  assert.match(body, /zb-legend/);
  // Das Skript wird unverändert in die Seite gesetzt und muss gültig sein.
  assert.doesNotThrow(() => new (require('vm').Script)(script, { filename: 'map.js' }));
  assert.match(script, /function layoutNetwork/, 'die getestete Layoutfunktion wird eingebettet');
  // Gerätenamen sind Fremdeingaben und dürfen kein Markup einschleusen.
  assert.doesNotMatch(body, /<script>böse<\/script>/);
});

test('Die Netzwerkkarte ersetzt die Geräteseite, die Verwaltung bleibt die Startseite', async () => {
  const context = managementContext();
  context.runtime.networkMap = () => ({
    nodes: [{ address: 'c', ieeeAddress: '0xc', networkAddress: 0, name: 'Coordinator', kind: 'coordinator',
      kindLabel: 'Coordinator', deviceType: 'Coordinator', deviceClass: 'router', isCoordinator: true,
      available: true, control: null, dimmer: null }],
    edges: [], scannedAt: null, reason: '', unreachable: [], isolated: [],
    progress: { running: false }, connected: true,
  });

  // Die Verwaltung bleibt dort, wo sie war.
  const landing = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_ADMIN, basePath: '/adapter/instance/14/manage' }, context);
  assert.equal(landing.status, 200);
  assert.match(landing.view.title, /Zigbee-Netzwerk/);
  assert.match(landing.view.body, /<h2>Status<\/h2>/, 'die Verwaltungsinhalte stehen hier');
  assert.doesNotMatch(landing.view.body, /id="zbMapSvg"/, 'die Karte selbst liegt auf ihrer eigenen Seite');
  // Sie verweist prominent auf die Karte, die an die Stelle der Geräteseite tritt.
  assert.match(landing.view.body, /zb-map-teaser/);
  assert.match(landing.view.body, /\/adapter\/instance\/14\/manage\/map/);
  assert.doesNotMatch(landing.view.script, /function layoutNetwork/,
    'das Kartenskript belastet die Verwaltungsseite nicht');

  // Die Karte hat ihre eigene Seite mit Rückweg.
  const mapPage = await management.handleRequest(
    { method: 'GET', path: '/map', access: ACCESS_ADMIN, basePath: '/adapter/instance/14/manage' }, context);
  assert.equal(mapPage.status, 200);
  assert.match(mapPage.view.title, /Netzwerkkarte/);
  assert.match(mapPage.view.body, /id="zbMapSvg"/);
  assert.match(mapPage.view.body, /href="\/adapter\/instance\/14\/manage"/, 'Rückweg zur Verwaltung');
  assert.doesNotThrow(() => new (require('vm').Script)(mapPage.view.script, { filename: 'map.js' }));

  assert.equal((await management.handleRequest(
    { method: 'GET', path: '/map', access: { canRead: false }, basePath: '/x' }, context)).status, 403);
});

test('Geräte lassen sich in der Verwaltung umbenennen', async () => {
  const context = managementContext();
  let renamed = null;
  context.runtime.renameDevice = async (slug, name) => {
    renamed = { slug, name };
    return { slug, name: name || 'Standardname', customName: name };
  };
  context.runtime.devices = () => [{
    slug: 'abc', ieeeAddress: '0xabc', networkAddress: 1, friendlyName: 'ZBMINI abc',
    customName: '', manufacturer: 'SONOFF', model: 'ZBMINI', zigbeeModel: '01MINIZB',
    deviceType: 'Router', powerSource: 'Mains', battery: null, linkquality: 80,
    lastSeen: new Date().toISOString(), available: true, interviewState: 'abgeschlossen',
    supported: true, generated: false, propertyCount: 1, properties: [],
  }];

  // Das Eingabefeld steht bei jedem Gerät in der Verwaltung.
  const page = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_ADMIN, basePath: '/x' }, context);
  assert.match(page.view.body, /data-rename="abc"/);
  assert.match(page.view.body, /data-rename-save="abc"/);
  // Und der Hinweis, dass Topics eine Umbenennung überstehen.
  assert.match(page.view.body, /State-Adressen folgen der IEEE-Adresse/);

  const ok = await management.handleRequest(
    { method: 'POST', path: '/devices/rename', access: ACCESS_ADMIN, body: { device: 'abc', name: 'Leinwand Wohnzimmer' } },
    context);
  assert.equal(ok.status, 200);
  assert.deepEqual(renamed, { slug: 'abc', name: 'Leinwand Wohnzimmer' });

  // Umbenennen ist eine Konfigurationsänderung: Bedienrecht genügt nicht.
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/devices/rename', access: ACCESS_OPERATE, body: { device: 'abc', name: 'x' } },
    context)).status, 403);
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/devices/rename', access: ACCESS_ADMIN, body: { name: 'x' } }, context)).status, 400);
  // Ohne Bearbeitungsrecht erscheinen die Felder gar nicht erst.
  const readOnly = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_READ, basePath: '/x' }, context);
  assert.doesNotMatch(readOnly.view.body, /data-rename-save/);
});

test('Die Karte wird ohne Bedienrecht nur angezeigt', async () => {
  const map = {
    nodes: [{ address: 'c', ieeeAddress: '0xc', networkAddress: 0, name: 'C', kind: 'coordinator',
      kindLabel: 'Coordinator', deviceType: 'Coordinator', deviceClass: 'router', isCoordinator: true,
      available: true, control: null, dimmer: null }],
    edges: [], scannedAt: null, unreachable: [], isolated: [], progress: { running: false }, connected: true,
  };
  const nurLesen = mapView.renderMap(map, ACCESS_READ);
  assert.doesNotMatch(nurLesen, /id="zbMapScan"/, 'kein Scan ohne Schreibrecht');
  assert.match(nurLesen, /id="zbMapRelayout"/, 'Neu anordnen ist reine Anzeige');
  assert.match(mapView.mapScript(map, ACCESS_READ, '/x'), /canOperate = false/);
  assert.match(mapView.mapScript(map, ACCESS_ADMIN, '/x'), /canOperate = true/);
});

test('Topologiescan und Schalten von der Karte prüfen die Rechte', async () => {
  const context = managementContext();
  let geschaltet = null;
  context.runtime.networkMap = () => ({ nodes: [], edges: [], scannedAt: null, unreachable: [],
    isolated: [], progress: { running: false }, connected: true });
  context.runtime.scanTopology = async () => ({ nodes: [], edges: [], unreachable: [], scannedAt: 'jetzt' });
  context.runtime.topologyProgress = () => ({ running: false });
  context.runtime.writeProperty = async (device, property, value) => {
    geschaltet = { device, property, value };
    return { [property]: value };
  };

  // Der Scan erzeugt Funkverkehr im ganzen Netz und ist deshalb eine Aktion.
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/topology/scan', access: ACCESS_OPERATE }, context)).status, 403);
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/topology/scan', access: ACCESS_ADMIN }, context)).status, 200);

  // Schalten ist dieselbe Handlung wie ein Schaltwidget: Bedienrecht genügt.
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/devices/write', access: ACCESS_READ, body: { device: 'a', property: 'state', value: true } },
    context)).status, 403);
  const ok = await management.handleRequest(
    { method: 'POST', path: '/devices/write', access: ACCESS_OPERATE, body: { device: 'a', property: 'state', value: 'ON' } },
    context);
  assert.equal(ok.status, 200);
  assert.deepEqual(geschaltet, { device: 'a', property: 'state', value: 'ON' });

  // Unvollständige Angaben werden abgewiesen, statt irgendetwas zu schalten.
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/devices/write', access: ACCESS_OPERATE, body: { device: 'a' } }, context)).status, 400);

  // Lesen der Topologie genügt mit Leserecht.
  assert.equal((await management.handleRequest(
    { method: 'GET', path: '/topology', access: ACCESS_READ }, context)).status, 200);
});


// Ein minimales DOM, das genau die vom Kartenskript benutzten Aufrufe abbildet.
// Ohne diese Prüfung fiele ein Fehler im eingebetteten Skript erst im Browser
// auf — die Karte bliebe dort schlicht leer.
function fakeDom() {
  const registry = {};
  const create = (tag) => ({
    tagName: tag, attributes: {}, children: [], hidden: false, disabled: false,
    textContent: '', innerHTML: '',
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); } },
    style: {},
    setAttribute(key, value) { this.attributes[key] = String(value); },
    setAttributeNS(_ns, key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key]; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 640 }; },
  });
  for (const id of ['zbMapSvg', 'zbMapEdges', 'zbMapNodes', 'zbMapDetail', 'zbMapEmpty',
    'zbMapLabels', 'zbMapRelayout', 'zbMapScan', 'zbMapScanned']) {
    registry[id] = create('div');
  }
  return {
    registry,
    document: {
      createElementNS: (_ns, tag) => create(tag),
      createElement: create,
      getElementById: (id) => registry[id] || null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
  };
}

test('Das Kartenskript zeichnet Knoten und Kanten tatsächlich', () => {
  const nodes = [
    { address: 'c', ieeeAddress: '0xc', networkAddress: 0, name: 'Coordinator', kind: 'coordinator',
      kindLabel: 'Coordinator', deviceType: 'Coordinator', deviceClass: 'router', isCoordinator: true,
      available: true, control: null, dimmer: null },
    { address: 'r1', ieeeAddress: '0xr1', networkAddress: 1, name: 'Flur Relais', kind: 'relay',
      kindLabel: 'Schaltaktor', deviceType: 'Router', deviceClass: 'router', available: true, linkquality: 200,
      control: { property: 'state', type: 'binary', value: 'ON', valueOn: 'ON', valueOff: 'OFF' }, dimmer: null },
    { address: 'r2', ieeeAddress: '0xr2', networkAddress: 2, name: 'Lampe', kind: 'light', kindLabel: 'Licht',
      deviceType: 'Router', deviceClass: 'router', available: false, linkquality: 30,
      control: { property: 'state', type: 'binary', value: 'OFF', valueOn: 'ON', valueOff: 'OFF' },
      dimmer: { property: 'brightness', min: 1, max: 254, value: 180 } },
    { address: 's1', ieeeAddress: '0xs1', networkAddress: 3, name: 'Sensor', kind: 'sensor', kindLabel: 'Sensor',
      deviceType: 'EndDevice', deviceClass: 'battery', available: null, battery: 88, control: null, dimmer: null },
  ];
  const edges = [
    { source: 'c', target: 'r1', lqi: 230, relationship: 'parent-child', quality: topology.qualityFor(230) },
    { source: 'c', target: 'r2', lqi: 35, relationship: 'sibling', quality: topology.qualityFor(35) },
  ];
  const map = { nodes, edges, scannedAt: new Date().toISOString(), unreachable: [], isolated: [],
    progress: { running: false }, connected: true };

  const dom = fakeDom();
  const script = mapView.mapScript(map, ACCESS_ADMIN, '/x');
  require('vm').runInNewContext(script, {
    document: dom.document,
    window: { addEventListener() {}, confirm: () => true, alert: () => {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console, Math, Number, String, Object, Array, JSON, Date,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    alert: () => {}, location: { reload() {} },
  });

  const drawnEdges = dom.registry.zbMapEdges.children;
  const drawnNodes = dom.registry.zbMapNodes.children;
  assert.equal(drawnEdges.length, 2, 'jede Funkstrecke wird gezeichnet');
  assert.equal(drawnNodes.length, 4, 'jedes Gerät wird gezeichnet');

  // Strichstärke UND Farbe tragen die Qualität — die Farbe allein wäre für
  // farbfehlsichtige Betrachter nicht unterscheidbar.
  const gut = drawnEdges[0];
  const schwach = drawnEdges[1];
  assert.ok(Number(gut.attributes['stroke-width']) > Number(schwach.attributes['stroke-width']));
  assert.match(gut.attributes.class, /zb-edge--excellent/);
  assert.match(schwach.attributes.class, /zb-edge--poor/);
  // Die direkte Route ist als solche gekennzeichnet.
  assert.match(gut.attributes.class, /zb-edge--direct/);
  assert.doesNotMatch(schwach.attributes.class, /zb-edge--direct/);
  // Jede Kante trägt ihre Erklärung als Titel.
  assert.match(gut.children[0].textContent, /sehr gut \(LQI 230\)/);

  // Jeder Knoten zeigt seine Gattung als Symbol und ist bedienbar.
  for (const node of drawnNodes) {
    assert.ok(node.children.some((child) => child.tagName === 'use'), 'Symbol vorhanden');
    assert.equal(node.attributes.role, 'button');
    assert.equal(node.attributes.tabindex, '0');
  }
  const symbols = drawnNodes.map((node) => node.children.find((child) => child.tagName === 'use').attributes.href);
  assert.deepEqual(symbols, ['#zbIcon-coordinator', '#zbIcon-relay', '#zbIcon-light', '#zbIcon-sensor']);

  // Zustände sind ohne Anklicken ablesbar.
  assert.match(drawnNodes[1].attributes.class, /zb-node--online/);
  assert.match(drawnNodes[2].attributes.class, /zb-node--offline/);
  assert.match(drawnNodes[3].attributes.class, /zb-node--unknown/);
  assert.ok(drawnNodes[1].children.some((child) => child.attributes.class === 'zb-node-on'),
    'das eingeschaltete Relais bekommt einen Ring');
  assert.ok(drawnNodes[3].children.some((child) => child.attributes.class === 'zb-node-battery'),
    'das Batteriegerät ist markiert');
});

test('Unbekannte Verwaltungsaktionen werden abgewiesen', async () => {
  const response = await management.handleRequest(
    { method: 'POST', path: '/etwas-anderes', access: ACCESS_ADMIN }, managementContext());
  assert.equal(response.status, 404);
});

test('Die Verwaltungsansicht maskiert Gerätenamen', async () => {
  const context = managementContext({
    devices: () => [{
      slug: 'abc', ieeeAddress: '0xabc', friendlyName: '<script>alert(1)</script>',
      manufacturer: 'Aqara', model: 'WSDCGQ11LM', zigbeeModel: 'lumi.weather',
      deviceType: 'EndDevice', powerSource: 'Battery', battery: 88, linkquality: 120,
      lastSeen: new Date().toISOString(), available: true, interviewState: 'abgeschlossen',
      supported: true, generated: false, propertyCount: 4, properties: [],
    }],
  });
  const response = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_ADMIN, basePath: '/x' }, context);
  assert.doesNotMatch(response.view.body, /<script>alert\(1\)<\/script>/);
  assert.match(response.view.body, /&lt;script&gt;/);
});

// ── Lebenszyklus ────────────────────────────────────────────────────────────

function fakeHost(dataDirectory) {
  const secrets = new Map();
  const events = { states: [], values: [], status: [], storage: new Map(), logs: [] };
  return {
    events,
    secrets,
    name: 'zigbee-test',
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

// Ein Treiber, der den Coordinator nachbildet — ohne echtes Netz-I/O.
function fakeDriver(behaviour) {
  return () => ({
    id: 'zstack', label: 'Texas Instruments Z-Stack', herdsmanAdapter: 'zstack',
    defaultBaudRate: 115200, supported: true, probe: behaviour,
  });
}

const REACHABLE_PROBE = async () => existingNetwork();

test('Ein nicht erreichbarer Coordinator beendet den Adapter nicht', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const adapter = createAdapter(host, {
      herdsman: { Controller: class {}, setLogger: () => {} },
      converters: { setLogger: () => {} },
      // So verhält sich eine abgeschaltete Bridge: keine Antwort, dann Zeitlimit.
      getDriver: fakeDriver(async () => {
        throw Object.assign(new Error('Der Coordinator hat nicht geantwortet.'),
          { code: 'ZIGBEE_COORDINATOR_TIMEOUT' });
      }),
    });
    // start() muss zurückkehren, damit der Supervisor den Kindprozess nicht in
    // einer Neustartschleife hält.
    await adapter.start({
      coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '192.0.2.1', tcpPort: 6638,
      networkMode: 'adopt',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = adapter._internals().runtime();
    assert.equal(runtime.status().connected, false);
    assert.match(runtime.status().lastError, /nicht geantwortet/);
    // Der Katalog steht trotzdem, damit die Coordinator-States sichtbar sind.
    assert.ok(host.events.states.length > 0);
    // Und der Adapter meldet den Zustand, statt still zu bleiben.
    assert.ok(host.events.status.some((entry) => entry.connected === false));
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Eine unzulässige Konfiguration beendet den Adapter nicht', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const adapter = createAdapter(host, {
      herdsman: { Controller: class {}, setLogger: () => {} },
      converters: { setLogger: () => {} },
    });
    // Coordinator-Typ, den es nicht gibt.
    await adapter.start({ coordinatorType: 'unbekannt', transportType: 'tcp', tcpHost: 'x', tcpPort: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = adapter._internals().runtime();
    assert.equal(runtime.status().connected, false);
    assert.match(runtime.status().lastError, /Coordinator-Typ/);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Ein Coordinator ohne Netz startet nicht und erklärt warum', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    let controllerBuilt = false;
    const adapter = createAdapter(host, {
      herdsman: {
        Controller: class { constructor() { controllerBuilt = true; } },
        setLogger: () => {},
      },
      converters: { setLogger: () => {} },
      getDriver: fakeDriver(async () => ({ ...existingNetwork(), configured: false, network: null })),
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '10.0.0.1', tcpPort: 6638,
      networkMode: 'adopt' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = adapter._internals().runtime();
    assert.equal(runtime.status().connected, false);
    // Entscheidend: Es wurde gar nicht erst versucht, den Coordinator in
    // Betrieb zu nehmen — ein Neuaufbau des Netzes bleibt damit ausgeschlossen.
    assert.equal(controllerBuilt, false);
    assert.match(runtime.status().lastError, /kein konfiguriertes Zigbee-Netz/);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Bestehendes Netz: der Controller erhält genau die Parameter des Coordinators', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    let passedOptions = null;
    class FakeController {
      constructor(options) { passedOptions = options; }
      on() {}
      removeAllListeners() {}
      async start() { return 'resumed'; }
      async stop() {}
      async getNetworkParameters() {
        return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
      }
      * getDevicesIterator() {}
      getPermitJoin() { return false; }
    }
    const adapter = createAdapter(host, {
      herdsman: { Controller: FakeController, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: fakeDriver(REACHABLE_PROBE),
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '10.0.0.1', tcpPort: 6638,
      networkMode: 'adopt' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const runtime = adapter._internals().runtime();
    assert.equal(runtime.status().connected, true);
    assert.equal(runtime.status().networkState, 'übernommen');
    assert.equal(runtime.status().planAction, 'adopt');

    // Die Netzwerkoptionen entsprechen dem Coordinator — nur so übernimmt
    // zigbee-herdsman das Netz, statt es neu zu kommissionieren.
    assert.equal(passedOptions.network.panID, 0x1a62);
    assert.deepEqual(passedOptions.network.channelList, [11]);
    assert.deepEqual(passedOptions.network.networkKey, existingNetwork().network.networkKey);
    // Ein Weiterlaufen trotz abweichender Coordinator-Konfiguration ist
    // ausdrücklich nicht erlaubt.
    assert.equal(passedOptions.adapter.forceStartWithInconsistentAdapterConfiguration, false);
    // Persistenz liegt im instanzeigenen Datenverzeichnis.
    assert.ok(passedOptions.databasePath.startsWith(directory));
    assert.ok(passedOptions.backupPath.startsWith(directory));
    // Und der Transport ist der TCP-Pfad, den zigbee-herdsman erwartet.
    assert.equal(passedOptions.serialPort.path, 'tcp://10.0.0.1:6638');
    assert.equal(passedOptions.serialPort.adapter, 'zstack');

    // Der Schlüssel liegt im Secret-Store, nicht in den Einstellungen.
    assert.equal(host.secrets.get('network-key').length, 32);
    const persisted = fs.readFileSync(path.join(directory, 'network.json'), 'utf8');
    assert.equal(persisted.match(/[0-9a-f]{32}/i), null);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Ein Verbindungsabriss verwirft weder Geräte noch Netzwerkdaten', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const listeners = new Map();
    class FakeController {
      on(event, handler) { listeners.set(event, handler); }
      removeAllListeners() {}
      async start() { return 'resumed'; }
      async stop() {}
      async getNetworkParameters() {
        return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
      }
      * getDevicesIterator() {}
    }
    const adapter = createAdapter(host, {
      herdsman: { Controller: FakeController, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: fakeDriver(REACHABLE_PROBE),
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '10.0.0.1', tcpPort: 6638,
      networkMode: 'adopt' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const runtime = adapter._internals().runtime();
    const networkBefore = JSON.stringify(runtime.status().network);

    // Der Coordinator verschwindet.
    listeners.get('adapterDisconnected')();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(runtime.status().connected, false);
    // Die Netzwerkdaten bleiben; sie werden nicht neu erzeugt.
    assert.equal(JSON.stringify(runtime.status().network), networkBefore);
    assert.ok(fs.existsSync(path.join(directory, 'network.json')));
    // Und es wurde als Betriebszustand gemeldet, nicht als Absturz.
    assert.ok(host.events.logs.some(([level, message]) => level === 'warn' && /unterbrochen/.test(message)));
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Das Anlernfenster ist immer begrenzt', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const permitCalls = [];
    class FakeController {
      on() {}
      removeAllListeners() {}
      async start() { return 'resumed'; }
      async stop() {}
      async getNetworkParameters() {
        return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
      }
      * getDevicesIterator() {}
      async permitJoin(time) { permitCalls.push(time); }
    }
    const adapter = createAdapter(host, {
      herdsman: { Controller: FakeController, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: fakeDriver(REACHABLE_PROBE),
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '10.0.0.1', tcpPort: 6638,
      networkMode: 'adopt', permitJoinSeconds: 120 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const runtime = adapter._internals().runtime();

    await runtime.setPermitJoin(true);
    assert.equal(permitCalls[0], 120, 'die Einstellung wird verwendet');
    // Ein dauerhaft offenes Netz lässt sich nicht anfordern.
    await runtime.setPermitJoin(true, 99999);
    assert.equal(permitCalls[1], 600, 'auf das Maximum begrenzt');
    await runtime.setPermitJoin(true, 0);
    assert.equal(permitCalls[2], 120, 'kein unbegrenztes Fenster über 0');
    await runtime.setPermitJoin(false);
    assert.equal(permitCalls[3], 0, 'Beenden schließt das Fenster');
    assert.equal(runtime.status().permitJoin.active, false);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Das Anlernen lässt sich über den Coordinator-State schalten', async () => {
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const permitCalls = [];
    class FakeController {
      on() {}
      removeAllListeners() {}
      async start() { return 'resumed'; }
      async stop() {}
      async getNetworkParameters() {
        return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
      }
      * getDevicesIterator() {}
      async permitJoin(time) { permitCalls.push(time); }
    }
    const adapter = createAdapter(host, {
      herdsman: { Controller: FakeController, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: fakeDriver(REACHABLE_PROBE),
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '10.0.0.1', tcpPort: 6638,
      networkMode: 'adopt', permitJoinSeconds: 90 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const runtime = adapter._internals().runtime();

    await runtime.write('coordinator/permit_join', true);
    assert.equal(permitCalls[0], 90);
    await runtime.write('coordinator/permit_join', false);
    assert.equal(permitCalls[1], 0);
    // Andere Coordinator-States bleiben schreibgeschützt.
    await assert.rejects(() => runtime.write('coordinator/ieee_address', 'x'), /nicht beschreibbar/);
    await assert.rejects(() => runtime.write('unbekannt/state', true), /Unbekanntes Zigbee-Gerät/);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Unveränderte Diagnosewerte werden nicht wiederholt gemeldet', () => {
  const devices = require('../adapter/zigbee/lib/devices');
  const registry = devices.createRegistry({ getConfig: () => ({ availabilityBatteryHours: 25 }) });
  const zhDevice = {
    ieeeAddr: '0x00124b002c3a7f69', networkAddress: 1, type: 'EndDevice',
    powerSource: 'Battery', interviewState: 'SUCCESSFUL', lastSeen: Date.now(), endpoints: [],
  };
  const entry = registry.upsert(zhDevice, null);
  entry.linkquality = 80;

  const first = registry.diagnosticValues(entry);
  assert.ok(first.length >= 3, 'beim ersten Mal wird alles gemeldet');
  // Ohne Änderung entsteht kein neues Ereignis — sonst löst jede eingehende
  // Zigbee-Nachricht unnötigen Regelungs-Fan-out in homeESS aus.
  assert.equal(registry.diagnosticValues(entry).length, 0);

  entry.linkquality = 42;
  const changed = registry.diagnosticValues(entry);
  assert.equal(changed.length, 1);
  assert.match(changed[0].address, /linkquality$/);
  assert.equal(changed[0].value, 42);

  // Nach einem Neuaufbau des Katalogs wird wieder vollständig gemeldet.
  registry.resetDiagnostics();
  assert.ok(registry.diagnosticValues(entry).length >= 3);
});


// ── Freigabe der Coordinator-Schnittstelle ──────────────────────────────────
//
// Diese Tests sichern einen Fehler ab, der ein ganzes Zigbee-Netz lahmlegt:
// Eine Bridge reicht genau einen seriellen Anschluss weiter und lässt deshalb
// nur einen Client zu. Bleibt beim Adapter eine Verbindung offen, kann sich
// weder er selbst noch sein Nachfolger je wieder verbinden — die Meldung lautet
// dann dauerhaft „Error while opening socket".

// Bridge-Attrappe mit genau einem Client-Platz. `resume()` ist wesentlich:
// Ohne Lesen bliebe der Socket pausiert und meldete das Schließen der
// Gegenseite nie — die Messung wäre falsch.
function createBridgeStub() {
  const net = require('net');
  let total = 0;
  const open = new Set();
  const server = net.createServer((socket) => {
    total += 1;
    open.add(socket);
    socket.resume();
    const gone = () => open.delete(socket);
    socket.on('close', gone);
    socket.on('end', gone);
    socket.on('error', gone);
  });
  return {
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { for (const s of open) s.destroy(); server.close(() => resolve()); }),
    get openCount() { return open.size; },
    get total() { return total; },
  };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Ein abgebrochener Coordinator-Zugriff lässt keine Verbindung zurück', async () => {
  const bridge = createBridgeStub();
  const port = await bridge.listen();
  try {
    const transport = { path: `tcp://127.0.0.1:${port}`, baudRate: 115200, rtscts: false, label: 'Test' };
    // Der Coordinator antwortet nie — genau der Fall, in dem das Zeitlimit greift.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await assert.rejects(() => coordinator.probeZStack(transport, { timeoutMs: 400 }));
      await settle(300);
      assert.equal(bridge.openCount, 0,
        `nach Versuch ${attempt} darf keine Verbindung hängen bleiben`);
    }
    assert.equal(bridge.total, 3, 'jeder Versuch hat tatsächlich verbunden');
  } finally {
    await bridge.close();
  }
});

test('Ein Stopp mitten im Verbindungsaufbau gibt die Bridge sofort frei', async () => {
  const bridge = createBridgeStub();
  const port = await bridge.listen();
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const adapter = createAdapter(host);
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp',
      tcpHost: '127.0.0.1', tcpPort: port, networkMode: 'adopt', activePing: false });
    await settle(500);
    assert.equal(bridge.openCount, 1, 'der Adapter belegt die Bridge');

    const started = Date.now();
    await adapter.stop();
    const duration = Date.now() - started;
    await settle(300);

    assert.equal(bridge.openCount, 0, 'nach dem Stoppen ist die Bridge frei');
    // homeESS beendet den Kindprozess drei Sekunden nach dem Stoppsignal hart.
    // Wer länger braucht, gibt den Anschluss nicht mehr geordnet frei.
    assert.ok(duration < 2500, `stop() muss deutlich unter 3 s bleiben, brauchte ${duration} ms`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    await bridge.close();
  }
});

test('Nach einem Neustart der Instanz bekommt der Nachfolger die Bridge', async () => {
  // Der Ablauf beim Umbenennen eines Gerätes: Instanz stoppen, sofort neu
  // starten. Genau hier blieb der Anschluss zuvor belegt.
  const bridge = createBridgeStub();
  const port = await bridge.listen();
  const directory = tempDir();
  const config = { coordinatorType: 'zstack', transportType: 'tcp',
    tcpHost: '127.0.0.1', tcpPort: port, networkMode: 'adopt', activePing: false };
  let current = null;
  try {
    for (let round = 1; round <= 3; round += 1) {
      if (current) {
        await current.stop();
        await settle(200);
        assert.equal(bridge.openCount, 0, `Runde ${round}: der Vorgänger hat freigegeben`);
      }
      current = createAdapter(fakeHost(directory));
      await current.start(config);
      await settle(600);
      assert.equal(bridge.openCount, 1, `Runde ${round}: der Nachfolger belegt genau einen Platz`);
    }
    await current.stop();
    current = null;
    await settle(200);
    assert.equal(bridge.openCount, 0);
  } finally {
    if (current) await current.stop().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
    await bridge.close();
  }
});

test('Eine abgewiesene Bridge-Verbindung wird verständlich gemeldet', async () => {
  // „Error while opening socket" nennt weder Ursache noch Ziel. Der häufigste
  // Grund — die Bridge ist bereits belegt — muss in der Meldung stehen.
  const net = require('net');
  const blocker = net.createServer((socket) => {
    // Zweiter Client wird sofort zurückgewiesen, wie bei einer echten Bridge.
    socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy();
  });
  const port = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
  const directory = tempDir();
  try {
    const host = fakeHost(directory);
    const adapter = createAdapter(host);
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp',
      tcpHost: '127.0.0.1', tcpPort: port, networkMode: 'adopt', activePing: false });
    await settle(1200);
    const status = adapter._internals().runtime().status();
    assert.equal(status.connected, false);
    assert.match(status.lastError, /nur einen Client/,
      'die Meldung erklärt den belegten Anschluss');
    assert.match(status.lastError, new RegExp(String(port)), 'sie nennt das Ziel');
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    await new Promise((resolve) => blocker.close(() => resolve()));
  }
});

test('Ein Gerätename mit Leerzeichen bleibt durchgängig unschädlich', async () => {
  // Anlass: Nach dem Umbenennen in „Leinwand Wohnzimmer" schien der Name die
  // Ursache zu sein. Der State-Katalog muss solche Namen unverändert tragen.
  const devices = require('../adapter/zigbee/lib/devices');
  const registry = devices.createRegistry({ getConfig: () => ({}) });
  const zhDevice = { ieeeAddr: '0xa4c138ea2018a1c9', networkAddress: 1, type: 'Router',
    powerSource: 'Mains (single phase)', interviewState: 'SUCCESSFUL', lastSeen: Date.now(), endpoints: [] };
  registry.upsert(zhDevice, { model: 'SC500ZB', vendor: 'LoraTap', description: '', exposes: [],
    fromZigbee: [], toZigbee: [] });

  for (const name of ['Leinwand Wohnzimmer', 'Leinwand', 'Küche „Süd"', 'Bad / Decke', '<b>x</b>']) {
    registry.applyCustomNames([{ address: 'a4c138ea2018a1c9', customName: name }]);
    const states = registry.buildCatalog().filter((state) => state.address.startsWith('a4c138'));
    assert.ok(states.length > 0, `${name}: der Katalog entsteht`);
    // Die Adresse bleibt an der IEEE-Adresse hängen, nicht am Namen.
    assert.ok(states.every((state) => state.address.startsWith('a4c138ea2018a1c9/')), name);
    assert.ok(states.every((state) => state.category.includes(name)), `${name}: der Name steht in der Kategorie`);
    const rows = registry.deviceRows();
    assert.equal(rows[0].customName, name);
    assert.equal(rows[0].address, 'a4c138ea2018a1c9', 'die Adresse folgt nie dem Namen');
  }
});


test('Die Geräteliste übernimmt die Verfügbarkeit, statt alles offline zu zeigen', () => {
  // Anlass: Der Adapter war verbunden und die Karte zeigte Verbindungen, auf der
  // Geräteseite stand aber jedes Gerät auf offline. Ursache war, dass die Zeilen
  // einmal beim Start geschrieben wurden — zu einem Zeitpunkt, an dem die
  // Verfügbarkeit noch gar nicht ausgewertet war.
  const devicesLib = require('../adapter/zigbee/lib/devices');
  const registry = devicesLib.createRegistry({
    getConfig: () => ({ availabilityMainsMinutes: 15, availabilityBatteryHours: 25 }),
  });
  const now = Date.now();
  const build = (ieee, type, powerSource, lastSeen) => ({
    ieeeAddr: ieee, networkAddress: 1, type, powerSource,
    interviewState: 'SUCCESSFUL', lastSeen, endpoints: [],
  });
  const definition = { model: 'ZBMINI', vendor: 'SONOFF', exposes: [], fromZigbee: [], toZigbee: [] };
  registry.upsert(build('0xaa', 'Router', 'Mains (single phase)', now - 60000), definition);
  registry.upsert(build('0xbb', 'EndDevice', 'Battery', now - 3 * 3600e3), definition);
  registry.upsert(build('0xcc', 'Router', 'Mains (single phase)', now - 3 * 3600e3), definition);

  // Nach der Auswertung stimmt der Zustand je Gerätetyp.
  for (const entry of registry.all()) registry.diagnosticValues(entry, now);
  const rows = new Map(registry.deviceRows().map((row) => [row.address, row]));
  assert.equal(rows.get('aa').online, true, 'kürzlich gesehener Router');
  assert.equal(rows.get('bb').online, true, 'Batteriegerät nach drei Stunden weiterhin erreichbar');
  assert.equal(rows.get('cc').online, false, 'Router nach drei Stunden Stille');

  // Die Signatur erkennt Zustandswechsel, damit die Liste nur dann neu
  // geschrieben wird — und nicht bei jeder eingehenden Zigbee-Nachricht.
  const before = registry.rowsSignature();
  assert.equal(registry.rowsSignature(), before, 'ohne Änderung bleibt sie gleich');
  registry.get('aa').lastSeen = now - 3 * 3600e3;
  registry.diagnosticValues(registry.get('aa'), now);
  assert.notEqual(registry.rowsSignature(), before, 'ein Zustandswechsel ändert sie');
  assert.equal(registry.deviceRows().find((row) => row.address === 'aa').online, false);
});

test('Umbenennen ändert nur die Anzeige, nie die State-Adressen', () => {
  const devicesLib = require('../adapter/zigbee/lib/devices');
  const registry = devicesLib.createRegistry({ getConfig: () => ({}) });
  registry.upsert({ ieeeAddr: '0xa4c138ea2018a1c9', networkAddress: 1, type: 'Router',
    powerSource: 'Mains (single phase)', interviewState: 'SUCCESSFUL', lastSeen: Date.now(), endpoints: [] },
  { model: 'SC500ZB', vendor: 'LoraTap', exposes: [], fromZigbee: [], toZigbee: [] });

  const addresses = () => registry.buildCatalog()
    .filter((state) => state.address.startsWith('a4c138')).map((state) => state.address).sort();
  const before = addresses();
  assert.ok(before.length > 0);

  assert.equal(registry.setCustomName('a4c138ea2018a1c9', 'Leinwand Wohnzimmer'), 'Leinwand Wohnzimmer');
  assert.deepEqual(addresses(), before, 'die Adressen bleiben unverändert');
  assert.ok(registry.buildCatalog().some((state) => state.category.includes('Leinwand Wohnzimmer')));
  assert.equal(registry.deviceRows()[0].customName, 'Leinwand Wohnzimmer');
  assert.equal(registry.deviceRows()[0].address, 'a4c138ea2018a1c9');

  // Ein leerer Name stellt die Standardbezeichnung wieder her.
  assert.match(registry.setCustomName('a4c138ea2018a1c9', '   '), /SC500ZB/);
  assert.equal(registry.customName('a4c138ea2018a1c9'), '');
  // Überlange Eingaben werden gekürzt statt abgewiesen.
  assert.equal(registry.setCustomName('a4c138ea2018a1c9', 'x'.repeat(200)).length, 80);
  assert.throws(() => registry.setCustomName('gibtesnicht', 'x'), /Unbekanntes Zigbee-Gerät/);
});


// ── Selbsttätige Ermittlung der Funkstrecken ────────────────────────────────

// Ein Controller, der mitzählt, wie oft Nachbartabellen abgefragt werden.
function topologyControllerStub(listeners, counter) {
  return class StubController {
    on(event, handler) { listeners.set(event, handler); }
    removeAllListeners() {}
    async start() { return 'resumed'; }
    async stop() {}
    async getNetworkParameters() {
      return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
    }
    * getDevicesIterator() {}
    getDevicesByType() {
      return [{ ieeeAddr: '0xcoordinator', networkAddress: 0, type: 'Coordinator',
        async lqi() { counter.count += 1; return []; } }];
    }
    async permitJoin() {}
  };
}

function reachableDriver() {
  return () => ({ id: 'zstack', label: 'Z-Stack', herdsmanAdapter: 'zstack', defaultBaudRate: 115200,
    supported: true, probe: async () => existingNetwork() });
}

test('Die Funkstrecken werden selbsttätig ermittelt, sobald das Netz steht', async () => {
  const directory = tempDir();
  const listeners = new Map();
  const counter = { count: 0 };
  try {
    const adapter = createAdapter(fakeHost(directory), {
      herdsman: { Controller: topologyControllerStub(listeners, counter), setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: reachableDriver(),
      // Verkürzte Zeitwerte, damit sich das Verhalten ohne Minuten Wartezeit zeigt.
      topologyTimings: { firstDelayMs: 80, debounceMs: 80, minIntervalMs: 150 },
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: true });

    // Nicht sofort: Der Start soll nicht mit Funkverkehr zusammenfallen.
    assert.equal(counter.count, 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(counter.count >= 1, 'nach kurzer Verzögerung läuft die Ermittlung von selbst');

    const runtime = adapter._internals().runtime();
    const map = runtime.networkMap();
    assert.ok(map.scannedAt, 'die Karte trägt einen Zeitpunkt');
    assert.equal(map.reason, 'Netz steht', 'und den Anlass');
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Eine Netzänderung löst eine erneute Ermittlung aus', async () => {
  const directory = tempDir();
  const listeners = new Map();
  const counter = { count: 0 };
  try {
    const adapter = createAdapter(fakeHost(directory), {
      herdsman: { Controller: topologyControllerStub(listeners, counter), setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: reachableDriver(),
      topologyTimings: { firstDelayMs: 80, debounceMs: 80, minIntervalMs: 150 },
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const afterStart = counter.count;
    assert.ok(afterStart >= 1);

    // Ein Gerät verlässt das Netz — die gezeichneten Wege stimmen dann nicht mehr.
    listeners.get('deviceLeave')({ ieeeAddr: '0xverschwunden' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(counter.count > afterStart, 'die Änderung führt zu einer neuen Ermittlung');
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Abgeschaltet bleibt die Ermittlung aus, auch beim ersten Start', async () => {
  const directory = tempDir();
  const listeners = new Map();
  const counter = { count: 0 };
  try {
    const adapter = createAdapter(fakeHost(directory), {
      herdsman: { Controller: topologyControllerStub(listeners, counter), setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: reachableDriver(),
      topologyTimings: { firstDelayMs: 80, debounceMs: 80, minIntervalMs: 150 },
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: false });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(counter.count, 0, 'ohne Automatik wird nichts abgefragt');

    listeners.get('deviceLeave')({ ieeeAddr: '0xweg' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(counter.count, 0, 'auch eine Netzänderung löst dann nichts aus');

    // Auf ausdrückliche Anforderung läuft sie trotzdem.
    await adapter._internals().runtime().scanTopology({ reason: 'auf Anforderung' });
    assert.ok(counter.count >= 1);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Zwei gleichzeitige Anforderungen ergeben einen Durchlauf', async () => {
  const directory = tempDir();
  const listeners = new Map();
  const counter = { count: 0 };
  try {
    const adapter = createAdapter(fakeHost(directory), {
      herdsman: { Controller: topologyControllerStub(listeners, counter), setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: reachableDriver(),
      topologyTimings: { firstDelayMs: 100000, debounceMs: 100000, minIntervalMs: 100000 },
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = adapter._internals().runtime();
    const before = counter.count;
    // Der Scan erzeugt Funkverkehr im ganzen Netz; er darf sich nicht überlagern.
    await Promise.all([runtime.scanTopology({ reason: 'a' }), runtime.scanTopology({ reason: 'b' })]);
    assert.equal(counter.count - before, 1, 'nur ein Durchlauf');
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Die Karte zeigt an, dass die Ermittlung von selbst läuft', () => {
  const running = { nodes: [], edges: [], scannedAt: null, unreachable: [], isolated: [],
    progress: { running: true, current: 3, total: 11 }, connected: true };
  const bodyRunning = mapView.renderMap(running, ACCESS_ADMIN);
  assert.match(bodyRunning, /werden gerade ermittelt/);
  assert.match(bodyRunning, /3 von 11/);
  assert.match(bodyRunning, /id="zbMapScan"[^>]*disabled/, 'währenddessen kein zweiter Anstoß');
  // Solange etwas läuft, holt sich die Seite das Ergebnis selbst.
  assert.match(mapView.mapScript(running, ACCESS_ADMIN, '/x'), /\/topology\/progress/);

  const idle = { nodes: [], edges: [], scannedAt: null, unreachable: [], isolated: [],
    progress: { running: false }, connected: true };
  const bodyIdle = mapView.renderMap(idle, ACCESS_ADMIN);
  assert.match(bodyIdle, /selbsttätig/, 'der Hinweis nennt die Automatik, nicht den Knopf');
  assert.doesNotMatch(bodyIdle, /id="zbMapScan"[^>]*disabled/);
});


// ── Altlasten aus der Adressverwaltung des Coordinators ─────────────────────
//
// Der Coordinator führt in seiner Adressverwaltung mitunter Einträge, hinter
// denen kein Gerät mehr steht: abgebrochene Anlernversuche oder längst
// entfernte Geräte. Sie besitzen keinen eigenen Sicherheitsschlüssel, melden
// sich nie und beantworten kein Interview. Sie dürfen weder wie ein erkanntes
// Gerät aussehen noch nach dem Entfernen zurückkehren.

test('Ein Eintrag ohne Modell, Endpunkte und Meldung gilt als nicht identifiziert', () => {
  const devicesLib = require('../adapter/zigbee/lib/devices');
  const registry = devicesLib.createRegistry({ getConfig: () => ({}) });
  registry.upsert({ ieeeAddr: '0xb4e3f9fffe15be72', networkAddress: 1059, type: 'Unknown',
    interviewState: 'FAILED', lastSeen: undefined, endpoints: [] }, null);
  registry.upsert({ ieeeAddr: '0xe8e07efffeefd93a', networkAddress: 55383, type: 'Router',
    powerSource: 'Mains (single phase)', interviewState: 'SUCCESSFUL', lastSeen: Date.now(), endpoints: [] },
  { model: 'ZBMINI', vendor: 'SONOFF', exposes: [], fromZigbee: [], toZigbee: [] });

  const byName = new Map(registry.deviceDetails().map((device) => [device.slug, device]));
  assert.equal(byName.get('b4e3f9fffe15be72').unidentified, true);
  assert.equal(byName.get('e8e07efffeefd93a').unidentified, false, 'ein erkanntes Gerät nicht');
});

test('Nicht identifizierte Einträge werden als solche ausgewiesen', async () => {
  const context = managementContext();
  context.runtime.devices = () => [{
    slug: 'b4e3f9fffe15be72', ieeeAddress: '0xb4e3f9fffe15be72', networkAddress: 1059,
    friendlyName: 'Zigbee 15be72', customName: '', manufacturer: '', model: '', zigbeeModel: '',
    deviceType: 'Unknown', powerSource: '', battery: null, linkquality: null, lastSeen: '',
    available: null, interviewState: 'fehlgeschlagen', supported: false, generated: true,
    unidentified: true, propertyCount: 0, properties: [],
  }];
  const page = await management.handleRequest(
    { method: 'GET', path: '/', access: ACCESS_ADMIN, basePath: '/x' }, context);
  assert.match(page.view.body, /nicht identifiziert/);
  assert.match(page.view.body, /Adressverwaltung des Coordinators/);
  // Der Betreiber soll wissen, dass das Entfernen hält.
  assert.match(page.view.body, /nicht\s+erneut angelegt/);
  // Ein automatisch erzeugter Converter darf hier nicht behauptet werden.
  assert.doesNotMatch(page.view.body, /automatisch erzeugt/);
});

test('Ein entferntes Gerät kehrt bei der Übernahme nicht zurück', async () => {
  const directory = tempDir();
  try {
    const backupFile = path.join(directory, 'coordinator_backup.json');
    fs.writeFileSync(backupFile, JSON.stringify({
      metadata: { format: 'zigpy/open-coordinator-backup', version: 1 },
      coordinator_ieee: '00124b002c3a7f69', pan_id: '1a62', channel: 11,
      network_key: { key: '00'.repeat(16) },
      devices: [
        { nwk_address: '423', ieee_address: 'b4e3f9fffe15be72', is_child: true },
        { nwk_address: 'd857', ieee_address: 'e8e07efffeefd93a', is_child: false, link_key: { key: 'ab' } },
      ],
    }));

    const created = [];
    const host = fakeHost(directory);
    const listeners = new Map();
    class StubController {
      on(event, handler) { listeners.set(event, handler); }
      removeAllListeners() {}
      async start() { return 'resumed'; }
      async stop() {}
      async getNetworkParameters() {
        return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
      }
      * getDevicesIterator() {}
      getDevicesByType() { return []; }
      getDeviceByIeeeAddr(address) { return created.includes(address) ? {} : undefined; }
    }
    const adapter = createAdapter(host, {
      herdsman: { Controller: StubController, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: () => ({ id: 'zstack', label: 'Z-Stack', herdsmanAdapter: 'zstack', defaultBaudRate: 115200,
        supported: true, probe: async () => existingNetwork() }),
      topologyTimings: { firstDelayMs: 100000, debounceMs: 100000, minIntervalMs: 100000 },
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: false,
      // Der Eintrag wurde zuvor bewusst entfernt.
      ignoredDevices: ['b4e3f9fffe15be72'] });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const runtime = adapter._internals().runtime();
    // Er zählt nicht mehr als übernehmbar …
    assert.equal(runtime.status().adoptableDevices, 1, 'nur das verbliebene Gerät');
    assert.deepEqual(runtime.status().ignoredDevices, ['b4e3f9fffe15be72']);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Unbestätigte Funkstrecken werden nicht wie lebende gezeichnet', () => {
  // Der Coordinator führt den Eintrag in seiner Nachbartabelle, empfangen wurde
  // von dem Gerät aber nie etwas. Die Linie darf keine lebende Verbindung
  // vortäuschen.
  const nodes = [
    { address: 'c', ieeeAddress: '0xc', networkAddress: 0, name: 'Coordinator', kind: 'coordinator',
      kindLabel: 'Coordinator', deviceType: 'Coordinator', deviceClass: 'router', isCoordinator: true,
      available: true, control: null, dimmer: null },
    { address: 'x', ieeeAddress: '0xx', networkAddress: 1059, name: 'Zigbee 15be72', kind: 'unknown',
      kindLabel: 'Unbekannt', deviceType: 'Unknown', deviceClass: 'battery',
      available: null, control: null, dimmer: null },
    { address: 'y', ieeeAddress: '0xy', networkAddress: 2, name: 'ZBMINI', kind: 'relay',
      kindLabel: 'Schaltaktor', deviceType: 'Router', deviceClass: 'router',
      available: true, control: null, dimmer: null },
  ];
  const edges = [
    { source: 'c', target: 'x', lqi: 200, relationship: 'parent-child', quality: topology.qualityFor(200) },
    { source: 'c', target: 'y', lqi: 200, relationship: 'parent-child', quality: topology.qualityFor(200) },
  ];
  const map = { nodes, edges, scannedAt: new Date().toISOString(), unreachable: [], isolated: [],
    progress: { running: false }, connected: true };

  const dom = fakeDom();
  require('vm').runInNewContext(mapView.mapScript(map, ACCESS_ADMIN, '/x'), {
    document: dom.document,
    window: { addEventListener() {}, confirm: () => true, alert: () => {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console, Math, Number, String, Object, Array, JSON, Date,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    alert: () => {}, location: { reload() {} },
  });

  const drawn = dom.registry.zbMapEdges.children;
  assert.equal(drawn.length, 2);
  assert.match(drawn[0].attributes.class, /zb-edge--stale/, 'die unbestätigte Strecke ist gekennzeichnet');
  assert.doesNotMatch(drawn[1].attributes.class, /zb-edge--stale/, 'die bestätigte nicht');
  assert.match(drawn[0].children[0].textContent, /nie bestätigt/, 'und sagt es im Tooltip');
});


// ── Schaltzustände als Wahrheitswert ────────────────────────────────────────
//
// Anlass: Ein eingeschalteter Zigbee-Schaltaktor wurde unter „Messen und
// Schalten" als aus angezeigt. Die Zigbee-Welt führt Schaltzustände als Text
// „ON"/„OFF"; die Auswertungen von homeESS kennen an den maßgeblichen Stellen
// aber nur `true`, `1`, `"1"`, `"true"` und teils `"on"` in Kleinschreibung.
// Ein „ON" kam dort durchweg als *aus* an.

// Die Prüfungen des Kerns, wörtlich wie im Quelltext.
const CORE_BOOLEAN_CHECKS = {
  'messen-schalten/aggregation': (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on',
  'messen-schalten/schaltgruppen': (v) => v != null && (v === 1 || v === '1' || v === true || v === 'true'),
  'states/system-values': (v) => v != null && (v === true || v === 'true' || v === 1 || v === '1'),
  'adapters/state-editor': (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on',
};

function switchRegistry() {
  const devicesLib = require('../adapter/zigbee/lib/devices');
  const registry = devicesLib.createRegistry({ getConfig: () => ({}) });
  const features = [
    { property: 'state', key: 'state', type: 'binary', valueOn: 'ON', valueOff: 'OFF',
      writable: true, label: 'State', unit: '' },
    { property: 'contact', key: 'contact', type: 'binary', valueOn: true, valueOff: false,
      writable: false, label: 'Contact', unit: '' },
    { property: 'position', key: 'position', type: 'numeric', writable: true, label: 'Position', unit: '%' },
    { property: 'system_mode', key: 'system_mode', type: 'enum', values: ['off', 'heat'],
      writable: true, label: 'Modus', unit: '' },
  ];
  const entry = registry.upsert({ ieeeAddr: '0xaa', networkAddress: 1, type: 'Router',
    powerSource: 'Mains (single phase)', interviewState: 'SUCCESSFUL', lastSeen: Date.now(), endpoints: [] },
  { model: 'ZBMINI', vendor: 'SONOFF', exposes: [], fromZigbee: [], toZigbee: [] });
  entry.features = features;
  entry.featureByProperty = new Map(features.map((feature) => [feature.property, feature]));
  return { registry, entry };
}

test('Binäre Zustände werden als Wahrheitswert gemeldet, nicht als ON/OFF', () => {
  const { registry, entry } = switchRegistry();
  assert.equal(registry.publishableValue(entry, 'state', 'ON'), true);
  assert.equal(registry.publishableValue(entry, 'state', 'OFF'), false);
  assert.equal(registry.publishableValue(entry, 'state', true), true);
  // Auch Merkmale, die ohnehin boolesch sind, bleiben boolesch.
  assert.equal(registry.publishableValue(entry, 'contact', false), false);
  // Zahlen und mehrwertige Zustände bleiben, was sie sind — aus OPEN/CLOSE/STOP
  // oder mehreren Betriebsarten ließe sich kein Wahrheitswert bilden.
  assert.equal(registry.publishableValue(entry, 'position', 73), 73);
  assert.equal(registry.publishableValue(entry, 'system_mode', 'heat'), 'heat');
  // Eine unerwartete Ausprägung wird nicht geraten.
  assert.equal(registry.publishableValue(entry, 'state', 'komisch'), 'komisch');
});

test('Der gemeldete Schaltzustand wird von allen Auswertungen des Kerns erkannt', () => {
  const { registry, entry } = switchRegistry();
  const published = (raw) => registry.applyValues(entry, { state: raw })[0].value;

  for (const [name, check] of Object.entries(CORE_BOOLEAN_CHECKS)) {
    // Vorher: der Text „ON" kam als *aus* an — genau der gemeldete Fehler.
    assert.equal(check('ON'), false, `${name} erkennt den Text ON nicht (Ausgangslage)`);
    // Jetzt: eingeschaltet ist eingeschaltet.
    assert.equal(check(published('ON')), true, `${name} erkennt den eingeschalteten Aktor`);
    assert.equal(check(published('OFF')), false, `${name} erkennt den ausgeschalteten Aktor`);
  }
});

test('Der Gerätezustand behält für die Converter seine eigene Schreibweise', () => {
  // Die Converter bekommen den Zustand als `meta.state` zurück und erwarten
  // dort ihre eigene Form; nur die Meldung an homeESS wird umgesetzt.
  const { registry, entry } = switchRegistry();
  const values = registry.applyValues(entry, { state: 'ON', position: 73 });
  assert.equal(values.find((value) => value.address.endsWith('/state')).value, true);
  assert.equal(entry.state.state, 'ON');
  assert.equal(entry.state.position, 73);
});

test('Verfügbarkeit wird erst gemeldet, wenn sie feststeht', () => {
  // Ein Text „unbekannt" in einem sonst booleschen State würde von jeder
  // Auswertung als *wahr* gelesen — schlimmer als gar keine Angabe.
  const devicesLib = require('../adapter/zigbee/lib/devices');
  const registry = devicesLib.createRegistry({ getConfig: () => ({ availabilityMainsMinutes: 15 }) });
  const entry = registry.upsert({ ieeeAddr: '0xbb', networkAddress: 1, type: 'Router',
    powerSource: 'Mains (single phase)', interviewState: 'SUCCESSFUL', lastSeen: undefined, endpoints: [] }, null);

  const first = registry.diagnosticValues(entry);
  assert.equal(first.some((value) => value.address.endsWith('/available')), false,
    'ohne je empfangene Meldung wird nichts behauptet');

  entry.lastSeen = Date.now();
  const second = registry.diagnosticValues(entry);
  const available = second.find((value) => value.address.endsWith('/available'));
  assert.ok(available, 'sobald etwas empfangen wurde, steht der Wert');
  assert.equal(available.value, true);
  assert.equal(typeof available.value, 'boolean');
});


// ── Bedienelemente auf der Karte ────────────────────────────────────────────

// Ruft den Renderer der Bedienelemente aus dem eingebetteten Seitenskript auf.
function renderControls(node, access = ACCESS_ADMIN) {
  const script = mapView.mapScript(
    { nodes: [node], edges: [], progress: { running: false } }, access, '/x',
  ).replace('}());', '  globalThis.__controls = bedienelemente;\n}());');
  const dom = fakeDom();
  const context = {
    document: dom.document,
    window: { addEventListener() {}, confirm: () => true, alert: () => {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console, Math, Number, String, Object, Array, JSON, Date,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    alert: () => {}, location: { reload() {} },
  };
  context.globalThis = context;
  require('vm').runInNewContext(script, context);
  return context.__controls(node);
}

const mapNodeBase = { ieeeAddress: '0x1', networkAddress: 1, deviceType: 'Router',
  deviceClass: 'router', available: true, control: null, kind: 'relay', kindLabel: 'Schaltaktor',
  address: 'a', name: 'Testgerät' };

test('Ein Schaltaktor bekommt einen Ein/Aus-Schalter', () => {
  const html = renderControls({ ...mapNodeBase, controls: [
    { property: 'state', type: 'binary', label: 'Schalter', unit: '', category: '',
      value: true, valueOn: 'ON', valueOff: 'OFF' },
  ] });
  assert.match(html, /class="zb-toggle zb-toggle--on"/, 'eingeschaltet ist am Schalter ablesbar');
  assert.match(html, /data-set="state"/);
  // Ein Druck schaltet in die Gegenrichtung.
  assert.match(html, /data-value="false"/);
  assert.match(html, /aria-pressed="true"/);
});

test('Ein Rollladen bekommt Fahrbefehle und einen Positionsregler', () => {
  const html = renderControls({ ...mapNodeBase, kind: 'cover', controls: [
    { property: 'state', type: 'enum', label: 'Fahrbefehl', unit: '', category: '',
      value: 'STOP', values: ['OPEN', 'CLOSE', 'STOP'] },
    { property: 'position', type: 'numeric', label: 'Position', unit: '%', category: '',
      value: 40, min: 0, max: 100, step: 1 },
  ] });
  // Die drei Fahrbefehle als Tasten, in verständlicher Beschriftung.
  for (const [wert, text] of [['OPEN', 'Auf'], ['CLOSE', 'Zu'], ['STOP', 'Stopp']]) {
    assert.match(html, new RegExp(`data-value="${wert}"[^>]*>${text}<`), `Taste ${text}`);
  }
  // Und der Positionsregler mit dem Bereich aus dem Expose.
  assert.match(html, /<input type="range" min="0" max="100"[^>]*value="40" data-set="position"/);
  assert.match(html, /<output data-output="position"[^>]*>40 %<\/output>/);
});

test('Eine Lampe bekommt Schalter und Regler, Einstellungen bleiben eingeklappt', () => {
  const html = renderControls({ ...mapNodeBase, kind: 'light', controls: [
    { property: 'state', type: 'binary', label: 'Schalter', unit: '', category: '',
      value: false, valueOn: 'ON', valueOff: 'OFF' },
    { property: 'brightness', type: 'numeric', label: 'Helligkeit', unit: '', category: '',
      value: 180, min: 0, max: 254, step: 1 },
    { property: 'color_temp', type: 'numeric', label: 'Farbtemperatur', unit: 'mired', category: '',
      value: 300, min: 153, max: 500, step: 1 },
    { property: 'power_on_behavior', type: 'enum', label: 'Verhalten', unit: '', category: 'config',
      value: 'previous', values: ['off', 'on', 'toggle', 'previous'] },
  ] });
  assert.match(html, /class="zb-toggle"/, 'ausgeschaltet');
  assert.match(html, /data-set="brightness"/);
  assert.match(html, /data-set="color_temp"/);
  // Konfigurationsmerkmale gehören nicht zwischen die Bedienung.
  assert.match(html, /<details class="zb-controls-config"><summary>Geräteeinstellungen \(1\)/);
  assert.ok(html.indexOf('data-set="brightness"') < html.indexOf('zb-controls-config'),
    'die Bedienung steht vor den Einstellungen');
});

test('Ein Thermostat bekommt Sollwert und Betriebsart', () => {
  const html = renderControls({ ...mapNodeBase, kind: 'thermostat', controls: [
    { property: 'occupied_heating_setpoint', type: 'numeric', label: 'Sollwert', unit: '°C',
      category: '', value: 21, min: 5, max: 30, step: 0.5 },
    { property: 'system_mode', type: 'enum', label: 'Betriebsart', unit: '', category: '',
      value: 'heat', values: ['off', 'auto', 'heat'] },
  ] });
  assert.match(html, /min="5" max="30" step="0.5"[^>]*value="21" data-set="occupied_heating_setpoint"/);
  assert.match(html, /<output data-output="occupied_heating_setpoint"[^>]*>21 °C<\/output>/);
  assert.match(html, /data-value="heat"[^>]*class=|class="[^"]*zb-button--active[^"]*"[^>]*data-set="system_mode" data-value="heat"/,
    'die aktive Betriebsart ist hervorgehoben');
  assert.match(html, />Automatik</);
});

test('Viele Auswahlmöglichkeiten werden zur Auswahlliste, nicht zu Tastenreihen', () => {
  const html = renderControls({ ...mapNodeBase, controls: [
    { property: 'effect', type: 'enum', label: 'Effekt', unit: '', category: '', value: 'okay',
      values: ['blink', 'breathe', 'okay', 'channel_change', 'finish_effect', 'stop_effect'] },
  ] });
  assert.match(html, /<select data-set="effect">/);
  assert.match(html, /<option value="okay" selected>/);
});

test('Ein Gerät ohne beschreibbare Merkmale bekommt keine Bedienung', () => {
  assert.equal(renderControls({ ...mapNodeBase, kind: 'sensor', controls: [] }), '');
});

test('Ohne Bedienrecht erscheinen keine Bedienelemente', async () => {
  const node = { ...mapNodeBase, controls: [
    { property: 'state', type: 'binary', label: 'Schalter', unit: '', category: '',
      value: true, valueOn: 'ON', valueOff: 'OFF' },
  ] };
  const script = mapView.mapScript({ nodes: [node], edges: [], progress: { running: false } },
    ACCESS_READ, '/x');
  assert.match(script, /canOperate = false/);
  // Der Renderer wird in diesem Fall gar nicht erst aufgerufen; der Schreibweg
  // wird zusätzlich serverseitig geprüft.
  const context = managementContext();
  assert.equal((await management.handleRequest(
    { method: 'POST', path: '/devices/write', access: ACCESS_READ,
      body: { device: 'a', property: 'state', value: true } }, context)).status, 403);
});

test('Nicht erreichbare und beziehungslose Knoten werden benannt', () => {
  const map = {
    nodes: [{ address: 'a', name: 'Küche Relais' }, { address: 'b', name: 'Flur Relais' },
      { address: 'c', name: 'Sensor Bad' }],
    edges: [], scannedAt: new Date().toISOString(), unreachable: ['a'], isolated: ['c'],
    progress: { running: false }, connected: true,
  };
  const html = mapView.renderMap(map, ACCESS_ADMIN);
  // Eine bloße Anzahl ist für die Fehlersuche wertlos.
  assert.match(html, /Küche Relais/, 'der stumme Knoten wird benannt');
  assert.match(html, /Sensor Bad/, 'der beziehungslose ebenso');
  assert.doesNotMatch(html, /1 Knoten haben/, 'keine Zählung ohne Namen mehr');
});


// ── Bedienkachel über dem Knoten ────────────────────────────────────────────

// DOM-Nachbau mit Ereignisauslösung und einfacher Selektorsuche. Nur so lässt
// sich ohne Browser prüfen, dass die Kachel beim Überfahren erscheint und ihre
// Bedienelemente tatsächlich einen Befehl auslösen.
function interactiveDom() {
  const registry = {};
  const parse = (html) => {
    const out = [];
    const tagRe = /<(\w+)([^>]*?)\/?>/g;
    let match;
    while ((match = tagRe.exec(html))) {
      const element = create(match[1]);
      const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
      let attr;
      while ((attr = attrRe.exec(match[2]))) element.setAttribute(attr[1], attr[2]);
      out.push(element);
    }
    return out;
  };
  const descendants = (root) => {
    const out = [];
    (function walk(node) { for (const child of node.children || []) { out.push(child); walk(child); } })(root);
    return out;
  };
  const matches = (element, selector) => {
    let match;
    if ((match = /^\[([a-zA-Z-]+)="?([^\]"]*)"?\]$/.exec(selector))) {
      return element.getAttribute(match[1]) === match[2];
    }
    if ((match = /^\[([a-zA-Z-]+)\]$/.exec(selector))) return element.getAttribute(match[1]) !== null;
    if ((match = /^#(.+)$/.exec(selector))) return element.getAttribute('id') === match[1];
    return false;
  };
  function create(tag) {
    const element = {
      tagName: tag, attributes: {}, children: [], hidden: false, disabled: false,
      textContent: '', _html: '', dataset: {}, type: '', value: '',
      offsetWidth: 300, offsetHeight: 160, style: {}, listeners: {},
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
        contains(c) { return this.set.has(c); } },
      setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'type') this.type = String(value); },
      setAttributeNS(_ns, key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key] === undefined ? null : this.attributes[key]; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(name, handler) { (this.listeners[name] = this.listeners[name] || []).push(handler); },
      removeEventListener() {},
      dispatch(name, event) {
        for (const handler of this.listeners[name] || []) {
          handler(event || { preventDefault() {}, stopPropagation() {} });
        }
      },
      getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 640 }; },
      querySelector(selector) { return descendants(this).find((e) => matches(e, selector)) || null; },
      querySelectorAll(selector) { return descendants(this).filter((e) => matches(e, selector)); },
    };
    Object.defineProperty(element, 'innerHTML', {
      get() { return element._html; },
      set(value) { element._html = String(value); element.children = parse(String(value)); },
    });
    return element;
  }
  for (const id of ['zbMapSvg', 'zbMapEdges', 'zbMapNodes', 'zbMapDetail', 'zbMapEmpty',
    'zbMapLabels', 'zbMapRelayout', 'zbMapScan', 'zbMapScanned', 'zbHoverCard']) {
    registry[id] = create('div');
    registry[id].setAttribute('id', id);
  }
  // Die Kachel ist im Markup verborgen; der Nachbau muss das abbilden.
  registry.zbHoverCard.hidden = true;
  return {
    registry,
    document: {
      createElementNS: (_ns, tag) => create(tag), createElement: create,
      getElementById: (id) => registry[id] || null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
  };
}

function runMap(map, access, onFetch) {
  const dom = interactiveDom();
  require('vm').runInNewContext(mapView.mapScript(map, access, '/x'), {
    document: dom.document,
    window: { addEventListener() {}, confirm: () => true, alert: () => {} },
    fetch: (url, options) => {
      if (onFetch) onFetch(url, options);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: {} }) });
    },
    console, Math, Number, String, Object, Array, JSON, Date,
    setInterval: () => 0, clearInterval: () => {},
    // Verzögerungen sofort ausführen, damit das Schließen prüfbar bleibt.
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    alert: () => {}, location: { reload() {} },
  });
  return dom;
}

const coverMap = () => ({
  nodes: [
    { address: 'c', ieeeAddress: '0xc', networkAddress: 0, name: 'Coordinator', kind: 'coordinator',
      kindLabel: 'Coordinator', deviceType: 'Coordinator', deviceClass: 'router', isCoordinator: true,
      available: true, control: null, controls: [] },
    { address: 'r', ieeeAddress: '0xr', networkAddress: 1, name: 'Rollladen Wohnzimmer', kind: 'cover',
      kindLabel: 'Rollladen', deviceType: 'Router', deviceClass: 'router', available: true, linkquality: 78,
      control: null, controls: [
        { property: 'state', type: 'enum', label: 'Fahrbefehl', unit: '', category: '',
          value: 'STOP', values: ['OPEN', 'CLOSE', 'STOP'] },
        { property: 'position', type: 'numeric', label: 'Position', unit: '%', category: '',
          value: 40, min: 0, max: 100, step: 1 },
      ] },
  ],
  edges: [{ source: 'c', target: 'r', lqi: 200, relationship: 'parent-child', quality: topology.qualityFor(200) }],
  scannedAt: new Date().toISOString(), unreachable: [], isolated: [],
  progress: { running: false }, connected: true,
});

test('Die Bedienkachel erscheint über dem Knoten, sobald der Zeiger ihn berührt', () => {
  const dom = runMap(coverMap(), ACCESS_ADMIN);
  const card = dom.registry.zbHoverCard;
  assert.equal(card.hidden, true, 'zunächst ist nichts zu sehen');

  const nodes = dom.registry.zbMapNodes.children;
  assert.equal(nodes.length, 2);
  nodes[1].dispatch('mouseenter');

  assert.equal(card.hidden, false, 'die Kachel erscheint');
  assert.match(card.innerHTML, /Rollladen Wohnzimmer/, 'sie nennt das Gerät');
  assert.match(card.innerHTML, /erreichbar/, 'und seinen Zustand');
  assert.match(card.innerHTML, /LQI 78/);
  // Sie sitzt am Knoten, nicht irgendwo.
  assert.ok(/^\d+px$/.test(card.style.left) && /^\d+px$/.test(card.style.top),
    `Lage gesetzt (${card.style.left}/${card.style.top})`);

  // Und sie trägt die Bedienelemente des Gerätes.
  for (const label of ['Auf', 'Zu', 'Stopp']) {
    assert.ok(card.innerHTML.includes(`>${label}<`), `Fahrbefehl ${label}`);
  }
  assert.match(card.innerHTML, /data-set="position"/);
});

test('Aus der Bedienkachel lässt sich das Gerät unmittelbar schalten', () => {
  const geschrieben = [];
  const dom = runMap(coverMap(), ACCESS_ADMIN, (url, options) => {
    if (options && options.body) geschrieben.push({ url, ...JSON.parse(options.body) });
  });
  const card = dom.registry.zbHoverCard;
  dom.registry.zbMapNodes.children[1].dispatch('mouseenter');

  const auf = card.querySelectorAll('[data-set]').find((e) => e.getAttribute('data-value') === 'OPEN');
  assert.ok(auf, 'die Taste „Auf" ist da');
  auf.dispatch('click');

  assert.equal(geschrieben.length, 1);
  assert.match(geschrieben[0].url, /\/devices\/write$/);
  assert.equal(geschrieben[0].device, 'r');
  assert.equal(geschrieben[0].property, 'state');
  assert.equal(geschrieben[0].value, 'OPEN');
});

test('Die Kachel schließt beim Verlassen und bleibt nach einem Klick stehen', () => {
  const dom = runMap(coverMap(), ACCESS_ADMIN);
  const card = dom.registry.zbHoverCard;
  const node = dom.registry.zbMapNodes.children[1];

  node.dispatch('mouseenter');
  assert.equal(card.hidden, false);
  node.dispatch('mouseleave');
  assert.equal(card.hidden, true, 'ohne Zeiger verschwindet sie wieder');

  // Ein Klick stellt sie fest — sonst ließe sich kein Regler ziehen.
  node.dispatch('click');
  assert.equal(card.hidden, false);
  assert.match(card.innerHTML, /zbHoverClose/, 'festgestellt gibt es einen Schließknopf');
  node.dispatch('mouseleave');
  assert.equal(card.hidden, false, 'sie bleibt offen');
});

test('Ohne Bedienrecht zeigt die Kachel Angaben, aber keine Bedienelemente', () => {
  const dom = runMap(coverMap(), ACCESS_READ);
  const card = dom.registry.zbHoverCard;
  dom.registry.zbMapNodes.children[1].dispatch('mouseenter');
  assert.equal(card.hidden, false);
  assert.match(card.innerHTML, /Rollladen Wohnzimmer/);
  assert.doesNotMatch(card.innerHTML, /data-set=/, 'nichts Bedienbares');
  assert.match(card.innerHTML, /fehlt die Berechtigung/);
});

test('Ein Gerät ohne Bedienung sagt das in der Kachel', () => {
  const map = coverMap();
  map.nodes[1].controls = [];
  const dom = runMap(map, ACCESS_ADMIN);
  const card = dom.registry.zbHoverCard;
  dom.registry.zbMapNodes.children[1].dispatch('mouseenter');
  assert.match(card.innerHTML, /nichts zum Bedienen/);
});


// ── Zuständigkeit bei überlappenden Neustarts ───────────────────────────────
//
// homeESS startet eine Instanz bei jeder Änderung neu. Überlappen sich zwei
// Neustarts, kann ein Kindprozess entstehen, den der Supervisor nicht mehr
// kennt und deshalb nie beendet. Er hält den Coordinator besetzt, der aktuelle
// Prozess bekommt ihn nie — und zeigt ein leeres Netz.

test('Die Belegungsmarke bestimmt den zuständigen Prozess', () => {
  const lock = require('../adapter/zigbee/lib/instance-lock');
  const directory = tempDir();
  try {
    // Ohne Marke ist niemand im Weg.
    assert.equal(lock.isOwner(directory, null), true);

    const own = lock.claim(directory);
    assert.equal(own.pid, process.pid);
    assert.equal(lock.isOwner(directory, own), true);

    // Ein später gestarteter Prozess übernimmt.
    fs.writeFileSync(lock.lockPath(directory),
      JSON.stringify({ pid: process.pid + 1, startedAt: own.startedAt + 1000 }));
    assert.equal(lock.isOwner(directory, own), false);

    // Ein älterer Eintrag stammt aus einem beendeten Vorgänger und zählt nicht.
    fs.writeFileSync(lock.lockPath(directory),
      JSON.stringify({ pid: process.pid + 2, startedAt: own.startedAt - 5000 }));
    assert.equal(lock.isOwner(directory, own), true);

    // Eine unlesbare Marke darf keinen laufenden Adapter beenden.
    fs.writeFileSync(lock.lockPath(directory), 'kaputt');
    assert.equal(lock.isOwner(directory, own), true);
    fs.rmSync(lock.lockPath(directory));
    assert.equal(lock.isOwner(directory, own), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Der Start meldet die Zuständigkeit an', async () => {
  const lock = require('../adapter/zigbee/lib/instance-lock');
  const directory = tempDir();
  try {
    const adapter = createAdapter(fakeHost(directory), {
      herdsman: { Controller: class {}, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: () => ({ id: 'zstack', label: 'Z-Stack', herdsmanAdapter: 'zstack', defaultBaudRate: 115200,
        supported: true, probe: async () => { throw new Error('nicht erreichbar'); } }),
    });
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: false });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const eingetragen = lock.readLock(directory);
    assert.ok(eingetragen, 'die Marke ist gesetzt');
    assert.equal(eingetragen.pid, process.pid);
    await adapter.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Ein überzählig gewordener Prozess gibt den Coordinator frei und tritt ab', async () => {
  const lock = require('../adapter/zigbee/lib/instance-lock');
  const directory = tempDir();
  let released = false;
  let exited = null;
  const realExit = process.exit;
  try {
    class StubController {
      on() {}
      removeAllListeners() {}
      async start() { return 'resumed'; }
      async stop() { released = true; }
      async getNetworkParameters() {
        return { panID: 0x1a62, extendedPanID: '0x00124b002c3a7f69', channel: 11, nwkUpdateID: 0 };
      }
      * getDevicesIterator() {}
      getDevicesByType() { return []; }
    }
    const host = fakeHost(directory);
    const adapter = createAdapter(host, {
      herdsman: { Controller: StubController, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: () => ({ id: 'zstack', label: 'Z-Stack', herdsmanAdapter: 'zstack', defaultBaudRate: 115200,
        supported: true, probe: async () => existingNetwork() }),
      topologyTimings: { firstDelayMs: 100000, debounceMs: 100000, minIntervalMs: 100000 },
      lockCheckMs: 1000,
    });
    process.exit = (code) => { exited = code; };

    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(adapter._internals().runtime().status().connected, true, 'zunächst ist dieser Prozess zuständig');
    assert.equal(lock.readLock(directory).pid, process.pid);

    // Jetzt startet ein neuerer Prozess derselben Instanz und übernimmt.
    fs.writeFileSync(lock.lockPath(directory),
      JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() + 1000 }));

    // Der Überzählige bemerkt das und gibt ab, ohne dass ihn jemand stoppt —
    // der Supervisor führt ihn nicht mehr.
    const deadline = Date.now() + 6000;
    while (exited === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(exited, 0, 'er beendet sich von selbst');
    assert.equal(released, true, 'und gibt den Coordinator vorher frei');
    assert.ok(host.events.logs.some(([level, message]) => level === 'warn' && /zweites Mal/.test(message)),
      'im Protokoll steht, warum');
  } finally {
    process.exit = realExit;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Bei fremder Zuständigkeit wird der Coordinator gar nicht erst angefasst', async () => {
  const lock = require('../adapter/zigbee/lib/instance-lock');
  const directory = tempDir();
  let exited = null;
  const realExit = process.exit;
  try {
    const host = fakeHost(directory);
    const adapter = createAdapter(host, {
      herdsman: { Controller: class {}, setLogger: () => {} },
      converters: { setLogger: () => {} },
      getDriver: () => ({ id: 'zstack', label: 'Z-Stack', herdsmanAdapter: 'zstack', defaultBaudRate: 115200,
        supported: true, probe: async () => existingNetwork() }),
      lockCheckMs: 1000,
    });
    process.exit = (code) => { exited = code; };
    await adapter.start({ coordinatorType: 'zstack', transportType: 'tcp', tcpHost: '127.0.0.1', tcpPort: 1,
      networkMode: 'adopt', activePing: false, autoTopology: false });
    // Übernahme zwischen Anmeldung und nächstem Verbindungsversuch.
    fs.writeFileSync(lock.lockPath(directory),
      JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() + 1000 }));
    await adapter._internals().runtime().reconnectNow().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(exited, 0, 'der Prozess tritt ab, statt den Anschluss zu belegen');
    assert.ok(host.events.logs.some(([, message]) => /zuständig|zweites Mal/.test(message)));
  } finally {
    process.exit = realExit;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Der Adapter exportiert eine createAdapter-Factory nach Adapter-Spezifikation', () => {
  assert.equal(typeof createAdapter, 'function');
  assert.equal(typeof createAdapter.createAdapter, 'function');
  const host = fakeHost(tempDir());
  const instance = createAdapter(host, {
    herdsman: { Controller: class {}, setLogger: () => {} },
    converters: { setLogger: () => {} },
  });
  for (const method of ['start', 'stop', 'write', 'read', 'handleManagementRequest']) {
    assert.equal(typeof instance[method], 'function', method);
  }
});

// ── Sichtbarkeit der Kartenschichten ────────────────────────────────────────
//
// Über der Karte liegen zwei Schichten: der Hinweis auf ein leeres Netz und die
// Bedienkachel. Beide werden allein über das Attribut `hidden` geschaltet. Setzt
// eine Klassenregel darunter ein `display`, gewinnt sie gegen die Vorgabe des
// Browsers — der Hinweis stand dann dauerhaft über der fertigen Karte und fing
// als deckende Schicht sämtliche Mausereignisse ab, sodass sich keine
// Bedienkachel mehr öffnen ließ.
test('Verborgene Kartenschichten bleiben verborgen und fangen keine Zeigerereignisse ab', () => {
  const styles = fs.readFileSync(path.join(__dirname, '../adapter/zigbee/management.css'), 'utf8');

  assert.match(styles, /\.zigbee \[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'eine Regel hält jedes hidden-Element verborgen, auch gegen spätere display-Regeln');

  const empty = styles.match(/\.zb-map-empty\s*\{[^}]*\}/);
  assert.ok(empty, 'die Hinweisschicht ist beschrieben');
  assert.match(empty[0], /pointer-events:\s*none/,
    'sie ist Beschriftung und darf die Knoten darunter nicht abschirmen');

  // Die Kachel selbst muss bedienbar bleiben — sonst ließe sich kein Regler ziehen.
  const card = styles.match(/\.zb-hover-card\s*\{[^}]*\}/);
  assert.ok(card, 'die Bedienkachel ist beschrieben');
  assert.doesNotMatch(card[0], /pointer-events:\s*none/);
});

// Das Markup muss beide Schichten verborgen ausliefern; sichtbar werden sie
// erst durch das Skript.
test('Die Karte liefert Hinweis und Bedienkachel verborgen aus', () => {
  const map = {
    nodes: [{ address: 'a', name: 'Küche Relais', kind: 'relay', kindLabel: 'Relais', available: true }],
    edges: [], scannedAt: new Date().toISOString(), unreachable: [], isolated: [],
    progress: { running: false }, connected: true,
  };
  const html = mapView.renderMap(map, ACCESS_ADMIN);
  assert.match(html, /id="zbMapEmpty" hidden/);
  assert.match(html, /id="zbHoverCard" hidden/);
});
