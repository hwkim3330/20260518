const $ = (id) => document.getElementById(id);

const state = {
  interfaces: [],
  senderIface: '',
  captureInterfaces: new Set(),
  captureRows: [],
  captureTimer: null,
  serialTimer: null,
  serialConnected: false,
  selectedGroupIdx: 0,
  selectedTcIdx: null,
};

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'info') {
  const tray = $('toastTray');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  tray.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setStatus(text, ok = true) {
  $('status').textContent = text;
  $('serverState').classList.toggle('bad', !ok);
  $('workerStatus').textContent = ok ? `Worker: connected` : `Worker: offline`;
  $('workerStatus').className = ok ? 'ok' : 'err';
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function tsNow() {
  const d = new Date();
  return `[${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}]`;
}

function pad2(n) { return String(n).padStart(2,'0'); }

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      $(tab.dataset.view)?.classList.add('active');
      if (tab.dataset.view === 'hyperTermView' || tab.dataset.view === 'hyperTerminalView') {
        refreshSerialStatus();
      }
    });
  });
  // Light theme uses .modeTab class
  document.querySelectorAll('.modeTab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.view === 'hyperTerminalView') refreshSerialStatus();
    });
  });
}

// ── Interfaces ────────────────────────────────────────────────────────────────
async function refreshInterfaces() {
  const data = await api('/api/interfaces');
  state.interfaces = data.interfaces || [];
  renderSenderInterfaces();
  await refreshCaptureStatus();
  setStatus(`Connected — ${state.interfaces.length} interfaces`);
}

function renderSenderInterfaces() {
  const wrap = $('senderInterfaces');
  if (!wrap) return;
  if (!state.interfaces.length) { wrap.innerHTML = '<p style="color:var(--muted);font-size:10px;">No interfaces found.</p>'; return; }
  wrap.innerHTML = '';
  for (const iface of state.interfaces) {
    const btn = document.createElement('button');
    btn.className = `chip ${iface.state === 'up' ? 'up' : ''}`;
    btn.textContent = iface.name;
    btn.title = iface.mac || '';
    btn.addEventListener('click', () => {
      state.senderIface = iface.name;
      wrap.querySelectorAll('.chip').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      if (!$('srcMac')?.value && iface.mac) $('srcMac').value = iface.mac;
      if (!$('srcIp')?.value && iface.ipv4?.[0]?.local) $('srcIp').value = iface.ipv4[0].local;
    });
    wrap.appendChild(btn);
  }
}

// ── Frame Builder ─────────────────────────────────────────────────────────────
function buildProfile() {
  return {
    protocol: $('protocol').value,
    interface: state.senderIface || null,
    dstMac: $('dstMac').value.trim(),
    srcMac: $('srcMac').value.trim(),
    srcIp: $('srcIp').value.trim(),
    dstIp: $('dstIp').value.trim(),
    udp: { srcPort: Number($('srcPort').value) || 12345, dstPort: Number($('dstPort').value) || 50000 },
    count: Number($('count').value) || 1,
    intervalMs: Number($('intervalMs').value) || 0,
    payload: { mode: 'text', data: $('payload').value },
    ...($('vlanEnabled')?.checked ? { vlan: { enabled: true, id: Number($('vlanId').value) || 100, priority: Number($('vlanPriority').value) || 0 } } : {}),
  };
}

