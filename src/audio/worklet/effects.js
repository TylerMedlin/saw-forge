// Audio-thread effects. Every buffer is allocated in the constructor;
// process() never allocates. Parameters arrive as real values (not normalized).

import { EFFECT_DEFS, SYNC_DIVS } from '../../shared/params.js';
import { biquadCoefs, BQ } from '../../shared/dspmath.js';

const TAU = Math.PI * 2;
const LN2 = Math.LN2;
const dbg = (db) => Math.pow(10, db / 20);
const fastTanh = (x) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));

class Fx {
  constructor(type, sr) {
    this.type = type;
    this.sr = sr;
    this.defs = EFFECT_DEFS[type].params;
    this.p = new Float64Array(this.defs.length);
    this.sp = new Float64Array(this.defs.length); // smoothed copy
    this.i = {};
    this.defs.forEach((d, k) => { this.p[k] = d.def; this.sp[k] = d.def; this.i[d.id] = k; });
    this.dirty = true;
  }
  setParam(k, v) { if (this.p[k] !== v) { this.p[k] = v; this.dirty = true; } }
  // One-pole smoothing at block rate. Returns true while still moving.
  smooth(coef = 0.35) {
    let moving = false;
    const p = this.p, sp = this.sp;
    for (let k = 0; k < p.length; k++) {
      const d = p[k] - sp[k];
      if (d === 0) continue;
      const disc = this.defs[k].curve === 'enum' || this.defs[k].curve === 'bool' || this.defs[k].curve === 'int';
      if (disc || Math.abs(d) < 1e-6 * (Math.abs(p[k]) + 1)) sp[k] = p[k];
      else { sp[k] += d * coef; moving = true; }
    }
    return moving;
  }
  reset() {}
  process() {}
}

// ---------------- EQ Four ----------------
class EQ extends Fx {
  constructor(sr) {
    super('eq', sr);
    this.c = [new Float64Array(5), new Float64Array(5), new Float64Array(5), new Float64Array(5)];
    this.z = new Float64Array(16);
    this.act = new Uint8Array(4);
    this.g = 1;
    this.moving = true;
  }
  reset() { this.z.fill(0); }
  update() {
    const s = this.sp, i = this.i, sr = this.sr;
    biquadCoefs(BQ.LOWSHELF, s[i.lf], 0.707, s[i.lg], sr, this.c[0]);
    biquadCoefs(BQ.PEAK, s[i.m1f], s[i.m1q], s[i.m1g], sr, this.c[1]);
    biquadCoefs(BQ.PEAK, s[i.m2f], s[i.m2q], s[i.m2g], sr, this.c[2]);
    biquadCoefs(BQ.HIGHSHELF, s[i.hf], 0.707, s[i.hg], sr, this.c[3]);
    this.act[0] = Math.abs(s[i.lg]) > 0.01 ? 1 : 0;
    this.act[1] = Math.abs(s[i.m1g]) > 0.01 ? 1 : 0;
    this.act[2] = Math.abs(s[i.m2g]) > 0.01 ? 1 : 0;
    this.act[3] = Math.abs(s[i.hg]) > 0.01 ? 1 : 0;
  }
  process(L, R, n) {
    if (this.dirty || this.moving) { this.moving = this.smooth(); this.dirty = false; this.update(); }
    const z = this.z;
    for (let b = 0; b < 4; b++) {
      if (!this.act[b]) continue;
      const c = this.c[b], b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
      let z1 = z[b * 4], z2 = z[b * 4 + 1], z3 = z[b * 4 + 2], z4 = z[b * 4 + 3];
      for (let k = 0; k < n; k++) {
        const x = L[k], y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; L[k] = y;
        const xr = R[k], yr = b0 * xr + z3;
        z3 = b1 * xr - a1 * yr + z4; z4 = b2 * xr - a2 * yr; R[k] = yr;
      }
      z[b * 4] = z1 + 1e-20; z[b * 4 + 1] = z2; z[b * 4 + 2] = z3 + 1e-20; z[b * 4 + 3] = z4;
    }
    const target = dbg(this.sp[this.i.out]);
    let g = this.g; const dg = (target - g) / n;
    if (Math.abs(dg) > 1e-9 || g !== 1) for (let k = 0; k < n; k++) { L[k] *= g; R[k] *= g; g += dg; }
    this.g = target;
  }
}

