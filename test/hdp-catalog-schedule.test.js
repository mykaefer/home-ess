'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CatalogSchedule, FILE_NAME, MAX_TIMER_MS, MIN_TIMER_MS } = require('../adapter/hdp/catalog-schedule');
const releaseStoreModule = require('../adapter/hdp/release-store');
const createHdpAdapter = require('../adapter/hdp/index');

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Feste Ortszeit als Millisekunden — die Tagesgrenze des Plans ist die lokale.
function at(year, month, day, hours, minutes) {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

test('Der erste Abruf legt die tägliche Uhrzeit fest und wird gespeichert', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-');
  let now = at(2026, 8, 31, 14, 37);
  const schedule = new CatalogSchedule({ now: () => now });
  schedule.attach(directory);

  assert.equal(schedule.due(), true, 'ohne Plan ist sofort fällig');
  schedule.record();
  assert.equal(schedule.describeSlot(), '14:37');
  assert.equal(schedule.due(), false);

  const stored = JSON.parse(fs.readFileSync(path.join(directory, FILE_NAME), 'utf8'));
  assert.equal(stored.slotMinute, (14 * 60) + 37);
  assert.equal(stored.lastCheckAt, new Date(now).toISOString());
});

test('Ein Neustart am selben Tag löst keinen zweiten Abruf aus', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-restart-');
  let now = at(2026, 8, 31, 14, 37);
  const first = new CatalogSchedule({ now: () => now });
  first.attach(directory);
  first.record();

  // Mehrere Neustarts über den Tag verteilt: keiner darf fällig sein.
  for (const instant of [at(2026, 8, 31, 14, 38), at(2026, 8, 31, 18, 0), at(2026, 8, 31, 23, 59)]) {
    now = instant;
    const restarted = new CatalogSchedule({ now: () => now });
    restarted.attach(directory);
    assert.equal(restarted.due(), false, `fällig um ${new Date(instant).toString()}`);
  }
});

test('Am nächsten Tag wird erst ab der festgelegten Uhrzeit geprüft', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-next-');
  let now = at(2026, 8, 31, 14, 37);
  const schedule = new CatalogSchedule({ now: () => now });
  schedule.attach(directory);
  schedule.record();

  now = at(2026, 9, 1, 14, 36);
  assert.equal(schedule.due(), false, 'kurz vor der Uhrzeit noch nicht');
  now = at(2026, 9, 1, 14, 37);
  assert.equal(schedule.due(), true);
  schedule.record();
  assert.equal(schedule.due(), false);
  // Die Uhrzeit bleibt die des ersten Abrufs, auch wenn später abgerufen wird.
  assert.equal(schedule.describeSlot(), '14:37');
});

test('Ein verpasster Termin wird beim nächsten Start nachgeholt', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-missed-');
  let now = at(2026, 8, 31, 14, 37);
  const schedule = new CatalogSchedule({ now: () => now });
  schedule.attach(directory);
  schedule.record();

  // Rechner war drei Tage aus und kommt nach der Uhrzeit wieder hoch.
  now = at(2026, 9, 3, 20, 5);
  assert.equal(schedule.due(), true);
  // Auch vor der Uhrzeit: Ein Rechner, der nur vormittags läuft, dürfte sonst
  // nie prüfen.
  now = at(2026, 9, 3, 6, 0);
  assert.equal(schedule.due(), true, 'ein ganzer ausgefallener Tag wird sofort nachgeholt');

  // Ein Abruf von gestern dagegen wartet auf die Uhrzeit.
  const yesterday = new CatalogSchedule({ now: () => now });
  yesterday.attach(directory);
  yesterday.record(at(2026, 9, 2, 14, 37));
  assert.equal(yesterday.due(), false);
  now = at(2026, 9, 3, 14, 37);
  assert.equal(yesterday.due(), true);
});

test('Der nächste Termin liegt auf der Uhrzeit des nächsten Tages', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-delay-');
  let now = at(2026, 8, 31, 14, 37);
  const schedule = new CatalogSchedule({ now: () => now });
  schedule.attach(directory);
  assert.equal(schedule.nextCheckAt(), null, 'ohne Abruf gibt es keinen Termin');
  schedule.record();

  assert.equal(schedule.nextCheckAt().getTime(), at(2026, 9, 1, 14, 37));
  const delay = schedule.nextDelayMs();
  assert.equal(delay, MAX_TIMER_MS, 'ein Timer läuft nie länger als sechs Stunden');

  now = at(2026, 9, 1, 14, 30);
  assert.equal(schedule.nextDelayMs(), 7 * 60 * 1000);
  now = at(2026, 9, 1, 14, 37);
  assert.equal(schedule.nextDelayMs() >= MIN_TIMER_MS, true, 'kein Timer unter einer Minute');
});

