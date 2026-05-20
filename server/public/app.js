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
      } else {
        if (_intrPollTimer) { clearInterval(_intrPollTimer); _intrPollTimer = null; const btn = $('rv-intr-raw-poll'); if (btn) { btn.textContent = '▶ Poll'; btn.className = 'small'; } }
      }
      if (tab.dataset.view === 'settingsView') {
        $('settingsWorkerRefresh')?.click();
      }
      if (tab.dataset.view === 'addrMapView') {
        refreshAddrLocal();
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

// ── Packet Library (localStorage templates) ───────────────────────────────────
const PKT_TPL_KEY = 'pktTemplates_v1';

function pktTplLoad() {
  try { return JSON.parse(localStorage.getItem(PKT_TPL_KEY) || '[]'); } catch { return []; }
}
function pktTplSave(list) {
  localStorage.setItem(PKT_TPL_KEY, JSON.stringify(list));
}

function renderPktTemplates() {
  const box = $('pktTplList');
  if (!box) return;
  const list = pktTplLoad();
  if (!list.length) {
    box.innerHTML = '<p style="color:var(--muted);font-size:10px;">No saved templates.</p>';
    return;
  }
  box.innerHTML = '';
  list.forEach((tpl, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;border:1px solid var(--border);border-radius:3px;padding:4px 6px;background:var(--bg);';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'flex:1;overflow:hidden;cursor:pointer;';
    lbl.innerHTML = `<div style="font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(tpl.name)}</div>
      <div style="font-size:9px;color:var(--muted);">${esc(tpl.profile.protocol||'')} · ${esc(tpl.profile.dstMac||'')} · ×${tpl.profile.count||1}</div>`;
    lbl.title = `Load: ${tpl.name}`;
    lbl.addEventListener('click', () => loadPktTemplate(tpl));
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '✕';
    del.title = 'Delete template';
    del.style.cssText = 'padding:2px 5px;flex-shrink:0;';
    del.addEventListener('click', () => {
      const l = pktTplLoad();
      l.splice(idx, 1);
      pktTplSave(l);
      renderPktTemplates();
    });
    row.appendChild(lbl);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function loadPktTemplate(tpl) {
  const p = tpl.profile;
  if ($('protocol') && p.protocol) $('protocol').value = p.protocol;
  if ($('dstMac') && p.dstMac) $('dstMac').value = p.dstMac;
  if ($('srcMac') && p.srcMac) $('srcMac').value = p.srcMac;
  if ($('srcIp')  && p.srcIp)  $('srcIp').value  = p.srcIp;
  if ($('dstIp')  && p.dstIp)  $('dstIp').value  = p.dstIp;
  if ($('srcPort') && p.udp?.srcPort) $('srcPort').value = p.udp.srcPort;
  if ($('dstPort') && p.udp?.dstPort) $('dstPort').value = p.udp.dstPort;
  if ($('count')   && p.count)        $('count').value   = p.count;
  if ($('intervalMs') && p.intervalMs !== undefined) $('intervalMs').value = p.intervalMs;
  if ($('payload') && p.payload?.data) $('payload').value = p.payload.data;
  if ($('vlanEnabled') && p.vlan) {
    $('vlanEnabled').checked = !!p.vlan.enabled;
    if ($('vlanId')) $('vlanId').value = p.vlan.id ?? 100;
    if ($('vlanPriority')) $('vlanPriority').value = p.vlan.priority ?? 0;
  }
  previewFrame();
  toast(`Loaded: ${tpl.name}`, 'ok');
}

// ── Addr Map ──────────────────────────────────────────────────────────────────
function renderIfaceCard(iface, container) {
  const ipList = (iface.ipv4 || []).map(a => `${a.local}/${a.prefixlen}`).join(', ') || '—';
  const div = document.createElement('div');
  div.style.cssText = 'border:1px solid var(--border);border-radius:4px;padding:8px 10px;margin-bottom:6px;background:var(--bg);';
  div.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <span style="width:8px;height:8px;border-radius:50%;background:${iface.state==='up'?'var(--green)':'var(--border)'};flex-shrink:0;"></span>
      <strong style="font-size:12px;">${esc(iface.name)}</strong>
      <span style="font-size:9px;color:var(--muted);margin-left:auto;">${esc(iface.state||'')}</span>
    </div>
    <div style="font-size:10px;color:var(--muted);">MAC: <span style="color:var(--fg);font-family:monospace;">${esc(iface.mac||'—')}</span></div>
    <div style="font-size:10px;color:var(--muted);">IP: <span style="color:var(--fg);">${esc(ipList)}</span></div>`;
  container.appendChild(div);
}

async function refreshAddrLocal() {
  const box = $('addrLocalList');
  if (!box) return;
  try {
    const data = await api('/api/interfaces');
    box.innerHTML = '';
    (data.interfaces || []).forEach(iface => renderIfaceCard(iface, box));
    if (!box.children.length) box.innerHTML = '<p style="color:var(--muted);">No interfaces found.</p>';
  } catch (err) { box.innerHTML = `<p style="color:var(--red);">Error: ${esc(err.message)}</p>`; }
}

async function probeAddrPeer() {
  const urlEl = $('addrPeerUrl');
  const url   = urlEl?.value.trim().replace(/\/$/, '');
  if (!url) { toast('Enter peer URL first', 'warn'); return; }
  const box  = $('addrPeerList');
  const stat = $('addrPeerStatus');
  const sel  = $('addrFillIface');
  if (stat) stat.textContent = 'Probing…';
  try {
    const data = await api(`${url}/api/interfaces`);
    if (box) {
      box.innerHTML = '';
      (data.interfaces || []).forEach(iface => renderIfaceCard(iface, box));
      if (!box.children.length) box.innerHTML = '<p style="color:var(--muted);">No interfaces found.</p>';
    }
    if (sel) {
      sel.innerHTML = '<option value="">-- select interface --</option>' +
        (data.interfaces || []).map(i => {
          const ip = i.ipv4?.[0]?.local || '';
          return `<option value="${esc(i.name)}" data-mac="${esc(i.mac||'')}" data-ip="${esc(ip)}">${esc(i.name)}  ${ip ? '('+ip+')' : ''}</option>`;
        }).join('');
    }
    if (stat) stat.textContent = `${(data.interfaces||[]).length} interfaces`;
  } catch (err) {
    if (box) box.innerHTML = `<p style="color:var(--red);">Probe failed: ${esc(err.message)}</p>`;
    if (stat) stat.textContent = 'failed';
  }
}

function fillDstFromPeer() {
  const sel = $('addrFillIface');
  if (!sel?.value) { toast('Select a peer interface first', 'warn'); return; }
  const opt = sel.options[sel.selectedIndex];
  const mac = opt.dataset.mac;
  const ip  = opt.dataset.ip;
  if (mac && $('dstMac')) $('dstMac').value = mac;
  if (ip  && $('dstIp'))  $('dstIp').value  = ip;
  toast(`Filled dst: ${mac} / ${ip}`, 'ok');
  previewFrame();
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
    const prevCount = state.captureRows.length;
    state.captureRows = (data.rows || []).map(formatCaptureRow);
    renderCaptureRows();
    const total = data.total || state.captureRows.length;
    if ($('captureTotal')) $('captureTotal').textContent = `${total} pkts`;
    updateStatusBar();
    if (state.captureRows.length > prevCount && $('capAutoScroll')?.checked) {
      const ta = document.querySelector('#captureView .table-area');
      if (ta) ta.scrollTop = ta.scrollHeight;
    }
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
    // Native format: data.snapshot is an array of groups [{id,name,cases:[]}]
    const snapshot = data.snapshot || data.testCases || [];
    const groups = Array.isArray(snapshot) ? snapshot : (snapshot.groups || []);
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence`;
    renderTcTree(groups);
  } catch (err) {
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence — load failed`;
  }
}

async function loadSequence() {
  try {
    const data = await api('/api/sequence/full');
    const items = data.items || [];
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence (${items.length} events)`;
    renderSequenceRows(items);
  } catch (err) {
    renderSequenceRows([]);
  }
}

function renderTcTree(groups) {
  const root = $('tcTree');
  if (!root) return;
  if (!groups.length) { root.innerHTML = '<p style="color:var(--muted);font-size:10px;">No groups. Add one above.</p>'; return; }
  root.innerHTML = groups.map((g, gi) => `
    <div class="tc-group">
      <div class="tc-group-head">
        <span>${esc(g.name)}</span>
        <button class="small danger tc-del-group" data-group="${gi}">Del</button>
      </div>
      ${(g.cases || g.testCases || []).map((t, ti) => `
        <div class="tc-item" data-group="${gi}" data-tc="${ti}">
          <span>${esc(t.name)}</span><small>${(t.steps||[]).length} steps</small>
        </div>`).join('')}
    </div>`).join('');
  root.querySelectorAll('.tc-item').forEach(el => el.addEventListener('click', async () => {
    state.selectedGroupIdx = Number(el.dataset.group);
    state.selectedTcIdx = Number(el.dataset.tc);
    el.closest('.tc-group').querySelectorAll('.tc-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    // Load TC steps into sequence
    try {
      const data = await api('/api/testcases/status');
      const snapshot = data.snapshot || [];
      const grp = snapshot[state.selectedGroupIdx];
      const tc  = (grp?.cases || grp?.testCases || [])[state.selectedTcIdx];
      if (tc) renderSequenceRows(tc.steps || []);
      if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence — ${esc(tc?.name || '')}`;
    } catch {}
  }));
  root.querySelectorAll('.tc-del-group').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this group?')) return;
    await api('/api/testcases/delete', { method: 'POST', body: JSON.stringify({ groupIndex: Number(btn.dataset.group) }) });
    await loadTestCases();
  }));
}

function seqEventSummary(item) {
  const t = (item.eventType || item.type || '').toLowerCase();
  if (t === 'delay')          return `${item.delayMs ?? 100}ms`;
  if (t === 'registerwrite')  return `${item.offset || item.address}  ←  ${item.value}`;
  if (t === 'registerread')   return `${item.offset || item.address}`;
  if (t === 'registerexpect') return `${item.offset || item.address} & ${item.mask||'0xFFFFFFFF'} == ${item.expected} [${item.timeoutMs||1000}ms]`;
  if (t === 'fdbwrite')       return `MAC:${item.mac}  Port:${item.port}`;
  if (t === 'fdbread')        return `MAC:${item.mac}`;
  if (t === 'fdbflush')       return `flush all`;
  if (t === 'rxverify')       return `if:${item.captureInterface||'?'}  filter:${item.captureFilter||''}  expect:${item.captureExpected||1}`;
  return JSON.stringify(item).slice(0,60);
}

function renderSequenceRows(items) {
  const tbody = $('sequenceRows');
  if (!tbody) return;
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty">No events. Drag from palette or click items →</td></tr>`; return; }
  tbody.innerHTML = items.map((item, i) => {
    const type = item.eventType || item.type || item.kind || 'Event';
    const info = seqEventSummary(item);
    return `<tr>
      <td style="color:var(--muted);font-size:10px;">${i+1}</td>
      <td><strong>${esc(type)}</strong></td>
      <td style="color:var(--muted);font-size:10px;">${esc(info)}</td>
      <td><button class="small danger seq-del" data-idx="${i}" style="padding:1px 5px;font-size:10px;">✕</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.seq-del').forEach(btn => btn.addEventListener('click', async () => {
    const idx = Number(btn.dataset.idx);
    await api('/api/sequence/event/remove', { method:'POST', body: JSON.stringify({ index: idx }) });
    await loadSequence();
  }));
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

// ── Event Palette Modal ───────────────────────────────────────────────────────
const EVENT_FIELDS = {
  Delay:      [{ id:'delayMs',  label:'Delay (ms)',       type:'number', def:'500'           }],
  RegWrite:   [{ id:'offset',   label:'Offset (hex)',     type:'text',   def:'0x000'         },
               { id:'value',    label:'Value (hex)',      type:'text',   def:'0x00000001'    }],
  RegRead:    [{ id:'offset',   label:'Offset (hex)',     type:'text',   def:'0x000'         }],
  RegVerify:  [{ id:'offset',   label:'Offset (hex)',     type:'text',   def:'0x000'         },
               { id:'expected', label:'Expected (hex)',   type:'text',   def:'0x00000001'    },
               { id:'mask',     label:'Mask (hex)',       type:'text',   def:'0xFFFFFFFF'    },
               { id:'timeoutMs',label:'Timeout (ms)',     type:'number', def:'1000'          }],
  FdbWrite:   [{ id:'mac',      label:'MAC',              type:'text',   def:'00:00:00:00:00:00' },
               { id:'vlanId',   label:'VLAN ID',          type:'number', def:'0'             },
               { id:'port',     label:'Port',             type:'number', def:'0'             }],
  FdbRead:    [{ id:'mac',      label:'MAC',              type:'text',   def:'00:00:00:00:00:00' },
               { id:'vlanId',   label:'VLAN ID',          type:'number', def:'0'             }],
  FdbFlush:   [],
  RxVerify:   [{ id:'captureInterface', label:'Interface',     type:'text',   def:''        },
               { id:'captureFilter',    label:'Filter (text)', type:'text',   def:''        },
               { id:'captureExpected',  label:'Min frames',    type:'number', def:'1'       }],
};

const EVENT_TYPES = {
  Delay:     'delay',     RegWrite: 'registerWrite', RegRead: 'registerRead',
  RegVerify: 'registerExpect', FdbWrite: 'fdbWrite', FdbRead:  'fdbRead',
  FdbFlush:  'fdbFlush',  RxVerify: 'rxVerify',
};

let _evKind = null;

function openEventModal(kind) {
  _evKind = kind;
  const fields = EVENT_FIELDS[kind] || [];
  const body = $('evModalBody');
  const title = $('evModalTitle');
  if (!body || !title) return;
  title.textContent = `Add Event: ${kind}`;
  if (!fields.length) {
    body.innerHTML = `<p style="color:var(--muted);font-size:12px;">No parameters required. Click "Add to Sequence".</p>`;
  } else {
    body.innerHTML = fields.map(f => `
      <div class="field">
        <label>${f.label}</label>
        <input id="evf-${f.id}" type="${f.type}" value="${f.def}" placeholder="${f.label}">
      </div>`).join('');
  }
  $('eventModal').style.display = 'flex';
  body.querySelector('input')?.focus();
}

async function confirmEventModal() {
  const kind   = _evKind;
  const fields = EVENT_FIELDS[kind] || [];
  const event  = { eventType: EVENT_TYPES[kind] || kind.toLowerCase() };
  for (const f of fields) {
    const el = $(`evf-${f.id}`);
    if (!el) continue;
    event[f.id] = f.type === 'number' ? Number(el.value) : el.value;
  }
  try {
    await api('/api/sequence/event/add', { method:'POST', body: JSON.stringify(event) });
    closeEventModal();
    await loadSequence();
    toast(`${kind} added`, 'ok');
  } catch(err) { toast(`Add failed: ${err.message}`, 'bad'); }
}

function closeEventModal() {
  $('eventModal').style.display = 'none';
  _evKind = null;
}

async function runSequence() {
  try {
    const data = await api('/api/sequence/run', { method:'POST', body:'{}' });
    appendSeqTerm(`▶ Sequence started`);
    toast('Sequence started', 'ok');
  } catch(err) { toast(`Run failed: ${err.message}`, 'bad'); }
}

async function clearSequence() {
  if (!confirm('Clear all sequence events?')) return;
  try {
    await api('/api/sequence/events/clear', { method:'POST', body:'{}' });
    await loadSequence();
    toast('Sequence cleared', 'ok');
  } catch(err) { toast(`Clear failed: ${err.message}`, 'bad'); }
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

// ── SYSTEM CONTROL helpers ────────────────────────────────────────────────────
function parseSysCtrlVersion(v) {
  const major = (v >>> 24) & 0xFF;
  const year  = (v >>> 16) & 0xFF;
  const month = (v >>> 12) & 0xF;
  const day   = (v >>>  4) & 0xFF;
  const minor =  v         & 0xF;
  const name  = major === 0x52 ? 'TSGW' : `0x${major.toString(16).toUpperCase().padStart(2,'0')}`;
  const yr    = ((year >> 4) & 0xF) * 10 + (year & 0xF);
  const dy    = ((day  >> 4) & 0xF) * 10 + (day  & 0xF);
  return `${name}  20${String(yr).padStart(2,'0')}년 ${month}월 ${String(dy).padStart(2,'0')}일  v${minor}`;
}

function syncSysCtrlEnable(v) {
  const ports = (v >>> 8) & 0xFF;
  if ($('rv-en-tsgw')) $('rv-en-tsgw').checked = (v & 1) !== 0;
  for (let i = 0; i < 8; i++) {
    const el = $(`rv-en-p${i}`);
    if (el) el.checked = (ports & (1 << i)) !== 0;
  }
}

function buildSysCtrlEnable() {
  let ports = 0;
  for (let i = 0; i < 8; i++) { if ($(`rv-en-p${i}`)?.checked) ports |= (1 << i); }
  return (($('rv-en-tsgw')?.checked ? 1 : 0) | (ports << 8)) >>> 0;
}

function syncHostIf(v) {
  if ($('rv-ahb-wr')) $('rv-ahb-wr').value = v & 0xF;
  if ($('rv-ahb-rd')) $('rv-ahb-rd').value = (v >>> 4) & 0xF;
}

function buildHostIf() {
  const wr = Math.max(0, Math.min(15, parseInt($('rv-ahb-wr')?.value || '0')));
  const rd = Math.max(0, Math.min(15, parseInt($('rv-ahb-rd')?.value || '0')));
  return ((rd << 4) | wr) >>> 0;
}

// ── FDB register helpers ──────────────────────────────────────────────────────
const FDB_OFF = {
  VERSION:    0xA00, FDB_LOAD:   0xA04, ENABLE:     0xA0C,
  AGE_PERIOD: 0xA10, AGING_THR:  0xA14, MCU_MAC0:   0xA18,
  MCU_MAC1:   0xA1C, MCU_VLAN:   0xA20, MCU_PORT:   0xA24,
  MCU_BUCKET: 0xA28, MCU_CMD:    0xA2C, FDB_STATUS: 0xA40,
  CMD_STATUS: 0xA44, RD_BUCKET:  0xA48, RD_PORT:    0xA4C,
  RD_FLAGS:   0xA50, RD_MAC0:    0xA54, RD_MAC1:    0xA58, RD_MAC2:    0xA5C,
};
const FDB_CMD = { HASH_READ: 0x12, READ_BUCKET: 0x13, HASH_WRITE: 0x14, WRITE_BUCKET: 0x15, HASH_DELETE: 0x16, FLUSH_ALL: 0x70 };

function parseRegD(d) {
  const raw = d.value || `0x${((d.valueDec||0)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
  return parseInt(raw, 16) >>> 0;
}

async function fdbReg(off) {
  const hex = `0x${off.toString(16).toUpperCase().padStart(3,'0')}`;
  const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset: hex }) });
  return parseRegD(d);
}

async function fdbWr(off, val) {
  const offset = `0x${off.toString(16).toUpperCase().padStart(3,'0')}`;
  const value  = `0x${(val >>> 0).toString(16).toUpperCase().padStart(8,'0')}`;
  await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset, value }) });
}

async function fdbPoll(off, mask, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 500);
  while (Date.now() < deadline) {
    if ((await fdbReg(off) & mask) !== 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Poll timeout off=0x${off.toString(16)}`);
}

function fdbEncodeMac(mac) {
  const b = mac.split(':').map(s => parseInt(s, 16));
  return {
    mac0: ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0,
    mac1: ((b[0] <<  8) | b[1]) >>> 0,
  };
}

function fdbDecodeMac(hi16, mid16, lo16) {
  return [
    (hi16 >> 8)&0xFF, hi16&0xFF,
    (mid16>>8)&0xFF, mid16&0xFF,
    (lo16>>8)&0xFF, lo16&0xFF,
  ].map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(':');
}

function fdbInputs() {
  const mac    = $('rv-fdb-mac')?.value.trim() || '00:00:00:00:00:00';
  const vlanId = parseInt($('rv-fdb-vlan')?.value || '0') & 0xFFF;
  const vlanV  = !!$('rv-fdb-vlan-valid')?.checked;
  const port   = parseInt($('rv-fdb-port')?.value || '0') & 0x1FF;
  const bktStr = ($('rv-fdb-bucket')?.value || '0').trim();
  const sltStr = ($('rv-fdb-slot')?.value || '0x1').trim();
  const bucket = parseInt(bktStr) & 0x3FF;
  const slot   = parseInt(sltStr) & 0xF || 1;
  return { mac, vlanId, vlanV, port, bucket, slot };
}

function fdbAddRow(row) {
  const tbody = $('rv-fdb-tbody');
  if (!tbody) return;
  if (tbody.querySelector('[colspan]')) tbody.innerHTML = '';
  const tr = document.createElement('tr');
  const mac = row.mac || '-';
  tr.innerHTML = `<td>${row.bucket??'-'}</td><td>${row.slot??'-'}</td>`
    + `<td class="mono">${mac}</td><td>${row.port??'-'}</td>`
    + `<td>${row.status??'-'}</td><td>${row.ts??'-'}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
}

function fdbClearRows() {
  const tbody = $('rv-fdb-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);">No results yet</td></tr>';
}

async function fdbReadByHash() {
  const { mac, vlanId, vlanV } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', '읽는 중...', false);
  try {
    const { mac0, mac1 } = fdbEncodeMac(mac);
    await fdbWr(FDB_OFF.MCU_MAC0, mac0);
    await fdbWr(FDB_OFF.MCU_MAC1, mac1);
    await fdbWr(FDB_OFF.MCU_VLAN, (vlanV ? 0x1000 : 0) | vlanId);
    await fdbWr(FDB_OFF.MCU_CMD,  FDB_CMD.HASH_READ);
    await fdbPoll(FDB_OFF.CMD_STATUS, 0x1, 500);
    const flags = await fdbReg(FDB_OFF.RD_FLAGS);
    fdbClearRows();
    if ((flags & 0x8000) === 0) {
      fdbAddRow({ mac, port:'-', bucket:'-', slot:'-', ts:'-', status:'없음 (미학습)' });
      setRegStatus('rv-st-fdb-cmd', '미학습 (테이블에 없음)', false);
    } else {
      const rdPort   = await fdbReg(FDB_OFF.RD_PORT);
      const rdBucket = await fdbReg(FDB_OFF.RD_BUCKET);
      fdbAddRow({
        mac, port: rdPort & 0x1FF, bucket: rdBucket & 0x3FF,
        slot: `0x${((rdBucket>>12)&0xF).toString(16)}`,
        ts: flags & 0x3FFF, status: (flags & 0x4000) ? 'Static' : 'Dynamic',
      });
      setRegStatus('rv-st-fdb-cmd', '엔트리 발견', true);
    }
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `오류: ${err.message}`, false); }
}

async function fdbReadByBucket() {
  const { bucket, slot } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', '읽는 중...', false);
  try {
    await fdbWr(FDB_OFF.MCU_BUCKET, ((slot & 0xF) << 16) | (bucket & 0x3FF));
    await fdbWr(FDB_OFF.MCU_CMD,    FDB_CMD.READ_BUCKET);
    await fdbPoll(FDB_OFF.CMD_STATUS, 0x1, 500);
    const flags = await fdbReg(FDB_OFF.RD_FLAGS);
    fdbClearRows();
    if ((flags & 0x8000) === 0) {
      fdbAddRow({ bucket, slot:`0x${slot.toString(16)}`, mac:'-', port:'-', ts:'-', status:'없음' });
      setRegStatus('rv-st-fdb-cmd', '슬롯 비어있음', false);
    } else {
      const mac0 = await fdbReg(FDB_OFF.RD_MAC0);
      const mac1 = await fdbReg(FDB_OFF.RD_MAC1);
      const mac2 = await fdbReg(FDB_OFF.RD_MAC2);
      const rdPort = await fdbReg(FDB_OFF.RD_PORT);
      fdbAddRow({
        bucket, slot:`0x${slot.toString(16)}`,
        mac: fdbDecodeMac(mac2 & 0xFFFF, mac1 & 0xFFFF, mac0 & 0xFFFF),
        port: rdPort & 0x1FF, ts: flags & 0x3FFF,
        status: (flags & 0x4000) ? 'Static' : 'Dynamic',
      });
      setRegStatus('rv-st-fdb-cmd', '엔트리 발견', true);
    }
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `오류: ${err.message}`, false); }
}

async function fdbWriteByHash() {
  const { mac, vlanId, vlanV, port } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', '쓰는 중...', false);
  try {
    const { mac0, mac1 } = fdbEncodeMac(mac);
    await fdbWr(FDB_OFF.MCU_MAC0, mac0);
    await fdbWr(FDB_OFF.MCU_MAC1, mac1);
    await fdbWr(FDB_OFF.MCU_VLAN, (vlanV ? 0x1000 : 0) | vlanId);
    await fdbWr(FDB_OFF.MCU_PORT, port);
    await fdbWr(FDB_OFF.MCU_CMD,  FDB_CMD.HASH_WRITE);
    await fdbPoll(FDB_OFF.CMD_STATUS, 0x4, 500);
    setRegStatus('rv-st-fdb-cmd', '쓰기 완료', true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `오류: ${err.message}`, false); }
}

async function fdbWriteByBucket() {
  const { mac, vlanId, vlanV, port, bucket, slot } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', '쓰는 중...', false);
  try {
    const { mac0, mac1 } = fdbEncodeMac(mac);
    await fdbWr(FDB_OFF.MCU_MAC0,   mac0);
    await fdbWr(FDB_OFF.MCU_MAC1,   mac1);
    await fdbWr(FDB_OFF.MCU_VLAN,   (vlanV ? 0x1000 : 0) | vlanId);
    await fdbWr(FDB_OFF.MCU_PORT,   port);
    await fdbWr(FDB_OFF.MCU_BUCKET, ((slot & 0xF) << 16) | (bucket & 0x3FF));
    await fdbWr(FDB_OFF.MCU_CMD,    FDB_CMD.WRITE_BUCKET);
    await fdbPoll(FDB_OFF.CMD_STATUS, 0x4, 500);
    setRegStatus('rv-st-fdb-cmd', `쓰기 완료  Bkt:${bucket}  Slot:0x${slot.toString(16)}`, true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `오류: ${err.message}`, false); }
}

async function fdbDeleteByHash() {
  const { mac, vlanId, vlanV } = fdbInputs();
  if (!confirm(`Delete FDB entry for ${mac}?`)) return;
  setRegStatus('rv-st-fdb-cmd', '삭제 중...', false);
  try {
    const { mac0, mac1 } = fdbEncodeMac(mac);
    await fdbWr(FDB_OFF.MCU_MAC0, mac0);
    await fdbWr(FDB_OFF.MCU_MAC1, mac1);
    await fdbWr(FDB_OFF.MCU_VLAN, (vlanV ? 0x1000 : 0) | vlanId);
    await fdbWr(FDB_OFF.MCU_CMD,  FDB_CMD.HASH_DELETE);
    await fdbPoll(FDB_OFF.CMD_STATUS, 0x4, 500);
    fdbClearRows();
    setRegStatus('rv-st-fdb-cmd', `삭제 완료 (${mac})`, true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `오류: ${err.message}`, false); }
}

async function fdbInitAll() {
  if (!confirm('Init all FDB tables? (Flush All)')) return;
  setRegStatus('rv-st-fdb-cmd', '전체 초기화 중...', false);
  try {
    await fdbWr(FDB_OFF.MCU_CMD, FDB_CMD.FLUSH_ALL);
    await fdbPoll(FDB_OFF.FDB_STATUS, 0x1, 2000);
    fdbClearRows();
    setRegStatus('rv-st-fdb-cmd', '전체 초기화 완료', true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `오류: ${err.message}`, false); }
}

async function fdbCtrlReadConfig() {
  setRegStatus('rv-st-fdb-ctrl', '읽는 중...', false);
  try {
    const ver = await fdbReg(FDB_OFF.VERSION);
    if ($('rv-fdb-ver')) $('rv-fdb-ver').value = `0x${ver.toString(16).toUpperCase().padStart(8,'0')}`;
    const en = await fdbReg(FDB_OFF.ENABLE);
    if ($('rv-fdb-age-scan')) $('rv-fdb-age-scan').checked = (en & (1<<4)) !== 0;
    if ($('rv-fdb-learning')) $('rv-fdb-learning').checked = (en & (1<<1)) !== 0;
    if ($('rv-fdb-lookup'))   $('rv-fdb-lookup').checked   = (en & 1) !== 0;
    const ap = await fdbReg(FDB_OFF.AGE_PERIOD);
    const at = await fdbReg(FDB_OFF.AGING_THR);
    if ($('rv-fdb-age-period')) $('rv-fdb-age-period').value = ap;
    if ($('rv-fdb-aging-thr'))  $('rv-fdb-aging-thr').value  = at;
    setRegStatus('rv-st-fdb-ctrl', '읽기 완료', true);
  } catch(err) { setRegStatus('rv-st-fdb-ctrl', `오류: ${err.message}`, false); }
}

async function fdbCtrlApplyEnable() {
  let en = 0;
  if ($('rv-fdb-age-scan')?.checked) en |= (1<<4);
  if ($('rv-fdb-learning')?.checked) en |= (1<<1);
  if ($('rv-fdb-lookup')?.checked)   en |= 1;
  setRegStatus('rv-st-fdb-ctrl', '적용 중...', false);
  try {
    await fdbWr(FDB_OFF.ENABLE, en);
    setRegStatus('rv-st-fdb-ctrl', 'ENABLE 적용 완료', true);
  } catch(err) { setRegStatus('rv-st-fdb-ctrl', `오류: ${err.message}`, false); }
}

async function fdbCtrlLoadDefault() {
  setRegStatus('rv-st-fdb-ctrl', 'Default Load 중...', false);
  try {
    await fdbWr(FDB_OFF.FDB_LOAD, 1);
    setRegStatus('rv-st-fdb-ctrl', 'Default Load 완료', true);
  } catch(err) { setRegStatus('rv-st-fdb-ctrl', `오류: ${err.message}`, false); }
}

// ── INTERRUPT ─────────────────────────────────────────────────────────────────
let _intrPollTimer = null;

function initIntrDots() {
  const portDiv = $('rv-intr-port-dots');
  const mdioDiv = $('rv-intr-mdio-dots');
  const pmDiv   = $('rv-intr-port-mask');
  const mmDiv   = $('rv-intr-mdio-mask');
  if (portDiv && !portDiv.children.length) {
    for (let i = 0; i < 16; i++) {
      portDiv.insertAdjacentHTML('beforeend',
        `<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;" title="PORT${i}"><span id="rv-intr-p${i}" class="led-dot"></span>P${i}</span>`);
    }
  }
  if (mdioDiv && !mdioDiv.children.length) {
    for (let i = 0; i < 8; i++) {
      mdioDiv.insertAdjacentHTML('beforeend',
        `<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;"><span id="rv-intr-m${i}" class="led-dot"></span>M${i}</span>`);
    }
  }
  if (pmDiv && !pmDiv.children.length) {
    for (let i = 0; i < 16; i++) {
      pmDiv.insertAdjacentHTML('beforeend',
        `<label class="rv-chk" title="PORT${i} mask"><input id="rv-intr-pm${i}" type="checkbox"><span>P${i}</span></label>`);
    }
  }
  if (mmDiv && !mmDiv.children.length) {
    for (let i = 0; i < 8; i++) {
      mmDiv.insertAdjacentHTML('beforeend',
        `<label class="rv-chk"><input id="rv-intr-mm${i}" type="checkbox"><span>M${i}</span></label>`);
    }
  }
}

async function intrCtrlRead() {
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x010' }) });
    const v = parseRegD(d);
    const low = (v & 1) !== 0;
    const actHigh = $('rv-intr-act-high'); const actLow = $('rv-intr-act-low');
    if (actHigh) actHigh.checked = !low;
    if (actLow)  actLow.checked  = low;
    setRegStatus('rv-st-intr-ctrl', `OK — Active ${low ? 'Low' : 'High'}`, true);
  } catch(err) { setRegStatus('rv-st-intr-ctrl', `오류: ${err.message}`, false); }
}

async function intrCtrlApply() {
  const low = $('rv-intr-act-low')?.checked ? 1 : 0;
  await rvWrite('0x010', `0x${low.toString(16).padStart(8,'0')}`, 'rv-st-intr-ctrl');
}

async function intrRawRead() {
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x014' }) });
    const v = parseRegD(d);
    for (let i = 0; i < 16; i++) {
      const dot = $(`rv-intr-p${i}`);
      if (dot) dot.classList.toggle('connected', ((v >> i) & 1) !== 0);
    }
    for (let i = 0; i < 8; i++) {
      const dot = $(`rv-intr-m${i}`);
      if (dot) dot.classList.toggle('connected', ((v >> (16+i)) & 1) !== 0);
    }
    const swDot = $('rv-intr-sw-dot');
    if (swDot) swDot.classList.toggle('connected', ((v >>> 31) & 1) !== 0);
    setRegStatus('rv-st-intr-raw', `0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`, true);
  } catch(err) { setRegStatus('rv-st-intr-raw', `오류: ${err.message}`, false); }
}

function intrTogglePoll() {
  const btn = $('rv-intr-raw-poll');
  if (_intrPollTimer) {
    clearInterval(_intrPollTimer); _intrPollTimer = null;
    if (btn) { btn.textContent = '▶ Poll'; btn.className = 'small'; }
  } else {
    _intrPollTimer = setInterval(intrRawRead, 500);
    if (btn) { btn.textContent = '■ Stop'; btn.className = 'small danger'; }
    intrRawRead();
  }
}

async function intrMaskRead() {
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x018' }) });
    const v = parseRegD(d);
    for (let i = 0; i < 16; i++) { const c = $(`rv-intr-pm${i}`); if (c) c.checked = ((v>>i)&1)!==0; }
    for (let i = 0; i < 8;  i++) { const c = $(`rv-intr-mm${i}`); if (c) c.checked = ((v>>(16+i))&1)!==0; }
    const sw = $('rv-intr-sw-mask'); if (sw) sw.checked = ((v>>>31)&1) !== 0;
    setRegStatus('rv-st-intr-mask', 'OK', true);
  } catch(err) { setRegStatus('rv-st-intr-mask', `오류: ${err.message}`, false); }
}

