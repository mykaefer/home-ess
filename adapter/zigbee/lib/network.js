'use strict';

// Netzwerkzustand: übernehmen oder neu erstellen.
//
// Diese Datei entscheidet als einzige, mit welchen Netzwerkparametern
// zigbee-herdsman gestartet wird. Die Regel ist absichtlich streng:
//
//   Ein bestehendes Zigbee-Netz wird niemals beiläufig neu erstellt.
//
// Fehlt die homeESS-Persistenz — etwa beim allerersten Start oder nach einem
// Umzug der Installation — ist das *kein* Grund, ein neues Netz aufzubauen.
// Maßgeblich ist ausschließlich der Coordinator selbst: Meldet er ein
// konfiguriertes Netz, werden dessen Parameter unverändert übernommen.
//
// Ein neues Netz entsteht nur, wenn der Betreiber das ausdrücklich anfordert
// UND zusätzlich bestätigt hat. Beides zusammen, nie nur eines von beiden.

const crypto = require('crypto');

const DEFAULT_CHANNEL = 11;

function fail(message, code) {
  return Object.assign(new Error(message), { code: code || 'ZIGBEE_NETWORK' });
}

function toHex(bytes) {
  return Buffer.from(bytes || []).toString('hex');
}

function fromHex(text) {
  const clean = String(text || '').replace(/^0x/i, '').trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) return null;
  return Array.from(Buffer.from(clean, 'hex'));
}

// Ein zufälliger 128-Bit-Netzwerkschlüssel aus der Kryptoquelle des Systems.
// Ausdrücklich keine Eigenimplementierung und kein Math.random().
function generateNetworkKey() {
  return Array.from(crypto.randomBytes(16));
}

function generatePanId() {
  // 0x0000 ist reserviert, 0xffff bedeutet „beliebig" — beides ist als feste
  // PAN-ID unbrauchbar.
  let panId = 0;
  while (panId === 0 || panId === 0xffff) {
    panId = crypto.randomBytes(2).readUInt16BE(0);
  }
  return panId;
}

function generateExtendedPanId() {
  return Array.from(crypto.randomBytes(8));
}

/**
 * Beschreibt in einem Satz, was mit dem Netzwerk geschehen wird.
 */
function describePlan(plan) {
  if (plan.action === 'adopt') {
    return `Bestehendes Zigbee-Netz übernehmen (PAN 0x${plan.network.panId.toString(16).padStart(4, '0')}, `
      + `Kanal ${plan.network.channel}).`;
  }
  if (plan.action === 'restore') {
    return 'Zigbee-Netz aus dem gespeicherten Coordinator-Backup wiederherstellen.';
  }
  return 'Neues Zigbee-Netz erstellen. Alle bisherigen Geräte müssten neu angelernt werden.';
}

/**
 * Ermittelt aus Coordinator-Momentaufnahme, gespeichertem Zustand und
 * Betreiberwunsch den auszuführenden Plan.
 *
 * @param {object} probe    Ergebnis des rein lesenden Coordinator-Zugriffs
 * @param {object|null} stored  zuletzt von homeESS persistierte Netzwerkdaten
 * @param {object} intent   { mode: 'adopt'|'create', createConfirmed: boolean, ... }
 */
