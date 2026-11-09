// Parameter definitions shared by the UI thread and the audio thread.
// No DOM access here: this module is imported by the AudioWorklet too.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Tempo-synced divisions, in quarter-note beats.
export const SYNC_DIVS = [
  { name: '8 bars', beats: 32 }, { name: '4 bars', beats: 16 }, { name: '2 bars', beats: 8 },
  { name: '1 bar', beats: 4 }, { name: '1/2', beats: 2 }, { name: '1/2 T', beats: 4 / 3 },
  { name: '1/4 D', beats: 1.5 }, { name: '1/4', beats: 1 }, { name: '1/4 T', beats: 2 / 3 },
  { name: '1/8 D', beats: 0.75 }, { name: '1/8', beats: 0.5 }, { name: '1/8 T', beats: 1 / 3 },
  { name: '1/16 D', beats: 0.375 }, { name: '1/16', beats: 0.25 }, { name: '1/16 T', beats: 1 / 6 },
  { name: '1/32', beats: 0.125 },
];
export const SYNC_DIV_NAMES = SYNC_DIVS.map((d) => d.name);
export const divIndex = (name) => SYNC_DIV_NAMES.indexOf(name);

function P(id, name, min, max, def, o = {}) {
  return {
    id, name, min, max, def,
    curve: o.curve || 'lin',
    skew: o.skew || 1,
    unit: o.unit || '',
    options: o.options || null,
    automatable: o.automatable !== false,
    short: o.short || name,
    bipolar: min < 0 && max > 0,
  };
}
const ENUM = (id, name, options, def, o = {}) => P(id, name, 0, options.length - 1, def, { automatable: false, ...o, curve: 'enum', options });
const BOOL = (id, name, def, o = {}) => P(id, name, 0, 1, def, { automatable: false, ...o, curve: 'bool' });
const INT = (id, name, min, max, def, o = {}) => P(id, name, min, max, def, { ...o, curve: 'int' });
const EXP = (id, name, min, max, def, o = {}) => P(id, name, min, max, def, { ...o, curve: 'exp' });

// ---------- normalized <-> real value mapping ----------
// Fader law: gain = 2 * n^3  (n = 0.7937 -> 0 dB, n = 1 -> +6 dB)
export const faderNormToDb = (n) => (n <= 0.0005 ? -70 : Math.max(-70, 20 * Math.log10(2 * n * n * n)));
export const faderDbToNorm = (db) => (db <= -69.9 ? 0 : Math.cbrt(Math.pow(10, db / 20) / 2));
export const dbToGain = (db) => (db <= -69.9 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0.0000003 ? -70 : 20 * Math.log10(g));

export function toNorm(d, v) {
  switch (d.curve) {
    case 'exp': return clamp(Math.log(v / d.min) / Math.log(d.max / d.min), 0, 1);
    case 'pow': return clamp(Math.pow((v - d.min) / (d.max - d.min), 1 / d.skew), 0, 1);
    case 'fader': return clamp(faderDbToNorm(v), 0, 1);
    default: return d.max === d.min ? 0 : clamp((v - d.min) / (d.max - d.min), 0, 1);
  }
}

export function fromNorm(d, n) {
  n = clamp(n, 0, 1);
  switch (d.curve) {
    case 'exp': return d.min * Math.pow(d.max / d.min, n);
    case 'pow': return d.min + (d.max - d.min) * Math.pow(n, d.skew);
    case 'fader': return faderNormToDb(n);
    case 'int': case 'enum': case 'bool': return Math.round(d.min + (d.max - d.min) * n);
    default: return d.min + (d.max - d.min) * n;
  }
}

export function isDiscrete(d) { return d.curve === 'int' || d.curve === 'enum' || d.curve === 'bool'; }

