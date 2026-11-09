// Files kept next to the app through the local server (serve.py):
//   saves/<name>.sfproj, saves/.autosave/<name>.sfproj, exports/<name>.wav
// Used instead of browser save dialogs whenever the server offers it, so work
// is on disk even where the browser cannot show a file picker.

const HEADERS = { 'X-SawForge-Store': '1' };

// The saves, autosaves and exports on disk, or null when the server has no file store.
export async function listDisk() {
  try {
    const r = await fetch('/__store/list', { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch { return null; }
}

// Write a file. kind: 'project' | 'autosave' | 'export'. A project that already
// exists is only replaced with overwrite; otherwise { exists: true } comes back.
export async function writeDisk(kind, name, bytes, { overwrite = true } = {}) {
  const url = `/__store/save?kind=${kind}&name=${encodeURIComponent(name)}&overwrite=${overwrite ? 1 : 0}`;
  const r = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' }, body: bytes });
  const j = await r.json().catch(() => null);
  if (r.status === 409 && j && j.exists) return { ok: false, exists: true, name: j.name };
  if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || `the local server answered ${r.status}`);
  return j;
}

export async function deleteDisk(kind, name) {
  try { await fetch(`/__store/delete?kind=${kind}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: HEADERS }); } catch { /* ignore */ }
}

export async function readDisk(file) {
  const r = await fetch('/' + file.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
  if (!r.ok) throw new Error(`could not read ${file} (${r.status})`);
  return r.arrayBuffer();
}
