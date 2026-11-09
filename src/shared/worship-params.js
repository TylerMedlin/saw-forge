// Worship Atmospheres: parameter model, keys and the harmonic voicing engine.
// Shared by the UI thread and the audio thread (no DOM here).
//
// A patch is a flat parameter set (like Saw Forge) so it can be smoothed on
// the audio thread, edited with the same knob widgets and saved as JSON.
// The modules it describes, in signal-flow order:
//   Sources  (4 oscillator slots, noise/air texture, string ensemble, bass foundation)
//   Filters  (2 shared paraphonic filters; each source picks a filter)
//   Modulation (swell envelope, auto swell, 2 LFOs, EVOLVE, 6-slot matrix)
//   Layer mixer -> Effects (saturation, chorus, delay, reverb send, shimmer send)
//   Master   (stereo width/motion, low cut, 3-band EQ, trim, safety limiter)

import { SYNC_DIV_NAMES, divIndex } from './params.js';

function P(id, name, min, max, def, o = {}) {
  return { id, name, min, max, def, curve: o.curve || 'lin', skew: o.skew || 1, unit: o.unit || '', options: o.options || null,
    automatable: o.automatable !== false, short: o.short || name, bipolar: min < 0 && max > 0 };
}
const ENUM = (id, name, options, def, o = {}) => P(id, name, 0, options.length - 1, def, { automatable: false, ...o, curve: 'enum', options });
const BOOL = (id, name, def, o = {}) => P(id, name, 0, 1, def, { automatable: false, ...o, curve: 'bool' });
const INT = (id, name, min, max, def, o = {}) => P(id, name, min, max, def, { ...o, curve: 'int' });
const EXP = (id, name, min, max, def, o = {}) => P(id, name, min, max, def, { ...o, curve: 'exp' });

export const WAVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Pulse', 'Morph', 'Wavetable'];
export const W = { SINE: 0, TRI: 1, SAW: 2, SQUARE: 3, PULSE: 4, MORPH: 5, WT: 6 };
export const ROUTES = ['Filter 1', 'Filter 2', 'No filter'];
export const PAD_FILTERS = ['LP 12', 'LP 24', 'Ladder', 'HP 12', 'BP 12', 'Off'];
export const NOISE_TYPES = ['Pink', 'Brown', 'Air', 'Breath'];
export const STRING_TYPES = ['Warm Strings', 'Soft Violins', 'Cinematic Strings', 'Lush Ensemble', 'Ambient Strings',
  'Slow Swell Strings', 'Chamber Strings', 'Deep Cellos', 'High Strings', 'Analog String Machine'];
export const BASS_WAVES = ['Sine', 'Triangle', 'Soft Saw'];
export const PAD_LFO_SHAPES = ['Sine', 'Triangle', 'Smooth Random', 'Drift'];
export const VOICINGS = ['Root + Fifth', 'Root + Octave', 'Open Fifths', 'Triad', 'Add9', 'Sus2', 'Sus4', 'Seventh', 'Wide Worship', 'Custom'];
export const VC = { R5: 0, R8: 1, OPEN5: 2, TRIAD: 3, ADD9: 4, SUS2: 5, SUS4: 6, SEVENTH: 7, WIDE: 8, CUSTOM: 9 };
export const REGISTERS = ['Low', 'Mid', 'High'];
export const PAD_MOD_SOURCES = ['Off', 'LFO 1', 'LFO 2', 'Evolve', 'Swell', 'Mod Wheel', 'Velocity'];
export const PS = { OFF: 0, LFO1: 1, LFO2: 2, EVOLVE: 3, SWELL: 4, MW: 5, VEL: 6 };
export const PAD_MOD_DESTS = ['Off', 'Cutoff 1', 'Cutoff 2', 'Resonance 1', 'Resonance 2', 'Morph (all)', 'Osc 1 Morph', 'Osc 2 Morph',
  'Osc 3 Morph', 'Osc 4 Morph', 'Osc 1 Level', 'Osc 2 Level', 'Osc 3 Level', 'Osc 4 Level', 'Detune', 'Pitch', 'Pan / Width',
  'Pad Level', 'Strings Level', 'Strings Brightness', 'Noise Level', 'Chorus Mix', 'Reverb Send', 'Shimmer'];
