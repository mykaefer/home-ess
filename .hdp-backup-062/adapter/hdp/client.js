'use strict';

const http = require('http');
const {
  bindingHeaders, bindingId, validateBindingId, validateNonce, validateBindingKey,
} = require('./auth');
const {
  PROTOCOL_VERSION, RUNTIME_PROFILE, supportedRuntimeProfile,
  validateDeviceId, validateInstanceId, validateProtocol, validateHardwareConfig,
  parseSemVer,
} = require('./validation');

const JSON_REQUEST_LIMIT = 3072;
// Optionale Pineigenschaften aus dem Manifest. Sie sperren keinen GPIO, sondern
// beschreiben, worauf beim Verdrahten zu achten ist.
const BINARY_PIN_TRAIT_KEYS = Object.freeze([
  'binary_pullup_pins', 'binary_boot_sensitive_pins', 'binary_serial_pins',
]);
const JSON_RESPONSE_LIMIT = 128 * 1024;
const GET_RETRY_DELAYS = [250, 500, 1000];
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'ENDPOINT_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_PROTOCOL_VERSION', 'UNSUPPORTED_RUNTIME_PROFILE', 'AUTH_REQUIRED',
  'INCOMPLETE_BINDING_CREDENTIALS', 'ALREADY_PAIRED', 'PAIRING_IN_PROGRESS',
  'PAIRING_SESSION_EXPIRED', 'INVALID_BINDING_KEY', 'NOT_PAIRED', 'INVALID_CONFIGURATION',
  'CONFIG_REVISION_CONFLICT', 'CONFIG_RECOVERY_REQUIRED', 'OUTPUT_NOT_FOUND',
  'OUTPUT_CONFIG_REVISION_MISMATCH', 'INVALID_OUTPUT_STATE', 'OUTPUT_BASE_FRAME_REQUIRED',
  'OUTPUT_RATE_LIMITED', 'OUTPUT_BUSY', 'TIMELINE_UPLOAD_IN_PROGRESS', 'TIMELINE_NOT_FOUND',
  'TIMELINE_OFFSET_MISMATCH', 'TIMELINE_SIZE_MISMATCH', 'TIMELINE_CHECKSUM_MISMATCH',
  'TIMELINE_INVALID_PROGRAM', 'TIMELINE_CAPACITY_EXCEEDED', 'UNSUPPORTED_MESSAGE_TYPE',
  'SEQUENCE_ERROR', 'SESSION_HELLO_TIMEOUT', 'HEARTBEAT_TIMEOUT', 'SESSION_REPLACED', 'DEVICE_BUSY',
  'BINARY_PIN_NOT_FOUND', 'BINARY_PIN_DIRECTION_MISMATCH',
  'BINARY_CONFIG_REVISION_MISMATCH',
  'FACTORY_RESET_NOT_ALLOWED', 'INTERNAL_ERROR', 'OTA_AUTH_REQUIRED', 'OTA_ALREADY_RUNNING',
  'OTA_INVALID_METADATA', 'OTA_FIRMWARE_NAME_MISMATCH', 'OTA_PLATFORM_MISMATCH',
  'OTA_BOARD_MISMATCH', 'OTA_VARIANT_MISMATCH', 'OTA_PROTOCOL_INCOMPATIBLE',
  'OTA_CONFIG_SCHEMA_INCOMPATIBLE', 'OTA_DOWNGRADE_NOT_ALLOWED', 'OTA_IMAGE_TOO_LARGE',
  'OTA_INSUFFICIENT_SPACE', 'OTA_TRANSFER_FAILED', 'OTA_SIZE_MISMATCH',
  'OTA_CHECKSUM_MISMATCH', 'OTA_SIGNATURE_INVALID', 'OTA_WRITE_FAILED',
  'OTA_FINALIZE_FAILED', 'OTA_RESTART_NOT_READY', 'OTA_BOOT_VALIDATION_FAILED',
]);

class HdpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HdpError';
    this.code = options.code || 'INTERNAL_ERROR';
    this.status = options.status || 500;
    this.details = options.details || {};
    this.uncertain = options.uncertain === true;
    if (options.cause) this.cause = options.cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function unwrap(payload) {
  if (!object(payload) || typeof payload.ok !== 'boolean') {
    throw new HdpError('Ungültiges hDP-Antwort-Envelope.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (payload.ok === true) {
    if (!object(payload.data)) {
      throw new HdpError('hDP-Erfolgsantwort enthält kein Datenobjekt.', { code: 'INVALID_REQUEST', status: 502 });
    }
    return payload.data;
  }
  if (!object(payload.error) || typeof payload.error.code !== 'string'
      || typeof payload.error.message !== 'string' || !object(payload.error.details)) {
    throw new HdpError('Ungültiges hDP-Fehler-Envelope.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (!ERROR_CODES.has(payload.error.code)) {
    throw new HdpError('hDP-Gerät meldet einen unbekannten Fehlercode.', {
      code: 'INVALID_REQUEST', status: 502,
    });
  }
  throw new HdpError(payload.error.message, {
    code: payload.error.code, details: payload.error.details,
  });
}

function requestJson(base, path, options = {}) {
  const url = new URL(path, base);
  if (url.search) return Promise.reject(new HdpError('hDP erlaubt keine Query-Parameter.', { code: 'INVALID_REQUEST' }));
  if (options.body != null && !object(options.body)) {
    return Promise.reject(new HdpError('hDP-JSON-Request benötigt ein Objekt als Wurzel.', {
      code: 'INVALID_REQUEST', status: 400,
    }));
  }
  const body = options.body == null ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  if (body && body.length > JSON_REQUEST_LIMIT) {
    return Promise.reject(new HdpError('hDP-JSON-Request ist größer als 3072 Bytes.', {
      code: 'PAYLOAD_TOO_LARGE', status: 413,
    }));
  }
  const headers = {
    Accept: 'application/json',
    Connection: 'close',
    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
    ...(options.headers || {}),
  };
  return new Promise((resolve, reject) => {
    let completed = false;
    const req = http.request(url, {
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 5000,
      agent: false,
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > JSON_RESPONSE_LIMIT) {
          req.destroy(new HdpError('hDP-Antwort ist zu groß.', { code: 'INVALID_REQUEST', status: 502 }));
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        completed = true;
        const contentType = String(res.headers['content-type'] || '').toLowerCase().trim();
        const cacheControl = String(res.headers['cache-control'] || '').toLowerCase()
          .split(',').map((part) => part.trim());
        if (contentType !== 'application/json' || !cacheControl.includes('no-store')) {
          reject(new HdpError('hDP-JSON-Antwort verletzt Content-Type oder Cache-Control.', {
            code: 'INVALID_REQUEST', status: 502,
          }));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(text); } catch (cause) {
          reject(new HdpError(`Ungültige JSON-Antwort (HTTP ${res.statusCode}).`, {
            code: 'INVALID_REQUEST', status: 502, cause,
          }));
          return;
        }
        try {
          const data = unwrap(payload);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new HdpError(`Fehlerstatus HTTP ${res.statusCode} mit Erfolgs-Envelope.`, {
              code: 'INVALID_REQUEST', status: 502,
            }));
          } else resolve(data);
        } catch (error) {
          if (error instanceof HdpError && res.statusCode >= 400) error.status = res.statusCode;
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new HdpError('hDP-Gerät antwortet nicht.', {
      code: 'DEVICE_OFFLINE', status: 504, uncertain: body !== null,
    })));
    req.on('error', (cause) => {
      if (cause instanceof HdpError) reject(cause);
      else reject(new HdpError('hDP-Gerät antwortet nicht.', {
        code: 'DEVICE_OFFLINE', status: 502, uncertain: body !== null && !completed, cause,
      }));
    });
    req.on('socket', (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => req.destroy(new HdpError('hDP-Verbindungsaufbau überschreitet 2000 ms.', {
        code: 'DEVICE_OFFLINE', status: 504, uncertain: body !== null,
      })), options.connectTimeoutMs || 2000);
      socket.once('connect', () => clearTimeout(timer));
      req.once('close', () => clearTimeout(timer));
    });
    req.end(body || undefined);
  });
}

function sameConfig(left, right) {
  const withoutRevision = (input) => {
    if (!object(input)) return input;
    const { revision, ...rest } = input;
    return rest;
  };
  return JSON.stringify(withoutRevision(left)) === JSON.stringify(withoutRevision(right));
}

