'use strict';

// Tests der Seite „Logs": Ringpuffer (Aufnahme, Einstufung, Filter, Blättern),
// die JSON-Route samt Abrufbremse und die Einbindung in Navigation und
// Rechtemodell.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const logStore = require('../src/logging/log-store');
const logsRoutes = require('../src/routes/logs');
const renderLogs = require('../src/views/logs');
const { renderLayout, NAV } = require('../src/views/layout');
const { PAGES, fullAccess, runWithAccess } = require('../src/auth/access');

function fill(count, level = 'info', prefix = '[mqtt]') {
  for (let index = 1; index <= count; index += 1) logStore.append(level, `${prefix} Zeile ${index}`);
}

test.beforeEach(() => logStore.reset());

test('Die Quelle stammt aus dem Präfix; Adapter melden je Instanz', () => {
  assert.equal(logStore.parseSource('[adapters] Adapter geladen'), 'adapters');
  assert.equal(logStore.parseSource('[remote-access] paired'), 'remote-access');
  assert.equal(logStore.parseSource('[batterie dynMinSoc] gesetzt'), 'batterie');
  // Adapterinstanzen bleiben einzeln auswählbar, in ihrer Schreibweise.
  assert.equal(logStore.parseSource('[adapter hm-rpc://OpenCCU] Werteevents'), 'hm-rpc://OpenCCU');
  assert.equal(logStore.parseSource('[adapter hdp://hDP-Devices] FEHLER: offline'), 'hdp://hDP-Devices');
  // Ohne Präfix bleibt nur die Sammelquelle.
  assert.equal(logStore.parseSource('homeESS läuft auf Port 3000'), 'system');
});

test('Die Quellenauswahl unterscheidet Groß- und Kleinschreibung nicht', () => {
  logStore.append('info', '[adapter hm-rpc://OpenCCU] Werteevents');
  logStore.append('info', '[mqtt] verbunden');
  assert.equal(logStore.read({ source: 'hm-rpc://openccu' }).total, 1);
  assert.equal(logStore.read({ query: 'OPENCCU' }).total, 1);
});

test('Die Dringlichkeit kommt aus der console-Methode, FEHLER und WARNUNG stufen hoch', () => {
  assert.equal(logStore.classify('error', 'irgendetwas'), 'error');
  assert.equal(logStore.classify('warn', 'irgendetwas'), 'warn');
  assert.equal(logStore.classify('debug', 'irgendetwas'), 'debug');
  assert.equal(logStore.classify('log', '[mqtt] verbunden'), 'info');
  assert.equal(logStore.classify('log', '[adapter x] FEHLER: Topic fehlt'), 'error');
  assert.equal(logStore.classify('log', '[adapter x] WARNUNG: langsam'), 'warn');
});

test('console-Ausgaben landen im Puffer, die ursprüngliche Ausgabe bleibt erhalten', () => {
  const gesehen = [];
  const fakeConsole = {
    log: (...args) => gesehen.push(['log', ...args]),
    info: () => {}, warn: () => {}, debug: () => {},
    error: (...args) => gesehen.push(['error', ...args]),
  };
  assert.equal(logStore.install(fakeConsole), true);
  // Mehrfaches Einhängen bleibt wirkungslos.
  assert.equal(logStore.install(fakeConsole), false);
  try {
    fakeConsole.log('[mqtt] verbunden mit %s', 'localhost');
    fakeConsole.error('[adapters] Init fehlgeschlagen');
  } finally {
    logStore.uninstall();
  }
  // Die Originalausgabe wurde weiterhin bedient …
  assert.deepEqual(gesehen[0], ['log', '[mqtt] verbunden mit %s', 'localhost']);
  // … und der Puffer trägt die formatierte Zeile.
  const { entries } = logStore.read({});
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, 'error');
  assert.equal(entries[1].line, '[mqtt] verbunden mit localhost');
  assert.equal(entries[1].source, 'mqtt');
  // Nach dem Aushängen schreibt die console wieder unverändert.
  fakeConsole.log('[mqtt] danach');
  assert.equal(logStore.read({}).total, 2);
});

