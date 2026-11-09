// Reusable controls: knobs, faders, sliders, number fields, meters,
// context menus, dialogs and toasts.

import { h, s, drag, clamp } from './dom.js';
import { toNorm, fromNorm, formatValue, isDiscrete, faderDbToNorm, faderNormToDb } from '../shared/params.js';

// ---------------------------------------------------------------- Knob
function polar(cx, cy, r, deg) { const a = (deg * Math.PI) / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; }
function arc(cx, cy, r, a0, a1) {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0, sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class Knob {
  constructor(o) {
    this.o = o; this.def = o.def;
    this.value = o.value ?? o.def.def;
    const size = o.size || 34;
    this.svg = s('svg', { width: size, height: size, viewBox: '0 0 40 40', class: 'knob-svg' });
    this.track = s('path', { class: 'knob-track', d: arc(20, 20, 16, -135, 135) });
    this.fillEl = s('path', { class: 'knob-fill' });
    this.cap = s('circle', { class: 'knob-cap', cx: 20, cy: 20, r: 11 });
    this.ptr = s('line', { class: 'knob-ptr', x1: 20, y1: 20, x2: 20, y2: 11 });
    this.svg.append(this.track, this.fillEl, this.cap, this.ptr);
    this.labelText = o.label ?? this.def.short;
    this.label = h('div', { class: 'knob-label' }, this.labelText);
    this.el = h('div', { class: 'knob' + (o.class ? ' ' + o.class : ''), tabIndex: 0, title: this.def.name }, this.svg, this.label);
    if (o.size >= 44) this.el.classList.add('knob-lg');
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('dblclick', (e) => { e.stopPropagation(); this.commit(this.def.def); });
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerenter', () => this.showValue(true));
    this.el.addEventListener('pointerleave', () => { if (!this.dragging) this.showValue(false); });
    this.el.addEventListener('contextmenu', (e) => { if (o.onContext) { e.preventDefault(); o.onContext(e); } });
    this.set(this.value);
  }
  showValue(on) {
    this.hover = on;
    this.label.textContent = on ? formatValue(this.def, this.value) : this.labelText;
    this.el.classList.toggle('show-value', on);
  }
  set(v) {
    this.value = v;
    const n = toNorm(this.def, v);
    const a = -135 + 270 * n;
    const bip = this.o.bipolar ?? this.def.bipolar;
    const start = bip ? 0 : -135;
    this.fillEl.setAttribute('d', a >= start ? arc(20, 20, 16, start, a) : arc(20, 20, 16, a, start));
    const [x, y] = polar(20, 20, 9.5, a);
    this.ptr.setAttribute('x2', x.toFixed(2)); this.ptr.setAttribute('y2', y.toFixed(2));
    if (this.hover || this.dragging) this.label.textContent = formatValue(this.def, v);
  }
  setAutomated(on) { this.el.classList.toggle('automated', !!on); }
  setDisabled(on) { this.el.classList.toggle('disabled', !!on); }
  commit(v) {
    this.o.onBegin && this.o.onBegin();
    this.set(v);
    this.o.onInput && this.o.onInput(v);
    this.o.onEnd && this.o.onEnd();
  }
  onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    let n = toNorm(this.def, this.value), lastY = e.clientY;
    const disc = isDiscrete(this.def);
    this.dragging = true; this.el.classList.add('active'); this.showValue(true);
    this.o.onBegin && this.o.onBegin();
    drag(e, {
      cursor: 'ns-resize',
      move: (ev) => {
        const dy = lastY - ev.clientY; lastY = ev.clientY;
        const range = disc ? Math.max(1, this.def.max - this.def.min) : 1;
        const sens = ev.shiftKey ? 0.0012 : disc ? Math.min(0.02, 1.6 / (range * 12)) : 0.0055;
        n = clamp(n + dy * sens, 0, 1);
        const v = fromNorm(this.def, n);
        if (v !== this.value) { this.set(v); this.o.onInput && this.o.onInput(v); }
      },
      up: () => { this.dragging = false; this.el.classList.remove('active'); this.showValue(this.el.matches(':hover')); this.o.onEnd && this.o.onEnd(); },
    });
  }
  step(dir, fine) {
    const disc = isDiscrete(this.def);
    let v;
    if (disc) v = clamp(Math.round(this.value) + dir, this.def.min, this.def.max);
    else v = fromNorm(this.def, clamp(toNorm(this.def, this.value) + dir * (fine ? 0.002 : 0.01), 0, 1));
    if (v === this.value) return;
    if (!this.wheelT) this.o.onBegin && this.o.onBegin();
    clearTimeout(this.wheelT);
    this.set(v); this.o.onInput && this.o.onInput(v);
    this.wheelT = setTimeout(() => { this.wheelT = null; this.o.onEnd && this.o.onEnd(); }, 450);
  }
  onWheel(e) { e.preventDefault(); this.step(e.deltaY < 0 ? 1 : -1, e.shiftKey); }
  onKey(e) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.step(1, e.shiftKey); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.step(-1, e.shiftKey); }
  }
}

