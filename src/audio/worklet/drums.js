// EDM drum kit instrument (audio thread). Every piece is synthesized per hit:
// pitch-swept sine kicks, tone + noise snares, multi-burst claps, six-square
// metallic hats and cymbals, FM percussion and filtered-noise risers.
// Allocation-free after construction; notes map to pieces via NOTE_MAP.

import { KITS, DRUM_INDEX as I, DRUM_COUNT, DRUM_PARAMS, PIECES, PC, NOTE_MAP, NPIECES } from '../../shared/drums.js';

const MAXV = 32;
const TAU = 2 * Math.PI;
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
const RIDE = [281.6, 417.1, 506.4, 716.1, 739.8, 1096];
const PAN = new Float64Array(NPIECES);
for (const [id, pan] of [['chh', 0.32], ['ohh', 0.32], ['ride', 0.42], ['crash', -0.3], ['tomL', -0.4], ['tomM', 0.05], ['tomH', 0.4],
  ['shaker', -0.5], ['perc', 0.45], ['rim', 0.18]]) PAN[PC[id]] = pan;
const RISER_BARS = new Float64Array(NPIECES);
RISER_BARS[PC.riser1] = 1; RISER_BARS[PC.riser2] = 2; RISER_BARS[PC.riser4] = 4;
const dbg = (db) => Math.pow(10, db / 20);
const KIT_GAIN = 0.6; // full-velocity kick ≈ −6 dBFS before the glue saturation
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Zavalishin TPT state-variable filter coefficients, stored in a Float64Array at o: g, k, a1, a2, a3
function svfSet(c, o, fc, q, sr) {
  const g = Math.tan(Math.PI * clamp(fc, 20, sr * 0.45) / sr), k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  c[o] = g; c[o + 1] = k; c[o + 2] = a1; c[o + 3] = g * a1; c[o + 4] = g * g * a1;
}

class Voice {
  constructor() {
    this.active = false; this.k = -1; this.note = -1; this.t = 0; this.age = 0;
    this.amp = 0; this.gl = 1; this.gr = 1;
    this.ph = new Float64Array(6); this.inc = new Float64Array(6);
    this.e1 = 0; this.e2 = 0; this.c1 = 0; this.c2 = 0; this.pe = 0; this.pc = 0;
    this.f0 = 0; this.f1 = 0; this.x1 = 0; this.x2 = 0; this.x3 = 0;
    this.cf = new Float64Array(10); // two filters' coefficients
    this.st = new Float64Array(8);  // filter states (4 per filter; riser uses L/R pairs)
    this.rng = 1; this.n1 = 0; this.n2 = 0; this.dur = 0; this.rel = false; this.choke = false;
  }
}

export class DrumKit {
  constructor(sr) {
    this.sr = sr;
    this.p = new Float64Array(DRUM_COUNT); this.manual = new Float64Array(DRUM_COUNT); this.auto = new Uint8Array(DRUM_COUNT);
    DRUM_PARAMS.forEach((d, i) => { this.p[i] = d.def; this.manual[i] = d.def; });
    this.voices = Array.from({ length: MAXV }, () => new Voice());
    this.ageN = 0; this.rngS = 0x2545f491;
    this.tempo = 120;
    this.outG = -1; this.lpL = 0; this.lpR = 0;
    this.hit = new Float64Array(NPIECES);
    this.tele = new Float64Array(32);
  }

  // ------------------------------------------------------------ parameters (same contract as SawForge)
  applyParam(i, v) { this.p[i] = v; }
  setParam(i, v) { this.manual[i] = v; if (!this.auto[i]) this.applyParam(i, v); }
  setAuto(i, v) { this.auto[i] = 1; if (this.p[i] !== v) this.applyParam(i, v); }
  setManualAll(arr, snap) { for (let i = 0; i < DRUM_COUNT && i < arr.length; i++) { this.manual[i] = arr[i]; if (!this.auto[i]) this.applyParam(i, arr[i]); } if (snap) this.outG = -1; }
  setAutomated(flags) {
    for (let i = 0; i < DRUM_COUNT; i++) {
      const was = this.auto[i];
      this.auto[i] = flags ? flags[i] : 0;
      if (was && !this.auto[i]) this.applyParam(i, this.manual[i]);
    }
  }
  setTable() {}
  pitchBend() {}
  modWheel() {}
  beginBlock(tempo) { if (tempo > 0) this.tempo = tempo; }
  get kit() { return KITS[clamp(Math.round(this.p[I.kit]), 0, KITS.length - 1)]; }
  rand() { let x = this.rngS; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngS = x; return (x >>> 0) / 4294967296; }

