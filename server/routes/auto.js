'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

// GET /api/auto/status
router.get('/auto/status', async (req, res) => {
  try { res.json({ ok: true, ...(await req.app.locals.localCmd('autostatus', {}, 10000) || {}) }); }
  catch (e) { wErr(res, e); }
});

// GET /api/auto/results
router.get('/auto/results', async (req, res) => {
  try { res.json({ ok: true, ...(await req.app.locals.localCmd('autoresults', {}, 10000) || {}) }); }
  catch (e) { wErr(res, e); }
});

// POST /api/auto/run  { test: "..." }
router.post('/auto/run', async (req, res) => {
  try { res.json({ ok: true, ...(await req.app.locals.localCmd('autorun', req.body || {}, 60000) || {}) }); }
  catch (e) { wErr(res, e); }
});

// POST /api/auto/stop
router.post('/auto/stop', async (req, res) => {
  try { res.json({ ok: true, ...(await req.app.locals.localCmd('autostop', {}, 5000) || {}) }); }
  catch (e) { wErr(res, e); }
});

module.exports = router;
