'use strict';
/* phone/phone.js — the player phone UI (browser preview + Electron overlay).
 * Talks ONLY to the Server Owner Host over WebSocket. Contains no ER:LC
 * credentials by design — there is nothing here worth stealing. */
const P = window.ERLC;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').trim().slice(0, 2).toUpperCase();
const teamColor = (t = '') => ({ Police: '#2456c8', Sheriff: '#7a5a12', Fire: '#c8362b', EMS: '#14965c', Civilian: '#69707d' }[Object.keys({ Police: 1, Sheriff: 1, Fire: 1, EMS: 1, Civilian: 1 }).find((k) => String(t).includes(k))] || '#69707d');
const fmtTime = (ts) => ts ? new Date(ts * (ts < 1e12 ? 1000 : 1)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

const store = {
  get(k, d) { try { const v = localStorage.getItem('erlc-phone:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('erlc-phone:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  ws: null, connected: false, me: null, role: 'player', duty: store.get('duty', 'Police'),
  server: null, source: 'mock', players: [], vehicles: [], calls: [], admin: null,
  messages: [], currentThread: null, unread: 0, currentApp: null,
  pendingPin: null, droppedPin: store.get('pin', null), balance: store.get('balance', 2500),
  acknowledged: new Set(), selectedCall: null, callPeer: null, adminTab: 'modcalls',
  mapTap: null, lastBannerCall: null,
};

/* ---------------- theme ---------------- */
function setTheme(theme) {
  if (!P.THEMES.includes(theme)) theme = 'ios';
  document.body.dataset.theme = theme; store.set('theme', theme);
  $$('[data-theme-choice]').forEach((b) => b.classList.toggle('on', b.dataset.themeChoice === theme));
  drawMap();
}
$$('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeChoice)));
setTheme(store.get('theme', 'ios'));
if (window.overlayAPI) { document.body.classList.add('electron'); $('.stage').classList.add('electron'); }

/* ---------------- clock ---------------- */
function tickClock() {
  const d = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/i, '');
  $('#sbTime').textContent = t; $('#homeTime').textContent = t;
  $('#homeDate').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
tickClock(); setInterval(tickClock, 15000);

/* ---------------- screens & apps ---------------- */
const APPS = [
  { id: 'dispatch', name: '911 Dispatch', icon: '🚨', bg: 'linear-gradient(150deg,#ff5f57,#c81e1e)' },
  { id: 'map', name: 'GPS Map', icon: '🗺️', bg: 'linear-gradient(150deg,#5ad06a,#1d9e4b)' },
  { id: 'contacts', name: 'Contacts', icon: '👥', bg: 'linear-gradient(150deg,#57a8ff,#2456c8)' },
  { id: 'messages', name: 'Messages', icon: '💬', bg: 'linear-gradient(150deg,#65d95f,#23a832)', badge: () => state.unread || '' },
  { id: 'admin', name: 'Admin', icon: '🛡️', bg: 'linear-gradient(150deg,#4b4f57,#14161a)', badge: () => state.role === 'owner' ? '' : '🔒' },
  { id: 'settings', name: 'Settings', icon: '⚙️', bg: 'linear-gradient(150deg,#b9bec7,#6d727c)' },
];
function buildHome() {
  $('#appGrid').innerHTML = APPS.map((a) => `
    <button class="app-btn" data-app="${a.id}" type="button">
      <span class="app-ico" style="background:${a.bg}">${a.icon}${a.badge && a.badge() ? `<span class="app-badge">${a.badge()}</span>` : ''}</span><span>${a.name}</span>
    </button>`).join('');
  $('#dock').innerHTML = ['messages', 'map', 'contacts', 'settings'].map((id) => {
    const a = APPS.find((x) => x.id === id);
    return `<button class="app-btn" data-app="${id}" type="button"><span class="app-ico" style="background:${a.bg}">${a.icon}</span><span>${a.name}</span></button>`;
  }).join('');
  $$('[data-app]').forEach((b) => b.addEventListener('click', () => openApp(b.dataset.app)));
}
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}
function openApp(id) {
  state.currentApp = id;
  $('#appTitle').textContent = APPS.find((a) => a.id === id)?.name || 'App';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + id));
  showScreen('screen-app');
  if (id === 'messages') { state.unread = 0; buildHome(); renderThreads(); }
  if (id === 'map') drawMap();
  if (id === 'admin') renderAdmin();
  if (id === 'dispatch') renderDispatch();
  if (id === 'contacts') renderContacts();
}
$('#btnBack').addEventListener('click', () => { state.currentApp = null; showScreen('screen-home'); buildHome(); });
buildHome();

/* ---------------- toast & banner ---------------- */
let toastTimer;
function toast(text, ms = 2600) {
  const el = $('#toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function showBanner(call) {
  state.lastBannerCall = call;
  $('#bannerTitle').textContent = `🚨 New 911 — ${call.team} · #${call.callNumber ?? ''}`;
  $('#bannerText').textContent = `${call.description} (${call.descriptor || 'location on map'})`;
  const b = $('#banner'); b.hidden = false;
  setTimeout(() => { b.hidden = true; }, 9000);
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}
$('#bannerBtn').addEventListener('click', () => { $('#banner').hidden = true; state.selectedCall = state.lastBannerCall; openApp('dispatch'); });

/* ---------------- connection ---------------- */
function defaultHost() {
  if (location.protocol.startsWith('http')) return location.host;
  return 'localhost:3847';
}
$('#inHost').value = store.get('host', defaultHost());
$('#inName').value = store.get('name', '');
$('#inDuty').value = state.duty;

fetch('/api/demo/codes').then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !d.demo) return;
  $('#demoBox').hidden = false;
  $('#demoPlayerCode').textContent = d.pairingCode; $('#demoOwnerCode').textContent = d.ownerCode;
  $('#demoPlayerCode').onclick = () => { $('#inCode').value = d.pairingCode; toast('Player code filled — now Connect.'); };
  $('#demoOwnerCode').onclick = () => { $('#inCode').value = d.ownerCode; toast('Owner code filled — the Admin app will unlock.'); };
}).catch(() => { /* not in demo mode */ });