async function intrMaskApply() {
  let v = 0;
  for (let i = 0; i < 16; i++) { if ($(`rv-intr-pm${i}`)?.checked) v |= (1 << i); }
  for (let i = 0; i < 8;  i++) { if ($(`rv-intr-mm${i}`)?.checked) v |= (1 << (16+i)); }
  if ($('rv-intr-sw-mask')?.checked) v |= 0x80000000;
  await rvWrite('0x018', `0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`, 'rv-st-intr-mask');
}

async function intrSwTrigger() {
  setRegStatus('rv-st-intr-sw', '트리거 발생 중...', true);
  try {
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x01C', value:'0x00000001' }) });
    setRegStatus('rv-st-intr-sw', 'SW Trigger 완료', true);
    const btn = $('rv-intr-sw-trigger');
    if (btn) { btn.className = 'small primary'; setTimeout(() => { btn.className = 'small danger'; }, 600); }
  } catch(err) { setRegStatus('rv-st-intr-sw', `오류: ${err.message}`, false); }
}

// ── TIMESTAMP ─────────────────────────────────────────────────────────────────
async function tsReadTime() {
  setRegStatus('rv-st-ts', '읽는 중...', true);
  try {
    const dNs    = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x020' }) });
    const dSecLo = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x024' }) });
    const dSecHi = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x028' }) });
    const ns    = parseRegD(dNs);
    const secLo = parseRegD(dSecLo);
    const secHi = parseRegD(dSecHi);
    const sec   = BigInt(secHi & 0xFFFF) * 4294967296n + BigInt(secLo >>> 0);
    const dt    = new Date(Number(sec) * 1000);
    const cur   = `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}  ` +
                  `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}.` +
                  `${String(ns).padStart(9,'0')} ns`;
    if ($('rv-ts-current')) $('rv-ts-current').value = cur;
    setRegStatus('rv-st-ts', 'OK', true);
  } catch(err) { setRegStatus('rv-st-ts', `오류: ${err.message}`, false); }
}

