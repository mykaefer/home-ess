'use strict';

// Abbildung des gesamten homeESS-States-Baums auf MQTT-Topics unterhalb von
// `states/`. Aus dem Prefix eines States wird dabei ein einfaches
// Unterverzeichnis; die Adresse behält ihre Gliederung, wobei **Punkte wie
// Schrägstriche** eine neue Ebene öffnen — sonst läge der gesamte Systembaum
// flach in einem einzigen Verzeichnis:
//
//   hdp://wohnzimmer/messwerte/temperatur → states/hdp/wohnzimmer/messwerte/temperatur
//   system://homeess/pv.current           → states/system/homeess/pv/current
//   system://homeess/geraet.3.leistung    → states/system/homeess/geraet/3/leistung
//
// Ausgelassen wird ausschließlich die **eigene Instanz**: sonst würde jeder
// eigene Wert als states/-Topic zurückgespiegelt und dort erneut als Broker-Wert
// verarbeitet werden. Andere Broker-Instanzen sind dagegen ganz gewöhnliche
// Fremd-States und erscheinen wie jeder andere Adapter unter
// `states/mqttbroker/<instanz>/…` — nur dort können MQTT-Clients frei States
// anlegen, deshalb gehören sie in den Baum.
//
// Diese Klasse hält ausschließlich Metadaten. Ob ein State auch tatsächlich
// abonniert wird, entscheidet index.js anhand der Abos der verbundenen Clients.

const { topicMatches, isValidTopicName } = require('./broker');

const DEFAULT_ROOT = 'states';
const SCHEME_RE = /^([a-z][a-z0-9_-]*):\/\/([^/]+)(?:\/(.*))?$/i;

function parseHomeTopic(topic) {
  const match = String(topic || '').trim().match(SCHEME_RE);
  if (!match) return null;
  return { scheme: match[1].toLowerCase(), instance: match[2], address: match[3] || '' };
}

// Ein Topic-Abschnitt darf keine MQTT-Sonderzeichen und kein Leerzeichen
// enthalten. Die Rückabbildung läuft ausschließlich über die Tabelle, deshalb
// ist die Ersetzung hier reine Darstellung.
function sanitizeLevel(level) {
  const value = String(level == null ? '' : level)
    .replace(/\+/g, '%2B')
    .replace(/#/g, '%23')
    .replace(/\s+/g, '_');
  return value || '_';
}

class SystemTree {
  constructor(options = {}) {
    this.root = String(options.root || DEFAULT_ROOT);
    this.ownPrefix = String(options.ownPrefix || '').toLowerCase();
    // Ohne bekannten Instanznamen bleibt es bei der alten, gröberen Regel:
    // dann wird der gesamte eigene Prefix ausgelassen.
    this.ownInstance = String(options.ownInstance || '').trim().toLowerCase();
    this.byMqttTopic = new Map(); // states/... -> { mqttTopic, homeTopic, name, writable, category, unit }
    this.byHomeTopic = new Map();
    this.skipped = 0;
    this.collisions = [];
  }

  get size() {
    return this.byMqttTopic.size;
  }

  // Gehört ein State zur eigenen Instanz? Nur diese darf sich nicht selbst
  // spiegeln; andere Instanzen desselben Adapters sind gewöhnliche Fremd-States.
  isOwnState(parsed) {
    if (!parsed || !this.ownPrefix || parsed.scheme !== this.ownPrefix) return false;
    if (!this.ownInstance) return true;
    return String(parsed.instance || '').trim().toLowerCase() === this.ownInstance;
  }

  mqttTopicFor(homeTopic) {
    const parsed = parseHomeTopic(homeTopic);
    if (!parsed) return '';
    if (this.isOwnState(parsed)) return '';
    const levels = [
      this.root,
      sanitizeLevel(parsed.scheme),
      sanitizeLevel(parsed.instance),
      ...String(parsed.address).split(/[/.]/).filter((part) => part !== '').map(sanitizeLevel),
    ];
    const topic = levels.join('/');
    return isValidTopicName(topic) ? topic : '';
  }

  entryByMqttTopic(topic) {
    return this.byMqttTopic.get(String(topic || '')) || null;
  }

  entryByHomeTopic(topic) {
    return this.byHomeTopic.get(String(topic || '')) || null;
  }

  topics() {
    return Array.from(this.byMqttTopic.keys());
  }

  entries() {
    return Array.from(this.byMqttTopic.values());
  }

  // Gehört ein MQTT-Topic in den Systembaum? Auch unbekannte Topics unterhalb
  // von `states/` gehören dazu – sie werden dann bewusst verworfen, statt einen
  // neuen State anzulegen.
  isSystemTopic(topic) {
    const value = String(topic || '');
    return value === this.root || value.startsWith(`${this.root}/`);
  }

  // Katalog übernehmen. Liefert die Differenz zum vorherigen Stand, damit
  // entfallene Topics ihre Retained Message verlieren können.
  refresh(states) {
    const next = new Map();
    let skipped = 0;
    const collisions = [];
    for (const state of Array.isArray(states) ? states : []) {
      if (!state || !state.topic) continue;
      const mqttTopic = this.mqttTopicFor(state.topic);
      if (!mqttTopic) {
        // Eigener Prefix oder unbrauchbares Topic – bewusst ausgelassen.
        skipped += 1;
        continue;
      }
      if (next.has(mqttTopic)) {
        // Zwei States bilden auf dasselbe Topic ab (z. B. weil der eine einen
        // Punkt, der andere einen Schrägstrich als Trenner verwendet). Der
        // erste behält es; der zweite bleibt unsichtbar und wird gemeldet.
        skipped += 1;
        collisions.push({ mqttTopic, homeTopic: String(state.topic) });
        continue;
      }
      next.set(mqttTopic, {
        mqttTopic,
        homeTopic: String(state.topic),
        name: state.name == null ? String(state.topic) : String(state.name),
        category: state.category == null ? '' : String(state.category),
        unit: state.unit == null ? '' : String(state.unit),
        // Letzter bekannter Wert aus dem Katalog: der Topic-Browser zeigt ihn
        // auch für States, die gerade kein Client abonniert hat.
        value: state.value === undefined ? null : state.value,
        writable: !!state.writable,
      });
    }
    const added = [];
    const removed = [];
    for (const topic of next.keys()) if (!this.byMqttTopic.has(topic)) added.push(topic);
    for (const topic of this.byMqttTopic.keys()) if (!next.has(topic)) removed.push(topic);
    this.byMqttTopic = next;
    this.byHomeTopic = new Map(Array.from(next.values(), (entry) => [entry.homeTopic, entry]));
    this.skipped = skipped;
    this.collisions = collisions;
    return { added, removed, total: next.size, skipped, collisions };
  }

  // Alle Systemtopics, die zu mindestens einem der aktiven Abos passen.
  // `limit` deckelt die Anzahl gleichzeitig gespiegelter States.
  matching(filters, limit = 0) {
    const result = new Set();
    const max = Math.max(0, Number(limit) || 0);
    const list = Array.isArray(filters) ? filters : [];
    if (!list.length) return result;
    for (const topic of this.byMqttTopic.keys()) {
      if (!list.some((filter) => topicMatches(filter, topic))) continue;
      result.add(topic);
      if (max && result.size >= max) break;
    }
    return result;
  }
}

module.exports = { SystemTree, parseHomeTopic, sanitizeLevel, DEFAULT_ROOT };
