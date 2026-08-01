'use strict';

// Adressierbare Topics für berechnete homeESS-Systemwerte. Die fachliche ID
// (z. B. `pv.current`) bleibt der stabile interne Schlüssel. State-Bezüge (wie
// bei Wert-Widgets) verwenden die eindeutige Form
// `system://homeess/pv.current`; alte Output-Bezüge bleiben kompatibel lesbar.

const SCHEME = 'system';
const INSTANCE = 'homeess';

function topicForId(id) {
  const value = String(id || '').trim();
  return value ? `${SCHEME}://${INSTANCE}/${value}` : '';
}

function parseSystemTopic(topic) {
  const text = String(topic || '').trim();
  const prefix = `${SCHEME}://${INSTANCE}/`;
  if (!text.toLowerCase().startsWith(prefix)) return null;
  const id = text.slice(prefix.length);
  return id ? { id, topic: topicForId(id) } : null;
}

module.exports = { SCHEME, INSTANCE, topicForId, parseSystemTopic };
