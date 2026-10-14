'use strict';
/**
 * server/hostServer.js — the Server Owner Host (".exe Server Manager" core).
 *
 * This is the ONLY component that ever touches the ER:LC Server-Key.
 * Player phones connect here over WebSocket with a 6-digit pairing code
 * and receive whitelisted, sanitized snapshots (shared/protocol.js).
 * Phones can therefore be distributed freely: they contain no credentials
 * and could not call api.erlc.gg even if decompiled.
 *
 * Data pipeline (see docs/ARCHITECTURE.md):
 *   ErlcClient/MockErlcSource --poll--> HostServer --sanitize+diff-->
 *   WebSocket broadcast (role-scoped) --> phone overlays
 *   ER:LC webhook POST /webhooks/erlc --Ed25519 verify--> same broadcast
 *   Owner phone admin:command --> role re-check --> POST /v2/server/command
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const P = require('../shared/protocol');
const { ErlcClient } = require('./erlcClient');
const { MockErlcSource } = require('./mockErlc');
const { verifyErlcWebhook, parseWebhookEvent } = require('./webhook');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const sixDigits = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

class HostServer {
  constructor({ port = 3847, host = '0.0.0.0', pollMs = 4000, demoMode = false } = {}) {
    this.port = port; this.host = host; this.pollMs = pollMs; this.demoMode = demoMode;
    this.adminToken = crypto.randomBytes(24).toString('hex'); // guards the Manager REST API
    this.source = null;            // ErlcClient | MockErlcSource
    this.sourceKind = 'stopped';   // 'live' | 'mock' | 'stopped'
    this.pairingCode = sixDigits();  // players
    this.ownerCode = sixDigits();    // server owner (grants the Admin app)
    while (this.ownerCode === this.pairingCode) this.ownerCode = sixDigits();
    this.clients = new Set();      // {ws, name, role, duty}
    this.chat = [];                // last 200 messages (in-memory; phones re-sync on join)
    this.snapshot = null;          // last sanitized snapshot
    this._knownCalls = new Set();  // CallNumbers already broadcast
    this._pollTimer = null;
    this._events = [];             // host event log for the Manager UI
    this.startedAt = Date.now();
  }

  logEvent(message) {
    const entry = { ts: Date.now(), message };
    this._events.unshift(entry); this._events = this._events.slice(0, 80);
    console.log(`[host] ${message}`);
  }

  /* ---------------- source lifecycle ---------------- */
  async configureSource({ serverKey = '', globalToken = '', mock = false } = {}) {
    this.stopPolling();
    if (this.source?.close) this.source.close();
    if (mock || !serverKey) {
      this.source = new MockErlcSource(); this.sourceKind = 'mock';
      this.logEvent('Source configured: MOCK MODE (no Server-Key in use).');
    } else {
      this.source = new ErlcClient({ serverKey, globalToken }); this.sourceKind = 'live';
      this.logEvent(`Source configured: LIVE ER:LC API (key ${this.source.keyHint()}).`);
    }
    const check = await this.source.validateKey();
    await this.pollOnce(true);
    this.startPolling();
    return check;
  }

  startPolling() {
    this.stopPolling();
    this._pollTimer = setInterval(() => this.pollOnce(false).catch((e) => this.logEvent(`Poll failed: ${e.message}`)), this.pollMs);
    this._pollTimer.unref?.();
  }
  stopPolling() { if (this._pollTimer) clearInterval(this._pollTimer); this._pollTimer = null; }

  async pollOnce(first = false) {
    if (!this.source) return;
    const raw = await this.source.getSnapshot();
    const snap = P.sanitizeSnapshot(raw);
    if (!snap) return;
    const prevPlayers = new Map((this.snapshot?.players || []).map((p) => [p.name, p]));
    this.snapshot = snap;

    // New 911 calls -> targeted real-time broadcast.
    for (const call of snap.emergencyCalls) {
      if (call.callNumber != null && !this._knownCalls.has(call.callNumber)) {
        this._knownCalls.add(call.callNumber);
        if (!first) { this.broadcast(P.MSG.EMERGENCY_NEW, { call }); this.logEvent(`New 911 call #${call.callNumber} (${call.team}): ${call.description}`); }
      }
    }
    if (this._knownCalls.size > 500) this._knownCalls = new Set(snap.emergencyCalls.map((c) => c.callNumber));

    const joined = snap.players.filter((p) => !prevPlayers.has(p.name)).map((p) => p.name);
    if (joined.length && !first) this.logEvent(`Player(s) joined: ${joined.join(', ')}`);

    this.broadcast(P.MSG.SERVER_INFO, { server: snap.server });
    this.broadcast(P.MSG.PLAYERS_SYNC, { players: snap.players });
    this.broadcast(P.MSG.VEHICLES_SYNC, { vehicles: snap.vehicles });
    this.broadcast(P.MSG.EMERGENCY_SYNC, { calls: snap.emergencyCalls });
    this.broadcast(P.MSG.ADMIN_SNAPSHOT, snap.admin, 'owner'); // owner-scoped only
  }

  /* ---------------- HTTP ---------------- */
  _sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  _isAdmin(req) { return req.headers['x-host-admin'] === this.adminToken; }

  _serveStatic(req, res, urlPath) {
    const routes = {
      '/': 'phone/index.html', '/phone': 'phone/index.html',
      '/phone/phone.js': 'phone/phone.js', '/phone/phone.css': 'phone/phone.css',
      '/shared/protocol.js': 'shared/protocol.js',
      '/manager': 'apps/host/manager.html',
    };
    const rel = routes[urlPath];
    if (!rel) return false;
    const file = path.join(ROOT, rel);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return true;
  }

  async _readBody(req, limit = 1024 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Body too large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  createHttpServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      try {
        if (this._serveStatic(req, res, url.pathname)) return;

        if (url.pathname === '/api/health' && req.method === 'GET') {
          return this._sendJson(res, 200, { ok: true, source: this.sourceKind, phones: this.clients.size, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) });
        }
        // Demo ONLY: lets the public web preview show the codes. Off by default.
        if (url.pathname === '/api/demo/codes' && req.method === 'GET') {
          if (!this.demoMode) return this._sendJson(res, 403, { error: 'Demo mode is off. Open the Host Manager for pairing codes.' });
          return this._sendJson(res, 200, { pairingCode: this.pairingCode, ownerCode: this.ownerCode, demo: true });
        }
        if (url.pathname === '/api/host/status' && req.method === 'GET') {
          if (!this._isAdmin(req)) return this._sendJson(res, 401, { error: 'Host admin token required.' });
          return this._sendJson(res, 200, {
            source: this.sourceKind, pairingCode: this.pairingCode, ownerCode: this.ownerCode,
            phones: [...this.clients].map((c) => ({ name: c.name, role: c.role, duty: c.duty })),
            server: this.snapshot?.server || null, playerCount: this.snapshot?.players.length || 0,
            events: this._events,
          });
        }
        if (url.pathname === '/api/host/configure' && req.method === 'POST') {
          if (!this._isAdmin(req)) return this._sendJson(res, 401, { error: 'Host admin token required.' });
          const body = JSON.parse((await this._readBody(req)).toString('utf8') || '{}');
          try {
            const check = await this.configureSource(body);
            return this._sendJson(res, 200, { ok: true, serverName: check.serverName, source: this.sourceKind });
          } catch (e) { return this._sendJson(res, 400, { error: `Could not validate that Server-Key: ${e.message}` }); }
        }
        if (url.pathname === '/api/host/regenerate' && req.method === 'POST') {
          if (!this._isAdmin(req)) return this._sendJson(res, 401, { error: 'Host admin token required.' });
          this.pairingCode = sixDigits(); this.ownerCode = sixDigits();
          this.logEvent('Pairing codes regenerated — all previously shared codes are now invalid.');
          return this._sendJson(res, 200, { pairingCode: this.pairingCode, ownerCode: this.ownerCode });
        }
        if (url.pathname === '/webhooks/erlc' && req.method === 'POST') {
          const raw = await this._readBody(req);
          const ok = verifyErlcWebhook({ rawBody: raw, timestamp: req.headers['x-signature-timestamp'], signatureHex: req.headers['x-signature-ed25519'] });
          if (!ok) return this._sendJson(res, 401, { error: 'Invalid webhook signature.' });
          let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* ignore */ }
          const ev = parseWebhookEvent(json);
          if (ev?.kind === 'emergency') {
            const call = P.sanitizeEmergencyCall(ev.call);
            if (call) { this.broadcast(P.MSG.EMERGENCY_NEW, { call }); this.logEvent(`Webhook: new 911 call #${call.callNumber ?? '?'} (${call.team})`); }
          } else if (ev?.kind === 'custom-command') {
            this.broadcast(P.MSG.HOST_NOTICE, { message: `In-game custom command: ${ev.text}` }, 'owner');
          }
          return this._sendJson(res, 200, { ok: true });
        }
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' }));
      } catch (e) {
        this._sendJson(res, 500, { error: e.message });
      }
    });
  }

  /* ---------------- WebSocket hub ---------------- */
  send(client, type, payload) {
    if (client.ws.readyState === 1) client.ws.send(P.envelope(type, payload));
  }
  broadcast(type, payload, role = null) {
    for (const c of this.clients) if (!role || c.role === role) this.send(c, type, payload);
  }
  broadcastPresence() {
    this.broadcast(P.MSG.PRESENCE, { phones: [...this.clients].map((c) => ({ name: c.name, role: c.role, duty: c.duty })) });
  }
  _deliverChat(msg) {
    this.chat.push(msg); this.chat = this.chat.slice(-200);
    for (const c of this.clients) {
      if (msg.to === 'lobby' || msg.to === c.name || msg.from === c.name) this.send(c, P.MSG.CHAT_MESSAGE, msg);
    }
  }

  async _handleMessage(client, msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case P.MSG.CHAT_SEND: {
        const text = typeof p.text === 'string' ? p.text.slice(0, 2000) : '';
        const image = typeof p.image === 'string' && p.image.startsWith('data:image/') && p.image.length < 700000 ? p.image : null;
        const pin = p.pin && Number.isFinite(Number(p.pin.x)) && Number.isFinite(Number(p.pin.z)) ? { x: Number(p.pin.x), z: Number(p.pin.z), label: String(p.pin.label || 'Dropped pin').slice(0, 60) } : null;
        if (!text && !image && !pin) return;
        this._deliverChat({ id: crypto.randomUUID(), from: client.name, to: String(p.to || 'lobby').slice(0, 40), text, image, pin, ts: Date.now() });
        break;
      }
      case P.MSG.CHAT_PIN: return this._handleMessage(client, { type: P.MSG.CHAT_SEND, payload: { to: p.to, pin: p.pin } });
      case P.MSG.CALL_RING: case P.MSG.CALL_ACCEPT: case P.MSG.CALL_END: {
        const to = String(p.to || '');
        for (const c of this.clients) if (c.name === to) {
          this.send(c, msg.type === P.MSG.CALL_RING ? P.MSG.CALL_INCOMING : P.MSG.CALL_STATE,
            { from: client.name, state: msg.type === P.MSG.CALL_ACCEPT ? 'accepted' : 'ended' });
        }
        break;
      }
      case P.MSG.TRANSFER_SEND: {
        const amount = Math.max(1, Math.min(1000000, Math.floor(Number(p.amount) || 0)));
        const to = String(p.to || '');
        if (!amount || !to) return;
        const rec = { from: client.name, to, amount, note: String(p.note || '').slice(0, 80), ts: Date.now() };
        for (const c of this.clients) if (c.name === to || c.name === client.name) this.send(c, P.MSG.TRANSFER_NEW, rec);
        this._deliverChat({ id: crypto.randomUUID(), from: 'PhonePay', to, text: `${client.name} sent $${amount.toLocaleString()}${rec.note ? ` — ${rec.note}` : ''}`, image: null, pin: null, ts: Date.now() });
        break;
      }
      case P.MSG.EMERGENCY_ACK: {
        const callNumber = Number(p.callNumber);
        this.broadcast(P.MSG.EMERGENCY_ACKED, { callNumber, by: client.name });
        this.logEvent(`${client.name} is responding to 911 call #${callNumber}.`);
        break;
      }
      case P.MSG.ADMIN_COMMAND: {
        if (client.role !== 'owner') { this.send(client, P.MSG.ADMIN_RESULT, { command: p.command, ok: false, message: 'Denied: only the Server Owner phone can run commands.' }); return; }
        const check = P.validateRemoteCommand(p.command);
        if (!check.ok) { this.send(client, P.MSG.ADMIN_RESULT, { command: p.command, ok: false, message: check.error }); return; }
        try {
          if (!this.source) throw new Error('No ER:LC source configured on the host.');
          await this.source.runCommand(check.command);
          this.logEvent(`Owner ran remote command: ${check.command}`);
          this.send(client, P.MSG.ADMIN_RESULT, { command: check.command, ok: true, message: this.sourceKind === 'mock' ? 'Sent (mock mode — no real server).' : 'Sent to your ER:LC server.' });
          setTimeout(() => this.pollOnce(false).catch(() => {}), 800);
        } catch (e) { this.send(client, P.MSG.ADMIN_RESULT, { command: check.command, ok: false, message: e.message }); }
        break;
      }
      case P.MSG.ADMIN_REFRESH: {
        if (client.role !== 'owner') return;
        if (this.snapshot) this.send(client, P.MSG.ADMIN_SNAPSHOT, this.snapshot.admin);
        break;
      }
      default: break;
    }
  }

  attachWebSockets(httpServer) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    wss.on('connection', (ws) => {
      const client = { ws, name: null, role: null, duty: 'Civilian', joined: false };
      const joinTimer = setTimeout(() => { if (!client.joined) ws.close(4001, 'Join timeout'); }, 15000);
      ws.on('message', async (data) => {
        const msg = P.parseEnvelope(data);
        if (!msg) return;
        if (!client.joined) {
          if (msg.type !== P.MSG.JOIN) { ws.close(4002, 'Must join first'); return; }
          const code = String(msg.payload?.code || '').trim();
          const name = String(msg.payload?.name || '').trim().slice(0, 32);
          const duty = P.DUTIES.includes(msg.payload?.duty) ? msg.payload.duty : 'Civilian';
          if (!name) { ws.send(P.envelope(P.MSG.ERROR, { message: 'Enter your Roblox username first.' })); return; }
          const role = code === this.ownerCode ? 'owner' : code === this.pairingCode ? 'player' : null;
          if (!role) { ws.send(P.envelope(P.MSG.ERROR, { message: 'That 6-digit code does not match this server host. Check the code in the Host Manager.' })); return; }
          Object.assign(client, { name, role, duty, joined: true });
          clearTimeout(joinTimer);
          this.clients.add(client);
          this.send(client, P.MSG.WELCOME, { role, you: name, duty, server: this.snapshot?.server || null, source: this.sourceKind });
          if (this.snapshot) {
            this.send(client, P.MSG.PLAYERS_SYNC, { players: this.snapshot.players });
            this.send(client, P.MSG.VEHICLES_SYNC, { vehicles: this.snapshot.vehicles });
            this.send(client, P.MSG.EMERGENCY_SYNC, { calls: this.snapshot.emergencyCalls });
            if (role === 'owner') this.send(client, P.MSG.ADMIN_SNAPSHOT, this.snapshot.admin);
          }
          this.send(client, P.MSG.CHAT_HISTORY, { messages: this.chat.filter((m) => m.to === 'lobby' || m.to === name || m.from === name).slice(-60) });
          this.broadcastPresence();
          this.logEvent(`Phone connected: ${name} (${role}, duty: ${duty}).`);
          return;
        }
        try { await this._handleMessage(client, msg); } catch (e) { this.send(client, P.MSG.ERROR, { message: e.message }); }
      });
      ws.on('close', () => {
        clearTimeout(joinTimer);
        if (this.clients.delete(client)) { this.broadcastPresence(); this.logEvent(`Phone disconnected: ${client.name || 'unknown'}.`); }
      });
    });
    // Heartbeat: drop dead sockets so the Manager's phone list stays honest.
    const hb = setInterval(() => { for (const c of this.clients) { if (c.ws.readyState === 1) c.ws.ping(); } }, 30000);
    hb.unref?.();
    return wss;
  }

  async start() {
    this.httpServer = this.createHttpServer();
    this.attachWebSockets(this.httpServer);
    await new Promise((resolve) => this.httpServer.listen(this.port, this.host, resolve));
    const addr = this.httpServer.address();
    this.logEvent(`Host listening on http://${this.host}:${addr.port}  (phones: same address, path /)`);
    this.logEvent(`Pairing code (players): ${this.pairingCode}   Owner code (Admin app): ${this.ownerCode}`);
    return addr;
  }

  async stop() {
    this.stopPolling();
    if (this.source?.close) this.source.close();
    for (const c of this.clients) { try { c.ws.close(); } catch { /* noop */ } }
    if (this.httpServer) await new Promise((r) => this.httpServer.close(r));
  }
}

module.exports = { HostServer };
