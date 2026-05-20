'use strict';

// Npcap on Windows: add to PATH so cap.node can find wpcap.dll
if (process.platform === 'win32') {
  const npcapDir = 'C:\\Windows\\System32\\Npcap';
  if (!process.env.PATH.includes(npcapDir)) {
    process.env.PATH = npcapDir + ';' + process.env.PATH;
  }
}

// Prevent unhandled errors from killing the process
process.on('uncaughtException',   (err) => console.error('[FATAL uncaughtException]', err));
process.on('unhandledRejection',  (reason) => console.error('[FATAL unhandledRejection]', reason));

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const workerHub      = require('./services/workerHub');
const serialBridge   = require('./services/serialBridge');
const switchProtocol = require('./services/switchProtocol');
const packetBackend  = require('./services/packetBackend');
const nativeWorker   = require('./services/nativeWorker');
const autoEngine     = require('./services/autoEngine');

const app  = express();
const PORT = Number(process.env.PORT || 8080);
const LOCAL_WORKER = process.env.LOCAL_WORKER_ID || 'local';

app.use(cors());
app.use(express.json({ limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── storage dirs ─────────────────────────────────────────────────────────────
const logsDir    = path.join(__dirname, 'logs');
const testsDir   = path.join(logsDir, 'tests');
const macrosDir  = path.join(logsDir, 'macros');
const reportsDir = path.join(__dirname, 'reports');
[logsDir, testsDir, macrosDir, reportsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.locals.workerHub      = workerHub;
app.locals.localWorkerId  = LOCAL_WORKER;
app.locals.testsDir       = testsDir;
app.locals.macrosDir      = macrosDir;
app.locals.reportsDir     = reportsDir;
app.locals.serialBridge   = serialBridge;
app.locals.switchProtocol = switchProtocol;
app.locals.packetBackend  = packetBackend;
app.locals.autoEngine     = autoEngine;

// Initialize autoEngine with services and storage dir
autoEngine.init({ packetBackend, serialBridge, switchProtocol }, testsDir);

// Helper: send command to local worker, falls back to nativeWorker when C# is not connected
async function localCmd(command, payload = {}, timeoutMs = 15000) {
  if (workerHub.hasWorker(LOCAL_WORKER)) {
    try {
      const reply = await workerHub.sendCommand(LOCAL_WORKER, command, payload, timeoutMs);
      if (!reply.ok) throw Object.assign(new Error(reply.error || 'Worker error'), { workerError: true });
      return reply.data;
    } catch (e) {
      if (e.workerError) throw e; // worker said error — don't fall through
    }
  }
  // Native fallback (Linux / headless / C# disconnected)
  return nativeWorker.dispatch(command, payload, { packetBackend, serialBridge, switchProtocol });
}
app.locals.localCmd = localCmd;

// Broadcast to all browser WebSocket clients
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
workerHub.attach(wss);

app.locals.broadcast = (msg) => {
  const raw = JSON.stringify(msg);
  wss.clients.forEach(ws => { try { ws.send(raw); } catch {} });
};

// Relay worker events (capture, serial, tabchange, …) to browser WebSocket clients
workerHub.events.on(`event:${LOCAL_WORKER}`, (payload) => {
  app.locals.broadcast({ type: 'workerEvent', payload });
});

// Relay native serial events to browser WebSocket clients (Linux / standalone mode)
serialBridge.events.on('serial', (payload) => {
  app.locals.broadcast({ type: 'workerEvent', payload });
});

// ── built-in simple routes ────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => res.json({ ok: true, commit: '1.0.0', version: '1.0.0' }));

app.get('/api/local-addresses', (_req, res) => {
  const nics = os.networkInterfaces();
  const addrs = [];
  for (const [name, entries] of Object.entries(nics || {})) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal) addrs.push({ name, address: e.address, netmask: e.netmask });
    }
  }
  const primary = addrs.find(a => /^172\./.test(a.address))
                 || addrs.find(a => /^10\./.test(a.address))
                 || addrs.find(a => /^192\.168\./.test(a.address) && !a.name.toLowerCase().includes('virtualbox') && !a.name.toLowerCase().includes('vmware') && !a.name.toLowerCase().includes('hyper'))
                 || addrs.find(a => !/^169\.254\./.test(a.address))
                 || addrs[0];
  res.json({ ok: true, addresses: addrs, primary: primary?.address || 'localhost' });
});

app.get('/api/examples', (_req, res) => {
  res.json({
    ok: true,
    profiles: {
      udp:  { protocol: 'udp',  dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', srcPort: 12345, dstPort: 50000, count: 1, intervalMs: 0, payload: { mode: 'text', data: 'KETI' } },
      icmp: { protocol: 'icmp', dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', count: 1, intervalMs: 0, payload: { mode: 'text', data: 'KETI ping' } },
      arp:  { protocol: 'arp',  dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', count: 1, intervalMs: 0 }
    },
    items: []
  });
});

app.post('/api/simple-bidir-forward-test', async (req, res) => {
  const { nodeAUrl, nodeBUrl, nodeAPrimaryInterface, nodeBPrimaryInterface,
    nodeAMonitorInterfaces = [], nodeBMonitorInterfaces = [],
    count = 10, intervalMs = 100, udpSrcPort = 40000, udpDstPort = 50000,
    payloadMarkerPrefix = 'KETI_SIMPLE_FORWARD', captureTimeoutMs = 3000,
    direction = 'A_TO_B' } = req.body || {};

  const directions = direction === 'BOTH' ? ['A_TO_B', 'B_TO_A'] : [direction];
  const results = [];

  for (const dir of directions) {
    const senderUrl   = dir === 'A_TO_B' ? nodeAUrl   : nodeBUrl;
    const receiverUrl = dir === 'A_TO_B' ? nodeBUrl   : nodeAUrl;
    const senderIface = dir === 'A_TO_B' ? nodeAPrimaryInterface : nodeBPrimaryInterface;
    const recvIface   = dir === 'A_TO_B' ? nodeBPrimaryInterface : nodeAPrimaryInterface;
    const monitorUrls = dir === 'A_TO_B'
      ? nodeAMonitorInterfaces.map(i => ({ url: nodeAUrl, iface: i })).concat(nodeBMonitorInterfaces.map(i => ({ url: nodeBUrl, iface: i })))
      : nodeBMonitorInterfaces.map(i => ({ url: nodeBUrl, iface: i })).concat(nodeAMonitorInterfaces.map(i => ({ url: nodeAUrl, iface: i })));

    try {
      const hdr = { 'Content-Type': 'application/json' };
      const to  = (ms) => ({ signal: AbortSignal.timeout(ms) });

      // Start capture on receiver
      await fetch(`${receiverUrl}/api/capture/clear`, { method: 'POST', headers: hdr, body: '{}', ...to(8000) }).catch(() => {});
      await fetch(`${receiverUrl}/api/capture/start`, { method: 'POST', headers: hdr, body: JSON.stringify({ interfaces: [recvIface] }), ...to(15000) }).catch(() => {});

      // Send packets from sender
      const marker = `${payloadMarkerPrefix}_${dir}_${Date.now()}`;
      const sendBody = { interface: senderIface, protocol: 'udp', dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '169.254.1.1', dstIp: '169.254.1.2', srcPort: udpSrcPort, dstPort: udpDstPort, count, intervalMs, payload: { mode: 'text', data: marker } };
      await fetch(`${senderUrl}/api/send`, { method: 'POST', headers: hdr, body: JSON.stringify(sendBody), ...to(30000) }).catch(() => {});

      // Wait for capture
      await new Promise(r => setTimeout(r, Math.min(captureTimeoutMs, 10000)));

      // Stop and collect capture
      await fetch(`${receiverUrl}/api/capture/stop`, { method: 'POST', headers: hdr, body: '{}', ...to(8000) }).catch(() => {});
      const capResp = await fetch(`${receiverUrl}/api/capture/packets?limit=1000`, { ...to(10000) }).catch(() => null);
      const capData = capResp ? await capResp.json().catch(() => ({})) : {};
      const rows = capData.rows ?? [];
      const matched = rows.filter(r => r.decoded && JSON.stringify(r.decoded).includes(marker));

      results.push({ direction: dir, result: matched.length >= count ? 'PASS' : 'FAIL', senderUrl, receiverUrl, sent: count, matched: matched.length });
    } catch (e) {
      results.push({ direction: dir, result: 'FAIL', error: e.message, senderUrl, receiverUrl });
    }
  }

  const overall = results.every(r => r.result === 'PASS') ? 'PASS' : 'FAIL';
  res.json({
    ok: true,
    directions: results,
    report: {
      overall, generatedAt: new Date().toISOString(),
      directions: results.map(r => ({
        direction: r.direction, result: r.result,
        senderUrl: r.senderUrl, receiverUrl: r.receiverUrl,
        sent: r.sent, matched: r.matched, error: r.error
      }))
    }
  });
});

// ── worker (EthernetPacketGenerator) health check ────────────────────────────
app.get('/api/csharp/health', (req, res) => {
  const { workerHub, localWorkerId } = req.app.locals;
  const connected = workerHub.hasWorker(localWorkerId);
  res.json({ ok: connected, connected, note: 'EthernetPacketGenerator WebSocket worker' });
});

// ── routes ───────────────────────────────────────────────────────────────────
app.use('/api/remote-capture', require('./routes/remoteCapture'));
app.use('/api', require('./routes/health'));
app.use('/api', require('./routes/packet'));
app.use('/api', require('./routes/capture'));
app.use('/api', require('./routes/tty'));
app.use('/api', require('./routes/testcases'));
app.use('/api', require('./routes/packetFlow'));
app.use('/api', require('./routes/macro'));
app.use('/api', require('./routes/logs'));
app.use('/api', require('./routes/workers')(workerHub));
app.use('/api', require('./routes/tests'));
// ── proxy routes → EthernetPacketGenerator.exe (--local-api, port 18080) ─────
app.use('/api', require('./routes/scenario'));
app.use('/api', require('./routes/register'));
app.use('/api', require('./routes/fdb'));
app.use('/api', require('./routes/mdio'));
app.use('/api', require('./routes/counter'));
app.use('/api', require('./routes/timestamp'));
app.use('/api', require('./routes/auto'));

// ── reports static ───────────────────────────────────────────────────────────
app.use('/reports', express.static(reportsDir));

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

server.listen(PORT, '0.0.0.0', () => {
  const nics = os.networkInterfaces();
  const wifiIp = (Object.values(nics).flat().find(e => e?.family === 'IPv4' && !e.internal && /^172\./.test(e.address))
               || Object.values(nics).flat().find(e => e?.family === 'IPv4' && !e.internal && /^10\./.test(e.address))
               || Object.values(nics).flat().find(e => e?.family === 'IPv4' && !e.internal && /^192\.168\./.test(e.address)))?.address;
  console.log(`[PacketLabManager] Local   : http://localhost:${PORT}`);
  if (wifiIp) console.log(`[PacketLabManager] Network : http://${wifiIp}:${PORT}`);
  console.log(`[PacketLabManager] Worker  : ws://localhost:${PORT}/ws/worker?workerId=${LOCAL_WORKER}`);
  console.log(`[PacketLabManager] Reports : ${reportsDir}`);
  console.log(`[PacketLabManager] Serial  : ${serialBridge.isAvailable()
    ? (process.platform === 'linux' ? 'Linux TTY ready (stty fallback + serialport if installed)' : 'serialport npm ready')
    : 'no serial support (install: npm install serialport)'}`);
  const capStatus = packetBackend.isAvailable()
    ? 'cap npm ready (send+capture)'
    : packetBackend.isTcpdumpAvailable()
      ? 'no cap npm — tcpdump fallback active (capture only)'
      : 'no cap npm, no tcpdump — packet features unavailable';
  console.log(`[PacketLabManager] Packets : ${capStatus}`);
});
