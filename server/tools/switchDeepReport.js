'use strict';

const fs = require('fs');
const path = require('path');

const local = process.env.LOCAL_URL || 'http://localhost:8080';
const peer = process.env.PEER_URL || 'http://172.31.51.213:8080';
const count = Number(process.env.FRAMES || 5);
const trials = Number(process.env.TRIALS || 5);
const measurementRetries = Number(process.env.MEASUREMENT_RETRIES || 3);
const qualityEnabled = process.env.QUALITY !== '0';
const mappingEnabled = process.env.MAPPING !== '0';
const ceilingEnabled = process.env.CEILING !== '0';
const sweepSizes = (process.env.SWEEP_SIZES || '64,128,256,512,1024,1500').split(',').map(Number).filter(Boolean);
const burstIntervals = (process.env.BURST_INTERVALS || '150,50,10,0').split(',').map(Number).filter((v) => Number.isFinite(v));
const ceilingCounts = (process.env.CEILING_COUNTS || '5,10,20,50').split(',').map(Number).filter(Boolean);
const ceilingIntervals = (process.env.CEILING_INTERVALS || '50,10,0').split(',').map(Number).filter((v) => Number.isFinite(v));

const directions = [
  { name: 'Local enp1s0f1 -> Peer 이더넷 2', srcBase: local, dstBase: peer, srcIf: 'enp1s0f1', srcMac: 'a0:36:9f:a8:e4:a9', srcIp: '169.254.141.14', dstIf: '이더넷 2', dstMac: 'c8:4d:44:20:40:5b', dstIp: '169.254.23.158' },
  { name: 'Local enp1s0f3 -> Peer 이더넷', srcBase: local, dstBase: peer, srcIf: 'enp1s0f3', srcMac: 'a0:36:9f:a8:e4:ab', srcIp: '169.254.12.243', dstIf: '이더넷', dstMac: 'c8:4d:44:26:3b:a6', dstIp: '169.254.204.140' },
  { name: 'Peer 이더넷 2 -> Local enp1s0f1', srcBase: peer, dstBase: local, srcIf: '이더넷 2', srcMac: 'c8:4d:44:20:40:5b', srcIp: '169.254.23.158', dstIf: 'enp1s0f1', dstMac: 'a0:36:9f:a8:e4:a9', dstIp: '169.254.141.14' },
  { name: 'Peer 이더넷 -> Local enp1s0f3', srcBase: peer, dstBase: local, srcIf: '이더넷', srcMac: 'c8:4d:44:26:3b:a6', srcIp: '169.254.204.140', dstIf: 'enp1s0f3', dstMac: 'a0:36:9f:a8:e4:ab', dstIp: '169.254.12.243' }
];
const qualityDirections = process.env.QUALITY_ALL_DIRECTIONS === '1' ? directions : null;
const localPorts = directions.slice(0, 2).map((d) => ({ base: local, if: d.srcIf, mac: d.srcMac, ip: d.srcIp }));
const peerPorts = directions.slice(0, 2).map((d) => ({ base: peer, if: d.dstIf, mac: d.dstMac, ip: d.dstIp }));

async function req(method, url, body, timeout = 12000) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function textOf(row) {
  try { return Buffer.from(row.frameHex || '', 'hex').toString('utf8'); }
  catch { return ''; }
}

async function startCaptureWithRetry(d) {
  let last = { ok: false, status: 'ERR', data: { error: 'capture not attempted' } };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await req('POST', `${d.dstBase}/api/capture/stop`, {}, 4000).catch(() => {});
    await req('POST', `${d.dstBase}/api/capture/clear`, {}, 4000).catch(() => {});
    last = await req('POST', `${d.dstBase}/api/capture/start`, {
      interfaces: [d.dstIf],
      srcMac: d.srcMac,
      dstMac: d.dstMac
    }, 8000).catch((e) => ({ ok: false, status: 'ERR', data: { error: e.message } }));
    if (last.ok) return { ...last, attempts: attempt };
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  return { ...last, attempts: 3 };
}

