const $ = (id) => document.getElementById(id);
const DEFAULT_PEER_URL = 'http://172.31.51.213:8080';
const savedPeerUrl = localStorage.getItem('peerUrl');
const initialPeerUrl = !savedPeerUrl || savedPeerUrl === 'http://169.254.5.7:8080'
  ? DEFAULT_PEER_URL
  : savedPeerUrl;

const state = {
  examples: {},
  exampleItems: [],
  interfaces: [],
  packets: [],
  report: null,
  nodes: {
    sender: null,
    receiver: null
  },
  peer: {
    url: initialPeerUrl,
    interface: localStorage.getItem('peerInterface') || '',
    interfaces: [],
    iface: null
  },
  testCases: [],
  testProfiles: [],
  currentCase: {
    id: '',
    name: 'Untitled Test Case',
    description: '',
    steps: []
  },
  selectedStep: -1,
  controlFrames: [],
  localRole: localStorage.getItem('localRole') || 'sender',
  locked: false
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  return String(value || 'test-case')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `test-case-${Date.now()}`;
}

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

// Toast notifications — replace alert() so the page never blocks.
function toast(message, kind = '', timeoutMs = 4500) {
  const tray = document.getElementById('toastTray');
  if (!tray) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  const icon = kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : kind === 'fail' ? '✕' : 'ⓘ';
  el.innerHTML = `<span class="icon">${icon}</span><span class="body"></span><button class="close" aria-label="Dismiss">×</button>`;
  el.querySelector('.body').textContent = message;
  el.querySelector('.close').addEventListener('click', () => dismiss());
  tray.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let t = setTimeout(dismiss, timeoutMs);
  function dismiss() {
    clearTimeout(t);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 240);
  }
  return dismiss;
}
function toastError(err) {
  const msg = err?.message || String(err);
  setStatus(msg, true);
  toast(msg, 'fail');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.stderr || 'request failed');
  }
  return data;
}

function payloadData(profile) {
  const payload = profile.payload || {};
  if (typeof payload === 'string') return { mode: 'text', data: payload };
  return payload;
}

function setProfile(profile) {
  const payload = payloadData(profile);
  $('protocol').value = profile.protocol || 'udp';
  // Templates carry placeholder source MAC/IP (e.g. 02:00:00:00:00:01 or
  // 192.168.100.10) that have nothing to do with the user's real NIC. Only
  // pull destination + frame content from the template; source addressing
  // is owned by the Sender interface picker and stays put.
  $('dstMac').value = profile.dstMac || '';
  $('dstIp').value  = profile.ipv4?.dst || profile.arp?.targetIp || '';
  // Re-apply autofill so srcMac / srcIp reflect the currently picked NIC
  // (clear the user-typed sticky flag — when picking a template the user
  // wants the source to follow the active interface).
  ['srcMac','srcIp'].forEach((id) => { const el = $(id); if (el) el.dataset.autofill = '1'; });
  $('srcMac').value = '';
  $('srcIp').value  = '';
  autofillSenderFromPickedIface();
  $('srcPort').value = profile.udp?.srcPort || profile.tcp?.srcPort || 40000;
  $('dstPort').value = profile.udp?.dstPort || profile.tcp?.dstPort || 50000;
  // Restore TCP flags if profile has explicit flags
  const f = profile.tcp?.flags;
  if (f !== undefined) {
    if ($('tcpFlagSyn')) $('tcpFlagSyn').checked = !!(f & 0x02);
    if ($('tcpFlagAck')) $('tcpFlagAck').checked = !!(f & 0x10);
    if ($('tcpFlagPsh')) $('tcpFlagPsh').checked = !!(f & 0x08);
    if ($('tcpFlagFin')) $('tcpFlagFin').checked = !!(f & 0x01);
    if ($('tcpFlagRst')) $('tcpFlagRst').checked = !!(f & 0x04);
  }
  $('payloadMode').value = payload.mode || 'text';
  $('payload').value = payload.data || payload.template || '';
  $('payloadSize').value = payload.size ?? '';
  $('payloadByte').value = payload.byte ?? '';
  $('targetFrameLength').value = profile.targetFrameLength ?? '';
  $('count').value = profile.count || 1;
  $('intervalMs').value = profile.intervalMs || 1000;
  $('vlanEnabled').checked = Boolean(profile.vlan?.enabled);
  $('vlanId').value = profile.vlan?.id ?? 10;
  $('vlanPriority').value = profile.vlan?.priority ?? 0;
  // Capture page is Wireshark-style "sniff all by default" - never auto-fill the
  // pre-decode filter inputs from the loaded profile. Otherwise loading the ARP
  // profile would silently lock captureEtherType=0x0806 and drop every UDP frame.
  $('profileDescription').textContent = profile.description || profile.name || '-';
}

function cidrFromInterface(iface) {
  const ipv4 = iface?.ipv4?.[0];
  if (!ipv4?.local || !ipv4?.prefixlen) return '';
  return `${ipv4.local}/${ipv4.prefixlen}`;
}

function currentPayload() {
  const mode = $('payloadMode').value;
  const payload = { mode };
  const text = $('payload').value;
  const size = $('payloadSize').value;
  const byte = $('payloadByte').value.trim();
  if (mode === 'sequence') {
    payload.template = text || 'KETI_TEST_SEQ_{seq:06d}';
    payload.start = 1;
  } else if (mode === 'hex') {
    payload.data = text;
  } else if (mode === 'counter' || mode === 'random') {
    payload.size = Number(size || 32);
  } else if (mode === 'repeat') {
    payload.byte = byte || '0x00';
    payload.size = Number(size || 32);
  } else {
    payload.data = text;
  }
  return payload;
}

function getProfile() {
  const protocol = $('protocol').value;
  const targetFrameLength = $('targetFrameLength').value;
  // Resolve the interface name from the active picker (Sender selection by
  // default). selectedInterfaceNames() returns all of them; we pick the first
  // because /api/build / /api/send takes one interface — multi-NIC fan-out
  // happens in send() by overriding `interface` per iteration.
  const ifaceName = selectedInterfaceNames()[0] || '';
  const profile = {
    interface: ifaceName,
    protocol,
    dstMac: $('dstMac').value.trim(),
    srcMac: $('srcMac').value.trim(),
    count: Number($('count').value || 1),
    intervalMs: Number($('intervalMs').value || 0),
    payload: currentPayload(),
    vlan: {
      enabled: $('vlanEnabled').checked,
      id: Number($('vlanId').value || 0),
      priority: Number($('vlanPriority').value || 0)
    }
  };
  if (targetFrameLength) profile.targetFrameLength = Number(targetFrameLength);
  if (protocol === 'udp') {
    profile.ipv4 = { src: $('srcIp').value.trim(), dst: $('dstIp').value.trim(), ttl: 64 };
    profile.udp = { srcPort: Number($('srcPort').value), dstPort: Number($('dstPort').value) };
  } else if (protocol === 'tcp') {
    profile.ipv4 = { src: $('srcIp').value.trim(), dst: $('dstIp').value.trim(), ttl: 64 };
    const tcpObj = { srcPort: Number($('srcPort').value), dstPort: Number($('dstPort').value) };
    const syn = $('tcpFlagSyn')?.checked, ack = $('tcpFlagAck')?.checked;
    const psh = $('tcpFlagPsh')?.checked, fin = $('tcpFlagFin')?.checked, rst = $('tcpFlagRst')?.checked;
    if (syn || ack || psh || fin || rst)
      tcpObj.flags = (syn ? 0x02 : 0) | (ack ? 0x10 : 0) | (psh ? 0x08 : 0) | (fin ? 0x01 : 0) | (rst ? 0x04 : 0);
    profile.tcp = tcpObj;
  } else if (protocol === 'icmp') {
    profile.ipv4 = { src: $('srcIp').value.trim(), dst: $('dstIp').value.trim(), ttl: 64 };
    profile.icmp = { type: 8, code: 0, id: 8230, seq: 1 };
  } else if (protocol === 'arp') {
    profile.arp = {
      operation: 1,
      senderMac: $('srcMac').value.trim(),
      senderIp: $('srcIp').value.trim(),
      targetMac: '00:00:00:00:00:00',
      targetIp: $('dstIp').value.trim()
    };
  } else {
    profile.etherType = '0x88b5';
  }
  return profile;
}

function showResult(result) {
  const body = result.stdout || result;
  $('decoded').textContent = JSON.stringify(body.decoded || body, null, 2);
  $('hexdump').textContent = body.hexdump || '';
}

function protocolName(decoded) {
  if (decoded.lldp) return 'LLDP';
  if (decoded.ptp) return 'PTP';
  if (decoded.lacp) return 'LACP';
  if (decoded.arp) return 'ARP';
  if (decoded.icmpv6) return 'ICMPv6';
  if (decoded.icmp) return 'ICMP';
  if (decoded.tls) return 'TLS';
  if (decoded.tcp) return decoded.ipv6 ? 'TCP/IPv6' : 'TCP';
  if (decoded.dns) return 'DNS';
  if (decoded.dhcp) return 'DHCP';
  if (decoded.ntp) return 'NTP';
  if (decoded.vxlan) return 'VXLAN';
  if (decoded.udp) {
    const sp = decoded.udp.srcPort, dp = decoded.udp.dstPort;
    if (sp === 5353 || dp === 5353) return 'mDNS';
    if (sp === 319 || dp === 319 || sp === 320 || dp === 320) return 'PTP/UDP';
    return decoded.ipv6 ? 'UDP/IPv6' : 'UDP';
  }
  if (decoded.ipv6) return `IPv6/${decoded.ipv6.nextHeader}`;
  if (decoded.ipv4) return `IPv4/${decoded.ipv4.protocol}`;
  return decoded.ethernet?.etherType || 'Ethernet';
}

function packetInfoExtra(decoded) {
  if (decoded.tls?.sni) return ` SNI=${decoded.tls.sni}`;
  if (decoded.dns) return ` ${decoded.dns.qr} ${decoded.dns.rcode ? 'rcode=' + decoded.dns.rcode : ''}`;
  if (decoded.dhcp?.messageType) return ` ${decoded.dhcp.messageType} xid=${decoded.dhcp.xid}`;
  if (decoded.ntp) return ` v${decoded.ntp.version} stratum=${decoded.ntp.stratum}`;
  if (decoded.vxlan) return ` VNI=${decoded.vxlan.vni}`;
  return '';
}

function packetInfo(decoded) {
  if (decoded.lldp) {
    const sysName = decoded.lldp.tlvs?.find((t) => t.name === 'SystemName')?.value;
    const portId = decoded.lldp.tlvs?.find((t) => t.name === 'PortID')?.value;
    return `LLDP ${sysName ? sysName + ' / ' : ''}${portId || decoded.lldp.tlvCount + ' TLVs'}`;
  }
  if (decoded.ptp) return `${decoded.ptp.messageName} seq=${decoded.ptp.sequenceId} dom=${decoded.ptp.domain}`;
  if (decoded.arp) return decoded.arp.operation === 1 ? `Who has ${decoded.arp.targetIp}? Tell ${decoded.arp.senderIp}` : `${decoded.arp.senderIp} is at ${decoded.arp.senderMac}`;
  if (decoded.tcp) {
    const f = decoded.tcp.flags || 0;
    const flagNames = [[0x02,'SYN'],[0x10,'ACK'],[0x08,'PSH'],[0x01,'FIN'],[0x04,'RST'],[0x20,'URG']].filter(([b])=>f&b).map(([,n])=>n);
    return `${decoded.tcp.srcPort} → ${decoded.tcp.dstPort} [${flagNames.join(',') || '-'}] seq=${decoded.tcp.seq} win=${decoded.tcp.window}` + packetInfoExtra(decoded);
  }
  if (decoded.udp) return `${decoded.udp.srcPort} → ${decoded.udp.dstPort}  Len=${decoded.udp.length}` + packetInfoExtra(decoded);
  if (decoded.icmpv6) return `${decoded.icmpv6.typeName} (type ${decoded.icmpv6.type})`;
  if (decoded.icmp) return `type ${decoded.icmp.type}, seq ${decoded.icmp.seq}`;
  if (decoded.ipv6) return `IPv6 next=${decoded.ipv6.nextHeader}`;
  return decoded.ethernet?.etherType || '';
}

const capture = {
  packets: [],
  reader: null,
  readers: [],
  abort: null,
  selectedIdx: -1,
  startedAtMs: 0,
  totalBytes: 0,
  lastWindow: { t: 0, count: 0, pps: 0 },
  filter: '',
  maxRows: 2000,
  maxBuffer: 50000,
  truncated: 0,
  pendingRows: [],
  flushScheduled: false
};

function rowProtoClass(decoded) {
  if (decoded.lldp) return 'proto-lldp';
  if (decoded.ptp) return 'proto-ptp';
  if (decoded.arp) return 'proto-arp';
  if (decoded.icmp || decoded.icmpv6) return 'proto-icmp';
  if (decoded.tcp) return 'proto-tcp';
  if (decoded.udp) return 'proto-udp';
  if (decoded.ipv6) return 'proto-ipv6';
  return '';
}

function frameMatchesFilter(packet, filter) {
  if (!filter) return true;
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const d = packet.decoded || {};
  // Tokens: udp / tcp / icmp / icmpv6 / arp / vlan / ipv4 / ipv6 / lldp / ptp / lacp / dns / dhcp / ntp / mdns
  if (f === 'udp') return Boolean(d.udp);
  if (f === 'tcp') return Boolean(d.tcp);
  if (f === 'icmp') return Boolean(d.icmp);
  if (f === 'icmpv6') return Boolean(d.icmpv6);
  if (f === 'arp') return Boolean(d.arp);
  if (f === 'vlan') return Boolean(d.vlan);
  if (f === 'ipv4') return Boolean(d.ipv4);
  if (f === 'ipv6') return Boolean(d.ipv6);
  if (f === 'lldp') return Boolean(d.lldp);
  if (f === 'ptp') return Boolean(d.ptp);
  if (f === 'lacp') return Boolean(d.lacp);
  if (f === 'dns') return d.udp && (d.udp.srcPort === 53 || d.udp.dstPort === 53);
  if (f === 'dhcp') return d.udp && [67,68].some((p) => d.udp.srcPort === p || d.udp.dstPort === p);
  if (f === 'ntp') return d.udp && (d.udp.srcPort === 123 || d.udp.dstPort === 123);
  if (f === 'mdns') return d.udp && (d.udp.srcPort === 5353 || d.udp.dstPort === 5353);
  if (f === 'tls') return Boolean(d.tls);
  if (f === 'vxlan') return Boolean(d.vxlan);
  if (f.startsWith('mac:')) {
    const m = f.slice(4).trim();
    return (d.ethernet?.srcMac || '').toLowerCase().includes(m)
      || (d.ethernet?.dstMac || '').toLowerCase().includes(m);
  }
  if (f.startsWith('ip:')) {
    const m = f.slice(3).trim();
    return (d.ipv4?.src || '').includes(m) || (d.ipv4?.dst || '').includes(m);
  }
  if (f.startsWith('port:')) {
    const m = Number(f.slice(5).trim());
    return d.udp?.srcPort === m || d.udp?.dstPort === m;
  }
  // Free-text substring against a precomputed haystack — *one* JSON.stringify
  // per frame at ingest, not one per filter-keystroke. Drops filter-input CPU
  // from O(N × payload-size) to O(N × search-len).
  if (!packet._hay) packet._hay = JSON.stringify(d).toLowerCase();
  return packet._hay.includes(f);
}

function buildPacketRow(packet) {
  const decoded = packet.decoded || {};
  const eth = decoded.ethernet || decoded.eth || {};
  const srcMac = eth.srcMac || eth.src || '-';
  const dstMac = eth.dstMac || eth.dst || '-';
  const srcIp = decoded.ipv4?.src || decoded.arp?.senderIp || decoded.ipv6?.src || '-';
  const dstIp = decoded.ipv4?.dst || decoded.arp?.targetIp || decoded.ipv6?.dst || '-';
  const t = packet.timestamp;
  const d = new Date(t * 1000);
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const tStr = `${d.toLocaleTimeString('en-GB')}.${ms}`;
  const proto = protocolName(decoded);
  const idx = packet._idx;
  const tr = document.createElement('tr');
  tr.dataset.idx = String(idx);
  tr.className = rowProtoClass(decoded);
  // No per-row listener — tbody-level delegation handles clicks.
  const iface = packet._iface || '';
  tr.innerHTML = `<td class="colNum">${idx + 1}</td><td class="colTime">${tStr}</td><td class="colIface">${iface}</td><td class="colSrcMac">${srcMac}</td><td class="colDstMac">${dstMac}</td><td class="colSrc">${srcIp}</td><td class="colDst">${dstIp}</td><td class="colProto">${proto}</td><td class="colLen">${packet.length}</td><td>${packetInfo(decoded)}</td>`;
  return tr;
}

function flushPendingRows() {
  capture.flushScheduled = false;
  const tbody = $('packetRows');
  if (!tbody || !capture.pendingRows.length) return;
  const empty = $('packetEmpty');
  if (empty) empty.classList.add('hidden');
  // Batch into a DocumentFragment so the browser does ONE layout pass per
  // animation frame regardless of incoming frame rate.
  const frag = document.createDocumentFragment();
  for (const pkt of capture.pendingRows) frag.appendChild(buildPacketRow(pkt));
  capture.pendingRows.length = 0;
  tbody.appendChild(frag);
  // Cap DOM rows; remove from front in one bulk op to avoid N reflows.
  let over = tbody.children.length - capture.maxRows;
  if (over > 0) {
    const range = document.createRange();
    range.setStart(tbody, 0);
    range.setEnd(tbody, over);
    range.deleteContents();
  }
  if ($('captureFollow').checked) {
    const list = tbody.parentElement.parentElement;
    list.scrollTop = list.scrollHeight;
  }
}

function appendPacketRow(packet) {
  capture.pendingRows.push(packet);
  if (!capture.flushScheduled) {
    capture.flushScheduled = true;
    requestAnimationFrame(flushPendingRows);
  }
}

function computeFrameLayers(decoded, hexLen) {
  // Walk the decoded structure and return [{name, color, start, end}] byte ranges.
  const layers = [];
  layers.push({ name: 'Ethernet', color: '#0ea5e9', start: 0, end: 14 });
  let off = 14;
  if (decoded.vlan) { layers.push({ name: 'VLAN', color: '#f59e0b', start: 12, end: 16 }); off = 18; }
  if (decoded.vlanInner) { layers.push({ name: 'VLAN inner', color: '#fbbf24', start: off - 4, end: off + 4 }); off += 4; }
  if (decoded.ipv4) {
    const ihl = 20; // simplification; works for default-no-options frames
    layers.push({ name: 'IPv4', color: '#16a34a', start: off, end: off + ihl });
    if (decoded.udp) {
      layers.push({ name: 'UDP', color: '#7c3aed', start: off + ihl, end: off + ihl + 8 });
      layers.push({ name: 'Payload', color: '#94a3b8', start: off + ihl + 8, end: hexLen });
    } else if (decoded.tcp) {
      const tcpLen = decoded.tcp.dataOffset || 20;
      layers.push({ name: 'TCP', color: '#7c3aed', start: off + ihl, end: off + ihl + tcpLen });
      layers.push({ name: 'Payload', color: '#94a3b8', start: off + ihl + tcpLen, end: hexLen });
    } else if (decoded.icmp) {
      layers.push({ name: 'ICMP', color: '#a855f7', start: off + ihl, end: off + ihl + 8 });
      layers.push({ name: 'Payload', color: '#94a3b8', start: off + ihl + 8, end: hexLen });
    }
  } else if (decoded.ipv6) {
    layers.push({ name: 'IPv6', color: '#6366f1', start: off, end: off + 40 });
    if (decoded.udp) {
      layers.push({ name: 'UDP', color: '#7c3aed', start: off + 40, end: off + 48 });
      layers.push({ name: 'Payload', color: '#94a3b8', start: off + 48, end: hexLen });
    } else if (decoded.tcp) {
      const tcpLen = decoded.tcp.dataOffset || 20;
      layers.push({ name: 'TCP', color: '#7c3aed', start: off + 40, end: off + 40 + tcpLen });
      layers.push({ name: 'Payload', color: '#94a3b8', start: off + 40 + tcpLen, end: hexLen });
    } else if (decoded.icmpv6) {
      layers.push({ name: 'ICMPv6', color: '#a855f7', start: off + 40, end: off + 44 });
      layers.push({ name: 'Payload', color: '#94a3b8', start: off + 44, end: hexLen });
    }
  } else if (decoded.arp) {
    layers.push({ name: 'ARP', color: '#f97316', start: off, end: off + 28 });
  } else if (decoded.lldp) {
    layers.push({ name: 'LLDP', color: '#ec4899', start: off, end: hexLen });
  } else if (decoded.ptp) {
    layers.push({ name: 'PTP', color: '#d946ef', start: off, end: hexLen });
  }
  return layers;
}

function renderColoredHex(frameHex, layers) {
  // Build a hexdump where each byte is wrapped in a span coloured by the layer it belongs to.
  const bytes = [];
  for (let i = 0; i < frameHex.length / 2; i += 1) bytes.push(frameHex.substr(i * 2, 2));
  const colorAt = new Array(bytes.length).fill('#94a3b8');
  for (const L of layers) {
    for (let i = L.start; i < Math.min(L.end, bytes.length); i += 1) colorAt[i] = L.color;
  }
  let out = '';
  for (let row = 0; row < bytes.length; row += 16) {
    let hex = ''; let ascii = '';
    for (let i = 0; i < 16 && row + i < bytes.length; i += 1) {
      const b = bytes[row + i];
      hex += `<span style="color:${colorAt[row + i]}">${b}</span> `;
      const v = parseInt(b, 16);
      ascii += (v >= 32 && v < 127) ? String.fromCharCode(v).replace('<', '&lt;').replace('>', '&gt;').replace('&', '&amp;') : '·';
    }
    out += `<span class="hexOff">${row.toString(16).padStart(4, '0')}</span>  ${hex.padEnd(16 * 4 - 1, ' ')}  <span class="hexAscii">${ascii}</span>\n`;
  }
  return out;
}

function renderLegend(layers) {
  const seen = new Set();
  const unique = layers.filter((L) => !seen.has(L.name) && seen.add(L.name));
  return '<div class="layerLegend">' + unique.map((L) => `<span><i style="background:${L.color}"></i>${L.name}</span>`).join('') + '</div>';
}

function selectPacket(idx) {
  capture.selectedIdx = idx;
  const pkt = capture.packets[idx];
  if (!pkt) return;
  $('captureDecoded').textContent = JSON.stringify(pkt.decoded, null, 2);
  const hex = pkt.frameHex || '';
  const layers = computeFrameLayers(pkt.decoded || {}, hex.length / 2);
  const bytesEl = $('captureHexdump');
  bytesEl.innerHTML = renderLegend(layers) + renderColoredHex(hex, layers);
  document.querySelectorAll('#packetRows tr').forEach((r) => r.classList.toggle('selected', r.dataset.idx === String(idx)));
}

function refreshCaptureStats() {
  $('capStatPkts').textContent = capture.packets.filter((p) => frameMatchesFilter(p, capture.filter)).length || capture.packets.length;
  $('capStatBytes').textContent = humanBytes(capture.totalBytes);
  $('capStatPps').textContent = capture.lastWindow.pps.toFixed(0);
}

function humanBytes(b) {
  if (b < 1024) return `${b}`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function clearCapture() {
  capture.packets = [];
  capture.totalBytes = 0;
  capture.selectedIdx = -1;
  capture.lastWindow = { t: 0, count: 0, pps: 0 };
  $('packetRows').innerHTML = '';
  $('captureDecoded').textContent = '';
  $('captureHexdump').textContent = '';
  $('packetEmpty')?.classList.remove('hidden');
  refreshCaptureStats();
}

function selectedInterfaceNames() {
  const el = $('interfaceSelect');
  if (!el) return [];
  if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value).filter(Boolean);
  return el.value ? [el.value] : [];
}

async function spawnCaptureStream(ifaceName, signal, statTimer) {
  const body = {
    interface: ifaceName,
    timeoutSec: 0,
    maxFrames: 0,
    srcMac: $('captureSrcMac')?.value.trim() || '',
    dstMac: $('captureDstMac')?.value.trim() || '',
    etherType: $('captureEtherType')?.value.trim() || ''
  };
  const res = await fetch('/api/capture-stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} on ${ifaceName}`);
  const reader = res.body.getReader();
  capture.readers.push(reader);
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'frame') {
        ev._idx = capture.packets.length;
        ev._iface = ifaceName; // tag origin so the user can tell where it came from
        capture.packets.push(ev);
        capture.totalBytes += ev.length;
        capture.lastWindow.count += 1;
        if (capture.packets.length > capture.maxBuffer) {
          capture.packets.shift();
          capture.truncated += 1;
          if (capture.truncated === 1) toast(`Capture buffer hit ${capture.maxBuffer} packets — oldest are now being dropped to keep memory bounded.`, 'warn', 6000);
        }
        if (frameMatchesFilter(ev, capture.filter)) appendPacketRow(ev);
      } else if (ev.type === 'stats') {
        $('capStatDrops').textContent = String(ev.kernelDrops || 0);
        if ((ev.kernelDrops || 0) > 0) {
          $('capStatDrops').parentElement.style.background = 'rgba(155, 28, 28, 0.12)';
          $('capStatDrops').parentElement.style.color = '#9b1c1c';
        }
      } else if (ev.type === 'log') {
        setStatus(`agent[${ifaceName}]: ${ev.stderr}`, true);
      }
    }
  }
}

