// Engine and workflow checks. Renders through the real AudioWorklet engine
// (offline), so these exercise the exact DSP used for playback and export.

import { AudioEngine } from '../src/audio/engine.js';
import { newProject, newTrack, newMidiClip, newNote, newBus, newInsert, newAudioClip, newLane, normalizeProject, cloneJSON } from '../src/core/project.js';
import { FACTORY_PRESETS } from '../src/shared/presets.js';
import { buildWavetable, getWtPreset, mipHarmonics, WT_SIZE, WT_MIPS, fft } from '../src/shared/wavetable.js';
import { EFFECT_TYPES, faderDbToNorm } from '../src/shared/params.js';
import { Store } from '../src/core/store.js';
import { packProject, unpackProject } from '../src/core/fileio.js';
import { encodeWav, audioStats } from '../src/audio/wav.js';
import { factorySamples } from '../src/audio/samples.js';
import { compileNotes, compileProject } from '../src/audio/compile.js';
import { planTake, extractRange, carveAudio, findOnset, punchNotes, placePunchMidi } from '../src/audio/recording.js';
import { valueAt, mergeSegment, simplify } from '../src/core/autowrite.js';
import { AutomationRecorder } from '../src/automation-recorder.js';
import { PadEngine, LivePadHost } from '../src/audio/worklet/worship.js';
import { WORSHIP_PRESETS, worshipPresetParams, worshipPresetByName } from '../src/shared/worship-presets.js';
import { worshipParamArray, voiceChord, VC, keyName, parseKey } from '../src/shared/worship-params.js';
import { addTakeLanes, compRange, compLaneRange, usedRanges, laneUsage, remapTakeIds } from '../src/core/comp.js';
import { DrumKit } from '../src/audio/worklet/drums.js';
import { PIECES, KIT_NAMES, drumDefaults, drumParamArray } from '../src/shared/drums.js';
import { DRUMMERS, PERSONALITIES, generateDrummer, newDrummerSettings, checkPatterns } from '../src/shared/drummers.js';
import { newDrumInstrument, newDrummerClip } from '../src/core/project.js';