// ---------------- Compressor ----------------
class Compressor extends Fx {
  constructor(sr) { super('compressor', sr); this.env = 0; this.gr = 0; }
  reset() { this.env = 0; }
  process(L, R, n) {
    if (this.dirty) { this.smooth(1); this.dirty = false; }
    const s = this.sp, i = this.i, sr = this.sr;
    const thr = s[i.thr], ratio = s[i.ratio], knee = s[i.knee], mix = s[i.mix];
    const makeup = s[i.makeup];
    const att = 1 - Math.exp(-1 / (s[i.att] * 0.001 * sr));
    const rel = 1 - Math.exp(-1 / (s[i.rel] * 0.001 * sr));
    const slope = 1 / ratio - 1;
    let env = this.env, maxGr = 0;
    for (let k = 0; k < n; k++) {
      const l = L[k], r = R[k];
      const lvl = Math.max(Math.abs(l), Math.abs(r));
      const db = 20 * Math.log10(lvl + 1e-9);
      const over = db - thr;
      let gr;
      if (2 * over < -knee) gr = 0;
      else if (knee > 0 && 2 * Math.abs(over) <= knee) { const t = over + knee / 2; gr = (slope * t * t) / (2 * knee); }
      else gr = slope * over;
      env += (gr - env) * (gr < env ? att : rel);
      const g = Math.exp((env + makeup) * 0.11512925464970229);
      L[k] = l + (l * g - l) * mix;
      R[k] = r + (r * g - r) * mix;
      if (env < maxGr) maxGr = env;
    }
    this.env = env; this.gr = maxGr;
  }
}

// ---------------- Distortion (ADAA waveshapers) ----------------
const logcosh = (x) => { const a = Math.abs(x); return a + Math.log1p(Math.exp(-2 * a)) - LN2; };
const TUBE_B = 0.35, TUBE_TB = Math.tanh(TUBE_B);
function shapeF(type, x) { // antiderivative
  switch (type) {
    case 0: return logcosh(x);
    case 1: { const a = Math.abs(x); return a <= 1 ? 0.5 * x * x : a - 0.5; }
    case 2: return -Math.cos(x);
    case 4: return Math.sqrt(1 + x * x); // algebraic sigmoid x/sqrt(1+x^2): cheap antiderivative
    default: return logcosh(x + TUBE_B) - x * TUBE_TB;
  }
}
function shapeFn(type, x) {
  switch (type) {
    case 0: return Math.tanh(x);
    case 1: return x < -1 ? -1 : x > 1 ? 1 : x;
    case 2: return Math.sin(x);
    case 4: return x / Math.sqrt(1 + x * x);
    default: return Math.tanh(x + TUBE_B) - TUBE_TB;
  }
}
export class ADAA {
  constructor() { this.x1 = 0; this.F1 = 0; this.type = 0; }
  reset() { this.x1 = 0; this.F1 = shapeF(this.type, 0); }
  run(x) {
    const d = x - this.x1;
    const F = shapeF(this.type, x);
    const y = Math.abs(d) > 1e-5 ? (F - this.F1) / d : shapeFn(this.type, 0.5 * (x + this.x1));
    this.x1 = x; this.F1 = F;
    return y;
  }
}

class Distortion extends Fx {
  constructor(sr) {
    super('distortion', sr);
    this.sl = new ADAA(); this.sr2 = new ADAA();
    this.lpL = 0; this.lpR = 0; this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
    this.pre = 1; this.post = 1;
  }
  reset() { this.sl.reset(); this.sr2.reset(); this.lpL = this.lpR = this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0; }
  process(L, R, n) {
    this.smooth(0.35);
    const s = this.sp, i = this.i;
    const type = s[i.type] | 0;
    if (this.sl.type !== type) { this.sl.type = type; this.sr2.type = type; this.sl.reset(); this.sr2.reset(); }
    const preT = dbg(s[i.drive]), postT = dbg(s[i.out]) / Math.max(1, Math.sqrt(preT) * 0.5);
    const mix = s[i.mix];
    const a = Math.exp((-TAU * s[i.tone]) / this.sr);
    let pre = this.pre, post = this.post;
    const dpre = (preT - pre) / n, dpost = (postT - post) / n;
    let lpL = this.lpL, lpR = this.lpR, dcxL = this.dcxL, dcyL = this.dcyL, dcxR = this.dcxR, dcyR = this.dcyR;
    for (let k = 0; k < n; k++) {
      const l = L[k], r = R[k];
      let yl = this.sl.run(l * pre), yr = this.sr2.run(r * pre);
      const ol = yl - dcxL + 0.995 * dcyL; dcxL = yl; dcyL = ol;
      const or = yr - dcxR + 0.995 * dcyR; dcxR = yr; dcyR = or;
      lpL = ol + (lpL - ol) * a; lpR = or + (lpR - or) * a;
      L[k] = l + (lpL * post - l) * mix;
      R[k] = r + (lpR * post - r) * mix;
      pre += dpre; post += dpost;
    }
    this.pre = preT; this.post = postT;
    this.lpL = lpL; this.lpR = lpR; this.dcxL = dcxL; this.dcyL = dcyL + 1e-20; this.dcxR = dcxR; this.dcyR = dcyR + 1e-20;
  }
}