function formatHex(hex) {
  if (!hex) return '';
  const bytes = hex.match(/.{1,2}/g) || [];
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const ascii = chunk.map(b => { const n = parseInt(b, 16); return n >= 32 && n <= 126 ? String.fromCharCode(n) : '.'; }).join('');
    lines.push(`${off.toString(16).padStart(4,'0')}  ${chunk.join(' ').padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

async function previewFrame() {
  try {
    const data = await api('/api/build', { method: 'POST', body: JSON.stringify(buildProfile()) });
    const out = data.stdout || data;
    $('decoded').textContent = JSON.stringify(out.decoded || {}, null, 2);
    $('hexdump').textContent = formatHex(out.frameHex);
  } catch (err) { toast(`Build failed: ${err.message}`, 'bad'); }
}

async function sendFrame() {
  if (!state.senderIface) { toast('Select a sender interface first', 'warn'); return; }
  try {
    const data = await api('/api/send', { method: 'POST', body: JSON.stringify(buildProfile()) });
    const out = data.stdout || data;
    toast(`Sent ${out.framesSent || 1} frame(s), ${out.bytesSent || '?'} bytes`, 'ok');
  } catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}

// ── Capture ───────────────────────────────────────────────────────────────────
function formatCaptureRow(r) {
  const eth  = r.decoded?.ethernet || r.decoded?.eth || {};
  const ip   = r.decoded?.ipv4 || {};
  const udp  = r.decoded?.udp || {};
  const tcp  = r.decoded?.tcp || {};
  const icmp = r.decoded?.icmp || {};
  const arp  = r.decoded?.arp || {};

  let protocol = 'RAW';
  if      (udp.srcPort  !== undefined) protocol = 'UDP';
  else if (tcp.srcPort  !== undefined) protocol = 'TCP';
  else if (icmp.type    !== undefined) protocol = 'ICMP';
  else if (arp.operation !== undefined) protocol = 'ARP';
  else if (ip.src)                     protocol = 'IPv4';

  let source = ip.src  || eth.srcMac || '';
  let dest   = ip.dst  || eth.dstMac || '';
  if (udp.srcPort  !== undefined) { source += `:${udp.srcPort}`;  dest += `:${udp.dstPort}`; }
  else if (tcp.srcPort !== undefined) { source += `:${tcp.srcPort}`; dest += `:${tcp.dstPort}`; }

  let info = '';
  if (udp.srcPort !== undefined)
    info = `${udp.srcPort} → ${udp.dstPort}  Len=${r.length}`;
  else if (tcp.srcPort !== undefined)
    info = `${tcp.srcPort} → ${tcp.dstPort}`;
  else if (icmp.type !== undefined)
    info = `Type=${icmp.type} Code=${icmp.code || 0}`;
  else if (arp.operation !== undefined)
    info = arp.operation === 1
      ? `Who has ${arp.targetIp}? Tell ${arp.senderIp}`
      : `${arp.senderIp} is at ${arp.senderMac}`;
  else if (eth.etherType)
    info = `EtherType=0x${Number(eth.etherType).toString(16).toUpperCase().padStart(4,'0')}`;

  const d = new Date((r.timestamp || 0) * 1000);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;

  return {
    no: r.no,
    time,
    interfaceName: r.interface || r.interfaceName || '',
    srcMac: eth.srcMac || '',
    dstMac: eth.dstMac || '',
    source,
    destination: dest,
    protocol,
    length: r.length,
    info,
    detailText: JSON.stringify(r.decoded || {}, null, 2),
    hexDump: formatHex(r.frameHex || r.hex || ''),
  };
}

async function refreshCaptureStatus() {
  try {
    const data = await api('/api/capture/status');
    const running = data.running || data.capturing || false;
    if ($('captureRunning')) $('captureRunning').textContent = running ? '● capturing' : 'idle';
    if ($('captureTotal'))   $('captureTotal').textContent   = `${data.totalPackets || data.captureCount || 0} pkts`;

    const list = $('captureInterfaces');
    if (!list) return;
    list.innerHTML = '';
    state.captureInterfaces = new Set((data.interfaces || []).filter(i => i.selected).map(i => i.name));
    for (const iface of data.interfaces || []) {
      const label = document.createElement('label');
      label.className = 'check-row';
      label.innerHTML = `<input type="checkbox" ${iface.selected ? 'checked' : ''} value="${esc(iface.name)}">
        <span><strong>${esc(iface.name)}</strong><small>${esc(iface.description || iface.state || '')}</small></span>`;
      label.querySelector('input').addEventListener('change', e => {
        if (e.target.checked) state.captureInterfaces.add(iface.name);
        else state.captureInterfaces.delete(iface.name);
      });
      list.appendChild(label);
    }
  } catch { /* keep stable */ }
}

async function startCapture() {
  try {
    await api('/api/capture/start', { method: 'POST', body: JSON.stringify({ interfaces: [...state.captureInterfaces] }) });
    toast('Capture started', 'ok');
    startCapturePolling();
    await refreshCaptureStatus();
  } catch (err) { toast(`Capture failed: ${err.message}`, 'bad'); }
}

async function stopCapture() {
  try {
    await api('/api/capture/stop', { method: 'POST', body: '{}' });
    toast('Capture stopped', 'ok');
    await refreshCaptureStatus();
  } catch (err) { toast(`Stop failed: ${err.message}`, 'bad'); }
}

async function clearCapture() {
  try {
    await api('/api/capture/clear', { method: 'POST', body: '{}' });
    state.captureRows = [];
    renderCaptureRows();
    if ($('packetDetails')) $('packetDetails').textContent = 'Select a packet.';
    if ($('packetHex'))     $('packetHex').textContent = '';
    await refreshCaptureStatus();
  } catch { /* ignore */ }
}

function startCapturePolling() {
  if (state.captureTimer) clearInterval(state.captureTimer);
  state.captureTimer = setInterval(loadCapturePackets, 1200);
  loadCapturePackets();
}

async function loadCapturePackets() {
  try {
    const data = await api('/api/capture/packets?limit=1000');
    state.captureRows = (data.rows || []).map(formatCaptureRow);
    renderCaptureRows();
    if ($('captureTotal'))
      $('captureTotal').textContent = `${data.total || state.captureRows.length} pkts`;
  } catch { /* keep stable */ }
}

function rowMatchesFilter(row, filter) {
  if (!filter) return true;
  const text = `${row.no} ${row.time} ${row.interfaceName} ${row.source} ${row.destination} ${row.protocol} ${row.length} ${row.info} ${row.srcMac} ${row.dstMac}`.toLowerCase();
  return filter.split(/\s+/).filter(Boolean).every(tok => {
    if (tok.startsWith('mac:'))  return `${row.srcMac} ${row.dstMac}`.toLowerCase().includes(tok.slice(4));
    if (tok.startsWith('ip:'))   return `${row.source} ${row.destination}`.toLowerCase().includes(tok.slice(3));
    if (tok.startsWith('port:')) return `${row.source} ${row.destination} ${row.info}`.toLowerCase().includes(tok.slice(5));
    return text.includes(tok);
  });
}

function renderCaptureRows() {
  const tbody = $('captureRows');
  if (!tbody) return;
  const filter = ($('captureFilter')?.value || '').trim().toLowerCase();
  const rows = state.captureRows.filter(r => rowMatchesFilter(r, filter));
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty">No packets captured.</td></tr>`; return; }
  tbody.innerHTML = rows.map((r, i) => `
    <tr data-idx="${i}" class="proto-${esc((r.protocol||'').toLowerCase())}">
      <td>${r.no}</td><td>${esc(r.time)}</td><td>${esc(r.interfaceName)}</td>
      <td class="mac">${esc(r.srcMac)}</td><td class="mac">${esc(r.dstMac)}</td>
      <td>${esc(r.source)}</td><td>${esc(r.destination)}</td>
      <td><strong>${esc(r.protocol)}</strong></td>
      <td>${r.length}</td><td>${esc(r.info)}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      const row = rows[Number(tr.dataset.idx)];
      if ($('packetDetails')) $('packetDetails').textContent = row.detailText || 'No detail.';
      if ($('packetHex'))     $('packetHex').textContent = row.hexDump || '';
    });
  });
}

// ── Scenario Lab ──────────────────────────────────────────────────────────────
async function loadTestCases() {
  try {
    const data = await api('/api/testcases/status');
    const tc = data.testCases || {};
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence — ${tc.selected || '(none selected)'}`;
    renderTcTree(tc.groups || []);
    renderSequenceRows(tc.sequence || []);
  } catch (err) {
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence — load failed`;
  }
}

function renderTcTree(groups) {
  const root = $('tcTree');
  if (!root) return;
  if (!groups.length) { root.innerHTML = '<p style="color:var(--muted);font-size:10px;">No groups. Add one above.</p>'; return; }
  root.innerHTML = groups.map(g => `
    <div class="tc-group">
      <div class="tc-group-head">
        <span>${esc(g.name)}</span>
        <button class="small danger tc-del-group" data-group="${g.index}">Del</button>
      </div>
      ${(g.testCases || []).map(t => `
        <div class="tc-item ${t.selected ? 'selected' : ''}" data-group="${t.groupIndex}" data-tc="${t.index}">
          <span>${esc(t.name)}</span><small>${t.itemCount} items</small>
        </div>`).join('')}
    </div>`).join('');
  root.querySelectorAll('.tc-item').forEach(el => el.addEventListener('click', async () => {
    state.selectedGroupIdx = Number(el.dataset.group);
    state.selectedTcIdx = Number(el.dataset.tc);
    await api('/api/testcases/select', { method: 'POST', body: JSON.stringify({ groupIndex: state.selectedGroupIdx, testCaseIndex: state.selectedTcIdx }) });
    await loadTestCases();
  }));
  root.querySelectorAll('.tc-del-group').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this group?')) return;
    await api('/api/testcases/delete', { method: 'POST', body: JSON.stringify({ groupIndex: Number(btn.dataset.group) }) });
    await loadTestCases();
  }));
}

function renderSequenceRows(items) {
  const tbody = $('sequenceRows');
  if (!tbody) return;
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty">No sequence loaded.</td></tr>`; return; }
  tbody.innerHTML = items.map((item, i) => `
    <tr>
      <td>${i}</td><td>${esc(item.kind)}</td><td>${item.checked ? '✓' : ''}</td>
      <td>${esc(item.packetName || item.eventType || '')}</td>
      <td colspan="4" style="color:var(--muted);">${esc(item.eventType ? JSON.stringify(item.params || {}) : `${(item.blocks || []).length} block(s)`)}</td>
    </tr>`).join('');
}

