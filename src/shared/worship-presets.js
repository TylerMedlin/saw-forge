// Worship Atmospheres factory presets: 40 synthesis configurations in five
// collections. Each preset starts from a neutral base and sets its own
// oscillators, filters, envelopes, modulation, layers, voicing and effects.
// `trim` values are loudness calibration measured by tests/run.js
// ("Worship presets: loudness"), so presets switch at a matched level.

import { worshipDefaults, W, VC, WP_DEF } from './worship-params.js';
import { divIndex } from './params.js';

const STR = (name) => ['Warm Strings', 'Soft Violins', 'Cinematic Strings', 'Lush Ensemble', 'Ambient Strings', 'Slow Swell Strings',
  'Chamber Strings', 'Deep Cellos', 'High Strings', 'Analog String Machine'].indexOf(name);
const SRC = { LFO1: 1, LFO2: 2, EVOLVE: 3, SWELL: 4 };
const DST = { CUT1: 1, CUT2: 2, MORPH: 5, M2: 7, L3: 12, DETUNE: 14, PAN: 16, PAD: 17, STR_BRIGHT: 19, NOISE: 20, REVERB: 22, SHIMMER: 23 };
const FLT = { LP12: 0, LP24: 1, LADDER: 2, HP: 3, BP: 4, OFF: 5 };
const ROUTE = { F1: 0, F2: 1, DRY: 2 };

// ---- builders --------------------------------------------------------------
const osc = (n, o) => {
  const r = { [`o${n}.on`]: 1 };
  const map = { wave: 'wave', level: 'level', oct: 'oct', semi: 'semi', fine: 'fine', uni: 'uni', det: 'detune', spread: 'spread', drift: 'drift', morph: 'morph', pw: 'pw', pan: 'pan', route: 'route' };
  for (const [k, id] of Object.entries(map)) if (o[k] !== undefined) r[`o${n}.${id}`] = o[k];
  return r;
};
const off = (n) => ({ [`o${n}.on`]: 0 });
const flt = (n, o) => {
  const r = {};
  for (const k of ['type', 'cut', 'res', 'drive', 'key', 'swell']) if (o[k] !== undefined) r[`f${n}.${k}`] = o[k];
  return r;
};
const env = (o) => {
  const r = {};
  const map = { a: 'attack', d: 'decay', s: 'sustain', r: 'release', curve: 'curve', int: 'intensity', auto: 'auto', period: 'period', depth: 'depth' };
  for (const [k, id] of Object.entries(map)) if (o[k] !== undefined) r[`sw.${id}`] = o[k];
  return r;
};
const strings = (type, o = {}) => {
  const r = { 'str.on': 1, 'str.type': STR(type) };
  const map = { vol: 'vol', a: 'attack', r: 'release', s: 'sustain', swell: 'swell', width: 'width', bright: 'bright', vib: 'vib', ens: 'ens', oct: 'oct', cut: 'cut', rev: 'rev', blend: 'blend' };
  for (const [k, id] of Object.entries(map)) if (o[k] !== undefined) r[`str.${id}`] = o[k];
  return r;
};
const bass = (o) => ({ 'bass.on': 1, ...(o.level !== undefined ? { 'bass.level': o.level } : {}), ...(o.oct !== undefined ? { 'bass.oct': o.oct } : {}), ...(o.wave !== undefined ? { 'bass.wave': o.wave } : {}), ...(o.lp !== undefined ? { 'bass.lp': o.lp } : {}) });
const noise = (type, level, tone, route = ROUTE.DRY) => ({ 'nz.on': 1, 'nz.type': type, 'nz.level': level, 'nz.tone': tone, 'nz.route': route });
const evolve = (amount, rate, o = {}) => {
  const r = { 'ev.amount': amount, 'ev.rate': rate };
  for (const k of ['morph', 'cutoff', 'detune', 'stereo', 'strings', 'amp']) if (o[k] !== undefined) r[`ev.${k}`] = o[k];
  return r;
};
const lfo = (n, shape, rate) => ({ [`l${n}.shape`]: shape, [`l${n}.rate`]: rate });
const mods = (...rows) => {
  const r = {};
  rows.forEach(([src, dst, amt], i) => { r[`m${i}.src`] = src; r[`m${i}.dst`] = dst; r[`m${i}.amt`] = amt; });
  return r;
};
const fx = (o) => {
  const r = {};
  if (o.sat !== undefined) { r['sat.on'] = o.sat > 0 ? 1 : 0; r['sat.drive'] = o.sat; }
  if (o.satTone !== undefined) r['sat.tone'] = o.satTone;
  if (o.chorus !== undefined) { r['ch.on'] = o.chorus > 0 ? 1 : 0; r['ch.mix'] = o.chorus; }
  if (o.chRate !== undefined) r['ch.rate'] = o.chRate;
  if (o.chDepth !== undefined) r['ch.depth'] = o.chDepth;
  if (o.delay !== undefined) { r['dl.on'] = o.delay > 0 ? 1 : 0; r['dl.mix'] = o.delay; }
  if (o.dlDiv !== undefined) r['dl.div'] = divIndex(o.dlDiv);
  if (o.dlFb !== undefined) r['dl.fb'] = o.dlFb;
  if (o.rv !== undefined) r['rv.send'] = o.rv;
  if (o.decay !== undefined) r['rv.decay'] = o.decay;
  if (o.size !== undefined) r['rv.size'] = o.size;
  if (o.damp !== undefined) r['rv.damp'] = o.damp;
  if (o.pre !== undefined) r['rv.pre'] = o.pre;
  if (o.shimmer !== undefined) { r['sh.on'] = o.shimmer > 0 ? 1 : 0; r['sh.amount'] = o.shimmer; }
  if (o.shFb !== undefined) r['sh.fb'] = o.shFb;
  if (o.shTone !== undefined) r['sh.tone'] = o.shTone;
  return r;
};
const master = (o) => {
  const r = {};
  const map = { width: 'st.width', motion: 'st.motion', lowcut: 'out.lowcut', low: 'eq.low', mid: 'eq.mid', midf: 'eq.midf', high: 'eq.high' };
  for (const [k, id] of Object.entries(map)) if (o[k] !== undefined) r[id] = o[k];
  return r;
};
const voicing = (type, reg = 1, density = 0.55, spread = 0.6) => ({ 'vc.type': type, 'vc.reg': reg, 'vc.density': density, 'vc.spread': spread });

