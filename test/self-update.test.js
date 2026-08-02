'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeVersion, compareVersions } = require('../src/update/version');
const { UpdateService, CHECK_INTERVAL_MS } = require('../src/update/service');
const { renderLayout } = require('../src/views/layout');
const updateRoutes = require('../src/routes/update');

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

test('Layout enthält Updateolive, Bestätigung und Fortschrittsansicht', () => {
  const html = renderLayout({ title: 'Test', body: '<p>Inhalt</p>' });
  assert.match(html, /id="header-update-pill"/);
  assert.match(html, /homeESS aktualisieren\?/);
  assert.match(html, /homeESS wird aktualisiert/);
  assert.match(html, /X-HomeESS-Update/);
});

test('Privilegierter Helper ist syntaktisch gültig und verwendet nur das feste Repository', () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'updater', 'self-update.js'), 'utf8');
  assert.doesNotThrow(() => new Function(helper.replace(/^#!.*\n/, ''))); // eslint-disable-line no-new-func
  assert.match(helper, /mykaefer\/home-ess\.git/);
  assert.doesNotMatch(helper, /body\.(?:url|repository|repo)/);
});

test('Update-HTTP-Routen trennen Healthcheck, Adminrecht und Bestätigung', async () => {
  let requested = null;
  const fakeService = {
    currentVersion: '1.3.35',
    getStatus: () => ({ currentVersion: '1.3.35', availableVersion: '1.3.36' }),
    requestUpdate: async (version) => {
      requested = version;
      return { operation: { state: 'requested', targetVersion: version } };
    },
  };
  const router = updateRoutes(fakeService);
  async function invoke(routePath, method, { admin = false, confirmed = false } = {}) {
    const layer = router.stack.find((item) => item.route && item.route.path === routePath && item.route.methods[method]);
    const result = { status: 200, body: null, headers: {} };
    const req = {
      access: { isAdmin: admin },
      body: { version: '1.3.36' },
      get: (name) => (name === 'X-HomeESS-Update' && confirmed ? 'confirm' : undefined),
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

  assert.equal((await invoke('/update/start', 'post', { confirmed: true })).status, 403);
  assert.equal((await invoke('/update/start', 'post', { admin: true })).status, 400);
  assert.equal((await invoke('/update/start', 'post', { admin: true, confirmed: true })).status, 202);
  assert.equal(requested, '1.3.36');
});
