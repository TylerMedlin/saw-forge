// Session Pianist: real-time physical model of an acoustic piano (no samples).
//
// Per note, a felt hammer (nonlinear mass-spring, F = K·c^p, solved
// implicitly with 4× oversampling while in contact) strikes 1–3 unison
// strings at its strike point. Each string is a digital waveguide loop with
// fractional tuning, a dispersion allpass cascade fitted to the stiff-string
// partial series (inharmonicity) and a frequency-dependent loss filter. The
// strings meet at a shared, passive bridge junction: it couples them (the
// in-phase mode drains into the bridge fast, the out-of-phase mode rings on,
// giving the piano's two-stage decay) and its velocity drives a modal
// soundboard. Dampers (with half-pedal), the sustain pedal, keybed thump and
// a small room are modelled on top. Re-striking a ringing note hits the same
// moving strings, so no two attacks are identical.
//
// render()/postProcess() are allocation-free; per-key coefficients are fitted
// lazily on note-on and cached until a parameter that shapes them changes.

import { PIANO_PARAMS, PIANO_COUNT, PIANO_INDEX as I, PIANO_MODELS } from '../../shared/piano-params.js';

const MAXV = 32, MAXL = 3, MAXM = 8, OS = 4, LO = 21, HI = 108, NK = HI - LO + 1;
const C0 = 1e-3; // felt compression unit (1 mm): hammer stiffness K is the force at 1 mm
const TAU = 2 * Math.PI;
const OUT = 16; // bridge velocity → output level
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function curve(n, pts) { // piecewise-linear over MIDI note
  if (n <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const p1 = pts[i];
    if (n <= p1[0]) { const p0 = pts[i - 1]; return p0[1] + (p1[1] - p0[1]) * (n - p0[0]) / (p1[0] - p0[0]); }
  }
  return pts[pts.length - 1][1];
}
function hash(n, s) { let x = (n * 374761393 + s * 668265263) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16; return ((x >>> 0) / 4294967296) * 2 - 1; }
// phase delay (samples) of the allpass (a + z⁻¹)/(1 + a·z⁻¹) at ω
function apDelay(a, w) { const s = Math.sin(w), c = Math.cos(w); return (Math.atan2(s, a + c) - Math.atan2(a * s, 1 + a * c)) / w; }
// phase delay of the one-pole loss filter b0/(1 − c·z⁻¹)
function lossDelay(c, w) { return Math.atan2(c * Math.sin(w), 1 - c * Math.cos(w)) / w; }

// Concert-grand scaling across the keyboard (MIDI note → value); characters scale these.
const LOG_B = [[21, -3.6], [40, -3.95], [52, -3.6], [64, -3.3], [76, -2.9], [88, -2.4], [108, -1.6]]; // inharmonicity
const MASS = [[21, 11e-3], [60, 8e-3], [108, 4.5e-3]]; // hammer mass, kg
const LOG_K = [[21, Math.log(40)], [60, Math.log(150)], [108, Math.log(1500)]]; // felt force at 1 mm, N
const PEXP = [[21, 2.2], [60, 2.6], [108, 3.1]]; // felt stiffness exponent
const LOG_Z = [[21, Math.log(6)], [45, Math.log(3.5)], [60, Math.log(1.6)], [84, Math.log(1.2)], [108, Math.log(0.9)]]; // string impedance, kg/s
const BETA = [[21, 0.125], [80, 0.115], [108, 0.07]]; // strike point (fraction of length)
const T60I = [[21, 50], [48, 35], [60, 26], [72, 17], [84, 9], [96, 5], [108, 2.5]]; // aftersound (internal losses), s
const T60P = [[21, 15], [48, 10], [60, 8], [72, 6], [84, 5], [96, 3.5], [108, 1.5]]; // prompt sound (bridge coupling), s
const T60H = [[21, 0.9], [48, 1], [60, 1], [72, 1], [84, 1], [96, 0.6], [108, 0.3]]; // high partials, s
const T60D = [[21, 0.6], [48, 0.35], [72, 0.2], [88, 0.15]]; // damper on the string, s
const DAMPER_TOP = 88; // as on a grand, the top strings have no dampers
// soundboard modes (Hz, Q) and their stereo signs
const SB_F = [52, 78, 110, 145, 190, 240, 300, 375, 470, 590, 740, 930, 1170, 1480, 1900, 2450];
const SB_Q = [5, 7, 9, 10, 11, 12, 13, 14, 15, 15, 16, 17, 18, 18, 20, 20];
const SB_SL = [1, -1, 1, 1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, -1, 1];
const SB_SR = [1, 1, -1, 1, 1, -1, -1, 1, -1, 1, 1, -1, 1, -1, -1, 1];
const NSB = SB_F.length;
const ROOM_D = [1201, 1613, 1999, 2441];
const REG_KEYS = [21, 27, 33, 39, 45, 51, 57, 63, 69, 75, 81, 87, 93, 99, 105, 108];
// voicing trim per piano (dB at REG_KEYS), measured so each piano plays evenly from bass to treble at the same overall level
const REG_DB = [
  [-5.4, -5.4, -1.8, -1.8, -1.3, 0.2, 0, 0.8, 1.1, 1.8, 4.2, 6.2, 9.2, 10, 12.3, 15.8], // Concert Grand
  [-8.1, -8.5, -5, -4.9, -4.9, -2.9, -3.2, -2.9, -1, -0.8, 1.2, 3.3, 6.5, 8.6, 9.5, 12.8], // Warm Upright
  [-6.3, -6.3, -2.8, -2.7, -2.1, -0.8, -1.1, -0.3, 0, 0.8, 2.5, 4.3, 8.7, 8.9, 10.5, 13.4], // Studio Grand
  [-8.5, -9, -4.3, -4.6, -3.6, -1.4, -1.3, -0.5, 2.4, 5.2, 9.2, 9.2, 10.6, 14.2, 19.4, 22.6], // Felt Piano
  [-7.8, -7.8, -4, -4, -3.5, -2.2, -2.4, -2, -1.2, 0.3, 2.3, 4.5, 7.1, 10.8, 11.8, 15.2], // Vintage Character
];
const HYST = [[21, 6e-5], [60, 3e-5], [108, 1.2e-5]]; // felt hysteresis time (s): the felt pushes back harder while compressing than while recovering
const SYM_LO = 36, SYM_HI = 71; // the strings the sustain pedal frees to ring in sympathy (plus the undamped treble)