// A neutral starting point every preset overrides.
const BASE = {
  ...off(1), ...off(2), ...off(3), ...off(4),
  ...flt(1, { type: FLT.LP24, cut: 2000, res: 0.1, drive: 0.1, key: 0.3, swell: 0.25 }),
  ...flt(2, { type: FLT.LP12, cut: 5000, res: 0.05, drive: 0, key: 0.2, swell: 0.1 }),
  ...env({ a: 4, d: 3, s: 0.85, r: 6, curve: 0.3, int: 0.5, auto: 0 }),
  'str.on': 0.0, 'bass.on': 0, 'nz.on': 0,
  ...evolve(0.4, 0.06), ...lfo(1, 0, 0.1), ...lfo(2, 2, 0.05),
  ...mods([SRC.LFO1, DST.CUT1, 0.05], [SRC.LFO2, DST.MORPH, 0.12]),
  ...fx({ sat: 0.2, satTone: 9000, chorus: 0.3, chRate: 0.35, chDepth: 0.45, delay: 0, rv: 0.45, decay: 7, size: 0.85, damp: 5000, pre: 30, shimmer: 0 }),
  ...master({ width: 1.1, motion: 0.2, lowcut: 70, low: 0, mid: 0, high: -1 }),
  ...voicing(VC.WIDE, 1, 0.55, 0.6),
};

const P = (name, desc, params) => ({ name, desc, params: { ...BASE, ...params } });

