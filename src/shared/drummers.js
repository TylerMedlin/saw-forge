// Drummer: virtual EDM drummers that play a region of a drum track.
//
// A drummer region stores only the drummer and its settings; the hits are
// generated (deterministically, from the region's seed) whenever the project
// is compiled. Each drummer has a personality: their own grooves (written as
// 16-step patterns), the fills they like, how they build into a drop, and a
// matching kit.
//
// Settings (all per region):
//   cx    Technique   0 simple … 1 complex (optional hits, ghost notes, hat rolls, extra percussion)
//   loud  Loudness    0 soft … 1 loud (velocity, open hats vs closed, layered snares, crashes)
//   fill  Fills       0 none … 1 lots (how often, how long, builds and risers)
//   speed Speed       half · normal · double time (kick & snare feel; hats stay in tempo)
//   swing Swing       0 straight … 1 triplet shuffle (16ths)
//   feel  Feel        −1 pushed … +1 laid back (snare/hats against the kick)
//   hum   Humanize    timing and velocity looseness
//   parts kick · hats · perc · cym: { on, v } — v picks one of 4 pattern variations

import { PC, PIECES } from './drums.js';

export const PARTS = [
  { id: 'kick', name: 'Kick & Snare' },
  { id: 'hats', name: 'Hi-Hats' },
  { id: 'perc', name: 'Percussion' },
  { id: 'cym', name: 'Cymbals & FX' },
];
export const SPEEDS = ['half', 'normal', 'double'];
export const SPEED_NAMES = { half: 'Half time', normal: 'Normal', double: 'Double time' };

// pattern characters: X accent · x hit · - soft · o optional (Technique) · g ghost (Technique) · . rest
const VEL = { X: 1, x: 0.82, '-': 0.6, o: 0.72, g: 0.3 };
const L = (piece, pats, o = {}) => ({ piece, pats, ...o });

