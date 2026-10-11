'use strict';

const access = require('../auth/access');
const store = require('./store');
const { isPage, allows } = require('./policy');
const { shareTheme, withTheme } = require('./urls');

// Derselbe Router und dieselben Views bedienen Freigaben. Der öffentliche
// Pfad wird vor der normalen Autorisierung auf die vorhandene Route abgebildet.
function sharingMiddleware(db) {
  return async (req, res, next) => {
    if (!req.path.startsWith('/share/')) {
      if (req.access) return access.runWithAccess({ ...req.access, pagePath: req.path }, next);
      return next();
    }
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
    const match = req.url.match(/^\/share\/([a-f0-9]{64})(\/[^?]*)?(\?.*)?$/);
    if (!match) return res.status(404).send('Freigabe nicht gefunden.');
    try {
      const saved = await store.forToken(db, match[1]);
      if (!saved || !isPage(saved.path)) return res.status(404).send('Freigabe nicht gefunden.');
      const share = { ...saved, theme: shareTheme(req.query.theme) };
      const base = `/share/${share.token}`;
      if (!match[2] && (req.method === 'GET' || req.method === 'HEAD')) {
        return res.redirect(withTheme(`${base}${share.path}${match[3] || ''}`, share.theme));
      }
      const target = match[2] || share.path;
      if (!allows(share, target, req.method)) return res.status(403).send('Keine Berechtigung für diese Aktion.');
      req.pageShare = share;
      // Auch ein angemeldeter Administrator erhält am Freigabelink nur dessen
      // Rechte; ein öffentlicher Request erzeugt niemals eine Login-Session.
      req.session = null;
      req.access = {
        ...access.accessForUser({ role: share.mode, visible_pages: null }),
        isAdmin: false, theme: share.theme, publicShare: share, pagePath: share.path,
      };
      const redirect = res.redirect.bind(res);
      res.redirect = (statusOrUrl, url) => {
        const location = typeof statusOrUrl === 'string' ? statusOrUrl : url;
        let mapped = `${base}${share.path}`;
        if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
          const pathname = location.split('?')[0];
          if (allows(share, pathname, 'GET')) mapped = `${base}${location}`;
          else if (req.method === 'GET' || req.method === 'HEAD') return res.status(404).send('Freigabe nicht gefunden.');
        }
        mapped = withTheme(mapped, share.theme);
        return typeof statusOrUrl === 'number' ? redirect(statusOrUrl, mapped) : redirect(mapped);
      };
      req.url = `${target}${match[3] || ''}`;
      req.originalUrl = req.url;
      access.runWithAccess(req.access, next);
    } catch (error) { next(error); }
  };
}

module.exports = { sharingMiddleware };