test('Der Puffer ist gedeckelt; die ältesten Zeilen fallen heraus', () => {
  fill(logStore.MAX_ENTRIES + 400);
  const data = logStore.read({});
  assert.ok(data.stored <= logStore.MAX_ENTRIES + 250, `Puffer zu groß: ${data.stored}`);
  assert.ok(data.dropped > 0, 'verworfene Zeilen werden gezählt');
  // Die neueste Zeile steht oben.
  assert.match(data.entries[0].line, new RegExp(`Zeile ${logStore.MAX_ENTRIES + 400}$`));
});

test('Nach Stufe, Quelle und Suchtext wird gefiltert', () => {
  logStore.append('info', '[mqtt] verbunden');
  logStore.append('error', '[adapters] Init fehlgeschlagen');
  logStore.append('warn', '[mqtt] Reconnect');
  logStore.append('debug', '[perf] Messwerte');

  assert.equal(logStore.read({ levels: 'error' }).total, 1);
  assert.equal(logStore.read({ levels: ['error', 'warn'] }).total, 2);
  // Alle Stufen ausgewählt heißt: kein Filter.
  assert.equal(logStore.read({ levels: 'error,warn,info,debug' }).total, 4);
  assert.equal(logStore.read({ source: 'mqtt' }).total, 2);
  assert.equal(logStore.read({ query: 'reconnect' }).total, 1, 'Suche ist unabhängig von Groß-/Kleinschreibung');
  assert.equal(logStore.read({ source: 'mqtt', query: 'verbunden' }).total, 1);
  assert.deepEqual(logStore.read({}).sources, ['adapters', 'mqtt', 'perf']);
  assert.deepEqual(logStore.read({}).counts, { error: 1, warn: 1, info: 1, debug: 1 });
});

test('Geblättert wird in festen Seiten; der Anker hält Folgeseiten ruhig', () => {
  fill(logStore.PAGE_SIZE * 2 + 10);
  const erste = logStore.read({ page: 1 });
  assert.equal(erste.entries.length, logStore.PAGE_SIZE);
  assert.equal(erste.totalPages, 3);
  assert.equal(erste.page, 1);

  const anker = erste.latestId;
  const zweite = logStore.read({ page: 2, anchorId: anker });
  assert.equal(zweite.entries[0].id, erste.entries[logStore.PAGE_SIZE - 1].id - 1);

  // Neue Zeilen verschieben die angeankerte Seite nicht.
  fill(50, 'info', '[neu]');
  const nochmal = logStore.read({ page: 2, anchorId: anker });
  assert.deepEqual(nochmal.entries.map((entry) => entry.id), zweite.entries.map((entry) => entry.id));
  // Ohne Anker wäre der Inhalt weitergewandert.
  assert.notDeepEqual(logStore.read({ page: 2 }).entries.map((entry) => entry.id), zweite.entries.map((entry) => entry.id));

  // Eine zu hohe Seitenzahl landet auf der letzten Seite statt im Leeren.
  assert.equal(logStore.read({ page: 99, anchorId: anker }).page, 3);
});

test('Die Seite trägt Filter, Suche, Pause und Blätterung', () => {
  logStore.append('error', '[adapters] Init fehlgeschlagen');
  const html = renderLogs({ initial: logStore.read({}) });

  assert.match(html, /<h1>Logs<\/h1>/);
  assert.match(html, /id="log-search"/);
  assert.match(html, /id="log-source"/);
  assert.match(html, /id="log-interval"/);
  assert.match(html, /id="log-pause"/);
  assert.match(html, /id="log-newer"/);
  assert.match(html, /id="log-older"/);
  // Jede Stufe hat einen eigenen Schalter …
  for (const level of logStore.LEVELS) assert.match(html, new RegExp(`data-log-level="${level}"`));
  // … und jede Zeile ihre Farbklasse.
  assert.match(html, /class="log-row log-row--error"/);
  // Die erste Seite kommt server-gerendert, nicht erst per Skript.
  assert.match(html, /Init fehlgeschlagen/);
  // Der Pausenzustand wird nirgends gespeichert: das Seitenskript kennt weder
  // Browserspeicher noch eine Rückmeldung an den Server, und startet immer
  // laufend.
  const seitenSkript = html.slice(html.indexOf('var logPaused'));
  assert.match(seitenSkript, /var logPaused = false;/);
  assert.doesNotMatch(seitenSkript, /localStorage|sessionStorage|document\.cookie/);
});

