// Saw Forge Hub — desktop shell.
//
// Serves the hub UI and every installed app from the private sawforge://
// scheme (sawforge://hub/…, sawforge://<app-id>/…) with the headers the audio
// engine needs (cross-origin isolation → SharedArrayBuffer), answers the apps'
// /__store/* file requests from Documents/Saw Forge (replacing serve.py), and
// manages app windows, permissions (microphone, MIDI), updates and shortcuts.
//
//   electron .                     open the hub
//   electron . --launch <app-id>   open one app directly (Start-menu shortcuts use this)
//   electron . --selftest          install + boot every bundled app headlessly, print a report, exit
//   electron . --capture <dir>     save real screenshots of the hub and Saw Forge Studio (for the website)

'use strict';
const { app, BrowserWindow, protocol, ipcMain, shell, Menu, dialog, session, systemPreferences, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AppManager, CONFIG, LINKS, PLACEHOLDER, tmpDir } = require('./apps');
const { handleStore } = require('./store');

const SELFTEST = process.argv.includes('--selftest');
const argLaunch = (argv) => { const i = argv.indexOf('--launch'); return i >= 0 ? argv[i + 1] : null; };
const HUB_DIR = path.join(__dirname, '..', 'hub');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.sfproj': 'application/octet-stream', '.woff2': 'font/woff2' };
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };

const CAPTURE = (() => { const i = process.argv.indexOf('--capture'); return i >= 0 ? path.resolve(process.argv[i + 1] || 'screenshots') : null; })();
const ISOLATED = SELFTEST || !!CAPTURE;
const SELFTEST_DIR = ISOLATED ? tmpDir() : null; // the self-test and screenshots never touch real installs or projects
if (ISOLATED) {
  process.env.SAWFORGE_SELFTEST = '1';
  app.setPath('userData', path.join(SELFTEST_DIR, 'userData'));
}
app.setName('Saw Forge Hub');
if (process.platform === 'win32') app.setAppUserModelId(CONFIG.appId);
nativeTheme.themeSource = 'dark';

