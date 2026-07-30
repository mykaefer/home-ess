'use strict';

const express = require('express');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireAuth } = require('../auth/session');
const registry = require('../adapters/registry');
const instancesRepo = require('../adapters/instances');
const host = require('../adapters/host');
const presetsRepo = require('../adapters/presets');
const stateEditor = require('../adapters/state-editor');
const { renderAdapters, renderAdapterInstance } = require('../views/adapters');
const { renderAdapterStates, renderAdapterPresets, renderPresetSelection } = require('../views/adapter-states');
const renderTasmotaDevices = require('../views/tasmota-devices');
const renderAdapterDevices = require('../views/adapter-devices');
const bus = require('../state-bus');
const { buildSchemeTopic } = require('../mqtt/topics');
const { renderLayout } = require('../views/layout');
const adapterSecrets = require('../adapters/secrets');

function streamUpload(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(Object.assign(new Error('Upload ist zu groß.'), { status: 413 }));
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-upload-'));
    const file = path.join(dir, 'upload.bin');
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fs.rm(dir, { recursive: true, force: true }, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(Object.assign(new Error('Upload ist zu groß.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('aborted', () => fail(new Error('Upload wurde abgebrochen.')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ file, dir, size: bytes });
    });
    req.pipe(out);
  });
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolve(true));
    });
  });
}

async function suggestPort(start) {
  const base = Math.max(1024, Number(start) || 1883);
  for (let port = base; port < base + 20; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(port)) return port;
  }
  return null;
}

