'use strict';

const { Discovery } = require('./discovery');
const { HdpClient, HdpError } = require('./client');
const { RuntimeConnection, connectionErrorMessage } = require('./runtime');
const { LegacyRuntimeAdapter, runtimePayload } = require('./legacy-runtime');
const { OutputClient } = require('./output-client');
const {
  renderPercentageFrame, compileIndicatorTimeline, scaleColor,
} = require('./renderer');
const {
  finite, bounded, scale, interpolateColor, colorStops, validateHardwareConfig,
  validateDeviceId, RUNTIME_PROFILE, BINARY_RUNTIME_PROFILE, SENSOR_RUNTIME_PROFILE,
  FINGERPRINT_RUNTIME_PROFILE, SENSOR_TYPES,
  FINGERPRINT_LED_SCENES, FINGERPRINT_LED_EFFECTS, FINGERPRINT_LED_COLORS,
  ARGB_OPERATORS, ARGB_OPERATOR_LABELS, validateArgbCondition, argbConditionActive,
  argbOutputPinRoles, argbOutputPins,
} = require('./validation');
const {
  createAdapterNonce, createBindingKey, validateBindingKey, bindingId,
} = require('./auth');
const {
  validateArtifactFile, uploadFirmware,
} = require('./firmware');
const { ReleaseStore, CHANNELS: releaseChannels } = require('./release-store');
const crypto = require('crypto');

const PROTOCOL_VERSION = '1.0-draft';
const SECRET_PREFIX = 'device-';
// Wie lange nach dem OTA-Neustart auf die Bestätigung des Geräts gewartet wird.
// Gemessen an einem D1 mini, der Image kopieren, Konfiguration vervollständigen,
// Pins einrichten und WLAN aufbauen muss: rund 70 Sekunden. Ein endgültiger
// Fehlschlag des Geräts bricht die Wartezeit ohnehin sofort ab.
const kRestartVerificationMilliseconds = 180000;

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

// Ein leeres Formularfeld ist keine Null, sondern eine fehlende Angabe.
// `Number('')` liefert 0 — ohne diese Abfrage würde ein geleertes Feld also
// still als 0 gespeichert statt auf seinen Standardwert zurückzufallen.
function number(value, fallback) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return fallback;
  const n = Number(text);
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
    dimming_switch: { topic: '', value: '1', dimming_percent: 80 },
    indicator: {
      rising_topic: '', falling_topic: '',
      sweep_milliseconds: 600, pulse_interval_milliseconds: 4000, dimming_percent: 40,
    },
    display: { fractional_pixel: true },
    binary: {},
    argb: {},
    fingerprint: {},
  };
}

// Ein LED-Platz der Statusanzeige: ein State, ein Einschaltkriterium und die
// beiden Farben. Grün/aus ist die Erwartung an eine Statusanzeige.
function defaultArgbBinding() {
  return {
    topic: '',
    operator: 'equals',
    value: '1',
    value_max: '',
    color_on: { r: 0, g: 255, b: 0 },
    color_off: { r: 0, g: 0, b: 0 },
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
    dimming_switch: { ...base.dimming_switch, ...(input.dimming_switch || {}) },
    indicator: { ...base.indicator, ...(input.indicator || {}) },
    display: { ...base.display, ...(input.display || {}) },
    binary: input.binary && typeof input.binary === 'object'
      ? Object.fromEntries(Object.entries(input.binary).map(([pin, binding]) => [pin, { ...(binding || {}) }]))
      : {},
    argb: input.argb && typeof input.argb === 'object'
      ? Object.fromEntries(Object.entries(input.argb).map(([index, binding]) => [index, { ...(binding || {}) }]))
      : {},
    fingerprint: input.fingerprint && typeof input.fingerprint === 'object'
      ? Object.fromEntries(Object.entries(input.fingerprint).map(([id, binding]) => [id, { ...(binding || {}) }]))
      : {},
  };
}

function binaryBoolean(value, label = 'Binary-Wert') {
  if (value === true || value === 1 || value === '1'
      || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'on') return true;
  if (value === false || value === 0 || value === '0'
      || String(value).toLowerCase() === 'false' || String(value).toLowerCase() === 'off') return false;
  throw new Error(`${label} muss einen Booleanwert liefern.`);
}

function normalizeBinaryBindings(bindings, hardwareConfig) {
  const source = bindings && bindings.binary && typeof bindings.binary === 'object'
    ? bindings.binary : {};
  const result = {};
  for (const pin of (hardwareConfig && Array.isArray(hardwareConfig.pins) ? hardwareConfig.pins : [])) {
    const current = source[String(pin.pin)] || {};
    result[String(pin.pin)] = pin.direction === 'output'
      ? {
        topic: String(current.topic || '').trim(),
        invert: current.invert === true,
      }
      : {
        topic: String(current.topic || '').trim(),
        action: ['state', 'toggle', 'set', 'counter'].includes(current.action)
          ? current.action : (pin.input_type === 'button' ? 'toggle' : 'state'),
        set_value: Object.prototype.hasOwnProperty.call(current, 'set_value') ? current.set_value : true,
        counter_step: Number.isFinite(Number(current.counter_step)) ? Number(current.counter_step) : 1,
      };
  }
  return result;
}

function binaryEventTarget(binding, currentValue, eventState) {
  if (binding.action === 'state') return !!eventState;
  if (binding.action === 'set') return binding.set_value;
  if (binding.action === 'toggle') return !binaryBoolean(currentValue, 'Binary-Topic');
  if (binding.action === 'counter') {
    const current = Number(currentValue);
    if (!Number.isFinite(current)) throw new Error('Counter-Topic ist nicht numerisch.');
    return current + Number(binding.counter_step);
  }
  throw new Error('Unbekannte Binary-Eingangsaktion.');
}

function normalizeFingerprintBinding(source) {
  const current = source && typeof source === 'object' ? source : {};
  return {
    name: String(current.name || '').trim().slice(0, 100),
    topic: String(current.topic || '').trim(),
    action: ['toggle', 'set', 'counter'].includes(current.action) ? current.action : 'toggle',
    set_value: Object.prototype.hasOwnProperty.call(current, 'set_value') ? current.set_value : true,
    counter_step: Number.isFinite(Number(current.counter_step)) ? Number(current.counter_step) : 1,
  };
}

function normalizeFingerprintBindings(bindings) {
  const source = bindings && bindings.fingerprint && typeof bindings.fingerprint === 'object'
    ? bindings.fingerprint : {};
  const result = {};
  for (const [id, binding] of Object.entries(source)) {
    const templateId = Number(id);
    if (Number.isInteger(templateId) && templateId >= 0 && templateId < 256) {
      result[String(templateId)] = normalizeFingerprintBinding(binding);
    }
  }
  return result;
}

// <input type="color"> liefert und erwartet #rrggbb; intern rechnet hDP mit
// RGB-Kanälen.
function hexColor(value, fallback) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value == null ? '' : value).trim());
  if (!match) return { ...fallback };
  const number = parseInt(match[1], 16);
  return { r: (number >> 16) & 0xff, g: (number >> 8) & 0xff, b: number & 0xff };
}

function colorHex(color) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
    .toString(16).padStart(2, '0');
  const source = color && typeof color === 'object' ? color : {};
  return `#${channel(source.r)}${channel(source.g)}${channel(source.b)}`;
}

function argbColor(value, fallback) {
  const source = value && typeof value === 'object' ? value : {};
  const channel = (raw, standard) => {
    const number = Math.round(Number(raw));
    return Number.isFinite(number) ? Math.max(0, Math.min(255, number)) : standard;
  };
  return {
    r: channel(source.r, fallback.r),
    g: channel(source.g, fallback.g),
    b: channel(source.b, fallback.b),
  };
}

// Verknüpfungen ohne State sind keine Zuordnung, sondern ein leerer Platz. Sie
// werden nicht persistiert; erst dadurch bleibt ein 300-LED-Strang mit drei
// belegten LEDs auch als gespeicherter Datensatz klein und übersichtlich.
function normalizeArgbBindings(bindings, pixelCount) {
  const source = bindings && bindings.argb && typeof bindings.argb === 'object'
    ? bindings.argb : {};
  const result = {};
  for (const [key, entry] of Object.entries(source)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= pixelCount) continue;
    const current = entry && typeof entry === 'object' ? entry : {};
    const topic = String(current.topic || '').trim();
    if (!topic) continue;
    const standard = defaultArgbBinding();
    result[String(index)] = {
      topic,
      operator: ARGB_OPERATORS.includes(current.operator) ? current.operator : standard.operator,
      value: current.value == null ? standard.value : String(current.value).trim(),
      value_max: current.value_max == null ? '' : String(current.value_max).trim(),
      color_on: argbColor(current.color_on, standard.color_on),
      color_off: argbColor(current.color_off, standard.color_off),
    };
  }
  return result;
}

