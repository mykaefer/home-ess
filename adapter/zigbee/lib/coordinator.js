'use strict';

// Coordinator-Abstraktion. Ein Coordinator-Treiber weiß, wie die jeweilige
// Funkhardware *gelesen* wird, bevor zigbee-herdsman sie in Betrieb nimmt.
//
// Warum das nötig ist: zigbee-herdsman entscheidet beim Start selbst, ob es ein
// vorhandenes Netz weiterführt oder ein neues kommissioniert. Diese Entscheidung
// trifft es durch Vergleich der übergebenen Netzwerkparameter mit dem Zustand im
// NV-Speicher des Coordinators. Übergäbe der Adapter beim ersten Start
// irgendwelche Vorgabewerte, wäre das Ergebnis „startCommissioning" — das
// bestehende Zigbee-Netz wäre unwiederbringlich verloren und alle Geräte
// müssten neu angelernt werden.
//
// Der Treiber liest die tatsächlichen Parameter deshalb vorab und rein lesend
// aus. Erst damit kann der Adapter ein bestehendes Netz bewusst übernehmen
// statt es zu überschreiben.

const CHANNEL_MIN = 11;
const CHANNEL_MAX = 26;

// Ein TCP-Verbindungsversuch zu einem Host, der Pakete stillschweigend verwirft,
// läuft ohne eigenes Zeitlimit minutenlang. Der Adapter würde in dieser Zeit
// weder erneut versuchen noch den Fehler melden.
const PROBE_TIMEOUT_MS = 20000;

function fail(message, code = 'ZIGBEE_COORDINATOR') {
  return Object.assign(new Error(message), { code });
}

// ── Texas Instruments Z-Stack ───────────────────────────────────────────────

const ZSTACK_PRODUCTS = {
  0: 'Z-Stack 1.2',
  1: 'Z-Stack 3.x.0',
  2: 'Z-Stack 3.0.x',
};

function zstackModules() {
  // Bewusst verzögert geladen: Die Module ziehen die seriellen Bindings nach.
  // Ein Konfigurationsfehler soll bereits vorher mit klarer Meldung scheitern.
  /* eslint-disable global-require */
  return {
    Znp: require('zigbee-herdsman/dist/adapter/z-stack/znp').Znp,
    AdapterNvMemory: require('zigbee-herdsman/dist/adapter/z-stack/adapter/adapter-nv-memory').AdapterNvMemory,
    Structs: require('zigbee-herdsman/dist/adapter/z-stack/structs'),
    common: require('zigbee-herdsman/dist/adapter/z-stack/constants/common'),
    Subsystem: require('zigbee-herdsman/dist/adapter/z-stack/unpi/constants').Subsystem,
    channelUtils: require('zigbee-herdsman/dist/adapter/z-stack/utils'),
    ZnpVersion: require('zigbee-herdsman/dist/adapter/z-stack/adapter/tstype').ZnpVersion,
  };
  /* eslint-enable global-require */
}

/**
 * Liest den Coordinator rein lesend aus. Es wird nichts geschrieben, nichts
 * kommissioniert und nichts zurückgesetzt.
 *
 * @returns {Promise<object>} Momentaufnahme des Coordinators
 */
/**
 * Gibt die Schnittstelle bedingungslos frei.
 *
 * `Znp.close()` zerstört den Port nur, wenn die Initialisierung zuvor
 * abgeschlossen wurde. Bricht der Zugriff vorher ab — Zeitlimit, stummer
 * Coordinator, Fehler beim Öffnen —, bleibt die Verbindung für die gesamte
 * Prozesslaufzeit bestehen. Bei einer Bridge, die nur einen Client zulässt,
 * blockiert schon eine einzige solche Leiche jeden weiteren Versuch: Der
 * Adapter meldet dann dauerhaft „Error while opening socket", obwohl er selbst
 * der Verursacher ist.
 */