function tsSetNow() {
  const now = new Date();
  if ($('rv-ts-year'))  $('rv-ts-year').value  = now.getFullYear();
  if ($('rv-ts-month')) $('rv-ts-month').value = now.getMonth()+1;
  if ($('rv-ts-day'))   $('rv-ts-day').value   = now.getDate();
  if ($('rv-ts-hour'))  $('rv-ts-hour').value  = now.getHours();
  if ($('rv-ts-min'))   $('rv-ts-min').value   = now.getMinutes();
  if ($('rv-ts-sec'))   $('rv-ts-sec').value   = now.getSeconds();
  if ($('rv-ts-set-ns')) $('rv-ts-set-ns').value = 0;
}

async function tsSetTime() {
  setRegStatus('rv-st-ts', '설정 중...', true);
  try {
    const yr = parseInt($('rv-ts-year')?.value  || '2025');
    const mo = parseInt($('rv-ts-month')?.value || '1');
    const dy = parseInt($('rv-ts-day')?.value   || '1');
    const hr = parseInt($('rv-ts-hour')?.value  || '0');
    const mn = parseInt($('rv-ts-min')?.value   || '0');
    const sc = parseInt($('rv-ts-sec')?.value   || '0');
    const ns = parseInt($('rv-ts-set-ns')?.value || '0') >>> 0;
    const unixSec = BigInt(Math.floor(new Date(yr, mo-1, dy, hr, mn, sc).getTime() / 1000));
    const secLo   = Number(unixSec & 0xFFFFFFFFn) >>> 0;
    const secHi   = Number((unixSec >> 32n) & 0xFFFFn) >>> 0;
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x020', value:`0x${ns.toString(16).padStart(8,'0')}` }) });
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x024', value:`0x${secLo.toString(16).padStart(8,'0')}` }) });
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x028', value:`0x${secHi.toString(16).padStart(8,'0')}` }) });
    setRegStatus('rv-st-ts', '시간 설정 완료', true);
  } catch(err) { setRegStatus('rv-st-ts', `오류: ${err.message}`, false); }
}

