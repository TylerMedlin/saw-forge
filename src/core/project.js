// Project data model. Everything here is plain JSON so it can be snapshotted
// for undo, autosaved for recovery and written to project files.

import { synthDefaults, effectDefaults, EFFECT_DEFS, SYNTH_DEF } from '../shared/params.js';
import { getWtPreset, makeFrame, WT_MAX_KEYS } from '../shared/wavetable.js';
import { WP_DEF, worshipDefaults } from '../shared/worship-params.js';
import { worshipPresetByName, worshipPresetParams } from '../shared/worship-presets.js';
import { DRUM_DEF, drumDefaults, kitIndex, KIT_NAMES } from '../shared/drums.js';
import { newDrummerSettings, normDrummerSettings, drummerById } from '../shared/drummers.js';

export const WORSHIP_WT = ['Analog Saw', 'Saw → Square', 'Dark → Bright', 'Formant Sweep'];

export const PROJECT_VERSION = 1;
export const TRACK_COLORS = ['#e8833a', '#d9b44a', '#86b85a', '#3fb3a0', '#4f9ddb', '#8c7fd9', '#cc6c9c', '#d06060', '#9aa5b1'];

let uidCounter = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36).slice(-5)}${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const cloneJSON = (o) => JSON.parse(JSON.stringify(o));

export function newProject(name = 'Untitled') {
  return {
    version: PROJECT_VERSION,
    name,
    tempo: 120, sigNum: 4, sigDen: 4,
    loop: { on: true, start: 0, end: 16 },
    // punch recording: only [start, end) is recorded; preRoll = bars played before the punch-in (-1: from the playhead)
    punch: { on: false, start: 4, end: 8, preRoll: 1, set: false },
    metronome: { on: false, level: 0.6, countIn: 1 },
    markers: [],
    tracks: [], buses: [],
    master: newMaster(),
    assets: [],
    live: newLive(),
  };
}

// Worship Atmospheres instrument: a flat parameter set plus four user-editable wavetables.
export function newWorshipInstrument(presetName = 'Endless Worship') {
  const preset = worshipPresetByName(presetName);
  return { type: 'worship', preset: preset ? preset.name : 'Init Pad', params: worshipPresetParams(preset), wt: WORSHIP_WT.map((n) => getWtPreset(n)), custom: '0 7 12 16' };
}

// EDM drum kit instrument: a flat parameter set (the kit is the 'kit' parameter).
export function newDrumInstrument(kitName = 'Festival') {
  return { type: 'drums', preset: KIT_NAMES[kitIndex(kitName)], params: { ...drumDefaults(), kit: kitIndex(kitName) }, wt: [] };
}
// A Drummer region: the drummer and their settings; the hits are generated when the project compiles.
export function newDrummerClip(start, length, settings = newDrummerSettings('nova'), name = null) {
  return { id: uid('clp'), kind: 'drummer', name: name || drummerById(settings.id).name, start, length, offset: 0, mute: false, dr: settings };
}
export const isDrumTrack = (t) => !!(t && t.instrument && t.instrument.type === 'drums');
// Can this clip live on this track? (audio ↔ audio tracks, MIDI ↔ instruments, Drummer ↔ drum tracks)
export function clipFits(t, clip) {
  if (!t) return false;
  if (clip.kind === 'audio') return t.kind === 'audio';
  if (clip.kind === 'drummer') return isDrumTrack(t);
  return t.kind === 'instrument';
}

// LIVE PAD state saved with the project: the sound, how it moves, and the setlists.
export function newLive() {
  return {
    vol: -4, mute: false,
    patch: newWorshipInstrument('Endless Worship'),
    xfade: 4,            // preset crossfade (s)
    fadeIn: 3, fadeOut: 8,
    transition: 'gentle', transTime: 4, voiceLead: true,
    keepVoicing: false,  // keep the current voicing when changing presets
    lastKey: 7, lastMinor: false, spell: 'auto',
    setlists: [], activeSetlist: null,
  };
}
export function newSetlist(name = 'Sunday Service') { return { id: uid('set'), name, songs: [] }; }
export function newSong(o = {}) {
  return { id: uid('song'), title: o.title || 'New song', artist: o.artist || '', key: o.key ?? 7, minor: !!o.minor, spell: o.spell || 'auto',
    preset: o.preset || '', voicing: o.voicing ?? -1, transition: o.transition || '', transTime: o.transTime ?? 0, tempo: o.tempo ?? 0, notes: o.notes || '' };
}

export function newMaster() {
  return { id: 'master', name: 'Master', color: '#c8ced6', vol: 0, pan: 0, mute: false, solo: false, inserts: [], automation: [], showLanes: false };
}

export function nextColor(project) {
  return TRACK_COLORS[(project.tracks.length + project.buses.length) % TRACK_COLORS.length];
}

export function newSynthInstrument(preset) {
  const params = synthDefaults();
  if (preset && preset.params) Object.assign(params, preset.params);
  const wt = preset && preset.wt ? preset.wt.map((w) => (typeof w === 'string' ? getWtPreset(w) : cloneJSON(w))) : [getWtPreset('Analog Saw'), getWtPreset('Saw → Square')];
  return { type: 'sawforge', preset: preset ? preset.name : 'Init Saw', params, wt };
}

export function newTrack(project, kind, opts = {}) {
  const n = project.tracks.filter((t) => t.kind === kind).length + 1;
  return {
    id: uid('trk'), kind,
    name: opts.name || (kind === 'instrument' ? `Saw Forge ${n}` : `Audio ${n}`),
    color: opts.color || nextColor(project),
    mute: false, solo: false, arm: false,
    vol: 0, pan: 0, output: 'master', sends: [], inserts: [],
    instrument: kind === 'instrument' ? (opts.instrument || newSynthInstrument(opts.preset)) : null,
    clips: [], automation: [], showLanes: false, height: 64,
    input: 'stereo', monitor: false, // audio tracks: which input channels to record, and whether to hear them while armed
    takeLanes: [], showTakes: false, takeSeq: 0, // audio tracks: every recorded take, for comping (see core/comp.js)
  };
}

export function newBus(project, name) {
  const n = project.buses.length + 1;
  return { id: uid('bus'), name: name || `Bus ${String.fromCharCode(64 + n)}`, color: nextColor(project), mute: false, solo: false, vol: 0, pan: 0, output: 'master', sends: [], inserts: [], automation: [], showLanes: false };
}

export function newInsert(type, params) {
  return { id: uid('fx'), type, bypass: false, params: { ...effectDefaults(type), ...(params || {}) } };
}

export function newMidiClip(start, length, notes = [], name = 'MIDI Clip') {
  return { id: uid('clp'), kind: 'midi', name, start, length, loopLen: length, offset: 0, notes, mute: false };
}

export function newAudioClip(asset, start, lengthBeats, name) {
  return { id: uid('clp'), kind: 'audio', name: name || asset.name, start, length: lengthBeats, assetId: asset.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, mute: false };
}

export function newLane(target) { return { id: uid('aut'), target, points: [] }; }
export const newNote = (p, s, l, v = 0.8) => ({ p, s, l, v });

export const allChannels = (p) => [...p.tracks, ...p.buses, p.master];
export function findChannel(p, id) {
  if (id === 'master') return p.master;
  return p.tracks.find((t) => t.id === id) || p.buses.find((b) => b.id === id) || null;
}
export const findTrack = (p, id) => p.tracks.find((t) => t.id === id) || null;
export function findClip(p, id) {
  for (const t of p.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return { clip: c, track: t }; }
  return null;
}
export const clipEnd = (c) => c.start + c.length;
export const barBeats = (p) => (p.sigNum * 4) / p.sigDen;
export function projectEndBeat(p) {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

// --- loading / migration: fill gaps so older or hand-edited files still open ---
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
function normInserts(list) {
  return (Array.isArray(list) ? list : []).filter((fx) => fx && EFFECT_DEFS[fx.type]).map((fx) => ({
    id: fx.id || uid('fx'), type: fx.type, bypass: !!fx.bypass, params: { ...effectDefaults(fx.type), ...(fx.params || {}) },
  }));
}
function normAutomation(list) {
  return (Array.isArray(list) ? list : []).filter((a) => a && typeof a.target === 'string').map((a) => ({
    id: a.id || uid('aut'), target: a.target,
    points: (Array.isArray(a.points) ? a.points : []).filter((pt) => Array.isArray(pt) && pt.length >= 2).map((pt) => [num(pt[0], 0), Math.min(1, Math.max(0, num(pt[1], 0)))]).sort((x, y) => x[0] - y[0]),
  }));
}
function normWavetable(w, fallback) {
  if (!w || !Array.isArray(w.frames) || !w.frames.length) return getWtPreset(fallback);
  return { name: String(w.name || 'Custom'), frames: w.frames.slice(0, WT_MAX_KEYS).map((f) => makeFrame(f)) };
}
export function normalizeProject(raw) {
  const p = { ...newProject(), ...raw };
  p.version = PROJECT_VERSION;
  p.name = String(p.name || 'Untitled');
  p.tempo = Math.min(999, Math.max(20, num(p.tempo, 120)));
  p.sigNum = Math.min(32, Math.max(1, Math.round(num(p.sigNum, 4))));
  p.sigDen = [2, 4, 8, 16].includes(p.sigDen) ? p.sigDen : 4;
  p.loop = { on: !!(p.loop && p.loop.on), start: num(p.loop && p.loop.start, 0), end: num(p.loop && p.loop.end, 16) };
  if (p.loop.end <= p.loop.start) p.loop.end = p.loop.start + 4;
  const pu = (raw && raw.punch) || {};
  p.punch = { on: !!pu.on, start: Math.max(0, num(pu.start, 4)), end: num(pu.end, 8), preRoll: [-1, 0, 1, 2].includes(pu.preRoll) ? pu.preRoll : 1, set: !!pu.set };
  if (p.punch.end < p.punch.start + 0.25) p.punch.end = p.punch.start + 4;
  p.metronome = { on: false, level: 0.6, countIn: 1, ...(p.metronome || {}) };
  p.markers = (Array.isArray(p.markers) ? p.markers : []).map((m) => ({ id: m.id || uid('mrk'), beat: num(m.beat, 0), name: String(m.name || 'Marker') }));
  p.assets = (Array.isArray(p.assets) ? p.assets : []).filter((a) => a && a.id);
  p.buses = (Array.isArray(p.buses) ? p.buses : []).map((b) => ({
    ...newBus(p), ...b, id: b.id || uid('bus'), inserts: normInserts(b.inserts), automation: normAutomation(b.automation), sends: [], output: 'master',
  }));
  const busIds = new Set(p.buses.map((b) => b.id));
  p.tracks = (Array.isArray(p.tracks) ? p.tracks : []).map((t) => {
    const kind = t.kind === 'audio' ? 'audio' : 'instrument';
    const base = { ...newTrack(p, kind, { instrument: kind === 'instrument' ? newSynthInstrument() : null }), ...t, kind };
    base.id = t.id || uid('trk');
    base.vol = num(base.vol, 0); base.pan = num(base.pan, 0);
    base.input = ['stereo', 'L', 'R'].includes(t.input) ? t.input : 'stereo';
    base.monitor = !!t.monitor;
    const normTake = (c) => ({ ...c, kind: 'audio', id: c.id || uid('clp'), start: Math.max(0, num(c.start, 0)), length: Math.max(0.0625, num(c.length, 4)),
      offset: Math.max(0, num(c.offset, 0)), gain: num(c.gain, 0), fadeIn: Math.max(0, num(c.fadeIn, 0)), fadeOut: Math.max(0, num(c.fadeOut, 0)), mute: false });
    base.takeLanes = kind !== 'audio' ? [] : (Array.isArray(t.takeLanes) ? t.takeLanes : []).filter((l) => l && Array.isArray(l.clips)).map((l) => ({
      id: l.id || uid('tkl'), name: String(l.name || 'Take'), clips: l.clips.filter((c) => c && c.kind === 'audio' && c.assetId).map(normTake),
    }));
    base.showTakes = !!t.showTakes && base.takeLanes.length > 0;
    base.takeSeq = Math.max(Math.round(num(t.takeSeq, 0)), base.takeLanes.length);
    base.inserts = normInserts(t.inserts);
    base.automation = normAutomation(t.automation);
    base.output = busIds.has(t.output) ? t.output : 'master';
    base.sends = (Array.isArray(t.sends) ? t.sends : []).filter((s) => busIds.has(s.busId)).map((s) => ({ busId: s.busId, level: num(s.level, -70), pre: !!s.pre }));
    if (kind === 'instrument' && t.instrument && t.instrument.type === 'worship') {
      base.instrument = normWorship(t.instrument);
    } else if (kind === 'instrument' && t.instrument && t.instrument.type === 'drums') {
      base.instrument = normDrums(t.instrument);
    } else if (kind === 'instrument') {
      const ins = t.instrument || {};
      const params = synthDefaults();
      for (const [k, v] of Object.entries(ins.params || {})) if (SYNTH_DEF[k] && typeof v === 'number' && Number.isFinite(v)) params[k] = v;
      base.instrument = { type: 'sawforge', preset: String(ins.preset || 'Custom'), params, wt: [normWavetable(ins.wt && ins.wt[0], 'Analog Saw'), normWavetable(ins.wt && ins.wt[1], 'Saw → Square')] };
    } else base.instrument = null;
    const drums = base.instrument && base.instrument.type === 'drums';
    base.clips = (Array.isArray(t.clips) ? t.clips : []).filter((c) => c && (kind === 'instrument' ? c.kind === 'midi' || (drums && c.kind === 'drummer') : c.kind === 'audio')).map((c) => {
      const clip = { ...c, id: c.id || uid('clp'), start: Math.max(0, num(c.start, 0)), length: Math.max(0.0625, num(c.length, 4)), offset: Math.max(0, num(c.offset, 0)), mute: !!c.mute };
      if (c.kind === 'drummer') {
        clip.dr = normDrummerSettings(c.dr); clip.offset = 0; clip.name = String(c.name || drummerById(clip.dr.id).name);
      } else if (c.kind === 'midi') {
        clip.loopLen = Math.max(0.0625, num(c.loopLen, clip.length));
        clip.notes = (Array.isArray(c.notes) ? c.notes : []).filter((n) => n && Number.isFinite(n.p) && Number.isFinite(n.s)).map((n) => ({
          p: Math.min(127, Math.max(0, Math.round(n.p))), s: Math.max(0, n.s), l: Math.max(0.01, num(n.l, 0.25)), v: Math.min(1, Math.max(0.01, num(n.v, 0.8))),
        }));
      } else {
        clip.gain = num(c.gain, 0); clip.fadeIn = Math.max(0, num(c.fadeIn, 0)); clip.fadeOut = Math.max(0, num(c.fadeOut, 0));
        if (c.src && typeof c.src.lane === 'string' && typeof c.src.clip === 'string') clip.src = { lane: c.src.lane, clip: c.src.clip }; else delete clip.src;
      }
      return clip;
    });
    return base;
  });
  p.master = { ...newMaster(), ...(raw.master || {}), id: 'master', inserts: normInserts(raw.master && raw.master.inserts), automation: normAutomation(raw.master && raw.master.automation) };
  p.live = normLive(raw.live);
  return p;
}

function normWorship(ins) {
  const params = worshipDefaults();
  for (const [k, v] of Object.entries((ins && ins.params) || {})) {
    const d = WP_DEF[k];
    if (d && typeof v === 'number' && Number.isFinite(v)) params[k] = Math.min(d.max, Math.max(d.min, v));
  }
  const wt = WORSHIP_WT.map((n, i) => normWavetable(ins && ins.wt && ins.wt[i], n));
  return { type: 'worship', preset: String((ins && ins.preset) || 'Custom'), params, wt, custom: String((ins && ins.custom) || '0 7 12 16') };
}
function normDrums(ins) {
  const params = drumDefaults();
  for (const [k, v] of Object.entries((ins && ins.params) || {})) {
    const d = DRUM_DEF[k];
    if (d && typeof v === 'number' && Number.isFinite(v)) params[k] = Math.min(d.max, Math.max(d.min, v));
  }
  params.kit = Math.round(params.kit);
  return { type: 'drums', preset: KIT_NAMES[params.kit], params, wt: [] };
}
function normLive(raw) {
  const d = newLive();
  if (!raw || typeof raw !== 'object') return d;
  const L = { ...d, ...raw };
  L.vol = Math.min(6, Math.max(-70, num(raw.vol, d.vol)));
  L.mute = !!raw.mute;
  L.patch = normWorship(raw.patch || d.patch);
  for (const [k, lo, hi] of [['xfade', 0.1, 30], ['fadeIn', 0.1, 60], ['fadeOut', 0.5, 120], ['transTime', 0.5, 60]]) L[k] = Math.min(hi, Math.max(lo, num(raw[k], d[k])));
  L.transition = ['immediate', 'gentle', 'atmos'].includes(raw.transition) ? raw.transition : d.transition;
  L.voiceLead = raw.voiceLead !== false; L.keepVoicing = !!raw.keepVoicing;
  L.lastKey = ((Math.round(num(raw.lastKey, 7)) % 12) + 12) % 12; L.lastMinor = !!raw.lastMinor;
  L.spell = ['auto', 'sharp', 'flat'].includes(raw.spell) ? raw.spell : 'auto';
  L.setlists = (Array.isArray(raw.setlists) ? raw.setlists : []).filter((s) => s && typeof s === 'object').map((s) => ({
    id: s.id || uid('set'), name: String(s.name || 'Setlist'),
    songs: (Array.isArray(s.songs) ? s.songs : []).filter((x) => x && typeof x === 'object').map((x) => ({ ...newSong(x), id: x.id || uid('song'),
      key: ((Math.round(num(x.key, 7)) % 12) + 12) % 12, voicing: Math.round(num(x.voicing, -1)), transTime: Math.max(0, num(x.transTime, 0)), tempo: Math.max(0, num(x.tempo, 0)) })),
  }));
  L.activeSetlist = L.setlists.some((s) => s.id === raw.activeSetlist) ? raw.activeSetlist : (L.setlists[0] ? L.setlists[0].id : null);
  return L;
}
