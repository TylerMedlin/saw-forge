// Saw Forge: polyphonic analog-style wavetable synthesizer (audio thread).
//
// Signal path per voice:
//   Osc A + Osc B (band-limited wavetables, up to 8 unison voices each,
//   optional hard sync with polyBLEP correction, dual-phase pulse shaping)
//   + Sub + Noise -> Drive (antiderivative anti-aliased tanh)
//   -> Filter (SVF LP12/LP24/HP/BP or zero-delay-feedback ladder) -> Amp
// Synth bus: Distortion -> Chorus -> Delay -> Reverb -> EQ -> Output gain.
//
// Real-time rules: every buffer and voice is preallocated; render paths do
// not allocate. Modulation runs at a control rate of 32 samples with
// per-sample linear ramps for pitch, wavetable position, levels, filter
// coefficients and amplitude, so control changes never step audibly.

import {
  SYNTH_PARAMS, SYNTH_INDEX as I, SYNC_DIVS, SRC, DEST, SYNTH_FX, EFFECT_DEFS, MATRIX_SLOTS, smoothKind,
} from '../../shared/params.js';
import { FxSlot, ADAA } from './effects.js';

const NP = SYNTH_PARAMS.length;
const CR = 32;
const MAX_UNI = 8;
const POOL = 20;
const TAU = Math.PI * 2;
const HEADROOM = 0.3;
const NSRC = 12;
const NDST = 23;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fastTanh = (x) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));

function oscIndex(k) {
  const o = {};
  for (const n of ['on', 'level', 'pos', 'oct', 'semi', 'fine', 'uni', 'detune', 'spread', 'phase', 'rand', 'pulse', 'width', 'sync', 'pan']) o[n] = I[`${k}.${n}`];
  return o;
}
const OSC = [oscIndex('a'), oscIndex('b')];
const ENV = ['aenv', 'fenv', 'menv'].map((k) => ({ a: I[k + '.a'], d: I[k + '.d'], s: I[k + '.s'], r: I[k + '.r'] }));
const LFO = ['lfo1', 'lfo2'].map((k) => ({ shape: I[k + '.shape'], sync: I[k + '.sync'], rate: I[k + '.rate'], div: I[k + '.div'], retrig: I[k + '.retrig'], phase: I[k + '.phase'] }));
const MAT = Array.from({ length: MATRIX_SLOTS }, (_, s) => ({ src: I[`m${s}.src`], dst: I[`m${s}.dst`], amt: I[`m${s}.amt`] }));
const X = {
  subOn: I['sub.on'], subLvl: I['sub.level'], subOct: I['sub.oct'], subShape: I['sub.shape'],
  nOn: I['noise.on'], nLvl: I['noise.level'], nColor: I['noise.color'], drift: I['an.drift'], vari: I['an.var'],
  fMode: I['flt.mode'], cut: I['flt.cut'], res: I['flt.res'], drive: I['flt.drive'], fEnv: I['flt.env'], key: I['flt.key'], fVel: I['flt.vel'],
  vMode: I['v.mode'], poly: I['v.poly'], glide: I['v.glide'], bend: I['v.bend'], vVel: I['v.vel'], out: I['out.gain'],
};

class Voice {
  constructor(id) {
    this.id = id;
    this.active = false; this.released = false; this.dying = false; this.kill = 0;
    this.note = 60; this.vel = 1; this.velGain = 1; this.age = 0;
    this.pitch = 60; this.target = 60;
    this.cr = 0; this.fresh = true;
    const f64 = () => [new Float64Array(MAX_UNI), new Float64Array(MAX_UNI)];
    this.nU = new Int32Array(2); this.on = new Uint8Array(2); this.sync = new Uint8Array(2); this.mip = new Int32Array(2);
    this.ph = f64(); this.mph = f64(); this.inc = f64(); this.dinc = f64(); this.minc = f64(); this.prev = f64();
    this.gl = f64(); this.gr = f64(); this.uvar = f64();
    this.pos = new Float64Array(2); this.dpos = new Float64Array(2);
    this.lvl = new Float64Array(2); this.dlvl = new Float64Array(2);
    this.pulse = new Float64Array(2); this.width = new Float64Array(2);
    this.subPh = 0; this.subInc = 0; this.subLvl = 0; this.dsub = 0;
    this.nLvl = 0; this.dn = 0;
    this.rng = (Math.imul(id, 2654435761) | 0) || 1;
    this.pk = new Float64Array(3);
    this.g = 0; this.dg = 0; this.k = 2; this.dk = 0;
    this.drv = 1; this.ddrv = 0; this.comp = 1; this.dcomp = 0; this.wet = 0; this.dwet = 0; this.useDrive = false;
    this.fs = new Float64Array(16);
    this.adL = new ADAA(); this.adR = new ADAA();
    this.amp = 0; this.damp = 0; this.pl = 1; this.pr = 1;
    this.ev = new Float64Array(3); this.es = new Int8Array(3);
    this.lph = new Float64Array(2); this.lval = new Float64Array(2); this.lrnd = new Float64Array(2); this.lprev = new Float64Array(2);
    this.lrate = new Float64Array([1, 1]);
    this.drift = new Float64Array(2); this.driftT = new Float64Array(2); this.driftN = 0;
    this.cutVar = 0; this.envScale = 1; this.lvlVar = 1; this.rnd = 0;
    this.posT = new Float64Array(2); this.cutHz = 1000;
    this.cA = new Float64Array(3); this.cD = new Float64Array(3); this.cR = new Float64Array(3); this.coefBlock = -1;
    this.rat = [new Float64Array(MAX_UNI), new Float64Array(MAX_UNI)];
    this.cDet = new Float64Array([NaN, NaN]); this.cNU = new Int32Array(2); this.cSpr = new Float64Array(2); this.cPan = new Float64Array(2);
  }
}

