// Saw Forge Studio audio engine (runs on the real-time audio thread).
//
// One AudioWorkletProcessor hosts the whole graph: transport, sample-accurate
// note sequencing, audio clip playback, automation, instruments, insert
// effects, sends, buses, master and metronome. The same processor renders
// offline for WAV export, so exports match playback.
//
// process() is allocation-free. Structural updates (new tracks, edited
// notes) arrive as messages and are applied between render quanta; meters,
// transport position and CPU load are published through a SharedArrayBuffer
// when the page is cross-origin isolated (postMessage fallback otherwise).

import { SawForge } from './sawforge.js';
import { PadEngine, LivePadHost } from './worship.js';
import { DrumKit } from './drums.js';
import { DRUM_PARAMS } from '../../shared/drums.js';
import { WORSHIP_PARAMS } from '../../shared/worship-params.js';
import { FxSlot } from './effects.js';
import { SYNTH_PARAMS, EFFECT_DEFS, fromNorm } from '../../shared/params.js';
import { METER_STRIDE, TELE_STRIDE, MAX_SLOTS, ST } from '../../shared/layout.js';

const MAX_PENDING = 256;
const MAX_EV = 512;
const EMPTY = new Float64Array(0);
const faderGain = (n) => (n <= 0.0005 ? 0 : 2 * n * n * n);
const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();


class Channel {
  constructor(id, kind) {
    this.id = id; this.kind = kind;
    this.L = new Float32Array(128); this.R = new Float32Array(128);
    this.inserts = []; this.inst = null;
    this.gain = 1; this.pan = 0; this.audible = 1;
    this.autoVolN = -1; this.autoPan = NaN; this.hasAutoVol = false; this.hasAutoPan = false;
    this.gl = 0; this.gr = 0;
    this.sends = []; this.output = null; this.slot = -1;
    this.notes = EMPTY; this.noteCount = 0; this.cursor = 0;
    this.offBeat = new Float64Array(MAX_PENDING); this.offPitch = new Int16Array(MAX_PENDING); this.offCount = 0;
    this.regions = []; this.lanes = [];
    this.monitor = false; this.inputMode = 0; // 0 stereo, 1 input 1, 2 input 2
    this.touched = new Set(); // lanes being written right now: the live control wins over playback
    this.take = 0; // while recording: 1 audio take (old audio muted where the take replaces it), 2 MIDI punch take
    this.pkL = 0; this.pkR = 0; this.msL = 0; this.msR = 0; this.clip = 0;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sr = sampleRate;
    this.channels = new Map();
    this.tracks = []; this.buses = []; this.chList = [];
    this.master = new Channel('master', 'master');
    this.channels.set('master', this.master);
    this.assets = new Map();
    this.pendingTables = new Map();
    this.playing = false; this.counting = false; this.pos = 0;
    this.tempo = 120; this.num = 4; this.den = 4;
    this.loopOn = false; this.loopStart = 0; this.loopEnd = 16;
    this.metroOn = false; this.metroLevel = 0.6;
    this.countIn = 0; this.countPos = 0; this.stopAt = -1;
    this.clickEnv = 0; this.clickPh = 0; this.clickInc = 0; this.clickAt = -1; this.clickAccent = false;
    this.clickDecay = Math.exp(-1 / (0.012 * this.sr));
    this.evOff = new Int32Array(MAX_EV); this.evType = new Int8Array(MAX_EV);
    this.evPitch = new Int16Array(MAX_EV); this.evVel = new Float32Array(MAX_EV);
    this.st = null; this.mt = null; this.tl = null;
    this.cpuAcc = 0; this.cpuN = 0; this.cpu = 0; this.fallbackTick = 0;
    this.nanCount = 0;
    // audio input: captured every block while enabled, sample-locked to the engine clock
    this.inputOn = false; this.ring = null; this.ringCap = 0; this.ringMask = 0; this.ctl = null; this.ringW = 0;
    this.inL = new Float32Array(128); this.inR = new Float32Array(128); this.inCh = 0; this.inPkL = 0; this.inPkR = 0;
    this.recArm = false; this.recActive = false; this.recStartIdx = 0; this.recStartBeat = 0;
    this.stageL = new Float32Array(2048); this.stageR = new Float32Array(2048); this.stageN = 0; this.stageStart = 0;
    // recording takes: tracks being recorded play their input, not their old material, over the range being replaced
    this.takeOn = false; this.takePunch = false; this.takeIn = 0; this.takeOut = 0;
    this.repS = 0; this.repBuf = new Float32Array(128); this.repStep = 1 / (0.005 * this.sr); // 5 ms crossfade
    // Worship Atmospheres: which channel feeds the analysis output and pad telemetry
    this.scopeCh = 'livepad'; this.padTele = null;
    this.blockSec = 128 / this.sr;
    this.peakDecay = Math.pow(10, (-26 * this.blockSec) / 20);
    this.rmsCoef = 1 - Math.exp(-this.blockSec / 0.3);
    this.ctx = { tempo: 120, sr: this.sr, beat: 0, playing: false };
    this.port.onmessage = (e) => { try { this.onMessage(e.data); } catch (err) { this.port.postMessage({ type: 'error', message: String(err && err.stack || err) }); } };
    const o = options && options.processorOptions;
    if (o && o.offline) this.setupOffline(o);
    this.port.postMessage({ type: 'ready', sampleRate: this.sr });
  }