async function tsReadClock() {
  setRegStatus('rv-st-ts-clk', '읽는 중...', true);
  try {
    const dA  = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x02C' }) });
    const dC1 = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x030' }) });
    const addend    = parseRegD(dA);
    const ctrl1     = parseRegD(dC1);
    const increment = ctrl1 & 0xFFFF;
    const scaled    = increment + addend / 4294967296.0;
    const nsPerTick = scaled * 1e9 / 4294967296.0;
    const mhz       = nsPerTick > 0 ? Math.round(1000.0 / nsPerTick * 1e6) / 1e6 : 0;
    if ($('rv-ts-clk-mhz')) $('rv-ts-clk-mhz').value = mhz;
    setRegStatus('rv-st-ts-clk', `INCREMENT=${increment}  ADDEND=0x${addend.toString(16).toUpperCase().padStart(8,'0')}`, true);
  } catch(err) { setRegStatus('rv-st-ts-clk', `오류: ${err.message}`, false); }
}

async function tsApplyClock() {
  const mhz = parseFloat($('rv-ts-clk-mhz')?.value || '200');
  if (!mhz) { setRegStatus('rv-st-ts-clk', 'MHz 값 오류', false); return; }
  setRegStatus('rv-st-ts-clk', '설정 중...', true);
  try {
    const periodNs  = 1000.0 / mhz;
    const exactIncr = periodNs * 4294967296.0 / 1e9;
    const increment = Math.floor(exactIncr) >>> 0;
    const addend    = Math.round((exactIncr - increment) * 4294967296.0) >>> 0;
    const dC1 = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x030' }) });
    let ctrl1 = parseRegD(dC1) & 0xFFFF0000;
    ctrl1 |= (increment & 0xFFFF);
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x02C', value:`0x${addend.toString(16).padStart(8,'0')}` }) });
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x030', value:`0x${ctrl1.toString(16).padStart(8,'0')}` }) });
    setRegStatus('rv-st-ts-clk', `완료 INCREMENT=${increment}  ADDEND=0x${addend.toString(16).toUpperCase().padStart(8,'0')}`, true);
  } catch(err) { setRegStatus('rv-st-ts-clk', `오류: ${err.message}`, false); }
}

