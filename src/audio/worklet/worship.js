// Worship Atmospheres: continuously sustaining pad synthesizer (audio thread).
//
// Paraphonic architecture, like classic string machines and pad synths:
// every note has its own oscillators and envelopes, but each layer is summed
// into a shared bus and filtered once. That keeps big sustained chords (and
// two chords overlapping during a key change) affordable, and lets filters,
// swells and EVOLVE move the whole atmosphere together.
//
//   per note:  Osc 1-4 (band-limited tables, unison, drift) -> bus F1 / F2 / dry
//              String ensemble voices (vibrato, octave doubling) -> strings bus
//              Bass foundation (root only)                       -> bass bus
//   shared:    Noise/air texture -> its bus
//              F1, F2: drive -> SVF / ladder;  strings: body EQ -> ensemble chorus
//              pad + strings (blend) -> low cut -> saturation -> chorus -> stereo
//              width/motion -> delay; reverb and shimmer as sends (tails survive
//              key and preset changes); + bass -> EQ -> trim -> safety limiter
//
// Live mode drives chords directly (setChord) with equal-power crossfades
// between voicings, held common tones, and a gate that fades the whole pad in
// and out ahead of the effects so reverb tails always ring out.
//
// Real-time rules: notes, buffers and effects are preallocated; render paths
// do not allocate. Control runs once per render quantum with per-sample ramps.

import { WORSHIP_PARAMS, WP_INDEX as I, WP_COUNT, PAD_MATRIX, PS, PD, W, VC, NOSC, voiceChord } from '../../shared/worship-params.js';
import { SYNC_DIVS, smoothKind } from '../../shared/params.js';
import { fft, WT_SIZE, WT_MIPS, mipHarmonics } from '../../shared/wavetable.js';
import { biquadCoefs, BQ } from '../../shared/dspmath.js';
import { createEffect, ADAA } from './effects.js';

const N = WT_SIZE, MIPS = WT_MIPS, ROW = N + 1;
const MAX_NOTES = 28, MAX_UNI = 7, MAX_STR = 8, BLOCK = 128;
const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fastTanh = (x) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
const st2r = (st) => Math.pow(2, st / 12);

// ---------------------------------------------------------------- basic band-limited tables
// Four frames (sine, triangle, saw, square) x octave mips, RMS-matched so
// changing waveform keeps the level. Built once per audio thread.
let BASIC = null;
export function basicTable() {
  if (BASIC) return BASIC;
  const F = 4, data = new Float32Array(F * MIPS * ROW);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < F; f++) {
    let scale = 1;
    for (let m = 0; m < MIPS; m++) {
      re.fill(0); im.fill(0);
      const H = mipHarmonics(m);
      for (let h = 1; h <= H && h < N / 2; h++) {
        let a = 0;
        if (f === 0) a = h === 1 ? 1 : 0;
        else if (f === 1) a = h % 2 ? (((h - 1) / 2) % 2 ? -1 : 1) / (h * h) : 0;
        else if (f === 2) a = 1 / h;
        else a = h % 2 ? 1 / h : 0;
        if (a) { im[h] = -a; im[N - h] = a; }
      }
      fft(re, im, true);
      if (m === 0) { let s = 0; for (let i = 0; i < N; i++) s += re[i] * re[i]; scale = 0.5 / Math.sqrt(s / N); }
      const base = (f * MIPS + m) * ROW;
      for (let i = 0; i < N; i++) data[base + i] = re[i] * scale;
      data[base + N] = data[base];
    }
  }
  let pk = 0;
  for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(data[(2 * MIPS) * ROW + i]));
  BASIC = { data, frames: F, mips: MIPS, size: N, sawPeak: pk };
  return BASIC;
}

// ---------------------------------------------------------------- string ensemble recipes
// voices per octave, detune (cents), octave layers, body high-pass, low-pass multiplier,
// two body resonances [Hz, dB, Q], vibrato / ensemble scaling, attack scaling,
// saw->square mix (string machines), bow noise.
const STRINGS = [
  { v: 3, det: 9, oct: [0], hp: 110, lp: 0.7, pk: [[320, 3, 1.1], [1500, 1.5, 1.2]], vib: 1, ens: 1, atk: 1, mix: 0, bow: 0.02 },
  { v: 3, det: 7, oct: [12], hp: 320, lp: 1.1, pk: [[600, 2, 1.2], [2900, 3, 1.4]], vib: 1.2, ens: 0.8, atk: 1, mix: 0, bow: 0.03 },
  { v: 3, det: 10, oct: [0, -12], hp: 60, lp: 0.95, pk: [[250, 2.5, 1], [2100, 2, 1.2]], vib: 1, ens: 1, atk: 1.2, mix: 0, bow: 0.025 },
  { v: 4, det: 14, oct: [0, 12], hp: 120, lp: 0.9, pk: [[400, 1.5, 0.9], [2500, 1.5, 1]], vib: 0.8, ens: 1.4, atk: 1, mix: 0.08, bow: 0.01 },
  { v: 3, det: 6, oct: [0], hp: 140, lp: 0.45, pk: [[350, 2, 0.9], [1200, 1, 1]], vib: 0.5, ens: 1.2, atk: 1.6, mix: 0, bow: 0 },
  { v: 3, det: 8, oct: [0], hp: 110, lp: 0.75, pk: [[300, 2.5, 1], [1800, 2, 1.2]], vib: 0.9, ens: 1, atk: 2.5, mix: 0, bow: 0.02 },
  { v: 2, det: 5, oct: [0], hp: 160, lp: 1.0, pk: [[450, 3.5, 1.4], [2700, 3.5, 1.5]], vib: 1.4, ens: 0.5, atk: 0.8, mix: 0, bow: 0.04 },
  { v: 3, det: 7, oct: [-12], hp: 45, lp: 0.5, pk: [[180, 3, 1.1], [850, 2, 1.2]], vib: 1.1, ens: 0.8, atk: 1.1, mix: 0, bow: 0.03 },
  { v: 3, det: 8, oct: [12], hp: 500, lp: 1.4, pk: [[1000, 1, 1], [3400, 3, 1.5]], vib: 1.2, ens: 0.9, atk: 1, mix: 0, bow: 0.03 },
  { v: 1, det: 0, oct: [0, 12], hp: 150, lp: 0.8, pk: [[700, 2, 0.8], [2400, 1, 1]], vib: 0, ens: 2, atk: 0.7, mix: 0.35, bow: 0 },
];

// ---------------------------------------------------------------- parameter index groups
const OSC = Array.from({ length: NOSC }, (_, s) => {
  const o = {};
  for (const k of ['on', 'wave', 'morph', 'pw', 'level', 'oct', 'semi', 'fine', 'uni', 'detune', 'spread', 'drift', 'pan', 'route']) o[k] = I[`o${s + 1}.${k}`];
  return o;
});
const FLT = [1, 2].map((n) => ({ type: I[`f${n}.type`], cut: I[`f${n}.cut`], res: I[`f${n}.res`], drive: I[`f${n}.drive`], key: I[`f${n}.key`], swell: I[`f${n}.swell`] }));
const LFO = [1, 2].map((n) => ({ shape: I[`l${n}.shape`], rate: I[`l${n}.rate`], sync: I[`l${n}.sync`], div: I[`l${n}.div`] }));
const MAT = Array.from({ length: PAD_MATRIX }, (_, s) => ({ src: I[`m${s}.src`], dst: I[`m${s}.dst`], amt: I[`m${s}.amt`] }));
const NDST = 24;

class Note {
  constructor(id) {
    this.id = id;
    this.active = false; this.age = 0;
    this.pitch = 60; this.vel = 0.8; this.velG = 1; this.key = -1; this.group = -1; this.live = false;
    this.pad = true; this.str = true; this.bass = false;
    this.es = 0; this.ev = 0; this.ss = 0; this.sv = 0; this.at = 0; // pad env stage/value, strings env stage/value, attack progress
    this.sat = 0;
    this.fade = 1; this.fadeDir = 0; this.fadeStep = 0;   // live crossfade (equal power)
    this.norm = 0.5; this.normT = 0.5;
    this.held = false;
    const k = NOSC * MAX_UNI;
    this.ph = new Float64Array(k); this.incS = new Float64Array(k); this.incT = new Float64Array(k);
    this.gl = new Float64Array(k); this.gr = new Float64Array(k); this.urnd = new Float64Array(k);
    this.ampS = new Float64Array(NOSC); this.ampT = new Float64Array(NOSC); this.mip = new Int32Array(NOSC); this.nU = new Int32Array(NOSC);
    this.drift = new Float64Array(NOSC); this.driftT = new Float64Array(NOSC); this.driftN = new Int32Array(NOSC);
    this.sph = new Float64Array(MAX_STR); this.sincS = new Float64Array(MAX_STR); this.sincT = new Float64Array(MAX_STR);
    this.sgl = new Float64Array(MAX_STR); this.sgr = new Float64Array(MAX_STR); this.srnd = new Float64Array(MAX_STR);
    this.sAmpS = 0; this.sAmpT = 0; this.sMip = 0; this.nS = 0;
    this.vibPh = 0; this.vibRate = 5.2; this.vibOn = 0;
    this.brA = 0; this.brB = 0; this.brT = 0; this.brLen = 1; this.brK = 1; this.brG = 1; // breathe wander
    this.bph = 0; this.bincS = 0; this.bincT = 0; this.bAmpS = 0; this.bAmpT = 0;
    this.padG = 0; this.strG = 0;
  }
}

// Smooth random generator for EVOLVE and the random LFO shapes: cosine
// interpolation between random targets at irregular intervals.
class Wander {
  constructor(seed) { this.rng = seed | 0 || 1; this.a = 0; this.b = this.r(); this.t = 0; this.len = 1; this.v = 0; }
  r() { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x; return ((x >>> 0) / 4294967296) * 2 - 1; }
  step(dt, rate) {
    this.t += dt * rate / this.len;
    if (this.t >= 1) { this.t -= Math.floor(this.t); this.a = this.b; this.b = this.r(); this.len = 0.6 + ((this.r() + 1) * 0.5); }
    const s = 0.5 - 0.5 * Math.cos(Math.PI * this.t);
    this.v = this.a + (this.b - this.a) * s;
    return this.v;
  }
}