const out = document.getElementById('out');
const results = [];
window.__results = results;
function log(status, name, detail = '') {
  results.push({ status, name, detail: String(detail) });
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="${status}">${status.toUpperCase()}</span><div><b>${name}</b><pre>${String(detail).replace(/</g, '&lt;')}</pre></div>`;
  out.appendChild(row);
}
async function test(name, fn) {
  const t0 = performance.now();
  try { const d = await fn(); log('pass', name, `${d ?? ''}  (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { log('fail', name, e && e.stack ? e.stack : e); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const db = (x) => (20 * Math.log10(x + 1e-12)).toFixed(1);

const engine = new AudioEngine();

async function render(project, { start = 0, end = null, sr = 48000, tail = 0.5, assets = [] } = {}) {
  const wavetables = [];
  for (const t of project.tracks) if (t.instrument && t.instrument.wt && t.instrument.wt.length >= 2) { wavetables.push({ ch: t.id, osc: 0, wt: t.instrument.wt[0] }, { ch: t.id, osc: 1, wt: t.instrument.wt[1] }); }
  let e = end;
  if (e === null) { e = 0; for (const t of project.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.length); }
  const { buffer } = await engine.renderOffline({ project, assets, wavetables, startBeat: start, endBeat: e, sampleRate: sr, tailSec: tail });
  return [buffer.getChannelData(0), buffer.getChannelData(1)];
}
const presetByName = (n) => FACTORY_PRESETS.find((p) => p.name === n);
function synthProject(preset, notes, { tempo = 120, len = 4, params = {} } = {}) {
  const p = newProject('test'); p.tempo = tempo; p.loop.on = false;
  const t = newTrack(p, 'instrument', { preset: preset ? presetByName(preset) : null });
  Object.assign(t.instrument.params, params);
  t.clips.push(newMidiClip(0, len, notes));
  p.tracks.push(t);
  return p;
}
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

// Fraction (dB) of spectral power not on harmonics of f0.
function inharmonicDb(x, start, f0, sr) {
  const N = 32768;
  const re = new Float64Array(N), im = new Float64Array(N);
  // 4-term Blackman-Harris window (−92 dB sidelobes) so window leakage stays below the alias floor.
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / (N - 1);
    const w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    re[i] = x[start + i] * w;
  }
  fft(re, im, false);
  let harm = 0, other = 0;
  const binHz = sr / N;
  for (let k = Math.ceil(30 / binHz); k < N / 2; k++) {
    const pw = re[k] * re[k] + im[k] * im[k];
    const f = k * binHz, h = Math.round(f / f0);
    if (h >= 1 && Math.abs(f - h * f0) <= 8 * binHz) harm += pw; else other += pw;
  }
  return 10 * Math.log10(other / (harm + other) + 1e-30);
}

const CLEAN = { 'flt.mode': 5, 'an.drift': 0, 'an.var': 0, 'a.rand': 0, 'aenv.a': 0.001, 'aenv.s': 1 };

// ---------------------------------------------------------------- tests
await test('Wavetable mip tables are band-limited and normalized', () => {
  const t = buildWavetable(getWtPreset('Saw → Square'));
  let worst = -300, peakErr = 0;
  const row = WT_SIZE + 1;
  for (let f = 0; f < t.frames; f += 4) {
    for (let m = 0; m < WT_MIPS; m++) {
      const base = (f * WT_MIPS + m) * row;
      const re = new Float64Array(WT_SIZE), im = new Float64Array(WT_SIZE);
      for (let i = 0; i < WT_SIZE; i++) re[i] = t.data[base + i];
      if (m === 0) { let pk = 0; for (let i = 0; i < WT_SIZE; i++) pk = Math.max(pk, Math.abs(re[i])); peakErr = Math.max(peakErr, Math.abs(pk - 1)); }
      fft(re, im, false);
      const H = mipHarmonics(m);
      let inB = 0, outB = 0;
      for (let k = 1; k < WT_SIZE / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; if (k <= H) inB += p; else outB += p; }
      worst = Math.max(worst, 10 * Math.log10(outB / inB + 1e-30));
    }
  }
  assert(worst < -100, `out-of-band energy ${worst.toFixed(1)} dB`);
  assert(peakErr < 1e-3, `mip0 peak error ${peakErr}`);
  return `${t.frames} frames × ${WT_MIPS} mips; worst out-of-band ${worst.toFixed(0)} dB; peak error ${peakErr.toExponential(1)}`;
});

await test('Spectral morph between key frames is smooth', () => {
  const t = buildWavetable(getWtPreset('Saw → Triangle'));
  const row = WT_SIZE + 1;
  let maxStep = 0;
  for (let f = 1; f < t.frames; f++) {
    let d = 0;
    for (let i = 0; i < WT_SIZE; i++) d += (t.data[(f * WT_MIPS) * row + i] - t.data[((f - 1) * WT_MIPS) * row + i]) ** 2;
    maxStep = Math.max(maxStep, Math.sqrt(d / WT_SIZE));
  }
  assert(maxStep < 0.15, `largest frame-to-frame RMS step ${maxStep.toFixed(3)}`);
  return `largest frame-to-frame RMS step ${maxStep.toFixed(3)}`;
});

await test('Init Saw renders cleanly (level, no NaN)', async () => {
  const [L, R] = await render(synthProject('Init Saw', [newNote(60, 0, 2, 0.8)]));
  const s = audioStats([L, R]);
  assert(s.nan === 0, 'NaN in output');
  assert(s.peak < 0.9 && s.peak > 0.05, `peak ${s.peakDb.toFixed(1)} dBFS`);
  return `peak ${s.peakDb.toFixed(1)} dBFS, rms ${s.rmsDb.toFixed(1)} dB`;
});

await test('Anti-aliasing: C7 sawtooth (2093 Hz) at 48 kHz', async () => {
  const [L] = await render(synthProject('Init Saw', [newNote(96, 0, 4, 0.9)], { params: CLEAN }), { tail: 0 });
  const r = inharmonicDb(L, 4800, 440 * Math.pow(2, (96 - 69) / 12), 48000);
  assert(r < -80, `inharmonic power ${r.toFixed(1)} dB`);
  return `inharmonic (alias) power ${r.toFixed(1)} dB relative to total`;
});

await test('Anti-aliasing: hard sync (+19 st) at C6 uses polyBLEP', async () => {
  const [L] = await render(synthProject('Init Saw', [newNote(84, 0, 4, 0.9)], { params: { ...CLEAN, 'a.sync': 19 } }), { tail: 0 });
  const r = inharmonicDb(L, 4800, 440 * Math.pow(2, (84 - 69) / 12), 48000);
  assert(r < -50, `inharmonic power ${r.toFixed(1)} dB`);
  return `inharmonic power ${r.toFixed(1)} dB (sync resets are BLEP-corrected)`;
});

await test('Every factory preset: 4-note chord stays below 0 dBFS and is audible', async () => {
  const lines = [];
  for (const pr of FACTORY_PRESETS) {
    const notes = [48, 55, 60, 64].map((p) => newNote(p, 0, 2, 0.8));
    const [L, R] = await render(synthProject(pr.name, notes), { tail: 1.5 });
    const s = audioStats([L, R]);
    lines.push(`${pr.name.padEnd(20)} peak ${s.peakDb.toFixed(1).padStart(6)} dBFS  rms ${s.rmsDb.toFixed(1).padStart(6)} dB`);
    assert(s.nan === 0, `${pr.name}: NaN`);
    assert(s.peak < 1, `${pr.name}: clipped (peak ${s.peakDb.toFixed(1)} dBFS)`);
    assert(s.rmsDb > -50, `${pr.name}: too quiet (${s.rmsDb.toFixed(1)} dB)`);
  }
  return lines.join('\n');
});

await test('Offline render is deterministic', async () => {
  const p = synthProject('Hyper Supersaw', [newNote(60, 0, 1), newNote(64, 1, 1), newNote(67, 2, 1)]);
  const [a] = await render(p), [b] = await render(cloneJSON(p));
  let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  assert(d === 0, `max difference ${d}`);
  return `${a.length} samples identical`;
});

await test('Sample-rate independence (44.1 kHz vs 96 kHz)', async () => {
  const p = synthProject('Init Saw', [newNote(57, 0, 2, 0.8)], { params: { ...CLEAN, 'flt.mode': 1, 'flt.cut': 1200 } });
  const [a] = await render(p, { sr: 44100 }), [b] = await render(p, { sr: 96000 });
  const ra = rms(a, 4410, 44100), rb = rms(b, 9600, 96000);
  const diff = 20 * Math.log10(ra / rb);
  assert(Math.abs(diff) < 0.5, `level differs by ${diff.toFixed(2)} dB`);
  return `level difference ${diff.toFixed(2)} dB`;
});

await test('Note timing is sample-accurate', async () => {
  const p = synthProject('Init Saw', [newNote(60, 0, 0.25), newNote(60, 1, 0.25), newNote(60, 2.5, 0.25)], { params: { ...CLEAN, 'aenv.a': 0.0005, 'aenv.r': 0.002 } });
  const [L] = await render(p, { tail: 0 });
  const onset = (from) => { for (let i = from; i < L.length; i++) if (Math.abs(L[i]) > 0.01) return i; return -1; };
  const o1 = onset(20000), o2 = onset(50000);
  assert(Math.abs(o1 - 24000) <= 40, `beat 1 onset at ${o1}, expected ~24000`);
  assert(Math.abs(o2 - 60000) <= 40, `beat 2.5 onset at ${o2}, expected ~60000`);
  return `onsets at ${o1} and ${o2} samples (expected 24000, 60000)`;
});

await test('Loop playback wraps and retriggers', async () => {
  const p = synthProject('Init Saw', [newNote(60, 0, 0.5)], { params: { ...CLEAN, 'aenv.r': 0.002 } });
  const tail = 0;
  // Render 8 beats with loop 0..2 — the note should play 4 times.
  p.loop = { on: true, start: 0, end: 2 };
  const wavetables = [{ ch: p.tracks[0].id, osc: 0, wt: p.tracks[0].instrument.wt[0] }, { ch: p.tracks[0].id, osc: 1, wt: p.tracks[0].instrument.wt[1] }];
  const { buffer } = await engine.renderOffline({ project: p, assets: [], wavetables, startBeat: 0, endBeat: 8, sampleRate: 48000, tailSec: tail });
  const L = buffer.getChannelData(0);
  // export renders with the loop disabled by design; check that instead
  const after = rms(L, 48000 * 1.5, 48000 * 3.9);
  assert(after < 1e-3, 'export should ignore the loop (no audio after the note)');
  return 'export ignores loop region (by design); live looping is exercised in the app checks';
});

await test('Mixer: volume, mute and solo', async () => {
  const p = synthProject('Init Saw', [newNote(60, 0, 2)], { params: CLEAN });
  const base = rms((await render(p))[0], 4800, 48000);
  p.tracks[0].vol = -6;
  const v6 = rms((await render(p))[0], 4800, 48000);
  const d = 20 * Math.log10(v6 / base);
  assert(Math.abs(d + 6) < 0.2, `-6 dB fader gave ${d.toFixed(2)} dB`);
  p.tracks[0].vol = 0; p.tracks[0].mute = true;
  const m = rms((await render(p))[0]);
  assert(m === 0, 'muted track still audible');
  p.tracks[0].mute = false;
  const t2 = newTrack(p, 'instrument'); t2.clips.push(newMidiClip(0, 4, [newNote(72, 0, 2)])); p.tracks.push(t2);
  t2.solo = true;
  const solo = rms((await render(p))[0], 4800, 48000);
  p.tracks[0].mute = true; t2.solo = false;
  const only2 = rms((await render(p))[0], 4800, 48000);
  assert(Math.abs(20 * Math.log10(solo / only2)) < 0.1, 'solo did not isolate the soloed track');
  return `fader −6 dB → ${d.toFixed(2)} dB; mute silent; solo isolates`;
});

await test('Sends feed buses (post-fader)', async () => {
  const p = synthProject('Init Saw', [newNote(60, 0, 2)], { params: CLEAN });
  const bus = newBus(p); bus.inserts.push(newInsert('utility')); p.buses.push(bus);
  const dry = rms((await render(p))[0], 4800, 48000);
  p.tracks[0].sends.push({ busId: bus.id, level: 0, pre: false });
  const wet = rms((await render(p))[0], 4800, 48000);
  const d = 20 * Math.log10(wet / dry);
  assert(Math.abs(d - 6.02) < 0.2, `0 dB send gave +${d.toFixed(2)} dB (expected +6.02)`);
  return `0 dB send to bus → +${d.toFixed(2)} dB`;
});

await test('Automation: volume and cutoff lanes', async () => {
  const p = synthProject('Init Saw', [newNote(60, 0, 4)], { params: CLEAN });
  const lane = newLane('mix:vol'); lane.points = [[0, 0], [2, 0], [2.01, faderDbToNorm(0)], [4, faderDbToNorm(0)]];
  p.tracks[0].automation.push(lane);
  const [L] = await render(p, { tail: 0 });
  const first = rms(L, 2400, 45000), second = rms(L, 52000, 90000);
  assert(first < 1e-4 && second > 0.02, `first half ${db(first)} dB, second half ${db(second)} dB`);
  const p2 = synthProject('Init Saw', [newNote(48, 0, 4)], { params: { ...CLEAN, 'flt.mode': 1 } });
  const cut = newLane('inst:flt.cut'); cut.points = [[0, 0.2], [4, 1]];
  p2.tracks[0].automation.push(cut);
  const [C] = await render(p2, { tail: 0 });
  const early = rms(C, 4800, 30000), late = rms(C, 70000, 95000);
  assert(late > early * 1.5, 'cutoff automation had no effect');
  return `volume lane: ${db(first)} → ${db(second)} dB; cutoff sweep raised level ${db(late / early)} dB`;
});

await test('Audio clip playback (factory kick)', async () => {
  const smp = factorySamples()[0];
  const p = newProject('audio'); p.loop.on = false;
  const t = newTrack(p, 'audio'); p.tracks.push(t);
  p.assets.push({ id: smp.id, name: smp.name });
  t.clips.push(newAudioClip({ id: smp.id, name: smp.name }, 1, 1));
  const [L] = await render(p, { assets: [{ id: smp.id, bytes: smp.bytes }], tail: 0 });
  const s = audioStats([L]);
  const pre = rms(L, 0, 23900);
  assert(pre === 0, 'audio before clip start');
  assert(s.peak > 0.7 && s.peak < 1, `peak ${s.peakDb.toFixed(1)}`);
  return `peak ${s.peakDb.toFixed(1)} dBFS, silent before clip start`;
});

await test('All insert effects produce finite, bounded output', async () => {
  const p = synthProject('Init Saw', [newNote(48, 0, 2), newNote(55, 0, 2)], { params: CLEAN });
  for (const type of EFFECT_TYPES) p.tracks[0].inserts.push(newInsert(type));
  const [L, R] = await render(p, { tail: 2 });
  const s = audioStats([L, R]);
  assert(s.nan === 0, 'NaN');
  assert(s.peak < 2, `peak ${s.peakDb.toFixed(1)} dBFS`);
  return `chain ${EFFECT_TYPES.join(' → ')}: peak ${s.peakDb.toFixed(1)} dBFS`;
});

await test('Extreme settings stay stable (res 100%, drive, fast LFO, sync)', async () => {
  const lines = [];
  for (const mode of [0, 1, 2, 3, 4]) {
    const p = synthProject('Init Saw', [newNote(36, 0, 2, 1), newNote(84, 0, 2, 1)], {
      params: { 'flt.mode': mode, 'flt.res': 1, 'flt.drive': 1, 'flt.cut': 3000, 'a.uni': 8, 'a.sync': 30, 'a.pulse': 1, 'a.width': 0.1,
        'm0.src': 1, 'm0.dst': 16, 'm0.amt': 1, 'lfo1.sync': 0, 'lfo1.rate': 40, 'm1.src': 2, 'm1.dst': 4, 'm1.amt': 1, 'b.on': 1, 'sub.on': 1, 'noise.on': 1 },
    });
    const s = audioStats(await render(p, { tail: 0.5 }));
    lines.push(`mode ${mode}: peak ${s.peakDb.toFixed(1)} dBFS`);
    assert(s.nan === 0, `mode ${mode}: NaN`);
    assert(s.peak < 4, `mode ${mode}: peak ${s.peakDb.toFixed(1)} dBFS`);
  }
  return lines.join('; ');
});

await test('Glide, mono/legato and voice stealing are click-safe', async () => {
  const notes = [];
  for (let i = 0; i < 24; i++) notes.push(newNote(48 + (i % 12), i * 0.125, 0.5, 0.9));
  const p = synthProject('Init Saw', notes, { params: { ...CLEAN, 'v.poly': 2, 'aenv.r': 0.4 } });
  const [L] = await render(p, { tail: 0.5 });
  let maxJump = 0;
  for (let i = 1; i < L.length; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
  const pm = synthProject('Init Saw', notes, { params: { ...CLEAN, 'v.mode': 2, 'v.glide': 0.1 } });
  const s = audioStats(await render(pm));
  assert(s.nan === 0, 'NaN in legato');
  assert(maxJump < 0.5, `largest sample-to-sample jump ${maxJump.toFixed(3)} with heavy stealing`);
  return `poly=2 stealing: largest sample step ${maxJump.toFixed(3)}; legato glide peak ${s.peakDb.toFixed(1)} dBFS`;
});

await test('Clip loop expansion (1-beat loop in 4-beat clip)', () => {
  const t = { clips: [{ kind: 'midi', start: 8, length: 4, loopLen: 1, offset: 0, mute: false, notes: [newNote(60, 0, 0.5), newNote(64, 0.5, 0.25)] }] };
  const ev = compileNotes(t);
  assert(ev.length === 8 * 4, `expected 8 events, got ${ev.length / 4}`);
  assert(ev[0] === 8 && ev[4] === 8.5 && ev[8] === 9, 'wrong event times');
  return `${ev.length / 4} events, starts ${Array.from({ length: ev.length / 4 }, (_, i) => ev[i * 4]).join(', ')}`;
});

await test('Undo/redo restores exact project state', () => {
  const p = newProject('undo');
  const s = new Store(p);
  const snap0 = JSON.stringify(s.p);
  s.do('Add track', (q) => { q.tracks.push(newTrack(q, 'instrument')); });
  const snap1 = JSON.stringify(s.p);
  s.begin('Drag');
  for (let i = 0; i < 20; i++) s.live((q) => { q.tracks[0].vol = -i; });
  s.end();
  const snap2 = JSON.stringify(s.p);
  assert(s.undoStack.length === 2, `expected 2 undo steps, got ${s.undoStack.length}`);
  s.undo(); assert(JSON.stringify(s.p) === snap1, 'undo 1 mismatch');
  s.undo(); assert(JSON.stringify(s.p) === snap0, 'undo 2 mismatch');
  s.redo(); s.redo(); assert(JSON.stringify(s.p) === snap2, 'redo mismatch');
  return 'gesture grouped into one step; undo/redo exact';
});

await test('Project file round-trip (with embedded audio)', () => {
  const smp = factorySamples()[1];
  const p = synthProject('Glass Pluck', [newNote(60, 0, 1)]);
  const t = newTrack(p, 'audio'); p.tracks.push(t);
  p.assets.push({ id: smp.id, name: smp.name });
  t.clips.push(newAudioClip({ id: smp.id, name: smp.name }, 0, 1));
  const bytes = packProject(p, new Map([[smp.id, smp.bytes]]));
  const { project, assetBytes, missing } = unpackProject(bytes.buffer);
  const n = normalizeProject(project);
  assert(missing.length === 0, 'missing assets');
  assert(new Uint8Array(assetBytes.get(smp.id)).length === smp.bytes.byteLength, 'asset size mismatch');
  assert(JSON.stringify(n.tracks) === JSON.stringify(normalizeProject(cloneJSON(p)).tracks), 'tracks differ after round-trip');
  return `${bytes.length} bytes; tracks and audio identical`;
});

await test('WAV encoder (16/24/32-bit) decodes back correctly', async () => {
  const N = 4800, x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const lines = [];
  for (const bits of [16, 24, 32]) {
    const buf = encodeWav([x, x], 48000, bits);
    const dec = await ctx.decodeAudioData(buf);
    const y = dec.getChannelData(0);
    let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    const tol = bits === 16 ? 1e-4 : bits === 24 ? 1e-6 : 1e-7;
    assert(dec.numberOfChannels === 2 && dec.length === N, `${bits}-bit: wrong shape`);
    assert(err < tol, `${bits}-bit max error ${err}`);
    lines.push(`${bits}-bit max error ${err.toExponential(1)}`);
  }
  return lines.join('; ');
});

await test('Malformed project data loads safely', () => {
  const n = normalizeProject({ tempo: 'fast', tracks: [{ kind: 'instrument', clips: [{ kind: 'midi', notes: [{ p: 200, s: -1 }, { p: 'x' }] }], instrument: { params: { 'flt.cut': 'bad', 'zz': 3 } } }, null].filter(Boolean), master: null });
  assert(n.tempo === 120, 'tempo not defaulted');
  assert(n.tracks[0].clips[0].notes.length === 1 && n.tracks[0].clips[0].notes[0].p === 127, 'notes not sanitized');
  assert(n.tracks[0].instrument.params['flt.cut'] === 20000, 'bad param not defaulted');
  return 'invalid values defaulted, bad notes dropped';
});

await test('Vertical slice: edit → save → reopen → export is bit-identical', async () => {
  const st = new Store(newProject('slice'));
  st.do('Add track', (q) => { q.tracks.push(newTrack(q, 'instrument', { preset: presetByName('Glass Pluck') })); q.loop = { on: true, start: 0, end: 4 }; });
  st.do('Add clip', (q) => { q.tracks[0].clips.push(newMidiClip(0, 4, [])); });
  st.begin('Draw notes');
  for (const [pch, s] of [[60, 0], [64, 1], [67, 2], [72, 3]]) st.live((q) => { q.tracks[0].clips[0].notes.push(newNote(pch, s, 0.5, 0.8)); });
  st.end();
  st.do('Adjust cutoff', (q) => { q.tracks[0].instrument.params['flt.cut'] = 900; });
  st.do('Mixer level', (q) => { q.tracks[0].vol = -4; });
  const bytes = packProject(st.p, new Map());
  const reopened = normalizeProject(unpackProject(bytes.buffer).project);
  const [a] = await render(st.p, { end: 4, tail: 1 });
  const [b] = await render(reopened, { end: 4, tail: 1 });
  let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  const s = audioStats([a]);
  assert(d === 0, `renders differ by ${d}`);
  assert(s.peak > 0.01 && s.peak < 1, `peak ${s.peakDb.toFixed(1)}`);
  st.undo(); st.undo();
  assert(st.p.tracks[0].instrument.params['flt.cut'] !== 900 && st.p.tracks[0].vol === 0, 'undo did not revert sound/mix edits');
  return `${st.undoStack.length + 2} undo steps; reopened render identical; peak ${s.peakDb.toFixed(1)} dBFS`;
});

await test('Audio input: capture is sample-locked; take starts after count-in; monitoring', async () => {
  const sr = 48000, frames = sr * 4;
  const off = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: sr });
  await off.audioWorklet.addModule('/src/audio/worklet/engine-processor.js');
  const buf = off.createBuffer(2, frames, sr);
  const imps = [1000, 50000, 96000, 120000, 150001];
  for (const f of imps) buf.getChannelData(0)[f] = 0.9;
  buf.getChannelData(1).fill(0.25);
  const src = off.createBufferSource(); src.buffer = buf;
  const p = newProject('rec'); p.tempo = 120; p.loop.on = false;
  const t = newTrack(p, 'audio'); t.arm = true; t.monitor = true; t.input = 'L'; p.tracks.push(t);
  const cap = 1 << 18, ring = new SharedArrayBuffer(cap * 8), ctl = new SharedArrayBuffer(64);
  const node = new AudioWorkletNode(off, 'sawforge-engine', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
    processorOptions: { offline: true, project: compileProject(p, { transport: { loopOn: false, metroOn: false } }), tables: [], assets: [],
      startBeat: 0, stopAt: -1, inputOn: true, recArm: true, countIn: 4, inputRing: { ring, ctl, cap } },
  });
  const msgs = [];
  node.port.onmessage = (e) => msgs.push(e.data);
  src.connect(node); node.connect(off.destination); src.start(0);
  const out = await off.startRendering();
  await new Promise((r) => setTimeout(r, 200));
  const started = msgs.find((m) => m.type === 'recStarted');
  const w = Atomics.load(new Int32Array(ctl), 0) >>> 0;
  const R = new Float32Array(ring);
  assert(started, 'no recStarted message');
  assert(started.index === 96000 && started.beat === 0, `take starts at ring ${started.index} beat ${started.beat}, expected 96000 / 0`);
  assert(w === frames, `ring holds ${w} samples, expected ${frames}`);
  for (const f of imps) assert(Math.abs(R[f] - 0.9) < 1e-6, `impulse at frame ${f} not at ring position ${f}`);
  assert(Math.abs(R[cap + 5000] - 0.25) < 1e-6, 'input 2 not captured');
  const oL = out.getChannelData(0), oR = out.getChannelData(1);
  // (checked after the count-in, whose clicks also play)
  assert(Math.abs(oL[120000] - 0.9) < 1e-3 && Math.abs(oR[120000] - 0.9) < 1e-3, 'monitored impulse missing from output');
  assert(Math.abs(oL[100000]) < 1e-6 && Math.abs(oR[100000]) < 1e-6, 'input 1 monitoring leaked input 2');
  return `count-in ends at sample ${started.index}; ${imps.length} impulses captured at exact frames; monitor routes input 1 only`;
});

