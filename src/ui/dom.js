// Tiny DOM helpers.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'textContent', 'innerHTML', 'tabIndex', 'htmlFor', 'draggable', 'spellcheck', 'contentEditable']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Pointer drag using window listeners (robust when elements re-render mid-drag).
export function drag(e, { move, up, cursor } = {}) {
  const id = e.pointerId;
  if (cursor) document.body.style.cursor = cursor;
  document.body.classList.add('is-dragging');
  const onMove = (ev) => { if (ev.pointerId === id && move) move(ev); };
  const onUp = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.style.cursor = '';
    document.body.classList.remove('is-dragging');
    if (up) up(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// High-DPI canvas that tracks its CSS size.
export class Surface {
  constructor(canvas, onResize) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0; this.dpr = 1;
    this.onResize = onResize;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    if (w === this.w && hh === this.h && dpr === this.dpr) return;
    this.w = w; this.h = hh; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(hh * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.onResize) this.onResize();
  }
  clear() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); this.ctx.clearRect(0, 0, this.w, this.h); }
}

export function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (p) => NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);
export const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);

export function fmtBars(beat, project, withTicks = true) {
  const barLen = (project.sigNum * 4) / project.sigDen, unit = 4 / project.sigDen;
  const b = Math.max(0, beat + 1e-9);
  const bar = Math.floor(b / barLen) + 1;
  const inBar = b - (bar - 1) * barLen;
  const bt = Math.floor(inBar / unit) + 1;
  const sixteenth = Math.floor((inBar - (bt - 1) * unit) / 0.25) + 1;
  return withTicks ? `${bar}.${bt}.${sixteenth}` : `${bar}.${bt}`;
}
export function fmtTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(3).padStart(6, '0')}`;
}

export function isTextInput(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
