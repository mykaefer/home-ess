'use strict';

// Seite „Logs": zeigt die Laufzeitmeldungen aller Hintergrunddienste aus dem
// Ringpuffer (`src/logging/log-store.js`).
//
// Aufbau: Filterleiste (Suche · Quelle · Stufen · Takt · Pause), darunter die
// Zeilenliste mit fester Kopfzeile, darunter die Blätterung. Die erste Seite
// wird server-gerendert ausgeliefert und danach vom Browser im gewählten Takt
// ersetzt.
//
// Der Pausenzustand lebt ausschließlich in einer Variablen des Seitenskripts —
// er wird weder gespeichert noch an den Server gemeldet. Ein erneuter Aufruf der
// Seite startet damit immer wieder laufend.

const { renderLayout } = require('./layout');
const { escapeHtml } = require('./components');

// Beschriftung und Farbklasse je Dringlichkeitsstufe.
const LEVELS = [
  { key: 'error', label: 'Fehler' },
  { key: 'warn', label: 'Warnung' },
  { key: 'info', label: 'Info' },
  { key: 'debug', label: 'Debug' },
];

// Wählbare Aktualisierungstakte. Der erste Eintrag ist die Vorgabe: 1 s, damit
// die Liste praktisch mitläuft. Schneller geht nicht — die Route weist engere
// Abstände ab.
const INTERVALS = [
  { value: 1000, label: '1 s' },
  { value: 5000, label: '5 s' },
  { value: 10000, label: '10 s' },
  { value: 30000, label: '30 s' },
  { value: 60000, label: '60 s' },
];

function pad(value) {
  return value < 10 ? `0${value}` : String(value);
}

function formatTime(ts) {
  const date = new Date(Number(ts) || 0);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}. `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function levelLabel(key) {
  const found = LEVELS.find((level) => level.key === key);
  return found ? found.label : key;
}

function renderRow(entry) {
  return `<div class="log-row log-row--${escapeHtml(entry.level)}">`
    + `<span class="log-time">${escapeHtml(formatTime(entry.ts))}</span>`
    + `<span class="log-level">${escapeHtml(levelLabel(entry.level))}</span>`
    + `<span class="log-source" title="${escapeHtml(entry.source)}">${escapeHtml(entry.source)}</span>`
    + `<span class="log-line">${escapeHtml(entry.line)}</span>`
    + '</div>';
}

function renderSourceOptions(sources) {
  return ['<option value="">Alle Quellen</option>']
    .concat(sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`))
    .join('\n              ');
}

function renderLevelFilters(counts) {
  return LEVELS.map((level) => `<label class="log-level-toggle log-level-toggle--${level.key}">
                <input type="checkbox" data-log-level="${level.key}" checked>
                <span class="log-level-name">${escapeHtml(level.label)}</span>
                <span class="log-level-count" id="log-count-${level.key}">${escapeHtml(String(counts[level.key] || 0))}</span>
              </label>`).join('\n              ');
}

function renderIntervalOptions() {
  return INTERVALS.map((entry, index) => (
    `<option value="${entry.value}"${index === 0 ? ' selected' : ''}>${entry.label}</option>`
  )).join('\n              ');
}

