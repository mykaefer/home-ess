'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { normalizeVersion, compareVersions } = require('../src/update/version');
const { UpdateService, CHECK_INTERVAL_MS, CHECK_RETRY_MS } = require('../src/update/service');
const { renderLayout } = require('../src/views/layout');
const updateRoutes = require('../src/routes/update');
const updateSettings = require('../src/update/settings');
const renderSettings = require('../src/views/settings');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-update-'));
  const unit = path.join(root, 'home-ess-update.path');
  fs.writeFileSync(unit, 'test');
  return { root, unit };
}

test('Versionsvergleich akzeptiert Release-Tags und vergleicht numerisch', () => {
  assert.equal(normalizeVersion('v1.3.36'), '1.3.36');
  assert.equal(normalizeVersion('1.3'), null);
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('v1.3.36', '1.3.36'), 0);
});

test('Updateeinstellungen normalisieren Intervalle und Wartungsfenster', () => {
  assert.deepEqual(updateSettings.normalize({}), updateSettings.DEFAULTS);
  assert.equal(updateSettings.normalize({ automaticEnabled: 'on', checkInterval: 'hourly' }).automaticEnabled, true);
  assert.equal(updateSettings.normalize({ maintenanceStart: '25:00' }).maintenanceStart, '03:00');
  assert.equal(updateSettings.timeInWindow('03:30', '03:00', '04:00'), true);
  assert.equal(updateSettings.timeInWindow('23:30', '23:00', '02:00'), true);
  assert.equal(updateSettings.timeInWindow('01:30', '23:00', '02:00'), true);
  assert.equal(updateSettings.timeInWindow('12:00', '03:00', '03:00'), true);
});

test('Updateeinstellungen werden dauerhaft in SQLite gespeichert', async (t) => {
  const db = new sqlite3.Database(':memory:');
  t.after(() => db.close());
  await new Promise((resolve, reject) => db.run(
    `CREATE TABLE update_config (
      id INTEGER PRIMARY KEY, automatic_enabled INTEGER, maintenance_start TEXT,
      maintenance_end TEXT, check_interval TEXT
    )`,
    (error) => error ? reject(error) : resolve()
  ));
  const saved = await updateSettings.save(db, {
    automaticEnabled: 'on', maintenanceStart: '23:30', maintenanceEnd: '01:15', checkInterval: 'weekly',
  });
  assert.deepEqual(saved, {
    automaticEnabled: true, maintenanceStart: '23:30', maintenanceEnd: '01:15', checkInterval: 'weekly',
  });
  assert.deepEqual(await updateSettings.load(db), saved);
});

test('Release-Check wird persistiert und innerhalb eines Tages nicht wiederholt', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-08-02T10:00:00Z');
  let calls = 0;
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.3.35',
    infrastructureFile: unit,
    now: () => now,
    fetchLatest: async () => {
      calls += 1;
      return { version: '1.3.36', url: 'https://github.com/mykaefer/home-ess/releases/tag/v1.3.36' };
    },
  });

  await service.checkNow();
  await service.checkNow();
  assert.equal(calls, 1);
  assert.equal(service.getStatus().availableVersion, '1.3.36');

  now += CHECK_INTERVAL_MS + 1;
  await service.checkNow();
  assert.equal(calls, 2);
  assert.ok(fs.existsSync(path.join(root, 'update', 'release-check.json')));
});

test('Updateanforderung ist auf das nochmals geprüfte neueste Release begrenzt', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.3.35',
    infrastructureFile: unit,
    fetchLatest: async () => ({ version: '1.3.36', url: 'https://example.invalid/release' }),
  });

  await assert.rejects(service.requestUpdate('1.3.37'), /nicht mehr das neueste/);
  const result = await service.requestUpdate('1.3.36');
  assert.equal(result.operation.state, 'requested');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'update', 'request.json'), 'utf8')).version, '1.3.36');
});

test('Automatik installiert nur im Wartungsfenster und höchstens einmal je Tag', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let local = { dateKey: '2026-08-04', hours: 2, minutes: 59 };
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.3.41',
    infrastructureFile: unit,
    calendar: () => local,
    fetchLatest: async () => ({ version: '1.3.42', url: 'https://example.invalid/release' }),
  });
  service.configure({ automaticEnabled: true, maintenanceStart: '03:00', maintenanceEnd: '04:00', checkInterval: 'daily' });
  await service.checkNow({ force: true });
  const requested = [];
  service.requestUpdate = async (version) => { requested.push(version); return service.getStatus(); };

  assert.equal(await service.maybeInstallAutomatic(), false);
  local = { dateKey: '2026-08-04', hours: 3, minutes: 1 };
  assert.equal(await service.maybeInstallAutomatic(), true);
  assert.deepEqual(requested, ['1.3.42']);
  assert.equal(await service.maybeInstallAutomatic(), false);
  local = { dateKey: '2026-08-05', hours: 3, minutes: 1 };
  assert.equal(await service.maybeInstallAutomatic(), true);
  assert.deepEqual(requested, ['1.3.42', '1.3.42']);
});