// ---------------------------------------------------------------- Fader (dB)
export class Fader {
  constructor(o) {
    this.o = o; this.db = o.value ?? 0;
    this.fill = h('div', { class: 'fader-fill' });
    this.capEl = h('div', { class: 'fader-cap' });
    this.trackEl = h('div', { class: 'fader-track' }, this.fill);
    const marks = [6, 0, -6, -12, -24, -48].map((d) => h('div', { class: 'fader-mark' + (d === 0 ? ' zero' : ''), style: { bottom: `${faderDbToNorm(d) * 100}%` } }));
    this.el = h('div', { class: 'fader', title: o.title || 'Volume — drag, Shift for fine, double-click for 0 dB' }, this.trackEl, ...marks, this.capEl);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('dblclick', () => this.commit(0));
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n = clamp(faderDbToNorm(this.db) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.003 : 0.015), 0, 1);
      if (!this.wt) o.onBegin && o.onBegin();
      clearTimeout(this.wt);
      this.set(faderNormToDb(n)); o.onInput && o.onInput(this.db);
      this.wt = setTimeout(() => { this.wt = null; o.onEnd && o.onEnd(); }, 450);
    }, { passive: false });
    this.el.addEventListener('contextmenu', (e) => { if (o.onContext) { e.preventDefault(); o.onContext(e); } });
    this.set(this.db);
  }
  set(db) {
    this.db = db;
    const n = faderDbToNorm(db);
    this.capEl.style.bottom = `calc(${n * 100}% - 7px)`;
    this.fill.style.height = `${n * 100}%`;
  }
  setAutomated(on) { this.el.classList.toggle('automated', !!on); }
  commit(db) { this.o.onBegin && this.o.onBegin(); this.set(db); this.o.onInput && this.o.onInput(db); this.o.onEnd && this.o.onEnd(); }
  onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const hgt = this.trackEl.getBoundingClientRect().height || 120;
    let n = faderDbToNorm(this.db), lastY = e.clientY;
    this.o.onBegin && this.o.onBegin();
    this.el.classList.add('active');
    drag(e, {
      cursor: 'ns-resize',
      move: (ev) => {
        const dy = lastY - ev.clientY; lastY = ev.clientY;
        n = clamp(n + (dy / hgt) * (ev.shiftKey ? 0.15 : 1), 0, 1);
        const db = faderNormToDb(n);
        this.set(db); this.o.onInput && this.o.onInput(db);
      },
      up: () => { this.el.classList.remove('active'); this.o.onEnd && this.o.onEnd(); },
    });
  }
}

