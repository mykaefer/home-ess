'use strict';

const { Discovery } = require('./discovery');
const { HdpClient, HdpError } = require('./client');
const { RuntimeConnection, connectionErrorMessage } = require('./runtime');
const { LegacyRuntimeAdapter, runtimePayload } = require('./legacy-runtime');
const { OutputClient } = require('./output-client');
const {
  renderPercentageFrame, compileIndicatorTimeline,
} = require('./renderer');
const {
  finite, bounded, scale, interpolateColor, colorStops, validateHardwareConfig,
  validateDeviceId, RUNTIME_PROFILE,
} = require('./validation');
const {
  createAdapterNonce, createBindingKey, validateBindingKey, bindingId,
} = require('./auth');
const {
  validateManifest, selectArtifact, checkCompatibility, validateArtifactFile,
  uploadFirmware, ReleaseService,
} = require('./firmware');
const crypto = require('crypto');

const PROTOCOL_VERSION = '1.0-draft';
const SECRET_PREFIX = 'device-';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function json(value) {
  return esc(JSON.stringify(value == null ? null : value, null, 2));
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function number(value, fallback) {
  const n = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function defaultBindings() {
  return {
    percentage: { topic: '', input_min: 0, input_max: 100, output_min: 0, output_max: 100, clamp: true, invert: false },
    color: {
      mode: 'fixed', topic: '', color: { r: 0, g: 255, b: 0 },
      stops: [
        { value: 0, color: { r: 255, g: 0, b: 0 } },
        { value: 50, color: { r: 255, g: 255, b: 0 } },
        { value: 100, color: { r: 0, g: 255, b: 0 } },
      ],
    },
    brightness: {
      mode: 'fixed', fixed: 100, topic: '',
      input_min: 0, input_max: 100, output_min: 0, output_max: 100, clamp: true, invert: false,
    },
    indicator: {
      rising_topic: '', falling_topic: '',
      sweep_milliseconds: 600, pulse_interval_milliseconds: 4000, dimming_percent: 40,
    },
    display: { fractional_pixel: true },
  };
}

  function defaultUpdateSettings() {
  return {
    mode: 'manual',
    channel: 'stable',
    maintenance_window: { enabled: false, start: '02:00', end: '04:00' },
    retry_count: 2,
    update_when_device_returns_online: true,
  };
}

function mergeBindings(value) {
  const base = defaultBindings();
  const input = value && typeof value === 'object' ? value : {};
  return {
    percentage: { ...base.percentage, ...(input.percentage || {}) },
    color: { ...base.color, ...(input.color || {}) },
    brightness: { ...base.brightness, ...(input.brightness || {}) },
    indicator: { ...base.indicator, ...(input.indicator || {}) },
    display: { ...base.display, ...(input.display || {}) },
  };
}

function sourceParts(topic) {
  const text = String(topic || '').trim();
  const match = /^([a-z][a-z0-9_-]*):\/\/([^/]+)\/(.+)$/.exec(text);
  return match
    ? { source_adapter: match[1], source_instance: decodeURIComponent(match[2]), source_state_id: decodeURIComponent(match[3]) }
    : { source_adapter: 'mqtt', source_instance: '', source_state_id: text };
}

function sanitizeDevice(device) {
  const copy = { ...device };
  delete copy.secret;
  delete copy.bindingKey;
  delete copy.client;
  delete copy.connection;
  delete copy.unsubscribers;
  delete copy.pendingFirmware;
  delete copy.reconciling;
  delete copy.sourceTimes;
  delete copy.outputClient;
  delete copy.legacyOutput;
  delete copy.renderQueue;
  delete copy.pendingRender;
  return copy;
}

function displayColor(device) {
  const binding = device.bindings.color;
  if (binding.mode === 'fixed') return binding.color;
  if (binding.mode === 'value_gradient') return interpolateColor(device.calculatedPercentage, binding.stops);
  if (binding.mode === 'separate_numeric_source') return interpolateColor(device.rawColor, binding.stops);
  throw new Error('Unbekannter Farbmodus.');
}

function dynamicBrightness(device) {
    const binding = device.bindings.brightness;
    let value;
    if (binding.mode === 'fixed') value = bounded(binding.fixed, 0, 100, 'Dynamische Helligkeit');
    if (binding.mode === 'separate_numeric_source') {
      value = bounded(scale(device.rawBrightness, binding), 0, 100, 'Dynamische Helligkeit');
    }
    if (value == null) throw new Error('Unbekannter Helligkeitsmodus.');
    return value;
  }

function normalizedPercentage(value) {
  const boundedValue = bounded(value, 0, 100, 'Prozentwert');
  return Math.round((boundedValue + Number.EPSILON) * 1000) / 1000;
}

function calculateState(device) {
  device.calculatedPercentage = normalizedPercentage(scale(device.rawPercentage, device.bindings.percentage));
  device.calculatedColor = displayColor(device);
  device.requestedBrightness = dynamicBrightness(device);
  const input = {
    percentage: device.calculatedPercentage,
    color: device.calculatedColor,
    brightness: device.requestedBrightness,
    transitionMilliseconds: device.hardwareConfig && device.hardwareConfig.display
      ? device.hardwareConfig.display.transition_milliseconds : 250,
  };
  if (device.manifest && device.manifest.features
      && device.manifest.features.direction_indicator === true) {
    device.indicatorDirection = device.rawRising && !device.rawFalling ? 'rising'
      : device.rawFalling && !device.rawRising ? 'falling' : null;
    input.directionIndicator = {
      direction: device.indicatorDirection,
      sweep_milliseconds: device.bindings.indicator.sweep_milliseconds,
      pulse_interval_milliseconds: device.bindings.indicator.pulse_interval_milliseconds,
      dimming_percent: device.bindings.indicator.dimming_percent,
    };
  }
  return input;
}

function indicatorActive(value, label) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
  throw new Error(`${label} muss einen Booleanwert liefern.`);
}

function resetChangedIndicatorState(device, previousBindings, nextBindings) {
  const previous = previousBindings && previousBindings.indicator
    ? previousBindings.indicator : {};
  const next = nextBindings && nextBindings.indicator ? nextBindings.indicator : {};
  if (!next.rising_topic || previous.rising_topic !== next.rising_topic) {
    device.rawRising = false;
  }
  if (!next.falling_topic || previous.falling_topic !== next.falling_topic) {
    device.rawFalling = false;
  }
}

function deviceStateCatalog(device) {
  const root = `devices/${encodeURIComponent(device.deviceId)}`;
  const category = `${device.name || device.deviceId} / Status`;
  return [
    { address: `${root}/online`, name: 'Online', category },
    { address: `${root}/connection-state`, name: 'Verbindungszustand', category },
    { address: `${root}/next-reconnect`, name: 'Nächster Verbindungsversuch', category },
    { address: `${root}/rssi`, name: 'WLAN-Signal', category, unit: 'dBm' },
    { address: `${root}/percentage`, name: 'Prozentwert', category, unit: '%' },
    { address: `${root}/color`, name: 'Farbe', category },
    { address: `${root}/requested-brightness`, name: 'Angeforderte Helligkeit', category, unit: '%' },
    { address: `${root}/indicator-direction`, name: 'Richtungsindikator', category },
    { address: `${root}/output-mode`, name: 'Ausgabemodus', category },
    { address: `${root}/timeline-id`, name: 'Aktive Timeline', category },
    { address: `${root}/effective-brightness`, name: 'Effektive Helligkeit', category, unit: '%' },
    { address: `${root}/estimated-current`, name: 'Geschätzter Strom', category, unit: 'mA' },
    { address: `${root}/power-limited`, name: 'Strombegrenzung aktiv', category },
    { address: `${root}/firmware-version`, name: 'Firmwareversion', category },
    { address: `${root}/config-revision`, name: 'Konfigurationsrevision', category },
    { address: `${root}/last-error`, name: 'Letzter Fehler', category },
  ];
}

function createHdpAdapter(host, dependencies = {}) {
  const DiscoveryClass = dependencies.Discovery || Discovery;
  const ClientClass = dependencies.HdpClient || HdpClient;
  const ConnectionClass = dependencies.RuntimeConnection || RuntimeConnection;
  let config = {};
  let identity = null;
  let discovery = null;
  let stopped = true;
  let firmwarePoll = null;
  let managementBase = '';
  const devices = new Map();
  const discovered = new Map();
  const pendingFirmware = new Map();
  const releaseService = new ReleaseService();
  let persistQueue = Promise.resolve();
  let persistDirty = false;
  let persistScheduled = false;

  function publicCatalog() {
    const all = new Map();
    for (const device of discovered.values()) all.set(device.deviceId, { ...device });
    for (const device of devices.values()) all.set(device.deviceId, { ...all.get(device.deviceId), ...sanitizeDevice(device) });
    return Array.from(all.values()).map((device) => ({
      address: device.deviceId,
      name: device.name || device.hostname || device.deviceId,
      customName: '',
      type: device.deviceType || '',
      generation: device.platform || '',
      online: !!device.online,
      channels: [{
        address: 'status',
        name: device.paired ? 'Gekoppelt' : 'Discovery',
        states: device.paired ? deviceStateCatalog(device).map((state) => ({
          address: state.address, name: state.name, unit: state.unit || '',
        })) : [],
      }],
    }));
  }

  async function persistRequired() {
    const records = Array.from(devices.values()).map(sanitizeDevice);
    await host.persistStorage('hdpDevices', records);
    await host.persistStorage('deviceCatalog', publicCatalog());
  }

  function persist() {
    persistDirty = true;
    if (persistScheduled) return persistQueue;
    persistScheduled = true;
    persistQueue = persistQueue.then(async () => {
      do {
        persistDirty = false;
        await persistRequired();
      } while (persistDirty);
    }).catch((error) => {
      host.error(`HDP-Persistenz: ${error.message}`);
    }).finally(() => {
      persistScheduled = false;
      if (persistDirty) persist();
    });
    return persistQueue;
  }

  function publishCatalog() {
    host.setStates(Array.from(devices.values()).filter((d) => d.paired).flatMap(deviceStateCatalog));
  }

  function publishDevice(device) {
    const root = `devices/${encodeURIComponent(device.deviceId)}`;
    const values = [
      { address: `${root}/online`, value: !!device.online },
      { address: `${root}/connection-state`, value: device.connectionState || (device.online ? 'connected' : 'offline') },
      { address: `${root}/next-reconnect`, value: device.nextReconnectAt || '' },
      { address: `${root}/rssi`, value: device.rssi == null ? '' : device.rssi },
      { address: `${root}/percentage`, value: device.calculatedPercentage == null ? '' : device.calculatedPercentage },
      { address: `${root}/color`, value: device.calculatedColor ? `${device.calculatedColor.r},${device.calculatedColor.g},${device.calculatedColor.b}` : '' },
      { address: `${root}/requested-brightness`, value: device.requestedBrightness == null ? '' : device.requestedBrightness },
      { address: `${root}/indicator-direction`, value: device.indicatorDirection || 'off' },
      { address: `${root}/output-mode`, value: device.outputMode || '' },
      { address: `${root}/timeline-id`, value: device.activeTimelineId || '' },
      { address: `${root}/effective-brightness`, value: device.effectiveBrightness == null ? '' : device.effectiveBrightness },
      { address: `${root}/estimated-current`, value: device.estimatedCurrent == null ? '' : device.estimatedCurrent },
      { address: `${root}/power-limited`, value: device.powerLimited == null ? '' : !!device.powerLimited },
      { address: `${root}/firmware-version`, value: (device.firmwareInfo && device.firmwareInfo.version) || device.firmwareVersion || '' },
      { address: `${root}/config-revision`, value: device.configRevision == null ? '' : device.configRevision },
      { address: `${root}/last-error`, value: device.lastError || '' },
    ];
    host.publishStates(values);
  }

  function setError(device, error, context) {
    const code = error && error.code ? `[${error.code}] ` : '';
    device.lastError = `${code}${error && error.message ? error.message : String(error)}`.slice(0, 500);
    host.error(`${context || 'HDP'} ${device.deviceId}: ${device.lastError}`);
    publishDevice(device);
    persist();
  }

  function clientFor(device) {
    if (!device.client) {
      device.client = new ClientClass(device, device.bindingKey
        ? { instanceId: identity.instanceId, bindingKey: device.bindingKey } : null);
    } else {
      device.client.update(device, device.bindingKey
        ? { instanceId: identity.instanceId, bindingKey: device.bindingKey } : null);
    }
    return device.client;
  }

  function stopSubscriptions(device) {
    for (const unsubscribe of device.unsubscribers || []) {
      try { unsubscribe(); } catch (_) { /* idempotent */ }
    }
    device.unsubscribers = [];
  }

  function applyRuntime(device) {
    try {
      const state = calculateState(device);
      if (/^(Datenquelle:|Prozentquelle:|Prozentwertquelle liefert|Farbquelle:|Helligkeitsquelle:|Keine Prozentwertquelle)/.test(device.lastError || '')) {
        device.lastError = '';
      }
      if (device.runtimeProfile === RUNTIME_PROFILE) {
        const output = device.hardwareConfig && device.hardwareConfig.outputs
          && device.hardwareConfig.outputs[0];
        if (!output) throw new Error('Kein generischer HDP-Ausgang konfiguriert.');
        const pixels = renderPercentageFrame({
          pixelCount: output.pixel_count,
          percentage: state.percentage,
          color: state.color,
          brightness: state.brightness,
          fractional: device.bindings.display.fractional_pixel,
        });
        const direction = device.rawRising && !device.rawFalling ? 'rising'
          : device.rawFalling && !device.rawRising ? 'falling' : null;
        device.indicatorDirection = direction;
        device.pendingRender = { outputId: output.output_id, pixels, direction };
        if (!device.renderQueue) {
          device.renderQueue = (async () => {
            while (device.pendingRender) {
              const pending = device.pendingRender;
              device.pendingRender = null;
              if (!device.connection || !device.connection.ready || !device.outputClient) continue;
              if (pending.direction) {
                const timeline = compileIndicatorTimeline(pending.pixels, {
                  direction: pending.direction,
                  ...device.bindings.indicator,
                }, device.manifest.limits);
                const timelineId = `indicator-${timeline.sha256.slice(0, 16)}`;
                await device.outputClient.setTimeline(pending.outputId, timelineId, timeline);
              } else {
                await device.outputClient.setFrame(pending.outputId, pending.pixels);
              }
            }
          })().catch((error) => {
            device.lastError = `[${error.code || 'OUTPUT'}] ${error.message}`;
            host.error(`HDP-Output ${device.deviceId}: ${device.lastError}`);
            publishDevice(device);
          }).finally(() => {
            device.renderQueue = null;
            if (device.pendingRender) applyRuntime(device);
          });
        }
      } else if (device.legacyOutput) {
        device.legacyOutput.sendState(state);
      }
      publishDevice(device);
    } catch (err) {
      device.lastError = `Datenquelle: ${err.message}`;
      publishDevice(device);
    }
  }

  function subscribeSources(device) {
    stopSubscriptions(device);
    device.unsubscribers = [];
    if (!device.bindings.indicator.rising_topic) device.rawRising = false;
    if (!device.bindings.indicator.falling_topic) device.rawFalling = false;
    const subscribe = (topic, key, assign) => {
      if (!topic) return;
      const unsubscribe = host.subscribeState(topic, (value) => {
        try {
          assign(finite(value, key));
          applyRuntime(device);
        } catch (err) {
          device.lastError = `${key}: ${err.message}`;
          publishDevice(device);
        }
      });
      device.unsubscribers.push(unsubscribe);
    };
    subscribe(device.bindings.percentage.topic, 'Prozentquelle', (value) => { device.rawPercentage = value; });
    if (device.bindings.color.mode === 'separate_numeric_source') {
      subscribe(device.bindings.color.topic, 'Farbquelle', (value) => { device.rawColor = value; });
    }
    if (device.bindings.brightness.mode === 'separate_numeric_source') {
      subscribe(device.bindings.brightness.topic, 'Helligkeitsquelle', (value) => { device.rawBrightness = value; });
    }
    const subscribeIndicator = (topic, label, assign) => {
      if (!topic) return;
      const unsubscribe = host.subscribeState(topic, (value) => {
        try {
          assign(indicatorActive(value, label));
          applyRuntime(device);
        } catch (err) {
          device.lastError = `${label}: ${err.message}`;
          publishDevice(device);
        }
      });
      device.unsubscribers.push(unsubscribe);
    };
    subscribeIndicator(device.bindings.indicator.rising_topic, 'Rising-Indikator', (value) => { device.rawRising = value; });
    subscribeIndicator(device.bindings.indicator.falling_topic, 'Falling-Indikator', (value) => { device.rawFalling = value; });
    if (!device.bindings.percentage.topic) device.lastError = 'Keine Prozentwertquelle ausgewählt.';
  }

  function attachConnection(device) {
    if (device.connection) device.connection.stop();
    const connection = new ConnectionClass({
      device,
      credentials: { instanceId: identity.instanceId, bindingKey: device.bindingKey },
      getConfigRevision: () => device.configRevision,
      synchronizeConfig: async () => {
        const remote = await clientFor(device).config();
        device.hardwareConfig = remote;
        device.configRevision = remote.revision;
        persist();
      },
      maximumMessageBytes: device.manifest && device.manifest.limits
        && device.manifest.limits.maximum_websocket_message_bytes,
    });
    device.connection = connection;
    device.outputClient = device.runtimeProfile === RUNTIME_PROFILE
      ? new OutputClient({
        transport: connection,
        manifest: device.manifest,
        getConfig: () => device.hardwareConfig,
      }) : null;
    device.legacyOutput = device.runtimeProfile ? null : new LegacyRuntimeAdapter(connection);
    if (device.outputClient) {
      device.outputClient.on('state', (state) => {
        device.outputMode = state.mode;
        device.activeTimelineId = state.timelineId || null;
        device.activeFrameId = state.frameId || null;
        publishDevice(device);
      });
    }
    connection.on('online', () => {
      device.online = true;
      device.connectionState = 'connected';
      device.reconnectAttempt = 0;
      device.nextReconnectAt = null;
      device.lastError = '';
      device.lastConnectedAt = new Date().toISOString();
      publishDevice(device);
      persist();
      if (device.outputClient) device.outputClient.sessionStarted();
      applyRuntime(device);
    });
    connection.on('offline', () => {
      device.online = false;
      publishDevice(device);
      persist();
    });
    connection.on('connectionState', (event) => {
      device.connectionState = event.state;
      device.reconnectAttempt = event.attempt || 0;
      device.nextReconnectAt = event.nextAttemptAt || null;
      publishDevice(device);
    });
    connection.on('reconnect', (event) => {
      host.warn(`HDP ${device.deviceId}: Verbindungsversuch ${event.attempt} in ${event.delay} ms`
        + (event.error ? ` (${connectionErrorMessage(event.error)})` : ''));
    });
    connection.on('status', (status) => {
      device.rssi = status.wifi_rssi == null ? status.rssi : status.wifi_rssi;
      device.effectiveBrightness = status.effective_brightness;
      device.estimatedCurrent = status.estimated_current_milliamps;
      device.powerLimited = status.power_limit_active;
      publishDevice(device);
    });
    connection.on('applied', (status) => {
      device.effectiveBrightness = status.effective_brightness;
      device.estimatedCurrent = status.estimated_current_milliamps;
      device.powerLimited = status.power_limit_active;
      device.appliedState = status;
      publishDevice(device);
    });
    connection.on('configChanged', (payload) => {
      if (Number.isInteger(payload.config_revision)) device.configRevision = payload.config_revision;
      if (device.outputClient) device.outputClient.sessionStarted();
      applyRuntime(device);
    });
    connection.on('deviceError', (payload) => {
      const rejectedTextFrame = payload.code === 'INVALID_REQUEST'
        && /UTF-8 text messages up to 1024 bytes/i.test(payload.message || '');
      device.lastError = rejectedTextFrame
        ? '[INVALID_REQUEST] Firmware hat den normativen UTF-8-Textframe homeess.hello abgelehnt.'
        : `[${payload.code || 'WEBSOCKET'}] ${payload.message || 'Gerätefehler'}`;
      publishDevice(device);
      // Laufzeitfehler nicht alle 30 Sekunden dauerhaft in SQLite schreiben.
      host.error(`WebSocket ${device.deviceId}: ${device.lastError}`);
    });
    connection.on('warning', (err) => {
      device.lastError = err && err.code === 'HPE_INVALID_HEADER_TOKEN'
        ? '[INVALID_REQUEST] Firmware liefert ungültige HTTP-Header beim WebSocket-Upgrade.'
        : `[WEBSOCKET] ${connectionErrorMessage(err)}`;
      publishDevice(device);
      host.warn(`HDP ${device.deviceId}: ${device.lastError}`);
    });
    connection.start();
  }

  async function restoreDevice(record) {
    if (!record || !record.deviceId) return;
    if (record.lastError === 'Prozentwertquelle liefert seit mehr als fünf Minuten keinen Wert.') {
      record = { ...record, lastError: '' };
    }
    const bindingKey = await host.getSecret(`${SECRET_PREFIX}${record.deviceId}`);
    try {
      if (!bindingKey) throw new Error('Binding-Key fehlt im sicheren Store.');
      validateBindingKey(bindingKey);
    } catch (error) {
      devices.set(record.deviceId, {
        ...record, bindingState: 'disabled', paired: false, online: false,
        lastError: `Lokales Binding ist ungültig: ${error.message}`,
      });
      return;
    }
    const device = {
      ...record, bindingKey, bindings: mergeBindings(record.bindings),
      updateSettings: { ...defaultUpdateSettings(), ...(record.updateSettings || {}) },
      bindingState: record.bindingState || (record.paired ? 'active' : 'pending'),
      paired: false, online: false, unsubscribers: [],
    };
    devices.set(device.deviceId, device);
  }

  function onDiscovered(found) {
    const previous = discovered.get(found.deviceId);
    const next = {
      ...previous,
      ...found,
      runtimeProfile: found.runtimeProfile || null,
      runtimeCompatible: found.runtimeProfile ? found.runtimeCompatible === true : true,
      runtimeMismatch: found.runtimeMismatch === true,
      name: (previous && previous.name) || found.hostname || found.deviceId,
    };
    discovered.set(found.deviceId, next);
    const local = devices.get(found.deviceId);
    if (local) {
      const addressChanged = local.address !== found.address || local.wsPort !== found.wsPort;
      const runtimeChanged = local.runtimeProfile !== found.runtimeProfile;
      Object.assign(local, found, {
        runtimeProfile: found.runtimeProfile || null,
        runtimeCompatible: found.runtimeProfile ? found.runtimeCompatible === true : true,
        runtimeMismatch: found.runtimeMismatch === true,
        bindingKey: local.bindingKey,
        bindingState: local.bindingState,
        paired: local.bindingState === 'active' && local.paired,
        discoveredOnline: found.online,
        online: local.bindingState === 'active' ? local.online : found.online,
      });
      clientFor(local).update(local, {
        instanceId: identity.instanceId, bindingKey: local.bindingKey,
      });
      if (found.runtimeMismatch) {
        local.lastError = `[UNSUPPORTED_RUNTIME_PROFILE] Gerät meldet ${found.runtimeProfile}; erwartet wird ${RUNTIME_PROFILE}.`;
        if (local.connection) local.connection.stop();
        publishDevice(local);
        persist();
        return;
      }
      if (runtimeChanged && local.bindingState === 'active') {
        if (local.connection) local.connection.stop();
        local.connection = null;
        local.outputClient = null;
        local.legacyOutput = null;
        local.manifest = null;
        local.hardwareConfig = null;
        if (local.client) local.client.manifestInfo = null;
        activate(local, { bindingId: local.bindingId })
          .catch((error) => setError(local, error, 'Runtime-Profilwechsel'));
        publishDevice(local);
        persist();
        return;
      }
      if (local.connection && addressChanged) local.connection.updateDevice(local);
      reconcileBinding(local).catch((error) => setError(local, error, 'Binding-Abgleich'));
      publishDevice(local);
    }
    persist();
  }

  async function activate(device, result) {
    device.manifest = result.manifest || device.manifest || await clientFor(device).manifest();
    clientFor(device).manifestInfo = device.manifest;
    const remoteConfig = result.existingConfig || await clientFor(device).config();
    const deviceStatus = result.status || await clientFor(device).status();
    device.bindingState = 'active';
    device.adapterNonce = null;
    device.paired = true;
    device.pairingState = 'paired';
    device.bindingId = result.bindingId || bindingId(device.bindingKey);
    device.runtimeProfile = device.manifest.runtime_profile || null;
    device.legacyRuntime = !device.runtimeProfile;
    device.hardwareConfig = remoteConfig;
    device.configRevision = remoteConfig.revision;
    device.configOrigin = device.hardwareConfigPresent ? 'device' : null;
    device.lastBoot = deviceStatus.last_boot || null;
    device.recoveryRequired = !!(device.lastBoot
      && ['invalid', 'storage_unavailable'].includes(device.lastBoot.config_load_status));
    device.lastError = '';
    device.bindings = mergeBindings(device.bindings);
    device.updateSettings = { ...defaultUpdateSettings(), ...(device.updateSettings || config.globalUpdateSettings || {}) };
    await persistRequired();
    publishCatalog();
    subscribeSources(device);
    attachConnection(device);
    publishDevice(device);
  }

  async function reconcileBinding(device) {
    if (device.reconciling || !device.bindingKey || !device.discoveredOnline) return;
    device.reconciling = true;
    try {
      const status = await clientFor(device).pairingStatus(true);
      if (status.binding_status === 'match') {
        if (device.bindingState !== 'active' || !device.paired) {
          await activate(device, { bindingId: status.binding_id });
        }
      } else if (status.binding_status === 'unpaired') {
        if (device.bindingState === 'pending') {
          const result = await clientFor(device).pair({
            instanceId: identity.instanceId,
            adapterNonce: device.adapterNonce,
            bindingKey: device.bindingKey,
          });
          await activate(device, result);
        } else {
          device.bindingState = 'disabled';
          device.paired = false;
          device.lastError = 'Das Gerät ist nicht mehr gekoppelt; das lokale Binding wurde deaktiviert.';
          if (device.connection) device.connection.stop();
          await persistRequired();
        }
      } else if (status.binding_status === 'conflict') {
        device.bindingState = 'conflict';
        device.paired = false;
        device.lastError = 'Das Gerät ist mit einer anderen Instanz oder einem anderen Binding-Key gekoppelt.';
        if (device.connection) device.connection.stop();
        if (device.adapterNonce) {
          await host.deleteSecret(`${SECRET_PREFIX}${device.deviceId}`);
          device.bindingKey = null;
          device.adapterNonce = null;
        }
        await persistRequired();
      }
    } finally {
      device.reconciling = false;
    }
  }

  async function pair(deviceId) {
    validateDeviceId(deviceId);
    const found = discovered.get(deviceId);
    if (!found) throw new Error('Gerät wurde nicht per mDNS gefunden.');
    if (found.runtimeMismatch) {
      throw Object.assign(new Error(`Runtime-Profil ${found.runtimeProfile} ist inkompatibel; erwartet wird ${RUNTIME_PROFILE}.`), {
        code: 'UNSUPPORTED_RUNTIME_PROFILE', status: 426,
      });
    }
    const existing = devices.get(deviceId);
    if (found.pairingState === 'paired' && (!existing || existing.bindingState !== 'pending')) {
      throw Object.assign(new Error('Gerät ist bereits mit einer Instanz gekoppelt.'), { code: 'ALREADY_PAIRED' });
    }
    host.log(`Pairing gestartet: ${deviceId}`);
    const device = existing && existing.bindingState === 'pending' ? existing : {
      ...found, name: found.hostname || deviceId,
      bindingState: 'pending', paired: false,
      adapterNonce: createAdapterNonce(), bindingKey: createBindingKey(),
      bindings: defaultBindings(),
      updateSettings: { ...defaultUpdateSettings(), ...(config.globalUpdateSettings || {}) },
      online: !!found.online, unsubscribers: [],
    };
    await host.setSecret(`${SECRET_PREFIX}${deviceId}`, device.bindingKey);
    devices.set(deviceId, device);
    await persistRequired();
    const client = clientFor(device);
    let result;
    try {
      result = await client.pair({
        instanceId: identity.instanceId,
        adapterNonce: device.adapterNonce,
        bindingKey: device.bindingKey,
      });
    } catch (error) {
      if (error.code === 'ALREADY_PAIRED') {
        await host.deleteSecret(`${SECRET_PREFIX}${deviceId}`);
        devices.delete(deviceId);
        await persistRequired();
      }
      throw error;
    }
    device.name = (result.device && (result.device.device_name || result.device.name)) || device.name;
    await activate(device, result);
    try {
      device.firmwareInfo = await clientFor(device).firmware();
      device.firmwareStatus = await clientFor(device).firmwareStatus();
      if (device.firmwareInfo.ota_port) device.otaPort = device.firmwareInfo.ota_port;
    } catch (err) {
      device.lastError = `Firmwarestatus: ${err.message}`;
    }
    await persistRequired();
    host.log(`Pairing erfolgreich: ${deviceId}`);
    return sanitizeDevice(device);
  }

  async function saveHardwareConfig(deviceId, input) {
    const device = requirePaired(deviceId);
    const manifest = device.manifest || await clientFor(device).manifest();
    const capabilities = device.runtimeProfile === RUNTIME_PROFILE ? manifest : {
      ...(manifest.hardware_capabilities || {}),
      maximum_led_count: manifest.limits && manifest.limits.maximum_led_count,
    };
    const validated = validateHardwareConfig(input.config || input, capabilities);
    const expected = Number.isInteger(Number(input.expected_revision))
      ? Number(input.expected_revision) : Number(device.configRevision || validated.revision || 0);
    try {
      const deviceStatus = await clientFor(device).status();
      const loadStatus = deviceStatus.last_boot && deviceStatus.last_boot.config_load_status;
      if (loadStatus === 'invalid' || loadStatus === 'storage_unavailable') {
        throw Object.assign(new Error('Konfigurationsspeicher des Geräts erfordert Wiederherstellung.'), {
          code: 'CONFIG_RECOVERY_REQUIRED', status: 409,
          details: { config_load_status: loadStatus },
        });
      }
      const result = await clientFor(device).putConfig(expected, validated, capabilities);
      device.hardwareConfig = result;
      device.configRevision = result.revision == null ? expected + 1 : result.revision;
      device.name = validated.device_name || device.name;
      device.configOrigin = 'homeess';
      if (device.outputClient) device.outputClient.sessionStarted();
      persist();
      publishDevice(device);
      applyRuntime(device);
      return sanitizeDevice(device);
    } catch (err) {
      if (err.code === 'CONFIG_REVISION_CONFLICT') {
        const current = await clientFor(device).config();
        device.hardwareConfig = current.config || current;
        device.configRevision = current.revision;
        persist();
        throw Object.assign(new Error('Konfigurationsrevision wurde geändert; aktuelle Gerätekonfiguration wurde neu geladen.'), {
          code: err.code, status: 409, current: sanitizeDevice(device),
        });
      }
      throw err;
    }
  }

  function validateBindings(input) {
    const bindings = mergeBindings(input);
    if (!String(bindings.percentage.topic || '').trim()) throw new Error('Prozentwertquelle fehlt.');
    Object.assign(bindings.percentage, sourceParts(bindings.percentage.topic));
    // Bereiche früh validieren.
    scale(bindings.percentage.input_min, bindings.percentage);
    if (!['fixed', 'value_gradient', 'separate_numeric_source'].includes(bindings.color.mode)) throw new Error('Ungültiger Farbmodus.');
    if (bindings.color.mode === 'fixed') {
      bindings.color.color = require('./validation').color(bindings.color.color);
    } else {
      bindings.color.stops = colorStops(bindings.color.stops, { percentage: bindings.color.mode === 'value_gradient' });
      if (bindings.color.mode === 'separate_numeric_source' && !bindings.color.topic) throw new Error('Separate Farbquelle fehlt.');
      if (bindings.color.mode === 'separate_numeric_source') Object.assign(bindings.color, sourceParts(bindings.color.topic));
    }
    if (!['fixed', 'separate_numeric_source'].includes(bindings.brightness.mode)) throw new Error('Ungültiger Helligkeitsmodus.');
    if (bindings.brightness.mode === 'fixed') bounded(bindings.brightness.fixed, 0, 100, 'Dynamische Helligkeit');
    if (bindings.brightness.mode === 'separate_numeric_source' && !bindings.brightness.topic) throw new Error('Helligkeitsquelle fehlt.');
    if (bindings.brightness.mode === 'separate_numeric_source') Object.assign(bindings.brightness, sourceParts(bindings.brightness.topic));
    const indicator = bindings.indicator;
    indicator.rising_topic = String(indicator.rising_topic || '').trim();
    indicator.falling_topic = String(indicator.falling_topic || '').trim();
    indicator.sweep_milliseconds = require('./validation').integer(indicator.sweep_milliseconds, 100, 10000, 'Indikatorgeschwindigkeit');
    indicator.pulse_interval_milliseconds = require('./validation').integer(indicator.pulse_interval_milliseconds, 500, 60000, 'Indikatorimpulsabstand');
    indicator.dimming_percent = require('./validation').integer(indicator.dimming_percent, 1, 100, 'Indikatordimmung');
    if (indicator.pulse_interval_milliseconds < indicator.sweep_milliseconds) {
      throw new Error('Indikatorimpulsabstand darf nicht kürzer als die Indikatorgeschwindigkeit sein.');
    }
    if (indicator.rising_topic) indicator.rising_source = sourceParts(indicator.rising_topic);
    if (indicator.falling_topic) indicator.falling_source = sourceParts(indicator.falling_topic);
    if (typeof bindings.display.fractional_pixel !== 'boolean') {
      throw new Error('Anteiliger Pixel muss ein Booleanwert sein.');
    }
    return bindings;
  }

  function saveBindings(deviceId, input) {
    const device = requirePaired(deviceId);
    const previousBindings = device.bindings;
    const nextBindings = validateBindings(input.bindings || input);
    resetChangedIndicatorState(device, previousBindings, nextBindings);
    device.bindings = nextBindings;
    device.updateSettings = { ...device.updateSettings, ...(input.updateSettings || {}) };
    stopSubscriptions(device);
    subscribeSources(device);
    persist();
    applyRuntime(device);
    return sanitizeDevice(device);
  }

  async function unpair(deviceId, confirmation) {
    const device = requirePaired(deviceId);
    if (confirmation !== 'ENTKOPPELN') throw Object.assign(new Error('Bestätigung ENTKOPPELN fehlt.'), { status: 422 });
    try {
      await clientFor(device).unpair();
    } catch (error) {
      if (!error.uncertain) throw error;
      const deadline = Date.now() + 60000;
      let confirmed = false;
      while (Date.now() < deadline && !stopped) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          const status = await clientFor(device).pairingStatus(true);
          if (status.binding_status === 'unpaired') {
            confirmed = true;
            break;
          }
        } catch (_) { /* Neustart/Rediscovery läuft noch. */ }
      }
      if (!confirmed) {
        throw Object.assign(new Error('Ausgang der Entkopplung ist nicht eindeutig; der Request wurde nicht wiederholt.'), {
          code: 'DEVICE_OFFLINE', status: 504,
        });
      }
    }
    if (device.connection) device.connection.stop();
    stopSubscriptions(device);
    await host.deleteSecret(`${SECRET_PREFIX}${deviceId}`);
    pendingFirmware.delete(deviceId);
    devices.delete(deviceId);
    const found = discovered.get(deviceId);
    if (found) discovered.set(deviceId, { ...found, online: false, pairingState: 'pairable', pairable: true });
    publishCatalog();
    persist();
    host.log(`Gerät entkoppelt: ${deviceId}`);
  }

  function requirePaired(deviceId) {
    const device = devices.get(validateDeviceId(deviceId));
    if (!device || device.bindingState !== 'active' || !device.paired) {
      throw Object.assign(new Error('Aktiv gekoppeltes Gerät nicht gefunden.'), { status: 404 });
    }
    return device;
  }

  function snapshot() {
    const pairedIds = new Set(Array.from(devices.values())
      .filter((device) => device.bindingState === 'active' && device.paired)
      .map((device) => device.deviceId));
    const found = Array.from(discovered.values()).filter((d) => !pairedIds.has(d.deviceId)).map((item) => {
      const local = devices.get(item.deviceId);
      return { ...item, ...(local ? sanitizeDevice(local) : {}) };
    });
    const paired = Array.from(devices.values())
      .filter((device) => device.bindingState === 'active' && device.paired)
      .map(sanitizeDevice);
    return {
      protocolVersion: PROTOCOL_VERSION,
      discoveryRunning: !!discovery,
      found,
      paired,
      offline: paired.filter((device) => !device.online),
      errors: paired.filter((device) => device.lastError).map((device) => ({ deviceId: device.deviceId, error: device.lastError })),
    };
  }

  async function refreshFirmware(device) {
    const [info, status] = await Promise.all([clientFor(device).firmware(), clientFor(device).firmwareStatus()]);
    device.firmwareInfo = info;
    device.firmwareStatus = status;
    if (info.ota_port) device.otaPort = info.ota_port;
    persist();
    return { info, status };
  }

  async function prepareFirmware(deviceId, body) {
    const device = requirePaired(deviceId);
    const manifest = validateManifest(body.manifest || body);
    const current = await refreshFirmware(device);
    const firmwareInfo = current.info;
    if (!['idle', 'failed', 'completed'].includes(current.status.state)) {
      throw Object.assign(new Error(`Gerät ist für ein Update nicht bereit (${current.status.state}).`), { status: 423, code: 'OTA_ALREADY_RUNNING' });
    }
    const artifact = selectArtifact(manifest, firmwareInfo);
    checkCompatibility(manifest, artifact, firmwareInfo, { allowDowngrade: !!body.allowDowngrade });
    pendingFirmware.set(deviceId, { manifest, artifact, allowDowngrade: !!body.allowDowngrade });
    return { release: manifest.release, artifact, signature: artifact.signature ? 'vorhanden' : 'nicht vorhanden' };
  }

  async function upload(deviceId, uploadInfo) {
    const device = requirePaired(deviceId);
    const pending = pendingFirmware.get(deviceId);
    if (!pending) throw new Error('Firmwaremanifest muss zuerst validiert werden.');
    if (!uploadInfo || !uploadInfo.path) throw new Error('Firmwaredatei fehlt.');
    if (uploadInfo.filename && uploadInfo.filename !== pending.artifact.filename) {
      throw new Error(`Firmwaredatei muss „${pending.artifact.filename}“ heißen.`);
    }
    const fileCheck = await validateArtifactFile(uploadInfo.path, pending.artifact, {
      requireSignature: true,
      publicKey: releaseService.publicKey,
    });
    // Vorhandene Signatur ohne konfigurierten Schlüssel niemals als verifiziert
    // darstellen oder übertragen.
    if (pending.artifact.signature && !fileCheck.signature.verified) {
      throw new Error('Signatur vorhanden, aber im Adapter ist kein öffentlicher Prüfschlüssel konfiguriert.');
    }
    device.otaProgress = { state: 'uploading', progress_percent: 0 };
    const result = await uploadFirmware({
      file: uploadInfo.path,
      device,
      firmwareInfo: device.firmwareInfo,
      manifest: pending.manifest,
      artifact: pending.artifact,
      credentials: { instanceId: identity.instanceId, bindingKey: device.bindingKey },
      allowDowngrade: pending.allowDowngrade,
      onProgress(progress) {
        device.otaProgress = { state: 'uploading', progress_percent: progress.percent,
          received_bytes: progress.sent, total_bytes: progress.total };
      },
    });
    device.otaProgress = { state: 'ready_to_restart', progress_percent: 100 };
    device.firmwareStatus = await clientFor(device).firmwareStatus();
    if (device.firmwareStatus.state !== 'ready_to_restart'
        || device.firmwareStatus.restart_required !== true) {
      throw Object.assign(new Error('Gerät bestätigt nach dem Upload keinen restartbereiten OTA-Zustand.'), {
        code: 'OTA_FINALIZE_FAILED', status: 502,
      });
    }
    persist();
    return { result, fileCheck, status: device.firmwareStatus };
  }

  async function restartFirmware(deviceId) {
    const device = requirePaired(deviceId);
    if (!device.firmwareStatus || device.firmwareStatus.state !== 'ready_to_restart') {
      device.firmwareStatus = await clientFor(device).firmwareStatus();
    }
    if (device.firmwareStatus.state !== 'ready_to_restart') throw Object.assign(new Error('Firmware ist nicht zum Neustart bereit.'), { status: 409 });
    const target = pendingFirmware.get(deviceId);
    try {
      await clientFor(device).restartFirmware();
    } catch (error) {
      if (!error.uncertain) throw error;
      host.warn(`HDP ${device.deviceId}: OTA-Neustartantwort verloren; es wird ausschließlich rediscovered und verifiziert.`);
    }
    device.online = false;
    device.otaProgress = { state: 'restarting', progress_percent: 100 };
    publishDevice(device);
    // Post-Boot-Prüfung erfolgt begrenzt und ausschließlich lokal.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !stopped) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const current = await refreshFirmware(device);
        if (target && current.info.version === target.manifest.release.version
            && current.status.state === 'completed') {
          device.otaProgress = { state: 'completed', progress_percent: 100 };
          pendingFirmware.delete(deviceId);
          persist();
          return current;
        }
      } catch (_) { /* Gerät startet noch */ }
    }
    throw new Error('Gerät wurde nach dem Firmwareupdate nicht erfolgreich verifiziert.');
  }

  function deviceFromForm(body, existing) {
    if (existing.runtimeProfile === RUNTIME_PROFILE) {
      return validateHardwareConfig({
        revision: number(body.revision, existing.configRevision || 0),
        device_type: existing.hardwareConfig.device_type || 'percentage_indicator',
        outputs: [{
          output_id: (existing.hardwareConfig.outputs[0] && existing.hardwareConfig.outputs[0].output_id) || 'main',
          output_type: 'argb_strip',
          pin: number(body.argb_pin, 2),
          pixel_count: number(body.led_count, 10),
          driver: body.led_type || 'WS2812',
          color_order: body.color_order || 'GRB',
          reverse: bool(body.reverse),
          maximum_brightness_percent: number(body.maximum_brightness_percent, 35),
          maximum_current_milliamps: number(body.maximum_current_milliamps, 500),
          current_per_pixel_milliamps: number(body.current_per_led_milliamps, 60),
          offline_mode: body.offline_mode || 'retain_last_frame',
        }],
      }, existing.manifest);
    }
    return validateHardwareConfig({
      revision: number(body.revision, existing.configRevision || 0),
      device_type: 'percentage_indicator',
      device_name: String(body.device_name || existing.name || '').slice(0, 100),
      hardware: {
        argb_pin: number(body.argb_pin, 2),
        led_count: number(body.led_count, 10),
        led_type: body.led_type || 'WS2812',
        color_order: body.color_order || 'GRB',
        reverse: bool(body.reverse),
      },
      display: {
        fractional_led: bool(body.fractional_led),
        inactive_led_mode: 'off',
        transition_milliseconds: number(body.transition_milliseconds, 250),
      },
      power: {
        maximum_brightness_percent: number(body.maximum_brightness_percent, 35),
        maximum_current_milliamps: number(body.maximum_current_milliamps, 500),
        current_per_led_milliamps: number(body.current_per_led_milliamps, 60),
      },
      offline: { mode: body.offline_mode || 'retain_last_state' },
    });
  }

  function bindingsFromForm(body) {
    return validateBindings({
      percentage: {
        topic: String(body.percentage_topic || '').trim(),
        input_min: number(body.percentage_input_min, 0), input_max: number(body.percentage_input_max, 100),
        output_min: number(body.percentage_output_min, 0), output_max: number(body.percentage_output_max, 100),
        clamp: bool(body.percentage_clamp), invert: bool(body.percentage_invert),
      },
      color: {
        mode: body.color_mode || 'fixed',
        topic: String(body.color_topic || '').trim(),
        color: { r: number(body.color_r, 0), g: number(body.color_g, 255), b: number(body.color_b, 0) },
        stops: JSON.parse(body.color_stops || '[]'),
      },
      brightness: {
        mode: body.brightness_mode || 'fixed', fixed: number(body.brightness_fixed, 100),
        topic: String(body.brightness_topic || '').trim(),
        input_min: number(body.brightness_input_min, 0), input_max: number(body.brightness_input_max, 100),
        output_min: number(body.brightness_output_min, 0), output_max: number(body.brightness_output_max, 100),
        clamp: bool(body.brightness_clamp), invert: bool(body.brightness_invert),
      },
      indicator: {
        rising_topic: String(body.indicator_rising_topic || '').trim(),
        falling_topic: String(body.indicator_falling_topic || '').trim(),
        sweep_milliseconds: number(body.indicator_sweep_milliseconds, 600),
        pulse_interval_milliseconds: number(body.indicator_pulse_interval_milliseconds, 4000),
        dimming_percent: number(body.indicator_dimming_percent, 40),
      },
      display: { fractional_pixel: bool(body.fractional_led) },
    });
  }

  function gpioOptions(device, selected) {
    const pins = device.manifest && device.manifest.hardware_capabilities
      && device.manifest.hardware_capabilities.argb_pins;
    return (Array.isArray(pins) ? pins : []).map((pin) =>
      `<option value="${pin}"${Number(selected) === Number(pin) ? ' selected' : ''}>GPIO ${pin}</option>`).join('');
  }

  function renderOverview() {
    const state = snapshot();
    const found = state.found;
    const paired = state.paired.filter((d) => d.online);
    const offline = state.paired.filter((d) => !d.online);
    const card = (device, pairedDevice = false) => `<div class="settings-card" style="margin-bottom:12px;">
      <div class="settings-card-head"><h3>${esc(device.name || device.hostname || device.deviceId)}</h3>
        <span class="status-badge ${device.online ? 'status-ok' : 'status-off'}">${device.online ? 'Online' : 'Offline'}</span></div>
      <p><code>${esc(device.deviceId)}</code> · ${esc(device.address || device.hostname || '—')}:${esc(device.apiPort || '')}</p>
      <p class="muted">Firmware ${esc(device.firmwareVersion || (device.firmwareInfo && device.firmwareInfo.version) || '—')} ·
        ${esc(device.platform || '—')} / ${esc(device.board || '—')} · HDP ${esc(device.protocolVersion || '—')} ·
        Runtime ${esc(device.runtimeProfile || 'Legacy')} · ${esc(device.deviceType || 'nicht konfiguriert')}</p>
      ${device.hardwareConfigPresent || device.hardwareConfig ? '<p>Hardwarekonfiguration vorhanden</p>' : ''}
      ${pairedDevice ? `<p class="muted">Verbindung: ${esc(device.connectionState || (device.online ? 'connected' : 'offline'))}
        · Versuch ${esc(device.reconnectAttempt || 0)} · nächster Versuch ${esc(device.nextReconnectAt || '—')}</p>` : ''}
      ${device.configOrigin === 'device' ? '<p class="status-text success">Vorhandene Hardwarekonfiguration vom Gerät übernommen</p>' : ''}
      ${device.lastError ? `<p class="error-text">${esc(device.lastError)}</p>` : ''}
      <div class="button-row">
        ${pairedDevice ? `<a class="module-toggle-btn" href="/adapter/instance/INSTANCE/manage/device/${encodeURIComponent(device.deviceId)}">Konfigurieren</a>` :
          device.runtimeMismatch ? '<span class="error-text">Inkompatibles Runtime-Profil</span>' :
          device.pairingState === 'paired'
            ? '<span class="muted">Bereits mit einer anderen homeESS-Instanz gekoppelt</span>'
            : `<form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/pair"><button>Koppeln</button></form>`}
      </div></div>`;
    const section = (title, rows, isPaired) => `<section><h2>${title}</h2>${rows.length
      ? rows.map((d) => card(d, isPaired)).join('')
      : '<p class="muted">Keine Geräte in diesem Bereich.</p>'}</section>`;
    return `<h1>HDP Kopplung &amp; Verwaltung</h1>
      <div class="settings-card"><div class="settings-card-head"><h2>Adapterstatus</h2></div>
        <p>Discovery: ${state.discoveryRunning ? 'aktiv' : 'inaktiv'} · gefunden: ${found.length} · gekoppelt: ${state.paired.length}</p>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/discovery/refresh"><button>Geräte suchen</button></form>
      </div>
      ${section('Gefundene Geräte', found, false)}
      ${section('Gekoppelte Geräte', paired, true)}
      ${section('Nicht erreichbare Geräte', offline, true)}`;
  }

  function renderDevicePage(device) {
    const hw = device.hardwareConfig || {};
    const genericOutput = Array.isArray(hw.outputs) ? hw.outputs[0] : null;
    const hardware = genericOutput ? {
      argb_pin: genericOutput.pin, led_count: genericOutput.pixel_count,
      led_type: genericOutput.driver, color_order: genericOutput.color_order,
      reverse: genericOutput.reverse,
    } : (hw.hardware || {});
    const display = genericOutput ? {
      fractional_led: device.bindings.display.fractional_pixel,
      transition_milliseconds: 0,
    } : (hw.display || {});
    const power = genericOutput ? {
      maximum_brightness_percent: genericOutput.maximum_brightness_percent,
      maximum_current_milliamps: genericOutput.maximum_current_milliamps,
      current_per_led_milliamps: genericOutput.current_per_pixel_milliamps,
    } : (hw.power || {});
    const offline = genericOutput ? { mode: genericOutput.offline_mode } : (hw.offline || {});
    const binding = device.bindings;
    const firmware = device.firmwareInfo || {};
    const firmwareStatus = device.firmwareStatus || {};
    const maximumLedCount = device.manifest && device.manifest.limits
      ? device.manifest.limits.maximum_led_count : 300;
    const colorOrders = device.manifest && device.manifest.hardware_capabilities
      && Array.isArray(device.manifest.hardware_capabilities.color_orders)
      ? device.manifest.hardware_capabilities.color_orders.filter((value) => ['RGB', 'GRB'].includes(value))
      : ['RGB', 'GRB'];
    const offlineModes = device.runtimeProfile === RUNTIME_PROFILE
      ? [
        ['retain_last_frame', 'Letztes Bild beibehalten'],
        ['clear', 'Anzeige ausschalten'],
        ['continue_timeline', 'Animation fortsetzen'],
      ]
      : [
        ['retain_last_state', 'Letzten Zustand beibehalten'],
        ['turn_off', 'Anzeige ausschalten'],
        ['show_offline_pattern', 'Offline-Muster anzeigen'],
      ];
    const runtimeDescription = device.runtimeProfile === RUNTIME_PROFILE
      ? 'Generischer Pixel-Ausgang'
      : 'Legacy-Ausgabe';
    return `<div class="hdp-device-page">
      <div class="hdp-device-head">
        <div>
          <a class="hdp-back-link" href="/adapter/instance/INSTANCE/manage">← HDP Kopplung &amp; Verwaltung</a>
          <h1>${esc(device.name || device.deviceId)}</h1>
          <p class="hdp-device-meta"><code>${esc(device.deviceId)}</code><span>${esc(runtimeDescription)}</span><span>Revision ${esc(device.configRevision)}</span></p>
        </div>
        <button type="button" class="button-secondary hdp-hardware-open" onclick="hdpOpenHardware()">Hardware einrichten</button>
      </div>
      ${device.lastError ? `<p class="error-text">${esc(device.lastError)}</p>` : ''}
      ${device.recoveryRequired ? `<p class="error-text">Recovery erforderlich: ${esc(device.lastBoot.config_load_status)} · ${esc(device.lastBoot.config_load_diagnostic || '')}. Automatische Konfigurationsschreibvorgänge sind gesperrt.</p>` : ''}
      <section class="settings-card hdp-status-card">
        <div class="settings-card-head hdp-card-head">
          <div><h2>Gerätestatus</h2><p class="settings-card-hint">${esc(device.address || 'Keine Netzwerkadresse')} · zuletzt verbunden ${esc(device.lastConnectedAt || '—')}</p></div>
          <span class="status-badge ${device.online ? 'status-ok' : 'status-off'}">${device.online ? 'Online' : 'Offline'}</span>
        </div>
        <dl class="hdp-status-grid">
          <div><dt>Verbindung</dt><dd>${esc(device.connectionState || (device.online ? 'Verbunden' : 'Offline'))}</dd><small>Versuch ${esc(device.reconnectAttempt || 0)} · nächster ${esc(device.nextReconnectAt || '—')}</small></div>
          <div><dt>WLAN</dt><dd>${esc(device.rssi == null ? '—' : `${device.rssi} dBm`)}</dd><small>HDP ${esc(device.protocolVersion || '—')}</small></div>
          <div><dt>Anzeigewert</dt><dd>${esc(device.calculatedPercentage == null ? '—' : `${device.calculatedPercentage} %`)}</dd><small>Farbe ${esc(device.calculatedColor ? JSON.stringify(device.calculatedColor) : '—')}</small></div>
          <div><dt>Helligkeit</dt><dd>${esc(device.effectiveBrightness == null ? '—' : `${device.effectiveBrightness} %`)}</dd><small>angefordert ${esc(device.requestedBrightness == null ? '—' : `${device.requestedBrightness} %`)}</small></div>
          <div><dt>Strom</dt><dd>${esc(device.estimatedCurrent == null ? '—' : `${device.estimatedCurrent} mA`)}</dd><small>Begrenzung ${device.powerLimited == null ? 'unbekannt' : device.powerLimited ? 'aktiv' : 'inaktiv'}</small></div>
        </dl>
        ${device.runtimeProfile === RUNTIME_PROFILE
          ? `<p class="hdp-runtime-line">Output ${esc(device.outputMode || '—')} · Frame ${esc(device.activeFrameId || '—')} · Timeline ${esc(device.activeTimelineId || '—')}</p>`
          : ''}
      </section>

      <form class="hdp-settings-form" method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/bindings">
        <section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">01 · Wert</span><h2>Anzeigewert und Skalierung</h2><p class="settings-card-hint">Legt fest, welcher homeESS-State als Prozentwert dargestellt und wie er auf die Anzeige abgebildet wird.</p></div>
          <div class="hdp-form-grid">
            <div class="field hdp-span-full"><label>Anzeigewert</label><input data-state-picker name="percentage_topic" value="${esc(binding.percentage.topic)}" placeholder="State auswählen"></div>
            <fieldset class="hdp-range-field"><legend>Eingangsbereich</legend><label>Minimum<input type="number" step="any" name="percentage_input_min" value="${esc(binding.percentage.input_min)}"></label><label>Maximum<input type="number" step="any" name="percentage_input_max" value="${esc(binding.percentage.input_max)}"></label></fieldset>
            <fieldset class="hdp-range-field"><legend>Ausgabebereich</legend><label>Minimum<input type="number" step="any" name="percentage_output_min" value="${esc(binding.percentage.output_min)}"></label><label>Maximum<input type="number" step="any" name="percentage_output_max" value="${esc(binding.percentage.output_max)}"></label></fieldset>
          </div>
          <div class="hdp-toggle-row">
            <label><input type="checkbox" name="percentage_clamp"${binding.percentage.clamp !== false ? ' checked' : ''}> Auf den Wertebereich begrenzen</label>
            <label><input type="checkbox" name="percentage_invert"${binding.percentage.invert ? ' checked' : ''}> Darstellung invertieren</label>
            ${device.runtimeProfile === RUNTIME_PROFILE ? `<label><input type="checkbox" name="fractional_led"${binding.display.fractional_pixel !== false ? ' checked' : ''}> Letzten Pixel anteilig darstellen</label>` : ''}
          </div>
        </section>

        <section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">02 · Farbe</span><h2>Farbdarstellung</h2><p class="settings-card-hint">Eine feste Farbe, ein wertabhängiger Verlauf oder eine eigene Zahlenquelle steuert die Anzeige.</p></div>
          <div class="hdp-form-grid">
            <div class="field"><label>Farbmodus</label><select id="hdp-color-mode" name="color_mode">
              <option value="fixed"${binding.color.mode === 'fixed' ? ' selected' : ''}>Feste Farbe</option>
              <option value="value_gradient"${binding.color.mode === 'value_gradient' ? ' selected' : ''}>Farbverlauf nach Wert</option>
              <option value="separate_numeric_source"${binding.color.mode === 'separate_numeric_source' ? ' selected' : ''}>Separate Zahlenquelle</option>
            </select></div>
            <div class="field hdp-color-field" data-hdp-color-panel="fixed"><label>Feste Farbe (RGB)</label><div class="hdp-rgb-row">
              <span id="hdp-color-preview" class="hdp-color-preview" aria-hidden="true"></span>
              <label>R<input type="number" name="color_r" min="0" max="255" value="${esc(binding.color.color.r)}"></label>
              <label>G<input type="number" name="color_g" min="0" max="255" value="${esc(binding.color.color.g)}"></label>
              <label>B<input type="number" name="color_b" min="0" max="255" value="${esc(binding.color.color.b)}"></label>
            </div></div>
            <div class="field hdp-span-full" data-hdp-color-panel="separate_numeric_source"><label>Separate Farbquelle</label><input data-state-picker name="color_topic" value="${esc(binding.color.topic)}" placeholder="State auswählen"></div>
            <div class="field hdp-span-full" data-hdp-color-panel="value_gradient"><label>Farbstützpunkte (JSON)</label><textarea name="color_stops" rows="7" spellcheck="false">${json(binding.color.stops)}</textarea><p class="settings-card-hint">Stützpunkte ordnen Prozentwerten RGB-Farben zu.</p></div>
          </div>
        </section>

        <section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">03 · Helligkeit</span><h2>Dynamische Helligkeit</h2><p class="settings-card-hint">Die Hardwaregrenze bleibt davon unberührt und wird ausschließlich im Hardwaredialog festgelegt.</p></div>
          <div class="hdp-form-grid">
            <div class="field"><label>Helligkeitsmodus</label><select id="hdp-brightness-mode" name="brightness_mode">
              <option value="fixed"${binding.brightness.mode === 'fixed' ? ' selected' : ''}>Fester Wert</option>
              <option value="separate_numeric_source"${binding.brightness.mode !== 'fixed' ? ' selected' : ''}>Separate Zahlenquelle</option>
            </select></div>
            <div class="field" data-hdp-brightness-panel="fixed"><label>Feste Helligkeit (%)</label><input type="number" min="0" max="100" name="brightness_fixed" value="${esc(binding.brightness.fixed)}"></div>
            <div class="field hdp-span-full" data-hdp-brightness-panel="separate_numeric_source"><label>Helligkeitsquelle</label><input data-state-picker name="brightness_topic" value="${esc(binding.brightness.topic)}" placeholder="State auswählen"></div>
            <fieldset class="hdp-range-field" data-hdp-brightness-panel="separate_numeric_source"><legend>Eingangsbereich</legend><label>Minimum<input type="number" step="any" name="brightness_input_min" value="${esc(binding.brightness.input_min)}"></label><label>Maximum<input type="number" step="any" name="brightness_input_max" value="${esc(binding.brightness.input_max)}"></label></fieldset>
            <fieldset class="hdp-range-field" data-hdp-brightness-panel="separate_numeric_source"><legend>Ausgabebereich</legend><label>Minimum<input type="number" step="any" name="brightness_output_min" value="${esc(binding.brightness.output_min)}"></label><label>Maximum<input type="number" step="any" name="brightness_output_max" value="${esc(binding.brightness.output_max)}"></label></fieldset>
          </div>
          <div class="hdp-toggle-row" data-hdp-brightness-panel="separate_numeric_source">
            <label><input type="checkbox" name="brightness_clamp"${binding.brightness.clamp !== false ? ' checked' : ''}> Auf den Wertebereich begrenzen</label>
            <label><input type="checkbox" name="brightness_invert"${binding.brightness.invert ? ' checked' : ''}> Helligkeit invertieren</label>
          </div>
        </section>

        <section class="settings-card hdp-config-card">
          <div class="settings-card-head hdp-card-head"><div><span class="hdp-section-kicker">04 · Bewegung</span><h2>Richtungsindikator</h2><p class="settings-card-hint">Optionale Boolean-States lassen einen Schatten in die jeweilige Richtung durch die Anzeige laufen.</p></div>
            <span class="hdp-capability-badge">${device.runtimeProfile === RUNTIME_PROFILE
              ? 'Als Pixel-Timeline'
              : device.manifest && device.manifest.features && device.manifest.features.direction_indicator === true
                ? 'Unterstützt' : 'Nicht unterstützt'}</span>
          </div>
          <div class="hdp-form-grid">
            <div class="field"><label>Aufwärts-Bewegung</label><input data-state-picker name="indicator_rising_topic" value="${esc(binding.indicator.rising_topic)}" placeholder="Optionalen Boolean-State auswählen"><p class="settings-card-hint">Schatten läuft von unten nach oben.</p></div>
            <div class="field"><label>Abwärts-Bewegung</label><input data-state-picker name="indicator_falling_topic" value="${esc(binding.indicator.falling_topic)}" placeholder="Optionalen Boolean-State auswählen"><p class="settings-card-hint">Schatten läuft von oben nach unten.</p></div>
            <div class="field"><label>Durchlaufzeit (ms)</label><input type="number" min="100" max="10000" name="indicator_sweep_milliseconds" value="${esc(binding.indicator.sweep_milliseconds)}"></div>
            <div class="field"><label>Impulsabstand (ms)</label><input type="number" min="500" max="60000" name="indicator_pulse_interval_milliseconds" value="${esc(binding.indicator.pulse_interval_milliseconds)}"></div>
            <div class="field"><label>Schatten-Dimmung (%)</label><input type="number" min="1" max="100" name="indicator_dimming_percent" value="${esc(binding.indicator.dimming_percent)}"></div>
          </div>
        </section>

        <section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">05 · Updates</span><h2>Update-Automatik</h2><p class="settings-card-hint">Steuert, ob und wann neue Firmware für dieses Gerät berücksichtigt wird.</p></div>
          <div class="hdp-form-grid">
            <div class="field"><label>Updatepolitik</label><select name="update_mode">
              <option value="manual"${device.updateSettings.mode === 'manual' ? ' selected' : ''}>Manuell</option>
              <option value="notify_only"${device.updateSettings.mode === 'notify_only' ? ' selected' : ''}>Nur benachrichtigen</option>
              <option value="automatic"${device.updateSettings.mode === 'automatic' ? ' selected' : ''}>Automatisch installieren</option>
            </select></div>
            <div class="field"><label>Release-Kanal</label><select name="update_channel">
              <option value="stable"${device.updateSettings.channel === 'stable' ? ' selected' : ''}>Stabil</option>
              <option value="beta"${device.updateSettings.channel === 'beta' ? ' selected' : ''}>Beta</option>
              <option value="development"${device.updateSettings.channel === 'development' ? ' selected' : ''}>Entwicklung</option>
            </select></div>
            <div class="field"><label>Wiederholungsversuche</label><input type="number" min="0" max="10" name="update_retry_count" value="${esc(device.updateSettings.retry_count)}"></div>
            <fieldset class="hdp-time-field"><legend>Wartungsfenster</legend><label>Von<input type="time" name="maintenance_start" value="${esc(device.updateSettings.maintenance_window.start)}"></label><label>Bis<input type="time" name="maintenance_end" value="${esc(device.updateSettings.maintenance_window.end)}"></label></fieldset>
          </div>
          <div class="hdp-toggle-row">
            <label><input type="checkbox" name="update_when_online"${device.updateSettings.update_when_device_returns_online ? ' checked' : ''}> Update nach späterer Wiederkehr nachholen</label>
            <label><input type="checkbox" name="maintenance_enabled"${device.updateSettings.maintenance_window.enabled ? ' checked' : ''}> Wartungsfenster verwenden</label>
          </div>
        </section>

        <div class="hdp-save-bar"><p>Wertzuordnung, Darstellung und Update-Automatik werden ausschließlich in homeESS gespeichert.</p><button>Geräteeinstellungen speichern</button></div>
      </form>

      <section class="settings-card hdp-firmware-card"><div class="settings-card-head"><span class="hdp-section-kicker">Wartung</span><h2>Firmware manuell aktualisieren</h2><p class="settings-card-hint">Manifest und Firmware werden lokal geprüft, bevor homeESS sie an das Gerät überträgt.</p></div>
        <div class="hdp-firmware-summary">
        <p>${esc(firmware.name || '—')} ${esc(firmware.version || '—')} · ${esc(firmware.channel || '—')} · ${esc(firmware.platform || device.platform || '—')}/${esc(firmware.board || device.board || '—')}/${esc(firmware.variant || device.variant || '—')}</p>
        <p>Build ${esc(firmware.build_id || '—')} · ${esc(firmware.build_timestamp || '—')} · OTA ${firmware.ota_supported ? 'unterstützt' : 'nicht unterstützt'} ·
          frei/max ${esc(firmware.free_update_space_bytes || '—')} / ${esc(firmware.maximum_image_size_bytes || '—')} Byte · Signatur ${esc(firmware.signature_verification || '—')}</p>
        <p>Status: ${esc(firmwareStatus.state || '—')} · Fortschritt ${esc(firmwareStatus.progress_percent || 0)} % · ${esc(firmwareStatus.last_error || '')}</p>
        </div>
        <div class="hdp-form-grid">
          <div class="field"><label>Release-Manifest (.json)</label><input type="file" id="firmware-manifest" accept=".json,application/json"></div>
          <div class="field"><label>Firmwareartefakt (.bin)</label><input type="file" id="firmware-bin" accept=".bin,application/octet-stream"></div>
        </div>
        <div class="button-row"><button type="button" onclick="hdpUploadFirmware('${esc(device.deviceId)}')">Update prüfen und übertragen</button>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/firmware/restart" style="display:inline;"><button>Geprüfte Firmware neu starten</button></form>
        </div>
        <pre id="firmware-result"></pre>
      </section>
      <section class="settings-card hdp-danger-card"><div class="settings-card-head"><h2>Gerät entkoppeln</h2></div>
        <p class="error-text">Das Gerät löscht seine WLAN-Zugangsdaten und startet anschließend im Accesspoint-Modus. Hardwarekonfiguration und Gerätetyp bleiben erhalten.</p>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/unpair" onsubmit="return confirm('Gerät wirklich entkoppeln und WLAN-Zugang löschen?');">
          <input type="hidden" name="confirmation" value="ENTKOPPELN"><button class="button-danger">Gerät entkoppeln</button>
        </form>
      </section>

      <dialog id="hdp-hardware-dialog" class="value-dialog hdp-hardware-dialog">
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/config" class="dialog-form">
          <input type="hidden" name="revision" value="${esc(device.configRevision || 0)}">
          <div class="dialog-hero"><h3>Hardware einrichten</h3><p class="muted">Diese Werte werden üblicherweise nur bei der Ersteinrichtung geändert und direkt auf dem Gerät gespeichert.</p></div>
          <section class="dialog-section"><div class="dialog-section-head"><h4>Gerät</h4></div><div class="dialog-grid dialog-grid--two">
            <label class="field-block">Gerätename<input name="device_name" value="${esc(hw.device_name || device.name || '')}"></label>
            <label class="field-block">Gerätetyp<input value="Prozentanzeige" disabled></label>
          </div></section>
          <section class="dialog-section"><div class="dialog-section-head"><h4>LED-Ausgang</h4></div><div class="dialog-grid dialog-grid--three">
            <label class="field-block">GPIO<select name="argb_pin">${gpioOptions(device, hardware.argb_pin == null ? 2 : hardware.argb_pin)}</select><span class="form-hint muted">Aus dem Gerätemanifest</span></label>
            <label class="field-block">LED-Anzahl<input type="number" name="led_count" min="1" max="${esc(maximumLedCount)}" value="${esc(hardware.led_count || 10)}"></label>
            <label class="field-block">LED-Typ<select name="led_type"><option>WS2812</option></select></label>
            <label class="field-block">Farbreihenfolge<select name="color_order">${colorOrders.map((v) => `<option${hardware.color_order === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="field-block">Inaktive LEDs<select name="inactive_led_mode"><option value="off">Aus</option></select></label>
            ${device.runtimeProfile === RUNTIME_PROFILE ? '' : `<label class="field-block">Übergangszeit (ms)<input type="number" min="0" name="transition_milliseconds" value="${esc(display.transition_milliseconds == null ? 250 : display.transition_milliseconds)}"></label>`}
          </div><div class="hdp-toggle-row hdp-dialog-toggles">
            <label><input type="checkbox" name="reverse"${hardware.reverse ? ' checked' : ''}> Laufrichtung umkehren</label>
            ${device.runtimeProfile === RUNTIME_PROFILE ? '' : `<label><input type="checkbox" name="fractional_led"${display.fractional_led !== false ? ' checked' : ''}> Anteilige letzte LED</label>`}
          </div></section>
          <section class="dialog-section"><div class="dialog-section-head"><h4>Schutz und Offline-Verhalten</h4></div><div class="dialog-grid dialog-grid--two">
            <label class="field-block">Hardware-Maximalhelligkeit (%)<input type="number" min="0" max="100" name="maximum_brightness_percent" value="${esc(power.maximum_brightness_percent == null ? 35 : power.maximum_brightness_percent)}"></label>
            <label class="field-block">Maximalstrom (mA)<input type="number" min="1" name="maximum_current_milliamps" value="${esc(power.maximum_current_milliamps || 500)}"></label>
            <label class="field-block">Strom je LED (mA)<input type="number" min="1" name="current_per_led_milliamps" value="${esc(power.current_per_led_milliamps || 60)}"></label>
            <label class="field-block">Bei Verbindungsverlust<select name="offline_mode">${offlineModes.map(([value, label]) => `<option value="${value}"${offline.mode === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
          </div></section>
          <div class="button-row hdp-dialog-actions"><button type="button" class="button-secondary" onclick="this.closest('dialog').close()">Abbrechen</button><button>Hardware auf Gerät speichern</button></div>
        </form>
      </dialog>
    </div>`;
  }

  function page(body, title = 'HDP Kopplung & Verwaltung') {
    const replaced = String(body).replaceAll('/adapter/instance/INSTANCE/manage', managementBase);
    return {
      status: 200,
      view: { title, body: replaced, script: `
        function hdpOpenHardware() {
          var dialog = document.getElementById('hdp-hardware-dialog');
          if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
        }
        function hdpBindMode(selectId, panelAttribute) {
          var select = document.getElementById(selectId);
          if (!select) return;
          function sync() {
            document.querySelectorAll('[' + panelAttribute + ']').forEach(function(panel) {
              panel.hidden = panel.getAttribute(panelAttribute) !== select.value;
            });
          }
          select.addEventListener('change', sync);
          sync();
        }
        function hdpUpdateColorPreview() {
          var preview = document.getElementById('hdp-color-preview');
          if (!preview) return;
          var channels = ['color_r', 'color_g', 'color_b'].map(function(name) {
            var field = document.querySelector('[name="' + name + '"]');
            return Math.max(0, Math.min(255, Number(field && field.value) || 0));
          });
          preview.style.backgroundColor = 'rgb(' + channels.join(',') + ')';
        }
        hdpBindMode('hdp-color-mode', 'data-hdp-color-panel');
        hdpBindMode('hdp-brightness-mode', 'data-hdp-brightness-panel');
        ['color_r', 'color_g', 'color_b'].forEach(function(name) {
          var field = document.querySelector('[name="' + name + '"]');
          if (field) field.addEventListener('input', hdpUpdateColorPreview);
        });
        hdpUpdateColorPreview();
        async function hdpUploadFirmware(deviceId) {
          var out = document.getElementById('firmware-result');
          var manifestFile = document.getElementById('firmware-manifest').files[0];
          var bin = document.getElementById('firmware-bin').files[0];
          if (!manifestFile || !bin) { out.textContent = 'Manifest und BIN-Datei auswählen.'; return; }
          try {
            out.textContent = 'Manifest wird geprüft…';
            var manifest = JSON.parse(await manifestFile.text());
            var base = location.pathname.replace(/\\/device\\/[^/]+$/, '');
            var prepare = await fetch(base + '/api/devices/' + encodeURIComponent(deviceId) + '/firmware/prepare', {
              method: 'POST', headers: {'Content-Type':'application/json','Accept':'application/json'},
              body: JSON.stringify({manifest:manifest})
            });
            var prepared = await prepare.json();
            if (!prepare.ok) throw new Error(prepared.error || 'Manifestprüfung fehlgeschlagen');
            out.textContent = 'Artefakt wird lokal geprüft…';
            var statusUrl = base + '/api/devices/' + encodeURIComponent(deviceId) + '/firmware/status';
            var poll = setInterval(function () {
              fetch(statusUrl, {headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(s){
                if (s && s.state && s.state !== 'idle') out.textContent =
                  'Gerät: ' + s.state + ' · ' + (s.progress_percent || 0) + ' % · ' +
                  (s.received_bytes || 0) + '/' + (s.total_bytes || 0) + ' Byte';
              }).catch(function(){});
            }, 2000);
            var result = await new Promise(function(resolve, reject) {
              var xhr = new XMLHttpRequest();
              xhr.open('POST', base + '/api/devices/' + encodeURIComponent(deviceId) + '/firmware/upload');
              xhr.setRequestHeader('Content-Type', 'application/octet-stream');
              xhr.setRequestHeader('Accept', 'application/json');
              xhr.setRequestHeader('X-Upload-Filename', bin.name);
              xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) out.textContent = 'Browser → homeESS: ' + Math.floor(e.loaded * 100 / e.total) + ' %';
              };
              xhr.onload = function() {
                var value = {}; try { value = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
                if (xhr.status >= 200 && xhr.status < 300) resolve(value);
                else reject(new Error(value.error || 'Upload fehlgeschlagen'));
              };
              xhr.onerror = function(){ reject(new Error('Uploadverbindung abgebrochen')); };
              xhr.send(bin);
            }).finally(function(){ clearInterval(poll); });
            out.textContent = JSON.stringify(result, null, 2);
            setTimeout(function(){ location.reload(); }, 1000);
          } catch (err) { out.textContent = err.message; }
        }` },
    };
  }

  function responseError(err) {
    return {
      status: Number(err && err.status) || 422,
      json: { error: err && err.message ? err.message : String(err), code: err && err.code, details: err && err.details },
    };
  }

  async function handleManagementRequest(request) {
    try {
      managementBase = String(request.basePath || managementBase || '');
      const method = String(request.method || 'GET').toUpperCase();
      const path = String(request.path || '/').replace(/\/+$/, '') || '/';
      const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
      if (method !== 'GET' && !(request.access && request.access.canWrite)) {
        return { status: 403, json: { error: 'Schreibberechtigung erforderlich.' } };
      }
      if (method === 'GET' && path === '/') return page(renderOverview());
      if (method === 'GET' && parts[0] === 'device' && parts[1]) {
        const device = requirePaired(parts[1]);
        return page(renderDevicePage(device), `${device.name || device.deviceId} – HDP`);
      }
      if (method === 'GET' && path === '/api/status') return { status: 200, json: snapshot() };
      if (method === 'POST' && path === '/api/discovery/refresh') {
        discovery.refresh();
        return { status: 303, redirect: managementBase };
      }
      if (parts[0] !== 'api' || parts[1] !== 'devices' || !parts[2]) return { status: 404, json: { error: 'Unbekannter HDP-Endpunkt.' } };
      const id = parts[2];
      const action = parts.slice(3).join('/');
      if (method === 'POST' && action === 'pair') {
        await pair(id);
        return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if (method === 'GET' && !action) return { status: 200, json: sanitizeDevice(requirePaired(id)) };
      if (method === 'GET' && action === 'config') return { status: 200, json: await clientFor(requirePaired(id)).config() };
      if (method === 'POST' && action === 'config') {
        const device = requirePaired(id);
        await saveHardwareConfig(id, { expected_revision: request.body.revision, config: deviceFromForm(request.body, device) });
        return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if (method === 'PUT' && action === 'config') return { status: 200, json: await saveHardwareConfig(id, request.body) };
      if ((method === 'POST' || method === 'PUT') && action === 'bindings') {
        const input = method === 'POST' ? bindingsFromForm(request.body) : request.body;
        const updateSettings = method === 'POST' ? {
          mode: ['manual','notify_only','automatic'].includes(request.body.update_mode) ? request.body.update_mode : 'manual',
          channel: ['stable','beta','development'].includes(request.body.update_channel) ? request.body.update_channel : 'stable',
          retry_count: Math.max(0, Math.min(10, Math.round(number(request.body.update_retry_count, 2)))),
          update_when_device_returns_online: bool(request.body.update_when_online),
          maintenance_window: {
            enabled: bool(request.body.maintenance_enabled),
            start: String(request.body.maintenance_start || '02:00'),
            end: String(request.body.maintenance_end || '04:00'),
          },
        } : request.body.updateSettings;
        saveBindings(id, { bindings: input.bindings || input, updateSettings });
        if (method === 'POST') return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
        return { status: 200, json: sanitizeDevice(requirePaired(id)) };
      }
      if (method === 'POST' && action === 'test-state') {
        const device = requirePaired(id);
        const payload = runtimePayload(request.body);
        if (device.runtimeProfile === RUNTIME_PROFILE) {
          const output = device.hardwareConfig && device.hardwareConfig.outputs
            && device.hardwareConfig.outputs[0];
          if (!output || !device.outputClient || !device.connection || !device.connection.ready) {
            throw Object.assign(new Error('Generischer HDP-Ausgang ist nicht verbunden.'), {
              code: 'DEVICE_OFFLINE', status: 503,
            });
          }
          const pixels = renderPercentageFrame({
            pixelCount: output.pixel_count,
            percentage: payload.percentage_value,
            color: payload.display_color,
            brightness: payload.dynamic_brightness,
            fractional: device.bindings.display.fractional_pixel,
          });
          await device.outputClient.setFrame(output.output_id, pixels, { force: true });
          return { status: 202, json: { accepted: true, output_id: output.output_id } };
        }
        if (request.body.direction_indicator != null
            && !(device.manifest && device.manifest.features
              && device.manifest.features.direction_indicator === true)) {
          throw Object.assign(new Error('Gerätefirmware unterstützt den Richtungsindikator nicht.'), {
            code: 'UNSUPPORTED_PROTOCOL_VERSION', status: 422,
          });
        }
        if (device.legacyOutput) {
          device.legacyOutput.sendState({
            percentage: payload.percentage_value,
            color: payload.display_color,
            brightness: payload.dynamic_brightness,
            transitionMilliseconds: payload.transition_milliseconds,
            directionIndicator: payload.direction_indicator,
          }, true);
        }
        return { status: 202, json: { accepted: true, payload } };
      }
      if (method === 'POST' && action === 'unpair') {
        await unpair(id, request.body.confirmation);
        return { status: 303, redirect: managementBase };
      }
      if (method === 'GET' && action === 'firmware') return { status: 200, json: (await refreshFirmware(requirePaired(id))).info };
      if (method === 'GET' && action === 'firmware/status') return { status: 200, json: (await refreshFirmware(requirePaired(id))).status };
      if (method === 'POST' && action === 'firmware/prepare') return { status: 200, json: await prepareFirmware(id, request.body) };
      if (method === 'POST' && action === 'firmware/upload') return { status: 200, json: await upload(id, request.upload) };
      if (method === 'POST' && action === 'firmware/restart') {
        const result = await restartFirmware(id);
        return request.body && Object.keys(request.body).length
          ? { status: 200, json: result }
          : { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      return { status: 404, json: { error: 'Unbekannter HDP-Endpunkt.' } };
    } catch (err) {
      return responseError(err);
    }
  }

  return {
    async start(nextConfig) {
      config = nextConfig || {};
      stopped = false;
      identity = await host.getInstanceIdentity();
      config.globalUpdateSettings = {
        ...defaultUpdateSettings(),
        mode: ['manual','notify_only','automatic'].includes(config.updateMode) ? config.updateMode : 'manual',
        channel: ['stable','beta','development'].includes(config.updateChannel) ? config.updateChannel : 'stable',
      };
      releaseService.source = String(config.releaseSource || '');
      if (String(config.firmwarePublicKey || '').trim()) {
        releaseService.publicKey = crypto.createPublicKey({
          key: Buffer.from(String(config.firmwarePublicKey).trim(), 'base64'),
          format: 'der',
          type: 'spki',
        });
        if (releaseService.publicKey.asymmetricKeyType !== 'ed25519') {
          throw new Error('Firmware-Prüfschlüssel ist kein Ed25519-Schlüssel.');
        }
      }
      for (const record of Array.isArray(config.hdpDevices) ? config.hdpDevices : []) {
        await restoreDevice(record);
      }
      publishCatalog();
      discovery = new DiscoveryClass({
        intervalMs: Math.max(5, number(config.discoveryIntervalSeconds, 30)) * 1000,
        offlineAfterMs: Math.max(15, number(config.offlineAfterSeconds, 90)) * 1000,
      });
      discovery.on('found', onDiscovered);
      discovery.on('updated', onDiscovered);
      discovery.on('lost', onDiscovered);
      discovery.on('warning', (err) => host.warn(`mDNS: ${err.message}`));
      discovery.start();
      firmwarePoll = setInterval(() => {
        for (const device of devices.values()) {
          if (device.online) refreshFirmware(device).catch((err) => {
            device.lastError = `Firmwarestatus: ${err.message}`;
            publishDevice(device);
          });
        }
      }, 5 * 60 * 1000);
      host.setConnected(true, 'HDP-Discovery aktiv');
      persist();
      host.log(`HDP Adapter gestartet (${identity.instanceId}).`);
    },

    stop() {
      stopped = true;
      if (discovery) discovery.stop();
      discovery = null;
      if (firmwarePoll) clearInterval(firmwarePoll);
      firmwarePoll = null;
      for (const device of devices.values()) {
        if (device.connection) device.connection.stop();
        stopSubscriptions(device);
      }
      host.setConnected(false, 'HDP Adapter gestoppt');
    },

    handleManagementRequest,
  };
}

module.exports = createHdpAdapter;
module.exports._test = {
  defaultBindings, defaultUpdateSettings, mergeBindings, sanitizeDevice,
  sourceParts, displayColor, dynamicBrightness, normalizedPercentage,
  calculateState, indicatorActive, deviceStateCatalog,
  resetChangedIndicatorState,
};
