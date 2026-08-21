'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const systemWarning = require('../src/system-warning');
const { renderLayout } = require('../src/views/layout');

function createDb() {
  const db = new sqlite3.Database(':memory:');
  return new Promise((resolve, reject) => {
    db.exec(
      `CREATE TABLE system_warning (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        raised_at INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT ''
      );
      INSERT OR IGNORE INTO system_warning (id) VALUES (1);`,
      (err) => (err ? reject(err) : resolve(db))
    );
  });
}

test('eine gemeldete Warnung setzt Text und Aktiv-Flag', async () => {
  systemWarning.resetForTests();
  const db = await createDb();
  await systemWarning.init(db);
  assert.deepEqual(
    { active: systemWarning.getState().active, text: systemWarning.getState().text },
    { active: false, text: '' }
  );

  await systemWarning.raise(db, 'Netzschaltung nicht bestätigt', { source: 'Netzsteuerung' });
  const state = systemWarning.getState();
  assert.equal(state.active, true);
  assert.equal(state.text, 'Netzschaltung nicht bestätigt');
  assert.equal(state.source, 'Netzsteuerung');
  assert.ok(state.raisedAt > 0);

  await new Promise((resolve) => db.close(resolve));
});

test('ein identischer Warntext behält den Zeitstempel der ersten Meldung', async () => {
  systemWarning.resetForTests();
  const db = await createDb();
  await systemWarning.init(db);
  await systemWarning.raise(db, 'Gleiche Warnung', { now: 1000 });
  await systemWarning.raise(db, 'Gleiche Warnung', { now: 9000 });
  assert.equal(systemWarning.getState().raisedAt, 1000);

  await systemWarning.raise(db, 'Neue Warnung', { now: 9000 });
  assert.equal(systemWarning.getState().text, 'Neue Warnung');
  assert.equal(systemWarning.getState().raisedAt, 9000);
  await new Promise((resolve) => db.close(resolve));
});

test('das Quittieren leert den Warntext und meldet es den Zuhörern', async () => {
  systemWarning.resetForTests();
  const db = await createDb();
  await systemWarning.init(db);
  const seen = [];
  systemWarning.onAcknowledged((previous) => seen.push(previous.text));

  await systemWarning.raise(db, 'Anlage prüfen');
  await systemWarning.acknowledge(db);

  assert.deepEqual(systemWarning.getState(), { active: false, text: '', raisedAt: 0, source: '' });
  assert.deepEqual(seen, ['Anlage prüfen']);

  // Persistenz: Nach einem Neustart bleibt die Warnung quittiert.
  systemWarning.resetForTests();
  await systemWarning.init(db);
  assert.equal(systemWarning.getState().active, false);
  await new Promise((resolve) => db.close(resolve));
});

test('eine aktive Warnung überdauert den Neustart', async () => {
  systemWarning.resetForTests();
  const db = await createDb();
  await systemWarning.init(db);
  await systemWarning.raise(db, 'Dauerfehler', { source: 'Netzsteuerung' });

  systemWarning.resetForTests();
  await systemWarning.init(db);
  assert.equal(systemWarning.getState().active, true);
  assert.equal(systemWarning.getState().text, 'Dauerfehler');
  await new Promise((resolve) => db.close(resolve));
});

test('leere Warntexte werden nicht übernommen', async () => {
  systemWarning.resetForTests();
  const db = await createDb();
  await systemWarning.init(db);
  await systemWarning.raise(db, '   ');
  assert.equal(systemWarning.getState().active, false);
  await new Promise((resolve) => db.close(resolve));
});

test('das Warnband erscheint auf jeder Seite, nur wenn eine Warnung aktiv ist', async () => {
  systemWarning.resetForTests();
  const db = await createDb();
  await systemWarning.init(db);

  const quiet = renderLayout({ title: 'Test', activePath: '/dashboard', body: '<p>x</p>' });
  assert.match(quiet, /id="system-warning-banner"[^>]*hidden/);

  await systemWarning.raise(db, 'Netzschaltung nicht bestätigt <prüfen>');
  const alarmed = renderLayout({ title: 'Test', activePath: '/dashboard', body: '<p>x</p>' });
  assert.doesNotMatch(alarmed, /id="system-warning-banner"[^>]*hidden/);
  // Ausgabe escapen (src/views/components.js).
  assert.match(alarmed, /Netzschaltung nicht bestätigt &lt;prüfen&gt;/);
  assert.match(alarmed, /id="system-warning-ack"/);
  assert.match(alarmed, /\/live\/warnung\/quittieren/);

  systemWarning.resetForTests();
  await new Promise((resolve) => db.close(resolve));
});
