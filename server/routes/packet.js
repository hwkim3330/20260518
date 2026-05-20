'use strict';
const { Router } = require('express');
const router = Router();

function workerErr(res, err) {
  res.status(err.workerError ? 502 : 503).json({ ok: false, error: err.message });
}

function hasWorker(req) {
  const { workerHub, localWorkerId } = req.app.locals;
  return workerHub.hasWorker(localWorkerId);
}

// GET /api/interfaces
router.get('/interfaces', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const data = await req.app.locals.localCmd('getinterfaces');
      const interfaces = (data?.interfaces ?? []).map(i => ({
        name: i.name, mac: i.mac, state: i.state, mtu: i.mtu ?? 1500,
        ipv4: (i.ipv4 ?? []).map(a => typeof a === 'string' ? { local: a, prefixlen: 24 } : a),
        description: i.description ?? i.name,
      }));
      return res.json({ ok: true, interfaces, stdout: { interfaces } });
    }
    const interfaces = req.app.locals.packetBackend.listInterfaces();
    res.json({ ok: true, interfaces, stdout: { interfaces } });
  } catch (err) { workerErr(res, err); }
});

// POST /api/build
router.post('/build', async (req, res) => {
  try {
    if (hasWorker(req)) {
      try {
        const data = await req.app.locals.localCmd('build', req.body || {});
        return res.json({ ok: true, ...(data || {}), stdout: data || {} });
      } catch (e) {
        if (!e.workerError || !/unsupported protocol/i.test(e.message)) throw e;
      }
    }
    // Linux or unsupported protocol: build frame locally and return hex
    const { buildFrame, normalizeProfile } = require('../services/frameBuilder');
    const frame = buildFrame(normalizeProfile(req.body || {}));
    const data  = { frameHex: frame.toString('hex'), frameLength: frame.length };
    res.json({ ok: true, ...data, stdout: data });
  } catch (err) { workerErr(res, err); }
});

// POST /api/send
router.post('/send', async (req, res) => {
  try {
    if (hasWorker(req)) {
      try {
        const data = await req.app.locals.localCmd('send', req.body || {}, 30000);
        return res.json({ ok: true, ...(data || {}), stdout: data || {} });
      } catch (e) {
        // C# doesn't support this protocol — fall through to native frameBuilder
        if (!e.workerError || !/unsupported protocol/i.test(e.message)) throw e;
      }
    }
    const result = await req.app.locals.packetBackend.sendPackets(req.body || {});
    res.json({ ok: true, ...result, stdout: result });
  } catch (err) { workerErr(res, err); }
});

// POST /api/packet/send (alias)
router.post('/packet/send', async (req, res) => {
  try {
    if (hasWorker(req)) {
      try {
        const data = await req.app.locals.localCmd('send', req.body || {}, 30000);
        return res.json({ ok: true, ...(data || {}), stdout: data || {} });
      } catch (e) {
        if (!e.workerError || !/unsupported protocol/i.test(e.message)) throw e;
      }
    }
    const result = await req.app.locals.packetBackend.sendPackets(req.body || {});
    res.json({ ok: true, ...result, stdout: result });
  } catch (err) { workerErr(res, err); }
});

// POST /api/probe-node
router.post('/probe-node', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    const base = url.replace(/\/$/, '');
    const resp = await fetch(`${base}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    const ifaces = (data.interfaces ?? []).map(i => ({
      key:  i.key || i.name || '',
      name: i.name || i.key || '',
      mac:  i.mac  || '',
      state: i.state || 'unknown',
      ipv4:  i.ipv4 || [],
      description: i.description || ''
    }));
    res.json({ ok: true, url: base, interfaces: ifaces });
  } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

// GET /api/arp-lookup?ip=...
router.get('/arp-lookup', async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.json({ ok: false, error: 'ip required' });
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const exec = promisify(execFile);
    const { stdout } = await exec('arp', ['-a', ip]);
    const match = stdout.match(/([0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2})/i);
    if (match) {
      const mac = match[1].replace(/-/g, ':').toLowerCase();
      return res.json({ ok: true, mac, ip });
    }
    res.json({ ok: false, error: 'not in ARP table', ip });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// GET /api/worker/status
router.get('/worker/status', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const data = await req.app.locals.localCmd('status');
      return res.json({ ok: true, ...(data || {}) });
    }
    const pb = req.app.locals.packetBackend;
    const st = pb.getCaptureStatus();
    res.json({ ok: true, workerId: 'local', capturing: st.capturing, captureCount: st.captureCount,
               captureInterfaces: st.captureInterfaces });
  } catch (err) { workerErr(res, err); }
});

module.exports = router;
