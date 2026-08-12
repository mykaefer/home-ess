'use strict';

// InfluxDB-Adapter für homeESS.
//
// Der Adapter schreibt die Werte ausgewählter States als Historie in eine
// InfluxDB 1.x. Ausgewählt wird nicht hier, sondern im Eigenschaften-Dialog
// eines States auf der States-Seite: Dort erscheint je aktiver Instanz dieses
// Adapters ein eigener Tab (Schema siehe `stateOptions` in adapter.json). Damit
// lassen sich mehrere Datenbanken parallel bespielen, jede mit eigener Auswahl.
//
// Je State sind Messreihenname (Alias), Speichermodus (bei Wertänderung oder in
// festen Abständen), Entprellzeit und Aufbewahrungsdauer einstellbar. Die
// Aufbewahrung bildet der Adapter auf Retention Policies ab — je Dauer eine.

const { InfluxClient, formatPoint, retentionPolicyName } = require('./client');
const setup = require('./setup');

const PING_INTERVAL_MS = 30000;
const RECONNECT_INTERVAL_MS = 60000;
const OPTIONS_RELOAD_MS = 300000;
const MAX_ALIAS_LENGTH = 120;
const DIAGNOSTIC_CATEGORY = 'InfluxDB';

function numberSetting(value, fallback, min, max) {
  const number = Number(String(value == null ? '' : value).replace(',', '.'));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max == null ? Number.MAX_SAFE_INTEGER : max, Math.max(min == null ? 0 : min, number));
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

// Aus `hdp://wohnzimmer/messwerte/temperatur` wird die Messreihe
// `hdp.wohnzimmer.messwerte.temperatur` — punktgetrennt, wie in Grafana üblich.
function aliasFromTopic(topic) {
  return String(topic || '')
    .replace(/:\/\//g, '.')
    .replace(/\//g, '.')
    .replace(/\s+/g, '_')
    .slice(0, MAX_ALIAS_LENGTH);
}

function formatTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('de-DE');
  } catch (_) {
    return '—';
  }
}

