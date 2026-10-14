'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../shared/protocol');

test('sanitizer whitelists fields and strips secrets / JoinKey', () => {
  const snap = P.sanitizeSnapshot({
    Name: 'Test', CurrentPlayers: 1, MaxPlayers: 40, JoinKey: 'DO-NOT-LEAK', OwnerId: 42,
    ServerKey: 'SECRET', Authorization: 'SECRET2',
    Players: [{ Player: 'Ava:123', Team: 'Police', Callsign: '1L-12', Permission: 'Normal', WantedStars: 2, Location: { LocationX: 10, LocationZ: -20, PostalCode: '218', StreetName: 'Park Street' }, Password: 'x' }],
    EmergencyCalls: [{ Team: 'Police', Caller: 123, Position: [5, 6], StartedAt: 100, CallNumber: 7, Description: 'MVA', PositionDescriptor: 'Park St' }],
    Vehicles: [{ Name: 'Car', Owner: 'Ava', Plate: 'A1', ColorHex: '#fff', LocationX: 1, LocationZ: 2 }],
  });
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('DO-NOT-LEAK') && !json.includes('SECRET'), 'no secret material may survive sanitizing');
  assert.equal(snap.players[0].name, 'Ava');
  assert.equal(snap.players[0].location.postal, '218');
  assert.equal(snap.emergencyCalls[0].position.x, 5);
  assert.equal(snap.vehicles[0].location.z, 2);
});

test('world<->map coordinates round-trip and clamp', () => {
  const m = P.worldToMap(99999, -99999);
  assert.ok(m.x <= 1 && m.y >= 0);
  const w = P.mapToWorld(0.5, 0.5);
  assert.deepEqual(w, { x: 0, z: 0 });
});

test('duty alert mapping', () => {
  assert.equal(P.dutyShouldAlert('Police', 'Sheriff'), true);
  assert.equal(P.dutyShouldAlert('Fire', 'Police'), false);
  assert.equal(P.dutyShouldAlert('Civilian', 'Police'), false);
});

test('remote command validation', () => {
  assert.equal(P.validateRemoteCommand(':h hello').ok, true);
  assert.equal(P.validateRemoteCommand('hello').ok, false);
  assert.equal(P.validateRemoteCommand(':h a\n:kick x').ok, false);
  assert.equal(P.validateRemoteCommand('').ok, false);
});

test('envelope round-trip + garbage tolerance', () => {
  const raw = P.envelope(P.MSG.CHAT_SEND, { text: 'hi' });
  const msg = P.parseEnvelope(raw);
  assert.equal(msg.type, P.MSG.CHAT_SEND);
  assert.equal(P.parseEnvelope('not json'), null);
});
