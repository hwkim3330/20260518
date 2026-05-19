'use strict';
const { Router } = require('express');
const os = require('os');
const router = Router();

router.get('/health', (req, res) => {
  const { workerHub, localWorkerId } = req.app.locals;
  const connected = workerHub.hasWorker(localWorkerId);
  const worker    = workerHub.getWorker(localWorkerId);
  res.json({
    ok: true,
    server:      { name: 'packet-lab-manager', port: Number(process.env.PORT || 8080) },
    localWorker: { connected, id: localWorkerId, info: worker?.info || {} },
    csharpWorker: { connected, note: 'EthernetPacketGenerator WebSocket worker' },
    time: new Date().toISOString()
  });
});

router.get('/backend/status', async (req, res) => {
  const { workerHub, localWorkerId, packetBackend, serialBridge } = req.app.locals;
  const worker = workerHub.getWorker(localWorkerId);
  const workerConnected = workerHub.hasWorker(localWorkerId);

  let serialPorts = [];
  if (serialBridge?.isAvailable?.()) {
    try { serialPorts = await serialBridge.list(); } catch {}
  }

  const interfaces = packetBackend.listInterfaces();
  const nodeNative = {
    packetSend: Boolean(packetBackend.isAvailable?.()),
    packetCapture: Boolean(packetBackend.isAvailable?.() || packetBackend.isTcpdumpAvailable?.()),
    cap: Boolean(packetBackend.isAvailable?.()),
    tcpdump: Boolean(packetBackend.isTcpdumpAvailable?.()),
    serial: Boolean(serialBridge?.isAvailable?.()),
    serialOpen: Boolean(serialBridge?.getStatus?.().open),
    serialPorts: serialPorts.map((p) => p.path || p.name).filter(Boolean),
    interfaces: interfaces.map((i) => ({
      name: i.name,
      state: i.state,
      mac: i.mac,
      ipv4: i.ipv4 || []
    }))
  };

  const features = {
    send: workerConnected || nodeNative.packetSend,
    capture: workerConnected || nodeNative.packetCapture,
    serial: workerConnected || nodeNative.serial,
    register: workerConnected || nodeNative.serialOpen,
    fdb: workerConnected || nodeNative.serialOpen,
    mdio: workerConnected || nodeNative.serialOpen,
    reports: true
  };

  res.json({
    ok: true,
    mode: workerConnected ? 'csharp-worker' : 'node-native',
    platform: { type: os.type(), platform: os.platform(), arch: os.arch(), node: process.version },
    worker: { connected: workerConnected, id: localWorkerId, info: worker?.info || {} },
    nodeNative,
    features,
    notes: {
      packetSend: nodeNative.packetSend ? 'Node cap is available for raw Ethernet send.' : 'Raw Ethernet send needs cap optional dependency.',
      packetCapture: nodeNative.packetCapture ? 'Capture backend is available.' : 'Capture needs cap or tcpdump.',
      register: features.register ? 'Register/MDIO/FDB can run through active worker or open serial bridge.' : 'Open serial bridge or connect C# worker for switch registers.'
    },
    time: new Date().toISOString()
  });
});

module.exports = router;