test('Layout enthält Updateolive, Bestätigung und Fortschrittsansicht', () => {
  const html = renderLayout({ title: 'Test', body: '<p>Inhalt</p>' });
  assert.match(html, /id="header-update-pill"/);
  assert.match(html, /homeESS aktualisieren\?/);
  assert.match(html, /homeESS wird aktualisiert/);
  assert.match(html, /X-HomeESS-Update/);
});

test('Updateolive ist im mobilen Layout ausgeblendet', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const mobileStyles = css.slice(css.indexOf('@media (max-width: 768px)'));
  assert.match(mobileStyles, /\.header-update-pill\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('Allgemeine Einstellungen enthalten Updatekarte und Automatikstandard', () => {
  const html = renderSettings({
    updateStatus: { currentVersion: '1.3.41', availableVersion: '1.3.42', checkedAt: null, supported: true },
  });
  assert.match(html, /homeESS-Updates/);
  assert.match(html, /Stündlich/);
  assert.match(html, /Wöchentlich/);
  assert.match(html, /id="automaticUpdatesEnabled"/);
  assert.doesNotMatch(html, /id="automaticUpdatesEnabled"[^>]*\schecked/);
  assert.match(html, /data-version="1\.3\.42"/);
  assert.match(html, /Jetzt auf Updates prüfen/);
});

test('Das Prüfintervall steht außerhalb des Wartungsfensters und bleibt immer bedienbar', () => {
  const html = renderSettings({
    updateStatus: {
      currentVersion: '1.4.4', availableVersion: null, checkedAt: null,
      nextCheckAt: '2026-08-11T04:00:00.000Z', supported: true,
    },
  });
  const intervalAt = html.indexOf('id="updateCheckInterval"');
  const automaticAt = html.indexOf('id="automaticUpdatesEnabled"');
  const maintenanceAt = html.indexOf('id="updateMaintenanceFields"');
  assert.ok(intervalAt > 0 && automaticAt > 0 && maintenanceAt > 0);
  assert.ok(intervalAt < automaticAt, 'die Prüfung steht vor der Installationsautomatik');
  assert.ok(automaticAt < maintenanceAt, 'das Wartungsfenster gehört zur Automatik');
  // Der ausgraubare Wartungsblock enthält nur noch die beiden Zeitfelder.
  const maintenanceBlock = html.slice(maintenanceAt, html.indexOf('Das Wartungsfenster legt'));
  assert.doesNotMatch(maintenanceBlock, /updateCheckInterval/);
  assert.match(maintenanceBlock, /updateMaintenanceStart/);
  assert.match(maintenanceBlock, /updateMaintenanceEnd/);
  // Der nächste Prüfzeitpunkt ist sichtbar und wird live nachgeführt.
  assert.match(html, /id="settingsUpdateNext"/);
  assert.match(html, /status\.nextCheckAt/);
});

test('Die Updateprüfung läuft unabhängig von der Installationsautomatik', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-08-11T10:00:00Z');
  let calls = 0;
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.4.4',
    infrastructureFile: unit,
    now: () => now,
    fetchLatest: async () => {
      calls += 1;
      return { version: '1.4.5', url: 'https://example.invalid/release' };
    },
  });
  // Automatik aus, Prüfung stündlich: der Hinweis auf eine neue Version muss
  // trotzdem von selbst erscheinen.
  service.configure({ automaticEnabled: false, checkInterval: 'hourly' });
  assert.equal(service.checkIntervalMs(), 60 * 60 * 1000);

  await service.checkNow();
  assert.equal(calls, 1);
  assert.equal(service.getStatus().availableVersion, '1.4.5');

  now += 30 * 60 * 1000;
  await service.checkNow();
  assert.equal(calls, 1, 'innerhalb des Intervalls wird nicht erneut geprüft');
  now += 31 * 60 * 1000;
  await service.checkNow();
  assert.equal(calls, 2, 'nach Ablauf des eingestellten Intervalls schon');
});

test('Nach einer fehlgeschlagenen Prüfung wird der nächste Versuch vorgezogen', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-08-11T10:00:00Z');
  let fail = true;
  let calls = 0;
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.4.4',
    infrastructureFile: unit,
    now: () => now,
    fetchLatest: async () => {
      calls += 1;
      if (fail) throw new Error('GitHub nicht erreichbar.');
      return { version: '1.4.5', url: 'https://example.invalid/release' };
    },
  });
  service.configure({ automaticEnabled: false, checkInterval: 'monthly' });

  await service.checkNow();
  assert.equal(service.getStatus().checkError, 'GitHub nicht erreichbar.');
  assert.equal(service.currentCheckDelayMs(), CHECK_RETRY_MS,
    'ein Fehler darf das Monatsintervall nicht blockieren');

  now += CHECK_RETRY_MS + 1;
  fail = false;
  await service.checkNow();
  assert.equal(calls, 2);
  assert.equal(service.getStatus().checkError, null);
  assert.equal(service.currentCheckDelayMs(), require('../src/update/settings').INTERVALS.monthly);
});

