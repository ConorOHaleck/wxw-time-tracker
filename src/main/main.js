'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

const log = require('./util/logger');
const settingsStore = require('./settings');
const { buildConfig } = require('./config');
const { TABLES, FIELDS } = require('./defaults');
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

// BLE device selection state.
let bleMatch = {}; // { namePrefix, peripheralId } — mutated when a device is learned
let blePairing = { active: false, callback: null }; // manual "choose device" session
const discoveredDevices = new Map(); // deviceId -> advertised name (for the picker)

function devicesList() {
  return Array.from(discoveredDevices, ([id, name]) => ({ id, name }));
}

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
 * Selection is driven here via the 'select-bluetooth-device' event and the
 * module-level `bleMatch` / `blePairing` state.
 */
function createBleWindow() {
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

  discoveredDevices.clear();
  bleWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();

    // Track everything we see and stream it to the setup UI's device picker.
    let changed = false;
    for (const d of devices) {
      if (!discoveredDevices.has(d.deviceId)) {
        discoveredDevices.set(d.deviceId, d.deviceName || '');
        log.info('ble: discovered device', `name="${d.deviceName || '(no name)'}"`, 'id=' + d.deviceId);
        changed = true;
      }
    }
    if (changed) sendToRenderer('ble-devices', devicesList());

    // Manual pairing: wait for the user to choose from the list.
    if (blePairing.active) {
      blePairing.callback = callback;
      return;
    }

    // Auto mode: connect to the exact paired device (by id) or, if we don't have
    // one yet, the first device whose name matches the prefix. Never pick an
    // unrelated device — if nothing matches, keep scanning.
    const { namePrefix, peripheralId } = bleMatch || {};
    const pick = devices.find((d) => {
      if (peripheralId && d.deviceId === peripheralId) return true;
      const name = (d.deviceName || '').toLowerCase();
      return namePrefix && name.includes(String(namePrefix).toLowerCase());
    });
    if (pick) {
      log.info('ble: auto-selected', pick.deviceName, pick.deviceId);
      callback(pick.deviceId);
    }
  });

  bleWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ble.html'));
  return bleWindow;
}

/** Remember the exact device we connected to, so future launches are seamless. */
function learnDevice(deviceId, deviceName) {
  if (!deviceId) return;
  bleMatch.peripheralId = deviceId;
  if (currentSettings.bleDeviceId !== deviceId) {
    currentSettings = settingsStore.save(userData, {
      ...currentSettings,
      bleDeviceId: deviceId,
      bleDeviceName: deviceName || currentSettings.bleDeviceName,
    });
    log.info('app: paired/learned device', deviceName || '(unnamed)', deviceId);
  }
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

  bleMatch = cfg.device.bleMatch; // module ref; mutated by learnDevice()
  device = new BleBridge({ bleMatch, password: cfg.device.password });
  engine = new SyncEngine({ device, mapper, store, airtable, cfg });
  engine.on('update', (snapshot) => {
    lastSnapshot = snapshot;
    sendToRenderer('snapshot', snapshot);
    refreshTrayMenu();
  });
  device.on('ready', ({ deviceId, deviceName }) => {
    blePairing.active = false;
    learnDevice(deviceId, deviceName);
    sendToRenderer('ble-paired', { deviceId, deviceName });
  });
  device.on('wrong-device', ({ deviceName }) => {
    // Manually-picked device isn't a TimeFlip — drop it and re-scan so the user
    // can pick again (a fresh scan is needed since the previous one resolved).
    bleMatch.peripheralId = currentSettings.bleDeviceId || '';
    blePairing.active = true;
    sendToRenderer('ble-wrong-device', { deviceName });
    if (device) device.start();
  });

  createBleWindow();
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

// Re-read the face setup from Airtable without restarting the app.
ipcMain.handle('resync-faces', async () => {
  if (!engine) return { ok: false, error: 'Not connected yet — finish setup first.' };
  try {
    const snapshot = await engine.refreshMapping();
    return { ok: true, snapshot };
  } catch (err) {
    log.error('app: resync faces failed', err.message);
    return { ok: false, error: `Couldn't reload from Airtable: ${err.message}` };
  }
});

// ---- IPC: device pairing ----

// Enter manual "choose device" mode and return what we've discovered so far.
// The list also streams live via the 'ble-devices' event as more appear.
ipcMain.handle('ble:list-devices', () => {
  blePairing.active = true;
  return devicesList();
});

// The user picked a device from the list — connect to that exact one.
ipcMain.handle('ble:choose-device', (_e, { deviceId }) => {
  if (!blePairing.callback) {
    return {
      ok: false,
      error: 'The scan isn’t active. If the app is already connected, use “Forget device” first.',
    };
  }
  const cb = blePairing.callback;
  blePairing.callback = null;
  blePairing.active = false;
  bleMatch.peripheralId = deviceId; // connect to this one; persisted on ready
  cb(deviceId);
  return { ok: true };
});

// Close the picker without choosing — resume automatic connection.
ipcMain.handle('ble:cancel-pairing', () => {
  blePairing.active = false;
  return { ok: true };
});

// Forget the paired device and re-scan from scratch (for switching devices).
ipcMain.handle('ble:forget-device', async () => {
  currentSettings = settingsStore.save(userData, {
    ...currentSettings,
    bleDeviceId: '',
    bleDeviceName: '',
  });
  blePairing.active = true; // the fresh scan will wait for a manual pick
  await startEngine();
  return { ok: true };
});

// ---- IPC: setup ----

// Verify a token and list the TimeFlip devices/people to choose from.
ipcMain.handle('settings:test', async (_e, { token }) => {
  if (!token) return { ok: false, error: 'Enter your Airtable token first.' };
  try {
    const at = new AirtableClient({ token, baseId: require('./defaults').BASE_ID });

    // Who owns this token? Used to resolve your device automatically.
    let meId = null;
    let meEmail = null;
    try {
      const me = await at.whoami();
      meId = (me && me.id) || null;
      meEmail = (me && me.email) || null;
    } catch (err) {
      log.warn('app: whoami failed during connection test:', err.message);
    }

    const records = await at.listRecords(TABLES.timeflip, { maxRecords: 100 });
    const devices = records.map((r) => {
      const users = r.fields[FIELDS.timeflip.airtableUserFromAssignee];
      let who = 'Unassigned TimeFlip';
      let assigneeUserId = null;
      if (Array.isArray(users) && users.length) {
        who = users[0].name || users[0].email || who;
        assigneeUserId = users[0].id || null;
      }
      const isYou = !!(meId && assigneeUserId && assigneeUserId === meId);
      return { recordId: r.id, who, label: isYou ? `${who}  (you)` : who, isYou };
    });

    // Which record is "yours"? Exactly one match means no picking required.
    const mine = devices.filter((d) => d.isYou);
    return {
      ok: true,
      devices,
      identified: !!meId,
      meName: (mine[0] && mine[0].who) || meEmail || null,
      matchCount: mine.length,
      autoRecordId: mine.length === 1 ? mine[0].recordId : null,
    };
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
