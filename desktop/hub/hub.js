// Saw Forge Hub window. Talks to the main process only through window.hub
// (see main/preload-hub.js). Opened in a normal browser (for design work) it
// runs against a built-in demo so every screen can be previewed.
'use strict';

const api = window.hub || demoApi();
let S = null;            // state from the main process
let view = 'all', query = '';
const progress = new Map(); // id → { phase, received, total, error }

// ------------------------------------------------------------ helpers
const $ = (sel) => document.querySelector(sel);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.innerHTML = d; return s; };
const ICON = { dots: '<circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none"/>', plus: '<path d="M8 3v10M3 8h10"/>' };
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ago = (t) => { if (!t) return 'not yet'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }
function confirmBox(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    const m = $('#modal');
    const close = (v) => { m.hidden = true; m.replaceChildren(); resolve(v); };
    m.replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, h('h3', null, title), h('p', null, text),
      h('div', { class: 'acts' }, h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'), h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, okLabel))));
    m.hidden = false;
    m.onclick = (e) => { if (e.target === m) close(false); };
    m.querySelector('.btn.ghost').focus();
  });
}
function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((x) => x.remove());
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => h('button', { class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => { el.remove(); it.action(); } }, it.label)));
  document.body.append(el);
  el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6)}px`;
  el.style.left = `${Math.max(8, r.right - el.offsetWidth)}px`;
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!el.contains(e.target)) { el.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}

// ------------------------------------------------------------ actions
async function install(a) {
  progress.set(a.id, { phase: 'preparing' }); render();
  const r = await api.install(a.id);
  if (r && r.ok === false) { progress.set(a.id, { phase: 'error', error: r.error }); render(); return; }
  progress.delete(a.id);
  toast(r && r.updated ? `${a.name} updated to ${r.version}` : `${a.name} is installed. Open it any time from here${S.hub.platform === 'win32' ? ' or the Start menu' : ''}.`);
}
async function uninstall(a) {
  const ok = await confirmBox(`Uninstall ${a.name}?`, `The app is removed from this computer. Your projects stay in ${a.dataDir}.`, 'Uninstall', true);
  if (!ok) return;
  await api.uninstall(a.id);
  toast(`${a.name} was uninstalled. Your projects were kept.`);
}
function actionButtons(a, big) {
  const p = progress.get(a.id) || (a.busy ? a.busy : null);
  if (p && p.phase !== 'error' && p.phase !== 'done') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) : null;
    const label = { preparing: 'Preparing…', downloading: 'Downloading…', verifying: 'Verifying checksum…', installing: 'Installing…' }[p.phase] || 'Working…';
    return h('div', { class: 'progress' },
      h('div', { class: 'lbl' }, h('span', null, label), h('span', null, p.phase === 'downloading' && p.total ? `${mb(p.received)} of ${mb(p.total)}` : pct != null && p.phase === 'downloading' ? `${pct}%` : '')),
      h('div', { class: 'bar' + (p.phase === 'downloading' && p.total ? '' : ' indet') }, h('i', { style: { width: `${pct || 0}%` } })));
  }
  const cls = big ? ' lg' : '';
  const more = h('button', { class: 'btn ghost more', title: 'More', 'aria-label': `More options for ${a.name}`, onclick: (e) => menu(e.currentTarget, [
    a.installed && { label: 'Show projects folder', action: () => api.reveal('projects', a.id) },
    { label: "What's new", action: () => go('whatsnew') },
    a.installed && { label: 'Uninstall…', danger: true, action: () => uninstall(a) },
  ]) }, svg(ICON.dots));
  const err = p && p.phase === 'error' ? h('div', { class: 'err' }, p.error) : null;
  if (!a.installed) return [err, h('button', { class: 'btn primary' + cls, onclick: () => install(a) }, err ? 'Try again' : 'Install'), big ? null : more];
  if (a.updateAvailable) return [err, h('button', { class: 'btn primary' + cls, onclick: () => install(a) }, 'Update'), h('button', { class: 'btn' + cls, onclick: () => api.launch(a.id) }, 'Open'), more];
  return [err, h('button', { class: 'btn primary' + cls, onclick: () => api.launch(a.id) }, 'Open'), more];
}
function statusPill(a) {
  if (a.updateAvailable) return h('span', { class: 'pill upd' }, `Update ${a.version}`);
  if (a.installed) return h('span', { class: 'pill ok' }, '✓ Installed');
  return null;
}

// ------------------------------------------------------------ views
const short = (a) => a.name.replace(/^Saw Forge\s+/, ''); // "Studio": app versions are labelled so they're never mistaken for the hub's
const matches = (a) => !query || [a.name, a.tagline, a.description, a.category].join(' ').toLowerCase().includes(query);
function card(a) {
  return h('div', { class: 'card', 'data-app-id': a.id },
    h('div', { class: 'card-top' }, h('img', { src: a.icon, alt: '' }), h('div', null, h('div', { class: 'card-name' }, a.name), h('div', { class: 'card-tag' }, a.tagline)), h('span', { style: { marginLeft: 'auto' } }, statusPill(a))),
    h('div', { class: 'card-desc' }, a.description),
    h('div', { class: 'card-foot' }, h('span', { class: 'ver' }, a.installed ? `${short(a)} ${a.installed}` : `${short(a)} ${a.version} · ${mb(a.size)}`), actionButtons(a, false)));
}
function hero(a) {
  return h('section', { class: 'hero', 'data-app-id': a.id },
    h('img', { src: a.icon, alt: '' }),
    h('div', null, h('div', { class: 'kicker' }, a.category || 'Featured'), h('h3', null, a.name), h('p', null, a.description),
      h('div', { class: 'meta' }, h('span', null, `${short(a)} ${a.version}`), h('span', null, mb(a.size)), h('span', null, 'Free · open source (GPL-3.0)'), statusPill(a))),
    h('div', { class: 'actions' }, actionButtons(a, true)));
}
function allView() {
  const apps = S.apps.filter(matches), out = [h('h1', null, 'All apps'), h('p', { class: 'sub' }, 'Free, open-source music software. Install with one click; updates arrive here.')];
  if (!apps.length) return [...out, h('div', { class: 'empty' }, `No apps match “${query}”.`)];
  if (!query) out.push(hero(apps[0]));
  out.push(h('h2', null, query ? 'Results' : 'Apps'), h('div', { class: 'grid' }, apps.map(card),
    query ? null : (S.comingSoon || []).map((c) => h('div', { class: 'card soon' }, h('div', { class: 'soon-icon' }, svg(ICON.plus)), h('div', { class: 'card-name' }, c.name), h('div', { class: 'card-desc' }, c.description)))));
  return out;
}
function listRows(apps, empty) {
  if (!apps.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'list' }, apps.map((a) => h('div', { class: 'row', 'data-app-id': a.id }, h('img', { src: a.icon, alt: '' }),
    h('div', { class: 'grow' }, h('div', { class: 'card-name' }, a.name, ' ', statusPill(a)), h('div', { class: 'card-tag' }, a.installed ? `${short(a)} ${a.installed} installed${a.updateAvailable ? ` · ${a.version} available` : ''}` : a.tagline)),
    actionButtons(a, false))));
}
function installedView() { return [h('h1', null, 'Installed'), h('p', { class: 'sub' }, 'Apps on this computer.'), listRows(S.apps.filter((a) => a.installed && matches(a)), 'Nothing installed yet. Pick an app under All apps.')]; }
function updatesView() {
  const ups = S.apps.filter((a) => a.updateAvailable);
  return [h('h1', null, 'Updates'), h('p', { class: 'sub' }, `Catalog checked ${ago(S.checkedAt)}.`),
    ups.length > 1 ? h('p', null, h('button', { class: 'btn primary', onclick: () => ups.forEach(install) }, 'Update all')) : null,
    listRows(ups, 'Everything is up to date.'), hubUpdateBlock()];
}
function hubUpdateBlock() {
  const u = S.hub.update || {};
  const text = { checking: 'Checking for a new version of the hub…', downloading: `Downloading Saw Forge Hub ${u.version || ''}${u.percent != null ? ` (${u.percent}%)` : ''}…`, ready: `Saw Forge Hub ${u.version} is ready to install.`,
    current: `Saw Forge Hub ${S.hub.version} is up to date.`, error: `Couldn't check for hub updates: ${u.error || 'unknown error'}`, unconfigured: 'Hub updates turn on once the project is published on GitHub.', dev: 'Running from source: hub updates are off.' }[u.status] || `Saw Forge Hub ${S.hub.version}.`;
  return h('div', { class: 'set', style: { marginTop: '18px' } }, h('img', { src: 'img/hub-icon.png', alt: '', width: 36, height: 36 }),
    h('div', { class: 'grow' }, h('div', { class: 't' }, 'Saw Forge Hub'), h('div', { class: 'd' }, text)),
    u.status === 'ready' ? h('button', { class: 'btn primary', onclick: () => api.hubUpdate('install') }, 'Restart to update') : h('button', { class: 'btn', onclick: () => api.hubUpdate('check') }, 'Check now'));
}
function whatsNewView() {
  return [h('h1', null, "What's new"), h('p', { class: 'sub' }, 'Release notes for the latest versions.'),
    S.apps.map((a) => h('div', { class: 'notes' }, h('div', { class: 'h' }, h('img', { src: a.icon, alt: '' }), h('b', null, `${a.name} ${a.version}`)), h('div', { class: 'card-desc' }, a.notes || 'Improvements and fixes.'))),
    h('p', null, h('button', { class: 'btn', onclick: () => api.open('releases') }, 'All releases on GitHub'))];
}
function settingsView() {
  const t = (key, title, desc) => h('div', { class: 'set' }, h('div', { class: 'grow' }, h('div', { class: 't' }, title), h('div', { class: 'd' }, desc)),
    h('button', { class: 'toggle' + (S.settings[key] ? ' on' : ''), role: 'switch', 'aria-checked': String(!!S.settings[key]), 'aria-label': title, onclick: async () => { S = await api.setSetting(key, !S.settings[key]); render(); } }));
  const win = S.hub.platform === 'win32';
  return [h('h1', null, 'Settings'), h('p', { class: 'sub' }, 'How Saw Forge Hub installs and updates apps.'),
    h('div', { class: 'settings' },
      t('autoUpdate', 'Check for updates automatically', 'Looks for new versions of the hub and your apps a few times a day.'),
      win ? t('desktopShortcuts', 'Desktop shortcuts for new apps', 'Apps always get a Start menu shortcut in the Saw Forge folder.') : null,
      t('openAtLogin', 'Open Saw Forge Hub when you sign in', 'Keeps app updates arriving in the background.'),
      h('div', { class: 'set' }, h('div', { class: 'grow' }, h('div', { class: 't' }, 'Your projects'), h('div', { class: 'd' }, h('code', null, S.paths.projects))), h('button', { class: 'btn', onclick: () => api.reveal('projects') }, 'Show')),
      h('div', { class: 'set' }, h('div', { class: 'grow' }, h('div', { class: 't' }, 'Installed apps'), h('div', { class: 'd' }, h('code', null, S.paths.apps))), h('button', { class: 'btn', onclick: () => api.reveal('apps') }, 'Show')),
      hubUpdateBlock())];
}
function aboutView() {
  return [h('div', { class: 'about' },
    h('div', { class: 'about-head' }, h('img', { src: 'img/hub-icon.png', alt: '' }), h('div', null, h('h1', null, 'Saw Forge Hub'), h('div', { class: 'card-tag' }, `Version ${S.hub.version} · ${S.hub.platform === 'darwin' ? 'macOS' : S.hub.platform === 'win32' ? 'Windows' : S.hub.platform} ${S.hub.arch}${S.hub.electron ? ` · Electron ${S.hub.electron}` : ''}`))),
    h('div', { class: 'legal' }, `Saw Forge Hub and the Saw Forge apps are free software by ${S.publisher}: you can redistribute and/or modify them under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. They are distributed in the hope that they will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.`),
    h('div', { class: 'links' }, h('button', { class: 'btn', onclick: () => api.open('source') }, 'Source code'), h('button', { class: 'btn', onclick: () => api.open('license') }, 'License (GPL-3.0)'),
      h('button', { class: 'btn', onclick: () => api.open('website') }, 'Website'), h('button', { class: 'btn', onclick: () => api.open('issues') }, 'Report a problem')))];
}

