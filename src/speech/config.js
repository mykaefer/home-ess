'use strict';

const DEFAULTS = Object.freeze({ volumePercent: 70, leadMs: 1000, tailMs: 1000, chunkMs: 50 });
const CHUNK_SIZES = Object.freeze([10, 20, 50, 100]);
const invalid = (message) => Object.assign(new Error(message), { validation: true });

function normalize(input = {}) {
  const result = {};
  for (const [key, min, max] of [['volumePercent', 10, 100], ['leadMs', 100, 5000], ['tailMs', 0, 5000], ['chunkMs', 10, 100]]) {
    const raw = input[key];
    if (!['string', 'number'].includes(typeof raw) || String(raw).trim() === '') throw invalid('Bitte gültige Wiedergabeeinstellungen eingeben.');
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw invalid('Bitte gültige Wiedergabeeinstellungen eingeben.');
    result[key] = value;
  }
  if (!CHUNK_SIZES.includes(result.chunkMs)) throw invalid('Bitte gültige Wiedergabeeinstellungen eingeben.');
  return result;
}

function get(db) {
  return new Promise((resolve, reject) => db.get('SELECT * FROM speech_config WHERE id = 1', (error, row) => {
    if (error) return reject(error);
    try {
      resolve(row ? normalize({ volumePercent: row.volume_percent, leadMs: row.lead_ms, tailMs: row.tail_ms, chunkMs: row.chunk_ms }) : { ...DEFAULTS });
    } catch (error) { reject(error); }
  }));
}
async function save(db, input) {
  const value = normalize(input);
  await new Promise((resolve, reject) => db.run(`INSERT INTO speech_config (id, volume_percent, lead_ms, tail_ms, chunk_ms)
    VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET volume_percent = excluded.volume_percent,
    lead_ms = excluded.lead_ms, tail_ms = excluded.tail_ms, chunk_ms = excluded.chunk_ms`,
  [value.volumePercent, value.leadMs, value.tailMs, value.chunkMs], (error) => error ? reject(error) : resolve()));
  return value;
}
module.exports = { DEFAULTS, CHUNK_SIZES, normalize, get, save };