export class PadEngine {
  constructor(sr) {
    this.sr = sr;
    this.basic = basicTable();
    this.tables = [null, null, null, null];
    const NP = WP_COUNT;
    this.p = new Float64Array(NP); this.ps = new Float64Array(NP); this.manual = new Float64Array(NP);
    this.auto = new Uint8Array(NP); this.sk = new Int8Array(NP);
    for (let i = 0; i < NP; i++) { const d = WORSHIP_PARAMS[i]; this.p[i] = this.ps[i] = this.manual[i] = d.def; this.sk[i] = smoothKind(d); }
    this.notes = Array.from({ length: MAX_NOTES }, (_, i) => new Note(i));
    this.age = 0;
    this.rng = 0x1234567 ^ Math.floor(Math.random() * 1e9);
    // buses: F1, F2, dry (stereo), strings (stereo), bass (mono), noise (stereo, routed)
    const B = () => new Float32Array(BLOCK);
    this.bL = [B(), B(), B()]; this.bR = [B(), B(), B()];
    this.sL = B(); this.sR = B(); this.bass = B();
    this.rvL = B(); this.rvR = B(); this.shL = B(); this.shR = B();
    this.n = BLOCK;
    // per-slot block values
    this.pos0 = new Float64Array(NOSC); this.pos1 = new Float64Array(NOSC); this.posInit = new Uint8Array(NOSC);
    this.pw0 = new Float64Array(NOSC); this.pw1 = new Float64Array(NOSC);
    this.mode = new Int8Array(NOSC); this.tab = [null, null, null, null]; this.fbase = new Int32Array(NOSC); this.lvl = new Float64Array(NOSC);
    this.route = new Int8Array(NOSC); this.slotOn = new Uint8Array(NOSC); this.pgain = new Float64Array(NOSC);
    // filters
    this.fs = [new Float64Array(16), new Float64Array(16)];
    this.fg = new Float64Array(2); this.fk = new Float64Array(2); this.fInit = new Uint8Array(2);
    this.adL = [new ADAA(), new ADAA()]; this.adR = [new ADAA(), new ADAA()];
    for (const a of [...this.adL, ...this.adR]) { a.type = 4; a.reset(); }
    this.hp = new Float64Array(8); this.hpG = -1;
    // strings body
    this.sHp = new Float64Array(8); this.sLp = new Float64Array(16); this.sG = -1; this.sLg = -1;
    this.pkC = [new Float64Array(5), new Float64Array(5)]; this.pkZ = new Float64Array(8); this.pkKey = '';
    this.ensLen = Math.ceil(sr * 0.05) + 4; this.ensBuf = new Float32Array(this.ensLen); this.ensW = 0; this.ensPh = 0; this.ensPh2 = 0;
    // bass
    this.bLp = new Float64Array(4);
    // noise
    this.nRng = 0x51ed27; this.nRngR = 0x2b1f93; this.nState = new Float64Array(16); this.nLvl = 0;
    // modulation
    this.lfoPh = new Float64Array(2); this.lfoVal = new Float64Array(2);
    this.lfoW = [new Wander(0x9e3779b1), new Wander(0x85ebca6b)];
    this.ev = Array.from({ length: 6 }, (_, i) => new Wander(0x27d4eb2f + i * 7919));
    this.evSlow = Array.from({ length: 6 }, (_, i) => new Wander(0x165667b1 + i * 104729));
    this.evv = new Float64Array(6);
    this.mod = new Float64Array(NDST);
    this.autoPh = 0.25; this.swell = 0; this.autoS = 0; this.mSwell = 0; this.mSwellT = -1; this.stereo = 0;
    this.trans = 0; this.transT = -1; this.transLen = 1;
    this.presence = 0; this.center = 60; this.mw = 0; this.avgVel = 0.8;
    // stereo
    this.motionPh = 0; this.width = 1;
    // effects
    this.sat = createEffect('distortion', sr); this.satOn = 0;
    this.cho = createEffect('chorus', sr);
    this.dly = createEffect('delay', sr);
    this.rev = createEffect('reverb', sr);
    this.shRev = createEffect('reverb', sr);
    this.eq = createEffect('eq', sr);
    this.lim = createEffect('limiter', sr);
    this.initFx();
    // shimmer pitch shifter (octave up) in the shimmer feedback loop
    this.psLen = Math.ceil(sr * 0.12) + 4; this.psL = new Float32Array(this.psLen); this.psR = new Float32Array(this.psLen);
    this.psW = 0; this.psPh = 0; this.psD = Math.round(sr * 0.06); this.shLp = new Float64Array(4);
    this.shPrevL = new Float32Array(BLOCK); this.shPrevR = new Float32Array(BLOCK); this.shTL = new Float32Array(BLOCK); this.shTR = new Float32Array(BLOCK);
    // gate (live fade in/out, preset crossfades): equal-power, applied before the effects
    this.gate = 1; this.gateDir = 0; this.gateStep = 0; this.gateOff = false;
    this.outG = -1;
    this.chordDirty = true; this.chordCache = new Array(12); this.custom = null; this.customKey = '';
    this.heldKeys = new Uint8Array(128); this.heldCount = 0;
    this.tele = new Float64Array(31); this.pk = new Float64Array(8);
    this.lowPitch = -1; this.brP = new Float64Array(MAX_NOTES); this.brV = new Float64Array(MAX_NOTES);
    this.tempo = 120; this.beat = 0; this.playing = false;
    this.silentFor = 0;
  }

  initFx() {
    const set = (fx, id, v) => fx.setParam(fx.i[id], v);
    set(this.sat, 'type', 3); set(this.sat, 'mix', 1);
    set(this.cho, 'delay', 9); set(this.cho, 'fb', 0.08); set(this.cho, 'width', 1);
    set(this.dly, 'pp', 1);
    set(this.rev, 'mix', 1); set(this.rev, 'width', 1);
    set(this.shRev, 'mix', 1); set(this.shRev, 'width', 1); set(this.shRev, 'size', 0.95); set(this.shRev, 'pre', 20);
    set(this.eq, 'lf', 220); set(this.eq, 'm1q', 0.8); set(this.eq, 'm2g', 0); set(this.eq, 'hf', 6500);
    set(this.lim, 'ceil', -1); set(this.lim, 'rel', 250);
  }

  rand() { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x; return (x >>> 0) / 4294967296; }

  // ---------- parameters (same interface as SawForge) ----------
  applyParam(i, v) {
    this.p[i] = v;
    if (this.sk[i] === 0) this.ps[i] = v;
    if (i === I['vc.type'] || i === I['vc.reg'] || i === I['vc.density'] || i === I['vc.spread'] || i === I['play.minor']) this.chordDirty = true;
  }
  setParam(i, v) { this.manual[i] = v; if (!this.auto[i]) this.applyParam(i, v); }
  setAuto(i, v) { this.auto[i] = 1; if (this.p[i] !== v) this.applyParam(i, v); }
  setManualAll(arr, snap) {
    for (let i = 0; i < WP_COUNT && i < arr.length; i++) {
      this.manual[i] = arr[i];
      if (!this.auto[i] && this.p[i] !== arr[i]) this.applyParam(i, arr[i]);
    }
    if (snap) this.snap();
  }
  setAutomated(flags) {
    for (let i = 0; i < WP_COUNT; i++) {
      const was = this.auto[i];
      this.auto[i] = flags[i] || 0;
      if (was && !this.auto[i]) this.applyParam(i, this.manual[i]);
    }
  }
  snap() { for (let i = 0; i < WP_COUNT; i++) this.ps[i] = this.p[i]; this.outG = -1; }
  setTable(osc, t) { if (osc >= 0 && osc < NOSC) this.tables[osc] = t; }

  // ---------- notes ----------
  alloc() {
    let free = null;
    for (const v of this.notes) if (!v.active) { free = v; break; }
    if (!free) { // steal the quietest
      let best = null, bv = Infinity;
      for (const v of this.notes) { const g = v.padG + v.strG; if (g < bv) { bv = g; best = v; } }
      free = best;
    }
    return free;
  }
  startNote(v, pitch, vel, { live = false, fadeIn = 0, skipAttack = false, key = -1, group = -1, pad = true, str = true, bass = false, norm = 0.5 } = {}) {
    const ps = this.ps;
    v.active = true; v.age = ++this.age; v.pitch = pitch; v.vel = vel; v.velG = 0.65 + 0.35 * vel;
    v.key = key; v.group = group; v.live = live; v.pad = pad; v.str = str; v.bass = bass; v.held = true;
    v.norm = norm; v.normT = norm;
    if (skipAttack) { v.es = 3; v.ev = ps[I['sw.sustain']]; v.ss = 3; v.sv = ps[I['str.sustain']]; }
    else { v.es = 1; v.ev = 0; v.at = 0; v.ss = 1; v.sv = 0; v.sat = 0; }
    if (fadeIn > 0) { v.fade = 0; v.fadeDir = 1; v.fadeStep = 1 / (fadeIn * this.sr); } else { v.fade = 1; v.fadeDir = 0; }
    for (let k = 0; k < NOSC * MAX_UNI; k++) { v.ph[k] = this.rand(); v.urnd[k] = (this.rand() * 2 - 1); v.incS[k] = 0; v.incT[k] = 0; }
    for (let s = 0; s < NOSC; s++) { v.ampS[s] = 0; v.ampT[s] = 0; v.drift[s] = (this.rand() * 2 - 1) * 0.5; v.driftT[s] = v.drift[s]; v.driftN[s] = 0; v.nU[s] = 0; }
    for (let k = 0; k < MAX_STR; k++) { v.sph[k] = this.rand(); v.srnd[k] = this.rand() * 2 - 1; v.sincS[k] = 0; v.sincT[k] = 0; }
    v.sAmpS = v.sAmpT = 0; v.nS = 0;
    v.vibPh = this.rand(); v.vibRate = 4.8 + this.rand() * 0.9; v.vibOn = 0;
    // each note breathes on its own clock: random start point, targets and speed
    v.brA = this.brDraw(); v.brB = this.brDraw(); v.brT = this.rand(); v.brLen = 0.6 + this.rand(); v.brK = 0.7 + this.rand() * 0.6; v.brG = 1;
    v.bph = 0; v.bincS = v.bincT = 0; v.bAmpS = v.bAmpT = 0;
    v.padG = 0; v.strG = 0;
    this.ctrlNote(v, true);
  }
  release(v) { v.held = false; if (v.es !== 0) v.es = 4; if (v.ss !== 0) v.ss = 4; }
  fadeOut(v, sec) { v.held = false; v.fadeDir = -1; v.fadeStep = 1 / (Math.max(0.01, sec) * this.sr); }

