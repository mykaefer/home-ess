'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { renderLayout } = require('../src/views/layout');
const { runWithAccess, accessForUser } = require('../src/auth/access');
const code = fs.readFileSync(path.join(__dirname, '../public/page-refresh.js'), 'utf8');

function browser({ forms = [], href = 'http://homeess.invalid/conditions' } = {}) {
  let now = 0, nextId = 0, reloads = 0;
  let open = false, drag = false;
  const tasks = new Map();
  const listeners = new Map();
  const requests = [];
  const key = (owner, event) => owner + ':' + event;
  function add(owner, event, fn) {
    const id = key(owner, event);
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(fn);
  }
  function remove(owner, event, fn) { if (listeners.has(key(owner, event))) listeners.get(key(owner, event)).delete(fn); }
  function event(owner, event, data = {}) { for (const fn of listeners.get(key(owner, event)) || []) fn(data); }
  function timer(fn, wait, interval = false) {
    const id = ++nextId;
    tasks.set(id, { fn, at: now + wait, interval: interval ? wait : 0 });
    return id;
  }
  const main = { querySelectorAll: () => forms, contains: element => element && element.inMain };
  const document = {
    hidden: false, activeElement: null,
    querySelector: selector => {
      if (selector === 'meta[name="homeess-page-version"]') return { content: 'old' };
      if (selector === '.main-content') return main;
      if (selector.includes('dialog[open]') || selector === ':popover-open') return open ? {} : null;
      return drag ? {} : null;
    },
    addEventListener: (name, fn) => add('document', name, fn),
    removeEventListener: (name, fn) => remove('document', name, fn),
  };
  const window = {
    location: { href, reload: () => reloads++ },
    setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: id => tasks.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: id => tasks.delete(id),
    addEventListener: (name, fn) => add('window', name, fn),
    removeEventListener: (name, fn) => remove('window', name, fn),
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  };
  vm.runInNewContext(code, {
    window, document, AbortController,
    Date: { now: () => now },
    DOMParser: class { parseFromString(html) { return { querySelector: () => html ? { content: html } : null }; } },
  });
  async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, task] = next;
      now = task.at;
      if (task.interval) task.at += task.interval;
      else tasks.delete(id);
      task.fn();
      await flush();
    }
    now = end;
    await flush();
  }
  async function answer(index, content, status = 200, redirected = false) {
    requests[index].resolve({ ok: status === 200, status, redirected, text: async () => content });
    await flush();
  }
  return {
    requests, document, advance, answer,
    mqtt: () => event('window', 'homeess:mqtt'),
    visibility: hidden => { document.hidden = hidden; event('document', 'visibilitychange'); },
    leave: () => event('window', 'pagehide'),
    returnFromCache: () => event('window', 'pageshow', { persisted: true }),
    dialog: value => { open = value; }, dragging: value => { drag = value; },
    get reloads() { return reloads; },
  };
}

const field = (value, type = 'text') => ({ name: 'setting', type, value, checked: false, disabled: false });
const form = (...fields) => ({ querySelectorAll: () => fields, closest: () => null });

test('Ereignis-Bursts und Minutentakt erzeugen nur eine Anfrage; laufende Anfragen überlappen nicht', async () => {
  const b = browser();
  for (let i = 0; i < 100; i++) b.mqtt();
  await b.advance(59999);
  assert.equal(b.requests.length, 0);
  await b.advance(1);
  assert.equal(b.requests.length, 1);
  for (let i = 0; i < 100; i++) b.mqtt();
  await b.advance(2000);
  assert.equal(b.requests.length, 1);
  await b.answer(0, 'old');
  assert.equal(b.reloads, 0);
  await b.advance(59000);
  assert.equal(b.requests.length, 2);
  await b.answer(1, 'new');
  assert.equal(b.reloads, 1);
});

test('Ohne MQTT-Verbindung bleibt die periodische Inhaltsprüfung aktiv', async () => {
  const b = browser();
  await b.advance(60000);
  assert.equal(b.requests.length, 0);
  await b.advance(1000);
  assert.equal(b.requests.length, 1);
  await b.answer(0, 'old');
  assert.equal(b.reloads, 0);
});

test('Versteckte Tabs und offene Dialoge pausieren; Sichtbarkeit setzt die Prüfung fort', async () => {
  const b = browser();
  b.visibility(true);
  b.mqtt();
  await b.advance(120000);
  assert.equal(b.requests.length, 0);
  b.visibility(false);
  b.dialog(true);
  await b.advance(1000);
  assert.equal(b.requests.length, 0);
  b.dialog(false);
  b.mqtt();
  await b.advance(1000);
  assert.equal(b.requests.length, 1);
  b.dialog(true);
  await b.answer(0, 'changed');
  assert.equal(b.reloads, 0);
});