export const DRUMMERS = [
  {
    id: 'nova', name: 'Nova', genre: 'Big Room', bpm: 128, kit: 'Festival', color: '#ff7a45', traits: ['Bold', 'Energetic'],
    blurb: 'Main-stage energy. Stomping four-on-the-floor, huge claps and snare-roll builds that beg for a drop.',
    def: { cx: 0.35, loud: 0.8, fill: 0.6, swing: 0, feel: 0, hum: 0.1 },
    four: true, fills: ['roll', 'roll', 'toms'], build: true, riser: true, dropGap: true, rollPiece: 'snare', crashEvery: 8,
    lanes: [
      L('kick', ['X...X...X...X...', 'X...X...X...X..o', 'X...X...X..oX...', 'X...X..oX...X.o.']),
      L('clap', ['....X.......X...', '....X.......X...', '....X......gX...', '....X.......X..g'], { soft: 'snare' }),
      L('snare', ['....x.......x...'], { loudMin: 0.6, vel: 0.7 }),
      L('ohh', ['..x...x...x...x.', '..x...x...x...x.', '..x...x...x.o.x.', '..x...x...x...xo'], { soft: 'chh' }),
      L('chh', ['-o.o-o.o-o.o-o.o', '-.o.-.o.-.o.-.o.', 'x.ox-.ox-.ox-.ox', '-o.o-o.o-o.o-ooo'], { cx: 0.3, vel: 0.8 }),
      L('shaker', ['.-x-.-x-.-x-.-x-', '-x-x-x-x-x-x-x-x', 'g-x-g-x-g-x-g-xx', '.-x-.-x-.-xg.-x-'], { cx: 0.45, vel: 0.8 }),
      L('perc', ['......o.......o.', '...o......o.....', '.o.....o.o.....o', '......o...o...o.'], { cx: 0.55 }),
      L('ride', ['..x...x...x...x.'], { loudMin: 0.85, vel: 0.8 }),
    ],
  },
  {
    id: 'jax', name: 'Jax', genre: 'Deep House', bpm: 122, kit: 'House', color: '#3fb3a0', traits: ['Laid-back', 'Groovy'],
    blurb: 'Smooth and soulful. Shuffling hats, shakers and rimshots that sit just behind the beat.',
    def: { cx: 0.5, loud: 0.45, fill: 0.3, swing: 0.35, feel: 0.3, hum: 0.35 },
    four: true, fills: ['perc', 'perc', 'roll'], build: false, riser: false, dropGap: false, rollPiece: 'clap', crashEvery: 16,
    lanes: [
      L('kick', ['X...X...X...X...', 'X...X...X...X...', 'X...X...X..oX...', 'X...X..oX...X...']),
      L('clap', ['....x.......x...', '....x.......x..g', '....x...g...x...', '....x..g....x...'], { soft: 'rim', softBelow: 0.22 }),
      L('chh', ['-g.g-g.g-g.g-g.g', 'x.-.x.-.x.-.x.-.', '-g.g-g.g-g.g-g.o', 'x-.-x-.-x-.-x-.-'], { vel: 0.85 }),
      L('ohh', ['..x...x...x...x.', '..x...x...x...x.', '..x...x...x...xo', '..-...x...-...x.'], { soft: 'chh' }),
      L('shaker', ['g-x-g-x-g-x-g-x-', '-x-x-x-x-x-x-x-x', 'g-xg-gx-g-xgg-x-', '-x-x-x-x-x-x-xxx'], { cx: 0.2 }),
      L('rim', ['...o..o....o..o.', '..o...o..o...o..', '.o....o..o....o.', '...o.o.....o..o.'], { cx: 0.4, vel: 0.7 }),
      L('perc', ['...o.....o....o.', '.o.....o..o.....', '......o..o......', '...o..o....o..o.'], { cx: 0.6, vel: 0.8 }),
      L('ride', ['--x---x---x---x-'], { loudMin: 0.75, vel: 0.7 }),
    ],
  },
  {
    id: 'vex', name: 'Vex', genre: 'Techno', bpm: 130, kit: 'Techno', color: '#8c7fd9', traits: ['Hypnotic', 'Precise'],
    blurb: 'Relentless and machine-tight. Rolling kicks, driving sixteenths and polyrhythmic percussion that locks you in.',
    def: { cx: 0.55, loud: 0.65, fill: 0.2, swing: 0.08, feel: 0, hum: 0.05 },
    four: true, fills: ['gap', 'perc', 'stutter'], build: false, riser: true, dropGap: true, rollPiece: 'clap', crashEvery: 16,
    lanes: [
      L('kick', ['X...X...X...X...', 'X...X...X...X...', 'X...X...X...X..o', 'X..oX...X...X...']),
      L('clap', ['....x.......x...', '....x.......x...', '............x...', '....x...........']),
      L('chh', ['--X---X---X---X-', 'x-X-x-X-x-X-x-X-', 'x-Xxx-X-x-Xxx-X-', '-xX--xX--xX--xX-'], { vel: 0.8 }),
      L('ohh', ['..x...x...x...x.'], { loudMin: 0.5, vel: 0.8 }),
      L('ride', ['x.x.x.x.x.x.x.x.'], { loudMin: 0.7, vel: 0.65 }),
      L('perc', ['x..x..x.x..x..x.', '..o..o..o..o..o.', 'o..x..o..x..o.x.', 'x..x..x...x..x..'], { cx: 0.35, vel: 0.65 }),
      L('rim', ['...o.....o....o.', '.o......o.....o.', '...o..o....o....', '..o..o..o..o....'], { cx: 0.6, vel: 0.6 }),
    ],
  },
  {
    id: 'sol', name: 'Sol', genre: 'Trance', bpm: 138, kit: 'Trance', color: '#4f9ddb', traits: ['Uplifting', 'Precise'],
    blurb: 'Euphoric and steady. Offbeat open hats, galloping percussion and long, rising snare builds.',
    def: { cx: 0.4, loud: 0.7, fill: 0.55, swing: 0, feel: 0, hum: 0.08 },
    four: true, fills: ['roll'], build: true, riser: true, dropGap: true, rollPiece: 'snare', crashEvery: 8,
    lanes: [
      L('kick', ['X...X...X...X...', 'X...X...X...X...', 'X...X...X...X..o', 'X...X...X..oX...']),
      L('clap', ['....X.......X...', '....X.......X...', '....X.......X..g', '....X......gX...']),
      L('snare', ['....x.......x...'], { loudMin: 0.55, vel: 0.65 }),
      L('ohh', ['..X...X...X...X.', '..X...X...X...X.', '..X...X...X.o.X.', '..X...X...X...Xo'], { soft: 'chh' }),
      L('chh', ['-x.x-x.x-x.x-x.x', '-o.o-o.o-o.o-o.o', 'xx.xxx.xxx.xxx.x', '-x.x-x.x-x.x-xxx'], { cx: 0.3, vel: 0.75 }),
      L('perc', ['...o...o...o...o', '.oo..oo..oo..oo.', '.x.o.x.o.x.o.x.o', '...o...o..o..o.o'], { cx: 0.45, vel: 0.7 }),
      L('shaker', ['-x-x-x-x-x-x-x-x'], { cx: 0.5, vel: 0.8 }),
      L('ride', ['x.x.x.x.x.x.x.x.'], { loudMin: 0.75, vel: 0.7 }),
    ],
  },
  {
    id: 'kira', name: 'Kira', genre: 'Future Bass', bpm: 150, kit: 'Future', color: '#cc6c9c', traits: ['Playful', 'Dreamy'],
    blurb: 'Bright and bouncy. Big half-time snares, choppy hats and playful trap rolls.',
    def: { cx: 0.5, loud: 0.65, fill: 0.45, swing: 0.1, feel: 0, hum: 0.15 },
    four: false, fills: ['trap', 'roll', 'gap'], build: true, riser: true, dropGap: true, rollPiece: 'snare', crashEvery: 8, hatRolls: 0.7,
    lanes: [
      L('kick', ['X.........x.....', 'X......o..x.....', 'X.....x...o..o..', 'X..o......x..x..']),
      L('snare', ['........X.......', '........X.......', '........X......g', '........X..g....']),
      L('clap', ['........x.......'], { loudMin: 0.4, vel: 0.8 }),
      L('chh', ['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.x.', 'x.x.x.xxx.x.x.x.', 'x.x.xxx.x.x.x.xx'], { vel: 0.8 }),
      L('ohh', ['......o.......o.'], { cx: 0.5 }),
      L('rim', ['....o.........o.', '..o.......o.....', '....o.o.......o.', '.......o.......o'], { cx: 0.5, vel: 0.7 }),
      L('shaker', ['-x-x-x-x-x-x-x-x'], { cx: 0.6 }),
    ],
  },
  {
    id: 'ace', name: 'Ace', genre: 'Trap', bpm: 140, kit: 'Trap', color: '#d9b44a', traits: ['Swagger', 'Aggressive'],
    blurb: 'Hard-hitting swagger. Booming 808 kicks, crisp snares and hi-hats that roll and stutter.',
    def: { cx: 0.6, loud: 0.75, fill: 0.4, swing: 0.05, feel: 0.1, hum: 0.1 },
    four: false, fills: ['trap', 'trap', 'gap'], build: false, riser: false, dropGap: true, rollPiece: 'snare', crashEvery: 16, hatRolls: 1,
    lanes: [
      L('kick', ['X......x..X.....', 'X..x......X..x..', 'X.....xX..x.....', 'X..o..x...X..o..']),
      L('snare', ['........X.......', '........X......g', '........X...g...', '........X.......']),
      L('clap', ['........x.......'], { loudMin: 0.5, vel: 0.85 }),
      L('chh', ['x.x.x.x.x.x.x.x.', 'xxx.x.xxx.x.x.xx', 'x.xxx.x.x.xxx.x.', 'xxxxx.x.xxxxx.x.'], { vel: 0.8 }),
      L('ohh', ['..............o.'], { cx: 0.6 }),
      L('rim', ['......o.......o.', '...o......o.....'], { cx: 0.5, vel: 0.65 }),
    ],
  },
  {
    id: 'riot', name: 'Riot', genre: 'Dubstep', bpm: 140, kit: 'Heavy', color: '#d06060', traits: ['Aggressive', 'Heavy'],
    blurb: 'Heavy and unpredictable. Crushing half-time backbeats, syncopated kicks and stuttering fills.',
    def: { cx: 0.45, loud: 0.85, fill: 0.5, swing: 0, feel: 0, hum: 0.08 },
    four: false, fills: ['stutter', 'toms', 'gap'], build: true, riser: true, dropGap: true, rollPiece: 'snare', crashEvery: 8,
    lanes: [
      L('kick', ['X.........o.....', 'X.....o...x.....', 'X..o......X..o..', 'X.......o.x...o.']),
      L('snare', ['........X.......', '........X.....g.', '........X...g...', '........X......o']),
      L('clap', ['........x.......'], { loudMin: 0.3, vel: 0.9 }),
      L('chh', ['x...x...x...x...', 'x.x.x.x.x.x.x.x.', 'x.x.x.xxx.x.x.xx', '..x...x...x...x.'], { vel: 0.8 }),
      L('ohh', ['......o.......o.'], { cx: 0.4 }),
      L('tomL', ['..........o..o..', '...........o.o..'], { cx: 0.7, vel: 0.8 }),
      L('perc', ['...o.......o....', '.......o.....o..'], { cx: 0.55, vel: 0.6 }),
    ],
  },
  {
    id: 'zed', name: 'Zed', genre: 'Drum & Bass', bpm: 174, kit: 'Breaks', color: '#86b85a', traits: ['Nimble', 'Energetic'],
    blurb: 'Fast and nimble. Two-step breakbeats with ghost snares, ride cymbals and rapid-fire fills.',
    def: { cx: 0.55, loud: 0.7, fill: 0.45, swing: 0.05, feel: -0.1, hum: 0.2 },
    four: false, fills: ['break', 'toms', 'roll'], build: false, riser: false, dropGap: false, rollPiece: 'snare', crashEvery: 8,
    lanes: [
      L('kick', ['X.........X.....', 'X.........x..o..', 'X.o.......X.....', 'X.........X.o...']),
      L('snare', ['....X.......X...', '....X..g....X..g', '....X.g.g...X...', '.g..X..g.g..X...']),
      L('chh', ['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.xx', 'x-x-x-x-x-x-x-x-', 'xxx.xxx.xxx.xxx.'], { vel: 0.75 }),
      L('ride', ['x.x.x.x.x.x.x.x.'], { loudMin: 0.55, vel: 0.7 }),
      L('ohh', ['......o.......o.'], { cx: 0.4 }),
      L('shaker', ['-x-x-x-x-x-x-x-x'], { cx: 0.65, vel: 0.8 }),
    ],
  },
  {
    id: 'milo', name: 'Milo', genre: 'Lo-Fi / Chill', bpm: 85, kit: 'Lo-Fi', color: '#9aa5b1', traits: ['Mellow', 'Laid-back'],
    blurb: 'Relaxed and dusty. Lazy swung grooves played softly and a little behind the beat.',
    def: { cx: 0.4, loud: 0.35, fill: 0.25, swing: 0.55, feel: 0.55, hum: 0.45 },
    four: false, fills: ['perc', 'toms'], build: false, riser: false, dropGap: false, rollPiece: 'snare', crashEvery: 16,
    lanes: [
      L('kick', ['X......x..X.....', 'X.......x.X.....', 'X......x..x..o..', 'X..o......X.....']),
      L('snare', ['....X.......X...', '....X.......X..g', '....X..g....X...', '....X.......X.g.'], { soft: 'rim', softBelow: 0.22 }),
      L('chh', ['x.-.x.-.x.-.x.-.', 'x.x.x.x.x.x.x.xo', 'x.-ox.-.x.-ox.-.', 'x.x.x.x.x.x.x.x.'], { vel: 0.75 }),
      L('ohh', ['..............o.'], { cx: 0.5 }),
      L('shaker', ['g.x.g.x.g.x.g.x.', '..x...x...x...x.'], { cx: 0.3 }),
      L('rim', ['......o.......o.', '...o.......o....'], { cx: 0.55, vel: 0.7 }),
    ],
  },
];
export const DRUMMER_BY_ID = Object.fromEntries(DRUMMERS.map((d) => [d.id, d]));
export const drummerById = (id) => DRUMMER_BY_ID[id] || DRUMMERS[0];
export const PERSONALITIES = [...new Set(DRUMMERS.flatMap((d) => d.traits))];

