'use strict';

// Topic-Helfer für ioBroker-MQTT. Reine Funktionen, abgeleitet aus MQTT.md.
// Diese Schicht kapselt die Eigenheiten des ioBroker-Brokers (Punkt-/Slash-
// Notation, eingebettete Slashes, Command-Topics) für Lese- und Schreibpfade.

function normalizeMqttTopic(topic) {
  const text = String(topic || '').trim();
  // Adapter-Schema-Topics (prefix://instanz/adresse) NICHT wie Broker-Topics
  // normalisieren: das Kollabieren doppelter Slashes würde das "://" des Schemas
  // zu ":/" zerstören, sodass es nicht mehr als Adapter-Topic erkannt und
  // fälschlich über den Broker geroutet wird (→ kein Wert). Kanonische Form zurück.
  const scheme = parseSchemeTopic(text);
  if (scheme) return buildSchemeTopic(scheme.scheme, scheme.instance, scheme.address);
  return text
    .replace(/^\/+/, '') // kein führender Slash
    .replace(/\/+/g, '/'); // keine doppelten Slashes
}

// State-ID (Punktnotation) -> MQTT-Topic (Slash-Notation).
function ioBrokerIdToMqttTopic(stateId) {
  return String(stateId || '')
    .replace(/^\/+/, '')
    .replace(/\./g, '/')
    .replace(/\/+/g, '/');
}

// "mqtt.0.Heizung.Vorlauf" -> Broker-Topic "Heizung/Vorlauf".
function mqttAdapterStateToBrokerTopic(topic) {
  const clean = normalizeMqttTopic(topic);
  const dotMatch = clean.match(/^mqtt\.\d+\.(.+)$/i);
  if (dotMatch) return ioBrokerIdToMqttTopic(dotMatch[1]);
  const slashMatch = clean.match(/^mqtt\/\d+\/(.+)$/i);
  if (slashMatch) return normalizeMqttTopic(slashMatch[1]);
  return '';
}

// Alle realistischen Lese-Pfade für ein konfiguriertes Topic (exakt, kein Wildcard).
function mqttReadCandidates(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  if (!clean) return [];
  const slashVariant = ioBrokerIdToMqttTopic(clean);
  const adapterVariant = mqttAdapterStateToBrokerTopic(clean);
  const result = new Set([clean]);
  if (slashVariant !== clean) result.add(slashVariant);
  if (adapterVariant && adapterVariant !== clean) result.add(adapterVariant);
  return Array.from(result);
}

// Duty-Cycle-sensible Funk-Topics (Homematic, MQTT.md Regel 7): Jede aktive
// Wertanfrage (/get) und jeder Schreibvorgang kann eine echte Funkübertragung
// auslösen. Solche Topics dürfen niemals gepollt werden, und beim Schreiben
// darf nicht auf mehrere Kandidaten aufgefächert werden – Punkt- und Slash-
// Variante landen beim Broker auf derselben State-ID und würden denselben
// Funkbefehl mehrfach senden.
function isRadioTopic(topic) {
  const clean = normalizeMqttTopic(topic);
  return /^hm-rpc[./]/i.test(clean);
}

// Schreib-Kandidaten für ein konfiguriertes Topic. Funk-Topics erhalten genau
// EINEN Kandidaten (Punktnotation): Sie wird vom Broker unabhängig von dessen
// Slash-Konvertierung auf dieselbe State-ID abgebildet; jede weitere Variante
// wäre ein zusätzlicher Funkbefehl. Alle anderen Topics behalten die
// Auffächerung, weil dort ein verworfener Kandidat folgenlos bleibt.
function mqttWriteCandidates(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  if (!clean) return [];
  if (isRadioTopic(clean)) return [clean];
  return mqttReadCandidates(clean);
}

