// Saw Forge wavetable editor: 3D frame stack (with live playing position),
// key-frame strip, and three editing modes for the selected key frame:
//   Shape     - analog saw controls (ramp curvature, reset slope, even/odd, tilt)
//   Harmonics - paint per-harmonic gains (1..64) over the measured spectrum
//   Draw      - draggable points with linear or smooth interpolation
// Edits rebuild band-limited tables in a worker; previews here are computed
// from the same spectral model so what you see is what the oscillator plays.

import { h, drag, Surface, clamp, css } from './dom.js';
import { icon } from './icons.js';
import { selectEl, contextMenu, toast } from './widgets.js';
import {
  WT_PRESETS, WT_EDIT_HARM, WT_MAX_KEYS, previewFrame, prototypeFrame, frameMagnitudes, makeFrame, defaultDrawPoints,
  sortedPoints, renderedFrameCount, wavetableHash, getWtPreset,
} from '../shared/wavetable.js';

const SHAPE_CTRLS = [
  { key: 'curve', label: 'Curve', min: -1, max: 1, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2), tip: 'Ramp curvature: analog capacitor charge (+) or convex ramp (−)' },
  { key: 'reset', label: 'Reset', min: 0, max: 0.5, def: 0, fmt: (v) => Math.round(v * 200) + '%', tip: 'Reset slope: 0 = ideal saw, 100% = triangle' },
  { key: 'even', label: 'Even', min: 0, max: 1, def: 1, fmt: (v) => Math.round(v * 100) + '%', tip: 'Even-harmonic level: 0 = square-like, 100% = saw' },
  { key: 'bright', label: 'Tilt', min: -1, max: 1, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2), tip: 'Spectral tilt: darker (−) or brighter (+)' },
];

