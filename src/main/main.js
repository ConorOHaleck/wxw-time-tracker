'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

const log = require('./util/logger');
const settingsStore = require('./settings');
const { buildConfig } = require('./config');
const { TABLES, FIELDS, DEVICE_ID_FIELD_NAME } = require('./defaults');
const { Store } = require('./store');
const { AirtableClient } = require('./airtable/client');
const { FaceMapper } = require('./airtable/mapper');
const { BleBridge } = require('./ble/bridge');
const { SyncEngine } = require('./sync/engine');

const APP_NAME = 'WxW Time Tracker';

let mainWindow = null;
let bleWindow = null;
let tray = null;
let engine = null;
let device = null;
let store = null;
let userData = null;
let currentSettings = null;
let lastSnapshot = { connected: false, bleState: 'idle' };

function iconPath() {
  // Packaged into the app via src/** so it resolves both in dev and production.
  return path.join(__dirname, '..', 'assets', 'icon.png');
}
function appIcon() {
  try {
    const img = nativeImage.createFromPath(iconPath());
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

function createWindow() {
  const icon = appIcon();
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    resizable: true,
    title: APP_NAME,
    icon: icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

/**
 * Hidden background window that runs the Web Bluetooth transport.
 * @param {{namePrefix?:string, peripheralId?:string}} bleMatch
 */
function createBleWindow(bleMatch) {
  bleWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const ses = bleWindow.webContents.session;
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler(() => true);

  // Auto-pick the configured device — no chooser popup.
  const seenDevices = new Set();
  bleWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    // Log every newly-seen device so we can confirm the die's advertised name.
    for (const d of devices) {
      if (!seenDevices.has(d.deviceId)) {
        seenDevices.add(d.deviceId);
        log.info('ble: discovered device', `name="${d.deviceName || '(no name)'}"`, 'id=' + d.deviceId);
      }
    }
    const { namePrefix, peripheralId } = bleMatch || {};
    const pick = devices.find((d) => {
      if (peripheralId && d.deviceId === peripheralId) return true;
      const name = (d.deviceName || '').toLowerCase();
      if (namePrefix && name.includes(String(namePrefix).toLowerCase())) return true;
      return !namePrefix && !peripheralId;
    });
    if (pick) {
      log.info('ble: auto-selected', pick.deviceName, pick.deviceId);
      callback(pick.deviceId);
    }
  });

  bleWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ble.html'));
  return bleWindow;
}

function createTray() {
  let icon = appIcon();
  if (icon) icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip(APP_NAME);
  refreshTrayMenu();
  tray.on('click', () => (mainWindow ? mainWindow.show() : createWindow()));
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = lastSnapshot || {};
  const configured = settingsStore.isComplete(currentSettings);
  const statusLine = !configured
    ? 'Setup needed'
    : s.connected
      ? `Connected — face ${s.currentFacet || '-'}${s.tracking ? ' (tracking)' : ''}`
      : `Disconnected (${s.bleState || 'idle'})`;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine, enabled: false },
      { type: 'separator' },
      { label: 'Show window', click: () => (mainWindow ? mainWindow.show() : createWindow()) },
      {
        label: 'Settings…',
        click: () => {
          if (!mainWindow) createWindow();
          mainWindow.show();
          sendToRenderer('show-setup');
        },
      },
      {
        label: 'Reconcile history now',
        enabled: !!engine,
        click: () => engine && engine._reconcile().catch((e) => log.error(e.message)),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---- engine lifecycle (restartable when settings change) ----

async function stopEngine() {
  try {
    if (engine) await engine.stop();
  } catch (e) {
    log.warn('app: engine stop error', e.message);
  }
  try {
    if (device) {
      await device.stop();
      device.dispose();
    }
  } catch (e) {
    log.warn('app: device stop error', e.message);
  }
  if (bleWindow && !bleWindow.isDestroyed()) bleWindow.destroy();
  engine = null;
  device = null;
  bleWindow = null;
}

async function startEngine() {
  await stopEngine();
  const cfg = buildConfig(currentSettings);
  if (!store) store = new Store(path.join(userData, 'state.json'));

  const airtable = new AirtableClient(cfg.airtable);
  let mapper;
  try {
    mapper = await new FaceMapper(airtable, cfg).load();
  } catch (err) {
    log.error('app: airtable/mapper error', err.message);
    sendToRenderer('fatal', `Couldn't load your setup from Airtable: ${err.message}`);
    return { ok: false, error: err.message };
  }

  device = new BleBridge({ bleMatch: cfg.device.bleMatch, password: cfg.device.password });
  engine = new SyncEngine({ device, mapper, store, airtable, cfg });
  engine.on('update', (snapshot) => {
    lastSnapshot = snapshot;
    sendToRenderer('snapshot', snapshot);
    refreshTrayMenu();
  });

  createBleWindow(cfg.device.bleMatch);
  device.attachWindow(bleWindow);
  engine.start();
  bleWindow.webContents.once('did-finish-load', () => {
    log.info('app: BLE window loaded, starting scan');
    device.start();
  });

  sendToRenderer('snapshot', engine.snapshot());
  refreshTrayMenu();
  return { ok: true };
}

async function init() {
  userData = app.getPath('userData');
  log.init(path.join(userData, 'logs'));
  log.info('app: starting', APP_NAME, 'userData =', userData);

  currentSettings = settingsStore.load(userData);
  if (settingsStore.isComplete(currentSettings)) {
    await startEngine();
  } else {
    log.info('app: not configured yet — showing setup');
    sendToRenderer('show-setup');
  }
}

// ---- IPC: status ----
ipcMain.handle('app:get-state', () => ({
  configured: settingsStore.isComplete(currentSettings),
  settings: currentSettings || settingsStore.DEFAULTS,
  snapshot: engine ? engine.snapshot() : lastSnapshot,
}));
ipcMain.handle('get-snapshot', () => (engine ? engine.snapshot() : lastSnapshot));
ipcMain.handle('reconcile-now', async () => {
  if (engine) await engine._reconcile();
  return engine ? engine.snapshot() : lastSnapshot;
});

// ---- IPC: setup ----

// Verify a token and list the TimeFlip devices/people to choose from.
ipcMain.handle('settings:test', async (_e, { token }) => {
  if (!token) return { ok: false, error: 'Enter your Airtable token first.' };
  try {
    const at = new AirtableClient({ token, baseId: require('./defaults').BASE_ID });
    const records = await at.listRecords(TABLES.timeflip, { maxRecords: 100 });
    const devices = records.map((r) => {
      const deviceId = r.fields[FIELDS.timeflip.deviceId] || '';
      const users = r.fields[FIELDS.timeflip.airtableUserFromAssignee];
      let who = 'Unassigned';
      if (Array.isArray(users) && users.length) who = users[0].name || users[0].email || who;
      const label = `${who}${deviceId ? `  ·  ${deviceId}` : '  ·  (no Device ID set)'}`;
      return { recordId: r.id, label, deviceId };
    });
    return { ok: true, devices };
  } catch (err) {
    const msg = /401|AUTHENTICATION/i.test(err.message)
      ? 'That token was rejected. Check it has read+write access to the WxW Delivery base.'
      : err.message;
    return { ok: false, error: msg };
  }
});

ipcMain.handle('settings:get', () => currentSettings || settingsStore.DEFAULTS);

ipcMain.handle('open-external', (_e, url) => {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('settings:save', async (_e, incoming) => {
  try {
    currentSettings = settingsStore.save(userData, { ...currentSettings, ...incoming });
  } catch (err) {
    return { ok: false, error: `Couldn't save settings: ${err.message}` };
  }
  if (!settingsStore.isComplete(currentSettings)) {
    return { ok: false, error: 'Please enter a token and choose your device.' };
  }
  const res = await startEngine();
  return res;
});

// ---- app lifecycle ----
app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.whatbywhen.wxw-time-tracker');
  createWindow();
  createTray();
  init().catch((err) => {
    log.error('app: init crashed', err.stack || err.message);
    sendToRenderer('fatal', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Boot smoke test: launch, run startup, then quit. Set TIMEFLIP_SMOKE=1.
  if (process.env.TIMEFLIP_SMOKE) {
    setTimeout(() => {
      log.info('smoke: auto-quit');
      app.isQuitting = true;
      app.quit();
    }, 4000);
  }
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  try {
    await stopEngine();
  } catch (err) {
    log.warn('app: shutdown error', err.message);
  }
});
