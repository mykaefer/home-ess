'use strict';

// CRUD für Benutzer der Weboberfläche. Ein Benutzer hat einen (eindeutigen)
// Namen, ein gehashtes Passwort, eine Rolle (read/operate/write) und eine
// Auswahl sichtbarer Seiten. Der Administrator (is_admin = 1) ist besonders:
// er trägt immer alle Rechte, sieht alle Seiten und kann weder heruntergestuft
// noch gelöscht werden.

const { hashPassword } = require('./password');
const { normalizeRole, normalizeVisiblePages, PAGE_KEYS, accessForUser } = require('./access');

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function validationError(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

// Öffentliche Repräsentation eines Nutzers (ohne Passwort-Hash) für Anzeige und
// Bearbeitung.
function toPublicUser(row = {}) {
  const isAdmin = row.is_admin === 1;
  return {
    id: row.id,
    name: row.name || '',
    role: isAdmin ? 'write' : normalizeRole(row.role),
    isAdmin,
    // null = alle Seiten sichtbar.
    visiblePages: isAdmin ? null : normalizeVisiblePages(row.visible_pages),
  };
}

async function listUsers(db) {
  const rows = await dbAll(db, 'SELECT id, name, role, is_admin, visible_pages FROM users ORDER BY is_admin DESC, name COLLATE NOCASE ASC, id ASC');
  return rows.map(toPublicUser);
}

// Für die Login-Auswahl: nur Namen (keine Rechte/Details).
async function listUsersForLogin(db) {
  const rows = await dbAll(db, 'SELECT id, name, is_admin FROM users ORDER BY is_admin DESC, name COLLATE NOCASE ASC, id ASC');
  return rows.map((row) => ({ id: row.id, name: row.name || 'Administrator' }));
}

async function getUser(db, id) {
  const row = await dbGet(db, 'SELECT id, name, role, is_admin, visible_pages FROM users WHERE id = ?', [id]);
  return row ? toPublicUser(row) : null;
}

// Vollständige Zeile inkl. Passwort-Hash (für die Anmeldung).
async function getUserWithSecret(db, id) {
  return dbGet(db, 'SELECT id, name, password, role, is_admin, visible_pages FROM users WHERE id = ?', [id]);
}

// Zugriff (Rechte) zu einer Session auflösen: über die in der Session
// hinterlegte user_id. Ohne gültigen Nutzer wird null zurückgegeben.
async function accessForUserId(db, userId) {
  if (userId == null) return null;
  const row = await dbGet(db, 'SELECT id, name, role, is_admin, visible_pages FROM users WHERE id = ?', [userId]);
  return row ? accessForUser(row) : null;
}

function normalizeName(value) {
  const name = String(value == null ? '' : value).trim();
  if (!name) throw validationError('Bitte einen Benutzernamen eingeben.');
  if (name.length > 60) throw validationError('Der Benutzername darf höchstens 60 Zeichen lang sein.');
  return name;
}

// Sichtbare Seiten aus dem Formular: mehrere gleichnamige Felder kommen als
// Array oder String an. Für Nicht-Admins wird die Auswahl gespeichert; eine
// leere Auswahl ergibt „keine Seite sichtbar" – bis auf mindestens eine Seite
// erzwingen wir hier nichts (der Nutzer kann bewusst stark eingeschränkt sein),
// doch mindestens eine Seite ist sinnvoll, damit ein Login nicht ins Leere läuft.
function normalizePagesInput(value) {
  let list = value;
  if (list == null) list = [];
  if (!Array.isArray(list)) list = [list];
  const wanted = new Set(list.map(String));
  return PAGE_KEYS.filter((key) => wanted.has(key));
}

async function ensureNameUnique(db, name, exceptId) {
  const row = await dbGet(db, 'SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id <> ?', [name, exceptId == null ? -1 : exceptId]);
  if (row) throw validationError('Dieser Benutzername ist bereits vergeben.');
}

async function createUser(db, input = {}) {
  const name = normalizeName(input.name);
  const password = String(input.password == null ? '' : input.password);
  if (!password) throw validationError('Bitte ein Passwort vergeben.');
  await ensureNameUnique(db, name, null);
  const role = normalizeRole(input.role);
  const pages = normalizePagesInput(input.visiblePages);
  const result = await dbRun(
    db,
    'INSERT INTO users (name, password, role, is_admin, visible_pages) VALUES (?, ?, ?, 0, ?)',
    [name, hashPassword(password), role, JSON.stringify(pages)]
  );
  return getUser(db, result.lastID);
}

// Nutzer aktualisieren. Der Administrator behält Rolle/Rechte/Sichtbarkeit
// unverändert (immer voll); Passwort und Name bleiben änderbar. Ein leeres
// Passwortfeld lässt das bestehende Passwort unangetastet.
async function updateUser(db, id, input = {}) {
  const current = await dbGet(db, 'SELECT id, is_admin FROM users WHERE id = ?', [id]);
  if (!current) throw validationError('Benutzer nicht gefunden.');
  const isAdmin = current.is_admin === 1;
  const name = normalizeName(input.name);
  await ensureNameUnique(db, name, id);
  const password = String(input.password == null ? '' : input.password);

  if (isAdmin) {
    if (password) {
      await dbRun(db, 'UPDATE users SET name = ?, password = ? WHERE id = ?', [name, hashPassword(password), id]);
    } else {
      await dbRun(db, 'UPDATE users SET name = ? WHERE id = ?', [name, id]);
    }
    return getUser(db, id);
  }

  const role = normalizeRole(input.role);
  const pages = normalizePagesInput(input.visiblePages);
  if (password) {
    await dbRun(db, 'UPDATE users SET name = ?, password = ?, role = ?, visible_pages = ? WHERE id = ?',
      [name, hashPassword(password), role, JSON.stringify(pages), id]);
  } else {
    await dbRun(db, 'UPDATE users SET name = ?, role = ?, visible_pages = ? WHERE id = ?',
      [name, role, JSON.stringify(pages), id]);
  }
  return getUser(db, id);
}

// Nutzer löschen. Der Administrator ist nicht löschbar. Aktive Sessions des
// Nutzers werden mitentfernt, damit ein gelöschter Nutzer sofort abgemeldet ist.
async function deleteUser(db, id) {
  const current = await dbGet(db, 'SELECT id, is_admin FROM users WHERE id = ?', [id]);
  if (!current) throw validationError('Benutzer nicht gefunden.');
  if (current.is_admin === 1) throw validationError('Der Administrator kann nicht gelöscht werden.');
  await dbRun(db, 'DELETE FROM sessions WHERE user_id = ?', [id]);
  await dbRun(db, 'DELETE FROM users WHERE id = ?', [id]);
}

module.exports = {
  listUsers,
  listUsersForLogin,
  getUser,
  getUserWithSecret,
  accessForUserId,
  createUser,
  updateUser,
  deleteUser,
  toPublicUser,
};
