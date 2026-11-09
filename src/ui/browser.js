// Browser: instruments, presets, effects and samples. Items can be
// double-clicked (apply to the selected track) or dragged onto the
// arrangement, a track, or a mixer strip.

import { h } from './dom.js';
import { icon } from './icons.js';
import { contextMenu, toast } from './widgets.js';
import { EFFECT_DEFS, EFFECT_TYPES } from '../shared/params.js';
import { PRESET_CATEGORIES } from '../shared/presets.js';
import { WORSHIP_COLLECTIONS } from '../shared/worship-presets.js';
import { DRUMMERS } from '../shared/drummers.js';
import { isDrumTrack } from '../core/project.js';

export const DND_TYPE = 'application/x-sawforge';
export let currentDrag = null; // payload while dragging (dataTransfer is unreadable during dragover)

export class BrowserPanel {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.query = '';
    this.collapsed = new Set(['Samples:Project', ...WORSHIP_COLLECTIONS.slice(1).map((c) => 'W:' + c.name)]);
    this.search = h('input', { class: 'browser-search', placeholder: 'Search presets, effects, samples', spellcheck: false });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { this.search.value = ''; this.query = ''; this.render(); this.search.blur(); } });
    this.list = h('div', { class: 'browser-list' });
    this.el = h('aside', { class: 'browser' },
      h('div', { class: 'panel-head' }, h('span', { class: 'panel-title' }, 'Browser'),
        h('button', { class: 'ibtn sm', title: 'Import audio files…', onClick: () => shell.importAudio() }, icon('plus', 14))),
      h('div', { class: 'browser-search-wrap' }, icon('search', 14), this.search),
      this.list);
    this.render();
  }

  refresh(d) {
    if (d.scope === 'all' || d.scope === 'clips' || (d.scope === 'ui' && (d.what === 'presets' || d.what === 'project' || d.what === 'track'))) this.render();
  }

  item(label, payload, opts = {}) {
    const el = h('div', { class: 'b-item' + (opts.cls ? ' ' + opts.cls : ''), draggable: true, title: opts.title || '' },
      h('span', { class: 'b-ico' }, opts.icon ? icon(opts.icon, 14) : h('span', { class: 'b-dot', style: { background: opts.color || 'var(--text-3)' } })),
      h('span', { class: 'b-label' }, label),
      opts.meta ? h('span', { class: 'b-meta' }, opts.meta) : null);
    el.addEventListener('dragstart', (e) => {
      currentDrag = payload;
      e.dataTransfer.setData(DND_TYPE, JSON.stringify({ kind: payload.kind, name: payload.name }));
      e.dataTransfer.setData('text/plain', label);
      e.dataTransfer.effectAllowed = 'copy';
      document.body.classList.add('dnd-active');
    });
    el.addEventListener('dragend', () => { currentDrag = null; document.body.classList.remove('dnd-active'); this.shell.arrange.clearDrop(); });
    el.addEventListener('dblclick', () => this.activate(payload));
    el.addEventListener('click', () => { if (payload.kind === 'sample') this.preview(payload.sample); });
    if (opts.context) el.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, opts.context()); });
    return el;
  }

  section(key, title, items, ic) {
    const shown = items.filter(Boolean);
    if (this.query && !shown.length) return null;
    const open = this.query ? true : !this.collapsed.has(key);
    const head = h('div', { class: 'b-head' + (open ? ' open' : ''), onClick: () => { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); this.render(); } },
      h('span', { class: 'b-chev' }, icon('chevron', 12)), ic ? icon(ic, 14) : null, h('span', null, title), h('span', { class: 'b-count' }, String(shown.length)));
    return h('div', { class: 'b-section' }, head, open ? h('div', { class: 'b-body' }, shown) : null);
  }

  match(...strs) { return !this.query || strs.some((s) => String(s).toLowerCase().includes(this.query)); }

  render() {
    const app = this.app;
    const presets = app.allPresets();
    const cats = [...PRESET_CATEGORIES, 'User'];
    const out = [];
    out.push(this.section('Instruments', 'Instruments', [
      this.match('saw forge', 'synth', 'instrument') ? this.item('Saw Forge', { kind: 'instrument', name: 'Saw Forge' }, { icon: 'synth', cls: 'accent', meta: 'synth', title: 'Wavetable analog synth — drag to the arrangement or double-click to add a track' }) : null,
      this.match('drummer', 'drums', 'edm', 'beat', 'instrument', 'kit') ? this.item('Drummer', { kind: 'drumkit', name: 'Drummer' }, { icon: 'metro', cls: 'accent', meta: 'drums', title: 'Virtual EDM drummer + synthesized kit — double-click or drag to add a Drummer track' }) : null,
      this.match('worship atmospheres', 'pad', 'instrument', 'strings') ? this.item('Worship Atmospheres', { kind: 'worship', name: 'Worship Atmospheres' }, { icon: 'live', cls: 'accent', meta: 'pads', title: 'Sustaining worship pad engine — double-click to add a track; use LIVE PAD (P) to play it without the timeline' }) : null,
    ], 'synth'));
    const drummers = DRUMMERS.filter((d) => this.match(d.name, d.genre, ...d.traits, 'drummer', 'drums', 'edm'));
    if (drummers.length) out.push(this.section('Drummers', 'EDM Drummers', drummers.map((d) => this.item(`${d.name} — ${d.genre}`, { kind: 'drummer', name: d.name, id: d.id }, {
      color: d.color, meta: d.traits[0], title: `${d.blurb}\nPersonality: ${d.traits.join(', ')} · ${d.bpm} BPM · kit ${d.kit}\nDouble-click: this drummer plays the selected Drummer track (or adds one)` })), 'metro'));
    const wNodes = [];
    for (const c of WORSHIP_COLLECTIONS) {
      const list = c.presets.filter((p) => this.match(p.name, c.name, 'worship', 'pad'));
      if (!list.length) continue;
      wNodes.push(this.section('W:' + c.name, c.name, list.map((p) => this.item(p.name, { kind: 'wpreset', name: p.name }, { color: '#8fb8ff', title: `${p.desc}\nDouble-click: load on the selected Worship track (or the live pad when Live Pad Mode is open)` }))));
    }
    if (wNodes.length) out.push(h('div', { class: 'b-group' }, h('div', { class: 'b-group-title' }, 'Worship Atmospheres'), wNodes));
    const presetNodes = [];
    for (const cat of cats) {
      const list = presets.filter((p) => p.category === cat && this.match(p.name, cat));
      if (!list.length) continue;
      presetNodes.push(this.section('Presets:' + cat, cat, list.map((p) => this.item(p.name, { kind: 'preset', name: p.name, preset: p }, {
        color: cat === 'User' ? 'var(--sel)' : 'var(--accent)', title: 'Double-click to load on the selected Saw Forge track; drag onto a track or empty space',
        context: cat === 'User' ? () => [{ label: 'Delete preset', danger: true, action: () => app.deleteUserPreset(p.name) }] : null,
      }))));
    }
    if (presetNodes.length) out.push(h('div', { class: 'b-group' }, h('div', { class: 'b-group-title' }, 'Saw Forge Presets'), presetNodes));
    out.push(this.section('Effects', 'Audio Effects', EFFECT_TYPES.filter((t) => this.match(EFFECT_DEFS[t].name, t)).map((t) => this.item(EFFECT_DEFS[t].name, { kind: 'effect', name: t }, { icon: 'fx', title: 'Double-click to add to the selected channel, or drag onto a track or mixer strip' })), 'fx'));
    out.push(this.section('Samples:Factory', 'Drum Kit', app.factorySamples.filter((s) => this.match(s.name, 'drum', 'sample')).map((s) => this.item(s.name, { kind: 'sample', name: s.name, sample: s }, { icon: 'wave', title: 'Click to preview; drag onto the arrangement' })), 'wave'));
    const projAssets = app.p.assets.filter((a) => !a.factory && this.match(a.name, 'sample'));
    if (projAssets.length) {
      out.push(this.section('Samples:Project', 'Project Audio', projAssets.map((a) => {
        const item = app.assets.get(a.id);
        return this.item(a.name, { kind: 'asset', name: a.name, assetId: a.id }, { icon: 'wave', cls: item && item.missing ? 'missing' : '', meta: item && item.missing ? 'offline' : item ? `${item.duration.toFixed(1)}s` : '' });
      }), 'file'));
    }
    this.list.replaceChildren(...out.filter(Boolean));
    if (!this.list.children.length) this.list.append(h('div', { class: 'empty-note' }, 'No matches'));
  }

  async activate(pl) {
    const app = this.app;
    const sel = app.selectedTrack;
    if (pl.kind === 'instrument') app.addInstrumentTrack();
    else if (pl.kind === 'drumkit') app.addDrummerTrack();
    else if (pl.kind === 'drummer') {
      if (isDrumTrack(sel)) { const c = app.drummerTarget(sel.id); app.chooseDrummer(sel.id, pl.id, c ? c.id : null); toast(`${pl.name} is now playing ${sel.name}`); }
      else app.addDrummerTrack(pl.id);
    }
    else if (pl.kind === 'worship') app.addWorshipTrack();
    else if (pl.kind === 'wpreset') {
      if (app.ui.live) app.loadPadPreset('livepad', pl.name);
      else if (sel && sel.instrument && sel.instrument.type === 'worship') { app.loadPadPreset(sel.id, pl.name); toast(`Loaded ${pl.name} on ${sel.name}`); }
      else app.addWorshipTrack(pl.name);
    }
    else if (pl.kind === 'preset') {
      if (sel && sel.kind === 'instrument' && sel.instrument.type === 'sawforge') { app.loadPreset(sel.id, pl.preset); toast(`Loaded ${pl.preset.name} on ${sel.name}`); }
      else app.addInstrumentTrack(pl.preset);
    } else if (pl.kind === 'effect') {
      const ch = app.selectedChannel;
      app.addInsert(ch.id, pl.name);
      toast(`Added ${EFFECT_DEFS[pl.name].name} to ${ch.name}`);
    } else if (pl.kind === 'sample') {
      await app.ensureAudio();
      app.addFactorySample(pl.sample, sel && sel.kind === 'audio' ? sel.id : null, app.ui.cursor);
    } else if (pl.kind === 'asset') {
      const item = app.assets.get(pl.assetId);
      if (item && !item.missing) app.placeAsset(item, sel && sel.kind === 'audio' ? sel.id : null, app.ui.cursor);
    }
  }

  async preview(sample) {
    const app = this.app;
    if (!(await app.ensureAudio())) return;
    const ctx = app.engine.ctx;
    try {
      if (!this.previewCache) this.previewCache = new Map();
      let buf = this.previewCache.get(sample.id);
      if (!buf) { buf = await ctx.decodeAudioData(sample.bytes.slice(0)); this.previewCache.set(sample.id, buf); }
      if (this.previewSrc) try { this.previewSrc.stop(); } catch { /* ignore */ }
      const src = ctx.createBufferSource(), g = ctx.createGain();
      g.gain.value = 0.7;
      src.buffer = buf; src.connect(g).connect(ctx.destination); src.start();
      this.previewSrc = src;
    } catch { /* preview is best-effort */ }
  }
}
