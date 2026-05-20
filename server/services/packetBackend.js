'use strict';
/**
 * packetBackend.js — Native packet send/capture.
 * Primary:  cap npm (libpcap) — full send + capture
 * Fallback: tcpdump subprocess — capture only, no compilation/Python needed
 *
 * Linux install:
 *   Full:    sudo apt install libpcap-dev build-essential && npm install cap
 *   Minimal: sudo apt install tcpdump  (capture only, no Python needed)
 */

const os             = require('os');
const { spawn }      = require('child_process');
const { buildFrame } = require('./frameBuilder');

let Cap;
try { Cap = require('cap').Cap; } catch {}

// ── Device resolution ──────────────────────────────────────────────────────────

function getDeviceList() {
  if (!Cap) return [];
  try { return Cap.deviceList() || []; } catch { return []; }
}

/** Reverse-resolve pcap device name → human-readable OS NIC name. */
function resolveDeviceName(pcapName) {
  if (!Cap || !pcapName) return pcapName;
  const nics = os.networkInterfaces();
  const devs = getDeviceList();
  const dev  = devs.find(d => d.name === pcapName);
  if (!dev) return pcapName;
  // Match via shared IP address
  for (const [nicName, entries] of Object.entries(nics || {})) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && (dev.addresses || []).some(a => a.addr === e.address)) {
        return nicName;
      }
    }
  }
  // Fall back to pcap description (e.g. "Intel(R) Wi-Fi 6E...")
  return dev.description || pcapName;
}

/** Resolve OS NIC name (e.g. "Wi-Fi", "eth0") to pcap device name. */
function resolveDevice(ifaceName) {
  if (!Cap) return null;
  if (!ifaceName) {
    const devs = getDeviceList();
    return devs.length ? devs[0].name : null;
  }

  const nics  = os.networkInterfaces();
  const devs  = getDeviceList();

  // Direct name match (Linux: eth0, wlan0)
  const direct = devs.find(d => d.name === ifaceName);
  if (direct) return direct.name;

  // Match by OS NIC IPv4 address
  const nicIps = new Set();
  for (const [name, entries] of Object.entries(nics || {})) {
    if (name.toLowerCase() === ifaceName.toLowerCase()) {
      for (const e of entries || []) if (e.family === 'IPv4') nicIps.add(e.address);
    }
  }
  for (const d of devs) {
    for (const a of d.addresses || []) {
      if (nicIps.has(a.addr)) return d.name;
    }
  }

  // Partial name / description match
  const lower = ifaceName.toLowerCase();
  const partial = devs.find(d =>
    d.name.toLowerCase().includes(lower) ||
    (d.description || '').toLowerCase().includes(lower));
  return partial?.name ?? null;
}

// ── Active captures ────────────────────────────────────────────────────────────

const activeCaptures = new Map(); // iface → { cap, buffer }

// ── tcpdump fallback capture (no cap, no Python needed) ───────────────────────

const activeTcpdump = new Map(); // iface → child_process
let lastCaptureError = '';        // last stderr from tcpdump