  noteOn(note, vel) {
    const ps = this.ps;
    if (ps[I['play.hold']] >= 0.5 && this.heldCount === 0) { for (const v of this.notes) if (v.active && !v.live) this.release(v); }
    if (!this.heldKeys[note]) { this.heldKeys[note] = 1; this.heldCount++; }
    const bassOn = ps[I['bass.on']] >= 0.5;
    if ((ps[I['play.mode']] | 0) === 1) {
      const chord = this.chordFor(note);
      const norm = 1 / Math.sqrt(Math.max(2, chord.notes.length));
      for (const pitch of chord.notes) this.startNote(this.alloc(), pitch, vel, { key: note, group: note, norm });
      if (bassOn) this.startNote(this.alloc(), chord.root, vel, { key: note, group: note, pad: false, str: false, bass: true, norm: 1 });
      return;
    }
    const poly = clamp(ps[I['play.poly']] | 0, 2, 16);
    let count = 0, oldest = null;
    for (const v of this.notes) if (v.active && !v.live && v.pad && v.es !== 4) { count++; if (!oldest || v.age < oldest.age) oldest = v; }
    if (count >= poly && oldest) this.fadeOut(oldest, 0.08);
    let low = true;
    for (const v of this.notes) if (v.active && !v.live && v.pad && v.held && v.pitch < note) { low = false; break; }
    this.startNote(this.alloc(), note, vel, { key: note, norm: 0.42 });
    if (bassOn && low) {
      for (const v of this.notes) if (v.active && !v.live && v.bass) this.fadeOut(v, 0.3);
      this.startNote(this.alloc(), note, vel, { key: note, pad: false, str: false, bass: true, norm: 1 });
    }
  }
  noteOff(note) {
    if (this.heldKeys[note]) { this.heldKeys[note] = 0; this.heldCount--; }
    if (this.ps[I['play.hold']] >= 0.5) return; // infinite sustain: released by the next chord
    for (const v of this.notes) if (v.active && !v.live && v.key === note && v.held) this.release(v);
  }
  // Next breathe target (0 = fully in … 1 = deepest dip). With Balance up, targets
  // gather at the extremes, so notes clearly leave and return (gliding between),
  // and lean toward "away" the further Balance goes. At 0 they wander evenly.
  brDraw() {
    const b = this.ps[I['br.bias']];
    if (b > 0 && this.rand() < b) return this.rand() < 0.35 + 0.45 * b ? 0.92 + 0.08 * this.rand() : 0.08 * this.rand();
    return this.rand();
  }
  // Custom voicing intervals (semitones above the root) for "Chord from root" on tracks.
  setCustom(arr) {
    const key = arr && arr.length ? arr.join(',') : '';
    if (key === this.customKey) return;
    this.customKey = key; this.custom = key ? arr.slice() : null; this.chordDirty = true;
  }
  chordFor(root) {
    if (this.chordDirty) { this.chordCache.fill(undefined); this.chordDirty = false; }
    const pc = root % 12, oct = Math.floor(root / 12);
    let c = this.chordCache[pc];
    if (!c) {
      const ps = this.ps;
      const type = ps[I['vc.type']] | 0;
      c = voiceChord({ root: pc, minor: ps[I['play.minor']] >= 0.5, type, register: ps[I['vc.reg']] | 0, density: ps[I['vc.density']], spread: ps[I['vc.spread']],
        custom: type === VC.CUSTOM ? this.custom : null });
      this.chordCache[pc] = c;
    }
    // keep the voicing's register but follow the octave played (±1)
    const shift = clamp(Math.round((root - c.root) / 12), -1, 1) * 12;
    return { root: c.root + shift, notes: c.notes.map((n) => n + shift) };
  }
  pitchBend() {}
  modWheel(v) { this.mw = clamp(v, 0, 1); }
  allNotesOff(hard) {
    this.heldKeys.fill(0); this.heldCount = 0;
    for (const v of this.notes) { if (!v.active) continue; if (hard) v.active = false; else this.release(v); }
    if (hard) this.resetFx();
  }
  resetFx() {
    for (const fx of [this.sat, this.cho, this.dly, this.rev, this.shRev, this.eq, this.lim]) fx.reset();
    this.psL.fill(0); this.psR.fill(0); this.shPrevL.fill(0); this.shPrevR.fill(0); this.shLp.fill(0); this.ensBuf.fill(0);
    for (const f of this.fs) f.fill(0);
    this.hp.fill(0); this.sHp.fill(0); this.sLp.fill(0); this.pkZ.fill(0); this.nState.fill(0); this.bLp.fill(0);
  }
  isActive() { for (const v of this.notes) if (v.active) return true; return false; }

  // ---------- live chords ----------
  // Move to a new chord: common tones are held (voice leading), the rest
  // crossfade with equal-power curves over the given times.
  setChord(pitches, bassPitch, { fadeIn = 3, fadeOut = 3, voiceLead = true, fromSilence = false, trans = 0, vel = 0.8 } = {}) {
    const ps = this.ps, norm = 1 / Math.sqrt(Math.max(2, pitches.length));
    const kept = new Set();
    for (const v of this.notes) {
      if (!v.active || !v.live || v.fadeDir < 0 || !v.held) continue;
      if (v.bass) {
        if (bassPitch != null && ps[I['bass.on']] >= 0.5 && v.pitch === bassPitch && voiceLead) { kept.add('b'); continue; }
        this.fadeOut(v, fadeOut); continue;
      }
      if (voiceLead && pitches.includes(v.pitch) && !kept.has(v.pitch)) { kept.add(v.pitch); v.normT = norm; continue; }
      this.fadeOut(v, fadeOut);
    }
    const opts = { live: true, fadeIn: fromSilence ? 0 : fadeIn, skipAttack: !fromSilence, norm, vel };
    for (const pitch of pitches) if (!kept.has(pitch)) this.startNote(this.alloc(), pitch, vel, opts);
    if (bassPitch != null && !kept.has('b')) this.startNote(this.alloc(), bassPitch, vel, { ...opts, pad: false, str: false, bass: true, norm: 1 });
    if (trans > 0) { this.transT = 0; this.transLen = trans; }
  }
  stopLive(sec) { for (const v of this.notes) if (v.active && v.live && v.fadeDir >= 0) this.fadeOut(v, sec); }
  setGate(on, sec) {
    this.gateDir = on ? 1 : -1;
    this.gateStep = 1 / (Math.max(0.01, sec) * this.sr);
    this.gateOff = false;
  }
  triggerSwell() { this.mSwellT = 0; }
  killLive() { for (const v of this.notes) if (v.live) v.active = false; }

  // ---------- block ----------
  beginBlock(tempo, beat, playing, n) {
    this.tempo = tempo; this.beat = beat; this.playing = playing; this.n = n;
    const p = this.p, ps = this.ps, sk = this.sk;
    for (let i = 0; i < WP_COUNT; i++) {
      const k = sk[i];
      if (k === 0) continue;
      const t = p[i], c = ps[i];
      if (t === c) continue;
      if (k === 2 && c > 0 && t > 0) { const r = t / c; ps[i] = Math.abs(r - 1) < 1e-4 ? t : c * Math.pow(r, 0.25); }
      else { const d = t - c; ps[i] = Math.abs(d) < 1e-6 * (Math.abs(t) + 1e-3) ? t : c + d * 0.25; }
    }
    for (let b = 0; b < 3; b++) { this.bL[b].fill(0, 0, n); this.bR[b].fill(0, 0, n); }
    this.sL.fill(0, 0, n); this.sR.fill(0, 0, n); this.bass.fill(0, 0, n);
    this.ctrlGlobal(n);
    for (const v of this.notes) if (v.active) this.ctrlNote(v, false);
  }

