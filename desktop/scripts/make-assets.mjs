// Draws every icon and installer image from code (no image tools needed):
//   build/icon.png, build/icon.ico            Saw Forge Hub app icon
//   build/installerSidebar.bmp, ...Header.bmp Windows setup wizard artwork
//   build/dmg-background(.png|@2x.png)        macOS disk image window
//   assets/apps/saw-forge-studio/icon.*       Saw Forge Studio icon (shortcuts, hub cards)
//   hub/img/*.png, ../site/img/*.png          icons for the hub UI and the download site
// Run: npm run assets

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (rel, data) => { const p = join(ROOT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); console.log('wrote', rel, data.length, 'bytes'); };

// ----------------------------------------------------------------- tiny raster
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
class Img {
  constructor(w, h, bg = null) { this.w = w; this.h = h; this.px = new Float64Array(w * h * 4); if (bg) this.fill(() => [...bg, 1]); }
  // fn(x, y) → [r, g, b, a] (0..255 colour, 0..1 alpha), composited "over"
  fill(fn) {
    const { w, h, px } = this;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = fn(x + 0.5, y + 0.5);
      if (!c || c[3] <= 0) continue;
      const i = (y * w + x) * 4, a = c[3], ia = px[i + 3], oa = a + ia * (1 - a);
      if (oa <= 0) continue;
      for (let k = 0; k < 3; k++) px[i + k] = (c[k] * a + px[i + k] * ia * (1 - a)) / oa;
      px[i + 3] = oa;
    }
  }
  rgba() { const b = new Uint8Array(this.w * this.h * 4); for (let i = 0; i < b.length; i++) b[i] = Math.round(clamp(i % 4 === 3 ? this.px[i] : this.px[i] / 255) * 255); return b; }
}
// signed distances (pixels)
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(x, y, ax, ay, bx, by) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = clamp((px * dx + py * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - dx * t, py - dy * t);
}
const sdPolyline = (x, y, pts) => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, sdSegment(x, y, ...pts[i], ...pts[i + 1])); return d; };
const cover = (d) => clamp(0.5 - d); // anti-aliased coverage from a signed distance

// The Saw Forge mark: a sawtooth (diagonal rise, vertical drop) in a 1024 design grid.
const SAW = [[250, 676], [425, 366], [425, 676], [600, 366], [600, 676], [775, 366], [775, 676]];

// ----------------------------------------------------------------- icons
function appIcon(size, variant) {
  const s = size / 1024, img = new Img(size, size);
  const cx = 512 * s, cy = 512 * s, hw = 412 * s, r = 186 * s;
  // soft drop shadow (macOS icon grid style)
  img.fill((x, y) => { const d = sdRoundRect(x, y - 14 * s, cx, cy, hw, hw, r); return d > 40 * s ? null : [0, 0, 0, 0.32 * clamp(1 - (d + 6 * s) / (46 * s))]; });
  const plate = variant === 'hub'
    ? (x, y) => { const t = y / size; const g = [mix(255, 236, t), mix(160, 96, t), mix(70, 22, t)]; const hl = Math.exp(-(((x - 0.3 * size) ** 2 + (y - 0.18 * size) ** 2) / (2 * (0.32 * size) ** 2))) * 0.18; return g.map((v) => mix(v, 255, hl)); }
    : (x, y) => { const t = y / size; const g = [mix(42, 16, t), mix(46, 18, t), mix(54, 22, t)]; const glow = Math.exp(-(((x - 0.5 * size) ** 2 + (y - 0.5 * size) ** 2) / (2 * (0.3 * size) ** 2))) * 0.16; return [mix(g[0], 255, glow), mix(g[1], 143, glow), mix(g[2], 60, glow)]; };
  img.fill((x, y) => { const a = cover(sdRoundRect(x, y, cx, cy, hw, hw, r)); return a ? [...plate(x, y), a] : null; });
  // inner rim light
  img.fill((x, y) => { const d = sdRoundRect(x, y, cx, cy, hw, hw, r); const a = cover(Math.abs(d + 3 * s) - 1.6 * s) * 0.35; return a && y < cy ? [255, 255, 255, a * (1 - y / cy)] : null; });
  const pts = SAW.map(([px, py]) => [px * s, py * s]), half = 27 * s;
  if (variant === 'hub') {
    img.fill((x, y) => { const a = cover(sdPolyline(x, y + 10 * s, pts) - half) * 0.25; return a ? [90, 30, 0, a] : null; });
    img.fill((x, y) => { const a = cover(sdPolyline(x, y, pts) - half); return a ? [30, 20, 18, a] : null; });
  } else {
    img.fill((x, y) => { const d = sdPolyline(x, y, pts); const a = Math.exp(-Math.max(0, d - half) / (26 * s)) * 0.55; return d > half + 120 * s ? null : [255, 128, 40, a]; });
    img.fill((x, y) => { const a = cover(sdPolyline(x, y, pts) - half); if (!a) return null; const t = clamp((y / s - 366) / 310); return [255, mix(186, 116, t), mix(112, 26, t), a]; });
  }
  return img;
}