// Aus den Verknüpfungen wird ein vollständiges Bild: Jede LED ohne Zuordnung
// bleibt dunkel, jede zugeordnete zeigt An- oder Aus-Farbe ihres Kriteriums.
function renderArgbFrame(device) {
  const pixelCount = argbPixelCount(device);
  const pixels = Array.from({ length: pixelCount }, () => ({ r: 0, g: 0, b: 0 }));
  const states = {};
  for (const [key, binding] of Object.entries(device.bindings.argb || {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= pixelCount) continue;
    const active = argbConditionActive(
      binding, device.argbValues ? device.argbValues[key] : undefined,
    );
    states[key] = active;
    pixels[index] = { ...(active ? binding.color_on : binding.color_off) };
  }
  return { pixels, states };
}

// Beide Verknüpfungslisten hängen an der Hardwarekonfiguration: Pins beim
// Binary-I/O, LED-Plätze beim ARGB-Ausgang. Nach jedem Konfigurationsabgleich
// müssen sie gemeinsam nachgezogen werden. Weil beide Pixeltypen dieselbe
// Pixelzahl melden, überlebt eine LED-Zuordnung den Wechsel zwischen
// Prozentanzeige und ARGB-Ausgang unverändert.
function normalizeDeviceBindings(device, hardwareConfig) {
  device.bindings.binary = normalizeBinaryBindings(device.bindings, hardwareConfig);
  device.bindings.argb = normalizeArgbBindings(
    device.bindings, argbPixelCount({ hardwareConfig }),
  );
  device.bindings.fingerprint = normalizeFingerprintBindings(device.bindings);
}

function validateDimmingSwitch(bindings) {
  const dimmingSwitch = bindings.dimming_switch || {};
  dimmingSwitch.topic = String(dimmingSwitch.topic || '').trim();
  dimmingSwitch.value = dimmingSwitch.value == null
    ? '' : String(dimmingSwitch.value).trim();
  dimmingSwitch.dimming_percent = require('./validation').integer(
    dimmingSwitch.dimming_percent, 0, 100, 'Dimmschalter-Dimmung',
  );
  if (dimmingSwitch.topic && !dimmingSwitch.value) {
    throw new Error('Dimmschalter-Vergleichswert fehlt.');
  }
  if (dimmingSwitch.topic) Object.assign(dimmingSwitch, sourceParts(dimmingSwitch.topic));
  bindings.dimming_switch = dimmingSwitch;
  return bindings;
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
  delete copy.pairingInProgress;
  delete copy.sourceTimes;
  delete copy.outputClient;
  delete copy.legacyOutput;
  delete copy.renderQueue;
  delete copy.pendingRender;
  delete copy.binaryTopicValues;
  delete copy.binaryStates;
  delete copy.binaryOutputDesired;
  delete copy.binaryOutputRunning;
  delete copy.argbValues;
  delete copy.argbStates;
  delete copy.fingerprintTopicValues;
  delete copy.rawDimmingSwitch;
  return copy;
}

function clearAppliedOutputError(device) {
  if (!device || !/^(?:\[OUTPUT_[A-Z0-9_]+\]|\[REQUEST_TIMEOUT\])/.test(String(device.lastError || ''))) return false;
  device.lastError = '';
  return true;
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
    device.brightnessBeforeDimming = Math.round(value);
    const dimmingSwitch = device.bindings.dimming_switch || {};
    device.dimmingSwitchActive = !!dimmingSwitch.topic && argbConditionActive({
      operator: 'equals', value: dimmingSwitch.value,
    }, device.rawDimmingSwitch);
    if (device.dimmingSwitchActive) {
      value *= (100 - bounded(
        dimmingSwitch.dimming_percent, 0, 100, 'Dimmschalter-Dimmung',
      )) / 100;
    }
    // homeESS-Quellen dürfen Prozentwerte mit Nachkommastellen liefern (z. B.
    // die Prognose-Helligkeit). hDP überträgt die Plugin-Helligkeit als
    // ganzzahligen Prozentwert; deshalb erst an dieser Protokollgrenze runden.
    return Math.round(value);
  }

function hardwareBrightnessLimit(device) {
  const config = device && device.hardwareConfig;
  const output = config && Array.isArray(config.outputs) ? config.outputs[0] : null;
  const value = output && output.maximum_brightness_percent != null
    ? output.maximum_brightness_percent
    : config && config.power && config.power.maximum_brightness_percent;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 100;
}

function effectiveDynamicBrightness(device, limit = hardwareBrightnessLimit(device)) {
  if (!device || device.requestedBrightness == null) return null;
  const dynamic = Number(device.requestedBrightness);
  const maximum = Number(limit);
  if (!Number.isFinite(dynamic) || !Number.isFinite(maximum)) return null;
  return Math.round(dynamic * maximum / 100);
}

function normalizedPercentage(value) {
  const boundedValue = bounded(value, 0, 100, 'Prozentwert');
  return Math.round((boundedValue + Number.EPSILON) * 1000) / 1000;
}

function calculateState(device) {
  device.calculatedPercentage = normalizedPercentage(scale(device.rawPercentage, device.bindings.percentage));
  device.calculatedColor = displayColor(device);
  device.requestedBrightness = dynamicBrightness(device);
  device.effectiveBrightness = effectiveDynamicBrightness(
    device, device.reportedBrightnessLimit == null
      ? hardwareBrightnessLimit(device) : device.reportedBrightnessLimit,
  );
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

function bindingNeedsReconcile(device, found) {
  return device.pairingInProgress !== true
    && (device.bindingState !== 'active'
    || device.paired !== true
    || found.pairingState !== 'paired'
    || !device.bindingId
    || found.bindingId !== device.bindingId);
}

function requestedDeviceName(input, fallback = '') {
  return String((input && input.device_name) || fallback || '')
    .trim().slice(0, 100);
}

const DEVICE_TYPES = Object.freeze([
  'percentage_indicator', 'argb_output', 'binary_io', 'sensors', 'fingerprint_reader',
]);
const DEVICE_TYPE_LABELS = Object.freeze({
  percentage_indicator: 'Prozentanzeige',
  argb_output: 'ARGB-Ausgang',
  binary_io: 'Binary-I/O',
  sensors: 'Sensoren',
  fingerprint_reader: 'Fingerabdrucksensor',
});
// Prozentanzeige und ARGB-Ausgang teilen sich Hardwareprofil und Laufzeit-
// profil; sie unterscheiden sich ausschließlich darin, wie homeESS die Pixel
// berechnet. Nur Binary-I/O ist eine eigene Laufzeitschicht.
const PIXEL_DEVICE_TYPES = Object.freeze(['percentage_indicator', 'argb_output']);
const CHANNEL_LABELS = Object.freeze({
  stable: 'Stabil', beta: 'Beta', development: 'Entwicklung',
});
const DEFAULT_BINARY_PIN_SLOTS = 5;
const SENSOR_I2C_TYPES = Object.freeze(['bme280', 'sht30', 'sht31', 'bh1750', 'ina219', 'vl53l0x']);
const SENSOR_GPIO_TYPES = Object.freeze(['dht11', 'dht22', 'ds18b20', 'hx711']);
const SENSOR_CALIBRATION_TYPES = Object.freeze(['hx711', 'analog']);

function sensorUiFields(sensorType) {
  if (!SENSOR_TYPES.includes(sensorType)) return [];
  const fields = ['identity', 'interval'];
  if (SENSOR_I2C_TYPES.includes(sensorType)) fields.push('i2c');
  if (SENSOR_GPIO_TYPES.includes(sensorType)) fields.push('data_gpio');
  if (sensorType === 'hx711') fields.push('clock_gpio');
  if (sensorType === 'analog') fields.push('adc');
  if (SENSOR_CALIBRATION_TYPES.includes(sensorType)) fields.push('calibration');
  return fields;
}

// Der Gerätetyp ist exklusiv — ein Gerät ist Prozentanzeige, ARGB-Ausgang oder
// Binary-I/O, niemals mehreres. Maßgeblich ist die persistierte Hardware-
// konfiguration: Das Runtime-Profil folgt ihr erst, nachdem das Gerät den
// Typwechsel übernommen hat. Bis dahin würde eine Auswertung des Profils den
// bereits abgewählten Typ weiterlaufen lassen — und zwischen den beiden
// Pixeltypen unterscheidet das Profil ohnehin nicht.
function deviceTypeOf(device) {
  const config = device && device.hardwareConfig;
  if (config && typeof config === 'object') {
    // Der ausgewiesene Typ hat Vorrang. `pins` allein taugt nicht mehr als
    // Erkennungsmerkmal, seit auch der ARGB-Ausgang Binary-Rollen führt.
    if (config.device_type === 'binary_io') return 'binary_io';
    if (config.device_type === 'argb_output') return 'argb_output';
    if (config.device_type === 'sensors') return 'sensors';
    if (config.device_type === 'fingerprint_reader') return 'fingerprint_reader';
    if (typeof config.device_type === 'string' && config.device_type) return 'percentage_indicator';
    if (Array.isArray(config.pins)) return 'binary_io';
  }
  return device && device.runtimeProfile === BINARY_RUNTIME_PROFILE
    ? 'binary_io' : device && device.runtimeProfile === SENSOR_RUNTIME_PROFILE
      ? 'sensors' : device && device.runtimeProfile === FINGERPRINT_RUNTIME_PROFILE
        ? 'fingerprint_reader' : 'percentage_indicator';
}

function isBinaryDevice(device) {
  return deviceTypeOf(device) === 'binary_io';
}

function isArgbDevice(device) {
  return deviceTypeOf(device) === 'argb_output';
}

function isSensorDevice(device) {
  return deviceTypeOf(device) === 'sensors';
}

function isFingerprintDevice(device) {
  return deviceTypeOf(device) === 'fingerprint_reader';
}

// Beide Typen belegen GPIOs als Binary-Ein- und -Ausgänge und teilen sich
// deshalb die gesamte Binary-Verarbeitung: Bindungen, Abonnements, Ereignisse,
// Ausgangswünsche und States. Für die Seitenauswahl bleibt `isBinaryDevice`
// maßgeblich — nur `binary_io` ist ein reines Binary-Gerät.
function hasBinaryIo(device) {
  return isBinaryDevice(device) || isArgbDevice(device)
    || ((isSensorDevice(device) || isFingerprintDevice(device)) && device.hardwareConfig
      && Array.isArray(device.hardwareConfig.pins) && device.hardwareConfig.pins.length > 0);
}

// Die Zahl der ansteuerbaren LEDs steht ausschließlich in der Hardware-
// konfiguration des Geräts; sie ist damit frei wählbar und begrenzt zugleich,
// wie viele States überhaupt verknüpft werden können.
function argbPixelCount(device) {
  const config = device && device.hardwareConfig;
  const output = config && Array.isArray(config.outputs) ? config.outputs[0] : null;
  const count = output && Number(output.pixel_count);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

// Ein Gerät bietet nur die Typen an, die sein Manifest ausweist. Ältere
// opaque-id-v1-Geräte kennen ausschließlich die Prozentanzeige.
function supportedDeviceTypes(manifest) {
  const declared = manifest && Array.isArray(manifest.device_types) ? manifest.device_types : null;
  if (!declared || !declared.length) return ['percentage_indicator'];
  const supported = DEVICE_TYPES.filter((type) => declared.includes(type));
  return supported.length ? supported : ['percentage_indicator'];
}

// Ein Wartungsfenster darf über Mitternacht laufen; dann liegt das Ende vor dem
// Start und der zulässige Bereich ist die Vereinigung beider Tageshälften.
// Ohne aktiviertes Fenster gilt jede Uhrzeit.
// Während einer OTA-Transaktion weist das Gerät jede Ausgangsänderung mit
// DEVICE_BUSY zurück. Der Wunschzustand wird trotzdem gemerkt und nach dem
// Update angewendet — nur die aussichtslose Übertragung entfällt.
function otaInProgress(device) {
  const progress = device && device.otaProgress;
  return !!(progress && ['uploading', 'ready_to_restart', 'restarting'].includes(progress.state));
}

// Eine laufende OTA-Transaktion kann einen Adapterneustart nicht überleben:
// insbesondere geht die nur im Speicher gehaltene Zuordnung zum Release
// verloren. Persistierte Zwischenzustände dürfen den Updateknopf deshalb nach
// dem Neustart nicht dauerhaft sperren.
function releaseInterruptedOta(device) {
  if (!otaInProgress(device)) return false;
  device.otaProgress = {
    state: 'failed',
    progress_percent: 0,
    message: 'Vorheriger Updatevorgang wurde unterbrochen; ein neuer Versuch ist möglich.',
  };
  return true;
}

// Ein gescheitertes Update wird im Adapter gemerkt, damit der Fehlschlag
// sichtbar bleibt und nicht spurlos verschwindet. Maßgeblich ist aber immer das
// Gerät: Meldet es selbst keinen gescheiterten OTA-Vorgang mehr, ist der
// gemerkte Fehlschlag überholt. Ohne diesen Abgleich klebte er dauerhaft an
// einem längst aktualisierten Gerät — etwa wenn der Fehlschlag nur in der
// Nachverifikation lag und das Gerät danach doch sauber hochkam. Ein laufendes
// Update bleibt unangetastet; dessen Zustand gehört updateFirmware.
function reconcileOtaProgress(device, status, updateRunning = false) {
  if (!device || !device.otaProgress || device.otaProgress.state !== 'failed') return false;
  if (updateRunning) return false;
  if (!status || status.state === 'failed') return false;
  device.otaProgress = null;
  return true;
}

function insideMaintenanceWindow(window, now = new Date()) {
  if (!window || !window.enabled) return true;
  const minutes = (value, fallback) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return fallback;
    const total = Number(match[1]) * 60 + Number(match[2]);
    return total >= 0 && total < 1440 ? total : fallback;
  };
  const start = minutes(window.start, 0);
  const end = minutes(window.end, 0);
  if (start === end) return true;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function binaryPinSlots(manifest) {
  const limit = manifest && manifest.limits && manifest.limits.maximum_binary_pins;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_BINARY_PIN_SLOTS;
  return Math.min(limit, 32);
}

function configuredOutput(device) {
  const config = device && device.hardwareConfig;
  if (config && Array.isArray(config.outputs) && config.outputs[0]) return config.outputs[0];
  if (!config || !config.hardware) return null;
  return {
    pin: config.hardware.argb_pin,
    pixel_count: config.hardware.led_count,
    driver: config.hardware.led_type,
    color_order: config.hardware.color_order,
    reverse: config.hardware.reverse,
    maximum_brightness_percent: config.power && config.power.maximum_brightness_percent,
    maximum_current_milliamps: config.power && config.power.maximum_current_milliamps,
    current_per_pixel_milliamps: config.power && config.power.current_per_led_milliamps,
    offline_mode: config.offline && config.offline.mode,
  };
}

function stateValue(value) {
  return value == null ? '' : value;
}

const SENSOR_VALUE_META = Object.freeze({
  temperature_millicelsius: ['Temperatur', '°C', 0.001],
  humidity_millipercent: ['Luftfeuchtigkeit', '%', 0.001],
  pressure_pascal: ['Luftdruck', 'hPa', 0.01],
  illuminance_millilux: ['Beleuchtungsstärke', 'lx', 0.001],
  bus_voltage_microvolts: ['Busspannung', 'V', 0.000001],
  shunt_voltage_microvolts: ['Shuntspannung', 'mV', 0.001],
  current_microamps: ['Strom', 'A', 0.000001],
  power_microwatts: ['Leistung', 'W', 0.000001],
  raw: ['Messwert', '', 1],
  distance_millimeters: ['Entfernung', 'mm', 1],
});

function applySensorSample(device, sample) {
  if (!sample || !sample.sensor_id) return;
  device.sensorSamples = device.sensorSamples || {};
  const calibration = device.sensorCalibration && device.sensorCalibration[sample.sensor_id]
    ? device.sensorCalibration[sample.sensor_id] : {};
  const values = {};
  for (const [key, raw] of Object.entries(sample.values || {})) {
    const meta = SENSOR_VALUE_META[key];
    if (!meta) continue;
    let value = Number(raw) * meta[2];
    if (key === 'raw') {
      value = value * Number(calibration.scale == null ? 1 : calibration.scale)
        + Number(calibration.offset == null ? 0 : calibration.offset);
    }
    values[key] = value;
  }
  device.sensorSamples[sample.sensor_id] = {
    sensor_type: sample.sensor_type, sequence: sample.sample_sequence,
    captured_at_uptime_milliseconds: sample.captured_at_uptime_milliseconds,
    status: sample.status, error: sample.error, values,
  };
}

// States-Baum, State-Picker und Geräteseite leiten sich aus demselben,
// gerätetypspezifischen Schema ab. So können keine Laufzeitwerte mehr in der
// allgemeinen Statusgruppe oder bei einem unpassenden Gerätetyp verbleiben.
function deviceStateChannels(device) {
  const root = `devices/${encodeURIComponent(device.deviceId)}`;
  const type = deviceTypeOf(device);
  const output = configuredOutput(device);
  const state = (suffix, name, value, unit = '') => ({
    address: `${root}/${suffix}`, name, value: stateValue(value), ...(unit ? { unit } : {}),
  });
  const channels = [{
    address: 'status', name: 'Status', states: [
      state('online', 'Online', !!device.online),
      state('connection-state', 'Verbindungszustand', device.connectionState || (device.online ? 'connected' : 'offline')),
      state('next-reconnect', 'Nächster Verbindungsversuch', device.nextReconnectAt),
      state('wifi-connected', 'WLAN verbunden', device.wifiConnected),
      state('rssi', 'WLAN-Signal', device.rssi, 'dBm'),
      state('ip-address', 'IP-Adresse', device.ipAddress || device.address),
      state('device-type', 'Gerätetyp', type),
      state('platform', 'Plattform', device.platform),
      state('firmware-version', 'Firmwareversion', (device.firmwareInfo && device.firmwareInfo.version) || device.firmwareVersion),
      state('config-revision', 'Konfigurationsrevision', device.configRevision),
      state('uptime', 'Gerätelaufzeit', device.uptimeSeconds, 's'),
      state('free-heap', 'Freier Arbeitsspeicher', device.freeHeapBytes, 'B'),
      state('last-reset-reason', 'Letzter Resetgrund', device.lastBoot && device.lastBoot.reset_reason),
      state('config-load-status', 'Hardwareprofil-Ladestatus', device.lastBoot && device.lastBoot.config_load_status),
      state('last-error', 'Letzter Fehler', device.lastError),
    ],
  }];

  // Diese Werte beschreiben das gespeicherte Hardwareprofil und sind nur bei
  // Gerätetypen mit physischem Pixel-Ausgang sinnvoll.
  if (PIXEL_DEVICE_TYPES.includes(type) && output) {
    channels[0].states.push(
      state('hardware/data-pin', 'ARGB-Datenpin', output.pin),
      state('hardware/pixel-count', 'LED-Anzahl', output.pixel_count),
      state('hardware/driver', 'LED-Typ', output.driver),
      state('hardware/color-order', 'Farbreihenfolge', output.color_order),
      state('hardware/reverse', 'Ausgaberichtung umgekehrt', output.reverse),
      state('hardware/maximum-brightness', 'Maximalhelligkeit', output.maximum_brightness_percent, '%'),
      state('hardware/maximum-current', 'Maximalstrom', output.maximum_current_milliamps, 'mA'),
      state('hardware/current-per-pixel', 'Strom je LED', output.current_per_pixel_milliamps, 'mA'),
      state('hardware/offline-mode', 'Verhalten bei Verbindungsverlust', output.offline_mode),
    );
  }

  if (type === 'percentage_indicator') {
    channels.push({ address: 'percentage-indicator', name: 'Prozentanzeige', states: [
      state('percentage', 'Prozentwert', device.calculatedPercentage, '%'),
      state('color', 'Farbe', device.calculatedColor
        ? `${device.calculatedColor.r},${device.calculatedColor.g},${device.calculatedColor.b}` : ''),
      state('requested-brightness', 'Angeforderte Helligkeit', device.requestedBrightness, '%'),
      state('brightness-before-dimming', 'Helligkeit vor Dimmung', device.brightnessBeforeDimming, '%'),
      state('dimming-switch-active', 'Dimmschalter aktiv', !!device.dimmingSwitchActive),
      state('dimming-percent', 'Dimmschalter-Dimmung', device.bindings.dimming_switch.dimming_percent, '%'),
      state('indicator-direction', 'Richtungsindikator', device.indicatorDirection || 'off'),
      state('output-mode', 'Ausgabemodus', device.outputMode),
      state('timeline-id', 'Aktive Timeline', device.activeTimelineId),
      state('effective-brightness', 'Effektive Helligkeit', device.effectiveBrightness, '%'),
      state('estimated-current', 'Geschätzter Strom', device.estimatedCurrent, 'mA'),
      state('power-limited', 'Strombegrenzung aktiv', device.powerLimited),
    ] });
  } else if (type === 'argb_output') {
    channels.push({ address: 'argb-output', name: 'ARGB-Ausgang', states: [
      state('requested-brightness', 'Angeforderte Helligkeit', device.requestedBrightness, '%'),
      state('brightness-before-dimming', 'Helligkeit vor Dimmung', device.brightnessBeforeDimming, '%'),
      state('dimming-switch-active', 'Dimmschalter aktiv', !!device.dimmingSwitchActive),
      state('dimming-percent', 'Dimmschalter-Dimmung', device.bindings.dimming_switch.dimming_percent, '%'),
      state('output-mode', 'Ausgabemodus', device.outputMode),
      state('effective-brightness', 'Effektive Helligkeit', device.effectiveBrightness, '%'),
      state('estimated-current', 'Geschätzter Strom', device.estimatedCurrent, 'mA'),
      state('power-limited', 'Strombegrenzung aktiv', device.powerLimited),
    ] });
    const ledStates = Object.keys(device.bindings && device.bindings.argb ? device.bindings.argb : {})
      .map(Number).filter(Number.isInteger).sort((left, right) => left - right)
      .map((index) => state(`argb/led-${index}`, `LED ${index + 1}`,
        device.argbStates && device.argbStates[String(index)]));
    if (ledStates.length) channels.push({ address: 'argb-leds', name: 'LED-Zustände', states: ledStates });
  }

  if (hasBinaryIo(device)) {
    const pins = device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [];
    for (const direction of ['input', 'output']) {
      const pinStates = pins.filter((pin) => pin.direction === direction).map((pin) => state(
        `binary/pin-${pin.pin}`,
        direction === 'input'
          ? `GPIO ${pin.pin} (${pin.input_type === 'button' ? 'Taster' : 'Schalter'})`
          : `GPIO ${pin.pin}`,
        device.binaryStates && device.binaryStates[String(pin.pin)],
      ));
      if (pinStates.length) channels.push({
        address: direction === 'input' ? 'binary-inputs' : 'binary-outputs',
        name: direction === 'input' ? 'Binary-Eingänge' : 'Binary-Ausgänge',
        states: pinStates,
      });
    }
  }
  if (type === 'sensors') {
    for (const sensor of (device.hardwareConfig && Array.isArray(device.hardwareConfig.sensors)
      ? device.hardwareConfig.sensors : [])) {
      const sample = device.sensorSamples && device.sensorSamples[sensor.sensor_id];
      const sensorStates = [
        state(`sensors/${sensor.sensor_id}/status`, 'Status', sample ? sample.status : 'not_sampled'),
        state(`sensors/${sensor.sensor_id}/error`, 'Fehler', sample && sample.error),
        state(`sensors/${sensor.sensor_id}/sequence`, 'Messfolge', sample && sample.sequence),
      ];
      for (const [key, value] of Object.entries(sample && sample.values ? sample.values : {})) {
        const meta = SENSOR_VALUE_META[key];
        if (meta) sensorStates.push(state(`sensors/${sensor.sensor_id}/${key}`, meta[0], value, meta[1]));
      }
      channels.push({
        address: `sensor-${sensor.sensor_id}`,
        name: `${sensor.sensor_id} (${sensor.sensor_type})`, states: sensorStates,
      });
    }
  }
  if (type === 'fingerprint_reader') {
    const fingerprint = device.fingerprintStatus || {};
    const last = device.lastFingerprint || {};
    channels.push({ address: 'fingerprint', name: 'Fingerabdrucksensor', states: [
      state('fingerprint/module-online', 'R503 bereit', fingerprint.online),
      state('fingerprint/enrolling', 'Anlernen aktiv', fingerprint.enrolling),
      state('fingerprint/template-count', 'Gespeicherte Vorlagen', fingerprint.count),
      state('fingerprint/capacity', 'Vorlagenkapazität', fingerprint.capacity),
      state('fingerprint/last-template-id', 'Zuletzt erkannte Vorlagen-ID', last.template_id),
      state('fingerprint/last-confidence', 'Letzte Konfidenz', last.confidence),
      state('fingerprint/last-unknown', 'Letzte Erkennung unbekannt', !!last.unknown),
      state('fingerprint/last-error', 'R503-Fehler', fingerprint.last_error),
    ] });
  }
  return channels;
}

function deviceStateCatalog(device) {
  const deviceName = device.name || device.deviceId;
  return deviceStateChannels(device).flatMap((channel) => channel.states.map(({ value, ...state }) => ({
    ...state, category: `${deviceName} / ${channel.name}`,
  })));
}

function deviceStateValues(device) {
  return deviceStateChannels(device).flatMap((channel) => channel.states.map((state) => ({
    address: state.address, value: state.value,
  })));
}

function applyDeviceStatus(device, status) {
  if (!device || !status || typeof status !== 'object') return;
  if (typeof status.wifi_connected === 'boolean') device.wifiConnected = status.wifi_connected;
  if (Object.prototype.hasOwnProperty.call(status, 'ip_address')) device.ipAddress = status.ip_address;
  if (Number.isInteger(status.uptime_seconds)) device.uptimeSeconds = status.uptime_seconds;
  if (Number.isInteger(status.free_heap_bytes)) device.freeHeapBytes = status.free_heap_bytes;
  if (status.last_boot && typeof status.last_boot === 'object') device.lastBoot = status.last_boot;
  const rssi = status.wifi_rssi_dbm == null
    ? (status.wifi_rssi == null ? status.rssi : status.wifi_rssi)
    : status.wifi_rssi_dbm;
  if (rssi != null || ['wifi_rssi_dbm', 'wifi_rssi', 'rssi']
    .some((key) => Object.prototype.hasOwnProperty.call(status, key))) device.rssi = rssi;
  if (Number.isInteger(status.config_revision)) device.configRevision = status.config_revision;
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
  let rolloutPoll = null;
  let rolloutRunning = false;
  let managementBase = '';
  const devices = new Map();
  const discovered = new Map();
  const pendingFirmware = new Map();
  const activeFirmwareUpdates = new Set();
  const releaseStore = new ReleaseStore();
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
      type: deviceTypeOf(device),
      generation: device.platform || '',
      online: !!device.online,
      channels: device.paired ? deviceStateChannels(device).map((channel) => ({
        address: channel.address,
        name: channel.name,
        states: channel.states.map(({ value, ...state }) => state),
      })) : [{ address: 'status', name: 'Discovery', states: [] }],
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
      host.error(`hDP-Persistenz: ${error.message}`);
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
    host.publishStates(deviceStateValues(device));
  }

  function setError(device, error, context) {
    const code = error && error.code ? `[${error.code}] ` : '';
    device.lastError = `${code}${error && error.message ? error.message : String(error)}`.slice(0, 500);
    host.error(`${context || 'hDP'} ${device.deviceId}: ${device.lastError}`);
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

  function binaryPin(device, pinNumber) {
    return device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins.find((pin) => pin.pin === Number(pinNumber)) : null;
  }

  function queueBinaryOutput(device, pinNumber, state) {
    const key = String(pinNumber);
    device.binaryOutputDesired = device.binaryOutputDesired || {};
    device.binaryOutputRunning = device.binaryOutputRunning || {};
    device.binaryOutputDesired[key] = !!state;
    if (otaInProgress(device)) return;
    if (device.binaryOutputRunning[key]) return;
    device.binaryOutputRunning[key] = true;
    (async () => {
      while (Object.prototype.hasOwnProperty.call(device.binaryOutputDesired, key)) {
        const desired = device.binaryOutputDesired[key];
        delete device.binaryOutputDesired[key];
        if (!device.connection || !device.connection.ready) return;
        const response = await device.connection.request('binary.output.set', {
          pin: Number(pinNumber), state: desired,
          config_revision: device.configRevision,
        });
        device.binaryStates = device.binaryStates || {};
        device.binaryStates[key] = response.payload.state;
        publishDevice(device);
      }
    })().catch((error) => setError(device, error, `Binary-Ausgang GPIO ${pinNumber}`))
      .finally(() => {
        device.binaryOutputRunning[key] = false;
        if (Object.prototype.hasOwnProperty.call(device.binaryOutputDesired, key)) {
          queueBinaryOutput(device, pinNumber, device.binaryOutputDesired[key]);
        }
      });
  }

  // Nach dem Ende einer OTA-Transaktion die zwischenzeitlich zurückgehaltenen
  // Ausgangswünsche nachziehen. Nach einem erfolgreichen Update erledigt das
  // ohnehin die zurückkehrende Sitzung; nach einem Fehlschlag gäbe es sonst
  // keinen Anlass mehr.
  function flushBinaryOutputs(device) {
    if (otaInProgress(device)) return;
    for (const [key, desired] of Object.entries(device.binaryOutputDesired || {})) {
      queueBinaryOutput(device, Number(key), desired);
    }
  }

  function applyBinaryOutputs(device) {
    for (const pin of (device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [])) {
      if (pin.direction !== 'output') continue;
      const key = String(pin.pin);
      if (!device.binaryTopicValues
          || !Object.prototype.hasOwnProperty.call(device.binaryTopicValues, key)) continue;
      const binding = device.bindings.binary[key];
      const active = binaryBoolean(device.binaryTopicValues[key], `GPIO ${pin.pin} Topic`);
      queueBinaryOutput(device, pin.pin, binding.invert ? !active : active);
    }
  }

  async function applyBinaryInputEvent(device, payload) {
    const pin = binaryPin(device, payload.pin);
    if (!pin || pin.direction !== 'input') return;
    const key = String(pin.pin);
    device.binaryStates = device.binaryStates || {};
    device.binaryStates[key] = payload.state;
    publishDevice(device);
    const binding = device.bindings.binary[key];
    if (!binding || !binding.topic) return;
    device.binaryTopicValues = device.binaryTopicValues || {};
    if (['toggle', 'counter'].includes(binding.action)) {
      if (!Object.prototype.hasOwnProperty.call(device.binaryTopicValues, key)) {
        throw new Error(`GPIO ${pin.pin}: Topic-Zustand ist noch unbekannt.`);
      }
    }
    const target = binaryEventTarget(binding, device.binaryTopicValues[key], payload.state);
    await host.writeState(binding.topic, target);
    device.binaryTopicValues[key] = target;
  }

  function handleBinaryMessage(device, message) {
    const payload = message.payload;
    if (payload.config_revision !== device.configRevision) {
      host.warn(`hDP ${device.deviceId}: Binary-Nachricht für Revision ${payload.config_revision} ignoriert.`);
      return;
    }
    device.binaryStates = device.binaryStates || {};
    if (message.type === 'binary.input.snapshot' || message.type === 'binary.status') {
      for (const entry of [...payload.inputs, ...payload.outputs]) {
        device.binaryStates[String(entry.pin)] = entry.state;
      }
      publishDevice(device);
      return;
    }
    if (message.type === 'binary.output.applied') {
      device.binaryStates[String(payload.pin)] = payload.state;
      publishDevice(device);
      return;
    }
    if (message.type === 'binary.input.event') {
      applyBinaryInputEvent(device, payload)
        .catch((error) => setError(device, error, `Binary-Eingang GPIO ${payload.pin}`));
    }
  }

  function handleSensorMessage(device, message) {
    const payload = message.payload;
    if (payload.config_revision !== device.configRevision) {
      host.warn(`hDP ${device.deviceId}: Sensornachricht für Revision ${payload.config_revision} ignoriert.`);
      return;
    }
    if (message.type === 'sensor.sample') applySensorSample(device, payload);
    if (message.type === 'sensor.status') {
      for (const sample of payload.samples) applySensorSample(device, sample);
    }
    publishCatalog();
    publishDevice(device);
  }

  async function applyFingerprintMatch(device, payload) {
    const key = String(payload.template_id);
    const binding = device.bindings.fingerprint && device.bindings.fingerprint[key];
    device.lastFingerprint = {
      template_id: payload.template_id, confidence: payload.confidence,
      occurred_at_uptime_milliseconds: payload.occurred_at_uptime_milliseconds,
      received_at: new Date().toISOString(),
    };
    publishDevice(device);
    if (!binding || !binding.topic) return;
    device.fingerprintTopicValues = device.fingerprintTopicValues || {};
    if (['toggle', 'counter'].includes(binding.action)
        && !Object.prototype.hasOwnProperty.call(device.fingerprintTopicValues, key)) {
      throw new Error(`Finger ${payload.template_id}: Topic-Zustand ist noch unbekannt.`);
    }
    const target = binaryEventTarget(binding, device.fingerprintTopicValues[key], true);
    await host.writeState(binding.topic, target);
    device.fingerprintTopicValues[key] = target;
  }

  function handleFingerprintMessage(device, message) {
    const payload = message.payload;
    if (message.type === 'fingerprint.command.accepted') return;
    if (payload.config_revision !== device.configRevision) {
      host.warn(`hDP ${device.deviceId}: Fingerabdrucknachricht für Revision ${payload.config_revision} ignoriert.`);
      return;
    }
    if (message.type === 'fingerprint.status') {
      device.fingerprintStatus = {
        online: payload.online, enrolling: payload.enrolling, capacity: payload.capacity,
        count: payload.template_count, occupied: payload.occupied_slots, last_error: payload.last_error,
      };
      if (device.pendingFingerprintBinding && !payload.enrolling) {
        device.pendingFingerprintBinding = null;
        persist();
      }
    } else if (message.type === 'fingerprint.match') {
      applyFingerprintMatch(device, payload)
        .catch((error) => setError(device, error, `Finger ${payload.template_id}`));
    } else if (message.type === 'fingerprint.unknown') {
      device.lastFingerprint = { unknown: true, received_at: new Date().toISOString() };
    } else if (message.type === 'fingerprint.enroll.status') {
      device.fingerprintStatus = {
        ...(device.fingerprintStatus || {}),
        enrolling: !['complete', 'cancelled', 'enrollment', 'runtime'].includes(payload.stage)
          && !payload.error,
      };
      device.fingerprintEnrollment = {
        stage: payload.stage, template_id: payload.template_id,
        error: payload.error, updated_at: new Date().toISOString(),
      };
      if (payload.stage === 'complete' && Number.isInteger(payload.template_id)) {
        const key = String(payload.template_id);
        device.bindings.fingerprint[key] = normalizeFingerprintBinding(
          device.pendingFingerprintBinding || {},
        );
        device.pendingFingerprintBinding = null;
        subscribeSources(device);
        persist();
      } else if (['cancelled', 'enrollment'].includes(payload.stage) || payload.error) {
        device.pendingFingerprintBinding = null;
        persist();
      }
      if (payload.stage === 'runtime' && payload.error) {
        device.fingerprintStatus = {
          ...(device.fingerprintStatus || {}), online: false, last_error: payload.error,
        };
      }
    } else if (message.type === 'fingerprint.template.deleted') {
      delete device.bindings.fingerprint[String(payload.template_id)];
      subscribeSources(device);
      persist();
    }
    publishCatalog();
    publishDevice(device);
  }

  function subscribeBinarySources(device) {
    device.binaryTopicValues = device.binaryTopicValues || {};
    for (const pin of (device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [])) {
      const key = String(pin.pin);
      const binding = device.bindings.binary[key];
      if (!binding || !binding.topic) continue;
      const unsubscribe = host.subscribeState(binding.topic, (value) => {
        device.binaryTopicValues[key] = value;
        if (pin.direction === 'output') {
          try {
            const active = binaryBoolean(value, `GPIO ${pin.pin} Topic`);
            queueBinaryOutput(device, pin.pin, binding.invert ? !active : active);
          } catch (error) {
            setError(device, error, `Binary-Ausgang GPIO ${pin.pin}`);
          }
        }
      });
      device.unsubscribers.push(unsubscribe);
    }
  }

  function subscribeFingerprintSources(device) {
    device.fingerprintTopicValues = device.fingerprintTopicValues || {};
    for (const [key, binding] of Object.entries(device.bindings.fingerprint || {})) {
      if (!binding.topic) continue;
      const unsubscribe = host.subscribeState(binding.topic, (value) => {
        device.fingerprintTopicValues[key] = value;
      });
      device.unsubscribers.push(unsubscribe);
    }
  }

  // Beide Pixel-Gerätetypen schreiben ihren Wunschzustand nach pendingRender
  // und lassen ihn von genau einer Schleife zustellen. Ein während der
  // Übertragung nachrückender Zustand ersetzt den wartenden, statt sich
  // aufzustauen — die Anzeige folgt so immer dem jüngsten Stand.
  function drainRenderQueue(device) {
    if (device.renderQueue) return;
    device.renderQueue = (async () => {
      while (device.pendingRender) {
        const pending = device.pendingRender;
        device.pendingRender = null;
        if (!device.connection || !device.connection.ready || !device.outputClient) continue;
        if (pending.runtimeBrightness != null) {
          await device.outputClient.setRuntimeBrightness(
            pending.outputId, pending.runtimeBrightness,
          );
        }
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
        if (clearAppliedOutputError(device)) publishDevice(device);
      }
    })().catch((error) => {
      device.lastError = `[${error.code || 'OUTPUT'}] ${error.message}`;
      host.error(`hDP-Output ${device.deviceId}: ${device.lastError}`);
      publishDevice(device);
    }).finally(() => {
      device.renderQueue = null;
      if (device.pendingRender) drainRenderQueue(device);
    });
  }

  // Die Statusanzeige rechnet ausschließlich hier: Aus den verknüpften States
  // und ihren Einschaltkriterien entsteht ein vollständiger Frame. Das Gerät
  // kennt weder States noch Kriterien, es zeigt nur das fertige Bild.
  function applyArgbRuntime(device) {
    const output = device.hardwareConfig && device.hardwareConfig.outputs
      && device.hardwareConfig.outputs[0];
    if (!output) throw new Error('Kein generischer hDP-Ausgang konfiguriert.');
    const { pixels, states } = renderArgbFrame(device);
    device.argbStates = states;
    const nativeRuntimeBrightness = device.manifest.features.runtime_brightness === true;
    const brightness = dynamicBrightness(device);
    device.requestedBrightness = brightness;
    device.effectiveBrightness = effectiveDynamicBrightness(
      device, device.reportedBrightnessLimit == null
        ? hardwareBrightnessLimit(device) : device.reportedBrightnessLimit,
    );
    device.pendingRender = {
      outputId: output.output_id,
      pixels: nativeRuntimeBrightness
        ? pixels : pixels.map((pixel) => scaleColor(pixel, brightness / 100)),
      direction: null,
      runtimeBrightness: nativeRuntimeBrightness ? brightness : null,
    };
    drainRenderQueue(device);
  }

  // Jede LED hängt an genau einem State; derselbe State darf mehrere LEDs
  // versorgen. Der Rohwert wird gemerkt, damit ein Kriteriumswechsel ohne
  // erneutes Eintreffen des Wertes sofort wirkt.
  function subscribeDimmingSwitch(device) {
    const binding = device.bindings.dimming_switch || {};
    if (!binding.topic) {
      device.rawDimmingSwitch = undefined;
      return;
    }
    const unsubscribe = host.subscribeState(binding.topic, (value) => {
      device.rawDimmingSwitch = value;
      try {
        applyRuntime(device);
      } catch (err) {
        device.lastError = `Dimmschalter: ${err.message}`;
        publishDevice(device);
      }
    });
    device.unsubscribers.push(unsubscribe);
  }

  function subscribeArgbSources(device) {
    device.argbValues = device.argbValues || {};
    for (const [key, binding] of Object.entries(device.bindings.argb || {})) {
      if (!binding || !binding.topic) continue;
      const unsubscribe = host.subscribeState(binding.topic, (value) => {
        device.argbValues[key] = value;
        applyRuntime(device);
      });
      device.unsubscribers.push(unsubscribe);
    }
    if (device.bindings.brightness.mode === 'separate_numeric_source'
        && device.bindings.brightness.topic) {
      const unsubscribe = host.subscribeState(device.bindings.brightness.topic, (value) => {
        try {
          device.rawBrightness = finite(value, 'Helligkeitsquelle');
          applyRuntime(device);
        } catch (err) {
          device.lastError = `Helligkeitsquelle: ${err.message}`;
          publishDevice(device);
        }
      });
      device.unsubscribers.push(unsubscribe);
    }
    subscribeDimmingSwitch(device);
  }

  function applyRuntime(device) {
    try {
      if (isBinaryDevice(device) || isSensorDevice(device) || isFingerprintDevice(device)) {
        publishDevice(device);
        return;
      }
      if (isArgbDevice(device)) {
        if (/^(Datenquelle:|Helligkeitsquelle:|Dimmschalter:|Statusquelle)/.test(device.lastError || '')) {
          device.lastError = '';
        }
        applyArgbRuntime(device);
        publishDevice(device);
        return;
      }
      const state = calculateState(device);
      if (/^(Datenquelle:|Prozentquelle:|Prozentwertquelle liefert|Farbquelle:|Helligkeitsquelle:|Dimmschalter:|Keine Prozentwertquelle)/.test(device.lastError || '')) {
        device.lastError = '';
      }
      if (device.runtimeProfile === RUNTIME_PROFILE) {
        const output = device.hardwareConfig && device.hardwareConfig.outputs
          && device.hardwareConfig.outputs[0];
        if (!output) throw new Error('Kein generischer hDP-Ausgang konfiguriert.');
        const nativeRuntimeBrightness = device.manifest.features.runtime_brightness === true;
        const pixels = renderPercentageFrame({
          pixelCount: output.pixel_count,
          percentage: state.percentage,
          color: state.color,
          brightness: nativeRuntimeBrightness ? 100 : state.brightness,
          fractional: device.bindings.display.fractional_pixel,
        });
        const direction = device.rawRising && !device.rawFalling ? 'rising'
          : device.rawFalling && !device.rawRising ? 'falling' : null;
        device.indicatorDirection = direction;
        device.pendingRender = {
          outputId: output.output_id,
          pixels,
          direction,
          runtimeBrightness: nativeRuntimeBrightness ? state.brightness : null,
        };
        drainRenderQueue(device);
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
    if (isSensorDevice(device)) {
      if (hasBinaryIo(device)) subscribeBinarySources(device);
      return;
    }
    if (isFingerprintDevice(device)) {
      subscribeFingerprintSources(device);
      if (hasBinaryIo(device)) subscribeBinarySources(device);
      return;
    }
    if (isBinaryDevice(device)) {
      subscribeBinarySources(device);
      return;
    }
    if (isArgbDevice(device)) {
      subscribeArgbSources(device);
      // Derselbe Gerätetyp führt zusätzlich die Binary-Rollen der übrigen
      // GPIOs; deren Abonnements laufen unverändert über den Binary-Pfad.
      subscribeBinarySources(device);
      if (!Object.keys(device.bindings.argb || {}).length) {
        device.lastError = 'Noch keine LED mit einem State verknüpft.';
      }
      return;
    }
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
    subscribeDimmingSwitch(device);
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
        normalizeDeviceBindings(device, remote);
        subscribeSources(device);
        publishCatalog();
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
      if (hasBinaryIo(device)) applyBinaryOutputs(device);
      if (isSensorDevice(device)) {
        connection.request('sensor.status.get', {}, 5000)
          .catch((error) => setError(device, error, 'Sensorstatus'));
      }
      if (isFingerprintDevice(device)) {
        connection.request('fingerprint.status.get', {}, 5000)
          .catch((error) => setError(device, error, 'Fingerabdruckstatus'));
      }
      applyRuntime(device);
      // Ein zurückgekehrtes Gerät sofort prüfen, statt bis zum nächsten Takt zu
      // warten — sonst wäre „Update nach Wiederkehr nachholen“ eine Minute
      // langsamer als nötig.
      runRollout().catch((error) => host.error(`hDP Rollout: ${error.message}`));
    });
    connection.on('offline', () => {
      device.online = false;
      device.wifiConnected = null;
      device.rssi = null;
      device.reportedBrightnessLimit = null;
      device.effectiveBrightness = null;
      device.estimatedCurrent = null;
      device.powerLimited = null;
      if (hasBinaryIo(device)) {
        device.binaryStates = device.binaryStates || {};
        for (const pin of (device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
          ? device.hardwareConfig.pins : [])) {
          if (pin.direction === 'output') device.binaryStates[String(pin.pin)] = false;
        }
      }
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
      host.warn(`hDP ${device.deviceId}: Verbindungsversuch ${event.attempt} in ${event.delay} ms`
        + (event.error ? ` (${connectionErrorMessage(event.error)})` : ''));
    });
    connection.on('status', (status) => {
      applyDeviceStatus(device, status);
      const nativeRuntimeBrightness = device.manifest && device.manifest.features
        && device.manifest.features.runtime_brightness === true;
      if (!nativeRuntimeBrightness && status.effective_brightness != null) {
        device.reportedBrightnessLimit = status.effective_brightness;
      }
      device.effectiveBrightness = nativeRuntimeBrightness
        ? status.effective_brightness
        : effectiveDynamicBrightness(
          device, device.reportedBrightnessLimit == null
            ? hardwareBrightnessLimit(device) : device.reportedBrightnessLimit,
        );
      device.estimatedCurrent = status.estimated_current_milliamps;
      device.powerLimited = status.power_limit_active;
      publishDevice(device);
    });
    connection.on('applied', (status) => {
      if (status.effective_brightness != null) {
        device.reportedBrightnessLimit = status.effective_brightness;
      }
      device.effectiveBrightness = effectiveDynamicBrightness(
        device, device.reportedBrightnessLimit == null
          ? hardwareBrightnessLimit(device) : device.reportedBrightnessLimit,
      );
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
    connection.on('binary', (message) => handleBinaryMessage(device, message));
    connection.on('sensor', (message) => handleSensorMessage(device, message));
    connection.on('fingerprint', (message) => handleFingerprintMessage(device, message));
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
      host.warn(`hDP ${device.deviceId}: ${device.lastError}`);
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
    const restoredBindingState = record.bindingState || (record.paired ? 'active' : 'pending');
    const device = {
      ...record, bindingKey, bindings: mergeBindings(record.bindings),
      updateSettings: { ...defaultUpdateSettings(), ...(record.updateSettings || {}) },
      bindingState: restoredBindingState,
      // Ein bereits bestätigtes lokales Binding bleibt auch vor der ersten
      // Discovery sichtbar. Nur die Erreichbarkeit ist nach einem Neustart
      // zunächst unbekannt/offline; mDNS gleicht den Zustand anschließend ab.
      paired: restoredBindingState === 'active',
      online: false, discoveredOnline: false, connectionState: 'offline',
      reconnectAttempt: 0, nextReconnectAt: null,
      wifiConnected: null, rssi: null, uptimeSeconds: null, freeHeapBytes: null,
      effectiveBrightness: null, estimatedCurrent: null, powerLimited: null,
      reportedBrightnessLimit: null,
      unsubscribers: [],
    };
    releaseInterruptedOta(device);
    normalizeDeviceBindings(device, device.hardwareConfig);
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
      const firmwareChanged = !!local.manifest && !!found.firmwareVersion
        && local.firmwareVersion !== found.firmwareVersion;
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
        local.lastError = `[UNSUPPORTED_RUNTIME_PROFILE] Gerät meldet ${found.runtimeProfile}; unterstützt werden pixel-timeline-v1, binary-io-v1, sensor-reading-v1 und fingerprint-event-v1.`;
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
      if (firmwareChanged) {
        // Eine neue Firmware darf andere Fähigkeiten, GPIOs und Limits melden.
        // Ohne diesen Abgleich zeigte die Verwaltung nach einem OTA dauerhaft
        // das zwischengespeicherte Manifest der Vorgängerversion.
        refreshManifest(local).catch((error) => setError(local, error, 'Manifestabgleich'));
      }
      if (local.connection && addressChanged) local.connection.updateDevice(local);
      const restoredConnectionMissing = local.bindingState === 'active'
        && local.paired === true && !local.connection;
      if (bindingNeedsReconcile(local, found) || restoredConnectionMissing) {
        reconcileBinding(local).catch((error) => setError(local, error, 'Binding-Abgleich'));
      }
      publishDevice(local);
    }
    persist();
  }

  // Das Manifest beschreibt die Fähigkeiten genau einer Firmwareversion und
  // wird persistiert. Es darf deshalb nur aus einer frischen Abfrage oder aus
  // dem Pairingergebnis stammen, niemals aus dem eigenen Zwischenspeicher.
  async function refreshManifest(device) {
    const manifest = await clientFor(device).manifest();
    device.manifest = manifest;
    clientFor(device).manifestInfo = manifest;
    if (device.outputClient) device.outputClient.manifest = manifest;
    persist();
    publishDevice(device);
    return manifest;
  }

  async function activate(device, result) {
    device.manifest = result.manifest || await clientFor(device).manifest();
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
    applyDeviceStatus(device, deviceStatus);
    device.recoveryRequired = !!(device.lastBoot
      && ['invalid', 'storage_unavailable'].includes(device.lastBoot.config_load_status));
    device.lastError = '';
    device.bindings = mergeBindings(device.bindings);
    normalizeDeviceBindings(device, device.hardwareConfig);
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
        if (device.bindingState !== 'active' || !device.paired || !device.connection) {
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
      throw Object.assign(new Error(`Runtime-Profil ${found.runtimeProfile} ist inkompatibel; unterstützt werden pixel-timeline-v1, binary-io-v1, sensor-reading-v1 und fingerprint-event-v1.`), {
        code: 'UNSUPPORTED_RUNTIME_PROFILE', status: 426,
      });
    }
    const existing = devices.get(deviceId);
    if (found.pairingState === 'paired' && (!existing || existing.bindingState !== 'pending')) {
      throw Object.assign(new Error('Gerät ist bereits mit einer Instanz gekoppelt.'), { code: 'ALREADY_PAIRED' });
    }
    const device = existing && existing.bindingState === 'pending' ? existing : {
      ...found, name: found.hostname || deviceId,
      bindingState: 'pending', paired: false,
      adapterNonce: createAdapterNonce(), bindingKey: createBindingKey(),
      bindings: defaultBindings(),
      updateSettings: { ...defaultUpdateSettings(), ...(config.globalUpdateSettings || {}) },
      online: !!found.online, unsubscribers: [],
    };
    if (device.pairingInProgress) {
      throw Object.assign(new Error('Für dieses Gerät läuft bereits eine Kopplung.'), {
        code: 'DEVICE_BUSY', status: 423,
      });
    }
    device.pairingInProgress = true;
    host.log(`Pairing gestartet: ${deviceId}`);
    try {
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
    } finally {
      device.pairingInProgress = false;
    }
  }

  async function saveHardwareConfig(deviceId, input) {
    const device = requirePaired(deviceId);
    const requestedName = requestedDeviceName(input, device.name);
    const manifest = device.manifest || await clientFor(device).manifest();
    const capabilities = device.runtimeProfile ? manifest : {
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
      normalizeDeviceBindings(device, result);
      device.name = requestedName || device.name;
      device.configOrigin = 'homeess';
      if (device.outputClient) device.outputClient.sessionStarted();
      subscribeSources(device);
      publishCatalog();
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
    return validateDimmingSwitch(bindings);
  }

  function validateBinaryBindings(device, input) {
    const bindings = mergeBindings(input);
    const source = input && input.binary && typeof input.binary === 'object'
      ? input.binary : {};
    for (const pin of (device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [])) {
      const current = source[String(pin.pin)] || {};
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`GPIO ${pin.pin}: Binding ist ungültig.`);
      }
      if (pin.direction === 'output' && current.invert != null
          && typeof current.invert !== 'boolean') {
        throw new Error(`GPIO ${pin.pin}: invert muss ein Booleanwert sein.`);
      }
      if (pin.direction === 'input') {
        if (current.action != null
            && !['state', 'toggle', 'set', 'counter'].includes(current.action)) {
          throw new Error(`GPIO ${pin.pin}: unbekannte Eingangsaktion.`);
        }
        if (current.action === 'set'
            && (typeof current.set_value === 'undefined'
              || (current.set_value !== null && typeof current.set_value === 'object'))) {
          throw new Error(`GPIO ${pin.pin}: Setzwert muss ein skalarer JSON-Wert sein.`);
        }
        if (current.action === 'counter'
            && (!Number.isFinite(Number(current.counter_step))
              || Number(current.counter_step) === 0)) {
          throw new Error(`GPIO ${pin.pin}: Counter-Schritt muss numerisch und ungleich null sein.`);
        }
      }
    }
    bindings.binary = normalizeBinaryBindings({ binary: source }, device.hardwareConfig);
    return bindings;
  }

  function validateArgbBindings(device, input) {
    const bindings = mergeBindings(input);
    const pixelCount = argbPixelCount(device);
    const source = input && input.argb && typeof input.argb === 'object' ? input.argb : {};
    const assigned = {};
    for (const [key, entry] of Object.entries(source)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= pixelCount) {
        throw new Error(`LED ${key}: Es gibt nur ${pixelCount} LEDs auf diesem Strang.`);
      }
      const current = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const topic = String(current.topic || '').trim();
      if (!topic) continue;
      const label = `LED ${index + 1}`;
      const standard = defaultArgbBinding();
      assigned[String(index)] = {
        topic,
        ...validateArgbCondition(current, label),
        color_on: argbColor(current.color_on, standard.color_on),
        color_off: argbColor(current.color_off, standard.color_off),
      };
    }
    // Die Helligkeit teilt sich der ARGB-Ausgang mit der Prozentanzeige; sie
    // begrenzt nur, wie hell das fertige Bild ausgegeben wird.
    if (!['fixed', 'separate_numeric_source'].includes(bindings.brightness.mode)) {
      throw new Error('Ungültiger Helligkeitsmodus.');
    }
    if (bindings.brightness.mode === 'fixed') {
      bounded(bindings.brightness.fixed, 0, 100, 'Dynamische Helligkeit');
    } else {
      if (!bindings.brightness.topic) throw new Error('Helligkeitsquelle fehlt.');
      Object.assign(bindings.brightness, sourceParts(bindings.brightness.topic));
    }
    bindings.argb = assigned;
    // Der ARGB-Ausgang führt zusätzlich Binary-Ein- und -Ausgänge. Sie werden
    // exakt nach denselben Regeln geprüft wie beim reinen Binary-I/O-Gerät.
    bindings.binary = validateBinaryBindings(device, input).binary;
    return validateDimmingSwitch(bindings);
  }

  function validateFingerprintBindings(device, input) {
    const bindings = mergeBindings(input);
    const source = input && input.fingerprint && typeof input.fingerprint === 'object'
      ? input.fingerprint : {};
    for (const [id, current] of Object.entries(source)) {
      const templateId = Number(id);
      if (!Number.isInteger(templateId) || templateId < 0 || templateId >= 256) {
        throw new Error(`Finger-ID ${id} ist ungültig.`);
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`Finger ${id}: Zuordnung ist ungültig.`);
      }
      if (!['toggle', 'set', 'counter'].includes(current.action || 'toggle')) {
        throw new Error(`Finger ${id}: unbekannte Aktion.`);
      }
      if (current.action === 'set'
          && (typeof current.set_value === 'undefined'
            || (current.set_value !== null && typeof current.set_value === 'object'))) {
        throw new Error(`Finger ${id}: Setzwert muss ein skalarer JSON-Wert sein.`);
      }
      if (current.action === 'counter'
          && (!Number.isFinite(Number(current.counter_step)) || Number(current.counter_step) === 0)) {
        throw new Error(`Finger ${id}: Counter-Schritt muss numerisch und ungleich null sein.`);
      }
    }
    bindings.fingerprint = normalizeFingerprintBindings({ fingerprint: source });
    bindings.binary = validateBinaryBindings(device, input).binary;
    return bindings;
  }

  function saveBindings(deviceId, input) {
    const device = requirePaired(deviceId);
    const previousBindings = device.bindings;
    const nextBindings = isBinaryDevice(device) || isSensorDevice(device)
      ? validateBinaryBindings(device, input.bindings || input)
      : isFingerprintDevice(device)
        ? validateFingerprintBindings(device, input.bindings || input)
      : isArgbDevice(device)
        ? validateArgbBindings(device, input.bindings || input)
        : validateBindings(input.bindings || input);
    if (!isBinaryDevice(device) && !isArgbDevice(device) && !isSensorDevice(device)
        && !isFingerprintDevice(device)) {
      resetChangedIndicatorState(device, previousBindings, nextBindings);
    }
    if (!isBinaryDevice(device) && !isSensorDevice(device)
        && previousBindings.dimming_switch.topic !== nextBindings.dimming_switch.topic) {
      device.rawDimmingSwitch = undefined;
    }
    device.bindings = nextBindings;
    device.updateSettings = { ...device.updateSettings, ...(input.updateSettings || {}) };
    stopSubscriptions(device);
    subscribeSources(device);
    publishCatalog();
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
    if (reconcileOtaProgress(device, status, activeFirmwareUpdates.has(device.deviceId))) {
      publishDevice(device);
    }
    persist();
    return { info, status };
  }

  // Welches Release der zentrale Speicher für genau dieses Gerät bereithält.
  // Liefert immer eine Begründung, damit die Oberfläche erklären kann, warum
  // kein Update angeboten wird.
  function firmwareCandidate(device) {
    if (!device.firmwareInfo || !device.firmwareInfo.name) {
      return { available: false, reason: 'Firmwareinformationen wurden noch nicht abgerufen.' };
    }
    const channel = releaseChannels.includes(device.updateSettings.channel)
      ? device.updateSettings.channel : 'stable';
    try {
      return releaseStore.candidateFor(device.firmwareInfo, channel);
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

  function availableFirmwareUpdates() {
    const updates = [];
    for (const device of devices.values()) {
      if (device.bindingState !== 'active' || !device.paired) continue;
      const candidate = firmwareCandidate(device);
      if (candidate.available) updates.push({ device, candidate });
    }
    return updates;
  }

  // Überträgt das zentral hinterlegte Release. Der Ablauf bleibt der normative:
  // lokal prüfen, übertragen, vom Gerät verifizieren lassen — der Neustart
  // folgt erst danach als eigener Schritt.
  async function installFirmware(deviceId, options = {}) {
    const device = requirePaired(deviceId);
    const current = await refreshFirmware(device);
    if (!['idle', 'failed', 'completed'].includes(current.status.state)) {
      throw Object.assign(new Error(`Gerät ist für ein Update nicht bereit (${current.status.state}).`), {
        status: 423, code: 'OTA_ALREADY_RUNNING',
      });
    }
    const channel = options.channel || device.updateSettings.channel;
    const candidate = releaseStore.candidateFor(current.info, channel, {
      allowDowngrade: !!options.allowDowngrade,
    });
    if (!candidate.available) {
      throw Object.assign(new Error(candidate.reason), { status: 409, code: 'OTA_NO_CANDIDATE' });
    }
    const fileCheck = await validateArtifactFile(candidate.file, candidate.artifact, {
      publicKey: releaseStore.publicKey,
    });
    try {
      device.otaProgress = { state: 'uploading', progress_percent: 0 };
      publishDevice(device);
      await uploadFirmware({
        file: candidate.file,
        device,
        firmwareInfo: current.info,
        manifest: candidate.manifest,
        artifact: candidate.artifact,
        credentials: { instanceId: identity.instanceId, bindingKey: device.bindingKey },
        allowDowngrade: !!options.allowDowngrade,
        onProgress(progress) {
          device.otaProgress = {
            state: 'uploading', progress_percent: progress.percent,
            received_bytes: progress.sent, total_bytes: progress.total,
          };
          publishDevice(device);
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
    } catch (error) {
      device.otaProgress = { state: 'failed', progress_percent: 0, message: error.message };
      flushBinaryOutputs(device);
      publishDevice(device);
      throw error;
    }
    pendingFirmware.set(deviceId, {
      manifest: candidate.manifest, artifact: candidate.artifact,
      allowDowngrade: !!options.allowDowngrade,
    });
    persist();
    return { release: candidate.release, artifact: candidate.artifact, fileCheck, status: device.firmwareStatus };
  }

  // Ein Klick: übertragen, verifizieren, neu starten, Erfolg nachweisen.
  async function updateFirmware(deviceId, options = {}) {
    const device = requirePaired(deviceId);
    if (activeFirmwareUpdates.has(deviceId)) {
      throw Object.assign(new Error('Auf dem Gerät läuft bereits ein Update.'), {
        status: 423, code: 'OTA_ALREADY_RUNNING',
      });
    }
    activeFirmwareUpdates.add(deviceId);
    try {
      const prepared = await installFirmware(deviceId, options);
      const verified = await restartFirmware(deviceId);
      return { ...prepared, installed: verified.info };
    } catch (error) {
      // Auch Fehler nach einem erfolgreichen Upload (beim Neustart oder bei der
      // Post-Boot-Prüfung) müssen die lokale Sperre zuverlässig lösen.
      device.otaProgress = {
        state: 'failed', progress_percent: 0, message: error.message,
      };
      pendingFirmware.delete(deviceId);
      flushBinaryOutputs(device);
      publishDevice(device);
      await persist();
      throw error;
    } finally {
      activeFirmwareUpdates.delete(deviceId);
    }
  }

  // Sammelupdates laufen bewusst nacheinander. So konkurrieren die Geräte
  // weder um Uploadbandbreite noch um Adapterzustand; ein einzelner Fehler
  // verhindert trotzdem nicht, dass die übrigen Geräte aktualisiert werden.
  async function updateAllFirmware() {
    const planned = availableFirmwareUpdates();
    const results = [];
    for (const { device, candidate } of planned) {
      const fromVersion = device.firmwareInfo && device.firmwareInfo.version;
      try {
        const result = await updateFirmware(device.deviceId);
        results.push({
          deviceId: device.deviceId,
          name: device.name || device.hostname || device.deviceId,
          status: 'updated',
          fromVersion: fromVersion || null,
          version: result.installed.version,
        });
      } catch (error) {
        results.push({
          deviceId: device.deviceId,
          name: device.name || device.hostname || device.deviceId,
          status: 'failed',
          version: candidate.release.version,
          code: error.code || null,
          error: error.message,
        });
      }
    }
    return {
      total: results.length,
      updated: results.filter((entry) => entry.status === 'updated').length,
      failed: results.filter((entry) => entry.status === 'failed').length,
      results,
    };
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
      host.warn(`hDP ${device.deviceId}: OTA-Neustartantwort verloren; es wird ausschließlich rediscovered und verifiziert.`);
    }
    device.online = false;
    device.otaProgress = { state: 'restarting', progress_percent: 100 };
    publishDevice(device);
    // Post-Boot-Prüfung erfolgt begrenzt und ausschließlich lokal. Ein Gerät
    // braucht nach dem Neustart mehr als eine Minute, wenn es das Image erst
    // kopiert, die Konfiguration vervollständigt, seine Pins einrichtet und
    // danach WLAN, mDNS und WebSocket aufbaut. Jede erfolglose Runde kostet
    // zudem die Wiederholungen des HTTP-Clients. Ein zu enges Fenster meldete
    // deshalb einen Fehlschlag, obwohl das Update sauber durchgelaufen war.
    const deadline = Date.now() + kRestartVerificationMilliseconds;
    let reported = null;
    while (Date.now() < deadline && !stopped) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const current = await refreshFirmware(device);
        // Die Sollversion kennt der Adapter aus dem laufenden Update. Fehlt
        // sie — etwa weil ein Neustart nur bestätigt wird, dessen Upload ein
        // früherer Adapterlauf gemacht hat —, gilt die Zielversion, die das
        // Gerät selbst meldet. Ohne diesen Rückfall könnte der eigenständige
        // Neustartknopf nie einen Erfolg melden.
        const expected = target
          ? target.manifest.release.version : current.status.target_version;
        if (current.status.state === 'completed'
            && (expected == null || current.info.version === expected)) {
          device.otaProgress = { state: 'completed', progress_percent: 100 };
          pendingFirmware.delete(deviceId);
          persist();
          return current;
        }
        reported = current;
        // Das Gerät antwortet wieder und meldet einen endgültigen Fehlschlag.
        // Weiter zu warten brächte nichts und würde den Fehler nur verzögern.
        if (current.status.state === 'failed') break;
      } catch (_) { /* Gerät startet noch */ }
    }
    // Was das Gerät zuletzt gemeldet hat, gehört in die Meldung: Sonst ist
    // nicht unterscheidbar, ob es unerreichbar blieb oder mit einer anderen
    // Version zurückkam.
    const detail = reported
      ? `Gerät meldet Version ${reported.info.version} im Zustand ${reported.status.state}`
        + (reported.status.last_error ? ` (${reported.status.last_error.code})` : '')
      : 'Gerät war innerhalb der Prüfzeit nicht erreichbar';
    throw Object.assign(
      new Error(`Gerät wurde nach dem Firmwareupdate nicht erfolgreich verifiziert. ${detail}.`),
      { code: reported && reported.status.state === 'failed' ? 'OTA_BOOT_VALIDATION_FAILED' : 'DEVICE_OFFLINE' },
    );
  }

  function updateBlockedReason(device, now = new Date()) {
    if (device.updateSettings.mode !== 'automatic') return 'Updatepolitik steht nicht auf automatisch.';
    if (!device.online) return 'Gerät ist nicht erreichbar.';
    if (device.recoveryRequired) return 'Konfigurationsspeicher erfordert Wiederherstellung.';
    if (device.otaProgress && ['uploading', 'ready_to_restart', 'restarting'].includes(device.otaProgress.state)) {
      return 'Ein Update läuft bereits.';
    }
    // Ein während der Abwesenheit verpasstes Fenster wird einmalig nachgeholt,
    // sonst bliebe ein Gerät mit nächtlichem Fenster nach längerer Trennung
    // dauerhaft auf einem alten Stand.
    if (!insideMaintenanceWindow(device.updateSettings.maintenance_window, now)
        && !device.missedMaintenanceWindow) {
      return 'Außerhalb des Wartungsfensters.';
    }
    const attempts = device.updateAttempts && device.updateAttempts[device.pendingUpdateVersion];
    const limit = Math.max(0, number(device.updateSettings.retry_count, 0));
    if (attempts != null && attempts > limit) {
      return `Nach ${attempts} Fehlversuchen ausgesetzt; Updatepolitik erlaubt ${limit} Wiederholungen.`;
    }
    return null;
  }

  // Wertet Kanal, Updatepolitik, Wartungsfenster und Wiederholungsgrenze aus.
  // Bis hierher waren diese Einstellungen reine Anzeige ohne Wirkung.
  async function runRollout(now = new Date()) {
    if (stopped || rolloutRunning) return;
    rolloutRunning = true;
    try {
      for (const device of devices.values()) {
        if (stopped) break;
        if (device.bindingState !== 'active' || !device.paired) continue;
        const candidate = firmwareCandidate(device);
        device.updateAvailable = candidate.available ? candidate.release.version : null;
        if (!candidate.available) continue;
        if (device.updateSettings.mode === 'notify_only') {
          publishDevice(device);
          continue;
        }
        if (!device.online && device.updateSettings.update_when_device_returns_online
            && device.updateSettings.mode === 'automatic'
            && insideMaintenanceWindow(device.updateSettings.maintenance_window, now)) {
          device.missedMaintenanceWindow = true;
        }
        const blocked = updateBlockedReason(device, now);
        if (blocked) {
          device.updateBlockedReason = blocked;
          publishDevice(device);
          continue;
        }
        device.updateBlockedReason = null;
        device.pendingUpdateVersion = candidate.release.version;
        device.updateAttempts = device.updateAttempts || {};
        device.updateAttempts[candidate.release.version] =
          (device.updateAttempts[candidate.release.version] || 0) + 1;
        host.log(`hDP ${device.deviceId}: automatisches Update auf ${candidate.release.version} wird installiert.`);
        try {
          await updateFirmware(device.deviceId);
          delete device.updateAttempts[candidate.release.version];
          device.updateAvailable = null;
          device.missedMaintenanceWindow = false;
          device.pendingUpdateVersion = null;
          host.log(`hDP ${device.deviceId}: Update auf ${candidate.release.version} abgeschlossen.`);
        } catch (error) {
          setError(device, error, 'Automatisches Update');
        }
        persist();
      }
    } finally {
      rolloutRunning = false;
    }
  }

  function deviceFromForm(body, existing) {
    const requestedType = String(body.device_type || deviceTypeOf(existing));
    const available = supportedDeviceTypes(existing.manifest);
    if (!available.includes(requestedType)) {
      throw Object.assign(
        new Error(`Das Gerät unterstützt den Gerätetyp ${requestedType} nicht.`),
        { code: 'UNSUPPORTED_DEVICE_TYPE', status: 422 },
      );
    }
    // Der ARGB-Ausgang setzt den generischen Ausgangsvertrag voraus; die
    // Legacy-Ausgabeschicht kennt nur die fertig berechnete Prozentanzeige.
    if (requestedType === 'argb_output' && !existing.runtimeProfile) {
      throw Object.assign(
        new Error('Der ARGB-Ausgang benötigt eine Firmware mit generischem Pixel-Ausgang.'),
        { code: 'UNSUPPORTED_DEVICE_TYPE', status: 422 },
      );
    }
    if (requestedType === 'fingerprint_reader') {
      const defaults = {
        idle: ['breathing', 'blue', 96, 0], scanning: ['on', 'blue', 0, 0],
        success: ['flashing', 'blue', 32, 2], failure: ['flashing', 'red', 32, 2],
        enrolling: ['breathing', 'purple', 64, 0],
      };
      const led = Object.fromEntries(FINGERPRINT_LED_SCENES.map((scene) => {
        const standard = defaults[scene];
        return [scene, {
          effect: FINGERPRINT_LED_EFFECTS.includes(body[`fingerprint_led_effect_${scene}`])
            ? body[`fingerprint_led_effect_${scene}`] : standard[0],
          color: FINGERPRINT_LED_COLORS.includes(body[`fingerprint_led_color_${scene}`])
            ? body[`fingerprint_led_color_${scene}`] : standard[1],
          speed: number(body[`fingerprint_led_speed_${scene}`], standard[2]),
          count: number(body[`fingerprint_led_count_${scene}`], standard[3]),
        }];
      }));
      const pins = [];
      const slots = binaryPinSlots(existing.manifest);
      for (let index = 0; index < slots; index += 1) {
        const rawPin = body[`binary_pin_${index}`];
        if (rawPin == null || String(rawPin).trim() === '') continue;
        const direction = body[`binary_direction_${index}`] === 'output' ? 'output' : 'input';
        pins.push({
          pin: number(rawPin, -1), direction,
          ...(direction === 'input' ? {
            input_type: body[`binary_input_type_${index}`] === 'button' ? 'button' : 'switch',
          } : {}),
        });
      }
      const wakeup = String(body.fingerprint_wakeup_pin == null
        ? '' : body.fingerprint_wakeup_pin).trim();
      return validateHardwareConfig({
        revision: number(body.revision, existing.configRevision || 0),
        device_type: 'fingerprint_reader',
        uart: {
          rx_pin: number(body.fingerprint_rx_pin, 13),
          tx_pin: number(body.fingerprint_tx_pin, 15),
        },
        wakeup_pin: wakeup ? number(wakeup, null) : null,
        led, pins,
      }, existing.manifest);
    }
    if (requestedType === 'sensors') {
      const sensors = [];
      const maximum = existing.manifest && existing.manifest.limits
        ? existing.manifest.limits.maximum_sensors : 8;
      for (let index = 0; index < maximum; index += 1) {
        const sensorType = String(body[`sensor_type_${index}`] || '').trim();
        if (!sensorType) continue;
        const sensor = {
          sensor_id: String(body[`sensor_id_${index}`] || `sensor${index + 1}`).trim(),
          sensor_type: sensorType,
          sample_interval_milliseconds: number(body[`sensor_interval_${index}`],
            sensorType === 'dht22' ? 2000 : sensorType === 'dht11' ? 1000 : 5000),
        };
        if (['bme280', 'sht30', 'sht31', 'bh1750', 'ina219', 'vl53l0x'].includes(sensorType)) {
          const defaultAddress = {
            bme280: 0x76, sht30: 0x44, sht31: 0x44, bh1750: 0x23,
            ina219: 0x40, vl53l0x: 0x29,
          }[sensorType];
          sensor.sda_pin = number(body[`sensor_sda_${index}`], 4);
          sensor.scl_pin = number(body[`sensor_scl_${index}`], 5);
          sensor.address = number(body[`sensor_address_${index}`], defaultAddress);
        } else if (sensorType === 'hx711') {
          sensor.data_pin = number(body[`sensor_pin_${index}`], 12);
          sensor.clock_pin = number(body[`sensor_aux_pin_${index}`], 13);
        } else if (sensorType !== 'analog') {
          sensor.pin = number(body[`sensor_pin_${index}`], 4);
        }
        sensors.push(sensor);
      }
      const pins = [];
      const slots = binaryPinSlots(existing.manifest);
      for (let index = 0; index < slots; index += 1) {
        const rawPin = body[`binary_pin_${index}`];
        if (rawPin == null || String(rawPin).trim() === '') continue;
        const direction = body[`binary_direction_${index}`] === 'output' ? 'output' : 'input';
        pins.push({
          pin: number(rawPin, -1), direction,
          ...(direction === 'input' ? {
            input_type: body[`binary_input_type_${index}`] === 'button' ? 'button' : 'switch',
          } : {}),
        });
      }
      return validateHardwareConfig({
        revision: number(body.revision, existing.configRevision || 0),
        device_type: 'sensors', sensors, pins,
      }, existing.manifest);
    }
    if (requestedType === 'binary_io') {
      const pins = [];
      const slots = binaryPinSlots(existing.manifest);
      for (let index = 0; index < slots; index += 1) {
        const rawPin = body[`binary_pin_${index}`];
        if (rawPin == null || String(rawPin).trim() === '') continue;
        const direction = body[`binary_direction_${index}`] === 'output' ? 'output' : 'input';
        const pin = {
          pin: number(rawPin, -1), direction,
          ...(direction === 'input' ? {
            input_type: body[`binary_input_type_${index}`] === 'button' ? 'button' : 'switch',
          } : {}),
        };
        pins.push(pin);
      }
      return validateHardwareConfig({
        revision: number(body.revision, existing.configRevision || 0),
        device_type: 'binary_io', pins,
      }, existing.manifest);
    }
    if (existing.runtimeProfile) {
      const outputs = existing.hardwareConfig && Array.isArray(existing.hardwareConfig.outputs)
        ? existing.hardwareConfig.outputs : [];
      // Beim ARGB-Ausgang fragt das Formular nur den Eingangstyp je GPIO ab.
      // Die vollständige Liste — Richtungen inklusive — wird hier aus dem
      // Manifest abgeleitet, damit das Gerät sie nie selbst raten muss.
      const pins = requestedType === 'argb_output'
        ? argbOutputPins(
          (existing.manifest && existing.manifest.hardware_capabilities) || {},
          number(body.argb_pin, 2),
          Object.fromEntries(Object.keys(body)
            .map((name) => /^binary_input_type_(\d+)$/.exec(name))
            .filter(Boolean)
            .map((match) => [match[1], body[match[0]]])),
        )
        : undefined;
      return validateHardwareConfig({
        revision: number(body.revision, existing.configRevision || 0),
        device_type: requestedType,
        ...(pins ? { pins } : {}),
        outputs: [{
          output_id: (outputs[0] && outputs[0].output_id) || 'main',
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

  // Die Binary-Felder sehen bei beiden Gerätetypen gleich aus; sie werden
  // deshalb auch nur einmal aus dem Formular gelesen.
  function binaryFromForm(body, device) {
    const binary = {};
    for (const pin of (device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [])) {
      const key = String(pin.pin);
      if (pin.direction === 'output') {
        binary[key] = {
          topic: String(body[`binary_topic_${key}`] || '').trim(),
          invert: bool(body[`binary_invert_${key}`]),
        };
      } else {
        let setValue = true;
        const raw = String(body[`binary_set_value_${key}`] == null
          ? 'true' : body[`binary_set_value_${key}`]);
        try { setValue = JSON.parse(raw); } catch (_) { setValue = raw; }
        binary[key] = {
          topic: String(body[`binary_topic_${key}`] || '').trim(),
          action: String(body[`binary_action_${key}`] || (pin.input_type === 'button' ? 'toggle' : 'state')),
          set_value: setValue,
          counter_step: number(body[`binary_counter_step_${key}`], 1),
        };
      }
    }
    return binary;
  }

  function bindingsFromForm(body, device) {
    if (device && (isBinaryDevice(device) || isSensorDevice(device))) {
      return validateBinaryBindings(device, { binary: binaryFromForm(body, device) });
    }
    if (device && isFingerprintDevice(device)) {
      const fingerprint = { ...(device.bindings.fingerprint || {}) };
      for (const key of Object.keys(fingerprint)) {
        let setValue = true;
        const raw = String(body[`fingerprint_set_value_${key}`] == null
          ? 'true' : body[`fingerprint_set_value_${key}`]);
        try { setValue = JSON.parse(raw); } catch (_) { setValue = raw; }
        fingerprint[key] = {
          name: String(body[`fingerprint_name_${key}`] || '').trim(),
          topic: String(body[`fingerprint_topic_${key}`] || '').trim(),
          action: String(body[`fingerprint_action_${key}`] || 'toggle'),
          set_value: setValue,
          counter_step: number(body[`fingerprint_counter_step_${key}`], 1),
        };
      }
      return validateFingerprintBindings(device, {
        fingerprint, binary: binaryFromForm(body, device),
      });
    }
    if (device && isArgbDevice(device)) {
      const argb = {};
      for (let index = 0; index < argbPixelCount(device); index += 1) {
        const key = String(index);
        argb[key] = {
          topic: String(body[`argb_topic_${key}`] || '').trim(),
          operator: String(body[`argb_operator_${key}`] || 'equals'),
          value: body[`argb_value_${key}`],
          value_max: body[`argb_value_max_${key}`],
          color_on: hexColor(body[`argb_color_on_${key}`], { r: 0, g: 255, b: 0 }),
          color_off: hexColor(body[`argb_color_off_${key}`], { r: 0, g: 0, b: 0 }),
        };
      }
      return validateArgbBindings(device, {
        argb,
        binary: binaryFromForm(body, device),
        brightness: {
          mode: body.brightness_mode || 'fixed',
          fixed: number(body.brightness_fixed, 100),
          topic: String(body.brightness_topic || '').trim(),
          input_min: number(body.brightness_input_min, 0),
          input_max: number(body.brightness_input_max, 100),
          output_min: number(body.brightness_output_min, 0),
          output_max: number(body.brightness_output_max, 100),
          clamp: bool(body.brightness_clamp), invert: bool(body.brightness_invert),
        },
        dimming_switch: {
          topic: String(body.dimming_switch_topic || '').trim(),
          value: String(body.dimming_switch_value == null ? '1' : body.dimming_switch_value).trim(),
          dimming_percent: number(body.dimming_switch_percent, 80),
        },
      });
    }
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
      dimming_switch: {
        topic: String(body.dimming_switch_topic || '').trim(),
        value: String(body.dimming_switch_value == null ? '1' : body.dimming_switch_value).trim(),
        dimming_percent: number(body.dimming_switch_percent, 80),
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

  // `allowed` grenzt die Auswahl weiter ein: Beim ARGB-Ausgang kommen nur
  // GPIOs mit internem Pull-up als Datenpin infrage, weil die übrigen dort
  // fest als Ausgänge geführt werden.
  function gpioOptions(device, selected, allowed = null) {
    const pins = device.manifest && device.manifest.hardware_capabilities
      && device.manifest.hardware_capabilities.argb_pins;
    return (Array.isArray(pins) ? pins : [])
      .filter((pin) => !Array.isArray(allowed) || allowed.includes(pin))
      .map((pin) =>
        `<option value="${pin}"${Number(selected) === Number(pin) ? ' selected' : ''}>GPIO ${pin}</option>`).join('');
  }

  // Kein GPIO wird gesperrt; die Eigenheiten einzelner Pins stehen als Hinweis
  // an der Auswahl, damit beim Verdrahten klar ist, wo etwas zu beachten ist.
  function binaryPinNote(device, pin) {
    const capabilities = (device.manifest && device.manifest.hardware_capabilities) || {};
    const inList = (key) => Array.isArray(capabilities[key]) && capabilities[key].includes(pin);
    const notes = [];
    if (Array.isArray(capabilities.binary_pullup_pins)
        && !capabilities.binary_pullup_pins.includes(pin)) {
      notes.push('externer Pull-up nötig');
    }
    if (inList('binary_boot_sensitive_pins')) notes.push('Boot-Pin');
    if (inList('binary_serial_pins')) notes.push('serielle Konsole');
    return notes.length ? ` · ${notes.join(', ')}` : '';
  }

  function binaryPinLegend(device) {
    const capabilities = (device.manifest && device.manifest.hardware_capabilities) || {};
    const list = (key) => (Array.isArray(capabilities[key]) ? capabilities[key] : []);
    const all = list('binary_pins');
    const withoutPullup = Array.isArray(capabilities.binary_pullup_pins)
      ? all.filter((pin) => !capabilities.binary_pullup_pins.includes(pin)) : [];
    const notes = [];
    if (withoutPullup.length) {
      notes.push(`GPIO ${withoutPullup.join(', ')} besitzen keinen nutzbaren internen Pull-up. Als Eingang brauchen sie einen externen 10k gegen 3V3; als Ausgang sind sie uneingeschränkt nutzbar.`);
    }
    if (list('binary_boot_sensitive_pins').length) {
      notes.push(`GPIO ${list('binary_boot_sensitive_pins').join(', ')} bestimmen den Bootmodus. Ein Schalter, der beim Einschalten bereits geschlossen ist, kann den Start blockieren.`);
    }
    if (list('binary_serial_pins').length) {
      notes.push(`GPIO ${list('binary_serial_pins').join(', ')} sind TX/RX der seriellen Konsole; ihre Nutzung kostet die Debugausgabe.`);
    }
    return notes.length
      ? `<ul class="hdp-pin-legend">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`
      : '';
  }

  function binaryPinRows(device, hardwareConfig) {
    const allowed = device.manifest && device.manifest.hardware_capabilities
      && Array.isArray(device.manifest.hardware_capabilities.binary_pins)
      ? device.manifest.hardware_capabilities.binary_pins : [];
    const configured = hardwareConfig && Array.isArray(hardwareConfig.pins)
      ? hardwareConfig.pins : [];
    return Array.from({ length: binaryPinSlots(device.manifest) }, (_, index) => {
      const current = configured[index] || {};
      const options = ['<option value="">Nicht verwendet</option>'].concat(allowed.map((pin) =>
        `<option value="${pin}"${Number(current.pin) === pin ? ' selected' : ''}>GPIO ${pin}${esc(binaryPinNote(device, pin))}</option>`)).join('');
      return `<div class="hdp-form-grid hdp-binary-pin-row">
        <label class="field">Pin ${index + 1}<select name="binary_pin_${index}">${options}</select></label>
        <label class="field">Richtung<select name="binary_direction_${index}">
          <option value="input"${current.direction !== 'output' ? ' selected' : ''}>Eingang</option>
          <option value="output"${current.direction === 'output' ? ' selected' : ''}>Ausgang</option>
        </select></label>
        <label class="field">Eingangstyp<select name="binary_input_type_${index}">
          <option value="switch"${current.input_type !== 'button' ? ' selected' : ''}>Schalter</option>
          <option value="button"${current.input_type === 'button' ? ' selected' : ''}>Taster</option>
        </select></label>
      </div>`;
    }).join('');
  }

  // Beim ARGB-Ausgang gibt es keine Pinauswahl: Die Belegung folgt zwingend der
  // Hardware. Zu entscheiden bleibt je Eingang nur Taster oder Schalter.
  // Gerendert werden alle Kandidaten; welcher davon als Datenpin wegfällt,
  // blendet das Skript live aus — und der Server verwirft ihn ohnehin.
  function argbPinRoleSection(device, argbPin) {
    const capabilities = (device.manifest && device.manifest.hardware_capabilities) || {};
    const roles = argbOutputPinRoles(capabilities, argbPin);
    if (!roles.all.length || !roles.fixedOutputs.length) return '';
    const configured = device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [];
    const currentType = (pin) => {
      const entry = configured.find((item) => item.pin === pin);
      return entry && entry.input_type === 'button' ? 'button' : 'switch';
    };
    const inputRows = roles.dataCandidates.map((pin) => {
      const note = binaryPinNote(device, pin).replace(/^ · /, '');
      return `<label class="field-block" data-hdp-argb-input="${pin}">GPIO ${pin}<select name="binary_input_type_${pin}">
        <option value="switch"${currentType(pin) === 'switch' ? ' selected' : ''}>Schalter</option>
        <option value="button"${currentType(pin) === 'button' ? ' selected' : ''}>Taster</option>
      </select>${note ? `<span class="form-hint muted">${esc(note)}</span>` : ''}</label>`;
    }).join('');
    return `<section class="dialog-section" data-hdp-type-panel="argb_output">
      <div class="dialog-section-head"><h4>GPIO-Belegung</h4>
        <p class="muted">Die Belegung folgt der Hardware und ist nicht frei wählbar. GPIO ${roles.fixedOutputs.join(' und ')} besitzen keinen nutzbaren internen Pull-up und sind deshalb fest Ausgänge — dort lassen sich Relais oder Schütze schalten. Der oben gewählte Datenpin trägt den LED-Strang. Alle übrigen GPIOs werden Eingänge für Taster oder Schalter: aktiv-low gelesen und 30 ms entprellt.</p>
        ${binaryPinLegend(device)}
      </div>
      <div class="dialog-grid dialog-grid--three" data-hdp-argb-inputs>${inputRows}</div>
    </section>`;
  }

  function binaryBindingRows(device) {
    const bindings = device.bindings.binary || {};
    return (device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : []).map((pin) => {
      const key = String(pin.pin);
      const binding = bindings[key] || {};
      if (pin.direction === 'output') {
        return `<section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">GPIO ${pin.pin} · Ausgang</span><h2>Binary-Ausgang</h2></div>
          <div class="hdp-form-grid"><label class="field hdp-span-full">Topic<input data-state-picker name="binary_topic_${key}" value="${esc(binding.topic || '')}" placeholder="State auswählen"></label></div>
          <div class="hdp-toggle-row"><label><input type="checkbox" name="binary_invert_${key}"${binding.invert ? ' checked' : ''}> Logik invertieren</label></div>
        </section>`;
      }
      return `<section class="settings-card hdp-config-card">
        <div class="settings-card-head"><span class="hdp-section-kicker">GPIO ${pin.pin} · ${pin.input_type === 'button' ? 'Taster' : 'Schalter'}</span><h2>Binary-Eingang</h2></div>
        <div class="hdp-form-grid">
          <label class="field hdp-span-full">Ziel-Topic<input data-state-picker name="binary_topic_${key}" value="${esc(binding.topic || '')}" placeholder="State auswählen"></label>
          <label class="field">Aktion<select name="binary_action_${key}">
            <option value="state"${binding.action === 'state' ? ' selected' : ''}>Eingangszustand übernehmen</option>
            <option value="toggle"${binding.action === 'toggle' ? ' selected' : ''}>Topic umschalten</option>
            <option value="set"${binding.action === 'set' ? ' selected' : ''}>Wert setzen</option>
            <option value="counter"${binding.action === 'counter' ? ' selected' : ''}>Counter erhöhen</option>
          </select></label>
          <label class="field">Setzwert (JSON)<input name="binary_set_value_${key}" value="${esc(JSON.stringify(binding.set_value == null ? null : binding.set_value))}"></label>
          <label class="field">Counter-Schritt<input type="number" step="any" name="binary_counter_step_${key}" value="${esc(binding.counter_step == null ? 1 : binding.counter_step)}"></label>
        </div>
      </section>`;
    }).join('');
  }

  // Eine Zeile je LED des Strangs, in physischer Reihenfolge. Nicht belegte
  // Zeilen bleiben leer und werden beim Speichern verworfen — so ist auch ein
  // langer Strang ohne Zusatzknöpfe vollständig bedienbar.
  function argbBindingRows(device) {
    const bindings = device.bindings.argb || {};
    const pixelCount = argbPixelCount(device);
    const rows = Array.from({ length: pixelCount }, (_, index) => {
      const key = String(index);
      const binding = { ...defaultArgbBinding(), ...(bindings[key] || {}) };
      const operators = ARGB_OPERATORS.map((operator) =>
        `<option value="${operator}"${binding.operator === operator ? ' selected' : ''}>${esc(ARGB_OPERATOR_LABELS[operator])}</option>`).join('');
      // Beschriftet wird per aria-label statt per <label>: Der State-Picker
      // hängt seinen Knopf neben das Topic-Feld, und ein umschließendes <label>
      // würde jeden Klick darauf zusätzlich als Klick aufs Feld auswerten.
      const led = `LED ${index + 1}`;
      // Jede Zelle trägt ihre Spaltenüberschrift mit. Wird die Zeile auf
      // schmalen Anzeigen zur Karte gestapelt, blendet das Stylesheet sie ein —
      // ohne sie hätte man dort sieben unbeschriftete Felder.
      const cell = (label, field) =>
        `<span class="hdp-argb-cell" data-label="${esc(label)}">${field}</span>`;
      return `<div class="hdp-argb-row"${binding.topic ? '' : ' data-hdp-argb-empty'}>
        <span class="hdp-argb-index">${index + 1}</span>
        ${cell('State', `<input data-state-picker name="argb_topic_${key}" value="${esc(binding.topic)}" placeholder="State auswählen" aria-label="${esc(`State für ${led}`)}">`)}
        ${cell('Einschaltkriterium', `<select name="argb_operator_${key}" aria-label="${esc(`Einschaltkriterium für ${led}`)}">${operators}</select>`)}
        ${cell('Wert x', `<input name="argb_value_${key}" inputmode="decimal" value="${esc(binding.value)}" placeholder="x" aria-label="${esc(`Vergleichswert für ${led}`)}">`)}
        ${cell('bis y', `<input name="argb_value_max_${key}" inputmode="decimal" value="${esc(binding.value_max)}" placeholder="y" aria-label="${esc(`Obergrenze für ${led}`)}">`)}
        ${cell('Farbe an', `<input type="color" name="argb_color_on_${key}" value="${esc(colorHex(binding.color_on))}" aria-label="${esc(`Farbe bei erfülltem Kriterium für ${led}`)}">`)}
        ${cell('Farbe aus', `<input type="color" name="argb_color_off_${key}" value="${esc(colorHex(binding.color_off))}" aria-label="${esc(`Farbe bei nicht erfülltem Kriterium für ${led}`)}">`)}
      </div>`;
    }).join('');
    return `<div class="hdp-argb-table">
      <div class="hdp-argb-row hdp-argb-head">
        <span>LED</span><span>State</span><span>Einschaltkriterium</span><span>Wert x</span><span>bis y</span><span>An</span><span>Aus</span>
      </div>
      ${rows}
    </div>`;
  }

  function argbStatusStrip(device) {
    const pixelCount = argbPixelCount(device);
    const bindings = device.bindings.argb || {};
    return Array.from({ length: pixelCount }, (_, index) => {
      const key = String(index);
      const binding = bindings[key];
      if (!binding) return '<i class="hdp-argb-dot" title="Nicht belegt"></i>';
      const active = device.argbStates ? device.argbStates[key] : null;
      const color = colorHex(active ? binding.color_on : binding.color_off);
      return `<i class="hdp-argb-dot is-bound" style="background:${esc(color)}" title="${esc(`LED ${index + 1}: ${binding.topic} — ${active == null ? 'unbekannt' : active ? 'erfüllt' : 'nicht erfüllt'}`)}"></i>`;
    }).join('');
  }

  function rssiSummary(device) {
    if (!device.online || device.rssi == null || device.rssi === '') return '';
    const value = Number(device.rssi);
    if (!Number.isFinite(value)) return '';
    const level = rssiLevel(device);
    const quality = level === 4 ? 'Sehr gut' : level === 3 ? 'Gut' : level === 2 ? 'Ausreichend' : 'Schwach';
    const label = 'WLAN-Signal';
    return `<div class="hdp-device-fact hdp-signal" title="${esc(`${label}: ${quality}, ${value} dBm`)}">
      <span class="hdp-fact-label">${label}</span>
      <span class="hdp-fact-value"><span class="hdp-signal-bars hdp-signal-${level}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${esc(quality)} <small>${esc(value)} dBm</small></span>
    </div>`;
  }

  function rssiLevel(device) {
    if (device.rssi == null || device.rssi === '') return 0;
    const value = Number(device.rssi);
    if (!Number.isFinite(value)) return 0;
    return value >= -50 ? 4 : value >= -60 ? 3 : value >= -70 ? 2 : 1;
  }

  function deviceFacts(device) {
    const firmwareVersion = device.firmwareVersion
      || (device.firmwareInfo && device.firmwareInfo.version);
    const update = device.updateAvailable && device.updateAvailable !== firmwareVersion
      ? `<span class="hdp-update-chip" title="Im Firmwarespeicher liegt eine neuere Version">→ ${esc(device.updateAvailable)}</span>` : '';
    return [
      rssiSummary(device),
      firmwareVersion ? `<div class="hdp-device-fact hdp-device-fact--firmware"><span class="hdp-fact-label">Firmware</span><span class="hdp-fact-value">${esc(firmwareVersion)}${update}</span></div>` : '',
    ].filter(Boolean).join('');
  }

  // Zentrale Firmwareablage. Ein Release-Manifest beschreibt dieselbe Firmware
  // für alle Plattformen und Boards; hochgeladen wird deshalb einmal hier und
  // nicht mehr je Gerät.
  function renderFirmwareSection(store = releaseStore.summary()) {
    const updates = availableFirmwareUpdates();
    const updateAll = updates.length
      ? `<div class="hdp-firmware-head-actions"><button type="button" id="hdp-update-all-button"
          data-armed="0" data-label="Alle aktualisieren (${updates.length})" data-count="${updates.length}"
          onclick="hdpRunUpdateAll(this)">Alle aktualisieren (${updates.length})</button></div>`
      : '';
    // Eine Karte je Kanal statt einer sechsspaltigen Tabelle: Die Tabelle war
    // schon auf dem Notebook nur mit Querscrollen lesbar und auf dem Telefon
    // gar nicht. Karten stapeln sich von selbst.
    const cards = store.map((entry) => {
      const title = `<div class="hdp-channel-head">
        <h3>${esc(CHANNEL_LABELS[entry.channel] || entry.channel)}</h3>
        <span class="status-badge ${!entry.present ? 'status-off' : entry.complete ? 'status-ok' : 'status-warn'}">${!entry.present ? 'Leer' : entry.complete ? 'Vollständig' : 'Artefakt fehlt'}</span>
      </div>`;
      if (!entry.present) {
        return `<article class="hdp-channel-card is-empty">${title}
          <p class="muted">Kein Release hinterlegt.</p>
        </article>`;
      }
      const artifacts = entry.artifacts.map((artifact) => `<li${artifact.stored ? '' : ' class="is-missing"'}>
        <span class="hdp-artifact-name">${esc(artifact.filename)}</span>
        <span class="hdp-artifact-meta">${esc(artifact.platform)}/${esc(artifact.board)}/${esc(artifact.variant)} · ${Math.round(artifact.size_bytes / 1024)} KiB${artifact.signed ? ' · signiert' : ''}${artifact.stored ? '' : ' · <strong>Datei fehlt</strong>'}</span>
      </li>`).join('');
      return `<article class="hdp-channel-card">${title}
        <p class="hdp-channel-version">${esc(entry.release.version)}</p>
        <dl class="hdp-channel-facts">
          <div><dt>Veröffentlicht</dt><dd>${esc(entry.release.published_at || '—')}</dd></div>
          <div><dt>Build</dt><dd>${esc(entry.release.build_id || '—')}</dd></div>
        </dl>
        <ul class="hdp-artifact-list">${artifacts}</ul>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/firmware/channel/${encodeURIComponent(entry.channel)}" onsubmit="return confirm('Release im Kanal ${esc(entry.channel)} wirklich entfernen?');"><button class="button-danger">Entfernen</button></form>
      </article>`;
    }).join('');
    const channelOptions = ['<option value="">Nach Vorgabe im Manifest</option>'].concat(
      releaseChannels.map((channel) =>
        `<option value="${channel}">${esc(CHANNEL_LABELS[channel] || channel)}</option>`),
    ).join('');
    return `<section class="settings-card hdp-device-section hdp-firmware-store">
      <div class="settings-card-head hdp-list-head hdp-firmware-head"><div><h2>Firmware</h2><p class="settings-card-hint">Eine universelle Firmware für alle hDP-Geräte. Release-Manifest und die zugehörigen Artefakte werden hier einmal hinterlegt; die Geräte ziehen daraus den Kanal, der in ihren Updateeinstellungen steht.</p></div>${updateAll}</div>
      <pre id="hdp-update-all-result"></pre>
      <div class="hdp-firmware-body">
        <div class="hdp-upload-grid">
          <label class="field">Release-Manifest (.json)<input type="file" id="hdp-release-manifest" accept=".json,application/json"></label>
          <label class="field">Firmwareartefakt (.bin)<input type="file" id="hdp-release-artifact" accept=".bin,application/octet-stream" multiple></label>
          <label class="field">Kanal<select id="hdp-release-channel">${channelOptions}</select>
            <span class="form-hint muted">Weicht die Auswahl vom Manifest ab, wird es beim Hochladen auf diesen Kanal umgeschrieben und dort abgelegt.</span></label>
        </div>
        <div class="button-row"><button type="button" onclick="hdpStoreFirmware()">In den Firmwarespeicher legen</button></div>
        <pre id="hdp-release-result"></pre>
        <div class="hdp-channel-grid">${cards}</div>
        ${renderUsbFlashHelp()}
      </div>
    </section>`;
  }

  // Erstinbetriebnahme und Rettung laufen über USB. Im Browser ginge das nur mit
  // der Web Serial API — die gibt es ausschließlich in Chromium und nur in einem
  // sicheren Kontext, also unter HTTPS oder auf localhost. Auf einer LAN-Adresse
  // über HTTP existiert `navigator.serial` schlicht nicht. Deshalb übernimmt ein
  // eigenständiges Werkzeug den seriellen Teil und holt sich die Firmware aus
  // genau diesem Speicher.
  // Der Adapterprozess kennt seine Instanznummer nicht direkt; sie steckt im
  // Basispfad, den der Host bei jeder Anfrage mitliefert.
  function publicBasePath() {
    const match = /\/adapter\/instance\/(\d+)\/manage/.exec(managementBase || '');
    return match ? `/adapter-public/${match[1]}` : null;
  }

  function renderUsbFlashHelp() {
    const publicBase = publicBasePath();
    const tools = publicBase ? releaseStore.bundledTools() : [];
    const downloads = tools.length
      ? `<p class="hdp-tool-downloads">${tools.map((tool) =>
        `<a class="module-toggle-btn" href="${publicBase}/assets/${encodeURIComponent(tool.filename)}" download>${esc(tool.filename)} herunterladen <small>${Math.round(tool.size_bytes / 1048576)} MB</small></a>`).join(' ')}</p>`
      : '<p class="settings-card-hint">In dieser Installation liegt kein Flashwerkzeug bei.</p>';
    return `<details class="hdp-usb-flash">
      <summary>Über USB flashen</summary>
      <p class="settings-card-hint">Nötig bei der Erstinbetriebnahme, nach einem Werksreset und für Geräte, deren installierte Firmware ein OTA ablehnt. Das Werkzeug sucht die homeESS-Instanz im lokalen Netz, zieht die oben hinterlegte Firmware, prüft ihre SHA-256 gegen das Manifest und schreibt sie über den seriellen Port.</p>
      ${downloads}
      <pre><code>hdp-flash.exe --list
hdp-flash.exe --channel development</code></pre>
      <p class="settings-card-hint">Die Serveradresse wird beim ersten Start gesucht und danach gemerkt; mit <code>--server</code> lässt sie sich fest vorgeben. Der Flash wird <strong>nicht</strong> gelöscht: WLAN-Zugang, Pairing und Hardwarekonfiguration bleiben erhalten. Für ein werksreines Gerät <code>--erase</code> ergänzen — danach muss das Gerät neu gekoppelt werden.</p>
      <p class="settings-card-hint">Werkzeug und Artefakte liegen unter <code>/adapter-public</code> ohne Anmeldung im lokalen Netz bereit. Im Browser passiert das Flashen bewusst nicht: Die Web Serial API setzt HTTPS oder localhost voraus und existiert nur in Chromium.</p>
    </details>`;
  }

  function deviceSubtitle(device) {
    const network = device.address || device.hostname;
    const details = [];
    if (network) details.push(network);
    if (device.deviceType) details.push(device.deviceType);
    return details.length ? `<p class="hdp-device-subtitle">${details.map(esc).join('<span>·</span>')}</p>` : '';
  }

  function overviewRevision(state) {
    return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  }

  function renderOverview(state = snapshot()) {
    const instanceName = String(host.name || '').trim();
    const byAvailabilityAndName = (left, right) =>
      Number(!!right.online) - Number(!!left.online)
      || String(left.name || left.hostname || left.deviceId).localeCompare(
        String(right.name || right.hostname || right.deviceId), 'de',
      );
    const found = state.found.slice().sort(byAvailabilityAndName);
    const paired = state.paired.slice().sort(byAvailabilityAndName);
    const onlineCount = paired.filter((device) => device.online).length;
    const searchValue = (device) => [
      device.name, device.hostname, device.address, device.deviceId, device.deviceType,
    ].filter(Boolean).join(' ').toLowerCase();
    const pairedRow = (device) => {
      const criticalSignal = device.online && rssiLevel(device) === 1;
      return `<article class="hdp-device-row${device.online ? '' : ' is-offline'}${criticalSignal ? ' has-critical-signal' : ''}" data-hdp-device data-search="${esc(searchValue(device))}">
      <div class="hdp-device-identity">
        <div class="hdp-device-title"><span class="hdp-status-dot" aria-hidden="true"></span><h3>${esc(device.name || device.hostname || device.deviceId)}</h3>
          <span class="status-badge ${device.online ? criticalSignal ? 'status-warn' : 'status-ok' : 'status-off'}">${device.online ? 'Online' : 'Offline'}</span></div>
        ${deviceSubtitle(device)}
      </div>
      <div class="hdp-device-facts">${deviceFacts(device)}</div>
      <a class="module-toggle-btn hdp-manage-link" href="/adapter/instance/INSTANCE/manage/device/${encodeURIComponent(device.deviceId)}">Verwalten <span aria-hidden="true">›</span></a>
      ${device.lastError ? `<p class="hdp-device-alert"><strong>Hinweis:</strong> ${esc(device.lastError)}</p>` : ''}
    </article>`;
    };
    const foundRow = (device) => `<article class="hdp-device-row hdp-device-row--found" data-hdp-device data-search="${esc(searchValue(device))}">
      <div class="hdp-device-identity">
        <div class="hdp-device-title"><span class="hdp-status-dot" aria-hidden="true"></span><h3>${esc(device.name || device.hostname || device.deviceId)}</h3>
          <span class="status-badge status-ok">Verfügbar</span></div>
        ${deviceSubtitle(device)}
      </div>
      <div class="hdp-device-facts">${deviceFacts(device)}</div>
      <div class="hdp-device-action">${device.runtimeMismatch
        ? '<span class="error-text">Nicht kompatibel</span>'
        : device.pairingState === 'paired'
          ? '<span class="muted">Anderweitig gekoppelt</span>'
          : `<form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/pair"><button>Koppeln</button></form>`}</div>
    </article>`;
    return `<div class="hdp-overview" data-hdp-revision="${overviewRevision(state)}">
      <header class="hdp-overview-head">
        <div><h1>${instanceName ? `${esc(instanceName)} – ` : ''}Geräteverwaltung</h1><p>hDP-Geräte auf einen Blick prüfen, koppeln und einzeln verwalten.</p></div>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/discovery/refresh">
          <button class="button-secondary" title="Suche im lokalen Netzwerk neu starten">Geräte suchen</button>
        </form>
      </header>
      <div class="hdp-overview-tools">
        <div class="hdp-overview-summary" aria-label="Geräteübersicht">
          <span><strong>${paired.length}</strong> gekoppelt</span>
          <span class="${onlineCount < paired.length ? 'has-offline' : ''}"><strong>${onlineCount}</strong> online</span>
          ${found.length ? `<span><strong>${found.length}</strong> neu gefunden</span>` : ''}
        </div>
        ${(paired.length + found.length) > 5 ? '<label class="hdp-device-search"><span class="visually-hidden">Geräte filtern</span><input id="hdp-device-search" type="search" placeholder="Geräte filtern …" autocomplete="off"></label>' : ''}
      </div>
      <section class="settings-card hdp-device-section">
        <div class="settings-card-head hdp-list-head"><div><h2>Meine Geräte</h2><p class="settings-card-hint">Status und Empfang sind sofort sichtbar. „Verwalten“ öffnet die Einstellungen des Geräts.</p></div></div>
        <div class="hdp-device-list">${paired.length
          ? paired.map(pairedRow).join('')
          : '<div class="hdp-empty-state"><strong>Noch kein Gerät gekoppelt</strong><span>Starte die Suche und kopple ein verfügbares hDP-Gerät.</span></div>'}</div>
      </section>
      ${found.length ? `<section class="settings-card hdp-device-section hdp-found-section">
        <div class="settings-card-head hdp-list-head"><div><h2>Neue Geräte</h2><p class="settings-card-hint">Diese Geräte wurden im lokalen Netzwerk gefunden und können gekoppelt werden.</p></div></div>
        <div class="hdp-device-list">${found.map(foundRow).join('')}</div>
      </section>` : ''}
      <p id="hdp-filter-empty" class="hdp-filter-empty" hidden>Keine Geräte passen zum Suchbegriff.</p>
    </div>`;
  }

  // Die Prozentanzeigenwerte stammen je nach Vertrag aus dem generischen
  // Ausgang oder dem Legacy-Hardwareobjekt. Bei einem Binary-I/O-Gerät ist
  // beides leer; der Dialog fällt dann auf die Ersteinrichtungsdefaults zurück.
  function pixelHardwareView(device) {
    const hw = device.hardwareConfig || {};
    const output = Array.isArray(hw.outputs) ? hw.outputs[0] : null;
    return {
      hardware: output ? {
        argb_pin: output.pin, led_count: output.pixel_count, led_type: output.driver,
        color_order: output.color_order, reverse: output.reverse,
      } : (hw.hardware || {}),
      display: output ? {
        fractional_led: device.bindings.display.fractional_pixel, transition_milliseconds: 0,
      } : (hw.display || {}),
      power: output ? {
        maximum_brightness_percent: output.maximum_brightness_percent,
        maximum_current_milliamps: output.maximum_current_milliamps,
        current_per_led_milliamps: output.current_per_pixel_milliamps,
      } : (hw.power || {}),
      offline: output ? { mode: output.offline_mode } : (hw.offline || {}),
    };
  }

  function offlineModeOptions(device) {
    // Sobald das Gerät ein Runtime-Profil meldet, gilt nach einem Wechsel auf
    // die Prozentanzeige der generische Ausgangsvertrag — auch dann, wenn es
    // aktuell noch als Binary-I/O läuft.
    return device.runtimeProfile
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
  }

  // Ein Dialog für beide Gerätetypen: Sichtbar ist immer nur der Abschnitt des
  // ausgewählten Typs, die Felder des abgewählten Typs werden zusätzlich
  // deaktiviert und damit gar nicht erst übertragen.
  function hardwareDialog(device) {
    const hw = device.hardwareConfig || {};
    const { hardware, display, power, offline } = pixelHardwareView(device);
    const currentType = deviceTypeOf(device);
    const available = supportedDeviceTypes(device.manifest);
    const legacy = !device.runtimeProfile;
    const maximumLedCount = device.manifest && device.manifest.limits
      ? device.manifest.limits.maximum_led_count : 300;
    const colorOrders = device.manifest && device.manifest.hardware_capabilities
      && Array.isArray(device.manifest.hardware_capabilities.color_orders)
      ? device.manifest.hardware_capabilities.color_orders.filter((value) => ['RGB', 'GRB'].includes(value))
      : ['RGB', 'GRB'];
    const currentArgbPin = hardware.argb_pin == null ? 2 : hardware.argb_pin;
    const argbRoles = argbOutputPinRoles(
      (device.manifest && device.manifest.hardware_capabilities) || {}, currentArgbPin,
    );
    const typeOptions = available.map((type) =>
      `<option value="${type}"${type === currentType ? ' selected' : ''}>${esc(DEVICE_TYPE_LABELS[type])}</option>`).join('');
    const typeHint = available.length > 1
      ? 'Ein Gerät erfüllt genau eine Aufgabe. Prozentanzeige und ARGB-Ausgang teilen sich denselben LED-Strang; ein Wechsel nach Binary-I/O startet das Gerät neu.'
      : 'Dieses Gerät bietet laut Manifest nur diesen Gerätetyp an.';
    const percentageSections = `
      <section class="dialog-section" data-hdp-type-panel="percentage_indicator argb_output"><div class="dialog-section-head"><h4>LED-Ausgang</h4></div><div class="dialog-grid dialog-grid--three">
        <label class="field-block" data-hdp-type-panel="percentage_indicator">GPIO<select name="argb_pin">${gpioOptions(device, currentArgbPin, null)}</select><span class="form-hint muted">Aus dem Gerätemanifest</span></label>
        <label class="field-block" data-hdp-type-panel="argb_output">GPIO<select id="hdp-argb-data-pin" name="argb_pin">${gpioOptions(device, currentArgbPin, argbRoles.dataCandidates)}</select><span class="form-hint muted">Nur GPIOs mit internem Pull-up; die übrigen sind fest Ausgänge.</span></label>
        <label class="field-block">LED-Anzahl<input type="number" name="led_count" min="1" max="${esc(maximumLedCount)}" value="${esc(hardware.led_count || 10)}"></label>
        <label class="field-block">LED-Typ<select name="led_type"><option>WS2812</option></select></label>
        <label class="field-block">Farbreihenfolge<select name="color_order">${colorOrders.map((v) => `<option${hardware.color_order === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field-block">Inaktive LEDs<select name="inactive_led_mode"><option value="off">Aus</option></select></label>
        ${legacy ? `<label class="field-block">Übergangszeit (ms)<input type="number" min="0" name="transition_milliseconds" value="${esc(display.transition_milliseconds == null ? 250 : display.transition_milliseconds)}"></label>` : ''}
      </div><div class="hdp-toggle-row hdp-dialog-toggles">
        <label><input type="checkbox" name="reverse"${hardware.reverse ? ' checked' : ''}> Laufrichtung umkehren</label>
        ${legacy ? `<label><input type="checkbox" name="fractional_led"${display.fractional_led !== false ? ' checked' : ''}> Anteilige letzte LED</label>` : ''}
      </div></section>
      <section class="dialog-section" data-hdp-type-panel="percentage_indicator argb_output"><div class="dialog-section-head"><h4>Schutz und Offline-Verhalten</h4></div><div class="dialog-grid dialog-grid--two">
        <label class="field-block">Hardware-Maximalhelligkeit (%)<input type="number" min="0" max="100" name="maximum_brightness_percent" value="${esc(power.maximum_brightness_percent == null ? 35 : power.maximum_brightness_percent)}"></label>
        <label class="field-block">Maximalstrom (mA)<input type="number" min="1" name="maximum_current_milliamps" value="${esc(power.maximum_current_milliamps || 500)}"></label>
        <label class="field-block">Strom je LED (mA)<input type="number" min="1" name="current_per_led_milliamps" value="${esc(power.current_per_led_milliamps || 60)}"></label>
        <label class="field-block">Bei Verbindungsverlust<select name="offline_mode">${offlineModeOptions(device).map(([value, label]) => `<option value="${value}"${offline.mode === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      </div></section>`;
    const binarySection = available.includes('binary_io') ? `
      <section class="dialog-section" data-hdp-type-panel="binary_io"><div class="dialog-section-head"><h4>Binary-Pins</h4><p class="muted">Eingänge sind aktiv-low und werden 30 ms entprellt. Ausgänge starten und enden offline immer inaktiv.</p>${binaryPinLegend(device)}</div>${binaryPinRows(device, hw)}</section>` : '';
    const sensorSection = available.includes('sensors') ? (() => {
      const configured = Array.isArray(hw.sensors) ? hw.sensors : [];
      const maximum = device.manifest && device.manifest.limits
        ? device.manifest.limits.maximum_sensors : 8;
      const rows = Array.from({ length: maximum }, (_, index) => {
        const sensor = configured[index] || {};
        const calibration = device.sensorCalibration && device.sensorCalibration[sensor.sensor_id]
          ? device.sensorCalibration[sensor.sensor_id] : {};
        const typeOptions = [''].concat(SENSOR_TYPES).map((type) =>
          `<option value="${esc(type)}"${sensor.sensor_type === type ? ' selected' : ''}>${esc(type || '— nicht belegt —')}</option>`).join('');
        const address = sensor.address == null ? '' : `0x${Number(sensor.address).toString(16)}`;
        return `<fieldset class="settings-card" data-hdp-sensor-row><legend>Sensor ${index + 1}</legend><div class="dialog-grid dialog-grid--three">
          <label class="field-block">Typ<select id="hdp-sensor-type-${index}" name="sensor_type_${index}" data-hdp-sensor-type>${typeOptions}</select></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_TYPES.join(' ')}">Sensor-ID<input name="sensor_id_${index}" maxlength="16" value="${esc(sensor.sensor_id || '')}"></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_TYPES.join(' ')}">Messintervall (ms)<input type="number" min="100" name="sensor_interval_${index}" value="${esc(sensor.sample_interval_milliseconds || 5000)}"></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_GPIO_TYPES.join(' ')}">Daten-GPIO<input type="number" name="sensor_pin_${index}" value="${esc(sensor.pin == null ? sensor.data_pin == null ? '' : sensor.data_pin : sensor.pin)}" placeholder="4"></label>
          <label class="field-block" data-hdp-sensor-types="hx711">Takt-GPIO<input type="number" name="sensor_aux_pin_${index}" value="${esc(sensor.clock_pin == null ? '' : sensor.clock_pin)}" placeholder="13"></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_I2C_TYPES.join(' ')}">I²C SDA<input type="number" name="sensor_sda_${index}" value="${esc(sensor.sda_pin == null ? '' : sensor.sda_pin)}" placeholder="4"></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_I2C_TYPES.join(' ')}">I²C SCL<input type="number" name="sensor_scl_${index}" value="${esc(sensor.scl_pin == null ? '' : sensor.scl_pin)}" placeholder="5"></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_I2C_TYPES.join(' ')}">I²C-Adresse<input name="sensor_address_${index}" value="${esc(address)}" placeholder="0x76"></label>
          <div class="field-block" data-hdp-sensor-types="analog"><span>ADC-Eingang</span><strong>A0</strong></div>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_CALIBRATION_TYPES.join(' ')}">Rohwert-Faktor<input type="number" step="any" name="sensor_scale_${index}" value="${esc(calibration.scale == null ? 1 : calibration.scale)}"></label>
          <label class="field-block" data-hdp-sensor-types="${SENSOR_CALIBRATION_TYPES.join(' ')}">Rohwert-Offset<input type="number" step="any" name="sensor_offset_${index}" value="${esc(calibration.offset == null ? 0 : calibration.offset)}"></label>
        </div></fieldset>`;
      }).join('');
      return `<section class="dialog-section" data-hdp-type-panel="sensors"><div class="dialog-section-head"><h4>Sensoren</h4><p class="muted">I²C-Sensoren teilen SDA/SCL. Faktor und Offset werden nur auf Rohwerte von HX711 und A0 im Adapter angewendet.</p></div>${rows}</section>
        <section class="dialog-section" data-hdp-type-panel="sensors"><div class="dialog-section-head"><h4>Freie Binary-Pins</h4><p class="muted">Nur GPIOs eintragen, die von keinem Sensorbus belegt sind.</p>${binaryPinLegend(device)}</div>${binaryPinRows(device, hw)}</section>`;
    })() : '';
    const fingerprintSection = available.includes('fingerprint_reader') ? (() => {
      const fingerprintUart = hw.uart && typeof hw.uart === 'object' ? hw.uart : {};
      const defaults = {
        idle: { effect: 'breathing', color: 'blue', speed: 96, count: 0 },
        scanning: { effect: 'on', color: 'blue', speed: 0, count: 0 },
        success: { effect: 'flashing', color: 'blue', speed: 32, count: 2 },
        failure: { effect: 'flashing', color: 'red', speed: 32, count: 2 },
        enrolling: { effect: 'breathing', color: 'purple', speed: 64, count: 0 },
      };
      const sceneLabels = {
        idle: 'Bereit', scanning: 'Finger wird gelesen', success: 'Erkannt',
        failure: 'Nicht erkannt', enrolling: 'Anlernen',
      };
      const led = hw.led && typeof hw.led === 'object' ? hw.led : {};
      const ledRows = FINGERPRINT_LED_SCENES.map((scene) => {
        const value = { ...defaults[scene], ...(led[scene] || {}) };
        const effectOptions = FINGERPRINT_LED_EFFECTS.map((effect) =>
          `<option value="${effect}"${value.effect === effect ? ' selected' : ''}>${esc(effect)}</option>`).join('');
        const colorOptions = FINGERPRINT_LED_COLORS.map((color) =>
          `<option value="${color}"${value.color === color ? ' selected' : ''}>${esc(color)}</option>`).join('');
        return `<fieldset class="settings-card"><legend>${esc(sceneLabels[scene])}</legend><div class="dialog-grid dialog-grid--four">
          <label class="field-block">Effekt<select name="fingerprint_led_effect_${scene}">${effectOptions}</select></label>
          <label class="field-block">Farbe<select name="fingerprint_led_color_${scene}">${colorOptions}</select></label>
          <label class="field-block">Geschwindigkeit<input type="number" min="0" max="255" name="fingerprint_led_speed_${scene}" value="${esc(value.speed)}"></label>
          <label class="field-block">Wiederholungen<input type="number" min="0" max="255" name="fingerprint_led_count_${scene}" value="${esc(value.count)}"></label>
        </div></fieldset>`;
      }).join('');
      return `<section class="dialog-section" data-hdp-type-panel="fingerprint_reader"><div class="dialog-section-head"><h4>R503 UART</h4><p class="muted">3,3-V-TTL, fest mit 57600 Baud. RX bezeichnet den ESP-Eingang und wird mit TX des R503 verbunden.</p></div><div class="dialog-grid dialog-grid--three">
        <label class="field-block">ESP RX-GPIO<select name="fingerprint_rx_pin">${gpioOptions(device, fingerprintUart.rx_pin == null ? 13 : fingerprintUart.rx_pin)}</select></label>
        <label class="field-block">ESP TX-GPIO<select name="fingerprint_tx_pin">${gpioOptions(device, fingerprintUart.tx_pin == null ? 15 : fingerprintUart.tx_pin)}</select></label>
        <label class="field-block">Wakeup-GPIO (optional)<input type="number" min="0" max="16" name="fingerprint_wakeup_pin" value="${esc(hw.wakeup_pin == null ? '' : hw.wakeup_pin)}" placeholder="nicht angeschlossen"></label>
      </div></section>
      <section class="dialog-section" data-hdp-type-panel="fingerprint_reader"><div class="dialog-section-head"><h4>LED-Ring</h4><p class="muted">Geschwindigkeit und Wiederholungen sind R503-Werte von 0 bis 255.</p></div>${ledRows}</section>
      <section class="dialog-section" data-hdp-type-panel="fingerprint_reader"><div class="dialog-section-head"><h4>Freie Binary-Pins</h4><p class="muted">Nur GPIOs eintragen, die nicht von UART oder Wakeup belegt sind.</p>${binaryPinLegend(device)}</div>${binaryPinRows(device, hw)}</section>`;
    })() : '';
    return `<dialog id="hdp-hardware-dialog" class="value-dialog hdp-hardware-dialog">
      <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/config" class="dialog-form">
        <input type="hidden" name="revision" value="${esc(device.configRevision || 0)}">
        <div class="dialog-hero"><h3>Hardware einrichten</h3><p class="muted">Diese Werte werden direkt auf dem Gerät gespeichert. Sichtbar ist ausschließlich der Abschnitt des gewählten Gerätetyps.</p></div>
        <section class="dialog-section"><div class="dialog-section-head"><h4>Gerät</h4></div><div class="dialog-grid dialog-grid--two">
          <label class="field-block">Gerätename<input name="device_name" value="${esc(hw.device_name || device.name || '')}"></label>
          <label class="field-block">Gerätetyp<select id="hdp-device-type" name="device_type">${typeOptions}</select><span class="form-hint muted">${esc(typeHint)}</span></label>
        </div></section>
        ${available.some((type) => PIXEL_DEVICE_TYPES.includes(type)) ? percentageSections : ''}
        ${available.includes('argb_output') ? argbPinRoleSection(device, currentArgbPin) : ''}
        ${binarySection}
        ${sensorSection}
        ${fingerprintSection}
        <div class="button-row hdp-dialog-actions"><button type="button" class="button-secondary" onclick="this.closest('dialog').close()">Abbrechen</button><button>Hardware auf Gerät speichern</button></div>
      </form>
    </dialog>`;
  }

  // Eine Firmwarekarte für beide Gerätetypen. Zuvor hatte die Binary-Seite eine
  // eigene Kurzfassung, in der Build, OTA-Fähigkeit, Speicher und Signatur
  // fehlten.
  function firmwareCard(device) {
    const firmware = device.firmwareInfo || {};
    const status = device.firmwareStatus || {};
    const progress = device.otaProgress || {};
    const candidate = firmwareCandidate(device);
    const bytes = (value) => (Number.isFinite(Number(value))
      ? `${Math.round(Number(value) / 1024)} KiB` : '—');
    const running = ['uploading', 'ready_to_restart', 'restarting'].includes(progress.state);
    const banner = candidate.available
      ? `<div class="hdp-update-banner is-available">
          <div><strong>Version ${esc(candidate.release.version)} steht bereit</strong>
          <span>Kanal ${esc(candidate.channel)} · ${esc(candidate.artifact.filename)} · ${esc(bytes(candidate.artifact.size_bytes))}${candidate.artifact.signature ? ' · signiert' : ''}</span></div>
          <button type="button" id="hdp-update-button" data-device="${esc(device.deviceId)}"
            data-armed="0" data-label="Jetzt aktualisieren"
            onclick="hdpRunUpdate(this)"${running ? ' disabled' : ''}>Jetzt aktualisieren</button>
        </div>`
      : `<div class="hdp-update-banner"><div><strong>Kein Update verfügbar</strong><span>${esc(candidate.reason || '—')}</span></div></div>`;
    return `<section class="settings-card hdp-firmware-card">
      <div class="settings-card-head"><span class="hdp-section-kicker">Wartung</span><h2>Firmware</h2><p class="settings-card-hint">Die Firmware wird zentral in der Geräteverwaltung hinterlegt; hier wird sie nur noch installiert.</p></div>
      ${banner}
      <p id="hdp-update-result" class="hdp-update-result"></p>
      <div class="hdp-firmware-summary">
        <p>${esc(firmware.name || '—')} ${esc(firmware.version || '—')} · ${esc(firmware.channel || '—')} · ${esc(firmware.platform || device.platform || '—')}/${esc(firmware.board || device.board || '—')}/${esc(firmware.variant || device.variant || '—')}</p>
        <p>Build ${esc(firmware.build_id || '—')} · ${esc(firmware.build_timestamp || '—')} · OTA ${firmware.ota_supported ? 'unterstützt' : 'nicht unterstützt'} ·
          frei/max ${esc(bytes(firmware.free_update_space_bytes))} / ${esc(bytes(firmware.maximum_image_size_bytes))} · Signatur ${esc(firmware.signature_verification || '—')}</p>
        <p>Status: ${esc(status.state || '—')} · Fortschritt ${esc(progress.progress_percent == null ? (status.progress_percent || 0) : progress.progress_percent)} %${progress.state ? ` · ${esc(progress.state)}` : ''} ${esc(progress.message || status.last_error || '')}</p>
        ${device.updateBlockedReason ? `<p class="settings-card-hint">Automatik wartet: ${esc(device.updateBlockedReason)}</p>` : ''}
      </div>
      ${status.state === 'ready_to_restart' ? `<div class="button-row">
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/firmware/restart"><button>Geprüfte Firmware neu starten</button></form>
      </div>` : ''}
    </section>`;
  }

  function dimmingSwitchFields(binding) {
    const dimmingSwitch = binding.dimming_switch || defaultBindings().dimming_switch;
    return `<div class="hdp-form-grid hdp-dimming-switch-grid">
      <div class="field hdp-span-full"><label>Dimmschalter-State</label><input data-state-picker name="dimming_switch_topic" value="${esc(dimmingSwitch.topic)}" placeholder="Optionalen State auswählen"><p class="settings-card-hint">Optional: Reduziert die berechnete Helligkeit, sobald der State dem Vergleichswert entspricht.</p></div>
      <div class="field"><label>Vergleichswert (x)</label><input name="dimming_switch_value" value="${esc(dimmingSwitch.value)}" placeholder="z. B. 1"></div>
      <div class="field"><label>Dimmung um (y %)</label><input type="number" min="0" max="100" name="dimming_switch_percent" value="${esc(dimmingSwitch.dimming_percent)}"><p class="settings-card-hint">80 % Dimmung lässt 20 % der zuvor berechneten Helligkeit übrig.</p></div>
    </div>`;
  }

  function renderBinaryDevicePage(device) {
    const hardware = device.hardwareConfig || {};
    const firmware = device.firmwareInfo || {};
    const firmwareStatus = device.firmwareStatus || {};
    const pins = Array.isArray(hardware.pins) ? hardware.pins : [];
    const pinSummary = pins.map((pin) => {
      const state = device.binaryStates && device.binaryStates[String(pin.pin)];
      return `<div><dt>GPIO ${pin.pin}</dt><dd>${state == null ? '—' : state ? 'Aktiv' : 'Inaktiv'}</dd><small>${pin.direction === 'input' ? (pin.input_type === 'button' ? 'Taster' : 'Schalter') : 'Ausgang'}</small></div>`;
    }).join('');
    return `<div class="hdp-device-page">
      <div class="hdp-device-head"><div>
        <a class="hdp-back-link" href="/adapter/instance/INSTANCE/manage">← Geräteverwaltung</a>
        <h1>${esc(device.name || device.deviceId)}</h1>
        <p class="hdp-device-meta"><code>${esc(device.deviceId)}</code><span>Binary-I/O</span><span>Revision ${esc(device.configRevision)}</span></p>
      </div><button type="button" class="button-secondary hdp-hardware-open" onclick="hdpOpenHardware()">Hardware einrichten</button></div>
      ${device.lastError ? `<p class="error-text">${esc(device.lastError)}</p>` : ''}
      <section class="settings-card hdp-status-card">
        <div class="settings-card-head hdp-card-head"><div><h2>Gerätestatus</h2><p class="settings-card-hint">${esc(device.address || 'Keine Netzwerkadresse')} · zuletzt verbunden ${esc(device.lastConnectedAt || '—')}</p></div><span class="status-badge ${device.online ? 'status-ok' : 'status-off'}">${device.online ? 'Online' : 'Offline'}</span></div>
        <dl class="hdp-status-grid"><div><dt>Verbindung</dt><dd>${esc(device.connectionState || 'offline')}</dd><small>binary-io-v1</small></div><div><dt>WLAN</dt><dd>${esc(device.rssi == null ? '—' : `${device.rssi} dBm`)}</dd><small>hDP ${esc(device.protocolVersion || '—')}</small></div>${pinSummary}</dl>
      </section>
      <form class="hdp-settings-form" method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/bindings">
        ${pins.length ? binaryBindingRows(device) : `<section class="settings-card hdp-config-card">
          <div class="settings-card-head"><h2>Noch keine GPIOs eingerichtet</h2><p class="settings-card-hint">Lege zuerst über „Hardware einrichten“ fest, welche GPIOs als Ein- oder Ausgang arbeiten. Danach erscheint hier für jeden Pin die Topic-Verknüpfung.</p></div>
        </section>`}
        <section class="settings-card hdp-config-card"><div class="settings-card-head"><h2>Update-Automatik</h2></div><div class="hdp-form-grid">
          <label class="field">Updatepolitik<select name="update_mode"><option value="manual"${device.updateSettings.mode === 'manual' ? ' selected' : ''}>Manuell</option><option value="notify_only"${device.updateSettings.mode === 'notify_only' ? ' selected' : ''}>Nur benachrichtigen</option><option value="automatic"${device.updateSettings.mode === 'automatic' ? ' selected' : ''}>Automatisch</option></select></label>
          <label class="field">Release-Kanal<select name="update_channel"><option value="stable"${device.updateSettings.channel === 'stable' ? ' selected' : ''}>Stabil</option><option value="beta"${device.updateSettings.channel === 'beta' ? ' selected' : ''}>Beta</option><option value="development"${device.updateSettings.channel === 'development' ? ' selected' : ''}>Entwicklung</option></select></label>
          <input type="hidden" name="update_retry_count" value="${esc(device.updateSettings.retry_count)}"><input type="hidden" name="maintenance_start" value="${esc(device.updateSettings.maintenance_window.start)}"><input type="hidden" name="maintenance_end" value="${esc(device.updateSettings.maintenance_window.end)}">
        </div><div class="hdp-toggle-row"><label><input type="checkbox" name="update_when_online"${device.updateSettings.update_when_device_returns_online ? ' checked' : ''}> Update nach Wiederkehr nachholen</label><label><input type="checkbox" name="maintenance_enabled"${device.updateSettings.maintenance_window.enabled ? ' checked' : ''}> Wartungsfenster verwenden</label></div></section>
        <div class="hdp-save-bar"><p>Topic-Verknüpfungen und Aktionen werden ausschließlich in homeESS verarbeitet.</p><button>Binary-I/O-Einstellungen speichern</button></div>
      </form>
      ${firmwareCard(device)}
      <section class="settings-card hdp-danger-card"><div class="settings-card-head"><h2>Gerät entkoppeln</h2></div><form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/unpair" onsubmit="return confirm('Gerät wirklich entkoppeln?');"><input type="hidden" name="confirmation" value="ENTKOPPELN"><button class="button-danger">Gerät entkoppeln</button></form></section>
      ${hardwareDialog(device)}
    </div>`;
  }

  function renderArgbDevicePage(device) {
    const binding = device.bindings;
    const pixelCount = argbPixelCount(device);
    const boundCount = Object.keys(binding.argb || {}).length;
    const binaryPins = device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [];
    const inputCount = binaryPins.filter((pin) => pin.direction === 'input').length;
    const outputCount = binaryPins.length - inputCount;
    return `<div class="hdp-device-page">
      <div class="hdp-device-head"><div>
        <a class="hdp-back-link" href="/adapter/instance/INSTANCE/manage">← Geräteverwaltung</a>
        <h1>${esc(device.name || device.deviceId)}</h1>
        <p class="hdp-device-meta"><code>${esc(device.deviceId)}</code><span>ARGB-Ausgang</span><span>Revision ${esc(device.configRevision)}</span></p>
      </div><button type="button" class="button-secondary hdp-hardware-open" onclick="hdpOpenHardware()">Hardware einrichten</button></div>
      ${device.lastError ? `<p class="error-text">${esc(device.lastError)}</p>` : ''}
      ${device.recoveryRequired ? `<p class="error-text">Recovery erforderlich: ${esc(device.lastBoot.config_load_status)} · ${esc(device.lastBoot.config_load_diagnostic || '')}. Automatische Konfigurationsschreibvorgänge sind gesperrt.</p>` : ''}
      <section class="settings-card hdp-status-card">
        <div class="settings-card-head hdp-card-head"><div><h2>Gerätestatus</h2><p class="settings-card-hint">${esc(device.address || 'Keine Netzwerkadresse')} · zuletzt verbunden ${esc(device.lastConnectedAt || '—')}</p></div><span class="status-badge ${device.online ? 'status-ok' : 'status-off'}">${device.online ? 'Online' : 'Offline'}</span></div>
        <dl class="hdp-status-grid">
          <div><dt>Verbindung</dt><dd>${esc(device.connectionState || (device.online ? 'Verbunden' : 'Offline'))}</dd><small>Versuch ${esc(device.reconnectAttempt || 0)} · nächster ${esc(device.nextReconnectAt || '—')}</small></div>
          <div><dt>WLAN</dt><dd>${esc(device.rssi == null ? '—' : `${device.rssi} dBm`)}</dd><small>hDP ${esc(device.protocolVersion || '—')}</small></div>
          <div><dt>Belegte LEDs</dt><dd>${boundCount} von ${pixelCount}</dd><small>Ausgabe ${esc(device.outputMode || '—')}</small></div>
          <div><dt>GPIOs</dt><dd>${inputCount} Ein / ${outputCount} Aus</dd><small>${binaryPins.length ? esc(binaryPins.map((pin) => `${pin.pin}${pin.direction === 'input' ? (pin.input_type === 'button' ? 'T' : 'S') : 'A'}`).join(' · ')) : 'nicht eingerichtet'}</small></div>
          <div><dt>Helligkeit</dt><dd>${esc(device.effectiveBrightness == null ? '—' : `${device.effectiveBrightness} %`)}</dd><small>${esc(device.requestedBrightness == null ? '—' : `${device.requestedBrightness} % von maximal ${hardwareBrightnessLimit(device)} %`)}${device.dimmingSwitchActive ? ` · Dimmschalter aktiv, vorher ${esc(device.brightnessBeforeDimming)} %` : ''}</small></div>
          <div><dt>Strom</dt><dd>${esc(device.estimatedCurrent == null ? '—' : `${device.estimatedCurrent} mA`)}</dd><small>Begrenzung ${device.powerLimited == null ? 'unbekannt' : device.powerLimited ? 'aktiv' : 'inaktiv'}</small></div>
        </dl>
        ${pixelCount ? `<div class="hdp-argb-strip" aria-label="Aktuelle Anzeige">${argbStatusStrip(device)}</div>` : ''}
      </section>

      <form class="hdp-settings-form" method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/bindings">
        ${pixelCount ? `<section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">01 · Zuordnung</span><h2>States auf LEDs</h2><p class="settings-card-hint">Jede LED zeigt genau einen homeESS-State. Sie leuchtet in der An-Farbe, solange der Wert das Einschaltkriterium erfüllt, sonst in der Aus-Farbe. Zeilen ohne State bleiben dunkel. „bis y“ gilt nur beim Bereichskriterium.</p></div>
          ${argbBindingRows(device)}
        </section>` : `<section class="settings-card hdp-config-card">
          <div class="settings-card-head"><h2>Noch keine LEDs eingerichtet</h2><p class="settings-card-hint">Lege zuerst über „Hardware einrichten“ GPIO und LED-Anzahl des Strangs fest. Danach erscheint hier für jede LED eine Zeile.</p></div>
        </section>`}

        ${binaryPins.length ? `<section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">02 · GPIOs</span><h2>Taster, Schalter und Ausgänge</h2><p class="settings-card-hint">Neben dem LED-Strang führt dieses Gerät die übrigen GPIOs als Binary-I/O. Eingänge sind aktiv-low und werden 30 ms entprellt; Ausgänge starten und enden offline immer inaktiv. Welcher GPIO welche Rolle hat, ergibt sich aus der Hardware und steht im Hardwaredialog.</p></div>
        </section>
        ${binaryBindingRows(device)}` : ''}

        <section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">03 · Helligkeit</span><h2>Dynamische Helligkeit</h2><p class="settings-card-hint">Begrenzt die Ausgabe der gesamten Anzeige. Die Hardwaregrenze bleibt davon unberührt und wird ausschließlich im Hardwaredialog festgelegt.</p></div>
          <div class="hdp-form-grid">
            <div class="field"><label>Helligkeitsmodus</label><select id="hdp-brightness-mode" name="brightness_mode">
              <option value="fixed"${binding.brightness.mode === 'fixed' ? ' selected' : ''}>Fester Wert</option>
              <option value="separate_numeric_source"${binding.brightness.mode !== 'fixed' ? ' selected' : ''}>Separate Zahlenquelle</option>
            </select></div>
            <div class="field" data-hdp-brightness-panel="fixed"><label>Feste Helligkeit (% der Hardware-Maximalhelligkeit)</label><input type="number" min="0" max="100" name="brightness_fixed" value="${esc(binding.brightness.fixed)}"></div>
            <div class="field hdp-span-full" data-hdp-brightness-panel="separate_numeric_source"><label>Helligkeitsquelle</label><input data-state-picker name="brightness_topic" value="${esc(binding.brightness.topic)}" placeholder="State auswählen"></div>
            <fieldset class="hdp-range-field" data-hdp-brightness-panel="separate_numeric_source"><legend>Eingangsbereich</legend><label>Minimum<input type="number" step="any" name="brightness_input_min" value="${esc(binding.brightness.input_min)}"></label><label>Maximum<input type="number" step="any" name="brightness_input_max" value="${esc(binding.brightness.input_max)}"></label></fieldset>
            <fieldset class="hdp-range-field" data-hdp-brightness-panel="separate_numeric_source"><legend>Ausgabebereich (% der Hardware-Maximalhelligkeit)</legend><label>Minimum<input type="number" step="any" name="brightness_output_min" value="${esc(binding.brightness.output_min)}"></label><label>Maximum<input type="number" step="any" name="brightness_output_max" value="${esc(binding.brightness.output_max)}"></label></fieldset>
          </div>
          <div class="hdp-toggle-row" data-hdp-brightness-panel="separate_numeric_source">
            <label><input type="checkbox" name="brightness_clamp"${binding.brightness.clamp !== false ? ' checked' : ''}> Auf den Wertebereich begrenzen</label>
            <label><input type="checkbox" name="brightness_invert"${binding.brightness.invert ? ' checked' : ''}> Helligkeit invertieren</label>
          </div>
          ${dimmingSwitchFields(binding)}
        </section>

        <section class="settings-card hdp-config-card">
          <div class="settings-card-head"><span class="hdp-section-kicker">04 · Updates</span><h2>Update-Automatik</h2></div>
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

        <div class="hdp-save-bar"><p>Zuordnung, Kriterien und Farben werden ausschließlich in homeESS ausgewertet; das Gerät empfängt nur das fertige Bild.</p><button>ARGB-Einstellungen speichern</button></div>
      </form>

      ${firmwareCard(device)}
      <section class="settings-card hdp-danger-card"><div class="settings-card-head"><h2>Gerät entkoppeln</h2></div>
        <p class="error-text">Das Gerät löscht seine WLAN-Zugangsdaten und startet anschließend im Accesspoint-Modus. Hardwarekonfiguration und Gerätetyp bleiben erhalten.</p>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/unpair" onsubmit="return confirm('Gerät wirklich entkoppeln und WLAN-Zugang löschen?');">
          <input type="hidden" name="confirmation" value="ENTKOPPELN"><button class="button-danger">Gerät entkoppeln</button>
        </form>
      </section>
      ${hardwareDialog(device)}
    </div>`;
  }

  function renderSensorDevicePage(device) {
    const sensors = device.hardwareConfig && Array.isArray(device.hardwareConfig.sensors)
      ? device.hardwareConfig.sensors : [];
    const cards = sensors.map((sensor) => {
      const sample = device.sensorSamples && device.sensorSamples[sensor.sensor_id];
      const values = Object.entries(sample && sample.values ? sample.values : {}).map(([key, value]) => {
        const meta = SENSOR_VALUE_META[key] || [key, ''];
        return `<div><dt>${esc(meta[0])}</dt><dd>${esc(value)}</dd><small>${esc(meta[1])}</small></div>`;
      }).join('');
      return `<section class="settings-card hdp-status-card"><div class="settings-card-head"><h2>${esc(sensor.sensor_id)}</h2><p class="settings-card-hint">${esc(sensor.sensor_type)} · alle ${esc(sensor.sample_interval_milliseconds)} ms</p></div>
        <dl class="hdp-status-grid"><div><dt>Status</dt><dd>${esc(sample ? sample.status : 'Noch keine Messung')}</dd><small>${esc(sample && sample.error || '')}</small></div>${values}</dl></section>`;
    }).join('');
    const binaryPins = device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [];
    return `<div class="hdp-device-page" data-hdp-fingerprint-page data-hdp-fingerprint-active="${device.pendingFingerprintBinding || status.enrolling ? 'true' : 'false'}"><div class="hdp-device-head"><div>
      <a class="hdp-back-link" href="/adapter/instance/INSTANCE/manage">← Geräteverwaltung</a>
      <h1>${esc(device.name || device.deviceId)}</h1><p class="hdp-device-meta"><code>${esc(device.deviceId)}</code><span>Sensoren</span><span>Revision ${esc(device.configRevision)}</span></p>
      </div><button type="button" class="button-secondary hdp-hardware-open" onclick="hdpOpenHardware()">Hardware einrichten</button></div>
      ${device.lastError ? `<p class="error-text">${esc(device.lastError)}</p>` : ''}
      ${cards || '<section class="settings-card"><h2>Noch keine Sensoren eingerichtet</h2></section>'}
      ${binaryPins.length ? `<form class="hdp-settings-form" method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/bindings">${binaryBindingRows(device)}<div class="hdp-save-bar"><button>Binary-I/O-Einstellungen speichern</button></div></form>` : ''}
      ${firmwareCard(device)}
      <section class="settings-card hdp-danger-card"><form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/unpair" onsubmit="return confirm('Gerät wirklich entkoppeln?');"><input type="hidden" name="confirmation" value="ENTKOPPELN"><button class="button-danger">Gerät entkoppeln</button></form></section>
      ${hardwareDialog(device)}</div>`;
  }

  function fingerprintActionFields(id, binding) {
    const key = String(id);
    const action = binding.action || 'toggle';
    return `<div class="hdp-form-grid">
      <div class="field"><label>Name<input name="fingerprint_name_${key}" maxlength="100" value="${esc(binding.name || '')}" placeholder="z. B. rechter Zeigefinger"></label></div>
      <div class="field hdp-span-full"><label>State<input data-state-picker name="fingerprint_topic_${key}" value="${esc(binding.topic || '')}" placeholder="State auswählen"></label></div>
      <div class="field"><label>Aktion<select name="fingerprint_action_${key}">
        <option value="toggle"${action === 'toggle' ? ' selected' : ''}>State umschalten</option>
        <option value="set"${action === 'set' ? ' selected' : ''}>Bestimmten Wert schreiben</option>
        <option value="counter"${action === 'counter' ? ' selected' : ''}>Wert hoch-/runterzählen</option>
      </select></label></div>
      <div class="field"><label>Setzwert (JSON)<input name="fingerprint_set_value_${key}" value="${esc(JSON.stringify(binding.set_value == null ? true : binding.set_value))}"></label></div>
      <div class="field"><label>Zählschritt<input type="number" step="any" name="fingerprint_counter_step_${key}" value="${esc(binding.counter_step == null ? 1 : binding.counter_step)}"></label></div>
    </div>`;
  }

  function renderFingerprintDevicePage(device) {
    const status = device.fingerprintStatus || {};
    const occupied = Array.from(new Set([
      ...(Array.isArray(status.occupied) ? status.occupied : []),
      ...Object.keys(device.bindings.fingerprint || {}).map(Number),
    ])).filter(Number.isInteger).sort((a, b) => a - b);
    const cards = occupied.map((id) => {
      const binding = normalizeFingerprintBinding(device.bindings.fingerprint[String(id)] || {});
      return `<section class="settings-card hdp-config-card"><div class="settings-card-head hdp-card-head"><div><span class="hdp-section-kicker">Vorlage ${id}</span><h2>${esc(binding.name || `Finger ${id}`)}</h2></div><button class="button-danger" formmethod="post" formaction="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/fingerprints/delete/${id}" onclick="return confirm('Fingerabdruck-Vorlage ${id} wirklich löschen?');">Vorlage löschen</button></div>${fingerprintActionFields(id, binding)}</section>`;
    }).join('');
    const enrollment = device.fingerprintEnrollment || {};
    const binaryPins = device.hardwareConfig && Array.isArray(device.hardwareConfig.pins)
      ? device.hardwareConfig.pins : [];
    const last = device.lastFingerprint || {};
    return `<div class="hdp-device-page"><div class="hdp-device-head"><div>
      <a class="hdp-back-link" href="/adapter/instance/INSTANCE/manage">← Geräteverwaltung</a>
      <h1>${esc(device.name || device.deviceId)}</h1><p class="hdp-device-meta"><code>${esc(device.deviceId)}</code><span>R503 Fingerabdrucksensor</span><span>Revision ${esc(device.configRevision)}</span></p>
      </div><button type="button" class="button-secondary hdp-hardware-open" onclick="hdpOpenHardware()">Hardware einrichten</button></div>
      ${device.lastError ? `<p class="error-text">${esc(device.lastError)}</p>` : ''}
      <section class="settings-card hdp-status-card"><div class="settings-card-head hdp-card-head"><div><h2>Sensorstatus</h2><p class="settings-card-hint">Vorlagen liegen ausschließlich verschlüsselt im R503-Modul; der Adapter speichert Namen und Aktionen.</p></div><span class="status-badge ${device.online && status.online ? 'status-ok' : 'status-off'}">${device.online && status.online ? 'Bereit' : 'Offline'}</span></div>
        <dl class="hdp-status-grid"><div><dt>Belegung</dt><dd>${esc(status.count == null ? '—' : `${status.count} / ${status.capacity}`)}</dd><small>Vorlagen im Modul</small></div><div><dt>Anlernen</dt><dd>${esc(status.enrolling ? 'Läuft' : enrollment.stage || 'Bereit')}</dd><small>${esc(enrollment.error || status.last_error || '')}</small></div><div><dt>Letzte Erkennung</dt><dd>${esc(last.unknown ? 'Unbekannt' : last.template_id == null ? '—' : `Vorlage ${last.template_id}`)}</dd><small>${esc(last.confidence == null ? '' : `Konfidenz ${last.confidence}`)}</small></div></dl>
      </section>
      <section class="settings-card hdp-config-card"><div class="settings-card-head"><span class="hdp-section-kicker">01 · Lernen</span><h2>Neuen Fingerabdruck anlernen</h2><p class="settings-card-hint">Nach Start denselben Finger zweimal auflegen und jeweils wieder abheben. Erst nach erfolgreichem Speichern wird die Zuordnung angelegt.</p></div>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/fingerprints/enroll"><div class="hdp-form-grid"><div class="field"><label>Vorlagen-ID<input type="number" min="0" max="255" name="template_id" placeholder="automatisch"></label></div><div class="field"><label>Name<input name="name" maxlength="100" placeholder="z. B. linker Daumen"></label></div><div class="field hdp-span-full"><label>State<input data-state-picker name="topic" placeholder="State auswählen"></label></div><div class="field"><label>Aktion<select name="action"><option value="toggle">State umschalten</option><option value="set">Bestimmten Wert schreiben</option><option value="counter">Wert hoch-/runterzählen</option></select></label></div><div class="field"><label>Setzwert (JSON)<input name="set_value" value="true"></label></div><div class="field"><label>Zählschritt<input type="number" step="any" name="counter_step" value="1"></label></div></div><div class="button-row"><button ${device.online && !status.enrolling ? '' : 'disabled'}>Anlernen starten</button><button type="submit" class="button-secondary" formaction="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/fingerprints/cancel" ${status.enrolling ? '' : 'disabled'}>Abbrechen</button></div></form>
      </section>
      <form class="hdp-settings-form" method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/bindings">
        <section class="settings-card hdp-config-card"><div class="settings-card-head"><span class="hdp-section-kicker">02 · Erkennungen</span><h2>Gelernte Finger und Aktionen</h2><p class="settings-card-hint">Eine positive Erkennung wirkt einmalig wie ein Tasterdruck. Toggle und Zähler warten auf den aktuellen Statewert.</p></div></section>
        ${cards || '<section class="settings-card"><h2>Noch kein Finger angelernt</h2></section>'}
        ${binaryPins.length ? `<section class="settings-card hdp-config-card"><div class="settings-card-head"><h2>Freie Binary-I/O-Pins</h2></div>${binaryBindingRows(device)}</section>` : ''}
        <div class="hdp-save-bar"><button>Zuordnungen speichern</button></div>
      </form>
      ${firmwareCard(device)}
      <section class="settings-card hdp-danger-card"><form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/unpair" onsubmit="return confirm('Gerät wirklich entkoppeln?');"><input type="hidden" name="confirmation" value="ENTKOPPELN"><button class="button-danger">Gerät entkoppeln</button></form></section>
      ${hardwareDialog(device)}</div>`;
  }

  function renderDevicePage(device) {
    // Der konfigurierte Gerätetyp entscheidet, nicht das Runtime-Profil: Nach
    // einem Typwechsel folgt das Profil erst mit dem Geräteneustart.
    if (isBinaryDevice(device)) return renderBinaryDevicePage(device);
    if (isArgbDevice(device)) return renderArgbDevicePage(device);
    if (isSensorDevice(device)) return renderSensorDevicePage(device);
    if (isFingerprintDevice(device)) return renderFingerprintDevicePage(device);
    const binding = device.bindings;
    const firmware = device.firmwareInfo || {};
    const firmwareStatus = device.firmwareStatus || {};
    const runtimeDescription = device.runtimeProfile === RUNTIME_PROFILE
      ? 'Generischer Pixel-Ausgang'
      : 'Legacy-Ausgabe';
    return `<div class="hdp-device-page">
      <div class="hdp-device-head">
        <div>
          <a class="hdp-back-link" href="/adapter/instance/INSTANCE/manage">← Geräteverwaltung</a>
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
          <div><dt>WLAN</dt><dd>${esc(device.rssi == null ? '—' : `${device.rssi} dBm`)}</dd><small>hDP ${esc(device.protocolVersion || '—')}</small></div>
          <div><dt>Anzeigewert</dt><dd>${esc(device.calculatedPercentage == null ? '—' : `${device.calculatedPercentage} %`)}</dd><small>Farbe ${esc(device.calculatedColor ? JSON.stringify(device.calculatedColor) : '—')}</small></div>
          <div><dt>Helligkeit</dt><dd>${esc(device.effectiveBrightness == null ? '—' : `${device.effectiveBrightness} %`)}</dd><small>${esc(device.requestedBrightness == null ? '—' : `${device.requestedBrightness} % von maximal ${hardwareBrightnessLimit(device)} %`)}${device.dimmingSwitchActive ? ` · Dimmschalter aktiv, vorher ${esc(device.brightnessBeforeDimming)} %` : ''}</small></div>
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
            <div class="field" data-hdp-brightness-panel="fixed"><label>Feste Helligkeit (% der Hardware-Maximalhelligkeit)</label><input type="number" min="0" max="100" name="brightness_fixed" value="${esc(binding.brightness.fixed)}"></div>
            <div class="field hdp-span-full" data-hdp-brightness-panel="separate_numeric_source"><label>Helligkeitsquelle</label><input data-state-picker name="brightness_topic" value="${esc(binding.brightness.topic)}" placeholder="State auswählen"></div>
            <fieldset class="hdp-range-field" data-hdp-brightness-panel="separate_numeric_source"><legend>Eingangsbereich</legend><label>Minimum<input type="number" step="any" name="brightness_input_min" value="${esc(binding.brightness.input_min)}"></label><label>Maximum<input type="number" step="any" name="brightness_input_max" value="${esc(binding.brightness.input_max)}"></label></fieldset>
            <fieldset class="hdp-range-field" data-hdp-brightness-panel="separate_numeric_source"><legend>Ausgabebereich (% der Hardware-Maximalhelligkeit)</legend><label>Minimum<input type="number" step="any" name="brightness_output_min" value="${esc(binding.brightness.output_min)}"></label><label>Maximum<input type="number" step="any" name="brightness_output_max" value="${esc(binding.brightness.output_max)}"></label></fieldset>
          </div>
          <div class="hdp-toggle-row" data-hdp-brightness-panel="separate_numeric_source">
            <label><input type="checkbox" name="brightness_clamp"${binding.brightness.clamp !== false ? ' checked' : ''}> Auf den Wertebereich begrenzen</label>
            <label><input type="checkbox" name="brightness_invert"${binding.brightness.invert ? ' checked' : ''}> Helligkeit invertieren</label>
          </div>
          ${dimmingSwitchFields(binding)}
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

      ${firmwareCard(device)}
      <section class="settings-card hdp-danger-card"><div class="settings-card-head"><h2>Gerät entkoppeln</h2></div>
        <p class="error-text">Das Gerät löscht seine WLAN-Zugangsdaten und startet anschließend im Accesspoint-Modus. Hardwarekonfiguration und Gerätetyp bleiben erhalten.</p>
        <form method="post" action="/adapter/instance/INSTANCE/manage/api/devices/${encodeURIComponent(device.deviceId)}/unpair" onsubmit="return confirm('Gerät wirklich entkoppeln und WLAN-Zugang löschen?');">
          <input type="hidden" name="confirmation" value="ENTKOPPELN"><button class="button-danger">Gerät entkoppeln</button>
        </form>
      </section>

      ${hardwareDialog(device)}
    </div>`;
  }

  function page(body, title = 'Geräteverwaltung') {
    const replaced = managedBody(body);
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
        function hdpBindHardwareType() {
          var select = document.getElementById('hdp-device-type');
          if (!select) return;
          var panels = Array.from(document.querySelectorAll('[data-hdp-type-panel]'));
          function sync() {
            panels.forEach(function(panel) {
              // Ein Abschnitt darf für mehrere Gerätetypen gelten: Prozent-
              // anzeige und ARGB-Ausgang beschreiben denselben LED-Strang.
              var active = (panel.getAttribute('data-hdp-type-panel') || '')
                .split(/\\s+/).indexOf(select.value) >= 0;
              panel.hidden = !active;
              // Felder des abgewählten Gerätetyps werden zusätzlich deaktiviert:
              // Ein verstecktes Feld würde sonst weiter mitgesendet und der
              // inaktive Typ bliebe mit seinen GPIOs in der Konfiguration.
              panel.querySelectorAll('input, select, textarea').forEach(function(field) {
                field.disabled = !active;
              });
            });
            hdpSyncArgbInputs();
            hdpSyncSensorFields();
          }
          select.addEventListener('change', sync);
          sync();
        }
        // Der gewählte ARGB-Datenpin ist kein Eingang; seine Zeile in der
        // GPIO-Belegung verschwindet. Maßgeblich bleibt aber der Gerätetyp —
        // ist der ARGB-Ausgang gar nicht gewählt, bleibt der ganze Abschnitt
        // abgeschaltet. Deshalb läuft dieser Abgleich immer nach dem des Typs.
        function hdpSyncArgbInputs() {
          var pinSelect = document.getElementById('hdp-argb-data-pin');
          if (!pinSelect) return;
          var typeSelect = document.getElementById('hdp-device-type');
          var active = !typeSelect || typeSelect.value === 'argb_output';
          document.querySelectorAll('[data-hdp-argb-input]').forEach(function (row) {
            var isData = row.getAttribute('data-hdp-argb-input') === pinSelect.value;
            row.hidden = !active || isData;
            row.querySelectorAll('select').forEach(function (field) {
              field.disabled = !active || isData;
            });
          });
        }
        function hdpBindArgbDataPin() {
          var pinSelect = document.getElementById('hdp-argb-data-pin');
          if (pinSelect) pinSelect.addEventListener('change', hdpSyncArgbInputs);
        }
        function hdpSyncSensorFields() {
          var deviceType = document.getElementById('hdp-device-type');
          var sensorDeviceActive = !deviceType || deviceType.value === 'sensors';
          document.querySelectorAll('[data-hdp-sensor-row]').forEach(function (row) {
            var typeSelect = row.querySelector('[data-hdp-sensor-type]');
            var sensorType = typeSelect ? typeSelect.value : '';
            row.querySelectorAll('[data-hdp-sensor-types]').forEach(function (field) {
              var visible = sensorDeviceActive && (field.getAttribute('data-hdp-sensor-types') || '')
                .split(/\\s+/).indexOf(sensorType) >= 0;
              field.hidden = !visible;
              field.querySelectorAll('input, select, textarea').forEach(function (input) {
                input.disabled = !visible;
              });
            });
            var address = row.querySelector('[name^="sensor_address_"]');
            var defaults = { bme280: '0x76', sht30: '0x44', sht31: '0x44', bh1750: '0x23', ina219: '0x40', vl53l0x: '0x29' };
            if (address) address.placeholder = defaults[sensorType] || '';
          });
        }
        function hdpBindSensorFields() {
          document.querySelectorAll('[data-hdp-sensor-type]').forEach(function (select) {
            select.addEventListener('change', hdpSyncSensorFields);
          });
          hdpSyncSensorFields();
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
        function hdpBindDeviceSearch(preservedQuery) {
          var input = document.getElementById('hdp-device-search');
          if (!input) return;
          var rows = Array.from(document.querySelectorAll('[data-hdp-device]'));
          var empty = document.getElementById('hdp-filter-empty');
          function filter() {
            var query = input.value.trim().toLocaleLowerCase('de');
            var visible = 0;
            rows.forEach(function(row) {
              var matches = !query || (row.getAttribute('data-search') || '').includes(query);
              row.hidden = !matches;
              if (matches) visible += 1;
            });
            if (empty) empty.hidden = visible !== 0;
          }
          input.addEventListener('input', filter);
          if (preservedQuery) {
            input.value = preservedQuery;
            filter();
          }
        }
        hdpBindDeviceSearch('');
        (function hdpStartOverviewUpdates() {
          var root = document.querySelector('.hdp-overview');
          if (!root) return;
          var revision = root.getAttribute('data-hdp-revision') || '';
          var endpoint = location.pathname.replace(/\\/+$/, '') + '/api/overview';
          async function tick() {
            if (!document.hidden) {
              try {
                var response = await fetch(endpoint, {
                  cache: 'no-store',
                  headers: { Accept: 'application/json' }
                });
                if (response.ok) {
                  var payload = await response.json();
                  if (payload && payload.revision && payload.revision !== revision
                      && typeof payload.html === 'string') {
                    var currentSearch = document.getElementById('hdp-device-search');
                    var query = currentSearch ? currentSearch.value : '';
                    root.outerHTML = payload.html;
                    root = document.querySelector('.hdp-overview');
                    revision = payload.revision;
                    hdpBindDeviceSearch(query);
                  }
                }
              } catch (_) { /* Nächster Takt versucht es erneut. */ }
            }
            window.setTimeout(tick, 1000);
          }
          window.setTimeout(tick, 1000);
        }());
        (function hdpRefreshFingerprintEnrollment() {
          var page = document.querySelector('[data-hdp-fingerprint-page]');
          if (!page || page.getAttribute('data-hdp-fingerprint-active') !== 'true') return;
          window.setTimeout(function () {
            if (!document.hidden) location.reload();
          }, 1500);
        }());
        hdpBindMode('hdp-color-mode', 'data-hdp-color-panel');
        hdpBindMode('hdp-brightness-mode', 'data-hdp-brightness-panel');
        hdpBindArgbDataPin();
        hdpBindSensorFields();
        hdpBindHardwareType();
        // Eine aus dem Verlauf wiederhergestellte Seite behält den DOM-Zustand
        // von damals — inklusive eines noch deaktivierten Knopfes. Ohne dieses
        // Zurücksetzen bliebe er nach einem Zurück-Navigieren dauerhaft tot.
        window.addEventListener('pageshow', function (event) {
          if (!event.persisted) return;
          document.querySelectorAll('button[data-armed]').forEach(function (button) {
            button.disabled = false;
            button.setAttribute('data-armed', '0');
            button.textContent = button.getAttribute('data-label') || button.textContent;
          });
        });
        ['color_r', 'color_g', 'color_b'].forEach(function(name) {
          var field = document.querySelector('[name="' + name + '"]');
          if (field) field.addEventListener('input', hdpUpdateColorPreview);
        });
        hdpUpdateColorPreview();
        // Gerätefehler kommen normativ englisch und mit Code. Die geläufigen
        // Fälle werden erklärt, statt den Rohtext zu zeigen.
        var UPDATE_HINTS = {
          OTA_CONFIG_SCHEMA_INCOMPATIBLE: 'Die installierte Firmware lehnt das neue Konfigurationsschema ab. Ältere Stände prüfen das gegen ihre eigene Migrationstabelle und können künftige Schemata nicht kennen — dieses Gerät muss einmalig per USB geflasht werden.',
          OTA_DOWNGRADE_NOT_ALLOWED: 'Das Gerät läuft bereits auf einer neueren Version.',
          OTA_ALREADY_RUNNING: 'Auf dem Gerät läuft bereits ein Update.',
          OTA_IMAGE_TOO_LARGE: 'Das Image passt nicht in den OTA-Bereich des Geräts.',
          OTA_INSUFFICIENT_SPACE: 'Auf dem Gerät ist derzeit zu wenig OTA-Speicher frei.',
          OTA_NO_CANDIDATE: 'Für den Kanal dieses Geräts liegt kein passendes Release bereit.',
          OTA_AUTH_REQUIRED: 'Das Gerät hat die Binding-Anmeldung abgelehnt.'
        };
        // Bewusst per fetch statt als Formular: Ein Formular-POST würde bei einem
        // Fehler auf die JSON-Antwort navigieren und den Button im
        // Zurück-Verlauf deaktiviert zurücklassen.
        async function hdpRunUpdate(button) {
          var out = document.getElementById('hdp-update-result');
          // Bewusst kein confirm(): Browser bieten nach mehreren Dialogen an,
          // weitere zu unterdrücken. Der Aufruf liefert danach still false —
          // der Knopf wirkt dann tot, ohne dass irgendetwas sichtbar wird.
          // Die Rückfrage passiert deshalb im Knopf selbst.
          if (button.getAttribute('data-armed') !== '1') {
            button.setAttribute('data-armed', '1');
            button.setAttribute('data-label', button.textContent);
            button.textContent = 'Wirklich übertragen?';
            if (out) {
              out.className = 'hdp-update-result';
              out.textContent = 'Das Gerät wird nach der Übertragung neu gestartet. Zum Bestätigen erneut klicken.';
            }
            window.clearTimeout(button.hdpArmTimer);
            button.hdpArmTimer = window.setTimeout(function () {
              button.setAttribute('data-armed', '0');
              button.textContent = button.getAttribute('data-label') || 'Jetzt aktualisieren';
              if (out && out.textContent.indexOf('erneut klicken') >= 0) out.textContent = '';
            }, 8000);
            return;
          }
          window.clearTimeout(button.hdpArmTimer);
          button.setAttribute('data-armed', '0');
          var label = button.getAttribute('data-label') || 'Jetzt aktualisieren';
          button.disabled = true;
          button.textContent = 'Wird übertragen …';
          if (out) { out.className = 'hdp-update-result'; out.textContent = 'Übertragung läuft; das Gerät startet anschließend neu.'; }
          try {
            var response = await fetch(location.pathname.replace(/\\/+$/, '').replace(/\\/device\\/[^/]+$/, '')
              + '/api/devices/' + encodeURIComponent(button.getAttribute('data-device')) + '/firmware/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ json: true })
            });
            var result = await response.json();
            if (!response.ok) {
              var hint = UPDATE_HINTS[result.code];
              throw new Error((hint ? hint + ' ' : '') + '(' + (result.code || 'Fehler') + ': ' + result.error + ')');
            }
            if (out) out.textContent = 'Version ' + result.installed.version + ' installiert. Seite wird neu geladen …';
            button.disabled = false;
            button.textContent = label;
            setTimeout(function () { location.reload(); }, 1500);
          } catch (err) {
            if (out) { out.className = 'hdp-update-result error-text'; out.textContent = err.message; }
            button.disabled = false;
            button.textContent = label;
          }
        }
        async function hdpRunUpdateAll(button) {
          var out = document.getElementById('hdp-update-all-result');
          var count = Number(button.getAttribute('data-count')) || 0;
          var label = button.getAttribute('data-label') || 'Alle aktualisieren';
          if (button.getAttribute('data-armed') !== '1') {
            button.setAttribute('data-armed', '1');
            button.textContent = 'Wirklich alle ' + count + ' aktualisieren?';
            if (out) out.textContent = 'Die Updates werden nacheinander übertragen. Zum Bestätigen erneut klicken.';
            window.clearTimeout(button.hdpArmTimer);
            button.hdpArmTimer = window.setTimeout(function () {
              button.setAttribute('data-armed', '0');
              button.textContent = label;
              if (out && out.textContent.indexOf('erneut klicken') >= 0) out.textContent = '';
            }, 8000);
            return;
          }
          window.clearTimeout(button.hdpArmTimer);
          button.setAttribute('data-armed', '0');
          button.disabled = true;
          button.textContent = 'Updates laufen …';
          if (out) out.textContent = '0 von ' + count + ' Geräten abgeschlossen …';
          try {
            var response = await fetch(location.pathname.replace(/\\/+$/, '') + '/api/firmware/update-all', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ json: true })
            });
            var result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Sammelupdate fehlgeschlagen');
            var lines = [result.updated + ' aktualisiert, ' + result.failed + ' fehlgeschlagen.'];
            (result.results || []).forEach(function (entry) {
              lines.push((entry.status === 'updated' ? '✓ ' : '✗ ') + entry.name + ': '
                + (entry.status === 'updated' ? 'Version ' + entry.version : entry.error));
            });
            if (out) out.textContent = lines.join('\\n') + '\\nSeite wird neu geladen …';
            button.disabled = false;
            button.textContent = label;
            setTimeout(function () { location.reload(); }, 2500);
          } catch (err) {
            if (out) out.textContent = 'Fehler: ' + err.message;
            button.disabled = false;
            button.textContent = label;
          }
        }
        // Legt Manifest und Artefakte zentral ab. Das Manifest zuerst, weil der
        // Speicher jedes Artefakt gegen die dort deklarierte Größe und Prüfsumme
        // verifiziert, bevor er es übernimmt.
        async function hdpStoreFirmware() {
          var out = document.getElementById('hdp-release-result');
          if (!out) return;
          var manifestInput = document.getElementById('hdp-release-manifest');
          var artifactInput = document.getElementById('hdp-release-artifact');
          var manifestFile = manifestInput && manifestInput.files[0];
          var artifacts = artifactInput ? Array.from(artifactInput.files) : [];
          if (!manifestFile && !artifacts.length) {
            out.textContent = 'Release-Manifest und/oder Artefakt auswählen.';
            return;
          }
          var base = location.pathname.replace(/\\/+$/, '');
          var lines = [];
          try {
            if (manifestFile) {
              out.textContent = 'Manifest wird geprüft …';
              var channelSelect = document.getElementById('hdp-release-channel');
              var response = await fetch(base + '/api/firmware/manifest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                  manifest: JSON.parse(await manifestFile.text()),
                  channel: channelSelect ? channelSelect.value : ''
                })
              });
              var stored = await response.json();
              if (!response.ok) throw new Error(stored.error || 'Manifest abgelehnt');
              lines.push('Kanal ' + stored.channel + ': Version ' + stored.release.version + ' hinterlegt.');
              if (stored.retargetedFrom) {
                lines.push('Manifest von Kanal ' + stored.retargetedFrom + ' auf '
                  + stored.channel + ' umgeschrieben.');
              }
              if (stored.missing && stored.missing.length) {
                lines.push('Fehlende Artefakte: ' + stored.missing.join(', '));
              }
              out.textContent = lines.join('\\n');
            }
            for (var index = 0; index < artifacts.length; index += 1) {
              var file = artifacts[index];
              var result = await new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', base + '/api/firmware/artifact');
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.setRequestHeader('Accept', 'application/json');
                xhr.setRequestHeader('X-Upload-Filename', file.name);
                xhr.upload.onprogress = function (event) {
                  if (!event.lengthComputable) return;
                  out.textContent = lines.concat([
                    file.name + ': ' + Math.floor(event.loaded * 100 / event.total) + ' % übertragen'
                  ]).join('\\n');
                };
                xhr.onload = function () {
                  var value = {}; try { value = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
                  if (xhr.status >= 200 && xhr.status < 300) resolve(value);
                  else reject(new Error(value.error || 'Artefakt abgelehnt'));
                };
                xhr.onerror = function () { reject(new Error('Uploadverbindung abgebrochen')); };
                xhr.send(file);
              });
              lines.push(file.name + ' abgelegt in: '
                + result.stored.map(function (item) { return item.channel; }).join(', '));
              out.textContent = lines.join('\\n');
            }
            lines.push('Fertig. Seite wird neu geladen …');
            out.textContent = lines.join('\\n');
            setTimeout(function () { location.reload(); }, 1200);
          } catch (err) {
            out.textContent = lines.concat(['Fehler: ' + err.message]).join('\\n');
          }
        }` },
    };
  }

  function managedBody(body) {
    return String(body).replaceAll('/adapter/instance/INSTANCE/manage', managementBase);
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
      // Die Firmwaresektion steht bewusst außerhalb von .hdp-overview: Der
      // Sekundentakt der Übersichtsaktualisierung ersetzt deren outerHTML und
      // würde eine bereits gewählte Datei sonst wieder verwerfen.
      if (method === 'GET' && path === '/') {
        return page(`${renderOverview()}${renderFirmwareSection()}`);
      }
      if (method === 'GET' && parts[0] === 'device' && parts[1]) {
        const device = requirePaired(parts[1]);
        return page(renderDevicePage(device), `${device.name || device.deviceId} – hDP`);
      }
      if (method === 'GET' && path === '/api/status') return { status: 200, json: snapshot() };
      if (method === 'GET' && path === '/api/overview') {
        const state = snapshot();
        return {
          status: 200,
          json: { revision: overviewRevision(state), html: managedBody(renderOverview(state)) },
        };
      }
      if (method === 'POST' && path === '/api/discovery/refresh') {
        discovery.refresh();
        return { status: 303, redirect: managementBase };
      }
      // Zentraler Firmwarespeicher: Das Release wird einmal hinterlegt, nicht
      // je Gerät. Manifest und Artefakt kommen getrennt, weil der Upload immer
      // genau eine Datei liefert.
      if (method === 'GET' && path === '/api/firmware') {
        return { status: 200, json: { channels: releaseStore.summary() } };
      }
      if (method === 'POST' && path === '/api/firmware/update-all') {
        return { status: 200, json: await updateAllFirmware() };
      }
      if (method === 'POST' && path === '/api/firmware/manifest') {
        // Nur der Upload von Hand darf den Kanal vorgeben. Kommt kein Wunsch
        // mit, gilt der Kanal aus dem Manifest — so bleibt es auch, wenn
        // Releases später automatisch abgeholt werden.
        const result = releaseStore.saveManifest(
          request.body.manifest || request.body, { channel: request.body.channel },
        );
        await runRollout().catch(() => {});
        return {
          status: 200,
          json: {
            channel: result.channel, release: result.manifest.release,
            retargetedFrom: result.retargetedFrom,
            missing: result.missing.map((artifact) => artifact.filename),
          },
        };
      }
      if (method === 'POST' && path === '/api/firmware/artifact') {
        const result = await releaseStore.saveArtifact(request.upload);
        await runRollout().catch(() => {});
        return { status: 200, json: result };
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'firmware'
          && parts[2] === 'channel' && parts[3]) {
        releaseStore.removeChannel(parts[3]);
        return { status: 303, redirect: managementBase };
      }
      if (parts[0] !== 'api' || parts[1] !== 'devices' || !parts[2]) return { status: 404, json: { error: 'Unbekannter hDP-Endpunkt.' } };
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
        const nextConfig = deviceFromForm(request.body, device);
        await saveHardwareConfig(id, {
          expected_revision: request.body.revision,
          device_name: request.body.device_name,
          config: nextConfig,
        });
        if (nextConfig.device_type === 'sensors') {
          device.sensorCalibration = {};
          nextConfig.sensors.forEach((sensor) => {
            const index = Array.from({ length: 32 }, (_, candidate) => candidate)
              .find((candidate) => String(request.body[`sensor_id_${candidate}`] || '').trim() === sensor.sensor_id);
            device.sensorCalibration[sensor.sensor_id] = {
              scale: number(request.body[`sensor_scale_${index == null ? 0 : index}`], 1),
              offset: number(request.body[`sensor_offset_${index == null ? 0 : index}`], 0),
            };
          });
          persist();
        }
        return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if (method === 'PUT' && action === 'config') return { status: 200, json: await saveHardwareConfig(id, request.body) };
      if (method === 'POST' && action === 'fingerprints/enroll') {
        const device = requirePaired(id);
        if (!isFingerprintDevice(device) || !device.connection || !device.connection.ready) {
          throw Object.assign(new Error('Fingerabdrucksensor ist nicht verbunden.'), {
            code: 'DEVICE_OFFLINE', status: 503,
          });
        }
        const status = device.fingerprintStatus || {};
        const capacity = Number.isInteger(status.capacity) && status.capacity > 0
          ? status.capacity : Number(device.manifest && device.manifest.limits
            && device.manifest.limits.maximum_fingerprint_templates) || 256;
        const occupied = new Set(Array.isArray(status.occupied) ? status.occupied : []);
        const requested = String(request.body.template_id == null ? '' : request.body.template_id).trim();
        const templateId = requested ? number(requested, -1)
          : Array.from({ length: capacity }, (_, index) => index).find((candidate) => !occupied.has(candidate));
        if (!Number.isInteger(templateId) || templateId < 0 || templateId >= capacity
            || occupied.has(templateId)) {
          throw Object.assign(new Error('Vorlagen-ID ist ungültig, belegt oder der Speicher ist voll.'), {
            code: 'FINGERPRINT_OPERATION_REJECTED', status: 409,
          });
        }
        let setValue = true;
        const raw = String(request.body.set_value == null ? 'true' : request.body.set_value);
        try { setValue = JSON.parse(raw); } catch (_) { setValue = raw; }
        device.pendingFingerprintBinding = normalizeFingerprintBinding({
          name: request.body.name, topic: request.body.topic,
          action: request.body.action, set_value: setValue,
          counter_step: number(request.body.counter_step, 1),
        });
        await device.connection.request('fingerprint.enroll.begin', {
          config_revision: device.configRevision, template_id: templateId,
        }, 5000);
        persist();
        return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if (method === 'POST' && action === 'fingerprints/cancel') {
        const device = requirePaired(id);
        if (!isFingerprintDevice(device) || !device.connection || !device.connection.ready) {
          throw Object.assign(new Error('Fingerabdrucksensor ist nicht verbunden.'), {
            code: 'DEVICE_OFFLINE', status: 503,
          });
        }
        await device.connection.request('fingerprint.enroll.cancel', {
          config_revision: device.configRevision,
        }, 5000);
        device.pendingFingerprintBinding = null;
        persist();
        return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if (method === 'POST' && /^fingerprints\/delete\/\d+$/.test(action)) {
        const device = requirePaired(id);
        if (!isFingerprintDevice(device) || !device.connection || !device.connection.ready) {
          throw Object.assign(new Error('Fingerabdrucksensor ist nicht verbunden.'), {
            code: 'DEVICE_OFFLINE', status: 503,
          });
        }
        const templateId = Number(action.split('/').at(-1));
        await device.connection.request('fingerprint.template.delete', {
          config_revision: device.configRevision, template_id: templateId,
        }, 5000);
        return { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if ((method === 'POST' || method === 'PUT') && action === 'bindings') {
        const device = requirePaired(id);
        const input = method === 'POST' ? bindingsFromForm(request.body, device) : request.body;
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
            throw Object.assign(new Error('Generischer hDP-Ausgang ist nicht verbunden.'), {
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
      // Ein Klick: Das Gerät zieht das zentral hinterlegte Release seines
      // Kanals, prüft es, startet neu und wird anschließend verifiziert.
      if (method === 'POST' && action === 'firmware/update') {
        const result = await updateFirmware(id, { allowDowngrade: bool(request.body.allow_downgrade) });
        return request.body && request.body.json
          ? { status: 200, json: result }
          : { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      if (method === 'POST' && action === 'firmware/restart') {
        const result = await restartFirmware(id);
        return request.body && Object.keys(request.body).length
          ? { status: 200, json: result }
          : { status: 303, redirect: `${managementBase}/device/${encodeURIComponent(id)}` };
      }
      return { status: 404, json: { error: 'Unbekannter hDP-Endpunkt.' } };
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
      releaseStore.source = String(config.releaseSource || '');
      if (String(config.firmwarePublicKey || '').trim()) {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(String(config.firmwarePublicKey).trim(), 'base64'),
          format: 'der',
          type: 'spki',
        });
        if (publicKey.asymmetricKeyType !== 'ed25519') {
          throw new Error('Firmware-Prüfschlüssel ist kein Ed25519-Schlüssel.');
        }
        releaseStore.publicKey = publicKey;
      } else {
        releaseStore.publicKey = null;
      }
      // Das Datenverzeichnis liegt außerhalb der Instanz-Settings, weil ein
      // Firmwareimage den bei jedem Persistieren neu geschriebenen Blob sonst
      // um Größenordnungen aufblähen würde.
      try {
        releaseStore.attach(await host.getDataDirectory());
      } catch (error) {
        host.warn(`Firmwarespeicher nicht verfügbar: ${error.message}`);
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
      // Der Rollout läuft häufiger als die Statusabfrage, damit ein Gerät ein
      // enges Wartungsfenster nicht verpasst und ein „nachholen“ nach der
      // Wiederkehr zeitnah greift.
      rolloutPoll = setInterval(() => {
        runRollout().catch((error) => host.error(`hDP Rollout: ${error.message}`));
      }, 60 * 1000);
      host.setConnected(true, 'hDP-Discovery aktiv');
      persist();
      host.log(`hDP Adapter gestartet (${identity.instanceId}).`);
    },

    stop() {
      stopped = true;
      if (discovery) discovery.stop();
      discovery = null;
      if (firmwarePoll) clearInterval(firmwarePoll);
      firmwarePoll = null;
      if (rolloutPoll) clearInterval(rolloutPoll);
      rolloutPoll = null;
      for (const device of devices.values()) {
        if (device.connection) device.connection.stop();
        stopSubscriptions(device);
      }
      host.setConnected(false, 'hDP Adapter gestoppt');
    },

    handleManagementRequest,
  };
}

module.exports = createHdpAdapter;
module.exports._test = {
  defaultBindings, defaultUpdateSettings, mergeBindings, sanitizeDevice,
  sourceParts, displayColor, dynamicBrightness, hardwareBrightnessLimit,
  effectiveDynamicBrightness, normalizedPercentage,
  calculateState, indicatorActive, deviceStateChannels, deviceStateCatalog, deviceStateValues,
  resetChangedIndicatorState, bindingNeedsReconcile, requestedDeviceName,
  clearAppliedOutputError,
  number,
  binaryBoolean, normalizeBinaryBindings, binaryEventTarget,
  defaultArgbBinding, normalizeArgbBindings, renderArgbFrame, argbPixelCount,
  hexColor, colorHex, argbColor,
  deviceTypeOf, isBinaryDevice, isArgbDevice, isSensorDevice, isFingerprintDevice,
  normalizeFingerprintBinding, normalizeFingerprintBindings,
  supportedDeviceTypes, binaryPinSlots, applySensorSample, sensorUiFields,
  insideMaintenanceWindow, otaInProgress, releaseInterruptedOta,
  reconcileOtaProgress,
  applyDeviceStatus,
};