protocol.registerSchemesAsPrivileged([{ scheme: 'sawforge', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

let manager = null, hubWin = null;
const appWins = new Map(); // id → BrowserWindow

// ------------------------------------------------------------ the sawforge:// scheme
async function serveFile(root, rel, extraHeaders = {}) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
  if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
  let data;
  try { data = await fs.promises.readFile(file); } catch { return new Response('Not found', { status: 404, headers: ISOLATION }); }
  return new Response(data, { status: 200, headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ...ISOLATION, ...extraHeaders } });
}
async function handleScheme(req) {
  const url = new URL(req.url), host = url.hostname, p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (host === 'hub') {
    const icon = /^\/app-icon\/(.+)$/.exec(p);
    if (icon) { const f = manager.iconFile(decodeURIComponent(icon[1])); return f ? serveFile(path.dirname(f), path.basename(f)) : serveFile(HUB_DIR, '/img/studio-icon.png'); }
    return serveFile(HUB_DIR, p, { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'" });
  }
  const rec = manager.installed(host);
  if (!rec) return new Response('This app is not installed.', { status: 404 });
  if (p.startsWith('/__store/')) return handleStore(req, url, manager.dataDir(host));
  if (p.startsWith('/saves/') || p.startsWith('/exports/')) return serveFile(manager.dataDir(host), p);
  return serveFile(rec.path, p);
}

// ------------------------------------------------------------ windows
const isOurs = (u) => { try { return new URL(u).protocol === 'sawforge:'; } catch { return false; } };
function guardNavigation(win, origin) {
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => { // developer tools for contributors: Ctrl/Cmd+Shift+I or F12
    if ((input.type === 'keyDown') && (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
}
function windowState(key, def) {
  const s = manager.state.windows[key];
  return s && s.width > 400 && s.height > 300 ? { ...def, ...s } : def;
}
function trackState(win, key) {
  const save = () => { if (!win.isDestroyed() && !win.isMinimized()) { manager.state.windows[key] = { ...win.getNormalBounds(), maximized: win.isMaximized() }; manager.save(); } };
  win.on('close', save);
}

function openHub() {
  if (hubWin && !hubWin.isDestroyed()) { if (hubWin.isMinimized()) hubWin.restore(); hubWin.show(); hubWin.focus(); return hubWin; }
  const st = windowState('hub', { width: 1180, height: 760 });
  hubWin = new BrowserWindow({
    ...st, minWidth: 900, minHeight: 600, show: false, title: 'Saw Forge Hub', backgroundColor: '#101214', autoHideMenuBar: true,
    icon: path.join(HUB_DIR, 'img', 'hub-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload-hub.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, ...(CAPTURE ? { offscreen: true } : {}) },
  });
  if (st.maximized) hubWin.maximize();
  guardNavigation(hubWin, 'sawforge://hub/');
  trackState(hubWin, 'hub');
  hubWin.once('ready-to-show', () => { if (!ISOLATED) hubWin.show(); });
  hubWin.on('closed', () => { hubWin = null; });
  hubWin.loadURL('sawforge://hub/index.html');
  return hubWin;
}

function launchApp(id, { show = true } = {}) {
  const existing = appWins.get(id);
  if (existing && !existing.isDestroyed()) { if (existing.isMinimized()) existing.restore(); existing.focus(); return existing; }
  const rec = manager.installed(id);
  if (!rec) { openHub(); return null; }
  const m = manager.manifest(id) || {}, w = m.window || {};
  const st = windowState(id, { width: w.width || 1400, height: w.height || 880 });
  const icon = manager.iconFile(id);
  const win = new BrowserWindow({
    ...st, minWidth: w.minWidth || 900, minHeight: w.minHeight || 600, show: false, title: m.name || id,
    backgroundColor: w.backgroundColor || '#121417', autoHideMenuBar: true, icon: icon || undefined,
    webPreferences: { preload: path.join(__dirname, 'preload-app.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, ...(CAPTURE ? { offscreen: true } : {}) },
  });
  if (process.platform === 'win32') win.setAppDetails({ appId: `${CONFIG.appId}.${id}` });
  if (st.maximized) win.maximize();
  guardNavigation(win, `sawforge://${id}/`);
  trackState(win, id);
  // The app asks the browser to keep the page when there is unsaved work; a desktop app asks the person instead.
  win.webContents.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close', 'Keep working'], defaultId: 1, cancelId: 1, title: m.name || 'Saw Forge',
      message: 'Close with unsaved changes?', detail: 'Your work was autosaved and will be offered for recovery the next time you open the app.' });
    if (r === 0) e.preventDefault(); // preventDefault here lets the window close
  });
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('closed', () => { appWins.delete(id); if (!hubWin && appWins.size === 0 && process.platform !== 'darwin') app.quit(); });
  appWins.set(id, win);
  win.loadURL(`sawforge://${id}/index.html`);
  return win;
}

// ------------------------------------------------------------ permissions: microphone (recording) and MIDI for our apps only
function setupPermissions() {
  const allowed = new Set(['media', 'midi', 'midiSysex', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    if (!isOurs(details.requestingUrl || wc.getURL()) || !allowed.has(permission)) return cb(false);
    if (permission === 'media' && process.platform === 'darwin' && (details.mediaTypes || []).includes('audio')) {
      try { return cb(await systemPreferences.askForMediaAccess('microphone')); } catch { return cb(false); }
    }
    cb(true);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => isOurs(origin) && allowed.has(permission));
}

// ------------------------------------------------------------ menus
function setupMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; } // apps draw their own UI; keeps every shortcut for the app
  // macOS needs Cut/Copy/Paste in a menu for text fields; Undo/Redo are left to the apps (Cmd+Z reaches the page).
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => { openHub(); checkHubUpdate(true); } }, { type: 'separator' },
      { label: 'Saw Forge Hub', accelerator: 'Cmd+Shift+H', click: () => openHub() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Saw Forge Website', click: () => shell.openExternal(LINKS.website) }, { label: 'Install Guide', click: () => shell.openExternal(LINKS.guide) },
      { label: 'Source Code (GPL-3.0)', click: () => shell.openExternal(LINKS.source) }, { label: 'Report a Problem', click: () => shell.openExternal(LINKS.issues) }] },
  ]));
}

// ------------------------------------------------------------ hub self-update (GitHub Releases via electron-updater)
let hubUpdate = { status: 'idle', version: null, error: null };
function sendHub(ch, data) { if (hubWin && !hubWin.isDestroyed()) hubWin.webContents.send('hub:' + ch, data); }
let updater = null;
function getUpdater() {
  if (updater !== null) return updater;
  updater = false;
  if (!app.isPackaged || PLACEHOLDER || ISOLATED) return updater;
  try {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = true; updater.autoInstallOnAppQuit = true;
    const set = (s) => { hubUpdate = { ...hubUpdate, ...s }; sendHub('hubUpdate', hubUpdate); };
    updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    updater.on('update-available', (i) => set({ status: 'downloading', version: i.version }));
    updater.on('update-not-available', () => set({ status: 'current' }));
    updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
    updater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version }));
    updater.on('error', (e) => set({ status: 'error', error: String(e && e.message ? e.message : e).split('\n')[0] }));
  } catch { updater = false; }
  return updater;
}
function checkHubUpdate(manual = false) {
  const u = getUpdater();
  if (!u) { hubUpdate = { status: app.isPackaged ? 'unconfigured' : 'dev', version: null }; sendHub('hubUpdate', hubUpdate); return; }
  if (manual || manager.state.settings.autoUpdate) u.checkForUpdates().catch(() => {});
}

