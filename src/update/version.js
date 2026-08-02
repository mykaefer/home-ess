'use strict';

// homeESS-Releases verwenden ausschließlich numerische Versionen mit drei
// Stellen. Bewusst kein Semver-Paket: Vorab-Releases werden von GitHubs
// /releases/latest ohnehin ausgeschlossen und sollen hier nicht erraten werden.
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

module.exports = { normalizeVersion, compareVersions };
