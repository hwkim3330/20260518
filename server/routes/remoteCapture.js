'use strict';
const { Router } = require('express');
const router = Router();

// Node.js 18+ has global fetch built-in.
// For older Node.js, fall back gracefully.
const nodeFetch = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function proxyErr(res, err, code = 502) {
  res.status(code).json({ ok: false, error: err.message });
}

function validatePeerUrl(peerUrl) {
  if (!peerUrl || typeof peerUrl !== 'string') throw new Error('peerUrl is required');
  const base = peerUrl.replace(/\/$/, '');
  // Basic sanity — must start with http:// or https://
  if (!/^https?:\/\//i.test(base)) throw new Error('peerUrl must start with http:// or https://');
  return base;
}

// ── POST /api/remote-capture/probe ───────────────────────────────────────────
// body: { peerUrl }
// → GET {peerUrl}/api/interfaces
router.post('/probe', async (req, res) => {
  try {
    const base = validatePeerUrl(req.body?.peerUrl);
    const resp = await nodeFetch(`${base}/api/interfaces`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!resp.ok) throw new Error(`Peer returned HTTP ${resp.status}`);
    const data = await resp.json();

    const interfaces = (data.interfaces ?? []).map(i => ({
      key:         i.key || i.name || i.deviceName || '',
      name:        i.name || i.deviceName || i.key || '',
      mac:         i.mac || '',
      state:       i.state || 'unknown',
      ipv4:        i.ipv4 || [],
      description: i.description || ''
    }));

    res.json({ ok: true, peerUrl: base, interfaces });
  } catch (err) { proxyErr(res, err); }
});

// ── POST /api/remote-capture/start ───────────────────────────────────────────
// body: { peerUrl, interfaces: [key, ...] }
router.post('/start', async (req, res) => {
  try {
    const base = validatePeerUrl(req.body?.peerUrl);
    const interfaces = req.body?.interfaces ?? [];

    // Clear first, then start
    await nodeFetch(`${base}/api/capture/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000)
    }).catch(() => {});

    const resp = await nodeFetch(`${base}/api/capture/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interfaces }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`Peer returned HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ ok: true, peerUrl: base, ...(data || {}) });
  } catch (err) { proxyErr(res, err); }
});

// ── POST /api/remote-capture/stop ────────────────────────────────────────────
// body: { peerUrl }
router.post('/stop', async (req, res) => {
  try {
    const base = validatePeerUrl(req.body?.peerUrl);
    const resp = await nodeFetch(`${base}/api/capture/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000)
    });
    if (!resp.ok) throw new Error(`Peer returned HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ ok: true, peerUrl: base, ...(data || {}) });
  } catch (err) { proxyErr(res, err); }
});

// ── POST /api/remote-capture/clear ───────────────────────────────────────────
// body: { peerUrl }
router.post('/clear', async (req, res) => {
  try {
    const base = validatePeerUrl(req.body?.peerUrl);
    const resp = await nodeFetch(`${base}/api/capture/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000)
    });
    if (!resp.ok) throw new Error(`Peer returned HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ ok: true, peerUrl: base, ...(data || {}) });
  } catch (err) { proxyErr(res, err); }
});

// ── GET /api/remote-capture/packets?peerUrl=...&limit=500&offset=0 ───────────
router.get('/packets', async (req, res) => {
  try {
    const base   = validatePeerUrl(req.query.peerUrl);
    const limit  = Number(req.query.limit  ?? 500);
    const offset = Number(req.query.offset ?? 0);

    // Pass offset/limit directly to peer; peer slices on its side
    const resp = await nodeFetch(
      `${base}/api/capture/packets?limit=${limit}&offset=${offset}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) throw new Error(`Peer returned HTTP ${resp.status}`);
    const data = await resp.json();

    const rows = data.rows ?? data.packets ?? [];
    res.json({ ok: true, rows, total: data.total ?? rows.length });
  } catch (err) { proxyErr(res, err); }
});

module.exports = router;