function wsUrl(hostValue) {
  let h = String(hostValue || defaultHost()).trim().replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${h}/ws`;
}
function connect() {
  const name = $('#inName').value.trim();
  const code = $('#inCode').value.trim();
  const err = $('#connectError'); err.classList.remove('show');
  if (!name) { err.textContent = 'Enter your Roblox username so other players (and the Host) know who this phone belongs to.'; err.classList.add('show'); return; }
  if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit pairing code from the server owner’s Host Manager.'; err.classList.add('show'); return; }
  state.duty = $('#inDuty').value; store.set('duty', state.duty); store.set('name', name); store.set('host', $('#inHost').value.trim());
  const btn = $('#btnConnect'); btn.disabled = true; btn.textContent = 'Connecting…';
  try { state.ws?.close(); } catch { /* noop */ }
  const ws = new WebSocket(wsUrl($('#inHost').value));
  state.ws = ws;
  const fail = (m) => { btn.disabled = false; btn.textContent = 'Connect phone'; err.textContent = m; err.classList.add('show'); };
  ws.onopen = () => ws.send(P.envelope(P.MSG.JOIN, { code, name, duty: state.duty }));
  ws.onerror = () => fail('Could not reach the Host. Check the host address — the owner’s Host app must be running (same network, or their forwarded address).');
  ws.onclose = () => {
    if (state.connected) { toast('Disconnected from the Host.'); showScreen('screen-connect'); }
    state.connected = false; btn.disabled = false; btn.textContent = 'Connect phone';
  };
  ws.onmessage = (ev) => {
    const msg = P.parseEnvelope(ev.data); if (!msg) return;
    if (msg.type === P.MSG.ERROR && !state.connected) { fail(msg.payload.message || 'The Host rejected that code.'); return; }
    handleMessage(msg);
  };
}
$('#btnConnect').addEventListener('click', connect);
$('#inCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

function handleMessage(msg) {
  const p = msg.payload || {};
  switch (msg.type) {
    case P.MSG.WELCOME: {
      state.connected = true; state.me = p.you; state.role = p.role; state.server = p.server; state.source = p.source || 'live';
      $('#btnConnect').disabled = false; $('#btnConnect').textContent = 'Connect phone';
      $('#dutySelect').value = state.duty;
      $('#homeServer').textContent = `🟢 ${state.server?.name || 'ER:LC server'} · you: ${state.me}${state.role === 'owner' ? ' · 👑 Owner' : ''}`;
      $('#setName').textContent = state.me; $('#setRole').textContent = state.role === 'owner' ? 'Server Owner (Admin app unlocked)' : 'Player';
      $('#setSource').textContent = state.source === 'mock' ? 'Mock Mode (demo data)' : 'Live ER:LC API via Host';
      $('#setBalance').textContent = '$' + state.balance.toLocaleString();
      showScreen('screen-home'); buildHome();
      toast(state.role === 'owner' ? 'Welcome, Owner — Admin app unlocked 🛡️' : `Connected to ${state.server?.name || 'the server'} 📱`);
      break;
    }
    case P.MSG.SERVER_INFO: state.server = p.server; if (state.connected) $('#homeServer').textContent = `🟢 ${p.server?.name || ''} · ${p.server?.currentPlayers ?? ''}/${p.server?.maxPlayers ?? ''} players · you: ${state.me}${state.role === 'owner' ? ' · 👑 Owner' : ''}`; break;
    case P.MSG.PLAYERS_SYNC: state.players = p.players || []; renderContacts(); drawMap(); if (state.currentApp === 'admin') renderAdmin(); break;
    case P.MSG.VEHICLES_SYNC: state.vehicles = p.vehicles || []; drawMap(); break;
    case P.MSG.EMERGENCY_SYNC: state.calls = p.calls || []; renderDispatch(); drawMap(); break;
    case P.MSG.EMERGENCY_NEW: {
      if (!state.calls.some((c) => c.callNumber === p.call.callNumber)) state.calls.unshift(p.call);
      renderDispatch(); drawMap();
      if (P.dutyShouldAlert(state.duty, p.call.team)) showBanner(p.call);
      else toast(`New 911 (${p.call.team}) — not your duty, see Dispatch.`);
      break;
    }
    case P.MSG.EMERGENCY_ACKED: toast(`${p.by} is responding to 911 #${p.callNumber}`); renderDispatch(); break;
    case P.MSG.CHAT_HISTORY: state.messages = p.messages || []; renderThreads(); renderBubbles(); break;
    case P.MSG.CHAT_MESSAGE: {
      state.messages.push(p);
      if (state.currentApp !== 'messages' && p.from !== state.me) { state.unread++; buildHome(); }
      renderThreads(); renderBubbles();
      break;
    }
    case P.MSG.TRANSFER_NEW: {
      if (p.to === state.me) { state.balance += p.amount; store.set('balance', state.balance); $('#setBalance').textContent = '$' + state.balance.toLocaleString(); toast(`💵 ${p.from} sent you $${p.amount.toLocaleString()}`); }
      if (p.from === state.me) { state.balance -= p.amount; store.set('balance', state.balance); $('#setBalance').textContent = '$' + state.balance.toLocaleString(); }
      break;
    }
    case P.MSG.CALL_INCOMING: state.callPeer = p.from; $('#callName').textContent = p.from; $('#callAvatar').textContent = initials(p.from); $('#callState').textContent = 'incoming call…'; $('#callAccept').style.display = ''; $('#callOverlay').hidden = false; break;
    case P.MSG.CALL_STATE:
      if (!$('#callOverlay').hidden && state.callPeer === p.from) {
        if (p.state === 'accepted') $('#callState').textContent = 'connected · 00:00';
        if (p.state === 'ended') { $('#callOverlay').hidden = true; toast(`Call with ${p.from} ended.`); }
      }
      break;
    case P.MSG.ADMIN_SNAPSHOT: state.admin = p; if (state.currentApp === 'admin') renderAdmin(); break;
    case P.MSG.ADMIN_RESULT: {
      const el = $('#cmdResult'); el.className = 'cmd-result show ' + (p.ok ? 'ok' : 'err');
      el.textContent = `${p.ok ? '✅' : '⛔'} ${p.command || ''} — ${p.message}`; break;
    }
    case P.MSG.HOST_NOTICE: toast(p.message); break;
    case P.MSG.ERROR: toast(p.message || 'Host error'); break;
    default: break;
  }
}
function send(type, payload) { if (state.ws?.readyState === 1) state.ws.send(P.envelope(type, payload)); }
$('#btnDisconnect').addEventListener('click', () => { try { state.ws?.close(); } catch { /* noop */ } state.connected = false; showScreen('screen-connect'); });
$('#dutySelect').addEventListener('change', (e) => { state.duty = e.target.value; store.set('duty', state.duty); toast(`Duty set to ${state.duty} — 911 alerts filtered accordingly.`); });

