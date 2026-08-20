'use strict';

// Anbindung an zigbee-herdsman-converters.
//
// Der Adapter führt bewusst keine eigene Gerätedatenbank. Empfangene
// Zigbee-Nachrichten werden von den fromZigbee-Convertern des jeweiligen
// Gerätes in Werte übersetzt, Schreibwünsche von den toZigbee-Convertern in
// Zigbee-Kommandos. Gerätespezifische Sonderfälle bleiben damit dort, wo sie
// gepflegt werden — in der Converter-Bibliothek.

const zhc = require('zigbee-herdsman-converters');

function fail(message, code = 'ZIGBEE_CONVERTER') {
  return Object.assign(new Error(message), { code });
}

/**
 * Sucht die Converter-Definition eines Gerätes. Unbekannte Geräte liefern
 * `undefined`, ohne zu werfen — ein einzelnes unbekanntes Gerät darf den
 * Adapter nie beeinträchtigen.
 */
async function resolveDefinition(device) {
  try {
    return await zhc.findByDevice(device, true);
  } catch (_) {
    try {
      return await zhc.findByDevice(device, false);
    } catch (_ignored) {
      return undefined;
    }
  }
}

/**
 * Wählt die fromZigbee-Converter, die zu einer eingegangenen Nachricht passen.
 */
function matchingReceiveConverters(definition, message) {
  if (!definition || !Array.isArray(definition.fromZigbee)) return [];
  return definition.fromZigbee.filter((converter) => {
    if (!converter || converter.cluster !== message.cluster) return false;
    return Array.isArray(converter.type)
      ? converter.type.includes(message.type)
      : converter.type === message.type;
  });
}

/**
 * Führt die passenden fromZigbee-Converter aus und liefert das zusammengeführte
 * Werteobjekt. Ein fehlerhafter Converter beendet die Verarbeitung der übrigen
 * nicht.
 */
async function convertReceived({ definition, message, device, state, options, publish, onError, onExposesChanged }) {
  const payload = {};
  const converters = matchingReceiveConverters(definition, message);
  if (!converters.length) return payload;

  const meta = {
    state: state || {},
    device,
    deviceExposesChanged: () => {
      if (typeof onExposesChanged === 'function') onExposesChanged();
    },
  };
  const emit = (values) => {
    if (values && typeof values === 'object') Object.assign(payload, values);
    if (typeof publish === 'function') publish(values);
  };

  for (const converter of converters) {
    try {
      const result = await converter.convert(definition, message, emit, options || {}, meta);
      if (result && typeof result === 'object') Object.assign(payload, result);
    } catch (error) {
      if (typeof onError === 'function') onError(error, converter);
    }
  }

  try {
    zhc.postProcessConvertedFromZigbeeMessage(definition, payload, options || {}, device);
  } catch (error) {
    if (typeof onError === 'function') onError(error, null);
  }
  return payload;
}

/**
 * Löst den Endpunkt auf, an den ein Schreibwunsch geht.
 */
function resolveEndpoint(device, definition, endpointName) {
  if (endpointName && definition && typeof definition.endpoint === 'function') {
    let map;
    try {
      map = definition.endpoint(device);
    } catch (_) {
      map = null;
    }
    const id = map && map[endpointName];
    if (id != null) {
      const endpoint = device.getEndpoint(id);
      if (endpoint) return endpoint;
    }
  }
  if (definition && typeof definition.endpoint === 'function') {
    let map;
    try {
      map = definition.endpoint(device);
    } catch (_) {
      map = null;
    }
    const id = map && map.default;
    if (id != null) {
      const endpoint = device.getEndpoint(id);
      if (endpoint) return endpoint;
    }
  }
  const endpoints = device.endpoints || [];
  if (!endpoints.length) throw fail('Das Gerät meldet keinen Endpunkt.');
  return endpoints[0];
}

/**
 * Sucht den toZigbee-Converter für einen Merkmalsschlüssel.
 */
function findSendConverter(definition, key, endpointName) {
  if (!definition || !Array.isArray(definition.toZigbee)) return undefined;
  const candidates = definition.toZigbee.filter((converter) => Array.isArray(converter.key) && converter.key.includes(key));
  if (!candidates.length) return undefined;
  if (endpointName) {
    const scoped = candidates.find((converter) => Array.isArray(converter.endpoints)
      && converter.endpoints.includes(endpointName));
    if (scoped) return scoped;
  }
  return candidates.find((converter) => !converter.endpoints) || candidates[0];
}

function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'true', 'on', 'ein', 'an', 'open', 'yes', 'ja', 'lock', 'locked'].includes(text);
}

