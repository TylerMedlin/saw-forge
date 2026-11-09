// Saw Forge wavetable model.
//
// A wavetable is a list of 1..8 key frames. Each key frame starts from a
// time-domain prototype (an "analog" sawtooth with ramp curvature and a
// finite reset slope, or a user-drawn cycle), is converted to a harmonic
// spectrum, and is then shaped (per-harmonic gains, even-harmonic balance,
// spectral tilt). Between key frames the spectra are interpolated in
// magnitude/phase, which morphs smoothly without the cancellation you get
// from crossfading waveforms. Finally each rendered frame is resynthesized
// as a band-limited mip chain (one table per octave), so the oscillator can
// pick a table with no harmonics above Nyquist for the note being played.
//
// Pure math, no DOM: used by the UI (previews), the table-builder worker and tests.

export const WT_SIZE = 2048;          // samples per table cycle
export const WT_MIPS = 10;            // octave mip levels
export const WT_HARM = 1023;          // highest harmonic stored (WT_SIZE/2 - 1)
export const WT_PROTO = 16384;        // prototype resolution (keeps prototype aliasing far below audibility)
export const WT_EDIT_HARM = 64;       // editable harmonic gains
export const WT_MAX_KEYS = 8;

export const mipHarmonics = (m) => Math.max(1, Math.floor(WT_HARM / (1 << m)));

export function makeFrame(o = {}) {
  return { curve: 0, reset: 0, even: 1, bright: 0, harm: null, draw: null, ...o };
}
export function makeWavetable(name, frames) { return { name, frames: frames.map((f) => makeFrame(f)) }; }
export const defaultDrawPoints = () => [{ x: 0, y: -1 }, { x: 0.5, y: 0 }, { x: 0.995, y: 1 }];

export function renderedFrameCount(K) {
  if (K <= 1) return 1;
  const steps = Math.max(2, Math.floor(32 / (K - 1)));
  return (K - 1) * steps + 1;
}

// ---------- FFT (in place, radix-2, complex) ----------
export function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const br = re[b] * cr - im[b] * ci;
        const bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}

// ---------- prototypes ----------
function curveFn(u, c) {
  if (Math.abs(c) < 1e-3) return u;
  const k = c * 4;
  return (1 - Math.exp(-k * u)) / (1 - Math.exp(-k));
}

// Rising ramp from -1 to +1 over (1 - reset) of the cycle, then a linear
// fall back to -1 over `reset`. reset = 0 is an ideal saw, 0.5 a triangle.
export function protoSaw(curve, reset, out) {
  const N = out.length;
  const r = Math.min(0.5, Math.max(0, reset));
  const rampEnd = 1 - r;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    if (t < rampEnd) out[i] = -1 + 2 * curveFn(t / rampEnd, curve);
    else out[i] = 1 - 2 * ((t - rampEnd) / r);
  }
}

export function sortedPoints(points) {
  return points.map((p) => ({ x: Math.min(0.9999, Math.max(0, p.x)), y: Math.min(1, Math.max(-1, p.y)) })).sort((a, b) => a.x - b.x);
}

// Periodic interpolation through user points (linear or Catmull-Rom).
export function protoDraw(draw, out) {
  const pts = sortedPoints(draw.points);
  const n = pts.length, N = out.length;
  if (n === 0) { out.fill(0); return; }
  if (n === 1) { out.fill(pts[0].y); return; }
  const P = (i) => { // periodic point access with x unwrapped
    const w = Math.floor(i / n);
    const p = pts[((i % n) + n) % n];
    return { x: p.x + w, y: p.y };
  };
  let j = -1; // index of segment start (may be -1 meaning last point of previous period)
  for (let i = 0; i < N; i++) {
    const x = i / N;
    while (j + 1 < n && pts[j + 1].x <= x) j++;
    const a = P(j), b = P(j + 1);
    const span = b.x - a.x;
    const t = span > 1e-9 ? (x - a.x) / span : 1;
    if (!draw.smooth) out[i] = a.y + (b.y - a.y) * t;
    else {
      const p0 = P(j - 1), p3 = P(j + 2);
      // Catmull-Rom (uniform), clamped to the drawable range
      const t2 = t * t, t3 = t2 * t;
      const v = 0.5 * ((2 * a.y) + (-p0.y + b.y) * t + (2 * p0.y - 5 * a.y + 4 * b.y - p3.y) * t2 + (-p0.y + 3 * a.y - 3 * b.y + p3.y) * t3);
      out[i] = Math.max(-1.2, Math.min(1.2, v));
    }
  }
}

