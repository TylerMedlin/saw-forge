// Crash/close recovery: unsaved work is autosaved to IndexedDB.

const DB = 'sawforge-studio';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => { db.close(); resolve(r && 'result' in r ? r.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export async function saveRecovery(bytes, name) {
  try { await tx('readwrite', (s) => s.put({ time: Date.now(), name, bytes }, 'recovery')); return true; }
  catch (e) { console.warn('Autosave failed', e); return false; }
}
export async function loadRecovery() {
  try { return (await tx('readonly', (s) => s.get('recovery'))) || null; } catch { return null; }
}
export async function clearRecovery() {
  try { await tx('readwrite', (s) => s.delete('recovery')); } catch { /* ignore */ }
}