function lfoShape(shape, ph, rnd, prev) {
  switch (shape) {
    case 0: return Math.sin(TAU * ph);
    case 1: { const t = ph + 0.25; const f = t - Math.floor(t); return 1 - 4 * Math.abs(f - 0.5); }
    case 2: return 2 * ph - 1;
    case 3: return 1 - 2 * ph;
    case 4: return ph < 0.5 ? 1 : -1;
    case 5: return rnd;
    default: { const t = 0.5 - 0.5 * Math.cos(Math.PI * ph); return prev + (rnd - prev) * t; }
  }
}

export class SawForge {
  constructor(sr) {
    this.sr = sr;
    this.p = new Float64Array(NP); this.ps = new Float64Array(NP); this.manual = new Float64Array(NP);
    this.auto = new Uint8Array(NP); this.sk = new Int8Array(NP);
    for (let i = 0; i < NP; i++) {
      const d = SYNTH_PARAMS[i];
      this.p[i] = this.ps[i] = this.manual[i] = d.def;
      this.sk[i] = smoothKind(d);
    }
    this.voices = Array.from({ length: POOL }, (_, i) => new Voice(i + 1));
    this.mono = this.voices[0];
    this.tables = [null, null];
    this.fx = SYNTH_FX.map((type) => { const s = new FxSlot('sf-' + type, type, sr); s.on = false; s.x = 0; return s; });
    this.fxOnSlot = new Int8Array(NP).fill(-1);
    this.fxSlot = new Int8Array(NP).fill(-1);
    this.fxIdx = new Int16Array(NP);
    SYNTH_FX.forEach((type, s) => {
      this.fxOnSlot[I[`fx.${type}.on`]] = s;
      EFFECT_DEFS[type].params.forEach((d, k) => {
        const idx = I[`fx.${type}.${d.id}`];
        this.fxSlot[idx] = s; this.fxIdx[idx] = k;
        this.fx[s].fx.setParam(k, d.def);
      });
    });
    this.mod = new Float64Array(NDST); this.src = new Float64Array(NSRC);
    this.tL = new Float32Array(128); this.tR = new Float32Array(128);
    this.age = 0; this.stack = new Int16Array(32); this.stackN = 0;
    this.bend = 0; this.bendT = 0; this.mw = 0; this.lastPitch = -1;
    this.lfoFree = new Float64Array(2);
    this.tempo = 120; this.beat = 0; this.playing = false;
    this.outG = -1; this.fMode = 1;
    this.rng = 0x2545f491;
    this.tele = new Float64Array(4);
    this.lastVoice = null;
    this.blockId = 0; this.lfoUse = 3; this.fenvUse = true; this.menvUse = true;
  }

  rand() { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x; return (x >>> 0) / 4294967296; }

  // ---------- parameters ----------
  applyParam(i, v) {
    this.p[i] = v;
    if (this.sk[i] === 0) this.ps[i] = v;
    const s = this.fxSlot[i];
    if (s >= 0) this.fx[s].fx.setParam(this.fxIdx[i], v);
    else if (this.fxOnSlot[i] >= 0) this.fx[this.fxOnSlot[i]].on = v >= 0.5;
  }
  setParam(i, v) { this.manual[i] = v; if (!this.auto[i]) this.applyParam(i, v); }
  setAuto(i, v) { this.auto[i] = 1; if (this.p[i] !== v) this.applyParam(i, v); }
  setManualAll(arr, snap) {
    for (let i = 0; i < NP && i < arr.length; i++) {
      this.manual[i] = arr[i];
      if (!this.auto[i] && this.p[i] !== arr[i]) this.applyParam(i, arr[i]);
    }
    if (snap) this.snap();
  }
  // Called when automation lanes are rebuilt: params no longer automated revert to manual values.
  setAutomated(flags) {
    for (let i = 0; i < NP; i++) {
      const was = this.auto[i];
      this.auto[i] = flags[i];
      if (was && !flags[i]) this.applyParam(i, this.manual[i]);
    }
  }
  snap() { for (let i = 0; i < NP; i++) this.ps[i] = this.p[i]; this.outG = -1; }
  setTable(osc, t) { this.tables[osc] = t; }