class Voice {
  constructor(size) {
    this.size = size; this.mask = size - 1;
    this.buf = new Float64Array(MAXL * size);
    this.N = new Int32Array(MAXL); this.eta = new Float64Array(MAXL); this.thz = new Float64Array(MAXL);
    this.ds = new Float64Array(MAXL * MAXM); this.lz = new Float64Array(MAXL);
    this.b0 = new Float64Array(MAXL); this.kap = new Float64Array(MAXL); this.ex = new Float64Array(MAXL); this.y = new Float64Array(MAXL);
    this.active = false; this.key = -1; this.keyDown = false; this.wp = 0; this.nl = 0; this.ns = 1; this.M = 0; this.ad = 0; this.c = 0;
    this.gd = 1; this.damp = 0; this.hasDamper = true; this.pan = 0; this.envB = 0; this.lvl = 0; this.age = 0;
    this.hOn = false; this.yh = 0; this.vh = 0; this.ys = 0; this.hF = 0; this.hm = 0.008; this.hK = 100; this.hp = 2.5; this.inv2Z = 0.1;
    this.hIdle = 0; this.hT = 0; this.t1 = 1; this.t2 = 2; this.quiet = 0; this.g = 1; this.gc = 1;
    this.fading = false; this.fade = 1; this.pendKey = -1; this.pendVel = 0; this.pendOff = false;
  }
}

export class Piano {
  constructor(sr) {
    this.sr = sr;
    this.p = new Float64Array(PIANO_COUNT); this.manual = new Float64Array(PIANO_COUNT); this.auto = new Uint8Array(PIANO_COUNT);
    PIANO_PARAMS.forEach((d, i) => { this.p[i] = d.def; this.manual[i] = d.def; });
    this.model = PIANO_MODELS[0]; this.mi = 0;
    let size = 1; while (size < sr / 26 + 64) size <<= 1;
    this.voices = Array.from({ length: MAXV }, () => new Voice(size));
    // per-key fitted coefficients
    this.ver = 0; this.kVer = new Int32Array(NK).fill(-1); this.kG = new Float64Array(NK);
    this.kN = new Int32Array(NK * MAXL); this.kEta = new Float64Array(NK * MAXL); this.kB0 = new Float64Array(NK * MAXL); this.kKap = new Float64Array(NK * MAXL);
    this.kAd = new Float64Array(NK); this.kM = new Int32Array(NK); this.kC = new Float64Array(NK); this.kNs = new Int32Array(NK);
    this.kGd = new Float64Array(NK); this.kT1 = new Int32Array(NK); this.kT2 = new Int32Array(NK); this.kI2Z = new Float64Array(NK);
    this.kMass = new Float64Array(NK); this.kK = new Float64Array(NK); this.kP = new Float64Array(NK);
    this.hdt = 1 / (sr * OS); this.hIdleMax = Math.round(0.002 * sr); this.hMaxT = Math.round(0.04 * sr);
    this.dampK = 1 - Math.exp(-1 / (0.008 * sr)); this.fadeStep = 1 / (0.004 * sr); this.gRamp = 1 - Math.exp(-1 / (0.0015 * sr));
    this.livePedal = 0; this.rngS = 0x2f6b9a1d; this.thump = 0;
    this.bL = new Float64Array(256); this.bR = new Float64Array(256); this.bM = new Float64Array(256); this.bT = new Float64Array(256);
    // soundboard
    this.sbB = new Float64Array(NSB); this.sbA1 = new Float64Array(NSB); this.sbA2 = new Float64Array(NSB);
    this.sbGL = new Float64Array(NSB); this.sbGR = new Float64Array(NSB); this.sbY1 = new Float64Array(NSB); this.sbY2 = new Float64Array(NSB);
    this.sbX1 = 0; this.sbX2 = 0;
    // keybed thump: two decaying resonances (wood knock + key frame)
    this.th = new Float64Array(8);
    const res = (f, t, o) => { const r = Math.exp(-1 / (t * sr)), w = TAU * f / sr; this.th[o] = Math.sin(w); this.th[o + 1] = 2 * r * Math.cos(w); this.th[o + 2] = -r * r; };
    res(95, 0.03, 0); res(430, 0.012, 3);
    this.thY = new Float64Array(4);
    // output filters, room
    this.lpL = 0; this.lpR = 0; this.lpK = 1 - Math.exp(-TAU * 250 / sr);
    this.hpA = Math.exp(-TAU * 25 / sr); this.hxL = 0; this.hxR = 0; this.hyL = 0; this.hyR = 0;
    let rs = 1; while (rs < ROOM_D[3] * sr / 48000 + 2) rs <<= 1;
    this.rSize = rs; this.rBuf = new Float64Array(4 * rs); this.rp = 0;
    this.rD = new Int32Array(4); this.rG = new Float64Array(4); this.rZ = new Float64Array(4);
    for (let i = 0; i < 4; i++) this.rD[i] = Math.round(ROOM_D[i] * sr / 48000);
    // sympathetic strings: a pedal bank (C2–B4, damped unless the pedal is down) and the undamped top strings
    const notes = [];
    for (let k = SYM_LO; k <= SYM_HI; k++) notes.push(k);
    this.NP = notes.length;
    for (let k = DAMPER_TOP + 1; k <= HI; k++) notes.push(k);
    const NS = (this.NS = notes.length);
    this.sNote = Int32Array.from(notes); this.sOff = new Int32Array(NS); this.sMask = new Int32Array(NS);
    let tot = 0;
    for (let i = 0; i < NS; i++) { let sz = 1; while (sz < (sr / (440 * Math.pow(2, (notes[i] - 69) / 12))) * 1.06 + 8) sz <<= 1; this.sOff[i] = tot; this.sMask[i] = sz - 1; tot += sz; }
    this.sBuf = new Float64Array(tot);
    this.sN = new Int32Array(NS); this.sEta = new Float64Array(NS); this.sThz = new Float64Array(NS); this.sB0 = new Float64Array(NS); this.sLz = new Float64Array(NS);
    this.sGdm = new Float64Array(NS); this.sGL = new Float64Array(NS); this.sGR = new Float64Array(NS); this.sGate = new Uint8Array(NS);
    this.sVer = -1; this.sW = 0; this.lift = 0; this.liftS = 0; this.symIdle = 0; this.pedNoise = false; this.kIn = 0; this.kOut = 0;
    this.dirty = true;
    this.tele = new Float64Array(4);
  }