  spb() { return (this.sr * 60) / this.tempo; }

  // ------------------------------------------------------------ messages
  onMessage(m) {
    switch (m.type) {
      case 'sab':
        this.st = new Float64Array(m.status); this.mt = new Float32Array(m.meters); this.tl = new Float32Array(m.tele);
        if (m.padTele) this.padTele = new Float32Array(m.padTele);
        break;
      case 'livePad': this.livePad(m); break;
      case 'scope': this.scopeCh = m.ch || 'livepad'; break;
      case 'project': this.applyProject(m.data); break;
      case 'transport': this.setTransport(m); break;
      case 'play': this.play(m.beat, m.countIn || 0, m.stopAt ?? -1); break;
      case 'stop': this.stop(); break;
      case 'locate': this.locate(m.beat); break;
      case 'param': this.setParamMsg(m); break;
      case 'instParams': { const ch = this.channels.get(m.ch); if (ch && ch.inst) ch.inst.setManualAll(m.params, !!m.snap); break; }
      case 'table': {
        const t = { data: m.data, frames: m.frames, mips: m.mips, size: m.size };
        const ch = this.channels.get(m.ch);
        if (ch && ch.inst) ch.inst.setTable(m.osc, t); else this.pendingTables.set(m.ch + ':' + m.osc, t);
        break;
      }
      case 'asset': this.assets.set(m.id, { ch: m.channels, len: m.channels[0].length, sr: m.sampleRate }); break;
      case 'assetRemove': this.assets.delete(m.id); break;
      case 'live': {
        const ch = this.channels.get(m.ch);
        if (!ch || !ch.inst) break;
        if (m.ev === 'on') ch.inst.noteOn(m.pitch, m.vel);
        else if (m.ev === 'off') ch.inst.noteOff(m.pitch);
        else if (m.ev === 'bend') ch.inst.pitchBend(m.value);
        else if (m.ev === 'mw') ch.inst.modWheel(m.value);
        else if (m.ev === 'allOff') ch.inst.allNotesOff(false);
        break;
      }
      case 'panic': this.recover(false); break;
      case 'clearClip': for (const ch of this.channels.values()) ch.clip = 0; break;
      case 'ping': this.port.postMessage({ type: 'pong', id: m.id }); break;
      case 'touch': {
        const ch = this.channels.get(m.ch);
        if (!ch) break;
        if (m.on) ch.touched.add(m.key); else ch.touched.delete(m.key);
        for (const lane of ch.lanes) if (lane.key === m.key) lane.touched = !!m.on;
        break;
      }
      case 'inputRing': this.ring = new Float32Array(m.ring); this.ringCap = m.cap; this.ringMask = m.cap - 1; this.ctl = new Int32Array(m.ctl); break;
      case 'input': this.inputOn = !!m.on; if (!this.inputOn) { this.endRec(); this.inPkL = this.inPkR = 0; } break;
      case 'rec': if (m.on) { this.recArm = true; this.recActive = false; } else this.endRec(); break;
      case 'take': this.setTake(m); break;
      default: break;
    }
  }

  // Which tracks are being recorded, and the punch range if punching.
  setTake(m) {
    for (const ch of this.channels.values()) ch.take = 0;
    this.takeOn = !!(m && m.on); this.repS = 0;
    if (!this.takeOn) return;
    for (const id of m.audio || []) { const ch = this.channels.get(id); if (ch) ch.take = 1; }
    for (const id of m.midi || []) { const ch = this.channels.get(id); if (ch) ch.take = 2; }
    const P = m.punch;
    this.takePunch = !!(P && P.on && P.end > P.start);
    this.takeIn = this.takePunch ? P.start : 0; this.takeOut = this.takePunch ? P.end : 0;
  }

  // LIVE PAD performance controls (runs whether or not the transport plays).
  livePad(m) {
    const ch = this.channels.get('livepad');
    const host = ch && ch.inst instanceof LivePadHost ? ch.inst : null;
    if (!host) return;
    switch (m.op) {
      case 'start': host.start(m.chord, m.bass, m.fadeIn ?? 2); break;
      case 'stop': host.stop(m.fadeOut ?? 6); break;
      case 'change': host.change(m.chord, m.bass, { fadeIn: m.fadeIn, fadeOut: m.fadeOut, voiceLead: m.voiceLead !== false, trans: m.trans || 0 }); break;
      case 'load': host.load(Float64Array.from(m.params), m.xfade ?? 3, host.cur.tables); break;
      case 'swell': host.swell(); break;
      case 'panic': host.panic(); break;
      default: break;
    }
  }

