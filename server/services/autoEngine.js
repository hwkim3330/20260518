'use strict';
/**
 * autoEngine.js — Node.js automation test runner.
 * Used as fallback when C# worker is not connected (Linux / headless).
 * Test cases are loaded from logs/tests/test-cases.json (same file as testcases.js).
 */
const path = require('path');
const fs   = require('fs');

let _state = {
  running:    false,
  test:       null,
  startedAt:  null,
  statusText: 'Idle',
  result:     null,
  rows:       [],
};

let _services  = null;
let _testsDir  = null;
let _stopFlag  = false;

function init(services, testsDir) {
  _services = services;
  _testsDir = testsDir;
}

async function runTest(testName) {
  if (_state.running) throw new Error('Already running');
  if (!_services)     throw new Error('autoEngine not initialized');
  _stopFlag = false;
  _state = { running: true, test: testName, startedAt: Date.now(), statusText: 'Starting…', result: null, rows: [] };

  try {
    const file = path.join(_testsDir, 'test-cases.json');
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const tc   = list.find(t => t.name === testName || t.id === testName);
    if (!tc) throw new Error(`Test not found: ${testName}`);

    const steps = Array.isArray(tc.steps) ? tc.steps : [];
    let passed = 0;
    let failed = 0;

    for (let i = 0; i < steps.length; i++) {
      if (_stopFlag) { _state.statusText = 'Stopped'; break; }
      const step = steps[i];
      _state.statusText = `[${i + 1}/${steps.length}] ${step.name || step.eventType || step.type || 'step'}`;

      let row;
      try {
        const r = await runStep(step);
        row = { step: i + 1, name: step.name || step.eventType || step.type, result: r.pass ? 'PASS' : 'FAIL', detail: r.detail };
        if (r.pass) passed++; else failed++;
      } catch (e) {
        row = { step: i + 1, name: step.name || step.type, result: 'FAIL', detail: e.message };
        failed++;
      }
      _state.rows.push(row);
    }

    _state.result     = failed === 0 ? 'PASS' : 'FAIL';
    _state.statusText = `Done — ${passed} passed, ${failed} failed`;
  } catch (e) {
    _state.result     = 'FAIL';
    _state.statusText = `Error: ${e.message}`;
    _state.rows.push({ step: -1, name: 'error', result: 'FAIL', detail: e.message });
  } finally {
    _state.running = false;
  }
}

