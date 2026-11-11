// Session Pianist editor (Instrument tab of a piano track).
// PLAY: choose the piano, shape its physical model, play it from the
//       on-screen keyboard, a MIDI keyboard or the computer keyboard.
// JAM:  a virtual pianist (personality × style) accompanies a chord
//       progression on the project transport, in sync with the Drummer.
// COMPOSE: the Chord Composer (chord-composer.js).

import { h } from './dom.js';
import { Knob, contextMenu, selectEl, promptText } from './widgets.js';
import { PIANO_MODELS, PIANO_DEF } from '../shared/piano-params.js';
import { PIANISTS, STYLES, KEY_NAMES, pianistById, parseProgression, chordName } from '../shared/pianist.js';
import { findTrack, isPianoTrack, barBeats } from '../core/project.js';
import { ChordComposer } from './chord-composer.js';

const KEY_LO = 36, KEY_HI = 96; // C2 – C7 on screen
const BLACK = [1, 3, 6, 8, 10];
const TABS = ['play', 'jam', 'compose'];
const def = (id, name, min, max, d, unit, short) => ({ id, name, min, max, def: d, curve: 'lin', skew: 1, unit, options: null, automatable: false, short, bipolar: min < 0 && max > 0 });
const JAM_KNOBS = [
  ['cx', 'Complexity', 0.5, 'Complexity'], ['energy', 'Energy', 0.5, 'Energy'], ['density', 'Busy ↔ Sparse (right = busier)', 0.45, 'Busy'],
  ['hum', 'Human Feel (0 = clean)', 0.4, 'Human'], ['swing', 'Swing', 0, 'Swing'], ['dyn', 'Dynamics', 0.5, 'Dynamics'],
  ['emb', 'Embellishment', 0.5, 'Embellish'], ['impro', 'Improvisation', 0.3, 'Improvise'], ['fill', 'Fill Frequency', 0.4, 'Fills'], ['voices', 'Chord Density', 0.5, 'Voices'],
];

