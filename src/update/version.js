'use strict';

const fs = require('fs');
const path = require('path');

// homeESS-Versionen bestehen ausschließlich aus drei Zahlen. Bewusst kein
// Semver-Paket: Vorab-Kennzeichen (Beta, Release Candidate) gibt es nicht, und
// sie sollen hier auch nicht erraten werden.
const VERSION_RE = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/;

function normalizeVersion(value) {
  const match = VERSION_RE.exec(String(value || '').trim());
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) throw new TypeError('Ungültige homeESS-Version.');
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (aa[index] !== bb[index]) return aa[index] < bb[index] ? -1 : 1;
  }
  return 0;
}

// VERSION.json ist die maßgebliche Versionsangabe – lokal wie online. Sie löst
// den früheren Release-Tag ab, damit `main` und `development` unabhängig
// voneinander eine eigene Nummer führen können.
//
// Inhalt ist ein JSON-Objekt mit dem Feld `version`:
//   { "version": "1.7.3" }
const VERSION_FILE = 'VERSION.json';

function parseVersionFile(text) {
  try {
    const document = JSON.parse(String(text == null ? '' : text));
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
    return normalizeVersion(document.version);
  } catch (_) {
    return null;
  }
}

// Version der Installation: VERSION.json im Stammverzeichnis, ersatzweise
// package.json. Der Rückfall hält ältere Arbeitskopien lauffähig, in denen die
// Datei noch fehlt.
function readLocalVersion(rootDir = path.join(__dirname, '..', '..')) {
  try {
    const fromFile = parseVersionFile(fs.readFileSync(path.join(rootDir, VERSION_FILE), 'utf8'));
    if (fromFile) return fromFile;
  } catch (_) { /* Rückfall auf package.json */ }
  try {
    return normalizeVersion(JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version);
  } catch (_) {
    return null;
  }
}

module.exports = { normalizeVersion, compareVersions, parseVersionFile, readLocalVersion, VERSION_FILE };
