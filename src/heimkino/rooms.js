'use strict';

// Heimkino-Räume: frei benannte Räume mit je einem beschreibbaren Kinomodus.
// Der Schaltzustand jedes Raums steht als virtueller State
// (heimkino://raeume/<id>) im State-Bus und erscheint dadurch automatisch auf
// der States-Seite unter „System / Heimkino", im State-Picker und im
// Wertekatalog. Geschrieben werden darf er von überall (State-Write,
// Bedingungen, Dashboard-Schaltwidget); die Aktionsfolgen laufen dann über
// heimkino/runtime.js.

const { normalizeMqttTopic } = require('../mqtt/topics');

// Virtuelle States-Instanz: Schema + Instanzname der Raum-Topics.
const SCHEME = 'heimkino';
const INSTANCE = 'raeume';

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function done(err) {
    if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function validation(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

// Der Name ist zugleich der Anzeigename des States. Ein Schrägstrich würde dort
// als Kategorietrenner gelesen und ist deshalb ausgeschlossen.
function cleanName(value) {
  const name = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!name) throw validation('Bitte einen Namen für den Raum angeben.');
  if (name.length > 100) throw validation('Der Name darf höchstens 100 Zeichen lang sein.');
  if (name.includes('/')) throw validation('Der Name darf keinen Schrägstrich enthalten.');
  return name;
}

function normalizeRow(row = {}) {
  return {
    id: Number(row.id),
    name: row.name || '',
    position: Number(row.position || 0),
    cinemaOn: Number(row.cinema_on) === 1,
    // Optionales Sync-Topic: hält den Kinomodus bidirektional mit einem
    // externen Topic synchron (siehe heimkino/runtime.js).
    remoteTopic: row.remote_topic || '',
    lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
    lastResult: row.last_result || '',
    lastError: row.last_error || '',
  };
}

const SELECT_COLUMNS = 'id, name, position, cinema_on, remote_topic, last_run_at, last_result, last_error';

// Feste alphanumerische Sortierung nach Name (wie die Schaltgruppen): SQLite
// kennt keine alphanumerische Kollation, sonst stünde „Kino 10" vor „Kino 2".
async function listRooms(db) {
  const rows = await dbAll(db, `SELECT ${SELECT_COLUMNS} FROM heimkino_rooms`);
  return rows
    .map(normalizeRow)
    .sort((left, right) =>
      left.name.localeCompare(right.name, 'de', { numeric: true, sensitivity: 'base' }) || left.id - right.id);
}

async function getRoom(db, id) {
  const row = await dbGet(db, `SELECT ${SELECT_COLUMNS} FROM heimkino_rooms WHERE id = ?`, [Number(id)]);
  return row ? normalizeRow(row) : null;
}

async function createRoom(db, input = {}) {
  const name = cleanName(input.name);
  const remoteTopic = normalizeMqttTopic(input.remoteTopic || '');
  const next = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM heimkino_rooms');
  try {
    const result = await dbRun(db, 'INSERT INTO heimkino_rooms (name, position, remote_topic) VALUES (?, ?, ?)',
      [name, next.position, remoteTopic]);
    return getRoom(db, result.id);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Einen Raum mit diesem Namen gibt es bereits.');
    throw error;
  }
}

async function updateRoom(db, id, input = {}) {
  const roomId = Number(id);
  if (!(await getRoom(db, roomId))) throw validation('Raum nicht gefunden.');
  const name = cleanName(input.name);
  const remoteTopic = normalizeMqttTopic(input.remoteTopic || '');
  try {
    await dbRun(db, 'UPDATE heimkino_rooms SET name = ?, remote_topic = ? WHERE id = ?', [name, remoteTopic, roomId]);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Einen Raum mit diesem Namen gibt es bereits.');
    throw error;
  }
  return getRoom(db, roomId);
}

// Der Raum und seine gesamten Aktionsfolgen verschwinden gemeinsam.
async function deleteRoom(db, id) {
  const roomId = Number(id);
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    await dbRun(db, 'DELETE FROM heimkino_actions WHERE room_id = ?', [roomId]);
    const result = await dbRun(db, 'DELETE FROM heimkino_rooms WHERE id = ?', [roomId]);
    if (!result.changes) throw validation('Raum nicht gefunden.');
    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

// Der Kinomodus wird persistiert, damit er einen Neustart übersteht und die
// Aktionsfolgen nach dem Start nicht ins Leere prüfen.
async function setCinemaOn(db, id, on) {
  await dbRun(db, 'UPDATE heimkino_rooms SET cinema_on = ? WHERE id = ?', [on ? 1 : 0, Number(id)]);
}

async function markRun(db, id, result, error = '', at = Date.now()) {
  await dbRun(db, 'UPDATE heimkino_rooms SET last_run_at = ?, last_result = ?, last_error = ? WHERE id = ?',
    [at, String(result || ''), String(error || '').slice(0, 1000), Number(id)]);
}

// Cache-Schlüssel des abonnierten Sync-Topics eines Raums.
function remoteCacheKey(id) {
  return `heimkino:${id}:remote`;
}

// Kanonisches Scheme-Topic des Kinomodus. Über dieses Topic ist der Zustand
// lesbar (State-Bus) und beschreibbar (Schreiben startet die Aktionsfolge).
function stateTopic(id) {
  return `${SCHEME}://${INSTANCE}/${id}`;
}

function cachedOn(cache, room) {
  const cached = cache ? cache.get(stateTopic(room.id)) : null;
  if (!cached) return room.cinemaOn;
  const value = cached.value;
  return value === 1 || value === '1' || value === true || value === 'true';
}

// Block für die States-Liste (Form wie eine Adapter-Instanz): Kategorie
// „Heimkino" mit dem Kinomodus jedes Raums. Erscheint dadurch automatisch auf
// der States-Seite, im State-Picker und im Wertekatalog.
async function buildHeimkinoStatesBlock(db, cache) {
  const rooms = await listRooms(db);
  if (!rooms.length) return null;
  const states = rooms.map((room) => {
    const on = cachedOn(cache, room);
    return {
      address: String(room.id),
      name: room.name,
      catalogLabel: `Kinomodus ${room.name}`,
      topic: stateTopic(room.id),
      unit: '',
      writable: true,
      value: on ? 1 : 0,
      display: on ? 'Ein' : 'Aus',
    };
  });
  return {
    instanceId: 'heimkino',
    instanceName: INSTANCE,
    adapterId: null,
    adapterName: 'Heimkino',
    prefix: SCHEME,
    enabled: true,
    running: true,
    virtual: true,
    categories: [{ name: 'Heimkino', states, children: [], stateCount: states.length }],
  };
}

module.exports = {
  SCHEME, INSTANCE,
  listRooms, getRoom, createRoom, updateRoom, deleteRoom,
  setCinemaOn, markRun, stateTopic, remoteCacheKey, buildHeimkinoStatesBlock,
};
