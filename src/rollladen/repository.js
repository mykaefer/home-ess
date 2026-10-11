'use strict';

const { normalizeMqttTopic } = require('../mqtt/topics');
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows)));
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve(this.lastID); }));
function invalid(message) { return Object.assign(new Error(message), { validation: true }); }
async function list(db) {
  return (await all(db, 'SELECT * FROM rollladen ORDER BY name COLLATE NOCASE, id')).map(row => ({ id: row.id, roomId: row.room_id, ...JSON.parse(row.config) }));
}
async function policies(db) {
  return new Map((await all(db, 'SELECT * FROM rollladen_rooms')).map(row => [row.room_id, { brightness: row.brightness, memory: JSON.parse(row.memory) }]));
}
async function requireRoom(db, id) {
  if (!Number.isInteger(Number(id)) || !(await all(db, 'SELECT id FROM heizung_rooms WHERE id = ?', [id])).length) throw invalid('Bitte einen vorhandenen Raum auswählen.');
}
function number(value, min, max, label) {
  const n = value == null || String(value).trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(`Ungültiger Wert für ${label}.`);
  return n;
}
async function save(db, id, input) {
  const newRoomName = String(input.newRoomName || '').trim();
  if (!newRoomName) await requireRoom(db, input.roomId);
  const config = { name: String(input.name || '').trim(), orientation: number(input.orientation, 0, 359, 'Himmelsrichtung'),
    openValue: number(input.positionTopic ? (input.openValue ?? 0) : 0, 0, 100, 'Position offen'), closedValue: number(input.positionTopic ? (input.closedValue ?? 100) : 100, 0, 100, 'Position geschlossen'),
    shadePercent: input.positionTopic ? number(input.shadePercent ?? 100, 0, 100, 'Sonnenschutzposition') : 100,
    upValue: String(input.upValue ?? 'true'), downValue: String(input.downValue ?? 'true'),
    contactOpenValue: String(input.contactOpenValue ?? 'true'), travelSeconds: number(input.travelSeconds ?? 60, 10, 180, 'Fahrzeit') };
  if (!config.name || config.name.length > 100) throw invalid('Bitte einen Namen mit höchstens 100 Zeichen angeben.');
  if (config.openValue === config.closedValue) throw invalid('Offene und geschlossene Position müssen verschieden sein.');
  for (const key of ['upTopic', 'downTopic', 'positionTopic', 'positionFeedbackTopic', 'contactTopic']) config[key] = normalizeMqttTopic(input[key] || '');
  if (config.positionFeedbackTopic && !config.positionTopic) throw invalid('Ein Positions-Istwert benötigt auch einen Prozent-State zum Fahren.');
  if (!config.positionTopic && !(config.upTopic && config.downTopic)) throw invalid('Bitte Hoch und Runter zusammen oder einen Prozent-State auswählen.');
  const existing = await list(db);
  if (id && !existing.some(s => s.id === Number(id))) throw invalid('Rollladen nicht gefunden.');
  if (existing.some(s => s.id !== Number(id) && ['upTopic', 'downTopic', 'positionTopic'].some(k => s[k] && [config.upTopic, config.downTopic, config.positionTopic].includes(s[k])))) throw invalid('Dieser Aktor wird bereits von einem anderen Rollladen verwendet.');
  let roomId = Number(input.roomId);
  if (newRoomName) {
    const room = await require('../heizung/rooms').createRoom(db, { name: newRoomName });
    roomId = room.id;
  }
  if (id) await run(db, 'UPDATE rollladen SET name = ?, room_id = ?, config = ? WHERE id = ?', [config.name, roomId, JSON.stringify(config), id]);
  else id = await run(db, 'INSERT INTO rollladen (name, room_id, config) VALUES (?, ?, ?)', [config.name, roomId, JSON.stringify(config)]);
  return id;
}
async function savePolicy(db, roomId, brightness) {
  await requireRoom(db, roomId);
  await run(db, 'INSERT INTO rollladen_rooms (room_id, brightness) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET brightness=excluded.brightness', [roomId, number(brightness, 0, 100, 'Resthelligkeit')]);
}
async function remember(db, roomId, memory) {
  await run(db, 'INSERT INTO rollladen_rooms (room_id, memory) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET memory=excluded.memory', [roomId, JSON.stringify(memory)]);
}
async function setCinemaRoom(db, cinemaId, roomId) {
  if (roomId) await requireRoom(db, roomId);
  await run(db, 'DELETE FROM rollladen_cinema WHERE cinema_id = ?', [cinemaId]);
  if (roomId) await run(db, 'INSERT INTO rollladen_cinema (cinema_id, room_id) VALUES (?, ?)', [cinemaId, roomId]);
}
module.exports = { requireRoom, all, run, list, policies, save, savePolicy, remember, setCinemaRoom };
