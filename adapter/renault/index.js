'use strict';

const { RenaultClient, attributes, accountRows, vehicleRows, vehicleVin, firstPath } = require('./client');

const STATES = [
  { address: 'battery/level', name: 'Akkustand', category: 'Fahrzeug / Akku', unit: '%' },
  { address: 'battery/range', name: 'Elektrische Reichweite', category: 'Fahrzeug / Akku', unit: 'km' },
  { address: 'battery/capacity', name: 'Akkukapazität', category: 'Fahrzeug / Akku', unit: 'kWh' },
  { address: 'battery/available-energy', name: 'Verfügbare Energie', category: 'Fahrzeug / Akku', unit: 'kWh' },
  { address: 'battery/temperature', name: 'Akkutemperatur', category: 'Fahrzeug / Akku', unit: '°C' },
  { address: 'battery/updated-at', name: 'Akku-Zeitstempel', category: 'Fahrzeug / Akku' },
  { address: 'charging/status', name: 'Ladestatus', category: 'Fahrzeug / Laden' },
  { address: 'charging/plug-status', name: 'Steckerstatus', category: 'Fahrzeug / Laden' },
  { address: 'charging/remaining-time', name: 'Verbleibende Ladezeit', category: 'Fahrzeug / Laden', unit: 'min' },
  { address: 'charging/power', name: 'Ladeleistung', category: 'Fahrzeug / Laden', unit: 'kW' },
  { address: 'charging/enabled', name: 'Laden starten / stoppen', category: 'Fahrzeug / Laden' },
  { address: 'cockpit/mileage', name: 'Kilometerstand', category: 'Fahrzeug / Cockpit', unit: 'km' },
  { address: 'hvac/status', name: 'Klimastatus', category: 'Fahrzeug / Klimatisierung' },
  { address: 'hvac/enabled', name: 'Vorklimatisierung', category: 'Fahrzeug / Klimatisierung' },
  { address: 'hvac/external-temperature', name: 'Außentemperatur', category: 'Fahrzeug / Klimatisierung', unit: '°C' },
  { address: 'hvac/internal-temperature', name: 'Innentemperatur', category: 'Fahrzeug / Klimatisierung', unit: '°C' },
];

function present(value) { return value !== undefined && value !== null && value !== ''; }

function isActive(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const text = String(value || '').trim().toLowerCase();
  return !!text && !['0', 'off', 'stopped', 'inactive', 'not_charging', 'unavailable'].includes(text);
}

function isCharging(value) {
  if (typeof value === 'number') return value === 1;
  const text = String(value || '').trim().toLowerCase();
  return ['1', 'charging', 'charge_in_progress', 'charging_in_progress'].includes(text);
}

function pick(source, ...keys) {
  for (const key of keys) if (present(source[key])) return source[key];
  return undefined;
}

function mapBattery(payload) {
  const data = attributes(payload);
  return {
    'battery/level': pick(data, 'batteryLevel'),
    'battery/range': pick(data, 'batteryAutonomy'),
    'battery/capacity': pick(data, 'batteryCapacity'),
    'battery/available-energy': pick(data, 'batteryAvailableEnergy'),
    'battery/temperature': pick(data, 'batteryTemperature'),
    'battery/updated-at': pick(data, 'timestamp', 'lastUpdateTime'),
    'charging/status': pick(data, 'chargingStatus'),
    'charging/plug-status': pick(data, 'plugStatus'),
    'charging/remaining-time': pick(data, 'chargingRemainingTime'),
    'charging/power': pick(data, 'chargingInstantaneousPower'),
    'charging/enabled': isCharging(pick(data, 'chargingStatus')),
  };
}

function mapCockpit(payload) {
  const data = attributes(payload);
  return { 'cockpit/mileage': pick(data, 'totalMileage', 'mileage') };
}

function mapHvac(payload) {
  const data = attributes(payload);
  const status = pick(data, 'hvacStatus', 'status');
  return {
    'hvac/status': status,
    'hvac/enabled': isActive(status),
    'hvac/external-temperature': pick(data, 'externalTemperature'),
    'hvac/internal-temperature': pick(data, 'internalTemperature'),
  };
}