// ---------------- Chorus ----------------
class Chorus extends Fx {
  constructor(sr) {
    super('chorus', sr);
    this.len = Math.ceil(sr * 0.06) + 4;
    this.bl = new Float32Array(this.len); this.br = new Float32Array(this.len);
    this.w = 0; this.ph = 0;
  }
  reset() { this.bl.fill(0); this.br.fill(0); }
  process(L, R, n) {
    this.smooth(0.35);
    const s = this.sp, i = this.i, sr = this.sr, len = this.len, bl = this.bl, br = this.br;
    const inc = s[i.rate] / sr, depth = s[i.depth] * 0.004 * sr, base = s[i.delay] * 0.001 * sr;
    const fb = s[i.fb], mix = s[i.mix], wofs = 0.25 * s[i.width];
    let w = this.w, ph = this.ph;
    for (let k = 0; k < n; k++) {
      const l = L[k], r = R[k];
      const m1 = Math.sin(TAU * ph), m2 = Math.sin(TAU * (ph + 0.5));
      const m3 = Math.sin(TAU * (ph + wofs)), m4 = Math.sin(TAU * (ph + wofs + 0.5));
      const tl = this.tap(bl, w, base + depth * (0.5 + 0.5 * m1), len) * 0.5 + this.tap(bl, w, base * 1.3 + depth * (0.5 + 0.5 * m2), len) * 0.5;
      const tr = this.tap(br, w, base + depth * (0.5 + 0.5 * m3), len) * 0.5 + this.tap(br, w, base * 1.3 + depth * (0.5 + 0.5 * m4), len) * 0.5;
      bl[w] = l + tl * fb; br[w] = r + tr * fb;
      if (++w >= len) w = 0;
      ph += inc; if (ph >= 1) ph -= 1;
      L[k] = l + (tl - l) * mix; R[k] = r + (tr - r) * mix;
    }
    this.w = w; this.ph = ph;
  }
  tap(buf, w, d, len) {
    let pos = w - d; if (pos < 0) pos += len;
    const i0 = pos | 0, f = pos - i0, i1 = i0 + 1 >= len ? 0 : i0 + 1;
    return buf[i0] + (buf[i1] - buf[i0]) * f;
  }
}

