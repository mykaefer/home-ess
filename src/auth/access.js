'use strict';

// Zentrale Definition des Rechtemodells (Rollen, Seiten) und der
// request-gebundene Zugriffskontext.
//
// Rollen:
//   read    – alles schreibgeschützt; Bearbeiten-Dialoge und Topic-Picker
//             gesperrt. Nur Lesen.
//   operate – wie read, zusätzlich dürfen Schalter (Messen + Schalten,
//             Schaltgruppen, Dashboard-Schalter) betätigt werden.
//   write   – Vollzugriff ohne Einschränkung (wie bisher der Administrator).
//
// Der Administrator (is_admin = 1) hat immer effektiv 'write' und darf zusätzlich
// die Benutzerverwaltung nutzen; er ist von Rollen-/Seiten-Beschränkungen
// ausgenommen.

const { AsyncLocalStorage } = require('async_hooks');

const ROLES = ['read', 'operate', 'write'];
const DEFAULT_ROLE = 'read';

const ROLE_LABELS = {
  read: 'Lesen',
  operate: 'Bedienen',
  write: 'Schreiben',
};

// Farbthema je Benutzer. Es betrifft ausschliesslich die Seitenflaeche
// (Arbeitsbereich); Titelleiste und Seitenmenue behalten in jedem Thema ihre
// Farben, damit die Wiedererkennung erhalten bleibt.
//   hell      – bisherige helle Oberflaeche (Standard)
//   dunkel    – alle Seiten auf dunklem Grund
//   dashboard – nur das Dashboard dunkel, alle anderen Seiten hell
const THEMES = ['hell', 'dunkel', 'dashboard'];
const DEFAULT_THEME = 'hell';

const THEME_LABELS = {
  hell: 'Hell',
  dunkel: 'Dunkel',
  dashboard: 'Nur Dashboard dunkel',
};

// Body-Klasse, die styles.css auswertet. Leer = helles Thema.
const DARK_BODY_CLASS = 'theme-dark';

// Katalog der über das Menü erreichbaren Seiten. `key` ist der stabile
// Persistenz-Schlüssel (visible_pages), `prefix`/`prefixes` decken die Seite
// samt ihrer Unterrouten ab. Module-Seiten (pool/grid-control/wallbox) sind nur
// sichtbar, wenn das jeweilige Modul aktiv ist – die Auswahl bleibt dennoch
// erhalten. Module und Fernzugriff sind Teil der Einstellungsseite (Tabs) und
// laufen daher als zusätzliche Prefixe unter dem Schlüssel `settings`.
const PAGES = [
  { key: 'dashboard', label: 'Dashboard', prefix: '/dashboard' },
  { key: 'stromverbrauch', label: 'Stromverbrauch', prefix: '/stromverbrauch' },
  { key: 'photovoltaik', label: 'Photovoltaik', prefix: '/photovoltaik' },
  { key: 'batterie', label: 'Batterie', prefix: '/batterie' },
  { key: 'messen-schalten', label: 'Messen + Schalten', prefix: '/messen-schalten' },
  { key: 'prognose', label: 'Prognose', prefix: '/prognose' },
  { key: 'states', label: 'States', prefix: '/states' },
  { key: 'conditions', label: 'Bedingungen', prefix: '/conditions' },
  { key: 'adapter', label: 'Adapter', prefix: '/adapter' },
  { key: 'output', label: 'Output', prefix: '/output' },
  { key: 'pool', label: 'Poolsteuerung', prefix: '/pool' },
  { key: 'grid-control', label: 'Grid-Control', prefix: '/grid-control' },
  { key: 'wallbox', label: 'Wallbox', prefix: '/wallbox' },
  { key: 'heimkino', label: 'Heimkino', prefix: '/heimkino' },
  { key: 'settings', label: 'Einstellungen', prefix: '/settings', prefixes: ['/settings', '/module', '/remote-access', '/api/remote-access'] },
];

const PAGE_KEYS = PAGES.map((page) => page.key);
const PAGE_KEY_SET = new Set(PAGE_KEYS);

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return ROLES.includes(role) ? role : DEFAULT_ROLE;
}

// Farbthema normalisieren. Unbekannte oder fehlende Werte fallen auf „hell"
// zurueck, damit bestehende Installationen unveraendert aussehen.
function normalizeTheme(value) {
  const theme = String(value || '').trim().toLowerCase();
  return THEMES.includes(theme) ? theme : DEFAULT_THEME;
}

