'use strict';

const http = require('http');
const https = require('https');

const API_GAP_MS = 1000;
const CATALOG_DEBOUNCE_MS = 250;

function segment(value) { return encodeURIComponent(String(value)); }
function unsegment(value) { try { return decodeURIComponent(value); } catch (_) { return value; } }

function normalizeServer(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function parseDeviceIds(value) {
  return String(value || '').split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean);
}

function primitive(value) {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value);
}

function flatten(value, path = [], result = []) {
  if (primitive(value)) {
    if (path.length && value != null) result.push({ path, value });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, [...path, String(index)], result));
    return result;
  }
  for (const [key, entry] of Object.entries(value || {})) flatten(entry, [...path, key], result);
  return result;
}

const UNITS = new Map([
  ['apower', 'W'], ['power', 'W'], ['voltage', 'V'], ['current', 'A'],
  ['aenergy.total', 'Wh'], ['total', 'Wh'], ['total_act_energy', 'Wh'],
  ['temperature.tC', '°C'], ['tmp.tC', '°C'], ['temperature', '°C'],
  ['humidity.rh', '%'], ['hum.value', '%'], ['battery.percent', '%'], ['bat.value', '%'],
  ['brightness', '%'], ['gain', '%'], ['current_pos', '%'], ['pos_control', '%'],
  ['lux.value', 'lx'], ['illumination.lux', 'lx'], ['rssi', 'dBm'], ['uptime', 's'],
]);

function unitFor(path) {
  const key = path.join('.');
  if (UNITS.has(key)) return UNITS.get(key);
  for (const [suffix, unit] of UNITS) if (key.endsWith(`.${suffix}`)) return unit;
  return '';
}

function writeTarget(path) {
  // Gen2+: switch:0/output, light:0/brightness, cover:0/current_pos.
  let match = /^(switch|light|cover):(\d+)\/(output|brightness|gain|red|green|blue|white|current_pos|pos_control)$/.exec(path.join('/'));
  if (match) return { kind: match[1], channel: Number(match[2]), property: match[3] };
  // Gen1: relays/0/ison, lights/0/brightness, rollers/0/current_pos.
  match = /^(relays|lights|rollers)\/(\d+)\/(ison|brightness|gain|red|green|blue|white|current_pos|pos)$/.exec(path.join('/'));
  if (!match) return null;
  return { kind: { relays: 'switch', lights: 'light', rollers: 'cover' }[match[1]], channel: Number(match[2]), property: match[3] };
}

function displayPart(value) {
  return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function requestJson(url, { form, json } = {}) {
  const target = new URL(url);
  const body = json != null ? JSON.stringify(json) : new URLSearchParams(form || {}).toString();
  const transport = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method: 'POST', headers: {
      'Content-Type': json != null ? 'application/json' : 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body), 'User-Agent': 'homeESS-shelly/1.0',
    }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
          const parsed = text ? JSON.parse(text) : {};
          if (parsed && parsed.isok === false) {
            const detail = parsed.errors ? JSON.stringify(parsed.errors) : 'Unbekannter API-Fehler';
            throw new Error(`Shelly Cloud: ${detail}`);
          }
          resolve(parsed);
        } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Shelly-Cloud-Zeitüberschreitung')));
    req.on('error', reject);
    req.end(body);
  });
}

function deviceRows(payload) {
  const root = payload && payload.data != null ? payload.data : payload;
  const source = root && root.devices != null ? root.devices : root;
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : {}) }));
}

function allStatusRows(payload) {
  const source = payload && payload.data && payload.data.devices_status;
  if (!source || typeof source !== 'object') return [];
  return Object.values(source).map((raw) => {
    const status = raw && typeof raw === 'object' ? { ...raw } : {};
    const info = status._dev_info && typeof status._dev_info === 'object' ? status._dev_info : {};
    delete status._dev_info;
    const id = info.id || info.device_id;
    return { ...info, id, code: info.code || info.type, online: info.online, status: { cloud: { online: !!Number(info.online) }, ...status } };
  }).filter((row) => row.id);
}