  // ---------- events ----------
  noteOn(note, vel) {
    const ps = this.ps;
    const mode = ps[X.vMode] | 0;
    if (mode === 0) {
      const poly = clamp(ps[X.poly] | 0, 1, 16);
      let count = 0;
      for (const v of this.voices) if (v.active && !v.kill && !v.dying) count++;
      while (count >= poly) {
        let best = null;
        for (const v of this.voices) {
          if (!v.active || v.kill || v.dying) continue;
          if (!best || (v.released && !best.released) || (v.released === best.released && v.age < best.age)) best = v;
        }
        if (!best) break;
        best.kill = 3; count--;
      }
      let free = null;
      for (const v of this.voices) if (!v.active) { free = v; break; }
      if (!free) { for (const v of this.voices) if (!free || ((v.kill || v.dying) && v.age < free.age)) free = v; }
      this.startVoice(free, note, vel);
    } else {
      this.stackRemove(note);
      if (this.stackN < 32) this.stack[this.stackN++] = note;
      const v = this.mono;
      if (v.active && !v.dying && !v.kill) {
        const held = !v.released;
        v.target = note; v.note = note;
        if (mode === 1 || !held) {
          v.vel = vel; v.velGain = this.velGain(vel);
          v.released = false; v.es[0] = 1; v.es[1] = 1; v.es[2] = 1;
          this.retrigLfo(v);
        }
        if (ps[X.glide] <= 0.0005) v.pitch = note;
        this.lastVoice = v;
      } else {
        this.startVoice(v, note, vel);
      }
    }
    this.lastPitch = note;
  }

  noteOff(note) {
    const mode = this.ps[X.vMode] | 0;
    if (mode === 0) {
      let best = null;
      for (const v of this.voices) {
        if (v.active && v.note === note && !v.released && !v.kill && (!best || v.age < best.age)) best = v;
      }
      if (best) this.release(best);
    } else {
      this.stackRemove(note);
      const v = this.mono;
      if (this.stackN > 0) {
        if (v.active && v.note === note) {
          const top = this.stack[this.stackN - 1];
          v.target = top; v.note = top;
          if (this.ps[X.glide] <= 0.0005) v.pitch = top;
        }
      } else if (v.active && v.note === note) this.release(v);
    }
  }

