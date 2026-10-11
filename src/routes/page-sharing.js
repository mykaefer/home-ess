'use strict';

const express = require('express');
const { canSeePage, pageForPath } = require('../auth/access');
const { isPage } = require('../page-sharing/policy');
const store = require('../page-sharing/store');
const { withTheme } = require('../page-sharing/urls');

function pageSharingRoutes(db) {
  const router = express.Router();
  router.use('/page-sharing', (req, res, next) => {
    if (!req.session || !req.access || req.pageShare) return res.status(401).json({ error: 'Nicht angemeldet.' });
    if (req.method !== 'GET' && !req.access.canWrite) return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  function validPath(req, res) {
    const path = req.method === 'GET' ? req.query.path : (req.body || {}).path;
    if (!isPage(path)) { res.status(400).json({ error: 'Diese Seite kann nicht freigegeben werden.' }); return null; }
    if (!canSeePage(req.access, pageForPath(path))) { res.status(403).json({ error: 'Diese Seite ist nicht freigeschaltet.' }); return null; }
    return path;
  }
  const payload = (row) => {
    const url = row ? `/share/${row.token}` : null;
    return {
      mode: row ? row.mode : 'none', url,
      urls: url ? { hell: withTheme(url, 'hell'), dunkel: withTheme(url, 'dunkel') } : null,
    };
  };
  router.get('/page-sharing', async (req, res, next) => {
    const path = validPath(req, res);
    if (!path) return;
    try { res.json(payload(await store.forPath(db, path))); } catch (error) { next(error); }
  });
  router.post('/page-sharing', async (req, res, next) => {
    const path = validPath(req, res);
    if (!path) return;
    if (!['none', 'read', 'write'].includes(req.body.mode)) return res.status(400).json({ error: 'Ungültige Freigabe.' });
    // Eigener Header verhindert Freigaben durch fremde HTML-Formulare.
    if (req.headers['x-homeess-request'] !== 'page-sharing') return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
    try { res.json(payload(await store.setMode(db, path, req.body.mode))); } catch (error) { next(error); }
  });
  return router;
}
module.exports = pageSharingRoutes;
