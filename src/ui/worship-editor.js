// Worship Atmospheres modular editor.
//
// One panel per module, laid out in signal-flow order:
//   SOURCES → FILTERS → MODULATION → LAYER MIXER → EFFECTS → MASTER (+ VOICING)
// Every control is a real engine parameter. Live visuals come from the
// engine: per-layer meters, voices, swell / LFO / EVOLVE activity (shared
// memory telemetry) and a spectrum of the pad's output (analyser).
// Edits either a Worship Atmospheres track or the LIVE PAD's sound.

import { h, Surface, css } from './dom.js';
import { icon } from './icons.js';
import { Knob, selectEl, contextMenu } from './widgets.js';
import { WavetableEditor } from './wavetable-editor.js';
import {
  WP_DEF, W, PAD_MATRIX, VC, voiceChord, parseIntervals, keyName,
} from '../shared/worship-params.js';
import { WORSHIP_COLLECTIONS } from '../shared/worship-presets.js';
import { SYNC_DIVS, formatValue } from '../shared/params.js';
import { synthFilterMag } from '../shared/dspmath.js';
import { previewFrame } from '../shared/wavetable.js';
import { basicTable } from '../audio/worklet/worship.js';
import { findTrack } from '../core/project.js';

const ACCENT2 = '#8fb8ff';