// ---------- spectra ----------
const specCache = new Map();
function frameKey(fr) { return JSON.stringify(fr); }

// Returns harmonic coefficients C_k (k = 1..WT_HARM) such that
// x(t) = sum_k 2*Re(C_k e^{i 2 pi k t}).
export function keyFrameSpectrum(fr) {
  const key = frameKey(fr);
  const hit = specCache.get(key);
  if (hit) return hit;
  const re = new Float64Array(WT_PROTO), im = new Float64Array(WT_PROTO);
  if (fr.draw && fr.draw.points && fr.draw.points.length >= 1) protoDraw(fr.draw, re);
  else protoSaw(fr.curve || 0, fr.reset || 0, re);
  fft(re, im, false);
  const outRe = new Float64Array(WT_HARM + 1), outIm = new Float64Array(WT_HARM + 1);
  const scale = 1 / WT_PROTO;
  const even = fr.even ?? 1, bright = fr.bright || 0, harm = fr.harm;
  for (let k = 1; k <= WT_HARM; k++) {
    let g = scale;
    if ((k & 1) === 0) g *= even;
    if (bright) g *= Math.pow(k, bright * 0.5);
    if (harm && k <= harm.length) g *= harm[k - 1];
    outRe[k] = re[k] * g; outIm[k] = im[k] * g;
  }
  const spec = { re: outRe, im: outIm };
  specCache.set(key, spec);
  if (specCache.size > 96) specCache.delete(specCache.keys().next().value);
  return spec;
}

export function lerpSpectrum(a, b, t, out, maxH = WT_HARM) {
  for (let k = 1; k <= maxH; k++) {
    const ar = a.re[k], ai = a.im[k], br = b.re[k], bi = b.im[k];
    const m0 = Math.hypot(ar, ai), m1 = Math.hypot(br, bi);
    if (m0 < 1e-12 && m1 < 1e-12) { out.re[k] = 0; out.im[k] = 0; continue; }
    const p0 = m0 < 1e-12 ? Math.atan2(bi, br) : Math.atan2(ai, ar);
    const p1 = m1 < 1e-12 ? p0 : Math.atan2(bi, br);
    let dp = p1 - p0;
    if (dp > Math.PI) dp -= 2 * Math.PI; else if (dp < -Math.PI) dp += 2 * Math.PI;
    const m = m0 + (m1 - m0) * t, p = p0 + dp * t;
    out.re[k] = m * Math.cos(p); out.im[k] = m * Math.sin(p);
  }
}

function spectrumAt(keys, pos, out, maxH) {
  const K = keys.length;
  if (K === 1) { for (let k = 1; k <= maxH; k++) { out.re[k] = keys[0].re[k]; out.im[k] = keys[0].im[k]; } return; }
  const kp = Math.min(1, Math.max(0, pos)) * (K - 1);
  const k0 = Math.min(K - 2, Math.floor(kp));
  lerpSpectrum(keys[k0], keys[k0 + 1], kp - k0, out, maxH);
}

function synth(spec, H, re, im) {
  const N = re.length;
  re.fill(0); im.fill(0);
  const top = Math.min(H, (N >> 1) - 1);
  for (let k = 1; k <= top; k++) {
    re[k] = spec.re[k] * N; im[k] = spec.im[k] * N;
    re[N - k] = re[k]; im[N - k] = -im[k];
  }
  fft(re, im, true);
}

// Full band-limited table set for the audio engine.
export function buildWavetable(wt) {
  const keys = (wt.frames && wt.frames.length ? wt.frames : [makeFrame()]).slice(0, WT_MAX_KEYS).map(keyFrameSpectrum);
  const F = renderedFrameCount(keys.length);
  const row = WT_SIZE + 1;
  const data = new Float32Array(F * WT_MIPS * row);
  const re = new Float64Array(WT_SIZE), im = new Float64Array(WT_SIZE);
  const spec = { re: new Float64Array(WT_HARM + 1), im: new Float64Array(WT_HARM + 1) };
  for (let f = 0; f < F; f++) {
    spectrumAt(keys, F === 1 ? 0 : f / (F - 1), spec, WT_HARM);
    let scale = 1;
    for (let m = 0; m < WT_MIPS; m++) {
      synth(spec, mipHarmonics(m), re, im);
      if (m === 0) {
        let peak = 0;
        for (let i = 0; i < WT_SIZE; i++) { const a = Math.abs(re[i]); if (a > peak) peak = a; }
        scale = peak > 1e-6 ? 1 / peak : 0;
      }
      const base = (f * WT_MIPS + m) * row;
      for (let i = 0; i < WT_SIZE; i++) data[base + i] = re[i] * scale;
      data[base + WT_SIZE] = data[base];
    }
  }
  return { data, frames: F, mips: WT_MIPS, size: WT_SIZE };
}

