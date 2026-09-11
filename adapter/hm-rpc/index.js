'use strict';

const http = require('http');
const createQueue = require('./rpc-queue');
const { call, methodResponse, parseCall } = require('./xmlrpc');

const OPERATIONS_WRITE = 2;
const DUTY_KEYS = new Set(['DUTY_CYCLE', 'DUTYCYCLE']);
const CATALOG_DEBOUNCE_MS = 500;
const READ_THROTTLE_MS = 3000;
// Kleinster Abstand zwischen zwei Hintergrund-Refreshs. Deckelt die CCU-Last bei
// sehr vielen Kanälen und kurzem Fenster (dann dauert ein Zyklus eben länger).
const MIN_DRIP_MS = 200;
// Nach einem Steuerbefehl das betroffene Gerät kurz aktiv beobachten, damit ein
// zugehöriges Status-Topic zeitnah nachzieht (CCU-Cache, kein Funk).
const ACTIVE_WATCH_MS = 5000;
const ACTIVE_WATCH_INTERVAL_MS = 1000;
// Ein CCU-updateDevice-Burst (oft viele Geräte gleichzeitig) darf nur EINEN
// vollständigen Re-Sync auslösen, nicht pro Ereignis einen. Das Fenster fasst
// die Bursts zusammen; ein Single-Flight-Schutz verhindert Überlappungen.
const RESYNC_DEBOUNCE_MS = 2000;
// So viele transportbedingte Fehlschläge in Folge gelten als tote CCU-Verbindung.
// Einzelne Fehlschläge (Gerät offline, kurzer Netzwerkschluckauf, eine gerade
// beschäftigte CCU) bleiben still. Gilt für Lese- UND Prüfpfad gemeinsam: ein
// erfolgreicher Aufruf irgendeiner Art belegt die Verbindung und setzt zurück.
const TRANSPORT_FAILURE_LIMIT = 3;
// Hintergrundabfragen nach einem Funkbefehl kurz pausieren.
const WRITE_GRACE_MS = 5000;
// Zeitlimit für den Erreichbarkeitstest vor einem Steuerbefehl bei scheinbar
// getrennter Verbindung. Kurz gehalten: er soll den Schaltvorgang nicht bremsen.
const PROBE_TIMEOUT_MS = 5000;
// Ein Steuerbefehl geht über Funk und wird von der CCU erst nach ihrem eigenen
// Geräte-Timeout quittiert – deutlich länger als ein lokaler Schnittstellen-
// Aufruf. Ohne eigenes Zeitlimit liefe jeder Befehl an ein trages oder gerade
// stummes Gerät in die 10-s-Voreinstellung und gälte fälschlich als Fehler.
const WRITE_TIMEOUT_MS = 30000;
// Ein optimistisch (ohne Readback-Event) gemerkter Schreibwert unterdrückt einen
// gleichlautenden Folgebefehl nur so lange. Danach darf derselbe Wert erneut
// gesendet werden: Kam der Befehl beim Gerät nie an, bleibt es sonst dauerhaft
// unschaltbar, weil jeder weitere Klick still am Vergleich hängen bliebe.
const UNCONFIRMED_REPEAT_MS = 30000;
// Der erste Geräteabgleich nach dem Start hat Vorrang vor Schreibbefehlen. Er
// dauert nur Sekundenbruchteile (reine CCU-Cache-Lesungen) und liefert genau die
// Istwerte, an denen der Schreibpfad überflüssige Funkbefehle erkennt. Nach
// dieser Frist gilt wieder die normale Reihenfolge, damit ein hängender Abgleich
// keine Schaltbefehle staut.
const FIRST_SYNC_PRIORITY_MS = 30000;
// Ein Funkbefehl an ein Gerät, das sich als nicht erreichbar meldet, wird von der
// CCU erst nach ihrem Geräte-Timeout (~20 s) mit einem Fehler quittiert und
// blockiert so lange die gemeinsame Warteschlange. Solche Aufträge werden
// vorgemerkt und erst gesendet, wenn das Gerät sich zurückmeldet.
const DEFERRED_WRITE_MAX_AGE_MS = 30 * 60 * 1000;

function segment(value) {
  return encodeURIComponent(String(value));
}

