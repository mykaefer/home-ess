'use strict';

// MQTT-Broker-Adapter für homeESS.
//
// Der Adapter betreibt einen vollwertigen MQTT-Broker (Server). Verbundene
// Clients legen ihre States selbst an: Jedes veröffentlichte Topic wird zur
// State-Adresse unter `mqttbroker://<instanz>/<topic>`. States, die länger als
// die eingestellte Idle-Haltezeit nicht mehr aktualisiert wurden, entfernt der
// Adapter vollständig — damit füllt sich der States-Baum nicht mit Karteileichen.
//
// Ist der systemweite State-Zugriff aktiviert, erscheint zusätzlich der gesamte
// homeESS-States-Baum unterhalb von `states/`; aus jedem Prefix wird dabei ein
// Unterverzeichnis (`hdp://…` → `states/hdp/…`). Der eigene Prefix bleibt
// ausgespart, sonst spiegelte sich der Broker endlos selbst. Geschrieben werden
// darf dort nur, was homeESS als schreibbar führt; neue States entstehen im
// states/-Baum grundsätzlich nicht.
//
// Vertrag und Host-API: siehe ADAPTER.md im Wurzelverzeichnis.

const fs = require('fs');
const path = require('path');
const { MqttBroker } = require('./broker');
const { DeviceStates } = require('./device-states');
const { SystemTree, parseHomeTopic, DEFAULT_ROOT } = require('./system-tree');
const { buildTopicTree, buildStateTree } = require('./topic-tree');
const { decodePayload, encodeValue } = require('./payload');
const manifest = require('./adapter.json');

const CATALOG_DEBOUNCE_MS = 300;
const PERSIST_DEBOUNCE_MS = 15000;
const SWEEP_INTERVAL_MS = 60000;
const RETRY_LISTEN_MS = 15000;
const DIAGNOSTIC_PREFIX = '$SYS/';
const STORAGE_FILE = 'device-states.json';
const STORAGE_KEY = 'deviceStates';
const WARN_INTERVAL_MS = 60000;
const MAX_WARN_KEYS = 200;

function numberSetting(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max == null ? Number.MAX_SAFE_INTEGER : max, Math.max(min == null ? 0 : min, number));
  return Math.round(clamped);
}

