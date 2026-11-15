// Pedal DSP: compressor, overdrive, delay, reverb.
// Interface: new Fx(fs, voice); fx.set(params); fx.process(L, R, n); fx.reset().
// R is null when the pedal runs in the mono (before-amp) section.
// Effects with trails (delay, reverb) have fx.send: a smoothed 0..1 input level
// that the chain lowers on bypass so the tail keeps ringing (spillover).

import { Biquad, OnePole, Smooth, Oversampler4, DelayLine, softClip, dbToGain, clamp, TAU } from './core.js';
import { VOICES, DIVISIONS } from '../shared/defs.js';

// ------------------------------------------------------------------ compressor
export class Compressor {
  constructor(fs, voice) {
    this.fs = fs; this.v = VOICES.comp[voice] || VOICES.comp.studio;
    this.env = 0; this.gr = 0; this.grMeter = 0;
    this.makeup = new Smooth(1, 30, fs); this.blend = new Smooth(0.7, 30, fs);
    this.thr = -26; this.ratio = 4; this.atk = 0; this.rel = 0;
    this.gainSm = new OnePole().setMs(2, fs);
  }
  set(p) {
    this.thr = p.sustain; this.ratio = Math.max(1, p.ratio);
    this.atk = Math.exp(-1 / (Math.max(0.1, p.attack) * 0.001 * this.fs));
    this.rel = Math.exp(-1 / (Math.max(5, p.release) * 0.001 * this.fs));
    this.makeup.set(dbToGain(p.level)); this.blend.set(p.blend / 100);
  }
  reset() { this.env = 0; this.gainSm.reset(1); }
  process(L, R, n) {
    const knee = this.v.knee, slope = 1 - 1 / this.ratio, thr = this.thr;
    let maxGr = 0;
    for (let i = 0; i < n; i++) {
      const a = R ? Math.max(Math.abs(L[i]), Math.abs(R[i])) : Math.abs(L[i]);
      this.env = a > this.env ? a + (this.env - a) * this.atk : a + (this.env - a) * this.rel;
      const over = 20 * Math.log10(this.env + 1e-9) - thr;
      let gr = 0;
      if (over >= knee / 2) gr = over * slope;
      else if (over > -knee / 2) { const t = over + knee / 2; gr = slope * t * t / (2 * knee); }
      if (gr > maxGr) maxGr = gr;
      const g = this.gainSm.process(Math.pow(10, -gr / 20));
      const mk = this.makeup.next(), bl = this.blend.next();
      const m = (bl * g + (1 - bl)) * mk;
      L[i] *= m; if (R) R[i] *= m;
    }
    this.grMeter = maxGr;
  }
}