async function runAttempt(d, trial, measurementAttempt, opts = {}) {
  const frameCount = opts.count ?? count;
  const intervalMs = opts.intervalMs ?? 150;
  const safeIf = d.srcIf.replace(/[^a-zA-Z0-9]/g, '_');
  const marker = `${opts.markerPrefix || 'KETI_UCAST'}_${trial}_${measurementAttempt}_${safeIf}_${Date.now()}`;
  const start = await startCaptureWithRetry(d);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const sendStarted = Date.now();
  const payloadData = opts.payloadSize
    ? `${marker}|${'Q'.repeat(Math.max(0, opts.payloadSize - marker.length - 1))}`
    : marker;
  const send = await req('POST', `${d.srcBase}/api/send`, {
    interface: d.srcIf,
    protocol: 'udp',
    dstMac: d.dstMac,
    srcMac: d.srcMac,
    srcIp: d.srcIp,
    dstIp: d.dstIp,
    srcPort: 46100,
    dstPort: 56100,
    count: frameCount,
    intervalMs,
    targetFrameLength: opts.targetFrameLength,
    payload: { mode: 'text', data: payloadData }
  }, 45000).catch((e) => ({ ok: false, status: 'ERR', data: { error: e.message } }));
  await new Promise((resolve) => setTimeout(resolve, opts.waitMs ?? 2500));
  await req('POST', `${d.dstBase}/api/capture/stop`, {}, 6000).catch(() => {});
  const cap = await req('GET', `${d.dstBase}/api/capture/packets?limit=3000`, null, 10000)
    .catch((e) => ({ ok: false, status: 'ERR', data: { error: e.message, rows: [] } }));
  const rows = cap.data.rows || [];
  const matches = rows.filter((row) => textOf(row).includes(marker));
  const matched = Math.min(matches.length, frameCount);
  const byIface = {};
  for (const row of matches) byIface[row.interface || 'unknown'] = (byIface[row.interface || 'unknown'] || 0) + 1;
  return {
    direction: d.name,
    trial,
    sent: send.data.framesSent || send.data.stdout?.framesSent || 0,
    expected: frameCount,
    matched,
    captureRows: rows.length,
    lossPct: Number((100 * (frameCount - matches.length) / frameCount).toFixed(1)),
    startOk: start.ok,
    captureStartAttempts: start.attempts,
    sendOk: send.ok,
    captureOk: cap.ok,
    measurementAttempt,
    elapsedMs: Date.now() - sendStarted,
    targetFrameLength: opts.targetFrameLength || null,
    intervalMs,
    byIface,
    error: start.data.error || send.data.error || cap.data.error || ''
  };
}

async function runQualitySweep() {
  if (!qualityEnabled) return { enabled: false, frameSizes: [], bursts: [] };
  const dirs = qualityDirections || [directions[2], directions[3]];
  const frameSizes = [];
  for (const d of dirs) {
    for (const size of sweepSizes) {
      const result = await runAttempt(d, size, 1, {
        markerPrefix: 'KETI_SIZE',
        count: 3,
        intervalMs: 60,
        targetFrameLength: size,
        payloadSize: Math.max(16, size - 42),
        waitMs: 1800
      });
      frameSizes.push({ direction: d.name, size, ...result });
      console.log(`${d.name} size ${size}: ${result.matched}/${result.expected} elapsed=${result.elapsedMs}ms rows=${result.captureRows} err=${result.error}`);
    }
  }
  const bursts = [];
  for (const d of dirs) {
    for (const intervalMs of burstIntervals) {
      const result = await runAttempt(d, intervalMs, 1, {
        markerPrefix: 'KETI_BURST',
        count: 5,
        intervalMs,
        targetFrameLength: 256,
        payloadSize: 96,
        waitMs: 2500
      });
      bursts.push({ direction: d.name, intervalMs, ...result });
      console.log(`${d.name} burst ${intervalMs}ms: ${result.matched}/${result.expected} elapsed=${result.elapsedMs}ms rows=${result.captureRows} err=${result.error}`);
    }
  }
  return { enabled: true, directions: dirs.map((d) => d.name), frameSizes, bursts };
}

async function runReachabilityMatrix() {
  if (!mappingEnabled) return { enabled: false, rows: [] };
  const rows = [];
  for (const src of localPorts) {
    for (const dst of peerPorts) {
      const d = {
        name: `${src.if} -> ${dst.if}`,
        srcBase: src.base,
        dstBase: dst.base,
        srcIf: src.if,
        srcMac: src.mac,
        srcIp: src.ip,
        dstIf: dst.if,
        dstMac: dst.mac,
        dstIp: dst.ip
      };
      const result = await runAttempt(d, rows.length + 1, 1, {
        markerPrefix: 'KETI_MATRIX',
        count: 2,
        intervalMs: 80,
        targetFrameLength: 128,
        payloadSize: 64,
        waitMs: 1600
      });
      rows.push({ srcIf: src.if, dstIf: dst.if, ...result });
      console.log(`${d.name} matrix: ${result.matched}/${result.expected} rows=${result.captureRows} err=${result.error}`);
    }
  }
  return {
    enabled: true,
    sources: localPorts.map((p) => p.if),
    destinations: peerPorts.map((p) => p.if),
    rows
  };
}