function planNetwork(probe, stored, intent = {}) {
  if (!probe || !probe.reachable) {
    throw fail('Der Coordinator ist nicht erreichbar.', 'ZIGBEE_COORDINATOR_UNREACHABLE');
  }
  const mode = String(intent.mode || 'adopt').toLowerCase();

  // ── Ausdrücklicher Neuaufbau ──────────────────────────────────────────────
  if (mode === 'create') {
    // Zwei-Schlüssel-Prinzip: Die Einstellung allein genügt nicht. Ohne die
    // zusätzliche Bestätigung in der Verwaltung passiert nichts — sonst würde
    // ein versehentlich stehen gelassener Auswahlwert beim nächsten Neustart
    // ein produktives Netz vernichten.
    if (!intent.createConfirmed) {
      throw fail('Für „Neues Netzwerk erstellen" fehlt die ausdrückliche Bestätigung. '
        + 'Sie wird in der Unterseite „Zigbee-Netzwerk" erteilt und gilt für genau einen Vorgang. '
        + 'Das vorhandene Zigbee-Netz bleibt bis dahin unverändert.',
      'ZIGBEE_CREATE_UNCONFIRMED');
    }
    const channel = Number(intent.channel) || DEFAULT_CHANNEL;
    return {
      action: 'create',
      // Der Coordinator wird dadurch neu kommissioniert; das ist hier gewollt.
      destructive: true,
      network: {
        panId: generatePanId(),
        extendedPanId: generateExtendedPanId(),
        channel,
        channelList: [channel],
        networkKey: generateNetworkKey(),
      },
    };
  }

  if (mode !== 'adopt') throw fail(`Unbekannter Netzwerkmodus: ${mode}.`);

  // ── Bestehendes Netz übernehmen ───────────────────────────────────────────
  if (probe.configured && probe.network) {
    const network = probe.network;
    if (!network.networkKey || network.networkKey.length !== 16) {
      throw fail('Der Coordinator meldet ein konfiguriertes Netz, gibt seinen Netzwerkschlüssel aber nicht heraus. '
        + 'Ohne diesen Schlüssel ließe sich das Netz nur durch Neuaufbau in Betrieb nehmen — das würde alle Geräte '
        + 'abmelden und wird deshalb nicht selbsttätig ausgeführt.',
      'ZIGBEE_ADOPT_NO_KEY');
    }
    // zigbee-herdsman übernimmt ein vorhandenes Netz nur, wenn der aktive und
    // der alternative Netzwerkschlüssel identisch sind. Sind sie es nicht,
    // bewertet es die Konfiguration als unpassend und baut das Netz neu auf —
    // mit dem Verlust aller angelernten Geräte. Dieser Fall wird deshalb hier
    // abgefangen, bevor der Coordinator überhaupt in Betrieb genommen wird.
    const alternate = network.alternateNetworkKey;
    if (alternate && alternate.length === 16
        && !Buffer.from(alternate).equals(Buffer.from(network.networkKey))) {
      throw fail('Der Coordinator führt einen aktiven und einen davon abweichenden alternativen '
        + 'Netzwerkschlüssel. In diesem Zustand würde die Zigbee-Bibliothek das vorhandene Netz nicht '
        + 'als passend erkennen und neu aufbauen — alle Geräte wären abgemeldet. Der Adapter startet '
        + 'deshalb nicht. Abhilfe: ein Coordinator-Backup des bestehenden Netzes einspielen oder das '
        + 'Netz bewusst neu erstellen.',
      'ZIGBEE_ADOPT_KEY_MISMATCH');
    }

    const channel = network.channel || (network.channelList && network.channelList[0]) || DEFAULT_CHANNEL;
    const plan = {
      action: 'adopt',
      destructive: false,
      network: {
        panId: network.panId,
        extendedPanId: network.extendedPanId,
        channel,
        channelList: network.channelList && network.channelList.length ? network.channelList : [channel],
        networkKey: network.networkKey,
      },
    };
    // Weicht der gespeicherte Zustand ab, gilt der Coordinator. Er ist die
    // Hardware, in der das Netz tatsächlich lebt.
    if (stored && stored.panId != null && Number(stored.panId) !== Number(network.panId)) {
      plan.note = `Die gespeicherten Netzwerkdaten (PAN 0x${Number(stored.panId).toString(16)}) weichen vom `
        + `Coordinator (PAN 0x${Number(network.panId).toString(16)}) ab. Maßgeblich ist der Coordinator; `
        + 'die gespeicherten Daten werden angeglichen.';
    }
    return plan;
  }

  // ── Coordinator ohne Netz ─────────────────────────────────────────────────
  // Auch hier wird nichts selbsttätig erzeugt. Ein fabrikneuer Stick ist der
  // einzige Fall, in dem ein Neuaufbau gefahrlos wäre — die Entscheidung bleibt
  // trotzdem beim Betreiber, weil ein „nicht konfiguriert" auch aus einer
  // fehlgeschlagenen Abfrage stammen kann.
  throw fail('Der Coordinator meldet kein konfiguriertes Zigbee-Netz. Es wird deshalb nichts übernommen und '
    + 'ausdrücklich auch nichts neu erstellt. Bei fabrikneuer Hardware in der Unterseite „Zigbee-Netzwerk" '
    + 'ein neues Netz anlegen; bei vorhandenem Netz zuerst prüfen, ob der richtige Coordinator angebunden ist.',
  'ZIGBEE_NO_NETWORK');
}

/**
 * Trennt die persistierbaren Netzwerkdaten vom Schlüsselmaterial. Der
 * Netzwerkschlüssel gehört ausschließlich in den Secret-Store.
 */
function splitPersistence(network) {
  return {
    // Wandert in das Adapter-Datenverzeichnis / die Instanzmetadaten.
    metadata: {
      panId: network.panId,
      extendedPanId: toHex(network.extendedPanId),
      channel: network.channel,
      channelList: network.channelList,
    },
    // Wandert ausschließlich in den Secret-Store.
    secret: toHex(network.networkKey),
  };
}

function mergePersistence(metadata, secretHex) {
  if (!metadata) return null;
  const networkKey = fromHex(secretHex);
  return {
    panId: Number(metadata.panId),
    extendedPanId: fromHex(metadata.extendedPanId),
    channel: Number(metadata.channel),
    channelList: Array.isArray(metadata.channelList) ? metadata.channelList : [Number(metadata.channel)],
    networkKey: networkKey && networkKey.length === 16 ? networkKey : null,
  };
}

/**
 * Baut aus dem Plan die NetworkOptions, die zigbee-herdsman erwartet.
 */
function herdsmanNetworkOptions(plan) {
  return {
    panID: plan.network.panId,
    extendedPanID: plan.network.extendedPanId,
    channelList: plan.network.channelList,
    networkKey: plan.network.networkKey,
    networkKeyDistribute: false,
  };
}

module.exports = {
  DEFAULT_CHANNEL,
  planNetwork,
  describePlan,
  splitPersistence,
  mergePersistence,
  herdsmanNetworkOptions,
  generateNetworkKey,
  generatePanId,
  generateExtendedPanId,
  toHex,
  fromHex,
};
