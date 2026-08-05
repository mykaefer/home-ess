'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../src/adapters/selection-policy');

function adapter(root, id, content) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), content);
}

test('Adapterauswahl bleibt updatefest: offiziell aktualisieren, eigene bewahren, entfernte auslassen', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous');
  const next = path.join(root, 'next');
  const selection = path.join(root, 'data', 'adapter-selection.json');

  adapter(previous, 'official_keep', 'alte Version');
  adapter(previous, 'custom', 'eigener Adapter');
  adapter(next, 'official_keep', 'neue Version');
  adapter(next, 'official_removed', 'würde wiederkommen');
  adapter(next, 'official_new', 'neu im Repository');
  policy.markRemoved(selection, 'official_removed');

  const result = policy.reconcileUpdate({
    previousAdapterDir: previous, nextAdapterDir: next, selectionFile: selection,
  });
  assert.deepEqual(result, { removed: 1, preserved: 1, restoreAll: false });
  assert.equal(fs.readFileSync(path.join(next, 'official_keep', 'marker.txt'), 'utf8'), 'neue Version');
  assert.equal(fs.readFileSync(path.join(next, 'custom', 'marker.txt'), 'utf8'), 'eigener Adapter');
  assert.equal(fs.existsSync(path.join(next, 'official_removed')), false);
  assert.equal(fs.existsSync(path.join(next, 'official_new')), true);
  assert.equal(policy.isRemoved(selection, 'official_removed'), true);
});

test('--all stellt offizielle Adapter wieder her und löscht die Entfernungsauswahl', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-selection-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous');
  const next = path.join(root, 'next');
  const selection = path.join(root, 'data', 'adapter-selection.json');
  adapter(previous, 'custom', 'eigen');
  adapter(next, 'official_removed', 'offiziell');
  policy.markRemoved(selection, 'official_removed');

  const result = policy.reconcileUpdate({
    previousAdapterDir: previous, nextAdapterDir: next, selectionFile: selection, restoreAll: true,
  });
  assert.deepEqual(result, { removed: 0, preserved: 1, restoreAll: true });
  assert.equal(fs.existsSync(path.join(next, 'official_removed')), true);
  assert.equal(fs.existsSync(path.join(next, 'custom')), true);
  assert.equal(fs.existsSync(selection), false, 'root-Aufruf hinterlässt keine root-eigene leere Policydatei');
});

test('beschädigte Auswahl bricht ein Update vor jeder Adapteränderung ab', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-adapter-selection-bad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const next = path.join(root, 'next');
  const selection = path.join(root, 'selection.json');
  adapter(next, 'official', 'unverändert');
  fs.writeFileSync(selection, '{kaputt');
  assert.throws(() => policy.reconcileUpdate({
    previousAdapterDir: null, nextAdapterDir: next, selectionFile: selection,
  }), /nicht lesbar/);
  assert.equal(fs.readFileSync(path.join(next, 'official', 'marker.txt'), 'utf8'), 'unverändert');
});
