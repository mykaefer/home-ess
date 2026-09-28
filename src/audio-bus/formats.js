'use strict';

// Audioformate des Audio Bus. Der Bus transportiert und routet nur — er
// transcodiert nicht. Ein Format beschreibt deshalb lediglich, was im Strom
// steckt (Codec, Samplerate, Kanäle), und liefert die Regeln, mit denen der Bus
// Frames plausibel prüfen kann (z. B. ganze Samples bei PCM).
//
// Neue Codecs (z. B. Opus) werden hier ergänzt; Protokoll, Sessions und
// Plugin-API bleiben davon unberührt.

const CODECS = Object.freeze({
  pcm_s16le: Object.freeze({
    label: 'PCM signed 16 Bit little endian',
    sampleRates: Object.freeze([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]),
    maxChannels: 2,
    // Bytes je Sample und Kanal. Ein Frame muss ganze Sample-Gruppen
    // (bytesPerSample × Kanäle) enthalten.
    bytesPerSample: 2,
  }),
});

const DEFAULT_FORMAT = Object.freeze({ codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });

function formatError(code, message) {
  return { ok: false, code, message };
}

// Format aus Protokollfeldern prüfen (codec, sample_rate, channels).
// Ergebnis: { ok: true, format: { codec, sampleRate, channels } }
//        oder { ok: false, code, message }
function validateFormat({ codec, sampleRate, channels } = {}) {
  if (typeof codec !== 'string' || !Object.prototype.hasOwnProperty.call(CODECS, codec)) {
    return formatError('unsupported_codec', `Nicht unterstützter Codec. Erlaubt: ${Object.keys(CODECS).join(', ')}.`);
  }
  const spec = CODECS[codec];
  if (!Number.isInteger(sampleRate) || !spec.sampleRates.includes(sampleRate)) {
    return formatError('invalid_sample_rate', `Nicht unterstützte Samplerate. Erlaubt: ${spec.sampleRates.join(', ')}.`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > spec.maxChannels) {
    return formatError('invalid_channels', `Ungültige Kanalzahl. Erlaubt: 1 bis ${spec.maxChannels}.`);
  }
  return { ok: true, format: Object.freeze({ codec, sampleRate, channels }) };
}

// Kleinste Einheit, in der ein Frame dieses Formats teilbar sein muss (Bytes).
// 1 bedeutet: keine Ausrichtung prüfbar.
function frameAlignment(format) {
  const spec = format && CODECS[format.codec];
  if (!spec || !spec.bytesPerSample) return 1;
  return spec.bytesPerSample * format.channels;
}

function isAlignedFrame(format, length) {
  return length > 0 && length % frameAlignment(format) === 0;
}

module.exports = { CODECS, DEFAULT_FORMAT, validateFormat, frameAlignment, isAlignedFrame };