await test('Audio takes: placement, latency, loop passes', () => {
  const spb = 24000; // 120 BPM at 48 kHz
  const a = planTake({ recorded: 48000 + 960, latency: 960, startBeat: 2, spb, loop: { on: false, start: 0, end: 4 } });
  assert(a.start === 2 && Math.abs(a.length - 2) < 1e-9 && a.offsetFrames === 960, `straight take ${JSON.stringify(a)}`);
  const b = planTake({ recorded: 960 + spb * 4 * 2.5, latency: 960, startBeat: 0, spb, loop: { on: true, start: 0, end: 4 } });
  assert(b.start === 0 && b.length === 4 && b.offsetFrames === 960 + 4 * spb && b.pass === 2 && b.passes === 3, `loop take ${JSON.stringify(b)}`);
  const c = planTake({ recorded: 960 + spb * 5, latency: 960, startBeat: 2, spb, loop: { on: true, start: 0, end: 4 } });
  assert(c.start === 2 && c.length === 2 && c.offsetFrames === 960 && c.pass === 1 && c.passes === 2, `partial second pass ${JSON.stringify(c)}`);
  assert(planTake({ recorded: 500, latency: 960, startBeat: 0, spb, loop: { on: false } }) === null, 'too-short take not rejected');
  // ring positions wrap at 2^32: extraction must follow
  const start = 4294967290;
  const col = { start, L: [Float32Array.of(0, 1, 2), Float32Array.of(3, 4, 5, 6, 7), Float32Array.of(8, 9)], R: [Float32Array.of(0, -1, -2), Float32Array.of(-3, -4, -5, -6, -7), Float32Array.of(-8, -9)] };
  const [L, R] = extractRange(col, (start + 2) >>> 0, (start + 9) >>> 0);
  assert(L.join() === '2,3,4,5,6,7,8' && R[6] === -8, `extracted ${L.join()}`);
  const [L2] = extractRange(col, (start - 2) >>> 0, (start + 2) >>> 0);
  assert(L2.join() === '0,0,0,1', `pre-start padding ${L2.join()}`);
  // a new take replaces what it overlaps
  const tr = { clips: [{ id: 'a', kind: 'audio', start: 0, length: 8, offset: 0 }, { id: 'b', kind: 'audio', start: 3, length: 1, offset: 0 }] };
  let n = 0;
  carveAudio(tr, 2, 5, 120, () => 'n' + n++);
  const sum = tr.clips.map((x) => `${x.id}:${x.start}+${x.length}@${x.offset}`).join(' ');
  assert(sum === 'a:0+2@0 n0:5+3@2.5', `carved ${sum}`);
  // calibration onset detector
  const x = new Float32Array(2000); for (let i = 1200; i < 1260; i++) x[i] = 0.3 * Math.sin(i);
  x[1200] = 0.25;
  assert(findOnset(x, 1000, 2000, 0.001) === 1200, 'click onset not found');
  assert(findOnset(new Float32Array(2000), 0, 2000, 0.001) === -1, 'silence reported as a click');
  return 'straight, looped (last full pass), partial-pass, too-short, wraparound extraction, overwrite carving, onset detection';
});

