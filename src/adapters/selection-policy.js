'use strict';

// Dauerhafte Auswahl bewusst entfernter Adapter. Die Datei liegt außerhalb des
// austauschbaren Git-Checkouts und wird von Webprozess, Installer und
// privilegiertem Self-Updater gemeinsam ausgewertet.

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z][a-z0-9_-]*$/;

function normalizeId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`Ungültige Adapter-ID: ${id || '(leer)'}.`);
  return id;
}

function readSelection(file) {
  if (!fs.existsSync(file)) return { version: 1, removed: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Adapter-Auswahl ist nicht lesbar: ${error.message}`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.removed)) {
    throw new Error('Adapter-Auswahl besitzt ein ungültiges Format.');
  }
  const removed = [];
  const seen = new Set();
  for (const value of parsed.removed) {
    const id = normalizeId(value);
    if (!seen.has(id)) removed.push(id);
    seen.add(id);
  }
  removed.sort();
  return { version: 1, removed };
}

function writeSelection(file, removed) {
  const ids = [...new Set(Array.from(removed, normalizeId))].sort();
  if (!ids.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, removed: ids }, null, 2)}\n`, {
      flag: 'wx', mode: 0o640,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o640);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function isRemoved(file, adapterId) {
  return readSelection(file).removed.includes(normalizeId(adapterId));
}

function markRemoved(file, adapterId) {
  const selection = readSelection(file);
  selection.removed.push(normalizeId(adapterId));
  writeSelection(file, selection.removed);
}

function markInstalled(file, adapterId) {
  const id = normalizeId(adapterId);
  const selection = readSelection(file);
  writeSelection(file, selection.removed.filter((entry) => entry !== id));
}

function reconcileUpdate({ previousAdapterDir, nextAdapterDir, selectionFile, restoreAll = false }) {
  const selection = readSelection(selectionFile);
  const removed = restoreAll ? new Set() : new Set(selection.removed);
  fs.mkdirSync(nextAdapterDir, { recursive: true, mode: 0o755 });

  if (restoreAll) writeSelection(selectionFile, []);
  for (const id of removed) {
    fs.rmSync(path.join(nextAdapterDir, id), { recursive: true, force: true });
  }

  let preserved = 0;
  if (previousAdapterDir && fs.existsSync(previousAdapterDir)) {
    for (const entry of fs.readdirSync(previousAdapterDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !ID_RE.test(entry.name)
          || removed.has(entry.name)) continue;
      const target = path.join(nextAdapterDir, entry.name);
      if (fs.existsSync(target)) continue;
      fs.cpSync(path.join(previousAdapterDir, entry.name), target, {
        recursive: true, errorOnExist: true, force: false,
      });
      preserved += 1;
    }
  }
  return { removed: removed.size, preserved, restoreAll: !!restoreAll };
}

if (require.main === module) {
  const [command, previous, next, selectionFile, restoreAll] = process.argv.slice(2);
  if (command !== 'reconcile' || !next || !selectionFile) {
    process.stderr.write('Verwendung: selection-policy.js reconcile <vorher|-> <nachher> <auswahl.json> <0|1>\n');
    process.exitCode = 2;
  } else {
    const result = reconcileUpdate({
      previousAdapterDir: previous && previous !== '-' ? previous : null,
      nextAdapterDir: next,
      selectionFile,
      restoreAll: restoreAll === '1',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

module.exports = {
  readSelection,
  writeSelection,
  isRemoved,
  markRemoved,
  markInstalled,
  reconcileUpdate,
};
