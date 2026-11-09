// UI-thread side of the audio engine: owns the AudioContext and the worklet
// node, ships project data/tables/assets to the audio thread, reads meters
// and transport state from shared memory, and renders exports offline.

import { compileProject } from './compile.js';
import { STATUS_LEN, METER_STRIDE, TELE_STRIDE, MAX_SLOTS, ST, INPUT_RING_SECONDS } from '../shared/layout.js';
import { wavetableHash } from '../shared/wavetable.js';
import { SYNTH_INDEX } from '../shared/params.js';
import { WP_INDEX } from '../shared/worship-params.js';
import { DRUM_INDEX } from '../shared/drums.js';

const WORKLET_URL = new URL('./worklet/engine-processor.js', import.meta.url).href;
const WORKER_URL = new URL('./wavetable-worker.js', import.meta.url).href;

// Builds wavetables in a worker and caches results by content hash.
export class TableBuilder {
  constructor() { this.worker = null; this.jobs = new Map(); this.cache = new Map(); this.inflight = new Map(); this.seq = 0; }
  ensure() {
    if (this.worker) return;
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker.onmessage = (e) => {
      const job = this.jobs.get(e.data.id);
      if (!job) return;
      this.jobs.delete(e.data.id);
      if (e.data.ok) job.resolve(e.data.table); else job.reject(new Error(e.data.error));
    };
    this.worker.onerror = (e) => {
      for (const j of this.jobs.values()) j.reject(new Error('Wavetable worker failed: ' + (e.message || 'unknown')));
      this.jobs.clear(); this.worker = null;
    };
  }
  build(wt) {
    const key = wavetableHash(wt);
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return Promise.resolve({ key, table: hit }); }
    if (this.inflight.has(key)) return this.inflight.get(key);
    this.ensure();
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.jobs.set(id, { resolve, reject }));
    this.worker.postMessage({ id, wt: { name: wt.name, frames: wt.frames } });
    const wrapped = p.then((table) => {
      this.cache.set(key, table);
      while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
      this.inflight.delete(key);
      return { key, table };
    }, (err) => { this.inflight.delete(key); throw err; });
    this.inflight.set(key, wrapped);
    return wrapped;
  }
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null; this.node = null;
    this.state = 'off'; this.error = '';
    this.slots = new Map(); this.freeSlots = []; this.nextSlot = 0;
    this.shared = false;
    this.status = new Float64Array(STATUS_LEN);
    this.meters = new Float32Array(MAX_SLOTS * METER_STRIDE);
    this.tele = new Float32Array(MAX_SLOTS * TELE_STRIDE);
    this.tables = new TableBuilder();
    this.sentTables = new Map();
    this.sentAssets = new Set();
    this.options = { sampleRate: 0, latencyHint: 'interactive', sinkId: '' };
    this.inRing = null; this.inCtl = null; this.inCap = 0;
    this.padTele = new Float32Array(32); this.analyser = null;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 0; }
  get running() { return this.state === 'running'; }

  setState(s) { this.state = s; this.dispatchEvent(new CustomEvent('state', { detail: s })); }
  fail(msg) { this.error = msg; this.setState('error'); this.dispatchEvent(new CustomEvent('error', { detail: msg })); }

  async start(opts = {}) {
    Object.assign(this.options, opts);
    await this.shutdown();
    this.setState('starting');
    try {
      const o = { latencyHint: this.options.latencyHint };
      if (this.options.sampleRate) o.sampleRate = this.options.sampleRate;
      const ctx = new AudioContext(o);
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(WORKLET_URL);
      // One stereo input carries the audio-interface signal into the engine (for recording/monitoring).
      // Output 2 carries the scoped pad channel to an analyser (spectrum display); it is not heard.
      const node = new AudioWorkletNode(ctx, 'sawforge-engine', {
        numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      this.node = node;
      node.port.onmessage = (e) => this.onMessage(e.data);
      node.onprocessorerror = () => this.fail('The audio engine stopped after an internal error. Use “Restart audio” to continue; your project is safe.');
      node.connect(ctx.destination, 0);
      const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.8;
      const sink = ctx.createGain(); sink.gain.value = 0;
      node.connect(an, 1); an.connect(sink); sink.connect(ctx.destination);
      this.analyser = an;
      if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
        const sS = new SharedArrayBuffer(STATUS_LEN * 8);
        const sM = new SharedArrayBuffer(MAX_SLOTS * METER_STRIDE * 4);
        const sT = new SharedArrayBuffer(MAX_SLOTS * TELE_STRIDE * 4), sP = new SharedArrayBuffer(32 * 4);
        this.status = new Float64Array(sS); this.meters = new Float32Array(sM); this.tele = new Float32Array(sT); this.padTele = new Float32Array(sP);
        node.port.postMessage({ type: 'sab', status: sS, meters: sM, tele: sT, padTele: sP });
        // Lock-free input ring: the audio thread writes every captured sample, the UI thread drains it.
        const cap = 1 << Math.ceil(Math.log2(ctx.sampleRate * INPUT_RING_SECONDS));
        const ringBuf = new SharedArrayBuffer(cap * 2 * 4), ctlBuf = new SharedArrayBuffer(16 * 4);
        this.inRing = new Float32Array(ringBuf); this.inCtl = new Int32Array(ctlBuf); this.inCap = cap;
        node.port.postMessage({ type: 'inputRing', ring: ringBuf, ctl: ctlBuf, cap });
        this.shared = true;
      } else {
        this.status = new Float64Array(STATUS_LEN); this.meters = new Float32Array(MAX_SLOTS * METER_STRIDE); this.tele = new Float32Array(MAX_SLOTS * TELE_STRIDE);
        this.inRing = null; this.inCtl = null; this.inCap = 0;
        this.shared = false;
      }
      ctx.onstatechange = () => this.onCtxState();
      if (this.options.sinkId && typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(this.options.sinkId); }
        catch (e) { this.dispatchEvent(new CustomEvent('warning', { detail: 'Selected output device is unavailable; using the system default.' })); }
      }
      this.sentTables.clear(); this.sentAssets.clear();
      try { await ctx.resume(); } catch { /* resumed later by a user gesture */ }
      this.onCtxState();
      return true;
    } catch (err) {
      this.fail('Could not start audio: ' + (err && err.message ? err.message : err));
      return false;
    }
  }

  onCtxState() {
    if (!this.ctx) return;
    const s = this.ctx.state;
    if (this.state === 'error') return;
    if (s === 'running') this.setState('running');
    else if (s === 'closed') this.setState('off');
    else this.setState('suspended');
  }

  async resume() { if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* ignore */ } } }

  async shutdown() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.ctx = null;
    try { this.node && this.node.disconnect(); } catch { /* ignore */ }
    this.node = null;
    try { await ctx.close(); } catch { /* ignore */ }
    this.state = 'off';
  }

  onMessage(m) {
    if (m.type === 'status') {
      const st = this.status;
      st[0] = m.pos; st[1] = m.play; st[2] = m.countIn; st[3] = m.cpu; st[4] = m.frame; st[5] = m.time; st[6] = m.nan;
      st[ST.IN_PK_L] = m.inPkL; st[ST.IN_PK_R] = m.inPkR; st[ST.IN_CH] = m.inCh; st[ST.IN_ON] = m.inOn; st[ST.REC_ACTIVE] = m.recActive;
      st[ST.IN_BLOCK_FRAME] = m.inFrame; st[ST.IN_BLOCK_POS] = m.inPos;
      for (const r of m.meters) {
        const b = r[0] * METER_STRIDE;
        this.meters[b] = r[1]; this.meters[b + 1] = r[2]; this.meters[b + 2] = r[3]; this.meters[b + 3] = r[4];
        if (r[5]) this.meters[b + 4] = 1;
        const tb = r[0] * TELE_STRIDE;
        this.tele[tb] = r[6]; this.tele[tb + 1] = r[7]; this.tele[tb + 2] = r[8]; this.tele[tb + 3] = r[9];
      }
    } else if (m.type === 'error') {
      console.error('[audio thread]', m.message);
      this.dispatchEvent(new CustomEvent('warning', { detail: 'Audio thread reported an error: ' + String(m.message).split('\n')[0] }));
    } else if (m.type === 'ready') this.dispatchEvent(new CustomEvent('ready'));
    else if (m.type === 'recStarted') this.dispatchEvent(new CustomEvent('recstarted', { detail: m }));
    else if (m.type === 'recStopped') this.dispatchEvent(new CustomEvent('recstopped', { detail: m }));
    else if (m.type === 'inChunk') this.dispatchEvent(new CustomEvent('inchunk', { detail: m }));
  }

  post(msg, transfer) { if (this.node) this.node.port.postMessage(msg, transfer || []); }

  slotOf(id) {
    let s = this.slots.get(id);
    if (s === undefined) {
      s = this.freeSlots.length ? this.freeSlots.pop() : this.nextSlot < MAX_SLOTS ? this.nextSlot++ : -1;
      if (s >= 0) {
        this.slots.set(id, s);
        this.meters.fill(0, s * METER_STRIDE, (s + 1) * METER_STRIDE);
        this.tele.fill(0, s * TELE_STRIDE, (s + 1) * TELE_STRIDE);
      }
    }
    return s;
  }
  releaseSlots(liveIds) {
    for (const [id, s] of this.slots) if (!liveIds.has(id)) { this.slots.delete(id); this.freeSlots.push(s); }
  }
  meterBase(id) { const s = this.slots.get(id); return s === undefined ? -1 : s * METER_STRIDE; }
  teleBase(id) { const s = this.slots.get(id); return s === undefined ? -1 : s * TELE_STRIDE; }
  clearClip(id) { const b = this.meterBase(id); if (b >= 0) this.meters[b + 4] = 0; if (!this.shared) this.post({ type: 'clearClip' }); }

  syncProject(project, snap = null, audition = null) {
    const live = new Set(['master', 'livepad', ...project.tracks.map((t) => t.id), ...project.buses.map((b) => b.id)]);
    this.releaseSlots(live);
    const data = compileProject(project, { slotOf: (id) => this.slotOf(id), snap, audition, live: true });
    this.post({ type: 'project', data });
  }

  setInstParam(trackId, pid, value) { this.post({ type: 'param', ch: trackId, scope: 'inst', index: SYNTH_INDEX[pid], value }); }
  setWorshipParam(chId, pid, value) { this.post({ type: 'param', ch: chId, scope: 'inst', index: WP_INDEX[pid], value }); }
  setDrumParam(chId, pid, value) { this.post({ type: 'param', ch: chId, scope: 'inst', index: DRUM_INDEX[pid], value }); }
  livePad(op, data = {}) { this.post({ type: 'livePad', op, ...data }); }
  setScope(ch) { this.post({ type: 'scope', ch }); }
  setFxParam(chId, slotId, index, value) { this.post({ type: 'param', ch: chId, scope: 'fx', slot: slotId, index, value }); }
  setMix(chId, key, value, bus) { this.post({ type: 'param', ch: chId, scope: 'mix', key, value, bus }); }

  sendTable(chId, osc, key, table) {
    const k = chId + ':' + osc;
    if (this.sentTables.get(k) === key) return;
    this.sentTables.set(k, key);
    const data = table.data.slice();
    this.post({ type: 'table', ch: chId, osc, data, frames: table.frames, mips: table.mips, size: table.size }, [data.buffer]);
  }
  forgetTables(chId) { for (let o = 0; o < 4; o++) this.sentTables.delete(chId + ':' + o); }

  async sendAsset(id, audioBuffer) {
    if (!this.node || this.sentAssets.has(id)) return;
    this.sentAssets.add(id);
    const channels = [];
    for (let c = 0; c < Math.min(2, audioBuffer.numberOfChannels); c++) channels.push(audioBuffer.getChannelData(c).slice());
    this.post({ type: 'asset', id, channels, sampleRate: audioBuffer.sampleRate }, channels.map((c) => c.buffer));
  }

  transport(cfg) { this.post({ type: 'transport', ...cfg }); }
  play(beat, countIn = 0) { this.post({ type: 'play', beat, countIn }); }
  stop() { this.post({ type: 'stop' }); }
  locate(beat) { this.post({ type: 'locate', beat }); }
  live(ch, ev, pitch = 0, vel = 0, value = 0) { this.post({ type: 'live', ch, ev, pitch, vel, value }); }
  panic() { this.post({ type: 'panic' }); }

  get playState() { return this.status[1]; } // 0 stopped, 1 playing, 2 count-in
  get position() { return this.status[0]; }
  get countIn() { return this.status[2]; }
  get cpu() { return this.status[3]; }
  get nanCount() { return this.status[6]; }
  get inputPeaks() { return [this.status[ST.IN_PK_L], this.status[ST.IN_PK_R]]; }
  get inputChannels() { return this.status[ST.IN_CH]; }
  get inputOn() { return this.status[ST.IN_ON] === 1; }
  // Total samples the audio thread has written into the input ring (wrapping uint32).
  inputWritePos() { return this.inCtl ? Atomics.load(this.inCtl, 0) >>> 0 : (this.status[ST.IN_BLOCK_POS] >>> 0); }
  latency() { return this.ctx ? (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) : 0; }
  // Beat the listener is hearing right now (used to timestamp recorded notes).
  heardBeat(tempo) {
    const st = this.status;
    if (!this.ctx || st[1] !== 1) return st[0];
    const dt = Math.max(0, this.ctx.currentTime - st[5]);
    return st[0] + ((dt - this.latency()) * tempo) / 60;
  }

  async listOutputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audiooutput').map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${i + 1}`) }));
    } catch { return []; }
  }

  // Offline render with the same processor used for playback.
  async renderOffline({ project, assets, wavetables, startBeat, endBeat, sampleRate, tailSec, onProgress }) {
    const durSec = ((endBeat - startBeat) * 60) / project.tempo + tailSec;
    const frames = Math.max(256, Math.ceil(durSec * sampleRate));
    const off = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
    await off.audioWorklet.addModule(WORKLET_URL);
    const assetList = [], missing = [];
    for (const a of assets) {
      try {
        const buf = await off.decodeAudioData(a.bytes.slice(0));
        assetList.push({ id: a.id, sampleRate: buf.sampleRate, channels: Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice()) });
      } catch { missing.push(a.id); }
    }
    const tableList = [];
    for (const w of wavetables) {
      const { table } = await this.tables.build(w.wt);
      tableList.push({ ch: w.ch, osc: w.osc, data: table.data.slice(), frames: table.frames, mips: table.mips, size: table.size });
    }
    const data = compileProject(project, { slotOf: () => -1, transport: { loopOn: false, metroOn: false } });
    const node = new AudioWorkletNode(off, 'sawforge-engine', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { offline: true, project: data, tables: tableList, assets: assetList, startBeat, stopAt: endBeat },
    });
    node.connect(off.destination);
    const step = Math.max(0.5, durSec / 40);
    for (let t = step; t < durSec - 0.01; t += step) {
      off.suspend(t).then(() => { if (onProgress) onProgress(t / durSec); off.resume(); }).catch(() => {});
    }
    const buffer = await off.startRendering();
    return { buffer, missing };
  }
}