  setParamMsg(m) {
    const ch = this.channels.get(m.ch);
    if (!ch) return;
    if (m.scope === 'inst') {
      if (!ch.inst) return;
      if (m.force) ch.inst.applyParam(m.index, m.value); // automation write: audible now, manual value untouched
      else ch.inst.setParam(m.index, m.value);
    } else if (m.scope === 'fx') {
      const slot = ch.inserts.find((s) => s.id === m.slot);
      if (!slot) return;
      if (m.force) slot.fx.setParam(m.index, m.value);
      else { slot.manual[m.index] = m.value; if (!slot.auto[m.index]) slot.fx.setParam(m.index, m.value); }
    } else if (m.scope === 'mixn') {
      // automation write on a mixer control: drive the automation override directly
      if (m.key === 'vol') ch.autoVolN = m.norm;
      else if (m.key === 'pan') ch.autoPan = m.norm * 2 - 1;
      else if (m.key === 'send') { const s = ch.sends.find((x) => x.id === m.bus); if (s) s.autoN = m.norm; }
    } else if (m.scope === 'mix') {
      if (m.key === 'gain') ch.gain = m.value;
      else if (m.key === 'pan') ch.pan = m.value;
      else if (m.key === 'send') { const s = ch.sends.find((x) => x.id === m.bus); if (s) s.gain = m.value; }
    }
  }

  setTransport(t) {
    if (!t) return;
    if (t.tempo) this.tempo = Math.min(999, Math.max(20, t.tempo));
    if (t.num) this.num = t.num;
    if (t.den) this.den = t.den;
    if (t.loopOn !== undefined) this.loopOn = !!t.loopOn;
    if (t.loopStart !== undefined) this.loopStart = Math.max(0, t.loopStart);
    if (t.loopEnd !== undefined) this.loopEnd = Math.max(this.loopStart + 0.0625, t.loopEnd);
    if (t.metroOn !== undefined) this.metroOn = !!t.metroOn;
    if (t.metroLevel !== undefined) this.metroLevel = t.metroLevel;
  }

  applyProject(d) {
    this.setTransport(d.transport);
    const seen = new Set(['master']);
    for (const c of d.channels) {
      let ch = this.channels.get(c.id);
      if (!ch || ch.kind !== c.kind) {
        if (ch && ch.inst) ch.inst.allNotesOff(true);
        ch = c.kind === 'master' ? this.master : new Channel(c.id, c.kind);
        this.channels.set(c.id, ch);
      }
      seen.add(c.id);
    }
    for (const id of [...this.channels.keys()]) if (!seen.has(id)) this.channels.delete(id);
    this.tracks = []; this.buses = []; this.chList = [...this.channels.values()];
    for (const c of d.channels) {
      const ch = this.channels.get(c.id);
      ch.slot = c.slot ?? -1; ch.gain = c.gain; ch.pan = c.pan; ch.audible = c.audible ? 1 : 0;
      ch.monitor = !!c.monitor; ch.inputMode = c.input | 0;
      if (c.kind === 'master') ch.output = null;
      else {
        let out = this.channels.get(c.output);
        if (!out || out === ch || out.kind === 'track') out = this.master;
        ch.output = out;
      }
      const oldSends = ch.sends;
      ch.sends = [];
      for (const s of c.sends || []) {
        const bus = this.channels.get(s.bus);
        if (!bus || bus.kind !== 'bus' || bus === ch) continue;
        const prev = oldSends.find((x) => x.id === s.bus);
        ch.sends.push({ id: s.bus, bus, gain: s.gain, cur: prev ? prev.cur : 0, pre: !!s.pre, autoN: -1 });
      }
      const oldIns = ch.inserts;
      ch.inserts = (c.inserts || []).map((fx) => {
        let slot = oldIns.find((s) => s.id === fx.id && s.type === fx.type);
        if (!slot) slot = new FxSlot(fx.id, fx.type, this.sr);
        slot.on = !fx.bypass;
        for (let k = 0; k < fx.params.length && k < slot.manual.length; k++) {
          slot.manual[k] = fx.params[k];
          if (!slot.auto[k]) slot.fx.setParam(k, fx.params[k]);
        }
        return slot;
      });
      if (c.inst) {
        const Kind = c.inst.type === 'worship' ? PadEngine : c.inst.type === 'live' ? LivePadHost : c.inst.type === 'drums' ? DrumKit : SawForge;
        if (!ch.inst || ch.inst.constructor !== Kind) {
          if (ch.inst) ch.inst.allNotesOff(true);
          ch.inst = new Kind(this.sr);
          for (let o = 0; o < 4; o++) {
            const key = c.id + ':' + o, t = this.pendingTables.get(key);
            if (t) { ch.inst.setTable(o, t); this.pendingTables.delete(key); }
          }
          ch.inst.setManualAll(c.inst.params, true);
        } else ch.inst.setManualAll(c.inst.params, !!c.inst.snap);
        if (ch.inst.setCustom) ch.inst.setCustom(c.inst.custom || null);
      } else if (ch.inst) ch.inst = null;
      ch.notes = c.notes || EMPTY; ch.noteCount = ch.notes.length >> 2;
      ch.cursor = this.lowerBound(ch, this.pos);
      ch.regions = c.regions || [];
      if (ch.kind === 'track') this.tracks.push(ch); else if (ch.kind === 'bus') this.buses.push(ch);
    }
    for (const c of d.channels) this.buildLanes(this.channels.get(c.id), c.lanes || []);
    if (!this.playing) this.applyAutomation(this.pos);
  }

