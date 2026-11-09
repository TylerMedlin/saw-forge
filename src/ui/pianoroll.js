// Piano roll for MIDI clips: draw/select tools, move/resize/duplicate,
// velocity lane, quantize, keyboard audition and loop-length editing.

import { h, drag, Surface, clamp, noteName, isBlack, css } from './dom.js';
import { icon } from './icons.js';
import { selectEl, contextMenu, toast } from './widgets.js';
import { findClip, barBeats, newNote } from '../core/project.js';
import { hexA } from './arrangement.js';
import { drumNoteName } from '../shared/drums.js';

const KEYS_W = 62, RULER_H = 24, VEL_H = 86, VEL_GAP = 6, EDGE = 5;
const SNAPS = [['auto', 'Auto'], ['bar', 'Bar'], ['1', '1/4'], ['0.5', '1/8'], ['0.25', '1/16'], ['0.125', '1/32'], ['0.3333333333', '1/8 T'], ['0.1666666667', '1/16 T'], ['off', 'Off']];
const LENS = [['last', 'Last used'], ['grid', 'Grid'], ['0.125', '1/32'], ['0.25', '1/16'], ['0.5', '1/8'], ['1', '1/4'], ['2', '1/2'], ['4', '1 bar']];

export class PianoRoll {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.ppb = 90; this.keyH = 13; this.scrollX = 0; this.top = 86;
    this.tool = 'draw'; this.snapMode = 'auto'; this.lenMode = 'last'; this.lastLen = 0.25;
    this.qStrength = 1; this.qEnds = false;
    this.sel = new Set(); this.dirty = true; this.band = null; this.op = null;
    this.held = new Set(); this.clipId = null;

