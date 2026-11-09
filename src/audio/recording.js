// Pure helpers for recording (no DOM, no audio APIs) so they can be tested.
//
// Timing model: the audio thread captures input in lockstep with its own
// sample clock and reports the ring position where the take starts (the
// exact sample playback started) and where it stops. A sound the performer
// makes in response to what they hear arrives `latency` samples late (output
// latency + input latency), so the performance time of captured sample j is
//   beat(j) = startBeat + (j - latency) / samplesPerBeat
// (unwrapped across loop passes when loop recording).

const u32 = (x) => x >>> 0;

// Decide where a take goes in the arrangement.
//   recorded   samples captured from the take start
//   latency    round-trip compensation in samples (>= 0)
//   startBeat  transport position at the take start
//   spb        samples per beat
//   loop       { on, start, end } at record time
//   punch      { on, start, end }: keep only what falls inside it
//   xfade      beats of extra audio to keep past each punch point, for crossfades
// Loop recording keeps the most recent pass that covered the whole window
// (the loop, or the punch range inside it); if none did, the most complete one.
// Returns { start, length, offsetFrames, pass, passes, xIn, xOut, carveStart, carveEnd, full, cover, takes } or null;
// `takes` lists every pass the same way (the chosen one included), for take lanes.
export function planTake({ recorded, latency, startBeat, spb, loop, punch, xfade = 0 }) {
  latency = Math.max(0, Math.round(latency || 0));
  const usable = recorded - latency;
  if (usable < spb / 64) return null;
  const endBeat = startBeat + usable / spb;
  const P = punch && punch.on && punch.end > punch.start ? punch : null;
  const MIN = 1 / 64, eps = 1e-6;
  // (all positions below are "unwrapped": loop pass k maps beat b to b + k * loopLength)
  const finish = (cs, ce, pass, passes, k, len, passBegin, passEnd) => {
    if (ce - cs < MIN) return null;
    let xIn = 0, xOut = 0;
    if (P && xfade > 0) {
      if (Math.abs(cs - (P.start + k * len)) < eps) xIn = Math.max(0, Math.min(xfade, cs - passBegin, cs - k * len));
      if (Math.abs(ce - (P.end + k * len)) < eps) xOut = Math.max(0, Math.min(xfade, passEnd - ce));
    }
    const s = cs - xIn;
    return { start: s - k * len, length: ce + xOut - s, offsetFrames: latency + Math.round((s - startBeat) * spb), pass, passes,
      xIn, xOut, carveStart: cs - k * len, carveEnd: ce - k * len };
  };
  const wrapped = loop && loop.on && loop.end > loop.start && startBeat < loop.end - eps && endBeat > loop.end + eps;
  if (!wrapped) {
    let cs = startBeat, ce = endBeat;
    if (P) { cs = Math.max(cs, P.start); ce = Math.min(ce, P.end); }
    const r = finish(cs, ce, 1, 1, 0, 0, startBeat, endBeat);
    return r && { ...r, full: true, cover: 1, takes: [{ ...r, full: true, cover: 1 }] };
  }
  const len = loop.end - loop.start;
  const cands = [];
  for (let k = 0; k === 0 || loop.start + k * len < endBeat - eps; k++) {
    let ws, we;
    if (P) { ws = k === 0 ? P.start : Math.max(P.start, loop.start); we = Math.min(loop.end, P.end); }
    else { ws = k === 0 ? startBeat : loop.start; we = loop.end; }
    const uws = ws + k * len, uwe = we + k * len;
    const passBegin = k === 0 ? startBeat : loop.start + k * len, passEnd = Math.min(loop.end + k * len, endBeat);
    const cs = Math.max(uws, startBeat, passBegin), ce = Math.min(uwe, endBeat);
    if (ce - cs >= MIN) cands.push({ k, cs, ce, full: cs <= uws + eps && ce >= uwe - eps, passBegin, passEnd, win: uwe - uws });
    if (k > 10000) break;
  }
  if (!cands.length) return null;
  let pick = null;
  for (const c of cands) if (c.full) pick = c;
  if (!pick) for (const c of cands) if (!pick || c.ce - c.cs > pick.ce - pick.cs + eps) pick = c;
  const takes = cands.map((c, i) => ({ ...finish(c.cs, c.ce, i + 1, cands.length, c.k, len, c.passBegin, c.passEnd), full: c.full, cover: (c.ce - c.cs) / Math.max(MIN, c.win) }));
  return { ...takes[cands.indexOf(pick)], takes };
}

