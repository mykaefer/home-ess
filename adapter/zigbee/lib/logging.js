'use strict';

// Brücke zwischen den Loggern von zigbee-herdsman / zigbee-herdsman-converters
// und der homeESS-Host-API — mit vorgeschalteter Redaktion.
//
// Die Bibliotheken geben in einigen Pfaden Netzwerkschlüssel im Klartext aus,
// etwa wenn Konfiguration und Coordinator nicht zusammenpassen. Solche Werte
// dürfen niemals in der homeESS-Konsole landen. Es wird deshalb nicht nur der
// eigene Schlüssel ausgefiltert, sondern jede Zeichenfolge, die überhaupt wie
// Schlüsselmaterial aussieht.

const REDACTED = '«entfernt»';

// 16 Byte Schlüsselmaterial: als zusammenhängender Hexstring oder als
// Byteliste in Dezimal-/Hexschreibweise, wie sie herdsman ebenfalls ausgibt.
const HEX_KEY_RE = /\b(?:0x)?[0-9a-fA-F]{32}\b/g;
const BYTE_LIST_RE = /\[(?:\s*(?:0x[0-9a-fA-F]{1,2}|\d{1,3})\s*,){15}\s*(?:0x[0-9a-fA-F]{1,2}|\d{1,3})\s*\]/g;
const LABELLED_RE = /((?:network[\s_-]?key|nwk[\s_-]?key|precfg[\s_-]?key|preconfigured[\s_-]?key|link[\s_-]?key|security[\s_-]?key|tclk)\s*[:=]\s*)(\S+)/gi;

/**
 * Entfernt Zigbee-Schlüsselmaterial aus einem Text.
 * @param {unknown} value beliebiger Logtext
 * @param {string[]} extraSecrets zusätzlich zu entfernende Klartextwerte
 */
function redact(value, extraSecrets = []) {
  let text = String(value == null ? '' : value);
  for (const secret of extraSecrets) {
    const raw = String(secret == null ? '' : secret).trim();
    if (raw.length < 8) continue;
    text = text.split(raw).join(REDACTED);
    const withoutPrefix = raw.replace(/^0x/i, '');
    if (withoutPrefix !== raw && withoutPrefix.length >= 8) text = text.split(withoutPrefix).join(REDACTED);
  }
  text = text.replace(LABELLED_RE, (_match, label) => `${label}${REDACTED}`);
  text = text.replace(BYTE_LIST_RE, REDACTED);
  // Die IEEE-Adresse ist 16 Hexziffern lang und damit nicht betroffen; erst
  // 32 Hexziffern entsprechen einem 128-Bit-Schlüssel.
  text = text.replace(HEX_KEY_RE, REDACTED);
  return text;
}

/**
 * Erzeugt den Logger, den zigbee-herdsman und die Converter erwarten, und
 * leitet ihn auf die Host-API um. Debugausgaben der Bibliotheken sind sehr
 * gesprächig und gehen deshalb ausschließlich in das homeESS-Debuglog.
 */
function createLibraryLogger(host, getSecrets) {
  const secrets = typeof getSecrets === 'function' ? getSecrets : () => [];
  const write = (level, message, namespace) => {
    try {
      const text = redact(message, secrets());
      const line = namespace ? `[${namespace}] ${text}` : text;
      if (level === 'error') host.error(line);
      else if (level === 'warning') host.warn(line);
      else if (level === 'info') host.debug(line);
      else host.debug(line);
    } catch (_) {
      // Ein fehlschlagender Logaufruf darf den Adapter niemals beenden.
    }
  };
  return {
    debug: (message, namespace) => write('debug', message, namespace),
    info: (message, namespace) => write('info', message, namespace),
    warning: (message, namespace) => write('warning', message, namespace),
    error: (message, namespace) => write('error', message, namespace),
  };
}

module.exports = { redact, createLibraryLogger, REDACTED };