export const PD = {
  OFF: 0, CUT1: 1, CUT2: 2, RES1: 3, RES2: 4, MORPH: 5, M1: 6, M2: 7, M3: 8, M4: 9, L1: 10, L2: 11, L3: 12, L4: 13,
  DETUNE: 14, PITCH: 15, PAN: 16, PAD: 17, STR: 18, STR_BRIGHT: 19, NOISE: 20, CHORUS: 21, REVERB: 22, SHIMMER: 23,
};
export const PAD_MATRIX = 6;
export const NOSC = 4;

const oscP = (n, on, wave) => {
  const k = `o${n}`, L = `Osc ${n}`;
  return [
    BOOL(`${k}.on`, `${L} On`, on),
    ENUM(`${k}.wave`, `${L} Wave`, WAVES, wave, { short: 'Wave' }),
    P(`${k}.morph`, `${L} Morph / WT Pos`, 0, 1, 0.5, { unit: '%', short: 'Morph' }),
    P(`${k}.pw`, `${L} Pulse Width`, 0.05, 0.95, 0.5, { unit: '%', short: 'Width' }),
    P(`${k}.level`, `${L} Level`, 0, 1, 0.7, { unit: '%', short: 'Level' }),
    INT(`${k}.oct`, `${L} Octave`, -3, 3, 0, { unit: 'oct', short: 'Oct' }),
    INT(`${k}.semi`, `${L} Semitone`, -12, 12, 0, { unit: 'st', short: 'Semi' }),
    P(`${k}.fine`, `${L} Fine`, -50, 50, 0, { unit: 'ct', short: 'Fine' }),
    INT(`${k}.uni`, `${L} Unison`, 1, 7, 3, { unit: 'v', short: 'Unison', automatable: false }),
    P(`${k}.detune`, `${L} Detune`, 0, 60, 12, { unit: 'ct', curve: 'pow', skew: 2, short: 'Detune' }),
    P(`${k}.spread`, `${L} Stereo Spread`, 0, 1, 0.7, { unit: '%', short: 'Spread' }),
    P(`${k}.drift`, `${L} Drift`, 0, 1, 0.3, { unit: '%', short: 'Drift' }),
    P(`${k}.pan`, `${L} Pan`, -1, 1, 0, { unit: 'pan', short: 'Pan' }),
    ENUM(`${k}.route`, `${L} Route`, ROUTES, 0, { short: 'Route' }),
  ];
};
const fltP = (n, type, cut) => [
  ENUM(`f${n}.type`, `Filter ${n} Type`, PAD_FILTERS, type, { short: 'Type' }),
  EXP(`f${n}.cut`, `Filter ${n} Cutoff`, 30, 18000, cut, { unit: 'Hz', short: 'Cutoff' }),
  P(`f${n}.res`, `Filter ${n} Resonance`, 0, 0.9, 0.12, { unit: '%', short: 'Res' }),
  P(`f${n}.drive`, `Filter ${n} Drive`, 0, 1, 0.1, { unit: '%', short: 'Drive' }),
  P(`f${n}.key`, `Filter ${n} Key Track`, 0, 1, 0.3, { unit: '%', short: 'Key' }),
  P(`f${n}.swell`, `Filter ${n} Swell Amount`, -1, 1, 0.25, { short: 'Swell' }),
];
const lfoP = (n, shape, rate) => [
  ENUM(`l${n}.shape`, `LFO ${n} Shape`, PAD_LFO_SHAPES, shape, { short: 'Shape' }),
  EXP(`l${n}.rate`, `LFO ${n} Rate`, 0.01, 8, rate, { unit: 'Hz', short: 'Rate' }),
  BOOL(`l${n}.sync`, `LFO ${n} Tempo Sync`, 0, { short: 'Sync' }),
  ENUM(`l${n}.div`, `LFO ${n} Division`, SYNC_DIV_NAMES, divIndex('2 bars'), { short: 'Div' }),
];
const matrix = [];
for (let i = 0; i < PAD_MATRIX; i++) {
  matrix.push(ENUM(`m${i}.src`, `Mod ${i + 1} Source`, PAD_MOD_SOURCES, 0));
  matrix.push(ENUM(`m${i}.dst`, `Mod ${i + 1} Destination`, PAD_MOD_DESTS, 0));
  matrix.push(P(`m${i}.amt`, `Mod ${i + 1} Amount`, -1, 1, 0, { short: 'Amt' }));
}

