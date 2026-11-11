// Session Pianist: the piano characters and the instrument's parameter set.
// Shared by the UI thread and the audio thread (src/audio/worklet/piano.js).
// Every note is synthesized by a physical model (hammer, coupled strings,
// bridge, soundboard): there are no samples anywhere.

function P(id, name, min, max, def, o = {}) {
  return { id, name, min, max, def, curve: o.curve || 'lin', skew: 1, unit: o.unit || '', options: o.options || null,
    automatable: o.automatable !== false, short: o.short || name, bipolar: min < 0 && max > 0 };
}

// Each character changes the physics, not just the tone: hammer mass and felt
// stiffness (k0, p), string stiffness (inh), losses (t60 internal, prompt =
// bridge coupling, hf = high-partial decay), unison detune (cents), soundboard
// size (sbScale moves its modes up), damper strength and voicing irregularity.
export const PIANO_MODELS = [
  { name: 'Concert Grand', desc: 'Rich, dynamic nine-foot grand', mass: 1, k0: 1, p: 0, beta: 1, inh: 1, t60: 1, prompt: 1, hf: 1, uni: 0.5, stretch: 1, sbScale: 1, sbQ: 1, sbGain: 1, low: 1, mech: 1, damp: 1, irr: 0, hyst: 1, gain: 1 },
  { name: 'Warm Upright', desc: 'Intimate, woody upright with some mechanism noise', mass: 0.85, k0: 0.55, p: -0.1, beta: 1.15, inh: 2.6, t60: 0.55, prompt: 0.6, hf: 0.6, uni: 1, stretch: 0.8, sbScale: 1.45, sbQ: 0.75, sbGain: 1.3, low: 0.55, mech: 1.8, damp: 1.25, irr: 0.15, hyst: 1.4, gain: 1.25 },
  { name: 'Studio Grand', desc: 'Balanced, clear recording grand', mass: 0.95, k0: 1.5, p: 0.05, beta: 0.95, inh: 1.2, t60: 0.85, prompt: 0.85, hf: 1.35, uni: 0.3, stretch: 1, sbScale: 1.1, sbQ: 0.9, sbGain: 0.85, low: 0.85, mech: 0.7, damp: 1, irr: 0, hyst: 0.8, gain: 0.95 },
  { name: 'Felt Piano', desc: 'Felt strip between hammers and strings: soft, muted, close', mass: 1.1, k0: 0.07, p: -0.45, beta: 1, inh: 2, t60: 0.5, prompt: 0.7, hf: 0.28, uni: 0.8, stretch: 0.8, sbScale: 1.35, sbQ: 0.8, sbGain: 1.4, low: 1.1, mech: 2.2, damp: 1.5, irr: 0.1, hyst: 4, gain: 1.9 },
  { name: 'Vintage Character', desc: 'Worn hammers, wandering unisons, uneven voicing', mass: 1, k0: 1.3, p: 0.1, beta: 1.05, inh: 1.5, t60: 0.7, prompt: 0.75, hf: 0.8, uni: 2.6, stretch: 1.2, sbScale: 1.2, sbQ: 0.85, sbGain: 1.2, low: 0.8, mech: 1.5, damp: 0.8, irr: 1, hyst: 0.6, gain: 1.1 },
];
export const PIANO_MODEL_NAMES = PIANO_MODELS.map((m) => m.name);

export const PIANO_PARAMS = [
  P('model', 'Piano', 0, PIANO_MODELS.length - 1, 0, { curve: 'enum', options: PIANO_MODEL_NAMES, automatable: false }),
  P('bright', 'Brightness', 0, 1, 0.5, { unit: '%' }),
  P('warmth', 'Warmth', 0, 1, 0.5, { unit: '%' }),
  P('hard', 'Hammer Hardness', 0, 1, 0.5, { unit: '%', short: 'Hammer' }),
  P('mech', 'Mechanical Character', 0, 1, 0.35, { unit: '%', short: 'Mechanics' }),
  P('sbres', 'Soundboard Resonance', 0, 1, 0.5, { unit: '%', short: 'Soundboard' }),
  P('sres', 'String Resonance', 0, 1, 0.5, { unit: '%', short: 'Resonance' }),
  P('width', 'Stereo Width', 0, 1, 0.6, { unit: '%', short: 'Width' }),
  P('sustain', 'Sustain', 0, 1, 0.5, { unit: '%' }),
  P('room', 'Room Ambience', 0, 1, 0.2, { unit: '%', short: 'Room' }),
  P('tuning', 'Tuning Character', 0, 1, 0.3, { unit: '%', short: 'Tuning' }),
  P('dyn', 'Dynamic Response', 0, 1, 0.5, { unit: '%', short: 'Dynamics' }),
  P('pedal', 'Sustain Pedal', 0, 1, 0, { unit: '%', short: 'Pedal' }),
  P('level', 'Level', -24, 6, 0, { unit: 'dB' }),
];
export const PIANO_INDEX = Object.fromEntries(PIANO_PARAMS.map((p, i) => [p.id, i]));
export const PIANO_DEF = Object.fromEntries(PIANO_PARAMS.map((p) => [p.id, p]));
export const PIANO_COUNT = PIANO_PARAMS.length;
export function pianoDefaults() { return Object.fromEntries(PIANO_PARAMS.map((p) => [p.id, p.def])); }
export function pianoParamArray(params) { return Float64Array.from(PIANO_PARAMS.map((d) => (params && typeof params[d.id] === 'number' ? params[d.id] : d.def))); }
