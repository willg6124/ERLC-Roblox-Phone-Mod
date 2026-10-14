# ER:LC Roblox Phone Mod 📱🚓

A dual-interface (**iOS / Samsung One UI**) desktop smartphone overlay for
**Emergency Response: Liberty County (ER:LC)** private servers, driven by
live data from the official **ER:LC Private Server API v2** — real 911 calls,
live GPS positions, your actual in-server player list — plus phone-to-phone
messaging, photo/pin sharing, and an owner-only in-phone Admin app.

> **The security rule this whole project is built around:** the owner's
> ER:LC `Server-Key` lives **only** in the Server Owner Host process. The
> player app contains no key, never talks to `api.erlc.gg`, and receives
> only whitelisted, filtered game data over WebSocket. See
> [`docs/SECURITY.md`](docs/SECURITY.md).

![architecture](docs/ARCHITECTURE.md)

## How it works (30 seconds)

| Who | Runs | Does |
|---|---|---|
| **Server Owner** | `ERLC-Host.exe` (or `node server/index.js --live`) | Pastes in the ER:LC Server Key **once, on their PC**, validates it, and gets **two 6-digit codes** |
| **Players** | `ERLC-Phone-Overlay.exe` (or a browser tab) | Enter the 6-digit player code + their Roblox name, pick iOS or Samsung, pick a duty — phone goes live |
| **Owner on their phone** | Same overlay, **Owner code** | Everything players get, **plus** the Admin app (logs, mod calls, remote `:h` / `:kick` / … commands) |

## Phone apps

- **🚨 911 Dispatch** — live feed from `/v2/server` `EmergencyCalls` (+ instant
  Ed25519-verified Event Webhooks). Phones on matching duty (Police/Fire/EMS)
  get a pop-up banner; tap **Respond** or plot the call on the map.
- **🗺️ GPS Map** — players plotted live from `LocationX`/`LocationZ`, vehicle
  dots when coordinates exist, pulsing 911 markers, drop-a-pin → share into chat.
- **👥 Contacts** — auto-synced from `/v2/server/players` with team, callsign,
  postal/street, wanted stars. Message, call, or send RP money in one tap.
- **💬 Messages** — server lobby + DMs, photo attachments (compressed on-phone),
  location pins that open straight in the Map app.
- **🛡️ Admin (Owner code only)** — server stats, mod-call queue, command/kill/
  join logs, and remote server management via `POST /v2/server/command`.
  Role is re-checked on the Host; player phones never even receive this data.
- **⚙️ Settings** — instant iOS ⇄ Samsung One UI switch, overlay keybind
  (default `F8`), session/role/source at a glance.

## Quick start

```bash
npm install
npm run host:web          # Mock Mode demo — no ER:LC key needed
# → phone:   http://localhost:3847/
# → manager: http://localhost:3847/manager
```

The web preview runs the **real** stack (Host + WebSocket + phone) against a
simulated live server, so you can try both pairing codes, both themes, duty
alerts, the map, messaging and the owner Admin app before touching a real key.

**Live mode (owner):** build/run the Host (`docs/BUILD_WINDOWS.md`), paste
your Server Key into the Host Manager (in-game: Settings → ER:LC API), hand
players the 6-digit code. Headless: `ERLC_SERVER_KEY=… node server/index.js --live`.

## Build the `.exe`s (Windows)

```bash
npm run dist:host     # release-host/ERLC-Host-Setup-*.exe        (owner only)
npm run dist:client   # release-client/ERLC-Phone-Overlay-*.exe   (give to players)
```

The overlay is frameless, always-on-top, tray-resident, and toggled by a
customizable global keybind. Full instructions: [`docs/BUILD_WINDOWS.md`](docs/BUILD_WINDOWS.md).

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design & data pipelines
- [`docs/WEBSOCKET_SCHEMA.md`](docs/WEBSOCKET_SCHEMA.md) — every Host ⇄ Phone message
- [`docs/ERLC_API.md`](docs/ERLC_API.md) — endpoints, real payload shapes, API limits
- [`docs/SECURITY.md`](docs/SECURITY.md) — credential handling, roles, pairing, webhooks

## Honest limitations

- A pairing code is a login, not an address: players must reach the Host
  (same LAN, or the owner's forwarded/tunneled address). Use `wss://`/HTTPS
  on the open internet.
- The ER:LC API has **no money or voice endpoints** — in-phone transfers are
  RP bookkeeping between phones and calls are phone-to-phone signalling;
  the app says so in-product rather than pretending.
- Polling is 4s by default (one consolidated API call); webhooks make 911
  effectively instant when configured.

## Tests

```bash
npm test   # sanitizers, coordinate math, pairing roles, owner-only admin,
           # chat/pin relay, webhook verification, and the wire-level
           # "no secrets ever reach a phone" assertion
```

*Not affiliated with Police Roleplay Community or Roblox. ER:LC API access
requires the server's ERLC API pack; your Server Key is yours — this app is
designed so you never have to share it.*
