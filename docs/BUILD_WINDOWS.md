# Building the Two Windows `.exe`s

Prereqs: Node.js 18+ on the build machine. `npm install` once at repo root.

## 1 · Server Owner Host → `ERLC-Host-Setup-<version>.exe`

```powershell
npm run dist:host        # electron-builder.host.yml
# output: release-host\
```

Run it on the **server owner's PC only**. It starts the Host on port 3847
(override with `HOST_PORT`), opens the Manager, and — until a key is
entered — runs in Mock Mode so the owner can test phones immediately.

Headless alternative (no Electron): `node server/index.js --live` with
`ERLC_SERVER_KEY` set in that shell's environment.

## 2 · Player Overlay → `ERLC-Phone-Overlay-Setup-<version>.exe`

```powershell
npm run dist:client      # electron-builder.client.yml
# output: release-client\
```

Give this to players. It contains **no `server/` code and no credentials**
(verify: the `files:` list in `electron-builder.client.yml`). On launch it
loads the phone UI from the Host (`ERLC_PHONE_URL`, default
`http://localhost:3847/` — players on other PCs point it at the owner's
reachable host address, e.g. set the env var or rebuild with their URL).

Dev run without packaging: `npm run client` (Electron) or just open
`http://<host>:3847/` in a browser — same UI.

## Overlay behaviour (Player Client)

- Frameless, transparent, always-on-top (`screen-saver` level), tray icon.
- Global keybind toggles visibility — default `F8`, changeable in
  Phone → Settings → Overlay (re-registered live via IPC;
  Electron accelerator syntax, e.g. `CommandOrControl+Shift+P`).
- Closing the window keeps the tray app alive; Quit from the tray menu.

## Trying the whole thing with zero setup (Mock Mode)

```bash
npm install
npm run host:web         # http://localhost:3847  (host + phone + manager)
```

Open the phone, use the on-screen demo codes (player + owner), username
`willg6124`. In production the codes are only in the Host Manager —
`/api/demo/codes` is a `--demo`-only convenience and is off by default.