test('Der Status nennt den geplanten Zeitpunkt der nächsten Prüfung', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-08-11T10:00:00Z');
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.4.4',
    infrastructureFile: unit,
    now: () => now,
    fetchLatest: async () => ({ version: '1.4.4', url: 'https://example.invalid/release' }),
  });
  t.after(() => service.shutdown());
  service.configure({ automaticEnabled: false, checkInterval: 'hourly' });
  assert.equal(service.getStatus().nextCheckAt, null);

  await service.checkNow();
  service.scheduleNextCheck();
  assert.equal(service.getStatus().nextCheckAt, new Date(now + 60 * 60 * 1000).toISOString());
});

test('Privilegierter Helper ist syntaktisch gültig und verwendet nur das feste Repository', () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'updater', 'self-update.js'), 'utf8');
  assert.doesNotThrow(() => new Function(helper.replace(/^#!.*\n/, ''))); // eslint-disable-line no-new-func
  assert.match(helper, /mykaefer\/home-ess\.git/);
  assert.doesNotMatch(helper, /body\.(?:url|repository|repo)/);
});

// ProtectHome=true blendet /root aus; ohne beschreibbares HOME und ohne
// ausdrücklichen Cache bricht `npm ci` mit ENOENT (Status 254) ab.
test('Abhängigkeitsinstallation läuft mit beschreibbarem HOME und eigenem npm-Cache', () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'updater', 'self-update.js'), 'utf8');
  assert.match(helper, /function npmEnvironment\(\)/);
  assert.match(helper, /HOME: UPDATE_DIR/);
  assert.match(helper, /npm_config_cache: cache/);
  assert.match(helper, /path\.join\(UPDATE_DIR, 'npm-cache'\)/);
  assert.match(helper, /\/usr\/bin\/npm',\s*\['ci', '--omit=dev', '--no-audit', '--no-fund'\],\s*\{ cwd: stageDir, env: npmEnvironment\(\) \}/);

  const unit = fs.readFileSync(path.join(__dirname, '..', 'updater', 'home-ess-update.service'), 'utf8');
  assert.match(unit, /^Environment=HOME=\/var\/lib\/home-ess\/update$/m);
  assert.match(unit, /^ProtectHome=true$/m);
  // Das HOME des Dienstes muss innerhalb der beschreibbaren Pfade liegen.
  const writable = (/^ReadWritePaths=(.+)$/m.exec(unit) || [])[1].split(/\s+/);
  assert.ok(writable.some((entry) => '/var/lib/home-ess/update'.startsWith(entry)));
});

test('Update-HTTP-Routen trennen Healthcheck, Adminrecht und Bestätigung', async () => {
  let requested = null;
  const fakeService = {
    currentVersion: '1.3.35',
    getStatus: () => ({ currentVersion: '1.3.35', availableVersion: '1.3.36' }),
    checkNow: async () => ({ currentVersion: '1.3.35', availableVersion: '1.3.36', checkedAt: '2026-08-04T00:00:00Z' }),
    requestUpdate: async (version) => {
      requested = version;
      return { operation: { state: 'requested', targetVersion: version } };
    },
  };
  const router = updateRoutes(fakeService);
  async function invoke(routePath, method, { admin = false, confirmed = false, checking = false } = {}) {
    const layer = router.stack.find((item) => item.route && item.route.path === routePath && item.route.methods[method]);
    const result = { status: 200, body: null, headers: {} };
    const req = {
      access: { isAdmin: admin },
      body: { version: '1.3.36' },
      get: (name) => name === 'X-HomeESS-Update' ? (confirmed ? 'confirm' : checking ? 'check' : undefined) : undefined,
    };
    const res = {
      set(name, value) { result.headers[name] = value; return this; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    };
    await layer.route.stack[0].handle(req, res);
    return result;
  }

  const health = await invoke('/update/health', 'get');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, version: '1.3.35' });

  assert.equal((await invoke('/update/check', 'post')).status, 403);
  assert.equal((await invoke('/update/check', 'post', { admin: true })).status, 400);
  assert.equal((await invoke('/update/check', 'post', { admin: true, checking: true })).status, 200);

  assert.equal((await invoke('/update/start', 'post', { confirmed: true })).status, 403);
  assert.equal((await invoke('/update/start', 'post', { admin: true })).status, 400);
  assert.equal((await invoke('/update/start', 'post', { admin: true, confirmed: true })).status, 202);
  assert.equal(requested, '1.3.36');
});
