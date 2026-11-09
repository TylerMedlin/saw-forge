// Take lanes and comping (audio tracks).
//
// Every recorded take (each loop pass too) is kept as a clip in a take lane
// under its track. The track's own clips are the comp: what actually plays.
// Comping copies a range of a take into the comp, replacing what was there,
// with short crossfades at the edges. Comp clips remember which take they
// came from (clip.src), so the lanes can show which parts are in use.
// Pure functions on plain project data, so they can be tested.

import { carveAudio } from '../audio/recording.js';
import { uid } from './project.js';

export const COMP_XFADE_SEC = 0.01;
const MIN_LEN = 1 / 64; // beats

// Is comp clip c playing take clip T's audio at the same timeline position?
export function aligned(c, T, tempo) {
  if (!c || c.kind !== 'audio' || !c.src || c.src.clip !== T.id || c.assetId !== T.assetId) return false;
  return Math.abs((c.offset - T.offset) - ((c.start - T.start) * 60) / tempo) < 1e-3;
}

// Parts of take clip T that the comp currently plays, as [start, end] beats.
export function usedRanges(track, T, tempo) {
  const out = [];
  for (const c of track.clips) {
    if (c.mute || !aligned(c, T, tempo)) continue;
    const a = Math.max(c.start, T.start), b = Math.min(c.start + c.length, T.start + T.length);
    if (b > a + 1e-9) out.push([a, b]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of out) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
  return merged;
}

// Share of a lane's audio that the comp uses (0..1).
export function laneUsage(track, lane, tempo) {
  let total = 0, used = 0;
  for (const T of lane.clips) { total += T.length; for (const [a, b] of usedRanges(track, T, tempo)) used += b - a; }
  return total > 0 ? used / total : 0;
}

// Store newly recorded takes, each in a new lane at the top (newest first).
// `clips` are audio clips in recording order. Returns the new lanes, oldest first.
export function addTakeLanes(track, clips) {
  track.takeLanes = track.takeLanes || [];
  const lanes = [];
  for (const clip of clips) {
    track.takeSeq = (track.takeSeq || 0) + 1;
    const lane = { id: uid('tkl'), name: `Take ${track.takeSeq}`, clips: [{ ...clip, id: uid('clp'), name: `${track.name} take ${track.takeSeq}`, src: undefined }] };
    delete lane.clips[0].src;
    track.takeLanes.unshift(lane);
    lanes.push(lane);
  }
  return lanes;
}

// Copy [a, b) of take clip T (from `lane`) into the comp, replacing what is
// there. Each edge gets a crossfade of `xfadeBeats` with the neighbouring comp
// audio: the take runs on past the edge when it has audio there, otherwise the
// neighbour runs on under the take. Touching parts of the same take join.
export function compRange(track, lane, T, a, b, tempo, xfadeBeats = 0) {
  const ts = T.start, te = T.start + T.length;
  a = Math.max(a, ts); b = Math.min(b, te);
  if (b - a < MIN_LEN) return null;
  const xL = a > ts + 1e-9 ? Math.min(xfadeBeats, a - ts) : 0;
  const xR = b < te - 1e-9 ? Math.min(xfadeBeats, te - b) : 0;
  const under = Math.min(xfadeBeats, (b - a) / 2);
  // comp clips can run on as far as their take has audio
  const takeOf = (c) => {
    const l = c.src && (track.takeLanes || []).find((x) => x.id === c.src.lane);
    const tk = l && l.clips.find((x) => x.id === c.src.clip);
    return tk && aligned(c, tk, tempo) ? tk : null;
  };
  const got = carveAudio(track, a, b, tempo, () => uid('clp'), {
    left: xL, right: xR, leftOver: xL ? 0 : under, rightOver: xR ? 0 : under,
    maxEnd: (c) => { const tk = takeOf(c); return Math.max(c.start + c.length, tk ? tk.start + tk.length : 0); },
    minStart: (c) => { const tk = takeOf(c); return tk ? Math.min(c.start, tk.start) : c.start - ((c.offset || 0) * tempo) / 60; },
  });
  let s = a - xL, e = b + xR;
  let fadeIn = xL > 0 ? xL : got.leftOver > 0 ? got.leftOver : (T.fadeIn || 0);
  let fadeOut = xR > 0 ? xR : got.rightOver > 0 ? got.rightOver : (T.fadeOut || 0);
  for (const c of [...track.clips]) {
    if (!aligned(c, T, tempo)) continue;
    const cs = c.start, ce = c.start + c.length;
    if (ce < s - 1e-6 || cs > e + 1e-6) continue;
    if (cs < s - 1e-9) { s = cs; fadeIn = c.fadeIn || 0; }
    if (ce > e + 1e-9) { e = ce; fadeOut = c.fadeOut || 0; }
    track.clips.splice(track.clips.indexOf(c), 1);
  }
  const clip = { ...T, id: uid('clp'), start: s, length: e - s, offset: T.offset + ((s - ts) * 60) / tempo, fadeIn, fadeOut, mute: false, src: { lane: lane.id, clip: T.id } };
  track.clips.push(clip);
  return clip;
}

// Comp [a, b) from every take clip of a lane that overlaps it.
export function compLaneRange(track, lane, a, b, tempo, xfadeBeats = 0) {
  const made = [];
  for (const T of lane.clips) {
    if (T.start >= b - 1e-9 || T.start + T.length <= a + 1e-9) continue;
    const c = compRange(track, lane, T, a, b, tempo, xfadeBeats);
    if (c) made.push(c);
  }
  return made;
}

// Give a duplicated track fresh lane and take ids, keeping comp links intact.
export function remapTakeIds(track) {
  const laneMap = new Map(), clipMap = new Map();
  for (const lane of track.takeLanes || []) {
    const nl = uid('tkl'); laneMap.set(lane.id, nl); lane.id = nl;
    for (const c of lane.clips) { const nc = uid('clp'); clipMap.set(c.id, nc); c.id = nc; }
  }
  for (const c of track.clips) if (c.src) c.src = { lane: laneMap.get(c.src.lane) || c.src.lane, clip: clipMap.get(c.src.clip) || c.src.clip };
}
