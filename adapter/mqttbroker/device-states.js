'use strict';

// Verwaltung der States, die angemeldete MQTT-Clients selbst anlegen. Jedes
// Gerätetopic wird unverändert zur State-Adresse: aus dem MQTT-Topic
// `wohnzimmer/temperatur` wird `mqttbroker://<instanz>/wohnzimmer/temperatur`.
//
// Kern der Aufgabe ist die Idle-Haltezeit: States, die länger als die
// eingestellte Dauer nicht mehr aktualisiert wurden, werden vollständig
// entfernt (Katalog, Wert, Retained Message). Damit füllt sich der States-Baum
// nicht dauerhaft mit Topics, die es längst nicht mehr gibt.

const DEFAULT_ROOT_CATEGORY = 'MQTT-Geräte';

class DeviceStates {
  constructor(options = {}) {
    this.maxStates = Math.max(1, Number(options.maxStates) || 500);
    this.rootCategory = options.rootCategory || DEFAULT_ROOT_CATEGORY;
    this.states = new Map(); // address -> { address, value, updatedAt, retained }
    this.rejected = 0;
  }

  get size() {
    return this.states.size;
  }

  has(address) {
    return this.states.has(address);
  }

  get(address) {
    return this.states.get(address) || null;
  }

  addresses() {
    return Array.from(this.states.keys());
  }

  // Wert eines Gerätetopics übernehmen. Liefert, ob der State neu angelegt
  // wurde und ob das Mengenlimit die Anlage verhindert hat.
  update(address, value, options = {}) {
    const key = String(address || '');
    if (!key) return { created: false, rejected: true };
    const now = Number(options.now) || Date.now();
    const existing = this.states.get(key);
    if (!existing && this.states.size >= this.maxStates) {
      this.rejected += 1;
      return { created: false, rejected: true };
    }
    const entry = existing || { address: key, value: null, updatedAt: now, retained: false, createdAt: now };
    entry.value = value;
    entry.updatedAt = now;
    if (options.retain != null) entry.retained = !!options.retain;
    this.states.set(key, entry);
    return { created: !existing, rejected: false, entry };
  }

  // Nur die Frische auffrischen (z. B. wenn homeESS selbst auf den State
  // schreibt), ohne einen neuen State anzulegen.
  touch(address, now = Date.now()) {
    const entry = this.states.get(String(address || ''));
    if (!entry) return false;
    entry.updatedAt = now;
    return true;
  }

  remove(address) {
    return this.states.delete(String(address || ''));
  }

  // Alle States entfernen, deren letzte Aktualisierung länger als `idleMs`
  // zurückliegt. `idleMs = 0` schaltet die Bereinigung ab.
  sweep(idleMs, now = Date.now()) {
    const limit = Number(idleMs) || 0;
    if (limit <= 0) return [];
    const removed = [];
    for (const [address, entry] of this.states) {
      if (now - entry.updatedAt < limit) continue;
      this.states.delete(address);
      removed.push(address);
    }
    return removed;
  }

  // State-Katalog für host.setStates(...). Der letzte Topic-Abschnitt ist der
  // Anzeigename, die übrigen bilden den Kategoriepfad.
  catalog() {
    return Array.from(this.states.values())
      .sort((a, b) => a.address.localeCompare(b.address, 'de'))
      .map((entry) => {
        const levels = entry.address.split('/').filter(Boolean);
        const name = levels.length ? levels[levels.length - 1] : entry.address;
        const parents = levels.slice(0, -1);
        return {
          address: entry.address,
          name,
          category: [this.rootCategory, ...parents].join(' / '),
          unit: '',
          writable: true,
        };
      });
  }

  // Persistierbarer Zustand (Werte + Frische), damit ein Neustart des Adapters
  // die bekannten Geräte-States nicht verliert.
  snapshot() {
    return Array.from(this.states.values()).map((entry) => ({
      address: entry.address,
      value: entry.value,
      updatedAt: entry.updatedAt,
      retained: !!entry.retained,
    }));
  }

  // Gespeicherten Zustand übernehmen. Bereits abgelaufene States werden dabei
  // gar nicht erst wiederhergestellt.
  restore(rows, idleMs, now = Date.now()) {
    const limit = Number(idleMs) || 0;
    let restored = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !row.address) continue;
      const updatedAt = Number(row.updatedAt) || 0;
      if (limit > 0 && now - updatedAt >= limit) continue;
      if (this.states.size >= this.maxStates) break;
      this.states.set(String(row.address), {
        address: String(row.address),
        value: row.value === undefined ? null : row.value,
        updatedAt: updatedAt || now,
        retained: !!row.retained,
        createdAt: updatedAt || now,
      });
      restored += 1;
    }
    return restored;
  }
}

module.exports = { DeviceStates, DEFAULT_ROOT_CATEGORY };
