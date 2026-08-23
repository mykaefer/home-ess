'use strict';

// Heizung & Klima: Räume, ihre Temperaturquellen und ihre Fenster-/Türkontakte.
//
// Jeder Raum hat eine eigene Soll-Temperatur und eigene Schaltschwellen. Die
// Ist-Temperatur entsteht aus allen zugeordneten Temperaturquellen (HDP-Sensor,
// Thermostat-Ist, beliebiger State); bei mehreren Quellen zählt ihr
// Durchschnitt. Die Geräte zum Heizen und Kühlen hängen an Aktionsfolgen
// (heizung/actions.js), die Freigabe der Zentralheizung an einem Häkchen —
// alles optional: ohne sie erfasst der Raum nur seine Temperatur und stellt sie
// als State bereit.
//
// Heizung & Klima ist ein Modul und kein Adapter — seine Werte sind deshalb
// homeESS-Systemwerte und stehen unter `system://`. Auf der States-Seite liegen
// sie im Ordner **Räume** mit einem Unterordner je Raum, benannt nach dem Raum:
//
//   System / Räume / Wohnzimmer / Temperatur
//   system://homeess/raeume.Wohnzimmer.temperatur
//
// Beschreibbar ist die Soll-Temperatur; die übrigen Werte sind Messwerte bzw.
// Ergebnisse der Regelung (siehe heizung/runtime.js). Weil der Name in der id
// steht, ändert ein Umbenennen die Topics des Raums — darauf weist die
// Oberfläche hin.

const { normalizeMqttTopic } = require('../mqtt/topics');
const { topicForId } = require('../states/system-topics');
const { checkboxValue } = require('../conditions/values');

// Systemwerte der Räume: id-Präfix und Ordner auf der States-Seite.
const ID_PREFIX = 'raeume.';
const CATEGORY = 'Räume';

// Grenzen der Eingabefelder. Sie schützen nur vor Tippfehlern — innerhalb
// dieser Grenzen bleibt jeder eingestellte Wert unverändert stehen.
const MIN_TEMP = -20;
const MAX_TEMP = 40;
const MAX_OFFSET = 20;
const MIN_HYSTERESIS = 0.1;
const MAX_HYSTERESIS = 5;
const MAX_CONTACT_DELAY_SECONDS = 3600;
// Priorität = Betriebslevel, ab dem das Gerät laufen darf (siehe LEVEL_HANDLING.md).
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 5;
// Plausibilitätsfenster einer Temperaturquelle: Werte außerhalb gelten als
// Störung und fließen nicht in den Durchschnitt ein.
const PLAUSIBLE_MIN = -60;
const PLAUSIBLE_MAX = 120;

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

function text(value) {
  return String(value == null ? '' : value).trim();
}