async function tsReadPps() {
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x030' }) });
    const v = parseRegD(d);
    const src = (v >> 16) & 0x3;
    const wid = ((v >> 24) & 0xFF) * 2;
    document.querySelectorAll('input[name="ts-pps-src"]').forEach(r => { r.checked = parseInt(r.value) === (src >= 2 ? 2 : src); });
    if ($('rv-ts-pps-width')) $('rv-ts-pps-width').value = wid;
    const srcLabel = ['Disable','Internal','GPS'][src] || 'GPS';
    setRegStatus('rv-st-ts-clk', `PPS: ${srcLabel}  width=${wid}ms`, true);
  } catch(err) { setRegStatus('rv-st-ts-clk', `PPS 읽기 오류: ${err.message}`, false); }
}

async function tsApplyPps() {
  try {
    const src = parseInt(document.querySelector('input[name="ts-pps-src"]:checked')?.value || '1');
    const wid = parseInt($('rv-ts-pps-width')?.value || '100');
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x030' }) });
    let v = parseRegD(d) & ~0xFF030000;
    v |= (src & 0x3) << 16;
    v |= ((Math.floor(wid / 2) & 0xFF) << 24);
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x030', value:`0x${v.toString(16).padStart(8,'0')}` }) });
    setRegStatus('rv-st-ts-clk', 'PPS 설정 완료', true);
  } catch(err) { setRegStatus('rv-st-ts-clk', `오류: ${err.message}`, false); }
}

async function tsAdjNs(inc) {
  const ms  = parseInt($('rv-ts-ns-adj')?.value || '0');
  const nsV = (Math.abs(ms) * 1000000) >>> 0;
  const v   = (nsV & 0x3FFFFFFF) | (inc ? 0x40000000 : 0x80000000);
  await rvWrite('0x034', `0x${v.toString(16).padStart(8,'0')}`, 'rv-st-ts-adj');
}

async function tsAdjSec(inc) {
  const s = parseInt($('rv-ts-sec-adj')?.value || '0');
  const v = (Math.abs(s) & 0x3FFFFFFF) | (inc ? 0x40000000 : 0x80000000);
  await rvWrite('0x038', `0x${v.toString(16).padStart(8,'0')}`, 'rv-st-ts-adj');
}

// ── LED / CLOCK ───────────────────────────────────────────────────────────────
const LED_FPGA_LABELS = ['System CLK Blink(400M)','AHB CLK Blink(400M)','RGMII CLK Blink(125M)','Reset_n','EXT_SW[0]','EXT_SW[1]','EXT_SW[2]','EXT_SW[3]'];

function initLedDots() {
  const fpgaDiv = $('rv-led-fpga-dots');
  const regDiv  = $('rv-led-reg-chks');
  const swDiv   = $('rv-ext-sw-dots');
  if (fpgaDiv && !fpgaDiv.children.length) {
    LED_FPGA_LABELS.forEach((lbl, i) =>
      fpgaDiv.insertAdjacentHTML('beforeend',
        `<div style="display:flex;align-items:center;gap:4px;font-size:11px;margin:1px 0;"><span id="rv-led-fpga-${i}" class="led-dot"></span>${esc(lbl)}</div>`)
    );
  }
  if (regDiv && !regDiv.children.length) {
    for (let i = 0; i < 8; i++)
      regDiv.insertAdjacentHTML('beforeend',
        `<label class="rv-chk"><input id="rv-led-rb-${i}" type="checkbox"><span>LED${i}</span></label>`);
  }
  if (swDiv && !swDiv.children.length) {
    for (let i = 0; i < 6; i++)
      swDiv.insertAdjacentHTML('beforeend',
        `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;"><span id="rv-ext-sw-${i}" class="led-dot"></span>SW${i}</span>`);
  }
}

function ledModeChanged() {
  const mode = parseInt(document.querySelector('input[name="led-mode"]:checked')?.value ?? '1');
  const fpgaDiv  = $('rv-led-fpga-dots');
  const regDiv   = $('rv-led-reg-chks');
  const cpuWarn  = $('rv-led-cpu-warn');
  const applyReg = $('rv-led-apply-reg');
  if (fpgaDiv)  fpgaDiv.style.display  = mode === 1 ? '' : 'none';
  if (regDiv)   regDiv.style.display   = mode === 3 ? '' : 'none';
  if (cpuWarn)  cpuWarn.style.display  = mode === 0 ? '' : 'none';
  if (applyReg) applyReg.style.display = mode === 3 ? '' : 'none';
}

async function ledRead() {
  setRegStatus('rv-st-led', '읽는 중...', true);
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x060' }) });
    const v = parseRegD(d);
    const mode = (v >> 8) & 0x3;
    const leds = v & 0xFF;
    document.querySelectorAll('input[name="led-mode"]').forEach(r => { r.checked = parseInt(r.value) === mode; });
    for (let i = 0; i < 8; i++) {
      const on = ((leds >> i) & 1) !== 0;
      const fpgaDot = $(`rv-led-fpga-${i}`); if (fpgaDot) fpgaDot.classList.toggle('connected', on);
      const regChk  = $(`rv-led-rb-${i}`);   if (regChk)  regChk.checked = on;
    }
    ledModeChanged();
    setRegStatus('rv-st-led', `OK — mode=${mode}  leds=0x${leds.toString(16).padStart(2,'0').toUpperCase()}`, true);
  } catch(err) { setRegStatus('rv-st-led', `오류: ${err.message}`, false); }
}