  allNotesOff(hard) {
    for (const v of this.voices) {
      if (!v.active) continue;
      if (hard) v.active = false; else if (RISER_BARS[v.k] > 0) v.rel = true;
    }
  }
  noteOff(note) { for (const v of this.voices) if (v.active && v.note === note && RISER_BARS[v.k] > 0) v.rel = true; }

  noteOn(note, vel) {
    const k = note >= 0 && note < 128 ? NOTE_MAP[note] : -1;
    if (k < 0) return;
    const sr = this.sr, p = this.p, kit = this.kit;
    // chokes: closed hat stops open hats; a new kick replaces the old one
    if (k === PC.chh || k === PC.kick) {
      const victim = k === PC.chh ? PC.ohh : PC.kick;
      for (const o of this.voices) if (o.active && o.k === victim && !o.choke) { o.choke = true; o.c1 = Math.exp(-1 / (0.004 * sr)); o.c2 = o.c1; }
    }
    let v = null;
    for (const o of this.voices) if (!o.active) { v = o; break; }
    if (!v) { v = this.voices[0]; for (const o of this.voices) if (o.age < v.age) v = o; }
    const vs = p[I.vel], vg = 1 - vs + vs * Math.pow(clamp(vel, 0, 1), 1.4);
    const pc = PIECES[k];
    const pan = PAN[k] * p[I.width] * 1.4;
    v.active = true; v.k = k; v.note = note; v.t = 0; v.age = ++this.ageN; v.rel = false; v.choke = false;
    v.gl = Math.min(1, 1 - pan); v.gr = Math.min(1, 1 + pan);
    v.rng = (this.rand() * 4294967295) | 0 || 7;
    v.st.fill(0); v.x1 = v.x2 = v.x3 = 0;
    for (let j = 0; j < 6; j++) v.ph[j] = this.rand();
    const lvl = dbg(p[I[pc.level]]);
    const hatTone = Math.pow(2, p[I['h.tone']] + p[I.tone] * 0.5);
    const decay = (s) => Math.exp(-1 / (Math.max(0.0005, s) * sr));
    let a = 1;
    switch (pc.id) {
      case 'kick': {
        const K = kit.kick, tune = Math.pow(2, p[I['k.tune']] / 12), punch = Math.pow(2, (p[I['k.punch']] - 0.5) * 2);
        v.f0 = K.f0 * tune; v.f1 = K.f1 * tune; v.pe = 1; v.pc = decay(K.pd);
        v.e1 = 1; v.c1 = decay(K.d * p[I['k.decay']]); v.e2 = 1; v.c2 = decay(0.0025);
        v.x1 = clamp(K.click * punch, 0, 1);             // click amount
        v.x2 = 1 + clamp(K.drive * punch, 0, 1) * 4;      // drive
        v.x3 = 1 / Math.tanh(v.x2);
        v.ph[0] = 0; a = K.lvl;
        break;
      }
      case 'snare': {
        const S = kit.snare, tune = Math.pow(2, p[I['s.tune']] / 12), d = p[I['s.decay']];
        v.f0 = S.tone * tune; v.pe = 1; v.pc = decay(0.012);
        v.e1 = 1; v.c1 = decay(S.td * d); v.e2 = 1; v.c2 = decay(S.nd * d);
        v.x1 = clamp(S.snap * Math.pow(2, (p[I['s.snap']] - 0.5) * 2), 0, 1);
        svfSet(v.cf, 0, S.hp, 0.7, sr); svfSet(v.cf, 5, 5200 * hatTone, 0.8, sr);
        v.ph[0] = 0; v.ph[1] = 0; a = S.lvl;
        break;
      }
      case 'clap': {
        const C = kit.clap;
        svfSet(v.cf, 0, C.f * Math.pow(2, p[I['s.tune']] / 24), C.q, sr);
        v.n1 = Math.max(1, Math.round(C.gap * sr)); v.n2 = C.bursts * v.n1;
        v.e1 = 1; v.c1 = decay(0.0048); v.e2 = 1; v.c2 = decay(C.tail * p[I['s.decay']]);
        a = C.lvl;
        break;
      }
      case 'rim': {
        const Rm = kit.rim, f = Rm.f * Math.pow(2, p[I['s.tune']] / 12);
        v.inc[0] = (1700 * f) / sr; v.inc[1] = (820 * f) / sr; v.ph[0] = v.ph[1] = 0;
        v.e1 = 1; v.c1 = decay(Rm.d); v.e2 = 1; v.c2 = decay(0.002);
        a = Rm.lvl;
        break;
      }
      case 'chh': case 'ohh': case 'ride': {
        const H = kit[pc.id], ride = pc.id === 'ride', freqs = ride ? RIDE : METAL;
        for (let j = 0; j < 6; j++) v.inc[j] = (freqs[j] * (ride ? 1 : 1.0 + 0.08 * p[I['h.tone']])) / sr;
        const d = ride ? H.d * p[I['c.decay']] : H.d * p[I['h.decay']];
        v.e1 = 1; v.c1 = decay(d); v.e2 = 1; v.c2 = decay(ride ? 0.45 : 0.002);
        v.x1 = ride ? 0.65 : H.metal; v.x2 = ride ? H.bell : 0;
        svfSet(v.cf, 0, (ride ? 8800 : 10500) * hatTone, 0.9, sr); svfSet(v.cf, 5, H.cut * hatTone, 0.7, sr);
        if (ride) { v.f0 = 2380 / sr; v.f1 = 3420 / sr; }
        a = H.lvl;
        break;
      }
      case 'crash': {
        const Cr = kit.crash;
        for (let j = 0; j < 6; j++) v.inc[j] = (METAL[j] * 1.9) / sr;
        v.e1 = 1; v.c1 = decay(0.12); v.e2 = 1; v.c2 = decay(Cr.d * p[I['c.decay']]);
        svfSet(v.cf, 0, Cr.cut * Math.pow(2, p[I.tone] * 0.5), 0.6, sr); svfSet(v.cf, 5, 12000, 0.5, sr);
        v.n1 = Math.max(1, Math.round(0.0015 * sr));
        a = Cr.lvl;
        break;
      }
      case 'tomL': case 'tomM': case 'tomH': {
        const T = kit.toms, idx = pc.id === 'tomL' ? 0 : pc.id === 'tomM' ? 1 : 2;
        v.f0 = T.f[idx] * Math.pow(2, p[I['t.tune']] / 12); v.pe = 1; v.pc = decay(T.pd);
        v.e1 = 1; v.c1 = decay(T.d); v.e2 = 1; v.c2 = decay(0.006);
        v.ph[0] = 0; a = T.lvl;
        break;
      }
      case 'shaker': {
        const Sh = kit.shaker;
        svfSet(v.cf, 0, Sh.cut * hatTone, 1.3, sr);
        v.n1 = Math.max(1, Math.round(Sh.att * sr)); v.e1 = 1; v.c1 = decay(Sh.d * p[I['h.decay']]);
        a = Sh.lvl;
        break;
      }
      case 'perc': {
        const Pc = kit.perc;
        v.inc[0] = Pc.f / sr; v.inc[1] = (Pc.f * Pc.ratio) / sr; v.ph[0] = v.ph[1] = 0;
        v.x1 = Pc.index; v.e1 = 1; v.c1 = decay(Pc.d); v.e2 = 1; v.c2 = decay(0.03);
        a = Pc.lvl;
        break;
      }
      default: { // risers
        const Rs = kit.riser;
        v.f0 = Rs.f0; v.f1 = Rs.f1; v.x1 = Rs.q;
        v.dur = Math.max(1, RISER_BARS[k] * 4 * (60 / this.tempo) * sr);
        v.e1 = 1; v.c1 = decay(0.07);
        v.n1 = 0; // samples until the next filter update
        a = Rs.lvl;
      }
    }
    v.amp = a * lvl * vg * KIT_GAIN;
    if (vg * lvl > this.hit[k]) this.hit[k] = Math.min(1.5, vg * lvl);
  }