    this.titleEl = h('div', { class: 'pr-title' });
    this.drawBtn = h('button', { class: 'ibtn sm toggle', title: 'Draw tool (B) — click to add notes', onClick: () => this.setTool('draw') }, icon('pencil', 14));
    this.selBtn = h('button', { class: 'ibtn sm toggle', title: 'Select tool (V) — drag to select', onClick: () => this.setTool('select') }, icon('pointer', 14));
    this.snapSel = selectEl(SNAPS.map(([v, l]) => ({ value: v, label: l })), 'auto', (v) => { this.snapMode = v; this.dirty = true; }, 'snap-sel', 'Grid / snap (Alt bypasses)');
    this.lenSel = selectEl(LENS.map(([v, l]) => ({ value: v, label: l })), 'last', (v) => { this.lenMode = v; }, 'len-sel', 'Length of new notes');
    this.qBtn = h('button', { class: 'btn ghost sm', title: 'Quantize selected notes (or all) to the grid (Q)', onClick: () => this.quantize() }, 'Quantize');
    this.qMenu = h('button', { class: 'ibtn sm', title: 'Quantize options', onClick: (e) => contextMenu(e.clientX, e.clientY, [
      { header: 'Strength' }, ...[1, 0.75, 0.5, 0.25].map((s) => ({ label: `${Math.round(s * 100)}%`, checked: this.qStrength === s, action: () => { this.qStrength = s; } })),
      { sep: true }, { label: 'Also quantize note ends', checked: this.qEnds, action: () => { this.qEnds = !this.qEnds; } }]) }, icon('chevron', 12));
    this.loopInfo = h('div', { class: 'pr-loopinfo', title: 'Drag the orange handle in the ruler to change the loop length' });
    this.empty = h('div', { class: 'pr-empty' },
      h('div', { class: 'pr-empty-title' }, 'No clip selected'),
      h('div', null, 'Double-click an instrument lane in the arrangement to create a MIDI clip, or double-click an existing clip to edit it here.'));
    this.toolbar = h('div', { class: 'pr-toolbar' }, this.titleEl, h('div', { class: 'tb-sep' }), this.drawBtn, this.selBtn, h('div', { class: 'tb-sep' }),
      h('span', { class: 'tb-label' }, icon('magnet', 14)), this.snapSel, h('span', { class: 'tb-label' }, 'Len'), this.lenSel, h('div', { class: 'tb-sep' }), this.qBtn, this.qMenu,
      h('div', { class: 'tb-spacer' }), this.loopInfo,
      h('button', { class: 'ibtn sm', title: 'Zoom to fit notes', onClick: () => this.fit() }, icon('zoomIn', 14)));
    this.cv = h('canvas', { class: 'pr-cv', tabIndex: 0 });
    this.ov = h('canvas', { class: 'pr-ov' });
    this.wrap = h('div', { class: 'pr-wrap' }, this.cv, this.ov, this.empty);
    this.el = h('div', { class: 'pianoroll' }, this.toolbar, this.wrap);
    this.s = new Surface(this.cv, () => { this.dirty = true; });
    this.o = new Surface(this.ov, () => {});
    this.cv.addEventListener('pointerdown', (e) => this.onDown(e));
    this.cv.addEventListener('pointermove', (e) => this.onHover(e));
    this.cv.addEventListener('dblclick', (e) => this.onDbl(e));
    this.cv.addEventListener('contextmenu', (e) => this.onContext(e));
    this.cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('pointerdown', () => { app.ui.focus = 'editor'; }, true);
    app.addEventListener('note', (e) => { if (e.detail.on) this.held.add(e.detail.pitch); else this.held.delete(e.detail.pitch); this.dirty = true; });
    this.setTool('draw');
  }

  get clip() { const f = this.clipId && findClip(this.app.p, this.clipId); return f ? f.clip : null; }
  get track() { const f = this.clipId && findClip(this.app.p, this.clipId); return f ? f.track : null; }
  setTool(t) { this.tool = t; this.drawBtn.classList.toggle('on', t === 'draw'); this.selBtn.classList.toggle('on', t === 'select'); }

  gridH() { return this.s.h - RULER_H - VEL_H - VEL_GAP; }
  x(b) { return KEYS_W + (b - this.scrollX) * this.ppb; }
  beat(x) { return this.scrollX + (x - KEYS_W) / this.ppb; }
  y(p) { return RULER_H + (this.top - p) * this.keyH; }
  pitchAt(y) { return clamp(this.top - Math.floor((y - RULER_H) / this.keyH), 0, 127); }
  unit() {
    const p = this.app.p, bar = barBeats(p);
    if (this.snapMode === 'off') return 0;
    if (this.snapMode === 'bar') return bar;
    if (this.snapMode !== 'auto') return parseFloat(this.snapMode);
    for (const u of [0.125, 0.25, 0.5, 1, 2, bar]) if (u * this.ppb >= 36) return u;
    return bar;
  }
  snap(b, ev, mode = 'round') {
    const u = this.unit();
    if (!u || (ev && ev.altKey)) return b;
    return (mode === 'floor' ? Math.floor(b / u + 1e-6) : Math.round(b / u)) * u;
  }
  newLen() {
    if (this.lenMode === 'last') return this.lastLen;
    if (this.lenMode === 'grid') return this.unit() || 0.25;
    return parseFloat(this.lenMode);
  }

  refresh(d) {
    const app = this.app;
    if (d.reason) this.sel.clear();
    const id = app.ui.editClip;
    if (id !== this.clipId) { this.clipId = id; this.sel.clear(); this.needFit = true; }
    const c = this.clip, t = this.track;
    this.empty.style.display = c ? 'none' : '';
    this.titleEl.replaceChildren(c ? h('span', null, h('span', { class: 'pr-dot', style: { background: t.color } }), h('b', null, c.name), h('span', { class: 'pr-track' }, ` · ${t.name}`)) : h('span', { class: 'muted' }, 'Clip Editor'));
    if (c) this.loopInfo.textContent = `Loop ${fmtBeats(c.loopLen || c.length, app.p)} · Clip ${fmtBeats(c.length, app.p)} · ${c.notes.length} note${c.notes.length === 1 ? '' : 's'}`;
    else this.loopInfo.textContent = '';
    this.dirty = true;
  }

  fitWidth() {
    const c = this.clip;
    if (!c || !this.s.w) return;
    const L = Math.max(1, c.loopLen || c.length);
    this.ppb = clamp((this.s.w - KEYS_W - 24) / L, 8, 800);
  }
  fit() {
    const c = this.clip;
    if (!c) return;
    this.fitWidth(); this.scrollX = 0;
    if (c.notes.length) {
      const lo = Math.min(...c.notes.map((n) => n.p)), hi = Math.max(...c.notes.map((n) => n.p));
      this.keyH = clamp(Math.floor(this.gridH() / (hi - lo + 6)), 7, 22);
      this.top = clamp(hi + 3, 10, 127);
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ drawing
  // Centre the view on the clip once the canvas has a real size (the panel may have been hidden).
  autoView() {
    const c = this.clip;
    if (!c) return;
    this.scrollX = 0;
    this.fitWidth();
    const rows = this.gridH() / this.keyH;
    if (c.notes.length) {
      const lo = Math.min(...c.notes.map((n) => n.p)), hi = Math.max(...c.notes.map((n) => n.p));
      if (hi - lo + 4 > rows) this.keyH = clamp(Math.floor(this.gridH() / (hi - lo + 4)), 7, 13);
      this.top = clamp(Math.round((lo + hi) / 2 + this.gridH() / this.keyH / 2), Math.ceil(this.gridH() / this.keyH), 127);
    } else this.top = clamp(Math.round(66 + rows / 2), Math.ceil(rows), 127);
  }

  frame() {
    if (!this.el.isConnected) return;
    if (this.needFit && this.s.w > 100 && this.gridH() > 40) { this.needFit = false; this.autoView(); this.dirty = true; }
    if (this.dirty) { this.dirty = false; this.draw(); }
    this.drawOverlay();
  }

  draw() {
    const s = this.s, c = s.ctx, app = this.app, p = app.p, clip = this.clip;
    s.clear();
    c.fillStyle = '#0f1113'; c.fillRect(0, 0, s.w, s.h);
    if (!clip) return;
    const accent = css('--accent') || '#ff8f3c';
    const gh = this.gridH(), gy1 = RULER_H + gh;
    const L = clip.loopLen || clip.length;
    const tcol = this.track.color || accent;
    const drums = !!(this.track.instrument && this.track.instrument.type === 'drums'); // label rows with kit pieces
    const label = (p) => (drums ? drumNoteName(p) || noteName(p) : noteName(p));
    // rows
    for (let pch = this.top; pch >= 0; pch--) {
      const y = this.y(pch);
      if (y > gy1) break;
      c.fillStyle = isBlack(pch) ? '#121417' : '#171a1e';
      c.fillRect(KEYS_W, y, s.w - KEYS_W, this.keyH);
      if (pch % 12 === 0) { c.fillStyle = 'rgba(255,255,255,0.09)'; c.fillRect(KEYS_W, y + this.keyH - 1, s.w - KEYS_W, 1); }
    }
    // grid
    const bar = barBeats(p), beatU = 4 / p.sigDen, u = this.unit() || beatU;
    const songOff = clip.start - (clip.offset || 0);
    const b1 = this.beat(s.w);
    for (let b = Math.floor(this.scrollX / u) * u; b <= b1; b += u) {
      const sb = b + songOff;
      const isBar = Math.abs(sb / bar - Math.round(sb / bar)) < 1e-6, isBeat = Math.abs(sb / beatU - Math.round(sb / beatU)) < 1e-6;
      c.fillStyle = isBar ? 'rgba(255,255,255,0.16)' : isBeat ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.035)';
      c.fillRect(Math.round(this.x(b)), RULER_H, 1, gh);
    }
    // outside-loop shade
    const lx = this.x(L);
    if (lx < s.w) { c.fillStyle = 'rgba(0,0,0,0.42)'; c.fillRect(Math.max(KEYS_W, lx), RULER_H, s.w, gh); }
    c.fillStyle = hexA(accent, 0.8); c.fillRect(Math.round(lx), RULER_H, 1.5, gh);
    // ghost repeats
    if (clip.length > L + 1e-6) {
      c.globalAlpha = 0.18;
      for (let k = 1; k * L < clip.length + (clip.offset || 0); k++) for (const n of clip.notes) {
        if (n.s >= L) continue;
        const x = this.x(n.s + k * L);
        if (x > s.w) break;
        c.fillStyle = tcol; c.fillRect(x, this.y(n.p) + 1, Math.max(2, n.l * this.ppb - 1), this.keyH - 2);
      }
      c.globalAlpha = 1;
    }
    // notes
    c.font = '9.5px var(--font-ui, sans-serif)';
    for (const n of clip.notes) {
      const x = this.x(n.s), y = this.y(n.p), w = Math.max(3, n.l * this.ppb - 1);
      if (x > s.w || x + w < KEYS_W || y > gy1 || y + this.keyH < RULER_H) continue;
      const selected = this.sel.has(n), outside = n.s >= L;
      c.globalAlpha = outside ? 0.35 : 1;
      c.fillStyle = selected ? mix(tcol, '#ffffff', 0.45) : mix('#2a2f35', tcol, 0.35 + 0.65 * n.v);
      c.beginPath(); c.roundRect(x, y + 1, w, this.keyH - 2, 2); c.fill();
      c.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.55)'; c.lineWidth = 1; c.stroke();
      if (w > 26 && this.keyH >= 11) { c.fillStyle = 'rgba(10,12,14,0.85)'; c.fillText(label(n.p), x + 3, y + this.keyH - 3); }
      c.globalAlpha = 1;
    }
    // keyboard
    for (let pch = this.top; pch >= 0; pch--) {
      const y = this.y(pch);
      if (y > gy1) break;
      const black = isBlack(pch), held = this.held.has(pch);
      c.fillStyle = held ? accent : black ? '#24282d' : '#d8dce0';
      c.fillRect(0, y, black ? KEYS_W * 0.62 : KEYS_W, this.keyH - (black ? 1 : 0));
      if (!black) { c.fillStyle = '#9da4ab'; c.fillRect(0, y + this.keyH - 1, KEYS_W, 1); }
      const dn = drums && this.keyH >= 9 ? drumNoteName(pch) : '';
      if (dn) { c.fillStyle = 'rgba(16,18,20,0.82)'; c.fillRect(0, y, KEYS_W, this.keyH - 1); c.fillStyle = held ? accent : '#e8a070'; c.fillText(dn.replace(' (alt)', '·'), 3, y + this.keyH - 3); }
      else if (pch % 12 === 0 && this.keyH >= 9) { c.fillStyle = held ? '#101214' : '#4a5158'; c.fillText(noteName(pch), KEYS_W - 26, y + this.keyH - 3); }
    }
    c.fillStyle = '#0f1113'; c.fillRect(0, 0, KEYS_W, RULER_H);
    // ruler
    c.fillStyle = '#131619'; c.fillRect(KEYS_W, 0, s.w - KEYS_W, RULER_H);
    c.font = '10.5px var(--font-mono, monospace)';
    let step = bar;
    while (step * this.ppb < 40) step *= 2;
    const firstSong = Math.floor((this.scrollX + songOff) / step) * step;
    for (let sb = firstSong; sb - songOff <= b1; sb += step) {
      const x = Math.round(this.x(sb - songOff));
      if (x < KEYS_W) continue;
      c.fillStyle = '#5a636b'; c.fillRect(x, 10, 1, RULER_H - 10);
      c.fillStyle = '#a3abb3'; c.fillText(String(Math.round(sb / bar) + 1), x + 4, 18);
    }
    // loop handle
    c.fillStyle = accent;
    c.beginPath(); c.moveTo(lx - 7, 2); c.lineTo(lx + 1, 2); c.lineTo(lx + 1, RULER_H - 2); c.closePath(); c.fill();
    // velocity lane
    const vy0 = gy1 + VEL_GAP, vh = VEL_H;
    c.fillStyle = '#0c0e10'; c.fillRect(0, gy1, s.w, VEL_GAP);
    c.fillStyle = '#121417'; c.fillRect(KEYS_W, vy0, s.w - KEYS_W, vh);
    c.fillStyle = 'rgba(255,255,255,0.05)'; for (const f of [0.25, 0.5, 0.75]) c.fillRect(KEYS_W, vy0 + vh * (1 - f), s.w - KEYS_W, 1);
    c.fillStyle = '#0f1113'; c.fillRect(0, vy0, KEYS_W, vh);
    c.fillStyle = '#6f7880'; c.font = '10px var(--font-ui, sans-serif)'; c.fillText('Velocity', 8, vy0 + 14);
    for (const n of clip.notes) {
      const x = this.x(n.s);
      if (x < KEYS_W - 2 || x > s.w) continue;
      const hh = Math.max(2, n.v * (vh - 6));
      const selected = this.sel.has(n);
      c.fillStyle = selected ? '#ffffff' : hexA(tcol, 0.55 + 0.45 * n.v);
      c.fillRect(x, vy0 + vh - hh, 3, hh);
      c.fillRect(x - 2, vy0 + vh - hh, 7, 2);
    }
  }

  drawOverlay() {
    const o = this.o, c = o.ctx, app = this.app, clip = this.clip;
    o.clear();
    if (!clip) return;
    const e = app.engine, pos = e.playState === 1 ? e.position : app.ui.cursor;
    const rel = pos - clip.start;
    if (rel >= 0 && rel < clip.length) {
      const L = clip.loopLen || clip.length;
      const cb = ((((rel + (clip.offset || 0)) % L) + L) % L);
      const x = this.x(cb);
      if (x >= KEYS_W) { c.fillStyle = e.playState === 1 ? (css('--accent') || '#ff8f3c') : 'rgba(255,255,255,0.5)'; c.fillRect(Math.round(x), RULER_H, 1.5, this.gridH()); }
    }
    if (this.band) {
      const b = this.band;
      c.fillStyle = 'rgba(92,179,255,0.12)'; c.strokeStyle = 'rgba(92,179,255,0.85)';
      c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); c.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
    }
  }

  // ------------------------------------------------------------ hit testing
  local(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  region(x, y) {
    const gy1 = RULER_H + this.gridH();
    if (y < RULER_H) return x < KEYS_W ? 'corner' : 'ruler';
    if (y < gy1) return x < KEYS_W ? 'keys' : 'grid';
    if (y < gy1 + VEL_GAP) return 'gap';
    return x < KEYS_W ? 'velkeys' : 'vel';
  }
  noteAt(x, y) {
    const clip = this.clip;
    if (!clip) return null;
    const pch = this.pitchAt(y);
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      if (n.p !== pch) continue;
      const x0 = this.x(n.s), x1 = x0 + Math.max(3, n.l * this.ppb);
      if (x >= x0 && x <= x1) {
        const edge = Math.min(EDGE, (x1 - x0) / 3);
        return { n, zone: x >= x1 - edge ? 'right' : x <= x0 + edge ? 'left' : 'body' };
      }
    }
    return null;
  }
  onHover(e) {
    if (this.op || !this.clip) return;
    const { x, y } = this.local(e);
    const r = this.region(x, y);
    let cur = '';
    if (r === 'grid') { const ht = this.noteAt(x, y); cur = ht ? (ht.zone === 'body' ? 'grab' : 'ew-resize') : this.tool === 'draw' ? 'crosshair' : 'default'; }
    else if (r === 'ruler') cur = Math.abs(x - this.x(this.clip.loopLen || this.clip.length)) < 8 ? 'ew-resize' : 'text';
    else if (r === 'keys') cur = 'pointer';
    else if (r === 'vel' || r === 'gap') cur = 'ns-resize';
    this.cv.style.cursor = cur;
  }

  audition(pitch, vel = 0.8) {
    const t = this.track;
    if (!t) return;
    this.stopAudition();
    this.app.noteOn(pitch, vel, [t]);
    this.audPitch = pitch;
  }
  stopAudition() { if (this.audPitch != null && this.track) { this.app.noteOff(this.audPitch, [this.track]); this.audPitch = null; } }

  // ------------------------------------------------------------ pointer
  onDown(e) {
    const clip = this.clip;
    if (!clip || e.button !== 0) return;
    this.cv.focus({ preventScroll: true });
    const app = this.app;
    const { x, y } = this.local(e);
    const r = this.region(x, y);
    if (r === 'keys') {
      let pch = this.pitchAt(y);
      this.audition(pch, clamp(0.4 + (x / KEYS_W) * 0.6, 0.2, 1));
      drag(e, { move: (ev) => { const np = this.pitchAt(this.local(ev).y); if (np !== pch) { pch = np; this.audition(pch); } }, up: () => this.stopAudition() });
      return;
    }
    if (r === 'ruler') {
      const L = clip.loopLen || clip.length;
      if (Math.abs(x - this.x(L)) < 8) {
        app.store.begin('Change loop length');
        drag(e, { cursor: 'ew-resize', move: (ev) => {
          const nb = Math.max(0.25, this.snap(this.beat(this.local(ev).x), ev));
          app.store.live((q) => { const c = findClip(q, this.clipId).clip; const wasFull = (c.loopLen || c.length) >= c.length - 1e-6; c.loopLen = nb; if (wasFull) c.length = nb; }, 'notes', { clipId: this.clipId });
        }, up: () => app.store.end('clips') });
        return;
      }
      const loc = (xx) => app.locate(clip.start - (clip.offset || 0) + Math.max(0, this.snap(this.beat(xx))));
      loc(x);
      drag(e, { move: (ev) => loc(this.local(ev).x) });
      return;
    }
    if (r === 'vel' || r === 'gap') return this.velDrag(e, x, y);
    if (r !== 'grid') return;
    const ht = this.noteAt(x, y);
    if (ht) return this.noteDrag(e, ht, x, y);
    if (this.tool === 'draw' && !e.ctrlKey && !e.shiftKey) return this.drawNote(e, x, y);
    this.marquee(e, x, y);
  }

  drawNote(e, x, y) {
    const app = this.app, clipId = this.clipId;
    const s = Math.max(0, this.snap(this.beat(x), e, 'floor'));
    const pch = this.pitchAt(y);
    const len = this.newLen();
    let note = null;
    app.store.begin('Add note');
    app.store.live((q) => { const c = findClip(q, clipId).clip; note = newNote(pch, s, len, app.ui.kbdVel || 0.8); c.notes.push(note); }, 'notes', { clipId });
    this.sel = new Set([note]);
    this.audition(pch, note.v);
    this.op = 'draw';
    drag(e, {
      cursor: 'ew-resize',
      move: (ev) => {
        const l = this.local(ev);
        const end = this.snap(this.beat(l.x), ev);
        const u = this.unit() || 0.0625;
        app.store.live(() => { note.l = Math.max(ev.altKey ? 0.02 : u, end - note.s); }, 'notes', { clipId });
      },
      up: () => { this.op = null; this.stopAudition(); if (note.l !== len) this.lastLen = note.l; app.store.end('notes'); },
    });
  }

  noteDrag(e, ht, x, y) {
    const app = this.app, clipId = this.clipId;
    if (e.shiftKey && this.sel.has(ht.n) && ht.zone === 'body') { this.sel.delete(ht.n); this.dirty = true; return; }
    if (!this.sel.has(ht.n)) { if (!e.shiftKey) this.sel.clear(); this.sel.add(ht.n); }
    this.dirty = true;
    const zone = ht.zone, dup = e.altKey && zone === 'body';
    const x0 = x, p0 = this.pitchAt(y);
    let began = false, orig = null, lastP = ht.n.p;
    const begin = () => {
      began = true;
      app.store.begin(dup ? 'Duplicate notes' : zone === 'body' ? 'Move notes' : 'Resize notes');
      if (dup) {
        const copies = [];
        app.store.live((q) => { const c = findClip(q, clipId).clip; for (const n of this.sel) { const k = { ...n }; c.notes.push(k); copies.push(k); } }, 'notes', { clipId });
        // originals stay; the copies move
        const map = new Map([...this.sel].map((n, i) => [n, copies[i]]));
        ht = { ...ht, n: map.get(ht.n) };
        this.sel = new Set(copies);
      }
      orig = new Map([...this.sel].map((n) => [n, { s: n.s, l: n.l, p: n.p }]));
      this.op = 'note';
      if (zone === 'body') this.audition(ht.n.p, ht.n.v);
    };
    drag(e, {
      cursor: zone === 'body' ? 'grabbing' : 'ew-resize',
      move: (ev) => {
        const l = this.local(ev);
        if (!began) { if (Math.abs(l.x - x0) < 3 && this.pitchAt(l.y) === p0) return; begin(); }
        const db = (l.x - x0) / this.ppb;
        const o = orig.get(ht.n);
        app.store.live(() => {
          if (zone === 'body') {
            const ns = this.snap(o.s + db, ev);
            const d = Math.max(-Math.min(...[...orig.values()].map((v) => v.s)), ns - o.s);
            const dp = clamp(this.pitchAt(l.y) - p0, -Math.min(...[...orig.values()].map((v) => v.p)), 127 - Math.max(...[...orig.values()].map((v) => v.p)));
            for (const [n, v] of orig) { n.s = v.s + d; n.p = v.p + dp; }
          } else if (zone === 'right') {
            const end = this.snap(o.s + o.l + db, ev);
            const d = end - (o.s + o.l);
            for (const [n, v] of orig) n.l = Math.max(0.02, v.l + d);
          } else {
            const ns = this.snap(o.s + db, ev);
            const d = ns - o.s;
            for (const [n, v] of orig) { const s2 = clamp(v.s + d, 0, v.s + v.l - 0.02); n.l = v.l + (v.s - s2); n.s = s2; }
          }
        }, 'notes', { clipId });
        if (zone === 'body' && ht.n.p !== lastP) { lastP = ht.n.p; this.audition(lastP, ht.n.v); }
      },
      up: () => {
        this.stopAudition();
        if (began) { this.op = null; if (zone !== 'body') this.lastLen = ht.n.l; app.store.end('notes'); }
        else if (!e.shiftKey) { this.sel = new Set([ht.n]); this.dirty = true; this.audition(ht.n.p, ht.n.v); setTimeout(() => this.stopAudition(), 180); }
      },
    });
  }

  marquee(e, x, y) {
    const clip = this.clip, add = e.shiftKey, base = new Set(add ? this.sel : []);
    this.op = 'band';
    drag(e, {
      move: (ev) => {
        const l = this.local(ev);
        this.band = { x0: Math.min(x, l.x), y0: Math.min(y, l.y), x1: Math.max(x, l.x), y1: Math.max(y, l.y) };
        const b0 = this.beat(this.band.x0), b1 = this.beat(this.band.x1), pTop = this.pitchAt(this.band.y0), pBot = this.pitchAt(this.band.y1);
        this.sel = new Set(base);
        for (const n of clip.notes) if (n.s < b1 && n.s + n.l > b0 && n.p <= pTop && n.p >= pBot) this.sel.add(n);
        this.dirty = true;
      },
      up: (ev) => {
        this.op = null;
        if (!this.band && !add) { this.sel.clear(); if (this.tool === 'select') this.app.locate(clip.start - (clip.offset || 0) + Math.max(0, this.snap(this.beat(x), ev))); }
        this.band = null; this.dirty = true;
      },
    });
  }

  velDrag(e, x, y) {
    const app = this.app, clip = this.clip, clipId = this.clipId;
    const vy0 = RULER_H + this.gridH() + VEL_GAP;
    const toV = (yy) => clamp(1 - (yy - vy0 - 3) / (VEL_H - 6), 0.01, 1);
    const near = (xx) => {
      let best = null, bd = 8;
      for (const n of clip.notes) { const d = Math.abs(this.x(n.s) - xx); if (d < bd) { bd = d; best = n; } }
      return best;
    };
    const first = near(x);
    app.store.begin('Change velocity');
    const relative = first && this.sel.has(first) && this.sel.size > 1;
    const orig = relative ? new Map([...this.sel].map((n) => [n, n.v])) : null;
    const y0 = y;
    const apply = (xx, yy) => {
      app.store.live(() => {
        if (relative) { const d = (y0 - yy) / (VEL_H - 6); for (const [n, v] of orig) n.v = clamp(v + d, 0.01, 1); }
        else { const n = near(xx); if (n) n.v = toV(yy); }
      }, 'notes', { clipId });
    };
    apply(x, y);
    drag(e, { cursor: 'ns-resize', move: (ev) => { const l = this.local(ev); apply(l.x, l.y); }, up: () => app.store.end('notes') });
  }

  onDbl(e) {
    const clip = this.clip;
    if (!clip) return;
    const { x, y } = this.local(e);
    if (this.region(x, y) !== 'grid') return;
    const ht = this.noteAt(x, y);
    const app = this.app, clipId = this.clipId;
    if (ht) {
      app.store.do('Delete note', (q) => { const c = findClip(q, clipId).clip; const i = clip.notes.indexOf(ht.n); if (i >= 0) c.notes.splice(i, 1); }, 'notes', { clipId });
      this.sel.delete(ht.n);
    } else if (this.tool === 'select') {
      const s = Math.max(0, this.snap(this.beat(x), e, 'floor'));
      app.store.do('Add note', (q) => { findClip(q, clipId).clip.notes.push(newNote(this.pitchAt(y), s, this.newLen(), 0.8)); }, 'notes', { clipId });
    }
  }

  onContext(e) {
    e.preventDefault();
    if (!this.clip) return;
    const { x, y } = this.local(e);
    const ht = this.region(x, y) === 'grid' ? this.noteAt(x, y) : null;
    if (ht && !this.sel.has(ht.n)) { this.sel = new Set([ht.n]); this.dirty = true; }
    const has = this.sel.size > 0;
    contextMenu(e.clientX, e.clientY, [
      { label: 'Quantize', shortcut: 'Q', action: () => this.quantize() },
      { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !has, action: () => this.duplicate() },
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !has, action: () => this.copy() },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !this.app.clipboard || this.app.clipboard.type !== 'notes', action: () => this.paste() },
      { label: 'Transpose +12', disabled: !has, action: () => this.transpose(12) },
      { label: 'Transpose −12', disabled: !has, action: () => this.transpose(-12) },
      { label: 'Fit loop to notes', action: () => this.fitLoop() },
      { sep: true },
      { label: 'Select all', shortcut: 'Ctrl+A', action: () => { this.sel = new Set(this.clip.notes); this.dirty = true; } },
      { label: 'Delete', shortcut: 'Del', danger: true, disabled: !has, action: () => this.deleteSel() },
    ]);
  }

  onWheel(e) {
    e.preventDefault();
    const { x, y } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      const b = this.beat(x);
      this.ppb = clamp(this.ppb * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 8, 1200);
      this.scrollX = Math.max(0, b - (x - KEYS_W) / this.ppb);
    } else if (e.altKey) {
      const p = this.pitchAt(y);
      this.keyH = clamp(this.keyH + (e.deltaY < 0 ? 1 : -1), 6, 28);
      this.top = clamp(Math.round(p + (y - RULER_H) / this.keyH), 10, 127);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scrollX = Math.max(0, this.scrollX + (e.shiftKey ? e.deltaY : e.deltaX) / this.ppb);
    } else {
      const rows = Math.max(1, Math.round(Math.abs(e.deltaY) / 30)) * Math.sign(e.deltaY);
      this.top = clamp(this.top - rows * 2, Math.ceil(this.gridH() / this.keyH), 127);
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ edit commands
  edit(label, fn) { const clipId = this.clipId; this.app.store.do(label, (q) => fn(findClip(q, clipId).clip), 'notes', { clipId }); }
  targets() { return this.sel.size ? [...this.sel] : this.clip.notes.slice(); }
  quantize() {
    const clip = this.clip;
    if (!clip) return;
    const u = this.unit() || 0.25, st = this.qStrength, ends = this.qEnds;
    const tg = new Set(this.targets());
    // operate on the live objects (store.do snapshots first)
    this.edit(`Quantize ${tg.size} notes`, () => {
      for (const n of tg) {
        const e0 = n.s + n.l;
        n.s = Math.max(0, n.s + (Math.round(n.s / u) * u - n.s) * st);
        if (ends) { const e1 = e0 + (Math.round(e0 / u) * u - e0) * st; n.l = Math.max(u * 0.25, e1 - n.s); }
      }
    });
    toast(`Quantized ${tg.size} note${tg.size === 1 ? '' : 's'} to ${SNAPS.find(([v]) => parseFloat(v) === u)?.[1] || u + ' beats'}${st < 1 ? ` (${Math.round(st * 100)}%)` : ''}`);
  }
  deleteSel() {
    if (!this.sel.size) return;
    const del = this.sel;
    this.edit(`Delete ${del.size} notes`, (c) => { c.notes = c.notes.filter((n) => !del.has(n)); });
    this.sel = new Set();
  }
  duplicate() {
    if (!this.sel.size) return;
    const notes = [...this.sel];
    const lo = Math.min(...notes.map((n) => n.s)), hi = Math.max(...notes.map((n) => n.s + n.l));
    const u = this.unit() || 0.25, span = Math.max(u, Math.ceil((hi - lo) / u - 1e-6) * u);
    const copies = notes.map((n) => ({ ...n, s: n.s + span }));
    this.edit('Duplicate notes', (c) => { c.notes.push(...copies); });
    this.sel = new Set(copies);
  }
  copy() {
    if (!this.sel.size) return;
    const notes = [...this.sel], lo = Math.min(...notes.map((n) => n.s));
    this.app.clipboard = { type: 'notes', notes: notes.map((n) => ({ ...n, s: n.s - lo })) };
    toast(`Copied ${notes.length} note${notes.length === 1 ? '' : 's'}`);
  }
  paste() {
    const cb = this.app.clipboard, clip = this.clip;
    if (!cb || cb.type !== 'notes' || !clip) return;
    const pos = this.app.ui.cursor - clip.start + (clip.offset || 0);
    const L = clip.loopLen || clip.length;
    const at = pos >= 0 && pos < clip.length ? ((pos % L) + L) % L : 0;
    const copies = cb.notes.map((n) => ({ ...n, s: n.s + this.snap(at) }));
    this.edit('Paste notes', (c) => { c.notes.push(...copies); });
    this.sel = new Set(copies);
  }
  transpose(d) {
    if (!this.sel.size) return;
    const sel = this.sel;
    this.edit('Transpose', () => { for (const n of sel) n.p = clamp(n.p + d, 0, 127); });
  }
  nudge(d) {
    const sel = this.sel;
    this.edit('Move notes', () => { for (const n of sel) n.s = Math.max(0, n.s + d); });
  }
  fitLoop() {
    const clip = this.clip;
    if (!clip || !clip.notes.length) return;
    const bar = barBeats(this.app.p);
    const end = Math.max(bar, Math.ceil(Math.max(...clip.notes.map((n) => n.s + n.l)) / bar - 1e-6) * bar);
    this.edit('Fit loop', (c) => { const full = (c.loopLen || c.length) >= c.length - 1e-6; c.loopLen = end; if (full) c.length = end; });
  }

  onKey(e) {
    if (!this.clip) return false;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSel(); return true; }
    if (mod && k === 'a') { this.sel = new Set(this.clip.notes); this.dirty = true; return true; }
    if (mod && k === 'd') { this.duplicate(); return true; }
    if (mod && k === 'c') { this.copy(); return true; }
    if (mod && k === 'v') { this.paste(); return true; }
    if (mod) return false;
    if (k === 'q' && !this.app.ui.kbd) { this.quantize(); return true; }
    if (k === 'b' && !this.app.ui.kbd) { this.setTool('draw'); return true; }
    if (k === 'v' && !this.app.ui.kbd) { this.setTool('select'); return true; }
    if (e.key === 'Escape') { this.sel.clear(); this.dirty = true; return true; }
    if (this.sel.size && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { this.transpose((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)); return true; }
    if (this.sel.size && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { this.nudge((e.key === 'ArrowRight' ? 1 : -1) * (this.unit() || 0.25)); return true; }
    if (e.key === '+' || e.key === '=') { this.ppb = clamp(this.ppb * 1.3, 8, 1200); this.dirty = true; return true; }
    if (e.key === '-') { this.ppb = clamp(this.ppb / 1.3, 8, 1200); this.dirty = true; return true; }
    return false;
  }
}

function fmtBeats(b, p) {
  const bar = barBeats(p);
  const bars = b / bar;
  return Math.abs(bars - Math.round(bars)) < 1e-6 ? `${Math.round(bars)} bar${Math.round(bars) === 1 ? '' : 's'}` : `${b.toFixed(2)} beats`;
}
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
