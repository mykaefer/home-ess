'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');
const {
  PROTOCOL_VERSION, supportedRuntimeProfile, validateDeviceId, validatePort, parseSemVer,
} = require('./validation');
const { validateBindingId } = require('./auth');

const SERVICE = '_homeess-hdp._tcp.local';
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.');
  return Buffer.concat([...parts.map((part) => {
    const value = Buffer.from(part, 'utf8');
    return Buffer.concat([Buffer.from([value.length]), value]);
  }), Buffer.from([0])]);
}

function queryPacket() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, encodeName(SERVICE), Buffer.from([0, 12, 0, 1])]);
}

function readName(buffer, offset, depth = 0) {
  if (depth > 12) throw new Error('DNS-Kompressionsschleife.');
  const labels = [];
  let cursor = offset;
  let end = null;
  while (cursor < buffer.length) {
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      if (end == null) end = cursor;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new Error('Ungültiger DNS-Pointer.');
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      const nested = readName(buffer, pointer, depth + 1);
      labels.push(nested.name);
      cursor += 2;
      if (end == null) end = cursor;
      break;
    }
    if (length > 63 || cursor + 1 + length > buffer.length) throw new Error('Ungültiger DNS-Name.');
    labels.push(buffer.subarray(cursor + 1, cursor + 1 + length).toString('utf8'));
    cursor += 1 + length;
  }
  return { name: labels.filter(Boolean).join('.'), offset: end == null ? cursor : end };
}

function parseTxt(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset++];
    if (offset + length > data.length) break;
    const entry = data.subarray(offset, offset + length).toString('utf8');
    offset += length;
    const split = entry.indexOf('=');
    const key = (split < 0 ? entry : entry.slice(0, split)).toLowerCase();
    result[key] = split < 0 ? true : entry.slice(split + 1);
  }
  return result;
}

function parsePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return [];
  const counts = [4, 6, 8, 10].map((offset) => buffer.readUInt16BE(offset));
  let offset = 12;
  const records = [];
  for (let section = 0; section < 4; section += 1) {
    for (let i = 0; i < counts[section]; i += 1) {
      const owner = readName(buffer, offset);
      offset = owner.offset;
      if (section === 0) {
        if (offset + 4 > buffer.length) return records;
        offset += 4;
        continue;
      }
      if (offset + 10 > buffer.length) return records;
      const type = buffer.readUInt16BE(offset);
      const ttl = buffer.readUInt32BE(offset + 4);
      const length = buffer.readUInt16BE(offset + 8);
      offset += 10;
      if (offset + length > buffer.length) return records;
      const start = offset;
      const data = buffer.subarray(offset, offset + length);
      offset += length;
      let value = data;
      if (type === 12) value = readName(buffer, start).name;
      else if (type === 33 && length >= 6) value = {
        priority: data.readUInt16BE(0), weight: data.readUInt16BE(2),
        port: data.readUInt16BE(4), target: readName(buffer, start + 6).name,
      };
      else if (type === 16) value = parseTxt(data);
      else if (type === 1 && length === 4) value = Array.from(data).join('.');
      else if (type === 28 && length === 16) {
        const groups = [];
        for (let pos = 0; pos < 16; pos += 2) groups.push(data.readUInt16BE(pos).toString(16));
        value = groups.join(':');
      }
      records.push({ name: owner.name, type, ttl, value });
    }
  }
  return records;
}

function decimalInteger(value, min, max, label) {
  const text = String(value == null ? '' : value);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(`${label} ist keine dezimale Ganzzahl.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} liegt außerhalb des Wertebereichs.`);
  return number;
}