export const WORSHIP_COLLECTIONS = [
  { name: 'Warm Analog Foundations', presets: [
    P('Warm Sanctuary', 'Deep, rich vintage analog pad with rounded low mids and soft high-frequency warmth.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.7, drift: 0.4 }), ...osc(2, { wave: W.SAW, oct: -1, uni: 3, det: 6, level: 0.45 }),
      ...osc(3, { wave: W.TRI, oct: 1, uni: 2, det: 5, level: 0.2 }),
      ...flt(1, { type: FLT.LP24, cut: 1600, res: 0.1, drive: 0.2 }), ...fx({ sat: 0.3, chorus: 0.3, rv: 0.4, decay: 6 }),
      ...master({ low: 1.5, high: -2 }) }),
    P('Golden Presence', 'Expansive, glowing analog pad with gentle movement.', {
      ...osc(1, { wave: W.SAW, uni: 6, det: 16, spread: 0.9, level: 0.65 }), ...osc(2, { wave: W.PULSE, pw: 0.35, uni: 3, det: 10, level: 0.35 }),
      ...osc(3, { wave: W.SINE, oct: 1, uni: 1, level: 0.25, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 2600, res: 0.18 }), ...lfo(1, 0, 0.1), ...mods([SRC.LFO1, DST.CUT1, 0.08], [SRC.LFO2, DST.MORPH, 0.1]),
      ...evolve(0.5, 0.06, { stereo: 0.6 }), ...fx({ chorus: 0.4, rv: 0.5, decay: 8 }), ...master({ width: 1.3, motion: 0.3 }) }),
    P('Vintage Worship', 'Warm, slightly detuned analog synthesizer with a classic worship atmosphere.', {
      ...osc(1, { wave: W.SAW, uni: 4, det: 18, drift: 0.65, level: 0.65 }), ...osc(2, { wave: W.PULSE, pw: 0.45, uni: 2, det: 9, drift: 0.6, level: 0.5 }),
      ...flt(1, { type: FLT.LADDER, cut: 1900, res: 0.2, drive: 0.3 }), ...env({ a: 2.5, d: 2, s: 0.85, r: 5 }),
      ...fx({ sat: 0.35, satTone: 7000, chorus: 0.45, chRate: 0.5, chDepth: 0.6, rv: 0.35, decay: 5 }), ...master({ width: 1.2 }) }),
    P('Deep Foundation', 'Massive yet restrained lower-register pad with smooth harmonic support.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 10, level: 0.6 }), ...osc(2, { wave: W.SINE, oct: 0, uni: 1, level: 0.5, route: ROUTE.DRY }),
      ...osc(3, { wave: W.TRI, uni: 3, det: 6, level: 0.3 }),
      ...flt(1, { type: FLT.LP24, cut: 900, res: 0.08, key: 0.5, swell: 0.2 }), ...bass({ level: 0.45, oct: -1, wave: 0, lp: 150 }),
      ...voicing(VC.OPEN5, 0, 0.5, 0.6), ...fx({ rv: 0.35, decay: 6, damp: 3500 }), ...master({ lowcut: 45, low: 2, high: -3, width: 1 }) }),
    P('Analog Heaven', 'Lush, slowly evolving analog oscillators with wide stereo imaging.', {
      ...osc(1, { wave: W.SAW, uni: 7, det: 20, spread: 1, level: 0.55 }), ...osc(2, { wave: W.SAW, oct: 1, uni: 5, det: 9, level: 0.3 }),
      ...osc(3, { wave: W.MORPH, morph: 0.2, uni: 3, det: 8, level: 0.3 }),
      ...flt(1, { type: FLT.LP12, cut: 2800, res: 0.15 }), ...evolve(0.7, 0.05, { morph: 0.8, cutoff: 0.6, stereo: 0.7 }),
      ...fx({ chorus: 0.4, rv: 0.55, decay: 9 }), ...master({ width: 1.5, motion: 0.45 }) }),
    P('Soft Ember', 'Gentle, muted, warm pad for quiet moments.', {
      ...osc(1, { wave: W.TRI, uni: 3, det: 8, level: 0.7 }), ...osc(2, { wave: W.SAW, uni: 3, det: 10, level: 0.3 }),
      ...flt(1, { type: FLT.LP24, cut: 950, res: 0.05, swell: 0.15 }), ...env({ a: 6, d: 3, s: 0.9, r: 8 }),
      ...voicing(VC.TRIAD, 1, 0.4, 0.5), ...fx({ sat: 0.15, rv: 0.4, decay: 6, damp: 3500 }), ...master({ high: -4 }) }),
    P('Cathedral Warmth', 'Broad, majestic pad with subtle harmonic movement.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 14, level: 0.6 }), ...osc(2, { wave: W.SAW, oct: -1, uni: 3, det: 7, level: 0.45 }),
      ...osc(3, { wave: W.SINE, oct: 1, uni: 1, level: 0.2, route: ROUTE.DRY }), ...osc(4, { wave: W.MORPH, oct: 1, morph: 0.3, uni: 3, det: 6, level: 0.2, route: ROUTE.F2 }),
      ...flt(1, { type: FLT.LP24, cut: 2000 }), ...flt(2, { type: FLT.LP12, cut: 3500 }),
      ...lfo(2, 2, 0.04), ...mods([SRC.LFO2, DST.CUT1, 0.08], [SRC.LFO1, DST.MORPH, 0.1]),
      ...voicing(VC.WIDE, 1, 0.7, 0.8), ...fx({ rv: 0.55, decay: 12, size: 1, pre: 60 }), ...master({ width: 1.4 }) }),
    P('Midnight Analog', 'Dark, deep, velvety analog atmosphere.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.65 }), ...osc(2, { wave: W.SINE, oct: -1, uni: 1, level: 0.4, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LADDER, cut: 700, res: 0.25, drive: 0.35, swell: 0.2 }),
      ...voicing(VC.WIDE, 0, 0.45, 0.6), ...evolve(0.3, 0.05), ...fx({ sat: 0.25, rv: 0.45, decay: 8, damp: 2500 }), ...master({ low: 1, high: -5 }) }),
  ] },
  { name: 'Ethereal Worship Atmospheres', presets: [
    P('Heavenly Atmosphere', 'Floating, airy, spacious worship pad.', {
      ...osc(1, { wave: W.TRI, uni: 5, det: 14, spread: 0.9, level: 0.6 }), ...osc(2, { wave: W.SINE, oct: 1, uni: 2, det: 4, level: 0.35, route: ROUTE.DRY }),
      ...osc(3, { wave: W.SAW, uni: 3, det: 20, level: 0.25 }), ...noise(2, 0.15, 6000),
      ...flt(1, { type: FLT.LP12, cut: 3200 }), ...env({ a: 6, d: 3, s: 0.85, r: 9 }), ...evolve(0.5, 0.05),
      ...fx({ rv: 0.6, decay: 11, size: 1, shimmer: 0.25, shFb: 0.45, shTone: 5000 }), ...master({ width: 1.5, motion: 0.3 }) }),
    P('Holy Ground', 'Deep, emotional, slowly developing harmonic wash.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.6 }), ...osc(2, { wave: W.MORPH, morph: 0.2, uni: 3, det: 8, level: 0.45 }),
      ...osc(3, { wave: W.SINE, oct: -1, uni: 1, level: 0.3, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 1300, swell: 0.5 }), ...env({ a: 8, d: 4, s: 0.85, r: 10, curve: 0.6, int: 0.7, auto: 1, period: 24, depth: 0.25 }),
      ...evolve(0.55, 0.04), ...voicing(VC.WIDE, 1, 0.55, 0.6), ...fx({ rv: 0.5, decay: 9 }) }),
    P('Eternal Light', 'Bright but soft upper harmonics over a rich warm foundation.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.55 }), ...osc(2, { wave: W.SINE, oct: 1, uni: 2, det: 5, level: 0.3, route: ROUTE.DRY }),
      ...osc(3, { wave: W.TRI, oct: 2, uni: 3, det: 6, level: 0.15, route: ROUTE.F2 }),
      ...flt(1, { type: FLT.LP24, cut: 1500 }), ...flt(2, { type: FLT.LP12, cut: 6000 }),
      ...fx({ rv: 0.5, decay: 8, shimmer: 0.2 }), ...master({ high: 0, width: 1.3 }) }),
    P('Still Waters', 'Smooth, peaceful, floating atmospheric texture.', {
      'br.amount': 0.35, 'br.rate': 0.1,
      ...osc(1, { wave: W.SINE, uni: 3, det: 6, level: 0.6 }), ...osc(2, { wave: W.TRI, uni: 5, det: 10, level: 0.5 }),
      ...osc(3, { wave: W.SINE, oct: 1, uni: 1, level: 0.2, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP12, cut: 2200, res: 0.05 }), ...env({ a: 5 }), ...lfo(1, 0, 0.07),
      ...mods([SRC.LFO1, DST.PAN, 0.3], [SRC.LFO2, DST.MORPH, 0.1]), ...evolve(0.45, 0.05),
      ...fx({ chorus: 0.4, chRate: 0.2, chDepth: 0.5, rv: 0.55, decay: 8 }), ...master({ motion: 0.35, width: 1.3 }) }),
    P('Open Heavens', 'Very wide, expansive layered pad with long reverberant tails.', {
      'br.amount': 0.3, 'br.rate': 0.08,
      ...osc(1, { wave: W.SAW, uni: 7, det: 22, spread: 1, level: 0.55 }), ...osc(2, { wave: W.TRI, oct: 1, uni: 5, det: 14, level: 0.35 }),
      ...flt(1, { type: FLT.LP24, cut: 2600 }), ...voicing(VC.WIDE, 1, 0.7, 0.9),
      ...fx({ rv: 0.7, decay: 14, size: 1, pre: 80, delay: 0.18, dlDiv: '1/4 D', dlFb: 0.5, shimmer: 0.2 }), ...master({ width: 1.8, motion: 0.4 }) }),
    P('Glory Cloud', 'Soft shimmering overtones over an evolving analog foundation.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 14, level: 0.6 }), ...osc(2, { wave: W.MORPH, morph: 0.5, uni: 3, det: 10, level: 0.35 }),
      ...osc(3, { wave: W.SINE, oct: 2, uni: 1, level: 0.12, route: ROUTE.DRY }), ...noise(2, 0.08, 7000),
      ...flt(1, { type: FLT.LP24, cut: 2000 }), ...evolve(0.6, 0.05, { morph: 0.7 }),
      ...fx({ rv: 0.5, decay: 10, shimmer: 0.45, shFb: 0.6, shTone: 7000 }), ...master({ width: 1.4 }) }),
    P('Quiet Presence', 'Extremely gentle, intimate ambient pad.', {
      ...osc(1, { wave: W.SINE, uni: 3, det: 5, level: 0.7 }), ...osc(2, { wave: W.TRI, uni: 3, det: 7, level: 0.35 }),
      ...flt(1, { type: FLT.LP12, cut: 1400, res: 0, swell: 0.1 }), ...env({ a: 7, r: 9 }), ...evolve(0.3, 0.04),
      ...voicing(VC.SUS2, 1, 0.35, 0.45), ...fx({ sat: 0.1, chorus: 0.25, rv: 0.45, decay: 7, damp: 3000 }), ...master({ high: -4, width: 1 }) }),
    P('Endless Horizon', 'Cinematic, spacious, evolving sonic atmosphere.', {
      ...osc(1, { wave: W.SAW, uni: 6, det: 16, level: 0.55 }), ...osc(2, { wave: W.MORPH, morph: 0.7, uni: 3, det: 9, level: 0.35 }),
      ...osc(3, { wave: W.SAW, oct: -1, uni: 3, det: 6, level: 0.3 }),
      ...flt(1, { type: FLT.LP24, cut: 1800, swell: 0.45 }), ...lfo(2, 2, 0.04), ...mods([SRC.LFO2, DST.MORPH, 0.3], [SRC.LFO1, DST.CUT1, 0.05]),
      ...evolve(0.7, 0.03), ...fx({ rv: 0.6, decay: 12, delay: 0.15, dlDiv: '1/2', dlFb: 0.5 }), ...master({ width: 1.6, motion: 0.3 }) }),
  ] },
  { name: 'Cinematic Strings and Synth Hybrids', presets: [
    P('Celestial Strings', 'Rich string ensemble supporting a warm analog pad.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.5 }), ...osc(2, { wave: W.TRI, uni: 3, det: 8, level: 0.3 }),
      ...flt(1, { type: FLT.LP24, cut: 1800 }), ...strings('Lush Ensemble', { vol: 0.7, a: 3, r: 6, blend: 0.5, bright: 0.5, ens: 0.6, vib: 0.3 }),
      ...fx({ rv: 0.55, decay: 9, shimmer: 0.15 }), ...master({ width: 1.4 }) }),
    P('Majestic Swell', 'Slowly building orchestral strings with a synthesizer foundation.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.5 }), ...osc(2, { wave: W.SAW, oct: -1, uni: 3, det: 6, level: 0.35 }),
      ...flt(1, { type: FLT.LP24, cut: 1500, swell: 0.6 }), ...env({ a: 8, curve: 0.6, int: 0.8, auto: 1, period: 20, depth: 0.3 }),
      ...strings('Slow Swell Strings', { vol: 0.8, a: 8, swell: 0.7, blend: 0.55 }), ...fx({ rv: 0.55, decay: 10 }) }),
    P('Worship Orchestra', 'Expansive string ensemble and analog hybrid.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 14, level: 0.5 }), ...osc(2, { wave: W.PULSE, pw: 0.4, uni: 3, det: 9, level: 0.3 }),
      ...osc(3, { wave: W.SINE, oct: 0, uni: 1, level: 0.3, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 2000 }), ...strings('Cinematic Strings', { vol: 0.75, a: 2.5, blend: 0.55, bright: 0.5 }),
      ...bass({ level: 0.3 }), ...fx({ rv: 0.5, decay: 10, size: 0.95 }), ...master({ width: 1.4 }) }),
    P('Emotional Strings', 'Expressive, soft, legato string-like textures.', {
      ...osc(1, { wave: W.TRI, uni: 3, det: 7, level: 0.5 }), ...osc(2, { wave: W.SAW, uni: 3, det: 8, level: 0.25 }),
      ...flt(1, { type: FLT.LP12, cut: 1800 }), ...strings('Soft Violins', { vol: 0.8, vib: 0.45, a: 2, r: 5, blend: 0.7, bright: 0.45 }),
      ...fx({ rv: 0.55, decay: 8, delay: 0.12, dlDiv: '1/4 D', dlFb: 0.35 }) }),
    P('Eternal Symphony', 'Wide orchestral pad with layered harmonics.', {
      ...osc(1, { wave: W.SAW, uni: 7, det: 18, level: 0.5 }), ...osc(2, { wave: W.SAW, oct: 1, uni: 3, det: 8, level: 0.25 }),
      ...osc(3, { wave: W.SINE, oct: -1, uni: 1, level: 0.3, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 2400 }), ...strings('Lush Ensemble', { vol: 0.75, blend: 0.5 }),
      ...voicing(VC.WIDE, 1, 0.75, 0.85), ...fx({ rv: 0.6, decay: 12, size: 1 }), ...master({ width: 1.6 }) }),
    P('Warm String Cloud', 'Velvety strings blended into an atmospheric synthesizer.', {
      ...osc(1, { wave: W.TRI, uni: 5, det: 12, level: 0.5 }), ...osc(2, { wave: W.SAW, uni: 5, det: 14, level: 0.3 }),
      ...flt(1, { type: FLT.LP24, cut: 1500 }), ...strings('Warm Strings', { vol: 0.75, bright: 0.35, ens: 0.8, blend: 0.5 }),
      ...evolve(0.5, 0.05, { strings: 0.6 }), ...fx({ chorus: 0.45, rv: 0.5, decay: 9 }) }),
    P('Glorious Rise', 'Dramatic but controlled cinematic swell.', {
      ...osc(1, { wave: W.SAW, uni: 6, det: 16, level: 0.55 }), ...osc(2, { wave: W.SQUARE, uni: 3, det: 8, level: 0.2 }),
      ...osc(3, { wave: W.SAW, oct: -1, uni: 3, det: 6, level: 0.3 }),
      ...flt(1, { type: FLT.LADDER, cut: 1200, res: 0.2, swell: 0.7 }), ...env({ a: 10, curve: 0.7, int: 0.9, period: 14 }),
      ...strings('Cinematic Strings', { vol: 0.8, a: 6, swell: 0.8, blend: 0.55 }), ...fx({ rv: 0.5, decay: 10 }) }),
    P('Tender Strings', 'Soft, intimate, warm string textures for prayer and reflection.', {
      ...osc(1, { wave: W.SINE, uni: 3, det: 5, level: 0.5 }), ...osc(2, { wave: W.TRI, uni: 3, det: 7, level: 0.3 }),
      ...flt(1, { type: FLT.LP12, cut: 1500 }), ...strings('Chamber Strings', { vol: 0.75, a: 2.5, vib: 0.4, bright: 0.4, blend: 0.7 }),
      ...voicing(VC.TRIAD, 1, 0.45, 0.55), ...fx({ rv: 0.45, decay: 7, damp: 4000 }) }),
  ] },
  { name: 'Deep Ambient and Prayer Pads', presets: [
    P('Prayer Room', 'Low, peaceful, warm harmonic bed.', {
      ...osc(1, { wave: W.TRI, uni: 5, det: 10, level: 0.6 }), ...osc(2, { wave: W.SAW, uni: 3, det: 8, level: 0.3 }),
      ...osc(3, { wave: W.SINE, oct: 0, uni: 1, level: 0.35, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 900 }), ...bass({ level: 0.35, lp: 140 }), ...env({ a: 6 }),
      ...voicing(VC.OPEN5, 0, 0.45, 0.6), ...fx({ rv: 0.45, decay: 8, damp: 3000 }), ...master({ high: -4 }) }),
    P('Deep Peace', 'Extremely soft, deep, dark, sustained pad.', {
      ...osc(1, { wave: W.SINE, uni: 3, det: 6, level: 0.7 }), ...osc(2, { wave: W.TRI, oct: -1, uni: 3, det: 5, level: 0.45 }),
      ...osc(3, { wave: W.SAW, uni: 3, det: 8, level: 0.15 }),
      ...flt(1, { type: FLT.LP24, cut: 650, res: 0.05, swell: 0.15 }), ...env({ a: 8, r: 14 }), ...evolve(0.25, 0.04),
      ...voicing(VC.WIDE, 0, 0.5, 0.6), ...fx({ rv: 0.5, decay: 10, damp: 2200 }), ...master({ high: -6, low: 1 }) }),
    P('Sacred Silence', 'Minimal evolving ambient texture with delicate high harmonics.', {
      'br.amount': 0.5, 'br.rate': 0.08,
      ...osc(1, { wave: W.SINE, uni: 3, det: 4, level: 0.6 }), ...osc(2, { wave: W.SINE, oct: 2, uni: 1, level: 0.1, route: ROUTE.F2 }),
      ...osc(3, { wave: W.TRI, oct: 1, uni: 3, det: 5, level: 0.12 }), ...noise(2, 0.06, 7000),
      ...flt(1, { type: FLT.LP12, cut: 1200 }), ...flt(2, { type: FLT.BP, cut: 2500, res: 0.3 }), ...evolve(0.55, 0.03, { morph: 0.6 }),
      ...voicing(VC.R8, 1, 0.35, 0.6), ...fx({ rv: 0.6, decay: 12, shimmer: 0.2, shFb: 0.4 }) }),
    P('Resting Place', 'Wide, floating, comforting atmosphere.', {
      'br.amount': 0.35, 'br.rate': 0.1,
      ...osc(1, { wave: W.TRI, uni: 5, det: 12, spread: 1, level: 0.55 }), ...osc(2, { wave: W.SAW, uni: 5, det: 16, level: 0.25 }),
      ...osc(3, { wave: W.SINE, oct: 1, uni: 1, level: 0.2, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP12, cut: 1800 }), ...env({ a: 5 }), ...fx({ chorus: 0.4, chRate: 0.25, rv: 0.55, decay: 9 }), ...master({ width: 1.7, motion: 0.35 }) }),
    P('Mercy Flow', 'Gentle analog pad with slow, subtle evolving movement.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 12, level: 0.5 }), ...osc(2, { wave: W.MORPH, morph: 0.3, uni: 3, det: 8, level: 0.4 }),
      ...flt(1, { type: FLT.LP24, cut: 1500, res: 0.12 }), ...lfo(1, 0, 0.06),
      ...mods([SRC.LFO1, DST.CUT1, 0.12], [SRC.LFO1, DST.M2, 0.25], [SRC.LFO2, DST.PAD, 0.05]),
      ...evolve(0.5, 0.04), ...fx({ chorus: 0.35, rv: 0.5, decay: 8 }) }),
    P('Infinite Grace', 'Very long, expansive evolving ambient wash.', {
      'br.amount': 0.45, 'br.rate': 0.06,
      ...osc(1, { wave: W.SAW, uni: 7, det: 18, level: 0.45 }), ...osc(2, { wave: W.TRI, oct: 1, uni: 5, det: 10, level: 0.3 }),
      ...osc(3, { wave: W.SINE, oct: -1, uni: 1, level: 0.3, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 1700 }), ...env({ a: 10, r: 20 }), ...evolve(0.65, 0.025),
      ...fx({ rv: 0.65, decay: 16, size: 1, pre: 60, shimmer: 0.3, shFb: 0.55, delay: 0.15, dlDiv: '1/2', dlFb: 0.55 }), ...master({ width: 1.6 }) }),
    P('Ocean of Peace', 'Flowing layers with subtle filtered motion.', {
      'br.amount': 0.4, 'br.rate': 0.1,
      ...osc(1, { wave: W.SAW, uni: 5, det: 14, level: 0.5 }), ...osc(2, { wave: W.TRI, uni: 5, det: 10, level: 0.4 }), ...noise(3, 0.12, 1200, ROUTE.F1),
      ...flt(1, { type: FLT.LP24, cut: 1300, res: 0.15 }), ...lfo(1, 0, 0.08), ...mods([SRC.LFO1, DST.CUT1, 0.2], [SRC.LFO2, DST.PAD, 0.1]),
      ...fx({ rv: 0.5, decay: 9 }), ...master({ motion: 0.4, width: 1.4 }) }),
    P('Whispering Spirit', 'Delicate harmonic shimmer over a deep foundation.', {
      'br.amount': 0.45, 'br.rate': 0.1,
      ...osc(1, { wave: W.TRI, uni: 3, det: 8, level: 0.55 }), ...osc(2, { wave: W.SINE, oct: -1, uni: 1, level: 0.35, route: ROUTE.DRY }),
      ...osc(3, { wave: W.SAW, oct: 2, uni: 5, det: 12, level: 0.1, route: ROUTE.F2 }), ...noise(2, 0.1, 8000),
      ...flt(1, { type: FLT.LP24, cut: 1100 }), ...flt(2, { type: FLT.BP, cut: 4000, res: 0.2 }), ...evolve(0.5, 0.05),
      ...fx({ rv: 0.55, decay: 10, shimmer: 0.35, shFb: 0.5, shTone: 6000 }) }),
  ] },
  { name: 'Modern Worship and Powerful Swells', presets: [
    P('Anthem Rise', 'Big, uplifting contemporary worship pad.', {
      ...osc(1, { wave: W.SAW, uni: 7, det: 18, level: 0.55 }), ...osc(2, { wave: W.SAW, oct: -1, uni: 5, det: 10, level: 0.35 }),
      ...osc(3, { wave: W.SQUARE, oct: 1, uni: 3, det: 8, level: 0.15 }),
      ...flt(1, { type: FLT.LP24, cut: 2600, res: 0.15, drive: 0.3, swell: 0.45 }), ...strings('Lush Ensemble', { vol: 0.5, blend: 0.35 }),
      ...bass({ level: 0.3 }), ...fx({ sat: 0.4, rv: 0.45, decay: 8, delay: 0.15, dlDiv: '1/4 D', dlFb: 0.4 }), ...master({ width: 1.5 }) }),
    P('Radiant Worship', 'Powerful warm analog stack with subtle brilliance.', {
      ...osc(1, { wave: W.SAW, uni: 6, det: 16, level: 0.55 }), ...osc(2, { wave: W.PULSE, pw: 0.3, uni: 4, det: 12, level: 0.35 }),
      ...osc(3, { wave: W.SAW, oct: 1, uni: 3, det: 8, level: 0.2 }),
      ...flt(1, { type: FLT.LADDER, cut: 2400, res: 0.2, drive: 0.35 }), ...fx({ sat: 0.45, satTone: 11000, chorus: 0.35, rv: 0.45, decay: 7 }),
      ...master({ high: 1.5, width: 1.4 }) }),
    P('Awakening', 'Dynamic, gradually evolving synth atmosphere.', {
      ...osc(1, { wave: W.SAW, uni: 5, det: 14, level: 0.55 }), ...osc(2, { wave: W.MORPH, morph: 0.1, uni: 3, det: 8, level: 0.4 }),
      ...osc(3, { wave: W.TRI, oct: 1, uni: 2, det: 5, level: 0.2 }),
      ...flt(1, { type: FLT.LP24, cut: 900, res: 0.2, swell: 0.8 }), ...env({ a: 9, curve: 0.7, int: 0.9, auto: 1, period: 30, depth: 0.2 }),
      ...lfo(2, 2, 0.05), ...mods([SRC.LFO2, DST.CUT1, 0.15], [SRC.EVOLVE, DST.MORPH, 0.3]), ...evolve(0.7, 0.05), ...fx({ rv: 0.5, decay: 9 }) }),
    P('Kingdom Atmosphere', 'Deep cinematic worship foundation with a broad stereo field.', {
      ...osc(1, { wave: W.SAW, uni: 7, det: 20, spread: 1, level: 0.5 }), ...osc(2, { wave: W.SAW, oct: -1, uni: 5, det: 8, level: 0.4 }),
      ...osc(3, { wave: W.SINE, oct: 0, uni: 1, level: 0.3, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 1500 }), ...bass({ level: 0.4 }), ...strings('Cinematic Strings', { vol: 0.4, blend: 0.3 }),
      ...voicing(VC.WIDE, 0, 0.7, 0.7), ...fx({ rv: 0.55, decay: 12, size: 1 }), ...master({ width: 1.8 }) }),
    P('Mountain of Glory', 'Grand, expansive, layered synth pad.', {
      ...osc(1, { wave: W.SAW, uni: 7, det: 18, level: 0.5 }), ...osc(2, { wave: W.SAW, oct: 1, uni: 5, det: 12, level: 0.3 }),
      ...osc(3, { wave: W.SQUARE, oct: -1, uni: 3, det: 6, level: 0.25 }), ...osc(4, { wave: W.MORPH, oct: 2, morph: 0.4, uni: 2, det: 6, level: 0.1, route: ROUTE.F2 }),
      ...flt(1, { type: FLT.LP24, cut: 2300, drive: 0.25 }), ...flt(2, { type: FLT.LP12, cut: 4500 }), ...strings('Lush Ensemble', { vol: 0.55, blend: 0.4 }),
      ...voicing(VC.WIDE, 1, 0.8, 0.9), ...fx({ rv: 0.6, decay: 13, shimmer: 0.25 }), ...master({ width: 1.7 }) }),
    P('Living Hope', 'Beautiful, soaring analog-string hybrid.', {
      ...osc(1, { wave: W.SAW, uni: 6, det: 14, level: 0.5 }), ...osc(2, { wave: W.TRI, oct: 1, uni: 3, det: 6, level: 0.3 }),
      ...flt(1, { type: FLT.LP24, cut: 2400, swell: 0.4 }), ...strings('Soft Violins', { vol: 0.75, blend: 0.55, bright: 0.55, vib: 0.35 }),
      ...voicing(VC.ADD9, 1, 0.65, 0.8), ...fx({ rv: 0.55, decay: 10, shimmer: 0.25, delay: 0.15, dlDiv: '1/4 D', dlFb: 0.4 }) }),
    P('Eternal Anthem', 'Full, majestic synth atmosphere suitable for large worship moments.', {
      ...osc(1, { wave: W.SAW, uni: 7, det: 20, level: 0.5 }), ...osc(2, { wave: W.PULSE, pw: 0.4, uni: 5, det: 12, level: 0.35 }),
      ...osc(3, { wave: W.SAW, oct: -1, uni: 5, det: 8, level: 0.35 }), ...osc(4, { wave: W.SINE, oct: 1, uni: 1, level: 0.2, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LADDER, cut: 2200, res: 0.15, drive: 0.4 }), ...strings('Cinematic Strings', { vol: 0.55, blend: 0.4 }),
      ...bass({ level: 0.35 }), ...voicing(VC.WIDE, 1, 0.8, 0.8), ...fx({ sat: 0.5, rv: 0.55, decay: 12, size: 1 }), ...master({ width: 1.6 }) }),
    P('Endless Worship', 'Signature flagship pad with exceptionally rich, continuous, evolving harmonic motion.', {
      'br.amount': 0.35, 'br.rate': 0.09,
      ...osc(1, { wave: W.SAW, uni: 7, det: 18, spread: 1, drift: 0.5, level: 0.5 }), ...osc(2, { wave: W.MORPH, morph: 0.4, uni: 5, det: 12, level: 0.35 }),
      ...osc(3, { wave: W.TRI, oct: 1, uni: 3, det: 6, level: 0.2, route: ROUTE.F2 }), ...osc(4, { wave: W.SINE, oct: -1, uni: 1, level: 0.3, route: ROUTE.DRY }),
      ...flt(1, { type: FLT.LP24, cut: 2100, res: 0.14, swell: 0.5 }), ...flt(2, { type: FLT.LP12, cut: 6000 }),
      ...strings('Lush Ensemble', { vol: 0.5, blend: 0.4, ens: 0.7 }), ...noise(2, 0.06, 7000),
      ...lfo(1, 0, 0.09), ...lfo(2, 2, 0.05), ...mods([SRC.LFO1, DST.CUT1, 0.08], [SRC.LFO2, DST.MORPH, 0.3], [SRC.EVOLVE, DST.STR_BRIGHT, 0.2]),
      ...evolve(0.7, 0.04, { morph: 0.7, cutoff: 0.6, detune: 0.4, stereo: 0.6, strings: 0.6, amp: 0.2 }),
      ...voicing(VC.WIDE, 1, 0.7, 0.8),
      ...fx({ rv: 0.55, decay: 12, size: 1, pre: 50, shimmer: 0.25, shFb: 0.5, delay: 0.1, dlDiv: '1/2', dlFb: 0.45 }), ...master({ width: 1.6, motion: 0.35 }) }),
  ] },
];