async function startCaptureStream() {
  if (capture.readers && capture.readers.length) return;
  const ifaces = selectedInterfaceNames();
  if (!ifaces.length) { setStatus('No interface selected', true); return; }
  clearCapture();
  $('capStatState').textContent = ifaces.length > 1 ? `capturing × ${ifaces.length}` : 'capturing';
  $('capStatState').classList.add('running');
  $('captureStart').disabled = true;
  $('captureStop').disabled = false;
  capture.startedAtMs = performance.now();
  capture.lastWindow = { t: capture.startedAtMs, count: 0, pps: 0 };
  capture.filter = $('captureDisplayFilter').value.trim();
  capture.readers = [];
  capture.abort = new AbortController();

  // Show BPF badge if any capture filter is active
  const _srcMac = $('captureSrcMac')?.value.trim() || '';
  const _dstMac = $('captureDstMac')?.value.trim() || '';
  const _etherType = $('captureEtherType')?.value.trim() || '';
  const bpfParts = [];
  if (_srcMac) bpfParts.push(`ether src ${_srcMac.toLowerCase()}`);
  if (_dstMac) bpfParts.push(`ether dst ${_dstMac.toLowerCase()}`);
  if (_etherType) bpfParts.push(`ether proto ${_etherType}`);
  const activeBpf = bpfParts.join(' and ');
  const badge = $('captureBpfBadge');
  const bpfText = $('captureBpfText');
  if (badge && bpfText) {
    if (activeBpf) {
      bpfText.textContent = activeBpf;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  const statTimer = setInterval(() => {
    const now = performance.now();
    const dt = (now - capture.lastWindow.t) / 1000;
    capture.lastWindow.pps = dt > 0 ? capture.lastWindow.count / dt : 0;
    capture.lastWindow.t = now;
    capture.lastWindow.count = 0;
    const elapsed = (now - capture.startedAtMs) / 1000;
    const stateEl = $('capStatState');
    if (stateEl?.classList.contains('running')) stateEl.textContent = ifaces.length > 1
      ? `capturing × ${ifaces.length} · ${elapsed.toFixed(1)}s`
      : `capturing · ${elapsed.toFixed(1)}s`;
    refreshCaptureStats();
  }, 500);
  try {
    // Each spawnCaptureStream call hits /api/capture-stream which spawns its own
    // packet_agent.py subprocess on the server, so N interfaces == N parallel
    // agents on the same machine. Frames are merged into capture.packets and
    // tagged with the originating interface (frame._iface) so the user can
    // tell rows apart.
    await Promise.all(ifaces.map((iface) =>
      spawnCaptureStream(iface, capture.abort.signal, statTimer)
        .catch((err) => { if (err.name !== 'AbortError') setStatus(`${iface}: ${err.message}`, true); })
    ));
  } finally {
    clearInterval(statTimer);
    finishCaptureStream('stopped');
  }
}

function finishCaptureStream(label) {
  capture.readers = [];
  capture.abort = null;
  $('captureStart').disabled = false;
  $('captureStop').disabled = true;
  $('capStatState').classList.remove('running');
  $('capStatState').textContent = label || 'idle';
  // Hide BPF badge when capture stops
  $('captureBpfBadge')?.classList.add('hidden');
  refreshCaptureStats();
}

function stopCaptureStream() {
  try { capture.abort?.abort(); } catch {}
  for (const r of capture.readers || []) { try { r.cancel(); } catch {} }
}

function reapplyFilter() {
  capture.filter = $('captureDisplayFilter').value.trim();
  $('packetRows').innerHTML = '';
  $('packetEmpty')?.classList.toggle('hidden', capture.packets.length > 0);
  for (const p of capture.packets) {
    if (frameMatchesFilter(p, capture.filter)) appendPacketRow(p);
  }
  refreshCaptureStats();
}

function renderPackets() {
  // legacy entry point kept for compatibility: reapplies filter on existing buffer
  reapplyFilter();
}

function protocolSummary(profile) {
  if (!profile) return '-';
  const parts = [];
  if (profile.vlan?.enabled) parts.push(`VLAN ${profile.vlan.id} PCP ${profile.vlan.priority}`);
  parts.push(String(profile.protocol || 'udp').toUpperCase());
  if (profile.udp) parts.push(`${profile.udp.srcPort || '-'}→${profile.udp.dstPort || '-'}`);
  return parts.join(' / ');
}

function payloadSummary(profile) {
  const payload = payloadData(profile || {});
  if (!payload) return '-';
  if (payload.mode === 'sequence') return payload.template || 'sequence';
  if (payload.mode === 'repeat') return `${payload.size || 0}B ${payload.byte || '0x00'}`;
  if (payload.mode === 'counter' || payload.mode === 'random' || payload.mode === 'benchmark') return `${payload.mode} ${payload.size || 0}B`;
  if (payload.mode === 'hex') return 'hex';
  return String(payload.data || '').slice(0, 38) || '-';
}

function syncCaseForm() {
  $('caseName').value = state.currentCase.name || '';
  $('caseDescription').value = state.currentCase.description || '';
}

function caseFromForm() {
  const name = $('caseName').value.trim() || 'Untitled Test Case';
  return {
    ...state.currentCase,
    id: state.currentCase.id || slugify(name),
    name,
    description: $('caseDescription').value.trim(),
    steps: state.currentCase.steps || []
  };
}

function renderCaseSelect() {
  if (!state.testCases.length) {
    $('caseSelect').innerHTML = '<option value="">No saved test cases</option>';
    return;
  }
  $('caseSelect').innerHTML = state.testCases.map((item) => (
    `<option value="${item.id}">${item.name} (${item.stepCount})</option>`
  )).join('');
  if (state.currentCase.id && state.testCases.find((item) => item.id === state.currentCase.id)) {
    $('caseSelect').value = state.currentCase.id;
  }
}

function renderProfileSuiteSelect() {
  if (!state.testProfiles.length) {
    $('profileSuiteSelect').innerHTML = '<option value="">No standard profiles</option>';
    return;
  }
  $('profileSuiteSelect').innerHTML = '<option value="">Load standard profile...</option>' + state.testProfiles.map((item) => (
    `<option value="${item.id}">${item.profileGroup} - ${item.name} (${item.stepCount})</option>`
  )).join('');
}

function renderCaseRows() {
  const steps = state.currentCase.steps || [];
  if (!steps.length) {
    $('caseRows').innerHTML = '<tr><td colspan="9" class="empty">No packet list rows yet</td></tr>';
    $('caseStepPreview').textContent = '';
    updateCaseEstimate();
    return;
  }
  $('caseRows').innerHTML = steps.map((step, index) => {
    const profile = step.profile || {};
    const selected = index === state.selectedStep ? ' class="selectedRow"' : '';
    if (step.kind === 'delay') {
      return `
        <tr data-step-index="${index}"${selected}>
          <td><input type="checkbox" data-step-check="${index}" ${step.checked !== false ? 'checked' : ''}></td>
          <td>${index}</td>
          <td class="eventName">${step.name || 'Delay'}</td>
          <td></td>
          <td></td>
          <td>DELAY</td>
          <td>${step.delayMs || 0} ms wait event</td>
          <td>-</td>
          <td><input class="miniInput" data-step-delay="${index}" type="number" min="0" value="${step.delayMs || 0}"> ms</td>
        </tr>
      `;
    }
    const src = profile.srcMac || profile.arp?.senderMac || '-';
    const dst = profile.dstMac || profile.arp?.targetMac || '-';
    return `
      <tr data-step-index="${index}"${selected}>
        <td><input type="checkbox" data-step-check="${index}" ${step.checked !== false ? 'checked' : ''}></td>
        <td>${index}</td>
        <td>${step.name || profile.name || 'Packet'}</td>
        <td><code>${src}</code></td>
        <td><code>${dst}</code></td>
        <td>${protocolSummary(profile)}</td>
        <td>${payloadSummary(profile)}</td>
        <td><input class="miniInput" data-step-count="${index}" type="number" min="1" value="${step.count || profile.count || 1}"></td>
        <td><input class="miniInput" data-step-interval="${index}" type="number" min="0" value="${step.intervalMs ?? profile.intervalMs ?? 0}"> ms</td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('[data-step-index]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedStep = Number(row.dataset.stepIndex);
      const step = state.currentCase.steps[state.selectedStep];
      $('caseStepPreview').textContent = JSON.stringify(step, null, 2);
      renderCaseRows();
      // Load the selected step's profile into the Sender form so its values
      // are editable and the Frame Details / Bytes preview rebuilds automatically.
      if (step?.kind === 'packet' && step.profile) {
        setProfile(step.profile);
        schedulePreview();
      }
    });
  });
  document.querySelectorAll('[data-step-check]').forEach((input) => {
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('change', () => {
      state.currentCase.steps[Number(input.dataset.stepCheck)].checked = input.checked;
    });
  });
  document.querySelectorAll('[data-step-count]').forEach((input) => {
    input.addEventListener('change', () => {
      state.currentCase.steps[Number(input.dataset.stepCount)].count = Math.max(1, Number(input.value || 1));
      updateCaseEstimate();
    });
  });
  document.querySelectorAll('[data-step-interval]').forEach((input) => {
    input.addEventListener('change', () => {
      state.currentCase.steps[Number(input.dataset.stepInterval)].intervalMs = Math.max(0, Number(input.value || 0));
      updateCaseEstimate();
    });
  });
  document.querySelectorAll('[data-step-delay]').forEach((input) => {
    input.addEventListener('change', () => {
      const step = state.currentCase.steps[Number(input.dataset.stepDelay)];
      step.delayMs = Math.max(0, Number(input.value || 0));
      step.name = `Delay ${step.delayMs} ms`;
      renderCaseRows();
    });
  });

  if (state.selectedStep >= 0 && state.currentCase.steps[state.selectedStep]) {
    $('caseStepPreview').textContent = JSON.stringify(state.currentCase.steps[state.selectedStep], null, 2);
  }
  updateCaseEstimate();
}

function setCurrentCase(testCase) {
  state.currentCase = cloneJson(testCase || {
    id: '',
    name: 'Untitled Test Case',
    description: '',
    steps: []
  });
  state.selectedStep = -1;
  syncCaseForm();
  renderCaseSelect();
  renderCaseRows();
}

async function loadTestCases() {
  const result = await api('/api/test-cases');
  state.testCases = result.items || [];
  renderCaseSelect();
  if (state.testCases.length && !state.currentCase.steps.length) {
    setCurrentCase(state.testCases[0].testCase);
  } else {
    renderCaseRows();
  }
}

async function loadTestProfiles() {
  try {
    const result = await api('/api/test-profiles');
    state.testProfiles = result.items || [];
  } catch (err) {
    state.testProfiles = [];
    console.warn('test-profiles unavailable:', err.message);
  }
  renderProfileSuiteSelect();
}

function addCurrentPacketToCase() {
  const profile = getProfile();
  const selected = state.exampleItems.find((entry) => entry.key === $('profileSelect').value);
  const insertAt = state.selectedStep >= 0 ? state.selectedStep + 1 : state.currentCase.steps.length;
  state.currentCase.steps.splice(insertAt, 0, {
    kind: 'packet',
    name: selected?.name || profile.name || `${String(profile.protocol || 'udp').toUpperCase()} packet`,
    enabled: true,
    checked: true,
    count: Number($('count').value || profile.count || 1),
    intervalMs: Number($('intervalMs').value || profile.intervalMs || 0),
    profile
  });
  state.selectedStep = insertAt;
  renderCaseRows();
}

function addDelayToCase() {
  const delayMs = Math.max(0, Number($('caseDelayMs').value || 100));
  const insertAt = state.selectedStep >= 0 ? state.selectedStep + 1 : state.currentCase.steps.length;
  state.currentCase.steps.splice(insertAt, 0, { kind: 'delay', name: `Delay ${delayMs} ms`, delayMs, checked: true });
  state.selectedStep = insertAt;
  renderCaseRows();
}

function selectedStep() {
  return state.selectedStep >= 0 ? state.currentCase.steps[state.selectedStep] : null;
}

function loadSelectedStep() {
  const step = selectedStep();
  if (step?.profile) setProfile(step.profile);
}

function duplicateSelectedStep() {
  const step = selectedStep();
  if (!step) return;
  const insertAt = state.selectedStep + 1;
  state.currentCase.steps.splice(insertAt, 0, cloneJson(step));
  state.selectedStep = insertAt;
  renderCaseRows();
}

function removeSelectedStep() {
  if (state.selectedStep < 0) return;
  state.currentCase.steps.splice(state.selectedStep, 1);
  state.selectedStep = Math.min(state.selectedStep, state.currentCase.steps.length - 1);
  renderCaseRows();
}

function moveSelectedStep(delta) {
  const index = state.selectedStep;
  const next = index + delta;
  if (index < 0 || next < 0 || next >= state.currentCase.steps.length) return;
  const tmp = state.currentCase.steps[next];
  state.currentCase.steps[next] = state.currentCase.steps[index];
  state.currentCase.steps[index] = tmp;
  state.selectedStep = next;
  renderCaseRows();
}

function estimatedWireMsForProfile(profile) {
  const len = Number(profile?.targetFrameLength || 64);
  return ((8 + Math.max(64, len) + 4 + 12) * 8) / 1_000_000;
}

function updateCaseEstimate() {
  const steps = state.currentCase.steps || [];
  let totalMs = 0;
  let packets = 0;
  for (const step of steps) {
    if (step.kind === 'delay') totalMs += Number(step.delayMs || 0);
    else {
      const count = Number(step.count || step.profile?.count || 1);
      totalMs += count * estimatedWireMsForProfile(step.profile);
      totalMs += Math.max(0, count - 1) * Number(step.intervalMs ?? step.profile?.intervalMs ?? 0);
      packets += count;
    }
  }
  const loops = $('caseRepeat')?.checked ? Math.max(1, Number($('caseLoopCount')?.value || 1)) : 1;
  const cycleMs = Math.max(0, Number($('caseCycleMs')?.value || 0));
  const repeatedMs = loops > 1 ? Math.max(totalMs, cycleMs) * loops : totalMs;
  if ($('caseEstimatedTime')) $('caseEstimatedTime').textContent = `${repeatedMs.toFixed(3)} ms`;
  if ($('caseSentPackets')) $('caseSentPackets').textContent = String(packets);
}

function caseForRun({ selectedOnly = false } = {}) {
  const testCase = caseFromForm();
  if (selectedOnly) {
    testCase.steps = testCase.steps.filter((step) => step.checked !== false);
  }
  return testCase;
}

async function saveCurrentCase() {
  const testCase = caseFromForm();
  const result = await api('/api/test-cases', { method: 'POST', body: JSON.stringify(testCase) });
  setCurrentCase(result.testCase);
  await loadTestCases();
  setStatus(`Saved test case: ${result.testCase.name}`);
}

async function deleteCurrentCase() {
  const id = state.currentCase.id || $('caseSelect').value;
  if (!id) return;
  if (!confirm(`Delete test case "${state.currentCase.name || id}"?`)) return;
  await api(`/api/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' });
  setCurrentCase({ id: '', name: 'Untitled Test Case', description: '', steps: [] });
  await loadTestCases();
  setStatus('Test case deleted');
}

async function runCurrentCase({ selectedOnly = false } = {}) {
  const started = new Date();
  $('caseStartTime').textContent = started.toLocaleTimeString();
  $('caseEndTime').textContent = '-';
  $('caseCycleStatus').textContent = 'running';
  setStatus(selectedOnly ? 'Sending selected packet list rows...' : 'Sending full packet list...');
  // Packet list Send is a local fan-out — fire each step's profile out the
  // Sender-picked NIC(s) via /api/send. No peer round-trip, no test-case
  // matching. (Peer-side matching lives on the Control tab's Wire
  // Validation / E2E pipelines, which already have their own URL fields.)
  const testCase = caseForRun({ selectedOnly });
  const senderIfaces = selectedInterfaceNames();
  if (!senderIfaces.length) throw new Error('No interface selected. Pick a NIC in "Send via" first.');
  const loopCount = $('caseRepeat').checked ? Math.max(1, Number($('caseLoopCount').value || 1)) : 1;
  const cyclePeriodMs = Math.max(0, Number($('caseCycleMs').value || 0));
  const stepResults = [];
  let totalFrames = 0, totalBytes = 0;
  for (let loop = 0; loop < loopCount; loop += 1) {
    const passStarted = Date.now();
    for (const step of testCase.steps) {
      if (step.kind === 'delay') {
        await new Promise((r) => setTimeout(r, Number(step.delayMs || 0)));
        stepResults.push({ kind: 'delay', name: step.name, delayMs: step.delayMs, ok: true });
        continue;
      }
      if (step.enabled === false) {
        stepResults.push({ kind: 'packet', name: step.name, skipped: true, ok: true, framesSent: 0 });
        continue;
      }
      for (const ifaceName of senderIfaces) {
        const ifaceObj = state.interfaces.find((i) => i.name === ifaceName);
        const profile = {
          ...step.profile,
          interface: ifaceName,
          srcMac: ifaceObj?.mac || step.profile.srcMac,
          count: step.count, intervalMs: step.intervalMs
        };
        try {
          const r = await api('/api/send', { method: 'POST', body: JSON.stringify(profile) });
          totalFrames += Number(r.stdout?.framesSent || 0);
          totalBytes += Number(r.stdout?.bytesSent || 0);
          stepResults.push({ kind: 'packet', name: `${step.name} via ${ifaceName}`, ok: true, framesSent: r.stdout?.framesSent, protocol: profile.protocol });
        } catch (e) {
          stepResults.push({ kind: 'packet', name: `${step.name} via ${ifaceName}`, ok: false, error: e.message });
        }
      }
    }
    const elapsed = Date.now() - passStarted;
    if (loop < loopCount - 1 && cyclePeriodMs > elapsed) {
      await new Promise((r) => setTimeout(r, cyclePeriodMs - elapsed));
    }
  }
  const result = {
    report: {
      ok: stepResults.every((s) => s.ok),
      summary: {
        framesSent: totalFrames,
        matched: 0, // no peer capture — receiver-side matching skipped
        total: stepResults.filter((s) => s.kind === 'packet').length,
        loopCount, cyclePeriodMs
      },
      steps: stepResults,
      capturedFrames: []
    }
  };
  $('caseEndTime').textContent = new Date().toLocaleTimeString();
  $('caseCycleStatus').textContent = `${Date.now() - started.getTime()} ms`;
  $('caseSentPackets').textContent = String(result.report.summary.framesSent);
  $('caseSentBytes').textContent = String(totalBytes);
  $('caseRunSummary').textContent = JSON.stringify(result.report.summary, null, 2);
  $('reportSummary').innerHTML = `
    <div><span>Status</span><strong>${result.report.ok ? 'PASS' : 'FAIL'}</strong></div>
    <div><span>Sent</span><strong>${result.report.summary.framesSent}</strong></div>
    <div><span>Matched</span><strong>${result.report.summary.matched}</strong></div>
  `;
  $('reportRows').innerHTML = result.report.steps.map((step, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>Case</td>
      <td>${step.name}</td>
      <td class="${step.ok ? 'passText' : 'failText'}">${step.ok ? 'PASS' : 'FAIL'}</td>
      <td>${step.framesSent ?? '-'}</td>
      <td>${step.kind}</td>
      <td>${step.kind === 'delay' ? `${step.delayMs} ms` : `${step.matchCount || 0} match`}</td>
    </tr>
  `).join('');
  $('openCaseReport').classList.remove('disabled');
  setStatus(`Test case ${result.report.ok ? 'PASS' : 'FAIL'}: ${result.report.summary.matched} match(es)`, !result.report.ok);
}

async function loadInterfaces() {
  setStatus('Loading interfaces...');
  const result = await api('/api/interfaces');
  state.interfaces = (result.stdout.interfaces || []).sort((a, b) => {
    const score = (iface) => {
      if (iface.name === 'lo') return 20;
      if (iface.name.startsWith('docker')) return 15;
      return iface.state === 'up' ? 0 : 10;
    };
    return score(a) - score(b) || a.name.localeCompare(b.name);
  });
  // Hidden <select multiple> stays so legacy callers reading .value still work
  // (it always reflects the first checked checkbox).
  const sel = $('interfaceSelect');
  sel.multiple = true;
  sel.innerHTML = state.interfaces
    .map((iface) => `<option value="${iface.name}">${iface.name} (${iface.state})</option>`)
    .join('');
  // Default: pick the first 'up' non-virtual NIC for both pickers so the UI
  // starts with one selection (matches the old single-select default).
  const def = state.interfaces.find((i) => i.state === 'up' && !/^(lo|docker|veth|br|virbr|tap|wlan|wlp|wlx)/.test(i.name))
           || state.interfaces[0];
  if (def) {
    if (!ifaceSel.sender.size)  ifaceSel.sender.add(def.name);
    if (!ifaceSel.capture.size) ifaceSel.capture.add(def.name);
  }
  renderInterfacePickers();
  updateInterfaceInfo();
  // Now that we know which NIC is picked, push srcMac/srcIp into the form
  // (loadExamples ran first and already loaded a template's dst values).
  autofillSenderFromPickedIface();
  // Fill the Control-tab linkStrip's quick-pick dropdown too.
  syncLocalInterfacePin?.();
  setStatus(`${state.interfaces.length} interfaces loaded`);
}

// Per-tab interface picker state. The Sender tab picks 'which NICs to
// transmit on'; the Capture tab picks 'which NICs to sniff on'. The hidden
// <select id=interfaceSelect> always mirrors the *active* tab's pick set so
// the rest of the app (which still reads interfaceSelect) stays correct.
const ifaceSel = { sender: new Set(), capture: new Set() };

function ifacePickerScope() {
  // 'capture' while the Capture tab is up, otherwise 'sender' (Control / Serial
  // share the sender NIC selection — sending from the Control SBF card etc.).
  return document.body.classList.contains('captureMode') ? 'capture' : 'sender';
}

function renderInterfacePickers() {
  renderOneIfacePicker('sender');
  renderOneIfacePicker('capture');
  mirrorIfaceSelectionToHiddenSelect();
}

function renderOneIfacePicker(scope) {
  const listId = scope === 'sender' ? 'senderIfaceList' : 'captureIfaceList';
  const countId = scope === 'sender' ? 'senderIfaceCount' : 'captureIfaceCount';
  const host = document.getElementById(listId);
  if (!host) return;
  if (!state.interfaces.length) {
    host.textContent = '— probe to load —';
    document.getElementById(countId).textContent = '0 selected';
    return;
  }
  const picked = ifaceSel[scope];
  host.innerHTML = state.interfaces.map((iface) => {
    const isChecked = picked.has(iface.name);
    const stateCls = iface.state === 'up' ? 'up' : iface.state === 'down' ? 'down' : 'unknown';
    const speed = iface.speedMbps ? `${iface.speedMbps} Mbps` : '';
    const ipv4 = (iface.ipv4 || [])[0];
    const ipText = ipv4 ? `${ipv4.local}/${ipv4.prefixlen}` : '';
    const extras = [speed, ipText].filter(Boolean).join(' · ');
    return `<label class="ifaceItem${isChecked ? ' checked' : ''}" data-iface="${iface.name}" data-scope="${scope}">
      <span class="ifaceCheck"></span>
      <input type="checkbox" value="${iface.name}"${isChecked ? ' checked' : ''}>
      <div class="ifaceMain">
        <div class="ifaceNameLine">
          <span class="ifaceName">${iface.name}</span>
          <span class="ifaceState ${stateCls}">${iface.state || '?'}</span>
        </div>
        <div class="ifaceMac">${iface.mac || '—'}</div>
        ${extras ? `<div class="ifaceExtras">${extras}</div>` : ''}
      </div>
    </label>`;
  }).join('');
  host.querySelectorAll('.ifaceItem').forEach((lab) => {
    lab.addEventListener('click', (e) => {
      // Avoid double-toggle when the inner checkbox itself emits a change.
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      toggleIface(scope, lab.dataset.iface);
    });
    lab.querySelector('input[type=checkbox]').addEventListener('change', () => {
      toggleIface(scope, lab.dataset.iface, true);
    });
  });
  document.getElementById(countId).textContent =
    `${picked.size}/${state.interfaces.length} selected`;
}

function toggleIface(scope, name, fromInputEvent = false) {
  const set = ifaceSel[scope];
  if (set.has(name)) set.delete(name); else set.add(name);
  renderOneIfacePicker(scope);
  if (scope === ifacePickerScope()) mirrorIfaceSelectionToHiddenSelect();
  if (scope === 'sender') autofillSenderFromPickedIface();
}

// When the user picks a NIC in the Sender picker, fill in Source MAC and
// Source IP from that NIC's properties — but only if the field is empty or
// matches the previously-picked NIC. Never clobber a value the user typed.
function autofillSenderFromPickedIface() {
  if (!document.body.classList.contains('senderMode')
      && document.body.classList.contains('captureMode')) return;
  const picked = Array.from(ifaceSel.sender)[0];
  if (!picked) return;
  const iface = state.interfaces.find((i) => i.name === picked);
  if (!iface) return;
  const srcMac = $('srcMac');
  const srcIp  = $('srcIp');
  if (srcMac && (!srcMac.value || srcMac.dataset.autofill === '1')) {
    srcMac.value = iface.mac || '';
    srcMac.dataset.autofill = '1';
  }
  if (srcIp && (!srcIp.value || srcIp.dataset.autofill === '1')) {
    const v4 = (iface.ipv4 || [])[0];
    srcIp.value = v4 ? v4.local : '';
    srcIp.dataset.autofill = '1';
  }
}
// Clear the autofill flag when the user actually types into the field.
document.addEventListener('input', (e) => {
  if (e.target && (e.target.id === 'srcMac' || e.target.id === 'srcIp')) {
    e.target.dataset.autofill = '';
  }
}, true);

function mirrorIfaceSelectionToHiddenSelect() {
  const sel = $('interfaceSelect');
  if (!sel) return;
  const scope = ifacePickerScope();
  const names = Array.from(ifaceSel[scope]);
  // IMPORTANT: don't `sel.value = names[0]` here. On a <select multiple>, the
  // .value setter de-selects every other option, undoing what we just set on
  // o.selected. Reading sel.value after this still returns the first selected
  // option (which is what getProfile() needs).
  Array.from(sel.options).forEach((o) => { o.selected = names.includes(o.value); });
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

// Backward-compat shim — many call sites still call renderInterfaceCheckboxes().
function renderInterfaceCheckboxes() { renderInterfacePickers(); }

// Initial body-class state — Sender tab is active on load.
document.body.classList.add('senderMode');
// Clear any stale readOnly from removed lock-to-peer feature.
setLockUi();

function updateInterfaceInfo() {
  const selected = state.interfaces.find((iface) => iface.name === $('interfaceSelect').value);
  if (!selected) {
    $('interfaceInfo').textContent = '';
    $('selectedInterfaceName').textContent = '-';
    $('selectedInterfaceMac').textContent = '-';
    return;
  }
  const v4 = firstV4(selected);
  const cidr = v4 && selected.ipv4[0]?.prefixlen ? `${v4}/${selected.ipv4[0].prefixlen}` : v4;
  const stateIcon = selected.state === 'up' ? '↑' : '↓';
  $('interfaceInfo').textContent = `${stateIcon}${selected.state} ${cidr || '—'} · ${selected.mac}`;
  $('selectedInterfaceName').textContent = selected.name;
  $('selectedInterfaceMac').textContent = `${selected.mac}${cidr ? ` / ${cidr}` : ''}`;
  if (selected.state !== 'up' && selected.name !== 'lo') setStatus(`${selected.name} is ${selected.state}`, true);
  if (state.locked) {
    $('srcMac').value = selected.mac;
    if (v4) $('srcIp').value = v4;
  } else {
    if (!$('srcMac').value || $('srcMac').value === '02:00:00:00:00:01') $('srcMac').value = selected.mac;
    if (v4 && (!$('srcIp').value || $('srcIp').value === '192.168.100.10')) $('srcIp').value = v4;
  }
}

function renderProfileSelect() {
  $('profileSelect').innerHTML = state.exampleItems.map((item) => (
    `<option value="${item.key}">${item.priority}. ${item.category} - ${item.name}</option>`
  )).join('');
}

async function loadExamples() {
  const data = await api('/api/examples');
  state.examples = data.profiles;
  state.exampleItems = data.items || Object.entries(data.profiles).map(([key, profile]) => ({ key, profile, name: profile.name || key, category: 'General', priority: 99 }));
  renderProfileSelect();
  const first = state.exampleItems[0];
  if (first) {
    $('profileSelect').value = first.key;
    setProfile(first.profile);
  }
}

function validateProfileFields() {
  const p = $('protocol').value;
  if (p === 'arp' || p === 'udp' || p === 'icmp' || p === 'tcp') {
    if (!$('srcMac').value || !$('dstMac').value) return 'Source / Destination MAC is empty. Pick a NIC above to autofill Source, then type Destination MAC.';
    if (p !== 'arp' && (!$('srcIp').value || !$('dstIp').value)) return 'Source / Destination IP is empty.';
  }
  return null;
}

async function build() {
  setStatus('Preparing frame preview...');
  const result = await api('/api/build', { method: 'POST', body: JSON.stringify(getProfile()) });
  showResult(result);
  setStatus(`Preview ready: ${result.stdout.decoded.length} bytes`);
}

async function send() {
  const err = validateProfileFields();
  if (err) { setStatus(err, true); toast(err, 'fail'); return; }
  const ifaces = selectedInterfaceNames();
  if (!ifaces.length) { setStatus('No interface selected', true); return; }
  const statsEl = $('sendStats');
  if (statsEl) statsEl.classList.add('hidden');
  if (ifaces.length === 1) {
    setStatus('Sending packet...');
    const t0 = performance.now();
    const result = await api('/api/send', { method: 'POST', body: JSON.stringify(getProfile()) });
    const elapsed = (performance.now() - t0) / 1000;
    showResult(result);
    const frames = Number(result.stdout?.framesSent || 0);
    const bytes  = Number(result.stdout?.bytesSent  || 0);
    const pps  = elapsed > 0 ? (frames / elapsed).toFixed(1) : '—';
    const mbps = elapsed > 0 ? ((bytes * 8) / elapsed / 1e6).toFixed(3) : '—';
    setStatus(`Sent ${frames} frame(s), ${bytes} bytes on ${ifaces[0]}`);
    if (statsEl) {
      statsEl.textContent = `${frames} frames · ${bytes} B · ${pps} pps · ${mbps} Mbps · ${elapsed.toFixed(3)} s`;
      statsEl.classList.remove('hidden');
    }
    return;
  }
  // Multi-interface fan-out: each NIC sends independently, with its own srcMac.
  setStatus(`Sending on ${ifaces.length} interface(s)...`);
  const t0 = performance.now();
  let totalFrames = 0, totalBytes = 0;
  const errors = [];
  for (const name of ifaces) {
    const iface = state.interfaces.find((i) => i.name === name);
    const profile = { ...getProfile(), interface: name, srcMac: iface?.mac || getProfile().srcMac };
    try {
      const r = await api('/api/send', { method: 'POST', body: JSON.stringify(profile) });
      totalFrames += Number(r.stdout?.framesSent || 0);
      totalBytes  += Number(r.stdout?.bytesSent  || 0);
      showResult(r);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  const elapsed = (performance.now() - t0) / 1000;
  const pps  = elapsed > 0 ? (totalFrames / elapsed).toFixed(1) : '—';
  const mbps = elapsed > 0 ? ((totalBytes * 8) / elapsed / 1e6).toFixed(3) : '—';
  if (errors.length) setStatus(`Sent ${totalFrames} frames across ${ifaces.length - errors.length}/${ifaces.length}; errors: ${errors.join('; ')}`, true);
  else setStatus(`Sent ${totalFrames} frames / ${totalBytes} bytes across ${ifaces.length} interfaces`);
  if (statsEl) {
    statsEl.textContent = `${totalFrames} frames · ${totalBytes} B · ${pps} pps · ${mbps} Mbps · ${elapsed.toFixed(3)} s`;
    statsEl.classList.remove('hidden');
  }
}

// `capture()` legacy function removed; use startCaptureStream / stopCaptureStream.

function renderReport(report) {
  state.report = report;
  $('reportSummary').innerHTML = `
    <div><span>Total</span><strong>${report.summary.total}</strong></div>
    <div><span>Pass</span><strong>${report.summary.pass}</strong></div>
    <div><span>Fail</span><strong>${report.summary.fail}</strong></div>
  `;
  $('reportRows').innerHTML = report.results.map((item) => `
    <tr>
      <td>${item.priority}</td>
      <td>${item.category}</td>
      <td>${item.name}</td>
      <td class="${item.ok ? 'passText' : 'failText'}">${item.ok ? 'PASS' : 'FAIL'}</td>
      <td>${item.length ?? '-'}</td>
      <td>${item.protocol || '-'}</td>
      <td>${item.error || item.info || ''}</td>
    </tr>
  `).join('');
  $('openReport')?.classList.remove('disabled');
}

function renderInterfaceOptions(selectId, interfaces) {
  $(selectId).innerHTML = interfaces.map((iface) => {
    const ip = iface.ipv4?.[0]?.local || '';
    return `<option value="${iface.name}">${iface.name} (${iface.state})${ip ? ` - ${ip}` : ''}</option>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function controlListId(role) {
  return role === 'sender' ? 'controlSenderIfaceList' : 'controlReceiverIfaceList';
}

function controlCountId(role) {
  return role === 'sender' ? 'controlSenderIfaceCount' : 'controlReceiverIfaceCount';
}

function controlSelectId(role) {
  return role === 'sender' ? 'senderNodeInterface' : 'receiverNodeInterface';
}

function selectedControlInterfaces(role) {
  const list = $(controlListId(role));
  const checked = list
    ? Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map((input) => input.value)
    : [];
  if (list?.querySelector('input[type=checkbox]')) return checked;
  if (checked.length) return checked;
  const fallback = $(controlSelectId(role))?.value;
  return fallback ? [fallback] : [];
}

function isControlLabInterface(iface) {
  const ip = iface?.ipv4?.find((addr) => addr.local && !addr.local.includes(':'))?.local || '';
  return iface?.state === 'up'
    && ip.startsWith('169.254.')
    && !/^(lo|docker|veth|br|virbr|tap|wlan|wlp|wlx)/.test(iface.name);
}

function updateControlInterfaceState(role) {
  const selected = selectedControlInterfaces(role);
  const count = $(controlCountId(role));
  if (count) count.textContent = `${selected.length} selected`;
  const select = $(controlSelectId(role));
  if (select && selected[0]) select.value = selected[0];
  updateControlPairMode();
  renderNodeGrid();
  renderPairCard();
  renderControlTopology();
}

function updateControlPairMode() {
  const senderCount = selectedControlInterfaces('sender').length;
  const receiverCount = selectedControlInterfaces('receiver').length;
  const el = $('controlPairMode');
  if (!el) return;
  if (!senderCount || !receiverCount) {
    el.textContent = 'no pair';
    return;
  }
  const pairCount = senderCount === receiverCount ? senderCount : senderCount * receiverCount;
  el.textContent = senderCount === receiverCount ? `${pairCount} pair${pairCount > 1 ? 's' : ''} · 1:1` : `${pairCount} combos`;
}

function renderControlInterfacePicker(role, interfaces, preferredName = '') {
  const list = $(controlListId(role));
  if (!list) return;
  const previous = new Set(selectedControlInterfaces(role));
  const validNames = new Set(interfaces.map((iface) => iface.name));
  let selected = new Set([...previous].filter((name) => validNames.has(name)));
  if (!selected.size && preferredName && validNames.has(preferredName)) selected.add(preferredName);
  if (!selected.size) {
    const labIfaces = interfaces.filter(isControlLabInterface);
    if (labIfaces.length) {
      selected = new Set(labIfaces.map((iface) => iface.name));
    } else {
      const firstUp = interfaces.find((iface) => iface.state === 'up' && iface.name !== 'lo' && !iface.name.startsWith('docker'));
      if (firstUp) selected.add(firstUp.name);
    }
  }
  list.innerHTML = interfaces.map((iface) => {
    const ip = iface.ipv4?.[0]?.local || '';
    const isChecked = selected.has(iface.name);
    const stateCls = iface.state === 'up' ? 'up' : 'down';
    return `
      <label class="controlIfaceChip ${isChecked ? 'checked' : ''}" data-iface="${iface.name}" title="${iface.name} / ${iface.mac || '-'}${ip ? ` / ${ip}` : ''}">
        <span class="ifaceCheck"></span>
        <input type="checkbox" value="${iface.name}"${isChecked ? ' checked' : ''}>
        <span class="controlIfaceChipState ${stateCls}"></span>
        <span class="controlIfaceChipName">${iface.name}</span>
        ${ip ? `<span class="controlIfaceChipIp">${ip}</span>` : ''}
      </label>`;
  }).join('');
  list.querySelectorAll('.controlIfaceChip').forEach((label) => {
    const input = label.querySelector('input[type=checkbox]');
    const sync = () => {
      label.classList.toggle('checked', input.checked);
      updateControlInterfaceState(role);
    };
    label.addEventListener('click', (event) => {
      if (event.target.tagName === 'INPUT') return;
      event.preventDefault();
      input.checked = !input.checked;
      sync();
    });
    input.addEventListener('change', sync);
  });
  updateControlInterfaceState(role);
}

function setControlSingleSelection(role, name) {
  const list = $(controlListId(role));
  if (!list || !name) return;
  list.querySelectorAll('input[type=checkbox]').forEach((input) => {
    input.checked = input.value === name;
    input.closest('.controlIfaceChip')?.classList.toggle('checked', input.checked);
  });
  updateControlInterfaceState(role);
}

function selectedControlPairs() {
  const senderUrl = $('senderNodeUrl').value;
  const receiverUrl = $('receiverNodeUrl').value;
  const senderIfs = selectedControlInterfaces('sender');
  const receiverIfs = selectedControlInterfaces('receiver');
  if (!senderUrl || !receiverUrl || !senderIfs.length || !receiverIfs.length) {
    throw new Error(`Missing pair: sender ${senderUrl || '?'}/${senderIfs.join(',') || '?'} -> receiver ${receiverUrl || '?'}/${receiverIfs.join(',') || '?'}`);
  }
  if (senderIfs.length === receiverIfs.length) {
    return senderIfs.map((senderIf, index) => ({
      senderUrl,
      receiverUrl,
      senderIf,
      receiverIf: receiverIfs[index],
      label: `${senderIf} -> ${receiverIfs[index]}`
    }));
  }
  return senderIfs.flatMap((senderIf) => receiverIfs.map((receiverIf) => ({
    senderUrl,
    receiverUrl,
    senderIf,
    receiverIf,
    label: `${senderIf} -> ${receiverIf}`
  })));
}

function ifaceByName(node, name) {
  return node?.interfaces?.find((iface) => iface.name === name) || null;
}

function ifaceIp(iface) {
  return iface?.ipv4?.find((addr) => addr.local && !addr.local.includes(':'))?.local || '';
}

// Live port link status (null=unknown, true=up, false=down) — updated by portMonitorPoll
const portLinkStatus = Array(6).fill(null);

function renderControlTopology() {
  const svgEl = $('controlTopologySvg');
  if (!svgEl) return;
  let pairs = [];
  try { pairs = selectedControlPairs(); } catch { pairs = []; }
  const senderNode = state.nodes.sender;
  const receiverNode = state.nodes.receiver;
  const summary = $('controlTopologySummary');
  if (summary) summary.textContent = pairs.length ? `${pairs.length} link(s) — 6-port switch` : 'select sender/receiver ports';

  // d3-powered topology
  if (typeof d3 === 'undefined') { svgEl.innerHTML = `<text x="460" y="132" text-anchor="middle" class="topoSubtext">d3.js loading...</text>`; return; }

  const W = 980, H = 310;
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();

  // ── Switch box (centre) ──────────────────────────────────────────────────
  const SW = { x: W / 2 - 110, y: H / 2 - 95, w: 220, h: 190, rx: 16 };
  svg.append('rect').attr('class', 'topoSwitch')
    .attr('x', SW.x).attr('y', SW.y).attr('width', SW.w).attr('height', SW.h).attr('rx', SW.rx);
  svg.append('text').attr('class', 'topoSwitchText').attr('text-anchor', 'middle')
    .attr('x', SW.x + SW.w / 2).attr('y', SW.y + 22).text('DUT SWITCH');

  // ── 6 switch ports (2 rows × 3 cols) ────────────────────────────────────
  const PW = 52, PH = 34, PGAP = 7;
  const pxStart = SW.x + (SW.w - 3 * PW - 2 * PGAP) / 2;
  const rowY = [SW.y + 34, SW.y + SW.h - PH - 14];
  const swPortCenters = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const p = row * 3 + col;
      const px = pxStart + col * (PW + PGAP);
      const py = rowY[row];
      swPortCenters[p] = { cx: px + PW / 2, cy: py + PH / 2 };
      const up = portLinkStatus[p];
      const dotColor = up === true ? '#22c55e' : up === false ? '#ef4444' : '#888';
      const isActive = pairs.some((_, i) => i % 6 === p);
      svg.append('rect').attr('x', px).attr('y', py).attr('width', PW).attr('height', PH).attr('rx', 6)
        .attr('fill', isActive ? '#0b5cab' : 'rgba(200,215,230,.8)')
        .attr('stroke', dotColor).attr('stroke-width', 2);
      svg.append('circle')
        .attr('cx', px + PW - 8).attr('cy', py + 8).attr('r', 4).attr('fill', dotColor);
      svg.append('text').attr('text-anchor', 'middle').attr('font-size', '11px').attr('font-weight', '700')
        .attr('x', px + PW / 2).attr('y', py + PH / 2 + 5)
        .attr('fill', isActive ? '#fff' : '#4a6070').text(`P${p}`);
    }
  }

  if (!pairs.length) {
    svg.append('text').attr('class', 'topoSubtext').attr('text-anchor', 'middle')
      .attr('x', W / 2).attr('y', H - 18).text('Probe peer and select interface pairs');
    return;
  }

  // ── PC node boxes ────────────────────────────────────────────────────────
  const PCW = 190, PCH = Math.max(130, pairs.length * 54 + 36), pcY = H / 2 - PCH / 2;
  const sX = 14, rX = W - 14 - PCW;
  svg.append('rect').attr('class', 'topoNode').attr('x', sX).attr('y', pcY).attr('width', PCW).attr('height', PCH).attr('rx', 20);
  svg.append('rect').attr('class', 'topoNode').attr('x', rX).attr('y', pcY).attr('width', PCW).attr('height', PCH).attr('rx', 20);
  svg.append('text').attr('class', 'topoSubtext').attr('text-anchor', 'middle').attr('x', sX + PCW / 2).attr('y', pcY + 22).text('THIS PC / SENDER');
  svg.append('text').attr('class', 'topoSubtext').attr('text-anchor', 'middle').attr('x', rX + PCW / 2).attr('y', pcY + 22).text('PEER PC / RECEIVER');

  // ── Per-pair: port boxes + connection paths ──────────────────────────────
  pairs.forEach((pair, i) => {
    const portIdx = i % 6;
    const sp = swPortCenters[portIdx];
    const laneY = Math.max(pcY + 34, Math.min(pcY + PCH - 34, pcY + 36 + i * 54));
    const cls = i % 2 ? 'alt' : '';
    const sIface = ifaceByName(senderNode, pair.senderIf);
    const rIface = ifaceByName(receiverNode, pair.receiverIf);

    // Sender port
    svg.append('rect').attr('class', `topoPort ${cls}`)
      .attr('x', sX + 12).attr('y', laneY - 18).attr('width', PCW - 24).attr('height', 36).attr('rx', 10);
    svg.append('text').attr('class', 'topoText').attr('text-anchor', 'middle')
      .attr('x', sX + PCW / 2).attr('y', laneY - 2).text(escapeHtml(pair.senderIf));
    svg.append('text').attr('class', 'topoSubtext').attr('text-anchor', 'middle')
      .attr('x', sX + PCW / 2).attr('y', laneY + 14).text(ifaceIp(sIface) || '-');

    // Link: sender → switch
    svg.append('path').attr('class', `topoLink ${cls}`)
      .attr('d', `M${sX + PCW - 12},${laneY} C${SW.x - 60},${laneY},${SW.x - 10},${sp.cy},${SW.x},${sp.cy}`);

    // Receiver port
    svg.append('rect').attr('class', `topoPort peer ${cls}`)
      .attr('x', rX + 12).attr('y', laneY - 18).attr('width', PCW - 24).attr('height', 36).attr('rx', 10);
    svg.append('text').attr('class', 'topoText').attr('text-anchor', 'middle')
      .attr('x', rX + PCW / 2).attr('y', laneY - 2).text(escapeHtml(pair.receiverIf));
    svg.append('text').attr('class', 'topoSubtext').attr('text-anchor', 'middle')
      .attr('x', rX + PCW / 2).attr('y', laneY + 14).text(ifaceIp(rIface) || '-');

    // Link: switch → receiver
    svg.append('path').attr('class', `topoLink ${cls}`)
      .attr('d', `M${SW.x + SW.w},${sp.cy} C${SW.x + SW.w + 10},${sp.cy},${rX + 60},${laneY},${rX + 12},${laneY}`);
  });
}

function initControlRunBoard(title, pairs) {
  const board = $('controlRunBoard');
  const cards = $('controlRunCards');
  if (!board || !cards) return;
  $('controlRunTitle').textContent = title;
  $('controlRunSummary').textContent = `${pairs.length} pair(s) queued`;
  cards.innerHTML = pairs.map((pair, index) => `
    <div class="controlRunCard" data-run-index="${index}" data-topo-index="${pair.topoIndex ?? index}">
      <div class="controlRunPair">
        <strong>${escapeHtml(pair.label)}</strong>
        <span class="controlRunBadge">pending</span>
      </div>
      <div class="controlRunMetrics"></div>
      <div class="controlRunError hidden"></div>
    </div>
  `).join('');
  board.classList.remove('hidden');
}

function updateControlRunSummary(done, total, okCount) {
  const el = $('controlRunSummary');
  if (el) el.textContent = `${done}/${total} done · ${okCount} pass`;
}

function updateControlRunCard(index, status, metrics = {}, error = '') {
  const card = document.querySelector(`.controlRunCard[data-run-index="${index}"]`);
  if (!card) return;
  card.classList.remove('running', 'ok', 'fail');
  if (status !== 'pending') card.classList.add(status);
  const badge = card.querySelector('.controlRunBadge');
  if (badge) badge.textContent = status;
  const metricEl = card.querySelector('.controlRunMetrics');
  if (metricEl) {
    metricEl.innerHTML = Object.entries(metrics).map(([key, value]) => `
      <div><span>${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>
    `).join('');
  }
  const errEl = card.querySelector('.controlRunError');
  if (errEl) {
    errEl.textContent = error || '';
    errEl.classList.toggle('hidden', !error);
  }
  updateTopologyLinkStatus(card.dataset.topoIndex ?? index, status);
}

function updateTopologyLinkStatus(index, status) {
  document.querySelectorAll(`[data-topo-index="${index}"]`).forEach((item) => {
    item.classList.remove('running', 'ok', 'fail');
    if (['running', 'ok', 'fail'].includes(status)) item.classList.add(status);
  });
}

function packetProtocol(decoded) {
  if (decoded?.arp) return 'ARP';
  if (decoded?.icmp) return 'ICMP';
  if (decoded?.udp) return 'UDP';
  if (decoded?.tcp) return 'TCP';
  if (decoded?.ipv4) return `IP ${decoded.ipv4.protocol}`;
  return decoded?.ethernet?.etherType || '-';
}

function packetSrc(decoded) {
  return decoded?.ipv4?.src || decoded?.arp?.senderIp || decoded?.ethernet?.srcMac || '-';
}

function packetDst(decoded) {
  return decoded?.ipv4?.dst || decoded?.arp?.targetIp || decoded?.ethernet?.dstMac || '-';
}

function renderControlPackets(frames, pairLabel = '') {
  const panel = $('controlPacketPanel');
  const rows = $('controlPacketRows');
  if (!panel || !rows) return;
  state.controlFrames = (frames || []).map((frame) => ({ ...frame, pairLabel: pairLabel || frame.pairLabel || '-' }));
  paintControlPacketTable();
}

function paintControlPacketTable() {
  const panel = $('controlPacketPanel');
  const rows = $('controlPacketRows');
  if (!panel || !rows) return;
  const total = state.controlFrames.length;
  const start = Math.max(0, total - 120);
  const sample = state.controlFrames.slice(start);
  rows.innerHTML = sample.map((frame, offset) => {
    const decoded = frame.decoded || {};
    return `
      <tr>
        <td>${start + offset + 1}</td>
        <td>${escapeHtml(frame.pairLabel || '-')}</td>
        <td class="iface">${escapeHtml(frame.interface || '-')}</td>
        <td>${escapeHtml(packetProtocol(decoded))}</td>
        <td class="addr">${escapeHtml(packetSrc(decoded))}</td>
        <td class="addr">${escapeHtml(packetDst(decoded))}</td>
        <td>${escapeHtml(frame.length ?? '-')}</td>
        <td class="hex" title="${escapeHtml(frame.frameHex || '')}">${escapeHtml((frame.frameHex || '').slice(0, 96))}</td>
      </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No captured frames available for this run</td></tr>';
  $('controlPacketSummary').textContent = `${total} frame(s)${total > sample.length ? ` · showing latest ${sample.length}` : ''}`;
  panel.dataset.frameCount = String(total);
  panel.classList.remove('hidden');
  renderControlPacketCharts();
}

function appendControlPackets(frames, pairLabel = '') {
  if ($('controlPacketPanel')?.classList.contains('hidden')) {
    renderControlPackets(frames, pairLabel);
    return;
  }
  const tagged = (frames || []).map((frame) => ({ ...frame, pairLabel: pairLabel || frame.pairLabel || '-' }));
  state.controlFrames.push(...tagged);
  paintControlPacketTable();
}

function renderControlPacketCharts() {
  const frames = state.controlFrames || [];
  renderMiniBarChart('controlProtocolChart', countBy(frames, (frame) => packetProtocol(frame.decoded || {})));
  renderMiniBarChart('controlPairChart', countBy(frames, (frame) => frame.pairLabel || '-'));
}

function countBy(items, getKey) {
  const out = new Map();
  for (const item of items) {
    const key = getKey(item) || '-';
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function renderMiniBarChart(svgId, rows) {
  const svg = $(svgId);
  if (!svg) return;
  if (!rows.length) {
    svg.innerHTML = '<text x="180" y="64" text-anchor="middle" class="miniChartEmpty">No packets yet</text>';
    return;
  }
  const max = Math.max(...rows.map(([, value]) => value), 1);
  svg.innerHTML = rows.map(([label, value], index) => {
    const y = 12 + index * 17;
    const width = Math.max(4, Math.round((value / max) * 190));
    return `
      <text x="8" y="${y + 10}" class="miniChartLabel">${escapeHtml(label)}</text>
      <rect x="130" y="${y}" width="${width}" height="11" rx="5" class="miniChartBar"></rect>
      <text x="${136 + width}" y="${y + 10}" class="miniChartValue">${value}</text>
    `;
  }).join('');
}

async function apiReport(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.report) throw new Error(data.error || data.stderr || `HTTP ${res.status}`);
  return data;
}

function controlSuiteStages(pair) {
  const burst = Number($('e2eBurst').value || 5);
  const e2eInterval = Number($('e2eInterval').value || 200);
  const benchCount = Number($('benchCount').value || 500);
  const benchInterval = Number($('benchInterval').value || 1);
  const profile = getProfile();
  return [
    {
      name: 'E2E',
      path: '/api/e2e-test',
      body: {
        senderUrl: pair.senderUrl,
        receiverUrl: pair.receiverUrl,
        senderInterface: pair.senderIf,
        receiverInterface: pair.receiverIf,
        profile: { ...profile, count: burst, intervalMs: e2eInterval },
        timeoutSec: Math.max(5, Math.ceil((burst * e2eInterval) / 1000) + 3),
        maxFrames: Math.max(50, burst + 20)
      },
      summarize(data) {
        const r = data.report;
        return {
          ok: Boolean(r.ok),
          metrics: { tx: r.sent?.framesSent ?? 0, match: r.matchCount ?? 0, capture: r.captureSummary?.total ?? 0 },
          error: r.ok ? '' : 'No matching frame captured.'
        };
      }
    },
    {
      name: 'Wire',
      path: '/api/wire-validation',
      body: {
        senderUrl: pair.senderUrl,
        receiverUrl: pair.receiverUrl,
        senderInterface: pair.senderIf,
        receiverInterface: pair.receiverIf,
        count: 2,
        intervalMs: 100
      },
      summarize(data) {
        const s = data.report.summary;
        return {
          ok: Boolean(data.report.ok),
          metrics: { sent: s.framesSent ?? 0, match: s.matched ?? 0, failed: s.failed ?? 0 },
          error: data.report.ok ? '' : 'Validation step failed.'
        };
      }
    },
    {
      name: 'Benchmark',
      path: '/api/benchmark',
      body: {
        senderUrl: pair.senderUrl,
        receiverUrl: pair.receiverUrl,
        senderInterface: pair.senderIf,
        receiverInterface: pair.receiverIf,
        profile,
        count: benchCount,
        intervalMs: benchInterval,
        payloadSize: Number($('benchPayloadSize').value || 64)
      },
      summarize(data) {
        const s = data.report.stats;
        const ok = Number(s.rxCount || 0) > 0;
        return {
          ok,
          metrics: { rx: `${s.rxCount}/${s.txCount}`, loss: `${Number(s.lossPct || 0).toFixed(2)}%`, mbps: Number(s.throughputMbps || 0).toFixed(2) },
          error: ok ? '' : 'Receiver got 0 benchmark packets.'
        };
      }
    },
    {
      name: 'Sweep',
      path: '/api/sweep',
      body: {
        senderUrl: pair.senderUrl,
        receiverUrl: pair.receiverUrl,
        senderInterface: pair.senderIf,
        receiverInterface: pair.receiverIf,
        count: benchCount,
        intervalMs: benchInterval
      },
      summarize(data) {
        const rows = data.report.results || [];
        const totalRx = rows.reduce((sum, row) => sum + Number(row.stats?.rxCount || 0), 0);
        const avgLoss = rows.length ? rows.reduce((sum, row) => sum + Number(row.stats?.lossPct || 0), 0) / rows.length : 100;
        return {
          ok: rows.length > 0,
          metrics: { sizes: rows.length, rx: totalRx, loss: `${avgLoss.toFixed(2)}%` },
          error: rows.length ? '' : 'No sweep result.'
        };
      }
    },
    {
      name: 'RFC2544',
      path: '/api/rfc2544',
      body: {
        senderUrl: pair.senderUrl,
        receiverUrl: pair.receiverUrl,
        senderInterface: pair.senderIf,
        receiverInterface: pair.receiverIf,
        trialDurationSec: Number($('rfcTrial').value || 2),
        linkRateMbps: Number($('rfcLink').value || 1000),
        tolerancePps: Number($('rfcTol').value || 100)
      },
      summarize(data) {
        const rows = data.report.results || [];
        const avgUtil = rows.length ? rows.reduce((sum, row) => sum + Number(row.utilizationPct || 0), 0) / rows.length : 0;
        return {
          ok: rows.length > 0,
          metrics: { sizes: rows.length, util: `${avgUtil.toFixed(1)}%`, report: 'saved' },
          error: rows.length ? '' : 'No RFC2544 result.'
        };
      }
    }
  ];
}

function renderNodeGrid() {
  const sender = state.nodes.sender;
  const receiver = state.nodes.receiver;
  const senderIfs = selectedControlInterfaces('sender');
  const receiverIfs = selectedControlInterfaces('receiver');
  const senderIface = sender?.interfaces?.find((iface) => iface.name === senderIfs[0]);
  const receiverIface = receiver?.interfaces?.find((iface) => iface.name === receiverIfs[0]);
  $('nodeGrid').innerHTML = `
    <div>
      <span>Sender</span>
      <strong>${senderIfs.length > 1 ? `${senderIfs[0]} +${senderIfs.length - 1}` : senderIface?.name || '-'}</strong>
      <small>${sender?.url || '-'} ${senderIface?.ipv4?.[0]?.local || ''}</small>
    </div>
    <div>
      <span>Receiver</span>
      <strong>${receiverIfs.length > 1 ? `${receiverIfs[0]} +${receiverIfs.length - 1}` : receiverIface?.name || '-'}</strong>
      <small>${receiver?.url || '-'} ${receiverIface?.ipv4?.[0]?.local || ''}</small>
    </div>
  `;
}

async function probeNode(url, role) {
  const result = await api('/api/probe-node', {
    method: 'POST',
    body: JSON.stringify({ url })
  });
  state.nodes[role] = { url: result.url, interfaces: result.interfaces };
  renderInterfaceOptions(role === 'sender' ? 'senderNodeInterface' : 'receiverNodeInterface', result.interfaces);
  renderControlInterfacePicker(role, result.interfaces, $(controlSelectId(role))?.value || '');
}

async function fetchBackendStatus(url = '') {
  const target = url ? `${url.replace(/\/+$/, '')}/api/backend/status` : '/api/backend/status';
  const res = await fetch(target, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (url && res.status === 404) return fetchLegacyBackendStatus(url);
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchLegacyBackendStatus(url) {
  const base = url.replace(/\/+$/, '');
  const [health, workers, ifaces] = await Promise.all([
    fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => ({})),
    fetch(`${base}/api/workers`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => ({ workers: [] })),
    fetch(`${base}/api/interfaces`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({ interfaces: [] }))
  ]);
  const connected = Boolean(health.csharpWorker?.connected || health.localWorker?.connected || (workers.workers || []).length);
  return {
    ok: true,
    mode: connected ? 'csharp-worker' : 'legacy-node',
    worker: { connected, id: health.localWorker?.id || 'local', info: health.localWorker?.info || {} },
    nodeNative: {
      packetSend: connected,
      packetCapture: connected,
      cap: null,
      tcpdump: null,
      serial: connected,
      serialOpen: connected,
      interfaces: ifaces.interfaces || []
    },
    features: {
      send: connected,
      capture: connected,
      serial: connected,
      register: connected,
      fdb: connected,
      mdio: connected,
      reports: true
    }
  };
}

function renderBackendStatus(hostId, data, err = null) {
  const host = $(hostId);
  if (!host) return;
  if (err) {
    host.innerHTML = `<div class="backendModeLine"><strong class="failText">offline</strong></div>
      <div class="backendIfaceLine">${escapeHtml(err.message || err)}</div>`;
    return;
  }
  const f = data.features || {};
  const nn = data.nodeNative || {};
  const featureRows = [
    ['send', f.send],
    ['capture', f.capture],
    ['serial', f.serial],
    ['register', f.register],
    ['mdio', f.mdio],
    ['report', f.reports]
  ].map(([name, ok]) => `<span class="backendFeature ${ok ? 'ok' : 'fail'}">${name}</span>`).join('');
  const labIfaces = (nn.interfaces || []).filter(isControlLabInterface);
  const ifaceLine = labIfaces.length
    ? labIfaces.map((i) => `<code>${escapeHtml(i.name)}</code>${i.ipv4?.[0]?.local ? ` ${escapeHtml(i.ipv4[0].local)}` : ''}`).join(' · ')
    : `${(nn.interfaces || []).length} interface(s), no 169.254 lab NIC auto-detected`;
  const capText = nn.cap === null ? 'unknown' : nn.cap ? 'yes' : 'no';
  const tcpdumpText = nn.tcpdump === null ? 'unknown' : nn.tcpdump ? 'yes' : 'no';
  host.innerHTML = `
    <div class="backendModeLine">
      <strong>${escapeHtml(data.mode || 'unknown')}</strong>
      <span class="${data.worker?.connected ? 'passText' : 'muted'}">${data.worker?.connected ? 'C# worker' : 'Node native'}</span>
    </div>
    <div class="backendFeatureRow">${featureRows}</div>
    <div class="backendIfaceLine">cap: ${capText} · tcpdump: ${tcpdumpText} · serial: ${nn.serialOpen ? 'open' : nn.serial ? 'ready' : 'no'}</div>
    <div class="backendIfaceLine">${ifaceLine}</div>
  `;
}

async function refreshBackendStatus() {
  const peerUrl = $('peerUrlPin')?.value.trim() || state.peer.url || DEFAULT_PEER_URL;
  if ($('backendPeerUrl')) $('backendPeerUrl').textContent = peerUrl || '-';
  await Promise.all([
    fetchBackendStatus()
      .then((data) => renderBackendStatus('backendLocalStatus', data))
      .catch((err) => renderBackendStatus('backendLocalStatus', null, err)),
    peerUrl
      ? fetchBackendStatus(peerUrl)
        .then((data) => renderBackendStatus('backendPeerStatus', data))
        .catch((err) => renderBackendStatus('backendPeerStatus', null, err))
      : Promise.resolve(renderBackendStatus('backendPeerStatus', null, new Error('Peer URL not set')))
  ]);
}

async function probeNodes() {
  setStatus('Probing remote nodes...');
  await Promise.all([
    probeNode($('senderNodeUrl').value, 'sender'),
    probeNode($('receiverNodeUrl').value, 'receiver')
  ]);
  refreshBackendStatus().catch(() => {});
  renderNodeGrid();
  setStatus('Nodes ready');
}

function renderE2EReport(report) {
  $('reportSummary').innerHTML = `
    <div><span>Status</span><strong>${report.ok ? 'PASS' : 'FAIL'}</strong></div>
    <div><span>Captured</span><strong>${report.captureSummary.total}</strong></div>
    <div><span>Matched</span><strong>${report.matchCount}</strong></div>
  `;
  $('reportRows').innerHTML = report.capturedFrames.length
    ? report.capturedFrames.map((frame, index) => {
      const decoded = frame.decoded || {};
      return `
        <tr>
          <td>${index + 1}</td>
          <td>E2E</td>
          <td>${decoded.arp ? 'ARP' : decoded.icmp ? 'ICMP' : decoded.udp ? 'UDP' : decoded.ethernet?.etherType || '-'}</td>
          <td class="passText">MATCH</td>
          <td>${frame.length}</td>
          <td>${decoded.ethernet?.srcMac || '-'}</td>
          <td>${decoded.ipv4?.src || decoded.arp?.senderIp || ''} -> ${decoded.ipv4?.dst || decoded.arp?.targetIp || ''}</td>
        </tr>
      `;
    }).join('')
    : '<tr><td colspan="7" class="empty">No matching frames captured</td></tr>';
  $('openE2EReport')?.classList.remove('disabled');
}

async function runE2E() {
  if ($('runE2E').disabled) return;
  $('runE2E').disabled = true;
  const prog = progressFor('progE2E');
  setActionStatus('statusE2E', 'running', 'running');
  prog.start(7);
  setStatus('Running end-to-end test...');
  try {
    await ensurePeerReady();
    syncControlFromPeer();
    const pairs = selectedControlPairs();
    const burst = Number($('e2eBurst').value || 5);
    const e2eInterval = Number($('e2eInterval').value || 200);
    const profile = { ...getProfile(), count: burst, intervalMs: e2eInterval };
    prog.start(7 * pairs.length);
    initControlRunBoard('E2E Progress', pairs);
    const results = [];
    for (const [index, pair] of pairs.entries()) {
      setStatus(`Running E2E ${index + 1}/${pairs.length}: ${pair.label}`);
      updateControlRunCard(index, 'running', { tx: '-', match: '-', capture: '-' });
      try {
        const result = await apiReport('/api/e2e-test', {
          senderUrl: pair.senderUrl,
          receiverUrl: pair.receiverUrl,
          senderInterface: pair.senderIf,
          receiverInterface: pair.receiverIf,
          profile,
          timeoutSec: Math.max(5, Math.ceil((burst * e2eInterval) / 1000) + 3),
          maxFrames: Math.max(50, burst + 20)
        });
        results.push({ pair, report: result.report });
        renderE2EReport(result.report);
        appendControlPackets(result.report.capturedFrames || [], pair.label);
        updateControlRunCard(index, result.report.ok ? 'ok' : 'fail', {
          tx: result.report.sent?.framesSent ?? 0,
          match: result.report.matchCount ?? 0,
          capture: result.report.captureSummary?.total ?? 0
        }, result.report.ok ? '' : 'No matching frame captured for this pair.');
      } catch (err) {
        results.push({ pair, error: err });
        updateControlRunCard(index, 'fail', { tx: 0, match: 0, capture: 0 }, err.message);
      }
      updateControlRunSummary(index + 1, pairs.length, results.filter((item) => item.report?.ok).length);
    }
    const pass = results.filter((item) => item.report?.ok).length;
    const matches = results.reduce((sum, item) => sum + Number(item.report?.matchCount || 0), 0);
    const ok = pass === results.length;
    setActionStatus('statusE2E', ok ? 'ok' : 'fail', `${pass}/${results.length} pairs · ${matches} match`);
    if (ok) prog.finish(); else prog.fail();
    setStatus(`E2E ${ok ? 'PASS' : 'FAIL'}: ${pass}/${results.length} pair(s), ${matches} matching frame(s)`, !ok);
  } catch (err) {
    setActionStatus('statusE2E', 'fail', 'fail');
    prog.fail();
    throw err;
  } finally {
    $('runE2E').disabled = false;
  }
}

async function runReport() {
  if ($('runReport').disabled) return;
  $('runReport').disabled = true;
  const prog = progressFor('progReport');
  setActionStatus('statusReport', 'running', 'running');
  prog.start(25);
  setStatus('Running on-wire standard validation...');
  try {
    await ensurePeerReady();
    syncControlFromPeer();
    const pairs = selectedControlPairs();
    prog.start(25 * pairs.length);
    initControlRunBoard('Wire Validation Progress', pairs);
    const results = [];
    for (const [index, pair] of pairs.entries()) {
      setStatus(`Running wire validation ${index + 1}/${pairs.length}: ${pair.label}`);
      updateControlRunCard(index, 'running', { sent: '-', match: '-', failed: '-' });
      try {
        const result = await apiReport('/api/wire-validation', {
          senderUrl: pair.senderUrl,
          receiverUrl: pair.receiverUrl,
          senderInterface: pair.senderIf,
          receiverInterface: pair.receiverIf,
          count: 2,
          intervalMs: 100
        });
        results.push({ pair, report: result.report });
        appendControlPackets(result.report.capturedFrames || [], pair.label);
        updateControlRunCard(index, result.report.ok ? 'ok' : 'fail', {
          sent: result.report.summary?.framesSent ?? 0,
          match: result.report.summary?.matched ?? 0,
          failed: result.report.summary?.failed ?? 0
        }, result.report.ok ? '' : 'One or more validation steps failed.');
      } catch (err) {
        results.push({ pair, error: err });
        updateControlRunCard(index, 'fail', { sent: 0, match: 0, failed: 1 }, err.message);
      }
      updateControlRunSummary(index + 1, pairs.length, results.filter((item) => item.report?.ok).length);
    }
    const lastReport = [...results].reverse().find((item) => item.report)?.report;
    const failedPairs = results.filter((item) => !item.report?.ok).length;
    const framesSent = results.reduce((sum, item) => sum + Number(item.report?.summary?.framesSent || 0), 0);
    const matched = results.reduce((sum, item) => sum + Number(item.report?.summary?.matched || 0), 0);
    $('reportSummary').innerHTML = `
      <div><span>Status</span><strong>${failedPairs === 0 ? 'PASS' : 'FAIL'}</strong></div>
      <div><span>Pairs</span><strong>${results.length - failedPairs}/${results.length}</strong></div>
      <div><span>Sent</span><strong>${framesSent}</strong></div>
      <div><span>Matched</span><strong>${matched}</strong></div>
    `;
    $('reportRows').innerHTML = lastReport ? lastReport.steps.map((step, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>Wire</td>
        <td>${step.name}</td>
        <td class="${step.ok ? 'passText' : 'failText'}">${step.ok ? 'PASS' : 'FAIL'}</td>
        <td>${step.framesSent ?? '-'}</td>
        <td>${step.protocol || step.kind}</td>
        <td>${step.kind === 'delay' ? `${step.delayMs} ms` : `${step.matchCount || 0} match`}</td>
      </tr>
    `).join('') : '<tr><td colspan="7" class="empty">No report generated</td></tr>';
    $('openReport')?.classList.remove('disabled');
    $('openCaseReport')?.classList.remove('disabled');
    setActionStatus('statusReport', failedPairs === 0 ? 'ok' : 'fail', `${results.length - failedPairs}/${results.length} pairs`);
    if (failedPairs === 0) prog.finish(); else prog.fail();
    setStatus(`Wire validation ${failedPairs === 0 ? 'PASS' : 'FAIL'}: ${results.length - failedPairs}/${results.length} pair(s), ${matched}/${framesSent} matched`, failedPairs > 0);
  } catch (err) {
    setActionStatus('statusReport', 'fail', 'fail');
    prog.fail();
    throw err;
  } finally {
    $('runReport').disabled = false;
  }
}

document.querySelectorAll('[data-example]').forEach((button) => {
  button.addEventListener('click', () => {
    const item = state.exampleItems.find((entry) => entry.key.includes(button.dataset.example));
    if (item) {
      $('profileSelect').value = item.key;
      setProfile(item.profile);
    }
  });
});

$('profileSelect').addEventListener('change', () => {
  const item = state.exampleItems.find((entry) => entry.key === $('profileSelect').value);
  if (item) setProfile(item.profile);
});

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.roleView').forEach((view) => view.classList.remove('active'));
    button.classList.add('active');
    $(button.dataset.view).classList.add('active');
    const v = button.dataset.view;
    document.body.classList.toggle('captureMode', v === 'captureView');
    document.body.classList.toggle('senderMode',  v === 'senderView');
    if (v !== 'hyperTerminalView') {
      document.body.classList.remove('serialMode', 'controlMode');
    } else {
      const activeHt = document.querySelector('.htSubTab.active');
      document.body.classList.toggle('serialMode',  activeHt?.dataset.htview === 'serialView');
      document.body.classList.toggle('controlMode', activeHt?.dataset.htview === 'controlView');
    }
    mirrorIfaceSelectionToHiddenSelect();
  });
});

// HyperTerminal sub-tab handler
document.querySelectorAll('[data-htview]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-htview]').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.htSubView').forEach((v) => v.classList.remove('active'));
    button.classList.add('active');
    $(button.dataset.htview).classList.add('active');
    const hv = button.dataset.htview;
    document.body.classList.toggle('serialMode',  hv === 'serialView');
    document.body.classList.toggle('controlMode', hv === 'controlView');
    if (hv === 'serialView' && !state.serial.ports.length) refreshTtyList().catch(() => {});
    if (hv === 'registerView') regLoadStatus().catch(() => {});
    if (hv === 'controlView') renderPairCard();
    mirrorIfaceSelectionToHiddenSelect();
  });
});