/* ---------------- 911 Dispatch ---------------- */
function renderDispatch() {
  const list = $('#callList'); if (!list) return;
  if (!state.calls.length) { list.innerHTML = '<div class="empty">📞 No active 911 calls.<br>New in-game 911 calls appear here in real time.</div>'; return; }
  list.innerHTML = state.calls.map((c) => {
    const teamCls = /fire/i.test(c.team) ? 'fire' : /ems|medic/i.test(c.team) ? 'ems' : '';
    const mine = P.dutyShouldAlert(state.duty, c.team);
    return `<article class="call-card" ${state.selectedCall?.callNumber === c.callNumber ? 'style="outline:2px solid var(--accent)"' : ''}>
      <div class="call-top"><span class="call-num">CALL #${esc(c.callNumber ?? '—')}</span><span class="call-team ${teamCls}">${esc(c.team)}${mine ? ' · YOUR DUTY' : ''}</span></div>
      <div class="call-desc">${esc(c.description)}</div>
      <div class="call-meta">📞 ${esc(c.callerName)} · 🕐 ${fmtTime(c.startedAt)}<br>📍 ${esc(c.descriptor || 'See map marker')}${c.position ? ` · (X ${Math.round(c.position.x)}, Z ${Math.round(c.position.z)})` : ''}</div>
      ${c.responders?.length ? `<div class="responders">Responding: ${c.responders.map(esc).join(', ')}</div>` : ''}
      <div class="call-actions">
        <button class="mini-btn accent" data-respond="${esc(c.callNumber)}" type="button">🚓 Respond</button>
        <button class="mini-btn" data-locate="${esc(c.callNumber)}" type="button">🗺️ Show on map</button>
      </div></article>`;
  }).join('');
  $$('[data-respond]', list).forEach((b) => b.addEventListener('click', () => {
    send(P.MSG.EMERGENCY_ACK, { callNumber: Number(b.dataset.respond) });
    toast(`You are responding to 911 #${b.dataset.respond}`);
  }));
  $$('[data-locate]', list).forEach((b) => b.addEventListener('click', () => {
    state.selectedCall = state.calls.find((c) => String(c.callNumber) === b.dataset.locate) || null;
    openApp('map');
  }));
}