// Copy ring positions [from, to) out of collected chunks.
// collect = { start (ring position of first collected sample), L: [Float32Array], R: [...] }
export function extractRange(collect, from, to) {
  const n = u32(to - from);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  let rel = (from - collect.start) | 0; // may be negative if capture began late
  let pos = 0;
  for (let c = 0; c < collect.L.length && pos < n + rel; c++) {
    const a = collect.L[c], b = collect.R[c], len = a.length;
    const s = Math.max(0, rel - pos), e = Math.min(len, rel + n - pos);
    if (e > s) { outL.set(a.subarray(s, e), pos + s - rel); outR.set(b.subarray(s, e), pos + s - rel); }
    pos += len;
  }
  return [outL, outR];
}

// Peak envelope (one value per `block` samples) for drawing.
export class PeakTrace {
  constructor(block = 512) { this.block = block; this.values = []; this.acc = 0; this.n = 0; }
  push(L, R) {
    const block = this.block;
    let acc = this.acc, n = this.n;
    for (let i = 0; i < L.length; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > acc) acc = a;
      if (++n === block) { this.values.push(acc); acc = 0; n = 0; }
    }
    this.acc = acc; this.n = n;
  }
}

// Locate a calibration click: first sample over 30% of the window peak,
// provided the peak clearly exceeds the background noise.
export function findOnset(x, from, to, noiseRms) {
  let peak = 0;
  for (let i = from; i < to && i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < Math.max(0.004, noiseRms * 8)) return -1;
  const thr = peak * 0.3;
  for (let i = from; i < to && i < x.length; i++) if (Math.abs(x[i]) >= thr) return i;
  return -1;
}

// Remove the part of existing audio clips covered by [start, end): a new take
// replaces what it overlaps. Clips are split or trimmed; audio offsets follow.
// Crossfades (beats), when the new audio is laid in with them:
//   fades.left / fades.right   the old audio fades out ending at `start` and
//                              back in from `end` (the new audio overlaps it)
//   fades.leftOver / rightOver the old audio runs on past `start` (or begins
//                              before `end`) and fades there instead, for new
//                              audio that has nothing before or after the cut
// Clips that merely touch the cut get the same treatment. A leftover piece
// that is nothing but an old crossfade tail is dropped.
// fades.maxEnd(c) / fades.minStart(c) say how far a clip's audio really goes
// (default: its own end; as far back as its file has audio).
// Returns how far the old audio was actually extended: { leftOver, rightOver }.
export function carveAudio(track, start, end, tempo, makeId, fades = {}) {
  const out = [];
  const fl = Math.max(0, fades.left || 0), fr = Math.max(0, fades.right || 0);
  const lo = Math.max(0, fades.leftOver || 0), ro = Math.max(0, fades.rightOver || 0);
  const maxEnd = fades.maxEnd || ((c) => c.start + c.length);
  const minStart = fades.minStart || ((c) => c.start - ((c.offset || 0) * tempo) / 60);
  const eps = 1e-9, touch = 1e-6;
  let gotLo = 0, gotRo = 0;
  for (const c of track.clips) {
    const cs = c.start, ce = c.start + c.length;
    if (c.kind !== 'audio') { out.push(c); continue; }
    if (Math.abs(ce - start) < touch && cs < start - eps) { // ends right at the cut
      const ext = Math.max(0, Math.min(lo, maxEnd(c) - ce));
      gotLo = Math.max(gotLo, ext);
      out.push(ext > 0 ? { ...c, length: c.length + ext, fadeOut: ext } : fl > 0 ? { ...c, fadeOut: Math.min(fl, c.length) } : c);
      continue;
    }
    if (Math.abs(cs - end) < touch && ce > end + eps) { // starts right at the cut
      const ext = Math.max(0, Math.min(ro, cs - minStart(c)));
      gotRo = Math.max(gotRo, ext);
      out.push(ext > 0 ? { ...c, start: cs - ext, length: c.length + ext, offset: (c.offset || 0) - (ext * 60) / tempo, fadeIn: ext } : fr > 0 ? { ...c, fadeIn: Math.min(fr, c.length) } : c);
      continue;
    }
    if (ce <= start + eps || cs >= end - eps) { out.push(c); continue; }
    if (cs < start - eps && start - cs > (c.fadeIn || 0) + eps) {
      const ext = Math.max(0, Math.min(lo, maxEnd(c) - start));
      gotLo = Math.max(gotLo, ext);
      out.push({ ...c, length: start - cs + ext, fadeOut: Math.min(fl + ext, start - cs + ext) });
    }
    if (ce > end + eps && ce - end > (c.fadeOut || 0) + eps) {
      const ext = Math.max(0, Math.min(ro, end - minStart(c)));
      gotRo = Math.max(gotRo, ext);
      const ns = end - ext;
      out.push({ ...c, id: cs < start - eps ? makeId() : c.id, start: ns, length: ce - ns, offset: (c.offset || 0) + ((ns - cs) * 60) / tempo, fadeIn: Math.min(fr + ext, ce - ns) });
    }
  }
  track.clips = out;
  return { leftOver: gotLo, rightOver: gotRo };
}

