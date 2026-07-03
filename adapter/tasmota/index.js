'use strict';

const net = require('net');
const mqttPacket = require('mqtt-packet');

const MIN_INTERVAL_MS = 5000;
const OFFLINE_BASE_MS = 60000;
const OFFLINE_FACTOR = 2.5;
const STATUS_REQUEST_DELAY_MS = 500;
const STORE_DEBOUNCE_MS = 250;
const CATALOG_DEBOUNCE_MS = 100;

function normalizeIp(ip) {
  if (!ip) return '';
  return String(ip).replace(/^::ffff:/, '');
}

function ipToInt(ip) {
  const parts = normalizeIp(ip).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function parseRangeToken(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  if (value.includes('/')) {
    const [ip, bitsRaw] = value.split('/');
    const bits = Number(bitsRaw);
    const int = ipToInt(ip);
    if (int == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { type: 'cidr', base: int & mask, mask };
  }
  if (value.includes('-')) {
    const [start, end] = value.split('-');
    const a = ipToInt(start);
    const b = ipToInt(end);
    if (a == null || b == null) return null;
    return { type: 'range', start: Math.min(a, b), end: Math.max(a, b) };
  }
  const int = ipToInt(value);
  return int == null ? null : { type: 'single', value: int };
}

function ipAllowed(ip, rangeSpec) {
  const rules = String(rangeSpec || '').split(',').map(parseRangeToken).filter(Boolean);
  if (!rules.length) return true;
  const int = ipToInt(ip);
  if (int == null) return false;
  return rules.some((rule) => {
    if (rule.type === 'single') return int === rule.value;
    if (rule.type === 'range') return int >= rule.start && int <= rule.end;
    return (int & rule.mask) === rule.base;
  });
}

function titleCase(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[_-]+/g, ' '))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function coerceValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^(on|true)$/i.test(text)) return true;
  if (/^(off|false)$/i.test(text)) return false;
  return text;
}

function unitForPath(path) {
  const key = String(path || '').toLowerCase();
  if (/(^|\/)(power|apparentpower|reactivepower)$/.test(key)) return 'W';
  if (/(^|\/)(voltage)$/.test(key)) return 'V';
  if (/(^|\/)(current)$/.test(key)) return 'A';
  if (/(^|\/)(frequency)$/.test(key)) return 'Hz';
  if (/(^|\/)(humidity)$/.test(key)) return '%';
  if (/(^|\/)(pressure)$/.test(key)) return 'hPa';
  if (/(^|\/)(temperature|dewpoint)$/.test(key)) return '°C';
  if (/(^|\/)(rssi|quality|dimmer)$/.test(key)) return '%';
  if (/(^|\/)(total|yesterday|today|exportactive|importactive)$/.test(key)) return 'kWh';
  return '';
}

function flattenPayload(value, prefix = '', into = []) {
  if (value == null) return into;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      flattenPayload(entry, prefix ? `${prefix}/${index + 1}` : String(index + 1), into);
    });
    return into;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      const next = prefix ? `${prefix}/${key}` : key;
      flattenPayload(entry, next, into);
    });
    return into;
  }
  const normalized = coerceValue(value);
  if (normalized != null) into.push({ path: prefix, value: normalized, unit: unitForPath(prefix) });
  return into;
}

function parseJsonPayload(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  try {
    return { json: JSON.parse(text), text };
  } catch (_) {
    return { json: null, text };
  }
}

function stateNameForPath(path) {
  return titleCase(path);
}