  stackRemove(note) {
    let w = 0;
    for (let r = 0; r < this.stackN; r++) if (this.stack[r] !== note) this.stack[w++] = this.stack[r];
    this.stackN = w;
  }
  release(v) { v.released = true; v.es[0] = 4; v.es[1] = 4; v.es[2] = 4; }
  allNotesOff(hard) {
    this.stackN = 0;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (hard) { v.active = false; }
      else this.release(v);
    }
    if (hard) for (const s of this.fx) s.fx.reset();
  }
  pitchBend(v) { this.bendT = clamp(v, -1, 1); }
  modWheel(v) { this.mw = clamp(v, 0, 1); }
  velGain(vel) { const a = this.ps[X.vVel]; return 1 - a + a * Math.pow(vel, 1.6); }
  isActive() { for (const v of this.voices) if (v.active) return true; return false; }

  retrigLfo(v) {
    const ps = this.ps;
    for (let l = 0; l < 2; l++) {
      if (ps[LFO[l].retrig] >= 0.5) v.lph[l] = ps[LFO[l].phase];
    }
  }

  startVoice(v, note, vel) {
    const ps = this.ps;
    v.active = true; v.released = false; v.dying = false; v.kill = 0; v.fresh = true; v.cr = 0;
    v.note = note; v.vel = vel; v.velGain = this.velGain(vel); v.age = ++this.age;
    v.target = note;
    v.pitch = ps[X.glide] > 0.0005 && this.lastPitch >= 0 ? this.lastPitch : note;
    const vr = ps[X.vari];
    v.cutVar = (this.rand() * 2 - 1) * vr * 3;
    v.envScale = 1 + (this.rand() * 2 - 1) * vr * 0.15;
    v.lvlVar = 1 + (this.rand() * 2 - 1) * vr * 0.08;
    v.rnd = this.rand() * 2 - 1;
    for (let o = 0; o < 2; o++) {
      const K = OSC[o];
      const ph0 = ps[K.phase] / 360, pr = ps[K.rand];
      for (let u = 0; u < MAX_UNI; u++) {
        let ph = ph0 + this.rand() * pr; ph -= Math.floor(ph);
        v.ph[o][u] = ph; v.mph[o][u] = ph; v.prev[o][u] = 0;
        v.uvar[o][u] = (this.rand() * 2 - 1) * vr * 5;
        v.dinc[o][u] = 0;
      }
      v.on[o] = 0; v.nU[o] = 0;
    }
    v.subPh = 0; v.subLvl = 0; v.dsub = 0; v.nLvl = 0; v.dn = 0; v.pk.fill(0);
    v.amp = 0; v.damp = 0;
    v.ev.fill(0); v.es.fill(1);
    for (let l = 0; l < 2; l++) {
      v.lph[l] = ps[LFO[l].retrig] >= 0.5 ? ps[LFO[l].phase] : this.lfoFree[l];
      v.lrnd[l] = this.rand() * 2 - 1; v.lprev[l] = v.lrnd[l]; v.lrate[l] = 1;
    }
    v.drift[0] = (this.rand() * 2 - 1) * 0.5; v.drift[1] = (this.rand() * 2 - 1) * 0.5; v.driftN = 0;
    v.fs.fill(0); v.adL.type = 4; v.adR.type = 4; v.adL.reset(); v.adR.reset();
    v.drv = 1; v.comp = 1; v.ddrv = 0; v.dcomp = 0; v.wet = 0; v.dwet = 0; v.useDrive = false;
    this.lastVoice = v;
  }

  // ---------- block ----------
  beginBlock(tempo, beat, playing, n) {
    this.tempo = tempo; this.beat = beat; this.playing = playing;
    const p = this.p, ps = this.ps, sk = this.sk;
    for (let i = 0; i < NP; i++) {
      const k = sk[i];
      if (k === 0) continue;
      const t = p[i], c = ps[i];
      if (t === c) continue;
      if (k === 2 && c > 0 && t > 0) {
        const r = t / c;
        ps[i] = Math.abs(r - 1) < 1e-4 ? t : c * Math.pow(r, 0.3);
      } else {
        const d = t - c;
        ps[i] = Math.abs(d) < 1e-6 * (Math.abs(t) + 1e-3) ? t : c + d * 0.3;
      }
    }
    this.bend += (this.bendT - this.bend) * 0.4;
    this.fMode = ps[X.fMode] | 0;
    this.blockId++;
    let lfoUse = 0, menvUse = false, fenvUse = ps[X.fEnv] !== 0;
    for (let s = 0; s < MATRIX_SLOTS; s++) {
      const si = ps[MAT[s].src] | 0;
      if (si === 0 || (ps[MAT[s].dst] | 0) === 0 || ps[MAT[s].amt] === 0) continue;
      if (si === SRC.LFO1) lfoUse |= 1; else if (si === SRC.LFO2) lfoUse |= 2;
      else if (si === SRC.MENV) menvUse = true; else if (si === SRC.FENV) fenvUse = true;
    }
    this.lfoUse = lfoUse; this.menvUse = menvUse; this.fenvUse = fenvUse;
    for (let l = 0; l < 2; l++) {
      this.lfoFree[l] += (this.lfoRate(l) * n) / this.sr;
      this.lfoFree[l] -= Math.floor(this.lfoFree[l]);
    }
  }

  lfoRate(l) {
    const ps = this.ps, L = LFO[l];
    return ps[L.sync] >= 0.5 ? this.tempo / 60 / SYNC_DIVS[ps[L.div] | 0].beats : ps[L.rate];
  }

  render(L, R, from, to) {
    if (to <= from) return;
    for (const v of this.voices) if (v.active) this.renderVoice(v, L, R, from, to);
  }

  renderVoice(v, L, R, from, to) {
    let n = from;
    while (n < to) {
      if (v.cr <= 0) {
        if (v.dying) { v.active = false; return; }
        this.ctrl(v);
        v.cr = CR;
      }
      const m = Math.min(to - n, v.cr);
      this.voiceSamples(v, L, R, n, n + m);
      v.cr -= m; n += m;
    }
  }

  postProcess(L, R, n, ctx) {
    for (let s = 0; s < this.fx.length; s++) this.fx[s].process(L, R, n, ctx);
    const target = Math.pow(10, this.ps[X.out] / 20);
    if (this.outG < 0) this.outG = target;
    let g = this.outG; const dg = (target - g) / n;
    for (let k = 0; k < n; k++) { L[k] *= g; R[k] *= g; g += dg; }
    this.outG = target;
    let c = 0; for (const v of this.voices) if (v.active) c++;
    this.tele[3] = c;
  }

  // ---------- control rate ----------
  envCoefs(v) {
    const ps = this.ps, k = CR / (v.envScale * this.sr);
    for (let e = 0; e < 3; e++) {
      const E = ENV[e];
      v.cA[e] = 1 - Math.exp((-1.466 * k) / ps[E.a]);
      v.cD[e] = 1 - Math.exp((-4.6 * k) / ps[E.d]);
      v.cR[e] = 1 - Math.exp((-4.6 * k) / ps[E.r]);
    }
  }
  advEnv(v, e) {
    const ps = this.ps, E = ENV[e];
    let val = v.ev[e];
    switch (v.es[e]) {
      case 1: {
        val += (1.3 - val) * v.cA[e];
        if (val >= 1) { val = 1; v.es[e] = 2; }
        break;
      }
      case 2: {
        const s = ps[E.s];
        val += (s - val) * v.cD[e];
        if (Math.abs(val - s) < 1e-4) { val = s; v.es[e] = 3; }
        break;
      }
      case 3: val += (ps[E.s] - val) * 0.2; break;
      case 4: {
        val -= val * v.cR[e];
        if (val < 1e-4) { val = 0; v.es[e] = 0; }
        break;
      }
      default: val = 0;
    }
    v.ev[e] = val;
  }

  ctrl(v) {
    const ps = this.ps, sr = this.sr, mod = this.mod, src = this.src;
    const fresh = v.fresh; v.fresh = false;
    if (v.coefBlock !== this.blockId) { v.coefBlock = this.blockId; this.envCoefs(v); }
    this.advEnv(v, 0);
    if (this.fenvUse) this.advEnv(v, 1);
    if (this.menvUse) this.advEnv(v, 2);

    for (let l = 0; l < 2; l++) {
      const Ld = LFO[l];
      let wrapped = false;
      if (ps[Ld.retrig] < 0.5 && ps[Ld.sync] >= 0.5 && this.playing) {
        let ph = this.beat / SYNC_DIVS[ps[Ld.div] | 0].beats + ps[Ld.phase];
        ph -= Math.floor(ph);
        if (ph < v.lph[l]) wrapped = true;
        v.lph[l] = ph;
      } else {
        v.lph[l] += (this.lfoRate(l) * v.lrate[l] * CR) / sr;
        if (v.lph[l] >= 1) { v.lph[l] -= Math.floor(v.lph[l]); wrapped = true; }
      }
      if (wrapped) { v.lprev[l] = v.lrnd[l]; v.lrnd[l] = this.rand() * 2 - 1; }
      v.lval[l] = this.lfoUse & (1 << l) ? lfoShape(ps[Ld.shape] | 0, v.lph[l], v.lrnd[l], v.lprev[l]) : 0;
    }

    src[SRC.LFO1] = v.lval[0]; src[SRC.LFO2] = v.lval[1];
    src[SRC.AENV] = v.ev[0]; src[SRC.FENV] = v.ev[1]; src[SRC.MENV] = v.ev[2];
    src[SRC.VEL] = v.vel; src[SRC.KEY] = (v.note - 60) / 60; src[SRC.MW] = this.mw; src[SRC.PB] = this.bend;
    src[SRC.RND] = v.rnd; src[SRC.DRIFT] = v.drift[0];
    mod.fill(0);
    for (let s = 0; s < MATRIX_SLOTS; s++) {
      const si = ps[MAT[s].src] | 0, di = ps[MAT[s].dst] | 0;
      if (si > 0 && di > 0) mod[di] += src[si] * ps[MAT[s].amt];
    }
    v.lrate[0] = mod[DEST.LFO1_RATE] !== 0 ? Math.pow(2, mod[DEST.LFO1_RATE] * 4) : 1;
    v.lrate[1] = mod[DEST.LFO2_RATE] !== 0 ? Math.pow(2, mod[DEST.LFO2_RATE] * 4) : 1;

    const glide = ps[X.glide];
    if (glide > 0.0005) v.pitch += (v.target - v.pitch) * (1 - Math.exp((-CR * 4.6) / (glide * sr)));
    else v.pitch = v.target;

    if (--v.driftN <= 0) {
      v.driftT[0] = this.rand() * 2 - 1; v.driftT[1] = this.rand() * 2 - 1;
      v.driftN = ((sr / CR) * (0.25 + this.rand() * 0.6)) | 0;
    }
    const dc = CR / (sr * 0.4);
    v.drift[0] += (v.driftT[0] - v.drift[0]) * dc;
    v.drift[1] += (v.driftT[1] - v.drift[1]) * dc;
    const drift = ps[X.drift];
    const bendSt = this.bend * ps[X.bend];

    this.ctrlOsc(v, 0, bendSt, drift, fresh);
    this.ctrlOsc(v, 1, bendSt, drift, fresh);

    // sub
    let subT = 0;
    if (ps[X.subOn] >= 0.5) {
      const pitch = v.pitch + bendSt + ps[OSC[0].oct] * 12 + ps[OSC[0].semi] - 12 * (1 + (ps[X.subOct] | 0));
      v.subInc = Math.min(0.45, (440 * Math.pow(2, (pitch - 69) / 12)) / sr);
      subT = clamp(ps[X.subLvl] + mod[DEST.SUB], 0, 1.5);
    }
    if (fresh) { v.subLvl = subT; v.dsub = 0; } else v.dsub = (subT - v.subLvl) / CR;
    const nT = ps[X.nOn] >= 0.5 ? clamp(ps[X.nLvl] + mod[DEST.NOISE], 0, 1.5) : 0;
    if (fresh) { v.nLvl = nT; v.dn = 0; } else v.dn = (nT - v.nLvl) / CR;

    // filter
    const mode = this.fMode;
    const semis = ps[X.key] * (v.note - 60) + ps[X.fEnv] * 96 * v.ev[1] + ps[X.fVel] * 48 * (v.vel - 0.5)
      + mod[DEST.CUT] * 96 + v.cutVar + v.drift[1] * drift * 1.2;
    const fc = clamp(ps[X.cut] * Math.pow(2, semis / 12), 16, sr * 0.45);
    v.cutHz = fc;
    const g = Math.tan((Math.PI * fc) / sr);
    const res = clamp(ps[X.res] + mod[DEST.RES], 0, 1);
    const k = mode === 2 ? res * 3.9 : 2 - 1.96 * res;
    if (fresh) { v.g = g; v.k = k; v.dg = 0; v.dk = 0; }
    else { v.dg = (g - v.g) / CR; v.dk = (k - v.k) / CR; }
    const drvAmt = clamp(ps[X.drive] + mod[DEST.DRIVE], 0, 1);
    const wetT = Math.min(1, drvAmt * 20);
    if (v.wet < 1e-6) v.wet = 0;
    if (wetT > 0 || v.wet > 0) {
      const drvT = Math.pow(10, (drvAmt * 24) / 20), compT = Math.pow(drvT, -0.55);
      if (!v.useDrive) {
        v.adL.reset(); v.adR.reset();
        v.drv = drvT; v.comp = compT; v.wet = fresh ? wetT : 0;
      }
      v.useDrive = true;
      v.ddrv = (drvT - v.drv) / CR; v.dcomp = (compT - v.comp) / CR; v.dwet = (wetT - v.wet) / CR;
    } else { v.useDrive = false; v.wet = 0; v.dwet = 0; }

    // amp
    let ampT = v.ev[0] * v.velGain * clamp(1 + mod[DEST.AMP], 0, 2) * v.lvlVar * HEADROOM;
    if (v.kill > 0) {
      ampT = (v.amp * (v.kill - 1)) / v.kill;
      v.kill--;
      if (v.kill === 0) { ampT = 0; v.dying = true; }
    } else if (v.es[0] === 0) { ampT = 0; v.dying = true; }
    v.damp = (ampT - v.amp) / CR;
    const pan = clamp(mod[DEST.PAN], -1, 1);
    v.pl = Math.min(1, 1 - pan); v.pr = Math.min(1, 1 + pan);

    if (v === this.lastVoice) { this.tele[0] = v.posT[0]; this.tele[1] = v.posT[1]; this.tele[2] = fc; }
  }

  ctrlOsc(v, o, bendSt, drift, fresh) {
    const K = OSC[o], ps = this.ps, T = this.tables[o], m = this.mod;
    if (ps[K.on] < 0.5 || !T) { v.on[o] = 0; return; }
    const wasOn = v.on[o] === 1;
    v.on[o] = 1;
    const pitchMod = (o === 0 ? m[DEST.A_PITCH] : m[DEST.B_PITCH]) + m[DEST.AB_PITCH];
    const pitch = v.pitch + bendSt + ps[K.oct] * 12 + ps[K.semi] + ps[K.fine] * 0.01 + pitchMod * 24 + v.drift[o] * drift * 0.08;
    const nU = clamp(ps[K.uni] | 0, 1, MAX_UNI);
    const detune = clamp(ps[K.detune] + m[DEST.DETUNE] * 100, 0, 100);
    const spread = ps[K.spread], opan = ps[K.pan];
    const syncSt = clamp(ps[K.sync] + (o === 0 ? m[DEST.A_SYNC] : m[DEST.B_SYNC]) * 48, 0, 72);
    const sync = syncSt > 0.05;
    const ratio = sync ? Math.pow(2, syncSt / 12) : 1;
    const baseInc = (440 * Math.pow(2, (pitch - 69) / 12)) / this.sr;
    const noRamp = fresh || !wasOn || v.nU[o] !== nU || v.sync[o] !== (sync ? 1 : 0);
    v.nU[o] = nU; v.sync[o] = sync ? 1 : 0;
    const ph = v.ph[o], inc = v.inc[o], dinc = v.dinc[o], minc = v.minc[o], gl = v.gl[o], gr = v.gr[o], uv = v.uvar[o], rat = v.rat[o];
    // Unison detune ratios and pan gains only change with their parameters: cache them.
    if (fresh || v.cDet[o] !== detune || v.cNU[o] !== nU || v.cSpr[o] !== spread || v.cPan[o] !== opan) {
      v.cDet[o] = detune; v.cNU[o] = nU; v.cSpr[o] = spread; v.cPan[o] = opan;
      const norm = 1 / Math.sqrt(nU);
      for (let u = 0; u < nU; u++) {
        const off = nU === 1 ? 0 : (2 * u) / (nU - 1) - 1;
        rat[u] = Math.pow(2, (off * detune + uv[u]) / 1200);
        const pan = nU === 1 ? opan : clamp(off * spread + opan, -1, 1);
        const a = ((pan + 1) * Math.PI) / 4;
        gl[u] = Math.cos(a) * Math.SQRT2 * norm; gr[u] = Math.sin(a) * Math.SQRT2 * norm;
      }
    }
    let maxInc = 0;
    for (let u = 0; u < nU; u++) {
      const mi = Math.min(0.45, baseInc * rat[u]);
      const si = sync ? Math.min(0.45, mi * ratio) : mi;
      if (noRamp) { inc[u] = si; dinc[u] = 0; if (sync) ph[u] = v.mph[o][u]; } else dinc[u] = (si - inc[u]) / CR;
      minc[u] = mi;
      if (si > maxInc) maxInc = si;
    }
    const mip = Math.ceil(Math.log2((1023 * maxInc) / 0.475));
    v.mip[o] = mip > 0 ? Math.min(T.mips - 1, mip) : 0;
    const posT = clamp(ps[K.pos] + (o === 0 ? m[DEST.A_POS] : m[DEST.B_POS]) + m[DEST.AB_POS], 0, 1);
    v.posT[o] = posT;
    const lvlT = clamp(ps[K.level] + (o === 0 ? m[DEST.A_LVL] : m[DEST.B_LVL]), 0, 1.5);
    if (noRamp) { v.pos[o] = posT; v.dpos[o] = 0; v.lvl[o] = lvlT; v.dlvl[o] = 0; }
    else { v.dpos[o] = (posT - v.pos[o]) / CR; v.dlvl[o] = (lvlT - v.lvl[o]) / CR; }
    v.pulse[o] = clamp(ps[K.pulse] + (o === 0 ? m[DEST.A_PULSE] : m[DEST.B_PULSE]), 0, 1);
    v.width[o] = ps[K.width];
  }

  // ---------- audio rate ----------
  voiceSamples(v, L, R, n0, n1) {
    const tL = this.tL, tR = this.tR;
    for (let i = n0; i < n1; i++) { tL[i] = 0; tR[i] = 0; }
    if (v.on[0]) this.oscRun(v, 0, n0, n1);
    if (v.on[1]) this.oscRun(v, 1, n0, n1);

    if (v.subLvl > 0 || v.dsub !== 0) {
      let ph = v.subPh, a = v.subLvl; const inc = v.subInc, da = v.dsub, shape = this.ps[X.subShape] | 0;
      for (let i = n0; i < n1; i++) {
        let s;
        if (shape === 0) s = Math.sin(TAU * ph);
        else if (shape === 1) s = 4 * Math.abs(ph - 0.5) - 1;
        else {
          s = ph < 0.5 ? 1 : -1;
          s += blep(ph, inc);
          let p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
          s -= blep(p2, inc);
        }
        s *= a * 0.9;
        tL[i] += s; tR[i] += s;
        ph += inc; if (ph >= 1) ph -= 1;
        a += da;
      }
      v.subPh = ph; v.subLvl = a;
    }
    if (v.nLvl > 0 || v.dn !== 0) {
      let x = v.rng, a = v.nLvl; const da = v.dn, pink = (this.ps[X.nColor] | 0) === 1, pk = v.pk;
      for (let i = n0; i < n1; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        let w = x / 2147483648;
        if (pink) {
          pk[0] = 0.99765 * pk[0] + w * 0.099046; pk[1] = 0.963 * pk[1] + w * 0.2965164; pk[2] = 0.57 * pk[2] + w * 1.0526913;
          w = (pk[0] + pk[1] + pk[2] + w * 0.1848) * 0.22;
        }
        w *= a * 0.5;
        tL[i] += w; tR[i] += w;
        a += da;
      }
      v.rng = x; v.nLvl = a;
    }

    this.filterRun(v, n0, n1);

    let a = v.amp; const da = v.damp, pl = v.pl, pr = v.pr;
    for (let i = n0; i < n1; i++) { L[i] += tL[i] * a * pl; R[i] += tR[i] * a * pr; a += da; }
    v.amp = a;
  }

  oscRun(v, o, n0, n1) {
    const T = this.tables[o];
    const data = T.data, N = T.size, row = N + 1, F = T.frames, M = T.mips, mip = v.mip[o];
    const tL = this.tL, tR = this.tR;
    const len = n1 - n0;
    const pos = v.pos[o], dpos = v.dpos[o], posEnd = pos + dpos * len;
    let f0 = 0, r0, r1, wf = 0, dwf = 0;
    if (F > 1) {
      const fp0 = pos * (F - 1), fp1 = posEnd * (F - 1);
      f0 = Math.floor(Math.min(fp0, fp1));
      if (f0 > F - 2) f0 = F - 2; if (f0 < 0) f0 = 0;
      wf = fp0 - f0; dwf = (fp1 - fp0) / len;
      r0 = (f0 * M + mip) * row; r1 = ((f0 + 1) * M + mip) * row;
    } else { r0 = mip * row; r1 = r0; }
    const lvl = v.lvl[o], dl = v.dlvl[o];
    const pulse = v.pulse[o], width = v.width[o];
    const norm = 1 / (1 + 0.4 * pulse);
    const nU = v.nU[o];
    const phA = v.ph[o], incA = v.inc[o], dincA = v.dinc[o];
    const sync = v.sync[o] === 1;
    for (let u = 0; u < nU; u++) {
      let ph = phA[u], inc = incA[u];
      const dinc = dincA[u];
      const gl = v.gl[o][u] * norm, gr = v.gr[o][u] * norm;
      let w = wf, a = lvl;
      if (!sync && r0 === r1 && pulse === 0) {
        // fast path: single-frame table, no pulse shaping (most patches)
        for (let i = n0; i < n1; i++) {
          const x = ph * N, ix = x | 0;
          const a0 = data[r0 + ix];
          const s = (a0 + (x - ix) * (data[r0 + ix + 1] - a0)) * a;
          tL[i] += s * gl; tR[i] += s * gr;
          ph += inc; if (ph >= 1) ph -= 1;
          inc += dinc; a += dl;
        }
      } else if (!sync) {
        for (let i = n0; i < n1; i++) {
          const ww = w < 0 ? 0 : w > 1 ? 1 : w;
          const x = ph * N, ix = x | 0, fr = x - ix;
          const a0 = data[r0 + ix], b0 = data[r1 + ix];
          const s0 = a0 + fr * (data[r0 + ix + 1] - a0);
          const s1 = b0 + fr * (data[r1 + ix + 1] - b0);
          let s = s0 + (s1 - s0) * ww;
          if (pulse > 0) {
            let p2 = ph + width; if (p2 >= 1) p2 -= 1;
            const x2 = p2 * N, j = x2 | 0, f2 = x2 - j;
            const c0 = data[r0 + j], d0 = data[r1 + j];
            const q0 = c0 + f2 * (data[r0 + j + 1] - c0), q1 = d0 + f2 * (data[r1 + j + 1] - d0);
            s -= pulse * (q0 + (q1 - q0) * ww);
          }
          s *= a;
          tL[i] += s * gl; tR[i] += s * gr;
          ph += inc; if (ph >= 1) ph -= 1;
          inc += dinc; w += dwf; a += dl;
        }
      } else {
        let mph = v.mph[o][u], prev = v.prev[o][u];
        const mi = v.minc[o][u];
        for (let i = n0; i < n1; i++) {
          const ww = w < 0 ? 0 : w > 1 ? 1 : w;
          ph += inc; mph += mi;
          let s;
          if (mph >= 1) {
            mph -= 1;
            const d = mi > 0 ? mph / mi : 0;
            let pr0 = ph - d * inc; pr0 -= Math.floor(pr0);
            const h = (rd(data, r0, r1, N, ww, 0, pulse, width) - rd(data, r0, r1, N, ww, pr0, pulse, width)) * a;
            ph = d * inc;
            s = rd(data, r0, r1, N, ww, ph, pulse, width) * a;
            prev += h * 0.5 * d * d;
            s += h * 0.5 * (2 * d - d * d - 1);
          } else {
            if (ph >= 1) ph -= 1;
            s = rd(data, r0, r1, N, ww, ph, pulse, width) * a;
          }
          tL[i] += prev * gl; tR[i] += prev * gr;
          prev = s;
          inc += dinc; w += dwf; a += dl;
        }
        v.mph[o][u] = mph; v.prev[o][u] = prev;
      }
      phA[u] = ph; incA[u] = inc;
    }
    v.pos[o] = posEnd;
    v.lvl[o] = lvl + dl * len;
  }

  filterRun(v, n0, n1) {
    const tL = this.tL, tR = this.tR, len = n1 - n0;
    if (v.useDrive) {
      let d = v.drv, c = v.comp, wt = v.wet; const dd = v.ddrv, dc = v.dcomp, dw = v.dwet;
      const aL = v.adL, aR = v.adR;
      for (let i = n0; i < n1; i++) {
        const xl = tL[i], xr = tR[i];
        tL[i] = xl + (aL.run(xl * d) * c - xl) * wt;
        tR[i] = xr + (aR.run(xr * d) * c - xr) * wt;
        d += dd; c += dc; wt += dw;
      }
      v.drv = d; v.comp = c; v.wet = wt < 0 ? 0 : wt > 1 ? 1 : wt;
    }
    const g = v.g, dg = v.dg, k = v.k, dk = v.dk, fs = v.fs;
    switch (this.fMode) {
      case 0: svf(tL, fs, 0, n0, n1, g, dg, k, dk, 0); svf(tR, fs, 8, n0, n1, g, dg, k, dk, 0); break;
      case 1:
        svf(tL, fs, 2, n0, n1, g, dg, 1.85, 0, 0); svf(tL, fs, 0, n0, n1, g, dg, k, dk, 0);
        svf(tR, fs, 10, n0, n1, g, dg, 1.85, 0, 0); svf(tR, fs, 8, n0, n1, g, dg, k, dk, 0);
        break;
      case 2: ladder(tL, fs, 4, n0, n1, g, dg, k, dk); ladder(tR, fs, 12, n0, n1, g, dg, k, dk); break;
      case 3: svf(tL, fs, 0, n0, n1, g, dg, k, dk, 1); svf(tR, fs, 8, n0, n1, g, dg, k, dk, 1); break;
      case 4: svf(tL, fs, 0, n0, n1, g, dg, k, dk, 2); svf(tR, fs, 8, n0, n1, g, dg, k, dk, 2); break;
      default: break;
    }
    v.g = g + dg * len; v.k = k + dk * len;
  }
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function rd(data, r0, r1, N, w, ph, pulse, width) {
  const x = ph * N, i = x | 0, f = x - i;
  const a0 = data[r0 + i], b0 = data[r1 + i];
  const s0 = a0 + f * (data[r0 + i + 1] - a0), s1 = b0 + f * (data[r1 + i + 1] - b0);
  let s = s0 + (s1 - s0) * w;
  if (pulse > 0) {
    let p2 = ph + width; if (p2 >= 1) p2 -= 1;
    const x2 = p2 * N, j = x2 | 0, f2 = x2 - j;
    const c0 = data[r0 + j], d0 = data[r1 + j];
    const q0 = c0 + f2 * (data[r0 + j + 1] - c0), q1 = d0 + f2 * (data[r1 + j + 1] - d0);
    s -= pulse * (q0 + (q1 - q0) * w);
  }
  return s;
}

