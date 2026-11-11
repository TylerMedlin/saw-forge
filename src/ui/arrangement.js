// Arrangement view: track headers, timeline ruler (markers, loop, bars),
// clips, automation lanes, playhead. Canvas-rendered; static content redraws
// on change, the playhead overlay redraws every frame.

import { h, drag, Surface, clamp, css } from './dom.js';
import { icon } from './icons.js';
import { HSlider, contextMenu, selectEl, toast, promptText } from './widgets.js';
import { DND_TYPE, currentDrag } from './browser.js';
import { findChannel, findClip, findTrack, barBeats, projectEndBeat, TRACK_COLORS, cloneJSON, uid, isDrumTrack, clipFits } from '../core/project.js';
import { instDefs } from '../shared/instruments.js';
import { PIECES } from '../shared/drums.js';
import { generateDrummer, drummerById, SPEED_NAMES } from '../shared/drummers.js';
import { generatePianist } from '../shared/pianist.js';
import { songContext } from '../audio/compile.js';
import { SYNTH_PARAMS, SYNTH_DEF, EFFECT_DEFS, MIX_PARAMS, toNorm, fromNorm, formatValue, faderDbToNorm } from '../shared/params.js';
import { WORSHIP_PARAMS, WP_DEF } from '../shared/worship-params.js';
import { usedRanges, laneUsage } from '../core/comp.js';

const RULER_H = 54, HEAD_W = 236, LANE_H = 54, TAKE_H = 44, BUS_H = 40, CLIP_HEAD = 15, EDGE = 6;
const SNAP_OPTIONS = [['auto', 'Auto grid'], ['bar', 'Bar'], ['2', '1/2'], ['1', '1/4'], ['0.5', '1/8'], ['0.25', '1/16'], ['0.125', '1/32'], ['0.3333333333', '1/8 T'], ['0.1666666667', '1/16 T'], ['off', 'Off']];

export const inputLabel = (v) => (v === 'L' ? '1' : v === 'R' ? '2' : '1+2');

export function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Automation targets for a channel, grouped for a <select>.
export function laneTargets(p, ch) {
  const groups = [];
  const mix = [{ value: 'mix:vol', label: 'Volume' }, { value: 'mix:pan', label: 'Pan' }];
  if ('clips' in ch) for (const b of p.buses) mix.push({ value: `mix:send:${b.id}`, label: `Send → ${b.name}` });
  groups.push({ group: 'Mixer', options: mix });
  if (ch.instrument) { const D = instDefs(ch.instrument); groups.push({ group: D.label, options: D.PARAMS.filter((d) => d.automatable).map((d) => ({ value: `inst:${d.id}`, label: d.name })) }); }
  ch.inserts.forEach((fx, i) => {
    groups.push({ group: `${i + 1}. ${EFFECT_DEFS[fx.type].name}`, options: EFFECT_DEFS[fx.type].params.filter((d) => d.automatable).map((d) => ({ value: `fx:${fx.id}:${d.id}`, label: d.name })) });
  });
  return groups;
}
// Parameter definition + current manual value (normalized) for a lane target.
export function targetInfo(p, ch, target) {
  const parts = target.split(':');
  if (parts[0] === 'mix') {
    if (parts[1] === 'vol') return { def: MIX_PARAMS.vol, norm: faderDbToNorm(ch.vol), name: 'Volume' };
    if (parts[1] === 'pan') return { def: MIX_PARAMS.pan, norm: (ch.pan + 1) / 2, name: 'Pan' };
    const bus = p.buses.find((b) => b.id === parts[2]);
    const s = (ch.sends || []).find((x) => x.busId === parts[2]);
    return { def: MIX_PARAMS.send, norm: faderDbToNorm(s ? s.level : -70), name: `Send → ${bus ? bus.name : '?'}` };
  }
  if (parts[0] === 'inst' && ch.instrument) {
    const def = instDefs(ch.instrument).DEF[parts[1]];
    if (def) return { def, norm: toNorm(def, ch.instrument.params[def.id]), name: def.name };
  }
  if (parts[0] === 'fx') {
    const fx = ch.inserts.find((f) => f.id === parts[1]);
    if (fx) { const def = EFFECT_DEFS[fx.type].params.find((d) => d.id === parts[2]); if (def) return { def, norm: toNorm(def, fx.params[def.id]), name: `${EFFECT_DEFS[fx.type].short} ${def.name}` }; }
  }
  return null;
}
export function laneValueAt(points, beat) {
  if (!points.length) return null;
  if (beat <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (beat >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] >= beat) { const a = points[i - 1], b = points[i]; return b[0] > a[0] ? a[1] + ((b[1] - a[1]) * (beat - a[0])) / (b[0] - a[0]) : b[1]; }
  }
  return last[1];
}

export class Arrangement {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.ppb = 26; this.scrollX = 0; this.scrollY = 0;
    this.rows = []; this.totalH = 0;
    this.heads = new Map();
    this.dirty = true; this.op = null; this.band = null; this.drop = null; this.hover = null;
    this.C = null;

    const tb = (ic, label, title, fn) => h('button', { class: 'btn ghost sm', title, onClick: fn }, icon(ic, 14), label ? h('span', null, label) : null);
    this.snapSel = selectEl(SNAP_OPTIONS.map(([v, l]) => ({ value: v, label: l })), 'auto', (v) => { app.ui.snap = v; this.invalidate(); }, 'snap-sel', 'Snap grid (hold Alt while dragging to bypass)');
    this.followBtn = h('button', { class: 'ibtn sm toggle on', title: 'Follow playhead', onClick: () => { app.ui.follow = !app.ui.follow; this.followBtn.classList.toggle('on', app.ui.follow); } }, icon('follow', 14));
    this.toolbar = h('div', { class: 'arr-toolbar' },
      tb('plus', 'Instrument', 'New Saw Forge track (Ctrl+Alt+T)', () => app.addInstrumentTrack()),
      tb('plus', 'Audio', 'New audio track (Ctrl+Alt+A)', () => app.addAudioTrack()),
      tb('plus', 'Drummer', 'New Drummer track: a virtual EDM drummer plays an 8-bar region', () => app.addDrummerTrack()),
      tb('plus', 'Bus', 'New return bus with reverb (Ctrl+Alt+R)', () => app.addBus(true)),
      h('div', { class: 'tb-sep' }),
      h('span', { class: 'tb-label' }, icon('magnet', 14)), this.snapSel,
      h('div', { class: 'tb-sep' }),
      h('button', { class: 'ibtn sm', title: 'Zoom out (−)', onClick: () => this.zoomBy(1 / 1.4) }, icon('zoomOut', 14)),
      h('button', { class: 'ibtn sm', title: 'Zoom in (+)', onClick: () => this.zoomBy(1.4) }, icon('zoomIn', 14)),
      h('button', { class: 'btn ghost sm', title: 'Zoom to fit the arrangement', onClick: () => this.zoomFit() }, 'Fit'),
      this.followBtn,
      h('div', { class: 'tb-spacer' }),
      this.hint = h('span', { class: 'arr-hint' }, 'Double-click an instrument lane to create a clip'));

    this.rulerCv = h('canvas', { class: 'arr-ruler-cv' });
    this.mainCv = h('canvas', { class: 'arr-main-cv' });
    this.overCv = h('canvas', { class: 'arr-over-cv' });
    this.headInner = h('div', { class: 'arr-heads-inner' });
    this.headCol = h('div', { class: 'arr-heads' }, this.headInner);
    this.lanes = h('div', { class: 'arr-lanes', tabIndex: 0 }, this.mainCv, this.overCv);
    this.hThumb = h('div', { class: 'hscroll-thumb' });
    this.hScroll = h('div', { class: 'hscroll' }, this.hThumb);
    this.corner = h('div', { class: 'arr-corner' });
    this.el = h('section', { class: 'arrange' }, this.toolbar,
      h('div', { class: 'arr-grid', style: { gridTemplateColumns: `${HEAD_W}px 1fr` } },
        this.corner, h('div', { class: 'arr-ruler' }, this.rulerCv), this.headCol, this.lanes),
      h('div', { class: 'arr-bottom', style: { paddingLeft: `${HEAD_W}px` } }, this.hScroll));

    this.ruler = new Surface(this.rulerCv, () => { this.dirty = true; });
    this.main = new Surface(this.mainCv, () => { this.dirty = true; });
    this.over = new Surface(this.overCv, () => {});