async function ledApplyMode() {
  const mode = parseInt(document.querySelector('input[name="led-mode"]:checked')?.value ?? '1');
  setRegStatus('rv-st-led', '설정 중...', true);
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x060' }) });
    let v = parseRegD(d) & ~0x300;
    v |= (mode << 8);
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x060', value:`0x${v.toString(16).padStart(8,'0')}` }) });
    ledModeChanged();
    setRegStatus('rv-st-led', 'LED 모드 설정 완료', true);
  } catch(err) { setRegStatus('rv-st-led', `오류: ${err.message}`, false); }
}

async function ledApplyReg() {
  let leds = 0;
  for (let i = 0; i < 8; i++) { if ($(`rv-led-rb-${i}`)?.checked) leds |= (1 << i); }
  setRegStatus('rv-st-led', '설정 중...', true);
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x060' }) });
    let v = parseRegD(d) & ~0xFF;
    v |= leds;
    await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset:'0x060', value:`0x${v.toString(16).padStart(8,'0')}` }) });
    setRegStatus('rv-st-led', 'LED 출력 설정 완료', true);
  } catch(err) { setRegStatus('rv-st-led', `오류: ${err.message}`, false); }
}

async function extSwRead() {
  try {
    const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x064' }) });
    const v = parseRegD(d);
    for (let i = 0; i < 6; i++) {
      const dot = $(`rv-ext-sw-${i}`);
      if (dot) dot.classList.toggle('connected', ((v >> i) & 1) !== 0);
    }
    setRegStatus('rv-st-ext-sw', `0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`, true);
  } catch(err) { setRegStatus('rv-st-ext-sw', `오류: ${err.message}`, false); }
}

function clkLimitToMhz(limit) { return limit > 0 ? Math.round(limit * 2 / 1e6 * 1e6) / 1e6 : 0; }
function clkMhzToLimit(mhz)   { return Math.round(mhz * 1e6 / 2) >>> 0; }

async function clkRead() {
  setRegStatus('rv-st-clk-limit', '읽는 중...', true);
  try {
    const [d0, d1, dr] = await Promise.all([
      api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x068' }) }),
      api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x06C' }) }),
      api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x0D0' }) }),
    ]);
    if ($('rv-clk-sys'))   $('rv-clk-sys').value   = clkLimitToMhz(parseRegD(d0));
    if ($('rv-clk-ahb'))   $('rv-clk-ahb').value   = clkLimitToMhz(parseRegD(d1));
    if ($('rv-clk-rgmii')) $('rv-clk-rgmii').value = clkLimitToMhz(parseRegD(dr));
    setRegStatus('rv-st-clk-limit', 'OK', true);
  } catch(err) { setRegStatus('rv-st-clk-limit', `오류: ${err.message}`, false); }
}

async function clkApply(offset, inputId) {
  const mhz = parseFloat($(inputId)?.value || '0');
  await rvWrite(offset, `0x${clkMhzToLimit(mhz).toString(16).padStart(8,'0')}`, 'rv-st-clk-limit');
}

// ── COUNT Viewer ──────────────────────────────────────────────────────────────
async function countRead() {
  const port = $('rv-count-port')?.value || 'all';
  setRegStatus('rv-st-count', '읽는 중...', true);
  try {
    const data = await api(`/api/counter/read?port=${encodeURIComponent(port)}`);
    const tbody = $('rv-count-tbody');
    if (!tbody) return;
    if (!data.counters || data.counters.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);">데이터 없음 — serial 연결 확인</td></tr>';
      setRegStatus('rv-st-count', '데이터 없음', false);
      return;
    }
    tbody.innerHTML = data.counters.map(c =>
      `<tr><td>${esc(c.name)}</td><td class="mono" style="font-size:11px;">${esc(c.address)}</td><td class="mono" style="font-size:11px;">${esc(c.value)}</td><td style="text-align:right;">${c.valueDec}</td></tr>`
    ).join('');
    setRegStatus('rv-st-count', `${data.counters.length}개  포트: ${port === 'all' ? 'ALL' : `Port ${port}`}`, true);
  } catch(err) { setRegStatus('rv-st-count', `오류: ${err.message}`, false); }
}

// ── MDIO ──────────────────────────────────────────────────────────────────────
const MDIO_PHY_ADDRS = [0x00, 0x04, 0x05, 0x08, 0x0A, 0x0C];

function mdioPortChanged() {
  const port = parseInt($('rv-mdio-port')?.value || '0');
  const phy  = MDIO_PHY_ADDRS[port] ?? 0;
  if ($('rv-mdio-phy-addr'))
    $('rv-mdio-phy-addr').value = `0x${phy.toString(16).toUpperCase().padStart(2,'0')}`;
}

function mdioCalcMdc() {
  const mhz = parseFloat($('rv-mdio-mhz')?.value || '2.5');
  if (isNaN(mhz) || mhz <= 0) { setRegStatus('rv-st-mdio', '주파수 형식 오류 (예: 2.5)', false); return; }
  const ahbMhz = 100.0;
  const clk  = Math.max(1, Math.min(255,  Math.round(ahbMhz / (2.0 * mhz))));
  const ms   = Math.max(1, Math.min(4095, Math.round(mhz * 1000.0)));
  if ($('rv-mdio-clk'))  $('rv-mdio-clk').value  = String(clk);
  if ($('rv-mdio-ms'))   $('rv-mdio-ms').value   = String(ms);
  if ($('rv-mdio-unit')) $('rv-mdio-unit').value  = '100';
  const actual = ahbMhz / (2.0 * clk);
  setRegStatus('rv-st-mdio', `f_MDC ≈ ${actual.toFixed(3)} MHz  (CLK=${clk}, MILLISEC=${ms})`, true);
}

async function mdioApplySetup() {
  const port       = parseInt($('rv-mdio-port')?.value || '0');
  const enable     = $('rv-mdio-en')?.checked    ?? false;
  const preDisable = $('rv-mdio-predis')?.checked ?? false;
  const intrEnable = $('rv-mdio-intr')?.checked  ?? false;
  const targetMhz  = parseFloat($('rv-mdio-mhz')?.value || '2.5');
  setRegStatus('rv-st-mdio', '적용 중...', true);
  try {
    const data = await api('/api/mdio/setup', { method:'POST',
      body: JSON.stringify({ port, enable, preDisable, interruptEnable: intrEnable, targetMhz }) });
    const setupHex = String(data.setup || '').replace(/^0x/i, '');
    const timeHex  = String(data.time  || '').replace(/^0x/i, '');
    setRegStatus('rv-st-mdio', `SETUP=0x${setupHex}  TIME=0x${timeHex}  CLK=${data.clk} MS=${data.ms}`, true);
  } catch(err) { setRegStatus('rv-st-mdio', `오류: ${err.message}`, false); }
}

async function mdioReadPhy() {
  const port    = parseInt($('rv-mdio-port')?.value || '0');
  const phyAddr = $('rv-mdio-phy-addr')?.value || '0x00';
  const regAddr = $('rv-mdio-reg-addr')?.value || '0x01';
  setRegStatus('rv-st-mdio-acc', '읽는 중...', true);
  try {
    const data = await api('/api/mdio/read', { method:'POST',
      body: JSON.stringify({ port, phyAddr, regAddr }) });
    if ($('rv-mdio-acc-data')) $('rv-mdio-acc-data').value = data.value || '0x0000';
    setRegStatus('rv-st-mdio-acc', `PHY[${phyAddr}] Reg[${regAddr}] = ${data.value}`, true);
  } catch(err) { setRegStatus('rv-st-mdio-acc', `오류: ${err.message}`, false); }
}

async function mdioWritePhy() {
  const port    = parseInt($('rv-mdio-port')?.value || '0');
  const phyAddr = $('rv-mdio-phy-addr')?.value || '0x00';
  const regAddr = $('rv-mdio-reg-addr')?.value || '0x01';
  const value   = $('rv-mdio-acc-data')?.value  || '0x0000';
  setRegStatus('rv-st-mdio-acc', '쓰는 중...', true);
  try {
    await api('/api/mdio/write', { method:'POST',
      body: JSON.stringify({ port, phyAddr, regAddr, value }) });
    setRegStatus('rv-st-mdio-acc', `PHY[${phyAddr}] Reg[${regAddr}] ← ${value}  완료`, true);
  } catch(err) { setRegStatus('rv-st-mdio-acc', `오류: ${err.message}`, false); }
}