// Loudness calibration (dB) per preset, measured with a reference chord; see the tests.
export const PRESET_TRIM = {
  'Warm Sanctuary': -2.1,
  'Golden Presence': -0.4,
  'Vintage Worship': 1.7,
  'Deep Foundation': -3.5,
  'Analog Heaven': -0.4,
  'Soft Ember': -1.1,
  'Cathedral Warmth': -1.3,
  'Midnight Analog': 0.4,
  'Heavenly Atmosphere': -1.6,
  'Holy Ground': -1.7,
  'Eternal Light': 0.5,
  'Still Waters': -1.6,
  'Open Heavens': 0.5,
  'Glory Cloud': -0.7,
  'Quiet Presence': -1.8,
  'Endless Horizon': 0.1,
  'Celestial Strings': -1.5,
  'Majestic Swell': -2.4,
  'Worship Orchestra': -3.2,
  'Emotional Strings': -0.1,
  'Eternal Symphony': -2.6,
  'Warm String Cloud': -0.9,
  'Glorious Rise': -1.9,
  'Tender Strings': -1.9,
  'Prayer Room': -2.3,
  'Deep Peace': -2.1,
  'Sacred Silence': 0.0,
  'Resting Place': -0.4,
  'Mercy Flow': 1.3,
  'Infinite Grace': 1.7,
  'Ocean of Peace': 0.1,
  'Whispering Spirit': 0.2,
  'Anthem Rise': -1.8,
  'Radiant Worship': 0.8,
  'Awakening': -0.1,
  'Kingdom Atmosphere': -2.3,
  'Mountain of Glory': -2.2,
  'Living Hope': -1.1,
  'Eternal Anthem': -3.3,
  'Endless Worship': -0.9,
};

export const WORSHIP_PRESETS = WORSHIP_COLLECTIONS.flatMap((c) => c.presets.map((p) => ({ ...p, collection: c.name })));
export function worshipPresetByName(name) { return WORSHIP_PRESETS.find((p) => p.name === name) || null; }
// Full parameter set for a preset (defaults + preset + calibrated trim), clamped to each parameter's range.
export function worshipPresetParams(preset) {
  const out = { ...worshipDefaults(), ...(preset ? preset.params : {}) };
  out['out.trim'] = (out['out.trim'] || 0) + (preset && PRESET_TRIM[preset.name] ? PRESET_TRIM[preset.name] : 0);
  for (const [k, v] of Object.entries(out)) { const d = WP_DEF[k]; if (d) out[k] = Math.min(d.max, Math.max(d.min, v)); else delete out[k]; }
  return out;
}