  ctrlGlobal(n) {
    const ps = this.ps, sr = this.sr, dt = n / sr, mod = this.mod;
    // LFOs
    for (let l = 0; l < 2; l++) {
      const L = LFO[l], shape = ps[L.shape] | 0;
      const rate = ps[L.sync] >= 0.5 ? this.tempo / 60 / SYNC_DIVS[ps[L.div] | 0].beats : ps[L.rate];
      this.lfoPh[l] += rate * dt; this.lfoPh[l] -= Math.floor(this.lfoPh[l]);
      const ph = this.lfoPh[l];
      this.lfoVal[l] = shape === 0 ? Math.sin(TAU * ph) : shape === 1 ? 1 - 4 * Math.abs(ph - 0.5) : shape === 2 ? this.lfoW[l].step(dt, rate) : this.lfoW[l].step(dt, rate * 0.37) * 0.7 + Math.sin(TAU * ph) * 0.3;
    }
    // EVOLVE: two layers of smooth random motion per destination (1/f-like, never a loop)
    const er = ps[I['ev.rate']], ea = ps[I['ev.amount']];
    for (let e = 0; e < 6; e++) this.evv[e] = ea > 0 ? (this.ev[e].step(dt, er) * 0.65 + this.evSlow[e].step(dt, er * 0.29) * 0.35) * ea : 0;
    // swell: auto (repeated) and manual one-shot
    const per = ps[I['sw.period']], curve = ps[I['sw.curve']];
    let autoS = 0;
    if (ps[I['sw.auto']] >= 0.5) {
      this.autoPh += dt / per; this.autoPh -= Math.floor(this.autoPh);
      autoS = 0.5 - 0.5 * Math.cos(TAU * this.autoPh);
      autoS = Math.pow(autoS, Math.pow(2, curve));
    }
    let man = 0;
    if (this.mSwellT >= 0) {
      this.mSwellT += dt;
      const up = Math.max(1.5, per * 0.4), down = Math.max(2, per * 0.6);
      if (this.mSwellT < up) man = 0.5 - 0.5 * Math.cos(Math.PI * this.mSwellT / up);
      else if (this.mSwellT < up + down) man = 0.5 + 0.5 * Math.cos(Math.PI * (this.mSwellT - up) / down);
      else this.mSwellT = -1;
    }
    this.mSwell = man;
    this.swell = clamp(Math.max(autoS, man), 0, 1);
    this.autoS = autoS;
    // transition wash (slow atmospheric key changes)
    let tr = 0;
    if (this.transT >= 0) {
      this.transT += dt;
      if (this.transT >= this.transLen) this.transT = -1; else tr = Math.sin(Math.PI * this.transT / this.transLen);
    }
    this.trans = tr;
    // presence and chord centre (paraphonic key tracking)
    let pres = 0, sum = 0, cnt = 0, vel = 0;
    for (const v of this.notes) if (v.active && v.pad) { const g = v.ev * (v.fadeDir === 0 && v.fade >= 1 ? 1 : Math.sin(HALF_PI * v.fade)); if (g > pres) pres = g; sum += v.pitch * g; cnt += g; vel += v.vel * g; }
    this.presence += (pres - this.presence) * 0.05;
    let low = 1e9;
    for (const v of this.notes) if (v.active && v.pad && v.fadeDir >= 0 && v.es !== 4 && v.pitch < low) low = v.pitch;
    this.lowPitch = low < 1e9 ? low : -1;
    if (cnt > 1e-3) { this.center += (sum / cnt - this.center) * 0.05; this.avgVel = vel / cnt; }
    // matrix
    mod.fill(0);
    const src = (si) => (si === PS.LFO1 ? this.lfoVal[0] : si === PS.LFO2 ? this.lfoVal[1] : si === PS.EVOLVE ? this.evv[0] : si === PS.SWELL ? this.swell : si === PS.MW ? this.mw : si === PS.VEL ? this.avgVel : 0);
    for (let s = 0; s < PAD_MATRIX; s++) {
      const si = ps[MAT[s].src] | 0, di = ps[MAT[s].dst] | 0, a = ps[MAT[s].amt];
      if (si > 0 && di > 0 && a !== 0) mod[di] += src(si) * a;
    }
    // oscillator slots
    const B = this.basic;
    for (let s = 0; s < NOSC; s++) {
      const K = OSC[s];
      this.slotOn[s] = ps[K.on] >= 0.5 ? 1 : 0;
      if (!this.slotOn[s]) continue;
      const wave = ps[K.wave] | 0;
      let tab = B, mode = 0, fbase = 0, pos = 0;
      const morph = clamp(ps[K.morph] + mod[PD.MORPH] + mod[PD.M1 + s] + this.evv[s % 2 === 0 ? 0 : 1] * ps[I['ev.morph']] * 0.35, 0, 1);
      if (wave === W.MORPH) { mode = 1; pos = morph * 3; }
      else if (wave === W.WT) {
        const T = this.tables[s];
        if (T) { tab = T; if (T.frames > 1) { mode = 1; pos = morph * (T.frames - 1); } }
        else { fbase = 2; }
      } else if (wave === W.PULSE) { mode = 2; fbase = 2; }
      else fbase = wave === W.SINE ? 0 : wave === W.TRI ? 1 : wave === W.SAW ? 2 : 3;
      if (this.tab[s] !== tab || this.mode[s] !== mode || !this.posInit[s]) { this.pos0[s] = pos; this.posInit[s] = 1; } else this.pos0[s] = this.pos1[s];
      this.pos1[s] = pos;
      this.tab[s] = tab; this.mode[s] = mode; this.fbase[s] = fbase;
      const pw = clamp(ps[K.pw], 0.05, 0.95);
      this.pw0[s] = this.pw1[s]; this.pw1[s] = pw; if (!this.pw0[s]) this.pw0[s] = pw;
      this.pgain[s] = mode === 2 ? 0.5 / (2 * B.sawPeak * Math.sqrt(pw * (1 - pw))) : 1;
      this.lvl[s] = clamp(ps[K.level] + mod[PD.L1 + s], 0, 1.5);
      this.route[s] = ps[K.route] | 0;
    }
  }

  // Per-note control: envelopes, crossfade, oscillator increments and levels.
  ctrlNote(v, fresh) {
    const ps = this.ps, sr = this.sr, n = this.n, dt = n / sr, mod = this.mod;
    if (!fresh) {
      // envelopes
      const A = ps[I['sw.attack']], D = ps[I['sw.decay']], S = ps[I['sw.sustain']], R = ps[I['sw.release']], cv = ps[I['sw.curve']];
      switch (v.es) {
        case 1: v.at += dt / A; if (v.at >= 1) { v.at = 1; v.es = 2; } v.ev = Math.pow(v.at, Math.pow(3, cv)); break;
        case 2: v.ev += (S - v.ev) * (1 - Math.exp((-4.6 * dt) / D)); if (Math.abs(v.ev - S) < 1e-3) v.es = 3; break;
        case 3: v.ev += (S - v.ev) * 0.02; break;
        case 4: v.ev *= Math.exp((-4.6 * dt) / R); if (v.ev < 1e-4) { v.ev = 0; v.es = 0; } break;
        default: v.ev = 0;
      }
      const ty = STRINGS[ps[I['str.type']] | 0] || STRINGS[0];
      const sA = ps[I['str.attack']] * ty.atk, sR = ps[I['str.release']], sS = ps[I['str.sustain']];
      switch (v.ss) {
        case 1: v.sat += dt / sA; if (v.sat >= 1) { v.sat = 1; v.ss = 3; } v.sv = Math.pow(v.sat, 1.6); break;
        case 3: v.sv += (sS - v.sv) * (1 - Math.exp((-4.6 * dt) / Math.max(0.5, sA))); break;
        case 4: v.sv *= Math.exp((-4.6 * dt) / sR); if (v.sv < 1e-4) { v.sv = 0; v.ss = 0; } break;
        default: v.sv = 0;
      }
      if (v.fadeDir !== 0) {
        v.fade += v.fadeDir * v.fadeStep * n;
        if (v.fade >= 1) { v.fade = 1; v.fadeDir = 0; }
        else if (v.fade <= 0) { v.fade = 0; v.fadeDir = 0; v.active = false; }
      }
      v.norm += (v.normT - v.norm) * 0.03;
      if (v.es === 0 && v.ss === 0) v.active = false;
      if (!v.active) { v.padG = v.strG = 0; return; }
    }
    const fg = Math.sin(HALF_PI * v.fade);
    // BREATHE: a slow wander per note between full level and the floor (smoothed, never silent)
    const ba = ps[I['br.amount']];
    let brTarget = 1, makeup = 1;
    if (ba > 0.001 && v.pad) {
      if (!fresh) {
        v.brT += (dt * ps[I['br.rate']] * v.brK) / v.brLen;
        if (v.brT >= 1) { v.brT -= Math.floor(v.brT); v.brA = v.brB; v.brB = this.brDraw(); v.brLen = 0.6 + this.rand(); }
      }
      const s = v.brA + (v.brB - v.brA) * (0.5 - 0.5 * Math.cos(Math.PI * v.brT));
      const c = ba * (1 - ps[I['br.floor']]);
      let lowest = v.pitch === this.lowPitch;
      if (fresh) { // a brand-new note: compare against what is sounding now, not last block's lowest
        lowest = true;
        for (const o of this.notes) if (o !== v && o.active && o.pad && o.fadeDir >= 0 && o.es !== 4 && o.pitch < v.pitch) { lowest = false; break; }
      }
      if (ps[I['br.root']] >= 0.5 && lowest) brTarget = 1;
      else {
        // Balance shapes the motion: 0 mostly present (dips out now and then) … 1 mostly away (drifts in now and then)
        const k = Math.pow(2, 1 - 2 * ps[I['br.bias']]);
        brTarget = 1 - c * Math.pow(s, k);
        // keep the average power where it was, but never boost a note by more than +2 dB when it comes in
        makeup = Math.min(1.25, 1 / Math.sqrt(Math.max(0.2, 1 - (2 * c) / (k + 1) + (c * c) / (2 * k + 1))));
      }
    }
    v.brG = fresh ? brTarget * makeup : v.brG + (brTarget * makeup - v.brG) * (1 - Math.exp(-dt / 0.3));
    v.padG = v.ev * fg * v.norm * v.velG * v.brG;
    v.strG = v.sv * fg * v.norm * v.velG * v.brG;
    const drift0 = this.evv[3] * ps[I['ev.detune']];
    // ----- oscillator slots
    if (v.pad) {
      const sw = 1 + this.mSwell * 0.5 * ps[I['sw.intensity']];
      const autoAmp = 1 - ps[I['sw.depth']] * (1 - this.autoS) * (ps[I['sw.auto']] >= 0.5 ? 1 : 0);
      const lvlMod = clamp(1 + mod[PD.PAD] + this.evv[1] * ps[I['ev.amp']] * 0.3, 0, 2) * sw * autoAmp;
      for (let s = 0; s < NOSC; s++) {
        const K = OSC[s];
        if (!this.slotOn[s]) { v.ampS[s] = v.ampT[s] = 0; continue; }
        // analog drift: slow random wander per note and slot
        if (--v.driftN[s] <= 0) { v.driftT[s] = this.rand() * 2 - 1; v.driftN[s] = ((sr / n) * (0.6 + this.rand() * 1.8)) | 0; }
        v.drift[s] += (v.driftT[s] - v.drift[s]) * (dt / 1.2);
        const nU = clamp(ps[K.uni] | 0, 1, MAX_UNI);
        const detune = clamp(ps[K.detune] * (1 + drift0 * 0.6) + mod[PD.DETUNE] * 30, 0, 80);
        const pitch = v.pitch + ps[K.oct] * 12 + ps[K.semi] + ps[K.fine] * 0.01 + v.drift[s] * ps[K.drift] * 0.12 + mod[PD.PITCH] * 0.5;
        const base = (440 * st2r(pitch - 69)) / sr;
        const spread = ps[K.spread], pan0 = ps[K.pan], norm = 1 / Math.sqrt(nU);
        let maxInc = 0;
        const changedU = v.nU[s] !== nU;
        v.nU[s] = nU;
        for (let u = 0; u < nU; u++) {
          const k = s * MAX_UNI + u;
          const off = nU === 1 ? 0 : (2 * u) / (nU - 1) - 1;
          const inc = Math.min(0.45, base * Math.pow(2, (off * detune + v.urnd[k] * 2.5) / 1200));
          v.incS[k] = fresh || changedU ? inc : v.incT[k];
          v.incT[k] = inc;
          if (inc > maxInc) maxInc = inc;
          const pan = clamp((nU === 1 ? 0 : off * spread) + pan0, -1, 1), a = ((pan + 1) * Math.PI) / 4;
          v.gl[k] = Math.cos(a) * Math.SQRT2 * norm; v.gr[k] = Math.sin(a) * Math.SQRT2 * norm;
        }
        const T = this.tab[s];
        const mip = Math.ceil(Math.log2((1023 * maxInc) / 0.475));
        v.mip[s] = mip > 0 ? Math.min(T.mips - 1, mip) : 0;
        const amp = v.padG * this.lvl[s] * lvlMod * this.pgain[s] * 0.55;
        v.ampS[s] = fresh ? 0 : v.ampT[s]; v.ampT[s] = amp;
      }
    }
    // ----- strings
    if (v.str && ps[I['str.on']] >= 0.5) {
      const ty = STRINGS[ps[I['str.type']] | 0] || STRINGS[0];
      const nV = ty.v, layers = ty.oct.length, nS = Math.min(MAX_STR, nV * layers);
      v.nS = nS;
      v.vibOn = Math.min(1, v.vibOn + dt / 1.2);
      v.vibPh += v.vibRate * dt; v.vibPh -= Math.floor(v.vibPh);
      const vib = Math.sin(TAU * v.vibPh) * ps[I['str.vib']] * ty.vib * 16 * v.vibOn; // cents
      const width = ps[I['str.width']], det = ty.det * (1 + this.evv[5] * ps[I['ev.strings']] * 0.4);
      const sOct = ps[I['str.oct']] * 12;
      let maxInc = 0;
      for (let q = 0; q < nS; q++) {
        const layer = (q / nV) | 0, u = q % nV;
        const off = nV === 1 ? 0 : (2 * u) / (nV - 1) - 1;
        const cents = off * det + v.srnd[q] * 3 + vib * (1 + v.srnd[q] * 0.15);
        const inc = Math.min(0.45, (440 * st2r(v.pitch + sOct + ty.oct[layer] - 69 + cents / 100)) / sr);
        v.sincS[q] = fresh ? inc : v.sincT[q]; v.sincT[q] = inc;
        if (inc > maxInc) maxInc = inc;
        const pan = clamp((nS === 1 ? 0 : ((2 * q) / (nS - 1) - 1)) * width, -1, 1), a = ((pan + 1) * Math.PI) / 4;
        const g = 1 / Math.sqrt(nS);
        v.sgl[q] = Math.cos(a) * Math.SQRT2 * g; v.sgr[q] = Math.sin(a) * Math.SQRT2 * g;
      }
      const mip = Math.ceil(Math.log2((1023 * maxInc) / 0.475));
      v.sMip = mip > 0 ? Math.min(MIPS - 1, mip) : 0;
      const exprMod = 1 + this.evv[5] * ps[I['ev.strings']] * 0.25 + this.mSwell * ps[I['str.swell']] * 0.6 + (this.autoS - 0.5) * ps[I['str.swell']] * 0.3 * (ps[I['sw.auto']] >= 0.5 ? 1 : 0);
      const sAmp = v.strG * clamp(exprMod + mod[PD.STR], 0, 2) * 0.6;
      v.sAmpS = fresh ? 0 : v.sAmpT; v.sAmpT = sAmp;
    } else { v.sAmpS = v.sAmpT = 0; v.nS = 0; }
    // ----- bass foundation (not affected by repeated swells: it holds the floor)
    if (v.bass && ps[I['bass.on']] >= 0.5) {
      const inc = Math.min(0.45, (440 * st2r(v.pitch + ps[I['bass.oct']] * 12 - 69)) / sr);
      v.bincS = fresh ? inc : v.bincT; v.bincT = inc;
      const g = Math.max(v.ev, v.sv) * fg * v.velG * 0.5;
      v.bAmpS = fresh ? 0 : v.bAmpT; v.bAmpT = g;
    } else { v.bAmpS = v.bAmpT = 0; }
  }

