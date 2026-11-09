// Saw Forge factory presets. Each preset lists only the parameters that
// differ from the defaults, plus the wavetable shapes for oscillators A and B.

import { MOD_SOURCES, MOD_DESTS, divIndex, LFO_SHAPES, FILTER_MODES } from './params.js';

const mod = (slot, src, dst, amt) => ({
  [`m${slot}.src`]: MOD_SOURCES.indexOf(src), [`m${slot}.dst`]: MOD_DESTS.indexOf(dst), [`m${slot}.amt`]: amt,
});
const F = (name) => FILTER_MODES.indexOf(name);
const S = (name) => LFO_SHAPES.indexOf(name);
const env = (k, a, d, s, r) => ({ [`${k}.a`]: a, [`${k}.d`]: d, [`${k}.s`]: s, [`${k}.r`]: r });

export const PRESET_CATEGORIES = ['Init', 'Bass', 'Lead', 'Pluck', 'Pad', 'Supersaw', 'Keys', 'FX'];

export const FACTORY_PRESETS = [
  { name: 'Init Saw', category: 'Init', wt: ['Analog Saw', 'Saw → Square'], params: {} },

  { name: 'Forge Sub Bass', category: 'Bass', wt: ['Analog Saw', 'Saw → Square'], params: {
    'v.mode': 1, 'v.glide': 0.035, 'a.level': 0.7, 'a.rand': 0, 'sub.on': 1, 'sub.level': 0.75,
    'flt.mode': F('LP 24'), 'flt.cut': 210, 'flt.res': 0.2, 'flt.env': 0.36, 'flt.key': 0.3, 'flt.drive': 0.25,
    ...env('fenv', 0.001, 0.25, 0.15, 0.15), ...env('aenv', 0.001, 0.4, 0.85, 0.08), 'an.drift': 0.12,
  } },
  { name: 'Acid Ladder', category: 'Bass', wt: ['Ideal Saw', 'Saw → Square'], params: {
    'v.mode': 2, 'v.glide': 0.06, 'a.rand': 0, 'flt.mode': F('Ladder'), 'flt.cut': 320, 'flt.res': 0.8, 'flt.env': 0.45,
    'flt.drive': 0.45, 'flt.key': 0.2, 'flt.vel': 0.3, ...env('fenv', 0.001, 0.22, 0, 0.1), ...env('aenv', 0.001, 0.3, 0.8, 0.06),
    'fx.distortion.on': 1, 'fx.distortion.drive': 9, 'fx.distortion.mix': 0.5, 'fx.distortion.out': -4,
    'fx.delay.on': 1, 'fx.delay.mix': 0.16, 'fx.delay.fb': 0.35, 'fx.delay.div': divIndex('1/8 D'),
  } },
  { name: 'Reese Drift', category: 'Bass', wt: ['Analog Saw', 'Dark → Bright'], params: {
    'v.mode': 1, 'v.glide': 0.03, 'a.uni': 2, 'a.detune': 20, 'a.fine': -12, 'a.spread': 0.5,
    'b.on': 1, 'b.uni': 2, 'b.detune': 16, 'b.fine': 12, 'b.level': 0.7, 'b.pos': 0.4, 'b.spread': 0.5,
    'sub.on': 1, 'sub.level': 0.45, 'flt.mode': F('LP 24'), 'flt.cut': 900, 'flt.res': 0.15, 'flt.drive': 0.3, 'an.drift': 0.4,
    'lfo1.sync': 1, 'lfo1.div': divIndex('2 bars'), 'lfo1.retrig': 0, 'lfo2.sync': 1, 'lfo2.div': divIndex('1 bar'), 'lfo2.shape': S('Triangle'), 'lfo2.retrig': 0,
    ...mod(0, 'LFO 1', 'Cutoff', 0.07), ...mod(1, 'LFO 2', 'B WT Pos', 0.35), ...env('aenv', 0.003, 0.4, 0.9, 0.12),
  } },
  { name: 'Pulse Bass', category: 'Bass', wt: ['Analog Saw', 'Saw → Square'], params: {
    'v.mode': 1, 'a.pulse': 0.85, 'a.width': 0.3, 'a.rand': 0, 'lfo1.sync': 0, 'lfo1.rate': 0.35, 'lfo1.retrig': 0,
    'flt.mode': F('LP 24'), 'flt.cut': 520, 'flt.res': 0.22, 'flt.env': 0.32, ...env('fenv', 0.001, 0.3, 0.2, 0.2),
    ...env('aenv', 0.001, 0.4, 0.9, 0.1), ...mod(0, 'LFO 1', 'A Pulse', 0.25), 'sub.on': 1, 'sub.level': 0.35,
  } },

  { name: 'Sync Lead', category: 'Lead', wt: ['Analog Saw', 'Ideal Saw'], params: {
    'v.mode': 2, 'v.glide': 0.05, 'a.uni': 2, 'a.detune': 10, 'b.on': 1, 'b.fine': 7, 'b.level': 0.45,
    ...mod(0, 'Mod Env', 'A Sync', 0.45), ...env('menv', 0.001, 0.6, 0.12, 0.3), ...mod(1, 'LFO 1', 'A+B Pitch', 0.003),
    'lfo1.sync': 0, 'lfo1.rate': 5.5, 'lfo1.retrig': 0, 'flt.mode': F('LP 12'), 'flt.cut': 7000, 'flt.res': 0.2,
    'fx.delay.on': 1, 'fx.delay.mix': 0.2, 'fx.delay.fb': 0.3, 'fx.reverb.on': 1, 'fx.reverb.mix': 0.15, 'fx.reverb.decay': 2,
  } },
  { name: 'Formant Lead', category: 'Lead', wt: ['Formant Sweep', 'Analog Saw'], params: {
    'v.mode': 1, 'v.glide': 0.03, 'a.uni': 3, 'a.detune': 12, 'a.pos': 0.4, 'lfo1.shape': S('Triangle'), 'lfo1.div': divIndex('1 bar'), 'lfo1.retrig': 0,
    ...mod(0, 'LFO 1', 'A WT Pos', 0.4), 'flt.mode': F('LP 12'), 'flt.cut': 9000,
    'fx.chorus.on': 1, 'fx.chorus.mix': 0.3, 'fx.delay.on': 1, 'fx.delay.mix': 0.18,
  } },
  { name: 'Square Glide', category: 'Lead', wt: ['Saw → Square', 'Analog Saw'], params: {
    'v.mode': 2, 'v.glide': 0.08, 'a.pos': 1, 'a.uni': 2, 'a.detune': 6, 'flt.mode': F('LP 24'), 'flt.cut': 3200, 'flt.res': 0.3,
    'flt.env': 0.15, ...env('fenv', 0.01, 0.5, 0.4, 0.3), ...mod(0, 'Mod Wheel', 'A+B Pitch', 0.004), ...mod(1, 'LFO 1', 'Cutoff', 0.03),
    'lfo1.sync': 0, 'lfo1.rate': 5, 'fx.delay.on': 1, 'fx.delay.mix': 0.22, 'fx.reverb.on': 1, 'fx.reverb.mix': 0.18,
  } },

  { name: 'Glass Pluck', category: 'Pluck', wt: ['Analog Saw', 'Saw → Triangle'], params: {
    'a.uni': 2, 'a.detune': 8, 'b.on': 1, 'b.pos': 0.7, 'b.oct': 1, 'b.level': 0.35,
    'flt.mode': F('LP 24'), 'flt.cut': 340, 'flt.res': 0.25, 'flt.env': 0.55, 'flt.vel': 0.3,
    ...env('fenv', 0.001, 0.28, 0, 0.25), ...env('aenv', 0.001, 0.6, 0, 0.35), 'v.vel': 0.7,
    'fx.reverb.on': 1, 'fx.reverb.mix': 0.28, 'fx.reverb.decay': 2.8, 'fx.delay.on': 1, 'fx.delay.mix': 0.2,
  } },
  { name: 'Saw Pluck Delay', category: 'Pluck', wt: ['Ideal Saw', 'Saw → Square'], params: {
    'a.rand': 0, 'flt.mode': F('LP 24'), 'flt.cut': 480, 'flt.env': 0.5, ...env('fenv', 0.001, 0.18, 0, 0.2), ...env('aenv', 0.001, 0.35, 0, 0.2),
    'fx.delay.on': 1, 'fx.delay.mix': 0.3, 'fx.delay.fb': 0.45, 'fx.chorus.on': 1, 'fx.chorus.mix': 0.3,
  } },

  { name: 'Warm Analog Pad', category: 'Pad', wt: ['Analog Saw', 'Saw → Square'], params: {
    'a.uni': 4, 'a.detune': 14, 'a.spread': 0.8, 'b.on': 1, 'b.pos': 0.5, 'b.uni': 3, 'b.detune': 10, 'b.fine': 5, 'b.level': 0.6,
    'flt.mode': F('LP 24'), 'flt.cut': 1400, 'flt.res': 0.15, 'flt.env': 0.15, ...env('fenv', 1.2, 2, 0.6, 1.5), ...env('aenv', 0.9, 1.5, 0.85, 1.8),
    'an.drift': 0.55, 'an.var': 0.35, 'lfo1.sync': 0, 'lfo1.rate': 0.18, 'lfo1.retrig': 0, ...mod(0, 'LFO 1', 'Cutoff', 0.06),
    'fx.chorus.on': 1, 'fx.chorus.mix': 0.35, 'fx.reverb.on': 1, 'fx.reverb.mix': 0.35, 'fx.reverb.decay': 4.5, 'fx.reverb.size': 0.8, 'out.gain': -2,
  } },
  { name: 'Evolving Table Pad', category: 'Pad', wt: ['Formant Sweep', 'Dark → Bright'], params: {
    'a.uni': 3, 'a.pos': 0.5, 'b.on': 1, 'b.uni': 3, 'b.fine': -6, 'b.pos': 0.5, 'b.level': 0.6,
    'lfo1.shape': S('Triangle'), 'lfo1.div': divIndex('4 bars'), 'lfo1.retrig': 0, 'lfo2.div': divIndex('2 bars'), 'lfo2.retrig': 0,
    ...mod(0, 'LFO 1', 'A WT Pos', 0.5), ...mod(1, 'LFO 2', 'B WT Pos', 0.4), ...mod(2, 'Mod Env', 'Cutoff', 0.15),
    ...env('menv', 2, 3, 0.3, 2), 'flt.mode': F('LP 12'), 'flt.cut': 2500, ...env('aenv', 1.5, 2, 0.9, 2.5),
    'fx.reverb.on': 1, 'fx.reverb.mix': 0.4, 'fx.reverb.decay': 6, 'fx.delay.on': 1, 'fx.delay.mix': 0.15, 'an.drift': 0.3, 'out.gain': -3,
  } },

  { name: 'Hyper Supersaw', category: 'Supersaw', wt: ['Analog Saw', 'Analog Saw'], params: {
    'a.uni': 7, 'a.detune': 28, 'a.spread': 1, 'b.on': 1, 'b.uni': 7, 'b.detune': 18, 'b.spread': 0.9, 'b.oct': 1, 'b.level': 0.35,
    'flt.mode': F('LP 12'), 'flt.cut': 12000, 'flt.res': 0.05, ...env('aenv', 0.005, 0.5, 0.9, 0.45),
    'fx.chorus.on': 1, 'fx.chorus.mix': 0.25, 'fx.reverb.on': 1, 'fx.reverb.mix': 0.25, 'fx.reverb.decay': 3,
    'fx.eq.on': 1, 'fx.eq.lg': -3, 'fx.eq.lf': 150, 'fx.eq.hg': 2, 'out.gain': -3, 'an.drift': 0.2,
  } },
  { name: 'Trance Stack', category: 'Supersaw', wt: ['Ideal Saw', 'Analog Saw'], params: {
    'a.uni': 8, 'a.detune': 35, 'a.spread': 1, 'b.on': 1, 'b.uni': 6, 'b.detune': 25, 'b.oct': -1, 'b.level': 0.5,
    'flt.mode': F('LP 24'), 'flt.cut': 3500, 'flt.env': 0.25, ...env('fenv', 0.002, 0.5, 0.4, 0.4), ...mod(0, 'Velocity', 'Cutoff', 0.1),
    'fx.delay.on': 1, 'fx.delay.mix': 0.18, 'fx.reverb.on': 1, 'fx.reverb.mix': 0.3, ...env('aenv', 0.003, 0.5, 0.85, 0.6), 'out.gain': -4,
  } },

  { name: 'Poly Brass', category: 'Keys', wt: ['Analog Saw', 'Ideal Saw'], params: {
    'a.uni': 2, 'a.detune': 9, 'b.on': 1, 'b.fine': 8, 'b.level': 0.6, 'flt.mode': F('LP 24'), 'flt.cut': 500, 'flt.res': 0.1,
    'flt.env': 0.45, 'flt.vel': 0.35, ...env('fenv', 0.06, 0.5, 0.45, 0.4), ...env('aenv', 0.03, 0.4, 0.85, 0.35), 'an.drift': 0.4,
    'fx.chorus.on': 1, 'fx.chorus.mix': 0.2, 'fx.reverb.on': 1, 'fx.reverb.mix': 0.2,
  } },
  { name: 'Hollow Keys', category: 'Keys', wt: ['Hollow Saw', 'Saw → Triangle'], params: {
    'b.on': 1, 'b.pos': 1, 'b.oct': 1, 'b.level': 0.3, 'flt.mode': F('LP 12'), 'flt.cut': 2200, 'flt.env': 0.2, 'flt.vel': 0.4,
    ...env('fenv', 0.002, 0.8, 0.2, 0.5), ...env('aenv', 0.002, 1.6, 0.3, 0.5), 'fx.chorus.on': 1, 'fx.chorus.mix': 0.3,
    'fx.reverb.on': 1, 'fx.reverb.mix': 0.22,
  } },

  { name: 'Noise Riser', category: 'FX', wt: ['Analog Saw', 'Saw → Square'], params: {
    'a.level': 0.25, 'noise.on': 1, 'noise.level': 0.9, 'noise.color': 1, 'flt.mode': F('BP 12'), 'flt.cut': 300, 'flt.res': 0.6,
    ...mod(0, 'Mod Env', 'Cutoff', 0.55), ...env('menv', 3, 2, 0.8, 2), ...env('aenv', 2, 1, 1, 2),
    'fx.reverb.on': 1, 'fx.reverb.mix': 0.5, 'fx.reverb.decay': 6, 'fx.delay.on': 1, 'fx.delay.mix': 0.2,
  } },
];
