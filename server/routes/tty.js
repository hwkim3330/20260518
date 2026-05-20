'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

function hasWorker(req) {
  const { workerHub, localWorkerId } = req.app.locals;
  return workerHub.hasWorker(localWorkerId);
}

// ── GET /api/tty/list ─────────────────────────────────────────────────────────
router.get('/tty/list', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const data = await req.app.locals.localCmd('serialList', {}, 5000);
      return res.json({ ok: true, ttys: data?.ttys ?? [], ports: data?.ttys ?? [] });
    }
    const { serialBridge } = req.app.locals;
    const ttys = await serialBridge.list();
    res.json({ ok: true, ttys, ports: ttys });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/tty/open ────────────────────────────────────────────────────────
router.post('/tty/open', async (req, res) => {
  try {
    const { path, port, baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none', hwFlow = false } = req.body || {};
    const portName = path || port || '';
    if (hasWorker(req)) {
      const data = await req.app.locals.localCmd('serialOpen',
        { path: portName, port: portName, baudRate, dataBits, stopBits, parity, rts: hwFlow }, 8000);
      const sessionId = data?.sessionId ?? data?.session ?? portName;
      return res.json({ ok: true, sessionId, session: sessionId, ...(data || {}) });
    }
    const { serialBridge } = req.app.locals;
    const result = await serialBridge.open(portName, { baudRate, dataBits, stopBits, parity });
    res.json({ ok: true, ...result });
  } catch (e) { wErr(res, e); }
});

// ── GET /api/tty/stream ───────────────────────────────────────────────────────
router.get('/tty/stream', (req, res) => {
  const { workerHub, localWorkerId, serialBridge } = req.app.locals;
  const session = req.query.session || '';

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  // Handler for both C# worker events and native serial events
  const onEvent = (payload) => {
    if (payload?.kind !== 'serial') return;
    if (session && payload.session && payload.session !== session) return;
    if (payload.rxType === 'rx' && payload.hex) {
      write({ type: 'rx', hex: payload.hex, session: payload.session });
    } else if (payload.type === 'error') {
      write({ type: 'error', message: payload.message });
    } else if (payload.type === 'closed') {
      write({ type: 'closed' });
    }
  };

  // Subscribe to whichever source is active
  workerHub.events.on(`event:${localWorkerId}`, onEvent);
  serialBridge.events.on('serial', onEvent);
  write({ connected: true, session });

  const keepalive = setInterval(() => { try { res.write('\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    workerHub.events.off(`event:${localWorkerId}`, onEvent);
    serialBridge.events.off('serial', onEvent);
  });
});

// ── POST /api/tty/write ───────────────────────────────────────────────────────
router.post('/tty/write', async (req, res) => {
  try {
    const { sessionId, session, hex, data: hexData, text } = req.body || {};
    const s = sessionId || session;
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialWrite', { session: s, hex: hex ?? hexData, text }, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    await req.app.locals.serialBridge.write(s, { hex: hex ?? hexData, text });
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/tty/control ─────────────────────────────────────────────────────
router.post('/tty/control', async (req, res) => {
  try {
    const { sessionId, session, ...rest } = req.body || {};
    const s = sessionId || session;
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialControl', { session: s, ...rest }, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    await req.app.locals.serialBridge.setSignals(s, rest);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/tty/close ───────────────────────────────────────────────────────
router.post('/tty/close', async (req, res) => {
  try {
    const { sessionId, session } = req.body || {};
    const s = sessionId || session;
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialClose', { session: s }, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    await req.app.locals.serialBridge.close(s);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

// ── Legacy /api/serial/* aliases ──────────────────────────────────────────────
router.get('/serial/status', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const ports = await req.app.locals.localCmd('serialList', {}, 5000);
      const info  = await req.app.locals.localCmd('serialStatus', {}, 5000).catch(() => ({}));
      return res.json({ ok: true, ttys: ports?.ttys ?? [], ports: ports?.ttys ?? [], ...(info || {}) });
    }
    const ttys = await req.app.locals.serialBridge.list();
    const st   = req.app.locals.serialBridge.getStatus();
    res.json({ ok: true, ttys, ports: ttys, ...st });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/connect', async (req, res) => {
  try {
    const { path, port, baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none' } = req.body || {};
    const portName = path || port || '';
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialOpen', req.body || {}, 8000);
      return res.json({ ok: true, sessionId: d?.sessionId ?? d?.session, ...(d || {}) });
    }
    const r = await req.app.locals.serialBridge.open(portName, { baudRate, dataBits, stopBits, parity });
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/disconnect', async (req, res) => {
  try {
    const { sessionId, session } = req.body || {};
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialClose', {}, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    await req.app.locals.serialBridge.close(sessionId || session);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/send', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialWrite', req.body || {}, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    const { sessionId, session, hex, text } = req.body || {};
    const sid = req.app.locals.serialBridge.getSession(sessionId || session);
    if (!sid) return res.status(400).json({ ok: false, error: 'Serial port not open' });
    await req.app.locals.serialBridge.write(sid, { hex, text });
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/clear', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialClear', {}, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/break', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialControl', { cmd: 'break' }, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    const { serialBridge } = req.app.locals;
    const sid = serialBridge.getSession();
    if (sid) await serialBridge.setSignals(sid, { brk: true });
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/control', async (req, res) => {
  try {
    if (hasWorker(req)) {
      const d = await req.app.locals.localCmd('serialControl', req.body || {}, 5000);
      return res.json({ ok: true, ...(d || {}) });
    }
    const { sessionId, session, ...rest } = req.body || {};
    await req.app.locals.serialBridge.setSignals(sessionId || session, rest);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