export function formatValue(d, v) {
  if (d.curve === 'enum') return d.options[Math.round(v)] ?? '';
  if (d.curve === 'bool') return v >= 0.5 ? 'On' : 'Off';
  const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '');
  switch (d.unit) {
    case 'Hz': return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : v.toFixed(v < 100 ? 1 : 0) + ' Hz';
    case 's': return v < 1 ? (v * 1000).toFixed(v < 0.01 ? 1 : 0) + ' ms' : v.toFixed(2) + ' s';
    case 'ms': return v.toFixed(v < 10 ? 1 : 0) + ' ms';
    case 'dB': return d.curve === 'fader' && v <= -69.9 ? '−∞ dB' : sign(v) + Math.abs(v).toFixed(1) + ' dB';
    case '%': return Math.round(v * 100) + '%';
    case 'ct': return sign(v) + Math.abs(v).toFixed(0) + ' ct';
    case 'st': return sign(v) + (d.curve === 'int' ? Math.abs(v) : Math.abs(v).toFixed(1)) + ' st';
    case 'oct': return sign(v) + Math.abs(v) + ' oct';
    case 'pan': return Math.abs(v) < 0.005 ? 'C' : v < 0 ? Math.round(-v * 100) + 'L' : Math.round(v * 100) + 'R';
    case '°': return Math.round(v) + '°';
    case ':1': return v.toFixed(1) + ':1';
    case 'v': return Math.round(v) + (Math.round(v) === 1 ? ' voice' : ' voices');
    case '×': return v.toFixed(2) + '×';
    case 'feel': return Math.abs(v) < 0.02 ? 'On the beat' : v < 0 ? `Pushed ${Math.round(-v * 100)}%` : `Laid back ${Math.round(v * 100)}%`;
    default: return d.curve === 'int' ? String(Math.round(v)) : (d.bipolar ? sign(v) + Math.abs(v).toFixed(2) : v.toFixed(2));
  }
}

// ---------- effects (used as mixer inserts and inside Saw Forge) ----------
export const EFFECT_DEFS = {
  eq: {
    name: 'EQ Four', short: 'EQ', params: [
      EXP('lf', 'Low Freq', 20, 1000, 120, { unit: 'Hz' }), P('lg', 'Low Gain', -18, 18, 0, { unit: 'dB' }),
      EXP('m1f', 'Mid 1 Freq', 60, 12000, 500, { unit: 'Hz' }), P('m1g', 'Mid 1 Gain', -18, 18, 0, { unit: 'dB' }), EXP('m1q', 'Mid 1 Q', 0.2, 10, 0.9),
      EXP('m2f', 'Mid 2 Freq', 200, 16000, 3000, { unit: 'Hz' }), P('m2g', 'Mid 2 Gain', -18, 18, 0, { unit: 'dB' }), EXP('m2q', 'Mid 2 Q', 0.2, 10, 0.9),
      EXP('hf', 'High Freq', 1000, 20000, 8000, { unit: 'Hz' }), P('hg', 'High Gain', -18, 18, 0, { unit: 'dB' }),
      P('out', 'Output', -18, 18, 0, { unit: 'dB' }),
    ],
  },
  compressor: {
    name: 'Compressor', short: 'Comp', params: [
      P('thr', 'Threshold', -60, 0, -18, { unit: 'dB' }), EXP('ratio', 'Ratio', 1, 20, 4, { unit: ':1' }),
      EXP('att', 'Attack', 0.1, 200, 10, { unit: 'ms' }), EXP('rel', 'Release', 5, 2000, 120, { unit: 'ms' }),
      P('knee', 'Knee', 0, 18, 6, { unit: 'dB' }), P('makeup', 'Makeup', 0, 24, 0, { unit: 'dB' }),
      P('mix', 'Mix', 0, 1, 1, { unit: '%' }),
    ],
  },
  distortion: {
    name: 'Distortion', short: 'Dist', params: [
      ENUM('type', 'Type', ['Soft', 'Hard', 'Fold', 'Tube'], 0), P('drive', 'Drive', 0, 48, 12, { unit: 'dB' }),
      EXP('tone', 'Tone', 200, 20000, 12000, { unit: 'Hz' }), P('mix', 'Mix', 0, 1, 1, { unit: '%' }),
      P('out', 'Output', -24, 6, -6, { unit: 'dB' }),
    ],
  },
  chorus: {
    name: 'Chorus', short: 'Chorus', params: [
      EXP('rate', 'Rate', 0.05, 8, 0.6, { unit: 'Hz' }), P('depth', 'Depth', 0, 1, 0.5, { unit: '%' }),
      P('delay', 'Delay', 2, 30, 8, { unit: 'ms' }), P('fb', 'Feedback', 0, 0.9, 0.1, { unit: '%' }),
      P('width', 'Width', 0, 1, 1, { unit: '%' }), P('mix', 'Mix', 0, 1, 0.4, { unit: '%' }),
    ],
  },
  delay: {
    name: 'Delay', short: 'Delay', params: [
      BOOL('sync', 'Sync', 1), ENUM('div', 'Division', SYNC_DIV_NAMES, divIndex('1/8 D')),
      EXP('time', 'Time', 1, 2000, 375, { unit: 'ms' }), P('fb', 'Feedback', 0, 0.95, 0.35, { unit: '%' }),
      EXP('damp', 'Damping', 500, 20000, 6000, { unit: 'Hz' }), BOOL('pp', 'Ping-Pong', 1),
      P('mix', 'Mix', 0, 1, 0.25, { unit: '%' }),
    ],
  },
  reverb: {
    name: 'Reverb', short: 'Verb', params: [
      P('pre', 'Pre-Delay', 0, 200, 10, { unit: 'ms' }), P('size', 'Size', 0, 1, 0.6, { unit: '%' }),
      EXP('decay', 'Decay', 0.2, 20, 2.4, { unit: 's' }), EXP('damp', 'Damping', 500, 20000, 7000, { unit: 'Hz' }),
      P('width', 'Width', 0, 1, 1, { unit: '%' }), P('mix', 'Mix', 0, 1, 0.25, { unit: '%' }),
    ],
  },
  filter: {
    name: 'Auto Filter', short: 'Filter', params: [
      ENUM('mode', 'Mode', ['Low-pass', 'High-pass', 'Band-pass', 'Notch'], 0),
      EXP('cut', 'Cutoff', 20, 20000, 2000, { unit: 'Hz' }), P('res', 'Resonance', 0, 1, 0.2, { unit: '%' }),
      P('drive', 'Drive', 0, 24, 0, { unit: 'dB' }), P('mix', 'Mix', 0, 1, 1, { unit: '%' }),
    ],
  },
  limiter: {
    name: 'Limiter', short: 'Limit', params: [
      P('gain', 'Input Gain', 0, 24, 0, { unit: 'dB' }), P('ceil', 'Ceiling', -12, 0, -0.3, { unit: 'dB' }),
      EXP('rel', 'Release', 1, 1000, 80, { unit: 'ms' }),
    ],
  },
  utility: {
    name: 'Utility', short: 'Util', params: [
      P('gain', 'Gain', -36, 24, 0, { unit: 'dB' }), P('width', 'Width', 0, 2, 1, { unit: '%' }),
      P('pan', 'Pan', -1, 1, 0, { unit: 'pan' }), BOOL('mono', 'Mono', 0),
    ],
  },
};
export const EFFECT_TYPES = Object.keys(EFFECT_DEFS);
export function effectDefaults(type) {
  return Object.fromEntries(EFFECT_DEFS[type].params.map((p) => [p.id, p.def]));
}
export function effectParamIndex(type, pid) { return EFFECT_DEFS[type].params.findIndex((p) => p.id === pid); }

