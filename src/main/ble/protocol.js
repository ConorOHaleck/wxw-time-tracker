'use strict';

/**
 * TimeFlip2 (firmware v4, >= 3.47) BLE GATT protocol constants and decoders.
 *
 * Cross-verified against two primary sources:
 *  - DI-GROUP TimeFlip.Docs "BLE protocol ver4 (02.06.2020)" (the TimeFlip2 spec)
 *  - pierre-24/pytimefliplib async_client.py (working v3+v4 reference client)
 *
 * noble wants UUIDs lowercase with no dashes, so that is the canonical form here.
 */

// Main proprietary service. All proprietary chars share the base f119<6f5X>-71a4-...
const SERVICE_UUID = 'f1196f5071a411e6bdf40800200c9a66';

const CHARACTERISTICS = {
  EVENTS: 'f1196f5171a411e6bdf40800200c9a66', // 6F51  R,N  raw event/accelerometer
  FACET: 'f1196f5271a411e6bdf40800200c9a66', // 6F52  R,N  current face up (1-12)
  COMMAND_RESULT: 'f1196f5371a411e6bdf40800200c9a66', // 6F53  R    last command output
  COMMAND: 'f1196f5471a411e6bdf40800200c9a66', // 6F54  R,W  command input
  DOUBLE_TAP: 'f1196f5571a411e6bdf40800200c9a66', // 6F55  N    double-tap facet
  SYSTEM_STATE: 'f1196f5671a411e6bdf40800200c9a66', // 6F56  R,N  sync/HW state (v4)
  PASSWORD: 'f1196f5771a411e6bdf40800200c9a66', // 6F57  W    auth
  HISTORY: 'f1196f5871a411e6bdf40800200c9a66', // 6F58  R,W,N history paging (v4)
};

// Standard GATT characteristics we also read.
const STD = {
  DEVICE_NAME: '2a00',
  FIRMWARE_REVISION: '2a26',
  BATTERY_LEVEL: '2a19',
  BATTERY_SERVICE: '180f',
};

// Command opcodes written to the COMMAND (6F54) characteristic.
const CMD = {
  STATUS: 0x10, // -> [locked, paused, autopauseLo, autopauseHi]
  READ_TIME: 0x07, // -> 0x07 + uint64 UTC seconds
  SET_TIME: 0x08, // 0x08 + uint64 UTC seconds
  HISTORY_DELETE: 0x02, // clears onboard history (destructive)
  SET_NAME: 0x15, // 0x15 + len + ascii
  SET_PASSWORD: 0x30, // 0x30 + 6 ascii
  LED_BRIGHTNESS: 0x09, // 0x09 + 1..100
};

// History opcodes written to the HISTORY (6F58) characteristic.
const HIST = {
  READ_ONE: 0x01, // 0x01 + uint32(BE) event number (0xFFFFFFFF = last)
  READ_FROM: 0x02, // 0x02 + uint32(BE) start event number -> paged dump
};

// A command is acknowledged when the echo's status byte equals this.
const CMD_STATUS_OK = 0x02;

// History read terminates when the first 17 bytes of a record are all zero.
const HISTORY_END_PREFIX_LEN = 17;

const FIRMWARE_V4_MIN = 3.47;

/** Convert a 32-char no-dash UUID (noble form) to the dashed form Web Bluetooth expects. */
function toDashed(uuid) {
  const u = String(uuid).toLowerCase().replace(/-/g, '');
  if (u.length !== 32) return uuid;
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
}

/** Default factory password as the 6 raw ASCII bytes written to 6F57. */
function passwordBytes(password) {
  const buf = Buffer.from(String(password), 'ascii');
  if (buf.length !== 6) {
    throw new Error(`TimeFlip password must be exactly 6 characters, got "${password}"`);
  }
  return buf;
}

/** Build the 5-byte HISTORY command: opcode + uint32 big-endian event number. */
function historyCommand(opcode, eventNumber) {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(opcode, 0);
  buf.writeUInt32BE(eventNumber >>> 0, 1);
  return buf;
}

/**
 * Decode a 20-byte history record read back from 6F58.
 * Layout (per the working v4 client):
 *   [0..3]   event number   uint32 big-endian
 *   [4]      facet id        1 byte (1-12; >127 => paused segment, subtract 128)
 *   [5..12]  start time      uint64 big-endian, Unix seconds
 *   [13..17] duration        uint32-ish, seconds (endianness configurable)
 *
 * Returns null at the end-of-history sentinel (first 17 bytes all zero).
 */
function decodeHistoryRecord(buf, { durationLittleEndian = true } = {}) {
  if (buf.length < 18) {
    return null;
  }
  if (buf.subarray(0, HISTORY_END_PREFIX_LEN).every((b) => b === 0)) {
    return null; // end marker
  }

  const eventNumber = buf.readUInt32BE(0);

  let facetByte = buf.readUInt8(4);
  let paused = false;
  if (facetByte > 127) {
    paused = true;
    facetByte -= 128;
  }

  // uint64 big-endian start time in Unix seconds.
  const startSeconds = Number(buf.readBigUInt64BE(5));

  const durSlice = buf.subarray(13, 18); // 5 bytes
  let durationSeconds = 0;
  for (let i = 0; i < durSlice.length; i++) {
    const shift = durationLittleEndian ? i : durSlice.length - 1 - i;
    durationSeconds += durSlice[i] * Math.pow(256, shift);
  }

  return {
    eventNumber,
    facet: facetByte,
    paused,
    startMs: startSeconds * 1000,
    durationSeconds,
    endMs: (startSeconds + durationSeconds) * 1000,
  };
}

/** Decode the 1-byte facet notification (1-12, or 0 when undefined/unauthed). */
function decodeFacet(buf) {
  if (!buf || buf.length < 1) return 0;
  return buf.readUInt8(0);
}

/** Decode the status reply read from 6F53 after a CMD.STATUS write. */
function decodeStatus(buf) {
  if (!buf || buf.length < 4) return { locked: false, paused: false, autoPauseMinutes: 0 };
  return {
    locked: buf.readUInt8(0) === 0x01,
    paused: buf.readUInt8(1) === 0x01,
    autoPauseMinutes: buf.readUInt16BE(2),
  };
}

/** Parse the firmware revision string into a comparable float (e.g. "F4.3.51" -> 3.51-ish). */
function parseFirmwareVersion(str) {
  if (!str) return 0;
  const m = String(str).match(/(\d+\.\d+)/);
  return m ? parseFloat(m[1]) : 0;
}

module.exports = {
  SERVICE_UUID,
  CHARACTERISTICS,
  STD,
  CMD,
  HIST,
  CMD_STATUS_OK,
  HISTORY_END_PREFIX_LEN,
  FIRMWARE_V4_MIN,
  toDashed,
  passwordBytes,
  historyCommand,
  decodeHistoryRecord,
  decodeFacet,
  decodeStatus,
  parseFirmwareVersion,
};