  // ---------- audio rate: oscillators into the buses ----------
  render(L, R, from, to) {
    if (to <= from) return;
    for (const v of this.notes) {
      if (!v.active) continue;
      if (v.pad) for (let s = 0; s < NOSC; s++) if (this.slotOn[s] && (v.ampT[s] > 1e-7 || v.ampS[s] > 1e-7)) this.oscRun(v, s, from, to);
      if (v.nS > 0 && (v.sAmpT > 1e-7 || v.sAmpS > 1e-7)) this.strRun(v, from, to);
      if (v.bAmpT > 1e-7 || v.bAmpS > 1e-7) this.bassRun(v, from, to);
    }
  }

  oscRun(v, s, from, to) {
    const T = this.tab[s], data = T.data, M = T.mips, mip = v.mip[s], n = this.n, mode = this.mode[s];
    const route = this.route[s], bl = this.bL[route], br = this.bR[route];
    const nU = v.nU[s];
    const ampS = v.ampS[s], damp = (v.ampT[s] - ampS) / n;
    let r0 = (this.fbase[s] * M + mip) * ROW, r1 = r0;
    let w0 = 0, dw = 0;
    if (mode === 1) {
      const p0 = this.pos0[s], p1 = this.pos1[s];
      let f0 = Math.floor(Math.min(p0, p1));
      if (f0 > T.frames - 2) f0 = T.frames - 2; if (f0 < 0) f0 = 0;
      r0 = (f0 * M + mip) * ROW; r1 = ((f0 + 1) * M + mip) * ROW;
      w0 = p0 - f0; dw = (p1 - p0) / n;
    }
    const pw0 = this.pw0[s], dpw = (this.pw1[s] - pw0) / n;
    for (let u = 0; u < nU; u++) {
      const k = s * MAX_UNI + u;
      let ph = v.ph[k];
      const incS = v.incS[k], dinc = (v.incT[k] - incS) / n;
      let inc = incS + dinc * from, amp = ampS + damp * from;
      const gl = v.gl[k], gr = v.gr[k];
      if (mode === 0) {
        for (let i = from; i < to; i++) {
          const x = ph * N, ix = x | 0, a0 = data[r0 + ix];
          const smp = (a0 + (x - ix) * (data[r0 + ix + 1] - a0)) * amp;
          bl[i] += smp * gl; br[i] += smp * gr;
          ph += inc; if (ph >= 1) ph -= 1;
          inc += dinc; amp += damp;
        }
      } else if (mode === 1) {
        let w = w0 + dw * from;
        for (let i = from; i < to; i++) {
          const ww = w < 0 ? 0 : w > 1 ? 1 : w;
          const x = ph * N, ix = x | 0, fr = x - ix;
          const a0 = data[r0 + ix], b0 = data[r1 + ix];
          const s0 = a0 + fr * (data[r0 + ix + 1] - a0), s1 = b0 + fr * (data[r1 + ix + 1] - b0);
          const smp = (s0 + (s1 - s0) * ww) * amp;
          bl[i] += smp * gl; br[i] += smp * gr;
          ph += inc; if (ph >= 1) ph -= 1;
          inc += dinc; amp += damp; w += dw;
        }
      } else {
        let pw = pw0 + dpw * from;
        for (let i = from; i < to; i++) {
          const x = ph * N, ix = x | 0, a0 = data[r0 + ix];
          let p2 = ph + pw; if (p2 >= 1) p2 -= 1;
          const x2 = p2 * N, j = x2 | 0, c0 = data[r0 + j];
          const smp = ((a0 + (x - ix) * (data[r0 + ix + 1] - a0)) - (c0 + (x2 - j) * (data[r0 + j + 1] - c0))) * amp;
          bl[i] += smp * gl; br[i] += smp * gr;
          ph += inc; if (ph >= 1) ph -= 1;
          inc += dinc; amp += damp; pw += dpw;
        }
      }
      v.ph[k] = ph;
    }
  }

  strRun(v, from, to) {
    const B = this.basic, data = B.data, n = this.n;
    const ty = STRINGS[this.ps[I['str.type']] | 0] || STRINGS[0];
    const rSaw = (2 * MIPS + v.sMip) * ROW, rSq = (3 * MIPS + v.sMip) * ROW, mix = ty.mix;
    const sL = this.sL, sR = this.sR;
    const ampS = v.sAmpS, damp = (v.sAmpT - ampS) / n;
    for (let q = 0; q < v.nS; q++) {
      let ph = v.sph[q];
      const incS = v.sincS[q], dinc = (v.sincT[q] - incS) / n;
      let inc = incS + dinc * from, amp = ampS + damp * from;
      const gl = v.sgl[q], gr = v.sgr[q];
      for (let i = from; i < to; i++) {
        const x = ph * N, ix = x | 0, fr = x - ix;
        const a0 = data[rSaw + ix];
        let smp = a0 + fr * (data[rSaw + ix + 1] - a0);
        if (mix > 0) { const b0 = data[rSq + ix]; smp += (b0 + fr * (data[rSq + ix + 1] - b0) - smp) * mix; }
        smp *= amp;
        sL[i] += smp * gl; sR[i] += smp * gr;
        ph += inc; if (ph >= 1) ph -= 1;
        inc += dinc; amp += damp;
      }
      v.sph[q] = ph;
    }
  }

