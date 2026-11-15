// Worship Pedalboard DSP checks (no browser needed): node tests/pedalboard-dsp.mjs
// Renders a synthetic plucked-string signal through the real pedal and amp classes.

import { DSP_CLASSES } from '../pedalboard/src/dsp/effects.js';
import { Amp } from '../pedalboard/src/dsp/amp.js';
import { PEDALS, AMPS, pedalDefaults, ampDefaults } from '../pedalboard/src/shared/defs.js';

const fs = 48000, Q = 128;
let fails = 0;
const ok = (cond, name, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!cond) fails++; };

function pluck(seconds, f = 196, amp = 0.3, at = 0) {
  const n = Math.round(seconds * fs), out = new Float32Array(n), len = Math.round(fs / f), buf = new Float32Array(len);
  let seed = 7, prev = 0;
  for (let k = 0; k < len; k++) { seed = (seed * 1664525 + 1013904223) >>> 0; prev += ((seed / 4294967296) * 2 - 1 - prev) * 0.6; buf[k] = prev * amp; }
  let i = 0;
  for (let s = Math.round(at * fs); s < n; s++) { const a = buf[i], j = (i + 1) % len; buf[i] = (a + buf[j]) * 0.5 * 0.998; i = j; out[s] = a; }
  return out;
}
const peak = (a, from = 0, to = a.length) => { let p = 0; from = Math.round(from); to = Math.round(to); for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p; };
const rms = (a, from = 0, to = a.length) => { let s = 0; from = Math.round(from); to = Math.round(to); for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };
const allFinite = (a) => a.every(Number.isFinite);

// run fx over a mono signal in 128-sample blocks; stereo=true returns [L, R]
function render(fx, input, stereo = false) {
  const L = Float32Array.from(input), R = stereo ? Float32Array.from(input) : null;
  for (let o = 0; o < L.length; o += Q) { const n = Math.min(Q, L.length - o); fx.process(L.subarray(o, o + n), R ? R.subarray(o, o + n) : null, n); }
  return stereo ? [L, R] : L;
}
const make = (type, over = {}) => { const d = PEDALS[type], fx = new DSP_CLASSES[d.dsp](fs, d.voice); fx.set({ ...pedalDefaults(type), ...over }); return fx; };

// distortion: share of energy that is not the fundamental (a pure sine goes in)
const sine = (f, amp, sec = 1) => Float32Array.from({ length: Math.round(sec * fs) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / fs));
function thd(a, f, from = Math.round(0.3 * fs)) {
  const N = a.length - from; let re = 0, im = 0, tot = 0;
  for (let i = from; i < a.length; i++) { const w = 2 * Math.PI * f * i / fs; re += a[i] * Math.cos(w); im += a[i] * Math.sin(w); tot += a[i] * a[i]; }
  const fund = 2 * (re * re + im * im) / N; return Math.max(0, tot - fund) / tot;
}

const dry = pluck(2, 110, 0.35);

// every pedal renders finite audio
for (const type of Object.keys(PEDALS)) {
  const out = render(make(type), dry, PEDALS[type].place === 'post');
  const L = Array.isArray(out) ? out[0] : out;
  ok(allFinite(L) && peak(L) > 0.01 && peak(L) < 4, `${type} renders`, `peak ${peak(L).toFixed(2)}`);
}

// compressor reduces dynamics
{
  const loud = pluck(2, 196, 0.6), out = render(make('studio-comp', { blend: 100, level: 0 }), loud);
  const s0 = rms(loud, 0.9 * fs, fs) / rms(loud, 0.05 * fs, 0.15 * fs), s1 = rms(out, 0.9 * fs, fs) / rms(out, 0.05 * fs, 0.15 * fs);
  ok(s1 > s0 * 1.5, 'compressor evens out dynamics (more sustain)', `late/early level ${s0.toFixed(2)} → ${s1.toFixed(2)}`);
}

// drive adds harmonics and responds to picking strength
{
  const fx1 = make('midhump-od', { drive: 70 }), fx2 = make('midhump-od', { drive: 70 });
  const hs = thd(render(fx1, sine(220, 0.02)), 220), hh = thd(render(fx2, sine(220, 0.4)), 220);
  const clean = thd(sine(220, 0.4), 220);
  ok(hh > clean * 1.3, 'overdrive adds high harmonics', `clean ${clean.toFixed(4)} driven ${hh.toFixed(4)}`);
  ok(hh > hs * 1.2, 'overdrive cleans up with lighter picking', `soft ${hs.toFixed(4)} hard ${hh.toFixed(4)}`);
}

