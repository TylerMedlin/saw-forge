// .sfproj container: a small binary bundle holding the project JSON and the
// original bytes of every referenced audio file, so a project is one file.
//
//   0  'SFPJ'           magic
//   4  uint32 version
//   8  uint32 jsonBytes
//  12  JSON (UTF-8)     project, with project.assets[i].byteLength
//  ..  asset bytes, concatenated in project.assets order

const MAGIC = 0x4a504653; // 'SFPJ' little-endian
const CONTAINER_VERSION = 1;

export function packProject(project, assetBytes /* Map id -> ArrayBuffer */) {
  const used = new Set();
  for (const t of project.tracks) {
    for (const c of t.clips) if (c.kind === 'audio') used.add(c.assetId);
    for (const lane of t.takeLanes || []) for (const c of lane.clips) used.add(c.assetId); // takes not in the comp are kept too
  }
  const assets = [];
  const blobs = [];
  for (const a of project.assets) {
    if (!used.has(a.id)) continue;
    const bytes = assetBytes.get(a.id);
    if (!bytes) { assets.push({ ...a, byteLength: 0 }); continue; }
    assets.push({ ...a, byteLength: bytes.byteLength });
    blobs.push(new Uint8Array(bytes));
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...project, assets }));
  const total = 12 + json.length + blobs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true); v.setUint32(4, CONTAINER_VERSION, true); v.setUint32(8, json.length, true);
  out.set(json, 12);
  let o = 12 + json.length;
  for (const b of blobs) { out.set(b, o); o += b.length; }
  return out;
}

export function unpackProject(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 12) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) === MAGIC) {
      const jsonLen = v.getUint32(8, true);
      if (12 + jsonLen > bytes.length) throw new Error('The project file is truncated.');
      const project = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen)));
      const assetBytes = new Map();
      const missing = [];
      let o = 12 + jsonLen;
      for (const a of project.assets || []) {
        const n = a.byteLength | 0;
        if (n > 0 && o + n <= bytes.length) assetBytes.set(a.id, bytes.slice(o, o + n).buffer);
        else missing.push(a.name || a.id);
        o += n;
      }
      return { project, assetBytes, missing };
    }
  }
  // Plain JSON project (no embedded audio).
  const text = new TextDecoder().decode(bytes);
  const project = JSON.parse(text);
  return { project, assetBytes: new Map(), missing: (project.assets || []).map((a) => a.name || a.id) };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const safeFileName = (s) => (String(s || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled');