  bassRun(v, from, to) {
    const B = this.basic, data = B.data, n = this.n, wave = this.ps[I['bass.wave']] | 0;
    const r = ((wave === 0 ? 0 : wave === 1 ? 1 : 2) * MIPS + 4) * ROW; // gentle mip: the bass never needs high partials
    const out = this.bass;
    let ph = v.bph;
    const incS = v.bincS, dinc = (v.bincT - incS) / n, damp = (v.bAmpT - v.bAmpS) / n;
    let inc = incS + dinc * from, amp = v.bAmpS + damp * from;
    for (let i = from; i < to; i++) {
      const x = ph * N, ix = x | 0, a0 = data[r + ix];
      out[i] += (a0 + (x - ix) * (data[r + ix + 1] - a0)) * amp;
      ph += inc; if (ph >= 1) ph -= 1;
      inc += dinc; amp += damp;
    }
    v.bph = ph;
  }

  // ---------- shared processing and effects ----------
  postProcess(L, R, n, ctx) {
    const ps = this.ps, sr = this.sr, mod = this.mod;
    for (const v of this.notes) if (v.active) { for (let s = 0; s < NOSC; s++) v.ampS[s] = v.ampT[s]; v.sAmpS = v.sAmpT; v.bAmpS = v.bAmpT; }
    // gate (equal power) applied ahead of the effects so tails ring on
    let g0 = Math.sin(HALF_PI * this.gate);
    if (this.gateDir !== 0) {
      this.gate += this.gateDir * this.gateStep * n;
      if (this.gate >= 1) { this.gate = 1; this.gateDir = 0; }
      else if (this.gate <= 0) { this.gate = 0; this.gateDir = 0; this.gateOff = true; }
    }
    const g1 = Math.sin(HALF_PI * this.gate), dgate = (g1 - g0) / n;
    // ----- noise / texture
    this.noise(n);
    // ----- filters F1, F2 (paraphonic)
    const swellSemis = 24 * this.presence + 30 * ps[I['sw.intensity']] * this.swell;
    for (let f = 0; f < 2; f++) {
      const F = FLT[f], type = ps[F.type] | 0;
      if (type === 5) continue;
      const semis = ps[F.key] * (this.center - 60) + ps[F.swell] * swellSemis + this.evv[2] * ps[I['ev.cutoff']] * 16
        + (f === 0 ? mod[PD.CUT1] : mod[PD.CUT2]) * 48 - this.trans * 9;
      const fc = clamp(ps[F.cut] * st2r(semis), 25, sr * 0.45);
      const g = Math.tan((Math.PI * fc) / sr);
      const res = clamp(ps[F.res] + (f === 0 ? mod[PD.RES1] : mod[PD.RES2]), 0, 0.95);
      const k = type === 2 ? res * 3.6 : 2 - 1.9 * res;
      if (!this.fInit[f]) { this.fg[f] = g; this.fk[f] = k; this.fInit[f] = 1; }
      const gs = this.fg[f], ks = this.fk[f], dg = (g - gs) / n, dk = (k - ks) / n;
      const bL = this.bL[f], bR = this.bR[f], st = this.fs[f];
      const drv = ps[F.drive];
      if (drv > 0.02) {
        const pre = 1 + drv * 5, post = 1 / Math.pow(pre, 0.6), aL = this.adL[f], aR = this.adR[f];
        for (let i = 0; i < n; i++) { bL[i] = aL.run(bL[i] * pre) * post; bR[i] = aR.run(bR[i] * pre) * post; }
      }
      switch (type) {
        case 0: svf(bL, st, 0, n, gs, dg, ks, dk, 0); svf(bR, st, 8, n, gs, dg, ks, dk, 0); break;
        case 1: svf(bL, st, 2, n, gs, dg, 1.85, 0, 0); svf(bL, st, 0, n, gs, dg, ks, dk, 0); svf(bR, st, 10, n, gs, dg, 1.85, 0, 0); svf(bR, st, 8, n, gs, dg, ks, dk, 0); break;
        case 2: ladder(bL, st, 4, n, gs, dg, ks, dk); ladder(bR, st, 12, n, gs, dg, ks, dk); break;
        case 3: svf(bL, st, 0, n, gs, dg, ks, dk, 1); svf(bR, st, 8, n, gs, dg, ks, dk, 1); break;
        case 4: svf(bL, st, 0, n, gs, dg, ks, dk, 2); svf(bR, st, 8, n, gs, dg, ks, dk, 2); break;
        default: break;
      }
      this.fg[f] = g; this.fk[f] = k;
    }
    // ----- strings body + ensemble
    const strOn = ps[I['str.on']] >= 0.5;
    if (strOn) this.stringsBody(n);
    // ----- layer mix
    const blend = ps[I['str.blend']];
    const padG = ps[I['mix.pad']] * (strOn ? Math.min(1, 2 * (1 - blend)) : 1);
    const strG = ps[I['mix.str']] * ps[I['str.vol']] * Math.min(1, 2 * blend) * clamp(1 + mod[PD.STR], 0, 2);
    const noiseG = ps[I['mix.noise']];
    const oL = this.rvL, oR = this.rvR; // reuse as the dry mix buffer
    const f1L = this.bL[0], f1R = this.bR[0], f2L = this.bL[1], f2R = this.bR[1], dL = this.bL[2], dR = this.bR[2], sL = this.sL, sR = this.sR;
    let gg = g0;
    const pk = this.pk;
    let pPad = 0, pStr = 0;
    for (let i = 0; i < n; i++) {
      const pl = (f1L[i] + f2L[i] + dL[i]) * padG, pr = (f1R[i] + f2R[i] + dR[i]) * padG;
      const ql = sL[i] * strG, qr = sR[i] * strG;
      oL[i] = (pl + ql) * gg; oR[i] = (pr + qr) * gg;
      const ap = Math.abs(pl) + Math.abs(pr), aq = Math.abs(ql) + Math.abs(qr);
      if (ap > pPad) pPad = ap; if (aq > pStr) pStr = aq;
      gg += dgate;
    }
    pk[0] = Math.max(pPad * 0.5, pk[0] * 0.9); pk[1] = Math.max(pStr * 0.5, pk[1] * 0.9);
    // low cut on the pad (keeps the low end free for bass guitar and kick)
    const hpG = Math.tan((Math.PI * Math.min(ps[I['out.lowcut']], sr * 0.4)) / sr);
    if (this.hpG < 0) this.hpG = hpG;
    svf(oL, this.hp, 0, n, this.hpG, (hpG - this.hpG) / n, 1.4, 0, 1); svf(oR, this.hp, 2, n, this.hpG, (hpG - this.hpG) / n, 1.4, 0, 1);
    this.hpG = hpG;
    // saturation (warmth)
    const satOn = ps[I['sat.on']] >= 0.5 && ps[I['sat.drive']] > 0.01;
    if (satOn) {
      const d = ps[I['sat.drive']];
      this.sat.setParam(this.sat.i.drive, d * 16); this.sat.setParam(this.sat.i.tone, ps[I['sat.tone']]);
      this.sat.setParam(this.sat.i.out, -d * 7); this.sat.setParam(this.sat.i.mix, 0.35 + 0.65 * d);
      this.sat.process(oL, oR, n, ctx);
    }
    // chorus
    if (ps[I['ch.on']] >= 0.5) {
      this.cho.setParam(this.cho.i.rate, ps[I['ch.rate']]); this.cho.setParam(this.cho.i.depth, ps[I['ch.depth']]);
      this.cho.setParam(this.cho.i.mix, clamp(ps[I['ch.mix']] + mod[PD.CHORUS], 0, 1));
      this.cho.process(oL, oR, n, ctx);
    }
    // stereo width and slow motion (M/S rotation)
    const motion = ps[I['st.motion']];
    this.motionPh += (n / sr) * 0.045; this.motionPh -= Math.floor(this.motionPh);
    const width = clamp(ps[I['st.width']] * (1 + this.evv[4] * ps[I['ev.stereo']] * 0.5) + mod[PD.PAN], 0, 2.5);
    const rot = motion * 0.5 * Math.sin(TAU * this.motionPh) + this.evv[4] * ps[I['ev.stereo']] * 0.25;
    const cr = Math.cos(rot), sn = Math.sin(rot);
    let w = this.width; const dwid = (width - w) / n;
    let sideE = 0, midE = 0;
    for (let i = 0; i < n; i++) {
      const m = (oL[i] + oR[i]) * 0.5, s0 = (oL[i] - oR[i]) * 0.5 * w;
      const l = m + s0, r = m - s0;
      oL[i] = l * cr - r * sn * 0.3; oR[i] = r * cr + l * sn * 0.3;
      midE += m * m; sideE += s0 * s0; w += dwid;
    }
    this.width = width;
    this.stereo = midE > 1e-12 ? Math.sqrt(sideE / midE) : 0;
    // delay (insert)
    if (ps[I['dl.on']] >= 0.5) {
      const d = this.dly;
      d.setParam(d.i.sync, ps[I['dl.sync']]); d.setParam(d.i.div, ps[I['dl.div']]); d.setParam(d.i.time, ps[I['dl.time']]);
      d.setParam(d.i.fb, ps[I['dl.fb']]); d.setParam(d.i.damp, ps[I['dl.damp']]); d.setParam(d.i.mix, ps[I['dl.mix']]);
      d.process(oL, oR, n, ctx);
    }
    // reverb and shimmer sends (strings get their own extra send)
    const rvOn = ps[I['rv.on']] >= 0.5, shOn = ps[I['sh.on']] >= 0.5;
    const out = this.shL, outR = this.shR; // final mix buffer
    for (let i = 0; i < n; i++) { out[i] = oL[i]; outR[i] = oR[i]; }
    if (rvOn || shOn) {
      const strSend = strOn ? (ps[I['str.rev']] * 2 - 1) * strG * 0.6 : 0;
      const sendL = this.sL, sendR = this.sR; // strings bus is done: reuse as the send buffer
      let gs = g0;
      for (let i = 0; i < n; i++) { sendL[i] = oL[i] + sL[i] * strSend * gs; sendR[i] = oR[i] + sR[i] * strSend * gs; gs += dgate; }
      if (shOn) this.shimmer(sendL, sendR, n, ctx, out, outR);
      if (rvOn) {
        const rv = this.rev;
        rv.setParam(rv.i.size, ps[I['rv.size']]); rv.setParam(rv.i.decay, ps[I['rv.decay']]); rv.setParam(rv.i.damp, ps[I['rv.damp']]); rv.setParam(rv.i.pre, ps[I['rv.pre']]);
        rv.process(sendL, sendR, n, ctx);
        const send = clamp(ps[I['rv.send']] * (1 + 0.6 * this.trans) + mod[PD.REVERB], 0, 1.2);
        let rp = 0;
        for (let i = 0; i < n; i++) { const a = sendL[i] * send, b = sendR[i] * send; out[i] += a; outR[i] += b; const m = Math.abs(a) + Math.abs(b); if (m > rp) rp = m; }
        pk[4] = Math.max(rp * 0.5, pk[4] * 0.9);
      }
    }
    // noise texture joins after the filters if it was not routed into them
    // bass foundation (dry, below the low cut)
    if (ps[I['bass.on']] >= 0.5) {
      const bg = ps[I['bass.level']] * ps[I['mix.bass']], fc = Math.min(ps[I['bass.lp']], sr * 0.2);
      const a = 1 - Math.exp((-TAU * fc) / sr), b = this.bass, z = this.bLp;
      let z1 = z[0], z2 = z[1], gb = g0, bp = 0;
      for (let i = 0; i < n; i++) {
        z1 += (b[i] - z1) * a; z2 += (z1 - z2) * a;
        const y = z2 * bg * gb;
        out[i] += y; outR[i] += y;
        if (Math.abs(y) > bp) bp = Math.abs(y);
        gb += dgate;
      }
      z[0] = z1 + 1e-20; z[1] = z2;
      pk[2] = Math.max(bp, pk[2] * 0.9);
    } else pk[2] *= 0.9;
    pk[3] = Math.max(this.nLvl * noiseG * 0.3, pk[3] * 0.9);
    // master EQ, trim, safety limiter
    const eq = this.eq;
    eq.setParam(eq.i.lg, ps[I['eq.low']]); eq.setParam(eq.i.m1g, ps[I['eq.mid']]); eq.setParam(eq.i.m1f, ps[I['eq.midf']]); eq.setParam(eq.i.hg, ps[I['eq.high']]);
    eq.process(out, outR, n, ctx);
    const target = Math.pow(10, ps[I['out.trim']] / 20);
    if (this.outG < 0) this.outG = target;
    let og = this.outG; const dog = (target - og) / n;
    for (let i = 0; i < n; i++) { out[i] *= og; outR[i] *= og; og += dog; }
    this.outG = target;
    this.lim.process(out, outR, n, ctx);
    let peak = 0;
    for (let i = 0; i < n; i++) { L[i] += out[i]; R[i] += outR[i]; const a = Math.abs(out[i]) + Math.abs(outR[i]); if (a > peak) peak = a; }
    this.silentFor = peak < 1e-5 ? this.silentFor + n : 0;
    // telemetry
    let c = 0; for (const v of this.notes) if (v.active) c++;
    const t = this.tele;
    t[0] = c; t[1] = pk[0]; t[2] = pk[1]; t[3] = pk[2]; t[4] = pk[3]; t[5] = pk[4];
    t[6] = this.swell; t[7] = this.presence; t[8] = this.lfoVal[0]; t[9] = this.lfoVal[1];
    for (let e = 0; e < 6; e++) t[10 + e] = this.evv[e];
    t[16] = this.stereo; t[17] = this.gate; t[18] = this.trans; t[19] = peak * 0.5;
    t[20] = Math.abs(mod[PD.CUT1]) + Math.abs(mod[PD.MORPH]) + Math.abs(mod[PD.PAD]);
    // breathe levels of the sounding notes, lowest first (up to 8)
    const bp = this.brP, bv = this.brV;
    let nb = 0;
    for (const v of this.notes) {
      if (!v.active || !v.pad || v.fadeDir < 0 || v.es === 4) continue;
      let j = nb++;
      while (j > 0 && bp[j - 1] > v.pitch) { bp[j] = bp[j - 1]; bv[j] = bv[j - 1]; j--; }
      bp[j] = v.pitch; bv[j] = v.brG;
    }
    for (let k = 0; k < 8; k++) t[21 + k] = k < nb ? bv[k] : -1;
    t[29] = nb;
  }

