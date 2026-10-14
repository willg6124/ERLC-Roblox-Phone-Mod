# ER:LC Private Server API v2 — How This App Uses It

Base: `https://api.erlc.gg` · Docs: https://apidocs.erlc.gg · Host-only.

| Need | Call | Used by |
|---|---|---|
| Validate key / server info | `GET /v2/server` | Manager "Validate & start" (`ErlcClient.validateKey`) |
| **Everything, per poll** | `GET /v2/server?Players=true&Vehicles=true&EmergencyCalls=true&CommandLogs=true&ModCalls=true&KillLogs=true&JoinLogs=true&Queue=true&Staff=true` | Poller — one consolidated call per interval |
| Players (focused) | `GET /v2/server/players` | `ErlcClient.getPlayers()` (debug/alternate) |
| Vehicles | `GET /v2/server/vehicles` | `getVehicles()` |
| 911 calls | `GET /v2/server/emergencycalls` | `getEmergencyCalls()` |
| Command / mod / kill logs | `GET /v2/server/commandlogs` · `/modcalls` · `/killlogs` | Admin app data (owner-scoped) |
| Run in-game command | `POST /v2/server/command` body `{"command":":h …"}` | Owner Admin app (Host re-checks role first) |
| Instant events | Event Webhooks → `POST /webhooks/erlc` (Ed25519) | New 911 calls / `;` custom commands |

Auth headers (Host → ER:LC only): `Server-Key: <key>` always;
`Authorization: <Global App Token>` only for registered public apps.

## Real payload shapes this app is built against

- **Player:** `{"Player":"Name:Id","Team":"Sheriff","Callsign":"2S-40",
  "Permission":"Normal","WantedStars":0,"Location":{"LocationX":1084.9,
  "LocationZ":2302.2,"PostalCode":"218","StreetName":"Park Street",…}}`
  → sanitized to `{name,id,team,callsign,permission,wantedStars,location:{x,z,postal,street}}`.
- **EmergencyCall:** `{"Team":"Police","Caller":168691872,"Position":[-654.6,666.5],
  "StartedAt":…,"CallNumber":400,"Description":"…","PositionDescriptor":"…"}`
  → `{callNumber,team,callerId,description,descriptor,position:{x,z},startedAt,responders}`.
- **Vehicle:** `{"Name":"Redline Fire Engine","Owner":"…","Plate":"…","ColorHex":"#ff4444"}`
  — note the stock payload may carry **no live coordinates**; when absent the
  Map app lists the vehicle without plotting it (players always have coords).

## What the API does *not* provide (and this app doesn't fake)

- ❌ Money balances/transfers → the phone's transfer feature is RP bookkeeping between phones.
- ❌ Voice calls → the phone's call UI is signalling between phones; use Discord/in-game voice to talk.
- ❌ A player-facing credential — there is no safe way to give players API
  access, which is exactly why the Host-proxy architecture exists.