/**
 * Bringt einen von homeESS geschriebenen Wert in die Form, die der Converter
 * des Gerätes erwartet. Die Vorgaben stammen aus dem Expose, nicht aus einer
 * gerätespezifischen Sonderbehandlung.
 */
function coerceValue(feature, raw) {
  if (!feature) return raw;
  const type = feature.type;

  if (type === 'binary') {
    const on = feature.valueOn === undefined ? true : feature.valueOn;
    const off = feature.valueOff === undefined ? false : feature.valueOff;
    if (feature.valueToggle != null) {
      const text = String(raw == null ? '' : raw).trim().toLowerCase();
      if (text === 'toggle' || text === String(feature.valueToggle).toLowerCase()) return feature.valueToggle;
    }
    // Ein bereits passender Wert wird unverändert durchgereicht.
    if (raw === on || raw === off) return raw;
    if (typeof on === 'string' && typeof raw === 'string') {
      if (raw.toUpperCase() === String(on).toUpperCase()) return on;
      if (raw.toUpperCase() === String(off).toUpperCase()) return off;
    }
    return truthy(raw) ? on : off;
  }

  if (type === 'numeric') {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) throw fail(`„${feature.property}" erwartet eine Zahl, empfangen wurde: ${raw}`);
    if (feature.min != null && numeric < feature.min) return feature.min;
    if (feature.max != null && numeric > feature.max) return feature.max;
    return numeric;
  }

  if (type === 'enum') {
    const text = String(raw == null ? '' : raw).trim();
    const values = feature.values || [];
    if (!values.length) return text;
    const exact = values.find((value) => String(value) === text);
    if (exact !== undefined) return exact;
    const loose = values.find((value) => String(value).toLowerCase() === text.toLowerCase());
    if (loose !== undefined) return loose;
    throw fail(`„${feature.property}" erlaubt nur: ${values.join(', ')}. Empfangen wurde: ${text}`);
  }

  if (feature.structured) {
    if (raw && typeof raw === 'object') return raw;
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw fail(`„${feature.property}" erwartet einen zusammengesetzten Wert als JSON.`);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw fail(`„${feature.property}" erwartet gültiges JSON, empfangen wurde: ${text}`);
    }
  }

  return raw == null ? '' : String(raw);
}

/**
 * Übersetzt einen Schreibwunsch in ein Zigbee-Kommando.
 */
async function convertSend({ definition, device, feature, value, state, options, publish }) {
  if (!definition) throw fail('Für dieses Gerät ist keine Converter-Definition bekannt.');
  const converter = findSendConverter(definition, feature.key, feature.endpoint);
  if (!converter || typeof converter.convertSet !== 'function') {
    throw fail(`Das Gerät bietet für „${feature.property}" keinen Schreibzugriff an.`);
  }
  const entity = resolveEndpoint(device, definition, feature.endpoint);
  const converted = coerceValue(feature, value);
  const meta = {
    message: { [feature.key]: converted },
    device,
    mapped: definition,
    options: options || {},
    state: state || {},
    endpoint_name: feature.endpoint || undefined,
    publish: typeof publish === 'function' ? publish : () => {},
  };
  const result = await converter.convertSet(entity, feature.key, converted, meta);
  return { result, converted };
}

/**
 * Fordert den aktuellen Wert eines Merkmals beim Gerät an.
 */
async function convertGet({ definition, device, feature, state, options }) {
  if (!definition) throw fail('Für dieses Gerät ist keine Converter-Definition bekannt.');
  const converter = findSendConverter(definition, feature.key, feature.endpoint);
  if (!converter || typeof converter.convertGet !== 'function') return false;
  const entity = resolveEndpoint(device, definition, feature.endpoint);
  await converter.convertGet(entity, feature.key, {
    message: {},
    device,
    mapped: definition,
    options: options || {},
    state: state || {},
    endpoint_name: feature.endpoint || undefined,
    publish: () => {},
  });
  return true;
}

/**
 * Reicht Lebenszyklusereignisse an die Converter weiter. Manche Geräte —
 * etwa viele Tuya-Modelle — benötigen das, um überhaupt Werte zu liefern.
 */
async function forwardEvent(definition, event, onError) {
  try {
    await zhc.onEvent(event);
  } catch (error) {
    if (typeof onError === 'function') onError(error);
  }
  const handler = definition && definition.onEvent;
  if (typeof handler !== 'function') return;
  try {
    await handler(event);
  } catch (error) {
    if (typeof onError === 'function') onError(error);
  }
}

module.exports = {
  zhc,
  resolveDefinition,
  matchingReceiveConverters,
  convertReceived,
  convertSend,
  convertGet,
  findSendConverter,
  resolveEndpoint,
  coerceValue,
  forwardEvent,
  truthy,
};