/* ---------------- Map ---------------- */
const ROADS = [ // stylised Liberty County road network (normalised coords)
  [[0.06, 0.52], [0.94, 0.52]], [[0.5, 0.04], [0.5, 0.96]], [[0.06, 0.3], [0.94, 0.34]],
  [[0.08, 0.74], [0.92, 0.7]], [[0.26, 0.08], [0.3, 0.92]], [[0.74, 0.06], [0.7, 0.94]],
  [[0.06, 0.52], [0.3, 0.3], [0.5, 0.34], [0.74, 0.3], [0.94, 0.34]],
];
function drawMap() {
  const cv = $('#mapCanvas'); if (!cv || state.currentApp !== 'map' && !$('#view-map.active')) { /* still safe to draw offscreen */ }
  if (!cv) return;
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#a9cf8e'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#8fbf74'; for (const [x, y, r] of [[0.16, 0.16, 90], [0.84, 0.84, 110], [0.85, 0.14, 70]]) { ctx.beginPath(); ctx.arc(x * W, y * H, r, 0, 7); ctx.fill(); }
  ctx.strokeStyle = '#6fa8d8'; ctx.lineWidth = 26; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0.88 * H); ctx.bezierCurveTo(0.3 * W, 0.78 * H, 0.62 * W, 0.98 * H, W, 0.84 * H); ctx.stroke();
  ctx.strokeStyle = '#f5f1e6'; ctx.lineWidth = 13;
  for (const line of ROADS) { ctx.beginPath(); line.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(120,110,90,.55)'; ctx.lineWidth = 1.4;
  for (const line of ROADS) { ctx.beginPath(); line.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)); ctx.stroke(); }
  ctx.fillStyle = 'rgba(60,70,50,.75)'; ctx.font = '600 12px Roboto, Arial';
  ctx.fillText('LIBERTY COUNTY', 14, 24); ctx.fillText('Riverbend', 0.6 * W, 0.9 * H);
  const dot = (nx, ny, color, label, ring = false) => {
    ctx.beginPath(); ctx.arc(nx * W, ny * H, ring ? 11 : 8, 0, 7); ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    if (label) { ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.font = '600 11px Roboto, Arial'; ctx.fillText(label, nx * W + 12, ny * H + 4); }
  };
  if ($('#chkCalls')?.checked) for (const c of state.calls) if (c.position) {
    const m = P.worldToMap(c.position.x, c.position.z);
    ctx.beginPath(); ctx.arc(m.x * W, m.y * H, 16 + Math.sin(Date.now() / 300) * 3, 0, 7); ctx.fillStyle = 'rgba(255,69,58,.35)'; ctx.fill();
    dot(m.x, m.y, '#ff453a', `#${c.callNumber}`);
  }
  if ($('#chkVehicles')?.checked) for (const v of state.vehicles) if (v.location) { const m = P.worldToMap(v.location.x, v.location.z); dot(m.x, m.y, v.color || '#666', '🚗'); }
  for (const pl of state.players) {
    if (!pl.location) continue; const m = P.worldToMap(pl.location.x, pl.location.z);
    dot(m.x, m.y, pl.name === state.me ? '#0a84ff' : teamColor(pl.team), pl.name === state.me ? 'YOU' : pl.callsign || '');
  }
  const pin = state.droppedPin || state.mapTap;
  if (pin) { const m = P.worldToMap(pin.x, pin.z); ctx.font = '24px serif'; ctx.fillText('📍', m.x * W - 10, m.y * H + 4); }
  const me = state.players.find((p) => p.name === state.me);
  $('#mapYouLabel').textContent = me?.location
    ? `You: X ${Math.round(me.location.x)}, Z ${Math.round(me.location.z)}${me.location.street ? ' · ' + me.location.street : ''}${me.location.postal ? ' · Postal ' + me.location.postal : ''}`
    : `${state.players.length} players in server · tap map to place a pin`;
}
$('#chkVehicles')?.addEventListener('change', drawMap);
$('#chkCalls')?.addEventListener('change', drawMap);
setInterval(() => { if (state.currentApp === 'map') drawMap(); }, 1200);
$('#mapCanvas').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
  // Hit-test 911 markers first.
  for (const c of state.calls) if (c.position) {
    const m = P.worldToMap(c.position.x, c.position.z);
    if (Math.hypot(m.x - nx, m.y - ny) < 0.045) {
      state.selectedCall = c;
      $('#mapDetail').innerHTML = `<article class="call-card"><div class="call-top"><span class="call-num">CALL #${esc(c.callNumber)}</span><span class="call-team">${esc(c.team)}</span></div><div class="call-desc">${esc(c.description)}</div><div class="call-meta">📞 ${esc(c.callerName)} · 📍 ${esc(c.descriptor || '')}</div><div class="call-actions"><button class="mini-btn accent" id="mapRespond" type="button">🚓 Respond</button></div></article>`;
      $('#mapRespond').addEventListener('click', () => { send(P.MSG.EMERGENCY_ACK, { callNumber: c.callNumber }); toast(`Responding to #${c.callNumber}`); });
      drawMap(); return;
    }
  }
  state.mapTap = P.mapToWorld(nx, ny);
  $('#mapDetail').innerHTML = `<article class="call-card"><div class="call-desc">📍 Pin preview — X ${state.mapTap.x}, Z ${state.mapTap.z}</div><div class="call-meta">Press “Drop pin” to save it, then share it into any chat.</div></article>`;
  drawMap();
});
$('#btnDropPin').addEventListener('click', () => {
  if (!state.mapTap) { toast('Tap the map first to choose a spot.'); return; }
  state.droppedPin = state.mapTap; store.set('pin', state.droppedPin);
  $('#btnSharePin').disabled = false;
  toast(`Pin dropped at X ${state.droppedPin.x}, Z ${state.droppedPin.z}`);
  drawMap();
});
$('#btnSharePin').addEventListener('click', () => {
  if (!state.droppedPin) return;
  openApp('messages'); openThread('lobby');
  send(P.MSG.CHAT_SEND, { to: 'lobby', pin: state.droppedPin });
  toast('Pin shared to Everyone chat.');
});

