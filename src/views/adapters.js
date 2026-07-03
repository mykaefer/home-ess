'use strict';

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');

// Adapter-Verwaltungsseite: listet die im /adapter-Verzeichnis gefundenen Adapter,
// je Adapter die angelegten Instanzen als kompakte, volle-Breite-Tabelle mit
// Status (aktiv) UND Verbindungszustand sowie Aktionen. Status wird live gepollt.
function renderAdapters({ registry = [], instancesByAdapter = new Map(), statusById = {}, message = '', error = '' } = {}) {
  const blocks = registry.length
    ? registry.map((adapter) => renderAdapterBlock(adapter, instancesByAdapter.get(adapter.id) || [], statusById)).join('\n')
    : '<div class="info-card"><p class="muted">Keine Adapter gefunden. Lege einen Adapter unter <code>/adapter/&lt;name&gt;/</code> mit einer <code>adapter.json</code> an (siehe ADAPTER.md).</p></div>';

  const body = `        <div class="page-head page-head--split">
          <div>
            <h1>Adapter</h1>
            <p class="muted" style="margin-bottom: 18px;">Adapter verbinden homeESS mit Geräten (z. B. Modbus). Jeder Adapter liegt als Unterverzeichnis in <code>/adapter/</code>. Pro Adapter lassen sich mehrere benannte Instanzen anlegen und einzeln aktivieren. Werte werden über <code>prefix://instanz/adresse</code> angesprochen.</p>
          </div>
          <label class="adapter-filter-toggle">
            <input type="checkbox" id="hide-inactive-adapters" checked>
            <span>Inaktive Adapter ausblenden</span>
          </label>
        </div>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}
        <div class="adapter-list">
${blocks}
        </div>`;

  const script = `
    function adapterBadge(el, cls, text) {
      if (!el) return;
      el.textContent = text;
      el.className = 'adapter-badge adapter-badge--' + cls;
    }
    function adapterStateOf(s) {
      var active = s.running ? ['on','Aktiv'] : (s.enabled ? ['warn','Startet…'] : ['off','Inaktiv']);
      var conn = !s.running ? ['off','—'] : (s.connected ? ['on','Verbunden'] : ['warn','Getrennt']);
      return { active: active, conn: conn, detail: s.detail || '' };
    }
    function syncAdapterVisibility() {
      var hideInactive = document.getElementById('hide-inactive-adapters');
      var hide = !hideInactive || hideInactive.checked;
      document.querySelectorAll('.adapter-block').forEach(function (block) {
        var hasActive = block.getAttribute('data-has-active') === '1';
        block.hidden = hide && !hasActive;
      });
    }
    function updateBlockState(block) {
      if (!block) return;
      var hasActive = Array.prototype.some.call(block.querySelectorAll('.adapter-row[data-running]'), function (row) {
        return row.getAttribute('data-running') === '1';
      });
      block.setAttribute('data-has-active', hasActive ? '1' : '0');
    }
    function adapterStatusTick() {
      fetch('/adapter/status.json', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.instances) return;
          Object.keys(data.instances).forEach(function (id) {
            var row = document.querySelector('.adapter-row[data-instance="' + id + '"]');
            if (!row) return;
            var st = adapterStateOf(data.instances[id]);
            adapterBadge(row.querySelector('[data-role="active"]'), st.active[0], st.active[1]);
            var conn = row.querySelector('[data-role="conn"]');
            adapterBadge(conn, st.conn[0], st.conn[1]);
            if (conn) conn.title = st.detail;
            row.setAttribute('data-enabled', data.instances[id].enabled ? '1' : '0');
            row.setAttribute('data-running', data.instances[id].running ? '1' : '0');
            updateBlockState(row.closest('.adapter-block'));
          });
          syncAdapterVisibility();
        }).catch(function () {});
    }
    var hideInactiveToggle = document.getElementById('hide-inactive-adapters');
    if (hideInactiveToggle) hideInactiveToggle.addEventListener('change', syncAdapterVisibility);
    document.querySelectorAll('.adapter-block').forEach(updateBlockState);
    syncAdapterVisibility();
    adapterStatusTick();
    setInterval(adapterStatusTick, 5000);
  `;

  return renderLayout({ title: 'Adapter', activePath: '/adapter', body, script });
}