test('Ungespeicherte Felder, Fokus und Drag-and-drop bleiben auch bei externen Änderungen erhalten', async () => {
  const input = field('before');
  const b = browser({ forms: [form(input)] });
  input.value = 'unsaved';
  b.mqtt();
  await b.advance(60000);
  assert.equal(b.requests.length, 0);
  input.value = 'before';
  b.document.activeElement = { inMain: true, matches: () => true };
  b.mqtt();
  await b.advance(1000);
  assert.equal(b.requests.length, 0);
  b.document.activeElement = null;
  b.dragging(true);
  b.mqtt();
  await b.advance(1000);
  assert.equal(b.requests.length, 0);
  b.dragging(false);
  b.mqtt();
  await b.advance(1000);
  assert.equal(b.requests.length, 1);
  input.value = 'edited during request';
  await b.answer(0, 'changed');
  assert.equal(b.reloads, 0);
});

test('Abgebrochene Dialoge blockieren nicht dauerhaft; der Browser-Cache bewahrt offene Eingaben', async () => {
  const input = field('initial');
  const closedDialogForm = { querySelectorAll: () => [input], closest: () => ({}) };
  const b = browser({ forms: [closedDialogForm] });
  input.value = 'cancelled edit';
  b.mqtt();
  await b.advance(60000);
  assert.equal(b.requests.length, 1);
  await b.answer(0, 'old');
  b.leave();
  b.dialog(true);
  b.returnFromCache();
  await b.advance(60000);
  assert.equal(b.requests.length, 1);
  assert.equal(b.reloads, 0);
  b.dialog(false);
  b.mqtt();
  await b.advance(1000);
  assert.equal(b.requests.length, 2);
  await b.answer(1, 'new');
  assert.equal(b.reloads, 1);
});

test('Mehrfach-Dateiuploads auf Adapterseiten bleiben vor einem Neuladen geschützt', async () => {
  const upload = { ...field('', 'file'), multiple: true, files: [] };
  const b = browser({ forms: [form(upload)] });
  upload.files = [{ name: 'firmware.bin', size: 4096, lastModified: 1 }];
  b.mqtt();
  await b.advance(60000);
  assert.equal(b.requests.length, 0);
  upload.files = [];
  b.mqtt();
  await b.advance(1000);
  assert.equal(b.requests.length, 1);
  await b.answer(0, 'old');
  assert.equal(b.reloads, 0);
});

test('Read-only-Freigaben und nachträgliche Theme-Felder verhindern die Aktualisierung nicht', async () => {
  const input = field('unchanged');
  const fields = [input];
  const b = browser({ forms: [{ querySelectorAll: () => fields, closest: () => null }], href: 'http://homeess.invalid/share/token/speech?theme=dunkel' });
  input.disabled = true;
  fields.push(field('dunkel', 'hidden'));
  b.mqtt();
  await b.advance(60000);
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].url, 'http://homeess.invalid/share/token/speech?theme=dunkel');
  await b.answer(0, 'new');
  assert.equal(b.reloads, 1);
});

test('Widerrufene Freigaben stoppen den Timer; Weiterleitungen und Fehler laden nichts neu', async () => {
  const b = browser();
  b.mqtt();
  await b.advance(60000);
  await b.answer(0, 'new', 404);
  await b.advance(180000);
  b.mqtt();
  await b.advance(60000);
  assert.equal(b.requests.length, 1);
  assert.equal(b.reloads, 0);
  const redirected = browser();
  redirected.mqtt();
  await redirected.advance(60000);
  await redirected.answer(0, 'login', 200, true);
  assert.equal(redirected.reloads, 0);
});

test('Verlassen der Seite bricht die laufende Anfrage ab und entfernt Timer', async () => {
  const b = browser();
  b.mqtt();
  await b.advance(60000);
  b.leave();
  assert.equal(b.requests[0].options.signal.aborted, true);
  await b.answer(0, 'new');
  await b.advance(180000);
  assert.equal(b.reloads, 0);
  assert.equal(b.requests.length, 1);
});

test('Das Layout deckt Seiten ohne Live-Abruf ab und vermeidet doppeltes Polling', () => {
  const args = { title: 'Test', activePath: '/conditions', body: '<h1>Bedingungen</h1>' };
  const html = renderLayout(args);
  assert.match(html, /src="\/page-refresh.js" defer/);
  const hash = source => source.match(/name="homeess-page-version" content="([a-f0-9]{64})"/)[1];
  assert.equal(hash(html), hash(renderLayout(args)));
  assert.notEqual(hash(html), hash(renderLayout({ ...args, body: '<h1>Geändert</h1>' })));
  assert.doesNotMatch(renderLayout({ ...args, periodicRefresh: true }), /page-refresh.js|homeess-page-version/);
  const share = { token: 'a'.repeat(64), path: '/conditions', mode: 'read', theme: 'dunkel' };
  const access = { ...accessForUser({ role: 'read' }), publicShare: share, theme: 'dunkel' };
  assert.match(runWithAccess(access, () => renderLayout(args)), /src="\/page-refresh.js" defer/);
});