    this.lanes.addEventListener('pointerdown', (e) => this.onDown(e));
    this.lanes.addEventListener('pointermove', (e) => this.onHover(e));
    this.lanes.addEventListener('pointerleave', () => { this.hover = null; this.mainCv.style.cursor = ''; });
    this.lanes.addEventListener('dblclick', (e) => this.onDbl(e));
    this.lanes.addEventListener('contextmenu', (e) => this.onContext(e));
    this.lanes.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.headCol.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rulerCv.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.rulerCv.addEventListener('dblclick', (e) => this.onRulerDbl(e));
    this.rulerCv.addEventListener('contextmenu', (e) => this.onRulerContext(e));
    this.rulerCv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rulerCv.addEventListener('pointermove', (e) => this.onRulerHover(e));
    this.hScroll.addEventListener('pointerdown', (e) => this.onScrollbar(e));
    for (const el of [this.lanes, this.headCol]) {
      el.addEventListener('dragover', (e) => this.onDragOver(e));
      el.addEventListener('dragleave', () => this.clearDrop());
      el.addEventListener('drop', (e) => this.onDrop(e));
    }
    this.el.addEventListener('pointerdown', () => { app.ui.focus = 'arrange'; }, true);
  }

  colors() {
    if (!this.C) this.C = {
      bg: css('--bg-0') || '#101214', row: css('--bg-1') || '#15181b', rowAlt: '#14171a', sel: 'rgba(92,179,255,0.06)',
      grid: 'rgba(255,255,255,0.035)', gridBeat: 'rgba(255,255,255,0.06)', gridBar: 'rgba(255,255,255,0.12)', line: css('--line') || '#2c3238',
      text: css('--text') || '#d9dde1', text2: css('--text-2') || '#a3abb3', text3: css('--text-3') || '#6f7880',
      accent: css('--accent') || '#ff8f3c', selc: css('--sel') || '#5cb3ff', rec: css('--rec') || '#ff4d55',
    };
    return this.C;
  }

  invalidate() { this.dirty = true; }
  get W() { return this.main.w; }
  get H() { return this.main.h; }
  x(beat) { return (beat - this.scrollX) * this.ppb; }
  beat(x) { return this.scrollX + x / this.ppb; }

  gridUnit() {
    const p = this.app.p, bar = barBeats(p);
    const sv = this.app.ui.snap;
    if (sv === 'off') return 0;
    if (sv === 'bar') return bar;
    if (sv !== 'auto') return parseFloat(sv);
    for (const u of [0.125, 0.25, 0.5, 1, 2, bar, bar * 2, bar * 4, bar * 8, bar * 16]) if (u * this.ppb >= 16) return u;
    return bar * 16;
  }
  snap(b, ev, mode = 'round') {
    const u = this.gridUnit();
    if (!u || (ev && ev.altKey)) return b;
    return (mode === 'floor' ? Math.floor(b / u + 1e-6) : Math.round(b / u)) * u;
  }

  // ------------------------------------------------------------ rows & headers
  computeRows() {
    const p = this.app.p, rows = [];
    let y = 0;
    const lanes = (ch) => { if (ch.showLanes) for (const lane of ch.automation) { rows.push({ kind: 'lane', ch, lane, y, h: LANE_H, key: 'lane:' + lane.id }); y += LANE_H; } };
    const takes = (t) => { if (t.kind === 'audio' && t.showTakes) for (const lane of t.takeLanes || []) { rows.push({ kind: 'take', ch: t, lane, y, h: TAKE_H, key: 'take:' + lane.id }); y += TAKE_H; } };
    p.tracks.forEach((t, i) => { const hh = t.height || 64; rows.push({ kind: 'track', ch: t, index: i, y, h: hh, key: 'trk:' + t.id }); y += hh; takes(t); lanes(t); });
    if (p.buses.length || true) { rows.push({ kind: 'divider', y, h: 22, key: 'divider' }); y += 22; }
    for (const b of p.buses) { rows.push({ kind: 'bus', ch: b, y, h: BUS_H, key: 'bus:' + b.id }); y += BUS_H; lanes(b); }
    rows.push({ kind: 'master', ch: p.master, y, h: BUS_H, key: 'master' }); y += BUS_H; lanes(p.master);
    this.rows = rows; this.totalH = y;
  }
  rowAt(y) { const cy = y + this.scrollY; return this.rows.find((r) => cy >= r.y && cy < r.y + r.h) || null; }
  trackRows() { return this.rows.filter((r) => r.kind === 'track'); }

  renderHeads() {
    const app = this.app, p = app.p, seen = new Set();
    this.headInner.style.height = `${this.totalH + 200}px`;
    for (const r of this.rows) {
      seen.add(r.key);
      let hd = this.heads.get(r.key);
      if (!hd) { hd = this.makeHead(r); this.heads.set(r.key, hd); this.headInner.append(hd.el); }
      hd.row = r;
      hd.el.style.top = `${r.y}px`; hd.el.style.height = `${r.h}px`;
      hd.update(r);
    }
    for (const [k, hd] of this.heads) if (!seen.has(k)) { hd.el.remove(); this.heads.delete(k); }
    this.headInner.style.transform = `translateY(${-this.scrollY}px)`;
    this.corner.textContent = '';
    this.corner.append(h('span', { class: 'corner-title' }, `${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'}`), h('span', { class: 'corner-sub' }, `${p.tempo.toFixed(p.tempo % 1 ? 1 : 0)} BPM · ${p.sigNum}/${p.sigDen}`));
  }

  makeHead(r) {
    const app = this.app;
    if (r.kind === 'divider') {
      const el = h('div', { class: 'th-divider' }, h('span', null, 'Returns & Master'));
      return { el, update() {} };
    }
    if (r.kind === 'lane') return this.makeLaneHead(r);
    if (r.kind === 'take') return this.makeTakeHead(r);
    const id = r.ch.id;
    const isMaster = r.kind === 'master', isBus = r.kind === 'bus';
    const bMute = h('button', { class: 'th-btn mute', title: 'Mute', onClick: (e) => { e.stopPropagation(); app.toggleChannel(id, 'mute'); } }, 'M');
    const bSolo = h('button', { class: 'th-btn solo', title: 'Solo (Ctrl+click: exclusive)', onClick: (e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey) app.exclusiveSolo(id); else app.toggleChannel(id, 'solo'); } }, 'S');
    const bArm = h('button', { class: 'th-btn arm', title: 'Arm for MIDI recording / live input', onClick: (e) => { e.stopPropagation(); app.toggleChannel(id, 'arm'); } }, 'R');
    const bAuto = h('button', { class: 'th-btn auto', title: 'Show automation lanes', onClick: (e) => { e.stopPropagation(); this.toggleLanes(id); } }, icon('automation', 12));
    const bTakes = h('button', { class: 'th-btn takes', title: 'Show take lanes (every recorded take, for comping)', onClick: (e) => { e.stopPropagation(); app.toggleTakes(id); } }, icon('takes', 12));
    const bMon = h('button', { class: 'th-btn mon', title: 'Monitor: hear the input through this track while it is armed (use headphones)', onClick: (e) => { e.stopPropagation(); app.toggleChannel(id, 'monitor'); } }, icon('headphones', 12));
    const name = h('div', { class: 'th-name' });
    const sub = h('div', { class: 'th-sub' });
    const vol = new HSlider({ def: MIX_PARAMS.vol, value: r.ch.vol, class: 'th-vol', title: 'Volume',
      onBegin: () => app.mixBegin('Change volume'), onInput: (v) => app.mixLive(id, 'vol', v), onEnd: () => app.mixEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(id, 'mix:vol')) });
    const color = h('div', { class: 'th-color', title: 'Track color', onClick: (e) => { e.stopPropagation(); this.colorMenu(e, id); } });
    const kindIcon = h('span', { class: 'th-kind' }, icon(isMaster ? 'mixer' : isBus ? 'bus' : r.ch.kind === 'audio' ? 'wave' : 'synth', 13));
    const resize = h('div', { class: 'th-resize', title: 'Drag to resize track' });
    const btns = [bMute, isMaster ? null : bSolo, r.kind === 'track' ? bArm : null, r.kind === 'track' && r.ch.kind === 'audio' ? bMon : null, r.kind === 'track' && r.ch.kind === 'audio' ? bTakes : null, bAuto].filter(Boolean);
    const el = h('div', { class: 'th th-' + r.kind },
      color,
      h('div', { class: 'th-main' },
        h('div', { class: 'th-row1' }, kindIcon, name),
        r.kind === 'track' ? sub : null,
        h('div', { class: 'th-row2' }, h('div', { class: 'th-btns' }, btns), vol.el)),
      r.kind === 'track' ? resize : null);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, .hslider, .th-color, .th-resize')) return;
      app.selectTrack(id, { openInstrument: false });
      if (r.kind === 'track') this.headReorder(e, id);
    });
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('button, .hslider')) app.promptRename(id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.headMenu(e, r.ch, r.kind); });
    resize.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const y0 = e.clientY, h0 = r.ch.height || 64;
      drag(e, { cursor: 'ns-resize', move: (ev) => { app.store.live((p) => { const t = findTrack(p, id); if (t) t.height = clamp(h0 + ev.clientY - y0, 40, 220); }, 'tracks'); } });
    });
    return {
      el,
      update: (row) => {
        const ch = row.ch;
        el.classList.toggle('selected', app.ui.selTrack === id);
        name.textContent = ch.name;
        color.style.background = ch.color || '#888';
        el.style.setProperty('--tc', ch.color || '#888');
        bMute.classList.toggle('on', !!ch.mute);
        bSolo.classList.toggle('on', !!ch.solo);
        bArm.classList.toggle('on', !!ch.arm);
        bMon.classList.toggle('on', !!ch.monitor);
        const nt = (ch.takeLanes || []).length;
        bTakes.classList.toggle('on', !!ch.showTakes && nt > 0);
        bTakes.classList.toggle('none', nt === 0);
        bTakes.title = nt ? `${ch.showTakes ? 'Hide' : 'Show'} take lanes (${nt} take${nt > 1 ? 's' : ''}): swipe across takes to comp` : 'No takes yet: every take you record here is kept for comping';
        bArm.title = ch.kind === 'audio' ? 'Arm for audio recording (opens the audio input)' : 'Arm for MIDI recording / live input';
        bAuto.classList.toggle('on', !!ch.showLanes);
        if (!vol.dragging) vol.set(ch.vol);
        vol.setAutomated(app.hasAutomation(id, 'mix:vol'));
        if (row.kind === 'track') {
          const out = ch.output && ch.output !== 'master' ? (findChannel(app.p, ch.output) || {}).name : null;
          sub.textContent = ch.kind === 'instrument' ? `${ch.instrument.type === 'worship' ? 'Worship' : ch.instrument.type === 'drums' ? 'Drummer · kit' : ch.instrument.type === 'piano' ? 'Session Pianist' : 'Saw Forge'} · ${ch.instrument.preset}${out ? ' → ' + out : ''}`
            : `Audio · In ${inputLabel(ch.input)}${ch.monitor ? ' · monitoring' : ''}${out ? ' → ' + out : ''}`;
          el.classList.toggle('compact', row.h < 56);
        }
      },
    };
  }

  makeLaneHead(r) {
    const app = this.app;
    const valEl = h('span', { class: 'lh-val' });
    let sel = null;
    const del = h('button', { class: 'ibtn xs', title: 'Remove lane', onClick: () => app.removeLane(r.ch.id, r.lane.id) }, icon('close', 12));
    const wrap = h('div', { class: 'lh-sel' });
    const el = h('div', { class: 'lh' }, h('div', { class: 'lh-row' }, wrap, del), valEl);
    let lastKey = '';
    return {
      el,
      update: (row) => {
        const p = app.p, ch = row.ch, lane = row.lane;
        const key = lane.target + '|' + ch.inserts.map((f) => f.id).join(',') + '|' + p.buses.map((b) => b.id + b.name).join(',');
        if (key !== lastKey) {
          lastKey = key;
          sel = selectEl(laneTargets(p, ch), lane.target, (v) => {
            app.store.do('Change automation target', (q) => { const c = findChannel(q, ch.id); const l = c.automation.find((a) => a.id === lane.id); if (l) { l.target = v; l.points = []; } }, 'auto', { id: ch.id });
          }, 'lane-target', 'Automated parameter');
          wrap.replaceChildren(sel);
        }
        const info = targetInfo(p, ch, lane.target);
        el.style.setProperty('--tc', ch.color || '#888');
        const beat = app.isPlaying ? app.engine.position : app.ui.cursor;
        const v = laneValueAt(lane.points, beat);
        valEl.textContent = info ? (v === null ? `${formatValue(info.def, fromNorm(info.def, info.norm))} · no points` : formatValue(info.def, fromNorm(info.def, v))) : 'unavailable';
      },
    };
  }

  makeTakeHead(r) {
    const app = this.app;
    let row = r;
    const name = h('div', { class: 'tk-name' });
    const info = h('div', { class: 'tk-info' });
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const bUse = h('button', { class: 'th-btn tk-use', title: 'Use this whole take in the comp', onClick: stop(() => app.compTake(row.ch.id, row.lane.id)) }, 'Use');
    const bAud = h('button', { class: 'th-btn tk-aud', title: 'Audition: the track plays this take instead of the comp (click again to go back)', onClick: stop(() => app.toggleAudition(row.ch.id, row.lane.id)) }, icon('headphones', 12));
    const bDel = h('button', { class: 'ibtn xs', title: 'Delete this take', onClick: stop(() => app.deleteTakeLanes(row.ch.id, [row.lane.id])) }, icon('close', 12));
    const el = h('div', { class: 'tk' }, h('div', { class: 'tk-row' }, name, h('div', { class: 'tk-btns' }, bUse, bAud, bDel)), info);
    el.addEventListener('dblclick', async (e) => {
      if (e.target.closest('button')) return;
      const n = await promptText('Rename take', row.lane.name);
      if (n) app.renameTakeLane(row.ch.id, row.lane.id, n);
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.takeMenu(e, row, null); });
    return {
      el,
      update: (rr) => {
        row = rr;
        const p = app.p, a = app.ui.audition;
        name.textContent = rr.lane.name;
        el.style.setProperty('--tc', rr.ch.color || '#888');
        const pct = Math.round(laneUsage(rr.ch, rr.lane, p.tempo) * 100);
        const auditioning = !!(a && a.track === rr.ch.id && a.lane === rr.lane.id);
        info.textContent = auditioning ? 'auditioning' : pct >= 100 ? 'all in comp' : pct > 0 ? `${pct}% in comp` : 'not in comp';
        el.classList.toggle('used', pct > 0);
        el.classList.toggle('auditioning', auditioning);
        bAud.classList.toggle('on', auditioning);
      },
    };
  }

  takeMenu(e, row, clip) {
    const app = this.app, t = row.ch, lane = row.lane, a = app.ui.audition;
    const auditioning = !!(a && a.track === t.id && a.lane === lane.id);
    contextMenu(e.clientX, e.clientY, [
      clip ? { label: 'Use this take here', action: () => app.compTake(t.id, lane.id, clip.id) } : null,
      { label: `Use all of ${lane.name}`, action: () => app.compTake(t.id, lane.id) },
      { label: auditioning ? 'Stop auditioning' : 'Audition this take', action: () => app.toggleAudition(t.id, lane.id) },
      { label: 'Rename…', action: async () => { const n = await promptText('Rename take', lane.name); if (n) app.renameTakeLane(t.id, lane.id, n); } },
      { sep: true },
      { label: 'Delete unused takes', action: () => app.deleteUnusedTakes(t.id) },
      { label: 'Delete this take', danger: true, action: () => app.deleteTakeLanes(t.id, [lane.id]) },
    ]);
  }

  // Swipe comping: drag across a take lane to use that range of it; a click uses the whole take.
  startCompOp(e, ht, x, y) {
    const app = this.app, trackId = ht.row.ch.id, laneId = ht.row.lane.id, key = ht.row.key;
    const b0 = this.beat(x), x0 = x;
    let base = null;
    drag(e, {
      cursor: 'text',
      move: (ev) => {
        const l = this.local(ev);
        if (!base) {
          if (Math.abs(l.x - x0) < 4) return;
          app.store.begin(`Comp from ${ht.row.lane.name}`);
          base = cloneJSON(findTrack(app.p, trackId).clips);
          this.op = { type: 'comp' };
        }
        const b1 = this.beat(l.x);
        const a = Math.max(0, this.snap(Math.min(b0, b1), ev)), z = this.snap(Math.max(b0, b1), ev);
        this.compSel = { key, a, z };
        app.store.live((q) => {
          findTrack(q, trackId).clips = cloneJSON(base); // re-apply from the start of the gesture so shrinking the swipe works
          if (z - a > 1e-6) app.compSwipe(q, trackId, laneId, a, z);
        }, 'clips');
      },
      up: () => {
        if (base) { this.op = null; this.compSel = null; app.store.end('clips'); }
        else if (ht.type === 'take') app.compTake(trackId, laneId, ht.clip.id);
      },
    });
  }

  toggleLanes(id) {
    const app = this.app, ch = findChannel(app.p, id);
    if (!ch) return;
    app.store.do(ch.showLanes ? 'Hide automation' : 'Show automation', (p) => {
      const c = findChannel(p, id);
      c.showLanes = !c.showLanes;
      if (c.showLanes && !c.automation.length) c.automation.push({ id: uid('aut'), target: 'mix:vol', points: [] });
    }, 'auto', { id });
  }

  headReorder(e, id) {
    const y0 = e.clientY;
    let moving = false, target = null;
    drag(e, {
      move: (ev) => {
        if (!moving && Math.abs(ev.clientY - y0) > 6) moving = true;
        if (!moving) return;
        const r = this.lanes.getBoundingClientRect();
        const cy = ev.clientY - r.top + this.scrollY;
        const trs = this.trackRows();
        let idx = trs.length;
        for (const t of trs) if (cy < t.y + t.h / 2) { idx = t.index; break; }
        target = idx;
        this.reorderY = idx < trs.length ? trs.find((t) => t.index === idx).y : (trs.length ? trs[trs.length - 1].y + trs[trs.length - 1].h : 0);
      },
      up: () => { this.reorderY = null; if (moving && target !== null) this.app.moveTrack(id, target); },
    });
  }

  colorMenu(e, id) {
    contextMenu(e.clientX, e.clientY, TRACK_COLORS.map((c) => ({ label: h('span', { class: 'color-swatch-row' }, h('span', { class: 'swatch', style: { background: c } }), c), action: () => this.app.setChannel(id, 'color', c, 'Change color') })));
  }

  headMenu(e, ch, kind) {
    const app = this.app;
    const items = [];
    if (kind !== 'master') items.push({ label: 'Rename…', action: () => app.promptRename(ch.id) });
    if (kind === 'track') items.push({ label: 'Duplicate track', action: () => app.duplicateTrack(ch.id) });
    items.push({ label: ch.showLanes ? 'Hide automation' : 'Show automation', action: () => this.toggleLanes(ch.id) });
    items.push({ label: 'Add automation lane', action: () => app.store.do('Add lane', (p) => { const c = findChannel(p, ch.id); c.showLanes = true; c.automation.push({ id: uid('aut'), target: 'mix:pan', points: [] }); }, 'auto') });
    if (kind === 'track' && ch.kind === 'audio') {
      items.push({ sep: true }, { header: 'Record input' });
      for (const [v, l] of [['stereo', 'Inputs 1+2 (stereo)'], ['L', 'Input 1 (mono)'], ['R', 'Input 2 (mono)']]) items.push({ label: l, checked: (ch.input || 'stereo') === v, action: () => app.setTrackInput(ch.id, v) });
      items.push({ label: 'Monitor input while armed', checked: !!ch.monitor, action: () => app.toggleChannel(ch.id, 'monitor') });
    }
    if (kind === 'track') {
      items.push({ sep: true }, { header: 'Output' });
      for (const o of [{ id: 'master', name: 'Master' }, ...app.p.buses]) items.push({ label: o.name, checked: (ch.output || 'master') === o.id, action: () => app.setChannel(ch.id, 'output', o.id, 'Route output') });
    }
    if (kind !== 'master') items.push({ sep: true }, { label: `Delete ${kind === 'bus' ? 'bus' : 'track'}`, danger: true, action: () => app.deleteChannel(ch.id) });
    contextMenu(e.clientX, e.clientY, items);
  }

  // ------------------------------------------------------------ refresh / frame
  refresh(d) {
    if (d.scope === 'autowrite') { this.dirty = true; return; }
    if (d.scope === 'mix-param' || d.scope === 'inst-param' || d.scope === 'fx-param' || d.scope === 'wt') {
      if (d.scope === 'mix-param') { this.computeRows(); this.renderHeads(); }
      return;
    }
    this.computeRows();
    this.renderHeads();
    this.dirty = true;
  }

  frame() {
    if (this.dirty) { this.dirty = false; this.drawRuler(); this.drawMain(); this.updateScrollbar(); }
    const app = this.app, e = app.engine;
    if (app.isPlaying && app.ui.follow && !this.op && e.playState === 1) {
      const x = this.x(e.position);
      if (x > this.W * 0.92 || x < 0) { this.scrollX = Math.max(0, e.position - (this.W * 0.06) / this.ppb); this.dirty = true; }
    }
    this.drawOverlay();
    if (app.isPlaying) {
      this.laneTick = (this.laneTick || 0) + 1;
      if (this.laneTick % 6 === 0) for (const hd of this.heads.values()) if (hd.row && hd.row.kind === 'lane') hd.update(hd.row);
    }
  }

  updateScrollbar() {
    const end = Math.max(projectEndBeat(this.app.p), this.app.p.loop.end) + barBeats(this.app.p) * 8;
    const visible = this.W / this.ppb;
    const total = Math.max(end, this.scrollX + visible);
    this.hTotal = total;
    this.hThumb.style.left = `${(this.scrollX / total) * 100}%`;
    this.hThumb.style.width = `${Math.max(3, (visible / total) * 100)}%`;
  }
  onScrollbar(e) {
    e.preventDefault();
    const r = this.hScroll.getBoundingClientRect();
    const total = this.hTotal || 64, visible = this.W / this.ppb;
    if (e.target !== this.hThumb) this.scrollX = clamp(((e.clientX - r.left) / r.width) * total - visible / 2, 0, total);
    const x0 = e.clientX, s0 = this.scrollX;
    this.dirty = true;
    drag(e, { move: (ev) => { this.scrollX = clamp(s0 + ((ev.clientX - x0) / r.width) * total, 0, total); this.dirty = true; } });
  }

  // ------------------------------------------------------------ drawing
  drawGrid(c, top, height) {
    const p = this.app.p, bar = barBeats(p), unit = 4 / p.sigDen, C = this.colors();
    const b0 = Math.floor(this.scrollX), b1 = this.beat(this.W);
    const minor = this.gridUnit() || unit;
    const drawStep = Math.max(minor, 0.0625);
    if (drawStep * this.ppb >= 5) {
      const start = Math.floor(this.scrollX / drawStep) * drawStep;
      for (let b = start; b <= b1; b += drawStep) {
        const isBar = Math.abs(b / bar - Math.round(b / bar)) < 1e-6, isBeat = Math.abs(b / unit - Math.round(b / unit)) < 1e-6;
        c.fillStyle = isBar ? C.gridBar : isBeat ? C.gridBeat : C.grid;
        c.fillRect(Math.round(this.x(b)), top, 1, height);
      }
    } else {
      let step = bar;
      while (step * this.ppb < 12) step *= 2;
      for (let b = Math.floor(b0 / step) * step; b <= b1; b += step) { c.fillStyle = C.gridBar; c.fillRect(Math.round(this.x(b)), top, 1, height); }
    }
  }

  drawMain() {
    const s = this.main, c = s.ctx, C = this.colors(), app = this.app, p = app.p;
    s.clear();
    c.fillStyle = C.bg; c.fillRect(0, 0, s.w, s.h);
    for (const r of this.rows) {
      const y = r.y - this.scrollY;
      if (y > s.h || y + r.h < 0) continue;
      if (r.kind === 'divider') { c.fillStyle = '#0d0f11'; c.fillRect(0, y, s.w, r.h); continue; }
      c.fillStyle = r.kind === 'lane' ? '#121518' : r.kind === 'take' ? '#111316' : r.kind === 'track' ? (r.index % 2 ? C.rowAlt : C.row) : '#13161a';
      c.fillRect(0, y, s.w, r.h);
      if (r.ch && app.ui.selTrack === r.ch.id && r.kind !== 'lane') { c.fillStyle = C.sel; c.fillRect(0, y, s.w, r.h); }
      c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, y + r.h - 1, s.w, 1);
    }
    this.drawGrid(c, 0, s.h);
    if (p.loop.on) {
      const x0 = this.x(p.loop.start), x1 = this.x(p.loop.end);
      c.fillStyle = 'rgba(255,143,60,0.035)'; c.fillRect(x0, 0, x1 - x0, s.h);
      c.fillStyle = 'rgba(255,143,60,0.25)'; c.fillRect(Math.round(x0), 0, 1, s.h); c.fillRect(Math.round(x1), 0, 1, s.h);
    }
    if (p.punch.on) {
      const x0 = this.x(p.punch.start), x1 = this.x(p.punch.end);
      c.fillStyle = 'rgba(255,77,85,0.04)'; c.fillRect(x0, 0, x1 - x0, s.h);
      c.fillStyle = 'rgba(255,77,85,0.5)';
      for (let yy = 0; yy < s.h; yy += 6) { c.fillRect(Math.round(x0), yy, 1, 3); c.fillRect(Math.round(x1), yy, 1, 3); }
    }
    for (const m of p.markers) { c.fillStyle = 'rgba(210,190,255,0.18)'; c.fillRect(Math.round(this.x(m.beat)), 0, 1, s.h); }
    for (const r of this.rows) {
      const y = r.y - this.scrollY;
      if (y > s.h || y + r.h < 0) continue;
      if (r.kind === 'track') {
        const au = app.ui.audition && app.ui.audition.track === r.ch.id;
        if (au) c.globalAlpha = 0.35; // the comp is not what plays while a take is auditioned
        for (const clip of r.ch.clips) this.drawClip(c, r.ch, clip, y, r.h);
        c.globalAlpha = 1;
      } else if (r.kind === 'take') this.drawTake(c, r, y);
      else if (r.kind === 'lane') this.drawLane(c, r, y);
      else if (r.kind === 'bus' || r.kind === 'master') {
        c.fillStyle = C.text3; c.font = '11px var(--font-ui, sans-serif)';
        c.fillText(r.kind === 'master' ? 'Master output' : 'Return bus — receives sends', 10, y + r.h / 2 + 4);
      }
    }
    if (this.reorderY != null) { c.fillStyle = C.selc; c.fillRect(0, this.reorderY - this.scrollY - 1, s.w, 2); }
  }

  drawClip(c, t, clip, y, rh) {
    const C = this.colors(), app = this.app;
    const x0 = this.x(clip.start), x1 = this.x(clip.start + clip.length);
    if (x1 < 0 || x0 > this.W) return;
    const top = y + 2, hh = rh - 5, w = Math.max(2, x1 - x0);
    const sel = app.ui.selClips.has(clip.id), editing = app.ui.editClip === clip.id;
    const col = clip.mute ? '#6a7178' : t.color;
    const asset = clip.kind === 'audio' ? app.assets.get(clip.assetId) : null;
    const offline = clip.kind === 'audio' && (!asset || asset.missing);
    c.save();
    c.beginPath(); c.roundRect(x0 + 0.5, top + 0.5, w - 1, hh - 1, 3); c.clip();
    c.fillStyle = hexA(col, sel ? 0.34 : 0.22); c.fillRect(x0, top, w, hh);
    c.fillStyle = hexA(col, sel ? 0.95 : 0.78); c.fillRect(x0, top, w, CLIP_HEAD);
    if (offline) {
      c.strokeStyle = 'rgba(255,80,80,0.35)'; c.lineWidth = 1;
      for (let k = -hh; k < w; k += 8) { c.beginPath(); c.moveTo(x0 + k, top + hh); c.lineTo(x0 + k + hh, top); c.stroke(); }
    }
    c.fillStyle = '#101214'; c.font = '600 10.5px var(--font-ui, sans-serif)';
    if (w > 24) c.fillText((offline ? '⚠ ' : '') + (clip.name || ''), x0 + 5, top + 11);
    const bodyTop = top + CLIP_HEAD + 2, bodyH = hh - CLIP_HEAD - 4;
    const pnNotes = clip.kind === 'pianist' ? this.pianistNotes(clip) : null;
    if (((clip.kind === 'midi' && clip.notes.length) || (pnNotes && pnNotes.length)) && bodyH > 4) {
      const notes = pnNotes || clip.notes;
      let lo = 127, hi = 0;
      for (const n of notes) { if (n.p < lo) lo = n.p; if (n.p > hi) hi = n.p; }
      lo -= 2; hi += 2;
      const span = Math.max(8, hi - lo), nh = Math.max(1.5, Math.min(5, bodyH / span));
      const L = pnNotes ? clip.length : clip.loopLen || clip.length, off = pnNotes ? 0 : clip.offset || 0;
      c.fillStyle = hexA(col === '#6a7178' ? '#9aa0a6' : '#ffffff', 0.85);
      for (let k = Math.floor(off / L); ; k++) {
        const base = clip.start - off + k * L;
        if (base >= clip.start + clip.length) break;
        if (k > Math.floor(off / L)) { c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(this.x(base), bodyTop, 1, bodyH); c.fillStyle = hexA('#ffffff', 0.85); }
        for (const n of notes) {
          if (n.s >= L) continue;
          const sb = base + n.s;
          if (sb < clip.start || sb >= clip.start + clip.length) continue;
          const nx = this.x(sb), nw = Math.max(1.5, Math.min(n.l, clip.start + clip.length - sb, L - n.s) * this.ppb - 1);
          if (nx > this.W || nx + nw < 0) continue;
          const ny = bodyTop + (1 - (n.p - lo) / span) * (bodyH - nh);
          c.globalAlpha = 0.45 + 0.55 * n.v;
          c.fillRect(nx, ny, nw, nh);
        }
        c.globalAlpha = 1;
        if (k > 2000) break;
      }
    } else if (clip.kind === 'drummer' && bodyH > 6) {
      // Drummer region: the generated hits in four rows (kick · snare/toms · hats · percussion & cymbals)
      const hits = this.drummerHits(clip);
      const rowH = bodyH / 4;
      c.fillStyle = 'rgba(0,0,0,0.18)';
      for (let r = 1; r < 4; r++) c.fillRect(x0, bodyTop + r * rowH, w, 1);
      c.fillStyle = hexA(col === '#6a7178' ? '#9aa0a6' : '#ffffff', 0.9);
      for (const n of hits) {
        const nx = this.x(clip.start + n.s);
        if (nx < x0 - 2 || nx > x1 || nx > this.W) continue;
        const pc = PIECES[n.k];
        const row = pc.id === 'kick' ? 0 : pc.part === 'kick' ? 1 : pc.part === 'hats' ? 2 : 3;
        c.globalAlpha = 0.35 + 0.65 * n.v;
        const hh2 = Math.max(2, rowH * (0.35 + 0.55 * n.v));
        if (pc.id.startsWith('riser')) c.fillRect(nx, bodyTop + row * rowH + rowH - 2, Math.max(2, n.l * this.ppb), 2);
        else c.fillRect(nx, bodyTop + row * rowH + (rowH - hh2) / 2, Math.max(1.2, Math.min(3, this.ppb * 0.08)), hh2);
      }
      c.globalAlpha = 1;
    } else if (clip.kind === 'audio' && asset && asset.peaks && bodyH > 4) {
      const pk = asset.peaks, spbSec = 60 / app.p.tempo;
      const mid = bodyTop + bodyH / 2, amp = bodyH / 2;
      const gain = Math.pow(10, (clip.gain || 0) / 20);
      c.fillStyle = hexA('#ffffff', 0.78);
      const xs = Math.max(0, Math.floor(x0)), xe = Math.min(this.W, Math.ceil(x1));
      for (let x = xs; x < xe; x++) {
        const tb0 = this.beat(x) - clip.start, tb1 = this.beat(x + 1) - clip.start;
        const s0 = (clip.offset + tb0 * spbSec) * pk.sampleRate / pk.block, s1 = (clip.offset + tb1 * spbSec) * pk.sampleRate / pk.block;
        let lo = 0, hi = 0;
        for (let b = Math.max(0, Math.floor(s0)); b <= Math.min(pk.min.length - 1, Math.ceil(s1)); b++) { if (pk.min[b] < lo) lo = pk.min[b]; if (pk.max[b] > hi) hi = pk.max[b]; }
        lo = Math.max(-1, lo * gain); hi = Math.min(1, hi * gain);
        if (hi - lo > 0.002) c.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    c.restore();
    c.strokeStyle = editing ? C.accent : sel ? '#ffffff' : hexA(col, 0.9);
    c.lineWidth = sel || editing ? 1.5 : 1;
    c.beginPath(); c.roundRect(x0 + 0.5, top + 0.5, w - 1, hh - 1, 3); c.stroke();
    if (clip.kind === 'midi' && (clip.loopLen || clip.length) < clip.length - 1e-6 && w > 30) {
      c.fillStyle = '#101214'; c.font = '10px var(--font-ui, sans-serif)'; c.fillText('⟲', x1 - 13, top + 11);
    }
  }

  // Generated notes of a Pianist region (cached until its settings, length or position change)
  pianistNotes(clip) {
    if (!this.pnCache) this.pnCache = new Map();
    const p = this.app.p, bar = barBeats(p), key = JSON.stringify(clip.pn) + '|' + clip.length + '|' + clip.start + '|' + bar + '|' + p.tempo;
    const hit = this.pnCache.get(clip.id);
    if (hit && hit.key === key) return hit.notes;
    const notes = generatePianist(clip.pn, clip.length, bar, { ...songContext(p), start: clip.start });
    if (this.pnCache.size > 200) this.pnCache.clear();
    this.pnCache.set(clip.id, { key, notes });
    return notes;
  }
  // Generated hits of a Drummer region (cached until its settings or length change)
  drummerHits(clip) {
    if (!this.drCache) this.drCache = new Map();
    const bar = barBeats(this.app.p), key = JSON.stringify(clip.dr) + '|' + clip.length + '|' + bar;
    const hit = this.drCache.get(clip.id);
    if (hit && hit.key === key) return hit.notes;
    const notes = generateDrummer(clip.dr, clip.length, bar);
    if (this.drCache.size > 200) this.drCache.clear();
    this.drCache.set(clip.id, { key, notes });
    return notes;
  }

  // A take lane: takes drawn faded, the parts the comp uses at full strength.
  drawTake(c, r, y) {
    const app = this.app, t = r.ch, tempo = app.p.tempo, a = app.ui.audition;
    const auditioning = a && a.track === t.id && a.lane === r.lane.id;
    for (const T of r.lane.clips) {
      const x0 = this.x(T.start), x1 = this.x(T.start + T.length);
      if (x1 < 0 || x0 > this.W) continue;
      c.save(); c.globalAlpha = auditioning ? 0.9 : 0.32; this.drawClip(c, t, T, y, r.h); c.restore();
      if (auditioning) continue;
      for (const [ua, ub] of usedRanges(t, T, tempo)) {
        c.save(); c.beginPath(); c.rect(this.x(ua), y, this.x(ub) - this.x(ua), r.h); c.clip();
        this.drawClip(c, t, T, y, r.h);
        c.restore();
      }
    }
    if (auditioning) { c.strokeStyle = this.colors().accent; c.lineWidth = 1.5; c.strokeRect(1, y + 1.5, this.W - 2, r.h - 3); }
  }

  laneY(r, y, v) { return y + 6 + (1 - v) * (r.h - 12); }

  drawLane(c, r, y) {
    const C = this.colors(), p = this.app.p, ch = r.ch, lane = r.lane;
    const info = targetInfo(p, ch, lane.target);
    c.fillStyle = 'rgba(255,255,255,0.025)'; c.fillRect(0, y + 6, this.W, r.h - 12);
    const col = ch.color || C.accent;
    const pts = lane.points;
    if (!pts.length) {
      const yv = this.laneY(r, y, info ? info.norm : 0.5);
      c.strokeStyle = hexA(col, 0.5); c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, yv); c.lineTo(this.W, yv); c.stroke(); c.setLineDash([]);
      c.fillStyle = C.text3; c.font = '11px var(--font-ui, sans-serif)'; c.fillText('Click to add automation points · double-click a point to delete', 10, y + r.h / 2 + 4);
      return;
    }
    c.beginPath();
    c.moveTo(0, this.laneY(r, y, pts[0][1]));
    for (const pt of pts) c.lineTo(this.x(pt[0]), this.laneY(r, y, pt[1]));
    c.lineTo(this.W, this.laneY(r, y, pts[pts.length - 1][1]));
    c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
    c.lineTo(this.W, y + r.h - 6); c.lineTo(0, y + r.h - 6); c.closePath();
    c.fillStyle = hexA(col, 0.12); c.fill();
    for (let i = 0; i < pts.length; i++) {
      const px = this.x(pts[i][0]);
      if (px < -6 || px > this.W + 6) continue;
      const hov = this.hover && this.hover.lane === lane && this.hover.index === i;
      c.beginPath(); c.arc(px, this.laneY(r, y, pts[i][1]), hov ? 4.5 : 3.2, 0, Math.PI * 2);
      c.fillStyle = hov ? '#ffffff' : col; c.fill();
      c.strokeStyle = '#0e1012'; c.lineWidth = 1; c.stroke();
    }
  }

  drawRuler() {
    const s = this.ruler, c = s.ctx, C = this.colors(), p = this.app.p, bar = barBeats(p);
    s.clear();
    c.fillStyle = '#121417'; c.fillRect(0, 0, s.w, s.h);
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, s.w, 16);
    // loop strip
    c.fillStyle = '#16191c'; c.fillRect(0, 16, s.w, 12);
    const lx0 = this.x(p.loop.start), lx1 = this.x(p.loop.end);
    c.fillStyle = p.loop.on ? 'rgba(255,143,60,0.85)' : 'rgba(150,160,170,0.35)';
    c.fillRect(lx0, 18, lx1 - lx0, 8);
    c.fillStyle = p.loop.on ? '#ffd2ad' : '#aab3bb'; c.fillRect(lx0, 18, 2, 8); c.fillRect(lx1 - 2, 18, 2, 8);
    // punch strip
    c.fillStyle = '#131518'; c.fillRect(0, 28, s.w, 10);
    const P = p.punch, px0 = this.x(P.start), px1 = this.x(P.end);
    c.fillStyle = P.on ? 'rgba(255,77,85,0.85)' : 'rgba(150,160,170,0.22)';
    c.fillRect(px0, 30, px1 - px0, 6);
    c.fillStyle = P.on ? '#ffc9cc' : '#8f99a2'; c.fillRect(px0, 29, 2, 8); c.fillRect(px1 - 2, 29, 2, 8);
    if (P.on && px1 - px0 > 70) { c.fillStyle = '#2a0d10'; c.font = '600 8.5px var(--font-ui, sans-serif)'; c.fillText('PUNCH', px0 + 5, 35.5); }
    // bars
    let step = 1;
    while (step * bar * this.ppb < 44) step *= 2;
    const firstBar = Math.max(0, Math.floor(this.scrollX / bar / step) * step);
    c.font = '10.5px var(--font-mono, monospace)';
    for (let k = firstBar; k * bar <= this.beat(s.w); k += step) {
      const x = Math.round(this.x(k * bar));
      c.fillStyle = C.text3; c.fillRect(x, 38, 1, 16);
      c.fillStyle = C.text2; c.fillText(String(k + 1), x + 4, 50);
    }
    const unit = 4 / p.sigDen;
    if (unit * this.ppb >= 8) {
      c.fillStyle = 'rgba(255,255,255,0.18)';
      for (let b = Math.floor(this.scrollX / unit) * unit; b <= this.beat(s.w); b += unit) if (Math.abs(b / bar - Math.round(b / bar)) > 1e-6) c.fillRect(Math.round(this.x(b)), 48, 1, 6);
    }
    // markers
    c.font = '600 10px var(--font-ui, sans-serif)';
    for (const m of p.markers) {
      const x = this.x(m.beat);
      if (x < -120 || x > s.w) continue;
      const tw = c.measureText(m.name).width + 10;
      c.fillStyle = '#b9a7ff'; c.fillRect(x, 2, 1.5, 13);
      c.fillStyle = 'rgba(185,167,255,0.22)'; c.fillRect(x + 1.5, 2, tw, 12);
      c.fillStyle = '#ddd4ff'; c.fillText(m.name, x + 6, 11.5);
    }
    c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, s.h - 1, s.w, 1);
  }

  drawOverlay() {
    const s = this.over, c = s.ctx, app = this.app, e = app.engine, C = this.colors();
    s.clear();
    const playing = e.playState === 1;
    const pos = playing ? e.position : app.ui.cursor;
    const x = Math.round(this.x(pos)) + 0.5;
    const rec = app.recording;
    if (rec && playing) {
      const audioStart = rec.audioStart, startBeat = audioStart ? audioStart.beat : rec.startBeat;
      if (rec.started || audioStart) {
        const loopRec = rec.loop.on && startBeat >= rec.loop.start && startBeat < rec.loop.end;
        let rx = this.x(loopRec && pos < startBeat ? rec.loop.start : startBeat), rx1 = x;
        if (rec.punch) { rx = Math.max(rx, this.x(rec.punch.start)); rx1 = Math.min(x, this.x(rec.punch.end)); }
        for (const r of this.rows) {
          if (r.kind !== 'track' || !(rec.tracks.includes(r.ch.id) || rec.audio.includes(r.ch.id))) continue;
          const ry = r.y - this.scrollY;
          c.fillStyle = 'rgba(255,77,85,0.16)'; c.fillRect(rx, ry + 2, Math.max(0, rx1 - rx), r.h - 5);
          if (audioStart && rec.audio.includes(r.ch.id)) this.drawLiveTake(c, rec, ry, r.h);
        }
      }
    }
    if (x >= 0 && x <= s.w) {
      c.fillStyle = playing ? (app.recording ? C.rec : C.accent) : 'rgba(255,255,255,0.55)';
      c.fillRect(x - 0.5, 0, playing ? 1.5 : 1, s.h);
    }
    if (this.compSel) {
      const r = this.rows.find((rr) => rr.key === this.compSel.key);
      if (r) {
        const ry = r.y - this.scrollY, xa = this.x(this.compSel.a), xz = this.x(this.compSel.z);
        c.fillStyle = 'rgba(92,179,255,0.18)'; c.fillRect(xa, ry + 1, xz - xa, r.h - 2);
        c.fillStyle = 'rgba(92,179,255,0.9)'; c.fillRect(Math.round(xa), ry + 1, 1, r.h - 2); c.fillRect(Math.round(xz), ry + 1, 1, r.h - 2);
      }
    }
    if (this.band) {
      const b = this.band;
      c.fillStyle = 'rgba(92,179,255,0.12)'; c.strokeStyle = 'rgba(92,179,255,0.8)';
      c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); c.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
    }
    if (this.drop) {
      const d = this.drop;
      c.fillStyle = d.valid ? 'rgba(92,179,255,0.16)' : 'rgba(255,77,85,0.12)';
      c.fillRect(0, d.y, s.w, d.h);
      if (d.x != null) { c.fillStyle = C.selc; c.fillRect(d.x, d.y, 2, d.h); }
    }
    // ruler playhead
    const rs = this.ruler;
    if (!this.rulerPh) this.rulerPh = h('div', { class: 'ruler-playhead' });
    if (!this.rulerPh.parentNode) this.rulerCv.parentNode.append(this.rulerPh);
    this.rulerPh.style.transform = `translateX(${x - 5}px)`;
    this.rulerPh.style.display = x >= 0 && x <= rs.w ? '' : 'none';
    this.rulerPh.classList.toggle('playing', playing);
  }

  // Incoming audio while recording, placed where it will land (latency-compensated, loop-wrapped).
  drawLiveTake(c, rec, ry, rh) {
    const app = this.app, col = app.input.collect;
    if (!col) return;
    const vals = col.trace.values, block = col.trace.block;
    const sr = app.engine.sampleRate, spb = (sr * 60) / app.p.tempo, lat = app.recLatencyFrames();
    const L = rec.loop, start = rec.audioStart, loopRec = L.on && start.beat < L.end, P = rec.punch;
    const mid = ry + rh / 2 + 6, amp = (rh - 22) / 2;
    c.fillStyle = 'rgba(255,200,200,0.85)';
    const first = (start.index - col.start) | 0;
    for (let b = Math.max(0, Math.floor(first / block)); b < vals.length; b++) {
      let beat = start.beat + (b * block - first - lat) / spb;
      if (beat < start.beat) continue;
      if (loopRec && beat >= L.end) beat = L.start + ((beat - L.end) % (L.end - L.start));
      if (P && (beat < P.start || beat >= P.end)) continue;
      const px = this.x(beat);
      if (px < 0 || px > this.W) continue;
      const v = Math.min(1, vals[b]) * amp;
      c.fillRect(px, mid - v, 1, Math.max(1, v * 2));
    }
  }

  // ------------------------------------------------------------ hit testing
  local(e) { const r = this.lanes.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  hit(x, y) {
    const r = this.rowAt(y);
    if (!r) return { type: 'none' };
    const ry = r.y - this.scrollY;
    if (r.kind === 'track') {
      for (let i = r.ch.clips.length - 1; i >= 0; i--) {
        const clip = r.ch.clips[i];
        const x0 = this.x(clip.start), x1 = this.x(clip.start + clip.length);
        if (x >= x0 && x <= x1) {
          const inHead = y - ry < CLIP_HEAD + 3;
          const edge = Math.min(EDGE, (x1 - x0) / 4);
          const zone = x <= x0 + edge ? 'left' : x >= x1 - edge ? (inHead && clip.kind === 'midi' ? 'loop' : 'right') : 'body';
          return { type: 'clip', row: r, clip, zone };
        }
      }
      return { type: 'empty', row: r };
    }
    if (r.kind === 'take') {
      for (let i = r.lane.clips.length - 1; i >= 0; i--) {
        const clip = r.lane.clips[i];
        if (x >= this.x(clip.start) && x <= this.x(clip.start + clip.length)) return { type: 'take', row: r, clip };
      }
      return { type: 'takeEmpty', row: r };
    }
    if (r.kind === 'lane') {
      const pts = r.lane.points;
      for (let i = 0; i < pts.length; i++) {
        const px = this.x(pts[i][0]), py = this.laneY(r, ry, pts[i][1]);
        if (Math.abs(px - x) <= 6 && Math.abs(py - y) <= 6) return { type: 'point', row: r, index: i };
      }
      return { type: 'lane', row: r };
    }
    return { type: r.kind, row: r };
  }

  onHover(e) {
    if (this.op) return;
    const { x, y } = this.local(e);
    const ht = this.hit(x, y);
    const cur = { left: 'w-resize', right: 'e-resize', loop: 'col-resize', body: 'grab' };
    this.mainCv.style.cursor = ht.type === 'clip' ? cur[ht.zone] : ht.type === 'point' ? 'move' : ht.type === 'lane' ? 'crosshair' : ht.type === 'take' || ht.type === 'takeEmpty' ? 'text' : '';
    const hov = ht.type === 'point' ? { lane: ht.row.lane, index: ht.index } : null;
    if ((hov && (!this.hover || this.hover.lane !== hov.lane || this.hover.index !== hov.index)) || (!hov && this.hover)) { this.hover = hov; this.dirty = true; }
    this.hint.textContent = ht.type === 'clip'
      ? ({ left: 'Drag to trim the clip start', right: 'Drag to resize', loop: 'Drag to loop the clip content', body: 'Drag to move · Alt+drag duplicates · double-click to edit' })[ht.zone]
      : ht.type === 'empty' ? (ht.row.ch.kind === 'instrument' ? 'Double-click to create a MIDI clip · drag to select' : 'Drop audio files or samples here')
      : ht.type === 'lane' || ht.type === 'point' ? 'Click to add a point · drag points · double-click to delete'
      : ht.type === 'take' || ht.type === 'takeEmpty' ? 'Click a take to use it · drag across takes to comp just that range (Alt: no snap) · right-click for more' : '';
  }

  // ------------------------------------------------------------ pointer: lanes area
  onDown(e) {
    if (e.button !== 0) return;
    this.lanes.focus({ preventScroll: true });
    const app = this.app;
    const { x, y } = this.local(e);
    const ht = this.hit(x, y);
    if (ht.row && ht.row.ch && ht.row.kind !== 'lane') app.selectTrack(ht.row.ch.id);
    if (ht.type === 'take' || ht.type === 'takeEmpty') return this.startCompOp(e, ht, x, y);
    if (ht.type === 'clip') return this.startClipOp(e, ht, x, y);
    if (ht.type === 'point' || ht.type === 'lane') return this.startLaneOp(e, ht, x, y);
    if (ht.type === 'empty' || ht.type === 'none' || ht.type === 'bus' || ht.type === 'master' || ht.type === 'divider') {
      // click empty: locate + rubber band
      const startX = x, startY = y;
      let moved = false;
      drag(e, {
        move: (ev) => {
          const l = this.local(ev);
          if (!moved && Math.hypot(l.x - startX, l.y - startY) > 4) moved = true;
          if (!moved) return;
          this.band = { x0: Math.min(startX, l.x), y0: Math.min(startY, l.y), x1: Math.max(startX, l.x), y1: Math.max(startY, l.y) };
          const b0 = this.beat(this.band.x0), b1 = this.beat(this.band.x1);
          const ids = [];
          for (const r of this.trackRows()) {
            const ry0 = r.y - this.scrollY, ry1 = ry0 + r.h;
            if (ry1 < this.band.y0 || ry0 > this.band.y1) continue;
            for (const c of r.ch.clips) if (c.start < b1 && c.start + c.length > b0) ids.push(c.id);
          }
          app.ui.selClips = new Set(ev.shiftKey ? [...app.ui.selClips, ...ids] : ids);
          this.dirty = true;
        },
        up: (ev) => {
          this.band = null;
          if (!moved) {
            if (!ev.shiftKey) app.ui.selClips.clear();
            if (!app.isPlaying) app.locate(this.snap(this.beat(startX), ev));
            else app.locate(this.snap(this.beat(startX), ev));
          }
          app.uiChanged('clips');
        },
      });
    }
  }

  startClipOp(e, ht, x, y) {
    const app = this.app, clip = ht.clip;
    if (e.shiftKey && app.ui.selClips.has(clip.id) && ht.zone === 'body') { app.ui.selClips.delete(clip.id); app.uiChanged('clips'); return; }
    if (!app.ui.selClips.has(clip.id)) { if (!e.shiftKey) app.ui.selClips.clear(); app.ui.selClips.add(clip.id); }
    if (clip.kind === 'midi') app.ui.editClip = clip.id;
    app.uiChanged('clips');
    const p = app.p;
    const zone = ht.zone, dup = e.altKey && zone === 'body';
    const startTrackIdx = p.tracks.indexOf(ht.row.ch);
    const x0 = x, y0 = y;
    let began = false, ids = [...app.ui.selClips];
    let orig = null;
    const begin = () => {
      began = true;
      app.store.begin(dup ? 'Duplicate clips' : zone === 'body' ? 'Move clips' : zone === 'loop' ? 'Loop clip' : 'Resize clip');
      if (dup) {
        const created = [];
        app.store.live((q) => {
          for (const id of ids) { const f = findClip(q, id); if (!f) continue; const c = cloneJSON(f.clip); c.id = uid('clp'); f.track.clips.push(c); created.push(c.id); }
        }, 'clips');
        ids = created; app.ui.selClips = new Set(created);
      }
      orig = new Map();
      for (const id of ids) { const f = findClip(app.p, id); if (f) orig.set(id, { ...f.clip, notes: undefined, track: app.p.tracks.indexOf(f.track) }); }
      this.op = { type: 'clip' };
    };
    const minLen = 0.0625;
    drag(e, {
      cursor: zone === 'body' ? 'grabbing' : zone === 'left' ? 'w-resize' : 'e-resize',
      move: (ev) => {
        const l = this.local(ev);
        if (!began) { if (Math.hypot(l.x - x0, l.y - y0) < 3) return; begin(); }
        const db = (l.x - x0) / this.ppb;
        const o = orig.get(clip.id) || orig.values().next().value;
        app.store.live((q) => {
          if (zone === 'body') {
            const ns = Math.max(0, this.snap(o.start + db, ev));
            const d = ns - o.start;
            const r = this.rowAt(l.y);
            let dt = r && r.kind === 'track' ? q.tracks.indexOf(findTrack(q, r.ch.id)) - startTrackIdx : 0;
            for (const [, oc] of orig) { const tt = q.tracks[oc.track + dt]; if (!clipFits(tt, oc)) { dt = 0; break; } }
            for (const [id, oc] of orig) {
              const f = findClip(q, id); if (!f) continue;
              f.clip.start = Math.max(0, oc.start + d);
              const target = q.tracks[oc.track + dt];
              if (target && target !== f.track) { f.track.clips = f.track.clips.filter((c) => c.id !== id); target.clips.push(f.clip); }
            }
          } else {
            for (const [id, oc] of orig) {
              const f = findClip(q, id); if (!f) continue;
              const c = f.clip;
              if (zone === 'right' || zone === 'loop') {
                let end = this.snap(oc.start + oc.length + db, ev);
                if (c.kind === 'audio' && f.track) {
                  const a = app.assets.get(c.assetId);
                  if (a && a.duration) end = Math.min(end, oc.start + ((a.duration - oc.offset) * q.tempo) / 60);
                }
                c.length = Math.max(minLen, end - oc.start);
                if (c.kind === 'midi') {
                  const looping = (oc.loopLen || oc.length) < oc.length - 1e-6;
                  c.loopLen = zone === 'loop' || looping ? (oc.loopLen || oc.length) : c.length + (oc.offset || 0);
                }
              } else {
                let ns = this.snap(oc.start + db, ev);
                ns = Math.min(ns, oc.start + oc.length - minLen);
                if (c.kind === 'audio') ns = Math.max(ns, oc.start - (oc.offset * q.tempo) / 60);
                else ns = Math.max(ns, oc.start - (oc.offset || 0));
                ns = Math.max(0, ns);
                const d = ns - oc.start;
                c.start = ns; c.length = oc.length - d;
                if (c.kind === 'audio') c.offset = Math.max(0, oc.offset + (d * 60) / q.tempo);
                else c.offset = Math.max(0, (oc.offset || 0) + d);
              }
            }
          }
        }, 'clips');
      },
      up: () => { if (began) { this.op = null; app.store.end('clips'); } },
    });
  }

  startLaneOp(e, ht, x, y) {
    const app = this.app, r = ht.row, chId = r.ch.id, laneId = r.lane.id;
    const ry = r.y - this.scrollY;
    const toV = (yy) => clamp(1 - (yy - ry - 6) / (r.h - 12), 0, 1);
    app.store.begin('Edit automation');
    let index = ht.index;
    if (ht.type === 'lane') {
      const b = Math.max(0, this.snap(this.beat(x), e));
      const v = toV(y);
      app.store.live((q) => {
        const lane = findChannel(q, chId).automation.find((a) => a.id === laneId);
        if (!lane.points.length) {
          const info = targetInfo(q, findChannel(q, chId), lane.target);
          if (info && b > 0) lane.points.push([0, info.norm]);
        }
        lane.points.push([b, v]);
        lane.points.sort((a, c) => a[0] - c[0]);
        index = lane.points.findIndex((pt) => pt[0] === b && pt[1] === v);
      }, 'auto', { id: chId });
    }
    this.op = { type: 'lane' };
    drag(e, {
      cursor: 'move',
      move: (ev) => {
        const l = this.local(ev);
        app.store.live((q) => {
          const lane = findChannel(q, chId).automation.find((a) => a.id === laneId);
          const pts = lane.points;
          const lo = index > 0 ? pts[index - 1][0] : 0, hi = index < pts.length - 1 ? pts[index + 1][0] : Infinity;
          pts[index][0] = clamp(Math.max(0, this.snap(this.beat(l.x), ev)), lo, hi);
          pts[index][1] = ev.shiftKey ? clamp(pts[index][1] - (ev.movementY || 0) / (r.h * 4), 0, 1) : toV(l.y);
        }, 'auto', { id: chId });
      },
      up: () => { this.op = null; app.store.end('auto'); },
    });
  }

  onDbl(e) {
    const app = this.app;
    const { x, y } = this.local(e);
    const ht = this.hit(x, y);
    if (ht.type === 'clip') { if (ht.clip.kind === 'midi' || ht.clip.kind === 'drummer' || ht.clip.kind === 'pianist') app.editClip(ht.clip.id); return; }
    if (ht.type === 'point') {
      const chId = ht.row.ch.id, laneId = ht.row.lane.id;
      app.store.do('Delete automation point', (q) => { const lane = findChannel(q, chId).automation.find((a) => a.id === laneId); lane.points.splice(ht.index, 1); }, 'auto', { id: chId });
      return;
    }
    if (ht.type === 'empty' && ht.row.ch.kind === 'instrument') {
      const bar = barBeats(app.p);
      const start = Math.max(0, Math.floor(this.beat(x) / bar) * bar);
      if (isDrumTrack(ht.row.ch)) app.createDrummerRegion(ht.row.ch.id, start); // drum tracks get a Drummer region
      else app.createMidiClip(ht.row.ch.id, start, bar);
    }
  }

  onContext(e) {
    e.preventDefault();
    const app = this.app;
    const { x, y } = this.local(e);
    const ht = this.hit(x, y);
    const beat = this.snap(this.beat(x));
    if (ht.type === 'take' || ht.type === 'takeEmpty') { this.takeMenu(e, ht.row, ht.clip || null); return; }
    if (ht.type === 'clip') {
      const clip = ht.clip;
      if (!app.ui.selClips.has(clip.id)) { app.ui.selClips = new Set([clip.id]); app.uiChanged('clips'); }
      const ids = [...app.ui.selClips];
      contextMenu(e.clientX, e.clientY, [
        clip.kind === 'midi' ? { label: 'Edit in piano roll', action: () => app.editClip(clip.id) } : null,
        clip.kind === 'drummer' ? { label: 'Edit Drummer…', action: () => app.editClip(clip.id) } : null,
        clip.kind === 'drummer' ? { label: 'New take (re-roll the groove)', action: () => app.newDrummerTake(clip.id) } : null,
        clip.kind === 'drummer' ? { label: 'Convert to MIDI clip', action: () => app.drummerToMidi(clip.id) } : null,
        clip.kind === 'drummer' ? { sep: true } : null,
        clip.kind === 'pianist' ? { label: 'Edit Pianist…', action: () => app.editClip(clip.id) } : null,
        clip.kind === 'pianist' ? { label: 'New take (regenerate)', action: () => app.newPianistTake(clip.id) } : null,
        clip.kind === 'pianist' ? { label: 'Keep as MIDI clip (editable)', action: () => app.pianistToMidi(clip.id) } : null,
        clip.kind === 'pianist' ? { sep: true } : null,
        { label: 'Rename…', action: async () => { const n = await promptText('Rename clip', clip.name); if (n) app.store.do('Rename clip', (q) => { findClip(q, clip.id).clip.name = n; }, 'clips'); } },
        { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => app.duplicateClips(ids) },
        { label: 'Split at playhead', shortcut: 'Ctrl+E', action: () => app.splitClips(ids, app.ui.cursor) },
        { label: 'Split here', action: () => app.splitClips([clip.id], beat) },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => app.copyClips(ids) },
        { label: clip.mute ? 'Unmute clip' : 'Mute clip', action: () => app.store.do('Mute clip', (q) => { for (const id of ids) { const f = findClip(q, id); if (f) f.clip.mute = !clip.mute; } }, 'clips') },
        { label: 'Set loop to clip', shortcut: 'Ctrl+L', action: () => app.setLoop(clip.start, clip.start + clip.length) },
        clip.kind === 'audio' ? { label: 'Clip gain…', action: async () => { const n = await promptText('Clip gain (dB)', String(clip.gain || 0), 'Gain dB'); const v = parseFloat(n); if (Number.isFinite(v)) app.store.do('Clip gain', (q) => { findClip(q, clip.id).clip.gain = clamp(v, -48, 24); }, 'clips'); } } : null,
        { sep: true },
        { label: 'Delete', shortcut: 'Del', danger: true, action: () => app.deleteClips(ids) },
      ]);
      return;
    }
    if (ht.type === 'point') {
      const chId = ht.row.ch.id, laneId = ht.row.lane.id;
      contextMenu(e.clientX, e.clientY, [{ label: 'Delete point', danger: true, action: () => app.store.do('Delete automation point', (q) => { findChannel(q, chId).automation.find((a) => a.id === laneId).points.splice(ht.index, 1); }, 'auto') }]);
      return;
    }
    if (ht.type === 'lane') {
      const chId = ht.row.ch.id, lane = ht.row.lane;
      contextMenu(e.clientX, e.clientY, [
        { label: 'Clear all points', disabled: !lane.points.length, action: () => app.clearLane(chId, lane.target) },
        { label: 'Remove lane', danger: true, action: () => app.removeLane(chId, lane.id) },
      ]);
      return;
    }
    const items = [];
    if (ht.type === 'empty' && ht.row.ch.kind === 'instrument') items.push({ label: 'Create MIDI clip', action: () => { const bar = barBeats(app.p); app.createMidiClip(ht.row.ch.id, Math.floor(beat / bar) * bar, bar); } });
    if (this.app.clipboard) items.push({ label: 'Paste at playhead', shortcut: 'Ctrl+V', action: () => app.pasteClips() });
    items.push({ label: 'Add marker here', action: () => app.addMarker(beat) });
    items.push({ sep: true }, { label: 'New instrument track', action: () => app.addInstrumentTrack() }, { label: 'New audio track', action: () => app.addAudioTrack() }, { label: 'New return bus', action: () => app.addBus(true) });
    contextMenu(e.clientX, e.clientY, items);
  }

  // ------------------------------------------------------------ ruler
  onRulerHover(e) {
    const r = this.rulerCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, p = this.app.p;
    if (y >= 16 && y < 38) {
      const R = y < 28 ? p.loop : p.punch, lx0 = this.x(R.start), lx1 = this.x(R.end);
      this.rulerCv.style.cursor = Math.abs(x - lx0) < 6 || Math.abs(x - lx1) < 6 ? 'ew-resize' : x > lx0 && x < lx1 ? 'grab' : 'copy';
      this.rulerCv.title = y < 28 ? 'Drag to set the loop · drag the bar to move it · double-click toggles the loop'
        : 'Punch range (red): drag to set it · drag the bar to move it · double-click toggles punch · right-click for pre-roll';
    } else if (y < 16) { this.rulerCv.style.cursor = 'default'; this.rulerCv.title = 'Markers — double-click to add, drag to move, right-click to rename'; }
    else { this.rulerCv.style.cursor = 'text'; this.rulerCv.title = 'Click or drag to move the playhead'; }
  }
  onRulerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = this.app, p = app.p;
    const r = this.rulerCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const bAt = (ev) => Math.max(0, this.snap(this.beat(ev.clientX - r.left), ev));
    if (y < 16) {
      const m = p.markers.find((mk) => Math.abs(this.x(mk.beat) - x) < 6 || (x >= this.x(mk.beat) && x <= this.x(mk.beat) + 60));
      if (!m) return;
      const id = m.id;
      let moved = false;
      app.store.begin('Move marker');
      drag(e, {
        move: (ev) => { moved = true; app.store.live((q) => { const mk = q.markers.find((k) => k.id === id); if (mk) mk.beat = bAt(ev); }, 'markers'); },
        up: () => { app.store.end('markers'); if (!moved) app.locate(m.beat); },
      });
      return;
    }
    if (y < 38) {
      const key = y < 28 ? 'loop' : 'punch';
      const lx0 = this.x(p[key].start), lx1 = this.x(p[key].end);
      const L0 = { ...p[key] };
      let mode = Math.abs(x - lx0) < 6 ? 'start' : Math.abs(x - lx1) < 6 ? 'end' : x > lx0 && x < lx1 ? 'move' : 'new';
      const b0 = bAt(e);
      app.store.begin(key === 'loop' ? 'Set loop' : 'Set punch range');
      drag(e, {
        move: (ev) => {
          const b = bAt(ev);
          app.store.live((q) => {
            const R = q[key];
            if (mode === 'start') R.start = Math.min(b, L0.end - 0.25);
            else if (mode === 'end') R.end = Math.max(b, L0.start + 0.25);
            else if (mode === 'move') { const d = b - b0; R.start = Math.max(0, L0.start + d); R.end = R.start + (L0.end - L0.start); }
            else { const a = Math.min(b0, b), z = Math.max(b0, b); if (z - a >= 0.25) { R.start = a; R.end = z; R.on = true; } }
            if (key === 'punch') R.set = true;
          }, 'transport');
        },
        up: () => app.store.end('transport'),
      });
      return;
    }
    app.locate(bAt(e));
    drag(e, { move: (ev) => app.locate(bAt(ev)) });
  }
  onRulerDbl(e) {
    const r = this.rulerCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < 16) this.app.addMarker(Math.max(0, this.snap(this.beat(x))));
    else if (y < 28) this.app.toggleLoop();
    else if (y < 38) this.app.togglePunch();
  }
  onRulerContext(e) {
    e.preventDefault();
    const app = this.app, r = this.rulerCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (y >= 28 && y < 38) { punchMenu(app, e.clientX, e.clientY, Math.max(0, this.snap(this.beat(x)))); return; }
    const m = app.p.markers.find((mk) => x >= this.x(mk.beat) - 4 && x <= this.x(mk.beat) + 70);
    const beat = Math.max(0, this.snap(this.beat(x)));
    contextMenu(e.clientX, e.clientY, [
      m ? { label: `Rename “${m.name}”…`, action: async () => { const n = await promptText('Rename marker', m.name); if (n) app.store.do('Rename marker', (q) => { q.markers.find((k) => k.id === m.id).name = n; }, 'markers'); } } : null,
      m ? { label: 'Delete marker', danger: true, action: () => app.store.do('Delete marker', (q) => { q.markers = q.markers.filter((k) => k.id !== m.id); }, 'markers') } : null,
      m ? { sep: true } : null,
      { label: 'Add marker here', action: () => app.addMarker(beat) },
      { label: 'Loop from here (1 bar)', action: () => app.setLoop(beat, beat + barBeats(app.p)) },
      { label: app.p.loop.on ? 'Disable loop' : 'Enable loop', action: () => app.toggleLoop() },
      { label: 'Punch from here (1 bar)', action: () => app.setPunch(beat, beat + barBeats(app.p)) },
    ]);
  }

  // ------------------------------------------------------------ zoom / scroll
  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = this.lanes.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scrollX = Math.max(0, this.scrollX + (e.shiftKey ? e.deltaY : e.deltaX) / this.ppb);
      this.dirty = true;
    } else {
      this.scrollY = clamp(this.scrollY + e.deltaY, 0, Math.max(0, this.totalH - this.H + 60));
      this.headInner.style.transform = `translateY(${-this.scrollY}px)`;
      this.dirty = true;
    }
  }
  zoomBy(f, ax = null) {
    const anchor = ax ?? this.x(this.app.isPlaying ? this.app.engine.position : this.app.ui.cursor);
    const b = this.beat(anchor);
    this.ppb = clamp(this.ppb * f, 1.5, 600);
    this.scrollX = Math.max(0, b - anchor / this.ppb);
    this.dirty = true;
  }
  zoomFit() {
    const end = Math.max(projectEndBeat(this.app.p), this.app.p.loop.on ? this.app.p.loop.end : 0, barBeats(this.app.p) * 4);
    this.ppb = clamp((this.W - 30) / end, 1.5, 600);
    this.scrollX = 0; this.dirty = true;
  }

  // ------------------------------------------------------------ drag & drop
  dropTarget(e) {
    const { x, y } = this.local(e);
    const r = this.rowAt(y);
    return { x: Math.max(0, x), y, row: r, beat: Math.max(0, this.snap(this.beat(Math.max(0, x)), e)) };
  }
  onDragOver(e) {
    const files = e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    if (!currentDrag && !files) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const t = this.dropTarget(e);
    const kind = currentDrag ? currentDrag.kind : 'files';
    const row = t.row && t.row.kind !== 'divider' && t.row.kind !== 'lane' ? t.row : null;
    let valid = true;
    if (kind === 'sample' || kind === 'asset' || kind === 'files') valid = !row || row.kind === 'track';
    const yy = row ? row.y - this.scrollY : this.totalH - this.scrollY;
    this.drop = { y: yy, h: row ? row.h : 40, x: kind === 'sample' || kind === 'asset' || kind === 'files' ? this.x(t.beat) : null, valid };
  }
  clearDrop() { this.drop = null; }
  async onDrop(e) {
    e.preventDefault();
    const app = this.app, t = this.dropTarget(e);
    this.drop = null;
    document.body.classList.remove('dnd-active');
    const row = t.row && (t.row.kind === 'track' || t.row.kind === 'bus' || t.row.kind === 'master') ? t.row : null;
    if (e.dataTransfer.files && e.dataTransfer.files.length && !currentDrag) {
      await app.ensureAudio();
      const trackId = row && row.kind === 'track' && row.ch.kind === 'audio' ? row.ch.id : null;
      await app.importAudioFiles([...e.dataTransfer.files], trackId, t.beat);
      return;
    }
    const pl = currentDrag;
    if (!pl) return;
    if (pl.kind === 'instrument') app.addInstrumentTrack(null, row && row.kind === 'track' ? row.index + 1 : null);
    else if (pl.kind === 'drumkit') app.addDrummerTrack('nova', row && row.kind === 'track' ? row.index + 1 : null);
    else if (pl.kind === 'drummer') {
      if (row && row.kind === 'track' && isDrumTrack(row.ch)) { app.chooseDrummer(row.ch.id, pl.id, (app.drummerTarget(row.ch.id) || {}).id); app.selectTrack(row.ch.id, { openInstrument: true }); toast(`${drummerById(pl.id).name} is now playing ${row.ch.name}`); }
      else app.addDrummerTrack(pl.id, row && row.kind === 'track' ? row.index + 1 : null);
    }
    else if (pl.kind === 'worship') app.addWorshipTrack('Endless Worship', row && row.kind === 'track' ? row.index + 1 : null);
    else if (pl.kind === 'piano') app.addPianoTrack(0, row && row.kind === 'track' ? row.index + 1 : null);
    else if (pl.kind === 'wpreset') {
      if (row && row.kind === 'track' && row.ch.instrument && row.ch.instrument.type === 'worship') { app.loadPadPreset(row.ch.id, pl.name); toast(`Loaded ${pl.name}`); }
      else app.addWorshipTrack(pl.name, row && row.kind === 'track' ? row.index + 1 : null);
    }
    else if (pl.kind === 'preset') {
      if (row && row.kind === 'track' && row.ch.kind === 'instrument') { app.loadPreset(row.ch.id, pl.preset); app.selectTrack(row.ch.id, { openInstrument: true }); toast(`Loaded ${pl.preset.name}`); }
      else app.addInstrumentTrack(pl.preset);
    } else if (pl.kind === 'effect') app.addInsert(row ? row.ch.id : app.selectedChannel.id, pl.name);
    else if (pl.kind === 'sample') { await app.ensureAudio(); await app.addFactorySample(pl.sample, row && row.kind === 'track' && row.ch.kind === 'audio' ? row.ch.id : null, t.beat); }
    else if (pl.kind === 'asset') { const item = app.assets.get(pl.assetId); if (item && !item.missing) await app.placeAsset(item, row && row.kind === 'track' && row.ch.kind === 'audio' ? row.ch.id : null, t.beat); }
  }

  // ------------------------------------------------------------ keys
  onKey(e) {
    const app = this.app, mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    const sel = [...app.ui.selClips];
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { app.deleteClips(sel); return true; }
    if (mod && k === 'd' && sel.length) { app.duplicateClips(sel); return true; }
    if (mod && k === 'c' && sel.length) { app.copyClips(sel); return true; }
    if (mod && k === 'v') { app.pasteClips(); return true; }
    if (mod && k === 'e') { app.splitClips(sel.length ? sel : (app.selectedTrack ? app.selectedTrack.clips.map((c) => c.id) : []), app.isPlaying ? app.engine.position : app.ui.cursor); return true; }
    if (mod && k === 'a') { app.selectClips(app.p.tracks.flatMap((t) => t.clips.map((c) => c.id))); return true; }
    if (mod && k === 'l' && sel.length) {
      const f = sel.map((id) => findClip(app.p, id)).filter(Boolean);
      app.setLoop(Math.min(...f.map((x) => x.clip.start)), Math.max(...f.map((x) => x.clip.start + x.clip.length)));
      return true;
    }
    if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel.length) {
      const d = (e.key === 'ArrowRight' ? 1 : -1) * (this.gridUnit() || 0.25);
      app.store.do('Nudge clips', (q) => { for (const id of sel) { const f = findClip(q, id); if (f) f.clip.start = Math.max(0, f.clip.start + d); } }, 'clips');
      return true;
    }
    if (!mod && (e.key === '+' || e.key === '=')) { this.zoomBy(1.4); return true; }
    if (!mod && e.key === '-') { this.zoomBy(1 / 1.4); return true; }
    return false;
  }
}

