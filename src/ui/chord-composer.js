// CHORD COMPOSER (the COMPOSE tab of the Session Pianist): write a progression
// by key, mood and genre, edit chords, hear alternatives, then hand it to the
// pianist or drop it into the song as MIDI chords.

import { h } from './dom.js';
import { Knob, selectEl, promptText } from './widgets.js';
import { KEY_NAMES, parseChord, chordName, newSeed } from '../shared/pianist.js';
import { MOODS, GENRES, RHYTHMS, EDIT_QUALITIES, FORMS, SECTION_NAMES, generateProgression, alternatives, extend, simplify, withInversions, moreComplex, transpose, editChord, voiceProgression } from '../shared/composer.js';
import { barBeats } from '../core/project.js';

const BLACK = [1, 3, 6, 8, 10];
const LENS = [[1, '1 beat'], [2, '2 beats'], [3, '3 beats'], [4, '4 beats'], [6, '6 beats'], [8, '8 beats'], [12, '12 beats'], [16, '16 beats']];

export class ChordComposer {
  constructor(app, editor) { this.app = app; this.ed = editor; this.build(); }
  get C() { return this.app.p.composer; }
  set(patch, label) { this.app.composerSet(patch, label); }
  setChords(chords, label, extra = {}) { this.set({ chords, ...extra }, label); }