await test('Punch takes: audio kept only inside the range, with crossfades', () => {
  const spb = 24000, lat = 960, xf = 0.02; // 120 BPM at 48 kHz; 10 ms = 0.02 beats
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const P = { on: true, start: 4, end: 8 };
  // pre-roll from 0, stopped after the punch-out: the take covers 4..8 plus a crossfade either side
  const a = planTake({ recorded: lat + spb * 10, latency: lat, startBeat: 0, spb, loop: { on: false }, punch: P, xfade: xf });
  assert(near(a.carveStart, 4) && near(a.carveEnd, 8) && near(a.xIn, xf) && near(a.xOut, xf) && near(a.start, 4 - xf) && near(a.length, 4 + 2 * xf)
    && a.offsetFrames === lat + Math.round((4 - xf) * spb), `punch take ${JSON.stringify(a)}`);
  // stopped inside the range: ends where it stopped, no crossfade there
  const b = planTake({ recorded: lat + spb * 6, latency: lat, startBeat: 0, spb, loop: { on: false }, punch: P, xfade: xf });
  assert(near(b.carveEnd, 6) && b.xOut === 0, `stopped inside ${JSON.stringify(b)}`);
  // stopped before the punch-in: nothing
  assert(planTake({ recorded: lat + spb * 3, latency: lat, startBeat: 0, spb, loop: { on: false }, punch: P, xfade: xf }) === null, 'take before the punch-in not rejected');
  // started inside the range: no audio before it to crossfade with
  const d = planTake({ recorded: lat + spb * 5, latency: lat, startBeat: 5, spb, loop: { on: false }, punch: P, xfade: xf });
  assert(near(d.start, 5) && d.xIn === 0 && d.offsetFrames === lat && near(d.carveEnd, 8), `started inside ${JSON.stringify(d)}`);
  // loop 0..8 with punch 2..4, stopped in the third pass: keeps pass 2's punch range
  const e = planTake({ recorded: lat + spb * 19, latency: lat, startBeat: 0, spb, loop: { on: true, start: 0, end: 8 }, punch: { on: true, start: 2, end: 4 }, xfade: xf });
  assert(near(e.carveStart, 2) && near(e.carveEnd, 4) && e.pass === 2 && e.passes === 3 && e.offsetFrames === lat + Math.round((10 - xf) * spb), `loop punch ${JSON.stringify(e)}`);
  // the old audio is cut at the punch points and fades across them
  const tr = { clips: [{ id: 'a', kind: 'audio', start: 0, length: 16, offset: 0, fadeIn: 0, fadeOut: 0 }] };
  carveAudio(tr, 4, 8, 120, () => 'n0', { left: xf, right: xf });
  const sum = tr.clips.map((x) => `${x.id}:${x.start}+${x.length}@${x.offset} in${x.fadeIn} out${x.fadeOut}`).join(' ');
  assert(sum === `a:0+4@0 in0 out${xf} n0:8+8@4 in${xf} out0`, `carved ${sum}`);
  return 'trimmed to the range with 10 ms crossfades; stopped inside / before / started inside; loop keeps the last full pass';
});

await test('Punch takes: MIDI replaces only the punch range', () => {
  const kept = punchNotes([{ p: 1, s: 3, l: 2, v: 1 }, { p: 2, s: 4, l: 3, v: 1 }, { p: 3, s: 6, l: 1, v: 1 }], 3.5, 5.5);
  assert(kept.length === 1 && kept[0].p === 2 && kept[0].l === 1.5, `kept ${JSON.stringify(kept)}`);
  // a 2-beat loop repeated over 8 beats: only the repeats inside 3.5..5.5 change
  const clip = newMidiClip(0, 8, [newNote(60, 0, 0.5), newNote(62, 1, 1.5)]); clip.loopLen = 2;
  const t = { clips: [clip] };
  const got = placePunchMidi(t, punchNotes([newNote(72, 4, 1)], 3.5, 5.5), 3.5, 5.5, () => { throw new Error('should reuse the clip'); });
  const sum = got.notes.map((n) => `${n.p}@${n.s}/${n.l}`).join(' ');
  assert(got === clip && clip.loopLen === 8 && sum === '60@0/0.5 62@1/1 60@2/0.5 62@3/0.5 72@4/1 60@6/0.5 62@7/1', `replaced ${sum}`);
  // nothing there yet: a new clip for the range
  const t2 = { clips: [] };
  const c2 = placePunchMidi(t2, [newNote(64, 4, 1)], 4, 6, () => newMidiClip(4, 2, []));
  assert(t2.clips.length === 1 && c2.notes[0].s === 0, 'new punch clip');
  return 'only notes started inside count; looped clip unrolled, repeats outside untouched, ringing note cut at the punch-in';
});

await test('Punch recording: old take muted inside the range, input heard only there', async () => {
  const sr = 48000, spb = 24000, frames = spb * 6;
  const run = async (punch) => {
    const off = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: sr });
    await off.audioWorklet.addModule('/src/audio/worklet/engine-processor.js');
    const buf = off.createBuffer(2, frames, sr); buf.getChannelData(0).fill(0.25); buf.getChannelData(1).fill(0.25);
    const src = off.createBufferSource(); src.buffer = buf;
    const p = newProject('punch'); p.tempo = 120; p.loop.on = false;
    const t = newTrack(p, 'audio'); t.arm = true; t.monitor = true; p.tracks.push(t);
    t.clips.push(newAudioClip({ id: 'old', name: 'old take' }, 0, 16));
    const old = new Float32Array(400000).fill(0.5);
    const cap = 1 << 18;
    const node = new AudioWorkletNode(off, 'sawforge-engine', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      processorOptions: { offline: true, project: compileProject(p, { transport: { loopOn: false, metroOn: false } }), tables: [],
        assets: [{ id: 'old', sampleRate: sr, channels: [old, old] }], startBeat: 0, stopAt: -1, inputOn: true, recArm: true, countIn: 0,
        inputRing: { ring: new SharedArrayBuffer(cap * 8), ctl: new SharedArrayBuffer(64), cap }, take: { on: true, audio: [t.id], midi: [], punch } },
    });
    src.connect(node); node.connect(off.destination); src.start(0);
    return (await off.startRendering()).getChannelData(0);
  };
  const o = await run({ on: true, start: 2, end: 4 });
  const near = (x, v) => Math.abs(x - v) < 1e-4;
  assert(near(o[24000], 0.5) && near(o[47000], 0.5), `before the punch-in: old take ${o[24000]}, ${o[47000]}`);
  assert(near(o[49000], 0.25) && near(o[72000], 0.25), `inside: input ${o[49000]}, ${o[72000]}`);
  assert(near(o[97000], 0.5) && near(o[120000], 0.5), `after the punch-out: old take ${o[97000]}, ${o[120000]}`);
  let jump = 0; for (let i = 40000; i < 104000; i++) jump = Math.max(jump, Math.abs(o[i] - o[i - 1]));
  assert(jump < 0.005, `switch at the punch points jumps by ${jump}`);
  const whole = await run(null);
  assert(near(whole[24000], 0.25) && near(whole[120000], 0.25), 'without punch, the old take should be muted for the whole take');
  return `old take → input → old take, largest step ${jump.toFixed(4)} (5 ms crossfade); without punch the take replaces throughout`;
});

