// Minimal ZIP reader/writer (store + deflate) on top of Node's zlib, so app
// packages need no third-party code. Writes deterministic archives: sorted
// entries and a fixed timestamp, so the same sources always give the same
// bytes and the same SHA-256.

'use strict';
const zlib = require('node:zlib');
const path = require('node:path');

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const crc32 = (buf) => zlib.crc32(buf) >>> 0;

// entries: [{ name: 'dir/file.js', data: Buffer }]
function writeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data, crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Returns [{ name, data }]; refuses absolute paths, '..' and anything that escapes the folder.
function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  if (end < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(end + 10), cdOff = buf.readUInt32LE(end + 16);
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('damaged zip (central directory)');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const norm = path.posix.normalize(name);
    if (path.posix.isAbsolute(norm) || norm.startsWith('..') || /^[a-zA-Z]:/.test(norm) || norm.includes('\\')) throw new Error(`unsafe path in package: ${name}`);
    if (buf.readUInt32LE(lo) !== SIG_LOCAL) throw new Error('damaged zip (local header)');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`unsupported compression in ${name}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`damaged file in package: ${name}`);
    out.push({ name: norm, data });
  }
  return out;
}

module.exports = { writeZip, readZip };
