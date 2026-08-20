'use strict';

// Geräteverzeichnis des Adapters.
//
// Es hält für jedes bekannte Zigbee-Gerät die Verbindung zwischen dem Modell
// von zigbee-herdsman, der Converter-Definition und den daraus abgeleiteten
// homeESS-States. Die Zigbee-Datenbank selbst führt zigbee-herdsman; hier liegt
// nur die Sicht, die homeESS benötigt.

const exposesLib = require('./exposes');
const availability = require('./availability');

const INTERVIEW_LABELS = {
  PENDING: 'ausstehend',
  IN_PROGRESS: 'läuft',
  SUCCESSFUL: 'abgeschlossen',
  FAILED: 'fehlgeschlagen',
};

function interviewLabel(state) {
  return INTERVIEW_LABELS[String(state || '')] || String(state || 'unbekannt');
}

/**
 * Übernimmt die Stammdaten eines herdsman-Gerätes in eine schlichte,
 * serialisierbare Beschreibung.
 */
function describeDevice(zhDevice) {
  const ieeeAddress = String(zhDevice.ieeeAddr || '');
  return {
    ieeeAddress,
    slug: exposesLib.deviceSlug(ieeeAddress),
    networkAddress: Number(zhDevice.networkAddress),
    manufacturer: zhDevice.manufacturerName || '',
    zigbeeModel: zhDevice.modelID || '',
    deviceType: String(zhDevice.type || 'Unknown'),
    powerSource: zhDevice.powerSource || '',
    deviceClass: availability.classifyDevice(zhDevice),
    interviewState: String(zhDevice.interviewState || ''),
    softwareBuildID: zhDevice.softwareBuildID || '',
    dateCode: zhDevice.dateCode || '',
  };
}