// ---------------------------------------------------------------- Horizontal slider
export class HSlider {
  constructor(o) {
    this.o = o; this.def = o.def; this.value = o.value ?? o.def.def;
    this.fill = h('div', { class: 'hs-fill' });
    this.text = h('div', { class: 'hs-text' });
    this.el = h('div', { class: 'hslider' + (o.class ? ' ' + o.class : ''), title: o.title || this.def.name }, this.fill, this.text);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('dblclick', () => { o.onBegin && o.onBegin(); this.set(this.def.def); o.onInput && o.onInput(this.def.def); o.onEnd && o.onEnd(); });
    this.el.addEventListener('contextmenu', (e) => { if (o.onContext) { e.preventDefault(); o.onContext(e); } });
    this.set(this.value);
  }
  set(v) {
    this.value = v;
    const n = this.def.curve === 'fader' ? faderDbToNorm(v) : toNorm(this.def, v);
    if (this.o.bipolar ?? this.def.bipolar) {
      const c = 0.5;
      this.fill.style.left = `${Math.min(c, n) * 100}%`; this.fill.style.width = `${Math.abs(n - c) * 100}%`;
    } else { this.fill.style.left = '0'; this.fill.style.width = `${n * 100}%`; }
    if (this.o.showText !== false) this.text.textContent = (this.o.prefix || '') + formatValue(this.def, v);
  }
  setAutomated(on) { this.el.classList.toggle('automated', !!on); }
  onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const w = this.el.getBoundingClientRect().width || 100;
    const fader = this.def.curve === 'fader';
    let n = fader ? faderDbToNorm(this.value) : toNorm(this.def, this.value), lastX = e.clientX;
    this.o.onBegin && this.o.onBegin();
    drag(e, {
      cursor: 'ew-resize',
      move: (ev) => {
        const dx = ev.clientX - lastX; lastX = ev.clientX;
        n = clamp(n + (dx / w) * (ev.shiftKey ? 0.15 : 1), 0, 1);
        const v = fader ? faderNormToDb(n) : fromNorm(this.def, n);
        if (v !== this.value) { this.set(v); this.o.onInput && this.o.onInput(v); }
      },
      up: () => { this.o.onEnd && this.o.onEnd(); },
    });
  }
}

// ---------------------------------------------------------------- Number field (drag or type)
export class NumberField {
  constructor(o) {
    this.o = o; this.value = o.value;
    this.el = h('div', { class: 'numfield' + (o.class ? ' ' + o.class : ''), tabIndex: 0, title: o.title || 'Drag up/down or double-click to type' });
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('dblclick', () => this.edit());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.edit(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); this.commit(this.value + (e.key === 'ArrowUp' ? 1 : -1) * (o.step || 1)); }
    });
    this.render();
  }
  fmt(v) { return this.o.format ? this.o.format(v) : v.toFixed(this.o.decimals ?? 0); }
  render() { if (!this.editing) this.el.textContent = this.fmt(this.value); }
  set(v) { this.value = v; this.render(); }
  clampV(v) { const st = this.o.step || 1; v = Math.round(v / st) * st; return clamp(v, this.o.min, this.o.max); }
  commit(v) { v = this.clampV(v); this.o.onBegin && this.o.onBegin(); this.set(v); this.o.onInput && this.o.onInput(v); this.o.onEnd && this.o.onEnd(); }
  onDown(e) {
    if (e.button !== 0 || this.editing) return;
    e.preventDefault();
    let acc = this.value, lastY = e.clientY, began = false;
    drag(e, {
      cursor: 'ns-resize',
      move: (ev) => {
        const dy = lastY - ev.clientY; lastY = ev.clientY;
        if (!began) { began = true; this.o.onBegin && this.o.onBegin(); }
        acc += dy * (this.o.dragStep || this.o.step || 1) * (ev.shiftKey ? 0.1 : 1);
        const v = this.clampV(acc);
        if (v !== this.value) { this.set(v); this.o.onInput && this.o.onInput(v); }
      },
      up: () => { if (began) this.o.onEnd && this.o.onEnd(); },
    });
  }
  edit() {
    if (this.editing) return;
    this.editing = true;
    const inp = h('input', { class: 'numfield-input', value: String(this.value), spellcheck: false });
    this.el.textContent = ''; this.el.append(inp);
    inp.focus(); inp.select();
    const done = (ok) => {
      if (!this.editing) return;
      this.editing = false;
      const v = parseFloat(inp.value);
      inp.remove();
      if (ok && Number.isFinite(v)) this.commit(v); else this.render();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }
}

