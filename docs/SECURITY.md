# Security Model

## The credential rule

The ER:LC **Server-Key grants co-owner-level power** over a private server.
Treating it like a password is the entire design constraint:

| Where the key may exist | Where it must never exist |
|---|---|
| Host process memory (`ErlcClient`, `server/erlcClient.js`) | Player Client `.exe` (not even compiled in) |
| Owner's typing into the local Host Manager | Any WebSocket frame, log line, or error message |
| OS-encrypted local file (Electron `safeStorage`, opt-in) | Git, `.env` committed to a repo, screenshots, Discord |

Concretely, in this repo:

1. `server/` (the only code that builds `Server-Key` headers) is **excluded
   from the player build** in `electron-builder.client.yml`.
2. The phone UI (`phone/`) contains no key field at all — there is nowhere
   to paste one, so support scams ("enter your server key to get the mod")
   have nothing to phish into *this* app.
3. Everything leaving the Host passes **whitelist** sanitizers
   (`shared/protocol.js`): fields are copied one-by-one, so a future ER:LC
   field can't leak by accident. This deliberately strips the server
   **JoinKey** and owner/co-owner Roblox IDs from `server:info`.
4. `test/hostServer.test.js` asserts on the raw wire that no
   credential-shaped string or mock JoinKey ever reaches a phone.
5. `ErlcClient.keyHint()` exposes only `••••-<last 4 of the public segment>`
   for the Manager UI; the key is never logged in full.

## Roles are enforced on the Host, not trusted from the phone

A modified player client can *send* `admin:command`, but `HostServer`
checks the role bound to that socket at `session:join` time (derived from
which code was used) and denies + logs it. `admin:snapshot` is never even
transmitted to player sockets. Hiding the Admin app in the UI is cosmetics;
the Host check is the security boundary.

## Pairing codes

- Two independent 6-digit codes (players / owner), `crypto.randomInt`-generated.
- Regenerating in the Manager invalidates old codes immediately.
- Codes are **not** a substitute for network reachability or TLS: on the
  open internet, run the Host behind HTTPS (`wss://`) so codes and chat
  aren't sniffable, and expect the codes to be shareable secrets within
  your community — rotate them per session if that matters to you.
- The Manager REST API requires a random per-boot `x-host-admin` token;
  `/api/demo/codes` (preview convenience) is off unless `--demo`/`DEMO_MODE=1`.

## Webhooks

`/webhooks/erlc` verifies Ed25519 (`timestamp + raw body`) against ER:LC's
published public key **before parsing**, returns 401 otherwise, and uses
the raw bytes exactly as received (never re-serialised JSON) — the classic
webhook-verification footguns are covered in `server/webhook.js`.

## If a key ever does leak

Rotate it in-game (Settings → ER:LC API), restart the Host with the new
key, and regenerate pairing codes. Player phones need no update — by
design, they never had anything to rotate.
