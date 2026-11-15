// Pedal, amp and cabinet definitions shared by the UI and the audio worklet.
// Names and artwork are original. "Inspired by" notes describe broad sonic
// families only; nothing here is an official or exact emulation.

// Beat divisions for tempo-synced delays (fraction of a quarter note).
export const DIVISIONS = [
  { id: 'off', label: 'Free', q: 0 },
  { id: '1/4', label: '1/4', q: 1 },
  { id: '1/8.', label: '1/8 dotted', q: 0.75 },
  { id: '1/8', label: '1/8', q: 0.5 },
  { id: '1/4T', label: '1/4 triplet', q: 2 / 3 },
  { id: '1/8T', label: '1/8 triplet', q: 1 / 3 },
  { id: '1/16', label: '1/16', q: 0.25 },
  { id: '1/2', label: '1/2', q: 2 },
];

// p(key, name, min, max, def, unit, curve)  curve: 'lin' | 'log'
const p = (k, name, min, max, def, unit = '', curve = 'lin') => ({ k, name, min, max, def, unit, curve });
const opt = (k, name, options, def) => ({ k, name, options, def, enum: true });
const pct = (k, name, def) => p(k, name, 0, 100, def, '%');

// dsp: which engine class runs it; voice: its character settings in VOICES.
// trails: keeps ringing after bypass (spillover). cost: rough CPU weight.
export const PEDALS = {
  'studio-comp': {
    name: 'Sanctum Comp', label: 'Studio Compressor', family: 'Dynamics', dsp: 'comp', voice: 'studio', cost: 1, color: '#2f5fbf', place: 'pre',
    blurb: 'Clean, even compression with a blend knob for natural pick attack.',
    params: [p('sustain', 'Sustain', -50, 0, -26, 'dB'), p('ratio', 'Ratio', 1, 12, 4, ':1', 'log'), p('attack', 'Attack', 0.3, 60, 12, 'ms', 'log'),
      p('release', 'Release', 30, 1200, 180, 'ms', 'log'), p('level', 'Level', -12, 18, 4, 'dB'), pct('blend', 'Blend', 70)],
  },
  'transparent-od': {
    name: 'Clearwater Drive', label: 'Transparent Overdrive', family: 'Drive', dsp: 'drive', voice: 'transparent', cost: 3, color: '#c9cdd3', place: 'pre',
    blurb: 'Low-gain drive that keeps your guitar\'s own voice, with clean signal blended in.',
    params: [p('drive', 'Drive', 0, 100, 30, '%'), p('tone', 'Tone', 0, 100, 55, '%'), p('level', 'Level', -24, 12, -2, 'dB'), pct('clean', 'Clean', 35)],
  },
  'midhump-od': {
    name: 'Greenlight Drive', label: 'Mid-Hump Overdrive', family: 'Drive', dsp: 'drive', voice: 'midhump', cost: 3, color: '#2f9a5a', place: 'pre',
    blurb: 'Classic mid-forward overdrive that tightens lows and helps leads cut through.',
    params: [p('drive', 'Drive', 0, 100, 45, '%'), p('tone', 'Tone', 0, 100, 50, '%'), p('level', 'Level', -24, 12, -3, 'dB'), pct('clean', 'Clean', 0)],
  },
  'digital-delay': {
    name: 'Lumen Echo', label: 'Clean Digital Delay', family: 'Delay', dsp: 'delay', voice: 'digital', cost: 1, color: '#d9dde3', place: 'post', trails: true,
    blurb: 'Pristine repeats with tap-tempo divisions, gentle modulation and ping-pong.',
    params: [p('time', 'Time', 40, 2000, 450, 'ms', 'log'), opt('sync', 'Sync', DIVISIONS.map((d) => d.label), 0), pct('feedback', 'Feedback', 32),
      pct('mix', 'Mix', 25), p('tone', 'Tone', 1000, 12000, 6500, 'Hz', 'log'), p('lowcut', 'Low Cut', 40, 800, 160, 'Hz', 'log'), pct('mod', 'Mod', 10),
      opt('mode', 'Mode', ['Stereo', 'Ping-Pong', 'Mono'], 0)],
  },
  'dotted-delay': {
    name: 'Dot Eight', label: 'Dotted-Eighth Delay', family: 'Delay', dsp: 'delay', voice: 'digital', cost: 1, color: '#e2b23a', place: 'post', trails: true,
    blurb: 'The signature worship rhythm delay, locked to tap tempo on dotted eighths.',
    params: [p('time', 'Time', 40, 2000, 375, 'ms', 'log'), opt('sync', 'Sync', DIVISIONS.map((d) => d.label), 2), pct('feedback', 'Feedback', 35),
      pct('mix', 'Mix', 28), p('tone', 'Tone', 1000, 12000, 5200, 'Hz', 'log'), p('lowcut', 'Low Cut', 40, 800, 220, 'Hz', 'log'), pct('mod', 'Mod', 8),
      opt('mode', 'Mode', ['Stereo', 'Ping-Pong', 'Mono'], 1)],
  },
  'analog-delay': {
    name: 'Ember Echo', label: 'Analog-Style Delay', family: 'Delay', dsp: 'delay', voice: 'analog', cost: 1, color: '#8a3b2c', place: 'post', trails: true,
    blurb: 'Warm, darkening repeats that soften as they fade, like a bucket-brigade delay.',
    params: [p('time', 'Time', 40, 1200, 420, 'ms', 'log'), opt('sync', 'Sync', DIVISIONS.map((d) => d.label), 0), pct('feedback', 'Feedback', 40),
      pct('mix', 'Mix', 25), p('tone', 'Tone', 800, 6000, 2800, 'Hz', 'log'), p('lowcut', 'Low Cut', 40, 800, 120, 'Hz', 'log'), pct('mod', 'Mod', 22),
      opt('mode', 'Mode', ['Stereo', 'Ping-Pong', 'Mono'], 0)],
  },
  'hall-reverb': {
    name: 'Great Hall', label: 'Large Hall Reverb', family: 'Reverb', dsp: 'reverb', voice: 'hall', cost: 4, color: '#3b3f8f', place: 'post', trails: true,
    blurb: 'Big, smooth hall with lush modulated tails and a low cut to keep things clear.',
    params: [p('decay', 'Decay', 0.4, 12, 3.6, 's', 'log'), pct('mix', 'Mix', 26), p('predelay', 'Pre-delay', 0, 200, 28, 'ms'),
      pct('size', 'Size', 75), p('tone', 'Tone', 1500, 14000, 6000, 'Hz', 'log'), p('lowcut', 'Low Cut', 40, 800, 220, 'Hz', 'log'), pct('mod', 'Mod', 35)],
  },
  'plate-reverb': {
    name: 'Silver Plate', label: 'Plate Reverb', family: 'Reverb', dsp: 'reverb', voice: 'plate', cost: 4, color: '#9aa3ad', place: 'post', trails: true,
    blurb: 'Bright, dense studio plate that sits behind the guitar without washing it out.',
    params: [p('decay', 'Decay', 0.3, 8, 1.9, 's', 'log'), pct('mix', 'Mix', 22), p('predelay', 'Pre-delay', 0, 150, 12, 'ms'),
      pct('size', 'Size', 45), p('tone', 'Tone', 1500, 14000, 8000, 'Hz', 'log'), p('lowcut', 'Low Cut', 40, 800, 180, 'Hz', 'log'), pct('mod', 'Mod', 15)],
  },
};

