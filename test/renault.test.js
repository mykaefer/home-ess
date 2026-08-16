'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createAdapter = require('../adapter/renault');
const { RenaultClient, attributes, accountRows, vehicleRows, vehicleVin } = require('../adapter/renault/client');

test('Renault-Helfer lesen Cloud-Antworten und Fahrzeugwerte robust', () => {
  assert.deepEqual(attributes({ data: { attributes: { batteryLevel: 72 } } }), { batteryLevel: 72 });
  assert.equal(accountRows({ accounts: [{ accountId: 'a1' }] })[0].accountId, 'a1');
  assert.equal(vehicleRows({ vehicleLinks: [{ vin: 'abc' }] }).length, 1);
  assert.equal(vehicleVin({ vehicleDetails: { vin: 'vf1spring12345678' } }), 'VF1SPRING12345678');

  const battery = createAdapter._test.mapBattery({ data: { attributes: {
    batteryLevel: 81, batteryAutonomy: 174, chargingStatus: 'charge_in_progress',
    plugStatus: 1, chargingRemainingTime: 42,
  } } });
  assert.equal(battery['battery/level'], 81);
  assert.equal(battery['battery/range'], 174);
  assert.equal(battery['charging/enabled'], true);
  assert.equal(createAdapter._test.isActive('not_charging'), false);
  assert.equal(createAdapter._test.isCharging(0.2), false);
  assert.equal(createAdapter._test.isCharging(1), true);
});

test('RenaultClient führt Gigya-Anmeldung und Kamereon-Anfragen ohne Passwortweitergabe aus', async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/accounts.login')) return { sessionInfo: { cookieValue: 'login-secret' } };
    if (url.endsWith('/accounts.getJWT')) return { id_token: 'jwt-secret' };
    if (url.endsWith('/accounts.getAccountInfo')) return { data: { personId: 'person-1' } };
    return { accounts: [] };
  };
  const client = new RenaultClient({ request });
  assert.equal(await client.login('spring@example.test', 'password-secret'), 'login-secret');
  await client.getPerson();

  const login = calls.find((call) => call.url.endsWith('/accounts.login'));
  assert.equal(login.options.form.password, 'password-secret');
  const person = calls.find((call) => call.url.includes('/commerce/v1/persons/person-1'));
  assert.ok(person.options.headers.apikey);
  assert.equal(person.options.headers['x-gigya-id_token'], 'jwt-secret');
  assert.ok(!person.url.includes('login-secret'));
  assert.ok(!person.url.includes('password-secret'));
});

test('Renault-Adapter erkennt den Dacia Spring, publiziert States und schaltet Klima', async (t) => {
  const actions = [];
  class FakeClient {
    async login() { return 'new-login-token'; }
    async getPerson() { return { accounts: [{ accountId: 'account-1' }] }; }
    async getVehicles() { return { vehicleLinks: [{ vehicleDetails: {
      vin: 'UU1DBG00123456789', nickname: 'Spring', modelCode: 'XBG1VE',
    } }] }; }
    async getVehicleData(_account, _vin, _version, endpoint) {
      if (endpoint === 'battery-status') return { data: { attributes: {
        batteryLevel: 63, batteryAutonomy: 128, chargingStatus: 'not_charging',
      } } };
      if (endpoint === 'cockpit') return { data: { attributes: { totalMileage: 12034 } } };
      return { data: { attributes: { hvacStatus: 'off', externalTemperature: 18 } } };
    }
    async setVehicleAction(account, vin, endpoint, type, values) {
      actions.push({ account, vin, endpoint, type, values });
    }
  }

  let catalog = [];
  const values = new Map();
  const secrets = new Map();
  const storage = {};
  const host = {
    setStates(rows) { catalog = rows; },
    publishStates(rows) { rows.forEach((row) => values.set(row.address, row.value)); },
    publishState(address, value) { values.set(address, value); },
    setStorage(key, value) { storage[key] = value; },
    persistStorage(key, value) { storage[key] = value; return Promise.resolve(true); },
    getSecret(key) { return Promise.resolve(secrets.get(key) || null); },
    setSecret(key, value) { secrets.set(key, value); return Promise.resolve(true); },
    deleteSecret(key) { secrets.delete(key); return Promise.resolve(true); },
    setConnected() {}, log() {}, warn() {}, error() {},
  };
  const adapter = createAdapter(host, { RenaultClient: FakeClient });
  await adapter.start({ username: 'owner@example.test', password: 'secret', locale: 'de_DE',
    pollInterval: 3600, enableControls: true, targetTemperature: 22 });
  t.after(() => adapter.stop());

  assert.equal(secrets.get('login-token'), 'new-login-token');
  assert.equal(storage.password, '');
  assert.equal(storage.vehicles[0].model, 'XBG1VE');
  assert.equal(values.get('battery/level'), 63);
  assert.equal(values.get('cockpit/mileage'), 12034);
  assert.ok(catalog.find((state) => state.address === 'hvac/enabled').writable);

  await adapter.write('hvac/enabled', true);
  assert.deepEqual(actions[0], {
    account: 'account-1', vin: 'UU1DBG00123456789', endpoint: 'hvac-start', type: 'HvacStart',
    values: { action: 'start', targetTemperature: 22 },
  });
});

test('Renault-Adapter bleibt bei vorübergehendem Cloudfehler stabil getrennt', async (t) => {
  class FailingDataClient {
    async getPerson() { return { accounts: [{ accountId: 'account-1' }] }; }
    async getVehicles() { return { vehicleLinks: [{ vin: 'UU1DBG00123456789' }] }; }
    async getVehicleData() { throw new Error('HTTP 429'); }
  }
  const connected = [];
  const warnings = [];
  const host = {
    setStates() {}, publishStates() {}, setStorage() {}, log() {}, error() {},
    getSecret(key) { return Promise.resolve(key === 'login-token' ? 'token' : 'owner@example.test'); },
    deleteSecret() { return Promise.resolve(true); },
    setConnected(value) { connected.push(value); },
    warn(message) { warnings.push(message); },
  };
  const adapter = createAdapter(host, { RenaultClient: FailingDataClient });
  await adapter.start({ username: 'owner@example.test', pollInterval: 3600 });
  t.after(() => adapter.stop());
  assert.equal(connected.at(-1), false);
  assert.ok(warnings.some((message) => message.includes('normalen Intervall')));
});