function unsegment(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function stateAddress(channel, parameter) {
  return `${segment(channel)}/${segment(parameter)}`;
}

function normalizeValue(value, description = {}) {
  if (description.TYPE === 'BOOL' || description.TYPE === 'ACTION') {
    if (typeof value === 'string') return /^(1|true|on|yes|ein)$/i.test(value.trim());
    return value === true || value === 1;
  }
  if (['FLOAT', 'INTEGER'].includes(description.TYPE) && value !== '') return Number(value);
  return value;
}

function unitOf(description) {
  const unit = description && description.UNIT;
  if (!unit) return '';
  return unit === '100%' ? '%' : String(unit);
}

module.exports = function createHmRpcAdapter(host) {
  let cfg = {};
  let server = null;
  let reconnectTimer = null;
  let catalogTimer = null;
  let resyncTimer = null;
  let dripTimer = null;
  let dripQueue = [];
  let dripIndex = 0;
  let activeWatchTimer = null;
  const activeWatchUntil = new Map(); // Geräteadresse -> Ablaufzeitpunkt (ms)
  let resyncQueued = false;
  let stopped = false;
  let registered = false;
  let connectionCheckRunning = false;
  let rpcOptions = null;
  let callbackUrl = '';
  let latestDutyCycle = null;
  let callbackCount = 0;
  let eventCount = 0;
  let lastEventLogAt = 0;
  // Zeitpunkt des letzten von der CCU empfangenen Callbacks (Event, listDevices, …).
  // Bleibt er ein volles Prüfintervall lang stehen, ist die Event-Registrierung
  // auf der CCU möglicherweise verloren (z. B. nach CCU-Neustart) → Re-Init.
  let lastCallbackAt = 0;
  let lastInitAt = 0;
  // Transportbedingte Fehlschläge in Folge (siehe noteTransportFailure).
  let transportFailures = 0;
  // Laufende eigene Steuerbefehle bzw. Zeitpunkt des zuletzt beendeten. Solange
  // ein Befehl die CCU-Schnittstelle blockiert, sind Zeitüberschreitungen
  // paralleler Aufrufe erwartbar (siehe WRITE_GRACE_MS).
  let pendingWrites = 0;
  let lastWriteEndedAt = 0;
  // Sofort-Reconnect nach einem Verbindungsverlust, damit nicht bis zum nächsten
  // Intervall-Tick jeder Schaltbefehl ins Leere liefe.
  let reconnectSoonTimer = null;
  const queue = createQueue();
  let generation = 0;
  let nextReconnectAt = 0;
  let reconnectAttempts = 0;
  let syncComplete = false;
  let syncPromise = null;
  let activeWatchRunning = false;
  let probePromise = null;
  let probeResult = false;
  let probeAt = 0;
  const channelSchemas = new Map();
  const initializedChannels = new Set();
  // Schreibaufträge für nicht erreichbare Geräte: State-Adresse -> { value, at }.
  // Je Adresse gilt der neueste Wert – wie bei der Ersetzung in der Warteschlange.
  const deferredWrites = new Map();
  let startedAt = 0;
  // true, solange der erste Abgleich als ein einziger Warteschlangen-Auftrag läuft.
  let syncInline = false;
  const descriptions = new Map();
  const channels = new Map();
  const states = new Map();
  // State-Adresse -> { value, confirmed, at }. Dient dem Steuerbefehl als
  // Vergleichsbasis: Ein Schreibvorgang mit unverändertem Wert löst KEINEN
  // erneuten setValue an die CCU aus (spart Funk/Duty-Cycle). Bestätigte Werte
  // stammen aus dem Event-/Refresh-Pfad, also derselben Quelle wie die
  // publizierten Werte; `confirmed: false` markiert den nur optimistisch
  // gemerkten Wert direkt nach einem Steuerbefehl (siehe UNCONFIRMED_REPEAT_MS).
  const lastValues = new Map();
  // Kanal -> letzter getParamset-Refresh (ms). Bündelt die je-State-Refreshwünsche
  // eines Kanals, damit ein Live-Tick nicht mehrere getParamset pro Kanal auslöst.
  const readThrottle = new Map();
  // Geräteadresse (Top-Level, z. B. "ABC0000001") -> vom Nutzer vergebener Klarname.
  const customNames = new Map();

  function interfaceId() {
    return `homeESS-${host.name}`;
  }

  function reconnectMs() {
    return Math.max(1, Number(cfg.reconnectInterval) || 30) * 1000;
  }

  function dutyLimit() {
    const value = Number(cfg.dutyCycleLimit);
    return Number.isFinite(value) ? value : 80;
  }

  function writesBlocked() {
    const limit = dutyLimit();
    return limit > 0 && latestDutyCycle != null && latestDutyCycle >= limit;
  }

  function publishCatalog() {
    const fixed = [
      { address: 'status/callback-connected', name: 'Callback bestätigt', category: 'Schnittstelle', writable: false },
      { address: 'status/event-count', name: 'Empfangene Werteereignisse', category: 'Schnittstelle', writable: false },
      { address: 'status/last-event-at', name: 'Letztes Werteereignis', category: 'Schnittstelle', writable: false },
      { address: 'status/duty-cycle', name: 'Duty Cycle', category: 'Schnittstelle', unit: '%', writable: false },
      { address: 'status/writes-blocked', name: 'Schreibsperre aktiv', category: 'Schnittstelle', writable: false },
    ];
    host.setStates([...fixed, ...Array.from(states.values()).sort((a, b) => a.address.localeCompare(b.address, 'de'))]);
  }

  function scheduleCatalog() {
    if (catalogTimer) return;
    catalogTimer = setTimeout(() => {
      catalogTimer = null;
      publishCatalog();
    }, CATALOG_DEBOUNCE_MS);
  }

  // Anzeigename eines Kanals (z. B. "Kanal 1"), CCU-Name bevorzugt.
  function channelDisplayName(channelAddress) {
    const channel = channels.get(channelAddress) || {};
    const channelNumber = String(channelAddress).includes(':') ? String(channelAddress).split(':').pop() : channelAddress;
    return channel.NAME || `${channel.TYPE || 'Kanal'} (${channelNumber})`;
  }

  // Vorgegebener Gerätename ohne Nutzer-Umbenennung: CCU-Name, sonst Typ + Adresse.
  function deviceDefaultName(channel, channelAddress) {
    const parent = channels.get(channel.PARENT) || {};
    return parent.NAME || (channel.PARENT
      ? `${parent.TYPE || 'Gerät'} (${channel.PARENT})`
      : channelAddress);
  }

  // Effektiver Gerätename: erst der frei vergebene Klarname, sonst der Default.
  function deviceDisplayName(channel, channelAddress) {
    const deviceAddress = channel.PARENT || channelAddress;
    return customNames.get(String(deviceAddress)) || deviceDefaultName(channel, channelAddress);
  }

  function rememberState(channelAddress, parameter, description = {}) {
    const address = stateAddress(channelAddress, parameter);
    const existing = states.get(address);
    // Ein Event kann einen State anlegen, BEVOR die Schleife die zugehörige
    // Parameterbeschreibung (mit UNIT/OPERATIONS) geladen hat. Eine leere
    // Beschreibung darf einen bereits bekannten Eintrag daher nicht verschlechtern;
    // eine echte Beschreibung wertet ihn dagegen nachträglich auf (behebt sonst
    // dauerhaft fehlende Einheiten bei großen Anlagen mit Event-Flut im Sync).
    const hasDescription = description && Object.keys(description).length > 0;
    if (existing && !hasDescription) return address;
    const channel = channels.get(channelAddress) || {};
    const name = `${channelDisplayName(channelAddress)} ${parameter}`;
    const category = `${deviceDisplayName(channel, channelAddress)} / ${channelDisplayName(channelAddress)}`;
    const unit = unitOf(description);
    const writable = (Number(description.OPERATIONS) & OPERATIONS_WRITE) !== 0;
    if (existing) {
      if (existing.unit !== unit || existing.writable !== writable
        || existing.name !== name || existing.category !== category) {
        existing.unit = unit;
        existing.writable = writable;
        existing.name = name;
        existing.category = category;
        scheduleCatalog(); // korrigierte Metadaten in den persistierten Katalog übernehmen
      }
      return address;
    }
    states.set(address, { address, name, category, unit, writable });
    return address;
  }

  // Geräteliste für die Adapter-Geräteseite: gruppiert die erkannten Kanäle/States
  // unter ihrem Top-Level-Gerät. Die technische Geräteadresse (ID) bleibt erhalten,
  // ergänzt um den frei vergebenen Klarnamen und den CCU-Default.
  function buildDeviceRecords() {
    const records = new Map();
    const ensure = (deviceAddress, defaultName) => {
      let record = records.get(deviceAddress);
      if (!record) {
        record = {
          address: deviceAddress,
          name: defaultName,
          customName: customNames.get(String(deviceAddress)) || '',
          channels: new Map(),
        };
        records.set(deviceAddress, record);
      }
      return record;
    };
    // Top-Level-Geräte aus der CCU-Liste vorbelegen (auch ohne VALUES-States).
    for (const [address, entry] of channels) {
      if (entry.PARENT || String(address).includes(':')) continue;
      ensure(address, entry.NAME || `${entry.TYPE || 'Gerät'} (${address})`);
    }
    // States ihren Kanälen und Geräten zuordnen.
    for (const [stateAddr, meta] of states) {
      const channelAddress = unsegment(stateAddr.split('/')[0]);
      const channel = channels.get(channelAddress) || {};
      const deviceAddress = channel.PARENT || channelAddress;
      const record = ensure(deviceAddress, deviceDefaultName(channel, channelAddress));
      let channelRecord = record.channels.get(channelAddress);
      if (!channelRecord) {
        channelRecord = { address: channelAddress, name: channelDisplayName(channelAddress), states: [] };
        record.channels.set(channelAddress, channelRecord);
      }
      channelRecord.states.push({ address: stateAddr, name: meta.name, unit: meta.unit || '', writable: !!meta.writable });
    }
    return Array.from(records.values())
      .map((record) => ({
        address: record.address,
        name: record.name,
        customName: record.customName,
        channels: Array.from(record.channels.values())
          .sort((a, b) => a.address.localeCompare(b.address, 'de'))
          .map((channel) => ({
            ...channel,
            states: channel.states.sort((a, b) => a.address.localeCompare(b.address, 'de')),
          })),
      }))
      .sort((a, b) => a.address.localeCompare(b.address, 'de'));
  }

  function publishDevices() {
    if (typeof host.setStorage === 'function') host.setStorage('devices', buildDeviceRecords());
  }

  // Persistierte Geräteliste (settings.devices) beim Start in die internen Maps
  // zurückspielen. Dadurch bleibt die Geräteseite über einen Adapterneustart
  // hinweg verfügbar und wird NICHT jedes Mal aus der CCU neu aufgebaut – die
  // spätere Synchronisierung ergänzt nur (rememberState ist idempotent), und
  // ohne erreichbare CCU bleibt die Liste unverändert erhalten.
  function restoreDevices(records) {
    for (const device of Array.isArray(records) ? records : []) {
      if (!device || !device.address) continue;
      const deviceAddress = String(device.address);
      const deviceName = device.name || deviceAddress;
      if (device.customName) customNames.set(deviceAddress, String(device.customName));
      if (!channels.has(deviceAddress)) channels.set(deviceAddress, { ADDRESS: deviceAddress, NAME: deviceName });
      for (const channel of device.channels || []) {
        if (!channel || !channel.address) continue;
        const channelAddress = String(channel.address);
        if (!channels.has(channelAddress)) {
          channels.set(channelAddress, { ADDRESS: channelAddress, NAME: channel.name || channelAddress, PARENT: deviceAddress });
        }
        for (const state of channel.states || []) {
          if (!state || !state.address || states.has(state.address)) continue;
          const channelEntry = channels.get(channelAddress);
          states.set(String(state.address), {
            address: String(state.address),
            name: state.name || String(state.address),
            category: `${deviceDisplayName(channelEntry, channelAddress)} / ${channelDisplayName(channelAddress)}`,
            unit: state.unit || '',
            writable: !!state.writable,
          });
        }
      }
    }
  }

  // Wartungskanal (":0") des Geräts, zu dem ein Kanal gehört. Dort führt die CCU
  // UNREACH, CONFIG_PENDING und die Batteriemeldung.
  function maintenanceChannel(channelAddress) {
    const address = `${deviceOfChannel(channelAddress)}:0`;
    return channels.has(address) ? address : null;
  }

  // CCU-Flags kommen je nach Schnittstelle als BOOL oder als 0/1.
  function flagSet(value) {
    return value === true || value === 1 || value === '1';
  }

  // Meldet die CCU das Gerät als nicht erreichbar? Nur ein bestätigter Wert aus
  // dem Wartungskanal zählt; ohne Kenntnis wird wie bisher gesendet.
  function deviceUnreachable(channelAddress) {
    const maintenance = maintenanceChannel(channelAddress);
    if (!maintenance) return false;
    const entry = lastValues.get(stateAddress(maintenance, 'UNREACH'));
    return !!(entry && entry.confirmed && flagSet(entry.value));
  }

  // Ein zurückgekehrtes Gerät bekommt seine vorgemerkten Sollwerte. Zu alte
  // Aufträge verfallen: Nach Stunden wäre der damals gültige Sollwert überholt,
  // und der reguläre Regelzyklus schreibt ohnehin neu.
  function flushDeferredWrites(deviceAddresses) {
    for (const [address, job] of Array.from(deferredWrites)) {
      const channelAddress = unsegment(String(address).split('/')[0]);
      if (!deviceAddresses.has(deviceOfChannel(channelAddress))) continue;
      deferredWrites.delete(address);
      if (Date.now() - job.at > DEFERRED_WRITE_MAX_AGE_MS) continue;
      host.log(`Vorgemerktes Schreiben ${address} wird nachgeholt: Gerät meldet sich wieder`);
      writeState(address, job.value).catch(() => {});
    }
  }

  function eventValues(channelAddress, parameter, value) {
    const key = `${channelAddress}\0${parameter}`;
    const description = descriptions.get(key) || {};
    const isNew = !states.has(stateAddress(channelAddress, parameter));
    const address = rememberState(channelAddress, parameter, description);
    const result = [{ address, value: normalizeValue(value, description) }];
    if (DUTY_KEYS.has(String(parameter).toUpperCase())) {
      const number = Number(value);
      if (Number.isFinite(number)) {
        latestDutyCycle = number;
        result.push(
          { address: 'status/duty-cycle', value: number },
          { address: 'status/writes-blocked', value: writesBlocked() },
        );
      }
    }
    if (isNew) scheduleCatalog();
    return result;
  }

  function publishEventBurst(events, statusEntries = []) {
    const latest = new Map();
    for (const event of events || []) {
      if (!event || event.length < 3) continue;
      for (const entry of eventValues(event[0], event[1], event[2])) latest.set(entry.address, entry);
    }
    for (const entry of statusEntries) latest.set(entry.address, entry);
    if (latest.size) {
      // Werte aus der CCU sind belegt (Readback/Refresh) – sie bestätigen einen
      // zuvor optimistisch gemerkten Schreibwert bzw. korrigieren ihn.
      const returned = new Set();
      for (const entry of latest.values()) {
        lastValues.set(entry.address, { value: entry.value, confirmed: true, at: Date.now() });
        // UNREACH false meldet ein Gerät zurück – Auslöser für vorgemerkte Aufträge.
        const parts = String(entry.address).split('/');
        if (parts.length === 2 && unsegment(parts[1]) === 'UNREACH' && !flagSet(entry.value)) {
          returned.add(deviceOfChannel(unsegment(parts[0])));
        }
      }
      host.publishStates(Array.from(latest.values()));
      if (returned.size && deferredWrites.size) flushDeferredWrites(returned);
    }
  }

  function noteIncomingEvents(count) {
    if (!count) return [];
    eventCount += count;
    const now = Date.now();
    const statusEntries = [
      { address: 'status/event-count', value: eventCount },
      { address: 'status/last-event-at', value: new Date(now).toISOString() },
    ];
    // Der erste echte Wert nach jeder Registrierung ist der entscheidende
    // Ende-zu-Ende-Nachweis. Danach höchstens einmal pro Minute protokollieren.
    if (eventCount === count || now - lastEventLogAt >= 60000) {
      host.log(`CCU-Werteevents empfangen: ${count} im Batch, ${eventCount} seit Adapterstart`);
      lastEventLogAt = now;
    }
    return statusEntries;
  }

  // Nur innerhalb der gemeinsamen Warteschlange aufrufen.
  async function performRpc(method, params, timeout) {
    try {
      const result = await call(rpcOptions, method, params, timeout);
      noteTransportSuccess();
      return result;
    } catch (err) {
      if (typeof err.code === 'number') noteTransportSuccess();
      throw err;
    }
  }

  function rpc(method, params, timeout, priority = 0) {
    const epoch = generation;
    return queue.run(async () => {
      if (stopped || epoch !== generation) throw Object.assign(new Error('Veralteter RPC-Auftrag'), { cancelled: true });
      const result = await performRpc(method, params, timeout);
      if (stopped || epoch !== generation) throw Object.assign(new Error('Veraltete RPC-Antwort'), { cancelled: true });
      return result.value;
    }, { key: `${epoch}:${method}:${JSON.stringify(params)}`, priority });
  }

  // Aufruf des Geräteabgleichs. Läuft der Abgleich als ein einziger Auftrag
  // (erster Abgleich nach dem Start, siehe synchronize), dann direkt – ein
  // verschachtelter Warteschlangen-Auftrag käme nie an die Reihe.
  async function syncCall(method, params) {
    if (!syncInline) return rpc(method, params);
    if (stopped) throw Object.assign(new Error('Veralteter RPC-Auftrag'), { cancelled: true });
    const result = await performRpc(method, params, undefined);
    return result.value;
  }

  // Istwerte eines Kanals innerhalb eines laufenden Warteschlangen-Auftrags
  // nachziehen. Bewusst ohne queue.run(): Die Warteschlange arbeitet die
  // Aufträge nacheinander ab, ein verschachtelter Auftrag käme nie an die Reihe.
  async function primeChannelInline(channelAddress) {
    try {
      const values = await performRpc('getParamset', [channelAddress, 'VALUES'], PROBE_TIMEOUT_MS);
      const burst = Object.entries(values.value || {}).map(([parameter, value]) => [channelAddress, parameter, value]);
      if (burst.length) publishEventBurst(burst);
      initializedChannels.add(channelAddress);
    } catch (err) {
      // Ein CCU-Fault bedeutet nur: dieser Kanal ist momentan nicht lesbar. Der
      // Schreibbefehl läuft danach wie bisher – ohne Vergleichswert eben blind.
      if (typeof err.code !== 'number') throw err;
    }
  }

  // Parallel eintreffende Steuerbefehle teilen einen Test, auch bei negativem
  // Ergebnis. So erzeugen dreizehn Heizungsräume keinen dreizehnfachen Probe-Burst.
  async function interfaceAlive(timeout) {
    if (probePromise) return probePromise;
    if (Date.now() - probeAt < PROBE_TIMEOUT_MS) return probeResult;
    probePromise = (async () => {
      try { await performRpc('system.listMethods', [], timeout); probeResult = true; }
      catch (_) { probeResult = false; }
      probeAt = Date.now();
      return probeResult;
    })();
    try { return await probePromise; } finally { probePromise = null; }
  }

  // Blockiert gerade ein eigener Steuerbefehl den CCU-Schnittstellenprozess?
  // Dann sind Zeitüberschreitungen paralleler Aufrufe hausgemacht und sagen
  // nichts über die Verbindung aus (siehe WRITE_GRACE_MS).
  function writeInFlight() {
    return pendingWrites > 0 || (lastWriteEndedAt > 0 && Date.now() - lastWriteEndedAt < WRITE_GRACE_MS);
  }

  // Ein geglückter CCU-Aufruf belegt die Verbindung – egal aus welchem Pfad.
  function noteTransportSuccess() {
    transportFailures = 0;
  }

  // Verbindungsverlust melden. Nur beim tatsächlichen Zustandswechsel, damit das
  // Protokoll den Wechsel zeigt (bisher war ein "getrennt" nirgends sichtbar).
  function markDisconnected(detail) {
    const wasRegistered = registered;
    registered = false;
    if (wasRegistered) generation += 1;
    for (const [key, entry] of lastValues) lastValues.set(key, { ...entry, confirmed: false, at: 0 });
    host.publishState('status/callback-connected', false);
    if (wasRegistered) host.error(`Verbindung zur CCU verloren: ${detail}`);
    host.setConnected(false, `CCU-RPC: ${detail}`);
  }

  // Nach einem Verbindungsverlust nicht bis zum nächsten Prüfintervall warten:
  // bis dahin liefe jeder Schaltbefehl in den Erreichbarkeitstest oder ins Leere.
  function scheduleImmediateReconnect() {
    if (stopped || registered || reconnectSoonTimer) return;
    const delay = Math.max(1000, nextReconnectAt - Date.now());
    reconnectSoonTimer = setTimeout(() => {
      reconnectSoonTimer = null;
      register().catch(() => {});
    }, delay);
  }

  // Transportfehler (Zeitüberschreitung, Verbindungsabbruch, HTTP-Fehler) buchen.
  // Erst mehrere in Folge gelten als tote Verbindung – ein einzelner Fehlschlag
  // bedeutet meist nur eine gerade beschäftigte CCU. Eigene Aufrufe laufen
  // bereits seriell; abgebrochene alte Aufträge zählen nicht als Netzfehler.
  function noteTransportFailure(err) {
    if (err.cancelled || stopped) return false;
    transportFailures += 1;
    if (transportFailures < TRANSPORT_FAILURE_LIMIT || !registered) return false;
    markDisconnected(`${err.message} (${transportFailures} Transportfehler in Folge)`);
    scheduleImmediateReconnect();
    return true;
  }

  async function loadChannel(channel, initialValues) {
    if (!Array.isArray(channel.PARAMSETS) || !channel.PARAMSETS.includes('VALUES')) return;
    const cached = channelSchemas.get(channel.ADDRESS);
    let description = cached && cached.version === channel.VERSION ? cached.description : null;
    try {
      if (!description) {
        description = await syncCall('getParamsetDescription', [channel.ADDRESS, 'VALUES']);
        channelSchemas.set(channel.ADDRESS, { version: channel.VERSION, description });
      }
      for (const [parameter, detail] of Object.entries(description || {})) {
        descriptions.set(`${channel.ADDRESS}\0${parameter}`, detail || {});
        rememberState(channel.ADDRESS, parameter, detail || {});
      }
      if (initializedChannels.has(channel.ADDRESS)) return;
      const before = new Map(lastValues);
      const values = await syncCall('getParamset', [channel.ADDRESS, 'VALUES']);
      for (const [parameter, value] of Object.entries(values || {})) {
        const address = stateAddress(channel.ADDRESS, parameter);
        if (lastValues.get(address) === before.get(address)) initialValues.push([channel.ADDRESS, parameter, value]);
      }
      initializedChannels.add(channel.ADDRESS);
    } catch (err) {
      if (typeof err.code !== 'number') throw err;
      host.error(`Gerätedaten ${channel.ADDRESS}: ${err.message}`);
    }
  }

  // Ein Durchlauf: Gerätebestand holen und jeden Kanal nachziehen, der noch
  // keine Werte geliefert hat.
  async function runSync(epoch) {
    const devices = await syncCall('listDevices', []);
    for (const entry of devices || []) if (entry && entry.ADDRESS) {
      const previous = channels.get(entry.ADDRESS);
      if (previous && previous.VERSION !== entry.VERSION) initializedChannels.delete(entry.ADDRESS);
      channels.set(entry.ADDRESS, entry);
    }
    for (const entry of channels.values()) {
      if (stopped || !registered || epoch !== generation) return;
      const values = [];
      await loadChannel(entry, values);
      if (stopped || epoch !== generation) return;
      // Sofort übernehmen: ein später gelesener Kanal darf aktuelle Events
      // nicht durch einen minutenalten Gesamt-Batch überschreiben.
      publishEventBurst(values);
    }
    syncComplete = true;
    reconnectAttempts = 0;
    host.log(`CCU-Geräteabgleich abgeschlossen (${channels.size} Geräte/Kanäle)`);
  }

  function synchronize() {
    if (syncPromise) { resyncQueued = true; return syncPromise; }
    if (stopped || !registered) return Promise.resolve();
    const epoch = generation;
    // Der erste Abgleich nach dem Start läuft als EIN Warteschlangen-Auftrag. Er
    // dauert nur Sekundenbruchteile (reine CCU-Cache-Lesungen) und liefert die
    // Istwerte, an denen der Schreibpfad überflüssige Funkbefehle erkennt; ein
    // dazwischen eintreffender Schaltbefehl würde sonst zwischen zwei Kanälen
    // durchrutschen und blind senden. Spätere Abgleiche reihen sich Kanal für
    // Kanal ein, damit Schaltbefehle sofort an die Reihe kommen.
    const zuerst = !syncComplete && Date.now() - startedAt < FIRST_SYNC_PRIORITY_MS;
    syncPromise = (async () => {
      try {
        if (zuerst) {
          syncInline = true;
          // Priorität über der von Schreibbefehlen (10); die Frist deckt auch
          // einen davor laufenden Funkbefehl ab, statt den Abgleich zu verwerfen.
          await queue.run(() => runSync(epoch), { priority: 15, maxAge: 300000 });
        } else {
          await runSync(epoch);
        }
      } catch (err) {
        if (!stopped && err.cancelled && registered) scheduleResync();
        if (!stopped && !err.cancelled && epoch === generation) {
          markDisconnected(`Geräteabgleich unterbrochen: ${err.message}`);
          nextReconnectAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(reconnectAttempts++, 6));
          scheduleImmediateReconnect();
        }
      } finally {
        syncInline = false;
        syncPromise = null;
        if (!stopped) {
          publishCatalog();
          publishDevices();
          if (typeof host.setStorage === 'function') host.setStorage('rpcMetadata', {
            channels: Array.from(channels.values()), schemas: Array.from(channelSchemas.entries()),
          });
          if (resyncQueued) { resyncQueued = false; scheduleResync(); }
        }
      }
    })();
    return syncPromise;
  }

  // updateDevice-Bursts der CCU auf einen einzigen Re-Sync zusammenfassen.
  function scheduleResync(delay = RESYNC_DEBOUNCE_MS) {
    if (resyncTimer || stopped || !registered) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      synchronize().catch((err) => host.error(`Geräteaktualisierung: ${err.message}`));
    }, delay);
  }

  // Werte eines Kanals aus dem CCU-Cache (VALUES-Paramset) nachladen und
  // republizieren. Kein Funk, kein Duty-Cycle – gleiche Quelle wie beim Sync.
  // Pro Kanal gedrosselt, damit gehäufte Refreshwünsche (mehrere States eines
  // Kanals, On-Demand + Hintergrund) nur EIN getParamset auslösen.
  const refreshes = new Map();
  function refreshChannel(channelAddress, force = false) {
    if (refreshes.has(channelAddress)) return refreshes.get(channelAddress);
    const promise = doRefreshChannel(channelAddress, force).finally(() => refreshes.delete(channelAddress));
    refreshes.set(channelAddress, promise);
    return promise;
  }

  async function doRefreshChannel(channelAddress, force = false) {
    if (!registered || !channelAddress || channelAddress === 'status') return;
    const now = Date.now();
    // Das aktive Beobachtungsfenster (force) fragt bewusst häufiger als die
    // normale Drossel – es soll eine Status-Änderung schnellstmöglich einfangen.
    if (!force && now - (readThrottle.get(channelAddress) || 0) < READ_THROTTLE_MS) return;
    readThrottle.set(channelAddress, now);
    try {
      const before = new Map(lastValues);
      const values = await rpc('getParamset', [channelAddress, 'VALUES']);
      noteTransportSuccess();
      const burst = [];
      for (const [parameter, value] of Object.entries(values || {})) {
        const address = stateAddress(channelAddress, parameter);
        if (lastValues.get(address) === before.get(address)) burst.push([channelAddress, parameter, value]);
      }
      if (burst.length) publishEventBurst(burst);
    } catch (err) {
      // CCU-Fault (numerischer XML-RPC-Fehlercode): die CCU hat geantwortet, nur
      // dieser Kanal ist momentan nicht lesbar (Gerät offline o. Ä.) – wie bisher
      // still übergehen; die Verbindung selbst ist nachweislich in Ordnung.
      if (typeof err.code === 'number') { noteTransportSuccess(); return; }
      // Transportfehler (Timeout, Verbindungsabbruch, HTTP-Fehler): mehrere in
      // Folge bedeuten eine tote CCU-Verbindung. Als getrennt melden, damit der
      // Reconnect-Pfad greift, statt Fehler unbegrenzt still zu schlucken und
      // dabei „verbunden" anzuzeigen, während alle Werte veralten.
      noteTransportFailure(err);
    }
  }

  // Alle Kanäle, für die wir States führen (ohne die Pseudo-Statuswerte).
  function refreshableChannels() {
    const set = new Set();
    for (const address of states.keys()) {
      const channelAddress = unsegment(address.split('/')[0]);
      if (channelAddress && channelAddress !== 'status') set.add(channelAddress);
    }
    return Array.from(set);
  }

  // Hintergrund-Refresh als serialisierter Round-Robin-„Drip": pro Tick genau EIN
  // Kanal, Antwort abwarten, dann der nächste. Der Taktabstand ergibt sich aus
  // Fenster/Kanalzahl (mit Jitter), sodass jeder Kanal einmal pro Fenster erneuert
  // wird und die CCU nie einen Burst, sondern einen gleichmäßigen Strom sieht.
  function refreshWindowMs() {
    return Math.max(0, Number(cfg.refreshInterval) || 0) * 1000;
  }
  function scheduleDrip() {
    if (dripTimer || stopped || refreshWindowMs() <= 0) return;
    if (dripIndex >= dripQueue.length) { dripQueue = refreshableChannels(); dripIndex = 0; }
    const count = dripQueue.length || 1;
    const base = Math.max(MIN_DRIP_MS, refreshWindowMs() / count);
    const delay = base * (0.85 + Math.random() * 0.3); // ±15 % Jitter
    dripTimer = setTimeout(async () => {
      dripTimer = null;
      if (stopped) return;
      // Solange ein eigener Steuerbefehl die CCU-Schnittstelle blockiert, keine
      // zusätzliche Last auflegen: Die Lesung liefe ohnehin nur in ihr Zeitlimit
      // und verlängerte die Blockade. Der Kanal bleibt an der Reihe.
      if (!writeInFlight()) {
        const channelAddress = dripIndex < dripQueue.length ? dripQueue[dripIndex++] : null;
        if (channelAddress) await refreshChannel(channelAddress).catch(() => {});
      }
      scheduleDrip();
    }, delay);
  }

  // Top-Level-Geräteadresse eines Kanals (z. B. "ABC:1" -> "ABC").
  function deviceOfChannel(channelAddress) {
    const channel = channels.get(channelAddress);
    return (channel && channel.PARENT) || channelAddress;
  }

  // Alle Kanäle eines Geräts, für die wir States führen (die „restlichen Topics").
  function channelsOfDevice(deviceAddress) {
    const set = new Set();
    for (const channelAddress of refreshableChannels()) {
      if (deviceOfChannel(channelAddress) === deviceAddress) set.add(channelAddress);
    }
    return Array.from(set);
  }

  // Nach einem Steuerbefehl das ganze Gerät für ACTIVE_WATCH_MS aktiv beobachten,
  // damit ein zugehöriges Status-Topic (auf demselben oder einem Schwesterkanal)
  // möglichst zeitnah den neuen Zustand widerspiegelt. Reine CCU-Cache-Lesungen.
  function armActiveWatch(deviceAddress) {
    if (!deviceAddress) return;
    activeWatchUntil.set(deviceAddress, Date.now() + ACTIVE_WATCH_MS);
    if (!activeWatchTimer && !activeWatchRunning) runActiveWatch();
  }

  function runActiveWatch() {
    activeWatchTimer = null;
    if (stopped || activeWatchRunning) return;
    const now = Date.now();
    const channelSet = new Set();
    for (const [deviceAddress, until] of activeWatchUntil) {
      if (until <= now) { activeWatchUntil.delete(deviceAddress); continue; }
      for (const channelAddress of channelsOfDevice(deviceAddress)) channelSet.add(channelAddress);
    }
    if (!channelSet.size) return;
    // Nacheinander, nicht parallel: Der CCU-Schnittstellenprozess arbeitet die
    // Aufrufe ohnehin seriell ab, ein Bündel gleichzeitiger Lesungen treibt nur
    // die hinteren in ihr Zeitlimit. force=true umgeht die Drossel – hier ist
    // schnelle Aktualität gewünscht.
    activeWatchRunning = true;
    (async () => {
      for (const channelAddress of channelSet) {
        if (stopped) return;
        await refreshChannel(channelAddress, true).catch(() => {});
      }
    })()
      .finally(() => {
        activeWatchRunning = false;
        if (!stopped && activeWatchUntil.size) {
          activeWatchTimer = setTimeout(runActiveWatch, ACTIVE_WATCH_INTERVAL_MS);
        }
      });
  }

  async function register() {
    if (stopped || registered || connectionCheckRunning || Date.now() < nextReconnectAt) return;
    connectionCheckRunning = true;
    const epoch = generation;
    try {
      const probe = await queue.run(() => performRpc('system.listMethods', [], PROBE_TIMEOUT_MS), { priority: 20 });
      if (stopped || epoch !== generation) return;
      const callbackHost = String(cfg.callbackHost || probe.localAddress || '').replace(/^::ffff:/, '');
      if (!callbackHost) throw new Error('Callback-Adresse konnte nicht ermittelt werden');
      callbackUrl = `http://${callbackHost}:${server.address().port}`;
      callbackCount = 0;
      lastCallbackAt = 0;
      await rpc('init', [callbackUrl, interfaceId()], undefined, 20);
      lastInitAt = Date.now();
      if (stopped || epoch !== generation) return;
      registered = true;
      if (syncComplete) reconnectAttempts = 0;
      nextReconnectAt = 0;
      host.log(`CCU-RPC erreichbar, Registrierung erneuert; Callback ${callbackUrl}`);
      host.setConnected(true, `CCU-RPC erreichbar; Callback ${lastCallbackAt ? 'bestätigt' : 'ausstehend'}`);
      if (!syncComplete) scheduleResync();
    } catch (err) {
      if (!stopped && !err.cancelled) {
        markDisconnected(err.message);
        nextReconnectAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(reconnectAttempts++, 6));
        host.error(`CCU-RPC Anmeldung fehlgeschlagen: ${err.message}; neuer Versuch in ${Math.ceil((nextReconnectAt - Date.now()) / 1000)} s`);
        scheduleImmediateReconnect();
      }
    } finally {
      connectionCheckRunning = false;
    }
  }

  async function maintainConnection(pingTimeout) {
    if (stopped || connectionCheckRunning) return;
    if (!registered) { await register(); return; }
    // Ein eigener Steuerbefehl blockiert die CCU-Schnittstelle gerade. Ein Ping
    // liefe garantiert in sein Zeitlimit und brächte keine Erkenntnis – der
    // laufende Befehl selbst prüft die Verbindung ohnehin mit.
    if (writeInFlight()) return;
    connectionCheckRunning = true;
    try {
      if (Date.now() - Math.max(lastCallbackAt, lastInitAt) >= reconnectMs()) {
        // Kein einziger Callback seit dem letzten Prüfintervall. Nach einem
        // CCU-Neustart ist die Event-Registrierung dort verloren, während
        // RPC-Aufrufe (und damit ein reiner Erreichbarkeits-Ping) weiter
        // gelingen – der Adapter stünde dauerhaft auf „verbunden", ohne je
        // wieder ein Event zu erhalten. Ein erneutes init ist idempotent und
        // stellt die Registrierung sicher wieder her; die CCU antwortet mit
        // listDevices-Callbacks, die die Event-Strecke Ende-zu-Ende bestätigen
        // (und lastCallbackAt fortschreiben). In ereignislosen Phasen läuft so
        // schlimmstenfalls je Intervall ein leichter init-Abgleich – kein Funk.
        const before = callbackCount;
        await rpc('init', [callbackUrl, interfaceId()], pingTimeout, 20);
        lastInitAt = Date.now();
        host.publishState('status/callback-connected', callbackCount > before);
      } else {
        // Rein lokaler Schnittstellen-Ping der CCU, niemals ein Geräte-/Funk-Read.
        await rpc('system.listMethods', [], pingTimeout, 20);
      }
      noteTransportSuccess();
    } catch (err) {
      // Nicht beim ersten Fehlschlag trennen: die CCU ist regelmäßig für einige
      // Sekunden mit einem Funkbefehl beschäftigt und antwortet dann gar nicht.
      // Ein sofortiges „getrennt" ließe bis zum nächsten Tick jeden Schaltbefehl
      // scheitern, obwohl die Verbindung in Ordnung ist.
      noteTransportFailure(err);
    } finally {
      connectionCheckRunning = false;
    }
  }

  function handleCallback(method, params) {
    if (stopped) return '';
    lastCallbackAt = Date.now();
    host.publishState('status/callback-connected', true);
    callbackCount += 1;
    // Die ersten Calls nach jeder Registrierung sichtbar machen. So lässt sich
    // unterscheiden, ob die CCU den Callback gar nicht erreicht oder Events erst
    // später ausbleiben, ohne das Log dauerhaft mit Geräteevents zu fluten.
    if (callbackCount <= 5) host.log(`XML-RPC Callback ${callbackCount}: ${method}`);
    if (method === 'system.listMethods') {
      return ['event', 'listDevices', 'newDevices', 'deleteDevices', 'updateDevice',
        'system.multicall', 'system.listMethods'];
    }
    // Laut Homematic-XML-RPC-Spezifikation gleicht der Schnittstellenprozess
    // direkt nach init() seinen Bestand mit der Logikschicht ab. ADDRESS und
    // VERSION reichen dafür aus.
    if (method === 'listDevices') {
      return Array.from(channels.values()).map((entry) => ({
        ADDRESS: entry.ADDRESS,
        VERSION: Number(entry.VERSION) || 0,
      }));
    }
    if (method === 'system.multicall') {
      const calls = Array.isArray(params[0]) ? params[0] : [];
      const events = calls.filter((entry) => entry.methodName === 'event').map((entry) => (entry.params || []).slice(1));
      publishEventBurst(events, noteIncomingEvents(events.length));
      return calls.map((entry) => entry.methodName === 'event' ? [''] : [handleCallback(entry.methodName, entry.params || [])]);
    }
    if (method === 'event') {
      publishEventBurst([[params[1], params[2], params[3]]], noteIncomingEvents(1));
    } else if (method === 'newDevices' && Array.isArray(params[1])) {
      for (const entry of params[1]) if (entry && entry.ADDRESS) {
        channels.set(entry.ADDRESS, entry);
        channelSchemas.delete(entry.ADDRESS);
        initializedChannels.delete(entry.ADDRESS);
      }
      syncComplete = false;
      scheduleResync(0);
    } else if (method === 'deleteDevices' && Array.isArray(params[1])) {
      const removed = new Set(params[1].map((entry) => typeof entry === 'string' ? entry : entry.ADDRESS));
      for (const address of removed) { channels.delete(address); channelSchemas.delete(address); initializedChannels.delete(address); }
      for (const [address] of states) {
        const channelAddress = unsegment(address.split('/')[0]);
        if (removed.has(channelAddress)) states.delete(address);
      }
      publishCatalog();
      publishDevices();
    } else if (method === 'updateDevice') {
      const address = params[1];
      for (const [key, channel] of channels) if (key === address || channel.PARENT === address) {
        channelSchemas.delete(key); initializedChannels.delete(key);
      }
      syncComplete = false;
      scheduleResync();
    }
    return '';
  }

  async function writeState(address, value) {
    const parts = String(address).split('/');
    if (stopped || parts.length !== 2 || parts[0] === 'status') return;
    const channelAddress = unsegment(parts[0]);
    const parameter = unsegment(parts[1]);
    const description = descriptions.get(`${channelAddress}\0${parameter}`);
    if (!description) {
      host.error(`Schreiben ${address} nicht ausgeführt: Parameterbeschreibung noch nicht verfügbar; Nachladen angefordert`);
      syncComplete = false;
      scheduleResync();
      return;
    }
    if ((Number(description.OPERATIONS) & OPERATIONS_WRITE) === 0) {
      host.error(`State ${address} ist laut CCU nicht schreibbar`);
      return;
    }
    const normalized = normalizeValue(value, description);
    const action = description.TYPE === 'ACTION';
    try {
      await queue.run(async () => {
        if (stopped) return;
        if (writesBlocked()) {
          host.error(`Schreiben ${address} verworfen: Duty Cycle ${latestDutyCycle}% (Grenze ${dutyLimit()}%)`);
          return;
        }
        // Vor dem ersten Schreiben auf einen noch nie gelesenen Kanal dessen
        // Istwerte holen. Diese Cache-Lesung kostet Millisekunden und erspart
        // einen blind abgesetzten Funkbefehl, den die CCU an ein trages oder
        // stummes Gerät erst nach ihrem Geräte-Timeout quittiert – während
        // dieser Zeit steht die gemeinsame Warteschlange still.
        if (registered && !initializedChannels.has(channelAddress)) {
          try { await primeChannelInline(channelAddress); } catch (_) { /* Verbindung prüft der Befehl selbst */ }
          const maintenance = maintenanceChannel(channelAddress);
          if (maintenance && !initializedChannels.has(maintenance)) {
            try { await primeChannelInline(maintenance); } catch (_) { /* s. o. */ }
          }
        }
        // Erst unmittelbar vor dem Senden vergleichen. Wartende Gegenbefehle
        // dürfen nicht am noch alten Istwert verloren gehen.
        const known = lastValues.get(address);
        if (!action && known && known.value === normalized
          && (known.confirmed || Date.now() - known.at < UNCONFIRMED_REPEAT_MS)) return;
        if (!registered) {
          if (!await interfaceAlive(PROBE_TIMEOUT_MS)) {
            host.error(`Schreiben ${address} verworfen: CCU nicht erreichbar`);
            scheduleImmediateReconnect();
            return;
          }
          scheduleImmediateReconnect();
        }
        // Ein Gerät, das sich als nicht erreichbar meldet, quittiert den Befehl
        // erst nach dem Geräte-Timeout der CCU mit einem Fehler und blockiert
        // die Warteschlange. Auftrag vormerken statt senden – flushDeferredWrites()
        // holt ihn nach, sobald UNREACH wieder false meldet.
        if (deviceUnreachable(channelAddress)) {
          const previous = deferredWrites.get(address);
          deferredWrites.set(address, { value, at: Date.now() });
          // Der Regelzyklus wiederholt denselben Sollwert laufend: nur der erste
          // bzw. ein geänderter Auftrag wird gemeldet, sonst flutet er das Protokoll.
          if (!previous || previous.value !== value) {
            host.error(`Schreiben ${address} vorgemerkt: Gerät ${deviceOfChannel(channelAddress)} meldet sich als nicht erreichbar; wird bei Rückkehr gesendet`);
          }
          return;
        }
        pendingWrites += 1;
        const before = lastValues.get(address);
        try {
          await performRpc('setValue', [channelAddress, parameter, normalized], WRITE_TIMEOUT_MS);
          // Ein während setValue empfangenes Event ist neuer und darf nicht
          // nachträglich zu einem unbestätigten optimistischen Wert werden.
          if (lastValues.get(address) === before) lastValues.set(address, { value: normalized, confirmed: false, at: Date.now() });
          armActiveWatch(deviceOfChannel(channelAddress));
        } catch (err) {
          lastValues.delete(address); // fehlgeschlagener Auftrag bleibt wiederholbar
          host.error(`Schreiben ${address} fehlgeschlagen: ${err.message}`);
          if (typeof err.code !== 'number') {
            probeAt = 0;
            if (!await interfaceAlive(PROBE_TIMEOUT_MS)) {
              markDisconnected(err.message);
              scheduleImmediateReconnect();
            }
          }
        } finally {
          pendingWrites -= 1;
          lastWriteEndedAt = Date.now();
        }
      }, { key: action ? undefined : `write:${address}`, replace: !action, priority: 10 });
    } catch (err) { if (!stopped) host.error(`Schreiben ${address}: ${err.message}`); }
  }

  return {
    async start(config) {
      cfg = config || {};
      stopped = false;
      startedAt = Date.now();
      deferredWrites.clear();
      callbackCount = 0;
      eventCount = 0;
      lastEventLogAt = 0;
      customNames.clear();
      // Zuerst die persistierte Geräteliste wiederherstellen, damit der folgende
      // publishCatalog() den Bestand NICHT auf die zwei Statuswerte eindampft und
      // die Geräteseite sofort – auch ohne CCU-Verbindung – vollständig ist.
      restoreDevices(cfg.devices);
      for (const entry of cfg.rpcMetadata?.channels || []) if (entry?.ADDRESS) channels.set(entry.ADDRESS, entry);
      for (const [address, schema] of cfg.rpcMetadata?.schemas || []) {
        channelSchemas.set(address, schema);
        for (const [parameter, detail] of Object.entries(schema.description || {})) descriptions.set(`${address}\0${parameter}`, detail);
      }
      if (!cfg.host) throw new Error('CCU-Adresse fehlt');
      rpcOptions = { host: String(cfg.host).replace(/^https?:\/\//, '').replace(/\/$/, ''), port: Number(cfg.port) || 2010,
        username: cfg.username || '', password: cfg.password || '' };
      publishCatalog();
      host.publishState('status/writes-blocked', false);
      host.publishState('status/callback-connected', false);
      host.publishState('status/event-count', 0);
      host.publishState('status/last-event-at', '');
      server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const { method, params } = parseCall(Buffer.concat(chunks).toString('utf8'));
            const result = handleCallback(method, params);
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(methodResponse(result));
          } catch (err) {
            res.writeHead(400); res.end();
            host.error(`Ungültiger CCU-Callback: ${err.message}`);
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(cfg.callbackPort) || 0, '0.0.0.0', resolve);
      });
      await register();
      if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
      await synchronize();
      reconnectTimer = setInterval(maintainConnection, reconnectMs());
      scheduleDrip(); // optionaler, gleichmäßig verteilter Hintergrund-Refresh (refreshInterval > 0)
    },

    async stop() {
      stopped = true;
      generation += 1;
      if (reconnectTimer) clearInterval(reconnectTimer);
      if (catalogTimer) clearTimeout(catalogTimer);
      if (resyncTimer) clearTimeout(resyncTimer);
      if (dripTimer) clearTimeout(dripTimer);
      if (activeWatchTimer) clearTimeout(activeWatchTimer);
      if (reconnectSoonTimer) clearTimeout(reconnectSoonTimer);
      if (registered) {
        // Abmeldung: gleiche Callback-URL, leere interface_id (HM XML-RPC API).
        try { await queue.run(() => performRpc('init', [callbackUrl, ''], 2000), { priority: 100 }); } catch (_) { /* CCU ggf. weg */ }
      }
      registered = false;
      deferredWrites.clear();
      queue.close();
      if (server) await new Promise((resolve) => server.close(resolve));
    },

    write: writeState,
    // Aktiver Refresh eines States (angestoßen z. B. vom Live-Tick der Messen-
    // Schalten-Seite über host.read). Liest den CCU-seitig gepflegten VALUES-
    // Bestand des Kanals per getParamset – das ist KEIN Funkbefehl, sondern die
    // gleiche zwischengespeicherte Quelle wie beim Sync. So werden CCU-Änderungen
    // auch dann übernommen, wenn ein Push-Event ausgeblieben ist, und die Frische-
    // Zeitstempel bleiben aktuell (behebt „⚠"/stale bei trägen Zählern wie kWh).
    async read(address) {
      const channelAddress = unsegment(String(address).split('/')[0]);
      await refreshChannel(channelAddress);
    },
    _test: { maintainConnection, synchronize, refreshChannel, forceDisconnected: () => markDisconnected('Test') },
  };
};

module.exports._test = { stateAddress, normalizeValue };
