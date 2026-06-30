'use strict';

// Optionale Module: Registry und In-Memory-Status.
// Der Status wird beim Start aus der DB geladen und bei Änderungen sofort
// aktualisiert, damit renderLayout() ohne DB-Abfrage auf den Status zugreifen kann.

const REGISTRY = [
  {
    key: 'pool',
    label: 'Poolsteuerung',
    path: '/pool',
    description: 'Überwachung der Poolanlage: Wassertemperatur, Pumpe, pH-Wert und Chlorgehalt.',
  },
  {
    key: 'grid-control',
    label: 'Grid-Control',
    path: '/grid-control',
    description: 'Netz- und Überschusseinspeisungs-Steuerung nach SoC, Batteriespannung und Wechselrichter-Temperaturwarnung.',
  },
  {
    key: 'wallbox',
    label: 'Wallbox',
    path: '/wallbox',
    description: 'Verwaltung mehrerer PKW-Wallboxen mit vorausschauender Überschuss-Ladung und Lademodi (Privat / Beruflich / Immer voll).',
  },
];

let _enabledKeys = new Set();

function initModules(db) {
  return new Promise((resolve) => {
    db.all('SELECT key FROM modules WHERE enabled = 1', (err, rows) => {
      if (!err && Array.isArray(rows)) {
        _enabledKeys = new Set(rows.map((r) => r.key));
      }
      resolve();
    });
  });
}

function isEnabled(key) {
  return _enabledKeys.has(key);
}

function setEnabled(db, key, enabled) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO modules (key, enabled) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled`,
      [key, enabled ? 1 : 0],
      (err) => {
        if (err) return reject(err);
        if (enabled) {
          _enabledKeys.add(key);
        } else {
          _enabledKeys.delete(key);
        }
        resolve();
      }
    );
  });
}

function getRegistry() {
  return REGISTRY;
}

function getEnabledNavItems() {
  return REGISTRY
    .filter((m) => _enabledKeys.has(m.key))
    .map((m) => ({ path: m.path, label: m.label, section: 'main' }));
}

module.exports = { initModules, isEnabled, setEnabled, getRegistry, getEnabledNavItems };
