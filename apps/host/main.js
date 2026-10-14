'use strict';
/**
 * apps/host/main.js — Server Owner Host (.exe Server Manager), Electron main.
 *
 * Starts the Host core (server/hostServer.js) in-process, then opens the
 * Manager UI with the one-time admin token injected into the URL fragment.
 * The ER:LC Server-Key the owner types into the Manager is held ONLY in
 * this process's memory (optionally sealed with Electron safeStorage into
 * an encrypted local file if the owner ticks "remember") — it is never
 * written to the phone, the repo, logs, or any client.
 *
 * Build:  npm run dist:host   ->  release-host/ERLC-Host.exe
 */
const { app, BrowserWindow, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { HostServer } = require('../../server/hostServer');

let host = null;

function secretsFile() { return path.join(app.getPath('userData'), 'host-secrets.bin'); }
function rememberSecrets(serverKey, globalToken) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const sealed = safeStorage.encryptString(JSON.stringify({ serverKey, globalToken }));
    fs.writeFileSync(secretsFile(), sealed);
    return true;
  } catch { return false; }
}
function recallSecrets() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(secretsFile())) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(secretsFile())));
  } catch { return null; }
}

async function start() {
  host = new HostServer({ port: Number(process.env.HOST_PORT || 3847) });
  await host.start();

  const win = new BrowserWindow({
    width: 1060, height: 780, title: 'ER:LC Phone — Server Owner Host',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Fragment (#) keeps the token out of server access logs / history files.
  win.loadURL(`http://localhost:${host.port}/manager#admin=${host.adminToken}`);

  // Auto-resume a remembered key (decrypted locally, this machine only).
  const saved = recallSecrets();
  if (saved?.serverKey) {
    try { await host.configureSource(saved); console.log('[host] Resumed saved Server-Key from encrypted local storage.'); }
    catch (e) { console.log(`[host] Saved key no longer valid (${e.message}); waiting for the owner to re-enter it.`); }
  } else {
    await host.configureSource({ mock: true }); // usable instantly; owner can switch to Live in the Manager
  }

}

app.whenReady().then(start);
app.on('window-all-closed', async () => { await host?.stop(); app.quit(); });
