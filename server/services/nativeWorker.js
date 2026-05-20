'use strict';
/**
 * nativeWorker.js — Handles worker commands natively (no C# required).
 * Used by localCmd() as fallback when C# worker is disconnected.
 * This makes timestamp, mdio, counter, register, FDB all work on Linux.
 */
const os = require('os');
const { buildFrame, normalizeProfile } = require('./frameBuilder');

async function dispatch(command, payload, services) {
  const { packetBackend, serialBridge, switchProtocol } = services;
  const cmd = command.toLowerCase();

  switch (cmd) {

    // ── Interfaces ──────────────────────────────────────────────────────────────
    case 'getinterfaces':
      return { interfaces: packetBackend.listInterfaces() };

    // ── Packet build ────────────────────────────────────────────────────────────
    case 'build': {
      const profile = normalizeProfile(payload);
      const frame   = buildFrame(profile, 0);
      return { frameHex: frame.toString('hex'), frameLength: frame.length };
    }

    // ── Packet send ─────────────────────────────────────────────────────────────
    case 'send':
      return packetBackend.sendPackets(normalizeProfile(payload));

    case 'sendhex':
      return packetBackend.sendRaw(payload.interface || '', payload.hex || '', payload.count ?? 1);

    // ── Worker status ───────────────────────────────────────────────────────────
    case 'status': {
      const st = packetBackend.getCaptureStatus();
      return {
        workerId:          'native',
        capturing:         st.capturing,
        captureCount:      st.captureCount,
        captureInterfaces: st.captureInterfaces,
      };
    }

    // ── Capture ─────────────────────────────────────────────────────────────────
    case 'startcapture': {
      const ifaces = Array.isArray(payload.interfaces) ? payload.interfaces : [];
      const bpf    = payload.bpfFilter || payload.filter || '';
      packetBackend.clearCapture();
      const ok = packetBackend.startCapture(ifaces, bpf, () => {}, (e) => console.error('[cap]', e.message));
      return { capturing: ok, interfaces: packetBackend.getCaptureDeviceNames().length, bpfFilter: bpf };
    }
    case 'stopcapture':
      packetBackend.stopCapture();
      return { capturing: false };

    case 'clearcapture':
      packetBackend.clearCapture();
      return { cleared: true };

    case 'getcaptures': {
      const limit  = payload.limit  ?? 1000;
      const offset = payload.offset ?? 0;
      return packetBackend.getCaptures(limit, offset);
    }

    // ── Serial ──────────────────────────────────────────────────────────────────
    case 'seriallist': {
      if (!serialBridge.isAvailable()) return { ttys: [], ports: [] };
      const ports = await serialBridge.list();
      return { ttys: ports, ports };
    }

    case 'serialstatus': {
      if (!serialBridge.isAvailable()) return { open: false, connected: false, ttys: [], ports: [] };
      const st    = serialBridge.getStatus();
      const ports = await serialBridge.list();
      return { open: st.open, connected: st.open, session: st.session, ttys: ports, ports };
    }

    case 'serialopen': {
      if (!serialBridge.isAvailable()) throw new Error('serialport npm not installed');
      const { port, baudRate, dataBits, parity, stopBits } = payload;
      if (!port) throw new Error('port required');
      await serialBridge.open(port, { baudRate, dataBits, parity, stopBits });
      return { open: true, port, session: port };
    }

    case 'serialclose': {
      const sid = serialBridge.getSession(payload.session);
      if (sid) await serialBridge.close(sid);
      return { open: false };
    }

    case 'serialwrite': {
      const sid = serialBridge.getSession(payload.session);
      if (!sid) throw new Error('Serial port not open');
      const data = payload.hex ? { hex: payload.hex } : { text: payload.text ?? '' };
      await serialBridge.write(sid, data);
      const written = payload.hex
        ? Math.floor(payload.hex.replace(/\s/g, '').length / 2)
        : (payload.text ?? '').length;
      return { written, mode: payload.hex ? 'hex' : 'text' };
    }

    case 'serialread':
      return { hex: '', length: 0 }; // data comes via events in native mode

    case 'serialclear':
      return { cleared: true };

    case 'serialcontrol': {
      const sid = serialBridge.getSession(payload.session);
      if (!sid) throw new Error('Serial port not open');
      const signals = {};
      if (payload.rts !== undefined) signals.rts = !!payload.rts;
      if (payload.dtr !== undefined) signals.dtr = !!payload.dtr;
      if (payload.brk !== undefined) signals.brk = !!payload.brk;
      if (payload.cmd === 'break') signals.brk = true;
      await serialBridge.setSignals(sid, signals);
      return { ...signals };
    }

    // ── Register ────────────────────────────────────────────────────────────────
    case 'registerstatus':
      return switchProtocol.registerStatus();

    case 'registerread':
      return switchProtocol.registerRead(payload);

    case 'registerwrite':
      return switchProtocol.registerWrite(payload);

    // ── FDB ─────────────────────────────────────────────────────────────────────
    case 'fdbread': {
      const entry = await switchProtocol.fdbRead(payload);
      return { entry };
    }
    case 'fdbwrite':
      return switchProtocol.fdbWrite(payload);
    case 'fdbdelete':
      return switchProtocol.fdbDelete(payload);
    case 'fdbflush':
      return switchProtocol.fdbFlush(payload);

    // ── App/sequence stubs (for clients that call these when no C# present) ─────
    case 'appstatus':
      return { selectedTabIndex: 0, sequenceCount: 0 };

    case 'portslinkstatus':
      // If register read works, delegate to mdio route's logic would be ideal,
      // but here we just return unknown state so callers don't crash.
      return { ports: Array.from({ length: 6 }, (_, i) => ({ port: i, linkUp: null })) };

    default:
      throw Object.assign(new Error(`No native handler for: ${command}`), { workerError: true });
  }
}

module.exports = { dispatch };