  render(L, R, from, to) {
    if (to <= from) return;
    for (let i = 0; i < MAXV; i++) { const v = this.voices[i]; if (v.active) this.renderVoice(v, L, R, from, to); }
  }

  noise(v) { let x = v.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; v.rng = x; return (x | 0) / 2147483648; }

  renderVoice(v, L, R, from, to) {
    const sr = this.sr, amp = v.amp, gl = v.gl * amp, gr = v.gr * amp, cf = v.cf, st = v.st;
    let done = false;
    switch (PIECES[v.k].id) {
      case 'kick': {
        let ph = v.ph[0], e1 = v.e1, e2 = v.e2, pe = v.pe;
        const f0 = v.f0, f1 = v.f1, c1 = v.c1, c2 = v.c2, pcf = v.pc, click = v.x1, dg = v.x2, nrm = v.x3;
        for (let n = from; n < to; n++) {
          ph += (f1 + (f0 - f1) * pe) / sr; if (ph >= 1) ph -= 1;
          const x = Math.tanh(Math.sin(TAU * ph) * e1 * dg) * nrm + this.noise(v) * e2 * click * 0.45;
          L[n] += x * gl; R[n] += x * gr;
          pe *= pcf; e1 *= c1; e2 *= c2;
        }
        v.ph[0] = ph; v.e1 = e1; v.e2 = e2; v.pe = pe; done = e1 < 1e-4;
        break;
      }
      case 'snare': {
        let p0 = v.ph[0], p1 = v.ph[1], e1 = v.e1, e2 = v.e2, pe = v.pe, a1 = st[0], a2 = st[1], b1 = st[2], b2 = st[3];
        const f = v.f0 / sr, snap = v.x1, tg = 1 - 0.45 * snap;
        const k = cf[1], A1 = cf[2], A2 = cf[3], A3 = cf[4], B1 = cf[7], B2 = cf[8], B3 = cf[9];
        for (let n = from; n < to; n++) {
          const fm = f * (1 + 0.45 * pe);
          p0 += fm; if (p0 >= 1) p0 -= 1; p1 += fm * 1.62; if (p1 >= 1) p1 -= 1;
          const tone = (Math.sin(TAU * p0) * 0.62 + Math.sin(TAU * p1) * 0.34) * e1 * tg;
          const w = this.noise(v);
          let v3 = w - a2, v1 = A1 * a1 + A2 * v3, v2 = a2 + A2 * a1 + A3 * v3; a1 = 2 * v1 - a1; a2 = 2 * v2 - a2;
          const hp = w - k * v1 - v2;
          v3 = hp - b2; v1 = B1 * b1 + B2 * v3; v2 = b2 + B2 * b1 + B3 * v3; b1 = 2 * v1 - b1; b2 = 2 * v2 - b2; // gentle top-end roll-off
          const x = tone + v2 * e2 * snap * 1.1;
          L[n] += x * gl; R[n] += x * gr;
          pe *= v.pc; e1 *= v.c1; e2 *= v.c2;
        }
        v.ph[0] = p0; v.ph[1] = p1; v.e1 = e1; v.e2 = e2; v.pe = pe; st[0] = a1; st[1] = a2; st[2] = b1; st[3] = b2;
        done = e1 < 1e-4 && e2 < 1e-4;
        break;
      }
      case 'clap': {
        let e1 = v.e1, e2 = v.e2, t = v.t, a1 = st[0], a2 = st[1];
        const A1 = cf[2], A2 = cf[3], A3 = cf[4], gap = v.n1, tail = v.n2;
        for (let n = from; n < to; n++, t++) {
          let env;
          if (t < tail) { if (t % gap === 0) e1 = 1; env = e1; e1 *= v.c1; } else { env = e2 * 0.78; e2 *= v.c2; }
          const w = this.noise(v);
          const v3 = w - a2, v1 = A1 * a1 + A2 * v3, v2 = a2 + A2 * a1 + A3 * v3; a1 = 2 * v1 - a1; a2 = 2 * v2 - a2;
          const x = v1 * env * 2.4;
          L[n] += x * gl; R[n] += x * gr;
        }
        v.e1 = e1; v.e2 = e2; v.t = t; st[0] = a1; st[1] = a2; done = t > tail && e2 < 1e-4;
        return void (done && (v.active = false));
      }
      case 'rim': {
        let p0 = v.ph[0], p1 = v.ph[1], e1 = v.e1, e2 = v.e2;
        for (let n = from; n < to; n++) {
          p0 += v.inc[0]; if (p0 >= 1) p0 -= 1; p1 += v.inc[1]; if (p1 >= 1) p1 -= 1;
          const x = (Math.sin(TAU * p0) * 0.6 + Math.sin(TAU * p1) * 0.4) * e1 + this.noise(v) * e2 * 0.5;
          L[n] += x * gl; R[n] += x * gr;
          e1 *= v.c1; e2 *= v.c2;
        }
        v.ph[0] = p0; v.ph[1] = p1; v.e1 = e1; v.e2 = e2; done = e1 < 1e-4;
        break;
      }
      case 'chh': case 'ohh': case 'ride': case 'crash': {
        const ph = v.ph, inc = v.inc, crash = v.k === PC.crash, ride = v.k === PC.ride;
        let e1 = v.e1, e2 = v.e2, t = v.t, a1 = st[0], a2 = st[1], b1 = st[2], b2 = st[3], q0 = v.x3;
        const metal = crash ? 0.35 : v.x1, A1 = cf[2], A2 = cf[3], A3 = cf[4], k1 = cf[1], B1 = cf[7], B2 = cf[8], B3 = cf[9], k2 = cf[6];
        for (let n = from; n < to; n++, t++) {
          let sq = 0;
          for (let j = 0; j < 6; j++) { let x = ph[j] + inc[j]; if (x >= 1) x -= 1; ph[j] = x; sq += x < 0.5 ? 1 : -1; }
          const src = (sq / 6) * metal + this.noise(v) * (1 - metal);
          // band-pass for the sizzle, then high-pass to clear the body
          let v3 = src - a2, v1 = A1 * a1 + A2 * v3, v2 = a2 + A2 * a1 + A3 * v3; a1 = 2 * v1 - a1; a2 = 2 * v2 - a2;
          const bp = crash ? src - k1 * v1 - v2 : v1; // crash: first filter is a high-pass
          v3 = bp - b2; v1 = B1 * b1 + B2 * v3; v2 = b2 + B2 * b1 + B3 * v3; b1 = 2 * v1 - b1; b2 = 2 * v2 - b2;
          const hp = crash ? v2 : bp - k2 * v1 - v2;
          let env;
          if (crash) { const at = t < v.n1 ? t / v.n1 : 1; env = at * (0.5 * e1 + 0.5 * e2); e1 *= v.c1; e2 *= v.c2; }
          else { env = e1 * (t < 24 ? t / 24 : 1); e1 *= v.c1; }
          let x = hp * env * (crash ? 1.3 : 1.6);
          if (ride) { q0 += 1; x += (Math.sin(TAU * v.f0 * q0) * 0.6 + Math.sin(TAU * v.f1 * q0) * 0.4) * e2 * v.x2 * 0.32; e2 *= v.c2; }
          L[n] += x * gl; R[n] += x * gr;
        }
        v.e1 = e1; v.e2 = e2; v.t = t; v.x3 = q0; st[0] = a1; st[1] = a2; st[2] = b1; st[3] = b2;
        return void ((crash ? e2 < 1e-4 && e1 < 1e-4 : e1 < 1e-4) && (v.active = false));
      }
      case 'tomL': case 'tomM': case 'tomH': {
        let ph = v.ph[0], e1 = v.e1, e2 = v.e2, pe = v.pe;
        const f = v.f0 / sr;
        for (let n = from; n < to; n++) {
          ph += f * (1 + 0.6 * pe); if (ph >= 1) ph -= 1;
          const x = Math.sin(TAU * ph) * e1 + this.noise(v) * e2 * 0.25;
          L[n] += x * gl; R[n] += x * gr;
          pe *= v.pc; e1 *= v.c1; e2 *= v.c2;
        }
        v.ph[0] = ph; v.e1 = e1; v.e2 = e2; v.pe = pe; done = e1 < 1e-4;
        break;
      }
      case 'shaker': {
        let e1 = v.e1, t = v.t, a1 = st[0], a2 = st[1];
        const A1 = cf[2], A2 = cf[3], A3 = cf[4], att = v.n1;
        for (let n = from; n < to; n++, t++) {
          const w = this.noise(v);
          const v3 = w - a2, v1 = A1 * a1 + A2 * v3, v2 = a2 + A2 * a1 + A3 * v3; a1 = 2 * v1 - a1; a2 = 2 * v2 - a2;
          let env; if (t < att) env = t / att; else { env = e1; e1 *= v.c1; }
          const x = v1 * env * 1.0;
          L[n] += x * gl; R[n] += x * gr;
        }
        v.e1 = e1; v.t = t; st[0] = a1; st[1] = a2;
        return void (t > att && e1 < 1e-4 && (v.active = false));
      }
      case 'perc': {
        let p0 = v.ph[0], p1 = v.ph[1], e1 = v.e1, e2 = v.e2;
        for (let n = from; n < to; n++) {
          p0 += v.inc[0]; if (p0 >= 1) p0 -= 1; p1 += v.inc[1]; if (p1 >= 1) p1 -= 1;
          const x = Math.sin(TAU * p0 + v.x1 * e2 * Math.sin(TAU * p1)) * e1;
          L[n] += x * gl; R[n] += x * gr;
          e1 *= v.c1; e2 *= v.c2;
        }
        v.ph[0] = p0; v.ph[1] = p1; v.e1 = e1; v.e2 = e2; done = e1 < 1e-4;
        break;
      }
      default: { // riser: stereo noise through a rising band-pass, swelling up to the downbeat
        let t = v.t, e1 = v.e1, upd = v.n1, a1 = st[0], a2 = st[1], b1 = st[2], b2 = st[3];
        const ga = amp * Math.min(1, 1 - PAN[v.k]);
        for (let n = from; n < to; n++, t++) {
          if (--upd <= 0) { const u = Math.min(1, t / v.dur); svfSet(cf, 0, v.f0 * Math.pow(v.f1 / v.f0, u * u), v.x1, sr); upd = 32; }
          const u = Math.min(1, t / v.dur), env = (0.12 + 0.88 * u * u) * (v.rel ? e1 : 1);
          if (v.rel) e1 *= v.c1;
          const A1 = cf[2], A2 = cf[3], A3 = cf[4];
          let w = this.noise(v), v3 = w - a2, v1 = A1 * a1 + A2 * v3, v2 = a2 + A2 * a1 + A3 * v3; a1 = 2 * v1 - a1; a2 = 2 * v2 - a2;
          const xl = v1;
          w = this.noise(v); v3 = w - b2; v1 = A1 * b1 + A2 * v3; v2 = b2 + A2 * b1 + A3 * v3; b1 = 2 * v1 - b1; b2 = 2 * v2 - b2;
          L[n] += xl * env * ga * 1.6; R[n] += v1 * env * ga * 1.6;
        }
        v.t = t; v.e1 = e1; v.n1 = upd; st[0] = a1; st[1] = a2; st[2] = b1; st[3] = b2;
        if (v.rel && e1 < 1e-4) v.active = false;
        return;
      }
    }
    v.t += to - from;
    if (done) v.active = false;
  }