async function addTcGroup() {
  const name = $('tcGroupName')?.value.trim();
  if (!name) return;
  await api('/api/testcases/add-group', { method: 'POST', body: JSON.stringify({ name }) });
  $('tcGroupName').value = '';
  await loadTestCases();
}

async function addTcFromCurrent() {
  const name = $('tcName')?.value.trim();
  if (!name) { toast('Enter TC name', 'warn'); return; }
  await api('/api/testcases/add', { method: 'POST', body: JSON.stringify({ groupIndex: state.selectedGroupIdx || 0, name }) });
  $('tcName').value = '';
  await loadTestCases();
}

async function saveTcCurrent() {
  try {
    await api('/api/testcases/save-current', { method: 'POST', body: '{}' });
    toast('Saved', 'ok');
    await loadTestCases();
  } catch (err) { toast(`Save failed: ${err.message}`, 'bad'); }
}

function appendSeqTerm(text) {
  const el = $('seqTermOutput');
  if (!el) return;
  el.textContent += `${tsNow()}  ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

async function seqTermSend() {
  const text = $('seqTermInput')?.value.trim();
  if (!text) return;
  try {
    await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ text }) });
    appendSeqTerm(`> ${text}`);
    $('seqTermInput').value = '';
  } catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}

// ── Register (Scenario Lab panel) ─────────────────────────────────────────────
async function refreshRegStatus() {
  try {
    const data = await api('/api/register/status');
    if ($('regStatus')) {
      $('regStatus').textContent = `${data.serialConnected ? '● connected' : '○ disconnected'} — base ${data.baseAddress || '0x0'}`;
    }
    if (data.baseAddress !== undefined && $('regBaseAddr')) {
      const b = typeof data.baseAddress === 'number'
        ? `0x${data.baseAddress.toString(16).toUpperCase().padStart(8,'0')}`
        : data.baseAddress;
      $('regBaseAddr').value = b;
    }
  } catch { if ($('regStatus')) $('regStatus').textContent = 'offline'; }
}

async function readRegister() {
  try {
    const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset: $('regOffset').value }) });
    if ($('regValue')) $('regValue').value = data.value;
    if ($('regResult')) $('regResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    if ($('regResult')) $('regResult').textContent = `Read failed: ${err.message}`;
    toast(`Register read failed: ${err.message}`, 'bad');
  }
}

async function writeRegister() {
  try {
    const data = await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset: $('regOffset').value, value: $('regValue').value }) });
    if ($('regResult')) $('regResult').textContent = JSON.stringify(data, null, 2);
    toast('Register written', 'ok');
  } catch (err) {
    if ($('regResult')) $('regResult').textContent = `Write failed: ${err.message}`;
    toast(`Register write failed: ${err.message}`, 'bad');
  }
}

function fdbPayload() {
  return { mac: $('fdbMac').value.trim(), port: Number($('fdbPort').value) || 0, vlanValid: $('fdbVlanValid').checked, vlanId: Number($('fdbVlanId').value) || 0 };
}

async function fdbCall(path, payload = fdbPayload()) {
  try {
    const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if ($('fdbResult')) $('fdbResult').textContent = JSON.stringify(data, null, 2);
    toast(data.status || 'FDB done', 'ok');
  } catch (err) {
    if ($('fdbResult')) $('fdbResult').textContent = `FDB failed: ${err.message}`;
    toast(`FDB failed: ${err.message}`, 'bad');
  }
}

// ── Register Viewer (HyperTerminal tab) ──────────────────────────────────────
function setRegStatus(id, text, isOk) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `reg-status${isOk ? ' ok' : ''}`;
  if (isOk) setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'reg-status'; } }, 3000);
}

async function rvRead(offset, valId, statusId) {
  try {
    const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
    const val = data.value || `0x${(data.valueDec || 0).toString(16).toUpperCase().padStart(8,'0')}`;
    if (valId && $(valId)) $(valId).value = val;
    setRegStatus(statusId, 'OK', true);
    return data;
  } catch (err) { setRegStatus(statusId, `오류: ${err.message}`, false); }
}

async function rvWrite(offset, value, statusId) {
  try {
    await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value }) });
    setRegStatus(statusId, '쓰기 완료', true);
  } catch (err) { setRegStatus(statusId, `오류: ${err.message}`, false); }
}

function initRegViewer() {
  const rc = $('regContent');
  if (!rc) return;

  // Generic data-rw buttons delegation
  rc.addEventListener('click', async e => {
    const btn = e.target.closest('[data-rw]');
    if (!btn) return;
    const rw  = btn.dataset.rw;
    const valId = btn.dataset.val;
    const stId  = btn.dataset.st;
    const offset = btn.dataset.offVal || (btn.dataset.off ? ($(btn.dataset.off)?.value || btn.dataset.off) : null);
    if (!offset) return;
    try {
      if (rw === 'read') {
        await rvRead(offset, valId, stId);
      } else {
        const val = valId && $(valId) ? $(valId).value : '0x00000000';
        await rvWrite(offset, val, stId);
      }
    } catch { /* status already set */ }
  });

  // READ ALL buttons
  $('sysctlReadAll')?.addEventListener('click', () =>
    Promise.allSettled([
      rvRead('0x000', 'rv-version', 'rv-st-version'),
      rvRead('0x008', 'rv-enable',  'rv-st-enable'),
      rvRead('0x00C', 'rv-ahb',     'rv-st-ahb'),
    ])
  );

  $('interruptReadAll')?.addEventListener('click', () =>
    Promise.allSettled([
      rvRead($('rv-intr-ctrl-off')?.value || '0x010', 'rv-intr-ctrl', 'rv-st-intr-ctrl'),
      rvRead($('rv-intr-raw-off')?.value  || '0x014', 'rv-intr-raw',  'rv-st-intr-raw'),
      rvRead($('rv-intr-mask-off')?.value || '0x018', 'rv-intr-mask', 'rv-st-intr-mask'),
      rvRead($('rv-intr-sw-off')?.value   || '0x01C', 'rv-intr-sw',   'rv-st-intr-sw'),
    ])
  );

  $('timestampReadAll')?.addEventListener('click', () =>
    Promise.allSettled([
      rvRead($('rv-ts-ns-off')?.value    || '0x020', 'rv-ts-ns',    'rv-st-ts'),
      rvRead($('rv-ts-seclo-off')?.value || '0x024', 'rv-ts-seclo', 'rv-st-ts'),
      rvRead($('rv-ts-adj-off')?.value   || '0x030', 'rv-ts-adj',   'rv-st-ts-adj'),
      rvRead($('rv-ts-clk-off')?.value   || '0x038', 'rv-ts-clk',   'rv-st-ts-clk'),
    ])
  );

  $('ledclockReadAll')?.addEventListener('click', () =>
    Promise.allSettled([
      rvRead($('rv-led-ctrl-off')?.value  || '0x040', 'rv-led-ctrl',  'rv-st-led'),
      rvRead($('rv-ext-sw-off')?.value    || '0x044', 'rv-ext-sw',    'rv-st-ext-sw'),
      rvRead($('rv-clk-limit-off')?.value || '0x048', 'rv-clk-limit', 'rv-st-clk-limit'),
    ])
  );

  $('countReadAll')?.addEventListener('click', () =>
    rvRead($('rv-count-off')?.value || '0x300', 'rv-count-v', 'rv-st-count')
  );

  // FDB in Register Viewer
  function rvFdbPay() {
    return { mac: $('rv-fdbMac')?.value.trim(), port: Number($('rv-fdbPort')?.value) || 0, vlanValid: $('rv-fdbVlanValid')?.checked, vlanId: Number($('rv-fdbVid')?.value) || 0 };
  }
  async function rvFdbCall(path, payload = rvFdbPay()) {
    try {
      const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
      if ($('rv-fdbResult')) $('rv-fdbResult').textContent = JSON.stringify(data, null, 2);
      toast(data.status || 'FDB done', 'ok');
    } catch (err) {
      if ($('rv-fdbResult')) $('rv-fdbResult').textContent = `FDB failed: ${err.message}`;
      toast(`FDB failed: ${err.message}`, 'bad');
    }
  }
  $('rv-fdbRead')?.addEventListener('click',   () => rvFdbCall('/api/fdb/read'));
  $('rv-fdbWrite')?.addEventListener('click',  () => rvFdbCall('/api/fdb/write'));
  $('rv-fdbDelete')?.addEventListener('click', () => rvFdbCall('/api/fdb/delete'));
  $('rv-fdbFlush')?.addEventListener('click',  () => { if (confirm('Flush all FDB entries?')) rvFdbCall('/api/fdb/flush', {}); });
}

// ── TOC Navigation ────────────────────────────────────────────────────────────
function initTocNav() {
  document.querySelectorAll('[data-sec]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sec]').forEach(b => b.classList.remove('toc-active'));
      btn.classList.add('toc-active');
      const target = document.getElementById(`rsec-${btn.dataset.sec}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// ── Layout Toggle & Splitter ──────────────────────────────────────────────────
function initLayoutToggle() {
  const btn  = $('layoutToggle');
  const wrap = $('hyperContent');
  if (!btn || !wrap) return;
  let horiz = false;
  btn.addEventListener('click', () => {
    horiz = !horiz;
    wrap.classList.toggle('horizontal', horiz);
    btn.textContent = horiz ? '⊟' : '⊞';
    btn.title = horiz ? '상하 레이아웃으로 전환' : '3분할 레이아웃으로 전환';
  });
}

function initSplitter() {
  const splitter = $('hyperSplitter');
  const wrap     = $('hyperContent');
  const terminal = document.querySelector('.hyper-terminal');
  if (!splitter || !wrap || !terminal) return;
  let dragging = false, startPos = 0, startSize = 0;

  splitter.addEventListener('mousedown', e => {
    dragging  = true;
    const isH = wrap.classList.contains('horizontal');
    startPos  = isH ? e.clientX : e.clientY;
    startSize = isH ? terminal.offsetWidth : terminal.offsetHeight;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const isH  = wrap.classList.contains('horizontal');
    const size = Math.max(80, startSize - ((isH ? e.clientX : e.clientY) - startPos));
    terminal.style[isH ? 'width' : 'height'] = `${size}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ── HyperTerminal (Serial) ────────────────────────────────────────────────────
function updateSerialUI(connected, statusText) {
  state.serialConnected = connected;
  const led = $('serialLed');
  const btn = $('serialConnect');
  const st  = $('serialState');
  if (led) led.classList.toggle('connected', connected);
  if (btn) {
    btn.textContent = connected ? '연결 해제' : '연결';
    btn.className   = connected ? 'danger' : 'primary';
    btn.style.width = '80px';
  }
  if (st && statusText !== undefined) st.textContent = statusText;
}

// appendHyperTerm — add timestamped line to serial terminal output
function appendHyperTerm(text) {
  const out = $('serialOutput');
  if (!out) return;
  const now = new Date();
  const ts  = `[${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
  if (out.textContent === 'No terminal output.') out.textContent = '';
  out.textContent += `${ts}  ${text}\n`;
  out.scrollTop = out.scrollHeight;
}

// TTY streaming for native Linux serial (no C# worker)
let _ttyStreamCtrl = null;
function startTtyStream(session) {
  if (_ttyStreamCtrl) { _ttyStreamCtrl.abort(); }
  _ttyStreamCtrl = new AbortController();
  const url = `/api/tty/stream${session ? `?session=${encodeURIComponent(session)}` : ''}`;
  let buf = '';

  fetch(url, { signal: _ttyStreamCtrl.signal })
    .then(r => {
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      function read() {
        reader.read().then(({ done, value }) => {
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const s = part.trim();
            if (!s) continue;
            try {
              const msg = JSON.parse(s);
              if (msg.type === 'rx' && msg.hex) {
                const bytes = Uint8Array.from(msg.hex.match(/.{1,2}/g) || [],
                  b => parseInt(b, 16));
                const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                text.split(/\r?\n/).filter(l => l.trim()).forEach(l => appendHyperTerm(l));
              } else if (msg.type === 'closed') {
                updateSerialUI(false, 'disconnected');
                stopTtyStream();
              } else if (msg.type === 'error') {
                appendHyperTerm(`[ERR] ${msg.message}`);
              }
            } catch { /* ignore parse errors */ }
          }
          read();
        }).catch(() => {});
      }
      read();
    }).catch(() => {});
}

function stopTtyStream() {
  if (_ttyStreamCtrl) { _ttyStreamCtrl.abort(); _ttyStreamCtrl = null; }
}

async function refreshSerialStatus() {
  try {
    const data = await api('/api/serial/status');
    // Handle both C# worker format (data.terminal.*) and native Linux format (data.ttys/data.open)
    const t    = data.terminal || {};
    const ttys = data.ttys || data.ports || t.ports || [];

    const portSel = $('serialPort');
    if (portSel) {
      const cur = portSel.value || t.selectedPort || data.session || '';
      portSel.innerHTML = ttys.map(p => {
        const val   = p.path || p.portName || p.PortName || p.name || String(p);
        const label = p.manufacturer
          ? `${val}  (${p.manufacturer})`
          : (p.displayName || p.DisplayName || p.usbProduct || val);
        return `<option value="${esc(val)}">${esc(label)}</option>`;
      }).join('');
      if (!portSel.innerHTML) portSel.innerHTML = '<option value="">-- 포트 없음 --</option>';
      if (cur && portSel.querySelector(`option[value="${cur}"]`)) portSel.value = cur;
    }

    const baudSel = $('serialBaud');
    if (baudSel && !baudSel.options.length) {
      const cur = baudSel.value || String(t.selectedBaudRate || 115200);
      baudSel.innerHTML = (t.baudRates || [9600, 19200, 38400, 57600, 115200, 230400, 921600])
        .map(b => `<option value="${b}">${b}</option>`).join('');
      baudSel.value = cur;
    }

    // Native mode: data.open / data.connected; C# worker mode: t.isConnected
    const connected = !!(data.open || data.connected || t.isConnected);
    const statusTxt = t.connectionStatus || (connected ? `connected (${data.session || ''})` : 'disconnected');
    updateSerialUI(connected, statusTxt);

    // C# worker provides terminal output text; native uses streaming
    const out = $('serialOutput');
    if (out && t.terminalOutput !== undefined) {
      out.textContent = t.terminalOutput || 'No terminal output.';
      out.scrollTop = out.scrollHeight;
    }
  } catch (err) { updateSerialUI(false, 'offline'); }
}

async function toggleSerial() {
  try {
    if (state.serialConnected) {
      stopTtyStream();
      await api('/api/serial/disconnect', { method: 'POST', body: '{}' });
      toast('Serial disconnected', 'ok');
    } else {
      const port = $('serialPort')?.value;
      const baud = Number($('serialBaud')?.value) || 115200;
      if (!port) { toast('포트를 먼저 선택하세요', 'warn'); return; }
      const res = await api('/api/serial/connect', { method: 'POST',
        body: JSON.stringify({ port, baudRate: baud, path: port }) });
      // Start TTY stream for native Linux (no C# worker terminal output)
      if (!res?.terminal) startTtyStream(res?.session || res?.sessionId || port);
      toast(`연결됨: ${port} @ ${baud} bps`, 'ok');
    }
    await refreshSerialStatus();
  } catch (err) {
    toast(`시리얼 오류: ${err.message}`, 'bad');
    await refreshSerialStatus();
  }
}

async function sendSerial() {
  const inp = $('serialInput');
  if (!inp?.value.trim()) return;
  const text = inp.value + '\r\n';
  try {
    await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ text }) });
    appendHyperTerm(`> ${inp.value}`);
    inp.value = '';
  } catch (err) { toast(`전송 실패: ${err.message}`, 'bad'); }
}