// Navigate to a view by ID — handles both top-level and HyperTerminal sub-views
function showView(viewId) {
  const HT_SUBVIEWS = ['serialView', 'registerView', 'fdbView', 'autoView', 'controlView'];
  if (HT_SUBVIEWS.includes(viewId)) {
    document.querySelector('[data-view="hyperTerminalView"]')?.click();
    document.querySelector(`[data-htview="${viewId}"]`)?.click();
  } else {
    document.querySelector(`[data-view="${viewId}"]`)?.click();
  }
}

// ----------- Serial / TTY console -----------
state.serial = { ports: [], sessionId: null, reader: null, abort: null, rxCount: 0, txCount: 0 };

const HEX_ESCAPE_RE = /\\x([0-9a-fA-F]{2})/g;
function expandEscapes(s) {
  return s
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\0/g, '\0')
    .replace(HEX_ESCAPE_RE, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function appendSerialLog(text, cls) {
  const log = $('serialLog');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  log.appendChild(span);
  if (atBottom) log.scrollTop = log.scrollHeight;
  // Trim buffer to 4000 child nodes to avoid memory growth
  while (log.childNodes.length > 4000) log.removeChild(log.firstChild);
}

function renderRxBytes(bytes) {
  if ($('serialHex').checked) {
    appendSerialLog(bytesToHex(bytes).match(/.{1,2}/g).join(' ') + ' ');
  } else {
    let s = '';
    for (const b of bytes) {
      if (b === 0x0d) continue;             // collapse CRLF for terminal feel
      if (b === 0x0a) { s += '\n'; continue; }
      if (b === 0x09) { s += '\t'; continue; }
      if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
      else s += `·`; // middle dot for non-printable
    }
    appendSerialLog(s);
  }
}

async function refreshTtyList() {
  const r = await api('/api/tty/list');
  state.serial.ports = r.ttys || [];
  const sel = $('serialPort');
  if (!state.serial.ports.length) {
    sel.innerHTML = '<option value="">no TTY found (plug in a USB serial adapter and click ↻)</option>';
    $('serialPortHint').textContent = 'No /dev/tty(USB|ACM)* devices visible. Plug in a USB-serial / FTDI / CDC-ACM adapter and refresh.';
    return;
  }
  sel.innerHTML = state.serial.ports.map((p) => {
    const label = [p.name, p.usbProduct || p.product || p.driver, p.usbId, p.serial]
      .filter(Boolean).join(' · ');
    return `<option value="${p.path}">${label}</option>`;
  }).join('');
  const sel0 = state.serial.ports[0];
  $('serialPortHint').textContent = `${sel0.path}  ${sel0.manufacturer || ''} ${sel0.usbProduct || ''} ${sel0.usbId ? '['+sel0.usbId+']' : ''}`.trim();
  sel.addEventListener('change', () => {
    const p = state.serial.ports.find((x) => x.path === sel.value);
    if (!p) return;
    $('serialPortHint').textContent = `${p.path}  ${p.manufacturer || ''} ${p.usbProduct || ''} ${p.usbId ? '['+p.usbId+']' : ''}`.trim();
  }, { once: true });
}

async function serialConnect() {
  if (state.serial.sessionId) return;
  const path = $('serialPort').value;
  if (!path) { toast('Pick a TTY first.','warn'); return; }
  state.serial.rxCount = 0; state.serial.txCount = 0;
  $('serRx').textContent = '0'; $('serTx').textContent = '0';
  $('serState').textContent = 'opening…'; $('serState').className = 'statChip';
  try {
    const r = await api('/api/tty/open', {
      method: 'POST',
      body: JSON.stringify({
        path,
        baudRate: Number($('serialBaud').value),
        dataBits: Number($('serialData').value),
        parity: $('serialParity').value,
        stopBits: Number($('serialStop').value),
        hwFlow: $('serialFlow').checked
      })
    });
    state.serial.sessionId = r.sessionId;
  } catch (err) {
    appendSerialLog(`open failed: ${err.message}\n`, 'err');
    $('serState').textContent = 'idle';
    return;
  }
  $('serialConnect').disabled = true;
  $('serialDisconnect').disabled = false;
  $('serialInput').disabled = false;
  $('serialBreak').disabled = false;
  $('serState').textContent = 'connected';
  $('serState').className = 'statChip connected';
  appendSerialLog(`-- opened ${path} @ ${$('serialBaud').value} ${$('serialData').value}${$('serialParity').value}${$('serialStop').value} --\n`, 'info');

  const ctrl = new AbortController();
  state.serial.abort = ctrl;
  const res = await fetch(`/api/tty/stream?session=${state.serial.sessionId}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  state.serial.reader = reader;
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'rx' && ev.hex) {
          const bytes = hexToBytes(ev.hex);
          state.serial.rxCount += bytes.length;
          $('serRx').textContent = state.serial.rxCount;
          renderRxBytes(bytes);
        } else if (ev.type === 'error') {
          appendSerialLog(`[err] ${ev.message}\n`, 'err');
        } else if (ev.type === 'closed') {
          appendSerialLog(`-- closed --\n`, 'info');
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') appendSerialLog(`[stream err] ${err.message}\n`, 'err');
  } finally {
    serialFinish();
  }
}

function serialFinish() {
  state.serial.sessionId = null;
  state.serial.reader = null;
  state.serial.abort = null;
  $('serialConnect').disabled = false;
  $('serialDisconnect').disabled = true;
  $('serialInput').disabled = true;
  $('serialBreak').disabled = true;
  $('serState').textContent = 'idle';
  $('serState').className = 'statChip';
}

async function serialDisconnect() {
  if (!state.serial.sessionId) return;
  const id = state.serial.sessionId;
  try { state.serial.abort?.abort(); } catch {}
  try { state.serial.reader?.cancel(); } catch {}
  try { await api('/api/tty/close', { method: 'POST', body: JSON.stringify({ sessionId: id }) }); } catch {}
  serialFinish();
}

async function serialSendInput() {
  if (!state.serial.sessionId) return;
  const inp = $('serialInput');
  const eol = $('serialEol').value;
  const text = expandEscapes(inp.value) + expandEscapes(eol);
  if (!text) return;
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const hex = bytesToHex(bytes);
  try {
    await api('/api/tty/write', { method: 'POST', body: JSON.stringify({ sessionId: state.serial.sessionId, hex }) });
    state.serial.txCount += bytes.length;
    $('serTx').textContent = state.serial.txCount;
    if ($('serialEcho').checked) appendSerialLog(`> ${inp.value}\n`, 'tx');
    inp.value = '';
  } catch (err) {
    appendSerialLog(`tx fail: ${err.message}\n`, 'err');
  }
}

$('serialRefresh')?.addEventListener('click', () => refreshTtyList().catch((e) => toastError(e)));
$('serialConnect')?.addEventListener('click', () => serialConnect().catch((e) => { toastError(e); }));
$('serialDisconnect')?.addEventListener('click', () => serialDisconnect());
$('serialClear')?.addEventListener('click', () => { $('serialLog').innerHTML = ''; });
$('serialBreak')?.addEventListener('click', async () => {
  if (!state.serial.sessionId) return;
  try { await api('/api/tty/control', { method:'POST', body: JSON.stringify({ sessionId: state.serial.sessionId, cmd: 'break' }) }); appendSerialLog('-- break --\n', 'info'); } catch {}
});
$('serialInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); serialSendInput().catch(() => {}); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; }
});

$('refreshInterfaces').addEventListener('click', () => loadInterfaces().catch((err) => {
  toastError(err);
}));
$('interfaceSelect').addEventListener('change', updateInterfaceInfo);
$('protocol').addEventListener('change', () => {
  const isTcp = $('protocol').value === 'tcp';
  const row = $('tcpFlagsRow');
  if (row) row.classList.toggle('hidden', !isTcp);
});
$('build').addEventListener('click', () => build().catch((err) => {
  toastError(err);
}));

// Auto-preview: rebuild the frame whenever the operator changes any sender input.
// Debounced so rapid typing doesn't spam the agent.
let _previewTimer = null;
function schedulePreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(() => {
    // Persist the live form state back into the selected Packet List step
    // so subsequent row clicks reload the user's edits, not the original profile.
    if (state.currentCase && state.selectedStep >= 0) {
      const step = state.currentCase.steps[state.selectedStep];
      if (step?.kind === 'packet') {
        const live = getProfile();
        step.profile = { ...step.profile, ...live };
        $('caseStepPreview').textContent = JSON.stringify(step, null, 2);
      }
    }
    build().catch(() => {});
  }, 250);
}
const SENDER_INPUT_IDS = [
  'protocol','dstMac','srcMac','srcIp','dstIp','srcPort','dstPort',
  'vlanEnabled','vlanId','vlanPriority',
  'payloadMode','payload','payloadSize','payloadByte','targetFrameLength'
];
SENDER_INPUT_IDS.forEach((id) => {
  const el = $(id); if (!el) return;
  const ev = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
  el.addEventListener(ev, schedulePreview);
});
$('send').addEventListener('click', () => send().catch((err) => {
  toastError(err);
}));
$('captureStart').addEventListener('click', () => startCaptureStream().catch((err) => {
  toastError(err);
}));
// Event delegation: one listener for the whole packet table replaces
// per-row listeners (which scaled O(N) and held memory for evicted rows).
$('packetRows')?.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-idx]');
  if (tr) selectPacket(Number(tr.dataset.idx));
});
$('captureStop').addEventListener('click', stopCaptureStream);
$('captureClear').addEventListener('click', clearCapture);
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('captureSavePcap')?.addEventListener('click', () => {
  if (!capture.packets.length) { toast('No packets buffered yet — start a capture first.','warn'); return; }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(buildPcap(capture.packets), `keti-capture-${ts}.pcap`);
});
$('captureSavePcapNg')?.addEventListener('click', () => {
  if (!capture.packets.length) { toast('No packets buffered yet — start a capture first.','warn'); return; }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(buildPcapNg(capture.packets), `keti-capture-${ts}.pcapng`);
});

// --- Open .pcap / .pcapng client-side ---------------------------------
$('captureOpenPcap')?.addEventListener('click', () => $('pcapFileInput')?.click());
$('pcapFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await loadPcapFile(file);
  e.target.value = '';
});

async function loadPcapFile(file) {
  if (capture.reader) {
    toast('Stop the live capture first before opening a file.', 'warn');
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const frames = parsePcapOrPcapNg(new DataView(buf));
    if (!frames.length) { toast(`${file.name}: no frames parsed.`, 'warn'); return; }
    clearCapture();
    let i = 0;
    for (const f of frames) {
      f._idx = i++;
      f.frameHex = f.frameHex || bytesToHex(new Uint8Array(buf, f._dataOffset, f._dataLength));
      f.length = f.frameHex.length / 2;
      // decode in-browser using a slim decoder for at least Ethernet headers;
      // we keep the bytes raw and let the existing UI decode through the
      // existing path (decoded already attached if we have it).
      f.decoded = clientDecode(hexToBytes(f.frameHex));
      capture.packets.push(f);
      capture.totalBytes += f.length;
      if (capture.packets.length > capture.maxBuffer) capture.packets.shift();
    }
    reapplyFilter();
    $('capStatState').textContent = `file · ${frames.length} frames`;
    $('capStatState').className = 'statChip ok';
    toast(`Loaded ${frames.length} frames from ${file.name}`, 'ok');
  } catch (err) {
    toast(`Failed to parse ${file.name}: ${err.message}`, 'fail');
  }
}

// Minimal browser-side decoder (subset of agent decoder, enough for the
// list view + hex highlighting). Covers Ethernet / VLAN / IPv4 / IPv6 /
// UDP / TCP / ICMP / ARP / LLDP / PTP at top level. Server-side decoder
// is still richer; this is "good enough for an offline pcap viewer".
function clientDecode(b) {
  if (b.length < 14) return { length: b.length };
  const macStr = (off) => Array.from(b.slice(off, off + 6)).map((x) => x.toString(16).padStart(2, '0')).join(':');
  const decoded = {
    length: b.length,
    ethernet: { dstMac: macStr(0), srcMac: macStr(6), etherType: '0x' + ((b[12] << 8) | b[13]).toString(16).padStart(4, '0') },
  };
  let off = 14;
  let etype = (b[12] << 8) | b[13];
  if (etype === 0x8100 || etype === 0x88a8) {
    const tci = (b[14] << 8) | b[15];
    decoded.vlan = { tpid: '0x' + etype.toString(16), priority: (tci >> 13) & 0x7, dei: !!(tci & 0x1000), id: tci & 0xfff, etherType: '0x' + ((b[16] << 8) | b[17]).toString(16).padStart(4, '0') };
    etype = (b[16] << 8) | b[17];
    off = 18;
  }
  if (etype === 0x0800 && b.length >= off + 20) {
    const ihl = (b[off] & 0x0f) * 4;
    decoded.ipv4 = {
      src: `${b[off + 12]}.${b[off + 13]}.${b[off + 14]}.${b[off + 15]}`,
      dst: `${b[off + 16]}.${b[off + 17]}.${b[off + 18]}.${b[off + 19]}`,
      ttl: b[off + 8], protocol: b[off + 9],
    };
    const l4 = off + ihl;
    const proto = b[off + 9];
    if (proto === 17 && b.length >= l4 + 8) {
      decoded.udp = { srcPort: (b[l4] << 8) | b[l4 + 1], dstPort: (b[l4 + 2] << 8) | b[l4 + 3], length: (b[l4 + 4] << 8) | b[l4 + 5] };
    } else if (proto === 6 && b.length >= l4 + 20) {
      const offflags = (b[l4 + 12] << 8) | b[l4 + 13];
      const flagBits = [[0x100, 'NS'], [0x80, 'CWR'], [0x40, 'ECE'], [0x20, 'URG'], [0x10, 'ACK'], [0x8, 'PSH'], [0x4, 'RST'], [0x2, 'SYN'], [0x1, 'FIN']];
      decoded.tcp = {
        srcPort: (b[l4] << 8) | b[l4 + 1], dstPort: (b[l4 + 2] << 8) | b[l4 + 3],
        seq: ((b[l4 + 4] << 24) >>> 0) + (b[l4 + 5] << 16) + (b[l4 + 6] << 8) + b[l4 + 7],
        ack: ((b[l4 + 8] << 24) >>> 0) + (b[l4 + 9] << 16) + (b[l4 + 10] << 8) + b[l4 + 11],
        flags: flagBits.filter(([m]) => offflags & m).map(([, n]) => n),
        window: (b[l4 + 14] << 8) | b[l4 + 15], dataOffset: ((offflags >> 12) & 0xf) * 4,
      };
    } else if (proto === 1 && b.length >= l4 + 8) {
      decoded.icmp = { type: b[l4], code: b[l4 + 1], id: (b[l4 + 4] << 8) | b[l4 + 5], seq: (b[l4 + 6] << 8) | b[l4 + 7] };
    }
  } else if (etype === 0x86dd && b.length >= off + 40) {
    const v6 = (start) => {
      const parts = [];
      for (let i = 0; i < 8; i += 1) parts.push(((b[start + i * 2] << 8) | b[start + i * 2 + 1]).toString(16));
      // simple :: collapse for one longest zero run
      const s = parts.join(':');
      return s.replace(/(^|:)(?:0:){2,}/, '::').replace(/^0::/, '::').replace(/::0$/, '::');
    };
    decoded.ipv6 = { src: v6(off + 8), dst: v6(off + 24), hopLimit: b[off + 7], nextHeader: b[off + 6] };
  } else if (etype === 0x0806 && b.length >= off + 28) {
    decoded.arp = {
      operation: (b[off + 6] << 8) | b[off + 7],
      senderMac: macStr(off + 8), senderIp: `${b[off + 14]}.${b[off + 15]}.${b[off + 16]}.${b[off + 17]}`,
      targetMac: macStr(off + 18), targetIp: `${b[off + 24]}.${b[off + 25]}.${b[off + 26]}.${b[off + 27]}`,
    };
  } else if (etype === 0x88cc) decoded.lldp = { tlvs: [] };
  else if (etype === 0x88f7) decoded.ptp = { messageType: b[off] & 0xf };
  return decoded;
}

// libpcap / pcap-ng parser. Returns array of { timestamp, rxTimestampNs, frameHex, length }.
function parsePcapOrPcapNg(view) {
  const magic = view.getUint32(0, true);
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d || magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) {
    return parsePcap(view, magic);
  }
  if (magic === 0x0a0d0d0a) return parsePcapNg(view);
  throw new Error(`unknown magic 0x${magic.toString(16)}`);
}

function parsePcap(view, magic) {
  const LE = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
  const nanoTs = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
  // skip 24-byte global header
  let off = 24;
  const out = [];
  while (off + 16 <= view.byteLength) {
    const sec = view.getUint32(off, LE);
    const subsec = view.getUint32(off + 4, LE);
    const captured = view.getUint32(off + 8, LE);
    off += 16;
    if (off + captured > view.byteLength) break;
    const ns = BigInt(sec) * 1_000_000_000n + BigInt(subsec) * (nanoTs ? 1n : 1000n);
    out.push({ rxTimestampNs: Number(ns), timestamp: Number(ns) / 1e9, _dataOffset: view.byteOffset + off, _dataLength: captured });
    off += captured;
  }
  return out;
}

function parsePcapNg(view) {
  // Section Header Block + Interface Description Blocks + Enhanced/Simple Packet Blocks.
  const out = [];
  let off = 0;
  let tsResol = 6; // default: microseconds (10^-6) per pcapng spec
  while (off + 12 <= view.byteLength) {
    const blockType = view.getUint32(off, true);
    const blockLen = view.getUint32(off + 4, true);
    if (blockLen < 12 || off + blockLen > view.byteLength) break;
    if (blockType === 0x00000001) {
      // IDB — parse options to find if_tsresol
      let p = off + 16; // 8 hdr + 8 (linktype+reserved+snaplen)
      const end = off + blockLen - 4;
      while (p + 4 <= end) {
        const code = view.getUint16(p, true);
        const len = view.getUint16(p + 2, true);
        if (code === 0) break;
        if (code === 9 && len >= 1) {
          const raw = view.getUint8(p + 4);
          tsResol = raw & 0x80 ? (raw & 0x7f) : raw; // bit7 set means base-2; we treat as exponent
        }
        p += 4 + Math.ceil(len / 4) * 4;
      }
    } else if (blockType === 0x00000006 || blockType === 0x00000003) {
      // EPB or SPB
      let dataOff, dataLen, tsNs;
      if (blockType === 0x00000006) {
        const tsHi = view.getUint32(off + 12, true);
        const tsLo = view.getUint32(off + 16, true);
        dataLen = view.getUint32(off + 20, true);
        dataOff = off + 28;
        const tick = BigInt((tsHi >>> 0)) * 0x100000000n + BigInt(tsLo >>> 0);
        // tick × 10^-tsResol seconds → nanoseconds:  ns = tick × 10^(9 - tsResol)
        const expo = 9 - tsResol;
        tsNs = expo >= 0 ? Number(tick * BigInt(10 ** expo)) : Number(tick / BigInt(10 ** -expo));
      } else {
        dataLen = view.getUint32(off + 8, true);
        dataOff = off + 12;
        tsNs = 0;
      }
      if (dataOff + dataLen <= off + blockLen - 4) {
        out.push({ rxTimestampNs: tsNs, timestamp: tsNs / 1e9, _dataOffset: view.byteOffset + dataOff, _dataLength: dataLen });
      }
    }
    off += blockLen;
  }
  return out;
}

// Drag & drop support: drop a .pcap or .pcapng onto the capture pane.
(function attachPcapDnd() {
  const tgt = document.getElementById('captureView');
  if (!tgt) return;
  let depth = 0;
  tgt.addEventListener('dragenter', (e) => { e.preventDefault(); depth += 1; tgt.classList.add('dropping'); });
  tgt.addEventListener('dragover',  (e) => { e.preventDefault(); });
  tgt.addEventListener('dragleave', (e) => { e.preventDefault(); depth -= 1; if (depth <= 0) tgt.classList.remove('dropping'); });
  tgt.addEventListener('drop',      (e) => {
    e.preventDefault(); depth = 0; tgt.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadPcapFile(f);
  });
})();

// Build a libpcap-format file from buffered frames.
// Global header (24 B) + per-packet record (16 B + frame bytes).
// Magic 0xa1b2c3d4 (microsecond timestamps, big-endian write but we use little-endian magic).
function buildPcap(packets) {
  // Compute total size
  let total = 24;
  for (const p of packets) total += 16 + (p.frameHex.length / 2);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  // Global header — little-endian magic 0xa1b2c3d4 means LE byte order, microsecond resolution
  view.setUint32(0, 0xa1b2c3d4, true);
  view.setUint16(4, 2, true);          // version major
  view.setUint16(6, 4, true);          // version minor
  view.setInt32(8, 0, true);           // thiszone (GMT)
  view.setUint32(12, 0, true);         // sigfigs
  view.setUint32(16, 65535, true);     // snaplen
  view.setUint32(20, 1, true);         // LINKTYPE_ETHERNET
  let off = 24;
  for (const p of packets) {
    const ns = p.rxTimestampNs ?? Math.round((p.timestamp || 0) * 1e9);
    const sec = Math.floor(ns / 1_000_000_000);
    const usec = Math.floor((ns % 1_000_000_000) / 1000);
    const len = p.frameHex.length / 2;
    view.setUint32(off, sec, true);
    view.setUint32(off + 4, usec, true);
    view.setUint32(off + 8, len, true);   // captured length
    view.setUint32(off + 12, len, true);  // original length
    off += 16;
    for (let i = 0; i < len; i += 1) {
      view.setUint8(off + i, parseInt(p.frameHex.substr(i * 2, 2), 16));
    }
    off += len;
  }
  return new Blob([buf], { type: 'application/vnd.tcpdump.pcap' });
}

// PCAP-NG (next-generation, RFC-draft format that Wireshark prefers).
// Keeps full nanosecond precision via the if_tsresol option = 9 (10^-9 s).
// We emit one Section Header Block + one Interface Description Block with
// link_type Ethernet + snaplen 65535 + tsresol=9 + a friendly if_name option,
// then one Enhanced Packet Block per captured frame. Packet data is padded to
// a 4-byte boundary as the spec requires.
function buildPcapNg(packets) {
  const enc = new TextEncoder();
  const ifName = enc.encode('keti-lab-capture');
  const pad4 = (n) => (4 - (n & 3)) & 3;

  // Section Header Block (Block Type 0x0a0d0d0a) — version 1.0, section length unknown (-1)
  const shbBody = 28; // BT(4)+TotalLen(4)+ByteOrderMagic(4)+Major(2)+Minor(2)+SectionLen(8)+TotalLen(4)
  const shb = new ArrayBuffer(shbBody);
  const shbV = new DataView(shb);
  shbV.setUint32(0, 0x0a0d0d0a, true);  // Block Type
  shbV.setUint32(4, shbBody, true);     // Block Total Length
  shbV.setUint32(8, 0x1a2b3c4d, true);  // Byte-Order Magic
  shbV.setUint16(12, 1, true);          // Major version
  shbV.setUint16(14, 0, true);          // Minor version
  shbV.setBigInt64(16, -1n, true);      // Section length: unknown
  shbV.setUint32(24, shbBody, true);    // Block Total Length (trailer)

  // Interface Description Block (BT 0x00000001)
  // Body: link_type(2) reserved(2) snaplen(4) [options...]
  // Options: if_name (code 2), if_tsresol (code 9, length 1, value 9 (ns))
  // Each option header: code(2) length(2) value(padded to 4)
  const ifNameOptLen = 4 + ifName.length + pad4(ifName.length);
  const ifTsResOptLen = 4 + 1 + 3; // code+len+value(1)+pad(3) = 8
  const optEnd = 4; // opt_endofopt code 0 length 0
  const idbBodyLen = 8 + ifNameOptLen + ifTsResOptLen + optEnd; // 8 = link_type+reserved+snaplen
  const idbTotal = 4 + 4 + idbBodyLen + 4; // BT + Total + body + Total trailer
  const idb = new ArrayBuffer(idbTotal);
  const idbV = new DataView(idb);
  let p = 0;
  idbV.setUint32(p, 0x00000001, true); p += 4; // BT IDB
  idbV.setUint32(p, idbTotal, true);   p += 4;
  idbV.setUint16(p, 1, true);          p += 2; // LinkType: LINKTYPE_ETHERNET
  idbV.setUint16(p, 0, true);          p += 2; // Reserved
  idbV.setUint32(p, 65535, true);      p += 4; // SnapLen
  // if_name option (code 2)
  idbV.setUint16(p, 2, true);          p += 2;
  idbV.setUint16(p, ifName.length, true); p += 2;
  new Uint8Array(idb, p, ifName.length).set(ifName); p += ifName.length;
  p += pad4(ifName.length);
  // if_tsresol option (code 9): 1 byte = 9 (powers-of-ten resolution, 10^-9 = ns)
  idbV.setUint16(p, 9, true);          p += 2;
  idbV.setUint16(p, 1, true);          p += 2;
  idbV.setUint8 (p, 9);                p += 1;
  p += 3; // pad to 4
  // opt_endofopt (code 0, len 0)
  idbV.setUint16(p, 0, true);          p += 2;
  idbV.setUint16(p, 0, true);          p += 2;
  idbV.setUint32(p, idbTotal, true);            // trailer

  // Enhanced Packet Blocks
  const epbs = [];
  for (const pk of packets) {
    const ns = pk.rxTimestampNs ?? Math.round((pk.timestamp || 0) * 1e9);
    const len = pk.frameHex.length / 2;
    const padLen = pad4(len);
    const total = 4 + 4 + 4 + 4 + 4 + 4 + 4 + len + padLen + 4;
    // BT(4)+Total(4)+IfaceID(4)+TsHi(4)+TsLo(4)+CapLen(4)+OrigLen(4)+data+pad+TotalTrailer(4)
    const buf = new ArrayBuffer(total);
    const v = new DataView(buf);
    let q = 0;
    v.setUint32(q, 0x00000006, true); q += 4; // BT EPB
    v.setUint32(q, total, true);      q += 4;
    v.setUint32(q, 0, true);          q += 4; // Interface ID 0
    // 64-bit ns timestamp split into high/low for endian-safe write
    const big = BigInt(ns);
    v.setUint32(q,     Number(big >> 32n) >>> 0, true); q += 4; // tsHigh
    v.setUint32(q,     Number(big & 0xffffffffn) >>> 0, true); q += 4; // tsLow
    v.setUint32(q, len, true);        q += 4; // captured len
    v.setUint32(q, len, true);        q += 4; // original len
    const u8 = new Uint8Array(buf, q, len);
    for (let i = 0; i < len; i += 1) u8[i] = parseInt(pk.frameHex.substr(i * 2, 2), 16);
    q += len + padLen;
    v.setUint32(q, total, true);      // trailer
    epbs.push(buf);
  }

  return new Blob([shb, idb, ...epbs], { type: 'application/x-pcapng' });
}
$('captureDisplayFilter').addEventListener('input', () => {
  // debounce
  clearTimeout(window._capFilterTimer);
  window._capFilterTimer = setTimeout(reapplyFilter, 120);
});
$('runReport').addEventListener('click', () => runReport().catch((err) => {
  toastError(err);
}));
$('runE2E').addEventListener('click', () => runE2E().catch((err) => {
  toastError(err);
}));

// ----------- Simple Bidirectional Forwarding Test (Control tab) -----------
const sbf = { a: { interfaces: [] }, b: { interfaces: [] }, local: { interfaces: [] } };
function sbfIsSinglePc() { return $('sbfSinglePc')?.checked === true; }
function sbfLocalUrl() { return window.location.origin; }

function sbfFillSelect(selectId, interfaces, fallbackIndex) {
  const sel = $(selectId);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select —</option>' + interfaces.map((iface) =>
    `<option value="${iface.name}">${iface.name} — ${iface.mac || '?'}${iface.state === 'up' ? ' · up' : ''}</option>`
  ).join('');
  if (prev && interfaces.find((i) => i.name === prev)) sel.value = prev;
  else if (fallbackIndex != null && interfaces[fallbackIndex]) sel.value = interfaces[fallbackIndex].name;
}

function sbfPrimary(side) {
  const sel = $(side === 'a' ? 'sbfNodeAPrimary' : 'sbfNodeBPrimary');
  return sbf[side].interfaces.find((i) => i.name === sel.value) || null;
}
function sbfMonitor(side) {
  const sel = $(side === 'a' ? 'sbfNodeAMonitor' : 'sbfNodeBMonitor');
  return sbf[side].interfaces.find((i) => i.name === sel.value) || null;
}
function sbfMonitor2(side) {
  const sel = $(side === 'a' ? 'sbfNodeAMonitor2' : 'sbfNodeBMonitor2');
  return sbf[side].interfaces.find((i) => i.name === sel.value) || null;
}
function sbfMonitorList(side) {
  const seen = new Set();
  const primary = sbfPrimary(side)?.name;
  return [sbfMonitor(side), sbfMonitor2(side)]
    .filter((m) => m && m.name !== primary && !seen.has(m.name) && (seen.add(m.name), true));
}

function sbfSyncTopology() {
  if (sbfIsSinglePc()) {
    const url = sbfLocalUrl();
    $('sbfTopoAUrl').textContent = url + ' (this PC)';
    $('sbfTopoBUrl').textContent = url + ' (this PC)';
    const s = sbfUnifiedSend(), r = sbfUnifiedRecv(), mons = sbfUnifiedMonitors();
    $('sbfTopoAPrimary').innerHTML  = `<span class="sbfBadge sbf-primary">Send</span> ${s ? `${s.name} <small style="color:var(--muted)">${s.mac}</small>` : '—'}`;
    $('sbfTopoAMonitors').innerHTML = `<span class="sbfBadge sbf-monitor">Monitors (${mons.length})</span> ${mons.length ? mons.map((m) => m.name).join(', ') : '—'}`;
    $('sbfTopoBPrimary').innerHTML  = `<span class="sbfBadge sbf-primary">Receive</span> ${r ? `${r.name} <small style="color:var(--muted)">${r.mac}</small>` : '—'}`;
    $('sbfTopoBMonitors').innerHTML = `<span class="sbfBadge sbf-monitor">(all captures on this PC)</span>`;
    return;
  }
  $('sbfTopoAUrl').textContent = $('sbfNodeAUrl').value || '-';
  $('sbfTopoBUrl').textContent = $('sbfNodeBUrl').value || '-';
  $('sbfNodeAEcho').textContent = $('sbfNodeAUrl').value || '';
  $('sbfNodeBEcho').textContent = $('sbfNodeBUrl').value || '';
  const ap = sbfPrimary('a'), bp = sbfPrimary('b');
  const aMons = sbfMonitorList('a'), bMons = sbfMonitorList('b');
  $('sbfTopoAPrimary').innerHTML = `<span class="sbfBadge sbf-primary">Primary</span> ${ap ? `${ap.name} <small style="color:var(--muted)">${ap.mac}</small>` : '—'}`;
  $('sbfTopoAMonitors').innerHTML = `<span class="sbfBadge sbf-monitor">Monitors</span> ${aMons.length ? aMons.map((m) => m.name).join(', ') : '—'}`;
  $('sbfTopoBPrimary').innerHTML = `<span class="sbfBadge sbf-primary">Primary</span> ${bp ? `${bp.name} <small style="color:var(--muted)">${bp.mac}</small>` : '—'}`;
  $('sbfTopoBMonitors').innerHTML = `<span class="sbfBadge sbf-monitor">Monitors</span> ${bMons.length ? bMons.map((m) => m.name).join(', ') : '—'}`;
}

async function sbfProbe() {
  setActionStatus('sbfProbeStatus', 'running', 'probing...');
  $('sbfProbe').disabled = true;
  try {
    if (sbfIsSinglePc()) {
      const url = sbfLocalUrl();
      const r = await api('/api/probe-node', { method: 'POST', body: JSON.stringify({ url }) });
      sbf.local.interfaces = r.interfaces;
      sbfRenderUnifiedTable(r.interfaces);
      sbfSyncTopology();
      setActionStatus('sbfProbeStatus', 'ok', `local: ${r.interfaces.length} IF`);
      return;
    }
    const aUrl = $('sbfNodeAUrl').value.trim();
    const bUrl = $('sbfNodeBUrl').value.trim();
    if (!aUrl || !bUrl) throw new Error('Node A URL과 Node B URL을 모두 입력하세요.');
    const [a, b] = await Promise.all([
      api('/api/probe-node', { method: 'POST', body: JSON.stringify({ url: aUrl }) }),
      api('/api/probe-node', { method: 'POST', body: JSON.stringify({ url: bUrl }) })
    ]);
    sbf.a.interfaces = a.interfaces;
    sbf.b.interfaces = b.interfaces;
    const realA = a.interfaces.findIndex((i) => !/^(lo|docker|veth|br|virbr|tap|wlan|wlp|wlx)/.test(i.name));
    const realB = b.interfaces.findIndex((i) => !/^(lo|docker|veth|br|virbr|tap|wlan|wlp|wlx)/.test(i.name));
    sbfFillSelect('sbfNodeAPrimary',  a.interfaces, realA >= 0 ? realA : 0);
    sbfFillSelect('sbfNodeAMonitor',  a.interfaces, realA + 1 < a.interfaces.length ? realA + 1 : null);
    sbfFillSelect('sbfNodeAMonitor2', a.interfaces, realA + 2 < a.interfaces.length ? realA + 2 : null);
    sbfFillSelect('sbfNodeBPrimary',  b.interfaces, realB >= 0 ? realB : 0);
    sbfFillSelect('sbfNodeBMonitor',  b.interfaces, realB + 1 < b.interfaces.length ? realB + 1 : null);
    sbfFillSelect('sbfNodeBMonitor2', b.interfaces, realB + 2 < b.interfaces.length ? realB + 2 : null);
    sbfSyncTopology();
    setActionStatus('sbfProbeStatus', 'ok', `A: ${a.interfaces.length} IF · B: ${b.interfaces.length} IF`);
  } finally {
    $('sbfProbe').disabled = false;
  }
}

function sbfSingleSender() { return sbf.local.interfaces.find((i) => i.name === $('sbfSingleSender').value) || null; }
function sbfSingleReceiver() { return sbf.local.interfaces.find((i) => i.name === $('sbfSingleReceiver').value) || null; }
function sbfSingleMonitors() {
  const seen = new Set();
  const used = new Set([sbfSingleSender()?.name, sbfSingleReceiver()?.name]);
  return [$('sbfSingleMonitor').value, $('sbfSingleMonitor2').value]
    .map((n) => sbf.local.interfaces.find((i) => i.name === n))
    .filter((m) => m && !used.has(m.name) && !seen.has(m.name) && (seen.add(m.name), true));
}

function sbfSetSinglePcMode(on) {
  $('sbfTwoPcUrls').style.display = on ? 'none' : '';
  $('sbfSinglePcUrl').style.display = on ? '' : 'none';
  $('sbfUnifiedBlock').style.display = on ? '' : 'none';
  $('sbfTwoPcIfaces').style.display = on ? 'none' : '';
  const btnBoth = $('sbfRunBoth'); const btnBtoA = $('sbfRunBtoA');
  if (on) {
    if (btnBoth) btnBoth.style.display = 'none';
    if (btnBtoA) btnBtoA.style.display = 'none';
    $('sbfRunAtoB').textContent = '▶ Run (Send → Receive)';
    $('sbfLocalUrl').value = sbfLocalUrl();
    $('sbfUnifiedEcho').textContent = sbfLocalUrl();
  } else {
    if (btnBoth) btnBoth.style.display = '';
    if (btnBtoA) btnBtoA.style.display = '';
    $('sbfRunAtoB').textContent = '▶ Run A to B';
  }
  sbfSyncTopology();
}

function sbfRenderUnifiedTable(interfaces) {
  const tbody = $('sbfUnifiedTable').querySelector('tbody');
  if (!interfaces.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:12px">Probe Nodes 누른 뒤 인터페이스가 표시됩니다.</td></tr>';
    return;
  }
  // Auto-select defaults: first non-virtual = Send, next = Receive
  const real = interfaces.findIndex((i) => !/^(lo|docker|veth|br|virbr|tap|wlan|wlp|wlx)/.test(i.name));
  tbody.innerHTML = interfaces.map((iface, idx) => {
    const isSend = idx === real;
    const isRecv = idx === real + 1;
    return `<tr>
      <td class="name">${iface.name}</td>
      <td class="mac">${iface.mac || '—'}</td>
      <td class="state">${iface.state || ''}</td>
      <td style="text-align:center"><input type="radio" name="sbfUSend" value="${iface.name}"${isSend ? ' checked' : ''}></td>
      <td style="text-align:center"><input type="radio" name="sbfURecv" value="${iface.name}"${isRecv ? ' checked' : ''}></td>
      <td style="text-align:center"><input type="checkbox" class="sbfUMon" value="${iface.name}"></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input').forEach((el) => el.addEventListener('change', sbfSyncTopology));
}

function sbfUnifiedSend() {
  const v = document.querySelector('input[name=sbfUSend]:checked')?.value;
  return sbf.local.interfaces.find((i) => i.name === v) || null;
}
function sbfUnifiedRecv() {
  const v = document.querySelector('input[name=sbfURecv]:checked')?.value;
  return sbf.local.interfaces.find((i) => i.name === v) || null;
}
function sbfUnifiedMonitors() {
  const used = new Set([sbfUnifiedSend()?.name, sbfUnifiedRecv()?.name]);
  return Array.from(document.querySelectorAll('input.sbfUMon:checked'))
    .map((el) => sbf.local.interfaces.find((i) => i.name === el.value))
    .filter((m) => m && !used.has(m.name));
}

function sbfRenderResult(report) {
  const el = $('sbfResult');
  el.classList.remove('hidden');
  const overallCls = report.overall === 'PASS' ? 'pass' : 'fail';
  const dirs = report.directions.map((d) => {
    const capRows = d.captures.map((c) => `
      <tr class="${c.pass ? 'pass' : 'fail'}">
        <td>${c.role}</td>
        <td>${c.node}</td>
        <td><code>${c.interface.name}</code></td>
        <td><code>${c.interface.mac}</code></td>
        <td>${c.expectMatch ? '≥ ' + d.count : '== 0'}</td>
        <td>${c.matched}</td>
        <td><span class="sbfBadge ${c.pass ? 'sbf-primary' : 'sbf-monitor'}" style="background:${c.pass ? '#dcfce7' : '#fee2e2'};color:${c.pass ? '#14532d' : '#9b1c1c'}">${c.pass ? 'PASS' : 'FAIL'}</span></td>
        <td>${c.error || ''}</td>
      </tr>
    `).join('');
    return `
      <div class="sbfDirection">
        <h5>${d.direction} — <span class="sbfBadge ${d.result === 'PASS' ? 'sbf-primary' : 'sbf-monitor'}" style="background:${d.result === 'PASS' ? '#dcfce7' : '#fee2e2'};color:${d.result === 'PASS' ? '#14532d' : '#9b1c1c'}">${d.result}</span></h5>
        <div style="color:var(--muted);font-size:12px">
          ${d.senderUrl} / <code>${d.senderInterface.name}</code> → ${d.receiverUrl} / <code>${d.expectedInterface.name}</code>
          · marker <code>${d.marker}</code> · UDP ${d.udpSrcPort}→${d.udpDstPort} · sent ${d.sent}/${d.count}
        </div>
        <table class="sbfCapTable">
          <thead><tr><th>Role</th><th>Node</th><th>Interface</th><th>MAC</th><th>Expect</th><th>Matched</th><th>Result</th><th>Error</th></tr></thead>
          <tbody>${capRows}</tbody>
        </table>
        <div class="sbfSeq">missing sequences (${d.missingSequences.length}): ${d.missingSequences.slice(0, 100).join(', ') || '<em>none</em>'}${d.missingSequences.length > 100 ? ' …' : ''}</div>
      </div>
    `;
  }).join('');
  el.innerHTML = `
    <div class="sbfResultSummary">
      <div class="box ${overallCls}"><span>Overall</span><strong>${report.overall}</strong></div>
      <div class="box"><span>Directions</span><strong>${report.directions.length}</strong></div>
      <div class="box"><span>Generated</span><strong style="font-size:12px">${new Date(report.generatedAt).toLocaleString()}</strong></div>
    </div>
    ${dirs}
  `;
  $('sbfOpenReport').classList.remove('disabled');
  $('sbfOpenJson').classList.remove('disabled');
}

async function sbfRun(direction) {
  const singlePc = sbfIsSinglePc();
  const count = Number($('sbfCount').value || 10);
  const intervalMs = Number($('sbfInterval').value || 100);
  const captureTimeoutMs = Number($('sbfCaptureTimeout').value || 3000);
  const params = {
    count, intervalMs,
    udpSrcPort: Number($('sbfUdpSrc').value || 40000),
    udpDstPort: Number($('sbfUdpDst').value || 50000),
    payloadMarkerPrefix: $('sbfMarker').value.trim() || 'KETI_SIMPLE_FORWARD',
    captureTimeoutMs
  };
  let body;
  if (singlePc) {
    const send = sbfUnifiedSend(), recv = sbfUnifiedRecv();
    if (!send) throw new Error('Send 인터페이스(라디오)를 선택하세요.');
    if (!recv) throw new Error('Receive 인터페이스(라디오)를 선택하세요.');
    if (send.name === recv.name) throw new Error('Send와 Receive는 다른 인터페이스여야 합니다.');
    const monitors = sbfUnifiedMonitors().map((m) => m.name);
    const url = sbfLocalUrl();
    body = {
      ...params,
      nodeAUrl: url, nodeBUrl: url,
      nodeAPrimaryInterface: send.name,
      nodeBPrimaryInterface: recv.name,
      // All checked monitors land on the receive side so they're checked against
      // the same expected dst MAC (receiver primary). Backend treats them as
      // "must == 0" captures.
      nodeAMonitorInterfaces: [],
      nodeBMonitorInterfaces: monitors,
      direction: 'A_TO_B'
    };
  } else {
    const aPrimary = sbfPrimary('a'), bPrimary = sbfPrimary('b');
    if (!aPrimary) throw new Error('Node A의 Primary 인터페이스를 선택하세요.');
    if (!bPrimary) throw new Error('Node B의 Primary 인터페이스를 선택하세요.');
    body = {
      ...params,
      nodeAUrl: $('sbfNodeAUrl').value.trim(),
      nodeBUrl: $('sbfNodeBUrl').value.trim(),
      nodeAPrimaryInterface: aPrimary.name,
      nodeBPrimaryInterface: bPrimary.name,
      nodeAMonitorInterfaces: sbfMonitorList('a').map((m) => m.name),
      nodeBMonitorInterfaces: sbfMonitorList('b').map((m) => m.name),
      direction
    };
  }
  const buttons = ['sbfRunAtoB', 'sbfRunBtoA', 'sbfRunBoth', 'sbfProbe'];
  buttons.forEach((id) => { const b = $(id); if (b) b.disabled = true; });
  const prog = progressFor('progSimpleBidir');
  const passes = body.direction === 'BOTH' ? 2 : 1;
  const estSec = passes * Math.max(1, (count * intervalMs + captureTimeoutMs) / 1000 + 1);
  setActionStatus('statusSimpleBidir', 'running', `${body.direction} running...`);
  prog.start(estSec);
  setStatus(`Simple bidir forward ${body.direction}...`);
  try {
    const result = await api('/api/simple-bidir-forward-test', { method: 'POST', body: JSON.stringify(body) });
    sbfRenderResult(result.report);
    renderBidirSimpleChart(result.report);
    const overall = result.report.overall;
    setActionStatus('statusSimpleBidir', overall === 'PASS' ? 'ok' : 'fail',
      result.directions.map((d) => `${d.direction}:${d.result}`).join(' · '));
    if (overall === 'PASS') prog.finish(); else prog.fail();
    setStatus(`Simple bidir forward ${overall}`, overall !== 'PASS');
  } catch (err) {
    setActionStatus('statusSimpleBidir', 'fail', 'fail');
    prog.fail();
    throw err;
  } finally {
    buttons.forEach((id) => { const b = $(id); if (b) b.disabled = false; });
  }
}

(function sbfInit() {
  const b = $('sbfNodeBUrl');
  if (b && !b.value) b.value = window.location.origin;
  if ($('sbfLocalUrl')) $('sbfLocalUrl').value = window.location.origin;
  const syncIds = [
    'sbfNodeAUrl','sbfNodeBUrl',
    'sbfNodeAPrimary','sbfNodeAMonitor','sbfNodeAMonitor2',
    'sbfNodeBPrimary','sbfNodeBMonitor','sbfNodeBMonitor2',
    'sbfSingleSender','sbfSingleReceiver','sbfSingleMonitor','sbfSingleMonitor2'
  ];
  syncIds.forEach((id) => {
    $(id)?.addEventListener('input', sbfSyncTopology);
    $(id)?.addEventListener('change', sbfSyncTopology);
  });
  $('sbfSinglePc')?.addEventListener('change', (e) => sbfSetSinglePcMode(e.target.checked));
  sbfSetSinglePcMode(false);
  sbfSyncTopology();
  $('sbfProbe')?.addEventListener('click', () => sbfProbe().catch(toastError));
  $('sbfRunAtoB')?.addEventListener('click', () => sbfRun('A_TO_B').catch(toastError));
  $('sbfRunBtoA')?.addEventListener('click', () => sbfRun('B_TO_A').catch(toastError));
  $('sbfRunBoth')?.addEventListener('click', () => sbfRun('BOTH').catch(toastError));
})();

async function ensurePeerReady() {
  if (!state.peer.url) throw new Error('Peer URL not set. Fill the Peer field in the top link strip.');
  if (!state.peer.interfaces.length) await probePeer();
  if (!state.peer.iface) throw new Error('Peer interface not selected.');
}

async function runBenchmark() {
  if ($('runBenchmark').disabled) return;
  $('runBenchmark').disabled = true;
  const prog = progressFor('progBench');
  const count = Number($('benchCount').value || 500);
  const intervalMs = Number($('benchInterval').value || 1);
  const estSec = Math.max(1.2, (count * intervalMs) / 1000 + 0.7);
  setActionStatus('statusBench', 'running', 'running');
  prog.start(estSec);
  setStatus('Running benchmark...');
  try {
    await ensurePeerReady();
    syncControlFromPeer();
    const pairs = selectedControlPairs();
    prog.start(estSec * pairs.length);
    initControlRunBoard('Benchmark Progress', pairs);
    const results = [];
    for (const [index, pair] of pairs.entries()) {
      setStatus(`Running benchmark ${index + 1}/${pairs.length}: ${pair.label}`);
      updateControlRunCard(index, 'running', { rx: '-', loss: '-', mbps: '-' });
      try {
        const data = await apiReport('/api/benchmark', {
          senderUrl: pair.senderUrl,
          receiverUrl: pair.receiverUrl,
          senderInterface: pair.senderIf,
          receiverInterface: pair.receiverIf,
          profile: getProfile(),
          count: Number($('benchCount').value || 500),
          intervalMs: Number($('benchInterval').value || 1),
          payloadSize: Number($('benchPayloadSize').value || 64)
        });
        results.push({ pair, report: data.report });
        const stats = data.report.stats;
        const ok = Number(stats.rxCount || 0) > 0;
        updateControlRunCard(index, ok ? 'ok' : 'fail', {
          rx: `${stats.rxCount}/${stats.txCount}`,
          loss: `${Number(stats.lossPct || 0).toFixed(2)}%`,
          mbps: Number(stats.throughputMbps || 0).toFixed(2)
        }, ok ? '' : 'Receiver got 0 benchmark packets.');
      } catch (err) {
        results.push({ pair, error: err });
        updateControlRunCard(index, 'fail', { rx: '0/0', loss: '-', mbps: '-' }, err.message);
      }
      updateControlRunSummary(index + 1, pairs.length, results.filter((item) => Number(item.report?.stats?.rxCount || 0) > 0).length);
    }
    const last = [...results].reverse().find((item) => item.report)?.report;
    if (!last) throw new Error('No benchmark report generated');
    const s = last.stats;
    const pass = results.filter((item) => item.report.stats.rxCount > 0).length;
    const totalRx = results.reduce((sum, item) => sum + Number(item.report.stats.rxCount || 0), 0);
    const totalTx = results.reduce((sum, item) => sum + Number(item.report.stats.txCount || 0), 0);
    $('reportSummary').innerHTML = `
      <div><span>Pairs</span><strong>${pass}/${results.length}</strong></div>
      <div><span>Sent</span><strong>${totalTx}</strong></div>
      <div><span>Recv</span><strong>${totalRx}</strong></div>
      <div><span>Last Loss</span><strong>${s.lossPct.toFixed(2)}%</strong></div>
      <div><span>Tx Mbps</span><strong>${s.throughputMbps.toFixed(2)}</strong></div>
      <div><span>Lat p95 µs (skew-adj.)</span><strong>${(s.latencyAdjustedUs?.p95||0).toFixed(1)}</strong></div>
      <div><span>Jitter µs</span><strong>${(s.jitterUs.mean||0).toFixed(2)}</strong></div>
    `;
    const okFlag = pass === results.length;
    setActionStatus('statusBench', okFlag ? 'ok' : 'fail', `${pass}/${results.length} pairs · ${totalRx}/${totalTx}`);
    if (okFlag) prog.finish(); else prog.fail();
    setStatus(`Benchmark done: ${pass}/${results.length} pair(s), ${totalRx}/${totalTx} rx`, !okFlag);
    renderBenchChart(results);
    if (okFlag) window.open('/reports/benchmark-latest.html', '_blank');
    else {
      toast(`One or more benchmark pairs received 0 packets. Check cable/link, selected Sender/Receiver NIC pairing, and peer agent reachability.\n\nThe benchmark always uses UDP+IPv4 internally regardless of the Sender-tab profile.`);
    }
  } catch (err) {
    setActionStatus('statusBench', 'fail', 'fail');
    prog.fail();
    throw err;
  } finally {
    $('runBenchmark').disabled = false;
  }
}

async function runRfc2544() {
  if ($('runRfc').disabled) return;
  $('runRfc').disabled = true;
  const prog = progressFor('progRfc');
  const trial = Number($('rfcTrial').value || 2);
  const link = Number($('rfcLink').value || 1000);
  const tol = Number($('rfcTol').value || 100);
  // 7 sizes × ~7 binary-search iterations × trial seconds, generous estimate
  const estSec = 7 * 7 * (trial + 0.7);
  setActionStatus('statusRfc', 'running', 'binary-searching');
  prog.start(estSec);
  setStatus('Running RFC 2544 throughput…');
  try {
    await ensurePeerReady();
    syncControlFromPeer();
    const pairs = selectedControlPairs();
    prog.start(estSec * pairs.length);
    initControlRunBoard('RFC 2544 Progress', pairs);
    const results = [];
    for (const [index, pair] of pairs.entries()) {
      setStatus(`Running RFC 2544 ${index + 1}/${pairs.length}: ${pair.label}`);
      updateControlRunCard(index, 'running', { sizes: '-', util: '-', report: '-' });
      try {
        const result = await apiReport('/api/rfc2544', {
          senderUrl: pair.senderUrl,
          receiverUrl: pair.receiverUrl,
          senderInterface: pair.senderIf,
          receiverInterface: pair.receiverIf,
          trialDurationSec: trial,
          linkRateMbps: link,
          tolerancePps: tol
        });
        results.push({ pair, report: result.report });
        const sizesNow = result.report.results.length;
        const utilNow = (result.report.results.reduce((sum, r) => sum + (r.utilizationPct || 0), 0) / sizesNow).toFixed(1);
        updateControlRunCard(index, 'ok', { sizes: sizesNow, util: `${utilNow}%`, report: 'saved' });
      } catch (err) {
        results.push({ pair, error: err });
        updateControlRunCard(index, 'fail', { sizes: 0, util: '-', report: '-' }, err.message);
      }
      updateControlRunSummary(index + 1, pairs.length, results.filter((item) => item.report).length);
    }
    const last = [...results].reverse().find((item) => item.report)?.report;
    if (!last) throw new Error('No RFC 2544 report generated');
    const sizes = last.results.length;
    const avgUtil = (last.results.reduce((sum, r) => sum + (r.utilizationPct || 0), 0) / sizes).toFixed(1);
    setActionStatus('statusRfc', 'ok', `${results.length} pair(s) · last avg ${avgUtil}%`);
    prog.finish();
    setStatus(`RFC 2544 done: ${results.length} pair(s), last ${sizes} sizes, avg ${avgUtil}% utilization`);
    renderRfcChart(last.results);
    window.open('/reports/rfc2544-latest.html', '_blank');
  } catch (err) {
    setActionStatus('statusRfc', 'fail', 'fail');
    prog.fail();
    throw err;
  } finally {
    $('runRfc').disabled = false;
  }
}

async function runSweep() {
  if ($('runSweep').disabled) return;
  $('runSweep').disabled = true;
  const prog = progressFor('progSweep');
  const count = Number($('benchCount').value || 200);
  const intervalMs = Number($('benchInterval').value || 1);
  // Per-slot wall time observed: send_ms + ~700ms HTTP/agent overhead. Strict
  // srcMac filter + maxFrames=count makes the receiver exit immediately when
  // all frames arrive instead of running to capture timeout.
  const perSlot = Math.max(1.2, (count * intervalMs) / 1000 + 0.7);
  const estSec = 7 * perSlot + 0.5;
  setActionStatus('statusSweep', 'running', 'running');
  prog.start(estSec);
  setStatus('Running frame-size sweep (this can take a while)...');
  try {
    await ensurePeerReady();
    syncControlFromPeer();
    const pairs = selectedControlPairs();
    prog.start(estSec * pairs.length);
    initControlRunBoard('Frame-size Sweep Progress', pairs);
    const results = [];
    for (const [index, pair] of pairs.entries()) {
      setStatus(`Running sweep ${index + 1}/${pairs.length}: ${pair.label}`);
      updateControlRunCard(index, 'running', { sizes: '-', rx: '-', loss: '-' });
      try {
        const result = await apiReport('/api/sweep', {
          senderUrl: pair.senderUrl,
          receiverUrl: pair.receiverUrl,
          senderInterface: pair.senderIf,
          receiverInterface: pair.receiverIf,
          count, intervalMs
        });
        results.push({ pair, report: result.report });
        const totalRx = result.report.results.reduce((sum, r) => sum + Number(r.stats?.rxCount || 0), 0);
        const avgLoss = result.report.results.reduce((sum, r) => sum + Number(r.stats?.lossPct || 0), 0) / result.report.results.length;
        updateControlRunCard(index, 'ok', {
          sizes: result.report.results.length,
          rx: totalRx,
          loss: `${avgLoss.toFixed(2)}%`
        });
      } catch (err) {
        results.push({ pair, error: err });
        updateControlRunCard(index, 'fail', { sizes: 0, rx: 0, loss: '-' }, err.message);
      }
      updateControlRunSummary(index + 1, pairs.length, results.filter((item) => item.report).length);
    }
    const lastSweep = [...results].reverse().find((item) => item.report)?.report;
    if (!lastSweep) throw new Error('No sweep report generated');
    const sizes = lastSweep.results.length;
    setActionStatus('statusSweep', 'ok', `${results.length} pair(s) · ${sizes} sizes`);
    prog.finish();
    setStatus(`Sweep done: ${results.length} pair(s), ${sizes} sizes each`);
    renderSweepChart(lastSweep.results);
    window.open('/reports/sweep-latest.html', '_blank');
  } catch (err) {
    setActionStatus('statusSweep', 'fail', 'fail');
    prog.fail();
    throw err;
  } finally {
    $('runSweep').disabled = false;
  }
}

async function runFullSuite() {
  if ($('runFullSuite').disabled) return;
  $('runFullSuite').disabled = true;
  setActionStatus('statusFullSuite', 'running', 'running');
  try {
    await ensurePeerReady();
    syncControlFromPeer();
    const pairs = selectedControlPairs();
    const suiteItems = pairs.flatMap((pair, pairIndex) => controlSuiteStages(pair).map((stage) => ({
      ...pair,
      stage,
      topoIndex: pairIndex,
      label: `${stage.name}: ${pair.label}`
    })));
    initControlRunBoard('Full Lab Suite Progress', suiteItems);
    let done = 0;
    let pass = 0;
    for (const [index, item] of suiteItems.entries()) {
      setStatus(`Full suite ${index + 1}/${suiteItems.length}: ${item.label}`);
      updateControlRunCard(index, 'running', { status: 'running', pair: item.stage.name, result: '-' });
      try {
        const data = await apiReport(item.stage.path, item.stage.body);
        const summary = item.stage.summarize(data);
        if (summary.ok) pass += 1;
        if (data.report?.capturedFrames?.length) appendControlPackets(data.report.capturedFrames, item.label);
        updateControlRunCard(index, summary.ok ? 'ok' : 'fail', summary.metrics, summary.error);
      } catch (err) {
        updateControlRunCard(index, 'fail', { status: 'error', pair: item.stage.name, result: '-' }, err.message);
      }
      done += 1;
      updateControlRunSummary(done, suiteItems.length, pass);
    }
    const ok = pass === suiteItems.length;
    setActionStatus('statusFullSuite', ok ? 'ok' : 'fail', `${pass}/${suiteItems.length}`);
    setStatus(`Full suite ${ok ? 'PASS' : 'FAIL'}: ${pass}/${suiteItems.length} stage(s) passed`, !ok);
  } catch (err) {
    setActionStatus('statusFullSuite', 'fail', 'fail');
    throw err;
  } finally {
    $('runFullSuite').disabled = false;
  }
}

$('runFullSuite')?.addEventListener('click', () => runFullSuite().catch((err) => {
  toastError(err);
}));

$('runBenchmark').addEventListener('click', () => runBenchmark().catch((err) => {
  toastError(err);
}));
$('runSweep').addEventListener('click', () => runSweep().catch((err) => {
  toastError(err);
}));
$('runRfc')?.addEventListener('click', () => runRfc2544().catch((err) => {
  toastError(err);
}));
$('caseSelect').addEventListener('change', () => {
  const item = state.testCases.find((entry) => entry.id === $('caseSelect').value);
  if (item) setCurrentCase(item.testCase);
});
$('profileSuiteSelect').addEventListener('change', () => {
  const item = state.testProfiles.find((entry) => entry.id === $('profileSuiteSelect').value);
  if (!item) return;
  setCurrentCase(item.testCase);
  $('caseName').value = item.name;
  $('caseDescription').value = item.description || '';
  setStatus(`Loaded standard profile: ${item.name}`);
});
$('newCase').addEventListener('click', () => setCurrentCase({ id: '', name: 'Untitled Test Case', description: '', steps: [] }));
$('saveCase').addEventListener('click', () => saveCurrentCase().catch((err) => {
  toastError(err);
}));
$('deleteCase').addEventListener('click', () => deleteCurrentCase().catch((err) => {
  toastError(err);
}));
$('addCurrentPacket').addEventListener('click', addCurrentPacketToCase);
$('addDelay').addEventListener('click', addDelayToCase);
$('duplicateStep').addEventListener('click', duplicateSelectedStep);
$('removeStep').addEventListener('click', removeSelectedStep);
$('moveStepUp').addEventListener('click', () => moveSelectedStep(-1));
$('moveStepDown').addEventListener('click', () => moveSelectedStep(1));
$('sendSelectedSteps').addEventListener('click', () => runCurrentCase({ selectedOnly: true }).catch((err) => {
  toastError(err);
}));
$('runCase').addEventListener('click', () => runCurrentCase().catch((err) => {
  toastError(err);
}));
$('caseCycleMs').addEventListener('change', updateCaseEstimate);
$('caseRepeat').addEventListener('change', updateCaseEstimate);
$('caseLoopCount').addEventListener('change', updateCaseEstimate);
$('senderNodeInterface').addEventListener('change', renderNodeGrid);
$('receiverNodeInterface').addEventListener('change', renderNodeGrid);

function localIface() {
  return state.interfaces.find((i) => i.name === $('interfaceSelect').value) || null;
}

function firstV4(iface) {
  return iface?.ipv4?.find((a) => a.local && !a.local.includes(':'))?.local || '';
}

function hostFromUrl(value) {
  try {
    return new URL(value.startsWith('http') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
}

// Lock-to-peer was making srcMac/srcIp/dstMac/dstIp readOnly, which blocked
// Send when the picker / form combo didn't match the peer-locked state.
// Killed in favour of the new Sender interface picker (which auto-fills
// srcMac/srcIp on toggle) and manual dstMac/dstIp entry.
function applyLock() { /* no-op: lock feature removed */ }
function setLockUi() {
  ['srcMac','srcIp','dstMac','dstIp'].forEach((id) => {
    const el = $(id);
    if (el) { el.readOnly = false; el.removeAttribute('readonly'); }
  });
  // Hide the legacy buttons — Lock to Peer / 🔒 Locked to peer.
  for (const id of ['lockToggle', 'useMacBtn']) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }
}

function renderLinkStrip() {
  const local = localIface();
  if (local) {
    $('localIfName').textContent = local.name;
    $('localIp').textContent = firstV4(local);
    $('localMac').textContent = local.mac;
  }
  const peer = state.peer.iface;
  if (peer) {
    $('peerIfName').textContent = peer.name;
    $('peerIp').textContent = firstV4(peer);
    $('peerMac').textContent = peer.mac;
  } else {
    $('peerIfName').textContent = state.peer.url ? '(probe to load)' : '-';
    $('peerIp').textContent = '';
    $('peerMac').textContent = '--:--:--:--:--:--';
  }
  const localTag = state.localRole === 'sender' ? 'SENDER' : 'RECEIVER';
  const peerTag = state.localRole === 'sender' ? 'RECEIVER' : 'SENDER';
  $('localRoleTag').textContent = localTag;
  $('peerRoleTag').textContent = peerTag;
  syncControlFromPeer();
  applyLock();
  setLockUi();
  const hint = $('e2eHint');
  if (hint) {
    const local = localIface();
    const peer = state.peer.iface;
    if (local && peer) {
      hint.textContent = `tcpdump -i ${local.name} -nn ether host ${peer.mac}`;
    } else {
      hint.textContent = 'tcpdump -i $iface -nn ether host PEER_MAC';
    }
  }
}

function setActionStatus(id, kind, text) {
  const el = $(id);
  if (!el) return;
  el.className = `actionStatus ${kind}`;
  el.textContent = text;
}

function progressFor(progId) {
  const track = $(progId);
  if (!track) return { start() {}, set() {}, finish() {}, fail() {} };
  const fill = track.querySelector('.progressFill');
  const label = track.querySelector('.progressLabel');
  let timer = null;
  let card = track.closest('.actionCard');
  return {
    start(estimatedSec) {
      track.classList.add('show');
      card?.classList.add('running');
      const t0 = performance.now();
      fill.style.width = '0%';
      label.textContent = '0%';
      track.classList.remove('indeterminate');
      if (!estimatedSec || estimatedSec <= 0) {
        track.classList.add('indeterminate');
        return;
      }
      const tick = () => {
        const elapsed = (performance.now() - t0) / 1000;
        const pct = Math.min(95, (elapsed / estimatedSec) * 100);
        fill.style.width = pct.toFixed(1) + '%';
        label.textContent = `${pct.toFixed(0)}% · ${elapsed.toFixed(1)}s / ~${estimatedSec.toFixed(1)}s`;
      };
      tick();
      timer = setInterval(tick, 100);
    },
    set(pct, text) {
      if (timer) { clearInterval(timer); timer = null; }
      track.classList.remove('indeterminate');
      fill.style.width = `${pct}%`;
      if (text) label.textContent = text;
    },
    finish() {
      if (timer) { clearInterval(timer); timer = null; }
      track.classList.remove('indeterminate');
      fill.style.width = '100%';
      label.textContent = '100% · done';
      card?.classList.remove('running');
      setTimeout(() => track.classList.remove('show'), 1200);
    },
    fail() {
      if (timer) { clearInterval(timer); timer = null; }
      track.classList.remove('indeterminate');
      fill.style.background = 'linear-gradient(90deg, #ef4444, #b91c1c)';
      label.textContent = 'failed';
      card?.classList.remove('running');
      setTimeout(() => {
        track.classList.remove('show');
        fill.style.background = '';
      }, 1500);
    }
  };
}

function renderPairCard() {
  const local = localIface();
  const peer = state.peer.iface;
  const localUrl = window.location.origin;
  const peerUrl = state.peer.url || '';
  const senderIs = state.localRole === 'sender';
  const senderIfs = selectedControlInterfaces('sender');
  const receiverIfs = selectedControlInterfaces('receiver');
  const senderNode = state.nodes.sender;
  const receiverNode = state.nodes.receiver;
  const sender = senderNode?.interfaces?.find((iface) => iface.name === senderIfs[0]) || (senderIs ? local : peer);
  const receiver = receiverNode?.interfaces?.find((iface) => iface.name === receiverIfs[0]) || (senderIs ? peer : local);
  const sUrl = senderIs ? localUrl : peerUrl;
  const rUrl = senderIs ? peerUrl : localUrl;
  const fmtMac = (m) => m || '--:--:--:--:--:--';
  const fmtIp = (i) => i?.ipv4?.[0]?.local || '-';
  if ($('ctrlSenderName')) {
    $('ctrlSenderName').textContent = senderIfs.length > 1 ? `${senderIfs[0]} +${senderIfs.length - 1}` : sender?.name || '— set in Interface picker —';
    $('ctrlSenderMac').textContent = fmtMac(sender?.mac);
    $('ctrlSenderIp').textContent = fmtIp(sender);
    $('ctrlSenderUrl').textContent = sUrl || '(this PC)';
    $('ctrlReceiverName').textContent = receiverIfs.length > 1 ? `${receiverIfs[0]} +${receiverIfs.length - 1}` : receiver?.name || '— probe peer in the link strip above —';
    $('ctrlReceiverMac').textContent = fmtMac(receiver?.mac);
    $('ctrlReceiverIp').textContent = fmtIp(receiver);
    $('ctrlReceiverUrl').textContent = rUrl || '(peer not set)';
    const ready = senderIfs.length && receiverIfs.length && sUrl && rUrl;
    $('pairWarning').classList.toggle('hidden', Boolean(ready));
    document.querySelector('.pairCard')?.classList.toggle('pairIncomplete', !ready);
  }
}

function syncControlFromPeer() {
  const localUrl = window.location.origin;
  const peerUrl = state.peer.url;
  const localIfName = $('interfaceSelect').value;
  const peerIfName = state.peer.iface?.name || state.peer.interface || '';
  const localPack = { url: localUrl, interfaces: state.interfaces };
  const peerPack = state.peer.interfaces.length ? { url: peerUrl, interfaces: state.peer.interfaces } : null;
  if (state.localRole === 'sender') {
    state.nodes.sender = localPack;
    if (peerPack) state.nodes.receiver = peerPack;
    $('senderNodeUrl').value = localUrl;
    $('receiverNodeUrl').value = peerUrl;
  } else {
    state.nodes.receiver = localPack;
    if (peerPack) state.nodes.sender = peerPack;
    $('senderNodeUrl').value = peerUrl;
    $('receiverNodeUrl').value = localUrl;
  }
  if (state.nodes.sender) {
    renderInterfaceOptions('senderNodeInterface', state.nodes.sender.interfaces);
    $('senderNodeInterface').value = state.localRole === 'sender' ? localIfName : peerIfName;
    renderControlInterfacePicker('sender', state.nodes.sender.interfaces, $('senderNodeInterface').value);
  }
  if (state.nodes.receiver) {
    renderInterfaceOptions('receiverNodeInterface', state.nodes.receiver.interfaces);
    $('receiverNodeInterface').value = state.localRole === 'sender' ? peerIfName : localIfName;
    renderControlInterfacePicker('receiver', state.nodes.receiver.interfaces, $('receiverNodeInterface').value);
  }
  renderNodeGrid();
  renderPairCard();
  renderControlTopology();
}

async function probePeer() {
  const url = $('peerUrlPin').value.trim();
  if (!url) { toast('Peer URL is required.','warn'); return; }
  setStatus('Probing peer...');
  state.peer.url = url;
  localStorage.setItem('peerUrl', url);
  const result = await api('/api/probe-node', { method: 'POST', body: JSON.stringify({ url }) });
  state.peer.interfaces = result.interfaces;
  const sel = $('peerInterfacePin');
  const sorted = [...result.interfaces].sort((a, b) => {
    const score = (i) => (i.name === 'lo' ? 20 : i.name.startsWith('docker') ? 15 : i.state === 'up' ? 0 : 10);
    return score(a) - score(b);
  });
  sel.innerHTML = sorted.map((i) => {
    const ip = i.ipv4?.[0]?.local || '';
    return `<option value="${i.name}">${i.name} (${i.state})${ip ? ' - ' + ip : ''}</option>`;
  }).join('');
  const urlHost = hostFromUrl(url);
  const urlMatchedInterface = sorted.find((i) => (i.ipv4 || []).some((addr) => addr.local === urlHost));
  if (urlMatchedInterface) {
    sel.value = urlMatchedInterface.name;
  } else if (state.peer.interface && sorted.find((i) => i.name === state.peer.interface)) {
    sel.value = state.peer.interface;
  }
  state.peer.interface = sel.value;
  localStorage.setItem('peerInterface', state.peer.interface);
  state.peer.iface = sorted.find((i) => i.name === sel.value) || null;
  if (state.localRole === 'sender') state.nodes.receiver = { url, interfaces: result.interfaces };
  else state.nodes.sender = { url, interfaces: result.interfaces };
  renderLinkStrip();
  refreshBackendStatus().catch(() => {});
  setStatus(`Peer probed: ${result.interfaces.length} interfaces`);
}

function lockToPeer() {
  const peer = state.peer.iface;
  if (!peer) { toast('Probe the peer first.','warn'); return; }
  if (state.localRole === 'sender') {
    $('dstMac').value = peer.mac;
    if (peer.ipv4?.[0]?.local) $('dstIp').value = peer.ipv4[0].local;
    $('captureSrcMac').value = peer.mac;
    setStatus(`Locked: dst MAC = ${peer.mac}`);
  } else {
    $('captureSrcMac').value = peer.mac;
    setStatus(`Locked: capture src MAC filter = ${peer.mac}`);
  }
}

$('peerProbeBtn').addEventListener('click', () => probePeer().catch((err) => { toastError(err); }));

// First-run welcome banner — show until user dismisses or sets a peer URL.
(function maybeShowFirstRun() {
  if (localStorage.getItem('firstRunDismissed') === '1') return;
  if (state.peer.url) return;
  document.getElementById('firstRunHint')?.classList.remove('hidden');
})();
document.getElementById('firstRunDismiss')?.addEventListener('click', () => {
  localStorage.setItem('firstRunDismissed', '1');
  document.getElementById('firstRunHint')?.classList.add('hidden');
});
$('peerInterfacePin').addEventListener('change', () => {
  state.peer.interface = $('peerInterfacePin').value;
  state.peer.iface = state.peer.interfaces.find((i) => i.name === state.peer.interface) || null;
  localStorage.setItem('peerInterface', state.peer.interface);
  renderLinkStrip();
});
$('linkArrow').addEventListener('click', () => {
  state.localRole = state.localRole === 'sender' ? 'receiver' : 'sender';
  localStorage.setItem('localRole', state.localRole);
  renderLinkStrip();
});
$('useMacBtn').addEventListener('click', lockToPeer);
$('lockToggle').addEventListener('click', () => {
  state.locked = !state.locked;
  localStorage.setItem('autoLock', state.locked ? '1' : '0');
  if (state.locked) applyLock();
  setLockUi();
});
$('interfaceSelect').addEventListener('change', () => {
  localStorage.setItem('localInterface', $('interfaceSelect').value);
  renderLinkStrip();
  syncLocalInterfacePin();
});

// linkStrip local NIC dropdown (Control tab quick-pick). Mirrors the Sender
// picker — picking here flips ifaceSel.sender to a single NIC.
function syncLocalInterfacePin() {
	  const sel = $('localInterfacePin');
	  if (!sel) return;
	  const current = Array.from(ifaceSel.sender)[0] || '';
	  if (sel.options.length !== state.interfaces.length) {
	    sel.innerHTML = state.interfaces.map((i) =>
	      `<option value="${i.name}">${i.name} — ${i.mac || '?'}${i.state==='up' ? ' · up':''}</option>`
	    ).join('');
	  }
	  if (current) sel.value = current;
	  const localUrl = $('localUrlPin');
	  if (localUrl && !localUrl.dataset.wifiSet) localUrl.value = window.location.origin;
	}
$('localInterfacePin')?.addEventListener('change', () => {
  const name = $('localInterfacePin').value;
  if (!name) return;
  ifaceSel.sender.clear();
  ifaceSel.sender.add(name);
  renderInterfacePickers();
  mirrorIfaceSelectionToHiddenSelect();
});

$('senderNodeInterface').addEventListener('change', () => {
  setControlSingleSelection('sender', $('senderNodeInterface').value);
  if (state.localRole === 'sender') {
    const name = $('senderNodeInterface').value;
    if (state.interfaces.find((i) => i.name === name)) {
      Array.from($('interfaceSelect').options).forEach((o) => { o.selected = (o.value === name); });
      renderInterfaceCheckboxes();
      localStorage.setItem('localInterface', name);
      updateInterfaceInfo();
      renderLinkStrip();
    }
  } else {
    state.peer.interface = $('senderNodeInterface').value;
    state.peer.iface = state.peer.interfaces.find((i) => i.name === state.peer.interface) || null;
    localStorage.setItem('peerInterface', state.peer.interface);
    if ($('peerInterfacePin').querySelector(`option[value="${state.peer.interface}"]`)) {
      $('peerInterfacePin').value = state.peer.interface;
    }
    renderLinkStrip();
  }
});

$('receiverNodeInterface').addEventListener('change', () => {
  setControlSingleSelection('receiver', $('receiverNodeInterface').value);
  if (state.localRole === 'receiver') {
    const name = $('receiverNodeInterface').value;
    if (state.interfaces.find((i) => i.name === name)) {
      Array.from($('interfaceSelect').options).forEach((o) => { o.selected = (o.value === name); });
      renderInterfaceCheckboxes();
      localStorage.setItem('localInterface', name);
      updateInterfaceInfo();
      renderLinkStrip();
    }
  } else {
    state.peer.interface = $('receiverNodeInterface').value;
    state.peer.iface = state.peer.interfaces.find((i) => i.name === state.peer.interface) || null;
    localStorage.setItem('peerInterface', state.peer.interface);
    if ($('peerInterfacePin').querySelector(`option[value="${state.peer.interface}"]`)) {
      $('peerInterfacePin').value = state.peer.interface;
    }
    renderLinkStrip();
  }
});

// ?autoStart=1 — used for headless verification of the capture pipeline
const _autoStart = new URLSearchParams(location.search).get('autoStart') === '1';
// Decorate the topbar version chip
fetch('/api/version').then((r) => r.json()).then((j) => {
  const el = document.getElementById('versionTag');
  if (el && j?.commit) el.textContent = j.commit;
}).catch(() => {});

// Help overlay
function toggleHelp(force) {
  const ov = document.getElementById('helpOverlay');
  if (!ov) return;
  const show = force === undefined ? ov.classList.contains('hidden') : force;
  ov.classList.toggle('hidden', !show);
}
document.getElementById('helpButton')?.addEventListener('click', () => toggleHelp(true));
document.getElementById('helpClose')?.addEventListener('click', () => toggleHelp(false));
document.getElementById('helpOverlay')?.addEventListener('click', (e) => { if (e.target.id === 'helpOverlay') toggleHelp(false); });

// Global keyboard shortcuts. Skip when the user is typing into a text input.
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
  if (e.key === 'Escape') {
    if (!document.getElementById('helpOverlay')?.classList.contains('hidden')) { toggleHelp(false); e.preventDefault(); return; }
    if (state.serial?.sessionId) { serialDisconnect(); return; }
    if (capture.reader) { stopCaptureStream(); return; }
  }
  if (isTyping) {
    if (e.ctrlKey && e.key.toLowerCase() === 's' && document.getElementById('senderView')?.classList.contains('active')) {
      e.preventDefault(); $('saveCase')?.click(); return;
    }
    if (e.ctrlKey && e.key === 'Enter' && document.getElementById('senderView')?.classList.contains('active')) {
      e.preventDefault(); $('send')?.click(); return;
    }
    return;
  }
  if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
  const tabMap = { '1': 'senderView', '2': 'labView', '3': 'captureView', '4': 'hyperTerminalView', '5': 'serialView', '6': 'registerView', '7': 'fdbView', '8': 'autoView', '9': 'controlView' };
  if (tabMap[e.key]) { e.preventDefault(); showView(tabMap[e.key]); return; }
  if (document.getElementById('captureView')?.classList.contains('active')) {
    if (e.key.toLowerCase() === 's') { e.preventDefault(); ($('captureStart').disabled ? $('captureStop') : $('captureStart'))?.click(); return; }
    if (e.key.toLowerCase() === 'c') { e.preventDefault(); $('captureClear')?.click(); return; }
    if (e.key.toLowerCase() === 'p') { e.preventDefault(); $('captureSavePcap')?.click(); return; }
    if (e.key === '/')              { e.preventDefault(); $('captureDisplayFilter')?.focus(); return; }
  }
});

await loadExamples();
await loadTestProfiles();
await loadTestCases();
await loadInterfaces();
// Show actual Wi-Fi/LAN IP in the local URL pin so remote devices know the address
api('/api/local-addresses').then(d => {
  if (d.primary && d.primary !== 'localhost') {
    const el = $('localUrlPin');
    if (el) { el.value = `http://${d.primary}:${location.port || 8080}`; el.dataset.wifiSet = '1'; }
  }
}).catch(() => {});
const savedLocalIf = localStorage.getItem('localInterface');
if (savedLocalIf && state.interfaces.find((i) => i.name === savedLocalIf)) {
  Array.from($('interfaceSelect').options).forEach((o) => { o.selected = (o.value === savedLocalIf); });
  renderInterfaceCheckboxes();
  updateInterfaceInfo();
}
$('peerUrlPin').value = state.peer.url;
renderLinkStrip();
if (state.peer.url) probePeer().catch(() => {});
try {
  await build();
} catch (err) {
  console.warn('initial build skipped:', err.message);
  $('decoded').textContent = '// Build needs Source MAC / Source IP / Destination MAC.\n// Lock to peer above (or pick a profile) and press "Preview Frame".';
  $('hexdump').textContent = '';
}
setStatus('Ready');
clearCapture();
if (_autoStart) {
  setTimeout(() => $('captureStart')?.click(), 800);
  // Auto-click first packet after some traffic accumulates
  setTimeout(() => {
    fetch('/api/send', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      interface: $('interfaceSelect').value, protocol:'udp',
      dstMac:'c8:4d:44:20:40:5b', srcMac: localIface()?.mac,
      ipv4:{src:firstV4(localIface()), dst:'169.254.148.199', ttl:64},
      udp:{srcPort:40000,dstPort:50000},
      payload:{mode:'counter', size:1400}, targetFrameLength:1500,
      count:3, intervalMs:300
    })});
  }, 1500);
  setTimeout(() => $('packetRows')?.firstElementChild?.click(), 5500);
}
// Honour URL hash like #capture / #control / #sender to jump to a tab on load
(() => {
  const hash = location.hash.replace('#', '');
  const target = { capture: 'captureView', sender: 'senderView', lab: 'labView', hyper: 'hyperTerminalView', hyperterminal: 'hyperTerminalView', serial: 'serialView', register: 'registerView', fdb: 'fdbView', auto: 'autoView', control: 'controlView' }[hash.toLowerCase()];
  if (target) showView(target);
})();