  // ------------------------------------------------------------ parameters (same contract as SawForge)
  applyParam(i, v) {
    this.p[i] = v;
    if (i === I.model) { this.mi = clamp(Math.round(v), 0, PIANO_MODELS.length - 1); this.model = PIANO_MODELS[this.mi]; this.ver++; }
    else if (i === I.tuning || i === I.bright || i === I.sustain) this.ver++;
    this.dirty = true;
  }
  setParam(i, v) { this.manual[i] = v; if (!this.auto[i]) this.applyParam(i, v); }
  setAuto(i, v) { this.auto[i] = 1; if (this.p[i] !== v) this.applyParam(i, v); }
  setManualAll(arr) { for (let i = 0; i < PIANO_COUNT && i < arr.length; i++) { this.manual[i] = arr[i]; if (!this.auto[i] && this.p[i] !== arr[i]) this.applyParam(i, arr[i]); } }
  setAutomated(flags) {
    for (let i = 0; i < PIANO_COUNT; i++) {
      const was = this.auto[i];
      this.auto[i] = flags ? flags[i] : 0;
      if (was && !this.auto[i]) this.applyParam(i, this.manual[i]);
    }
  }
  setTable() {}
  pitchBend() {}
  modWheel() {}
  beginBlock() {}
  setPedal(v) { this.livePedal = clamp(v, 0, 1); }
  rand() { let x = this.rngS; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngS = x; return (x >>> 0) / 4294967296; }

  // live coefficients: soundboard modes, room, output gain
  update() {
    this.dirty = false;
    const m = this.model, p = this.p, sr = this.sr;
    const res = p[I.sbres], warm = p[I.warmth], w = p[I.width];
    for (let i = 0; i < NSB; i++) {
      const f = SB_F[i] * m.sbScale, Q = SB_Q[i] * m.sbQ * (0.6 + 0.8 * res);
      if (f > 0.45 * sr) { this.sbB[i] = 0; this.sbGL[i] = 0; this.sbGR[i] = 0; continue; }
      const r = Math.exp(-Math.PI * f / (Q * sr));
      this.sbA1[i] = 2 * r * Math.cos(TAU * f / sr); this.sbA2[i] = -r * r; this.sbB[i] = (1 - r * r) / 2;
      const g = (1.2 * res * m.sbGain / Math.sqrt(1 + 0.5 * i)) * (i < 4 ? m.low * (0.4 + 1.6 * warm) : 1);
      this.sbGL[i] = g * (1 - w + w * SB_SL[i]); this.sbGR[i] = g * (1 - w + w * SB_SR[i]);
    }
    this.warmG = (warm - 0.5) * 1.2;
    const rt = 0.5 + 0.9 * p[I.room];
    for (let i = 0; i < 4; i++) this.rG[i] = Math.pow(10, -3 * this.rD[i] / (sr * rt));
    this.wet = p[I.room] * 0.32;
    this.kIn = 0.012 * p[I.sres]; this.kOut = 0.32;
    if (this.sVer !== this.ver) this.tuneBank();
    this.outG = OUT * Math.pow(2, (p[I.sustain] - 0.5) * 2.0); // a shorter sustain drains the strings faster (louder): keep the level steady
    this.lev = Math.pow(10, p[I.level] / 20);
  }

