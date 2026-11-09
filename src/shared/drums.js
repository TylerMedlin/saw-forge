// EDM drum kit: the pieces, how MIDI notes map to them, the synthesized kits
// and the kit's parameter set. Shared by the UI thread and the audio thread.
//
// Every sound is synthesized live on the audio thread (no samples), so a kit
// is just a table of numbers: kick pitch sweep, snare tone/noise, clap bursts,
// metallic hats, and so on.

function P(id, name, min, max, def, o = {}) {
  return { id, name, min, max, def, curve: o.curve || 'lin', skew: o.skew || 1, unit: o.unit || '', options: o.options || null,
    automatable: o.automatable !== false, short: o.short || name, bipolar: min < 0 && max > 0 };
}
const ENUM = (id, name, options, def, o = {}) => P(id, name, 0, options.length - 1, def, { automatable: false, ...o, curve: 'enum', options });
const EXP = (id, name, min, max, def, o = {}) => P(id, name, min, max, def, { ...o, curve: 'exp' });

// part: which Drummer control group plays the piece
export const PIECES = [
  { id: 'kick', name: 'Kick', note: 36, part: 'kick', level: 'l.kick' },
  { id: 'snare', name: 'Snare', note: 38, part: 'kick', level: 'l.snare' },
  { id: 'clap', name: 'Clap', note: 39, part: 'kick', level: 'l.snare' },
  { id: 'rim', name: 'Rim', note: 37, part: 'perc', level: 'l.perc' },
  { id: 'chh', name: 'Closed Hat', note: 42, part: 'hats', level: 'l.hats' },
  { id: 'ohh', name: 'Open Hat', note: 46, part: 'hats', level: 'l.hats' },
  { id: 'ride', name: 'Ride', note: 51, part: 'cym', level: 'l.cym' },
  { id: 'crash', name: 'Crash', note: 49, part: 'cym', level: 'l.cym' },
  { id: 'tomL', name: 'Low Tom', note: 41, part: 'kick', level: 'l.toms' },
  { id: 'tomM', name: 'Mid Tom', note: 45, part: 'kick', level: 'l.toms' },
  { id: 'tomH', name: 'High Tom', note: 48, part: 'kick', level: 'l.toms' },
  { id: 'shaker', name: 'Shaker', note: 70, part: 'perc', level: 'l.perc' },
  { id: 'perc', name: 'Perc', note: 56, part: 'perc', level: 'l.perc' },
  { id: 'riser1', name: 'Riser 1 bar', note: 84, part: 'cym', level: 'l.cym' },
  { id: 'riser2', name: 'Riser 2 bars', note: 85, part: 'cym', level: 'l.cym' },
  { id: 'riser4', name: 'Riser 4 bars', note: 86, part: 'cym', level: 'l.cym' },
];
export const PC = Object.fromEntries(PIECES.map((p, i) => [p.id, i]));
export const PIECE_BY_ID = Object.fromEntries(PIECES.map((p) => [p.id, p]));
export const NPIECES = PIECES.length;

// MIDI note → piece index (General MIDI drum layout plus the riser notes)
export const NOTE_MAP = new Int8Array(128).fill(-1);
for (const p of PIECES) NOTE_MAP[p.note] = PC[p.id];
for (const [n, id] of [[35, 'kick'], [40, 'snare'], [44, 'chh'], [43, 'tomL'], [47, 'tomM'], [50, 'tomH'], [53, 'ride'], [59, 'ride'],
  [57, 'crash'], [55, 'crash'], [52, 'crash'], [54, 'shaker'], [82, 'shaker'], [69, 'shaker'], [75, 'perc'], [76, 'perc'], [77, 'perc'],
  [60, 'perc'], [61, 'perc'], [62, 'perc'], [63, 'perc'], [64, 'perc']]) NOTE_MAP[n] = PC[id];
export const pieceForNote = (note) => (note >= 0 && note < 128 ? NOTE_MAP[note] : -1);
// Name shown on piano-roll rows of a drum track
export function drumNoteName(note) {
  const i = pieceForNote(note);
  if (i < 0) return '';
  const p = PIECES[i];
  return p.note === note ? p.name : `${p.name} (alt)`;
}

