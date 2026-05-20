'use strict';
const { Router } = require('express');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }
function hasWorker(req) { return req.app.locals.workerHub.hasWorker(req.app.locals.localWorkerId); }
function localCmd(req, cmd, body, ms) { return req.app.locals.localCmd(cmd, body || {}, ms || 10000); }

// ── Sequence file helpers ─────────────────────────────────────────────────────
function seqFile(req)  { return path.join(req.app.locals.testsDir, 'sequence.json'); }
function seqLoad(req)  {
  const f = seqFile(req);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function seqSave(req, items) { fs.writeFileSync(seqFile(req), JSON.stringify(items, null, 2)); }

// ── Legacy /api/scenarios/* aliases (auto routes are in auto.js) ─────────────
router.post('/scenarios/run', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'autorun', req.body, 60000) || {}) });
    const test = req.body?.test;
    if (!test) return res.status(400).json({ ok: false, error: 'test required' });
    req.app.locals.autoEngine.runTest(test).catch(() => {});
    res.json({ ok: true, test, status: 'started' });
  } catch (e) { wErr(res, e); }
});
router.get('/scenarios/status', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'autostatus', {}, 5000) || {}) });
    res.json({ ok: true, ...req.app.locals.autoEngine.getStatus() });
  } catch (e) { wErr(res, e); }
});
router.get('/scenarios/results', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'autoresults', {}, 5000) || {}) });
    res.json({ ok: true, rows: req.app.locals.autoEngine.getResults() });
  } catch (e) { wErr(res, e); }
});

// ── Testcase management — file-based (same on Windows and Linux) ──────────────
function tcFile(req) { return path.join(req.app.locals.testsDir, 'test-cases.json'); }
function tcLoad(req) {
  const f = tcFile(req);
  if (!fs.existsSync(f)) return [{ id: 'default', name: 'Default Group', groups: [], cases: [] }];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function tcSave(req, data) { fs.writeFileSync(tcFile(req), JSON.stringify(data, null, 2)); }

router.get('/testcases/status', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'testcasesstatus', {}, 5000) || {}) });
    res.json({ ok: true, snapshot: tcLoad(req) });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/add-group', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'testcasesaddgroup', req.body, 5000) || {}) });
    const data = tcLoad(req);
    const grp  = { id: crypto.randomUUID(), name: req.body?.name || 'Group', cases: [] };
    data.push(grp);
    tcSave(req, data);
    res.json({ ok: true, group: grp, status: 'group-added' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/add', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'testcasesadd', req.body, 5000) || {}) });
    const data  = tcLoad(req);
    const grpIdx = req.body?.groupIndex ?? 0;
    const tc    = { id: crypto.randomUUID(), name: req.body?.name || 'Test', steps: req.body?.steps || [] };
    if (data[grpIdx]) {
      if (!data[grpIdx].cases) data[grpIdx].cases = [];
      data[grpIdx].cases.push(tc);
    }
    tcSave(req, data);
    res.json({ ok: true, testCase: tc, status: 'testcase-added' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/select', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'testcasesselect', req.body, 5000) || {}) });
    res.json({ ok: true, status: 'testcase-selected' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/save-current', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'testcasessavecurrent', req.body, 5000) || {}) });
    const { groupIndex = 0, tcIndex = 0, steps } = req.body || {};
    const data = tcLoad(req);
    const grp  = data[groupIndex];
    if (!grp) return res.status(400).json({ ok: false, error: 'group not found' });
    const cases = grp.cases || grp.testCases || [];
    if (!cases[tcIndex]) return res.status(400).json({ ok: false, error: 'test case not found' });
    cases[tcIndex] = { ...cases[tcIndex], steps: steps ?? seqLoad(req) };
    if (!grp.cases) grp.testCases = cases; else grp.cases = cases;
    tcSave(req, data);
    res.json({ ok: true, status: 'current-saved' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/delete', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'testcasesdelete', req.body, 5000) || {}) });
    const data  = tcLoad(req);
    const { groupIndex, testCaseIndex } = req.body || {};
    if (testCaseIndex !== undefined && groupIndex !== undefined) {
      const grp = data[groupIndex];
      if (grp) {
        const cases = grp.cases || grp.testCases;
        if (cases) cases.splice(testCaseIndex, 1);
      }
    } else if (groupIndex !== undefined) {
      data.splice(groupIndex, 1);
    }
    tcSave(req, data);
    res.json({ ok: true, status: 'deleted' });
  } catch (e) { wErr(res, e); }
});

// ── App / Sequence status ─────────────────────────────────────────────────────
router.get('/app/status', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'appstatus', {}, 5000) || {}) });
    res.json({ ok: true, selectedTabIndex: 0, sequenceCount: seqLoad(req).length });
  } catch (e) { wErr(res, e); }
});

