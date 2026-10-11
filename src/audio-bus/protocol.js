'use strict';

// Control-Messages des Audio-Bus-WebSockets (JSON-Textframes). Audio selbst
// läuft ausschließlich als Binärframe — nie Base64 in JSON.
//
// Client → Server:
//   { type: 'audio.start', device_id, source, room?, codec, sample_rate, channels, metadata? }
//   { type: 'audio.end', session_id }
//   { type: 'ping' }
// Server → Client:
//   audio.started, audio.ended, audio.output.start, audio.output.end,
//   audio.error, pong
//
// Alle Felder eines Clients sind Clientangaben. Die authentifizierte
// Identität setzt ausschließlich der Server.

const MAX_CONTROL_BYTES = 4096;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const METADATA_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_ROOM_LENGTH = 64;
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_VALUE_LENGTH = 256;
// Steuerzeichen (inkl. DEL) sind in Klartextfeldern nicht erlaubt.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const CLIENT_TYPES = Object.freeze(['audio.start', 'audio.end', 'ping']);

function invalid(code, message) {
  return { ok: false, code, message };
}

// Textframe → Objekt. Ergebnis: { ok: true, message } | { ok: false, code, message }
function parseControl(text) {
  const raw = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_BYTES) {
    return invalid('message_too_large', `Control-Message zu groß (höchstens ${MAX_CONTROL_BYTES} Bytes).`);
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch (_) {
    return invalid('invalid_json', 'Control-Message ist kein gültiges JSON.');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return invalid('invalid_message', 'Control-Message muss ein JSON-Objekt sein.');
  }
  if (typeof message.type !== 'string' || !CLIENT_TYPES.includes(message.type)) {
    return invalid('unknown_type', `Unbekannter Nachrichtentyp. Erlaubt: ${CLIENT_TYPES.join(', ')}.`);
  }
  return { ok: true, message };
}

function validateMetadata(value) {
  if (value == null) return { ok: true, metadata: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_metadata', 'metadata muss ein Objekt sein.');
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_KEYS) return invalid('invalid_metadata', `metadata darf höchstens ${MAX_METADATA_KEYS} Schlüssel enthalten.`);
  const metadata = {};
  for (const [key, item] of entries) {
    if (!METADATA_KEY_RE.test(key)) return invalid('invalid_metadata', 'metadata enthält einen ungültigen Schlüssel.');
    if (typeof item === 'string') {
      if (item.length > MAX_METADATA_VALUE_LENGTH || CONTROL_CHARS_RE.test(item)) {
        return invalid('invalid_metadata', 'metadata enthält einen ungültigen Text.');
      }
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid('invalid_metadata', 'metadata enthält eine ungültige Zahl.');
    } else if (typeof item !== 'boolean') {
      return invalid('invalid_metadata', 'metadata erlaubt nur Texte, Zahlen und Wahrheitswerte.');
    }
    metadata[key] = item;
  }
  return { ok: true, metadata };
}

// audio.start prüfen. Format (Codec/Samplerate/Kanäle) prüft der Bus über
// formats.js; hier nur die Typen. Ergebnis: { ok: true, params } | Fehler.
function validateStart(message) {
  const { device_id: deviceId, source, room, codec, sample_rate: sampleRate, channels } = message;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    return invalid('invalid_device_id', 'device_id fehlt oder ist ungültig (1–128 Zeichen: A–Z, a–z, 0–9, . _ : @ -).');
  }
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    return invalid('invalid_source', 'source fehlt oder ist ungültig (1–64 Zeichen: A–Z, a–z, 0–9, . _ -).');
  }
  let normalizedRoom = null;
  if (room != null && room !== '') {
    if (typeof room !== 'string') return invalid('invalid_room', 'room muss ein Text sein.');
    normalizedRoom = room.trim();
    if (!normalizedRoom || normalizedRoom.length > MAX_ROOM_LENGTH || CONTROL_CHARS_RE.test(normalizedRoom)) {
      return invalid('invalid_room', `room ist ungültig (höchstens ${MAX_ROOM_LENGTH} Zeichen, keine Steuerzeichen).`);
    }
  }
  if (typeof codec !== 'string') return invalid('unsupported_codec', 'codec fehlt.');
  if (!Number.isInteger(sampleRate)) return invalid('invalid_sample_rate', 'sample_rate fehlt oder ist keine ganze Zahl.');
  if (!Number.isInteger(channels)) return invalid('invalid_channels', 'channels fehlt oder ist keine ganze Zahl.');
  const metadata = validateMetadata(message.metadata);
  if (!metadata.ok) return metadata;
  return {
    ok: true,
    params: { deviceId, source, room: normalizedRoom, codec, sampleRate, channels, metadata: metadata.metadata },
  };
}

function validateEnd(message) {
  if (typeof message.session_id !== 'string' || !message.session_id || message.session_id.length > 64) {
    return invalid('invalid_session_id', 'session_id fehlt oder ist ungültig.');
  }
  return { ok: true, sessionId: message.session_id };
}

module.exports = { MAX_CONTROL_BYTES, CLIENT_TYPES, parseControl, validateStart, validateEnd, validateMetadata };