module.exports = function createInfluxAdapter(host) {
  const t = (key, fallback) => (typeof host.t === 'function' ? host.t(key, fallback) : fallback);

  let cfg = {};
  let client = null;
  let connected = false;
  let lastError = '';
  let serverVersion = '';
  let stopped = false;

  // Fortschritt einer im Adapter laufenden Einrichtung (nur mit Rootrechten).
  const install = { running: false, messages: [], error: '' };
  const tracked = new Map(); // topic -> { options, alias, retention, unsubscribe, timers, lastValue, ... }
  let queue = []; // { retention, line }
  const stats = { written: 0, dropped: 0, failed: 0, lastWriteAt: 0 };
  // Aus der Datenbank gelesene Aufbewahrungsdauern (Tage) für die Auswahlliste.
  const knownRetentionDays = new Set();

  let flushTimer = null;
  let pingTimer = null;
  let optionsTimer = null;
  let reconnectTimer = null;

  // ── Konfiguration ────────────────────────────────────────────────────────────

  function applyConfig(config) {
    const source = config || {};
    cfg = {
      protocol: source.protocol === 'https' ? 'https' : 'http',
      host: String(source.host || '127.0.0.1').trim() || '127.0.0.1',
      port: numberSetting(source.port, 8086, 1, 65535),
      database: String(source.database || 'homeess').trim() || 'homeess',
      username: String(source.username || '').trim(),
      password: String(source.password || ''),
      verifyTls: boolSetting(source.verifyTls, true),
      createDatabase: boolSetting(source.createDatabase, true),
      instanceTag: boolSetting(source.instanceTag, true),
      flushSeconds: numberSetting(source.flushSeconds, 2, 1, 300),
      queueLimit: numberSetting(source.queueLimit, 5000, 100, 200000),
      // Nicht im Formular: nur für Tests und Sonderfälle über die Instanzdaten.
      timeoutMs: numberSetting(source.timeoutMs, 10000, 200, 60000),
    };
    client = new InfluxClient(cfg);
    return cfg;
  }

  // ── Diagnose-States ──────────────────────────────────────────────────────────

  function publishCatalog() {
    host.setStates([
      { address: 'status/verbunden', name: t('connected', 'Verbunden'), category: DIAGNOSTIC_CATEGORY, unit: '', writable: false },
      { address: 'status/states', name: t('tracked_states', 'Historisierte States'), category: DIAGNOSTIC_CATEGORY, unit: '', writable: false },
      { address: 'status/geschrieben', name: t('written_points', 'Geschriebene Messpunkte'), category: DIAGNOSTIC_CATEGORY, unit: '', writable: false },
      { address: 'status/warteschlange', name: t('queued_points', 'Wartende Messpunkte'), category: DIAGNOSTIC_CATEGORY, unit: '', writable: false },
      { address: 'status/verworfen', name: t('dropped_points', 'Verworfene Messpunkte'), category: DIAGNOSTIC_CATEGORY, unit: '', writable: false },
    ]);
  }

  function publishDiagnostics() {
    host.publishStates([
      { address: 'status/verbunden', value: connected },
      { address: 'status/states', value: tracked.size },
      { address: 'status/geschrieben', value: stats.written },
      { address: 'status/warteschlange', value: queue.length },
      { address: 'status/verworfen', value: stats.dropped },
    ]);
  }

  function updateStatus() {
    if (connected) {
      host.setConnected(true, `${cfg.host}:${cfg.port}/${cfg.database}${serverVersion ? ` · ${serverVersion}` : ''}`);
    } else {
      host.setConnected(false, lastError || t('not_connected', 'Nicht verbunden'));
    }
  }

  // ── Verbindung ───────────────────────────────────────────────────────────────

  async function ensureRetentionPolicies() {
    const wanted = new Set();
    for (const entry of tracked.values()) wanted.add(entry.retentionDays);
    if (!wanted.size) return;
    const existing = await client.listRetentionPolicies().catch(() => []);
    for (const policy of existing) {
      const match = /^homeess_(\d+)d$/.exec(policy.name);
      if (match) knownRetentionDays.add(Number(match[1]));
    }
    for (const days of wanted) {
      await client.ensureRetentionPolicy(days, existing).catch((error) => {
        host.warn(`Aufbewahrungsregel für ${days} Tage konnte nicht angelegt werden: ${error.message}`);
      });
    }
  }

  async function connect() {
    const info = await client.ping();
    serverVersion = info.version ? `InfluxDB ${info.version}` : '';
    const databases = await client.listDatabases();
    if (!databases.includes(cfg.database)) {
      if (!cfg.createDatabase) {
        throw new Error(`Die Datenbank "${cfg.database}" existiert nicht.`);
      }
      await client.createDatabase();
      host.log(`Datenbank "${cfg.database}" angelegt.`);
    }
    await ensureRetentionPolicies();
    publishStateOptionsSchema();
    connected = true;
    lastError = '';
    updateStatus();
    publishDiagnostics();
    return true;
  }

  async function tryConnect() {
    if (stopped) return false;
    try {
      await connect();
      return true;
    } catch (error) {
      connected = false;
      lastError = error && error.message ? error.message : String(error);
      updateStatus();
      publishDiagnostics();
      return false;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || stopped) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (connected) return;
      await tryConnect();
      if (!connected) scheduleReconnect();
    }, RECONNECT_INTERVAL_MS);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  // ── Schreiben ────────────────────────────────────────────────────────────────

  // Mehrere Instanzen dürfen dieselbe Datenbank bespielen. Der Instanzname geht
  // deshalb als Tag mit: Er ist Teil des Serienschlüssels, sodass identische
  // Messreihennamen aus verschiedenen Instanzen getrennte Serien bleiben.
  function pointTags() {
    return cfg.instanceTag ? { instance: host.name } : {};
  }

  function enqueue(entry, value, timestamp) {
    if (value === undefined) return;
    const line = formatPoint(entry.alias, value, timestamp, pointTags());
    if (!line) return;
    queue.push({ retention: entry.retention, line });
    entry.lastWriteAt = timestamp;
    if (queue.length > cfg.queueLimit) {
      const removed = queue.length - cfg.queueLimit;
      queue = queue.slice(removed);
      stats.dropped += removed;
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || stopped) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, cfg.flushSeconds * 1000);
    if (flushTimer.unref) flushTimer.unref();
  }

  async function flush() {
    if (!queue.length || !client) return;
    if (!connected) {
      // Nicht verbunden: Messpunkte bleiben in der begrenzten Warteschlange.
      scheduleReconnect();
      return;
    }
    const pending = queue;
    queue = [];
    const byRetention = new Map();
    for (const point of pending) {
      if (!byRetention.has(point.retention)) byRetention.set(point.retention, []);
      byRetention.get(point.retention).push(point.line);
    }
    for (const [retention, lines] of byRetention) {
      try {
        await client.write(lines, retention);
        stats.written += lines.length;
        stats.lastWriteAt = Date.now();
      } catch (error) {
        // Fehlgeschlagene Punkte zurück in die Warteschlange (vorne), damit die
        // Reihenfolge grob erhalten bleibt.
        queue = [...lines.map((line) => ({ retention, line })), ...queue];
        if (queue.length > cfg.queueLimit) {
          const removed = queue.length - cfg.queueLimit;
          queue = queue.slice(removed);
          stats.dropped += removed;
        }
        stats.failed += 1;
        connected = false;
        lastError = error && error.message ? error.message : String(error);
        host.warn(`Schreiben in die InfluxDB fehlgeschlagen: ${lastError}`);
        updateStatus();
        scheduleReconnect();
        break;
      }
    }
    publishDiagnostics();
  }

  // Wertänderung mit Entprellung: der erste Wert geht sofort, weitere frühestens
  // nach Ablauf der Entprellzeit — dann mit dem zuletzt gemeldeten Wert.
  function onValueChanged(entry, value) {
    entry.lastValue = value;
    entry.lastValueAt = Date.now();
    if (entry.mode !== 'change') return;
    const debounceMs = entry.debounceSeconds * 1000;
    const now = Date.now();
    if (!debounceMs || now - entry.lastWriteAt >= debounceMs) {
      enqueue(entry, value, now);
      return;
    }
    if (entry.debounceTimer) return;
    const wait = Math.max(0, debounceMs - (now - entry.lastWriteAt));
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      enqueue(entry, entry.lastValue, Date.now());
    }, wait);
    if (entry.debounceTimer.unref) entry.debounceTimer.unref();
  }

  function releaseEntry(entry) {
    if (entry.unsubscribe) {
      try {
        entry.unsubscribe();
      } catch (_) {
        /* Abo bereits beendet */
      }
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.intervalTimer) clearInterval(entry.intervalTimer);
  }

  function trackState(topic, options) {
    const entry = {
      topic,
      alias: String(options.alias || '').trim() || aliasFromTopic(topic),
      mode: options.mode === 'interval' ? 'interval' : 'change',
      intervalSeconds: numberSetting(options.intervalSeconds, 60, 1, 86400),
      debounceSeconds: numberSetting(options.debounceSeconds, 5, 0, 3600),
      retentionDays: Math.max(0, Math.round(numberSetting(options.retentionDays, 730, 0, 36500))),
      lastValue: undefined,
      lastValueAt: 0,
      lastWriteAt: 0,
      debounceTimer: null,
      intervalTimer: null,
      unsubscribe: null,
    };
    entry.retention = retentionPolicyName(entry.retentionDays);
    try {
      entry.unsubscribe = host.subscribeState(topic, (value) => onValueChanged(entry, value));
    } catch (error) {
      host.warn(`State ${topic} konnte nicht abonniert werden: ${error.message}`);
      return null;
    }
    if (entry.mode === 'interval') {
      entry.intervalTimer = setInterval(() => {
        if (entry.lastValue === undefined) return;
        enqueue(entry, entry.lastValue, Date.now());
      }, entry.intervalSeconds * 1000);
      if (entry.intervalTimer.unref) entry.intervalTimer.unref();
    }
    return entry;
  }

  // Auswahl und Einstellungen aus dem Eigenschaften-Dialog übernehmen.
  async function reloadStateOptions() {
    if (typeof host.listStateOptions !== 'function') {
      host.warn('Diese homeESS-Version kennt keine State-Optionen; es wird nichts historisiert.');
      return;
    }
    const list = await host.listStateOptions().catch((error) => {
      host.warn(`State-Auswahl konnte nicht gelesen werden: ${error.message}`);
      return null;
    });
    if (!Array.isArray(list)) return;
    const wanted = new Map();
    for (const item of list) {
      if (!item || !item.topic) continue;
      const options = item.options || {};
      if (options.enabled !== true) continue;
      wanted.set(String(item.topic), options);
    }
    // Entfallene oder geänderte States sauber abmelden …
    for (const [topic, entry] of Array.from(tracked)) {
      const options = wanted.get(topic);
      const unchanged = options
        && (String(options.alias || '').trim() || aliasFromTopic(topic)) === entry.alias
        && (options.mode === 'interval' ? 'interval' : 'change') === entry.mode
        && numberSetting(options.intervalSeconds, 60, 1, 86400) === entry.intervalSeconds
        && numberSetting(options.debounceSeconds, 5, 0, 3600) === entry.debounceSeconds
        && Math.max(0, Math.round(numberSetting(options.retentionDays, 730, 0, 36500))) === entry.retentionDays;
      if (unchanged) {
        wanted.delete(topic);
        continue;
      }
      releaseEntry(entry);
      tracked.delete(topic);
    }
    // … und neue oder geänderte anlegen.
    for (const [topic, options] of wanted) {
      const entry = trackState(topic, options);
      if (entry) tracked.set(topic, entry);
    }
    if (connected) await ensureRetentionPolicies();
    publishDiagnostics();
    host.debug(`${tracked.size} State(s) werden historisiert.`);
  }

  // ── Tab im Eigenschaften-Dialog ──────────────────────────────────────────────

  // Das Manifest deklariert ein Startschema, damit der Tab schon vor dem ersten
  // Start existiert. Zur Laufzeit meldet der Adapter es erneut — dann mit den
  // Standardwerten dieser Instanz und den in der Datenbank vorhandenen
  // Aufbewahrungsregeln zur Auswahl.
  function publishStateOptionsSchema() {
    if (typeof host.setStateOptionsSchema !== 'function') return;
    const days = Array.from(new Set([730, 365, 90, 30, 7, 0, ...knownRetentionDays]))
      .sort((left, right) => right - left);
    host.setStateOptionsSchema({
      label: `InfluxDB · ${cfg.database}`,
      hint: t('state_options_hint',
        'Historie dieses States in dieser Datenbank. Ohne Alias wird das Topic als Name der Messreihe verwendet.'),
      enabledField: 'enabled',
      fields: [
        { key: 'enabled', label: t('opt_enabled', 'Werte in dieser InfluxDB speichern'), type: 'checkbox', default: false },
        { key: 'alias', label: t('opt_alias', 'DB-Alias (Messreihe)'), type: 'text', default: '',
          hint: t('opt_alias_hint', 'Name der Messreihe. Leer = aus dem Topic abgeleitet.') },
        { key: 'mode', label: t('opt_mode', 'Speichern'), type: 'select', default: 'change', options: [
          { value: 'change', label: t('on_change', 'Bei Änderung') },
          { value: 'interval', label: t('opt_interval_mode', 'In festen Abständen') },
        ] },
        { key: 'intervalSeconds', label: t('opt_interval', 'Abstand (Sekunden)'), type: 'number', default: 60,
          hint: t('opt_interval_hint', 'Nur bei festen Abständen. Es wird der zuletzt bekannte Wert geschrieben.') },
        { key: 'debounceSeconds', label: t('opt_debounce', 'Entprellzeit (Sekunden)'), type: 'number', default: 5,
          hint: t('opt_debounce_hint', 'Mindestabstand zwischen zwei Schreibvorgängen. 0 = keine Entprellung.') },
        { key: 'retentionDays', label: t('opt_retention', 'Keepalive (Tage)'), type: 'select', default: '730',
          options: days.map((value) => ({
            value: String(value),
            label: value > 0 ? `${value} ${t('days', 'Tage')}` : t('forever', 'unbegrenzt'),
          })) },
      ],
    });
  }

  // ── Verwaltungsseite ─────────────────────────────────────────────────────────

  function setupState() {
    const installed = setup.localInstallationPresent();
    const local = client ? client.isLocal() : false;
    // Einrichtung nur, wenn sie nichts überschreiben kann: lokale Datenbank
    // gewünscht, noch keine Installation vorhanden, keine bestehende Verbindung.
    const needed = local && !installed && !connected;
    return {
      installed,
      local,
      connected,
      needed,
      // Selbst ausführen kann der Adapter nur mit Rootrechten; im Normalbetrieb
      // bleibt die Anleitung für die Root-Konsole.
      privileged: setup.canInstallLocally(),
      running: install.running,
      messages: install.messages,
      error: install.error,
    };
  }

  function managementView(basePath, access) {
    const state = setupState();
    const rows = Array.from(tracked.values())
      .sort((a, b) => a.alias.localeCompare(b.alias, 'de'))
      .map((entry) => `
        <tr>
          <td><code>${escapeHtml(entry.topic)}</code></td>
          <td><code>${escapeHtml(entry.alias)}</code></td>
          <td>${entry.mode === 'interval'
    ? `${escapeHtml(t('interval', 'Abstand'))} ${entry.intervalSeconds} s`
    : escapeHtml(t('on_change', 'Bei Änderung'))}</td>
          <td>${entry.debounceSeconds} s</td>
          <td>${entry.retentionDays ? `${entry.retentionDays} ${escapeHtml(t('days', 'Tage'))}` : escapeHtml(t('forever', 'unbegrenzt'))}</td>
          <td>${escapeHtml(formatTime(entry.lastWriteAt))}</td>
        </tr>`).join('');

    let setupPanel;
    if (state.connected) {
      setupPanel = `<p class="influx-note influx-note--ok">${escapeHtml(t('setup_connected',
        'Die Datenbank ist verbunden. Die Ersteinrichtung wird zum Schutz vorhandener Daten nicht mehr angeboten.'))}</p>`;
    } else if (!state.local) {
      setupPanel = `<p class="influx-note">${escapeHtml(t('setup_remote',
        'Es ist ein entfernter Server eingetragen. Bitte dort eine InfluxDB 1.x bereitstellen und die Zugangsdaten in den Instanzeinstellungen hinterlegen.'))}</p>`;
    } else if (state.installed) {
      setupPanel = `<p class="influx-note">${escapeHtml(t('setup_installed',
        'Auf diesem Server ist bereits eine InfluxDB installiert. Die Ersteinrichtung bleibt deshalb ausgeblendet; bitte Zugangsdaten prüfen.'))}</p>`;
    } else if (state.running) {
      setupPanel = `<p class="influx-note influx-note--busy">${escapeHtml(t('setup_running', 'Die Einrichtung läuft …'))}</p>`;
    } else {
      // Genau ein Weg, zwei Auslöser: mit Rootrechten startet ihn der Adapter
      // selbst, sonst führt ihn der Betreiber in der Root-Konsole aus.
      setupPanel = `
        ${state.privileged && access.isAdmin ? `<div class="button-row">
          <button type="button" class="influx-button" id="influxSetupStart">${escapeHtml(t('setup_start', 'Ersteinrichtung starten'))}</button>
        </div>
        <p class="influx-note">${escapeHtml(t('setup_privileged',
    'Dieser Adapter läuft mit erweiterten Rechten und kann das mitgelieferte Installationsskript selbst ausführen.'))}</p>`
    : `<p class="influx-note influx-note--warn">${escapeHtml(t('setup_no_rights',
      'homeESS läuft ohne erweiterte Rechte und kann InfluxDB nicht selbst installieren. Zur Installation von InfluxDB bitte folgendes in der Root-Konsole eingeben:'))}</p>`}
        <pre class="influx-script" id="influxCommand">${escapeHtml(setup.installCommand({ ...cfg, retentionDays: 730 }))}</pre>
        <div class="button-row">
          <button type="button" class="influx-button influx-button--secondary" id="influxCopyCommand">${escapeHtml(t('copy', 'In die Zwischenablage kopieren'))}</button>
        </div>
        <p class="influx-note">${escapeHtml(t('setup_command_hint',
    'Das Skript gehört zum Adapter und fragt das Kennwort verdeckt ab — es muss mit dem Kennwort in den Instanzeinstellungen übereinstimmen. Danach unten auf „Verbindung prüfen" klicken.'))}</p>
        <details class="influx-manual">
          <summary>${escapeHtml(t('setup_show_script', 'Inhalt des Installationsskripts anzeigen'))}</summary>
          <pre class="influx-script">${escapeHtml(setup.readScript())}</pre>
        </details>`;
    }

    const statusMessages = state.messages.slice(-10)
      .map((message) => `<li>${escapeHtml(message)}</li>`).join('')
      + (state.error ? `<li class="influx-error">${escapeHtml(state.error)}</li>` : '');

    const body = `
<section class="influx">
  <h1>${escapeHtml(t('title', 'InfluxDB'))} – ${escapeHtml(host.name)}</h1>
  <div class="influx-status">
    <span><strong>${escapeHtml(t('connection', 'Verbindung'))}:</strong> ${connected
    ? `${escapeHtml(t('connected', 'Verbunden'))} · ${escapeHtml(serverVersion || '')}`
    : escapeHtml(lastError || t('not_connected', 'Nicht verbunden'))}</span>
    <span><strong>${escapeHtml(t('server', 'Server'))}:</strong> <code>${escapeHtml(`${cfg.protocol}://${cfg.host}:${cfg.port}`)}</code></span>
    <span><strong>${escapeHtml(t('database', 'Datenbank'))}:</strong> <code>${escapeHtml(cfg.database)}</code></span>
    <span><strong>${escapeHtml(t('tracked_states', 'Historisierte States'))}:</strong> ${tracked.size}</span>
    <span><strong>${escapeHtml(t('written_points', 'Geschriebene Messpunkte'))}:</strong> ${stats.written}</span>
    <span><strong>${escapeHtml(t('queued_points', 'Wartende Messpunkte'))}:</strong> ${queue.length}</span>
  </div>

  <h2>${escapeHtml(t('setup', 'Ersteinrichtung'))}</h2>
  ${setupPanel}
  ${statusMessages ? `<ul class="influx-log">${statusMessages}</ul>` : ''}
  ${access.canWrite ? `<div class="button-row">
    <button type="button" class="influx-button influx-button--secondary" id="influxVerify">${escapeHtml(t('verify', 'Verbindung prüfen'))}</button>
  </div>` : ''}

  <h2>${escapeHtml(t('tracked_states', 'Historisierte States'))}</h2>
  <table class="influx-table">
    <thead><tr>
      <th>${escapeHtml(t('state', 'State'))}</th><th>${escapeHtml(t('alias', 'Alias'))}</th>
      <th>${escapeHtml(t('mode', 'Speichern'))}</th><th>${escapeHtml(t('debounce', 'Entprellung'))}</th>
      <th>${escapeHtml(t('retention', 'Keepalive'))}</th><th>${escapeHtml(t('last_write', 'Zuletzt geschrieben'))}</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="influx-empty">${escapeHtml(t('no_states',
    'Noch kein State ausgewählt. Die Auswahl erfolgt auf der States-Seite über die Stiftschaltfläche neben dem Wert.'))}</td></tr>`}</tbody>
  </table>
</section>`;

    const script = `
(function () {
  var base = ${JSON.stringify(basePath)};
  function post(url) {
    return fetch(base + url, { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json().then(function (data) {
        if (!response.ok) throw new Error(data && data.error ? data.error : 'Fehlgeschlagen');
        return data;
      }); });
  }
  var start = document.getElementById('influxSetupStart');
  if (start) start.addEventListener('click', function () {
    start.disabled = true;
    post('/setup/start').then(function () { pollSetup(); })
      .catch(function (error) { start.disabled = false; alert(error.message); });
  });
  var verify = document.getElementById('influxVerify');
  if (verify) verify.addEventListener('click', function () {
    verify.disabled = true;
    post('/setup/verify').then(function () { location.reload(); })
      .catch(function (error) { verify.disabled = false; alert(error.message); });
  });
  var copy = document.getElementById('influxCopyCommand');
  if (copy) copy.addEventListener('click', function () {
    var text = document.getElementById('influxCommand').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () {
      copy.textContent = ${JSON.stringify(t('copied', 'Kopiert'))};
    });
  });
  function pollSetup() {
    fetch(base + '/setup/status', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.running) { setTimeout(pollSetup, 3000); return; }
        location.reload();
      })
      .catch(function () { setTimeout(pollSetup, 5000); });
  }
  if (${state.running ? 'true' : 'false'}) pollSetup();
}());`;

    return { title: `${t('title', 'InfluxDB')} – ${host.name}`, body, script };
  }

  // ── Adapter-Schnittstelle ────────────────────────────────────────────────────

  return {
    async start(config) {
      stopped = false;
      applyConfig(config);
      publishCatalog();
      publishStateOptionsSchema();
      publishDiagnostics();
      updateStatus();

      await tryConnect();
      if (!connected) scheduleReconnect();
      await reloadStateOptions();

      pingTimer = setInterval(async () => {
        if (stopped) return;
        if (!connected) return;
        try {
          await client.ping();
        } catch (error) {
          connected = false;
          lastError = error && error.message ? error.message : String(error);
          updateStatus();
          scheduleReconnect();
        }
        publishDiagnostics();
      }, PING_INTERVAL_MS);
      if (pingTimer.unref) pingTimer.unref();

      // Sicherheitsnetz: Der Host meldet Änderungen zwar sofort, ein
      // regelmäßiger Abgleich fängt verpasste Meldungen auf.
      optionsTimer = setInterval(() => reloadStateOptions().catch(() => {}), OPTIONS_RELOAD_MS);
      if (optionsTimer.unref) optionsTimer.unref();
    },

    async stop() {
      stopped = true;
      for (const timer of [flushTimer, reconnectTimer]) if (timer) clearTimeout(timer);
      for (const timer of [pingTimer, optionsTimer]) if (timer) clearInterval(timer);
      flushTimer = reconnectTimer = pingTimer = optionsTimer = null;
      for (const entry of tracked.values()) releaseEntry(entry);
      tracked.clear();
      // Verbleibende Messpunkte noch schreiben, solange die Verbindung steht.
      if (connected && queue.length) {
        stopped = false;
        await flush().catch(() => {});
        stopped = true;
      }
    },

    // Der Benutzer hat im Eigenschaften-Dialog etwas geändert.
    async stateOptionsChanged() {
      await reloadStateOptions();
    },

    read(address) {
      if (!address || String(address).startsWith('status/')) publishDiagnostics();
    },

    async handleManagementRequest(request) {
      const access = request.access || {};
      const method = String(request.method || 'GET').toUpperCase();
      const subpath = String(request.path || '/');
      if (method === 'GET' && (subpath === '/' || subpath === '')) {
        if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        return { status: 200, view: managementView(String(request.basePath || ''), access) };
      }
      if (method === 'GET' && subpath === '/setup/status') {
        if (!access.canRead) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        return { status: 200, json: { running: install.running, connected, messages: install.messages, error: install.error } };
      }
      if (method === 'POST' && subpath === '/setup/start') {
        if (!access.isAdmin) return { status: 403, json: { error: 'Nur Administratoren dürfen die Ersteinrichtung starten.' } };
        const state = setupState();
        if (!state.needed) {
          return { status: 409, json: { error: 'Die Ersteinrichtung ist hier nicht verfügbar.' } };
        }
        if (!state.privileged) {
          return { status: 409, json: {
            error: 'homeESS läuft ohne erweiterte Rechte. Bitte das mitgelieferte Installationsskript in einer Root-Konsole ausführen.',
            command: setup.installCommand({ ...cfg, retentionDays: 730 }),
          } };
        }
        if (install.running) return { status: 409, json: { error: 'Die Einrichtung läuft bereits.' } };
        install.running = true;
        install.error = '';
        install.messages = [];
        host.log('Ersteinrichtung der lokalen InfluxDB gestartet.');
        setup.runLocalInstall({ ...cfg, retentionDays: 730 }, (line) => {
          install.messages = [...install.messages, line].slice(-40);
          host.debug(`Einrichtung: ${line}`);
        })
          .then(async () => {
            install.running = false;
            host.log('Lokale InfluxDB eingerichtet.');
            await tryConnect();
            if (connected) await reloadStateOptions();
          })
          .catch((error) => {
            install.running = false;
            install.error = error && error.message ? error.message : String(error);
            host.error(`Ersteinrichtung fehlgeschlagen: ${install.error}`);
          });
        return { status: 202, json: { ok: true } };
      }
      if (method === 'POST' && subpath === '/setup/verify') {
        if (!access.canWrite) return { status: 403, json: { error: 'Keine Berechtigung.' } };
        const ok = await tryConnect();
        if (ok) await reloadStateOptions();
        return ok
          ? { status: 200, json: { ok: true } }
          : { status: 409, json: { error: lastError || 'Verbindung fehlgeschlagen.' } };
      }
      return { status: 404, json: { error: 'Unbekannte Aktion.' } };
    },

    // Für Tests: Zugriff auf den inneren Zustand.
    _internals: () => ({
      config: () => cfg,
      client: () => client,
      tracked: () => tracked,
      queue: () => queue,
      stats: () => stats,
      setupState,
      reloadStateOptions,
      flush,
      tryConnect,
      setConnected: (value) => { connected = value; },
      install: () => install,
    }),
  };
};

module.exports.aliasFromTopic = aliasFromTopic;
