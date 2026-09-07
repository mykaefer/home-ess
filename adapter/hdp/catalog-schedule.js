'use strict';

// Zeitplan der automatischen Katalogprüfung.
//
// Der Online-Firmwarekatalog wird genau einmal am Tag gefragt. Die Uhrzeit legt
// die Instanz selbst fest: Es gilt die Minute, zu der sie den Katalog zum ersten
// Mal gefragt hat — also der erste Abruf nach der Neuinstallation. Damit
// verteilen sich die Instanzen von allein über den Tag, ohne dass irgendwo eine
// Zufallszahl gewürfelt oder ein Zeitfenster konfiguriert werden müsste.
//
// Der Plan liegt im Datenverzeichnis der Instanz, nicht im Speicher: Ein
// Neustart des Dienstes, ein Adapter-Neustart nach einer Einstellungsänderung
// und ein Absturz mit Auto-Restart dürfen keinen zusätzlichen Abruf auslösen.
//
// Einzige Ausnahme ist ein Update über die interne Updatefunktion: Ändert sich
// die homeESS-Version, wird sofort geprüft, auch wenn der Tagesabruf schon
// gelaufen ist. Ein frischer Stand soll seine Firmware nicht bis zum nächsten
// Tag zurückhalten.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'catalog-schedule.json';
const MINUTES_PER_DAY = 24 * 60;
// Kein Timer läuft länger als sechs Stunden. Sommerzeitwechsel, ein Standby und
// eine nachgestellte Systemuhr verschieben einen 24-Stunden-Timer sonst um
// Stunden; nach jedem Aufwachen wird die Fälligkeit neu am Kalender gemessen.
const MAX_TIMER_MS = 6 * 60 * 60 * 1000;
const MIN_TIMER_MS = 60 * 1000;

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function minuteOfDay(date) {
  return (date.getHours() * 60) + date.getMinutes();
}

function normalizeMinute(value) {
  const minute = Number(value);
  if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) return null;
  return minute;
}

function normalizeInstant(value) {
  const instant = Date.parse(String(value || ''));
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

class CatalogSchedule {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.file = null;
    this.slotMinute = null;
    this.lastCheckAt = null;
    this.version = null;
  }

  attach(directory) {
    this.file = directory ? path.join(directory, FILE_NAME) : null;
    this.slotMinute = null;
    this.lastCheckAt = null;
    this.version = null;
    if (!this.file || !fs.existsSync(this.file)) return this;
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      // Ein unlesbarer Plan darf den Start nicht verhindern. Er gilt dann als
      // leer; der nächste Abruf legt ihn neu an.
      return this;
    }
    if (!stored || typeof stored !== 'object') return this;
    this.slotMinute = normalizeMinute(stored.slotMinute);
    this.lastCheckAt = normalizeInstant(stored.lastCheckAt);
    this.version = stored.version == null ? null : String(stored.version);
    return this;
  }

  save() {
    if (!this.file) return false;
    const payload = {
      slotMinute: this.slotMinute,
      lastCheckAt: this.lastCheckAt,
      version: this.version,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    return true;
  }

  // Wurde über die interne Updatefunktion aktualisiert? Eine noch unbekannte
  // Version (Erstinstallation) zählt nicht als Update — dort greift ohnehin der
  // erste Abruf.
  updated(version) {
    const wanted = String(version || '').trim();
    if (!wanted || !this.version) return false;
    return this.version !== wanted;
  }

  noteVersion(version) {
    const wanted = String(version || '').trim();
    if (!wanted || this.version === wanted) return false;
    this.version = wanted;
    this.save();
    return true;
  }

  // Fällig ist der Abruf, wenn heute noch keiner lief und die Tagesuhrzeit
  // erreicht ist. War der Rechner zur Uhrzeit aus, wird beim nächsten Erreichen
  // geprüft.
  //
  // Fehlt dagegen ein ganzer Kalendertag, wird sofort nachgeholt: Ein Rechner,
  // der nur vormittags läuft, dürfte sonst nie prüfen, wenn die Uhrzeit auf den
  // Nachmittag fiel. Auch dann bleibt es bei höchstens einem Abruf am Tag.
  due(instant) {
    const now = new Date(instant == null ? this.now() : instant);
    if (this.slotMinute == null || !this.lastCheckAt) return true;
    const last = new Date(this.lastCheckAt);
    if (dateKey(last) === dateKey(now)) return false;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dateKey(last) !== dateKey(yesterday)) return true;
    return minuteOfDay(now) >= this.slotMinute;
  }

  // Zeitpunkt der nächsten planmäßigen Prüfung. Ohne festen Termin (noch kein
  // Abruf gelaufen) gibt es keinen — dann ist ohnehin sofort fällig.
  nextCheckAt(instant) {
    if (this.slotMinute == null || !this.lastCheckAt) return null;
    const now = new Date(instant == null ? this.now() : instant);
    const target = new Date(now.getTime());
    target.setHours(Math.floor(this.slotMinute / 60), this.slotMinute % 60, 0, 0);
    // Heute schon vorbei oder heute schon gelaufen: dann gilt morgen.
    if (target.getTime() <= now.getTime() || dateKey(new Date(this.lastCheckAt)) === dateKey(now)) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  nextDelayMs(instant) {
    const now = instant == null ? this.now() : instant;
    const target = this.nextCheckAt(now);
    if (!target) return MIN_TIMER_MS;
    return Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, target.getTime() - now));
  }

  // Ein gelaufener Abruf — geglückt oder nicht — belegt den Tag. Der erste legt
  // zugleich die Uhrzeit für alle folgenden fest.
  record(instant) {
    const now = new Date(instant == null ? this.now() : instant);
    if (this.slotMinute == null) this.slotMinute = minuteOfDay(now);
    this.lastCheckAt = now.toISOString();
    this.save();
    return this.lastCheckAt;
  }

  // Tagesuhrzeit als HH:MM für die Oberfläche.
  describeSlot() {
    if (this.slotMinute == null) return null;
    return `${String(Math.floor(this.slotMinute / 60)).padStart(2, '0')}:${String(this.slotMinute % 60).padStart(2, '0')}`;
  }
}

module.exports = {
  CatalogSchedule, dateKey, minuteOfDay, FILE_NAME, MAX_TIMER_MS, MIN_TIMER_MS,
};
