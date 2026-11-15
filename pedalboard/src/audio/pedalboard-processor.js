// Worship Pedalboard audio worklet. Two instances run in the audio graph:
//   section 'pre'  : guitar input → input gain → noise gate → pedals before the amp (mono) → amp (L/R)
//   [cabinet convolution between them, native ConvolverNode]
//   section 'post' : pedals after the amp (stereo: delays, reverbs…) → volume, width, mute,
//                    output limiter and feedback protection → speakers
// Pedal instances are created when the board changes (message thread), never in process().

import { DSP_CLASSES } from '../dsp/effects.js';
import { Amp } from '../dsp/amp.js';
import { Smooth, softClip, dbToGain, finite } from '../dsp/core.js';
import { PEDALS } from '../shared/defs.js';

const MAXQ = 128;
const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : null;

class Slot {
  constructor(uid, type, fs, bpm) {
    const d = PEDALS[type];
    this.uid = uid; this.type = type; this.def = d;
    this.fx = d ? new DSP_CLASSES[d.dsp](fs, d.voice) : null;
    this.trails = !!(d && d.trails);
    this.on = true; this.fade = new Smooth(1, 6, fs);
    if (this.fx && this.fx.setTempo) this.fx.bpm = bpm;
  }
}

// Karplus-Strong plucked strings playing a slow worship progression.
// Only used when the person turns on the clearly labelled TEST SIGNAL.
const CHORDS = [ // MIDI notes, low to high
  [43, 47, 50, 55, 59, 67], // G
  [42, 45, 50, 57, 62, 66], // D/F#
  [40, 47, 52, 55, 59, 64], // Em
  [48, 52, 55, 60, 64, 67], // Cadd9-ish
];
class TestGuitar {
  constructor(fs) {
    this.fs = fs; this.strings = Array.from({ length: 6 }, () => ({ buf: new Float32Array(Math.ceil(fs / 60) + 2), len: 100, i: 0, last: 0, damp: 0.996 }));
    this.t = 0; this.step = -1; this.bpm = 72; this.seed = 12345;
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 * 2 - 1; }
  pluck(s, midi, vel) {
    const st = this.strings[s], f = 440 * Math.pow(2, (midi - 69) / 12), len = Math.max(4, Math.min(st.buf.length - 1, Math.round(this.fs / f)));
    st.len = len; st.i = 0; let prev = 0;
    const bright = 0.35 + vel * 0.5;
    for (let k = 0; k < len; k++) { const nz = this.rnd(); prev = prev + (nz - prev) * bright; st.buf[k] = prev * vel; }
    st.damp = 0.9965 + vel * 0.0025;
  }
  process(out, n) {
    const eighth = this.fs * 60 / this.bpm / 2;
    for (let i = 0; i < n; i++) {
      const step = Math.floor(this.t / eighth);
      if (step !== this.step) {
        this.step = step;
        const bar = Math.floor(step / 8) % CHORDS.length, pos = step % 8, ch = CHORDS[bar];
        if (pos === 0) for (let s = 0; s < 6; s++) this.pluck(s, ch[s], 0.55 + 0.1 * Math.abs(this.rnd()));
        else { const s = [2, 3, 4, 5, 4, 3, 5][pos - 1]; this.pluck(s, ch[s], 0.35 + 0.25 * Math.abs(this.rnd())); }
      }
      this.t++;
      let y = 0;
      for (let s = 0; s < 6; s++) {
        const st = this.strings[s], a = st.buf[st.i], j = st.i + 1 === st.len ? 0 : st.i + 1, b = st.buf[j];
        const v = (a + b) * 0.5 * st.damp;
        st.buf[st.i] = v; st.i = j; y += a;
      }
      out[i] = y * 0.7;
    }
  }
}

class PedalboardProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.section = o.section === 'post' ? 'post' : 'pre';
    this.fs = sampleRate; this.bpm = 120;
    this.slots = []; this.byUid = new Map();
    this.L = new Float32Array(MAXQ); this.R = new Float32Array(MAXQ); this.dL = new Float32Array(MAXQ); this.dR = new Float32Array(MAXQ);
    // pre: input + gate + amp
    this.inGain = new Smooth(1, 20, this.fs); this.channel = 0; // 0 = input 1, 1 = input 2, 2 = both
    this.gateOn = true; this.gateThr = dbToGain(-62); this.gateRel = 0.12; this.gateEnv = 0; this.gateG = 1; this.gateHold = 0; this.gateOpen = false;
    this.amp = this.section === 'pre' ? new Amp(this.fs) : null; this.ampOn = true; this.ampFade = new Smooth(1, 10, this.fs);
    this.test = null; this.testOn = false;
    // post: output
    this.vol = new Smooth(dbToGain(-6), 30, this.fs); this.mute = new Smooth(0, 15, this.fs); this.width = new Smooth(1, 30, this.fs); this.mono = false;
    this.limG = 1; this.limRel = Math.exp(-1 / (0.12 * this.fs)); this.hot = 0; this.protect = false;
    // meters
    this.mIn = 0; this.mClip = false; this.mOutL = 0; this.mOutR = 0; this.mLim = 1; this.mGate = 1; this.count = 0; this.busy = 0; this.errors = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'chain': {
        const next = [];
        for (const s of m.slots) {
          let slot = this.byUid.get(s.uid);
          if (!slot || slot.type !== s.type) { slot = new Slot(s.uid, s.type, this.fs, this.bpm); }
          if (slot.fx) slot.fx.set(s.params);
          slot.on = !!s.on; slot.fade.set(slot.on ? 1 : 0);
          next.push(slot);
        }
        this.slots = next; this.byUid = new Map(next.map((s) => [s.uid, s]));
        break;
      }
      case 'param': { const s = this.byUid.get(m.uid); if (s && s.fx) s.fx.set(m.params); break; }
      case 'on': { const s = this.byUid.get(m.uid); if (s) { s.on = !!m.on; s.fade.set(s.on ? 1 : 0); } break; }
      case 'tempo': this.bpm = m.bpm; for (const s of this.slots) if (s.fx && s.fx.setTempo) s.fx.setTempo(m.bpm); if (this.test) this.test.bpm = Math.min(90, m.bpm); break;
      case 'amp': if (this.amp) { this.amp.set(m.model, m.params); this.ampOn = !!m.on; this.ampFade.set(this.ampOn ? 1 : 0); } break;
      case 'io':
        if ('inputGain' in m) this.inGain.set(dbToGain(m.inputGain));
        if ('channel' in m) this.channel = m.channel | 0;
        if ('gateOn' in m) this.gateOn = !!m.gateOn;
        if ('gateThr' in m) this.gateThr = dbToGain(m.gateThr);
        if ('gateRel' in m) this.gateRel = Math.max(0.01, m.gateRel / 1000);
        if ('test' in m) { this.testOn = !!m.test; if (this.testOn && !this.test) { this.test = new TestGuitar(this.fs); this.test.bpm = Math.min(90, this.bpm); } }
        break;
      case 'out':
        if ('volume' in m) this.vol.set(dbToGain(m.volume));
        if ('mute' in m) this.mute.set(m.mute ? 0 : 1);
        if ('width' in m) this.width.set(m.width / 100);
        if ('mono' in m) this.mono = !!m.mono;
        break;
      case 'panic': this.resetAll(); break;
      case 'unprotect': this.protect = false; this.hot = 0; break;
    }
  }

  resetAll() { for (const s of this.slots) if (s.fx) s.fx.reset(); if (this.amp) this.amp.reset(); }

  runChain(L, R, n) {
    const dL = this.dL, dR = this.dR;
    for (let k = 0; k < this.slots.length; k++) {
      const s = this.slots[k], fx = s.fx;
      if (!fx) continue;
      if (s.trails) {
        fx.send.set(s.on ? 1 : 0);
        // bypassed and the tail has died away: stop spending CPU on it
        if (!s.on && fx.send.v < 1e-4 && fx.energy < 1e-11) continue;
        fx.process(L, R, n);
      } else {
        const f = s.fade;
        if (f.settled && f.t === 0) continue;
        if (f.settled && f.t === 1) fx.process(L, R, n);
        else {
          dL.set(L.subarray(0, n)); if (R) dR.set(R.subarray(0, n));
          fx.process(L, R, n);
          for (let i = 0; i < n; i++) { const w = f.next(); L[i] = dL[i] + (L[i] - dL[i]) * w; if (R) R[i] = dR[i] + (R[i] - dR[i]) * w; }
        }
      }
      // never let a broken state reach the speakers
      let sum = 0;
      for (let i = 0; i < n; i++) sum += L[i] + (R ? R[i] : 0);
      if (!finite(sum)) { fx.reset(); L.fill(0); if (R) R.fill(0); this.errors++; }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length, L = this.L.subarray(0, n), R = this.R.subarray(0, n);
    const t0 = now ? now() : 0;
    const inp = inputs[0] || [];
    if (this.section === 'pre') {
      // 1) source
      if (this.testOn && this.test) this.test.process(L, n);
      else if (inp.length === 0) L.fill(0);
      else {
        const a = inp[0], b = inp[1] || inp[0];
        if (this.channel === 1) L.set(b); else if (this.channel === 2) for (let i = 0; i < n; i++) L[i] = (a[i] + b[i]) * 0.5; else L.set(a);
      }
      // 2) input gain, meter, gate
      let peak = 0;
      const atk = Math.exp(-1 / (0.001 * this.fs)), rel = Math.exp(-1 / (this.gateRel * this.fs)), hold = 0.05 * this.fs;
      const open = this.gateThr, close = this.gateThr * 0.6;
      for (let i = 0; i < n; i++) {
        const raw = L[i]; if (Math.abs(raw) > peak) peak = Math.abs(raw);
        const x = raw * this.inGain.next();
        if (this.gateOn) {
          const a = Math.abs(x);
          this.gateEnv = a > this.gateEnv ? a : this.gateEnv * 0.9995;
          if (this.gateEnv > open) { this.gateOpen = true; this.gateHold = hold; }
          else if (this.gateEnv < close) { if (this.gateHold > 0) this.gateHold--; else this.gateOpen = false; }
          const target = this.gateOpen ? 1 : 0.0;
          this.gateG = target > this.gateG ? target + (this.gateG - target) * atk : target + (this.gateG - target) * rel;
          L[i] = x * this.gateG;
        } else { this.gateG = 1; L[i] = x; }
      }
      if (peak > this.mIn) this.mIn = peak;
      if (peak >= 0.98) this.mClip = true;
      this.mGate = Math.min(this.mGate, this.gateG);
      // 3) pedals before the amp (mono), 4) amp
      this.runChain(L, null, n);
      const af = this.ampFade;
      if (af.settled && af.t === 0) R.set(L);
      else {
        this.dL.set(L);
        this.amp.process(L, R, n);
        if (!af.settled) for (let i = 0; i < n; i++) { const w = af.next(); L[i] = this.dL[i] + (L[i] - this.dL[i]) * w; R[i] = this.dL[i] + (R[i] - this.dL[i]) * w; }
      }
      let sum = 0; for (let i = 0; i < n; i++) sum += L[i] + R[i];
      if (!finite(sum)) { this.amp.reset(); L.fill(0); R.fill(0); this.errors++; }
      out[0].set(L); if (out[1]) out[1].set(R);
    } else {
      if (inp.length === 0) { L.fill(0); R.fill(0); }
      else { L.set(inp[0]); R.set(inp[1] || inp[0]); }
      this.runChain(L, R, n);
      // output stage
      let pl = 0, pr = 0, minG = 1;
      const ceil = 0.89; // -1 dBFS
      for (let i = 0; i < n; i++) {
        const v = this.vol.next() * this.mute.next(), w = this.width.next();
        let l = L[i] * v, r = R[i] * v;
        const mid = (l + r) * 0.5, side = (l - r) * 0.5 * (this.mono ? 0 : w);
        l = mid + side; r = mid - side;
        const a = Math.max(Math.abs(l), Math.abs(r));
        const need = a > ceil ? ceil / a : 1;
        this.limG = need < this.limG ? need : 1 + (this.limG - 1) * this.limRel;
        if (this.protect) this.limG *= 0.999;
        l *= this.limG; r *= this.limG;
        l = softClip(l * 1.05) * 0.95; r = softClip(r * 1.05) * 0.95; // final safety, never above 0 dBFS
        L[i] = l; R[i] = r;
        if (this.limG < minG) minG = this.limG;
        const al = Math.abs(l), ar = Math.abs(r); if (al > pl) pl = al; if (ar > pr) pr = ar;
      }
      // runaway protection: more than 12 dB of limiting for 1.5 s → fade out, clear delays/reverbs
      if (minG < 0.25) this.hot += n; else this.hot = Math.max(0, this.hot - n);
      if (!this.protect && this.hot > 1.5 * this.fs) { this.protect = true; this.resetAll(); this.port.postMessage({ type: 'protect' }); }
      if (this.protect && this.limG < 1e-4) { L.fill(0); R.fill(0); }
      if (pl > this.mOutL) this.mOutL = pl; if (pr > this.mOutR) this.mOutR = pr; if (minG < this.mLim) this.mLim = minG;
      out[0].set(L); if (out[1]) out[1].set(R);
    }
    if (now) this.busy += now() - t0;
    this.count += n;
    if (this.count >= 2048) {
      const gr = {};
      for (const s of this.slots) if (s.fx && s.fx.grMeter !== undefined) gr[s.uid] = s.fx.grMeter;
      const load = now ? this.busy / (this.count / this.fs * 1000) : null;
      this.port.postMessage(this.section === 'pre'
        ? { type: 'meter', inPeak: this.mIn, inClip: this.mClip, gate: this.mGate, gr, load, errors: this.errors }
        : { type: 'meter', outL: this.mOutL, outR: this.mOutR, lim: this.mLim, load, errors: this.errors, protect: this.protect });
      this.mIn = 0; this.mClip = false; this.mGate = 1; this.mOutL = 0; this.mOutR = 0; this.mLim = 1; this.count = 0; this.busy = 0;
    }
    return true;
  }
}

registerProcessor('sf-pedalboard', PedalboardProcessor);
