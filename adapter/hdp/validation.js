'use strict';

const DEVICE_ID_RE = /^[a-z0-9-]{12,64}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PROTOCOL_VERSION = '1.0-draft';
const PIXEL_RUNTIME_PROFILE = 'pixel-timeline-v1';
const BINARY_RUNTIME_PROFILE = 'binary-io-v1';
const SENSOR_RUNTIME_PROFILE = 'sensor-reading-v1';
const FINGERPRINT_RUNTIME_PROFILE = 'fingerprint-event-v1';
const IR_RUNTIME_PROFILE = 'ir-transceiver-v1';
const RUNTIME_PROFILE = PIXEL_RUNTIME_PROFILE;
const RUNTIME_PROFILES = Object.freeze([
  PIXEL_RUNTIME_PROFILE, BINARY_RUNTIME_PROFILE, SENSOR_RUNTIME_PROFILE,
  FINGERPRINT_RUNTIME_PROFILE, IR_RUNTIME_PROFILE,
]);

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
  if (config.device_type === 'ir_transceiver' || config.receiver || config.blaster) {
    return validateIrConfig(config, capabilities);
  }
  if (config.device_type === 'fingerprint_reader' || config.uart) {
    return validateFingerprintConfig(config, capabilities);
  }
  if (config.device_type === 'sensors' || Array.isArray(config.sensors)) {
    return validateSensorConfig(config, capabilities);
  }
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

function validateIrConfig(input, capabilities = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const manifest = capabilities.manifest || capabilities;
  const hardware = manifest.hardware_capabilities || capabilities;
  const allowedPins = Array.isArray(hardware.binary_pins) ? hardware.binary_pins : [];
  const pullupPins = Array.isArray(hardware.binary_pullup_pins)
    ? hardware.binary_pullup_pins : allowedPins;
  if (config.device_type !== 'ir_transceiver') {
    throw new Error('IR-Konfiguration benötigt device_type ir_transceiver.');
  }
  const receiver = config.receiver && typeof config.receiver === 'object' ? config.receiver : {};
  const blaster = config.blaster && typeof config.blaster === 'object' ? config.blaster : {};
  if (typeof receiver.enabled !== 'boolean' || typeof blaster.enabled !== 'boolean'
      || (!receiver.enabled && !blaster.enabled)) {
    throw new Error('Receiver oder Blaster muss aktiviert sein.');
  }
  const result = {
    device_type: 'ir_transceiver',
    receiver: { enabled: receiver.enabled },
    blaster: { enabled: blaster.enabled },
  };
  const used = new Set();
  const pin = (value, label, allowed = allowedPins) => {
    const parsed = strictInteger(value, 0, 255, label);
    if (!allowed.includes(parsed)) throw new Error(`${label} wird vom Gerät nicht unterstützt.`);
    if (used.has(parsed)) throw new Error('IR-GPIOs müssen eindeutig sein.');
    used.add(parsed); return parsed;
  };
  if (receiver.enabled) {
    result.receiver.pin = pin(receiver.pin, 'Receiver-GPIO');
    result.receiver.carrier_frequency_hz = strictInteger(
      receiver.carrier_frequency_hz == null ? 38000 : receiver.carrier_frequency_hz,
      20000, 60000, 'IR-Trägerfrequenz',
    );
    const modes = Array.isArray(hardware.ir_receiver_modes)
      ? hardware.ir_receiver_modes : ['passthrough', 'record'];
    if (!['passthrough', 'record'].includes(receiver.mode) || !modes.includes(receiver.mode)) {
      throw new Error('Receiver-Modus muss passthrough oder record sein.');
    }
    result.receiver.mode = receiver.mode;
    result.receiver.trigger_pin = receiver.trigger_pin == null
      ? null : pin(receiver.trigger_pin, 'Trigger-GPIO', pullupPins);
  } else {
    result.receiver.pin = Number(hardware.ir_default_receiver_pin || 14);
    result.receiver.carrier_frequency_hz = 38000;
    result.receiver.mode = 'passthrough'; result.receiver.trigger_pin = null;
  }
  if (blaster.enabled) result.blaster.pin = pin(blaster.pin, 'Blaster-GPIO');
  else result.blaster.pin = Number(hardware.ir_default_blaster_pin || 4);
  result.status_led_pin = pin(
    config.status_led_pin == null
      ? Number(hardware.ir_default_status_led_pin || 2) : config.status_led_pin,
    'Signal-LED-GPIO',
  );
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) {
    result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
  }
  return result;
}

