// Guitar amp model: input filter → bright → preamp gain → asymmetric triode-like
// clipping (4x oversampled) → tone stack → power amp with sag → presence.
// The cabinet comes after this, as a convolution in the audio graph.

import { Biquad, OnePole, Smooth, Oversampler4, softClip, dbToGain, clamp } from './core.js';
import { ampById } from '../shared/defs.js';

class AmpVoice {
  constructor(fs) {
    this.fs = fs;
    this.hp = new Biquad(); this.bright = new Biquad(); this.cpl = new Biquad(); this.cpl2 = new Biquad();
    this.bass = new Biquad(); this.mid = new Biquad(); this.treb = new Biquad(); this.pres = new Biquad(); this.lp = new Biquad();
    this.os1 = new Oversampler4(fs); this.os2 = new Oversampler4(fs);
    this.env = new OnePole(); this.envRel = 0; this.envAtk = 0; this.envV = 0;
    this.gain = new Smooth(1, 30, fs); this.master = new Smooth(1, 30, fs); this.out = new Smooth(1, 30, fs);
    this.asym = 0.1; this.asymOut = 0; this.sagAmt = 0.5;
    this.c1 = (x, s) => { // preamp stage: softer on the negative side, like a triode
      const v = x + s.asym;
      return (v > 0 ? softClip(v) : softClip(v * 0.7) / 0.7 * 0.92) - s.asymOut;
    };
    this.c2 = (x) => softClip(x);
  }
  config(m, p) {
    const fs = this.fs, gainN = clamp(p.gain / 100, 0, 1);
    this.m = m;
    this.hp.set('hp', m.hp, 0.6, 0, fs);
    // bright cap: strongest at low gain, as on a real amp
    this.bright.set('highshelf', 2500, 0.6, m.bright * (p.bright / 100) * (1.2 - gainN), fs);
    this.gain.set(dbToGain(m.gainLo + (m.gainHi - m.gainLo) * gainN));
    this.asym = m.asym; this.asymOut = this.asym > 0 ? softClip(this.asym) : -(softClip(-this.asym * 0.7) / 0.7 * 0.92);
    this.cpl.set('hp1', 25, 0.7, 0, fs); this.cpl2.set('hp1', 20, 0.7, 0, fs);
    const t = (v) => (clamp(v, 0, 10) - 5); // −5..+5 around noon
    this.bass.set('lowshelf', m.bassHz, 0.7, t(p.bass) * 2.2, fs);
    this.mid.set('peak', m.midHz, 0.7, m.midScoop + t(p.mid) * 2.0, fs);
    this.treb.set('highshelf', m.trebHz, 0.7, t(p.treble) * 2.2, fs);
    this.pres.set('highshelf', m.presHz, 0.8, t(p.presence) * 1.6, fs);
    this.lp.set('lp', m.lp, 0.7, 0, fs);
    // master pushes the power stage; higher master = more power-amp breakup
    const mN = clamp(p.master / 100, 0, 1);
    this.master.set(dbToGain(-18 + mN * 24) * m.power);
    this.out.set(dbToGain(p.output + m.outTrim + (12 - mN * 16) * 0.5 - (m.gainLo + (m.gainHi - m.gainLo) * gainN) * 0.12));
    this.sagAmt = (p.sag / 100) * m.sag * 2;
    this.envAtk = Math.exp(-1 / (0.015 * fs)); this.envRel = Math.exp(-1 / (0.25 * fs));
  }
  reset() { for (const f of [this.hp, this.bright, this.cpl, this.cpl2, this.bass, this.mid, this.treb, this.pres, this.lp]) f.reset(); this.os1.reset(); this.os2.reset(); this.envV = 0; }
  sample(x) {
    const g = this.gain.next(), ms = this.master.next(), o = this.out.next();
    let y = this.bright.process(this.hp.process(x)) * g;
    y = this.cpl.process(this.os1.run(y, this.c1, this));
    y = this.treb.process(this.mid.process(this.bass.process(y)));
    // sag: the supply drops when you dig in, compressing and "blooming" the note
    const a = Math.abs(y);
    this.envV = a > this.envV ? a + (this.envV - a) * this.envAtk : a + (this.envV - a) * this.envRel;
    const sag = 1 / (1 + this.sagAmt * this.envV * ms);
    y = this.cpl2.process(this.os2.run(y * ms * sag, this.c2, null)) / Math.max(0.35, Math.min(1, ms));
    return this.lp.process(this.pres.process(y)) * o;
  }
}

export class Amp {
  constructor(fs) { this.fs = fs; this.a = new AmpVoice(fs); this.b = new AmpVoice(fs); this.stereo = false; this.model = ampById('chime30'); }
  set(model, p) {
    this.model = ampById(model);
    this.a.config(this.model, p);
    this.stereo = !!this.model.stereoB;
    if (this.stereo) this.b.config(ampById(this.model.stereoB), p);
  }
  reset() { this.a.reset(); this.b.reset(); }
  // mono in (L) → L/R out
  process(L, R, n) {
    for (let i = 0; i < n; i++) {
      const x = L[i];
      L[i] = this.a.sample(x);
      R[i] = this.stereo ? this.b.sample(x) : L[i];
    }
  }
}
