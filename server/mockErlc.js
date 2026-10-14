'use strict';
/**
 * server/mockErlc.js — a drop-in, credential-free stand-in for ErlcClient.
 *
 * Lets anyone run the whole stack (Host + phones) with NO ER:LC Server Key:
 * it returns the exact v2 shapes documented at apidocs.erlc.gg and simulates
 * a living server — players roam (LocationX/LocationZ random-walk), new 911
 * calls arrive, logs grow. The Host cannot tell the difference, which is
 * precisely the point: swap `new MockErlcSource()` for `new ErlcClient(...)`
 * and everything downstream is unchanged.
 */

const NAMES = [
  ['Ava_RPD', 'Police', '1L-12'], ['MarcusFD', 'Fire', null], ['medic_mia', 'EMS', null],
  ['Deputy_Dan', 'Sheriff', '2S-40'], ['willg6124', 'Civilian', null], ['LibertyLeo', 'Police', '1L-07'],
  ['SgtRiley', 'Sheriff', '2S-18'], ['civ_carl', 'Civilian', null], ['TracerTom', 'Civilian', null],
  ['FireChiefFox', 'Fire', null], ['OfficerIvy', 'Police', '1L-21'], ['EMSElena', 'EMS', null],
];
const STREETS = ['Park Street', 'Freedom Avenue', 'Liberty Way', 'Main Street', 'Riverbend Road', 'Cactus Court'];
const CALLS = [
  ['Police', 'MVA with injuries — two vehicles, blocking the intersection.', 'Nr. Park Street'],
  ['Fire', 'Structure fire reported, smoke visible from the roof.', 'Freedom Avenue'],
  ['EMS', 'Unconscious person on the sidewalk, caller unsure of cause.', 'Liberty Way'],
  ['Police', 'Shoplifting suspect fled on foot, last seen heading east.', 'Main Street'],
  ['Fire', 'Brush fire spreading near the treeline, no structures yet.', 'Riverbend Road'],
];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

class MockErlcSource {
  constructor() {
    this.kind = 'mock';
    this._seq = 400;
    this._players = NAMES.map(([name, team, callsign], i) => ({
      Player: `${name}:${100000 + i * 137}`,
      Team: team, Callsign: callsign,
      Permission: name === 'willg6124' ? 'Server Owner' : (team === 'Civilian' ? 'Normal' : 'Normal'),
      WantedStars: team === 'Civilian' && i % 3 === 0 ? 1 : 0,
      Location: { LocationX: rnd(-2600, 2600), LocationZ: rnd(-2600, 2600), PostalCode: String(200 + Math.floor(rnd(0, 60))), StreetName: pick(STREETS), BuildingNumber: String(2000 + Math.floor(rnd(0, 90))) },
      _vx: rnd(-90, 90), _vz: rnd(-90, 90),
    }));
    this._calls = CALLS.slice(0, 3).map(([team, description, descriptor], i) => this._mkCall(team, description, descriptor, Date.now() / 1000 - (i + 1) * 240));
    this._commandLogs = [{ Player: 'SgtRiley:1000548', Timestamp: Math.floor(Date.now() / 1000) - 600, Command: ':h Traffic advisory on Freedom Ave' }];
    this._modCalls = [{ Caller: 'civ_carl:1001095', Moderator: 'SgtRiley:1000548', Timestamp: Math.floor(Date.now() / 1000) - 900 }];
    this._killLogs = [];
    this._joinLogs = this._players.slice(0, 4).map((p) => ({ Join: true, Timestamp: Math.floor(Date.now() / 1000) - 1800, Player: p.Player }));
    this._vehicles = [
      { Name: 'Police Interceptor', Owner: 'Ava_RPD', Plate: 'LCPD-12', ColorHex: '#1b3a6b', LocationX: -420, LocationZ: 610 },
      { Name: 'Redline Fire Engine', Owner: 'MarcusFD', Plate: 'FD-204', ColorHex: '#c02727', LocationX: 880, LocationZ: -340 },
      { Name: 'Ambulance', Owner: 'medic_mia', Plate: 'EMS-07', ColorHex: '#e8e8e8', LocationX: 120, LocationZ: 1180 },
      { Name: 'Civilian Sedan', Owner: 'civ_carl', Plate: 'ABC-123', ColorHex: '#3f7f4f', LocationX: -1500, LocationZ: -900 },
    ];
    this._timer = setInterval(() => this._tick(), 2000);
    this._timer.unref?.();
    this._nextCallAt = Date.now() + 25000;
  }

  _mkCall(team, description, descriptor, startedAtSec) {
    return {
      Team: team, Caller: 100000 + Math.floor(rnd(0, 900)),
      Players: [], Position: [Math.round(rnd(-2400, 2400)), Math.round(rnd(-2400, 2400))],
      StartedAt: Math.floor(startedAtSec), CallNumber: this._seq++,
      Description: description, PositionDescriptor: descriptor,
    };
  }

  _tick() {
    for (const p of this._players) {
      p.Location.LocationX = Math.max(-3200, Math.min(3200, p.Location.LocationX + p._vx));
      p.Location.LocationZ = Math.max(-3200, Math.min(3200, p.Location.LocationZ + p._vz));
      if (Math.random() < 0.06) { p._vx = rnd(-90, 90); p._vz = rnd(-90, 90); }
      if (Math.random() < 0.03) p.Location.StreetName = pick(STREETS);
    }
    if (Date.now() >= this._nextCallAt) {
      const [team, description, descriptor] = pick(CALLS);
      this._calls.unshift(this._mkCall(team, description, descriptor, Date.now() / 1000));
      this._calls = this._calls.slice(0, 12);
      this._nextCallAt = Date.now() + rnd(45000, 90000);
    }
  }

  async validateKey() { return { ok: true, serverName: 'Liberty County RP (Mock)' }; }
  keyHint() { return 'mock-mode'; }

  async getSnapshot() {
    const pub = (p) => { const { _vx, _vz, ...rest } = p; return rest; };
    return {
      Name: 'Liberty County RP (Mock)', OwnerId: 1, CoOwnerIds: [],
      CurrentPlayers: this._players.length, MaxPlayers: 40,
      JoinKey: 'MOCK-ONLY-NOT-A-REAL-KEY', AccVerifiedReq: 'Disabled', TeamBalance: true,
      Players: this._players.map(pub), Vehicles: this._vehicles,
      EmergencyCalls: this._calls, CommandLogs: this._commandLogs,
      ModCalls: this._modCalls, KillLogs: this._killLogs,
      JoinLogs: this._joinLogs, Queue: [1000999],
      Staff: { Admins: { '1': 'willg6124' }, Mods: { '1000548': 'SgtRiley' }, Helpers: {} },
    };
  }

  async runCommand(command) {
    this._commandLogs.unshift({ Player: 'willg6124:1', Timestamp: Math.floor(Date.now() / 1000), Command: command });
    return { ok: true, mock: true };
  }

  close() { clearInterval(this._timer); }
}

module.exports = { MockErlcSource };