// ------------------------------------------------------------------ overdrive
// Input high-pass and mid emphasis → gain → asymmetric soft clipping at 4x
// rate → post smoothing → tone → level, with optional clean blend.
// Clipping depends on how hard you play, so it cleans up with lighter picking
// or the guitar's volume knob.
export class Drive {
  constructor(fs, voice) {
    this.fs = fs; this.v = VOICES.drive[voice] || VOICES.drive.transparent;
    this.chans = [0, 1].map(() => ({ hp: new Biquad(), mid: new Biquad(), lp: new Biquad(), tone: new Biquad(), os: new Oversampler4(fs), dc: new Biquad() }));
    this.gain = new Smooth(1, 30, fs); this.level = new Smooth(1, 30, fs); this.clean = new Smooth(0, 30, fs);
    const v = this.v;
    for (const c of this.chans) {
      c.hp.set('hp1', v.hp, 0.7, 0, fs); c.mid.set('peak', v.midHz, 0.8, v.midDb, fs);
      c.lp.set('lp', v.lp, 0.7, 0, fs); c.dc.set('hp1', 15, 0.7, 0, fs);
    }
    this.bias = v.asym; this.biasOut = softClip(v.asym);
    this.clip = (x, self) => softClip(x + self.bias) - self.biasOut;
  }
  set(p) {
    const v = this.v, d = clamp(p.drive / 100, 0, 1);
    this.gain.set(dbToGain(v.gainMin + (v.gainMax - v.gainMin) * d));
    // Gentle loudness compensation: more drive → more clipping → less level rise.
    this.level.set(dbToGain(p.level - (v.gainMin + (v.gainMax - v.gainMin) * d) * 0.15));
    this.clean.set(clamp(p.clean / 100, 0, 1));
    const f = v.toneLo * Math.pow(v.toneHi / v.toneLo, clamp(p.tone / 100, 0, 1));
    for (const c of this.chans) c.tone.set('lp', f, 0.6, 0, this.fs);
  }
  reset() { for (const c of this.chans) { c.hp.reset(); c.mid.reset(); c.lp.reset(); c.tone.reset(); c.os.reset(); c.dc.reset(); } }
  process(L, R, n) {
    const lowKeep = this.v.lowKeep;
    for (let ch = 0; ch < (R ? 2 : 1); ch++) {
      const buf = ch ? R : L, c = this.chans[ch];
      // Each channel walks the same smoother path; copy state so both channels match.
      const g0 = this.gain.v, l0 = this.level.v, k0 = this.clean.v;
      for (let i = 0; i < n; i++) {
        const x = buf[i];
        const g = this.gain.next(), lv = this.level.next(), cl = this.clean.next();
        const hp = c.hp.process(x);
        const low = x - hp; // the lows the input filter removed
        const pre = c.mid.process(hp) * g;
        let y = c.os.run(pre, this.clip, this);
        y = c.tone.process(c.lp.process(c.dc.process(y)));
        // clean blend keeps pick attack and lows of the dry guitar (transparent style)
        buf[i] = (y * (1 - cl) + (x * 0.9) * cl + low * lowKeep * 0.6 * (1 - cl)) * lv;
      }
      if (ch === 0 && R) { this.gain.v = g0; this.level.v = l0; this.clean.v = k0; }
    }
  }
}