export class WorshipEditor {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.controls = new Map();
    this.graphs = [];
    this.target = null;   // 'livepad' or a track id
    this.wtSlot = 0;
    this.build();
  }

  get inst() { return this.target ? this.app.padInst(this.target) : null; }

  // ------------------------------------------------------------ control factories
  knob(pid, opts = {}) {
    const app = this.app, def = WP_DEF[pid];
    const k = new Knob({
      def, size: opts.size || 30, label: opts.label || def.short, class: opts.cls,
      onBegin: () => app.padBegin(this.target, `Change ${def.name}`),
      onInput: (v) => { if (this.target) app.padLive(this.target, pid, v); },
      onEnd: () => app.padEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, this.target !== 'livepad' && def.automatable
        ? app.laneMenuItems(this.target, 'inst:' + pid, () => app.setPadParam(this.target, pid, def.def))
        : [{ label: 'Reset to default', action: () => app.setPadParam(this.target, pid, def.def) }]),
    });
    this.controls.set(pid, { set: (v) => k.set(v), auto: (a) => k.setAutomated(a) });
    return k.el;
  }
  sel(pid, cls = '', labels = null) {
    const def = WP_DEF[pid];
    const el = selectEl((labels || def.options).map((o, i) => ({ value: i, label: o })), def.def, (v) => this.app.setPadParam(this.target, pid, +v), 'sel-sm ' + cls, def.name);
    this.controls.set(pid, { set: (v) => { el.value = String(Math.round(v)); }, auto: () => {} });
    return el;
  }
  power(pid, card) {
    const b = h('button', { class: 'power', title: `${WP_DEF[pid].name}`, onClick: () => { const i = this.inst; if (i) this.app.setPadParam(this.target, pid, i.params[pid] >= 0.5 ? 0 : 1); } }, icon('power', 12));
    this.controls.set(pid, { set: (v) => { b.classList.toggle('on', v >= 0.5); if (card) card.classList.toggle('off', v < 0.5); }, auto: () => {} });
    return b;
  }
  tog(pid, label) {
    const b = h('button', { class: 'pill', title: WP_DEF[pid].name, onClick: () => { const i = this.inst; if (i) this.app.setPadParam(this.target, pid, i.params[pid] >= 0.5 ? 0 : 1); } }, label);
    this.controls.set(pid, { set: (v) => b.classList.toggle('on', v >= 0.5), auto: () => {} });
    return b;
  }
  card(title, cls, head, ...body) {
    const c = h('div', { class: 'wp-card ' + (cls || '') });
    c.append(h('div', { class: 'card-head' }, ...[].concat(head && head.pre ? head.pre : []), h('span', { class: 'card-title' }, title), ...[].concat(head && head.post ? head.post : [])), ...body);
    return c;
  }
  graph(cls, drawFn, height) {
    const cv = h('canvas', { class: 'wp-graph ' + cls, style: { height: `${height}px` } });
    const g = { cv, s: null, draw: drawFn };
    queueMicrotask(() => { g.s = new Surface(cv, () => this.drawGraph(g)); });
    this.graphs.push(g);
    return g;
  }
  drawGraph(g) { const i = this.inst; if (g.s && i && g.s.w > 2) { g.s.clear(); g.draw(g.s.ctx, g.s.w, g.s.h, i.params, i); } }
  col(title, ...cards) { return h('div', { class: 'wp-col' }, h('div', { class: 'wp-col-title' }, title), ...cards); }

  // ------------------------------------------------------------ layout
  build() {
    const app = this.app;
    this.presetSel = h('div', { class: 'preset-sel-wrap' });
    this.targetPill = h('div', { class: 'sf-track-pill' });
    this.voicesEl = h('div', { class: 'sf-voices' });
    this.liveBtn = h('button', { class: 'btn ghost sm', title: 'Open Live Pad Mode (P)', onClick: () => app.toggleLiveView(true) }, icon('live', 13), h('span', null, 'Live Pad'));
    const header = h('div', { class: 'sf-header wp-header' },
      h('div', { class: 'sf-logo wp-logo' }, h('span', { class: 'wp-logo-mark' }), h('b', null, 'WORSHIP ATMOSPHERES'), h('span', null, 'sustaining pad engine')),
      h('div', { class: 'preset-nav' },
        h('button', { class: 'ibtn sm', title: 'Previous preset', onClick: () => this.stepPreset(-1) }, icon('left', 14)),
        this.presetSel,
        h('button', { class: 'ibtn sm', title: 'Next preset', onClick: () => this.stepPreset(1) }, icon('right', 14))),
      this.targetPill, h('div', { class: 'tb-spacer' }), this.liveBtn, this.voicesEl);

    // ---- SOURCES
    const B = basicTable();
    const osc = (n) => {
      const k = `o${n}`, card = h('div', { class: 'wp-card osc' });
      const g = this.graph('wave', (c, w, hh, p, inst) => this.drawWave(c, w, hh, p, inst, n - 1, B), 34);
      const wtBtn = h('button', { class: 'wt-name', title: 'Edit this oscillator\'s wavetable', onClick: () => { this.wtSlot = n - 1; this.showWt = true; this.refresh({ scope: 'all' }); } });
      this['wtBtn' + n] = wtBtn;
      card.append(
        h('div', { class: 'card-head' }, this.power(`${k}.on`, card), h('span', { class: 'card-title' }, `OSC ${n}`), this.sel(`${k}.wave`, 'wave-sel'), wtBtn),
        g.cv,
        h('div', { class: 'knob-grid g6' },
          this.knob(`${k}.level`), this.knob(`${k}.morph`), this.knob(`${k}.pw`), this.knob(`${k}.oct`), this.knob(`${k}.semi`), this.knob(`${k}.fine`),
          this.knob(`${k}.uni`), this.knob(`${k}.detune`), this.knob(`${k}.spread`), this.knob(`${k}.drift`), this.knob(`${k}.pan`),
          h('div', { class: 'route' }, h('span', { class: 'mini-label' }, 'To'), this.sel(`${k}.route`, 'route-sel', ['F1', 'F2', 'Dry']))));
      return card;
    };
    this.wtWrap = h('div', { class: 'wp-wt' });
    this.wtTabs = [0, 1, 2, 3].map((i) => h('button', { class: 'seg-btn', onClick: () => { this.wtSlot = i; this.refresh({ scope: 'all' }); } }, `OSC ${i + 1}`));
    this.wtClose = h('button', { class: 'ibtn xs', title: 'Close the wavetable editor', onClick: () => { this.showWt = false; this.refresh({ scope: 'all' }); } }, icon('close', 12));
    this.wtEd = new WavetableEditor(this.wtAdapter());
    this.wtEd.oscTabs.forEach((b) => { b.style.display = 'none'; });
    this.wtWrap.append(h('div', { class: 'wp-wt-head' }, h('span', { class: 'card-title' }, 'WAVETABLE'), h('div', { class: 'seg' }, this.wtTabs), h('div', { class: 'tb-spacer' }), this.wtClose), this.wtEd.el);

    const noise = this.card('TEXTURE', 'noise', { pre: [this.power('nz.on')], post: [this.sel('nz.type'), this.sel('nz.route', 'route-sel', ['F1', 'F2', 'Dry'])] },
      h('div', { class: 'knob-row' }, this.knob('nz.level'), this.knob('nz.tone')));
    const bass = this.card('BASS FOUNDATION', 'bass', { pre: [this.power('bass.on')], post: [this.sel('bass.wave')] },
      h('div', { class: 'knob-row' }, this.knob('bass.level'), this.knob('bass.oct'), this.knob('bass.lp')),
      h('div', { class: 'card-note' }, 'Root only, below the pad\'s low cut — keep it low or off when a bass player is on stage.'));
    const strings = this.card('STRING ENSEMBLE', 'strings', { pre: [this.power('str.on')], post: [this.sel('str.type', 'str-sel')] },
      h('div', { class: 'knob-grid g7' },
        this.knob('str.vol'), this.knob('str.blend'), this.knob('str.attack'), this.knob('str.release'), this.knob('str.sustain'), this.knob('str.swell'), this.knob('str.oct'),
        this.knob('str.bright'), this.knob('str.cut'), this.knob('str.vib'), this.knob('str.ens'), this.knob('str.width'), this.knob('str.rev')),
      h('div', { class: 'card-note' }, 'Synthesized ensemble (detuned saw sections, bowed vibrato, body resonances, string-machine chorus) — not sampled orchestral recordings.'));
    const sources = this.col('SOURCES', h('div', { class: 'wp-osc-grid' }, osc(1), osc(2), osc(3), osc(4)), this.wtWrap, h('div', { class: 'wp-row' }, noise, bass), strings);

    // ---- FILTERS
    const flt = (n) => {
      const g = this.graph('filter', (c, w, hh, p) => this.drawFilter(c, w, hh, p, n), 52);
      this['fGraph' + n] = g;
      return this.card(`FILTER ${n}`, 'filter', { post: [this.sel(`f${n}.type`)] }, g.cv,
        h('div', { class: 'knob-grid g3' }, this.knob(`f${n}.cut`, { size: 36 }), this.knob(`f${n}.res`), this.knob(`f${n}.drive`), this.knob(`f${n}.key`), this.knob(`f${n}.swell`)));
    };
    const filters = this.col('FILTERS', flt(1), flt(2), h('div', { class: 'card-note wp-note' }, 'Paraphonic: every note of a layer shares its filter, so the whole atmosphere breathes together.'));

    // ---- MODULATION
    this.swellGraph = this.graph('env', (c, w, hh, p) => this.drawSwell(c, w, hh, p), 50);
    const swell = this.card('SWELL', 'swell', { post: [this.tog('sw.auto', 'Auto swell'), h('button', { class: 'pill', title: 'Trigger a swell now (live pad)', onClick: () => app.liveSwell() }, 'Swell ↑')] },
      this.swellGraph.cv,
      h('div', { class: 'knob-grid g5' }, this.knob('sw.attack'), this.knob('sw.decay'), this.knob('sw.sustain'), this.knob('sw.release'), this.knob('sw.curve'),
        this.knob('sw.intensity'), this.knob('sw.period'), this.knob('sw.depth')));
    const lfo = (n) => {
      const g = this.graph('lfo', (c, w, hh, p) => this.drawLfo(c, w, hh, p, n), 30);
      this['lfoGraph' + n] = g;
      const rate = h('div', { class: 'lfo-rate' }, this.knob(`l${n}.rate`));
      const div = h('div', { class: 'lfo-div' }, h('span', { class: 'mini-label' }, 'Rate'), this.sel(`l${n}.div`));
      this['rate' + n] = rate; this['div' + n] = div;
      return this.card(`LFO ${n}`, 'lfo', { post: [this.sel(`l${n}.shape`), this.tog(`l${n}.sync`, 'Sync')] }, g.cv, h('div', { class: 'knob-row' }, rate, div));
    };
    this.evBars = h('div', { class: 'wp-ev-bars', title: 'Live EVOLVE motion (morph, level, cutoff, detune, stereo, strings)' }, ...Array.from({ length: 6 }, () => h('span', null, h('i'))));
    const evolve = this.card('EVOLVE', 'evolve', { post: [this.evBars] },
      h('div', { class: 'knob-grid g4' }, this.knob('ev.amount', { size: 36 }), this.knob('ev.rate'), this.knob('ev.morph'), this.knob('ev.cutoff'),
        this.knob('ev.detune'), this.knob('ev.stereo'), this.knob('ev.strings'), this.knob('ev.amp')));
    this.brBars = h('div', { class: 'wp-br-bars', title: 'Each sounding note’s level right now, lowest note first' }, ...Array.from({ length: 8 }, () => h('span', null, h('i'))));
    const breathe = this.card('BREATHE', 'breathe', { post: [this.tog('br.root', 'Hold root')] },
      h('div', { class: 'wp-row' }, h('div', { class: 'knob-row' }, this.knob('br.amount', { size: 36 }), this.knob('br.rate'), this.knob('br.floor'), this.knob('br.bias')), this.brBars),
      h('div', { class: 'card-note wp-note' }, 'Each note of the chord fades in and out on its own clock while Hold root keeps the lowest note steady. Floor 0 lets notes leave completely; turn In ↔ Out up so they only drift in now and then.'));
    const rows = [];
    this.matRows = [];
    for (let i = 0; i < PAD_MATRIX; i++) {
      const row = h('div', { class: 'mat-row' }, h('span', { class: 'mat-n' }, String(i + 1)), this.sel(`m${i}.src`, 'mat-src'), h('span', { class: 'mat-arrow' }, '→'), this.sel(`m${i}.dst`, 'mat-dst'), this.knob(`m${i}.amt`, { size: 24, label: ' ' }));
      this.matRows.push(row); rows.push(row);
    }
    const matrix = this.card('MOD MATRIX', 'matrix', { post: [h('span', { class: 'card-sub' }, 'source → destination · amount')] }, h('div', { class: 'mat-list' }, rows));
    const modulation = this.col('MODULATION', swell, h('div', { class: 'wp-row' }, lfo(1), lfo(2)), evolve, breathe, matrix);

    // ---- LAYER MIXER
    const meter = (label, key) => {
      const bar = h('i');
      this.meters.push({ key, bar });
      return h('div', { class: 'wp-meter', title: `${label} level` }, h('span', { class: 'wp-meter-bar' }, bar), h('span', { class: 'mini-label' }, label));
    };
    this.meters = [];
    const mixer = this.col('LAYER MIXER', this.card('LAYERS', 'mixer', null,
      h('div', { class: 'wp-mix' },
        h('div', { class: 'wp-mix-ch' }, meter('Pad', 1), this.knob('mix.pad')),
        h('div', { class: 'wp-mix-ch' }, meter('Strings', 2), this.knob('mix.str')),
        h('div', { class: 'wp-mix-ch' }, meter('Bass', 3), this.knob('mix.bass')),
        h('div', { class: 'wp-mix-ch' }, meter('Texture', 4), this.knob('mix.noise')),
        h('div', { class: 'wp-mix-ch' }, meter('Space', 5), h('span', { class: 'mini-label' }, 'reverb'))),
      this.statEl = h('div', { class: 'wp-stats' })));

    // ---- EFFECTS
    const fxc = (title, onPid, ...ctrls) => this.card(title, 'fx', { pre: [this.power(onPid)] }, h('div', { class: 'knob-row' }, ...ctrls));
    this.dlTime = h('div', { class: 'lfo-rate' }, this.knob('dl.time'));
    this.dlDiv = h('div', { class: 'lfo-div' }, h('span', { class: 'mini-label' }, 'Time'), this.sel('dl.div'));
    const effects = this.col('EFFECTS',
      fxc('SATURATION', 'sat.on', this.knob('sat.drive'), this.knob('sat.tone')),
      fxc('CHORUS', 'ch.on', this.knob('ch.rate'), this.knob('ch.depth'), this.knob('ch.mix')),
      fxc('DELAY', 'dl.on', h('div', { class: 'pill-col' }, this.tog('dl.sync', 'Sync')), this.dlTime, this.dlDiv, this.knob('dl.fb'), this.knob('dl.damp'), this.knob('dl.mix')),
      fxc('REVERB', 'rv.on', this.knob('rv.send'), this.knob('rv.size'), this.knob('rv.decay'), this.knob('rv.damp'), this.knob('rv.pre')),
      fxc('SHIMMER', 'sh.on', this.knob('sh.amount'), this.knob('sh.fb'), this.knob('sh.tone')));

    // ---- MASTER + VOICING
    this.spec = this.graph('spectrum', (c, w, hh) => this.drawSpectrum(c, w, hh), 74);
    this.stereoEl = h('div', { class: 'wp-stereo', title: 'Stereo width of the pad (side / mid)' }, h('i'));
    const master = this.card('MASTER', 'master', { post: [this.stereoEl] }, this.spec.cv,
      h('div', { class: 'knob-grid g4' }, this.knob('st.width'), this.knob('st.motion'), this.knob('out.lowcut'), this.knob('out.trim'),
        this.knob('eq.low'), this.knob('eq.mid'), this.knob('eq.midf'), this.knob('eq.high')));
    this.customIn = h('input', { class: 'text-input wp-custom', placeholder: '0 7 12 16', spellcheck: false, title: 'Custom voicing: semitones above the root, separated by spaces' });
    this.customIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.customIn.blur(); });
    this.customIn.addEventListener('change', () => { if (parseIntervals(this.customIn.value)) app.setPadCustom(this.target, this.customIn.value.trim()); else this.customIn.value = (this.inst && this.inst.custom) || ''; });
    this.chordEl = h('div', { class: 'wp-chord' });
    this.playRow = h('div', { class: 'wp-playrow' }, this.sel('play.mode'), this.tog('play.minor', 'Minor'), this.tog('play.hold', 'Hold'), this.knob('play.poly', { size: 24 }));
    const voicing = this.card('VOICING', 'voicing', { post: [this.sel('vc.type')] },
      h('div', { class: 'knob-row' }, h('div', { class: 'stack' }, h('span', { class: 'mini-label' }, 'Register'), this.sel('vc.reg')), this.knob('vc.density'), this.knob('vc.spread')),
      this.customRow = h('div', { class: 'wp-custom-row' }, h('span', { class: 'mini-label' }, 'Intervals'), this.customIn),
      this.chordEl, this.playRow);
    const out = this.col('MASTER', master, voicing);

    const arrow = () => h('div', { class: 'wp-arrow' }, '→');
    this.flow = h('div', { class: 'wp-flow' }, sources, arrow(), filters, arrow(), modulation, arrow(), mixer, arrow(), effects, arrow(), out);
    this.placeholder = h('div', { class: 'sf-placeholder' }, h('div', { class: 'sf-ph-title' }, 'No Worship Atmospheres sound selected'));
    this.el = h('div', { class: 'synth wp' }, header, this.flow, this.placeholder);
  }

  // Reuse the Saw Forge wavetable editor for slots set to "Wavetable".
  wtAdapter() {
    const self = this, app = this.app;
    const frames = [0, 0, 0, 0];
    const ui = { get wtOsc() { return self.wtSlot; }, set wtOsc(v) {}, wtFrame: frames,
      get wtMode() { return app.ui.wtMode; }, set wtMode(v) { app.ui.wtMode = v; } };
    const proxy = Object.create(app, {
      ui: { value: ui },
      wtEdit: { value: (id, osc, fn, phase, label) => app.padWtEdit(id, osc, fn, phase, label) },
      setWavetable: { value: (id, osc, wt) => { frames[osc] = 0; app.padSetWavetable(id, osc, wt); } },
    });
    return {
      app: proxy,
      get track() {
        const inst = self.inst;
        if (!inst) return null;
        const pos = inst.params[`o${self.wtSlot + 1}.morph`];
        return { id: self.target, instrument: { wt: inst.wt, params: { 'a.pos': pos, 'b.pos': pos } } };
      },
    };
  }

  // ------------------------------------------------------------ refresh
  pickTarget() {
    const app = this.app;
    if (app.ui.padEdit && app.p.live) return 'livepad';
    const t = app.selectedTrack;
    return t && t.instrument && t.instrument.type === 'worship' ? t.id : null;
  }
  refresh(d) {
    const app = this.app;
    const target = this.pickTarget();
    const changed = target !== this.target;
    this.target = target;
    if (changed && target) app.engine.setScope(target);
    const inst = this.inst;
    this.flow.style.display = inst ? '' : 'none';
    this.placeholder.style.display = inst ? 'none' : '';
    if (!inst) return;
    if (d && d.transient && (d.scope === 'inst-param' || d.scope === 'live-param') && !changed) { this.onLocalChange(d.pid); return; }
    const p = inst.params;
    for (const [pid, c] of this.controls) {
      c.set(p[pid]);
      c.auto(target !== 'livepad' && app.hasAutomation(target, 'inst:' + pid));
    }
    const live = target === 'livepad';
    const tr = findTrack(app.p, target) || {};
    this.targetPill.replaceChildren(...(live
      ? [h('span', { class: 'live-pill' }, icon('live', 12), 'LIVE PAD')]
      : [h('span', { class: 'pill-dot', style: { background: tr.color } }), tr.name || '']));
    this.liveBtn.style.display = live ? 'none' : '';
    this.playRow.style.display = live ? 'none' : '';
    this.renderPresetSel(inst);
    for (let n = 1; n <= 4; n++) {
      const isWt = (p[`o${n}.wave`] | 0) === W.WT;
      this['wtBtn' + n].style.display = isWt ? '' : 'none';
      this['wtBtn' + n].textContent = inst.wt[n - 1].name;
    }
    const anyWt = [1, 2, 3, 4].some((n) => (p[`o${n}.wave`] | 0) === W.WT);
    this.wtWrap.style.display = this.showWt && anyWt ? '' : 'none';
    this.wtTabs.forEach((b, i) => { b.classList.toggle('on', i === this.wtSlot); b.disabled = (p[`o${i + 1}.wave`] | 0) !== W.WT; });
    if (this.showWt && anyWt) this.wtEd.refresh();
    if (document.activeElement !== this.customIn) this.customIn.value = inst.custom || '';
    this.updateVisibility(p);
    for (const g of this.graphs) this.drawGraph(g);
  }

  onLocalChange(pid) {
    const inst = this.inst;
    if (!inst) return;
    if (pid && /sync|div|^vc\.|^m\d|\.wave$/.test(pid)) this.updateVisibility(inst.params);
    for (const g of this.graphs) if (g !== this.spec) this.drawGraph(g);
    if (pid && /morph$/.test(pid)) this.wtEd.dirty = true;
  }

  updateVisibility(p) {
    for (const n of [1, 2]) {
      const synced = p[`l${n}.sync`] >= 0.5;
      this['rate' + n].style.display = synced ? 'none' : '';
      this['div' + n].style.display = synced ? '' : 'none';
    }
    const ds = p['dl.sync'] >= 0.5;
    this.dlTime.style.display = ds ? 'none' : ''; this.dlDiv.style.display = ds ? '' : 'none';
    this.matRows.forEach((r, i) => r.classList.toggle('active', p[`m${i}.src`] > 0 && p[`m${i}.dst`] > 0));
    this.customRow.style.display = (p['vc.type'] | 0) === VC.CUSTOM ? '' : 'none';
    // the chord this voicing makes (in the live key, or C for a track)
    const live = this.target === 'livepad', s = this.app.liveState;
    const pc = live ? s.key : 0, minor = live ? s.minor : p['play.minor'] >= 0.5;
    const type = p['vc.type'] | 0;
    const ch = voiceChord({ root: pc, minor, type, register: p['vc.reg'] | 0, density: p['vc.density'], spread: p['vc.spread'], custom: type === VC.CUSTOM ? parseIntervals(this.inst.custom) : null });
    const nm = (n) => keyName(n % 12, false, 'auto') + (Math.floor(n / 12) - 1);
    this.chordEl.textContent = `${keyName(pc, minor, this.app.p.live.spell)}: ${ch.notes.map(nm).join(' · ')}`;
  }

  renderPresetSel(inst) {
    const key = inst.preset;
    if (key === this.presetKey) return;
    this.presetKey = key;
    const groups = WORSHIP_COLLECTIONS.map((c) => ({ group: c.name, options: c.presets.map((pr) => ({ value: pr.name, label: pr.name })) }));
    const known = WORSHIP_COLLECTIONS.some((c) => c.presets.some((pr) => pr.name === key));
    if (!known) groups.unshift({ group: 'Current', options: [{ value: key, label: key + ' (modified)' }] });
    this.presetSel.replaceChildren(selectEl(groups, key, (v) => this.app.loadPadPreset(this.target, v), 'preset-sel', 'Worship Atmospheres presets'));
  }
  stepPreset(dir) {
    const inst = this.inst;
    if (!inst) return;
    const all = WORSHIP_COLLECTIONS.flatMap((c) => c.presets.map((p) => p.name));
    const i = all.indexOf(inst.preset);
    this.app.loadPadPreset(this.target, all[(i + dir + all.length) % all.length]);
  }

  // ------------------------------------------------------------ live visuals
  frame() {
    const inst = this.inst;
    if (!inst || !this.el.isConnected) return;
    const e = this.app.engine, t = e.padTele;
    const running = e.state === 'running';
    const voices = running ? Math.round(t[0]) : 0;
    const vt = voices > 0 ? `${voices} voice${voices === 1 ? '' : 's'}` : 'idle';
    if (vt !== this.lastVoices) { this.lastVoices = vt; this.voicesEl.textContent = vt; this.voicesEl.classList.toggle('on', voices > 0); }
    for (const m of this.meters) {
      const v = running ? t[m.key] : 0;
      const db = 20 * Math.log10(v + 1e-6), w = Math.max(0, Math.min(1, (db + 54) / 54));
      m.bar.style.height = `${(w * 100).toFixed(1)}%`;
    }
    const evs = this.evBars.children;
    for (let i = 0; i < 6; i++) { const v = running ? t[10 + i] : 0; evs[i].firstChild.style.height = `${(50 + v * 50).toFixed(1)}%`; }
    const brs = this.brBars.children;
    for (let k = 0; k < 8; k++) {
      const v = running ? t[21 + k] : -1;
      brs[k].classList.toggle('idle', v < 0);
      brs[k].firstChild.style.height = `${v < 0 ? 0 : Math.min(100, (v / 1.3) * 100).toFixed(1)}%`;
    }
    this.stereoEl.firstChild.style.width = `${Math.min(100, (running ? t[16] : 0) * 100).toFixed(1)}%`;
    const st = `swell ${Math.round((running ? t[6] : 0) * 100)}% · presence ${Math.round((running ? t[7] : 0) * 100)}%${running && t[18] > 0.01 ? ' · transition' : ''}`;
    if (st !== this.lastStat) { this.lastStat = st; this.statEl.textContent = st; }
    this.liveLfo = [running ? t[8] : 0, running ? t[9] : 0];
    this.liveSwellV = running ? t[6] : 0; this.livePresence = running ? t[7] : 0;
    if ((this.tick = (this.tick || 0) + 1) % 2 === 0) {
      this.drawGraph(this.spec); this.drawGraph(this.lfoGraph1); this.drawGraph(this.lfoGraph2); this.drawGraph(this.swellGraph);
    }
    if (this.showWt && this.wtWrap.style.display !== 'none') this.wtEd.frame_(-1, -1, voices);
  }

  drawWave(c, w, hh, p, inst, s, B) {
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
    const wave = p[`o${s + 1}.wave`] | 0, morph = p[`o${s + 1}.morph`], pw = p[`o${s + 1}.pw`];
    const N = B.size, row = N + 1, M = B.mips, data = B.data;
    const frame = (f, x) => { const i = Math.floor(x * N) % N; return data[(f * M + 1) * row + i]; };
    let fn;
    if (wave === W.WT) { const fr = previewFrame(inst.wt[s], morph, 128, 40); fn = (x) => fr[Math.floor(x * 127.99)] * 0.9; }
    else if (wave === W.MORPH) { const pos = morph * 3, f0 = Math.min(2, Math.floor(pos)), a = pos - f0; fn = (x) => frame(f0, x) * (1 - a) + frame(f0 + 1, x) * a; }
    else if (wave === W.PULSE) { const g = 0.5 / (2 * B.sawPeak * Math.sqrt(pw * (1 - pw))); fn = (x) => (frame(2, x) - frame(2, (x + pw) % 1)) * g; }
    else { const f = wave === W.SINE ? 0 : wave === W.TRI ? 1 : wave === W.SAW ? 2 : 3; fn = (x) => frame(f, x); }
    c.beginPath();
    for (let x = 0; x <= w; x++) { const y = hh / 2 - fn(x / (w + 1)) * (hh / 2 - 3); x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.strokeStyle = p[`o${s + 1}.on`] >= 0.5 ? (css('--accent') || '#ff8f3c') : '#55606a'; c.lineWidth = 1.4; c.stroke();
  }

  drawFilter(c, w, hh, p, n) {
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
    const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * w;
    c.strokeStyle = 'rgba(255,255,255,0.06)';
    for (const f of [100, 1000, 10000]) { c.beginPath(); c.moveTo(fx(f), 0); c.lineTo(fx(f), hh); c.stroke(); }
    const type = p[`f${n}.type`] | 0, fc = p[`f${n}.cut`], res = p[`f${n}.res`];
    const dbY = (db) => hh * 0.18 + (-db / 36) * hh * 0.82;
    c.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = 20 * Math.pow(1000, x / w), m = type === 5 ? 1 : synthFilterMag(type, f, fc, res);
      const y = Math.min(hh, dbY(20 * Math.log10(m + 1e-9)));
      x ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = n === 1 ? (css('--accent') || '#ff8f3c') : ACCENT2; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = '#6f7880'; c.font = '9.5px var(--font-mono, monospace)';
    c.fillText(type === 5 ? 'off' : formatValue(WP_DEF[`f${n}.cut`], fc), 4, 11);
  }

  drawSwell(c, w, hh, p) {
    const accent = css('--accent') || '#ff8f3c';
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
    const A = p['sw.attack'], D = p['sw.decay'], S = p['sw.sustain'], R = p['sw.release'], cv = p['sw.curve'];
    const sc = (t) => Math.sqrt(t), total = sc(A) + sc(D) + sc(R) + 0.8, ux = (w - 8) / total;
    const top = 5, bot = hh - 4, yv = (v) => bot - v * (bot - top);
    const xa = 4 + sc(A) * ux, xd = xa + sc(D) * ux, xs = xd + 0.8 * ux, xr = xs + sc(R) * ux;
    c.beginPath(); c.moveTo(4, bot);
    const e = Math.pow(3, cv);
    for (let i = 1; i <= 24; i++) { const t = i / 24; c.lineTo(4 + (xa - 4) * t, yv(Math.pow(t, e))); }
    for (let i = 1; i <= 16; i++) { const t = i / 16; c.lineTo(xa + (xd - xa) * t, yv(S + (1 - S) * Math.exp(-4.6 * t))); }
    c.lineTo(xs, yv(S));
    for (let i = 1; i <= 16; i++) { const t = i / 16; c.lineTo(xs + (xr - xs) * t, yv(S * Math.exp(-4.6 * t))); }
    c.strokeStyle = accent; c.lineWidth = 1.6; c.stroke();
    c.lineTo(xr, bot); c.closePath(); c.fillStyle = 'rgba(255,143,60,0.1)'; c.fill();
    if (p['sw.auto'] >= 0.5) {
      c.strokeStyle = 'rgba(143,184,255,0.6)'; c.setLineDash([3, 3]); c.beginPath();
      c.moveTo(4, yv(1 - p['sw.depth'])); c.lineTo(w - 4, yv(1 - p['sw.depth'])); c.stroke(); c.setLineDash([]);
    }
    if (this.livePresence > 0.001) { c.fillStyle = 'rgba(255,255,255,0.75)'; c.fillRect(w - 10, yv(this.livePresence) - 1, 6, 2); }
    if (this.liveSwellV > 0.001) { c.fillStyle = ACCENT2; c.fillRect(w - 4, yv(this.liveSwellV), 3, bot - yv(this.liveSwellV)); }
  }

  drawLfo(c, w, hh, p, n) {
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, hh / 2, w, 1);
    const shape = p[`l${n}.shape`] | 0, rnd = [0.6, -0.4, 0.9, -0.8, 0.1, 0.7, -0.2, -0.9];
    c.beginPath();
    for (let x = 0; x <= w; x++) {
      const t = (x / w) * 2, ph = t - Math.floor(t), cyc = Math.floor(t);
      let v;
      if (shape === 0) v = Math.sin(2 * Math.PI * ph);
      else if (shape === 1) v = 1 - 4 * Math.abs(ph - 0.5);
      else { const a = rnd[cyc % 8], b = rnd[(cyc + 1) % 8]; v = (a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * ph))) * (shape === 3 ? 0.7 : 1); }
      const y = hh / 2 - v * (hh / 2 - 3);
      x ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = 'rgba(255,143,60,0.7)'; c.lineWidth = 1.2; c.stroke();
    const live = this.liveLfo ? this.liveLfo[n - 1] : 0;
    c.fillStyle = '#fff'; c.beginPath(); c.arc(w - 6, hh / 2 - live * (hh / 2 - 3), 2.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#6f7880'; c.font = '9px var(--font-mono, monospace)';
    c.fillText(p[`l${n}.sync`] >= 0.5 ? SYNC_DIVS[p[`l${n}.div`] | 0].name : formatValue(WP_DEF[`l${n}.rate`], p[`l${n}.rate`]), 3, 9);
  }

  drawSpectrum(c, w, hh) {
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, w, hh);
    const an = this.app.engine.analyser;
    const fx = (f) => (Math.log(f / 30) / Math.log(18000 / 30)) * w;
    c.strokeStyle = 'rgba(255,255,255,0.06)';
    for (const f of [100, 1000, 10000]) { c.beginPath(); c.moveTo(fx(f), 0); c.lineTo(fx(f), hh); c.stroke(); }
    if (!an || this.app.engine.state !== 'running') return;
    if (!this.specBuf || this.specBuf.length !== an.frequencyBinCount) this.specBuf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(this.specBuf);
    const sr = this.app.engine.sampleRate, bin = sr / an.fftSize, buf = this.specBuf;
    c.beginPath();
    let started = false;
    for (let x = 0; x <= w; x += 2) {
      const f0 = 30 * Math.pow(18000 / 30, x / w), f1 = 30 * Math.pow(18000 / 30, (x + 2) / w);
      let m = -140;
      for (let k = Math.floor(f0 / bin); k <= Math.ceil(f1 / bin) && k < buf.length; k++) if (buf[k] > m) m = buf[k];
      const y = hh - Math.max(0, Math.min(1, (m + 100) / 80)) * (hh - 4);
      if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
    }
    c.strokeStyle = ACCENT2; c.lineWidth = 1.3; c.stroke();
    c.lineTo(w, hh); c.lineTo(0, hh); c.closePath(); c.fillStyle = 'rgba(143,184,255,0.1)'; c.fill();
  }
}