test('Ein Versionswechsel gilt als Update, ein Neustart nicht', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-version-');
  const now = at(2026, 8, 31, 14, 37);
  const schedule = new CatalogSchedule({ now: () => now });
  schedule.attach(directory);

  assert.equal(schedule.updated('1.4.7'), false, 'die Erstinstallation ist kein Update');
  schedule.noteVersion('1.4.7');
  schedule.record();

  const restarted = new CatalogSchedule({ now: () => now });
  restarted.attach(directory);
  assert.equal(restarted.updated('1.4.7'), false);
  assert.equal(restarted.updated('1.4.8'), true);
  restarted.noteVersion('1.4.8');
  assert.equal(restarted.updated('1.4.8'), false, 'nur der Wechsel selbst zählt, einmalig');
});

test('Ein unlesbarer Plan blockiert nicht, sondern gilt als leer', (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-broken-');
  fs.writeFileSync(path.join(directory, FILE_NAME), '{kaputt');
  const schedule = new CatalogSchedule({ now: () => at(2026, 8, 31, 9, 0) });
  schedule.attach(directory);
  assert.equal(schedule.due(), true);
  assert.equal(schedule.describeSlot(), null);
});

// Zusammenspiel im Adapter: Der Katalogabruf selbst wird ersetzt, geprüft wird
// nur, wann der Adapter ihn anstößt.
async function withCountedCatalog(t, run) {
  const original = releaseStoreModule.ReleaseStore.prototype.syncFromCatalog;
  const calls = [];
  releaseStoreModule.ReleaseStore.prototype.syncFromCatalog = async function stub() {
    calls.push(Date.now());
    this.lastCatalogCheck = { checkedAt: new Date().toISOString(), url: this.catalogUrl, results: [], error: null };
    return [];
  };
  t.after(() => { releaseStoreModule.ReleaseStore.prototype.syncFromCatalog = original; });
  await run(calls);
}

function fakeHost(directory, hostVersion) {
  return {
    async getInstanceIdentity() {
      return { instanceId: 'homeess-test', fingerprint: 'a'.repeat(64), hostVersion };
    },
    async getDataDirectory() { return directory; },
    async getSecret() { return null; },
    async setSecret() {}, async deleteSecret() {},
    async persistStorage() {}, setStorage() {}, subscribeState() { return () => {}; },
    setStates() {}, publishStates() {}, setConnected() {},
    log() {}, warn() {}, error() {}, debug() {},
  };
}

class FakeDiscovery extends EventEmitter {
  start() {} stop() {} refresh() {}
}
class FakeConnection extends EventEmitter {
  start() {} stop() {} sendState() { return false; } updateDevice() {}
}

async function startAdapter(directory, hostVersion) {
  const adapter = createHdpAdapter(fakeHost(directory, hostVersion), {
    Discovery: FakeDiscovery, RuntimeConnection: FakeConnection,
  });
  await adapter.start({
    firmwareCatalogUrl: 'https://www.homeess.de/wp-json/hdp-firmware/v1/firmware',
  });
  // Der Abruf läuft neben dem Start; einmal die Ereignisschleife durchlassen.
  await new Promise((resolve) => setImmediate(resolve));
  adapter.stop();
  return adapter;
}

test('Der Adapter fragt den Katalog beim Start nur einmal am Tag', async (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-adapter-');
  await withCountedCatalog(t, async (calls) => {
    await startAdapter(directory, '1.4.7');
    assert.equal(calls.length, 1, 'die Neuinstallation fragt sofort');

    await startAdapter(directory, '1.4.7');
    await startAdapter(directory, '1.4.7');
    assert.equal(calls.length, 1, 'weitere Neustarts am selben Tag fragen nicht erneut');

    // Update über die interne Updatefunktion: neue homeESS-Version.
    await startAdapter(directory, '1.4.8');
    assert.equal(calls.length, 2, 'nach einem Update wird sofort geprüft');

    await startAdapter(directory, '1.4.8');
    assert.equal(calls.length, 2, 'danach gilt wieder der Tagesplan');
  });
});

test('Der Adapter merkt sich auch die von Hand angestoßene Prüfung', async (t) => {
  const directory = tempDirectory(t, 'hdp-schedule-manual-');
  await withCountedCatalog(t, async (calls) => {
    const plan = new CatalogSchedule();
    // Plan von gestern: Der Start heute wäre fällig.
    plan.attach(directory);
    plan.noteVersion('1.4.7');
    plan.record(Date.now() - (26 * 60 * 60 * 1000));
    assert.equal(calls.length, 0);

    const adapter = createHdpAdapter(fakeHost(directory, '1.4.7'), {
      Discovery: FakeDiscovery, RuntimeConnection: FakeConnection,
    });
    await adapter.start({ firmwareCatalogUrl: 'https://www.homeess.de/wp-json/hdp-firmware/v1/firmware' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);

    const manual = await adapter.handleManagementRequest({
      method: 'POST', path: '/api/firmware/check', body: {},
      basePath: '/adapter/instance/1/manage', access: { canWrite: true },
    });
    assert.equal(manual.status, 200);
    assert.equal(calls.length, 2, 'die Prüfung von Hand läuft unabhängig vom Tagesplan');
    adapter.stop();

    // Sie belegt den Tag mit: Ein Neustart danach fragt nicht noch einmal.
    await startAdapter(directory, '1.4.7');
    assert.equal(calls.length, 2);
  });
});