// ---------------------------------------------------------------- simple controls
export function toggleBtn(label, on, onClick, cls = '', title = '') {
  const b = h('button', { class: 'tbtn ' + cls + (on ? ' on' : ''), title, onClick: (e) => onClick(e) }, label);
  b.setOn = (v) => b.classList.toggle('on', !!v);
  return b;
}
export function selectEl(options, value, onChange, cls = '', title = '') {
  const sel = h('select', { class: 'sel ' + cls, title });
  for (const o of options) {
    if (o && o.group) {
      const g = h('optgroup', { label: o.group });
      for (const x of o.options) g.append(h('option', { value: String(x.value) }, x.label));
      sel.append(g);
    } else {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      sel.append(h('option', { value: String(opt.value) }, opt.label));
    }
  }
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  return sel;
}

// ---------------------------------------------------------------- Meter
const METER_MIN = -60, METER_MAX = 6;
const dbPos = (db) => clamp((db - METER_MIN) / (METER_MAX - METER_MIN), 0, 1);
const lin2db = (x) => (x <= 1e-7 ? -140 : 20 * Math.log10(x));

export class Meter {
  constructor({ width = 10, height = 120, horizontal = false } = {}) {
    this.horizontal = horizontal;
    this.canvas = h('canvas', { class: 'meter-canvas' });
    this.clipEl = h('div', { class: 'meter-clip', title: 'Clip indicator — click to reset' });
    this.el = h('div', { class: 'meter' + (horizontal ? ' horizontal' : '') }, this.canvas, this.clipEl);
    this.w = width; this.h = height;
    this.holdL = -140; this.holdR = -140; this.holdT = 0;
    this.last = '';
    this.sized = false;
  }
  size() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.round(r.width)), hh = Math.max(2, Math.round(r.height));
    if (w !== this.cw || hh !== this.ch) {
      this.cw = w; this.ch = hh;
      this.canvas.width = w * dpr; this.canvas.height = hh * dpr;
      this.ctx = this.canvas.getContext('2d');
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = this.horizontal ? this.ctx.createLinearGradient(0, 0, w, 0) : this.ctx.createLinearGradient(0, hh, 0, 0);
      g.addColorStop(0, '#2f9e66'); g.addColorStop(dbPos(-18), '#46c07c'); g.addColorStop(dbPos(-6), '#c9c54a');
      g.addColorStop(dbPos(-1), '#e8913a'); g.addColorStop(dbPos(0), '#ef4d4d'); g.addColorStop(1, '#ef4d4d');
      this.grad = g;
      this.last = '';
    }
  }
  draw(pL, pR, rL, rR, clip) {
    if (!this.cw) this.size();
    const now = performance.now();
    const dL = lin2db(pL), dR = lin2db(pR);
    if (dL >= this.holdL) { this.holdL = dL; this.tL = now; } else if (now - (this.tL || 0) > 1500) this.holdL = Math.max(dL, this.holdL - 0.9);
    if (dR >= this.holdR) { this.holdR = dR; this.tR = now; } else if (now - (this.tR || 0) > 1500) this.holdR = Math.max(dR, this.holdR - 0.9);
    const key = `${dL.toFixed(1)}|${dR.toFixed(1)}|${this.holdL.toFixed(1)}|${this.holdR.toFixed(1)}|${clip}`;
    this.clipEl.classList.toggle('on', !!clip);
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx, w = this.cw, hh = this.ch;
    c.clearRect(0, 0, w, hh);
    c.fillStyle = '#0c0e10'; c.fillRect(0, 0, w, hh);
    const bars = [[dL, lin2db(rL), this.holdL], [dR, lin2db(rR), this.holdR]];
    if (this.horizontal) {
      const bh = (hh - 1) / 2;
      bars.forEach(([pk, rm, hd], i) => {
        const y = i * (bh + 1);
        c.globalAlpha = 0.45; c.fillStyle = this.grad; c.fillRect(0, y, dbPos(pk) * w, bh);
        c.globalAlpha = 1; c.fillRect(0, y, dbPos(rm) * w, bh);
        if (hd > METER_MIN) { c.fillStyle = '#e8edf2'; c.fillRect(dbPos(hd) * w - 1, y, 1.5, bh); }
      });
    } else {
      const bw = (w - 1) / 2;
      bars.forEach(([pk, rm, hd], i) => {
        const x = i * (bw + 1);
        const yp = hh - dbPos(pk) * hh, yr = hh - dbPos(rm) * hh;
        c.globalAlpha = 0.45; c.fillStyle = this.grad; c.fillRect(x, yp, bw, hh - yp);
        c.globalAlpha = 1; c.fillRect(x, yr, bw, hh - yr);
        if (hd > METER_MIN) { c.fillStyle = '#e8edf2'; c.fillRect(x, hh - dbPos(hd) * hh, bw, 1.5); }
      });
      c.fillStyle = 'rgba(0,0,0,0.35)';
      for (const d of [0, -6, -12, -24, -48]) c.fillRect(0, Math.round(hh - dbPos(d) * hh), w, 1);
    }
    c.globalAlpha = 1;
  }
}
export { lin2db };