// Character settings used by the DSP classes.
export const VOICES = {
  comp: { studio: { knee: 6, detect: 'peak' } },
  drive: {
    // hp: input high-pass; midHz/midDb: pre-clip emphasis; gain: max drive (dB);
    // asym: clip asymmetry (even harmonics); lp: post-clip smoothing; floorDb: drive at 0 %
    transparent: { hp: 120, midHz: 900, midDb: 3, gainMin: 2, gainMax: 30, asym: 0.12, lp: 7000, toneLo: 2000, toneHi: 9000, lowKeep: 1 },
    midhump: { hp: 720, midHz: 720, midDb: 7, gainMin: 6, gainMax: 40, asym: 0.05, lp: 5200, toneLo: 1500, toneHi: 7000, lowKeep: 0.15 },
  },
  delay: {
    digital: { sat: 0, darken: 0, wow: 0 },
    analog: { sat: 0.6, darken: 0.35, wow: 0.3 },
  },
  reverb: {
    // lens: FDN line lengths (ms) scaled by size; diff: input diffusion allpass lengths (ms)
    hall: { lens: [43.1, 51.7, 61.3, 69.9, 78.7, 89.3, 97.1, 107.9], diff: [4.7, 7.3, 11.1, 15.9], diffG: 0.68, sizeMin: 0.55, sizeMax: 1.6 },
    plate: { lens: [19.7, 23.3, 27.1, 31.9, 36.7, 41.1, 47.3, 53.9], diff: [2.1, 3.7, 5.3, 7.9], diffG: 0.75, sizeMin: 0.5, sizeMax: 1.4 },
  },
};

