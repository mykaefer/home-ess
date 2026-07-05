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
              <tbody>${rows}</tbody>
            </table>`;
}

function renderDevice(instance, device) {
  const title = device.customName || device.name || device.address;
  const channels = (device.channels || []).map((channel) => `
              <div style="margin-top:12px;">
                <p class="muted" style="margin-bottom:6px;"><strong>${escapeHtml(channel.name || channel.address)}</strong> · <code>${escapeHtml(channel.address)}</code></p>
${renderStates(channel.states || [])}
              </div>`).join('');
  return `          <details class="state-cat" data-device-key="${instance.id}:${escapeHtml(device.address)}">
            <summary><span class="state-cat-name">${escapeHtml(title)}</span><span class="state-cat-count">${device.online === false ? 'Offline · ' : ''}${escapeHtml(device.address)}</span></summary>
            <div style="padding:12px;">
              <div style="display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                <span class="adapter-badge adapter-badge--${device.online === false ? 'off' : 'on'}">${device.online === false ? 'Offline' : 'Online'}</span>
                <span class="muted">Typ: ${escapeHtml(device.type || '—')}</span>
                <span class="muted">Generation: ${escapeHtml(device.generation || '—')}</span>
                <form method="POST" action="/adapter/instance/${instance.id}/devices/rename" style="display:flex; gap:6px; align-items:center; margin-left:auto;">
                  <input type="hidden" name="address" value="${escapeHtml(device.address)}">
                  <input type="text" name="name" value="${escapeHtml(device.customName || '')}" placeholder="Eigener Gerätename" aria-label="Gerätename" style="min-width:180px;">
                  <button type="submit" class="module-toggle-btn">Umbenennen</button>
                </form>
              </div>${channels || '<p class="muted">Noch keine Werte empfangen.</p>'}
            </div>
          </details>`;
}

module.exports = function renderAdapterDevices({ adapter, instance, devices = [], message = '', error = '' }) {
  const body = `        <h1>${escapeHtml(adapter.name)} – ${escapeHtml(instance.name)}: ${escapeHtml(adapter.devicePage.label)}</h1>
        <p class="muted" style="margin-bottom:16px;">Adresse: <code>${escapeHtml(adapter.prefix)}://${escapeHtml(instance.name)}/&lt;gerät&gt;/...</code> · <a href="/adapter/instance/${instance.id}">Einstellungen</a></p>
        <p class="muted" style="margin-bottom:16px;">Eigene Namen ändern nur die sortierten State-Kategorien; technische Adressen bleiben stabil.</p>
        ${message ? statusText(message, 'success') : ''}${error ? statusText(error) : ''}
        <div class="settings-card"><div class="settings-card-head"><h2>${escapeHtml(adapter.devicePage.label)}</h2></div>
          ${devices.length ? devices.map((device) => renderDevice(instance, device)).join('\n') : `<p class="muted">${escapeHtml(adapter.devicePage.emptyText)}</p>`}
        </div>`;
  return renderLayout({ title: `${adapter.name} – ${adapter.devicePage.label}`, activePath: '/adapter', body });
};
