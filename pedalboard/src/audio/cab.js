// Speaker-cabinet impulse responses, synthesised from each cabinet's
// resonances and roll-off (original, freely distributable), plus loading of
// a person's own IR files. The IR runs in a native ConvolverNode.

import { Biquad } from '../dsp/core.js';
import { cabById } from '../shared/defs.js';

const IR_MS = 42;

// mic: 0 = centre of the cone (brightest) … 1 = edge (darkest)
// distance: 0 = close-mic … 1 = a little back (room reflections, softer lows)
export function cabIR(id, sampleRate, mic = 0.35, distance = 0.2) {
  const c = cabById(id), fs = sampleRate, n = Math.round(IR_MS * 0.001 * fs);
  const ir = new Float32Array(n);
  const f = [];
  const add = (type, hz, q, db) => f.push(new Biquad().set(type, hz, q, db, fs));
  add('hp', c.lowHz * 0.85, c.lowQ, 0);                    // cone resonance / low cut
  add('peak', c.lowHz * 1.1, 1.2, 3 - distance * 2);       // resonance bump (proximity)
  for (const [hz, db, q] of c.bumps) add('peak', hz, q, db);
  const lp = c.lp * (1.18 - mic * 0.45);                   // off-axis = darker
  add('lp', lp, 0.75, 0); add('lp', lp * 1.25, 0.6, 0);
  add('peak', lp * 1.45, 4, -8);                           // cone break-up notch
  add('lp', Math.min(fs * 0.45, lp * 2.2), 0.7, 0);
  add('highshelf', 2500, 0.7, -mic * 3);
  // impulse through the filters
  for (let i = 0; i < n; i++) { let x = i === 0 ? 1 : 0; for (const b of f) x = b.process(x); ir[i] = x; }
  // open-back diffusion + mic distance: a few short reflections
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const refl = [[0.9 + distance * 3, 0.25 * distance + 0.12 * c.open], [2.3 + distance * 4, 0.12 * c.open + 0.1 * distance], [4.1 + distance * 5, 0.08 * c.open]];
  const base = ir.slice();
  for (const [ms, g] of refl) {
    const d = Math.round(ms * 0.001 * fs);
    for (let i = 0; i + d < n; i++) ir[i + d] += base[i] * g * (0.7 + 0.3 * rnd());
  }
  // fade the end, then normalise so every cab sits at a similar loudness (energy at ~1 kHz)
  const fade = Math.round(n * 0.3);
  for (let i = 0; i < fade; i++) ir[n - 1 - i] *= i / fade;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) { const w = 2 * Math.PI * 1000 * i / fs; re += ir[i] * Math.cos(w); im -= ir[i] * Math.sin(w); }
  const mag = Math.hypot(re, im) || 1;
  for (let i = 0; i < n; i++) ir[i] /= mag;
  return ir;
}

// Build an AudioBuffer for the convolver. Two channels so the stereo rig can
// use a different cabinet on each side (true-stereo pair: L→IR0, R→IR1).
export function cabBuffer(ctx, idA, idB, mic, distance) {
  const a = cabIR(idA, ctx.sampleRate, mic, distance), b = idB ? cabIR(idB, ctx.sampleRate, mic, distance) : a;
  const buf = ctx.createBuffer(2, Math.max(a.length, b.length), ctx.sampleRate);
  buf.copyToChannel(a, 0); buf.copyToChannel(b, 1);
  return buf;
}

// A person's own cabinet IR (WAV, etc.). Trimmed to 500 ms, normalised.
export async function loadUserIR(ctx, arrayBuffer) {
  const src = await ctx.decodeAudioData(arrayBuffer);
  const n = Math.min(src.length, Math.round(ctx.sampleRate * 0.5));
  if (n < 16) throw new Error('That file is too short to be a cabinet IR.');
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  let peakEnergy = 0;
  const chans = [0, 1].map((c) => src.getChannelData(Math.min(c, src.numberOfChannels - 1)).slice(0, n));
  for (const d of chans) { let e = 0; for (let i = 0; i < n; i++) e += d[i] * d[i]; peakEnergy = Math.max(peakEnergy, e); }
  const g = peakEnergy > 0 ? 1 / Math.sqrt(peakEnergy) * 0.5 : 1;
  chans.forEach((d, c) => { for (let i = 0; i < n; i++) d[i] *= g; buf.copyToChannel(d, c); });
  return buf;
}