// ------------------------------------------------------------ hub ↔ main
function hubState() {
  return { hub: { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, electron: process.versions.electron, update: hubUpdate },
    configured: !PLACEHOLDER, links: LINKS, publisher: CONFIG.publisher, ...manager.snapshot(), running: [...appWins.keys()] };
}
function setupIpc() {
  const onlyHub = (fn) => async (e, ...args) => {
    if (!e.senderFrame || !e.senderFrame.url.startsWith('sawforge://hub/')) throw new Error('not allowed');
    return fn(...args);
  };
  ipcMain.handle('hub:state', onlyHub(() => hubState()));
  ipcMain.handle('hub:refresh', onlyHub(async () => { await manager.refresh(); checkHubUpdate(true); return hubState(); }));
  ipcMain.handle('hub:install', onlyHub(async (id) => { try { return await manager.install(String(id)); } catch (err) { return { ok: false, error: String(err.message || err) }; } }));
  ipcMain.handle('hub:cancel', onlyHub((id) => manager.cancel(String(id))));
  ipcMain.handle('hub:uninstall', onlyHub(async (id) => {
    const w = appWins.get(id); if (w && !w.isDestroyed()) w.close();
    return manager.uninstall(String(id));
  }));
  ipcMain.handle('hub:launch', onlyHub((id) => { launchApp(String(id)); return true; }));
  ipcMain.handle('hub:reveal', onlyHub((what, id) => {
    const target = what === 'projects' ? (id ? manager.dataDir(id) : manager.docsDir) : what === 'apps' ? manager.appsDir : null;
    if (target) { fs.mkdirSync(target, { recursive: true }); shell.openPath(target); }
    return true;
  }));
  ipcMain.handle('hub:open', onlyHub((key) => { if (LINKS[key]) shell.openExternal(LINKS[key]); return true; }));
  ipcMain.handle('hub:setting', onlyHub((k, v) => {
    if (!(k in manager.state.settings)) return hubState();
    manager.state.settings[k] = !!v; manager.save();
    if (k === 'openAtLogin' && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!v });
    return hubState();
  }));
  ipcMain.handle('hub:hubUpdate', onlyHub((action) => {
    if (action === 'check') checkHubUpdate(true);
    else if (action === 'install' && getUpdater() && hubUpdate.status === 'ready') getUpdater().quitAndInstall();
    return hubUpdate;
  }));
}