// ------------------------------------------------------------------ delay
const MAX_DELAY_S = 2.6;
export class Delay {
  constructor(fs, voice) {
    this.fs = fs; this.v = VOICES.delay[voice] || VOICES.delay.digital;
    const len = Math.ceil(MAX_DELAY_S * fs) + 8;
    this.dl = [new DelayLine(len), new DelayLine(len)];
    this.lp = [new Biquad(), new Biquad()]; this.hp = [new Biquad(), new Biquad()];
    this.time = new Smooth(0.45 * fs, 120, fs); // slewed like a tape head, no zipper noise
    this.fb = new Smooth(0.3, 30, fs); this.mix = new Smooth(0.25, 30, fs);
    this.send = new Smooth(1, 15, fs);
    this.phase = 0; this.modRate = 0.6; this.modDepth = 0; this.mode = 0; this.bpm = 120;
    this.p = null; this.energy = 0;
  }
  setTempo(bpm) { this.bpm = bpm; if (this.p) this.set(this.p); }
  set(p) {
    this.p = p;
    const div = DIVISIONS[p.sync | 0] || DIVISIONS[0];
    const ms = div.q > 0 ? (60000 / this.bpm) * div.q : p.time;
    this.time.set(clamp(ms, 5, MAX_DELAY_S * 1000 - 10) * 0.001 * this.fs);
    this.fb.set(clamp(p.feedback / 100, 0, 0.97)); this.mix.set(clamp(p.mix / 100, 0, 1));
    const tone = p.tone * (1 - this.v.darken * 0.3);
    for (let c = 0; c < 2; c++) { this.lp[c].set('lp', tone, 0.6, 0, this.fs); this.hp[c].set('hp1', p.lowcut, 0.7, 0, this.fs); }
    this.modDepth = (p.mod / 100) * (0.0025 + this.v.wow * 0.004) * this.fs; // up to a few ms of wobble
    this.modRate = 0.35 + this.v.wow * 0.4 + (p.mod / 100) * 0.5;
    this.mode = p.mode | 0;
  }
  reset() { this.dl[0].reset(); this.dl[1].reset(); for (const f of [...this.lp, ...this.hp]) f.reset(); this.energy = 0; }
  process(L, R, n) {
    const [dA, dB] = this.dl, sat = this.v.sat, mode = this.mode, inc = TAU * this.modRate / this.fs;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const t = this.time.next(), fb = this.fb.next(), mix = this.mix.next(), send = this.send.next();
      this.phase += inc; if (this.phase > TAU) this.phase -= TAU;
      const m = Math.sin(this.phase) * this.modDepth, m2 = Math.cos(this.phase * 0.83) * this.modDepth;
      const xl = L[i], xr = R ? R[i] : xl, xin = (xl + xr) * 0.5 * send;
      let wl = dA.read(Math.max(2, t + m)), wr = dB.read(Math.max(2, (mode === 0 ? t * 1.012 : t) + m2));
      // feedback path: tone filtering, optional saturation, then soft limiting so it can never run away
      let fl = this.hp[0].process(this.lp[0].process(wl)) * fb, fr = this.hp[1].process(this.lp[1].process(wr)) * fb;
      if (sat > 0) { fl = fl * (1 - sat) + softClip(fl * 1.5) * sat / 1.5; fr = fr * (1 - sat) + softClip(fr * 1.5) * sat / 1.5; }
      fl = softClip(fl * 0.8) * 1.25; fr = softClip(fr * 0.8) * 1.25;
      if (mode === 1) { dA.write(xin + fr + 1e-18); dB.write(fl + 1e-18); }          // ping-pong
      else if (mode === 2) { dA.write(xin + fl + 1e-18); dB.write(xin + fl + 1e-18); wr = wl; } // mono
      else { dA.write((R ? xl * send : xin) + fl + 1e-18); dB.write((R ? xr * send : xin) + fr + 1e-18); }
      if (R) { L[i] = xl + wl * mix; R[i] = xr + wr * mix; }
      else L[i] = xl + (wl + wr) * 0.5 * mix;
      e += wl * wl + wr * wr;
    }
    this.energy = e / n;
  }
}