async function releaseZnp(znp) {
  if (!znp) return;
  try {
    await znp.close();
  } catch (_) {
    /* Eine bereits tote Verbindung lässt sich nicht mehr sauber schließen. */
  }
  const socket = znp.socketPort;
  if (socket && !socket.destroyed) {
    try {
      socket.destroy();
    } catch (_) {
      /* Der Dateideskriptor ist damit in jedem Fall freigegeben. */
    }
  }
  const serial = znp.serialPort;
  if (serial && serial.isOpen) {
    try {
      serial.close(() => {});
    } catch (_) {
      /* dito */
    }
  }
}

async function probeZStack(transport, options = {}) {
  const { Znp, AdapterNvMemory, Structs, common, Subsystem, channelUtils, ZnpVersion } = options.modules || zstackModules();
  const timeoutMs = Number(options.timeoutMs) || PROBE_TIMEOUT_MS;
  const znp = new Znp(transport.path, transport.baudRate, transport.rtscts);
  // Ein Abbruch von außen (Adapter wird gestoppt) muss die Schnittstelle sofort
  // freigeben können, statt auf das Zeitlimit zu warten.
  if (typeof options.onOpen === 'function') options.onOpen(() => releaseZnp(znp));
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail(
      `Der Coordinator hat unter ${transport.label} innerhalb von ${Math.round(timeoutMs / 1000)} s nicht geantwortet.`,
      'ZIGBEE_COORDINATOR_TIMEOUT')), timeoutMs);
    if (timer.unref) timer.unref();
  });
  const guard = (promise) => Promise.race([promise, deadline]);
  try {
    await guard(znp.open());

    const version = await guard(znp.requestWithReply(Subsystem.SYS, 'version', {}));
    const info = await guard(znp.requestWithReply(Subsystem.UTIL, 'getDeviceInfo', {}));
    const product = Number(version.payload.product);
    const znpVersion = product === ZnpVersion.ZStack12 ? ZnpVersion.ZStack12
      : (product === ZnpVersion.ZStack30x ? ZnpVersion.ZStack30x : ZnpVersion.ZStack3x0);

    const nv = new AdapterNvMemory(znp);
    await guard(nv.init());

    const hasConfiguredId = znpVersion === ZnpVersion.ZStack12
      ? common.NvItemsIds.ZNP_HAS_CONFIGURED_ZSTACK1
      : common.NvItemsIds.ZNP_HAS_CONFIGURED_ZSTACK3;
    const hasConfigured = await guard(nv.readItem(hasConfiguredId, 0, Structs.hasConfigured));
    const nib = await guard(nv.readItem(common.NvItemsIds.NIB, 0, Structs.nib));
    const activeKey = await guard(nv.readItem(common.NvItemsIds.NWK_ACTIVE_KEY_INFO, 0, Structs.nwkKeyDescriptor));
    // Der Alternativschlüssel wird ausdrücklich mitgelesen: zigbee-herdsman
    // erkennt ein Netz nur dann als „passend" an, wenn aktiver UND alternativer
    // Schlüssel mit den übergebenen Netzwerkoptionen übereinstimmen. Weichen sie
    // voneinander ab, würde es das Netz stattdessen neu kommissionieren. Diese
    // Abweichung muss deshalb vor dem Start bekannt sein.
    const alternateKey = await guard(nv.readItem(common.NvItemsIds.NWK_ALTERN_KEY_INFO, 0, Structs.nwkKeyDescriptor));

    const configured = !!(hasConfigured && hasConfigured.isConfigured() && nib);
    const network = configured ? {
      panId: nib.nwkPanId,
      extendedPanId: Array.from(Buffer.from(nib.extendedPANID)),
      channel: nib.nwkLogicalChannel,
      channelList: channelUtils.unpackChannelList(nib.channelList),
      nwkUpdateId: nib.nwkUpdateId,
      // Der Schlüssel verlässt diese Struktur nur in Richtung Secret-Store
      // beziehungsweise zigbee-herdsman. Er wird nie geloggt und nie in den
      // Instanz-Einstellungen abgelegt.
      networkKey: activeKey && activeKey.key ? Array.from(Buffer.from(activeKey.key)) : null,
      alternateNetworkKey: alternateKey && alternateKey.key ? Array.from(Buffer.from(alternateKey.key)) : null,
    } : null;

    return {
      coordinatorType: 'zstack',
      reachable: true,
      configured,
      ieeeAddress: String(info.payload.ieeeaddr || ''),
      networkAddress: Number(info.payload.shortaddr),
      // devicestate 9 (ZB_COORD) bedeutet: läuft bereits als Coordinator.
      started: Number(info.payload.devicestate) === common.DevStates.ZB_COORD,
      firmware: {
        product: ZSTACK_PRODUCTS[product] || `unbekannt (${product})`,
        transportRevision: Number(version.payload.transportrev),
        version: `${version.payload.majorrel}.${version.payload.minorrel}.${version.payload.maintrel}`,
        revision: String(version.payload.revision || ''),
      },
      znpVersion,
      network,
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Der lesende Zugriff darf unter keinen Umständen eine offene Verbindung
    // hinterlassen; sonst blockiert er den anschließenden regulären Start.
    await releaseZnp(znp);
    if (typeof options.onRelease === 'function') options.onRelease();
  }
}

