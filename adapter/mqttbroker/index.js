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
const { SystemTree, DEFAULT_ROOT } = require('./system-tree');
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
      systemTree = new SystemTree({ ownPrefix: manifest.prefix, root: DEFAULT_ROOT });
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