// Topology-preserving state-variable filter (Simper). out: 0 LP, 1 HP, 2 BP (unity peak).
function svf(buf, st, off, n0, n1, g, dg, k, dk, out) {
  let ic1 = st[off], ic2 = st[off + 1];
  for (let i = n0; i < n1; i++) {
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const x = buf[i];
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    buf[i] = out === 0 ? v2 : out === 1 ? x - k * v1 - v2 : k * v1;
    g += dg; k += dk;
  }
  st[off] = ic1 + 1e-20; st[off + 1] = ic2;
}

// Zero-delay-feedback 4-pole ladder with a saturating input stage.
function ladder(buf, st, off, n0, n1, g, dg, k, dk) {
  let s1 = st[off], s2 = st[off + 1], s3 = st[off + 2], s4 = st[off + 3];
  for (let i = n0; i < n1; i++) {
    const G = g / (1 + g), G2 = G * G, G4 = G2 * G2, ig = 1 / (1 + g);
    const S = (G2 * G * s1 + G2 * s2 + G * s3 + s4) * ig;
    const x = buf[i] * (1 + k * 0.25);
    const y4 = (G4 * x + S) / (1 + k * G4);
    const u = fastTanh((x - k * y4) * 0.7) / 0.7;
    let t = (u - s1) * G; const y1 = t + s1; s1 = y1 + t;
    t = (y1 - s2) * G; const y2 = t + s2; s2 = y2 + t;
    t = (y2 - s3) * G; const y3 = t + s3; s3 = y3 + t;
    t = (y3 - s4) * G; const y = t + s4; s4 = y + t;
    buf[i] = y;
    g += dg; k += dk;
  }
  st[off] = s1 + 1e-20; st[off + 1] = s2; st[off + 2] = s3; st[off + 3] = s4;
}
