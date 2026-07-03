'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

function formatDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' });
}

function formatInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min} min`;
}

function deviceBadge(device) {
  return device.online
    ? '<span class="adapter-badge adapter-badge--on">Online</span>'
    : '<span class="adapter-badge adapter-badge--off">Offline</span>';
}

function renderValues(values) {
  if (!values.length) return '<p class="muted">Noch keine Werte empfangen.</p>';
  const rows = values.map((entry) => `                <tr>
                  <td><code>${escapeHtml(entry.address)}</code></td>
                  <td>${escapeHtml(entry.name)}</td>
                  <td>${escapeHtml(entry.display)}</td>
                </tr>`).join('\n');
  return `            <table class="states-edit-table">
              <thead><tr><th>Adresse</th><th>Name</th><th>Wert</th></tr></thead>
              <tbody>
${rows}
              </tbody>
            </table>`;
}

function renderDevice(instance, device) {
  const title = device.friendlyName || device.topic;
  return `          <details class="state-cat" open>
            <summary><span class="state-cat-name">${escapeHtml(title)}</span><span class="state-cat-count">${escapeHtml(device.topic)}</span></summary>
            <div style="padding:12px;">
              <div style="display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                ${deviceBadge(device)}
                <span class="muted">Client: <code>${escapeHtml(device.clientId || '—')}</code></span>
                <span class="muted">IP: <code>${escapeHtml(device.ip || '—')}</code></span>
                <span class="muted">Intervall: <strong>${escapeHtml(formatInterval(device.intervalMs))}</strong></span>
                <span class="muted">Zuletzt: ${escapeHtml(formatDate(device.lastSeenAt))}</span>
                <form method="POST" action="/adapter/instance/${instance.id}/tasmota-devices/delete" onsubmit="return confirm('Gerät „${escapeHtml(title)}“ löschen?');" style="margin-left:auto;">
                  <input type="hidden" name="topic" value="${escapeHtml(device.topic)}">
                  <button type="submit" class="module-toggle-btn button-danger">Löschen</button>
                </form>
              </div>
              <p class="muted" style="margin-bottom:10px;">MAC: <code>${escapeHtml(device.mac || '—')}</code> · Firmware: ${escapeHtml(device.version || '—')} · Modul: ${escapeHtml(device.module || '—')}</p>
${renderValues(device.values)}
            </div>
          </details>`;
}

function renderTasmotaDevices({ adapter, instance, devices = [], message = '', error = '' } = {}) {
  const body = `        <h1>${escapeHtml(adapter.name)} – ${escapeHtml(instance.name)}: Geräte</h1>
        <p class="muted" style="margin-bottom:16px;">Adresse: <code>${escapeHtml(adapter.prefix)}://${escapeHtml(instance.name)}/&lt;gerät&gt;/...</code> · <a href="/adapter/instance/${instance.id}">Einstellungen</a></p>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}
        <div class="settings-card">
          <div class="settings-card-head"><h2>Registrierte Geräte</h2></div>
          ${devices.length ? devices.map((device) => renderDevice(instance, device)).join('\n') : '<p class="muted">Noch keine Tasmota-Geräte registriert.</p>'}
        </div>`;
  return renderLayout({ title: `${adapter.name} – Geräte`, activePath: '/adapter', body });
}

module.exports = renderTasmotaDevices;
