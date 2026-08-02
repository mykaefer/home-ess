'use strict';

const DEVICE_ID_RE = /^[a-z0-9-]{12,64}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PROTOCOL_VERSION = '1.0-draft';
const PIXEL_RUNTIME_PROFILE = 'pixel-timeline-v1';
const BINARY_RUNTIME_PROFILE = 'binary-io-v1';
const RUNTIME_PROFILE = PIXEL_RUNTIME_PROFILE;
const RUNTIME_PROFILES = Object.freeze([PIXEL_RUNTIME_PROFILE, BINARY_RUNTIME_PROFILE]);

function supportedRuntimeProfile(value) {
  return RUNTIME_PROFILES.includes(value);
}

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
  if (!DEVICE_ID_RE.test(id)) throw new Error('Ungültige hDP-Geräte-ID.');
  return id;
}

function validateInstanceId(value) {
  const id = String(value || '');
  if (!INSTANCE_ID_RE.test(id)) throw new Error('Ungültige homeESS-Instanz-ID für hDP.');
  return id;
}

function validatePort(value, label = 'Port') {
  return integer(value, 1, 65535, label);
}

function validateProtocol(value) {
  if (value !== PROTOCOL_VERSION) {
    const error = new Error(`hDP-Protokollversion muss exakt ${PROTOCOL_VERSION} sein.`);
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
  // `argb_output` führt beide Abschnitte: den Strang und die Binary-Rollen der
  // übrigen GPIOs. Allein an `pins` lässt sich der Gerätetyp deshalb nicht mehr
  // erkennen — `outputs` entscheidet.
  if (config.device_type === 'binary_io'
      || (Array.isArray(config.pins) && !Array.isArray(config.outputs))) {
    return validateBinaryConfig(config, capabilities);
  }
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
    throw new Error('LED-Typ wird von hDP 1.0-draft oder dem Gerät nicht unterstützt.');
  }
  if (typeof hardware.color_order !== 'string' || !allowedColorOrders.includes(hardware.color_order)
      || !['RGB', 'GRB'].includes(hardware.color_order)) {
    throw new Error('Farbreihenfolge wird von hDP 1.0-draft oder dem Gerät nicht unterstützt.');
  }
  if (typeof hardware.reverse !== 'boolean' || typeof display.fractional_led !== 'boolean') {
    throw new Error('Hardware-Booleanfelder müssen echte JSON-Booleanwerte sein.');
  }
  if (display.inactive_led_mode !== 'off') throw new Error('inactive_led_mode muss in hDP 1.0-draft exakt off sein.');
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

function validateBinaryConfig(input, capabilities = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const manifest = capabilities.manifest || capabilities;
  const limits = manifest.limits || capabilities;
  const hardware = manifest.hardware_capabilities || capabilities;
  const maximumPins = strictInteger(
    limits.maximum_binary_pins == null ? 5 : limits.maximum_binary_pins,
    1, 32, 'Maximale Binary-Pinzahl',
  );
  if (config.device_type !== 'binary_io') {
    throw new Error('Binary-I/O-Konfiguration benötigt device_type binary_io.');
  }
  if (!Array.isArray(config.pins) || config.pins.length < 1 || config.pins.length > maximumPins) {
    throw new Error(`pins muss 1 bis ${maximumPins} Einträge enthalten.`);
  }
  const allowedPins = Array.isArray(hardware.binary_pins) ? hardware.binary_pins : [];
  const allowedInputTypes = Array.isArray(hardware.binary_input_types)
    ? hardware.binary_input_types : ['switch', 'button'];
  const used = new Set();
  const result = {
    device_type: 'binary_io',
    pins: config.pins.map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('Binary-Pinkonfiguration ist ungültig.');
      }
      const pin = strictInteger(source.pin, 0, 255, 'GPIO');
      if (!allowedPins.includes(pin)) throw new Error('GPIO wird für Binary-I/O nicht unterstützt.');
      if (used.has(pin)) throw new Error('Binary-I/O-GPIOs müssen eindeutig sein.');
      used.add(pin);
      if (!['input', 'output'].includes(source.direction)) {
        throw new Error('Binary-I/O-Richtung muss input oder output sein.');
      }
      if (source.direction === 'input') {
        if (!allowedInputTypes.includes(source.input_type)
            || !['switch', 'button'].includes(source.input_type)) {
          throw new Error('Binary-Eingangstyp muss switch oder button sein.');
        }
        return { pin, direction: 'input', input_type: source.input_type };
      }
      if (Object.prototype.hasOwnProperty.call(source, 'input_type')) {
        throw new Error('Binary-Ausgänge dürfen keinen input_type definieren.');
      }
      return { pin, direction: 'output' };
    }),
  };
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) {
    result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
  }
  return result;
}

