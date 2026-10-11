'use strict';

const crypto = require('crypto');
const SCHEMA = `CREATE TABLE IF NOT EXISTS page_shares (
  path TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write'))
)`;
const get = (db, sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const run = (db, sql, params) => new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));

function forPath(db, path) { return get(db, 'SELECT path, token, mode FROM page_shares WHERE path = ?', [path]); }
function forToken(db, token) { return get(db, 'SELECT path, token, mode FROM page_shares WHERE token = ?', [token]); }
async function setMode(db, path, mode) {
  if (mode === 'none') {
    await run(db, 'DELETE FROM page_shares WHERE path = ?', [path]);
    return null;
  }
  // UPSERT bewahrt einen aktiven Link bei einem Wechsel read/write. Nach dem
  // Widerruf erzeugt erneutes Freigeben immer einen neuen Link.
  await run(db, `INSERT INTO page_shares (path, token, mode) VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET mode = excluded.mode`, [path, crypto.randomBytes(32).toString('hex'), mode]);
  return forPath(db, path);
}
module.exports = { SCHEMA, forPath, forToken, setMode };
