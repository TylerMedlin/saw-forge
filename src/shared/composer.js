// Chord Composer: rule-based songwriting help (no AI service). Progressions
// come from mood templates (Roman numerals), are coloured by genre and
// complexity, and the best of several weighted candidates wins on voice
// leading, variety and cadence. Chords are stored as symbols + beats, so the
// result is plain text the Session Pianist (and the user) can read and edit.

import { parseChord, chordName, rng, hash, newSeed, scaleOf, pianistById } from './pianist.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const MOODS = ['Worshipful', 'Hopeful', 'Emotional', 'Peaceful', 'Triumphant', 'Reflective', 'Melancholic', 'Cinematic', 'Gospel', 'Jazzy'];
export const GENRES = [['worship', 'Worship'], ['pop', 'Pop'], ['gospel', 'Gospel'], ['jazz', 'Jazz'], ['soul', 'Soul'], ['cinematic', 'Cinematic'], ['songwriter', 'Singer-Songwriter'], ['classical', 'Classical']];
export const RHYTHMS = [[2, 'One chord / 2 bars'], [1, 'One chord / bar'], [0.5, 'Two chords / bar']];
export const EDIT_QUALITIES = ['', 'm', '7', 'maj7', 'm7', 'add9', 'madd9', 'sus2', 'sus4', '7sus4', '6', 'm6', '9', 'maj9', 'm9', '11', 'm11', '13', '6/9', 'dim', 'm7b5', 'dim7', 'aug', '5'];

// [template, weight, minor?]  — numerals are read in the chosen key and tonality
const T = {
  Worshipful: [['I V vi IV', 3], ['I IV vi V', 2], ['IV I V vi', 2], ['vi IV I V', 2], ['I V/vii vi IV', 2], ['I IV I V', 1], ['IV V vi I', 1]],
  Hopeful: [['I V vi IV', 2], ['IV V iii vi', 2], ['I iii IV V', 2], ['IV I V vi', 2], ['I V IV V', 1]],
  Emotional: [['vi IV I V', 3], ['I V vi iii IV I IV V', 2], ['vi V IV V', 1], ['I iii vi IV', 2], ['IV V vi vi', 1]],
  Peaceful: [['I IV I IV', 2], ['I iii IV I', 2], ['I vi IV I', 2], ['IV I IV I', 1], ['I V/vii IV I', 1]],
  Triumphant: [['I V vi IV', 2], ['I bVII IV I', 2], ['IV V I I', 2], ['vi IV V I', 2], ['I IV V IV', 1]],
  Reflective: [['I iii vi IV', 2], ['ii V I vi', 2], ['I vi ii V', 2], ['IV iii ii I', 1], ['vi iii IV I', 1]],
  Melancholic: [['i VI III VII', 3, 1], ['i iv VI V', 2, 1], ['i VII VI V', 2, 1], ['i iv i V', 1, 1], ['vi IV I V', 2]],
  Cinematic: [['i VI III VII', 2, 1], ['i iv VI III', 2, 1], ['VI VII i i', 2, 1], ['i III VII iv', 1, 1], ['I bVI IV I', 2]],
  Gospel: [['I IV I V', 2], ['I vi ii V', 2], ['IV #iv° I/V V', 2], ['I I7 IV iv', 2], ['ii V I IV', 1]],
  Jazzy: [['ii V I vi', 3], ['I vi ii V', 2], ['iii vi ii V', 2], ['IV iv iii VI7', 1], ['I IV iii VI7', 1]],
};
const MINOR_FALLBACK = [['i VI III VII', 2, 1], ['i iv VI V', 2, 1], ['i VII VI VII', 1, 1], ['VI VII i i', 1, 1], ['i iv VII III', 1, 1]];
const RESOLVE = new Set(['Worshipful', 'Peaceful', 'Triumphant', 'Reflective', 'Gospel']);

