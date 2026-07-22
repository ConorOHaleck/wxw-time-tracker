'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge — no Node access leaks into the renderer.
contextBridge.exposeInMainWorld('timeflip', {
  // status
  getState: () => ipcRenderer.invoke('app:get-state'),
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  reconcileNow: () => ipcRenderer.invoke('reconcile-now'),
  resyncFaces: () => ipcRenderer.invoke('resync-faces'),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, data) => cb(data)),
  onFatal: (cb) => ipcRenderer.on('fatal', (_e, msg) => cb(msg)),
  onShowSetup: (cb) => ipcRenderer.on('show-setup', () => cb()),

  // setup
  getSettings: () => ipcRenderer.invoke('settings:get'),
  testConnection: (token) => ipcRenderer.invoke('settings:test', { token }),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // device pairing
  listDevices: () => ipcRenderer.invoke('ble:list-devices'),
  chooseDevice: (deviceId) => ipcRenderer.invoke('ble:choose-device', { deviceId }),
  cancelPairing: () => ipcRenderer.invoke('ble:cancel-pairing'),
  forgetDevice: () => ipcRenderer.invoke('ble:forget-device'),
  onDevices: (cb) => ipcRenderer.on('ble-devices', (_e, list) => cb(list)),
  onPaired: (cb) => ipcRenderer.on('ble-paired', (_e, d) => cb(d)),
  onWrongDevice: (cb) => ipcRenderer.on('ble-wrong-device', (_e, d) => cb(d)),
});