// ---------- mixer ----------
export const MIX_PARAMS = {
  vol: P('vol', 'Volume', -70, 6, 0, { unit: 'dB', curve: 'fader' }),
  pan: P('pan', 'Pan', -1, 1, 0, { unit: 'pan' }),
  send: P('send', 'Send', -70, 6, -70, { unit: 'dB', curve: 'fader' }),
};

// ---------- Saw Forge ----------
export const MOD_SOURCES = ['Off', 'LFO 1', 'LFO 2', 'Amp Env', 'Filter Env', 'Mod Env', 'Velocity', 'Key', 'Mod Wheel', 'Pitch Bend', 'Random', 'Drift'];
export const SRC = { OFF: 0, LFO1: 1, LFO2: 2, AENV: 3, FENV: 4, MENV: 5, VEL: 6, KEY: 7, MW: 8, PB: 9, RND: 10, DRIFT: 11 };
export const MOD_DESTS = ['Off', 'A Pitch', 'B Pitch', 'A+B Pitch', 'A WT Pos', 'B WT Pos', 'A+B WT Pos', 'A Level', 'B Level',
  'A Pulse', 'B Pulse', 'A Sync', 'B Sync', 'Unison Detune', 'Sub Level', 'Noise Level', 'Cutoff', 'Resonance', 'Drive',
  'Amp', 'Pan', 'LFO 1 Rate', 'LFO 2 Rate'];