  // ------------------------------------------------------------ per-key physics
  // stretched tuning (+ wandering pitch on a vintage piano)
  keyF(n) {
    const m = this.model, tune = this.p[I.tuning], st = (0.4 + 0.8 * tune) * m.stretch;
    const cents = st * (n < 60 ? -Math.pow((60 - n) / 39, 2.2) * 20 : Math.pow((n - 60) / 48, 2.2) * 30) + m.irr * hash(n, 1) * (2 + 4 * tune);
    return 440 * Math.pow(2, (n - 69) / 12 + cents / 1200);
  }
  // sympathetic strings: plain waveguides (no stiffness), tuned like the keys they belong to
  tuneBank() {
    const sr = this.sr, m = this.model, sus = Math.pow(2, (this.p[I.sustain] - 0.5) * 2.4), c = 0.3;
    for (let i = 0; i < this.NS; i++) {
      const n = this.sNote[i], f = this.keyF(n), w = TAU * f / sr;
      const G0 = Math.pow(10, -3 / (f * curve(n, T60P) * m.prompt * sus * 1.2));
      this.sB0[i] = Math.min(G0 * Math.sqrt(1 - 2 * c * Math.cos(w) + c * c), 0.9999 * (1 - c));
      const R = sr / f - lossDelay(c, w), N = Math.floor(R - 0.6), d = R - N;
      let lo = -0.95, hi = 0.95;
      for (let it = 0; it < 32; it++) { const mid = 0.5 * (lo + hi); if (apDelay(mid, w) > d) lo = mid; else hi = mid; }
      this.sN[i] = N; this.sEta[i] = 0.5 * (lo + hi);
      this.sGdm[i] = n > DAMPER_TOP ? 0 : 1 - Math.pow(10, -3 / (f * 0.08));
      const pan = clamp((n - 64.5) / 44, -1, 1) * 0.7;
      this.sGL[i] = Math.cos((pan + 1) * Math.PI / 4); this.sGR[i] = Math.sin((pan + 1) * Math.PI / 4);
    }
    this.sVer = this.ver;
  }
  fitKey(k) {
    const n = k + LO, sr = this.sr, m = this.model, p = this.p, tune = p[I.tuning], irr = m.irr;
    const h1 = hash(n, 1), h2 = hash(n, 2), h3 = hash(n, 3);
    const f1 = this.keyF(n), w1 = TAU * f1 / sr;
    void h1;
    const B = Math.pow(10, curve(n, LOG_B)) * m.inh * (1 + 0.3 * irr * h2);
    const ns = n <= 31 ? 1 : n <= 48 ? 2 : 3, nl = ns === 1 ? 2 : ns;
    // losses: internal (aftersound) and high-partial decay → one-pole loss filter
    const sus = Math.pow(2, (p[I.sustain] - 0.5) * 2.4), bright = Math.pow(2, (p[I.bright] - 0.5) * 2.6);
    const t60i = curve(n, T60I) * m.t60 * sus, t60p = curve(n, T60P) * m.prompt * sus;
    const t60h = Math.min(curve(n, T60H) * m.hf * bright, t60i * 0.98);
    const fh = Math.min(Math.max(3 * f1, 2000), 0.42 * sr), wh = TAU * fh / sr;
    const G0 = Math.pow(10, -3 / (f1 * t60i)), r = Math.pow(10, -3 / (f1 * t60h)) / G0;
    let c = 0;
    // c gives |H(ωh)|/|H(ω1)| = r, but no steeper than keeps the DC gain below 1 while |H(ω1)| = G0
    const solveC = (ratio, w) => { if (ratio >= 1) return 0; const r2 = ratio * ratio, A = 1 - r2 * Math.cos(w), Bq = 1 - r2; return clamp((A - Math.sqrt(Math.max(0, A * A - Bq * Bq))) / Bq, 0, 0.9); };
    if (r < 1) c = Math.min(solveC(r, wh), solveC(G0 / 0.99995, w1));
    const b0 = Math.min(G0 * Math.sqrt(1 - 2 * c * Math.cos(w1) + c * c), 0.99995 * (1 - c)); // DC gain stays below 1
    const tl1 = lossDelay(c, w1), tau1 = sr / f1, CMIN = 10;
    // dispersion: fit one allpass coefficient (M stages) to the partials f_k = k·f1·√((1+Bk²)/(1+B))
    let M = n < 36 ? 8 : n < 52 ? 6 : n < 72 ? 4 : 2;
    while (M > 0 && tau1 - M - tl1 < CMIN) M--;
    let ad = 0;
    if (M > 0) {
      let K = 1; while (K < 14 && (K + 1) * f1 * Math.sqrt((1 + B * (K + 1) * (K + 1)) / (1 + B)) < 0.42 * sr) K++;
      if (K >= 2) {
        const err = (a) => {
          const ap1 = apDelay(a, w1);
          if (tau1 - M * ap1 - tl1 < CMIN) return 1e30;
          let e = 0;
          for (let q = 2; q <= K; q++) {
            const fk = q * f1 * Math.sqrt((1 + B * q * q) / (1 + B)), wk = TAU * fk / sr;
            const d = M * (apDelay(a, wk) - ap1) + lossDelay(c, wk) - tl1 - (q * sr / fk - tau1);
            e += d * d;
          }
          return e;
        };
        let lo = -0.95, hi = 0;
        const gr = 0.6180339887;
        let x1 = hi - gr * (hi - lo), x2 = lo + gr * (hi - lo), e1 = err(x1), e2 = err(x2);
        for (let it = 0; it < 32; it++) {
          if (e1 < e2) { hi = x2; x2 = x1; e2 = e1; x1 = hi - gr * (hi - lo); e1 = err(x1); }
          else { lo = x1; x1 = x2; e1 = e2; x2 = lo + gr * (hi - lo); e2 = err(x2); }
        }
        ad = 0.5 * (lo + hi);
        if (err(ad) >= 1e30) ad = 0;
      }
    }
    // unison strings (or two polarizations of a single bass string), each tuned exactly
    const uni = m.uni * (0.4 + 1.2 * tune) * (1 + 0.5 * irr * h2);
    const kt = 1 - Math.pow(10, -3 / (f1 * t60p)); // in-phase energy drained into the bridge per period
    let nMin = 1 << 30;
    for (let i = 0; i < nl; i++) {
      const det = ns === 1 ? (i === 0 ? 0 : 0.3 + 0.2 * h3) : ns === 2 ? (i === 0 ? -0.5 : 0.5) * uni : (i === 0 ? -0.5 : i === 1 ? 0.06 * h3 : 0.45) * uni;
      const fi = f1 * Math.pow(2, det / 1200), wi = TAU * fi / sr;
      const R = sr / fi - M * apDelay(ad, wi) - lossDelay(c, wi);
      const N = Math.floor(R - 0.6), d = R - N;
      let lo = -0.95, hi = 0.95;
      for (let it = 0; it < 32; it++) { const mid = 0.5 * (lo + hi); if (apDelay(mid, wi) > d) lo = mid; else hi = mid; }
      const j = k * MAXL + i;
      this.kN[j] = N; this.kEta[j] = 0.5 * (lo + hi);
      this.kB0[j] = b0 * (1 + 0.0004 * irr * hash(n, 10 + i));
      this.kKap[j] = ns === 1 && i === 1 ? kt * 0.15 : kt / ns;
      if (N < nMin) nMin = N;
    }
    if (this.kB0[k * MAXL] * 1 >= 0.99995 * (1 - c)) for (let i = 0; i < nl; i++) this.kB0[k * MAXL + i] = Math.min(this.kB0[k * MAXL + i], 0.99995 * (1 - c));
    // hammer and strike point
    const beta = curve(n, BETA) * m.beta;
    let t1 = Math.max(1, Math.round((1 - beta) * nMin / 2)), t2 = Math.round((1 + beta) * nMin / 2);
    if (t2 <= t1) t2 = t1 + 1;
    if (t2 > nMin - 1) t2 = nMin - 1;
    this.kT1[k] = t1; this.kT2[k] = t2;
    const tr = clamp((n - 80) / 16, 0, 1); // top-octave hammers are tiny and very hard, so they leave the short strings quickly
    this.kMass[k] = curve(n, MASS) * m.mass * (1 - 0.65 * tr);
    this.kK[k] = Math.exp(curve(n, LOG_K)) * m.k0 * (1 + 0.25 * irr * h3) * (1 + 9 * tr);
    const reg = REG_DB[this.mi] || REG_DB[0];
    this.kG[k] = Math.pow(10, curve(n, REG_KEYS.map((x, i) => [x, reg[i]])) / 20); // voicing: even loudness across the registers
    this.kP[k] = curve(n, PEXP) + m.p;
    this.kI2Z[k] = 1 / (2 * Math.exp(curve(n, LOG_Z)) * ns);
    this.kAd[k] = ad; this.kM[k] = M; this.kC[k] = c; this.kNs[k] = ns;
    this.kGd[k] = n > DAMPER_TOP ? 1 : Math.pow(10, -3 / (f1 * curve(n, T60D) / m.damp));
    this.kVer[k] = this.ver;
  }