// Wildcard-Abo für State-IDs mit eingebettetem Slash (Modbus/Victron-Bug).
function mqttSlashStateWildcard(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  const firstSlash = clean.indexOf('/');
  if (firstSlash === -1) return '';
  const dotPrefix = clean.slice(0, firstSlash);
  const lastDot = dotPrefix.lastIndexOf('.');
  if (lastDot === -1) return '';
  const base = dotPrefix.slice(0, lastDot);
  const slashBase = ioBrokerIdToMqttTopic(base);
  return slashBase ? `${slashBase}/#` : '';
}

// Alle Abo-Pfade (Lese-Kandidaten + ggf. Wildcard) für ein konfiguriertes Topic.
function mqttSubscribeCandidates(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  if (!clean) return [];
  const candidates = new Set(mqttReadCandidates(clean));
  const wildcard = mqttSlashStateWildcard(clean);
  if (wildcard) candidates.add(wildcard);
  return Array.from(candidates);
}

// Adapter-Schema-Topics: prefix://instanz/adresse. Der Prefix (Schema) wird beim
// Adapter registriert, die Instanz ist der benannte Adapter-Lauf, die Adresse der
// gerätespezifische State-Pfad. Gibt { scheme, instance, address } zurück oder
// null, wenn kein Schema-Topic vorliegt. Normale ioBroker-Topics (Punkt-/Slash-
// Notation ohne "://") liefern null und laufen weiter über den Broker.
function parseSchemeTopic(topic) {
  const text = String(topic == null ? '' : topic).trim();
  const match = text.match(/^([a-z][a-z0-9_-]*):\/\/([^/]+)(?:\/(.*))?$/i);
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase(),
    instance: match[2],
    address: match[3] || '',
  };
}

function isSchemeTopic(topic) {
  return parseSchemeTopic(topic) != null;
}

// Kanonisches Schema-Topic aus seinen Bestandteilen zusammensetzen.
function buildSchemeTopic(scheme, instance, address) {
  const base = `${String(scheme).toLowerCase()}://${instance}`;
  return address ? `${base}/${address}` : base;
}

function isCommandTopic(topic) {
  const upper = normalizeMqttTopic(topic).toUpperCase();
  return upper.endsWith('.SET') || upper.endsWith('/SET') || upper.endsWith('_SET');
}

// Auspacken einer ioBroker-MQTT-Nachricht inkl. ack-Flag.
//   { value, ack } – ack ist true/false (aus dem JSON) oder null (kein JSON-Wrap).
// In ioBroker bedeutet ack:true den BESTÄTIGTEN Ist-Zustand, ack:false einen
// reinen Schreibwunsch/Kommando. Letzteres ist u. a. das Echo unserer eigenen
// Schreibvorgänge auf dem Haupt-Topic und darf NICHT als Readback gelten.
function unwrapMqttMessage(raw) {
  const text = String(raw);
  if (!text || (text[0] !== '{' && text[0] !== '[')) return { value: text, ack: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'val' in parsed) {
      return { value: parsed.val, ack: typeof parsed.ack === 'boolean' ? parsed.ack : null };
    }
  } catch (_) {
    /* kein gültiges JSON */
  }
  return { value: text, ack: null };
}

// Auspacken des ioBroker-JSON-Formats { val, ack, ... }; sonst Rohstring.
function unwrapMqttPayload(raw) {
  return unwrapMqttMessage(raw).value;
}

function isMeaningfulValue(value) {
  const text = String(value == null ? '' : value).trim();
  return text !== '' && text.toLowerCase() !== 'null' && text.toLowerCase() !== 'nan';
}

// Typrichtiger Wert für das val-Feld beim JSON-Publish.
function parseValue(value) {
  const text = String(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  return text;
}

module.exports = {
  normalizeMqttTopic,
  ioBrokerIdToMqttTopic,
  mqttAdapterStateToBrokerTopic,
  mqttReadCandidates,
  mqttWriteCandidates,
  isRadioTopic,
  mqttSlashStateWildcard,
  mqttSubscribeCandidates,
  parseSchemeTopic,
  isSchemeTopic,
  buildSchemeTopic,
  isCommandTopic,
  unwrapMqttMessage,
  unwrapMqttPayload,
  isMeaningfulValue,
  parseValue,
};
