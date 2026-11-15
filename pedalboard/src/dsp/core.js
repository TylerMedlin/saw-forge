// Small real-time DSP building blocks shared by every pedal and the amp.
// Everything here allocates only in constructors, never per sample.

export const TAU = Math.PI * 2;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(g > 1e-12 ? g : 1e-12);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Smooth saturating curve (tanh-like rational approximation, exact 1 at |x| >= 3).
export function softClip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

// Biquad in transposed direct form II (RBJ cookbook coefficients).
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  reset() { this.z1 = 0; this.z2 = 0; }
  set(type, freq, q, gainDb, fs) {
    const f = clamp(freq, 5, fs * 0.49);
    const w = TAU * f / fs, cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * (q || 0.7071));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
      }
      case 'lp1': { const k = Math.tan(w / 2); b0 = k / (1 + k); b1 = b0; b2 = 0; a0 = 1; a1 = (k - 1) / (k + 1); a2 = 0; break; }
      case 'hp1': { const k = Math.tan(w / 2); b0 = 1 / (1 + k); b1 = -b0; b2 = 0; a0 = 1; a1 = (k - 1) / (k + 1); a2 = 0; break; }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// One-pole lowpass / DC blocker helpers.
export class OnePole {
  constructor() { this.a = 0; this.y = 0; }
  setHz(hz, fs) { this.a = Math.exp(-TAU * hz / fs); return this; }
  setMs(ms, fs) { this.a = ms <= 0 ? 0 : Math.exp(-1 / (ms * 0.001 * fs)); return this; }
  process(x) { this.y = x + (this.y - x) * this.a; return this.y; }
  reset(v = 0) { this.y = v; }
}

// Parameter smoother (about 20 ms) so knob moves never click.
export class Smooth {
  constructor(v = 0, ms = 20, fs = 48000) { this.v = v; this.t = v; this.k = 1 - Math.exp(-1 / (ms * 0.001 * fs)); }
  set(t) { this.t = t; }
  jump(v) { this.v = v; this.t = v; }
  next() { this.v += (this.t - this.v) * this.k; return this.v; }
  get settled() { return Math.abs(this.t - this.v) < 1e-6; }
}

// 4x oversampler: zero-stuff + 6th-order Butterworth lowpass on the way up and
// the same filter before decimating. Lets drives clip without harsh aliasing.
const OS_Q = [0.5176, 0.7071, 1.9319];
export class Oversampler4 {
  constructor(fs) {
    this.up = OS_Q.map((q) => new Biquad().set('lp', fs * 0.45, q, 0, fs * 4));
    this.dn = OS_Q.map((q) => new Biquad().set('lp', fs * 0.45, q, 0, fs * 4));
  }
  reset() { for (const b of this.up) b.reset(); for (const b of this.dn) b.reset(); }
  // fn: nonlinearity applied at the 4x rate. Returns one output sample.
  run(x, fn, ctx) {
    const u0 = this.up[0], u1 = this.up[1], u2 = this.up[2], d0 = this.dn[0], d1 = this.dn[1], d2 = this.dn[2];
    let y = 0;
    for (let i = 0; i < 4; i++) {
      const s = u2.process(u1.process(u0.process(i === 0 ? x * 4 : 0)));
      y = d2.process(d1.process(d0.process(fn(s, ctx))));
    }
    return y;
  }
}

// Fractional-delay circular buffer (linear interpolation).
export class DelayLine {
  constructor(len) { this.buf = new Float32Array(len); this.len = len; this.w = 0; }
  reset() { this.buf.fill(0); }
  write(x) { this.buf[this.w] = x; this.w = this.w + 1 === this.len ? 0 : this.w + 1; }
  // d: delay in samples (>= 1)
  read(d) {
    let p = this.w - d;
    while (p < 0) p += this.len;
    const i = p | 0, f = p - i, j = i + 1 === this.len ? 0 : i + 1;
    return this.buf[i] + (this.buf[j] - this.buf[i]) * f;
  }
}

export const finite = (v) => (v === v && v !== Infinity && v !== -Infinity);