  // ------------------------------------------------------------ notes
  allNotesOff(hard) {
    for (const v of this.voices) {
      if (hard) { v.active = false; v.fading = false; } else { v.keyDown = false; v.pendOff = true; }
    }
    if (hard) { // silence everything: strings, resonance, body and room
      this.livePedal = 0; this.sBuf.fill(0); this.sThz.fill(0); this.sLz.fill(0); this.rBuf.fill(0); this.rZ.fill(0);
      this.sbY1.fill(0); this.sbY2.fill(0); this.thY.fill(0); this.sbX1 = this.sbX2 = 0; this.thump = 0;
    }
  }
  noteOff(note) {
    let n = note; while (n < LO) n += 12; while (n > HI) n -= 12;
    for (const v of this.voices) {
      if (v.active && v.key === n && v.keyDown) { v.keyDown = false; if (v.hasDamper && this.lift < 0.5) this.thump += 0.003 * this.p[I.mech] * this.model.mech; } // the damper lands
      if (v.fading && v.pendKey === n) v.pendOff = true;
    }
  }
  noteOn(note, vel) {
    let n = note; while (n < LO) n += 12; while (n > HI) n -= 12;
    vel = clamp(vel, 0.01, 1);
    for (const v of this.voices) if (v.active && !v.fading && v.key === n) { this.strike(v, vel); return; } // same strings, still moving
    let best = null, score = Infinity;
    for (const v of this.voices) {
      if (!v.active) { this.begin(v, n, vel); return; }
      if (v.fading) { if (v.pendKey === n) return; continue; }
      const sc = (v.keyDown ? 1e3 : 0) + v.lvl;
      if (sc < score) { score = sc; best = v; }
    }
    if (best) { best.fading = true; best.fade = 1; best.pendKey = n; best.pendVel = vel; best.pendOff = false; }
  }
  begin(v, n, vel) {
    const k = n - LO;
    if (this.kVer[k] !== this.ver) this.fitKey(k);
    v.buf.fill(0); v.thz.fill(0); v.ds.fill(0); v.lz.fill(0);
    const ns = this.kNs[k], nl = ns === 1 ? 2 : ns;
    for (let i = 0; i < MAXL; i++) {
      const j = k * MAXL + i;
      v.N[i] = this.kN[j]; v.eta[i] = this.kEta[j]; v.b0[i] = this.kB0[j]; v.kap[i] = i < nl ? this.kKap[j] : 0;
    }
    v.ns = ns; v.nl = nl; v.M = this.kM[k]; v.ad = this.kAd[k]; v.c = this.kC[k]; v.gd = this.kGd[k];
    v.t1 = this.kT1[k]; v.t2 = this.kT2[k]; v.hm = this.kMass[k]; v.inv2Z = this.kI2Z[k];
    v.hasDamper = n <= DAMPER_TOP; v.pan = clamp((n - 64.5) / 44, -1, 1); v.g = this.kG[k]; v.gc = Math.min(1, v.g);
    v.key = n; v.wp = 0; v.damp = 0; v.age = 0; v.lvl = 1; v.envB = 0; v.quiet = 0;
    v.active = true; v.fading = false; v.fade = 1;
    this.strike(v, vel);
  }
  strike(v, vel) {
    const k = v.key - LO, p = this.p, dyn = p[I.dyn], hard = p[I.hard];
    const lo = 6 * Math.pow(10, -(0.6 + 1.2 * dyn)); // softest hammer speed, m/s (loudest 6 m/s): 12–36 dB of range
    const v0 = lo * Math.pow(6 / lo, vel) * (1 + 0.03 * (this.rand() - 0.5));
    v.hK = this.kK[k] * Math.pow(2, (hard - 0.5) * 3); v.hp = this.kP[k] + (hard - 0.5) * 0.4;
    v.yh = 0; v.vh = v0; v.ys = 0; v.hF = 0; v.hOn = true; v.hIdle = 0; v.hT = 0;
    v.hCp = 0; v.hEps = (curve(v.key, HYST) * (this.model.hyst ?? 1)) / this.hdt;
    const irr = this.model.irr;
    for (let i = 0; i < v.nl; i++) v.ex[i] = v.ns === 1 && i === 1 ? 0.08 + 0.06 * this.rand() : 1 + 0.08 * (1 + irr) * (this.rand() - 0.5);
    v.keyDown = true; v.lvl = 1;
    const q = v0 / 6;
    this.thump += 0.024 * p[I.mech] * this.model.mech * q * Math.sqrt(q);
  }

