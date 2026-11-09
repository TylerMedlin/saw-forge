// App manager: the catalog (bundled with the hub, refreshed from the project's
// website), and installing, updating and removing apps.
//
// An app package is a zip of web files plus .sawforge/app.json. Every package
// is checked against the SHA-256 in the catalog before anything is unpacked;
// a mismatch installs nothing. Installed apps live in
//   Windows: %LOCALAPPDATA%\Saw Forge Hub\apps\<id>\<version>
//   macOS:   ~/Library/Application Support/Saw Forge Hub/apps/<id>/<version>
// Your projects live separately in Documents/Saw Forge/<App> and are never
// touched by updates or uninstalls.

'use strict';
const { app, net, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { readZip } = require('./zip');

const CONFIG = require('../sawforge.config.json');
const PLACEHOLDER = /YOUR-GITHUB-USER/.test(CONFIG.githubOwner);
const SITE = `https://${CONFIG.githubOwner.toLowerCase()}.github.io/${CONFIG.githubRepo}/`;
const REPO = `https://github.com/${CONFIG.githubOwner}/${CONFIG.githubRepo}`;
const LINKS = {
  website: SITE, source: REPO, issues: `${REPO}/issues`, releases: `${REPO}/releases`,
  guide: `${SITE}install.html`, license: `${REPO}/blob/main/LICENSE`, gpl: 'https://www.gnu.org/licenses/gpl-3.0.html',
};

// semver-ish compare: '1.10.0' > '1.9.2'
function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class AppManager {
  constructor({ onChange, onProgress, paths = {} } = {}) {
    this.onChange = onChange || (() => {});
    this.onProgress = onProgress || (() => {});
    const local = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, app.getName()) : app.getPath('userData');
    this.appsDir = paths.apps || path.join(local, 'apps');
    this.stateFile = paths.state || path.join(app.getPath('userData'), 'hub-state.json');
    this.docsDir = paths.documents || path.join(app.getPath('documents'), 'Saw Forge');
    // bundled packages: <resources>/apps when installed, desktop/dist-apps while developing
    this.bundleDir = app.isPackaged ? path.join(process.resourcesPath, 'apps') : path.join(__dirname, '..', 'dist-apps');
    this.state = { installed: {}, settings: { desktopShortcuts: true, autoUpdate: true, openAtLogin: false }, windows: {} };
    this.catalog = { apps: [], comingSoon: [] };
    this.catalogSource = 'bundled'; this.catalogError = null; this.checkedAt = 0;
    this.busy = new Map(); // id → { phase, received, total, ctrl }
  }

  // ------------------------------------------------------------ persistence
  load() {
    try { const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); this.state = { ...this.state, ...s, settings: { ...this.state.settings, ...(s.settings || {}) } }; } catch { /* first run */ }
    // forget installs whose folder was removed by hand
    for (const [id, rec] of Object.entries(this.state.installed)) if (!fs.existsSync(path.join(rec.path, 'index.html'))) delete this.state.installed[id];
    this.bundled = this.readBundledCatalog();
    this.catalog = this.bundled;
  }
  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = this.stateFile + '.part';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }
  readBundledCatalog() {
    try { return JSON.parse(fs.readFileSync(path.join(this.bundleDir, 'catalog.json'), 'utf8')); } catch { return { apps: [], comingSoon: [] }; }
  }

  // ------------------------------------------------------------ catalog
  // The website's catalog wins when it offers a newer version; the bundled one keeps the hub working offline.
  async refresh() {
    this.checkedAt = Date.now();
    if (PLACEHOLDER) { this.catalogSource = 'bundled'; this.catalogError = null; this.onChange(); return; }
    try {
      const r = await net.fetch(`${SITE}catalog.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`catalog request failed (${r.status})`);
      const remote = await r.json();
      const byId = new Map(this.bundled.apps.map((a) => [a.id, a]));
      for (const a of remote.apps || []) { const b = byId.get(a.id); if (!b || cmpVersion(a.version, b.version) > 0) byId.set(a.id, { ...a, remote: true }); }
      this.catalog = { ...remote, apps: [...byId.values()], comingSoon: remote.comingSoon || this.bundled.comingSoon || [] };
      this.catalogSource = 'online'; this.catalogError = null;
    } catch (e) {
      this.catalog = this.bundled; this.catalogSource = 'bundled'; this.catalogError = String(e.message || e);
    }
    this.onChange();
  }
  entry(id) { return this.catalog.apps.find((a) => a.id === id) || this.bundled.apps.find((a) => a.id === id) || null; }
  installed(id) { return this.state.installed[id] || null; }
  manifest(id) {
    const rec = this.installed(id);
    if (!rec) return null;
    try { return JSON.parse(fs.readFileSync(path.join(rec.path, '.sawforge', 'app.json'), 'utf8')); } catch { return null; }
  }
  dataDir(id) {
    const m = this.manifest(id), e = this.entry(id);
    return path.join(this.docsDir, (m && m.dataFolder) || (e && e.dataFolder) || id);
  }
  iconFile(id) {
    const rec = this.installed(id);
    const candidates = [rec && path.join(rec.path, '.sawforge', 'icon.png'), path.join(this.bundleDir, 'icons', `${id}.png`)];
    return candidates.find((f) => f && fs.existsSync(f)) || null;
  }

  // ------------------------------------------------------------ install / update / remove
  async packageBytes(e) {
    const local = path.join(this.bundleDir, e.file);
    if (!e.remote && fs.existsSync(local)) { this.progress(e.id, 'verifying', e.size, e.size); return fs.promises.readFile(local); }
    if (!e.url) throw new Error('no download address for this app');
    const ctrl = new AbortController();
    this.busy.set(e.id, { ...this.busy.get(e.id), ctrl });
    const r = await net.fetch(e.url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    const total = Number(r.headers.get('content-length')) || e.size || 0, chunks = [];
    let got = 0, last = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); got += value.length;
      if (Date.now() - last > 80) { last = Date.now(); this.progress(e.id, 'downloading', got, total); }
    }
    this.progress(e.id, 'verifying', got, total);
    return Buffer.concat(chunks);
  }
  progress(id, phase, received = 0, total = 0) {
    const b = { ...(this.busy.get(id) || {}), phase, received, total };
    this.busy.set(id, b);
    this.onProgress({ id, phase, received, total });
  }

  async install(id) {
    const e = this.entry(id);
    if (!e) throw new Error(`unknown app: ${id}`);
    if (this.busy.has(id)) return;
    this.progress(id, 'preparing');
    try {
      const bytes = await this.packageBytes(e);
      if (sha256(bytes) !== e.sha256) throw new Error('The package did not match its published checksum, so nothing was installed. Try again, or download the hub again from the official site.');
      this.progress(id, 'installing', bytes.length, bytes.length);
      const files = readZip(bytes);
      if (!files.some((f) => f.name === 'index.html')) throw new Error('package has no index.html');
      const dest = path.join(this.appsDir, id, e.version), tmp = dest + '.partial';
      await fsp.rm(tmp, { recursive: true, force: true });
      for (const f of files) {
        const out = path.join(tmp, ...f.name.split('/'));
        if (!out.startsWith(tmp + path.sep)) throw new Error('unsafe path in package');
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.writeFile(out, f.data);
      }
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(tmp, dest);
      const prev = this.state.installed[id];
      this.state.installed[id] = { version: e.version, path: dest, installedAt: new Date().toISOString(), sha256: e.sha256 };
      this.save();
      // remove older versions
      for (const v of await fsp.readdir(path.join(this.appsDir, id)).catch(() => [])) if (v !== e.version) await fsp.rm(path.join(this.appsDir, id, v), { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(this.dataDir(id), { recursive: true });
      this.makeShortcuts(id, !prev);
      this.busy.delete(id);
      this.onProgress({ id, phase: 'done' });
      this.onChange();
      return { ok: true, version: e.version, updated: !!prev };
    } catch (err) {
      this.busy.delete(id);
      this.onProgress({ id, phase: 'error', error: String(err.message || err) });
      this.onChange();
      throw err;
    }
  }
  cancel(id) { const b = this.busy.get(id); if (b && b.ctrl) b.ctrl.abort(); }

  async uninstall(id) {
    const rec = this.installed(id);
    if (!rec) return { ok: true };
    await fsp.rm(path.join(this.appsDir, id), { recursive: true, force: true });
    delete this.state.installed[id];
    this.save();
    this.removeShortcuts(id);
    this.onChange();
    return { ok: true, kept: this.dataDir(id) };
  }

  // ------------------------------------------------------------ Windows shortcuts (Start menu, desktop)
  shortcutPaths(id) {
    const m = this.manifest(id) || this.entry(id) || { name: id };
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Saw Forge');
    return { startMenu: path.join(startMenu, `${m.name}.lnk`), desktop: path.join(app.getPath('desktop'), `${m.name}.lnk`) };
  }
  shortcutsEnabled() { return process.platform === 'win32' && app.isPackaged && !process.env.SAWFORGE_SELFTEST; }
  writeShortcut(id, file) {
    const rec = this.installed(id), m = this.manifest(id) || {};
    const icon = path.join(rec.path, '.sawforge', 'icon.ico');
    const opts = { target: process.execPath, args: `--launch ${id}`, description: m.tagline || m.name, icon: fs.existsSync(icon) ? icon : process.execPath, iconIndex: 0, appUserModelId: `${CONFIG.appId}.${id}` };
    // 'create' writes or overwrites ('replace' only works on a shortcut that already exists)
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); return shell.writeShortcutLink(file, 'create', opts); } catch { return false; }
  }
  // fresh: first install of the app (a desktop shortcut follows the setting); otherwise keep what exists
  makeShortcuts(id, fresh) {
    if (!this.shortcutsEnabled()) return;
    const p = this.shortcutPaths(id);
    this.writeShortcut(id, p.startMenu);
    if (fresh ? this.state.settings.desktopShortcuts : fs.existsSync(p.desktop)) { if (this.writeShortcut(id, p.desktop)) this.trackDesktop(id, true); }
  }
  trackDesktop(id, on) {
    const t = this.state.desktopLinks || (this.state.desktopLinks = {});
    if (on) t[id] = true; else delete t[id];
    this.save();
  }
  // At startup: every installed app gets its Start-menu shortcut back if it went missing.
  // Desktop shortcuts the hub made come back only right after a hub update (an update must
  // never cost anyone their shortcuts); if one disappears at any other time, someone removed
  // it on purpose and the hub stops tracking it.
  repairShortcuts() {
    if (!this.shortcutsEnabled()) return;
    const version = app.getVersion(), updated = !!this.state.lastHubVersion && this.state.lastHubVersion !== version;
    const links = this.state.desktopLinks || (this.state.desktopLinks = {});
    for (const id of Object.keys(this.state.installed)) {
      const p = this.shortcutPaths(id);
      if (!fs.existsSync(p.startMenu)) this.writeShortcut(id, p.startMenu);
      const onDesktop = fs.existsSync(p.desktop);
      if (onDesktop) links[id] = true;                         // adopt shortcuts that exist
      else if (links[id] && updated) this.writeShortcut(id, p.desktop);
      else if (links[id]) delete links[id];
    }
    this.state.lastHubVersion = version;
    this.save();
  }
  removeShortcuts(id) {
    if (!this.shortcutsEnabled()) return; // never from source runs or the self-test: those must not touch a real install's shortcuts
    const p = this.shortcutPaths(id);
    for (const f of [p.startMenu, p.desktop]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    if (this.state.desktopLinks && this.state.desktopLinks[id]) { delete this.state.desktopLinks[id]; this.save(); }
  }

  // ------------------------------------------------------------ what the hub window shows
  snapshot() {
    const apps = this.catalog.apps.map((e) => {
      const rec = this.installed(e.id), b = this.busy.get(e.id);
      return {
        id: e.id, name: e.name, tagline: e.tagline, description: e.description, category: e.category, notes: e.notes,
        version: e.version, size: e.size, installed: rec ? rec.version : null, updateAvailable: !!(rec && cmpVersion(e.version, rec.version) > 0),
        busy: b ? { phase: b.phase, received: b.received || 0, total: b.total || 0 } : null,
        icon: `sawforge://hub/app-icon/${encodeURIComponent(e.id)}`, dataDir: this.dataDir(e.id),
      };
    });
    return { apps, comingSoon: this.catalog.comingSoon || [], catalogSource: this.catalogSource, catalogError: this.catalogError, checkedAt: this.checkedAt, settings: this.state.settings, paths: { apps: this.appsDir, projects: this.docsDir } };
  }
}

module.exports = { AppManager, CONFIG, LINKS, PLACEHOLDER, cmpVersion, sha256, tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'sawforge-')) };