function devicesFromRecords(records, remoteAddress = '') {
  const instances = new Set();
  for (const record of records) {
    if (record.type === 12 && record.name.toLowerCase() === SERVICE && typeof record.value === 'string') {
      instances.add(record.value);
    }
  }
  // Einige minimalistische Firmwares schicken beim Query nur SRV/TXT im
  // Additional-Abschnitt. Diese Instanzen ebenfalls berücksichtigen.
  records.filter((record) => record.type === 16 || record.type === 33).forEach((record) => instances.add(record.name));
  const result = [];
  for (const instance of instances) {
    const txt = records.find((record) => record.type === 16 && record.name === instance);
    const srv = records.find((record) => record.type === 33 && record.name === instance);
    if (!txt || !srv || !txt.value || !srv.value) continue;
    const fields = txt.value;
    let deviceId;
    try {
      deviceId = validateDeviceId(fields.device_id);
      if (fields.protocol_version !== PROTOCOL_VERSION) throw new Error('Falsche Protokollversion.');
      if (fields.runtime_profile != null
          && !/^[A-Za-z0-9._-]{1,64}$/.test(fields.runtime_profile)) throw new Error('Ungültiges Runtime-Profil.');
      parseSemVer(fields.firmware_version);
      if (!/^[\x21-\x7e]+$/.test(String(fields.platform || ''))) throw new Error('Ungültige Plattform.');
      if (!['pairable', 'pairing', 'paired'].includes(fields.pairing_state)) throw new Error('Ungültiger Pairing-Zustand.');
      if (fields.configured_device_type && !/^[a-z0-9._-]{1,32}$/.test(fields.configured_device_type)) throw new Error('Ungültiger Gerätetyp.');
      if (!['true', 'false'].includes(fields.hardware_config_present)) throw new Error('Ungültiger Hardwarestatus.');
      if (fields.pairing_state === 'paired') validateBindingId(fields.binding_id);
      else if (fields.binding_id !== '') throw new Error('Ungekoppeltes Gerät darf keine Binding-ID annoncieren.');
    } catch (_) { continue; }
    const addressRecord = records.find((record) =>
      (record.type === 1 || record.type === 28) && record.name === srv.value.target);
    let apiPort;
    let wsPort;
    let otaPort;
    let configRevision;
    try {
      apiPort = validatePort(decimalInteger(fields.api_port, 1, 65535, 'API-Port'), 'API-Port');
      wsPort = validatePort(decimalInteger(fields.ws_port, 1, 65535, 'WebSocket-Port'), 'WebSocket-Port');
      otaPort = validatePort(decimalInteger(fields.ota_port, 1, 65535, 'OTA-Port'), 'OTA-Port');
      configRevision = decimalInteger(fields.config_revision, 0, 0xffffffff, 'Konfigurationsrevision');
      if (apiPort !== srv.value.port) throw new Error('SRV- und TXT-API-Port stimmen nicht überein.');
    } catch (_) { continue; }
    result.push({
      deviceId,
      serviceName: instance,
      hostname: srv.value.target,
      address: addressRecord ? addressRecord.value : (srv.remoteAddress || txt.remoteAddress || remoteAddress),
      apiPort,
      wsPort,
      otaPort,
      protocolVersion: fields.protocol_version,
      ...(fields.runtime_profile ? { runtimeProfile: fields.runtime_profile } : {}),
      ...(fields.runtime_profile ? {
        runtimeCompatible: supportedRuntimeProfile(fields.runtime_profile),
        runtimeMismatch: !supportedRuntimeProfile(fields.runtime_profile),
      } : {}),
      firmwareVersion: fields.firmware_version,
      platform: fields.platform,
      pairingState: fields.pairing_state,
      bindingId: fields.binding_id || null,
      deviceType: fields.configured_device_type || '',
      hardwareConfigPresent: fields.hardware_config_present === 'true',
      configRevision,
      pairable: fields.pairing_state === 'pairable',
    });
  }
  return result;
}

class Discovery extends EventEmitter {
  constructor(options = {}) {
    super();
    this.intervalMs = Math.max(5000, Number(options.intervalMs) || 30000);
    this.offlineAfterMs = Math.max(this.intervalMs * 2, Number(options.offlineAfterMs) || 90000);
    this.socketFactory = options.socketFactory || (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    this.devices = new Map();
    this.records = new Map();
    this.socket = null;
    this.timer = null;
    this.expiryTimer = null;
  }

  start() {
    if (this.socket) return;
    const socket = this.socketFactory();
    this.socket = socket;
    socket.on('message', (packet, remote) => {
      try {
        const now = Date.now();
        for (const record of parsePacket(packet)) {
          const suffix = record.type === 12 ? `|${record.value}` : '';
          const key = `${record.name}|${record.type}${suffix}`;
          if (record.ttl === 0) this.records.delete(key);
          else this.records.set(key, {
            ...record, remoteAddress: remote && remote.address,
            expiresAt: now + record.ttl * 1000,
          });
        }
        for (const [key, record] of this.records) {
          if (record.expiresAt <= now) this.records.delete(key);
        }
        this.ingest(devicesFromRecords(Array.from(this.records.values()), remote && remote.address), now);
      } catch (err) {
        this.emit('warning', err);
      }
    });
    socket.on('error', (err) => this.emit('warning', err));
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
        socket.setMulticastTTL(255);
      } catch (err) {
        this.emit('warning', err);
      }
      this.refresh();
    });
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.expiryTimer = setInterval(() => this.markExpired(), Math.min(this.intervalMs, 10000));
  }

  refresh() {
    if (!this.socket) return;
    const packet = queryPacket();
    this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDRESS, (err) => {
      if (err) this.emit('warning', err);
    });
  }

  ingest(devices, now = Date.now()) {
    for (const device of devices || []) {
      const previous = this.devices.get(device.deviceId);
      const next = { ...previous, ...device, online: true, lastSeenAt: now };
      this.devices.set(device.deviceId, next);
      if (!previous) {
        this.emit('found', next, null);
        continue;
      }
      const changed = previous.online !== true
        || Object.keys(device).some((key) => previous[key] !== device[key]);
      if (changed) this.emit('updated', next, previous);
    }
  }

  markExpired(now = Date.now()) {
    for (const [id, device] of this.devices) {
      if (device.online && now - device.lastSeenAt > this.offlineAfterMs) {
        const next = { ...device, online: false };
        this.devices.set(id, next);
        this.emit('lost', next);
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.timer = null;
    this.expiryTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch (_) { /* bereits geschlossen */ }
    }
    this.socket = null;
    this.records.clear();
  }
}

module.exports = {
  SERVICE, queryPacket, parsePacket, decimalInteger, devicesFromRecords, Discovery,
};
