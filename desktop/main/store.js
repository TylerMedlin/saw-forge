// The desktop version of serve.py's file store: the same /__store/* requests,
// answered from the app's folder in Documents instead of a Python server, so
// Saw Forge Studio saves exactly as it does in the browser.
//   <data>/saves/<name>.sfproj, saves/.autosave/, saves/.history/, exports/<name>.wav

'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const STORE = { project: ['saves', '.sfproj'], autosave: ['saves/.autosave', '.sfproj'], export: ['exports', '.wav'] };
const HISTORY_DIR = 'saves/.history', HISTORY_KEEP = 10, MAX_BODY = 2 * 1024 ** 3;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

function safeName(name) {
  let n = String(name || '').replace(/[^\p{L}\p{N}_ \-().,&'+!]/gu, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 120).replace(/^[ .]+|[ .]+$/g, '');
  if (!n) n = 'Untitled';
  if (RESERVED.has(n.split('.')[0].toUpperCase())) n = '_' + n;
  return n;
}
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });

async function listing(dataDir, kind) {
  const [folder, ext] = STORE[kind], full = path.join(dataDir, ...folder.split('/'));
  let names = [];
  try { names = await fsp.readdir(full); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(ext)) continue;
    try {
      const st = await fsp.stat(path.join(full, f));
      if (st.isFile()) out.push({ name: f.slice(0, -ext.length), file: `${folder}/${f}`, size: st.size, modified: Math.floor(st.mtimeMs) });
    } catch { /* vanished */ }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const stamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
async function keepHistory(dataDir, file, name) {
  const hist = path.join(dataDir, ...HISTORY_DIR.split('/'));
  await fsp.mkdir(hist, { recursive: true });
  const st = await fsp.stat(file);
  await fsp.copyFile(file, path.join(hist, `${name} ${stamp(st.mtime)}.sfproj`));
  const mine = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d{8}-\\d{6}\\.sfproj$`);
  const old = (await fsp.readdir(hist)).filter((f) => mine.test(f)).sort();
  for (const f of old.slice(0, -HISTORY_KEEP)) await fsp.rm(path.join(hist, f), { force: true });
}

// Handle /__store/* for an app whose data lives in dataDir. Returns a Response.
async function handleStore(req, url, dataDir) {
  if (req.headers.get('X-SawForge-Store') !== '1') return json(403, { ok: false, error: 'not allowed' });
  const p = url.pathname;
  if (req.method === 'GET' && p === '/__store/list') {
    return json(200, { ok: true, saves: await listing(dataDir, 'project'), autosaves: await listing(dataDir, 'autosave'), exports: await listing(dataDir, 'export') });
  }
  if (req.method !== 'POST') return json(404, { ok: false, error: 'unknown request' });
  const kind = url.searchParams.get('kind') || 'project';
  if (!STORE[kind]) return json(400, { ok: false, error: 'unknown kind' });
  const name = safeName(url.searchParams.get('name'));
  const [folder, ext] = STORE[kind], dir = path.join(dataDir, ...folder.split('/')), file = path.join(dir, name + ext);
  try {
    if (p === '/__store/delete') { await fsp.rm(file, { force: true }); return json(200, { ok: true, name }); }
    if (p !== '/__store/save') return json(404, { ok: false, error: 'unknown request' });
    const body = Buffer.from(await req.arrayBuffer());
    if (!body.length || body.length > MAX_BODY) return json(413, { ok: false, error: 'empty or too large' });
    const exists = fs.existsSync(file);
    if (kind === 'project' && exists && url.searchParams.get('overwrite') !== '1') return json(409, { ok: false, exists: true, name });
    await fsp.mkdir(dir, { recursive: true });
    if (kind === 'project' && exists) await keepHistory(dataDir, file, name);
    const tmp = `${file}.${process.pid}.${Date.now()}.part`;
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file); // atomic: a crash never leaves a half-written project
    return json(200, { ok: true, name, file: `${folder}/${name}${ext}`, bytes: body.length });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
}

module.exports = { handleStore, safeName, STORE };