export const WORSHIP_PARAMS = [
  ...oscP(1, 1, W.SAW), ...oscP(2, 1, W.TRI), ...oscP(3, 0, W.SINE), ...oscP(4, 0, W.MORPH),
  // texture
  BOOL('nz.on', 'Noise On', 0), ENUM('nz.type', 'Noise Type', NOISE_TYPES, 2, { short: 'Type' }),
  P('nz.level', 'Noise Level', 0, 1, 0.25, { unit: '%', short: 'Level' }), EXP('nz.tone', 'Noise Tone', 200, 16000, 5000, { unit: 'Hz', short: 'Tone' }),
  ENUM('nz.route', 'Noise Route', ROUTES, 2, { short: 'Route' }),
  // strings
  BOOL('str.on', 'Strings On', 0), ENUM('str.type', 'String Sound', STRING_TYPES, 0, { short: 'Sound' }),
  P('str.vol', 'Strings Volume', 0, 1, 0.6, { unit: '%', short: 'Volume' }),
  EXP('str.attack', 'Strings Attack', 0.1, 30, 2.5, { unit: 's', short: 'Attack' }),
  EXP('str.release', 'Strings Release', 0.5, 60, 4, { unit: 's', short: 'Release' }),
  P('str.sustain', 'Strings Sustain', 0, 1, 0.9, { unit: '%', short: 'Sustain' }),
  P('str.swell', 'Strings Swell', 0, 1, 0.3, { unit: '%', short: 'Swell' }),
  P('str.width', 'Strings Width', 0, 1, 0.8, { unit: '%', short: 'Width' }),
  P('str.bright', 'Strings Brightness', 0, 1, 0.45, { unit: '%', short: 'Bright' }),
  P('str.vib', 'Strings Vibrato', 0, 1, 0.3, { unit: '%', short: 'Vibrato' }),
  P('str.ens', 'Strings Ensemble', 0, 1, 0.5, { unit: '%', short: 'Ensemble' }),
  INT('str.oct', 'Strings Octave', -2, 2, 0, { unit: 'oct', short: 'Oct' }),
  EXP('str.cut', 'Strings Cutoff', 300, 16000, 4500, { unit: 'Hz', short: 'Cutoff' }),
  P('str.rev', 'Strings Reverb Send', 0, 1, 0.5, { unit: '%', short: 'Reverb' }),
  P('str.blend', 'Strings / Pad Blend', 0, 1, 0.35, { unit: '%', short: 'Blend' }),
  // bass foundation
  BOOL('bass.on', 'Bass Foundation On', 0), P('bass.level', 'Bass Level', 0, 1, 0.4, { unit: '%', short: 'Level' }),
  INT('bass.oct', 'Bass Octave', -2, -1, -1, { unit: 'oct', short: 'Oct' }), ENUM('bass.wave', 'Bass Wave', BASS_WAVES, 0, { short: 'Wave' }),
  EXP('bass.lp', 'Bass Low-pass', 60, 600, 180, { unit: 'Hz', short: 'Tone' }),
  // filters
  ...fltP(1, 1, 2400), ...fltP(2, 0, 5000),
  // swell envelope (pad layers)
  EXP('sw.attack', 'Swell Attack', 0.1, 60, 4, { unit: 's', short: 'Attack' }),
  EXP('sw.decay', 'Swell Decay', 0.1, 30, 3, { unit: 's', short: 'Decay' }),
  P('sw.sustain', 'Sustain Level', 0, 1, 0.85, { unit: '%', short: 'Sustain' }),
  EXP('sw.release', 'Release', 0.5, 120, 6, { unit: 's', short: 'Release' }),
  P('sw.curve', 'Swell Curve', -1, 1, 0.3, { short: 'Curve' }),
  P('sw.intensity', 'Swell Intensity', 0, 1, 0.5, { unit: '%', short: 'Intensity' }),
  BOOL('sw.auto', 'Auto Swell', 0, { short: 'Auto' }),
  EXP('sw.period', 'Auto Swell Period', 4, 60, 16, { unit: 's', short: 'Period' }),
  P('sw.depth', 'Auto Swell Depth', 0, 0.85, 0.35, { unit: '%', short: 'Depth' }),
  // modulation
  ...lfoP(1, 0, 0.12), ...lfoP(2, 2, 0.05),
  P('ev.amount', 'Evolve', 0, 1, 0.4, { unit: '%', short: 'Evolve' }),
  EXP('ev.rate', 'Evolve Speed', 0.01, 0.5, 0.06, { unit: 'Hz', short: 'Speed' }),
  P('ev.morph', 'Evolve → Morph', 0, 1, 0.5, { unit: '%', short: 'Morph' }),
  P('ev.cutoff', 'Evolve → Cutoff', 0, 1, 0.5, { unit: '%', short: 'Cutoff' }),
  P('ev.detune', 'Evolve → Detune', 0, 1, 0.3, { unit: '%', short: 'Detune' }),
  P('ev.stereo', 'Evolve → Stereo', 0, 1, 0.4, { unit: '%', short: 'Stereo' }),
  P('ev.strings', 'Evolve → Strings', 0, 1, 0.4, { unit: '%', short: 'Strings' }),
  P('ev.amp', 'Evolve → Level', 0, 1, 0.2, { unit: '%', short: 'Level' }),
  // BREATHE: every note of the chord rises and falls on its own, slowly and softly
  P('br.amount', 'Breathe', 0, 1, 0, { unit: '%', short: 'Breathe' }),
  EXP('br.rate', 'Breathe Speed', 0.02, 1, 0.12, { unit: 'Hz', short: 'Speed' }),
  P('br.floor', 'Breathe Floor', 0, 0.9, 0.35, { unit: '%', short: 'Floor' }),
  BOOL('br.root', 'Breathe: Hold Lowest Note', 1, { short: 'Hold root' }),
  // 0: notes are mostly there and dip out now and then · 1: mostly away, drifting in now and then
  P('br.bias', 'Breathe Balance (in ↔ out)', 0, 1, 0, { unit: '%', short: 'In ↔ Out' }),
  ...matrix,
  // layer mixer
  P('mix.pad', 'Pad Layer', 0, 1.5, 1, { unit: '%', short: 'Pad' }),
  P('mix.str', 'Strings Layer', 0, 1.5, 1, { unit: '%', short: 'Strings' }),
  P('mix.bass', 'Bass Layer', 0, 1.5, 1, { unit: '%', short: 'Bass' }),
  P('mix.noise', 'Texture Layer', 0, 1.5, 1, { unit: '%', short: 'Texture' }),
  // effects
  BOOL('sat.on', 'Saturation On', 1), P('sat.drive', 'Saturation Drive', 0, 1, 0.25, { unit: '%', short: 'Drive' }),
  EXP('sat.tone', 'Saturation Tone', 1000, 18000, 9000, { unit: 'Hz', short: 'Tone' }),
  BOOL('ch.on', 'Chorus On', 1), EXP('ch.rate', 'Chorus Rate', 0.05, 3, 0.35, { unit: 'Hz', short: 'Rate' }),
  P('ch.depth', 'Chorus Depth', 0, 1, 0.45, { unit: '%', short: 'Depth' }), P('ch.mix', 'Chorus Mix', 0, 1, 0.35, { unit: '%', short: 'Mix' }),
  BOOL('dl.on', 'Delay On', 0), BOOL('dl.sync', 'Delay Sync', 1, { short: 'Sync' }), ENUM('dl.div', 'Delay Division', SYNC_DIV_NAMES, divIndex('1/4 D'), { short: 'Div' }),
  EXP('dl.time', 'Delay Time', 20, 2000, 600, { unit: 'ms', short: 'Time' }), P('dl.fb', 'Delay Feedback', 0, 0.9, 0.45, { unit: '%', short: 'Feedback' }),
  EXP('dl.damp', 'Delay Damping', 500, 16000, 3500, { unit: 'Hz', short: 'Damping' }), P('dl.mix', 'Delay Mix', 0, 1, 0.18, { unit: '%', short: 'Mix' }),
  BOOL('rv.on', 'Reverb On', 1), P('rv.size', 'Reverb Size', 0, 1, 0.85, { unit: '%', short: 'Size' }),
  EXP('rv.decay', 'Reverb Decay', 0.5, 20, 7, { unit: 's', short: 'Decay' }), EXP('rv.damp', 'Reverb Damping', 800, 16000, 5000, { unit: 'Hz', short: 'Damping' }),
  P('rv.pre', 'Reverb Pre-Delay', 0, 200, 30, { unit: 'ms', short: 'Pre' }), P('rv.send', 'Reverb Send', 0, 1, 0.45, { unit: '%', short: 'Send' }),
  BOOL('sh.on', 'Shimmer On', 0), P('sh.amount', 'Shimmer Amount', 0, 1, 0.3, { unit: '%', short: 'Amount' }),
  P('sh.fb', 'Shimmer Feedback', 0, 0.85, 0.5, { unit: '%', short: 'Feedback' }), EXP('sh.tone', 'Shimmer Tone', 1500, 14000, 6000, { unit: 'Hz', short: 'Tone' }),
  // master
  P('st.width', 'Stereo Width', 0, 2, 1.1, { unit: '%', short: 'Width' }), P('st.motion', 'Stereo Motion', 0, 1, 0.2, { unit: '%', short: 'Motion' }),
  EXP('out.lowcut', 'Pad Low Cut', 20, 400, 70, { unit: 'Hz', short: 'Low Cut' }),
  P('eq.low', 'EQ Low', -12, 12, 0, { unit: 'dB', short: 'Low' }), P('eq.mid', 'EQ Mid', -12, 12, 0, { unit: 'dB', short: 'Mid' }),
  EXP('eq.midf', 'EQ Mid Freq', 200, 6000, 900, { unit: 'Hz', short: 'Mid Hz' }), P('eq.high', 'EQ High', -12, 12, -1, { unit: 'dB', short: 'High' }),
  P('out.trim', 'Output Trim', -24, 12, 0, { unit: 'dB', short: 'Trim' }),
  // voicing (used by live mode and by chord-trigger mode on tracks)
  ENUM('vc.type', 'Voicing', VOICINGS, VC.WIDE, { short: 'Voicing' }), ENUM('vc.reg', 'Register', REGISTERS, 1, { short: 'Register' }),
  P('vc.density', 'Harmonic Density', 0, 1, 0.55, { unit: '%', short: 'Density' }), P('vc.spread', 'Voicing Spread', 0, 1, 0.6, { unit: '%', short: 'Spread' }),
  // playing behaviour on tracks
  ENUM('play.mode', 'Track Playing', ['Notes', 'Chord from root'], 0, { short: 'Play' }), BOOL('play.minor', 'Chord Minor', 0, { short: 'Minor' }),
  BOOL('play.hold', 'Infinite Sustain (hold)', 0, { short: 'Hold' }), INT('play.poly', 'Polyphony', 2, 16, 12, { short: 'Voices', automatable: false }),
];
export const WP_INDEX = Object.fromEntries(WORSHIP_PARAMS.map((p, i) => [p.id, i]));
export const WP_DEF = Object.fromEntries(WORSHIP_PARAMS.map((p) => [p.id, p]));
export const WP_COUNT = WORSHIP_PARAMS.length;
export function worshipDefaults() { return Object.fromEntries(WORSHIP_PARAMS.map((p) => [p.id, p.def])); }
export function worshipParamArray(params) { return Float64Array.from(WORSHIP_PARAMS.map((d) => (params && typeof params[d.id] === 'number' ? params[d.id] : d.def))); }