  // implicit hammer–string contact for one output sample; returns the velocity wave sent into each string
  hammer(v, vin) {
    const dt = this.hdt, m = v.hm, i2z = v.inv2Z, pe = v.hp, ep = v.hEps;
    const K = v.hK * (1 + ep), Kh = v.hK * ep; // F = K0·(c^p + α·d(c^p)/dt): Stulov felt with hysteresis
    const bm = (dt * dt / m + dt * i2z) / C0;
    let Fs = 0, F = v.hF;
    for (let s = 0; s < OS; s++) {
      const a = (v.yh + v.vh * dt - v.ys - vin * dt) / C0;
      const H = Kh * v.hCp; // memory of the previous compression
      if (a <= 0 || K * Math.pow(a, pe) - H <= 0) { F = 0; v.hCp = a > 0 ? Math.pow(a, pe) : 0; }
      else {
        // F = K·(a − bm·F)^p − H: g(F) is concave and increasing, so Newton from the left converges monotonically
        if (F >= a / bm || F - K * Math.pow(a - bm * F, pe) + H > 0) F = 0;
        for (let it = 0; it < 12; it++) {
          const cc = a - bm * F, pw = Math.pow(cc, pe - 1);
          let Fn = F - (F - K * pw * cc + H) / (1 + K * pe * pw * bm);
          if (a - bm * Fn <= 0) Fn = 0.999999 * a / bm;
          const done = Fn - F < 1e-7 * (1 + F);
          F = Fn;
          if (done) break;
        }
        v.hCp = Math.pow(a - bm * F, pe);
      }
      v.vh -= F / m * dt; v.yh += v.vh * dt; v.ys += (vin + F * i2z) * dt;
      Fs += F;
    }
    v.hF = F;
    if (F === 0) { if (++v.hIdle > this.hIdleMax && v.yh < v.ys) v.hOn = false; } else v.hIdle = 0;
    if (++v.hT > this.hMaxT) v.hOn = false;
    return Fs / OS * i2z;
  }