  postProcess(L, R, n) {
    const p = this.p, sr = this.sr;
    // glue: soft saturation with unity small-signal gain
    const dg = 1 + p[I.drive] * 3;
    if (dg > 1.01) for (let i = 0; i < n; i++) { L[i] = Math.tanh(L[i] * dg) / dg; R[i] = Math.tanh(R[i] * dg) / dg; }
    // kit tone: dark kits (Lo-Fi) and the Tone knob roll off the top
    const fc = this.kit.lp * Math.pow(2, p[I.tone] * 1.5);
    if (fc < 18000) {
      const a = 1 - Math.exp((-TAU * fc) / sr);
      let l = this.lpL, r = this.lpR;
      for (let i = 0; i < n; i++) { l += a * (L[i] - l); r += a * (R[i] - r); L[i] = l; R[i] = r; }
      this.lpL = l; this.lpR = r;
    }
    const target = dbg(p[I.out]);
    if (this.outG < 0) this.outG = target;
    let g = this.outG; const dgn = (target - g) / n;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; g += dgn; }
    this.outG = target;
    // telemetry: per-piece hit flashes (tele[4 + piece])
    const fall = Math.exp(-n / (0.14 * sr)), te = this.tele;
    for (let k = 0; k < NPIECES; k++) { this.hit[k] *= fall; te[4 + k] = this.hit[k]; }
  }
}
