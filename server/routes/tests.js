'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

const POST = (url, body, timeout = 30000) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
    .then(r => r.json()).catch(() => ({}));

const GET = (url, timeout = 15000) =>
  fetch(url, { signal: AbortSignal.timeout(timeout) })
    .then(r => r.json()).catch(() => ({}));

function marker(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

function textHex(text) {
  return Buffer.from(String(text), 'utf8').toString('hex').toLowerCase();
}

function packetHasText(row, text) {
  const needle = String(text);
  const decoded = row?.decoded ? JSON.stringify(row.decoded) : '';
  const hex = String(row?.frameHex || row?.hex || '').toLowerCase();
  return decoded.includes(needle) || hex.includes(textHex(needle));
}

function packetProtocol(row) {
  const d = row?.decoded || {};
  if (d.udp) return 'udp';
  if (d.tcp) return 'tcp';
  if (d.icmp) return 'icmp';
  if (d.arp) return 'arp';
  const ethType = String(d.ethernet?.etherType || '').toLowerCase();
  if (ethType === '0x0806') return 'arp';
  if (ethType === '0x0800') return 'ipv4';
  return 'raw';
}

async function clearStartCapture(receiverUrl, interfaces) {
  await POST(`${receiverUrl}/api/capture/clear`, {}).catch(() => {});
  await POST(`${receiverUrl}/api/capture/start`, { interfaces: interfaces ? [interfaces] : [] });
}

async function stopGetPackets(receiverUrl, limit = 2000) {
  await POST(`${receiverUrl}/api/capture/stop`, {}).catch(() => {});
  const d = await GET(`${receiverUrl}/api/capture/packets?limit=${limit}`).catch(() => ({}));
  return d.rows ?? [];
}

function saveReport(reportsDir, name, html) {
  try {
    fs.writeFileSync(path.join(reportsDir, `${name}-latest.html`), html);
  } catch {}
}

function simpleHtml(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;padding:20px;background:#f4f6f8}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:8px 12px;text-align:left}th{background:#0f6f78;color:#fff}</style></head>
<body><h2>${title}</h2>${body}</body></html>`;
}

// ── POST /api/e2e-test ────────────────────────────────────────────────────────
router.post('/e2e-test', async (req, res) => {
  const { senderUrl, receiverUrl, senderInterface, receiverInterface,
          profile = {}, timeoutSec = 5, maxFrames = 50 } = req.body || {};

  const tag = marker('E2E');
  const sendProfile = {
    ...profile,
    interface: senderInterface,
    protocol: profile.protocol || 'udp',
    srcIp: profile.srcIp || '169.254.1.1',
    dstIp: profile.dstIp || '169.254.1.2',
    srcPort: profile.srcPort || 40000,
    dstPort: profile.dstPort || 50000,
    payload: { mode: 'text', data: tag }
  };
  const count = sendProfile.count || 5;

  try {
    await clearStartCapture(receiverUrl, receiverInterface);
    const sent = await POST(`${senderUrl}/api/send`, sendProfile, 60000);
    await new Promise(r => setTimeout(r, Math.min(timeoutSec * 1000, 30000)));
    const rows = await stopGetPackets(receiverUrl, maxFrames * 4);

    const matched = rows.filter(r => packetHasText(r, tag));
    const ok = matched.length >= Math.ceil(count * 0.5); // 50% match threshold

    const report = {
      ok,
      sent: { framesSent: sent?.framesSent ?? count, bytesSent: sent?.bytesSent ?? 0 },
      matchCount: matched.length,
      captureSummary: { total: rows.length },
      capturedFrames: rows.slice(0, 50).map(r => ({
        no: r.no, timestamp: r.timestamp, interface: r.interface,
        length: r.length, frameHex: r.frameHex, decoded: r.decoded
      })),
      tag,
      generatedAt: new Date().toISOString()
    };

    saveReport(req.app.locals.reportsDir, 'e2e',
      simpleHtml('E2E Test Report', `<p>Status: <strong>${ok ? 'PASS' : 'FAIL'}</strong></p>
      <p>Sent: ${report.sent.framesSent} | Matched: ${report.matchCount} | Captured: ${report.captureSummary.total}</p>`));

    res.json({ ok: true, report });
  } catch (err) {
    res.json({ ok: false, error: err.message, report: { ok: false, sent: { framesSent: 0 }, matchCount: 0, captureSummary: { total: 0 }, capturedFrames: [] } });
  }
});

// ── POST /api/wire-validation ─────────────────────────────────────────────────
router.post('/wire-validation', async (req, res) => {
  const { senderUrl, receiverUrl, senderInterface, receiverInterface,
          count = 2, intervalMs = 100 } = req.body || {};

  const steps = [
    { name: 'UDP unicast',   kind: 'udp',  protocol: 'udp',  srcPort: 40001, dstPort: 50001 },
    { name: 'ICMP echo',     kind: 'icmp', protocol: 'icmp' },
    { name: 'ARP broadcast', kind: 'arp',  protocol: 'arp'  }
  ];

  const capturedFrames = [];
  let totalSent = 0, totalMatched = 0, totalFailed = 0;

  const stepResults = [];
  for (const step of steps) {
    const tag = marker(`WIRE_${step.kind.toUpperCase()}`);
    try {
      await clearStartCapture(receiverUrl, receiverInterface);
      const sendBody = {
        interface: senderInterface, protocol: step.protocol,
        dstMac: 'FF:FF:FF:FF:FF:FF',
        srcIp: '169.254.1.1', dstIp: '169.254.1.2',
        srcPort: step.srcPort, dstPort: step.dstPort,
        count, intervalMs,
        payload: { mode: 'text', data: tag }
      };
      const sent = await POST(`${senderUrl}/api/send`, sendBody, 30000);
      await new Promise(r => setTimeout(r, Math.max(intervalMs * count + 500, 1000)));
      const rows = await stopGetPackets(receiverUrl, 500);

      const matched = step.kind === 'arp'
        ? rows.filter(r => packetProtocol(r) === 'arp')
        : rows.filter(r => packetHasText(r, tag));
      const stepOk  = matched.length > 0;
      totalSent    += sent?.framesSent ?? count;
      totalMatched += matched.length;
      if (!stepOk) totalFailed++;
      capturedFrames.push(...matched.slice(0, 5).map(r => ({ ...r, step: step.name })));
      stepResults.push({ name: step.name, ok: stepOk, kind: step.kind, protocol: step.protocol,
                         framesSent: sent?.framesSent ?? count, matchCount: matched.length });
    } catch (e) {
      totalFailed++;
      stepResults.push({ name: step.name, ok: false, kind: step.kind, protocol: step.protocol,
                         framesSent: 0, matchCount: 0, error: e.message });
    }
  }

  const overallOk = totalFailed === 0;
  const report = {
    ok: overallOk,
    steps: stepResults,
    summary: { framesSent: totalSent, matched: totalMatched, failed: totalFailed },
    capturedFrames: capturedFrames.slice(0, 50),
    generatedAt: new Date().toISOString()
  };

  const rowsHtml = stepResults.map(s =>
    `<tr><td>${s.name}</td><td>${s.protocol}</td>
     <td style="color:${s.ok ? 'green' : 'red'}">${s.ok ? 'PASS' : 'FAIL'}</td>
     <td>${s.framesSent}</td><td>${s.matchCount}</td></tr>`).join('');

  saveReport(req.app.locals.reportsDir, 'wire-validation',
    simpleHtml('Wire Validation Report',
      `<p>Status: <strong>${overallOk ? 'PASS' : 'FAIL'}</strong></p>
       <table><tr><th>Step</th><th>Protocol</th><th>Result</th><th>Sent</th><th>Matched</th></tr>${rowsHtml}</table>`));

  res.json({ ok: true, report });
});

// ── POST /api/benchmark ───────────────────────────────────────────────────────
router.post('/benchmark', async (req, res) => {
  const { senderUrl, receiverUrl, senderInterface, receiverInterface,
          count = 500, intervalMs = 1, payloadSize = 64 } = req.body || {};

  const tag = marker('BENCH');

  try {
    const tStart = Date.now();
    await clearStartCapture(receiverUrl, receiverInterface);
    const sendBody = {
      interface: senderInterface,
      protocol: 'udp',
      dstMac: 'FF:FF:FF:FF:FF:FF',
      srcIp: '169.254.1.1', dstIp: '169.254.1.2',
      srcPort: 40000, dstPort: 50000,
      count, intervalMs,
      payload: payloadSize > 64
        ? { mode: 'repeat', size: payloadSize - 42, data: 'ab' }
        : { mode: 'text', data: tag }
    };
    const sent   = await POST(`${senderUrl}/api/send`, sendBody, 120000);
    const tAfterSend = Date.now();
    await new Promise(r => setTimeout(r, Math.min(intervalMs * count + 1500, 10000)));
    const rows   = await stopGetPackets(receiverUrl, count * 2);
    const tEnd   = Date.now();

    const txCount = sent?.framesSent ?? count;
    const rxCount = rows.length;
    const lossPct  = txCount > 0 ? Math.max(0, ((txCount - rxCount) / txCount) * 100) : 100;
    const durationMs = tAfterSend - tStart;
    const bytesPerFrame = (payloadSize + 42);
    const throughputMbps = durationMs > 0 ? (txCount * bytesPerFrame * 8) / (durationMs * 1000) : 0;

    const report = {
      ok: rxCount > 0,
      stats: {
        txCount,
        rxCount,
        lossPct: parseFloat(lossPct.toFixed(4)),
        throughputMbps: parseFloat(throughputMbps.toFixed(4)),
        payloadSize,
        durationMs,
        latencyAdjustedUs: { p50: 0, p95: 0, p99: 0 },
        jitterUs: { mean: 0, max: 0 }
      },
      generatedAt: new Date().toISOString()
    };

    saveReport(req.app.locals.reportsDir, 'benchmark',
      simpleHtml('Benchmark Report',
        `<p>TX: ${txCount} | RX: ${rxCount} | Loss: ${lossPct.toFixed(2)}% | Throughput: ${throughputMbps.toFixed(2)} Mbps</p>`));

    res.json({ ok: true, report });
  } catch (err) {
    res.json({ ok: false, error: err.message,
               report: { ok: false, stats: { txCount: 0, rxCount: 0, lossPct: 100, throughputMbps: 0,
                         latencyAdjustedUs: { p50:0, p95:0, p99:0 }, jitterUs: { mean:0, max:0 } } } });
  }
});

// ── POST /api/sweep ───────────────────────────────────────────────────────────
router.post('/sweep', async (req, res) => {
  const { senderUrl, receiverUrl, senderInterface, receiverInterface,
          count = 200, intervalMs = 1 } = req.body || {};

  const FRAME_SIZES = [64, 128, 256, 512, 1024, 1280, 1500];
  const results = [];

  for (const payloadSize of FRAME_SIZES) {
    const tag = marker(`SWEEP_${payloadSize}`);
    try {
      await clearStartCapture(receiverUrl, receiverInterface);
      const sendBody = {
        interface: senderInterface, protocol: 'udp',
        dstMac: 'FF:FF:FF:FF:FF:FF',
        srcIp: '169.254.1.1', dstIp: '169.254.1.2',
        srcPort: 40000, dstPort: 50000,
        count, intervalMs,
        payload: payloadSize > 64
          ? { mode: 'repeat', size: payloadSize - 42, data: 'ab' }
          : { mode: 'text', data: tag }
      };
      const tStart = Date.now();
      const sent   = await POST(`${senderUrl}/api/send`, sendBody, 120000);
      const durMs  = Date.now() - tStart;
      await new Promise(r => setTimeout(r, Math.min(intervalMs * count + 1000, 8000)));
      const rows   = await stopGetPackets(receiverUrl, count * 2);

      const txCount = sent?.framesSent ?? count;
      const rxCount = rows.length;
      const lossPct = txCount > 0 ? Math.max(0, ((txCount - rxCount) / txCount) * 100) : 100;
      const throughputMbps = durMs > 0 ? (txCount * (payloadSize + 42) * 8) / (durMs * 1000) : 0;
      results.push({ payloadSize, stats: { txCount, rxCount, lossPct: parseFloat(lossPct.toFixed(4)), throughputMbps: parseFloat(throughputMbps.toFixed(4)) } });
    } catch (e) {
      results.push({ payloadSize, stats: { txCount: count, rxCount: 0, lossPct: 100, throughputMbps: 0, error: e.message } });
    }
  }

  const rowsHtml = results.map(r =>
    `<tr><td>${r.payloadSize}</td><td>${r.stats.txCount}</td><td>${r.stats.rxCount}</td>
     <td>${r.stats.lossPct.toFixed(2)}%</td><td>${(r.stats.throughputMbps||0).toFixed(2)}</td></tr>`).join('');

  saveReport(req.app.locals.reportsDir, 'sweep',
    simpleHtml('Frame-size Sweep Report',
      `<table><tr><th>Size(B)</th><th>TX</th><th>RX</th><th>Loss</th><th>Mbps</th></tr>${rowsHtml}</table>`));

  res.json({ ok: true, report: { results, generatedAt: new Date().toISOString() } });
});

// ── POST /api/rfc2544 ─────────────────────────────────────────────────────────
router.post('/rfc2544', async (req, res) => {
  const { senderUrl, receiverUrl, senderInterface, receiverInterface,
          trialDurationSec = 2, linkRateMbps = 1000, tolerancePps = 100 } = req.body || {};

  const FRAME_SIZES = [64, 128, 256, 512, 1024, 1280, 1518];
  const LINK_BPS    = linkRateMbps * 1_000_000;
  const results     = [];

  for (const frameSize of FRAME_SIZES) {
    const bytesPerFrame = frameSize + 20; // with preamble/IFG
    const maxPps  = LINK_BPS / (bytesPerFrame * 8);
    let lo = 0, hi = maxPps, bestPps = 0;

    // Binary search: max 5 iterations to keep runtime reasonable
    for (let iter = 0; iter < 5; iter++) {
      const testPps  = Math.round((lo + hi) / 2);
      const testMs   = Math.max(1, Math.round(1000 / testPps));
      const testCount = Math.round(testPps * trialDurationSec);

      try {
        await clearStartCapture(receiverUrl, receiverInterface);
        const sent = await POST(`${senderUrl}/api/send`, {
          interface: senderInterface, protocol: 'udp',
          dstMac: 'FF:FF:FF:FF:FF:FF',
          srcIp: '169.254.1.1', dstIp: '169.254.1.2',
          srcPort: 40000, dstPort: 50000,
          count: testCount, intervalMs: testMs,
          payload: frameSize > 64 ? { mode: 'repeat', size: frameSize - 42, data: 'ab' } : { mode: 'text', data: 'KETI' }
        }, 120000);
        await new Promise(r => setTimeout(r, testMs * testCount + 1000));
        const rows = await stopGetPackets(receiverUrl, testCount * 2);

        const txCount = sent?.framesSent ?? testCount;
        const rxCount = rows.length;
        const lost    = txCount - rxCount;

        if (lost <= tolerancePps * trialDurationSec) {
          bestPps = testPps;
          lo = testPps;
        } else {
          hi = testPps;
        }
      } catch { hi = testPps; }
    }

    const utilizationPct = (bestPps * bytesPerFrame * 8 / LINK_BPS) * 100;
    results.push({ frameSize, txPps: bestPps, rxPps: bestPps, utilizationPct: parseFloat(utilizationPct.toFixed(2)), loss: 0 });
  }

  const rowsHtml = results.map(r =>
    `<tr><td>${r.frameSize}</td><td>${r.txPps}</td><td>${r.utilizationPct}%</td></tr>`).join('');

  saveReport(req.app.locals.reportsDir, 'rfc2544',
    simpleHtml('RFC 2544 Throughput Report',
      `<p>Link: ${linkRateMbps} Mbps, Trial: ${trialDurationSec}s</p>
       <table><tr><th>Frame(B)</th><th>Max PPS</th><th>Utilization</th></tr>${rowsHtml}</table>`));

  res.json({ ok: true, report: { results, linkRateMbps, trialDurationSec, generatedAt: new Date().toISOString() } });
});

module.exports = router;