function startCaptureTcpdump(ifaceNames, filter, onPacket, onError) {
  const ifaces = ifaceNames.length ? ifaceNames : ['any'];
  let started  = 0;
  lastCaptureError = '';

  for (const iface of ifaces) {
    if (activeTcpdump.has(iface)) continue;

    const args = ['-i', iface, '-w', '-', '-U', '--immediate-mode'];
    if (filter) args.push(filter);

    let proc;
    try { proc = spawn('tcpdump', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { continue; }

    let pcapBuf    = Buffer.alloc(0);
    let hdrDone    = false;
    let littleEnd  = true;

    proc.stdout.on('data', (chunk) => {
      pcapBuf = Buffer.concat([pcapBuf, chunk]);

      // Parse global pcap header (24 bytes)
      if (!hdrDone) {
        if (pcapBuf.length < 24) return;
        const magic = pcapBuf.readUInt32LE(0);
        if (magic === 0xa1b2c3d4)      { littleEnd = true;  }
        else if (magic === 0xd4c3b2a1) { littleEnd = false; }
        else { proc.kill(); return; }
        pcapBuf = pcapBuf.slice(24);
        hdrDone = true;
      }

      // Parse packet records
      const r32 = (o) => littleEnd ? pcapBuf.readUInt32LE(o) : pcapBuf.readUInt32BE(o);
      while (pcapBuf.length >= 16) {
        const tsSec  = r32(0);
        const tsUsec = r32(4);
        const incl   = r32(8);
        const origLen = r32(12); // read before slicing
        if (pcapBuf.length < 16 + incl) break;
        const frame = Buffer.from(pcapBuf.slice(16, 16 + incl));
        pcapBuf     = pcapBuf.slice(16 + incl);

        const no      = ++captureSeq;
        const ts      = tsSec + tsUsec / 1e6;
        const decoded = decodeFrame(frame);
        const record  = { no, timestamp: ts, interface: iface, length: origLen, frameHex: frame.toString('hex'), decoded };
        captureRows.push(record);
        try { onPacket(iface, frame, record); } catch {}
        for (const cb of captureStreamCbs) { try { cb(record); } catch {} }
      }
    });

    // Capture stderr: normal startup line ("listening on …") is not an error
    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (!msg) return;
      lastCaptureError = msg;
      if (!/listening on /i.test(msg)) {
        try { onError && onError(new Error(msg)); } catch {}
      }
    });

    proc.on('error', (err) => {
      lastCaptureError = err.message;
      try { onError && onError(err); } catch {};
    });
    proc.on('close', () => { activeTcpdump.delete(iface); });

    activeTcpdump.set(iface, proc);
    started++;
  }
  return started > 0;
}

function getLastCaptureError() { return lastCaptureError; }

function stopCaptureTcpdump() {
  for (const [, proc] of activeTcpdump) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  activeTcpdump.clear();
}