router.get('/sequence/status', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'sequencestatus', {}, 5000) || {}) });
    const items = seqLoad(req).map((ev, i) => ({
      index:       i,
      kind:        'Event',
      name:        ev.name || ev.eventType || 'event',
      protocol:    ev.protocol || '',
      description: ev.label || ev.description || '',
      isChecked:   true,
    }));
    res.json({ ok: true, items });
  } catch (e) { wErr(res, e); }
});

router.get('/sequence/full', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'sequencegetfull', {}, 5000) || {}) });
    const items = seqLoad(req).map((ev, i) => ({ index: i, ...ev }));
    res.json({ ok: true, items });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/run', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'sequencerun', {}, 10000) || {}) });
    const items = seqLoad(req);
    if (!items.length) return res.json({ ok: false, error: 'Sequence is empty' });
    // Run sequence as an autoEngine test
    const syntheticTc = [{ id: '__sequence__', name: '__sequence__', steps: items }];
    const file = path.join(req.app.locals.testsDir, 'test-cases.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const existing = saved.findIndex(t => t.id === '__sequence__');
    if (existing >= 0) saved[existing] = syntheticTc[0]; else saved.push(syntheticTc[0]);
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    req.app.locals.autoEngine.runTest('__sequence__').catch(() => {});
    res.json({ ok: true, status: 'started' });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/event/add', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'sequenceaddevent', req.body, 5000) || {}) });
    const items = seqLoad(req);
    items.push(req.body || {});
    seqSave(req, items);
    res.json({ ok: true, status: 'event-added', index: items.length - 1 });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/event/remove', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'sequenceremoveevent', req.body, 5000) || {}) });
    const items = seqLoad(req);
    const idx   = req.body?.index ?? -1;
    if (idx >= 0 && idx < items.length) items.splice(idx, 1);
    seqSave(req, items);
    res.json({ ok: true, status: 'event-removed' });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/events/clear', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'sequenceclearevents', {}, 5000) || {}) });
    seqSave(req, []);
    res.json({ ok: true, status: 'events-cleared' });
  } catch (e) { wErr(res, e); }
});

// ── Sequence bulk import ──────────────────────────────────────────────────────
router.post('/sequence/import', async (req, res) => {
  try {
    const incoming = req.body?.items || req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ ok: false, error: 'items array expected' });
    seqSave(req, incoming);
    res.json({ ok: true, count: incoming.length });
  } catch (e) { wErr(res, e); }
});

// ── Test-case bulk import ─────────────────────────────────────────────────────
router.post('/testcases/import', async (req, res) => {
  try {
    const incoming = req.body?.groups || req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ ok: false, error: 'groups array expected' });
    const cur = tcLoad(req);
    incoming.forEach(g => {
      if (!g || !g.name) return;
      const i = cur.findIndex(x => x.name === g.name);
      if (i >= 0) cur[i] = { ...cur[i], ...g }; else cur.push(g);
    });
    fs.writeFileSync(tcFile(req), JSON.stringify(cur, null, 2));
    res.json({ ok: true, count: incoming.length });
  } catch (e) { wErr(res, e); }
});

// ── Ports link status — uses MDIO via register (works native too) ─────────────
router.get('/ports/link-status', async (req, res) => {
  try {
    if (hasWorker(req)) return res.json({ ok: true, ...(await localCmd(req, 'portslinkstatus', {}, 15000) || {}) });
    // Delegate to mdio/link-status endpoint logic directly
    const { localCmd: lc } = req.app.locals;
    // Call the mdio route indirectly via localCmd which uses nativeWorker
    return res.redirect(307, '/api/mdio/link-status');
  } catch (e) { wErr(res, e); }
});

module.exports = router;
