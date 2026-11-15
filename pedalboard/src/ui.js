// Small DOM helpers and the knob / footswitch widgets.

import { toNorm, fromNorm } from './shared/defs.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function fmt(q, v) {
  if (q.enum) return q.options[v] ?? '';
  const u = q.unit;
  if (u === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`;
  if (u === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  if (u === 's') return `${v.toFixed(1)} s`;
  if (u === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (u === ':1') return `${v.toFixed(1)}:1`;
  if (u === '%') return `${Math.round(v)}%`;
  return v.toFixed(1);
}

// Rotary knob: drag up/down (Shift = fine), mouse wheel, double-click resets,
// arrow keys when focused. onInput fires while moving, onCommit at the end.
export function knob(q, value, { onInput, onCommit, size = 'm', disabledText } = {}) {
  const arc = h('div', { class: 'knob-cap' }, h('div', { class: 'knob-pointer' }));
  const val = h('div', { class: 'knob-val' });
  const el = h('div', { class: `knob knob-${size}`, tabindex: 0, role: 'slider', 'aria-label': q.name, title: `${q.name} — drag, scroll, or double-click to reset` },
    h('div', { class: 'knob-ring' }, arc), h('div', { class: 'knob-name' }, q.name), val);
  let v = value;
  const show = () => {
    const n = toNorm(q, v);
    arc.style.transform = `rotate(${-135 + n * 270}deg)`;
    el.style.setProperty('--fill', String(n));
    val.textContent = disabledText || fmt(q, v);
    el.setAttribute('aria-valuetext', fmt(q, v));
  };
  const setN = (n, commit) => {
    const nv = fromNorm(q, n);
    if (nv !== v) { v = nv; show(); onInput && onInput(v); }
    if (commit) onCommit && onCommit(v);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); el.focus();
    el.setPointerCapture(e.pointerId);
    let y = e.clientY, n = toNorm(q, v);
    const move = (ev) => { n = Math.max(0, Math.min(1, n + (y - ev.clientY) / (ev.shiftKey ? 900 : 180))); y = ev.clientY; setN(n, false); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); onCommit && onCommit(v); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); const step = q.enum ? 1 / Math.max(1, q.options.length - 1) : (e.shiftKey ? 0.005 : 0.02); setN(toNorm(q, v) + (e.deltaY < 0 ? step : -step), true); }, { passive: false });
  el.addEventListener('dblclick', () => { v = q.def; show(); onInput && onInput(v); onCommit && onCommit(v); });
  el.addEventListener('keydown', (e) => {
    const step = q.enum ? 1 / Math.max(1, q.options.length - 1) : (e.shiftKey ? 0.005 : 0.03);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); setN(toNorm(q, v) + step, true); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setN(toNorm(q, v) - step, true); }
  });
  show();
  el.setValue = (nv) => { v = nv; show(); };
  return el;
}

export function toast(msg, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), kind === 'warn' ? 6500 : 3500);
  setTimeout(() => t.remove(), kind === 'warn' ? 7000 : 4000);
}