/* ---------------- Contacts ---------------- */
function renderContacts() {
  const list = $('#contactList'); if (!list) return;
  const q = ($('#contactSearch').value || '').toLowerCase();
  const rows = state.players.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.callsign || '').toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  if (!rows.length) { list.innerHTML = '<div class="empty">No players match. Contacts sync live from <code>/v2/server/players</code> via the Host.</div>'; return; }
  list.innerHTML = rows.map((p) => `<div class="contact-card">
    <div class="avatar" style="background:${teamColor(p.team)}">${esc(initials(p.name))}</div>
    <div class="contact-main"><div class="contact-name">${esc(p.name)}${p.name === state.me ? ' (you)' : ''} ${'★'.repeat(p.wantedStars || 0)}</div>
    <div class="contact-sub">${esc(p.team)}${p.callsign ? ' · ' + esc(p.callsign) : ''}${p.permission && p.permission !== 'Normal' ? ' · ' + esc(p.permission) : ''}<br>${p.location ? `📍 ${esc(p.location.street || 'In county')}${p.location.postal ? ' · Postal ' + esc(p.location.postal) : ''}` : 'Location unavailable'}</div></div>
    <div class="contact-btns">
      <button class="round-btn" data-msg="${esc(p.name)}" title="Message" type="button">💬</button>
      <button class="round-btn" data-call="${esc(p.name)}" title="Call" type="button">📞</button>
      <button class="round-btn" data-pay="${esc(p.name)}" title="Send money (RP)" type="button">💵</button>
    </div></div>`).join('');
  $$('[data-msg]', list).forEach((b) => b.addEventListener('click', () => { openApp('messages'); openThread(b.dataset.msg); }));
  $$('[data-call]', list).forEach((b) => b.addEventListener('click', () => ringCall(b.dataset.call)));
  $$('[data-pay]', list).forEach((b) => b.addEventListener('click', () => {
    const amount = Number(prompt(`Send how much to ${b.dataset.pay}? (phone RP balance: $${state.balance.toLocaleString()})`, '100'));
    if (!amount || amount <= 0) return;
    if (amount > state.balance) { toast('Insufficient phone balance.'); return; }
    send(P.MSG.TRANSFER_SEND, { to: b.dataset.pay, amount });
    toast(`Sent $${amount.toLocaleString()} to ${b.dataset.pay} (RP transfer)`);
  }));
}
$('#contactSearch').addEventListener('input', renderContacts);