// ---------------------------------------------------------------- keys
export const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
// Spelling most songs use for each tonic (worship charts favour these).
const MAJOR_PREF = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_PREF = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
// spell: 'auto' | 'sharp' | 'flat'
export function keyName(pc, minor = false, spell = 'auto') {
  pc = ((pc % 12) + 12) % 12;
  const n = spell === 'sharp' ? SHARP_NAMES[pc] : spell === 'flat' ? FLAT_NAMES[pc] : (minor ? MINOR_PREF : MAJOR_PREF)[pc];
  return n + (minor ? 'm' : '');
}
export const altName = (pc) => (SHARP_NAMES[pc] === FLAT_NAMES[pc] ? '' : `${SHARP_NAMES[pc]} / ${FLAT_NAMES[pc]}`);
// "G", "Bb", "F#m", "C♯ minor", "Ebmaj" -> { pc, minor } or null
export function parseKey(text) {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|-)?\s*(maj|major)?\s*$/i.exec(String(text || ''));
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return { pc: (base + acc + 12) % 12, minor: !!m[3] && !m[4], spell: acc > 0 ? 'sharp' : acc < 0 ? 'flat' : 'auto' };
}

// ---------------------------------------------------------------- voicing engine
const REG_BASE = [36, 45, 55]; // lowest root placement for Low / Mid / High (C2, A2, G3)
// Chord intervals above the root, by voicing and tonality.
export function voicingIntervals(type, minor, custom = null) {
  const third = minor ? 3 : 4, seventh = minor ? 10 : 11;
  switch (type) {
    case VC.R5: return [0, 7, 12];
    case VC.R8: return [0, 12, 19];
    case VC.OPEN5: return [0, 7, 12, 19];
    case VC.TRIAD: return [0, third, 7, 12];
    case VC.ADD9: return [0, 7, 12, 14, 12 + third];
    case VC.SUS2: return [0, 7, 12, 14];
    case VC.SUS4: return [0, 7, 12, 17];
    case VC.SEVENTH: return [0, 7, 12 + third, seventh + 12, 19];
    case VC.CUSTOM: return custom && custom.length ? [...custom] : [0, 7, 12, 12 + third];
    case VC.WIDE: default: return [0, 7, 12, 14, 12 + third, 19];
  }
}
export function parseIntervals(text) {
  const v = String(text || '').split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x) && x >= -12 && x <= 36).map(Math.round);
  return v.length ? [...new Set(v)].sort((a, b) => a - b) : null;
}