function badge(role, cls, text, title) {
  return `<span class="adapter-badge adapter-badge--${cls}" data-role="${role}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;
}

function renderAdapterBlock(adapter, instances, statusById) {
  const hasActive = instances.some((inst) => !!(statusById[inst.id] && statusById[inst.id].running));
  const rows = instances.length
    ? instances.map((inst) => renderInstanceRow(adapter, inst, statusById[inst.id] || {})).join('\n')
    : '            <div class="adapter-row adapter-row--empty"><span class="muted">Noch keine Instanz angelegt.</span></div>';

  const header = instances.length
    ? `            <div class="adapter-row adapter-row--head">
              <span>Instanz</span><span>Adresse</span><span>Status</span><span>Verbindung</span><span></span>
            </div>`
    : '';

  return `          <div class="adapter-block" data-has-active="${hasActive ? '1' : '0'}">
            <div class="adapter-block-head">
              <div class="adapter-block-title">
                <strong>${escapeHtml(adapter.name)}</strong>
                <span class="adapter-prefix">${escapeHtml(adapter.prefix)}://</span>
                <span class="muted">${escapeHtml(adapter.description)} · v${escapeHtml(adapter.version)}</span>
              </div>
              <form action="/adapter/${escapeHtml(adapter.id)}/instances" method="POST" class="adapter-add-form">
                <input type="text" name="name" placeholder="Neue Instanz" required>
                <button type="submit">+ Instanz</button>
              </form>
            </div>
            <div class="adapter-rows">
${header}
${rows}
            </div>
          </div>`;
}

function renderInstanceRow(adapter, inst, status) {
  const enabled = inst.enabled;
  const running = !!status.running;
  const connected = !!status.connected;
  const active = running ? ['on', 'Aktiv'] : enabled ? ['warn', 'Startet…'] : ['off', 'Inaktiv'];
  const conn = !running ? ['off', '—'] : connected ? ['on', 'Verbunden'] : ['warn', 'Getrennt'];
  const toggleAction = enabled ? 'disable' : 'enable';
  const toggleLabel = enabled ? 'Deaktivieren' : 'Aktivieren';
  const toggleClass = enabled ? 'button-danger' : '';

  const tasmotaLink = adapter.id === 'tasmota'
    ? `<a href="/adapter/instance/${inst.id}/tasmota-devices" class="module-toggle-btn">Geräte</a>`
    : '';

  return `            <div class="adapter-row" data-instance="${inst.id}" data-enabled="${enabled ? '1' : '0'}" data-running="${running ? '1' : '0'}">
              <span class="adapter-col-name"><strong>${escapeHtml(inst.name)}</strong></span>
              <span class="adapter-col-addr muted">${escapeHtml(adapter.prefix)}://${escapeHtml(inst.name)}/</span>
              <span>${badge('active', active[0], active[1])}</span>
              <span>${badge('conn', conn[0], conn[1], status.detail)}</span>
              <span class="adapter-row-actions">
                <a href="/adapter/instance/${inst.id}" class="module-toggle-btn">Einstellungen</a>
                ${adapter.stateEditor ? `<a href="/adapter/instance/${inst.id}/states" class="module-toggle-btn">${escapeHtml(adapter.stateEditor.label)}</a>` : ''}
                ${tasmotaLink}
                <form action="/adapter/instance/${inst.id}/${toggleAction}" method="POST">
                  <button type="submit" class="module-toggle-btn ${toggleClass}">${toggleLabel}</button>
                </form>
                <form action="/adapter/instance/${inst.id}/delete" method="POST" onsubmit="return confirm('Instanz „${escapeHtml(inst.name)}“ wirklich löschen?');">
                  <button type="submit" class="module-toggle-btn button-danger">Löschen</button>
                </form>
              </span>
            </div>`;
}

// Generische Einstellungsseite einer Instanz: rendert das Schema aus dem Manifest.
// Ist das Schema leer, bleibt die Seite (bis auf Namen/Umbenennen) leer – der
// Adapter bestimmt selbst, was hier erscheint.
function renderAdapterInstance({ adapter, instance, message = '', error = '', hints = [] } = {}) {
  const fields = (adapter.settings || []).map((field) => renderSettingField(field, instance.settings)).join('\n');
  const settingsBlock = fields
    ? `          <div class="settings-card">
            <div class="settings-card-head">
              <h2>Einstellungen</h2>
              <p class="settings-card-hint">Diese Einstellungen gelten nur für diese Instanz.</p>
            </div>
            <div class="field-grid">
${fields}
            </div>
          </div>`
    : '          <div class="info-card"><p class="muted">Dieser Adapter stellt keine Einstellungen bereit.</p></div>';

  const editorLink = adapter.stateEditor
    ? ` · <a href="/adapter/instance/${instance.id}/states">${escapeHtml(adapter.stateEditor.label)} verwalten</a>`
    : '';
  const tasmotaLink = adapter.id === 'tasmota'
    ? ` · <a href="/adapter/instance/${instance.id}/tasmota-devices">Geräte ansehen</a>`
    : '';
  const body = `        <h1>${escapeHtml(adapter.name)} – ${escapeHtml(instance.name)}</h1>
        <p class="muted" style="margin-bottom:16px;">Adresse: <code>${escapeHtml(adapter.prefix)}://${escapeHtml(instance.name)}/</code>${editorLink}${tasmotaLink}</p>
        ${message ? statusText(message, 'success') : ''}
        ${error ? statusText(error) : ''}
        ${hints.map((hint) => `<p class="muted">${escapeHtml(hint)}</p>`).join('')}

        <form action="/adapter/instance/${instance.id}/rename" method="POST" class="settings-form" style="margin-bottom:16px;">
          <div class="settings-card">
            <div class="settings-card-head"><h2>Name</h2></div>
            <div class="field" style="display:flex; gap:8px; align-items:flex-end;">
              <input type="text" name="name" value="${escapeHtml(instance.name)}" required style="flex:1;">
              <button type="submit">Umbenennen</button>
            </div>
          </div>
        </form>

        <form action="/adapter/instance/${instance.id}/settings" method="POST" class="settings-form">
${settingsBlock}
          <div class="button-row">
            <a href="/adapter" class="module-toggle-btn">Zurück</a>
            ${fields ? '<button type="submit">Einstellungen speichern</button>' : ''}
          </div>
        </form>`;

  return renderLayout({ title: `Adapter – ${instance.name}`, activePath: '/adapter', body });
}

function renderSettingField(field, values) {
  const current = values && Object.prototype.hasOwnProperty.call(values, field.key)
    ? values[field.key]
    : field.default;
  const id = `setting-${escapeHtml(field.key)}`;
  const hint = field.hint ? `<p class="settings-card-hint">${escapeHtml(field.hint)}</p>` : '';
  let control;
  if (field.type === 'checkbox') {
    const checked = current === true || current === 'true' || current === 1 || current === '1';
    control = `<label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="${id}" name="${escapeHtml(field.key)}" value="1"${checked ? ' checked' : ''}> ${escapeHtml(field.label)}</label>`;
    return `              <div class="field">${control}${hint}</div>`;
  }
  if (field.type === 'select') {
    const options = field.options.map((o) => `<option value="${escapeHtml(o.value)}"${String(current) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    control = `<select id="${id}" name="${escapeHtml(field.key)}">${options}</select>`;
  } else {
    const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text';
    control = `<input type="${type}" id="${id}" name="${escapeHtml(field.key)}" value="${escapeHtml(current)}">`;
  }
  return `              <div class="field">
                <label for="${id}">${escapeHtml(field.label)}</label>
                ${control}
                ${hint}
              </div>`;
}

module.exports = { renderAdapters, renderAdapterInstance };
