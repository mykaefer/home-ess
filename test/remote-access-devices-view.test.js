'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/remote-access/identity-store');
const deviceStatus = require('../src/remote-access/device-status');
const { buildDevicesView } = require('../src/remote-access/devices-view');

const DEVICE_FP = '1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90';
const DEVICE_FP_2 = 'abcd1234ef905678abcd1234ef905678abcd1234ef905678abcd1234ef905678';

function freshDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ess-dev-'));
  const dir = path.join(base, 'identity');
  store._internal._resetForTests(dir);
  store.init(dir);
  deviceStatus._reset();
  return { base, dir };
}

// Persistiert ein Gerät über den echten Identity-Store (mit gültigem
// Instanzfingerprint der frisch erzeugten Identität).
async function provision(instanceId, device, pairedAt) {
  const id = await store.loadOrCreateInstanceIdentity();
  return store.storeProvisionedIdentity({
    instanceId,
    instanceName: 'homeESS',
    instanceFingerprint: id.fingerprintHex,
    device,
    relayBaseUrl: 'https://relay.example',
    protocolVersion: '0.1',
    pairedAt: pairedAt || new Date().toISOString(),
  });
}

// Fake-Verbindungsdienst: meldet den Origin-WebSocket-Status.
function connService(state) {
  return { getStatus: () => ({ state }) };
}

function acceptLinks(revision, deviceIds) {
  deviceStatus.setAuthoritativeLinks({
    instanceId: 'ins_abcd1234',
    revision,
    complete: true,
    devices: deviceIds.map((deviceId) => ({ deviceId })),
  });
}

test('erstes Gerät wird gespeichert und erscheint in der Übersicht', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_first0001', name: 'Handy A', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('idle') });
  assert.equal(view.counts.paired, 1);
  assert.equal(view.devices[0].deviceName, 'Handy A');
  assert.equal(view.devices[0].platform, 'android');
  assert.ok(view.devices[0].deviceIdShort.startsWith('dev_first'));
  // Nie der vollständige Fingerprint.
  assert.ok(view.devices[0].fingerprintShort.length < DEVICE_FP.length);
  fs.rmSync(base, { recursive: true, force: true });
});

test('zweites Gerät ergänzt die Liste und überschreibt das erste nicht', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_first0001', name: 'Handy A', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP }, '2026-07-10T10:00:00.000Z');
  await provision('ins_abcd1234', { deviceId: 'dev_second002', name: 'Handy B', platform: 'android', fingerprint: DEVICE_FP_2, claimFingerprint: DEVICE_FP_2 }, '2026-07-12T10:00:00.000Z');

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('idle') });
  assert.equal(view.counts.paired, 2);
  const ids = view.devices.map((d) => d.deviceIdShort);
  assert.ok(ids.some((s) => s.startsWith('dev_first')), 'erstes Gerät bleibt erhalten');
  assert.ok(ids.some((s) => s.startsWith('dev_second')), 'zweites Gerät ergänzt');
  fs.rmSync(base, { recursive: true, force: true });
});

test('erneutes Provisioning desselben Geräts dupliziert nicht', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_first0001', name: 'Handy A', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP }, '2026-07-10T10:00:00.000Z');
  const rec = await provision('ins_abcd1234', { deviceId: 'dev_first0001', name: 'Handy A (neu)', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP }, '2026-07-14T10:00:00.000Z');

  assert.equal(rec.devices.length, 1, 'kein Duplikat');
  // Ursprünglicher Kopplungszeitpunkt bleibt erhalten.
  assert.equal(rec.devices[0].pairedAt, '2026-07-10T10:00:00.000Z');
  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('idle') });
  assert.equal(view.counts.paired, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('aktive und inaktive Geräte werden korrekt unterschieden', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_active001', name: 'Aktiv', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  await provision('ins_abcd1234', { deviceId: 'dev_idle00002', name: 'Offline', platform: 'android', fingerprint: DEVICE_FP_2, claimFingerprint: DEVICE_FP_2 });

  acceptLinks(1, ['dev_active001', 'dev_idle00002']);
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [
      { deviceId: 'dev_active001', connected: true, connectedAt: new Date().toISOString() },
      { deviceId: 'dev_idle00002', connected: false, connectedAt: null },
    ],
  });

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('authenticated') });
  assert.equal(view.relay.connected, true);
  assert.equal(view.counts.active, 1);
  const byId = {};
  view.devices.forEach((d) => { byId[d.deviceIdShort.slice(0, 12)] = d.connection; });
  assert.equal(byId.dev_active00, 'active');
  assert.equal(byId.dev_idle0000, 'offline');
  fs.rmSync(base, { recursive: true, force: true });
});