// ---------------- Delay ----------------
class Delay extends Fx {
  constructor(sr) {
    super('delay', sr);
    this.len = Math.ceil(sr * 4) + 8;
    this.bl = new Float32Array(this.len); this.br = new Float32Array(this.len);
    this.w = 0; this.dt = -1; this.lpL = 0; this.lpR = 0; this.hpL = 0; this.hpR = 0;
  }
  reset() { this.bl.fill(0); this.br.fill(0); this.lpL = this.lpR = this.hpL = this.hpR = 0; }
  process(L, R, n, ctx) {
    this.smooth(0.35);
    const s = this.sp, i = this.i, sr = this.sr, len = this.len, bl = this.bl, br = this.br;
    let target = s[i.sync] >= 0.5 ? (SYNC_DIVS[s[i.div] | 0].beats * 60 / ctx.tempo) * sr : s[i.time] * 0.001 * sr;
    target = Math.min(len - 4, Math.max(1, target));
    if (this.dt < 0) this.dt = target;
    const fb = s[i.fb], mix = s[i.mix], pp = s[i.pp] >= 0.5;
    const a = 1 - Math.exp((-TAU * s[i.damp]) / sr);
    const hpA = 1 - Math.exp((-TAU * 40) / sr);
    let w = this.w, dt = this.dt, lpL = this.lpL, lpR = this.lpR, hpL = this.hpL, hpR = this.hpR;
    for (let k = 0; k < n; k++) {
      dt += (target - dt) * 0.0006;
      let pos = w - dt; if (pos < 0) pos += len;
      const i0 = pos | 0, f = pos - i0, i1 = i0 + 1 >= len ? 0 : i0 + 1;
      const rl = bl[i0] + (bl[i1] - bl[i0]) * f;
      const rr = br[i0] + (br[i1] - br[i0]) * f;
      lpL += (rl - lpL) * a; lpR += (rr - lpR) * a;
      hpL += (lpL - hpL) * hpA; hpR += (lpR - hpR) * hpA;
      const fl = fastTanh((lpL - hpL) * fb), fr = fastTanh((lpR - hpR) * fb);
      const l = L[k], r = R[k];
      if (pp) { bl[w] = (l + r) * 0.5 + fr; br[w] = fl; }
      else { bl[w] = l + fl; br[w] = r + fr; }
      if (++w >= len) w = 0;
      L[k] = l + (rl - l) * mix; R[k] = r + (rr - r) * mix;
    }
    this.w = w; this.dt = dt; this.lpL = lpL + 1e-20; this.lpR = lpR + 1e-20; this.hpL = hpL; this.hpR = hpR;
  }
}

// ---------------- Reverb (8-line feedback delay network) ----------------
const RV_MS = [31.3, 37.9, 41.9, 47.3, 53.9, 59.7, 67.3, 73.1];
const RV_AP_MS = [4.77, 3.59, 12.73, 9.31];
const SGN_L = [1, -1, 1, -1, 1, -1, 1, -1];
const SGN_R = [1, 1, -1, -1, 1, 1, -1, -1];
const SGN_IN = [1, -1, -1, 1, 1, -1, -1, 1];
class Reverb extends Fx {
  constructor(sr) {
    super('reverb', sr);
    this.size = Math.ceil((73.1 * 1.7 + 4) * 0.001 * sr) + 8;
    this.lines = RV_MS.map(() => new Float32Array(this.size));
    this.lens = new Float64Array(8); this.lenT = new Float64Array(8);
    this.gains = new Float64Array(8); this.lp = new Float64Array(8); this.o = new Float64Array(8);
    this.w = 0;
    this.preLen = Math.ceil(sr * 0.21) + 4; this.pre = new Float32Array(this.preLen); this.pw = 0;
    this.ap = RV_AP_MS.map((ms) => new Float32Array(Math.ceil(ms * 0.001 * sr)));
    this.apw = new Int32Array(4);
    this.mph = 0;
    this.init = false;
  }
  reset() { for (const l of this.lines) l.fill(0); this.pre.fill(0); for (const a of this.ap) a.fill(0); this.lp.fill(0); }
  process(L, R, n) {
    this.smooth(0.35);
    const s = this.sp, i = this.i, sr = this.sr;
    const scale = 0.45 + 1.2 * s[i.size];
    const decay = s[i.decay];
    for (let k = 0; k < 8; k++) {
      this.lenT[k] = RV_MS[k] * scale * 0.001 * sr;
      if (!this.init) this.lens[k] = this.lenT[k];
      else this.lens[k] += (this.lenT[k] - this.lens[k]) * 0.08;
      this.gains[k] = Math.pow(10, (-3 * (this.lens[k] / sr)) / decay);
    }
    this.init = true;
    const damp = 1 - Math.exp((-TAU * s[i.damp]) / sr);
    const preD = Math.max(1, Math.min(this.preLen - 2, Math.round(s[i.pre] * 0.001 * sr)));
    const mix = s[i.mix], width = s[i.width];
    const lines = this.lines, size = this.size, lens = this.lens, gains = this.gains, lp = this.lp, o = this.o;
    const ap = this.ap, apw = this.apw;
    const modDepth = 0.0003 * sr, mInc = 0.6 / sr;
    let w = this.w, pw = this.pw, mph = this.mph;
    for (let k = 0; k < n; k++) {
      const l = L[k], r = R[k];
      // pre-delay
      this.pre[pw] = (l + r) * 0.5;
      let rp = pw - preD; if (rp < 0) rp += this.preLen;
      let x = this.pre[rp];
      if (++pw >= this.preLen) pw = 0;
      // input diffusion
      for (let a = 0; a < 4; a++) {
        const buf = ap[a], j = apw[a];
        const d = buf[j];
        const v = x + d * 0.62;
        buf[j] = v;
        x = d - v * 0.62;
        apw[a] = j + 1 >= buf.length ? 0 : j + 1;
      }
      // read lines
      const m = Math.sin(TAU * mph);
      let sum = 0, outL = 0, outR = 0;
      for (let q = 0; q < 8; q++) {
        let d = lens[q];
        if (q === 0) d += modDepth * m; else if (q === 3) d -= modDepth * m; else if (q === 5) d += modDepth * 0.7 * Math.cos(TAU * mph);
        let pos = w - d; if (pos < 0) pos += size;
        const i0 = pos | 0, f = pos - i0, i1 = i0 + 1 >= size ? 0 : i0 + 1;
        const buf = lines[q];
        const v = buf[i0] + (buf[i1] - buf[i0]) * f;
        lp[q] += (v - lp[q]) * damp;
        const y = lp[q] * gains[q];
        o[q] = y; sum += y;
        outL += v * SGN_L[q]; outR += v * SGN_R[q];
      }
      const hh = sum * 0.25; // Householder: y - 2/N * sum
      for (let q = 0; q < 8; q++) lines[q][w] = o[q] - hh + x * SGN_IN[q] * 0.35 + 1e-20;
      if (++w >= size) w = 0;
      mph += mInc; if (mph >= 1) mph -= 1;
      outL *= 0.3; outR *= 0.3;
      const mid = (outL + outR) * 0.5, side = (outL - outR) * 0.5 * width;
      L[k] = l + (mid + side - l) * mix;
      R[k] = r + (mid - side - r) * mix;
    }
    this.w = w; this.pw = pw; this.mph = mph;
  }
}

