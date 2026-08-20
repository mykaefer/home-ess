'use strict';

// Transportauflösung. Der Transport beschreibt ausschließlich, *wie* der
// serielle Datenstrom des Coordinators erreicht wird — niemals, *welche*
// Zigbee-Hardware dahinter steckt. Beides bleibt bewusst getrennt, damit
// derselbe Coordinator-Typ lokal wie über das Netz nutzbar ist.
//
// zigbee-herdsman unterscheidet die beiden Fälle selbst am Pfad: eine als URL
// interpretierbare Zeichenkette (`tcp://host:port`) öffnet einen Socket, alles
// andere einen seriellen Port. Wir liefern deshalb nur den korrekt gebauten
// Pfad und die Portparameter.

const TRANSPORT_TYPES = ['serial', 'tcp'];

// Vom Anwender frei eingetragene Hostnamen dürfen keine weiteren URL-Bestandteile
// einschleusen können; sonst landet ein Pfad wie `1.2.3.4:1/x?y` im Socket.
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,251}[a-zA-Z0-9])?$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;

function fail(message) {
  return Object.assign(new Error(message), { code: 'ZIGBEE_TRANSPORT_CONFIG' });
}

function normalizeHost(value) {
  const host = String(value == null ? '' : value).trim();
  if (!host) throw fail('Für die TCP-Anbindung fehlt die Adresse der Zigbee-Bridge.');
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    if (!IPV6_RE.test(inner)) throw fail(`Ungültige IPv6-Adresse der Zigbee-Bridge: ${host}`);
    return host;
  }
  if (IPV6_RE.test(host) && host.includes(':')) return `[${host}]`;
  if (!HOSTNAME_RE.test(host)) throw fail(`Ungültige Adresse der Zigbee-Bridge: ${host}`);
  return host;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw fail(`Ungültiger Port der Zigbee-Bridge: ${value}`);
  }
  return port;
}

function normalizeSerialPath(value) {
  const path = String(value == null ? '' : value).trim();
  if (!path) throw fail('Für die serielle Anbindung fehlt der Gerätepfad des Coordinators.');
  if (!path.startsWith('/')) throw fail(`Der serielle Pfad muss absolut sein: ${path}`);
  // Ein Pfad, den Node als URL lesen kann, würde von zigbee-herdsman als
  // Netzwerkziel behandelt. Solche Eingaben gehören nicht in dieses Feld.
  let looksLikeUrl = false;
  try {
    // eslint-disable-next-line no-new
    new URL(path);
    looksLikeUrl = true;
  } catch (_) {
    looksLikeUrl = false;
  }
  if (looksLikeUrl) throw fail(`Der serielle Pfad darf keine Netzwerkadresse sein: ${path}`);
  return path;
}

function normalizeBaudRate(value, fallback) {
  const baudRate = Number(value);
  if (!Number.isInteger(baudRate) || baudRate < 1200 || baudRate > 4000000) return fallback;
  return baudRate;
}

// Stabile Pfade unter /dev/serial/by-id/… überleben einen Neustart und das
// Umstecken; /dev/ttyUSB0 kann nach einem Reboot eine andere Hardware sein.
function isStableSerialPath(path) {
  return String(path || '').startsWith('/dev/serial/by-id/');
}

/**
 * Baut aus den Instanz-Einstellungen die Transportbeschreibung.
 * @returns {{type: string, path: string, baudRate: number, rtscts: boolean,
 *            label: string, warnings: string[]}}
 */
function resolveTransport(config = {}, defaults = {}) {
  const type = String(config.transportType || 'tcp').trim().toLowerCase();
  if (!TRANSPORT_TYPES.includes(type)) {
    throw fail(`Unbekannte Anbindung: ${type}. Zulässig sind ${TRANSPORT_TYPES.join(' und ')}.`);
  }
  const baudRate = normalizeBaudRate(config.baudRate, Number(defaults.baudRate) || 115200);
  const warnings = [];

  if (type === 'tcp') {
    const host = normalizeHost(config.tcpHost);
    const port = normalizePort(config.tcpPort);
    return {
      type,
      path: `tcp://${host}:${port}`,
      // Über TCP ist die Baudrate Sache der Bridge; sie wird nur mitgeführt,
      // damit die Anzeige die Gegenstelle vollständig beschreibt.
      baudRate,
      rtscts: false,
      label: `TCP ${host}:${port}`,
      warnings,
    };
  }

  const path = normalizeSerialPath(config.serialPath);
  if (!isStableSerialPath(path)) {
    warnings.push(`Der serielle Pfad ${path} kann sich nach einem Neustart auf andere Hardware beziehen. `
      + 'Empfohlen ist der gleichbleibende Pfad unter /dev/serial/by-id/….');
  }
  return {
    type,
    path,
    baudRate,
    rtscts: config.rtscts === true || config.rtscts === 'true',
    label: `Seriell ${path} @ ${baudRate}`,
    warnings,
  };
}

module.exports = {
  TRANSPORT_TYPES,
  resolveTransport,
  isStableSerialPath,
  normalizeHost,
  normalizePort,
  normalizeSerialPath,
};
