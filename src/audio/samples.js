// Factory one-shot samples, synthesized deterministically at startup and
// encoded as WAV so they behave exactly like imported files.

import { encodeWav } from './wav.js';

const SR = 48000;
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; }; }
const env = (t, d) => Math.exp(-t / d);

function kick() {
  const n = Math.round(SR * 0.6), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 44 + 120 * Math.exp(-t / 0.035);
    ph += f / SR;
    const click = i < 96 ? (1 - i / 96) * 0.35 * Math.sin(i * 0.9) : 0;
    out[i] = Math.tanh(1.6 * Math.sin(2 * Math.PI * ph) * env(t, 0.18)) * 0.9 + click;
  }
  return out;
}
function snare() {
  const n = Math.round(SR * 0.35), out = new Float32Array(n), r = rng(7);
  let lp = 0, hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tone = (Math.sin(2 * Math.PI * 185 * t) * 0.6 + Math.sin(2 * Math.PI * 330 * t) * 0.3) * env(t, 0.05);
    const w = r(); lp += (w - lp) * 0.5; hp = w - lp;
    out[i] = (tone + hp * 1.1 * env(t, 0.09)) * 0.7;
  }
  return out;
}
function hat(decay, seed) {
  const n = Math.round(SR * (decay * 6 + 0.02)), out = new Float32Array(n), r = rng(seed);
  const freqs = [2.1, 3.17, 4.33, 5.47, 6.73, 8.21].map((m) => m * 1000);
  let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let metal = 0;
    for (const f of freqs) metal += Math.sign(Math.sin(2 * Math.PI * f * t));
    const s = metal * 0.12 + r() * 0.6;
    const h1 = 0.92 * (y1 + s - x1); x1 = s; y1 = h1;
    const h2 = 0.92 * (y2 + h1 - x2); x2 = h1; y2 = h2;
    out[i] = h2 * env(t, decay) * 0.5;
  }
  return out;
}
function clap() {
  const n = Math.round(SR * 0.45), out = new Float32Array(n), r = rng(99);
  let b1 = 0, b2 = 0;
  const f = 1200 / SR * 2 * Math.PI, q = 0.25;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = 0;
    for (const o of [0, 0.011, 0.023]) if (t >= o) e = Math.max(e, env(t - o, 0.008));
    e = Math.max(e, t > 0.025 ? env(t - 0.025, 0.12) * 0.6 : 0);
    const x = r();
    b1 += f * (x - b1 - q * b2); b2 += f * b1; // crude band-pass
    out[i] = b1 * e * 1.4;
  }
  return out;
}
function rim() {
  const n = Math.round(SR * 0.12), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] = (Math.sin(2 * Math.PI * 1700 * t) * 0.6 + Math.sin(2 * Math.PI * 820 * t) * 0.4) * env(t, 0.012) * 0.8; }
  return out;
}
function tom() {
  const n = Math.round(SR * 0.5), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += (95 + 60 * Math.exp(-t / 0.05)) / SR; out[i] = Math.sin(2 * Math.PI * ph) * env(t, 0.16) * 0.8; }
  return out;
}

const DEFS = [
  ['Forge Kick', kick], ['Forge Snare', snare], ['Closed Hat', () => hat(0.025, 3)], ['Open Hat', () => hat(0.12, 5)],
  ['Clap', clap], ['Rim', rim], ['Low Tom', tom],
];

let cache = null;
export function factorySamples() {
  if (cache) return cache;
  cache = DEFS.map(([name, fn], i) => {
    const data = fn();
    let peak = 0; for (const x of data) peak = Math.max(peak, Math.abs(x));
    const g = peak > 0 ? 0.89 / peak : 1; // about -1 dBFS
    for (let k = 0; k < data.length; k++) data[k] *= g;
    return { id: 'factory_' + i, name, bytes: encodeWav([data], SR, 16), factory: true };
  });
  return cache;
}
