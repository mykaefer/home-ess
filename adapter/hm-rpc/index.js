'use strict';

const http = require('http');
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
  let syncRunning = false;
  let resyncQueued = false;
  let stopped = false;
  let registered = false;
  let connectionCheckRunning = false;
  let rpcOptions = null;
  let callbackUrl = '';
  let latestDutyCycle = null;
  const descriptions = new Map();
  const channels = new Map();
  const states = new Map();
  // Kanal -> letzter getParamset-Refresh (ms). Bündelt die je-State-Refreshwünsche
  // eines Kanals, damit ein Live-Tick nicht mehrere getParamset pro Kanal auslöst.
  const readThrottle = new Map();
  // Geräteadresse (Top-Level, z. B. "ABC0000001") -> vom Nutzer vergebener Klarname.
  const customNames = new Map();

  function interfaceId() {
    return `homeESS-${host.name}`;
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

  function publishEventBurst(events) {
    const latest = new Map();
    for (const event of events || []) {
      if (!event || event.length < 3) continue;
      for (const entry of eventValues(event[0], event[1], event[2])) latest.set(entry.address, entry);
    }
    if (latest.size) host.publishStates(Array.from(latest.values()));
  }

  async function rpc(method, params) {
    return (await call(rpcOptions, method, params)).value;
  }

  async function loadChannel(channel, initialValues) {
    if (!Array.isArray(channel.PARAMSETS) || !channel.PARAMSETS.includes('VALUES')) return;
    let description;
    try {
      description = await rpc('getParamsetDescription', [channel.ADDRESS, 'VALUES']);
    } catch (err) {
      host.error(`Parameterbeschreibung ${channel.ADDRESS}: ${err.message}`);
      return;
    }
    for (const [parameter, detail] of Object.entries(description || {})) {
      descriptions.set(`${channel.ADDRESS}\0${parameter}`, detail || {});
      rememberState(channel.ADDRESS, parameter, detail || {});
    }
    // getParamset liest den bereits in der CCU geführten VALUES-Bestand. Es wird
    // absichtlich niemals durch einen homeESS-Lesezugriff aufgerufen.
    try {
      const values = await rpc('getParamset', [channel.ADDRESS, 'VALUES']);
      for (const [parameter, value] of Object.entries(values || {})) {
        initialValues.push([channel.ADDRESS, parameter, value]);
      }
    } catch (err) {
      host.error(`Initialwerte ${channel.ADDRESS}: ${err.message}`);
    }
  }

  async function synchronize() {
    // Single-Flight: läuft bereits ein Sync, wird nur ein Nachlauf vorgemerkt,
    // statt einen zweiten vollständigen CCU-Durchlauf parallel zu starten.
    if (syncRunning) { resyncQueued = true; return; }
    syncRunning = true;
    try {
      const devices = await rpc('listDevices', []);
      channels.clear();
      for (const entry of devices || []) if (entry && entry.ADDRESS) channels.set(entry.ADDRESS, entry);
      const initialValues = [];
      for (const entry of channels.values()) await loadChannel(entry, initialValues);
      publishCatalog();
      publishDevices();
      publishEventBurst(initialValues);
    } finally {
      syncRunning = false;
      if (resyncQueued) { resyncQueued = false; scheduleResync(); }
    }
  }

  // updateDevice-Bursts der CCU auf einen einzigen Re-Sync zusammenfassen.
  function scheduleResync() {
    if (resyncTimer || stopped) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      synchronize().catch((err) => host.error(`Geräteaktualisierung: ${err.message}`));
    }, RESYNC_DEBOUNCE_MS);
  }

  // Werte eines Kanals aus dem CCU-Cache (VALUES-Paramset) nachladen und
  // republizieren. Kein Funk, kein Duty-Cycle – gleiche Quelle wie beim Sync.
  // Pro Kanal gedrosselt, damit gehäufte Refreshwünsche (mehrere States eines
  // Kanals, On-Demand + Hintergrund) nur EIN getParamset auslösen.
  async function refreshChannel(channelAddress, force = false) {
    if (!registered || !channelAddress || channelAddress === 'status') return;
    const now = Date.now();
    // Das aktive Beobachtungsfenster (force) fragt bewusst häufiger als die
    // normale Drossel – es soll eine Status-Änderung schnellstmöglich einfangen.
    if (!force && now - (readThrottle.get(channelAddress) || 0) < READ_THROTTLE_MS) return;
    readThrottle.set(channelAddress, now);
    try {
      const values = await rpc('getParamset', [channelAddress, 'VALUES']);
      const burst = [];
      for (const [parameter, value] of Object.entries(values || {})) {
        burst.push([channelAddress, parameter, value]);
      }
      if (burst.length) publishEventBurst(burst);
    } catch (err) {
      // Wert momentan nicht lesbar (Gerät offline o. Ä.) – still übergehen.
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
      const channelAddress = dripIndex < dripQueue.length ? dripQueue[dripIndex++] : null;
      if (channelAddress) await refreshChannel(channelAddress).catch(() => {});
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
    if (!activeWatchTimer) runActiveWatch();
  }

  function runActiveWatch() {
    activeWatchTimer = null;
    if (stopped) return;
    const now = Date.now();
    const channelSet = new Set();
    for (const [deviceAddress, until] of activeWatchUntil) {
      if (until <= now) { activeWatchUntil.delete(deviceAddress); continue; }
      for (const channelAddress of channelsOfDevice(deviceAddress)) channelSet.add(channelAddress);
    }
    if (!channelSet.size) return;
    // force=true umgeht die Drossel – hier ist schnelle Aktualität gewünscht.
    Promise.all(Array.from(channelSet).map((channelAddress) => refreshChannel(channelAddress, true).catch(() => {})))
      .finally(() => {
        if (!stopped && activeWatchUntil.size) {
          activeWatchTimer = setTimeout(runActiveWatch, ACTIVE_WATCH_INTERVAL_MS);
        }
      });
  }

  async function register() {
    if (stopped || registered || connectionCheckRunning) return;
    connectionCheckRunning = true;
    try {
      const probe = await call(rpcOptions, 'listDevices', []);
      const callbackHost = String(cfg.callbackHost || probe.localAddress || '').replace(/^::ffff:/, '');
      if (!callbackHost) throw new Error('Callback-Adresse konnte nicht ermittelt werden');
      callbackUrl = `http://${callbackHost}:${server.address().port}`;
      await rpc('init', [callbackUrl, interfaceId()]);
      registered = true;
      await synchronize();
      host.setConnected(true, `CCU-RPC verbunden (${channels.size} Geräte/Kanäle), Callback ${callbackUrl}`);
    } catch (err) {
      registered = false;
      host.setConnected(false, `CCU-RPC: ${err.message}`);
    } finally {
      connectionCheckRunning = false;
    }
  }

  async function maintainConnection() {
    if (stopped || connectionCheckRunning) return;
    if (!registered) { await register(); return; }
    connectionCheckRunning = true;
    try {
      // Rein lokaler Schnittstellen-Ping der CCU, niemals ein Geräte-/Funk-Read.
      await rpc('system.listMethods', []);
    } catch (err) {
      registered = false;
      host.setConnected(false, `CCU-RPC: ${err.message}`);
    } finally {
      connectionCheckRunning = false;
    }
  }

  function handleCallback(method, params) {
    if (method === 'system.listMethods') {
      return ['event', 'newDevices', 'deleteDevices', 'updateDevice', 'system.multicall', 'system.listMethods'];
    }
    if (method === 'system.multicall') {
      const calls = Array.isArray(params[0]) ? params[0] : [];
      const events = calls.filter((entry) => entry.methodName === 'event').map((entry) => (entry.params || []).slice(1));
      publishEventBurst(events);
      return calls.map((entry) => entry.methodName === 'event' ? [''] : [handleCallback(entry.methodName, entry.params || [])]);
    }
    if (method === 'event') {
      publishEventBurst([[params[1], params[2], params[3]]]);
    } else if (method === 'newDevices' && Array.isArray(params[1])) {
      for (const entry of params[1]) if (entry && entry.ADDRESS) channels.set(entry.ADDRESS, entry);
      const initialValues = [];
      Promise.all(params[1].map((entry) => loadChannel(entry, initialValues)))
        .then(() => { publishCatalog(); publishDevices(); publishEventBurst(initialValues); })
        .catch((err) => host.error(err.message));
    } else if (method === 'deleteDevices' && Array.isArray(params[1])) {
      const removed = new Set(params[1].map((entry) => typeof entry === 'string' ? entry : entry.ADDRESS));
      for (const address of removed) channels.delete(address);
      for (const [address] of states) {
        const channelAddress = unsegment(address.split('/')[0]);
        if (removed.has(channelAddress)) states.delete(address);
      }
      publishCatalog();
      publishDevices();
    } else if (method === 'updateDevice') {
      scheduleResync();
    }
    return '';
  }

  return {
    async start(config) {
      cfg = config || {};
      stopped = false;
      customNames.clear();
      // Zuerst die persistierte Geräteliste wiederherstellen, damit der folgende
      // publishCatalog() den Bestand NICHT auf die zwei Statuswerte eindampft und
      // die Geräteseite sofort – auch ohne CCU-Verbindung – vollständig ist.
      restoreDevices(cfg.devices);
      if (!cfg.host) throw new Error('CCU-Adresse fehlt');
      rpcOptions = { host: String(cfg.host).replace(/^https?:\/\//, '').replace(/\/$/, ''), port: Number(cfg.port) || 2010,
        username: cfg.username || '', password: cfg.password || '' };
      publishCatalog();
      host.publishState('status/writes-blocked', false);
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
      reconnectTimer = setInterval(maintainConnection, Math.max(10, Number(cfg.reconnectInterval) || 30) * 1000);
      scheduleDrip(); // optionaler, gleichmäßig verteilter Hintergrund-Refresh (refreshInterval > 0)
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) clearInterval(reconnectTimer);
      if (catalogTimer) clearTimeout(catalogTimer);
      if (resyncTimer) clearTimeout(resyncTimer);
      if (dripTimer) clearTimeout(dripTimer);
      if (activeWatchTimer) clearTimeout(activeWatchTimer);
      if (registered) {
        try { await rpc('init', ['', interfaceId()]); } catch (_) { /* CCU ggf. weg */ }
      }
      registered = false;
      if (server) await new Promise((resolve) => server.close(resolve));
    },

    async write(address, value) {
      if (!registered) { host.error(`Schreiben ${address} verworfen: CCU nicht verbunden`); return; }
      if (writesBlocked()) {
        host.error(`Schreiben ${address} verworfen: Duty Cycle ${latestDutyCycle}% (Grenze ${dutyLimit()}%)`);
        return;
      }
      const parts = String(address).split('/');
      if (parts.length !== 2 || parts[0] === 'status') return;
      const channelAddress = unsegment(parts[0]);
      const parameter = unsegment(parts[1]);
      const description = descriptions.get(`${channelAddress}\0${parameter}`) || {};
      if ((Number(description.OPERATIONS) & OPERATIONS_WRITE) === 0) {
        host.error(`State ${address} ist laut CCU nicht schreibbar`);
        return;
      }
      try {
        await rpc('setValue', [channelAddress, parameter, normalizeValue(value, description)]);
        // Steuerbefehl gesetzt – das Gerät jetzt kurz aktiv beobachten, damit ein
        // zugehöriges Status-Topic zeitnah nachzieht (auch ohne Push-Event).
        armActiveWatch(deviceOfChannel(channelAddress));
      } catch (err) {
        host.error(`Schreiben ${address} fehlgeschlagen: ${err.message}`);
        registered = false;
        host.setConnected(false, `CCU-RPC: ${err.message}`);
      }
    },
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
  };
};

module.exports._test = { stateAddress, normalizeValue };