function validatePairingStatus(data) {
  if (!object(data)
      || !['pairable', 'pairing', 'paired'].includes(data.pairing_state)
      || typeof data.paired !== 'boolean'
      || !['unpaired', 'not_checked', 'match', 'conflict'].includes(data.binding_status)
      || ![true, false, null].includes(data.paired_to_requester)) {
    throw new HdpError('Ungültiger Pairing-Status.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (data.binding_id !== null) validateBindingId(data.binding_id);
  if (data.paired !== (data.pairing_state === 'paired')
      || (data.paired && data.binding_id === null)
      || (!data.paired && data.binding_id !== null)
      || (data.binding_status === 'match' && data.paired_to_requester !== true)
      || (['conflict', 'unpaired'].includes(data.binding_status) && data.paired_to_requester === true)
      || (data.binding_status === 'not_checked' && data.paired_to_requester !== null)) {
    throw new HdpError('Pairing-Status verletzt hDP-Invarianten.', { code: 'INVALID_REQUEST', status: 502 });
  }
  return data;
}

function validateDeviceInfo(data) {
  if (!object(data)) throw new HdpError('Ungültige Geräteinformationen.', { code: 'INVALID_REQUEST', status: 502 });
  validateDeviceId(data.device_id);
  validateProtocol(data.protocol_version);
  if (data.runtime_profile != null && !supportedRuntimeProfile(data.runtime_profile)) {
    throw new HdpError('Gerät verwendet ein inkompatibles Runtime-Profil.', {
      code: 'UNSUPPORTED_RUNTIME_PROFILE', status: 426,
    });
  }
  parseSemVer(data.firmware_version);
  if (typeof data.model !== 'string' || !data.model
      || typeof data.platform !== 'string' || !data.platform
      || !['pairable', 'pairing', 'paired'].includes(data.pairing_state)
      || typeof data.paired !== 'boolean'
      || data.paired !== (data.pairing_state === 'paired')
      || typeof data.hardware_config_present !== 'boolean'
      || !Number.isInteger(data.hardware_config_revision)
      || data.hardware_config_revision < 0 || data.hardware_config_revision > 0xffffffff) {
    throw new HdpError('Geräteinformationen verletzen hDP-Invarianten.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (data.paired) validateBindingId(data.binding_id);
  else if (data.binding_id !== null) throw new HdpError('Ungekoppeltes Gerät meldet eine Binding-ID.', { code: 'INVALID_REQUEST', status: 502 });
  if (data.configured_device_type !== null
      && (typeof data.configured_device_type !== 'string'
        || !/^[a-z0-9._-]{1,32}$/.test(data.configured_device_type))) {
    throw new HdpError('Ungültiger konfigurierter Gerätetyp.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (!data.hardware_config_present
      && (data.configured_device_type !== null || data.hardware_config_revision !== 0)) {
    throw new HdpError('Gerät meldet widersprüchliche Hardwarekonfigurationsdaten.', { code: 'INVALID_REQUEST', status: 502 });
  }
  return data;
}

function validateManifestInfo(data) {
  if (object(data) && data.runtime_profile != null) {
    const limitNames = [
      'maximum_json_body_bytes', 'maximum_websocket_message_bytes', 'maximum_outputs',
      'maximum_led_count', 'minimum_frame_interval_milliseconds', 'maximum_timeline_bytes',
      'maximum_timeline_events', 'maximum_timeline_chunk_bytes',
      'maximum_timeline_duration_milliseconds',
    ];
    if (data.protocol_version !== PROTOCOL_VERSION || data.api_version !== 'v1'
        || data.auth_profile !== 'local-binding-key-v1'
        || !supportedRuntimeProfile(data.runtime_profile)
        || !['opaque-id-v1', 'boot-dispatch-v1'].includes(data.device_type_profile)
        || !Array.isArray(data.output_types) || !data.output_types.includes('argb_strip')
        || !Array.isArray(data.frame_encodings)
        || !data.frame_encodings.includes('rgb8-base64')
        || !data.frame_encodings.includes('pixel-list-v1')
        || !Array.isArray(data.timeline_encodings)
        || !data.timeline_encodings.includes('hdtl-delta-v1')
        || !object(data.features) || !object(data.hardware_capabilities) || !object(data.limits)
        || ['mdns', 'websocket', 'ota', 'frame_output', 'timeline_output', 'timeline_loop']
          .some((key) => typeof data.features[key] !== 'boolean')
        || !Array.isArray(data.hardware_capabilities.argb_pins)
        || !Array.isArray(data.hardware_capabilities.led_types)
        || !Array.isArray(data.hardware_capabilities.color_orders)
        || limitNames.some((key) => !Number.isInteger(data.limits[key]) || data.limits[key] < 1)
        || data.limits.maximum_json_body_bytes !== 3072
        || data.limits.maximum_websocket_message_bytes < 1
        || data.limits.maximum_websocket_message_bytes > 65535
        || data.limits.maximum_outputs > 255
        || data.limits.maximum_led_count > 65535
        || data.limits.minimum_frame_interval_milliseconds > 60000
        || data.limits.maximum_timeline_bytes > 0xffffffff
        || data.limits.maximum_timeline_events > 65535
        || data.limits.maximum_timeline_chunk_bytes > data.limits.maximum_timeline_bytes
        || data.limits.maximum_timeline_duration_milliseconds > 86400000) {
      throw new HdpError('Gerätemanifest entspricht nicht pixel-timeline-v1.', {
        code: !supportedRuntimeProfile(data.runtime_profile)
          ? 'UNSUPPORTED_RUNTIME_PROFILE' : 'INVALID_REQUEST', status: 426,
      });
    }
    for (const pin of data.hardware_capabilities.argb_pins) {
      if (!Number.isInteger(pin) || pin < 0 || pin > 255) throw new HdpError('Manifest enthält ungültige ARGB-Pins.', { code: 'INVALID_REQUEST', status: 502 });
    }
    if (data.hardware_capabilities.led_types.some((value) => value !== 'WS2812')
        || data.hardware_capabilities.color_orders.some((value) => !['RGB', 'GRB'].includes(value))) {
      throw new HdpError('Manifest enthält nicht unterstützte Hardwarefähigkeiten.', { code: 'INVALID_REQUEST', status: 502 });
    }
    if (data.device_type_profile === 'boot-dispatch-v1') {
      if (!Array.isArray(data.device_types)
          || !data.device_types.includes('percentage_indicator')
          || !data.device_types.includes('binary_io')
          || typeof data.features.binary_input !== 'boolean'
          || typeof data.features.binary_output !== 'boolean'
          || !Array.isArray(data.hardware_capabilities.binary_pins)
          || !Array.isArray(data.hardware_capabilities.binary_input_types)
          || !data.hardware_capabilities.binary_input_types.includes('switch')
          || !data.hardware_capabilities.binary_input_types.includes('button')
          || !Number.isInteger(data.limits.maximum_binary_pins)
          || data.limits.maximum_binary_pins < 1 || data.limits.maximum_binary_pins > 32
          || !Number.isInteger(data.limits.binary_input_debounce_milliseconds)
          || data.limits.binary_input_debounce_milliseconds < 1
          || data.limits.binary_input_debounce_milliseconds > 1000) {
        throw new HdpError('Gerätemanifest enthält keinen vollständigen Binary-I/O-Vertrag.', {
          code: 'INVALID_REQUEST', status: 502,
        });
      }
      if (data.device_types.includes('sensors')
          && (data.features.sensor_reading !== true
            || !Array.isArray(data.hardware_capabilities.sensor_types)
            || !data.hardware_capabilities.sensor_types.length
            || !Number.isInteger(data.limits.maximum_sensors)
            || data.limits.maximum_sensors < 1 || data.limits.maximum_sensors > 32
            || !Number.isInteger(data.limits.minimum_sensor_interval_milliseconds)
            || data.limits.minimum_sensor_interval_milliseconds < 1)) {
        throw new HdpError('Gerätemanifest enthält keinen vollständigen Sensorvertrag.', {
          code: 'INVALID_REQUEST', status: 502,
        });
      }
      const binaryPins = data.hardware_capabilities.binary_pins;
      if (!binaryPins.length || binaryPins.length > data.limits.maximum_binary_pins
          || new Set(binaryPins).size !== binaryPins.length
          || binaryPins.some((pin) => !Number.isInteger(pin) || pin < 0 || pin > 255)) {
        throw new HdpError('Manifest enthält ungültige Binary-I/O-GPIOs.', {
          code: 'INVALID_REQUEST', status: 502,
        });
      }
      // Optionale Pineigenschaften. Firmware 0.4.0 meldet sie noch nicht; wo sie
      // vorhanden sind, müssen es eindeutige Teilmengen von binary_pins sein.
      for (const key of BINARY_PIN_TRAIT_KEYS) {
        const trait = data.hardware_capabilities[key];
        if (trait === undefined) continue;
        if (!Array.isArray(trait) || new Set(trait).size !== trait.length
            || trait.some((pin) => !binaryPins.includes(pin))) {
          throw new HdpError(`Manifest enthält ungültige ${key}.`, {
            code: 'INVALID_REQUEST', status: 502,
          });
        }
      }
    } else if (data.runtime_profile !== RUNTIME_PROFILE) {
      throw new HdpError('Altes Gerätemanifest ist nur mit pixel-timeline-v1 zulässig.', {
        code: 'UNSUPPORTED_RUNTIME_PROFILE', status: 426,
      });
    }
    return data;
  }
  // Vorübergehender, vollständig gekapselter Legacy-Vertrag für bereits
  // gekoppelte Produktivgeräte ohne runtime_profile.
  if (!object(data) || data.protocol_version !== PROTOCOL_VERSION || data.api_version !== 'v1'
      || data.auth_profile !== 'local-binding-key-v1'
      || !Array.isArray(data.device_types) || !data.device_types.includes('percentage_indicator')
      || !Array.isArray(data.inputs)
      || !object(data.features) || !object(data.hardware_capabilities) || !object(data.limits)
      || !Array.isArray(data.hardware_capabilities.argb_pins)
      || !Array.isArray(data.hardware_capabilities.led_types)
      || !Array.isArray(data.hardware_capabilities.color_orders)
      || data.limits.maximum_json_body_bytes !== 3072
      || data.limits.maximum_websocket_message_bytes !== 1024
      || !Number.isInteger(data.limits.maximum_led_count)
      || data.limits.maximum_led_count < 1 || data.limits.maximum_led_count > 300) {
    throw new HdpError('Gerätemanifest entspricht nicht hDP 1.0-draft.', {
      code: 'UNSUPPORTED_PROTOCOL_VERSION', status: 426,
    });
  }
  const requiredInputs = ['percentage_value', 'display_color', 'dynamic_brightness', 'transition_milliseconds'];
  if (requiredInputs.some((value) => !data.inputs.includes(value))
      || ['mdns', 'websocket', 'ota'].some((key) => typeof data.features[key] !== 'boolean')
      || (Object.prototype.hasOwnProperty.call(data.features, 'direction_indicator')
        && typeof data.features.direction_indicator !== 'boolean')
      || ((data.features.direction_indicator === true) !== data.inputs.includes('direction_indicator'))) {
    throw new HdpError('Manifest enthält nicht alle normativen Eingänge oder Feature-Flags.', { code: 'INVALID_REQUEST', status: 502 });
  }
  for (const pin of data.hardware_capabilities.argb_pins) {
    if (!Number.isInteger(pin) || pin < 0 || pin > 255) throw new HdpError('Manifest enthält ungültige ARGB-Pins.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (data.hardware_capabilities.led_types.some((value) => value !== 'WS2812')
      || data.hardware_capabilities.color_orders.some((value) => !['RGB', 'GRB'].includes(value))) {
    throw new HdpError('Manifest enthält nicht unterstützte LED-Fähigkeiten.', { code: 'INVALID_REQUEST', status: 502 });
  }
  return data;
}

function validateStatusInfo(data) {
  const states = ['access_point', 'pairable', 'pairing', 'paired', 'connected', 'offline', 'recovery_portal', 'updating', 'error'];
  const loadStates = ['ok', 'recovered', 'uninitialized', 'invalid', 'storage_unavailable'];
  if (!object(data) || !states.includes(data.state)
      || !Number.isInteger(data.uptime_seconds) || data.uptime_seconds < 0 || data.uptime_seconds > 0xffffffff
      || !Number.isInteger(data.free_heap_bytes) || data.free_heap_bytes < 0 || data.free_heap_bytes > 0xffffffff
      || typeof data.wifi_connected !== 'boolean' || typeof data.paired !== 'boolean'
      || !object(data.last_boot) || !loadStates.includes(data.last_boot.config_load_status)) {
    throw new HdpError('Ungültiger hDP-Gerätestatus.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if ((data.wifi_connected && (typeof data.ip_address !== 'string' || !Number.isInteger(data.wifi_rssi_dbm)))
      || (!data.wifi_connected && (data.ip_address !== null || data.wifi_rssi_dbm !== null))
      || !Number.isInteger(data.last_boot.storage_generation)
      || data.last_boot.storage_generation < 0 || data.last_boot.storage_generation > 0xffffffff
      || !['primary', 'temporary', 'backup', 'defaults', null].includes(data.last_boot.config_load_source)
      || !['power_on', 'external_reset', 'software_restart', 'watchdog', 'exception', 'brownout', 'deep_sleep', 'unknown']
        .includes(data.last_boot.reset_reason)) {
    throw new HdpError('Gerätestatus verletzt hDP-Invarianten.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if ((data.wifi_rssi_dbm !== null && (data.wifi_rssi_dbm < -0x80000000 || data.wifi_rssi_dbm > 0x7fffffff))
      || ![null, 'string'].includes(data.last_boot.reset_detail === null ? null : typeof data.last_boot.reset_detail)
      || ![null, 'string'].includes(data.last_boot.config_load_diagnostic === null
        ? null : typeof data.last_boot.config_load_diagnostic)) {
    throw new HdpError('Gerätestatus enthält ungültige Diagnosefelder.', { code: 'INVALID_REQUEST', status: 502 });
  }
  return data;
}

function validateFirmwareInfo(data) {
  if (!object(data)) throw new HdpError('Ungültige Firmwaremetadaten.', { code: 'INVALID_REQUEST', status: 502 });
  parseSemVer(data.version);
  if (typeof data.name !== 'string' || !data.name
      || !['stable', 'beta', 'development'].includes(data.channel)
      || typeof data.platform !== 'string' || !data.platform
      || typeof data.board !== 'string' || !data.board
      || typeof data.variant !== 'string' || !data.variant
      || typeof data.build_id !== 'string' || !data.build_id
      || typeof data.build_timestamp !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(data.build_timestamp)
      || data.protocol_version !== PROTOCOL_VERSION
      || !Number.isInteger(data.config_schema_version) || data.config_schema_version < 0 || data.config_schema_version > 65535
      || typeof data.ota_supported !== 'boolean'
      || !Number.isInteger(data.ota_port) || data.ota_port < 1 || data.ota_port > 65535
      || !Number.isInteger(data.maximum_image_size_bytes) || data.maximum_image_size_bytes < 1
      || data.maximum_image_size_bytes > 0xffffffff
      || !Number.isInteger(data.free_update_space_bytes) || data.free_update_space_bytes < 0
      || data.free_update_space_bytes > 0xffffffff
      || !['enabled', 'not_configured', 'unsupported'].includes(data.signature_verification)) {
    throw new HdpError('Firmwaremetadaten entsprechen nicht hDP 1.0-draft.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (data.signature_verification === 'enabled') {
    if (data.signature_algorithm !== 'ed25519-sha256'
        || typeof data.signature_key_id !== 'string' || !data.signature_key_id) {
      throw new HdpError('Firmware-Signaturprofil ist unvollständig.', { code: 'INVALID_REQUEST', status: 502 });
    }
  } else if (data.signature_algorithm !== null || data.signature_key_id !== null) {
    throw new HdpError('Inaktives Firmware-Signaturprofil enthält Schlüsselmetadaten.', { code: 'INVALID_REQUEST', status: 502 });
  }
  return data;
}

function validateFirmwareStatus(data) {
  const states = ['idle', 'preparing', 'receiving', 'verifying', 'ready_to_restart', 'restarting', 'completed', 'failed'];
  if (!object(data) || !states.includes(data.state)
      || !Number.isInteger(data.received_bytes) || data.received_bytes < 0
      || data.received_bytes > 0xffffffff
      || !Number.isInteger(data.total_bytes) || data.total_bytes < 0 || data.total_bytes > 0xffffffff
      || !Number.isInteger(data.progress_percent) || data.progress_percent < 0 || data.progress_percent > 100
      || typeof data.restart_required !== 'boolean'
      || data.restart_required !== ['ready_to_restart', 'restarting'].includes(data.state)
      || ![null, 'signature_verified', 'signature_not_configured', 'signature_invalid'].includes(data.signature_status)
      || (data.state === 'failed' ? !object(data.last_error) : data.last_error !== null)) {
    throw new HdpError('Ungültiger OTA-Status.', { code: 'INVALID_REQUEST', status: 502 });
  }
  if (data.target_version !== null) parseSemVer(data.target_version);
  if (data.state === 'failed'
      && (typeof data.last_error.code !== 'string' || typeof data.last_error.message !== 'string')) {
    throw new HdpError('OTA-Fehlerstatus ist unvollständig.', { code: 'INVALID_REQUEST', status: 502 });
  }
  return data;
}

class HdpClient {
  constructor(device, credentials = null, options = {}) {
    this.random = options.random || Math.random;
    this.update(device, credentials);
  }

  update(device, credentials = this.credentials) {
    this.device = { ...device };
    const host = this.device.address || this.device.hostname;
    this.base = `http://${host}:${this.device.apiPort}/api/v1/`;
    this.credentials = credentials;
  }

  async request(path, options = {}) {
    const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
    const relative = `/api/v1/${cleanPath}`;
    const headers = options.auth && this.credentials ? bindingHeaders(this.credentials) : {};
    const request = () => requestJson(this.base, relative, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });
    if (options.retryGet !== true || (options.method && options.method !== 'GET')) return request();
    let last;
    for (let attempt = 0; attempt <= GET_RETRY_DELAYS.length; attempt += 1) {
      try { return await request(); } catch (error) {
        last = error;
        if (error.status >= 400 && error.status < 500) throw error;
        if (attempt === GET_RETRY_DELAYS.length) break;
        await sleep(GET_RETRY_DELAYS[attempt] + Math.floor(this.random() * 101));
      }
    }
    throw last;
  }

  deviceInfo() {
    return this.request('device', { retryGet: true, timeoutMs: 5000 }).then(validateDeviceInfo);
  }
  manifest() {
    return this.request('manifest', { retryGet: true, timeoutMs: 5000 }).then(validateManifestInfo)
      .then((manifest) => {
        this.manifestInfo = manifest;
        return manifest;
      });
  }
  status() {
    return this.request('status', { retryGet: true, timeoutMs: 5000 }).then(validateStatusInfo);
  }
  config() {
    return this.request('config', {
      auth: !!this.credentials, retryGet: true, timeoutMs: 10000,
    }).then((data) => validateHardwareConfig(data, this.manifestInfo || {}));
  }
  firmware() {
    return this.request('firmware', { retryGet: true, timeoutMs: 5000 }).then(validateFirmwareInfo);
  }
  firmwareStatus() {
    return this.request('firmware/status', { retryGet: true, timeoutMs: 5000 }).then(validateFirmwareStatus);
  }
  pairingStatus(withCredentials = !!this.credentials) {
    return this.request('pairing/status', {
      auth: withCredentials, retryGet: true, timeoutMs: 5000,
    }).then(validatePairingStatus);
  }

  async assertPairable() {
    const device = await this.deviceInfo();
    const manifest = await this.manifest();
    const status = await this.status();
    if (device.device_id !== this.device.deviceId) {
      throw new HdpError('Geräte-ID der HTTP-Antwort passt nicht zu mDNS.', {
        code: 'INVALID_REQUEST', status: 409,
      });
    }
    validateProtocol(device.protocol_version);
    validateProtocol(manifest.protocol_version);
    if ((device.runtime_profile || null) !== (manifest.runtime_profile || null)) {
      throw new HdpError('Gerät und Manifest melden unterschiedliche Runtime-Profile.', {
        code: 'UNSUPPORTED_RUNTIME_PROFILE', status: 426,
      });
    }
    if (manifest.api_version !== 'v1' || manifest.auth_profile !== 'local-binding-key-v1') {
      throw new HdpError('Gerätemanifest verwendet kein hDP-1.0-Authentifizierungsprofil.', {
        code: 'UNSUPPORTED_PROTOCOL_VERSION', status: 426,
      });
    }
    const loadStatus = status.last_boot && status.last_boot.config_load_status;
    if (loadStatus === 'invalid' || loadStatus === 'storage_unavailable') {
      throw new HdpError('Gerätekonfiguration erfordert Wiederherstellung; Pairing wurde nicht gestartet.', {
        code: 'CONFIG_RECOVERY_REQUIRED', status: 409,
        details: { config_load_status: loadStatus },
      });
    }
    return { device, manifest, status };
  }

  async pair(pending) {
    const instanceId = validateInstanceId(pending.instanceId);
    const adapterNonce = validateNonce(pending.adapterNonce, 'Adapter-Nonce');
    const bindingKey = validateBindingKey(pending.bindingKey);
    const credentials = { instanceId, bindingKey };
    const localBindingId = bindingId(bindingKey);
    const before = await this.assertPairable();
    const publicPairing = await this.pairingStatus(false);
    if (publicPairing.paired) {
      this.credentials = credentials;
      const current = await this.pairingStatus(true);
      if (current.binding_status === 'match') {
        return { ...before, existingConfig: await this.config(), bindingId: localBindingId, recovered: true };
      }
      this.credentials = null;
      throw new HdpError('Gerät ist mit einer anderen Instanz oder einem anderen Schlüssel gekoppelt.', {
        code: 'ALREADY_PAIRED', status: 409,
      });
    }

    const startBody = {
      instance_id: instanceId,
      protocol_version: PROTOCOL_VERSION,
      adapter_nonce: adapterNonce,
    };
    let started;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        started = await this.request('pairing/start', {
          method: 'POST', body: startBody, timeoutMs: 5000,
        });
        break;
      } catch (error) {
        if (!error.uncertain || attempt === 2) throw error;
      }
    }
    if (!object(started)
        || started.adapter_nonce !== adapterNonce
        || started.security_profile !== 'local-binding-key-v1'
        || !Number.isInteger(started.expires_in_ms)
        || started.expires_in_ms < 0 || started.expires_in_ms > 120000) {
      throw new HdpError('Ungültige Antwort auf pairing/start.', { code: 'INVALID_REQUEST', status: 502 });
    }
    validateNonce(started.pairing_session, 'Pairing-Session');
    validateNonce(started.device_nonce, 'Geräte-Nonce');
    const confirmBody = {
      pairing_session: started.pairing_session,
      instance_id: instanceId,
      adapter_nonce: adapterNonce,
      device_nonce: started.device_nonce,
      binding_key: bindingKey,
    };
    let confirmed;
    try {
      confirmed = await this.request('pairing/confirm', {
        method: 'POST', body: confirmBody, timeoutMs: 5000,
      });
    } catch (error) {
      if (!error.uncertain) throw error;
      this.credentials = credentials;
      const status = await this.pairingStatus(true);
      if (status.binding_status === 'match') {
        confirmed = {
          paired: true, device_id: this.device.deviceId, instance_id: instanceId,
          binding_id: status.binding_id,
        };
      } else if (status.binding_status === 'unpaired') {
        try {
          confirmed = await this.request('pairing/confirm', {
            method: 'POST', body: confirmBody, timeoutMs: 5000,
          });
        } catch (retryError) {
          if (!retryError.uncertain) throw retryError;
          const finalStatus = await this.pairingStatus(true);
          if (finalStatus.binding_status !== 'match') throw retryError;
          confirmed = {
            paired: true, device_id: this.device.deviceId, instance_id: instanceId,
            binding_id: finalStatus.binding_id,
          };
        }
      } else {
        this.credentials = null;
        throw new HdpError('Pairing-Konflikt nach unsicherer Bestätigung.', {
          code: 'ALREADY_PAIRED', status: 409,
        });
      }
    }
    if (!object(confirmed) || confirmed.paired !== true
        || confirmed.device_id !== this.device.deviceId || confirmed.instance_id !== instanceId
        || validateBindingId(confirmed.binding_id) !== localBindingId) {
      this.credentials = null;
      throw new HdpError('Bestätigte Binding-ID stimmt nicht mit dem lokalen Binding-Key überein.', {
        code: 'ALREADY_PAIRED', status: 409,
      });
    }
    this.credentials = credentials;
    const bindingStatus = await this.pairingStatus(true);
    if (bindingStatus.binding_status !== 'match' || bindingStatus.binding_id !== localBindingId) {
      this.credentials = null;
      throw new HdpError('Gerät hat das Binding nicht eindeutig bestätigt.', {
        code: 'ALREADY_PAIRED', status: 409,
      });
    }
    return {
      ...before,
      existingConfig: await this.config(),
      confirmed,
      bindingId: localBindingId,
    };
  }

  async putConfig(expectedRevision, config, capabilities = {}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 0xffffffff) {
      throw new HdpError('expected_revision muss ein uint32 sein.', { code: 'INVALID_REQUEST', status: 400 });
    }
    const validated = validateHardwareConfig(config, capabilities);
    delete validated.revision;
    const body = { expected_revision: expectedRevision, config: validated };
    try {
      return await this.request('config', {
        method: 'PUT', auth: true, body, timeoutMs: 10000,
      }).then((data) => validateHardwareConfig(data, capabilities));
    } catch (error) {
      if (!error.uncertain) throw error;
      const current = await this.config();
      if (current.revision === expectedRevision + 1 && sameConfig(current, validated)) return current;
      if (current.revision !== expectedRevision) {
        throw new HdpError('Konfiguration wurde parallel verändert; der unsichere Schreibvorgang wird nicht wiederholt.', {
          code: 'CONFIG_REVISION_CONFLICT', status: 409,
          details: { expected_revision: expectedRevision, current_revision: current.revision },
        });
      }
      const retried = await this.request('config', {
        method: 'PUT', auth: true, body, timeoutMs: 10000,
      }).catch(async (retryError) => {
        if (!retryError.uncertain) throw retryError;
        const after = await this.config();
        if (after.revision === expectedRevision + 1 && sameConfig(after, validated)) return after;
        throw new HdpError('Ergebnis der Konfigurationsspeicherung ist nicht eindeutig.', {
          code: 'CONFIG_REVISION_CONFLICT', status: 409,
          details: { expected_revision: expectedRevision, current_revision: after.revision },
        });
      });
      return retried;
    }
  }

  unpair() {
    return this.request('unpair', {
      method: 'POST', auth: true, body: { preserve_hardware_config: true }, timeoutMs: 5000,
    }).then((data) => {
      if (data.hardware_config_retained !== true || data.restart_required !== true) {
        throw new HdpError('Ungültige Entkopplungsantwort.', { code: 'INVALID_REQUEST', status: 502 });
      }
      return data;
    });
  }

  restart() {
    return this.request('restart', { method: 'POST', auth: !!this.credentials, body: {}, timeoutMs: 5000 });
  }

  restartFirmware() {
    return this.request('firmware/restart', {
      method: 'POST', auth: true, body: {}, timeoutMs: 5000,
    }).then((data) => {
      if (data.state !== 'restarting') {
        throw new HdpError('Ungültige OTA-Neustartantwort.', { code: 'INVALID_REQUEST', status: 502 });
      }
      return data;
    });
  }
}

module.exports = {
  JSON_REQUEST_LIMIT, BINARY_PIN_TRAIT_KEYS, HdpError, unwrap, requestJson, sameConfig,
  validatePairingStatus, validateDeviceInfo, validateManifestInfo, validateStatusInfo,
  validateFirmwareInfo, validateFirmwareStatus, HdpClient,
};
