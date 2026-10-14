'use strict';
/**
 * apps/client/main.js — Player Client (.exe Overlay), Electron main process.
 *
 * A frameless, transparent, always-on-top phone that toggles with a global
 * keybind while you play ER:LC. It contains NO ER:LC Server-Key and never
 * talks to api.erlc.gg — only to the Server Owner Host over WebSocket.
 *
 * Build:  npm run dist:client   ->  release-client/ERLC-Phone-Overlay.exe
 * Run:    npm run client          (dev; set ERLC_PHONE_URL to a running Host)
 */
const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = process.env.ERLC_PHONE_URL || 'http://localhost:3847/';
let win = null; let tray = null; let visible = true;
let settings = { keybind: 'F8' };

function settingsFile() { return path.join(app.getPath('userData'), 'phone-settings.json'); }
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* noop */ } }

function registerKeybind(accelerator) {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(accelerator, toggle);
  if (ok) { settings.keybind = accelerator; saveSettings(); }
  return ok;
}
function toggle() {
  if (!win) return;
  visible = !visible;
  if (visible) { win.show(); win.focus(); } else win.hide();
}

function createWindow() {
  win = new BrowserWindow({
    width: 404, height: 824, show: true, frame: false, transparent: true,
    resizable: false, alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // stays above fullscreen-ish game windows
  win.setVisibleOnAllWorkspaces(true);
  win.loadURL(DEFAULT_URL);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  registerKeybind(settings.keybind || 'F8');
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip(`ER:LC Phone Overlay (${settings.keybind} to show/hide)`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide phone', click: toggle },
    { label: 'Reload', click: () => win?.reload() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', toggle);

  ipcMain.handle('overlay:set-keybind', (_e, accelerator) => ({ ok: registerKeybind(String(accelerator || 'F8')) }));
  ipcMain.handle('overlay:get-settings', () => ({ ...settings }));
  ipcMain.handle('overlay:hide', () => { visible = false; win?.hide(); return { ok: true }; });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault()); // tray app: closing the phone must not kill the overlay