// ── Register Tab ──────────────────────────────────────────────────────────────
async function regLoadStatus() {
  const el = document.getElementById('regStatus');
  if (!el) return;
  try {
    const d = await api('/api/register/status');
    el.textContent = `Serial: ${d.serialConnected ? '✓ 연결됨' : '✗ 미연결'} | Base Address: ${d.baseAddress || '-'}`;
    el.style.color = d.serialConnected ? 'var(--ok)' : 'var(--muted)';
  } catch (e) {
    el.textContent = `⚠ EthernetPacketGenerator 미연결 — ${e.message}`;
    el.style.color = 'var(--warn)';
  }
}

function regParseInput(val) {
  const s = (val || '').trim();
  if (!s) throw new Error('값을 입력하세요');
  if (!/^(0x[\da-fA-F]+|\d+)$/.test(s)) throw new Error(`잘못된 형식: "${s}" (예: 0x10 또는 16)`);
  return s;
}

// ── System Control helpers ─────────────────────────────────────────────────────
// Offset is relative to base address. The server-side register API already applies
// the base address stored in the C# app, so we send the offset raw.  But the web UI
// adds its own "Base Address" field so users can cross-check / override.  The field
// is informational only (the server owns the real base); we use it just for display.

function sysCtrlSetStatus(text, kind) {
  const el = document.getElementById('regSysCtrlStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'sysCtrlStatus' + (kind === 'ok' ? ' sysCtrlOk' : kind === 'err' ? ' sysCtrlErr' : kind === 'warn' ? ' sysCtrlWarn' : '');
}

function parseBcdByte(b) {
  return ((b >> 4) & 0xF) * 10 + (b & 0xF);
}

function parseVersionWord(v) {
  const major = (v >>> 24) & 0xFF;
  const year  = (v >>> 16) & 0xFF;
  const month = (v >>> 12) & 0xF;
  const day   = (v >>>  4) & 0xFF;
  const minor =  v         & 0xF;
  const majorName = major === 0x52 ? 'TSGW' : `0x${major.toString(16).toUpperCase().padStart(2,'0')}`;
  const yearVal = parseBcdByte(year);
  const dayVal  = parseBcdByte(day);
  const monthNames = ['','1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  const monthStr = monthNames[month] || `${month}월`;
  return `${majorName}  20${String(yearVal).padStart(2,'0')}년 ${monthStr} ${String(dayVal).padStart(2,'0')}일  v${minor}`;
}

async function sysCtrlReadVersion() {
  const d = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset: '0x000' }) });
  const raw = parseInt(d.value, 16);
  const verEl = document.getElementById('regVersionDisplay');
  if (verEl) verEl.textContent = parseVersionWord(raw) + `  (raw: ${d.value})`;
}

