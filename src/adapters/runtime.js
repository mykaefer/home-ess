'use strict';

// Fork-Ziel für eine Adapter-Instanz. Läuft als eigener Kindprozess, lädt die
// Adapter-Einstiegsdatei und stellt dem Adapter eine `host`-API bereit, die
// transparent auf IPC abgebildet wird. Der Adapter-Autor kennt kein IPC – er
// schreibt nur module.exports = (host) => ({ start, stop, write, read }).
//
// IPC (Parent -> Child):  init{mainPath,name,config}, stop, write{address,value}, read{address}
// IPC (Child -> Parent):  ready, states{list}, value{address,value}, log{level,message}, error{message}

let adapter = null;
let currentConfig = {};
let instanceName = '';
let language = { code: 'de', locale: 'de-DE', direction: 'ltr', fallback: 'de' };
let translations = {};
let hostCallSequence = 0;
let subscriptionSequence = 0;
const hostCalls = new Map();
const subscriptions = new Map();

function send(message) {
  if (process.send) {
    try {
      process.send(message);
    } catch (_) {
      /* Parent weg – beim nächsten Lebenszyklus neu */
    }
  }
}

function localize(value) {
  let result = String(value == null ? '' : value);
  const entries = Object.entries(translations || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [source, translated] of entries) {
    if (!source || source === translated) continue;
    if (result === source) return translated;
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexibleWhitespace = escaped.replace(/\s+/g, '\\s+');
    result = result.replace(new RegExp(`(>\\s*)${flexibleWhitespace}(\\s*<)`, 'gu'), (_match, before, after) => `${before}${translated}${after}`);
    for (const quote of ['"', "'", '`']) {
      if (!source.includes(quote)) result = result.replace(new RegExp(`${quote}${escaped}${quote}`, 'gu'), `${quote}${translated}${quote}`);
    }
  }
  return result;
}

function localizeCategory(value) {
  return String(value == null ? '' : value)
    .split(' / ')
    .map((part) => localize(part))
    .join(' / ');
}