// Spread the chord for a sustained pad: keeps thirds out of the muddy low
// register, thins or thickens with density, and (when `prev` is given) picks
// the octave whose average pitch is closest to the previous chord, so key
// changes move as little as possible (voice leading).
export function voiceChord({ root, minor, type, register = 1, density = 0.55, spread = 0.6, custom = null, prev = null }) {
  let iv = voicingIntervals(type, minor, custom);
  if (type !== VC.CUSTOM) {
    if (spread < 0.35) iv = iv.map((x) => (x > 12 && !iv.includes(x - 12) ? x - 12 : x));         // close voicing
    else if (spread > 0.75) iv = iv.map((x) => (x === 3 || x === 4 ? x + 12 : x));                 // open the third
    if (density < 0.3) iv = iv.slice(0, Math.max(2, Math.ceil(iv.length * 0.5)));
    else if (density < 0.55) iv = iv.slice(0, Math.max(2, iv.length - 1));
    else if (density > 0.8 && !iv.includes(24)) iv = [...iv, 24];
  }
  iv = [...new Set(iv)].sort((a, b) => a - b);
  const base = REG_BASE[Math.max(0, Math.min(2, register))];
  const pc = ((root % 12) + 12) % 12;
  let r0 = base + ((pc - (base % 12) + 12) % 12);
  const notesAt = (r) => iv.map((x) => {
    let n = r + x;
    const rel = ((x % 12) + 12) % 12;
    if ((rel === 3 || rel === 4) && n < 50) n += 12; // no low thirds
    return n;
  });
  if (prev && prev.length) {
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const target = avg(prev);
    let best = r0, bestD = Infinity;
    for (const r of [r0 - 12, r0, r0 + 12]) {
      if (r < base - 7 || r > base + 12) continue;
      const d = Math.abs(avg(notesAt(r)) - target);
      if (d < bestD - 1e-9) { bestD = d; best = r; }
    }
    r0 = best;
  }
  const notes = [...new Set(notesAt(r0))].filter((n) => n >= 24 && n <= 100).sort((a, b) => a - b);
  return { root: r0, notes };
}