  stringsBody(n) {
    const ps = this.ps, sr = this.sr, ty = STRINGS[ps[I['str.type']] | 0] || STRINGS[0];
    const sL = this.sL, sR = this.sR;
    // high-pass (body), two resonances, low-pass (brightness)
    const hp = Math.tan((Math.PI * ty.hp) / sr);
    svf(sL, this.sHp, 0, n, hp, 0, 1.4, 0, 1); svf(sR, this.sHp, 2, n, hp, 0, 1.4, 0, 1);
    const key = (ps[I['str.type']] | 0) + ':' + sr;
    if (key !== this.pkKey) {
      this.pkKey = key;
      for (let k = 0; k < 2; k++) biquadCoefs(BQ.PEAK, ty.pk[k][0], ty.pk[k][2], ty.pk[k][1], sr, this.pkC[k]);
    }
    for (let k = 0; k < 2; k++) {
      const c = this.pkC[k], b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4], z = this.pkZ;
      let z1 = z[k * 4], z2 = z[k * 4 + 1], z3 = z[k * 4 + 2], z4 = z[k * 4 + 3];
      for (let i = 0; i < n; i++) {
        const x = sL[i], y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; sL[i] = y;
        const xr = sR[i], yr = b0 * xr + z3; z3 = b1 * xr - a1 * yr + z4; z4 = b2 * xr - a2 * yr; sR[i] = yr;
      }
      z[k * 4] = z1 + 1e-20; z[k * 4 + 1] = z2; z[k * 4 + 2] = z3 + 1e-20; z[k * 4 + 3] = z4;
    }
    const bright = clamp(ps[I['str.bright']] + this.mod[PD.STR_BRIGHT] + this.evv[5] * ps[I['ev.strings']] * 0.15, 0, 1);
    const fc = clamp(ps[I['str.cut']] * ty.lp * Math.pow(2, (bright - 0.45) * 2.5), 300, sr * 0.42);
    const g = Math.tan((Math.PI * fc) / sr);
    if (this.sLg < 0) this.sLg = g;
    const dg = (g - this.sLg) / n;
    svf(sL, this.sLp, 0, n, this.sLg, dg, 1.4, 0, 0); svf(sL, this.sLp, 2, n, this.sLg, dg, 1.85, 0, 0);
    svf(sR, this.sLp, 4, n, this.sLg, dg, 1.4, 0, 0); svf(sR, this.sLp, 6, n, this.sLg, dg, 1.85, 0, 0);
    this.sLg = g;
    // ensemble: three modulated taps (slow + fast LFO), the classic string-machine chorus
    const ens = clamp(ps[I['str.ens']] * ty.ens, 0, 2) * 0.5;
    if (ens > 0.001) {
      const buf = this.ensBuf, len = this.ensLen;
      const base = 0.008 * sr, slow = 0.0028 * sr * ens, fast = 0.00035 * sr * ens;
      const i1 = 0.63 / sr, i2 = 5.7 / sr;
      let w = this.ensW, p1 = this.ensPh, p2 = this.ensPh2;
      const mix = Math.min(1, ens * 1.2);
      for (let i = 0; i < n; i++) {
        const x = (sL[i] + sR[i]) * 0.5;
        buf[w] = x;
        const tap = (o) => {
          const d = base + slow * (1 + Math.sin(TAU * (p1 + o))) + fast * (1 + Math.sin(TAU * (p2 + o)));
          let pos = w - d; if (pos < 0) pos += len;
          const j = pos | 0, f = pos - j, j1 = j + 1 >= len ? 0 : j + 1;
          return buf[j] + (buf[j1] - buf[j]) * f;
        };
        const t0 = tap(0), t1 = tap(1 / 3), t2 = tap(2 / 3);
        sL[i] += ((t0 + t1 * 0.5) * 0.8 - sL[i]) * mix;
        sR[i] += ((t2 + t1 * 0.5) * 0.8 - sR[i]) * mix;
        if (++w >= len) w = 0;
        p1 += i1; if (p1 >= 1) p1 -= 1; p2 += i2; if (p2 >= 1) p2 -= 1;
      }
      this.ensW = w; this.ensPh = p1; this.ensPh2 = p2;
    }
  }

  noise(n) {
    const ps = this.ps, sr = this.sr;
    const on = ps[I['nz.on']] >= 0.5;
    const target = on ? ps[I['nz.level']] * ps[I['mix.noise']] * clamp(1 + this.mod[PD.NOISE], 0, 2) * this.presence * (1 + 0.4 * this.swell) : 0;
    if (target < 1e-6 && this.nLvl < 1e-6) { this.nLvl = 0; return; }
    const type = ps[I['nz.type']] | 0, route = ps[I['nz.route']] | 0;
    const bl = this.bL[route], br = this.bR[route], st = this.nState;
    let a = this.nLvl; const da = (target - a) / n;
    let x = this.nRng, y = this.nRngR;
    const tone = ps[I['nz.tone']] * (type === 2 ? Math.pow(2, this.evv[2] * 0.6) : 1);
    const g = Math.tan((Math.PI * Math.min(tone, sr * 0.45)) / sr), a1 = 1 / (1 + g * (g + 0.7)), a2 = g * a1, a3 = g * a2;
    const breath = type === 3 ? 0.6 + 0.4 * Math.sin(TAU * this.lfoPh[0] * 0.5 + 1) : 1;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; y ^= y << 13; y ^= y >>> 17; y ^= y << 5;
      let wl = x / 2147483648, wr = y / 2147483648;
      if (type === 1) { st[0] = st[0] * 0.995 + wl * 0.06; st[1] = st[1] * 0.995 + wr * 0.06; wl = st[0] * 2.5; wr = st[1] * 2.5; }
      else if (type !== 2) { // pink-ish
        st[2] = 0.997 * st[2] + wl * 0.029; st[3] = 0.985 * st[3] + wl * 0.032; wl = (st[2] + st[3] + wl * 0.03) * 1.6;
        st[4] = 0.997 * st[4] + wr * 0.029; st[5] = 0.985 * st[5] + wr * 0.032; wr = (st[4] + st[5] + wr * 0.03) * 1.6;
      }
      // tone filter: band-pass for Air/Breath, low-pass otherwise
      let v3 = wl - st[7], v1 = a1 * st[6] + a2 * v3, v2 = st[7] + a2 * st[6] + a3 * v3;
      st[6] = 2 * v1 - st[6]; st[7] = 2 * v2 - st[7];
      const ol = type >= 2 ? v1 * 0.7 : v2;
      v3 = wr - st[9]; v1 = a1 * st[8] + a2 * v3; v2 = st[9] + a2 * st[8] + a3 * v3;
      st[8] = 2 * v1 - st[8]; st[9] = 2 * v2 - st[9];
      const or = type >= 2 ? v1 * 0.7 : v2;
      bl[i] += ol * a * 0.25 * breath; br[i] += or * a * 0.25 * breath;
      a += da;
    }
    st[6] += 1e-20; st[8] += 1e-20;
    this.nRng = x; this.nRngR = y; this.nLvl = target;
  }

  // Octave-up shimmer: a pitch shifter inside the feedback loop of a long
  // reverb. The loop runs one render quantum behind (the previous block's
  // reverb output is shifted and fed back), which is inaudible at these lengths.
  shimmer(inL, inR, n, ctx, outL, outR) {
    const ps = this.ps, sr = this.sr;
    const amount = clamp(ps[I['sh.amount']] + this.mod[PD.SHIMMER], 0, 1.2), fb = ps[I['sh.fb']];
    const a = 1 - Math.exp((-TAU * ps[I['sh.tone']]) / sr), hpA = 1 - Math.exp((-TAU * 350) / sr);
    const tL = this.shTL, tR = this.shTR, prevL = this.shPrevL, prevR = this.shPrevR;
    const len = this.psLen, D = this.psD, pL = this.psL, pR = this.psR, z = this.shLp;
    let w = this.psW, ph = this.psPh;
    const step = 1 / D; // the read heads run at twice the write speed: one octave up
    for (let i = 0; i < n; i++) {
      pL[w] = prevL[i]; pR[w] = prevR[i];
      let yl = 0, yr = 0;
      for (let h = 0; h < 2; h++) {
        let q = ph + h * 0.5; if (q >= 1) q -= 1;
        const d = 2 + (1 - q) * D, win = Math.sin(Math.PI * q);
        let pos = w - d; if (pos < 0) pos += len;
        const j = pos | 0, f = pos - j, j1 = j + 1 >= len ? 0 : j + 1;
        yl += (pL[j] + (pL[j1] - pL[j]) * f) * win * win;
        yr += (pR[j] + (pR[j1] - pR[j]) * f) * win * win;
      }
      if (++w >= len) w = 0;
      ph += step; if (ph >= 1) ph -= 1;
      // soft, dark feedback: low-pass + high-pass keep it from getting brittle
      z[0] += (yl - z[0]) * a; z[1] += (yr - z[1]) * a; z[2] += (z[0] - z[2]) * hpA; z[3] += (z[1] - z[3]) * hpA;
      tL[i] = inL[i] * 0.5 + fastTanh((z[0] - z[2]) * fb);
      tR[i] = inR[i] * 0.5 + fastTanh((z[1] - z[3]) * fb);
    }
    this.psW = w; this.psPh = ph; z[0] += 1e-20; z[1] += 1e-20;
    const rv = this.shRev;
    rv.setParam(rv.i.decay, Math.min(20, ps[I['rv.decay']] * 1.4 + 2)); rv.setParam(rv.i.damp, ps[I['sh.tone']]);
    rv.process(tL, tR, n, ctx);
    for (let i = 0; i < n; i++) {
      outL[i] += tL[i] * amount * 0.7; outR[i] += tR[i] * amount * 0.7;
      prevL[i] = tL[i]; prevR[i] = tR[i];
    }
  }
}