function hasTcpdump() {
  try { const { spawnSync } = require('child_process'); return spawnSync('tcpdump', ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

// ── Unified startCapture ───────────────────────────────────────────────────────

function startCapture(ifaceNames, filter, onPacket, onError) {
  if (Cap) {
    // Primary: cap npm
    const ifaces = ifaceNames.length ? ifaceNames : [null];
    let started  = 0;

    for (const name of ifaces) {
      const dev = resolveDevice(name);
      if (!dev) continue;
      if (activeCaptures.has(dev)) continue;

      try {
        const c      = new Cap();
        const buf    = Buffer.alloc(65535);
        c.open(dev, filter || '', 10 * 1024 * 1024, buf);
        c.setMinBytes && c.setMinBytes(0);

        c.on('packet', (nbytes) => {
          const now = Date.now();
          if (now - _lastCapture < CAPTURE_RATE_MS) { _capDropped++; return; }
          _lastCapture = now;
          setImmediate(() => {
            try {
              const frame   = Buffer.from(buf.slice(0, nbytes));
              const no      = ++captureSeq;
              const decoded = decodeFrame(frame);
              const ifName  = resolveDeviceName(dev);
              const record  = { no, timestamp: now / 1000, interface: ifName, length: nbytes, frameHex: frame.toString('hex'), decoded };
              if (captureRows.length >= MAX_CAPTURE_ROWS) captureRows.shift();
              captureRows.push(record);
              onPacket(ifName, frame, record);
              for (const cb of captureStreamCbs) { try { cb(record); } catch {} }
            } catch {}
          });
        });
        c.on('error', (err) => { try { onError && onError(err); } catch {} });

        activeCaptures.set(dev, { cap: c, buffer: buf });
        started++;
      } catch (e) { /* device not available */ }
    }
    return started > 0;
  }

  // Fallback: tcpdump subprocess (no Python, no native compilation)
  return startCaptureTcpdump(ifaceNames, filter, onPacket, onError);
}

function stopCapture() {
  for (const [, { cap }] of activeCaptures) {
    try { cap.close(); } catch {}
  }
  activeCaptures.clear();
  stopCaptureTcpdump();
}

function isCapturing() { return activeCaptures.size > 0 || activeTcpdump.size > 0; }

function getCaptureDeviceNames() {
  return [...Array.from(activeCaptures.keys()), ...Array.from(activeTcpdump.keys())];
}

// ── Send ───────────────────────────────────────────────────────────────────────

async function sendPackets(profile) {
  if (!Cap) throw new Error('cap npm not installed (run: npm install cap)');

  const dev = resolveDevice(profile.interface);
  if (!dev) throw new Error(`Interface not found: ${profile.interface}`);

  const count      = profile.count      ?? 1;
  const intervalMs = profile.intervalMs ?? 0;

  // Auto-fill srcMac if missing (look up from OS NIC)
  if (!profile.srcMac) {
    const nics = os.networkInterfaces();
    const iface = (profile.interface || '').toLowerCase();
    for (const [name, entries] of Object.entries(nics || {})) {
      if (name.toLowerCase() === iface) {
        const e4 = (entries || []).find(e => e.family === 'IPv4');
        if (e4 && e4.mac && e4.mac !== '00:00:00:00:00:00') {
          profile = { ...profile, srcMac: e4.mac };
          break;
        }
      }
    }
  }

  const c   = new Cap();
  const buf = Buffer.alloc(65535);
  try {
    c.open(dev, '', 0, buf);
    let sent  = 0;
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      const frame = buildFrame(profile, i);
      c.send(frame, frame.length);
      sent++;
      bytes += frame.length;
      if (intervalMs > 0 && i < count - 1)
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return { framesSent: sent, bytesSent: bytes };
  } finally {
    try { c.close(); } catch {}
  }
}

function isAvailable()       { return !!Cap; }
function isTcpdumpAvailable() { return hasTcpdump(); }

// Send a raw hex frame (used by nativeWorker sendhex command)
async function sendRaw(ifaceName, hex, count = 1) {
  if (!Cap) throw new Error('cap npm not installed — packet send requires: sudo apt install libpcap-dev build-essential && npm install cap');
  const dev = resolveDevice(ifaceName);
  if (!dev) throw new Error(`Interface not found: ${ifaceName}`);
  const frame = Buffer.from((hex || '').replace(/[\s:]/g, ''), 'hex');
  const c   = new Cap();
  const buf = Buffer.alloc(65535);
  c.open(dev, '', 0, buf);
  let sent = 0;
  try {
    for (let i = 0; i < count; i++) { c.send(frame, frame.length); sent++; }
  } finally { try { c.close(); } catch {} }
  return { framesSent: sent, bytesSent: sent * frame.length };
}

// ── Frame decoder ──────────────────────────────────────────────────────────────

function macStr(buf, off) {
  return Array.from(buf.slice(off, off + 6)).map(b => b.toString(16).padStart(2, '0')).join(':');
}

function decodeFrame(buf) {
  const result = { length: buf.length };
  if (buf.length < 14) return result;

  const dstMac    = macStr(buf, 0);
  const srcMac    = macStr(buf, 6);
  let   etherType = buf.readUInt16BE(12);
  let   offset    = 14;

  result.ethernet = { dstMac, srcMac, etherType: '0x' + etherType.toString(16).padStart(4, '0') };

  if (etherType === 0x8100 && buf.length >= 18) {
    const tci = buf.readUInt16BE(14);
    result.ethernet.vlan = { priority: (tci >> 13) & 7, dei: !!(tci & 0x1000), id: tci & 0xFFF };
    etherType = buf.readUInt16BE(16);
    result.ethernet.etherType = '0x' + etherType.toString(16).padStart(4, '0');
    offset = 18;
  }

  if (etherType === 0x0800 && buf.length >= offset + 20) {
    const ihl   = (buf[offset] & 0x0F) * 4;
    const proto = buf[offset + 9];
    const src   = Array.from(buf.slice(offset + 12, offset + 16)).join('.');
    const dst   = Array.from(buf.slice(offset + 16, offset + 20)).join('.');
    result.ipv4 = { src, dst, ttl: buf[offset + 8], protocol: proto, totalLength: buf.readUInt16BE(offset + 2) };

    const l4 = offset + ihl;
    if (proto === 17 && buf.length >= l4 + 8) {
      result.udp = { srcPort: buf.readUInt16BE(l4), dstPort: buf.readUInt16BE(l4 + 2), length: buf.readUInt16BE(l4 + 4) };
      if (buf.length > l4 + 8) {
        const p = buf.slice(l4 + 8);
        result.payload = { hex: p.toString('hex'), text: p.toString('utf8').replace(/[^\x20-\x7E]/g, '.') };
      }
    } else if (proto === 6 && buf.length >= l4 + 20) {
      result.tcp = { srcPort: buf.readUInt16BE(l4), dstPort: buf.readUInt16BE(l4 + 2), flags: buf[l4 + 13] };
    } else if (proto === 1 && buf.length >= l4 + 4) {
      result.icmp = { type: buf[l4], code: buf[l4 + 1] };
    }
  } else if (etherType === 0x0806 && buf.length >= offset + 28) {
    result.arp = {
      op:        buf.readUInt16BE(offset + 6) === 1 ? 'request' : 'reply',
      senderMac: macStr(buf, offset + 8),
      senderIp:  Array.from(buf.slice(offset + 14, offset + 18)).join('.'),
      targetMac: macStr(buf, offset + 18),
      targetIp:  Array.from(buf.slice(offset + 24, offset + 28)).join('.'),
    };
  }
  return result;
}

// ── Capture buffer ─────────────────────────────────────────────────────────────

const MAX_CAPTURE_ROWS = 5000;
const CAPTURE_RATE_MS  = 10;   // min ms between processed packets (100 pkt/s max)

let captureSeq       = 0;
let captureRows      = [];
let captureStreamCbs = [];
let _lastCapture     = 0;
let _capDropped      = 0;

function clearCapture() { captureSeq = 0; captureRows = []; _capDropped = 0; }

function getCaptures(limit = 1000, offset = 0) {
  const slice = captureRows.slice(offset, offset + limit);
  return { rows: slice, total: captureRows.length };
}

function getCaptureStatus(ifaceNames) {
  return {
    capturing:          activeCaptures.size > 0,
    captureCount:       captureRows.length,
    captureInterfaces:  ifaceNames ?? getCaptureDeviceNames(),
  };
}

// ── Interface list ─────────────────────────────────────────────────────────────

function listInterfaces() {
  const nics   = os.networkInterfaces();
  const devs   = getDeviceList();
  const result = [];

  for (const [name, entries] of Object.entries(nics || {})) {
    const ipv4 = (entries || [])
      .filter(e => e.family === 'IPv4')
      .map(e => ({ local: e.address, prefixlen: prefixFromMask(e.netmask) }));

    const mac = (entries || []).find(e => e.mac && e.mac !== '00:00:00:00:00:00')?.mac ?? '';
    const state = ipv4.length > 0 ? 'up' : 'down';

    result.push({ name, key: name, mac, state, mtu: 1500, ipv4, description: name });
  }
  return result;
}

function prefixFromMask(mask) {
  if (!mask) return 0;
  return mask.split('.').reduce((a, b) => a + (parseInt(b, 10) >>> 0).toString(2).split('1').length - 1, 0);
}

function addStreamCallback(cb)    { captureStreamCbs.push(cb); }
function removeStreamCallback(cb) { captureStreamCbs = captureStreamCbs.filter(x => x !== cb); }

module.exports = {
  sendPackets, sendRaw, startCapture, stopCapture, isCapturing,
  getCaptureDeviceNames, clearCapture, getCaptures, getCaptureStatus,
  addStreamCallback, removeStreamCallback,
  listInterfaces, resolveDevice, isAvailable, isTcpdumpAvailable, decodeFrame,
  getLastCaptureError,
};
