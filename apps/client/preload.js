'use strict';
/** Preload: the ONLY bridge between the phone UI and Electron. No Node,
 *  no filesystem, no credentials — just keybind/window controls. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlayAPI', {
  setKeybind: (accelerator) => ipcRenderer.invoke('overlay:set-keybind', accelerator),
  getSettings: () => ipcRenderer.invoke('overlay:get-settings'),
  hide: () => ipcRenderer.invoke('overlay:hide'),
});
