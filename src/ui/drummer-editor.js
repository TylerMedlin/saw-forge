// Drummer editor (Instrument tab of a drum track), in the spirit of a
// "personal drummer": pick a drummer by personality, then shape how they play
// the selected region — Technique × Loudness pad, Fills, Speed, Swing, Feel —
// and which parts of the kit they use. The kit itself (sound, levels) is on the right.

import { h, Surface, css } from './dom.js';
import { icon } from './icons.js';
import { Knob, selectEl, contextMenu } from './widgets.js';
import { DRUMMERS, PERSONALITIES, PARTS, SPEEDS, SPEED_NAMES, drummerById, generateDrummer } from '../shared/drummers.js';
import { PIECES, KITS, KIT_NAMES, DRUM_DEF } from '../shared/drums.js';
import { findTrack, barBeats, isDrumTrack } from '../core/project.js';

const def = (id, name, min, max, d, unit, short) => ({ id, name, min, max, def: d, curve: 'lin', skew: 1, unit, options: null, automatable: false, short, bipolar: min < 0 && max > 0 });
const SORTS = [['default', 'Featured'], ['loud', 'Loudest'], ['fill', 'Most fills'], ['tech', 'Most complex'], ['speed', 'Fastest']];
const ROWS = [ // groove preview rows
  { name: 'Kick', ids: ['kick'] }, { name: 'Snare', ids: ['snare', 'clap'] }, { name: 'Toms', ids: ['tomL', 'tomM', 'tomH'] },
  { name: 'Hats', ids: ['chh', 'ohh'] }, { name: 'Perc', ids: ['rim', 'shaker', 'perc'] }, { name: 'Cym', ids: ['ride', 'crash', 'riser1', 'riser2', 'riser4'] },
];
const ROW_OF = PIECES.map((p) => ROWS.findIndex((r) => r.ids.includes(p.id)));
const halfTimeFeel = (D) => D.lanes.some((l) => l.piece === 'snare' && l.pats[0][8] === 'X' && l.pats[0][4] === '.');