function createRegistry({ getConfig, onCatalogChanged, log }) {
  const entries = new Map();
  let customNames = new Map();

  function config() {
    return (typeof getConfig === 'function' ? getConfig() : {}) || {};
  }

  /**
   * Eigene Gerätenamen stammen von der Geräteseite von homeESS. Sie sind
   * Anzeigetext — die State-Adressen bleiben davon unberührt und behalten die
   * IEEE-Adresse, damit eingetragene Topics eine Umbenennung überstehen.
   */
  function applyCustomNames(deviceRows) {
    customNames = new Map();
    for (const row of Array.isArray(deviceRows) ? deviceRows : []) {
      const address = String(row && row.address || '').trim();
      const custom = String(row && row.customName || '').trim();
      if (address && custom) customNames.set(address, custom);
    }
    for (const entry of entries.values()) entry.friendlyName = displayName(entry);
  }

  /**
   * Setzt oder entfernt den eigenen Namen eines Gerätes.
   *
   * Der Name ist reiner Anzeigetext. Die State-Adressen bleiben an der
   * IEEE-Adresse hängen, damit eingetragene Topics eine Umbenennung
   * unbeschadet überstehen.
   */
  function setCustomName(slug, name) {
    const key = String(slug || '').toLowerCase();
    const entry = entries.get(key);
    if (!entry) throw Object.assign(new Error('Unbekanntes Zigbee-Gerät.'), { code: 'ZIGBEE_UNKNOWN_DEVICE' });
    const clean = String(name == null ? '' : name).trim().slice(0, 80);
    if (clean) customNames.set(key, clean);
    else customNames.delete(key);
    entry.friendlyName = displayName(entry);
    return entry.friendlyName;
  }

  function customName(slug) {
    return customNames.get(String(slug || '').toLowerCase()) || '';
  }

  function displayName(entry) {
    const custom = customNames.get(entry.slug);
    if (custom) return custom;
    if (entry.model) return `${entry.model} ${entry.slug.slice(-6)}`;
    if (entry.zigbeeModel) return `${entry.zigbeeModel} ${entry.slug.slice(-6)}`;
    return `Zigbee ${entry.slug.slice(-6)}`;
  }

  /**
   * Nimmt ein Gerät neu auf oder aktualisiert seine Beschreibung.
   */
  function upsert(zhDevice, definition, options = {}) {
    const description = describeDevice(zhDevice);
    const existing = entries.get(description.slug);
    const features = definition
      ? exposesLib.flattenExposes(exposesLib.exposeList(definition, zhDevice, options.converterOptions || {}))
      : [];

    const entry = {
      ...(existing || {}),
      ...description,
      zh: zhDevice,
      definition: definition || null,
      supported: !!definition && !definition.generated,
      generated: !!(definition && definition.generated),
      model: definition ? definition.model : (existing ? existing.model : ''),
      vendor: definition ? definition.vendor : (existing ? existing.vendor : ''),
      description: definition ? definition.description : (existing ? existing.description : ''),
      features,
      featureByProperty: new Map(features.map((feature) => [feature.property, feature])),
      state: (existing && existing.state) || {},
      lastSeen: (existing && existing.lastSeen) || Number(zhDevice.lastSeen) || 0,
      lastPing: (existing && existing.lastPing) || 0,
      available: existing ? existing.available : null,
      linkquality: existing ? existing.linkquality : null,
    };
    entry.friendlyName = displayName(entry);
    entries.set(entry.slug, entry);
    return entry;
  }

  function remove(slug) {
    return entries.delete(String(slug || '').toLowerCase());
  }

  function get(slug) {
    return entries.get(String(slug || '').toLowerCase());
  }

  function bySlugOrIeee(value) {
    return get(exposesLib.deviceSlug(value));
  }

  function all() {
    return Array.from(entries.values());
  }

  function size() {
    return entries.size;
  }

  /**
   * Der vollständige State-Katalog: Coordinator plus alle Geräte.
   */
  function buildCatalog() {
    const states = exposesLib.coordinatorStates();
    for (const entry of all()) {
      for (const state of exposesLib.deviceStates(entry, entry.features)) states.push(state);
    }
    return states;
  }

  function notifyCatalogChanged() {
    if (typeof onCatalogChanged === 'function') onCatalogChanged();
  }

  /**
   * Bringt einen Converter-Wert in die Form, die homeESS erwartet.
   *
   * Entscheidend sind die Schaltzustände: Die Zigbee-Welt führt sie als Text
   * „ON"/„OFF", homeESS wertet Schaltzustände aber als Wahrheitswert aus — und
   * seine Prüfungen kennen je nach Stelle nur `true`, `1`, `"1"`, `"true"` und
   * teils `"on"` in Kleinschreibung. Ein „ON" käme dort durchweg als *aus* an.
   * Was das Expose als binär ausweist, wird deshalb als Wahrheitswert gemeldet.
   *
   * Mehrwertige Zustände bleiben Text: Ein Rollladen kennt OPEN/CLOSE/STOP, ein
   * Thermostat mehrere Betriebsarten — daraus ließe sich kein Wahrheitswert
   * bilden, ohne Bedeutung zu verlieren.
   */
  function publishableValue(entry, property, raw) {
    const feature = entry.featureByProperty && entry.featureByProperty.get(property);
    if (feature && feature.type === 'binary') {
      if (typeof raw === 'boolean') return raw;
      if (feature.valueOn !== undefined && raw === feature.valueOn) return true;
      if (feature.valueOff !== undefined && raw === feature.valueOff) return false;
      const text = String(raw == null ? '' : raw).trim().toLowerCase();
      if (['on', 'true', '1', 'ein', 'open', 'lock', 'locked'].includes(text)) return true;
      if (['off', 'false', '0', 'aus', 'close', 'closed', 'unlock', 'unlocked'].includes(text)) return false;
      // Eine unerwartete Ausprägung wird nicht geraten, sondern unverändert
      // weitergereicht — lieber sichtbar fremd als still falsch.
    }
    return exposesLib.normalizeValue(raw);
  }

  /**
   * Übernimmt vom Converter gelieferte Werte in den Gerätezustand und liefert
   * die zu meldenden homeESS-Werte.
   */
  function applyValues(entry, payload) {
    const values = [];
    for (const [property, raw] of Object.entries(payload || {})) {
      const value = publishableValue(entry, property, raw);
      if (value === null && raw !== null) continue;
      // Im Gerätezustand bleibt die Schreibweise der Converter erhalten: Sie
      // bekommen ihn als `meta.state` zurück und erwarten dort ihre eigene Form.
      entry.state[property] = raw;
      values.push({ address: exposesLib.stateAddress(entry.ieeeAddress, property), value });
    }
    return values;
  }

  /**
   * Diagnosewerte eines Gerätes (Verfügbarkeit, Verbindungsqualität, …).
   *
   * Gemeldet wird nur, was sich tatsächlich geändert hat. Verfügbarkeit und
   * Interviewstatus stehen über Stunden still; sie bei jeder eingehenden
   * Nachricht und in jedem Prüfzyklus erneut zu melden, löst in homeESS
   * unnötigen Regelungs-Fan-out aus. `last_seen` ändert sich dagegen bei jedem
   * Kontakt und wird deshalb regulär mitgeführt.
   */
  function diagnosticValues(entry, now = Date.now()) {
    const evaluation = availability.evaluate(entry, config(), now);
    entry.available = evaluation.available;
    const address = (property) => exposesLib.stateAddress(entry.ieeeAddress, property);
    const published = entry.publishedDiagnostics || (entry.publishedDiagnostics = {});
    const values = [];

    // „Verfügbar" ist ein Wahrheitswert. Solange er nicht feststeht, wird nichts
    // gemeldet — ein Text „unbekannt" in einem sonst booleschen State würde von
    // jeder Auswertung als *wahr* gelesen.
    if (evaluation.available !== null && published.available !== evaluation.available) {
      published.available = evaluation.available;
      values.push({ address: address('available'), value: evaluation.available });
    }

    const interview = interviewLabel(entry.interviewState);
    if (published.interviewState !== interview) {
      published.interviewState = interview;
      values.push({ address: address('interview_state'), value: interview });
    }

    if (entry.linkquality != null && published.linkquality !== entry.linkquality) {
      published.linkquality = entry.linkquality;
      values.push({ address: address('linkquality'), value: entry.linkquality });
    }

    const lastSeen = entry.lastSeen ? new Date(entry.lastSeen).toISOString() : '';
    if (published.lastSeen !== lastSeen) {
      published.lastSeen = lastSeen;
      values.push({ address: address('last_seen'), value: lastSeen });
    }
    return values;
  }

  /**
   * Erzwingt die erneute Meldung aller Diagnosewerte — nach einem Neuaufbau des
   * State-Katalogs, wenn homeESS die bisherigen Werte nicht mehr kennt.
   */
  function resetDiagnostics() {
    for (const entry of entries.values()) entry.publishedDiagnostics = {};
  }

  /**
   * Kennung des zuletzt an die Geräteliste gemeldeten Zustands. Die Liste wird
   * in den Instanz-Einstellungen persistiert; sie bei jeder eingehenden
   * Nachricht neu zu schreiben, hieße die Datenbank ohne Not zu beschäftigen.
   */
  function rowsSignature() {
    return all()
      .map((entry) => `${entry.slug}:${entry.friendlyName}:${entry.available}:${entry.features.length}`)
      .sort()
      .join('|');
  }

  /**
   * Zeilen für die Geräteseite von homeESS.
   */
  function deviceRows() {
    return all().map((entry) => ({
      address: entry.slug,
      name: entry.friendlyName,
      customName: customNames.get(entry.slug) || '',
      type: entry.model || entry.zigbeeModel || 'Zigbee-Gerät',
      generation: entry.vendor || '',
      online: entry.available === null ? false : !!entry.available,
      channels: [{
        address: 'zigbee',
        name: entry.friendlyName,
        states: entry.features.map((feature) => ({
          address: exposesLib.stateAddress(entry.ieeeAddress, feature.property),
          name: feature.label,
          unit: feature.unit || '',
          writable: feature.writable,
        })),
      }],
    }));
  }

  /**
   * Ausführliche Gerätebeschreibung für die Verwaltungsseite.
   */
  function deviceDetails(now = Date.now()) {
    return all().map((entry) => {
      const evaluation = availability.evaluate(entry, config(), now);
      return {
        slug: entry.slug,
        ieeeAddress: entry.ieeeAddress,
        networkAddress: entry.networkAddress,
        friendlyName: entry.friendlyName,
        manufacturer: entry.vendor || entry.manufacturer || '',
        model: entry.model || '',
        zigbeeModel: entry.zigbeeModel || '',
        description: entry.description || '',
        deviceType: entry.deviceType,
        powerSource: entry.powerSource || '',
        deviceClass: entry.deviceClass,
        battery: entry.state && entry.state.battery != null ? entry.state.battery : null,
        linkquality: entry.linkquality,
        lastSeen: entry.lastSeen ? new Date(entry.lastSeen).toISOString() : '',
        available: evaluation.available,
        interviewState: interviewLabel(entry.interviewState),
        supported: entry.supported,
        generated: entry.generated,
        // Ein Eintrag ohne Modellkennung, ohne Endpunkte und ohne je empfangene
        // Meldung ist kein erkanntes Gerät, sondern in aller Regel eine Altlast
        // aus der Adressverwaltung des Coordinators.
        unidentified: !entry.zigbeeModel && !entry.model && !entry.lastSeen
          && entry.features.length === 0,
        propertyCount: entry.features.length,
        properties: entry.features.map((feature) => ({
          property: feature.property,
          label: feature.label,
          unit: feature.unit,
          writable: feature.writable,
          type: feature.type,
        })),
      };
    }).sort((a, b) => a.friendlyName.localeCompare(b.friendlyName, 'de'));
  }

  function onlineCount(now = Date.now()) {
    return all().filter((entry) => availability.evaluate(entry, config(), now).available === true).length;
  }

  return {
    upsert,
    remove,
    get,
    bySlugOrIeee,
    all,
    size,
    buildCatalog,
    notifyCatalogChanged,
    applyValues,
    publishableValue,
    applyCustomNames,
    setCustomName,
    customName,
    diagnosticValues,
    resetDiagnostics,
    deviceRows,
    rowsSignature,
    deviceDetails,
    onlineCount,
    displayName,
    interviewLabel,
    log,
  };
}

module.exports = { createRegistry, describeDevice, interviewLabel, INTERVIEW_LABELS };