function relevantField(path) {
  const value = String(path || '').replace(/^StatusSTS\//, '').replace(/^StatusSNS\//, '');
  if (/^POWER\d*$/i.test(value)) {
    return { path: value.toUpperCase(), name: value.toUpperCase(), unit: '', category: 'Schalten', writable: true };
  }
  const energy = /^ENERGY\/(Total|Today|Yesterday|Power)$/i.exec(value);
  if (!energy) return null;
  const key = energy[1].charAt(0).toUpperCase() + energy[1].slice(1).toLowerCase();
  const names = { Total: 'Energie gesamt', Today: 'Energie heute', Yesterday: 'Energie gestern', Power: 'Aktuelle Leistung' };
  return { path: `ENERGY/${key}`, name: names[key], unit: key === 'Power' ? 'W' : 'kWh', category: 'Energie', writable: false };
}

function buildStateCatalog(devices) {
  const states = [];
  devices.forEach((device) => {
    const baseName = device.friendlyName || device.topic;
    (device.fields || []).forEach((field) => {
      states.push({
        address: `${device.topic}/${field.path}`,
        name: `${baseName} ${field.name || stateNameForPath(field.path)}`.trim(),
        category: `${baseName} / ${field.category || 'Werte'}`,
        unit: field.unit || '',
        writable: !!field.writable,
      });
    });
  });
  return states.sort((a, b) => a.address.localeCompare(b.address, 'de'));
}

function recordForStorage(device) {
  return {
    topic: device.topic,
    identityLocked: !!device.identityLocked,
    friendlyName: device.friendlyName || '',
    clientId: device.clientId || '',
    ip: device.ip || '',
    mac: device.mac || '',
    version: device.version || '',
    module: device.module || '',
    commandTopic: device.commandTopic || '',
    online: !!device.online,
    lastSeenAt: device.lastSeenAt || 0,
    intervalMs: device.intervalMs || 0,
    fields: (device.fields || []).map((field) => ({
      path: field.path,
      name: field.name,
      unit: field.unit || '',
      category: field.category || '',
      writable: !!field.writable,
    })),
  };
}

function intervalChanged(previous, next) {
  if (!Number.isFinite(previous) || previous <= 0) return true;
  return Math.abs(previous - next) > Math.max(5000, previous * 0.25);
}

function parseTasmotaTopic(topic) {
  const parts = String(topic || '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const messageType = parts[parts.length - 1];
  const prefixIndex = parts.findIndex((part) => /^(tele|stat)$/i.test(part));
  const knownMessage = /^(LWT|STATE|SENSOR|INFO\d*|STATUS\d*|RESULT)$/i.test(messageType);
  if (prefixIndex < 0 && !knownMessage) return null;

  const group = prefixIndex >= 0 ? parts[prefixIndex].toLowerCase() : 'tele';
  const identity = parts.slice(0, -1).filter((_part, index) => index !== prefixIndex);
  if (!identity.length) return null;
  return { group, deviceTopic: identity.join('/'), messageType };
}

function commandTopicFromSubscription(subscription) {
  const parts = String(subscription || '').split('/').filter(Boolean);
  const commandIndex = parts.findIndex((part) => /^cmnd$/i.test(part));
  if (commandIndex < 0 || parts.length < 2) return null;
  const commandParts = [...parts];
  if (['#', '+'].includes(commandParts[commandParts.length - 1])) commandParts.pop();
  else if (commandParts.length > commandIndex + 1) commandParts.pop();
  return `${commandParts.join('/')}/STATUS`;
}

function mergeField(device, field) {
  if (!field || !field.path) return false;
  const existing = new Map((device.fields || []).map((entry) => [entry.path, entry]));
  const prev = existing.get(field.path);
  if (prev && prev.name === field.name && prev.unit === field.unit &&
      prev.category === field.category && !!prev.writable === !!field.writable) return false;
  existing.set(field.path, {
    path: field.path,
    name: field.name,
    unit: field.unit || '',
    category: field.category || '',
    writable: !!field.writable,
  });
  device.fields = Array.from(existing.values()).sort((a, b) => a.path.localeCompare(b.path, 'de'));
  return true;
}

module.exports = function createTasmotaAdapter(host) {
  let cfg = {};
  let server = null;
  let stopped = false;
  let effectivePort = 0;
  let storeTimer = null;
  let catalogTimer = null;
  let offlineTimer = null;
  const devices = new Map();
  const sockets = new Set();

  function updateConnectionStatus(detail) {
    const connectedDevices = Array.from(sockets).filter((socket) => socket._authenticated).length;
    host.setConnected(
      connectedDevices > 0,
      detail || (connectedDevices > 0
        ? `${connectedDevices} Gerät${connectedDevices === 1 ? '' : 'e'} verbunden`
        : `Broker aktiv auf Port ${effectivePort}, kein Gerät verbunden`)
    );
  }

  function scheduleStore() {
    if (storeTimer) return;
    storeTimer = setTimeout(() => {
      storeTimer = null;
      if (typeof host.setStorage === 'function') {
        host.setStorage('devices', Array.from(devices.values()).map(recordForStorage));
      }
    }, STORE_DEBOUNCE_MS);
  }

  function scheduleCatalog() {
    if (catalogTimer) return;
    catalogTimer = setTimeout(() => {
      catalogTimer = null;
      host.setStates(buildStateCatalog(Array.from(devices.values())));
    }, CATALOG_DEBOUNCE_MS);
  }

  function upsertDevice(topic, patch = {}) {
    const existing = devices.get(topic) || {
      topic,
      friendlyName: topic,
      clientId: '',
      ip: '',
      mac: '',
      version: '',
      module: '',
      commandTopic: '',
      online: false,
      lastSeenAt: 0,
      intervalMs: 0,
      fields: [],
      intervalSamples: [],
      lastStatusAt: 0,
      statusRequested: false,
      identityLocked: false,
    };
    Object.assign(existing, patch);
    devices.set(topic, existing);
    return existing;
  }

  function mergeDevice(target, source) {
    if (!source || target === source) return target;
    ['friendlyName', 'clientId', 'ip', 'mac', 'version', 'module', 'commandTopic'].forEach((key) => {
      const sourceValue = source[key];
      if (sourceValue && (!target[key] || target[key] === target.topic)) target[key] = sourceValue;
    });
    target.online = !!(target.online || source.online);
    target.lastSeenAt = Math.max(Number(target.lastSeenAt) || 0, Number(source.lastSeenAt) || 0);
    target.intervalMs = Number(target.intervalMs) || Number(source.intervalMs) || 0;
    target.intervalSamples = [...(target.intervalSamples || []), ...(source.intervalSamples || [])].slice(-4);
    target.lastStatusAt = Math.max(Number(target.lastStatusAt) || 0, Number(source.lastStatusAt) || 0);
    (source.fields || []).forEach((field) => mergeField(target, field));
    return target;
  }

  function deviceScore(device) {
    return (device.topic !== device.clientId ? 10 : 0) +
      (device.friendlyName && device.friendlyName !== device.topic ? 5 : 0) +
      (device.fields || []).length +
      ['mac', 'version', 'module'].filter((key) => device[key]).length;
  }

  function consolidateClient(clientId) {
    if (!clientId) return null;
    const matches = Array.from(devices.values()).filter((device) => device.clientId === clientId);
    if (!matches.length) return null;
    matches.sort((a, b) => {
      if (!!a.identityLocked !== !!b.identityLocked) return a.identityLocked ? -1 : 1;
      if (a.identityLocked && b.identityLocked) return 0;
      return deviceScore(b) - deviceScore(a);
    });
    const canonical = matches[0];
    matches.slice(1).forEach((duplicate) => {
      mergeDevice(canonical, duplicate);
      devices.delete(duplicate.topic);
    });
    return canonical;
  }

  function deviceForMessage(socket, topic) {
    const previousKey = socket && socket._deviceKey;
    const previousDevice = previousKey ? devices.get(previousKey) : null;
    if (previousDevice && previousDevice.identityLocked) {
      return upsertDevice(previousKey, {
        clientId: socket && socket._clientId ? socket._clientId : previousDevice.clientId,
        ip: socket ? normalizeIp(socket.remoteAddress) : previousDevice.ip,
      });
    }
    if (previousKey && previousKey !== topic && devices.has(previousKey)) {
      const previous = devices.get(previousKey);
      const device = devices.get(topic);
      devices.delete(previousKey);
      if (device) mergeDevice(device, previous);
      else {
        previous.topic = topic;
        if (previous.friendlyName === previousKey) previous.friendlyName = topic;
        previous.identityLocked = true;
        devices.set(topic, previous);
      }
      scheduleCatalog();
      scheduleStore();
    }
    if (socket) socket._deviceKey = topic;
    return upsertDevice(topic, {
      clientId: socket && socket._clientId ? socket._clientId : '',
      ip: socket ? normalizeIp(socket.remoteAddress) : '',
      identityLocked: true,
    });
  }

  function touchInterval(device, now) {
    if (device.lastStatusAt) {
      const delta = now - device.lastStatusAt;
      if (delta >= MIN_INTERVAL_MS) {
        device.intervalSamples = [...(device.intervalSamples || []), delta].slice(-4);
        if (device.intervalSamples.length >= 3) {
          const avg = Math.round(device.intervalSamples.reduce((sum, entry) => sum + entry, 0) / device.intervalSamples.length);
          if (intervalChanged(device.intervalMs, avg)) {
            device.intervalMs = avg;
            scheduleStore();
          }
        }
      }
    }
    device.lastStatusAt = now;
  }

  function markSeen(device, socket, isStatus) {
    const now = Date.now();
    const changed = !device.online;
    device.online = true;
    device.lastSeenAt = now;
    if (socket && socket.remoteAddress) device.ip = normalizeIp(socket.remoteAddress);
    if (isStatus) touchInterval(device, now);
    scheduleStore();
    if (changed) {
      host.publishState(`${device.topic}/online`, true);
    }
  }

  function markOffline(device, reason) {
    if (!device || !device.online) return;
    device.online = false;
    host.publishState(`${device.topic}/online`, false);
    scheduleStore();
    if (reason) host.log(`${device.topic} offline: ${reason}`);
  }

  function updateMetaFromJson(device, json) {
    const candidates = [];
    if (json && typeof json === 'object') candidates.push(json);
    ['Info1', 'Info2', 'Info3', 'Status', 'StatusNET', 'StatusFWR', 'StatusSTS'].forEach((key) => {
      if (json && json[key] && typeof json[key] === 'object') candidates.push(json[key]);
    });
    let dirty = false;
    candidates.forEach((obj) => {
      if (!obj || typeof obj !== 'object') return;
      const friendly = Array.isArray(obj.FriendlyName) ? obj.FriendlyName[0] : obj.FriendlyName || obj.DeviceName;
      const moduleValue = typeof obj.Module === 'string' ? obj.Module : obj.ModuleName;
      if (friendly && device.friendlyName !== String(friendly)) { device.friendlyName = String(friendly); dirty = true; }
      if (obj.Version && device.version !== String(obj.Version)) { device.version = String(obj.Version); dirty = true; }
      if (obj.IPAddress && device.ip !== String(obj.IPAddress)) { device.ip = String(obj.IPAddress); dirty = true; }
      if (obj.Mac && device.mac !== String(obj.Mac)) { device.mac = String(obj.Mac); dirty = true; }
      if (moduleValue && device.module !== String(moduleValue)) { device.module = String(moduleValue); dirty = true; }
    });
    if (dirty) scheduleStore();
  }

  function publishFlattened(device, json, prefix) {
    const values = flattenPayload(json, prefix).filter((entry) => entry.path);
    if (!values.length) return;
    const published = [];
    values.forEach((entry) => {
      const field = relevantField(entry.path);
      if (!field) return;
      if (mergeField(device, field)) scheduleCatalog();
      published.push({ address: `${device.topic}/${field.path}`, value: entry.value });
    });
    if (published.length) {
      if (typeof host.publishStates === 'function') host.publishStates(published);
      else published.forEach((entry) => host.publishState(entry.address, entry.value));
      scheduleStore();
    }
  }

  function handleTasmotaPublish(socket, topic, payload) {
    const parts = String(topic || '').split('/').filter(Boolean);
    const parsed = parseTasmotaTopic(topic) || (socket._deviceKey && parts.length ? {
      group: 'stat',
      deviceTopic: socket._deviceKey,
      messageType: parts[parts.length - 1],
    } : null);
    if (!parsed) return;
    const { group, deviceTopic, messageType } = parsed;
    const device = deviceForMessage(socket, deviceTopic);
    const { json, text } = parseJsonPayload(payload);
    const typeUpper = messageType.toUpperCase();

    markSeen(device, socket, group === 'tele' && (typeUpper === 'STATE' || typeUpper === 'SENSOR'));

    if (typeUpper === 'LWT') {
      const online = /^online$/i.test(text.trim());
      if (!online) markOffline(device, 'LWT');
      else {
        device.online = true;
        device.lastSeenAt = Date.now();
      }
      host.publishState(`${device.topic}/online`, online);
      scheduleStore();
      return;
    }

    if (json) updateMetaFromJson(device, json);

    if (typeUpper.startsWith('INFO')) {
      if (json) publishFlattened(device, json, '');
      return;
    }
    if (typeUpper === 'STATE' || typeUpper === 'SENSOR') {
      if (json) publishFlattened(device, json, '');
      return;
    }
    if (typeUpper.startsWith('STATUS')) {
      if (json) {
        Object.entries(json).forEach(([key, value]) => publishFlattened(device, value, key));
      }
      return;
    }

    const field = relevantField(messageType);
    if (!field) return;
    if (mergeField(device, field)) scheduleCatalog();
    host.publishState(`${device.topic}/${field.path}`, coerceValue(text));
    scheduleStore();
  }

  function sendPacket(socket, packet, opts) {
    try {
      socket.write(mqttPacket.generate(packet, opts || { protocolVersion: 4 }));
    } catch (_) {
      socket.destroy();
    }
  }

  function sendStatusRequest(socket, protocolVersion, commandTopic) {
    setTimeout(() => {
      if (stopped || socket.destroyed) return;
      sendPacket(socket, {
        cmd: 'publish',
        qos: 0,
        dup: false,
        retain: false,
        topic: commandTopic,
        payload: Buffer.from('0'),
      }, { protocolVersion });
    }, STATUS_REQUEST_DELAY_MS);
  }

  function commandScore(commandTopic, deviceTopic) {
    const command = String(commandTopic || '').toLowerCase();
    const device = String(deviceTopic || '').toLowerCase();
    if (!command || !device) return 0;
    if (command.includes(`/${device}/`) || command.startsWith(`${device}/`) || command.startsWith(`cmnd/${device}/`)) return 10;
    return 1;
  }

  function rememberCommandTopic(socket, device) {
    const candidates = Array.from(socket._commandTopics || []);
    if (device && device.commandTopic) candidates.push(device.commandTopic);
    if (!device || !candidates.length) return;
    candidates.sort((a, b) => commandScore(b, device.topic) - commandScore(a, device.topic));
    if (device.commandTopic !== candidates[0]) {
      device.commandTopic = candidates[0];
      scheduleStore();
    }
  }

  function sendDeviceCommand(address, value) {
    const topics = Array.from(devices.keys()).sort((a, b) => b.length - a.length);
    const topic = topics.find((candidate) => String(address).startsWith(`${candidate}/`));
    if (!topic) return;
    const endpoint = String(address).slice(topic.length + 1);
    if (!/^POWER\d*$/i.test(endpoint)) return;
    const device = devices.get(topic);
    const socket = Array.from(sockets).find((entry) => entry._authenticated &&
      (entry._deviceKey === topic || (device.clientId && entry._clientId === device.clientId)));
    if (!socket || !device.commandTopic) return;
    const commandTopic = device.commandTopic.replace(/\/STATUS$/i, `/${endpoint.toUpperCase()}`);
    const enabled = value === true || value === 1 || /^(1|on|true)$/i.test(String(value));
    sendPacket(socket, {
      cmd: 'publish',
      qos: 0,
      dup: false,
      retain: false,
      topic: commandTopic,
      payload: Buffer.from(enabled ? 'ON' : 'OFF'),
    }, { protocolVersion: socket._protocolVersion || 4 });
  }

  function onSocketClosed(socket) {
    sockets.delete(socket);
    updateConnectionStatus();
    const topic = socket._tasmotaTopic;
    if (!topic) return;
    const device = devices.get(topic);
    if (device) {
      device.lastSeenAt = Date.now();
      scheduleStore();
    }
  }

  function attachSocket(socket) {
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    socket.setNoDelay(true);
    sockets.add(socket);

    parser.on('packet', (packet) => {
      const protocolVersion = packet && packet.protocolVersion ? packet.protocolVersion : (socket._protocolVersion || 4);
      if (packet.cmd === 'connect') {
        socket._protocolVersion = protocolVersion;
        socket._clientId = packet.clientId || '';
        if (!ipAllowed(socket.remoteAddress, cfg.ipRange)) {
          sendPacket(socket, { cmd: 'connack', returnCode: 5, sessionPresent: false }, { protocolVersion });
          socket.end();
          return;
        }
        const username = packet.username == null ? '' : String(packet.username);
        const password = packet.password == null ? '' : Buffer.from(packet.password).toString('utf8');
        const needsAuth = cfg.username || cfg.password;
        if (needsAuth && (username !== String(cfg.username || '') || password !== String(cfg.password || ''))) {
          sendPacket(socket, { cmd: 'connack', returnCode: 4, sessionPresent: false }, { protocolVersion });
          socket.end();
          return;
        }
        socket._authenticated = true;
        const knownDevice = consolidateClient(socket._clientId);
        socket._deviceKey = knownDevice
          ? knownDevice.topic
          : socket._clientId || normalizeIp(socket.remoteAddress) || `client-${Date.now()}`;
        const device = upsertDevice(socket._deviceKey, {
          clientId: socket._clientId || '',
          ip: normalizeIp(socket.remoteAddress),
          online: true,
          lastSeenAt: Date.now(),
        });
        host.publishState(`${device.topic}/online`, true);
        scheduleCatalog();
        scheduleStore();
        sendPacket(socket, { cmd: 'connack', returnCode: 0, sessionPresent: false }, { protocolVersion });
        updateConnectionStatus();
        return;
      }
      if (packet.cmd === 'subscribe') {
        const subscriptions = Array.isArray(packet.subscriptions) ? packet.subscriptions : [];
        subscriptions.forEach((entry) => {
          const sub = String(entry.topic || '');
          const commandTopic = commandTopicFromSubscription(sub);
          if (commandTopic && !socket._statusRequests?.has(commandTopic)) {
            if (!socket._statusRequests) socket._statusRequests = new Set();
            socket._statusRequests.add(commandTopic);
            if (!socket._commandTopics) socket._commandTopics = new Set();
            socket._commandTopics.add(commandTopic);
            rememberCommandTopic(socket, devices.get(socket._deviceKey));
            sendStatusRequest(socket, protocolVersion, commandTopic);
          }
        });
        sendPacket(socket, {
          cmd: 'suback',
          messageId: packet.messageId,
          granted: subscriptions.map(() => 0),
        }, { protocolVersion });
        return;
      }
      if (packet.cmd === 'publish') {
        handleTasmotaPublish(socket, packet.topic, packet.payload);
        const topicInfo = parseTasmotaTopic(packet.topic);
        if (topicInfo) {
          const device = deviceForMessage(socket, topicInfo.deviceTopic);
          rememberCommandTopic(socket, device);
          socket._tasmotaTopic = device.topic;
          if (!device.fields.some((field) => field.path === 'online')) scheduleCatalog();
        }
        if (packet.qos === 1 && packet.messageId != null) {
          sendPacket(socket, { cmd: 'puback', messageId: packet.messageId }, { protocolVersion });
        }
        return;
      }
      if (packet.cmd === 'pingreq') {
        sendPacket(socket, { cmd: 'pingresp' }, { protocolVersion });
        return;
      }
      if (packet.cmd === 'disconnect') {
        socket.end();
      }
    });

    parser.on('error', (err) => {
      host.log(`MQTT-Protokollfehler von ${normalizeIp(socket.remoteAddress) || 'unbekannt'}: ${err.message}`);
      socket.destroy();
    });
    socket.on('data', (chunk) => parser.parse(chunk));
    socket.on('error', () => {});
    socket.on('close', () => onSocketClosed(socket));
  }

  async function findAlternativePort(startPort) {
    const base = Math.max(1024, Number(startPort) || 1884);
    for (let port = base; port < base + 20; port += 1) {
      // eslint-disable-next-line no-await-in-loop
      const free = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
      });
      if (free) return port;
    }
    return null;
  }

  async function startServer() {
    server = net.createServer(attachSocket);
    server.on('error', async (err) => {
      if (err && err.code === 'EADDRINUSE') {
        const suggestion = await findAlternativePort((Number(cfg.port) || 1883) + 1);
        updateConnectionStatus(suggestion
          ? `Port ${Number(cfg.port) || 1883} belegt. Vorschlag: ${suggestion}`
          : `Port ${Number(cfg.port) || 1883} belegt`);
      } else {
        updateConnectionStatus(err && err.message ? err.message : 'Broker-Fehler');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen(Number(cfg.port) || 1883, '0.0.0.0');
    });
    effectivePort = server.address() && server.address().port;
    updateConnectionStatus();
  }

  function restoreStoredDevices() {
    const stored = Array.isArray(cfg.devices) ? cfg.devices : [];
    stored.forEach((row) => {
      if (!row || !row.topic) return;
      devices.set(String(row.topic), {
        topic: String(row.topic),
        friendlyName: row.friendlyName || row.topic,
        clientId: row.clientId || '',
        ip: row.ip || '',
        mac: row.mac || '',
        version: row.version || '',
        module: row.module || '',
        commandTopic: row.commandTopic || '',
        online: !!row.online,
        lastSeenAt: Number(row.lastSeenAt) || 0,
        intervalMs: Number(row.intervalMs) || 0,
        fields: Array.isArray(row.fields) ? row.fields
          .map((field) => relevantField(field.path))
          .filter(Boolean) : [],
        intervalSamples: [],
        lastStatusAt: 0,
        statusRequested: false,
        identityLocked: row.identityLocked == null
          ? String(row.topic) !== String(row.clientId || '')
          : !!row.identityLocked,
      });
    });
    const clientIds = new Set(Array.from(devices.values()).map((device) => device.clientId).filter(Boolean));
    const before = devices.size;
    clientIds.forEach((clientId) => consolidateClient(clientId));
    if (devices.size !== before) scheduleStore();
    if (devices.size) host.setStates(buildStateCatalog(Array.from(devices.values())));
  }

  function startOfflineWatcher() {
    offlineTimer = setInterval(() => {
      const now = Date.now();
      let dirty = false;
      devices.forEach((device) => {
        if (!device.online) return;
        const interval = Math.max(OFFLINE_BASE_MS, Number(device.intervalMs) || OFFLINE_BASE_MS);
        const overdue = Math.round(interval * OFFLINE_FACTOR);
        if (device.lastSeenAt && now - device.lastSeenAt > overdue) {
          markOffline(device, 'Intervall ueberfaellig');
          dirty = true;
        }
      });
      if (dirty) scheduleStore();
    }, 15000);
  }

  return {
    async start(config) {
      cfg = config || {};
      restoreStoredDevices();
      await startServer();
      startOfflineWatcher();
    },

    async stop() {
      stopped = true;
      if (storeTimer) clearTimeout(storeTimer);
      if (catalogTimer) clearTimeout(catalogTimer);
      if (offlineTimer) clearInterval(offlineTimer);
      sockets.forEach((socket) => {
        try { socket.destroy(); } catch (_) {}
      });
      sockets.clear();
      if (server) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      server = null;
    },

    write(address, value) {
      sendDeviceCommand(address, value);
    },
  };
};

module.exports.flattenPayload = flattenPayload;
module.exports.buildStateCatalog = buildStateCatalog;
module.exports.ipAllowed = ipAllowed;
module.exports.parseTasmotaTopic = parseTasmotaTopic;
module.exports.commandTopicFromSubscription = commandTopicFromSubscription;