async function sysCtrlReadEnable() {
  const d = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset: '0x008' }) });
  const v = parseInt(d.value, 16);
  const ports = (v >>> 8) & 0xFF;
  const checks = ['regP0','regP1','regP2','regP3','regP4','regP5','regP6','regP7'];
  checks.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.checked = (ports & (1 << i)) !== 0;
  });
  const tsgw = document.getElementById('regTsgwEnable');
  if (tsgw) tsgw.checked = (v & 0x1) !== 0;
}

async function sysCtrlReadHostIf() {
  const d = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset: '0x00C' }) });
  const v = parseInt(d.value, 16);
  const wrEl = document.getElementById('regAhbWrWait');
  const rdEl = document.getElementById('regAhbRdWait');
  if (wrEl) wrEl.value = v & 0xF;
  if (rdEl) rdEl.value = (v >>> 4) & 0xF;
}

document.getElementById('regReadAllBtn')?.addEventListener('click', async () => {
  sysCtrlSetStatus('읽는 중...', '');
  try {
    await sysCtrlReadVersion();
    await sysCtrlReadEnable();
    await sysCtrlReadHostIf();
    sysCtrlSetStatus('읽기 완료', 'ok');
  } catch (e) { sysCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('regLoadDefaultsBtn')?.addEventListener('click', async () => {
  sysCtrlSetStatus('기본값 로드 중...', '');
  try {
    await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset: '0x004', value: '0x1' }) });
    sysCtrlSetStatus('기본값 로드 완료', 'ok');
  } catch (e) { sysCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('regApplyEnableBtn')?.addEventListener('click', async () => {
  sysCtrlSetStatus('Enable 설정 적용 중...', '');
  try {
    const checks = ['regP0','regP1','regP2','regP3','regP4','regP5','regP6','regP7'];
    let ports = 0;
    checks.forEach((id, i) => {
      if (document.getElementById(id)?.checked) ports |= (1 << i);
    });
    const tsgw = document.getElementById('regTsgwEnable')?.checked ? 1 : 0;
    const v = tsgw | (ports << 8);
    await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset: '0x008', value: `0x${v.toString(16).toUpperCase()}` }) });
    sysCtrlSetStatus(`Enable 적용 완료 (0x${v.toString(16).toUpperCase().padStart(8,'0')})`, 'ok');
  } catch (e) { sysCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('regApplyAhbBtn')?.addEventListener('click', async () => {
  sysCtrlSetStatus('AHB 설정 적용 중...', '');
  try {
    const wr = Math.max(0, Math.min(15, parseInt(document.getElementById('regAhbWrWait')?.value || '15', 10)));
    const rd = Math.max(0, Math.min(15, parseInt(document.getElementById('regAhbRdWait')?.value || '15', 10)));
    const v = (rd << 4) | wr;
    await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset: '0x00C', value: `0x${v.toString(16).toUpperCase()}` }) });
    sysCtrlSetStatus(`AHB 적용 완료 (WR=${wr}, RD=${rd})`, 'ok');
  } catch (e) { sysCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('regReadBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('regReadResult');
  if (!out) return;
  let offset;
  try { offset = regParseInput(document.getElementById('regReadOffset')?.value); }
  catch (e) { out.textContent = `입력 오류: ${e.message}`; out.style.color = 'var(--warn)'; return; }
  out.textContent = '읽는 중...'; out.style.color = 'var(--muted)';
  try {
    const d = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
    const dec = d.valueDec ?? d.valueNum ?? '';
    out.textContent = `offset : ${d.offset}\nvalue  : ${d.value}\n         (dec: ${dec})`;
    out.style.color = 'var(--accent)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

document.getElementById('regWriteBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('regWriteResult');
  if (!out) return;
  let offset, value;
  try {
    offset = regParseInput(document.getElementById('regWriteOffset')?.value);
    value  = regParseInput(document.getElementById('regWriteValue')?.value);
  } catch (e) { out.textContent = `입력 오류: ${e.message}`; out.style.color = 'var(--warn)'; return; }
  out.textContent = '쓰는 중...'; out.style.color = 'var(--muted)';
  try {
    const d = await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value }) });
    out.textContent = `완료: ${d.status || 'written'}`;
    out.style.color = 'var(--ok)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

document.querySelector('[data-htview="registerView"]')?.addEventListener('click', () => regLoadStatus().catch(() => {}));

// ── FDB Tab ───────────────────────────────────────────────────────────────────
const MAC_RE = /^([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}$/;

// FDB Control helpers
const FDB_OFF_VERSION    = '0xA00';
const FDB_OFF_FDB_LOAD   = '0xA04';
const FDB_OFF_ENABLE     = '0xA0C';
const FDB_OFF_AGE_PERIOD = '0xA10';
const FDB_OFF_AGING_THR  = '0xA14';
const FDB_OFF_MCU_MAC0   = '0xA18';
const FDB_OFF_MCU_MAC1   = '0xA1C';
const FDB_OFF_MCU_VLAN   = '0xA20';
const FDB_OFF_MCU_BUCKET = '0xA28';
const FDB_OFF_MCU_CMD    = '0xA2C';
const FDB_OFF_FDB_STATUS = '0xA40';
const FDB_OFF_CMD_STATUS = '0xA44';
const FDB_OFF_RD_BUCKET  = '0xA48';
const FDB_OFF_RD_PORT    = '0xA4C';
const FDB_OFF_RD_FLAGS   = '0xA50';
const FDB_OFF_RD_MAC0    = '0xA54';
const FDB_OFF_RD_MAC1    = '0xA58';
const FDB_OFF_RD_MAC2    = '0xA5C';

function fdbCtrlSetStatus(text, kind) {
  const el = document.getElementById('fdbCtrlStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'sysCtrlStatus' + (kind === 'ok' ? ' sysCtrlOk' : kind === 'err' ? ' sysCtrlErr' : kind === 'warn' ? ' sysCtrlWarn' : '');
}

async function fdbRegRead(offset) {
  const d = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
  return parseInt(d.value, 16);
}

async function fdbRegWrite(offset, value) {
  await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value: `0x${value.toString(16).toUpperCase().padStart(8,'0')}` }) });
}