export class WavetableEditor {
  constructor(synth) {
    this.synth = synth; this.app = synth.app;
    this.cache = { key: '', slices: null };
    this.livePos = [-1, -1];
    this.dirty = true;
    const app = this.app;

    this.oscTabs = ['A', 'B'].map((n, i) => h('button', { class: 'seg-btn', onClick: () => { app.ui.wtOsc = i; this.dirty = true; this.refresh(); } }, `OSC ${n}`));
    this.presetSel = h('div', { class: 'wt-preset-wrap' });
    this.modeTabs = [['shape', 'Shape'], ['harm', 'Harmonics'], ['draw', 'Draw']].map(([m, l]) => h('button', { class: 'seg-btn', onClick: () => { app.ui.wtMode = m; this.refresh(); } }, l));
    this.cv3 = h('canvas', { class: 'wt-3d', title: 'Wavetable — drag up/down to scan the position' });
    this.cvE = h('canvas', { class: 'wt-edit' });
    this.cvF = h('canvas', { class: 'wt-frames', title: 'Key frames — click to select' });
    this.posLabel = h('div', { class: 'wt-pos-label' });
    this.editHint = h('div', { class: 'wt-hint' });
    this.shapeRow = h('div', { class: 'wt-shape-row' });
    this.harmRow = h('div', { class: 'wt-tool-row' },
      h('button', { class: 'btn ghost xs', onClick: () => this.harmPreset('reset') }, 'Reset'),
      h('button', { class: 'btn ghost xs', onClick: () => this.harmPreset('odd') }, 'Odd only'),
      h('button', { class: 'btn ghost xs', onClick: () => this.harmPreset('thin') }, 'Thin'),
      h('button', { class: 'btn ghost xs', onClick: () => this.harmPreset('formant') }, 'Formant'),
      h('button', { class: 'btn ghost xs', title: 'Randomize harmonic gains', onClick: () => this.harmPreset('random') }, icon('dice', 12), ' Random'));
    this.smoothBtn = h('button', { class: 'btn ghost xs toggle', onClick: () => this.toggleSmooth() }, 'Smooth');
    this.drawRow = h('div', { class: 'wt-tool-row' }, this.smoothBtn,
      h('button', { class: 'btn ghost xs', onClick: () => this.drawPreset('saw') }, 'Saw'),
      h('button', { class: 'btn ghost xs', onClick: () => this.drawPreset('pulse') }, 'Pulse'),
      h('button', { class: 'btn ghost xs', onClick: () => this.drawPreset('steps') }, 'Steps'),
      h('button', { class: 'btn ghost xs', onClick: () => this.drawPreset('hump') }, 'Hump'),
      h('button', { class: 'btn ghost xs', title: 'Return this frame to the analog saw model', onClick: () => this.clearDraw() }, 'Use analog saw'));
    this.shapeCtrls = SHAPE_CTRLS.map((c) => this.makeShapeSlider(c));
    this.shapeRow.append(...this.shapeCtrls.map((s) => s.el));

    this.addBtn = h('button', { class: 'ibtn xs', title: 'Add key frame (duplicate selected)', onClick: () => this.addFrame() }, icon('plus', 12));
    this.delBtn = h('button', { class: 'ibtn xs', title: 'Delete selected key frame', onClick: () => this.deleteFrame() }, icon('trash', 12));
    this.el = h('div', { class: 'sf-card wt-card' },
      h('div', { class: 'card-head wt-head' },
        h('div', { class: 'seg' }, this.oscTabs), this.presetSel,
        h('div', { class: 'tb-spacer' }),
        h('div', { class: 'seg' }, this.modeTabs)),
      h('div', { class: 'wt-main' },
        h('div', { class: 'wt-3d-wrap' }, this.cv3, this.posLabel),
        h('div', { class: 'wt-edit-wrap' }, this.cvE, this.editHint)),
      h('div', { class: 'wt-bottom' },
        h('div', { class: 'wt-frames-wrap' }, h('span', { class: 'wt-frames-label' }, 'Frames'), this.cvF, this.addBtn, this.delBtn),
        h('div', { class: 'wt-controls' }, this.shapeRow, this.harmRow, this.drawRow)));
    this.s3 = new Surface(this.cv3, () => { this.dirty = true; });
    this.sE = new Surface(this.cvE, () => { this.dirty = true; });
    this.sF = new Surface(this.cvF, () => { this.dirty = true; });
    this.cv3.addEventListener('pointerdown', (e) => this.onScan(e));
    this.cvE.addEventListener('pointerdown', (e) => this.onEditDown(e));
    this.cvE.addEventListener('dblclick', (e) => this.onEditDbl(e));
    this.cvE.addEventListener('contextmenu', (e) => this.onEditContext(e));
    this.cvE.addEventListener('pointermove', (e) => this.onEditHover(e));
    this.cvF.addEventListener('pointerdown', (e) => this.onFrameDown(e));
  }

  get osc() { return this.app.ui.wtOsc || 0; }
  get track() { return this.synth.track; }
  get wt() { const t = this.track; return t && t.instrument ? t.instrument.wt[this.osc] : null; }
  get frameIndex() { const w = this.wt; return w ? clamp(this.app.ui.wtFrame[this.osc] || 0, 0, w.frames.length - 1) : 0; }
  set frameIndex(i) { this.app.ui.wtFrame[this.osc] = i; }
  get frame() { const w = this.wt; return w ? w.frames[this.frameIndex] : null; }
  edit(fn, phase = 'do', label) { this.app.wtEdit(this.track.id, this.osc, fn, phase, label); }
  editFrame(fn, phase, label) { const i = this.frameIndex; this.edit((wt) => fn(wt.frames[i]), phase, label); }