// ----------------------------------------------------------------- kits
// Units: Hz, seconds; lvl is a linear gain; mixes are 0..1.
const base = {
  kick: { f0: 230, f1: 50, pd: 0.032, d: 0.3, click: 0.5, drive: 0.4, lvl: 1 },
  snare: { tone: 200, td: 0.08, nd: 0.17, hp: 1300, snap: 0.7, lvl: 0.75 },
  clap: { f: 1250, q: 1.4, tail: 0.2, bursts: 4, gap: 0.0095, lvl: 0.85 },
  rim: { f: 1, d: 0.014, lvl: 0.45 },
  chh: { d: 0.038, cut: 7800, metal: 0.45, lvl: 0.42 },
  ohh: { d: 0.28, cut: 7200, metal: 0.45, lvl: 0.4 },
  ride: { d: 1.1, cut: 5200, bell: 0.4, lvl: 0.3 },
  crash: { d: 2, cut: 4200, lvl: 0.42 },
  toms: { f: [92, 128, 172], pd: 0.05, d: 0.32, lvl: 0.55 },
  shaker: { d: 0.06, cut: 6500, att: 0.009, lvl: 0.28 },
  perc: { f: 780, ratio: 1.41, index: 2.2, d: 0.08, lvl: 0.36 },
  riser: { f0: 350, f1: 9500, q: 2.2, lvl: 0.32 },
  lp: 20000,
};
function kit(name, desc, over) {
  const k = { name, desc };
  for (const key of Object.keys(base)) k[key] = typeof base[key] === 'object' && !Array.isArray(base[key]) ? { ...base[key], ...(over[key] || {}) } : (over[key] ?? base[key]);
  return k;
}
export const KITS = [
  kit('Festival', 'Big-room main stage: punchy driven kick, wide layered clap, bright crash', {
    kick: { f0: 290, f1: 52, pd: 0.028, d: 0.32, click: 0.65, drive: 0.65 }, clap: { f: 1350, tail: 0.24, lvl: 0.95 },
    snare: { tone: 210, nd: 0.2, snap: 0.8 }, crash: { d: 2.4, lvl: 0.48 }, riser: { lvl: 0.36 } }),
  kit('House', 'Warm 909-style kit: round kick, snappy clap, shuffling hats and shaker', {
    kick: { f0: 200, f1: 52, pd: 0.036, d: 0.28, click: 0.4, drive: 0.25 }, clap: { f: 1100, tail: 0.17, bursts: 3, gap: 0.011 },
    chh: { metal: 0.6, d: 0.035 }, ohh: { metal: 0.6, d: 0.24 }, shaker: { lvl: 0.34 }, perc: { f: 420, ratio: 1.5, index: 1.4, d: 0.12 } }),
  kit('Techno', 'Industrial: rumbling kick, tight metallic hats, clangy percussion', {
    kick: { f0: 165, f1: 45, pd: 0.045, d: 0.46, click: 0.3, drive: 0.85 }, clap: { f: 1600, tail: 0.14, bursts: 3 },
    chh: { d: 0.026, cut: 9000, metal: 0.8 }, ohh: { d: 0.2, cut: 8500, metal: 0.8 }, ride: { d: 0.9, bell: 0.65, lvl: 0.32 },
    perc: { f: 520, ratio: 2.71, index: 4, d: 0.13, lvl: 0.4 } }),
  kit('Trance', 'Clean and bright: tight kick, crisp clap, airy offbeat hats', {
    kick: { f0: 250, f1: 56, pd: 0.024, d: 0.22, click: 0.7, drive: 0.4 }, clap: { f: 1450, tail: 0.2 },
    ohh: { d: 0.22, cut: 8000 }, perc: { f: 1100, ratio: 2, index: 1.5, d: 0.05 } }),
  kit('Future', 'Future bass: soft-punch kick, huge snare, crisp hats for rolls', {
    kick: { f0: 220, f1: 48, pd: 0.032, d: 0.36, click: 0.45, drive: 0.3 },
    snare: { tone: 235, td: 0.09, nd: 0.24, hp: 1700, snap: 0.85, lvl: 0.85 }, clap: { f: 1500, tail: 0.3 },
    chh: { d: 0.03, cut: 9200, metal: 0.3 } }),
  kit('Trap', 'Booming 808 kick, sharp snare, tight rolling hats', {
    kick: { f0: 135, f1: 46, pd: 0.06, d: 0.95, click: 0.25, drive: 0.5 }, snare: { tone: 215, td: 0.06, nd: 0.14, snap: 0.8 },
    clap: { tail: 0.2 }, chh: { d: 0.024, cut: 9600, metal: 0.35 } }),
  kit('Heavy', 'Dubstep weight: slamming kick, cannon snare, long crash', {
    kick: { f0: 300, f1: 52, pd: 0.024, d: 0.3, click: 0.8, drive: 0.9 },
    snare: { tone: 180, td: 0.12, nd: 0.3, hp: 900, snap: 0.8, lvl: 0.95 }, clap: { lvl: 0.7 }, crash: { d: 2.8 },
    toms: { f: [80, 112, 150], d: 0.38 } }),
  kit('Breaks', 'Drum & bass: tight kick, cracking snare, ride and fast hats', {
    kick: { f0: 260, f1: 58, pd: 0.02, d: 0.2, click: 0.7, drive: 0.3 }, snare: { tone: 245, td: 0.06, nd: 0.12, hp: 2000, snap: 0.72 },
    chh: { d: 0.034 }, ride: { d: 1, lvl: 0.32 }, toms: { f: [110, 150, 200], d: 0.22 } }),
  kit('Lo-Fi', 'Dusty and soft: rounded kick, mellow snare, dark hats', {
    kick: { f0: 150, f1: 50, pd: 0.04, d: 0.26, click: 0.1, drive: 0.15 }, snare: { tone: 190, nd: 0.14, hp: 900, snap: 0.55 },
    chh: { d: 0.045, cut: 6000, metal: 0.25 }, ohh: { cut: 6000, metal: 0.25 }, shaker: { cut: 5000 }, lp: 6500 }),
];
export const KIT_NAMES = KITS.map((k) => k.name);
export const kitIndex = (name) => Math.max(0, KIT_NAMES.indexOf(name));