async function mdioReadAllLink() {
  setRegStatus('rv-st-mdio-link', '읽는 중...', true);
  try {
    const data = await api('/api/mdio/link-status');
    if (data.ports) {
      data.ports.forEach(p => {
        const td = $(`rv-mdio-link-${p.port}`);
        if (!td) return;
        const linked = p.linkUp === true;
        const label  = p.linkUp === null ? '—' : (p.linkUp ? 'Link UP' : 'Link DOWN');
        td.innerHTML = `<span class="led-dot${linked ? ' connected' : ''}"></span> ${label}`;
      });
    }
    setRegStatus('rv-st-mdio-link', `갱신 완료  ${new Date().toLocaleTimeString()}`, true);
  } catch(err) { setRegStatus('rv-st-mdio-link', `오류: ${err.message}`, false); }
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

  // ── SYSTEM CONTROL ────────────────────────────────────────────────────────
  $('rv-ver-read')?.addEventListener('click', async () => {
    try {
      const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x000' }) });
      const raw = d.value || `0x${(d.valueDec||0).toString(16).toUpperCase().padStart(8,'0')}`;
      const v = parseInt(raw, 16) >>> 0;
      if ($('rv-ver-str')) $('rv-ver-str').value = parseSysCtrlVersion(v);
      setRegStatus('rv-st-version', 'OK', true);
    } catch(err) { setRegStatus('rv-st-version', `오류: ${err.message}`, false); }
  });
  $('rv-ver-default')?.addEventListener('click', async () => {
    await rvWrite('0x004', '0x00000001', 'rv-st-version');
  });

  $('rv-en-read')?.addEventListener('click', async () => {
    try {
      const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x008' }) });
      const raw = d.value || `0x${(d.valueDec||0).toString(16).toUpperCase().padStart(8,'0')}`;
      syncSysCtrlEnable(parseInt(raw, 16) >>> 0);
      setRegStatus('rv-st-enable', 'OK', true);
    } catch(err) { setRegStatus('rv-st-enable', `오류: ${err.message}`, false); }
  });
  $('rv-en-apply')?.addEventListener('click', async () => {
    const v = buildSysCtrlEnable();
    await rvWrite('0x008', `0x${v.toString(16).toUpperCase().padStart(8,'0')}`, 'rv-st-enable');
  });

  $('rv-ahb-read')?.addEventListener('click', async () => {
    try {
      const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset:'0x00C' }) });
      const raw = d.value || `0x${(d.valueDec||0).toString(16).toUpperCase().padStart(8,'0')}`;
      syncHostIf(parseInt(raw, 16) >>> 0);
      setRegStatus('rv-st-ahb', 'OK', true);
    } catch(err) { setRegStatus('rv-st-ahb', `오류: ${err.message}`, false); }
  });
  $('rv-ahb-apply')?.addEventListener('click', async () => {
    const v = buildHostIf();
    await rvWrite('0x00C', `0x${v.toString(16).toUpperCase().padStart(8,'0')}`, 'rv-st-ahb');
  });

  $('sysctlReadAll')?.addEventListener('click', () => {
    $('rv-ver-read')?.click();
    $('rv-en-read')?.click();
    $('rv-ahb-read')?.click();
  });

  // ── INTERRUPT ─────────────────────────────────────────────────────────────
  initIntrDots();
  $('interruptReadAll')?.addEventListener('click', () => Promise.allSettled([intrCtrlRead(), intrRawRead(), intrMaskRead()]));
  $('rv-intr-ctrl-read')?.addEventListener('click', intrCtrlRead);
  $('rv-intr-ctrl-apply')?.addEventListener('click', intrCtrlApply);
  $('rv-intr-raw-read')?.addEventListener('click', intrRawRead);
  $('rv-intr-raw-poll')?.addEventListener('click', intrTogglePoll);
  $('rv-intr-mask-read')?.addEventListener('click', intrMaskRead);
  $('rv-intr-mask-apply')?.addEventListener('click', intrMaskApply);
  $('rv-intr-sw-trigger')?.addEventListener('click', intrSwTrigger);

  // ── TIMESTAMP ─────────────────────────────────────────────────────────────
  $('timestampReadAll')?.addEventListener('click', () => Promise.allSettled([tsReadTime(), tsReadClock(), tsReadPps()]));
  $('rv-ts-read-time')?.addEventListener('click', tsReadTime);
  $('rv-ts-now')?.addEventListener('click', tsSetNow);
  $('rv-ts-set-time')?.addEventListener('click', tsSetTime);
  $('rv-ts-read-clock')?.addEventListener('click', tsReadClock);
  $('rv-ts-apply-clock')?.addEventListener('click', tsApplyClock);
  $('rv-ts-read-pps')?.addEventListener('click', tsReadPps);
  $('rv-ts-apply-pps')?.addEventListener('click', tsApplyPps);
  $('rv-ts-ns-inc')?.addEventListener('click', () => tsAdjNs(true));
  $('rv-ts-ns-dec')?.addEventListener('click', () => tsAdjNs(false));
  $('rv-ts-sec-inc')?.addEventListener('click', () => tsAdjSec(true));
  $('rv-ts-sec-dec')?.addEventListener('click', () => tsAdjSec(false));

  // ── LED / CLOCK ───────────────────────────────────────────────────────────
  initLedDots();
  document.querySelectorAll('input[name="led-mode"]').forEach(r => r.addEventListener('change', ledModeChanged));
  $('ledclockReadAll')?.addEventListener('click', () => Promise.allSettled([ledRead(), extSwRead(), clkRead()]));
  $('rv-led-read')?.addEventListener('click', ledRead);
  $('rv-led-apply-mode')?.addEventListener('click', ledApplyMode);
  $('rv-led-apply-reg')?.addEventListener('click', ledApplyReg);
  $('rv-ext-sw-read')?.addEventListener('click', extSwRead);
  $('rv-clk-read')?.addEventListener('click', clkRead);
  $('rv-clk-sys-apply')?.addEventListener('click', () => clkApply('0x068', 'rv-clk-sys'));
  $('rv-clk-ahb-apply')?.addEventListener('click', () => clkApply('0x06C', 'rv-clk-ahb'));
  $('rv-clk-rgmii-apply')?.addEventListener('click', () => clkApply('0x0D0', 'rv-clk-rgmii'));
  $('rv-clk-apply-all')?.addEventListener('click', () => Promise.allSettled([
    clkApply('0x068', 'rv-clk-sys'),
    clkApply('0x06C', 'rv-clk-ahb'),
    clkApply('0x0D0', 'rv-clk-rgmii'),
  ]));

  // ── TEST DATA ─────────────────────────────────────────────────────────────
  const TD_OFFSETS = ['0x040','0x044','0x048','0x04C','0x050','0x054','0x058','0x05C'];
  $('testdataReadAll')?.addEventListener('click', () =>
    Promise.allSettled(TD_OFFSETS.map((off, i) => rvRead(off, `rv-td-${i}`, `rv-st-td-${i}`)))
  );
  $('testdataWriteAll')?.addEventListener('click', () =>
    Promise.allSettled(TD_OFFSETS.map((off, i) => rvWrite(off, $(`rv-td-${i}`)?.value || '0x00000000', `rv-st-td-${i}`)))
  );

  $('rv-count-read')?.addEventListener('click', countRead);
  $('rv-count-clear')?.addEventListener('click', () => {
    const tbody = $('rv-count-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);">No data</td></tr>';
    setRegStatus('rv-st-count', '', true);
  });

  // ── MDIO ─────────────────────────────────────────────────────────────────
  $('rv-mdio-port')?.addEventListener('change', mdioPortChanged);
  $('rv-mdio-calc')?.addEventListener('click', mdioCalcMdc);
  $('rv-mdio-apply')?.addEventListener('click', mdioApplySetup);
  $('rv-mdio-read-phy')?.addEventListener('click', mdioReadPhy);
  $('rv-mdio-write-phy')?.addEventListener('click', mdioWritePhy);
  $('rv-mdio-read-link')?.addEventListener('click', mdioReadAllLink);

  // BASE ADDR editable — applies in native mode
  $('regBaseAddr')?.addEventListener('keydown', async function(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = this.value.trim();
    if (!val) return;
    try { await api('/api/register/base-addr', { method:'POST', body: JSON.stringify({ address: val }) }); } catch { /* worker mode: read-only */ }
    await refreshRegStatus();
  });
  $('regBaseAddr')?.addEventListener('blur', async function() {
    const val = this.value.trim();
    if (!val) return;
    try { await api('/api/register/base-addr', { method:'POST', body: JSON.stringify({ address: val }) }); } catch { /* worker mode: read-only */ }
  });

  // ── FDB ──────────────────────────────────────────────────────────────────
  $('rv-fdb-port-mac')?.addEventListener('change', e => {
    const val = e.target.value;
    if (!val) return;
    const [portIdx, mac] = val.split('|');
    if ($('rv-fdb-mac'))  $('rv-fdb-mac').value  = mac;
    if ($('rv-fdb-port')) $('rv-fdb-port').value = portIdx;
  });

  $('rv-fdb-read-config')?.addEventListener('click', fdbCtrlReadConfig);
  $('fdbReadConfig')?.addEventListener('click', fdbCtrlReadConfig);
  $('rv-fdb-apply-en')?.addEventListener('click', fdbCtrlApplyEnable);
  $('rv-fdb-load-default')?.addEventListener('click', fdbCtrlLoadDefault);

  $('rv-fdb-rdhash')?.addEventListener('click',   fdbReadByHash);
  $('rv-fdb-rdbucket')?.addEventListener('click', fdbReadByBucket);
  $('rv-fdb-wrhash')?.addEventListener('click',   fdbWriteByHash);
  $('rv-fdb-wrbucket')?.addEventListener('click', fdbWriteByBucket);
  $('rv-fdb-delete')?.addEventListener('click',   fdbDeleteByHash);
  $('rv-fdb-initall')?.addEventListener('click',  fdbInitAll);
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
  updateStatusBar();
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
  const brk = $('serialBreak');
  if (brk) brk.disabled = !connected;
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
let _ttySession    = null;
function startTtyStream(session) {
  _ttySession = session;
  if (_ttyStreamCtrl) { _ttyStreamCtrl.abort(); }
  _ttyStreamCtrl = new AbortController();
  const ctrl = _ttyStreamCtrl;
  const url  = `/api/tty/stream${session ? `?session=${encodeURIComponent(session)}` : ''}`;
  let buf = '';
  let retries = 0;

  function connect() {
    if (ctrl.signal.aborted) return;
    buf = '';
    fetch(url, { signal: ctrl.signal })
      .then(r => {
        retries = 0;
        const reader  = r.body.getReader();
        const decoder = new TextDecoder();
        function read() {
          reader.read().then(({ done, value }) => {
            if (ctrl.signal.aborted) return;
            if (done) {
              if (retries < 5) { retries++; setTimeout(connect, 1500); }
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split('\n');
            buf = parts.pop() ?? '';
            for (const part of parts) {
              const s = part.trim();
              if (!s) continue;
              try {
                const msg = JSON.parse(s);
                if (msg.type === 'rx' && msg.hex) {
                  const bytes = Uint8Array.from(msg.hex.match(/.{1,2}/g) || [], b => parseInt(b, 16));
                  const text  = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                  const lines = text.split(/\r?\n/);
                  // last element may be partial line — only emit complete lines
                  for (let i = 0; i < lines.length - 1; i++) {
                    if (lines[i]) appendHyperTerm(lines[i]);
                  }
                  if (lines[lines.length - 1]) appendHyperTerm(lines[lines.length - 1]);
                } else if (msg.type === 'closed') {
                  updateSerialUI(false, 'disconnected');
                  stopTtyStream();
                } else if (msg.type === 'error') {
                  appendHyperTerm(`[ERR] ${msg.message}`);
                }
              } catch { /* ignore json parse errors */ }
            }
            read();
          }).catch(err => {
            if (ctrl.signal.aborted) return;
            if (retries < 5) { retries++; setTimeout(connect, 1500); }
          });
        }
        read();
      }).catch(err => {
        if (ctrl.signal.aborted) return;
        if (retries < 5) { retries++; setTimeout(connect, 2000); }
      });
  }
  connect();
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
    if (baudSel) {
      const cur = baudSel.value || String(t.selectedBaudRate || 115200);
      const rates = t.baudRates || [9600, 19200, 38400, 57600, 115200, 230400, 921600];
      if (!baudSel.options.length || (t.baudRates && baudSel.options.length !== rates.length)) {
        baudSel.innerHTML = rates.map(b => `<option value="${b}">${b}</option>`).join('');
      }
      baudSel.value = t.selectedBaudRate ? String(t.selectedBaudRate) : cur;
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
  const hexMode = $('serialHex')?.checked;
  try {
    let body, echo;
    if (hexMode) {
      const clean = inp.value.replace(/\s+/g, '');
      if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
        toast('잘못된 HEX 형식 (예: 0D0A)', 'warn'); return;
      }
      body = JSON.stringify({ hex: clean });
      echo = `> [HEX] ${clean}`;
    } else {
      body = JSON.stringify({ text: inp.value + '\r\n' });
      echo = `> ${inp.value}`;
    }
    await api('/api/serial/send', { method: 'POST', body });
    appendHyperTerm(echo);
    inp.value = '';
  } catch (err) { toast(`전송 실패: ${err.message}`, 'bad'); }
}

// ── Logs ──────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const data = await api('/api/logs');
    const box = $('logsBox');
    if (!box) return;
    const fmtEntry = (e, kind) => {
      if (e.error) return `[${kind}] parse error: ${e.file}\n`;
      const ts = e.startedAt || e.timestamp || e.createdAt || '';
      const name = e.name || e.testName || e.macroName || e.id || '?';
      const result = e.result || e.status || (e.passed != null ? (e.passed ? 'PASS' : 'FAIL') : '');
      return `${ts ? new Date(ts).toLocaleString() + '  ' : ''}[${kind}] ${name}  ${result}\n`;
    };
    const tests  = (data.tests  || []).map(e => fmtEntry(e, 'TEST'));
    const macros = (data.macros || []).map(e => fmtEntry(e, 'MACRO'));
    const all = [...tests, ...macros];
    box.textContent = all.length ? all.join('') : '(no logs yet)';
  } catch (err) { if ($('logsBox')) $('logsBox').textContent = `Log load failed: ${err.message}`; }
}