function render() {
  if (!S) return;
  document.querySelectorAll('.side [data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === view));
  const ups = S.apps.filter((a) => a.updateAvailable).length, badge = $('#upd-badge');
  badge.hidden = !ups; badge.textContent = String(ups);
  const main = $('#view'), scroll = main.scrollTop;
  main.replaceChildren(...[].concat({ all: allView, installed: installedView, updates: updatesView, whatsnew: whatsNewView, settings: settingsView, about: aboutView }[view]()).flat().filter(Boolean));
  main.scrollTop = scroll;
  $('#status-left').replaceChildren(h('span', { class: 'dot' + (S.catalogSource === 'online' ? '' : S.catalogError ? ' warn' : ' off') }),
    S.catalogSource === 'online' ? `Catalog up to date · checked ${ago(S.checkedAt)}` : S.catalogError ? 'Offline: showing the apps included with the hub' : 'Apps included with this version of the hub');
  $('#status-right').textContent = `${S.apps.filter((a) => a.installed).length} of ${S.apps.length} installed · Saw Forge Hub ${S.hub.version}`;
  $('#hub-ver').textContent = S.hub.version;
}
function go(v) { view = v; render(); $('#view').focus(); }

// ------------------------------------------------------------ wiring
document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
document.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => api.open(b.dataset.link)));
$('#q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); if (!['all', 'installed'].includes(view)) view = 'all'; render(); });
$('#refresh').addEventListener('click', async (e) => { const b = e.currentTarget; b.classList.add('spin'); S = await api.refresh(); b.classList.remove('spin'); render(); toast(S.apps.some((a) => a.updateAvailable) ? 'Updates are available.' : 'Everything is up to date.'); });
api.on('state', (s) => { S = s; render(); });
api.on('progress', (p) => {
  if (p.phase === 'done') progress.delete(p.id); else progress.set(p.id, p);
  const el = document.querySelector(`[data-app-id="${CSS.escape(p.id)}"] .progress`);
  if (el && p.phase === 'downloading' && p.total) {
    el.querySelector('i').style.width = `${Math.round((p.received / p.total) * 100)}%`; el.querySelector('.bar').classList.remove('indet');
    el.querySelector('.lbl span:first-child').textContent = 'Downloading…'; el.querySelector('.lbl span:last-child').textContent = `${mb(p.received)} of ${mb(p.total)}`;
  }
  else render();
});
api.on('hubUpdate', (u) => { if (S) { S.hub.update = u; if (u.status === 'ready') toast(`Saw Forge Hub ${u.version} is ready — restart to update.`, 6000); render(); } });
api.state().then((s) => { S = s; render(); });

// ------------------------------------------------------------ demo (only when opened outside the desktop app)
function demoApi() {
  const listeners = {};
  const emit = (ev, d) => (listeners[ev] || []).forEach((f) => f(d));
  const state = {
    hub: { version: '1.0.0', platform: navigator.userAgent.includes('Mac') ? 'darwin' : 'win32', arch: 'x64', packaged: false, update: { status: 'dev' } },
    configured: false, publisher: 'Saw Forge', catalogSource: 'bundled', catalogError: null, checkedAt: Date.now(), comingSoon: [{ name: 'More Saw Forge apps', description: 'New instruments and tools will appear here and install with one click.' }],
    settings: { desktopShortcuts: true, autoUpdate: true, openAtLogin: false }, paths: { projects: 'C:\\Users\\you\\Documents\\Saw Forge', apps: 'C:\\Users\\you\\AppData\\Local\\Saw Forge Hub\\apps' },
    apps: [{ id: 'saw-forge-studio', name: 'Saw Forge Studio', tagline: 'Music production studio', category: 'Music production', version: '1.0.0', size: 415000, installed: null, updateAvailable: false, icon: 'img/studio-icon.png', dataDir: 'Documents\\Saw Forge\\Saw Forge Studio',
      description: 'Arrange, record and mix with the Saw Forge wavetable synth, Worship Atmospheres pads, virtual EDM drummers, take comping and automation.', notes: 'First desktop release.' }],
  };
  const snap = () => JSON.parse(JSON.stringify(state));
  return {
    state: async () => snap(), refresh: async () => snap(), cancel: async () => {}, reveal: async () => {}, open: async () => {}, hubUpdate: async () => state.hub.update,
    setSetting: async (k, v) => { state.settings[k] = v; return snap(); },
    launch: async () => toast('In the desktop app this opens Saw Forge Studio in its own window.'),
    uninstall: async (id) => { state.apps.find((a) => a.id === id).installed = null; emit('state', snap()); return { ok: true }; },
    install: (id) => new Promise((done) => {
      const a = state.apps.find((x) => x.id === id), total = a.size;
      let got = 0;
      const step = () => {
        got = Math.min(total, got + total / 18);
        emit('progress', { id, phase: 'downloading', received: got, total });
        if (got < total) return setTimeout(step, 70);
        emit('progress', { id, phase: 'verifying' });
        setTimeout(() => { emit('progress', { id, phase: 'installing' }); setTimeout(() => { a.installed = a.version; emit('progress', { id, phase: 'done' }); emit('state', snap()); done({ ok: true, version: a.version }); }, 400); }, 400);
      };
      step();
    }),
    on: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); return () => {}; },
  };
}