export class DrummerEditor {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.trackId = null;
    this.filter = 'All'; this.sort = 'default';
    this.kitControls = new Map();
    this.lights = []; this.padEls = [];
    this.previewKey = '';
    this.build();
  }

  pickTarget() { const t = this.app.selectedTrack; return isDrumTrack(t) ? t.id : null; }
  get track() { return findTrack(this.app.p, this.trackId); }
  get clip() { return this.trackId ? this.app.drummerTarget(this.trackId) : null; }

  // ------------------------------------------------------------ building blocks
  card(title, cls, ...body) {
    return h('div', { class: 'wp-card dr-panel ' + (cls || '') }, h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, title)), ...body);
  }
  regionKnob(key, d, size = 34) {
    const app = this.app;
    const k = new Knob({
      def: d, size, label: d.short,
      onBegin: () => { const c = this.clip; if (c) app.drummerBegin(`Drummer: ${d.name}`); },
      onInput: (v) => { const c = this.clip; if (c) app.drummerLive(c.id, { [key]: v }); },
      onEnd: () => app.drummerEnd(),
    });
    return { el: k.el, set: (v) => k.set(v), knob: k };
  }
  kitKnob(pid, size = 28) {
    const app = this.app, d = DRUM_DEF[pid];
    const k = new Knob({
      def: d, size, label: d.short,
      onBegin: () => app.drumBegin(`Change ${d.name}`),
      onInput: (v) => { if (this.trackId) app.drumLive(this.trackId, pid, v); },
      onEnd: () => app.drumEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(this.trackId, 'inst:' + pid, () => app.setDrumParam(this.trackId, pid, d.def))),
    });
    this.kitControls.set(pid, { set: (v) => k.set(v), auto: (a) => k.setAutomated(a) });
    return k.el;
  }

  build() {
    const app = this.app;
    // ---- header
    this.trackPill = h('div', { class: 'sf-track-pill' });
    this.regionSel = h('select', { class: 'sel sel-sm dr-region-sel', title: 'Which Drummer region you are editing' });
    this.regionSel.addEventListener('change', () => { const id = this.regionSel.value; if (id) { app.ui.selClips = new Set([id]); app.editClip(id); } });
    this.tempoBtn = h('button', { class: 'btn ghost sm', title: "Set the project tempo to this drummer's natural tempo", onClick: () => { const c = this.clip; if (c) app.setTempo(drummerById(c.dr.id).bpm); } });
    const header = h('div', { class: 'sf-header dr-header' },
      h('div', { class: 'sf-logo dr-logo' }, h('span', { class: 'dr-logo-mark' }), h('b', null, 'DRUMMER'), h('span', null, 'virtual EDM drummers')),
      this.trackPill,
      h('span', { class: 'dr-hdr-label' }, 'Region'), this.regionSel,
      h('button', { class: 'btn ghost sm', title: 'Add a Drummer region after the last one', onClick: () => this.addRegion() }, icon('plus', 13), h('span', null, 'Region')),
      h('div', { class: 'tb-spacer' }),
      this.tempoBtn,
      h('button', { class: 'btn ghost sm', title: 'Same settings, a fresh take of the groove (new variations and fills)', onClick: () => { const c = this.clip; if (c) app.newDrummerTake(c.id); } }, icon('dice', 13), h('span', null, 'New take')),
      h('button', { class: 'btn ghost sm', title: 'Turn this region into an ordinary MIDI clip you can edit note by note', onClick: () => { const c = this.clip; if (c) app.drummerToMidi(c.id); } }, icon('roll', 13), h('span', null, 'Convert to MIDI')));

    // ---- drummers library
    this.chips = h('div', { class: 'dr-chips' });
    this.sortSel = selectEl(SORTS.map(([v, l]) => ({ value: v, label: l })), 'default', (v) => { this.sort = v; this.renderLibrary(); }, 'sel-sm', 'Sort drummers');
    this.list = h('div', { class: 'dr-list' });
    const library = this.card('DRUMMERS', 'dr-lib',
      h('div', { class: 'dr-lib-tools' }, h('span', { class: 'dr-hdr-label' }, 'Personality'), h('div', { class: 'tb-spacer' }), h('span', { class: 'dr-hdr-label' }, 'Sort'), this.sortSel),
      this.chips, this.list);

    // ---- performance: Technique × Loudness pad + feel controls
    this.xy = h('canvas', { class: 'dr-xy', title: 'Drag: left–right = Technique (simple → complex), down–up = Loudness (soft → loud)' });
    this.xyS = new Surface(this.xy, () => this.drawXY());
    this.xy.addEventListener('pointerdown', (e) => this.xyDown(e));
    this.fillK = this.regionKnob('fill', def('fill', 'Fills', 0, 1, 0.5, '%', 'Fills'), 44);
    this.swingK = this.regionKnob('swing', def('swing', 'Swing', 0, 1, 0, '%', 'Swing'));
    this.feelK = this.regionKnob('feel', def('feel', 'Feel (push ↔ laid back)', -1, 1, 0, 'feel', 'Feel'));
    this.humK = this.regionKnob('hum', def('hum', 'Humanize', 0, 1, 0.2, '%', 'Humanize'));
    this.speedBtns = SPEEDS.map((s) => h('button', { class: 'seg-btn', title: s === 'half' ? 'Kick & snare at half speed (backbeat on 3)' : s === 'double' ? 'Kick & snare at double speed' : 'Kick & snare as the drummer plays them', onClick: () => { const c = this.clip; if (c) app.setDrummer(c.id, { speed: s }, `Drummer speed: ${SPEED_NAMES[s]}`); } }, SPEED_NAMES[s]));
    this.xyInfo = h('div', { class: 'dr-xy-info' });
    const perf = this.card('PERFORMANCE', 'dr-perf',
      h('div', { class: 'dr-xy-wrap' },
        h('span', { class: 'dr-ax dr-ax-top' }, 'LOUD'), h('span', { class: 'dr-ax dr-ax-bot' }, 'SOFT'),
        h('span', { class: 'dr-ax dr-ax-l' }, 'SIMPLE'), h('span', { class: 'dr-ax dr-ax-r' }, 'COMPLEX'),
        this.xy),
      this.xyInfo,
      h('div', { class: 'dr-sub' }, 'SPEED'), h('div', { class: 'seg dr-speed' }, ...this.speedBtns),
      h('div', { class: 'knob-row dr-knobs' }, this.fillK.el, this.swingK.el, this.feelK.el, this.humK.el));

    // ---- parts + groove preview
    this.partRows = PARTS.map((part) => {
      const pw = h('button', { class: 'power', title: `${part.name} on/off`, onClick: () => { const c = this.clip; if (c) app.setDrummer(c.id, { parts: { [part.id]: { on: !c.dr.parts[part.id].on } } }, `${part.name} ${c.dr.parts[part.id].on ? 'off' : 'on'}`); } }, icon('power', 12));
      const vars = [0, 1, 2, 3].map((v) => h('button', { class: 'seg-btn dr-var', title: `${part.name}: pattern ${v + 1}`, onClick: () => { const c = this.clip; if (c) app.setDrummer(c.id, { parts: { [part.id]: { v } } }, `${part.name} pattern ${v + 1}`); } }, String(v + 1)));
      const lights = PIECES.map((p, k) => (p.part === part.id && !p.id.startsWith('riser') ? h('span', { class: 'dr-light', title: p.name, dataset: { k } }) : null)).filter(Boolean);
      for (const l of lights) this.lights.push([+l.dataset.k, l]);
      const row = h('div', { class: 'dr-part' }, pw, h('span', { class: 'dr-part-name' }, part.name), h('div', { class: 'seg dr-vars' }, ...vars), h('div', { class: 'dr-lights' }, ...lights));
      return { part, row, pw, vars };
    });
    this.preview = h('canvas', { class: 'dr-preview' });
    this.previewS = new Surface(this.preview, () => { this.previewKey = ''; this.drawPreview(true); });
    this.previewInfo = h('span', { class: 'card-sub' });
    const parts = this.card('PARTS & GROOVE', 'dr-parts', ...this.partRows.map((r) => r.row),
      h('div', { class: 'dr-sub' }, 'GROOVE', this.previewInfo), this.preview);

    // ---- kit: choose + audition pads
    this.kitSel = selectEl(KIT_NAMES.map((n, i) => ({ value: i, label: n })), 0, (v) => { if (this.trackId) app.setDrumParam(this.trackId, 'kit', +v); }, 'sel-sm', 'Drum kit');
    this.kitDesc = h('div', { class: 'card-note dr-kit-desc' });
    this.pads = h('div', { class: 'dr-pads' }, ...PIECES.map((p, k) => {
      const b = h('button', { class: 'dr-pad', title: `${p.name} — note ${p.note}. Click to hear it.`, onClick: () => { if (this.trackId) app.auditionDrum(this.trackId, p.note); } }, h('span', null, p.name.replace(' bar', '').replace(' bars', '')));
      this.padEls[k] = b;
      return b;
    }));
    const kit = this.card('KIT', 'dr-kit', h('div', { class: 'dr-kit-top' }, this.kitSel), this.kitDesc, this.pads);

    // ---- kit sound
    const grp = (title, ...knobs) => h('div', { class: 'dr-kgrp' }, h('div', { class: 'dr-sub' }, title), h('div', { class: 'knob-row' }, ...knobs));
    const sound = this.card('KIT SOUND', 'dr-sound',
      h('div', { class: 'dr-kgrid' },
        grp('KICK', this.kitKnob('k.tune'), this.kitKnob('k.decay'), this.kitKnob('k.punch')),
        grp('SNARE & CLAP', this.kitKnob('s.tune'), this.kitKnob('s.snap'), this.kitKnob('s.decay')),
        grp('HATS · CYMBALS · TOMS', this.kitKnob('h.decay'), this.kitKnob('h.tone'), this.kitKnob('c.decay'), this.kitKnob('t.tune')),
        grp('LEVELS', this.kitKnob('l.kick'), this.kitKnob('l.snare'), this.kitKnob('l.hats'), this.kitKnob('l.cym'), this.kitKnob('l.toms'), this.kitKnob('l.perc')),
        grp('MASTER', this.kitKnob('width'), this.kitKnob('drive'), this.kitKnob('tone'), this.kitKnob('vel'), this.kitKnob('out'))));

    this.noRegion = h('div', { class: 'dr-empty' }, h('div', null, 'This drum track has no Drummer region yet.'),
      h('button', { class: 'btn primary sm', onClick: () => this.addRegion() }, icon('plus', 13), h('span', null, 'Add a Drummer region')),
      h('div', { class: 'card-note' }, 'Or double-click the track lane in the arrangement. MIDI clips on this track play the kit too.'));
    this.flow = h('div', { class: 'wp-flow dr-flow' }, library, h('div', { class: 'dr-col' }, perf), h('div', { class: 'dr-col' }, parts), h('div', { class: 'dr-col' }, kit), h('div', { class: 'dr-col' }, sound));
    this.placeholder = h('div', { class: 'empty-note' }, 'Select a Drummer track. Add one with the Drummer button in the arrangement toolbar or from the Browser.');
    this.el = h('div', { class: 'synth dr' }, header, this.noRegion, this.flow, this.placeholder);
    this.renderLibrary();
  }

  addRegion() {
    const t = this.track;
    if (!t) return;
    const bar = barBeats(this.app.p);
    const end = t.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
    this.app.createDrummerRegion(t.id, Math.ceil(end / bar - 1e-9) * bar);
  }

  // ------------------------------------------------------------ drummers library
  renderLibrary() {
    const app = this.app, c = this.clip, cur = c ? c.dr.id : null;
    this.chips.replaceChildren(...['All', ...PERSONALITIES].map((p) => h('button', { class: 'pill dr-chip' + (this.filter === p ? ' on' : ''), onClick: () => { this.filter = p; this.renderLibrary(); } }, p)));
    let list = DRUMMERS.filter((d) => this.filter === 'All' || d.traits.includes(this.filter));
    const by = { loud: (d) => d.def.loud, fill: (d) => d.def.fill, tech: (d) => d.def.cx, speed: (d) => d.bpm }[this.sort];
    if (by) list = [...list].sort((a, b) => by(b) - by(a));
    const meter = (label, v, text) => h('div', { class: 'dr-meter', title: `${label}: ${text}` }, h('span', null, label), h('i', null, h('b', { style: { width: `${Math.round(v * 100)}%` } })), h('em', null, text));
    this.list.replaceChildren(...list.map((d) => {
      const half = halfTimeFeel(d);
      return h('button', { class: 'dr-card' + (d.id === cur ? ' on' : ''), title: `${d.name} — ${d.genre}\n${d.blurb}\nKit: ${d.kit}`,
        onClick: () => { if (this.trackId) app.chooseDrummer(this.trackId, d.id, c ? c.id : null); } },
        h('div', { class: 'dr-avatar', style: { background: d.color } }, d.name[0]),
        h('div', { class: 'dr-info' },
          h('div', { class: 'dr-name' }, h('b', null, d.name), h('span', null, d.genre)),
          h('div', { class: 'dr-tags' }, ...d.traits.map((t) => h('span', null, t))),
          h('div', { class: 'dr-blurb' }, d.blurb),
          h('div', { class: 'dr-meters' },
            meter('Fill', d.def.fill, `${Math.round(d.def.fill * 100)}%`),
            meter('Speed', (d.bpm - 80) / 100, `${d.bpm}${half ? ' ½' : ''}`),
            meter('Loud', d.def.loud, `${Math.round(d.def.loud * 100)}%`),
            meter('Tech', d.def.cx, `${Math.round(d.def.cx * 100)}%`))));
    }));
    if (!list.length) this.list.append(h('div', { class: 'empty-note' }, 'No drummer with that personality'));
  }

  // ------------------------------------------------------------ Technique × Loudness pad
  xyDown(e) {
    const c = this.clip;
    if (!c || e.button !== 0) return;
    e.preventDefault();
    const app = this.app, r = this.xy.getBoundingClientRect(), id = c.id;
    const at = (ev) => ({ cx: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), loud: Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height)) });
    app.drummerBegin('Drummer: Technique & Loudness');
    app.drummerLive(id, at(e));
    this.xy.setPointerCapture(e.pointerId);
    const move = (ev) => app.drummerLive(id, at(ev));
    const up = () => { this.xy.removeEventListener('pointermove', move); this.xy.removeEventListener('pointerup', up); this.xy.removeEventListener('pointercancel', up); app.drummerEnd(); };
    this.xy.addEventListener('pointermove', move); this.xy.addEventListener('pointerup', up); this.xy.addEventListener('pointercancel', up);
  }
  drawXY() {
    if (!this.xyS) return; // the Surface draws once while it is being created
    const S = this.xyS, g = S.ctx, W = S.w, H = S.h, c = this.clip;
    S.clear();
    g.fillStyle = '#121417'; g.beginPath(); g.roundRect(0, 0, W, H, 6); g.fill();
    g.strokeStyle = '#22262b'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((W * i) / 4 + 0.5, 0); g.lineTo((W * i) / 4 + 0.5, H); g.stroke(); g.beginPath(); g.moveTo(0, (H * i) / 4 + 0.5); g.lineTo(W, (H * i) / 4 + 0.5); g.stroke(); }
    if (!c) return;
    const D = drummerById(c.dr.id), accent = css('--accent') || '#ff8f3c';
    // the drummer's natural spot
    const nx = D.def.cx * W, ny = (1 - D.def.loud) * H;
    g.strokeStyle = D.color; g.globalAlpha = 0.5; g.setLineDash([3, 3]); g.beginPath(); g.arc(nx, ny, 9, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    const x = c.dr.cx * W, y = (1 - c.dr.loud) * H;
    const grd = g.createRadialGradient(x, y, 0, x, y, 40); grd.addColorStop(0, 'rgba(255,143,60,0.28)'); grd.addColorStop(1, 'rgba(255,143,60,0)');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.fillStyle = accent; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#1a0f05'; g.lineWidth = 2; g.stroke();
  }

  // ------------------------------------------------------------ groove preview (one bar)
  previewBar() {
    const c = this.clip, app = this.app;
    if (!c) return 0;
    const bar = barBeats(app.p), n = Math.max(1, Math.ceil(c.length / bar - 1e-9));
    const pos = app.isPlaying ? app.engine.position : app.ui.cursor;
    const b = Math.floor((pos - c.start) / bar);
    return b >= 0 && b < n ? b : 0;
  }
  drawPreview(force = false) {
    const S = this.previewS, c = this.clip, app = this.app;
    if (!S || !c || S.w < 10) return;
    const bar = barBeats(app.p), b = this.previewBar();
    const key = JSON.stringify(c.dr) + c.length + '|' + bar + '|' + b + '|' + S.w;
    if (!force && key === this.previewKey) return;
    this.previewKey = key;
    if (!this.hitsCache || this.hitsCache.key !== JSON.stringify(c.dr) + c.length + '|' + bar) this.hitsCache = { key: JSON.stringify(c.dr) + c.length + '|' + bar, hits: generateDrummer(c.dr, c.length, bar) };
    const hits = this.hitsCache.hits.filter((x) => x.s >= b * bar - 1e-9 && x.s < (b + 1) * bar - 1e-9);
    const g = S.ctx, W = S.w, H = S.h, LW = 38, rh = H / ROWS.length, steps = Math.round(bar * 4), sw = (W - LW) / steps;
    S.clear();
    g.fillStyle = '#121417'; g.fillRect(0, 0, W, H);
    for (let s = 0; s < steps; s++) { g.fillStyle = s % 4 === 0 ? '#1d2126' : '#171a1e'; g.fillRect(LW + s * sw + 0.5, 0, sw - 1, H); }
    g.font = '600 9px var(--font-ui, sans-serif)'; g.textBaseline = 'middle';
    ROWS.forEach((r, i) => { g.fillStyle = '#7d8590'; g.fillText(r.name.toUpperCase(), 4, i * rh + rh / 2); if (i) { g.fillStyle = '#0d0f11'; g.fillRect(0, i * rh, W, 1); } });
    const D = drummerById(c.dr.id);
    for (const x of hits) {
      const row = ROW_OF[x.k];
      if (row < 0) continue;
      const t = x.s - b * bar, px = LW + (t / bar) * (W - LW);
      g.globalAlpha = 0.3 + 0.7 * x.v;
      g.fillStyle = PIECES[x.k].id === 'ohh' || PIECES[x.k].id === 'clap' || PIECES[x.k].id === 'crash' ? '#ffd2ad' : D.color;
      if (PIECES[x.k].id.startsWith('riser')) g.fillRect(px, row * rh + rh - 4, Math.min(W - px, ((x.l / bar) * (W - LW))), 3);
      else { g.beginPath(); g.roundRect(px + 1, row * rh + 3, Math.max(3, sw * 0.42), rh - 6, 2); g.fill(); }
    }
    g.globalAlpha = 1;
    const n = Math.max(1, Math.ceil(c.length / bar - 1e-9));
    this.previewInfo.textContent = `bar ${b + 1} of ${n}`;
    this.previewBarIdx = b;
  }

  // ------------------------------------------------------------ refresh
  refresh(d) {
    const app = this.app;
    const target = this.pickTarget();
    const changed = target !== this.trackId;
    this.trackId = target;
    if (changed && target) app.engine.setScope(target);
    const t = this.track, c = this.clip;
    this.placeholder.style.display = t ? 'none' : '';
    this.flow.style.display = t && c ? '' : 'none';
    this.noRegion.style.display = t && !c ? '' : 'none';
    if (!t) return;
    if (d && d.transient && d.scope === 'inst-param' && !changed) return; // a kit knob is moving; it already shows its value
    this.trackPill.replaceChildren(h('span', { class: 'pill-dot', style: { background: t.color } }), t.name);
    const bar = barBeats(app.p);
    const regions = t.clips.filter((x) => x.kind === 'drummer').sort((a, b) => a.start - b.start);
    this.regionSel.replaceChildren(...regions.map((r) => h('option', { value: r.id }, `${r.name} · bars ${Math.floor(r.start / bar) + 1}–${Math.ceil((r.start + r.length) / bar - 1e-9)}`)));
    this.regionSel.value = c ? c.id : '';
    this.regionSel.disabled = !regions.length;
    // kit
    const p = t.instrument.params;
    this.kitSel.value = String(Math.round(p.kit));
    this.kitDesc.textContent = KITS[Math.round(p.kit)] ? KITS[Math.round(p.kit)].desc : '';
    for (const [pid, ctl] of this.kitControls) { ctl.set(p[pid]); ctl.auto(app.hasAutomation(t.id, 'inst:' + pid)); }
    if (!c) return;
    const D = drummerById(c.dr.id);
    this.tempoBtn.textContent = `Use ${D.bpm} BPM`;
    this.tempoBtn.style.display = Math.abs(app.p.tempo - D.bpm) < 0.5 ? 'none' : '';
    this.fillK.knob.def.def = D.def.fill; this.swingK.knob.def.def = D.def.swing; this.feelK.knob.def.def = D.def.feel; this.humK.knob.def.def = D.def.hum;
    this.fillK.set(c.dr.fill); this.swingK.set(c.dr.swing); this.feelK.set(c.dr.feel); this.humK.set(c.dr.hum);
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === c.dr.speed));
    for (const r of this.partRows) {
      const st = c.dr.parts[r.part.id];
      r.pw.classList.toggle('on', st.on); r.row.classList.toggle('off', !st.on);
      r.vars.forEach((b, i) => b.classList.toggle('on', i === st.v));
    }
    const pct = (v) => `${Math.round(v * 100)}%`;
    this.xyInfo.replaceChildren(h('span', null, 'Technique ', h('b', null, pct(c.dr.cx))), h('span', null, 'Loudness ', h('b', null, pct(c.dr.loud))),
      h('span', { class: 'dr-who', style: { color: D.color } }, `${D.name} · ${D.genre}`));
    this.drawXY();
    this.renderLibrary();
    this.drawPreview();
  }

  frame() {
    if (!this.trackId || this.el.offsetParent === null) return;
    const te = this.app.engine.padTele;
    if (te) {
      for (const [k, el] of this.lights) { const v = Math.min(1, te[4 + k] || 0); el.style.opacity = String(0.18 + 0.82 * v); }
      for (let k = 0; k < this.padEls.length; k++) { const v = Math.min(1, te[4 + k] || 0); this.padEls[k].style.setProperty('--hit', v.toFixed(3)); }
    }
    // follow the playhead through the region's bars, and draw where it is
    const c = this.clip;
    if (!c) return;
    this.drawPreview();
    const app = this.app;
    if (app.isPlaying) {
      const bar = barBeats(app.p), pos = app.engine.position - c.start - this.previewBarIdx * bar;
      if (pos >= 0 && pos < bar) {
        const S = this.previewS, g = S.ctx, LW = 38, x = LW + (pos / bar) * (S.w - LW);
        this.drawPreview(true);
        g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(x, 0, 1.5, S.h);
      }
    }
  }
}
