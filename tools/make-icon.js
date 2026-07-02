'use strict';

/**
 * Generates the app icon (a blue die face showing 5 pips) as a 512x512 PNG,
 * with no third-party dependencies. Writes to build/icon.png (used by
 * electron-builder for the installer) and src/assets/icon.png (packaged into
 * the app for the tray/window icon at runtime).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024; // 1024 so macOS .icns is crisp; Windows .ico is derived from this too
const BG = { r: 0x2b, g: 0x5c, b: 0xe6 }; // WxW-ish blue
const PIP = { r: 0xff, g: 0xff, b: 0xff };

// Rounded square geometry, proportional to SIZE.
const M = SIZE * 0.086; // margin
const X0 = M;
const Y0 = M;
const X1 = SIZE - M;
const Y1 = SIZE - M;
const R = SIZE * 0.1875; // corner radius

// Five pips (like a die showing 5): four corners + center.
const C = SIZE / 2;
const OFF = SIZE * 0.2305;
const PIP_R = SIZE * 0.082;
const PIPS = [
  [C - OFF, C - OFF],
  [C + OFF, C - OFF],
  [C, C],
  [C - OFF, C + OFF],
  [C + OFF, C + OFF],
];

function insideRoundedRect(x, y) {
  if (x < X0 || x > X1 || y < Y0 || y > Y1) return false;
  // Corner circles.
  const corners = [
    [X0 + R, Y0 + R],
    [X1 - R, Y0 + R],
    [X0 + R, Y1 - R],
    [X1 - R, Y1 - R],
  ];
  if (x < X0 + R && y < Y0 + R) return dist2(x, y, corners[0]) <= R * R;
  if (x > X1 - R && y < Y0 + R) return dist2(x, y, corners[1]) <= R * R;
  if (x < X0 + R && y > Y1 - R) return dist2(x, y, corners[2]) <= R * R;
  if (x > X1 - R && y > Y1 - R) return dist2(x, y, corners[3]) <= R * R;
  return true;
}

function insidePip(x, y) {
  for (const [px, py] of PIPS) {
    if (dist2(x, y, [px, py]) <= PIP_R * PIP_R) return true;
  }
  return false;
}

function dist2(x, y, [cx, cy]) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy;
}

function buildRaw() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0; // filter byte: none
    for (let x = 0; x < SIZE; x++) {
      // 2x2 supersample for smooth edges.
      let sq = 0;
      let pip = 0;
      for (const sx of [0.25, 0.75]) {
        for (const sy of [0.25, 0.75]) {
          const px = x + sx;
          const py = y + sy;
          if (insideRoundedRect(px, py)) {
            sq++;
            if (insidePip(px, py)) pip++;
          }
        }
      }
      const sqCov = sq / 4;
      const pipCov = pip / 4;
      const r = Math.round(BG.r * (1 - pipCov) + PIP.r * pipCov);
      const g = Math.round(BG.g * (1 - pipCov) + PIP.g * pipCov);
      const b = Math.round(BG.b * (1 - pipCov) + PIP.b * pipCov);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = Math.round(sqCov * 255);
    }
  }
  return raw;
}

// ---- PNG encoding ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng() {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(buildRaw(), { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = encodePng();
const targets = [
  path.join(__dirname, '..', 'build', 'icon.png'),
  path.join(__dirname, '..', 'src', 'assets', 'icon.png'),
];
for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, png);
  // eslint-disable-next-line no-console
  console.log('wrote', t, png.length, 'bytes');
}