// Amp characters. Gain is in dB of preamp drive; tone stack frequencies in Hz.
// stereoB: for the dual rig, the right-channel voice.
export const AMPS = [
  { id: 'chime30', name: 'Chapel 30', label: 'British Chime 30', blurb: 'Chimey, top-boosted British Class A clean (AC30-inspired).', cab: 'bright-chime',
    hp: 90, bright: 4, gainLo: 0, gainHi: 30, asym: 0.18, bassHz: 110, midHz: 900, midScoop: -2, trebHz: 2800, presHz: 4200, lp: 9000, power: 0.9, sag: 0.45, outTrim: -1 },
  { id: 'american-clean', name: 'Westbound Clean', label: 'American Clean', blurb: 'Scooped, sparkly clean with deep lows and lots of headroom.', cab: '1x12-open',
    hp: 70, bright: 3, gainLo: -6, gainHi: 18, asym: 0.08, bassHz: 90, midHz: 480, midScoop: -4, trebHz: 3200, presHz: 5000, lp: 9500, power: 0.6, sag: 0.25, outTrim: 0 },
  { id: 'american-edge', name: 'Westbound Edge', label: 'American Edge', blurb: 'The same clean amp pushed to the edge of breakup.', cab: '1x12-open',
    hp: 80, bright: 2, gainLo: 6, gainHi: 32, asym: 0.15, bassHz: 95, midHz: 550, midScoop: -2, trebHz: 3000, presHz: 4800, lp: 8500, power: 1.1, sag: 0.5, outTrim: -2 },
  { id: 'boutique-a', name: 'Atelier A', label: 'Boutique Class A', blurb: 'Touch-sensitive boutique amp with blooming compression.', cab: '2x12-boutique',
    hp: 85, bright: 2, gainLo: 2, gainHi: 30, asym: 0.22, bassHz: 100, midHz: 750, midScoop: 1, trebHz: 2600, presHz: 4000, lp: 8000, power: 1.2, sag: 0.75, outTrim: -2 },
  { id: 'modern-clean', name: 'Summit Clean', label: 'Modern Worship Clean', blurb: 'Neutral, high-headroom platform that lets pedals do the talking.', cab: 'warm-studio',
    hp: 75, bright: 1, gainLo: -8, gainHi: 14, asym: 0.05, bassHz: 100, midHz: 700, midScoop: 0, trebHz: 3000, presHz: 4500, lp: 10000, power: 0.4, sag: 0.15, outTrim: 0 },
  { id: 'british-crunch', name: 'Albion Crunch', label: 'British Crunch', blurb: 'Warm, mid-pushed British crunch for rhythm and leads.', cab: '4x12-british',
    hp: 100, bright: 2, gainLo: 10, gainHi: 40, asym: 0.12, bassHz: 110, midHz: 850, midScoop: 3, trebHz: 2500, presHz: 3800, lp: 7000, power: 1.4, sag: 0.55, outTrim: -4 },
  { id: 'stereo-rig', name: 'Twin Horizons', label: 'Stereo Ambient Rig', blurb: 'Two complementary amps, chime on the left and American clean on the right.', cab: 'bright-chime', cabB: '1x12-open',
    hp: 90, bright: 3, gainLo: 0, gainHi: 28, asym: 0.16, bassHz: 110, midHz: 900, midScoop: -2, trebHz: 2800, presHz: 4200, lp: 9000, power: 0.9, sag: 0.45, outTrim: -2,
    stereoB: 'american-clean' },
];
export const ampById = (id) => AMPS.find((a) => a.id === id) || AMPS[0];

