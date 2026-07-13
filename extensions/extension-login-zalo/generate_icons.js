/**
 * Generate simple PNG icons for the extension using only core Node.js
 * Run: node generate_icons.js
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let crc = 0xffffffff;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type), data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(typeData));
  return Buffer.concat([len, typeData, crcVal]);
}

function createPNG(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR (RGBA)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rawData = [];
  const center = size / 2;
  const radius = size * 0.18;

  for (let y = 0; y < size; y++) {
    rawData.push(0); // filter byte
    for (let x = 0; x < size; x++) {
      // Rounded rectangle check
      const inCorner =
        (x < radius && y < radius && Math.hypot(radius - x, radius - y) > radius) ||
        (x > size - radius - 1 && y < radius && Math.hypot(x - size + radius + 1, radius - y) > radius) ||
        (x < radius && y > size - radius - 1 && Math.hypot(radius - x, y - size + radius + 1) > radius) ||
        (x > size - radius - 1 && y > size - radius - 1 && Math.hypot(x - size + radius + 1, y - size + radius + 1) > radius);

      if (inCorner) {
        rawData.push(0, 0, 0, 0); // transparent
        continue;
      }

      // Blue gradient background
      const t = (x + y) / (2 * size);
      let r = Math.round(3 + t * 0);
      let g = Math.round(105 - t * 40);
      let b = Math.round(161 + t * 94);

      // Draw "Z" letter (white)
      const pad = size * 0.22;
      const thick = Math.max(2, Math.ceil(size * 0.14));
      const zLeft = pad;
      const zRight = size - pad;
      const zTop = pad;
      const zBottom = size - pad;
      const zWidth = zRight - zLeft;
      const zHeight = zBottom - zTop;

      let isZ = false;
      // Top bar
      if (y >= zTop && y < zTop + thick && x >= zLeft && x <= zRight) isZ = true;
      // Bottom bar
      if (y > zBottom - thick && y <= zBottom && x >= zLeft && x <= zRight) isZ = true;
      // Diagonal
      if (!isZ) {
        const diagY = y - zTop;
        const diagProgress = diagY / zHeight;
        const diagX = zRight - diagProgress * zWidth;
        if (Math.abs(x - diagX) < thick * 0.7) isZ = true;
      }

      if (isZ) {
        r = 255; g = 255; b = 255;
      }

      rawData.push(r, g, b, 255);
    }
  }

  const compressed = zlib.deflateSync(Buffer.from(rawData));
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, "icons");
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of sizes) {
  const png = createPNG(size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png (${png.length} bytes)`);
}

console.log("Done! Icons created in ./icons/");
