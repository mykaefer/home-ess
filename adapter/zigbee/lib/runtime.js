'use strict';

// Laufzeit des Zigbee-Adapters: Coordinator anbinden, Netz übernehmen,
// Ereignisse verarbeiten, Verbindung halten.
//
// Der Ablauf ist bewusst in dieser Reihenfolge festgelegt:
//
//   1. Transport auflösen            (wie wird der Coordinator erreicht?)
//   2. Coordinator rein lesend prüfen (welches Netz liegt tatsächlich vor?)
//   3. Plan fassen                    (übernehmen oder – nur bestätigt – neu)
//   4. Netzwerkdaten persistieren
//   5. zigbee-herdsman starten
//
// Schritt 2 ist nicht optional. Ohne ihn entscheidet zigbee-herdsman anhand
// beliebiger Vorgabewerte, ob es das vorhandene Netz weiterführt oder
// neu kommissioniert — und ein neu kommissioniertes Netz bedeutet, dass jedes
// Gerät neu angelernt werden müsste.

const path = require('path');

const transportLib = require('./transport');
const coordinatorLib = require('./coordinator');
const networkLib = require('./network');
const backupLib = require('./backup');
const devicesLib = require('./devices');
const convertersLib = require('./converters');
const exposesLib = require('./exposes');
const availabilityLib = require('./availability');
const topologyLib = require('./topology');
const loggingLib = require('./logging');
const instanceLock = require('./instance-lock');

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 120000;
const AVAILABILITY_INTERVAL_MS = 60000;
const PERMIT_JOIN_MAX_SECONDS = 600;
// Der Topologiescan fragt jeden Router nach seiner Nachbartabelle. Das ist
// echter Funkverkehr im gesamten Netz und darf deshalb weder bei jeder
// Kleinigkeit noch in dichter Folge laufen.
const TOPOLOGY_DEBOUNCE_MS = 45000;
const TOPOLOGY_MIN_INTERVAL_MS = 10 * 60 * 1000;
const TOPOLOGY_FIRST_DELAY_MS = 15000;
const STOP_TIMEOUT_MS = 15000;
// homeESS beendet einen Adapterprozess drei Sekunden nach dem Stoppsignal hart.
// Das Aufräumen muss deutlich darunter bleiben, damit die Schnittstelle beim
// Neustart der Instanz frei ist.
const STOP_RELEASE_MS = 1200;
const STOP_SETTLE_MS = 800;
// Auch die Inbetriebnahme durch zigbee-herdsman braucht eine Obergrenze: Bleibt
// sie hängen, versucht der Adapter es sonst nie wieder.
const START_TIMEOUT_MS = 180000;