async function fdbPollStatus(bitMask, statusOffset, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fdbRegRead(statusOffset);
    if ((v & bitMask) !== 0) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`폴링 타임아웃 (mask=0x${bitMask.toString(16)}, offset=${statusOffset})`);
}

function parseMacToWords(mac) {
  const bytes = mac.split(':').map(s => parseInt(s, 16));
  // bytes[0]=MSB ... bytes[5]=LSB
  // MAC0 = bytes[2..5] (little-endian layout matching C# service)
  const mac0 = (bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
  const mac1 = (bytes[0] << 8)  |  bytes[1];
  return { mac0: mac0 >>> 0, mac1: mac1 >>> 0 };
}

function formatMacFromWords(hi16, mid16, lo16) {
  const b = (n, shift, mask) => ((n >>> shift) & mask).toString(16).padStart(2, '0').toUpperCase();
  return `${b(hi16,8,0xFF)}:${b(hi16,0,0xFF)}:${b(mid16,8,0xFF)}:${b(mid16,0,0xFF)}:${b(lo16,8,0xFF)}:${b(lo16,0,0xFF)}`;
}

document.getElementById('fdbReadStatusBtn')?.addEventListener('click', async () => {
  fdbCtrlSetStatus('읽는 중...', '');
  try {
    const ver = await fdbRegRead(FDB_OFF_VERSION);
    const verEl = document.getElementById('fdbVersionDisplay');
    if (verEl) verEl.textContent = `Version: 0x${ver.toString(16).toUpperCase().padStart(8,'0')}`;

    const en = await fdbRegRead(FDB_OFF_ENABLE);
    const ageScan  = document.getElementById('fdbAgeScanEnable');
    const learning = document.getElementById('fdbLearningEnable');
    const lookup   = document.getElementById('fdbLookupEnable');
    if (ageScan)  ageScan.checked  = (en & (1 << 4)) !== 0;
    if (learning) learning.checked = (en & (1 << 1)) !== 0;
    if (lookup)   lookup.checked   = (en & (1 << 0)) !== 0;

    const agePeriod = await fdbRegRead(FDB_OFF_AGE_PERIOD);
    const agingThr  = await fdbRegRead(FDB_OFF_AGING_THR);
    const apEl = document.getElementById('fdbAgePeriodNs');
    const atEl = document.getElementById('fdbAgingThr');
    if (apEl) apEl.value = agePeriod;
    if (atEl) atEl.value = agingThr;

    fdbCtrlSetStatus('읽기 완료', 'ok');
  } catch (e) { fdbCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('fdbLoadDefaultsBtn')?.addEventListener('click', async () => {
  fdbCtrlSetStatus('Default Load 중...', '');
  try {
    await fdbRegWrite(FDB_OFF_FDB_LOAD, 1);
    fdbCtrlSetStatus('Default Load 완료', 'ok');
  } catch (e) { fdbCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('fdbApplyEnableBtn')?.addEventListener('click', async () => {
  fdbCtrlSetStatus('Enable 적용 중...', '');
  try {
    let en = 0;
    if (document.getElementById('fdbAgeScanEnable')?.checked)  en |= (1 << 4);
    if (document.getElementById('fdbLearningEnable')?.checked) en |= (1 << 1);
    if (document.getElementById('fdbLookupEnable')?.checked)   en |= (1 << 0);
    await fdbRegWrite(FDB_OFF_ENABLE, en);
    fdbCtrlSetStatus(`ENABLE 적용 완료 (0x${en.toString(16).toUpperCase()})`, 'ok');
  } catch (e) { fdbCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

document.getElementById('fdbApplyAgingBtn')?.addEventListener('click', async () => {
  fdbCtrlSetStatus('Aging 설정 적용 중...', '');
  try {
    const ap = parseInt(document.getElementById('fdbAgePeriodNs')?.value || '0', 10);
    const at = parseInt(document.getElementById('fdbAgingThr')?.value    || '0', 10);
    await fdbRegWrite(FDB_OFF_AGE_PERIOD, ap);
    await fdbRegWrite(FDB_OFF_AGING_THR,  at);
    fdbCtrlSetStatus(`Aging 적용 완료 (Period=${ap}ns, Thr=${at}×100ms)`, 'ok');
  } catch (e) { fdbCtrlSetStatus(`오류: ${e.message}`, 'err'); }
});

// FDB Bucket Read (CMD=0x13)
document.getElementById('fdbBucketReadBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('fdbBucketResult');
  if (!out) return;
  out.textContent = '읽는 중...'; out.style.color = 'var(--muted)';
  try {
    const bucketStr = (document.getElementById('fdbBucketNum')?.value || '0').trim();
    const slotStr   = (document.getElementById('fdbSlotBitmap')?.value || '0x1').trim();
    const bucket = parseInt(bucketStr, 10);
    const slot   = slotStr.startsWith('0x') || slotStr.startsWith('0X')
                     ? parseInt(slotStr, 16) : parseInt(slotStr, 10);
    if (bucket < 0 || bucket > 1023) throw new Error('Bucket은 0~1023 범위입니다');
    if (slot < 1 || slot > 0xF)     throw new Error('Slot bitmap은 0x1~0xF 범위입니다');

    const bucketReg = ((slot & 0xF) << 16) | (bucket & 0x3FF);
    await fdbRegWrite(FDB_OFF_MCU_BUCKET, bucketReg);
    await fdbRegWrite(FDB_OFF_MCU_CMD,    0x13);      // CMD_READ_BUCKET

    // Poll CMD_STATUS [0] = RD-MAC valid
    await fdbPollStatus(0x1, FDB_OFF_CMD_STATUS, 1000);

    const flags  = await fdbRegRead(FDB_OFF_RD_FLAGS);
    const valid  = (flags & 0x8000) !== 0;
    const isStatic = (flags & 0x4000) !== 0;
    const timestamp = flags & 0x3FFF;

    if (!valid) {
      out.textContent = `Bucket ${bucket} / Slot 0x${slot.toString(16).toUpperCase()}: 슬롯 비어있음 (Valid 비트 = 0)`;
      out.style.color = 'var(--warn)';
      return;
    }

    const mac0    = await fdbRegRead(FDB_OFF_RD_MAC0);
    const mac1    = await fdbRegRead(FDB_OFF_RD_MAC1);
    const mac2    = await fdbRegRead(FDB_OFF_RD_MAC2);
    const rdPort  = await fdbRegRead(FDB_OFF_RD_PORT);
    const rdBkt   = await fdbRegRead(FDB_OFF_RD_BUCKET);

    const macStr  = formatMacFromWords(mac2 & 0xFFFF, mac1 & 0xFFFF, mac0 & 0xFFFF);
    const port    = rdPort & 0x1FF;
    const rdBucket = rdBkt & 0x3FF;
    const rdSlot  = (rdBkt >>> 12) & 0xF;

    out.textContent = [
      `Bucket    : ${rdBucket}`,
      `Slot      : 0x${rdSlot.toString(16).toUpperCase()}`,
      `MAC       : ${macStr}`,
      `Port      : ${port}`,
      `Type      : ${isStatic ? 'Static' : 'Dynamic'}`,
      `Timestamp : ${timestamp}`,
      `Flags raw : 0x${flags.toString(16).toUpperCase().padStart(4,'0')}`
    ].join('\n');
    out.style.color = 'var(--accent)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

function fdbParams(requireMac = true) {
  const mac = (document.getElementById('fdbMac')?.value || '').trim();
  if (requireMac && !MAC_RE.test(mac)) throw new Error(`잘못된 MAC 주소: "${mac}" (예: AA:BB:CC:DD:EE:FF)`);
  return {
    mac,
    vlanValid: document.getElementById('fdbVlanValid')?.checked || false,
    vlanId:    Number(document.getElementById('fdbVlanId')?.value  || 0),
    port:      Number(document.getElementById('fdbPort')?.value    || 0)
  };
}

function fdbShow(text, state) {
  const el = document.getElementById('fdbResult');
  if (!el) return;
  el.textContent = text;
  el.style.color = state === 'ok' ? 'var(--ok)' : state === 'warn' ? 'var(--warn)' : state === 'err' ? '#b91c1c' : 'var(--accent)';
}

document.getElementById('fdbReadBtn')?.addEventListener('click', async () => {
  try {
    const { mac, vlanValid, vlanId } = fdbParams();
    fdbShow('읽는 중...', null);
    const d = await api('/api/fdb/read', { method: 'POST', body: JSON.stringify({ mac, vlanValid, vlanId }) });
    fdbShow(d.found ? `found: true\n${JSON.stringify(d.entry, null, 2)}` : 'found: false — 엔트리 없음', d.found ? null : 'warn');
  } catch (e) { fdbShow(`오류: ${e.message}`, 'err'); }
});

document.getElementById('fdbWriteBtn')?.addEventListener('click', async () => {
  try {
    const { mac, vlanValid, vlanId, port } = fdbParams();
    fdbShow('쓰는 중...', null);
    const d = await api('/api/fdb/write', { method: 'POST', body: JSON.stringify({ mac, vlanValid, vlanId, port }) });
    fdbShow(`완료: ${d.status}`, 'ok');
  } catch (e) { fdbShow(`오류: ${e.message}`, 'err'); }
});

document.getElementById('fdbDeleteBtn')?.addEventListener('click', async () => {
  try {
    const { mac, vlanValid, vlanId } = fdbParams();
    fdbShow('삭제 중...', null);
    const d = await api('/api/fdb/delete', { method: 'POST', body: JSON.stringify({ mac, vlanValid, vlanId }) });
    fdbShow(`완료: ${d.status}`, 'ok');
  } catch (e) { fdbShow(`오류: ${e.message}`, 'err'); }
});

document.getElementById('fdbFlushBtn')?.addEventListener('click', async () => {
  if (!confirm('FDB 전체 엔트리를 삭제합니다. 계속하시겠습니까?')) return;
  try {
    fdbShow('Flush 중...', null);
    const d = await api('/api/fdb/flush', { method: 'POST', body: '{}' });
    fdbShow(`완료: ${d.status}`, 'ok');
  } catch (e) { fdbShow(`오류: ${e.message}`, 'err'); }
});

// ── Auto Tab ──────────────────────────────────────────────────────────────────
let _autoPollTimer = null;

function autoSetBadge(badge, state, label) {
  if (!badge) return;
  badge.textContent = label;
  badge.className = `statusBadge${state ? ' ' + state : ''}`;
}

async function autoPoll() {
  try {
    const d = await api('/api/auto/status');
    const badge = document.getElementById('autoStatusBadge');
    const text  = document.getElementById('autoStatusText');
    if (text) text.textContent = d.statusText || '';
    if (d.running) {
      autoSetBadge(badge, 'running', 'running');
    } else {
      autoSetBadge(badge, d.result === 'PASS' ? 'pass' : d.result === 'FAIL' ? 'fail' : '', d.result || 'idle');
      clearInterval(_autoPollTimer); _autoPollTimer = null;
    }
    const rows = await api('/api/auto/results').catch(() => ({ rows: [] }));
    autoRenderRows(rows.rows || []);
  } catch (e) {
    const el = document.getElementById('autoStatusText');
    if (el) el.textContent = `⚠ EthernetPacketGenerator 미연결 — ${e.message}`;
    clearInterval(_autoPollTimer); _autoPollTimer = null;
  }
}

function autoRenderRows(rows) {
  const tbody = document.getElementById('autoResultRows');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:1.5rem;">테스트를 실행하면 결과가 표시됩니다.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const res = r.result === 'PASS' ? 'PASS' : r.result === 'FAIL' ? 'FAIL' : (r.result ?? '-');
    const cls = r.result === 'PASS' ? 'passText' : r.result === 'FAIL' ? 'failText' : '';
    const m = (v) => `<td class="${v ? 'passText' : 'failText'}">${v ? '✓' : '✗'}</td>`;
    return `<tr>
      <td>${r.step ?? '-'}</td>
      <td>${r.testType ?? '-'}</td>
      <td>${r.expectedMode ?? '-'}</td>
      <td>${r.expectedPort ?? '-'}</td>
      ${m(r.txMatch)}${m(r.port1Match)}${m(r.port2Match)}${m(r.port3Match)}
      <td class="${cls}">${res}</td>
      <td style="font-size:.75rem;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.reason ?? ''}">${r.reason ?? ''}</td>
    </tr>`;
  }).join('');
}

document.getElementById('autoRunBtn')?.addEventListener('click', async () => {
  const test  = document.getElementById('autoTestSelect')?.value;
  const badge = document.getElementById('autoStatusBadge');
  const text  = document.getElementById('autoStatusText');
  autoSetBadge(badge, 'running', 'starting...');
  if (text) text.textContent = '';
  try {
    await api('/api/auto/run', { method: 'POST', body: JSON.stringify({ test }) });
    clearInterval(_autoPollTimer);
    _autoPollTimer = setInterval(autoPoll, 1500);
    autoPoll();
  } catch (e) {
    autoSetBadge(badge, 'fail', 'error');
    if (text) text.textContent = e.message;
  }
});

document.querySelector('[data-htview="autoView"]')?.addEventListener('click', () => autoPoll());

// ============================================================
// Port Monitor — 6-port switch live link status
// ============================================================

let _portMonitorTimer = null;

async function portMonitorPoll() {
  const grid = document.getElementById('portMonitorGrid');
  const timeEl = document.getElementById('portMonitorTime');
  try {
    const d = await api('/api/ports/link-status');
    const ports = d.ports || [];
    ports.forEach((p) => { portLinkStatus[p.port] = p.linkUp; });
    if (grid) {
      grid.innerHTML = portLinkStatus.map((up, i) => {
        const cls = up === true ? 'up' : up === false ? 'down' : '';
        const label = up === true ? 'Link UP' : up === false ? 'Link DOWN' : '—';
        return `<div class="portMonitorCard ${cls}">
          <div class="portMonitorDot"></div>
          <div class="portMonitorLabel">Port ${i}</div>
          <div class="portMonitorState">${label}</div>
        </div>`;
      }).join('');
    }
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
    renderControlTopology();
  } catch (e) {
    if (grid) grid.innerHTML = `<div class="portMonitorPlaceholder">⚠ ${e.message} — EthernetPacketGenerator 연결 필요</div>`;
    if (timeEl) timeEl.textContent = '';
  }
}

document.getElementById('portMonitorRefresh')?.addEventListener('click', portMonitorPoll);

document.querySelector('[data-htview="controlView"]')?.addEventListener('click', () => {
  refreshBackendStatus().catch(() => {});
  portMonitorPoll();
  if (!_portMonitorTimer) {
    _portMonitorTimer = setInterval(portMonitorPoll, 3000);
  }
});

$('backendRefresh')?.addEventListener('click', () => refreshBackendStatus().catch(toastError));

// Stop polling when leaving Control sub-tab or HyperTerminal top-level tab
document.querySelectorAll('[data-htview]').forEach((btn) => {
  if (btn.dataset.htview !== 'controlView') {
    btn.addEventListener('click', () => { clearInterval(_portMonitorTimer); _portMonitorTimer = null; });
  }
});
document.querySelectorAll('[data-view]').forEach((btn) => {
  if (btn.dataset.view !== 'hyperTerminalView') {
    btn.addEventListener('click', () => { clearInterval(_portMonitorTimer); _portMonitorTimer = null; });
  }
});

// ============================================================
// ECharts — Benchmark / RFC 2544 / Sweep result charts
// ============================================================

const _echartsInstances = {};

function getChart(id) {
  const el = document.getElementById(id);
  if (!el || typeof echarts === 'undefined') return null;
  if (!_echartsInstances[id]) _echartsInstances[id] = echarts.init(el, null, { renderer: 'svg' });
  return _echartsInstances[id];
}

function showChartPanel(panelId) {
  const el = document.getElementById(panelId);
  if (el) el.classList.remove('hidden');
}

// ── Capture — protocol distribution pie chart ─────────────────────────────
function renderCaptureProtoChart(rows) {
  const panel = $('caChartPanel');
  if (!rows.length) { if (panel) panel.classList.add('hidden'); return; }
  if (panel) panel.classList.remove('hidden');

  const chart = getChart('caProtoChart');
  if (!chart) return;

  const counts = { ARP: 0, UDP: 0, TCP: 0, ICMP: 0, Other: 0 };
  for (const r of rows) {
    const d = r.decoded || {};
    if (d.arp)       counts.ARP++;
    else if (d.udp)  counts.UDP++;
    else if (d.tcp)  counts.TCP++;
    else if (d.icmp) counts.ICMP++;
    else             counts.Other++;
  }
  const colors = { ARP: '#f59e0b', UDP: '#0b5cab', TCP: '#16a34a', ICMP: '#7c3aed', Other: '#6b7280' };
  const data   = Object.entries(counts).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }));

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', right: 8, top: 'middle', textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['38%', '65%'], center: ['38%', '50%'],
      data, label: { fontSize: 11 },
      itemStyle: { color: (p) => colors[p.name] || '#6b7280' }
    }]
  }, true);
}

// ── Bidir simple test — sent vs matched bar chart ─────────────────────────
function renderBidirSimpleChart(report) {
  const wrap = $('sbfSimpleChartWrap');
  if (!report || !report.directions) { if (wrap) wrap.classList.add('hidden'); return; }
  if (wrap) wrap.classList.remove('hidden');

  const chart = getChart('sbfSimpleChart');
  if (!chart) return;

  const dirs    = report.directions;
  const labels  = dirs.map((d) => d.direction);
  const sent    = dirs.map((d) => d.sent    || d.count || 0);
  const matched = dirs.map((d) => d.matched || 0);
  const colors  = dirs.map((d) => d.result === 'PASS' ? '#16a34a' : '#ef4444');

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['Sent', 'Matched'], top: 4, textStyle: { fontSize: 12 } },
    grid: { left: 44, right: 16, bottom: 36, top: 44 },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 12 } },
    yAxis: { type: 'value', name: 'Packets', nameTextStyle: { fontSize: 11 } },
    series: [
      { name: 'Sent',    type: 'bar', data: sent,    barGap: '5%',
        itemStyle: { color: '#94a3b8' } },
      { name: 'Matched', type: 'bar', data: matched,
        itemStyle: { color: (p) => colors[p.dataIndex] },
        label: { show: true, position: 'top', fontSize: 12,
                 formatter: (p) => dirs[p.dataIndex].result } }
    ]
  }, true);
}