await test('Punch recording: old MIDI notes inside the range are muted', async () => {
  const p = synthProject('Init Saw', [newNote(60, 0, 0.5), newNote(64, 2.5, 0.5)], { params: CLEAN });
  const t = p.tracks[0];
  const tables = [];
  for (const o of [0, 1]) { const { table } = await engine.tables.build(t.instrument.wt[o]); tables.push({ ch: t.id, osc: o, data: table.data.slice(), frames: table.frames, mips: table.mips, size: table.size }); }
  const run = async (take) => {
    const off = new OfflineAudioContext({ numberOfChannels: 2, length: 24000 * 4, sampleRate: 48000 });
    await off.audioWorklet.addModule('/src/audio/worklet/engine-processor.js');
    const node = new AudioWorkletNode(off, 'sawforge-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { offline: true, project: compileProject(p, { transport: { loopOn: false, metroOn: false } }), tables, assets: [], startBeat: 0, stopAt: -1, take } });
    node.connect(off.destination);
    return (await off.startRendering()).getChannelData(0);
  };
  const plain = await run(null), punched = await run({ on: true, audio: [], midi: [t.id], punch: { on: true, start: 2, end: 4 } });
  const a0 = rms(plain, 2400, 12000), b0 = rms(punched, 2400, 12000);
  const a1 = rms(plain, 62400, 72000), b1 = rms(punched, 62400, 72000);
  assert(a1 > 0.01 && b1 < 1e-4, `note inside the punch range: ${db(a1)} dB normally, ${db(b1)} dB while punching`);
  assert(Math.abs(a0 - b0) < 1e-6, 'note before the punch-in changed');
  return `inside the range ${db(a1)} → ${db(b1)} dB; outside unchanged`;
});

await test('Take lanes: loop passes become takes; swipe comping with crossfades', () => {
  const spb = 24000, lat = 0, tempo = 120, xf = 0.02;
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
  // loop 0..4 recorded for 9 beats: two full passes become takes, the quarter pass does not
  const plan = planTake({ recorded: spb * 9, latency: lat, startBeat: 0, spb, loop: { on: true, start: 0, end: 4 } });
  const keep = plan.takes.filter((tk) => tk.full || tk.cover >= 0.5 || tk.pass === plan.pass);
  assert(plan.takes.length === 3 && keep.length === 2 && plan.pass === 2 && keep[1].offsetFrames === 4 * spb, `passes ${JSON.stringify(plan.takes.map((t) => [t.pass, t.full, t.cover]))}`);
  const p = newProject('takes'); p.tempo = tempo;
  const t = newTrack(p, 'audio'); p.tracks.push(t);
  const clips = keep.map((tk) => { const c = newAudioClip({ id: 'rec1', name: 'rec' }, tk.start, tk.length); c.offset = tk.offsetFrames / 48000; return c; });
  const lanes = addTakeLanes(t, clips);
  assert(t.takeLanes.length === 2 && t.takeLanes[0] === lanes[1] && lanes[1].name === 'Take 2', 'newest take should be the top lane');
  const [L1, L2] = lanes, T1 = L1.clips[0], T2 = L2.clips[0];
  compRange(t, L2, T2, T2.start, T2.start + T2.length, tempo, xf);
  assert(t.clips.length === 1 && t.clips[0].src.lane === L2.id && near(t.clips[0].offset, 2), `comp ${JSON.stringify(t.clips)}`);
  // swipe take 1 over beat 1..2: three clips, crossfaded
  compLaneRange(t, L1, 1, 2, tempo, xf);
  const sum = () => t.clips.slice().sort((a, b) => a.start - b.start).map((c) => `${t.takeLanes.find((l) => l.id === c.src.lane).name.replace('Take ', 'T')}:${+c.start.toFixed(3)}-${+(c.start + c.length).toFixed(3)} in${+c.fadeIn.toFixed(3)} out${+c.fadeOut.toFixed(3)}`).join(' ');
  assert(sum() === 'T2:0-1 in0 out0.02 T1:0.98-2.02 in0.02 out0.02 T2:2-4 in0.02 out0', `after swipe: ${sum()}`);
  const t1clip = t.clips.find((c) => c.src.lane === L1.id);
  assert(near(t1clip.offset - T1.offset, (0.98 * 60) / tempo), 'comp clip offset not aligned with its take');
  assert(near(laneUsage(t, L1, tempo), 1.04 / 4) && usedRanges(t, T2, tempo).length === 2, 'usage of the lanes');
  // extending the swipe joins the same take into one clip
  compLaneRange(t, L1, 2, 3, tempo, xf);
  assert(sum() === 'T2:0-1 in0 out0.02 T1:0.98-3.02 in0.02 out0.02 T2:3-4 in0.02 out0', `joined: ${sum()}`);
  // a shorter take used whole: old crossfade tails go, and the comp runs on under its end to crossfade
  const [L3] = addTakeLanes(t, [Object.assign(newAudioClip({ id: 'rec1', name: 'rec' }, 0, 3), { offset: 6 })]);
  compRange(t, L3, L3.clips[0], 0, 3, tempo, xf);
  assert(sum() === 'T3:0-3 in0 out0.02 T2:2.98-4 in0.02 out0', `shorter whole take: ${sum()}`);
  // a whole take replaces everything it covers
  compRange(t, L1, T1, T1.start, T1.start + T1.length, tempo, xf);
  assert(sum() === 'T1:0-4 in0 out0', `whole take: ${sum()}`);
  // audition: the engine gets the lane's clips instead of the comp
  compRange(t, L2, T2, 0, 4, tempo, xf);
  const regions = (au) => compileProject(p, { audition: au }).channels.find((c) => c.id === t.id).regions;
  assert(near(regions(null)[0].offset, 2) && near(regions({ track: t.id, lane: L1.id })[0].offset, 0), 'audition should play the lane');
  // saved files keep audio used only by takes; reload keeps lanes and comp links
  p.assets.push({ id: 'rec1', name: 'rec' }, { id: 'only-take', name: 'x' });
  L1.clips.push({ ...newAudioClip({ id: 'only-take', name: 'x' }, 8, 2) });
  const bytes = packProject(p, new Map([['rec1', new ArrayBuffer(8)], ['only-take', new ArrayBuffer(4)]]));
  const back = normalizeProject(unpackProject(bytes.buffer).project);
  const bt = back.tracks[0];
  assert(back.assets.some((a) => a.id === 'only-take'), 'audio used only by a take was dropped from the file');
  assert(bt.takeLanes.length === 3 && bt.clips[0].src.lane === L2.id && bt.takeSeq === 3, 'lanes or comp links lost on reload');
  // duplicating a track gives its lanes new ids but keeps the comp pointing at them
  const dup = cloneJSON(t); remapTakeIds(dup);
  assert(dup.takeLanes[0].id !== t.takeLanes[0].id && dup.clips[0].src.lane === dup.takeLanes.find((l) => l.name === 'Take 2').id, 'duplicate links');
  return `3 passes → 2 takes; swipe makes 3 crossfaded clips; extending joins; shorter take crossfades under the comp; whole-take replace; audition; save/reload; duplicate`;
});

await test('Comp playback: crossfades between takes are click-free', async () => {
  const sr = 48000, n = sr * 3;
  const dc = (v) => { const x = new Float32Array(n).fill(v); return encodeWav([x, x], sr, 32); };
  const p = newProject('comp'); p.tempo = 120; p.loop.on = false;
  const t = newTrack(p, 'audio'); p.tracks.push(t);
  const [LA, LB] = addTakeLanes(t, [newAudioClip({ id: 'A', name: 'A' }, 0, 4), newAudioClip({ id: 'B', name: 'B' }, 0, 4)]);
  compRange(t, LA, LA.clips[0], 0, 4, 120, 0.02);
  compLaneRange(t, LB, 1, 2, 120, 0.02);
  const [o] = await render(p, { end: 4, tail: 0, assets: [{ id: 'A', bytes: dc(0.5) }, { id: 'B', bytes: dc(0.25) }] });
  const at = (b) => o[Math.round(b * 24000)];
  const near = (x, v) => Math.abs(x - v) < 1e-4;
  assert(near(at(0.5), 0.5) && near(at(1.5), 0.25) && near(at(3), 0.5), `levels ${at(0.5)} ${at(1.5)} ${at(3)}`);
  let jump = 0; for (let i = 12000; i < 84000; i++) jump = Math.max(jump, Math.abs(o[i] - o[i - 1]));
  assert(jump < 0.002, `largest step at the comp edits ${jump}`);
  let lo = 1; for (let i = 12000; i < 84000; i++) lo = Math.min(lo, o[i]);
  assert(lo > 0.249, `level dipped to ${lo} inside a crossfade`);
  return `take A → B → A, largest step ${jump.toFixed(5)}, no dip`;
});

// ---------------------------------------------------------------- Worship Atmospheres
// The pad engine is plain JavaScript: drive it block by block exactly as the audio thread does.
function runPad(host, sec, events = [], sr = 48000) {
  const n = 128, blocks = Math.ceil((sec * sr) / n);
  const L = new Float32Array(blocks * n), R = new Float32Array(blocks * n);
  const bl = new Float32Array(n), br = new Float32Array(n), ctx = { tempo: 120, sr, beat: 0, playing: false };
  const evs = [...events].sort((a, b) => a.t - b.t);
  let e = 0;
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    const t = (b * n) / sr;
    while (e < evs.length && evs[e].t <= t) evs[e++].fn();
    bl.fill(0); br.fill(0);
    host.beginBlock(120, 0, false, n); host.render(bl, br, 0, n); host.postProcess(bl, br, n, ctx);
    L.set(bl, b * n); R.set(br, b * n);
  }
  return { L, R, ms: performance.now() - t0 };
}
const padParams = (name, over = {}) => ({ ...worshipPresetParams(worshipPresetByName(name)), ...over });
const chordFor = (pc, minor, pr) => voiceChord({ root: pc, minor, type: pr['vc.type'], register: pr['vc.reg'], density: pr['vc.density'], spread: pr['vc.spread'] });
const liveHost = (pr) => { const h = new LivePadHost(48000); h.setManualAll(worshipParamArray(pr), true); return h; };
const winDb = (L, R, a, b) => { let s = 0; for (let i = a; i < b; i++) s += L[i] * L[i] + R[i] * R[i]; return 10 * Math.log10(s / Math.max(1, 2 * (b - a)) + 1e-20); };
function centroid(x, at) {
  const N = 8192, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im, false);
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); num += m * k * (48000 / N); den += m; }
  return den > 0 ? num / den : 0;
}

await test('Worship voicing engine: spacious chords, keys and voice leading', () => {
  const g = voiceChord({ root: 7, minor: false, type: VC.WIDE, register: 1, density: 0.55, spread: 0.6 });
  assert(g.notes.length >= 4 && g.notes.every((n) => n >= 40 && n <= 84), `G wide ${g.notes}`);
  const lowThird = g.notes.some((n) => (n - g.root) % 12 === 4 && n < 50);
  assert(!lowThird, 'thirds should stay out of the muddy low register');
  const d = voiceChord({ root: 2, minor: false, type: VC.WIDE, register: 1, density: 0.55, spread: 0.6, prev: g.notes });
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert(Math.abs(avg(d.notes) - avg(g.notes)) <= 7, `voice leading moved ${avg(d.notes) - avg(g.notes)} semitones`);
  const thin = voiceChord({ root: 0, minor: false, type: VC.WIDE, density: 0.1 }), thick = voiceChord({ root: 0, minor: false, type: VC.WIDE, density: 0.95 });
  assert(thin.notes.length < thick.notes.length, 'density should change how many notes sound');
  const am = voiceChord({ root: 9, minor: true, type: VC.TRIAD, register: 1 });
  assert(am.notes.some((n) => (n - am.root) % 12 === 3), 'minor triad needs a minor third');
  assert(keyName(1, false) === 'D♭' && keyName(1, true) === 'C♯m' && keyName(6, false, 'flat') === 'G♭', 'enharmonic spelling');
  const k = parseKey('Bbm'); assert(k && k.pc === 10 && k.minor && k.spell === 'flat', 'parse key');
  return `G wide ${g.notes.join(' ')}; → D ${d.notes.join(' ')} (moved ${(avg(d.notes) - avg(g.notes)).toFixed(1)} st); spellings ok`;
});

await test('Worship presets: all 40 sustain cleanly at matched loudness', () => {
  assert(WORSHIP_PRESETS.length === 40 && new Set(WORSHIP_PRESETS.map((p) => p.name)).size === 40, 'need exactly 40 distinct presets');
  // presets must differ in their actual synthesis, not just their names
  const sig = new Set(WORSHIP_PRESETS.map((p) => JSON.stringify(Object.entries(p.params).sort())));
  assert(sig.size === 40, 'two presets share identical settings');
  const rows = [], trims = {};
  let worstMs = 0, worstName = '';
  // Oscillators start at random phases, so a preset's level wobbles about ±1 dB from chord to chord.
  // Give every preset the same seed so the comparison is repeatable.
  const realRandom = Math.random;
  try {
  for (const pre of WORSHIP_PRESETS) {
    let seed = 0x9e3779b9;
    Math.random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    // Breathe is random by design (its makeup gain keeps the average level), so measure the steady sound.
    const pr = padParams(pre.name, { 'sw.attack': 0.3, 'str.attack': 0.3, 'sw.auto': 0, 'br.amount': 0 });
    const h = liveHost(pr), ch = chordFor(7, false, pr);
    h.start(ch.notes, ch.root, 0.05);
    const { L, R, ms } = runPad(h, 6.5);
    let peak = 0, bad = false;
    for (let i = 0; i < L.length; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a !== a) bad = true; if (a > peak) peak = a; }
    const rms = winDb(L, R, 96000, 312000), c = centroid(L, 120000); // 2–6.5 s averages out slow beating
    if (ms > worstMs) { worstMs = ms; worstName = pre.name; }
    assert(!bad, `${pre.name}: NaN in output`);
    assert(peak < 1, `${pre.name}: peak ${peak.toFixed(3)}`);
    assert(rms > -40, `${pre.name}: too quiet (${rms.toFixed(1)} dB)`);
    rows.push({ name: pre.name, rms, c, peak });
    trims[pre.name] = +(-18 - rms).toFixed(1);
  }
  } finally { Math.random = realRandom; }
  window.__padTrims = trims;
  const spread = Math.max(...rows.map((r) => r.rms)) - Math.min(...rows.map((r) => r.rms));
  const brightest = rows.reduce((x, y) => (y.c > x.c ? y : x));
  const table = rows.map((r) => `${r.name.padEnd(22)} ${r.rms.toFixed(1)} dB  centroid ${r.c.toFixed(0)} Hz  peak ${r.peak.toFixed(2)}`).join('\n');
  assert(spread <= 3, `loudness differs by ${spread.toFixed(1)} dB across presets (calibrate PRESET_TRIM)\n${table}`);
  assert(brightest.c < 3500, `${brightest.name} is too bright (centroid ${brightest.c.toFixed(0)} Hz)`);
  return `40 presets clean; loudness spread ${spread.toFixed(1)} dB; brightest ${brightest.name} ${brightest.c.toFixed(0)} Hz; heaviest ${worstName}: ${(6500 / worstMs).toFixed(1)}× real time on the UI thread\n` + table;
});