// ---------------- Auto Filter (stereo SVF) ----------------
class Filter extends Fx {
  constructor(sr) { super('filter', sr); this.s = new Float64Array(4); this.g = -1; }
  reset() { this.s.fill(0); }
  process(L, R, n) {
    this.smooth(0.3);
    const sp = this.sp, i = this.i, sr = this.sr;
    const mode = sp[i.mode] | 0;
    const gT = Math.tan((Math.PI * Math.min(sp[i.cut], sr * 0.45)) / sr);
    if (this.g < 0) this.g = gT;
    let g = this.g; const dg = (gT - g) / n;
    const k = 2 - 1.96 * sp[i.res];
    const drv = dbg(sp[i.drive]), useDrive = sp[i.drive] > 0.05, mix = sp[i.mix];
    const st = this.s;
    let a1L = st[0], a2L = st[1], a1R = st[2], a2R = st[3];
    for (let q = 0; q < n; q++) {
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      let xl = L[q], xr = R[q];
      const dl = xl, dr = xr;
      if (useDrive) { xl = fastTanh(xl * drv) / Math.sqrt(drv); xr = fastTanh(xr * drv) / Math.sqrt(drv); }
      let v3 = xl - a2L, v1 = a1 * a1L + a2 * v3, v2 = a2L + a2 * a1L + a3 * v3;
      a1L = 2 * v1 - a1L; a2L = 2 * v2 - a2L;
      let yl = mode === 0 ? v2 : mode === 1 ? xl - k * v1 - v2 : mode === 2 ? v1 * k : xl - k * v1;
      v3 = xr - a2R; v1 = a1 * a1R + a2 * v3; v2 = a2R + a2 * a1R + a3 * v3;
      a1R = 2 * v1 - a1R; a2R = 2 * v2 - a2R;
      let yr = mode === 0 ? v2 : mode === 1 ? xr - k * v1 - v2 : mode === 2 ? v1 * k : xr - k * v1;
      L[q] = dl + (yl - dl) * mix; R[q] = dr + (yr - dr) * mix;
      g += dg;
    }
    this.g = gT;
    st[0] = a1L + 1e-20; st[1] = a2L; st[2] = a1R + 1e-20; st[3] = a2R;
  }
}