// ----------------------------------------------------------------- settings
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const newSeed = () => (Math.random() * 0x7fffffff) | 0;

export function newDrummerSettings(id = 'nova', over = {}) {
  const d = drummerById(id);
  return {
    id: d.id, cx: d.def.cx, loud: d.def.loud, fill: d.def.fill, speed: 'normal', swing: d.def.swing, feel: d.def.feel, hum: d.def.hum,
    parts: Object.fromEntries(PARTS.map((p) => [p.id, { on: true, v: 0 }])), seed: newSeed(), ...over,
  };
}
export function normDrummerSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = drummerById(r.id);
  const parts = {};
  for (const p of PARTS) {
    const x = (r.parts && r.parts[p.id]) || {};
    parts[p.id] = { on: x.on !== false, v: clamp(Math.round(num(x.v, 0)), 0, 3) };
  }
  return {
    id: d.id, cx: clamp(num(r.cx, d.def.cx), 0, 1), loud: clamp(num(r.loud, d.def.loud), 0, 1), fill: clamp(num(r.fill, d.def.fill), 0, 1),
    speed: SPEEDS.includes(r.speed) ? r.speed : 'normal', swing: clamp(num(r.swing, d.def.swing), 0, 1), feel: clamp(num(r.feel, d.def.feel), -1, 1),
    hum: clamp(num(r.hum, d.def.hum), 0, 1), parts, seed: Math.abs(Math.round(num(r.seed, 1))) | 0,
  };
}