function createAdapter(host, dependencies = {}) {
  const Client = dependencies.RenaultClient || RenaultClient;
  let client;
  let cfg = {};
  let timer = null;
  let refreshTimer = null;
  let stopped = false;
  let accountId = '';
  let vin = '';
  let polling = null;

  function publish(values) {
    host.publishStates(Object.entries(values)
      .filter(([, value]) => present(value))
      .map(([address, value]) => ({ address, value })));
  }

  async function authenticate() {
    const username = String(cfg.username || '').trim().toLowerCase();
    if (!username) throw new Error('My-Renault-/My-Dacia-E-Mail fehlt.');
    let token = await host.getSecret('login-token');
    const tokenUser = await host.getSecret('login-user');
    if (token && tokenUser !== username) {
      await host.deleteSecret('login-token');
      token = null;
    }
    client = new Client({ locale: cfg.locale || 'de_DE', loginToken: token });
    // Ein erneut eingetragenes Passwort ist eine bewusste Neuanmeldung, etwa
    // nach Ablauf oder Widerruf des zuvor gespeicherten Tokens.
    if (cfg.password || !token) {
      if (!cfg.password) throw new Error('Passwort zur Erstanmeldung fehlt.');
      token = await client.login(username, String(cfg.password));
      await host.setSecret('login-token', token);
      await host.setSecret('login-user', username);
      await host.persistStorage('password', '');
    }
  }

  async function discover() {
    const person = await client.getPerson();
    const requestedAccount = String(cfg.accountId || '').trim();
    const accounts = accountRows(person);
    const account = requestedAccount
      ? accounts.find((row) => String(row.accountId || row.id) === requestedAccount)
      : accounts[0];
    accountId = requestedAccount || String(account && (account.accountId || account.id) || '');
    if (!accountId) throw new Error('Kein Renault-/Dacia-Fahrzeugkonto gefunden.');

    const vehiclePayload = await client.getVehicles(accountId);
    const vehicles = vehicleRows(vehiclePayload);
    const requestedVin = String(cfg.vin || '').trim().toUpperCase();
    const selected = requestedVin ? vehicles.find((row) => vehicleVin(row) === requestedVin) : vehicles[0];
    vin = requestedVin || vehicleVin(selected);
    if (!vin) throw new Error('Kein Fahrzeug im Renault-/Dacia-Konto gefunden.');
    if (requestedVin && !selected) throw new Error('Die konfigurierte FIN wurde im Konto nicht gefunden.');

    const details = selected && (selected.vehicleDetails || selected.vehicle || selected) || {};
    host.setStorage('vehicles', vehicles.map((row) => {
      const rowDetails = row.vehicleDetails || row.vehicle || row;
      return {
        address: vehicleVin(row),
        name: firstPath(rowDetails, ['nickname', 'model.label', 'modelLabel', 'model']) || vehicleVin(row),
        model: firstPath(rowDetails, ['model.label', 'modelLabel', 'modelCode', 'model']) || '',
        vin: vehicleVin(row),
      };
    }));
    host.log(`Fahrzeug verbunden: ${firstPath(details, ['nickname', 'model.label', 'modelLabel']) || 'Renault / Dacia'}`);
  }

  async function optionalRead(label, version, endpoint, mapper) {
    try {
      const result = await client.getVehicleData(accountId, vin, version, endpoint);
      publish(mapper(result));
      return true;
    } catch (error) {
      host.warn(`${label} nicht verfügbar: ${error.message}`);
      return false;
    }
  }

  async function poll() {
    if (stopped) return;
    if (polling) return polling;
    polling = (async () => {
      const battery = await optionalRead('Akkudaten', 2, 'battery-status', mapBattery);
      const cockpit = await optionalRead('Cockpitdaten', 1, 'cockpit', mapCockpit);
      const hvac = await optionalRead('Klimadaten', 1, 'hvac-status', mapHvac);
      const connected = battery || cockpit || hvac;
      host.setConnected(connected, connected ? `Online · ${vin.slice(-6)}` : 'Keine Fahrzeugdaten verfügbar');
      // Vorübergehende Cloud- oder Quotenfehler dürfen den Kindprozess nicht
      // beenden: Der Supervisor würde ihn sofort neu starten und damit ein
      // Renault-Rate-Limit durch eine Anfrageschleife weiter verschärfen.
      if (!connected) host.warn('Renault-Cloud lieferte vorübergehend keine Fahrzeugdaten; nächster Versuch im normalen Intervall.');
    })();
    try { await polling; } finally { polling = null; }
  }

  async function action(endpoint, type, actionAttributes) {
    if (!cfg.enableControls) throw new Error('Fahrzeugsteuerung ist in den Adaptereinstellungen deaktiviert.');
    await client.setVehicleAction(accountId, vin, endpoint, type, actionAttributes);
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      poll().catch((error) => host.warn(error.message));
    }, 5000);
  }

  return {
    async start(config) {
      cfg = config || {};
      stopped = false;
      const writable = !!cfg.enableControls;
      host.setStates(STATES.map((state) => ({
        ...state,
        writable: writable && ['charging/enabled', 'hvac/enabled'].includes(state.address),
      })));
      await authenticate();
      await discover();
      await poll();
      timer = setInterval(() => poll().catch((error) => {
        host.setConnected(false, error.message);
        host.error(`Renault-Aktualisierung: ${error.message}`);
      }), Math.max(5, Number(cfg.pollInterval) || 15) * 60 * 1000);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (refreshTimer) clearTimeout(refreshTimer);
      timer = null;
      refreshTimer = null;
    },
    async read() { await poll(); },
    async write(address, value) {
      if (address === 'hvac/enabled') {
        const enabled = isActive(value);
        const temperature = Math.max(16, Math.min(26, Number(cfg.targetTemperature) || 21));
        await action('hvac-start', 'HvacStart', enabled
          ? { action: 'start', targetTemperature: temperature }
          : { action: 'cancel' });
        host.publishState(address, enabled);
        return;
      }
      if (address === 'charging/enabled') {
        const enabled = isActive(value);
        await action('charging-start', 'ChargingStart', { action: enabled ? 'start' : 'stop' });
        host.publishState(address, enabled);
        return;
      }
      throw new Error(`Unbekanntes Renault-Schreibziel: ${address}`);
    },
  };
}

module.exports = createAdapter;
module.exports._test = { STATES, isActive, isCharging, mapBattery, mapCockpit, mapHvac };
