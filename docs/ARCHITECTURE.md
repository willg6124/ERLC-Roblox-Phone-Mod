# Architecture — ER:LC API-Integrated Phone Mod

## The one rule everything follows

> **The ER:LC `Server-Key` exists in exactly one process on one machine: the Server Owner Host. Player phones are credential-free viewers.**

That is not a convention — it is enforced structurally: the player build
(`electron-builder.client.yml`) doesn't even *contain* the `server/` folder,
and the Host broadcasts only whitelisted fields produced by
`shared/protocol.js` sanitizers.

```
┌──────────────────────── SERVER OWNER'S PC ────────────────────────┐
│  ERLC-Host.exe  (apps/host/main.js → server/hostServer.js)        │
│                                                                   │
│   ┌─────────────┐   Server-Key    ┌──────────────────────────┐    │
│   │ Host Manager │──(memory only)─▶│ ErlcClient               │────┼──▶ api.erlc.gg
│   │ UI :3847     │                 │ GET /v2/server?...=true  │    │    /v2/server
│   └─────────────┘                 │ POST /v2/server/command  │    │    (HTTPS)
│        ▲ admin token              └───────────┬──────────────┘    │
│        │ (localhost)                          │ raw API JSON      │
│   ┌────┴──────────────────────────────────────▼──────────────┐    │
│   │ Poller (4s) → sanitizeSnapshot() → diff (new 911 calls)   │    │
│   │ Webhook receiver  POST /webhooks/erlc (Ed25519 verified)  │◀───┼── ER:LC Event
│   └───────────────────────┬──────────────────────────────────┘    │    Webhooks
└───────────────────────────┼───────────────────────────────────────┘
              WebSocket /ws │  6-digit pairing code → role
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
 ┌─────────────┐    ┌─────────────┐      ┌─────────────┐
 │ Player phone │    │ Player phone │      │ Owner phone  │  role=owner
 │ ERLC-Phone-  │    │ (web preview)│      │ + Admin app  │
 │ Overlay.exe  │    └─────────────┘      └─────────────┘
 │ always-on-top│     iOS / Samsung One UI themes (same UI code)
 │ keybind F8   │
 └─────────────┘
```

## Components

| Piece | Path | Runs where | Holds key? |
|---|---|---|---|
| Host core | `server/hostServer.js` | Owner PC | **Yes — memory only** |
| ER:LC API client | `server/erlcClient.js` | Owner PC | Uses it per-request |
| Mock data source | `server/mockErlc.js` | Owner PC | No key needed |
| Webhook verifier | `server/webhook.js` | Owner PC | No (public key only) |
| Host Manager UI | `apps/host/manager.html` | Owner PC browser/Electron | Types it, sends to local Host |
| Host .exe shell | `apps/host/main.js` | Owner PC | Optional OS-encrypted recall |
| Phone UI | `phone/` | Every player PC | **Never** |
| Overlay .exe shell | `apps/client/main.js` | Every player PC | **Never** (loads UI from Host) |
| Shared protocol | `shared/protocol.js` | Both | Defines the only legal wire shapes |

## Data pipelines

### 1. Poll pipeline (primary)
`HostServer.pollOnce()` calls **one** consolidated request —
`GET /v2/server?Players=true&Vehicles=true&EmergencyCalls=true&CommandLogs=true&ModCalls=true&KillLogs=true&JoinLogs=true&Queue=true&Staff=true` —
every `pollMs` (default 4s), then:
1. `sanitizeSnapshot()` whitelists fields (drops `JoinKey`, owner IDs, anything unknown).
2. Diff: previously unseen `CallNumber`s → `emergency:new` broadcast.
3. Broadcast `server:info`, `players:sync`, `vehicles:sync`, `emergency:sync` to all phones.
4. `admin:snapshot` is broadcast **only to `role=owner` sockets**.

One consolidated call per interval keeps the host far from rate limits;
the client retries a `429` once, honouring `Retry-After` (`server/erlcClient.js`).

### 2. Webhook pipeline (instant 911, optional)
Owner pastes `https://<public-host>/webhooks/erlc` into the in-game Event
Webhook setting. The Host verifies Ed25519 over `timestamp + rawBody`
(`server/webhook.js`, ER:LC's published SPKI public key), **only then**
parses JSON, sanitizes the call and broadcasts `emergency:new`. Webhooks
complement polling; they don't replace it (per ER:LC docs).

### 3. Phone → Host → game (owner commands)
Owner phone sends `admin:command` → Host re-checks `client.role === 'owner'`
(server-side, forged messages from player phones are denied + logged) →
`validateRemoteCommand()` → `POST /v2/server/command {"command": "..."}` →
`admin:result` back to that phone → re-poll so logs refresh.

### 4. Phone ↔ phone (no ER:LC involvement)
Chat, photo attachments (client-side compressed, host-capped), dropped
pins, call signalling and RP money transfers are relayed by the Host's
WebSocket hub (`chat:send`, `call:ring`, `transfer:send`…). **Honesty note:**
the ER:LC API exposes no money-transfer or voice endpoints — balances live
on the phone, calls are signalling + UI, and the app says so in-product.

## Pairing & reachability (important, often misunderstood)

A 6-digit code is a **login**, not a network address. Phones must reach the
Host's `http://<host>:3847` — same LAN by default, or the owner's
port-forward / tunnel address for internet play. The Owner code is a
separate 6-digit code shown only in the Host Manager; regenerating codes
invalidates every previously shared one. The Manager REST API itself is
guarded by a random per-boot admin token, and `/api/demo/codes` exists
only when the host is explicitly started with `--demo`.

## Roles

| Capability | Player phone | Owner phone |
|---|---|---|
| 911 feed + duty alerts, Map, Contacts, Messages | ✅ | ✅ |
| Drop/share pins, photos, RP transfers, calls | ✅ | ✅ |
| Command/mod/kill/join logs, queue, staff | ❌ never sent | ✅ |
| Run `:h`, `:kick`, … in-game | ❌ denied on Host | ✅ |

## Scaling notes

State is in-memory (chat = last 200 messages). For a 40-player private
server and a handful of phones this is plenty. If you outgrow it: persist
chat to SQLite behind `HostServer._deliverChat`, add per-phone rate limits
in `_handleMessage`, and put the Host behind a TLS reverse proxy (`wss://`)
— the phone already picks `wss://` automatically on HTTPS pages.
