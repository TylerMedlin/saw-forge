// Session Pianist acoustic checks (Node, no browser): `node tests/piano-dsp.mjs`
// Renders the real worklet DSP offline and measures loudness, brightness and decay.
import { Piano } from '../src/audio/worklet/piano.js';
import { DrumKit } from '../src/audio/worklet/drums.js';
import { PadEngine } from '../src/audio/worklet/worship.js';
import { PIANO_INDEX as I, PIANO_MODELS } from '../src/shared/piano-params.js';

const SR = 48000, B = 128;
let fails = 0;
const ok = (cond, name, detail) => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const db = (x) => 20 * Math.log10(x + 1e-12);

function render(events, secs, setup) {
  const p = new Piano(SR); if (setup) setup(p);
  const n = Math.round(secs * SR), L = new Float64Array(n), R = new Float64Array(n);
  const ev = [...events].sort((a, b) => a.t - b.t); let e = 0;
  const l = new Float64Array(B), r = new Float64Array(B);
  for (let s = 0; s < n; s += B) {
    while (e < ev.length && ev[e].t * SR <= s) ev[e++].fn(p);
    const m = Math.min(B, n - s); l.fill(0); r.fill(0);
    p.render(l, r, 0, m); p.postProcess(l, r, m); L.set(l.subarray(0, m), s); R.set(r.subarray(0, m), s);
  }
  return { L, R, p };
}
const on = (t, k, v) => ({ t, fn: (p) => p.noteOn(k, v / 127, true) });
const off = (t, k) => ({ t, fn: (p) => p.noteOff(k) });
const ped = (t, v) => ({ t, fn: (p) => p.setPedal(v) });
const rms = (x, a, b) => { let s = 0; const i0 = Math.round(a * SR), i1 = Math.round(b * SR); for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / (i1 - i0)); };
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), p = i + k + len / 2, xr = re[p] * c - im[p] * s, xi = re[p] * s + im[p] * c; re[p] = re[i + k] - xr; im[p] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; } }
}
// spectral centroid (Hz) of a 4096-sample Hann window starting at t
function centroid(x, t, len = 4096) {
  const a = Math.round(t * SR), re = new Float64Array(len), im = new Float64Array(len);
  for (let i = 0; i < len; i++) re[i] = (x[a + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / len));
  fft(re, im); let num = 0, den = 0;
  for (let k = 1; k < len / 2; k++) { const m = Math.hypot(re[k], im[k]); num += m * k * SR / len; den += m; }
  return num / den;
}
const finite = (x) => { for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i]) || Math.abs(x[i]) > 1) return false; return true; };

