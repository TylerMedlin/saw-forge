// Flattens the editable project into the compact form the audio thread uses:
// typed arrays of note events per track (clip loops expanded), audio regions,
// resolved routing, solo logic and automation lanes.

import { SYNTH_PARAMS, SYNTH_INDEX, EFFECT_DEFS, dbToGain, effectParamIndex } from '../shared/params.js';
import { worshipParamArray, parseIntervals } from '../shared/worship-params.js';
import { drumParamArray } from '../shared/drums.js';
import { generateDrummer } from '../shared/drummers.js';
import { instDefs } from '../shared/instruments.js';

export const MIN_NOTE = 0.01; // beats

export function compileNotes(track, barLen = 4) {
  const ev = [];
  for (const clip of track.clips) {
    if (clip.mute) continue;
    if (clip.kind === 'drummer') { // Drummer region: generate its hits
      for (const n of generateDrummer(clip.dr, clip.length, barLen)) { const s = clip.start + n.s; ev.push([s, s + Math.max(n.l, MIN_NOTE), n.p, n.v]); }
      continue;
    }
    if (clip.kind !== 'midi') continue;
    const L = clip.loopLen > 0 ? clip.loopLen : clip.length;
    const off = clip.offset || 0;
    const end = clip.start + clip.length;
    for (let k = Math.floor(off / L); ; k++) {
      const base = clip.start - off + k * L;
      if (base >= end - 1e-9) break;
      for (const n of clip.notes) {
        if (n.s >= L - 1e-9) continue;
        const s = base + n.s;
        if (s < clip.start - 1e-9 || s >= end - 1e-9) continue;
        const e = Math.min(s + n.l, end, base + L);
        ev.push([s, Math.max(e, s + MIN_NOTE), n.p, n.v]);
      }
      if (k > 100000) break;
    }
  }
  ev.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const out = new Float64Array(ev.length * 4);
  ev.forEach((e, i) => { out[i * 4] = e[0]; out[i * 4 + 1] = e[1]; out[i * 4 + 2] = e[2]; out[i * 4 + 3] = e[3]; });
  return out;
}

export function parseTarget(target, instType = 'sawforge') {
  const parts = target.split(':');
  if (parts[0] === 'mix') {
    if (parts[1] === 'vol') return { kind: 0 };
    if (parts[1] === 'pan') return { kind: 1 };
    if (parts[1] === 'send') return { kind: 2, bus: parts[2] };
  } else if (parts[0] === 'inst') {
    const index = instDefs(instType).INDEX[parts.slice(1).join(':')];
    if (index !== undefined) return { kind: 3, index };
  } else if (parts[0] === 'fx') {
    return { kind: 4, slot: parts[1], pid: parts.slice(2).join(':') };
  }
  return null;
}

// Resolve a lane target on a channel to the engine's addressing (null if it no longer exists).
export function resolveTarget(ch, target) {
  const t = parseTarget(target, ch.instrument ? ch.instrument.type : 'sawforge');
  if (!t) return null;
  if (t.kind === 4) {
    const ins = (ch.inserts || []).find((x) => x.id === t.slot);
    if (!ins) return null;
    t.index = effectParamIndex(ins.type, t.pid);
    if (t.index < 0) return null;
    t.type = ins.type;
  }
  t.key = `${t.kind}:${t.index | 0}:${t.slot || ''}:${t.bus || ''}`; // stable identity used for "touched" lanes
  return t;
}

function compileLanes(ch) {
  const out = [];
  for (const lane of ch.automation || []) {
    if (!lane.points || !lane.points.length) continue;
    const t = resolveTarget(ch, lane.target);
    if (!t) continue;
    const pts = new Float64Array(lane.points.length * 2);
    lane.points.forEach((p, i) => { pts[i * 2] = p[0]; pts[i * 2 + 1] = p[1]; });
    out.push({ kind: t.kind, index: t.index, slot: t.slot, bus: t.bus, key: t.key, points: pts });
  }
  return out;
}

function compileInserts(list) {
  return (list || []).map((fx) => ({
    id: fx.id, type: fx.type, bypass: !!fx.bypass,
    params: Float64Array.from(EFFECT_DEFS[fx.type].params.map((d) => (fx.params[d.id] ?? d.def))),
  }));
}

