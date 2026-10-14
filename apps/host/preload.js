'use strict';
/** Host Manager preload: lets the Manager ask Electron to seal the Server-Key
 *  with OS encryption (safeStorage) on THIS machine only. The key still never
 *  leaves the Host process/machine and is never sent to a phone. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hostAPI', {
  rememberSecrets: (serverKey, globalToken) => ipcRenderer.invoke('host:remember-secrets', { serverKey, globalToken }),
  forgetSecrets: () => ipcRenderer.invoke('host:forget-secrets'),
});