function adapterRoutes(db) {
  const router = express.Router();

  async function sendOverview(res, { message = '', error = '' } = {}) {
    const reg = registry.getRegistry();
    const all = await instancesRepo.listInstances(db);
    const byAdapter = new Map();
    const statusById = {};
    for (const inst of all) {
      if (!byAdapter.has(inst.adapterId)) byAdapter.set(inst.adapterId, []);
      byAdapter.get(inst.adapterId).push(inst);
      statusById[inst.id] = host.getStatus(inst.id);
    }
    res.send(renderAdapters({ registry: reg, instancesByAdapter: byAdapter, statusById, message, error }));
  }

  router.get('/adapter', requireAuth, (req, res) => {
    sendOverview(res).catch(() => res.status(500).send('Fehler beim Laden der Adapter.'));
  });

  // Live-Status (aktiv + Verbindung) je Instanz für die Adapter-Seite.
  router.get('/adapter/status.json', requireAuth, async (req, res) => {
    try {
      const all = await instancesRepo.listInstances(db);
      const instances = {};
      for (const inst of all) instances[inst.id] = { enabled: inst.enabled, ...host.getStatus(inst.id) };
      res.json({ instances });
    } catch (_) {
      res.status(500).json({ instances: {} });
    }
  });

  // Neue Instanz eines Adapters anlegen.
  router.post('/adapter/:adapterId/instances', requireAuth, (req, res) => {
    const manifest = registry.getManifest(req.params.adapterId);
    const name = String(req.body.name || '').trim();
    if (!manifest) return res.status(404).send('Unbekannter Adapter.');
    if (!name) return sendOverview(res, { error: 'Bitte einen Namen angeben.' });
    instancesRepo
      .createInstance(db, manifest.id, name)
      .then(() => sendOverview(res, { message: `Instanz „${name}" angelegt.` }))
      .catch(() => sendOverview(res, { error: 'Anlegen fehlgeschlagen.' }));
  });

  // Instanz-Einstellungsseite.
  router.get('/adapter/instance/:id', requireAuth, async (req, res) => {
    try {
      const instance = await instancesRepo.getInstance(db, Number(req.params.id));
      if (!instance) return res.status(404).send('Instanz nicht gefunden.');
      const manifest = registry.getManifest(instance.adapterId);
      if (!manifest) return res.status(404).send('Adapter nicht gefunden.');
      const hints = [];
      if (manifest.id === 'tasmota' && !host.getStatus(instance.id).running) {
        const port = Number(instance.settings && instance.settings.port) || 1883;
        if (!(await canBindPort(port))) {
          const alternative = await suggestPort(port + 1);
          hints.push(alternative
            ? `Port ${port} ist lokal bereits belegt. Vorschlag: ${alternative}.`
            : `Port ${port} ist lokal bereits belegt.`);
        }
      }
      res.send(renderAdapterInstance({ adapter: manifest, instance, hints }));
    } catch (_) {
      res.status(500).send('Fehler beim Laden.');
    }
  });

  const reload = (id) => host.reloadInstance(Number(id)).catch(() => {});

  router.post('/adapter/instance/:id/enable', requireAuth, (req, res) => {
    instancesRepo
      .setEnabled(db, Number(req.params.id), true)
      .then(() => reload(req.params.id))
      .then(() => sendOverview(res, { message: 'Instanz aktiviert.' }))
      .catch(() => sendOverview(res, { error: 'Aktivieren fehlgeschlagen.' }));
  });

  router.post('/adapter/instance/:id/disable', requireAuth, (req, res) => {
    instancesRepo
      .setEnabled(db, Number(req.params.id), false)
      .then(() => host.stopInstance(Number(req.params.id)))
      .then(() => sendOverview(res, { message: 'Instanz deaktiviert.' }))
      .catch(() => sendOverview(res, { error: 'Deaktivieren fehlgeschlagen.' }));
  });

  router.post('/adapter/instance/:id/rename', requireAuth, (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect(`/adapter/instance/${req.params.id}`);
    instancesRepo
      .renameInstance(db, Number(req.params.id), name)
      .then(() => reload(req.params.id))
      .then(() => res.redirect(`/adapter/instance/${req.params.id}`))
      .catch(() => res.redirect(`/adapter/instance/${req.params.id}`));
  });

  router.post('/adapter/instance/:id/settings', requireAuth, async (req, res) => {
    try {
      const instance = await instancesRepo.getInstance(db, Number(req.params.id));
      if (!instance) return res.status(404).send('Instanz nicht gefunden.');
      const manifest = registry.getManifest(instance.adapterId);
      if (!manifest) return res.status(404).send('Adapter nicht gefunden.');
      // Bestehende Settings als Basis behalten – sonst gingen nicht im settings-Schema
      // enthaltene Werte (v. a. der State-Editor-Speicher wie modbus-Register) verloren.
      const settings = { ...instance.settings };
      const changedSettings = {};
      for (const field of manifest.settings) {
        if (field.type === 'checkbox') {
          settings[field.key] = req.body[field.key] === '1' || req.body[field.key] === 'on';
        } else if (field.type === 'number') {
          const n = Number(String(req.body[field.key] == null ? '' : req.body[field.key]).replace(',', '.'));
          settings[field.key] = Number.isFinite(n) ? n : field.default;
        } else {
          settings[field.key] = req.body[field.key] == null ? '' : String(req.body[field.key]);
        }
        changedSettings[field.key] = settings[field.key];
      }
      // Nur die Formularfelder atomar patchen. Vom Adapter parallel persistierte
      // Metadaten wie HM-RPC settings.devices bleiben dadurch sicher erhalten.
      await instancesRepo.updateSettingKeys(db, instance.id, changedSettings);
      await reload(instance.id);
      const hints = [];
      if (manifest.id === 'tasmota' && !host.getStatus(instance.id).running) {
        const port = Number(settings.port) || 1883;
        if (!(await canBindPort(port))) {
          const alternative = await suggestPort(port + 1);
          hints.push(alternative
            ? `Port ${port} ist lokal bereits belegt. Vorschlag: ${alternative}.`
            : `Port ${port} ist lokal bereits belegt.`);
        }
      }
      res.send(renderAdapterInstance({
        adapter: manifest,
        instance: { ...instance, settings },
        message: 'Einstellungen gespeichert.',
        hints,
      }));
    } catch (_) {
      res.status(500).send('Speichern fehlgeschlagen.');
    }
  });

  router.post('/adapter/instance/:id/delete', requireAuth, (req, res) => {
    const instanceId = Number(req.params.id);
    host
      .stopInstance(instanceId)
      .then(() => instancesRepo.deleteInstance(db, instanceId))
      .then(() => adapterSecrets.removeInstance(instanceId))
      .then(() => sendOverview(res, { message: 'Instanz gelöscht.' }))
      .catch(() => sendOverview(res, { error: 'Löschen fehlgeschlagen.' }));
  });

  // Generische, vom Manifest aktivierte Geräteseite. Metadatenformat entspricht
  // der host.setStorage()-Struktur: device -> channels -> states.
  async function loadDevicePageContext(id) {
    const instance = await instancesRepo.getInstance(db, Number(id));
    if (!instance) return null;
    const manifest = registry.getManifest(instance.adapterId);
    return manifest && manifest.devicePage ? { instance, manifest } : null;
  }

  async function buildAdapterDevices(ctx) {
    const rows = await new Promise((resolve) => db.all(
      'SELECT * FROM adapter_states WHERE instance_id = ?', [ctx.instance.id],
      (err, result) => resolve(err ? [] : result || [])
    ));
    const byAddress = new Map(rows.map((row) => [String(row.address), row]));
    const cache = bus.getCache();
    const stored = ctx.instance.settings && ctx.instance.settings[ctx.manifest.devicePage.storageKey];
    const stateFor = (entry) => {
      const row = byAddress.get(String(entry.address));
      const cached = cache.get(buildSchemeTopic(ctx.manifest.prefix, ctx.instance.name, entry.address));
      const value = cached ? cached.value : (row ? row.last_value : null);
      const unit = (row && row.unit) || entry.unit || '';
      return { ...entry, name: (row && row.name) || entry.name || entry.address,
        display: unit && value != null && value !== '' ? `${value} ${unit}` : (value == null || value === '' ? '—' : String(value)) };
    };
    return (Array.isArray(stored) ? stored : []).map((device) => ({ ...device,
      channels: (device.channels || []).map((channel) => ({ ...channel, states: (channel.states || []).map(stateFor) })),
    })).sort((a, b) => String(a.customName || a.name || a.address).localeCompare(String(b.customName || b.name || b.address), 'de'));
  }

  router.get('/adapter/instance/:id/devices', requireAuth, async (req, res) => {
    const ctx = await loadDevicePageContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Keine Geräteseite für diese Instanz.');
    res.send(renderAdapterDevices({ adapter: ctx.manifest, instance: ctx.instance, devices: await buildAdapterDevices(ctx) }));
  });

  router.post('/adapter/instance/:id/devices/rename', requireAuth, async (req, res) => {
    const ctx = await loadDevicePageContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Keine Geräteseite für diese Instanz.');
    const address = String(req.body.address || '').trim();
    const customName = String(req.body.name || '').trim();
    const key = ctx.manifest.devicePage.storageKey;
    const devices = Array.isArray(ctx.instance.settings && ctx.instance.settings[key]) ? ctx.instance.settings[key] : [];
    const target = devices.find((row) => String(row.address || '') === address);
    if (!target) return res.status(404).send('Gerät nicht gefunden.');
    const next = devices.map((row) => String(row.address || '') === address ? { ...row, customName } : row);
    await instancesRepo.updateSettingKey(db, ctx.instance.id, key, next);
    const displayName = customName || String(target.name || address);
    const updates = [];
    for (const channel of target.channels || []) {
      for (const state of channel.states || []) {
        updates.push([`${displayName} / ${channel.name || channel.address}`, ctx.instance.id, String(state.address)]);
      }
    }
    await Promise.all(updates.map((params) => new Promise((resolve) => {
      db.run('UPDATE adapter_states SET category = ? WHERE instance_id = ? AND address = ?', params, () => resolve());
    })));
    await host.reloadInstance(ctx.instance.id).catch(() => {});
    ctx.instance = await instancesRepo.getInstance(db, ctx.instance.id);
    res.send(renderAdapterDevices({ adapter: ctx.manifest, instance: ctx.instance, devices: await buildAdapterDevices(ctx),
      message: customName ? `Gerät in „${customName}" umbenannt.` : 'Eigener Gerätename entfernt.' }));
  });

  // Generische Management-Brücke: Authentifizierung, Rollenprüfung, Layout und
  // begrenztes Upload-Streaming bleiben im Host. Fachlogik/HTML kommen aus dem
  // isolierten Adapterprozess über handleManagementRequest(request).
  router.use('/adapter/instance/:id/manage', requireAuth, async (req, res) => {
    let upload = null;
    try {
      const instance = await instancesRepo.getInstance(db, Number(req.params.id));
      if (!instance) return res.status(404).send('Instanz nicht gefunden.');
      const manifest = registry.getManifest(instance.adapterId);
      if (!manifest || !manifest.managementPage) return res.status(404).send('Keine Adapterverwaltung verfügbar.');
      const prefix = `/adapter/instance/${instance.id}/manage`;
      const originalPath = String(req.originalUrl || '').split('?')[0];
      const subpath = originalPath.startsWith(prefix) ? originalPath.slice(prefix.length) || '/' : '/';
      if (req.method === 'GET' && subpath === '/assets/management.css') {
        if (!manifest.managementPage.stylesheet) return res.status(404).send('Kein Adapter-Stylesheet vorhanden.');
        const stylesheetPath = path.join(manifest.dir, manifest.managementPage.stylesheet);
        return res.type('text/css').set('Cache-Control', 'private, max-age=300').sendFile(stylesheetPath);
      }
      const contentType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      if (contentType === 'application/octet-stream') {
        upload = await streamUpload(req, manifest.managementPage.maxUploadBytes);
      }
      const response = await host.managementRequest(instance.id, {
        method: req.method,
        path: subpath,
        basePath: prefix,
        query: req.query || {},
        body: upload ? null : (req.body || {}),
        upload: upload ? { path: upload.file, size: upload.size,
          filename: String(req.headers['x-upload-filename'] || 'upload.bin').slice(0, 255) } : null,
        access: {
          canRead: !!(req.access && req.access.canRead),
          canOperate: !!(req.access && req.access.canOperate),
          canWrite: !!(req.access && req.access.canWrite),
          isAdmin: !!(req.access && req.access.isAdmin),
        },
      });
      const status = Math.max(100, Math.min(599, Number(response && response.status) || 200));
      if (response && response.redirect) return res.redirect(status >= 300 && status < 400 ? status : 303, String(response.redirect));
      if (response && response.json !== undefined) return res.status(status).json(response.json);
      if (response && response.view) {
        return res.status(status).send(renderLayout({
          title: response.view.title || `${manifest.name} – ${manifest.managementPage.label}`,
          activePath: '/adapter',
          body: String(response.view.body || ''),
          script: String(response.view.script || ''),
          stylesheets: manifest.managementPage.stylesheet
            ? [`${prefix}/assets/management.css`]
            : [],
        }));
      }
      return res.status(status).type('text/plain').send(String((response && response.body) || ''));
    } catch (err) {
      const status = Number(err && err.status) || 500;
      if ((req.headers.accept || '').includes('application/json')) {
        return res.status(status).json({ error: err && err.message ? err.message : 'Adapterverwaltung fehlgeschlagen.' });
      }
      return res.status(status).send(err && err.message ? err.message : 'Adapterverwaltung fehlgeschlagen.');
    } finally {
      if (upload) fs.rm(upload.dir, { recursive: true, force: true }, () => {});
    }
  });

  // ── State-Editor (generisch, nur wenn der Adapter stateEditor deklariert) ──────

  // Lädt Instanz + Manifest + Editor; antwortet sonst mit 404.
  async function loadEditorContext(id) {
    const instance = await instancesRepo.getInstance(db, Number(id));
    if (!instance) return null;
    const manifest = registry.getManifest(instance.adapterId);
    if (!manifest || !manifest.stateEditor) return null;
    return { instance, manifest, editor: manifest.stateEditor };
  }

  function sendStatesPage(res, ctx, extra = {}) {
    const rows = stateEditor.getRows(ctx.instance, ctx.editor);
    res.send(renderAdapterStates({ adapter: ctx.manifest, instance: ctx.instance, editor: ctx.editor, rows, ...extra }));
  }

  function sendPresetsPage(res, ctx, extra = {}) {
    const rows = stateEditor.getRows(ctx.instance, ctx.editor);
    const presets = ctx.editor.presets ? presetsRepo.listPresets(ctx.manifest, ctx.editor) : [];
    res.send(renderAdapterPresets({ adapter: ctx.manifest, instance: ctx.instance, editor: ctx.editor, presets, hasRows: rows.length > 0, ...extra }));
  }

  const persistRows = async (ctx, rows) => {
    await instancesRepo.updateSettings(db, ctx.instance.id, stateEditor.withRows(ctx.instance, ctx.editor, rows));
    await host.reloadInstance(ctx.instance.id).catch(() => {});
  };

  router.get('/adapter/instance/:id/states', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Kein State-Editor für diesen Adapter.');
    sendStatesPage(res, ctx);
  });

  router.post('/adapter/instance/:id/states/save', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Kein State-Editor für diesen Adapter.');
    const row = stateEditor.normalizeRow(req.body, ctx.editor);
    const original = String(req.body.originalKey || '').trim();
    // Bei Fehlern den Dialog vorbefüllt wieder aufmachen, statt die Eingaben zu verwerfen.
    const reopen = (error) => sendStatesPage(res, ctx, { dialogOpen: true, dialogError: error, dialogValues: row, dialogOriginalKey: original });
    const errors = stateEditor.validateRow(row, ctx.editor);
    if (errors.length) return reopen(errors.join(' '));
    const key = stateEditor.rowKey(row, ctx.editor);
    const rows = stateEditor.getRows(ctx.instance, ctx.editor);
    // Duplikat-Adresse verhindern (außer man bearbeitet genau diesen Eintrag).
    if (rows.some((r) => stateEditor.rowKey(r, ctx.editor) === key && key !== original)) {
      return reopen(`Adresse „${key}" existiert bereits.`);
    }
    const next = original
      ? rows.map((r) => (stateEditor.rowKey(r, ctx.editor) === original ? row : r))
      : [...rows, row];
    if (original && !rows.some((r) => stateEditor.rowKey(r, ctx.editor) === original)) next.push(row);
    await persistRows(ctx, next);
    ctx.instance = await instancesRepo.getInstance(db, ctx.instance.id);
    sendStatesPage(res, ctx, { message: original ? 'State aktualisiert.' : 'State angelegt.' });
  });

  router.post('/adapter/instance/:id/states/delete', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Kein State-Editor für diesen Adapter.');
    const key = String(req.body.key || '').trim();
    const rows = stateEditor.getRows(ctx.instance, ctx.editor).filter((r) => stateEditor.rowKey(r, ctx.editor) !== key);
    await persistRows(ctx, rows);
    ctx.instance = await instancesRepo.getInstance(db, ctx.instance.id);
    sendStatesPage(res, ctx, { message: 'State gelöscht.' });
  });

  // ── Presets (eigene Seite) ──────────────────────────────────────────────────────

  router.get('/adapter/instance/:id/presets', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx || !ctx.editor.presets) return res.status(404).send('Keine Presets verfügbar.');
    sendPresetsPage(res, ctx);
  });

  router.get('/adapter/instance/:id/presets/:file', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx || !ctx.editor.presets) return res.status(404).send('Keine Presets verfügbar.');
    const data = presetsRepo.readPreset(ctx.manifest, req.params.file);
    const result = data && presetsRepo.validatePresetData(data, ctx.editor);
    if (!result || !result.ok) return sendPresetsPage(res, ctx, { error: (result && result.error) || 'Preset nicht lesbar.' });
    const editor = ctx.editor;
    const existing = new Set(stateEditor.getRows(ctx.instance, editor).map((r) => stateEditor.rowKey(r, editor)));
    const keyFields = editor.keyFields && editor.keyFields.length ? editor.keyFields : [editor.keyField];
    const catField = editor.categoryField && editor.columns.some((c) => c.key === editor.categoryField) ? editor.categoryField : null;
    const skip = new Set([...keyFields, editor.nameField, catField]);
    const detailCols = editor.columns.filter((c) => !skip.has(c.key));
    const entries = result.rows.map((e) => ({
      key: e.key,
      name: e.name,
      category: catField ? (e.row[catField] == null || e.row[catField] === '' ? 'Allgemein' : String(e.row[catField])) : '',
      exists: existing.has(e.key),
      detail: detailCols.map((c) => `${c.label}: ${e.row[c.key] === '' || e.row[c.key] == null ? '–' : e.row[c.key]}`).join(' · '),
    }));
    res.send(renderPresetSelection({ adapter: ctx.manifest, instance: ctx.instance, editor: ctx.editor, file: req.params.file, presetName: data.name || req.params.file, entries }));
  });

  router.post('/adapter/instance/:id/presets/:file/apply', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx || !ctx.editor.presets) return res.status(404).send('Keine Presets verfügbar.');
    const data = presetsRepo.readPreset(ctx.manifest, req.params.file);
    const result = data && presetsRepo.validatePresetData(data, ctx.editor);
    if (!result || !result.ok) return sendPresetsPage(res, ctx, { error: (result && result.error) || 'Preset nicht lesbar.' });
    let selected = req.body.keys || [];
    if (!Array.isArray(selected)) selected = [selected];
    const selectedSet = new Set(selected.map(String));
    const overwrite = req.body.overwrite === '1' || req.body.overwrite === 'on';
    const rows = stateEditor.getRows(ctx.instance, ctx.editor);
    const byKey = new Map(rows.map((r) => [stateEditor.rowKey(r, ctx.editor), r]));
    let added = 0;
    let updated = 0;
    for (const entry of result.rows) {
      if (!selectedSet.has(entry.key)) continue;
      if (byKey.has(entry.key)) {
        if (!overwrite) continue;
        byKey.set(entry.key, entry.row);
        updated += 1;
      } else {
        byKey.set(entry.key, entry.row);
        added += 1;
      }
    }
    await persistRows(ctx, Array.from(byKey.values()));
    ctx.instance = await instancesRepo.getInstance(db, ctx.instance.id);
    sendStatesPage(res, ctx, { message: `${added} angelegt, ${updated} überschrieben.` });
  });

  router.post('/adapter/instance/:id/presets/save', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx || !ctx.editor.presets) return res.status(404).send('Keine Presets verfügbar.');
    const rows = stateEditor.getRows(ctx.instance, ctx.editor);
    if (!rows.length) return sendPresetsPage(res, ctx, { error: 'Keine States zum Speichern vorhanden.' });
    const preset = presetsRepo.buildPreset(rows, ctx.editor, { name: String(req.body.name || '').trim() || 'Eigenes Preset' });
    try {
      const file = presetsRepo.savePreset(ctx.manifest, req.body.name, preset);
      sendPresetsPage(res, ctx, { message: `Als Preset „${file}" gespeichert.` });
    } catch (_) {
      sendPresetsPage(res, ctx, { error: 'Preset konnte nicht gespeichert werden.' });
    }
  });

  // Upload aus dem Browser: { fileName, data } als JSON (Datei wird clientseitig gelesen).
  router.post('/adapter/instance/:id/presets/upload', requireAuth, async (req, res) => {
    const ctx = await loadEditorContext(req.params.id).catch(() => null);
    if (!ctx || !ctx.editor.presets) return res.status(404).json({ ok: false, error: 'Keine Presets verfügbar.' });
    const result = presetsRepo.validatePresetData(req.body && req.body.data, ctx.editor);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    try {
      const file = presetsRepo.savePreset(ctx.manifest, (req.body && req.body.fileName) || (req.body.data && req.body.data.name) || 'upload', req.body.data);
      res.json({ ok: true, file });
    } catch (_) {
      res.status(500).json({ ok: false, error: 'Speichern fehlgeschlagen.' });
    }
  });

  async function loadTasmotaContext(id) {
    const instance = await instancesRepo.getInstance(db, Number(id));
    if (!instance || instance.adapterId !== 'tasmota') return null;
    const manifest = registry.getManifest(instance.adapterId);
    if (!manifest) return null;
    return { instance, manifest };
  }

  async function buildTasmotaDevices(instance) {
    const rows = await new Promise((resolve) => {
      db.all('SELECT * FROM adapter_states WHERE instance_id = ? ORDER BY category, name, address', [instance.id], (err, result) => {
        resolve(err ? [] : result || []);
      });
    });
    const cache = bus.getCache();
    const metaRows = Array.isArray(instance.settings && instance.settings.devices) ? instance.settings.devices : [];
    const byTopic = new Map();
    const topics = metaRows
      .map((device) => String(device.topic || ''))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const row of rows) {
      const address = String(row.address || '');
      const topic = topics.find((candidate) => address === candidate || address.startsWith(`${candidate}/`));
      if (!topic) continue;
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      const cacheEntry = cache.get(buildSchemeTopic('tasmota', instance.name, address));
      const value = cacheEntry ? cacheEntry.value : row.last_value;
      byTopic.get(topic).push({
        address,
        name: row.name || address,
        display: row.unit && value != null && value !== '' ? `${value} ${row.unit}` : (value == null || value === '' ? '—' : String(value)),
      });
    }
    return metaRows.map((device) => ({
      ...device,
      values: (byTopic.get(String(device.topic || '')) || []).sort((a, b) => a.address.localeCompare(b.address, 'de')),
    })).sort((a, b) => String(a.customName || a.friendlyName || a.topic || '').localeCompare(String(b.customName || b.friendlyName || b.topic || ''), 'de'));
  }

  router.get('/adapter/instance/:id/tasmota-devices', requireAuth, async (req, res) => {
    const ctx = await loadTasmotaContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Keine Tasmota-Geräteseite für diese Instanz.');
    const devices = await buildTasmotaDevices(ctx.instance);
    res.send(renderTasmotaDevices({ adapter: ctx.manifest, instance: ctx.instance, devices }));
  });

  router.post('/adapter/instance/:id/tasmota-devices/rename', requireAuth, async (req, res) => {
    const ctx = await loadTasmotaContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Keine Tasmota-Geräteseite für diese Instanz.');
    const topic = String(req.body.topic || '').trim();
    const customName = String(req.body.name || '').trim();
    const devices = Array.isArray(ctx.instance.settings && ctx.instance.settings.devices) ? ctx.instance.settings.devices : [];
    const found = devices.some((row) => String(row.topic || '') === topic);
    if (!found) {
      const current = await buildTasmotaDevices(ctx.instance);
      return res.status(404).send(renderTasmotaDevices({
        adapter: ctx.manifest, instance: ctx.instance, devices: current, error: 'Gerät nicht gefunden.',
      }));
    }
    const nextDevices = devices.map((row) => String(row.topic || '') === topic
      ? { ...row, customName }
      : row);
    await instancesRepo.updateSettingKey(db, ctx.instance.id, 'devices', nextDevices);
    const renamedDevice = nextDevices.find((row) => String(row.topic || '') === topic);
    const displayName = customName || String(renamedDevice.friendlyName || topic);
    await Promise.all((renamedDevice.fields || []).map((field) => new Promise((resolve) => {
      db.run(
        'UPDATE adapter_states SET name = ?, category = ? WHERE instance_id = ? AND address = ?',
        [
          `${displayName} ${field.name || field.path}`.trim(),
          `${displayName} / ${field.category || 'Werte'}`,
          ctx.instance.id,
          `${topic}/${field.path}`,
        ],
        () => resolve()
      );
    })));
    await host.reloadInstance(ctx.instance.id).catch(() => {});
    ctx.instance = await instancesRepo.getInstance(db, ctx.instance.id);
    const next = await buildTasmotaDevices(ctx.instance);
    res.send(renderTasmotaDevices({
      adapter: ctx.manifest,
      instance: ctx.instance,
      devices: next,
      message: customName ? `Gerät in „${customName}" umbenannt.` : 'Eigener Gerätename entfernt.',
    }));
  });

  router.post('/adapter/instance/:id/tasmota-devices/delete', requireAuth, async (req, res) => {
    const ctx = await loadTasmotaContext(req.params.id).catch(() => null);
    if (!ctx) return res.status(404).send('Keine Tasmota-Geräteseite für diese Instanz.');
    const topic = String(req.body.topic || '').trim();
    const devices = Array.isArray(ctx.instance.settings && ctx.instance.settings.devices) ? ctx.instance.settings.devices : [];
    await instancesRepo.updateSettingKey(db, ctx.instance.id, 'devices', devices.filter((row) => String(row.topic || '') !== topic));
    await new Promise((resolve) => {
      db.run('DELETE FROM adapter_states WHERE instance_id = ? AND (address = ? OR address LIKE ?)', [ctx.instance.id, topic, `${topic}/%`], () => resolve());
    });
    ctx.instance = await instancesRepo.getInstance(db, ctx.instance.id);
    const next = await buildTasmotaDevices(ctx.instance);
    res.send(renderTasmotaDevices({ adapter: ctx.manifest, instance: ctx.instance, devices: next, message: 'Gerät gelöscht.' }));
  });

  return router;
}

module.exports = adapterRoutes;