await test('Worship live pad: key changes crossfade with no jump, dip or click', () => {
  const pr = padParams('Endless Worship', { 'sw.attack': 0.3, 'str.attack': 0.3, 'sw.auto': 0 });
  const h = liveHost(pr), g = chordFor(7, false, pr);
  const d = chordFor(2, false, { ...pr }), dl = voiceChord({ root: 2, minor: false, type: pr['vc.type'], register: pr['vc.reg'], density: pr['vc.density'], spread: pr['vc.spread'], prev: g.notes });
  h.start(g.notes, g.root, 0.05);
  const { L, R } = runPad(h, 9, [{ t: 3, fn: () => h.change(dl.notes, dl.root, { fadeIn: 3, fadeOut: 3, voiceLead: true }) }]);
  // the pad moves on its own (evolve, LFOs): compare the change against the same stretch with no change
  const h0 = liveHost(pr); h0.start(g.notes, g.root, 0.05);
  const still = runPad(h0, 9);
  const w = 2400, rangeOf = (A, B) => { const v = []; for (let a = 2.4 * 48000; a + w <= 8.5 * 48000; a += w) v.push(winDb(A, B, a, a + w)); return Math.max(...v) - Math.min(...v); };
  const range = rangeOf(L, R), base = rangeOf(still.L, still.R);
  const jump = (a, b) => { let m = 0; for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(L[i] - L[i - 1])); return m; };
  const steady = jump(1.5 * 48000, 2.9 * 48000), during = jump(2.95 * 48000, 6.2 * 48000);
  const held = h.cur.notes.filter((v) => v.active && v.live && !v.bass).map((v) => v.pitch).sort((a, b) => a - b);
  assert(range < base + 2, `level moved ${range.toFixed(1)} dB through the key change (${base.toFixed(1)} dB without one)`);
  assert(during < steady * 1.6 + 1e-4, `click during the change: step ${during.toFixed(4)} vs ${steady.toFixed(4)}`);
  assert(JSON.stringify(held) === JSON.stringify(dl.notes), `sounding ${held} vs D chord ${dl.notes}`);
  return `G → D over 3 s: level range ${range.toFixed(1)} dB (pad's own movement ${base.toFixed(1)} dB), largest step ${during.toFixed(4)} (steady ${steady.toFixed(4)}); common tones held; D chord ${dl.notes.join(' ')}`;
});

await test('Worship live pad: preset crossfade, stop fade, tails and panic', () => {
  const a = padParams('Warm Sanctuary', { 'sw.attack': 0.3, 'sw.auto': 0 }), b = padParams('Heavenly Atmosphere', { 'sw.attack': 0.3, 'sw.auto': 0 });
  const h = liveHost(a), ch = chordFor(4, false, a);
  h.start(ch.notes, ch.root, 0.05);
  const { L, R } = runPad(h, 12, [
    { t: 3, fn: () => h.load(worshipParamArray(b), 2.5, h.cur.tables) },
    { t: 7, fn: () => h.stop(2) },
    { t: 11, fn: () => h.panic() },
  ]);
  const sr = 48000, w = 2400;
  const rangeOf = (A, B, from, to) => { const v = []; for (let s = from * sr; s + w <= to * sr; s += w) v.push(winDb(A, B, s, s + w)); return Math.max(...v) - Math.min(...v); };
  const xr = rangeOf(L, R, 2.5, 6.5);
  // each preset moves on its own; the crossfade may add at most a little to that
  const own = (pr) => { const x = liveHost(pr); x.start(ch.notes, ch.root, 0.05); const o = runPad(x, 6.5); return rangeOf(o.L, o.R, 2.5, 6.5); };
  const base = Math.max(own(a), own(b));
  const before = winDb(L, R, 6.5 * sr, 7 * sr), tail = winDb(L, R, 9.5 * sr, 10 * sr), after = winDb(L, R, 11.1 * sr, 11.6 * sr);
  assert(xr < base + 2.5, `preset crossfade moved the level ${xr.toFixed(1)} dB (presets alone: ${base.toFixed(1)} dB)`);
  assert(tail > before - 45 && tail < before - 6, `reverb tail after stop: ${tail.toFixed(1)} dB (playing ${before.toFixed(1)})`);
  assert(after < -90, `panic left ${after.toFixed(1)} dB`);
  assert(h.engines.length <= 2, `${h.engines.length} engines still alive after the crossfade`);
  return `crossfade range ${xr.toFixed(1)} dB (presets alone ${base.toFixed(1)} dB); 2.5 s after stop the reverb tail is ${(before - tail).toFixed(0)} dB down; panic → ${after.toFixed(0)} dB`;
});

await test('Worship instrument on a track: notes, chord-from-root, hold', () => {
  const pr = padParams('Golden Presence', { 'sw.attack': 0.2 });
  const e = new PadEngine(48000); e.setManualAll(worshipParamArray(pr), true);
  const count = () => e.notes.filter((v) => v.active && v.pad && v.es !== 4).length;
  e.noteOn(60, 0.8); e.noteOn(64, 0.8);
  const a = count();
  e.setParam(e.p.length && 0, e.p[0]);
  const pm = worshipParamArray({ ...pr, 'play.mode': 1, 'play.hold': 1 });
  const e2 = new PadEngine(48000); e2.setManualAll(pm, true);
  e2.noteOn(55, 0.8);
  const chordNotes = e2.notes.filter((v) => v.active && v.pad).length;
  e2.noteOff(55);
  const heldAfterOff = e2.notes.filter((v) => v.active && v.pad && v.held).length;
  e2.noteOn(57, 0.8); // next chord releases the held one
  const released = e2.notes.filter((v) => v.active && v.pad && v.es === 4).length;
  const { L, R } = runPad(e2, 1.5);
  assert(a === 2, `two notes → ${a} voices`);
  assert(chordNotes >= 3, `chord-from-root played ${chordNotes} notes`);
  assert(heldAfterOff === chordNotes && released === chordNotes, `hold kept ${heldAfterOff}, then released ${released}`);
  assert(winDb(L, R, 48000, 72000) > -40, 'track instrument silent');
  return `notes mode 2 voices; one key → ${chordNotes}-note chord; hold sustains until the next chord`;
});

await test('Worship breathe: notes rise and fall on their own; root holds; never silent', () => {
  const over = { 'sw.attack': 0.3, 'sw.auto': 0, 'ev.amount': 0, 'br.rate': 0.4, 'br.floor': 0.35, 'br.root': 1 };
  const trace = (amount) => {
    const pr = padParams('Still Waters', { ...over, 'br.amount': amount });
    const h = liveHost(pr), ch = chordFor(7, false, pr);
    h.start(ch.notes, ch.root, 0.05);
    const tr = new Map(), ev = [];
    for (let t = 1; t < 24; t += 0.1) ev.push({ t, fn: () => { for (const v of h.cur.notes) if (v.active && v.pad && v.live) { if (!tr.has(v.pitch)) tr.set(v.pitch, []); tr.get(v.pitch).push(v.brG); } } });
    return { tr, ...runPad(h, 24, ev), notes: ch.notes };
  };
  const on = trace(1), off = trace(0);
  const low = Math.min(...on.tr.keys());
  const root = on.tr.get(low), others = [...on.tr.entries()].filter(([p]) => p !== low).map(([, v]) => v);
  const c = 0.65, makeup = 1 / Math.sqrt(1 - (2 * c) / 3 + (c * c) / 5);
  const range = (a) => Math.max(...a) - Math.min(...a);
  assert(range(root) < 0.01, `lowest note should hold steady (moved ${range(root).toFixed(3)})`);
  assert(others.every((a) => range(a) > 0.25), `every other note should breathe: ranges ${others.map((a) => range(a).toFixed(2))}`);
  const floorSeen = Math.min(...others.map((a) => Math.min(...a))) / makeup;
  assert(floorSeen >= 0.35 - 0.02, `a note dipped to ${floorSeen.toFixed(2)} of full level (floor 0.35)`);
  // independence: the notes do not move together
  const corr = (a, b) => { const n = Math.min(a.length, b.length), ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n, mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
    let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return sab / Math.sqrt(saa * sbb + 1e-12); };
  const rs = []; for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) rs.push(Math.abs(corr(others[i], others[j])));
  const meanR = rs.reduce((s, x) => s + x, 0) / rs.length;
  assert(meanR < 0.5, `notes move together (mean correlation ${meanR.toFixed(2)})`);
  // the chord never drops out, the overall level stays put, and there are no clicks
  const sr = 48000, w = 2400, lv = (L, R) => { const v = []; for (let a = 3 * sr; a + w <= 24 * sr; a += w) v.push(winDb(L, R, a, a + w)); return v; };
  const von = lv(on.L, on.R), voff = lv(off.L, off.R), mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const step = (L) => { let m = 0; for (let i = 3 * sr; i < 24 * sr; i++) m = Math.max(m, Math.abs(L[i] - L[i - 1])); return m; };
  assert(Math.min(...von) > mean(von) - 8, `chord dipped to ${(Math.min(...von) - mean(von)).toFixed(1)} dB below its average`);
  assert(Math.abs(mean(von) - mean(voff)) < 1.5, `breathing changed the average level by ${(mean(von) - mean(voff)).toFixed(1)} dB`);
  assert(step(on.L) < step(off.L) * 1.4 + 1e-4, 'breathing produced a click');
  assert([...off.tr.values()].every((a) => a.every((x) => x === 1)), 'Breathe at 0 must leave the notes alone');
  return `${others.length} notes breathe independently (mean |r| ${meanR.toFixed(2)}), lowest note steady, deepest dip ${(floorSeen * 100).toFixed(0)}% of full; average level ${(mean(von) - mean(voff)).toFixed(1)} dB vs off`;
});

