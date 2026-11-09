// Small DSP helpers shared by the audio thread and the UI (response curves).

export const BQ = { PEAK: 0, LOWSHELF: 1, HIGHSHELF: 2, LOWPASS: 3, HIGHPASS: 4, BANDPASS: 5, NOTCH: 6 };

// RBJ cookbook biquad. Writes normalized [b0, b1, b2, a1, a2] into out.
export function biquadCoefs(type, f, q, gainDb, sr, out) {
  const w0 = (2 * Math.PI * Math.min(Math.max(f, 1), sr * 0.49)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sw / (2 * Math.max(q, 0.05));
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case BQ.PEAK:
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case BQ.LOWSHELF: {
      const sa = 2 * Math.sqrt(A) * (sw / 2) * Math.SQRT2;
      b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa);
      a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa; break;
    }
    case BQ.HIGHSHELF: {
      const sa = 2 * Math.sqrt(A) * (sw / 2) * Math.SQRT2;
      b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa);
      a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa; break;
    }
    case BQ.LOWPASS:
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case BQ.HIGHPASS:
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case BQ.BANDPASS:
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    default: // NOTCH
      b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
  }
  out[0] = b0 / a0; out[1] = b1 / a0; out[2] = b2 / a0; out[3] = a1 / a0; out[4] = a2 / a0;
  return out;
}

// Magnitude (linear) of a biquad at frequency f.
export function biquadMag(c, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
  const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

// Analog-prototype magnitude of the Saw Forge filter modes (for drawing).
export function synthFilterMag(mode, f, fc, res) {
  const w = f / fc;
  if (mode === 5) return 1;
  if (mode === 2) { // ladder: 1 / ((1+s)^4 + k)
    const k = res * 3.9;
    // (1 + jw)^4
    const r2 = 1 - w * w, i2 = 2 * w; // (1+jw)^2
    const r4 = r2 * r2 - i2 * i2 + k, i4 = 2 * r2 * i2;
    return (1 + k * 0.25) / Math.hypot(r4, i4);
  }
  const kk = 2 - 1.96 * res;
  const dr = 1 - w * w, di = kk * w;
  const den = Math.hypot(dr, di);
  if (mode === 0) return 1 / den;
  if (mode === 1) { const d1 = Math.hypot(1 - w * w, 1.85 * w); return 1 / (den * d1); }
  if (mode === 3) return (w * w) / den;
  return (kk * w) / den; // band-pass normalized
}