  render(L, R, from, to) {
    if (to <= from) return;
    if (this.dirty) this.update();
    if (this.thump) { this.bT[from] += this.thump; this.thump = 0; }
    const ped = this.p[I.pedal] > this.livePedal ? this.p[I.pedal] : this.livePedal;
    const x = clamp((ped - 0.2) / 0.6, 0, 1), lift = x * x * (3 - 2 * x); // half-pedal: dampers lift gradually
    if (lift > 0.5 && this.lift <= 0.5) this.pedNoise = true; // the dampers leave the strings…
    else if (lift < 0.5 && this.lift >= 0.5) this.thump += 0.006 * this.p[I.mech] * this.model.mech; // …and land again
    this.lift = lift;
    const pw = 0.3 + 0.7 * this.p[I.width];
    for (let i = 0; i < MAXV; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      if (v.fading) {
        const left = Math.ceil(v.fade / this.fadeStep);
        if (left < to - from) {
          this.renderVoice(v, from, from + left, lift, pw);
          const off = v.pendOff;
          this.begin(v, v.pendKey, v.pendVel);
          if (off) v.keyDown = false;
          this.renderVoice(v, from + left, to, lift, pw);
          continue;
        }
      }
      this.renderVoice(v, from, to, lift, pw);
    }
  }

  renderVoice(v, from, to, lift, pw) {
    if (to <= from) return;
    const buf = v.buf, mask = v.mask, size = v.size, nl = v.nl, ns = v.ns, M = v.M, ad = v.ad, c = v.c;
    const N = v.N, eta = v.eta, thz = v.thz, ds = v.ds, lz = v.lz, b0 = v.b0, kap = v.kap, ex = v.ex, y = v.y;
    const dT = v.keyDown || !v.hasDamper ? 0 : 1 - lift, dk = this.dampK, gdm = 1 - v.gd;
    const pan = v.pan * pw, pl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, pr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    const bL = this.bL, bR = this.bR, bM = this.bM, g = this.outG, gr = this.gRamp, fstep = v.fading ? this.fadeStep : 0;
    let wp = v.wp, damp = v.damp, env = v.envB, fade = v.fade;
    for (let s = from; s < to; s++) {
      damp += (dT - damp) * dk;
      const gl = 1 - damp * gdm;
      if (v.hOn) {
        let vin = 0;
        for (let i = 0; i < ns; i++) { const off = i * size; vin += buf[off + ((wp - v.t2) & mask)] - buf[off + ((wp - v.t1) & mask)]; }
        const u = this.hammer(v, vin / ns);
        if (u !== 0) {
          const i1 = (wp - v.t1) & mask, i2 = (wp - v.t2) & mask;
          for (let i = 0; i < nl; i++) { const off = i * size, e = u * ex[i]; buf[off + i1] -= e; buf[off + i2] += e; }
        }
      }
      let vj = 0;
      for (let i = 0; i < nl; i++) {
        let xx = buf[i * size + ((wp - N[i]) & mask)];
        let o = eta[i] * xx + thz[i]; thz[i] = xx - eta[i] * o; xx = o; // fractional tuning (Thiran allpass)
        for (let m = 0, q = i * MAXM; m < M; m++, q++) { o = ad * xx + ds[q]; ds[q] = xx - ad * o; xx = o; } // stiffness
        xx = b0[i] * xx + c * lz[i]; lz[i] = xx; // frequency-dependent losses
        y[i] = xx; vj += kap[i] * xx;
      }
      for (let i = 0; i < nl; i++) buf[i * size + wp] = (y[i] - vj) * gl; // bridge junction (+ damper)
      wp = (wp + 1) & mask;
      v.gc += (v.g - v.gc) * gr; // a treble boost fades in over ~1.5 ms so it lifts the tone, not the hammer click
      let out = vj * g * v.gc;
      if (fstep) { fade -= fstep; if (fade < 0) fade = 0; out *= fade; }
      const a = out < 0 ? -out : out; if (a > env) env = a;
      bL[s] += out * pl; bR[s] += out * pr; bM[s] += out;
    }
    v.wp = wp; v.damp = damp; v.envB = env; v.fade = fade;
  }