// Einschaltkriterien einer ARGB-Statusanzeige. Eine LED leuchtet, solange der
// verknüpfte State das Kriterium erfüllt; sonst zeigt sie die Aus-Farbe.
const ARGB_OPERATORS = Object.freeze(['equals', 'less_than', 'greater_than', 'between']);
const ARGB_OPERATOR_LABELS = Object.freeze({
  equals: 'ist gleich (x)',
  less_than: 'ist kleiner als (< x)',
  greater_than: 'ist größer als (> x)',
  between: 'liegt zwischen (x bis y)',
});

// homeESS-States liefern Zahlen, Booleans und Texte. Für die Vergleiche
// <x, >x und x-y zählt ausschließlich die Zahl; Booleans sind dabei 1 und 0,
// damit ein Schaltzustand ohne Umweg als Kriterium „= 1“ nutzbar bleibt.
function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (['true', 'on', 'yes', 'ein', 'an'].includes(lower)) return 1;
  if (['false', 'off', 'no', 'aus'].includes(lower)) return 0;
  const number = Number(text.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function comparableText(value) {
  if (value == null) return '';
  return String(typeof value === 'boolean' ? (value ? 'true' : 'false') : value)
    .trim().toLowerCase();
}

function validateArgbCondition(input, label = 'Bedingung') {
  const source = input && typeof input === 'object' ? input : {};
  const operator = ARGB_OPERATORS.includes(source.operator) ? source.operator : 'equals';
  // Nur „ist gleich“ vergleicht auch Text; alle Ordnungsvergleiche brauchen
  // zwingend eine Zahl, sonst wäre das Kriterium schlicht nicht auswertbar.
  const rawValue = source.value == null ? '' : String(source.value).trim();
  const value = numericValue(rawValue);
  if (operator !== 'equals' && value == null) {
    throw new Error(`${label}: Der Vergleichswert muss numerisch sein.`);
  }
  if (operator !== 'between') {
    return { operator, value: rawValue, value_max: '' };
  }
  const rawMaximum = source.value_max == null ? '' : String(source.value_max).trim();
  const maximum = numericValue(rawMaximum);
  if (maximum == null) throw new Error(`${label}: Der obere Bereichswert muss numerisch sein.`);
  if (maximum < value) throw new Error(`${label}: Der obere Bereichswert darf nicht kleiner als der untere sein.`);
  return { operator, value: rawValue, value_max: rawMaximum };
}

// Ein noch nie empfangener State erfüllt kein Kriterium; die LED bleibt dann
// auf ihrer Aus-Farbe, statt einen erfundenen Zustand anzuzeigen.
function argbConditionActive(condition, value) {
  if (value === undefined) return false;
  const source = condition && typeof condition === 'object' ? condition : {};
  const operator = ARGB_OPERATORS.includes(source.operator) ? source.operator : 'equals';
  const current = numericValue(value);
  const target = numericValue(source.value);
  if (operator === 'equals') {
    if (current != null && target != null) return current === target;
    return comparableText(value) === comparableText(source.value);
  }
  if (current == null || target == null) return false;
  if (operator === 'less_than') return current < target;
  if (operator === 'greater_than') return current > target;
  const maximum = numericValue(source.value_max);
  if (maximum == null) return false;
  return current >= target && current <= maximum;
}

function validateOpaqueId(value, label, pattern = /^[A-Za-z0-9._-]{1,32}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} ist ungültig.`);
  return value;
}

// Beim ARGB-Ausgang ist die Pinbelegung nicht frei: Ein GPIO ohne nutzbaren
// internen Pull-up taugt nicht als aktiv-low-Eingang und ist deshalb fest
// Ausgang. Genau ein weiterer GPIO trägt die Datenleitung, alle übrigen sind
// Eingänge. Die Regel folgt allein aus `binary_pins` und `binary_pullup_pins`
// des Manifests — ein eigenes Manifestfeld wäre nur eine zweite Wahrheit.
function argbOutputPinRoles(hardware, argbPin) {
  const all = Array.isArray(hardware.binary_pins) ? hardware.binary_pins : [];
  const pullup = Array.isArray(hardware.binary_pullup_pins)
    ? hardware.binary_pullup_pins : all;
  const fixedOutputs = all.filter((pin) => !pullup.includes(pin));
  const dataCandidates = all.filter((pin) => pullup.includes(pin));
  const inputs = dataCandidates.filter((pin) => pin !== argbPin);
  return { all, fixedOutputs, dataCandidates, inputs };
}

// Die vollständige Pinliste, die ein argb_output-Gerät erwartet. Der Adapter
// leitet sie ab, statt sie den Benutzer eintragen zu lassen; die Firmware
// prüft sie anschließend gegen dieselbe Regel.
function argbOutputPins(hardware, argbPin, inputTypes = {}) {
  const roles = argbOutputPinRoles(hardware, argbPin);
  return roles.all
    .filter((pin) => pin !== argbPin)
    .map((pin) => (roles.fixedOutputs.includes(pin)
      ? { pin, direction: 'output' }
      : {
        pin,
        direction: 'input',
        input_type: inputTypes[String(pin)] === 'button' ? 'button' : 'switch',
      }));
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
  // Der ARGB-Ausgang führt zusätzlich die Binary-Rollen aller übrigen GPIOs.
  // Der Datenpin muss dafür einen nutzbaren Pull-up haben — sonst wäre er selbst
  // ein fester Ausgang. Die Pinliste wird hier nur geprüft und normalisiert,
  // niemals erfunden: Ein Gerät, das keine meldet, führt auch keine. Erzeugt
  // wird sie ausschließlich dort, wo eine Konfiguration geschrieben wird.
  if (result.device_type === 'argb_output') {
    const argbPin = result.outputs[0].pin;
    const roles = argbOutputPinRoles(hardware, argbPin);
    if (!roles.all.length) throw new Error('Gerätemanifest nennt keine Binary-GPIOs.');
    if (!roles.dataCandidates.includes(argbPin)) {
      throw new Error('Der ARGB-Datenpin braucht einen nutzbaren internen Pull-up; GPIO '
        + `${roles.fixedOutputs.join(', ')} sind fest Ausgänge.`);
    }
    if (Array.isArray(config.pins)) {
      const inputTypes = {};
      for (const source of config.pins) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          throw new Error('Binary-Pinkonfiguration ist ungültig.');
        }
        const pin = strictInteger(source.pin, 0, 255, 'GPIO');
        if (pin === argbPin) {
          throw new Error('Der ARGB-Datenpin darf keine Binary-Rolle haben.');
        }
        if (!roles.all.includes(pin)) {
          throw new Error('GPIO wird für Binary-I/O nicht unterstützt.');
        }
        const wantsOutput = roles.fixedOutputs.includes(pin);
        if (wantsOutput !== (source.direction === 'output')) {
          throw new Error(`GPIO ${pin} muss beim ARGB-Ausgang `
            + `${wantsOutput ? 'Ausgang' : 'Eingang'} sein.`);
        }
        if (source.direction === 'input') {
          if (!['switch', 'button'].includes(source.input_type)) {
            throw new Error('Binary-Eingangstyp muss switch oder button sein.');
          }
          inputTypes[String(pin)] = source.input_type;
        }
      }
      result.pins = argbOutputPins(hardware, argbPin, inputTypes);
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) {
    result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
  }
  return result;
}

module.exports = {
  PROTOCOL_VERSION, RUNTIME_PROFILE, PIXEL_RUNTIME_PROFILE, BINARY_RUNTIME_PROFILE,
  RUNTIME_PROFILES, supportedRuntimeProfile,
  clamp, finite, strictFinite, bounded, integer, strictInteger,
  validateDeviceId, validateInstanceId, validatePort, validateProtocol,
  compatibleProtocol, parseSemVer, compareSemVer, color, colorStops, scale,
  interpolateColor, validateHardwareConfig, validateOutputConfig, validateBinaryConfig,
  validateOpaqueId,
  ARGB_OPERATORS, ARGB_OPERATOR_LABELS,
  numericValue, comparableText, validateArgbCondition, argbConditionActive,
  argbOutputPinRoles, argbOutputPins,
};