// delay: repeats land at the tempo-synced time
{
  const imp = new Float32Array(fs * 2); imp[0] = 1;
  const fx = make('dotted-delay', { mod: 0, mix: 100, feedback: 0, lowcut: 40, tone: 12000, mode: 2 });
  fx.setTempo(100); // dotted 8th at 100 bpm = 450 ms
  fx.time.jump(fx.time.t);
  const [L] = render(fx, imp, true);
  let best = 0, at = 0; for (let i = 100; i < L.length; i++) if (Math.abs(L[i]) > best) { best = Math.abs(L[i]); at = i; }
  ok(Math.abs(at / fs * 1000 - 450) < 2, 'dotted-eighth repeat at 100 bpm', `${(at / fs * 1000).toFixed(1)} ms`);
}

// delay feedback at max stays bounded
{
  const fx = make('digital-delay', { feedback: 100, mix: 100 });
  const [L] = render(fx, pluck(6, 220, 0.9), true);
  ok(allFinite(L) && peak(L) < 6, 'delay at max feedback stays bounded', `peak ${peak(L).toFixed(2)}`);
}

// reverb: tail decays, roughly at the set decay time
{
  const imp = new Float32Array(fs * 6); imp[0] = 0.5;
  const fx = make('hall-reverb', { decay: 2, mix: 100, predelay: 0 });
  const [L, R] = render(fx, imp, true);
  const e1 = rms(L, 0.2 * fs, 0.4 * fs), e2 = rms(L, 2.2 * fs, 2.4 * fs);
  const drop = 20 * Math.log10(e1 / e2);
  ok(drop > 35 && drop < 80, 'hall reverb decays close to its decay time', `${drop.toFixed(1)} dB over 2 s (target 60 → RT60)`);
  ok(rms(L, 5.5 * fs, 6 * fs) < 1e-4, 'reverb tail dies away');
  let c = 0, a = 0, b = 0; for (let i = 0.1 * fs; i < fs; i++) { c += L[i] * R[i]; a += L[i] * L[i]; b += R[i] * R[i]; }
  ok(Math.abs(c / Math.sqrt(a * b)) < 0.6, 'reverb is wide stereo', `L/R correlation ${(c / Math.sqrt(a * b)).toFixed(2)}`);
}

// bypassed trails keep ringing (spillover)
{
  const fx = make('hall-reverb', { mix: 100, decay: 4 });
  const [L1] = render(fx, pluck(0.5, 220, 0.3), true);
  fx.send.set(0);
  const [L2] = render(fx, new Float32Array(fs), true);
  ok(rms(L2, 0.2 * fs, 0.5 * fs) > 1e-3, 'reverb tail continues after bypass');
}

// amp: every model is finite, clean amps stay clean at low gain, higher gain = more harmonics
for (const m of AMPS) {
  const a = new Amp(fs); a.set(m.id, ampDefaults());
  const L = Float32Array.from(dry), R = new Float32Array(L.length);
  for (let o = 0; o < L.length; o += Q) a.process(L.subarray(o, o + Q), R.subarray(o, o + Q), Q);
  ok(allFinite(L) && allFinite(R) && peak(L) > 0.02 && peak(L) < 1.5, `amp ${m.id}`, `peak ${peak(L).toFixed(2)} rms ${(20 * Math.log10(rms(L))).toFixed(1)} dB`);
}
{
  const lo = new Amp(fs), hi = new Amp(fs);
  lo.set('modern-clean', { ...ampDefaults(), gain: 10 }); hi.set('british-crunch', { ...ampDefaults(), gain: 90 });
  const run = (a) => { const L = sine(220, 0.3), R = new Float32Array(L.length); for (let o = 0; o < L.length; o += Q) a.process(L.subarray(o, o + Q), R.subarray(o, o + Q), Q); return L; };
  const tl = thd(run(lo), 220), th = thd(run(hi), 220);
  ok(th > tl * 3, 'crunch amp breaks up more than clean amp', `distortion clean ${(tl * 100).toFixed(2)} % crunch ${(th * 100).toFixed(1)} %`);
  ok(tl < 0.03, 'clean amp at low gain stays clean', `${(tl * 100).toFixed(2)} %`);
}

// order matters: drive→delay differs from delay→drive
{
  const a1 = make('midhump-od', { drive: 80 }), d1 = make('digital-delay', { mix: 60 });
  const a2 = make('midhump-od', { drive: 80 }), d2 = make('digital-delay', { mix: 60 });
  const x = pluck(1.5, 165, 0.4);
  const o1 = render(d1, render(a1, x)), o2 = render(a2, render(d2, x));
  let diff = 0; for (let i = 0; i < o1.length; i++) diff += (o1[i] - o2[i]) ** 2;
  ok(Math.sqrt(diff / o1.length) > 0.005, 'reordering pedals changes the sound', `rms difference ${Math.sqrt(diff / o1.length).toFixed(4)}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
