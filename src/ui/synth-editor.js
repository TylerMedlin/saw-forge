// Saw Forge instrument panel.

import { h, Surface, css } from './dom.js';
import { icon } from './icons.js';
import { Knob, HSlider, selectEl, contextMenu } from './widgets.js';
import { WavetableEditor } from './wavetable-editor.js';
import { SYNTH_DEF, SYNTH_PARAMS, MOD_SOURCES, MOD_DESTS, MATRIX_SLOTS, SYNC_DIVS, LFO_SHAPES, toNorm, formatValue } from '../shared/params.js';
import { synthFilterMag } from '../shared/dspmath.js';
import { PRESET_CATEGORIES } from '../shared/presets.js';
import { findTrack } from '../core/project.js';

export class SynthEditor {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.controls = new Map();
    this.trackId = null;
    this.graphs = [];
    this.build();
  }

  get track() { const t = findTrack(this.app.p, this.trackId); return t && t.instrument ? t : null; }

  // ------------------------------------------------------------ control factories
  knob(pid, opts = {}) {
    const app = this.app, def = SYNTH_DEF[pid];
    const k = new Knob({
      def, size: opts.size || 34, label: opts.label, class: opts.cls,
      onBegin: () => app.synthBegin(`Change ${def.name}`),
      onInput: (v) => { if (this.trackId) app.synthLive(this.trackId, pid, v); },
      onEnd: () => app.synthEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, def.automatable
        ? app.laneMenuItems(this.trackId, 'inst:' + pid, () => app.setSynthParam(this.trackId, pid, def.def))
        : [{ label: 'Reset to default', action: () => app.setSynthParam(this.trackId, pid, def.def) }]),
    });
    this.controls.set(pid, { type: 'knob', set: (v) => k.set(v), auto: (a) => k.setAutomated(a), ctl: k });
    return k.el;
  }
  sel(pid, cls = '') {
    const def = SYNTH_DEF[pid];
    const el = selectEl(def.options.map((o, i) => ({ value: i, label: o })), def.def, (v) => this.app.setSynthParam(this.trackId, pid, +v), 'sel-sm ' + cls, def.name);
    this.controls.set(pid, { type: 'sel', set: (v) => { el.value = String(Math.round(v)); }, auto: () => {} });
    return el;
  }
  tog(pid, label, cls = '') {
    const def = SYNTH_DEF[pid];
    const b = h('button', { class: 'pill ' + cls, title: def.name, onClick: () => { const t = this.track; if (t) this.app.setSynthParam(t.id, pid, t.instrument.params[pid] >= 0.5 ? 0 : 1); } }, label);
    this.controls.set(pid, { type: 'tog', set: (v) => b.classList.toggle('on', v >= 0.5), auto: () => {} });
    return b;
  }
  power(pid, card) {
    const b = h('button', { class: 'power', title: 'On / off', onClick: () => { const t = this.track; if (t) this.app.setSynthParam(t.id, pid, t.instrument.params[pid] >= 0.5 ? 0 : 1); } }, icon('power', 12));
    this.controls.set(pid, { type: 'pow', set: (v) => { b.classList.toggle('on', v >= 0.5); if (card) card.classList.toggle('off', v < 0.5); }, auto: () => {} });
    return b;
  }
  card(title, cls, headExtra, ...body) {
    const c = h('div', { class: 'sf-card ' + cls });
    c.append(h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, title), ...[].concat(headExtra || [])), ...body);
    return c;
  }
  graph(cls, drawFn, height = 56) {
    const cv = h('canvas', { class: 'sf-graph ' + cls, style: { height: `${height}px` } });
    const g = { cv, s: null, draw: drawFn };
    queueMicrotask(() => { g.s = new Surface(cv, () => this.drawGraph(g)); });
    this.graphs.push(g);
    return cv;
  }
  drawGraph(g) { if (g.s && this.track && g.s.w > 2) { g.s.clear(); g.draw(g.s.ctx, g.s.w, g.s.h, this.track.instrument.params); } }

  // ------------------------------------------------------------ layout
  build() {
    const app = this.app;
    this.presetSel = h('div', { class: 'preset-sel-wrap' });
    this.trackPill = h('div', { class: 'sf-track-pill' });
    this.voicesEl = h('div', { class: 'sf-voices', title: 'Active voices' });
    const header = h('div', { class: 'sf-header' },
      h('div', { class: 'sf-logo' }, h('span', { class: 'sf-logo-mark' }), h('b', null, 'SAW FORGE'), h('span', null, 'wavetable analog')),
      h('div', { class: 'preset-nav' },
        h('button', { class: 'ibtn sm', title: 'Previous preset', onClick: () => this.stepPreset(-1) }, icon('left', 14)),
        this.presetSel,
        h('button', { class: 'ibtn sm', title: 'Next preset', onClick: () => this.stepPreset(1) }, icon('right', 14)),
        h('button', { class: 'btn ghost sm', title: 'Save as user preset', onClick: () => app.savePreset(this.trackId) }, icon('save', 13), h('span', null, 'Save')),
      ),
      this.trackPill, h('div', { class: 'tb-spacer' }), this.voicesEl);

    // oscillators
    const osc = (k, name) => {
      const card = h('div', { class: 'sf-card osc-card' });
      const body = h('div', { class: 'knob-grid g4' },
        this.knob(`${k}.level`), this.knob(`${k}.pos`), this.knob(`${k}.oct`), this.knob(`${k}.semi`),
        this.knob(`${k}.fine`), this.knob(`${k}.uni`), this.knob(`${k}.detune`), this.knob(`${k}.spread`),
        this.knob(`${k}.phase`), this.knob(`${k}.rand`), this.knob(`${k}.pulse`), this.knob(`${k}.width`),
        this.knob(`${k}.sync`), this.knob(`${k}.pan`));
      const wtName = h('button', { class: 'wt-name', title: 'Edit this oscillator in the wavetable editor', onClick: () => { app.ui.wtOsc = k === 'a' ? 0 : 1; this.wtEd.refresh(); } });
      this['wtName_' + k] = wtName;
      card.append(h('div', { class: 'card-head' }, this.power(`${k}.on`, card), h('span', { class: 'card-title' }, name), wtName), body);
      return card;
    };
    this.wtEd = new WavetableEditor(this);
    const row1 = h('div', { class: 'sf-row' }, osc('a', 'OSC A'), this.wtEd.el, osc('b', 'OSC B'));

    // sub / noise / analog
    const subCard = h('div', { class: 'sf-card subnoise-card' });
    subCard.append(
      h('div', { class: 'card-head' }, this.power('sub.on'), h('span', { class: 'card-title' }, 'SUB'), this.sel('sub.oct'), this.sel('sub.shape')),
      h('div', { class: 'knob-row' }, this.knob('sub.level')),
      h('div', { class: 'card-head sub2' }, this.power('noise.on'), h('span', { class: 'card-title' }, 'NOISE'), this.sel('noise.color')),
      h('div', { class: 'knob-row' }, this.knob('noise.level')));
    const analog = this.card('ANALOG', 'analog-card', null,
      h('div', { class: 'knob-row' }, this.knob('an.drift', { size: 40 }), this.knob('an.var', { size: 40 })),
      h('div', { class: 'card-note' }, 'Slow pitch & cutoff drift per voice, plus random detune, envelope and level offsets per note.'));

    // filter
    const fGraph = this.graph('filter-graph', (c, w, hh, p) => this.drawFilter(c, w, hh, p), 70);
    this.filterGraph = this.graphs[this.graphs.length - 1];
    const filter = this.card('FILTER', 'filter-card', [this.sel('flt.mode', 'flt-mode')], fGraph,
      h('div', { class: 'knob-row' }, this.knob('flt.cut', { size: 46 }), this.knob('flt.res', { size: 40 }), this.knob('flt.drive'), this.knob('flt.env'), this.knob('flt.key'), this.knob('flt.vel')));

    const env = (k, title) => {
      const cv = this.graph('env-graph', (c, w, hh, p) => drawEnv(c, w, hh, p, k), 46);
      return this.card(title, 'env-card', null, cv, h('div', { class: 'knob-row' }, this.knob(`${k}.a`), this.knob(`${k}.d`), this.knob(`${k}.s`), this.knob(`${k}.r`)));
    };
    const voice = this.card('VOICE', 'voice-card', [this.sel('v.mode')],
      h('div', { class: 'knob-grid g3' }, this.knob('v.poly'), this.knob('v.glide'), this.knob('v.bend'), this.knob('v.vel'), this.knob('out.gain', { size: 40 })));
    const row2 = h('div', { class: 'sf-row' }, subCard, analog, filter, env('fenv', 'FILTER ENV'), env('aenv', 'AMP ENV'), env('menv', 'MOD ENV'), voice);

    // LFOs
    const lfo = (k, title) => {
      const rateWrap = h('div', { class: 'lfo-rate' }, this.knob(`${k}.rate`));
      const divWrap = h('div', { class: 'lfo-div' }, h('span', { class: 'mini-label' }, 'Rate'), this.sel(`${k}.div`));
      this['rate_' + k] = rateWrap; this['div_' + k] = divWrap;
      const cv = this.graph('lfo-graph', (c, w, hh, p) => drawLfo(c, w, hh, p, k), 40);
      return this.card(title, 'lfo-card', [this.sel(`${k}.shape`)], cv,
        h('div', { class: 'knob-row' }, rateWrap, divWrap, this.knob(`${k}.phase`), h('div', { class: 'pill-col' }, this.tog(`${k}.sync`, 'Sync'), this.tog(`${k}.retrig`, 'Retrig'))));
    };

    // matrix
    const rows = [];
    this.matRows = [];
    for (let i = 0; i < MATRIX_SLOTS; i++) {
      const amt = new HSlider({ def: SYNTH_DEF[`m${i}.amt`], class: 'mat-amt', bipolar: true,
        onBegin: () => app.synthBegin('Mod amount'), onInput: (v) => app.synthLive(this.trackId, `m${i}.amt`, v), onEnd: () => app.synthEnd(),
        onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(this.trackId, `inst:m${i}.amt`, () => app.setSynthParam(this.trackId, `m${i}.amt`, 0))) });
      this.controls.set(`m${i}.amt`, { type: 'hs', set: (v) => amt.set(v), auto: (a) => amt.setAutomated(a) });
      const row = h('div', { class: 'mat-row' }, h('span', { class: 'mat-n' }, String(i + 1)), this.sel(`m${i}.src`, 'mat-src'), h('span', { class: 'mat-arrow' }, '→'), this.sel(`m${i}.dst`, 'mat-dst'), amt.el);
      this.matRows.push(row); rows.push(row);
    }
    const matrix = this.card('MOD MATRIX', 'matrix-card', [h('span', { class: 'card-sub' }, 'source → destination · amount')], h('div', { class: 'mat-list' }, rows));

    // FX
    const fx = (type, title, ...controls) => h('div', { class: 'fx-mini' }, h('div', { class: 'fx-mini-head' }, this.power(`fx.${type}.on`), h('span', null, title)), h('div', { class: 'knob-row' }, ...controls));
    this.delayTime = h('div', { class: 'lfo-rate' }, this.knob('fx.delay.time', { label: 'Time' }));
    this.delayDiv = h('div', { class: 'lfo-div' }, h('span', { class: 'mini-label' }, 'Time'), this.sel('fx.delay.div'));
    const fxCard = this.card('EFFECTS', 'fx-card', [h('span', { class: 'card-sub' }, 'Distortion → Chorus → Delay → Reverb → EQ')],
      h('div', { class: 'fx-rack' },
        fx('distortion', 'Drive', h('div', { class: 'stack' }, this.sel('fx.distortion.type')), this.knob('fx.distortion.drive', { label: 'Drive' }), this.knob('fx.distortion.tone', { label: 'Tone' }), this.knob('fx.distortion.mix', { label: 'Mix' })),
        fx('chorus', 'Chorus', this.knob('fx.chorus.rate', { label: 'Rate' }), this.knob('fx.chorus.depth', { label: 'Depth' }), this.knob('fx.chorus.mix', { label: 'Mix' })),
        fx('delay', 'Delay', h('div', { class: 'pill-col' }, this.tog('fx.delay.sync', 'Sync'), this.tog('fx.delay.pp', 'P-Pong')), this.delayTime, this.delayDiv, this.knob('fx.delay.fb', { label: 'Fdbk' }), this.knob('fx.delay.mix', { label: 'Mix' })),
        fx('reverb', 'Reverb', this.knob('fx.reverb.size', { label: 'Size' }), this.knob('fx.reverb.decay', { label: 'Decay' }), this.knob('fx.reverb.damp', { label: 'Damp' }), this.knob('fx.reverb.mix', { label: 'Mix' })),
        fx('eq', 'EQ', this.knob('fx.eq.lg', { label: 'Low' }), this.knob('fx.eq.m1g', { label: 'Mid' }), this.knob('fx.eq.m1f', { label: 'Freq' }), this.knob('fx.eq.hg', { label: 'High' }))));
    const row3 = h('div', { class: 'sf-row' }, lfo('lfo1', 'LFO 1'), lfo('lfo2', 'LFO 2'), matrix, fxCard);

    this.placeholder = h('div', { class: 'sf-placeholder' },
      h('div', { class: 'sf-ph-title' }, 'Select a Saw Forge track'),
      h('div', null, 'Choose an instrument track in the arrangement or mixer to edit its sound, or create one.'),
      h('button', { class: 'btn primary', onClick: () => app.addInstrumentTrack() }, icon('plus', 14), h('span', null, 'New Saw Forge track')));
    this.body = h('div', { class: 'sf-body' }, row1, row2, row3);
    this.el = h('div', { class: 'synth' }, header, this.body, this.placeholder);
  }

  // ------------------------------------------------------------ refresh
  refresh(d) {
    const app = this.app;
    const sel = app.selectedTrack;
    const tid = sel && sel.instrument && sel.instrument.type === 'sawforge' ? sel.id : null;
    const changedTrack = tid !== this.trackId;
    this.trackId = tid;
    const t = this.track;
    this.body.style.display = t ? '' : 'none';
    this.placeholder.style.display = t ? 'none' : '';
    if (!t) return;
    if (d && d.scope === 'inst-param' && d.transient && !changedTrack) { this.onLocalChange(d.pid); return; }
    if (d && d.scope === 'wt' && d.transient) { this.wtEd.refresh(); return; }
    const p = t.instrument.params;
    for (const [pid, c] of this.controls) {
      c.set(p[pid]);
      c.auto(app.hasAutomation(t.id, 'inst:' + pid));
    }
    this.wtName_a.textContent = t.instrument.wt[0].name;
    this.wtName_b.textContent = t.instrument.wt[1].name;
    this.trackPill.replaceChildren(h('span', { class: 'pill-dot', style: { background: t.color } }), t.name);
    this.renderPresetSel(t);
    this.updateVisibility(p);
    this.wtEd.refresh();
    for (const g of this.graphs) this.drawGraph(g);
  }

  onLocalChange(pid) {
    const t = this.track;
    if (!t) return;
    const p = t.instrument.params;
    if (pid && /sync|div|shape|^m\d/.test(pid)) this.updateVisibility(p);
    for (const g of this.graphs) this.drawGraph(g);
    if (pid && /\.pos$/.test(pid)) this.wtEd.dirty = true;
  }

  updateVisibility(p) {
    for (const k of ['lfo1', 'lfo2']) {
      const synced = p[`${k}.sync`] >= 0.5;
      this['rate_' + k].style.display = synced ? 'none' : '';
      this['div_' + k].style.display = synced ? '' : 'none';
    }
    const ds = p['fx.delay.sync'] >= 0.5;
    this.delayTime.style.display = ds ? 'none' : ''; this.delayDiv.style.display = ds ? '' : 'none';
    this.matRows.forEach((r, i) => r.classList.toggle('active', p[`m${i}.src`] > 0 && p[`m${i}.dst`] > 0));
  }

  renderPresetSel(t) {
    const app = this.app, all = app.allPresets();
    const name = t.instrument.preset;
    const key = name + '|' + all.length;
    if (key === this.presetKey) return;
    this.presetKey = key;
    const groups = [...PRESET_CATEGORIES, 'User'].map((cat) => ({ group: cat, options: all.filter((pr) => pr.category === cat).map((pr) => ({ value: pr.name, label: pr.name })) })).filter((g) => g.options.length);
    const known = all.some((pr) => pr.name === name);
    if (!known) groups.unshift({ group: 'Current', options: [{ value: name, label: name + ' (modified)' }] });
    this.presetSel.replaceChildren(selectEl(groups, name, (v) => { const pr = all.find((x) => x.name === v); if (pr) app.loadPreset(t.id, pr); }, 'preset-sel', 'Presets'));
  }
  stepPreset(dir) {
    const t = this.track;
    if (!t) return;
    const all = this.app.allPresets();
    const i = all.findIndex((p) => p.name === t.instrument.preset);
    const n = all[(i + dir + all.length) % all.length];
    this.app.loadPreset(t.id, n);
  }

  frame() {
    const t = this.track;
    if (!t || !this.el.isConnected) return;
    const e = this.app.engine, b = e.teleBase(t.id);
    let posA = -1, posB = -1, cut = 0, voices = 0;
    if (b >= 0 && e.state === 'running') { posA = e.tele[b]; posB = e.tele[b + 1]; cut = e.tele[b + 2]; voices = e.tele[b + 3]; }
    this.wtEd.frame_(posA, posB, voices);
    const vt = voices > 0 ? `${voices} voice${voices === 1 ? '' : 's'}` : 'idle';
    if (vt !== this.lastVoices) { this.lastVoices = vt; this.voicesEl.textContent = vt; this.voicesEl.classList.toggle('on', voices > 0); }
    const lc = voices > 0 ? Math.round(cut) : 0;
    if (lc !== this.liveCut) { this.liveCut = lc; this.drawGraph(this.filterGraph); }
    if (this.app.isPlaying && (this.tick = (this.tick || 0) + 1) % 4 === 0) this.followAutomation(t);
  }

  // Automated parameters follow their lanes during playback.
  followAutomation(t) {
    const pos = this.app.engine.position;
    for (const lane of t.automation) {
      if (!lane.target.startsWith('inst:') || !lane.points.length) continue;
      const pid = lane.target.slice(5), c = this.controls.get(pid), def = SYNTH_DEF[pid];
      if (!c || !def || this.app.autoRec.isWriting(t.id, lane.target)) continue; // the hand on the knob wins
      const v = laneValue(lane.points, pos);
      c.set(def.curve === 'exp' ? def.min * Math.pow(def.max / def.min, v) : def.min + (def.max - def.min) * (def.curve === 'pow' ? Math.pow(v, def.skew) : v));
    }
  }

  drawFilter(c, w, hh, p) {
    const accent = css('--accent') || '#ff8f3c';
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
    const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * w;
    c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 1;
    for (const f of [100, 1000, 10000]) { c.beginPath(); c.moveTo(fx(f), 0); c.lineTo(fx(f), hh); c.stroke(); }
    const mode = p['flt.mode'] | 0, fc = p['flt.cut'], res = p['flt.res'];
    const dbY = (db) => hh * 0.18 + (-db / 36) * hh * 0.82;
    c.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = 20 * Math.pow(1000, x / w);
      const m = synthFilterMag(mode, f, fc, res);
      const y = Math.min(hh, dbY(20 * Math.log10(m + 1e-9)));
      x ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = accent; c.lineWidth = 1.6; c.stroke();
    c.lineTo(w, hh); c.lineTo(0, hh); c.closePath();
    c.fillStyle = 'rgba(255,143,60,0.1)'; c.fill();
    if (this.liveCut > 0 && mode !== 5) {
      const x = fx(Math.max(20, Math.min(20000, this.liveCut)));
      c.fillStyle = 'rgba(255,255,255,0.7)'; c.fillRect(x, 0, 1.5, hh);
    }
    c.fillStyle = '#6f7880'; c.font = '9.5px var(--font-mono, monospace)';
    c.fillText(formatValue(SYNTH_DEF['flt.cut'], fc), 4, 11);
  }
}