function buildHost() {
  function hostCall(method, data = {}) {
    const requestId = `${process.pid}-${Date.now()}-${++hostCallSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        hostCalls.delete(requestId);
        reject(new Error('Host-Aufruf hat nicht rechtzeitig geantwortet.'));
      }, 10000);
      hostCalls.set(requestId, { resolve, reject, timer });
      send({ type: 'host-call', requestId, method, ...data });
    });
  }
  return {
    get name() {
      return instanceName;
    },
    getConfig() {
      return currentConfig;
    },
    get language() {
      return language.code;
    },
    getLanguage() {
      return { ...language };
    },
    // Adaptereigene Sprachdateien verwenden stabile Schlüssel. Fehlt ein
    // Schlüssel, bleibt der mitgegebene Standardtext erhalten.
    t(key, defaultText) {
      if (Object.prototype.hasOwnProperty.call(translations, `@${key}`)) return translations[`@${key}`];
      const source = defaultText == null ? String(key) : String(defaultText);
      return localize(source);
    },
    // Einen einzelnen State-Wert melden.
    publishState(address, value) {
      if (address == null) return;
      send({ type: 'value', address: String(address), value });
    },
    // Mehrere zusammen gelesene Werte in einer IPC-Nachricht melden. Der Parent
    // aktualisiert alle Frischezeitstempel und feuert nur ein gemeinsames Event.
    publishStates(values) {
      if (!Array.isArray(values) || !values.length) return;
      send({ type: 'values', values: values
        .filter((entry) => entry && entry.address != null)
        .map((entry) => ({ address: String(entry.address), value: entry.value })) });
    },
    // Den State-Katalog (Liste declarierter States) melden/aktualisieren.
    // Eintrag: { address, name?, category?, unit?, writable? }
    setStates(list) {
      const states = Array.isArray(list) ? list : [];
      send({ type: 'states', list: states.map((state) => state && ({
        ...state,
        name: state.name == null ? state.name : localize(state.name),
        category: state.category == null ? state.category : localizeCategory(state.category),
      })) });
    },
    // Verbindungszustand zum Gerät/Dienst melden (für die Adapter-Seite).
    setConnected(connected, detail) {
      send({ type: 'status', connected: !!connected, detail: detail == null ? '' : localize(detail) });
    },
    // Persistente Instanzdaten unter settings[key] ablegen, ohne die Instanz neu
    // zu laden. Gedacht für dynamisch erkannte Geräte/Metadaten.
    setStorage(key, value) {
      if (key == null) return;
      send({ type: 'storage', key: String(key), value });
    },
    // Wie setStorage(), bestätigt aber erst nach erfolgreichem SQLite-Commit.
    // Protokolle mit vorab dauerhaft zu sichernden Transaktionen (z. B. hDP-
    // Pairing) dürfen erst nach Auflösung dieses Promises fortfahren.
    persistStorage(key, value) {
      if (key == null) return Promise.reject(new Error('Persistenzschlüssel fehlt.'));
      return hostCall('storage.set', { key: String(key), value });
    },
    // Beliebige homeESS-Datenquelle (MQTT oder prefix://-Adapter-State)
    // ereignisgetrieben abonnieren. Liefert eine idempotente Abmeldefunktion.
    subscribeState(topic, listener) {
      if (!String(topic || '').trim() || typeof listener !== 'function') {
        throw new Error('subscribeState benötigt Topic und Listener.');
      }
      const subscriptionId = String(++subscriptionSequence);
      subscriptions.set(subscriptionId, listener);
      send({ type: 'subscribe', subscriptionId, topic: String(topic).trim() });
      return () => {
        if (!subscriptions.delete(subscriptionId)) return;
        send({ type: 'unsubscribe', subscriptionId });
      };
    },
    // Einen Wert gezielt in eine homeESS-Datenquelle schreiben. Die Parent-
    // Laufzeit übernimmt MQTT-, Adapter- und Schreibschutzregeln zentral.
    writeState(topic, value) {
      const target = String(topic || '').trim();
      if (!target) return Promise.reject(new Error('writeState benötigt ein Ziel-Topic.'));
      return hostCall('state.write', { topic: target, value });
    },
    // Instanzeigenes Datenverzeichnis (0700). Für Nutzdaten, die zu groß für
    // die Instanz-Settings sind — der Settings-Blob wird bei jedem Persistieren
    // vollständig neu geschrieben. Das Verzeichnis wird bei Bedarf angelegt.
    getDataDirectory() {
      return hostCall('storage.dir');
    },
    getInstanceIdentity() {
      return hostCall('identity');
    },
    getSecret(key) {
      return hostCall('secret.get', { key: String(key) });
    },
    setSecret(key, value) {
      return hostCall('secret.set', { key: String(key), value: String(value) });
    },
    deleteSecret(key) {
      return hostCall('secret.delete', { key: String(key) });
    },
    debug(...args) {
      send({ type: 'log', level: 'debug', message: args.map(String).join(' ') });
    },
    warn(...args) {
      send({ type: 'log', level: 'warn', message: args.map(String).join(' ') });
    },
    log(...args) {
      send({ type: 'log', level: 'info', message: args.map(String).join(' ') });
    },
    error(...args) {
      send({ type: 'log', level: 'error', message: args.map(String).join(' ') });
    },
  };
}

async function start(mainPath, name, cfg, selectedLanguage, selectedTranslations) {
  instanceName = name;
  currentConfig = cfg || {};
  language = selectedLanguage || language;
  translations = selectedTranslations || {};
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const factory = require(mainPath);
  const create = typeof factory === 'function' ? factory : factory && factory.createAdapter;
  if (typeof create !== 'function') {
    throw new Error('Adapter exportiert keine createAdapter(host)-Funktion');
  }
  adapter = create(buildHost());
  if (adapter && typeof adapter.start === 'function') {
    await adapter.start(currentConfig);
  }
  send({ type: 'ready' });
}

async function stop() {
  try {
    if (adapter && typeof adapter.stop === 'function') await adapter.stop();
  } catch (err) {
    send({ type: 'log', level: 'error', message: `stop fehlgeschlagen: ${err.message}` });
  } finally {
    process.exit(0);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    start(msg.mainPath, msg.name, msg.config, msg.language, msg.translations).catch((err) => {
      send({ type: 'error', message: err && err.message ? err.message : String(err) });
      process.exit(1);
    });
  } else if (msg.type === 'stop') {
    stop();
  } else if (msg.type === 'write') {
    try {
      if (adapter && typeof adapter.write === 'function') adapter.write(msg.address, msg.value);
    } catch (err) {
      send({ type: 'log', level: 'error', message: `write fehlgeschlagen: ${err.message}` });
    }
  } else if (msg.type === 'read') {
    try {
      if (adapter && typeof adapter.read === 'function') adapter.read(msg.address);
    } catch (err) {
      send({ type: 'log', level: 'error', message: `read fehlgeschlagen: ${err.message}` });
    }
  } else if (msg.type === 'config') {
    currentConfig = msg.config || {};
  } else if (msg.type === 'state-value') {
    const listener = subscriptions.get(String(msg.subscriptionId));
    if (listener) {
      try {
        listener(msg.value, { receivedAt: msg.receivedAt });
      } catch (err) {
        send({ type: 'log', level: 'error', message: `State-Listener fehlgeschlagen: ${err.message}` });
      }
    }
  } else if (msg.type === 'host-call-result') {
    const pending = hostCalls.get(String(msg.requestId));
    if (!pending) return;
    hostCalls.delete(String(msg.requestId));
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(String(msg.error)));
    else pending.resolve(msg.result);
  } else if (msg.type === 'management') {
    Promise.resolve()
      .then(() => {
        if (!adapter || typeof adapter.handleManagementRequest !== 'function') {
          return { status: 404, json: { error: 'Adapter stellt keine Verwaltungs-API bereit.' } };
        }
        return adapter.handleManagementRequest(msg.request || {});
      })
      .then((response) => {
        if (response && response.view) response = { ...response, view: {
          ...response.view,
          title: localize(response.view.title),
          body: localize(response.view.body),
          script: localize(response.view.script),
        } };
        send({ type: 'management-result', requestId: msg.requestId, response });
      })
      .catch((err) => send({ type: 'management-result', requestId: msg.requestId,
        response: { status: 500, json: { error: err && err.message ? err.message : String(err) } } }));
  }
});

// Unbehandelte Fehler im Adapter dürfen nur diesen Kindprozess beenden – der
// Supervisor im Hauptprozess startet ihn neu. homeESS selbst bleibt unberührt.
process.on('uncaughtException', (err) => {
  send({ type: 'error', message: `uncaughtException: ${err && err.message}` });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ type: 'error', message: `unhandledRejection: ${err && (err.message || err)}` });
  process.exit(1);
});
