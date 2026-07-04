'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function renderStates(states) {
  if (!states.length) return '<p class="muted">Noch keine Werte empfangen.</p>';
  const rows = states.map((entry) => `                <tr>
                  <td><code>${escapeHtml(entry.address)}</code></td>
                  <td>${escapeHtml(entry.name)}${entry.writable ? ' <span class="adapter-badge adapter-badge--on">schreibbar</span>' : ''}</td>
                  <td>${escapeHtml(entry.display)}</td>
                </tr>`).join('\n');
  return `            <table class="states-edit-table">
              <thead><tr><th>Adresse</th><th>Name</th><th>Wert</th></tr></thead>
              <tbody>
${rows}
              </tbody>
            </table>`;
}

function renderChannel(channel) {
  return `              <div style="margin-top:12px;">
                <p class="muted" style="margin-bottom:6px;"><strong>${escapeHtml(channel.name)}</strong> · <code>${escapeHtml(channel.address)}</code></p>
${renderStates(channel.states || [])}
              </div>`;
}

function renderDevice(instance, device) {
  const title = device.customName || device.name || device.address;
  const channels = (device.channels || []).length
    ? device.channels.map(renderChannel).join('\n')
    : '<p class="muted">Keine Kanäle mit Werten erkannt.</p>';
  return `          <details class="state-cat" data-device-key="${instance.id}:${escapeHtml(device.address)}">
            <summary><span class="state-cat-name">${escapeHtml(title)}</span><span class="state-cat-count">${escapeHtml(device.address)}</span></summary>
            <div style="padding:12px;">
              <div style="display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                <span class="muted">Geräte-ID: <code>${escapeHtml(device.address)}</code></span>
                <span class="muted">CCU-Name: ${escapeHtml(device.name || '—')}</span>
                <form method="POST" action="/adapter/instance/${instance.id}/hm-rpc-devices/rename" style="display:flex; gap:6px; align-items:center; margin-left:auto;">
                  <input type="hidden" name="address" value="${escapeHtml(device.address)}">
                  <input type="text" name="name" value="${escapeHtml(device.customName || '')}" placeholder="Eigener Gerätename" aria-label="Gerätename" style="min-width:180px;">
                  <button type="submit" class="module-toggle-btn">Umbenennen</button>
                </form>
              </div>
${channels}
            </div>
          </details>`;
}

function renderHmRpcDevices({ adapter, instance, devices = [], message = '', error = '' } = {}) {
  const body = `        <h1>${escapeHtml(adapter.name)} – ${escapeHtml(instance.name)}: Geräte</h1>
        <p class="muted" style="margin-bottom:16px;">Adresse: <code>${escapeHtml(adapter.prefix)}://${escapeHtml(instance.name)}/&lt;kanal&gt;/&lt;parameter&gt;</code> · <a href="/adapter/instance/${instance.id}">Einstellungen</a></p>
        <p class="muted" style="margin-bottom:16px;">Vergib je Gerät einen Klarnamen. Er ersetzt die Geräte-ID in den State-Kategorien; die ID bleibt hier sichtbar.</p>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}
        <div class="settings-card">
          <div class="settings-card-head"><h2>Erkannte Geräte</h2></div>
          ${devices.length ? devices.map((device) => renderDevice(instance, device)).join('\n') : '<p class="muted">Noch keine Geräte erkannt. Der Adapter muss dazu mit der CCU verbunden sein.</p>'}
        </div>`;
  // Geräte sind standardmäßig eingeklappt; der Auf-/Zu-Zustand jedes Geräts wird
  // je Instanz+Adresse in localStorage gemerkt und beim Laden wiederhergestellt.
  const script = `
    var HMRPC_DEV_KEY = 'homeess.hmrpc.devices.expanded.v1';
    function hmrpcDevicesLoad() {
      try { return JSON.parse(localStorage.getItem(HMRPC_DEV_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }
    function hmrpcDevicesRestore() {
      var state = hmrpcDevicesLoad();
      var items = document.querySelectorAll('details[data-device-key]');
      for (var i = 0; i < items.length; i++) {
        var key = items[i].getAttribute('data-device-key');
        items[i].open = state[key] === true;
      }
    }
    function hmrpcDevicesBind() {
      var items = document.querySelectorAll('details[data-device-key]');
      for (var i = 0; i < items.length; i++) {
        items[i].addEventListener('toggle', function () {
          var state = hmrpcDevicesLoad();
          state[this.getAttribute('data-device-key')] = this.open;
          try { localStorage.setItem(HMRPC_DEV_KEY, JSON.stringify(state)); } catch (_) {}
        });
      }
    }
    hmrpcDevicesRestore();
    hmrpcDevicesBind();
    window.addEventListener('pageshow', hmrpcDevicesRestore);
  `;
  return renderLayout({ title: `${adapter.name} – Geräte`, activePath: '/adapter', body, script });
}

module.exports = renderHmRpcDevices;
