'use strict';

/**
 * Hidden background renderer: the actual Web Bluetooth transport.
 *
 * Runs with nodeIntegration so it can use ipcRenderer directly. It is a thin
 * GATT proxy — all protocol/history logic lives in the main process (bridge.js).
 * Device selection is handled in main via the 'select-bluetooth-device' event,
 * so requestDevice never shows a chooser popup.
 */
const { ipcRenderer } = require('electron');

const DEVICE_INFO_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const FIRMWARE_REVISION_CHAR = '00002a26-0000-1000-8000-00805f9b34fb';

let cfg = null;
let device = null;
let chars = {}; // dashed uuid -> BluetoothRemoteGATTCharacteristic
let stopping = false;
let reconnectTimer = null;

function send(channel, payload) {
  ipcRenderer.send(channel, payload);
}
function status(state) {
  send('ble:status', { state });
}
function fail(message) {
  send('ble:error', { message: String(message) });
}

/** Entry point invoked by main with a user gesture. */
window.startBle = async function startBle(config) {
  cfg = config;
  stopping = false;
  try {
    status('scanning');
    device = await pickDevice();
    if (!device) return; // pairing cancelled / nothing selected
    device.addEventListener('gattserverdisconnected', onDisconnected);
    await connectGatt();
  } catch (err) {
    if (err && err.name === 'NotFoundError') {
      // User cancelled the picker, or no device was chosen. Stay idle.
      status('idle');
      return;
    }
    fail(`requestDevice/connect failed: ${err.message}`);
    scheduleReconnect();
  }
};

/**
 * Get the target device. If we already know the exact paired device, reconnect
 * to it silently via getDevices() (no chooser, no name dependence). Otherwise
 * scan for all devices; the main process picks by id/name, or forwards the list
 * to the setup screen for the user to choose (pairing).
 */
async function pickDevice() {
  const wanted = cfg.match && cfg.match.peripheralId;
  if (wanted && navigator.bluetooth.getDevices) {
    try {
      const known = await navigator.bluetooth.getDevices();
      const found = known.find((d) => d.id === wanted);
      if (found) return found;
    } catch {
      /* getDevices unsupported/empty — fall back to a scan */
    }
  }
  return navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [cfg.uuids.service, DEVICE_INFO_SERVICE],
  });
}

window.stopBle = function stopBle() {
  stopping = true;
  clearTimeout(reconnectTimer);
  try {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
  } catch {
    /* ignore */
  }
  status('idle');
};

async function connectGatt() {
  if (!device) return;
  status('connecting');
  const server = await device.gatt.connect();

  // Verify this is actually a TimeFlip by the presence of its proprietary
  // service — the one reliable, name-independent signal. If it's missing, this
  // is the wrong device; don't loop trying to talk to it.
  let service;
  try {
    service = await server.getPrimaryService(cfg.uuids.service);
  } catch {
    send('ble:wrong-device', { deviceName: device.name || null, deviceId: device.id });
    try {
      device.gatt.disconnect();
    } catch {
      /* ignore */
    }
    return;
  }

  chars = {};
  for (const uuid of [cfg.uuids.password, cfg.uuids.facet, cfg.uuids.history, cfg.uuids.command, cfg.uuids.commandResult]) {
    try {
      chars[uuid] = await service.getCharacteristic(uuid);
    } catch (err) {
      // command/result chars are optional for core tracking; log and continue.
      send('ble:error', { message: `characteristic ${uuid} unavailable: ${err.message}` });
    }
  }

  // Authenticate: write password (with response) before anything else works.
  status('authenticating');
  await chars[cfg.uuids.password].writeValueWithResponse(Uint8Array.from(cfg.passwordBytes));

  // Subscribe to live facet changes.
  const facetChar = chars[cfg.uuids.facet];
  await facetChar.startNotifications();
  facetChar.addEventListener('characteristicvaluechanged', (e) => {
    const v = e.target.value;
    send('ble:facet', { facet: v.byteLength ? v.getUint8(0) : 0 });
  });

  // Seed current facet + best-effort firmware read.
  let facet = 0;
  try {
    const seed = await facetChar.readValue();
    facet = seed.byteLength ? seed.getUint8(0) : 0;
  } catch {
    /* ignore */
  }
  const firmware = await readFirmware(server);

  status('ready');
  send('ble:ready', { firmware, deviceName: device.name || null, deviceId: device.id, facet });
}

async function readFirmware(server) {
  try {
    const svc = await server.getPrimaryService(DEVICE_INFO_SERVICE);
    const ch = await svc.getCharacteristic(FIRMWARE_REVISION_CHAR);
    const dv = await ch.readValue();
    const str = new TextDecoder().decode(dv).replace(/\0+$/, '').trim();
    const m = str.match(/(\d+\.\d+)/);
    return m ? parseFloat(m[1]) : 0;
  } catch {
    return 0; // device-info service not exposed; not fatal
  }
}

function onDisconnected() {
  send('ble:status', { state: 'disconnected' });
  if (!stopping) scheduleReconnect();
}

function scheduleReconnect() {
  if (stopping) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    // Reconnect to the same device object — no re-selection needed.
    connectGatt().catch((err) => {
      fail(`reconnect failed: ${err.message}`);
      scheduleReconnect();
    });
  }, 3000);
}

// ---- command channel from main (bridge._command) ----
ipcRenderer.on('ble:command', async (_e, { id, type, payload }) => {
  try {
    let result = null;
    if (type === 'gattWriteRead') {
      result = await gattWriteRead(payload);
    } else {
      throw new Error(`unknown ble command: ${type}`);
    }
    ipcRenderer.send('ble:command-result', { id, ok: true, result });
  } catch (err) {
    ipcRenderer.send('ble:command-result', { id, ok: false, error: err.message });
  }
});

async function gattWriteRead({ writeChar, readChar, bytes, withResponse }) {
  const wc = chars[writeChar];
  const rc = chars[readChar];
  if (!wc) throw new Error(`write characteristic ${writeChar} not available`);
  if (!rc) throw new Error(`read characteristic ${readChar} not available`);
  const buf = Uint8Array.from(bytes);
  if (withResponse) await wc.writeValueWithResponse(buf);
  else await wc.writeValueWithoutResponse(buf);
  const dv = await rc.readValue();
  return Array.from(new Uint8Array(dv.buffer.slice(0)));
}
