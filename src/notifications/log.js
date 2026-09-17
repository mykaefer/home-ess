'use strict';

// Strukturiertes Logging des Nachrichtensystems.
//
// Geloggt werden ausschließlich Metadaten: Regel-ID, Ereignistyp, Priorität,
// Empfängeranzahl und Grund. Niemals der Nachrichtentext, niemals Push-Token,
// niemals personenbezogene Inhalte — der Nachrichtentext kann frei formuliert
// sein und damit private Angaben enthalten.

// Felder, die das Log verlassen dürfen. Alles andere wird verworfen, auch wenn
// ein Aufrufer versehentlich mehr übergibt.
const ALLOWED_KEYS = new Set(['ruleId', 'eventType', 'severity', 'recipients', 'reason', 'stateId', 'triggerType']);

function safeMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (!ALLOWED_KEYS.has(key) || value == null) continue;
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return out;
}

function log(event, meta) {
  const safe = safeMeta(meta);
  const suffix = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[notifications] ${event}${suffix}`);
}

module.exports = { log, safeMeta };
