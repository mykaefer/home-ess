'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const createAdapter = require('../adapter/shelly');

test('Shelly normalisiert IDs, Statuspfade und Gen1/Gen2-Schreibziele', () => {
  const helper = createAdapter._test;
  assert.equal(helper.normalizeServer('example.shelly.cloud/'), 'https://example.shelly.cloud');
  assert.deepEqual(helper.parseDeviceIds('abc, def;ghi'), ['abc', 'def', 'ghi']);
  assert.deepEqual(helper.flatten({ 'switch:0': { output: true, apower: 12.5 } }), [
    { path: ['switch:0', 'output'], value: true },
    { path: ['switch:0', 'apower'], value: 12.5 },
  ]);
  assert.deepEqual(helper.writeTarget(['switch:0', 'output']), { kind: 'switch', channel: 0, property: 'output' });
  assert.deepEqual(helper.writeTarget(['relays', '1', 'ison']), { kind: 'switch', channel: 1, property: 'ison' });
  assert.deepEqual(helper.writeTarget(['rollers', '0', 'current_pos']), { kind: 'cover', channel: 0, property: 'current_pos' });
  assert.equal(helper.unitFor(['switch:0', 'apower']), 'W');
});

test('Shelly Cloud erkennt Gen1 und Gen2 dynamisch und persistiert die Geräteseite', async (t) => {
  const calls = [];
  const cloud = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/device/all_status')) {
        res.end(JSON.stringify({ isok: true, data: { devices_status: {
          one: { _dev_info: { id: 'gen1', name: 'Steckdose', code: 'SHPLG-S', gen: 'G1', online: 1 }, relays: [{ ison: false }], meters: [{ power: 4.2 }] },
          two: { _dev_info: { id: 'gen2', name: 'Pro 1 PM', code: 'switch', gen: 'G2', online: 1 }, 'switch:0': { output: true, apower: 8.1 } },
        } } }));
        return;
      }
      if (req.url.startsWith('/v2/devices/api/set/switch')) { res.end('{}'); return; }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((resolve) => cloud.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => cloud.close(resolve)));

  let catalog = [];
  const values = new Map();
  const storage = {};
  const adapter = createAdapter({ name: 'cloud', setStates(rows) { catalog = rows; },
    setStorage(key, value) { storage[key] = value; }, publishState(address, value) { values.set(address, value); },
    publishStates(rows) { rows.forEach((row) => values.set(row.address, row.value)); },
    setConnected() {}, log() {}, error() {} });
  await adapter.start({ serverUri: `http://127.0.0.1:${cloud.address().port}`, authKey: 'secret', pollInterval: 3600 });
  t.after(() => adapter.stop());

  assert.ok(catalog.some((state) => state.address === 'gen1/relays/0/ison' && state.writable));
  assert.ok(catalog.some((state) => state.address === 'gen2/switch%3A0/apower' && state.unit === 'W'));
  assert.equal(values.get('gen2/switch%3A0/output'), true);
  assert.equal(storage.devices.length, 2);
  assert.ok(storage.devices.find((device) => device.address === 'gen1').channels.length);

  await adapter.write('gen1/relays/0/ison', true);
  const write = calls.find((call) => call.url.startsWith('/v2/devices/api/set/switch'));
  assert.ok(write);
  assert.deepEqual(JSON.parse(write.body), { id: 'gen1', channel: 0, on: true });
});