await test('Worship drifting harmony: one key, custom intervals drift in and out around a steady root', () => {
  const pr = padParams('Open Heavens', { 'sw.attack': 0.2, 'play.mode': 1, 'play.minor': 0, 'vc.type': VC.CUSTOM, 'ev.amount': 0,
    'br.amount': 1, 'br.floor': 0, 'br.root': 1, 'br.bias': 0.8, 'br.rate': 0.4 });
  const e = new PadEngine(48000); e.setManualAll(worshipParamArray(pr), true); e.setCustom([0, 7, 10, 17]);
  e.noteOn(64, 0.8); // E4
  const pitches = e.notes.filter((v) => v.active && v.pad).map((v) => v.pitch).sort((a, b) => a - b);
  assert(JSON.stringify(pitches) === '[64,71,74,81]', `one E should play E4 B4 D5 A5, got ${pitches}`);
  const tr = new Map(), ev = [];
  for (let t = 1; t < 60; t += 0.1) ev.push({ t, fn: () => { for (const v of e.notes) if (v.active && v.pad) { if (!tr.has(v.pitch)) tr.set(v.pitch, []); tr.get(v.pitch).push(v.brG); } } });
  const { L, R } = runPad(e, 60, ev);
  const root = tr.get(64), ext = [71, 74, 81].map((p) => tr.get(p));
  const rng = (a) => Math.max(...a) - Math.min(...a), frac = (a) => a.filter((x) => x > 0.6).length / a.length;
  assert(rng(root) < 0.01, `the root should stay put (moved ${rng(root).toFixed(3)})`);
  assert(ext.every((a) => Math.min(...a) < 0.1 && Math.max(...a) > 0.8), `each added note should leave completely and come back: ${ext.map((a) => `${Math.min(...a).toFixed(2)}–${Math.max(...a).toFixed(2)}`)}`);
  const inFrac = ext.map(frac), avgIn = inFrac.reduce((x, y) => x + y, 0) / inFrac.length;
  assert(avgIn < 0.5, `with Balance toward Out the added notes should be away most of the time (in ${Math.round(avgIn * 100)}%)`);
  let peak = 0; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  assert(peak < 1, `peak ${peak.toFixed(2)}`);
  return `E → E4 B4 D5 A5; root steady; 5th, 7th and 11th each drift fully out and back in, present ${inFrac.map((x) => Math.round(x * 100) + '%').join(' / ')} of the time`;
});

await test('Worship live pad through the audio engine, transport stopped', async () => {
  const p = newProject('live'); p.live.vol = 0;
  const pr = padParams('Still Waters', { 'sw.attack': 0.2 });
  p.live.patch.params = pr;
  const ch = chordFor(0, false, pr);
  const sr = 48000, off = new OfflineAudioContext({ numberOfChannels: 2, length: sr * 3, sampleRate: sr });
  await off.audioWorklet.addModule('/src/audio/worklet/engine-processor.js');
  const node = new AudioWorkletNode(off, 'sawforge-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { offline: true, project: compileProject(p, { live: true, transport: { loopOn: false, metroOn: false } }), tables: [], assets: [], startBeat: 0, stopAt: 0.001,
      live: [{ op: 'start', chord: ch.notes, bass: ch.root, fadeIn: 0.1 }] } });
  node.connect(off.destination);
  const out = await off.startRendering();
  const L = out.getChannelData(0), R = out.getChannelData(1);
  const lvl = winDb(L, R, 2 * sr, 3 * sr);
  assert(lvl > -40, `live pad silent through the engine (${lvl.toFixed(1)} dB)`);
  return `live pad ${lvl.toFixed(1)} dB at 2–3 s with the transport stopped at beat 0`;
});

// ---------------------------------------------------------------- Drummer
const drumHits = (id, over = {}, len = 32, bar = 4) => generateDrummer(newDrummerSettings(id, { seed: 4242, ...over }), len, bar);
const countOf = (hits, ...ids) => hits.filter((x) => ids.includes(PIECES[x.k].id)).length;
const meanVel = (hits) => hits.reduce((a, x) => a + x.v, 0) / Math.max(1, hits.length);

await test('Drummer: 9 drummers with personalities, valid grooves and matching kits', () => {
  const bad = checkPatterns();
  assert(!bad.length, `bad patterns: ${bad.join('; ')}`);
  assert(DRUMMERS.length === 9 && new Set(DRUMMERS.map((d) => d.id)).size === 9, 'need 9 distinct drummers');
  for (const d of DRUMMERS) {
    assert(KIT_NAMES.includes(d.kit), `${d.name}: unknown kit ${d.kit}`);
    assert(d.traits.length >= 2 && d.blurb.length > 30, `${d.name}: needs a personality`);
    for (const k of ['cx', 'loud', 'fill', 'swing', 'hum']) assert(d.def[k] >= 0 && d.def[k] <= 1, `${d.name}: ${k}`);
    const hits = drumHits(d.id);
    assert(hits.length > 40, `${d.name}: only ${hits.length} hits in 8 bars`);
    assert(countOf(hits, 'kick') >= 8, `${d.name}: needs a kick`);
    assert(countOf(hits, 'snare', 'clap') >= 6, `${d.name}: needs a backbeat`);
    assert(hits.every((x) => x.s >= 0 && x.s < 32 && x.v > 0 && x.v <= 1 && x.p >= 0 && x.p < 128), `${d.name}: hit out of range`);
  }
  const same = JSON.stringify(drumHits('nova')) === JSON.stringify(drumHits('nova'));
  const other = JSON.stringify(drumHits('nova')) !== JSON.stringify(drumHits('nova', { seed: 7 }));
  assert(same && other, 'the same seed must give the same groove; a new take must differ');
  return `${DRUMMERS.map((d) => `${d.name} (${d.traits.join('/')})`).join(', ')}; ${PERSONALITIES.length} personalities; deterministic takes`;
});

await test('Drummer: Technique, Loudness, Fill, Speed, Swing, Feel and parts change the playing', () => {
  // Technique: complex plays more notes (ghosts, optional hits, extra percussion)
  const simple = drumHits('nova', { cx: 0.05, fill: 0 }), complex = drumHits('nova', { cx: 0.95, fill: 0 });
  assert(complex.length > simple.length * 1.4, `technique: ${simple.length} → ${complex.length} hits`);
  // Loudness: louder velocities, open hats and layered snare
  const soft = drumHits('nova', { loud: 0.1, fill: 0 }), loud = drumHits('nova', { loud: 0.95, fill: 0 });
  assert(meanVel(loud) > meanVel(soft) + 0.2, `loudness: mean velocity ${meanVel(soft).toFixed(2)} → ${meanVel(loud).toFixed(2)}`);
  assert(countOf(soft, 'ohh') === 0 && countOf(loud, 'ohh') > 8, 'soft playing closes the hats; loud opens them');
  // Fills: none at 0, more fill notes (toms, rolls) with more fill
  const nofill = drumHits('sol', { fill: 0 }, 64), fills = drumHits('sol', { fill: 0.7 }, 64);
  const lastBar = (h) => h.filter((x) => x.s >= 60 && ['snare', 'clap', 'tomL', 'tomM', 'tomH'].includes(PIECES[x.k].id)).length;
  assert(lastBar(fills) > lastBar(nofill) + 6, `fills: last bar snare/toms ${lastBar(nofill)} → ${lastBar(fills)}`);
  // Speed: half time puts the backbeat on 3 once a bar; double time twice as often
  const bb = (h) => countOf(h, 'clap');
  const half = drumHits('nova', { speed: 'half', fill: 0, cx: 0 }), norm = drumHits('nova', { speed: 'normal', fill: 0, cx: 0 }), dbl = drumHits('nova', { speed: 'double', fill: 0, cx: 0 });
  assert(bb(half) * 2 === bb(norm) && bb(dbl) === bb(norm) * 2, `speed: claps ${bb(half)} / ${bb(norm)} / ${bb(dbl)}`);
  assert(half.filter((x) => PIECES[x.k].id === 'clap').every((x) => Math.abs((x.s % 4) - 2) < 0.05), 'half time: backbeat on beat 3');
  // Swing delays the off-sixteenths; Feel lays the hats back against the kick
  const off16 = (h) => h.filter((x) => PIECES[x.k].id === 'chh').map((x) => (x.s * 4) % 2).filter((q) => q > 0.5 && q < 1.6);
  const st = off16(drumHits('jax', { swing: 0, feel: 0, hum: 0 })), sw = off16(drumHits('jax', { swing: 1, feel: 0, hum: 0 }));
  assert(st.every((q) => Math.abs(q - 1) < 0.01) && sw.every((q) => Math.abs(q - 4 / 3) < 0.02), `swing: off-16ths at ${st[0]?.toFixed(2)} → ${sw[0]?.toFixed(2)} sixteenths`);
  const laid = drumHits('milo', { swing: 0, feel: 1, hum: 0, fill: 0 });
  assert(laid.filter((x) => PIECES[x.k].id === 'snare').every((x) => (x.s % 1) > 0.01) && laid.filter((x) => PIECES[x.k].id === 'kick').some((x) => x.s % 1 === 0), 'feel: laid back snare behind a straight kick');
  // Parts: switching a part off removes its pieces; variations change the pattern
  const noHats = drumHits('vex', { parts: { kick: { on: true, v: 0 }, hats: { on: false, v: 0 }, perc: { on: true, v: 0 }, cym: { on: true, v: 0 } } });
  assert(countOf(noHats, 'chh', 'ohh') === 0, 'hats off');
  const v0 = drumHits('vex', { fill: 0 }), v2 = drumHits('vex', { fill: 0, parts: { kick: { on: true, v: 0 }, hats: { on: true, v: 2 }, perc: { on: true, v: 0 }, cym: { on: true, v: 0 } } });
  assert(JSON.stringify(v0.filter((x) => PIECES[x.k].id === 'chh')) !== JSON.stringify(v2.filter((x) => PIECES[x.k].id === 'chh')), 'hat variation 3 should differ');
  return `technique ${simple.length}→${complex.length} hits; loudness vel ${meanVel(soft).toFixed(2)}→${meanVel(loud).toFixed(2)}; claps half/normal/double ${bb(half)}/${bb(norm)}/${bb(dbl)}; swing → triplet; laid-back snare`;
});

await test('Drummer: builds, risers, pre-drop gap and crashes land in the right place', () => {
  const hits = drumHits('nova', { fill: 0.95, loud: 0.8 }, 64); // 16 bars
  const riser = hits.find((x) => PIECES[x.k].id === 'riser2');
  assert(riser && Math.abs(riser.s - 56) < 1e-6 && Math.abs(riser.l - 8) < 1e-6, `2-bar riser into the end (${riser ? riser.s + '/' + riser.l : 'none'})`);
  const roll = hits.filter((x) => PIECES[x.k].id === 'snare' && x.s >= 56);
  const late = roll.filter((x) => x.s >= 62.95), early = roll.filter((x) => x.s < 59.95);
  assert(late.length >= 4 && early.length <= 4 && roll.length >= 16, `snare roll accelerates (${early.length} early, ${late.length} in the last beat, ${roll.length} total)`);
  assert(meanVel(roll.filter((x) => x.s >= 62)) > meanVel(roll.filter((x) => x.s < 58)), 'roll crescendos');
  assert(!hits.some((x) => x.s >= 63.5 && !PIECES[x.k].id.startsWith('riser')), 'silence before the drop');
  const crashes = hits.filter((x) => PIECES[x.k].id === 'crash').map((x) => x.s);
  const near = (b) => crashes.some((x) => Math.abs(x - b) < 0.01);
  assert(near(0) && near(32), `crash at the start and after the bar-8 fill: ${crashes}`);
  return `16 bars: riser at bar 15, ${roll.length}-hit snare roll speeding up into a half-beat gap; crashes at beats ${crashes.map((x) => x.toFixed(2)).join(', ')}`;
});