function renderLogs({ initial = null, minIntervalMs = 2000 } = {}) {
  const data = initial || {
    page: 1, totalPages: 1, total: 0, latestId: 0, entries: [], sources: [],
    counts: { error: 0, warn: 0, info: 0, debug: 0 }, stored: 0, capacity: 0, dropped: 0,
  };

  const body = `        <h1>Logs</h1>

        <section class="panel-card logs-card">
          <div class="logs-toolbar">
            <div class="logs-field logs-field--search">
              <label for="log-search">Suche</label>
              <input type="search" id="log-search" placeholder="Suchen …" autocomplete="off">
            </div>
            <div class="logs-field">
              <label for="log-source">Quelle</label>
              <select id="log-source">
              ${renderSourceOptions(data.sources)}
              </select>
            </div>
            <div class="logs-field logs-field--levels">
              <label>Art</label>
              <div class="log-level-toggles">
              ${renderLevelFilters(data.counts)}
              </div>
            </div>
            <div class="logs-field">
              <label for="log-interval">Intervall</label>
              <select id="log-interval">
              ${renderIntervalOptions()}
              </select>
            </div>
            <div class="logs-field logs-field--pause">
              <button type="button" class="logs-pause" id="log-pause" aria-pressed="false">
                <span class="logs-pause-icon" id="log-pause-icon" aria-hidden="true">⏸</span>
                <span class="logs-pause-text" id="log-pause-text">Pause</span>
              </button>
            </div>
          </div>

          <div class="logs-meta">
            <span class="logs-state logs-state--live" id="log-state">Live</span>
            <span class="logs-meta-item"><span class="logs-meta-label">Treffer</span><span class="logs-meta-value" id="log-total">${escapeHtml(String(data.total))}</span></span>
            <span class="logs-meta-item"><span class="logs-meta-label">Puffer</span><span class="logs-meta-value" id="log-stored">${escapeHtml(`${data.stored} / ${data.capacity}`)}</span></span>
            <span class="logs-meta-item"><span class="logs-meta-label">Stand</span><span class="logs-meta-value" id="log-updated">—</span></span>
          </div>

          <div class="log-list-head">
            <span>Zeit</span>
            <span>Art</span>
            <span>Quelle</span>
            <span>Meldung</span>
          </div>
          <div class="log-list" id="log-list">
            ${data.entries.length
              ? data.entries.map(renderRow).join('\n            ')
              : '<div class="log-empty">Keine Logzeilen vorhanden.</div>'}
          </div>

          <div class="logs-pager">
            <button type="button" id="log-newer" disabled>Neuer</button>
            <span class="logs-pager-label">Seite</span>
            <span class="logs-pager-info" id="log-page-info">${escapeHtml(`${data.page} / ${data.totalPages}`)}</span>
            <button type="button" id="log-older"${data.totalPages > 1 ? '' : ' disabled'}>Älter</button>
          </div>

          <p class="logs-hint muted">Aufgezeichnet werden die Meldungen der Hintergrunddienste seit dem letzten Serverstart. Der Speicher ist begrenzt, ältere Zeilen fallen heraus.</p>
        </section>`;

  const script = `
    // Fortlaufende Anzeige der Logzeilen.
    //
    // Der Pausenzustand steht bewusst nur in dieser Variablen: nichts davon geht
    // in localStorage oder auf den Server, ein Seitenaufruf beginnt daher immer
    // wieder laufend.
    var logPaused = false;
    var logTimer = null;
    var logSearchTimer = null;
    var logIntervalMs = ${INTERVALS[0].value};
    var logMinIntervalMs = ${Number(minIntervalMs) || 2000};
    var logPage = ${Number(data.page) || 1};
    var logTotalPages = ${Number(data.totalPages) || 1};
    // Anker der Blätterung: ab Seite 2 bleibt der Inhalt stehen, auch wenn
    // zwischenzeitlich neue Zeilen eintreffen.
    var logAnchor = 0;
    var logLatestId = ${Number(data.latestId) || 0};
    var logTotal = ${Number(data.total) || 0};
    var logSources = ${JSON.stringify(data.sources || [])};
    var logBusy = false;

    var LOG_LEVEL_LABELS = { error: 'Fehler', warn: 'Warnung', info: 'Info', debug: 'Debug' };

    function logPad(value) { return (value < 10 ? '0' : '') + value; }
    function logFormatTime(ts) {
      var date = new Date(Number(ts) || 0);
      return logPad(date.getDate()) + '.' + logPad(date.getMonth() + 1) + '. '
        + logPad(date.getHours()) + ':' + logPad(date.getMinutes()) + ':' + logPad(date.getSeconds());
    }

    function logSelectedLevels() {
      var picked = [];
      var boxes = document.querySelectorAll('[data-log-level]');
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) picked.push(boxes[i].getAttribute('data-log-level'));
      }
      return picked;
    }

    function logQueryString() {
      var params = [];
      params.push('seite=' + logPage);
      var levels = logSelectedLevels();
      if (levels.length) params.push('stufe=' + encodeURIComponent(levels.join(',')));
      var source = document.getElementById('log-source').value;
      if (source) params.push('quelle=' + encodeURIComponent(source));
      var search = document.getElementById('log-search').value.trim();
      if (search) params.push('suche=' + encodeURIComponent(search));
      if (logAnchor) params.push('anker=' + logAnchor);
      return params.join('&');
    }

    function logRenderRows(entries) {
      var list = document.getElementById('log-list');
      list.textContent = '';
      if (!entries || !entries.length) {
        var empty = document.createElement('div');
        empty.className = 'log-empty';
        empty.textContent = 'Keine Logzeilen vorhanden.';
        list.appendChild(empty);
        return;
      }
      var fragment = document.createDocumentFragment();
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var row = document.createElement('div');
        row.className = 'log-row log-row--' + entry.level;
        var time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = logFormatTime(entry.ts);
        var level = document.createElement('span');
        level.className = 'log-level';
        level.textContent = LOG_LEVEL_LABELS[entry.level] || entry.level;
        var source = document.createElement('span');
        source.className = 'log-source';
        source.textContent = entry.source;
        // Lange Instanznamen werden in der Spalte gekürzt – der volle Name
        // steht im Tooltip.
        source.title = entry.source;
        var line = document.createElement('span');
        line.className = 'log-line';
        line.textContent = entry.line;
        row.appendChild(time);
        row.appendChild(level);
        row.appendChild(source);
        row.appendChild(line);
        fragment.appendChild(row);
      }
      list.appendChild(fragment);
    }

    // Quellenauswahl nachziehen, sobald eine neue Quelle auftaucht. Die
    // getroffene Auswahl bleibt dabei erhalten.
    function logSyncSources(sources) {
      if (!sources || sources.join('|') === logSources.join('|')) return;
      logSources = sources;
      var select = document.getElementById('log-source');
      var current = select.value;
      select.textContent = '';
      var all = document.createElement('option');
      all.value = '';
      all.textContent = 'Alle Quellen';
      select.appendChild(all);
      for (var i = 0; i < sources.length; i++) {
        var option = document.createElement('option');
        option.value = sources[i];
        option.textContent = sources[i];
        select.appendChild(option);
      }
      select.value = current;
      if (select.value !== current) select.value = '';
    }

    function logApply(data) {
      logPage = data.page;
      logTotalPages = data.totalPages;
      logLatestId = data.latestId;
      logTotal = data.total;
      logRenderRows(data.entries);
      logSyncSources(data.sources);
      document.getElementById('log-total').textContent = String(data.total);
      document.getElementById('log-stored').textContent = data.stored + ' / ' + data.capacity;
      document.getElementById('log-page-info').textContent = data.page + ' / ' + data.totalPages;
      var counts = data.counts || {};
      Object.keys(LOG_LEVEL_LABELS).forEach(function (key) {
        var node = document.getElementById('log-count-' + key);
        if (node) node.textContent = String(counts[key] || 0);
      });
      logUpdatePager();
      logMarkUpdated();
    }

    function logMarkUpdated() {
      var now = new Date();
      document.getElementById('log-updated').textContent =
        logPad(now.getHours()) + ':' + logPad(now.getMinutes()) + ':' + logPad(now.getSeconds());
    }

    function logUpdatePager() {
      document.getElementById('log-newer').disabled = logPage <= 1;
      document.getElementById('log-older').disabled = logPage >= logTotalPages;
    }

    function logLoad(force) {
      if (logBusy) return;
      logBusy = true;
      var url = '/logs/daten?' + logQueryString();
      // Unverändert? Dann antwortet der Server nur mit einem Kennzeichen und
      // spart die Zeilenliste ein.
      if (!force) url += '&bekannt=' + logLatestId + '&bekanntGesamt=' + logTotal;
      fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (response) {
          if (response.status === 429) {
            return response.json().then(function (info) {
              logSchedule(Math.max(logIntervalMs, (info && info.retryAfterMs) || logMinIntervalMs));
              return null;
            });
          }
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          if (data && !data.unchanged) logApply(data);
          else if (data && data.unchanged) logMarkUpdated();
        })
        .catch(function () {})
        .then(function () {
          logBusy = false;
          logSchedule(logIntervalMs);
        });
    }

    function logSchedule(delay) {
      if (logTimer) window.clearTimeout(logTimer);
      logTimer = null;
      if (logPaused) return;
      logTimer = window.setTimeout(function () { logLoad(false); }, Math.max(delay, logMinIntervalMs));
    }

    function logSetPaused(paused) {
      logPaused = paused;
      var button = document.getElementById('log-pause');
      var state = document.getElementById('log-state');
      button.setAttribute('aria-pressed', paused ? 'true' : 'false');
      button.classList.toggle('is-paused', paused);
      document.getElementById('log-pause-icon').textContent = paused ? '▶' : '⏸';
      document.getElementById('log-pause-text').textContent = paused ? 'Weiter' : 'Pause';
      state.textContent = paused ? 'Angehalten' : 'Live';
      state.classList.toggle('logs-state--paused', paused);
      state.classList.toggle('logs-state--live', !paused);
      if (paused) {
        if (logTimer) window.clearTimeout(logTimer);
        logTimer = null;
      } else {
        logLoad(true);
      }
    }

    // Filteränderung: immer zurück auf die erste (lebende) Seite.
    function logResetAndLoad() {
      logPage = 1;
      logAnchor = 0;
      logLoad(true);
    }

    document.getElementById('log-pause').addEventListener('click', function () { logSetPaused(!logPaused); });
    document.getElementById('log-interval').addEventListener('change', function () {
      logIntervalMs = Number(this.value) || logIntervalMs;
      logSchedule(logIntervalMs);
    });
    document.getElementById('log-source').addEventListener('change', logResetAndLoad);
    document.getElementById('log-search').addEventListener('input', function () {
      if (logSearchTimer) window.clearTimeout(logSearchTimer);
      // Erst nach kurzer Tippruhe abrufen – nicht bei jedem Zeichen.
      logSearchTimer = window.setTimeout(logResetAndLoad, 400);
    });
    var levelBoxes = document.querySelectorAll('[data-log-level]');
    for (var boxIndex = 0; boxIndex < levelBoxes.length; boxIndex++) {
      levelBoxes[boxIndex].addEventListener('change', logResetAndLoad);
    }
    document.getElementById('log-newer').addEventListener('click', function () {
      if (logPage <= 1) return;
      logPage -= 1;
      // Zurück auf Seite 1 heißt zurück in den laufenden Betrieb.
      if (logPage === 1) logAnchor = 0;
      logLoad(true);
    });
    document.getElementById('log-older').addEventListener('click', function () {
      if (logPage >= logTotalPages) return;
      // Beim Verlassen der ersten Seite den Anker setzen, damit der Inhalt der
      // Folgeseiten nicht unter der Hand weiterwandert.
      if (!logAnchor) logAnchor = logLatestId;
      logPage += 1;
      logLoad(true);
    });

    logUpdatePager();
    logMarkUpdated();
    logSchedule(logIntervalMs);`;

  return renderLayout({ title: 'Logs', activePath: '/logs', body, script });
}

module.exports = renderLogs;
