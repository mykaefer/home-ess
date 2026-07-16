'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/remote-access/identity-store');
const deviceStatus = require('../src/remote-access/device-status');

const FP_A = '1111abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90';
const FP_B = '2222abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90';

function freshDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ess-rec-'));
  const dir = path.join(base, 'identity');
  store._internal._resetForTests(dir);
  store.init(dir);
  deviceStatus._reset();
  return { base, dir };
}

async function provision(deviceId, name, fp, pairedAt) {
  const id = await store.loadOrCreateInstanceIdentity();
  return store.storeProvisionedIdentity({
    instanceId: 'ins_abcd1234',
    instanceName: 'homeESS',
    instanceFingerprint: id.fingerprintHex,
    device: { deviceId, name, platform: 'android', fingerprint: fp, claimFingerprint: fp },
    relayBaseUrl: 'https://relay.example', protocolVersion: '0.1', pairedAt: pairedAt || new Date().toISOString(),
  });
}

function snapshot(revision, complete, deviceIds, over = {}) {
  return {
    type: 'linked_devices',
    instanceId: 'ins_abcd1234',
    revision,
    complete,
    generatedAt: new Date().toISOString(),
    devices: deviceIds.map((deviceId) => ({ deviceId, deviceName: deviceId, platform: 'android', pairedAt: new Date().toISOString(), connected: false, connectedAt: null })),
    ...over,
  };
}

test('linked_devices entfernt lokal fehlende Geräte, behält enthaltene (Offline-Reconciliation)', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A, '2026-07-10T10:00:00.000Z');
  await provision('dev_b0000002', 'B', FP_B, '2026-07-11T10:00:00.000Z');

  // Simuliert den beim nächsten Login empfangenen Snapshot: dev_b wurde offline
  // in der App entfernt und fehlt.
  const rec = await store.reconcileLinkedDevices(snapshot(1, true, ['dev_a0000001']));
  assert.equal(rec.devices.length, 1);
  assert.equal(rec.devices[0].deviceId, 'dev_a0000001');
  // Bekannte lokale Felder (Fingerprint, pairedAt) bleiben erhalten.
  assert.equal(rec.devices[0].fingerprintHex, FP_A);
  assert.equal(rec.devices[0].pairedAt, '2026-07-10T10:00:00.000Z');
  assert.equal(rec.linkedDevicesRevision, 1);

  const prov = await store.getProvisionedIdentity();
  assert.equal(prov.devices.length, 1, 'Persistenz aktualisiert');
  fs.rmSync(base, { recursive: true, force: true });
});

test('zweites Gerät bleibt erhalten, wenn es im Snapshot enthalten ist', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A);
  await provision('dev_b0000002', 'B', FP_B);
  const rec = await store.reconcileLinkedDevices(snapshot(1, true, ['dev_a0000001', 'dev_b0000002']));
  assert.equal(rec.devices.length, 2);
  const ids = rec.devices.map((d) => d.deviceId).sort();
  assert.deepEqual(ids, ['dev_a0000001', 'dev_b0000002']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('ältere Revision wird ignoriert', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A);
  await provision('dev_b0000002', 'B', FP_B);
  await store.reconcileLinkedDevices(snapshot(5, true, ['dev_a0000001']));
  // Älterer, überholter Snapshot (revision 3) mit beiden Geräten: ignorieren.
  const rec = await store.reconcileLinkedDevices(snapshot(3, true, ['dev_a0000001', 'dev_b0000002']));
  assert.equal(rec.devices.length, 1, 'ältere Revision ändert nichts');
  assert.equal(rec.linkedDevicesRevision, 5);
  fs.rmSync(base, { recursive: true, force: true });
});

test('complete:false löscht nichts', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A);
  await provision('dev_b0000002', 'B', FP_B);
  const rec = await store.reconcileLinkedDevices(snapshot(9, false, ['dev_a0000001']));
  assert.equal(rec.devices.length, 2, 'unvollständiger Snapshot ändert nichts');
  // Revision wird nicht übernommen (kein anwendbarer Snapshot).
  assert.equal(rec.linkedDevicesRevision, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('fremde instanceId wird abgelehnt', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A);
  await provision('dev_b0000002', 'B', FP_B);
  const rec = await store.reconcileLinkedDevices(snapshot(1, true, ['dev_a0000001'], { instanceId: 'ins_other9999' }));
  assert.equal(rec.devices.length, 2, 'fremde Instanz ändert nichts');
  fs.rmSync(base, { recursive: true, force: true });
});

test('connection_status legt ein durch linked_devices entferntes Gerät nicht neu an', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A);
  await provision('dev_b0000002', 'B', FP_B);
  await store.reconcileLinkedDevices(snapshot(1, true, ['dev_a0000001'])); // dev_b entfernt

  // connection_status-Merker für das entfernte Gerät: darf es nicht wieder anlegen.
  await store.updateDeviceLastConnected([{ deviceId: 'dev_b0000002', connectedAt: new Date().toISOString() }]);
  const prov = await store.getProvisionedIdentity();
  assert.equal(prov.devices.length, 1);
  assert.equal(prov.devices[0].deviceId, 'dev_a0000001');
  fs.rmSync(base, { recursive: true, force: true });
});

test('vollständiger Snapshot ohne Gerät entfernt Persistenz und Runtime-Status, weiteres Gerät bleibt', async () => {
  const { base } = freshDir();
  await provision('dev_a0000001', 'A', FP_A);
  await provision('dev_b0000002', 'B', FP_B);
  deviceStatus.setAuthoritativeLinks(snapshot(1, true, ['dev_a0000001', 'dev_b0000002']));
  deviceStatus.applyConnectionStatus({
    instanceId: 'ins_abcd1234',
    generatedAt: new Date().toISOString(),
    devices: [
      { deviceId: 'dev_a0000001', connected: true, connectedAt: '2026-07-14T09:00:00.000Z' },
      { deviceId: 'dev_b0000002', connected: true, connectedAt: '2026-07-14T09:00:00.000Z' },
    ],
  });

  const rec = await store.reconcileLinkedDevices(snapshot(2, true, ['dev_b0000002']));
  deviceStatus.setAuthoritativeLinks({ ...snapshot(2, true, ['dev_b0000002']), devices: rec.devices });

  const prov = await store.getProvisionedIdentity();
  assert.deepEqual(prov.devices.map((d) => d.deviceId), ['dev_b0000002']);
  const runtime = deviceStatus.getRuntime();
  assert.deepEqual(Object.keys(runtime.devices), ['dev_b0000002']);
  assert.equal(runtime.devices.dev_b0000002.connected, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test('reconcile ohne Provisioning tut nichts (kein Schlüsselmaterial anlegen)', async () => {
  const { base, dir } = freshDir();
  const rec = await store.reconcileLinkedDevices(snapshot(1, true, ['dev_a0000001']));
  assert.equal(rec, null);
  assert.ok(!fs.existsSync(path.join(dir, store._internal.PRIV_FILE)), 'kein Key durch reconcile');
  fs.rmSync(base, { recursive: true, force: true });
});