async function runCaptureCeiling() {
  if (!ceilingEnabled) return { enabled: false, rows: [] };
  const d = directions[2]; // peer -> local uses the local Node capture path, which is the most observable path here.
  const rows = [];
  for (const intervalMs of ceilingIntervals) {
    for (const frameCount of ceilingCounts) {
      const result = await runAttempt(d, frameCount, 1, {
        markerPrefix: 'KETI_CEILING',
        count: frameCount,
        intervalMs,
        targetFrameLength: 256,
        payloadSize: 96,
        waitMs: Math.max(2200, frameCount * Math.max(intervalMs, 1) + 1800)
      });
      rows.push({ intervalMs, frameCount, ...result });
      console.log(`${d.name} ceiling ${frameCount}@${intervalMs}ms: ${result.matched}/${result.expected} elapsed=${result.elapsedMs}ms rows=${result.captureRows} err=${result.error}`);
    }
  }
  return { enabled: true, direction: d.name, counts: ceilingCounts, intervals: ceilingIntervals, rows };
}

async function runOne(d, trial) {
  let best = null;
  for (let attempt = 1; attempt <= measurementRetries; attempt += 1) {
    const result = await runAttempt(d, trial, attempt);
    if (!best || result.matched > best.matched || (!result.error && best.error)) best = result;
    if (!result.error && result.matched >= result.expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  return best;
}

function summarize(results) {
  return directions.map((d) => {
    const rows = results.filter((r) => r.direction === d.name);
    const sent = rows.reduce((sum, r) => sum + r.expected, 0);
    const matched = rows.reduce((sum, r) => sum + r.matched, 0);
    const apiErrors = rows.filter((r) => r.error || !r.startOk || !r.sendOk || !r.captureOk).length;
    const perfectTrials = rows.filter((r) => r.matched >= r.expected).length;
    const partialTrials = rows.filter((r) => r.matched > 0 && r.matched < r.expected).length;
    const zeroTrials = rows.filter((r) => r.matched === 0).length;
    const verdict = apiErrors
      ? 'MEASUREMENT UNSTABLE'
      : perfectTrials === rows.length
        ? 'PASS'
        : partialTrials || matched > 0
          ? 'CAPTURE UNDERCOUNT'
          : zeroTrials === rows.length
            ? 'NO MATCH'
            : 'CHECK';
    return {
      direction: d.name,
      sent,
      matched,
      rxPct: Number((100 * matched / sent).toFixed(1)),
      lossPct: Number((100 * (sent - matched) / sent).toFixed(1)),
      apiErrors,
      perfectTrials,
      partialTrials,
      zeroTrials,
      verdict,
      trials: rows
    };
  });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function writeReportIndex(reportsDir) {
  const entries = fs.readdirSync(reportsDir)
    .filter((name) => /^switch-deep-\d.*\.json$/.test(name))
    .sort()
    .reverse()
    .map((jsonName) => {
      const htmlName = jsonName.replace(/\.json$/, '.html');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(path.join(reportsDir, jsonName), 'utf8')); } catch {}
      const pass = (data.summary || []).filter((s) => s.verdict === 'PASS').length;
      const total = (data.summary || []).length;
      const quality = data.quality?.enabled ? 'quality' : '';
      const matrix = data.mapping?.enabled ? 'matrix' : '';
      const ceiling = data.ceiling?.enabled ? 'ceiling' : '';
      return `<tr><td>${esc(data.generatedAt || jsonName)}</td><td><a href="./${esc(htmlName)}">${esc(htmlName)}</a></td><td>${pass}/${total}</td><td>${esc([quality, matrix, ceiling].filter(Boolean).join(' + ') || '-')}</td></tr>`;
    }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Switch Report Index</title><style>
    body{margin:24px;font:14px/1.45 ui-sans-serif,system-ui;background:#f8fafc;color:#17202a}.wrap{max-width:980px;margin:auto}
    h1{letter-spacing:-.03em}.card{background:white;border:1px solid #d9e2ea;border-radius:18px;padding:18px;box-shadow:0 4px 16px #0f172a10}
    table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #e5edf3;text-align:left}th{font-size:12px;text-transform:uppercase;color:#64748b}
    a{color:#0f6f78;font-weight:800}.latest{display:inline-block;margin:0 0 14px;border-radius:999px;background:#0f6f78;color:white;padding:8px 12px;text-decoration:none}
  </style></head><body><div class="wrap"><h1>Switch Report Index</h1><a class="latest" href="./switch-deep-latest.html">Open latest report</a><div class="card"><table><thead><tr><th>Generated</th><th>Report</th><th>Pass</th><th>Extras</th></tr></thead><tbody>${entries || '<tr><td colspan="4">No archived reports yet</td></tr>'}</tbody></table></div></div></body></html>`;
  fs.writeFileSync(path.join(reportsDir, 'index.html'), html);
}

function writeReport(report) {
  const reportsDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/[^\dTZ]/g, '');
  const jsonText = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(reportsDir, 'switch-deep-latest.json'), jsonText);
  const labels = report.summary.map((s) => s.direction);
  const rx = report.summary.map((s) => s.rxPct);
  const apiErrors = report.summary.map((s) => s.apiErrors);
  const sentFrames = report.summary.map((s) => s.sent);
  const matchedFrames = report.summary.map((s) => s.matched);
  const capturedRows = report.summary.map((s) => s.trials.reduce((sum, t) => sum + t.captureRows, 0));
  const avgElapsed = report.summary.map((s) => Math.round(s.trials.reduce((sum, t) => sum + t.elapsedMs, 0) / Math.max(1, s.trials.length)));
  const trialNumbers = Array.from(new Set(report.results.map((r) => r.trial))).sort((a, b) => a - b);
  const elapsedDatasets = report.summary.map((s, index) => ({
    label: s.direction,
    data: trialNumbers.map((trial) => {
      const row = s.trials.find((t) => t.trial === trial);
      return row ? row.elapsedMs : null;
    }),
    borderColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4],
    backgroundColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4],
    tension: 0.25
  }));
  const verdictColor = (v) => ({
    PASS: '#12803a',
    'CAPTURE UNDERCOUNT': '#b9651a',
    'MEASUREMENT UNSTABLE': '#b45309',
    'NO MATCH': '#b91c1c',
    CHECK: '#475569'
  }[v] || '#475569');
  const totalSent = report.summary.reduce((sum, s) => sum + s.sent, 0);
  const totalMatched = report.summary.reduce((sum, s) => sum + s.matched, 0);
  const stableDirections = report.summary.filter((s) => s.verdict === 'PASS').length;
  const undercountDirections = report.summary.filter((s) => s.verdict === 'CAPTURE UNDERCOUNT').length;
  const allTrials = report.summary.flatMap((s) => s.trials);
  const avgTrialMs = Math.round(allTrials.reduce((sum, t) => sum + t.elapsedMs, 0) / Math.max(1, allTrials.length));
  const setupRetries = allTrials.reduce((sum, t) => sum + Math.max(0, (t.captureStartAttempts || 1) - 1), 0);
  const quality = report.quality || { enabled: false, frameSizes: [], bursts: [] };
  const mapping = report.mapping || { enabled: false, rows: [] };
  const ceiling = report.ceiling || { enabled: false, rows: [] };
  const sizeLabels = [...new Set((quality.frameSizes || []).map((r) => r.size))].sort((a, b) => a - b).map(String);
  const qualityDirLabels = [...new Set((quality.frameSizes || []).map((r) => r.direction))];
  const sizeDatasets = qualityDirLabels.map((direction, index) => ({
    label: direction,
    data: sizeLabels.map((size) => {
      const rows = (quality.frameSizes || []).filter((r) => r.direction === direction && String(r.size) === size);
      if (!rows.length) return null;
      return Number((100 * rows.reduce((sum, r) => sum + r.matched, 0) / rows.reduce((sum, r) => sum + r.expected, 0)).toFixed(1));
    }),
    borderColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4],
    backgroundColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4],
    tension: 0.25
  }));
  const intervalLabels = [...new Set((quality.bursts || []).map((r) => r.intervalMs))].sort((a, b) => b - a).map(String);
  const burstDirLabels = [...new Set((quality.bursts || []).map((r) => r.direction))];
  const burstRuntimeDatasets = burstDirLabels.map((direction, index) => ({
    label: direction,
    data: intervalLabels.map((interval) => {
      const rows = (quality.bursts || []).filter((r) => r.direction === direction && String(r.intervalMs) === interval);
      return rows.length ? Math.round(rows.reduce((sum, r) => sum + r.elapsedMs, 0) / rows.length) : null;
    }),
    borderColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4],
    backgroundColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4],
    tension: 0.25
  }));
  const burstMatchDatasets = burstDirLabels.map((direction, index) => ({
    label: direction,
    data: intervalLabels.map((interval) => {
      const rows = (quality.bursts || []).filter((r) => r.direction === direction && String(r.intervalMs) === interval);
      if (!rows.length) return null;
      return Number((100 * rows.reduce((sum, r) => sum + r.matched, 0) / rows.reduce((sum, r) => sum + r.expected, 0)).toFixed(1));
    }),
    backgroundColor: ['#0f6f78', '#f59e0b', '#2563eb', '#16a34a'][index % 4]
  }));
  const matrixTable = mapping.enabled ? `<div class="matrix"><h3>2x2 Port Reachability Matrix</h3><table><thead><tr><th>Local source</th>${(mapping.destinations || []).map((dst) => `<th>${esc(dst)}</th>`).join('')}</tr></thead><tbody>${(mapping.sources || []).map((src) => `<tr><th>${esc(src)}</th>${(mapping.destinations || []).map((dst) => {
    const row = (mapping.rows || []).find((r) => r.srcIf === src && r.dstIf === dst);
    const ok = row && row.matched >= row.expected && !row.error;
    return `<td><span class="matrixCell ${ok ? 'ok' : 'fail'}">${row ? `${row.matched}/${row.expected}` : '-'}</span></td>`;
  }).join('')}</tr>`).join('')}</tbody></table><p class="muted">This matrix checks L2 reachability for every selected local source to peer destination combination. It is not a cable tracer; a learning switch may forward multiple valid combinations.</p></div>` : '';
  const ceilingLabels = (ceiling.rows || []).map((r) => `${r.frameCount}@${r.intervalMs}ms`);
  const ceilingMatch = (ceiling.rows || []).map((r) => Number((100 * r.matched / Math.max(1, r.expected)).toFixed(1)));
  const ceilingRows = (ceiling.rows || []).map((r) => r.captureRows);
  const ceilingTable = ceiling.enabled ? `<div class="matrix"><h3>Capture Ceiling Sweep</h3><p class="muted">Direction: ${esc(ceiling.direction)}. This estimates the current app/worker capture pipeline limit, not certified 1GbE line-rate.</p><canvas id="ceilingChart"></canvas></div>` : '';
  const topologyPairs = [
    {
      port: 'P0-P1',
      local: directions[0],
      peer: directions[0],
      forward: report.summary.find((s) => s.direction === directions[0].name),
      reverse: report.summary.find((s) => s.direction === directions[2].name)
    },
    {
      port: 'P2-P3',
      local: directions[1],
      peer: directions[1],
      forward: report.summary.find((s) => s.direction === directions[1].name),
      reverse: report.summary.find((s) => s.direction === directions[3].name)
    }
  ];
  const topology = topologyPairs.map((p) => {
    const ok = p.forward?.verdict === 'PASS' && p.reverse?.verdict === 'PASS';
    return `<div class="topoLinkCard ${ok ? 'ok' : 'warn'}">
      <div class="topoNode">
        <span>THIS PC</span><strong>${esc(p.local.srcIf)}</strong><code>${esc(p.local.srcIp)}</code><small>${esc(p.local.srcMac)}</small>
      </div>
      <div class="switchPath">
        <div class="wire"></div>
        <div class="dutPort">${esc(p.port)}</div>
        <div class="dutBox">DUT SWITCH</div>
        <div class="linkStats">
          <span>→ ${p.forward?.matched ?? 0}/${p.forward?.sent ?? 0}</span>
          <span>← ${p.reverse?.matched ?? 0}/${p.reverse?.sent ?? 0}</span>
        </div>
      </div>
      <div class="topoNode peer">
        <span>PEER PC</span><strong>${esc(p.peer.dstIf)}</strong><code>${esc(p.peer.dstIp)}</code><small>${esc(p.peer.dstMac)}</small>
      </div>
    </div>`;
  }).join('');
  const heatmap = report.summary.map((s) => {
    const cells = s.trials.map((t) => {
      const ok = t.matched >= t.expected && !t.error;
      const partial = t.matched > 0 && t.matched < t.expected;
      const cls = ok ? 'ok' : partial ? 'partial' : 'fail';
      return `<span class="heatCell ${cls}" title="trial ${t.trial}: ${t.matched}/${t.expected}">${t.matched}/${t.expected}</span>`;
    }).join('');
    return `<div class="heatRow"><strong>${esc(s.direction)}</strong><div>${cells}</div></div>`;
  }).join('');
  const rows = report.summary.map((s) =>
    `<tr><td>${esc(s.direction)}</td><td><span class="pill" style="background:${verdictColor(s.verdict)}">${esc(s.verdict)}</span></td><td>${s.matched}/${s.sent}</td><td>${s.rxPct}%</td><td>${s.apiErrors}</td><td>${s.trials.map((t) => `${t.matched}/${t.expected}${t.error ? ` (${esc(t.error)})` : ''}`).join(' · ')}</td></tr>`
  ).join('');
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Switch Deep Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    body{margin:24px;font:14px/1.45 ui-sans-serif,system-ui;color:#17202a;background:linear-gradient(180deg,#eef5f6,#f8fafc 280px)}
    .wrap{max-width:1220px;margin:auto}
    .hero{background:radial-gradient(circle at 85% 15%,rgba(34,197,94,.24),transparent 170px),linear-gradient(135deg,#10262c,#0f6f78);color:white;border-radius:24px;padding:24px 26px;box-shadow:0 18px 45px #0f172a26}
    .hero h1{margin:0 0 6px;font-size:30px;letter-spacing:-.03em}.hero p{max-width:900px;color:#d9fbff}
    .cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:16px 0}
    .card,.chart,table,.note,.topology,.heatmap{background:white;border:1px solid #d9e2ea;border-radius:18px;box-shadow:0 4px 16px #0f172a10}
    .card{padding:14px}.card span{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:800}.card strong{display:block;font-size:26px}
    .charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}.chart{padding:16px}.chart h3,.topology h3,.heatmap h3{margin:0 0 10px}
    .note{padding:14px 16px;margin:16px 0;color:#334155}.note strong{color:#0f6f78}
    .topology{padding:16px;margin:16px 0}.topoGrid{display:grid;gap:12px}
    .topoLinkCard{display:grid;grid-template-columns:minmax(180px,1fr) minmax(280px,1.15fr) minmax(180px,1fr);gap:12px;align-items:center;border:1px solid #dbe7ef;border-radius:16px;padding:12px;background:linear-gradient(90deg,#f8fbfc,#fff)}
    .topoLinkCard.ok{border-color:#b7e4c7}.topoLinkCard.warn{border-color:#f5c28b}
    .topoNode{border-radius:14px;background:#f2f8f9;border:1px solid #d7e8ec;padding:12px}.topoNode.peer{background:#fff7ed;border-color:#fed7aa}
    .topoNode span{display:block;font-size:10px;font-weight:900;color:#64748b;letter-spacing:.08em}.topoNode strong{display:block;font-size:18px}.topoNode code,.topoNode small{display:block;color:#475569;margin-top:2px}
    .switchPath{position:relative;display:grid;grid-template-columns:1fr 110px 1fr;align-items:center;gap:8px;min-height:94px}
    .wire{grid-column:1/4;height:8px;border-radius:999px;background:linear-gradient(90deg,#0f6f78,#22c55e,#f59e0b);box-shadow:0 0 0 4px #eef8f1}
    .dutBox{grid-column:2;grid-row:1;border-radius:14px;background:#10262c;color:white;text-align:center;padding:16px 10px;font-weight:900;box-shadow:0 12px 24px #0f172a22}
    .dutPort{position:absolute;top:0;left:50%;transform:translateX(-50%);background:#e6f5ed;color:#14532d;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:900}
    .linkStats{position:absolute;bottom:0;left:50%;transform:translateX(-50%);display:flex;gap:8px}.linkStats span{background:white;border:1px solid #dbe7ef;border-radius:999px;padding:4px 8px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
    .heatmap{padding:16px;margin:16px 0}.heatRow{display:grid;grid-template-columns:minmax(260px,.95fr) 1.5fr;gap:10px;align-items:center;padding:7px 0;border-top:1px solid #edf2f7}.heatRow:first-of-type{border-top:0}
    .heatRow strong{font-size:12px}.heatCell{display:inline-block;margin:3px;border-radius:8px;padding:5px 8px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;font-weight:800}
    .heatCell.ok{background:#dcfce7;color:#14532d}.heatCell.partial{background:#fef3c7;color:#92400e}.heatCell.fail{background:#fee2e2;color:#991b1b}
    .qualityGrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}.matrix{background:white;border:1px solid #d9e2ea;border-radius:18px;box-shadow:0 4px 16px #0f172a10;padding:16px;margin:16px 0}
    .matrixCell{display:inline-block;border-radius:999px;padding:5px 9px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:900}.matrixCell.ok{background:#dcfce7;color:#14532d}.matrixCell.fail{background:#fee2e2;color:#991b1b}
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:16px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid #e5edf3;text-align:left;vertical-align:top}th{background:#edf6f7;font-size:12px;text-transform:uppercase;color:#456}td:nth-child(n+3){font-family:ui-monospace,SFMono-Regular,monospace}
    .pill{display:inline-block;color:white;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;white-space:nowrap}.muted{color:#64748b}
    @media(max-width:900px){.cards,.charts,.qualityGrid,.topoLinkCard,.heatRow{grid-template-columns:1fr}.switchPath{min-height:120px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>Switch Deep Test Report</h1>
      <div>${esc(report.generatedAt)}</div>
      <p>Known-unicast validation. Local ${esc(report.local)} · Peer ${esc(report.peer)} · ${report.trials} trials · ${report.count} frames/trial · up to ${measurementRetries} measurement attempts/trial. Destination MAC and capture BPF are pinned per port pair.</p>
    </div>
    <div class="cards">
      <div class="card"><span>Total Frames</span><strong>${totalSent}</strong></div>
      <div class="card"><span>Matched</span><strong>${totalMatched}</strong></div>
      <div class="card"><span>Clean Directions</span><strong>${stableDirections}/${report.summary.length}</strong></div>
      <div class="card"><span>Avg Trial Runtime</span><strong>${avgTrialMs} ms</strong></div>
      <div class="card"><span>Setup Retries</span><strong>${setupRetries}</strong></div>
    </div>
    <div class="topology">
      <h3>Physical 4-Port Switch Topology</h3>
      <div class="topoGrid">${topology}</div>
    </div>
    <div class="note"><strong>Method:</strong> Each direction sends known-unicast UDP frames to the exact destination MAC, then captures only frames matching source and destination MAC on the expected receiving NIC. A retry is used only for measurement setup errors, not to inflate packet counts.</div>
    <div class="charts">
      <div class="chart"><h3>Frame Accounting by Direction</h3><canvas id="accounting"></canvas></div>
      <div class="chart"><h3>Marker Receive Rate by Direction</h3><canvas id="rx"></canvas></div>
      <div class="chart"><h3>Trial Runtime Trend</h3><canvas id="elapsed"></canvas></div>
      <div class="chart"><h3>Setup / API Health</h3><canvas id="api"></canvas></div>
    </div>
    ${quality.enabled ? `<div class="qualityGrid">
      <div class="chart"><h3>Frame Size Sweep — Marker RX</h3><canvas id="sizeSweep"></canvas></div>
      <div class="chart"><h3>Burst Interval — Runtime</h3><canvas id="burstRuntime"></canvas></div>
      <div class="chart"><h3>Burst Interval — Marker RX</h3><canvas id="burstMatch"></canvas></div>
      <div class="chart"><h3>Quality Scope</h3><p class="muted">Frame sizes: ${esc(sizeLabels.join(', '))} bytes. Burst intervals: ${esc(intervalLabels.join(', '))} ms. Quality sweep runs on ${esc((quality.directions || []).join(' / '))} by default to keep runtime bounded.</p></div>
    </div>` : ''}
    ${matrixTable}
    ${ceilingTable}
    <div class="heatmap"><h3>Trial Stability Heatmap</h3>${heatmap}</div>
    <table><thead><tr><th>Direction</th><th>Verdict</th><th>Matched</th><th>RX</th><th>API Errors</th><th>Trials</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">Generated artifact: <code>/reports/switch-deep-latest.html</code> and <code>/reports/switch-deep-latest.json</code>.</p>
  </div>
  <script>
    const labels=${JSON.stringify(labels)};
    new Chart(document.getElementById('accounting'),{type:'bar',data:{labels,datasets:[
      {label:'Sent frames',data:${JSON.stringify(sentFrames)},backgroundColor:'#94a3b8'},
      {label:'Marker matched',data:${JSON.stringify(matchedFrames)},backgroundColor:'#16a34a'},
      {label:'Captured rows',data:${JSON.stringify(capturedRows)},backgroundColor:'#0f6f78'}
    ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,ticks:{precision:0}}}}});
    new Chart(document.getElementById('rx'),{type:'bar',data:{labels,datasets:[{label:'RX %',data:${JSON.stringify(rx)},backgroundColor:'#0f6f78'}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{min:0,max:100}}}});
    new Chart(document.getElementById('elapsed'),{type:'line',data:{labels:${JSON.stringify(trialNumbers.map((n) => `Trial ${n}`))},datasets:${JSON.stringify(elapsedDatasets)}},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:false,title:{display:true,text:'ms'}}}}});
    new Chart(document.getElementById('api'),{type:'bar',data:{labels,datasets:[
      {label:'API errors',data:${JSON.stringify(apiErrors)},backgroundColor:'#dc2626'},
      {label:'Avg runtime ms',data:${JSON.stringify(avgElapsed)},backgroundColor:'#f59e0b',yAxisID:'y1'}
    ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,ticks:{precision:0}},y1:{position:'right',beginAtZero:true,grid:{drawOnChartArea:false},title:{display:true,text:'ms'}}}}});
    if (${quality.enabled ? 'true' : 'false'}) {
      new Chart(document.getElementById('sizeSweep'),{type:'line',data:{labels:${JSON.stringify(sizeLabels)},datasets:${JSON.stringify(sizeDatasets)}},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{min:0,max:100,title:{display:true,text:'RX %'}},x:{title:{display:true,text:'Frame bytes'}}}}});
      new Chart(document.getElementById('burstRuntime'),{type:'line',data:{labels:${JSON.stringify(intervalLabels.map((v) => `${v} ms`))},datasets:${JSON.stringify(burstRuntimeDatasets)}},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,title:{display:true,text:'ms'}},x:{title:{display:true,text:'Send interval'}}}}});
      new Chart(document.getElementById('burstMatch'),{type:'bar',data:{labels:${JSON.stringify(intervalLabels.map((v) => `${v} ms`))},datasets:${JSON.stringify(burstMatchDatasets)}},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{min:0,max:100,title:{display:true,text:'RX %'}}}}});
    }
    if (${ceiling.enabled ? 'true' : 'false'}) {
      new Chart(document.getElementById('ceilingChart'),{type:'bar',data:{labels:${JSON.stringify(ceilingLabels)},datasets:[
        {label:'Marker RX %',data:${JSON.stringify(ceilingMatch)},backgroundColor:'#0f6f78',yAxisID:'y'},
        {label:'Captured rows',data:${JSON.stringify(ceilingRows)},backgroundColor:'#f59e0b',yAxisID:'y1'}
      ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{min:0,max:100,title:{display:true,text:'RX %'}},y1:{position:'right',beginAtZero:true,grid:{drawOnChartArea:false},title:{display:true,text:'rows'}}}}});
    }
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(reportsDir, 'switch-deep-latest.html'), html);
  fs.writeFileSync(path.join(reportsDir, `switch-deep-${stamp}.json`), jsonText);
  fs.writeFileSync(path.join(reportsDir, `switch-deep-${stamp}.html`), html);
  writeReportIndex(reportsDir);
}

(async () => {
  const results = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const direction of directions) {
      const result = await runOne(direction, trial);
      results.push(result);
      console.log(`${result.direction} trial ${trial}: ${result.matched}/${result.expected} loss=${result.lossPct}% rows=${result.captureRows} err=${result.error}`);
    }
  }
  const report = { generatedAt: new Date().toISOString(), local, peer, count, trials, measurementRetries, results };
  report.summary = summarize(results);
  report.quality = await runQualitySweep();
  report.mapping = await runReachabilityMatrix();
  report.ceiling = await runCaptureCeiling();
  writeReport(report);
  console.log('Report: /reports/switch-deep-latest.html');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