// ── Treiberverzeichnis ──────────────────────────────────────────────────────

const DRIVERS = {
  zstack: {
    id: 'zstack',
    label: 'Texas Instruments Z-Stack',
    // Kennung, die zigbee-herdsman für diese Hardware erwartet.
    herdsmanAdapter: 'zstack',
    defaultBaudRate: 115200,
    supported: true,
    probe: probeZStack,
  },
  // Vorbereitet, aber nicht freigegeben: Die Netzwerkübernahme setzt einen
  // hardwarespezifischen, rein lesenden Zugriff auf die Netzwerkparameter
  // voraus. Ohne diesen dürfte der Adapter nicht starten, ohne das Überschreiben
  // eines bestehenden Netzes zu riskieren. Ein Treiber ist damit vollständig,
  // sobald `probe` ergänzt und `supported` gesetzt ist — die übrige
  // Adapterlogik bleibt unverändert.
  ember: {
    id: 'ember',
    label: 'Silicon Labs Ember / EmberZNet',
    herdsmanAdapter: 'ember',
    defaultBaudRate: 115200,
    supported: false,
    probe: null,
  },
  deconz: {
    id: 'deconz',
    label: 'Dresden Elektronik deCONZ',
    herdsmanAdapter: 'deconz',
    defaultBaudRate: 38400,
    supported: false,
    probe: null,
  },
};

function getDriver(type) {
  const id = String(type || 'zstack').trim().toLowerCase();
  const driver = DRIVERS[id];
  if (!driver) throw fail(`Unbekannter Coordinator-Typ: ${id}.`);
  if (!driver.supported || typeof driver.probe !== 'function') {
    throw fail(`Der Coordinator-Typ ${driver.label} ist in dieser Adapterfassung noch nicht freigegeben. `
      + 'Freigegeben ist derzeit Texas Instruments Z-Stack.');
  }
  return driver;
}

function listDrivers() {
  return Object.values(DRIVERS).map((driver) => ({
    id: driver.id, label: driver.label, supported: driver.supported,
  }));
}

function isValidChannel(channel) {
  return Number.isInteger(channel) && channel >= CHANNEL_MIN && channel <= CHANNEL_MAX;
}

module.exports = {
  DRIVERS,
  releaseZnp,
  PROBE_TIMEOUT_MS,
  CHANNEL_MIN,
  CHANNEL_MAX,
  getDriver,
  listDrivers,
  isValidChannel,
  probeZStack,
};