// ---------------------------------------------------------------- live pad host
// The always-on LIVE PAD channel. Owns one engine per loaded preset: a preset
// change starts a new engine and fades the old one out (both gates are
// applied before the effects, so the old reverb tail keeps ringing).
export class LivePadHost {
  constructor(sr) {
    this.sr = sr;
    this.engines = [new PadEngine(sr)];
    this.cur = this.engines[0];
    this.cur.gate = 0; this.cur.gateOff = true;
    this.playing = false;
    this.chord = null; this.bassPitch = null;
    this.tele = this.cur.tele;
    this.tL = new Float32Array(BLOCK); this.tR = new Float32Array(BLOCK);
    this.outG = 1; this.outT = 1; this.panicking = false;
  }
  setManualAll(arr, snap) { this.cur.setManualAll(arr, snap); }
  setParam(i, v) { this.cur.setParam(i, v); }
  applyParam(i, v) { this.cur.applyParam(i, v); }
  setAuto(i, v) { this.cur.setAuto(i, v); }
  setAutomated() {}
  setTable(osc, t) { this.cur.setTable(osc, t); }
  setCustom(arr) { for (const e of this.engines) e.setCustom(arr); }
  noteOn(p, v) { this.cur.noteOn(p, v); }
  noteOff(p) { this.cur.noteOff(p); }
  pitchBend() {}
  modWheel(v) { for (const e of this.engines) e.modWheel(v); }
  allNotesOff(hard) { for (const e of this.engines) e.allNotesOff(hard); if (hard) this.panic(); }
  isActive() { return true; }

  // ----- performance controls (messages from the UI) -----
  start(chord, bass, fadeIn) {
    const e = this.cur;
    this.chord = chord; this.bassPitch = bass;
    if (e.gate > 0.001 && !e.gateOff) e.setChord(chord, bass, { fadeIn: 2, fadeOut: 2 }); // restarted while fading out
    else { e.killLive(); e.setChord(chord, bass, { fromSilence: true }); e.gate = 0; }
    e.setGate(true, fadeIn);
    this.playing = true;
  }
  stop(fadeOut) {
    for (const e of this.engines) e.setGate(false, fadeOut);
    this.playing = false;
  }
  change(chord, bass, o) {
    this.chord = chord; this.bassPitch = bass;
    if (!this.playing) return;
    this.cur.setChord(chord, bass, o);
  }
  // Load a new patch with a crossfade (params: Float64Array).
  load(params, xfade, tables) {
    const old = this.cur;
    const e = new PadEngine(this.sr);
    e.setManualAll(params, true);
    if (tables) tables.forEach((t, i) => { if (t) e.setTable(i, t); });
    e.mw = old.mw;
    if (this.playing && this.chord) {
      e.setChord(this.chord, this.bassPitch, { fromSilence: false, fadeIn: 0.01 });
      for (const v of e.notes) if (v.active) { v.ev = e.ps[I['sw.sustain']]; v.sv = e.ps[I['str.sustain']]; v.es = 3; v.ss = 3; }
      e.gate = 0; e.setGate(true, xfade);
      old.setGate(false, xfade);
    } else { e.gate = 0; e.gateOff = true; }
    this.engines.push(e);
    this.cur = e; this.tele = e.tele;
    while (this.engines.length > 4) this.engines.shift(); // rapid preset hopping: keep at most four alive
  }
  swell() { this.cur.triggerSwell(); }
  // Emergency silence: a 30 ms fade of the whole channel, then everything is cleared.
  panic() { this.outT = 0; this.panicking = true; this.playing = false; }
  clearAll() {
    for (const e of this.engines) { e.killLive(); e.allNotesOff(true); e.gate = 0; e.gateDir = 0; e.gateOff = true; }
    this.engines = [this.cur];
    this.panicking = false; this.outT = 1;
  }

  beginBlock(tempo, beat, playing, n) {
    for (const e of this.engines) if (!e.gateOff || e.gateDir !== 0 || e.silentFor < this.sr * 2) e.beginBlock(tempo, beat, playing, n);
  }
  render(L, R, from, to) {
    for (const e of this.engines) if (!e.gateOff || e.gateDir !== 0 || e.silentFor < this.sr * 2) e.render(L, R, from, to);
  }
  postProcess(L, R, n, ctx) {
    const tL = this.tL, tR = this.tR;
    tL.fill(0, 0, n); tR.fill(0, 0, n);
    for (const e of this.engines) if (!e.gateOff || e.gateDir !== 0 || e.silentFor < this.sr * 2) e.postProcess(tL, tR, n, ctx);
    let g = this.outG;
    const step = n / (0.03 * this.sr), gT = g < this.outT ? Math.min(this.outT, g + step) : Math.max(this.outT, g - step);
    const dg = (gT - g) / n;
    for (let i = 0; i < n; i++) { L[i] += tL[i] * g; R[i] += tR[i] * g; g += dg; }
    this.outG = gT;
    if (this.panicking && gT <= 0) { this.clearAll(); }
    // free engines that have faded out and gone quiet; stop notes behind a closed gate
    for (let i = this.engines.length - 1; i >= 0; i--) {
      const e = this.engines[i];
      if (e.gateOff && e.gateDir === 0) {
        if (e !== this.cur || !this.playing) e.killLive();
        if (e !== this.cur && e.silentFor >= this.sr * 2) this.engines.splice(i, 1);
      }
    }
  }
}

// Topology-preserving state-variable filter (Simper). out: 0 LP, 1 HP, 2 BP.
function svf(buf, st, off, n, g, dg, k, dk, out) {
  let ic1 = st[off], ic2 = st[off + 1];
  for (let i = 0; i < n; i++) {
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
function ladder(buf, st, off, n, g, dg, k, dk) {
  let s1 = st[off], s2 = st[off + 1], s3 = st[off + 2], s4 = st[off + 3];
  for (let i = 0; i < n; i++) {
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