export class PianoEditor {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.trackId = null; this.tab = 'play';
    this.controls = new Map(); this.jamKnobs = new Map();
    this.keyEls = new Map();
    this.down = new Map(); // pointerId → pitch
    this.chordKey = ''; this.lastChord = '';
    this.build();
    app.addEventListener('note', (e) => { const el = this.keyEls.get(e.detail.pitch); if (el) el.classList.toggle('on', e.detail.on); });
    app.addEventListener('pedal', () => this.pedalBtn.classList.toggle('on', !!app.sustain));
  }

  pickTarget() { const t = this.app.selectedTrack; return isPianoTrack(t) ? t.id : null; }
  get track() { return findTrack(this.app.p, this.trackId); }
  get clip() { return this.trackId ? this.app.pianistTarget(this.trackId) : null; }

  card(title, cls, ...body) {
    return h('div', { class: 'wp-card dr-panel ' + (cls || '') }, h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, title)), ...body);
  }
  knob(pid, size = 34) {
    const app = this.app, d = PIANO_DEF[pid];
    const k = new Knob({
      def: d, size, label: d.short,
      onBegin: () => app.pianoBegin(`Change ${d.name}`),
      onInput: (v) => { if (this.trackId) app.pianoLive(this.trackId, pid, v); },
      onEnd: () => app.pianoEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(this.trackId, 'inst:' + pid, () => app.setPianoParam(this.trackId, pid, d.def))),
    });
    this.controls.set(pid, { set: (v) => k.set(v), auto: (a) => k.setAutomated(a) });
    return k.el;
  }
  jamKnob(key, d) {
    const app = this.app;
    const k = new Knob({
      def: d, size: 34, label: d.short,
      onBegin: () => { if (this.clip) app.pianistBegin(`Pianist: ${d.name}`); },
      onInput: (v) => { const c = this.clip; if (c) app.pianistLive(c.id, { [key]: v }); },
      onEnd: () => app.pianistEnd(),
    });
    this.jamKnobs.set(key, k);
    return k.el;
  }

  build() {
    const app = this.app;
    this.trackPill = h('div', { class: 'sf-track-pill' });
    this.pedalBtn = h('button', { class: 'btn ghost sm pn-pedal', title: 'Sustain pedal (also MIDI CC64). Lifts the dampers so the strings ring and resonate together.',
      onClick: () => app.setSustain(!app.sustain) }, 'Sustain pedal');
    this.tabBtns = TABS.map((t) => h('button', { class: 'seg-btn', onClick: () => { this.tab = t; this.refresh(); } }, t.toUpperCase()));
    const header = h('div', { class: 'sf-header dr-header' },
      h('div', { class: 'sf-logo dr-logo' }, h('span', { class: 'dr-logo-mark pn-mark' }), h('b', null, 'SESSION PIANIST'), h('span', null, 'physically modelled piano')),
      this.trackPill, h('div', { class: 'seg' }, ...this.tabBtns), h('div', { class: 'tb-spacer' }), this.pedalBtn);

    // ================= PLAY
    this.modelBtns = PIANO_MODELS.map((m, i) => h('button', { class: 'pill dr-chip', title: m.desc, onClick: () => { if (this.trackId) app.setPianoParam(this.trackId, 'model', i); } }, m.name));
    this.modelDesc = h('div', { class: 'card-note' });
    this.presetSel = h('select', { class: 'sel sel-sm', title: 'My piano presets (saved in this app, available in every project)' });
    this.presetSel.addEventListener('change', () => { if (this.trackId && this.presetSel.value) app.loadPianoPreset(this.trackId, this.presetSel.value); });
    const piano = this.card('PIANO', 'pn-models', h('div', { class: 'dr-chips' }, ...this.modelBtns), this.modelDesc,
      h('div', { class: 'pn-row' }, h('span', { class: 'dr-hdr-label' }, 'My presets'), this.presetSel,
        h('button', { class: 'btn ghost sm', title: 'Save the current sound as a preset', onClick: async () => { const t = this.track; if (!t) return; const n = await promptText('Save piano preset', t.instrument.preset === PIANO_MODELS[Math.round(t.instrument.params.model)].name ? `My ${t.instrument.preset}` : t.instrument.preset); if (n) app.savePianoPreset(t.id, n.trim()); } }, 'Save'),
        h('button', { class: 'btn ghost sm', title: 'Delete the chosen preset', onClick: () => { if (this.presetSel.value) app.deletePianoPreset(this.presetSel.value); } }, 'Delete')));
    const grp = (title, ...knobs) => h('div', { class: 'dr-kgrp' }, h('div', { class: 'dr-sub' }, title), h('div', { class: 'knob-row' }, ...knobs));
    const sound = this.card('SOUND', 'pn-sound', h('div', { class: 'dr-kgrid' },
      grp('HAMMERS & TOUCH', this.knob('hard'), this.knob('dyn'), this.knob('mech')),
      grp('STRINGS', this.knob('bright'), this.knob('sustain'), this.knob('tuning'), this.knob('sres')),
      grp('BODY & SPACE', this.knob('warmth'), this.knob('sbres'), this.knob('width'), this.knob('room')),
      grp('OUTPUT', this.knob('pedal'), this.knob('level'))));
    this.keys = h('div', { class: 'pn-keys' });
    let white = 0;
    for (let p = KEY_LO; p <= KEY_HI; p++) {
      const black = BLACK.includes(p % 12);
      const el = h('div', { class: 'pn-key ' + (black ? 'blk' : 'wht'), style: black ? { left: `calc(${white} * var(--pn-w) - var(--pn-w) * 0.3)` } : {} });
      if (!black) white++;
      if (p % 12 === 0) el.append(h('span', null, 'C' + (p / 12 - 1)));
      el.dataset.p = p;
      this.keyEls.set(p, el);
      this.keys.append(el);
    }
    this.keys.style.setProperty('--pn-n', white);
    this.keys.addEventListener('pointerdown', (e) => this.keyDown(e));
    this.keys.addEventListener('pointermove', (e) => { if (this.down.has(e.pointerId)) this.keyDown(e, true); });
    const up = (e) => this.keyUp(e.pointerId);
    this.keys.addEventListener('pointerup', up); this.keys.addEventListener('pointercancel', up); this.keys.addEventListener('lostpointercapture', up);
    const play = this.card('PLAY', 'pn-play', this.keys,
      h('div', { class: 'card-note' }, 'Click or drag on the keys (lower on a key plays harder). A MIDI keyboard with velocity and a sustain pedal (CC64) plays it too.'));
    this.playView = h('div', { class: 'wp-flow dr-flow' }, h('div', { class: 'dr-col' }, piano, sound), h('div', { class: 'dr-col pn-col' }, play));

    // ================= JAM
    this.jamBtn = h('button', { class: 'btn primary pn-jam', title: 'Start / stop: the pianist loops this part on the transport (the Drummer plays along in sync)', onClick: () => { if (this.trackId) app.jam(this.trackId); } }, 'JAM');
    this.nowEl = h('b', { class: 'pn-now' }, '—'); this.nextEl = h('span', { class: 'pn-next' }, '');
    this.keySel = selectEl(KEY_NAMES.map((k, i) => ({ value: String(i), label: k })), '7', (v) => this.set({ key: +v }, 'Pianist key'), 'sel-sm', 'Key');
    this.majBtn = h('button', { class: 'seg-btn', onClick: () => this.set({ minor: false }, 'Pianist: major') }, 'Major');
    this.minBtn = h('button', { class: 'seg-btn', onClick: () => this.set({ minor: true }, 'Pianist: minor') }, 'Minor');
    this.progIn = h('input', { class: 'text-input pn-prog', spellcheck: false, placeholder: 'G D/F# Em7 Cadd9   (one chord per bar; "C,G" splits a bar; I V vi IV works too)' });
    this.progIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.progIn.blur(); });
    this.progIn.addEventListener('change', () => this.set({ prog: this.progIn.value.trim() }, 'Pianist chords'));
    this.progInfo = h('div', { class: 'card-note' });
    const song = this.card('SONG', 'pn-song',
      h('div', { class: 'pn-row' }, this.jamBtn, h('div', { class: 'pn-chord' }, h('span', null, 'Now'), this.nowEl, h('span', null, 'Next'), this.nextEl), h('div', { class: 'tb-spacer' }),
        h('button', { class: 'btn ghost sm', title: 'Same settings, a fresh performance (new seed)', onClick: () => { const c = this.clip; if (c) app.newPianistTake(c.id); } }, 'New take'),
        h('button', { class: 'btn ghost sm', title: 'Keep the voicings and rhythm, vary the embellishments, melody and feel', onClick: () => { const c = this.clip; if (c) app.setPianist(c.id, { var: (c.pn.var || 0) + 1 }, 'Pianist variation'); } }, 'Variation'),
        h('button', { class: 'btn ghost sm', title: 'Keep this performance as an ordinary MIDI clip you can edit note by note', onClick: () => { const c = this.clip; if (c) app.pianistToMidi(c.id); } }, 'Keep as MIDI')),
      h('div', { class: 'pn-row' }, h('span', { class: 'dr-hdr-label' }, 'Key'), this.keySel, h('div', { class: 'seg' }, this.majBtn, this.minBtn), this.progIn),
      this.progInfo);
    this.pianistBtns = PIANISTS.map((P) => h('button', { class: 'dr-card pn-card', title: P.blurb, onClick: () => { const c = this.clip; if (c) app.choosePianist(c.id, P.id); } },
      h('div', { class: 'dr-avatar', style: { background: P.color } }, P.short[0]), h('div', { class: 'dr-info' }, h('div', { class: 'dr-name' }, h('b', null, P.short)), h('div', { class: 'pn-blurb' }, P.blurb))));
    const who = this.card('PIANIST', 'pn-who', h('div', { class: 'pn-cards' }, ...this.pianistBtns));
    this.styleBtns = STYLES.map((S) => h('button', { class: 'pill dr-chip', onClick: () => this.set({ style: S.id }, `Pianist style: ${S.name}`) }, S.name));
    this.followBtn = h('button', { class: 'pill dr-chip', title: 'Lock left-hand accents to the Drummer\'s kicks, ease off during drum fills and follow its loudness', onClick: () => { const c = this.clip; if (c) this.set({ follow: !c.pn.follow }, 'Follow Drummer'); } }, 'Follow Drummer');
    this.bassBtn = h('button', { class: 'pill dr-chip', title: 'A bass player is in the band: the left hand stays out of the low register', onClick: () => { const c = this.clip; if (c) this.set({ bass: !c.pn.bass }, 'Bass player present'); } }, 'Bass player present');
    const hand = (k, n, sh, bip = false) => this.jamKnob(k, def(k, n, bip ? -1 : 0, 1, bip ? 0 : 0.5, bip ? 'feel' : '%', sh));
    this.followMidiBtn = h('button', { class: 'pill dr-chip', title: 'Play chords on your MIDI keyboard and the pianist follows them (the keys you hold are not played themselves). Turning it off keeps what you played as the part.', onClick: () => { if (this.trackId) app.toggleChordFollow(this.trackId, +this.winSel.value); } }, 'Follow my MIDI chords');
    this.winSel = selectEl([40, 80, 150, 250].map((v) => ({ value: String(v), label: `${v} ms` })), '80', () => {}, 'sel-sm', 'Chord detection window: how long to wait for all the notes of a chord');
    app.addEventListener('chordfollow', () => this.followMidiBtn.classList.toggle('on', !!app.chordFollow));
    const how = this.card('PLAYING', 'pn-how', h('div', { class: 'dr-chips' }, ...this.styleBtns),
      h('div', { class: 'knob-row pn-jk' }, ...JAM_KNOBS.map(([k, n, d, sh]) => this.jamKnob(k, def(k, n, 0, 1, d, '%', sh)))),
      h('div', { class: 'dr-kgrid' },
        h('div', { class: 'dr-kgrp' }, h('div', { class: 'dr-sub' }, 'LEFT HAND'), h('div', { class: 'knob-row' }, hand('lhAct', 'Left-hand activity', 'Activity'), hand('lhVel', 'Left-hand velocity', 'Velocity'), hand('lhReg', 'Left-hand register', 'Register', true))),
        h('div', { class: 'dr-kgrp' }, h('div', { class: 'dr-sub' }, 'RIGHT HAND'), h('div', { class: 'knob-row' }, hand('rhAct', 'Right-hand activity', 'Activity'), hand('rhVel', 'Right-hand velocity', 'Velocity'), hand('reg', 'Right-hand register', 'Register', true)))),
      h('div', { class: 'dr-chips' }, this.followBtn, this.bassBtn, this.followMidiBtn, this.winSel));
    this.jamView = h('div', { class: 'wp-flow dr-flow' }, h('div', { class: 'dr-col pn-col' }, song, how), h('div', { class: 'dr-col pn-whocol' }, who));

    this.composer = new ChordComposer(this.app, this);
    this.composeView = this.composer.el;
    this.placeholder = h('div', { class: 'empty-note' }, 'Select a Session Pianist track. Add one from the Browser (Instruments → Session Pianist).');
    this.el = h('div', { class: 'synth dr pn' }, header, this.playView, this.jamView, this.composeView, this.placeholder);
  }

  set(patch, label) {
    const c = this.clip;
    if (c) this.app.setPianist(c.id, patch, label);
    else if (this.trackId) { const id = this.app.createPianistRegion(this.trackId, 0); if (id) this.app.setPianist(id, patch, label); }
  }

  keyDown(e, moving = false) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const p = el && el.dataset && el.dataset.p ? +el.dataset.p : (el && el.parentElement && el.parentElement.dataset.p ? +el.parentElement.dataset.p : null);
    const prev = this.down.get(e.pointerId);
    if (p == null || p === prev) return;
    const t = this.track;
    if (!t) return;
    if (!moving) this.keys.setPointerCapture(e.pointerId);
    if (prev != null) this.app.noteOff(prev, [t]);
    const r = this.keyEls.get(p).getBoundingClientRect();
    const vel = Math.min(1, Math.max(0.15, 0.2 + 0.8 * (e.clientY - r.top) / r.height));
    this.down.set(e.pointerId, p);
    this.app.noteOn(p, vel, [t]);
  }
  keyUp(id) {
    const p = this.down.get(id);
    if (p == null) return;
    this.down.delete(id);
    const t = this.track;
    if (t) this.app.noteOff(p, [t]);
  }

  refresh(d) {
    const app = this.app, target = this.pickTarget(), changed = target !== this.trackId;
    this.trackId = target;
    if (changed && target) app.engine.setScope(target);
    const t = this.track;
    if (changed && t && t.clips.some((c) => c.kind === 'pianist') && app.ui.editClip && t.clips.some((c) => c.id === app.ui.editClip)) this.tab = 'jam';
    this.placeholder.style.display = t ? 'none' : '';
    this.playView.style.display = t && this.tab === 'play' ? '' : 'none';
    this.jamView.style.display = t && this.tab === 'jam' ? '' : 'none';
    this.composeView.style.display = t && this.tab === 'compose' ? '' : 'none';
    this.tabBtns.forEach((b, i) => b.classList.toggle('on', TABS[i] === this.tab));
    if (!t) return;
    if (this.tab === 'compose' && !(d && d.transient)) this.composer.refresh();
    if (d && d.transient && (d.scope === 'inst-param' || d.scope === 'clips') && !changed) return; // a knob is moving; it already shows its value
    this.trackPill.replaceChildren(h('span', { class: 'pill-dot', style: { background: t.color } }), t.name);
    const p = t.instrument.params, mi = Math.round(p.model);
    this.modelBtns.forEach((b, i) => b.classList.toggle('on', i === mi));
    this.modelDesc.textContent = PIANO_MODELS[mi] ? PIANO_MODELS[mi].desc : '';
    const mine = app.pianoPresets;
    this.presetSel.replaceChildren(h('option', { value: '' }, mine.length ? '— choose —' : '(none saved yet)'), ...mine.map((x) => h('option', { value: x.name }, x.name)));
    this.presetSel.value = mine.some((x) => x.name === t.instrument.preset) ? t.instrument.preset : '';
    for (const [pid, ctl] of this.controls) { ctl.set(p[pid]); ctl.auto(app.hasAutomation(t.id, 'inst:' + pid)); }
    this.pedalBtn.classList.toggle('on', !!app.sustain);
    // jam
    const c = this.clip, s = c ? c.pn : null;
    this.jamBtn.textContent = app.isPlaying ? 'STOP' : 'JAM';
    this.pianistBtns.forEach((b, i) => b.classList.toggle('on', !!s && PIANISTS[i].id === s.id));
    this.styleBtns.forEach((b, i) => b.classList.toggle('on', !!s && STYLES[i].id === s.style));
    this.followBtn.classList.toggle('on', !!s && s.follow); this.bassBtn.classList.toggle('on', !!s && s.bass);
    if (s) {
      this.keySel.value = String(s.key); this.majBtn.classList.toggle('on', !s.minor); this.minBtn.classList.toggle('on', s.minor);
      if (document.activeElement !== this.progIn) this.progIn.value = s.prog;
      const P = pianistById(s.id);
      for (const [k, kn] of this.jamKnobs) { if (k === 'density') kn.def.def = P.density; if (k === 'swing') kn.def.def = P.swing; kn.set(s[k]); }
      const pr = parseProgression(s.prog, s.key, s.minor, barBeats(app.p));
      const bad = s.prog.split(/[\s,|]+/).filter((x) => x && x !== '%' && x !== '.' && !/^(n\.?c\.?|_|x|-)$/i.test(x)).length - pr.segs.filter((g) => g.ch).length;
      this.progInfo.textContent = `${pr.bars} bar${pr.bars === 1 ? '' : 's'} · ${pr.segs.filter((g) => g.ch).map((g) => chordName(g.ch, s.key, s.minor)).join(' – ')}${bad > 0 ? ` · ${bad} chord${bad > 1 ? 's' : ''} not understood` : ''} · region ${Math.round(c.length / barBeats(app.p))} bars`;
    } else this.progInfo.textContent = 'Press JAM (or change anything here) to create the pianist\'s part at the start of the song.';
    this.chordKey = '';
  }

  // current and upcoming chord under the playhead
  frame() {
    if (!this.trackId || this.tab !== 'jam' || this.el.offsetParent === null) return;
    const app = this.app, c = this.clip;
    const playing = app.isPlaying;
    if (this.jamBtn.textContent !== (playing ? 'STOP' : 'JAM')) { this.jamBtn.textContent = playing ? 'STOP' : 'JAM'; this.jamBtn.classList.toggle('on', playing); }
    if (!c) return;
    const bar = barBeats(app.p), s = c.pn;
    const key = s.prog + '|' + s.key + '|' + s.minor + '|' + bar;
    if (key !== this.chordKey) { this.chordKey = key; this.prog = parseProgression(s.prog, s.key, s.minor, bar); }
    const pr = this.prog;
    if (!pr.bars) return;
    const pos = Math.max(0, (playing ? app.engine.position : app.ui.cursor) - c.start), loop = pr.bars * bar, q = pos % loop;
    let i = pr.segs.findIndex((g) => q >= g.s - 1e-6 && q < g.s + g.l - 1e-6);
    if (i < 0) i = 0;
    const now = chordName(pr.segs[i].ch, s.key, s.minor), nx = chordName(pr.segs[(i + 1) % pr.segs.length].ch, s.key, s.minor);
    if (now + nx !== this.lastChord) { this.lastChord = now + nx; this.nowEl.textContent = now; this.nextEl.textContent = nx; }
  }
}