// ----------------------------------------------------------------- generation
function rng(seed) {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const hash = (a, b) => (Math.imul(a ^ 0x5bd1e995, 0x01000193) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
const PART_OF = PIECES.map((p) => p.part);
const MAIN = new Set([PC.kick, PC.snare, PC.clap, PC.tomL, PC.tomM, PC.tomH]); // follows Speed
const RISER = [PC.riser1, PC.riser2, PC.riser4];

// Plan which bars carry a fill, a pickup or a build.
function planBars(D, s, nBars, barLen) {
  const plan = [];
  const f = s.fill, phrase = f < 0.4 ? 8 : 4;
  const span = f < 0.35 ? 1 : f < 0.65 ? 2 : Math.min(4, barLen);
  const build = D.build && f >= 0.75 && nBars >= 8;
  for (let b = 0; b < nBars; b++) {
    const r = rng(hash(s.seed, b * 31 + 7));
    const last = b === nBars - 1, phraseEnd = (b + 1) % phrase === 0;
    let p = null;
    if (build && b >= nBars - 2) p = { kind: 'build', first: b === nBars - 2 };
    else if (f > 0.02 && ((last && f >= 0.2 && nBars >= 2) || (phraseEnd && !last))) {
      let kind = D.fills[Math.floor(r() * D.fills.length)];
      if (kind === 'gap' && !(f >= 0.5 && (last || (b + 1) % 8 === 0))) kind = D.fills.find((k) => k !== 'gap') || 'roll';
      p = { kind, span: kind === 'gap' ? Math.max(1, span) : span };
    } else if (f >= 0.55 && (b + 1) % 2 === 0 && r() < (f - 0.5) * 1.4) p = { kind: 'pickup', span: 0.5 };
    plan.push(p);
  }
  return plan;
}

// One bar of fill hits: push(pieceIndex, beatInBar, velocity 0..1)
function fillHits(D, s, kind, F, E, r, push) {
  const S = E - F, f = s.fill;
  const roll = (a, b, steps) => {
    for (const [s0, s1, st] of steps) for (let t = s0; t < s1 - 1e-9; t += st) {
      const u = (t - a) / Math.max(1e-6, b - a);
      push(PC[D.rollPiece], t, 0.38 + 0.62 * Math.pow(u, 0.8) + (Math.abs(t - Math.round(t)) < 1e-9 ? 0.06 : 0));
    }
  };
  const rollSteps = (a, b) => {
    const n = b - a;
    if (n >= 8) return [[a, a + 4, 1], [a + 4, a + 6, 0.5], [a + 6, a + 7, 0.25], [a + 7, b, 0.125]];
    if (n >= 4) return [[a, a + 2, 0.5], [a + 2, a + 3, 0.25], [a + 3, b, f > 0.7 ? 0.125 : 0.25]];
    if (n >= 2) return [[a, a + 1, f > 0.5 ? 0.25 : 0.5], [a + 1, b, f > 0.75 ? 0.125 : 0.25]];
    return [[a, b, n <= 0.5 ? 0.25 : f > 0.85 ? 0.125 : 0.25]];
  };
  switch (kind) {
    case 'pickup': {
      const pc = r() < 0.5 ? PC[D.rollPiece] : PC.tomH;
      push(pc, E - 0.5, 0.55); push(pc, E - 0.25, 0.75);
      if (r() < 0.5) push(PC[D.rollPiece], E - 0.125, 0.5);
      break;
    }
    case 'roll': roll(F, E, rollSteps(F, E)); break;
    case 'gap': {
      const g = S >= 2 ? 1 : 0.5;
      if (E - g > F) roll(F, E - g, rollSteps(F, E - g));
      break;
    }
    case 'toms': {
      const st = 0.25, n = Math.round(S / st);
      for (let i = 0; i < n; i++) {
        const t = F + i * st, u = i / n;
        if (S >= 4 && u < 0.5 && i % 2) continue;
        const pc = u < 0.25 ? PC.snare : u < 0.5 ? PC.tomH : u < 0.75 ? PC.tomM : PC.tomL;
        push(pc, t, 0.62 + 0.38 * u);
      }
      push(PC.kick, F, 0.85); push(PC.kick, E - st, 0.8);
      break;
    }
    case 'stutter': {
      const a = Math.max(F, E - 2);
      if (a > F) { push(PC.kick, F, 0.9); push(PC.kick, F + 0.75, 0.8); push(PC.snare, F + 1, 0.95); if (a - F > 2) { push(PC.kick, F + 2, 0.85); push(PC.snare, F + 2.5, 0.7); } }
      for (let t = a; t < E - 1e-9; t += 0.5) {
        const lastEighth = t >= E - 0.5 - 1e-9, k = lastEighth ? 0 : Math.floor(r() * 3);
        if (k === 0) for (let j = 0; j < 4; j++) push(PC.snare, t + j * 0.125, 0.55 + 0.12 * j);
        else if (k === 1) { push(PC.kick, t, 0.9); push(PC.kick, t + 0.125, 0.7); push(PC.snare, t + 0.25, 0.9); }
        else { push(PC.tomL, t, 0.85); push(PC.tomM, t + 0.25, 0.8); }
      }
      break;
    }
    case 'trap': {
      push(PC.kick, F, 0.9);
      if (S >= 1) push(PC.kick, F + 0.75, 0.75);
      const rs = Math.max(F, E - 1);
      for (let t = F; t < rs - 1e-9; t += 0.25) push(PC.chh, t, Math.abs(t - Math.round(t)) < 1e-9 ? 0.75 : 0.55);
      for (let t = rs, i = 0; t < E - 1e-9; i++) { const st = t < rs + 0.5 ? 1 / 6 : 0.125; push(PC.chh, t, 0.45 + 0.5 * ((t - rs) / Math.max(0.5, E - rs))); t += st; }
      push(PC.snare, E - 0.25, 0.85);
      break;
    }
    case 'break': {
      const T = ['.g.x', 'g.xg', 'x.g.', '.xg.'];
      for (let b = F; b < E - 1e-9; b += 1) {
        const pat = T[Math.floor(r() * T.length)];
        for (let j = 0; j < 4; j++) { const ch = pat[j]; if (ch !== '.') push(PC.snare, b + j * 0.25, ch === 'x' ? 0.85 : 0.35); }
      }
      push(PC.kick, F, 0.9); push(PC.kick, F + 0.75, 0.75); if (S >= 3) push(PC.kick, F + 2.5, 0.8);
      push(PC.ohh, F + 0.5, 0.7); push(PC.snare, E - 0.25, 0.95);
      break;
    }
    case 'perc': {
      for (let t = F, i = 0; t < E - 0.25 - 1e-9; t += 0.25, i++) push(i % 2 ? PC.perc : PC.rim, t, 0.4 + 0.45 * ((t - F) / S));
      push(PC.clap, E - 0.25, 0.9);
      break;
    }
    default: break;
  }
}

// Generate a drummer region. Returns hits sorted by time:
// { k: piece index, p: MIDI note, s: beat from the region start, l: length, v: velocity 0..1 }
export function generateDrummer(settings, length, barLen = 4) {
  const s = normDrummerSettings(settings);
  const D = drummerById(s.id);
  const out = [];
  if (!(length > 0)) return out;
  const nBars = Math.ceil(length / barLen - 1e-9);
  const plan = planBars(D, s, nBars, barLen);
  const cx = s.cx, loud = s.loud;
  const pOpt = Math.pow(clamp((cx - 0.1) / 0.8, 0, 1), 1.2) * 0.9;
  const pGhost = cx < 0.3 ? 0 : clamp((cx - 0.3) / 0.6, 0, 1) * 0.85;
  const scale = s.speed === 'half' ? 2 : s.speed === 'double' ? 0.5 : 1;
  const on = (part) => s.parts[part] && s.parts[part].on;
  let crashNext = false;

  for (let b = 0; b < nBars; b++) {
    const r = rng(hash(s.seed, b));
    const bar0 = b * barLen, E = Math.min(barLen, length - bar0);
    const P = plan[b];
    const hits = [];
    const push = (k, t, v, l = 0.12) => { if (k >= 0 && t >= -1e-9 && t < E - 1e-9) hits.push({ k, t, v: clamp(v, 0.02, 1), l }); };
    // where the fill sits in this bar, and what it silences
    let F = E, mute = null, keepKick = false, gapFrom = E;
    if (P && P.kind === 'build') {
      F = 0; mute = new Set(['hats', 'kick']); keepKick = true;
      if (!P.first) mute.add('perc');
      if (!P.first && s.fill >= 0.85 && D.dropGap) gapFrom = E - 0.5;
    } else if (P) {
      F = Math.max(0, E - P.span);
      mute = new Set(P.kind === 'perc' || P.kind === 'pickup' ? ['kick'] : ['kick', 'hats']);
      keepKick = D.four && (P.kind === 'roll' || P.kind === 'perc' || P.kind === 'pickup');
      if (P.kind === 'gap') gapFrom = E - (P.span >= 2 ? 1 : 0.5);
    }

    // grooves
    for (let li = 0; li < D.lanes.length; li++) {
      const lane = D.lanes[li];
      let k = PC[lane.piece];
      const part = PART_OF[k];
      if (!on(part)) continue;
      if (lane.cx && cx < lane.cx) continue;
      if (lane.loudMin && loud < lane.loudMin) continue;
      if (lane.soft && loud < (lane.softBelow ?? 0.3)) k = PC[lane.soft];
      const pat = lane.pats[s.parts[part].v % lane.pats.length];
      const main = MAIN.has(k), st = main ? 0.25 * scale : 0.25;
      const n = Math.floor(E / st + 1e-9), off = main && scale === 2 ? (b % 2) * n : 0;
      for (let i = 0; i < n; i++) {
        const ch = pat[(off + i) % 16];
        if (ch === '.') continue;
        if (ch === 'o' && r() >= pOpt) continue;
        if (ch === 'g' && r() >= pGhost) continue;
        const t = i * st;
        if (t >= F - 1e-9 && mute && mute.has(part) && !(keepKick && k === PC.kick)) continue;
        push(k, t, VEL[ch] * (lane.vel || 1));
      }
    }
    // hi-hat rolls (trap / future bass)
    if (D.hatRolls && on('hats') && cx > 0.3) {
      const pr = D.hatRolls * ((cx - 0.3) / 0.7) * 0.6;
      for (let beat = 0; beat < Math.floor(E); beat++) {
        const a = beat + 0.5;
        if (a >= F - 1e-9 || r() >= pr) continue;
        for (let i = hits.length - 1; i >= 0; i--) if (hits[i].k === PC.chh && hits[i].t >= a - 1e-9 && hits[i].t < a + 0.5 - 1e-9) hits.splice(i, 1);
        const st = r() < 0.5 ? 1 / 6 : 0.125;
        for (let t = a, j = 0; t < a + 0.5 - 1e-9; t += st, j++) push(PC.chh, t, 0.45 + 0.12 * j);
      }
    }
    // four-on-the-floor builds double up the kick in the final bar
    if (P && P.kind === 'build' && !P.first && D.four && on('kick')) for (let t = 0.5; t < E; t += 1) push(PC.kick, t, 0.8);
    // fills
    if (P) {
      const fr = rng(hash(s.seed, b * 977 + 3));
      const fpush = (k, t, v) => { if (on(PART_OF[k])) push(k, t, v); };
      if (P.kind === 'build') { if (P.first) fillHits(D, s, 'roll', 0, 2 * barLen, fr, (k, t, v) => { if (t < E) fpush(k, t, v); }); else fillHits(D, s, 'roll', -barLen, barLen, fr, (k, t, v) => { if (t >= 0) fpush(k, t, v); }); }
      else fillHits(D, s, P.kind, F, E, fr, fpush);
      if (D.riser && on('cym') && s.fill >= 0.55) {
        if (P.kind === 'build' && P.first) push(PC.riser2, 0, 0.85, Math.min(2 * barLen, length - bar0));
        else if (P.kind !== 'build' && P.kind !== 'pickup' && P.span >= 4) push(PC.riser1, 0, 0.8, E);
      }
    }
    // pre-drop silence
    if (gapFrom < E) for (let i = hits.length - 1; i >= 0; i--) if (hits[i].t >= gapFrom - 1e-9 && !RISER.includes(hits[i].k)) hits.splice(i, 1);
    // crashes: region start (when loud), after fills, and on phrase starts when loud
    const crash = crashNext || (b === 0 && loud >= 0.45) || (b > 0 && b % D.crashEvery === 0 && loud >= 0.6);
    if (crash && on('cym')) { push(PC.crash, 0, 0.9); if (on('kick') && !hits.some((h) => h.k === PC.kick && h.t < 1e-6)) push(PC.kick, 0, 0.95); }
    crashNext = !!(P && P.kind !== 'pickup' && (P.kind !== 'build' || !P.first)); // crash on the downbeat after a fill

    // feel: swing, push/pull, humanize, loudness → velocity
    for (const h of hits) {
      let t = h.t;
      const q = t * 4, qi = Math.round(q);
      if (Math.abs(q - qi) < 1e-6 && qi % 2 === 1) t += s.swing / 12;
      const pc = PIECES[h.k].id;
      const isKick = pc === 'kick', isOneShot = !RISER.includes(h.k);
      if (!isKick && pc !== 'crash' && isOneShot) t += s.feel * 0.016;
      if (isOneShot) t += (r() * 2 - 1) * s.hum * (Math.abs(t - Math.round(t)) < 1e-6 && isKick ? 0.003 : 0.011);
      const ghost = h.v < 0.4;
      let v = h.v * (ghost ? 0.6 + 0.4 * loud : 0.38 + 0.62 * loud);
      v *= 1 + (r() * 2 - 1) * 0.12 * s.hum;
      const at = bar0 + Math.max(0, t);
      if (at >= length - 1e-9) continue;
      out.push({ k: h.k, p: PIECES[h.k].note, s: at, l: Math.min(h.l, length - at), v: clamp(v, 0.05, 1) });
    }
  }
  out.sort((a, b) => a.s - b.s || a.p - b.p);
  return out;
}

// Validate pattern data (used by the tests)
export function checkPatterns() {
  const bad = [];
  for (const d of DRUMMERS) for (const l of d.lanes) for (const p of l.pats) if (p.length !== 16 || /[^Xx\-og.]/.test(p)) bad.push(`${d.name} ${l.piece}: "${p}"`);
  for (const d of DRUMMERS) for (const l of d.lanes) if (PC[l.piece] === undefined || (l.soft && PC[l.soft] === undefined)) bad.push(`${d.name}: unknown piece ${l.piece}`);
  return bad;
}
