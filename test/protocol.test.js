'use strict';

/**
 * Hardware-free unit tests for the BLE binary protocol decoders.
 * Run with: npm test
 */
const assert = require('assert');
const p = require('../src/main/ble/protocol');

const start = 1718600000; // unix seconds

/** Build a synthetic 20-byte history record. */
function rec(event, facet, startS, durSec, littleEndian) {
  const b = Buffer.alloc(20);
  b.writeUInt32BE(event, 0);
  b.writeUInt8(facet, 4);
  b.writeBigUInt64BE(BigInt(startS), 5);
  for (let i = 0; i < 5; i++) {
    const shift = littleEndian ? i : 4 - i;
    b[13 + i] = Math.floor(durSec / Math.pow(256, shift)) % 256;
  }
  return b;
}

// Little-endian duration (matches the reference v4 client).
let r = p.decodeHistoryRecord(rec(5, 3, start, 125, true), { durationLittleEndian: true });
assert.strictEqual(r.eventNumber, 5);
assert.strictEqual(r.facet, 3);
assert.strictEqual(r.paused, false);
assert.strictEqual(r.startMs, start * 1000);
assert.strictEqual(r.durationSeconds, 125);
assert.strictEqual(r.endMs, (start + 125) * 1000);

// Paused segment encodes facet + 128.
let rp = p.decodeHistoryRecord(rec(6, 131, start, 60, true), { durationLittleEndian: true });
assert.strictEqual(rp.facet, 3);
assert.strictEqual(rp.paused, true);

// Big-endian duration variant.
let rbe = p.decodeHistoryRecord(rec(7, 2, start, 300, false), { durationLittleEndian: false });
assert.strictEqual(rbe.durationSeconds, 300);

// End-of-history sentinel: first 17 bytes zero.
let end = Buffer.alloc(20);
end[18] = 9;
assert.strictEqual(p.decodeHistoryRecord(end), null);

// Command encoders.
assert.deepStrictEqual([...p.historyCommand(0x02, 5)], [0x02, 0, 0, 0, 5]);
assert.deepStrictEqual([...p.historyCommand(0x01, 0xffffffff)], [0x01, 255, 255, 255, 255]);
assert.deepStrictEqual([...p.passwordBytes('000000')], [48, 48, 48, 48, 48, 48]);
assert.throws(() => p.passwordBytes('123'), /6 characters/);

// Small decoders.
assert.strictEqual(p.decodeFacet(Buffer.from([7])), 7);
assert.deepStrictEqual(p.decodeStatus(Buffer.from([1, 0, 0, 15])), {
  locked: true,
  paused: false,
  autoPauseMinutes: 15,
});
assert.ok(p.parseFirmwareVersion('F3.47') >= p.FIRMWARE_V4_MIN);

console.log('protocol.test.js: all assertions passed');
