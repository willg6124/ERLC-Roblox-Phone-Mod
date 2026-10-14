'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { HostServer } = require('../server/hostServer');
const P = require('../shared/protocol');

function connectPhone(port, { code, name, duty = 'Police' }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    ws.on('open', () => ws.send(P.envelope(P.MSG.JOIN, { code, name, duty })));
    ws.on('message', (d) => { const m = P.parseEnvelope(d); if (m) { inbox.push(m); if (m.type === P.MSG.WELCOME) resolve({ ws, inbox }); } });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout')), 5000);
  });
}
const nextOf = (phone, type, ms = 4000) => new Promise((resolve, reject) => {
  const hit = phone.inbox.find((m) => m.type === type);
  if (hit) return resolve(hit);
  const t = setInterval(() => { const h = phone.inbox.find((m) => m.type === type); if (h) { clearInterval(t); resolve(h); } }, 10);
  setTimeout(() => { clearInterval(t); reject(new Error(`timed out waiting for ${type}`)); }, ms);
});

test('host: pairing roles, filtered sync, chat relay, owner-only admin', async (t) => {
  const host = new HostServer({ port: 0, pollMs: 60000 });
  await host.start();
  t.after(() => host.stop());
  const { port } = host.httpServer.address();
  await host.configureSource({ mock: true });

  // Bad code is rejected (no WELCOME).
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const badErr = new Promise((resolve) => bad.on('message', (d) => { const m = P.parseEnvelope(d); if (m?.type === P.MSG.ERROR) resolve(m); }));
  bad.on('open', () => bad.send(P.envelope(P.MSG.JOIN, { code: '000000', name: 'Intruder' })));
  assert.match((await badErr).payload.message, /does not match/);
  bad.close();

  const player = await connectPhone(port, { code: host.pairingCode, name: 'Ava_RPD' });
  const owner = await connectPhone(port, { code: host.ownerCode, name: 'willg6124' });
  t.after(() => { player.ws.close(); owner.ws.close(); });

  assert.equal(player.inbox.find((m) => m.type === P.MSG.WELCOME).payload.role, 'player');
  assert.equal(owner.inbox.find((m) => m.type === P.MSG.WELCOME).payload.role, 'owner');

  const sync = await nextOf(player, P.MSG.PLAYERS_SYNC);
  assert.ok(sync.payload.players.length >= 5);
  assert.ok(sync.payload.players.every((p) => p.location && 'x' in p.location), 'players carry map coordinates');

  // The single most important assertion in this repo: nothing on the wire
  // may contain credential-shaped material or the server JoinKey.
  const wire = JSON.stringify(player.inbox) + JSON.stringify(owner.inbox);
  assert.ok(!/Server-Key|MOCK-ONLY|JoinKey/i.test(wire), 'no secrets on the phone wire');

  // Players must NOT receive the owner-only admin snapshot…
  assert.ok(!player.inbox.some((m) => m.type === P.MSG.ADMIN_SNAPSHOT));
  // …but the owner must.
  await nextOf(owner, P.MSG.ADMIN_SNAPSHOT);

  // Player trying to run a command is denied even if they forge the message.
  player.ws.send(P.envelope(P.MSG.ADMIN_COMMAND, { command: ':kick Ava_RPD' }));
  const denied = await nextOf(player, P.MSG.ADMIN_RESULT);
  assert.equal(denied.payload.ok, false);

  // Owner command succeeds (mock source).
  owner.ws.send(P.envelope(P.MSG.ADMIN_COMMAND, { command: ':h Test announcement' }));
  const okRes = await nextOf(owner, P.MSG.ADMIN_RESULT);
  assert.equal(okRes.payload.ok, true);

  // Chat + dropped pin relay player -> owner.
  player.ws.send(P.envelope(P.MSG.CHAT_SEND, { to: 'lobby', text: '10-4', pin: { x: 100, z: -200, label: 'Staging' } }));
  const chat = await nextOf(owner, P.MSG.CHAT_MESSAGE);
  assert.equal(chat.payload.text, '10-4');
  assert.equal(chat.payload.pin.x, 100);
});

test('host: health + demo code gating', async (t) => {
  const host = new HostServer({ port: 0, demoMode: false });
  await host.start(); t.after(() => host.stop());
  const { port } = host.httpServer.address();
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.ok, true);
  const codes = await fetch(`http://127.0.0.1:${port}/api/demo/codes`);
  assert.equal(codes.status, 403, 'pairing codes are never public unless demo mode is explicitly on');
  const status = await fetch(`http://127.0.0.1:${port}/api/host/status`);
  assert.equal(status.status, 401, 'manager status requires the host admin token');
});