export const SECTION_NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Instrumental', 'Outro'];
export const FORMS = [
  ['Verse · Chorus', [['Verse', 8], ['Chorus', 8]]],
  ['Worship song', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]],
  ['Pop song', [['Intro', 4], ['Verse', 8], ['Pre-Chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-Chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]],
  ['Ballad', [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Chorus', 8], ['Instrumental', 4], ['Chorus', 8], ['Outro', 4]]],
];
const normForm = (a) => (Array.isArray(a) ? a : []).filter((x) => Array.isArray(x) && SECTION_NAMES.includes(x[0])).slice(0, 32).map((x) => [x[0], clamp(Math.round(num(x[1], 8)), 1, 32)]);
export function newComposer() {
  return { key: 7, minor: false, genre: 'worship', mood: 'Worshipful', cx: 0.4, bars: 4, hr: 1, seed: 1, chords: [['G', 4], ['D', 4], ['Em', 4], ['C', 4]], sel: 0, saved: [], form: FORMS[1][1].map((x) => [...x]) };
}
const normChords = (a) => (Array.isArray(a) ? a : []).filter((c) => Array.isArray(c) && typeof c[0] === 'string').slice(0, 128).map((c) => [c[0].slice(0, 24), clamp(num(c[1], 4), 0.5, 32)]);
export function normComposer(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}, d = newComposer();
  return {
    key: ((Math.round(num(r.key, d.key)) % 12) + 12) % 12, minor: !!r.minor, genre: GENRES.some((g) => g[0] === r.genre) ? r.genre : d.genre,
    mood: MOODS.includes(r.mood) ? r.mood : d.mood, cx: clamp(num(r.cx, d.cx), 0, 1), bars: clamp(Math.round(num(r.bars, 4)), 1, 64),
    hr: RHYTHMS.some((x) => x[0] === r.hr) ? r.hr : 1, seed: Math.abs(Math.round(num(r.seed, 1))) | 0,
    chords: r.chords ? normChords(r.chords) : d.chords, sel: Math.max(0, Math.round(num(r.sel, 0))), form: r.form ? normForm(r.form) : d.form,
    saved: (Array.isArray(r.saved) ? r.saved : []).slice(0, 60).map((s) => ({ name: String((s && s.name) || 'Progression').slice(0, 60), key: num(s && s.key, 0) % 12, minor: !!(s && s.minor), chords: normChords(s && s.chords) })),
  };
}

// ----------------------------------------------------------------- chord helpers
export const chordOf = (sym, key, minor) => parseChord(sym, key, minor);
export const pcsOf = (ch) => (ch ? [...new Set([...ch.iv.map((x) => (x + ch.root) % 12), ...(ch.bass != null ? [ch.bass] : [])])] : []);
const make = (root, suf, bass, key, minor) => chordName({ root: ((root % 12) + 12) % 12, suf, bass: bass == null || bass === root ? null : ((bass % 12) + 12) % 12 }, key, minor);
// how far the voices must move from one chord to the next (pitch classes, nearest neighbour)
function vlCost(a, b) {
  if (!a || !b) return 0;
  const A = pcsOf(a), B = pcsOf(b);
  let c = 0;
  for (const p of B) { let d = 12; for (const q of A) { const x = Math.abs(p - q) % 12; d = Math.min(d, x, 12 - x); } c += d; }
  return c / B.length;
}
const FUNC = (fn) => ([0, 4, 9].includes(fn) ? 'T' : [2, 5].includes(fn) ? 'S' : [7, 11].includes(fn) ? 'D' : 'X');

// Colour a plain chord the way this genre would, more as complexity rises
function colour(ch, genre, cx, r, key) {
  if (!ch || ch.iv.length > 3 || /sus|°|o|dim|aug|\+|5/.test(ch.suf)) return ch;
  const minor = ch.iv[1] === 3, fn = (ch.root - key + 12) % 12, dom = fn === 7 && !minor, tonicish = fn === 0 || fn === 5;
  const p = (x) => r() < x;
  let suf = ch.suf;
  const any = (opts) => opts[Math.floor(r() * opts.length)];
  switch (genre) {
    case 'jazz': suf = minor ? any(cx > 0.5 ? ['m9', 'm7', 'm11'] : ['m7']) : dom ? any(cx > 0.6 ? ['13', '9', '7'] : ['7']) : any(cx > 0.5 ? ['maj9', '6/9', 'maj7'] : ['maj7', '6']); break;
    case 'gospel': if (p(0.4 + 0.6 * cx)) suf = minor ? any(['m7', 'm9', 'm11']) : dom ? any(['9', '13', '7']) : any(['maj7', 'maj9', '6/9', 'add9']); break;
    case 'soul': if (p(0.3 + 0.6 * cx)) suf = minor ? any(['m7', 'm9']) : dom ? any(['9', '7', '13']) : any(['maj7', 'maj9', '9']); break;
    case 'worship': if (p(0.2 + 0.6 * cx)) suf = minor ? any(['m7', 'm', 'madd9']) : dom ? any(['sus4', '', 'add9']) : any(tonicish ? ['add9', 'add9', 'maj7', 'sus2'] : ['add9', 'sus2']); break;
    case 'cinematic': if (p(0.2 + 0.5 * cx)) suf = minor ? any(['madd9', 'm', 'm7']) : any(['add9', 'sus2', '5']); break;
    case 'classical': if (dom && p(0.3 + 0.5 * cx)) suf = '7'; else if (fn === 2 && minor && p(0.4 * cx)) suf = 'm7'; break;
    case 'pop': if (p(0.15 + 0.4 * cx)) suf = minor ? any(['m7', 'm']) : dom ? any(['sus4', '']) : any(['add9', 'sus2', '']); break;
    default: if (p(0.4 * cx)) suf = minor ? 'm7' : any(['add9', 'sus4', '']); // songwriter
  }
  return parseChord(make(ch.root, suf, ch.bass, key, false), key, false) || ch;
}
// Turn chords into a stepwise bass line with inversions (e.g. G – D/F# – Em)
function invert(chs, key, minor, amount, r) {
  for (let i = 1; i < chs.length - 1; i++) {
    const ch = chs[i], prev = chs[i - 1], next = chs[i + 1];
    if (!ch || !prev || !next || ch.bass != null || r() > amount) continue;
    const pb = prev.bass != null ? prev.bass : prev.root, nb = next.bass != null ? next.bass : next.root;
    const step = (a, b) => { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); };
    for (const iv of [ch.iv[1], ch.iv[2]]) {
      const pc = (ch.root + iv) % 12;
      if (iv != null && step(pc, pb) <= 2 && step(pc, nb) <= 2 && step(pc, pb) + step(pc, nb) >= 2) { chs[i] = parseChord(make(ch.root, ch.suf, pc, key, minor), key, minor); break; }
    }
  }
  return chs;
}

// ----------------------------------------------------------------- generation
export function generateProgression(c, seed = newSeed()) {
  const barLen = c.barLen || 4, n = Math.max(1, Math.round(c.bars / (c.hr >= 2 ? 2 : c.hr <= 0.5 ? 0.5 : 1))), dur = barLen * (c.hr >= 2 ? 2 : c.hr <= 0.5 ? 0.5 : 1);
  let pool = (T[c.mood] || T.Worshipful).filter((t) => !!t[2] === c.minor);
  if (!pool.length) pool = c.minor ? MINOR_FALLBACK : T.Hopeful;
  let best = null, bestS = -Infinity;
  for (let k = 0; k < 8; k++) {
    const r = rng(hash(seed, k));
    let tw = 0; for (const t of pool) tw += t[1];
    let x = r() * tw, tpl = pool[0];
    for (const t of pool) { x -= t[1]; if (x <= 0) { tpl = t; break; } }
    const nums = tpl[0].split(' ');
    const seq = [];
    for (let i = 0; i < n; i++) {
      let rn = nums[i % nums.length];
      const rep = Math.floor(i / nums.length);
      // second time through: a varied phrase (substitutions keep the function)
      if (rep % 2 === 1 && r() < 0.35 + 0.3 * c.cx) rn = ({ vi: 'IV', IV: 'ii', I: 'vi', iii: 'I', V: c.minor ? 'VII' : 'V/vii', ii: 'IV', i: 'VI', VI: 'iv', VII: 'V' })[rn] || rn;
      seq.push(rn);
    }
    if (RESOLVE.has(c.mood) && n >= 8) seq[n - 1] = c.minor ? 'i' : 'I'; // longer phrases come home
    if (n >= 8 && r() < 0.5) seq[n / 2 - 1 | 0] = c.minor ? 'V' : 'V'; // half cadence at the middle
    let chs = seq.map((rn) => colour(parseChord(rn, c.key, c.minor), c.genre, c.cx, r, c.key));
    chs = invert(chs, c.key, c.minor, ['classical', 'worship', 'gospel'].includes(c.genre) ? 0.25 + 0.6 * c.cx : 0.4 * c.cx, r);
    // passing chords: a secondary dominant leading into the next chord
    const out = [];
    chs.forEach((ch, i) => {
      const nx = chs[i + 1];
      if (nx && dur >= 4 && c.cx > 0.55 && ['jazz', 'gospel', 'soul'].includes(c.genre) && r() < (c.cx - 0.5) * 0.8 && nx.root !== ch.root) {
        out.push([chordName(ch, c.key, c.minor), dur / 2], [make(nx.root + 7, c.genre === 'jazz' ? '7' : r() < 0.5 ? '7' : '9', null, c.key, c.minor), dur / 2]);
      } else out.push([chordName(ch, c.key, c.minor), dur]);
    });
    // score: smooth voice leading, variety, a satisfying (or loopable) ending, template weight
    let vl = 0; const pc = out.map((o) => parseChord(o[0], c.key, c.minor));
    for (let i = 1; i < pc.length; i++) vl += vlCost(pc[i - 1], pc[i]);
    const variety = new Set(out.map((o) => o[0])).size / out.length;
    const last = pc[pc.length - 1], fnL = last ? (last.root - c.key + 12) % 12 : 0;
    const cadence = RESOLVE.has(c.mood) ? (fnL === (c.minor ? 0 : 0) ? 1 : 0) : (vlCost(last, pc[0]) < 1.2 ? 0.6 : 0);
    const s = tpl[1] * 0.3 + variety - (vl / Math.max(1, pc.length - 1)) * 0.4 + cadence * 0.6 + r() * 0.6;
    if (s > bestS) { bestS = s; best = out; }
  }
  return best;
}

// ----------------------------------------------------------------- editing
// Alternatives for chord i: same-function substitutes, borrowed and secondary chords, colours and inversions
export function alternatives(chords, i, key, minor) {
  const cur = parseChord(chords[i][0], key, minor);
  if (!cur) return [];
  const prev = i > 0 ? parseChord(chords[i - 1][0], key, minor) : null, next = i + 1 < chords.length ? parseChord(chords[i + 1][0], key, minor) : null;
  const sc = scaleOf(key, minor), cands = new Set();
  const diat = minor ? ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII', 'V'] : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
  for (const rn of diat.concat(minor ? ['IV', 'bII'] : ['iv', 'bVI', 'bVII', 'II7', 'III7'])) { const c = parseChord(rn, key, minor); if (c) cands.add(chordName(c, key, minor)); }
  const minorQ = cur.iv[1] === 3;
  for (const suf of minorQ ? ['m7', 'm9', 'madd9', 'm6', 'm11'] : ['add9', 'sus2', 'sus4', 'maj7', '7', '6/9', '9', '13']) cands.add(make(cur.root, suf, cur.bass, key, minor));
  for (const iv of cur.iv.slice(1, 3)) cands.add(make(cur.root, cur.suf, cur.root + iv, key, minor)); // inversions
  cands.add(make(cur.root, cur.suf, null, key, minor));
  if (next) { cands.add(make(next.root + 7, '7', null, key, minor)); cands.add(make(next.root + 1, '7', null, key, minor)); } // V/next, tritone sub
  if (cur.iv.includes(4) && cur.iv.includes(10)) cands.add(make(cur.root + 6, '7', null, key, minor));
  cands.add(make(cur.root + (minorQ ? 3 : 9), minorQ ? '' : 'm', null, key, minor)); // relative
  const fn = FUNC((cur.root - key + 12) % 12), name = chordName(cur, key, minor);
  return [...cands].filter((s) => s !== name).map((s) => {
    const c = parseChord(s, key, minor);
    const f = FUNC((c.root - key + 12) % 12), dia = pcsOf(c).every((p) => sc.includes(p));
    const score = (f === fn ? 1.2 : 0) + (c.root === cur.root ? 0.8 : 0) + (dia ? 0.5 : 0.1) - 0.35 * (vlCost(prev, c) + vlCost(c, next));
    return { sym: s, score, why: c.root === cur.root ? (c.bass != null && c.bass !== cur.bass ? 'inversion' : 'colour') : f === fn ? 'same function' : dia ? 'diatonic' : 'borrowed / passing' };
  }).sort((a, b) => b.score - a.score).filter((a, k, all) => {
    const same = parseChord(a.sym, key, minor).root === cur.root;
    return all.slice(0, k).filter((b) => (parseChord(b.sym, key, minor).root === cur.root) === same).length < (same ? 4 : 8); // a few colours, mostly other chords
  });
}
const EXT = { '': (dom, fn) => (dom ? '7' : fn === 0 || fn === 5 ? 'maj7' : 'add9'), m: () => 'm7', add9: () => 'maj9', '7': () => '9', maj7: () => 'maj9', m7: () => 'm9', '9': () => '13', m9: () => 'm11', sus4: () => '7sus4', sus2: () => 'add9', madd9: () => 'm9', '6': () => '6/9' };
export function extend(chords, key, minor) {
  return chords.map(([s, d]) => { const c = parseChord(s, key, minor); if (!c || !EXT[c.suf]) return [s, d]; const fn = (c.root - key + 12) % 12; return [make(c.root, EXT[c.suf](fn === 7 && c.iv[1] === 4, fn), c.bass, key, minor), d]; });
}
export function simplify(chords, key, minor) {
  return chords.map(([s, d]) => { const c = parseChord(s, key, minor); if (!c) return [s, d]; const suf = c.iv.includes(6) && !c.iv.includes(7) ? 'dim' : c.iv[1] === 3 ? 'm' : ''; return [make(c.root, suf, null, key, minor), d]; });
}
export function withInversions(chords, key, minor) {
  const chs = invert(chords.map(([s]) => parseChord(s, key, minor)), key, minor, 1, () => 0);
  return chords.map(([s, d], i) => [chs[i] ? chordName(chs[i], key, minor) : s, d]);
}
export function moreComplex(chords, key, minor) { return withInversions(extend(chords, key, minor), key, minor); }
export function transpose(chords, key, minor, n) {
  const k2 = (key + n + 12) % 12;
  return { key: k2, chords: chords.map(([s, d]) => { const c = parseChord(s, key, minor); return [c ? make(c.root + n, c.suf, c.bass != null ? c.bass + n : null, k2, minor) : s, d]; }) };
}
export const editChord = (sym, key, minor, { root, suf, bass }) => { const c = parseChord(sym, key, minor) || { root: key, suf: '', bass: null }; return make(root ?? c.root, suf ?? c.suf, bass === undefined ? c.bass : bass, key, minor); };

// ----------------------------------------------------------------- whole songs
// One pianist part per section of the form. Section markers set each one's intensity (verse sparse,
// pre-chorus moving, chorus full); the style and harmony also change where a pianist would change them.
export function sectionParts(C, base, barLen = 4) {
  const P = pianistById(base.id), tonic = chordName(parseChord(C.minor ? 'i' : 'I', C.key, C.minor), C.key, C.minor), ch = C.chords;
  return C.form.map(([name, bars]) => {
    let chords = ch;
    if (name === 'Intro') chords = ch.slice(0, Math.max(1, Math.ceil(ch.length / 2)));
    else if (name === 'Bridge') { const k = Math.min(2, ch.length - 1); chords = moreComplex(ch.slice(k).concat(ch.slice(0, k)), C.key, C.minor); } // new harmonic ground
    else if (name === 'Outro') chords = [...ch.slice(-2), [tonic, barLen * 2]]; // come home
    else if (name === 'Pre-Chorus') chords = [...ch.slice(1, Math.max(2, ch.length - 1)), [chordName(parseChord('V', C.key, C.minor), C.key, C.minor), barLen]]; // lift into the chorus on the dominant
    const style = name === 'Intro' ? (['worship', 'cinematic'].includes(P.id) ? 'ambient' : 'sustain')
      : name === 'Bridge' ? 'build' : name === 'Instrumental' ? (P.id === 'gospel' ? 'runs' : 'fills')
      : name === 'Outro' ? (P.id === 'worship' ? 'arp' : 'sustain') : base.style;
    return { name, bars, pn: { ...base, style, key: C.key, minor: C.minor, prog: toProgText(chords, barLen), seed: newSeed(), var: 0 } };
  });
}

// ----------------------------------------------------------------- output
// Pianist progression text: one token per bar, "A:3,B:1" when a bar holds several chords
export function toProgText(chords, barLen = 4) {
  const bars = []; let cur = [], fill = 0;
  for (const [s, d0] of chords) {
    let d = d0;
    while (d > 1e-6) {
      const part = Math.min(d, barLen - fill);
      cur.push([s, part]); fill += part; d -= part;
      if (fill >= barLen - 1e-6) { bars.push(cur); cur = []; fill = 0; }
    }
  }
  if (cur.length) { cur.push(['N.C.', barLen - fill]); bars.push(cur); }
  return bars.map((b) => (b.length === 1 ? b[0][0] : b.every((x) => Math.abs(x[1] - b[0][1]) < 1e-6) ? b.map((x) => x[0]).join(',') : b.map((x) => `${x[0]}:${+x[1].toFixed(3)}`).join(','))).join(' ');
}
// Close-position voicings with smooth voice leading (left hand: bass; right hand: chord near middle C)
export function voiceProgression(chords, key, minor) {
  let prev = null;
  return chords.map(([s]) => {
    const c = parseChord(s, key, minor);
    if (!c) return { bass: null, rh: [] };
    const pcs = [...new Set(c.iv.map((x) => (x + c.root) % 12))].slice(0, 5);
    let best = null, bc = Infinity;
    for (let inv = 0; inv < pcs.length; inv++) {
      const rot = pcs.slice(inv).concat(pcs.slice(0, inv));
      for (const base of [55, 60, 65]) {
        const v = []; let last = base - 1;
        for (const pc of rot) { let p = last + 1 + ((pc - last - 1) % 12 + 12) % 12; v.push(p); last = p; }
        if (v[v.length - 1] - v[0] > 14) continue;
        let cost = Math.abs((v[0] + v[v.length - 1]) / 2 - 66) * 0.3;
        if (prev) for (const p of v) { let d = 99; for (const q of prev) d = Math.min(d, Math.abs(p - q)); cost += d; }
        if (cost < bc) { bc = cost; best = v; }
      }
    }
    prev = best;
    const bpc = c.bass != null ? c.bass : c.root;
    return { bass: 36 + ((bpc - 36) % 12 + 12) % 12, rh: best };
  });
}