  buildLanes(ch, lanes) {
    const IP = ch.inst instanceof PadEngine ? WORSHIP_PARAMS : ch.inst instanceof DrumKit ? DRUM_PARAMS : SYNTH_PARAMS;
    const instFlags = ch.inst ? new Uint8Array(IP.length) : null;
    const fxFlags = ch.inserts.map((s) => new Uint8Array(s.auto.length));
    ch.hasAutoVol = false; ch.hasAutoPan = false;
    for (const s of ch.sends) s.autoN = -1;
    ch.lanes = [];
    for (const L of lanes) {
      if (!L.points || L.points.length < 2) continue;
      const lane = { kind: L.kind, index: L.index | 0, points: L.points, n: L.points.length >> 1, ref: null, def: null, key: L.key, touched: ch.touched.has(L.key) };
      if (L.kind === 0) ch.hasAutoVol = true;
      else if (L.kind === 1) ch.hasAutoPan = true;
      else if (L.kind === 2) { lane.ref = ch.sends.find((s) => s.id === L.bus); if (!lane.ref) continue; }
      else if (L.kind === 3) { if (!ch.inst || !IP[lane.index]) continue; lane.def = IP[lane.index]; instFlags[lane.index] = 1; }
      else if (L.kind === 4) {
        const si = ch.inserts.findIndex((s) => s.id === L.slot);
        if (si < 0) continue;
        lane.ref = ch.inserts[si]; lane.def = EFFECT_DEFS[lane.ref.type].params[lane.index];
        if (!lane.def) continue;
        fxFlags[si][lane.index] = 1;
      } else continue;
      ch.lanes.push(lane);
    }
    if (ch.inst) ch.inst.setAutomated(instFlags);
    ch.inserts.forEach((s, si) => {
      for (let k = 0; k < s.auto.length; k++) {
        const was = s.auto[k];
        s.auto[k] = fxFlags[si][k];
        if (was && !s.auto[k]) s.fx.setParam(k, s.manual[k]);
      }
    });
    if (!ch.hasAutoVol) ch.autoVolN = -1;
    if (!ch.hasAutoPan) ch.autoPan = NaN;
  }