const SENSOR_TYPES = Object.freeze([
  'dht11', 'dht22', 'ds18b20', 'bme280', 'sht30', 'sht31', 'bh1750',
  'ina219', 'hx711', 'vl53l0x', 'analog',
]);
const I2C_SENSOR_TYPES = new Set(['bme280', 'sht30', 'sht31', 'bh1750', 'ina219', 'vl53l0x']);
const FINGERPRINT_LED_SCENES = Object.freeze(['idle', 'scanning', 'success', 'failure', 'enrolling']);
const FINGERPRINT_LED_EFFECTS = Object.freeze([
  'breathing', 'flashing', 'on', 'off', 'gradual_on', 'gradual_off',
]);
const FINGERPRINT_LED_COLORS = Object.freeze(['red', 'blue', 'purple']);

function validateFingerprintConfig(input, capabilities = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const manifest = capabilities.manifest || capabilities;
  const hardware = manifest.hardware_capabilities || capabilities;
  if (config.device_type !== 'fingerprint_reader') {
    throw new Error('Fingerabdruckkonfiguration benötigt device_type fingerprint_reader.');
  }
  const allowedPins = Array.isArray(hardware.binary_pins) ? hardware.binary_pins : [];
  const uart = config.uart;
  if (!uart || typeof uart !== 'object' || Array.isArray(uart)) {
    throw new Error('UART-Konfiguration des Fingerabdrucksensors fehlt.');
  }
  const pin = (value, label) => {
    const parsed = strictInteger(value, 0, 255, label);
    if (!allowedPins.includes(parsed)) throw new Error(`${label} wird vom Gerät nicht unterstützt.`);
    return parsed;
  };
  const rxPin = pin(uart.rx_pin, 'UART-RX-GPIO');
  const txPin = pin(uart.tx_pin, 'UART-TX-GPIO');
  if (rxPin === txPin) throw new Error('UART-RX und UART-TX müssen verschieden sein.');
  if (rxPin === 16) throw new Error('GPIO 16 unterstützt den benötigten UART-Empfang nicht.');
  let wakeupPin = null;
  if (config.wakeup_pin !== null && config.wakeup_pin !== undefined
      && String(config.wakeup_pin) !== '') {
    wakeupPin = pin(config.wakeup_pin, 'Wakeup-GPIO');
    if ([rxPin, txPin].includes(wakeupPin)) throw new Error('Wakeup-GPIO darf UART-RX/TX nicht überlappen.');
  }
  const supportedEffects = Array.isArray(hardware.fingerprint_led_effects)
    ? hardware.fingerprint_led_effects : FINGERPRINT_LED_EFFECTS;
  const supportedColors = Array.isArray(hardware.fingerprint_led_colors)
    ? hardware.fingerprint_led_colors : FINGERPRINT_LED_COLORS;
  const sourceLed = config.led && typeof config.led === 'object' ? config.led : {};
  const led = {};
  for (const scene of FINGERPRINT_LED_SCENES) {
    const source = sourceLed[scene];
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`LED-Verhalten für ${scene} fehlt.`);
    }
    if (!FINGERPRINT_LED_EFFECTS.includes(source.effect) || !supportedEffects.includes(source.effect)) {
      throw new Error(`LED-Effekt für ${scene} wird nicht unterstützt.`);
    }
    if (!FINGERPRINT_LED_COLORS.includes(source.color) || !supportedColors.includes(source.color)) {
      throw new Error(`LED-Farbe für ${scene} wird nicht unterstützt.`);
    }
    led[scene] = {
      effect: source.effect, color: source.color,
      speed: strictInteger(source.speed, 0, 255, `LED-Geschwindigkeit ${scene}`),
      count: strictInteger(source.count, 0, 255, `LED-Wiederholungen ${scene}`),
    };
  }
  const pins = Array.isArray(config.pins) ? config.pins : [];
  const binary = pins.length
    ? validateBinaryConfig({ device_type: 'binary_io', pins }, manifest).pins : [];
  const reserved = new Set([rxPin, txPin, ...(wakeupPin === null ? [] : [wakeupPin])]);
  if (binary.some((entry) => reserved.has(entry.pin))) {
    throw new Error('Binary-GPIO überlappt UART oder Wakeup des Fingerabdrucksensors.');
  }
  const result = {
    device_type: 'fingerprint_reader',
    uart: { rx_pin: rxPin, tx_pin: txPin }, wakeup_pin: wakeupPin, led,
    pins: binary,
  };
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) {
    result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
  }
  return result;
}