async function runStep(step) {
  const type = (step.eventType || step.type || 'delay').toLowerCase();
  const { packetBackend, switchProtocol } = _services;

  switch (type) {

    case 'delay':
      await delay(step.delayMs ?? 100);
      return { pass: true, detail: `${step.delayMs ?? 100}ms` };

    case 'regwrite':
    case 'registerwrite': {
      await switchProtocol.registerWrite({
        offset: step.address ?? step.offset,
        value:  step.value,
      });
      return { pass: true, detail: `write ${step.value} → ${step.address ?? step.offset}` };
    }

    case 'regread':
    case 'registerread': {
      const r = await switchProtocol.registerRead({ offset: step.address ?? step.offset });
      return { pass: true, detail: `read → ${r.value}` };
    }

    case 'regwaitfor':
    case 'registerwait':
    case 'registerexpect': {
      const mask     = parseHex(step.mask     ?? '0xFFFFFFFF');
      const expected = parseHex(step.expected ?? '0x00000000');
      const timeout  = step.timeoutMs ?? 1000;
      const deadline = Date.now() + timeout;
      let last = 0;
      while (Date.now() < deadline) {
        const r = await switchProtocol.registerRead({ offset: step.address ?? step.offset });
        last = r.raw ?? parseHex(r.value);
        if ((last & mask) === (expected & mask))
          return { pass: true, detail: `got 0x${last.toString(16)}` };
        await delay(20);
      }
      return { pass: false, detail: `timeout: last=0x${last.toString(16)}, expected=0x${expected.toString(16)}&mask` };
    }

    case 'send':
    case 'sendpacket': {
      const profile = step.profile || step;
      const result  = await packetBackend.sendPackets(require('./frameBuilder').normalizeProfile(profile));
      return { pass: true, detail: `${result.framesSent} frames sent` };
    }

    case 'capture':
    case 'startcapture':
      packetBackend.clearCapture();
      packetBackend.startCapture(
        step.interfaces ?? (step.captureInterface ? [step.captureInterface] : []),
        step.captureFilter ?? '',
        () => {}, () => {}
      );
      return { pass: true, detail: 'capture started' };

    case 'stopcapture':
      packetBackend.stopCapture();
      return { pass: true, detail: 'capture stopped' };

    case 'captureverify':
    case 'rxverify':
    case 'checkcapture': {
      const timeout  = step.timeoutMs ?? 3000;
      const deadline = Date.now() + timeout;
      const filter   = step.captureFilter ?? '';
      const expected = step.captureExpected ?? 1;
      let matched = [];
      while (Date.now() < deadline) {
        const { rows } = packetBackend.getCaptures(10000, 0);
        matched = filter
          ? rows.filter(r => r.frameHex?.includes(filter) || JSON.stringify(r.decoded).includes(filter))
          : rows;
        if (matched.length >= expected) break;
        await delay(100);
      }
      const pass = matched.length >= expected;
      return { pass, detail: `${matched.length}/${expected} frames matched` };
    }

    case 'fdbwrite': {
      await switchProtocol.fdbWrite({
        mac: step.macAddress ?? step.mac, port: step.port ?? 0,
        vlanId: step.vlanId ?? 0, vlanValid: step.vlanValid ?? false,
      });
      return { pass: true, detail: `FDB write ${step.macAddress ?? step.mac} → port ${step.port ?? 0}` };
    }

    case 'fdbread': {
      const r = await switchProtocol.fdbRead({ mac: step.macAddress ?? step.mac, vlanId: step.vlanId ?? 0 });
      return { pass: true, detail: JSON.stringify(r).slice(0, 80) };
    }

    case 'fdbflush': {
      await switchProtocol.fdbFlush({});
      return { pass: true, detail: 'FDB flushed' };
    }

    case 'serialsend': {
      const { serialBridge } = _services;
      if (!serialBridge) return { pass: false, detail: 'no serial service' };
      const sessions = serialBridge.getSessions ? serialBridge.getSessions() : [];
      const sess = sessions[0];
      if (!sess) return { pass: false, detail: 'no serial session open' };
      if (step.serialHex) {
        const buf = Buffer.from(step.serialHex.replace(/\s/g, ''), 'hex');
        await sess.write(buf);
      } else {
        await sess.write(Buffer.from(step.serialText ?? '', 'utf8'));
      }
      return { pass: true, detail: `sent "${step.serialText || step.serialHex || ''}"` };
    }

    case 'serialverify': {
      const { serialBridge } = _services;
      if (!serialBridge) return { pass: false, detail: 'no serial service' };
      const timeout  = step.timeoutMs ?? 5000;
      const deadline = Date.now() + timeout;
      const expect   = step.serialText ?? '';
      let buf = '';
      while (Date.now() < deadline) {
        if (buf.includes(expect)) return { pass: true, detail: `matched "${expect}"` };
        await delay(50);
      }
      return { pass: false, detail: `timeout waiting for "${expect}"` };
    }

    default:
      return { pass: true, detail: `${type} skipped (native mode)` };
  }
}

function stopTest() {
  _stopFlag = true;
  _state.running    = false;
  _state.statusText = 'Stopped';
  _state.result     = _state.result ?? 'STOPPED';
}

function getStatus()  {
  return { running: _state.running, result: _state.result ?? null, statusText: _state.statusText };
}

function getResults() { return _state.rows.slice(); }

function parseHex(s) { return parseInt(String(s ?? '0').replace(/^0x/i, ''), 16) || 0; }
function delay(ms)   { return new Promise(r => setTimeout(r, ms)); }

module.exports = { init, runTest, stopTest, getStatus, getResults };