  postProcess(L, R, n) {
    if (this.dirty) this.update();
    const bL = this.bL, bR = this.bR, bM = this.bM, bT = this.bT, th = this.th, ty = this.thY;
    const sbB = this.sbB, a1 = this.sbA1, a2 = this.sbA2, gL = this.sbGL, gR = this.sbGR, y1 = this.sbY1, y2 = this.sbY2;
    const rb = this.rBuf, rs = this.rSize, rm = rs - 1, rD = this.rD, rG = this.rG, rZ = this.rZ, wet = this.wet;
    const lev = this.lev, wg = this.warmG, lk = this.lpK, ha = this.hpA;
    let x1 = this.sbX1, x2 = this.sbX2, rp = this.rp;
    // sympathetic strings: the keys being played are already real voices, so their own bank strings take no input
    const NS = this.NS, NP = this.NP, sBuf = this.sBuf, sOff = this.sOff, sMask = this.sMask, sN = this.sN, sEta = this.sEta, sThz = this.sThz;
    const sB0 = this.sB0, sLz = this.sLz, sGdm = this.sGdm, sGL = this.sGL, sGR = this.sGR, sGate = this.sGate, kIn = this.kIn, kOut = this.kOut, dk = this.dampK, lift = this.lift;
    const sym = kIn > 0;
    let sw = this.sW, liftS = this.liftS;
    if (sym) {
      sGate.fill(0);
      for (let i = 0; i < MAXV; i++) { const v = this.voices[i]; if (v.active) { const j = v.key >= SYM_LO && v.key <= SYM_HI ? v.key - SYM_LO : v.key > DAMPER_TOP ? NP + v.key - DAMPER_TOP - 1 : -1; if (j >= 0) sGate[j] = 1; } }
      if (this.pedNoise) { // lifting the dampers brushes every string: a soft wash at their pitches
        const amp = 0.0064 * this.p[I.mech] * this.model.mech;
        for (let i = 0; i < NP; i++) for (let k = 1; k <= sN[i]; k++) sBuf[sOff[i] + ((sw - k) & sMask[i])] += (this.rand() - 0.5) * amp;
      }
      this.symIdle = lift < 0.002 && liftS < 0.002 ? this.symIdle + n : 0;
    }
    this.pedNoise = false;
    const skipP = this.symIdle > 0.4 * this.sr;
    for (let s = 0; s < n; s++) {
      const t = bT[s]; bT[s] = 0;
      const k1 = th[0] * t + th[1] * ty[0] + th[2] * ty[1]; ty[1] = ty[0]; ty[0] = k1;
      const k2 = th[3] * t + th[4] * ty[2] + th[5] * ty[3]; ty[3] = ty[2]; ty[2] = k2;
      const knock = k1 + 0.4 * k2;
      let m = bM[s] + knock; bM[s] = 0;
      let syl = 0, syr = 0;
      if (sym) {
        liftS += (lift - liftS) * dk;
        const inp = kIn * m;
        for (let i = skipP ? NP : 0; i < NS; i++) {
          const off = sOff[i], mk = sMask[i];
          let xx = sBuf[off + ((sw - sN[i]) & mk)];
          const o = sEta[i] * xx + sThz[i]; sThz[i] = xx - sEta[i] * o;
          xx = sB0[i] * o + 0.3 * sLz[i]; sLz[i] = xx;
          sBuf[off + (sw & mk)] = xx * (i < NP ? 1 - (1 - liftS) * sGdm[i] : 1) + (sGate[i] ? 0 : inp);
          syl += xx * sGL[i]; syr += xx * sGR[i];
        }
        sw = (sw + 1) & 0x3fffffff;
        syl *= kOut; syr *= kOut;
        m += 0.5 * (syl + syr);
      }
      let sl = 0, sr = 0;
      for (let i = 0; i < NSB; i++) {
        const yy = sbB[i] * (m - x2) + a1[i] * y1[i] + a2[i] * y2[i];
        y2[i] = y1[i]; y1[i] = yy; sl += gL[i] * yy; sr += gR[i] * yy;
      }
      x2 = x1; x1 = m;
      let l = bL[s] + 0.5 * knock + sl + syl, r = bR[s] + 0.5 * knock + sr + syr; bL[s] = 0; bR[s] = 0;
      this.lpL += lk * (l - this.lpL); l += wg * this.lpL;
      this.lpR += lk * (r - this.lpR); r += wg * this.lpR;
      const hl = ha * (this.hyL + l - this.hxL); this.hxL = l; this.hyL = hl;
      const hr = ha * (this.hyR + r - this.hxR); this.hxR = r; this.hyR = hr;
      l = hl; r = hr;
      if (wet > 0) { // small room: 4-line feedback delay network
        const z0 = (rZ[0] += 0.45 * (rb[(rp - rD[0]) & rm] - rZ[0])), z1 = (rZ[1] += 0.45 * (rb[rs + ((rp - rD[1]) & rm)] - rZ[1]));
        const z2 = (rZ[2] += 0.45 * (rb[2 * rs + ((rp - rD[2]) & rm)] - rZ[2])), z3 = (rZ[3] += 0.45 * (rb[3 * rs + ((rp - rD[3]) & rm)] - rZ[3]));
        const inp = 0.35 * (l + r);
        rb[rp] = inp + 0.5 * (z0 + z1 + z2 + z3) * rG[0];
        rb[rs + rp] = inp + 0.5 * (z0 - z1 + z2 - z3) * rG[1];
        rb[2 * rs + rp] = -inp + 0.5 * (z0 + z1 - z2 - z3) * rG[2];
        rb[3 * rs + rp] = -inp + 0.5 * (z0 - z1 - z2 + z3) * rG[3];
        rp = (rp + 1) & rm;
        l += wet * (z0 + 0.6 * z2); r += wet * (z1 + 0.6 * z3);
      }
      l *= lev; r *= lev;
      if (l > 0.7 || l < -0.7) l = l > 0 ? 0.7 + 0.3 * Math.tanh((l - 0.7) / 0.3) : -0.7 - 0.3 * Math.tanh((-l - 0.7) / 0.3); // safety: rare extreme peaks stay under 0 dBFS
      if (r > 0.7 || r < -0.7) r = r > 0 ? 0.7 + 0.3 * Math.tanh((r - 0.7) / 0.3) : -0.7 - 0.3 * Math.tanh((-r - 0.7) / 0.3);
      L[s] += l; R[s] += r;
    }
    this.sbX1 = x1; this.sbX2 = x2; this.rp = rp; this.sW = sw; this.liftS = liftS;
    // retire voices that have died away
    let act = 0;
    for (let i = 0; i < MAXV; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      v.age += n; v.lvl = Math.max(v.envB, v.lvl * 0.97);
      const thr = v.damp > 0.5 ? 2e-5 : 2e-6;
      v.quiet = v.envB < thr && !v.hOn && !v.fading ? v.quiet + n : 0;
      if (v.quiet > 2 * v.N[0] + 0.03 * this.sr) v.active = false; else act++; // silent for over a period
      v.envB = 0;
    }
    this.tele[0] = act; this.tele[1] = this.p[I.pedal] > this.livePedal ? this.p[I.pedal] : this.livePedal;
  }
}
