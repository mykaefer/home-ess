'use strict';

// Umwandlung zwischen MQTT-Nutzlast (Bytes) und homeESS-Werten (Zahl, Boolean,
// String). Reine Funktionen ohne Zustand.

const TRUE_WORDS = new Set(['true', 'on', 'an', 'ein', 'ja', 'yes']);
const FALSE_WORDS = new Set(['false', 'off', 'aus', 'nein', 'no']);
const MAX_TEXT_LENGTH = 4096;

// Zahl/Boolean aus einem Text ableiten; sonst den Text selbst.
function coerceText(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return '';
  if (TRUE_WORDS.has(value.toLowerCase())) return true;
  if (FALSE_WORDS.has(value.toLowerCase())) return false;
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value.slice(0, MAX_TEXT_LENGTH);
}

// MQTT-Nutzlast in einen homeESS-Wert überführen. Mit `json` wird eine
// JSON-Hülle {"val": …} ausgepackt; skalare JSON-Werte ebenso.
function decodePayload(payload, options = {}) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload == null ? '' : payload);
  const trimmed = text.trim();
  if (options.json !== false && trimmed && /^[[{"]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (Object.prototype.hasOwnProperty.call(parsed, 'val')) {
          const inner = parsed.val;
          if (inner == null) return null;
          if (typeof inner === 'object') return JSON.stringify(inner).slice(0, MAX_TEXT_LENGTH);
          return typeof inner === 'string' ? coerceText(inner) : inner;
        }
        return trimmed.slice(0, MAX_TEXT_LENGTH);
      }
      if (typeof parsed === 'string') return coerceText(parsed);
      if (typeof parsed === 'number' || typeof parsed === 'boolean') return parsed;
      if (parsed === null) return null;
      return trimmed.slice(0, MAX_TEXT_LENGTH);
    } catch (_) {
      /* kein JSON – als Text weiterbehandeln */
    }
  }
  return coerceText(text);
}

// homeESS-Wert als MQTT-Nutzlast. Booleans bleiben true/false, Objekte werden
// als JSON gesendet; null wird zur leeren Nutzlast (löscht Retained Messages).
function encodeValue(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') {
    try {
      return Buffer.from(JSON.stringify(value), 'utf8');
    } catch (_) {
      return Buffer.from(String(value), 'utf8');
    }
  }
  return Buffer.from(String(value), 'utf8');
}

module.exports = { decodePayload, encodeValue, coerceText };