/* ---------------- Calls (simulated phone-to-phone signalling) ---------------- */
function ringCall(name) {
  if (name === state.me) { toast('You cannot call yourself.'); return; }
  state.callPeer = name;
  $('#callName').textContent = name; $('#callAvatar').textContent = initials(name);
  $('#callState').textContent = 'calling…'; $('#callAccept').style.display = 'none'; $('#callOverlay').hidden = false;
  send(P.MSG.CALL_RING, { to: name });
}
$('#callAccept').addEventListener('click', () => { send(P.MSG.CALL_ACCEPT, { to: state.callPeer }); $('#callState').textContent = 'connected · 00:00'; });
$('#callDecline').addEventListener('click', () => { send(P.MSG.CALL_END, { to: state.callPeer }); $('#callOverlay').hidden = true; });

/* ---------------- Messages ---------------- */
function threadKey(m) { return m.to === 'lobby' || m.from === 'lobby' ? 'lobby' : (m.from === state.me ? m.to : m.from); }
function renderThreads() {
  const el = $('#threadList'); if (!el || state.currentThread) return;
  const by = new Map([['lobby', null]]);
  for (const m of state.messages) { const k = threadKey(m); if (!by.has(k)) by.set(k, m); by.set(k, m); }
  for (const p of state.players) if (p.name !== state.me && !by.has(p.name)) by.set(p.name, null);
  el.innerHTML = [...by.entries()].map(([k, last]) => `<button class="thread-card" data-thread="${esc(k)}" type="button">
    <div class="avatar" style="background:${k === 'lobby' ? '#23a832' : teamColor(state.players.find((p) => p.name === k)?.team)}">${k === 'lobby' ? '🌐' : esc(initials(k))}</div>
    <div class="contact-main"><div class="contact-name">${k === 'lobby' ? 'Everyone (server lobby)' : esc(k)}</div>
    <div class="contact-sub">${last ? esc(last.text || (last.pin ? '📍 Location pin' : last.image ? '🖼️ Photo' : '')) : 'Say hello…'}</div></div></button>`).join('');
  $$('[data-thread]', el).forEach((b) => b.addEventListener('click', () => openThread(b.dataset.thread)));
}
function openThread(k) {
  state.currentThread = k;
  $('#threadList').hidden = true; $('#threadView').hidden = false;
  $('#threadName').textContent = k === 'lobby' ? 'Everyone' : k;
  renderBubbles();
}
$('#btnThreads').addEventListener('click', () => { state.currentThread = null; $('#threadView').hidden = true; $('#threadList').hidden = false; renderThreads(); });
function renderBubbles() {
  const el = $('#bubbles'); if (!el || !state.currentThread) return;
  const msgs = state.messages.filter((m) => threadKey(m) === state.currentThread);
  el.innerHTML = msgs.map((m) => `<div class="bubble ${m.from === state.me ? 'me' : ''}">
    ${state.currentThread === 'lobby' && m.from !== state.me ? `<div class="b-from">${esc(m.from)}</div>` : ''}
    ${m.image ? `<img src="${m.image}" alt="Shared photo">` : ''}
    ${m.pin ? `<div class="pin-card">📍 <strong>${esc(m.pin.label || 'Dropped pin')}</strong><br>X ${Math.round(m.pin.x)}, Z ${Math.round(m.pin.z)} <button class="mini-btn" data-showpin="${esc(m.pin.x)},${esc(m.pin.z)}" type="button">Show</button></div>` : ''}
    ${m.text ? `<div>${esc(m.text)}</div>` : ''}
    <div class="b-time">${fmtTime(Math.floor(m.ts / 1000))}</div></div>`).join('') || '<div class="empty">No messages yet.</div>';
  el.scrollTop = el.scrollHeight;
  $$('[data-showpin]', el).forEach((b) => b.addEventListener('click', () => {
    const [x, z] = b.dataset.showpin.split(',').map(Number);
    state.droppedPin = { x, z }; store.set('pin', state.droppedPin); openApp('map');
  }));
}
function sendCurrent(extra = {}) {
  const text = $('#msgInput').value.trim();
  if (!text && !extra.image && !extra.pin) return;
  send(P.MSG.CHAT_SEND, { to: state.currentThread || 'lobby', text, ...extra });
  $('#msgInput').value = '';
}
$('#btnSend').addEventListener('click', () => sendCurrent());
$('#msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCurrent(); });
$('#btnPinMsg').addEventListener('click', () => {
  if (!state.droppedPin) { toast('No pin yet — drop one in the GPS Map app first.'); return; }
  sendCurrent({ pin: state.droppedPin, text: '' });
});
$('#btnPhoto').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 720 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    sendCurrent({ image: cv.toDataURL('image/jpeg', 0.72) }); // ~<200KB typical; host caps at 700KB
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});