function nowMs() {
  return Date.now();
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function createRuntime(host, dependencies = {}) {
  const modules = {
    Controller: dependencies.Controller,
    setLogger: dependencies.setLogger,
    ...dependencies,
  };

  let config = {};
  let dataDirectory = null;
  let transport = null;
  let controller = null;
  let plan = null;
  let coordinatorInfo = null;
  let networkMetadata = null;

  let stopped = true;
  let starting = false;
  // Ein zugewiesenes Controller-Objekt bedeutet noch keine betriebsbereite
  // Verbindung: `controller.start()` läuft danach noch. Erst dieser Merker wird
  // gesetzt, wenn der Coordinator tatsächlich in Betrieb ist.
  let connected = false;
  // Der laufende Verbindungsaufbau. Abbrechende Vorgänge warten ihn ab, statt
  // mitten in den Start hineinzugreifen.
  let connecting = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let availabilityTimer = null;
  let permitJoinEndsAt = 0;
  let lastError = '';
  let networkState = 'getrennt';
  // Einmalige, ausdrückliche Freigabe für den Neuaufbau eines Netzes. Sie wird
  // nach dem Vorgang sofort wieder entzogen, damit ein Neustart nicht erneut
  // kommissioniert.
  let createConfirmation = null;
  // Ergebnis des letzten Topologiescans. Der Scan erzeugt Funkverkehr auf jedem
  // Router und läuft deshalb nur auf Anforderung — nie automatisch im Takt.
  let topology = null;
  let topologyScan = null;
  let topologyProgress = null;
  let topologyTimer = null;
  let topologyLastRun = 0;
  let topologyReason = '';
  // Zeitwerte der Automatik. Sie sind für Tests austauschbar, damit sich das
  // Verhalten nachweisen lässt, ohne Minuten zu warten.
  const timings = {
    debounceMs: TOPOLOGY_DEBOUNCE_MS,
    minIntervalMs: TOPOLOGY_MIN_INTERVAL_MS,
    firstDelayMs: TOPOLOGY_FIRST_DELAY_MS,
    ...(dependencies.topologyTimings || {}),
  };
  // Freigabe der gerade offenen Coordinator-Schnittstelle. Wird gesetzt, solange
  // ein Zugriff läuft, und erlaubt es, ihn sofort zu kappen, statt auf ein
  // Zeitlimit zu warten.
  let releaseTransport = null;
  // Adressen, die der Betreiber ausdrücklich entfernt hat. Der Coordinator führt
  // sie in seiner Adressverwaltung mitunter weiter; ohne dieses Gedächtnis
  // holte die Geräteübernahme sie beim nächsten Mal wieder herein.
  let ignoredDevices = new Set();
  // Belegungsmarke: Wer ist der zuständige Kindprozess dieser Instanz?
  let ownLock = null;
  let unwatchLock = null;

  const registry = devicesLib.createRegistry({
    getConfig: () => config,
    log: (message) => host.debug(message),
  });

  // ── Hilfen ────────────────────────────────────────────────────────────────

  function secretsForRedaction() {
    const secrets = [];
    if (plan && plan.network && plan.network.networkKey) {
      secrets.push(networkLib.toHex(plan.network.networkKey));
    }
    return secrets;
  }

  function safeLog(level, message) {
    const text = loggingLib.redact(message, secretsForRedaction());
    if (level === 'error') host.error(text);
    else if (level === 'warn') host.warn(text);
    else if (level === 'debug') host.debug(text);
    else host.log(text);
  }

  function setStatus(isConnected, detail, { isError = false } = {}) {
    if (isConnected) lastError = '';
    else if (isError && detail) lastError = detail;
    try {
      host.setConnected(isConnected, detail || '');
    } catch (_) {
      /* Statusmeldungen dürfen den Betrieb nicht anhalten. */
    }
  }

  function publishCatalog() {
    try {
      host.setStates(registry.buildCatalog());
      // Der Katalog wurde ersetzt; die zuletzt gemeldeten Diagnosewerte gelten
      // damit als nicht mehr zugestellt und werden erneut ausgegeben.
      registry.resetDiagnostics();
    } catch (error) {
      safeLog('error', `State-Katalog konnte nicht gemeldet werden: ${errorText(error)}`);
    }
  }

  let publishedRowsSignature = null;

  function publishDeviceRows(options = {}) {
    // Die Verfügbarkeit steht beim ersten Melden noch nicht fest — sie ergibt
    // sich erst aus der Auswertung von `lastSeen`. Ohne erneutes Melden bliebe
    // in der Geräteliste dauerhaft der Anfangswert stehen, und jedes Gerät
    // erschiene als offline, obwohl der Adapter verbunden ist und die Karte die
    // Verbindungen zeigt.
    const signature = registry.rowsSignature();
    if (!options.force && signature === publishedRowsSignature) return;
    publishedRowsSignature = signature;
    try {
      host.setStorage('devices', registry.deviceRows());
    } catch (error) {
      safeLog('debug', `Geräteliste konnte nicht gespeichert werden: ${errorText(error)}`);
    }
  }

  function publish(values) {
    if (!values || !values.length) return;
    try {
      host.publishStates(values);
    } catch (error) {
      safeLog('debug', `Werte konnten nicht gemeldet werden: ${errorText(error)}`);
    }
  }

  function publishCoordinatorState() {
    const permitRemaining = permitJoinEndsAt > nowMs()
      ? Math.round((permitJoinEndsAt - nowMs()) / 1000)
      : 0;
    const values = [
      { address: 'coordinator/connected', value: connected },
      { address: 'coordinator/network_state', value: networkState },
      { address: 'coordinator/transport', value: transport ? transport.label : '' },
      { address: 'coordinator/device_count', value: registry.size() },
      { address: 'coordinator/devices_online', value: registry.onlineCount() },
      { address: 'coordinator/permit_join', value: permitRemaining > 0 },
      { address: 'coordinator/permit_join_remaining', value: permitRemaining },
    ];
    if (coordinatorInfo) {
      values.push({ address: 'coordinator/ieee_address', value: coordinatorInfo.ieeeAddress });
      values.push({ address: 'coordinator/adapter_type', value: coordinatorLib.DRIVERS[coordinatorInfo.coordinatorType]
        ? coordinatorLib.DRIVERS[coordinatorInfo.coordinatorType].label : coordinatorInfo.coordinatorType });
      values.push({ address: 'coordinator/firmware', value: coordinatorInfo.firmware
        ? `${coordinatorInfo.firmware.product} ${coordinatorInfo.firmware.version} (Rev. ${coordinatorInfo.firmware.revision})`
        : '' });
    }
    if (networkMetadata) {
      values.push({ address: 'coordinator/pan_id', value: `0x${Number(networkMetadata.panId).toString(16).padStart(4, '0')}` });
      values.push({ address: 'coordinator/channel', value: Number(networkMetadata.channel) });
    }
    publish(values);
  }

  // ── Netzwerkdaten ─────────────────────────────────────────────────────────

  async function loadStoredNetwork() {
    const metadata = backupLib.readNetworkMetadata(dataDirectory);
    if (!metadata) return null;
    let secret = null;
    try {
      secret = await host.getSecret('network-key');
    } catch (_) {
      secret = null;
    }
    return networkLib.mergePersistence(metadata, secret);
  }

  async function persistNetwork(network) {
    const split = networkLib.splitPersistence(network);
    networkMetadata = {
      ...split.metadata,
      coordinatorIeee: coordinatorInfo ? coordinatorInfo.ieeeAddress : '',
      updatedAt: new Date().toISOString(),
    };
    backupLib.writeNetworkMetadata(dataDirectory, networkMetadata);
    // Der Netzwerkschlüssel gehört ausschließlich in den geschützten
    // Secret-Store — niemals in die Instanz-Einstellungen und niemals ins Log.
    try {
      await host.setSecret('network-key', split.secret);
    } catch (error) {
      safeLog('warn', `Der Netzwerkschlüssel konnte nicht gesichert werden: ${errorText(error)}`);
    }
  }

  // ── Ereignisse von zigbee-herdsman ────────────────────────────────────────

  async function refreshDevice(zhDevice, { announce = false } = {}) {
    if (!zhDevice || zhDevice.type === 'Coordinator') return null;
    let definition = null;
    try {
      definition = await convertersLib.resolveDefinition(zhDevice);
    } catch (error) {
      safeLog('debug', `Converter-Suche für ${zhDevice.ieeeAddr} fehlgeschlagen: ${errorText(error)}`);
    }
    const entry = registry.upsert(zhDevice, definition);
    if (zhDevice.lastSeen) entry.lastSeen = Number(zhDevice.lastSeen);
    if (zhDevice.linkquality != null) entry.linkquality = Number(zhDevice.linkquality);
    if (announce) {
      if (!definition) {
        safeLog('warn', `Für ${entry.friendlyName} (${entry.zigbeeModel || 'ohne Modellkennung'}, `
          + `${entry.manufacturer || 'ohne Hersteller'}) ist kein Converter bekannt. Das Gerät bleibt erhalten, `
          + 'liefert aber keine ausgewerteten Werte.');
      } else {
        safeLog('info', `Gerät erkannt: ${entry.friendlyName} — ${entry.vendor} ${entry.model}`
          + `${entry.generated ? ' (automatisch erzeugte Definition)' : ''}, ${entry.features.length} Eigenschaften.`);
      }
    }
    return entry;
  }

  async function loadDevices() {
    if (!controller) return;
    for (const zhDevice of controller.getDevicesIterator()) {
      if (zhDevice.type === 'Coordinator') continue;
      try {
        await refreshDevice(zhDevice);
      } catch (error) {
        // Ein einzelnes fehlerhaftes Gerät darf den Start nie verhindern.
        safeLog('warn', `Gerät ${zhDevice.ieeeAddr} konnte nicht übernommen werden: ${errorText(error)}`);
      }
    }
    registry.applyCustomNames(config.devices);
    publishCatalog();
    // Die Verfügbarkeit vor dem ersten Melden auswerten, damit die Geräteliste
    // nicht mit lauter unbekannten Zuständen startet.
    for (const entry of registry.all()) registry.diagnosticValues(entry);
    publishDeviceRows({ force: true });
  }

  async function handleMessage(data) {
    const entry = registry.bySlugOrIeee(data.device && data.device.ieeeAddr);
    if (!entry) return;
    entry.lastSeen = nowMs();
    if (data.linkquality != null) entry.linkquality = Number(data.linkquality);

    const payload = await convertersLib.convertReceived({
      definition: entry.definition,
      message: data,
      device: entry.zh,
      state: entry.state,
      options: {},
      onError: (error, converter) => {
        safeLog('warn', `Converter${converter && converter.cluster ? ` (${converter.cluster})` : ''} für `
          + `${entry.friendlyName} meldete einen Fehler: ${errorText(error)}`);
      },
      onExposesChanged: () => {
        // Manche Geräte melden ihre Fähigkeiten erst im Betrieb nach.
        refreshDevice(entry.zh)
          .then(() => {
            publishCatalog();
            publishDeviceRows();
          })
          .catch(() => {});
      },
    });

    const values = registry.applyValues(entry, payload);
    if (entry.linkquality != null) {
      values.push({ address: exposesLib.stateAddress(entry.ieeeAddress, 'linkquality'), value: entry.linkquality });
    }
    values.push(...registry.diagnosticValues(entry));
    publish(values);
    // Ein Gerät, das gerade gesendet hat, ist erreichbar. Die Geräteliste wird
    // nur bei tatsächlicher Änderung geschrieben.
    publishDeviceRows();
  }

  function wireEvents() {
    controller.on('message', (data) => {
      handleMessage(data).catch((error) => {
        safeLog('warn', `Zigbee-Nachricht konnte nicht verarbeitet werden: ${errorText(error)}`);
      });
    });

    controller.on('deviceJoined', (data) => {
      const address = data && data.device ? data.device.ieeeAddr : '';
      // Wird ein zuvor entferntes Gerät bewusst neu angelernt, gilt die Sperre
      // für die Geräteübernahme nicht mehr.
      const slug = exposesLib.deviceSlug(address);
      if (ignoredDevices.delete(slug)) {
        try {
          host.setStorage('ignoredDevices', Array.from(ignoredDevices));
        } catch (_) { /* siehe oben */ }
      }
      safeLog('info', `Neues Zigbee-Gerät im Netz: ${address}. Das Interview beginnt.`);
      refreshDevice(data.device, { announce: false })
        .then(() => {
          publishCatalog();
          publishDeviceRows();
          scheduleTopologyScan('neues Gerät');
        })
        .catch((error) => safeLog('warn', `Neues Gerät konnte nicht aufgenommen werden: ${errorText(error)}`));
    });

    controller.on('deviceInterview', (data) => {
      const address = data && data.device ? data.device.ieeeAddr : '';
      if (data.status === 'started') {
        safeLog('info', `Interview gestartet: ${address}.`);
        return;
      }
      if (data.status === 'failed') {
        // Ein gescheitertes Interview ist ein Geräteproblem, kein Adapterfehler.
        safeLog('warn', `Interview fehlgeschlagen: ${address}. Das Gerät bleibt bekannt; `
          + 'ein erneuter Anlernvorgang oder das Aufwecken des Gerätes kann es vervollständigen.');
      }
      refreshDevice(data.device, { announce: data.status === 'successful' })
        .then((entry) => {
          publishCatalog();
          publishDeviceRows();
          if (entry) publish(registry.diagnosticValues(entry));
          publishCoordinatorState();
          // Erst mit dem Interview steht fest, ob das Gerät ein Router ist und
          // damit selbst eine Nachbartabelle führt.
          if (data.status === 'successful') scheduleTopologyScan('Gerät angelernt');
        })
        .catch((error) => safeLog('warn', `Interviewergebnis konnte nicht übernommen werden: ${errorText(error)}`));
    });

    controller.on('deviceAnnounce', (data) => {
      const entry = registry.bySlugOrIeee(data.device && data.device.ieeeAddr);
      if (!entry) return;
      entry.lastSeen = nowMs();
      publish(registry.diagnosticValues(entry));
    });

    controller.on('deviceNetworkAddressChanged', (data) => {
      // Eine neue Netzadresse bedeutet in aller Regel einen neuen Weg durch das
      // Netz — die gezeichneten Funkstrecken stimmen dann nicht mehr.
      refreshDevice(data.device)
        .then(() => {
          publishDeviceRows();
          scheduleTopologyScan('Gerät hat die Netzadresse gewechselt');
        })
        .catch(() => {});
    });

    controller.on('deviceLeave', (data) => {
      const slug = exposesLib.deviceSlug(data && data.ieeeAddr);
      const entry = registry.get(slug);
      safeLog('info', `Gerät hat das Netz verlassen: ${entry ? entry.friendlyName : slug}.`);
      registry.remove(slug);
      publishCatalog();
      publishDeviceRows();
      publishCoordinatorState();
      scheduleTopologyScan('Gerät hat das Netz verlassen');
    });

    controller.on('lastSeenChanged', (data) => {
      const entry = registry.bySlugOrIeee(data.device && data.device.ieeeAddr);
      if (!entry) return;
      entry.lastSeen = Number(data.device.lastSeen) || nowMs();
    });

    controller.on('permitJoinChanged', (data) => {
      const time = Number(data && data.time) || 0;
      permitJoinEndsAt = time > 0 ? nowMs() + time * 1000 : 0;
      publishCoordinatorState();
    });

    controller.on('adapterDisconnected', () => {
      // Der Coordinator ist weg — Kabel, Bridge, Netzwerk. Das ist ein
      // Betriebszustand, kein Grund abzustürzen, und ganz sicher kein Grund,
      // Geräte oder Netzwerkdaten zu verwerfen.
      safeLog('warn', 'Die Verbindung zum Coordinator wurde unterbrochen. '
        + 'Geräte und Netzwerkdaten bleiben unverändert erhalten; der Adapter verbindet sich neu.');
      networkState = 'Coordinator getrennt';
      markAllUnavailable();
      teardownController()
        .catch(() => {})
        .then(() => scheduleReconnect());
    });
  }

  function markAllUnavailable() {
    const values = [];
    for (const entry of registry.all()) {
      entry.available = false;
      values.push({ address: exposesLib.stateAddress(entry.ieeeAddress, 'available'), value: false });
    }
    publish(values);
    setStatus(false, lastError || 'Coordinator nicht verbunden', { isError: true });
    publishCoordinatorState();
  }

  // ── Verfügbarkeit ─────────────────────────────────────────────────────────

  async function pingDevice(entry) {
    if (!entry || !entry.zh) return;
    entry.lastPing = nowMs();
    try {
      const endpoint = entry.zh.endpoints && entry.zh.endpoints[0];
      if (!endpoint) return;
      await endpoint.read('genBasic', ['zclVersion']);
      entry.lastSeen = nowMs();
    } catch (_) {
      // Keine Antwort ist das erwartete Ergebnis bei einem nicht erreichbaren
      // Gerät und deshalb kein Fehler, der protokolliert werden müsste.
    }
  }

  async function refreshAvailability() {
    if (!controller) return;
    const now = nowMs();
    const values = [];
    const pings = [];
    for (const entry of registry.all()) {
      if (availabilityLib.shouldPing(entry, config, now)) pings.push(pingDevice(entry));
      values.push(...registry.diagnosticValues(entry, now));
    }
    publish(values);
    // Erst hier steht die Verfügbarkeit fest; die Geräteliste muss sie
    // übernehmen, sonst bleibt sie beim Anfangswert stehen.
    publishDeviceRows();
    publishCoordinatorState();
    // Abfragen laufen bewusst nach dem Melden und ohne den Zyklus zu blockieren.
    await Promise.allSettled(pings);
  }

  /**
   * Übersetzt Verbindungsfehler in eine Aussage, mit der sich etwas anfangen
   * lässt.
   *
   * „Error while opening socket" aus zigbee-herdsman nennt weder Ursache noch
   * Ziel. Der häufigste Grund ist zugleich der am schwersten zu erratende: Eine
   * Zigbee-Bridge reicht genau einen seriellen Anschluss weiter und lässt
   * deshalb nur einen Client zu. Hängt dort noch eine Verbindung — etwa ein
   * nicht beendeter Adapterprozess oder ein anderes Programm —, wird jeder
   * weitere Versuch abgewiesen.
   */
  function explainConnectError(error, currentTransport) {
    const raw = errorText(error);
    const ziel = currentTransport ? currentTransport.label : 'dem Coordinator';
    if (/Error while opening socket/i.test(raw) || /ECONNRESET|ECONNREFUSED/i.test(raw)) {
      return `Die Verbindung zu ${ziel} wurde abgewiesen. Eine Zigbee-Bridge lässt in der Regel nur einen `
        + 'Client gleichzeitig zu — vermutlich hält noch eine andere Verbindung den Anschluss belegt. '
        + 'Zu prüfen sind ein noch laufender zweiter Adapterprozess, ein weiteres Programm am selben '
        + `Coordinator und die Erreichbarkeit der Bridge selbst. Ursprüngliche Meldung: ${raw}`;
    }
    if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(raw)) {
      return `${ziel} ist im Netz nicht erreichbar. Ursprüngliche Meldung: ${raw}`;
    }
    if (/ENOENT|EACCES/i.test(raw) && currentTransport && currentTransport.type === 'serial') {
      return `Der serielle Anschluss ${currentTransport.path} ist nicht vorhanden oder nicht zugänglich. `
        + `Ursprüngliche Meldung: ${raw}`;
    }
    return raw;
  }

  // ── Verbindungsaufbau ─────────────────────────────────────────────────────

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(reconnectDelay * 1.8));
    safeLog('info', `Nächster Verbindungsversuch in ${Math.round(delay / 1000)} s.`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => safeLog('error', `Verbindungsversuch fehlgeschlagen: ${errorText(error)}`));
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  /**
   * Gibt die Coordinator-Schnittstelle bedingungslos frei — auch wenn der
   * reguläre Weg hängt.
   *
   * Das ist keine Kosmetik: Eine Bridge lässt in der Regel genau einen Client
   * zu. Bleibt hier ein Socket offen, kann sich der Nachfolger nicht mehr
   * verbinden und meldet dauerhaft „Error while opening socket".
   */
  async function forceReleasePort(current) {
    const release = releaseTransport;
    releaseTransport = null;
    if (release) {
      try {
        await release();
      } catch (_) {
        /* Die Freigabe darf nichts verhindern. */
      }
    }
    const znp = current && current.adapter && current.adapter.znp;
    if (znp) {
      try {
        await coordinatorLib.releaseZnp(znp);
      } catch (_) {
        /* dito */
      }
    }
  }

  async function teardownController(options = {}) {
    const budget = Number(options.timeoutMs) || STOP_TIMEOUT_MS;
    // Ein geplanter Scan ohne Coordinator ergibt keinen Sinn.
    if (topologyTimer) {
      clearTimeout(topologyTimer);
      topologyTimer = null;
    }
    const current = controller;
    controller = null;
    connected = false;
    // Auch ohne Controller kann ein Zugriff offen sein — etwa mitten im
    // lesenden Coordinator-Zugriff.
    if (!current) {
      await forceReleasePort(null);
      return;
    }
    try {
      await Promise.race([
        current.stop(),
        new Promise((resolve) => setTimeout(resolve, budget)),
      ]);
    } catch (error) {
      safeLog('debug', `Beenden des Coordinators meldete: ${errorText(error)}`);
    }
    // `stop()` kann in das Zeitlimit gelaufen sein und den Port weiterhin
    // halten. Deshalb anschließend in jedem Fall selbst freigeben.
    await forceReleasePort(current);
    try {
      current.removeAllListeners();
    } catch (_) {
      /* egal */
    }
  }

  /**
   * Ein vollständiger Verbindungsaufbau. Wirft nicht nach außen — Fehler führen
   * zu einem erneuten Versuch, niemals zum Ende des Adapterprozesses.
   */
  async function connect() {
    if (stopped || starting || controller) return;
    starting = true;
    connecting = runConnect();
    try {
      await connecting;
    } finally {
      connecting = null;
      starting = false;
    }
  }

  /**
   * Wartet einen laufenden Verbindungsaufbau ab. Ein Abbruch mitten im Start
   * hinterlässt sonst einen halb initialisierten Coordinator.
   */
  async function settleConnect() {
    while (connecting) {
      try {
        await connecting;
      } catch (_) {
        /* Der Fehler ist im Verbindungsaufbau bereits behandelt. */
      }
    }
  }

  async function runConnect() {
    try {
      // Nicht mehr zuständig? Dann keinen Coordinator belegen.
      if (dataDirectory && !instanceLock.isOwner(dataDirectory, ownLock)) {
        safeLog('warn', 'Ein neuerer Prozess dieser Instanz ist zuständig; dieser verbindet sich nicht.');
        await stepAside();
        return;
      }
      const driver = modules.getDriver
        ? modules.getDriver(config.coordinatorType)
        : coordinatorLib.getDriver(config.coordinatorType);
      transport = transportLib.resolveTransport(config, { baudRate: driver.defaultBaudRate });
      for (const warning of transport.warnings) safeLog('warn', warning);

      networkState = 'Coordinator wird geprüft';
      setStatus(false, `Verbinde: ${transport.label}`, { isError: false });
      publishCoordinatorState();

      // Schritt 2: rein lesend. Hier wird nichts geschrieben.
      coordinatorInfo = await driver.probe(transport, {
        onOpen: (release) => { releaseTransport = release; },
        onRelease: () => { releaseTransport = null; },
      });
      safeLog('info', `Coordinator erreicht: ${driver.label}, ${coordinatorInfo.firmware.product} `
        + `${coordinatorInfo.firmware.version} (Rev. ${coordinatorInfo.firmware.revision}), `
        + `IEEE ${coordinatorInfo.ieeeAddress}, `
        + `${coordinatorInfo.configured ? 'konfiguriertes Netz vorhanden' : 'kein konfiguriertes Netz'}.`);

      // Schritt 3: Plan fassen.
      const stored = await loadStoredNetwork();
      const intent = {
        mode: String(config.networkMode || 'adopt').toLowerCase(),
        createConfirmed: !!createConfirmation,
        channel: createConfirmation ? createConfirmation.channel : undefined,
      };
      plan = networkLib.planNetwork(coordinatorInfo, stored, intent);
      safeLog('info', networkLib.describePlan(plan));
      if (plan.note) safeLog('warn', plan.note);

      // Schritt 4: persistieren, bevor der Coordinator angefasst wird.
      await persistNetwork(plan.network);

      // Schritt 5: zigbee-herdsman starten.
      const Controller = modules.Controller;
      const files = backupLib.paths(dataDirectory);
      controller = new Controller({
        network: networkLib.herdsmanNetworkOptions(plan),
        serialPort: {
          path: transport.path,
          baudRate: transport.baudRate,
          rtscts: transport.rtscts,
          adapter: driver.herdsmanAdapter,
        },
        databasePath: files.database,
        databaseBackupPath: files.databaseBackup,
        backupPath: files.backup,
        adapter: {
          disableLED: false,
          concurrent: undefined,
          transmitPower: Number(config.transmitPower) || undefined,
          // Ein Weiterstarten trotz abweichender Coordinator-Konfiguration wird
          // nicht erlaubt. Lieber scheitert der Start hörbar, als dass der
          // Adapter mit falschen Netzwerkparametern weiterläuft.
          forceStartWithInconsistentAdapterConfiguration: false,
        },
        acceptJoiningDeviceHandler: async () => true,
      });

      wireEvents();
      const startAbort = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(START_TIMEOUT_MS)
        : undefined;
      const result = await controller.start(startAbort);

      // Letzte Kontrolle: „reset" bedeutet, dass ein Netz neu kommissioniert
      // wurde. Nach der Vorprüfung darf das nur bei ausdrücklichem Wunsch
      // vorkommen.
      if (result === 'reset' && plan.action !== 'create') {
        safeLog('error', 'zigbee-herdsman hat das Zigbee-Netz neu aufgebaut, obwohl das bestehende Netz '
          + 'übernommen werden sollte. Bitte den Coordinator prüfen; angelernte Geräte müssen neu verbunden werden.');
      } else if (result === 'reset') {
        safeLog('info', 'Neues Zigbee-Netz erstellt. Alle Geräte müssen neu angelernt werden.');
      } else if (result === 'restored') {
        safeLog('info', 'Zigbee-Netz aus dem Coordinator-Backup wiederhergestellt.');
      } else {
        safeLog('info', 'Bestehendes Zigbee-Netz unverändert übernommen.');
      }
      // Die Freigabe gilt für genau einen Vorgang.
      createConfirmation = null;

      // Die tatsächlichen Parameter nach dem Start noch einmal beim Coordinator
      // erfragen; sie sind die Wahrheit für die Anzeige.
      try {
        const parameters = await controller.getNetworkParameters();
        networkMetadata = {
          ...(networkMetadata || {}),
          panId: parameters.panID,
          extendedPanId: String(parameters.extendedPanID || '').replace(/^0x/i, ''),
          channel: parameters.channel,
          nwkUpdateId: parameters.nwkUpdateID,
        };
        backupLib.writeNetworkMetadata(dataDirectory, networkMetadata);
      } catch (error) {
        safeLog('debug', `Netzwerkparameter konnten nicht gelesen werden: ${errorText(error)}`);
      }

      networkState = result === 'resumed' ? 'übernommen' : result;
      reconnectDelay = RECONNECT_MIN_MS;
      lastError = '';
      connected = true;

      await loadDevices();
      setStatus(true, `${transport.label} · ${registry.size()} Geräte`);
      publishCoordinatorState();
      await refreshAvailability();
      // Das Netz steht — die Karte soll ihre Verbindungen von selbst bekommen.
      // Kurz verzögert, damit der Start nicht mit Funkverkehr zusammenfällt.
      scheduleTopologyScan('Netz steht', { delayMs: timings.firstDelayMs, force: true });
    } catch (error) {
      const message = loggingLib.redact(explainConnectError(error, transport), secretsForRedaction());
      lastError = message;
      networkState = 'Fehler';
      safeLog('error', `Zigbee-Coordinator nicht in Betrieb: ${message}`);
      setStatus(false, message, { isError: true });
      await teardownController();
      publishCoordinatorState();
      // Konfigurationsfehler werden ebenfalls erneut versucht: Der Betreiber
      // korrigiert die Einstellungen, ohne dass der Prozess sterben muss.
      scheduleReconnect();
    }
  }

  // ── Netzwerktopologie ─────────────────────────────────────────────────────

  /**
   * Beschreibt einen Knoten für die Netzwerkkarte.
   */
  function mapNode(entry, { isCoordinator = false } = {}) {
    const exposes = entry.definition
      ? exposesLib.exposeList(entry.definition, entry.zh, {})
      : [];
    const kind = isCoordinator
      ? 'coordinator'
      : exposesLib.deviceKind(exposes, { deviceType: entry.deviceType });
    // Direkt bedienbar ist ein Knoten über sein hervorstechendes schaltbares
    // Merkmal. Mehr gehört nicht auf die Karte — die vollständige Bedienung
    // bleibt Sache der States-Seite und des Dashboards.
    // Bedienelemente entstehen aus den beschreibbaren Merkmalen des Gerätes —
    // ein Schaltaktor bekommt dadurch einen Ein/Aus-Schalter, ein Rollladen
    // seine Fahrbefehle und einen Positionsregler, ein Thermostat seinen
    // Sollwert. Es gibt keine Sonderbehandlung je Gerätetyp: Was der Converter
    // als beschreibbar ausweist, wird bedienbar.
    const wert = (feature) => (entry.state && entry.state[feature.property] !== undefined
      ? registry.publishableValue(entry, feature.property, entry.state[feature.property])
      : undefined);
    const bedienbar = (entry.features || []).filter((feature) => feature.writable
      // Zusammengesetzte Werte lassen sich nicht sinnvoll als Bedienelement
      // darstellen; sie bleiben über die States-Seite erreichbar.
      && !feature.structured
      // Diagnosewerte sind keine Bedienung.
      && feature.category !== 'diagnostic');
    const controls = bedienbar.map((feature) => ({
      property: feature.property,
      type: feature.type,
      label: feature.label,
      unit: feature.unit || '',
      category: feature.category || '',
      value: wert(feature),
      values: feature.values,
      valueOn: feature.valueOn,
      valueOff: feature.valueOff,
      min: feature.min,
      max: feature.max,
      step: feature.step,
    }));
    // Der Ring am Knoten zeigt den hervorstechenden Schaltzustand.
    const primary = bedienbar.find((feature) => feature.type === 'binary' && feature.property === 'state')
      || bedienbar.find((feature) => feature.type === 'binary')
      || null;
    return {
      address: entry.slug,
      ieeeAddress: entry.ieeeAddress,
      networkAddress: entry.networkAddress,
      name: entry.friendlyName,
      kind,
      kindLabel: exposesLib.kindLabel(kind),
      deviceType: isCoordinator ? 'Coordinator' : entry.deviceType,
      deviceClass: isCoordinator ? 'router' : entry.deviceClass,
      powerSource: entry.powerSource || '',
      vendor: entry.vendor || '',
      model: entry.model || entry.zigbeeModel || '',
      battery: entry.state && entry.state.battery != null ? entry.state.battery : null,
      linkquality: entry.linkquality == null ? null : entry.linkquality,
      lastSeen: entry.lastSeen ? new Date(entry.lastSeen).toISOString() : '',
      available: isCoordinator ? true : entry.available,
      isCoordinator,
      controls,
      control: primary ? {
        property: primary.property,
        type: primary.type,
        stateAddress: exposesLib.stateAddress(entry.ieeeAddress, primary.property),
        // Derselbe Wert, den auch homeESS sieht — sonst stünde in der Karte
        // „ON", im Dashboard aber ein Wahrheitswert.
        value: wert(primary),
        valueOn: primary.valueOn,
        valueOff: primary.valueOff,
      } : null,
    };
  }

  /**
   * Alle Knoten der Karte: Coordinator und bekannte Geräte.
   */
  function mapNodes() {
    const nodes = [];
    const coordinator = controller && controller.getDevicesByType
      ? controller.getDevicesByType('Coordinator')[0]
      : null;
    if (coordinator) {
      nodes.push({
        ...mapNode({
          slug: exposesLib.deviceSlug(coordinator.ieeeAddr),
          ieeeAddress: coordinator.ieeeAddr,
          networkAddress: coordinator.networkAddress,
          friendlyName: 'Coordinator',
          deviceType: 'Coordinator',
          features: [],
          featureByProperty: new Map(),
          state: {},
          lastSeen: nowMs(),
          vendor: coordinatorInfo ? coordinatorInfo.firmware.product : '',
          model: transport ? transport.label : '',
        }, { isCoordinator: true }),
        zh: coordinator,
      });
    }
    for (const entry of registry.all()) nodes.push({ ...mapNode(entry), zh: entry.zh });
    return nodes;
  }

  /**
   * Plant einen Topologiescan.
   *
   * Er läuft selbsttätig, sobald das Netz steht, und erneut, wenn es sich
   * ändert — ein Gerät kommt hinzu, verschwindet oder wechselt seine
   * Netzadresse. Damit bleibt die Karte aktuell, ohne dass jemand einen Knopf
   * drückt.
   *
   * Zwei Bremsen verhindern, dass daraus Dauerfunk wird: Änderungen werden
   * gesammelt (mehrere Geräte beim Anlernen ergeben einen Scan), und zwischen
   * zwei Durchläufen liegt ein Mindestabstand.
   */
  function scheduleTopologyScan(reason, { delayMs = timings.debounceMs, force = false } = {}) {
    if (stopped || !controller) return;
    // Der Schalter gilt für jede selbsttätige Ermittlung, auch für die erste.
    // `force` hebt allein den Mindestabstand auf.
    if (config.autoTopology === false) return;
    if (topologyTimer) {
      // Ein bereits geplanter Lauf deckt die weiteren Änderungen mit ab.
      topologyReason = reason || topologyReason;
      return;
    }
    const seitLetztem = topologyLastRun ? nowMs() - topologyLastRun : Infinity;
    const wartezeit = force
      ? delayMs
      : Math.max(delayMs, timings.minIntervalMs - seitLetztem);
    topologyReason = reason || 'Netzänderung';
    topologyTimer = setTimeout(() => {
      topologyTimer = null;
      const grund = topologyReason;
      topologyReason = '';
      runTopologyScan({ reason: grund })
        .catch((error) => safeLog('debug', `Topologiescan (${grund}) nicht möglich: ${errorText(error)}`));
    }, Math.max(50, wartezeit));
    if (topologyTimer.unref) topologyTimer.unref();
  }

  /**
   * Führt einen Topologiescan durch. Immer nur einer gleichzeitig.
   */
  async function runTopologyScan(options = {}) {
    if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
    if (topologyScan) return topologyScan;
    const reason = options.reason || 'auf Anforderung';

    const nodes = mapNodes();
    // Nur Coordinator und Router führen eine Nachbartabelle. Endgeräte würden
    // die Abfrage nicht beantworten, Batteriegeräte allenfalls nach dem Wecken.
    const queryable = nodes.filter((node) => node.isCoordinator || node.deviceType === 'Router');
    topologyProgress = { running: true, current: 0, total: queryable.length, name: '', startedAt: nowMs() };

    topologyScan = (async () => {
      safeLog('info', `Topologiescan (${reason}): ${queryable.length} Knoten werden nach ihren Nachbarn gefragt.`);
      const scan = await topologyLib.scanTopology({
        nodes: queryable,
        onProgress: (progress) => {
          topologyProgress = { ...topologyProgress, ...progress, running: true };
        },
        onWarning: (node, message) => {
          safeLog('debug', `Nachbartabelle von ${node.name} nicht lesbar: ${message}`);
        },
      });
      const graph = topologyLib.buildGraph({
        nodes: nodes.map(({ zh, ...rest }) => rest),
        scan,
      });
      topology = {
        ...graph,
        scannedAt: new Date().toISOString(),
        durationMs: nowMs() - topologyProgress.startedAt,
        reason,
      };
      topologyLastRun = nowMs();
      safeLog('info', `Topologiescan beendet: ${graph.edges.length} Verbindungen zwischen `
        + `${graph.nodes.length} Knoten; ${graph.unreachable.length} Knoten ohne Antwort.`);
      return topology;
    })();

    try {
      return await topologyScan;
    } finally {
      topologyScan = null;
      topologyProgress = { ...topologyProgress, running: false };
    }
  }

  /**
   * Interviewt alle Geräte mit offenem oder fehlgeschlagenem Interview. Fehler
   * einzelner Geräte werden protokolliert, brechen den Durchlauf aber nicht ab.
   */
  async function interviewPending() {
    if (!controller) return { interviewed: 0, failed: 0, skipped: 0 };
    let interviewed = 0;
    let failed = 0;
    let skipped = 0;
    for (const zhDevice of controller.getDevicesIterator()) {
      if (zhDevice.type === 'Coordinator') continue;
      const state = String(zhDevice.interviewState || '');
      if (state === 'SUCCESSFUL' || state === 'IN_PROGRESS') { skipped += 1; continue; }
      try {
        await zhDevice.interview();
        interviewed += 1;
        await refreshDevice(zhDevice, { announce: true });
      } catch (error) {
        failed += 1;
        safeLog('debug', `Interview von ${zhDevice.ieeeAddr} nicht möglich: ${errorText(error)}`);
      }
    }
    if (interviewed || failed) {
      safeLog('info', `Interviews abgeschlossen: ${interviewed} erfolgreich, ${failed} ohne Antwort `
        + '(schlafende Batteriegeräte melden sich später von selbst).');
      publishCatalog();
      publishDeviceRows();
      publishCoordinatorState();
    }
    return { interviewed, failed, skipped };
  }

  /**
   * Öffnet oder schließt das Anlernfenster.
   */
  async function setPermitJoin(enabled, seconds) {
    if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
    if (!enabled) {
      await controller.permitJoin(0);
      permitJoinEndsAt = 0;
      safeLog('info', 'Anlernen beendet.');
      publishCoordinatorState();
      return { active: false, remaining: 0 };
    }
    const requested = Number(seconds) || Number(config.permitJoinSeconds) || 120;
    // Ein dauerhaft offenes Zigbee-Netz ist ein Sicherheitsproblem. Das
    // Anlernfenster ist deshalb immer begrenzt und endet von selbst.
    const limited = Math.max(10, Math.min(PERMIT_JOIN_MAX_SECONDS, Math.round(requested)));
    await controller.permitJoin(limited);
    permitJoinEndsAt = nowMs() + limited * 1000;
    safeLog('info', `Anlernen für ${limited} s geöffnet. Das Fenster schließt sich automatisch.`);
    publishCoordinatorState();
    return { active: true, remaining: limited };
  }

  /**
   * Schreibwunsch aus homeESS auf eine Adresse `<gerät>/<eigenschaft>`.
   */
  async function runtimeWrite(address, value) {
    const raw = String(address || '');
    if (raw.startsWith('coordinator/')) {
      if (raw === 'coordinator/permit_join') {
        await setPermitJoin(convertersLib.truthy(value));
        return;
      }
      throw Object.assign(new Error(`Der Coordinator-State ${raw} ist nicht beschreibbar.`),
        { code: 'ZIGBEE_READONLY' });
    }
    const separator = raw.indexOf('/');
    if (separator < 1) throw new Error(`Unbekannte Zigbee-Adresse: ${raw}`);
    const slug = raw.slice(0, separator);
    const property = raw.slice(separator + 1);
    const entry = registry.get(slug);
    if (!entry) throw new Error(`Unbekanntes Zigbee-Gerät: ${slug}`);
    if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
    const feature = entry.featureByProperty.get(property);
    if (!feature) throw new Error(`Das Gerät ${entry.friendlyName} kennt die Eigenschaft „${property}" nicht.`);
    if (!feature.writable) throw new Error(`Die Eigenschaft „${property}" von ${entry.friendlyName} ist nicht beschreibbar.`);

    const outcome = await convertersLib.convertSend({
      definition: entry.definition,
      device: entry.zh,
      feature,
      value,
      state: entry.state,
      options: {},
      publish: (values) => publish(registry.applyValues(entry, values)),
    });

    // Der Converter meldet den erreichten Zustand; sonst gilt der gesendete
    // Wert als bestätigt.
    const confirmed = outcome.result && outcome.result.state
      ? outcome.result.state
      : { [property]: outcome.converted };
    entry.lastSeen = nowMs();
    publish(registry.applyValues(entry, confirmed));
  }

  /**
   * Aktiver Lesewunsch.
   */
  async function runtimeRead(address) {
    const raw = String(address || '');
    if (!raw || raw.startsWith('coordinator/')) {
      publishCoordinatorState();
      return;
    }
    const separator = raw.indexOf('/');
    if (separator < 1) return;
    const entry = registry.get(raw.slice(0, separator));
    if (!entry || !controller) return;
    const property = raw.slice(separator + 1);
    const feature = entry.featureByProperty.get(property);
    if (!feature) {
      publish(registry.diagnosticValues(entry));
      return;
    }
    try {
      await convertersLib.convertGet({
        definition: entry.definition,
        device: entry.zh,
        feature,
        state: entry.state,
        options: {},
      });
    } catch (error) {
      safeLog('debug', `Abfrage von ${raw} nicht möglich: ${errorText(error)}`);
    }
    }

  /**
   * Tritt zugunsten eines neueren Prozesses derselben Instanz ab: Coordinator
   * freigeben, dann beenden. Der Supervisor führt diesen Prozess nicht mehr,
   * also kann ihn auch niemand mehr stoppen — er muss das selbst tun.
   */
  async function stepAside() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (availabilityTimer) clearInterval(availabilityTimer);
    if (topologyTimer) clearTimeout(topologyTimer);
    reconnectTimer = availabilityTimer = topologyTimer = null;
    try {
      await teardownController({ timeoutMs: STOP_RELEASE_MS });
    } finally {
      process.exit(0);
    }
  }

  // ── Öffentliche Laufzeit-Schnittstelle ────────────────────────────────────

  return {
    registry,

    async start(instanceConfig) {
      config = instanceConfig || {};
      stopped = false;
      reconnectDelay = RECONNECT_MIN_MS;

      if (typeof modules.setLogger === 'function') {
        modules.setLogger(loggingLib.createLibraryLogger(host, secretsForRedaction));
      }
      if (typeof modules.setConverterLogger === 'function') {
        modules.setConverterLogger(loggingLib.createLibraryLogger(host, secretsForRedaction));
      }

      dataDirectory = await host.getDataDirectory();

      // Zuständigkeit anmelden. Überlappende Neustarts können einen
      // Kindprozess hinterlassen, den der Supervisor nicht mehr kennt und nie
      // beendet — er hielte den Coordinator dauerhaft besetzt. Der zuletzt
      // gestartete Prozess ist der zuständige; ältere geben ab.
      ownLock = instanceLock.claim(dataDirectory);
      unwatchLock = instanceLock.watch(dataDirectory, ownLock, (nachfolger) => {
        safeLog('warn', 'Diese Instanz läuft ein zweites Mal; ein neuerer Prozess'
          + `${nachfolger && nachfolger.pid ? ` (${nachfolger.pid})` : ''} hat übernommen. `
          + 'Dieser Prozess gibt den Coordinator frei und beendet sich, damit die Verbindung nicht belegt bleibt.');
        stepAside().catch(() => process.exit(0));
      }, dependencies.lockCheckMs);

      networkMetadata = backupLib.readNetworkMetadata(dataDirectory);
      registry.applyCustomNames(config.devices);
      ignoredDevices = new Set((Array.isArray(config.ignoredDevices) ? config.ignoredDevices : [])
        .map((value) => exposesLib.deviceSlug(value)).filter(Boolean));

      publishCatalog();
      setStatus(false, 'Coordinator wird verbunden');
      publishCoordinatorState();

      availabilityTimer = setInterval(() => {
        refreshAvailability().catch((error) => safeLog('debug', `Verfügbarkeitsprüfung: ${errorText(error)}`));
      }, AVAILABILITY_INTERVAL_MS);
      if (availabilityTimer.unref) availabilityTimer.unref();

      // Der Verbindungsaufbau läuft bewusst nebenläufig: Ein nicht erreichbarer
      // Coordinator darf start() nicht scheitern lassen, sonst beendet der
      // Supervisor den Kindprozess und startet ihn in einer Schleife neu.
      connect().catch((error) => safeLog('error', `Start fehlgeschlagen: ${errorText(error)}`));
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (availabilityTimer) clearInterval(availabilityTimer);
      if (topologyTimer) clearTimeout(topologyTimer);
      if (unwatchLock) unwatchLock();
      reconnectTimer = null;
      availabilityTimer = null;
      topologyTimer = null;
      unwatchLock = null;

      // Reihenfolge ist hier entscheidend. homeESS beendet den Kindprozess drei
      // Sekunden nach dem Stoppsignal hart. Auf einen laufenden
      // Verbindungsaufbau zu warten, würde dieses Budget überschreiten — die
      // Schnittstelle wird deshalb zuerst gekappt und der laufende Zugriff
      // dadurch von selbst beendet.
      await teardownController({ timeoutMs: STOP_RELEASE_MS });
      // Erst danach den abgebrochenen Verbindungsaufbau auslaufen lassen, aber
      // nur kurz — er kann nichts mehr belegen.
      await Promise.race([
        settleConnect(),
        new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS)),
      ]);
      setStatus(false, 'Adapter gestoppt');
    },

    /**
     * Schreibwunsch aus homeESS auf eine Adresse `<gerät>/<eigenschaft>`.
     */
    write: runtimeWrite,

    /**
     * Aktiver Lesewunsch.
     */
    read: runtimeRead,

    // ── Steuerung für die Verwaltungsseite ──────────────────────────────────

    setPermitJoin,

    async removeDevice(slug, { force = false } = {}) {
      if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
      const entry = registry.get(slug);
      if (!entry) throw new Error('Unbekanntes Zigbee-Gerät.');
      const name = entry.friendlyName;
      try {
        await entry.zh.removeFromNetwork();
      } catch (error) {
        if (!force) {
          throw new Error(`${name} konnte nicht aus dem Netz entfernt werden: ${errorText(error)}. `
            + 'Bei einem nicht mehr erreichbaren Gerät kann das erzwungene Entfernen verwendet werden.');
        }
        safeLog('warn', `${name} antwortete nicht; der Eintrag wird lokal entfernt: ${errorText(error)}`);
        try {
          await entry.zh.removeFromDatabase();
        } catch (removeError) {
          throw new Error(`${name} konnte nicht entfernt werden: ${errorText(removeError)}`);
        }
      }
      registry.remove(entry.slug);
      // Merken, damit die Geräteübernahme den Eintrag nicht erneut aus dem
      // Coordinator-Backup hereinholt.
      ignoredDevices.add(entry.slug);
      try {
        host.setStorage('ignoredDevices', Array.from(ignoredDevices));
      } catch (_) {
        /* Ohne Persistenz bleibt es bei der Sitzung — kein Grund abzubrechen. */
      }
      publishCatalog();
      publishDeviceRows({ force: true });
      publishCoordinatorState();
      safeLog('info', `Gerät entfernt: ${name}. Es wird bei einer Geräteübernahme nicht erneut angelegt.`);
      return { removed: name };
    },

    /**
     * Erteilt die einmalige Freigabe für den Neuaufbau eines Netzes.
     */
    confirmNetworkCreation(channel) {
      const wanted = Number(channel) || networkLib.DEFAULT_CHANNEL;
      if (!coordinatorLib.isValidChannel(wanted)) {
        throw new Error(`Ungültiger Kanal: ${channel}. Zulässig sind ${coordinatorLib.CHANNEL_MIN} bis ${coordinatorLib.CHANNEL_MAX}.`);
      }
      createConfirmation = { channel: wanted, confirmedAt: nowMs() };
      safeLog('warn', `Neuaufbau des Zigbee-Netzes auf Kanal ${wanted} wurde bestätigt. `
        + 'Er wird beim nächsten Verbindungsaufbau ausgeführt; alle Geräte müssen danach neu angelernt werden.');
      return createConfirmation;
    },

    /**
     * Nimmt die im Coordinator-Backup verzeichneten Geräte in die
     * Gerätedatenbank auf, ohne sie neu anzulernen.
     *
     * Hintergrund: Nach dem Übernehmen eines bestehenden Netzes stimmen
     * Netzwerkschlüssel und PAN-ID, die Geräte funken also weiterhin. Für
     * zigbee-herdsman existieren sie aber erst, wenn sie in seiner eigenen
     * Datenbank stehen — bis dahin verwirft es ihre Nachrichten als „von
     * unbekanntem Gerät". Hier werden sie deshalb aus der Coordinator-Sicht
     * angelegt und anschließend interviewt.
     */
    async adoptDevicesFromBackup() {
      if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
      const rows = backupLib.readBackupDevices(dataDirectory);
      if (!rows.length) {
        throw new Error('Im Coordinator-Backup sind keine Geräte verzeichnet. '
          + 'Zuerst ein Backup erstellen oder ein vorhandenes einspielen.');
      }
      /* eslint-disable global-require */
      const { Device } = require('zigbee-herdsman/dist/controller/model');
      const { InterviewState } = require('zigbee-herdsman/dist/controller/model/device');
      /* eslint-enable global-require */

      let added = 0;
      let known = 0;
      let skipped = 0;
      let withoutKey = 0;
      const failed = [];
      for (const row of rows) {
        const slug = exposesLib.deviceSlug(row.ieeeAddress);
        if (ignoredDevices.has(slug)) {
          skipped += 1;
          continue;
        }
        if (controller.getDeviceByIeeeAddr(row.ieeeAddress)) {
          known += 1;
          continue;
        }
        // Ein regulär angelerntes Gerät besitzt einen eigenen Sicherheitsschlüssel.
        // Fehlt er, ist der Eintrag häufig eine Altlast aus der Adressverwaltung
        // des Coordinators — ein abgebrochener Anlernversuch oder ein längst
        // entferntes Gerät. Übernommen wird er trotzdem, aber benannt.
        if (!row.hasLinkKey) withoutKey += 1;
        try {
          Device.create('Unknown', row.ieeeAddress, row.networkAddress,
            undefined, undefined, undefined, undefined, InterviewState.Pending);
          added += 1;
        } catch (error) {
          failed.push(`${row.ieeeAddress}: ${errorText(error)}`);
        }
      }
      safeLog('info', `Geräteübernahme: ${added} Geräte aus dem Coordinator-Backup aufgenommen, `
        + `${known} waren bereits bekannt`
        + `${skipped ? `, ${skipped} zuvor entfernte übersprungen` : ''}`
        + `${failed.length ? `, ${failed.length} fehlgeschlagen` : ''}. `
        + 'Ihre Eigenschaften stehen fest, sobald das jeweilige Gerät das Interview beantwortet — '
        + 'batteriebetriebene Geräte müssen dafür geweckt werden.');
      if (withoutKey) {
        safeLog('warn', `${withoutKey} übernommene${withoutKey === 1 ? 'r Eintrag führt' : ' Einträge führen'} `
          + 'keinen eigenen Sicherheitsschlüssel. Das sind häufig Altlasten aus der Adressverwaltung des '
          + 'Coordinators — abgebrochene Anlernversuche oder längst entfernte Geräte. Bleibt das Interview '
          + 'dauerhaft ohne Antwort und fehlen Hersteller und Modell, kann der Eintrag gefahrlos entfernt werden.');
      }
      for (const message of failed) safeLog('warn', `Geräteübernahme: ${message}`);

      await loadDevices();
      publishCoordinatorState();
      scheduleTopologyScan('Geräte übernommen');
      // Interviews im Hintergrund anstoßen. Ein nicht antwortendes Gerät ist
      // hier der Normalfall (Batteriegerät im Schlaf) und darf nichts blockieren.
      interviewPending().catch(() => {});
      return { added, known, skipped, withoutKey, failed: failed.length, total: rows.length };
    },

    /**
     * Interviewt alle Geräte, deren Interview noch aussteht.
     */
    async interviewPendingDevices() {
      if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
      return interviewPending();
    },

    async createBackup() {
      if (!controller) throw new Error('Der Coordinator ist derzeit nicht verbunden.');
      await controller.backup();
      return backupLib.readStoredBackupInfo(dataDirectory);
    },

    async reconnectNow() {
      await settleConnect();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDelay = RECONNECT_MIN_MS;
      await teardownController();
      await connect();
      return { connected: !!controller, error: lastError };
    },

    /**
     * Zustandsbild für die Verwaltungsseite.
     */
    status() {
      const permitRemaining = permitJoinEndsAt > nowMs() ? Math.round((permitJoinEndsAt - nowMs()) / 1000) : 0;
      return {
        connected,
        starting,
        stopped,
        networkState,
        lastError,
        transport: transport ? { type: transport.type, label: transport.label } : null,
        coordinator: coordinatorInfo ? {
          type: coordinatorInfo.coordinatorType,
          ieeeAddress: coordinatorInfo.ieeeAddress,
          firmware: coordinatorInfo.firmware,
          configured: coordinatorInfo.configured,
        } : null,
        network: networkMetadata ? {
          panId: networkMetadata.panId,
          panIdHex: `0x${Number(networkMetadata.panId).toString(16).padStart(4, '0')}`,
          extendedPanId: networkMetadata.extendedPanId,
          channel: networkMetadata.channel,
          updatedAt: networkMetadata.updatedAt || '',
        } : null,
        planAction: plan ? plan.action : null,
        createConfirmed: !!createConfirmation,
        permitJoin: { active: permitRemaining > 0, remaining: permitRemaining },
        deviceCount: registry.size(),
        devicesOnline: registry.onlineCount(),
        backup: dataDirectory ? backupLib.readStoredBackupInfo(dataDirectory) : null,
        // Geräte, die der Coordinator kennt, dem Adapter aber noch fehlen.
        adoptableDevices: dataDirectory
          ? backupLib.readBackupDevices(dataDirectory).filter((row) => {
            const slug = exposesLib.deviceSlug(row.ieeeAddress);
            return !registry.get(slug) && !ignoredDevices.has(slug);
          }).length
          : 0,
        ignoredDevices: Array.from(ignoredDevices),
        dataDirectory,
      };
    },

    devices() {
      return registry.deviceDetails();
    },

    /**
     * Die Netzwerkkarte: Knoten mit ihrer Gattung, Kanten mit ihrer Qualität.
     * Ohne vorherigen Scan sind die Knoten bekannt, die Verbindungen nicht.
     */
    networkMap() {
      const nodes = mapNodes().map(({ zh, ...rest }) => rest);
      if (!topology) {
        return {
          nodes, edges: [], scannedAt: null, unreachable: [], isolated: [],
          progress: topologyProgress, connected: !!controller,
        };
      }
      // Die Knoten kommen immer frisch: Werte und Verfügbarkeit ändern sich
      // laufend, die Funkstrecken nur beim Scan.
      const known = new Map(topology.nodes.map((node) => [node.address, node]));
      return {
        nodes: nodes.map((node) => ({
          ...node,
          depth: known.has(node.address) ? known.get(node.address).depth : null,
          links: known.has(node.address) ? known.get(node.address).links : 0,
        })),
        edges: topology.edges,
        scannedAt: topology.scannedAt,
        reason: topology.reason || '',
        durationMs: topology.durationMs,
        unreachable: topology.unreachable,
        isolated: topology.isolated,
        progress: topologyProgress,
        connected: !!controller,
      };
    },

    scanTopology: runTopologyScan,

    /**
     * Benennt ein Gerät um.
     *
     * Die Umbenennung wirkt nur auf die Anzeige: State-Adressen folgen der
     * IEEE-Adresse und bleiben unverändert, eingetragene Topics gelten weiter.
     * Angepasst werden der Anzeigename, die Kategorie im States-Baum und die
     * gespeicherte Geräteliste.
     */
    async renameDevice(slug, name) {
      const friendlyName = registry.setCustomName(slug, name);
      publishCatalog();
      publishDeviceRows({ force: true });
      const entry = registry.get(slug);
      if (entry) publish(registry.diagnosticValues(entry));
      safeLog('info', registry.customName(slug)
        ? `Gerät umbenannt: ${friendlyName}.`
        : `Eigener Name entfernt; das Gerät heißt wieder ${friendlyName}.`);
      return { slug: String(slug).toLowerCase(), name: friendlyName, customName: registry.customName(slug) };
    },

    /**
     * Schreibt eine Eigenschaft und liefert den bestätigten Zustand zurück —
     * für die Bedienung direkt aus der Netzwerkkarte.
     */
    async writeProperty(slug, property, value) {
      const entry = registry.get(slug);
      if (!entry) throw new Error('Unbekanntes Zigbee-Gerät.');
      await runtimeWrite(`${entry.slug}/${property}`, value);
      const feature = entry.featureByProperty.get(property);
      const raw = entry.state ? entry.state[property] : undefined;
      const result = { [property]: raw === undefined ? undefined : registry.publishableValue(entry, property, raw) };
      if (feature && feature.property === 'state' && entry.state.brightness !== undefined) {
        result.brightness = registry.publishableValue(entry, 'brightness', entry.state.brightness);
      }
      return result;
    },

    topologyProgress() {
      return topologyProgress;
    },

    // Nur für Integrationstests: Zugriff auf den laufenden Controller.
    __testController() {
      return controller;
    },

    // Nur für Integrationstests: Zugriff auf den darunterliegenden Socket, um
    // einen echten Verbindungsabriss auslösen zu können.
    __testControllerSocket() {
      const adapter = controller && controller.adapter;
      const znp = adapter && adapter.znp;
      return (znp && (znp.socketPort || znp.serialPort)) || null;
    },

    dataDirectory() {
      return dataDirectory;
    },

    importDeviceDatabaseFile(sourcePath) {
      if (!dataDirectory) throw new Error('Das Datenverzeichnis ist noch nicht verfügbar.');
      if (controller) {
        throw new Error('Die Gerätedatenbank kann nur bei getrenntem Coordinator eingespielt werden. '
          + 'Bitte die Instanz kurz deaktivieren oder die Verbindung trennen.');
      }
      const info = backupLib.importDeviceDatabase(dataDirectory, sourcePath);
      safeLog('info', `Gerätedatenbank übernommen: ${info.devices} Geräte, ${info.groups} Gruppen. `
        + 'Sie wird beim nächsten Verbindungsaufbau geladen.');
      return info;
    },

    importBackupFile(sourcePath) {
      if (!dataDirectory) throw new Error('Das Datenverzeichnis ist noch nicht verfügbar.');
      const info = backupLib.importBackup(dataDirectory, sourcePath);
      safeLog('info', `Coordinator-Backup übernommen (${info.format}, ${info.deviceCount == null ? 'unbekannt viele' : info.deviceCount} Geräte). `
        + 'Es wird beim nächsten Verbindungsaufbau berücksichtigt.');
      return info;
    },
  };
}

module.exports = { createRuntime, PERMIT_JOIN_MAX_SECONDS, RECONNECT_MIN_MS, RECONNECT_MAX_MS };
