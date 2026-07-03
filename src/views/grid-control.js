'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function checked(value) { return value ? ' checked' : ''; }
function fmtLogTime(ts) {
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function logRowClass(category) {
  if (category === 'action') return ' gc-log-row--action';
  if (category === 'critical') return ' gc-log-row--critical';
  return '';
}
function renderLogRows(entries) {
  if (!entries || !entries.length) return '<div class="gc-log-empty">Noch keine Eintraege.</div>';
  return entries
    .map(
      (e) => `<div class="gc-log-row${logRowClass(e.category)}"><span class="gc-log-time">${escapeHtml(fmtLogTime(e.ts))}</span><span class="gc-log-msg">${escapeHtml(e.message)}</span>${e.values ? `<span class="gc-log-vals">${escapeHtml(e.values)}</span>` : ''}</div>`
    )
    .join('');
}
function brokerValue(id, value) { return `<span class="topic-current">Broker: <strong id="${id}">${escapeHtml(value == null ? '—' : value)}</strong></span>`; }
// Bestätigungs-Badge: zeigt, ob der Broker den geschriebenen Schaltbefehl
// tatsächlich zurückgemeldet hat. null = kein Topic/keine Schaltung aktiv.
function confirmBadge(id, confirmed) {
  const cls = confirmed === false ? 'cmd-confirm cmd-confirm--bad' : (confirmed === true ? 'cmd-confirm cmd-confirm--ok' : 'cmd-confirm');
  const text = confirmed === false ? 'nicht bestätigt!' : (confirmed === true ? 'bestätigt' : '—');
  return `<span class="${cls}" id="${id}">${text}</span>`;
}
function stateCard(label, value, id) {
  return `<div class="kpi-card"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value grid-state" id="${id}">${value ? 'Ein' : 'Aus'}</div></div>`;
}

function renderGridControl({ config, batteryConfig, state, brokerValues = {}, log = { entries: [], page: 1, totalPages: 1 }, message = '', error = '' }) {
  const lowSoc = Number(batteryConfig.minSoc) + Number(config.socLowerOffset);
  const highSoc = 100 - Number(config.socUpperOffset);
  const body = `        <h1>Grid-Control</h1>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}

        <div class="kpi-row">
          ${stateCard('Grid by SoC', state.gridBySoc, 'grid-by-soc')}
          ${stateCard('Grid by Voltage', state.gridByVoltage, 'grid-by-voltage')}
          ${stateCard('Warnung', state.gridByTemperature, 'grid-by-temperature')}
          ${stateCard('Grid by Load', state.gridByLoad, 'grid-by-load')}
          ${stateCard('Grid actual', state.gridActual, 'grid-actual')}
        </div>

        <form action="/grid-control/config" method="POST" class="grid-control-form">
          <div class="settings-card">
            <div class="settings-card-head"><h2>MQTT-Steuerung <span class="cmd-confirm${state.mqttConnected ? ' cmd-confirm--ok' : ' cmd-confirm--bad'}" id="mqtt-connection">${state.mqttConnected ? 'verbunden' : 'getrennt!'}</span></h2><p class="settings-card-hint">Schaltbefehle werden gegen die Broker-Rückmeldung verifiziert und bei Abweichung automatisch wiederholt.</p></div>
            <div class="field-grid">
              <div class="field"><label for="gridCommandTopic">Netz schalten – Ziel-Topic</label><input id="gridCommandTopic" name="gridCommandTopic" type="text" value="${escapeHtml(config.gridCommandTopic)}" placeholder="z.B. inverter.0.grid.SET">${brokerValue('broker-grid-command', brokerValues.gridCommand)}${confirmBadge('grid-command-confirm', state.gridCommandConfirmed)}</div>
              <div class="field"><label for="feedInCommandTopic">Überschusseinspeisung – Ziel-Topic</label><input id="feedInCommandTopic" name="feedInCommandTopic" type="text" value="${escapeHtml(config.feedInCommandTopic)}" placeholder="z.B. inverter.0.feedIn.SET">${brokerValue('broker-feed-in-command', brokerValues.feedInCommand)}${confirmBadge('feed-in-command-confirm', state.feedInCommandConfirmed)}</div>
              <div class="field"><label for="warningTextTopic">Warnungstext – Ziel-Topic</label><input id="warningTextTopic" name="warningTextTopic" type="text" value="${escapeHtml(config.warningTextTopic)}">${brokerValue('broker-warning-text', brokerValues.warningText)}</div>
              <div class="field"><label for="warningActiveTopic">Warnung aktiv – Ziel-Topic</label><input id="warningActiveTopic" name="warningActiveTopic" type="text" value="${escapeHtml(config.warningActiveTopic)}">${brokerValue('broker-warning-active', brokerValues.warningActive)}</div>
              <div class="field"><label for="gridFrequencyL1Topic">Netzfrequenz L1 – Quell-Topic (Hz)</label><input id="gridFrequencyL1Topic" name="gridFrequencyL1Topic" type="text" value="${escapeHtml(config.gridFrequencyL1Topic)}">${brokerValue('broker-grid-frequency-l1', brokerValues.gridFrequencyL1)}</div>
              <div class="field"><label for="gridFrequencyL2Topic">Netzfrequenz L2 – Quell-Topic (Hz)</label><input id="gridFrequencyL2Topic" name="gridFrequencyL2Topic" type="text" value="${escapeHtml(config.gridFrequencyL2Topic)}">${brokerValue('broker-grid-frequency-l2', brokerValues.gridFrequencyL2)}</div>
              <div class="field"><label for="gridFrequencyL3Topic">Netzfrequenz L3 – Quell-Topic (Hz)</label><input id="gridFrequencyL3Topic" name="gridFrequencyL3Topic" type="text" value="${escapeHtml(config.gridFrequencyL3Topic)}">${brokerValue('broker-grid-frequency-l3', brokerValues.gridFrequencyL3)}</div>
              <div class="field"><label for="gridDetectionSeconds">Wartezeit bis Notstromerkennung (Sekunden)</label><input id="gridDetectionSeconds" name="gridDetectionSeconds" type="number" min="1" max="3600" step="1" value="${escapeHtml(config.gridDetectionSeconds)}"></div>
            </div>
            <label class="checkbox-field disabled-aware" id="feedInAllowedLabel"><input type="checkbox" id="feedInAllowed" name="feedInAllowed"${checked(config.feedInAllowed)}> Überschusseinspeisung generell erlauben</label>
          </div>

          <div class="settings-card">
            <div class="settings-card-head"><h2>SoC-Schaltung</h2><p class="settings-card-hint">Unten und oben sind getrennte Schaltfenster. Im Bereich dazwischen bleibt dieser Ausgang aus.</p></div>
            <label class="checkbox-field"><input type="checkbox" name="socEnabled"${checked(config.socEnabled)}> Bei SoC-Ereignissen schalten</label>
            <div class="field-grid grid-control-fields">
              <div class="field"><label for="socLowerOffset">Untere Schwelle: Mindest-SoC + Offset (%)</label><input id="socLowerOffset" name="socLowerOffset" type="number" min="0" max="20" step="1" value="${escapeHtml(config.socLowerOffset)}"><small>Aktuell Netz an bei ≤ ${escapeHtml(lowSoc)} %</small></div>
              <div class="field"><label for="socUpperOffset">Obere Schwelle: 100 % − Offset (%)</label><input id="socUpperOffset" name="socUpperOffset" type="number" min="0" max="20" step="1" value="${escapeHtml(config.socUpperOffset)}"><small>Aktuell Netz an bei ≥ ${escapeHtml(highSoc)} %</small></div>
              <div class="field"><label for="socHysteresis">Hysterese je Schaltgrenze (%)</label><input id="socHysteresis" name="socHysteresis" type="number" min="0" max="5" step="1" value="${escapeHtml(config.socHysteresis)}"><small>Maximal 5 %, wirkt nur direkt an der jeweiligen Grenze.</small></div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-head"><h2>Spannungsschaltung</h2><p class="settings-card-hint">Grenzen aus Batterie: ${escapeHtml(batteryConfig.lowerVoltage)} V / ${escapeHtml(batteryConfig.upperVoltage)} V. Im Bereich dazwischen ist dieser Ausgang aus.</p></div>
            <label class="checkbox-field"><input type="checkbox" name="voltageEnabled"${checked(config.voltageEnabled)}> Bei Spannungsereignissen schalten</label>
            <div class="field-grid grid-control-fields"><div class="field"><label for="voltageHysteresis">Hysterese je Schaltgrenze (V)</label><input id="voltageHysteresis" name="voltageHysteresis" type="number" min="0" max="10" step="0.1" value="${escapeHtml(config.voltageHysteresis)}"></div></div>
          </div>

          <div class="settings-card">
            <div class="settings-card-head"><h2>Temperaturwarnung</h2><p class="settings-card-hint">Ohne abweichende Angabe wird der Wert 1 bzw. true als Warnung erkannt.</p></div>
            <label class="checkbox-field"><input type="checkbox" name="temperatureEnabled"${checked(config.temperatureEnabled)}> Bei Temperaturwarnung schalten</label>
            <div class="field-grid grid-control-fields">
              <div class="field"><label for="temperatureWarningTopic">Temperaturwarnung – Quell-Topic</label><input id="temperatureWarningTopic" name="temperatureWarningTopic" type="text" value="${escapeHtml(config.temperatureWarningTopic)}">${brokerValue('broker-temperature-warning', brokerValues.temperatureWarning)}</div>
              <div class="field"><label for="temperatureWarningValue">Wert für aktive Warnung</label><input id="temperatureWarningValue" name="temperatureWarningValue" type="text" value="${escapeHtml(config.temperatureWarningValue)}" placeholder="1"></div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-head"><h2>Wechselrichterlast</h2><p class="settings-card-hint">Messwerte kommen direkt aus Stromverbrauch → Leistung Eigenverbrauch L1–L3. Die Netzschaltung nutzt ihre eigenen Ein-/Aus-Schwellen. Der stufenweise Lastabwurf arbeitet separat mit 80 % der hinterlegten Maximallast je Phase und gibt erst unter 50 % wieder stufenweise frei.</p></div>
            <label class="checkbox-field"><input type="checkbox" name="loadEnabled"${checked(config.loadEnabled)}> Bei Wechselrichterlast schalten</label>
            <div class="field-grid grid-control-fields"><div class="field"><label for="loadOffDelaySeconds">Ausschaltverzögerung (Sekunden)</label><input id="loadOffDelaySeconds" name="loadOffDelaySeconds" type="number" min="0" max="3600" step="1" value="${escapeHtml(config.loadOffDelaySeconds)}"><small>0 schaltet ohne Verzögerung ab. Eine laufende Verzögerung bleibt bei einem HomeESS-Neustart erhalten.</small></div></div>
            <div class="phase-threshold-grid grid-control-fields">
              ${[1, 2, 3].map((phase) => `<div class="phase-threshold-card"><strong>L${phase}</strong><span class="topic-current">Aktuell: <strong id="current-load-l${phase}">${escapeHtml(state.inverterLoads?.[phase - 1] == null ? '—' : state.inverterLoads[phase - 1])} W</strong></span><div class="field"><label for="loadShedMaxL${phase}">Maximallast Lastabwurf (W)</label><input id="loadShedMaxL${phase}" name="loadShedMaxL${phase}" type="number" min="0" step="1" value="${escapeHtml(config[`loadShedMaxL${phase}`])}"></div><div class="field"><label for="loadOnL${phase}">Netz ein über (W)</label><input id="loadOnL${phase}" name="loadOnL${phase}" type="number" min="0" step="1" value="${escapeHtml(config[`loadOnL${phase}`])}"></div><div class="field"><label for="loadOffL${phase}">Netz aus unter (W)</label><input id="loadOffL${phase}" name="loadOffL${phase}" type="number" min="0" step="1" value="${escapeHtml(config[`loadOffL${phase}`])}"></div></div>`).join('')}
            </div>
          </div>
          <div class="button-row"><button type="submit">Konfiguration speichern</button></div>
        </form>

        <div class="settings-card gc-log-card">
          <div class="settings-card-head">
            <h2>Protokoll</h2>
            <p class="settings-card-hint">Jede erkannte Wertänderung und ausgeführte Aktion mit Zeitstempel. <span class="gc-log-legend"><span class="gc-log-chip gc-log-chip--action">Aktion</span> <span class="gc-log-chip gc-log-chip--critical">kritisch</span></span></p>
          </div>
          <div class="gc-log" id="gc-log">${renderLogRows(log.entries)}</div>
          <div class="gc-log-pager">
            <button type="button" id="gc-log-newer" disabled>← Neuer</button>
            <span id="gc-log-info">Seite ${log.page} / ${log.totalPages}${log.page === 1 ? ' (live)' : ' (statisch)'}</span>
            <button type="button" id="gc-log-older"${log.totalPages <= 1 ? ' disabled' : ''}>Älter →</button>
          </div>
        </div>`;

  const script = `
    function updateFeedInAvailability() {
      var topic = document.getElementById('feedInCommandTopic');
      var checkbox = document.getElementById('feedInAllowed');
      var label = document.getElementById('feedInAllowedLabel');
      var disabled = !topic.value.trim();
      checkbox.disabled = disabled;
      if (disabled) checkbox.checked = false;
      label.classList.toggle('is-disabled', disabled);
    }
    document.getElementById('feedInCommandTopic').addEventListener('input', updateFeedInAvailability);
    updateFeedInAvailability();
    function refreshGridState() {
      fetch('/grid-control/status', { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
        if (!s) return;
        [['grid-by-soc','gridBySoc'],['grid-by-voltage','gridByVoltage'],['grid-by-temperature','gridByTemperature'],['grid-by-load','gridByLoad'],['grid-actual','gridActual']].forEach(function (pair) {
          var el = document.getElementById(pair[0]);
          el.textContent = s[pair[1]] ? 'Ein' : 'Aus';
          el.classList.toggle('grid-state--on', !!s[pair[1]]);
        });
        var brokerMap = {
          'broker-grid-command': 'gridCommand', 'broker-feed-in-command': 'feedInCommand',
          'broker-warning-text': 'warningText', 'broker-warning-active': 'warningActive',
          'broker-grid-frequency-l1': 'gridFrequencyL1', 'broker-grid-frequency-l2': 'gridFrequencyL2',
          'broker-grid-frequency-l3': 'gridFrequencyL3', 'broker-temperature-warning': 'temperatureWarning'
        };
        Object.keys(brokerMap).forEach(function (id) {
          var value = s.brokerValues ? s.brokerValues[brokerMap[id]] : null;
          document.getElementById(id).textContent = value == null ? '—' : String(value);
        });
        (s.inverterLoads || []).forEach(function (value, index) {
          var el = document.getElementById('current-load-l' + (index + 1));
          if (el) el.textContent = (value == null ? '—' : String(value)) + ' W';
        });
        [['grid-command-confirm', s.gridCommandConfirmed], ['feed-in-command-confirm', s.feedInCommandConfirmed]].forEach(function (pair) {
          var el = document.getElementById(pair[0]);
          if (!el) return;
          var c = pair[1];
          el.textContent = c === false ? 'nicht bestätigt!' : (c === true ? 'bestätigt' : '—');
          el.classList.toggle('cmd-confirm--bad', c === false);
          el.classList.toggle('cmd-confirm--ok', c === true);
        });
        var conn = document.getElementById('mqtt-connection');
        if (conn) {
          conn.textContent = s.mqttConnected ? 'verbunden' : 'getrennt!';
          conn.classList.toggle('cmd-confirm--ok', !!s.mqttConnected);
          conn.classList.toggle('cmd-confirm--bad', !s.mqttConnected);
        }
      }).catch(function () {});
    }
    refreshGridState();
    window.addEventListener('homeess:mqtt', refreshGridState);
    setInterval(refreshGridState, 30000);

    // Protokoll: Seite 1 live, ab Seite 2 statisch; mit Blättern.
    var gcLogPage = 1;
    var gcLogTotalPages = ${log.totalPages};
    function gcEsc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
    function gcFmtTime(ts) {
      var d = new Date(Number(ts));
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function gcRenderLog(data) {
      var box = document.getElementById('gc-log');
      if (!box) return;
      if (!data.entries || !data.entries.length) {
        box.innerHTML = '<div class="gc-log-empty">Noch keine Eintraege.</div>';
      } else {
        box.innerHTML = data.entries.map(function (e) {
          var cls = e.category === 'action' ? ' gc-log-row--action' : (e.category === 'critical' ? ' gc-log-row--critical' : '');
          return '<div class="gc-log-row' + cls + '"><span class="gc-log-time">' + gcEsc(gcFmtTime(e.ts)) + '</span>'
            + '<span class="gc-log-msg">' + gcEsc(e.message) + '</span>'
            + (e.values ? '<span class="gc-log-vals">' + gcEsc(e.values) + '</span>' : '') + '</div>';
        }).join('');
      }
      gcLogPage = data.page;
      gcLogTotalPages = data.totalPages;
      var info = document.getElementById('gc-log-info');
      if (info) info.textContent = 'Seite ' + data.page + ' / ' + data.totalPages + (data.page === 1 ? ' (live)' : ' (statisch)');
      var newer = document.getElementById('gc-log-newer');
      var older = document.getElementById('gc-log-older');
      if (newer) newer.disabled = data.page <= 1;
      if (older) older.disabled = data.page >= data.totalPages;
    }
    function loadLogPage(page) {
      fetch('/grid-control/log?page=' + page, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) gcRenderLog(d); })
        .catch(function () {});
    }
    var btnNewer = document.getElementById('gc-log-newer');
    var btnOlder = document.getElementById('gc-log-older');
    if (btnNewer) btnNewer.addEventListener('click', function () { loadLogPage(gcLogPage - 1); });
    if (btnOlder) btnOlder.addEventListener('click', function () { loadLogPage(gcLogPage + 1); });
    function gcLogLiveTick() { if (gcLogPage === 1) loadLogPage(1); }
    window.addEventListener('homeess:mqtt', gcLogLiveTick);
    setInterval(gcLogLiveTick, 5000);`;

  return renderLayout({ title: 'Grid-Control', activePath: '/grid-control', body, script });
}

module.exports = renderGridControl;
