/**
 * Deterministic placeholder images for the seed, as real PNG bytes.
 *
 * The seeded conference is the first thing anyone sees, and a schedule whose
 * speaker gallery is twenty grey circles reads as a broken product rather than
 * as a demo without photographs. These are not photographs either, but they are
 * *files*: bytes that live in R2, are served by `/assets/:id` with a real
 * content type, and go stale, 404 or leak exactly as a real upload would. That
 * is the point — the seed should exercise the storage path, not route around it.
 *
 * No image library, for the same reason the seed hashes passwords by hand: this
 * runs as plain node against the repository's existing dependencies. A PNG is a
 * signature, three chunks and a zlib stream, and `node:zlib` supplies the only
 * hard part.
 *
 * Everything here is a pure function of the caller's `seed` string, so a
 * re-seed produces byte-identical images and R2 does not accumulate versions of
 * the same face.
 */

import { deflateSync } from "node:zlib";

/* -------------------------------------------------------------------------- */
/* PNG encoding                                                                */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Truecolour, 8 bits per channel, no interlace — the simplest legal PNG. */
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10–12: compression, filter and interlace methods, all zero.

  // Filter byte 0 (None) in front of every scanline. Flat fills and vertical
  // gradients cost almost nothing to deflate this way.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* A 5×7 bitmap font                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Uppercase, digits and a few marks — every character these images can contain.
 * Each glyph is seven rows of five columns, `#` on, space off. Unknown
 * characters render as a blank cell rather than throwing, so a name with an
 * accent in it degrades to a space instead of failing the seed.
 */
const GLYPHS = {
  A: ["  #  ", " # # ", "#   #", "#   #", "#####", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  D: ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ### ", "#   #", "#    ", "#  ##", "#   #", "#   #", " ####"],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  J: ["  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "],
  K: ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  Q: [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "#   #", "# # #", "## ##", "#   #"],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  Y: ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
  0: [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  1: ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  2: [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  3: ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  4: ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  5: ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  6: ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  7: ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  8: [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  9: [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
  "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/** FNV-1a, so a name maps to the same hue on every machine and every run. */
function hashOf(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

function canvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 3) };
}

function setPixel(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (y * c.width + x) * 3;
  c.data[i] = rgb[0];
  c.data[i + 1] = rgb[1];
  c.data[i + 2] = rgb[2];
}

/** A vertical two-stop gradient, which is what makes these look deliberate. */
function fillGradient(c, top, bottom) {
  for (let y = 0; y < c.height; y++) {
    const t = c.height === 1 ? 0 : y / (c.height - 1);
    const rgb = [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t));
    for (let x = 0; x < c.width; x++) setPixel(c, x, y, rgb);
  }
}

/** Draw `text` centred on `cx, cy`, one glyph pixel to a `scale × scale` block. */
function drawText(c, text, { cx, cy, scale, colour, tracking = 1 }) {
  const chars = [...text.toUpperCase()];
  const cellW = (GLYPH_W + tracking) * scale;
  const totalW = chars.length * cellW - tracking * scale;
  const originX = Math.round(cx - totalW / 2);
  const originY = Math.round(cy - (GLYPH_H * scale) / 2);

  chars.forEach((ch, i) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (glyph[gy][gx] !== "#") continue;
        const px = originX + i * cellW + gx * scale;
        const py = originY + gy * scale;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) setPixel(c, px + dx, py + dy, colour);
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* The two images the seed needs                                               */
/* -------------------------------------------------------------------------- */

/** The letters a gallery tile shows when there is no photograph: up to two. */
export function initialsOf(fullName) {
  const parts = String(fullName)
    .split(/[\s-]+/)
    .filter((p) => /[a-z]/i.test(p));
  const letters = (parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts).map((p) =>
    p.normalize("NFD").replace(/[^a-z]/gi, "").charAt(0).toUpperCase(),
  );
  return letters.join("").slice(0, 2) || "?";
}

/**
 * A speaker headshot stand-in: initials over a gradient whose hue is the
 * person's own, so the same face appears on the gallery, the session page and
 * the CRM directory without a lookup table.
 */
export function avatarPng(fullName, seed, size = 320) {
  const h = hashOf(seed);
  const hue = h % 360;
  const c = canvas(size, size);
  fillGradient(c, hslToRgb(hue, 0.52, 0.44), hslToRgb((hue + 28) % 360, 0.58, 0.28));
  drawText(c, initialsOf(fullName), {
    cx: size / 2,
    cy: size / 2,
    scale: Math.max(2, Math.round(size / 22)),
    colour: [255, 255, 255],
    tracking: 2,
  });
  return encodePng(size, size, c.data);
}

/**
 * A wordmark for an organization, an event or a sponsor: the name in caps on a
 * band of its own colour. Wide rather than square, because that is the shape
 * every place one is rendered expects.
 */
export function wordmarkPng(text, seed, width = 512, height = 160) {
  const h = hashOf(seed);
  const hue = h % 360;
  const c = canvas(width, height);
  fillGradient(c, hslToRgb(hue, 0.44, 0.22), hslToRgb((hue + 20) % 360, 0.50, 0.14));
  const label = String(text).slice(0, 14);
  // Widest scale that still leaves a margin either side.
  const scale = Math.max(2, Math.floor((width * 0.84) / (label.length * (GLYPH_W + 2))));
  drawText(c, label, { cx: width / 2, cy: height / 2, scale, colour: [255, 255, 255], tracking: 2 });
  return encodePng(width, height, c.data);
}