  evalLane(lane, beat) {
    const p = lane.points, n = lane.n;
    if (beat <= p[0]) return p[1];
    if (beat >= p[(n - 1) * 2]) return p[(n - 1) * 2 + 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid * 2] <= beat) lo = mid; else hi = mid; }
    const b0 = p[lo * 2], v0 = p[lo * 2 + 1], b1 = p[hi * 2], v1 = p[hi * 2 + 1];
    return b1 > b0 ? v0 + ((v1 - v0) * (beat - b0)) / (b1 - b0) : v1;
  }

  applyAutomation(beat) {
    const list = this.chList;
    for (let c = 0; c < list.length; c++) {
      const ch = list[c];
      const lanes = ch.lanes;
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        if (lane.touched) continue;
        const v = this.evalLane(lane, beat);
        switch (lane.kind) {
          case 0: ch.autoVolN = v; break;
          case 1: ch.autoPan = v * 2 - 1; break;
          case 2: lane.ref.autoN = v; break;
          case 3: ch.inst.setAuto(lane.index, fromNorm(lane.def, v)); break;
          case 4: lane.ref.fx.setParam(lane.index, fromNorm(lane.def, v)); break;
          default: break;
        }
      }
    }
  }

  setupOffline(o) {
    for (const a of o.assets || []) this.assets.set(a.id, { ch: a.channels, len: a.channels[0].length, sr: a.sampleRate });
    for (const t of o.tables || []) this.pendingTables.set(t.ch + ':' + t.osc, { data: t.data, frames: t.frames, mips: t.mips, size: t.size });
    this.applyProject(o.project);
    if (o.inputRing) { this.ring = new Float32Array(o.inputRing.ring); this.ringCap = o.inputRing.cap; this.ringMask = o.inputRing.cap - 1; this.ctl = new Int32Array(o.inputRing.ctl); }
    this.inputOn = !!o.inputOn;
    this.recArm = !!o.recArm;
    if (o.take) this.setTake(o.take);
    if (o.live) for (const msg of o.live) this.livePad(msg);
    this.play(o.startBeat || 0, o.countIn || 0, o.stopAt ?? -1);
  }

  // ------------------------------------------------------------ transport
  lowerBound(ch, beat) {
    const notes = ch.notes;
    let lo = 0, hi = ch.noteCount;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid * 4] < beat) lo = mid + 1; else hi = mid; }
    return lo;
  }
  seekAll() { const tr = this.tracks; for (let i = 0; i < tr.length; i++) tr[i].cursor = this.lowerBound(tr[i], this.pos); }
  allSeqOff() {
    const tr = this.tracks;
    for (let i = 0; i < tr.length; i++) {
      const t = tr[i];
      if (t.inst) for (let k = 0; k < t.offCount; k++) t.inst.noteOff(t.offPitch[k]);
      t.offCount = 0;
    }
  }
  play(beat, countInBeats, stopAt) {
    this.allSeqOff();
    this.pos = Math.max(0, beat);
    this.stopAt = stopAt;
    this.seekAll();
    if (countInBeats > 0) {
      this.countIn = Math.round(countInBeats * this.spb());
      this.countPos = this.pos - countInBeats;
      this.counting = true; this.playing = false;
    } else { this.counting = false; this.playing = true; }
    this.applyAutomation(this.pos);
  }
  stop() { this.endRec(); if (this.takeOn) this.setTake(null); this.playing = false; this.counting = false; this.countIn = 0; this.allSeqOff(); }
  // Report where the take ends in the input ring (or that it never started).
  endRec() {
    if (!this.recArm && !this.recActive) return;
    this.port.postMessage({ type: 'recStopped', started: this.recActive, index: this.ringW >>> 0, startIndex: this.recStartIdx >>> 0, startBeat: this.recStartBeat });
    this.recArm = false; this.recActive = false;
  }

  captureInput(inp, n) {
    const nch = inp ? inp.length : 0;
    this.inCh = nch;
    const iL = this.inL, iR = this.inR;
    if (nch > 0) {
      const a = inp[0], b = nch > 1 ? inp[1] : inp[0];
      for (let i = 0; i < n; i++) { iL[i] = a[i]; iR[i] = b[i]; }
    } else { iL.fill(0); iR.fill(0); }
    let pl = 0, pr = 0;
    for (let i = 0; i < n; i++) { const l = iL[i] < 0 ? -iL[i] : iL[i], r = iR[i] < 0 ? -iR[i] : iR[i]; if (l > pl) pl = l; if (r > pr) pr = r; }
    this.inPkL = Math.max(pl, this.inPkL * this.peakDecay);
    this.inPkR = Math.max(pr, this.inPkR * this.peakDecay);
    const w = this.ringW;
    this.blkFrame = currentFrame; this.blkPos = w >>> 0;
    if (this.st) { this.st[ST.IN_BLOCK_FRAME] = currentFrame; this.st[ST.IN_BLOCK_POS] = w >>> 0; }
    if (this.ring) {
      const r = this.ring, cap = this.ringCap, m = this.ringMask;
      for (let i = 0; i < n; i++) { const j = (w + i) & m; r[j] = iL[i]; r[cap + j] = iR[i]; }
      this.ringW = (w + n) | 0;
      Atomics.store(this.ctl, 0, this.ringW);
    } else {
      // no shared memory: ship 2048-sample chunks by message (allocates; fallback only)
      if (this.stageN === 0) this.stageStart = w >>> 0;
      for (let i = 0; i < n; i++) { this.stageL[this.stageN + i] = iL[i]; this.stageR[this.stageN + i] = iR[i]; }
      this.stageN += n;
      this.ringW = (w + n) | 0;
      if (this.stageN >= 2048) {
        this.port.postMessage({ type: 'inChunk', start: this.stageStart, frame: currentFrame + n - this.stageN, L: this.stageL.slice(0, this.stageN), R: this.stageR.slice(0, this.stageN) });
        this.stageN = 0;
      }
    }
  }
  locate(beat) {
    this.pos = Math.max(0, beat);
    if (this.playing) this.allSeqOff();
    this.seekAll();
    this.applyAutomation(this.pos);
  }

  // ------------------------------------------------------------ render
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    const t0 = now();
    const spb = this.spb();

    const tracks = this.tracks, buses = this.buses;
    for (let i = 0; i < tracks.length; i++) { tracks[i].L.fill(0); tracks[i].R.fill(0); }
    const blockRing = this.ringW;
    if (this.inputOn) this.captureInput(inputs && inputs[0], n);
    for (let i = 0; i < buses.length; i++) { buses[i].L.fill(0); buses[i].R.fill(0); }
    this.master.L.fill(0); this.master.R.fill(0);
    this.clickAt = -1;

    for (let i = 0; i < tracks.length; i++) if (tracks[i].inst) tracks[i].inst.beginBlock(this.tempo, this.pos, this.playing, n);
    if (this.playing) this.applyAutomation(this.pos);

    let playFrom = this.playing ? 0 : -1;
    const playBeat = this.pos;
    let o = 0;
    if (this.counting) {
      const k = Math.min(n, this.countIn);
      this.renderIdle(0, k);
      this.metroTicks(this.countPos, this.countPos + k / spb, 0, k, spb);
      this.countPos += k / spb; this.countIn -= k; o = k;
      if (this.countIn <= 0) { this.counting = false; this.playing = true; this.seekAll(); playFrom = o; }
    }
    if (this.playing) {
      let guard = 0;
      while (o < n && this.playing && guard++ < 16) {
        const remain = n - o, b0 = this.pos, b1 = b0 + remain / spb;
        if (this.loopOn && b0 < this.loopEnd && b1 > this.loopEnd) {
          let k = Math.round((this.loopEnd - b0) * spb);
          if (k > remain) k = remain; if (k < 0) k = 0;
          if (k > 0) this.renderSegment(b0, this.loopEnd, o, o + k, spb);
          o += k; this.pos = this.loopStart;
          this.allSeqOff(); this.seekAll(); this.applyAutomation(this.pos);
        } else if (this.stopAt >= 0 && b1 >= this.stopAt) {
          let k = Math.round((this.stopAt - b0) * spb);
          if (k > remain) k = remain; if (k < 0) k = 0;
          if (k > 0) this.renderSegment(b0, this.stopAt, o, o + k, spb);
          o += k; this.pos = this.stopAt; this.playing = false; this.allSeqOff();
        } else {
          this.renderSegment(b0, b1, o, n, spb);
          this.pos = b1; o = n;
        }
      }
    }
    if (o < n) this.renderIdle(o, n);
    if (this.inputOn) this.monitorInput(n);
    if (this.recArm && !this.recActive && playFrom >= 0 && this.inputOn) {
      // the take starts at the exact sample where playback started
      this.recActive = true;
      this.recStartIdx = (blockRing + playFrom) >>> 0; this.recStartBeat = playBeat;
      this.port.postMessage({ type: 'recStarted', index: this.recStartIdx, beat: playBeat, frame: currentFrame + playFrom });
    }

    this.mixdown(n);

    const mL = this.master.L, mR = this.master.R;
    let bad = false;
    for (let i = 0; i < n; i++) {
      const l = mL[i], r = mR[i];
      if (l !== l || r !== r || l > 64 || l < -64 || r > 64 || r < -64) { bad = true; break; }
    }
    if (bad) { oL.fill(0); if (oR !== oL) oR.fill(0); this.recover(true); }
    else {
      for (let i = 0; i < n; i++) { oL[i] = mL[i]; }
      if (oR !== oL) for (let i = 0; i < n; i++) oR[i] = mR[i];
    }
    this.renderClick(oL, oR, n);
    // second output: the scoped pad channel (post-fader) for the spectrum display
    const sc = this.channels.get(this.scopeCh);
    const aOut = outputs[1];
    if (aOut && aOut[0]) {
      const aL = aOut[0], aR = aOut[1] || aOut[0];
      if (sc && sc.inst) { for (let i = 0; i < n; i++) { aL[i] = sc.L[i]; if (aR !== aL) aR[i] = sc.R[i]; } }
      else { aL.fill(0); if (aR !== aL) aR.fill(0); }
    }
    if (this.padTele && sc && sc.inst && sc.inst.tele) {
      const t = sc.inst.tele, pt = this.padTele, len = Math.min(t.length, pt.length - 1);
      for (let i = 0; i < len; i++) pt[i] = t[i];
      pt[pt.length - 1] = (pt[pt.length - 1] + 1) % 1e6;
    }

    const dt = now() - t0;
    this.cpuAcc += dt; this.cpuN++;
    if (this.cpuN >= 64) { this.cpu = this.cpuAcc / (this.cpuN * this.blockSec * 1000); this.cpuAcc = 0; this.cpuN = 0; }
    this.publish(spb);
    return true;
  }

  // Input monitoring. When punching, a track being recorded hears its input
  // only inside the punch range (and its old take outside it).
  monitorInput(n) {
    const tracks = this.tracks, iL = this.inL, iR = this.inR;
    const gate = this.takeOn && this.takePunch ? this.repBuf : null;
    for (let t = 0; t < tracks.length; t++) {
      const tr = tracks[t];
      if (!tr.monitor) continue;
      const L = tr.L, R = tr.R, mode = tr.inputMode, g = gate && tr.take === 1 ? gate : null;
      const a = mode === 2 ? iR : iL, b = mode === 0 ? iR : a;
      if (g) for (let i = 0; i < n; i++) { L[i] += a[i] * g[i]; R[i] += b[i] * g[i]; }
      else for (let i = 0; i < n; i++) { L[i] += a[i]; R[i] += b[i]; }
    }
  }

  // Per-sample "replacing" amount for the tracks being recorded (0 = old material, 1 = input),
  // ramped so the switch at the punch points doesn't click.
  fillRep(b0, o0, o1, spb, playing) {
    const buf = this.repBuf, step = this.repStep, P = this.takePunch, a = this.takeIn, z = this.takeOut;
    let s = this.repS;
    for (let i = o0; i < o1; i++) {
      let tgt = 0;
      if (playing) { if (!P) tgt = 1; else { const b = b0 + (i - o0) / spb; tgt = b >= a && b < z ? 1 : 0; } }
      if (s < tgt) { s += step; if (s > tgt) s = tgt; } else if (s > tgt) { s -= step; if (s < tgt) s = tgt; }
      buf[i] = s;
    }
    this.repS = s;
  }

  renderIdle(o0, o1) {
    if (o1 <= o0) return;
    if (this.takeOn) this.fillRep(0, o0, o1, 1, false);
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) { const t = tracks[i]; if (t.inst) t.inst.render(t.L, t.R, o0, o1); }
  }

  renderSegment(b0, b1, o0, o1, spb) {
    if (this.takeOn) this.fillRep(b0, o0, o1, spb, true);
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.inst) this.renderInst(t, b0, b1, o0, o1, spb);
      if (t.regions.length) this.renderRegions(t, b0, b1, o0, o1, spb);
    }
    if (this.metroOn) this.metroTicks(b0, b1, o0, o1, spb);
  }

  renderInst(t, b0, b1, o0, o1, spb) {
    const inst = t.inst, evOff = this.evOff, evType = this.evType, evPitch = this.evPitch, evVel = this.evVel;
    let ne = 0;
    const notes = t.notes;
    let c = t.cursor;
    const punchMute = t.take === 2 && this.takeOn && this.takePunch; // old notes inside the punch range are being replaced
    while (c < t.noteCount && notes[c * 4] < b1) {
      const s = notes[c * 4];
      if (s >= b0 - 1e-9 && !(punchMute && s >= this.takeIn && s < this.takeOut)) {
        let off = o0 + Math.floor((s - b0) * spb);
        if (off < o0) off = o0; if (off >= o1) off = o1 - 1;
        if (ne < MAX_EV) { evOff[ne] = off; evType[ne] = 1; evPitch[ne] = notes[c * 4 + 2]; evVel[ne] = notes[c * 4 + 3]; ne++; }
        if (t.offCount < MAX_PENDING) { t.offBeat[t.offCount] = notes[c * 4 + 1]; t.offPitch[t.offCount] = notes[c * 4 + 2]; t.offCount++; }
      }
      c++;
    }
    t.cursor = c;
    let k = 0;
    while (k < t.offCount) {
      const eb = t.offBeat[k];
      if (eb < b1) {
        let off = o0 + Math.floor((eb - b0) * spb);
        if (off < o0) off = o0; if (off >= o1) off = o1 - 1;
        if (ne < MAX_EV) { evOff[ne] = off; evType[ne] = 0; evPitch[ne] = t.offPitch[k]; ne++; }
        t.offCount--; t.offBeat[k] = t.offBeat[t.offCount]; t.offPitch[k] = t.offPitch[t.offCount];
      } else k++;
    }
    for (let i = 1; i < ne; i++) { // insertion sort by offset; note-offs first on ties
      const o = evOff[i], ty = evType[i], p = evPitch[i], v = evVel[i];
      let j = i - 1;
      while (j >= 0 && (evOff[j] > o || (evOff[j] === o && evType[j] > ty))) {
        evOff[j + 1] = evOff[j]; evType[j + 1] = evType[j]; evPitch[j + 1] = evPitch[j]; evVel[j + 1] = evVel[j]; j--;
      }
      evOff[j + 1] = o; evType[j + 1] = ty; evPitch[j + 1] = p; evVel[j + 1] = v;
    }
    let pos = o0;
    for (let i = 0; i < ne; i++) {
      const off = evOff[i];
      if (off > pos) { inst.render(t.L, t.R, pos, off); pos = off; }
      if (evType[i] === 1) inst.noteOn(evPitch[i], evVel[i]); else inst.noteOff(evPitch[i]);
    }
    if (pos < o1) inst.render(t.L, t.R, pos, o1);
  }

  renderRegions(t, b0, b1, o0, o1, spb) {
    const L = t.L, R = t.R, sr = this.sr;
    const rep = this.takeOn && t.take === 1 ? this.repBuf : null;
    for (let q = 0; q < t.regions.length; q++) {
      const r = t.regions[q];
      if (r.end <= b0 || r.start >= b1) continue;
      const a = this.assets.get(r.asset);
      if (!a) continue;
      const ratio = a.sr / sr, cl = a.ch[0], cr = a.ch[1] || a.ch[0], len = a.len;
      const fin = Math.max(r.fadeIn, 64 / spb), fout = Math.max(r.fadeOut, 64 / spb);
      const base = r.offset * sr;
      for (let i = o0; i < o1; i++) {
        const beat = b0 + (i - o0) / spb;
        if (beat < r.start || beat >= r.end) continue;
        const sp = (base + (beat - r.start) * spb) * ratio;
        const idx = sp | 0;
        if (idx < 0 || idx >= len - 1) continue;
        const f = sp - idx;
        let g = r.gain;
        const ti = (beat - r.start) / fin; if (ti < 1) g *= ti;
        const to = (r.end - beat) / fout; if (to < 1) g *= to;
        if (rep) g *= 1 - rep[i];
        L[i] += (cl[idx] + (cl[idx + 1] - cl[idx]) * f) * g;
        R[i] += (cr[idx] + (cr[idx + 1] - cr[idx]) * f) * g;
      }
    }
  }

  metroTicks(b0, b1, o0, o1, spb) {
    const unit = 4 / this.den;
    let k = Math.ceil(b0 / unit - 1e-9);
    for (let guard = 0; guard < 8; guard++, k++) {
      const tb = k * unit;
      if (tb >= b1) break;
      if (tb < b0 - 1e-9) continue;
      let off = o0 + Math.floor((tb - b0) * spb);
      if (off < o0) off = o0; if (off >= o1) off = o1 - 1;
      this.clickAt = off;
      this.clickAccent = ((k % this.num) + this.num) % this.num === 0;
    }
  }

  renderClick(oL, oR, n) {
    if (this.clickAt < 0 && this.clickEnv < 1e-4) return;
    const lvl = this.metroLevel * 0.45, dec = this.clickDecay;
    let env = this.clickEnv, ph = this.clickPh, inc = this.clickInc;
    for (let i = 0; i < n; i++) {
      if (i === this.clickAt) { env = 1; ph = 0; inc = (this.clickAccent ? 1680 : 1180) / this.sr; }
      if (env > 1e-4) {
        const s = Math.sin(6.283185307179586 * ph) * env * lvl;
        oL[i] += s; if (oR !== oL) oR[i] += s;
        ph += inc; if (ph >= 1) ph -= 1;
        env *= dec;
      }
    }
    this.clickEnv = env; this.clickPh = ph; this.clickInc = inc;
  }

  mixdown(n) {
    const ctx = this.ctx;
    ctx.tempo = this.tempo; ctx.beat = this.pos; ctx.playing = this.playing;
    const tracks = this.tracks, buses = this.buses;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.inst) t.inst.postProcess(t.L, t.R, n, ctx);
      this.channelOut(t, n, ctx);
    }
    for (let i = 0; i < buses.length; i++) this.channelOut(buses[i], n, ctx);
    this.channelOut(this.master, n, ctx);
  }

  channelOut(ch, n, ctx) {
    const L = ch.L, R = ch.R;
    for (let s = 0; s < ch.inserts.length; s++) ch.inserts[s].process(L, R, n, ctx);
    for (let s = 0; s < ch.sends.length; s++) if (ch.sends[s].pre) this.addSend(ch, ch.sends[s], n);
    const vol = ch.autoVolN >= 0 ? faderGain(ch.autoVolN) : ch.gain;
    const pan = ch.autoPan === ch.autoPan ? ch.autoPan : ch.pan;
    const tl = vol * Math.min(1, 1 - pan) * ch.audible, tr = vol * Math.min(1, 1 + pan) * ch.audible;
    let gl = ch.gl, gr = ch.gr;
    const dl = (tl - gl) / n, dr = (tr - gr) / n;
    let pl = 0, pr = 0, sl = 0, sr = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i] * gl, r = R[i] * gr;
      L[i] = l; R[i] = r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al; if (ar > pr) pr = ar;
      sl += l * l; sr += r * r;
      gl += dl; gr += dr;
    }
    ch.gl = tl; ch.gr = tr;
    ch.pkL = Math.max(pl, ch.pkL * this.peakDecay);
    ch.pkR = Math.max(pr, ch.pkR * this.peakDecay);
    ch.msL += (sl / n - ch.msL) * this.rmsCoef;
    ch.msR += (sr / n - ch.msR) * this.rmsCoef;
    if (pl >= 1 || pr >= 1) ch.clip = 1;
    for (let s = 0; s < ch.sends.length; s++) if (!ch.sends[s].pre) this.addSend(ch, ch.sends[s], n);
    const out = ch.output;
    if (out) {
      const oL = out.L, oR = out.R;
      for (let i = 0; i < n; i++) { oL[i] += L[i]; oR[i] += R[i]; }
    }
  }

  addSend(ch, s, n) {
    const target = (s.autoN >= 0 ? faderGain(s.autoN) : s.gain) * ch.audible;
    let g = s.cur;
    if (g === 0 && target === 0) return;
    const d = (target - g) / n, L = ch.L, R = ch.R, bL = s.bus.L, bR = s.bus.R;
    for (let i = 0; i < n; i++) { bL[i] += L[i] * g; bR[i] += R[i] * g; g += d; }
    s.cur = target;
  }

  recover(fromNan) {
    for (const ch of this.channels.values()) {
      if (ch.inst) ch.inst.allNotesOff(true);
      for (const s of ch.inserts) s.fx.reset();
      ch.offCount = 0;
    }
    if (fromNan) this.nanCount++;
  }

  publish(spb) {
    const st = this.st;
    const playState = this.playing ? 1 : this.counting ? 2 : 0;
    if (st) {
      st[0] = this.pos; st[1] = playState; st[2] = this.counting ? this.countIn / spb : 0;
      st[3] = this.cpu; st[4] = currentFrame; st[5] = currentTime; st[6] = this.nanCount; st[7] = this.tempo;
      st[8] = st[8] + 1;
      st[ST.IN_PK_L] = this.inPkL; st[ST.IN_PK_R] = this.inPkR; st[ST.IN_CH] = this.inCh; st[ST.IN_ON] = this.inputOn ? 1 : 0; st[ST.REC_ACTIVE] = this.recActive ? 1 : 0;
      const mt = this.mt, tl = this.tl, list = this.chList;
      for (let c = 0; c < list.length; c++) {
        const ch = list[c], s = ch.slot;
        if (s < 0 || s >= MAX_SLOTS) continue;
        const b = s * METER_STRIDE;
        mt[b] = ch.pkL; mt[b + 1] = ch.pkR; mt[b + 2] = Math.sqrt(ch.msL); mt[b + 3] = Math.sqrt(ch.msR);
        if (ch.clip) mt[b + 4] = 1;
        ch.clip = 0;
        if (ch.inst) {
          const tb = s * TELE_STRIDE, te = ch.inst.tele;
          tl[tb] = te[0]; tl[tb + 1] = te[1]; tl[tb + 2] = te[2]; tl[tb + 3] = te[3];
        }
      }
    } else if (++this.fallbackTick >= 10) {
      this.fallbackTick = 0;
      const meters = [];
      for (const ch of this.channels.values()) {
        if (ch.slot < 0) continue;
        const te = ch.inst ? ch.inst.tele : null;
        meters.push([ch.slot, ch.pkL, ch.pkR, Math.sqrt(ch.msL), Math.sqrt(ch.msR), ch.clip, te ? te[0] : 0, te ? te[1] : 0, te ? te[2] : 0, te ? te[3] : 0]);
        ch.clip = 0;
      }
      this.port.postMessage({ type: 'status', pos: this.pos, play: playState, countIn: this.counting ? this.countIn / spb : 0, cpu: this.cpu, frame: currentFrame, time: currentTime, nan: this.nanCount, meters,
        inPkL: this.inPkL, inPkR: this.inPkR, inCh: this.inCh, inOn: this.inputOn ? 1 : 0, recActive: this.recActive ? 1 : 0, inFrame: this.blkFrame || 0, inPos: this.blkPos || 0 });
    }
  }
}

registerProcessor('sawforge-engine', EngineProcessor);