// ------------------------------------------------------------ self-test: proves an installed app boots with audio + file store
async function selftest() {
  const report = { electron: process.versions.electron, chrome: process.versions.chrome, platform: `${process.platform}-${process.arch}`, apps: [] };
  try {
    // the hub UI
    const hw = openHub();
    await new Promise((r) => hw.webContents.once('did-finish-load', r));
    report.hub = await hw.webContents.executeJavaScript(`(async () => { await new Promise((r) => setTimeout(r, 300)); return { bridge: typeof window.hub === 'object', cards: document.querySelectorAll('[data-app-id]').length, title: document.title }; })()`);
    for (const e of manager.catalog.apps) {
      const r = { id: e.id, version: e.version };
      const res = await manager.install(e.id);
      r.installed = !!(res && res.ok);
      const win = launchApp(e.id, { show: false });
      await new Promise((ok) => win.webContents.once('did-finish-load', ok));
      r.page = await win.webContents.executeJavaScript(`(async () => {
        const out = { isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', title: document.title };
        for (let i = 0; i < 50 && !window.__booted; i++) await new Promise((r) => setTimeout(r, 100));
        out.booted = !!window.__booted;
        const H = { 'X-SawForge-Store': '1' };
        const save = await fetch('/__store/save?kind=project&name=Selftest&overwrite=1', { method: 'POST', headers: H, body: new Uint8Array([83, 70, 80, 74, 1, 2, 3]) }).then((x) => x.json());
        const list = await fetch('/__store/list', { headers: H }).then((x) => x.json());
        const back = await fetch('/saves/Selftest.sfproj').then((x) => x.arrayBuffer());
        out.store = { saved: save.ok, listed: list.saves.map((s) => s.name), readBack: back.byteLength };
        const blocked = await fetch('/__store/list').then((x) => x.status);
        out.storeNeedsHeader = blocked === 403;
        try {
          const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 4800, sampleRate: 48000 });
          await ctx.audioWorklet.addModule('/src/audio/worklet/engine-processor.js');
          out.worklet = true;
        } catch (err) { out.worklet = String(err); }
        return out;
      })()`);
      r.dataDir = manager.dataDir(e.id);
      r.onDisk = fs.existsSync(path.join(r.dataDir, 'saves', 'Selftest.sfproj'));
      win.destroy();
      const un = await manager.uninstall(e.id);
      r.uninstalled = un.ok && !manager.installed(e.id) && r.onDisk && fs.existsSync(path.join(r.dataDir, 'saves', 'Selftest.sfproj'));
      report.apps.push(r);
    }
    const a = report.apps;
    report.ok = !!report.hub && report.hub.bridge && a.length > 0 && a.every((r) => r.installed && r.page.isolated && r.page.sab && r.page.booted && r.page.worklet === true && r.page.store.saved && r.page.store.readBack === 7 && r.page.storeNeedsHeader && r.onDisk && r.uninstalled);
  } catch (err) { report.ok = false; report.error = String(err && err.stack ? err.stack : err); }
  const outFile = path.join(require('node:os').tmpdir(), 'sawforge-selftest.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  app.exit(report.ok ? 0 : 1);
}

// ------------------------------------------------------------ screenshots for the website (real windows, rendered off screen)
async function capture() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win, name) => { win.webContents.invalidate(); await wait(250); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(CAPTURE, name), img.toPNG()); return `${name} ${img.getSize().width}×${img.getSize().height}`; };
  const log = [];
  try {
    fs.mkdirSync(CAPTURE, { recursive: true });
    const hw = openHub();
    hw.setContentSize(1200, 760);
    await new Promise((r) => hw.webContents.once('did-finish-load', r));
    await wait(600);
    log.push(await shot(hw, 'hub.png'));
    const id = manager.catalog.apps[0].id;
    await manager.install(id);
    await wait(500);
    log.push(await shot(hw, 'hub-installed.png'));
    const win = launchApp(id, { show: false });
    win.setContentSize(1440, 900);
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 60 && !window.__booted; i++) await new Promise((r) => setTimeout(r, 100));
      document.querySelectorAll('.welcome-back').forEach((d) => d.remove());
      const app = window.sawforge;
      await app.newProject('demo');
      app.addDrummerTrack('nova');
      await new Promise((r) => setTimeout(r, 900));
      return app.p.tracks.map((t) => t.name).join(', ');
    })()`).then((t) => log.push('studio tracks: ' + t));
    log.push(await shot(win, 'studio.png'));
    win.destroy();
  } catch (err) { log.push('error: ' + (err && err.stack ? err.stack : err)); }
  process.stdout.write(log.join('\n') + '\n');
  fs.writeFileSync(path.join(require('node:os').tmpdir(), 'sawforge-capture.log'), log.join('\n'));
  app.exit(log.some((l) => l.startsWith('error')) ? 1 : 0);
}

// ------------------------------------------------------------ startup
const gotLock = ISOLATED || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (e, argv) => { const id = argLaunch(argv); if (id && manager.installed(id)) launchApp(id); else openHub(); });
  app.whenReady().then(async () => {
    manager = new AppManager({ onChange: () => sendHub('state', hubState()), onProgress: (p) => sendHub('progress', p),
      paths: ISOLATED ? { apps: path.join(SELFTEST_DIR, 'apps'), documents: path.join(SELFTEST_DIR, 'Documents') } : {} });
    manager.load();
    protocol.handle('sawforge', handleScheme);
    setupPermissions(); setupMenu(); setupIpc();
    if (SELFTEST) return selftest();
    if (CAPTURE) return capture();
    const id = argLaunch(process.argv);
    if (id && manager.installed(id)) launchApp(id); else openHub();
    manager.repairShortcuts();
    manager.refresh().catch(() => {});
    setTimeout(() => checkHubUpdate(false), 4000);
    setInterval(() => { manager.refresh().catch(() => {}); checkHubUpdate(false); }, 6 * 3600 * 1000);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openHub(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