export const DEST = {
  OFF: 0, A_PITCH: 1, B_PITCH: 2, AB_PITCH: 3, A_POS: 4, B_POS: 5, AB_POS: 6, A_LVL: 7, B_LVL: 8, A_PULSE: 9, B_PULSE: 10,
  A_SYNC: 11, B_SYNC: 12, DETUNE: 13, SUB: 14, NOISE: 15, CUT: 16, RES: 17, DRIVE: 18, AMP: 19, PAN: 20, LFO1_RATE: 21, LFO2_RATE: 22,
};
export const MATRIX_SLOTS = 8;
export const FILTER_MODES = ['LP 12', 'LP 24', 'Ladder', 'HP 12', 'BP 12', 'Off'];
export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square', 'S&H', 'Smooth Rnd'];
export const SYNTH_FX = ['distortion', 'chorus', 'delay', 'reverb', 'eq'];

const osc = (k, L, on) => [
  BOOL(`${k}.on`, `${L} On`, on),
  P(`${k}.level`, `${L} Level`, 0, 1, 0.8, { unit: '%', short: 'Level' }),
  P(`${k}.pos`, `${L} WT Position`, 0, 1, 0, { unit: '%', short: 'WT Pos' }),
  INT(`${k}.oct`, `${L} Octave`, -3, 3, 0, { unit: 'oct', short: 'Oct' }),
  INT(`${k}.semi`, `${L} Semitone`, -12, 12, 0, { unit: 'st', short: 'Semi' }),
  P(`${k}.fine`, `${L} Fine`, -100, 100, 0, { unit: 'ct', short: 'Fine' }),
  INT(`${k}.uni`, `${L} Unison`, 1, 8, 1, { unit: 'v', short: 'Unison', automatable: false }),
  P(`${k}.detune`, `${L} Detune`, 0, 100, 18, { unit: 'ct', curve: 'pow', skew: 2, short: 'Detune' }),
  P(`${k}.spread`, `${L} Stereo Spread`, 0, 1, 0.7, { unit: '%', short: 'Spread' }),
  P(`${k}.phase`, `${L} Phase`, 0, 360, 0, { unit: '°', short: 'Phase' }),
  P(`${k}.rand`, `${L} Phase Random`, 0, 1, 1, { unit: '%', short: 'Rand' }),
  P(`${k}.pulse`, `${L} Pulse Shape`, 0, 1, 0, { unit: '%', short: 'Pulse' }),
  P(`${k}.width`, `${L} Pulse Width`, 0.02, 0.98, 0.5, { unit: '%', short: 'Width' }),
  P(`${k}.sync`, `${L} Sync`, 0, 48, 0, { unit: 'st', short: 'Sync' }),
  P(`${k}.pan`, `${L} Pan`, -1, 1, 0, { unit: 'pan', short: 'Pan' }),
];
const env = (k, L, d) => [
  EXP(`${k}.a`, `${L} Attack`, 0.0005, 20, d[0], { unit: 's', short: 'A' }),
  EXP(`${k}.d`, `${L} Decay`, 0.001, 20, d[1], { unit: 's', short: 'D' }),
  P(`${k}.s`, `${L} Sustain`, 0, 1, d[2], { unit: '%', short: 'S' }),
  EXP(`${k}.r`, `${L} Release`, 0.001, 20, d[3], { unit: 's', short: 'R' }),
];
const lfo = (k, L) => [
  ENUM(`${k}.shape`, `${L} Shape`, LFO_SHAPES, 0, { short: 'Shape' }),
  BOOL(`${k}.sync`, `${L} Tempo Sync`, 1, { short: 'Sync' }),
  EXP(`${k}.rate`, `${L} Rate`, 0.02, 40, 2, { unit: 'Hz', short: 'Rate' }),
  ENUM(`${k}.div`, `${L} Division`, SYNC_DIV_NAMES, divIndex('1/4'), { short: 'Div' }),
  BOOL(`${k}.retrig`, `${L} Retrigger`, 1, { short: 'Retrig' }),
  P(`${k}.phase`, `${L} Phase`, 0, 1, 0, { unit: '%', short: 'Phase' }),
];
const matrix = [];
for (let i = 0; i < MATRIX_SLOTS; i++) {
  matrix.push(ENUM(`m${i}.src`, `Mod ${i + 1} Source`, MOD_SOURCES, 0));
  matrix.push(ENUM(`m${i}.dst`, `Mod ${i + 1} Destination`, MOD_DESTS, 0));
  matrix.push(P(`m${i}.amt`, `Mod ${i + 1} Amount`, -1, 1, 0, { short: 'Amt' }));
}
const synthFx = [];
for (const type of SYNTH_FX) {
  synthFx.push(BOOL(`fx.${type}.on`, `FX ${EFFECT_DEFS[type].short} On`, 0));
  for (const p of EFFECT_DEFS[type].params) {
    synthFx.push({ ...p, id: `fx.${type}.${p.id}`, name: `FX ${EFFECT_DEFS[type].short} ${p.name}`, short: p.short });
  }
}