function downloadCaptureCsv() {
  if (!state.captureRows.length) { toast('No packets to export', 'bad'); return; }
  const hdr = 'No,Time,Interface,SrcMAC,DstMAC,Source,Destination,Protocol,Length,Info\n';
  const rows = state.captureRows.map(r =>
    [r.no, r.time, r.interfaceName, r.srcMac, r.dstMac, r.source, r.destination, r.protocol, r.length, r.info]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  const blob = new Blob([hdr + rows], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `capture_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function updateStatusBar() {
  const pkts = state.captureRows.length;
  const serial = state.serialConnected ? '● Serial' : '○ Serial';
  const cap = state.captureTimer ? `● Cap ${pkts}pkts` : `○ Cap ${pkts}pkts`;
  const sb = $('statusExtra');
  if (sb) sb.textContent = `${serial}   ${cap}`;
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

  // Packet Library
  $('pktTplSave')?.addEventListener('click', () => {
    const name = $('pktTplName')?.value.trim();
    if (!name) { toast('Enter a template name first', 'warn'); return; }
    const list = pktTplLoad();
    const existing = list.findIndex(t => t.name === name);
    const entry = { name, profile: buildProfile(), savedAt: new Date().toISOString() };
    if (existing >= 0) list[existing] = entry; else list.push(entry);
    pktTplSave(list);
    renderPktTemplates();
    if ($('pktTplName')) $('pktTplName').value = '';
    toast(`Saved: ${name}`, 'ok');
  });
  $('pktTplClearAll')?.addEventListener('click', () => {
    if (!confirm('Clear all saved packet templates?')) return;
    pktTplSave([]);
    renderPktTemplates();
  });
  renderPktTemplates();

  // Addr Map
  $('addrRefreshLocal')?.addEventListener('click', refreshAddrLocal);
  $('addrProbeBtn')?.addEventListener('click', probeAddrPeer);
  $('addrFillBtn')?.addEventListener('click', fillDstFromPeer);

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

  // Sequence run/clear/load buttons (dark theme)
  $('seqRun')?.addEventListener('click', runSequence);
  $('seqClear')?.addEventListener('click', clearSequence);
  $('seqLoad')?.addEventListener('click', loadSequence);
  // Event palette — each item opens modal
  document.querySelectorAll('.palette-item[data-event]').forEach(el => {
    el.addEventListener('click', () => openEventModal(el.dataset.event));
  });

  // Modal buttons
  $('evModalOk')?.addEventListener('click', confirmEventModal);
  $('evModalCancel')?.addEventListener('click', closeEventModal);
  $('evModalClose')?.addEventListener('click', closeEventModal);
  $('eventModal')?.addEventListener('click', e => { if (e.target === $('eventModal')) closeEventModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('eventModal')?.style.display !== 'none') closeEventModal(); });

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

  // Capture extra
  $('captureSaveCsv')?.addEventListener('click', downloadCaptureCsv);

  // Settings
  $('refreshLogs')?.addEventListener('click', loadLogs);
  $('settingsWorkerRefresh')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/register/status');
      const el = $('settingsWorkerState');
      if (el) el.textContent = `${data.serialConnected ? '● connected' : '○ disconnected'}  base: ${data.baseAddress || '—'}`;
      if ($('settingsBaseAddr') && data.baseAddress) $('settingsBaseAddr').value = data.baseAddress;
    } catch(err) { if ($('settingsWorkerState')) $('settingsWorkerState').textContent = `offline: ${err.message}`; }
  });
  $('settingsBaseAddrApply')?.addEventListener('click', async () => {
    const val = $('settingsBaseAddr')?.value?.trim();
    if (!val) return;
    try {
      await api('/api/register/base-addr', { method:'POST', body: JSON.stringify({ address: val }) });
      if ($('settingsBaseAddrSt')) $('settingsBaseAddrSt').textContent = 'Applied';
      setTimeout(() => { if ($('settingsBaseAddrSt')) $('settingsBaseAddrSt').textContent = ''; }, 2000);
      await refreshRegStatus();
    } catch(err) { if ($('settingsBaseAddrSt')) $('settingsBaseAddrSt').textContent = `Error: ${err.message}`; }
  });

  // Serial Break
  $('serialBreak')?.addEventListener('click', async () => {
    try {
      await api('/api/serial/break', { method:'POST', body:'{}' });
      toast('Break signal sent', 'ok');
    } catch(err) { toast(`Break failed: ${err.message}`, 'bad'); }
  });

  try {
    await api('/api/health');
    await Promise.allSettled([
      refreshInterfaces(),
      loadLogs(),
      refreshSerialStatus(),
      refreshRegStatus(),
      loadTestCases(),
      loadSequence(),
      refreshAddrLocal(),
    ]);
    startCapturePolling();
    state.serialTimer = setInterval(refreshSerialStatus, 2000);
  } catch (err) {
    setStatus(`Offline — ${err.message}`, false);
    toast(`Server not reachable: ${err.message}`, 'bad');
  }
}

init();