  build() {
    const app = this.app, opt = (a) => a.map(([v, l]) => ({ value: String(v), label: l }));
    const card = (t, cls, ...b) => this.ed.card(t, cls, ...b);
    // ---- settings
    this.keySel = selectEl(opt(KEY_NAMES.map((k, i) => [i, k])), '7', (v) => { const C = this.C, t = transpose(C.chords, C.key, C.minor, ((+v - C.key + 18) % 12) - 6); this.setChords(t.chords, `Key: ${KEY_NAMES[+v]}`, { key: t.key }); }, 'sel-sm', 'Key (changing it transposes the chords)');
    this.majBtn = h('button', { class: 'seg-btn', onClick: () => this.set({ minor: false }, 'Major') }, 'Major');
    this.minBtn = h('button', { class: 'seg-btn', onClick: () => this.set({ minor: true }, 'Minor') }, 'Minor');
    this.genreSel = selectEl(opt(GENRES), 'worship', (v) => this.set({ genre: v }, 'Genre'), 'sel-sm', 'Genre');
    this.moodSel = selectEl(opt(MOODS.map((m) => [m, m])), 'Worshipful', (v) => this.set({ mood: v }, 'Mood'), 'sel-sm', 'Mood');
    this.barsSel = selectEl(opt([2, 4, 8, 12, 16].map((n) => [n, `${n} bars`])), '4', (v) => this.set({ bars: +v }, 'Measures'), 'sel-sm', 'Number of measures');
    this.hrSel = selectEl(opt(RHYTHMS), '1', (v) => this.set({ hr: +v }, 'Harmonic rhythm'), 'sel-sm', 'Harmonic rhythm: how often the chord changes');
    this.sigSel = selectEl(opt([['4/4', '4/4'], ['3/4', '3/4'], ['6/8', '6/8'], ['2/4', '2/4']]), '4/4', (v) => { const [n, d] = v.split('/').map(Number); app.setSignature(n, d); }, 'sel-sm', 'Time signature (the project\'s)');
    this.cxK = new Knob({ def: { id: 'cx', name: 'Complexity', min: 0, max: 1, def: 0.4, curve: 'lin', skew: 1, unit: '%', options: null, automatable: false, short: 'Complexity', bipolar: false },
      size: 34, onInput: (v) => { this.cx = v; }, onEnd: () => this.set({ cx: this.cx }, 'Complexity') });
    const lab = (t) => h('span', { class: 'dr-hdr-label' }, t);
    const settings = card('CHORD COMPOSER', 'cc-set',
      h('div', { class: 'pn-row' }, lab('Key'), this.keySel, h('div', { class: 'seg' }, this.majBtn, this.minBtn), lab('Genre'), this.genreSel, lab('Mood'), this.moodSel),
      h('div', { class: 'pn-row' }, lab('Length'), this.barsSel, this.hrSel, lab('Time'), this.sigSel, this.cxK.el,
        h('button', { class: 'btn primary', title: 'Write a new progression from these settings (press again for another)', onClick: () => this.generate() }, 'Generate')));
    // ---- progression
    this.strip = h('div', { class: 'cc-strip' });
    const tool = (label, title, fn) => h('button', { class: 'btn ghost sm', title, onClick: fn }, label);
    const op = (fn, label) => () => { const C = this.C; this.setChords(fn(C.chords, C.key, C.minor), label); };
    this.progCard = card('PROGRESSION', 'cc-prog', this.strip,
      h('div', { class: 'pn-row' },
        tool('▶ Play', 'Hear the whole progression on this piano', () => this.play()),
        tool('Extensions', 'Add 7ths, 9ths and 13ths', op(extend, 'Add extensions')),
        tool('Inversions', 'Slash chords for a stepwise bass line', op(withInversions, 'Add inversions')),
        tool('Simplify', 'Back to plain triads', op(simplify, 'Simplify chords')),
        tool('More complex', 'Extensions and inversions together', op(moreComplex, 'More complex')),
        tool('− ½', 'Transpose down a semitone', () => this.shift(-1)), tool('+ ½', 'Transpose up a semitone', () => this.shift(1)),
        tool('Save', 'Save this progression with the project', () => this.save())),
      h('div', { class: 'pn-row' },
        h('button', { class: 'btn primary sm', title: 'Give these chords to the Session Pianist at the cursor\'s bar (it plays them in its personality and style)', onClick: () => this.insert(false) }, 'Generate piano part'),
        h('button', { class: 'btn ghost sm', title: 'Insert the chords as an ordinary MIDI clip at the cursor\'s bar', onClick: () => this.insert(true) }, 'Insert as MIDI chords')));
    // ---- selected chord
    const pcs = (none) => opt([...(none ? [['-1', '— (root)']] : []), ...KEY_NAMES.map((k, i) => [i, k])]);
    this.rootSel = selectEl(pcs(false), '0', (v) => this.editSel({ root: +v }), 'sel-sm', 'Root');
    this.qualSel = h('select', { class: 'sel sel-sm', title: 'Quality and extensions' });
    this.qualSel.addEventListener('change', () => this.editSel({ suf: this.qualSel.value }));
    this.bassSel = selectEl(pcs(true), '-1', (v) => this.editSel({ bass: +v < 0 ? null : +v }), 'sel-sm', 'Bass note (inversion / slash chord)');
    this.lenSel = selectEl(opt(LENS), '4', (v) => { const C = this.C, ch = C.chords.map((c) => [...c]); if (ch[C.sel]) { ch[C.sel][1] = +v; this.setChords(ch, 'Chord length'); } }, 'sel-sm', 'How long the chord lasts');
    this.kb = h('div', { class: 'pn-keys cc-keys' });
    this.kbKeys = new Map();
    let white = 0;
    for (let p = 36; p <= 84; p++) {
      const black = BLACK.includes(p % 12);
      const el = h('div', { class: 'pn-key ' + (black ? 'blk' : 'wht'), style: black ? { left: `calc(${white} * var(--pn-w) - var(--pn-w) * 0.3)` } : {} });
      if (!black) white++;
      if (p % 12 === 0) el.append(h('span', null, 'C' + (p / 12 - 1)));
      this.kbKeys.set(p, el); this.kb.append(el);
    }
    this.kb.style.setProperty('--pn-n', white);
    this.alts = h('div', { class: 'dr-chips cc-alts' });
    this.chordCard = card('CHORD', 'cc-chord-card',
      h('div', { class: 'pn-row' }, this.rootSel, this.qualSel, lab('Bass'), this.bassSel, this.lenSel,
        tool('▶', 'Hear this chord', () => this.play(this.C.sel)),
        tool('Duplicate', 'Repeat this chord after itself', () => { const C = this.C, ch = C.chords.map((c) => [...c]); ch.splice(C.sel + 1, 0, [...ch[C.sel]]); this.setChords(ch, 'Duplicate chord', { sel: C.sel + 1 }); }),
        tool('Delete', 'Remove this chord', () => { const C = this.C; if (C.chords.length < 2) return; const ch = C.chords.filter((_, i) => i !== C.sel); this.setChords(ch, 'Delete chord', { sel: Math.min(C.sel, ch.length - 1) }); })),
      this.kb, h('div', { class: 'dr-sub' }, 'ALTERNATIVES — click to swap in and hear it'), this.alts);
    this.savedList = h('div', { class: 'cc-saved' });
    const saved = card('SAVED PROGRESSIONS', 'cc-saved-card', this.savedList);
    // ---- song form → a complete piano part
    this.formSel = selectEl([{ value: '', label: 'Choose a form…' }, ...FORMS.map(([n], i) => ({ value: String(i), label: n }))], '', (v) => { if (v !== '') this.set({ form: FORMS[+v][1].map((x) => [...x]) }, 'Song form'); this.formSel.value = ''; }, 'sel-sm', 'Start from a common song form');
    this.formList = h('div', { class: 'cc-form' });
    const form = card('SONG FORM', 'cc-form-card', h('div', { class: 'pn-row' }, this.formSel,
      tool('+ Section', 'Add a section at the end', () => { const f = this.C.form.map((x) => [...x]); f.push(['Chorus', 8]); this.set({ form: f }, 'Add section'); })),
      this.formList,
      h('button', { class: 'btn primary sm', title: 'One pianist part per section at the cursor\'s bar, with section markers: sparse verses, moving pre-choruses, full choruses, a building bridge, a gentle outro', onClick: () => { if (this.ed.trackId) this.app.generateSongPart(this.ed.trackId); } }, 'Generate full piano part'),
      h('div', { class: 'card-note' }, 'Uses the progression above (the bridge gets new harmony, the outro comes home). Re-roll any section with New take or Variation, or Keep it as MIDI.'));
    this.el = h('div', { class: 'wp-flow dr-flow' }, h('div', { class: 'dr-col pn-col' }, settings, this.progCard, this.chordCard), h('div', { class: 'dr-col pn-whocol' }, form, saved));
  }

