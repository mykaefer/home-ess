'use strict';

// Übersetzung der Converter-Exposes in den homeESS-State-Katalog.
//
// Die Eigenschaften eines Gerätes werden nicht gepflegt, sondern aus der
// Definition von zigbee-herdsman-converters abgeleitet. Damit sind alle von der
// Bibliothek unterstützten Geräte automatisch abgedeckt, ohne dass der Adapter
// eine eigene Gerätedatenbank führt.

// Sammelnde Expose-Typen besitzen selbst keinen Wert, sondern bündeln nur
// Einzelmerkmale. Sie werden eine Ebene flachgeklopft — genau die Sicht, die
// auch die Converter beim Schreiben erwarten.
const GROUPING_TYPES = new Set(['light', 'switch', 'cover', 'climate', 'fan', 'lock']);

// Diese Typen tragen einen zusammengesetzten Wert. Er wird als JSON-Text
// geführt, weil ein homeESS-State genau einen Zahl-, Wahrheits- oder Textwert
// hält.
const STRUCTURED_TYPES = new Set(['composite', 'list']);

const ACCESS_STATE = 1;
const ACCESS_SET = 2;
const ACCESS_GET = 4;

// Diagnosewerte, die jedes Zigbee-Gerät unabhängig vom Converter besitzt.
const DEVICE_DIAGNOSTICS = [
  { property: 'linkquality', label: 'Verbindungsqualität', unit: 'lqi' },
  { property: 'available', label: 'Verfügbar' },
  { property: 'last_seen', label: 'Zuletzt gesehen' },
  { property: 'interview_state', label: 'Interviewstatus' },
];

function exposeList(definition, device, options = {}) {
  if (!definition) return [];
  const exposes = definition.exposes;
  try {
    const resolved = typeof exposes === 'function' ? exposes(device, options) : exposes;
    return Array.isArray(resolved) ? resolved : [];
  } catch (_) {
    // Eine Definition, deren Exposes-Funktion stolpert, darf weder den Katalog
    // noch den Adapter beschädigen.
    return [];
  }
}

/**
 * Flacht die Exposes eines Gerätes zu einer Liste beschreibbarer bzw. lesbarer
 * Einzelmerkmale ab.
 *
 * @returns {Array<{property,key,endpoint,type,access,unit,label,values,valueOn,valueOff,min,max,step,structured}>}
 */
function flattenExposes(exposes) {
  const result = [];
  const seen = new Set();

  const visit = (expose) => {
    if (!expose || typeof expose !== 'object') return;
    const type = String(expose.type || '');

    if (GROUPING_TYPES.has(type)) {
      for (const feature of expose.features || []) visit(feature);
      return;
    }

    const property = expose.property;
    if (!property || seen.has(property)) return;
    seen.add(property);

    const access = Number.isInteger(expose.access) ? expose.access : ACCESS_STATE;
    const entry = {
      property: String(property),
      // Der Converter-Schlüssel ist der Name ohne Endpunkt-Zusatz.
      key: String(expose.name || property),
      endpoint: expose.endpoint == null ? null : String(expose.endpoint),
      type,
      access,
      readable: (access & ACCESS_STATE) !== 0,
      writable: (access & ACCESS_SET) !== 0,
      pollable: (access & ACCESS_GET) !== 0,
      unit: expose.unit == null ? '' : String(expose.unit),
      label: expose.label || expose.description || String(expose.name || property),
      structured: STRUCTURED_TYPES.has(type),
      category: expose.category || null,
    };
    if (type === 'enum' && Array.isArray(expose.values)) entry.values = expose.values.slice();
    if (type === 'binary') {
      entry.valueOn = expose.value_on;
      entry.valueOff = expose.value_off;
      entry.valueToggle = expose.value_toggle;
    }
    if (type === 'numeric') {
      if (expose.value_min != null) entry.min = expose.value_min;
      if (expose.value_max != null) entry.max = expose.value_max;
      if (expose.value_step != null) entry.step = expose.value_step;
    }
    result.push(entry);
  };

  for (const expose of exposes || []) visit(expose);
  return result;
}

// ── Gerätegattung ───────────────────────────────────────────────────────────
//
// Für die Netzwerkkarte muss auf einen Blick erkennbar sein, *was* ein Knoten
// ist. Die Gattung wird aus denselben Exposes abgeleitet wie die States — es
// gibt also weiterhin keine gepflegte Geräteliste, die veralten könnte.
//
// Die Reihenfolge ist bewusst: Ein Thermostat besitzt auch Temperaturwerte, ist
// aber kein Sensor; eine Messsteckdose ist eine Steckdose und kein Zähler.

const KINDS = {
  coordinator: { label: 'Coordinator' },
  light: { label: 'Licht' },
  outlet: { label: 'Steckdose' },
  relay: { label: 'Schaltaktor' },
  cover: { label: 'Rollladen' },
  thermostat: { label: 'Thermostat' },
  lock: { label: 'Schloss' },
  fan: { label: 'Lüfter' },
  motion: { label: 'Bewegungsmelder' },
  contact: { label: 'Fenster-/Türkontakt' },
  smoke: { label: 'Rauchmelder' },
  water: { label: 'Wassermelder' },
  button: { label: 'Taster / Fernbedienung' },
  sensor: { label: 'Sensor' },
  router: { label: 'Repeater' },
  unknown: { label: 'Unbekannt' },
};