module.exports = function createShellyAdapter(host) {
  let cfg = {};
  let baseUrl = '';
  let timer = null;
  let catalogTimer = null;
  let stopped = false;
  let polling = false;
  let lastRequestAt = 0;
  const devices = new Map();
  const states = new Map();
  const lastValues = new Map();

  async function api(path, options) {
    const wait = Math.max(0, API_GAP_MS - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (stopped) throw new Error('Adapter gestoppt');
    lastRequestAt = Date.now();
    return requestJson(`${baseUrl}${path}`, options);
  }

  function customName(id) {
    const record = devices.get(String(id));
    return record && record.customName ? record.customName : '';
  }

  function publishCatalog() {
    host.setStates(Array.from(states.values()).sort((a, b) =>
      `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`, 'de')));
  }

  function scheduleCatalog() {
    if (catalogTimer) return;
    catalogTimer = setTimeout(() => { catalogTimer = null; publishCatalog(); }, CATALOG_DEBOUNCE_MS);
  }

  function restore(records) {
    for (const device of Array.isArray(records) ? records : []) {
      if (!device || !device.address) continue;
      devices.set(String(device.address), { ...device });
      for (const channel of device.channels || []) {
        for (const state of channel.states || []) {
          if (!state || !state.address) continue;
          states.set(String(state.address), { address: String(state.address), name: state.name || state.address,
            category: `${device.customName || device.name || device.address} / ${channel.name || channel.address}`,
            unit: state.unit || '', writable: !!state.writable });
        }
      }
    }
  }

  function rememberDevice(info) {
    const id = String(info.id || info.device_id || info.mac || '').trim();
    if (!id) return null;
    const old = devices.get(id) || {};
    const name = info.name || info.device_name || info.room_name || old.name || `${info.type || info.code || 'Shelly'} (${id})`;
    devices.set(id, { ...old, address: id, name: String(name), customName: old.customName || '',
      type: String(info.type || info.code || old.type || ''), generation: String(info.gen || info.generation || old.generation || ''),
      online: info.online == null ? old.online : !!Number(info.online), channels: old.channels || [] });
    return id;
  }

  function applyStatus(info) {
    const id = rememberDevice(info);
    if (!id) return [];
    const record = devices.get(id);
    const status = info.status || info.device_status || {};
    const channelMap = new Map();
    const values = [];
    for (const item of flatten(status)) {
      const path = item.path;
      const component = path.length > 1 ? path[0] : 'Allgemein';
      const address = `${segment(id)}/${path.map(segment).join('/')}`;
      const target = writeTarget(path);
      const state = { address, name: displayPart(path.at(-1)),
        category: `${customName(id) || record.name || id} / ${displayPart(component)}`,
        unit: unitFor(path), writable: !!target };
      states.set(address, state);
      lastValues.set(address, item.value);
      values.push({ address, value: item.value });
      if (!channelMap.has(component)) channelMap.set(component, []);
      channelMap.get(component).push({ address, name: state.name, unit: state.unit, writable: state.writable });
    }
    record.channels = Array.from(channelMap, ([address, channelStates]) => ({ address, name: displayPart(address),
      states: channelStates.sort((a, b) => a.address.localeCompare(b.address, 'de')) }))
      .sort((a, b) => a.address.localeCompare(b.address, 'de'));
    return values;
  }

  function persistDevices() {
    host.setStorage('devices', Array.from(devices.values()).sort((a, b) =>
      String(a.customName || a.name || a.address).localeCompare(String(b.customName || b.name || b.address), 'de')));
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      const values = [];
      const payload = await api('/device/all_status?show_info=true', { form: { auth_key: cfg.authKey, show_info: 'true' } });
      const automatic = allStatusRows(payload);
      automatic.forEach((row) => values.push(...applyStatus(row)));
      const known = new Set(automatic.map((row) => String(row.id)));
      const fallbackIds = parseDeviceIds(cfg.deviceIds).filter((id) => !known.has(id));
      for (let index = 0; index < fallbackIds.length; index += 10) {
        const batch = fallbackIds.slice(index, index + 10);
        const response = await api(`/v2/devices/api/get?auth_key=${encodeURIComponent(cfg.authKey)}`,
          { json: { ids: batch, select: ['status'] } });
        const rows = Array.isArray(response) ? response : deviceRows(response);
        rows.forEach((row) => values.push(...applyStatus(row)));
      }
      const ids = [...known, ...fallbackIds];
      if (!ids.length) throw new Error('Die Shelly Cloud meldet keine Geräte');
      publishCatalog();
      persistDevices();
      if (values.length) host.publishStates(values);
      host.setConnected(true, `${ids.length} Shelly-Gerät${ids.length === 1 ? '' : 'e'}`);
    } catch (err) {
      host.setConnected(false, err.message);
      host.error(`Shelly Cloud: ${err.message}`);
    } finally { polling = false; }
  }

  function decodeAddress(address) {
    const parts = String(address).split('/').map(unsegment);
    return { id: parts.shift(), path: parts };
  }

  async function command(address, value) {
    const { id, path } = decodeAddress(address);
    const target = writeTarget(path);
    if (!target) throw new Error(`State ${address} ist nicht schreibbar`);
    const body = { id, channel: target.channel };
    if (target.kind === 'switch') body.on = value === true || /^(1|true|on|ein)$/i.test(String(value));
    if (target.kind === 'light') {
      if (target.property === 'output' || target.property === 'ison') body.on = value === true || /^(1|true|on|ein)$/i.test(String(value));
      else body[target.property] = Number(value);
    }
    if (target.kind === 'cover') body.position = Number.isFinite(Number(value)) ? Number(value) : String(value);
    await api(`/v2/devices/api/set/${target.kind}?auth_key=${encodeURIComponent(cfg.authKey)}`, { json: body });
    lastValues.set(address, value);
    host.publishState(address, value);
  }

  return {
    async start(config) {
      cfg = config || {};
      baseUrl = normalizeServer(cfg.serverUri);
      if (!baseUrl) throw new Error('Shelly Cloud Server fehlt');
      if (!cfg.authKey) throw new Error('Shelly Authorization Cloud Key fehlt');
      stopped = false;
      restore(cfg.devices);
      publishCatalog();
      await poll();
      timer = setInterval(poll, Math.max(5, Number(cfg.pollInterval) || 30) * 1000);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (catalogTimer) clearTimeout(catalogTimer);
      timer = null;
    },
    async write(address, value) {
      if (lastValues.has(address) && lastValues.get(address) === value) return;
      try { await command(address, value); }
      catch (err) { host.error(`Shelly-Schreiben ${address}: ${err.message}`); throw err; }
    },
    async read() { await poll(); },
  };
};

module.exports._test = { normalizeServer, parseDeviceIds, flatten, unitFor, writeTarget, deviceRows, allStatusRows };