  generate() {
    const C = this.C, seed = newSeed();
    const chords = generateProgression({ ...C, barLen: barBeats(this.app.p) }, seed);
    if (chords) { this.setChords(chords, 'Generate progression', { seed, sel: 0 }); this.play(); }
  }
  shift(n) { const C = this.C, t = transpose(C.chords, C.key, C.minor, n); this.setChords(t.chords, 'Transpose', { key: t.key }); }
  editSel(change) {
    const C = this.C, ch = C.chords.map((c) => [...c]);
    if (!ch[C.sel]) return;
    ch[C.sel][0] = editChord(ch[C.sel][0], C.key, C.minor, change);
    this.setChords(ch, 'Edit chord'); this.play(C.sel);
  }
  async save() {
    const C = this.C, name = await promptText('Save progression', `${C.mood} in ${KEY_NAMES[C.key]}${C.minor ? ' minor' : ''}`);
    if (name) this.set({ saved: [...C.saved, { name, key: C.key, minor: C.minor, chords: C.chords.map((c) => [...c]) }] }, 'Save progression');
  }
  insert(asMidi) { if (this.ed.trackId) { this.app.composerInsert(this.ed.trackId, asMidi); if (!asMidi) { this.ed.tab = 'jam'; this.ed.refresh(); } } }
  play(only = null) {
    const C = this.C, vs = voiceProgression(C.chords, C.key, C.minor);
    const items = C.chords.map(([, d], i) => ({ notes: vs[i].bass != null ? [vs[i].bass, ...vs[i].rh] : [], d: only == null ? d : 3 }));
    if (this.ed.trackId) this.app.auditionChords(this.ed.trackId, only == null ? items : [items[only]].filter(Boolean));
  }