// ── Logs ──────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const data = await api('/api/logs');
    if ($('logsBox')) $('logsBox').textContent = JSON.stringify(data, null, 2);
  } catch (err) { if ($('logsBox')) $('logsBox').textContent = `Log load failed: ${err.message}`; }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function initWebSocket() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'workerEvent') {
        const p = msg.payload || {};
        if (p.type === 'serialData' || p.type === 'terminal') {
          // Route only to scenario lab terminal to avoid duplicate with polling
          appendSeqTerm(p.text || p.data || '');
        }
      }
    } catch { /* ignore */ }
  };
  ws.onclose = () => setTimeout(initWebSocket, 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  initTabs();
  initWebSocket();
  initLayoutToggle();
  initSplitter();
  initTocNav();
  initRegViewer();

  if ($('startTime')) $('startTime').textContent = new Date().toLocaleTimeString();

  // Packet Generator
  $('refreshAll')?.addEventListener('click', refreshInterfaces);
  $('build')?.addEventListener('click', previewFrame);
  $('send')?.addEventListener('click', sendFrame);
  ['protocol','dstMac','srcMac','srcIp','dstIp','srcPort','dstPort','payload','vlanEnabled','vlanId','vlanPriority']
    .forEach(id => $(id)?.addEventListener('change', previewFrame));

  // Capture
  $('captureRefresh')?.addEventListener('click', refreshCaptureStatus);
  $('captureStart')?.addEventListener('click', startCapture);
  $('captureStop')?.addEventListener('click', stopCapture);
  $('captureClear')?.addEventListener('click', clearCapture);
  $('captureFilter')?.addEventListener('input', renderCaptureRows);

  // Protocol filter chips
  document.querySelectorAll('.proto-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.proto-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const f = $('captureFilter');
      if (f) { f.value = btn.dataset.proto || ''; renderCaptureRows(); }
    });
  });

  // Scenario Lab
  $('tcRefresh')?.addEventListener('click', loadTestCases);
  $('tcAddGroup')?.addEventListener('click', addTcGroup);
  $('tcAdd')?.addEventListener('click', addTcFromCurrent);
  $('tcSaveCurrent')?.addEventListener('click', saveTcCurrent);
  $('seqTermSend')?.addEventListener('click', seqTermSend);
  $('seqTermInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') seqTermSend(); });
  $('clearSeqTerminal')?.addEventListener('click', () => { if ($('seqTermOutput')) $('seqTermOutput').textContent = ''; });

  // Register / FDB (Scenario Lab)
  $('regStatusRefresh')?.addEventListener('click', refreshRegStatus);
  $('regRead')?.addEventListener('click', readRegister);
  $('regWrite')?.addEventListener('click', writeRegister);
  $('fdbRead')?.addEventListener('click', () => fdbCall('/api/fdb/read'));
  $('fdbWrite')?.addEventListener('click', () => fdbCall('/api/fdb/write'));
  $('fdbDelete')?.addEventListener('click', () => fdbCall('/api/fdb/delete'));
  $('fdbFlush')?.addEventListener('click', () => { if (confirm('Flush all FDB entries?')) fdbCall('/api/fdb/flush', {}); });

  // HyperTerminal
  $('serialRefresh')?.addEventListener('click', refreshSerialStatus);
  $('serialConnect')?.addEventListener('click', toggleSerial);
  $('serialSend')?.addEventListener('click', sendSerial);
  $('serialInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendSerial(); });
  $('serialClear')?.addEventListener('click', async () => {
    try { await api('/api/serial/clear', { method: 'POST', body: '{}' }); } catch { /* best effort */ }
    if ($('serialOutput')) $('serialOutput').textContent = '';
  });

  // Settings
  $('refreshLogs')?.addEventListener('click', loadLogs);

  try {
    await api('/api/health');
    await Promise.allSettled([
      refreshInterfaces(),
      loadLogs(),
      refreshSerialStatus(),
      refreshRegStatus(),
      loadTestCases(),
    ]);
    startCapturePolling();
    state.serialTimer = setInterval(refreshSerialStatus, 2000);
  } catch (err) {
    setStatus(`Offline — ${err.message}`, false);
    toast(`Server not reachable: ${err.message}`, 'bad');
  }
}

init();
