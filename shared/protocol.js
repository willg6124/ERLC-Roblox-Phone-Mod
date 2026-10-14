/**
 * shared/protocol.js — single source of truth shared by the Host server,
 * the Electron shells and the phone UI (browser + Electron renderer).
 *
 * Loaded as a CommonJS module in Node and as `window.ERLC` in the browser.
 *
 * SECURITY INVARIANT: nothing in this file (and nothing sent over the phone
 * WebSocket) ever contains the ER:LC Server-Key or a Global App Token.
 * The key exists only inside the Host process. See docs/SECURITY.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ERLC = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const PROTOCOL_VERSION = 1;

  /** WebSocket message types (see docs/WEBSOCKET_SCHEMA.md). */
  const MSG = Object.freeze({
    // client -> host
    JOIN: 'session:join',          // {code, name, duty}
    CHAT_SEND: 'chat:send',        // {to, text?, image?, pin?}
    CHAT_PIN: 'chat:pin',          // shortcut: {to, pin}
    CALL_RING: 'call:ring',        // {to}
    CALL_ACCEPT: 'call:accept',    // {to}
    CALL_END: 'call:end',          // {to}
    EMERGENCY_ACK: 'emergency:ack',// {callNumber}
    TRANSFER_SEND: 'transfer:send',// {to, amount, note?} phone-RP only, no ER:LC money API exists
    ADMIN_COMMAND: 'admin:command',// {command} OWNER ROLE ONLY — re-checked on the host
    ADMIN_REFRESH: 'admin:refresh',// {} OWNER ROLE ONLY
    // host -> client
    WELCOME: 'session:welcome',    // {role, you, server, duty}
    ERROR: 'session:error',        // {message, code?}
    SERVER_INFO: 'server:info',    // sanitized server info (never the JoinKey)
    PLAYERS_SYNC: 'players:sync',  // {players:[sanitizedPlayer]}
    VEHICLES_SYNC: 'vehicles:sync',// {vehicles:[sanitizedVehicle]}
    EMERGENCY_SYNC: 'emergency:sync', // {calls:[sanitizedCall]}
    EMERGENCY_NEW: 'emergency:new',   // {call} — on-duty phones show the pop-up
    EMERGENCY_ACKED: 'emergency:acked', // {callNumber, by}
    CHAT_MESSAGE: 'chat:message',  // {id, from, to, text?, image?, pin?, ts}
    CHAT_HISTORY: 'chat:history',  // {messages:[...]}
    CALL_INCOMING: 'call:incoming',// {from}
    CALL_STATE: 'call:state',      // {from, state:'accepted'|'ended'}
    TRANSFER_NEW: 'transfer:new',  // {from, to, amount, note?, ts}
    ADMIN_SNAPSHOT: 'admin:snapshot', // OWNER ONLY {commandLogs, modCalls, killLogs, queue, staff}
    ADMIN_RESULT: 'admin:result',     // OWNER ONLY {command, ok, message}
    PRESENCE: 'presence',          // {phones:[{name, role, duty}]}
    HOST_NOTICE: 'host:notice',    // {message}
  });

  const DUTIES = Object.freeze(['Police', 'Fire', 'EMS', 'Civilian']);
  const THEMES = Object.freeze(['ios', 'samsung']);

  /** Which ER:LC EmergencyCalls `Team` values alert which phone duty. */
  const DUTY_ALERT_TEAMS = Object.freeze({
    Police: ['Police', 'Sheriff', 'Law Enforcement', 'State Police'],
    Fire: ['Fire', 'Fire Department'],
    EMS: ['EMS', 'Medical', 'Fire'], // fire-rescue often carries medical calls
    Civilian: [],
  });

  function dutyShouldAlert(duty, callTeam) {
    const teams = DUTY_ALERT_TEAMS[duty] || [];
    if (!callTeam) return duty !== 'Civilian';
    return teams.some((t) => String(callTeam).toLowerCase().includes(t.toLowerCase()))
      || (duty === 'Police' && /police|sheriff|trooper|law/i.test(callTeam));
  }

  /**
   * ER:LC world coordinates -> phone map coordinates.
   * ER:LC LocationX / LocationZ are Roblox studs roughly centred on (0,0);
   * the playable county fits comfortably in +/- MAP_EXTENT. We clamp, then
   * normalise to 0..1 (x east, y south — Z is flipped so north is up).
   */
  const MAP_EXTENT = 3600;
  function worldToMap(x, z) {
    const cx = Math.max(-MAP_EXTENT, Math.min(MAP_EXTENT, Number(x) || 0));
    const cz = Math.max(-MAP_EXTENT, Math.min(MAP_EXTENT, Number(z) || 0));
    return { x: (cx + MAP_EXTENT) / (2 * MAP_EXTENT), y: (cz + MAP_EXTENT) / (2 * MAP_EXTENT) };
  }
  function mapToWorld(nx, ny) {
    return {
      x: Math.round(nx * 2 * MAP_EXTENT - MAP_EXTENT),
      z: Math.round(ny * 2 * MAP_EXTENT - MAP_EXTENT),
    };
  }

  function splitPlayerTag(tag) {
    // ER:LC returns "PlayerName:12345678"
    const s = String(tag || '');
    const i = s.lastIndexOf(':');
    if (i < 0) return { name: s || 'Unknown', id: null };
    return { name: s.slice(0, i), id: s.slice(i + 1) };
  }

  /* ------------------------------------------------------------------ *
   * Sanitizers — the ONLY shapes allowed to leave the Host.
   * Whitelist, never blacklist: a new upstream field cannot leak by
   * accident because it is simply never copied here.
   * ------------------------------------------------------------------ */

  function sanitizePlayer(p) {
    if (!p || typeof p !== 'object') return null;
    const { name, id } = splitPlayerTag(p.Player);
    const loc = p.Location || {};
    const hasLoc = Number.isFinite(Number(loc.LocationX)) && Number.isFinite(Number(loc.LocationZ));
    return {
      name,
      id,
      team: String(p.Team || 'Civilian'),
      callsign: p.Callsign ? String(p.Callsign) : null,
      permission: String(p.Permission || 'Normal'),
      wantedStars: Math.max(0, Math.min(5, Number(p.WantedStars) || 0)),
      location: hasLoc ? {
        x: Number(loc.LocationX), z: Number(loc.LocationZ),
        postal: loc.PostalCode ? String(loc.PostalCode) : null,
        street: loc.StreetName ? String(loc.StreetName) : null,
        building: loc.BuildingNumber ? String(loc.BuildingNumber) : null,
      } : null,
    };
  }

  function sanitizeVehicle(v) {
    if (!v || typeof v !== 'object') return null;
    const loc = v.Location || v; // some payloads nest, some are flat
    const hasLoc = Number.isFinite(Number(loc.LocationX)) && Number.isFinite(Number(loc.LocationZ));
    return {
      name: String(v.Name || 'Vehicle'),
      owner: v.Owner ? String(v.Owner) : null,
      plate: v.Plate ? String(v.Plate) : null,
      color: v.ColorHex ? String(v.ColorHex) : null,
      // NOTE: the stock v2 Vehicles payload may omit live coordinates; when
      // absent the Map app lists the vehicle without plotting a dot.
      location: hasLoc ? { x: Number(loc.LocationX), z: Number(loc.LocationZ) } : null,
    };
  }

  function sanitizeEmergencyCall(c) {
    if (!c || typeof c !== 'object') return null;
    const pos = Array.isArray(c.Position) ? c.Position : [];
    const caller = splitPlayerTag(c.CallerName || c.Caller);
    return {
      callNumber: Number(c.CallNumber) || null,
      team: String(c.Team || 'Police'),
      callerName: caller.name === 'Unknown' && typeof c.Caller === 'number' ? `Caller #${c.Caller}` : caller.name,
      callerId: typeof c.Caller === 'number' ? c.Caller : (caller.id ? Number(caller.id) : null),
      description: String(c.Description || 'No description provided.'),
      descriptor: c.PositionDescriptor ? String(c.PositionDescriptor) : null,
      position: Number.isFinite(Number(pos[0])) && Number.isFinite(Number(pos[1]))
        ? { x: Number(pos[0]), z: Number(pos[1]) } : null,
      startedAt: Number(c.StartedAt) || null,
      responders: Array.isArray(c.Players) ? c.Players.map((p) => splitPlayerTag(p).name) : [],
    };
  }

  function sanitizeServerInfo(s) {
    if (!s || typeof s !== 'object') return null;
    // Deliberately EXCLUDES: JoinKey (joining key — leaking it admits anyone),
    // OwnerId/CoOwnerIds (Roblox ids of owners), and any credential material.
    return {
      name: String(s.Name || 'ER:LC Private Server'),
      currentPlayers: Number(s.CurrentPlayers) || 0,
      maxPlayers: Number(s.MaxPlayers) || 0,
      teamBalance: Boolean(s.TeamBalance),
    };
  }

  /** Owner-only payloads (command logs / mod calls / kills / queue / staff). */
  function sanitizeAdminSnapshot(s) {
    if (!s || typeof s !== 'object') return { commandLogs: [], modCalls: [], killLogs: [], joinLogs: [], queue: [], staff: null };
    const log = (arr, fn) => (Array.isArray(arr) ? arr.slice(0, 100).map(fn).filter(Boolean) : []);
    return {
      commandLogs: log(s.CommandLogs, (l) => ({ player: splitPlayerTag(l.Player).name, command: String(l.Command || ''), ts: Number(l.Timestamp) || null })),
      modCalls: log(s.ModCalls, (l) => ({ caller: splitPlayerTag(l.Caller).name, moderator: l.Moderator ? splitPlayerTag(l.Moderator).name : null, ts: Number(l.Timestamp) || null })),
      killLogs: log(s.KillLogs, (l) => ({ killed: splitPlayerTag(l.Killed).name, killer: splitPlayerTag(l.Killer).name, ts: Number(l.Timestamp) || null })),
      joinLogs: log(s.JoinLogs, (l) => ({ player: splitPlayerTag(l.Player).name, join: Boolean(l.Join), ts: Number(l.Timestamp) || null })),
      queue: Array.isArray(s.Queue) ? s.Queue.map(String) : [],
      staff: s.Staff && typeof s.Staff === 'object' ? s.Staff : null,
    };
  }

  function sanitizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      server: sanitizeServerInfo(raw),
      players: (Array.isArray(raw.Players) ? raw.Players : []).map(sanitizePlayer).filter(Boolean),
      vehicles: (Array.isArray(raw.Vehicles) ? raw.Vehicles : []).map(sanitizeVehicle).filter(Boolean),
      emergencyCalls: (Array.isArray(raw.EmergencyCalls) ? raw.EmergencyCalls : []).map(sanitizeEmergencyCall).filter(Boolean),
      admin: sanitizeAdminSnapshot(raw),
    };
  }

  function envelope(type, payload, id) {
    return JSON.stringify({ v: PROTOCOL_VERSION, id: id || null, type, ts: Date.now(), payload: payload || {} });
  }

  function parseEnvelope(data) {
    try {
      const msg = JSON.parse(String(data));
      if (!msg || typeof msg.type !== 'string') return null;
      return msg;
    } catch { return null; }
  }

  /** Commands allowed from the Owner Admin App: in-game ":" or ";" commands only. */
  function validateRemoteCommand(cmd) {
    const c = String(cmd || '').trim();
    if (!c) return { ok: false, error: 'Command is empty.' };
    if (c.length > 120) return { ok: false, error: 'Command is too long (max 120 characters).' };
    if (!/^[:;][a-zA-Z]/.test(c)) return { ok: false, error: 'Commands must start with ":" (e.g. :h, :kick Name) or ";".' };
    if (/[\r\n]/.test(c)) return { ok: false, error: 'Commands must be a single line.' };
    return { ok: true, command: c };
  }

  return {
    PROTOCOL_VERSION, MSG, DUTIES, THEMES, MAP_EXTENT,
    dutyShouldAlert, worldToMap, mapToWorld, splitPlayerTag,
    sanitizePlayer, sanitizeVehicle, sanitizeEmergencyCall,
    sanitizeServerInfo, sanitizeAdminSnapshot, sanitizeSnapshot,
    envelope, parseEnvelope, validateRemoteCommand,
  };
});