// ---------------------------------------------------------------- MIDI punch takes

// Notes played during a punch take: only those that start inside [start, end)
// count, and they are cut at the punch-out.
export function punchNotes(notes, start, end) {
  return notes.filter((n) => n.s >= start - 1e-6 && n.s < end - 1e-6)
    .map((n) => ({ ...n, l: Math.max(0.03, Math.min(n.l, end - n.s)) }));
}

// Turn a looped MIDI clip into plain notes, so part of it can be replaced
// without changing the other repeats. Returns true if the clip changed.
export function unrollClip(c) {
  const Lc = c.loopLen > 0 ? c.loopLen : c.length, off = c.offset || 0;
  if (off + c.length <= Lc + 1e-9) return false;
  const end = c.start + c.length, out = [];
  for (let k = Math.floor(off / Lc); k < 100000; k++) {
    const base = c.start - off + k * Lc;
    if (base >= end - 1e-9) break;
    for (const n of c.notes) {
      if (n.s >= Lc - 1e-9) continue;
      const t = base + n.s;
      if (t < c.start - 1e-9 || t >= end - 1e-9) continue;
      out.push({ ...n, s: t - c.start, l: Math.min(n.l, Lc - n.s) });
    }
  }
  out.sort((a, b) => a.s - b.s || a.p - b.p);
  c.notes = out; c.offset = 0; c.loopLen = c.length;
  return true;
}

// Replace [start, end) on a track's MIDI clips with `notes` (timeline beats):
// old notes starting inside go, notes ringing into it are cut at the punch-in,
// and the new notes land in the clip that covers the range (or a new one).
export function placePunchMidi(track, notes, start, end, makeClip) {
  for (const c of track.clips) {
    if (c.kind !== 'midi' || c.start >= end - 1e-9 || c.start + c.length <= start + 1e-9) continue;
    unrollClip(c);
    const base = c.start - (c.offset || 0), ce = c.start + c.length;
    const keep = [];
    for (const n of c.notes) {
      const t = base + n.s;
      const visible = t >= c.start - 1e-9 && t < ce - 1e-9;
      if (visible && t >= start - 1e-9 && t < end - 1e-9) continue;
      if (visible && t < start && t + n.l > start + 1e-9) keep.push({ ...n, l: Math.max(0.03, start - t) });
      else keep.push(n);
    }
    c.notes = keep;
  }
  let clip = track.clips.find((c) => c.kind === 'midi' && c.start <= start + 1e-6 && c.start + c.length >= end - 1e-6);
  if (!clip) { clip = makeClip(); track.clips.push(clip); }
  const base = clip.start - (clip.offset || 0);
  for (const n of notes) clip.notes.push({ p: n.p, s: n.s - base, l: n.l, v: n.v });
  clip.notes.sort((a, b) => a.s - b.s || a.p - b.p);
  return clip;
}