// A — velocity changes loudness AND brightness
{
  const rows = [15, 40, 75, 105, 127].map((v) => { const { L } = render([on(0, 60, v)], 0.6); return { v, lvl: db(rms(L, 0, 0.3)), c: centroid(L, 0.005) }; });
  const span = rows[4].lvl - rows[0].lvl, cr = rows[4].c / rows[0].c;
  ok(span > 18 && cr > 1.6 && rows.every((r, i) => !i || (r.lvl > rows[i - 1].lvl && r.c > rows[i - 1].c)), 'A velocity', rows.map((r) => `v${r.v}: ${r.lvl.toFixed(1)} dB, ${r.c.toFixed(0)} Hz`).join(' | '));
}
// B — a held C4 decays naturally for 10 s, never held at a constant level, never cut off
{
  const { L } = render([on(0, 60, 80)], 10.5);
  const seg = [0.2, 2, 4, 6, 8, 10].map((t) => db(rms(L, t, t + 0.25)));
  const falling = seg.every((v, i) => !i || v < seg[i - 1]), audible = seg[5] > seg[0] - 55;
  const early = (seg[0] - seg[1]) / 1.8, late = (seg[3] - seg[5]) / 4; // dB/s: two-stage decay (prompt sound, then aftersound)
  ok(falling && audible && early > late, 'B held note', seg.map((v) => v.toFixed(1)).join(' → ') + ` dB; ${early.toFixed(1)} then ${late.toFixed(1)} dB/s`);
}
// C — a quick release: the damper stops the string within ~0.5 s, smoothly
{
  const { L } = render([on(0, 60, 90), off(0.3, 60)], 1.5);
  const before = db(rms(L, 0.2, 0.3)), after = db(rms(L, 0.8, 0.9));
  let jump = 0; const i0 = Math.round(0.3 * SR); for (let i = i0; i < i0 + 4800; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
  ok(before - after > 30 && jump < 0.05, 'C note release', `${before.toFixed(1)} → ${after.toFixed(1)} dB 0.5 s after release, max step ${jump.toFixed(4)}`);
}
// D — pedal: keys up but strings ring; pedal up damps them
{
  const ch = [48, 55, 60, 64];
  const { L } = render([ped(0, 1), ...ch.map((k) => on(0.01, k, 85)), ...ch.map((k) => off(0.4, k)), ped(2.5, 0)], 3.5);
  const dry = render([...ch.map((k) => on(0.01, k, 85)), ...ch.map((k) => off(0.4, k))], 3.5).L;
  const held = db(rms(L, 2.2, 2.45)), dryAt = db(rms(dry, 2.2, 2.45)), damped = db(rms(L, 3.1, 3.4));
  ok(held - dryAt > 25 && held - damped > 25, 'D sustain pedal', `pedal ${held.toFixed(1)} dB vs no pedal ${dryAt.toFixed(1)} dB at 2.2 s; ${damped.toFixed(1)} dB after pedal up`);
  const half = render([ped(0, 0.5), ...ch.map((k) => on(0.01, k, 85)), ...ch.map((k) => off(0.4, k))], 2.5).L;
  const hv = db(rms(half, 1.2, 1.4)), fv = db(rms(L, 1.2, 1.4)), nv = db(rms(dry, 1.2, 1.4));
  ok(hv < fv - 3 && hv > nv + 3, 'D half pedal', `full ${fv.toFixed(1)} / half ${hv.toFixed(1)} / none ${nv.toFixed(1)} dB at 1.2 s`);
}
// E — Softness 100 %: much less high-frequency attack, not merely quieter
{
  const play = (soft) => render([on(0, 60, 64), on(0.5, 64, 64), on(1, 67, 64)], 1.6, (p) => p.applyParam(I.soft, soft)).L;
  const a = play(0), b = play(1);
  const ca = centroid(a, 0.502), cb = centroid(b, 0.502), la = db(rms(a, 0, 1.5)), lb = db(rms(b, 0, 1.5));
  ok(cb < 0.75 * ca && la - lb < 12, 'E softness', `attack centroid ${ca.toFixed(0)} → ${cb.toFixed(0)} Hz; level ${la.toFixed(1)} → ${lb.toFixed(1)} dB`);
  const una = render([on(0, 60, 90)], 1, (p) => p.applyParam(I.una, 1)).L, full = render([on(0, 60, 90)], 1).L;
  ok(centroid(una, 0.005) < centroid(full, 0.005), 'E una corda', `attack centroid ${centroid(full, 0.005).toFixed(0)} → ${centroid(una, 0.005).toFixed(0)} Hz`);
  const modes = PIANO_MODELS.map((m, i) => { const x = render([on(0, 60, 90)], 0.4, (p) => p.applyParam(I.model, i)).L; return `${m.name} ${centroid(x, 0.005).toFixed(0)} Hz`; });
  console.log('      modes (attack centroid, C4 v90):', modes.join(', '));
}
// F — register: decay and brightness differ by octave
{
  const rows = [21, 36, 48, 60, 72, 84, 96, 108].map((k) => {
    const { L } = render([on(0, k, 90)], 3.2), a = db(rms(L, 0.1, 0.3)), b = db(rms(L, 2.8, 3.1));
    return { k, d: (a - b) / 2.75, lvl: a };
  });
  const bassSlow = rows[0].d < rows[3].d && rows[3].d < rows[6].d;
  ok(bassSlow, 'F register', rows.map((r) => `${r.k}: ${r.lvl.toFixed(0)} dB, ${r.d.toFixed(1)} dB/s`).join(' | '));
}
// G — repeated notes (key released between strikes): organic, not identical, not erratic
{
  const ev = []; for (let i = 0; i < 8; i++) { ev.push(on(i * 0.25, 60, 70)); ev.push(off(i * 0.25 + 0.15, 60)); }
  const { L } = render(ev, 2.2);
  const lv = [...Array(8)].map((_, i) => db(rms(L, i * 0.25 + 0.002, i * 0.25 + 0.06)));
  const spread = Math.max(...lv) - Math.min(...lv);
  let diff = 0; const a0 = Math.round(0.5 * SR), a1 = Math.round(0.75 * SR); for (let j = 0; j < 4800; j++) diff += Math.abs(L[a0 + j] - L[a1 + j]);
  ok(spread > 0.1 && spread < 3 && diff > 1e-3, 'G repeated notes', `attack levels ${lv.map((v) => v.toFixed(1)).join(', ')} dB (spread ${spread.toFixed(2)} dB), waveforms differ`);
  const vs = [30, 90, 50, 120, 70].map((v, i) => on(i * 0.3, 60, v)); const x = render([...vs, ...vs.map((e, i) => off(i * 0.3 + 0.2, 60))], 1.6).L;
  const lv2 = vs.map((e, i) => db(rms(x, i * 0.3 + 0.002, i * 0.3 + 0.05)));
  ok(lv2[3] > lv2[1] && lv2[1] > lv2[4] && lv2[4] > lv2[2] && lv2[2] > lv2[0], 'G repeated, varied velocity', lv2.map((v) => v.toFixed(1)).join(', ') + ' dB (v30, 90, 50, 120, 70)');
}
// stability: loud cluster with pedal, all models
{
  let good = true;
  for (let mi = 0; mi < PIANO_MODELS.length; mi++) {
    const ev = [ped(0, 1)]; for (let k = 21; k <= 108; k += 3) ev.push(on(0.002 * k, k, 127));
    const { L, R } = render(ev, 1.5, (p) => p.applyParam(I.model, mi));
    good = good && finite(L) && finite(R);
  }
  ok(good, 'stability', 'every model: 30-note ff cluster with pedal stays finite and under 0 dBFS');
}
// H — full band: piano + drummer kit + worship pad in one block loop; CPU and note timing
{
  const piano = new Piano(SR), kit = new DrumKit(SR), pad = new PadEngine(SR);
  const l = new Float64Array(B), r = new Float64Array(B), secs = 8, blocks = Math.round(secs * SR / B);
  let worst = 0, total = 0;
  pad.noteOn && [48, 55, 60, 64].forEach((k) => pad.noteOn(k, 0.7));
  const chords = [[48, 60, 64, 67], [45, 57, 60, 64], [41, 57, 60, 65], [43, 55, 59, 62]];
  let onset = -1;
  for (let b = 0; b < blocks; b++) {
    const t = b * B / SR;
    if (b % 94 === 0) { const c = chords[(b / 94) % 4]; c.forEach((k) => piano.noteOn(k, 0.75)); }
    if (b % 94 === 60) chords[Math.floor(b / 94) % 4].forEach((k) => piano.noteOff(k));
    if (b % 47 === 0 && kit.noteOn) kit.noteOn(36, 0.9);
    if (b % 47 === 23 && kit.noteOn) kit.noteOn(38, 0.8);
    l.fill(0); r.fill(0);
    const t0 = performance.now();
    for (const inst of [kit, pad]) { inst.beginBlock && inst.beginBlock(120, t * 2, true, B); inst.render(l, r, 0, B); inst.postProcess(l, r, B, null); }
    const pl = new Float64Array(B), pr = new Float64Array(B);
    piano.render(pl, pr, 0, B); piano.postProcess(pl, pr, B);
    const dt = performance.now() - t0; total += dt; if (b > 10) worst = Math.max(worst, dt);
    if (b === 0) for (let i = 0; i < B; i++) if (onset < 0 && Math.abs(pl[i]) > 1e-6) onset = i;
  }
  const blockMs = B / SR * 1000, load = total / (blocks * blockMs);
  ok(load < 0.35 && onset >= 0 && onset < 8, 'H full band', `avg load ${(load * 100).toFixed(1)} % of real time (piano + drums + pad), worst block ${worst.toFixed(2)} of ${blockMs.toFixed(2)} ms, piano onset at sample ${onset}`);
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall piano checks passed');
process.exit(fails ? 1 : 0);
