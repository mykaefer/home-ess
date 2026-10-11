'use strict';

const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (e) { e ? reject(e) : resolve(this.changes); }));

async function discover(db, session) {
  await run(db, `INSERT INTO speech_endpoints (device_id, source, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET source = excluded.source, last_seen = excluded.last_seen`,
  [session.deviceId, session.source, Date.now()]);
}
function list(db) {
  return all(db, `SELECT e.*, r.name AS room_name FROM speech_endpoints e
    LEFT JOIN heizung_rooms r ON r.id = e.room_id ORDER BY e.name COLLATE NOCASE, e.device_id`);
}
async function update(db, deviceId, input) {
  const name = String(input.name || '').trim();
  const roomId = input.roomId ? Number(input.roomId) : null;
  const invalid = (message) => Object.assign(new Error(message), { validation: true });
  if (name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw invalid('Name ist ungültig (maximal 120 Zeichen).');
  if (roomId !== null && (!Number.isInteger(roomId) || !(await all(db, 'SELECT id FROM heizung_rooms WHERE id = ?', [roomId])).length)) {
    throw invalid('Raum nicht gefunden.');
  }
  if (!await run(db, 'UPDATE speech_endpoints SET name = ?, room_id = ? WHERE device_id = ?', [name, roomId, deviceId])) {
    throw invalid('Endpunkt nicht gefunden.');
  }
}
module.exports = { discover, list, update };