test('Relay-Disconnect löscht keine Kopplungen; Geräte gelten als Status unbekannt', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_active001', name: 'Aktiv', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  acceptLinks(1, ['dev_active001']);
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234', generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_active001', connected: true, connectedAt: new Date().toISOString() }],
  });
  // Disconnect: Laufzeitstatus verwerfen.
  deviceStatus.markRelayDisconnected();

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('reconnecting') });
  assert.equal(view.relay.connected, false);
  assert.equal(view.counts.paired, 1, 'Kopplung bleibt erhalten');
  assert.equal(view.counts.active, 0);
  assert.equal(view.devices[0].connection, 'unknown');
  // Persistenz unverändert.
  const prov = await store.getProvisionedIdentity();
  assert.equal(prov.devices.length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('fremde Device-ID im Status wird ignoriert (kein Phantom-Gerät, nicht aktiv)', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_known0001', name: 'Bekannt', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  acceptLinks(1, ['dev_known0001']);
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234', generatedAt: new Date().toISOString(),
    devices: [
      { deviceId: 'dev_known0001', connected: false, connectedAt: null },
      { deviceId: 'dev_stranger9', connected: true, connectedAt: new Date().toISOString() },
    ],
  });

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('authenticated') });
  assert.equal(view.counts.paired, 1, 'nur das persistierte Gerät');
  assert.equal(view.counts.active, 0, 'fremdes aktives Gerät zählt nicht');
  assert.ok(!view.devices.some((d) => d.deviceIdShort.startsWith('dev_stranger')), 'fremde deviceId taucht nicht auf');
  assert.equal(view.devices[0].connection, 'offline');
  fs.rmSync(base, { recursive: true, force: true });
});

test('authentifizierter Geräte-WebSocket ohne akzeptierten Link erzeugt keinen aktiven Eintrag', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_pending001', name: 'Alt', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_pending001', connected: true, connectedAt: new Date().toISOString() }],
  });

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('authenticated') });
  assert.equal(view.counts.paired, 1);
  assert.equal(view.counts.active, 0);
  assert.equal(view.devices[0].connection, 'unknown');
  fs.rmSync(base, { recursive: true, force: true });
});

test('connection_status für unbekanntes Gerät wird ignoriert', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_known0002', name: 'Bekannt', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  acceptLinks(1, ['dev_known0002']);
  const accepted = deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_unknown02', connected: true, connectedAt: new Date().toISOString() }],
  });

  assert.deepEqual(accepted, []);
  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('authenticated') });
  assert.equal(view.counts.paired, 1);
  assert.equal(view.counts.active, 0);
  assert.equal(view.devices[0].connection, 'unknown');
  fs.rmSync(base, { recursive: true, force: true });
});

test('entferntes Gerät wird durch späteren connection_status nicht wieder aktiv', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_keep00001', name: 'Bleibt', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  await provision('ins_abcd1234', { deviceId: 'dev_gone00002', name: 'Weg', platform: 'android', fingerprint: DEVICE_FP_2, claimFingerprint: DEVICE_FP_2 });
  acceptLinks(1, ['dev_keep00001', 'dev_gone00002']);
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [
      { deviceId: 'dev_keep00001', connected: true, connectedAt: new Date().toISOString() },
      { deviceId: 'dev_gone00002', connected: true, connectedAt: new Date().toISOString() },
    ],
  });
  await store.reconcileLinkedDevices({
    type: 'linked_devices',
    instanceId: 'ins_abcd1234',
    revision: 2,
    complete: true,
    generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_keep00001', deviceName: 'Bleibt', platform: 'android', pairedAt: new Date().toISOString(), connected: false, connectedAt: null }],
  });
  acceptLinks(2, ['dev_keep00001']);
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_gone00002', connected: true, connectedAt: new Date().toISOString() }],
  });

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('authenticated') });
  assert.equal(view.counts.paired, 1);
  assert.equal(view.devices[0].deviceId, 'dev_keep00001');
  assert.equal(view.counts.active, 0);
  assert.ok(!view.devices.some((d) => d.deviceId === 'dev_gone00002'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('nach Origin-Reconnect wird alter Online-Status nicht weiter angezeigt', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_reconn001', name: 'Reconnect', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  acceptLinks(1, ['dev_reconn001']);
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [{ deviceId: 'dev_reconn001', connected: true, connectedAt: new Date().toISOString() }],
  });
  deviceStatus.markRelayDisconnected();

  const view = await buildDevicesView({ identityStore: store, deviceStatus, connectionService: connService('authenticated') });
  assert.equal(view.counts.active, 0);
  assert.equal(view.devices[0].connection, 'unknown');
  fs.rmSync(base, { recursive: true, force: true });
});

test('lastKnownConnectedAt wird persistent fortgeschrieben und bleibt getrennt vom Laufzeitstatus', async () => {
  const { base } = freshDir();
  await provision('ins_abcd1234', { deviceId: 'dev_track0001', name: 'Track', platform: 'android', fingerprint: DEVICE_FP, claimFingerprint: DEVICE_FP });
  await store.updateDeviceLastConnected([{ deviceId: 'dev_track0001', connectedAt: '2026-07-14T09:00:00.000Z' }]);
  // Älterer Zeitstempel überschreibt nicht (monoton).
  await store.updateDeviceLastConnected([{ deviceId: 'dev_track0001', connectedAt: '2026-07-13T09:00:00.000Z' }]);
  // Fremde deviceId wird ignoriert.
  await store.updateDeviceLastConnected([{ deviceId: 'dev_stranger9', connectedAt: '2026-07-15T09:00:00.000Z' }]);

  const prov = await store.getProvisionedIdentity();
  assert.equal(prov.devices[0].lastKnownConnectedAt, '2026-07-14T09:00:00.000Z');
  assert.equal(prov.devices.length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});