/**
 * Bestimmt die Gattung eines Gerätes aus seinen Exposes.
 *
 * @param {Array}  exposes  die unveränderten Exposes der Definition
 * @param {object} device   `{ deviceType }` als Rückfallebene
 */
function deviceKind(exposes, device = {}) {
  if (String(device.deviceType || '') === 'Coordinator') return 'coordinator';

  const types = new Set();
  const names = new Set();
  const collect = (list) => {
    for (const expose of list || []) {
      if (!expose || typeof expose !== 'object') continue;
      if (expose.type) types.add(String(expose.type));
      if (expose.name) names.add(String(expose.name));
      if (expose.property) names.add(String(expose.property));
      if (Array.isArray(expose.features)) collect(expose.features);
    }
  };
  collect(exposes);

  if (types.has('light')) return 'light';
  if (types.has('cover')) return 'cover';
  if (types.has('climate')) return 'thermostat';
  if (types.has('lock')) return 'lock';
  if (types.has('fan')) return 'fan';
  if (types.has('switch')) {
    // Eine Steckdose misst in aller Regel mit; ein reiner Schaltaktor nicht.
    return (names.has('power') || names.has('energy') || names.has('current')) ? 'outlet' : 'relay';
  }
  if (names.has('smoke')) return 'smoke';
  if (names.has('water_leak')) return 'water';
  if (names.has('occupancy') || names.has('presence') || names.has('motion')) return 'motion';
  if (names.has('contact') || names.has('vibration')) return 'contact';
  if (names.has('action')) return 'button';
  for (const name of ['temperature', 'humidity', 'pressure', 'illuminance', 'co2', 'voc', 'pm25', 'soil_moisture']) {
    if (names.has(name)) return 'sensor';
  }
  // Ohne aussagekräftige Exposes bleibt die Rolle im Netz die beste Auskunft:
  // Ein Router ohne eigene Funktion ist praktisch ein Repeater.
  if (String(device.deviceType || '') === 'Router') return 'router';
  return 'unknown';
}

function kindLabel(kind) {
  return (KINDS[kind] || KINDS.unknown).label;
}

// Aus der IEEE-Adresse wird der stabile Teil der State-Adresse. Bewusst nicht
// der Anzeigename: Der darf sich jederzeit ändern, ohne dass eingetragene
// Topics ungültig werden.
function deviceSlug(ieeeAddress) {
  return String(ieeeAddress || '').replace(/^0x/i, '').toLowerCase();
}

function stateAddress(ieeeAddress, property) {
  return `${deviceSlug(ieeeAddress)}/${property}`;
}

/**
 * Baut die homeESS-State-Einträge eines Gerätes.
 *
 * @param {object} device   normalisierte Gerätebeschreibung
 * @param {Array}  features Ergebnis von flattenExposes
 */
function deviceStates(device, features) {
  const category = `Zigbee / ${device.friendlyName || deviceSlug(device.ieeeAddress)}`;
  const states = features.map((feature) => ({
    address: stateAddress(device.ieeeAddress, feature.property),
    name: feature.label,
    category: feature.category === 'diagnostic' || feature.category === 'config'
      ? `${category} / ${feature.category === 'config' ? 'Einstellungen' : 'Diagnose'}`
      : category,
    unit: feature.unit || undefined,
    writable: feature.writable,
  }));
  for (const diagnostic of DEVICE_DIAGNOSTICS) {
    states.push({
      address: stateAddress(device.ieeeAddress, diagnostic.property),
      name: diagnostic.label,
      category: `${category} / Diagnose`,
      unit: diagnostic.unit || undefined,
      writable: false,
    });
  }
  return states;
}

/**
 * States des Coordinators selbst. Sie beschreiben das Netz, nicht ein Gerät.
 */
function coordinatorStates() {
  return [
    { address: 'coordinator/connected', name: 'Coordinator verbunden', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/network_state', name: 'Netzwerkstatus', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/ieee_address', name: 'IEEE-Adresse', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/adapter_type', name: 'Adapter-Typ', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/firmware', name: 'Firmware', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/transport', name: 'Anbindung', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/pan_id', name: 'PAN-ID', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/channel', name: 'Kanal', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/device_count', name: 'Bekannte Geräte', category: 'Zigbee / Coordinator' },
    { address: 'coordinator/devices_online', name: 'Erreichbare Geräte', category: 'Zigbee / Coordinator' },
    {
      address: 'coordinator/permit_join',
      name: 'Anlernen aktiv',
      category: 'Zigbee / Coordinator',
      writable: true,
    },
    {
      address: 'coordinator/permit_join_remaining',
      name: 'Anlernen verbleibend',
      category: 'Zigbee / Coordinator',
      unit: 's',
    },
  ];
}

/**
 * Bringt einen Converter-Wert in eine für homeESS zulässige Form: Zahl,
 * Wahrheitswert oder Text.
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'bigint') return Number(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

module.exports = {
  KINDS,
  deviceKind,
  kindLabel,
  GROUPING_TYPES,
  STRUCTURED_TYPES,
  DEVICE_DIAGNOSTICS,
  ACCESS_STATE,
  ACCESS_SET,
  ACCESS_GET,
  exposeList,
  flattenExposes,
  deviceStates,
  coordinatorStates,
  deviceSlug,
  stateAddress,
  normalizeValue,
};
