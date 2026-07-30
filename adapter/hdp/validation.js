'use strict';

const DEVICE_ID_RE = /^[a-z0-9-]{12,64}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PROTOCOL_VERSION = '1.0-draft';
const RUNTIME_PROFILE = 'pixel-timeline-v1';

function finite(value, label = 'Wert') {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} muss numerisch und endlich sein.`);
  return n;
}

function strictFinite(value, label = 'Wert') {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} muss eine endliche JSON-Zahl sein.`);
  return value;
}

function bounded(value, min, max, label) {
  const n = finite(value, label);
  if (n < min || n > max) throw new Error(`${label} muss zwischen ${min} und ${max} liegen.`);
  return n;
}

function integer(value, min, max, label) {
  const n = finite(value, label);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return n;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validateDeviceId(value) {
  const id = String(value || '');
  if (!DEVICE_ID_RE.test(id)) throw new Error('Ungültige HDP-Geräte-ID.');
  return id;
}

function validateInstanceId(value) {
  const id = String(value || '');
  if (!INSTANCE_ID_RE.test(id)) throw new Error('Ungültige homeESS-Instanz-ID für HDP.');
  return id;
}

function validatePort(value, label = 'Port') {
  return integer(value, 1, 65535, label);
}

function validateProtocol(value) {
  if (value !== PROTOCOL_VERSION) {
    const error = new Error(`HDP-Protokollversion muss exakt ${PROTOCOL_VERSION} sein.`);
    error.code = 'UNSUPPORTED_PROTOCOL_VERSION';
    error.status = 426;
    throw error;
  }
  return value;
}

function compatibleProtocol(a, b) {
  return a === PROTOCOL_VERSION && b === PROTOCOL_VERSION;
}

function parseSemVer(value) {
  const match = SEMVER_RE.exec(String(value || ''));
  if (!match) throw new Error('Ungültige Firmwareversion.');
  return {
    raw: String(value),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareSemVer(a, b) {
  const left = typeof a === 'string' ? parseSemVer(a) : a;
  const right = typeof b === 'string' ? parseSemVer(b) : b;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (left.prerelease[i] == null) return -1;
    if (right.prerelease[i] == null) return 1;
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

function color(value, label = 'Farbe') {
  if (!value || typeof value !== 'object') throw new Error(`${label} fehlt.`);
  return {
    r: integer(value.r, 0, 255, `${label} Rot`),
    g: integer(value.g, 0, 255, `${label} Grün`),
    b: integer(value.b, 0, 255, `${label} Blau`),
  };
}

function colorStops(stops, { percentage = false } = {}) {
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 32) {
    throw new Error('Es sind 2 bis 32 Farbstützpunkte erforderlich.');
  }
  let previous = -Infinity;
  return stops.map((stop, index) => {
    const value = finite(stop && stop.value, `Stützpunkt ${index + 1}`);
    if (percentage && (value < 0 || value > 100)) throw new Error('Prozent-Farbstützpunkte müssen zwischen 0 und 100 liegen.');
    if (value <= previous) throw new Error('Farbstützpunkte müssen eindeutig und aufsteigend sortiert sein.');
    previous = value;
    return { value, color: color(stop.color, `Stützpunkt ${index + 1}`) };
  });
}

function scale(value, config = {}) {
  const raw = finite(value, 'Datenquellenwert');
  const inputMin = finite(config.input_min == null ? 0 : config.input_min, 'Eingangsminimum');
  const inputMax = finite(config.input_max == null ? 100 : config.input_max, 'Eingangsmaximum');
  const outputMin = finite(config.output_min == null ? 0 : config.output_min, 'Ausgangsminimum');
  const outputMax = finite(config.output_max == null ? 100 : config.output_max, 'Ausgangsmaximum');
  if (inputMax === inputMin) throw new Error('Eingangsminimum und -maximum dürfen nicht identisch sein.');
  let ratio = (raw - inputMin) / (inputMax - inputMin);
  if (config.invert) ratio = 1 - ratio;
  if (config.clamp !== false) ratio = clamp(ratio, 0, 1);
  return outputMin + ratio * (outputMax - outputMin);
}

function interpolateColor(value, stops) {
  const n = finite(value, 'Farbquellenwert');
  const valid = colorStops(stops);
  if (n <= valid[0].value) return valid[0].color;
  if (n >= valid.at(-1).value) return valid.at(-1).color;
  const upperIndex = valid.findIndex((stop) => stop.value >= n);
  const lower = valid[upperIndex - 1];
  const upper = valid[upperIndex];
  const ratio = (n - lower.value) / (upper.value - lower.value);
  return {
    r: Math.round(lower.color.r + (upper.color.r - lower.color.r) * ratio),
    g: Math.round(lower.color.g + (upper.color.g - lower.color.g) * ratio),
    b: Math.round(lower.color.b + (upper.color.b - lower.color.b) * ratio),
  };
}

function strictInteger(value, min, max, label) {
  const n = strictFinite(value, label);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return n;
}

function validateHardwareConfig(input, capabilities = {}) {
  const config = input && typeof input === 'object' ? input : {};
  if (Array.isArray(config.outputs)) return validateOutputConfig(config, capabilities);
  if (config.device_type !== 'percentage_indicator') throw new Error('Nur percentage_indicator wird unterstützt.');
  const hardware = config.hardware || {};
  const display = config.display || {};
  const power = config.power || {};
  const offline = config.offline || {};
  const pin = strictInteger(hardware.argb_pin, 0, 255, 'GPIO');
  const allowedPins = Array.isArray(capabilities.argb_pins) ? capabilities.argb_pins : null;
  if (allowedPins && !allowedPins.includes(pin)) {
    throw Object.assign(new Error('GPIO wird vom Gerätemanifest nicht unterstützt.'), { code: 'INVALID_CONFIGURATION', status: 422 });
  }
  const maximumLedCount = Number.isInteger(capabilities.maximum_led_count)
    ? Math.min(300, capabilities.maximum_led_count) : 300;
  const allowedLedTypes = Array.isArray(capabilities.led_types) ? capabilities.led_types : ['WS2812'];
  const allowedColorOrders = Array.isArray(capabilities.color_orders) ? capabilities.color_orders : ['RGB', 'GRB'];
  const ledType = hardware.led_type == null ? 'WS2812' : hardware.led_type;
  if (typeof ledType !== 'string' || !allowedLedTypes.includes(ledType) || ledType !== 'WS2812') {
    throw new Error('LED-Typ wird von HDP 1.0-draft oder dem Gerät nicht unterstützt.');
  }
  if (typeof hardware.color_order !== 'string' || !allowedColorOrders.includes(hardware.color_order)
      || !['RGB', 'GRB'].includes(hardware.color_order)) {
    throw new Error('Farbreihenfolge wird von HDP 1.0-draft oder dem Gerät nicht unterstützt.');
  }
  if (typeof hardware.reverse !== 'boolean' || typeof display.fractional_led !== 'boolean') {
    throw new Error('Hardware-Booleanfelder müssen echte JSON-Booleanwerte sein.');
  }
  if (display.inactive_led_mode !== 'off') throw new Error('inactive_led_mode muss in HDP 1.0-draft exakt off sein.');
  const mode = String(offline.mode || '');
  if (!['retain_last_state', 'turn_off', 'show_offline_pattern'].includes(mode)) {
    throw new Error('Ungültiges Offline-Verhalten.');
  }
  const result = {
    device_type: 'percentage_indicator',
    hardware: {
      argb_pin: pin,
      led_count: strictInteger(hardware.led_count, 1, maximumLedCount, 'LED-Anzahl'),
      led_type: ledType,
      color_order: hardware.color_order,
      reverse: hardware.reverse,
    },
    display: {
      fractional_led: display.fractional_led,
      inactive_led_mode: 'off',
      transition_milliseconds: strictInteger(display.transition_milliseconds, 0, 60000, 'Übergangszeit'),
    },
    power: {
      maximum_brightness_percent: strictInteger(power.maximum_brightness_percent, 0, 100, 'Maximalhelligkeit'),
      maximum_current_milliamps: strictInteger(power.maximum_current_milliamps, 1, 20000, 'Maximalstrom'),
      current_per_led_milliamps: strictInteger(power.current_per_led_milliamps, 1, 100, 'Strom pro LED'),
    },
    offline: { mode },
  };
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) {
    result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
  }
  return result;
}

function validateOpaqueId(value, label, pattern = /^[A-Za-z0-9._-]{1,32}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} ist ungültig.`);
  return value;
}

function validateOutputConfig(input, capabilities = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const manifest = capabilities.manifest || capabilities;
  const limits = manifest.limits || capabilities;
  const hardware = manifest.hardware_capabilities || capabilities;
  const outputTypes = manifest.output_types || ['argb_strip'];
  const maximumOutputs = strictInteger(limits.maximum_outputs == null ? 1 : limits.maximum_outputs, 1, 255, 'Maximale Ausgangszahl');
  if (!Array.isArray(config.outputs) || config.outputs.length < 1 || config.outputs.length > maximumOutputs) {
    throw new Error(`outputs muss 1 bis ${maximumOutputs} Ausgänge enthalten.`);
  }
  const ids = new Set();
  const result = {
    device_type: validateOpaqueId(config.device_type, 'Gerätetyp', /^[a-z0-9._-]{1,32}$/),
    outputs: config.outputs.map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Ausgangskonfiguration ist ungültig.');
      const outputId = validateOpaqueId(source.output_id, 'Output-ID');
      if (ids.has(outputId)) throw new Error('Output-IDs müssen eindeutig sein.');
      ids.add(outputId);
      if (typeof source.output_type !== 'string' || !outputTypes.includes(source.output_type)) throw new Error('Output-Typ wird nicht unterstützt.');
      const pin = strictInteger(source.pin, 0, 255, 'GPIO');
      if (!Array.isArray(hardware.argb_pins) || !hardware.argb_pins.includes(pin)) throw new Error('GPIO wird vom Gerätemanifest nicht unterstützt.');
      if (typeof source.driver !== 'string' || !hardware.led_types.includes(source.driver)) throw new Error('Treiber wird nicht unterstützt.');
      if (typeof source.color_order !== 'string' || !hardware.color_orders.includes(source.color_order)) throw new Error('Farbreihenfolge wird nicht unterstützt.');
      if (typeof source.reverse !== 'boolean') throw new Error('reverse muss ein Booleanwert sein.');
      if (!['retain_last_frame', 'clear', 'continue_timeline'].includes(source.offline_mode)) throw new Error('Offline-Verhalten ist ungültig.');
      return {
        output_id: outputId,
        output_type: source.output_type,
        pin,
        pixel_count: strictInteger(source.pixel_count, 1, limits.maximum_led_count, 'Pixelanzahl'),
        driver: source.driver,
        color_order: source.color_order,
        reverse: source.reverse,
        maximum_brightness_percent: strictInteger(source.maximum_brightness_percent, 0, 100, 'Maximalhelligkeit'),
        maximum_current_milliamps: strictInteger(source.maximum_current_milliamps, 1, 20000, 'Maximalstrom'),
        current_per_pixel_milliamps: strictInteger(source.current_per_pixel_milliamps, 1, 100, 'Strom pro Pixel'),
        offline_mode: source.offline_mode,
      };
    }),
  };
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) {
    result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
  }
  return result;
}

module.exports = {
  PROTOCOL_VERSION, RUNTIME_PROFILE, clamp, finite, strictFinite, bounded, integer, strictInteger,
  validateDeviceId, validateInstanceId, validatePort, validateProtocol,
  compatibleProtocol, parseSemVer, compareSemVer, color, colorStops, scale,
  interpolateColor, validateHardwareConfig, validateOutputConfig, validateOpaqueId,
};
