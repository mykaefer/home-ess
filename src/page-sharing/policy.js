'use strict';

const { PAGES } = require('../auth/access');

// Eigene HTML-Seiten erhalten eigene Links; Daten- und Aktionsrouten gehören
// jeweils zur Seite. Einstellungen und ihre Nebenrouten sind ausgeschlossen.
const ROOTS = PAGES.filter(page => page.key !== 'settings').map(page => page.prefix);
const CHILDREN = [
  '/messen-schalten/energiefluss', '/messen-schalten/schaltgruppen', '/states/custom',
  '/heizung/zentrale',
];
const DYNAMIC = [
  /^\/(?:heizung|heimkino)\/raum\/[1-9]\d*$/,
  /^\/adapter\/instance\/[1-9]\d*(?:\/(?:manage|devices|states|presets|tasmota-devices))?$/,
  /^\/adapter\/instance\/[1-9]\d*\/presets\/[^/]+$/,
];

function isPage(path) {
  return typeof path === 'string' && !/[?%#\\\s]/.test(path)
    && (ROOTS.includes(path) || CHILDREN.includes(path) || DYNAMIC.some(re => re.test(path)));
}

function childRoot(path) {
  const dynamic = path.match(/^\/(?:heizung|heimkino)\/raum\/[1-9]\d*|^\/adapter\/instance\/[1-9]\d*(?:\/(?:manage|devices|states|presets|tasmota-devices))?/);
  return [...CHILDREN, ...(dynamic ? [dynamic[0]] : [])]
    .sort((a, b) => b.length - a.length)
    .find(root => path === root || path.startsWith(`${root}/`));
}

function allows(share, path, method) {
  const read = method === 'GET' || method === 'HEAD';
  if (!read && share.mode !== 'write') return false;
  if (path === '/me/access') return read;
  // Der Topic-Picker gehört zum Bearbeiten einer Seite. Lesen gibt keinen
  // zusätzlichen Zugriff auf den systemweiten State-Katalog.
  if (['/states/catalog', '/states/catalog.json', '/states/tree.json', '/states/properties'].includes(path)
      && share.path !== '/states') return read && share.mode === 'write';
  if (path === share.path) return true;
  if (path.startsWith(`${share.path}/`)) {
    const child = childRoot(path);
    if (child && child !== share.path && child.startsWith(`${share.path}/`)) {
      // Bedienelemente der Heizungsübersicht bedienen einen Raum, dessen
      // eigene HTML-/Konfigurationsseite dadurch nicht freigegeben wird.
      return !read && ((share.path === '/heizung' && /^\/heizung\/raum\/\d+\/(?:soll|klima\/[^/]+)$/.test(path))
        || (share.path === '/adapter' && !path.includes('/manage') && !isPage(path)));
    }
    return !isPage(path);
  }
  const room = share.path.match(/^\/heimkino\/raum\/(\d+)$/);
  if (room && path === `/heimkino/rooms/${room[1]}/state`) return !read;
  if (share.path === '/messen-schalten/energiefluss' && /^\/messen-schalten\/groups\/\d+\/color$/.test(path)) return !read;
  return false;
}

module.exports = { isPage, allows };
