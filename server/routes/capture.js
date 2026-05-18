'use strict';
const { Router } = require('express');
const router = Router();

function workerErr(res, err) {
  res.status(err.workerError ? 502 : 503).json({ ok: false, error: err.message });
}

/**
 * Build a BPF filter string from MAC/EtherType fields.
 * If a raw bpfFilter string is already provided, it takes precedence.
 */
function buildBpfFilter({ srcMac, dstMac, etherType, bpfFilter } = {}) {
  if (bpfFilter && bpfFilter.trim()) return bpfFilter.trim();
  const parts = [];
  if (srcMac && srcMac.trim()) parts.push(`ether src ${srcMac.trim().toLowerCase()}`);
  if (dstMac && dstMac.trim()) parts.push(`ether dst ${dstMac.trim().toLowerCase()}`);
  if (etherType && etherType.trim()) parts.push(`ether proto ${etherType.trim()}`);
  return parts.join(' and ');
}

// GET /api/capture/status
router.get('/capture/status', async (req, res) => {
  try {
    const [status, ifaces] = await Promise.all([
      req.app.locals.localCmd('status'),
      req.app.locals.localCmd('getinterfaces').catch(() => ({ interfaces: [] }))
    ]);
    const interfaces = (ifaces?.interfaces ?? []).map(i => ({
      name: i.name, description: i.description, state: i.state, mac: i.mac,
      selected: status?.captureInterfaces?.includes(i.name) ?? false
    }));
    res.json({
      ok: true,
      running: status?.capturing ?? false,
      capturing: status?.capturing ?? false,
      totalPackets: status?.captureCount ?? 0,
      captureCount: status?.captureCount ?? 0,
      interfaces
    });
  } catch (err) { workerErr(res, err); }
});

// GET /api/capture/packets?limit=500&offset=0
router.get('/capture/packets', async (req, res) => {
  try {
    const limit  = Number(req.query.limit  ?? 1000);
    const offset = Number(req.query.offset ?? 0);
    const data   = await req.app.locals.localCmd('getCaptures', { limit, offset });
    // C# returns { rows: [...], total: N }  (older builds may use "packets" key)
    const rows = data?.rows ?? data?.packets ?? [];
    res.json({ ok: true, rows, total: data?.total ?? rows.length });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture/start
router.post('/capture/start', async (req, res) => {
  try {
    const body = req.body || {};
    const { srcMac = '', dstMac = '', etherType = '', bpfFilter: rawBpf = '' } = body;
    const bpfFilter = buildBpfFilter({ srcMac, dstMac, etherType, bpfFilter: rawBpf });
    const cmdPayload = { ...body, bpfFilter };
    const data = await req.app.locals.localCmd('startCapture', cmdPayload, 10000);
    res.json({ ok: true, bpfFilter, ...(data || {}) });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture/stop
router.post('/capture/stop', async (req, res) => {
  try {
    const data = await req.app.locals.localCmd('stopCapture', {});
    res.json({ ok: true, ...(data || {}) });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture/clear
router.post('/capture/clear', async (req, res) => {
  try {
    const data = await req.app.locals.localCmd('clearCapture', {});
    res.json({ ok: true, ...(data || {}) });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture  (one-shot: start, wait, stop, return packets)
router.post('/capture', async (req, res) => {
  const { interfaces = [], timeoutMs = 5000, limit = 500 } = req.body || {};
  try {
    await req.app.locals.localCmd('clearCapture', {});
    await req.app.locals.localCmd('startCapture', { interfaces }, 10000);
    await new Promise(r => setTimeout(r, Math.min(timeoutMs, 30000)));
    await req.app.locals.localCmd('stopCapture', {});
    const data = await req.app.locals.localCmd('getCaptures', { limit, offset: 0 });
    const rows = data?.rows ?? data?.packets ?? [];
    res.json({ ok: true, rows, total: data?.total ?? rows.length });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture-stream  — NDJSON streaming capture
// Each line: { type: 'frame', no, timestamp, interface, length, frameHex, decoded }
router.post('/capture-stream', async (req, res) => {
  const { workerHub, localWorkerId } = req.app.locals;
  const {
    interfaces: ifaceArr,
    interface: ifaceSingle,
    timeoutMs,
    timeoutSec,
    srcMac = '',
    dstMac = '',
    etherType = ''
  } = req.body || {};

  // Normalize: singular 'interface' → array, dedupe
  const interfaces = ifaceArr?.length ? ifaceArr
    : ifaceSingle ? [ifaceSingle]
    : [];

  // timeoutSec=0 means infinite; cap streaming at 1 hour
  let effectiveTimeout;
  if (timeoutMs !== undefined)  effectiveTimeout = timeoutMs === 0 ? 3600000 : timeoutMs;
  else if (timeoutSec !== undefined) effectiveTimeout = timeoutSec === 0 ? 3600000 : timeoutSec * 1000;
  else effectiveTimeout = 3600000;
  effectiveTimeout = Math.min(effectiveTimeout, 3600000);

  // Simple filter helpers
  const normMac = (m) => m.replace(/[:\-]/g, '').toLowerCase();
  const filterSrc = srcMac ? normMac(srcMac) : '';
  const filterDst = dstMac ? normMac(dstMac) : '';
  const filterEtype = etherType ? etherType.toLowerCase().replace('0x', '') : '';

  function passesFilter(rec) {
    if (filterSrc || filterDst || filterEtype) {
      const eth = rec.decoded?.ethernet || rec.decoded?.eth || {};
      if (filterSrc && normMac(eth.srcMac || eth.src || '') !== filterSrc) return false;
      if (filterDst && normMac(eth.dstMac || eth.dst || '') !== filterDst) return false;
      if (filterEtype) {
        const etype = (eth.etherType || '').replace('0x', '').toLowerCase();
        if (etype !== filterEtype) return false;
      }
    }
    return true;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    workerHub.events.off(`event:${localWorkerId}`, onEvent);
    try { await workerHub.sendCommand(localWorkerId, 'stopCapture', {}, 5000); } catch {}
    write({ done: true });
    res.end();
  };

  const onEvent = (payload) => {
    if (payload?.kind === 'capture' && payload.record) {
      const rec = payload.record;
      if (!passesFilter(rec)) return;
      write({ type: 'frame', ...rec });
    } else if (payload?.kind === 'captureStats') {
      write({ type: 'stats', ...payload });
    }
  };

  // Build BPF filter from MAC/EtherType fields for kernel-level filtering
  const bpfFilter = buildBpfFilter({ srcMac, dstMac, etherType });

  try {
    await workerHub.sendCommand(localWorkerId, 'clearCapture', {}, 5000);
    await workerHub.sendCommand(localWorkerId, 'startCapture', { interfaces, bpfFilter }, 10000);
    workerHub.events.on(`event:${localWorkerId}`, onEvent);
  } catch (err) {
    write({ error: err.message });
    res.end();
    return;
  }

  const timer = setTimeout(stop, effectiveTimeout);
  req.on('close', () => { clearTimeout(timer); stop(); });
});

module.exports = router;