  makeShapeSlider(c) {
    const fill = h('div', { class: 'wsl-fill' }), val = h('span', { class: 'wsl-val' });
    const bar = h('div', { class: 'wsl-bar' }, fill);
    const el = h('div', { class: 'wsl', title: c.tip }, h('span', { class: 'wsl-label' }, c.label), bar, val);
    const set = (v) => {
      const n = (v - c.min) / (c.max - c.min), bip = c.min < 0;
      if (bip) { fill.style.left = `${Math.min(0.5, n) * 100}%`; fill.style.width = `${Math.abs(n - 0.5) * 100}%`; }
      else { fill.style.left = '0'; fill.style.width = `${n * 100}%`; }
      val.textContent = c.fmt(v);
    };
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.frame) return;
      const r = bar.getBoundingClientRect();
      const toV = (x) => clamp(c.min + ((x - r.left) / r.width) * (c.max - c.min), c.min, c.max);
      const v0 = toV(e.clientX);
      this.editFrame((f) => { f[c.key] = v0; }, 'begin', `Wavetable ${c.label}`);
      drag(e, { cursor: 'ew-resize', move: (ev) => this.editFrame((f) => { f[c.key] = toV(ev.clientX); }, 'live'), up: () => this.edit(null, 'end') });
    });
    bar.addEventListener('dblclick', () => this.editFrame((f) => { f[c.key] = c.def; }, 'do', `Reset ${c.label}`));
    return { el, set, c };
  }

  refresh() {
    const app = this.app, wt = this.wt;
    this.oscTabs.forEach((b, i) => b.classList.toggle('on', i === this.osc));
    const mode = app.ui.wtMode || 'shape';
    this.modeTabs.forEach((b) => b.classList.toggle('on', b.textContent.toLowerCase().startsWith(mode === 'harm' ? 'harm' : mode)));
    if (!wt) return;
    const names = WT_PRESETS.map((w) => w.name);
    const cur = names.includes(wt.name) ? wt.name : '__custom';
    const opts = [...(cur === '__custom' ? [{ value: '__custom', label: wt.name }] : []), ...names.map((n) => ({ value: n, label: n }))];
    const key = cur + '|' + wt.name;
    if (key !== this.presetKey) {
      this.presetKey = key;
      this.presetSel.replaceChildren(selectEl(opts, cur, (v) => { if (v !== '__custom') app.setWavetable(this.track.id, this.osc, getWtPreset(v)); }, 'wt-preset', 'Load a factory wavetable'));
    }
    const f = this.frame;
    this.shapeCtrls.forEach((s) => s.set(f[s.c.key] ?? s.c.def));
    this.shapeRow.style.display = mode === 'shape' ? '' : 'none';
    this.harmRow.style.display = mode === 'harm' ? '' : 'none';
    this.drawRow.style.display = mode === 'draw' ? '' : 'none';
    this.smoothBtn.classList.toggle('on', !!(f.draw && f.draw.smooth));
    this.delBtn.disabled = wt.frames.length <= 1;
    this.addBtn.disabled = wt.frames.length >= WT_MAX_KEYS;
    this.editHint.textContent = mode === 'shape'
      ? (f.draw ? 'Drawn frame — Even/Tilt still apply; switch to Draw to edit points' : 'Analog saw model — band-limited result shown; dashed line is the raw ramp')
      : mode === 'harm' ? 'Paint harmonic gains (bars) · dots show the resulting spectrum · Shift = fine'
      : f.draw ? 'Drag points · double-click to add · right-click to delete' : 'Click to start drawing this frame from a saw';
    this.dirty = true;
  }

  // ------------------------------------------------------------ geometry for 3D stack
  slices() {
    const wt = this.wt;
    const key = wavetableHash(wt);
    if (this.cache.key === key) return this.cache.slices;
    const F = renderedFrameCount(wt.frames.length);
    const S = Math.min(26, Math.max(F, 14));
    const slices = [];
    for (let i = 0; i < S; i++) slices.push(previewFrame(wt, S === 1 ? 0 : i / (S - 1), 128, 40));
    this.cache = { key, slices, thumbs: wt.frames.map((fr) => previewFrame({ frames: [fr] }, 0, 128, 32)) };
    return slices;
  }

  frame3dPos() {
    const t = this.track;
    if (!t) return 0;
    const p = t.instrument.params[(this.osc ? 'b' : 'a') + '.pos'];
    return this.livePos[this.osc] >= 0 ? this.livePos[this.osc] : p;
  }

  draw() {
    if (!this.wt) return;
    this.draw3d(); this.drawEdit(); this.drawFrames();
  }

  draw3d() {
    const s = this.s3, c = s.ctx, accent = css('--accent') || '#ff8f3c';
    s.clear();
    const g = c.createLinearGradient(0, 0, 0, s.h);
    g.addColorStop(0, '#15181c'); g.addColorStop(1, '#0d0f11');
    c.fillStyle = g; c.fillRect(0, 0, s.w, s.h);
    const slices = this.slices();
    const S = slices.length;
    const pos = this.frame3dPos(), param = this.track.instrument.params[(this.osc ? 'b' : 'a') + '.pos'];
    const depthX = Math.min(70, s.w * 0.22), depthY = Math.min(58, s.h * 0.34);
    const w = s.w - depthX - 28, amp = (s.h - depthY - 28) * 0.42;
    const baseX = 14, baseY = s.h - 14 - amp;
    // floor guide
    c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(baseX, baseY + amp); c.lineTo(baseX + w, baseY + amp); c.lineTo(baseX + w + depthX, baseY + amp - depthY); c.stroke();
    const sliceXY = (i) => { const t = S === 1 ? 0 : i / (S - 1); return [baseX + t * depthX, baseY - t * depthY]; };
    for (let i = S - 1; i >= 0; i--) {
      const [ox, oy] = sliceXY(i), d = slices[i];
      const t = S === 1 ? 0 : i / (S - 1);
      const near = Math.abs(t - pos) < 0.5 / Math.max(1, S - 1);
      c.beginPath();
      for (let k = 0; k < d.length; k++) { const x = ox + (k / (d.length - 1)) * w, y = oy - d[k] * amp; k ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.strokeStyle = near ? 'rgba(255,255,255,0)' : `rgba(170,190,210,${0.12 + 0.22 * (1 - t)})`;
      c.lineWidth = 1; c.stroke();
    }
    // highlighted (interpolated) frame at position
    const live = previewFrame(this.wt, pos, 256, 64);
    const ox = baseX + pos * depthX, oy = baseY - pos * depthY;
    c.save();
    c.shadowColor = accent; c.shadowBlur = 10;
    c.beginPath();
    for (let k = 0; k < live.length; k++) { const x = ox + (k / (live.length - 1)) * w, y = oy - live[k] * amp; k ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.strokeStyle = accent; c.lineWidth = 2; c.stroke();
    c.restore();
    // position rail
    const rx = s.w - 10;
    c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(rx, 12, 3, s.h - 24);
    c.fillStyle = 'rgba(255,255,255,0.45)'; c.fillRect(rx - 2, 12 + (1 - param) * (s.h - 24) - 1, 7, 2);
    c.fillStyle = accent; c.beginPath(); c.arc(rx + 1.5, 12 + (1 - pos) * (s.h - 24), 3.5, 0, Math.PI * 2); c.fill();
    this.posLabel.textContent = `Position ${Math.round(pos * 100)}%${this.livePos[this.osc] >= 0 ? ' · live' : ''}`;
  }

  editGeom() { const s = this.sE; return { x0: 12, x1: s.w - 12, y0: 10, y1: s.h - 10, mid: s.h / 2 }; }

  drawEdit() {
    const s = this.sE, c = s.ctx, f = this.frame, mode = this.app.ui.wtMode || 'shape', accent = css('--accent') || '#ff8f3c';
    s.clear();
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, s.w, s.h);
    const G = this.editGeom();
    c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 1;
    for (const q of [0.25, 0.5, 0.75]) { const x = G.x0 + q * (G.x1 - G.x0); c.beginPath(); c.moveTo(x, G.y0); c.lineTo(x, G.y1); c.stroke(); }
    c.beginPath(); c.moveTo(G.x0, G.mid); c.lineTo(G.x1, G.mid); c.stroke();
    const amp = (G.y1 - G.y0) / 2 * 0.9;
    if (mode === 'harm') return this.drawHarm(c, G, accent);
    const raw = prototypeFrame(f, 256);
    const bl = previewFrame({ frames: [f] }, 0, 512, 200);
    const line = (arr, color, width, dash) => {
      c.beginPath();
      for (let k = 0; k < arr.length; k++) { const x = G.x0 + (k / arr.length) * (G.x1 - G.x0), y = G.mid - arr[k] * amp; k ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.strokeStyle = color; c.lineWidth = width; c.setLineDash(dash || []); c.stroke(); c.setLineDash([]);
    };
    if (mode === 'draw' && f.draw) {
      line(bl, 'rgba(255,143,60,0.45)', 1.2);
      line(raw, '#e9edf1', 1.6);
      const pts = sortedPoints(f.draw.points);
      for (let i = 0; i < pts.length; i++) {
        const x = G.x0 + pts[i].x * (G.x1 - G.x0), y = G.mid - pts[i].y * amp;
        const hov = this.hoverPt === i;
        c.beginPath(); c.arc(x, y, hov ? 6 : 4.5, 0, Math.PI * 2);
        c.fillStyle = hov ? '#ffffff' : accent; c.fill(); c.strokeStyle = '#0e1012'; c.lineWidth = 1.5; c.stroke();
      }
    } else {
      line(raw, 'rgba(200,210,220,0.35)', 1, [3, 3]);
      c.save(); c.shadowColor = accent; c.shadowBlur = 8; line(bl, accent, 2); c.restore();
      if (mode === 'draw') { c.fillStyle = 'rgba(14,16,18,0.6)'; c.fillRect(0, 0, s.w, s.h); c.fillStyle = '#d9dde1'; c.font = '600 12px var(--font-ui, sans-serif)'; c.textAlign = 'center'; c.fillText('Click to start drawing from this shape', s.w / 2, s.h / 2 + 4); c.textAlign = 'left'; }
    }
  }

  drawHarm(c, G, accent) {
    const f = this.frame;
    const gains = f.harm || new Array(WT_EDIT_HARM).fill(1);
    const mags = frameMagnitudes(f, WT_EDIT_HARM);
    const n = WT_EDIT_HARM, bw = (G.x1 - G.x0) / n;
    const top = G.y0, hgt = G.y1 - G.y0;
    c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(G.x0, top + hgt * (1 - 1 / 1.5), G.x1 - G.x0, 1);
    for (let k = 0; k < n; k++) {
      const g = clamp(gains[k], 0, 1.5) / 1.5;
      const x = G.x0 + k * bw;
      c.fillStyle = k % 2 === 1 ? 'rgba(255,143,60,0.55)' : 'rgba(255,143,60,0.8)';
      c.fillRect(x + 0.5, top + hgt * (1 - g), Math.max(1, bw - 1.5), hgt * g);
    }
    // resulting magnitude (log) dots
    c.fillStyle = '#e9edf1';
    for (let k = 0; k < n; k++) {
      const db = 20 * Math.log10(mags[k] + 1e-9);
      const v = clamp((db + 60) / 66, 0, 1);
      c.fillRect(G.x0 + k * bw + bw / 2 - 1, top + hgt * (1 - v) - 1, 2.5, 2.5);
    }
    c.fillStyle = '#6f7880'; c.font = '10px var(--font-mono, monospace)';
    for (const k of [1, 8, 16, 32, 64]) c.fillText(String(k), G.x0 + (k - 1) * bw + 1, G.y1 + 0);
  }

  drawFrames() {
    const s = this.sF, c = s.ctx, wt = this.wt, accent = css('--accent') || '#ff8f3c';
    s.clear();
    this.slices();
    const thumbs = this.cache.thumbs;
    const K = wt.frames.length, gap = 6, tw = Math.min(64, (s.w - gap * (K - 1)) / K), th = s.h - 4;
    this.thumbRects = [];
    for (let i = 0; i < K; i++) {
      const x = i * (tw + gap), y = 2;
      this.thumbRects.push([x, x + tw]);
      const sel = i === this.frameIndex;
      c.fillStyle = sel ? 'rgba(255,143,60,0.14)' : '#121417'; c.fillRect(x, y, tw, th);
      c.strokeStyle = sel ? accent : 'rgba(255,255,255,0.1)'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
      const d = thumbs[i];
      c.beginPath();
      for (let k = 0; k < d.length; k++) { const px = x + 3 + (k / (d.length - 1)) * (tw - 6), py = y + th / 2 - d[k] * (th / 2 - 4); k ? c.lineTo(px, py) : c.moveTo(px, py); }
      c.strokeStyle = sel ? accent : '#9aa5b1'; c.lineWidth = 1.2; c.stroke();
      c.fillStyle = '#6f7880'; c.font = '9px var(--font-mono, monospace)'; c.fillText(String(i + 1), x + 3, y + 10);
    }
    if (K > 1) {
      const pos = this.frame3dPos(), span = K * tw + (K - 1) * gap - tw;
      const px = tw / 2 + pos * span;
      c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(px, th - 1, 1.5, 4);
    }
  }

  // ------------------------------------------------------------ interactions
  onScan(e) {
    if (e.button !== 0 || !this.track) return;
    e.preventDefault();
    const app = this.app, pid = (this.osc ? 'b' : 'a') + '.pos', tid = this.track.id;
    const r = this.cv3.getBoundingClientRect();
    const toV = (y) => clamp(1 - (y - r.top - 12) / (r.height - 24), 0, 1);
    app.synthBegin('Wavetable position');
    app.synthLive(tid, pid, toV(e.clientY));
    drag(e, { cursor: 'ns-resize', move: (ev) => app.synthLive(tid, pid, toV(ev.clientY)), up: () => app.synthEnd() });
  }

  onFrameDown(e) {
    const r = this.cvF.getBoundingClientRect(), x = e.clientX - r.left;
    const i = (this.thumbRects || []).findIndex(([a, b]) => x >= a && x <= b);
    if (i >= 0) { this.frameIndex = i; this.refresh(); }
  }
  addFrame() {
    const wt = this.wt;
    if (!wt || wt.frames.length >= WT_MAX_KEYS) return;
    const i = this.frameIndex;
    this.edit((w) => { w.frames.splice(i + 1, 0, JSON.parse(JSON.stringify(w.frames[i]))); }, 'do', 'Add key frame');
    this.frameIndex = i + 1; this.refresh();
  }
  deleteFrame() {
    const wt = this.wt;
    if (!wt || wt.frames.length <= 1) return;
    const i = this.frameIndex;
    this.edit((w) => { w.frames.splice(i, 1); }, 'do', 'Delete key frame');
    this.frameIndex = Math.max(0, i - 1); this.refresh();
  }

  harmPreset(kind) {
    let seed = (Date.now() & 0xffff) || 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gen = {
      reset: () => null,
      odd: () => Array.from({ length: WT_EDIT_HARM }, (_, i) => ((i + 1) % 2 === 0 ? 0 : 1)),
      thin: () => Array.from({ length: WT_EDIT_HARM }, (_, i) => (i < 2 ? 0.25 : 1)),
      formant: () => Array.from({ length: WT_EDIT_HARM }, (_, i) => 0.2 + 1.2 * Math.exp(-Math.pow((i + 1 - 9) / 3, 2)) + 0.7 * Math.exp(-Math.pow((i + 1 - 22) / 5, 2))),
      random: () => Array.from({ length: WT_EDIT_HARM }, (_, i) => (i === 0 ? 1 : clamp(rnd() * 1.3 * (1 - i / 90), 0, 1.5))),
    }[kind];
    this.editFrame((f) => { f.harm = gen(); }, 'do', 'Harmonics preset');
  }

  harmAt(x, y) {
    const G = this.editGeom(), n = WT_EDIT_HARM, bw = (G.x1 - G.x0) / n;
    return { k: clamp(Math.floor((x - G.x0) / bw), 0, n - 1), g: clamp((1 - (y - G.y0) / (G.y1 - G.y0)) * 1.5, 0, 1.5) };
  }

  pointAt(x, y) {
    const f = this.frame;
    if (!f || !f.draw) return -1;
    const G = this.editGeom(), amp = (G.y1 - G.y0) / 2 * 0.9;
    const pts = sortedPoints(f.draw.points);
    for (let i = 0; i < pts.length; i++) {
      const px = G.x0 + pts[i].x * (G.x1 - G.x0), py = G.mid - pts[i].y * amp;
      if (Math.hypot(px - x, py - y) < 8) return i;
    }
    return -1;
  }
  toPoint(x, y) {
    const G = this.editGeom(), amp = (G.y1 - G.y0) / 2 * 0.9;
    return { x: clamp((x - G.x0) / (G.x1 - G.x0), 0, 0.9999), y: clamp((G.mid - y) / amp, -1, 1) };
  }

  onEditHover(e) {
    const mode = this.app.ui.wtMode;
    if (mode !== 'draw') { this.cvE.style.cursor = mode === 'harm' ? 'crosshair' : 'default'; return; }
    const r = this.cvE.getBoundingClientRect();
    const i = this.pointAt(e.clientX - r.left, e.clientY - r.top);
    this.cvE.style.cursor = i >= 0 ? 'move' : 'crosshair';
    if (i !== this.hoverPt) { this.hoverPt = i; this.drawEdit(); }
  }

  onEditDown(e) {
    if (e.button !== 0 || !this.frame) return;
    e.preventDefault();
    const mode = this.app.ui.wtMode || 'shape';
    const r = this.cvE.getBoundingClientRect();
    const lx = (ev) => ev.clientX - r.left, ly = (ev) => ev.clientY - r.top;
    if (mode === 'harm') {
      let last = this.harmAt(lx(e), ly(e));
      const paint = (a, b, fine) => (f) => {
        if (!f.harm) f.harm = new Array(WT_EDIT_HARM).fill(1);
        const k0 = Math.min(a.k, b.k), k1 = Math.max(a.k, b.k);
        for (let k = k0; k <= k1; k++) {
          const t = k1 === k0 ? 1 : (k - a.k) / (b.k - a.k);
          const g = a.g + (b.g - a.g) * t;
          f.harm[k] = fine ? f.harm[k] + (g - f.harm[k]) * 0.2 : g;
        }
      };
      this.editFrame(paint(last, last, e.shiftKey), 'begin', 'Paint harmonics');
      drag(e, { move: (ev) => { const cur = this.harmAt(lx(ev), ly(ev)); this.editFrame(paint(last, cur, ev.shiftKey), 'live'); last = cur; }, up: () => this.edit(null, 'end') });
      return;
    }
    if (mode === 'draw') {
      const f = this.frame;
      if (!f.draw) { this.editFrame((fr) => { fr.draw = { smooth: false, points: shapeToPoints(fr) }; }, 'do', 'Start drawing'); this.refresh(); return; }
      let i = this.pointAt(lx(e), ly(e));
      this.app.store.begin('Edit points');
      if (i < 0) {
        const np = this.toPoint(lx(e), ly(e));
        this.editFrame((fr) => { fr.draw.points = sortedPoints([...fr.draw.points, np]); }, 'live');
        i = sortedPoints(this.frame.draw.points).findIndex((p) => Math.abs(p.x - np.x) < 1e-9 && Math.abs(p.y - np.y) < 1e-9);
      }
      const idx = i;
      drag(e, {
        cursor: 'move',
        move: (ev) => {
          const np = this.toPoint(lx(ev), ly(ev));
          this.editFrame((fr) => {
            const pts = sortedPoints(fr.draw.points);
            const lo = idx > 0 ? pts[idx - 1].x : 0, hi = idx < pts.length - 1 ? pts[idx + 1].x : 0.9999;
            pts[idx] = { x: clamp(np.x, lo, hi), y: np.y };
            fr.draw.points = pts;
          }, 'live');
        },
        up: () => this.edit(null, 'end'),
      });
    }
  }
  onEditDbl(e) {
    if ((this.app.ui.wtMode || 'shape') !== 'draw' || !this.frame || !this.frame.draw) return;
    const r = this.cvE.getBoundingClientRect();
    const i = this.pointAt(e.clientX - r.left, e.clientY - r.top);
    if (i >= 0) this.removePoint(i);
  }
  onEditContext(e) {
    e.preventDefault();
    const mode = this.app.ui.wtMode || 'shape';
    const r = this.cvE.getBoundingClientRect();
    if (mode === 'draw' && this.frame && this.frame.draw) {
      const i = this.pointAt(e.clientX - r.left, e.clientY - r.top);
      if (i >= 0) { this.removePoint(i); return; }
    }
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy frame to all frames', action: () => { const fi = this.frameIndex; this.edit((w) => { const src = JSON.stringify(w.frames[fi]); w.frames = w.frames.map(() => JSON.parse(src)); }, 'do', 'Copy frame'); } },
      { label: 'Reset frame to analog saw', action: () => this.editFrame((f) => { Object.assign(f, makeFrame({ curve: 0.12, reset: 0.004 })); }, 'do', 'Reset frame') },
    ]);
  }
  removePoint(i) {
    const f = this.frame;
    if (sortedPoints(f.draw.points).length <= 2) { toast('A drawn frame needs at least two points.'); return; }
    this.editFrame((fr) => { const pts = sortedPoints(fr.draw.points); pts.splice(i, 1); fr.draw.points = pts; }, 'do', 'Delete point');
  }
  toggleSmooth() {
    const f = this.frame;
    if (!f) return;
    if (!f.draw) { this.editFrame((fr) => { fr.draw = { smooth: true, points: shapeToPoints(fr) }; }, 'do', 'Smooth drawing'); }
    else this.editFrame((fr) => { fr.draw.smooth = !fr.draw.smooth; }, 'do', 'Toggle smooth');
    this.refresh();
  }
  drawPreset(kind) {
    const P = {
      saw: defaultDrawPoints(),
      pulse: [{ x: 0, y: 1 }, { x: 0.299, y: 1 }, { x: 0.3, y: -1 }, { x: 0.995, y: -1 }],
      steps: [{ x: 0, y: -1 }, { x: 0.249, y: -1 }, { x: 0.25, y: -0.33 }, { x: 0.499, y: -0.33 }, { x: 0.5, y: 0.33 }, { x: 0.749, y: 0.33 }, { x: 0.75, y: 1 }, { x: 0.995, y: 1 }],
      hump: [{ x: 0, y: -1 }, { x: 0.25, y: 0.8 }, { x: 0.45, y: 0.2 }, { x: 0.7, y: 0.9 }, { x: 0.97, y: -0.6 }],
    }[kind];
    this.editFrame((f) => { f.draw = { smooth: kind === 'hump', points: P.map((p) => ({ ...p })) }; }, 'do', 'Draw preset');
    this.app.ui.wtMode = 'draw';
    this.refresh();
  }
  clearDraw() { this.editFrame((f) => { f.draw = null; }, 'do', 'Use analog saw'); this.refresh(); }

  frame_(liveA, liveB, voices) {
    const prev = this.livePos.slice();
    this.livePos = voices > 0 ? [liveA, liveB] : [-1, -1];
    if (prev[0] !== this.livePos[0] || prev[1] !== this.livePos[1]) { this.draw3d(); this.drawFrames(); }
    if (this.dirty) { this.dirty = false; this.draw(); }
  }
}

// Sample a frame's raw shape into ~12 editable points.
function shapeToPoints(fr) {
  const raw = prototypeFrame(fr, 1024);
  if (!fr.curve && !fr.reset) return defaultDrawPoints();
  const pts = [];
  for (let i = 0; i < 12; i++) { const x = i / 12; pts.push({ x, y: clamp(raw[Math.floor(x * 1024)], -1, 1) }); }
  pts.push({ x: 0.995, y: clamp(raw[1018], -1, 1) });
  return pts;
}