// ---------------- Limiter (look-ahead peak limiter) ----------------
class Limiter extends Fx {
  constructor(sr) {
    super('limiter', sr);
    this.la = Math.max(16, Math.round(sr * 0.0015));
    this.bl = new Float32Array(this.la); this.br = new Float32Array(this.la);
    this.w = 0; this.g = 1; this.hold = 1; this.holdN = 0; this.gr = 0;
  }
  reset() { this.bl.fill(0); this.br.fill(0); this.g = 1; this.hold = 1; this.holdN = 0; }
  process(L, R, n) {
    this.smooth(0.35);
    const s = this.sp, i = this.i, sr = this.sr, la = this.la;
    const inG = dbg(s[i.gain]), ceil = dbg(s[i.ceil]);
    const att = 1 - Math.exp(-5 / la), rel = 1 - Math.exp(-1 / (s[i.rel] * 0.001 * sr));
    let w = this.w, g = this.g, hold = this.hold, holdN = this.holdN, minG = 1;
    for (let k = 0; k < n; k++) {
      const l = L[k] * inG, r = R[k] * inG;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      const want = pk > ceil ? ceil / pk : 1;
      if (want <= hold) { hold = want; holdN = la; } else if (--holdN <= 0) { hold = want; holdN = 0; }
      g += (hold - g) * (hold < g ? att : rel);
      const dl = this.bl[w], dr = this.br[w];
      this.bl[w] = l; this.br[w] = r;
      if (++w >= la) w = 0;
      let ol = dl * g, or = dr * g;
      if (ol > ceil) ol = ceil; else if (ol < -ceil) ol = -ceil;
      if (or > ceil) or = ceil; else if (or < -ceil) or = -ceil;
      L[k] = ol; R[k] = or;
      if (g < minG) minG = g;
    }
    this.w = w; this.g = g; this.hold = hold; this.holdN = holdN;
    this.gr = 20 * Math.log10(minG);
  }
}

// ---------------- Utility ----------------
class Utility extends Fx {
  constructor(sr) { super('utility', sr); this.gl = 1; this.gr = 1; }
  process(L, R, n) {
    this.smooth(0.35);
    const s = this.sp, i = this.i;
    const g = dbg(s[i.gain]), pan = s[i.pan], width = s[i.width], mono = s[i.mono] >= 0.5;
    const tl = g * Math.min(1, 1 - pan), tr = g * Math.min(1, 1 + pan);
    let gl = this.gl, gr = this.gr; const dl = (tl - gl) / n, dr = (tr - gr) / n;
    const wv = mono ? 0 : width;
    for (let k = 0; k < n; k++) {
      const m = (L[k] + R[k]) * 0.5, sd = (L[k] - R[k]) * 0.5 * wv;
      L[k] = (m + sd) * gl; R[k] = (m - sd) * gr;
      gl += dl; gr += dr;
    }
    this.gl = tl; this.gr = tr;
  }
}

const CLASSES = { eq: EQ, compressor: Compressor, distortion: Distortion, chorus: Chorus, delay: Delay, reverb: Reverb, filter: Filter, limiter: Limiter, utility: Utility };
export function createEffect(type, sr) {
  const C = CLASSES[type];
  if (!C) throw new Error('Unknown effect ' + type);
  return new C(sr);
}

// Insert slot with click-free bypass crossfade.
export class FxSlot {
  constructor(id, type, sr, blockSize = 128) {
    this.id = id; this.type = type;
    this.fx = createEffect(type, sr);
    this.on = true; this.x = 1;
    this.auto = new Uint8Array(this.fx.p.length);
    this.manual = new Float64Array(this.fx.p.length);
    this.dl = new Float32Array(blockSize); this.dr = new Float32Array(blockSize);
  }
  process(L, R, n, ctx) {
    const target = this.on ? 1 : 0;
    if (target === 0 && this.x === 0) return;
    if (target === 1 && this.x === 1) { this.fx.process(L, R, n, ctx); return; }
    const dl = this.dl, dr = this.dr;
    for (let k = 0; k < n; k++) { dl[k] = L[k]; dr[k] = R[k]; }
    this.fx.process(L, R, n, ctx);
    let x = this.x;
    const x1 = Math.min(1, Math.max(0, x + (target > x ? 0.25 : -0.25)));
    const d = (x1 - x) / n;
    for (let k = 0; k < n; k++) { L[k] = dl[k] + (L[k] - dl[k]) * x; R[k] = dr[k] + (R[k] - dr[k]) * x; x += d; }
    this.x = x1;
    if (x1 === 0) this.fx.reset();
  }
}
