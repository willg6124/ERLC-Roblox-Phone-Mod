# WebSocket Schema — Host ⇄ Phone

Transport: `ws://<host>:3847/ws` (`wss://` when the Host sits behind HTTPS).
Every frame is one JSON envelope; unknown `type`s are ignored, so the
protocol can grow without breaking old phones.

```jsonc
{ "v": 1, "id": null, "type": "<type>", "ts": 1760000000000, "payload": { } }
```

The **first** frame a phone sends must be `session:join`; anything else
closes the socket. Payload objects below omit the envelope for brevity.

## Client → Host

| Type | Payload | Notes |
|---|---|---|
| `session:join` | `{code:"123456", name:"RobloxName", duty:"Police"}` | `code` = player code → `role:"player"`; owner code → `role:"owner"`. `duty` ∈ Police/Fire/EMS/Civilian |
| `chat:send` | `{to:"lobby"\|"<username>", text?, image?, pin?}` | `image` = `data:image/…` ≤ ~700 KB; `pin={x,z,label?}` game coords |
| `chat:pin` | `{to, pin}` | Shortcut for pin-only messages |
| `call:ring` / `call:accept` / `call:end` | `{to:"<username>"}` | Signalling only (no ER:LC voice API exists) |
| `transfer:send` | `{to, amount, note?}` | Phone-RP balance only (no ER:LC money API exists) |
| `emergency:ack` | `{callNumber:412}` | "I'm responding" |
| `admin:command` | `{command:":h …"}` | **Owner role only — re-checked on the Host** |
| `admin:refresh` | `{}` | Owner only; re-sends `admin:snapshot` |

## Host → Client

| Type | Payload | Audience |
|---|---|---|
| `session:welcome` | `{role, you, duty, server:{name,currentPlayers,maxPlayers,teamBalance}, source:"live"\|"mock"}` | the joining phone |
| `session:error` | `{message}` | the offending phone |
| `server:info` | `{server}` (sanitized; **no JoinKey**) | all |
| `players:sync` | `{players:[{name,id,team,callsign,permission,wantedStars,location:{x,z,postal,street,building}\|null}]}` | all |
| `vehicles:sync` | `{vehicles:[{name,owner,plate,color,location:{x,z}\|null}]}` | all |
| `emergency:sync` | `{calls:[call]}` full current feed | all |
| `emergency:new` | `{call}` one brand-new 911 call | all (phones self-filter the pop-up by duty) |
| `emergency:acked` | `{callNumber, by}` | all |
| `chat:message` | `{id, from, to, text?, image?, pin?, ts}` | lobby → all; DM → sender + recipient only |
| `chat:history` | `{messages:[…last 60 relevant]}` | joining phone |
| `call:incoming` | `{from}` | callee |
| `call:state` | `{from, state:"accepted"\|"ended"}` | caller/callee |
| `transfer:new` | `{from,to,amount,note?,ts}` | sender + recipient |
| `admin:snapshot` | `{commandLogs:[{player,command,ts}], modCalls:[{caller,moderator,ts}], killLogs:[{killed,killer,ts}], joinLogs:[{player,join,ts}], queue:[…], staff}` | **owner role only** |
| `admin:result` | `{command, ok, message}` | requesting owner phone |
| `presence` | `{phones:[{name,role,duty}]}` | all (Manager mirrors this via REST) |
| `host:notice` | `{message}` | all / owner (context) |

`call` (emergency) shape: `{callNumber, team, callerName, callerId, description,
descriptor, position:{x,z}|null, startedAt, responders:[names]}`.

## Guarantees

- Nothing in any frame contains the Server-Key, a Global Token, the server
  JoinKey, or owner Roblox IDs — enforced by whitelist sanitizers +
  asserted in `test/hostServer.test.js`.
- Chat/DM routing is enforced on the Host; a phone cannot read DMs it is
  not party to by asking nicely.
- Frames > 1 MB are dropped by the transport (`maxPayload`).