// ----------------------------------------------------------------- encoders
function png(img) {
  const { w, h } = img, data = img.rgba(), raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(data.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(images) { // PNG-compressed entries (Windows Vista and later)
  const pngs = images.map(png), head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach((im, i) => {
    const e = 6 + 16 * i;
    head[e] = im.w >= 256 ? 0 : im.w; head[e + 1] = im.h >= 256 ? 0 : im.h; head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12);
    off += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}
function bmp(img) { // 24-bit, bottom-up (what NSIS expects)
  const { w, h } = img, data = img.rgba(), row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h, b = Buffer.alloc(size);
  b.write('BM', 0, 'ascii'); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, o = 54 + y * row + x * 3, a = data[s + 3] / 255;
    b[o] = Math.round(data[s + 2] * a + 255 * (1 - a)); b[o + 1] = Math.round(data[s + 1] * a + 255 * (1 - a)); b[o + 2] = Math.round(data[s] * a + 255 * (1 - a));
  }
  return b;
}
// draw a smaller icon onto a picture
function stamp(dst, src, ox, oy) {
  const d = src.rgba();
  dst.fill((x, y) => { const sx = Math.floor(x - ox), sy = Math.floor(y - oy); if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) return null; const i = (sy * src.w + sx) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3] / 255]; });
}

// ----------------------------------------------------------------- installer art
function sidebar() { // 164×314 left panel of the Windows setup wizard
  const w = 164, h = 314, img = new Img(w, h);
  img.fill((x, y) => { const t = y / h; return [mix(30, 14, t), mix(33, 15, t), mix(39, 18, t), 1]; });
  img.fill((x, y) => { const g = Math.exp(-(((x - 82) ** 2) / (2 * 70 ** 2) + ((y - 120) ** 2) / (2 * 90 ** 2))) * 0.28; return [255, 128, 40, g]; });
  img.fill((x, y) => { const a = (Math.abs(((x + y * 0.6) % 22) - 11) < 0.5 ? 0.035 : 0); return a ? [255, 255, 255, a] : null; });
  stamp(img, appIcon(112, 'hub'), 26, 64);
  img.fill((x, y) => (y > h - 4 ? [255, 143, 60, 1] : null)); // accent rule
  return img;
}
function header() { // 150×57 top-right banner
  const img = new Img(150, 57, [255, 255, 255]);
  stamp(img, appIcon(46, 'hub'), 98, 5);
  return img;
}
function dmgBackground(scale) { // 540×380 window: app on the left, Applications on the right
  const w = 540 * scale, h = 380 * scale, img = new Img(w, h);
  img.fill((x, y) => { const t = y / h; return [mix(29, 15, t), mix(32, 16, t), mix(38, 19, t), 1]; });
  img.fill((x, y) => { const g = Math.exp(-(((x - w / 2) ** 2) / (2 * (w * 0.45) ** 2) + ((y - h * 0.5) ** 2) / (2 * (h * 0.4) ** 2))) * 0.12; return [255, 128, 40, g]; });
  // arrow from the app (x 140) to Applications (x 400), at icon height (y 190)
  const y0 = 190 * scale, x0 = 215 * scale, x1 = 322 * scale, th = 3.2 * scale, head = 13 * scale;
  img.fill((x, y) => {
    const shaft = sdSegment(x, y, x0, y0, x1 - head * 0.6, y0) - th;
    const tip = Math.min(sdSegment(x, y, x1, y0, x1 - head, y0 - head) , sdSegment(x, y, x1, y0, x1 - head, y0 + head)) - th;
    const dashed = Math.floor((x - x0) / (12 * scale)) % 2 === 0 || x > x1 - head * 1.2;
    const a = Math.max(dashed ? cover(shaft) : 0, cover(tip));
    return a ? [255, 160, 80, a * 0.9] : null;
  });
  return img;
}

// ----------------------------------------------------------------- write everything
const hubSizes = [16, 24, 32, 48, 64, 128, 256];
out('build/icon.png', png(appIcon(1024, 'hub')));
out('build/icon.ico', ico(hubSizes.map((s) => appIcon(s, 'hub'))));
out('build/installerSidebar.bmp', bmp(sidebar()));
out('build/uninstallerSidebar.bmp', bmp(sidebar()));
out('build/installerHeader.bmp', bmp(header()));
out('build/dmg-background.png', png(dmgBackground(1)));
out('build/dmg-background@2x.png', png(dmgBackground(2)));
out('assets/apps/saw-forge-studio/icon.png', png(appIcon(512, 'studio')));
out('assets/apps/saw-forge-studio/icon.ico', ico(hubSizes.map((s) => appIcon(s, 'studio'))));
out('hub/img/hub-icon.png', png(appIcon(128, 'hub')));
out('hub/img/studio-icon.png', png(appIcon(256, 'studio')));
out('../site/img/hub-icon.png', png(appIcon(256, 'hub')));
out('../site/img/studio-icon.png', png(appIcon(256, 'studio')));
out('../site/img/favicon.png', png(appIcon(64, 'hub')));