function renderBenchChart(results) {
  showChartPanel('benchChartPanel');
  const chart = getChart('benchChart');
  if (!chart) return;
  const valid = results.filter((r) => r.report);
  const labels = valid.map((r) => r.pair.label);
  const mbps   = valid.map((r) => Number(r.report.stats.throughputMbps || 0).toFixed(2));
  const loss   = valid.map((r) => Number(r.report.stats.lossPct || 0).toFixed(2));
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['Throughput (Mbps)', 'Loss (%)'], top: 4 },
    grid: { left: 50, right: 50, bottom: 36, top: 40 },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 11, rotate: labels.length > 3 ? 20 : 0 } },
    yAxis: [
      { type: 'value', name: 'Mbps', nameTextStyle: { fontSize: 11 }, axisLabel: { fontSize: 11 } },
      { type: 'value', name: 'Loss %', nameTextStyle: { fontSize: 11 }, axisLabel: { fontSize: 11 }, max: 100 }
    ],
    series: [
      { name: 'Throughput (Mbps)', type: 'bar', data: mbps, itemStyle: { color: '#0b5cab' } },
      { name: 'Loss (%)', type: 'bar', yAxisIndex: 1, data: loss, itemStyle: { color: '#ef4444' } }
    ]
  });
}

function renderRfcChart(rfcResults) {
  showChartPanel('rfcChartPanel');
  const chart = getChart('rfcChart');
  if (!chart) return;
  const sizes = rfcResults.map((r) => r.frameSize || r.frame_size || r.size || '?');
  const util  = rfcResults.map((r) => Number(r.utilizationPct || 0).toFixed(1));
  const p95   = rfcResults.map((r) => Number(r.p95LatencyUs || r.latencyP95Us || 0).toFixed(1));
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['Utilization (%)', 'P95 Latency (µs)'], top: 4 },
    grid: { left: 60, right: 60, bottom: 36, top: 40 },
    xAxis: { type: 'category', data: sizes, name: 'Frame size (B)', nameLocation: 'middle', nameGap: 26, axisLabel: { fontSize: 11 } },
    yAxis: [
      { type: 'value', name: 'Util %', max: 100, nameTextStyle: { fontSize: 11 }, axisLabel: { fontSize: 11 } },
      { type: 'value', name: 'Lat µs', nameTextStyle: { fontSize: 11 }, axisLabel: { fontSize: 11 } }
    ],
    series: [
      { name: 'Utilization (%)', type: 'line', data: util, symbol: 'circle', lineStyle: { color: '#0b5cab' }, itemStyle: { color: '#0b5cab' } },
      { name: 'P95 Latency (µs)', type: 'line', yAxisIndex: 1, data: p95, symbol: 'diamond', lineStyle: { color: '#f59e0b', type: 'dashed' }, itemStyle: { color: '#f59e0b' } }
    ]
  });
}

function renderSweepChart(sweepResults) {
  showChartPanel('sweepChartPanel');
  const chart = getChart('sweepChart');
  if (!chart) return;
  const sizes  = sweepResults.map((r) => r.frameSize || r.frame_size || r.payloadSize || '?');
  const mbps   = sweepResults.map((r) => {
    const s = r.stats || {};
    return Number(s.throughputMbps || 0).toFixed(2);
  });
  const loss   = sweepResults.map((r) => {
    const s = r.stats || {};
    return Number(s.lossPct || 0).toFixed(2);
  });
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['Throughput (Mbps)', 'Loss (%)'], top: 4 },
    grid: { left: 60, right: 60, bottom: 36, top: 40 },
    xAxis: { type: 'category', data: sizes, name: 'Frame size (B)', nameLocation: 'middle', nameGap: 26, axisLabel: { fontSize: 11 } },
    yAxis: [
      { type: 'value', name: 'Mbps', nameTextStyle: { fontSize: 11 }, axisLabel: { fontSize: 11 } },
      { type: 'value', name: 'Loss %', max: 100, nameTextStyle: { fontSize: 11 }, axisLabel: { fontSize: 11 } }
    ],
    series: [
      { name: 'Throughput (Mbps)', type: 'line', data: mbps, areaStyle: { color: 'rgba(11,92,171,.15)' }, symbol: 'circle', lineStyle: { color: '#0b5cab' }, itemStyle: { color: '#0b5cab' } },
      { name: 'Loss (%)', type: 'line', yAxisIndex: 1, data: loss, symbol: 'triangle', lineStyle: { color: '#ef4444', type: 'dashed' }, itemStyle: { color: '#ef4444' } }
    ]
  });
}

// ============================================================
// Lab tab — TestCase Manager + Sequence Sender
// ============================================================

const labState = { selectedGroupIndex: 0, selectedTestCaseIndex: null };

async function labLoadTestCases() {
  try {
    const data = await api('/api/testcases/status');
    const tc = data.snapshot || data.testCases || {};
    const el = document.getElementById('tcStatus');
    if (el) el.textContent = `${tc.status || ''} Selected: ${tc.selected || '(none)'}`;
    labRenderTree(tc.groups || []);
    labRenderSequence(tc.sequence || []);
  } catch (err) {
    const el = document.getElementById('tcStatus');
    if (el) el.textContent = `Load failed: ${err.message}`;
  }
}

function labRenderTree(groups) {
  const root = document.getElementById('tcTree');
  if (!root) return;
  if (!groups.length) {
    root.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:8px;">No test case groups yet.</div>';
    return;
  }
  const gi = (g) => g.index ?? groups.indexOf(g);
  root.innerHTML = groups.map((g) => {
    const gIdx = gi(g);
    return `
    <div style="background:rgba(255,255,255,.72);border:1px solid var(--line);border-radius:14px;padding:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong style="font-size:.9rem;">${escHtml(g.name || `Group ${gIdx}`)}</strong>
        <button class="ghostBtn small tc-delete-group" data-group="${gIdx}" style="color:#b91c1c;">✕ Del Group</button>
      </div>
      ${(g.testCases || []).map((tc) => {
        const tIdx = tc.index ?? (g.testCases || []).indexOf(tc);
        const sel = tc.selected === true;
        return `
        <div style="display:flex;align-items:center;gap:4px;margin-top:4px;">
          <button class="tc-item" data-group="${gIdx}" data-tc="${tIdx}"
                  style="flex:1;text-align:left;padding:7px 10px;border-radius:10px;background:${sel ? 'linear-gradient(135deg,#0b5cab,#00a3ad)' : '#f8fbfd'};color:${sel ? 'white' : 'inherit'};border:1px solid #e3ebf3;">
            ${escHtml(tc.name || `TC ${tIdx}`)}
            <small style="opacity:.7;font-size:.78rem;margin-left:6px;">${tc.itemCount != null ? `${tc.itemCount} steps` : ''}</small>
          </button>
          <button class="ghostBtn small tc-delete-tc" data-group="${gIdx}" data-tc="${tIdx}" style="color:#b91c1c;flex-shrink:0;">✕</button>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  root.querySelectorAll('.tc-item').forEach((btn) => btn.addEventListener('click', async () => {
    labState.selectedGroupIndex = Number(btn.dataset.group);
    labState.selectedTestCaseIndex = Number(btn.dataset.tc);
    await api('/api/testcases/select', {
      method: 'POST',
      body: JSON.stringify({ groupIndex: labState.selectedGroupIndex, testCaseIndex: labState.selectedTestCaseIndex }),
    });
    await labLoadTestCases();
  }));

  root.querySelectorAll('.tc-delete-group').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Delete this group?')) return;
    await api('/api/testcases/delete', { method: 'POST', body: JSON.stringify({ groupIndex: Number(btn.dataset.group) }) });
    await labLoadTestCases();
  }));

  root.querySelectorAll('.tc-delete-tc').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this test case?')) return;
    await api('/api/testcases/delete', {
      method: 'POST',
      body: JSON.stringify({ groupIndex: Number(btn.dataset.group), testCaseIndex: Number(btn.dataset.tc) }),
    });
    await labLoadTestCases();
  }));
}

function labRenderSequence(items) {
  const tbody = document.getElementById('sequenceRows');
  if (!tbody) return;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:1rem;">No sequence items — add an event above or select a test case</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((s, i) => {
    const idx = s.index ?? i;
    const kind = s.kind || 'Event';
    const evType = s.eventType || s.kind || '';
    const rawLabel = s.label || s.name
      || (s.serialText ? `"${s.serialText}"` : '')
      || (s.captureFilter ? s.captureFilter : '')
      || evType || '';
    const label = escHtml(rawLabel);
    const addr = escHtml(s.address || s.macAddress || '');
    const val  = escHtml(s.value || s.serialHex || '');
    const timing = s.delayMs != null ? `${s.delayMs} ms`
                 : s.timeoutMs != null ? `${s.timeoutMs} ms`
                 : (s.timingMs != null ? `${s.timingMs} ms` : '');
    return `<tr>
      <td>${idx + 1}</td>
      <td><span class="sbfBadge ${kind === 'Event' ? 'sbf-monitor' : 'sbf-primary'}">${escHtml(kind)}</span></td>
      <td style="font-size:.78rem;">${escHtml(evType)}</td>
      <td style="font-size:.8rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;" title="${label}">${label}</td>
      <td class="monoInput" style="font-size:.75rem;">${addr}</td>
      <td class="monoInput" style="font-size:.75rem;">${val}</td>
      <td style="font-size:.78rem;">${escHtml(timing)}</td>
      <td><button class="ghostBtn" style="min-height:22px;padding:0 6px;font-size:.72rem;color:#b91c1c;border-color:#b91c1c;" data-seq-remove="${idx}">✕</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-seq-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.seqRemove);
      await api('/api/sequence/event/remove', { method: 'POST', body: JSON.stringify({ index: idx }) });
      await labLoadSequence();
    });
  });
}

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function labRunSequence() {
  try {
    const data = await api('/api/sequence/run', { method: 'POST', body: '{}' });
    const st = data.status || 'started';
    const el = document.getElementById('tcStatus');
    if (el) el.textContent = `Sequence: ${st}`;
  } catch (err) {
    alert(`Run sequence failed: ${err.message}`);
  }
}

async function labAddGroup() {
  const inp = document.getElementById('tcGroupName');
  if (!inp?.value.trim()) return;
  await api('/api/testcases/add-group', { method: 'POST', body: JSON.stringify({ name: inp.value.trim() }) });
  inp.value = '';
  await labLoadTestCases();
}

async function labAddTestCase() {
  const inp = document.getElementById('tcName');
  if (!inp?.value.trim()) return;
  await api('/api/testcases/add', {
    method: 'POST',
    body: JSON.stringify({ groupIndex: labState.selectedGroupIndex || 0, name: inp.value.trim() }),
  });
  inp.value = '';
  await labLoadTestCases();
}

async function labSaveCurrent() {
  try {
    await api('/api/testcases/save-current', { method: 'POST', body: '{}' });
    await labLoadTestCases();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

document.getElementById('tcRunSequence')?.addEventListener('click', labRunSequence);
document.getElementById('tcSaveCurrent')?.addEventListener('click', labSaveCurrent);
document.getElementById('tcRefresh')?.addEventListener('click', labLoadTestCases);
document.getElementById('tcAddGroup')?.addEventListener('click', labAddGroup);
document.getElementById('tcAdd')?.addEventListener('click', labAddTestCase);
document.querySelector('[data-view="labView"]')?.addEventListener('click', () => { labLoadTestCases(); labLoadSequence(); });

async function labLoadSequence() {
  try {
    const data = await api('/api/sequence/full');
    labRenderSequence(data.items || []);
  } catch (err) {
    const tbody = document.getElementById('sequenceRows');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:var(--muted);padding:1rem;text-align:center;">⚠ ${escHtml(err.message)}</td></tr>`;
  }
}

function seqUpdateFields() {
  const t = document.getElementById('seqEventType')?.value || 'Delay';
  const showDelay          = t === 'Delay';
  const showAddr           = ['RegWrite','RegRead','RegWaitFor','FdbWaitFor'].includes(t);
  const showValue          = t === 'RegWrite';
  const showMask           = ['RegWaitFor','FdbWaitFor'].includes(t);
  const showExpected       = ['RegWaitFor','FdbWaitFor'].includes(t);
  const showTimeout        = ['RegWaitFor','FdbWaitFor','SerialVerify','CaptureVerify'].includes(t);
  const showMac            = ['FdbWrite','FdbRead'].includes(t);
  const showPort           = t === 'FdbWrite';
  const showSerialText     = ['SerialSend','SerialVerify'].includes(t);
  const showSerialHex      = t === 'SerialSend';
  const showCaptureIface   = t === 'CaptureVerify';
  const showCaptureFilter  = t === 'CaptureVerify';
  const showCaptureExpected= t === 'CaptureVerify';
  const set = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  };
  set('seqDelayField',          showDelay);
  set('seqAddrField',           showAddr);
  set('seqValueField',          showValue);
  set('seqMaskField',           showMask);
  set('seqExpectedField',       showExpected);
  set('seqTimeoutField',        showTimeout);
  set('seqMacField',            showMac);
  set('seqPortField',           showPort);
  set('seqSerialTextField',     showSerialText);
  set('seqSerialHexField',      showSerialHex);
  set('seqCaptureIfaceField',   showCaptureIface);
  set('seqCaptureFilterField',  showCaptureFilter);
  set('seqCaptureExpectedField',showCaptureExpected);
}

document.getElementById('seqEventType')?.addEventListener('change', seqUpdateFields);
seqUpdateFields(); // init

document.getElementById('seqAddEvent')?.addEventListener('click', async () => {
  const evType = document.getElementById('seqEventType')?.value || 'Delay';
  const body = {
    eventType:       evType,
    delayMs:         Number(document.getElementById('seqDelayMs')?.value          || 100),
    address:         document.getElementById('seqAddress')?.value.trim()           || '0',
    value:           document.getElementById('seqValue')?.value.trim()             || '0',
    mask:            document.getElementById('seqMask')?.value.trim()              || '0xFFFFFFFF',
    expected:        document.getElementById('seqExpected')?.value.trim()          || '0',
    timeoutMs:       Number(document.getElementById('seqTimeout')?.value           || 1000),
    macAddress:      document.getElementById('seqMac')?.value.trim()               || '00:00:00:00:00:00',
    port:            Number(document.getElementById('seqPort')?.value              || 0),
    serialText:      document.getElementById('seqSerialText')?.value.trim()        || '',
    serialHex:       document.getElementById('seqSerialHex')?.value.trim()         || '',
    captureInterface:document.getElementById('seqCaptureIface')?.value.trim()      || '',
    captureFilter:   document.getElementById('seqCaptureFilter')?.value.trim()     || '',
    captureExpected: Number(document.getElementById('seqCaptureExpected')?.value   || 1)
  };
  try {
    await api('/api/sequence/event/add', { method: 'POST', body: JSON.stringify(body) });
    await labLoadSequence();
  } catch (err) {
    alert(`Add event failed: ${err.message}`);
  }
});

document.getElementById('seqClearEvents')?.addEventListener('click', async () => {
  if (!confirm('Clear all events from the sequence?')) return;
  await api('/api/sequence/events/clear', { method: 'POST', body: '{}' });
  await labLoadSequence();
});

document.getElementById('seqRefreshFull')?.addEventListener('click', labLoadSequence);

// =============================================================================
// Serial Macro Buttons
// =============================================================================

let _serialMacros = (() => {
  try { return JSON.parse(localStorage.getItem('serialMacros') || '[]'); } catch { return []; }
})();

function _saveMacros() { localStorage.setItem('serialMacros', JSON.stringify(_serialMacros)); }

function _renderMacros() {
  const container = document.getElementById('serialMacroBtns');
  if (!container) return;
  if (!_serialMacros.length) {
    container.innerHTML = '<span style="font-size:.75rem;color:var(--muted)">No macros — click ⚙ Edit to add</span>';
    return;
  }
  container.innerHTML = _serialMacros.map((m, i) =>
    `<span class="serialMacroPill">
      <button class="serialMacroBtn" data-mi="${i}" title="${escHtml(m.text + (m.eol || ''))}">${escHtml(m.label || `M${i+1}`)}</button>
      <button class="serialMacroDelBtn" data-md="${i}" title="Delete macro">✕</button>
    </span>`
  ).join('');
  container.querySelectorAll('[data-mi]').forEach(btn =>
    btn.addEventListener('click', () => _sendMacro(Number(btn.dataset.mi))));
  container.querySelectorAll('[data-md]').forEach(btn =>
    btn.addEventListener('click', () => {
      _serialMacros.splice(Number(btn.dataset.md), 1);
      _saveMacros(); _renderMacros();
    }));
}

async function _sendMacro(idx) {
  const m = _serialMacros[idx];
  if (!m) return;
  if (!state.serial.sessionId) { alert('Serial port not connected'); return; }
  const raw = m.text.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  const text = raw + (m.eol || '');
  const bytes = new TextEncoder().encode(text);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
  try {
    await api('/api/tty/write', { method: 'POST', body: JSON.stringify({ sessionId: state.serial.sessionId, hex }) });
    state.serial.txCount += bytes.length;
    const txEl = document.getElementById('serTx');
    if (txEl) txEl.textContent = state.serial.txCount;
    if (document.getElementById('serialEcho')?.checked)
      appendSerialLog(`> [${escHtml(m.label)}] ${escHtml(m.text)}\n`, 'tx');
  } catch (err) {
    appendSerialLog(`[macro error] ${escHtml(err.message)}\n`, 'err');
  }
}

document.getElementById('serialMacroManage')?.addEventListener('click', () => {
  const panel = document.getElementById('serialMacroPanel');
  if (panel) panel.classList.toggle('hidden');
});

document.getElementById('macroAddBtn')?.addEventListener('click', () => {
  const label = document.getElementById('macroLabel')?.value.trim() || 'Macro';
  const text  = document.getElementById('macroText')?.value ?? '';
  const eol   = document.getElementById('macroEolSel')?.value ?? '\r';
  if (!text && !eol) return;
  _serialMacros.push({ label, text, eol });
  _saveMacros(); _renderMacros();
  const lEl = document.getElementById('macroLabel');
  const tEl = document.getElementById('macroText');
  if (lEl) lEl.value = '';
  if (tEl) tEl.value = '';
});

_renderMacros();

// =============================================================================
// Sequence Event Presets
// =============================================================================

const _SEQ_PRESETS = {
  delay100:  { eventType: 'Delay',      delayMs: 100 },
  delay1s:   { eventType: 'Delay',      delayMs: 1000 },
  flushFdb:  { eventType: 'FdbFlush',   address: '0', value: '0', mask: '0xFFFFFFFF', macAddress: '00:00:00:00:00:00' },
  readBmsr:  { eventType: 'RegRead',    address: '0x0001', value: '0', mask: '0xFFFFFFFF' },
  waitLink:  { eventType: 'RegWaitFor', address: '0x0001', mask: '0x0004', expected: '0x0004', timeoutMs: 5000 },
};

let _seqCustomPresets = (() => {
  try { return JSON.parse(localStorage.getItem('seqPresets') || '[]'); } catch { return []; }
})();

function _saveSeqPresets() { localStorage.setItem('seqPresets', JSON.stringify(_seqCustomPresets)); }

function _renderSeqPresets() {
  const container = document.getElementById('seqCustomPresets');
  if (!container) return;
  container.innerHTML = _seqCustomPresets.map((p, i) =>
    `<span class="seqPresetPill">
      <button class="seqPreset seqPresetCustom" data-pi="${i}" title="Add ${escHtml(p.label)}">${escHtml(p.label)}</button>
      <button class="seqPresetDelBtn" data-pd="${i}" title="Delete preset">✕</button>
    </span>`
  ).join('');
  container.querySelectorAll('[data-pi]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const preset = _seqCustomPresets[Number(btn.dataset.pi)]?.event;
      if (preset) {
        try {
          await api('/api/sequence/event/add', { method: 'POST', body: JSON.stringify(preset) });
          await labLoadSequence();
        } catch (err) { alert(`Add preset failed: ${err.message}`); }
      }
    }));
  container.querySelectorAll('[data-pd]').forEach(btn =>
    btn.addEventListener('click', () => {
      _seqCustomPresets.splice(Number(btn.dataset.pd), 1);
      _saveSeqPresets(); _renderSeqPresets();
    }));
}