export const SYNTH_PARAMS = [
  ...osc('a', 'Osc A', 1), ...osc('b', 'Osc B', 0),
  BOOL('sub.on', 'Sub On', 0), P('sub.level', 'Sub Level', 0, 1, 0.5, { unit: '%', short: 'Level' }),
  ENUM('sub.oct', 'Sub Octave', ['−1 oct', '−2 oct'], 0, { short: 'Oct' }), ENUM('sub.shape', 'Sub Shape', ['Sine', 'Triangle', 'Square'], 0, { short: 'Shape' }),
  BOOL('noise.on', 'Noise On', 0), P('noise.level', 'Noise Level', 0, 1, 0.15, { unit: '%', short: 'Level' }),
  ENUM('noise.color', 'Noise Color', ['White', 'Pink'], 0, { short: 'Color' }),
  P('an.drift', 'Analog Drift', 0, 1, 0.2, { unit: '%', short: 'Drift' }),
  P('an.var', 'Voice Variance', 0, 1, 0.15, { unit: '%', short: 'Variance' }),
  ENUM('flt.mode', 'Filter Mode', FILTER_MODES, 1, { short: 'Mode' }),
  EXP('flt.cut', 'Filter Cutoff', 20, 20000, 20000, { unit: 'Hz', short: 'Cutoff' }),
  P('flt.res', 'Filter Resonance', 0, 1, 0.1, { unit: '%', short: 'Res' }),
  P('flt.drive', 'Filter Drive', 0, 1, 0, { unit: '%', short: 'Drive' }),
  P('flt.env', 'Filter Env Amount', -1, 1, 0, { short: 'Env' }),
  P('flt.key', 'Filter Key Track', 0, 1, 0.5, { unit: '%', short: 'Key' }),
  P('flt.vel', 'Filter Velocity', 0, 1, 0, { unit: '%', short: 'Vel' }),
  ...env('aenv', 'Amp', [0.002, 0.35, 1, 0.25]),
  ...env('fenv', 'Filter', [0.002, 0.4, 0.2, 0.35]),
  ...env('menv', 'Mod', [0.002, 0.6, 0, 0.6]),
  ...lfo('lfo1', 'LFO 1'), ...lfo('lfo2', 'LFO 2'),
  ENUM('v.mode', 'Voice Mode', ['Poly', 'Mono', 'Legato'], 0, { short: 'Mode' }),
  INT('v.poly', 'Polyphony', 1, 16, 8, { short: 'Voices', automatable: false }),
  P('v.glide', 'Glide', 0, 2, 0, { unit: 's', curve: 'pow', skew: 3, short: 'Glide' }),
  INT('v.bend', 'Bend Range', 0, 24, 2, { unit: 'st', short: 'Bend', automatable: false }),
  P('v.vel', 'Velocity → Amp', 0, 1, 0.6, { unit: '%', short: 'Vel' }),
  P('out.gain', 'Output Gain', -36, 12, 0, { unit: 'dB', short: 'Output' }),
  ...matrix,
  ...synthFx,
];
export const SYNTH_INDEX = Object.fromEntries(SYNTH_PARAMS.map((p, i) => [p.id, i]));
export const SYNTH_DEF = Object.fromEntries(SYNTH_PARAMS.map((p) => [p.id, p]));
export function synthDefaults() { return Object.fromEntries(SYNTH_PARAMS.map((p) => [p.id, p.def])); }

// Smoothing class per parameter on the audio thread: 0 none, 1 linear, 2 geometric.
export function smoothKind(d) {
  if (isDiscrete(d)) return 0;
  if (d.id && /\.(a|d|r)$/.test(d.id) && /env/.test(d.id)) return 0; // envelope times need no smoothing
  return d.curve === 'exp' ? 2 : 1;
}