function laneValue(pts, b) {
  if (b <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (pts[i][0] >= b) { const a = pts[i - 1], z = pts[i]; return z[0] > a[0] ? a[1] + ((z[1] - a[1]) * (b - a[0])) / (z[0] - a[0]) : z[1]; }
  return pts[pts.length - 1][1];
}

function drawEnv(c, w, hh, p, k) {
  const accent = css('--accent') || '#ff8f3c';
  c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
  const A = p[`${k}.a`], D = p[`${k}.d`], S = p[`${k}.s`], R = p[`${k}.r`];
  const sc = (t) => Math.sqrt(t);
  const total = sc(A) + sc(D) + sc(R) + 0.6;
  const ux = (w - 8) / total;
  const top = 5, bot = hh - 4, yv = (v) => bot - v * (bot - top);
  const xa = 4 + sc(A) * ux, xd = xa + sc(D) * ux, xs = xd + 0.6 * ux, xr = xs + sc(R) * ux;
  c.beginPath(); c.moveTo(4, bot);
  for (let i = 1; i <= 16; i++) { const t = i / 16; c.lineTo(4 + (xa - 4) * t, yv(1.3 * (1 - Math.exp(-1.466 * t)))); }
  for (let i = 1; i <= 16; i++) { const t = i / 16; c.lineTo(xa + (xd - xa) * t, yv(S + (1 - S) * Math.exp(-4.6 * t))); }
  c.lineTo(xs, yv(S));
  for (let i = 1; i <= 16; i++) { const t = i / 16; c.lineTo(xs + (xr - xs) * t, yv(S * Math.exp(-4.6 * t))); }
  c.strokeStyle = accent; c.lineWidth = 1.6; c.stroke();
  c.lineTo(xr, bot); c.closePath(); c.fillStyle = 'rgba(255,143,60,0.1)'; c.fill();
  c.fillStyle = 'rgba(255,255,255,0.18)'; for (const x of [xa, xd, xs]) c.fillRect(x, top, 1, bot - top);
}

function drawLfo(c, w, hh, p, k) {
  const accent = css('--accent') || '#ff8f3c';
  c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
  c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, hh / 2, w, 1);
  const shape = p[`${k}.shape`] | 0, ph0 = p[`${k}.phase`];
  const rnd = [0.6, -0.4, 0.9, -0.8, 0.1, 0.7, -0.2, -0.9];
  c.beginPath();
  for (let x = 0; x <= w; x++) {
    const t = (x / w) * 2 + ph0, ph = t - Math.floor(t), cyc = Math.floor(t);
    let v;
    switch (shape) {
      case 0: v = Math.sin(2 * Math.PI * ph); break;
      case 1: { const q = ph + 0.25; v = 1 - 4 * Math.abs(q - Math.floor(q) - 0.5); break; }
      case 2: v = 2 * ph - 1; break;
      case 3: v = 1 - 2 * ph; break;
      case 4: v = ph < 0.5 ? 1 : -1; break;
      case 5: v = rnd[((cyc * 2 + (ph < 0.5 ? 0 : 1)) % 8 + 8) % 8]; break;
      default: { const a = rnd[(cyc % 8 + 8) % 8], b = rnd[((cyc + 1) % 8 + 8) % 8]; v = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * ph)); }
    }
    const y = hh / 2 - v * (hh / 2 - 4);
    x ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.strokeStyle = accent; c.lineWidth = 1.5; c.stroke();
  c.fillStyle = '#6f7880'; c.font = '9.5px var(--font-mono, monospace)';
  const synced = p[`${k}.sync`] >= 0.5;
  c.fillText(synced ? SYNC_DIVS[p[`${k}.div`] | 0].name : formatValue(SYNTH_DEF[`${k}.rate`], p[`${k}.rate`]), 4, 11);
}