export function instParamArray(inst) {
  return Float64Array.from(SYNTH_PARAMS.map((d) => (inst.params[d.id] ?? d.def)));
}

// Instrument data for the engine: Saw Forge (flat param array) or Worship Atmospheres.
export function compileInstrument(inst, snap) {
  if (!inst) return null;
  if (inst.type === 'worship') return { type: 'worship', params: worshipParamArray(inst.params), snap, custom: parseIntervals(inst.custom) };
  if (inst.type === 'drums') return { type: 'drums', params: drumParamArray(inst.params), snap };
  return { params: instParamArray(inst), snap };
}

export function compileProject(p, { slotOf = () => -1, transport = {}, snap = null, audition = null, live = false } = {}) {
  const soloBuses = new Set(p.buses.filter((b) => b.solo).map((b) => b.id));
  const anySolo = p.tracks.some((t) => t.solo) || soloBuses.size > 0;
  const trackAudible = (t) => !t.mute && (!anySolo || t.solo || soloBuses.has(t.output) || t.sends.some((s) => soloBuses.has(s.busId)));
  const busAudible = (b) => !b.mute && (soloBuses.size === 0 || b.solo);
  const channels = [];
  for (const t of p.tracks) {
    // auditioning a take lane: that track plays the lane instead of its comp
    const auLane = audition && audition.track === t.id ? (t.takeLanes || []).find((l) => l.id === audition.lane) : null;
    const audioClips = auLane ? auLane.clips : t.clips;
    channels.push({
      id: t.id, kind: 'track', slot: slotOf(t.id),
      gain: dbToGain(t.vol), pan: t.pan, audible: trackAudible(t), output: t.output || 'master',
      monitor: t.kind === 'audio' && !!t.monitor && !!t.arm,
      input: t.input === 'L' ? 1 : t.input === 'R' ? 2 : 0,
      sends: t.sends.map((s) => ({ bus: s.busId, gain: dbToGain(s.level), pre: !!s.pre })),
      inserts: compileInserts(t.inserts),
      inst: compileInstrument(t.instrument, snap ? snap.has(t.id) : false),
      notes: t.kind === 'instrument' ? compileNotes(t, (p.sigNum * 4) / p.sigDen) : null,
      regions: t.kind === 'audio' ? audioClips.filter((c) => !c.mute).map((c) => ({
        asset: c.assetId, start: c.start, end: c.start + c.length, offset: c.offset || 0, gain: dbToGain(c.gain || 0),
        fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
      })) : [],
      lanes: compileLanes(t),
    });
  }
  for (const b of p.buses) {
    channels.push({
      id: b.id, kind: 'bus', slot: slotOf(b.id), gain: dbToGain(b.vol), pan: b.pan, audible: busAudible(b), output: 'master',
      sends: [], inserts: compileInserts(b.inserts), inst: null, notes: null, regions: [], lanes: compileLanes(b),
    });
  }
  // LIVE PAD: an always-on channel outside the arrangement (not part of exports)
  if (live && p.live) {
    channels.push({
      id: 'livepad', kind: 'track', slot: slotOf('livepad'), gain: dbToGain(p.live.vol), pan: 0, audible: !p.live.mute, output: 'master',
      monitor: false, input: 0, sends: [], inserts: [], inst: { type: 'live', params: worshipParamArray(p.live.patch.params), snap: false, custom: parseIntervals(p.live.patch.custom) },
      notes: null, regions: [], lanes: [],
    });
  }
  channels.push({
    id: 'master', kind: 'master', slot: slotOf('master'), gain: dbToGain(p.master.vol), pan: p.master.pan || 0, audible: !p.master.mute,
    output: null, sends: [], inserts: compileInserts(p.master.inserts), inst: null, notes: null, regions: [], lanes: compileLanes(p.master),
  });
  return {
    transport: {
      tempo: p.tempo, num: p.sigNum, den: p.sigDen,
      loopOn: p.loop.on, loopStart: p.loop.start, loopEnd: p.loop.end,
      metroOn: p.metronome.on, metroLevel: p.metronome.level,
      ...transport,
    },
    channels,
  };
}