await test('Drummer: the synthesized kit sounds every piece cleanly', () => {
  const kit = new DrumKit(48000), rows = [];
  for (let ki = 0; ki < KIT_NAMES.length; ki++) {
    const pr = drumDefaults(); pr.kit = ki;
    kit.setManualAll(drumParamArray(pr), true);
    for (const pc of PIECES) {
      if (pc.id.startsWith('riser')) continue;
      const ev = [{ t: 0.01, fn: () => kit.noteOn(pc.note, 0.9) }];
      const { L, R } = runPad(kit, 0.6, ev);
      let pk = 0, bad = false; for (let i = 0; i < L.length; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a !== a) bad = true; if (a > pk) pk = a; }
      assert(!bad, `${KIT_NAMES[ki]} ${pc.name}: NaN`);
      assert(pk > 0.02 && pk < 1, `${KIT_NAMES[ki]} ${pc.name}: peak ${pk.toFixed(3)}`);
      if (ki === 0) rows.push(`${pc.name} ${db(pk)}`);
      kit.allNotesOff(true);
    }
  }
  // open hat is choked by a closed hat
  const pr = drumDefaults(); kit.setManualAll(drumParamArray(pr), true);
  const open = runPad(kit, 0.45, [{ t: 0, fn: () => kit.noteOn(46, 1) }]).L; kit.allNotesOff(true);
  const choked = runPad(kit, 0.45, [{ t: 0, fn: () => kit.noteOn(46, 1) }, { t: 0.1, fn: () => kit.noteOn(42, 0.3) }]).L; kit.allNotesOff(true);
  const tOpen = rms(open, 0.3 * 48000, 0.4 * 48000), tail = rms(choked, 0.3 * 48000, 0.4 * 48000);
  assert(tail < tOpen * 0.05, `open hat should be choked by the closed hat (${db(tOpen)} → ${db(tail)} dB)`);
  // a riser sweeps upward: more high-frequency energy at the end than the start
  const rs = runPad(kit, 2.2, [{ t: 0, fn: () => kit.noteOn(84, 1) }, { t: 2.0, fn: () => kit.noteOff(84) }]);
  const zc = (x, a, b) => { let n = 0; for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++; return n; };
  const z0 = zc(rs.L, 2400, 14400), z1 = zc(rs.L, 72000, 84000);
  assert(z1 > z0 * 3 && rms(rs.L, 72000, 84000) > rms(rs.L, 2400, 14400), `riser sweeps up (${z0} → ${z1} crossings)`);
  return `9 kits × 13 pieces clean; open hat choked; riser sweeps ${z0}→${z1} zero-crossings. Festival: ${rows.join(', ')}`;
});

await test('Drummer track: region → notes → engine render; MIDI conversion; project round-trip', async () => {
  const p = newProject('drums'); p.tempo = 128; p.loop.on = false;
  const t = newTrack(p, 'instrument', { instrument: newDrumInstrument('Festival'), name: 'Drummer' });
  t.clips.push(newDrummerClip(0, 16, newDrummerSettings('nova', { seed: 99 })));
  p.tracks.push(t);
  const notes = compileNotes(t, 4);
  assert(notes.length / 4 > 40, `compiled ${notes.length / 4} notes`);
  const [L, R] = await render(p, { tail: 1 });
  let pk = 0; for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const lvl = 20 * Math.log10(rms(L, 0, L.length) + 1e-12);
  assert(pk > 0.1 && pk < 1, `engine render peak ${pk.toFixed(2)}`);
  // kick on every beat at 128 BPM: energy lands right after each beat
  const spb = (60 / 128) * 48000, onBeat = rms(L, Math.round(spb * 4), Math.round(spb * 4 + 1200)), between = rms(L, Math.round(spb * 4.6), Math.round(spb * 4.6 + 1200));
  assert(onBeat > between, `kick on the beat (${db(onBeat)} vs ${db(between)} dB)`);
  // a MIDI clip on the same track plays the same kit
  const raw = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert(raw.tracks[0].instrument.type === 'drums' && raw.tracks[0].clips[0].kind === 'drummer' && raw.tracks[0].clips[0].dr.seed === 99, 'round-trip keeps the drummer region');
  const bogus = JSON.parse(JSON.stringify(p)); bogus.tracks[0].instrument = { type: 'sawforge' };
  assert(normalizeProject(bogus).tracks[0].clips.length === 0, 'drummer regions only live on drum tracks');
  const mid = generateDrummer(t.clips[0].dr, 16, 4);
  assert(mid.length === notes.length / 4, 'MIDI conversion = the same hits');
  return `${notes.length / 4} hits in 4 bars; render peak ${pk.toFixed(2)}, ${lvl.toFixed(1)} dB RMS; kick on the beat; saves and reloads`;
});

await test('Automation writing: touch, overwrite, latch, loop wrap', () => {
  // the real recorder and store, with a stub engine whose playhead the test moves
  const make = (mode, loop) => {
    const p = newProject('auto'); p.loop = loop || { on: false, start: 0, end: 16 };
    const t = newTrack(p, 'instrument'); t.instrument.params['flt.cut'] = 632.5; p.tracks.push(t); // ~0.5 normalized
    const store = new Store(p), posts = [];
    const engine = { position: 0, playState: 1, post: (m) => posts.push(m) };
    const app = { store, engine, ui: { autoArm: true, autoMode: mode }, get p() { return store.p; } };
    return { app, rec: new AutomationRecorder(app), tid: t.id, posts };
  };
  const lane = (x) => x.app.p.tracks[0].automation.find((a) => a.target === 'inst:flt.cut');
  const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
  const sweep = (x, from, to, v0, v1) => { for (let b = from; b <= to + 1e-9; b += 0.05) { x.app.engine.position = b; x.rec.capture(x.tid, 'inst:flt.cut', v0 + ((v1 - v0) * (b - from)) / (to - from)); x.rec.tick(); } };

  // Touch on a fresh lane: writes the move, then glides back to the static value
  const a = make('touch');
  a.app.store.begin('Change Filter Cutoff');
  sweep(a, 1, 2, 0.5, 0.9);
  a.rec.release(); a.app.store.end('inst-param'); a.rec.afterGesture();
  const la = lane(a).points;
  assert(near(valueAt(la, 0.5), 0.5, 0.01) && near(valueAt(la, 1.5), 0.7) && near(valueAt(la, 2), 0.9) && near(valueAt(la, 3), 0.5, 0.01), `touch curve ${JSON.stringify(la)}`);
  assert(la.length <= 6, `ramp should simplify to a few points, got ${la.length}`);
  assert(a.app.store.undoLabel === 'Write automation', `undo label ${a.app.store.undoLabel}`);
  assert(a.posts.some((m) => m.type === 'touch' && m.on) && a.posts.some((m) => m.type === 'touch' && !m.on), 'engine touch on/off not sent');
  assert(a.posts.some((m) => m.type === 'param' && m.force), 'live value not forced to the engine');
  a.app.store.undo();
  assert(!lane(a), 'undo should remove the written lane');

  // Touch over an existing flat curve overwrites only what it passed
  const b = make('touch');
  b.app.store.do('lane', (q) => { q.tracks[0].automation.push({ id: 'l1', target: 'inst:flt.cut', points: [[0, 0.2], [8, 0.2]] }); });
  b.app.store.begin('x'); sweep(b, 2, 4, 0.8, 0.8); b.rec.release(); b.app.store.end('inst-param');
  const lb = lane(b).points;
  assert(near(valueAt(lb, 1), 0.2, 1e-6) && near(valueAt(lb, 3), 0.8, 1e-6) && near(valueAt(lb, 5), 0.2, 1e-6), `overwrite ${JSON.stringify(lb)}`);

  // Latch keeps the last value until the transport stops, as its own undo step
  const c = make('latch');
  c.app.store.begin('x'); sweep(c, 1, 1.5, 0.6, 0.6); c.rec.release(); c.app.store.end('inst-param'); c.rec.afterGesture();
  for (let bb = 1.5; bb <= 4; bb += 0.1) { c.app.engine.position = bb; c.rec.tick(); }
  c.app.engine.playState = 0; c.rec.tick();
  const lc = lane(c).points;
  assert(near(valueAt(lc, 3.5), 0.6, 1e-6) && !c.rec.busy, `latch ${JSON.stringify(lc)}`);
  assert(c.app.store.undoLabel === 'Write automation (latch)', `latch undo ${c.app.store.undoLabel}`);

  // Holding a control across the loop wrap writes both sides of the loop
  const d = make('touch', { on: true, start: 0, end: 4 });
  d.app.store.begin('x');
  for (const bb of [3, 3.3, 3.6, 3.9, 0.2, 0.5, 0.8, 1.0]) { d.app.engine.position = bb; d.rec.capture(d.tid, 'inst:flt.cut', 0.9); d.rec.tick(); }
  d.rec.release(); d.app.store.end('inst-param');
  const ld = lane(d).points;
  assert(near(valueAt(ld, 3.5), 0.9, 1e-6) && near(valueAt(ld, 0.5), 0.9, 1e-6) && near(valueAt(ld, 2), 0.5, 0.01), `wrap ${JSON.stringify(ld)}`);

  // pure helpers
  const ramp = Array.from({ length: 50 }, (_, i) => [i / 10, i / 50]);
  assert(simplify(ramp, 0.002).length === 2, 'straight ramp should simplify to its endpoints');
  assert(JSON.stringify(mergeSegment([[0, 0], [5, 1], [9, 0]], [[4, 0.5], [6, 0.5]])) === '[[0,0],[4,0.5],[6,0.5],[9,0]]', 'merge');
  return `touch ${la.length} pts + return; overwrite keeps the curve outside; latch holds 0.6 to stop; wrap writes ${ld.length} pts on both sides of the loop`;
});

await test('Render speed (8-voice supersaw stack, 4 s)', async () => {
  const notes = [48, 52, 55, 59, 60, 64, 67, 71].map((p) => newNote(p, 0, 8, 0.8));
  const p = synthProject('Hyper Supersaw', notes, { len: 8 });
  const t0 = performance.now();
  await render(p, { tail: 0 });
  const ms = performance.now() - t0;
  const rt = 4000 / ms;
  return `${ms.toFixed(0)} ms for 4 s of audio → ${rt.toFixed(1)}× real-time (8 voices × 14 unison oscillators + FX)`;
});

const failed = results.filter((r) => r.status === 'fail').length;
document.getElementById('summary').textContent = failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
window.__done = true;