// Kommazahlen dürfen mit Komma oder Punkt eingegeben werden.
function toNumber(value) {
  const raw = text(value).replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

// Priorität 1–5 (1 = höchste). Ein leeres Feld behält die Vorgabe.
function priority(value, fallback, label) {
  if (text(value) === '') return fallback;
  const number = toNumber(value);
  if (number == null || !Number.isInteger(number) || number < MIN_PRIORITY || number > MAX_PRIORITY) {
    throw validation(`Bitte ${label} zwischen ${MIN_PRIORITY} und ${MAX_PRIORITY} angeben.`);
  }
  return number;
}

function requireNumber(value, label, min, max) {
  const number = toNumber(value);
  if (number == null) throw validation(`Bitte ${label} als Zahl angeben.`);
  if (number < min || number > max) throw validation(`${label} muss zwischen ${min} und ${max} liegen.`);
  return number;
}

// Der Name ist zugleich der Anzeigename der States. Ein Schrägstrich würde dort
// als Kategorietrenner gelesen und ist deshalb ausgeschlossen.
function cleanName(value) {
  const name = text(value).replace(/\s+/g, ' ');
  if (!name) throw validation('Bitte einen Namen für den Raum angeben.');
  if (name.length > 100) throw validation('Der Name darf höchstens 100 Zeichen lang sein.');
  if (name.includes('/')) throw validation('Der Name darf keinen Schrägstrich enthalten.');
  return name;
}

function cleanLabel(value, fallback) {
  const label = text(value).replace(/\s+/g, ' ');
  if (!label) return fallback;
  if (label.length > 100) throw validation('Die Bezeichnung darf höchstens 100 Zeichen lang sein.');
  return label;
}

// Adresse eines Raums in der State-id. Punkte trennen in einer id die Ebenen,
// Leerraum und Schrägstrich sind dort ebenfalls unerwünscht — sie werden alle
// zum Unterstrich.
function addressFor(name) {
  return text(name).replace(/[\s._/\\]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeRoom(row = {}) {
  return {
    id: Number(row.id),
    name: row.name || '',
    position: Number(row.position || 0),
    // Soll-Temperatur des Raums.
    targetTemp: Number(row.target_temp),
    // Heizen schaltet ein bei Soll minus Offset, Kühlen bei Soll plus Offset.
    heatOffset: Number(row.heat_offset),
    coolOffset: Number(row.cool_offset),
    // Absolute Untergrenze fürs Kühlen: darunter wird nie gekühlt, egal wie
    // niedrig die Soll-Temperatur gerade steht (Nachtabsenkung am Thermostat).
    coolMinTemp: row.cool_min_temp == null ? null : Number(row.cool_min_temp),
    // Schalthysterese gegen Takten: sie gilt für Heizen, Kühlen und die
    // Wärmeanforderung an die Zentralheizung gleichermaßen.
    hysteresis: Number(row.hysteresis),
    // Optionales Thermostat: hält die Soll-Temperatur bidirektional synchron.
    thermostatTopic: row.thermostat_topic || '',
    // Betriebslevel, ab dem das jeweilige lokale Gerät laufen darf.
    heatPriority: row.heat_priority == null ? 2 : Number(row.heat_priority),
    coolPriority: row.cool_priority == null ? 4 : Number(row.cool_priority),
    // Springt die Zentralheizung ein, wenn das Betriebslevel das lokale
    // Heizgerät sperrt? Dann gilt für diesen Raum solange keine
    // Außentemperaturgrenze.
    heatCentralFallback: Number(row.heat_central_fallback) === 1,
    // Freigabe der Zentralheizung und die **Außentemperatur**, unterhalb derer
    // sie den Raum anstelle des lokalen Gerätes versorgt.
    centralAllowed: Number(row.central_allowed) === 1,
    centralTemp: row.central_temp == null ? null : Number(row.central_temp),
    // Optionaler Heizkörperlüfter: läuft, solange der Raum Wärme von der
    // Zentralheizung anfordert.
    fanTopic: row.fan_topic || '',
    // Verzögerung, bevor ein offener Kontakt Heizen/Kühlen abschaltet
    // (0 = sofort).
    contactDelaySeconds: Number(row.contact_delay_seconds || 0),
    lastError: row.last_error || '',
  };
}

function normalizeSensor(row = {}) {
  return {
    id: Number(row.id),
    roomId: Number(row.room_id),
    name: row.name || '',
    topic: row.topic || '',
    position: Number(row.position || 0),
  };
}

function normalizeContact(row = {}) {
  return {
    id: Number(row.id),
    roomId: Number(row.room_id),
    name: row.name || '',
    topic: row.topic || '',
    // Manche Kontakte melden 1 = geschlossen; dann wird die Auswertung gedreht.
    inverted: Number(row.inverted) === 1,
    position: Number(row.position || 0),
  };
}

const ROOM_COLUMNS = `id, name, position, target_temp, heat_offset, cool_offset, cool_min_temp, hysteresis,
  thermostat_topic, heat_priority, cool_priority, heat_central_fallback,
  central_allowed, central_temp, fan_topic, contact_delay_seconds, last_error`;

// Zwei Namen dürfen nicht auf dieselbe State-Adresse fallen („Bad 1" und
// „Bad_1" wären dasselbe Topic). Geprüft wird gegen alle übrigen Räume.
async function ensureFreeAddress(db, name, exceptId = null) {
  const address = addressFor(name);
  if (!address) throw validation('Der Name muss mindestens ein Zeichen enthalten, das im State-Topic stehen kann.');
  const rows = await dbAll(db, 'SELECT id, name FROM heizung_rooms WHERE id IS NOT ?', [exceptId == null ? -1 : Number(exceptId)]);
  // Ein gleicher Name ist keine Adress-Kollision, sondern ein doppelter Name —
  // dafür meldet sich die UNIQUE-Bedingung mit ihrer eigenen Meldung.
  const clash = rows.find((row) => row.name.toLowerCase() !== text(name).toLowerCase()
    && addressFor(row.name).toLowerCase() === address.toLowerCase());
  if (clash) throw validation(`„${clash.name}" belegt bereits die States ${topicForId(`${ID_PREFIX}${address}`)}.…`);
  return address;
}

// Feste alphanumerische Sortierung nach Name (wie Heimkino und Schaltgruppen):
// SQLite kennt keine alphanumerische Kollation, sonst stünde „Zimmer 10" vor
// „Zimmer 2".
function byName(left, right) {
  return left.name.localeCompare(right.name, 'de', { numeric: true, sensitivity: 'base' }) || left.id - right.id;
}

async function listRooms(db) {
  const rows = await dbAll(db, `SELECT ${ROOM_COLUMNS} FROM heizung_rooms`);
  return rows.map(normalizeRoom).sort(byName);
}

async function getRoom(db, id) {
  const row = await dbGet(db, `SELECT ${ROOM_COLUMNS} FROM heizung_rooms WHERE id = ?`, [Number(id)]);
  return row ? normalizeRoom(row) : null;
}

// Eingaben eines Raum-Dialogs prüfen. Eingestellte Werte werden nie
// stillschweigend zurechtgebogen. Die Grenztemperatur der Zentralheizung ist
// eine **Außentemperatur** und steht damit in keinem Zwangsverhältnis zur
// Soll-Temperatur des Raums.
function cleanRoomInput(input = {}) {
  const centralAllowed = checkboxValue(input.centralAllowed);
  const centralTempRaw = text(input.centralTemp);
  const targetTemp = requireNumber(input.targetTemp, 'die Soll-Temperatur', MIN_TEMP, MAX_TEMP);
  const values = {
    name: cleanName(input.name),
    targetTemp,
    heatOffset: requireNumber(input.heatOffset == null || text(input.heatOffset) === '' ? 0 : input.heatOffset,
      'den Offset zum Heizen', 0, MAX_OFFSET),
    coolOffset: requireNumber(input.coolOffset == null || text(input.coolOffset) === '' ? 0 : input.coolOffset,
      'den Offset zum Kühlen', 0, MAX_OFFSET),
    // Leer = keine Untergrenze; dann zählt allein Soll plus Offset.
    coolMinTemp: text(input.coolMinTemp) === ''
      ? null
      : requireNumber(input.coolMinTemp, 'die Mindesttemperatur zum Kühlen', MIN_TEMP, MAX_TEMP),
    hysteresis: requireNumber(text(input.hysteresis) === '' ? 0.5 : input.hysteresis,
      'die Schalthysterese', MIN_HYSTERESIS, MAX_HYSTERESIS),
    thermostatTopic: normalizeMqttTopic(input.thermostatTopic || ''),
    heatPriority: priority(input.heatPriority, 2, 'die Priorität des Heizgerätes'),
    coolPriority: priority(input.coolPriority, 4, 'die Priorität des Kühlgerätes'),
    heatCentralFallback: checkboxValue(input.heatCentralFallback),
    fanTopic: normalizeMqttTopic(input.fanTopic || ''),
    centralAllowed,
    centralTemp: null,
    contactDelaySeconds: Math.round(requireNumber(
      input.contactDelaySeconds == null || text(input.contactDelaySeconds) === '' ? 0 : input.contactDelaySeconds,
      'die Verzögerung der Kontakte', 0, MAX_CONTACT_DELAY_SECONDS
    )),
  };
  // Die Ersatzschaltung setzt voraus, dass der Raum die Zentralheizung
  // überhaupt anfordern darf.
  if (values.heatCentralFallback && !centralAllowed) {
    throw validation('Die Zentralheizung darf nur einspringen, wenn der Raum sie anfordern darf.');
  }
  if (centralAllowed && !centralTempRaw) {
    throw validation('Bitte die Außentemperatur angeben, unterhalb derer die Zentralheizung den Raum versorgt.');
  }
  if (centralTempRaw) {
    values.centralTemp = requireNumber(centralTempRaw, 'die Grenz-Außentemperatur', MIN_TEMP, MAX_TEMP);
  }
  return values;
}

async function createRoom(db, input = {}) {
  const values = cleanRoomInput(input);
  await ensureFreeAddress(db, values.name);
  const next = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM heizung_rooms');
  try {
    const result = await dbRun(db, `INSERT INTO heizung_rooms
      (name, position, target_temp, heat_offset, cool_offset, cool_min_temp, hysteresis, thermostat_topic,
       heat_priority, cool_priority, heat_central_fallback,
       central_allowed, central_temp, fan_topic, contact_delay_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      values.name, next.position, values.targetTemp, values.heatOffset, values.coolOffset,
      values.coolMinTemp, values.hysteresis,
      values.thermostatTopic, values.heatPriority, values.coolPriority, values.heatCentralFallback ? 1 : 0,
      values.centralAllowed ? 1 : 0, values.centralTemp, values.fanTopic, values.contactDelaySeconds,
    ]);
    return getRoom(db, result.id);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Einen Raum mit diesem Namen gibt es bereits.');
    throw error;
  }
}

async function updateRoom(db, id, input = {}) {
  const roomId = Number(id);
  if (!(await getRoom(db, roomId))) throw validation('Raum nicht gefunden.');
  const values = cleanRoomInput(input);
  await ensureFreeAddress(db, values.name, roomId);
  try {
    await dbRun(db, `UPDATE heizung_rooms SET name = ?, target_temp = ?, heat_offset = ?, cool_offset = ?,
      cool_min_temp = ?, hysteresis = ?, thermostat_topic = ?, heat_priority = ?, cool_priority = ?,
      heat_central_fallback = ?, central_allowed = ?, central_temp = ?, fan_topic = ?,
      contact_delay_seconds = ? WHERE id = ?`, [
      values.name, values.targetTemp, values.heatOffset, values.coolOffset,
      values.coolMinTemp, values.hysteresis,
      values.thermostatTopic, values.heatPriority, values.coolPriority, values.heatCentralFallback ? 1 : 0,
      values.centralAllowed ? 1 : 0, values.centralTemp, values.fanTopic, values.contactDelaySeconds, roomId,
    ]);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT') throw validation('Einen Raum mit diesem Namen gibt es bereits.');
    throw error;
  }
  return getRoom(db, roomId);
}

// Soll-Temperatur allein setzen (State-Schreibzugriff, Thermostat-Kopplung,
// Schnellverstellung in der Oberfläche). Die übrigen Einstellungen des Raums
// bleiben unangetastet.
async function setTargetTemp(db, id, value) {
  const target = requireNumber(value, 'die Soll-Temperatur', MIN_TEMP, MAX_TEMP);
  const result = await dbRun(db, 'UPDATE heizung_rooms SET target_temp = ? WHERE id = ?', [target, Number(id)]);
  if (!result.changes) throw validation('Raum nicht gefunden.');
  return target;
}

async function markError(db, id, message = '') {
  await dbRun(db, 'UPDATE heizung_rooms SET last_error = ? WHERE id = ?',
    [String(message || '').slice(0, 500), Number(id)]);
}

// Der Raum verschwindet mit allen Temperaturquellen, Kontakten und Folgen.
async function deleteRoom(db, id) {
  const roomId = Number(id);
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    await dbRun(db, 'DELETE FROM heizung_room_sensors WHERE room_id = ?', [roomId]);
    await dbRun(db, 'DELETE FROM heizung_room_contacts WHERE room_id = ?', [roomId]);
    await dbRun(db, 'DELETE FROM heizung_actions WHERE room_id = ?', [roomId]);
    const result = await dbRun(db, 'DELETE FROM heizung_rooms WHERE id = ?', [roomId]);
    if (!result.changes) throw validation('Raum nicht gefunden.');
    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

// Temperaturquellen ─────────────────────────────────────────────────────────

async function listSensors(db, roomId) {
  const rows = await dbAll(db,
    'SELECT id, room_id, name, topic, position FROM heizung_room_sensors WHERE room_id = ? ORDER BY position, id',
    [Number(roomId)]);
  return rows.map(normalizeSensor);
}

async function listAllSensors(db) {
  const rows = await dbAll(db, 'SELECT id, room_id, name, topic, position FROM heizung_room_sensors ORDER BY room_id, position, id');
  return rows.map(normalizeSensor);
}

async function addSensor(db, roomId, input = {}) {
  const room = await getRoom(db, roomId);
  if (!room) throw validation('Raum nicht gefunden.');
  const topic = normalizeMqttTopic(input.topic || '');
  if (!topic) throw validation('Bitte einen State mit der Temperatur auswählen.');
  const name = cleanLabel(input.name, topic);
  const next = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM heizung_room_sensors WHERE room_id = ?',
    [room.id]);
  const result = await dbRun(db, 'INSERT INTO heizung_room_sensors (room_id, name, topic, position) VALUES (?, ?, ?, ?)',
    [room.id, name, topic, next.position]);
  return result.id;
}

async function updateSensor(db, roomId, sensorId, input = {}) {
  const topic = normalizeMqttTopic(input.topic || '');
  if (!topic) throw validation('Bitte einen State mit der Temperatur auswählen.');
  const name = cleanLabel(input.name, topic);
  const result = await dbRun(db, 'UPDATE heizung_room_sensors SET name = ?, topic = ? WHERE id = ? AND room_id = ?',
    [name, topic, Number(sensorId), Number(roomId)]);
  if (!result.changes) throw validation('Temperaturquelle nicht gefunden.');
}

async function deleteSensor(db, roomId, sensorId) {
  const result = await dbRun(db, 'DELETE FROM heizung_room_sensors WHERE id = ? AND room_id = ?',
    [Number(sensorId), Number(roomId)]);
  if (!result.changes) throw validation('Temperaturquelle nicht gefunden.');
}

// Fenster- und Türkontakte ──────────────────────────────────────────────────

async function listContacts(db, roomId) {
  const rows = await dbAll(db,
    'SELECT id, room_id, name, topic, inverted, position FROM heizung_room_contacts WHERE room_id = ? ORDER BY position, id',
    [Number(roomId)]);
  return rows.map(normalizeContact);
}

async function listAllContacts(db) {
  const rows = await dbAll(db, 'SELECT id, room_id, name, topic, inverted, position FROM heizung_room_contacts ORDER BY room_id, position, id');
  return rows.map(normalizeContact);
}

function contactInverted(input) {
  return checkboxValue(input && input.inverted);
}

async function addContact(db, roomId, input = {}) {
  const room = await getRoom(db, roomId);
  if (!room) throw validation('Raum nicht gefunden.');
  const topic = normalizeMqttTopic(input.topic || '');
  if (!topic) throw validation('Bitte einen State des Kontakts auswählen.');
  const name = cleanLabel(input.name, topic);
  const next = await dbGet(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM heizung_room_contacts WHERE room_id = ?',
    [room.id]);
  const result = await dbRun(db,
    'INSERT INTO heizung_room_contacts (room_id, name, topic, inverted, position) VALUES (?, ?, ?, ?, ?)',
    [room.id, name, topic, contactInverted(input) ? 1 : 0, next.position]);
  return result.id;
}

async function updateContact(db, roomId, contactId, input = {}) {
  const topic = normalizeMqttTopic(input.topic || '');
  if (!topic) throw validation('Bitte einen State des Kontakts auswählen.');
  const name = cleanLabel(input.name, topic);
  const result = await dbRun(db,
    'UPDATE heizung_room_contacts SET name = ?, topic = ?, inverted = ? WHERE id = ? AND room_id = ?',
    [name, topic, contactInverted(input) ? 1 : 0, Number(contactId), Number(roomId)]);
  if (!result.changes) throw validation('Kontakt nicht gefunden.');
}

async function deleteContact(db, roomId, contactId) {
  const result = await dbRun(db, 'DELETE FROM heizung_room_contacts WHERE id = ? AND room_id = ?',
    [Number(contactId), Number(roomId)]);
  if (!result.changes) throw validation('Kontakt nicht gefunden.');
}

// States ────────────────────────────────────────────────────────────────────

// id und Topic eines Raumwertes, benannt nach dem Raum. Beschreibbar ist allein
// die Soll-Temperatur.
function stateId(name, suffix) {
  return `${ID_PREFIX}${addressFor(name)}.${suffix}`;
}
function stateTopic(name, suffix) {
  return topicForId(stateId(name, suffix));
}

const ROOM_STATES = [
  { suffix: 'temperatur', label: 'Temperatur', unit: '°C', writable: false },
  { suffix: 'soll', label: 'Soll-Temperatur', unit: '°C', writable: true },
  { suffix: 'heizen', label: 'Heizen', unit: '', writable: false },
  { suffix: 'kuehlen', label: 'Kühlen', unit: '', writable: false },
  { suffix: 'zentral', label: 'Wärmeanforderung Zentralheizung', unit: '', writable: false },
  { suffix: 'fenster', label: 'Fenster/Tür offen', unit: '', writable: false },
];

// Cache-Schlüssel der abonnierten Fremd-Topics eines Raums.
function sensorCacheKey(sensorId) {
  return `heizung:sensor:${sensorId}`;
}
function contactCacheKey(contactId) {
  return `heizung:contact:${contactId}`;
}
function thermostatCacheKey(roomId) {
  return `heizung:room:${roomId}:thermostat`;
}
function fanCacheKey(roomId) {
  return `heizung:room:${roomId}:fan`;
}

// Durchschnitt aller plausiblen Messwerte. Ohne brauchbaren Wert bleibt die
// Raumtemperatur unbekannt (null) — dann wird nicht geschaltet.
function averageTemperature(cache, sensors) {
  const numbers = [];
  for (const sensor of sensors || []) {
    const entry = cache ? cache.get(sensorCacheKey(sensor.id)) : null;
    if (!entry) continue;
    const number = toNumber(entry.value);
    if (number == null || number < PLAUSIBLE_MIN || number > PLAUSIBLE_MAX) continue;
    numbers.push(number);
  }
  if (!numbers.length) return { value: null, count: 0 };
  const sum = numbers.reduce((total, number) => total + number, 0);
  return { value: Math.round((sum / numbers.length) * 100) / 100, count: numbers.length };
}

function formatTemp(value) {
  return value == null ? '—' : `${value.toFixed(1).replace('.', ',')} °C`;
}

// Systemwert-Einträge eines Raums. Sie erscheinen dadurch auf der States-Seite
// unter „System / Räume / <Raum>", im State-Picker und im Wertekatalog.
function roomEntries(room, state = {}) {
  const values = {
    temperatur: state.temperature == null ? null : state.temperature,
    soll: state.targetTemp == null ? room.targetTemp : state.targetTemp,
    heizen: state.heating ? 1 : 0,
    kuehlen: state.cooling ? 1 : 0,
    zentral: state.centralDemand ? 1 : 0,
    fenster: state.contactOpen ? 1 : 0,
  };
  return ROOM_STATES.map((definition) => {
    const value = values[definition.suffix];
    return {
      id: stateId(room.name, definition.suffix),
      // Der Wertekatalog ist eine flache Liste — deshalb trägt die Beschriftung
      // den Raum, auch wenn die States-Seite ihn schon als Ordner zeigt.
      label: `${room.name} – ${definition.label}`,
      category: `${CATEGORY}/${room.name}`,
      unit: definition.unit,
      writable: definition.writable,
      value,
      display: definition.unit === '°C' ? formatTemp(value == null ? null : Number(value)) : (value ? 'Ein' : 'Aus'),
    };
  });
}

module.exports = {
  ID_PREFIX, CATEGORY, ROOM_STATES,
  MIN_TEMP, MAX_TEMP, MAX_OFFSET, MIN_HYSTERESIS, MAX_HYSTERESIS, MAX_CONTACT_DELAY_SECONDS,
  MIN_PRIORITY, MAX_PRIORITY,
  listRooms, getRoom, createRoom, updateRoom, deleteRoom, setTargetTemp, markError,
  listSensors, listAllSensors, addSensor, updateSensor, deleteSensor,
  listContacts, listAllContacts, addContact, updateContact, deleteContact,
  stateId, stateTopic, addressFor, ensureFreeAddress,
  sensorCacheKey, contactCacheKey, thermostatCacheKey, fanCacheKey,
  averageTemperature, roomEntries, formatTemp, toNumber,
};
