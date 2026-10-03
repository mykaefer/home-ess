'use strict';
const DEFAULT_MAX_SESSIONS = 16;
const MAX_SESSIONS = 256;
function normalize(value) {
  if (!['string', 'number'].includes(typeof value) || !String(value).trim() || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > MAX_SESSIONS) {
    throw Object.assign(new Error('Bitte eine Session-Anzahl zwischen 1 und 256 eingeben.'), { validation: true });
  }
  return Number(value);
}
const connectionLimit = (value) => Math.max(32, normalize(value) * 2);
function load(db) {
  return new Promise((resolve, reject) => db.get('SELECT max_sessions FROM audio_bus_config WHERE id = 1', (error, row) => {
    if (error) return reject(error);
    try { resolve(row ? normalize(row.max_sessions) : DEFAULT_MAX_SESSIONS); } catch (error) { reject(error); }
  }));
}
async function save(db, value) {
  const count = normalize(value);
  await new Promise((resolve, reject) => db.run('INSERT INTO audio_bus_config (id, max_sessions) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET max_sessions = excluded.max_sessions', [count], (error) => error ? reject(error) : resolve()));
  return count;
}
module.exports = { DEFAULT_MAX_SESSIONS, MAX_SESSIONS, normalize, connectionLimit, load, save };