// ------------------------------------------------------------------ reverb
// 8-line feedback delay network with input diffusion, per-line damping,
// slow modulation (removes metallic ringing) and a low cut on the tail.
class Allpass {
  constructor(len, g) { this.buf = new Float32Array(len); this.len = len; this.i = 0; this.g = g; }
  reset() { this.buf.fill(0); }
  process(x) {
    const d = this.buf[this.i], v = x + d * this.g;
    this.buf[this.i] = v; this.i = this.i + 1 === this.len ? 0 : this.i + 1;
    return d - v * this.g;
  }
}
const N = 8;
const OUT_L = [1, -1, 1, -1, 1, 1, -1, -1], OUT_R = [1, 1, -1, -1, 1, -1, 1, -1];
export class Reverb {
  constructor(fs, voice) {
    this.fs = fs; this.v = VOICES.reverb[voice] || VOICES.reverb.hall;
    const v = this.v;
    this.lines = v.lens.map((ms) => new DelayLine(Math.ceil(ms * v.sizeMax * 0.001 * fs) + 64));
    this.lens = new Float64Array(N); this.g = new Float64Array(N);
    this.damp = Array.from({ length: N }, () => new OnePole());
    this.phases = Float64Array.from({ length: N }, (_, i) => i * 0.785);
    this.diffL = v.diff.map((ms) => new Allpass(Math.round(ms * 0.001 * fs), v.diffG));
    this.diffR = v.diff.map((ms) => new Allpass(Math.round(ms * 0.001 * fs * 1.07), v.diffG));
    this.pre = new DelayLine(Math.ceil(0.25 * fs) + 4);
    this.hpL = new Biquad(); this.hpR = new Biquad(); this.lpIn = new Biquad();
    this.mix = new Smooth(0.25, 30, fs); this.send = new Smooth(1, 15, fs);
    this.preD = 0; this.modDepth = 0; this.x = new Float64Array(N); this.y = new Float64Array(N); this.energy = 0;
    this.decay = 2; this.freeze = false;
  }
  set(p) {
    const v = this.v, fs = this.fs, size = v.sizeMin + (v.sizeMax - v.sizeMin) * clamp(p.size / 100, 0, 1);
    this.decay = clamp(p.decay, 0.1, 30);
    for (let i = 0; i < N; i++) {
      this.lens[i] = v.lens[i] * size * 0.001 * fs;
      this.g[i] = Math.pow(10, (-3 * this.lens[i]) / (this.decay * fs));
      this.damp[i].setHz(p.tone, fs);
    }
    this.preD = Math.max(1, p.predelay * 0.001 * fs);
    this.hpL.set('hp', p.lowcut, 0.6, 0, fs); this.hpR.set('hp', p.lowcut, 0.6, 0, fs);
    this.lpIn.set('lp', Math.min(p.tone * 1.5, fs * 0.45), 0.6, 0, fs);
    this.mix.set(clamp(p.mix / 100, 0, 1));
    this.modDepth = (p.mod / 100) * 0.0012 * fs; // up to ~1.2 ms
  }
  reset() { for (const l of this.lines) l.reset(); for (const a of [...this.diffL, ...this.diffR]) a.reset(); this.pre.reset(); this.energy = 0; for (const d of this.damp) d.reset(); }
  process(L, R, n) {
    const lines = this.lines, x = this.x, y = this.y, g = this.g, lens = this.lens, damp = this.damp, inc = TAU * 0.13 / this.fs;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const mix = this.mix.next(), send = this.send.next();
      const dl = L[i], dr = R ? R[i] : dl;
      this.pre.write(this.lpIn.process((dl + dr) * 0.5 * send) + 1e-18);
      const s = this.pre.read(this.preD);
      let a = s, b = s;
      for (let k = 0; k < this.diffL.length; k++) { a = this.diffL[k].process(a); b = this.diffR[k].process(b); }
      // read the lines (two of them slowly modulated)
      for (let k = 0; k < N; k++) {
        let d = lens[k];
        if (k < 4) { this.phases[k] += inc * (1 + k * 0.37); d += Math.sin(this.phases[k]) * this.modDepth; }
        y[k] = damp[k].process(lines[k].read(d)) * g[k];
      }
      // Hadamard mix (fast Walsh-Hadamard, normalised): lossless, so g sets the decay exactly
      x[0] = y[0] + y[1]; x[1] = y[0] - y[1]; x[2] = y[2] + y[3]; x[3] = y[2] - y[3];
      x[4] = y[4] + y[5]; x[5] = y[4] - y[5]; x[6] = y[6] + y[7]; x[7] = y[6] - y[7];
      y[0] = x[0] + x[2]; y[2] = x[0] - x[2]; y[1] = x[1] + x[3]; y[3] = x[1] - x[3];
      y[4] = x[4] + x[6]; y[6] = x[4] - x[6]; y[5] = x[5] + x[7]; y[7] = x[5] - x[7];
      let ol = 0, or = 0;
      for (let k = 0; k < 4; k++) {
        const p0 = (y[k] + y[k + 4]) * 0.35355339, p1 = (y[k] - y[k + 4]) * 0.35355339;
        lines[k].write(p0 + (k & 1 ? b : a) * 0.5);
        lines[k + 4].write(p1 + (k & 1 ? a : b) * 0.5);
      }
      for (let k = 0; k < N; k++) { const v = lines[k].read(1); ol += v * OUT_L[k]; or += v * OUT_R[k]; }
      ol = this.hpL.process(ol * 0.3); or = this.hpR.process(or * 0.3);
      if (R) { L[i] = dl + ol * mix; R[i] = dr + or * mix; }
      else L[i] = dl + (ol + or) * 0.5 * mix;
      e += ol * ol + or * or;
    }
    this.energy = e / n;
  }
}

export const DSP_CLASSES = { comp: Compressor, drive: Drive, delay: Delay, reverb: Reverb };