// ---------------------------------------------------------------- Context menu
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(h('div', { class: 'ctx-sep' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const row = h('div', { class: 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), role: 'menuitem' },
      h('span', { class: 'ctx-check' }, it.checked ? '✓' : ''), h('span', { class: 'ctx-label' }, it.label), it.shortcut ? h('span', { class: 'ctx-key' }, it.shortcut) : null);
    if (!it.disabled) row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.action && it.action(); });
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
  setTimeout(() => {
    const off = (e) => { if (openMenu && !openMenu.contains(e.target)) { closeMenu(); cleanup(); } };
    const key = (e) => { if (e.key === 'Escape') { closeMenu(); cleanup(); } };
    const cleanup = () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); };
    const blur = () => { closeMenu(); cleanup(); };
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
  }, 0);
  return menu;
}

// ---------------------------------------------------------------- Dialogs
export function dialog({ title, body, actions = [], width = 420, onClose, className = '' }) {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal ' + className, role: 'dialog', 'aria-label': title, style: { width: `${width}px` } });
  const close = (result) => { back.remove(); window.removeEventListener('keydown', onKey, true); onClose && onClose(result); };
  const btns = actions.map((a) => h('button', {
    class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
    onClick: async () => { const r = a.action ? await a.action() : undefined; if (r !== false) close(a.value ?? a.label); },
  }, a.label));
  box.append(h('div', { class: 'modal-title' }, title), h('div', { class: 'modal-body' }, body), btns.length ? h('div', { class: 'modal-actions' }, btns) : null);
  back.append(box);
  document.body.append(back);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
      const i = actions.findIndex((a) => a.primary);
      if (i >= 0) { e.preventDefault(); e.stopPropagation(); btns[i].click(); }
    } else e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  setTimeout(() => { const f = box.querySelector('input, select, button.primary'); f && f.focus(); }, 0);
  return { el: box, close };
}
export function promptText(title, value = '', label = 'Name') {
  return new Promise((resolve) => {
    const inp = h('input', { class: 'text-input', value, spellcheck: false });
    dialog({ title, body: h('label', { class: 'field' }, h('span', null, label), inp), width: 360,
      actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, action: () => { resolve(inp.value.trim()); } }],
      onClose: (r) => { if (r === null || r === 'Cancel') resolve(null); } });
    setTimeout(() => { inp.focus(); inp.select(); }, 10);
  });
}
export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    dialog({ title, body: h('p', null, message), width: 400,
      actions: [{ label: 'Cancel', value: false }, { label: okLabel, primary: true, danger, value: true }],
      onClose: (r) => resolve(r === true) });
  });
}

// ---------------------------------------------------------------- Toasts
let toastBox = null;
export function toast(msg, kind = 'info', ms = 3200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
