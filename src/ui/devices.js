// Effects tab: the insert chain of the selected channel as device cards.

import { h, Surface, css } from './dom.js';
import { icon } from './icons.js';
import { Knob, selectEl, contextMenu } from './widgets.js';
import { currentDrag } from './browser.js';
import { EFFECT_DEFS, EFFECT_TYPES, formatValue } from '../shared/params.js';
import { biquadCoefs, biquadMag, BQ } from '../shared/dspmath.js';

export class Devices {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.cards = new Map();
    this.title = h('div', { class: 'dev-title' });
    this.rack = h('div', { class: 'dev-rack' });
    this.addBtn = h('button', { class: 'dev-add', title: 'Add an insert effect', onClick: (e) => this.addMenu(e) }, icon('plus', 16), h('span', null, 'Add effect'));
    this.el = h('div', { class: 'devices' }, h('div', { class: 'dev-head' }, this.title, h('div', { class: 'tb-spacer' }), h('span', { class: 'dev-tip' }, 'Signal flows left → right · drag effects here from the browser')), this.rack);
    this.el.addEventListener('dragover', (e) => { if (currentDrag && currentDrag.kind === 'effect') { e.preventDefault(); this.rack.classList.add('drop'); } });
    this.el.addEventListener('dragleave', () => this.rack.classList.remove('drop'));
    this.el.addEventListener('drop', (e) => { this.rack.classList.remove('drop'); if (currentDrag && currentDrag.kind === 'effect') { e.preventDefault(); app.addInsert(app.selectedChannel.id, currentDrag.name); } });
  }
  addMenu(e) {
    const ch = this.app.selectedChannel;
    contextMenu(e.clientX, e.clientY, EFFECT_TYPES.map((t) => ({ label: EFFECT_DEFS[t].name, action: () => this.app.addInsert(ch.id, t) })));
  }

  refresh(d) {
    const app = this.app, ch = app.selectedChannel;
    if (d && d.scope === 'fx-param' && d.transient) { const c = this.cards.get(d.fxId); if (c) c.updateValues(); return; }
    if (d && (d.scope === 'inst-param' || d.scope === 'mix-param' || d.scope === 'wt')) return;
    this.title.replaceChildren(h('span', { class: 'pill-dot', style: { background: ch.color || '#888' } }), h('b', null, ch.name), h('span', { class: 'muted' }, ` · ${ch.inserts.length} insert${ch.inserts.length === 1 ? '' : 's'}`));
    const seen = new Set(), nodes = [];
    ch.inserts.forEach((fx, i) => {
      const key = fx.id;
      seen.add(key);
      let c = this.cards.get(key);
      if (!c || c.chId !== ch.id) { c = this.makeCard(ch.id, fx.id); this.cards.set(key, c); }
      c.update(i, ch.inserts.length);
      nodes.push(c.el);
      if (i < ch.inserts.length - 1) nodes.push(h('div', { class: 'dev-arrow' }, icon('right', 14)));
    });
    for (const k of [...this.cards.keys()]) if (!seen.has(k)) this.cards.delete(k);
    nodes.push(this.addBtn);
    this.rack.replaceChildren(...nodes);
  }

  makeCard(chId, fxId) {
    const app = this.app;
    const getFx = () => { const ch = app.selectedChannel; return ch.inserts.find((f) => f.id === fxId); };
    const fx0 = getFx(), type = fx0.type, defs = EFFECT_DEFS[type].params;
    const ctl = new Map();
    const body = h('div', { class: 'dev-body' });
    let graph = null;
    if (type === 'eq') {
      const cv = h('canvas', { class: 'eq-graph' });
      body.append(cv);
      graph = { cv, s: null };
      queueMicrotask(() => { graph.s = new Surface(cv, () => drawEq()); drawEq(); });
    }
    const knobs = h('div', { class: 'dev-knobs' + (defs.length > 6 ? ' many' : '') });
    for (const d of defs) {
      if (d.curve === 'enum') {
        const el = selectEl(d.options.map((o, i) => ({ value: i, label: o })), d.def, (v) => app.store.do(`Set ${d.name}`, (p) => { getFxIn(p).params[d.id] = +v; }, 'fx', { id: chId }), 'sel-sm', d.name);
        ctl.set(d.id, { set: (v) => { el.value = String(Math.round(v)); }, auto: () => {} });
        knobs.append(h('div', { class: 'stack' }, h('span', { class: 'mini-label' }, d.name), el));
      } else if (d.curve === 'bool') {
        const b = h('button', { class: 'pill', onClick: () => { const f = getFx(); app.store.do(`Toggle ${d.name}`, (p) => { getFxIn(p).params[d.id] = f.params[d.id] >= 0.5 ? 0 : 1; }, 'fx', { id: chId }); } }, d.name);
        ctl.set(d.id, { set: (v) => b.classList.toggle('on', v >= 0.5), auto: () => {} });
        knobs.append(h('div', { class: 'pill-col' }, b));
      } else {
        const k = new Knob({ def: d, size: 36, onBegin: () => app.fxBegin(`Change ${d.name}`), onInput: (v) => { app.fxLive(chId, fxId, d.id, v); }, onEnd: () => app.fxEnd(),
          onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(chId, `fx:${fxId}:${d.id}`, () => app.store.do('Reset', (p) => { getFxIn(p).params[d.id] = d.def; }, 'fx', { id: chId }))) });
        ctl.set(d.id, { set: (v) => k.set(v), auto: (a) => k.setAutomated(a) });
        knobs.append(k.el);
      }
    }
    body.append(knobs);
    function getFxIn(p) {
      const ch = chId === 'master' ? p.master : p.tracks.find((t) => t.id === chId) || p.buses.find((b) => b.id === chId);
      return ch.inserts.find((f) => f.id === fxId);
    }
    const pow = h('button', { class: 'power', title: 'Bypass', onClick: () => app.toggleBypass(chId, fxId) }, icon('power', 12));
    const left = h('button', { class: 'ibtn xs', title: 'Move left', onClick: () => app.moveInsert(chId, fxId, -1) }, icon('left', 12));
    const right = h('button', { class: 'ibtn xs', title: 'Move right', onClick: () => app.moveInsert(chId, fxId, 1) }, icon('right', 12));
    const del = h('button', { class: 'ibtn xs', title: 'Remove effect', onClick: () => app.removeInsert(chId, fxId) }, icon('close', 12));
    const el = h('div', { class: 'dev-card dev-' + type }, h('div', { class: 'dev-card-head' }, pow, h('span', { class: 'dev-name' }, EFFECT_DEFS[type].name), h('div', { class: 'tb-spacer' }), left, right, del), body);
    el.addEventListener('pointerdown', () => { app.ui.selInsert = fxId; });
    const drawEq = () => {
      if (!graph || !graph.s) return;
      const f = getFx(); if (!f) return;
      const s = graph.s, c = s.ctx, w = s.w, hh = s.h, P = f.params, accent = css('--accent') || '#ff8f3c';
      s.clear(); c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
      const sr = 48000, bands = [
        biquadCoefs(BQ.LOWSHELF, P.lf, 0.707, P.lg, sr, new Float64Array(5)), biquadCoefs(BQ.PEAK, P.m1f, P.m1q, P.m1g, sr, new Float64Array(5)),
        biquadCoefs(BQ.PEAK, P.m2f, P.m2q, P.m2g, sr, new Float64Array(5)), biquadCoefs(BQ.HIGHSHELF, P.hf, 0.707, P.hg, sr, new Float64Array(5))];
      const fx_ = (fr) => (Math.log(fr / 20) / Math.log(1000)) * w, y = (db) => hh / 2 - (db / 20) * (hh / 2 - 4);
      c.fillStyle = 'rgba(255,255,255,0.07)'; c.fillRect(0, hh / 2, w, 1);
      for (const fr of [100, 1000, 10000]) c.fillRect(fx_(fr), 0, 1, hh);
      c.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const fr = 20 * Math.pow(1000, x / w);
        let m = Math.pow(10, P.out / 20);
        for (const b of bands) m *= biquadMag(b, fr, sr);
        const yy = y(20 * Math.log10(m));
        x ? c.lineTo(x, yy) : c.moveTo(x, yy);
      }
      c.strokeStyle = accent; c.lineWidth = 1.6; c.stroke();
      c.lineTo(w, hh / 2); c.lineTo(0, hh / 2); c.closePath(); c.fillStyle = 'rgba(255,143,60,0.12)'; c.fill();
      c.fillStyle = '#6f7880'; c.font = '9.5px var(--font-mono, monospace)'; c.fillText('+20 dB', 3, 10); c.fillText('−20', 3, hh - 3);
    };
    const card = {
      el, chId,
      updateValues: () => {
        const f = getFx(); if (!f) return;
        for (const [pid, c] of ctl) { c.set(f.params[pid]); c.auto(app.hasAutomation(chId, `fx:${fxId}:${pid}`)); }
        drawEq();
      },
      update: (i, n) => {
        const f = getFx(); if (!f) return;
        el.classList.toggle('bypassed', !!f.bypass);
        el.classList.toggle('active', app.ui.selInsert === fxId);
        pow.classList.toggle('on', !f.bypass);
        left.disabled = i === 0; right.disabled = i === n - 1;
        card.updateValues();
      },
    };
    return card;
  }
  frame() {}
}
export { formatValue };
