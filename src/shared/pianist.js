// Session Pianist: the musical decision engine. Shared, deterministic and
// local (no AI service). Four independent stages:
//   1. chord interpretation  (parseChord / parseProgression / chordTones)
//   2. voicing               (voiceChord: hand spans, registers, voice leading)
//   3. rhythmic pattern      (STYLE_FN: style × personality × density/energy)
//   4. human performance     (humanize: timing feel, rolls, velocity arcs, legato)
// A Pianist region stores only settings; its notes are generated from its seed
// whenever the project compiles, so a take is repeatable and "New take" just
// changes the seed. "Make MIDI" freezes a take into an ordinary MIDI clip.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const newSeed = () => (Math.random() * 0x7fffffff) | 0;
export function rng(seed) {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export const hash = (a, b) => (Math.imul(a ^ 0x5bd1e995, 0x01000193) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) >>> 0;

// ----------------------------------------------------------------- 1. chords
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb (major)
export const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const pcName = (pc, key = 0, minor = false) => (FLAT_KEYS.has(((minor ? key + 3 : key) % 12 + 12) % 12) ? FLAT : SHARP)[((pc % 12) + 12) % 12];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJ = [0, 2, 4, 5, 7, 9, 11], NMIN = [0, 2, 3, 5, 7, 8, 10];
export const scaleOf = (key, minor) => (minor ? NMIN : MAJ).map((x) => (x + key) % 12);
// chord suffix → intervals (semitones above the root)
export const QUALITIES = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7], dim: [0, 3, 6], o: [0, 3, 6], '°': [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8], 5: [0, 7],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], add9: [0, 4, 7, 14], add2: [0, 2, 4, 7], madd9: [0, 3, 7, 14], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], '6/9': [0, 4, 7, 9, 14], 69: [0, 4, 7, 9, 14],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], 'Δ': [0, 4, 7, 11], m7: [0, 3, 7, 10], '-7': [0, 3, 7, 10], m7b5: [0, 3, 6, 10], 'ø': [0, 3, 6, 10], dim7: [0, 3, 6, 9], o7: [0, 3, 6, 9], mmaj7: [0, 3, 7, 11],
  '7sus4': [0, 5, 7, 10], '7sus': [0, 5, 7, 10], '9sus4': [0, 5, 7, 10, 14], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '7b9': [0, 4, 7, 10, 13], '7#9': [0, 4, 7, 10, 15],
  11: [0, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 21], maj13: [0, 4, 7, 11, 14, 21], m13: [0, 3, 7, 10, 14, 21], add11: [0, 4, 7, 17], madd11: [0, 3, 7, 17],
};
function notePc(t) {
  const m = /^([A-Ga-g])([#b♯♭]?)$/.exec(t);
  if (!m) return null;
  return (LETTER[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0) + 12) % 12;
}
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
// "Gadd9", "D/F#", "Em7", "Cmaj9", "Bb", "N.C." — or Roman numerals in the key: "I V vi IV", "ii7", "bVII"
export function parseChord(sym, key = 0, minor = false) {
  let s = String(sym || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!s || /^(n\.?c\.?|_|x|-)$/i.test(s)) return null;
  let bass = null;
  const sl = s.lastIndexOf('/');
  if (sl > 0 && !/6\/9$/.test(s)) {
    const b = s.slice(sl + 1);
    bass = notePc(b);
    if (bass === null) { const rb = parseChord(b, key, minor); bass = rb ? rb.root : null; }
    s = s.slice(0, sl);
  }
  let root, suf;
  const m = /^([A-G])([#b]?)(.*)$/.exec(s);
  if (m) { root = notePc(m[1] + m[2]); suf = m[3]; }
  else {
    const r = /^([#b]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/.exec(s);
    if (!r) return null;
    const deg = ROMAN.indexOf(r[2].toUpperCase()), lower = r[2] !== r[2].toUpperCase();
    root = (key + (minor ? NMIN : MAJ)[deg] + (r[1] === '#' ? 1 : r[1] === 'b' ? -1 : 0) + 12) % 12;
    suf = r[3];
    if (lower && !/^(o|°|ø|dim|m)/.test(suf)) suf = 'm' + suf;
  }
  let iv = QUALITIES[suf];
  if (!iv) { const lo = suf.toLowerCase(); iv = lo.startsWith('m') && !lo.startsWith('maj') ? [0, 3, 7, 10] : /7|9|11|13/.test(suf) ? [0, 4, 7, 10] : [0, 4, 7]; }
  if (bass === root) bass = null;
  return { root, bass, iv: [...iv], suf };
}
// Name the chord in a set of held notes (live MIDI chord input). The lowest note becomes the bass.
const DETECT = ['', 'm', '7', 'maj7', 'm7', 'm7b5', 'dim', 'dim7', 'aug', 'sus2', 'sus4', '6', 'm6', 'add9', 'madd9', '9', 'maj9', 'm9', '7sus4', '5'];
export function detectChord(pitches, key = 0, minor = false) {
  const ps = [...new Set(pitches)].sort((a, b) => a - b);
  if (ps.length < 2) return null;
  const pcs = new Set(ps.map((p) => p % 12)), bass = ps[0] % 12;
  let best = null, bestS = -1e9;
  for (let root = 0; root < 12; root++) {
    if (!pcs.has(root)) continue;
    for (const suf of DETECT) {
      const iv = QUALITIES[suf], tones = iv.map((x) => (x + root) % 12);
      let sc = (root === bass ? 0.5 : 0) - iv.length * 0.3;
      for (let i = 0; i < iv.length; i++) sc += pcs.has(tones[i]) ? 3 : iv[i] === 7 ? -1.2 : -2.5; // a missing fifth is normal
      for (const p of pcs) if (!tones.includes(p)) sc -= 3;
      if (sc > bestS) { bestS = sc; best = { root, suf }; }
    }
  }
  return best ? chordName({ root: best.root, suf: best.suf, bass: bass !== best.root ? bass : null }, key, minor) : null;
}
export function chordName(ch, key = 0, minor = false) {
  if (!ch) return 'N.C.';
  return pcName(ch.root, key, minor) + ch.suf + (ch.bass != null ? '/' + pcName(ch.bass, key, minor) : '');
}
// Progression text: one token per bar ("G D Em C"); "C,G/B" splits a bar ("C:3,G:1" unevenly); "%" repeats; "N.C." rests; "|" is ignored.
export function parseProgression(str, key = 0, minor = false, barLen = 4) {
  const segs = [];
  let bar = 0, prev = null;
  for (const tok of String(str || '').replace(/\|/g, ' ').split(/\s+/).filter(Boolean)) {
    if (bar >= 128) break;
    const parts = tok.split(',').filter(Boolean).map((pt) => { const m = /^(.*):(\d+(?:\.\d+)?)$/.exec(pt); return m ? [m[1], +m[2] || 1] : [pt, 1]; });
    const W = parts.reduce((a, x) => a + x[1], 0);
    let at = 0;
    for (const [pt, w] of parts) {
      const ch = pt === '%' || pt === '.' ? prev : parseChord(pt, key, minor);
      segs.push({ s: bar * barLen + (at * barLen) / W, l: (w * barLen) / W, ch });
      at += w;
      if (ch) prev = ch;
    }
    bar++;
  }
  return { segs, bars: bar };
}

// ----------------------------------------------------------------- personalities & styles
// ext: how often each colour is added; lh: left-hand figure weights; open: split
// voicings between hands; jump: tolerance for wide voice-leading moves; reg:
// right-hand centre (MIDI); density: natural busyness; legato; push (+ ahead,
// − laid back); roll: chord spread; emb: embellishment habits.
const PZ = (id, name, color, blurb, o) => ({ id, name, short: name.replace(/^The /, '').replace(/ Pianist$/, ''), color, blurb, ...o });
export const PIANISTS = [
  PZ('worship', 'The Worship Pianist', '#8fb8ff', 'Warm, spacious add9 and sus voicings, gentle arpeggios and swells, plenty of space.', {
    ext: { sev: 0.15, nine: 0.15, add9: 0.75, sus: 0.35, high: 0 }, lh: { root: 0.25, octave: 0.55, fifth: 0.2 }, open: 0.7, jump: 0.2, reg: 70, density: 0.35, legato: 0.95, push: -0.1, roll: 0.4, vel: 0.48, swing: 0, inv: 0.35,
    emb: { grace: 0.05, approach: 0.05, walk: 0.05, run: 0.03, antic: 0.15, oct: 0.1, sub: 0 }, def: { style: 'arp', cx: 0.35, energy: 0.4, hum: 0.45 } }),
  PZ('gospel', 'The Gospel Pianist', '#ffb35c', 'Rich extensions, passing chords, walk-ups, turnarounds and punchy accents.', {
    ext: { sev: 0.7, nine: 0.55, add9: 0.2, sus: 0.2, high: 0.35 }, lh: { octave: 0.45, root: 0.15, fifth: 0.1, tenth: 0.3 }, open: 0.5, jump: 0.35, reg: 67, density: 0.6, legato: 0.65, push: 0.06, roll: 0.25, vel: 0.62, swing: 0.15, inv: 0.5,
    emb: { grace: 0.35, approach: 0.45, walk: 0.45, run: 0.35, antic: 0.3, oct: 0.15, sub: 0.12 }, def: { style: 'comp', cx: 0.65, energy: 0.6, hum: 0.5 } }),
  PZ('jazz', 'The Jazz Pianist', '#c9a0ff', 'Shell and rootless voicings, substitutions, syncopated comping, smooth voice leading.', {
    ext: { sev: 0.95, nine: 0.7, add9: 0, sus: 0.1, high: 0.45 }, lh: { shell: 0.6, root: 0.25, tenth: 0.15 }, open: 0.5, jump: 0.15, reg: 65, density: 0.5, legato: 0.5, push: 0, roll: 0.12, vel: 0.55, swing: 0.6, inv: 0.2,
    emb: { grace: 0.25, approach: 0.3, walk: 0.3, run: 0.2, antic: 0.45, oct: 0, sub: 0.35 }, def: { style: 'comp', cx: 0.7, energy: 0.5, hum: 0.5 } }),
  PZ('pop', 'The Pop Pianist', '#ff7a9c', 'Catchy, accessible chord rhythms, octave hooks, supportive and steady.', {
    ext: { sev: 0.08, nine: 0.08, add9: 0.35, sus: 0.25, high: 0 }, lh: { octave: 0.5, root: 0.35, fifth: 0.15 }, open: 0.3, jump: 0.25, reg: 66, density: 0.55, legato: 0.7, push: 0.05, roll: 0.1, vel: 0.62, swing: 0, inv: 0.35,
    emb: { grace: 0.05, approach: 0.05, walk: 0.05, run: 0.05, antic: 0.35, oct: 0.45, sub: 0 }, def: { style: 'eighths', cx: 0.35, energy: 0.6, hum: 0.3 } }),
  PZ('classical', 'The Classical Pianist', '#e8d9a8', 'Elegant broken chords, Alberti figures, scalar runs, controlled dynamics.', {
    ext: { sev: 0.2, nine: 0, add9: 0, sus: 0.08, high: 0 }, lh: { root: 0.4, octave: 0.4, fifth: 0.2 }, open: 0.35, jump: 0.15, reg: 69, density: 0.6, legato: 0.85, push: -0.05, roll: 0.2, vel: 0.52, swing: 0, inv: 0.45,
    emb: { grace: 0.1, approach: 0.15, walk: 0.1, run: 0.3, antic: 0, oct: 0.1, sub: 0 }, def: { style: 'broken', cx: 0.5, energy: 0.45, hum: 0.35 } }),
  PZ('soul', 'The Soul Pianist', '#ff9a6b', 'Warm sevenths and ninths, laid-back rhythmic phrasing, slides and grace notes.', {
    ext: { sev: 0.8, nine: 0.55, add9: 0.2, sus: 0.2, high: 0.2 }, lh: { octave: 0.35, root: 0.35, tenth: 0.2, fifth: 0.1 }, open: 0.45, jump: 0.3, reg: 66, density: 0.5, legato: 0.65, push: -0.18, roll: 0.2, vel: 0.58, swing: 0.25, inv: 0.3,
    emb: { grace: 0.45, approach: 0.25, walk: 0.2, run: 0.15, antic: 0.35, oct: 0.1, sub: 0.05 }, def: { style: 'comp', cx: 0.55, energy: 0.5, hum: 0.5 } }),
  PZ('cinematic', 'The Cinematic Pianist', '#7fd6c2', 'Minimal emotional phrases, open fifths, spacious ostinatos and slow builds.', {
    ext: { sev: 0.1, nine: 0.25, add9: 0.5, sus: 0.45, high: 0 }, lh: { octave: 0.7, fifth: 0.3 }, open: 0.85, jump: 0.3, reg: 72, density: 0.3, legato: 1, push: -0.05, roll: 0.3, vel: 0.45, swing: 0, inv: 0.25,
    emb: { grace: 0, approach: 0.05, walk: 0, run: 0, antic: 0.05, oct: 0.25, sub: 0 }, def: { style: 'minimal', cx: 0.4, energy: 0.35, hum: 0.35 } }),
  PZ('songwriter', 'The Singer-Songwriter', '#b7d77a', 'Natural, restrained accompaniment that leaves room for a lead vocal.', {
    ext: { sev: 0.1, nine: 0.05, add9: 0.3, sus: 0.3, high: 0 }, lh: { root: 0.5, octave: 0.3, fifth: 0.2 }, open: 0.3, jump: 0.2, reg: 62, density: 0.4, legato: 0.8, push: -0.05, roll: 0.2, vel: 0.5, swing: 0, inv: 0.4,
    emb: { grace: 0.05, approach: 0.05, walk: 0.12, run: 0, antic: 0.2, oct: 0, sub: 0 }, def: { style: 'ballad', cx: 0.3, energy: 0.4, hum: 0.4 } }),
];
export const pianistById = (id) => PIANISTS.find((p) => p.id === id) || PIANISTS[0];
export const STYLES = [
  { id: 'sustain', name: 'Sustained Chords' }, { id: 'broken', name: 'Broken Chords' }, { id: 'arp', name: 'Flowing Arpeggios' },
  { id: 'comp', name: 'Rhythmic Comping' }, { id: 'ballad', name: 'Gentle Ballad' }, { id: 'eighths', name: 'Driving Eighth Notes' },
  { id: 'rolling', name: 'Rolling Piano' }, { id: 'minimal', name: 'Minimalist' }, { id: 'fills', name: 'Melodic Fills' },
  { id: 'runs', name: 'Gospel Runs' }, { id: 'ambient', name: 'Ambient Worship' }, { id: 'build', name: 'Dynamic Build' },
];
const STYLE_IDS = STYLES.map((s) => s.id);

// ----------------------------------------------------------------- settings
export function newPianistSettings(id = 'worship', over = {}) {
  const P = pianistById(id);
  return { id: P.id, style: P.def.style, key: 7, minor: false, prog: 'G D Em C', cx: P.def.cx, energy: P.def.energy, density: P.density, hum: P.def.hum,
    swing: P.swing, reg: 0, dyn: 0.5, emb: 0.5, impro: 0.3, fill: 0.4, voices: 0.5, bass: false, follow: true,
    lhAct: 0.5, rhAct: 0.5, lhVel: 0.5, rhVel: 0.5, lhReg: 0, var: 0, seed: newSeed(), ...over };
}
export function normPianistSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const P = pianistById(r.id), u = (k, d) => clamp(num(r[k], d), 0, 1);
  return {
    id: P.id, style: STYLE_IDS.includes(r.style) ? r.style : P.def.style, key: ((Math.round(num(r.key, 7)) % 12) + 12) % 12, minor: !!r.minor,
    prog: typeof r.prog === 'string' ? r.prog.slice(0, 600) : 'G D Em C', cx: u('cx', P.def.cx), energy: u('energy', P.def.energy), density: u('density', P.density),
    hum: u('hum', P.def.hum), swing: u('swing', P.swing), reg: clamp(num(r.reg, 0), -1, 1), dyn: u('dyn', 0.5), emb: u('emb', 0.5), impro: u('impro', 0.3),
    fill: u('fill', 0.4), voices: u('voices', 0.5), bass: !!r.bass, follow: r.follow !== false,
    lhAct: u('lhAct', 0.5), rhAct: u('rhAct', 0.5), lhVel: u('lhVel', 0.5), rhVel: u('rhVel', 0.5), lhReg: clamp(num(r.lhReg, 0), -1, 1), var: Math.max(0, Math.round(num(r.var, 0))) | 0,
    seed: Math.abs(Math.round(num(r.seed, 1))) | 0,
  };
}
// Song sections from marker names (Intro, Verse, Pre-Chorus, Chorus, Bridge, Instrumental, Outro) → intensity
const SECTIONS = [[/intro/i, 0.35], [/pre/i, 0.7], [/verse/i, 0.5], [/chorus|hook/i, 1], [/bridge/i, 0.8], [/instr|solo|break|interlude/i, 0.85], [/outro|ending|tag/i, 0.3]];
export function sectionAt(markers, beat) {
  let m = null;
  for (const x of markers) if (x.beat <= beat + 1e-6 && (!m || x.beat >= m.beat)) m = x;
  if (!m) return null;
  const hit = SECTIONS.find(([re]) => re.test(m.name));
  return hit ? { name: m.name, int: hit[1] } : null;
}

// ----------------------------------------------------------------- 2. voicing
const pick = (r, w) => { let t = 0; for (const k in w) t += w[k]; let x = r() * t; for (const k in w) { x -= w[k]; if (x <= 0) return k; } return Object.keys(w)[0]; };
// Pitch classes (as intervals above the root) this pianist plays for a chord
function chordTones(ch, P, s, r, key) {
  const set = new Set(ch.iv.map((x) => x % 12));
  const minor = set.has(3) && !set.has(4), dim = set.has(6) && !set.has(7), aug = set.has(8);
  if (ch.iv.length <= 3 && !dim && !aug && !/sus|5/.test(ch.suf)) { // the chart says a plain triad: colour it to taste
    const fn = (ch.root - key + 12) % 12, cx = s.cx;
    if (r() < P.ext.sev * (0.35 + cx)) set.add(minor || fn === 7 || fn === 2 || fn === 4 || fn === 9 ? 10 : 11);
    if (r() < P.ext.nine * (0.3 + cx) || r() < P.ext.add9 * (0.4 + 0.6 * cx)) set.add(2);
    if (!minor && !set.has(10) && r() < P.ext.sus * (0.3 + 0.5 * cx)) { set.delete(4); set.add(r() < 0.6 ? 5 : 2); }
    if (r() < P.ext.high * cx) set.add(minor ? 5 : 9);
  }
  return set;
}
// Right hand: colour tones first, then the rest; close position within an octave, chosen for the smoothest move.
function voiceRH(tones, n, P, s, prev, r, centre, root) {
  const order = [4, 3, 5, 10, 11, 2, 9, 7, 0, 6, 8, 1];
  let pcs = order.filter((x) => tones.has(x));
  if ((P.lh.shell || s.bass) && pcs.length > 3) pcs = pcs.filter((x) => x !== 0);
  pcs = pcs.slice(0, n).map((x) => (x + root) % 12);
  let best = null, bestC = Infinity;
  for (let inv = 0; inv < pcs.length; inv++) {
    const ordered = [...pcs].sort((a, b) => a - b);
    const rot = ordered.slice(inv).concat(ordered.slice(0, inv));
    for (let oct = 3; oct <= 6; oct++) {
      const v = []; let last = -1;
      for (const x of rot) { let p = oct * 12 + x; while (p <= last) p += 12; v.push(p); last = p; }
      if (v[v.length - 1] - v[0] > 12) continue; // one hand: within an octave
      const mid = (v[0] + v[v.length - 1]) / 2;
      let c = Math.abs(mid - centre) * 0.35 + (v[0] < 55 ? (55 - v[0]) * 1.5 : 0) + r() * 0.8;
      if (prev) {
        let mv = 0;
        for (const p of v) { let d = 99; for (const q of prev) d = Math.min(d, Math.abs(p - q)); mv += d; }
        c += mv * (1.2 - P.jump) + Math.abs(v[v.length - 1] - prev[prev.length - 1]) * 0.6;
      }
      if (c < bestC) { bestC = c; best = v; }
    }
  }
  return best || [60, 64, 67];
}
// Both hands for one chord
function voiceChord(ch, P, s, st, r, energy, next) {
  const key = s.key, tones = chordTones(ch, P, s, r, key);
  const third = tones.has(4) ? 4 : tones.has(3) ? 3 : tones.has(5) ? 5 : 2, seventh = tones.has(10) ? 10 : tones.has(11) ? 11 : null;
  let bassPc = ch.bass != null ? ch.bass : ch.root;
  // inversions for a stepwise bass line (e.g. G → D/F# → Em), tritone substitutes on dominants
  if (ch.bass == null && next && st.bass != null && r() < P.inv * s.cx) {
    const tpc = (ch.root + third) % 12, nb = next.bass != null ? next.bass : next.root;
    const step = (a, b) => { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); };
    if (step(tpc, nb) <= 2 && step(tpc, st.bass % 12) <= 2) bassPc = tpc;
  }
  if (tones.has(4) && tones.has(10) && r() < P.emb.sub * s.cx) bassPc = (ch.root + 6) % 12;
  const lo = s.bass ? 43 : 31 + Math.round(s.lhReg * 6), hi = lo + 12;
  let bass = lo + ((bassPc - lo) % 12 + 12) % 12;
  if (st.bass != null && Math.abs(bass + 12 - st.bass) < Math.abs(bass - st.bass) && bass + 12 <= hi + 4) bass += 12;
  // left-hand figure
  let fig = s.bass ? 'shell' : pick(r, P.lh);
  if (!s.bass && energy > 0.7 && fig === 'root') fig = 'octave';
  let lh;
  if (fig === 'octave') lh = [bass, bass + 12];
  else if (fig === 'fifth') lh = [bass, bass + 7];
  else if (fig === 'tenth' && bassPc === ch.root) lh = [bass, bass + 12 + third];
  else if (fig === 'shell') lh = s.bass ? [bass + ((ch.root + third - bassPc + 12) % 12), bass + ((ch.root + (seventh || 7) - bassPc + 12) % 12)].sort((a, b) => a - b) : [bass, bass + (seventh || (third + 12))];
  else lh = [bass];
  // right hand
  const n = clamp(3 + Math.round(s.voices * 2 + (energy - 0.5)), 2, 5);
  const centre = P.reg + s.reg * 9 + (energy - 0.5) * 4;
  const rh = voiceRH(tones, n, P, s, st.rh, r, centre, ch.root);
  while (rh[0] <= lh[lh.length - 1]) for (let i = 0; i < rh.length; i++) rh[i] += 12;
  // open voicing: the right hand's lowest colour tone moves into the left hand (tenor voice)
  if (rh.length >= 4 && r() < P.open * 0.6 && rh[0] - 12 > lh[lh.length - 1] && rh[0] - 12 - lh[0] <= (P.lh.tenth ? 16 : 12)) lh = [...lh, rh.shift() - 12];
  st.bass = bass; st.rh = rh;
  return { ch, lh, rh, bass, top: rh[rh.length - 1], tones, third };
}

// ----------------------------------------------------------------- 3. rhythmic patterns
const COMP = [[0, 1.5, 3], [0, 2.5], [1.5, 3.5], [0, 1.5, 2.5], [0.5, 2, 3.5], [0, 2], [1, 3], [0, 0.5, 2, 3.5], [0, 1.5]];
function scaleRun(from, to, key, minor, steps, pent = false) {
  const sc = pent ? (minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]) : (minor ? NMIN : MAJ);
  const pcs = new Set(sc.map((x) => (x + key) % 12)), out = [];
  let p = from;
  const dir = to >= from ? 1 : -1;
  for (let i = 0; i < steps; i++) { do p += dir; while (!pcs.has(((p % 12) + 12) % 12)); out.push(p); }
  return out;
}
// Each style writes notes for one chord segment: x = { add, V, t0, L, ... }
const STYLE_FN = {
  sustain(x) { x.lhHit(x.t0, x.L); x.rhHit(x.t0, x.L); if (x.L >= 4 && x.dens > 0.55) x.rhHit(x.t0 + x.L / 2, x.L / 2, 0.8); },
  broken(x) {
    const { V, t0, L, r } = x, step = x.dens > 0.6 || x.L <= 2 ? 0.5 : 1;
    if (x.P.id === 'classical') { // Alberti bass under a singing top line
      const b = V.bass, fig = [b, b + 7, b + 12 + V.third, b + 7];
      for (let t = 0, i = 0; t < L - 1e-6; t += 0.5, i++) x.add(fig[i % 4], t0 + t, 0.5, x.vb * (i % 4 === 0 ? 0.85 : 0.65), 0);
      x.rhHit(t0, Math.min(2, L)); if (L >= 4) x.top(t0 + 2, 2, r);
      return;
    }
    x.lhHit(t0, L);
    const seq = [0, 1, 2, 1, 0, 2, 1, 2];
    for (let t = 0, i = 0; t < L - 1e-6; t += step, i++) x.add(V.rh[seq[i % seq.length] % V.rh.length], t0 + t, step * 1.6, x.vb * (i % 2 ? 0.7 : 0.82), 1);
  },
  arp(x) {
    const { V, t0, L } = x, step = x.dens < 0.25 ? 1 : (x.cx > 0.8 || x.dens > 0.75) && x.tempo < 132 ? 0.25 : 0.5;
    const up = [...new Set([V.bass + 7, V.bass + 12, V.bass + 19, ...V.rh, V.rh[0] + 12])].filter((p) => p > V.bass).sort((a, b) => a - b).slice(0, 7);
    const cyc = up.concat(up.slice(1, -1).reverse());
    x.add(V.bass, t0, L, x.vb * 0.9, 0);
    for (let t = step, i = 0; t < L - 1e-6; t += step, i++) { const p = cyc[i % cyc.length]; x.add(p, t0 + t, L - t, x.vb * (0.62 + (i % 4 === 0 ? 0.1 : 0)), p < V.rh[0] - 2 ? 0 : 1); } // low notes belong to the left hand
  },
  comp(x) {
    const { t0, L, r } = x;
    const kicks = x.gr && x.gr.k.length ? x.gr.k.filter((k) => k >= x.off && k < x.off + L).map((k) => k - x.off) : null;
    for (const t of kicks && kicks.length ? kicks.slice(0, 3) : x.dens > 0.45 && L >= 4 ? [0, 2] : [0]) x.lhHit(t0 + t, Math.min(L - t, 1.5));
    const pat = COMP[Math.floor(r() * Math.min(COMP.length, 3 + x.dens * 7))].filter((t) => t < L - 0.1);
    for (const t of pat) x.rhHit(t0 + t, 0.35 + 0.4 * x.P.legato, t === 0 ? 1 : 0.88);
  },
  ballad(x) {
    const { V, t0, L, r } = x, b = V.bass, fig = [b, b + 7, b + 12, b + 7 + (x.dens > 0.6 ? 5 : 0)], step = x.dens > 0.45 ? 0.5 : 1;
    for (let t = 0, i = 0; t < L - 1e-6; t += step, i++) x.add(fig[i % 4], t0 + t, L - t, x.vb * (i % 4 === 0 ? 0.85 : 0.6), 0);
    x.rhHit(t0, Math.min(2, L)); if (L >= 4) x.top(t0 + 2, 2, r);
  },
  eighths(x) {
    const { t0, L } = x, step = x.dens < 0.35 ? 1 : 0.5;
    const lhT = x.kicks && x.kicks.length ? x.kicks.slice(0, 4) : []; // locked to the Drummer's kick when following
    if (!lhT.length) for (let t = 0; t < L - 1e-6; t += x.energy > 0.7 ? 1 : 2) lhT.push(t);
    for (const t of lhT) x.lhHit(t0 + t, Math.min(1, L - t));
    for (let t = 0, i = 0; t < L - 1e-6; t += step, i++) x.rhHit(t0 + t, step * 0.8, t % 1 === 0 ? (t % 2 === 0 ? 1 : 0.9) : 0.72);
  },
  rolling(x) {
    const { V, t0, L } = x, b = V.bass, fig = [b, b + 7, b + 12, b + 7];
    for (let t = 0, i = 0; t < L - 1e-6; t += 0.5, i++) x.add(fig[i % 4] + (i % 8 === 0 && x.energy > 0.6 ? -12 : 0), t0 + t, 0.5, x.vb * (i % 2 ? 0.66 : 0.8), 0);
    for (const t of [0, 1.5, 3]) if (t < L - 0.1) x.rhHit(t0 + t, 0.9, t ? 0.85 : 1);
  },
  minimal(x) {
    const { V, t0, L } = x;
    x.lhHit(t0, L, 0.85);
    const pair = [V.rh[V.rh.length - 2] || V.rh[0], V.top];
    if (x.dens < 0.2) { x.add(pair[0], t0, L, x.vb * 0.7, 1); x.add(pair[1], t0, L, x.vb * 0.75, 1); return; }
    const step = x.dens > 0.45 ? 0.5 : 1;
    for (let t = 0, i = 0; t < L - 1e-6; t += step, i++) x.add(pair[i % 2], t0 + t, step * 2, x.vb * (i % 2 ? 0.62 : 0.72), 1);
  },
  fills(x) { // the right hand stops comping where its fill begins
    const rl = x.L >= 4 ? 2 : 1, run = x.L >= 2 && x.next && (x.phraseEnd || x.r() < x.s.fill * 0.5);
    if (run) x.stopAt = x.L - rl;
    STYLE_FN.sustain(x);
    if (run) x.run(x.t0 + x.L - rl, rl, false);
  },
  runs(x) {
    const run = x.next && (x.phraseEnd || x.r() < x.s.fill * 0.6);
    if (run) { x.stopAt = x.L - 1; x.lhStopAt = x.L - 0.75; } // hands make room for the run and the walk-up
    STYLE_FN.comp(x);
    if (run) { x.run(x.t0 + x.L - 1, 1, true); x.walk(); }
  },
  ambient(x) {
    const { V, t0, L, r } = x;
    x.add(V.bass, t0, L, x.vb * 0.7, 0); x.add(V.bass + 12, t0 + 0.02, L, x.vb * 0.6, 0);
    let t = (x.dens > 0.4 ? 1 : 0) + (r() < 0.5 ? 0 : 0.5); // colour notes never land on the chord
    const colour = V.rh.filter((p) => [2, 7, 5, 4, 3].includes(((p - V.ch.root) % 12 + 12) % 12));
    const pool = colour.length ? colour : V.rh;
    while (t < L - 0.5) { x.add(pool[Math.floor(r() * pool.length)] + 12, t0 + t, L - t, x.vb * (0.45 + 0.2 * r()), 1); t += 1.5 + (1 - x.dens) * 2 + r() * 1.5; }
    if (x.dens > 0.4) x.rhHit(t0, L, 0.6);
  },
  build(x) {
    const lvl = x.buildLvl, { t0, L } = x;
    if (lvl < 0.25) { STYLE_FN.sustain(x); return; }
    const step = lvl < 0.5 ? 1 : lvl < 0.75 ? 0.5 : 0.25;
    for (let t = 0; t < L - 1e-6; t += Math.max(step * 2, 1)) x.lhHit(t0 + t, Math.max(step * 2, 1), 0.9);
    if (lvl > 0.9 && x.next) x.stopAt = L - 1;
    for (let t = 0, i = 0; t < L - 1e-6; t += step, i++) x.rhHit(t0 + t, step * 0.9, (t % 1 === 0 ? 0.95 : 0.75) * (0.85 + 0.3 * (t / L)));
    if (lvl > 0.9 && x.next) x.run(t0 + L - 1, 1, true);
  },
};

// ----------------------------------------------------------------- generation
// ctx (optional): { tempo, start (region's absolute beat), groove(beat) → {k, fill, loud}, markers }
export function generatePianist(settings, length, barLen = 4, ctx = null) {
  const s = normPianistSettings(settings), P = pianistById(s.id);
  const prog = parseProgression(s.prog, s.key, s.minor, barLen);
  const notes = [];
  if (!prog.bars || !(length > 0)) return notes;
  const tempo = (ctx && ctx.tempo) || 120, start = (ctx && ctx.start) || 0;
  const nBars = Math.ceil(length / barLen - 1e-9);
  const segAt = (b) => { const pb = b % prog.bars; return prog.segs.filter((g) => g.s >= pb * barLen - 1e-6 && g.s < (pb + 1) * barLen - 1e-6).map((g) => ({ ...g, off: g.s - pb * barLen })); };
  const st = { bass: null, rh: null };
  let antic = false;
  let segT0 = 0, segBass = -1, segTop = -1, segV = null;
  const handV = [0.6 + 0.8 * s.lhVel, 0.6 + 0.8 * s.rhVel], act = [s.lhAct, s.rhAct]; // act is adjusted per bar by the song section
  const push = (p, t, l, v, h) => { if (t >= -0.25 && t < length && l > 0.02 && p >= 21 && p <= 108) notes.push({ p, s: t, l, v: clamp(v * handV[h], 0.04, 1), h }); };
  // hand activity: below the middle a hand drops optional attacks (whole chords at a time, never the chord change);
  // above it, the hand fills out (left: octave below the bass, right: melody doubled an octave up)
  const add = (p, t, l, v, h, fx = false) => { // fx: a struck chord the hand may fill out
    const anchor = Math.abs(t - segT0) < 0.02, a = act[h], u = (hash(s.seed + h * 7919, Math.round(t * 96) + 1) % 10007) / 10007;
    if (!anchor && a < 0.5 && u > 0.12 + 1.76 * a) return;
    push(p, t, l, v, h);
    if (fx && anchor && a > 0.5 && u < (a - 0.5) * 1.8) {
      // stay within one hand's reach: the left hand only doubles a lone bass note; the right hand adds the melody's lower octave inside its span
      if (h === 0 && p === segBass && segV.lh.length === 1 && p - 12 >= 24) push(p - 12, t, l, v * 0.85, 0);
      else if (h === 1 && p === segTop && segV.rh[0] > p - 12 && p - 12 > segV.lh[segV.lh.length - 1]) push(p - 12, t, l, v * 0.8, 1);
    }
  };
  // is the right hand already playing at time t? (one hand cannot strike two chords at once)
  const rhBusy = (t) => { for (let i = notes.length - 1, k = 0; i >= 0 && k < 80; i--, k++) if (notes[i].h === 1 && Math.abs(notes[i].s - t) < 0.06) return true; return false; };
  // a short melodic motif for this take: the top line keeps returning to it (more freely with Improvisation)
  const mr = rng(hash(s.seed + s.var * 7777, 777)), motif = [0, 1, 2, 3].map(() => Math.round(mr() * 4) - 2);
  for (let b = 0; b < nBars; b++) {
    const r = rng(hash(s.seed, b)), re = rng(hash(s.seed + s.var * 7777, b + 50000)); // r: structure, re: embellishments (Variation re-rolls only these)
    const bar0 = b * barLen, E = Math.min(barLen, length - bar0), abs = start + bar0;
    const phrasePos = b % 4, phraseEnd = phrasePos === 3 || b === nBars - 1;
    const sec = ctx && ctx.markers ? sectionAt(ctx.markers, abs) : null;
    const gr = s.follow && ctx && ctx.groove ? ctx.groove(abs) : null;
    const afterFill = !!(s.follow && ctx && ctx.groove && b > 0 && (ctx.groove(abs - barLen) || {}).fill); // answer a drum fill with a strong downbeat
    let energy = s.energy * (sec ? 0.35 + 0.9 * sec.int : 1); // song sections: verse sparse … chorus full
    if (gr) energy = 0.75 * energy + 0.25 * gr.loud;
    const lift = sec ? (sec.int - 0.6) * 0.7 : 0; // sections thin out (verse, intro, outro) or fill out with octaves (chorus)
    act[0] = clamp(s.lhAct + lift, 0, 1); act[1] = clamp(s.rhAct + lift, 0, 1);
    let dens = clamp(s.density * (sec ? 0.45 + 0.8 * sec.int : 1) * (gr && gr.fill ? 0.6 : 1), 0, 1);
    if (s.style === 'build') { const f = nBars > 4 ? (b % 8) / 7 : phrasePos / 3; energy = clamp(energy * (0.55 + 0.7 * f), 0, 1); }
    // restraint: a sparse pianist sometimes leaves the right hand out for a bar
    const rest = phrasePos !== 0 && r() < (1 - dens) * 0.3 * (1 - s.cx);
    const segs = segAt(b), nextSegs = segAt(b + 1);
    segs.forEach((g, gi) => {
      if (!g.ch || g.off >= E - 1e-6) return;
      let anticNow = antic; antic = false;
      const nextG = gi + 1 < segs.length ? segs[gi + 1] : nextSegs[0];
      const next = nextG && nextG.ch;
      const V = voiceChord(g.ch, P, s, st, r, energy, next);
      const t0 = bar0 + g.off, L = Math.min(g.l, E - g.off);
      segT0 = t0; segBass = V.bass; segTop = V.top; segV = V;
      const vb = (0.28 + 0.55 * energy) * (0.75 + 0.5 * P.vel);
      const x = {
        V, t0, L, r, P, s, add, energy, dens, cx: s.cx, tempo, vb, gr, off: g.off, next, phraseEnd: phraseEnd && gi === segs.length - 1,
        kicks: gr && gr.k.length ? gr.k.filter((k) => k >= g.off - 1e-6 && k < g.off + L - 1e-6).map((k) => k - g.off) : null,
        buildLvl: s.style === 'build' ? (nBars > 4 ? (b % 8) / 7 : phrasePos / 3) : 0,
        lhHit: (t, l, k = 1) => (x.lhStopAt != null && t - t0 >= x.lhStopAt - 1e-6) || V.lh.forEach((p, i) => add(p, t + i * 0.005, l, vb * k * (i ? 0.78 : 0.9), 0, true)),
        rhHit: (t, l, k = 1) => {
          if (rest || (x.stopAt != null && t - t0 >= x.stopAt - 1e-6)) return;
          let tt = t;
          if (anticNow && Math.abs(t - t0) < 1e-6) { if (!rhBusy(t - 0.5)) tt = t - 0.5; anticNow = false; }
          const inBar = t - bar0, acc = (afterFill && inBar < 0.02 ? 1.15 : 1) * (gr && gr.s && gr.s.some((q) => Math.abs(q - inBar) < 0.05) ? 1.06 : 1); // lean on the backbeat
          if (re() < P.emb.grace * s.emb * 0.5 && tt - 0.08 >= 0) add(V.top - 1, tt - 0.08, 0.08, vb * k * 0.55, 1); // grace into the top note
          V.rh.forEach((p, i) => add(p, tt, l + (t - tt), vb * k * acc * (i === V.rh.length - 1 ? 1.06 : 0.86), 1, true));
          if (k >= 1 && re() < P.emb.oct * s.impro) add(V.top - 12, tt, l, vb * k * 0.8, 1); // octave melody
        },
        top: (t, l) => { // a new melody note on top of the held chord, stepping through the take's motif
          if (rest) return;
          const sc = scaleOf(s.key, s.minor), step = re() < 0.3 + 0.7 * s.impro ? motif[(b + gi) % 4] : 0;
          let p = V.top;
          for (let k = Math.abs(step); k > 0; k--) do p += Math.sign(step); while (!sc.includes(((p % 12) + 12) % 12));
          add(p, t, l, vb * 0.8, 1);
        },
        run: (t, l, pent) => { // a melodic fill/run that lands on the next chord
          if (!next || re() > 0.35 + s.fill * 0.65) return;
          const unit = pent ? (tempo > 110 ? 0.25 : 0.125) : 0.5 - 0.25 * s.impro, steps = Math.max(3, Math.round(l / unit));
          const seq = pent ? scaleRun(V.top + 12, V.top, s.key, s.minor, steps, true) : scaleRun(V.top, V.top + ((next.root - V.ch.root + 12) % 12 > 6 ? -7 : 7), s.key, s.minor, steps);
          seq.forEach((p, i) => add(p, t + (i * l) / steps, l / steps * 1.2, vb * (0.6 + 0.35 * i / steps), 1));
        },
        walk: () => { // left-hand walk-up into the next root
          if (!next || re() > P.emb.walk * 2 * s.emb + 0.1) return;
          const nb = next.bass != null ? next.bass : next.root;
          let target = V.bass + ((nb - V.bass) % 12 + 12) % 12; if (target - V.bass > 6) target -= 12;
          const dir = target >= V.bass ? 1 : -1;
          for (let i = 3; i >= 1; i--) add(target - dir * i, t0 + L - i * 0.25, 0.25, vb * 0.7, 0);
        },
      };
      (STYLE_FN[s.style] || STYLE_FN.sustain)(x);
      // passing/approach chord a half step from the next chord, and anticipations, at the end of the segment
      if (next && L >= 2 && x.stopAt == null && !['arp', 'broken', 'ballad', 'minimal', 'ambient'].includes(s.style) && re() < P.emb.approach * s.cx * s.emb * 1.4 && !rhBusy(t0 + L - 0.5)) { // block passing chords suit comping, not flowing figures
        const nv = voiceChord(next, P, s, { bass: st.bass, rh: st.rh }, rng(hash(s.seed, b * 13 + gi)), energy, null);
        const d = re() < 0.6 ? 1 : -1;
        nv.rh.forEach((p) => add(p + d, t0 + L - 0.5, 0.45, vb * 0.75, 1));
      } else if (next && re() < P.emb.antic * s.cx) antic = true;
    });
  }
  return humanize(notes, s, P, tempo, length, barLen);
}

// ----------------------------------------------------------------- 4. human performance
function humanize(notes, s, P, tempo, length, barLen) {
  const r = rng(hash(s.seed, 99991 + s.var)), hum = s.hum, ms = tempo / 60000; // ms → beats
  const nBeats = Math.ceil(length) + 2, drift = [new Float64Array(nBeats), new Float64Array(nBeats)];
  for (let h = 0; h < 2; h++) for (let i = 1; i < nBeats; i++) drift[h][i] = 0.65 * drift[h][i - 1] + 0.35 * (r() * 2 - 1);
  const ARC = [0.94, 1, 1.06, 0.97], dynK = 0.5 + s.dyn;
  notes.sort((a, b) => a.s - b.s || a.p - b.p);
  const roll = (P.roll * 16 + hum * 6) * ms;
  let chordT = -1, chordH = -1, idx = 0;
  for (const n of notes) {
    const nom = n.s, beat = Math.max(0, Math.floor(nom)), pos = nom - Math.floor(nom);
    // swing the off-beat eighths
    if (s.swing > 0 && Math.abs(pos - 0.5) < 0.02) n.s += s.swing / 6;
    // feel: personality push/pull plus a slowly wandering hand-specific drift, never more than ~25 ms
    n.s += clamp(P.push * 14 * (0.5 + hum) + drift[n.h][beat] * hum * 12 + (r() - 0.5) * hum * 5 + (n.h ? 0 : -2 * hum), -25, 25) * ms;
    // chord rolls: notes struck together spread upward
    if (Math.abs(nom - chordT) < 1e-6 && n.h === chordH) n.s += ++idx * roll; else { chordT = nom; chordH = n.h; idx = 0; }
    // velocity: phrase arc, metric accent, hand balance, a little life
    const bar = Math.floor(nom / barLen), inBar = nom - bar * barLen;
    const metric = inBar < 0.01 ? 1.07 : pos < 0.01 ? (Math.abs(inBar - barLen / 2) < 0.01 ? 1.02 : 0.97) : 0.9;
    n.v = clamp(n.v * (1 + (ARC[bar % 4] - 1) * dynK) * (1 + (metric - 1) * dynK) * (1 + (r() - 0.5) * 0.14 * hum), 0.04, 1);
    // articulation: legato overlap for connected players, never shorter than a grace
    n.l = Math.max(0.05, n.l * (0.75 + 0.3 * P.legato) + (P.legato > 0.8 ? 0.03 : 0));
    if (n.s < 0) { n.l += n.s; n.s = 0; }
  }
  return notes.filter((n) => n.l > 0.02 && n.s < length).map((n) => ({ p: n.p, s: n.s, l: Math.min(n.l, length - n.s + 0.5), v: n.v, h: n.h }));
}