// ----------------------------------------------------------------- parameters
export const DRUM_PARAMS = [
  ENUM('kit', 'Kit', KIT_NAMES, 0),
  P('k.tune', 'Kick Tune', -12, 12, 0, { unit: 'st', short: 'Tune' }),
  EXP('k.decay', 'Kick Decay', 0.3, 3, 1, { unit: '×', short: 'Decay' }),
  P('k.punch', 'Kick Punch', 0, 1, 0.5, { unit: '%', short: 'Punch' }),
  P('s.tune', 'Snare Tune', -12, 12, 0, { unit: 'st', short: 'Tune' }),
  P('s.snap', 'Snare Snap', 0, 1, 0.5, { unit: '%', short: 'Snap' }),
  EXP('s.decay', 'Snare & Clap Decay', 0.3, 3, 1, { unit: '×', short: 'Decay' }),
  EXP('h.decay', 'Hi-Hat Decay', 0.3, 4, 1, { unit: '×', short: 'Decay' }),
  P('h.tone', 'Hi-Hat Tone', -1, 1, 0, { short: 'Tone' }),
  EXP('c.decay', 'Cymbal Decay', 0.3, 3, 1, { unit: '×', short: 'Cym Decay' }),
  P('t.tune', 'Tom Tune', -12, 12, 0, { unit: 'st', short: 'Tom Tune' }),
  P('l.kick', 'Kick Level', -30, 6, 0, { unit: 'dB', short: 'Kick' }),
  P('l.snare', 'Snare & Clap Level', -30, 6, 0, { unit: 'dB', short: 'Snare' }),
  P('l.hats', 'Hi-Hat Level', -30, 6, 0, { unit: 'dB', short: 'Hats' }),
  P('l.cym', 'Cymbals & FX Level', -30, 6, 0, { unit: 'dB', short: 'Cymbals' }),
  P('l.toms', 'Tom Level', -30, 6, 0, { unit: 'dB', short: 'Toms' }),
  P('l.perc', 'Percussion Level', -30, 6, 0, { unit: 'dB', short: 'Perc' }),
  P('width', 'Stereo Width', 0, 1, 0.6, { unit: '%', short: 'Width' }),
  P('drive', 'Drive', 0, 1, 0.15, { unit: '%', short: 'Drive' }),
  P('tone', 'Kit Tone', -1, 1, 0, { short: 'Tone' }),
  P('vel', 'Velocity Sensitivity', 0, 1, 0.8, { unit: '%', short: 'Velocity' }),
  P('out', 'Output', -24, 12, 0, { unit: 'dB', short: 'Output' }),
];
export const DRUM_INDEX = Object.fromEntries(DRUM_PARAMS.map((p, i) => [p.id, i]));
export const DRUM_DEF = Object.fromEntries(DRUM_PARAMS.map((p) => [p.id, p]));
export const DRUM_COUNT = DRUM_PARAMS.length;
export function drumDefaults() { return Object.fromEntries(DRUM_PARAMS.map((p) => [p.id, p.def])); }
export function drumParamArray(params) { return Float64Array.from(DRUM_PARAMS.map((d) => (params && typeof params[d.id] === 'number' ? params[d.id] : d.def))); }