/* ---------------- Admin (owner only) ---------------- */
const PRESETS = [
  ['📣 Announcement', () => ':h ' + (prompt('Announcement text:', 'Server restart in 10 minutes') || '')],
  ['⚠️ Kick player', () => { const n = prompt('Player username to kick:'); return n ? `:kick ${n}` : ''; }],
  ['🔨 Ban player', () => { const n = prompt('Player username to ban:'); return n ? `:ban ${n}` : ''; }],
  ['🧹 Clear cars', () => ':clearcars'],
  ['🌧️ Weather', () => ':weather rain'],
];
$('#cmdPresets').innerHTML = PRESETS.map(([label], i) => `<button class="mini-btn" data-preset="${i}" type="button">${label}</button>`).join('');
$$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const cmd = PRESETS[Number(b.dataset.preset)][1]();
  if (cmd && cmd.trim() && !cmd.endsWith(' ')) { $('#cmdInput').value = cmd; runCommand(); }
  else if (cmd) $('#cmdInput').value = cmd;
}));
function runCommand() { const cmd = $('#cmdInput').value.trim(); if (cmd) send(P.MSG.ADMIN_COMMAND, { command: cmd }); }
$('#btnCmd').addEventListener('click', runCommand);
$('#cmdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(); });
$$('#adminTabs button').forEach((b) => b.addEventListener('click', () => {
  state.adminTab = b.dataset.tab; $$('#adminTabs button').forEach((x) => x.classList.toggle('on', x === b)); renderAdmin();
}));
function renderAdmin() {
  const owner = state.role === 'owner';
  $('#adminGuard').style.display = owner ? 'none' : '';
  $('#adminMain').hidden = !owner;
  if (!owner) return;
  const a = state.admin || { commandLogs: [], modCalls: [], killLogs: [], joinLogs: [], queue: [] };
  $('#adminStats').innerHTML = `
    <div class="stat"><b>${state.server?.currentPlayers ?? 0}/${state.server?.maxPlayers ?? 0}</b><span>Players online</span></div>
    <div class="stat"><b>${a.queue?.length ?? 0}</b><span>In queue</span></div>
    <div class="stat"><b>${state.calls.length}</b><span>Active 911 calls</span></div>
    <div class="stat"><b>${a.modCalls?.length ?? 0}</b><span>Mod calls (recent)</span></div>`;
  const rows = {
    modcalls: (a.modCalls || []).map((l) => `<div class="log-card">🛎️ <strong>${esc(l.caller)}</strong> requested a moderator${l.moderator ? ` · handled by ${esc(l.moderator)}` : ''}<div class="log-meta">${fmtTime(l.ts)}</div><div class="call-actions"><button class="mini-btn" data-respond-to="${esc(l.caller)}" type="button">Message caller</button></div></div>`),
    commands: (a.commandLogs || []).map((l) => `<div class="log-card"><code>${esc(l.command)}</code> — ${esc(l.player)}<div class="log-meta">${fmtTime(l.ts)}</div></div>`),
    kills: (a.killLogs || []).map((l) => `<div class="log-card">💀 <strong>${esc(l.killer)}</strong> killed <strong>${esc(l.killed)}</strong><div class="log-meta">${fmtTime(l.ts)}</div></div>`),
    joins: (a.joinLogs || []).map((l) => `<div class="log-card">${l.join ? '🟢 joined' : '🔴 left'} <strong>${esc(l.player)}</strong><div class="log-meta">${fmtTime(l.ts)}</div></div>`),
  }[state.adminTab] || [];
  $('#adminLogList').innerHTML = rows.join('') || '<div class="empty">Nothing here yet — the Host polls command/mod/kill/join logs from the ER:LC API.</div>';
  $$('[data-respond-to]').forEach((b) => b.addEventListener('click', () => { openApp('messages'); openThread(b.dataset.respondTo); }));
}

/* ---------------- settings / overlay keybind ---------------- */
$('#inKeybind').value = store.get('keybind', 'F8');
$('#inKeybind').addEventListener('change', (e) => {
  const value = e.target.value.trim() || 'F8';
  store.set('keybind', value);
  if (window.overlayAPI?.setKeybind) window.overlayAPI.setKeybind(value).then((r) => toast(r?.ok ? `Keybind set to ${value}` : `Could not register ${value} — try another combo.`));
  else toast(`Keybind saved: ${value} (applies in the desktop overlay)`);
});