function validateSensorConfig(input, capabilities = {}) {
  const config = input && typeof input === 'object' ? input : {};
  const manifest = capabilities.manifest || capabilities;
  const limits = manifest.limits || capabilities;
  const hardware = manifest.hardware_capabilities || capabilities;
  const maximumSensors = strictInteger(limits.maximum_sensors == null ? 8 : limits.maximum_sensors,
    1, 32, 'Maximale Sensorzahl');
  const allowedTypes = Array.isArray(hardware.sensor_types) ? hardware.sensor_types : SENSOR_TYPES;
  const allowedPins = Array.isArray(hardware.binary_pins) ? hardware.binary_pins : [];
  if (config.device_type !== 'sensors') throw new Error('Sensorkonfiguration benötigt device_type sensors.');
  if (!Array.isArray(config.sensors) || config.sensors.length < 1 || config.sensors.length > maximumSensors) {
    throw new Error(`sensors muss 1 bis ${maximumSensors} Einträge enthalten.`);
  }
  const ids = new Set();
  const discretePins = new Set();
  const i2cAddresses = new Set();
  let i2cPair = null;
  let analogSeen = false;
  const sensors = config.sensors.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Sensorkonfiguration ist ungültig.');
    const sensorId = validateOpaqueId(source.sensor_id, 'Sensor-ID', /^[A-Za-z0-9._-]{1,16}$/);
    if (ids.has(sensorId)) throw new Error('Sensor-IDs müssen eindeutig sein.');
    ids.add(sensorId);
    const sensorType = String(source.sensor_type || '');
    if (!SENSOR_TYPES.includes(sensorType) || !allowedTypes.includes(sensorType)) throw new Error('Sensortyp wird nicht unterstützt.');
    const minimum = sensorType === 'dht22' ? 2000 : sensorType === 'dht11' ? 1000
      : Number(limits.minimum_sensor_interval_milliseconds || 100);
    const result = {
      sensor_id: sensorId, sensor_type: sensorType,
      sample_interval_milliseconds: strictInteger(source.sample_interval_milliseconds,
        minimum, 3600000, 'Messintervall'),
    };
    const pin = (value, label) => {
      const parsed = strictInteger(value, 0, 255, label);
      if (!allowedPins.includes(parsed)) throw new Error(`${label} wird vom Gerät nicht unterstützt.`);
      return parsed;
    };
    if (sensorType === 'analog') {
      if (analogSeen) throw new Error('A0 kann nur einmal als analoger Sensor verwendet werden.');
      analogSeen = true;
      return result;
    }
    if (I2C_SENSOR_TYPES.has(sensorType)) {
      result.sda_pin = pin(source.sda_pin, 'SDA-GPIO');
      result.scl_pin = pin(source.scl_pin, 'SCL-GPIO');
      if (result.sda_pin === result.scl_pin) throw new Error('SDA und SCL müssen verschieden sein.');
      const pair = `${result.sda_pin}:${result.scl_pin}`;
      if (i2cPair && i2cPair !== pair) throw new Error('Alle I²C-Sensoren müssen dasselbe SDA/SCL-Paar nutzen.');
      i2cPair = pair;
      result.address = strictInteger(source.address, 0x08, 0x77, 'I²C-Adresse');
      const validAddress = (sensorType === 'bme280' && [0x76, 0x77].includes(result.address))
        || (['sht30', 'sht31'].includes(sensorType) && [0x44, 0x45].includes(result.address))
        || (sensorType === 'bh1750' && [0x23, 0x5c].includes(result.address))
        || (sensorType === 'ina219' && result.address >= 0x40 && result.address <= 0x4f)
        || (sensorType === 'vl53l0x' && result.address === 0x29);
      if (!validAddress) throw new Error('I²C-Adresse passt nicht zum Sensortyp.');
      if (i2cAddresses.has(result.address)) throw new Error('I²C-Adressen müssen eindeutig sein.');
      i2cAddresses.add(result.address);
      return result;
    }
    if (sensorType === 'hx711') {
      result.data_pin = pin(source.data_pin, 'Daten-GPIO');
      result.clock_pin = pin(source.clock_pin, 'Takt-GPIO');
      if (result.data_pin === result.clock_pin) throw new Error('HX711-Daten- und Taktpin müssen verschieden sein.');
      for (const gpio of [result.data_pin, result.clock_pin]) {
        if (discretePins.has(gpio)) throw new Error('Sensor-GPIOs dürfen sich nicht überschneiden.');
        discretePins.add(gpio);
      }
      return result;
    }
    result.pin = pin(source.pin, 'Sensor-GPIO');
    if (discretePins.has(result.pin)) throw new Error('Sensor-GPIOs dürfen sich nicht überschneiden.');
    discretePins.add(result.pin);
    return result;
  });
  const reserved = new Set(discretePins);
  if (i2cPair) {
    const i2cPins = i2cPair.split(':').map(Number);
    if (i2cPins.some((pin) => discretePins.has(pin))) {
      throw new Error('Diskreter Sensor-GPIO überlappt den I²C-Bus.');
    }
    i2cPins.forEach((value) => reserved.add(value));
  }
  const pins = Array.isArray(config.pins) ? config.pins : [];
  const binary = pins.length ? validateBinaryConfig({ device_type: 'binary_io', pins }, manifest).pins : [];
  if (binary.some((entry) => reserved.has(entry.pin))) throw new Error('Binary-GPIO überlappt einen Sensorbus.');
  const result = { device_type: 'sensors', sensors, pins: binary };
  if (Object.prototype.hasOwnProperty.call(config, 'revision')) result.revision = strictInteger(config.revision, 0, 0xffffffff, 'Revision');
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
  SENSOR_RUNTIME_PROFILE, FINGERPRINT_RUNTIME_PROFILE, IR_RUNTIME_PROFILE,
  RUNTIME_PROFILES, supportedRuntimeProfile,
  clamp, finite, strictFinite, bounded, integer, strictInteger,
  validateDeviceId, validateInstanceId, validatePort, validateProtocol,
  compatibleProtocol, parseSemVer, compareSemVer, color, colorStops, scale,
  interpolateColor, validateHardwareConfig, validateOutputConfig, validateBinaryConfig,
  validateSensorConfig, SENSOR_TYPES, validateFingerprintConfig, validateIrConfig,
  FINGERPRINT_LED_SCENES, FINGERPRINT_LED_EFFECTS, FINGERPRINT_LED_COLORS,
  validateOpaqueId,
  ARGB_OPERATORS, ARGB_OPERATOR_LABELS,
  numericValue, comparableText, validateArgbCondition, argbConditionActive,
  argbOutputPinRoles, argbOutputPins,
};