  refresh() {
    const C = this.C, app = this.app;
    this.keySel.value = String(C.key); this.majBtn.classList.toggle('on', !C.minor); this.minBtn.classList.toggle('on', C.minor);
    this.genreSel.value = C.genre; this.moodSel.value = C.mood; this.barsSel.value = String(C.bars); this.hrSel.value = String(C.hr);
    this.sigSel.value = `${app.p.sigNum}/${app.p.sigDen}`; this.cxK.set(C.cx); this.cx = C.cx;
    const sel = Math.min(C.sel, C.chords.length - 1);
    this.strip.replaceChildren(...C.chords.map(([s, d], i) => h('button', { class: 'cc-chord' + (i === sel ? ' on' : ''), style: { flex: `${d} 1 0` }, title: `${s} · ${d} beat${d === 1 ? '' : 's'}`,
      onClick: () => { if (i !== C.sel) this.set({ sel: i }, 'Select chord'); this.play(i); } }, h('b', null, s), h('span', null, `${d}`))),
    h('button', { class: 'cc-chord cc-add', title: 'Add a chord at the end', onClick: () => this.setChords([...C.chords, [...C.chords[C.chords.length - 1] || ['C', 4]]], 'Add chord', { sel: C.chords.length }) }, '+'));
    const cur = C.chords[sel], ch = cur ? parseChord(cur[0], C.key, C.minor) : null;
    this.chordCard.style.display = ch ? '' : 'none';
    if (!ch) return;
    this.rootSel.value = String(ch.root); this.bassSel.value = String(ch.bass == null ? -1 : ch.bass); this.lenSel.value = String(cur[1]);
    const qs = EDIT_QUALITIES.includes(ch.suf) ? EDIT_QUALITIES : [ch.suf, ...EDIT_QUALITIES];
    this.qualSel.replaceChildren(...qs.map((q) => h('option', { value: q }, chordName({ root: ch.root, suf: q, bass: null }, C.key, C.minor))));
    this.qualSel.value = ch.suf;
    const v = voiceProgression(C.chords, C.key, C.minor)[sel], on = new Set([v.bass, ...v.rh]);
    for (const [p, el] of this.kbKeys) el.classList.toggle('on', on.has(p));
    this.alts.replaceChildren(...alternatives(C.chords, sel, C.key, C.minor).map((a) => h('button', { class: 'pill dr-chip', title: a.why,
      onClick: () => { const c2 = C.chords.map((c) => [...c]); c2[sel][0] = a.sym; this.setChords(c2, `Chord → ${a.sym}`); this.play(sel); } }, a.sym)));
    const bars = [2, 4, 8, 12, 16].map((n) => ({ value: String(n), label: `${n} bars` }));
    this.formList.replaceChildren(...C.form.map(([name, n], i) => h('div', { class: 'cc-saved-row' },
      selectEl(SECTION_NAMES.map((x) => ({ value: x, label: x })), name, (v) => { const f = C.form.map((x) => [...x]); f[i][0] = v; this.set({ form: f }, 'Section'); }, 'sel-sm'),
      selectEl(bars, String(n), (v) => { const f = C.form.map((x) => [...x]); f[i][1] = +v; this.set({ form: f }, 'Section length'); }, 'sel-sm'),
      h('button', { class: 'btn ghost sm', title: 'Remove section', onClick: () => this.set({ form: C.form.filter((_, k) => k !== i) }, 'Remove section') }, '✕'))));
    this.savedList.replaceChildren(...(C.saved.length ? C.saved.map((s, i) => h('div', { class: 'cc-saved-row' },
      h('button', { class: 'btn ghost sm', title: s.chords.map((c) => c[0]).join(' – '), onClick: () => this.set({ key: s.key, minor: s.minor, chords: s.chords.map((c) => [...c]), sel: 0 }, `Load ${s.name}`) }, s.name),
      h('span', { class: 'cc-saved-ch' }, s.chords.map((c) => c[0]).join(' ')),
      h('button', { class: 'btn ghost sm', title: 'Delete', onClick: () => this.set({ saved: C.saved.filter((_, k) => k !== i) }, 'Delete saved progression') }, '✕')))
      : [h('div', { class: 'card-note' }, 'Saved progressions are kept with the project.')]));
  }
}
