'use strict';

const EventEmitter = require('events');
const { ipcMain } = require('electron');
const proto = require('./protocol');
const log = require('../util/logger');

/**
 * BLE transport over Electron's built-in Web Bluetooth, exposing the same
 * interface the SyncEngine expects from a device:
 *
 *   events: 'status' {state}, 'facet' {facet}, 'ready' {firmware, deviceName}, 'error'
 *   props:  lastFacet
 *   methods: start(), stop(), readHistory(startEvent, opts), getLastEventNumber(opts)
 *
 * The actual GATT work runs in a hidden renderer (renderer/ble.js). This class
 * is a thin proxy: it forwards low-level write/read primitives to that renderer
 * and keeps all protocol logic (history paging, decoding) here in the main
 * process, reusing protocol.js unchanged.
 */
class BleBridge extends EventEmitter {
  constructor({ bleMatch = {}, password = '000000' } = {}) {
    super();
    this.bleMatch = bleMatch;
    this.password = password;
    this.lastFacet = 0;
    this.state = 'idle';

    this.win = null; // the hidden BLE BrowserWindow
    this._pending = new Map(); // commandId -> { resolve, reject }
    this._cmdId = 0;

    // Dashed UUIDs for Web Bluetooth.
    this.uuids = {
      service: proto.toDashed(proto.SERVICE_UUID),
      password: proto.toDashed(proto.CHARACTERISTICS.PASSWORD),
      facet: proto.toDashed(proto.CHARACTERISTICS.FACET),
      history: proto.toDashed(proto.CHARACTERISTICS.HISTORY),
      command: proto.toDashed(proto.CHARACTERISTICS.COMMAND),
      commandResult: proto.toDashed(proto.CHARACTERISTICS.COMMAND_RESULT),
    };

    this._wireIpc();
  }

  /** Attach the hidden renderer window that runs the Web Bluetooth code. */
  attachWindow(win) {
    this.win = win;
  }

  _wireIpc() {
    ipcMain.on('ble:status', (_e, { state }) => {
      this.state = state;
      if (state === 'ready') {
        // handled by 'ble:ready'
      }
      log.info('ble: state ->', state);
      this.emit('status', { state });
    });

    ipcMain.on('ble:ready', (_e, { firmware, deviceName, deviceId, facet }) => {
      this.firmware = firmware || 0;
      this.deviceName = deviceName || null;
      this.deviceId = deviceId || null;
      this.lastFacet = facet || 0;
      this.state = 'ready';
      log.info(
        'ble: ready, firmware', this.firmware, 'name', this.deviceName, 'id', this.deviceId,
        'facet', this.lastFacet
      );
      this.emit('ready', {
        firmware: this.firmware,
        deviceName: this.deviceName,
        deviceId: this.deviceId,
      });
      if (this.lastFacet > 0) this.emit('facet', { facet: this.lastFacet });
    });

    ipcMain.on('ble:wrong-device', (_e, { deviceName }) => {
      log.warn('ble: selected device is not a TimeFlip:', deviceName || '(unnamed)');
      this.emit('wrong-device', { deviceName: deviceName || null });
    });

    ipcMain.on('ble:facet', (_e, { facet }) => {
      if (facet === this.lastFacet) return;
      this.lastFacet = facet;
      this.emit('facet', { facet });
    });

    ipcMain.on('ble:error', (_e, { message }) => {
      log.error('ble: renderer error', message);
      this.emit('error', new Error(message));
    });

    ipcMain.on('ble:command-result', (_e, { id, ok, result, error }) => {
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error || 'ble command failed'));
    });
  }

  start() {
    if (!this.win) throw new Error('BleBridge.start: no window attached');
    const cfg = {
      uuids: this.uuids,
      passwordBytes: [...proto.passwordBytes(this.password)],
      match: this.bleMatch,
    };
    // userGesture=true lets the renderer call navigator.bluetooth.requestDevice.
    this.win.webContents
      .executeJavaScript(`window.startBle(${JSON.stringify(cfg)})`, true)
      .catch((err) => {
        log.error('ble: startBle failed', err.message);
        this.emit('error', err);
      });
  }

  /** Remove the ipcMain listeners this bridge registered (call when tearing down). */
  dispose() {
    for (const ch of [
      'ble:status',
      'ble:ready',
      'ble:facet',
      'ble:error',
      'ble:wrong-device',
      'ble:command-result',
    ]) {
      ipcMain.removeAllListeners(ch);
    }
    for (const [, p] of this._pending) p.reject(new Error('disposed'));
    this._pending.clear();
  }

  async stop() {
    if (this.win && !this.win.isDestroyed()) {
      try {
        await this.win.webContents.executeJavaScript('window.stopBle && window.stopBle()');
      } catch {
        /* ignore */
      }
    }
    for (const [, p] of this._pending) p.reject(new Error('stopped'));
    this._pending.clear();
  }

  _command(type, payload) {
    if (!this.win || this.win.isDestroyed()) {
      return Promise.reject(new Error('ble window not available'));
    }
    const id = ++this._cmdId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.win.webContents.send('ble:command', { id, type, payload });
      // Safety timeout so a lost reply can't hang the engine forever.
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`ble command "${type}" timed out`));
        }
      }, 15000);
    });
  }

  /** Write bytes to one characteristic, then read another (or the same). */
  async _writeRead(writeChar, readChar, bytes) {
    const result = await this._command('gattWriteRead', {
      writeChar,
      readChar,
      bytes: [...bytes],
      withResponse: true,
    });
    return Buffer.from(result || []);
  }

  // ---- device-like history API (identical contract to the noble driver) ----

  async getLastEventNumber(opts = {}) {
    const buf = await this._writeRead(
      this.uuids.history,
      this.uuids.history,
      proto.historyCommand(proto.HIST.READ_ONE, 0xffffffff)
    );
    const rec = proto.decodeHistoryRecord(buf, opts);
    return rec ? rec.eventNumber : -1;
  }

  async readHistory(startEvent = 0, opts = {}) {
    const records = [];
    const max = opts.max || 100000;
    let event = startEvent >>> 0;
    for (let i = 0; i < max; i++) {
      const buf = await this._writeRead(
        this.uuids.history,
        this.uuids.history,
        proto.historyCommand(proto.HIST.READ_FROM, event)
      );
      const rec = proto.decodeHistoryRecord(buf, opts);
      if (!rec) break;
      records.push(rec);
      event = rec.eventNumber + 1;
    }
    log.info('ble: read', records.length, 'history records from event', startEvent);
    return records;
  }
}

module.exports = { BleBridge };