function boolSetting(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (['1', 'true', 'on', 'ja', 'yes'].includes(text)) return true;
  if (['0', 'false', 'off', 'nein', 'no'].includes(text)) return false;
  return fallback;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function shorten(value, length = 60) {
  const text = String(value == null ? '' : value);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

module.exports = function createMqttBrokerAdapter(host) {
  const t = (key, fallback) => (typeof host.t === 'function' ? host.t(key, fallback) : fallback);

  let cfg = {};
  let broker = null;
  let deviceStates = null;
  let systemTree = null;
  let dataDirectory = null;
  let listening = false;
  let lastError = '';

  const mirrors = new Map(); // states/-Topic -> Abmeldefunktion des Host-Abos
  const warnedAt = new Map(); // Meldungsschlüssel -> Zeitpunkt der letzten Warnung

  let catalogTimer = null;
  let persistTimer = null;
  let sweepTimer = null;
  let refreshTimer = null;
  let retryTimer = null;
  let catalogListStatesUnavailable = false;

  // ── Konfiguration ────────────────────────────────────────────────────────────

  function applyConfig(config) {
    const source = config || {};
    cfg = {
      // Port 0 überlässt dem Betriebssystem die Wahl (nur für Tests sinnvoll).
      port: numberSetting(source.port, 1883, 0, 65535),
      bindAddress: String(source.bindAddress || '0.0.0.0').trim() || '0.0.0.0',
      allowAnonymous: boolSetting(source.allowAnonymous, true),
      username: String(source.username || ''),
      password: String(source.password || ''),
      ipRange: String(source.ipRange || '').trim(),
      idleMinutes: numberSetting(source.idleMinutes, 1440, 0, 525600),
      maxStates: numberSetting(source.maxStates, 500, 1, 20000),
      maxClients: numberSetting(source.maxClients, 32, 1, 1000),
      jsonPayload: boolSetting(source.jsonPayload, true),
      systemAccess: boolSetting(source.systemAccess, false),
      maxSystemStates: numberSetting(source.maxSystemStates, 1000, 1, 20000),
      catalogRefreshSeconds: numberSetting(source.catalogRefreshSeconds, 60, 10, 3600),
    };
    cfg.idleMs = cfg.idleMinutes * 60000;
    return cfg;
  }

  // Wiederkehrende Meldungen höchstens einmal pro Minute je Anlass. Die Tabelle
  // bleibt begrenzt, damit ein Client sie nicht mit immer neuen Topics aufbläht.
  function warnThrottled(key, message) {
    const now = Date.now();
    if (now - (warnedAt.get(key) || 0) < WARN_INTERVAL_MS) return;
    if (warnedAt.size >= MAX_WARN_KEYS) warnedAt.clear();
    warnedAt.set(key, now);
    host.warn(message);
  }

  // ── Persistenz der Geräte-States ─────────────────────────────────────────────

  function storagePath() {
    return dataDirectory ? path.join(dataDirectory, STORAGE_FILE) : '';
  }

  async function loadPersisted() {
    if (typeof host.getDataDirectory === 'function') {
      dataDirectory = await host.getDataDirectory().catch(() => null);
    }
    let rows = [];
    const file = storagePath();
    if (file) {
      try {
        rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        rows = [];
      }
    }
    if (!Array.isArray(rows) || !rows.length) {
      const fallback = host.getConfig ? host.getConfig()[STORAGE_KEY] : null;
      rows = Array.isArray(fallback) ? fallback : [];
    }
    const restored = deviceStates.restore(rows, cfg.idleMs);
    if (restored) host.log(`${restored} bekannte Geräte-States übernommen.`);
  }

  function persistNow() {
    if (!deviceStates) return;
    const snapshot = deviceStates.snapshot();
    const file = storagePath();
    if (file) {
      try {
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        fs.renameSync(temporary, file);
        return;
      } catch (err) {
        warnThrottled('persist', `Geräte-States konnten nicht gespeichert werden: ${err.message}`);
      }
    }
    if (typeof host.setStorage === 'function') host.setStorage(STORAGE_KEY, snapshot);
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
    if (persistTimer.unref) persistTimer.unref();
  }

  // ── State-Katalog ────────────────────────────────────────────────────────────

  function diagnosticStates() {
    return [
      { address: `${DIAGNOSTIC_PREFIX}clients`, name: t('connected_clients', 'Verbundene Clients'), category: t('broker_category', 'Broker'), unit: '', writable: false },
      { address: `${DIAGNOSTIC_PREFIX}states`, name: t('device_state_count', 'Geräte-States'), category: t('broker_category', 'Broker'), unit: '', writable: false },
      { address: `${DIAGNOSTIC_PREFIX}mirrors`, name: t('mirrored_states', 'Gespiegelte System-States'), category: t('broker_category', 'Broker'), unit: '', writable: false },
      { address: `${DIAGNOSTIC_PREFIX}online`, name: t('broker_online', 'Broker aktiv'), category: t('broker_category', 'Broker'), unit: '', writable: false },
    ];
  }

  function publishCatalog() {
    if (!deviceStates) return;
    host.setStates([...diagnosticStates(), ...deviceStates.catalog()]);
  }

  function scheduleCatalog() {
    if (catalogTimer) return;
    catalogTimer = setTimeout(() => {
      catalogTimer = null;
      publishCatalog();
    }, CATALOG_DEBOUNCE_MS);
    if (catalogTimer.unref) catalogTimer.unref();
  }

  function publishDiagnostics() {
    host.publishStates([
      { address: `${DIAGNOSTIC_PREFIX}clients`, value: broker ? broker.clients.size : 0 },
      { address: `${DIAGNOSTIC_PREFIX}states`, value: deviceStates ? deviceStates.size : 0 },
      { address: `${DIAGNOSTIC_PREFIX}mirrors`, value: mirrors.size },
      { address: `${DIAGNOSTIC_PREFIX}online`, value: listening },
    ]);
  }

  function updateStatus() {
    if (!listening) {
      host.setConnected(false, lastError || t('broker_stopped', 'Broker nicht gestartet'));
      return;
    }
    const clients = broker ? broker.clients.size : 0;
    const detail = `${t('port', 'Port')} ${broker ? broker.port : cfg.port} · ${clients} ${t('clients', 'Clients')} · ${deviceStates ? deviceStates.size : 0} States`;
    host.setConnected(true, detail);
  }

  // ── Geräte-States (Topics der verbundenen Clients) ───────────────────────────

  function handleDevicePublish(topic, payload, retain) {
    // Leere Retained Message ist die MQTT-Löschsemantik: Das Gerät räumt sein
    // Topic ausdrücklich ab, der State verschwindet mit.
    if (retain && (!payload || !payload.length)) {
      if (removeDeviceState(topic)) {
        host.log(`State ${topic} durch leere Retained Message entfernt.`);
        publishCatalog();
        publishDiagnostics();
        schedulePersist();
      }
      return;
    }
    const value = decodePayload(payload, { json: cfg.jsonPayload });
    const result = deviceStates.update(topic, value, { retain, now: Date.now() });
    if (result.rejected) {
      warnThrottled('limit', `Mengenlimit von ${cfg.maxStates} States erreicht – "${shorten(topic, 80)}" wurde nicht angelegt.`);
      return;
    }
    // Weiterverteilen wie ein gewöhnlicher Broker (inklusive Retained-Ablage) …
    broker.publish(topic, payload, { retain });
    // … und den Wert in den homeESS-Bus melden.
    host.publishState(topic, value);
    if (result.created) {
      host.debug(`Neuer State: ${topic}`);
      scheduleCatalog();
      publishDiagnostics();
    }
    schedulePersist();
  }

  // ── Systemweiter State-Zugriff (states/…) ────────────────────────────────────

  function addMirror(mqttTopic) {
    if (mirrors.has(mqttTopic)) return;
    const entry = systemTree.entryByMqttTopic(mqttTopic);
    if (!entry) return;
    try {
      const unsubscribe = host.subscribeState(entry.homeTopic, (value) => {
        if (!broker) return;
        broker.publish(mqttTopic, encodeValue(value), { retain: true });
      });
      mirrors.set(mqttTopic, unsubscribe);
    } catch (err) {
      warnThrottled('mirror', `State ${entry.homeTopic} konnte nicht abonniert werden: ${err.message}`);
    }
  }

  function removeMirror(mqttTopic, options = {}) {
    const unsubscribe = mirrors.get(mqttTopic);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (_) {
        /* Abo bereits beendet */
      }
      mirrors.delete(mqttTopic);
    }
    if (!broker) return;
    if (options.clearRetained) broker.publish(mqttTopic, Buffer.alloc(0), { retain: true });
    else broker.forgetRetained(mqttTopic);
  }

  // Abos der Clients und gespiegelte States abgleichen. Gespiegelt wird nur,
  // was tatsächlich jemand abonniert hat.
  function syncMirrors() {
    if (!broker) return;
    if (!cfg.systemAccess) {
      for (const topic of Array.from(mirrors.keys())) removeMirror(topic);
      return;
    }
    const filters = broker.activeFilters();
    const desired = systemTree.matching(filters, cfg.maxSystemStates);
    for (const topic of Array.from(mirrors.keys())) {
      if (!desired.has(topic)) removeMirror(topic);
    }
    for (const topic of desired) addMirror(topic);
    if (desired.size >= cfg.maxSystemStates) {
      const wanted = systemTree.matching(filters, 0).size;
      if (wanted > cfg.maxSystemStates) {
        warnThrottled('mirror-limit', `Abo umfasst ${wanted} System-States; gespiegelt werden nur ${cfg.maxSystemStates} (Einstellung "Maximal gespiegelte System-States").`);
      }
    }
    publishDiagnostics();
  }

  async function refreshSystemCatalog() {
    if (!cfg.systemAccess || !broker) return;
    if (typeof host.listStates !== 'function') {
      if (!catalogListStatesUnavailable) {
        catalogListStatesUnavailable = true;
        host.warn('Diese homeESS-Version stellt keinen systemweiten State-Katalog bereit; states/ bleibt leer.');
      }
      return;
    }
    try {
      const list = await host.listStates();
      const diff = systemTree.refresh(list);
      for (const topic of diff.removed) removeMirror(topic, { clearRetained: true });
      if (diff.added.length || diff.removed.length) {
        host.debug(`Systembaum: ${diff.total} States (+${diff.added.length}/-${diff.removed.length}).`);
      }
      // Zwei States auf demselben Topic: der zweite bleibt unsichtbar. Das darf
      // nicht unbemerkt geschehen, sonst sucht man den State vergeblich.
      if (diff.collisions.length) {
        const first = diff.collisions[0];
        warnThrottled('collision', `${diff.collisions.length} State(s) teilen sich ein MQTT-Topic und bleiben im states/-Baum unsichtbar, z. B. ${first.homeTopic} → ${first.mqttTopic}.`);
      }
      syncMirrors();
    } catch (err) {
      warnThrottled('catalog', `Systembaum konnte nicht gelesen werden: ${err.message}`);
    }
  }

  function handleSystemPublish(topic, payload, client) {
    if (!cfg.systemAccess) {
      host.debug(`states/-Topic von ${client && client.id} verworfen: systemweiter Zugriff ist deaktiviert.`);
      return;
    }
    const entry = systemTree.entryByMqttTopic(topic);
    if (!entry) {
      // Ausdrücklich kein Anlegen: der states/-Baum bildet ausschließlich
      // bestehende homeESS-States ab.
      warnThrottled(`unknown:${topic}`, `Unbekannter State "${shorten(topic, 100)}" – im states/-Baum werden keine neuen States angelegt.`);
      return;
    }
    if (!entry.writable) {
      warnThrottled(`readonly:${topic}`, `State ${entry.homeTopic} ist schreibgeschützt; Schreibversuch von ${client && client.id} verworfen.`);
      return;
    }
    const value = decodePayload(payload, { json: cfg.jsonPayload });
    Promise.resolve()
      .then(() => host.writeState(entry.homeTopic, value))
      .catch((err) => warnThrottled(`write:${topic}`, `Schreiben auf ${entry.homeTopic} fehlgeschlagen: ${err.message}`));
    // Der neue Wert wird nicht selbst weiterverteilt: er kommt über das
    // Spiegel-Abo zurück, sobald homeESS ihn übernommen hat.
  }

  // ── Idle-Haltezeit ───────────────────────────────────────────────────────────

  function sweepIdleStates() {
    if (!deviceStates || !cfg.idleMs) return [];
    const removed = deviceStates.sweep(cfg.idleMs);
    if (!removed.length) return removed;
    for (const address of removed) {
      // Leere Retained Message: Clients verwerfen den Wert ebenfalls.
      if (broker) broker.publish(address, Buffer.alloc(0), { retain: true });
    }
    host.log(`${removed.length} State(s) nach ${cfg.idleMinutes} min ohne Aktualisierung entfernt.`);
    publishCatalog();
    publishDiagnostics();
    persistNow();
    return removed;
  }

  // ── Broker ───────────────────────────────────────────────────────────────────

  function authenticate({ clientId, username, password, ip }) {
    if (cfg.username || cfg.password) {
      if (username === cfg.username && password === cfg.password) return true;
      if (cfg.allowAnonymous && !username && !password) return true;
      host.debug(`Falsche Zugangsdaten von ${clientId} (${ip}).`);
      return false;
    }
    if (!cfg.allowAnonymous) {
      warnThrottled('anonymous', 'Anonyme Anmeldungen sind deaktiviert, es sind aber keine Zugangsdaten hinterlegt.');
      return false;
    }
    return true;
  }

  function wireBroker() {
    broker.on('publish', ({ topic, payload, retain, client }) => {
      if (systemTree.isSystemTopic(topic)) {
        handleSystemPublish(topic, payload, client);
        return;
      }
      handleDevicePublish(topic, payload, retain);
    });
    broker.on('connect', ({ client }) => {
      host.log(`Client verbunden: ${client.id} (${client.ip || 'unbekannt'})`);
      updateStatus();
      publishDiagnostics();
    });
    broker.on('disconnect', ({ client }) => {
      host.debug(`Client getrennt: ${client.id}`);
      syncMirrors();
      updateStatus();
      publishDiagnostics();
    });
    broker.on('subscribe', () => syncMirrors());
    broker.on('unsubscribe', () => syncMirrors());
    broker.on('error', (err) => {
      lastError = err && err.message ? err.message : String(err);
      host.error(`Broker-Fehler: ${lastError}`);
      listening = false;
      updateStatus();
      scheduleListen();
    });
  }

  function scheduleListen() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startListening().catch(() => {});
    }, RETRY_LISTEN_MS);
    if (retryTimer.unref) retryTimer.unref();
  }

  async function startListening() {
    if (!broker || listening) return;
    try {
      await broker.listen(cfg.port, cfg.bindAddress);
      listening = true;
      lastError = '';
      host.log(`MQTT-Broker lauscht auf ${cfg.bindAddress}:${broker.port}.`);
      // Bekannte Werte als Retained Messages bereitstellen, damit Clients nach
      // einem Neustart sofort den letzten Stand erhalten.
      for (const entry of deviceStates.snapshot()) {
        if (entry.retained && entry.value != null) broker.publish(entry.address, encodeValue(entry.value), { retain: true });
      }
    } catch (err) {
      listening = false;
      lastError = err && err.code === 'EADDRINUSE'
        ? `Port ${cfg.port} ist belegt`
        : (err && err.message ? err.message : String(err));
      host.error(`Broker konnte nicht starten: ${lastError}`);
      scheduleListen();
    }
    updateStatus();
    publishDiagnostics();
  }

  // ── Topic-Browser ────────────────────────────────────────────────────────────

  // Letzter über MQTT verteilter Wert eines Topics. Für Geräte-States steht der
  // Wert ohnehin in der Ablage; im Systembaum kennt ihn nur die Retained-Ablage
  // des Brokers — und auch nur, solange der State gespiegelt wird.
  function retainedValue(topic) {
    if (!broker || !broker.retained) return undefined;
    const kept = broker.retained.get(topic);
    if (!kept) return undefined;
    return decodePayload(kept.payload, { json: cfg.jsonPayload });
  }

  // Alle über MQTT erreichbaren Topics dieser Instanz: die von Clients selbst
  // angelegten Geräte-Topics und — sofern freigeschaltet — der Systembaum unter
  // states/. Die Diagnose-States ($SYS/…) bleiben außen vor: sie existieren nur
  // in homeESS und werden nicht über den Broker verteilt.
  // Geräte-Topics eines Brokers gehören unter „MQTT-Geräte / <Instanz>" — die
  // eigene Instanz genauso wie fremde. Nur dort dürfen MQTT-Clients States frei
  // anlegen; im states/-Baum darunter ist das ausgeschlossen.
  function deviceCategory(instanceName, address) {
    const parents = String(address || '').split('/').filter(Boolean).slice(0, -1);
    return [t('device_root', 'MQTT-Geräte'), String(instanceName || '—'), ...parents].join(' / ');
  }

  // Verzeichnis der eigenen Geräte-Topics. Es steht auch dann im Baum, wenn noch
  // kein Client etwas veröffentlicht hat.
  function ownDeviceCategory() {
    return `${t('device_root', 'MQTT-Geräte')} / ${host.name}`;
  }

  // homeESS setzt Fremd-States den Instanznamen voran („Broker EG – temp").
  // Unterhalb des Instanzverzeichnisses ist das doppelt gemoppelt.
  function stripInstancePrefix(name, instanceName) {
    const prefix = `${String(instanceName || '')} – `;
    const text = String(name || '');
    return instanceName && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  function topicInventory() {
    const rows = [];
    if (deviceStates) {
      const catalog = new Map(deviceStates.catalog().map((state) => [state.address, state]));
      for (const entry of deviceStates.snapshot()) {
        const meta = catalog.get(entry.address) || {};
        rows.push({
          topic: entry.address,
          source: 'device',
          instance: host.name,
          name: meta.name || entry.address,
          category: deviceCategory(host.name, entry.address),
          writable: true,
          value: entry.value === undefined ? null : entry.value,
          updatedAt: entry.updatedAt,
          homeTopic: `${manifest.prefix}://${host.name}/${entry.address}`,
        });
      }
    }
    if (cfg.systemAccess && systemTree) {
      for (const entry of systemTree.entries()) {
        // Der gespiegelte Wert ist der frischere; sonst gilt der Stand des
        // letzten Katalogabgleichs.
        const retained = retainedValue(entry.mqttTopic);
        const parsed = parseHomeTopic(entry.homeTopic);
        const foreignBroker = parsed && parsed.scheme === manifest.prefix;
        rows.push({
          topic: entry.mqttTopic,
          source: foreignBroker ? 'broker' : 'system',
          instance: parsed ? parsed.instance : '',
          name: foreignBroker
            ? stripInstancePrefix(entry.name, parsed.instance) || entry.homeTopic
            : (entry.name || entry.homeTopic),
          // Fremde Broker bekommen dieselbe Gliederung wie die eigene Instanz,
          // statt als „Adapter: <Instanz>" neben den übrigen Adaptern zu landen.
          category: foreignBroker ? deviceCategory(parsed.instance, parsed.address) : (entry.category || ''),
          writable: !!entry.writable,
          unit: entry.unit || '',
          value: retained === undefined ? (entry.value == null ? null : entry.value) : retained,
          mirrored: mirrors.has(entry.mqttTopic),
          homeTopic: entry.homeTopic,
        });
      }
    }
    return rows;
  }

  // Baum für die Verwaltungsseite. Die Oberfläche holt ihn getrennt von der
  // Seite ab, damit große Installationen das HTML nicht aufblähen — und je
  // Gliederung einzeln, damit immer nur ein Baum über die Leitung geht.
  function topicBrowserData(grouping) {
    const rows = topicInventory();
    const group = grouping === 'path' ? 'path' : 'category';
    const tree = group === 'path'
      ? buildTopicTree(rows)
      : buildStateTree(rows, { folders: [ownDeviceCategory()] });
    const device = rows.reduce((sum, row) => sum + (row.source === 'device' ? 1 : 0), 0);
    const broker = rows.reduce((sum, row) => sum + (row.source === 'broker' ? 1 : 0), 0);
    return {
      group,
      nodes: tree.children,
      total: tree.count,
      device,
      broker,
      system: rows.length - device - broker,
      systemAccess: !!cfg.systemAccess,
    };
  }

  // ── Verwaltungsseite ─────────────────────────────────────────────────────────

  function managementView(basePath, access) {
    const now = Date.now();
    const clients = broker ? broker.list() : [];
    const states = deviceStates ? deviceStates.snapshot().sort((a, b) => a.address.localeCompare(b.address, 'de')) : [];
    const rows = states.map((entry) => `
      <tr>
        <td><code>${escapeHtml(entry.address)}</code></td>
        <td>${escapeHtml(shorten(entry.value == null ? '—' : String(entry.value), 40))}</td>
        <td>${escapeHtml(formatAge(now - entry.updatedAt))}</td>
        <td class="mqttbroker-actions">${access.canWrite
    ? `<button type="button" class="mqttbroker-button" data-remove="${escapeHtml(entry.address)}">${escapeHtml(t('remove', 'Entfernen'))}</button>`
    : ''}</td>
      </tr>`).join('');
    const clientRows = clients.map((client) => `
      <tr>
        <td><code>${escapeHtml(client.id)}</code></td>
        <td>${escapeHtml(client.ip || '—')}</td>
        <td>${escapeHtml(formatAge(now - client.connectedAt))}</td>
        <td>${client.subscriptions.length}</td>
        <td>${client.published}</td>
      </tr>`).join('');

    const body = `
<section class="mqttbroker">
  <h1>${escapeHtml(t('broker_title', 'MQTT-Broker'))} – ${escapeHtml(host.name)}</h1>
  <div class="mqttbroker-status">
    <span><strong>${escapeHtml(t('status', 'Status'))}:</strong> ${listening
    ? `${escapeHtml(t('listening', 'aktiv auf'))} ${escapeHtml(cfg.bindAddress)}:${broker ? broker.port : cfg.port}`
    : escapeHtml(lastError || t('broker_stopped', 'Broker nicht gestartet'))}</span>
    <span><strong>${escapeHtml(t('clients', 'Clients'))}:</strong> ${clients.length} / ${cfg.maxClients}</span>
    <span><strong>${escapeHtml(t('device_state_count', 'Geräte-States'))}:</strong> ${states.length} / ${cfg.maxStates}</span>
    <span><strong>${escapeHtml(t('idle_hold', 'Idle-Haltezeit'))}:</strong> ${cfg.idleMinutes ? `${cfg.idleMinutes} min` : escapeHtml(t('disabled', 'aus'))}</span>
    <span><strong>${escapeHtml(t('system_tree', 'Systembaum'))}:</strong> ${cfg.systemAccess
    ? `${systemTree.size} States, ${mirrors.size} ${escapeHtml(t('mirrored', 'gespiegelt'))}`
    : escapeHtml(t('disabled', 'aus'))}</span>
  </div>

  <h2>${escapeHtml(t('connected_clients', 'Verbundene Clients'))}</h2>
  <table class="mqttbroker-table">
    <thead><tr>
      <th>${escapeHtml(t('client_id', 'Client-ID'))}</th><th>${escapeHtml(t('address', 'Adresse'))}</th>
      <th>${escapeHtml(t('connected_for', 'Verbunden seit'))}</th><th>${escapeHtml(t('subscriptions', 'Abos'))}</th>
      <th>${escapeHtml(t('messages', 'Nachrichten'))}</th>
    </tr></thead>
    <tbody>${clientRows || `<tr><td colspan="5" class="mqttbroker-empty">${escapeHtml(t('no_clients', 'Noch kein Client verbunden.'))}</td></tr>`}</tbody>
  </table>

  <h2>${escapeHtml(t('topic_browser', 'Topic-Browser'))}</h2>
  <div class="mqttbroker-browser">
    <div class="mqttbroker-browser-bar">
      <label class="mqttbroker-group" for="mqttbroker-group">${escapeHtml(t('grouping', 'Gliederung'))}
        <select id="mqttbroker-group">
          <option value="category">${escapeHtml(t('group_states', 'homeESS-Struktur'))}</option>
          <option value="path">${escapeHtml(t('group_path', 'MQTT-Pfad'))}</option>
        </select>
      </label>
      <input type="search" id="mqttbroker-filter" class="mqttbroker-filter" autocomplete="off"
        placeholder="${escapeHtml(t('filter_placeholder', 'Topic filtern …'))}"
        aria-label="${escapeHtml(t('filter_placeholder', 'Topic filtern …'))}">
      <button type="button" class="mqttbroker-button mqttbroker-button--quiet" data-tree="expand">${escapeHtml(t('expand_all', 'Alle aufklappen'))}</button>
      <button type="button" class="mqttbroker-button mqttbroker-button--quiet" data-tree="collapse">${escapeHtml(t('collapse_all', 'Alle zuklappen'))}</button>
      <span class="mqttbroker-browser-count" id="mqttbroker-tree-count"></span>
    </div>
    <div class="mqttbroker-tree" id="mqttbroker-tree">
      <p class="mqttbroker-empty">${escapeHtml(t('loading', 'Wird geladen …'))}</p>
    </div>
  </div>
  <p class="mqttbroker-hint">${escapeHtml(t('browser_hint', 'Die homeESS-Gliederung zeigt denselben Aufbau wie der States-Baum, die MQTT-Gliederung den Topic-Pfad. Der Kopierknopf übernimmt in beiden Fällen den vollständigen MQTT-Pfad — bei Verzeichnissen der MQTT-Gliederung den passenden Abo-Filter mit „/#“.'))}</p>
  ${cfg.systemAccess ? '' : `<p class="mqttbroker-hint">${escapeHtml(t('browser_system_hint', 'Der Systembaum states/ erscheint erst, wenn der systemweite State-Zugriff in den Instanzeinstellungen aktiviert ist.'))}</p>`}

  <h2>${escapeHtml(t('device_states', 'Geräte-States'))}</h2>
  <table class="mqttbroker-table">
    <thead><tr>
      <th>${escapeHtml(t('topic', 'Topic'))}</th><th>${escapeHtml(t('value', 'Wert'))}</th>
      <th>${escapeHtml(t('last_update', 'Letzte Aktualisierung'))}</th><th></th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="mqttbroker-empty">${escapeHtml(t('no_states', 'Noch keine States angelegt.'))}</td></tr>`}</tbody>
  </table>
  <p class="mqttbroker-hint">${escapeHtml(t('states_hint', 'States entstehen automatisch, sobald ein Client auf ein Topic veröffentlicht. Ohne Aktualisierung innerhalb der Idle-Haltezeit werden sie wieder entfernt.'))}</p>
  ${access.canWrite && states.length ? `<p><button type="button" class="mqttbroker-button mqttbroker-button--danger" id="mqttbroker-clear">${escapeHtml(t('remove_all', 'Alle States entfernen'))}</button></p>` : ''}
</section>`;

    const script = `
(function () {
  var base = ${JSON.stringify(basePath)};
  function send(url, payload) {
    return fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload || {}),
    }).then(function (response) {
      if (!response.ok) throw new Error('failed');
      location.reload();
    }).catch(function () { alert(${JSON.stringify(t('action_failed', 'Aktion fehlgeschlagen.'))}); });
  }
  document.querySelectorAll('[data-remove]').forEach(function (button) {
    button.addEventListener('click', function () {
      send('/states/delete', { address: button.getAttribute('data-remove') });
    });
  });
  var clear = document.getElementById('mqttbroker-clear');
  if (clear) clear.addEventListener('click', function () {
    if (confirm(${JSON.stringify(t('confirm_clear', 'Alle Geräte-States dieser Instanz entfernen?'))})) send('/states/clear', {});
  });

  // ── Topic-Browser ──────────────────────────────────────────────────────────
  var labels = {
    copyTopic: ${JSON.stringify(t('copy_topic', 'MQTT-Pfad kopieren'))},
    copyFilter: ${JSON.stringify(t('copy_filter', 'Abo-Filter kopieren'))},
    readOnly: ${JSON.stringify(t('read_only', 'schreibgeschützt'))},
    topics: ${JSON.stringify(t('topics', 'Topics'))},
    empty: ${JSON.stringify(t('no_topics', 'Noch keine Topics vorhanden.'))},
    noMatch: ${JSON.stringify(t('no_match', 'Kein Topic passt zum Filter.'))},
    failed: ${JSON.stringify(t('browser_failed', 'Topic-Liste konnte nicht geladen werden.'))}
  };
  var treeHost = document.getElementById('mqttbroker-tree');
  var treeCount = document.getElementById('mqttbroker-tree-count');
  var treeFilter = document.getElementById('mqttbroker-filter');
  var treeGroup = document.getElementById('mqttbroker-group');
  var views = [];
  var cache = {};
  var grouping = 'category';
  var totalTopics = 0;
  var filtering = false;

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function shortValue(entry) {
    if (entry.value === null || entry.value === undefined) return '—';
    var text = String(entry.value);
    return text.length > 40 ? text.slice(0, 39) + '…' : text;
  }

  // Ein Verzeichnis bleibt eines, auch wenn es (noch) leer ist — der Bereich für
  // die frei anlegbaren Geräte-Topics steht immer im Baum.
  function isFolder(node) {
    return !!node.folder || (node.children && node.children.length > 0);
  }

  function copyButton(text, label) {
    var button = element('button', 'mqttbroker-copy', '📋');
    button.type = 'button';
    button.setAttribute('data-copy', text);
    button.title = label + ': ' + text;
    button.setAttribute('aria-label', label + ': ' + text);
    return button;
  }

  // Eine Zeile: Bezeichnung, bei Verzeichnissen die Anzahl darunterliegender
  // States, bei States zusätzlich die Zweitzeile und der letzte Wert.
  //
  // In der homeESS-Gliederung ist die Bezeichnung der Klarname des States und
  // die Zweitzeile sein MQTT-Pfad; in der MQTT-Gliederung ist es umgekehrt der
  // Pfadabschnitt mit dem Klarnamen daneben — sonst stünde dort nur „1".
  function buildRow(node) {
    var row = element('div', 'mqttbroker-row');
    var folder = isFolder(node);
    var byPath = grouping === 'path';
    row.appendChild(element('span', 'mqttbroker-row-name', node.name));
    if (folder) row.appendChild(element('span', 'mqttbroker-badge', String(node.count)));
    if (node.entry) {
      var second = byPath ? (node.entry.name || '') : node.path;
      if (second && second !== node.name) row.appendChild(element('code', 'mqttbroker-row-path', second));
      else row.appendChild(element('span', 'mqttbroker-spacer'));
      row.appendChild(element('span', 'mqttbroker-row-value', shortValue(node.entry)));
      if (!node.entry.writable) {
        var lock = element('span', 'mqttbroker-badge mqttbroker-badge--lock', '🔒');
        lock.title = labels.readOnly;
        row.appendChild(lock);
      }
      row.title = node.path + (node.entry.homeTopic ? '\\n' + node.entry.homeTopic : '');
    } else {
      // Reine Verzeichniszeile: der Platzhalter schiebt den Kopierknopf ans Ende.
      row.appendChild(element('span', 'mqttbroker-spacer'));
    }
    // Kategorien der homeESS-Gliederung haben keinen MQTT-Pfad — dort gibt es
    // nur an den States etwas zu kopieren.
    if (node.entry) row.appendChild(copyButton(node.path, labels.copyTopic));
    else if (node.path) row.appendChild(copyButton(node.path + '/#', labels.copyFilter));
    return row;
  }

  function buildNode(node) {
    var view = {
      node: node,
      // Gesucht wird über Klarname und MQTT-Pfad zugleich.
      haystack: (String(node.name || '') + ' ' + String(node.path || '')).toLowerCase(),
      children: [], details: null, element: null, userOpen: false,
    };
    if (isFolder(node)) {
      var details = element('details', 'mqttbroker-node');
      var summary = element('summary', 'mqttbroker-summary');
      summary.appendChild(buildRow(node));
      details.appendChild(summary);
      var box = element('div', 'mqttbroker-children');
      for (var i = 0; i < node.children.length; i += 1) {
        var child = buildNode(node.children[i]);
        view.children.push(child);
        box.appendChild(child.element);
      }
      details.appendChild(box);
      details.addEventListener('toggle', function () {
        if (!filtering) view.userOpen = details.open;
      });
      view.details = details;
      view.element = details;
    } else {
      var leaf = element('div', 'mqttbroker-node mqttbroker-node--leaf');
      leaf.appendChild(buildRow(node));
      view.element = leaf;
    }
    return view;
  }

  function updateCount(visible) {
    if (!treeCount) return;
    treeCount.textContent = filtering
      ? visible + ' / ' + totalTopics + ' ' + labels.topics
      : totalTopics + ' ' + labels.topics;
  }

  function renderTree(data) {
    treeHost.textContent = '';
    views = [];
    totalTopics = data && data.total ? data.total : 0;
    var nodes = (data && data.nodes) || [];
    if (!nodes.length) {
      treeHost.appendChild(element('p', 'mqttbroker-empty', labels.empty));
      updateCount(0);
      return;
    }
    for (var i = 0; i < nodes.length; i += 1) {
      var view = buildNode(nodes[i]);
      views.push(view);
      treeHost.appendChild(view.element);
    }
    updateCount(totalTopics);
  }

  // Filtern blendet Zeilen aus, statt den Baum neu zu bauen: passende Ebenen
  // klappen auf, beim Leeren des Feldes gilt wieder der Stand von Hand.
  function applyFilter() {
    var query = ((treeFilter && treeFilter.value) || '').trim().toLowerCase();
    filtering = query.length > 0;
    var visible = 0;

    function walk(view, forced) {
      var self = forced || !query || view.haystack.indexOf(query) >= 0;
      var childVisible = false;
      for (var i = 0; i < view.children.length; i += 1) {
        if (walk(view.children[i], self)) childVisible = true;
      }
      var show = self || childVisible;
      view.element.style.display = show ? '' : 'none';
      if (view.details) view.details.open = filtering ? show : view.userOpen;
      if (show && view.node.entry) visible += 1;
      return show;
    }

    for (var i = 0; i < views.length; i += 1) walk(views[i], false);
    updateCount(visible);
    var note = document.getElementById('mqttbroker-nomatch');
    if (filtering && !visible && !note) {
      note = element('p', 'mqttbroker-empty', labels.noMatch);
      note.id = 'mqttbroker-nomatch';
      treeHost.appendChild(note);
    } else if ((!filtering || visible) && note) {
      note.parentNode.removeChild(note);
    }
  }

  // Ohne HTTPS fehlt die Clipboard-API; im lokalen Netz ist das der Normalfall.
  function legacyCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '0';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(field);
    return copied;
  }

  function confirmCopy(button) {
    button.textContent = '✓';
    button.classList.add('is-copied');
    setTimeout(function () {
      button.textContent = '📋';
      button.classList.remove('is-copied');
    }, 1200);
  }

  function copyText(text, button) {
    function fallback() {
      if (legacyCopy(text)) confirmCopy(button);
      else window.prompt(labels.copyTopic, text);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { confirmCopy(button); }, fallback);
      return;
    }
    fallback();
  }

  if (treeHost) {
    treeHost.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('[data-copy]') : null;
      if (!button) return;
      // Ohne preventDefault würde der Klick in der Summary-Zeile zusätzlich
      // die Ebene auf- oder zuklappen.
      event.preventDefault();
      event.stopPropagation();
      copyText(button.getAttribute('data-copy'), button);
    });
    document.querySelectorAll('[data-tree]').forEach(function (button) {
      button.addEventListener('click', function () {
        var open = button.getAttribute('data-tree') === 'expand';
        var walk = function (view) {
          if (view.details) {
            view.details.open = open;
            view.userOpen = open;
          }
          view.children.forEach(walk);
        };
        views.forEach(walk);
      });
    });
    // Jede Gliederung wird einmal geholt und danach aus dem Zwischenspeicher
    // gezeichnet — Umschalten kostet dann keine Runde zum Server mehr.
    function loadTree(group) {
      grouping = group;
      if (cache[group]) {
        renderTree(cache[group]);
        applyFilter();
        return;
      }
      treeHost.textContent = '';
      treeHost.appendChild(element('p', 'mqttbroker-empty', ${JSON.stringify(t('loading', 'Wird geladen …'))}));
      fetch(base + '/topics?group=' + encodeURIComponent(group), { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('failed');
          return response.json();
        })
        .then(function (data) {
          if (grouping !== group) return;
          cache[group] = data;
          renderTree(data);
          applyFilter();
        })
        .catch(function () {
          treeHost.textContent = '';
          treeHost.appendChild(element('p', 'mqttbroker-empty', labels.failed));
        });
    }

    if (treeFilter) treeFilter.addEventListener('input', applyFilter);
    if (treeGroup) treeGroup.addEventListener('change', function () { loadTree(treeGroup.value); });
    loadTree(treeGroup ? treeGroup.value : grouping);
  }
}());`;

    return { title: `${t('broker_title', 'MQTT-Broker')} – ${host.name}`, body, script };
  }

  function removeDeviceState(address) {
    if (!deviceStates.has(address)) return false;
    deviceStates.remove(address);
    if (broker) broker.publish(address, Buffer.alloc(0), { retain: true });
    return true;
  }

  // ── Adapter-Schnittstelle ────────────────────────────────────────────────────

  return {
    async start(config) {
      applyConfig(config);
      deviceStates = new DeviceStates({
        maxStates: cfg.maxStates,
        rootCategory: t('device_root', 'MQTT-Geräte'),
      });
      systemTree = new SystemTree({ ownPrefix: manifest.prefix, ownInstance: host.name, root: DEFAULT_ROOT });
      await loadPersisted();

      broker = new MqttBroker({
        maxClients: cfg.maxClients,
        ipRange: cfg.ipRange,
        authenticate,
        log: (message) => host.log(message),
        debug: (message) => host.debug(message),
      });
      wireBroker();

      publishCatalog();
      for (const entry of deviceStates.snapshot()) {
        if (entry.value != null) host.publishState(entry.address, entry.value);
      }

      // Den Systembaum vor dem ersten Client aufbauen: sonst liefe ein sofort
      // eintreffendes Abo auf states/# ins Leere.
      if (cfg.systemAccess) await refreshSystemCatalog();

      await startListening();

      sweepTimer = setInterval(sweepIdleStates, SWEEP_INTERVAL_MS);
      if (sweepTimer.unref) sweepTimer.unref();
      if (cfg.systemAccess) {
        refreshTimer = setInterval(() => {
          refreshSystemCatalog().catch(() => {});
        }, cfg.catalogRefreshSeconds * 1000);
        if (refreshTimer.unref) refreshTimer.unref();
      }
      publishDiagnostics();
    },

    async stop() {
      for (const timer of [catalogTimer, persistTimer, retryTimer]) if (timer) clearTimeout(timer);
      for (const timer of [sweepTimer, refreshTimer]) if (timer) clearInterval(timer);
      catalogTimer = persistTimer = sweepTimer = refreshTimer = retryTimer = null;
      for (const topic of Array.from(mirrors.keys())) removeMirror(topic);
      persistNow();
      listening = false;
      if (broker) await broker.close();
      broker = null;
    },

    // Schreibwunsch aus homeESS auf einen Geräte-State: an alle Abonnenten des
    // Topics senden und den Wert optimistisch übernehmen.
    write(address, value) {
      const topic = String(address || '');
      if (!broker || !topic || topic.startsWith(DIAGNOSTIC_PREFIX)) return;
      if (!deviceStates.has(topic)) {
        host.debug(`Schreibversuch auf unbekanntes Topic ${topic} verworfen.`);
        return;
      }
      broker.publish(topic, encodeValue(value), { retain: true });
      deviceStates.update(topic, value, { now: Date.now() });
      host.publishState(topic, value);
      schedulePersist();
    },

    read(address) {
      if (!deviceStates) return;
      if (!address) {
        publishDiagnostics();
        return;
      }
      const entry = deviceStates.get(String(address));
      if (entry) host.publishState(entry.address, entry.value);
      else if (String(address).startsWith(DIAGNOSTIC_PREFIX)) publishDiagnostics();
    },

    // Verwaltungsseite: Übersicht der Clients und States, Entfernen einzelner
    // oder aller Geräte-States. Anmeldung und Rollen prüft homeESS.
    handleManagementRequest(request) {
      const access = request.access || {};
      const method = String(request.method || 'GET').toUpperCase();
      const subpath = String(request.path || '/');
      if (method === 'GET' && (subpath === '/' || subpath === '')) {
        if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        return { status: 200, view: managementView(String(request.basePath || ''), access) };
      }
      if (method === 'GET' && subpath === '/topics') {
        if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        return { status: 200, json: topicBrowserData(String((request.query || {}).group || '')) };
      }
      if (method === 'POST' && subpath === '/states/delete') {
        if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        const address = String((request.body || {}).address || '');
        if (!removeDeviceState(address)) return { status: 404, json: { error: 'State unbekannt.' } };
        publishCatalog();
        publishDiagnostics();
        persistNow();
        return { status: 200, json: { ok: true } };
      }
      if (method === 'POST' && subpath === '/states/clear') {
        if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        for (const address of deviceStates.addresses()) removeDeviceState(address);
        publishCatalog();
        publishDiagnostics();
        persistNow();
        return { status: 200, json: { ok: true } };
      }
      return { status: 404, json: { error: 'Unbekannte Aktion.' } };
    },

    // Für Tests: Zugriff auf den inneren Zustand ohne Umweg über die Oberfläche.
    _internals: () => ({
      broker: () => broker,
      deviceStates: () => deviceStates,
      systemTree: () => systemTree,
      mirrors: () => mirrors,
      config: () => cfg,
      sweepIdleStates,
      refreshSystemCatalog,
      syncMirrors,
    }),
  };
};