// Gilt das dunkle Thema fuer diesen Seitenpfad? Bei „dashboard" nur auf der
// Dashboard-Seite, bei „dunkel" ueberall, bei „hell" nirgends.
function isDarkForPath(theme, pathname) {
  const value = normalizeTheme(theme);
  if (value === 'dunkel') return true;
  if (value !== 'dashboard') return false;
  const path = String(pathname || '');
  return path === '/dashboard' || path.startsWith('/dashboard/');
}

// Body-Klasse fuer renderLayout: leerer String oder die Dunkel-Klasse.
function themeBodyClass(theme, pathname) {
  return isDarkForPath(theme, pathname) ? DARK_BODY_CLASS : '';
}

// Sichtbare Seiten normalisieren: null/leer bedeutet „alle Seiten sichtbar".
function normalizeVisiblePages(value) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch (_) {
      list = null;
    }
  }
  if (!Array.isArray(list)) return null;
  const wanted = new Set(list.map(String));
  const picked = PAGE_KEYS.filter((key) => wanted.has(key));
  return picked;
}

// Effektiven Zugriff aus einer User-Zeile bilden. Ohne User (nicht angemeldet)
// wird null zurückgegeben.
function accessForUser(user) {
  if (!user) return null;
  const isAdmin = user.is_admin === 1 || user.is_admin === true || user.isAdmin === true;
  const role = isAdmin ? 'write' : normalizeRole(user.role);
  const visiblePages = isAdmin ? null : normalizeVisiblePages(user.visible_pages != null ? user.visible_pages : user.visiblePages);
  return {
    userId: user.id,
    userName: user.name || 'Administrator',
    isAdmin,
    role,
    // Farbthema gilt auch fuer den Administrator – es ist eine reine
    // Darstellungseinstellung und keine Rechtefrage.
    theme: normalizeTheme(user.theme),
    // Jeder angemeldete Benutzer darf lesen; erst Bedienen und Schreiben sind
    // an die Rolle gebunden. Das Feld gehört zum dokumentierten Vertrag von
    // GET /me/access und wird auch an Adapter-Verwaltungsseiten durchgereicht.
    canRead: true,
    canWrite: role === 'write',
    canOperate: role === 'write' || role === 'operate',
    // null = alle Seiten sichtbar (Administrator oder ohne Einschränkung).
    visiblePages,
  };
}

// Voller Zugriff – Default außerhalb eines Requests (z. B. Tests, die Views
// direkt rendern) und für den Administrator.
function fullAccess() {
  return {
    userId: null,
    userName: '',
    isAdmin: true,
    role: 'write',
    theme: DEFAULT_THEME,
    canRead: true,
    canWrite: true,
    canOperate: true,
    visiblePages: null,
  };
}

function canSeePage(access, pageKey) {
  if (!access || !access.visiblePages) return true;
  return access.visiblePages.includes(pageKey);
}

// Zu welcher Seite (key) gehört ein Request-Pfad? Längster passender Prefix
// (eine Seite kann mehrere Prefixe abdecken, z. B. Einstellungen inkl. Module
// und Fernzugriff).
function pageForPath(pathname) {
  const path = String(pathname || '');
  let best = null;
  let bestLen = -1;
  for (const page of PAGES) {
    const prefixes = page.prefixes || [page.prefix];
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        if (prefix.length > bestLen) { bestLen = prefix.length; best = page; }
      }
    }
  }
  return best ? best.key : null;
}

// Request-gebundener Zugriffskontext, damit renderLayout und die Views die Rechte
// lesen können, ohne dass jede Route sie explizit durchreichen muss.
const storage = new AsyncLocalStorage();

function runWithAccess(access, fn) {
  return storage.run({ access }, fn);
}

// Aktuellen Zugriff lesen. Außerhalb eines Requests (Tests/Direktrender) sowie
// bei fehlendem Kontext: voller Zugriff, damit bestehendes Verhalten erhalten
// bleibt.
function currentAccess() {
  const store = storage.getStore();
  return store && store.access ? store.access : fullAccess();
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  DEFAULT_ROLE,
  THEMES,
  THEME_LABELS,
  DEFAULT_THEME,
  DARK_BODY_CLASS,
  normalizeTheme,
  isDarkForPath,
  themeBodyClass,
  PAGES,
  PAGE_KEYS,
  PAGE_KEY_SET,
  normalizeRole,
  normalizeVisiblePages,
  accessForUser,
  fullAccess,
  canSeePage,
  pageForPath,
  runWithAccess,
  currentAccess,
};