function _readSeqForm() {
  return {
    eventType:       document.getElementById('seqEventType')?.value     || 'Delay',
    delayMs:         Number(document.getElementById('seqDelayMs')?.value  || 100),
    address:         document.getElementById('seqAddress')?.value.trim()  || '0',
    value:           document.getElementById('seqValue')?.value.trim()    || '0',
    mask:            document.getElementById('seqMask')?.value.trim()     || '0xFFFFFFFF',
    expected:        document.getElementById('seqExpected')?.value.trim() || '0',
    timeoutMs:       Number(document.getElementById('seqTimeout')?.value  || 1000),
    macAddress:      document.getElementById('seqMac')?.value.trim()      || '00:00:00:00:00:00',
    port:            Number(document.getElementById('seqPort')?.value     || 0),
    serialText:      document.getElementById('seqSerialText')?.value.trim()    || '',
    serialHex:       document.getElementById('seqSerialHex')?.value.trim()     || '',
    captureInterface:document.getElementById('seqCaptureIface')?.value.trim()  || '',
    captureFilter:   document.getElementById('seqCaptureFilter')?.value.trim() || '',
    captureExpected: Number(document.getElementById('seqCaptureExpected')?.value || 1),
  };
}

function _applyPresetToForm(preset) {
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
  setVal('seqEventType', preset.eventType);
  if (preset.delayMs !== undefined)  setVal('seqDelayMs', preset.delayMs);
  if (preset.address)   setVal('seqAddress',  preset.address);
  if (preset.value)     setVal('seqValue',    preset.value);
  if (preset.mask)      setVal('seqMask',     preset.mask);
  if (preset.expected)  setVal('seqExpected', preset.expected);
  if (preset.timeoutMs) setVal('seqTimeout',  preset.timeoutMs);
  if (preset.macAddress)setVal('seqMac',      preset.macAddress);
  if (preset.port !== undefined) setVal('seqPort', preset.port);
  if (preset.serialText) setVal('seqSerialText', preset.serialText);
  if (preset.serialHex)  setVal('seqSerialHex',  preset.serialHex);
  seqUpdateFields();
}

document.querySelectorAll('.seqPreset[data-preset]').forEach(btn =>
  btn.addEventListener('click', () => _applyPresetToForm(_SEQ_PRESETS[btn.dataset.preset] || {})));

document.getElementById('seqSavePreset')?.addEventListener('click', () => {
  const label = prompt('Preset name? (will appear as a quick-add button)');
  if (!label?.trim()) return;
  _seqCustomPresets.push({ label: label.trim(), event: _readSeqForm() });
  _saveSeqPresets(); _renderSeqPresets();
});

_renderSeqPresets();

// =============================================================================
// MDIO / PHY
// =============================================================================

// Auto-fill PHY address when port selection changes
document.getElementById('mdioPort')?.addEventListener('change', () => {
  const PHY_ADDRS = ['0x00', '0x04', '0x05', '0x08', '0x0A', '0x0C'];
  const port = Number(document.getElementById('mdioPort')?.value || 0);
  const phyEl = document.getElementById('mdioPhyAddr');
  if (phyEl && port >= 0 && port <= 5) phyEl.value = PHY_ADDRS[port];
});

document.getElementById('mdioReadBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('mdioAccResult');
  if (!out) return;
  out.textContent = '읽는 중...'; out.style.color = 'var(--muted)';
  try {
    const port    = Number(document.getElementById('mdioPort')?.value    || 0);
    const phyAddr = document.getElementById('mdioPhyAddr')?.value.trim() || '0x00';
    const regAddr = document.getElementById('mdioRegAddr')?.value.trim() || '0x01';
    const d = await api('/api/mdio/read', { method: 'POST', body: JSON.stringify({ port, phyAddr, regAddr }) });
    out.textContent = `Port ${port}  PHY[${phyAddr}]  Reg[${regAddr}] = ${d.value}`;
    out.style.color = 'var(--accent)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

document.getElementById('mdioWriteBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('mdioAccResult');
  if (!out) return;
  out.textContent = '쓰는 중...'; out.style.color = 'var(--muted)';
  try {
    const port    = Number(document.getElementById('mdioPort')?.value      || 0);
    const phyAddr = document.getElementById('mdioPhyAddr')?.value.trim()   || '0x00';
    const regAddr = document.getElementById('mdioRegAddr')?.value.trim()   || '0x01';
    const value   = document.getElementById('mdioWriteValue')?.value.trim()|| '0x0000';
    await api('/api/mdio/write', { method: 'POST', body: JSON.stringify({ port, phyAddr, regAddr, value }) });
    out.textContent = `Port ${port}  PHY[${phyAddr}]  Reg[${regAddr}] ← ${value}  완료`;
    out.style.color = 'var(--ok)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

document.getElementById('mdioLinkStatusBtn')?.addEventListener('click', async () => {
  const grid = document.getElementById('mdioLinkGrid');
  if (!grid) return;
  grid.innerHTML = '<span class="muted" style="font-size:.8rem;">읽는 중...</span>';
  try {
    const d = await api('/api/mdio/link-status');
    grid.innerHTML = (d.ports || []).map(p => {
      const cls   = p.linkUp === true ? 'up' : p.linkUp === false ? 'down' : '';
      const label = p.linkUp === true ? 'UP' : p.linkUp === false ? 'DOWN' : '—';
      return `<span class="mdioLinkBadge ${cls}"><span class="mdioLinkDot"></span>P${p.port} ${label}</span>`;
    }).join('');
  } catch (e) { grid.innerHTML = `<span style="color:#b91c1c;font-size:.8rem;">오류: ${e.message}</span>`; }
});

document.getElementById('mdioSetupApplyBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('mdioSetupResult');
  if (!out) return;
  out.textContent = '적용 중...'; out.style.color = 'var(--muted)';
  try {
    const port            = Number(document.getElementById('mdioPort')?.value || 0);
    const enable          = document.getElementById('mdioSetupEnable')?.checked    ?? true;
    const preDisable      = document.getElementById('mdioSetupPreDisable')?.checked ?? false;
    const interruptEnable = document.getElementById('mdioSetupIntrEnable')?.checked ?? false;
    const targetMhz       = Number(document.getElementById('mdioTargetMhz')?.value  || 2.5);
    const d = await api('/api/mdio/setup', { method: 'POST', body: JSON.stringify({ port, enable, preDisable, interruptEnable, targetMhz }) });
    out.textContent = `완료  SETUP=${d.setup}  TIME=${d.time}  CLK=${d.clk}  MILLISEC=${d.ms}`;
    out.style.color = 'var(--ok)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

// =============================================================================
// Timestamp
// =============================================================================

document.getElementById('timestampReadBtn')?.addEventListener('click', async () => {
  const disp = document.getElementById('timestampDisplay');
  if (!disp) return;
  disp.textContent = '읽는 중...';
  try {
    const d = await api('/api/timestamp/read');
    disp.textContent = d.isoString ? `${d.isoString}  (ns: ${d.ns})` : `sec=0x${(d.sec || 0).toString(16).toUpperCase()}  ns=${d.ns}`;
    disp.style.color = 'var(--accent)';
  } catch (e) { disp.textContent = `오류: ${e.message}`; disp.style.color = '#b91c1c'; }
});

document.getElementById('timestampStatusBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('tsStatusResult');
  if (!out) return;
  out.textContent = '읽는 중...';
  try {
    const d = await api('/api/timestamp/status');
    out.textContent = `CTRL_0(ADDEND)=${d.ctrl0}  CTRL_1=${d.ctrl1}  INCREMENT=${d.increment}  PPS_SRC=${d.ppsSrc}  PPS_WIDTH=${d.ppsWidthMs}ms`;
    out.style.color = 'var(--accent)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

document.getElementById('tsSetNowBtn')?.addEventListener('click', () => {
  const now = new Date();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('tsYear',  now.getFullYear());
  set('tsMonth', now.getMonth() + 1);
  set('tsDay',   now.getDate());
  set('tsHour',  now.getHours());
  set('tsMin',   now.getMinutes());
  set('tsSec',   now.getSeconds());
});

document.getElementById('tsSetBtn')?.addEventListener('click', async () => {
  const out = document.getElementById('tsSetResult');
  if (!out) return;
  out.textContent = '설정 중...'; out.style.color = 'var(--muted)';
  try {
    const get = (id) => Number(document.getElementById(id)?.value || 0);
    const body = { year: get('tsYear'), month: get('tsMonth'), day: get('tsDay'), hour: get('tsHour'), min: get('tsMin'), sec: get('tsSec') };
    const d = await api('/api/timestamp/set', { method: 'POST', body: JSON.stringify(body) });
    out.textContent = `시간 설정 완료: ${d.isoString || ''}`;
    out.style.color = 'var(--ok)';
  } catch (e) { out.textContent = `오류: ${e.message}`; out.style.color = '#b91c1c'; }
});

// Auto-fill "Set Time" fields and auto-read Timestamp when entering Control sub-tab
document.querySelector('[data-htview="controlView"]')?.addEventListener('click', () => {
  const now = new Date();
  const trySet = (id, v) => { const el = document.getElementById(id); if (el && !el.dataset.userEdited) el.value = v; };
  trySet('tsYear',  now.getFullYear());
  trySet('tsMonth', now.getMonth() + 1);
  trySet('tsDay',   now.getDate());
  trySet('tsHour',  now.getHours());
  trySet('tsMin',   now.getMinutes());
  trySet('tsSec',   now.getSeconds());

  // Auto-read timestamp from hardware on tab entry
  const disp = document.getElementById('timestampDisplay');
  if (disp) {
    disp.textContent = '읽는 중...';
    api('/api/timestamp/read').then((d) => {
      disp.textContent = d.isoString ? `${d.isoString}  (ns: ${d.ns})` : `sec=0x${(d.sec || 0).toString(16).toUpperCase()}  ns=${d.ns}`;
      disp.style.color = 'var(--accent)';
    }).catch((e) => {
      disp.textContent = `(읽기 실패: ${e.message})`;
      disp.style.color = 'var(--muted)';
    });
  }
}, { capture: true });

// =============================================================================
// Counter
// =============================================================================

document.getElementById('counterReadBtn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('counterStatus');
  const tableEl  = document.getElementById('counterTable');
  const tbody    = document.getElementById('counterRows');
  const emptyEl  = document.getElementById('counterEmpty');
  if (!tbody) return;

  if (statusEl) statusEl.textContent = '읽는 중...';
  if (emptyEl)  { emptyEl.style.display = 'block'; emptyEl.textContent = '읽는 중...'; }
  if (tableEl)  tableEl.style.display = 'none';

  try {
    const port = document.getElementById('counterPort')?.value || 'all';
    const d = await api(`/api/counter/read?port=${encodeURIComponent(port)}`);
    const counters = d.counters || [];

    if (statusEl) statusEl.textContent = `${counters.length}개 항목`;

    if (!counters.length) {
      if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = '데이터 없음 — 시리얼 포트가 연결되어 있는지 확인하세요.'; }
      return;
    }

    tbody.innerHTML = counters.map(c =>
      `<tr>
        <td>${escHtml(c.group || '')}</td>
        <td>${escHtml(c.name  || '')}</td>
        <td><code>${escHtml(c.address || '')}</code></td>
        <td><code>${escHtml(c.value   || '')}</code></td>
        <td style="text-align:right;">${c.valueDec ?? ''}</td>
      </tr>`
    ).join('');

    if (emptyEl)  emptyEl.style.display = 'none';
    if (tableEl)  tableEl.style.display = '';
  } catch (e) {
    if (statusEl) statusEl.textContent = `오류: ${e.message}`;
    if (emptyEl)  { emptyEl.style.display = 'block'; emptyEl.textContent = `오류: ${e.message}`; }
    if (tableEl)  tableEl.style.display = 'none';
  }
});

// =============================================================================
// Capture Address — remote peer capture with PASS/FAIL evaluation
// Fetch peer's captured packets via the Node.js proxy /api/remote-capture/*
// =============================================================================

const caState = {
  peerUrl: DEFAULT_PEER_URL,
  packets: [],          // all captured packets accumulated
  ifaces: [],           // interface objects from peer probe
  selectedIfaces: [],   // interface keys currently checked
  isCapturing: false,
  pollTimer: null,
  lastOffset: 0,        // number of packets fetched so far (for incremental poll)
  selectedIdx: -1,
  targetAddr: '',       // raw text from caAddrInput (for PASS/FAIL)
  displayFilter: '',    // current display filter string
};

// ─── Probe peer — GET peer's interfaces via server proxy ─────────────────────
async function caProbe() {
  const peerUrlEl = $('caPeerUrl');
  const statusEl  = $('caPeerStatus');
  const listEl    = $('caIfaceList');
  const startBtn  = $('caStartBtn');
  if (!peerUrlEl) return;

  const peerUrl = peerUrlEl.value.trim() || 'http://localhost:8080';
  caState.peerUrl = peerUrl;

  if (statusEl) { statusEl.textContent = 'Probing…'; statusEl.className = 'caPeerStatus'; }
  if (listEl)   listEl.textContent = 'loading…';
  if (startBtn) startBtn.disabled = true;

  try {
    const data = await api('/api/remote-capture/probe', {
      method: 'POST',
      body: JSON.stringify({ peerUrl })
    });
    caState.ifaces = data.interfaces || [];
    if (!caState.ifaces.length) {
      if (listEl) listEl.textContent = '— no NICs found on peer —';
      if (statusEl) { statusEl.textContent = 'No NICs'; statusEl.className = 'caPeerStatus warn'; }
      return;
    }
    // Auto-select first interface
    if (!caState.selectedIfaces.length) {
      caState.selectedIfaces = [caState.ifaces[0].key || caState.ifaces[0].name];
    }
    caRenderIfaceList();
    if (statusEl) { statusEl.textContent = `OK — ${caState.ifaces.length} NIC(s)`; statusEl.className = 'caPeerStatus ok'; }
    if (startBtn) startBtn.disabled = false;
  } catch (err) {
    if (listEl)   listEl.textContent = `Probe failed: ${err.message}`;
    if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'caPeerStatus fail'; }
  }
}

// ─── Render peer interface checkboxes ─────────────────────────────────────────
function caRenderIfaceList() {
  const listEl   = $('caIfaceList');
  const startBtn = $('caStartBtn');
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const iface of caState.ifaces) {
    const key   = iface.key || iface.name;
    const label = iface.name || key;
    const mac   = iface.mac ? ` (${iface.mac})` : '';
    const chip  = document.createElement('label');
    chip.className = 'caIfaceChip' + (caState.selectedIfaces.includes(key) ? ' selected' : '');
    chip.title = iface.description || label;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = key;
    cb.checked = caState.selectedIfaces.includes(key);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!caState.selectedIfaces.includes(key)) caState.selectedIfaces.push(key);
      } else {
        caState.selectedIfaces = caState.selectedIfaces.filter((k) => k !== key);
      }
      chip.classList.toggle('selected', cb.checked);
      if (startBtn) startBtn.disabled = caState.selectedIfaces.length === 0;
    });
    chip.appendChild(cb);
    chip.append(` ${label}${mac}`);
    listEl.appendChild(chip);
  }
  if (startBtn) startBtn.disabled = caState.selectedIfaces.length === 0;
}

// ─── Capture timeline chart (pps per second) ─────────────────────────────────
function renderCaptureTimeline(packets) {
  const panel = $('caTimelinePanel');
  if (!packets.length) { if (panel) panel.classList.add('hidden'); return; }
  if (panel) panel.classList.remove('hidden');
  const chart = getChart('caTimelineChart');
  if (!chart) return;
  const minTs = Math.floor(packets[0].timestamp || 0);
  const buckets = {};
  for (const p of packets) {
    const s = Math.max(0, Math.floor(p.timestamp || 0) - minTs);
    buckets[s] = (buckets[s] || 0) + 1;
  }
  const maxS = Math.max(...Object.keys(buckets).map(Number));
  const xData = Array.from({ length: maxS + 1 }, (_, i) => `+${i}s`);
  const yData = Array.from({ length: maxS + 1 }, (_, i) => buckets[i] || 0);
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', formatter: (p) => `${p[0].name}: ${p[0].value} pkt/s` },
    grid: { left: 38, right: 12, bottom: 22, top: 14 },
    xAxis: { type: 'category', data: xData, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    series: [{ type: 'line', data: yData, smooth: true, areaStyle: { opacity: 0.15 },
      symbol: 'none', lineStyle: { width: 2, color: '#0b5cab' },
      itemStyle: { color: '#0b5cab' } }]
  }, true);
}

// ─── Capture polling — GET packets from peer via proxy ────────────────────────
async function caPoll() {
  if (!caState.isCapturing) return;
  try {
    const params = new URLSearchParams({
      peerUrl: caState.peerUrl,
      limit:   500,
      offset:  caState.lastOffset
    });
    const data = await api(`/api/remote-capture/packets?${params}`);
    const newRows = data.rows || [];
    if (newRows.length > 0) {
      for (const pkt of newRows) {
        pkt._idx   = caState.packets.length;
        pkt._iface = pkt.interface || pkt.iface || '';
        caState.packets.push(pkt);
        // Apply display filter before rendering
        if (caPacketPassesFilter(pkt, caState.displayFilter)) {
          caRenderRow(pkt);
        }
      }
      caState.lastOffset += newRows.length;
      caUpdateCount();
      renderCaptureProtoChart(caState.packets);
      renderCaptureTimeline(caState.packets);
      const exportBtn = $('caExportBtn');
      if (exportBtn) exportBtn.disabled = false;
    }
  } catch {
    // silently swallow polling errors
  }
}

// ─── Display filter helper ────────────────────────────────────────────────────
function caPacketPassesFilter(pkt, filter) {
  if (!filter) return true;
  // Reuse the global frameMatchesFilter if available, otherwise do simple substring
  if (typeof frameMatchesFilter === 'function') {
    return frameMatchesFilter(pkt, filter);
  }
  const hay = JSON.stringify(pkt).toLowerCase();
  return hay.includes(filter.toLowerCase());
}

// ─── Row renderer ─────────────────────────────────────────────────────────────
function caRenderRow(packet) {
  const tbody = $('caRows');
  if (!tbody) return;
  const empty = $('caPacketEmpty');
  if (empty) empty.classList.add('hidden');

  const decoded = packet.decoded || {};
  const eth     = decoded.ethernet || decoded.eth || {};
  const srcMac  = eth.srcMac || eth.src || '-';
  const dstMac  = eth.dstMac || eth.dst || '-';
  const srcIp   = decoded.ipv4?.src || decoded.arp?.senderIp || decoded.ipv6?.src || '-';
  const dstIp   = decoded.ipv4?.dst || decoded.arp?.targetIp || decoded.ipv6?.dst || '-';
  const t = packet.timestamp;
  const d = new Date(t * 1000);
  const ms  = String(d.getMilliseconds()).padStart(3, '0');
  const tStr = `${d.toLocaleTimeString('en-GB')}.${ms}`;
  const proto = protocolName(decoded);
  const info  = packetInfo(decoded);
  const idx   = packet._idx;
  const iface = packet._iface || '';

  const tr = document.createElement('tr');
  tr.dataset.idx = String(idx);
  tr.className   = rowProtoClass(decoded);

  // Highlight rows matching target address
  if (caState.targetAddr && caPacketMatchesTarget(packet, caState.targetAddr)) {
    tr.classList.add('ca-match');
  }

  tr.innerHTML = `<td class="colNum">${idx + 1}</td><td class="colTime">${tStr}</td><td class="colIface">${iface}</td><td class="colSrcMac">${srcMac}</td><td class="colDstMac">${dstMac}</td><td class="colSrc">${srcIp}</td><td class="colDst">${dstIp}</td><td class="colProto">${proto}</td><td class="colLen">${packet.length || 0}</td><td>${info}</td>`;
  tbody.appendChild(tr);
}

// ─── Packet count display ─────────────────────────────────────────────────────
function caUpdateCount() {
  const el = $('caPacketCount');
  if (el) el.textContent = `${caState.packets.length} packet${caState.packets.length !== 1 ? 's' : ''}`;
}

// ─── Target address matcher ───────────────────────────────────────────────────
function caPacketMatchesTarget(packet, addr) {
  if (!addr) return false;
  const a = addr.toLowerCase().trim();
  const d = packet.decoded || {};
  const eth = d.ethernet || d.eth || {};
  const srcMac = (eth.srcMac || eth.src || '').toLowerCase();
  const dstMac = (eth.dstMac || eth.dst || '').toLowerCase();
  // IP match
  if (/^\d{1,3}\.\d{1,3}/.test(a)) {
    const srcIp = (d.ipv4?.src || d.arp?.senderIp || d.ipv6?.src || '').toLowerCase();
    const dstIp = (d.ipv4?.dst || d.arp?.targetIp || d.ipv6?.dst || '').toLowerCase();
    return srcIp.includes(a) || dstIp.includes(a);
  }
  // MAC match
  return srcMac.includes(a) || dstMac.includes(a);
}

// ─── PASS/FAIL check ─────────────────────────────────────────────────────────
function caCheck() {
  const addrInput = $('caAddrInput');
  const resultEl  = $('caResult');
  if (!addrInput || !resultEl) return;

  const addr = (addrInput.value || '').trim();
  caState.targetAddr = addr;

  // Re-highlight all rows
  document.querySelectorAll('#caRows tr').forEach((tr) => {
    const idx = Number(tr.dataset.idx);
    const pkt = caState.packets[idx];
    if (pkt) tr.classList.toggle('ca-match', addr ? caPacketMatchesTarget(pkt, addr) : false);
  });

  if (!addr) {
    resultEl.textContent = '';
    resultEl.className   = 'caResult';
    return;
  }

  const total   = caState.packets.length;
  const matches = caState.packets.filter((p) => caPacketMatchesTarget(p, addr));
  const verdict = matches.length > 0 ? 'PASS' : 'FAIL';
  resultEl.className   = `caResult ${verdict.toLowerCase()}`;
  resultEl.textContent = `${verdict}  —  Target: ${addr}  |  Matched: ${matches.length}/${total} packet(s)`;
}

// ─── Start capture on peer ────────────────────────────────────────────────────
async function caStartCapture() {
  if (caState.isCapturing) return;
  if (!caState.selectedIfaces.length) { toast('No interface selected', 'warn'); return; }

  // Reset local state
  caState.packets    = [];
  caState.lastOffset = 0;
  caState.selectedIdx = -1;
  caState.targetAddr  = '';
  const tbody = $('caRows'); if (tbody) tbody.innerHTML = '';
  const empty = $('caPacketEmpty');
  if (empty) { empty.classList.remove('hidden'); empty.textContent = 'Capturing from peer…'; }
  const det = $('caDetailPane'); if (det) det.classList.add('hidden');
  const res = $('caResult'); if (res) { res.textContent = ''; res.className = 'caResult'; }
  caUpdateCount();

  const startBtn = $('caStartBtn');
  const stopBtn  = $('caStopBtn');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '…'; }

  let startData;
  try {
    const bpf = $('caBpfFilter')?.value?.trim();
    startData = await api('/api/remote-capture/start', {
      method: 'POST',
      body: JSON.stringify({ peerUrl: caState.peerUrl, interfaces: caState.selectedIfaces, ...(bpf ? { bpfFilter: bpf } : {}) })
    });
  } catch (err) {
    toast(`Capture start failed: ${err.message}`, 'fail');
    if (empty) { empty.classList.remove('hidden'); empty.textContent = `Capture failed: ${err.message}`; }
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▶ Start Capture'; }
    return;
  }

  if (startData && startData.warning) toast(`Warning: ${startData.warning}`, 'warn');

  caState.isCapturing = true;
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '● Capturing'; }
  if (stopBtn)  stopBtn.disabled = false;

  caState.pollTimer = setInterval(caPoll, 500);
}

// ─── Stop capture on peer ─────────────────────────────────────────────────────
async function caStopCapture() {
  if (!caState.isCapturing) return;
  caState.isCapturing = false;
  clearInterval(caState.pollTimer);
  caState.pollTimer = null;

  try {
    await api('/api/remote-capture/stop', {
      method: 'POST',
      body: JSON.stringify({ peerUrl: caState.peerUrl })
    });
  } catch { /* ignore */ }

  // One final poll
  await caPoll();

  const startBtn = $('caStartBtn');
  const stopBtn  = $('caStopBtn');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▶ Start Capture'; }
  if (stopBtn)  stopBtn.disabled = true;

  const empty = $('caPacketEmpty');
  if (empty && caState.packets.length === 0) {
    empty.classList.remove('hidden');
    empty.textContent = 'No packets captured from peer.';
  }
  caUpdateCount();
}

// ─── Clear ────────────────────────────────────────────────────────────────────
async function caClear() {
  await caStopCapture();
  caState.packets    = [];
  caState.lastOffset = 0;
  caState.selectedIdx = -1;
  caState.targetAddr  = '';
  const tbody = $('caRows'); if (tbody) tbody.innerHTML = '';
  const res   = $('caResult'); if (res) { res.textContent = ''; res.className = 'caResult'; }
  const det   = $('caDetailPane'); if (det) det.classList.add('hidden');
  const empty = $('caPacketEmpty');
  if (empty) { empty.classList.remove('hidden'); empty.textContent = 'Probe the peer, select an interface, then press Start Capture.'; }
  const addrIn = $('caAddrInput'); if (addrIn) addrIn.value = '';
  const exportBtn = $('caExportBtn'); if (exportBtn) exportBtn.disabled = true;
  const tpanel = $('caTimelinePanel'); if (tpanel) tpanel.classList.add('hidden');
  // Reset display filter + chips
  caState.displayFilter = '';
  const filterEl = $('caDisplayFilter');
  if (filterEl) filterEl.value = '';
  document.querySelectorAll('.filterChip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === '');
  });
  caUpdateCount();

  try {
    await api('/api/remote-capture/clear', {
      method: 'POST',
      body: JSON.stringify({ peerUrl: caState.peerUrl })
    });
  } catch { /* ignore */ }
}

// ─── Format raw hex string into 16-byte-per-line hex dump ────────────────────
function formatHex(raw) {
  if (!raw) return '';
  const clean = raw.replace(/\s/g, '');
  const lines = [];
  for (let offset = 0; offset < clean.length; offset += 32) {
    const chunk = clean.slice(offset, offset + 32);
    const bytes = chunk.match(/.{1,2}/g) || [];
    const hex   = bytes.join(' ').padEnd(47, ' ');
    const ascii = bytes.map((b) => {
      const c = parseInt(b, 16);
      return c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.';
    }).join('');
    lines.push(`${(offset / 2).toString(16).padStart(4, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

// ─── Show packet detail (decoded JSON + hex dump) ─────────────────────────────
function caShowDetail(pkt) {
  const pre = $('caDetailText');
  if (!pre) return;
  const parts = [];
  if (pkt.decoded) parts.push(JSON.stringify(pkt.decoded, null, 2));
  if (pkt.frameHex) parts.push('\n--- HEX ---\n' + formatHex(pkt.frameHex));
  pre.textContent = parts.length ? parts.join('\n') : JSON.stringify(pkt, null, 2);
}

// ─── Load connected workers into the dropdown ─────────────────────────────────
async function caLoadWorkers() {
  const sel = $('caWorkerSelect');
  if (!sel) return;
  try {
    const data = await api('/api/workers');
    const workers = data.workers || [];
    // Keep the placeholder option, rebuild the rest
    while (sel.options.length > 1) sel.remove(1);
    // Add "localhost (local)" as convenience
    const localOpt = document.createElement('option');
    localOpt.value = 'http://localhost:8080';
    localOpt.textContent = 'localhost:8080 (local)';
    sel.appendChild(localOpt);
    for (const w of workers) {
      const url = w.info?.url || w.info?.peerUrl || '';
      const label = w.info?.label || w.id || w.info?.hostname || url || w.id;
      const opt = document.createElement('option');
      opt.value = url || `worker:${w.id}`;
      opt.textContent = url ? `${label} — ${url}` : label;
      opt.title = JSON.stringify(w.info || {});
      sel.appendChild(opt);
    }
  } catch { /* ignore */ }
}

// ─── Wire up event listeners ──────────────────────────────────────────────────
(function initCaptureAddress() {
  const probeBtn   = $('caProbeBtn');
  const startBtn   = $('caStartBtn');
  const stopBtn    = $('caStopBtn');
  const clearBtn   = $('caClearBtn');
  const checkBtn   = $('caCheckBtn');
  const addrInput  = $('caAddrInput');
  const filterInput = $('caDisplayFilter');
  const tbody      = $('caRows');

  if (!startBtn) return; // view not in DOM

  probeBtn?.addEventListener('click', caProbe);
  startBtn.addEventListener('click', caStartCapture);
  stopBtn.addEventListener('click', caStopCapture);
  clearBtn.addEventListener('click', caClear);
  checkBtn?.addEventListener('click', caCheck);
  $('caExportBtn')?.addEventListener('click', () => {
    if (!caState.packets.length) { toast('No packets to export', 'warn'); return; }
    const norm = caState.packets.map((p) => ({
      frameHex: p.frameHex || p.hex || '',
      rxTimestampNs: p.rxTimestampNs || (p.timestamp ? Math.round(p.timestamp * 1e9) : 0)
    })).filter((p) => p.frameHex.length > 0);
    if (!norm.length) { toast('No packet hex data available', 'warn'); return; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(buildPcap(norm), `keti-capture-${ts}.pcap`);
  });

  // Worker dropdown → autofill URL + re-probe
  const workerSel = $('caWorkerSelect');
  workerSel?.addEventListener('change', () => {
    const val = workerSel.value;
    if (!val) return;
    const urlEl = $('caPeerUrl');
    if (urlEl && val.startsWith('http')) {
      urlEl.value = val;
      caState.peerUrl = val;
    }
    workerSel.value = ''; // reset dropdown
    caProbe();
  });

  // Enter in address input → check
  addrInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') caCheck();
  });

  // Display filter
  filterInput?.addEventListener('input', () => {
    caState.displayFilter = filterInput.value.trim();
    const allRows = document.querySelectorAll('#caRows tr');
    allRows.forEach((tr) => {
      const idx = Number(tr.dataset.idx);
      const pkt = caState.packets[idx];
      if (!pkt) return;
      tr.style.display = caPacketPassesFilter(pkt, caState.displayFilter) ? '' : 'none';
    });
    document.querySelectorAll('.filterChip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === caState.displayFilter);
    });
  });

  // Quick filter chips
  document.querySelectorAll('.filterChip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      if (filterInput) { filterInput.value = f; filterInput.dispatchEvent(new Event('input')); }
    });
  });

  // Set initial active chip (displayFilter starts as '')
  document.querySelectorAll('.filterChip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === caState.displayFilter);
  });

  // Row click → show detail
  tbody?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.idx) return;
    const idx = Number(tr.dataset.idx);
    const pkt = caState.packets[idx];
    if (!pkt) return;
    caState.selectedIdx = idx;
    document.querySelectorAll('#caRows tr').forEach((r) => r.classList.toggle('selected', r === tr));
    const det = $('caDetailPane');
    if (det) det.classList.remove('hidden');
    caShowDetail(pkt);
  });

  // Tab activation → load workers + auto-probe if no interfaces yet
  document.querySelector('[data-view="captureAddressView"]')?.addEventListener('click', () => {
    caLoadWorkers();
    if (!caState.ifaces.length) caProbe();
  });
})();

// =============================================================================
// WebSocket — receive worker events (tab change, capture, serial rx, …)
// =============================================================================
(function initWorkerEventSocket() {
  let _ws = null;
  let _wsRetry = null;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    _ws = new WebSocket(`${proto}//${location.host}`);
    _ws.onopen = () => { clearTimeout(_wsRetry); };
    _ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'workerEvent') handleWorkerEvent(msg.payload || {});
    };
    _ws.onclose = _ws.onerror = () => {
      _ws = null;
      _wsRetry = setTimeout(connect, 3000);
    };
  }
  function handleWorkerEvent(payload) {
    if (payload.kind === 'tabchange' && payload.view) {
      showView(payload.view);
    }
  }
  connect();
})();