// Punch options: on/off, pre-roll, and quick ways to set the range.
export function punchMenu(app, x, y, beat = null) {
  const P = app.p.punch, bar = barBeats(app.p);
  const pre = (v, label) => ({ label, checked: P.preRoll === v, action: () => app.setPreRoll(v) });
  const sel = [...app.ui.selClips].map((id) => findClip(app.p, id)).filter(Boolean).map((f) => f.clip);
  contextMenu(x, y, [
    { label: P.on ? 'Turn punch off' : 'Turn punch on', shortcut: 'I', action: () => app.togglePunch() },
    { sep: true }, { header: 'When recording from stop, start' },
    pre(1, '1 bar before the punch-in'), pre(2, '2 bars before the punch-in'),
    pre(0, 'At the punch-in (with count-in)'), pre(-1, 'From the playhead'),
    { sep: true },
    { label: 'Set punch range to the loop', action: () => app.setPunch(app.p.loop.start, app.p.loop.end) },
    sel.length ? { label: 'Set punch range to the selected clips', action: () => app.setPunch(Math.min(...sel.map((c) => c.start)), Math.max(...sel.map((c) => c.start + c.length))) } : null,
    beat != null ? { label: 'Punch from here (1 bar)', action: () => app.setPunch(beat, beat + bar) } : null,
  ]);
}