export const AMP_PARAMS = [p('gain', 'Gain', 0, 100, 35, '%'), p('bass', 'Bass', 0, 10, 5), p('mid', 'Mid', 0, 10, 5), p('treble', 'Treble', 0, 10, 5.5),
  p('presence', 'Presence', 0, 10, 5), p('master', 'Master', 0, 100, 50, '%'), p('sag', 'Sag', 0, 100, 50, '%'), p('bright', 'Bright', 0, 100, 40, '%'),
  p('output', 'Output', -24, 12, 0, 'dB')];

// Cabinet characters, synthesised into impulse responses by cab.js.
// lowHz/lowQ: low resonance; bumps: [Hz, dB, Q]; lp: top roll-off; open: open-back diffusion.
export const CABS = [
  { id: '1x12-open', name: '1x12 Open Back', lowHz: 95, lowQ: 1.0, bumps: [[180, -1, 1], [1200, 1.5, 1.2], [2600, 3.5, 1.6], [3900, -2, 3]], lp: 5600, open: 0.5 },
  { id: '2x12-british', name: '2x12 British', lowHz: 105, lowQ: 1.4, bumps: [[150, 2, 1.2], [450, -2.5, 1.2], [1700, 2, 1.4], [3200, 4, 1.8]], lp: 5400, open: 0.35 },
  { id: '2x12-boutique', name: '2x12 Boutique', lowHz: 100, lowQ: 1.2, bumps: [[220, 1.5, 1], [800, 1.5, 1], [2400, 2.5, 1.4], [4200, -3, 2]], lp: 5000, open: 0.3 },
  { id: '4x12-british', name: '4x12 British', lowHz: 85, lowQ: 1.6, bumps: [[120, 3, 1.3], [500, -3, 1.1], [2000, 3, 1.5], [3500, 3, 2]], lp: 4800, open: 0 },
  { id: 'warm-studio', name: 'Warm Studio Cabinet', lowHz: 90, lowQ: 1.1, bumps: [[200, 2, 0.9], [1000, 0.5, 1], [2600, 1, 1.4], [4000, -3, 1.5]], lp: 4600, open: 0.15 },
  { id: 'bright-chime', name: 'Bright Chime Cabinet', lowHz: 110, lowQ: 1.2, bumps: [[300, -1.5, 1], [1400, 1, 1.2], [2900, 5, 1.7], [4500, 1.5, 2.5]], lp: 6200, open: 0.4 },
];
export const cabById = (id) => CABS.find((c) => c.id === id) || CABS[0];

export function pedalDefaults(type) {
  const d = PEDALS[type], o = {};
  for (const q of d.params) o[q.k] = q.def;
  return o;
}
export function ampDefaults() { const o = {}; for (const q of AMP_PARAMS) o[q.k] = q.def; return o; }

// Map between a parameter's value and a 0..1 knob position.
export function toNorm(q, v) {
  if (q.enum) return q.options.length > 1 ? v / (q.options.length - 1) : 0;
  if (q.curve === 'log') return Math.log(v / q.min) / Math.log(q.max / q.min);
  return (v - q.min) / (q.max - q.min);
}
export function fromNorm(q, n) {
  n = n < 0 ? 0 : n > 1 ? 1 : n;
  if (q.enum) return Math.round(n * (q.options.length - 1));
  if (q.curve === 'log') return q.min * Math.pow(q.max / q.min, n);
  return q.min + (q.max - q.min) * n;
}