// Band-limited single-cycle preview for the UI (normalized to its own peak).
export function previewFrame(wt, pos, n = 512, maxH = 160) {
  n = 1 << Math.ceil(Math.log2(Math.max(8, n))); // FFT needs a power of two
  const keys = wt.frames.map(keyFrameSpectrum);
  const H = Math.min(maxH, (n >> 1) - 1);
  const spec = { re: new Float64Array(WT_HARM + 1), im: new Float64Array(WT_HARM + 1) };
  spectrumAt(keys, pos, spec, H);
  const re = new Float64Array(n), im = new Float64Array(n);
  synth(spec, H, re, im);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]));
  const out = new Float32Array(n);
  const s = peak > 1e-6 ? 1 / peak : 0;
  for (let i = 0; i < n; i++) out[i] = re[i] * s;
  return out;
}

// Raw (non band-limited) prototype for showing drawn points/ramp shape.
export function prototypeFrame(fr, n = 512) {
  const out = new Float64Array(n);
  if (fr.draw && fr.draw.points && fr.draw.points.length) protoDraw(fr.draw, out);
  else protoSaw(fr.curve || 0, fr.reset || 0, out);
  return out;
}

// Harmonic magnitudes (1..count) of a key frame, relative to the fundamental of an ideal saw.
export function frameMagnitudes(fr, count = WT_EDIT_HARM) {
  const s = keyFrameSpectrum(fr);
  const out = new Float32Array(count);
  const ref = 1 / Math.PI; // |C_1| of an ideal saw
  for (let k = 1; k <= count; k++) out[k - 1] = Math.hypot(s.re[k], s.im[k]) / ref;
  return out;
}

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export const wavetableHash = (wt) => hashString(JSON.stringify(wt.frames));

// ---------- factory wavetables ----------
const bump = (center, width, depth = 1, base = 0.25) => Array.from({ length: WT_EDIT_HARM }, (_, i) => {
  const k = i + 1;
  return base + depth * Math.exp(-Math.pow((k - center) / width, 2));
});
const hollow = Array.from({ length: WT_EDIT_HARM }, (_, i) => ((i + 1) % 3 === 0 ? 0.05 : 1));
const stairs = { smooth: false, points: [
  { x: 0, y: -1 }, { x: 0.249, y: -1 }, { x: 0.25, y: -0.33 }, { x: 0.499, y: -0.33 },
  { x: 0.5, y: 0.33 }, { x: 0.749, y: 0.33 }, { x: 0.75, y: 1 }, { x: 0.995, y: 1 }] };
const bentSaw = { smooth: true, points: [{ x: 0, y: -1 }, { x: 0.3, y: 0.4 }, { x: 0.6, y: 0.7 }, { x: 0.97, y: 1 }] };

export const WT_PRESETS = [
  makeWavetable('Analog Saw', [{ curve: 0.12, reset: 0.004 }]),
  makeWavetable('Ideal Saw', [{}]),
  makeWavetable('Saw → Square', [{}, { even: 0.45 }, { even: 0 }]),
  makeWavetable('Saw → Triangle', [{ reset: 0 }, { reset: 0.18 }, { reset: 0.5 }]),
  makeWavetable('Dark → Bright', [{ bright: -1 }, { bright: -0.3 }, { bright: 0.2 }, { bright: 0.7 }]),
  makeWavetable('Curved Ramp', [{ curve: -0.9 }, { curve: 0 }, { curve: 0.9 }]),
  makeWavetable('Hollow Saw', [{ harm: hollow }]),
  makeWavetable('Formant Sweep', [{ harm: bump(3, 2) }, { harm: bump(8, 3) }, { harm: bump(16, 4) }, { harm: bump(30, 6) }]),
  makeWavetable('Vowel Saw', [{ harm: bump(4, 1.5, 1.2, 0.3) }, { harm: bump(10, 2, 1.2, 0.3) }]),
  makeWavetable('Stair Step', [{ draw: stairs }, {}]),
  makeWavetable('Bent Saw', [{ draw: bentSaw }, { curve: 0.4, reset: 0.02 }]),
];
export const getWtPreset = (name) => structuredCloneSafe(WT_PRESETS.find((w) => w.name === name) || WT_PRESETS[0]);
export function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
