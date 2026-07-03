'use strict';

// CRUD für Adapter-Instanzen. Jede Instanz ist ein benannter Lauf eines Adapters
// (adapter_id verweist auf /adapter/<adapter_id>) mit eigenen Einstellungen.

function parseSettings(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function rowToInstance(row) {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    name: row.name,
    enabled: !!row.enabled,
    settings: parseSettings(row.settings),
    position: row.position || 0,
  };
}

function listInstances(db) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM adapter_instances ORDER BY position, id', (err, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map(rowToInstance));
    });
  });
}

function listInstancesForAdapter(db, adapterId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM adapter_instances WHERE adapter_id = ? ORDER BY position, id',
      [adapterId],
      (err, rows) => {
        if (err) return reject(err);
        resolve((rows || []).map(rowToInstance));
      }
    );
  });
}

function getInstance(db, id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM adapter_instances WHERE id = ?', [id], (err, row) => {
      if (err) return reject(err);
      resolve(row ? rowToInstance(row) : null);
    });
  });
}

function createInstance(db, adapterId, name) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO adapter_instances (adapter_id, name, enabled, settings, position)
       VALUES (?, ?, 0, '{}', (SELECT COALESCE(MAX(position), 0) + 1 FROM adapter_instances))`,
      [adapterId, name],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function renameInstance(db, id, name) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE adapter_instances SET name = ? WHERE id = ?', [name, id], (err) =>
      err ? reject(err) : resolve()
    );
  });
}

function setEnabled(db, id, enabled) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE adapter_instances SET enabled = ? WHERE id = ?',
      [enabled ? 1 : 0, id],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function updateSettings(db, id, settings) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE adapter_instances SET settings = ? WHERE id = ?',
      [JSON.stringify(settings || {}), id],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function updateSettingKey(db, id, key, value) {
  return getInstance(db, id).then((instance) => {
    if (!instance) return;
    const settings = { ...(instance.settings || {}) };
    settings[String(key)] = value;
    return updateSettings(db, id, settings);
  });
}

function deleteInstance(db, id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM adapter_states WHERE instance_id = ?', [id], () => {
      db.run('DELETE FROM adapter_instances WHERE id = ?', [id], (err) =>
        err ? reject(err) : resolve()
      );
    });
  });
}

module.exports = {
  parseSettings,
  listInstances,
  listInstancesForAdapter,
  getInstance,
  createInstance,
  renameInstance,
  setEnabled,
  updateSettings,
  updateSettingKey,
  deleteInstance,
};