test('Der Takt beginnt bei einer Sekunde und wird serverseitig begrenzt', () => {
  const html = renderLogs({ initial: logStore.read({}), minIntervalMs: 750 });
  // Vorgabe ist der schnellste Takt: die Liste läuft praktisch mit.
  assert.match(html, /var logIntervalMs = 1000;/);
  assert.match(html, /<option value="1000" selected>1 s<\/option>/);
  assert.match(html, /var logMinIntervalMs = 750;/);
  // Kein Takt unterhalb einer Sekunde wählbar.
  const optionen = [...html.matchAll(/<option value="(\d+)"[^>]*>\d+ s<\/option>/g)].map((match) => Number(match[1]));
  assert.ok(optionen.length >= 4, `zu wenige Takte: ${optionen}`);
  assert.ok(optionen.every((wert) => wert >= 1000), `zu schneller Takt wählbar: ${optionen}`);
});

test('Logs stehen an letzter Stelle des Hauptmenüs und im Rechtemodell', () => {
  const html = renderLayout({ title: 'Navigation', activePath: '/logs', body: '<p>Test</p>' });
  const link = html.indexOf('href="/logs"');
  assert.ok(link > 0, 'der Menüpunkt ist vorhanden');
  for (const item of NAV.filter((entry) => entry.section === 'main' && entry.path !== '/logs')) {
    assert.ok(html.indexOf(`href="${item.path}"`) < link, `${item.path} muss vor den Logs stehen`);
  }
  assert.ok(PAGES.some((page) => page.key === 'logs' && page.prefix === '/logs'));
});

// --- Routen -----------------------------------------------------------------

let server;
let baseUrl;
let sessionId = 'test-session';

test.before(async () => {
  const app = express();
  app.use((req, res, next) => {
    req.session = sessionId ? { id: sessionId, userId: 1 } : null;
    req.access = fullAccess();
    runWithAccess(req.access, () => next());
  });
  app.use(logsRoutes());
  server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('GET /logs liefert die Seite aus', async () => {
  logStore.append('warn', '[mqtt] Reconnect');
  const response = await fetch(`${baseUrl}/logs`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /log-row--warn/);
});

test('GET /logs/daten filtert, blättert und erkennt den unveränderten Stand', async () => {
  logStore.reset();
  logStore.append('error', '[adapters] Init fehlgeschlagen');
  logStore.append('info', '[mqtt] verbunden');

  sessionId = 'abruf-1';
  const erste = await (await fetch(`${baseUrl}/logs/daten?stufe=error`)).json();
  assert.equal(erste.total, 1);
  assert.equal(erste.entries[0].source, 'adapters');

  // Zweiter Abruf derselben Sitzung wird von der Bremse abgewiesen.
  const gebremst = await fetch(`${baseUrl}/logs/daten?stufe=error`);
  assert.equal(gebremst.status, 429);
  assert.ok(Number(gebremst.headers.get('Retry-After')) >= 1);

  // Andere Sitzung, unveränderter Stand: nur das Kennzeichen, keine Liste.
  sessionId = 'abruf-2';
  const unveraendert = await (await fetch(
    `${baseUrl}/logs/daten?stufe=error&bekannt=${erste.latestId}&bekanntGesamt=${erste.total}`
  )).json();
  assert.equal(unveraendert.unchanged, true);
  assert.equal(unveraendert.entries, undefined);
});

test('GET /logs/daten antwortet ohne Sitzung mit 401 statt einer Weiterleitung', async () => {
  sessionId = '';
  const response = await fetch(`${baseUrl}/logs/daten`, { redirect: 'manual' });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Nicht angemeldet.');
  sessionId = 'test-session';
});
